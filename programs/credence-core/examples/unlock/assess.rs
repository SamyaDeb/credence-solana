//! The Friday alerts' pricing (C4a, `keeper/src/alerts.ts`) as one more op of `unlock_quote`: the program's own pricing
//! for any covered xStock and closure, off-chain. It replaces the standalone `keeper/alerts-quote` crate, so the repo has
//! one pricing helper (audit A-83): the deployed parameters are `model::config()`, the same ones C1 prices with.
//!
//! `{"op":"assess","equityUsdc":"…","items":[{"id","ticker","covered","debt","basisSigmaWad","closureId"?,"cap"?}]}` (USDC
//! base units and WAD as decimal strings; `closureId` the session the closure follows, as the program's epochs; no
//! `init` needed) replies, per item, priced alone against a model vault with `equityUsdc` of equity, for that closure as
//! `buy_cover` prices it (`calendar::epoch_times` and `quote::closure_terms`: its type's set and σ, its days, the
//! capacity multiplier; audit A-117), a plain weekend without `closureId`:
//! - `need8`, `need12`: what a −8% / −12% open would need repaid to bring the position back to its threshold
//!   (`pricing::realized_payout` with cap = D, close 1, settle 0.92 / 0.88);
//! - `paysCount` of `n`: scenarios of the closure's set (the one `buy_cover` prices with) whose gap leaves the
//!   position liquidatable, i.e. `realized_payout(C′, D, D, 1, g) > 0` with risk-core's `gap_factor(z, σ, d, κ)`;
//! - `premium` for a cap of `cap` (default `need8`, when it is above 0): `pricing::premium` + `pricing::shield_loading`,
//!   with the capacity (`pricing::capacity` over the asset's joint stress column, scaled) and concentration checks of
//!   `buy_cover`; or `refused` with the CoreError name.
//! σ and the dividend come from `data/onchain/assets.json`, σ_b from the caller (the loader's `basisSigmaFor`,
//! `scripts/src/basis.ts`).

#![allow(dead_code)]

use anchor_lang::prelude::{AccountInfo, AnchorDeserialize, Pubkey};
use anchor_lang::Space;
use credence_core::calendar::epoch_times;
use credence_core::closure_terms;
use credence_core::math::{wad_to_q64_down, WAD};
use credence_core::pricing::{capacity, policy_losses_scaled, premium, priced_debt, realized_payout, reserved_debt, shield_loading, CoverInputs};
use credence_core::state::{closure, AssetConfig, Config, Epoch, ScenarioSet, Session, K, SEED_SCENARIOS};
use credence_risk_core::{gap_factor, U256};
use serde_json::{json, Value};

fn load(root: &str, p: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{root}/{p}")).expect(p)).expect(p)
}
fn zs(v: &Value) -> Vec<i16> {
    v.as_array().expect("array").iter().map(|x| x.as_i64().expect("i16") as i16).collect()
}

const TYPES: [(u8, &str); 3] = [(closure::OVERNIGHT, "OVERNIGHT"), (closure::WEEKEND, "WEEKEND"), (closure::HOLIDAY_WEEKEND, "HOLIDAY_WEEKEND")];

struct Asset {
    ticker: String,
    tbytes: [u8; 8],
    sigma: u64,
    dividend: u64,
    /// Per closure type (1 OVERNIGHT, 2 WEEKEND, 3 HOLIDAY_WEEKEND): the scenario set and its σ (`sigmaByType`, what
    /// `set_scenario_sigma` stores; the WEEKEND set prices on the asset's σ).
    sets: Vec<(u8, Vec<i16>, u64)>,
    /// The `AssetConfig` with the K joint gap factors `compute_gap_factors` stores (Q64.64 rounded down).
    cfg: Box<AssetConfig>,
}

fn asset(root: &str, a: &Value, joint: &[Vec<i16>]) -> Asset {
    let ticker = a["ticker"].as_str().expect("ticker").to_string();
    let sigma: u64 = a["sigmaWad"].as_str().expect("sigmaWad").parse().expect("sigmaWad");
    let dividend: u64 = a["dividendWad"].as_str().unwrap_or("0").parse().expect("dividendWad");
    let col = &joint[a["jointColumn"].as_u64().expect("jointColumn") as usize];
    let mut c: Box<AssetConfig> = Box::new(bytemuck::Zeroable::zeroed());
    c.sigma_wad = sigma;
    c.dividend_wad = dividend;
    for (j, z) in col.iter().enumerate() {
        let g = gap_factor(*z, U256::from(sigma), U256::from(dividend), U256::ZERO).expect("gap factor");
        c.gap_factors[j] = wad_to_q64_down(g).expect("q64").to_le_bytes();
    }
    c.gf_count = K as u16;
    let mut tbytes = [0u8; 8];
    tbytes[..ticker.len().min(8)].copy_from_slice(&ticker.as_bytes()[..ticker.len().min(8)]);
    c.ticker = tbytes;
    let sets = TYPES
        .iter()
        .map(|(t, name)| {
            let z = zs(&load(root, &format!("data/onchain/{ticker}-{name}.json"))["z"]);
            let s: u64 = a["sigmaByType"][name].as_str().map(|x| x.parse().expect("sigmaByType")).unwrap_or(sigma);
            (*t, z, s)
        })
        .collect();
    Asset { ticker, tbytes, sigma, dividend, sets, cfg: c }
}

/// What `buy_cover` prices for closure `closure_id` (the session the closure follows): the program's own
/// `calendar::epoch_times` (closure type, times) and `closure_terms` (σ by type, nights, days, capacity multiplier);
/// no earnings bump (no asset is flagged by `set_earnings` in the deployed data). None = a plain weekend.
fn terms<'a>(a: &'a Asset, sessions: &[Session], closure_id: Option<u32>) -> Result<(u8, &'a Vec<i16>, credence_core::ClosureTerms), String> {
    let Some(id) = closure_id else {
        let (_, z, _) = a.sets.iter().find(|(t, _, _)| *t == closure::WEEKEND).expect("WEEKEND set");
        return Ok((closure::WEEKEND, z, credence_core::ClosureTerms { sigma_wad: a.sigma, days: WEEKEND_DAYS, capacity_mult_wad: WAD as u64 }));
    };
    let t = epoch_times(sessions, id).ok_or("closureId: not a session followed by another")?;
    let (ty, z, set_sigma) = a.sets.iter().find(|(ty, _, _)| *ty == t.closure_type).ok_or("closure type not sold")?;
    let mut e = Epoch::deserialize(&mut &vec![0u8; Epoch::INIT_SPACE][..]).map_err(|e| e.to_string())?;
    (e.ticker, e.closure_id, e.closure_type, e.sale_open, e.bell, e.close, e.open, e.settle_after) =
        (a.tbytes, id, t.closure_type, t.sale_open, t.bell, t.close, t.open, t.settle_after);
    let (set_key, bump) = Pubkey::find_program_address(&[SEED_SCENARIOS, a.tbytes.as_ref(), &[*ty]], &credence_core::ID);
    let mut set: Box<ScenarioSet> = Box::new(bytemuck::Zeroable::zeroed());
    (set.ticker, set.closure_type, set.finalized, set.bump, set.sigma_wad) = (a.tbytes, *ty, 1, bump, *set_sigma);
    // The asset is not flagged for earnings, so closure_terms never reads this account.
    let (key, owner, mut lamports, mut data) = (Pubkey::default(), Pubkey::default(), 0u64, [0u8; 0]);
    let none = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
    let terms = closure_terms(&a.cfg, &set, &set_key, &e, &none).map_err(|e| e.to_string())?;
    Ok((*ty, z, terms))
}

const WEEKEND_DAYS: u16 = credence_core::WEEKEND_CLOSURE_DAYS;

fn num<T: std::str::FromStr>(v: &Value, k: &str) -> Result<T, String> {
    let s = v[k].as_str().ok_or_else(|| format!("{k}: expected a decimal string"))?;
    s.parse().map_err(|_| format!("{k}: not a number"))
}

const W: u128 = WAD;

fn assess_one(cfg: &Config, a: &Asset, sessions: &[Session], equity: u64, p: &Value) -> Result<Value, String> {
    let covered: u64 = num(p, "covered")?;
    let debt: u64 = num(p, "debt")?;
    let basis: u64 = num(p, "basisSigmaWad")?;
    if covered == 0 || debt == 0 {
        return Err("covered and debt must be positive".into());
    }
    let e = |x: anchor_lang::error::Error| x.to_string();
    let need8 = realized_payout(covered, debt, debt, W, W / 100 * 92).map_err(e)?;
    let need12 = realized_payout(covered, debt, debt, W, W / 100 * 88).map_err(e)?;
    let closure_id = p["closureId"].as_u64().map(|x| x as u32);
    let (ty, set, t) = terms(a, sessions, closure_id)?;
    let mut pays = 0u32;
    for z in set {
        let g = gap_factor(*z, U256::from(t.sigma_wad), U256::from(a.dividend), U256::ZERO).map_err(|_| "gap factor".to_string())?;
        let g: u128 = g.try_into().map_err(|_| "gap factor".to_string())?;
        if g > 0 && realized_payout(covered, debt, debt, W, g).map_err(e)? > 0 {
            pays += 1;
        }
    }
    let mut out = json!({ "id": p["id"], "ticker": a.ticker, "need8": need8.to_string(), "need12": need12.to_string(), "paysCount": pays, "n": set.len(),
        "closureType": ty, "days": t.days, "sigmaWad": t.sigma_wad.to_string() });
    // The cap priced: `cap` when given (e.g. the full debt), else need8.
    let cap_req: u64 = if p["cap"].is_string() { num(p, "cap")? } else { need8 };
    if cap_req == 0 {
        return Ok(out);
    }
    // As buy_cover: capacity on the debt plus the interest cap, the premium on the expected interest.
    let xr = CoverInputs { covered_value: covered, debt: reserved_debt(debt, cfg).map_err(e)?, max_payout: cap_req };
    let x = CoverInputs { debt: priced_debt(debt, cfg).map_err(e)?, ..xr };
    let mut losses = vec![0u64; K];
    let worst = policy_losses_scaled(&a.cfg, cfg, &xr, t.capacity_mult_wad, &mut losses).map_err(e)?;
    let group = [0u64; K];
    let conc_limit = (equity as u128) * (cfg.u_max_wad as u128) / W * (cfg.max_asset_share_wad as u128) / W;
    match capacity(&group, &losses, 0, equity, cfg.u_max_wad) {
        Err(_) => out["refused"] = json!("CapacityExceeded"),
        Ok(_) if worst as u128 > conc_limit => out["refused"] = json!("ConcentrationExceeded"),
        Ok(cap) => {
            let cover = premium(set, cfg, t.sigma_wad, a.dividend, t.days, cap.util_after_wad, &x).map_err(e)?;
            let loading = shield_loading(set, cfg, t.sigma_wad, basis, &x, worst).map_err(e)?;
            out["premium"] = json!((cover + loading).to_string());
            out["cap"] = json!(cap_req.to_string());
        }
    }
    Ok(out)
}

/// The assets of `data/onchain/assets.json` with their per-closure-type sets, and the XNYS calendar the program's epochs follow.
pub struct Assessor {
    cfg: Config,
    assets: Vec<Asset>,
    sessions: Vec<Session>,
}

impl Assessor {
    pub fn load(root: &str) -> Assessor {
        let list = load(root, "data/onchain/assets.json");
        let joint = load(root, "data/onchain/joint-v2.json");
        let cols: Vec<Vec<i16>> = joint["columns"].as_array().expect("columns").iter().map(zs).collect();
        let assets = list.as_array().expect("assets").iter().map(|a| asset(root, a, &cols)).collect();
        let cal = load(root, "data/onchain/calendar-XNYS.json");
        let sessions = cal["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .map(|s| Session { date: s["date"].as_u64().expect("date") as u32, _pad: 0, open: s["open"].as_i64().expect("open"), close: s["close"].as_i64().expect("close") })
            .collect();
        Assessor { cfg: crate::model::config(), assets, sessions }
    }

    pub fn handle(&self, req: &Value) -> Result<Value, String> {
        let equity: u64 = num(req, "equityUsdc")?;
        let items = req["items"].as_array().cloned().unwrap_or_default();
        let out: Vec<Value> = items
            .iter()
            .map(|p| match self.assets.iter().find(|a| Some(a.ticker.as_str()) == p["ticker"].as_str()) {
                None => json!({ "id": p["id"], "error": "ticker: not covered" }),
                Some(a) => assess_one(&self.cfg, a, &self.sessions, equity, p).unwrap_or_else(|e| json!({ "id": p["id"], "error": e })),
            })
            .collect();
        Ok(json!({ "items": out }))
    }
}
