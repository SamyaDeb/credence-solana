//! Premium and capacity for one policy. Premium math is `risk-core::quote_cover`; the loss vector uses the
//! precomputed Q64.64 gap factors (plan/03, compute budget) and is golden-tested against `risk-core` in
//! `tests/pricing.rs`.
//!
//! Payout rule (plan/02 §2): `payout = min(cap, max(0, D − LT·C·(1 + r)))`. Mapped onto risk-core with the covered value
//! `C′ = LT × C` and κ = 0 in the gap factors.

use anchor_lang::prelude::*;
use credence_risk_core::{quote_cover_capped, PremiumParams, SliceZ, U256};

use crate::math::WAD;
use crate::state::{AssetConfig, Config, K};
use crate::CoreError;

/// One policy's inputs, USDC base units.
#[derive(Clone, Copy, Debug)]
pub struct CoverInputs {
    /// C′ = LT × covered collateral value, rounded DOWN (smaller covered value → larger loss).
    pub covered_value: u64,
    pub debt: u64,
    pub max_payout: u64,
}

/// Premium for a capped policy (`risk-core::quote_cover_capped`), USDC base units, rounded UP.
///
/// `util_after_wad` is u from the capacity check. `closure_days` is τ × 365 (3 for a weekend).
pub fn premium(
    z: &[i16],
    cfg: &Config,
    sigma_wad: u64,
    dividend_wad: u64,
    closure_days: u16,
    util_after_wad: u64,
    x: &CoverInputs,
) -> Result<u64> {
    let params = PremiumParams {
        sigma: U256::from(sigma_wad),
        dividend: U256::from(dividend_wad),
        // Same κ as the gap factors (`compute_gap_factors`); `ConfigParams::validate` pins it to 0 in Phase 1.
        kappa: U256::from(cfg.kappa_wad),
        collateral_value: U256::from(x.covered_value),
        debt_projected: U256::from(x.debt),
        closure_days,
        util_after: U256::from(util_after_wad),
        theta: U256::from(cfg.theta_wad),
        cost_of_cap: U256::from(cfg.cost_of_cap_wad),
        eta: U256::from(cfg.eta_wad),
        beta: U256::from(cfg.beta_wad),
        min_premium: U256::from(cfg.min_premium),
    };
    let q = quote_cover_capped(&SliceZ(z), &params, U256::from(x.max_payout)).map_err(|_| error!(CoreError::Math))?;
    q.premium.try_into().map_err(|_| error!(CoreError::Math))
}

/// Writes `min(cap, max(0, D − ⌊C′ × g_j⌋))` for every joint scenario into `out` and returns the worst one.
///
/// 128-bit with Q64.64 factors: `⌊C′ × g_j / 2^64⌋`. Real values are far from the limits (C′ < 2^50, g_j < 2^65);
/// `checked_mul` and `try_from` turn any overflow into an error instead of wrapping. Covered value rounds DOWN, so the
/// loss rounds UP.
pub fn policy_losses(asset: &AssetConfig, x: &CoverInputs, out: &mut [u64]) -> Result<u64> {
    require!(out.len() == K, CoreError::Math);
    let c = x.covered_value as u128;
    let mut worst = 0u64;
    for (j, slot) in out.iter_mut().enumerate() {
        let g = asset.gap_factor_q64(j);
        let covered = u64::try_from(c.checked_mul(g).ok_or(CoreError::Math)? >> 64).map_err(|_| CoreError::Math)?;
        let loss = x.debt.saturating_sub(covered).min(x.max_payout);
        *slot = loss;
        worst = worst.max(loss);
    }
    Ok(worst)
}

/// Capacity check result.
#[derive(Clone, Copy, Debug, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct Capacity {
    /// max_j (group_j + policy_j), USDC.
    pub group_worst_after: u64,
    /// Utilisation after the policy, WAD: (reserved_other + group_worst_after) / (u_max × equity), rounded UP.
    pub util_after_wad: u64,
}

/// INV-2: `reserved_other + max_j(group_j + policy_j) ≤ u_max × equity`. Utilisation rounds UP (higher premium).
pub fn capacity(
    group: &[u64; K],
    policy: &[u64],
    reserved_other: u64,
    equity: u64,
    u_max_wad: u64,
) -> Result<Capacity> {
    let mut worst = 0u64;
    for j in 0..K {
        worst = worst.max(group[j].checked_add(policy[j]).ok_or(CoreError::Math)?);
    }
    let used = (reserved_other as u128).checked_add(worst as u128).ok_or(CoreError::Math)?;
    // limit = u_max × equity, rounded DOWN (smaller limit is conservative).
    let limit = (equity as u128) * (u_max_wad as u128) / WAD;
    require!(limit > 0 && used <= limit, CoreError::CapacityExceeded);
    // u = used / limit in WAD, rounded UP.
    let util = (used * WAD).div_ceil(limit);
    Ok(Capacity { group_worst_after: worst, util_after_wad: util as u64 })
}
