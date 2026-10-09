//! Monday Backstop (Credence Solana, W2): the inventory's money math. Prices are WAD USD per whole token of the
//! liquidity mint (Kamino's Scope basis, per raw unit × 10^decimals, the Scaled UI multiplier already inside it);
//! amounts are raw token units and USDC base units. `scale = 10^(18 + token_decimals − usdc_decimals)` (1e20 for an
//! 8-decimal xStock against 6-decimal USDC) turns `qty × price` into USDC base units.
//!
//! Rounding is always against the counterparty of the vault: a buyer pays more, a mark is lower, a cost basis removed
//! at a sale is larger, a quantity the vault may receive for its payment is smaller.

use crate::fixed::{MathError, MathResult, WAD};
use alloy_primitives::U256;

fn to_u64(x: U256) -> MathResult<u64> {
    u64::try_from(x).map_err(|_| MathError::Overflow)
}

fn to_u128(x: U256) -> MathResult<u128> {
    u128::try_from(x).map_err(|_| MathError::Overflow)
}

/// The Dutch auction's price at `now`: linear from `start` at `t0` to `floor` at `t0 + duration`, then `floor`.
/// Rounded UP (the buyer pays more). Before `t0` it is `start`. `floor ≤ start`, `duration > 0`.
pub fn dutch_price(start: u128, floor: u128, t0: i64, duration: i64, now: i64) -> MathResult<u128> {
    if floor > start || duration <= 0 {
        return Err(MathError::InvalidInput);
    }
    let elapsed = now.saturating_sub(t0).clamp(0, duration) as u128;
    let drop = U256::from(start - floor) * U256::from(elapsed) / U256::from(duration as u128); // DOWN: price UP
    to_u128(U256::from(start) - drop)
}

/// USDC a buyer pays for `qty` raw units at `price`: `⌈qty × price / scale⌉`.
pub fn lot_cost(qty: u64, price: u128, scale: u128) -> MathResult<u64> {
    if scale == 0 {
        return Err(MathError::InvalidInput);
    }
    let n = U256::from(qty) * U256::from(price);
    to_u64(n.div_ceil(U256::from(scale)))
}

/// The value of `qty` raw units at `price × (1 − haircut)`, USDC, rounded DOWN: the inventory's NAV mark.
pub fn inventory_mark(qty: u64, price: u128, haircut: u64, scale: u128) -> MathResult<u64> {
    if haircut > WAD.to::<u64>() || scale == 0 {
        return Err(MathError::InvalidInput);
    }
    let p = U256::from(price) * (WAD - U256::from(haircut)) / WAD;
    to_u64(U256::from(qty) * p / U256::from(scale))
}

/// INV-8: the most raw units a payment of `paid` USDC may buy at the committed price `price × (1 − max_discount)`:
/// `⌊paid × scale / (price × (1 − max_discount))⌋`, rounded DOWN (the vault never receives more than it paid for).
pub fn paid_for_qty(paid: u64, price: u128, max_discount: u64, scale: u128) -> MathResult<u64> {
    if max_discount >= WAD.to::<u64>() || price == 0 {
        return Err(MathError::InvalidInput);
    }
    // The committed price rounds UP: a smaller one would allow more quantity.
    let committed = (U256::from(price) * (WAD - U256::from(max_discount))).div_ceil(WAD);
    to_u64(U256::from(paid) * U256::from(scale) / committed)
}

/// The cost basis leaving the inventory when `sold` of `qty` units go: `⌈cost × sold / qty⌉`, all of it when everything
/// goes. Rounded UP, so the realised P&L of a sale is never flattered and what stays booked is never above cost.
pub fn cost_portion(cost: u64, qty: u64, sold: u64) -> MathResult<u64> {
    if sold > qty || qty == 0 {
        return Err(MathError::InvalidInput);
    }
    if sold == qty {
        return Ok(cost);
    }
    to_u64((U256::from(cost) * U256::from(sold)).div_ceil(U256::from(qty))).map(|c| c.min(cost))
}
