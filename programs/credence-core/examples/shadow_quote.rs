//! The program's own pricing as a line-oriented helper for the shadow keeper (W6, `keeper/src/shadow.ts`).
//!
//!   cargo build -p credence-core --example shadow_quote --release
//!   target/release/examples/shadow_quote [--root <repo>]   (one JSON request per stdin line, one JSON reply per line)
//!
//! Requests (amounts in USDC base units and prices in WAD, as decimal strings):
//! - `{"op":"book","equityUsdc":"…","positions":[{"id":…,"ticker":"SPYx","covered":"…","debt":"…","cap":"…"}]}`:
//!   sells the positions in order to a model vault with `equityUsdc` of equity, as `buy_cover` would (the program's
//!   `policy_losses`, `capacity`, the concentration cap and `premium`, with the on-chain gap factors computed by
//!   `risk-core::gap_factor`). Replies `{"premiums":[{"id","premium","utilAfterWad","worstLoss"} | {"id","refused"}]}`.
//! - `{"op":"payout","items":[{"covered","debt","cap","closeWad","settleWad"}]}` → `{"payouts":["…"]}`
//!   (`pricing::realized_payout`).
//! - `{"op":"shield","alphaWad","bufferWad","healthWad","items":[{"covered","debt","cap","closeWad","fairWad"}]}` →
//!   `{"targets":["…"]}` (`pricing::shield_target`).
//!
//! Errors reply `{"error":"…"}` and the helper keeps running. Parameters are the deployed Phase 1 ones (θ 1.0, c 10%,
//! η 1, β 97.5%, κ 0, min premium 5 USDC, u_max 50%, max asset share 50%, σ from `data/onchain/assets.json`).

use std::io::{BufRead, Write};

use anchor_lang::prelude::Pubkey;
use credence_core::math::{wad_to_q64_down, WAD};
use credence_core::pricing::{capacity, policy_losses, premium, realized_payout, shield_target, CoverInputs, ShieldParams};
use credence_core::state::{AssetConfig, Config, K};
use credence_core::WEEKEND_CLOSURE_DAYS;
use credence_risk_core::{gap_factor, U256};
use serde_json::{json, Value};

const TICKERS: [&str; 3] = ["SPYx", "QQQx", "NVDAx"];

/// Repository root for `data/onchain`: `--root <dir>` (the shadow keeper passes its own checkout), else this crate's.
fn root() -> String {
    let args: Vec<String> = std::env::args().collect();
    match args.iter().position(|a| a == "--root") {
        Some(i) if i + 1 < args.len() => args[i + 1].clone(),
        _ => format!("{}/../..", env!("CARGO_MANIFEST_DIR")),
    }
}
fn load(p: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{}/{p}", root())).expect(p)).expect(p)
}
fn zs(v: &Value) -> Vec<i16> {
    v.as_array().expect("array").iter().map(|x| x.as_i64().expect("i16") as i16).collect()
}

/// The deployed Phase 1 parameters (same as `examples/backtest.rs` and `scripts/src/load-onchain.ts`).
fn config() -> Config {
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
        shield_alpha_wad: 0,
        shield_buffer_wad: (WAD / 50) as u64,
        shield_health_wad: 0,
        shield_lambda_wad: (2 * WAD) as u64,
        shield_max_age_secs: 36 * 3600,
        shield_start_before_open_secs: 48_600,
        shield_deadline_before_open_secs: 9_000,
        paused: false,
        bump: 0,
    }
}

/// An `AssetConfig` with the K gap factors `compute_gap_factors` would store (risk-core, Q64.64 rounded down).
fn asset(sigma: u64, column: &[i16]) -> Box<AssetConfig> {
    let mut a: Box<AssetConfig> = Box::new(bytemuck::Zeroable::zeroed());
    a.sigma_wad = sigma;
    for (j, z) in column.iter().enumerate() {
        let g = gap_factor(*z, U256::from(sigma), U256::ZERO, U256::ZERO).expect("gap factor");
        a.gap_factors[j] = wad_to_q64_down(g).expect("q64").to_le_bytes();
    }
    a.gf_count = K as u16;
    a
}

struct Model {
    cfg: Config,
    sigma: Vec<u64>,
    sets: Vec<Vec<i16>>,
    assets: Vec<Box<AssetConfig>>,
}

fn num<T: std::str::FromStr>(v: &Value, k: &str) -> Result<T, String> {
    let s = v[k].as_str().ok_or_else(|| format!("{k}: expected a decimal string"))?;
    s.parse().map_err(|_| format!("{k}: not a number"))
}

fn book(m: &Model, req: &Value) -> Result<Value, String> {
    let equity: u64 = num(req, "equityUsdc")?;
    let conc_limit = (equity as u128) * (m.cfg.u_max_wad as u128) / WAD * (m.cfg.max_asset_share_wad as u128) / WAD;
    let mut group = [0u64; K];
    let mut asset_worst = [0u64; 3];
    let mut out = vec![];
    for p in req["positions"].as_array().ok_or("positions: expected an array")? {
        let i = TICKERS.iter().position(|t| Some(*t) == p["ticker"].as_str()).ok_or("ticker: not covered")?;
        let x = CoverInputs { covered_value: num(p, "covered")?, debt: num(p, "debt")?, max_payout: num(p, "cap")? };
        let mut losses = vec![0u64; K];
        let worst = policy_losses(&m.assets[i], &x, &mut losses).map_err(|e| e.to_string())?;
        let Ok(cap) = capacity(&group, &losses, 0, equity, m.cfg.u_max_wad) else {
            out.push(json!({ "id": p["id"], "refused": "CapacityExceeded" }));
            continue;
        };
        if (asset_worst[i] + worst) as u128 > conc_limit {
            out.push(json!({ "id": p["id"], "refused": "ConcentrationExceeded" }));
            continue;
        }
        let prem = premium(&m.sets[i], &m.cfg, m.sigma[i], 0, WEEKEND_CLOSURE_DAYS, cap.util_after_wad, &x)
            .map_err(|e| e.to_string())?;
        for (g, l) in group.iter_mut().zip(&losses) {
            *g += l;
        }
        asset_worst[i] += worst;
        out.push(json!({
            "id": p["id"], "premium": prem.to_string(), "utilAfterWad": cap.util_after_wad.to_string(),
            "worstLoss": worst.to_string(),
        }));
    }
    Ok(json!({ "premiums": out, "reservedWorstLoss": group.iter().max().copied().unwrap_or(0).to_string() }))
}

fn handle(m: &Model, line: &str) -> Value {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({ "error": format!("bad json: {e}") }),
    };
    let items = || req["items"].as_array().cloned().unwrap_or_default();
    let r: Result<Value, String> = match req["op"].as_str() {
        Some("book") => book(m, &req),
        Some("payout") => items()
            .iter()
            .map(|x| {
                realized_payout(num(x, "covered")?, num(x, "debt")?, num(x, "cap")?, num(x, "closeWad")?, num(x, "settleWad")?)
                    .map(|p| p.to_string())
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|v| json!({ "payouts": v })),
        Some("shield") => (|| {
            let p = ShieldParams { alpha_wad: num(&req, "alphaWad")?, buffer_wad: num(&req, "bufferWad")?, health_wad: num(&req, "healthWad")? };
            items()
                .iter()
                .map(|x| {
                    shield_target(num(x, "covered")?, num(x, "debt")?, num(x, "cap")?, num(x, "closeWad")?, num(x, "fairWad")?, &p)
                        .map(|t| t.to_string())
                        .map_err(|e| e.to_string())
                })
                .collect::<Result<Vec<_>, String>>()
                .map(|v| json!({ "targets": v }))
        })(),
        _ => Err("op: expected book, payout or shield".into()),
    };
    r.unwrap_or_else(|e| json!({ "error": e }))
}

fn main() {
    let assets = load("data/onchain/assets.json");
    let joint = load("data/onchain/joint-v1.json");
    let cols: Vec<Vec<i16>> = joint["columns"].as_array().expect("columns").iter().map(zs).collect();
    let sigma: Vec<u64> = (0..3).map(|i| assets[i]["sigmaWad"].as_str().expect("sigma").parse().expect("sigma")).collect();
    let m = Model {
        cfg: config(),
        sets: TICKERS.iter().map(|t| zs(&load(&format!("data/onchain/{t}-WEEKEND.json"))["z"])).collect(),
        assets: (0..3).map(|i| asset(sigma[i], &cols[i])).collect(),
        sigma,
    };
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "{}", json!({ "ready": true, "sigmaWad": m.sigma.iter().map(|s| s.to_string()).collect::<Vec<_>>() })).ok();
    out.flush().ok();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        writeln!(out, "{}", handle(&m, &line)).ok();
        out.flush().ok();
    }
}
