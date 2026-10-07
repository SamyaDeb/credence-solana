//! Fixed-point primitives: WAD mul/div with explicit rounding over a 512-bit intermediate, powers, and the
//! packed-integer layouts shared with `contracts/src/libraries/PackedInt.sol`.

use alloy_primitives::ruint::UintTryFrom;
use alloy_primitives::{aliases::U512, U256};

/// 1e18.
pub const WAD: U256 = U256::from_limbs([1_000_000_000_000_000_000, 0, 0, 0]);
/// Seconds in a 365-day year (§9.7).
pub const YEAR_SECONDS: u64 = 31_536_000;
/// Seconds in a day.
pub const DAY_SECONDS: u64 = 86_400;

/// Math failure. The discriminant is the `MathError(uint8 code)` reported by the Stylus engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MathError {
    /// A result does not fit its type.
    Overflow = 1,
    /// Division by zero.
    DivisionByZero = 2,
    /// An input is outside its documented domain.
    InvalidInput = 3,
    /// The scenario set is empty.
    EmptySet = 4,
    /// A scenario set is not sorted ascending.
    NotSorted = 5,
}

impl MathError {
    /// The numeric code used in the on-chain `MathError(uint8)`.
    pub const fn code(self) -> u8 {
        self as u8
    }
}

/// Result alias for this crate.
pub type MathResult<T> = Result<T, MathError>;

#[inline]
fn narrow(x: U512) -> MathResult<U256> {
    U256::uint_try_from(x).map_err(|_| MathError::Overflow)
}

/// ⌊a × b / d⌋ (and whether it was exact) with the cheapest exact intermediate: 256-bit when the product fits,
/// else 512-bit. Both return the same quotient; the fast one only saves gas on-chain (the per-scenario loops of
/// quoteCover / coverLossVector / poolCapacity always fit 256 bits).
#[inline]
fn mul_div_rem(a: U256, b: U256, d: U256) -> MathResult<(U256, bool)> {
    if d.is_zero() {
        return Err(MathError::DivisionByZero);
    }
    if let Some(p) = a.checked_mul(b) {
        let (q, r) = p.div_rem(d);
        return Ok((q, !r.is_zero()));
    }
    let prod: U512 = a.widening_mul(b);
    let (q, r) = prod.div_rem(U512::from(d));
    Ok((narrow(q)?, !r.is_zero()))
}

/// ⌊a × b / d⌋ with an exact intermediate (up to 512 bits).
pub fn mul_div_down(a: U256, b: U256, d: U256) -> MathResult<U256> {
    Ok(mul_div_rem(a, b, d)?.0)
}

/// ⌈a × b / d⌉ with an exact intermediate (up to 512 bits).
pub fn mul_div_up(a: U256, b: U256, d: U256) -> MathResult<U256> {
    let (q, rem) = mul_div_rem(a, b, d)?;
    if rem {
        q.checked_add(U256::from(1u8)).ok_or(MathError::Overflow)
    } else {
        Ok(q)
    }
}

/// ⌊a × b / 1e18⌋.
pub fn mul_wad_down(a: U256, b: U256) -> MathResult<U256> {
    mul_div_down(a, b, WAD)
}

/// ⌈a × b / 1e18⌉.
pub fn mul_wad_up(a: U256, b: U256) -> MathResult<U256> {
    mul_div_up(a, b, WAD)
}

/// ⌊a × 1e18 / b⌋.
pub fn div_wad_down(a: U256, b: U256) -> MathResult<U256> {
    mul_div_down(a, WAD, b)
}

/// ⌈a × 1e18 / b⌉.
pub fn div_wad_up(a: U256, b: U256) -> MathResult<U256> {
    mul_div_up(a, WAD, b)
}

/// ⌈a / b⌉ for plain integers.
pub fn ceil_div(a: U256, b: U256) -> MathResult<U256> {
    if b.is_zero() {
        return Err(MathError::DivisionByZero);
    }
    let (q, r) = a.div_rem(b);
    Ok(if r.is_zero() { q } else { q + U256::from(1u8) })
}

/// 10^dec for token decimals (≤ 36).
pub fn pow10(dec: u8) -> MathResult<U256> {
    if dec > 36 {
        return Err(MathError::InvalidInput);
    }
    Ok(U256::from(10u8).pow(U256::from(dec)))
}

/// `base^n` in WAD, rounded down at every step (binary exponentiation). Used for 0.9^days.
pub fn pow_wad_down(base: U256, mut n: u64) -> MathResult<U256> {
    let mut result = WAD;
    let mut b = base;
    while n > 0 {
        if n & 1 == 1 {
            result = mul_wad_down(result, b)?;
        }
        n >>= 1;
        if n > 0 {
            b = mul_wad_down(b, b)?;
        }
    }
    Ok(result)
}

/// `base^n` in WAD, rounded up at every step.
pub fn pow_wad_up(base: U256, mut n: u64) -> MathResult<U256> {
    let mut result = WAD;
    let mut b = base;
    while n > 0 {
        if n & 1 == 1 {
            result = mul_wad_up(result, b)?;
        }
        n >>= 1;
        if n > 0 {
            b = mul_wad_up(b, b)?;
        }
    }
    Ok(result)
}

/// value(q, V) = q × V × 10^loanDec / (10^collDec × 1e18), rounded DOWN (§7.1, F-4.1).
pub fn collateral_value(q: U256, v: U256, coll_dec: u8, loan_dec: u8) -> MathResult<U256> {
    let num_scale = pow10(loan_dec)?;
    let den = pow10(coll_dec)?
        .checked_mul(WAD)
        .ok_or(MathError::Overflow)?;
    mul_div_down(q, v.checked_mul(num_scale).ok_or(MathError::Overflow)?, den)
}

/// LTV = D × 1e18 / C, rounded UP (F-4.1). C = 0 with D > 0 → `U256::MAX`.
pub fn ltv_up(debt: U256, collateral_value: U256) -> MathResult<U256> {
    if debt.is_zero() {
        return Ok(U256::ZERO);
    }
    if collateral_value.is_zero() {
        return Ok(U256::MAX);
    }
    div_wad_up(debt, collateral_value)
}

/// HF = C × LT / D, rounded DOWN (F-4.1). D = 0 → `U256::MAX`.
pub fn health_factor_down(collateral_value: U256, lt: U256, debt: U256) -> MathResult<U256> {
    if debt.is_zero() {
        return Ok(U256::MAX);
    }
    mul_div_down(collateral_value, lt, debt)
}

/// Loan units → WAD USD (exact for loanDec ≤ 18).
pub fn loan_to_wad(amount: U256, loan_dec: u8) -> MathResult<U256> {
    if loan_dec > 18 {
        return Err(MathError::InvalidInput);
    }
    amount
        .checked_mul(pow10(18 - loan_dec)?)
        .ok_or(MathError::Overflow)
}

// ───────────────────────────── packed layouts (== PackedInt.sol) ─────────────────────────────

/// Signed int16 lane `lane` (0 = least-significant 16 bits) of a word holding 16 × int16.
pub fn unpack_i16(word: U256, lane: usize) -> i16 {
    debug_assert!(lane < 16);
    let limb = word.as_limbs()[lane / 4];
    ((limb >> (16 * (lane % 4))) & 0xffff) as u16 as i16
}

/// Pack int16 values 16 per word, lane 0 = least-significant bits.
pub fn pack_i16(values: &[i16]) -> alloc::vec::Vec<U256> {
    let mut words = alloc::vec![[0u64; 4]; values.len().div_ceil(16)];
    for (i, v) in values.iter().enumerate() {
        let lane = i % 16;
        words[i / 16][lane / 4] |= ((*v as u16) as u64) << (16 * (lane % 4));
    }
    words.into_iter().map(U256::from_limbs).collect()
}

/// uint64 lane `lane` (0 = least-significant 64 bits) of a word holding 4 × uint64.
pub fn unpack_u64(word: U256, lane: usize) -> u64 {
    debug_assert!(lane < 4);
    word.as_limbs()[lane]
}

/// Pack uint64 values 4 per word, lane 0 = least-significant bits.
pub fn pack_u64(values: &[u64]) -> alloc::vec::Vec<U256> {
    let mut words = alloc::vec![[0u64; 4]; values.len().div_ceil(4)];
    for (i, v) in values.iter().enumerate() {
        words[i / 4][i % 4] = *v;
    }
    words.into_iter().map(U256::from_limbs).collect()
}

/// Unpack the first `n` uint64 lanes.
pub fn unpack_u64_vec(words: &[U256], n: usize) -> MathResult<alloc::vec::Vec<u64>> {
    if n.div_ceil(4) > words.len() {
        return Err(MathError::InvalidInput);
    }
    Ok((0..n).map(|i| unpack_u64(words[i / 4], i % 4)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(x: u128) -> U256 {
        U256::from(x)
    }

    #[test]
    fn mul_div_rounding() {
        assert_eq!(mul_div_down(u(7), u(3), u(2)).unwrap(), u(10));
        assert_eq!(mul_div_up(u(7), u(3), u(2)).unwrap(), u(11));
        assert_eq!(mul_div_up(u(6), u(3), u(2)).unwrap(), u(9));
        assert_eq!(
            mul_div_down(u(1), u(1), U256::ZERO),
            Err(MathError::DivisionByZero)
        );
        assert_eq!(
            mul_div_up(u(1), u(1), U256::ZERO),
            Err(MathError::DivisionByZero)
        );
        // 512-bit intermediate: (2^255)·4/8 = 2^254
        let big = U256::from(1u8) << 255;
        assert_eq!(
            mul_div_down(big, u(4), u(8)).unwrap(),
            U256::from(1u8) << 254
        );
        assert_eq!(
            mul_div_down(U256::MAX, U256::MAX, u(1)),
            Err(MathError::Overflow)
        );
    }

    #[test]
    fn pow_and_decimals() {
        let nine = u(900_000_000_000_000_000);
        assert_eq!(pow_wad_down(nine, 0).unwrap(), WAD);
        assert_eq!(pow_wad_down(nine, 1).unwrap(), nine);
        assert_eq!(pow_wad_down(nine, 2).unwrap(), u(810_000_000_000_000_000));
        assert_eq!(pow_wad_down(nine, 3).unwrap(), u(729_000_000_000_000_000));
        assert_eq!(pow_wad_up(nine, 3).unwrap(), u(729_000_000_000_000_000));
        assert_eq!(pow10(6).unwrap(), u(1_000_000));
        assert_eq!(pow10(37), Err(MathError::InvalidInput));
        assert_eq!(ceil_div(u(7), u(2)).unwrap(), u(4));
        assert_eq!(ceil_div(u(1), U256::ZERO), Err(MathError::DivisionByZero));
        assert_eq!(loan_to_wad(u(1_000_000), 6).unwrap(), WAD);
        assert_eq!(loan_to_wad(u(1), 19), Err(MathError::InvalidInput));
    }

    #[test]
    fn value_ltv_hf() {
        // 100 tokens × $180 = $18,000 in 6-dec USDC
        let c = collateral_value(u(100) * WAD, u(180) * WAD, 18, 6).unwrap();
        assert_eq!(c, u(18_000_000_000));
        assert_eq!(
            ltv_up(u(13_500_000_000), c).unwrap(),
            u(750_000_000_000_000_000)
        );
        assert_eq!(ltv_up(U256::ZERO, c).unwrap(), U256::ZERO);
        assert_eq!(ltv_up(u(1), U256::ZERO).unwrap(), U256::MAX);
        // HF = 18,000 × 0.8 / 13,500 = 1.0666…
        assert_eq!(
            health_factor_down(c, u(800_000_000_000_000_000), u(13_500_000_000)).unwrap(),
            u(1_066_666_666_666_666_666)
        );
        assert_eq!(health_factor_down(c, WAD, U256::ZERO).unwrap(), U256::MAX);
    }

    #[test]
    fn packing_matches_solidity_layout() {
        let vals: alloc::vec::Vec<i16> = (-20..20).map(|x| (x * 1234) as i16).collect();
        let words = pack_i16(&vals);
        assert_eq!(words.len(), 3);
        for (i, v) in vals.iter().enumerate() {
            assert_eq!(unpack_i16(words[i / 16], i % 16), *v);
        }
        // lane 0 is the least-significant 16 bits: [-1] → 0xffff
        assert_eq!(pack_i16(&[-1])[0], u(0xffff));
        assert_eq!(pack_i16(&[0, 1])[0], u(0x1_0000));
        let u64s = [1u64, 2, u64::MAX, 4, 5];
        let w = pack_u64(&u64s);
        assert_eq!(w.len(), 2);
        assert_eq!(unpack_u64_vec(&w, 5).unwrap(), u64s.to_vec());
        assert_eq!(w[1], u(5));
        assert!(unpack_u64_vec(&w, 9).is_err());
    }
}
