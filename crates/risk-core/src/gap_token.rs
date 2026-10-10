//! Gap tokens (D2, research prototype, not offered): the payout split of one complete set.
//!
//! A complete set is 1 USDC (1,000,000 base units) that backs 1 GAP-DOWN and 1 GAP-UP. After the closure settles on
//! `r = settle / close − 1` (WAD, the epoch's stored prices) the set is split by the gap, linear in a band `±k`:
//! `down = clamp(0.5 − r / 2k, 0, 1)`, `up = 1 − down`.
//!
//! Units: token base units are 1:1 with USDC base units (6 decimals). A side's share of a set is a whole number of
//! millionths ("micro", `0..=1_000_000`), so a set splits into whole base units.
//!
//! Rounding: DOWN's share rounds **down**; UP's share is the complement, never computed on its own, so
//! `down + up = 1_000_000` exactly for every `r` (INV-21). A redemption pays `floor(amount × micro / 1e6)`: it loses
//! less than one base unit against the redeemer and never exceeds the pool, so the collateral cannot run short.

use crate::fixed::{MathError, MathResult};

/// 1e18 as `u128`.
const W: u128 = 1_000_000_000_000_000_000;
/// One set split, in millionths.
pub const SET_MICRO: u32 = 1_000_000;
/// Band multiple: `k = 2.5 σ`, WAD.
pub const BAND_M_WAD: u128 = 2_500_000_000_000_000_000;
/// Smallest band, 2%, WAD.
pub const BAND_MIN_WAD: u128 = 20_000_000_000_000_000;
/// Largest band, 30%, WAD.
pub const BAND_MAX_WAD: u128 = 300_000_000_000_000_000;
/// Band rounding step, 0.5%, WAD.
pub const BAND_STEP_WAD: u128 = 5_000_000_000_000_000;
/// A WAD value of one millionth.
const MICRO_WAD: u128 = 1_000_000_000_000;

/// The band `k` (WAD) for a closure's σ (WAD): `2.5 σ` rounded **up** to 0.5%, clamped to `[2%, 30%]`.
/// Rounds up so a rounding never narrows the band below `2.5 σ`.
pub fn band_k(sigma_wad: u64) -> u128 {
    let raw = (sigma_wad as u128) * BAND_M_WAD / W; // ≤ 4.6e19, no overflow
    let up = raw.div_ceil(BAND_STEP_WAD) * BAND_STEP_WAD;
    up.clamp(BAND_MIN_WAD, BAND_MAX_WAD)
}

/// DOWN's share of one set in millionths, rounded **down**. `r_wad` is the signed gap; `k_wad` the band (must be > 0
/// and at most `BAND_MAX_WAD`). `r` is clamped to `[−k, +k]` first, so any `i128` is accepted.
pub fn down_micro(r_wad: i128, k_wad: u128) -> MathResult<u32> {
    if k_wad == 0 || k_wad > BAND_MAX_WAD {
        return Err(MathError::InvalidInput);
    }
    let k = k_wad as i128;
    let x = r_wad.clamp(-k, k);
    // (k − x) ∈ [0, 2k]; (k − x) · 1e18 ≤ 6e35 fits in u128.
    let num = (k - x) as u128;
    let down_wad = num * W / (2 * k_wad);
    Ok((down_wad / MICRO_WAD) as u32)
}

/// UP's share of one set in millionths: the complement of DOWN's, so the pair sums to `SET_MICRO` exactly.
pub fn up_micro(down_micro: u32) -> u32 {
    SET_MICRO.saturating_sub(down_micro)
}

/// Both shares `(down, up)` for a gap and band. Always sums to `SET_MICRO`.
pub fn split(r_wad: i128, k_wad: u128) -> MathResult<(u32, u32)> {
    let d = down_micro(r_wad, k_wad)?;
    Ok((d, up_micro(d)))
}

/// USDC base units paid for `amount` tokens of a side whose share is `side_micro`: `floor(amount × micro / 1e6)`,
/// at most `amount`. Rounds against the redeemer by less than one base unit.
pub fn payout(amount: u64, side_micro: u32) -> MathResult<u64> {
    if side_micro > SET_MICRO {
        return Err(MathError::InvalidInput);
    }
    Ok(((amount as u128) * (side_micro as u128) / SET_MICRO as u128) as u64)
}

/// DOWN payout in USDC base units for `amount` DOWN tokens at gap `r` and band `k`.
pub fn payout_down(r_wad: i128, k_wad: u128, amount: u64) -> MathResult<u64> {
    payout(amount, down_micro(r_wad, k_wad)?)
}

/// UP payout in USDC base units for `amount` UP tokens at gap `r` and band `k`.
pub fn payout_up(r_wad: i128, k_wad: u128, amount: u64) -> MathResult<u64> {
    payout(amount, split(r_wad, k_wad)?.1)
}

/// What the series still owes one side: `pool = floor(sets × micro / 1e6)`.
pub fn side_pool(sets: u64, side_micro: u32) -> MathResult<u64> {
    payout(sets, side_micro)
}

/// The amount a redemption of `amount` tokens pays when `remaining` tokens of the side are still outstanding and
/// `pool_left` of the side's pool is unpaid. The last redeemer (`amount == remaining`) takes the whole remainder, so
/// no dust is stranded; any other redemption pays `floor(amount × micro / 1e6)`, capped at `pool_left`.
pub fn redeem_amount(amount: u64, remaining: u64, pool_left: u64, side_micro: u32) -> MathResult<u64> {
    if amount == 0 || amount > remaining {
        return Err(MathError::InvalidInput);
    }
    if amount == remaining {
        return Ok(pool_left);
    }
    Ok(payout(amount, side_micro)?.min(pool_left))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const PCT: i128 = 10_000_000_000_000_000; // 1% in WAD

    #[test]
    fn golden_points() {
        let k = 10 * PCT as u128;
        assert_eq!(split(0, k).unwrap(), (500_000, 500_000));
        assert_eq!(split(-8 * PCT, k).unwrap(), (900_000, 100_000)); // the demo's −8%
        assert_eq!(split(-10 * PCT, k).unwrap(), (1_000_000, 0));
        assert_eq!(split(-50 * PCT, k).unwrap(), (1_000_000, 0));
        assert_eq!(split(10 * PCT, k).unwrap(), (0, 1_000_000));
        assert_eq!(split(i128::MAX, k).unwrap(), (0, 1_000_000));
        assert_eq!(split(i128::MIN, k).unwrap(), (1_000_000, 0));
    }

    #[test]
    fn band_rule() {
        assert_eq!(band_k(0), BAND_MIN_WAD);
        assert_eq!(band_k(21_506_226_567_830_584), 55_000_000_000_000_000); // NVDAx 2.15% → 5.38% → 5.5%
        assert_eq!(band_k(40_000_000_000_000_000), 100_000_000_000_000_000); // 4% → 10%
        assert_eq!(band_k(u64::MAX), BAND_MAX_WAD);
    }

    #[test]
    fn rejects_bad_band() {
        assert!(down_micro(0, 0).is_err());
        assert!(down_micro(0, BAND_MAX_WAD + 1).is_err());
    }

    #[test]
    fn payouts_floor_and_never_exceed_the_set() {
        assert_eq!(payout(1_000_000, 900_000).unwrap(), 900_000);
        assert_eq!(payout(1, 900_000).unwrap(), 0);
        assert_eq!(payout(3, 500_000).unwrap(), 1);
        assert!(payout(1, SET_MICRO + 1).is_err());
    }

    #[test]
    fn last_redeemer_takes_the_remainder() {
        // 3 tokens, share 0.5: pool = floor(1.5) = 1. Redeeming 1,1,1 would pay 0,0,0; the last takes the 1.
        let (mut rem, mut pool, mut paid) = (3u64, side_pool(3, 500_000).unwrap(), 0u64);
        for _ in 0..3 {
            let p = redeem_amount(1, rem, pool, 500_000).unwrap();
            rem -= 1;
            pool -= p;
            paid += p;
        }
        assert_eq!((rem, pool, paid), (0, 0, 1));
        assert!(redeem_amount(0, 3, 1, 500_000).is_err());
        assert!(redeem_amount(4, 3, 1, 500_000).is_err());
    }

    proptest! {
        #[test]
        fn pair_sums_to_one_usdc(r in any::<i128>(), k in 1u128..=BAND_MAX_WAD) {
            let (d, u) = split(r, k).unwrap();
            prop_assert_eq!(d + u, SET_MICRO);
        }

        #[test]
        fn monotone_in_r(a in any::<i128>(), b in any::<i128>(), k in 1u128..=BAND_MAX_WAD) {
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            let (dl, ul) = split(lo, k).unwrap();
            let (dh, uh) = split(hi, k).unwrap();
            prop_assert!(dl >= dh, "DOWN falls as r rises");
            prop_assert!(ul <= uh, "UP rises as r rises");
        }

        #[test]
        fn clamped_at_the_edges(extra in 0i128..i128::MAX / 2, k in 1u128..=BAND_MAX_WAD) {
            let ki = k as i128;
            prop_assert_eq!(split(-ki - extra, k).unwrap(), (SET_MICRO, 0));
            prop_assert_eq!(split(ki + extra, k).unwrap(), (0, SET_MICRO));
            prop_assert_eq!(split(-ki, k).unwrap(), split(i128::MIN, k).unwrap());
        }

        #[test]
        fn symmetric_within_one_micro(r in any::<i128>(), k in 1u128..=BAND_MAX_WAD) {
            let r = r.max(-i128::MAX);
            let s = down_micro(r, k).unwrap() + down_micro(-r, k).unwrap();
            prop_assert!(s == SET_MICRO || s == SET_MICRO - 1, "{s}");
        }

        #[test]
        fn redemptions_never_exceed_the_pool(
            sets in 0u64..1_000_000_000_000, r in any::<i128>(), k in 1u128..=BAND_MAX_WAD,
            cuts in proptest::collection::vec(1u64..1000, 1..20),
        ) {
            let (d, u) = split(r, k).unwrap();
            for micro in [d, u] {
                let (mut rem, mut pool, mut paid) = (sets, side_pool(sets, micro).unwrap(), 0u64);
                for c in &cuts {
                    if rem == 0 { break; }
                    let a = (*c).min(rem);
                    let p = redeem_amount(a, rem, pool, micro).unwrap();
                    // against the redeemer by < 1 unit (the last redeemer takes the remainder, so only above)
                    if a != rem { prop_assert!(p as u128 * 1_000_000 <= a as u128 * micro as u128); }
                    prop_assert!(p <= pool);
                    rem -= a; pool -= p; paid += p;
                }
                prop_assert!(paid <= side_pool(sets, micro).unwrap());
            }
            // both pools together never exceed the collateral
            prop_assert!(side_pool(sets, d).unwrap() + side_pool(sets, u).unwrap() <= sets);
        }

        #[test]
        fn payout_loses_under_one_unit(amount in any::<u64>(), micro in 0u32..=SET_MICRO) {
            let p = payout(amount, micro).unwrap() as u128;
            let exact = amount as u128 * micro as u128;
            prop_assert!(p * 1_000_000 <= exact && exact - p * 1_000_000 < 1_000_000);
        }

        #[test]
        fn band_is_within_bounds(sigma in any::<u64>()) {
            let k = band_k(sigma);
            prop_assert!((BAND_MIN_WAD..=BAND_MAX_WAD).contains(&k) && k % BAND_STEP_WAD == 0);
        }
    }
}
