//! Monday Backstop math (W2): the Dutch auction decays from start to floor and never below, the buyer always pays at
//! least the exact price, the mark is never above the haircut value, INV-8's bound never lets the vault take more
//! than it paid for at the committed price, and selling a lot in pieces never removes less cost than selling it whole.

use credence_risk_core::{cost_portion, dutch_price, inventory_mark, lot_cost, paid_for_qty, U256};
use proptest::prelude::*;

const W: u128 = 1_000_000_000_000_000_000;
const SCALE: u128 = 100_000_000_000_000_000_000; // 1e20: 8-decimal token, 6-decimal USDC

proptest! {
    #![proptest_config(ProptestConfig::with_cases(5_000))]

    #[test]
    fn dutch_decays_monotone_between_start_and_floor(start in 1u128..2_000 * W, cut in 0u128..W, t0 in 0i64..1_000_000,
                                                    dur in 1i64..100_000, a in -1_000i64..200_000, b in 0i64..200_000) {
        let floor = start - start / W * cut.min(W - 1) / 1;
        let floor = floor.min(start);
        let p = |t: i64| dutch_price(start, floor, t0, dur, t0 + t).unwrap();
        let (x, y) = (p(a), p(a + b));
        prop_assert!(x >= floor && x <= start);
        prop_assert!(y <= x, "price rose over time");
        prop_assert_eq!(p(-5), start);
        prop_assert_eq!(p(dur), floor);
        prop_assert_eq!(p(dur + 1_000), floor);
    }

    #[test]
    fn buyer_pays_at_least_the_exact_cost(qty in 0u64..10_000_000_000_000, price in 1u128..5_000 * W) {
        let c = lot_cost(qty, price, SCALE).unwrap();
        let exact = qty as f64 * price as f64 / SCALE as f64;
        prop_assert!(c as f64 + 1e-6 >= exact * (1.0 - 1e-12));
        prop_assert!((c as f64) <= exact + 1.0 + exact * 1e-12);
    }

    /// INV-8: the quantity a payment buys at the committed price, valued back at that price, never exceeds the payment.
    #[test]
    fn inv8_paid_for_never_exceeds_payment(paid in 0u64..100_000_000_000_000, price in 1_000u128..5_000 * W, kappa in 0u64..500_000_000_000_000_000) {
        let q = paid_for_qty(paid, price, kappa, SCALE).unwrap();
        let committed = (U256::from(price) * U256::from(W - kappa as u128)).div_ceil(U256::from(W));
        // q at the committed price is never worth more than what was paid, and one more unit would be (tight bound)
        prop_assert!(U256::from(q) * committed <= U256::from(paid) * U256::from(SCALE), "q {} > paid {}", q, paid);
        prop_assert!((U256::from(q) + U256::from(1u8)) * committed > U256::from(paid) * U256::from(SCALE));
    }

    #[test]
    fn mark_never_above_haircut_value(qty in 0u64..10_000_000_000_000, price in 1u128..5_000 * W, h in 0u64..1_000_000_000_000_000_000) {
        let m = inventory_mark(qty, price, h, SCALE).unwrap();
        let exact = qty as f64 * price as f64 * (1.0 - h as f64 / 1e18) / SCALE as f64;
        prop_assert!(m as f64 <= exact * (1.0 + 1e-12) + 1e-9);
        prop_assert!(inventory_mark(qty, price, 0, SCALE).unwrap() >= m);
    }

    /// Selling in two pieces removes at least the cost of selling at once (UP twice ≥ UP once), never more than cost.
    #[test]
    fn cost_basis_removed_in_pieces(cost in 0u64..1_000_000_000_000, qty in 1u64..10_000_000_000, s1 in 0u64..10_000_000_000, s2 in 0u64..10_000_000_000) {
        let s1 = s1 % (qty + 1);
        let s2 = s2 % (qty - s1 + 1);
        let a = cost_portion(cost, qty, s1).unwrap();
        let b = cost_portion(cost - a, qty - s1, s2).unwrap();
        let once = cost_portion(cost, qty, s1 + s2).unwrap();
        prop_assert!(a + b >= once && a + b <= cost);
        prop_assert_eq!(cost_portion(cost, qty, qty).unwrap(), cost);
    }
}

#[test]
fn backstop_demo_numbers() {
    // SPYx at $715.53: 15.588 SPYx (1,558,877,147 raw) are worth 11,154.23 USDC; at a 10% haircut the mark is 10,038.81.
    let price = 715_530_000_000_000_000_000u128;
    assert_eq!(lot_cost(1_558_877_147, price, SCALE).unwrap(), 11_154_233_650);
    assert_eq!(inventory_mark(1_558_877_147, price, 100_000_000_000_000_000, SCALE).unwrap(), 10_038_810_284);
    // 10,013.10 USDC at a committed −15% price buys at most 16.46 SPYx: the 15.59 received is inside INV-8.
    assert_eq!(paid_for_qty(10_013_100_000, price, 150_000_000_000_000_000, SCALE).unwrap(), 1_646_348_531);
    // Auction from +2% to −5% over 2 h: after 1 h the midpoint.
    let (s, f) = (price * 102 / 100, price * 95 / 100);
    assert_eq!(dutch_price(s, f, 0, 7_200, 3_600).unwrap(), (s + f).div_ceil(2));
    assert!(dutch_price(f, s, 0, 1, 0).is_err() && dutch_price(s, f, 0, 0, 0).is_err());
    assert!(paid_for_qty(1, price, 1_000_000_000_000_000_000, SCALE).is_err());
}
