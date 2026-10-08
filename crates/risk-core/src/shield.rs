//! Liquidation Shield loading (Credence Solana, W1): what the vault expects to lose by advancing on the weekend fair
//! value instead of waiting for the open.
//!
//! The shield repays `A = min(α·cap, min(cap, max(0, D − C″·(1 + f))))` into the position on Sunday night, where
//! `f` is the weekend fair-value move and `C″ = C′·(1 − b)/(1 + h)` folds in the buffer `b` and the target health
//! `1 + h`. At the open the policy owes `P = min(cap, max(0, D − C′·(1 + r)))`; settlement pays `max(0, P − A)` and the
//! vault keeps `max(0, A − P)` as its loss. With the open move `r` from the scenario set (`r = σ·z/1000`) and the basis
//! `e = f − r ~ N(0, σ_b)`:
//!
//! `E[max(0, A − P)] ≈ (1/N) Σ_k Σ_i w_i · max(0, A(r_k + e_i) − P(r_k))`,
//!
//! with 3-point Gauss–Hermite nodes `e_i ∈ {−√3, 0, +√3}·σ_b`, weights `{1/6, 2/3, 1/6}` (exact for polynomials up to
//! degree 5; the payoff is piecewise linear, so this is an estimate, priced with a loading λ). The basis node is
//! applied as a shift of the scenario's `z` by `δ = node·σ_b/σ·1000`, so `A` is [`scenario_loss_u64`] at `z_k + δ`
//! with collateral `C″`: native u64 arithmetic, no 128-bit division (slow on SBF).
//!
//! The expectation runs over a bounded sample of the set: all of it for a set of at most [`MAX_POINTS`], else M =
//! [`MAX_POINTS`] buckets `[⌊jN/M⌋, ⌊(j+1)N/M⌋)`, the lowest one read in full (the extreme tail, audit A-24) and every
//! other one represented by its midpoint `⌊(2j + 1)·N / 2M⌋`, weighted by the bucket's size (a 3,000-point set → 266
//! points). The loss is non-zero over a wide band of
//! z for a position near its threshold (the buffer makes the advance exceed the payout wherever both are positive), so
//! a full pass would cost about 1.2M CU on SBF; 256 points bound it near 100k. The cover premium itself still uses the
//! full set. `A` is non-increasing in `z`, so once the most negative node's advance is 0 every later point's is too,
//! and the loop stops. Rounding is against the buyer: `C″` rounds DOWN and the negative shift rounds away from zero
//! (both a larger advance), the expectation and `λ·E` round UP.

use crate::fixed::{ceil_div, mul_wad_up, MathError, MathResult, WAD};
use crate::premium::scenario_loss_u64;
use crate::scenarios::ZSource;
use alloy_primitives::U256;

/// Points of the scenario set the loading reads at most (midpoint quantiles beyond it).
pub const MAX_POINTS: u32 = 256;

/// √3 × 1e9 (the outer Gauss–Hermite node for a standard normal), rounded UP.
const SQRT3_E9: u64 = 1_732_050_808;
const E9: u64 = 1_000_000_000;

/// Inputs of the shield loading. WAD for σ, σ_b, α, b, h, λ; USDC base units for amounts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShieldLoadingParams {
    /// σ of the closure (the scenario set's scale).
    pub sigma: u64,
    /// σ_b, the standard deviation of `fair − open` as a return (basis study).
    pub basis_sigma: u64,
    /// C′ = LT × collateral value.
    pub covered: u64,
    /// D.
    pub debt: u64,
    /// Policy cap.
    pub cap: u64,
    /// α: the advance never exceeds `α·cap`.
    pub alpha: u64,
    /// b: fair-value buffer.
    pub buffer: u64,
    /// h: target health above 1.
    pub health: u64,
    /// λ: loading on the expected loss.
    pub lambda: u64,
}

/// Scenario points visited and the result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShieldLoading {
    /// `E[max(0, A − P)]`, USDC base units, rounded UP.
    pub expected_loss: u64,
    /// `λ·E`, USDC base units, rounded UP.
    pub loading: u64,
    /// Points read before the advance reached 0 at every node.
    pub visited: u32,
}

/// `⌊C′·(1 − b)/(1 + h)⌋`, rounded DOWN (a larger advance: conservative). One U256 division per quote.
fn covered_for_advance(p: &ShieldLoadingParams) -> MathResult<u64> {
    if p.buffer >= WAD.to::<u64>() {
        return Err(MathError::InvalidInput);
    }
    let f = U256::from(p.covered) * (WAD - U256::from(p.buffer)) / (WAD + U256::from(p.health));
    u64::try_from(f).map_err(|_| MathError::Overflow)
}

/// z-units shift for a basis node of `k·σ_b` with `k = SQRT3_E9 / 1e9`: `⌈k·σ_b·1000/σ⌉` (rounded away from zero, so
/// the negative node's advance is larger: conservative). Saturates at the i16 range.
fn node_shift(basis_sigma: u64, sigma: u64) -> MathResult<i32> {
    if sigma == 0 {
        return Err(MathError::InvalidInput);
    }
    let num = U256::from(SQRT3_E9) * U256::from(basis_sigma) * U256::from(1000u16);
    let s = ceil_div(num, U256::from(sigma) * U256::from(E9))?;
    Ok(if s > U256::from(65_536u32) { 65_536 } else { s.to::<i32>() })
}

fn shifted(z: i16, d: i32) -> i16 {
    (z as i32 + d).clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

/// The expected shield loss and its loading (module docs). `set` ascending, as every scenario set is.
pub fn shield_loading<S: ZSource + ?Sized>(set: &S, p: &ShieldLoadingParams) -> MathResult<ShieldLoading> {
    let n = set.len();
    if n == 0 {
        return Err(MathError::EmptySet);
    }
    if p.alpha > WAD.to::<u64>() {
        return Err(MathError::InvalidInput);
    }
    let zero = ShieldLoading { expected_loss: 0, loading: 0, visited: 0 };
    let alpha_cap = u64::try_from(U256::from(p.cap) * U256::from(p.alpha) / WAD).map_err(|_| MathError::Overflow)?;
    if alpha_cap == 0 {
        return Ok(zero);
    }
    let c2 = covered_for_advance(p)?;
    let d = node_shift(p.basis_sigma, p.sigma)?;
    let adv = |z: i16| -> MathResult<u64> {
        let l = scenario_loss_u64(z, p.sigma, 0, c2, p.debt).ok_or(MathError::Overflow)?;
        Ok(l.min(p.cap).min(alpha_cap))
    };
    let pay = |z: i16| -> MathResult<u64> {
        Ok(scenario_loss_u64(z, p.sigma, 0, p.covered, p.debt).ok_or(MathError::Overflow)?.min(p.cap))
    };
    // (index, weight) of each point read, ascending: the whole lowest bucket, then one midpoint per bucket weighted by
    // its size; Σ weights = N. For a set of at most MAX_POINTS, every point with weight 1.
    let big = n > MAX_POINTS;
    let first = if big { n / MAX_POINTS } else { 0 }; // lowest bucket [0, first)
    let count = if big { first + MAX_POINTS - 1 } else { n };
    let point = |i: u32| -> (u32, u64) {
        if !big {
            return (i, 1);
        }
        if i < first {
            return (i, 1);
        }
        let j = (i - first + 1) as u64; // buckets 1..M
        let (m, nn) = (MAX_POINTS as u64, n as u64);
        let (lo, hi) = (j * nn / m, (j + 1) * nn / m);
        (((2 * j + 1) * nn / (2 * m)) as u32, hi - lo)
    };
    // Σ_k weight_k · (1·L₋ + 4·L₀ + 1·L₊), i.e. 6 × the weighted sum.
    let mut sum6 = 0u128;
    let mut i = 0u32;
    while i < count {
        let (k, weight) = point(i);
        let z = set.z(k);
        let a_lo = adv(shifted(z, -d))?;
        if a_lo == 0 {
            break; // the most negative node's advance is 0 here and at every later (larger) z
        }
        let p_k = pay(z)?;
        let a_mid = adv(z)?;
        let a_hi = adv(shifted(z, d))?;
        let l = |a: u64| a.saturating_sub(p_k) as u128;
        let weighted = (l(a_lo) + 4 * l(a_mid) + l(a_hi)).checked_mul(weight as u128).ok_or(MathError::Overflow)?;
        sum6 = sum6.checked_add(weighted).ok_or(MathError::Overflow)?;
        i += 1;
    }
    let e = ceil_div(U256::from(sum6), U256::from(6u32) * U256::from(n))?;
    let loading = mul_wad_up(U256::from(p.lambda), e)?;
    Ok(ShieldLoading {
        expected_loss: u64::try_from(e).map_err(|_| MathError::Overflow)?,
        loading: u64::try_from(loading).map_err(|_| MathError::Overflow)?,
        visited: i,
    })
}
