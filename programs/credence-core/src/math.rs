//! Unit conversions between `risk-core` (WAD, U256) and on-chain storage. No risk math lives here: premiums, losses
//! and gap factors come from `credence-risk-core`. Every function documents its rounding direction.

use credence_risk_core::U256;

/// 1e18.
pub const WAD: u128 = 1_000_000_000_000_000_000;

/// WAD → Q64.64, rounded DOWN: `floor(x × 2^64 / 1e18)`.
///
/// Used for gap factors: a smaller factor means a smaller covered value and a larger loss, which is conservative for
/// the vault. Returns `None` if the result does not fit in 128 bits (x ≥ 2^64 WAD); gap factors are
/// below 2 WAD.
pub fn wad_to_q64_down(x: U256) -> Option<u128> {
    if x.bit_len() > 128 {
        return None; // `<< 64` would wrap in U256
    }
    let q = (x << 64) / U256::from(WAD);
    u128::try_from(q).ok()
}

/// Q64.64 → WAD, rounded DOWN. Test and display helper.
pub fn q64_to_wad_down(q: u128) -> U256 {
    (U256::from(q) * U256::from(WAD)) >> 64
}

/// LP shares minted for a deposit of `amount` USDC, rounded DOWN (against the depositor, INV-5).
///
/// First deposit (`supply == 0`): 1:1 (shares and USDC both have 6 decimals). Later: `⌊amount × supply / equity⌋`, at
/// NAV = equity / supply, where `equity` is the vault's book equity, never its token balance, so a direct transfer
/// to the vault cannot move the share price. `None` when the vault has shares but no equity (wiped out) or on overflow.
pub fn shares_for_deposit(amount: u64, equity: u64, supply: u64) -> Option<u64> {
    if supply == 0 {
        return Some(amount);
    }
    if equity == 0 {
        return None;
    }
    u64::try_from((amount as u128).checked_mul(supply as u128)? / equity as u128).ok()
}

/// USDC paid for redeeming `shares`, rounded DOWN (against the withdrawer, INV-5): `⌊shares × equity / supply⌋`.
pub fn usdc_for_shares(shares: u64, equity: u64, supply: u64) -> Option<u64> {
    if supply == 0 || shares > supply {
        return None;
    }
    u64::try_from((shares as u128).checked_mul(equity as u128)? / supply as u128).ok()
}

/// Equity available to back new cover: `equity − ⌈queued_withdraw_shares × equity / supply⌉`. The deduction (the
/// queued withdrawals' value at today's NAV) rounds UP, so capacity is never overstated, and new cover never relies on
/// equity that is about to leave. `None` on overflow or more queued shares than supply.
pub fn free_equity(equity: u64, queued_withdraw_shares: u64, supply: u64) -> Option<u64> {
    if queued_withdraw_shares == 0 {
        return Some(equity);
    }
    if queued_withdraw_shares > supply {
        return None;
    }
    let num = (queued_withdraw_shares as u128).checked_mul(equity as u128)?;
    let leaving = u64::try_from(num.div_ceil(supply as u128)).ok()?;
    equity.checked_sub(leaving)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// INV-5 on the share math: a deposit or redemption never lowers NAV per share (equity / supply), and raises it only
    /// by rounding dust: the actor gives up less than one share's worth (`< equity / supply`, in USDC × supply units).
    #[test]
    fn inv5_share_math_never_raises_nav_for_the_actor() {
        let mut seed = 0x9E3779B97F4A7C15u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..20_000 {
            let supply = next() % 1_000_000_000_000 + 1;
            let equity = next() % 2_000_000_000_000 + 1;
            let amount = next() % 10_000_000_000 + 1;
            // Deposit: (equity + amount) / (supply + minted) ≥ equity / supply ⇔ the depositor did not gain.
            let minted = shares_for_deposit(amount, equity, supply).unwrap();
            let lhs = (equity as u128 + amount as u128) * supply as u128;
            let rhs = equity as u128 * (supply as u128 + minted as u128);
            assert!(lhs >= rhs, "deposit raised the depositor's value");
            assert!(amount as u128 * supply as u128 - (minted as u128 * equity as u128) < (equity as u128), "more than dust");
            // Redemption: (equity − paid) / (supply − shares) ≥ equity / supply.
            let shares = next() % supply + 1;
            let paid = usdc_for_shares(shares, equity, supply).unwrap();
            if shares < supply {
                let lhs = (equity as u128 - paid as u128) * supply as u128;
                let rhs = equity as u128 * (supply as u128 - shares as u128);
                assert!(lhs >= rhs, "withdrawal took more than its share");
            }
            assert!(shares as u128 * equity as u128 - (paid as u128 * supply as u128) < (supply as u128), "more than dust");
        }
        assert_eq!(shares_for_deposit(5, 0, 0), Some(5));
        assert_eq!(shares_for_deposit(5, 0, 7), None);
        assert_eq!(usdc_for_shares(8, 100, 7), None);
    }

    #[test]
    fn free_equity_rounds_the_deduction_up() {
        assert_eq!(free_equity(1_000, 0, 0), Some(1_000));
        assert_eq!(free_equity(1_000, 1, 3), Some(666)); // 333.3… leaves → 334 deducted
        assert_eq!(free_equity(1_000, 3, 3), Some(0));
        assert_eq!(free_equity(1_000, 4, 3), None);
        assert_eq!(free_equity(999, 1, 1_000), Some(998));
    }

    #[test]
    fn q64_round_trip_never_rounds_up() {
        for x in [0u128, 1, WAD / 3, WAD / 2, WAD - 1, WAD, WAD + 7, 2 * WAD - 1] {
            let q = wad_to_q64_down(U256::from(x)).unwrap();
            let back = q64_to_wad_down(q);
            assert!(back <= U256::from(x), "x={x}");
            // Q64.64 resolution is 2^-64 ≈ 5.4e-20, finer than WAD's 1e-18: the loss is at most 1 WAD unit.
            assert!(U256::from(x) - back <= U256::from(1u8), "x={x}");
        }
        assert_eq!(wad_to_q64_down(U256::from(WAD)).unwrap(), 1u128 << 64);
    }
}
