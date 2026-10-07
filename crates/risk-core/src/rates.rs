//! F-4.6: the kinked borrow rate, senior rate and interest accrual (§9.7).

use crate::fixed::{
    mul_div_down, mul_div_up, mul_wad_down, mul_wad_up, MathError, MathResult, WAD, YEAR_SECONDS,
};
use alloy_primitives::U256;

/// U = borrowed / supplied, WAD, rounded DOWN. S = 0 → 0.
pub fn utilization(borrowed: U256, supplied: U256) -> MathResult<U256> {
    if supplied.is_zero() {
        return Ok(U256::ZERO);
    }
    mul_div_down(borrowed, WAD, supplied)
}

/// r_b(U): r0 + s1·U/U* below the kink, r0 + s1 + s2·(U − U*)/(1 − U*) above it. WAD per year, rounded DOWN.
pub fn kinked_rate(u: U256, r0: U256, s1: U256, s2: U256, u_kink: U256) -> MathResult<U256> {
    if u_kink.is_zero() || u_kink >= WAD {
        return Err(MathError::InvalidInput);
    }
    if u <= u_kink {
        return r0
            .checked_add(mul_div_down(s1, u, u_kink)?)
            .ok_or(MathError::Overflow);
    }
    let excess = u - u_kink;
    let slope = mul_div_down(s2, excess, WAD - u_kink)?;
    r0.checked_add(s1)
        .and_then(|x| x.checked_add(slope))
        .ok_or(MathError::Overflow)
}

/// r_senior = r_b × U × (1 − ρ_J − ρ_p), WAD per year, rounded DOWN.
pub fn senior_rate(r_b: U256, u: U256, rho_pool: U256, rho_treasury: U256) -> MathResult<U256> {
    let fees = rho_pool
        .checked_add(rho_treasury)
        .ok_or(MathError::Overflow)?;
    if fees > WAD {
        return Err(MathError::InvalidInput);
    }
    mul_wad_down(mul_wad_down(r_b, u)?, WAD - fees)
}

/// I = B × r_b × dt / 31,536,000, rounded UP (§8.4.3 `_accrue`).
pub fn accrue_interest(borrowed: U256, rate: U256, dt: u64) -> MathResult<U256> {
    let per_year = mul_wad_up(borrowed, rate)?;
    mul_div_up(per_year, U256::from(dt), U256::from(YEAR_SECONDS))
}

/// D_proj = D × (1 + r_b × days / 365), rounded UP (R-08).
pub fn projected_debt(debt: U256, rate: U256, days: u16) -> MathResult<U256> {
    let growth = mul_div_up(rate, U256::from(days), U256::from(365u16))?;
    mul_wad_up(debt, WAD.checked_add(growth).ok_or(MathError::Overflow)?)
}
