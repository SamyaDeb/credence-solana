//! `settle_policy` (task 2.5): permissionless, one policy per instruction.
//!
//! Payout = `pricing::realized_payout` (plan/02 §2). If the obligation is still open with USDC debt, the payout is
//! repaid into it through `repay_obligation_liquidity_v2` with the vault PDA signing (the caller's transaction must
//! refresh the reserves and the obligation first). klend repays at most the outstanding debt, so the vault's USDC
//! balance is measured before and after the CPI and whatever klend did not take goes to the policy owner's USDC account
//! in the same instruction. A closed or debt-free obligation is paid to the owner's wallet.
//!
//! The last policy of a group releases the group's premiums to `equity`, frees its capacity and marks the loss vector
//! settled.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

/// `Sysvar1nstructions1111111111111111111111111`.
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");

use crate::kamino::{repay_obligation_liquidity_v2, ObligationView, RepayV2, KLEND_PROGRAM_ID, XSTOCKS_MARKETS};
use crate::pricing::realized_payout;
use crate::state::*;
use crate::CoreError;

#[derive(Accounts)]
pub struct SettlePolicy<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut, seeds = [SEED_EPOCH, epoch.ticker.as_ref(), &epoch.closure_id.to_le_bytes()], bump = epoch.bump,
    )]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        mut,
        seeds = [SEED_POLICY, epoch.key().as_ref(), policy.owner.as_ref(), policy.obligation.as_ref()], bump = policy.bump,
        has_one = epoch @ CoreError::InvalidParam,
    )]
    pub policy: Box<Account<'info, Policy>>,
    #[account(mut, seeds = [SEED_LOSS, &epoch.closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    /// The policy owner's USDC account: receives the payout (or what klend did not take).
    #[account(mut, token::mint = config.usdc_mint, token::authority = policy.owner, token::token_program = token_program)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ CoreError::InvalidParam)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: must be `policy.obligation`; decoded with `ObligationView` when klend still owns it.
    #[account(mut, address = policy.obligation @ CoreError::InvalidParam)]
    pub obligation: UncheckedAccount<'info>,
    // klend accounts for the repay CPI, required while the obligation has debt (None otherwise). klend validates
    // them against the obligation and reserve; the program checks the program ids, the market, and that the reserve is
    // the obligation's USDC borrow.
    /// CHECK: one of the two xStocks markets (checked) and the obligation's market (klend `has_one`).
    pub lending_market: Option<UncheckedAccount<'info>>,
    /// CHECK: the obligation's USDC borrow reserve (checked against the decoded obligation).
    #[account(mut)]
    pub repay_reserve: Option<UncheckedAccount<'info>>,
    /// CHECK: the reserve's supply vault (klend checks).
    #[account(mut)]
    pub reserve_destination_liquidity: Option<UncheckedAccount<'info>>,
    /// CHECK: instructions sysvar (address checked).
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instruction_sysvar: Option<UncheckedAccount<'info>>,
    /// CHECK: obligation's debt-farm user state (klend checks); the klend program id when the reserve has no farm.
    #[account(mut)]
    pub obligation_farm_user_state: Option<UncheckedAccount<'info>>,
    /// CHECK: reserve's debt farm (klend checks); the klend program id when the reserve has no farm.
    #[account(mut)]
    pub reserve_farm_state: Option<UncheckedAccount<'info>>,
    /// CHECK: `["lma", market]` under klend (klend checks).
    pub lending_market_authority: Option<UncheckedAccount<'info>>,
    /// CHECK: program id checked in `kamino::repay_obligation_liquidity_v2`.
    pub farms_program: Option<UncheckedAccount<'info>>,
    /// CHECK: program id checked in `kamino::repay_obligation_liquidity_v2`.
    pub klend_program: Option<UncheckedAccount<'info>>,
}

pub fn handle_settle_policy<'info>(ctx: Context<'info, SettlePolicy<'info>>) -> Result<()> {
    let e = &ctx.accounts.epoch;
    let p = &ctx.accounts.policy;
    require!(e.state == epoch_state::SETTLED, CoreError::WrongEpochState);
    require!(p.state == policy_state::ACTIVE, CoreError::WrongEpochState);
    let payout = realized_payout(p.covered_value, p.debt, p.max_payout, e.close_price_wad, e.settle_price_wad)?;
    require!(payout <= p.max_payout, CoreError::Math); // INV-1
    require!(payout <= ctx.accounts.vault.equity, CoreError::VaultInsolvent);

    // Where the payout goes: into the obligation while it has USDC debt, else the owner's wallet.
    let open_debt = obligation_usdc_borrow(&ctx.accounts.obligation)?;
    let mut repaid = 0u64;
    if payout > 0 {
        if let Some(borrow_reserve) = open_debt {
            let a = &ctx.accounts;
            let need = |x: &Option<UncheckedAccount<'info>>| -> Result<AccountInfo<'info>> {
                x.as_ref().map(|u| u.to_account_info()).ok_or_else(|| error!(CoreError::KaminoAccountsMissing))
            };
            let (market, reserve, dest, ixs) =
                (need(&a.lending_market)?, need(&a.repay_reserve)?, need(&a.reserve_destination_liquidity)?, need(&a.instruction_sysvar)?);
            let (farm_user, farm_state, lma, farms, klend) = (
                need(&a.obligation_farm_user_state)?,
                need(&a.reserve_farm_state)?,
                need(&a.lending_market_authority)?,
                need(&a.farms_program)?,
                need(&a.klend_program)?,
            );
            require_keys_eq!(*reserve.key, borrow_reserve, CoreError::InvalidParam);
            require!(XSTOCKS_MARKETS.contains(market.key), CoreError::MarketNotAllowed);
            let before = ctx.accounts.vault_usdc.amount;
            let bump = ctx.accounts.vault.bump;
            let seeds: &[&[u8]] = &[SEED_VAULT, &[bump]];
            let vault_info = ctx.accounts.vault.to_account_info();
            let farm = |x: &AccountInfo<'info>| if *x.key == KLEND_PROGRAM_ID { None } else { Some(x.clone()) };
            let (farm_user, farm_state) = (farm(&farm_user), farm(&farm_state));
            repay_obligation_liquidity_v2(
                &RepayV2 {
                    owner: &vault_info,
                    obligation: ctx.accounts.obligation.as_ref(),
                    lending_market: &market,
                    repay_reserve: &reserve,
                    reserve_liquidity_mint: &ctx.accounts.usdc_mint.to_account_info(),
                    reserve_destination_liquidity: &dest,
                    user_source_liquidity: &ctx.accounts.vault_usdc.to_account_info(),
                    token_program: ctx.accounts.token_program.as_ref(),
                    instruction_sysvar: &ixs,
                    obligation_farm_user_state: farm_user.as_ref(),
                    reserve_farm_state: farm_state.as_ref(),
                    lending_market_authority: &lma,
                    farms_program: &farms,
                    klend_program: &klend,
                },
                payout,
                &[seeds],
            )?;
            ctx.accounts.vault_usdc.reload()?;
            // klend takes at most the outstanding debt (and never more than offered).
            repaid = before.checked_sub(ctx.accounts.vault_usdc.amount).ok_or(CoreError::Math)?;
            require!(repaid <= payout, CoreError::Math);
        }
        let rest = payout - repaid;
        if rest > 0 {
            let bump = ctx.accounts.vault.bump;
            let seeds: &[&[u8]] = &[SEED_VAULT, &[bump]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.vault_usdc.to_account_info(),
                        to: ctx.accounts.owner_usdc.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                rest,
            )?;
        }
    }

    record_settlement(&mut ctx.accounts.vault, &mut *ctx.accounts.loss.load_mut()?, payout)?;
    let e = &mut ctx.accounts.epoch;
    e.policies_settled = e.policies_settled.checked_add(1).ok_or(CoreError::Math)?;
    e.total_payout = e.total_payout.checked_add(payout).ok_or(CoreError::Math)?;
    let p = &mut ctx.accounts.policy;
    p.payout = payout;
    p.state = policy_state::SETTLED;
    emit!(PolicySettled {
        policy: p.key(),
        owner: p.owner,
        obligation: p.obligation,
        payout,
        repaid_into_obligation: repaid,
        paid_to_wallet: payout - repaid,
    });
    Ok(())
}

/// The obligation's USDC borrow reserve if klend still owns it and it has a borrow, else `None` (closed or repaid).
/// Phase 1 obligations have exactly one borrow (USDC), checked at purchase.
fn obligation_usdc_borrow(acc: &AccountInfo) -> Result<Option<Pubkey>> {
    if *acc.owner != KLEND_PROGRAM_ID || acc.data_is_empty() {
        return Ok(None);
    }
    let ob = ObligationView::load(acc)?;
    Ok(ob.borrows.iter().find(|b| b.1 > 0).map(|b| b.0))
}

/// Vault and group bookkeeping for one settled policy; the group's last policy releases premiums and capacity.
fn record_settlement(v: &mut Vault, l: &mut LossVector, payout: u64) -> Result<()> {
    v.equity = v.equity.checked_sub(payout).ok_or(CoreError::VaultInsolvent)?;
    v.total_payouts = v.total_payouts.checked_add(payout).ok_or(CoreError::Math)?;
    l.policies_settled = l.policies_settled.checked_add(1).ok_or(CoreError::Math)?;
    if l.policies_settled == l.policy_count {
        v.premiums_unearned = v.premiums_unearned.checked_sub(l.premiums).ok_or(CoreError::Math)?;
        v.equity = v.equity.checked_add(l.premiums).ok_or(CoreError::Math)?;
        v.reserved_total = v.reserved_total.checked_sub(l.max_loss).ok_or(CoreError::Math)?;
        v.live_groups = v.live_groups.checked_sub(1).ok_or(CoreError::Math)?;
        l.settled = 1;
    }
    Ok(())
}

#[event]
pub struct PolicySettled {
    pub policy: Pubkey,
    pub owner: Pubkey,
    pub obligation: Pubkey,
    pub payout: u64,
    pub repaid_into_obligation: u64,
    pub paid_to_wallet: u64,
}
