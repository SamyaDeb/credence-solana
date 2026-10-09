//! C2 curator book quote: the program's own leg pricing (`pricing::leg_quote_single` / `leg_quote_multi`, the leg's
//! payout losses on the joint set) and `risk-core::book_premium`, next to each leg's standalone premium (`model::price`,
//! what `buy_cover*` charges). Read by the app's `/api/book-quote` (Curator page); nothing in the app prices.
//!
//!   cargo build -p credence-core --example book_quote
//!   echo '{"positions":[…],"utilWad":"0","targetWad":"900000000000000000"}' | target/debug/examples/book_quote [--root <repo>]
//!
//! Positions are C1's format (`{"id","legs":[{"ticker","covered"}],"stable","debt","multi"}`, USDC base units). With
//! `targetWad` each position is priced at the debt `⌈t × C′⌉` it would carry at that D/C′ (positions already at or
//! above it are left out), and the reply also has the extra credit. Full cover (cap = debt), as a book leg is.
//! One JSON reply on stdout: `{"legs":[{id, standalone, e, es, loading, w, extra}], "book": {premium, base, esJoint,
//! esBook}, "sumStandalone", "minPremium"}`; amounts as decimal strings.

#[path = "unlock/model.rs"]
mod model;

use std::collections::HashMap;
use std::io::Read;

use credence_core::math::WAD;
use credence_core::pricing::{
    book_params, leg_quote_multi, leg_quote_single, policy_losses, policy_losses_multi, priced_debt, reserved_debt, settlement_losses_multi,
    settlement_losses_single, CoverInputs, LegPricing, MultiInputs,
};
use credence_core::state::{AssetConfig, K};
use credence_risk_core::{book_premium_from_sums, BookSums, U256};
use model::*;
use serde_json::{json, Value};

fn root() -> String {
    let args: Vec<String> = std::env::args().collect();
    match args.iter().position(|a| a == "--root") {
        Some(i) if i + 1 < args.len() => args[i + 1].clone(),
        _ => format!("{}/../..", env!("CARGO_MANIFEST_DIR")),
    }
}

fn wad(v: &Value) -> u64 {
    v.as_str().and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn run(req: &Value) -> Result<Value, String> {
    // σ_b per base ticker (as the loader sets it): data/shield-basis.json via the request, else 0 is refused.
    let basis: HashMap<String, u64> = req["basisWad"]
        .as_object()
        .ok_or("basisWad: σ_b per xStock")?
        .iter()
        .map(|(k, v)| (k.clone(), wad(v)))
        .collect();
    let m = load(&root(), &basis)?;
    let util = wad(&req["utilWad"]);
    let target = req["targetWad"].as_str().and_then(|s| s.parse::<u64>().ok());
    let cfg = &m.cfg;
    let e = |x: anchor_lang::error::Error| x.to_string();
    let mut sums = BookSums::default();
    let mut joint = vec![0u64; K];
    let (mut sum_standalone, mut legs_out) = (0u128, vec![]);
    for v in req["positions"].as_array().ok_or("positions: expected an array")? {
        let p0 = parse_position(&m, v)?;
        let (p, extra) = match target {
            Some(t) => {
                let dt = u64::try_from((t as u128 * p0.covered() as u128).div_ceil(WAD)).map_err(|_| "target debt")?;
                if dt <= p0.debt {
                    continue;
                }
                (p0.at_debt(dt), dt - p0.debt)
            }
            None => (p0.clone(), 0),
        };
        let standalone = price(&m, &p, p.debt, util)?.premium;
        let mut reserved = vec![0u64; K];
        let mut settle = vec![0u64; K];
        let q = if !p.multi {
            let a = &m.assets[p.legs[0].0];
            let xr = CoverInputs { covered_value: p.legs[0].1, debt: reserved_debt(p.debt, cfg).map_err(e)?, max_payout: p.debt };
            let xp = CoverInputs { debt: priced_debt(p.debt, cfg).map_err(e)?, ..xr };
            let worst = policy_losses(&a.cfg, cfg, &xr, &mut reserved).map_err(e)?;
            settlement_losses_single(&a.cfg, &xp, &mut settle).map_err(e)?;
            leg_quote_single(&a.z, cfg, a.sigma, a.dividend, a.basis, &xp, worst).map_err(e)?
        } else {
            let refs: Vec<&AssetConfig> = p.legs.iter().map(|l| &*m.assets[l.0].cfg).collect();
            let covered: Vec<u64> = p.legs.iter().map(|l| l.1).collect();
            let xr = MultiInputs { legs: &covered, stable: p.stable, debt: reserved_debt(p.debt, cfg).map_err(e)?, max_payout: p.debt };
            let worst = policy_losses_multi(&refs, cfg, &xr, &mut reserved).map_err(e)?;
            let xp = MultiInputs { debt: priced_debt(p.debt, cfg).map_err(e)?, ..xr };
            settlement_losses_multi(&refs, &xp, &mut settle).map_err(e)?;
            let pricing: Vec<LegPricing> = p
                .legs
                .iter()
                .map(|l| {
                    let a = &m.assets[l.0];
                    LegPricing { z: &a.z, sigma_wad: a.sigma, dividend_wad: a.dividend, basis_sigma_wad: a.basis }
                })
                .collect();
            leg_quote_multi(&pricing, cfg, &xp, &settle, worst).map_err(e)?
        };
        sums = credence_risk_core::book::add_leg(&sums, q.e, q.es, q.loading).map_err(|_| "sums")?;
        for (j, s) in joint.iter_mut().zip(&settle) {
            *j = j.checked_add(*s).ok_or("joint overflow")?;
        }
        sum_standalone += standalone as u128;
        legs_out.push(json!({
            "id": p.id, "debt": p.debt.to_string(), "standalone": standalone.to_string(), "e": q.e.to_string(), "es": q.es.to_string(),
            "loading": q.loading.to_string(), "w": q.w.to_string(), "extra": extra.to_string(),
        }));
    }
    if legs_out.is_empty() {
        return Ok(json!({ "legs": [], "book": null, "sumStandalone": "0", "minPremium": cfg.min_premium.to_string() }));
    }
    let b = book_premium_from_sums(&sums, &joint, U256::from(util), &book_params(cfg)).map_err(|_| "book premium")?;
    Ok(json!({
        "legs": legs_out,
        "book": { "premium": b.premium.to_string(), "base": b.base.to_string(), "esJoint": b.es_joint.to_string(), "esBook": b.es_book.to_string(),
                  "expectedLoss": sums.e.to_string(), "loading": sums.loading.to_string() },
        "sumStandalone": sum_standalone.to_string(),
        "minPremium": cfg.min_premium.to_string(),
        "utilWad": util.to_string(),
        "method": "book.v1 (pricing::leg_quote_* + risk-core::book_premium; standalone = buy_cover* pricing)",
    }))
}

fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).expect("stdin");
    let out = serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()).and_then(|req| run(&req));
    match out {
        Ok(v) => println!("{v}"),
        Err(e) => {
            println!("{}", json!({ "error": e }));
            std::process::exit(1);
        }
    }
}
