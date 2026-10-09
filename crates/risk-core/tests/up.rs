//! risk-core::up (B3, side UP): the loss rule mirrors DOWN, rounds against the vault, is monotone in z, and the
//! premium equals a full-scan U256 reference and grows with the debt.
use credence_risk_core::premium::PremiumParams;
use credence_risk_core::scenarios::SliceZ;
use credence_risk_core::safe_ltv::gap_factor;
use credence_risk_core::up::{gap_factor_up, loss_up, quote_cover_up, scenario_loss_up, UpFactor};
use credence_risk_core::{U256, WAD};
use proptest::prelude::*;

fn params(d: u64, c: u64, sigma_bp: u64) -> PremiumParams {
    PremiumParams {
        sigma: U256::from(sigma_bp) * WAD / U256::from(10_000u64),
        dividend: U256::ZERO,
        kappa: U256::ZERO,
        collateral_value: U256::from(c),
        debt_projected: U256::from(d),
        closure_days: 3,
        util_after: U256::ZERO,
        theta: WAD,
        cost_of_cap: WAD / U256::from(10u8),
        eta: WAD,
        beta: WAD * U256::from(975u16) / U256::from(1000u16),
        min_premium: U256::from(5_000_000u64),
    }
}

fn set() -> Vec<i16> {
    (-3000..=3000).step_by(2).map(|x| x as i16).collect()
}

#[test]
fn rule_and_rounding() {
    // D 100,000, C′ 105,000: a +6% gap owes 1,000; +5% nothing; capped at 400.
    let w = WAD;
    let g = |pct: u64| w + w * U256::from(pct) / U256::from(100u8);
    assert_eq!(loss_up(U256::from(100_000u64), U256::from(105_000u64), U256::MAX, g(6)).unwrap(), U256::from(1_000u64));
    assert_eq!(loss_up(U256::from(100_000u64), U256::from(105_000u64), U256::MAX, g(5)).unwrap(), U256::ZERO);
    assert_eq!(loss_up(U256::from(100_000u64), U256::from(105_000u64), U256::from(400u64), g(6)).unwrap(), U256::from(400u64));
    // g rounds up: σ = 1/3 % per thousandth-z unit is not exact.
    let s = WAD / U256::from(300u16);
    assert!(gap_factor_up(1, s, U256::ZERO).unwrap() > WAD);
    assert_eq!(gap_factor_up(0, s, U256::ZERO).unwrap(), WAD);
}

#[test]
fn premium_matches_a_full_scan_reference() {
    let z = set();
    let p = params(1_000_000_000_000, 1_030_000_000_000, 100); // D/C′ 0.97, σ 1%
    let cap = U256::from(200_000_000_000u64);
    let q = quote_cover_up(&SliceZ(&z), &p, cap).unwrap();
    let losses: Vec<U256> = z.iter().map(|x| scenario_loss_up(*x, &p, cap).unwrap()).collect();
    let n = U256::from(z.len());
    let total: U256 = losses.iter().fold(U256::ZERO, |a, b| a + *b);
    let e = (total + n - U256::from(1u8)) / n;
    assert_eq!(q.expected_loss, e);
    let mut sorted = losses.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    let m = ((U256::from(25u8) * n).div_ceil(U256::from(1000u16))).max(U256::from(1u8)).to::<usize>();
    let worst: U256 = sorted.iter().take(m).fold(U256::ZERO, |a, b| a + *b);
    assert_eq!(q.expected_shortfall, worst.div_ceil(U256::from(m)));
    assert!(q.premium >= p.min_premium);
}

proptest! {
    #[test]
    fn monotone_in_z_and_in_debt(zz in -3000i16..3000, d in 1u64..1_000_000_000_000, c in 1u64..1_000_000_000_000, sbp in 10u64..500) {
        let p = params(d, c, sbp);
        let l0 = scenario_loss_up(zz, &p, U256::MAX).unwrap();
        let l1 = scenario_loss_up(zz.saturating_add(1), &p, U256::MAX).unwrap();
        prop_assert!(l1 >= l0);
        let p2 = params(d.saturating_add(1_000), c, sbp);
        prop_assert!(scenario_loss_up(zz, &p2, U256::MAX).unwrap() >= l0);
    }

    #[test]
    fn premium_grows_with_the_debt(d in 500_000_000_000u64..1_000_000_000_000, sbp in 50u64..300) {
        let z = set();
        let c = 1_000_000_000_000u64;
        let a = quote_cover_up(&SliceZ(&z), &params(d, c, sbp), U256::MAX).unwrap();
        let b = quote_cover_up(&SliceZ(&z), &params(d + 10_000_000_000, c, sbp), U256::MAX).unwrap();
        prop_assert!(b.premium >= a.premium);
    }
}

proptest! {
    /// A-64: the up factor recovered from a stored DOWN gap factor (WAD floor, Q64 floor) is never below the true
    /// `1 + σz/1000` and at most a few hundred Q64 units (≈1e-17) above it, for any dividend and κ < 1.
    #[test]
    fn up_factor_inverts_the_down_gap_factor(z in -3000i16..=3000, sigma_bp in 1u64..3000, d_bp in 0u64..1000, k_bp in 0u64..5000) {
        let w = WAD.to::<u128>();
        let (sigma, d, k) = (sigma_bp as u128 * w / 10_000, d_bp as u128 * w / 10_000, k_bp as u128 * w / 10_000);
        let g = gap_factor(z, U256::from(sigma), U256::from(d), U256::from(k)).unwrap();
        let q: U256 = U256::from(1u8) << 64usize;
        let g_q64: u128 = ((g * q) / WAD).to::<u128>();
        let f = UpFactor::new(d, k).unwrap().apply(g_q64).unwrap();
        // The truth, exactly: (1000 WAD + σ z) / (1000 WAD), in Q64 (rounded up).
        let num = U256::from(1000u16) * WAD;
        let mv = U256::from(sigma) * U256::from(z.unsigned_abs());
        let truth = if z >= 0 { num + mv } else { num.saturating_sub(mv) };
        let truth_q = ((truth * q).div_ceil(num)).to::<u128>();
        prop_assert!(f >= truth_q, "f {f} < truth {truth_q}");
        let clamped = truth * WAD < U256::from(d) * num; // 1 + r < d: the DOWN factor was 0
        if !clamped {
            prop_assert!(f - truth_q <= 400, "f {f} too far above truth {truth_q}");
        }
    }
}
