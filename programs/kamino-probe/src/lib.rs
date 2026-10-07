//! Test-only (task 1.3): proves `repay_obligation_liquidity_v2` works through a cross-program call signed by a PDA,
//! which is how `settle_policy` pays into an obligation. Not part of the product; never deployed outside a fork.

use anchor_lang::prelude::*;
use credence_core::kamino::{repay_obligation_liquidity_v2, RepayV2};

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
