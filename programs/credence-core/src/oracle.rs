//! Settlement prices from Pyth `PriceUpdateV2` accounts and the xStock's Scaled UI multiplier.
//!
//! Every update is checked: owner = Pyth receiver (pro-compatible id, enforced by the account type), feed id,
//! `VerificationLevel::Full`, publish time inside the window (INV-4), price > 0 and confidence ≤ `max_conf_bps` of
//! the price. Prices are converted to WAD USD per raw xStock token unit (1e8 raw = one token at multiplier 1):
//!
//! - `EQUITY` source (plan): `Equity.US.<T>/USD` × the mint's Scaled UI multiplier effective at the publish time,
//!   cross-checked against `Crypto.<T>X/USD` within `xcheck_bps`; the equity-based value is used.
//! - `SCOPE` source: Kamino's own Scope price for the xStock ([`scope`]), the price klend liquidates on.
//! - `XSTOCK` source (fallback while the Hermes key has no equity entitlement): `Crypto.<T>X/USD` directly
//!   (Pyth already quotes it per token, multiplier included), read only from Pyth's sponsored push account for the
//!   feed ([`push_account`]). The push account holds one update at a time, so nobody can pick a favourable update out
//!   of the wider XSTOCK windows: the value is whatever Pyth pushed last.

use anchor_lang::prelude::*;
use credence_risk_core::U256;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::math::WAD;
use crate::CoreError;

/// Settlement price source per asset (`AssetConfig.settle_source`).
pub mod source {
    pub const EQUITY: u8 = 0;
    pub const XSTOCK: u8 = 1;
    /// Kamino's own oracle: the asset's Scope chain (Chainlink Data Streams and Pyth Pro, capped to a band around the
    /// last close). See [`super::scope`].
    pub const SCOPE: u8 = 2;
}

/// Kamino's Scope oracle prices, read directly (settlement source `SCOPE`).
///
/// Scope's `OraclePrices` account (`3t4JZcue…`, owner the Scope program) is what klend reads for every xStock reserve
/// of the xStocks Market. On-chain mapping (read Oct 8): each xStock chain is
/// `CappedFloored(MostRecentOf(Chainlink Data Streams, Pyth Lazer))` — SPYx 344, QQQx 347, NVDAx 332. Scope refreshes
/// about every 40 s; for SPYx and NVDAx the value only moves in the regular and pre-market sessions.
/// Settling on it means the payout uses exactly the price Kamino liquidates on. Trust: Kamino administers Scope; a
/// product that protects Kamino positions already depends on it.
pub mod scope {
    use super::*;

    pub const SCOPE_PROGRAM_ID: Pubkey = pubkey!("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ");
    /// The `OraclePrices` account klend's xStocks reserves use.
    pub const SCOPE_PRICES: Pubkey = pubkey!("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
    /// `sha256("account:OraclePrices")[..8]` (scope-sdk).
    pub const ORACLE_PRICES_DISC: [u8; 8] = [89, 128, 118, 221, 6, 72, 180, 146];
    /// Chains per account; each `DatedPrice` is price {value u64, exp u64}, last_updated_slot u64, unix_timestamp u64,
    /// generic_data [u8; 24], after the discriminator and the `oracle_mappings` pubkey.
    pub const N_CHAINS: usize = 512;
    pub const ENTRY_LEN: usize = 56;
    pub const PRICES_OFFSET: usize = 8 + 32;
    pub const ACCOUNT_LEN: usize = PRICES_OFFSET + N_CHAINS * ENTRY_LEN;

    /// One Scope entry: price in WAD USD per token (rounded DOWN) and Scope's refresh time.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct ScopePrice {
        pub price_wad: u128,
        pub unix_timestamp: i64,
    }

    /// Reads chain `chain` from Scope's `OraclePrices`. Checks the address, the owner program, the length and the
    /// discriminator; the price must be positive with an exponent of at most 18.
    pub fn read(acc: &AccountInfo, chain: u64) -> Result<ScopePrice> {
        require_keys_eq!(*acc.key, SCOPE_PRICES, CoreError::NotScopePrices);
        require_keys_eq!(*acc.owner, SCOPE_PROGRAM_ID, CoreError::NotScopePrices);
        let d = acc.try_borrow_data()?;
        decode(&d, chain)
    }

    /// Decodes one entry from raw account data (length and discriminator checked; address and owner by [`read`]).
    pub fn decode(d: &[u8], chain: u64) -> Result<ScopePrice> {
        require!(d.len() == ACCOUNT_LEN && d[..8] == ORACLE_PRICES_DISC, CoreError::NotScopePrices);
        let i = usize::try_from(chain).map_err(|_| error!(CoreError::InvalidParam))?;
        require!(i < N_CHAINS, CoreError::InvalidParam);
        let o = PRICES_OFFSET + i * ENTRY_LEN;
        let u = |a: usize| -> Result<u64> {
            Ok(u64::from_le_bytes(d[a..a + 8].try_into().map_err(|_| error!(CoreError::NotScopePrices))?))
        };
        let (value, exp, ts) = (u(o)?, u(o + 8)?, u(o + 24)?);
        require!(value > 0 && exp <= 18 && ts > 0, CoreError::BadPrice);
        let price_wad = (value as u128).checked_mul(10u128.pow((18 - exp) as u32)).ok_or(CoreError::BadPrice)?;
        Ok(ScopePrice { price_wad, unix_timestamp: i64::try_from(ts).map_err(|_| error!(CoreError::BadPrice))? })
    }
}

/// Pyth's sponsored push account for `feed_id` (shard 0): PDA `[shard_id u16 LE, feed_id]` of the pro-compatible push
/// oracle (`pyth_solana_receiver_sdk::PYTH_PUSH_ORACLE_ID`). Matches the mainnet accounts `27Tv3HxU…` (SPYX),
/// `BMcyd2UQ…` (QQQX), `VSgf6jkw…` (NVDAX).
pub fn push_account(feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[&0u16.to_le_bytes(), feed_id], &pyth_solana_receiver_sdk::PYTH_PUSH_ORACLE_ID).0
}

/// Token-2022 `ExtensionType::ScaledUiAmount`.
pub const EXT_SCALED_UI_AMOUNT: u16 = 25;
/// Base mint length, then padding to the account-type byte (Token-2022 layout).
const MINT_ACCOUNT_TYPE_OFFSET: usize = 165;

/// Pyth price (`price × 10^expo`) as WAD, rounded DOWN. `None` for price ≤ 0 or an exponent outside [−18, 0].
pub fn price_wad(price: i64, expo: i32) -> Option<u128> {
    if price <= 0 || !(-18..=0).contains(&expo) {
        return None;
    }
    (price as u128).checked_mul(10u128.pow((18 + expo) as u32))
}

/// A checked update: price in WAD and its publish time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Checked {
    pub price_wad: u128,
    pub publish_time: i64,
}

/// Checks one update against the feed, the window `[from, to]` (inclusive, Unix seconds) and the confidence bound.
pub fn check_update(u: &PriceUpdateV2, feed: &[u8; 32], from: i64, to: i64, max_conf_bps: u16) -> Result<Checked> {
    require!(u.verification_level == VerificationLevel::Full, CoreError::PriceNotVerified);
    let m = &u.price_message;
    require!(m.feed_id == *feed, CoreError::WrongFeed);
    require!(m.publish_time >= from && m.publish_time <= to, CoreError::PriceOutsideWindow);
    let p = price_wad(m.price, m.exponent).ok_or(CoreError::BadPrice)?;
    // conf / price ≤ max_conf_bps / 10_000, compared in integers.
    require!(
        (m.conf as u128) * 10_000 <= (m.price as u128) * (max_conf_bps as u128),
        CoreError::PriceConfidenceTooWide
    );
    Ok(Checked { price_wad: p, publish_time: m.publish_time })
}

/// Mean of updates with strictly increasing publish times (each update counts once), rounded DOWN. The keeper passes
/// all updates it has inside the window; equal weights approximate a time-weighted average.
pub fn average(prices: &[Checked]) -> Result<u128> {
    require!(!prices.is_empty(), CoreError::PriceOutsideWindow);
    require!(prices.windows(2).all(|w| w[0].publish_time < w[1].publish_time), CoreError::DuplicateUpdate);
    let mut sum = 0u128;
    for p in prices {
        sum = sum.checked_add(p.price_wad).ok_or(CoreError::Math)?;
    }
    Ok(sum / prices.len() as u128)
}

/// The Scaled UI multiplier of a Token-2022 mint effective at `t`, WAD. The f64 is rounded to 15 decimals (exact for
/// multipliers below 9, where f64 resolves about 2e-16) and scaled to WAD, so binary noise below 1e-15 is dropped and
/// the result is deterministic. A mint without the extension has multiplier 1.
///
/// Layout of the extension value: authority (32), multiplier f64 (8), new_multiplier_effective_timestamp i64 (8),
/// new_multiplier f64 (8). Before the timestamp the old multiplier applies, from it on the new one.
pub fn scaled_ui_multiplier_wad(mint_data: &[u8], t: i64) -> Result<u128> {
    if mint_data.len() <= MINT_ACCOUNT_TYPE_OFFSET {
        return Ok(WAD);
    }
    require!(mint_data[MINT_ACCOUNT_TYPE_OFFSET] == 1, CoreError::InvalidParam); // AccountType::Mint
    let mut o = MINT_ACCOUNT_TYPE_OFFSET + 1;
    while o + 4 <= mint_data.len() {
        let ty = u16::from_le_bytes([mint_data[o], mint_data[o + 1]]);
        let len = u16::from_le_bytes([mint_data[o + 2], mint_data[o + 3]]) as usize;
        let v = mint_data.get(o + 4..o + 4 + len).ok_or(CoreError::InvalidParam)?;
        if ty == EXT_SCALED_UI_AMOUNT {
            require!(len == 56, CoreError::InvalidParam);
            let f = |a: usize| -> Result<[u8; 8]> { v[a..a + 8].try_into().map_err(|_| error!(CoreError::InvalidParam)) };
            let old = f64::from_le_bytes(f(32)?);
            let ts = i64::from_le_bytes(f(40)?);
            let new = f64::from_le_bytes(f(48)?);
            let m = if t >= ts { new } else { old };
            require!(m.is_finite() && m > 0.0 && m < 9.0, CoreError::InvalidParam);
            return Ok(((m * 1e15).round() as u128) * 1_000);
        }
        if ty == 0 {
            break; // uninitialised TLV space
        }
        o += 4 + len;
    }
    Ok(WAD)
}

/// `price × multiplier`, both WAD, rounded DOWN. 256-bit intermediate: a WAD price above about $340 times a WAD
/// multiplier does not fit in 128 bits.
pub fn per_token(price_wad: u128, multiplier_wad: u128) -> Result<u128> {
    let x = U256::from(price_wad) * U256::from(multiplier_wad) / U256::from(WAD);
    u128::try_from(x).map_err(|_| error!(CoreError::Math))
}

/// |a − b| ≤ tolerance_bps × a / 10_000.
pub fn within_bps(a: u128, b: u128, tolerance_bps: u16) -> bool {
    a.abs_diff(b).saturating_mul(10_000) <= a.saturating_mul(tolerance_bps as u128)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn price_conversion() {
        assert_eq!(price_wad(78_152_372_482, -8), Some(781_523_724_820_000_000_000));
        assert_eq!(price_wad(1, 0), Some(WAD));
        assert_eq!(price_wad(0, -8), None);
        assert_eq!(price_wad(5, -19), None);
        assert!(within_bps(1_000, 1_010, 100));
        assert!(!within_bps(1_000, 1_011, 100));
        // SPY-sized prices × a multiplier overflow u128 without the 256-bit intermediate.
        let p = per_token(777_050_000_000_000_000_000, 1_005_714_560_286_254_000).unwrap();
        assert_eq!(p, 781_490_499_070_433_670_700);
    }
}
