//! risk-core::fluid against `@jup-ag/lend` 0.4.0 (keeper/src/gen-fluid-golden.ts → tests/fixtures/fluid_golden.json):
//! every tick ratio and position debt bit for bit; the ratio grows 0.15% a tick.
use credence_risk_core::fluid::{debt_raw, ratio_at_tick, raw_to_tokens, MAX_TICK, MIN_TICK};
use credence_risk_core::U256;

fn golden() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/fluid_golden.json")).unwrap()
}

#[test]
fn ratios_match_the_sdk() {
    let g = golden();
    let rs = g["ratios"].as_array().unwrap();
    assert!(rs.len() > 300);
    for r in rs {
        let t = r["tick"].as_i64().unwrap() as i32;
        let want: U256 = r["ratioX48"].as_str().unwrap().parse().unwrap();
        assert_eq!(ratio_at_tick(t).unwrap(), want, "tick {t}");
    }
}

#[test]
fn debts_match_the_sdk() {
    for d in golden()["debts"].as_array().unwrap() {
        let t = d["tick"].as_i64().unwrap() as i32;
        let col: u64 = d["colRaw"].as_str().unwrap().parse().unwrap();
        let want: u128 = d["debtRaw"].as_str().unwrap().parse().unwrap();
        assert_eq!(debt_raw(col, t).unwrap(), want, "tick {t} col {col}");
    }
}

#[test]
fn ratio_steps_by_fifteen_bps_and_bounds_hold() {
    for t in [-5000, -1, 0, 1, 4012, 9000] {
        let a = ratio_at_tick(t).unwrap();
        let b = ratio_at_tick(t + 1).unwrap();
        let step = (b - a) * U256::from(1_000_000u64) / a;
        assert!(step >= U256::from(1499u64) && step <= U256::from(1501u64), "tick {t}: {step}");
    }
    assert!(ratio_at_tick(MIN_TICK - 1).is_err() && ratio_at_tick(MAX_TICK + 1).is_err());
    assert_eq!(debt_raw(1_000, MIN_TICK).unwrap(), 0);
}

#[test]
fn raw_to_tokens_rounds_against_the_position() {
    // 1.5 raw units at exchange price 1e12, 6 decimals: 1,500,000,001 raw → 1,500,000 (down) / 1,500,001 (up).
    assert_eq!(raw_to_tokens(1_500_000_001, 1_000_000_000_000, 6, false).unwrap(), 1_500_000);
    assert_eq!(raw_to_tokens(1_500_000_001, 1_000_000_000_000, 6, true).unwrap(), 1_500_001);
    assert!(raw_to_tokens(1, 1, 10, false).is_err());
}
