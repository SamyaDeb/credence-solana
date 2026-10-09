//! Book legs at the weekend and the open (C2): the shield, settlement and the unpaid exits. One code path per lender:
//! a leg advances through the same `shield_kamino` / `shield_jl` and settles on the same `payout_due`, `repay_kamino` /
//! `operate_payback` as an owner's policy; only where the money may go differs.
//!
//! - **Never a wallet (INV-7, INV-11).** A leg's payout goes into its position or stays in the vault. What klend or
//!   Jupiter does not take (a position that owes less than the payout) stays in the vault.
//! - **A leg pays only on a sealed book**; an OPEN one is voided at its expiry (`void_book_leg`).
//! - **Unpaid legs refund their share, only when the vault kept an owed payout** (audit A-84): a position that no
//!   longer borrows at settlement, or whose payment could not go through within `SETTLE_GRACE` (`close_out_book_leg`),
//!   is paid 0, and its share of the book's net premium is owed to the payer **if the payout rule owed it something**.
//!   A leg that owed nothing earned its premium (the vault bore the weekend), so closing a position before the open is
//!   not a free option on the gap. An epoch voided for want of a close refunds the share as `refund_policy` does.
//! - INV-16: a book's advances never exceed Σ its live legs' `worst_loss`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token::{Token, TokenAccount};
use anchor_spl::token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface, TokenInterface};

use crate::instructions::book::accrue_refund;
use crate::instructions::jupiter_lend::*; // composite accounts need the derive's generated modules
use crate::instructions::settle::{
    finish_policy, is_pyusd, obligation_borrows_from, pay_mint, pay_source, payout_due, record_settlement, release_pyusd, repay_kamino, settle_legs,
    KlendRepay, INSTRUCTIONS_SYSVAR_ID, SETTLE_GRACE,
};
use crate::instructions::shield::*;
use crate::jupiter::{operate_payback, JL_VAULTS_PROGRAM_ID};
use crate::kamino::ReserveView;
use crate::pricing::accrued_debt;
use crate::state::*;
use crate::CoreError;

fn require_sealed(b: &Book) -> Result<()> {
    require!(b.state == book_state::SEALED, CoreError::BookNotSealed);
    Ok(())
}

/// Books an advance on the leg's book; INV-16.
fn book_advance(book: &AccountLoader<Book>, repaid: u64) -> Result<()> {
    if repaid == 0 {
        return Ok(());
    }
    let mut b = book.load_mut()?;
    b.advanced = b.advanced.checked_add(repaid).ok_or(CoreError::Math)?;
    require!(b.advanced <= b.sum_worst, CoreError::Math); // INV-16
    Ok(())
}

#[derive(Accounts)]
pub struct ShieldBookLeg<'info> {
    pub base: ShieldAdvance<'info>,
    #[account(mut, address = base.policy.book @ CoreError::NotABookLeg)]
    pub book: AccountLoader<'info, Book>,
}

/// The Liquidation Shield on a Kamino book leg (keeper): `shield_advance` itself, on a sealed book, booked on the book.
pub fn handle_shield_book_leg<'info>(ctx: Context<'info, ShieldBookLeg<'info>>) -> Result<()> {
    require_sealed(&*ctx.accounts.book.load()?)?;
    let repaid = shield_kamino(&mut ctx.accounts.base, ctx.remaining_accounts)?;
    book_advance(&ctx.accounts.book, repaid)
}

#[derive(Accounts)]
pub struct ShieldBookLegJl<'info> {
    pub base: ShieldAdvanceJl<'info>,
    #[account(mut, address = base.policy.book @ CoreError::NotABookLeg)]
    pub book: AccountLoader<'info, Book>,
}

/// The Liquidation Shield on a Jupiter book leg (keeper): `shield_advance_jl` itself, booked on the book.
pub fn handle_shield_book_leg_jl<'info>(ctx: Context<'info, ShieldBookLegJl<'info>>, expected: u64, indices: Vec<u8>) -> Result<()> {
    require_sealed(&*ctx.accounts.book.load()?)?;
    let repaid = shield_jl(&mut ctx.accounts.base, ctx.remaining_accounts, expected, &indices)?;
    book_advance(&ctx.accounts.book, repaid)
}

#[derive(Accounts)]
pub struct SettleBookLeg<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch.ticker.as_ref(), &epoch.closure_id.to_le_bytes()], bump = epoch.bump)]
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
    /// The vault's USDC, or its PYUSD sleeve for a PYUSD leg.
    #[account(mut, constraint = vault_usdc.key() == pay_source(&vault, &config, &policy) @ CoreError::InvalidParam)]
    pub vault_usdc: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(address = pay_mint(&config, &policy) @ CoreError::InvalidParam)]
    pub usdc_mint: Box<InterfaceAccount<'info, MintInterface>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: `policy.obligation`; decoded while klend owns it.
    #[account(mut, address = policy.obligation @ CoreError::InvalidParam)]
    pub obligation: UncheckedAccount<'info>,
    #[account(mut, address = policy.book @ CoreError::NotABookLeg)]
    pub book: AccountLoader<'info, Book>,
    // klend's repay accounts as in `settle_policy` (required while the obligation borrows from the leg's reserve).
    /// CHECK: one of the two xStocks markets (checked).
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
    /// CHECK: debt-farm user state, or klend's id (klend checks; A-21).
    pub obligation_farm_user_state: Option<UncheckedAccount<'info>>,
    /// CHECK: reserve debt farm, or klend's id (klend checks; A-21).
    pub reserve_farm_state: Option<UncheckedAccount<'info>>,
    /// CHECK: klend checks.
    pub lending_market_authority: Option<UncheckedAccount<'info>>,
    /// CHECK: program id checked in the CPI helper.
    pub farms_program: Option<UncheckedAccount<'info>>,
    /// CHECK: program id checked in the CPI helper.
    pub klend_program: Option<UncheckedAccount<'info>>,
    // remaining_accounts: a multi-collateral leg's legs 1.. epochs, as `settle_policy`.
}

/// Settles a Kamino book leg (anyone): the payout rule (as `settle_policy`) repaid into the obligation while it still
/// borrows from the leg's reserve; otherwise 0, and the leg's premium share owed to the payer if the rule owed a payout.
pub fn handle_settle_book_leg<'info>(ctx: Context<'info, SettleBookLeg<'info>>) -> Result<()> {
    require_sealed(&*ctx.accounts.book.load()?)?;
    let p = &ctx.accounts.policy;
    require!(p.lender == lender::KAMINO && p.side == side::DOWN, CoreError::InvalidParam);
    let borrow_reserve = p.borrow_reserve;
    let borrows = obligation_borrows_from(&ctx.accounts.obligation, &borrow_reserve)?;
    let debt = match (&ctx.accounts.repay_reserve, borrows) {
        (Some(r), true) => {
            require_keys_eq!(r.key(), borrow_reserve, CoreError::InvalidParam);
            accrued_debt(p, ReserveView::load(r)?.cumulative_borrow_rate_bsf)?
        }
        (None, true) => return err!(CoreError::KaminoAccountsMissing),
        _ => p.debt,
    };
    let (legs, _) = settle_legs(&ctx.accounts.epoch, p, ctx.remaining_accounts)?;
    let group_premiums = ctx.accounts.loss.load()?.premiums;
    let (payout, shortfall) = payout_due(&ctx.accounts.epoch, p, &ctx.accounts.vault, group_premiums, debt, &legs)?;
    let mut repaid = 0u64;
    if payout > 0 && borrows {
        let a = &mut *ctx.accounts;
        let k = KlendRepay::from_options(
            &a.lending_market, &a.repay_reserve, &a.reserve_destination_liquidity, &a.instruction_sysvar,
            &a.obligation_farm_user_state, &a.reserve_farm_state, &a.lending_market_authority, &a.farms_program, &a.klend_program,
        )?;
        repaid = repay_kamino(&a.vault, &mut a.vault_usdc, &a.usdc_mint, &a.token_program, a.obligation.as_ref(), &borrow_reserve, &k, payout)?;
    }
    finish_leg(&mut ctx.accounts.vault, &ctx.accounts.loss, &mut ctx.accounts.epoch, &mut ctx.accounts.policy, &ctx.accounts.book, &ctx.accounts.config, payout, repaid, shortfall)
}

/// Books a settled leg: what went into the position is its payout; an owed payout that could not go in (repaid 0)
/// refunds the leg's share (A-84). The refund comes out of the group before `finish_policy` may release it.
#[allow(clippy::too_many_arguments)]
fn finish_leg<'info>(
    v: &mut Account<'info, Vault>,
    loss: &AccountLoader<'info, LossVector>,
    e: &mut Account<'info, Epoch>,
    p: &mut Account<'info, Policy>,
    book: &AccountLoader<'info, Book>,
    cfg: &Config,
    owed: u64,
    repaid: u64,
    shortfall: u64,
) -> Result<()> {
    let mut b = book.load_mut()?;
    let mut l = loss.load_mut()?;
    let refund = if owed > 0 && repaid == 0 { accrue_refund(&mut b, &mut l, v, p.leg_w)? } else { 0 };
    let pyusd = is_pyusd(cfg, p);
    finish_policy(v, &mut l, e, p, repaid, repaid, shortfall, pyusd)?;
    b.paid_out = b.paid_out.checked_add(repaid).ok_or(CoreError::Math)?;
    b.legs_done = b.legs_done.checked_add(1).ok_or(CoreError::Math)?;
    emit!(BookLegSettled { book: book.key(), obligation: p.obligation, owed, paid_into_position: repaid, kept_by_vault: owed - repaid, refund });
    Ok(())
}

#[derive(Accounts)]
pub struct SettleBookLegJl<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch.ticker.as_ref(), &epoch.closure_id.to_le_bytes()], bump = epoch.bump)]
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
    pub token_program: Program<'info, Token>,
    /// CHECK: Jupiter Lend Vaults program (address checked).
    #[account(address = JL_VAULTS_PROGRAM_ID @ CoreError::InvalidParam)]
    pub jl_vaults: UncheckedAccount<'info>,
    #[account(mut, address = policy.book @ CoreError::NotABookLeg)]
    pub book: AccountLoader<'info, Book>,
    // remaining_accounts: operate's accounts, as `settle_policy_jl`.
}

/// Settles a Jupiter book leg (anyone): as `settle_policy_jl`, paid back into the position only (operate CPI); what
/// cannot go in stays in the vault. `expected = u64::MAX` only returns `(payout, offer)`.
pub fn handle_settle_book_leg_jl<'info>(ctx: Context<'info, SettleBookLegJl<'info>>, expected: u64, indices: Vec<u8>) -> Result<()> {
    require_sealed(&*ctx.accounts.book.load()?)?;
    let p = &ctx.accounts.policy;
    require!(p.lender == lender::JUPITER, CoreError::InvalidParam);
    let rem = ctx.remaining_accounts;
    let vault_key = ctx.accounts.vault.key();
    let (borrows, borrow_ex, owes) = check_operate_accounts(rem, p, &vault_key, &ctx.accounts.vault_usdc.key())?;
    let debt = if borrows { accrued_debt(p, borrow_ex as u128)? } else { p.debt };
    let group_premiums = ctx.accounts.loss.load()?.premiums;
    let (payout, shortfall) = payout_due(&ctx.accounts.epoch, p, &ctx.accounts.vault, group_premiums, debt, &[])?;
    // Jupiter refuses a payback that leaves the position above its threshold: only a payout that restores it goes in.
    let owed = crate::pricing::realized_payout(p.covered_value, debt, u64::MAX, ctx.accounts.epoch.close_price_wad, ctx.accounts.epoch.settle_price_wad)?;
    let restores = p.advanced.checked_add(payout).is_some_and(|t| t >= owed);
    let (into, offer) = if borrows && restores { payback_split(payout, owes) } else { (0, 0) };
    if expected == u64::MAX {
        let mut out = payout.to_le_bytes().to_vec();
        out.extend_from_slice(&offer.to_le_bytes());
        set_return_data(&out);
        return Ok(());
    }
    require!(expected == payout, CoreError::AmountMismatch);
    let mut repaid = 0u64;
    if into > 0 {
        let before = ctx.accounts.vault_usdc.amount;
        let seeds: &[&[u8]] = &[SEED_VAULT, &[ctx.accounts.vault.bump]];
        operate_payback(&ctx.accounts.jl_vaults, rem, &vault_key, offer, USDC_DECIMALS, &indices, &[seeds])?;
        ctx.accounts.vault_usdc.reload()?;
        repaid = before.checked_sub(ctx.accounts.vault_usdc.amount).ok_or(CoreError::Math)?;
        require!(repaid <= into, CoreError::Math);
    }
    let a = &mut *ctx.accounts;
    finish_leg(&mut a.vault, &a.loss, &mut a.epoch, &mut a.policy, &a.book, &a.config, payout, repaid, shortfall)
}

#[derive(Accounts)]
pub struct CloseOutBookLeg<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch.ticker.as_ref(), &epoch.closure_id.to_le_bytes()], bump = epoch.bump)]
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
    #[account(mut, address = policy.book @ CoreError::NotABookLeg)]
    pub book: AccountLoader<'info, Book>,
    // remaining_accounts: a multi-collateral leg's legs 1.. epochs.
}

/// Anyone: finishes a sealed leg without paying it, so no leg can keep its group live (plan/02 rule 8).
/// - Its epoch was voided (no close stored; for a multi-collateral leg, every leg's): the leg's share is refunded, as
///   `refund_policy` refunds an owner's premium.
/// - Otherwise `SETTLE_GRACE` after the settlement price: payout 0, and the share is owed to the payer if the payout
///   rule owed something (the vault kept it; A-84). Never a wallet.
pub fn handle_close_out_book_leg<'info>(ctx: Context<'info, CloseOutBookLeg<'info>>) -> Result<()> {
    require_sealed(&*ctx.accounts.book.load()?)?;
    let p = &ctx.accounts.policy;
    require!(p.state == policy_state::ACTIVE, CoreError::WrongEpochState);
    let rem = ctx.remaining_accounts;
    let all_voided = ctx.accounts.epoch.state == epoch_state::VOIDED
        && (1..p.n_legs.max(1) as usize).try_fold(true, |acc, i| -> Result<bool> {
            let ep: Account<Epoch> = Account::try_from(rem.get(i - 1).ok_or(CoreError::InvalidParam)?)?;
            require!(ep.ticker == p.leg_ticker(i) && ep.closure_id == ctx.accounts.epoch.closure_id, CoreError::InvalidParam);
            Ok(acc && ep.state == epoch_state::VOIDED)
        })?;
    if all_voided {
        let a = &mut *ctx.accounts;
        let mut b = a.book.load_mut()?;
        let mut l = a.loss.load_mut()?;
        let refund = accrue_refund(&mut b, &mut l, &mut a.vault, a.policy.leg_w)?;
        record_settlement(&mut a.vault, &mut l, 0)?;
        drop(l);
        if is_pyusd(&a.config, &a.policy) {
            release_pyusd(&mut a.vault, &a.policy)?;
        }
        a.epoch.policies_settled = a.epoch.policies_settled.checked_add(1).ok_or(CoreError::Math)?;
        a.policy.state = policy_state::REFUNDED;
        b.legs_done = b.legs_done.checked_add(1).ok_or(CoreError::Math)?;
        emit!(BookLegSettled { book: a.book.key(), obligation: a.policy.obligation, owed: 0, paid_into_position: 0, kept_by_vault: 0, refund });
        return Ok(());
    }
    let (legs, settled_at) = settle_legs(&ctx.accounts.epoch, p, rem)?;
    require!(Clock::get()?.unix_timestamp >= settled_at.checked_add(SETTLE_GRACE).ok_or(CoreError::Math)?, CoreError::TooEarly);
    let group_premiums = ctx.accounts.loss.load()?.premiums;
    let (payout, shortfall) = payout_due(&ctx.accounts.epoch, p, &ctx.accounts.vault, group_premiums, p.debt, &legs)?;
    let a = &mut *ctx.accounts;
    finish_leg(&mut a.vault, &a.loss, &mut a.epoch, &mut a.policy, &a.book, &a.config, payout, 0, shortfall)
}

#[derive(Accounts)]
pub struct CloseBookLeg<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_EPOCH, epoch.ticker.as_ref(), &epoch.closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_POLICY, epoch.key().as_ref(), policy.obligation.as_ref()], bump = policy.bump,
        has_one = epoch @ CoreError::InvalidParam,
    )]
    pub policy: Box<Account<'info, Policy>>,
    #[account(seeds = [SEED_LOSS, &epoch.closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    /// CHECK: receives the rent (address = `policy.rent_payer`).
    #[account(mut, address = policy.rent_payer @ CoreError::InvalidParam)]
    pub rent_payer: UncheckedAccount<'info>,
}

/// Anyone: a finished leg's account back to its rent payer once its group has released (no sale or settlement of the
/// closure can need it any more).
pub fn handle_close_book_leg(ctx: Context<CloseBookLeg>) -> Result<()> {
    let p = &ctx.accounts.policy;
    require!(p.book != Pubkey::default(), CoreError::NotABookLeg);
    require!(p.state != policy_state::ACTIVE && ctx.accounts.loss.load()?.settled == 1, CoreError::WrongEpochState);
    Ok(())
}

#[event]
pub struct BookLegSettled {
    pub book: Pubkey,
    pub obligation: Pubkey,
    /// What the payout rule owed after advances (capped by the vault's cash).
    pub owed: u64,
    /// What went into the position.
    pub paid_into_position: u64,
    /// What the position could not take (it owed less, or no longer borrows): stays in the vault.
    pub kept_by_vault: u64,
    /// The leg's premium share owed to the payer.
    pub refund: u64,
}
