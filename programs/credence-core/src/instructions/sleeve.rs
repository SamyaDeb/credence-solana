//! The vault's PYUSD sleeve (W4): cover on the Sentora xStocks Market's PYUSD debt pays in PYUSD, from a PYUSD account
//! of the vault PDA (Token-2022 ATA). INV-14: the sleeve holds at least every live PYUSD policy's reservation less the
//! advances already paid from it (`Vault::pyusd_reserved − pyusd_advanced`); `buy_cover_multi` refuses PYUSD cover
//! beyond it.
//!
//! - `set_pyusd_sleeve` (admin): the vault PDA's PYUSD ATA becomes the sleeve.
//! - `fund_sleeve(pyusd_in, usdc_out)` (keeper): the keeper swaps USDC for PYUSD on Jupiter in its own transaction
//!   (never with klend, `RESTRICTED_PROGRAMS`), then sells the PYUSD to the vault here: `pyusd_in` into the sleeve,
//!   `usdc_out` from the vault's cash, at most `⌊pyusd_in × p × (1 + slippage)⌋` with p the PYUSD price of the Sentora
//!   PYUSD reserve refreshed in this slot (the swap's slippage is bounded); p ≥ 0.98 (a depegged PYUSD is not bought);
//!   the cash INV-13 keeps stays. Equity counts PYUSD at par: it moves by `pyusd_in − usdc_out` (the swap cost).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Mint as MintInterface, TokenAccount as TokenAccountInterface, TransferChecked};

use crate::kamino::{ReserveView, SF_SHIFT};
use crate::state::*;
use crate::CoreError;

/// A PYUSD price below this (0.98 USD) is refused: the sleeve counts PYUSD at par.
pub const PEG_FLOOR_BPS: u128 = 9_800;

#[derive(Accounts)]
pub struct SetPyusdSleeve<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(token::mint = config.pyusd_mint, token::authority = vault, token::token_program = token_2022_program)]
    pub sleeve: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handle_set_pyusd_sleeve(ctx: Context<SetPyusdSleeve>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(cfg.pyusd_mint != Pubkey::default(), CoreError::InvalidParam);
    let want = get_associated_token_address_with_program_id(&ctx.accounts.vault.key(), &cfg.pyusd_mint, &Token2022::id());
    require_keys_eq!(ctx.accounts.sleeve.key(), want, CoreError::InvalidParam);
    let v = &mut ctx.accounts.vault;
    require!(v.pyusd_reserved == 0, CoreError::InvalidParam); // not while PYUSD policies are live
    v.pyusd_sleeve = want;
    Ok(())
}

#[derive(Accounts)]
pub struct FundSleeve<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.keeper == keeper.key() @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = vault.pyusd_sleeve @ CoreError::InvalidParam)]
    pub sleeve: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(address = config.pyusd_mint @ CoreError::InvalidParam)]
    pub pyusd_mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(mut, token::mint = config.pyusd_mint, token::authority = keeper, token::token_program = token_2022_program)]
    pub keeper_pyusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = keeper, token::token_program = token_program)]
    pub keeper_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: a klend PYUSD reserve of an xStocks market (decoded; mint, market, refreshed this slot checked).
    pub pyusd_reserve: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handle_fund_sleeve(ctx: Context<FundSleeve>, pyusd_in: u64, usdc_out: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.config.paused, CoreError::Paused);
    require!(pyusd_in > 0 && usdc_out > 0, CoreError::InvalidParam);
    let r = ReserveView::load(&a.pyusd_reserve)?;
    require!(crate::kamino::XSTOCKS_MARKETS.contains(&r.lending_market), CoreError::MarketNotAllowed);
    require_keys_eq!(r.liquidity_mint, a.config.pyusd_mint, CoreError::InvalidParam);
    require!(r.last_update_slot == Clock::get()?.slot, CoreError::ReserveNotRefreshed);
    // Price in USD × 1e4: market_price_sf / 2^60 × 1e4, rounded DOWN.
    let p_bps = (r.market_price_sf.checked_mul(10_000).ok_or(CoreError::Math)?) >> SF_SHIFT;
    require!(p_bps >= PEG_FLOOR_BPS, CoreError::Depegged);
    // The most the vault pays: ⌊pyusd_in × p × (1 + slippage)⌋ (PYUSD and USDC both 6 decimals).
    let max_out = ((pyusd_in as u128)
        .checked_mul(r.market_price_sf)
        .ok_or(CoreError::Math)?
        .checked_mul(10_000 + a.config.sleeve_slippage_bps as u128)
        .ok_or(CoreError::Math)?
        / 10_000)
        >> SF_SHIFT;
    require!((usdc_out as u128) <= max_out, CoreError::SlippageTooHigh);
    // INV-13: the vault's cash after paying keeps what live groups and queues need.
    require!(a.vault_usdc.amount.checked_sub(usdc_out).is_some_and(|left| left >= a.vault.reserved_cash().unwrap_or(u64::MAX)), CoreError::BackstopBudget);

    token_interface::transfer_checked(
        CpiContext::new(
            a.token_2022_program.key(),
            TransferChecked { from: a.keeper_pyusd.to_account_info(), mint: a.pyusd_mint.to_account_info(), to: a.sleeve.to_account_info(), authority: a.keeper.to_account_info() },
        ),
        pyusd_in,
        a.pyusd_mint.decimals,
    )?;
    let seeds: &[&[u8]] = &[SEED_VAULT, &[a.vault.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.key(),
            Transfer { from: a.vault_usdc.to_account_info(), to: a.keeper_usdc.to_account_info(), authority: a.vault.to_account_info() },
            &[seeds],
        ),
        usdc_out,
    )?;
    let v = &mut ctx.accounts.vault;
    let delta = (pyusd_in as i128) - (usdc_out as i128); // the swap's cost (negative) or gain, PYUSD at par
    v.equity = u64::try_from((v.equity as i128).checked_add(delta).ok_or(CoreError::Math)?).map_err(|_| CoreError::VaultInsolvent)?;
    emit!(SleeveFunded { pyusd_in, usdc_out, price_bps: p_bps as u64 });
    Ok(())
}

#[event]
pub struct SleeveFunded {
    pub pyusd_in: u64,
    pub usdc_out: u64,
    /// PYUSD's klend price, USD × 1e4.
    pub price_bps: u64,
}
