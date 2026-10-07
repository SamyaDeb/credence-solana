//! Property tests (Build Guide §14.1): monotonicity, conservation and no panic / overflow within the §9.1
//! bounds: loan amounts ≤ 1e18 base units, prices ≤ 1e24 WAD (a $1M token), WAD ratios ≤ 1e19.

use alloy_primitives::B256;
use credence_risk_core::fixed::{collateral_value, ltv_up, pack_i16, pack_u64};
use credence_risk_core::{
    blended_price, clear, cure_amounts, kinked_rate, liquidation_lot, loss_vector, pool_capacity,
    preclose_lot, quote_cover, safe_ltv, settle_position, PackedZ, PremiumParams, SliceZ,
    UncoveredMarket, U256, WAD,
};
use proptest::prelude::*;

const MAX_LOAN: u128 = 1_000_000_000_000_000_000; // 1e18 base units
const MAX_PRICE: u128 = 1_000_000_000_000_000_000_000_000; // 1e24
const MAX_QTY: u128 = 1_000_000_000_000_000_000_000_000_000; // 1e9 whole tokens at 18 dec

fn wad_frac(bps: u32) -> U256 {
    U256::from(bps) * WAD / U256::from(10_000u32)
}

fn sorted_set() -> impl Strategy<Value = Vec<i16>> {
    prop::collection::vec(any::<i16>(), 1..400).prop_map(|mut v| {
        v.sort();
        v
    })
}

fn premium_params(c: u128, d: u128, sigma_bps: u32, util_bps: u32) -> PremiumParams {
    PremiumParams {
        sigma: wad_frac(sigma_bps),
        dividend: U256::ZERO,
        kappa: wad_frac(300),
        collateral_value: U256::from(c),
        debt_projected: U256::from(d),
        closure_days: 3,
        util_after: wad_frac(util_bps),
        theta: WAD,
        cost_of_cap: wad_frac(1500),
        eta: U256::from(4u8) * WAD,
        beta: wad_frac(9750),
        min_premium: U256::from(500_000u32),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    /// A higher σ never raises the safe LTV.
    #[test]
    fn safe_ltv_monotone_in_sigma(z in any::<i16>(), s1 in 1u32..5000, ds in 0u32..5000, k in 0u32..2000,
                                  d in 0u32..500, max in 1u32..10_000) {
        let lo = safe_ltv(z.min(0), wad_frac(s1), wad_frac(d), wad_frac(k), wad_frac(max)).unwrap();
        let hi = safe_ltv(z.min(0), wad_frac(s1 + ds), wad_frac(d), wad_frac(k), wad_frac(max)).unwrap();
        prop_assert!(hi <= lo);
        prop_assert!(lo <= wad_frac(max));
    }

    /// A higher debt never lowers the premium; a higher utilisation never lowers it either.
    #[test]
    fn premium_monotone(set in sorted_set(), c in 1u128..MAX_LOAN, d1 in 0u128..MAX_LOAN, dd in 0u128..MAX_LOAN,
                        sigma in 1u32..3000, u in 0u32..10_000, du in 0u32..10_000) {
        let d2 = (d1 + dd).min(MAX_LOAN);
        let a = quote_cover(&SliceZ(&set), &premium_params(c, d1, sigma, u)).unwrap();
        let b = quote_cover(&SliceZ(&set), &premium_params(c, d2, sigma, u)).unwrap();
        prop_assert!(b.premium >= a.premium);
        prop_assert!(b.expected_loss >= a.expected_loss);
        let u2 = (u + du).min(10_000);
        let e = quote_cover(&SliceZ(&set), &premium_params(c, d1, sigma, u2)).unwrap();
        prop_assert!(e.premium >= a.premium);
        prop_assert!(a.premium >= U256::from(500_000u32));
        prop_assert!(a.expected_shortfall >= a.expected_loss);
    }

    /// Packed and in-memory sets give identical quotes.
    #[test]
    fn packed_equals_slice(set in sorted_set(), c in 1u128..MAX_LOAN, d in 0u128..MAX_LOAN, sigma in 1u32..3000) {
        let words = pack_i16(&set);
        let packed = PackedZ::new(&words, set.len() as u32).unwrap();
        let p = premium_params(c, d, sigma, 2500);
        prop_assert_eq!(quote_cover(&packed, &p).unwrap(), quote_cover(&SliceZ(&set), &p).unwrap());
    }

    /// Liquidation lot: never more than q; selling it at R restores HF ≥ H* for a partial lot.
    #[test]
    fn liquidation_lot_bounds(debt in 1u128..MAX_LOAN, q in 1u128..MAX_QTY, p in 1_000_000u128..MAX_PRICE,
                              lt_bps in 5000u32..9000, lam_bps in 0u32..500, kap_bps in 0u32..1000) {
        let (lt, lam, h) = (wad_frac(lt_bps), wad_frac(lam_bps), wad_frac(11_000));
        let price = U256::from(p);
        let r = price * (WAD - wad_frac(kap_bps)) / WAD;
        let x = liquidation_lot(U256::from(debt), U256::from(q), r, price, lt, h, lam, 18, 6).unwrap();
        prop_assert!(x <= U256::from(q));
        if x > U256::ZERO && x < U256::from(q) {
            // after selling x at R: D' = D − (1−λ)·x·R ; C' = (q − x)·P ; HF' = C'·LT/D' ≥ H* (relative 1e-6)
            let proceeds = collateral_value(x, r, 18, 6).unwrap() * (WAD - lam) / WAD;
            if proceeds < U256::from(debt) {
                let d_after = U256::from(debt) - proceeds;
                let c_after = collateral_value(U256::from(q) - x, price, 18, 6).unwrap();
                if d_after >= U256::from(1_000_000u32) {
                    let hf = c_after * lt / d_after;
                    prop_assert!(hf + h / U256::from(1_000_000u32) >= h, "hf {} below H*", hf);
                }
            }
        }
    }

    /// Pre-close lot never exceeds q, and is 0 when already at or below the target.
    #[test]
    fn preclose_lot_bounds(debt in 0u128..MAX_LOAN, q in 1u128..MAX_QTY, v in 1_000_000u128..MAX_PRICE,
                           target_bps in 1000u32..8000) {
        let price = U256::from(v);
        let r = price * U256::from(99u8) / U256::from(100u8);
        let target = wad_frac(target_bps);
        let x = preclose_lot(U256::from(debt), U256::from(q), price, r, target, wad_frac(100), 18, 6).unwrap();
        prop_assert!(x <= U256::from(q));
        let c = collateral_value(U256::from(q), price, 18, 6).unwrap();
        if ltv_up(U256::from(debt), c).unwrap() <= target && c > U256::ZERO {
            prop_assert!(x <= U256::from(1u8)); // at most rounding dust
        }
    }

    /// Settlement conserves proceeds: P = penalty + repaid + refund; shortfall only on a short full close.
    #[test]
    fn settlement_conserves(q in 1u128..MAX_QTY, xf in 0u32..=10_000, p in 1u128..MAX_PRICE, debt in 0u128..MAX_LOAN,
                            lam in 0u32..1000) {
        let x = U256::from(q) * U256::from(xf) / U256::from(10_000u32);
        let s = settle_position(x, U256::from(q), U256::from(p), U256::from(debt), wad_frac(lam), 18, 6).unwrap();
        prop_assert_eq!(s.proceeds, s.penalty + s.repaid + s.refund);
        prop_assert!(s.repaid <= U256::from(debt));
        prop_assert!(s.shortfall.is_zero() || (s.full_close && s.penalty.is_zero()));
        prop_assert_eq!(s.repaid + s.shortfall + s.debt_after, U256::from(debt));
    }

    /// Clearing: fills never exceed bids or the lot; everyone filled pays p* ≥ R; arrival order is irrelevant.
    #[test]
    fn clearing_uniform_and_order_free(bids in prop::collection::vec((1u128..1_000_000_000_000_000_000_000u128,
                                        1u128..1000u128, any::<[u8; 32]>()), 0..64),
                                       lot in 0u128..10_000_000_000_000_000_000_000u128, reserve in 1u128..1000u128) {
        let q: Vec<U256> = bids.iter().map(|b| U256::from(b.0)).collect();
        let p: Vec<U256> = bids.iter().map(|b| U256::from(b.1) * WAD).collect();
        let k: Vec<B256> = bids.iter().map(|b| B256::from(b.2)).collect();
        let r = U256::from(reserve) * WAD;
        let out = clear(&q, &p, &k, U256::from(lot), r).unwrap();
        let mut filled = U256::ZERO;
        for i in 0..q.len() {
            prop_assert!(out.fills[i] <= q[i]);
            if out.fills[i] > U256::ZERO {
                prop_assert!(p[i] >= out.p_star && p[i] >= r);
            }
            if p[i] < r { prop_assert!(out.fills[i].is_zero()); }
            filled += out.fills[i];
        }
        prop_assert_eq!(filled + out.q_pool, U256::from(lot));
        // reversed arrival order → same fills per bid
        let mut qr = q.clone(); qr.reverse();
        let mut pr = p.clone(); pr.reverse();
        let mut kr = k.clone(); kr.reverse();
        let rev = clear(&qr, &pr, &kr, U256::from(lot), r).unwrap();
        let mut fr = rev.fills.clone(); fr.reverse();
        prop_assert_eq!(fr, out.fills.clone());
        prop_assert_eq!(rev.p_star, out.p_star);
        let pbar = blended_price(U256::from(lot), out.p_star, out.q_pool, r).unwrap();
        if lot > 0 && out.q_pool < U256::from(lot) { prop_assert!(pbar >= r.min(out.p_star)); }
    }

    /// Capacity: adding a policy never lowers utilisation; uncovered bounds are never negative.
    #[test]
    fn capacity_monotone(joint in prop::collection::vec(any::<i16>(), 1..64), c in 1u128..MAX_LOAN,
                         d in 0u128..MAX_LOAN, sigma in 1u32..3000, equity in 1u128..MAX_LOAN) {
        let lv = loss_vector(&SliceZ(&joint), U256::from(c), U256::from(d), wad_frac(sigma), U256::ZERO, wad_frac(300)).unwrap();
        let k = joint.len() as u32;
        let zero = pack_u64(&vec![0u64; joint.len()]);
        let add = pack_u64(&lv);
        let unc = [UncoveredMarket { joint: &SliceZ(&joint), sigma: wad_frac(sigma), dividend: U256::ZERO,
                                     collateral_value: U256::from(c), safe_ltv: wad_frac(7000) }];
        let before = pool_capacity(&zero, &zero, k, &unc, wad_frac(300), U256::from(equity), wad_frac(5000)).unwrap();
        let after = pool_capacity(&zero, &add, k, &unc, wad_frac(300), U256::from(equity), wad_frac(5000)).unwrap();
        prop_assert!(after.util_after >= before.util_after);
        prop_assert!(after.worst_loss >= before.worst_loss);
        prop_assert!(after.worst_loss >= U256::from(*lv.iter().max().unwrap()));
    }

    /// No panic / overflow inside the §9.1 bounds for cures and rates.
    #[test]
    fn no_overflow_in_bounds(d in 0u128..MAX_LOAN, q in 0u128..MAX_QTY, v in 1u128..MAX_PRICE, ltv in 1u32..10_000,
                             u in 0u32..=10_000) {
        prop_assert!(cure_amounts(U256::from(d), U256::from(q), U256::from(v), wad_frac(ltv), 18, 6).is_ok());
        prop_assert!(kinked_rate(wad_frac(u), wad_frac(200), wad_frac(600), wad_frac(8000), wad_frac(9000)).is_ok());
    }
}
