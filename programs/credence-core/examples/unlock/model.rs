//! C1 credit-unlock model (plan/09 "Phase C, C1"): the program's own pricing, losses, capacity and shield sizing applied
//! to scanned positions, for `examples/unlock_quote.rs` and the golden test `tests/unlock.rs`. Nothing here prices on
//! its own: premiums are `pricing::premium` / `premium_multi` + `shield_loading`, losses `policy_losses(_multi)` /
//! `settlement_losses_multi`, capacity `pricing::capacity` and `concentration_limit`, shield advances `shield_target(_multi)`.
//!
//! Assets come from `data/onchain/assets.json` (every entry, plus a `<T>.J` alias for each one with a `jupiter` vault:
//! `<T>`'s set, σ, joint column and σ_b, its own concentration bucket), the WEEKEND sets and joint set v2.

#![allow(dead_code)]

use std::collections::HashMap;

use anchor_lang::prelude::Pubkey;
use credence_core::instructions::cover::concentration_limit;
use credence_core::math::{wad_to_q64_down, WAD};
use credence_core::pricing::{
    capacity, policy_losses, policy_losses_multi, premium, premium_multi, priced_debt, reserved_debt, settlement_losses_multi,
    shield_loading, shield_target, shield_target_multi, CoverInputs, LegPrice, LegPricing, MultiInputs, ShieldParams, JOINT_N_ALL,
};
use credence_core::state::{AssetConfig, Config, K};
use credence_core::WEEKEND_CLOSURE_DAYS;
use credence_risk_core::{gap_factor, quote_cover_capped, PremiumParams, SliceZ, U256};
use serde_json::Value;

pub const METHOD: &str = "unlock.v1";

/// The deployed parameters (same as `examples/shadow_quote.rs`, `examples/backtest.rs` and `scripts/src/load-onchain.ts`).
pub fn config() -> Config {
    Config {
        admin: Pubkey::default(),
        guardian: Pubkey::default(),
        keeper: Pubkey::default(),
        usdc_mint: Pubkey::default(),
        u_max_wad: (WAD / 2) as u64,
        max_asset_share_wad: (WAD / 2) as u64,
        theta_wad: WAD as u64,
        cost_of_cap_wad: (WAD / 10) as u64,
        eta_wad: WAD as u64,
        beta_wad: (WAD / 1000 * 975) as u64,
        kappa_wad: 0,
        min_premium: 5_000_000,
        fee_bps: 0,
        max_conf_bps: 50,
        xcheck_bps: 200,
        close_window_secs: 60,
        xstock_settle_window_secs: 3600,
        shield_alpha_wad: (WAD / 2) as u64,
        shield_buffer_wad: (WAD / 50) as u64,
        shield_health_wad: 0,
        shield_lambda_wad: (2 * WAD) as u64,
        shield_max_age_secs: 36 * 3600,
        shield_start_before_open_secs: 48_600,
        shield_deadline_before_open_secs: 9_000,
        shield_reserve_k_wad: (2 * WAD) as u64,
        debt_growth_cap_wad: (WAD / 200) as u64,
        debt_growth_est_wad: (WAD / 1000) as u64,
        pending_admin: Pubkey::default(),
        pyusd_mint: Pubkey::default(),
        sleeve_slippage_bps: 30,
        paused: false,
        bump: 0,
    }
}

fn zs(v: &Value) -> Vec<i16> {
    v.as_array().expect("array").iter().map(|x| x.as_i64().expect("i16") as i16).collect()
}
fn wad_str(v: &Value) -> u64 {
    v.as_str().expect("decimal string").parse().expect("u64")
}

pub struct Asset {
    pub ticker: String,
    /// The xStock (for an alias, the base ticker): closure gaps and the app's odds use it.
    pub base: String,
    pub sigma: u64,
    pub dividend: u64,
    pub basis: u64,
    pub z: Vec<i16>,
    /// The on-chain `AssetConfig` as `compute_gap_factors` leaves it (risk-core factors, Q64.64 rounded down).
    pub cfg: Box<AssetConfig>,
}

pub struct Model {
    pub cfg: Config,
    pub assets: Vec<Asset>,
    pub index: HashMap<String, usize>,
    /// Real closures since 2016 per base ticker: (open date, gap).
    pub gaps: HashMap<String, Vec<(String, f64)>>,
}

/// `root` is the repository; `basis` maps a base ticker to σ_b in WAD (`scripts/src/basis.ts` `basisSigmaFor`, as the
/// on-chain loader sets it).
pub fn load(root: &str, basis: &HashMap<String, u64>) -> Result<Model, String> {
    let rd = |p: &str| -> Result<Value, String> {
        serde_json::from_str(&std::fs::read_to_string(format!("{root}/{p}")).map_err(|e| format!("{p}: {e}"))?).map_err(|e| format!("{p}: {e}"))
    };
    let list = rd("data/onchain/assets.json")?;
    let joint = rd("data/onchain/joint-v2.json")?;
    let cols: Vec<Vec<i16>> = joint["columns"].as_array().ok_or("joint columns")?.iter().map(zs).collect();
    let jt: Vec<String> = joint["tickers"].as_array().ok_or("joint tickers")?.iter().map(|t| t.as_str().unwrap_or("").to_string()).collect();
    let mut assets = vec![];
    let mut aliases = vec![];
    for a in list.as_array().ok_or("assets.json: expected an array")? {
        let t = a["ticker"].as_str().ok_or("ticker")?.to_string();
        let col = a["jointColumn"].as_u64().ok_or("jointColumn")? as usize;
        if jt.get(col) != Some(&t) {
            return Err(format!("{t}: joint v2 column {col} is {:?}", jt.get(col)));
        }
        let sigma = wad_str(&a["sigmaWad"]);
        let dividend = a["dividendWad"].as_str().map(|s| s.parse().unwrap_or(0)).unwrap_or(0);
        let b = *basis.get(&t).ok_or(format!("{t}: no σ_b"))?;
        let z = zs(&rd(&format!("data/onchain/{t}-WEEKEND.json"))?["z"]);
        let mk = |ticker: &str| Asset {
            ticker: ticker.to_string(),
            base: t.clone(),
            sigma,
            dividend,
            basis: b,
            z: z.clone(),
            cfg: asset_config(sigma, dividend, b, &cols[col]),
        };
        assets.push(mk(&t));
        if !a["jupiter"].is_null() {
            aliases.push(mk(&format!("{t}.J")));
        }
    }
    assets.extend(aliases);
    let index = assets.iter().enumerate().map(|(i, a)| (a.ticker.clone(), i)).collect();
    let g = rd("data/sigma/closure-gaps.json")?;
    let mut gaps = HashMap::new();
    for (t, v) in g["gaps"].as_object().ok_or("closure-gaps: gaps")? {
        let rows = v
            .as_array()
            .ok_or("gaps row")?
            .iter()
            .map(|r| (r["open"].as_str().unwrap_or("").to_string(), r["gap"].as_f64().unwrap_or(0.0)))
            .collect();
        gaps.insert(t.clone(), rows);
    }
    Ok(Model { cfg: config(), assets, index, gaps })
}

fn asset_config(sigma: u64, dividend: u64, basis: u64, column: &[i16]) -> Box<AssetConfig> {
    let mut a: Box<AssetConfig> = Box::new(bytemuck::Zeroable::zeroed());
    a.sigma_wad = sigma;
    a.dividend_wad = dividend;
    a.gf_sigma_wad = sigma;
    a.gf_dividend_wad = dividend;
    a.basis_sigma_wad = basis;
    for (j, z) in column.iter().enumerate() {
        let g = gap_factor(*z, U256::from(sigma), U256::from(dividend), U256::ZERO).expect("gap factor");
        a.gap_factors[j] = wad_to_q64_down(g).expect("q64").to_le_bytes();
    }
    a.gf_count = K as u16;
    a
}

/// A position as the program would see it: covered values per xStock leg (C′_i, rounded DOWN), stablecoin S′, debt D.
/// `multi` takes the `buy_cover_multi` / `quote_cover_multi` path (several legs, stablecoin collateral or PYUSD debt);
/// otherwise one leg on `buy_cover` (Kamino) or `buy_cover_jl` (a `<T>.J` alias).
#[derive(Clone, Debug)]
pub struct Position {
    pub id: String,
    pub legs: Vec<(usize, u64)>,
    pub stable: u64,
    pub debt: u64,
    pub multi: bool,
}

impl Position {
    pub fn covered(&self) -> u64 {
        self.legs.iter().map(|l| l.1).sum::<u64>() + self.stable
    }
    /// The same position with debt `d` (the cover's cap is the debt: full cover).
    pub fn at_debt(&self, d: u64) -> Position {
        Position { debt: d, ..self.clone() }
    }
}

pub fn parse_position(m: &Model, v: &Value) -> Result<Position, String> {
    let num = |v: &Value, k: &str| -> Result<u64, String> {
        v[k].as_str().ok_or(format!("{k}: expected a decimal string"))?.parse().map_err(|_| format!("{k}: not a number"))
    };
    let mut legs = vec![];
    for l in v["legs"].as_array().ok_or("legs: expected an array")? {
        let t = l["ticker"].as_str().ok_or("leg ticker")?;
        let i = *m.index.get(t).ok_or(format!("{t}: not covered"))?;
        legs.push((i, num(l, "covered")?));
    }
    if legs.is_empty() || legs.len() > credence_core::state::MAX_LEGS {
        return Err("legs: 1 to 8".into());
    }
    let multi = v["multi"].as_bool().unwrap_or(false);
    if !multi && (legs.len() != 1 || num(v, "stable").unwrap_or(0) != 0) {
        return Err("single path: one leg, no stablecoin".into());
    }
    Ok(Position { id: v["id"].as_str().unwrap_or("").to_string(), legs, stable: num(v, "stable").unwrap_or(0), debt: num(v, "debt")?, multi })
}

/// One policy's pricing at utilisation `util`: premium (shield loading included), the loading, the reserved worst loss,
/// the per-scenario reserved losses (capacity), and E[L] (single: risk-core's quote; multi: the joint set's
/// settlement losses, each closure 1/564, rounded UP).
#[derive(Clone, Debug)]
pub struct Priced {
    pub premium: u64,
    pub loading: u64,
    pub worst: u64,
    pub losses: Vec<u64>,
    pub expected_loss: u64,
}

pub fn price(m: &Model, p: &Position, cap: u64, util: u64) -> Result<Priced, String> {
    let e = |x: anchor_lang::error::Error| x.to_string();
    let cfg = &m.cfg;
    let mut losses = vec![0u64; K];
    if !p.multi {
        // buy_cover / quote_cover / buy_cover_jl: reserved on the interest cap, priced on the expected interest.
        let a = &m.assets[p.legs[0].0];
        let xr = CoverInputs { covered_value: p.legs[0].1, debt: reserved_debt(p.debt, cfg).map_err(e)?, max_payout: cap };
        let x = CoverInputs { debt: priced_debt(p.debt, cfg).map_err(e)?, ..xr };
        let worst = policy_losses(&a.cfg, cfg, &xr, &mut losses).map_err(e)?;
        let cover = premium(&a.z, cfg, a.sigma, a.dividend, WEEKEND_CLOSURE_DAYS, util, &x).map_err(e)?;
        let loading = shield_loading(&a.z, cfg, a.sigma, a.basis, &x, worst).map_err(e)?;
        let el = quote_cover_capped(&SliceZ(&a.z), &premium_params(cfg, a, &x, util), U256::from(cap))
            .map_err(|_| "risk-core quote".to_string())?
            .expected_loss
            .to::<u64>();
        return Ok(Priced { premium: cover + loading, loading, worst, losses, expected_loss: el });
    }
    // buy_cover_multi / quote_cover_multi.
    let refs: Vec<&AssetConfig> = p.legs.iter().map(|l| &*m.assets[l.0].cfg).collect();
    let covered: Vec<u64> = p.legs.iter().map(|l| l.1).collect();
    let xr = MultiInputs { legs: &covered, stable: p.stable, debt: reserved_debt(p.debt, cfg).map_err(e)?, max_payout: cap };
    let worst = policy_losses_multi(&refs, cfg, &xr, &mut losses).map_err(e)?;
    let xp = MultiInputs { debt: priced_debt(p.debt, cfg).map_err(e)?, ..xr };
    let mut settle = vec![0u64; K];
    settlement_losses_multi(&refs, &xp, &mut settle).map_err(e)?;
    let pricing: Vec<LegPricing> = p
        .legs
        .iter()
        .map(|l| {
            let a = &m.assets[l.0];
            LegPricing { z: &a.z, sigma_wad: a.sigma, dividend_wad: a.dividend, basis_sigma_wad: a.basis }
        })
        .collect();
    let (prem, loading) = premium_multi(&pricing, cfg, WEEKEND_CLOSURE_DAYS, util, &xp, &settle, worst).map_err(e)?;
    let el = settle.iter().map(|x| *x as u128).sum::<u128>().div_ceil(JOINT_N_ALL as u128) as u64;
    Ok(Priced { premium: prem, loading, worst, losses, expected_loss: el })
}

fn premium_params(cfg: &Config, a: &Asset, x: &CoverInputs, util: u64) -> PremiumParams {
    PremiumParams {
        sigma: U256::from(a.sigma),
        dividend: U256::from(a.dividend),
        kappa: U256::from(cfg.kappa_wad),
        collateral_value: U256::from(x.covered_value),
        debt_projected: U256::from(x.debt),
        closure_days: WEEKEND_CLOSURE_DAYS,
        util_after: U256::from(util),
        theta: U256::from(cfg.theta_wad),
        cost_of_cap: U256::from(cfg.cost_of_cap_wad),
        eta: U256::from(cfg.eta_wad),
        beta: U256::from(cfg.beta_wad),
        min_premium: U256::from(cfg.min_premium),
    }
}

/// The app's "chance this pays anything" rule (`app/src/lib/odds.ts` `modelPays`), which is "liquidatable after the
/// weekend" for a single leg: D × 1000 × WAD > C′ × max(0, 1000 × WAD + σ z). Exact integers.
fn liquidatable_at(cov: u64, debt: u64, sigma: u64, z: i16) -> bool {
    let w = WAD as i128 * 1000;
    let g = (w + sigma as i128 * z as i128).max(0) as u128;
    (debt as u128) * (w as u128) > (cov as u128) * g
}

/// Scenario count where the position is liquidatable after the gap alone, and the count it is drawn from: single leg
/// over the asset's 3,000-point set (`modelPays`), multi over joint v2 with the program's settlement losses (loss > 0),
/// each scenario standing for one of the 564 closures.
pub fn p_liquidatable(m: &Model, p: &Position) -> (u32, u32) {
    if !p.multi {
        let a = &m.assets[p.legs[0].0];
        let n = a.z.iter().take_while(|z| liquidatable_at(p.legs[0].1, p.debt, a.sigma, **z)).count();
        return (n as u32, a.z.len() as u32);
    }
    let refs: Vec<&AssetConfig> = p.legs.iter().map(|l| &*m.assets[l.0].cfg).collect();
    let covered: Vec<u64> = p.legs.iter().map(|l| l.1).collect();
    let x = MultiInputs { legs: &covered, stable: p.stable, debt: p.debt, max_payout: p.debt.max(1) };
    let mut s = vec![0u64; K];
    settlement_losses_multi(&refs, &x, &mut s).expect("settlement losses");
    (s.iter().filter(|l| **l > 0).count() as u32, JOINT_N_ALL)
}

/// Real closures since 2016 whose gap alone would have made the position liquidatable, and the closures counted.
/// Single leg: `historyPays` (gap < D/C′ − 1, f64 as in the app). Multi: the dates every leg has, Σ C′_i (1 + gap_i) + S′ < D.
pub fn history(m: &Model, p: &Position) -> (u32, u32) {
    let base = |i: usize| &m.assets[i].base;
    if !p.multi {
        let g = &m.gaps[base(p.legs[0].0)];
        let be = p.debt as f64 / p.legs[0].1 as f64 - 1.0;
        return (g.iter().filter(|(_, x)| *x < be).count() as u32, g.len() as u32);
    }
    let maps: Vec<HashMap<&str, f64>> = p.legs.iter().map(|l| m.gaps[base(l.0)].iter().map(|(d, g)| (d.as_str(), *g)).collect()).collect();
    let first = &m.gaps[base(p.legs[0].0)];
    let (mut hit, mut n) = (0u32, 0u32);
    for (d, _) in first {
        let Some(gs) = maps.iter().map(|mp| mp.get(d.as_str()).copied()).collect::<Option<Vec<f64>>>() else { continue };
        n += 1;
        let cov: f64 = p.legs.iter().zip(&gs).map(|(l, g)| l.1 as f64 * (1.0 + g)).sum::<f64>() + p.stable as f64;
        if cov < p.debt as f64 {
            hit += 1;
        }
    }
    (hit, n)
}

/// Residual: scenarios where the position, fully covered (cap = D) and shielded, is still liquidatable at the open.
/// Per scenario: open = close × g; the shield sees f = open × (1 + k_e σ_b) (`k_e` ∈ {0, −1, +1}); it advances
/// A = min(`shield_target(_multi)`, the policy's reserved worst loss) (INV-12); liquidatable iff D − A is still above
/// the covered value at the open (single: the `modelPays` rule; multi: settlement loss > 0). Returns (count, of,
/// largest advance, scenarios where INV-12 capped the advance).
pub fn residual(m: &Model, p: &Position, k_e: i64) -> Result<(u32, u32, u64, u32), String> {
    let e = |x: anchor_lang::error::Error| x.to_string();
    let cfg = &m.cfg;
    let sp = ShieldParams::from_config(cfg);
    let w = WAD as i128;
    let worst = price(m, p, p.debt, 0)?.worst;
    let fair = |g: u128, basis: u64| -> u128 {
        let f = g as i128 * (w + k_e as i128 * basis as i128) / w;
        f.max(1) as u128
    };
    let (mut hit, mut max_a, mut capped) = (0u32, 0u64, 0u32);
    if !p.multi {
        let a = &m.assets[p.legs[0].0];
        let c = p.legs[0].1;
        for z in &a.z {
            // g in WAD: 1 + σ z / 1000, as the rule above (floored at a tiny positive price).
            let g = ((w * 1000 + a.sigma as i128 * *z as i128) / 1000).max(1) as u128;
            let t = shield_target(c, p.debt, p.debt, WAD, fair(g, a.basis), &sp).map_err(e)?;
            if t > worst {
                capped += 1;
            }
            let adv = t.min(worst);
            max_a = max_a.max(adv);
            if liquidatable_at(c, p.debt - adv, a.sigma, *z) {
                hit += 1;
            } else if adv == 0 {
                // ascending z: no advance and not liquidatable means every later point is safe as well.
                break;
            }
        }
        return Ok((hit, a.z.len() as u32, max_a, capped));
    }
    let refs: Vec<&AssetConfig> = p.legs.iter().map(|l| &*m.assets[l.0].cfg).collect();
    let covered: Vec<u64> = p.legs.iter().map(|l| l.1).collect();
    for j in 0..K {
        let legs: Vec<LegPrice> = p
            .legs
            .iter()
            .map(|l| {
                let a = &m.assets[l.0];
                let g = ((a.cfg.gap_factor_q64(j) * WAD) >> 64).max(1);
                LegPrice { covered: l.1, close_wad: WAD, price_wad: fair(g, a.basis) }
            })
            .collect();
        let t = shield_target_multi(&legs, p.stable, p.debt, p.debt, &sp).map_err(e)?;
        if t > worst {
            capped += 1;
        }
        let adv = t.min(worst);
        max_a = max_a.max(adv);
        let x = MultiInputs { legs: &covered, stable: p.stable, debt: p.debt - adv, max_payout: p.debt.max(1) };
        let mut s = vec![0u64; K];
        // One scenario at a time is enough here; the vector form is the program's.
        settlement_losses_multi(&refs, &x, &mut s).map_err(e)?;
        if s[j] > 0 {
            hit += 1;
        }
    }
    Ok((hit, JOINT_N_ALL, max_a, capped))
}

/// A model vault selling `positions` in order at `equity` (INV-2 capacity on one weekend group, the per-asset
/// concentration cap; a multi policy's worst loss counts on every leg's asset, as `buy_cover_multi` books it). `priced`
/// holds each policy's u = 0 pricing (its losses and worst loss do not depend on the vault). With `with_premium`, each
/// sold policy is re-priced at the utilisation after it (the premium `buy_cover` would charge).
pub struct BookResult {
    pub sold: Vec<Option<Priced>>,
    pub refused_capacity: u32,
    pub refused_concentration: Vec<String>,
    pub group: Vec<u64>,
    pub asset_worst: Vec<u64>,
}

pub fn book(m: &Model, positions: &[Position], priced: &[Priced], equity: u64, with_premium: bool) -> Result<BookResult, String> {
    let cfg = &m.cfg;
    let limit = concentration_limit(equity, cfg.u_max_wad, cfg.max_asset_share_wad);
    let mut group = [0u64; K];
    let mut asset_worst = vec![0u64; m.assets.len()];
    let mut out = Vec::with_capacity(positions.len());
    let (mut ref_cap, mut ref_conc) = (0u32, vec![]);
    for (p, pr) in positions.iter().zip(priced) {
        let Ok(c) = capacity(&group, &pr.losses, 0, equity, cfg.u_max_wad) else {
            ref_cap += 1;
            out.push(None);
            continue;
        };
        let legs = leg_assets(p);
        if let Some(i) = legs.iter().find(|i| asset_worst[**i] as u128 + pr.worst as u128 > limit) {
            ref_conc.push(m.assets[*i].ticker.clone());
            out.push(None);
            continue;
        }
        for (g, l) in group.iter_mut().zip(&pr.losses) {
            *g += l;
        }
        for i in legs {
            asset_worst[i] += pr.worst;
        }
        out.push(Some(if with_premium { price(m, p, p.debt, c.util_after_wad)? } else { pr.clone() }));
    }
    Ok(BookResult { sold: out, refused_capacity: ref_cap, refused_concentration: ref_conc, group: group.to_vec(), asset_worst })
}

/// Distinct assets of a position's legs (a ticker counts once).
pub fn leg_assets(p: &Position) -> Vec<usize> {
    let mut v: Vec<usize> = p.legs.iter().map(|l| l.0).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// The LP equity a book needs: the smallest equity (USDC base units) at which every policy sells. Group and asset totals
/// only grow along the sale, so every policy sells iff the final totals pass the program's checks (`capacity` on the
/// final loss vector, `concentration_limit` per asset); each is found by bisection on those functions. Returns
/// (equity, equity for capacity alone, per asset the equity its concentration alone needs).
pub struct EquityNeeded {
    pub equity: u64,
    pub capacity: u64,
    pub per_asset: Vec<u64>,
    pub group_worst: u64,
}

pub fn equity_needed(m: &Model, positions: &[Position], priced: &[Priced]) -> EquityNeeded {
    let cfg = &m.cfg;
    let mut group = [0u64; K];
    let mut asset = vec![0u64; m.assets.len()];
    for (p, pr) in positions.iter().zip(priced) {
        for (g, l) in group.iter_mut().zip(&pr.losses) {
            *g += l;
        }
        for i in leg_assets(p) {
            asset[i] += pr.worst;
        }
    }
    let zero = [0u64; K];
    let min_e = |ok: &dyn Fn(u64) -> bool| -> u64 {
        if ok(0) {
            return 0;
        }
        let mut hi = 1u64;
        while !ok(hi) {
            hi *= 2;
        }
        let mut lo = hi / 2;
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if ok(mid) {
                hi = mid
            } else {
                lo = mid
            }
        }
        hi
    };
    let gw = group.iter().copied().max().unwrap_or(0);
    let cap_e = if gw == 0 { 0 } else { min_e(&|e| capacity(&zero, &group, 0, e, cfg.u_max_wad).is_ok()) };
    let per_asset: Vec<u64> = asset
        .iter()
        .map(|s| if *s == 0 { 0 } else { min_e(&|e| concentration_limit(e, cfg.u_max_wad, cfg.max_asset_share_wad) >= *s as u128) })
        .collect();
    let equity = per_asset.iter().copied().fold(cap_e, u64::max);
    EquityNeeded { equity, capacity: cap_e, per_asset, group_worst: gw }
}
