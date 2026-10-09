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

/// The debt cover prices and reserves for a policy whose snapshot debt `D` may accrue interest until the open, at
/// most `growth_cap` (Credence Solana, task 1.2): `D × (1 + growth_cap)`, rounded UP (a larger loss: conservative).
pub fn priced_debt(debt: u64, growth_cap: u64) -> MathResult<u64> {
    let d = mul_wad_up(U256::from(debt), WAD.checked_add(U256::from(growth_cap)).ok_or(MathError::Overflow)?)?;
    u64::try_from(d).map_err(|_| MathError::Overflow)
}

/// The snapshot debt `D` with the interest it accrued since purchase, from klend's cumulative borrow-rate index
/// (U68F60 or any common scale) at purchase and now: `min(⌊D × idx_now / idx_buy⌋, ⌊D × (1 + growth_cap)⌋)`, never
/// below `D` (Credence Solana, task 1.2). Only interest on the snapshot is counted, never new borrowing. Rounded DOWN
/// (the advance and the payout are the vault's money; the reservation priced [`priced_debt`], which is never smaller).
pub fn accrued_debt(debt: u64, idx_buy: u128, idx_now: u128, growth_cap: u64) -> MathResult<u64> {
    if idx_buy == 0 {
        return Err(MathError::InvalidInput);
    }
    let grown = mul_div_down(U256::from(debt), U256::from(idx_now.max(idx_buy)), U256::from(idx_buy))?;
    let cap = mul_wad_down(U256::from(debt), WAD.checked_add(U256::from(growth_cap)).ok_or(MathError::Overflow)?)?;
    u64::try_from(grown.min(cap)).map_err(|_| MathError::Overflow)
}

/// klend's `Fraction` scale (U68F60): `_sf` values are × 2^60.
const SF_ONE: u128 = 1u128 << 60;

/// USDC value of `ctokens` of a klend reserve (Credence Solana, W3 yield vault): `⌊ctokens × total_supply_sf /
/// (mint_total_supply × 2^60)⌋`, with `total_supply_sf = available × 2^60 + borrowed_sf − protocol and referrer fees`
/// (klend's `Reserve::total_supply`, read from a reserve refreshed in the same slot). Rounded DOWN: the vault's NAV never
/// counts more than a redemption would pay. An empty reserve is valued at par.
pub fn ctoken_value(ctokens: u64, total_supply_sf: u128, mint_total_supply: u64) -> MathResult<u64> {
    if mint_total_supply == 0 || total_supply_sf == 0 {
        return Ok(ctokens);
    }
    let v = U256::from(ctokens) * U256::from(total_supply_sf) / (U256::from(mint_total_supply) * U256::from(SF_ONE));
    u64::try_from(v).map_err(|_| MathError::Overflow)
}

/// cTokens to redeem for at least `liquidity` USDC: `⌈liquidity × mint_total_supply × 2^60 / total_supply_sf⌉`.
/// Rounded UP (the vault redeems enough to restore its cash buffer).
pub fn ctokens_for(liquidity: u64, total_supply_sf: u128, mint_total_supply: u64) -> MathResult<u64> {
    if mint_total_supply == 0 || total_supply_sf == 0 {
        return Ok(liquidity);
    }
    let n = U256::from(liquidity) * U256::from(mint_total_supply) * U256::from(SF_ONE);
    u64::try_from(n.div_ceil(U256::from(total_supply_sf))).map_err(|_| MathError::Overflow)
}
