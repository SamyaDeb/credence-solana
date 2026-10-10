//! D3 hedge sizing (testnet hedge, research): the keeper's helper. One JSON request on stdin, one JSON reply on stdout;
//! no risk math lives in TypeScript.
//!
//!   cargo run -q -p credence-core --example hedge_delta --release < request.json
//!
//! `{"op":"bounds","legs":[{"notional","entry","exit"}],"pnl":"…","cap":"…","margin":"…"}` (WAD prices as decimal strings; `cap` and `margin` optional) replies
//! `{"implied":"…","pnl":"…"}`: the P&L the prices imply for the shorts (`risk-core::hedge::short_pnl_total`) and the reported
//! P&L clamped to it, which is what `report_hedge` accepts.
//!
//! Request: `{"h":"0.5","capNotional":"300000000","positions":[{"debt","cap","covered":{"<T>":"…"},"stable"}]}` with amounts in
//! USDC base units as decimal strings. `covered` is C′ = LT × collateral value per xStock. Reply:
//! `{"delta":{"<T>":"…"},"notional":{"<T>":"…"},"scaled":bool}`: `delta` is `risk-core::hedge::loss_delta` over the 256 joint
//! scenarios (σ from `data/onchain/assets.json`, columns from `data/onchain/joint-v2.json`), `notional` is `h × delta` rounded
//! down, scaled down pro rata when its sum exceeds `capNotional`. Errors reply `{"error":"…"}`.

use std::io::Read;

use credence_risk_core::hedge::{hedge_notional, loss_delta, HedgePosition};
use credence_risk_core::{MathError, U256};
use serde_json::{json, Value};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}
fn load(p: &str) -> Result<Value, String> {
    let s = std::fs::read_to_string(format!("{}/{p}", root())).map_err(|e| format!("{p}: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("{p}: {e}"))
}
fn u(v: &Value, what: &str) -> Result<u64, String> {
    v.as_str().ok_or(format!("{what}: expected a decimal string"))?.parse().map_err(|_| format!("{what}: not a number"))
}
fn wad(s: &str) -> Result<u64, String> {
    // "0.5" -> 5e17; at most 18 decimals.
    let (i, f) = s.split_once('.').unwrap_or((s, ""));
    if f.len() > 18 || i.is_empty() || !i.bytes().chain(f.bytes()).all(|b| b.is_ascii_digit()) {
        return Err(format!("h: not a decimal: {s}"));
    }
    let v: u128 = i.parse::<u128>().map_err(|_| "h")? * 10u128.pow(18) + if f.is_empty() { 0 } else { f.parse::<u128>().map_err(|_| "h")? * 10u128.pow(18 - f.len() as u32) };
    u64::try_from(v).map_err(|_| "h: too large".to_string())
}

fn bounds(req: &Value) -> Result<Value, String> {
    let legs: Vec<(u64, u128, u128)> = req["legs"]
        .as_array()
        .ok_or("legs: expected an array")?
        .iter()
        .map(|l| {
            let w = |k: &str| l[k].as_str().ok_or(format!("{k}: expected a string"))?.parse::<u128>().map_err(|_| format!("{k}: not a number"));
            Ok((u(&l["notional"], "notional")?, w("entry")?, w("exit")?))
        })
        .collect::<Result<_, String>>()?;
    let implied = credence_risk_core::hedge::short_pnl_total(&legs).map_err(|e| format!("{e:?}"))?;
    let pnl: i64 = req["pnl"].as_str().ok_or("pnl: expected a string")?.parse().map_err(|_| "pnl: not a number")?;
    // The program's other caps (gain and loss at most `cap`, loss at most `margin`), when the request names them.
    let cap = req.get("cap").filter(|c| !c.is_null()).map(|c| u(c, "cap")).transpose()?.unwrap_or(u64::MAX);
    let margin = req.get("margin").filter(|c| !c.is_null()).map(|c| u(c, "margin")).transpose()?.unwrap_or(u64::MAX);
    let clamped = credence_risk_core::hedge::clamp_report(pnl, implied, cap, margin);
    Ok(json!({ "implied": implied.to_string(), "pnl": clamped.to_string() }))
}

fn run(req: &Value) -> Result<Value, String> {
    if req["op"] == "bounds" {
        return bounds(req);
    }
    let assets = load("data/onchain/assets.json")?;
    let joint = load("data/onchain/joint-v2.json")?;
    let tickers: Vec<String> = joint["tickers"].as_array().ok_or("joint tickers")?.iter().map(|t| t.as_str().unwrap_or("").to_string()).collect();
    let cols: Vec<Vec<i16>> = joint["columns"]
        .as_array()
        .ok_or("joint columns")?
        .iter()
        .map(|c| c.as_array().unwrap_or(&vec![]).iter().map(|x| x.as_i64().unwrap_or(0) as i16).collect())
        .collect();
    let n = tickers.len();
    let k = cols.first().map_or(0, |c| c.len());
    let mut sigma = vec![U256::ZERO; n];
    for (i, t) in tickers.iter().enumerate() {
        let a = assets.as_array().ok_or("assets")?.iter().find(|a| a["ticker"] == *t).ok_or(format!("no asset {t}"))?;
        sigma[i] = U256::from(a["sigmaWad"].as_str().ok_or("sigmaWad")?.parse::<u64>().map_err(|_| "sigmaWad")?);
    }
    let z: Vec<Vec<i16>> = (0..k).map(|j| (0..n).map(|i| cols[i][j]).collect()).collect();
    let mut positions = vec![];
    for p in req["positions"].as_array().ok_or("positions: expected an array")? {
        let mut covered = vec![0u64; n];
        for (t, v) in p["covered"].as_object().ok_or("covered: expected an object")? {
            let i = tickers.iter().position(|x| x == t).ok_or(format!("unknown ticker {t}"))?;
            covered[i] = u(v, "covered")?;
        }
        positions.push(HedgePosition { debt: u(&p["debt"], "debt")?, cap: u(&p["cap"], "cap")?, covered, stable: u(&p["stable"], "stable")? });
    }
    let h = wad(req["h"].as_str().ok_or("h: expected a decimal string")?)?;
    let eps = (credence_core::math::WAD / 100) as u64;
    let delta = loss_delta(&positions, &z, &sigma, &vec![U256::ZERO; n], eps).map_err(|e: MathError| format!("loss_delta: {e:?}"))?;
    let mut notional: Vec<u64> = delta.iter().map(|d| hedge_notional(*d, h).map_err(|e| format!("{e:?}"))).collect::<Result<_, _>>()?;
    let total: u128 = notional.iter().map(|x| *x as u128).sum();
    let mut scaled = false;
    if let Some(cap) = req.get("capNotional").filter(|c| !c.is_null()) {
        let cap = u(cap, "capNotional")? as u128;
        if total > cap {
            notional.iter_mut().for_each(|x| *x = (*x as u128 * cap / total) as u64); // pro rata, rounded down
            scaled = true;
        }
    }
    let by = |v: &[u64]| -> Value { tickers.iter().zip(v).filter(|(_, x)| **x > 0).map(|(t, x)| (t.clone(), json!(x.to_string()))).collect::<serde_json::Map<_, _>>().into() };
    Ok(json!({ "delta": by(&delta), "notional": by(&notional), "scaled": scaled }))
}

fn main() {
    let mut s = String::new();
    let _ = std::io::stdin().read_to_string(&mut s);
    let out = serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()).and_then(|r| run(&r));
    println!("{}", out.unwrap_or_else(|e| json!({ "error": e })));
}
