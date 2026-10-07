//! Friday close and Monday settlement prices (task 2.4). See `oracle.rs` for the per-update checks.
//!
//! `EQUITY` source (the plan; Hermes updates posted through the receiver):
//! - `snapshot_close` (anyone): one update published in `[close − close_window_secs, close]`.
//! - `post_settlement` (keeper, from `open + 5 min`): all the keeper's updates published in `[open, open + 5 min]`
//!   (INV-4), averaged. The keeper, not anyone, posts it, so nobody can cherry-pick a subset of the window's updates.
//!
//! `XSTOCK` source (fallback while the Hermes key has no entitlement, plan/06). Pyth's push accounts update about every
//! 14.5 min in session and rarely outside it, so a 5-minute window would halt most Mondays. With
//! `w = xstock_settle_window_secs` (≤ 1 h) and only the asset's push account accepted (`oracle::push_account`):
//! - `snapshot_close` (anyone): the push account's update, published in `[close − w, close]`.
//! - `post_settlement` (keeper, from the open): the push account's update, published in `[open, open + w]`. The keeper
//!   posts as soon as the account holds an update at or after the open, i.e. the first push update after the open.
//!
//! - `halt_epoch` (keeper): no valid update in the window → `HALTED`, and the window moves to the next session's open
//!   (from the calendar). Never settle on a price outside its window.

use anchor_lang::prelude::*;
use credence_risk_core::U256;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::instructions::epoch::VENUE_XNYS;
use crate::calendar::SETTLE_WINDOW;
use crate::math::WAD;
use crate::oracle::{average, check_update, per_token, push_account, scaled_ui_multiplier_wad, source, within_bps, Checked};
use crate::state::*;
use crate::CoreError;

/// The cross-check update (`Crypto.<T>X/USD`, 24/7 but pushed every few minutes to an hour) may be this far from the
/// window it checks.
pub const XCHECK_MAX_DISTANCE: i64 = 3600;

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct SnapshotClose<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(mut, seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Account<'info, Epoch>,
    /// CHECK: the asset's xStock mint (address checked); read for the Scaled UI multiplier.
    #[account(address = asset.load()?.mint @ CoreError::InvalidParam)]
    pub mint: UncheckedAccount<'info>,
    /// `Equity.US.<T>/USD` (EQUITY source) or the `Crypto.<T>X/USD` push account (XSTOCK source). Owner = Pyth
    /// receiver.
    pub price: Account<'info, PriceUpdateV2>,
    /// `Crypto.<T>X/USD` cross-check; required for the EQUITY source.
    pub xcheck: Option<Account<'info, PriceUpdateV2>>,
}

pub fn handle_snapshot_close(ctx: Context<SnapshotClose>, _ticker: Ticker, _closure_id: u32) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let a = ctx.accounts.asset.load()?;
    let e = &ctx.accounts.epoch;
    require!(e.state == epoch_state::OPEN, CoreError::WrongEpochState);
    require!(Clock::get()?.unix_timestamp >= e.close, CoreError::TooEarly);
    let window = if is_xstock(&a) {
        require_push_account(&a, &ctx.accounts.price.key())?;
        cfg.xstock_settle_window_secs
    } else {
        cfg.close_window_secs
    };
    let from = e.close.checked_sub(window as i64).ok_or(CoreError::Math)?;
    let (price, mult) = token_price(
        &a,
        cfg,
        &ctx.accounts.mint,
        &[check_update(&ctx.accounts.price, primary_feed(&a), from, e.close, cfg.max_conf_bps)?],
        ctx.accounts.xcheck.as_deref(),
        (from, e.close),
    )?;
    drop(a);
    let e = &mut ctx.accounts.epoch;
    e.close_price_wad = price;
    e.close_multiplier_wad = mult;
    e.state = epoch_state::CLOSED;
    emit!(CloseSnapshotted { ticker: e.ticker, closure_id: e.closure_id, price_wad: price, multiplier_wad: mult });
    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct PostSettlement<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = keeper @ CoreError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(mut, seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Account<'info, Epoch>,
    /// CHECK: the asset's xStock mint (address checked); read for the Scaled UI multiplier.
    #[account(address = asset.load()?.mint @ CoreError::InvalidParam)]
    pub mint: UncheckedAccount<'info>,
    /// `Crypto.<T>X/USD` cross-check; required for the EQUITY source.
    pub xcheck: Option<Account<'info, PriceUpdateV2>>,
    // remaining_accounts: EQUITY: the window's updates of the primary feed, ascending publish time. XSTOCK: the asset's
    // push account only.
}

pub fn handle_post_settlement<'info>(
    ctx: Context<'info, PostSettlement<'info>>,
    _ticker: Ticker,
    _closure_id: u32,
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let a = ctx.accounts.asset.load()?;
    let e = &ctx.accounts.epoch;
    require!(e.state == epoch_state::CLOSED || e.state == epoch_state::HALTED, CoreError::WrongEpochState);
    let (from, to) = settle_window(&a, cfg, e)?;
    // EQUITY averages the whole window, so it waits for its end; XSTOCK takes the first push update after the open.
    let earliest = if is_xstock(&a) { e.open } else { e.settle_after };
    require!(Clock::get()?.unix_timestamp >= earliest, CoreError::TooEarly);
    let max_updates = if is_xstock(&a) { 1 } else { 16 };
    require!(
        !ctx.remaining_accounts.is_empty() && ctx.remaining_accounts.len() <= max_updates,
        CoreError::InvalidParam
    );
    let mut checked: Vec<Checked> = Vec::with_capacity(ctx.remaining_accounts.len());
    for info in ctx.remaining_accounts {
        if is_xstock(&a) {
            require_push_account(&a, info.key)?;
        }
        let u: Account<PriceUpdateV2> = Account::try_from(info)?;
        checked.push(check_update(&u, primary_feed(&a), from, to, cfg.max_conf_bps)?);
    }
    let (price, mult) = token_price(&a, cfg, &ctx.accounts.mint, &checked, ctx.accounts.xcheck.as_deref(), (from, to))?;
    drop(a);
    let e = &mut ctx.accounts.epoch;
    e.settle_price_wad = price;
    e.settle_multiplier_wad = mult;
    e.settled_at = Clock::get()?.unix_timestamp;
    e.state = epoch_state::SETTLED;
    emit!(SettlementPosted {
        ticker: e.ticker,
        closure_id: e.closure_id,
        price_wad: price,
        multiplier_wad: mult,
        updates: checked.len() as u8,
        gap_wad: gap_wad(e.close_price_wad, price)?,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct HaltEpoch<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = keeper @ CoreError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(mut, seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Account<'info, Epoch>,
    #[account(seeds = [SEED_CALENDAR, VENUE_XNYS.as_ref()], bump = calendar.load()?.bump)]
    pub calendar: AccountLoader<'info, Calendar>,
}

/// No valid update in the window (asset halted at the open, or feed outage): the epoch waits for the next session's
/// opening window. Only after the window (the source's, see [`settle_window`]) has passed.
pub fn handle_halt_epoch(ctx: Context<HaltEpoch>, _ticker: Ticker, _closure_id: u32) -> Result<()> {
    let (_, to) = settle_window(&*ctx.accounts.asset.load()?, &ctx.accounts.config, &ctx.accounts.epoch)?;
    let e = &mut ctx.accounts.epoch;
    require!(e.state == epoch_state::CLOSED || e.state == epoch_state::HALTED, CoreError::WrongEpochState);
    require!(Clock::get()?.unix_timestamp > to, CoreError::TooEarly);
    let cal = ctx.accounts.calendar.load()?;
    let s = &cal.sessions[..cal.n as usize];
    let next = s.iter().find(|x| x.open > e.open).ok_or(CoreError::NotASession)?;
    e.open = next.open;
    e.settle_after = next.open.checked_add(SETTLE_WINDOW).ok_or(CoreError::Math)?;
    e.state = epoch_state::HALTED;
    emit!(EpochHalted { ticker: e.ticker, closure_id: e.closure_id, next_open: e.open });
    Ok(())
}

fn is_xstock(a: &AssetConfig) -> bool {
    a.settle_source == source::XSTOCK as u64
}

/// XSTOCK source: only Pyth's push account for the asset's xStock feed (see `oracle::push_account`).
fn require_push_account(a: &AssetConfig, key: &Pubkey) -> Result<()> {
    require_keys_eq!(*key, push_account(&a.feed_xstock), CoreError::NotPushAccount);
    Ok(())
}

/// The settlement window `[from, to]` (inclusive, Unix seconds): EQUITY `[open, open + 5 min]` (`settle_after`),
/// XSTOCK `[open, open + xstock_settle_window_secs]`.
pub fn settle_window(a: &AssetConfig, cfg: &Config, e: &Epoch) -> Result<(i64, i64)> {
    if is_xstock(a) {
        Ok((e.open, e.open.checked_add(cfg.xstock_settle_window_secs as i64).ok_or(CoreError::Math)?))
    } else {
        Ok((e.open, e.settle_after))
    }
}

fn primary_feed(a: &AssetConfig) -> &[u8; 32] {
    if is_xstock(a) {
        &a.feed_xstock
    } else {
        &a.feed_equity
    }
}

/// Price per raw xStock token unit (WAD) and the multiplier used. EQUITY: mean equity price × multiplier at the first
/// update, cross-checked against the xStock feed. XSTOCK: mean xStock price (multiplier recorded for display).
fn token_price(
    a: &AssetConfig,
    cfg: &Config,
    mint: &AccountInfo,
    checked: &[Checked],
    xcheck: Option<&PriceUpdateV2>,
    window: (i64, i64),
) -> Result<(u128, u128)> {
    let mean = average(checked)?;
    let t = checked[0].publish_time;
    let mult = scaled_ui_multiplier_wad(&mint.try_borrow_data()?, t)?;
    if is_xstock(a) {
        return Ok((mean, mult));
    }
    let price = per_token(mean, mult)?;
    let x = xcheck.ok_or(CoreError::CrossCheckFailed)?;
    let xc = check_update(
        x,
        &a.feed_xstock,
        window.0.saturating_sub(XCHECK_MAX_DISTANCE),
        window.1.saturating_add(XCHECK_MAX_DISTANCE),
        cfg.max_conf_bps,
    )?;
    require!(within_bps(price, xc.price_wad, cfg.xcheck_bps), CoreError::CrossCheckFailed);
    Ok((price, mult))
}

/// r = settle / close − 1 in WAD (signed, rounded toward −∞ on the ratio), for events and display. 256-bit: a WAD
/// price times 1e18 does not fit in 128 bits.
pub fn gap_wad(close: u128, settle: u128) -> Result<i128> {
    require!(close > 0, CoreError::BadPrice);
    let ratio = U256::from(settle) * U256::from(WAD) / U256::from(close);
    let ratio = i128::try_from(ratio).map_err(|_| error!(CoreError::Math))?;
    Ok(ratio - WAD as i128)
}

#[event]
pub struct CloseSnapshotted {
    pub ticker: Ticker,
    pub closure_id: u32,
    pub price_wad: u128,
    pub multiplier_wad: u128,
}

#[event]
pub struct SettlementPosted {
    pub ticker: Ticker,
    pub closure_id: u32,
    pub price_wad: u128,
    pub multiplier_wad: u128,
    pub updates: u8,
    pub gap_wad: i128,
}

#[event]
pub struct EpochHalted {
    pub ticker: Ticker,
    pub closure_id: u32,
    pub next_open: i64,
}
