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
    quote_cover_capped(set, p, U256::MAX)
}

/// F-4.3 for a capped payout: the loss in scenario k is `min(cap, L_k)`. `cap = U256::MAX` is `quote_cover`.
///
/// `min(cap, L)` is non-increasing in z like L, so the losses still form a prefix of an ascending set. Rounding as in
/// `quote_cover` (E[L], ES and every product rounded UP). Per-scenario losses use [`scenario_loss_u128`] when it fits,
/// which returns exactly `scenario_loss`; the aggregate is identical either way.
pub fn quote_cover_capped<S: ZSource + ?Sized>(set: &S, p: &PremiumParams, cap: U256) -> MathResult<PremiumQuote> {
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

    let (total, worst_m) = match FastLoss::new(p).and_then(|f| f.sums(set, cap, m_u32)) {
        Some((t, w)) => (U256::from(t), U256::from(w)),
        None => slow_sums(set, p, cap, m_u32)?,
    };
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

/// Σ min(cap, L_k) over the loss prefix and over its first `m` entries, in U256 (reference path).
fn slow_sums<S: ZSource + ?Sized>(set: &S, p: &PremiumParams, cap: U256, m: u32) -> MathResult<(U256, U256)> {
    let mut total = U256::ZERO;
    let mut worst_m = U256::ZERO;
    let mut i = 0u32;
    while i < set.len() {
        let l = scenario_loss(set.z(i), p)?.min(cap);
        if l.is_zero() {
            break; // monotone: every later scenario has zero loss
        }
        total = total.checked_add(l).ok_or(MathError::Overflow)?;
        if i < m {
            worst_m = worst_m.checked_add(l).ok_or(MathError::Overflow)?;
        }
        i += 1;
    }
    Ok((total, worst_m))
}

const E9: u64 = 1_000_000_000;
const E18: u64 = 1_000_000_000_000_000_000;

/// ⌊a·b / 1e18⌋ and whether the division was inexact, with native u64 operations only (no 128-bit division, which is
/// a slow software routine on SBF). Exact: a·b = (q + x)·1e18 + inner with 10⁹ limbs. `None` on overflow.
#[inline]
fn mul_div_e18_u64(a: u64, b: u64) -> Option<(u64, bool)> {
    let (a1, a0, b1, b0) = (a / E9, a % E9, b / E9, b % E9);
    let q = a1.checked_mul(b1)?;
    let hi = a1.checked_mul(b0)?;
    let lo = a0.checked_mul(b1)?;
    let x = (hi / E9).checked_add(lo / E9)?;
    let inner = (hi % E9 + lo % E9) * E9 + a0 * b0; // < 3e18
    let floor = q.checked_add(x)?.checked_add(inner / E18)?;
    Some((floor, inner % E18 != 0))
}

/// ⌊σ·|z| / 1000⌋ and whether it was inexact, in u64.
#[inline]
fn mul_div_1000_u64(sigma: u64, az: u64) -> Option<(u64, bool)> {
    let r = (sigma % 1000) * az; // < 1000 · 32768
    let q = (sigma / 1000).checked_mul(az)?.checked_add(r / 1000)?;
    Some((q, r % 1000 != 0))
}

const WAD_U128: u128 = 1_000_000_000_000_000_000;

/// `scenario_loss` inputs narrowed to u128 (constructed only if every input fits).
#[derive(Clone, Copy, Debug)]
pub struct FastLoss {
    sigma: u128,
    dividend: u128,
    one_minus_kappa: u128,
    collateral: u128,
    debt: u128,
    /// The same inputs in u64 when κ = 0 and each fits (the common on-chain case).
    small: Option<(u64, u64, u64, u64)>,
}

impl FastLoss {
    /// `None` if an input does not fit in 128 bits or κ > 1 (the U256 path then reports the error).
    pub fn new(p: &PremiumParams) -> Option<Self> {
        if p.kappa > WAD {
            return None;
        }
        let small = if p.kappa.is_zero() {
            (|| {
                Some((
                    p.sigma.try_into().ok()?,
                    p.dividend.try_into().ok()?,
                    p.collateral_value.try_into().ok()?,
                    p.debt_projected.try_into().ok()?,
                ))
            })()
        } else {
            None
        };
        Some(Self {
            sigma: p.sigma.try_into().ok()?,
            dividend: p.dividend.try_into().ok()?,
            one_minus_kappa: (WAD - p.kappa).try_into().ok()?,
            collateral: p.collateral_value.try_into().ok()?,
            debt: p.debt_projected.try_into().ok()?,
            small,
        })
    }

    /// `scenario_loss` exactly, or `None` if this path cannot represent it: [`scenario_loss_u64`] when κ = 0,
    /// else [`scenario_loss_u128`].
    pub fn loss(&self, z: i16) -> Option<u128> {
        match self.small {
            Some((sigma, d, c, debt)) => scenario_loss_u64(z, sigma, d, c, debt).map(u128::from),
            None => scenario_loss_u128(z, self),
        }
    }

    /// Σ min(cap, L_k) over the loss prefix and its first `m` entries, in u128. `None` if any step does not fit; the
    /// caller then recomputes in U256.
    fn sums<S: ZSource + ?Sized>(&self, set: &S, cap: U256, m: u32) -> Option<(u128, u128)> {
        let cap: u128 = cap.try_into().unwrap_or(u128::MAX);
        let (mut total, mut worst_m) = (0u128, 0u128);
        let mut i = 0u32;
        while i < set.len() {
            let l = self.loss(set.z(i))?.min(cap);
            if l == 0 {
                break;
            }
            total = total.checked_add(l)?;
            if i < m {
                worst_m = worst_m.checked_add(l)?;
            }
            i += 1;
        }
        Some((total, worst_m))
    }
}

/// `scenario_loss` for κ = 0 with native u64 operations. Same floors and ceilings on the same integers:
/// g = max(0, 1 + σz/1000 − d) (σ|z|/1000 rounded UP for z < 0, DOWN for z ≥ 0), covered = ⌊C·g⌋ written as
/// `C − ⌈C·m⌉` (g = 1 − m) or `C + ⌊C·m⌋` (g = 1 + m). `None` on overflow.
pub fn scenario_loss_u64(z: i16, sigma: u64, dividend: u64, c: u64, debt: u64) -> Option<u64> {
    let (mv, inexact) = mul_div_1000_u64(sigma, z.unsigned_abs() as u64)?;
    // Signed move net of the dividend: up = 1 + net, down = 1 − net.
    let (down, m) = if z >= 0 {
        if mv >= dividend { (false, mv - dividend) } else { (true, dividend - mv) }
    } else {
        let mv = mv + inexact as u64; // ceil for z < 0
        (true, mv.checked_add(dividend)?)
    };
    let covered = if down {
        let m = m.min(E18); // g saturates at 0
        let (f, rem) = mul_div_e18_u64(c, m)?;
        c - (f + rem as u64) // ⌈C·m⌉ ≤ C since m ≤ 1
    } else {
        c.checked_add(mul_div_e18_u64(c, m)?.0)?
    };
    Some(debt.saturating_sub(covered))
}

/// `scenario_loss` in u128: the same floors and ceilings on the same exact integers, so the result is identical
/// whenever no intermediate exceeds 128 bits; `None` on any overflow (the caller falls back to U256).
///
/// g = max(0, 1 + σ·z/1000 − d)(1 − κ) rounded DOWN (σ·|z|/1000 rounded UP for z < 0, DOWN for z ≥ 0, as `gap_factor`);
/// loss = max(0, D − ⌊C·g⌋), so the loss rounds UP.
pub fn scenario_loss_u128(z: i16, f: &FastLoss) -> Option<u128> {
    let prod = f.sigma.checked_mul(z.unsigned_abs() as u128)?;
    let base = if z >= 0 {
        WAD_U128.checked_add(prod / 1000)?
    } else {
        WAD_U128.saturating_sub(prod.div_ceil(1000))
    };
    let g = base.saturating_sub(f.dividend).checked_mul(f.one_minus_kappa)? / WAD_U128;
    let covered = f.collateral.checked_mul(g)? / WAD_U128;
    Some(f.debt.saturating_sub(covered))
}
