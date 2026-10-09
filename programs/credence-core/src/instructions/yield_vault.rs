//! Yield vault (W3): idle USDC earns the xStocks Market USDC reserve's supply rate.
//!
//! - `set_yield_reserve(cash_headroom_wad)` (admin): the klend USDC reserve (one of the two xStocks markets, liquidity
//!   mint = USDC) and the vault PDA's cToken ATA; only while nothing is lent.
//! - `rebalance` (keeper): keeps vault cash at the **buffer** and lends the rest:
//!   `buffer = reserved cash (INV-13: Σ live groups' reserved worst loss, shield included since task 1.2, + unearned
//!   premiums + queued deposits) + queued withdrawals at NAV + the backstop's unspent share + headroom × cover equity`,
//!   rounded UP. Above it by more than [`MIN_MOVE`], `deposit_reserve_liquidity` (not while paused); below it,
//!   `redeem_reserve_collateral` for the shortfall, limited to the reserve's available liquidity (at 100% utilisation
//!   nothing can be redeemed: the buffer is what pays, which is why it is cash). Then it values the position from the
//!   reserve klend just refreshed (`risk-core::ctoken_value`, rounded down) and books the change as yield in equity.
//!
//! Yield is recognised only here (INV-5): between rebalances share prices use the last valuation, and they refuse one
//! older than `MARK_MAX_AGE_SECS` while anything is lent, so nobody buys or redeems shares around an unbooked accrual.
//! The keeper rebalances before it processes queues. Payouts, shield advances, backstop purchases and withdrawals
//! always pay from cash (`buy_cover` refuses cover the cash does not back).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::{Mint, Token, TokenAccount};
use credence_risk_core::{ctoken_value, ctokens_for};

use crate::instructions::settle::INSTRUCTIONS_SYSVAR_ID;
use crate::kamino::{deposit_reserve_liquidity, redeem_reserve_collateral, ReserveLiquidity, ReserveView, XSTOCKS_MARKETS};
use crate::math::WAD;
use crate::state::*;
use crate::CoreError;

/// Moves smaller than this (1 USDC) are skipped: not worth a CPI, and dust stays cash.
pub const MIN_MOVE: u64 = 1_000_000;

#[derive(Accounts)]
pub struct SetYieldReserve<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: a klend USDC reserve of an xStocks market (decoded and checked).
    pub reserve: UncheckedAccount<'info>,
    /// The vault PDA's ATA for the reserve's cToken mint (created by the client).
    #[account(token::authority = vault, token::token_program = token_program)]
    pub kusdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_set_yield_reserve(ctx: Context<SetYieldReserve>, cash_headroom_wad: u64) -> Result<()> {
    require!(cash_headroom_wad <= WAD as u64, CoreError::InvalidParam);
    let r = ReserveView::load(&ctx.accounts.reserve)?;
    require!(XSTOCKS_MARKETS.contains(&r.lending_market), CoreError::MarketNotAllowed);
    require_keys_eq!(r.liquidity_mint, ctx.accounts.config.usdc_mint, CoreError::InvalidParam);
    let vault_key = ctx.accounts.vault.key();
    let want = get_associated_token_address_with_program_id(&vault_key, &r.collateral_mint, &Token::id());
    require_keys_eq!(ctx.accounts.kusdc.key(), want, CoreError::InvalidParam);
    let v = &mut ctx.accounts.vault;
    // The reserve can change only while nothing is lent (the booked position belongs to the old one).
    require!(v.lent_ctokens == 0 || v.yield_reserve == ctx.accounts.reserve.key(), CoreError::YieldPositionOpen);
    v.yield_reserve = ctx.accounts.reserve.key();
    v.kusdc = want;
    v.cash_headroom_wad = cash_headroom_wad;
    Ok(())
}

#[derive(Accounts)]
pub struct Rebalance<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.keeper == keeper.key() @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Box<Account<'info, Mint>>,
    /// The backstop pool: its unspent share of equity stays cash for the open. Required (audit A-41: optional, a
    /// rebalance without it lent that cash).
    #[account(seeds = [SEED_BACKSTOP], bump = pool.bump)]
    pub pool: Box<Account<'info, BackstopPool>>,
    #[account(mut, address = vault.kusdc @ CoreError::InvalidParam)]
    pub kusdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: `vault.yield_reserve` (address checked; decoded).
    #[account(mut, address = vault.yield_reserve @ CoreError::InvalidParam)]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: the reserve's market (checked against the decoded reserve).
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: `["lma", market]` under klend (klend checks).
    pub lending_market_authority: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ CoreError::InvalidParam)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: the reserve's liquidity supply vault (checked).
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: the reserve's cToken mint (checked).
    #[account(mut)]
    pub reserve_collateral_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: instructions sysvar (address checked).
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
    /// CHECK: program id checked in the CPI helpers.
    pub klend_program: UncheckedAccount<'info>,
}

/// The cash the vault keeps (module docs), USDC, rounded UP. `unbooked` is yield this rebalance is about to book:
/// queued withdrawals are paid at the NAV after it, so the buffer counts it.
pub fn cash_buffer(v: &Vault, share_supply: u64, pool: Option<&BackstopPool>, unbooked: u64) -> Result<u64> {
    let nav = v.nav_unchecked()?.checked_add(unbooked).ok_or(CoreError::Math)?;
    let queued_wd = if share_supply == 0 {
        0
    } else {
        u64::try_from(((v.queued_withdraw_shares as u128) * (nav as u128)).div_ceil(share_supply as u128)).map_err(|_| CoreError::Math)?
    };
    let backstop = match pool {
        Some(p) => {
            let share = ((v.equity as u128) * (p.max_share_wad as u128)).div_ceil(WAD);
            u64::try_from(share.saturating_sub(v.inventory_cost()? as u128)).map_err(|_| CoreError::Math)?
        }
        None => 0,
    };
    let headroom = u64::try_from(((v.cover_equity()? as u128) * (v.cash_headroom_wad as u128)).div_ceil(WAD)).map_err(|_| CoreError::Math)?;
    v.reserved_cash()?
        .checked_add(queued_wd)
        .and_then(|x| x.checked_add(backstop))
        .and_then(|x| x.checked_add(headroom))
        .ok_or_else(|| error!(CoreError::Math))
}

pub fn handle_rebalance(ctx: Context<Rebalance>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let slot = Clock::get()?.slot;
    let a = &ctx.accounts;
    let r0 = ReserveView::load(&a.reserve)?;
    require_keys_eq!(r0.lending_market, *a.lending_market.key, CoreError::InvalidParam);
    require_keys_eq!(r0.supply_vault, *a.reserve_liquidity_supply.key, CoreError::InvalidParam);
    require_keys_eq!(r0.collateral_mint, *a.reserve_collateral_mint.key, CoreError::InvalidParam);
    require_keys_eq!(r0.collateral_mint, a.kusdc.mint, CoreError::InvalidParam);

    // Yield accrued since the last booking, on the reserve as refreshed this slot (else not known yet: 0, and the next
    // rebalance with a refresh sizes for it).
    let unbooked = if r0.last_update_slot == slot {
        let v0 = ctoken_value(a.kusdc.amount, r0.total_supply_sf()?, r0.collateral_mint_total_supply).map_err(|_| error!(CoreError::Math))?;
        v0.saturating_sub(a.vault.lent_value)
    } else {
        0
    };
    let buffer = cash_buffer(&a.vault, a.share_mint.supply, Some(&a.pool), unbooked)?;
    let (cash0, k0) = (a.vault_usdc.amount, a.kusdc.amount);
    let seeds: &[&[u8]] = &[SEED_VAULT, &[a.vault.bump]];
    let accts = ReserveLiquidity {
        owner: &a.vault.to_account_info(),
        reserve: a.reserve.as_ref(),
        lending_market: a.lending_market.as_ref(),
        lending_market_authority: a.lending_market_authority.as_ref(),
        reserve_liquidity_mint: &a.usdc_mint.to_account_info(),
        reserve_liquidity_supply: a.reserve_liquidity_supply.as_ref(),
        reserve_collateral_mint: a.reserve_collateral_mint.as_ref(),
        user_liquidity: &a.vault_usdc.to_account_info(),
        user_collateral: &a.kusdc.to_account_info(),
        collateral_token_program: a.token_program.as_ref(),
        liquidity_token_program: a.token_program.as_ref(),
        instruction_sysvar: a.instruction_sysvar.as_ref(),
        klend_program: a.klend_program.as_ref(),
    };
    let mut skipped_illiquid = false;
    if cash0 > buffer.saturating_add(MIN_MOVE) {
        // Lending more is risk-increasing: not while paused.
        if !a.config.paused {
            deposit_reserve_liquidity(&accts, cash0 - buffer, &[seeds])?;
        }
    } else if cash0 < buffer && k0 > 0 {
        let need = buffer - cash0;
        let total = r0.total_supply_sf()?;
        let mut c = ctokens_for(need, total, r0.collateral_mint_total_supply).map_err(|_| error!(CoreError::Math))?.min(k0);
        // At most what the reserve can pay out now (utilisation can leave nothing): the buffer is cash for that reason.
        let liquid = ctokens_for(r0.available_amount, total, r0.collateral_mint_total_supply).map_err(|_| error!(CoreError::Math))?;
        if c > liquid {
            c = liquid.saturating_sub(1);
            skipped_illiquid = true;
        }
        if c > 0 && ctoken_value(c, total, r0.collateral_mint_total_supply).map_err(|_| error!(CoreError::Math))? >= MIN_MOVE {
            redeem_reserve_collateral(&accts, c, &[seeds])?;
        }
    }

    let a = &mut *ctx.accounts;
    a.vault_usdc.reload()?;
    a.kusdc.reload()?;
    let (cash1, k1) = (a.vault_usdc.amount, a.kusdc.amount);
    // Valued on the reserve as klend left it this slot. klend's deposit and redeem refresh the reserve themselves (no
    // refresh instruction needed, verified in `tests/yield_vault.rs`) and then set its `stale` flag, which only asks the
    // next price user to refresh again: the supply and exchange rate are this slot's. Without a move, the keeper's
    // `refresh_reserve` earlier in the transaction is what makes it this slot's.
    let r1 = ReserveView::load(&a.reserve)?;
    require!(r1.last_update_slot == slot, CoreError::ReserveNotRefreshed);
    let value = ctoken_value(k1, r1.total_supply_sf()?, r1.collateral_mint_total_supply).map_err(|_| error!(CoreError::Math))?;
    // Book: cash moved at par in or out of the position; the rest of the change is yield.
    let v = &mut a.vault;
    let moved_in = (cash0 as i128) - (cash1 as i128); // > 0: deposited; < 0: redeemed
    let expected = (v.lent_value as i128) + moved_in;
    let yield_now = (value as i128) - expected;
    let equity = (v.equity as i128).checked_add(yield_now).ok_or(CoreError::Math)?;
    v.equity = u64::try_from(equity).map_err(|_| CoreError::VaultInsolvent)?;
    v.lent_ctokens = k1;
    v.lent_value = value;
    v.lent_valued_at = now;
    v.yield_recognized = v
        .yield_recognized
        .checked_add(i64::try_from(yield_now).map_err(|_| CoreError::Math)?)
        .ok_or(CoreError::Math)?;
    emit!(Rebalanced {
        buffer,
        cash_before: cash0,
        cash_after: cash1,
        ctokens_before: k0,
        ctokens_after: k1,
        lent_value: value,
        yield_recognized: yield_now as i64,
        illiquid: skipped_illiquid,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ValueYield<'info> {
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(address = vault.kusdc @ CoreError::InvalidParam)]
    pub kusdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: `vault.yield_reserve` (address checked; decoded).
    #[account(address = vault.yield_reserve @ CoreError::InvalidParam)]
    pub reserve: UncheckedAccount<'info>,
}

/// Books the lending position's yield without moving anything (anyone): the reserve must have been refreshed in this
/// slot (`refresh_reserve` earlier in the transaction). Lets a depositor's or withdrawer's transaction carry its own
/// fresh valuation (INV-5) between the keeper's rebalances.
pub fn handle_value_yield(ctx: Context<ValueYield>) -> Result<()> {
    let clock = Clock::get()?;
    let r = ReserveView::load(&ctx.accounts.reserve)?;
    require!(r.last_update_slot == clock.slot, CoreError::ReserveNotRefreshed);
    let k = ctx.accounts.kusdc.amount;
    let v = &mut ctx.accounts.vault;
    // Only the booked cTokens count (a transfer into the ATA is not the LPs' yield to book here; `rebalance` books the
    // balance it moved).
    let booked = ctoken_value(k.min(v.lent_ctokens), r.total_supply_sf()?, r.collateral_mint_total_supply).map_err(|_| error!(CoreError::Math))?;
    let y = (booked as i128) - (v.lent_value as i128);
    let equity = (v.equity as i128).checked_add(y).ok_or(CoreError::Math)?;
    v.equity = u64::try_from(equity).map_err(|_| CoreError::VaultInsolvent)?;
    v.lent_value = booked;
    v.lent_valued_at = clock.unix_timestamp;
    v.yield_recognized = v.yield_recognized.checked_add(i64::try_from(y).map_err(|_| CoreError::Math)?).ok_or(CoreError::Math)?;
    emit!(Rebalanced {
        buffer: 0, cash_before: 0, cash_after: 0, ctokens_before: v.lent_ctokens, ctokens_after: v.lent_ctokens,
        lent_value: booked, yield_recognized: y as i64, illiquid: false,
    });
    Ok(())
}

#[event]
pub struct Rebalanced {
    pub buffer: u64,
    pub cash_before: u64,
    pub cash_after: u64,
    pub ctokens_before: u64,
    pub ctokens_after: u64,
    /// The position's value after the move, USDC (rounded down).
    pub lent_value: u64,
    /// Booked into equity by this rebalance (signed; rounding at a deposit is a few base units negative).
    pub yield_recognized: i64,
    /// The redemption was limited by the reserve's available liquidity.
    pub illiquid: bool,
}
