//! Interest on a covered debt (Credence Solana, task 1.2): `accrued_debt` counts klend's interest on the snapshot debt
//! up to a cap and never below it; `priced_debt` is the cap itself, rounded up, so what cover reserves and prices is
//! never less than what the shield and settlement may use.

use credence_risk_core::{accrued_debt, priced_debt};
use proptest::prelude::*;

const W: u64 = 1_000_000_000_000_000_000;
const ONE_SF: u128 = 1 << 60;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(5_000))]

    #[test]
    fn accrued_between_snapshot_and_priced(d in 0u64..1_000_000_000_000_000, idx_buy in ONE_SF..ONE_SF * 4,
                                           grow_ppm in 0u64..50_000, cap_bps in 0u64..1_000) {
        let cap = W / 10_000 * cap_bps;
        let idx_now = idx_buy + idx_buy / 1_000_000 * grow_ppm as u128;
        let a = accrued_debt(d, idx_buy, idx_now, cap).unwrap();
        let p = priced_debt(d, cap).unwrap();
        prop_assert!(a >= d, "below the snapshot");
        prop_assert!(a <= p, "accrued {} above what was priced {}", a, p);
        // Exact below the cap: ⌊D × idx_now / idx_buy⌋.
        let exact = (d as u128 * idx_now / idx_buy) as u64;
        prop_assert_eq!(a, exact.min((d as u128 * (W + cap) as u128 / W as u128) as u64));
    }

    /// A falling index (it cannot fall in klend, but the input is not trusted) never shrinks the debt.
    #[test]
    fn never_below_the_snapshot(d in 0u64..1_000_000_000_000, idx_buy in ONE_SF..ONE_SF * 4, drop in 0u128..ONE_SF) {
        prop_assert_eq!(accrued_debt(d, idx_buy, idx_buy.saturating_sub(drop), W / 100).unwrap(), d);
    }
}

/// The twin: $50,000 for a weekend at about 12% a year (index +0.122%) accrues 61 USDC, inside a 0.5% cap.
#[test]
fn twin_weekend_numbers() {
    let d = 50_000_000_000u64;
    let idx_buy = 1_234_000_000_000_000_000_000u128; // a decimal index keeps the expected values exact
    let idx_now = idx_buy + idx_buy / 1_000_000 * 1_220;
    assert_eq!(accrued_debt(d, idx_buy, idx_now, W / 200).unwrap(), 50_061_000_000);
    assert_eq!(priced_debt(d, W / 200).unwrap(), 50_250_000_000);
    // A 3% jump is held at the cap.
    assert_eq!(accrued_debt(d, idx_buy, idx_buy + idx_buy / 100 * 3, W / 200).unwrap(), 50_250_000_000);
    assert!(accrued_debt(d, 0, 1, 0).is_err());
}
