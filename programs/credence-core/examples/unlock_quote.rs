//! C1 credit unlock (plan/09 "Phase C, C1"): the program's pricing applied to scanned positions, as a line-oriented
//! helper for `scripts/src/unlock.ts`. The model is `examples/unlock/model.rs` (also used by the golden test
//! `tests/unlock.rs`); `examples/shadow_quote.rs` is unchanged (the shadow keeper's helper).
//!
//!   cargo build -p credence-core --example unlock_quote --release
//!   target/release/examples/unlock_quote [--root <repo>]   (one JSON request per stdin line, one JSON reply per line)
//!
//! Amounts are USDC base units and WAD fractions as decimal strings. A position is
//! `{"id","legs":[{"ticker","covered"}],"stable","debt","multi"}` (`multi`: the `buy_cover_multi` path; otherwise one leg,
//! a Kamino ticker or a Jupiter alias `<T>.J`).
//!
//! - `{"op":"init","basisWad":{"<T>":"…"}}` (σ_b per xStock, as `load-onchain.ts` sets it) → `{"assets":[…]}`. Required
//!   first.
//! - `{"op":"analyse","positions":[…],"targets":["…"]}` → per position: P(liquidatable) today (scenario count and set
//!   size), the history count, and per target t (where D/C′ < t): D_t = ⌈t × C′⌉, extra debt, the u = 0 quote (cap D_t),
//!   P(liquidatable) at D_t without cover, and the residual with cover and the Shield at e = 0, −σ_b, +σ_b.
//! - `{"op":"capacity","positions":[…],"prefixes":[n…]}` (positions at their target debt, in sale order) → per prefix
//!   the LP equity it needs (and which rule binds), and for the whole list the premiums at the utilisation after each
//!   sale at that equity (`book`), checked: every policy sells at the equity, one is refused 1 base unit below.
//!
//! Errors reply `{"error":"…"}` and the helper keeps running.

#[path = "unlock/model.rs"]
mod model;

use std::collections::HashMap;
use std::io::{BufRead, Write};

use credence_core::math::WAD;
use model::*;
use serde_json::{json, Value};

fn root() -> String {
    let args: Vec<String> = std::env::args().collect();
    match args.iter().position(|a| a == "--root") {
        Some(i) if i + 1 < args.len() => args[i + 1].clone(),
        _ => format!("{}/../..", env!("CARGO_MANIFEST_DIR")),
    }
}

fn positions(m: &Model, req: &Value) -> Result<Vec<Position>, String> {
    req["positions"].as_array().ok_or("positions: expected an array")?.iter().map(|p| parse_position(m, p)).collect()
}

fn priced_json(p: &Priced) -> Value {
    json!({ "premium": p.premium.to_string(), "loading": p.loading.to_string(), "worstLoss": p.worst.to_string(),
            "expectedLoss": p.expected_loss.to_string() })
}

fn analyse(m: &Model, req: &Value) -> Result<Value, String> {
    let targets: Vec<u64> = req["targets"]
        .as_array()
        .ok_or("targets: expected an array")?
        .iter()
        .map(|t| t.as_str().and_then(|s| s.parse().ok()).ok_or("target: decimal WAD string"))
        .collect::<Result<_, _>>()?;
    let mut out = vec![];
    for p in positions(m, req)? {
        let c = p.covered();
        let (n, of) = p_liquidatable(m, &p);
        let (h, hof) = history(m, &p);
        let mut ts = vec![];
        for t in &targets {
            let dt = u64::try_from((*t as u128 * c as u128).div_ceil(WAD)).map_err(|_| "target debt")?;
            if dt <= p.debt {
                ts.push(Value::Null);
                continue;
            }
            let pt = p.at_debt(dt);
            let q = price(m, &pt, dt, 0)?;
            let (pn, pof) = p_liquidatable(m, &pt);
            let mut res = vec![];
            for k in [0i64, -1, 1] {
                let (r, rof, adv, capped) = residual(m, &pt, k)?;
                res.push(json!({ "basisSigmas": k, "n": r, "of": rof, "maxAdvance": adv.to_string(), "inv12Capped": capped }));
            }
            ts.push(json!({
                "targetWad": t.to_string(), "debt": dt.to_string(), "extra": (dt - p.debt).to_string(), "quote": priced_json(&q),
                "pLiquidatable": { "n": pn, "of": pof }, "residual": res,
            }));
        }
        out.push(json!({
            "id": p.id, "covered": c.to_string(), "pLiquidatable": { "n": n, "of": of }, "history": { "n": h, "of": hof },
            "targets": ts,
        }));
    }
    Ok(json!({ "positions": out }))
}

fn capacity_op(m: &Model, req: &Value) -> Result<Value, String> {
    let ps = positions(m, req)?;
    let priced: Vec<Priced> = ps.iter().map(|p| price(m, p, p.debt, 0)).collect::<Result<_, _>>()?;
    let prefixes: Vec<usize> = req["prefixes"].as_array().ok_or("prefixes")?.iter().map(|v| v.as_u64().unwrap_or(0) as usize).collect();
    let tickers = |v: &[u64]| -> Value {
        v.iter().enumerate().filter(|(_, e)| **e > 0).map(|(i, e)| (m.assets[i].ticker.clone(), Value::String(e.to_string()))).collect::<serde_json::Map<_, _>>().into()
    };
    let mut slices = vec![];
    for n in prefixes {
        let n = n.min(ps.len());
        let e = equity_needed(m, &ps[..n], &priced[..n]);
        let binding = if e.equity == 0 {
            "none".to_string()
        } else if e.equity == e.capacity {
            "capacity".to_string()
        } else {
            let i = e.per_asset.iter().enumerate().max_by_key(|(_, v)| **v).map(|(i, _)| i).unwrap_or(0);
            format!("concentration:{}", m.assets[i].ticker)
        };
        // The program's own sale at that equity sells every policy; 1 base unit less refuses one.
        let ok = book(m, &ps[..n], &priced[..n], e.equity, false)?;
        let all = ok.sold.iter().all(|s| s.is_some());
        let below = if e.equity == 0 { false } else { book(m, &ps[..n], &priced[..n], e.equity - 1, false)?.sold.iter().all(|s| s.is_some()) };
        if !all || below {
            return Err(format!("equity check failed at prefix {n}: all {all}, below {below}"));
        }
        slices.push(json!({
            "n": n, "equity": e.equity.to_string(), "capacityEquity": e.capacity.to_string(), "binding": binding,
            "perAssetEquity": tickers(&e.per_asset), "groupWorstLoss": e.group_worst.to_string(),
            "assetWorstLoss": tickers(&ok.asset_worst),
        }));
    }
    // Premiums at the utilisation each policy sees when the whole list sells at the equity it needs.
    let full = equity_needed(m, &ps, &priced);
    let b = book(m, &ps, &priced, full.equity, true)?;
    let prem: Vec<Value> = ps
        .iter()
        .zip(&b.sold)
        .map(|(p, s)| match s {
            Some(x) => json!({ "id": p.id, "premium": x.premium.to_string(), "expectedLoss": x.expected_loss.to_string() }),
            None => json!({ "id": p.id, "refused": true }),
        })
        .collect();
    Ok(json!({ "slices": slices, "bookEquity": full.equity.to_string(), "book": prem }))
}

fn main() {
    let r = root();
    let mut model: Option<Model> = None;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "{}", json!({ "ready": true, "method": METHOD })).ok();
    out.flush().ok();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Err(e) => json!({ "error": format!("bad json: {e}") }),
            Ok(req) => {
                let res: Result<Value, String> = match (req["op"].as_str(), &model) {
                    (Some("init"), _) => (|| {
                        let b = req["basisWad"].as_object().ok_or("basisWad: expected an object")?;
                        let basis: HashMap<String, u64> =
                            b.iter().map(|(k, v)| (k.clone(), v.as_str().and_then(|s| s.parse().ok()).unwrap_or(0))).collect();
                        let m = load(&r, &basis)?;
                        let list: Vec<Value> = m
                            .assets
                            .iter()
                            .map(|a| json!({ "ticker": a.ticker, "base": a.base, "sigmaWad": a.sigma.to_string(), "basisWad": a.basis.to_string() }))
                            .collect();
                        model = Some(m);
                        Ok(json!({ "assets": list, "method": METHOD }))
                    })(),
                    (_, None) => Err("init first".into()),
                    (Some("analyse"), Some(m)) => analyse(m, &req),
                    (Some("capacity"), Some(m)) => capacity_op(m, &req),
                    _ => Err("op: expected init, analyse or capacity".into()),
                };
                res.unwrap_or_else(|e| json!({ "error": e }))
            }
        };
        writeln!(out, "{reply}").ok();
        out.flush().ok();
    }
}

#[cfg(test)]
mod tests {
    //! Properties of the unlock model on synthetic positions over the real data (plan/09 C1 checks).
    use super::*;

    fn model() -> Model {
        let assets: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/data/onchain/assets.json", root())).unwrap()).unwrap();
        // A plain σ_b (1%) per asset: the properties do not depend on its value.
        let basis = assets.as_array().unwrap().iter().map(|a| (a["ticker"].as_str().unwrap().to_string(), WAD as u64 / 100)).collect();
        load(&root(), &basis).unwrap()
    }

    fn single(m: &Model, t: &str, c: u64, d: u64) -> Position {
        Position { id: format!("{t}-{d}"), legs: vec![(m.index[t], c)], stable: 0, debt: d, multi: false }
    }

    /// Extra debt ≥ 0 and monotone in t; premium monotone in t; residual P ≤ P without cover at the same debt; no
    /// premium below the 5 USDC minimum. Every asset (aliases included), single and multi-collateral.
    #[test]
    fn unlock_properties() {
        let m = model();
        let c = 100_000_000_000u64; // C′ 100,000 USDC
        let mut cases: Vec<Position> = vec![];
        for a in &m.assets {
            for r in [0.30, 0.71, 0.76, 0.84] {
                cases.push(single(&m, &a.ticker, c, (c as f64 * r) as u64));
            }
        }
        let i = |t: &str| m.index[t];
        cases.push(Position { id: "multi".into(), legs: vec![(i("SPYx"), c / 2), (i("TSLAx"), c / 4)], stable: c / 4, debt: c / 2, multi: true });
        cases.push(Position { id: "pyusd".into(), legs: vec![(i("NVDAx"), c)], stable: 0, debt: c * 7 / 10, multi: true });
        cases.push(Position { id: "mstr-hood".into(), legs: vec![(i("MSTRx"), c / 2), (i("HOODx"), c / 2)], stable: 0, debt: c * 6 / 10, multi: true });
        for p in &cases {
            let cv = p.covered();
            let (mut last_extra, mut last_prem) = (0u64, 0u64);
            for t in [850u64, 900, 950] {
                let dt = (t as u128 * cv as u128).div_ceil(1000) as u64;
                assert!(dt > p.debt, "{}: target below today's D/C′", p.id);
                let extra = dt - p.debt;
                assert!(extra >= last_extra, "{}: extra debt not monotone", p.id);
                let pt = p.at_debt(dt);
                let q = price(&m, &pt, dt, 0).unwrap();
                assert!(q.premium >= m.cfg.min_premium, "{}: premium below the minimum", p.id);
                assert!(q.premium >= last_prem, "{}: premium not monotone in the target ({} < {last_prem})", p.id, q.premium);
                let (pn, pof) = p_liquidatable(&m, &pt);
                for k in [0i64, -1, 1] {
                    let (r, rof, _, _) = residual(&m, &pt, k).unwrap();
                    assert_eq!(rof, pof);
                    assert!(r <= pn, "{} t {t} e {k}σ_b: residual {r} > uncovered {pn}", p.id);
                }
                (last_extra, last_prem) = (extra, q.premium);
            }
        }
    }

    /// The single-leg probability is the app's `modelPays` rule: ascending z, liquidatable iff D·1000·WAD > C′·(1000·WAD + σz).
    #[test]
    fn p_liquidatable_matches_the_rule() {
        let m = model();
        let p = single(&m, "MSTRx", 1_000_000_000, 900_000_000);
        let a = &m.assets[m.index["MSTRx"]];
        let (n, of) = p_liquidatable(&m, &p);
        let brute = a.z.iter().filter(|z| (900_000_000u128) * 1000 * WAD > 1_000_000_000u128 * (1000 * WAD as i128 + a.sigma as i128 * **z as i128).max(0) as u128).count();
        assert_eq!((n as usize, of as usize), (brute, a.z.len()));
        assert!(n > 0);
    }

    /// The equity a book needs: every policy sells at it, one is refused 1 base unit below.
    #[test]
    fn equity_needed_is_tight() {
        let m = model();
        let c = 10_000_000_000u64;
        let ps: Vec<Position> = (0..40)
            .map(|k| {
                let t = &m.assets[k % m.assets.len()].ticker;
                single(&m, t, c + k as u64 * 1_000_000, c * 9 / 10)
            })
            .collect();
        let pr: Vec<Priced> = ps.iter().map(|p| price(&m, p, p.debt, 0).unwrap()).collect();
        let e = equity_needed(&m, &ps, &pr);
        assert!(book(&m, &ps, &pr, e.equity, false).unwrap().sold.iter().all(|s| s.is_some()));
        assert!(!book(&m, &ps, &pr, e.equity - 1, false).unwrap().sold.iter().all(|s| s.is_some()));
    }
}
