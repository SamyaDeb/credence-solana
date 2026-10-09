//! Audit A-66: σ of a closure spanning several nights (a mid-week holiday typed OVERNIGHT) is the one-night σ × √n,
//! rounded UP: one night unchanged, never below the exact value, within one unit of it.
use credence_risk_core::premium::sigma_over_nights;
use credence_risk_core::{U256, WAD};
use proptest::prelude::*;

proptest! {
    #[test]
    fn sigma_scales_with_the_square_root_of_nights(sigma_bp in 1u64..5000, n in 1u16..30) {
        let sigma = U256::from(sigma_bp) * WAD / U256::from(10_000u64);
        let s = sigma_over_nights(sigma, n).unwrap();
        if n == 1 {
            prop_assert_eq!(s, sigma);
        }
        // s ≥ σ√n ⇔ s² ≥ σ² n, and (s − 1)² < σ² n.
        let target = sigma * sigma * U256::from(n);
        prop_assert!(s * s >= target);
        prop_assert!((s - U256::from(1u8)) * (s - U256::from(1u8)) < target);
    }
}
