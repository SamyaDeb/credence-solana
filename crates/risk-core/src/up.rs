//! Gap Cover side `UP` (Credence Solana, W11, task B3): a short position, an xStock borrowed against stablecoins, is
//! hurt when the open gaps UP. With `D` the borrowed xStock's value at the close (klend: × its borrow factor, the debt
//! value health uses), `C′` the stablecoin collateral at the liquidation threshold (it does not move) and `g = 1 + r`:
//!
//! `repay_needed = min(cap, max(0, ⌈D × g⌉ − C′))`
//!
//! the mirror of the `DOWN` rule. D × g rounds UP (against the vault): the loss rounds up. `L` is non-decreasing in z,
//! so on an ascending scenario set the losses form a suffix: only the top words are read.

use crate::fixed::{ceil_div, mul_div_down, mul_div_up, mul_wad_up, MathError, MathResult, WAD};
use crate::premium::{PremiumParams, PremiumQuote};
use crate::scenarios::ZSource;
use alloy_primitives::U256;

const THOUSAND: U256 = U256::from_limbs([1000, 0, 0, 0]);

/// `g = max(0, 1 + σz/1000 − d)`, rounded UP (the up side's adverse direction): σ|z| up for z ≥ 0, down for z < 0.
pub fn gap_factor_up(z: i16, sigma: U256, dividend: U256) -> MathResult<U256> {
    let az = U256::from(z.unsigned_abs());
    let base = if z >= 0 {
        WAD.checked_add(mul_div_up(sigma, az, THOUSAND)?).ok_or(MathError::Overflow)?
    } else {
        WAD.saturating_sub(mul_div_down(sigma, az, THOUSAND)?)
    };
    Ok(base.saturating_sub(dividend))
}

/// The up factor `1 + r` (Q64.64) behind a stored DOWN gap factor `g = max(0, 1 + r − d) × (1 − κ)` (WAD rounded DOWN,
/// then Q64.64 rounded DOWN; `safe_ltv::gap_factor`): `g / (1 − κ) + d`, rounded UP, plus a margin that covers every
/// rounding the stored factor took (audit A-64). The up side is hurt by the move itself: a dividend does not move an
/// xStock's price (its multiplier absorbs it) and κ, a liquidation cost on the collateral, does not apply to a debt.
/// Where the DOWN factor was clamped at 0 (1 + r < d) the result is at least `d`, above the truth.
#[derive(Clone, Copy, Debug)]
pub struct UpFactor {
    d_q64: u128,
    one_minus_kappa: u128,
    margin: u128,
}

impl UpFactor {
    /// The transform for the dividend and κ the gap factors were computed with (`gf_dividend_wad`, `gf_kappa_wad`).
    pub fn new(dividend_wad: u128, kappa_wad: u128) -> MathResult<Self> {
        let w = WAD.to::<u128>();
        if kappa_wad >= w || dividend_wad > w {
            return Err(MathError::InvalidInput);
        }
        let q = 1u128 << 64;
        let d_q64 = (dividend_wad * q).div_ceil(w);
        let one_minus_kappa = w - kappa_wad;
        // One WAD unit in Q64 units (19), plus one for the Q64 floor; the floors before the division grow by 1/(1 − κ).
        let unit = q.div_ceil(w) + 1;
        let margin = (2 * unit * w).div_ceil(one_minus_kappa) + unit;
        Ok(Self { d_q64, one_minus_kappa, margin })
    }

    /// `1 + r` (Q64.64, rounded UP) for the stored gap factor `g_q64`.
    pub fn apply(&self, g_q64: u128) -> MathResult<u128> {
        let w = WAD.to::<u128>();
        let a = if self.one_minus_kappa == w {
            g_q64
        } else {
            g_q64.checked_mul(w).ok_or(MathError::Overflow)?.div_ceil(self.one_minus_kappa)
        };
        a.checked_add(self.d_q64).and_then(|x| x.checked_add(self.margin)).ok_or(MathError::Overflow)
    }
}

/// `min(cap, max(0, ⌈D × g⌉ − C′))`, loan units.
pub fn loss_up(debt_value: U256, covered: U256, cap: U256, g: U256) -> MathResult<U256> {
    Ok(mul_wad_up(debt_value, g)?.saturating_sub(covered).min(cap))
}

/// The loss in scenario `z` (`PremiumParams`: `debt_projected` = D, `collateral_value` = C′).
pub fn scenario_loss_up(z: i16, p: &PremiumParams, cap: U256) -> MathResult<U256> {
    loss_up(p.debt_projected, p.collateral_value, cap, gap_factor_up(z, p.sigma, p.dividend)?)
}

/// F-4.3 for the up side: `π = max(min_premium, m(u) × [(1 + θ) E[L] + c τ ES_β])` with the capped up losses, ES over
/// the `⌈(1 − β) N⌉` highest scenarios. Rounding as `quote_cover` (UP). κ is not used (the payout rule has no
/// liquidation cost).
pub fn quote_cover_up<S: ZSource + ?Sized>(set: &S, p: &PremiumParams, cap: U256) -> MathResult<PremiumQuote> {
    let n = set.len();
    if n == 0 {
        return Err(MathError::EmptySet);
    }
    if p.beta > WAD {
        return Err(MathError::InvalidInput);
    }
    let m = mul_div_up(WAD - p.beta, U256::from(n), WAD)?.max(U256::from(1u8));
    let m_u32: u32 = if m > U256::from(n) { n } else { m.to::<u32>() };
    let (mut total, mut worst_m) = (U256::ZERO, U256::ZERO);
    let mut k = 0u32;
    while k < n {
        let l = scenario_loss_up(set.z(n - 1 - k), p, cap)?;
        if l.is_zero() {
            break; // monotone: every lower scenario has zero loss
        }
        total = total.checked_add(l).ok_or(MathError::Overflow)?;
        if k < m_u32 {
            worst_m = worst_m.checked_add(l).ok_or(MathError::Overflow)?;
        }
        k += 1;
    }
    let expected_loss = ceil_div(total, U256::from(n))?;
    let expected_shortfall = ceil_div(worst_m, U256::from(m_u32))?;
    let tau = mul_div_up(U256::from(p.closure_days), WAD, U256::from(365u16))?;
    let loaded = mul_wad_up(WAD.checked_add(p.theta).ok_or(MathError::Overflow)?, expected_loss)?;
    let capital = mul_wad_up(mul_wad_up(p.cost_of_cap, tau)?, expected_shortfall)?;
    let base = loaded.checked_add(capital).ok_or(MathError::Overflow)?;
    let mult = WAD.checked_add(mul_wad_up(p.eta, mul_wad_up(p.util_after, p.util_after)?)?).ok_or(MathError::Overflow)?;
    Ok(PremiumQuote { premium: mul_wad_up(mult, base)?.max(p.min_premium), expected_loss, expected_shortfall })
}
