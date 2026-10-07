//! Underwriter vault: init, deposits and LP shares (task 2.1). Queued deposits and withdrawals: task 3.1.
//!
//! USDC is a classic SPL Token mint; the vault's USDC account and the share mint are PDAs owned by the SPL Token
//! program with the vault PDA as authority. Share prices always use `vault.equity`, never the token balance.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::math::shares_for_deposit;
use crate::state::*;
use crate::CoreError;

/// LP share decimals (same as USDC, so the first deposit mints 1:1).
pub const SHARE_DECIMALS: u8 = 6;

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = Vault::SIZE, seeds = [SEED_VAULT], bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        init, payer = admin, seeds = [SEED_VAULT_USDC], bump,
        token::mint = usdc_mint, token::authority = vault, token::token_program = token_program
    )]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(
        init, payer = admin, seeds = [SEED_SHARES], bump,
        mint::decimals = SHARE_DECIMALS, mint::authority = vault, mint::token_program = token_program
    )]
    pub share_mint: Account<'info, Mint>,
    #[account(address = config.usdc_mint @ CoreError::InvalidParam, mint::token_program = token_program)]
    pub usdc_mint: Account<'info, Mint>,
    /// Protocol fee destination: any USDC account.
    #[account(token::mint = usdc_mint, token::token_program = token_program)]
    pub fee_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_vault(ctx: Context<InitVault>) -> Result<()> {
    let v = &mut ctx.accounts.vault;
    v.usdc = ctx.accounts.vault_usdc.key();
    v.share_mint = ctx.accounts.share_mint.key();
    v.fee_account = ctx.accounts.fee_account.key();
    v.bump = ctx.bumps.vault;
    v.usdc_bump = ctx.bumps.vault_usdc;
    v.mint_bump = ctx.bumps.share_mint;
    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Account<'info, Mint>,
    #[account(
        mut, token::mint = config.usdc_mint, token::authority = depositor, token::token_program = token_program
    )]
    pub depositor_usdc: Account<'info, TokenAccount>,
    /// Receives the shares (any owner; the depositor chooses).
    #[account(mut, token::mint = share_mint, token::token_program = token_program)]
    pub depositor_shares: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Deposits `amount` USDC and mints shares at NAV (first deposit 1:1), rounded down. Only while no group is live:
/// deposits during a live weekend are queued (task 3.1, INV-6), so an LP cannot join after seeing the risk.
pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, CoreError::InvalidParam);
    let v = &ctx.accounts.vault;
    require!(v.live_groups == 0, CoreError::VaultLocked);
    let supply = ctx.accounts.share_mint.supply;
    let shares = shares_for_deposit(amount, v.equity, supply).ok_or(CoreError::Math)?;
    require!(shares > 0, CoreError::InvalidParam);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.depositor_usdc.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;
    let seeds: &[&[u8]] = &[SEED_VAULT, &[v.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.depositor_shares.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        shares,
    )?;
    let v = &mut ctx.accounts.vault;
    v.equity = v.equity.checked_add(amount).ok_or(CoreError::Math)?;
    let supply = supply.checked_add(shares).ok_or(CoreError::Math)?;
    emit!(Deposited { depositor: ctx.accounts.depositor.key(), amount, shares, equity: v.equity, supply });
    Ok(())
}

#[event]
pub struct Deposited {
    pub depositor: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub equity: u64,
    pub supply: u64,
}
