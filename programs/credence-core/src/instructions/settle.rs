//! `settle_policy` (task 2.5) and `settle_policy_to_wallet`: permissionless, one policy per instruction.
//!
//! Payout = `pricing::realized_payout`. If the obligation still borrows from the reserve recorded at
//! purchase (`Policy.borrow_reserve`, non-zero amount), the payout is repaid into it through
//! `repay_obligation_liquidity_v2` with the vault PDA signing (the caller's transaction must refresh the reserves and
//! the obligation first). klend repays at most the outstanding debt, so the vault's USDC balance is measured before and
//! after the CPI and whatever klend did not take goes to the policy owner's USDC account in the same instruction. A
//! closed obligation, or one that no longer borrows from that reserve (the owner repaid and borrowed something else),
//! is paid to the owner's wallet: the CPI is never sent against a reserve the policy was not bought on.
//!
//! The owner can still make the repay CPI fail (or klend can: stale Scope price, paused market, farm accounts). A
//! group releases premiums and capacity only when all its policies are settled, so one stuck policy would freeze the
//! group. `settle_policy_to_wallet` is the exit: anyone may call it `SETTLE_GRACE` after the settlement price was
//! posted; it pays the whole payout to the owner's wallet and never calls klend.
//!
//! The last policy of a group releases the group's premiums to `equity`, frees its capacity and marks the loss vector
//! settled ([`record_settlement`]).
//!
//! Liquidation Shield (W1): a policy that received advances before the open (`Policy.advanced`, already paid from
//! equity) is paid `max(0, payout rule − advanced)` here. When the advance was larger than the payout rule, nothing
//! more is paid and the difference stays the vault's loss (booked when it was advanced). INV-10:
//! `advanced + paid here ≤ max_payout`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

/// After the settlement price is posted, the keeper has this long to repay into obligations; then anyone may pay a
/// still-active policy to the owner's wallet (`settle_policy_to_wallet`).
pub const SETTLE_GRACE: i64 = 3600;

/// `Sysvar1nstructions1111111111111111111111111`.
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");

use crate::kamino::{repay_obligation_liquidity_v2, ObligationView, RepayV2, ReserveView, KLEND_PROGRAM_ID, XSTOCKS_MARKETS};
use crate::pricing::{accrued_debt, realized_payout};
use crate::state::*;
use crate::CoreError;

#[derive(Accounts)]
pub struct SettlePolicy<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, seeds = [SEED_EPOCH, epoch.ticker.as_ref(), &epoch.closure_id.to_le_bytes()], bump = epoch.bump,
    )]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        mut,
        seeds = [SEED_POLICY, epoch.key().as_ref(), policy.obligation.as_ref()], bump = policy.bump,
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
    // klend accounts for the repay CPI, required while the obligation borrows from `policy.borrow_reserve` (None
    // otherwise). klend validates them against the obligation and reserve; the program checks the program ids, the
    // market, and that the reserve is the policy's borrow reserve.
    /// CHECK: one of the two xStocks markets (checked) and the obligation's market (klend `has_one`).
    pub lending_market: Option<UncheckedAccount<'info>>,
    /// CHECK: `policy.borrow_reserve` (checked).
    #[account(mut)]
    pub repay_reserve: Option<UncheckedAccount<'info>>,
    /// CHECK: the reserve's supply vault (klend checks).
    #[account(mut)]
    pub reserve_destination_liquidity: Option<UncheckedAccount<'info>>,
    /// CHECK: instructions sysvar (address checked).
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instruction_sysvar: Option<UncheckedAccount<'info>>,
    /// CHECK: obligation's debt-farm user state (klend checks); the klend program id when the reserve has no farm.
    /// Not `mut` (audit A-21): without a debt farm this slot is klend's program id, which the runtime demotes to
    /// read-only; a real farm is passed writable by the client and klend's CPI meta asks for it writable.
    pub obligation_farm_user_state: Option<UncheckedAccount<'info>>,
    /// CHECK: reserve's debt farm (klend checks); the klend program id when the reserve has no farm. Not `mut` (A-21).
    pub reserve_farm_state: Option<UncheckedAccount<'info>>,
    /// CHECK: `["lma", market]` under klend (klend checks).
    pub lending_market_authority: Option<UncheckedAccount<'info>>,
    /// CHECK: program id checked in `kamino::repay_obligation_liquidity_v2`.
    pub farms_program: Option<UncheckedAccount<'info>>,
    /// CHECK: program id checked in `kamino::repay_obligation_liquidity_v2`.
    pub klend_program: Option<UncheckedAccount<'info>>,
}

pub fn handle_settle_policy<'info>(ctx: Context<'info, SettlePolicy<'info>>) -> Result<()> {
    // Where the payout goes: into the obligation while it still borrows from the policy's reserve, else the wallet.
    let borrow_reserve = ctx.accounts.policy.borrow_reserve;
    let repay_into_obligation = obligation_borrows_from(&ctx.accounts.obligation, &borrow_reserve)?;
    // Into the obligation the payout restores health on the debt it carries at the open: the snapshot plus klend's
    // interest on it since purchase, capped (task 1.2). To a wallet (no debt left to restore), the snapshot.
    // While the obligation borrows, the reserve is required even if the payout turns out 0: leaving it out must not
    // switch the rule to the snapshot debt (audit A-37).
    let debt = match (&ctx.accounts.repay_reserve, repay_into_obligation) {
        (Some(r), true) => {
            require_keys_eq!(r.key(), borrow_reserve, CoreError::InvalidParam);
            accrued_debt(&ctx.accounts.policy, ReserveView::load(r)?.cumulative_borrow_rate_bsf)?
        }
        (None, true) => return err!(CoreError::KaminoAccountsMissing),
        _ => ctx.accounts.policy.debt,
    };
    let group_premiums = ctx.accounts.loss.load()?.premiums;
    let (payout, shortfall) = payout_due(&ctx.accounts.epoch, &ctx.accounts.policy, &ctx.accounts.vault, group_premiums, debt)?;
    let mut repaid = 0u64;
    if payout > 0 && repay_into_obligation {
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
    let a = &mut *ctx.accounts;
    pay_from_vault(&a.token_program, &a.vault, &a.vault_usdc, &a.owner_usdc, payout - repaid)?;
    finish_policy(&mut a.vault, &mut *a.loss.load_mut()?, &mut a.epoch, &mut a.policy, payout, repaid, shortfall)
}

#[derive(Accounts)]
pub struct SettlePolicyToWallet<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, seeds = [SEED_EPOCH, epoch.ticker.as_ref(), &epoch.closure_id.to_le_bytes()], bump = epoch.bump,
    )]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        mut,
        seeds = [SEED_POLICY, epoch.key().as_ref(), policy.obligation.as_ref()], bump = policy.bump,
        has_one = epoch @ CoreError::InvalidParam,
    )]
    pub policy: Box<Account<'info, Policy>>,
    #[account(mut, seeds = [SEED_LOSS, &epoch.closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    /// The policy owner's USDC account: receives the whole payout.
    #[account(mut, token::mint = config.usdc_mint, token::authority = policy.owner, token::token_program = token_program)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Fallback when `settle_policy` cannot complete (the repay CPI fails): `SETTLE_GRACE` after the settlement price was
/// posted, anyone may pay the policy's whole payout to the owner's wallet. Never calls klend, so nothing the owner or
/// Kamino does can keep the group from releasing.
pub fn handle_settle_policy_to_wallet(ctx: Context<SettlePolicyToWallet>) -> Result<()> {
    let group_premiums = ctx.accounts.loss.load()?.premiums;
    let (payout, shortfall) =
        payout_due(&ctx.accounts.epoch, &ctx.accounts.policy, &ctx.accounts.vault, group_premiums, ctx.accounts.policy.debt)?;
    let after = ctx.accounts.epoch.settled_at.checked_add(SETTLE_GRACE).ok_or(CoreError::Math)?;
    require!(Clock::get()?.unix_timestamp >= after, CoreError::TooEarly);
    let a = &mut *ctx.accounts;
    pay_from_vault(&a.token_program, &a.vault, &a.vault_usdc, &a.owner_usdc, payout)?;
    finish_policy(&mut a.vault, &mut *a.loss.load_mut()?, &mut a.epoch, &mut a.policy, payout, 0, shortfall)
}

/// The payout of an active policy on a settled epoch: the payout rule, checked against its cap (INV-1), and at most
/// what can back it: the vault's equity plus the group's own premiums not yet released to it. INV-2 bounds the worst
/// joint stress scenario, not every possible gap, so a weekend beyond all of them can owe more than that; then
/// policies are paid in settlement order until it runs out, and the rest are paid what remains (possibly 0) instead
/// of failing forever, which would keep their group live and every LP withdrawal waiting on it. The shortfall is in
/// `PolicySettled`.
///
/// With shield advances the amount due here is the payout rule net of them, `max(0, owed − advanced)`; the shortfall
/// is measured on that remainder. `debt` is the snapshot, or with interest when paying into the obligation (task 1.2).
fn payout_due(e: &Epoch, p: &Policy, v: &Vault, group_premiums: u64, debt: u64) -> Result<(u64, u64)> {
    require!(e.state == epoch_state::SETTLED, CoreError::WrongEpochState);
    require!(p.state == policy_state::ACTIVE, CoreError::WrongEpochState);
    let owed = realized_payout(p.covered_value, debt, p.max_payout, e.close_price_wad, e.settle_price_wad)?;
    require!(owed <= p.max_payout, CoreError::Math); // INV-1
    let remainder = owed.saturating_sub(p.advanced);
    // Backed by cash: equity less backstop inventory (W2), plus the group's own unearned premiums.
    let payout = remainder.min(v.cover_equity()?.saturating_add(group_premiums));
    // INV-10: advances plus this payout never exceed the cap.
    require!(p.advanced.checked_add(payout).is_some_and(|t| t <= p.max_payout), CoreError::Math);
    Ok((payout, remainder - payout))
}

/// Transfers `amount` USDC from the vault to `to`, the vault PDA signing. No-op for 0.
pub(crate) fn pay_from_vault<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, Vault>,
    vault_usdc: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[SEED_VAULT, &[vault.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer { from: vault_usdc.to_account_info(), to: to.to_account_info(), authority: vault.to_account_info() },
            &[seeds],
        ),
        amount,
    )
}

/// Marks the policy settled, books the payout on the epoch, vault and group, and emits `PolicySettled`.
fn finish_policy(
    v: &mut Vault,
    l: &mut LossVector,
    e: &mut Epoch,
    p: &mut Account<Policy>,
    payout: u64,
    repaid: u64,
    shortfall: u64,
) -> Result<()> {
    record_settlement(v, l, payout)?;
    e.policies_settled = e.policies_settled.checked_add(1).ok_or(CoreError::Math)?;
    e.total_payout = e.total_payout.checked_add(payout).ok_or(CoreError::Math)?;
    p.payout = p.advanced.checked_add(payout).ok_or(CoreError::Math)?;
    p.state = policy_state::SETTLED;
    emit!(PolicySettled {
        policy: p.key(),
        owner: p.owner,
        obligation: p.obligation,
        payout,
        repaid_into_obligation: repaid,
        paid_to_wallet: payout - repaid,
        shortfall,
        advanced: p.advanced,
    });
    Ok(())
}

/// True if klend still owns the obligation and it borrows from `reserve` with a non-zero amount. False for a closed
/// obligation, a repaid borrow, or a borrow moved to another reserve.
pub(crate) fn obligation_borrows_from(acc: &AccountInfo, reserve: &Pubkey) -> Result<bool> {
    if *acc.owner != KLEND_PROGRAM_ID || acc.data_is_empty() {
        return Ok(false);
    }
    let ob = ObligationView::load(acc)?;
    Ok(ob.borrows.iter().any(|b| b.0 == *reserve && b.1 > 0))
}

/// Vault and group bookkeeping for one finished policy (settled or, for a voided epoch, refunded); the group's last
/// policy releases premiums and capacity. The payout comes out of equity first; only beyond equity (a weekend worse
/// than every stress scenario) out of the group's unearned premiums, which would otherwise go to the LPs. "Equity" here is
/// cover equity: never the backstop inventory's book value (audit A-33).
pub(crate) fn record_settlement(v: &mut Vault, l: &mut LossVector, payout: u64) -> Result<()> {
    // Equity that backs cover only: the backstop inventory's book value is not cash and stays booked (audit A-33).
    let from_equity = payout.min(v.cover_equity()?);
    let from_premiums = payout - from_equity;
    v.equity -= from_equity;
    l.premiums = l.premiums.checked_sub(from_premiums).ok_or(CoreError::VaultInsolvent)?;
    v.premiums_unearned = v.premiums_unearned.checked_sub(from_premiums).ok_or(CoreError::Math)?;
    v.total_payouts = v.total_payouts.checked_add(payout).ok_or(CoreError::Math)?;
    l.policies_settled = l.policies_settled.checked_add(1).ok_or(CoreError::Math)?;
    if l.policies_settled == l.policy_count {
        v.premiums_unearned = v.premiums_unearned.checked_sub(l.premiums).ok_or(CoreError::Math)?;
        v.equity = v.equity.checked_add(l.premiums).ok_or(CoreError::Math)?;
        v.reserved_total = v.reserved_total.checked_sub(l.max_loss).ok_or(CoreError::Math)?;
        v.advanced_live = v.advanced_live.checked_sub(l.advanced).ok_or(CoreError::Math)?; // A-34
        v.remove_live(l.group)?;
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
    /// What the payout rule owed beyond the vault's remaining equity (0 unless the vault ran out).
    pub shortfall: u64,
    /// Shield advances paid before the open (`payout` is what settlement added on top).
    pub advanced: u64,
}
