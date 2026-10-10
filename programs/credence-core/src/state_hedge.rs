//! Hedging the vault (D3, testnet hedge, research): the book of one weekend's hedge and its caps. See
//! `instructions/hedge.rs` and the README section "Hedging (D3)".

use anchor_lang::prelude::*;

pub const SEED_HEDGE_CFG: &[u8] = b"hedgecfg";
pub const SEED_HEDGE: &[u8] = b"hedge";

/// Most assets one weekend's hedge book holds.
pub const MAX_HEDGE_LEGS: usize = 8;

pub mod hedge_state {
    /// The keeper declared the hedge before the bell (margin and notionals); nothing is reported yet.
    pub const OPEN: u8 = 0;
    /// The keeper reported the close (exit prices, P&L, evidence hash); waiting for the weekend to settle and the delay.
    pub const REPORTED: u8 = 1;
    /// P&L recognised in vault equity (and the USDC moved).
    pub const FINAL: u8 = 2;
    /// Voided by the guardian, or expired: no P&L recognised, ever.
    pub const VOIDED: u8 = 3;
}

/// The caps of the hedge path. Seeds `["hedgecfg"]`; the admin sets them; absent until created (no hedge without it).
#[account]
#[derive(InitSpace)]
pub struct HedgeConfig {
    /// Margin sitting on the venue ≤ this share of cover equity at the time the hedge is declared, basis points.
    pub margin_cap_bps: u16,
    /// A reported gain ≤ this share of the equity at declaration, basis points. A reported loss is capped by the margin.
    pub pnl_cap_bps: u16,
    /// Notional ≤ `max_leverage × margin`.
    pub max_leverage: u8,
    /// Seconds a report waits (challenge window) before it can settle, counted from the report and not before the
    /// group has settled.
    pub delay_secs: u32,
    /// An unfinalised book is void for good this long after the weekend's open (anyone can expire it).
    pub expiry_secs: u32,
    /// A leg's perp return over the closure may differ from the lender-oracle return by at most this, WAD.
    pub return_tol_wad: u64,
    pub bump: u8,
}
impl HedgeConfig {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
    /// Hard ceilings the admin cannot exceed: margin 10%, P&L 5%, 10x, delay between 1 hour and 7 days.
    pub const MAX_MARGIN_BPS: u16 = 1_000;
    pub const MAX_PNL_BPS: u16 = 500;
    pub const MAX_LEVERAGE: u8 = 10;
    pub const MIN_DELAY: u32 = 3_600;
    pub const MAX_DELAY: u32 = 7 * 86_400;
    pub const MAX_EXPIRY: u32 = 60 * 86_400;
    /// Return tolerance ceiling: 10%.
    pub const MAX_TOL_WAD: u64 = 100_000_000_000_000_000;
}

/// One asset of the hedge: a short of `notional` USDC at `entry_wad`, closed at `exit_wad`.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HedgeLeg {
    pub ticker: [u8; 8],
    pub notional: u64,
    pub entry_wad: u128,
    pub exit_wad: u128,
}

/// One weekend's hedge. Seeds `["hedge", group_le]`. The margin and the positions live on the venue, under the keeper's
/// key: the program sees only what the keeper reports, within the caps.
#[account]
#[derive(InitSpace)]
pub struct HedgeBook {
    pub group: u32,
    pub state: u8,
    pub bump: u8,
    pub n_legs: u8,
    pub legs: [HedgeLeg; MAX_HEDGE_LEGS],
    /// Margin posted on the venue, USDC (declared).
    pub margin: u64,
    /// Cover equity when declared: the base of the caps.
    pub equity_at_open: u64,
    pub opened_at: i64,
    /// Not before this (the latest leg's open) may the close be reported.
    pub earliest_report: i64,
    /// The group's bell (new hedges are declared before it).
    pub bell: i64,
    pub reported_at: i64,
    pub report_slot: u64,
    /// Reported net P&L after fees and funding, USDC (negative: a loss).
    pub pnl: i64,
    /// Hash of the venue's fills (evidence; the program cannot check it).
    pub evidence: [u8; 32],
    pub reporter: Pubkey,
    pub finalized_at: i64,
    /// What `finalize_hedge` actually moved: + into the vault, − out of it.
    pub settled_pnl: i64,
}
impl HedgeBook {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}
