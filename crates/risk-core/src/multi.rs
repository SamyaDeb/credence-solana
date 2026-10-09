//! Multi-collateral cover (Credence Solana, W4): one policy on an obligation whose deposits are several xStocks and
//! stablecoins, against one stablecoin debt.
//!
//! Payout rule (plan/02 §2, generalised): with `C′_i = LT_i × C_i` per xStock leg, `g_i = 1 + r_i` its gap factor and
//! `S′ = Σ LT_s × S` the stablecoin collateral (it does not move),
//!
//! `repay_needed = min(cap, max(0, D − Σ_i ⌊C′_i × g_i⌋ − S′))`
//!
//! Each covered value rounds DOWN, so the loss rounds UP (as the single-asset rule). With one leg and `S′ = 0` this is
//! exactly `scenario_loss` / `realized_payout`.
//!
//! Premium (task B1):
//! - **Joint.** Over the K joint stress closures with each asset's own column: every one of them is weighted 1/`n_all`,
//!   where `n_all` (564) is the number of non-overnight closures the joint set was drawn from; the closures outside it
//!   are basket-up weekends and count as no loss. The ADR-0204 synthetic closures inside the set get the same weight,
//!   which overweights them (their return periods are 26.7 and 40 years): conservative. Expected loss E and the ES at
//!   β over the `n_all` closures, then F-4.3 as `quote_cover`.
//! - **Marginal.** For each leg, the single-asset quote on its own 3,000-point set (t₃ floor) with the other legs flat
//!   (their covered value moved into the debt side): what an idiosyncratic gap of that asset alone costs. The joint set
//!   cannot see it (it ranks closures by the basket).
//! - **Premium = max(joint, max_i marginal_i)**: each term is a lower bound of what the policy is worth, so their
//!   maximum is too. `quote_cover_capped` gives the marginals; [`quote_joint`] the joint one.

use crate::fixed::{ceil_div, mul_div_up, mul_wad_down, mul_wad_up, MathError, MathResult, WAD};
use crate::safe_ltv::gap_factor;
use alloy_primitives::U256;

/// One xStock leg of a multi-collateral position.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Leg {
    /// C′_i = LT_i × collateral value, loan units.
    pub covered: u64,
    /// The leg's gap factor `1 + r_i` (or the scenario's), WAD.
    pub g: U256,
}

/// `min(cap, max(0, D − Σ ⌊C′_i·g_i⌋ − S′))`, loan units, rounded UP (each covered value DOWN).
pub fn loss_multi(debt: u64, cap: u64, legs: &[Leg], stable: u64) -> MathResult<u64> {
    let mut covered = U256::from(stable);
    for l in legs {
        covered = covered.checked_add(mul_wad_down(U256::from(l.covered), l.g)?).ok_or(MathError::Overflow)?;
    }
    let loss = U256::from(debt).saturating_sub(covered).min(U256::from(cap));
    u64::try_from(loss).map_err(|_| MathError::Overflow)
}

/// The loss in joint scenario `z` (one z per leg, the legs' σ and dividends): `gap_factor` per leg, then [`loss_multi`].
pub fn joint_loss(debt: u64, cap: u64, covered: &[u64], z: &[i16], sigma: &[U256], dividend: &[U256], stable: u64) -> MathResult<u64> {
    if covered.len() != z.len() || z.len() != sigma.len() || sigma.len() != dividend.len() {
        return Err(MathError::InvalidInput);
    }
    let mut legs = [Leg { covered: 0, g: U256::ZERO }; 8];
    if covered.len() > legs.len() {
        return Err(MathError::InvalidInput);
    }
    for i in 0..covered.len() {
        legs[i] = Leg { covered: covered[i], g: gap_factor(z[i], sigma[i], dividend[i], U256::ZERO)? };
    }
    loss_multi(debt, cap, &legs[..covered.len()], stable)
}

/// Inputs of the joint premium (F-4.3 parameters as `PremiumParams`).
#[derive(Clone, Copy, Debug)]
pub struct JointPremiumParams {
    /// Closures the K joint scenarios stand for (564: the non-overnight closures 2016-04 → 2026-09).
    pub n_all: u32,
    /// τ × 365 (3 for a weekend).
    pub closure_days: u16,
    /// Utilisation after the policy, WAD.
    pub util_after: U256,
    /// θ, the loading on the expected loss, WAD.
    pub theta: U256,
    /// c, the cost of capital per year, WAD.
    pub cost_of_cap: U256,
    /// η of m(u) = 1 + η u², WAD.
    pub eta: U256,
    /// β of the expected shortfall, WAD.
    pub beta: U256,
    /// Floor premium, loan units.
    pub min_premium: U256,
}

/// The joint premium from the policy's loss in each joint scenario (`losses`, K values, any order), rounded UP:
/// `E = ⌈Σ L / n_all⌉`, `ES_β` = the mean of the worst `m = ⌈(1 − β) n_all⌉` of the `n_all` closures (the missing
/// `n_all − K` closures are 0), `π = max(min_premium, m(u)·[(1 + θ)E + c·τ·ES])` with `τ = days/365` and
/// `m(u) = 1 + η u²` (as `quote_cover`).
pub fn quote_joint(losses: &[u64], p: &JointPremiumParams) -> MathResult<U256> {
    let n = p.n_all as usize;
    if n == 0 || losses.len() > n || p.beta >= WAD {
        return Err(MathError::InvalidInput);
    }
    let mut sorted: alloc::vec::Vec<u64> = losses.to_vec();
    sorted.sort_unstable_by(|a, b| b.cmp(a)); // worst first
    let total: U256 = sorted.iter().fold(U256::ZERO, |a, x| a + U256::from(*x));
    let e = ceil_div(total, U256::from(n as u64))?;
    let m = mul_div_up(WAD - p.beta, U256::from(n as u64), WAD)?.max(U256::from(1u8)).to::<usize>();
    let worst: U256 = sorted.iter().take(m).fold(U256::ZERO, |a, x| a + U256::from(*x));
    let es = ceil_div(worst, U256::from(m as u64))?;
    let tau = mul_div_up(U256::from(p.closure_days), WAD, U256::from(365u16))?;
    let base = mul_wad_up(WAD + p.theta, e)? + mul_wad_up(mul_wad_up(p.cost_of_cap, tau)?, es)?;
    let mult = WAD + mul_wad_up(p.eta, mul_wad_up(p.util_after, p.util_after)?)?;
    Ok(mul_wad_up(mult, base)?.max(p.min_premium))
}

/// The debt a leg's marginal quote uses: `D − Σ_{k≠i} C′_k − S′` (the other legs flat), saturating at 0. The loss of the
/// single-asset quote on it, `D_i − C′_i·g`, equals [`loss_multi`] with only leg i moving.
pub fn marginal_debt(debt: u64, covered: &[u64], i: usize, stable: u64) -> MathResult<u64> {
    if i >= covered.len() {
        return Err(MathError::InvalidInput);
    }
    let others: u128 = covered.iter().enumerate().filter(|(k, _)| *k != i).map(|(_, c)| *c as u128).sum::<u128>() + stable as u128;
    Ok((debt as u128).saturating_sub(others) as u64)
}
