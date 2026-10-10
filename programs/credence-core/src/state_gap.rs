//! Gap tokens (D2, research prototype, not offered): the series account. See `instructions/gap.rs`.

use anchor_lang::prelude::*;

pub const SEED_GSERIES: &[u8] = b"gseries";
pub const SEED_GDOWN: &[u8] = b"gdown";
pub const SEED_GUP: &[u8] = b"gup";
pub const SEED_GCOLL: &[u8] = b"gcoll";

pub mod gap_state {
    /// Minting until the bell; merge at par.
    pub const OPEN: u8 = 0;
    /// Rate fixed from the epoch's stored close and settlement price (or 0.5 each if the epoch was voided).
    pub const SETTLED: u8 = 1;
    /// The epoch never settled: 0.5 each.
    pub const EXPIRED: u8 = 2;
}

pub mod gap_side {
    pub const DOWN: u8 = 0;
    pub const UP: u8 = 1;
}

/// How long after the epoch's `settle_after` an unsettled series may be expired.
pub const GAP_EXPIRY_SECS: i64 = 14 * 86_400;
/// Token decimals of both sides (USDC units).
pub const GAP_DECIMALS: u8 = 6;
/// Shown in the token metadata and on every screen.
pub const GAP_DISCLAIMER: &str = "research prototype, not offered";

/// One series per (asset, closure). Seeds `["gseries", ticker, closure_id_le]`. It owns the collateral account
/// (`["gcoll", series]`) and is the mint authority of both sides until the rate is fixed.
///
/// Accounting (token base units = USDC base units):
/// - before the rate: `sets_outstanding` = supply of each side; the collateral holds exactly that in USDC;
/// - after the rate: `sets_settled` is frozen, `pool_down = floor(sets × down_micro / 1e6)`, `pool_up = sets − pool_down`,
///   so the two pools add up to the sets exactly; each side pays out of its own pool until it is empty.
#[account]
#[derive(InitSpace)]
pub struct GapSeries {
    pub ticker: [u8; 8],
    pub closure_id: u32,
    pub closure_type: u8,
    pub state: u8,
    pub bump: u8,
    pub down_mint: Pubkey,
    pub up_mint: Pubkey,
    pub collateral: Pubkey,
    /// Band, WAD (fixed at init from the closure's σ).
    pub k_wad: u128,
    /// Minting stops here (the epoch's bell).
    pub bell: i64,
    /// An unsettled series may expire from here.
    pub expires_at: i64,
    pub sets_outstanding: u64,
    /// DOWN's and UP's share of one set, millionths; `down_micro + up_micro = 1_000_000` once the rate is fixed.
    pub down_micro: u32,
    pub up_micro: u32,
    pub close_price_wad: u128,
    pub settle_price_wad: u128,
    pub close_source: u8,
    pub settled_at: i64,
    pub sets_settled: u64,
    pub pool_down: u64,
    pub pool_up: u64,
    pub redeemed_down: u64,
    pub redeemed_up: u64,
    pub paid_down: u64,
    pub paid_up: u64,
}
impl GapSeries {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    pub fn fixed(&self) -> bool {
        self.state == gap_state::SETTLED || self.state == gap_state::EXPIRED
    }
}
