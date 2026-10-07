//! F-4.3: the Gap Cover premium (§9.4).
//!
//! L_k = max(0, D_proj − C × g_k) with g_k = (1 + σ z_k/1000 − d)(1 − κ). L_k is non-increasing in z, so on an
//! ascending set the losses form a prefix: only the tail words are read.

use crate::fixed::{ceil_div, mul_div_up, mul_wad_down, mul_wad_up, MathError, MathResult, WAD};
use crate::safe_ltv::gap_factor;
use crate::scenarios::ZSource;
use alloy_primitives::U256;

/// Inputs of a premium quote. All ratios WAD; amounts in loan units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PremiumParams {
    /// σ for (asset, closure type).
    pub sigma: U256,
    /// Known dividend inside the closure, fraction of price.
    pub dividend: U256,
    /// κ, liquidation cost.
    pub kappa: U256,
    /// C at V_live, loan units.
    pub collateral_value: U256,
    /// D_proj, loan units (R-08).
    pub debt_projected: U256,
    /// Closure length in days (R-07); τ = days / 365.
    pub closure_days: u16,
    /// u, pool utilisation AFTER this policy (F-4.4).
    pub util_after: U256,
    /// θ, loading.
    pub theta: U256,
    /// c, cost of capital per year.
    pub cost_of_cap: U256,
    /// η, the utilisation multiplier slope.
    pub eta: U256,
    /// β, the expected-shortfall level.
    pub beta: U256,
    /// Floor premium, loan units.
    pub min_premium: U256,
}

/// A premium quote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PremiumQuote {
    /// π, loan units, rounded UP.
    pub premium: U256,
    /// E[L], loan units, rounded UP.
    pub expected_loss: U256,
    /// ES_β, loan units, rounded UP.
    pub expected_shortfall: U256,
}

/// Loss in one scenario: max(0, D − C × g(z)), with C × g rounded down (the loss rounds UP).
pub fn scenario_loss(z: i16, p: &PremiumParams) -> MathResult<U256> {
    let g = gap_factor(z, p.sigma, p.dividend, p.kappa)?;
    Ok(p.debt_projected
        .saturating_sub(mul_wad_down(p.collateral_value, g)?))
}

/// π = max(minPremium, m(u) × [(1 + θ) E[L] + c τ ES_β]), m(u) = 1 + η u² (F-4.3).
pub fn quote_cover<S: ZSource + ?Sized>(set: &S, p: &PremiumParams) -> MathResult<PremiumQuote> {
    let n = set.len();
    if n == 0 {
        return Err(MathError::EmptySet);
    }
    if p.beta > WAD || p.kappa > WAD {
        return Err(MathError::InvalidInput);
    }
    // m = ⌈(1 − β) N⌉, at least 1
    let m = mul_div_up(WAD - p.beta, U256::from(n), WAD)?.max(U256::from(1u8));
    let m_u32: u32 = if m > U256::from(n) { n } else { m.to::<u32>() };

    let mut total = U256::ZERO;
    let mut worst_m = U256::ZERO;
    let mut i = 0u32;
    while i < n {
        let l = scenario_loss(set.z(i), p)?;
        if l.is_zero() {
            break; // monotone: every later scenario has zero loss
        }
        total = total.checked_add(l).ok_or(MathError::Overflow)?;
        if i < m_u32 {
            worst_m = worst_m.checked_add(l).ok_or(MathError::Overflow)?;
        }
        i += 1;
    }
    let expected_loss = ceil_div(total, U256::from(n))?;
    let expected_shortfall = ceil_div(worst_m, U256::from(m_u32))?;

    // τ = days / 365 in WAD (rounded up)
    let tau = mul_div_up(U256::from(p.closure_days), WAD, U256::from(365u16))?;
    let loaded = mul_wad_up(
        WAD.checked_add(p.theta).ok_or(MathError::Overflow)?,
        expected_loss,
    )?;
    let capital = mul_wad_up(mul_wad_up(p.cost_of_cap, tau)?, expected_shortfall)?;
    let base = loaded.checked_add(capital).ok_or(MathError::Overflow)?;
    let mult = WAD
        .checked_add(mul_wad_up(p.eta, mul_wad_up(p.util_after, p.util_after)?)?)
        .ok_or(MathError::Overflow)?;
    let premium = mul_wad_up(mult, base)?.max(p.min_premium);
    Ok(PremiumQuote {
        premium,
        expected_loss,
        expected_shortfall,
    })
}
