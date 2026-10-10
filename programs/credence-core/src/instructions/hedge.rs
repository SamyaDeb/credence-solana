//! Hedging the vault (D3, testnet hedge, research): the hedge book, its caps, and the one place hedge P&L can reach equity.
//!
//! The hedge is a short perp on another venue (Hyperliquid's testnet `xyz` dex for the keeper in this repo), margin
//! under a key the keeper holds. That is a **trust assumption** the program bounds and never relies on:
//!
//! - `open_hedge` (keeper; refused while paused): declares the weekend's legs before the open. Margin ≤ `margin_cap_bps` of
//!   cover equity, notional ≤ `max_leverage × margin`, each leg's epoch is the weekend's own and still unsettled.
//! - `report_hedge` (keeper; works while paused, so a hedge can always be closed out): exit prices, net P&L after fees and
//!   funding, a hash of the venue's fills. Gain ≤ the price-implied P&L and ≤ `pnl_cap_bps` of the equity at declaration;
//!   loss ≤ the margin and ≤ the same `pnl_cap_bps` share (A-271). Nothing moves yet.
//! - `finalize_hedge` (keeper, because it brings the USDC): only after the weekend's group settled **and** the challenge delay.
//!   The reported P&L must sit within `return_tol` of the P&L the lender-oracle prices of the epochs imply (the keeper cannot
//!   invent a gain the settlement prices do not show) and every leg's return within the same tolerance. A gain is a USDC
//!   transfer **into** the vault (equity rises by what arrived); a loss is a transfer **out** to the keeper's account that
//!   funded the margin. Only here does equity move; rounding: gains floor, losses are the reported integers.
//! - `void_hedge` (guardian): a report nobody should believe never reaches equity. `expire_hedge` (anyone): a book not
//!   finalised `expiry_secs` after the open is void for good.
//!
//! Capacity is never touched: no instruction here reads or writes `reserved_total`, a `LossVector` row or the Backstop.
//! While a book is pending, `Vault.hedge_pending > 0` blocks queue processing and immediate deposits, so nobody enters or
//! leaves at a NAV that is about to move (INV-5).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use credence_risk_core::hedge as rc;

use crate::instructions::settle::pay_from_vault;
use crate::state::*;
use crate::state_hedge::*;
use crate::CoreError;

const BPS: u128 = 10_000;
const WAD: u128 = 1_000_000_000_000_000_000;

/// The caps; see [`HedgeConfig`].
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct HedgeParams {
    pub margin_cap_bps: u16,
    pub pnl_cap_bps: u16,
    pub max_leverage: u8,
    pub delay_secs: u32,
    pub expiry_secs: u32,
    pub return_tol_wad: u64,
}
impl HedgeParams {
    fn validate(&self) -> Result<()> {
        require!(self.margin_cap_bps > 0 && self.margin_cap_bps <= HedgeConfig::MAX_MARGIN_BPS, CoreError::InvalidParam);
        require!(self.pnl_cap_bps > 0 && self.pnl_cap_bps <= HedgeConfig::MAX_PNL_BPS, CoreError::InvalidParam);
        require!(self.max_leverage > 0 && self.max_leverage <= HedgeConfig::MAX_LEVERAGE, CoreError::InvalidParam);
        require!((HedgeConfig::MIN_DELAY..=HedgeConfig::MAX_DELAY).contains(&self.delay_secs), CoreError::InvalidParam);
        require!(self.expiry_secs > self.delay_secs && self.expiry_secs <= HedgeConfig::MAX_EXPIRY, CoreError::InvalidParam);
        require!(self.return_tol_wad > 0 && self.return_tol_wad <= HedgeConfig::MAX_TOL_WAD, CoreError::InvalidParam);
        Ok(())
    }
    fn apply(&self, c: &mut HedgeConfig) {
        c.margin_cap_bps = self.margin_cap_bps;
        c.pnl_cap_bps = self.pnl_cap_bps;
        c.max_leverage = self.max_leverage;
        c.delay_secs = self.delay_secs;
        c.expiry_secs = self.expiry_secs;
        c.return_tol_wad = self.return_tol_wad;
    }
}

// -------------------------------------------------------------------------------------------------------------------
// Config (admin)
// -------------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitHedgeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = HedgeConfig::SIZE, seeds = [SEED_HEDGE_CFG], bump)]
    pub hedge_config: Account<'info, HedgeConfig>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_hedge_config(ctx: Context<InitHedgeConfig>, params: HedgeParams) -> Result<()> {
    params.validate()?;
    let c = &mut ctx.accounts.hedge_config;
    params.apply(c);
    c.bump = ctx.bumps.hedge_config;
    Ok(())
}

#[derive(Accounts)]
pub struct SetHedgeConfig<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_HEDGE_CFG], bump = hedge_config.bump)]
    pub hedge_config: Account<'info, HedgeConfig>,
}

/// Changes the caps for books declared from now on (a pending book keeps the equity base it was declared with).
pub fn handle_set_hedge_config(ctx: Context<SetHedgeConfig>, params: HedgeParams) -> Result<()> {
    params.validate()?;
    params.apply(&mut ctx.accounts.hedge_config);
    Ok(())
}

// -------------------------------------------------------------------------------------------------------------------
// open_hedge
// -------------------------------------------------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct HedgeLegArg {
    pub ticker: [u8; 8],
    /// USDC base units of the short.
    pub notional: u64,
    /// The venue's fill price, WAD (any scale: only the ratio to the exit price is used).
    pub entry_wad: u128,
}

#[derive(Accounts)]
#[instruction(group: u32)]
pub struct OpenHedge<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.keeper == keeper.key() @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_HEDGE_CFG], bump = hedge_config.bump)]
    pub hedge_config: Account<'info, HedgeConfig>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(seeds = [SEED_LOSS, &group.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(init, payer = keeper, space = HedgeBook::SIZE, seeds = [SEED_HEDGE, &group.to_le_bytes()], bump)]
    pub hedge: Account<'info, HedgeBook>,
    pub system_program: Program<'info, System>,
}

/// The leg's epoch for this group: the account at `info` must be the PDA of `(ticker, group)` and deserialize as an Epoch.
fn leg_epoch<'info>(info: &'info AccountInfo<'info>, ticker: &[u8; 8], group: u32) -> Result<Account<'info, Epoch>> {
    let (key, _) = Pubkey::find_program_address(&[SEED_EPOCH, ticker.as_ref(), &group.to_le_bytes()], &crate::ID);
    require_keys_eq!(info.key(), key, CoreError::NotThisEpoch);
    Account::<Epoch>::try_from(info).map_err(|_| error!(CoreError::NotThisEpoch))
}

/// Declares the weekend's hedge before the open. Refused while the protocol is paused (the kill switch: no new hedges).
/// `remaining_accounts`: the epoch of each leg, in leg order.
pub fn handle_open_hedge<'info>(
    ctx: Context<'info, OpenHedge<'info>>,
    group: u32,
    margin: u64,
    venue: [u8; 20],
    legs: Vec<HedgeLegArg>,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    let cfg = &ctx.accounts.hedge_config;
    require!(!legs.is_empty() && legs.len() <= MAX_HEDGE_LEGS && ctx.remaining_accounts.len() == legs.len(), CoreError::InvalidParam);
    require!(venue != [0u8; 20], CoreError::InvalidParam); // A-270
    require!(ctx.accounts.loss.load()?.settled == 0 && ctx.accounts.loss.load()?.group == group, CoreError::HedgeState);
    let now = Clock::get()?.unix_timestamp;

    let mut book_legs = [HedgeLeg::default(); MAX_HEDGE_LEGS];
    let (mut total, mut earliest, mut bell) = (0u128, 0i64, 0i64);
    for (i, a) in legs.iter().enumerate() {
        require!(a.notional > 0 && a.entry_wad > 0 && a.ticker != [0; 8], CoreError::InvalidParam);
        // Tickers strictly ascending: one leg per asset.
        require!(i == 0 || legs[i - 1].ticker < a.ticker, CoreError::InvalidParam);
        let e = leg_epoch(&ctx.remaining_accounts[i], &a.ticker, group)?;
        require!(e.state == epoch_state::OPEN || e.state == epoch_state::CLOSED, CoreError::WrongEpochState);
        require!(now < e.open, CoreError::TooEarly);
        earliest = earliest.max(e.open);
        bell = bell.max(e.bell);
        total += a.notional as u128;
        book_legs[i] = HedgeLeg { ticker: a.ticker, notional: a.notional, entry_wad: a.entry_wad, exit_wad: 0 };
    }
    // Caps (rounded down): margin against cover equity, notional against the margin.
    let equity = ctx.accounts.vault.cover_equity()?;
    let max_margin = (equity as u128) * (cfg.margin_cap_bps as u128) / BPS;
    require!(margin > 0 && (margin as u128) <= max_margin, CoreError::HedgeBounds);
    require!(total <= (margin as u128) * (cfg.max_leverage as u128), CoreError::HedgeBounds);

    let b = &mut ctx.accounts.hedge;
    b.group = group;
    b.state = hedge_state::OPEN;
    b.bump = ctx.bumps.hedge;
    b.n_legs = legs.len() as u8;
    b.venue = venue;
    b.legs = book_legs;
    b.margin = margin;
    b.equity_at_open = equity;
    b.opened_at = now;
    b.earliest_report = earliest;
    b.bell = bell;
    b.reporter = Pubkey::default();
    let v = &mut ctx.accounts.vault;
    v.hedge_pending = v.hedge_pending.checked_add(1).ok_or(CoreError::Math)?;
    emit!(HedgeOpened { group, margin, notional: total as u64, legs: b.n_legs });
    Ok(())
}

// -------------------------------------------------------------------------------------------------------------------
// report_hedge
// -------------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ReportHedge<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.keeper == keeper.key() @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_HEDGE_CFG], bump = hedge_config.bump)]
    pub hedge_config: Account<'info, HedgeConfig>,
    #[account(mut, seeds = [SEED_HEDGE, &hedge.group.to_le_bytes()], bump = hedge.bump)]
    pub hedge: Account<'info, HedgeBook>,
}

/// Reports the close. `exits` are the legs' exit prices in leg order. Allowed while paused. Nothing moves.
pub fn handle_report_hedge(ctx: Context<ReportHedge>, exits: Vec<u128>, pnl: i64, evidence: [u8; 32]) -> Result<()> {
    let cfg = &ctx.accounts.hedge_config;
    let b = &mut ctx.accounts.hedge;
    require!(b.state == hedge_state::OPEN, CoreError::HedgeState);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= b.earliest_report, CoreError::TooEarly);
    let n = b.n_legs as usize;
    require!(exits.len() == n && exits.iter().all(|x| *x > 0) && evidence != [0u8; 32], CoreError::InvalidParam);

    // The most the prices let a short earn (fees and funding only lower it), and the cap on a gain.
    let mut priced: Vec<(u64, u128, u128)> = Vec::with_capacity(n);
    for i in 0..n {
        priced.push((b.legs[i].notional, b.legs[i].entry_wad, exits[i]));
    }
    let implied = rc::short_pnl_total(&priced).map_err(|_| error!(CoreError::Math))?;
    let gain_cap = ((b.equity_at_open as u128) * (cfg.pnl_cap_bps as u128) / BPS).min(i64::MAX as u128) as i64;
    require!(pnl <= implied && pnl <= gain_cap, CoreError::HedgeBounds);
    // A loss is capped by the margin and by the same share of equity as a gain (A-271): a keeper that invents a hedge on a
    // weekend the market rose can take at most that.
    require!(pnl >= 0 || pnl.unsigned_abs() <= b.margin.min(gain_cap as u64), CoreError::HedgeBounds);

    for i in 0..n {
        b.legs[i].exit_wad = exits[i];
    }
    b.state = hedge_state::REPORTED;
    b.reported_at = now;
    b.report_slot = Clock::get()?.slot;
    b.pnl = pnl;
    b.evidence = evidence;
    b.reporter = ctx.accounts.keeper.key();
    emit!(HedgeReported { group: b.group, pnl, evidence, reporter: b.reporter, slot: b.report_slot });
    Ok(())
}

// -------------------------------------------------------------------------------------------------------------------
// finalize_hedge
// -------------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct FinalizeHedge<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.keeper == keeper.key() @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_HEDGE_CFG], bump = hedge_config.bump)]
    pub hedge_config: Account<'info, HedgeConfig>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Account<'info, TokenAccount>,
    /// The keeper's USDC account: a gain is paid from it, a loss to it.
    #[account(mut, token::mint = config.usdc_mint, token::authority = keeper, token::token_program = token_program)]
    pub keeper_usdc: Account<'info, TokenAccount>,
    #[account(seeds = [SEED_LOSS, &hedge.group.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(mut, seeds = [SEED_HEDGE, &hedge.group.to_le_bytes()], bump = hedge.bump)]
    pub hedge: Account<'info, HedgeBook>,
    pub token_program: Program<'info, Token>,
}

/// Recognises the reported P&L in equity once the weekend has settled and the challenge delay has passed.
/// `remaining_accounts`: each leg's epoch, in leg order.
pub fn handle_finalize_hedge<'info>(ctx: Context<'info, FinalizeHedge<'info>>) -> Result<()> {
    let cfg = ctx.accounts.hedge_config.clone();
    let now = Clock::get()?.unix_timestamp;
    let group = ctx.accounts.hedge.group;
    let n = ctx.accounts.hedge.n_legs as usize;
    require!(ctx.accounts.hedge.state == hedge_state::REPORTED, CoreError::HedgeState);
    // Only the key that reported brings it through (A-272): a rotated keeper key cannot finalise a report it did not make.
    require_keys_eq!(ctx.accounts.hedge.reporter, ctx.accounts.keeper.key(), CoreError::Unauthorized);
    require!(now >= ctx.accounts.hedge.reported_at.saturating_add(cfg.delay_secs as i64), CoreError::TooEarly);
    {
        // The weekend is over for the vault: every policy settled (or there were none and the bell has passed).
        let l = ctx.accounts.loss.load()?;
        require!(l.settled == 1 || (l.policy_count == 0 && now > ctx.accounts.hedge.bell), CoreError::TooEarly);
    }
    require!(ctx.remaining_accounts.len() == n, CoreError::InvalidParam);

    // The reported prices and P&L against the lender-oracle prices the epochs stored.
    let (mut oracle_legs, mut total): (Vec<(u64, u128, u128)>, u128) = (Vec::with_capacity(n), 0);
    for i in 0..n {
        let leg = ctx.accounts.hedge.legs[i];
        let e = leg_epoch(&ctx.remaining_accounts[i], &leg.ticker, group)?;
        require!(e.state == epoch_state::SETTLED && e.close_price_wad > 0 && e.settle_price_wad > 0, CoreError::WrongEpochState);
        let gap = rc::return_gap_wad(leg.entry_wad, leg.exit_wad, e.close_price_wad, e.settle_price_wad)
            .map_err(|_| error!(CoreError::Math))?;
        require!(gap <= cfg.return_tol_wad as u128, CoreError::HedgeMismatch);
        oracle_legs.push((leg.notional, e.close_price_wad, e.settle_price_wad));
        total += leg.notional as u128;
    }
    let oracle_pnl = rc::short_pnl_total(&oracle_legs).map_err(|_| error!(CoreError::Math))? as i128;
    let band = (total * (cfg.return_tol_wad as u128)).div_ceil(WAD) as i128;
    let pnl = ctx.accounts.hedge.pnl;
    require!((pnl as i128) >= oracle_pnl - band && (pnl as i128) <= oracle_pnl + band, CoreError::HedgeMismatch);

    if pnl > 0 {
        let amount = pnl as u64;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.keeper_usdc.to_account_info(),
                    to: ctx.accounts.vault_usdc.to_account_info(),
                    authority: ctx.accounts.keeper.to_account_info(),
                },
            ),
            amount,
        )?;
        let v = &mut ctx.accounts.vault;
        v.equity = v.equity.checked_add(amount).ok_or(CoreError::Math)?;
    } else if pnl < 0 {
        let loss = pnl.unsigned_abs();
        let v = &ctx.accounts.vault;
        // The loss reimburses the margin the keeper put up; the vault keeps the cash INV-13 requires.
        require!(loss <= v.cover_equity()?, CoreError::CapacityExceeded);
        let cash_after = ctx.accounts.vault_usdc.amount.checked_sub(loss).ok_or(CoreError::CapacityExceeded)?;
        require!(cash_after >= v.reserved_cash()?, CoreError::CapacityExceeded);
        pay_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.vault_usdc, &ctx.accounts.keeper_usdc, loss)?;
        let v = &mut ctx.accounts.vault;
        v.equity = v.equity.checked_sub(loss).ok_or(CoreError::Math)?;
    }
    let v = &mut ctx.accounts.vault;
    v.hedge_pending = v.hedge_pending.checked_sub(1).ok_or(CoreError::Math)?;
    let b = &mut ctx.accounts.hedge;
    b.state = hedge_state::FINAL;
    b.finalized_at = now;
    b.settled_pnl = pnl;
    emit!(HedgeFinalized { group, pnl, equity: ctx.accounts.vault.equity });
    Ok(())
}

// -------------------------------------------------------------------------------------------------------------------
// void_hedge, expire_hedge
// -------------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct VoidHedge<'info> {
    pub guardian: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.guardian == guardian.key() @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [SEED_HEDGE, &hedge.group.to_le_bytes()], bump = hedge.bump)]
    pub hedge: Account<'info, HedgeBook>,
}

/// The guardian voids a hedge book that is not final: its P&L never reaches equity. Reduces risk only (a void gain is
/// forgone; a void loss is a loss the keeper bears).
pub fn handle_void_hedge(ctx: Context<VoidHedge>) -> Result<()> {
    close_book(&mut ctx.accounts.vault, &mut ctx.accounts.hedge)
}

#[derive(Accounts)]
pub struct ExpireHedge<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_HEDGE_CFG], bump = hedge_config.bump)]
    pub hedge_config: Account<'info, HedgeConfig>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [SEED_HEDGE, &hedge.group.to_le_bytes()], bump = hedge.bump)]
    pub hedge: Account<'info, HedgeBook>,
}

/// Anyone: a book still pending `expiry_secs` after the weekend's open is void for good, so a keeper that vanishes cannot
/// hold queues and deposits locked.
pub fn handle_expire_hedge(ctx: Context<ExpireHedge>) -> Result<()> {
    let due = ctx.accounts.hedge.earliest_report.saturating_add(ctx.accounts.hedge_config.expiry_secs as i64);
    require!(Clock::get()?.unix_timestamp > due, CoreError::TooEarly);
    close_book(&mut ctx.accounts.vault, &mut ctx.accounts.hedge)
}

fn close_book(v: &mut Vault, b: &mut HedgeBook) -> Result<()> {
    require!(b.state == hedge_state::OPEN || b.state == hedge_state::REPORTED, CoreError::HedgeState);
    b.state = hedge_state::VOIDED;
    v.hedge_pending = v.hedge_pending.checked_sub(1).ok_or(CoreError::Math)?;
    emit!(HedgeVoided { group: b.group });
    Ok(())
}

#[event]
pub struct HedgeOpened {
    pub group: u32,
    pub margin: u64,
    pub notional: u64,
    pub legs: u8,
}

#[event]
pub struct HedgeReported {
    pub group: u32,
    pub pnl: i64,
    pub evidence: [u8; 32],
    pub reporter: Pubkey,
    pub slot: u64,
}

#[event]
pub struct HedgeFinalized {
    pub group: u32,
    pub pnl: i64,
    pub equity: u64,
}

#[event]
pub struct HedgeVoided {
    pub group: u32,
}
