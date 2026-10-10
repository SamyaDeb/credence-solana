//! NAV-priced assets (D4, research prototype): a closure type for an asset whose lender prices it at a NAV (ONyc on
//! Kamino's OnRe Market), `NAV_STRIKE`. The closure is the time between two strikes of a schedule this program holds
//! (`NavSchedule`); there is no exchange calendar. Everything else is the Gap Cover that already exists:
//! - the price at both ends is the **lender's own oracle** (Kamino's Scope, `settle_source` SCOPE): `snapshot_close` at the
//!   strike, `post_settlement` at the next one, with the same windows and the same keeper-only rule;
//! - cover is `buy_cover` on a real klend obligation of the NAV market (ONyc collateral, USDC debt), priced on the
//!   asset's NAV_STRIKE scenario set (its σ is an assumed floor: the data has no down strike) and settled by repaying
//!   into the obligation;
//! - the Liquidation Shield does not apply (no second price to act on): `shield_advance` refuses a NAV epoch.
//!
//! Instructions:
//! - `add_nav_asset` (admin): the asset (a classic SPL token, Scope-priced) and its schedule, in one step;
//! - `open_nav_epoch` (anyone): the closure after the strike on a given UTC date; refused while the guardian has gated the
//!   asset;
//! - `halt_nav_epoch` (keeper): no valid NAV in the settlement window (stale oracle, halted fund) → the window moves to the
//!   next strike. The close price stays; the payout rule is unchanged;
//! - `set_nav_gate` (guardian closes, admin opens): redemption-gate switch: no new closure opens while gated;
//! - `stop_nav_sales` (guardian or admin): ends the sale of one open closure now.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};

use crate::calendar::{nav_times, SETTLE_WINDOW};
use crate::instructions::admin::{apply_asset, AssetParams};
use crate::state::*;
use crate::state_nav::*;
use crate::CoreError;

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct AddNavAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = AssetConfig::SIZE, seeds = [SEED_ASSET, ticker.as_ref()], bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(init, payer = admin, space = NavSchedule::SIZE, seeds = [SEED_NAV, ticker.as_ref()], bump)]
    pub schedule: Account<'info, NavSchedule>,
    /// The NAV token: a classic SPL Token mint (ONyc has 9 decimals; the payout uses price ratios per raw unit).
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Registers a NAV asset. It settles on the lender's own oracle (SCOPE) only; its single Kamino reserve (the NAV market's)
/// goes in `kamino_reserves[0]`; no Pyth feed is used. `anchor_ts` and `interval_secs` are the strike schedule. The NAV_STRIKE set's σ
/// is **per day**: a closure of several days is priced as σ × √days, like an overnight over a holiday.
pub fn handle_add_nav_asset(ctx: Context<AddNavAsset>, ticker: Ticker, params: AssetParams, anchor_ts: i64, interval_secs: u32) -> Result<()> {
    params.validate()?;
    require!(ticker != [0u8; 8], CoreError::InvalidParam);
    require!(params.settle_source == crate::oracle::source::SCOPE, CoreError::InvalidParam);
    require!(params.kamino_reserves[0] != Pubkey::default() && params.kamino_reserves[1] == Pubkey::default(), CoreError::InvalidParam);
    require!(params.feed_equity == [0u8; 32] && params.feed_xstock == [0u8; 32] && params.feed_redemption == [0u8; 32], CoreError::InvalidParam);
    require!((6..=9).contains(&ctx.accounts.mint.decimals), CoreError::InvalidParam);
    require!(anchor_ts > 0, CoreError::InvalidParam);
    require!(
        interval_secs >= NavSchedule::DAY && interval_secs % NavSchedule::DAY == 0 && interval_secs <= NavSchedule::MAX_INTERVAL,
        CoreError::InvalidParam
    );
    let mut a = ctx.accounts.asset.load_init()?;
    a.ticker = ticker;
    a.mint = ctx.accounts.mint.key();
    a.bump = ctx.bumps.asset;
    apply_asset(&mut a, &params);
    let s = &mut ctx.accounts.schedule;
    s.ticker = ticker;
    s.anchor_ts = anchor_ts;
    s.interval_secs = interval_secs;
    s.gated = 0;
    s.bump = ctx.bumps.schedule;
    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct OpenNavEpoch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(seeds = [SEED_NAV, ticker.as_ref()], bump = schedule.bump)]
    pub schedule: Account<'info, NavSchedule>,
    /// The loss vector of the strike's date must exist (`open_group`): it is shared with any exchange closure of that date.
    #[account(seeds = [SEED_LOSS, &closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(
        init, payer = payer, space = Epoch::SIZE,
        seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump
    )]
    pub epoch: Account<'info, Epoch>,
    pub system_program: Program<'info, System>,
}

/// Opens the closure that starts at the strike on the UTC date `closure_id`. Refused while paused, while the asset is
/// disabled or gated, off the schedule, and once the bell has passed.
pub fn handle_open_nav_epoch(ctx: Context<OpenNavEpoch>, ticker: Ticker, closure_id: u32) -> Result<()> {
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    require!(ctx.accounts.asset.load()?.enabled == 1, CoreError::AssetDisabled);
    let s = &ctx.accounts.schedule;
    require!(s.gated == 0, CoreError::NavGated);
    let t = nav_times(s.anchor_ts, s.interval_secs, closure_id).ok_or(CoreError::NotAStrike)?;
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
    emit!(crate::instructions::epoch::EpochOpened { ticker, closure_id, sale_open: t.sale_open, bell: t.bell, close: t.close, open: t.open });
    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct HaltNavEpoch<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = keeper @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_NAV, ticker.as_ref()], bump = schedule.bump)]
    pub schedule: Account<'info, NavSchedule>,
    #[account(mut, seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Account<'info, Epoch>,
}

/// No valid NAV in the settlement window (the lender's oracle went stale, or the fund halted): the closure waits for the next
/// strike's window, one interval later. Only after the window has passed.
pub fn handle_halt_nav_epoch(ctx: Context<HaltNavEpoch>, _ticker: Ticker, _closure_id: u32) -> Result<()> {
    let e = &mut ctx.accounts.epoch;
    require!(e.closure_type == closure::NAV_STRIKE, CoreError::UnsupportedClosure);
    require!(e.state == epoch_state::CLOSED || e.state == epoch_state::HALTED, CoreError::WrongEpochState);
    let (_, to) = crate::instructions::settlement::settle_window(e.close_source as u64, &ctx.accounts.config, e)?;
    require!(Clock::get()?.unix_timestamp > to, CoreError::TooEarly);
    e.open = e.open.checked_add(ctx.accounts.schedule.interval_secs as i64).ok_or(CoreError::Math)?;
    e.settle_after = e.open.checked_add(SETTLE_WINDOW).ok_or(CoreError::Math)?;
    e.state = epoch_state::HALTED;
    emit!(crate::instructions::settlement::EpochHalted { ticker: e.ticker, closure_id: e.closure_id, next_open: e.open });
    Ok(())
}

#[derive(Accounts)]
pub struct SetNavGate<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_NAV, schedule.ticker.as_ref()], bump = schedule.bump)]
    pub schedule: Account<'info, NavSchedule>,
}

/// The guardian (or the admin) closes the gate; only the admin reopens it: the same asymmetry as `set_paused`.
pub fn handle_set_nav_gate(ctx: Context<SetNavGate>, gated: bool) -> Result<()> {
    let (c, who) = (&ctx.accounts.config, ctx.accounts.authority.key());
    let allowed = if gated { who == c.guardian || who == c.admin } else { who == c.admin };
    require!(allowed, CoreError::Unauthorized);
    ctx.accounts.schedule.gated = gated as u8;
    Ok(())
}

#[derive(Accounts)]
pub struct StopNavSales<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch.ticker.as_ref(), &epoch.closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Account<'info, Epoch>,
}

/// Ends the sale of one open NAV closure now (the bell moves to this moment). Policies already sold are untouched and settle
/// as usual. Reduces risk only, so the guardian may do it.
pub fn handle_stop_nav_sales(ctx: Context<StopNavSales>) -> Result<()> {
    let (c, who) = (&ctx.accounts.config, ctx.accounts.authority.key());
    require!(who == c.guardian || who == c.admin, CoreError::Unauthorized);
    let e = &mut ctx.accounts.epoch;
    require!(e.closure_type == closure::NAV_STRIKE && e.state == epoch_state::OPEN, CoreError::WrongEpochState);
    let now = Clock::get()?.unix_timestamp;
    require!(now < e.bell, CoreError::SalesClosed);
    e.bell = now;
    Ok(())
}
