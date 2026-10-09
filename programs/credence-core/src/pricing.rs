//! Premium and capacity for one policy. Premium math is `risk-core::quote_cover`; the loss vector uses the
//! precomputed Q64.64 gap factors and is golden-tested against `risk-core` in
//! `tests/pricing.rs`.
//!
//! Payout rule: `payout = min(cap, max(0, D − LT·C·(1 + r)))`. Mapped onto risk-core with the covered value
//! `C′ = LT × C` and κ = 0 in the gap factors.
//!
//! With the Liquidation Shield on, a policy's reserved loss per joint scenario also covers the advance the shield would
//! make in that scenario (`risk-core::reserved_loss`, task 1.2), so the capacity INV-2 reserves is what the vault can
//! actually pay before the open, and INV-12 binds only beyond `k·σ_b` of basis.

use anchor_lang::prelude::*;
use credence_risk_core::{
    fixed::mul_wad_down, gap_factor_at, quote_cover_capped, reserve_shift, shield_loading as risk_shield_loading,
    PremiumParams, ShieldLoadingParams, SliceZ, U256,
};

use crate::math::WAD;
use crate::state::{AssetConfig, Config, K, MAX_LEGS};
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

/// Liquidation Shield loading of a policy's premium (W1), USDC base units, rounded UP: `λ × E[max(0, advance −
/// payout)]` from `risk-core::shield_loading` over the asset's scenario set, with the config's α, b, h, λ and the
/// asset's σ_b. 0 while the shield is off (α = 0). Added on top of [`premium`] by `buy_cover` and `quote_cover`.
///
/// `worst_loss` is the policy's reservation from [`policy_losses`]: `shield_advance` never advances above it (INV-12),
/// so the loading prices the advance capped there.
pub fn shield_loading(
    z: &[i16],
    cfg: &Config,
    sigma_wad: u64,
    basis_sigma_wad: u64,
    x: &CoverInputs,
    worst_loss: u64,
) -> Result<u64> {
    if cfg.shield_alpha_wad == 0 {
        return Ok(0);
    }
    let p = ShieldLoadingParams {
        sigma: sigma_wad,
        basis_sigma: basis_sigma_wad,
        covered: x.covered_value,
        debt: x.debt,
        cap: x.max_payout,
        alpha: cfg.shield_alpha_wad,
        buffer: cfg.shield_buffer_wad,
        health: cfg.shield_health_wad,
        lambda: cfg.shield_lambda_wad,
        advance_cap: worst_loss,
    };
    Ok(risk_shield_loading(&SliceZ(z), &p).map_err(|_| error!(CoreError::Math))?.loading)
}

/// The shield part of a policy's reservation in Q64.64, computed once per policy (task 1.2).
struct ShieldReserveQ {
    /// C″ = ⌊C′ × (1 − b) / (1 + h)⌋, rounded DOWN (a larger advance).
    covered: u64,
    /// ⌈k × σ_b⌉ in Q64.64, rounded UP (a lower fair value, a larger advance).
    shift_q64: u128,
    /// ⌊α × cap⌋.
    alpha_cap: u64,
}

fn shield_reserve(asset: &AssetConfig, cfg: &Config, x: &CoverInputs) -> Result<Option<ShieldReserveQ>> {
    if cfg.shield_alpha_wad == 0 {
        return Ok(None);
    }
    require!((cfg.shield_buffer_wad as u128) < WAD, CoreError::InvalidParam);
    let covered = (x.covered_value as u128)
        .checked_mul(WAD - cfg.shield_buffer_wad as u128)
        .ok_or(CoreError::Math)?
        / (WAD + cfg.shield_health_wad as u128);
    let shift_wad = reserve_shift(cfg.shield_reserve_k_wad, asset.basis_sigma_wad).map_err(|_| error!(CoreError::Math))?;
    let shift_q64 = ((shift_wad as u128) << 64).div_ceil(WAD);
    let alpha_cap = (x.max_payout as u128) * (cfg.shield_alpha_wad as u128) / WAD;
    Ok(Some(ShieldReserveQ {
        covered: u64::try_from(covered).map_err(|_| CoreError::Math)?,
        shift_q64,
        alpha_cap: u64::try_from(alpha_cap).map_err(|_| CoreError::Math)?,
    }))
}

/// Writes each joint scenario's reserved loss into `out` and returns the worst one, USDC base units:
///
/// - shield off (α = 0): `min(cap, max(0, D − ⌊C′ × g_j⌋))`, the settlement loss;
/// - shield on: `max(settlement loss, min(⌊α × cap⌋, cap, D − ⌊C″ × max(0, g_j − k·σ_b)⌋))`, i.e. also the advance the
///   shield makes at a fair value `k·σ_b` below the scenario's gap (`risk-core::reserved_loss`, task 1.2).
///
/// 128-bit with Q64.64 factors: `⌊C × g_j / 2^64⌋`. Real values are far from the limits (C′ < 2^50, g_j < 2^65);
/// `checked_mul` and `try_from` turn any overflow into an error instead of wrapping. Covered values round DOWN and the
/// shift rounds UP, so every loss rounds UP: never below risk-core's (golden test in `tests/pricing.rs`).
pub fn policy_losses(asset: &AssetConfig, cfg: &Config, x: &CoverInputs, out: &mut [u64]) -> Result<u64> {
    policy_losses_scaled(asset, cfg, x, WAD as u64, out)
}

/// The weekend gap factors scaled to another closure's σ (W11): `g′ = 1 + m (g − 1)` with `m = σ_closure / σ_weekend`
/// when it is above 1 (an earnings bump, a closure riskier than a weekend); below 1 the weekend's factors are kept
/// (conservative: more capacity reserved than the closure needs). Q64, the move rounded against the vault.
pub fn scale_gap_q64(g: u128, mult_wad: u64) -> u128 {
    if mult_wad as u128 <= WAD {
        return g;
    }
    let one = 1u128 << 64;
    let m = mult_wad as u128;
    if g < one {
        let mv = ((one - g).saturating_mul(m)).div_ceil(WAD);
        one.saturating_sub(mv)
    } else {
        let mv = ((g - one).saturating_mul(m)).div_ceil(WAD);
        one.saturating_add(mv)
    }
}

/// [`policy_losses`] with the gap factors scaled by `mult_wad` ([`scale_gap_q64`]).
pub fn policy_losses_scaled(asset: &AssetConfig, cfg: &Config, x: &CoverInputs, mult_wad: u64, out: &mut [u64]) -> Result<u64> {
    require!(out.len() == K, CoreError::Math);
    let c = x.covered_value as u128;
    let shield = shield_reserve(asset, cfg, x)?;
    let mut worst = 0u64;
    for (j, slot) in out.iter_mut().enumerate() {
        let g = scale_gap_q64(asset.gap_factor_q64(j), mult_wad);
        let covered = u64::try_from(c.checked_mul(g).ok_or(CoreError::Math)? >> 64).map_err(|_| CoreError::Math)?;
        let mut loss = x.debt.saturating_sub(covered).min(x.max_payout);
        if let Some(s) = &shield {
            let gs = g.saturating_sub(s.shift_q64);
            let cs = (s.covered as u128).checked_mul(gs).ok_or(CoreError::Math)? >> 64;
            let cs = u64::try_from(cs).map_err(|_| CoreError::Math)?;
            loss = loss.max(x.debt.saturating_sub(cs).min(x.max_payout).min(s.alpha_cap));
        }
        *slot = loss;
        worst = worst.max(loss);
    }
    Ok(worst)
}

/// The debt a policy's capacity is reserved on: `D × (1 + debt_growth_cap)`, rounded UP (`risk-core::priced_debt`,
/// task 1.2): the snapshot plus the most interest the shield and settlement will count.
pub fn reserved_debt(debt: u64, cfg: &Config) -> Result<u64> {
    credence_risk_core::priced_debt(debt, cfg.debt_growth_cap_wad).map_err(|_| error!(CoreError::Math))
}

/// The debt a policy's premium is priced on: `D × (1 + debt_growth_est)`, rounded UP: the expected interest to the
/// open, where [`reserved_debt`] is the most (task 1.2).
pub fn priced_debt(debt: u64, cfg: &Config) -> Result<u64> {
    credence_risk_core::priced_debt(debt, cfg.debt_growth_est_wad).map_err(|_| error!(CoreError::Math))
}

/// The policy's snapshot debt with klend's interest since purchase (`risk-core::accrued_debt`), from the borrow
/// reserve's cumulative borrow-rate index now (the caller's transaction refreshed it): never below `p.debt`, never above
/// `p.debt × (1 + p.debt_growth_cap_wad)`, rounded DOWN. Only interest counts, never new borrowing.
pub fn accrued_debt(p: &crate::state::Policy, index_now: u128) -> Result<u64> {
    credence_risk_core::accrued_debt(p.debt, p.borrow_index_bsf, index_now, p.debt_growth_cap_wad)
        .map_err(|_| error!(CoreError::Math))
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

impl ShieldParams {
    pub fn from_config(c: &Config) -> Self {
        Self { alpha_wad: c.shield_alpha_wad, buffer_wad: c.shield_buffer_wad, health_wad: c.shield_health_wad }
    }
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

// ---- W4: multi-collateral (one policy, several xStock legs and stablecoin collateral, one stablecoin debt) ----

/// A multi-collateral policy's inputs, debt units.
#[derive(Clone, Copy, Debug)]
pub struct MultiInputs<'a> {
    /// C′_i per leg, rounded DOWN.
    pub legs: &'a [u64],
    /// S′ (stablecoins at their LT), rounded DOWN.
    pub stable: u64,
    pub debt: u64,
    pub max_payout: u64,
}

/// [`policy_losses`] for several legs: per joint scenario j,
/// `max(min(cap, D − Σ_i ⌊C′_i·g_{i,j}⌋ − S′), min(⌊α·cap⌋, cap, D − Σ_i ⌊C″_i·max(0, g_{i,j} − k·σ_b,i)⌋ − S″))`
/// with `C″_i = ⌊C′_i(1 − b)/(1 + h)⌋` and `S″ = ⌊S′/(1 + h)⌋` (stablecoins do not move: no buffer). Q64.64 factors,
/// covered values DOWN, shifts UP: every loss rounds UP (golden-tested against `risk-core::loss_multi`). With one leg and
/// no stablecoin it is [`policy_losses`]. `assets[i]` is leg i's asset (its gap factors and σ_b).
pub fn policy_losses_multi(assets: &[&AssetConfig], cfg: &Config, x: &MultiInputs, out: &mut [u64]) -> Result<u64> {
    require!(out.len() == K && assets.len() == x.legs.len() && !assets.is_empty(), CoreError::Math);
    let shield = cfg.shield_alpha_wad > 0;
    let w = WAD;
    let (b, h) = (cfg.shield_buffer_wad as u128, cfg.shield_health_wad as u128);
    require!(b < w, CoreError::InvalidParam);
    let mut c2 = [0u64; MAX_LEGS];
    let mut shift = [0u128; MAX_LEGS];
    require!(assets.len() <= MAX_LEGS, CoreError::InvalidParam);
    for (i, a) in assets.iter().enumerate() {
        c2[i] = u64::try_from((x.legs[i] as u128).checked_mul(w - b).ok_or(CoreError::Math)? / (w + h)).map_err(|_| CoreError::Math)?;
        let sw = reserve_shift(cfg.shield_reserve_k_wad, a.basis_sigma_wad).map_err(|_| error!(CoreError::Math))?;
        shift[i] = ((sw as u128) << 64).div_ceil(w);
    }
    let s2 = u64::try_from((x.stable as u128) * w / (w + h)).map_err(|_| CoreError::Math)?;
    let alpha_cap = u64::try_from((x.max_payout as u128) * (cfg.shield_alpha_wad as u128) / w).map_err(|_| CoreError::Math)?;
    let mut worst = 0u64;
    for (j, slot) in out.iter_mut().enumerate() {
        let (mut cov, mut cov_s) = (x.stable as u128, s2 as u128);
        for (i, a) in assets.iter().enumerate() {
            let g = a.gap_factor_q64(j);
            cov += (x.legs[i] as u128).checked_mul(g).ok_or(CoreError::Math)? >> 64;
            if shield {
                cov_s += (c2[i] as u128).checked_mul(g.saturating_sub(shift[i])).ok_or(CoreError::Math)? >> 64;
            }
        }
        let mut loss = (x.debt as u128).saturating_sub(cov).min(x.max_payout as u128) as u64;
        if shield {
            loss = loss.max((x.debt as u128).saturating_sub(cov_s).min(x.max_payout as u128).min(alpha_cap as u128) as u64);
        }
        *slot = loss;
        worst = worst.max(loss);
    }
    Ok(worst)
}

/// The settlement-only loss per joint scenario (no shield term), for the joint premium. Rounded UP as above.
pub fn settlement_losses_multi(assets: &[&AssetConfig], x: &MultiInputs, out: &mut [u64]) -> Result<()> {
    require!(out.len() == K && assets.len() == x.legs.len(), CoreError::Math);
    for (j, slot) in out.iter_mut().enumerate() {
        let mut cov = x.stable as u128;
        for (i, a) in assets.iter().enumerate() {
            cov += (x.legs[i] as u128).checked_mul(a.gap_factor_q64(j)).ok_or(CoreError::Math)? >> 64;
        }
        *slot = (x.debt as u128).saturating_sub(cov).min(x.max_payout as u128) as u64;
    }
    Ok(())
}

/// One leg for the premium: its scenario set, σ, dividend, σ_b.
pub struct LegPricing<'a> {
    pub z: &'a [i16],
    pub sigma_wad: u64,
    pub dividend_wad: u64,
    pub basis_sigma_wad: u64,
}

/// Non-overnight closures the joint set's K scenarios were drawn from (2016-04-25 → 2026-09-21; plan/09 task 3.4).
pub const JOINT_N_ALL: u32 = 564;

/// The premium of a multi-collateral policy, USDC base units, rounded UP (task B1; `risk-core::multi` docs):
/// `max(joint, max_i marginal_i) + Σ_i shield loading_i`.
/// - joint: `risk-core::quote_joint` over the policy's settlement losses in the K joint scenarios (`settle_losses`),
///   each closure weighted 1/564;
/// - marginal_i: [`premium`] of leg i alone on its 3,000-point set, the other legs and the stablecoins flat
///   (`risk-core::marginal_debt`);
/// - shield loading: [`shield_loading`] of each leg alone, summed (each leg's buffer adds its own overshoot), each capped
///   at the policy's reservation `worst_loss`.
pub fn premium_multi(
    legs: &[LegPricing],
    cfg: &Config,
    closure_days: u16,
    util_after_wad: u64,
    x: &MultiInputs,
    settle_losses: &[u64],
    worst_loss: u64,
) -> Result<(u64, u64)> {
    require!(legs.len() == x.legs.len() && !legs.is_empty(), CoreError::InvalidParam);
    let jp = credence_risk_core::JointPremiumParams {
        n_all: JOINT_N_ALL,
        closure_days,
        util_after: U256::from(util_after_wad),
        theta: U256::from(cfg.theta_wad),
        cost_of_cap: U256::from(cfg.cost_of_cap_wad),
        eta: U256::from(cfg.eta_wad),
        beta: U256::from(cfg.beta_wad),
        min_premium: U256::from(cfg.min_premium),
    };
    let joint: u64 = credence_risk_core::quote_joint(settle_losses, &jp)
        .map_err(|_| error!(CoreError::Math))?
        .try_into()
        .map_err(|_| error!(CoreError::Math))?;
    let mut best = joint;
    let mut loading = 0u64;
    for (i, l) in legs.iter().enumerate() {
        let d_i = credence_risk_core::marginal_debt(x.debt, x.legs, i, x.stable).map_err(|_| error!(CoreError::Math))?;
        let xi = CoverInputs { covered_value: x.legs[i], debt: d_i, max_payout: x.max_payout };
        best = best.max(premium(l.z, cfg, l.sigma_wad, l.dividend_wad, closure_days, util_after_wad, &xi)?);
        loading = loading.checked_add(shield_loading(l.z, cfg, l.sigma_wad, l.basis_sigma_wad, &xi, worst_loss)?).ok_or(CoreError::Math)?;
    }
    Ok((best.checked_add(loading).ok_or(CoreError::Math)?, loading))
}

/// One leg at settlement or for the shield: covered value and its close and settlement (or fair) price per raw unit.
#[derive(Clone, Copy, Debug)]
pub struct LegPrice {
    pub covered: u64,
    pub close_wad: u128,
    pub price_wad: u128,
}

/// The multi-leg payout: `min(cap, max(0, D − Σ ⌊C′_i·g_i⌋ − S′))` with `g_i` from `settle_i / close_i` (ratio UP, as
/// [`realized_payout`]). A leg whose epoch never got a price (voided) passes `price = close` (flat). With one leg and
/// `S′ = 0` it is [`realized_payout`].
pub fn realized_payout_multi(legs: &[LegPrice], stable: u64, debt: u64, cap: u64) -> Result<u64> {
    let w = U256::from(WAD);
    let mut covered = U256::from(stable);
    for l in legs {
        require!(l.close_wad > 0 && l.price_wad > 0, CoreError::BadPrice);
        let ratio = (U256::from(l.price_wad) * w).div_ceil(U256::from(l.close_wad));
        let (mv, down) = if ratio >= w { (ratio - w, false) } else { (w - ratio, true) };
        let g = gap_factor_at(mv, down, U256::ZERO, U256::ZERO).map_err(|_| error!(CoreError::Math))?;
        covered += mul_wad_down(U256::from(l.covered), g).map_err(|_| error!(CoreError::Math))?;
    }
    let loss = U256::from(debt).saturating_sub(covered).min(U256::from(cap));
    u64::try_from(loss).map_err(|_| error!(CoreError::Math))
}

/// The multi-leg shield target: [`realized_payout_multi`] at each leg's fair value marked down by b (UP), covered values
/// scaled by 1/(1 + h) (UP), the stablecoins scaled by 1/(1 + h) only; capped at ⌊α × cap⌋ (as [`shield_target`]).
pub fn shield_target_multi(legs: &[LegPrice], stable: u64, debt: u64, cap: u64, p: &ShieldParams) -> Result<u64> {
    let w = U256::from(WAD);
    require!(U256::from(p.buffer_wad) < w && U256::from(p.alpha_wad) <= w, CoreError::InvalidParam);
    let mut adj = [LegPrice { covered: 0, close_wad: 1, price_wad: 1 }; MAX_LEGS];
    require!(legs.len() <= MAX_LEGS, CoreError::InvalidParam);
    for (i, l) in legs.iter().enumerate() {
        require!(l.close_wad > 0 && l.price_wad > 0, CoreError::BadPrice);
        let fair_b = u128::try_from((U256::from(l.price_wad) * (w - U256::from(p.buffer_wad))).div_ceil(w)).map_err(|_| error!(CoreError::Math))?.max(1);
        let cov_h = u64::try_from((U256::from(l.covered) * w).div_ceil(w + U256::from(p.health_wad))).map_err(|_| error!(CoreError::Math))?;
        adj[i] = LegPrice { covered: cov_h, close_wad: l.close_wad, price_wad: fair_b };
    }
    let stable_h = u64::try_from((U256::from(stable) * w).div_ceil(w + U256::from(p.health_wad))).map_err(|_| error!(CoreError::Math))?;
    let need = realized_payout_multi(&adj[..legs.len()], stable_h, debt, cap)?;
    let alpha_cap = u64::try_from(U256::from(cap) * U256::from(p.alpha_wad) / w).map_err(|_| error!(CoreError::Math))?;
    Ok(need.min(alpha_cap))
}

// ---------------------------------------------------------------------------------------------------------------
// Side UP (W11, task B3): a short position, an xStock borrowed against stablecoins. `covered_value` is C′ (the
// stablecoins at the threshold), `debt` D (the xStock debt's value at the close, × its borrow factor).
// ---------------------------------------------------------------------------------------------------------------

/// UP loss per joint scenario: `min(cap, max(0, ⌈D × g_j⌉ − C′))` with the weekend gap factors scaled by `mult_wad`
/// (as `policy_losses_scaled`), g rounded UP (one Q64 unit), the loss UP. No shield on the up side.
pub fn policy_losses_up(asset: &AssetConfig, x: &CoverInputs, mult_wad: u64, out: &mut [u64]) -> Result<u64> {
    require!(out.len() == K, CoreError::Math);
    let d = x.debt as u128;
    let mut worst = 0u64;
    for (j, slot) in out.iter_mut().enumerate() {
        let g = scale_gap_q64(asset.gap_factor_q64(j), mult_wad).saturating_add(1);
        let dg = u64::try_from(d.checked_mul(g).ok_or(CoreError::Math)?.div_ceil(1u128 << 64)).map_err(|_| CoreError::Math)?;
        let loss = dg.saturating_sub(x.covered_value).min(x.max_payout);
        *slot = loss;
        worst = worst.max(loss);
    }
    Ok(worst)
}

/// The UP premium: `risk-core::quote_cover_up` over the closure's set (capped at `max_payout`).
pub fn premium_up(z: &[i16], cfg: &Config, sigma_wad: u64, dividend_wad: u64, closure_days: u16, util_after_wad: u64, x: &CoverInputs) -> Result<u64> {
    let params = PremiumParams {
        sigma: U256::from(sigma_wad),
        dividend: U256::from(dividend_wad),
        kappa: U256::ZERO,
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
    let q = credence_risk_core::up::quote_cover_up(&SliceZ(z), &params, U256::from(x.max_payout)).map_err(|_| error!(CoreError::Math))?;
    q.premium.try_into().map_err(|_| error!(CoreError::Math))
}

/// UP payout at settlement: `min(cap, max(0, ⌈D × (settle / close)⌉ − C′))`, the ratio rounded DOWN (a smaller payout:
/// the rounding the premium priced is the other way). INV-1: never above `cap`.
pub fn realized_payout_up(covered_value: u64, debt: u64, cap: u64, close_wad: u128, settle_wad: u128) -> Result<u64> {
    require!(close_wad > 0 && settle_wad > 0, CoreError::BadPrice);
    let w = U256::from(WAD);
    let g = U256::from(settle_wad) * w / U256::from(close_wad);
    let loss = credence_risk_core::up::loss_up(U256::from(debt), U256::from(covered_value), U256::from(cap), g).map_err(|_| error!(CoreError::Math))?;
    u64::try_from(loss).map_err(|_| error!(CoreError::Math))
}
