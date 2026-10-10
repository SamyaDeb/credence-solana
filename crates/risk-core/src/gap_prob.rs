//! P(gap < −x) from a scenario set (C3, the Gap Oracle feed).
//!
//! A scenario `z` (i16 thousandths of σ) is a gap of `σ · z / 1000`. The set is ascending, so the scenarios below
//! `−x` are a prefix and the count is a binary search. This is the rule the app's "chance this pays anything" uses
//! (`app/src/lib/odds.ts` `modelPays`: pays iff `D × 1000 × WAD > C′ × (1000 × WAD + σ z)`, which at `D/C′ = 1 − x` is
//! `σ z < −1000 x`), so the feed and the app give one answer for one threshold.

use crate::fixed::{MathError, MathResult, WAD};
use crate::scenarios::ZSource;

/// Number of scenarios with `σ · z / 1000 < −x`, with σ and x in WAD (`x` is the positive threshold, e.g. 5% = 5e16).
/// `σ = 0` has no scenario below any positive `x`. The set must be ascending (verified at upload, `finalize`).
pub fn count_below<S: ZSource + ?Sized>(set: &S, sigma_wad: u64, x_wad: u64) -> u32 {
    if sigma_wad == 0 || x_wad == 0 {
        return 0;
    }
    let limit = -(x_wad as i128) * 1000; // σ z < limit
    let below = |i: u32| (sigma_wad as i128) * (set.z(i) as i128) < limit;
    // First index that is NOT below; everything before it is.
    let (mut lo, mut hi) = (0u32, set.len());
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if below(mid) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

/// P(gap < −x) in WAD, rounded **up** (the safer reading for a lender). `EmptySet` for an empty set.
pub fn gap_prob_wad<S: ZSource + ?Sized>(set: &S, sigma_wad: u64, x_wad: u64) -> MathResult<u64> {
    let n = set.len();
    if n == 0 {
        return Err(MathError::EmptySet);
    }
    let c = count_below(set, sigma_wad, x_wad) as u128;
    let p = (c * WAD.to::<u128>()).div_ceil(n as u128);
    u64::try_from(p).map_err(|_| MathError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenarios::SliceZ;
    use alloc::vec::Vec;

    const W: u64 = 1_000_000_000_000_000_000;

    #[test]
    fn matches_the_app_rule() {
        // z in thousandths of σ, ascending.
        let z: Vec<i16> = (-4000..=4000).step_by(8).collect();
        let s = SliceZ(&z);
        let sigma = 21_506_226_567_830_584u64; // NVDAx weekend
        for x in [W / 20, W / 100 * 8, W / 100 * 12] {
            // The app's rule (odds.ts modelPays) at D/C′ = 1 − x, both sides divided by C′ = WAD:
            // (WAD − x) × 1000 > max(0, 1000 WAD + σ z).
            let app = z
                .iter()
                .filter(|&&zi| ((W - x) as i128) * 1000 > (1000 * W as i128 + sigma as i128 * zi as i128).max(0))
                .count();
            assert_eq!(count_below(&s, sigma, x) as usize, app, "x = {x}");
        }
    }

    #[test]
    fn edges_and_rounding() {
        let z = [-3000i16, -2000, -1000, 0, 1000];
        let s = SliceZ(&z);
        let sigma = W / 20; // 5%: z = −1000 is a −5% gap, which is NOT below −5%
        assert_eq!(count_below(&s, sigma, W / 20), 2);
        assert_eq!(count_below(&s, 0, W / 20), 0);
        assert_eq!(count_below(&s, sigma, 0), 0);
        // 2 of 5 = 0.4 exactly; 1 of 3 rounds up.
        assert_eq!(gap_prob_wad(&s, sigma, W / 20).unwrap(), W * 2 / 5);
        let z3 = [-3000i16, 0, 1000];
        assert_eq!(gap_prob_wad(&SliceZ(&z3), sigma, W / 20).unwrap(), W / 3 + 1);
        assert!(gap_prob_wad(&SliceZ(&[]), sigma, W / 20).is_err());
        // A wider threshold never has more mass below it than a narrower one: monotone.
        assert!(count_below(&s, sigma, W / 8) <= count_below(&s, sigma, W / 20));
    }
}
