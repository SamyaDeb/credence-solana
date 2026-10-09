//! `shield_advance` (W1, the Liquidation Shield): keeper-only, one policy per instruction.
//!
//! Kamino's xStock price is frozen from the Friday close until Monday pre-market (plan/09, S7), when the gap lands at
//! once and liquidators act on it. The shield repays into a covered position **before** that move, sized from the
//! xStock token's own 24/7 price (Pyth `Crypto.<T>X/USD`, the push account for the asset's feed):
//!
//! - target = `pricing::shield_target` = `min(α × cap, realized_payout(⌈C′/(1+h)⌉, D, cap, close, ⌈fair × (1 − b)⌉))`,
//!   the settlement rule at the marked-down fair value (no new payout math);
//! - pays `target − policy.advanced` into the obligation through `repay_obligation_liquidity_v2`, the vault PDA
//!   signing, measuring the vault's USDC before and after like `settle_policy`. Whatever klend does not take stays in
//!   the vault. **Nothing is ever paid to a wallet** (INV-11): an obligation that no longer borrows from the policy's
//!   reserve gets no advance.
//!
//! Window: from `epoch.open − shield_start_before_open_secs` (Sunday 20:00 ET) to `epoch.open −
//! shield_deadline_before_open_secs` (Monday 07:00 ET); `epoch.open` comes from the calendar, so holidays shift the
//! window. The epoch must be CLOSED: a HALTED epoch's open has moved past a live Monday, outside the frozen weekend the
//! loading prices (audit A-26). The fair value must be published at most an hour before the close (the last push before
//! a Friday close lands 4–14 min early) and within `shield_max_age_secs` (audit A-25).
//!
//! Bounded by what the vault reserved (INV-12, audit A-32): a policy's advances never exceed its `worst_loss` (its own
//! worst joint-scenario loss, reserved at purchase), and a group's advances never exceed its `LossVector.max_loss` (the
//! capacity INV-2 reserved for the whole weekend). Without this, a weekend fair value far below what the open delivers
//! (a thin 24/7 market, or a covered borrower pushing it) could pay out up to α × cap per policy against a much smaller
//! reservation. The fair value still sizes the advance; the reservation only caps it.
//!
//! Idempotent: a retry with the same (or a higher) fair value finds `target ≤ advanced` (or above it only by the
//! interest accrued since, less than [`MIN_TOPUP`]) and does nothing; a lower
//! fair value later in the window tops the advance up, never above `α × cap` (INV-9). An advance is paid from vault
//! equity (cash first): it is an early part of the policy's payout, so equity drops now; settlement pays
//! `max(0, payout rule − advanced)` and books nothing more when the advance was larger (the vault's loss, priced by
//! the shield loading). The caller's transaction must refresh the reserves and the obligation first.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface, TokenInterface};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::instructions::settle::{is_pyusd, obligation_borrows_from, pay_mint, pay_source, INSTRUCTIONS_SYSVAR_ID};
use crate::kamino::{repay_obligation_liquidity_v2, RepayV2, ReserveView, KLEND_PROGRAM_ID, XSTOCKS_MARKETS};
use crate::oracle::{check_update, push_account};
use crate::pricing::{accrued_debt, shield_target, shield_target_multi, LegPrice, ShieldParams};
use crate::state::*;
use crate::CoreError;

/// A fair value may be published up to this long before the Friday close (the last in-session push lands 4–14 minutes
/// early), never earlier (audit A-25).
pub const FAIR_BEFORE_CLOSE_SECS: i64 = 3600;

/// Once a policy has an advance, a top-up smaller than this (1 USDC) is skipped: the sized target creeps up with the
/// interest klend accrues every slot (task 1.2), and a keeper retry at the same fair value should not pay dust.
pub const MIN_TOPUP: u64 = 1_000_000;

#[derive(Accounts)]
pub struct ShieldAdvance<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.keeper == keeper.key() @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, epoch.ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
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
    /// The group's loss vector: its `max_loss` is the shield budget, `advanced` the running total (INV-12).
    #[account(mut, seeds = [SEED_LOSS, &epoch.closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// The vault's USDC, or its PYUSD sleeve for a PYUSD policy (W4).
    #[account(mut, constraint = vault_usdc.key() == pay_source(&vault, &config, &policy) @ CoreError::InvalidParam)]
    pub vault_usdc: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(address = pay_mint(&config, &policy) @ CoreError::InvalidParam)]
    pub usdc_mint: Box<InterfaceAccount<'info, MintInterface>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// The weekend fair value: Pyth's push account for the asset's `Crypto.<T>X/USD` feed (address checked; owner =
    /// the pro-compatible receiver via the account type). The push account holds one update at a time, so the keeper
    /// cannot pick a favourable price.
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    /// CHECK: must be `policy.obligation`; decoded with `ObligationView` (klend owner, discriminator, layout).
    #[account(mut, address = policy.obligation @ CoreError::InvalidParam)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: one of the two xStocks markets (checked) and the obligation's market (klend `has_one`).
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: `policy.borrow_reserve` (address checked).
    #[account(mut, address = policy.borrow_reserve @ CoreError::InvalidParam)]
    pub repay_reserve: UncheckedAccount<'info>,
    /// CHECK: the reserve's supply vault (klend checks).
    #[account(mut)]
    pub reserve_destination_liquidity: UncheckedAccount<'info>,
    /// CHECK: instructions sysvar (address checked).
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
    /// CHECK: obligation's debt-farm user state (klend checks); the klend program id when the reserve has no farm.
    /// Not `mut` (audit A-21): without a debt farm this slot is klend's program id, which the runtime demotes to
    /// read-only; a real farm is passed writable by the client and klend's CPI meta asks for it writable.
    pub obligation_farm_user_state: UncheckedAccount<'info>,
    /// CHECK: reserve's debt farm (klend checks); the klend program id when the reserve has no farm. Not `mut` (A-21).
    pub reserve_farm_state: UncheckedAccount<'info>,
    /// CHECK: `["lma", market]` under klend (klend checks).
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: program id checked in `kamino::repay_obligation_liquidity_v2`.
    pub farms_program: UncheckedAccount<'info>,
    /// CHECK: program id checked in `kamino::repay_obligation_liquidity_v2`.
    pub klend_program: UncheckedAccount<'info>,
}

pub fn handle_shield_advance<'info>(ctx: Context<'info, ShieldAdvance<'info>>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, CoreError::Paused);
    require!(cfg.shield_alpha_wad > 0, CoreError::ShieldOff);
    let e = &ctx.accounts.epoch;
    require!(e.state == epoch_state::CLOSED, CoreError::WrongEpochState); // not HALTED (A-26)
    let p = &ctx.accounts.policy;
    require!(p.state == policy_state::ACTIVE, CoreError::WrongEpochState);
    require!(p.lender == lender::KAMINO, CoreError::InvalidParam); // Jupiter: shield_advance_jl (A-53)
    require!(p.side == side::DOWN, CoreError::InvalidParam); // no shield on the up side (W11)

    // Window from the epoch's next open (calendar).
    let now = Clock::get()?.unix_timestamp;
    let from = e.open.checked_sub(cfg.shield_start_before_open_secs as i64).ok_or(CoreError::Math)?;
    let to = e.open.checked_sub(cfg.shield_deadline_before_open_secs as i64).ok_or(CoreError::Math)?;
    require!(now >= from && now <= to, CoreError::OutsideShieldWindow);

    // Fair value: the asset's push account, Full-verified, the right feed, at most `shield_max_age_secs` old,
    // confidence within `max_conf_bps`.
    let feed = ctx.accounts.asset.load()?.feed_xstock;
    require_keys_eq!(ctx.accounts.price_update.key(), push_account(&feed), CoreError::NotPushAccount);
    // Not older than the max age, and not from before the close's last hour (A-25).
    let oldest = now
        .checked_sub(cfg.shield_max_age_secs as i64)
        .ok_or(CoreError::Math)?
        .max(e.close.checked_sub(FAIR_BEFORE_CLOSE_SECS).ok_or(CoreError::Math)?);
    let fair = check_update(&ctx.accounts.price_update, &feed, oldest, now, cfg.max_conf_bps)?;

    // The snapshot debt with the interest klend accrued on it since purchase (task 1.2): the advance restores the
    // target health on the debt the position will actually carry at the open, not the Friday snapshot.
    let index_now = ReserveView::load(&ctx.accounts.repay_reserve)?.cumulative_borrow_rate_bsf;
    let debt = accrued_debt(p, index_now)?;
    let sp = ShieldParams::from_config(cfg);
    let sized = if p.n_legs == 0 {
        shield_target(p.covered_value, debt, p.max_payout, e.close_price_wad, fair.price_wad, &sp)?
    } else {
        // W4: every leg on its own fair value. Legs 1.. come as remaining accounts: [asset, epoch, push] per leg, each
        // checked as leg 0 (the asset's push account, Full, its feed, age, confidence; the epoch CLOSED, same group).
        require!(e.ticker == p.leg_ticker(0), CoreError::InvalidParam);
        let n = p.n_legs as usize;
        let rem = ctx.remaining_accounts;
        require!(rem.len() >= 3 * (n - 1), CoreError::InvalidParam);
        let mut legs = vec![LegPrice { covered: p.leg_covered[0], close_wad: e.close_price_wad, price_wad: fair.price_wad }];
        for i in 1..n {
            let a: AccountLoader<AssetConfig> = AccountLoader::try_from(&rem[3 * (i - 1)])?;
            let ep: Account<Epoch> = Account::try_from(&rem[3 * (i - 1) + 1])?;
            let (feed_i, ticker_i) = { let av = a.load()?; (av.feed_xstock, av.ticker) };
            require!(ticker_i == p.leg_ticker(i) && ep.ticker == ticker_i && ep.closure_id == e.closure_id, CoreError::InvalidParam);
            require!(ep.state == epoch_state::CLOSED, CoreError::WrongEpochState);
            let push: Account<PriceUpdateV2> = Account::try_from(&rem[3 * (i - 1) + 2])?;
            require_keys_eq!(push.key(), push_account(&feed_i), CoreError::NotPushAccount);
            let oldest_i = now.checked_sub(cfg.shield_max_age_secs as i64).ok_or(CoreError::Math)?
                .max(ep.close.checked_sub(FAIR_BEFORE_CLOSE_SECS).ok_or(CoreError::Math)?);
            let f = check_update(&push, &feed_i, oldest_i, now, cfg.max_conf_bps)?;
            legs.push(LegPrice { covered: p.leg_covered[i], close_wad: ep.close_price_wad, price_wad: f.price_wad });
        }
        shield_target_multi(&legs, p.stable_covered, debt, p.max_payout, &sp)?
    };
    // INV-12 (A-32): never above the policy's reserved worst-case loss, nor the group's remaining reservation.
    let target = sized.min(p.worst_loss);
    let group_left = {
        let l = ctx.accounts.loss.load()?;
        require!(l.settled == 0, CoreError::WrongEpochState);
        l.max_loss.saturating_sub(l.advanced)
    };
    // Cash first: an advance never draws on more than the vault's equity that backs cover (unearned premiums and queued
    // deposits are not the LPs' to lend out, and backstop inventory is not cash).
    let mut add = target.saturating_sub(p.advanced).min(group_left).min(ctx.accounts.vault.cover_equity()?);
    if is_pyusd(cfg, p) {
        add = add.min(ctx.accounts.vault_usdc.amount); // a PYUSD advance is what the sleeve holds at most (A-44)
    }
    if add == 0 || (p.advanced > 0 && add < MIN_TOPUP) {
        return Ok(()); // already advanced (about) this much: a keeper retry, or the position does not need it
    }

    // INV-11: only into the obligation, only while klend still owns it and it borrows from the policy's reserve (A-28:
    // a closed obligation is a clear refusal, not a decode error).
    require!(obligation_borrows_from(&ctx.accounts.obligation, &p.borrow_reserve)?, CoreError::NoDebtToAdvance);
    require!(XSTOCKS_MARKETS.contains(ctx.accounts.lending_market.key), CoreError::MarketNotAllowed);

    let a = &ctx.accounts;
    let before = a.vault_usdc.amount;
    let seeds: &[&[u8]] = &[SEED_VAULT, &[a.vault.bump]];
    let farm = |x: &UncheckedAccount<'info>| if *x.key == KLEND_PROGRAM_ID { None } else { Some(x.to_account_info()) };
    let (farm_user, farm_state) = (farm(&a.obligation_farm_user_state), farm(&a.reserve_farm_state));
    repay_obligation_liquidity_v2(
        &RepayV2 {
            owner: &a.vault.to_account_info(),
            obligation: a.obligation.as_ref(),
            lending_market: a.lending_market.as_ref(),
            repay_reserve: a.repay_reserve.as_ref(),
            reserve_liquidity_mint: &a.usdc_mint.to_account_info(),
            reserve_destination_liquidity: a.reserve_destination_liquidity.as_ref(),
            user_source_liquidity: &a.vault_usdc.to_account_info(),
            token_program: a.token_program.as_ref(),
            instruction_sysvar: a.instruction_sysvar.as_ref(),
            obligation_farm_user_state: farm_user.as_ref(),
            reserve_farm_state: farm_state.as_ref(),
            lending_market_authority: a.lending_market_authority.as_ref(),
            farms_program: a.farms_program.as_ref(),
            klend_program: a.klend_program.as_ref(),
        },
        add,
        &[seeds],
    )?;
    ctx.accounts.vault_usdc.reload()?;
    // klend takes at most the outstanding debt and never more than offered; the rest never left the vault.
    let repaid = before.checked_sub(ctx.accounts.vault_usdc.amount).ok_or(CoreError::Math)?;
    require!(repaid <= add, CoreError::Math);
    if repaid == 0 {
        return Ok(());
    }

    {
        let mut l = ctx.accounts.loss.load_mut()?;
        l.advanced = l.advanced.checked_add(repaid).ok_or(CoreError::Math)?;
        require!(l.advanced <= l.max_loss, CoreError::Math); // INV-12
    }
    let a = &mut *ctx.accounts;
    let p = &mut a.policy;
    p.advanced = p.advanced.checked_add(repaid).ok_or(CoreError::Math)?;
    p.advanced_at = now;
    // INV-9: advanced ≤ α × max_payout (rounded down, as `shield_target` caps it).
    let alpha_cap = (p.max_payout as u128) * (a.config.shield_alpha_wad as u128) / crate::math::WAD;
    require!(p.advanced as u128 <= alpha_cap, CoreError::Math);
    let v = &mut a.vault;
    v.equity = v.equity.checked_sub(repaid).ok_or(CoreError::VaultInsolvent)?;
    v.advanced_live = v.advanced_live.checked_add(repaid).ok_or(CoreError::Math)?; // A-34
    if is_pyusd(&a.config, p) {
        v.pyusd_advanced = v.pyusd_advanced.checked_add(repaid).ok_or(CoreError::Math)?; // INV-14 bookkeeping
    }
    v.total_payouts = v.total_payouts.checked_add(repaid).ok_or(CoreError::Math)?;
    a.epoch.total_payout = a.epoch.total_payout.checked_add(repaid).ok_or(CoreError::Math)?;
    emit!(ShieldAdvanced {
        policy: p.key(),
        obligation: p.obligation,
        amount: repaid,
        advanced: p.advanced,
        target,
        fair_price_wad: fair.price_wad,
        fair_publish_time: fair.publish_time,
        close_price_wad: a.epoch.close_price_wad,
    });
    Ok(())
}

#[event]
pub struct ShieldAdvanced {
    pub policy: Pubkey,
    pub obligation: Pubkey,
    /// Repaid into the obligation by this instruction, USDC.
    pub amount: u64,
    /// The policy's advances so far, USDC.
    pub advanced: u64,
    /// `shield_target` at this fair value, USDC.
    pub target: u64,
    pub fair_price_wad: u128,
    pub fair_publish_time: i64,
    pub close_price_wad: u128,
}
