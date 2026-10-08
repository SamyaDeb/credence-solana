#![allow(non_snake_case)]
//! Task 3.4: Gap Cover backtest export (chart data for the underwriters page).
//!
//!   cargo run -p credence-core --example backtest --release   → data/backtest/gap-cover-backtest.json
//!
//! A model book is priced exactly as `buy_cover` prices it (the program's own `pricing::policy_losses`, `capacity`,
//! `premium`, and the on-chain gap factors from `risk-core::gap_factor`), then replayed through every dated
//! historical closure of the joint stress set: today's book and σ through history's standardised shocks,
//! r = z × σ, payout = the program's `pricing::realized_payout`.
//!
//! Data: `data/onchain` (σ, the calibrated WEEKEND sets, joint v1 with QQQx on the SPY column) and the source joint
//! set's dated closures (`data/joint/joint-38f0d2af.json`): the 256 worst of the 564 non-overnight closures from
//! 2016-04-25 to 2026-09-21, ranked by the equal-weighted mean z of six assets. 252 are historical (203 WEEKEND,
//! 49 HOLIDAY_WEEKEND) and 4 are synthetic stress closures, reported separately. The other 312 closures are
//! basket-up weekends (mean z above +0.009) without per-asset data here: they are counted as premium-only, which
//! understates payouts where one asset gapped down while the basket rose (mostly NVDAx; SPYx needs −3σ to pay the
//! book's nearest position).

use anchor_lang::prelude::Pubkey;
use credence_core::math::{wad_to_q64_down, WAD};
use credence_core::pricing::{capacity, policy_losses, premium, realized_payout, CoverInputs};
use credence_core::state::{AssetConfig, Config, K};
use credence_core::WEEKEND_CLOSURE_DAYS;
use credence_risk_core::{gap_factor, U256};
use serde_json::{json, Value};

const TICKERS: [&str; 3] = ["SPYx", "QQQx", "NVDAx"];
/// Vault equity held at J0 every weekend (as in the EVM backtest).
const EQUITY: u64 = 2_000_000_000_000;
/// Model book: per asset, `PER_ASSET` policies with D/C′ evenly spaced on [LO, HI], debt `DEBT` each, cap = debt.
/// Overridable for parameter sweeps: BT_LO, BT_HI, BT_THETA (WAD fraction, e.g. 0.2), BT_MIN_PREMIUM (USDC),
/// BT_COST_OF_CAP, BT_DEBT (USDC per policy, default 25,000), BT_OUT (output file name), BT_SIGMA_FLOOR=1 (σ_used =
/// max(σ, the long-run 2016–2026 weekend σ in `data/sigma/sigma-floor.json`)). Defaults are the deployed parameters.
const PER_ASSET: usize = 40;
fn env_f(k: &str, d: f64) -> f64 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}
fn load(p: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{}/{p}", root())).unwrap()).unwrap()
}
fn zs(v: &Value) -> Vec<i16> {
    v.as_array().unwrap().iter().map(|x| x.as_i64().unwrap() as i16).collect()
}

/// The deployed Phase 1 parameters (`scripts/src/load-onchain.ts`): θ 1.0, minimum premium 5 USDC since Day 5; σ from
/// `data/onchain/assets.json`, which already includes the σ floor.
fn config() -> Config {
    let wad = |x: f64| (x * 1e18) as u64;
    Config {
        admin: Pubkey::default(),
        guardian: Pubkey::default(),
        keeper: Pubkey::default(),
        usdc_mint: Pubkey::default(),
        u_max_wad: (WAD / 2) as u64,
        max_asset_share_wad: (WAD / 2) as u64,
        theta_wad: wad(env_f("BT_THETA", 1.0)),
        cost_of_cap_wad: wad(env_f("BT_COST_OF_CAP", 0.1)),
        eta_wad: WAD as u64,
        beta_wad: (WAD / 1000 * 975) as u64,
        kappa_wad: 0,
        min_premium: (env_f("BT_MIN_PREMIUM", 5.0) * 1e6) as u64,
        fee_bps: 0,
        max_conf_bps: 50,
        xcheck_bps: 200,
        close_window_secs: 60,
        xstock_settle_window_secs: 3600,
        paused: false,
        bump: 0,
    }
}

/// An `AssetConfig` with the K gap factors `compute_gap_factors` would store (risk-core, Q64.64 rounded down).
fn asset(sigma: u64, column: &[i16]) -> Box<AssetConfig> {
    let mut a: Box<AssetConfig> = Box::new(bytemuck::Zeroable::zeroed());
    a.sigma_wad = sigma;
    for (j, z) in column.iter().enumerate() {
        let g = gap_factor(*z, U256::from(sigma), U256::ZERO, U256::ZERO).unwrap();
        a.gap_factors[j] = wad_to_q64_down(g).unwrap().to_le_bytes();
    }
    a.gf_count = K as u16;
    a
}

struct Policy {
    ticker: usize,
    ratio: f64,
    x: CoverInputs,
    premium: u64,
}

fn main() {
    let (LO, HI) = (env_f("BT_LO", 0.80), env_f("BT_HI", 0.98));
    let DEBT = (env_f("BT_DEBT", 25_000.0) * 1e6) as u64;
    let cfg = config();
    let assets = load("data/onchain/assets.json");
    let joint = load("data/onchain/joint-v1.json");
    let source = load("data/joint/joint-38f0d2af.json");
    let cols: Vec<Vec<i16>> = joint["columns"].as_array().unwrap().iter().map(zs).collect();
    let closures = source["meta"]["closures"].as_array().unwrap();
    assert_eq!(closures.len(), K);
    let mut sigma: Vec<u64> = (0..3).map(|i| assets[i]["sigmaWad"].as_str().unwrap().parse().unwrap()).collect();
    let floor_env = std::env::var("BT_SIGMA_FLOOR").is_ok_and(|v| v == "1");
    // assets.json carries the floor already since Day 5 (gen-onchain.ts); BT_SIGMA_FLOOR applies it to older files.
    let floor_on = floor_env || assets[0]["sigmaFloorWad"].is_string();
    if floor_env {
        let floor = load("data/sigma/sigma-floor.json");
        for (i, t) in TICKERS.iter().enumerate() {
            sigma[i] = sigma[i].max(floor["assets"][t]["sigmaWad"].as_str().unwrap().parse().unwrap());
        }
    }
    let sets: Vec<Vec<i16>> = TICKERS.iter().map(|t| zs(&load(&format!("data/onchain/{t}-WEEKEND.json"))["z"])).collect();
    let acs: Vec<Box<AssetConfig>> = (0..3).map(|i| asset(sigma[i], &cols[i])).collect();

    // 1. Sell the book in order, as buy_cover would: capacity and utilisation from the group's loss vector.
    let mut group = [0u64; K];
    let mut book: Vec<Policy> = vec![];
    let mut refused = 0;
    let mut asset_worst = [0u64; 3];
    let conc_limit = (EQUITY as u128) * (cfg.u_max_wad as u128) / WAD * (cfg.max_asset_share_wad as u128) / WAD;
    for k in 0..PER_ASSET {
        for (i, a) in acs.iter().enumerate() {
            let ratio = LO + (HI - LO) * k as f64 / (PER_ASSET - 1) as f64;
            let x = CoverInputs { covered_value: (DEBT as f64 / ratio) as u64, debt: DEBT, max_payout: DEBT };
            let mut losses = vec![0u64; K];
            let worst = policy_losses(a, &x, &mut losses).unwrap();
            let Ok(cap) = capacity(&group, &losses, 0, EQUITY, cfg.u_max_wad) else {
                refused += 1;
                continue;
            };
            if (asset_worst[i] + worst) as u128 > conc_limit {
                refused += 1;
                continue;
            }
            let p = premium(&sets[i], &cfg, sigma[i], 0, WEEKEND_CLOSURE_DAYS, cap.util_after_wad, &x).unwrap();
            for (g, l) in group.iter_mut().zip(&losses) {
                *g += l;
            }
            asset_worst[i] += worst;
            book.push(Policy { ticker: i, ratio, x, premium: p });
        }
    }
    let premiums: u64 = book.iter().map(|p| p.premium).sum();
    let reserved = *group.iter().max().unwrap();
    let usd = |x: u64| x as f64 / 1e6;

    // 2. Replay every dated closure.
    let mut dated = vec![];
    let mut synthetic = vec![];
    for (j, c) in closures.iter().enumerate() {
        let r: Vec<f64> = (0..3).map(|i| cols[i][j] as f64 / 1000.0 * sigma[i] as f64 / 1e18).collect();
        let settle: Vec<u128> = (0..3)
            .map(|i| {
                let m = (cols[i][j] as i128) * (sigma[i] as i128) / 1000; // r in WAD, toward zero
                (WAD as i128 + m).max(1) as u128
            })
            .collect();
        let mut pay = [0u64; 3];
        for p in &book {
            pay[p.ticker] += realized_payout(p.x.covered_value, p.x.debt, p.x.max_payout, WAD, settle[p.ticker]).unwrap();
        }
        let payout: u64 = pay.iter().sum();
        let row = json!({
            "date": c["date"], "type": c["type"], "basketZ": c["basketZ"],
            "z": { "SPYx": cols[0][j], "QQQx": cols[1][j], "NVDAx": cols[2][j] },
            "r": { "SPYx": r[0], "QQQx": r[1], "NVDAx": r[2] },
            "premiumUsd": usd(premiums),
            "payoutUsd": { "SPYx": usd(pay[0]), "QQQx": usd(pay[1]), "NVDAx": usd(pay[2]), "total": usd(payout) },
            "pnlUsd": usd(premiums) - usd(payout),
            "lpReturn": (usd(premiums) - usd(payout)) / usd(EQUITY),
        });
        if c["type"] == "SYNTHETIC" { synthetic.push(row) } else { dated.push(row) }
    }
    dated.sort_by(|a, b| a["date"].as_str().cmp(&b["date"].as_str()));

    // 3. Summary over all 564 non-overnight closures (312 premium-only).
    const ALL: usize = 564;
    let premium_only = ALL - dated.len();
    let dated_payouts: f64 = dated.iter().map(|d| d["payoutUsd"]["total"].as_f64().unwrap()).sum();
    let total_premiums = usd(premiums) * ALL as f64;
    let worst = dated.iter().min_by(|a, b| a["pnlUsd"].as_f64().unwrap().total_cmp(&b["pnlUsd"].as_f64().unwrap())).unwrap();
    let mut rets: Vec<f64> = dated.iter().map(|d| d["lpReturn"].as_f64().unwrap()).collect();
    rets.extend(std::iter::repeat(usd(premiums) / usd(EQUITY)).take(premium_only));
    rets.sort_by(f64::total_cmp);
    let q = |p: f64| rets[((p * rets.len() as f64) as usize).min(rets.len() - 1)];
    let paying = dated.iter().filter(|d| d["payoutUsd"]["total"].as_f64().unwrap() > 0.0).count();
    let losing = dated.iter().filter(|d| d["pnlUsd"].as_f64().unwrap() < 0.0).count();
    let years = (2026.0 + 8.7 / 12.0) - (2016.0 + 3.8 / 12.0);
    let mut by_year: std::collections::BTreeMap<String, (f64, usize)> = Default::default();
    for d in &dated {
        let y = d["date"].as_str().unwrap()[..4].to_string();
        let e = by_year.entry(y).or_default();
        e.0 += d["payoutUsd"]["total"].as_f64().unwrap();
        e.1 += 1;
    }
    // 4. The demo position (SPYx, $50k debt at D/C′ 0.96, cap = debt), priced alone in the same vault, and how often it
    // pays: the model's probability (share of the WEEKEND set with r < D/C′ − 1) and the dated closures that would pay.
    let demo_ratio = env_f("BT_DEMO_RATIO", 0.96);
    let dx = CoverInputs { covered_value: (50_000e6 / demo_ratio) as u64, debt: 50_000_000_000, max_payout: 50_000_000_000 };
    let mut dl = vec![0u64; K];
    policy_losses(&acs[0], &dx, &mut dl).unwrap();
    let dcap = capacity(&[0u64; K], &dl, 0, EQUITY, cfg.u_max_wad).unwrap();
    let demo_premium = premium(&sets[0], &cfg, sigma[0], 0, WEEKEND_CLOSURE_DAYS, dcap.util_after_wad, &dx).unwrap();
    let z_pay = (demo_ratio - 1.0) / (sigma[0] as f64 / 1e18) * 1000.0;
    let p_pay = sets[0].iter().filter(|z| (**z as f64) < z_pay).count() as f64 / sets[0].len() as f64;
    let hist_pay = closures
        .iter()
        .enumerate()
        .filter(|(j, c)| c["type"] != "SYNTHETIC" && (cols[0][*j] as f64) < z_pay)
        .count();
    let summary = json!({
        "sigmaFloor": floor_on,
        "demoPosition": {
            "ticker": "SPYx", "debtUsd": 50_000, "debtToCovered": demo_ratio, "premiumUsd": usd(demo_premium),
            "breakEvenGap": demo_ratio - 1.0, "probabilityPays": p_pay, "historicalWeekendsPaying": hist_pay,
        },
        "book": {
            "policies": book.len(), "refusedByCapacity": refused,
            "perAsset": PER_ASSET, "debtToCoveredRange": [LO, HI], "debtUsdEach": usd(DEBT), "capEqualsDebt": true,
            "debtUsdTotal": usd(DEBT) * book.len() as f64,
            "premiumUsdPerWeekend": usd(premiums),
            "premiumBps": usd(premiums) / (usd(DEBT) * book.len() as f64) * 1e4,
            "reservedWorstLossUsd": usd(reserved), "utilisation": reserved as f64 / (EQUITY as f64 * 0.5),
            "premiumByRatio": book.iter().filter(|p| p.ticker == 0).map(|p| json!({"ratio": p.ratio, "premiumUsd": usd(p.premium)})).collect::<Vec<_>>(),
        },
        "vaultEquityUsd": usd(EQUITY),
        "closures": { "nonOvernight": ALL, "dated": dated.len(), "premiumOnly": premium_only, "synthetic": synthetic.len() },
        "totals": {
            "premiumsUsd": total_premiums, "payoutsUsd": dated_payouts, "pnlUsd": total_premiums - dated_payouts,
            "lossRatio": dated_payouts / total_premiums,
            "annualReturnOnEquity": (total_premiums - dated_payouts) / usd(EQUITY) / years,
        },
        "weekends": { "withPayout": paying, "withLoss": losing },
        "lpReturnQuantiles": { "0.001": q(0.001), "0.01": q(0.01), "0.05": q(0.05), "0.5": q(0.5), "0.95": q(0.95) },
        "worstWeekend": worst,
        "worstSynthetic": synthetic.iter().min_by(|a, b| a["pnlUsd"].as_f64().unwrap().total_cmp(&b["pnlUsd"].as_f64().unwrap())),
        "payoutsByYear": by_year.iter().map(|(y, (p, n))| json!({"year": y, "datedClosures": n, "payoutsUsd": p})).collect::<Vec<_>>(),
    });
    let out = json!({
        "kind": "credence.gap-cover-backtest.v1",
        "generatedBy": "programs/credence-core/examples/backtest.rs",
        "method": "today's model book and σ through history's standardised shocks: r = z × σ (σ: data/onchain/assets.json; QQQx on the SPY column), premium and payout from the program's own pricing code",
        "sigmaWad": { "SPYx": sigma[0].to_string(), "QQQx": sigma[1].to_string(), "NVDAx": sigma[2].to_string() },
        "caveats": [
            "the 312 non-overnight closures outside the joint stress set (basket mean z above +0.009) have no per-asset data here and are counted as premium-only, which understates payouts where one asset gapped down while the basket rose",
            "HOLIDAY_WEEKEND closures use the WEEKEND σ and premium",
            format!("equity is held at J0 every weekend; parameters: θ {}, c {}, η 1, β 97.5%, u_max 50%, min premium {} USDC, fee 0, σ floor {}", cfg.theta_wad as f64 / 1e18, cfg.cost_of_cap_wad as f64 / 1e18, usd(cfg.min_premium), if floor_on { "on" } else { "off" }),
            "Alpaca personal-licence data (data/README.md)",
        ],
        "summary": summary,
        "dated": dated,
        "synthetic": synthetic,
    });
    let name = std::env::var("BT_OUT").unwrap_or_else(|_| "gap-cover-backtest.json".into());
    let path = format!("{}/data/backtest/{name}", root());
    std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    println!("{}", serde_json::to_string_pretty(&out["summary"]).unwrap());
    println!("wrote {path}");
}
