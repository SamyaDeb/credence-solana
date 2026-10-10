//! C3 Gap Oracle feed, off-chain: the same arithmetic and flag rules as the on-chain `update_gap_feed`
//! (`credence_core::instructions::gap_feed::compute`), run on inputs read from MAINNET, where the `GapFeed` account does
//! not exist. Read by `scripts/src/gap-feed-mainnet.ts` and the Oracle page's public read-only mode, which labels the
//! result "computed off-chain from mainnet data; the feed account is not on mainnet".
//!
//!   cargo build -p credence-core --example gap_feed
//!   echo '{"now":…,"closureType":"WEEKEND","closeTs":…,"items":[…]}' | target/debug/examples/gap_feed [--root <repo>]
//!
//! Request: `{"now","closureType":"WEEKEND|OVERNIGHT|HOLIDAY_WEEKEND","closeTs","maxConfBps"?:50,"shieldMaxAgeSecs"?:129600,
//! "maxInputAgeSecs"?:3600,"items":[{"ticker","closePriceWad"?,"fair"?:{"priceWad","publishTs","confBps","full"},
//! "lender"?:{"priceWad","ts","sinceTs"?}}]}`. `sinceTs` is when the lender's price last changed
//! (the recorder's history); without it a first sighting is assumed, so the row is never flagged frozen. WAD amounts are decimal strings. σ and the scenario set of each ticker come from
//! `data/onchain/assets.json` and `data/onchain/<T>-<TYPE>.json` (the files the program's sets were uploaded from), so
//! a Jupiter alias `<T>.J` uses its base ticker's. A missing `fair` / `lender` / `closePriceWad` is recorded as missing,
//! never defaulted. Reply: `{"items":[{ticker, flags, flagNames, sigmaWad, pLt5Wad, pLt8Wad, pLt12Wad, nScen, closePriceWad,
//! fairPriceWad, lenderPriceWad, impliedGapFairWad, impliedGapLenderWad, …}]}`; errors reply `{"error":"…"}`.

use std::io::Read;

use credence_core::instructions::gap_feed::{compute, FairIn, FeedIn, LenderIn};
use credence_core::state::{closure, feed_flag as ff};
use serde_json::{json, Value};

const FLAGS: [(&str, u32); 12] = [
    ("MISSING_FAIR", ff::MISSING_FAIR), ("MISSING_LENDER", ff::MISSING_LENDER), ("NO_CLOSE", ff::NO_CLOSE), ("NO_SCENARIOS", ff::NO_SCENARIOS),
    ("STALE_FAIR", ff::STALE_FAIR), ("PAUSED", ff::PAUSED), ("FAIR_UNVERIFIED", ff::FAIR_UNVERIFIED), ("FAIR_OUTSIDE_CONF", ff::FAIR_OUTSIDE_CONF),
    ("LENDER_SUSPENDED", ff::LENDER_SUSPENDED), ("LENDER_FROZEN", ff::LENDER_FROZEN), ("LENDER_STALE", ff::LENDER_STALE), ("EARNINGS_ASSET", ff::EARNINGS_ASSET),
];

fn root() -> String {
    let args: Vec<String> = std::env::args().collect();
    match args.iter().position(|a| a == "--root") {
        Some(i) if i + 1 < args.len() => args[i + 1].clone(),
        _ => format!("{}/../..", env!("CARGO_MANIFEST_DIR")),
    }
}

fn wad(v: &Value, what: &str) -> Result<u128, String> {
    v.as_str().and_then(|s| s.parse().ok()).ok_or(format!("{what}: expected a decimal string"))
}
fn int(v: &Value, what: &str) -> Result<i64, String> {
    v.as_i64().ok_or(format!("{what}: expected an integer"))
}

fn run(req: &Value, root: &str) -> Result<Value, String> {
    let now = int(&req["now"], "now")?;
    let ty = match req["closureType"].as_str() {
        Some("WEEKEND") => closure::WEEKEND,
        Some("OVERNIGHT") => closure::OVERNIGHT,
        Some("HOLIDAY_WEEKEND") => closure::HOLIDAY_WEEKEND,
        _ => return Err("closureType: WEEKEND, OVERNIGHT or HOLIDAY_WEEKEND".into()),
    };
    let type_name = ["", "OVERNIGHT", "WEEKEND", "HOLIDAY_WEEKEND"][ty as usize];
    let close_ts = int(&req["closeTs"], "closeTs")?;
    let max_conf = req["maxConfBps"].as_u64().unwrap_or(50) as u32;
    let max_age = req["shieldMaxAgeSecs"].as_i64().unwrap_or(36 * 3600);
    let max_input_age = req["maxInputAgeSecs"].as_i64().unwrap_or(3600);
    let rd = |p: &str| -> Result<Value, String> {
        serde_json::from_str(&std::fs::read_to_string(format!("{root}/{p}")).map_err(|e| format!("{p}: {e}"))?).map_err(|e| format!("{p}: {e}"))
    };
    let assets = rd("data/onchain/assets.json")?;
    let mut out = vec![];
    for it in req["items"].as_array().ok_or("items: expected an array")? {
        let ticker = it["ticker"].as_str().ok_or("ticker: expected a string")?;
        let base = ticker.trim_end_matches(".J");
        let a = assets.as_array().ok_or("assets.json: expected an array")?.iter().find(|a| a["ticker"] == base).ok_or(format!("{ticker}: not in assets.json"))?;
        let sigma: u64 = a["sigmaByType"][type_name].as_str().and_then(|s| s.parse().ok()).ok_or(format!("{ticker}: no σ for {type_name}"))?;
        let z: Vec<i16> = rd(&format!("data/onchain/{base}-{type_name}.json"))?["z"]
            .as_array()
            .ok_or("z: expected an array")?
            .iter()
            .map(|x| x.as_i64().map(|v| v as i16).ok_or("z: integers"))
            .collect::<Result<_, _>>()?;
        let fair = match it.get("fair").filter(|v| !v.is_null()) {
            Some(f) => Some(FairIn {
                price_wad: Some(wad(&f["priceWad"], "fair.priceWad")?).filter(|p| *p > 0),
                publish_ts: int(&f["publishTs"], "fair.publishTs")?,
                conf_bps: f["confBps"].as_u64().ok_or("fair.confBps")? as u32,
                full: f["full"].as_bool().unwrap_or(false),
            }),
            None => None,
        };
        let lender = match it.get("lender").filter(|v| !v.is_null()) {
            Some(l) => Some(LenderIn { price_wad: wad(&l["priceWad"], "lender.priceWad")?, ts: int(&l["ts"], "lender.ts")?, suspended: false }),
            None => None,
        };
        let since = it.get("lender").and_then(|l| l.get("sinceTs")).and_then(|v| v.as_i64());
        let close = match it.get("closePriceWad").filter(|v| !v.is_null()) {
            Some(c) => wad(c, "closePriceWad")?,
            None => 0,
        };
        let o = compute(&FeedIn {
            now,
            closure_type: ty,
            close_ts,
            close_price_wad: close,
            fair,
            lender,
            prev_lender: lender.and_then(|l| since.map(|s| (l.price_wad, s))),
            scenarios: Some((sigma, &z)),
            paused: false,
            earnings: false,
            max_conf_bps: max_conf,
            shield_max_age_secs: max_age,
            max_input_age_secs: max_input_age,
        })
        .map_err(|e| format!("{ticker}: {e:?}"))?;
        out.push(json!({
            "ticker": ticker, "flags": o.flags, "flagNames": FLAGS.iter().filter(|(_, b)| o.flags & b != 0).map(|(n, _)| *n).collect::<Vec<_>>(),
            "blocked": o.flags & ff::BLOCKING != 0, "sigmaWad": o.sigma_wad.to_string(), "nScen": o.n_scen,
            "pLt5Wad": o.probs_wad[0].to_string(), "pLt8Wad": o.probs_wad[1].to_string(), "pLt12Wad": o.probs_wad[2].to_string(),
            "closePriceWad": o.close_price_wad.to_string(), "fairPriceWad": o.fair_price_wad.to_string(), "fairPublishTs": o.fair_publish_ts, "fairConfBps": o.fair_conf_bps,
            "lenderPriceWad": o.lender_price_wad.to_string(), "lenderTs": o.lender_ts, "lenderSinceTs": o.lender_since_ts,
            "impliedGapFairWad": o.implied_gap_fair_wad.to_string(), "impliedGapLenderWad": o.implied_gap_lender_wad.to_string(),
        }));
    }
    Ok(json!({ "closureType": type_name, "items": out }))
}

fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).ok();
    let reply = match serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()).and_then(|r| run(&r, &root())) {
        Ok(v) => v,
        Err(e) => json!({ "error": e }),
    };
    println!("{reply}");
}
