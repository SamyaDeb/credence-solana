//! `buy_cover_up` (W11, task B3): Gap Cover side `UP` for a short position on Kamino: an xStock borrowed against
//! stablecoins, hurt when the open gaps UP. The payout rule mirrors `DOWN` (`risk-core::up`):
//!
//! `repay_needed = min(cap, max(0, ⌈D × (1 + r)⌉ − C′))`
//!
//! with D the xStock debt's value at the close (× its borrow factor, as klend's health counts it) and C′ the
//! stablecoins at their LT. It is paid in USDC to the owner's wallet at settlement: USDC cannot repay an xStock debt,
//! and a deposit into the obligation needs its owner's signature. No shield on the up side.
//!
//! **Netting:** an UP policy's losses go into the same weekend loss vector as the DOWN policies (INV-2 on the netted
//! vector). Its losses sit in the up scenarios, theirs in the down ones, so a book with both reserves less than the sum
//! of its parts (`tests/cover_up.rs::netting_lowers_reserved_capacity`).
//!
//! Transaction: `refresh_reserve` (every reserve of the obligation) → `refresh_obligation` → `buy_cover_up`.
//! Remaining accounts: the obligation's deposit reserves, in its deposit order.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::instructions::cover::{concentration_limit, record_policy, CoverBought};
use crate::instructions::quote::{closure_terms, reserved_other};
use crate::kamino::{cover_snapshot_up, ObligationView, ReserveView};
use crate::math::free_equity;
use crate::pricing::{capacity, policy_losses_up, premium_up, priced_debt, reserved_debt, CoverInputs};
use crate::state::*;
use crate::CoreError;

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct BuyCoverUp<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    /// The asset's scenario set for the epoch's closure type (PDA checked by `closure_terms`).
    pub scenarios: AccountLoader<'info, ScenarioSet>,
    #[account(mut, seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    /// CHECK: the asset's `["earnings", ticker]` PDA (checked by `closure_terms`).
    pub earnings: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_LOSS, &closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = vault.fee_account @ CoreError::InvalidParam)]
    pub fee_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: klend `Obligation` (decoded and checked in `cover_snapshot_up`).
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: the obligation's xStock borrow reserve (decoded; identity checked).
    pub borrow_reserve: UncheckedAccount<'info>,
    #[account(
        init, payer = buyer, space = Policy::SIZE,
        seeds = [SEED_POLICY, epoch.key().as_ref(), obligation.key().as_ref()], bump
    )]
    pub policy: Box<Account<'info, Policy>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_buy_cover_up<'info>(
    ctx: Context<'info, BuyCoverUp<'info>>,
    _ticker: Ticker,
    _closure_id: u32,
    max_payout: u64,
    max_premium: u64,
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, CoreError::Paused);
    let clock = Clock::get()?;
    let e = &ctx.accounts.epoch;
    require!(e.state == epoch_state::OPEN, CoreError::SalesClosed);
    require!(clock.unix_timestamp >= e.sale_open && clock.unix_timestamp < e.bell, CoreError::SalesClosed); // INV-3
    let asset = ctx.accounts.asset.load()?;
    require!(asset.enabled == 1 && asset.lender == lender::KAMINO as u64, CoreError::AssetDisabled);
    require!(
        asset.gap_factors_ready() && asset.gf_sigma_wad == asset.sigma_wad && asset.gf_dividend_wad == asset.dividend_wad && asset.gf_kappa_wad == cfg.kappa_wad,
        CoreError::StaleGapFactors
    );
    let set = ctx.accounts.scenarios.load()?;
    let terms = closure_terms(&asset, &set, &ctx.accounts.scenarios.key(), e, &ctx.accounts.earnings)?;

    // Snapshot of the short.
    let ob = ObligationView::load(&ctx.accounts.obligation)?;
    let rem = ctx.remaining_accounts;
    require!(rem.len() == ob.deposits.len(), CoreError::InvalidParam);
    let views: Vec<ReserveView> = rem.iter().map(ReserveView::load).collect::<Result<_>>()?;
    let deps: Vec<(Pubkey, &ReserveView)> = rem.iter().zip(views.iter()).map(|(a, v)| (a.key(), v)).collect();
    let bor = ReserveView::load(&ctx.accounts.borrow_reserve)?;
    let snap = cover_snapshot_up(
        &ob, ctx.accounts.buyer.key, clock.slot, &deps, ctx.accounts.borrow_reserve.key(), &bor, &asset.mint, &asset.kamino_reserves,
        &[cfg.usdc_mint, cfg.pyusd_mint],
    )?;
    require!(max_payout > 0 && max_payout <= snap.debt, CoreError::InvalidParam);
    require!(snap.debt < snap.covered_value, CoreError::AlreadyLiquidatable);
    require!(bor.cumulative_borrow_rate_bsf > 0, CoreError::KaminoLayout);

    // Losses (netted with the weekend's DOWN policies in one vector), capacity, concentration, premium.
    let x = CoverInputs { covered_value: snap.covered_value, debt: reserved_debt(snap.debt, cfg)?, max_payout };
    let xp = CoverInputs { debt: priced_debt(snap.debt, cfg)?, ..x };
    let mut losses = vec![0u64; K];
    let worst = policy_losses_up(&asset, &x, terms.capacity_mult_wad, &mut losses)?;
    let v = &ctx.accounts.vault;
    let equity = free_equity(v.cover_equity()?, v.queued_withdraw_shares, ctx.accounts.share_mint.supply).ok_or(CoreError::Math)?;
    let (cap, group_max_before) = {
        let l = ctx.accounts.loss.load()?;
        require!(l.settled == 0, CoreError::SalesClosed);
        (capacity(&l.losses, &losses, reserved_other(v, &l)?, equity, cfg.u_max_wad)?, l.max_loss)
    };
    let asset_worst = e.worst_loss_sum.checked_add(worst).ok_or(CoreError::Math)?;
    require!(asset_worst as u128 <= concentration_limit(equity, cfg.u_max_wad, cfg.max_asset_share_wad), CoreError::ConcentrationExceeded);
    let z = &set.z[..set.n as usize];
    let prem = premium_up(z, cfg, terms.sigma_wad, asset.dividend_wad, terms.days, cap.util_after_wad, &xp)?;
    require!(prem <= max_premium, CoreError::PremiumAboveMax);
    let fee = u64::try_from((prem as u128) * (cfg.fee_bps as u128) / 10_000).map_err(|_| CoreError::Math)?;
    let net = prem.checked_sub(fee).ok_or(CoreError::Math)?;
    drop(asset);
    drop(set);

    for (amount, to) in [(net, &ctx.accounts.vault_usdc), (fee, &ctx.accounts.fee_account)] {
        if amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    Transfer { from: ctx.accounts.buyer_usdc.to_account_info(), to: to.to_account_info(), authority: ctx.accounts.buyer.to_account_info() },
                ),
                amount,
            )?;
        }
    }
    let policy_key = ctx.accounts.policy.key();
    {
        let mut loss = ctx.accounts.loss.load_mut()?;
        record_policy(&mut ctx.accounts.vault, &mut loss, &mut ctx.accounts.epoch, &losses, cap.group_worst_after, group_max_before, worst, max_payout, prem, net)?;
    }
    ctx.accounts.vault_usdc.reload()?;
    require!(ctx.accounts.vault_usdc.amount >= ctx.accounts.vault.reserved_cash()?, CoreError::CashBelowReservation);
    let p = &mut ctx.accounts.policy;
    p.owner = ctx.accounts.buyer.key();
    p.obligation = ctx.accounts.obligation.key();
    p.borrow_reserve = ctx.accounts.borrow_reserve.key();
    p.epoch = ctx.accounts.epoch.key();
    p.ticker = ctx.accounts.epoch.ticker;
    p.side = side::UP;
    p.state = policy_state::ACTIVE;
    p.bump = ctx.bumps.policy;
    p.collateral_value = snap.collateral_value;
    p.covered_value = snap.covered_value;
    p.debt = snap.debt;
    p.max_payout = max_payout;
    p.premium = prem;
    p.fee = fee;
    p.worst_loss = worst;
    p.created_at = clock.unix_timestamp;
    p.borrow_index_bsf = bor.cumulative_borrow_rate_bsf; // the xStock debt's interest (task 1.2)
    p.debt_growth_cap_wad = ctx.accounts.config.debt_growth_cap_wad;
    p.lender = lender::KAMINO;
    emit!(CoverBought {
        policy: policy_key,
        owner: p.owner,
        obligation: p.obligation,
        ticker: p.ticker,
        closure_id: ctx.accounts.epoch.closure_id,
        covered_value: snap.covered_value,
        debt: snap.debt,
        max_payout,
        premium: prem,
        fee,
        worst_loss: worst,
        util_after_wad: cap.util_after_wad,
    });
    Ok(())
}
