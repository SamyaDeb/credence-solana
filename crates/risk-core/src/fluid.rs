//! Jupiter Lend (Fluid vaults) position math (Credence Solana, W12, task B2): a borrow position stores its collateral
//! and a tick, not its debt. The debt is the collateral times the tick's ratio, `1.0015^tick` in Q48, rounded UP:
//!
//! `debt_raw = ⌊ratio_x48(tick) × (col_raw + 1) / 2^48⌋ + 1`
//!
//! Both raw amounts are in Fluid's normalised 9-decimal units, divided by the vault's exchange prices (1e12). Ported
//! bit for bit from `@jup-ag/lend` (`getRatioAtTick`, `getCurrentPositionState`), golden-tested against it.

use crate::fixed::{MathError, MathResult};
use alloy_primitives::U256;

/// Lowest tick (`MIN_TICK`).
pub const MIN_TICK: i32 = -16383;
/// Highest tick (`MAX_TICK`).
pub const MAX_TICK: i32 = 16383;
/// The exchange-price precision of Fluid vaults.
pub const EXCHANGE_PRICE_PRECISION: u64 = 1_000_000_000_000;

const FACTORS: [u128; 16] = [
    18446744073709551616,
    18419115400608638658,
    18391528108445969703,
    18336477419114433396,
    18226869890870665593,
    18009616477100071088,
    17582847377087825313,
    16759408633341240198,
    15226414841393184936,
    12568272644527235157,
    8563108841104354677,
    3975055583337633975,
    856577552520149366,
    39775317560084773,
    85764505686420,
    398745188,
];

/// `ratio_x48(tick) = 1.0015^tick × 2^48`, as Fluid computes it (for a positive tick: ⌊(2^128 − 1) / factor⌋ >> 16,
/// rounded up when the division leaves bits below 2^16).
pub fn ratio_at_tick(tick: i32) -> MathResult<U256> {
    if !(MIN_TICK..=MAX_TICK).contains(&tick) {
        return Err(MathError::InvalidInput);
    }
    let abs = tick.unsigned_abs();
    let mut factor = U256::from(if abs & 1 != 0 { FACTORS[1] } else { FACTORS[0] });
    for (bit, f) in FACTORS.iter().enumerate().skip(2) {
        if abs & (1 << (bit - 1)) != 0 {
            factor = (factor * U256::from(*f)) >> 64;
        }
    }
    let mut precision = U256::ZERO;
    if tick > 0 {
        let max_u128 = (U256::from(1u8) << 128) - U256::from(1u8);
        factor = max_u128 / factor;
        if factor % U256::from(65_536u32) != U256::ZERO {
            precision = U256::from(1u8);
        }
    }
    Ok((factor >> 16) + precision)
}

/// A position's raw debt from its raw collateral and tick (rounded UP, +1 as Fluid). 0 at or below `MIN_TICK`.
pub fn debt_raw(col_raw: u64, tick: i32) -> MathResult<u128> {
    if tick <= MIN_TICK {
        return Ok(0);
    }
    let d = ((ratio_at_tick(tick)? * (U256::from(col_raw) + U256::from(1u8))) >> 48) + U256::from(1u8);
    u128::try_from(d).map_err(|_| MathError::Overflow)
}

/// Raw (normalised, 9-decimal) amount → token base units: `raw × exchange_price / 1e12`, then down to `decimals`
/// (< 9). `up` rounds up (debt), else down (collateral): against the position, so cover never over-reads it.
pub fn raw_to_tokens(raw: u128, exchange_price: u64, decimals: u8, up: bool) -> MathResult<u64> {
    if decimals > 9 {
        return Err(MathError::InvalidInput);
    }
    let scale = U256::from(EXCHANGE_PRICE_PRECISION) * U256::from(10u64.pow(9 - decimals as u32));
    let n = U256::from(raw) * U256::from(exchange_price);
    let v = if up { n.div_ceil(scale) } else { n / scale };
    u64::try_from(v).map_err(|_| MathError::Overflow)
}
