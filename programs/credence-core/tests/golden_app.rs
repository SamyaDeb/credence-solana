//! Golden vectors for the app (task 4.2). The app's loss table ports `pricing::realized_payout` to TypeScript
//! (app/src/lib/payout.ts); app/test/payout-golden.test.ts checks the port against the vectors this test pins.
//!
//! `cargo test -p credence-core --test golden_app` compares the program's results with the committed file;
//! `GOLDEN_WRITE=1 cargo test -p credence-core --test golden_app` regenerates it.

use credence_core::pricing;
use serde_json::{json, Value};

const WAD: u128 = 1_000_000_000_000_000_000;
const FILE: &str = "app/test/fixtures/payout-golden.json";

/// Settlement price for a gap of `bps` basis points from a close of `close` (the app's loss-table convention:
/// `settle = close × (10,000 + bps) / 10,000`, rounded down).
fn gapped(close: u128, bps: i64) -> u128 {
    close * ((10_000 + bps) as u128) / 10_000
}

fn vectors() -> Vec<Value> {
    // (C′, D, cap) in USDC base units: the demo positions, a near-threshold and a healthy book, rounding edges.
    let positions: [(u64, u64, u64); 9] = [
        (447_536_918, 429_611_768, 429_611_768),
        (447_536_918, 429_611_768, 10_000_000),
        (17_587_000_000, 16_890_000_000, 16_890_000_000),
        (415_000_000_000, 315_180_770_000, 315_180_770_000),
        (1, 1, 1),
        (999_999, 1_000_000, 1_000_000),
        (1_000_000, 999_999, 999_999),
        (u64::MAX / 4, u64::MAX / 8, u64::MAX / 8),
        (123_456_789, 120_000_000, 0),
    ];
    let closes: [u128; 4] = [WAD, 781_741_900_000_000_000_000, 760_579_600_000_000_000_000, 237_894_000_000_000_001];
    let gaps: [i64; 12] = [-2_000, -1_500, -1_200, -1_000, -800, -500, -333, -1, 0, 1, 500, 1_200];
    let mut out = Vec::new();
    for &(c, d, cap) in &positions {
        for &close in &closes {
            for &g in &gaps {
                let settle = gapped(close, g);
                let p = pricing::realized_payout(c, d, cap, close, settle).unwrap();
                out.push(json!({
                    "coveredValue": c.to_string(), "debt": d.to_string(), "cap": cap.to_string(),
                    "closeWad": close.to_string(), "settleWad": settle.to_string(), "gapBps": g, "payout": p.to_string(),
                }));
            }
        }
    }
    // The settled demo epoch (data/demo/demo-result.json): SPYx 781.7419 → 719.2026 on Kamino's Scope.
    let (close, settle) = (781_741_900_000_000_000_000u128, 719_202_573_490_000_000_000u128);
    let p = pricing::realized_payout(447_536_918, 429_611_768, 429_611_768, close, settle).unwrap();
    out.push(json!({
        "coveredValue": "447536918", "debt": "429611768", "cap": "429611768",
        "closeWad": close.to_string(), "settleWad": settle.to_string(), "gapBps": null, "payout": p.to_string(),
    }));
    out
}

#[test]
fn app_payout_golden_vectors() {
    let path = format!("{}/../../{FILE}", env!("CARGO_MANIFEST_DIR"));
    let v = json!({
        "about": "credence_core::pricing::realized_payout vectors for the app's TypeScript port (programs/credence-core/tests/golden_app.rs)",
        "vectors": vectors(),
    });
    if std::env::var("GOLDEN_WRITE").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
        return;
    }
    let committed: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("run with GOLDEN_WRITE=1 first")).unwrap();
    assert_eq!(committed, v, "{FILE} is out of date with realized_payout: regenerate with GOLDEN_WRITE=1");
}
