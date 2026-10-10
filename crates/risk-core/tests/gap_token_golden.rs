//! Golden vectors of `gap_token` for the SDK's display port (packages/sdk/test/gap.test.ts reads the same file).
//! `GEN_GAP_GOLDEN=1 cargo test -p credence-risk-core --test gap_token_golden` rewrites it; otherwise the test checks it.

use credence_risk_core::gap_token::{band_k, split};

const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/sdk/test/fixtures/gap-golden.json");

fn vectors() -> String {
    let sigmas: [u64; 8] = [0, 5_000_000_000_000_000, 20_000_000_000_000_000, 45_000_000_000_000_000, 80_000_000_000_000_000, 120_000_000_000_000_000, 400_000_000_000_000_000, u64::MAX];
    let bands: Vec<String> = sigmas.iter().map(|s| format!("[\"{s}\",\"{}\"]", band_k(*s))).collect();
    let mut splits = vec![];
    for k in [20_000_000_000_000_000u128, 85_000_000_000_000_000, 100_000_000_000_000_000, 300_000_000_000_000_000] {
        for r in [-1_000_000_000_000_000_000i128, -150_000_000_000_000_000, -80_000_000_000_000_000, -1, 0, 1, 12_345_678_901_234_567, 80_000_000_000_000_000, 99_999_999_999_999_999, 300_000_000_000_000_000, 1_000_000_000_000_000_000] {
            let (d, u) = split(r, k).unwrap();
            splits.push(format!("[\"{r}\",\"{k}\",{d},{u}]"));
        }
    }
    format!("{{\"band\":[{}],\"split\":[{}]}}\n", bands.join(","), splits.join(","))
}

#[test]
fn sdk_golden_vectors_match_the_rust() {
    let v = vectors();
    if std::env::var("GEN_GAP_GOLDEN").is_ok() {
        std::fs::write(FILE, &v).unwrap();
    }
    assert_eq!(std::fs::read_to_string(FILE).unwrap(), v, "regenerate with GEN_GAP_GOLDEN=1");
}
