//! `buy_cover` (task 2.3). Settlement of a policy: `settle.rs` (task 2.5).
//!
//! The snapshot comes from the chain, never from the buyer: the transaction is `refresh_reserve` (every reserve of the
//! obligation) → `refresh_obligation` → `buy_cover`, and `buy_cover` decodes the obligation itself
//! (`kamino::cover_snapshot`). Premium and capacity use the same capped loss; every state change of a
//! purchase happens in [`record_policy`].

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::instructions::quote::reserved_other;
use crate::kamino::{cover_snapshot, cover_snapshot_in, CoverAccounts, CoverSnapshot, ObligationView, ReserveView};
use crate::math::{free_equity, WAD};
use crate::pricing::{capacity, policy_losses_scaled, premium, priced_debt, reserved_debt, shield_loading, CoverInputs};
use crate::state::*;
use crate::CoreError;

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct BuyCover<'info> {
    /// Buyer: must be the obligation's owner; pays the premium and the policy's rent.
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    /// The asset's scenario set for the epoch's closure type (W11; PDA checked by `closure_terms`).
    pub scenarios: AccountLoader<'info, ScenarioSet>,
    #[account(mut, seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    /// CHECK: the asset's `["earnings", ticker]` PDA (checked by `closure_terms`), initialised or not (W11).
    pub earnings: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_LOSS, &closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    /// LP share mint (supply prices the queued withdrawals out of capacity).
    #[account(address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = vault.fee_account @ CoreError::InvalidParam)]
    pub fee_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,
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
        seeds = [SEED_POLICY, epoch.key().as_ref(), obligation.key().as_ref()], bump
    )]
    pub policy: Box<Account<'info, Policy>>,
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
    let asset = ctx.accounts.asset.load()?;
    let owner = ctx.accounts.buyer.key();
    let pr = price_cover(
        &PriceIn {
            cfg,
            asset: &asset,
            scenarios: &ctx.accounts.scenarios,
            epoch: &ctx.accounts.epoch,
            earnings: ctx.accounts.earnings.as_ref(),
            vault: &ctx.accounts.vault,
            share_supply: ctx.accounts.share_mint.supply,
            loss: &ctx.accounts.loss,
            obligation: ctx.accounts.obligation.as_ref(),
            deposit_reserve: ctx.accounts.deposit_reserve.as_ref(),
            borrow_reserve: ctx.accounts.borrow_reserve.as_ref(),
            owner,
            clock: &clock,
        },
        Some(max_payout),
        None,
        0,
    )?;
    require!(pr.prem <= max_premium, CoreError::PremiumAboveMax);
    drop(asset);

    pay(&ctx, pr.net, &ctx.accounts.vault_usdc)?;
    if pr.fee > 0 {
        pay(&ctx, pr.fee, &ctx.accounts.fee_account)?;
    }

    let policy_key = ctx.accounts.policy.key();
    let bump = ctx.bumps.policy;
    let accts = &mut *ctx.accounts;
    let epoch_key = accts.epoch.key();
    commit_policy(
        &mut accts.vault,
        &accts.loss,
        &mut accts.epoch,
        &mut accts.vault_usdc,
        &mut accts.policy,
        &pr,
        owner,
        accts.obligation.key(),
        accts.borrow_reserve.key(),
        epoch_key,
        bump,
        accts.config.debt_growth_cap_wad,
        clock.unix_timestamp,
    )?;
    let p = &accts.policy;
    emit!(CoverBought {
        policy: policy_key,
        owner: p.owner,
        obligation: p.obligation,
        ticker: p.ticker,
        closure_id: accts.epoch.closure_id,
        covered_value: pr.snap.covered_value,
        debt: pr.snap.debt,
        max_payout: pr.max_payout,
        premium: pr.prem,
        fee: pr.fee,
        worst_loss: pr.worst,
        util_after_wad: pr.cap.util_after_wad,
    });
    Ok(())
}

/// Everything `buy_cover` and the weekend-safe market's `wsm_auto_cover` share about *what a cover costs*: a pure
/// function of the chain's state, with no payment and no write. It fails (never half-applies) when the epoch is not on
/// sale, the asset is not ready, the obligation is not what the cover can price, or the vault cannot hold the loss.
pub(crate) struct PriceIn<'a, 'info> {
    pub cfg: &'a Config,
    pub asset: &'a AssetConfig,
    pub scenarios: &'a AccountLoader<'info, ScenarioSet>,
    pub epoch: &'a Epoch,
    pub earnings: &'a AccountInfo<'info>,
    pub vault: &'a Vault,
    pub share_supply: u64,
    pub loss: &'a AccountLoader<'info, LossVector>,
    pub obligation: &'a AccountInfo<'info>,
    pub deposit_reserve: &'a AccountInfo<'info>,
    pub borrow_reserve: &'a AccountInfo<'info>,
    /// The obligation's owner the snapshot is taken for (`buy_cover`: the signer).
    pub owner: Pubkey,
    pub clock: &'a Clock,
}

pub(crate) struct Priced {
    pub snap: CoverSnapshot,
    pub max_payout: u64,
    pub losses: Vec<u64>,
    pub worst: u64,
    pub cap: crate::pricing::Capacity,
    pub group_max_before: u64,
    pub prem: u64,
    pub fee: u64,
    pub net: u64,
    pub loading: u64,
    pub borrow_index: u128,
}

/// `wsm_reserve`: for an obligation in the weekend-safe market, the asset's deposit reserve there (otherwise the
/// asset's own, by market). `extra_debt`: base units added to the snapshot's debt before pricing (the weekend-safe
/// market borrows its premium on the position, so the cover is for the debt that exists after it). `max_payout`
/// `None`: full cover of that debt.
pub(crate) fn price_cover(i: &PriceIn, max_payout: Option<u64>, wsm_reserve: Option<Pubkey>, extra_debt: u64) -> Result<Priced> {
    let (cfg, asset, e) = (i.cfg, i.asset, i.epoch);
    // INV-3: only between sale_open and the bell, on an open epoch.
    require!(e.state == epoch_state::OPEN, CoreError::SalesClosed);
    require!(i.clock.unix_timestamp >= e.sale_open && i.clock.unix_timestamp < e.bell, CoreError::SalesClosed);
    require!(asset.enabled == 1, CoreError::AssetDisabled);
    require!(asset.lender == lender::KAMINO as u64, CoreError::InvalidParam); // a Jupiter asset sells through buy_cover_jl (A-53)
    require!(
        asset.gap_factors_ready()
            && asset.gf_sigma_wad == asset.sigma_wad
            && asset.gf_dividend_wad == asset.dividend_wad
            && asset.gf_kappa_wad == cfg.kappa_wad,
        CoreError::StaleGapFactors
    );
    let set = i.scenarios.load()?;
    let terms = crate::instructions::quote::closure_terms(asset, &set, &i.scenarios.key(), e, i.earnings)?;

    // Snapshot from the refreshed obligation (owner, single xStock + USDC, same slot).
    let ob = ObligationView::load(i.obligation)?;
    let dep = ReserveView::load(i.deposit_reserve)?;
    let bor = ReserveView::load(i.borrow_reserve)?;
    let accounts = CoverAccounts {
        deposit_reserve_key: i.deposit_reserve.key(),
        deposit_reserve: &dep,
        borrow_reserve_key: i.borrow_reserve.key(),
        borrow_reserve: &bor,
        asset_mint: asset.mint,
        asset_reserves: asset.kamino_reserves,
        usdc_mint: cfg.usdc_mint,
    };
    let mut snap = match wsm_reserve {
        Some(r) => {
            require_keys_eq!(ob.lending_market, crate::kamino::WSM_MARKET, CoreError::MarketNotAllowed);
            cover_snapshot_in(&ob, &i.owner, i.clock.slot, &accounts, r)?
        }
        None => cover_snapshot(&ob, &i.owner, i.clock.slot, &accounts)?,
    };
    snap.debt = snap.debt.checked_add(extra_debt).ok_or(CoreError::Math)?;
    let max_payout = match max_payout {
        Some(m) => {
            require!(m > 0 && m <= snap.debt, CoreError::InvalidParam);
            m
        }
        None => snap.debt,
    };
    require!(bor.cumulative_borrow_rate_bsf > 0, CoreError::KaminoLayout);
    // Reserved on the debt plus the most interest the shield and settlement count, priced on the expected interest
    // (task 1.2).
    let x = CoverInputs { covered_value: snap.covered_value, debt: reserved_debt(snap.debt, cfg)?, max_payout };
    let xp = CoverInputs { debt: priced_debt(snap.debt, cfg)?, ..x };

    // Capped loss per joint scenario, capacity (INV-2) and concentration, against equity net of queued withdrawals.
    let mut losses = vec![0u64; K];
    let worst = policy_losses_scaled(asset, cfg, &x, terms.capacity_mult_wad, &mut losses)?;
    let v = i.vault;
    // Inventory never backs cover (W2, INV-13): capacity is sized on equity less the backstop's inventory at cost.
    let equity = free_equity(v.cover_equity()?, v.queued_withdraw_shares, i.share_supply).ok_or(CoreError::Math)?;
    let (cap, group_max_before) = {
        let l = i.loss.load()?;
        require!(l.settled == 0, CoreError::SalesClosed);
        (capacity(&l.losses, &losses, reserved_other(v, &l)?, equity, cfg.u_max_wad)?, l.max_loss)
    };
    let asset_limit = concentration_limit(equity, cfg.u_max_wad, cfg.max_asset_share_wad);
    let asset_worst = e.worst_loss_sum.checked_add(worst).ok_or(CoreError::Math)?;
    require!(asset_worst as u128 <= asset_limit, CoreError::ConcentrationExceeded);

    // Premium (risk-core, rounded up) and fee (rounded down: the vault keeps the remainder).
    let z = &set.z[..set.n as usize];
    let loading = shield_loading(z, cfg, terms.sigma_wad, asset.basis_sigma_wad, &xp, worst)?;
    let prem = premium(z, cfg, terms.sigma_wad, asset.dividend_wad, terms.days, cap.util_after_wad, &xp)?
        .checked_add(loading)
        .ok_or(CoreError::Math)?;
    let fee = u64::try_from((prem as u128) * (cfg.fee_bps as u128) / 10_000).map_err(|_| CoreError::Math)?;
    let net = prem.checked_sub(fee).ok_or(CoreError::Math)?;
    Ok(Priced { snap, max_payout, losses, worst, cap, group_max_before, prem, fee, net, loading, borrow_index: bor.cumulative_borrow_rate_bsf })
}

/// Writes a purchase after `price_cover` and the payment: the vault's books (`record_policy`), the reservation-in-cash
/// check, and the policy account.
#[allow(clippy::too_many_arguments)]
pub(crate) fn commit_policy<'info>(
    vault: &mut Account<'info, Vault>,
    loss: &AccountLoader<'info, LossVector>,
    epoch: &mut Account<'info, Epoch>,
    vault_usdc: &mut Account<'info, TokenAccount>,
    p: &mut Policy,
    pr: &Priced,
    owner: Pubkey,
    obligation: Pubkey,
    borrow_reserve: Pubkey,
    epoch_key: Pubkey,
    bump: u8,
    debt_growth_cap_wad: u64,
    now: i64,
) -> Result<()> {
    let mut l = loss.load_mut()?;
    record_policy(vault, &mut l, epoch, &pr.losses, pr.cap.group_worst_after, pr.group_max_before, pr.worst, pr.max_payout, pr.prem, pr.net)?;
    drop(l);
    // Cash first (W3): with idle cash lent out, the reservation this cover adds must still be in cash, or a payout at
    // the open would depend on redeeming from a reserve that may be fully utilised.
    vault_usdc.reload()?;
    require!(vault_usdc.amount >= vault.reserved_cash()?, CoreError::CashBelowReservation);
    p.owner = owner;
    p.obligation = obligation;
    p.borrow_reserve = borrow_reserve; // = the obligation's only borrow (cover_snapshot)
    p.epoch = epoch_key;
    p.ticker = epoch.ticker;
    p.side = side::DOWN;
    p.state = policy_state::ACTIVE;
    p.bump = bump;
    write_snapshot(p, &pr.snap);
    p.max_payout = pr.max_payout;
    p.premium = pr.prem;
    p.fee = pr.fee;
    p.worst_loss = pr.worst;
    p.payout = 0;
    p.created_at = now;
    p.advanced = 0;
    p.advanced_at = 0;
    p.shield_loading = pr.loading;
    p.borrow_index_bsf = pr.borrow_index;
    p.debt_growth_cap_wad = debt_growth_cap_wad;
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
pub(crate) fn record_policy(
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
        v.add_live(l.group)?;
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
