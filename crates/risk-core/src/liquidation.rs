//! F-4.5a/b/d: liquidation lots and per-position settlement (§9.6).

use crate::fixed::{
    collateral_value, loan_to_wad, mul_div_down, mul_div_up, mul_wad_down, pow10, MathError,
    MathResult, WAD,
};
use alloy_primitives::U256;

/// F-4.5a. Lot for REOPEN, INTRADAY, EMERGENCY and NAV, sized at the reserve price R (`sizing_price`) with
/// health measured at P_hf (`hf_price`: open print, V_live or V_ext):
///
/// x = (H*·D − q·P_hf·LT) / (H*·R·(1 − λ) − P_hf·LT), rounded UP (sell enough), clamped to [0, q].
/// A non-positive denominator, or x ≥ q, is a full close (x = q).
#[allow(clippy::too_many_arguments)]
pub fn liquidation_lot(
    debt: U256,
    qty: U256,
    sizing_price: U256,
    hf_price: U256,
    lt: U256,
    h_star: U256,
    lambda: U256,
    coll_dec: u8,
    loan_dec: u8,
) -> MathResult<U256> {
    if lambda > WAD || lt > WAD * U256::from(10u8) {
        return Err(MathError::InvalidInput);
    }
    if qty.is_zero() {
        return Ok(U256::ZERO);
    }
    let scale = pow10(coll_dec)?;
    // numerator in WAD² USD: H*·D_usd − LT·(q·P/10^collDec), the subtracted term rounded down
    let d_usd = loan_to_wad(debt, loan_dec)?;
    let lhs = h_star.checked_mul(d_usd).ok_or(MathError::Overflow)?;
    let rhs = mul_div_down(
        qty,
        hf_price.checked_mul(lt).ok_or(MathError::Overflow)?,
        scale,
    )?;
    if lhs <= rhs {
        return Ok(U256::ZERO); // already at or above H*
    }
    let num = lhs - rhs;
    // denominator in WAD² per token: H*·R·(1 − λ) − P·LT, rounded down
    let hr = mul_wad_down(
        h_star
            .checked_mul(sizing_price)
            .ok_or(MathError::Overflow)?,
        WAD - lambda,
    )?;
    let pl = hf_price.checked_mul(lt).ok_or(MathError::Overflow)?;
    if hr <= pl {
        return Ok(qty);
    }
    let x = mul_div_up(num, scale, hr - pl)?;
    Ok(if x >= qty { qty } else { x })
}

/// F-4.5b. Pre-close lot (R-06): down to the safe LTV at V, sold at R_pre = (1 − κ_pre) V, penalty λ_pre:
///
/// x = (D_proj − LTV_s·q·V) / ((1 − λ_pre)·R_pre − LTV_s·V), rounded UP, clamped to [0, q].
#[allow(clippy::too_many_arguments)]
pub fn preclose_lot(
    debt: U256,
    qty: U256,
    valuation: U256,
    reserve: U256,
    target_ltv: U256,
    lambda_pre: U256,
    coll_dec: u8,
    loan_dec: u8,
) -> MathResult<U256> {
    if lambda_pre > WAD || target_ltv > WAD {
        return Err(MathError::InvalidInput);
    }
    if qty.is_zero() {
        return Ok(U256::ZERO);
    }
    let scale = pow10(coll_dec)?;
    let d_usd = loan_to_wad(debt, loan_dec)?;
    let lhs = d_usd.checked_mul(WAD).ok_or(MathError::Overflow)?;
    let rhs = mul_div_down(
        qty,
        target_ltv
            .checked_mul(valuation)
            .ok_or(MathError::Overflow)?,
        scale,
    )?;
    if lhs <= rhs {
        return Ok(U256::ZERO);
    }
    let num = lhs - rhs;
    let sell = (WAD - lambda_pre)
        .checked_mul(reserve)
        .ok_or(MathError::Overflow)?;
    let keep = target_ltv
        .checked_mul(valuation)
        .ok_or(MathError::Overflow)?;
    if sell <= keep {
        return Ok(qty);
    }
    let x = mul_div_up(num, scale, sell - keep)?;
    Ok(if x >= qty { qty } else { x })
}

/// Settlement of one position after its lot cleared at the blended price p̄ (F-4.5d).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Settlement {
    /// P_i = value(x_i, p̄), rounded DOWN.
    pub proceeds: U256,
    /// Liquidation penalty, rounded DOWN.
    pub penalty: U256,
    /// Debt repaid from the proceeds.
    pub repaid: U256,
    /// Refunded to the borrower (full close, solvent).
    pub refund: U256,
    /// S_i = D_i − P_i when a full close is short; goes to the waterfall.
    pub shortfall: U256,
    /// Debt left on the position.
    pub debt_after: U256,
    /// x_i == q_i.
    pub full_close: bool,
}

/// Settle one position (F-4.5d): partial → penalty λP, debt − (1 − λ)P; full and solvent → penalty
/// min(λP, P − D), refund the rest; full and short → no penalty, shortfall D − P.
#[allow(clippy::too_many_arguments)]
pub fn settle_position(
    x: U256,
    q_before: U256,
    blended_price: U256,
    debt: U256,
    lambda: U256,
    coll_dec: u8,
    loan_dec: u8,
) -> MathResult<Settlement> {
    if x > q_before || lambda > WAD {
        return Err(MathError::InvalidInput);
    }
    let p = collateral_value(x, blended_price, coll_dec, loan_dec)?;
    let pen_full = mul_wad_down(lambda, p)?;
    let mut s = Settlement {
        proceeds: p,
        full_close: x == q_before,
        ..Settlement::default()
    };
    if !s.full_close {
        let net = p - pen_full;
        s.penalty = pen_full;
        s.repaid = net.min(debt);
        s.refund = net - s.repaid;
        s.debt_after = debt - s.repaid;
    } else if p >= debt {
        s.penalty = pen_full.min(p - debt);
        s.repaid = debt;
        s.refund = p - debt - s.penalty;
    } else {
        s.repaid = p;
        s.shortfall = debt - p;
    }
    Ok(s)
}
