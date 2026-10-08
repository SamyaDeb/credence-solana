//! Calendar upload and epoch creation (task 2.2). Settlement prices: `settlement.rs` (task 2.4).
//!
//! `open_group` creates the weekend's shared `LossVector`; `open_epoch` creates one asset's epoch with every time
//! taken from the finalised calendar (no caller-supplied times). Both are permissionless (the keeper opens the next
//! four weekends) and refused while the protocol is paused.

use anchor_lang::prelude::*;

use crate::calendar::{epoch_times, sessions_valid};
use crate::state::*;
use crate::CoreError;

/// The only venue in Phase 1.
pub const VENUE_XNYS: [u8; 8] = *b"XNYS\0\0\0\0";

// ---------------------------------------------------------------------------------------------------------------
// Calendar upload (admin)
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(venue: [u8; 8])]
pub struct InitCalendar<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = Calendar::SIZE, seeds = [SEED_CALENDAR, venue.as_ref()], bump)]
    pub calendar: AccountLoader<'info, Calendar>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_calendar(ctx: Context<InitCalendar>, venue: [u8; 8], n: u16) -> Result<()> {
    require!(venue == VENUE_XNYS, CoreError::InvalidParam);
    require!(n >= 2 && n as usize <= N_SESSIONS, CoreError::InvalidParam);
    let mut c = ctx.accounts.calendar.load_init()?;
    c.venue = venue;
    c.n = n;
    c.bump = ctx.bumps.calendar;
    Ok(())
}

#[derive(Accounts)]
pub struct WriteCalendar<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_CALENDAR, calendar.load()?.venue.as_ref()], bump = calendar.load()?.bump)]
    pub calendar: AccountLoader<'info, Calendar>,
}

pub fn handle_write_calendar(ctx: Context<WriteCalendar>, offset: u16, sessions: Vec<SessionArg>) -> Result<()> {
    let mut c = ctx.accounts.calendar.load_mut()?;
    require!(c.finalized == 0, CoreError::AlreadyFinalized);
    let start = offset as usize;
    let end = start.checked_add(sessions.len()).ok_or(CoreError::InvalidParam)?;
    require!(!sessions.is_empty() && end <= c.n as usize, CoreError::InvalidParam);
    for (slot, s) in c.sessions[start..end].iter_mut().zip(sessions) {
        *slot = s.into();
    }
    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeCalendar<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_CALENDAR, calendar.load()?.venue.as_ref()], bump = calendar.load()?.bump)]
    pub calendar: AccountLoader<'info, Calendar>,
}

/// SHA-256 over `date u32 ‖ open i64 ‖ close i64` (little-endian) per session, as `gen-calendar.ts` prints it.
pub fn calendar_hash(sessions: &[Session]) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(sessions.len() * 20);
    for s in sessions {
        bytes.extend_from_slice(&s.date.to_le_bytes());
        bytes.extend_from_slice(&s.open.to_le_bytes());
        bytes.extend_from_slice(&s.close.to_le_bytes());
    }
    solana_sha256_hasher::hashv(&[&bytes]).to_bytes()
}

/// Checks the sessions are ordered and well-formed and hash to `expected_hash`. Finalised calendars are immutable.
pub fn handle_finalize_calendar(ctx: Context<FinalizeCalendar>, expected_hash: [u8; 32]) -> Result<()> {
    let mut c = ctx.accounts.calendar.load_mut()?;
    require!(c.finalized == 0, CoreError::AlreadyFinalized);
    let s = &c.sessions[..c.n as usize];
    require!(sessions_valid(s), CoreError::NotSorted);
    require!(calendar_hash(s) == expected_hash, CoreError::HashMismatch);
    c.hash = expected_hash;
    c.finalized = 1;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Groups and epochs (anyone)
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(group: u32)]
pub struct OpenGroup<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = payer, space = LossVector::SIZE, seeds = [SEED_LOSS, &group.to_le_bytes()], bump)]
    pub loss: AccountLoader<'info, LossVector>,
    pub system_program: Program<'info, System>,
}

/// Creates the weekend's shared loss vector. `group` is the closure id (Friday's date, `yyyymmdd`).
pub fn handle_open_group(ctx: Context<OpenGroup>, group: u32) -> Result<()> {
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    require!(crate::calendar::days_from_civil(group).is_some(), CoreError::InvalidParam);
    let mut l = ctx.accounts.loss.load_init()?;
    l.group = group;
    l.bump = ctx.bumps.loss;
    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct OpenEpoch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(seeds = [SEED_CALENDAR, VENUE_XNYS.as_ref()], bump = calendar.load()?.bump)]
    pub calendar: AccountLoader<'info, Calendar>,
    /// The weekend's loss vector must exist (`open_group`) so every epoch of the weekend shares it.
    #[account(seeds = [SEED_LOSS, &closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(
        init, payer = payer, space = Epoch::SIZE,
        seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump
    )]
    pub epoch: Account<'info, Epoch>,
    pub system_program: Program<'info, System>,
}

/// Creates the epoch for `ticker` and the closure after session `closure_id`, with times from the calendar.
/// Phase 1 sells `WEEKEND` closures only, and only epochs whose bell is still ahead.
pub fn handle_open_epoch(ctx: Context<OpenEpoch>, ticker: Ticker, closure_id: u32) -> Result<()> {
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    require!(ctx.accounts.asset.load()?.enabled == 1, CoreError::AssetDisabled);
    let cal = ctx.accounts.calendar.load()?;
    require!(cal.finalized == 1, CoreError::NotFinalized);
    let t = epoch_times(&cal.sessions[..cal.n as usize], closure_id).ok_or(CoreError::NotASession)?;
    require!(t.closure_type == closure::WEEKEND, CoreError::UnsupportedClosure);
    require!(Clock::get()?.unix_timestamp < t.bell, CoreError::SalesClosed);

    let e = &mut ctx.accounts.epoch;
    e.ticker = ticker;
    e.closure_id = closure_id;
    e.closure_type = t.closure_type;
    e.state = epoch_state::OPEN;
    e.bump = ctx.bumps.epoch;
    e.sale_open = t.sale_open;
    e.bell = t.bell;
    e.close = t.close;
    e.open = t.open;
    e.settle_after = t.settle_after;
    emit!(EpochOpened { ticker, closure_id, sale_open: t.sale_open, bell: t.bell, close: t.close, open: t.open });
    Ok(())
}

#[event]
pub struct EpochOpened {
    pub ticker: Ticker,
    pub closure_id: u32,
    pub sale_open: i64,
    pub bell: i64,
    pub close: i64,
    pub open: i64,
}
