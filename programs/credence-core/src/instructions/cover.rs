//! `buy_cover` (task 2.3). Settlement of a policy: `settle.rs` (task 2.5).
//!
//! The snapshot comes from the chain, never from the buyer: the transaction is `refresh_reserve` (every reserve of the
//! obligation) → `refresh_obligation` → `buy_cover`, and `buy_cover` decodes the obligation itself
//! (`kamino::cover_snapshot`). Premium and capacity use the same capped loss (plan/02 §2); every state change of a
//! purchase happens in [`record_policy`].

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::instructions::quote::{reserved_other, WEEKEND_CLOSURE_DAYS};
use crate::kamino::{cover_snapshot, CoverAccounts, CoverSnapshot, ObligationView, ReserveView};
use crate::math::WAD;
use crate::pricing::{capacity, policy_losses, premium, CoverInputs};
use crate::state::*;
use crate::CoreError;

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct BuyCover<'info> {
    /// Buyer: must be the obligation's owner; pays the premium and the policy's rent.
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(address = asset.load()?.scenario_set @ CoreError::InvalidParam)]
    pub scenarios: AccountLoader<'info, ScenarioSet>,
    #[account(mut, seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Account<'info, Epoch>,
    #[account(mut, seeds = [SEED_LOSS, &closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = vault.fee_account @ CoreError::InvalidParam)]
    pub fee_account: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_usdc: Account<'info, TokenAccount>,
    /// CHECK: klend `Obligation`; owner program, discriminator, length, market, owner and freshness checked in
    /// `kamino::cover_snapshot`.
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: klend `Reserve` of the obligation's deposit; owner program and discriminator checked by `ReserveView::load`,
    /// identity and contents by `cover_snapshot`.
    pub deposit_reserve: UncheckedAccount<'info>,
    /// CHECK: klend `Reserve` of the obligation's borrow; as above.
    pub borrow_reserve: UncheckedAccount<'info>,
    #[account(
        init, payer = buyer, space = Policy::SIZE,
        seeds = [SEED_POLICY, epoch.key().as_ref(), buyer.key().as_ref(), obligation.key().as_ref()], bump
    )]
    pub policy: Account<'info, Policy>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Buys `DOWN` gap cover for `closure_id` on the buyer's Kamino obligation.
///
/// `max_payout` (USDC, 0 < max_payout ≤ debt) is the hard cap (INV-1). `max_premium` is slippage protection: the call
/// fails if the premium (fee included) is higher.
pub fn handle_buy_cover(
    ctx: Context<BuyCover>,
    _ticker: Ticker,
    _closure_id: u32,
    max_payout: u64,
    max_premium: u64,
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, CoreError::Paused);
    let clock = Clock::get()?;

    // INV-3: only between sale_open and the bell, on an open epoch.
    let e = &ctx.accounts.epoch;
    require!(e.state == epoch_state::OPEN, CoreError::SalesClosed);
    require!(clock.unix_timestamp >= e.sale_open && clock.unix_timestamp < e.bell, CoreError::SalesClosed);

    let asset = ctx.accounts.asset.load()?;
    require!(asset.enabled == 1, CoreError::AssetDisabled);
    require!(
        asset.gap_factors_ready()
            && asset.gf_sigma_wad == asset.sigma_wad
            && asset.gf_dividend_wad == asset.dividend_wad
            && asset.gf_kappa_wad == cfg.kappa_wad,
        CoreError::StaleGapFactors
    );
    let set = ctx.accounts.scenarios.load()?;
    require!(set.finalized == 1, CoreError::NotFinalized);

    // Snapshot from the refreshed obligation (owner, single xStock + USDC, same slot).
    let ob = ObligationView::load(&ctx.accounts.obligation)?;
    let dep = ReserveView::load(&ctx.accounts.deposit_reserve)?;
    let bor = ReserveView::load(&ctx.accounts.borrow_reserve)?;
    let snap = cover_snapshot(
        &ob,
        ctx.accounts.buyer.key,
        clock.slot,
        &CoverAccounts {
            deposit_reserve_key: ctx.accounts.deposit_reserve.key(),
            deposit_reserve: &dep,
            borrow_reserve_key: ctx.accounts.borrow_reserve.key(),
            borrow_reserve: &bor,
            asset_mint: asset.mint,
            asset_reserves: asset.kamino_reserves,
            usdc_mint: cfg.usdc_mint,
        },
    )?;
    require!(max_payout > 0 && max_payout <= snap.debt, CoreError::InvalidParam);
    let x = CoverInputs { covered_value: snap.covered_value, debt: snap.debt, max_payout };

    // Capped loss per joint scenario, capacity (INV-2) and concentration.
    let mut losses = vec![0u64; K];
    let worst = policy_losses(&asset, &x, &mut losses)?;
    let (cap, group_max_before) = {
        let l = ctx.accounts.loss.load()?;
        require!(l.settled == 0, CoreError::SalesClosed);
        (capacity(&l.losses, &losses, reserved_other(&ctx.accounts.vault, &l)?, ctx.accounts.vault.equity, cfg.u_max_wad)?, l.max_loss)
    };
    let asset_limit = concentration_limit(ctx.accounts.vault.equity, cfg.u_max_wad, cfg.max_asset_share_wad);
    let asset_worst = e.worst_loss_sum.checked_add(worst).ok_or(CoreError::Math)?;
    require!(asset_worst as u128 <= asset_limit, CoreError::ConcentrationExceeded);

    // Premium (risk-core, rounded up) and fee (rounded down: the vault keeps the remainder).
    let prem = premium(&set.z[..set.n as usize], cfg, asset.sigma_wad, asset.dividend_wad, WEEKEND_CLOSURE_DAYS, cap.util_after_wad, &x)?;
    require!(prem <= max_premium, CoreError::PremiumAboveMax);
    let fee = u64::try_from((prem as u128) * (cfg.fee_bps as u128) / 10_000).map_err(|_| CoreError::Math)?;
    let net = prem.checked_sub(fee).ok_or(CoreError::Math)?;
    drop(asset);
    drop(set);

    pay(&ctx, net, &ctx.accounts.vault_usdc)?;
    if fee > 0 {
        pay(&ctx, fee, &ctx.accounts.fee_account)?;
    }

    let policy_key = ctx.accounts.policy.key();
    let mut loss = ctx.accounts.loss.load_mut()?;
    record_policy(
        &mut ctx.accounts.vault,
        &mut loss,
        &mut ctx.accounts.epoch,
        &losses,
        cap.group_worst_after,
        group_max_before,
        worst,
        max_payout,
        prem,
        net,
    )?;
    drop(loss);
    let p = &mut ctx.accounts.policy;
    p.owner = ctx.accounts.buyer.key();
    p.obligation = ctx.accounts.obligation.key();
    p.borrow_reserve = ctx.accounts.borrow_reserve.key(); // = the obligation's only borrow (cover_snapshot)
    p.epoch = ctx.accounts.epoch.key();
    p.ticker = ctx.accounts.epoch.ticker;
    p.side = side::DOWN;
    p.state = policy_state::ACTIVE;
    p.bump = ctx.bumps.policy;
    write_snapshot(p, &snap);
    p.max_payout = max_payout;
    p.premium = prem;
    p.worst_loss = worst;
    p.payout = 0;
    p.created_at = clock.unix_timestamp;
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

/// `max_asset_share × u_max × equity`, rounded DOWN (a smaller limit is conservative).
pub fn concentration_limit(equity: u64, u_max_wad: u64, share_wad: u64) -> u128 {
    (equity as u128) * (u_max_wad as u128) / WAD * (share_wad as u128) / WAD
}

fn pay<'info>(ctx: &Context<BuyCover<'info>>, amount: u64, to: &Account<'info, TokenAccount>) -> Result<()> {
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.buyer_usdc.to_account_info(),
                to: to.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        amount,
    )
}

fn write_snapshot(p: &mut Policy, s: &CoverSnapshot) {
    p.collateral_value = s.collateral_value;
    p.covered_value = s.covered_value;
    p.debt = s.debt;
    p.liquidation_threshold_wad = s.liquidation_threshold_wad;
}

/// Every state change of a purchase, in one place: the group's loss vector, the vault's reservation and premiums,
/// and the epoch's totals. `group_worst_after` is `max_j(group_j + policy_j)` from the capacity check.
#[allow(clippy::too_many_arguments)]
fn record_policy(
    v: &mut Vault,
    l: &mut LossVector,
    e: &mut Epoch,
    losses: &[u64],
    group_worst_after: u64,
    group_max_before: u64,
    worst: u64,
    max_payout: u64,
    premium: u64,
    net_premium: u64,
) -> Result<()> {
    for (slot, add) in l.losses.iter_mut().zip(losses) {
        *slot = slot.checked_add(*add).ok_or(CoreError::Math)?;
    }
    l.max_loss = group_worst_after;
    if l.policy_count == 0 {
        v.live_groups = v.live_groups.checked_add(1).ok_or(CoreError::Math)?;
    }
    l.policy_count = l.policy_count.checked_add(1).ok_or(CoreError::Math)?;
    l.premiums = l.premiums.checked_add(net_premium).ok_or(CoreError::Math)?;

    // reserved_total holds Σ live groups' max_loss: replace this group's old max with the new one.
    v.reserved_total = v
        .reserved_total
        .checked_sub(group_max_before)
        .and_then(|r| r.checked_add(group_worst_after))
        .ok_or(CoreError::Math)?;
    v.premiums_unearned = v.premiums_unearned.checked_add(net_premium).ok_or(CoreError::Math)?;
    v.total_premiums = v.total_premiums.checked_add(net_premium).ok_or(CoreError::Math)?;
    v.latest_group = v.latest_group.max(l.group);

    e.policy_count = e.policy_count.checked_add(1).ok_or(CoreError::Math)?;
    e.total_max_payout = e.total_max_payout.checked_add(max_payout).ok_or(CoreError::Math)?;
    e.worst_loss_sum = e.worst_loss_sum.checked_add(worst).ok_or(CoreError::Math)?;
    e.total_premium = e.total_premium.checked_add(premium).ok_or(CoreError::Math)?;
    Ok(())
}

#[event]
pub struct CoverBought {
    pub policy: Pubkey,
    pub owner: Pubkey,
    pub obligation: Pubkey,
    pub ticker: Ticker,
    pub closure_id: u32,
    pub covered_value: u64,
    pub debt: u64,
    pub max_payout: u64,
    pub premium: u64,
    pub fee: u64,
    pub worst_loss: u64,
    pub util_after_wad: u64,
}
