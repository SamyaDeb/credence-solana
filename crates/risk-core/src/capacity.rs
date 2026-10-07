//! F-4.4: pool capacity over K joint stress weekends (§9.5, R-13).
//!
//! The pool stores the policy part of the loss vector (4 × uint64 per word). The uncovered part is a linear
//! upper bound per market, recomputed at each check: after the Bell every uncovered position has
//! D_i ≤ LTV_safe × C_i, so L_i ≤ C_i × max(0, LTV_safe − g) and the sum over positions is B.

use crate::fixed::{div_wad_up, mul_wad_up, unpack_u64, MathError, MathResult, WAD};
use crate::safe_ltv::gap_factor;
use crate::scenarios::ZSource;
use alloc::vec::Vec;
use alloy_primitives::U256;

/// Loss of one policy in each of the K joint scenarios, loan units (rounded UP), as uint64.
pub fn loss_vector<S: ZSource + ?Sized>(
    joint: &S,
    collateral_value: U256,
    debt_projected: U256,
    sigma: U256,
    dividend: U256,
    kappa: U256,
) -> MathResult<Vec<u64>> {
    let k = joint.len();
    let mut out = Vec::with_capacity(k as usize);
    for j in 0..k {
        let g = gap_factor(joint.z(j), sigma, dividend, kappa)?;
        // C × g rounded down → the loss rounds up
        let covered_value = crate::fixed::mul_wad_down(collateral_value, g)?;
        let l = debt_projected.saturating_sub(covered_value);
        out.push(u64::try_from(l).map_err(|_| MathError::Overflow)?);
    }
    Ok(out)
}

/// B_j = C_unc × max(0, LTV_safe − g_j), loan units, rounded UP.
pub fn uncovered_bound(
    collateral_unc: U256,
    safe_ltv: U256,
    sigma: U256,
    dividend: U256,
    kappa: U256,
    z: i16,
) -> MathResult<U256> {
    let g = gap_factor(z, sigma, dividend, kappa)?;
    if g >= safe_ltv {
        return Ok(U256::ZERO);
    }
    mul_wad_up(collateral_unc, safe_ltv - g)
}

/// One market's uncovered exposure for the capacity check.
#[derive(Clone, Copy, Debug)]
pub struct UncoveredMarket<'a, S: ZSource + ?Sized> {
    /// The asset's column of the joint scenario matrix (K entries).
    pub joint: &'a S,
    /// σ of the asset for this closure type.
    pub sigma: U256,
    /// Known dividend.
    pub dividend: U256,
    /// C_unc = value(totalCollateral − coveredCollateral, V_live), loan units.
    pub collateral_value: U256,
    /// The market's safe LTV for this closure.
    pub safe_ltv: U256,
}

/// Capacity check output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapacityResult {
    /// u_after ≤ u_max.
    pub ok: bool,
    /// u = max_j Λ_j / J, WAD, rounded UP. `U256::MAX` if J = 0 and some loss is positive.
    pub util_after: U256,
    /// max_j Λ_j, loan units.
    pub worst_loss: U256,
}

/// Λ_j = current_j + add_j + Σ_markets B_{m,j}; u = max_j Λ_j / J; accept iff u ≤ u_max (F-4.4).
pub fn pool_capacity<S: ZSource + ?Sized>(
    packed_current: &[U256],
    packed_add: &[U256],
    k: u32,
    uncovered: &[UncoveredMarket<'_, S>],
    kappa: U256,
    equity: U256,
    u_max: U256,
) -> MathResult<CapacityResult> {
    let words = (k as usize).div_ceil(4);
    if packed_current.len() < words || packed_add.len() < words {
        return Err(MathError::InvalidInput);
    }
    for m in uncovered {
        if m.joint.len() < k {
            return Err(MathError::InvalidInput);
        }
    }
    let mut worst = U256::ZERO;
    for j in 0..k as usize {
        let mut lambda = U256::from(unpack_u64(packed_current[j / 4], j % 4))
            + U256::from(unpack_u64(packed_add[j / 4], j % 4));
        for m in uncovered {
            let b = uncovered_bound(
                m.collateral_value,
                m.safe_ltv,
                m.sigma,
                m.dividend,
                kappa,
                m.joint.z(j as u32),
            )?;
            lambda = lambda.checked_add(b).ok_or(MathError::Overflow)?;
        }
        if lambda > worst {
            worst = lambda;
        }
    }
    let util_after = if worst.is_zero() {
        U256::ZERO
    } else if equity.is_zero() {
        U256::MAX
    } else {
        div_wad_up(worst, equity)?
    };
    if u_max > WAD {
        return Err(MathError::InvalidInput);
    }
    Ok(CapacityResult {
        ok: util_after <= u_max,
        util_after,
        worst_loss: worst,
    })
}
