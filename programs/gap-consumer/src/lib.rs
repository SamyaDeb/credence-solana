//! A toy lender that reads Credence's `GapFeed` (C3.2). **An example of how to consume the feed, not a recommendation.**
//!
//! `refresh_limit` is permissionless: it reads one asset's `GapFeed` by account data (no CPI), checks it, and stores the
//! weekend loan-to-value limit
//!
//! ```text
//! ltv_weekend = max(floor, base_ltv × (1 − k × P(gap < −8%)))
//! ```
//!
//! in basis points. Rounding is always toward the lower LTV: the reduction is rounded up, the result down, and the floor
//! never exceeds the base. The feed is refused when it is not owned by `credence_core`, is not the PDA of the market's
//! ticker, was never updated, is older than `max_age_secs`, describes a closure that has already opened, or carries any
//! blocking flag (a missing, stale or unverified input, or the protocol paused), or is not about a WEEKEND closure.

use anchor_lang::prelude::*;
use credence_core::state::{closure, feed_flag, GapFeed, SEED_FEED};

declare_id!("HrmC5fZU5dS8NURy6fusY8nuF2mMUE6GfJk4PwCbGbtR");

pub const SEED_MARKET: &[u8] = b"market";
pub const BPS: u128 = 10_000;
const WAD: u128 = 1_000_000_000_000_000_000;

/// `base × (1 − k × P)` in basis points, floored at `floor`, rounded toward the lower LTV. `k_x100` is k × 100, `p_wad`
/// is P(gap < −8%) in WAD (the feed rounds it up). Pure, so the tests and the app can call it.
pub fn weekend_ltv_bps(base_bps: u16, k_x100: u32, floor_bps: u16, p_wad: u64) -> u16 {
    let base = base_bps as u128;
    // reduction = ceil(base × k × P) with k = k_x100 / 100: rounding the reduction up lowers the LTV.
    let num = base.saturating_mul(k_x100 as u128).saturating_mul(p_wad as u128);
    let reduction = num.div_ceil(100 * WAD);
    let ltv = base.saturating_sub(reduction);
    ltv.max(floor_bps.min(base_bps) as u128).min(base) as u16
}

#[program]
pub mod gap_consumer {
    use super::*;

    pub fn init_market(ctx: Context<InitMarket>, ticker: [u8; 8], base_ltv_bps: u16, k_x100: u32, floor_bps: u16, max_age_secs: u32) -> Result<()> {
        require!(base_ltv_bps > 0 && base_ltv_bps as u128 <= BPS, ConsumerError::BadParam);
        require!(floor_bps <= base_ltv_bps, ConsumerError::BadParam);
        require!(k_x100 <= 10_000, ConsumerError::BadParam);
        require!((60..=86_400).contains(&max_age_secs), ConsumerError::BadParam);
        let m = &mut ctx.accounts.market;
        m.authority = ctx.accounts.authority.key();
        m.ticker = ticker;
        m.base_ltv_bps = base_ltv_bps;
        m.k_x100 = k_x100;
        m.floor_bps = floor_bps;
        m.max_age_secs = max_age_secs;
        m.ltv_weekend_bps = 0;
        m.bump = ctx.bumps.market;
        Ok(())
    }

    pub fn refresh_limit(ctx: Context<RefreshLimit>, ticker: [u8; 8]) -> Result<()> {
        // The ticker only selects the market and feed PDAs (account constraints); the market stores its own.
        require!(ctx.accounts.market.ticker == ticker, ConsumerError::BadParam);
        let f = ctx.accounts.feed.load()?;
        let now = Clock::get()?.unix_timestamp;
        require!(f.updates > 0, ConsumerError::FeedNeverUpdated);
        require!(f.flags & feed_flag::BLOCKING == 0, ConsumerError::FeedFlagged);
        // The feed describes whichever closure is next; its probabilities are for that closure type.
        require!(f.closure_type == closure::WEEKEND, ConsumerError::NotWeekend);
        let age = now.checked_sub(f.last_update_ts).ok_or(ConsumerError::Math)?;
        require!(age >= 0 && age <= ctx.accounts.market.max_age_secs as i64, ConsumerError::FeedStale);
        require!(now < f.next_open, ConsumerError::ClosureOver);
        let m = &mut ctx.accounts.market;
        m.ltv_weekend_bps = weekend_ltv_bps(m.base_ltv_bps, m.k_x100, m.floor_bps, f.p_lt_8_wad);
        m.p_lt_8_wad = f.p_lt_8_wad;
        m.feed_ts = f.last_update_ts;
        m.closure_id = f.closure_id;
        m.set_at_ts = now;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(ticker: [u8; 8])]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Market::INIT_SPACE, seeds = [SEED_MARKET, ticker.as_ref()], bump)]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(ticker: [u8; 8])]
pub struct RefreshLimit<'info> {
    #[account(mut, seeds = [SEED_MARKET, ticker.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// The feed: `AccountLoader` checks the owner (`credence_core`), the discriminator and the length; the seeds check
    /// that it is the PDA of this market's ticker under `credence_core`.
    #[account(seeds = [SEED_FEED, ticker.as_ref()], bump = feed.load()?.bump, seeds::program = credence_core::ID)]
    pub feed: AccountLoader<'info, GapFeed>,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub ticker: [u8; 8],
    pub base_ltv_bps: u16,
    pub k_x100: u32,
    pub floor_bps: u16,
    pub max_age_secs: u32,
    /// Result of the last `refresh_limit` (0 until the first).
    pub ltv_weekend_bps: u16,
    pub p_lt_8_wad: u64,
    pub feed_ts: i64,
    pub set_at_ts: i64,
    pub closure_id: u32,
    pub bump: u8,
}

#[error_code]
pub enum ConsumerError {
    #[msg("bad market parameter")]
    BadParam,
    #[msg("the feed has never been updated")]
    FeedNeverUpdated,
    #[msg("the feed carries a blocking flag (missing, stale or unverified input, or paused)")]
    FeedFlagged,
    #[msg("the feed is older than the market allows")]
    FeedStale,
    #[msg("the feed's closure has already opened")]
    ClosureOver,
    #[msg("the feed describes an overnight or holiday closure, not a weekend")]
    NotWeekend,
    #[msg("arithmetic error")]
    Math,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_toward_the_lower_ltv() {
        const W: u64 = 1_000_000_000_000_000_000;
        // No risk: the base. Certain gap with k = 1: the floor.
        assert_eq!(weekend_ltv_bps(8_000, 2_000, 5_000, 0), 8_000);
        assert_eq!(weekend_ltv_bps(8_000, 100, 5_000, W), 5_000);
        // 8000 × 20 × 0.00123 = 196.8 → reduction 197 (up) → 7803.
        assert_eq!(weekend_ltv_bps(8_000, 2_000, 5_000, 1_230_000_000_000_000), 7_803);
        // A tiny positive probability always lowers it by at least 1 bp.
        assert_eq!(weekend_ltv_bps(8_000, 100, 5_000, 1), 7_999);
        // The floor never exceeds the base.
        assert_eq!(weekend_ltv_bps(4_000, 100, 5_000, W), 4_000);
        // Monotone: more probability, never a higher LTV.
        let mut last = u16::MAX;
        for p in (0..=W).step_by((W / 997) as usize) {
            let l = weekend_ltv_bps(8_000, 2_500, 3_000, p);
            assert!(l <= last);
            last = l;
        }
    }
}
