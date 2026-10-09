//! Curator book cover (C2): `book_premium` is never above the legs' standalone premiums (one floor instead of one per
//! leg), never below its riskiest leg, monotone in every leg, invariant to leg order; a one-leg book is exactly the
//! single policy's F-4.3 premium; refund shares never add up to more than the premium.
use credence_risk_core::{
    book::{add_leg, standalone_unfloored},
    book_premium, book_premium_from_sums, leg_share, leg_weight, quote_cover_capped, BookLeg, BookParams, BookSums, PremiumParams,
    SliceZ, U256,
};
use proptest::prelude::*;

const W: u64 = 1_000_000_000_000_000_000;
const K: usize = 16;

fn params(min_premium: u64) -> BookParams {
    BookParams {
        n_all: 564,
        closure_days: 3,
        theta: U256::from(W),
        cost_of_cap: U256::from(W / 10),
        eta: U256::from(W),
        beta: U256::from(W / 1000 * 975),
        min_premium: U256::from(min_premium),
    }
}

fn leg() -> impl Strategy<Value = BookLeg> {
    (0u64..50_000_000_000, 0u64..5_000_000_000, 0u64..2_000_000_000, prop::collection::vec(0u64..100_000_000_000, K))
        .prop_map(|(e, es_extra, loading, losses)| BookLeg { e, es: e + es_extra, loading, losses })
}

fn standalone(l: &BookLeg, u: U256, p: &BookParams) -> U256 {
    let unf = standalone_unfloored(l.e, l.es, l.loading, u, p).unwrap();
    // The floor applies to the base, the loading on top (as buy_cover: premium + loading).
    let base = unf - U256::from(l.loading);
    base.max(p.min_premium) + U256::from(l.loading)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2_000))]

    /// π_B ≤ max(min_premium, Σ unfloored bases) + Σ loading ≤ Σ standalone premiums (floors included), and π_B is at
    /// least every leg's own standalone premium (a one-leg book is no cheaper than a single policy).
    #[test]
    fn book_between_riskiest_leg_and_sum_of_standalone(legs in prop::collection::vec(leg(), 1..12), u_bps in 0u64..10_000, min in 0u64..10_000_000) {
        let p = params(min);
        let u = U256::from(W / 10_000 * u_bps);
        let q = book_premium(&legs, u, &p).unwrap();
        let loading: U256 = legs.iter().map(|l| U256::from(l.loading)).sum();
        let unfloored: U256 = legs.iter().map(|l| standalone_unfloored(l.e, l.es, l.loading, u, &p).unwrap()).sum::<U256>() - loading;
        prop_assert!(q.premium <= unfloored.max(p.min_premium) + loading);
        let sum_standalone: U256 = legs.iter().map(|l| standalone(l, u, &p)).sum();
        prop_assert!(q.premium <= sum_standalone);
        for l in &legs {
            prop_assert!(q.premium >= standalone(l, u, &p));
        }
    }

    /// More loss on any leg (E, ES, loading or one joint scenario) never lowers the book premium.
    #[test]
    fn monotone_in_each_leg(legs in prop::collection::vec(leg(), 1..8), i in 0usize..8, j in 0usize..K, bump in 1u64..10_000_000_000, what in 0u8..4, u_bps in 0u64..10_000) {
        let p = params(5_000_000);
        let u = U256::from(W / 10_000 * u_bps);
        let i = i % legs.len();
        let before = book_premium(&legs, u, &p).unwrap().premium;
        let mut more = legs.clone();
        match what {
            0 => { more[i].e += bump; more[i].es += bump; }
            1 => more[i].es += bump,
            2 => more[i].loading += bump,
            _ => more[i].losses[j] += bump,
        }
        prop_assert!(book_premium(&more, u, &p).unwrap().premium >= before);
    }

    /// Any order of the legs prices the same book.
    #[test]
    fn invariant_to_leg_order(legs in prop::collection::vec(leg(), 2..10), seed in any::<u64>()) {
        let p = params(5_000_000);
        let u = U256::from(W / 3);
        let mut shuffled = legs.clone();
        let mut s = seed | 1;
        for k in (1..shuffled.len()).rev() {
            s ^= s << 13; s ^= s >> 7; s ^= s << 17;
            shuffled.swap(k, (s % (k as u64 + 1)) as usize);
        }
        prop_assert_eq!(book_premium(&legs, u, &p).unwrap(), book_premium(&shuffled, u, &p).unwrap());
    }

    /// One leg priced from its own `quote_cover_capped` components is exactly the single policy's premium at the same
    /// utilisation (plus the loading, as buy_cover adds it).
    #[test]
    fn one_leg_book_is_the_single_policy(c in 1_000_000u64..1_000_000_000_000, ratio in 6_000u64..9_900, cap_bps in 1u64..10_001, u_bps in 0u64..10_000, loading in 0u64..1_000_000_000) {
        let z: Vec<i16> = (0..3_000).map(|k| (k as i32 * 6 - 9_000) as i16).collect();
        let d = c / 10_000 * ratio;
        let cap = U256::from((d / 10_000 * cap_bps).max(1));
        let pp = |u: U256| PremiumParams {
            sigma: U256::from(W / 50), dividend: U256::ZERO, kappa: U256::ZERO, collateral_value: U256::from(c), debt_projected: U256::from(d),
            closure_days: 3, util_after: u, theta: U256::from(W), cost_of_cap: U256::from(W / 10), eta: U256::from(W),
            beta: U256::from(W / 1000 * 975), min_premium: U256::from(5_000_000u64),
        };
        let u = U256::from(W / 10_000 * u_bps);
        let q0 = quote_cover_capped(&SliceZ(&z), &pp(U256::ZERO), cap).unwrap();
        let qu = quote_cover_capped(&SliceZ(&z), &pp(u), cap).unwrap();
        let s = add_leg(&BookSums::default(), q0.expected_loss.to::<u64>(), q0.expected_shortfall.to::<u64>(), loading).unwrap();
        // The joint vector cannot raise ES_B above ES_1 for one leg: ES_B = min(ES_1, max(ES_J, ES_1)).
        let joint = vec![u64::MAX / 1024; K];
        let b = book_premium_from_sums(&s, &joint, u, &params(5_000_000)).unwrap();
        prop_assert_eq!(b.premium, qu.premium + U256::from(loading));
    }

    /// Refund shares round down: any subset of legs gets at most the net premium back, each at most its pro-rata part.
    #[test]
    fn refunds_never_exceed_the_premium(legs in prop::collection::vec(leg(), 1..20), net in 0u64..1_000_000_000_000, pick in any::<u32>()) {
        let p = params(5_000_000);
        let w: Vec<u64> = legs.iter().map(|l| leg_weight(l.e, l.es, l.loading, &p).unwrap()).collect();
        let total: u64 = w.iter().sum();
        let mut paid = 0u128;
        for (k, wi) in w.iter().enumerate() {
            let share = leg_share(net, *wi, total).unwrap();
            prop_assert!((share as u128) * (total as u128) <= (net as u128) * (*wi as u128));
            if pick >> (k % 32) & 1 == 1 { paid += share as u128; }
        }
        prop_assert!(paid <= net as u128);
        let all: u128 = w.iter().map(|wi| leg_share(net, *wi, total).unwrap() as u128).sum();
        prop_assert!(all <= net as u128);
    }
}

/// A book of many riskless legs pays one floor, not one per leg.
#[test]
fn floor_once() {
    let p = params(5_000_000);
    let legs: Vec<BookLeg> = (0..400).map(|_| BookLeg { e: 0, es: 0, loading: 0, losses: vec![0; K] }).collect();
    assert_eq!(book_premium(&legs, U256::ZERO, &p).unwrap().premium, U256::from(5_000_000u64));
    assert_eq!(leg_share(5_000_000, 1, 400).unwrap(), 12_500);
}
