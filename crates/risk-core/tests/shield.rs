//! Liquidation Shield loading (W1, added Oct 8, 2026): the fast early-exit path equals a full U256 reference over
//! every scenario, and the loading has the bounds and monotonicity the pricing relies on.

use credence_risk_core::fixed::{ceil_div, mul_wad_up};
use credence_risk_core::premium::scenario_loss;
use credence_risk_core::{shield_loading, PremiumParams, ShieldLoadingParams, SliceZ, U256, WAD};
use proptest::prelude::*;

const W: u64 = 1_000_000_000_000_000_000;
fn frac(bps: u64) -> u64 {
    W / 10_000 * bps
}

fn sorted_set() -> impl Strategy<Value = Vec<i16>> {
    prop::collection::vec(-12_000i16..12_000, 1..300).prop_map(|mut v| {
        v.sort();
        v
    })
}

fn loss_at(z: i16, sigma: u64, c: u64, d: u64) -> u64 {
    let p = PremiumParams {
        sigma: U256::from(sigma),
        dividend: U256::ZERO,
        kappa: U256::ZERO,
        collateral_value: U256::from(c),
        debt_projected: U256::from(d),
        closure_days: 3,
        util_after: U256::ZERO,
        theta: U256::ZERO,
        cost_of_cap: U256::ZERO,
        eta: U256::ZERO,
        beta: U256::ZERO,
        min_premium: U256::ZERO,
    };
    scenario_loss(z, &p).unwrap().to::<u64>()
}

/// Every scenario, every node, U256 throughout, no early exit.
fn reference(set: &[i16], p: &ShieldLoadingParams) -> (u64, u64) {
    let alpha_cap = (U256::from(p.cap) * U256::from(p.alpha) / WAD).to::<u64>();
    let c2 = (U256::from(p.covered) * (WAD - U256::from(p.buffer)) / (WAD + U256::from(p.health))).to::<u64>();
    let num = U256::from(1_732_050_808u64) * U256::from(p.basis_sigma) * U256::from(1000u16);
    let d = ceil_div(num, U256::from(p.sigma) * U256::from(1_000_000_000u64)).unwrap().min(U256::from(65_536u32)).to::<i32>();
    let sh = |z: i16, s: i32| (z as i32 + s).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
    let mut sum6 = 0u128;
    for &z in set {
        let pay = loss_at(z, p.sigma, p.covered, p.debt).min(p.cap);
        let adv = |zz: i16| loss_at(zz, p.sigma, c2, p.debt).min(p.cap).min(alpha_cap);
        let l = |a: u64| a.saturating_sub(pay) as u128;
        sum6 += l(adv(sh(z, -d))) + 4 * l(adv(z)) + l(adv(sh(z, d)));
    }
    let e = ceil_div(U256::from(sum6), U256::from(6 * set.len() as u64)).unwrap();
    (e.to::<u64>(), mul_wad_up(U256::from(p.lambda), e).unwrap().to::<u64>())
}

prop_compose! {
    fn params()(c in 1_000_000u64..1_000_000_000_000, ratio_bps in 5_000u64..11_000, cap_bps in 0u64..10_001,
                sigma_bps in 10u64..600, basis_bps in 0u64..400, alpha_bps in 0u64..10_001, b_bps in 0u64..1_000,
                h_bps in 0u64..1_000, lambda_bps in 0u64..40_000) -> ShieldLoadingParams {
        let debt = c / 10_000 * ratio_bps;
        ShieldLoadingParams {
            sigma: frac(sigma_bps), basis_sigma: frac(basis_bps), covered: c, debt, cap: debt / 10_000 * cap_bps,
            alpha: frac(alpha_bps), buffer: frac(b_bps), health: frac(h_bps), lambda: frac(lambda_bps),
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2_000))]

    /// The early exit and the u64 path change nothing: equal to the full U256 sum over every scenario.
    #[test]
    fn fast_path_equals_full_reference(set in sorted_set(), p in params()) {
        let r = shield_loading(&SliceZ(&set), &p).unwrap();
        let (e, l) = reference(&set, &p);
        prop_assert_eq!(r.expected_loss, e);
        prop_assert_eq!(r.loading, l);
        prop_assert!(r.visited as usize <= set.len());
    }

    /// 0 ≤ E ≤ α·cap (the advance itself is at most α·cap; INV-9 at the pricing level).
    #[test]
    fn bounded_by_alpha_cap(set in sorted_set(), p in params()) {
        let r = shield_loading(&SliceZ(&set), &p).unwrap();
        let alpha_cap = (U256::from(p.cap) * U256::from(p.alpha) / WAD).to::<u64>();
        prop_assert!(r.expected_loss <= alpha_cap);
    }

    /// A larger α, buffer or health target never lowers the expected loss (each makes every advance larger).
    #[test]
    fn monotone_in_alpha_buffer_health(set in sorted_set(), p in params(), da in 0u64..2_000, db in 0u64..500, dh in 0u64..500) {
        let base = shield_loading(&SliceZ(&set), &p).unwrap().expected_loss;
        let more = |q: ShieldLoadingParams| shield_loading(&SliceZ(&set), &q).unwrap().expected_loss;
        let a = more(ShieldLoadingParams { alpha: (p.alpha + frac(da)).min(W), ..p });
        let b = more(ShieldLoadingParams { buffer: p.buffer + frac(db), ..p });
        let h = more(ShieldLoadingParams { health: p.health + frac(dh), ..p });
        prop_assert!(a >= base && b >= base && h >= base, "base {} alpha {} buffer {} health {}", base, a, b, h);
    }

    /// With a perfect fair value (σ_b = 0), no buffer and no health margin, the advance never exceeds the payout.
    #[test]
    fn zero_without_basis_buffer_or_margin(set in sorted_set(), p in params()) {
        let q = ShieldLoadingParams { basis_sigma: 0, buffer: 0, health: 0, ..p };
        prop_assert_eq!(shield_loading(&SliceZ(&set), &q).unwrap().expected_loss, 0);
    }
}

#[test]
fn zero_alpha_or_far_from_threshold_costs_nothing() {
    let set: Vec<i16> = (-3000..3000).step_by(2).collect();
    let p = ShieldLoadingParams {
        sigma: frac(94), basis_sigma: frac(50), covered: 52_083_333_333, debt: 50_000_000_000, cap: 50_000_000_000,
        alpha: 0, buffer: frac(200), health: frac(200), lambda: 2 * W,
    };
    assert_eq!(shield_loading(&SliceZ(&set), &p).unwrap().expected_loss, 0);
    // D/C′ 0.5: the advance needs a −49% fair move, beyond every point: no scenario is read past the first.
    let far = ShieldLoadingParams { alpha: W / 2, debt: 26_041_666_666, cap: 26_041_666_666, ..p };
    let r = shield_loading(&SliceZ(&set), &far).unwrap();
    assert_eq!((r.expected_loss, r.visited), (0, 0));
}

#[test]
fn rejects_bad_inputs() {
    let set = [-100i16, 0, 100];
    let p = ShieldLoadingParams {
        sigma: frac(94), basis_sigma: 0, covered: 1_000, debt: 900, cap: 900, alpha: W / 2, buffer: 0, health: 0, lambda: W,
    };
    assert!(shield_loading(&SliceZ(&[] as &[i16]), &p).is_err());
    assert!(shield_loading(&SliceZ(&set), &ShieldLoadingParams { alpha: W + 1, ..p }).is_err());
    assert!(shield_loading(&SliceZ(&set), &ShieldLoadingParams { buffer: W, ..p }).is_err());
    assert!(shield_loading(&SliceZ(&set), &ShieldLoadingParams { sigma: 0, ..p }).is_err());
}
