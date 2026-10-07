//! Scenario sets (R-14): standardised gaps z, sorted ascending, as int16 thousandths of one σ.
//!
//! `ZSource` is implemented by an in-memory slice (native builds, tests) and by packed words (the on-chain
//! storage layout, 16 × int16 per word), so the same math runs in every build.

use crate::fixed::{mul_div_up, unpack_i16, MathError, MathResult, WAD};
use alloy_primitives::U256;

/// A read-only, ascending scenario set.
pub trait ZSource {
    /// Number of scenarios N.
    fn len(&self) -> u32;
    /// The i-th smallest z (0-based), in thousandths of σ.
    fn z(&self, i: u32) -> i16;
    /// True if the set is empty.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// An in-memory set.
#[derive(Clone, Copy, Debug)]
pub struct SliceZ<'a>(pub &'a [i16]);

impl ZSource for SliceZ<'_> {
    fn len(&self) -> u32 {
        self.0.len() as u32
    }
    fn z(&self, i: u32) -> i16 {
        self.0[i as usize]
    }
}

/// A packed set: 16 × int16 per word, lane 0 = least-significant bits (== PackedInt.sol).
#[derive(Clone, Copy, Debug)]
pub struct PackedZ<'a> {
    words: &'a [U256],
    n: u32,
}

impl<'a> PackedZ<'a> {
    /// Wrap `words` holding `n` values. Fails if the words are too few.
    pub fn new(words: &'a [U256], n: u32) -> MathResult<Self> {
        if (n as usize).div_ceil(16) > words.len() {
            return Err(MathError::InvalidInput);
        }
        Ok(Self { words, n })
    }
}

impl ZSource for PackedZ<'_> {
    fn len(&self) -> u32 {
        self.n
    }
    fn z(&self, i: u32) -> i16 {
        unpack_i16(self.words[(i / 16) as usize], (i % 16) as usize)
    }
}

/// True if the set is sorted ascending (non-strict).
pub fn is_sorted<S: ZSource + ?Sized>(s: &S) -> bool {
    (1..s.len()).all(|i| s.z(i - 1) <= s.z(i))
}

/// i* = ⌈α·N⌉ − 1 (0-based, floored at 0): the lower empirical α-quantile of an ascending set (F-4.2).
pub fn quantile_index(n: u32, alpha: U256) -> MathResult<u32> {
    if n == 0 {
        return Err(MathError::EmptySet);
    }
    if alpha.is_zero() || alpha > WAD {
        return Err(MathError::InvalidInput);
    }
    let k = mul_div_up(alpha, U256::from(n), WAD)?;
    let k: u32 = k.to::<u32>();
    Ok(k.saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixed::pack_i16;

    #[test]
    fn quantile_index_edges() {
        let a = U256::from(1_000_000_000_000_000u64); // 0.1%
        assert_eq!(quantile_index(1000, a).unwrap(), 0);
        assert_eq!(quantile_index(1300, a).unwrap(), 1); // ⌈1.3⌉ − 1
        assert_eq!(quantile_index(3000, a).unwrap(), 2);
        assert_eq!(quantile_index(10, a).unwrap(), 0);
        assert_eq!(quantile_index(0, a), Err(MathError::EmptySet));
        assert_eq!(quantile_index(10, U256::ZERO), Err(MathError::InvalidInput));
        assert_eq!(
            quantile_index(10, WAD + U256::from(1u8)),
            Err(MathError::InvalidInput)
        );
        assert_eq!(quantile_index(10, WAD).unwrap(), 9);
    }

    #[test]
    fn packed_equals_slice() {
        let v: alloc::vec::Vec<i16> = (0..37).map(|i| (i * 97 - 1800) as i16).collect();
        let w = pack_i16(&v);
        let p = PackedZ::new(&w, v.len() as u32).unwrap();
        let s = SliceZ(&v);
        assert_eq!(p.len(), s.len());
        for i in 0..s.len() {
            assert_eq!(p.z(i), s.z(i));
        }
        assert!(is_sorted(&p));
        assert!(!is_sorted(&SliceZ(&[1, 0])));
        assert!(PackedZ::new(&w, 49).is_err());
        assert!(SliceZ(&[]).is_empty());
    }
}
