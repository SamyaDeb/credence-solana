//! F-4.2: safe LTV, cures and the Bell status (§9.3), plus the σ rate limit (R-15).

use crate::fixed::{
    collateral_value, div_wad_up, loan_to_wad, ltv_up, mul_div_down, mul_div_up, mul_wad_down,
    pow10, pow_wad_up, MathError, MathResult, DAY_SECONDS, WAD,
};
use crate::scenarios::{quantile_index, ZSource};
use alloy_primitives::U256;

const THOUSAND: U256 = U256::from_limbs([1000, 0, 0, 0]);
/// 0.9 in WAD: σ may fall at most 10% per day.
pub const SIGMA_DAILY_FLOOR: U256 = U256::from_limbs([900_000_000_000_000_000, 0, 0, 0]);

/// g = max(0, 1 + σ·z/1000 − d) × (1 − κ), rounded DOWN.
///
/// This is the post-gap, post-liquidation-cost value of one unit of collateral in scenario z. Rounding down
/// is conservative everywhere it is used (safe LTV down, losses up, uncovered bounds up).
pub fn gap_factor(z: i16, sigma: U256, dividend: U256, kappa: U256) -> MathResult<U256> {
    let az = U256::from(z.unsigned_abs());
    if z >= 0 {
        gap_factor_at(mul_div_down(sigma, az, THOUSAND)?, false, dividend, kappa)
    } else {
        gap_factor_at(mul_div_up(sigma, az, THOUSAND)?, true, dividend, kappa)
    }
}

/// The same formula with the price move σ·|z| given directly in WAD (full precision; `down` = a negative z):
/// g = max(0, 1 ± move − d) × (1 − κ), rounded DOWN. `gap_factor` rounds σ·|z| against the user before calling it.
pub fn gap_factor_at(move_wad: U256, down: bool, dividend: U256, kappa: U256) -> MathResult<U256> {
    if kappa > WAD {
        return Err(MathError::InvalidInput);
    }
    let base = if down {
        WAD.saturating_sub(move_wad)
    } else {
        WAD.checked_add(move_wad).ok_or(MathError::Overflow)?
    };
    mul_wad_down(base.saturating_sub(dividend), WAD - kappa)
}

/// LTV_safe = min(LTV_max_eff, g(z_{i*})) for the quantile scenario z (F-4.2), rounded down.
pub fn safe_ltv(
    z: i16,
    sigma: U256,
    dividend: U256,
    kappa: U256,
    max_ltv: U256,
) -> MathResult<U256> {
    Ok(gap_factor(z, sigma, dividend, kappa)?.min(max_ltv))
}

/// `safe_ltv` at i* = ⌈α·N⌉ − 1 of an ascending set.
pub fn safe_ltv_from_set<S: ZSource + ?Sized>(
    set: &S,
    alpha: U256,
    sigma: U256,
    dividend: U256,
    kappa: U256,
    max_ltv: U256,
) -> MathResult<U256> {
    let idx = quantile_index(set.len(), alpha)?;
    safe_ltv(set.z(idx), sigma, dividend, kappa, max_ltv)
}

/// The two alternative cures for a position above the safe LTV (F-4.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cures {
    /// ΔD = max(0, D_proj − LTV_safe × C), loan units, rounded UP.
    pub repay: U256,
    /// Δq = max(0, D_proj / (LTV_safe × V) − q), collateral base units, rounded UP.
    pub add_collateral: U256,
    /// value(Δq, V), loan units, rounded UP.
    pub add_collateral_value: U256,
}

/// Cure amounts for a position (q, V, D_proj) against `ltv_safe` (F-4.2). `ltv_safe = 0` → the collateral
/// cure is impossible and returned as `U256::MAX`.
pub fn cure_amounts(
    debt_projected: U256,
    q: U256,
    v: U256,
    ltv_safe: U256,
    coll_dec: u8,
    loan_dec: u8,
) -> MathResult<Cures> {
    let c = collateral_value(q, v, coll_dec, loan_dec)?;
    let allowed = mul_wad_down(ltv_safe, c)?;
    let repay = debt_projected.saturating_sub(allowed);
    if ltv_safe.is_zero() || v.is_zero() {
        let inf = if debt_projected.is_zero() {
            U256::ZERO
        } else {
            U256::MAX
        };
        return Ok(Cures {
            repay,
            add_collateral: inf,
            add_collateral_value: inf,
        });
    }
    // q* = D_usd × 10^collDec / (LTV_safe × V / 1e18), rounded up
    let d_usd = loan_to_wad(debt_projected, loan_dec)?;
    let scale = pow10(coll_dec)?
        .checked_mul(WAD)
        .ok_or(MathError::Overflow)?;
    let den = ltv_safe.checked_mul(v).ok_or(MathError::Overflow)?;
    let q_star = mul_div_up(d_usd, scale, den)?;
    let add = q_star.saturating_sub(q);
    let add_value = mul_div_up(
        add,
        v.checked_mul(pow10(loan_dec)?).ok_or(MathError::Overflow)?,
        scale,
    )?;
    Ok(Cures {
        repay,
        add_collateral: add,
        add_collateral_value: add_value,
    })
}

/// Bell status codes (== `BellStatus` in Types.sol).
pub const SAFE: u8 = 0;
/// Above the safe LTV and not covered.
pub const NEEDS_ACTION: u8 = 1;
/// Covered for this closure.
pub const COVERED: u8 = 2;

/// `bellStatus` output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BellResult {
    /// SAFE / NEEDS_ACTION / COVERED.
    pub status: u8,
    /// ΔD, loan units, rounded UP.
    pub cure_repay: U256,
    /// Collateral value to add, loan units, rounded UP.
    pub cure_collateral_value: U256,
}

/// Bell status of a position in value terms (C, D_proj at the closure's safe LTV).
pub fn bell_status(
    collateral_value: U256,
    debt_projected: U256,
    ltv_safe: U256,
    covered: bool,
) -> MathResult<BellResult> {
    if covered {
        return Ok(BellResult {
            status: COVERED,
            cure_repay: U256::ZERO,
            cure_collateral_value: U256::ZERO,
        });
    }
    if ltv_up(debt_projected, collateral_value)? <= ltv_safe {
        return Ok(BellResult {
            status: SAFE,
            cure_repay: U256::ZERO,
            cure_collateral_value: U256::ZERO,
        });
    }
    let cure_repay = debt_projected.saturating_sub(mul_wad_down(ltv_safe, collateral_value)?);
    let cure_collateral_value = if ltv_safe.is_zero() {
        U256::MAX
    } else {
        div_wad_up(debt_projected, ltv_safe)?.saturating_sub(collateral_value)
    };
    Ok(BellResult {
        status: NEEDS_ACTION,
        cure_repay,
        cure_collateral_value,
    })
}

/// Whole days elapsed between two unix timestamps (floored); 0 if `now < from`.
pub fn elapsed_days(from: u64, now: u64) -> u64 {
    now.saturating_sub(from) / DAY_SECONDS
}

/// The lowest σ allowed after `days` whole days: current × 0.9^days, rounded UP (R-15: down at most 10%/day).
pub fn sigma_min_allowed(current: U256, days: u64) -> MathResult<U256> {
    if current.is_zero() {
        return Ok(U256::ZERO);
    }
    // 0.9^days underflows to 0 well before 400 days; cap the exponent to bound gas.
    let factor = pow_wad_up(SIGMA_DAILY_FLOOR, days.min(400))?;
    crate::fixed::mul_wad_up(current, factor)
}
