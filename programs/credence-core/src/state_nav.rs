//! NAV-priced assets (D4, research prototype): the strike schedule of an asset the lender prices at a NAV. See
//! `instructions/nav.rs` and the README section "NAV-priced assets (D4)".

use anchor_lang::prelude::*;

pub const SEED_NAV: &[u8] = b"navsched";

/// When a NAV asset's closures start and end. Seeds `["navsched", ticker]`. Strike `k` is at `anchor_ts + k × interval_secs`
/// (a whole number of days, at most a week); the closure after strike `k` runs to strike `k + 1`. The strike is a
/// **schedule this program chooses**, not a fact about the issuer: ONyc's NAV refreshes around the clock, and the lender's
/// own oracle (Scope) is read at both ends.
#[account]
#[derive(InitSpace)]
pub struct NavSchedule {
    pub ticker: [u8; 8],
    pub anchor_ts: i64,
    pub interval_secs: u32,
    /// The guardian closed the redemption gate (the issuer gates or freezes redemptions, or the guardian suspects it):
    /// no new closure opens for the asset until the admin reopens it. Epochs already open stay as they are, or stop
    /// selling through `stop_nav_sales`.
    pub gated: u8,
    pub bump: u8,
}
impl NavSchedule {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
    pub const DAY: u32 = 86_400;
    pub const MAX_INTERVAL: u32 = 7 * Self::DAY;
}
