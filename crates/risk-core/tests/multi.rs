//! Multi-collateral cover (W4): the payout rule reduces to the single-asset rule with one leg, is monotone in every
//! leg's gap and in the stablecoin collateral, never exceeds the cap; the joint premium is the F-4.3 formula over the
//! joint set padded with the closures it leaves out; the marginal debt reproduces the single-asset quote.
use credence_risk_core::{
    joint_loss, loss_multi, marginal_debt, premium::scenario_loss, quote_joint, JointPremiumParams, Leg, PremiumParams, U256, WAD,
};
use proptest::prelude::*;

const W: u64 = 1_000_000_000_000_000_000;
fn params(c: u64, d: u64) -> PremiumParams {
    PremiumParams {
        sigma: U256::from(W / 100), dividend: U256::ZERO, kappa: U256::ZERO, collateral_value: U256::from(c), debt_projected: U256::from(d),
        closure_days: 3, util_after: U256::ZERO, theta: U256::ZERO, cost_of_cap: U256::ZERO, eta: U256::ZERO, beta: U256::from(W / 2), min_premium: U256::ZERO,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4_000))]

    /// One leg, no stablecoins: exactly the single-asset loss (scenario_loss, capped).
    #[test]
    fn one_leg_is_the_single_asset_rule(c in 1u64..1_000_000_000_000, ratio in 5_000u64..11_000, z in -9_000i16..9_000, cap_bps in 1u64..10_001) {
        let d = c / 10_000 * ratio;
        let cap = (d / 10_000 * cap_bps).max(1);
        let single = scenario_loss(z, &params(c, d)).unwrap().min(U256::from(cap)).to::<u64>();
        let multi = joint_loss(d, cap, &[c], &[z], &[U256::from(W / 100)], &[U256::ZERO], 0).unwrap();
        prop_assert_eq!(single, multi);
    }

    /// A lower gap on any leg, or less stablecoin collateral, never lowers the loss; the loss never exceeds the cap.
    #[test]
    fn monotone_and_capped(c1 in 1u64..500_000_000_000, c2 in 1u64..500_000_000_000, s in 0u64..100_000_000_000, ratio in 5_000u64..12_000,
                           z1 in -9_000i16..9_000, z2 in -9_000i16..9_000, dz in 0i16..2_000, cap_bps in 1u64..10_001) {
        let d = ((c1 as u128 + c2 as u128 + s as u128) * ratio as u128 / 10_000) as u64;
        let cap = (d / 10_000 * cap_bps).max(1);
        let sig = [U256::from(W / 100), U256::from(W / 50)];
        let l = |z1: i16, z2: i16, s: u64| joint_loss(d, cap, &[c1, c2], &[z1, z2], &sig, &[U256::ZERO; 2], s).unwrap();
        let base = l(z1, z2, s);
        prop_assert!(base <= cap);
        prop_assert!(l(z1.saturating_sub(dz), z2, s) >= base);
        prop_assert!(l(z1, z2.saturating_sub(dz), s) >= base);
        prop_assert!(l(z1, z2, s / 2) >= base);
    }

    /// The marginal debt reproduces the multi-leg loss with only leg i moving (the others at g = 1).
    #[test]
    fn marginal_debt_is_the_leg_alone(c1 in 1u64..500_000_000_000, c2 in 1u64..500_000_000_000, s in 0u64..100_000_000_000, ratio in 5_000u64..12_000, z in -9_000i16..9_000) {
        let d = ((c1 as u128 + c2 as u128 + s as u128) * ratio as u128 / 10_000) as u64;
        let sig = U256::from(W / 100);
        let alone = joint_loss(d, d, &[c1, c2], &[z, 0], &[sig, sig], &[U256::ZERO; 2], s).unwrap();
        let md = marginal_debt(d, &[c1, c2], 0, s).unwrap();
        let single = scenario_loss(z, &params(c1, md)).unwrap().min(U256::from(d)).to::<u64>();
        prop_assert_eq!(alone, single);
    }
}

/// The joint premium: E over n_all closures, ES over the worst ⌈(1 − β) n_all⌉ of them, F-4.3 (θ, c, τ, m(u)).
#[test]
fn joint_premium_formula() {
    let losses = [1_000_000u64, 0, 3_000_000, 500_000];
    let p = JointPremiumParams {
        n_all: 564, closure_days: 3, util_after: U256::ZERO, theta: U256::from(W), cost_of_cap: U256::from(W / 10), eta: U256::from(W),
        beta: U256::from(W / 1000 * 975), min_premium: U256::ZERO,
    };
    let q = quote_joint(&losses, &p).unwrap();
    // E = ⌈4.5e6/564⌉ = 7,979; m = ⌈0.025 × 564⌉ = 15, ES = ⌈4.5e6/15⌉ = 300,000; τ = ⌈3/365 WAD⌉.
    let e = 7_979u128;
    let tau = (3u128 * WAD.to::<u128>()).div_ceil(365);
    let es_term = ((W as u128 / 10) * tau).div_ceil(W as u128) * 300_000u128;
    let expect = 2 * e + es_term.div_ceil(W as u128);
    assert_eq!(q, U256::from(expect));
    // The minimum premium floors it; a loss-free policy pays it.
    let floor = JointPremiumParams { min_premium: U256::from(5_000_000u64), ..p };
    assert_eq!(quote_joint(&[0; 256], &floor).unwrap(), U256::from(5_000_000u64));
    assert!(quote_joint(&[0; 600], &p).is_err());
    let _ = loss_multi(1, 1, &[Leg { covered: 1, g: U256::from(W) }], 0).unwrap();
}
