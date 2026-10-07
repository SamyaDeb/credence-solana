//! F-4.5c: uniform-price batch clearing with pro-rata ties (§9.6, R-05).
//!
//! Bids with price ≥ R are sorted by price descending and filled until the lot Q is reached. p* is the price
//! of the last bid needed; everyone pays p*. At p*, the remaining quantity is split pro rata by quantity, and
//! integer remainders go one unit each in ascending tie-key order (tie key = keccak256(auctionId, bidder)).
//! Arrival order never matters, so being fastest earns nothing (P5).

use crate::fixed::{mul_div_down, MathError, MathResult};
use alloc::vec::Vec;
use alloy_primitives::{B256, U256};

/// Clearing output. `fills` is aligned with the input bids.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClearResult {
    /// Uniform clearing price p* (0 if nothing filled).
    pub p_star: U256,
    /// Quantity filled per input bid.
    pub fills: Vec<U256>,
    /// Q − Σ fills: bought by the pool at R.
    pub q_pool: U256,
}

/// Clear a batch (F-4.5c).
pub fn clear(
    qtys: &[U256],
    prices: &[U256],
    tie_keys: &[B256],
    lot: U256,
    reserve: U256,
) -> MathResult<ClearResult> {
    let n = qtys.len();
    if prices.len() != n || tie_keys.len() != n {
        return Err(MathError::InvalidInput);
    }
    let mut fills = alloc::vec![U256::ZERO; n];
    // eligible bids: price ≥ R, qty > 0; ordered by price desc, then tie key asc (determinism only)
    let mut idx: Vec<usize> = (0..n)
        .filter(|&i| prices[i] >= reserve && !qtys[i].is_zero())
        .collect();
    idx.sort_unstable_by(|&a, &b| {
        prices[b]
            .cmp(&prices[a])
            .then(tie_keys[a].cmp(&tie_keys[b]))
    });

    let mut remaining = lot;
    let mut p_star = U256::ZERO;
    let mut g = 0;
    while g < idx.len() && !remaining.is_zero() {
        // the group of bids at the same price
        let price = prices[idx[g]];
        let mut end = g;
        let mut total = U256::ZERO;
        while end < idx.len() && prices[idx[end]] == price {
            total = total
                .checked_add(qtys[idx[end]])
                .ok_or(MathError::Overflow)?;
            end += 1;
        }
        p_star = price;
        if total <= remaining {
            for &i in &idx[g..end] {
                fills[i] = qtys[i];
            }
            remaining -= total;
        } else {
            // pro rata at the marginal price; group is already in ascending tie-key order
            let mut assigned = U256::ZERO;
            for &i in &idx[g..end] {
                let f = mul_div_down(qtys[i], remaining, total)?;
                fills[i] = f;
                assigned += f;
            }
            let mut leftover = remaining - assigned;
            for &i in &idx[g..end] {
                if leftover.is_zero() {
                    break;
                }
                if fills[i] < qtys[i] {
                    fills[i] += U256::from(1u8);
                    leftover -= U256::from(1u8);
                }
            }
            remaining = U256::ZERO;
        }
        g = end;
    }
    Ok(ClearResult {
        p_star,
        fills,
        q_pool: remaining,
    })
}

/// p̄ = ((Q − Q_pool) p* + Q_pool R) / Q, rounded DOWN (0 if Q = 0).
pub fn blended_price(lot: U256, p_star: U256, q_pool: U256, reserve: U256) -> MathResult<U256> {
    if lot.is_zero() {
        return Ok(U256::ZERO);
    }
    if q_pool > lot {
        return Err(MathError::InvalidInput);
    }
    let sold = (lot - q_pool)
        .checked_mul(p_star)
        .ok_or(MathError::Overflow)?;
    let pool = q_pool.checked_mul(reserve).ok_or(MathError::Overflow)?;
    mul_div_down(
        sold.checked_add(pool).ok_or(MathError::Overflow)?,
        U256::from(1u8),
        lot,
    )
}
