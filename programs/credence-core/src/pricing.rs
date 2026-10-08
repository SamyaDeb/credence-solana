//! Premium and capacity for one policy. Premium math is `risk-core::quote_cover`; the loss vector uses the
//! precomputed Q64.64 gap factors and is golden-tested against `risk-core` in
//! `tests/pricing.rs`.
//!
//! Payout rule: `payout = min(cap, max(0, D − LT·C·(1 + r)))`. Mapped onto risk-core with the covered value
//! `C′ = LT × C` and κ = 0 in the gap factors.

use anchor_lang::prelude::*;
use credence_risk_core::{fixed::mul_wad_down, gap_factor_at, quote_cover_capped, PremiumParams, SliceZ, U256};

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

/// INV-2: `reserved_other + max_j(group_j + policy_j) ≤ u_max × equity`, where `reserved_other` is the reserved
/// worst-case loss of all other live groups. Utilisation rounds UP (higher premium).
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

/// Payout at settlement: `min(cap, max(0, D − C′ × (1 + r)))` with `1 + r = settle / close`, both per raw
/// xStock token unit (multiplier included).
///
/// The loss is risk-core's: `g = gap_factor_at(|r|, r < 0, d = 0, κ = 0)` and `D − ⌊C′ × g⌋`, the same rounding as the
/// premium and the capacity loss vector (covered value DOWN, so at most one base unit above the exact loss, which the
/// capacity check already reserved). The ratio `settle / close` rounds UP (a smaller payout), so the only rounding
/// in the buyer's favour is the one the vault priced. INV-1: never above `cap`.
pub fn realized_payout(covered_value: u64, debt: u64, cap: u64, close_wad: u128, settle_wad: u128) -> Result<u64> {
    require!(close_wad > 0 && settle_wad > 0, CoreError::BadPrice);
    let w = U256::from(WAD);
    let num = U256::from(settle_wad) * w;
    let ratio = num.div_ceil(U256::from(close_wad));
    let (mv, down) = if ratio >= w { (ratio - w, false) } else { (w - ratio, true) };
    let g = gap_factor_at(mv, down, U256::ZERO, U256::ZERO).map_err(|_| error!(CoreError::Math))?;
    let covered = mul_wad_down(U256::from(covered_value), g).map_err(|_| error!(CoreError::Math))?;
    let loss = U256::from(debt).saturating_sub(covered);
    u64::try_from(loss.min(U256::from(cap))).map_err(|_| error!(CoreError::Math))
}

/// Liquidation Shield parameters (W1), WAD fractions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShieldParams {
    /// α: the advance never exceeds `α × cap` (INV-9).
    pub alpha_wad: u64,
    /// b: the fair value is marked down by `b` before sizing (the basis between the weekend price and the open).
    pub buffer_wad: u64,
    /// h: the shield sizes to a projected health of `1 + h` at the marked-down fair value, so it also acts on a
    /// position that would stay just above its threshold (the "prevent" case). h = 0 is the plain repay-needed rule.
    pub health_wad: u64,
}

/// Total shield advance for a policy at a weekend fair value (W1), USDC base units, rounded DOWN.
///
/// `need = realized_payout(⌈C′ / (1 + h)⌉, D, cap, close, ⌈fair × (1 − b)⌉)`: the same payout rule as settlement, at
/// the fair value marked down by `b`, with the covered value scaled so the repayment restores health `1 + h` (with
/// h = 0: `min(cap, max(0, D − C′ × (fair / close) × (1 − b)))`). Returns `min(⌊α × cap⌋, need)`.
///
/// Rounding is against the advance where this function chooses it, since an advance above the final payout is the
/// vault's loss: the marked-down price and the scaled covered value round UP and `α × cap` rounds DOWN. Inside,
/// `realized_payout` keeps settlement's rounding (ratio UP, covered value DOWN), so `need` is at most one base unit
/// above the exact value, the same unit the capacity check reserves. The caller pays `target − advanced` when
/// positive.
pub fn shield_target(
    covered_value: u64,
    debt: u64,
    cap: u64,
    close_wad: u128,
    fair_wad: u128,
    p: &ShieldParams,
) -> Result<u64> {
    require!(close_wad > 0 && fair_wad > 0, CoreError::BadPrice);
    let w = U256::from(WAD);
    require!(U256::from(p.buffer_wad) < w && U256::from(p.alpha_wad) <= w, CoreError::InvalidParam);
    let fair_b = (U256::from(fair_wad) * (w - U256::from(p.buffer_wad))).div_ceil(w);
    let covered_h = (U256::from(covered_value) * w).div_ceil(w + U256::from(p.health_wad));
    let fair_b = u128::try_from(fair_b).map_err(|_| error!(CoreError::Math))?.max(1);
    let covered_h = u64::try_from(covered_h).map_err(|_| error!(CoreError::Math))?;
    let need = realized_payout(covered_h, debt, cap, close_wad, fair_b)?;
    let alpha_cap = u64::try_from(U256::from(cap) * U256::from(p.alpha_wad) / w).map_err(|_| error!(CoreError::Math))?;
    Ok(need.min(alpha_cap))
}

#[cfg(test)]
mod tests {
    use super::*;

    const P0: ShieldParams = ShieldParams { alpha_wad: WAD as u64, buffer_wad: 0, health_wad: 0 };

    /// With α = 1, b = 0, h = 0 the shield target is exactly the settlement payout at the fair value.
    #[test]
    fn shield_target_is_the_payout_rule_at_fair_value() {
        let close = 781_741_900_000_000_000_000u128;
        for &(c, d, cap) in &[(52_083_333_333u64, 50_000_000_000u64, 50_000_000_000u64), (447_536_918, 429_611_768, 10_000_000)] {
            for bps in [-2_000i64, -800, -400, -1, 0, 300] {
                let fair = close * (10_000 + bps) as u128 / 10_000;
                assert_eq!(shield_target(c, d, cap, close, fair, &P0).unwrap(), realized_payout(c, d, cap, close, fair).unwrap());
            }
        }
    }

    /// The demo position: $50k at D/C′ 0.96, fair −8%, b 2%, α 50%: need = D − C′ × 0.92 × 0.98 ≈ 3,041.67 USDC
    /// (within one base unit, settlement's rounding), below α × cap = 25,000.
    #[test]
    fn shield_target_demo_numbers() {
        let (c, d) = (52_083_333_333u64, 50_000_000_000u64);
        let p = ShieldParams { alpha_wad: (WAD / 2) as u64, buffer_wad: (WAD / 50) as u64, health_wad: 0 };
        let t = shield_target(c, d, d, WAD, WAD * 92 / 100, &p).unwrap();
        let exact = d as f64 - c as f64 * 0.92 * 0.98;
        assert!((t as f64 - exact).abs() <= 1.0, "t {t} exact {exact}");
        // h = 5% also acts at a fair value that leaves the position healthy at the open (D/C′ 0.96 at −2%: 0.98 < 1).
        let ph = ShieldParams { health_wad: (WAD / 20) as u64, ..p };
        assert_eq!(shield_target(c, d, d, WAD, WAD * 98 / 100, &p).unwrap(), 0);
        assert!(shield_target(c, d, d, WAD, WAD * 98 / 100, &ph).unwrap() > 0);
    }

    /// INV-9 at the sizing level and monotonicity: never above ⌊α × cap⌋, never above the cap, and a lower fair value
    /// never shrinks the target.
    #[test]
    fn shield_target_bounded_and_monotone() {
        let mut seed = 0x2545F4914F6CDD1Du64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..5_000 {
            let c = next() % 1_000_000_000_000 + 1;
            let d = next() % 1_000_000_000_000 + 1;
            let cap = next() % (d + 1);
            let close = (next() % 1_000_000 + 1) as u128 * 1_000_000_000_000_000;
            let lo = (next() % 2_000_000 + 1) as u128 * 1_000_000_000_000_000;
            let hi = lo + (next() % 1_000) as u128 * 1_000_000_000_000_000;
            let p = ShieldParams { alpha_wad: next() % (WAD as u64 + 1), buffer_wad: next() % (WAD as u64 / 5), health_wad: next() % (WAD as u64 / 5) };
            let alpha_cap = (cap as u128 * p.alpha_wad as u128 / WAD) as u64;
            let t_lo = shield_target(c, d, cap, close, lo, &p).unwrap();
            let t_hi = shield_target(c, d, cap, close, hi, &p).unwrap();
            assert!(t_lo <= alpha_cap && t_lo <= cap);
            assert!(t_lo >= t_hi, "lower fair value gave a smaller target");
        }
        assert!(shield_target(1, 1, 1, 0, WAD, &P0).is_err());
        assert!(shield_target(1, 1, 1, WAD, WAD, &ShieldParams { buffer_wad: WAD as u64, ..P0 }).is_err());
    }
}
