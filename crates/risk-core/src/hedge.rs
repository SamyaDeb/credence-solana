//! Hedging the vault's weekend exposure (D3, testnet hedge, research): the delta to hedge and the P&L bounds.
//!
//! The vault is hurt by gaps **down**, so the hedge is a **short** perp. Units: notional and P&L in USDC base units,
//! prices in WAD (any common scale: only ratios are used, so an index perp and an ETF token can differ in level).
//!
//! - [`loss_delta`]: per asset, the loss-weighted derivative of the group's joint-scenario loss with respect to that
//!   asset's gap factor, as a USDC notional (what a 100% price drop of the asset alone would add, linearised). Weights are
//!   each scenario's share of the total loss, so the scenarios that hurt count most. A bump of `eps` lowers one asset's
//!   gap factor at a time. Rounds DOWN (a smaller hedge; the hedge is upside only, never relied on by capacity).
//! - [`short_pnl`]: the P&L the prices imply for a short, rounded toward the **loss** side: gains round down, losses
//!   round up in magnitude. The program refuses a report that claims more than this (fees and funding only lower it).
//! - [`return_gap_wad`]: how far the perp's return over the closure is from the lender-oracle return of the same asset;
//!   the program refuses to credit a report whose legs disagree with the epoch's stored close and settlement price.

use crate::fixed::{MathError, MathResult};
use crate::multi::{loss_multi, Leg};
use crate::safe_ltv::gap_factor;
use alloy_primitives::U256;
use alloc::vec::Vec;

const W: u128 = 1_000_000_000_000_000_000;

/// One covered position of the group, in loan units: `covered[i]` is `C′_i` for asset `i` (0 if not held).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HedgePosition {
    /// Debt D.
    pub debt: u64,
    /// Payout cap.
    pub cap: u64,
    /// `C′_i = LT_i × collateral value` per asset index.
    pub covered: Vec<u64>,
    /// Stablecoin collateral `S′`.
    pub stable: u64,
}

fn group_losses(positions: &[HedgePosition], g: &[U256]) -> MathResult<u64> {
    let mut total: u64 = 0;
    for p in positions {
        if p.covered.len() != g.len() {
            return Err(MathError::InvalidInput);
        }
        let legs: Vec<Leg> = p.covered.iter().zip(g).map(|(c, gi)| Leg { covered: *c, g: *gi }).collect();
        total = total.checked_add(loss_multi(p.debt, p.cap, &legs, p.stable)?).ok_or(MathError::Overflow)?;
    }
    Ok(total)
}

/// The loss-weighted delta per asset, USDC base units, rounded down.
///
/// `z[s][i]` is asset `i`'s standardised gap in joint scenario `s` (thousandths of σ), `sigma[i]` and `dividend[i]` its
/// σ and dividend (WAD). `eps_wad` is the bump (e.g. 1%): scenario loss `L_s`, and `L_s(i)` the loss with asset `i`'s
/// gap factor lowered by `eps`; `delta_i = Σ_s (L_s / Σ L) × (L_s(i) − L_s) / eps`.
pub fn loss_delta(positions: &[HedgePosition], z: &[Vec<i16>], sigma: &[U256], dividend: &[U256], eps_wad: u64) -> MathResult<Vec<u64>> {
    let n = sigma.len();
    if eps_wad == 0 || eps_wad as u128 >= W || dividend.len() != n || z.iter().any(|row| row.len() != n) {
        return Err(MathError::InvalidInput);
    }
    let mut base: Vec<(u64, Vec<U256>)> = Vec::with_capacity(z.len());
    let mut total: u128 = 0;
    for row in z {
        let g: Vec<U256> = (0..n).map(|i| gap_factor(row[i], sigma[i], dividend[i], U256::ZERO)).collect::<MathResult<_>>()?;
        let l = group_losses(positions, &g)?;
        total += l as u128;
        base.push((l, g));
    }
    let mut out = alloc::vec![0u64; n];
    if total == 0 {
        return Ok(out);
    }
    let eps = U256::from(eps_wad);
    for (i, o) in out.iter_mut().enumerate() {
        // Σ_s L_s × (L_s(i) − L_s) / (Σ L × eps), in one division at the end so the rounding is a single floor.
        let mut acc = U256::ZERO;
        for (l, g) in &base {
            if *l == 0 && positions.iter().all(|p| p.covered[i] == 0) {
                continue;
            }
            let mut gb = g.clone();
            gb[i] = gb[i].saturating_sub(eps);
            let lb = group_losses(positions, &gb)?;
            acc += U256::from(*l) * U256::from(lb.saturating_sub(*l));
        }
        let d = acc * U256::from(W) / (U256::from(total) * eps);
        *o = u64::try_from(d).map_err(|_| MathError::Overflow)?;
    }
    Ok(out)
}

/// `⌊notional × h⌋` for a hedge fraction `h` (WAD, at most 1): the notional to short. Rounds down.
pub fn hedge_notional(delta: u64, h_wad: u64) -> MathResult<u64> {
    if h_wad as u128 > W {
        return Err(MathError::InvalidInput);
    }
    Ok(((delta as u128) * (h_wad as u128) / W) as u64)
}

/// The P&L of a short of `notional` USDC opened at `entry` and closed at `exit` (WAD, both > 0):
/// `⌊notional × (entry − exit) / entry⌋`, rounded toward the loss side (floor of the signed value).
pub fn short_pnl(notional: u64, entry: u128, exit: u128) -> MathResult<i64> {
    if entry == 0 || exit == 0 {
        return Err(MathError::InvalidInput);
    }
    let n = notional as i128;
    let diff = entry as i128 - exit as i128;
    // |n × diff| < 2^64 × 2^127 can overflow i128: widen through U256.
    let mag = U256::from(n as u128) * U256::from(diff.unsigned_abs());
    let q = mag / U256::from(entry);
    let r = mag % U256::from(entry);
    let q = u128::try_from(q).map_err(|_| MathError::Overflow)?;
    let v: i128 = if diff >= 0 { q as i128 } else { -(q as i128) - if r.is_zero() { 0 } else { 1 } };
    i64::try_from(v).map_err(|_| MathError::Overflow)
}

/// The P&L `report_hedge` accepts, nearest to `claimed`: a gain at most `implied` (the price-implied P&L) and at most `cap`; a loss at
/// most `min(margin, cap)` (all USDC base units, `cap` = the share of equity at declaration the program allows). Rounds toward the
/// loss side of every bound, so what it returns is never above what the program takes.
pub fn clamp_report(claimed: i64, implied: i64, cap: u64, margin: u64) -> i64 {
    let gain_max = implied.min(i64::try_from(cap).unwrap_or(i64::MAX));
    let loss_max = i64::try_from(margin.min(cap)).unwrap_or(i64::MAX);
    claimed.min(gain_max).max(-loss_max)
}

/// Σ of [`short_pnl`] over legs `(notional, entry, exit)`.
pub fn short_pnl_total(legs: &[(u64, u128, u128)]) -> MathResult<i64> {
    let mut t: i64 = 0;
    for (n, e, x) in legs {
        t = t.checked_add(short_pnl(*n, *e, *x)?).ok_or(MathError::Overflow)?;
    }
    Ok(t)
}

/// `|exit/entry − settle/close|` in WAD, rounded up: the perp's return over the closure against the lender-oracle
/// return of the same asset. All four prices > 0.
pub fn return_gap_wad(entry: u128, exit: u128, close: u128, settle: u128) -> MathResult<u128> {
    if entry == 0 || exit == 0 || close == 0 || settle == 0 {
        return Err(MathError::InvalidInput);
    }
    let a = (U256::from(exit) * U256::from(W)).div_ceil(U256::from(entry));
    let b = (U256::from(settle) * U256::from(W)).div_ceil(U256::from(close));
    let d = if a > b { a - b } else { b - a };
    u128::try_from(d).map_err(|_| MathError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1_000_000;

    #[test]
    fn short_pnl_signs_and_rounding() {
        let w = W;
        assert_eq!(short_pnl(1_000 * S, 100 * w, 90 * w).unwrap(), 100 * S as i64); // price −10%: +10%
        assert_eq!(short_pnl(1_000 * S, 100 * w, 110 * w).unwrap(), -(100 * S as i64));
        assert_eq!(short_pnl(1_000 * S, 100 * w, 100 * w).unwrap(), 0);
        // 1 base unit × (100−99.9999…)/100 floors to 0 for a gain and to −1 for a loss.
        assert_eq!(short_pnl(1, 3 * w, 2 * w).unwrap(), 0);
        assert_eq!(short_pnl(1, 3 * w, 4 * w).unwrap(), -1);
        assert!(short_pnl(1, 0, w).is_err() && short_pnl(1, w, 0).is_err());
    }

    #[test]
    fn clamp_report_follows_the_program_caps() {
        // gain: min(claimed, implied, cap); loss: max(claimed, -min(margin, cap)).
        assert_eq!(clamp_report(9, 5, 10, 30), 5);
        assert_eq!(clamp_report(20, 50, 10, 30), 10);
        assert_eq!(clamp_report(9, 50, 10, 30), 9);
        assert_eq!(clamp_report(-40, 5, 10, 30), -10);
        assert_eq!(clamp_report(-40, 5, 100, 30), -30);
        assert_eq!(clamp_report(-3, 5, 100, 30), -3);
        assert_eq!(clamp_report(0, 0, 0, 0), 0);
    }

    #[test]
    fn return_gap_zero_when_they_agree() {
        let w = W;
        assert_eq!(return_gap_wad(100 * w, 95 * w, 400 * w, 380 * w).unwrap(), 0);
        let d = return_gap_wad(100 * w, 90 * w, 400 * w, 380 * w).unwrap();
        assert_eq!(d, w / 20); // 0.90 vs 0.95
    }

    #[test]
    fn delta_of_one_asset_position_is_its_covered_value() {
        // One position, one asset, no stable: D = 100, C′ = 100, cap = 100. Any gap down is a loss ∝ C′ × drop,
        // so the derivative with respect to g is C′ = 100 USDC (until the cap binds).
        let p = HedgePosition { debt: 100 * S, cap: 100 * S, covered: alloc::vec![100 * S], stable: 0 };
        let sigma = [U256::from(30_000_000_000_000_000u64)]; // 3%
        let div = [U256::ZERO];
        let z: Vec<Vec<i16>> = [-3000i16, -2000, -1000, 500].iter().map(|v| alloc::vec![*v]).collect();
        let d = loss_delta(&[p], &z, &sigma, &div, (W / 100) as u64).unwrap();
        assert_eq!(d[0], 100 * S);
    }

    #[test]
    fn delta_zero_without_losses_or_exposure() {
        let p = HedgePosition { debt: 10 * S, cap: 10 * S, covered: alloc::vec![100 * S, 0], stable: 0 };
        let sigma = [U256::from(30_000_000_000_000_000u64), U256::from(30_000_000_000_000_000u64)];
        let div = [U256::ZERO, U256::ZERO];
        let z: Vec<Vec<i16>> = alloc::vec![alloc::vec![500, 500], alloc::vec![1000, -1000]];
        // Heavily over-collateralised: no scenario loses, so there is nothing to hedge.
        assert_eq!(loss_delta(&[p.clone()], &z, &sigma, &div, (W / 100) as u64).unwrap(), alloc::vec![0, 0]);
        // Asset 1 is not held: its delta is 0 even when losses exist.
        let p2 = HedgePosition { debt: 100 * S, cap: 100 * S, covered: alloc::vec![100 * S, 0], stable: 0 };
        let z2: Vec<Vec<i16>> = alloc::vec![alloc::vec![-2000, -2000]];
        let d = loss_delta(&[p2], &z2, &sigma, &div, (W / 100) as u64).unwrap();
        assert!(d[0] > 0 && d[1] == 0);
    }

    #[test]
    fn hedge_notional_rounds_down_and_bounds_h() {
        assert_eq!(hedge_notional(1001, (W / 2) as u64).unwrap(), 500);
        assert!(hedge_notional(1, (W + 1) as u64).is_err());
    }
}
