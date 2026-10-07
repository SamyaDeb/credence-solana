//! `quote_cover_capped` and the u128 per-scenario fast path (added for Solana compute, Oct 8, 2026).

use credence_risk_core::fixed::{ceil_div, mul_div_up, mul_wad_up};
use credence_risk_core::premium::{scenario_loss, scenario_loss_u128, scenario_loss_u64, FastLoss};
use credence_risk_core::{quote_cover, quote_cover_capped, PremiumParams, SliceZ, U256, WAD};
use proptest::prelude::*;

fn wad_frac(bps: u32) -> U256 {
    U256::from(bps) * WAD / U256::from(10_000u32)
}

fn sorted_set() -> impl Strategy<Value = Vec<i16>> {
    prop::collection::vec(any::<i16>(), 1..400).prop_map(|mut v| {
        v.sort();
        v
    })
}

fn params(c: u128, d: u128, sigma_bps: u32, div_bps: u32, kappa_bps: u32, util_bps: u32) -> PremiumParams {
    PremiumParams {
        sigma: wad_frac(sigma_bps),
        dividend: wad_frac(div_bps),
        kappa: wad_frac(kappa_bps),
        collateral_value: U256::from(c),
        debt_projected: U256::from(d),
        closure_days: 3,
        util_after: wad_frac(util_bps),
        theta: wad_frac(2000),
        cost_of_cap: wad_frac(1000),
        eta: WAD,
        beta: wad_frac(9750),
        min_premium: U256::from(1_000_000u32),
    }
}

/// Brute force: every capped loss from the U256 `scenario_loss`, then F-4.3 restated.
fn reference(set: &[i16], p: &PremiumParams, cap: U256) -> U256 {
    let n = set.len();
    let losses: Vec<U256> = set.iter().map(|z| scenario_loss(*z, p).unwrap().min(cap)).collect();
    let m = mul_div_up(WAD - p.beta, U256::from(n), WAD).unwrap().max(U256::from(1u8)).min(U256::from(n)).to::<usize>();
    let el = ceil_div(losses.iter().fold(U256::ZERO, |a, b| a + b), U256::from(n)).unwrap();
    let es = ceil_div(losses[..m].iter().fold(U256::ZERO, |a, b| a + b), U256::from(m)).unwrap();
    let tau = mul_div_up(U256::from(p.closure_days), WAD, U256::from(365u16)).unwrap();
    let base = mul_wad_up(WAD + p.theta, el).unwrap() + mul_wad_up(mul_wad_up(p.cost_of_cap, tau).unwrap(), es).unwrap();
    let mult = WAD + mul_wad_up(p.eta, mul_wad_up(p.util_after, p.util_after).unwrap()).unwrap();
    mul_wad_up(mult, base).unwrap().max(p.min_premium)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    /// Whenever the u128 path returns a value it equals the U256 `scenario_loss` exactly.
    #[test]
    fn fast_loss_is_exact(z in any::<i16>(), c in 0u128..u64::MAX as u128, d in 0u128..u64::MAX as u128,
                          sigma in 0u32..10_000, div in 0u32..2_000, kappa in 0u32..=10_000) {
        let p = params(c, d, sigma, div, kappa, 0);
        let f = FastLoss::new(&p).unwrap();
        if let Some(l) = scenario_loss_u128(z, &f) {
            prop_assert_eq!(U256::from(l), scenario_loss(z, &p).unwrap());
        }
    }

    /// κ = 0, native u64 path: equal to the U256 `scenario_loss` whenever it returns, over the full u64 input range.
    #[test]
    fn u64_loss_is_exact(z in any::<i16>(), c in any::<u64>(), d in any::<u64>(), sigma in any::<u64>(), div in any::<u64>()) {
        let p = PremiumParams {
            sigma: U256::from(sigma), dividend: U256::from(div), kappa: U256::ZERO,
            collateral_value: U256::from(c), debt_projected: U256::from(d),
            ..params(0, 0, 0, 0, 0, 0)
        };
        let reference = scenario_loss(z, &p);
        if let Some(l) = scenario_loss_u64(z, sigma, div, c, d) {
            prop_assert_eq!(U256::from(l), reference.unwrap());
        }
    }

    /// The u64 path covers realistic inputs (C, D ≤ $10B in USDC base units, σ ≤ 50% per closure, d ≤ 20%) without
    /// falling back. (Beyond that an up-move can exceed u64; the path returns `None` and the U256 loop takes over.)
    #[test]
    fn u64_loss_covers_realistic_inputs(z in any::<i16>(), c in 0u64..10_000_000_000_000_000, d in 0u64..10_000_000_000_000_000,
                                        sigma in 0u64..=500_000_000_000_000_000, div in 0u64..200_000_000_000_000_000) {
        let l = scenario_loss_u64(z, sigma, div, c, d);
        prop_assert!(l.is_some());
        let p = PremiumParams {
            sigma: U256::from(sigma), dividend: U256::from(div), kappa: U256::ZERO,
            collateral_value: U256::from(c), debt_projected: U256::from(d),
            ..params(0, 0, 0, 0, 0, 0)
        };
        prop_assert_eq!(U256::from(l.unwrap()), scenario_loss(z, &p).unwrap());
    }

    /// Within realistic bounds (C, D ≤ 1e15 base units = $1B, σ ≤ 100%) the fast path never falls back.
    #[test]
    fn fast_loss_covers_realistic_inputs(z in any::<i16>(), c in 0u128..1_000_000_000_000_000, d in 0u128..1_000_000_000_000_000,
                                         sigma in 0u32..=10_000, div in 0u32..2_000) {
        let p = params(c, d, sigma, div, 0, 0);
        prop_assert!(scenario_loss_u128(z, &FastLoss::new(&p).unwrap()).is_some());
    }

    /// The capped quote equals the brute-force reference; uncapped equals `quote_cover`; a cap never raises it.
    #[test]
    fn capped_quote_matches_reference(set in sorted_set(), c in 1u128..1_000_000_000_000_000, d in 0u128..1_000_000_000_000_000,
                                      cap in 0u128..1_000_000_000_000_000, sigma in 1u32..3000, util in 0u32..10_000) {
        let p = params(c, d, sigma, 0, 0, util);
        let capped = quote_cover_capped(&SliceZ(&set), &p, U256::from(cap)).unwrap();
        prop_assert_eq!(capped.premium, reference(&set, &p, U256::from(cap)));
        let full = quote_cover(&SliceZ(&set), &p).unwrap();
        prop_assert_eq!(full.premium, reference(&set, &p, U256::MAX));
        prop_assert!(capped.premium <= full.premium);
    }
}
