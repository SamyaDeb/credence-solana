//! Liquidation Shield loading (W1, added Oct 8, 2026): the fast early-exit path equals a full U256 reference over
//! every scenario, and the loading has the bounds and monotonicity the pricing relies on.

use credence_risk_core::fixed::{ceil_div, mul_wad_up};
use credence_risk_core::premium::scenario_loss;
use credence_risk_core::{
    gap_factor, reserve_shift, reserved_loss, shield_loading, PremiumParams, ShieldLoadingParams, ShieldReserveParams, SliceZ,
    U256, WAD,
};
use proptest::prelude::*;

const W: u64 = 1_000_000_000_000_000_000;
fn frac(bps: u64) -> u64 {
    W / 10_000 * bps
}

fn sorted_set() -> impl Strategy<Value = Vec<i16>> {
    prop::collection::vec(-12_000i16..12_000, 1..900).prop_map(|mut v| {
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

/// The points the loading reads, with their weights: all of a small set, else the lowest bucket in full and one
/// midpoint per other bucket weighted by its size (audit A-24).
fn sample(set: &[i16]) -> Vec<(i16, u64)> {
    let (n, m) = (set.len() as u64, 256u64);
    if n <= m {
        return set.iter().map(|z| (*z, 1)).collect();
    }
    let mut out: Vec<(i16, u64)> = set[..(n / m) as usize].iter().map(|z| (*z, 1)).collect();
    for j in 1..m {
        out.push((set[((2 * j + 1) * n / (2 * m)) as usize], (j + 1) * n / m - j * n / m));
    }
    out
}

/// Every sampled point, every node, U256 throughout, no early exit.
fn reference(set: &[i16], p: &ShieldLoadingParams) -> (u64, u64) {
    let n = set.len() as u64;
    let set = &sample(set)[..];
    let alpha_cap = (U256::from(p.cap) * U256::from(p.alpha) / WAD).to::<u64>().min(p.advance_cap);
    let c2 = (U256::from(p.covered) * (WAD - U256::from(p.buffer)) / (WAD + U256::from(p.health))).to::<u64>();
    let num = U256::from(1_732_050_808u64) * U256::from(p.basis_sigma) * U256::from(1000u16);
    let d = ceil_div(num, U256::from(p.sigma) * U256::from(1_000_000_000u64)).unwrap().min(U256::from(65_536u32)).to::<i32>();
    let sh = |z: i16, s: i32| (z as i32 + s).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
    let mut sum6 = 0u128;
    for &(z, wgt) in set {
        let pay = loss_at(z, p.sigma, p.covered, p.debt).min(p.cap);
        let adv = |zz: i16| loss_at(zz, p.sigma, c2, p.debt).min(p.cap).min(alpha_cap);
        let l = |a: u64| a.saturating_sub(pay) as u128;
        sum6 += (l(adv(sh(z, -d))) + 4 * l(adv(z)) + l(adv(sh(z, d)))) * wgt as u128;
    }
    let e = ceil_div(U256::from(sum6), U256::from(6 * n)).unwrap();
    (e.to::<u64>(), mul_wad_up(U256::from(p.lambda), e).unwrap().to::<u64>())
}

prop_compose! {
    fn params()(c in 1_000_000u64..1_000_000_000_000, ratio_bps in 5_000u64..11_000, cap_bps in 0u64..10_001,
                sigma_bps in 10u64..600, basis_bps in 0u64..400, alpha_bps in 0u64..10_001, b_bps in 0u64..1_000,
                h_bps in 0u64..1_000, lambda_bps in 0u64..40_000, adv_cap_bps in 0u64..12_000) -> ShieldLoadingParams {
        let debt = c / 10_000 * ratio_bps;
        ShieldLoadingParams {
            sigma: frac(sigma_bps), basis_sigma: frac(basis_bps), covered: c, debt, cap: debt / 10_000 * cap_bps,
            alpha: frac(alpha_bps), buffer: frac(b_bps), health: frac(h_bps), lambda: frac(lambda_bps),
            // Above 10,000 bps: no cap (the common case); below, a reservation that binds.
            advance_cap: if adv_cap_bps >= 10_000 { u64::MAX } else { debt / 10_000 * adv_cap_bps },
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
        alpha: 0, buffer: frac(200), health: frac(200), lambda: 2 * W, advance_cap: u64::MAX,
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
        sigma: frac(94), basis_sigma: 0, covered: 1_000, debt: 900, cap: 900, alpha: W / 2, buffer: 0, health: 0, lambda: W, advance_cap: u64::MAX,
    };
    assert!(shield_loading(&SliceZ(&[] as &[i16]), &p).is_err());
    assert!(shield_loading(&SliceZ(&set), &ShieldLoadingParams { alpha: W + 1, ..p }).is_err());
    assert!(shield_loading(&SliceZ(&set), &ShieldLoadingParams { buffer: W, ..p }).is_err());
    assert!(shield_loading(&SliceZ(&set), &ShieldLoadingParams { sigma: 0, ..p }).is_err());
}

/// The 256-point sample against the full 3,000-point set on the real calibrated sets, for the near-threshold positions
/// the loading matters for: printed for plan/09; the sample stays within 10% (or 2 USDC) of the full pass.
#[test]
fn sampled_loading_tracks_the_full_set_on_real_data() {
    let root = format!("{}/../..", env!("CARGO_MANIFEST_DIR"));
    let assets: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{root}/data/onchain/assets.json")).unwrap()).unwrap();
    for (i, t) in ["SPYx", "QQQx", "NVDAx"].iter().enumerate() {
        let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{root}/data/onchain/{t}-WEEKEND.json")).unwrap()).unwrap();
        let set: Vec<i16> = f["z"].as_array().unwrap().iter().map(|x| x.as_i64().unwrap() as i16).collect();
        let sigma: u64 = assets[i]["sigmaWad"].as_str().unwrap().parse().unwrap();
        for ratio_bps in [9_000u64, 9_600, 9_900, 9_950] {
            for basis_bps in [0u64, 30, 100] {
                let c = 100_000_000_000u64;
                let d = c / 10_000 * ratio_bps;
                let p = ShieldLoadingParams { sigma, basis_sigma: frac(basis_bps), covered: c, debt: d, cap: d, alpha: W / 2, buffer: frac(200), health: 0, lambda: W, advance_cap: u64::MAX };
                let fast = shield_loading(&SliceZ(&set), &p).unwrap().expected_loss;
                // Full pass: the reference without sampling.
                let full = {
                    let alpha_cap = d / 2;
                    let c2 = (U256::from(c) * (WAD - U256::from(p.buffer)) / WAD).to::<u64>();
                    let dz = ceil_div(U256::from(1_732_050_808u64) * U256::from(p.basis_sigma) * U256::from(1000u16), U256::from(sigma) * U256::from(1_000_000_000u64)).unwrap().to::<i32>();
                    let sh = |z: i16, s: i32| (z as i32 + s).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                    let mut sum6 = 0u128;
                    for &z in &set {
                        let pay = loss_at(z, sigma, c, d).min(d);
                        let adv = |zz: i16| loss_at(zz, sigma, c2, d).min(d).min(alpha_cap);
                        let l = |a: u64| a.saturating_sub(pay) as u128;
                        sum6 += l(adv(sh(z, -dz))) + 4 * l(adv(z)) + l(adv(sh(z, dz)));
                    }
                    (sum6 as f64) / (6.0 * set.len() as f64)
                };
                println!("{t} D/C′ {:.3} σ_b {:.2}%: E sampled {:.2} USDC, full {:.2} USDC (C′ 100k)", ratio_bps as f64 / 1e4, basis_bps as f64 / 100.0, fast as f64 / 1e6, full / 1e6);
                assert!((fast as f64 - full).abs() <= (0.10 * full).max(2_000_000.0), "{t} {ratio_bps} {basis_bps}: {fast} vs {full}");
            }
        }
    }
}

/// Audit A-24: with more than 256 points the loading sampled midpoint quantiles only, so the most extreme scenarios (the
/// lowest n/512) were never read and a loss that lives only there priced as 0. The lowest bucket is now read in full.
#[test]
fn a24_extreme_tail_is_read() {
    // σ 1%: the lowest point is a −4% open, every other one +3%. D/C′ 0.95: at −4% the payout rule owes 0 but the
    // advance at the buffered fair value is 95 − 98 × 0.96 = 0.92% of C′; at +3% neither pays.
    let mut set = vec![-4_000i16];
    set.extend(std::iter::repeat(3_000i16).take(2_999));
    let p = ShieldLoadingParams {
        sigma: frac(100), basis_sigma: 0, covered: 100_000_000_000, debt: 95_000_000_000, cap: 95_000_000_000,
        alpha: W / 2, buffer: frac(200), health: 0, lambda: W, advance_cap: u64::MAX,
    };
    let r = shield_loading(&SliceZ(&set), &p).unwrap();
    // Exact: 920,000,000 / 3,000 ≈ 306,667 base units.
    assert!(r.expected_loss >= 306_666 && r.expected_loss <= 306_668, "the one overshooting scenario must count: {}", r.expected_loss);
}

/// The advance the program makes is capped at the policy's reservation (INV-12), so the loading never prices more.
#[test]
fn advance_cap_bounds_the_loading() {
    let set: Vec<i16> = (-6000..3000).step_by(3).collect();
    let p = ShieldLoadingParams {
        sigma: frac(94), basis_sigma: frac(34), covered: 52_083_333_333, debt: 50_000_000_000, cap: 50_000_000_000,
        alpha: W / 2, buffer: frac(200), health: 0, lambda: 2 * W, advance_cap: u64::MAX,
    };
    let free = shield_loading(&SliceZ(&set), &p).unwrap().expected_loss;
    let capped = shield_loading(&SliceZ(&set), &ShieldLoadingParams { advance_cap: 2_000_000_000, ..p }).unwrap().expected_loss;
    let none = shield_loading(&SliceZ(&set), &ShieldLoadingParams { advance_cap: 0, ..p }).unwrap().expected_loss;
    assert!(free > 0 && capped <= free && none == 0, "free {free} capped {capped} none {none}");
}

fn reserve_settle(z: i16, sigma: u64, c: u64, d: u64, cap: u64) -> u64 {
    loss_at(z, sigma, c, d).min(cap)
}

prop_compose! {
    fn reserve_case()(c in 1_000_000u64..1_000_000_000_000, ratio_bps in 5_000u64..11_000, cap_bps in 1u64..10_001,
                      sigma_bps in 10u64..600, z in -12_000i16..12_000, alpha_bps in 0u64..10_001, b_bps in 0u64..1_000,
                      h_bps in 0u64..1_000, shift_bps in 0u64..600)
                      -> (i16, u64, u64, u64, u64, ShieldReserveParams) {
        let d = c / 10_000 * ratio_bps;
        (z, frac(sigma_bps), c, d, (d / 10_000 * cap_bps).max(1),
         ShieldReserveParams { alpha: frac(alpha_bps), buffer: frac(b_bps), health: frac(h_bps), shift: frac(shift_bps) })
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(5_000))]

    /// Task 1.2. The reservation is the settlement loss with the shield off, never below it with the shield on, never
    /// above the cap, and never below the advance at the shifted fair value (independent float check: at most 2 units below, from float
    /// error, and 3 above, from the two floors that round the reservation UP).
    #[test]
    fn reserved_loss_bounds((z, sigma, c, d, cap, r) in reserve_case()) {
        let settle = reserve_settle(z, sigma, c, d, cap);
        prop_assert_eq!(reserved_loss(z, sigma, 0, c, d, cap, &ShieldReserveParams { alpha: 0, ..r }).unwrap(), settle);
        let got = reserved_loss(z, sigma, 0, c, d, cap, &r).unwrap();
        prop_assert!(got >= settle && got <= cap);
        let g = gap_factor(z, U256::from(sigma), U256::ZERO, U256::ZERO).unwrap().to::<u128>() as f64 / 1e18;
        let c2 = c as f64 * (1.0 - r.buffer as f64 / 1e18) / (1.0 + r.health as f64 / 1e18);
        let adv = (d as f64 - c2 * (g - r.shift as f64 / 1e18).max(0.0)).max(0.0).min(cap as f64).min(cap as f64 * r.alpha as f64 / 1e18);
        prop_assert!(got as f64 + 2.0 >= adv.max(settle as f64), "got {} adv {} settle {}", got, adv, settle);
        prop_assert!(got as f64 <= adv.max(settle as f64) + 3.0, "got {} adv {} settle {}", got, adv, settle);
    }

    /// A larger shift, α, buffer or health target never lowers the reservation; a higher z never raises it.
    #[test]
    fn reserved_loss_monotone((z, sigma, c, d, cap, r) in reserve_case(), dk in 0u64..200, da in 0u64..2_000, dz in 0i16..500) {
        let base = reserved_loss(z, sigma, 0, c, d, cap, &r).unwrap();
        let at = |q: ShieldReserveParams| reserved_loss(z, sigma, 0, c, d, cap, &q).unwrap();
        let shift = at(ShieldReserveParams { shift: r.shift + frac(dk), ..r });
        let alpha = at(ShieldReserveParams { alpha: (r.alpha + frac(da)).min(W), ..r });
        let buffer = at(ShieldReserveParams { buffer: r.buffer + frac(dk), ..r });
        let health = at(ShieldReserveParams { health: r.health + frac(dk), ..r });
        prop_assert!(shift >= base && alpha >= base && buffer >= base && health >= base);
        let up = z.saturating_add(dz);
        prop_assert!(reserved_loss(up, sigma, 0, c, d, cap, &r).unwrap() <= base);
    }
}

/// The demo position (SPYx, $50k at D/C′ 0.96, α 50%, b 2%, k = 2, σ_b 0.339%) at a −8.65% joint scenario: the
/// settlement loss is the old reservation (≈ 2,424 USDC, which capped A's advance in the A-32 twin run); the shield's
/// own advance there is ≈ 3,719 USDC, so the reservation now covers the full −8% advance (≈ 3,042).
#[test]
fn reserved_loss_demo_numbers() {
    let (c, d) = (52_083_333_333u64, 50_000_000_000u64);
    let sigma = frac(100); // 1%: z = −8,650 is a −8.65% gap
    let r = ShieldReserveParams { alpha: W / 2, buffer: frac(200), health: 0, shift: reserve_shift(2 * W, 3_390_000_000_000_000).unwrap() };
    assert_eq!(r.shift, 6_780_000_000_000_000);
    let settle = reserve_settle(-8_650, sigma, c, d, d);
    let got = reserved_loss(-8_650, sigma, 0, c, d, d, &r).unwrap();
    let exact = d as f64 - c as f64 * 0.98 * (1.0 - 0.0865 - 0.00678);
    assert!((settle as f64 - (d as f64 - c as f64 * 0.9135)).abs() <= 1.0, "settle {settle}");
    assert!((got as f64 - exact).abs() <= 2.0, "got {got} exact {exact}");
    assert!(got > 3_041_670_000);
}
