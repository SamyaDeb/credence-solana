//! Test-only (task 1.3, W2): proves `repay_obligation_liquidity_v2` (how `settle_policy` pays into an obligation) and
//! `liquidate_obligation_and_redeem_reserve_collateral_v2` (how the W2 backstop liquidates) work through a
//! cross-program call signed by a PDA. Not part of the product; never deployed outside a fork.

use anchor_lang::prelude::*;
use credence_core::kamino::{
    liquidate_obligation_and_redeem_reserve_collateral_v2, repay_obligation_liquidity_v2, LiquidateV2, RepayV2, KLEND_PROGRAM_ID,
};

declare_id!("2Ljo3kQQ28heEfDHY1bsd9nw8Nq9msFpAaL37bDMbCsX");

pub const VAULT_AUTH_SEED: &[u8] = b"vault_auth";

#[program]
pub mod kamino_probe {
    use super::*;

    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        let a = &ctx.accounts;
        let bump = ctx.bumps.vault_authority;
        let seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[bump]];
        repay_obligation_liquidity_v2(
            &RepayV2 {
                owner: &a.vault_authority.to_account_info(),
                obligation: &a.obligation,
                lending_market: &a.lending_market,
                repay_reserve: &a.repay_reserve,
                reserve_liquidity_mint: &a.reserve_liquidity_mint,
                reserve_destination_liquidity: &a.reserve_destination_liquidity,
                user_source_liquidity: &a.user_source_liquidity,
                token_program: &a.token_program,
                instruction_sysvar: &a.instruction_sysvar,
                obligation_farm_user_state: Some(&a.obligation_farm_user_state),
                reserve_farm_state: Some(&a.reserve_farm_state),
                lending_market_authority: &a.lending_market_authority,
                farms_program: &a.farms_program,
                klend_program: &a.klend_program,
            },
            amount,
            &[seeds],
        )
    }

    /// W2 gate: a PDA-signed v2 liquidation. Farm slots holding the klend program id mean "no farm".
    pub fn liquidate<'info>(ctx: Context<'info, Liquidate<'info>>, amount: u64, min_received: u64) -> Result<()> {
        let a = &ctx.accounts;
        let seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[ctx.bumps.vault_authority]];
        let opt = |x: &UncheckedAccount<'info>| if *x.key == KLEND_PROGRAM_ID { None } else { Some(x.to_account_info()) };
        let (cu, cs, du, ds) = (opt(&a.collateral_farm_user_state), opt(&a.collateral_farm_state), opt(&a.debt_farm_user_state), opt(&a.debt_farm_state));
        liquidate_obligation_and_redeem_reserve_collateral_v2(
            &LiquidateV2 {
                liquidator: &a.vault_authority.to_account_info(),
                obligation: &a.obligation,
                lending_market: &a.lending_market,
                lending_market_authority: &a.lending_market_authority,
                repay_reserve: &a.repay_reserve,
                repay_reserve_liquidity_mint: &a.repay_reserve_liquidity_mint,
                repay_reserve_liquidity_supply: &a.repay_reserve_liquidity_supply,
                withdraw_reserve: &a.withdraw_reserve,
                withdraw_reserve_liquidity_mint: &a.withdraw_reserve_liquidity_mint,
                withdraw_reserve_collateral_mint: &a.withdraw_reserve_collateral_mint,
                withdraw_reserve_collateral_supply: &a.withdraw_reserve_collateral_supply,
                withdraw_reserve_liquidity_supply: &a.withdraw_reserve_liquidity_supply,
                withdraw_reserve_liquidity_fee_receiver: &a.withdraw_reserve_liquidity_fee_receiver,
                user_source_liquidity: &a.user_source_liquidity,
                user_destination_collateral: &a.user_destination_collateral,
                user_destination_liquidity: &a.user_destination_liquidity,
                collateral_token_program: &a.collateral_token_program,
                repay_liquidity_token_program: &a.repay_liquidity_token_program,
                withdraw_liquidity_token_program: &a.withdraw_liquidity_token_program,
                instruction_sysvar: &a.instruction_sysvar,
                collateral_farm_user_state: cu.as_ref(),
                collateral_farm_state: cs.as_ref(),
                debt_farm_user_state: du.as_ref(),
                debt_farm_state: ds.as_ref(),
                farms_program: &a.farms_program,
                klend_program: &a.klend_program,
            },
            amount,
            min_received,
            &[seeds],
        )
    }
}

/// Probe only: every account is forwarded to klend, which validates it.
#[derive(Accounts)]
pub struct Liquidate<'info> {
    /// CHECK: PDA that owns the liquidator token accounts; signs the CPI.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: klend validates (allow-list checked in credence_core::kamino).
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    #[account(mut)]
    pub repay_reserve: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    pub repay_reserve_liquidity_mint: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    #[account(mut)]
    pub repay_reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    #[account(mut)]
    pub withdraw_reserve: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    pub withdraw_reserve_liquidity_mint: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    #[account(mut)]
    pub withdraw_reserve_collateral_mint: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    #[account(mut)]
    pub withdraw_reserve_collateral_supply: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    #[account(mut)]
    pub withdraw_reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    #[account(mut)]
    pub withdraw_reserve_liquidity_fee_receiver: UncheckedAccount<'info>,
    /// CHECK: token program validates.
    #[account(mut)]
    pub user_source_liquidity: UncheckedAccount<'info>,
    /// CHECK: token program validates.
    #[account(mut)]
    pub user_destination_collateral: UncheckedAccount<'info>,
    /// CHECK: token program validates.
    #[account(mut)]
    pub user_destination_liquidity: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    pub collateral_token_program: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    pub repay_liquidity_token_program: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    pub withdraw_liquidity_token_program: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    pub instruction_sysvar: UncheckedAccount<'info>,
    /// CHECK: farms validates. Not `mut` here: an absent farm is klend's program id, which the runtime demotes to
    /// read-only; a real farm is passed writable by the transaction.
    pub collateral_farm_user_state: UncheckedAccount<'info>,
    /// CHECK: farms validates. Not `mut` here: an absent farm is klend's program id, which the runtime demotes to
    /// read-only; a real farm is passed writable by the transaction.
    pub collateral_farm_state: UncheckedAccount<'info>,
    /// CHECK: farms validates. Not `mut` here: an absent farm is klend's program id, which the runtime demotes to
    /// read-only; a real farm is passed writable by the transaction.
    pub debt_farm_user_state: UncheckedAccount<'info>,
    /// CHECK: farms validates. Not `mut` here: an absent farm is klend's program id, which the runtime demotes to
    /// read-only; a real farm is passed writable by the transaction.
    pub debt_farm_state: UncheckedAccount<'info>,
    /// CHECK: id checked in credence_core::kamino.
    pub farms_program: UncheckedAccount<'info>,
    /// CHECK: id checked in credence_core::kamino.
    pub klend_program: UncheckedAccount<'info>,
}

/// Probe only: accounts are forwarded to klend, which validates them. Product instructions validate every account.
#[derive(Accounts)]
pub struct Repay<'info> {
    /// CHECK: PDA that owns `user_source_liquidity`; signs the CPI.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: klend validates; market allow-list checked in credence_core::kamino.
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    #[account(mut)]
    pub repay_reserve: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    pub reserve_liquidity_mint: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    #[account(mut)]
    pub reserve_destination_liquidity: UncheckedAccount<'info>,
    /// CHECK: token program validates.
    #[account(mut)]
    pub user_source_liquidity: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    pub instruction_sysvar: UncheckedAccount<'info>,
    /// CHECK: farms validates.
    #[account(mut)]
    pub obligation_farm_user_state: UncheckedAccount<'info>,
    /// CHECK: farms validates.
    #[account(mut)]
    pub reserve_farm_state: UncheckedAccount<'info>,
    /// CHECK: klend validates.
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: id checked in credence_core::kamino.
    pub farms_program: UncheckedAccount<'info>,
    /// CHECK: id checked in credence_core::kamino.
    pub klend_program: UncheckedAccount<'info>,
}
