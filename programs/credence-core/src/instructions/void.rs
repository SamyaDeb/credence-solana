//! `void_epoch` and `refund_policy` (review fix): the exit for an epoch whose Friday close was never stored.
//!
//! `snapshot_close` needs a price update published in the close window. If none exists (feed outage, early close,
//! nobody called it), the epoch would stay `OPEN` forever and its policies, premiums and the group's capacity with it.
//! `VOID_AFTER` past the close anyone may void it; then anyone may refund each policy: the net premium (premium − fee)
//! goes back from the vault to the owner, and the group is released exactly as settlement releases it (the group's
//! last finished policy, settled or refunded, moves the remaining premiums to equity and frees the capacity).
//!
//! The protocol fee is not refunded: it already left the vault for `Vault.fee_account`, which is any USDC account
//! (not a vault PDA), so the program cannot sign for it. Phase 1 deploys with `fee_bps = 0`.

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::instructions::settle::{is_pyusd, pay_from_vault, record_settlement, release_pyusd};
use crate::state::*;
use crate::CoreError;

/// An epoch still `OPEN` this long after the close never got its Friday close and may be voided. Long enough for the
/// keeper to retry `snapshot_close` with any update published in the window; far shorter than the weekend.
pub const VOID_AFTER: i64 = 6 * 3600;

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct VoidEpoch<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Account<'info, Epoch>,
}

/// Anyone, `VOID_AFTER` past the close, if the close was never stored. Not gated by `paused` (it only unwinds risk).
pub fn handle_void_epoch(ctx: Context<VoidEpoch>, _ticker: Ticker, _closure_id: u32) -> Result<()> {
    let e = &mut ctx.accounts.epoch;
    require!(e.state == epoch_state::OPEN, CoreError::WrongEpochState);
    let after = e.close.checked_add(VOID_AFTER).ok_or(CoreError::Math)?;
    require!(Clock::get()?.unix_timestamp >= after, CoreError::TooEarly);
    e.state = epoch_state::VOIDED;
    emit!(EpochVoided { ticker: e.ticker, closure_id: e.closure_id, policies: e.policy_count });
    Ok(())
}

#[derive(Accounts)]
pub struct RefundPolicy<'info> {
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
    /// The policy owner's USDC account: receives the net premium.
    #[account(
        mut, token::mint = config.usdc_mint, token::authority = policy.owner, token::token_program = token_program,
        constraint = policy.payout_destination_ok(&owner_usdc.key()) @ CoreError::InvalidParam, // A-190
    )]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Refunds one active policy of a voided epoch (anyone may call): `premium − fee` from the vault to the owner, removed
/// from the group's and the vault's unearned premiums, then the group bookkeeping of a zero payout.
pub fn handle_refund_policy<'info>(ctx: Context<'info, RefundPolicy<'info>>) -> Result<()> {
    require!(ctx.accounts.epoch.state == epoch_state::VOIDED, CoreError::WrongEpochState);
    require!(ctx.accounts.policy.state == policy_state::ACTIVE, CoreError::WrongEpochState);
    require!(ctx.accounts.policy.book == Pubkey::default(), CoreError::BookLeg); // a book leg: close_out_book_leg (C2)
    // A multi-leg policy is refunded only when every leg is voided; with one leg settled it settles, the voided legs
    // flat (A-47). Legs 1..'s epochs come as remaining accounts in leg order.
    let p = &ctx.accounts.policy;
    for i in 1..p.n_legs as usize {
        let ep: Account<Epoch> = Account::try_from(ctx.remaining_accounts.get(i - 1).ok_or(CoreError::InvalidParam)?)?;
        require!(ep.ticker == p.leg_ticker(i) && ep.closure_id == ctx.accounts.epoch.closure_id, CoreError::InvalidParam);
        require!(ep.state == epoch_state::VOIDED, CoreError::WrongEpochState);
    }
    let a = &mut *ctx.accounts;
    let refund = a.policy.premium.checked_sub(a.policy.fee).ok_or(CoreError::Math)?;
    pay_from_vault(&a.token_program, &a.vault, &a.vault_usdc, &a.owner_usdc, refund)?;

    let mut l = a.loss.load_mut()?;
    l.premiums = l.premiums.checked_sub(refund).ok_or(CoreError::Math)?;
    let v = &mut a.vault;
    v.premiums_unearned = v.premiums_unearned.checked_sub(refund).ok_or(CoreError::Math)?;
    v.total_premiums = v.total_premiums.checked_sub(refund).ok_or(CoreError::Math)?;
    record_settlement(v, &mut l, 0)?;
    drop(l);
    if is_pyusd(&a.config, &a.policy) {
        release_pyusd(&mut a.vault, &a.policy)?; // W4: the sleeve reservation goes with the policy
    }

    let e = &mut a.epoch;
    e.policies_settled = e.policies_settled.checked_add(1).ok_or(CoreError::Math)?;
    e.total_premium = e.total_premium.checked_sub(a.policy.premium).ok_or(CoreError::Math)?;
    let p = &mut a.policy;
    p.state = policy_state::REFUNDED;
    emit!(PolicyRefunded { policy: p.key(), owner: p.owner, refund });
    Ok(())
}

#[event]
pub struct EpochVoided {
    pub ticker: Ticker,
    pub closure_id: u32,
    pub policies: u32,
}

#[event]
pub struct PolicyRefunded {
    pub policy: Pubkey,
    pub owner: Pubkey,
    pub refund: u64,
}
