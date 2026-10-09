//! `buy_cover_multi` (W4): Gap Cover on an obligation whose deposits are several covered xStocks and stablecoins, with
//! one USDC or PYUSD debt. The payout rule is `min(cap, D − Σ_i LT_i C_i (1 + r_i) − Σ_s LT_s S)` (`risk-core::multi`);
//! settlement waits for every leg's epoch.
//!
//! Transaction: `refresh_reserve` (every reserve of the obligation) → `refresh_obligation` → `buy_cover_multi`.
//! Accounts beyond the named ones (`remaining_accounts`), in order:
//! 1. the obligation's deposit reserves, in the obligation's deposit order;
//! 2. per leg i (legs in order of first appearance among the deposits): its `AssetConfig`, its `WEEKEND` scenario set
//!    and its epoch for `closure_id` (writable).
//!
//! Leg 0's epoch is the named `epoch` (the policy PDA's seed); its remaining-account slot repeats it. A PYUSD debt also
//! needs the vault's PYUSD sleeve (`sleeve`): it must hold every live PYUSD policy's reservation after this one (INV-14).
//! The premium is always paid in USDC.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::TokenAccount as TokenAccountInterface;

use crate::instructions::cover::concentration_limit;
use crate::instructions::quote::{reserved_other, WEEKEND_CLOSURE_DAYS};
use crate::kamino::{cover_snapshot_multi, DepositLeg, ObligationView, ReserveView, XSTOCKS_MARKETS};
use crate::math::free_equity;
use crate::pricing::{
    capacity, policy_losses_multi, premium_multi, priced_debt, reserved_debt, settlement_losses_multi, LegPricing, MultiInputs,
};
use crate::state::*;
use crate::CoreError;

#[derive(Accounts)]
#[instruction(closure_id: u32)]
pub struct BuyCoverMulti<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// Leg 0's epoch for `closure_id` (checked against leg 0 below).
    #[account(mut, constraint = epoch.closure_id == closure_id @ CoreError::InvalidParam)]
    pub epoch: Box<Account<'info, Epoch>>,
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
    /// CHECK: klend `Obligation` (decoded and checked in `cover_snapshot_multi`).
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: the obligation's borrow reserve (decoded; identity and contents checked).
    pub borrow_reserve: UncheckedAccount<'info>,
    /// The vault's PYUSD sleeve: required for a PYUSD debt (address checked).
    pub sleeve: Option<Box<InterfaceAccount<'info, TokenAccountInterface>>>,
    #[account(
        init, payer = buyer, space = Policy::SIZE,
        seeds = [SEED_POLICY, epoch.key().as_ref(), obligation.key().as_ref()], bump
    )]
    pub policy: Box<Account<'info, Policy>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_buy_cover_multi<'info>(
    ctx: Context<'info, BuyCoverMulti<'info>>,
    closure_id: u32,
    max_payout: u64,
    max_premium: u64,
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, CoreError::Paused);
    let clock = Clock::get()?;
    let ob = ObligationView::load(&ctx.accounts.obligation)?;
    let market_idx = XSTOCKS_MARKETS.iter().position(|m| *m == ob.lending_market).ok_or(CoreError::MarketNotAllowed)?;
    let n_dep = ob.deposits.len();
    let rem = ctx.remaining_accounts;
    require!(rem.len() >= n_dep, CoreError::InvalidParam);
    let reserves: Vec<ReserveView> = rem[..n_dep].iter().map(ReserveView::load).collect::<Result<_>>()?;

    // Legs: the remaining accounts after the reserves, three per leg.
    let leg_accts = &rem[n_dep..];
    require!(!leg_accts.is_empty() && leg_accts.len().is_multiple_of(3) && leg_accts.len() / 3 <= MAX_LEGS, CoreError::InvalidParam);
    let n_legs = leg_accts.len() / 3;
    let mut assets: Vec<AccountLoader<'info, AssetConfig>> = Vec::with_capacity(n_legs);
    let mut sets: Vec<AccountLoader<'info, ScenarioSet>> = Vec::with_capacity(n_legs);
    let mut epochs: Vec<Account<'info, Epoch>> = Vec::with_capacity(n_legs);
    for i in 0..n_legs {
        let a: AccountLoader<'info, AssetConfig> = AccountLoader::try_from(&leg_accts[3 * i])?;
        let s: AccountLoader<'info, ScenarioSet> = AccountLoader::try_from(&leg_accts[3 * i + 1])?;
        let e: Account<'info, Epoch> = Account::try_from(&leg_accts[3 * i + 2])?;
        {
            let av = a.load()?;
            require!(av.enabled == 1, CoreError::AssetDisabled);
            require!(
                av.gap_factors_ready() && av.gf_sigma_wad == av.sigma_wad && av.gf_dividend_wad == av.dividend_wad && av.gf_kappa_wad == cfg.kappa_wad,
                CoreError::StaleGapFactors
            );
            require_keys_eq!(s.key(), av.scenario_set, CoreError::InvalidParam);
            require!(s.load()?.finalized == 1, CoreError::NotFinalized);
            // The epoch is this asset's for this weekend, on sale now (INV-3).
            require!(e.ticker == av.ticker && e.closure_id == closure_id && leg_accts[3 * i + 2].is_writable, CoreError::InvalidParam);
            require!(e.state == epoch_state::OPEN && clock.unix_timestamp >= e.sale_open && clock.unix_timestamp < e.bell, CoreError::SalesClosed);
            // Distinct legs, all on one joint set (their gap factors are columns of the same scenarios).
            for prev in assets.iter() {
                require!(prev.load()?.ticker != av.ticker, CoreError::InvalidParam);
            }
            if i > 0 {
                require!(av.gf_joint_hash == assets[0].load()?.gf_joint_hash, CoreError::StaleGapFactors);
            }
        }
        assets.push(a);
        sets.push(s);
        epochs.push(e);
    }
    require_keys_eq!(epochs[0].key(), ctx.accounts.epoch.key(), CoreError::InvalidParam);

    // Each deposit: a leg's xStock reserve in this market, or a stablecoin.
    let mut deps = Vec::with_capacity(n_dep);
    let mut seen = [false; MAX_LEGS];
    for (k, r) in reserves.iter().enumerate() {
        let leg = assets.iter().position(|a| a.load().map(|v| v.kamino_reserves[market_idx] == rem[k].key() && v.mint == r.liquidity_mint).unwrap_or(false));
        if let Some(i) = leg {
            seen[i] = true;
        }
        deps.push(DepositLeg { reserve_key: rem[k].key(), reserve: r, leg });
    }
    require!(seen[..n_legs].iter().all(|x| *x), CoreError::UnsupportedObligation); // no leg without a deposit
    // Legs in order of first appearance among the deposits (A-45): leg 0, which seeds the policy PDA, is the
    // obligation's first xStock deposit, so an obligation has one policy address per weekend whatever the caller's order.
    let mut next = 0usize;
    for d in deps.iter() {
        if let Some(i) = d.leg {
            if i == next {
                next += 1;
            } else {
                require!(i < next, CoreError::InvalidParam);
            }
        }
    }
    let stable_mints = [cfg.usdc_mint, cfg.pyusd_mint];
    let bor = ReserveView::load(&ctx.accounts.borrow_reserve)?;
    let snap = cover_snapshot_multi(&ob, ctx.accounts.buyer.key, clock.slot, &deps, n_legs, ctx.accounts.borrow_reserve.key(), &bor, &stable_mints)?;
    require!(max_payout > 0 && max_payout <= snap.debt, CoreError::InvalidParam);
    // Already liquidatable (D ≥ Σ C′): klend acts before any weekend move, and every scenario would pay the cap.
    let covered_total = snap.leg_covered.iter().try_fold(snap.stable_covered, |a, c| a.checked_add(*c)).ok_or(CoreError::Math)?;
    require!(snap.debt < covered_total, CoreError::AlreadyLiquidatable);
    let pyusd = snap.borrow_mint == cfg.pyusd_mint && cfg.pyusd_mint != Pubkey::default();
    require!(pyusd || snap.borrow_mint == cfg.usdc_mint, CoreError::UnsupportedObligation);

    // Losses (reserved on the debt plus the interest cap), capacity, per-leg concentration.
    let av: Vec<_> = assets.iter().map(|a| a.load()).collect::<Result<_>>()?;
    let refs: Vec<&AssetConfig> = av.iter().map(|r| &**r).collect();
    let xr = MultiInputs { legs: &snap.leg_covered, stable: snap.stable_covered, debt: reserved_debt(snap.debt, cfg)?, max_payout };
    let mut losses = vec![0u64; K];
    let worst = policy_losses_multi(&refs, cfg, &xr, &mut losses)?;
    let v = &ctx.accounts.vault;
    let equity = free_equity(v.cover_equity()?, v.queued_withdraw_shares, ctx.accounts.share_mint.supply).ok_or(CoreError::Math)?;
    let (cap, group_max_before) = {
        let l = ctx.accounts.loss.load()?;
        require!(l.settled == 0, CoreError::SalesClosed);
        (capacity(&l.losses, &losses, reserved_other(v, &l)?, equity, cfg.u_max_wad)?, l.max_loss)
    };
    let limit = concentration_limit(equity, cfg.u_max_wad, cfg.max_asset_share_wad);
    for e in epochs.iter() {
        require!((e.worst_loss_sum as u128) + (worst as u128) <= limit, CoreError::ConcentrationExceeded);
    }

    // Premium: max(joint, max_i marginal_i) + Σ_i shield loading_i, priced on the expected interest.
    let xp = MultiInputs { debt: priced_debt(snap.debt, cfg)?, ..xr };
    let mut settle = vec![0u64; K];
    settlement_losses_multi(&refs, &xp, &mut settle)?;
    let sv: Vec<_> = sets.iter().map(|s| s.load()).collect::<Result<_>>()?;
    let pricing: Vec<LegPricing> = (0..n_legs)
        .map(|i| LegPricing { z: &sv[i].z[..sv[i].n as usize], sigma_wad: refs[i].sigma_wad, dividend_wad: refs[i].dividend_wad, basis_sigma_wad: refs[i].basis_sigma_wad })
        .collect();
    let (prem, loading) = premium_multi(&pricing, cfg, WEEKEND_CLOSURE_DAYS, cap.util_after_wad, &xp, &settle, worst)?;
    require!(prem <= max_premium, CoreError::PremiumAboveMax);
    let fee = u64::try_from((prem as u128) * (cfg.fee_bps as u128) / 10_000).map_err(|_| CoreError::Math)?;
    let net = prem.checked_sub(fee).ok_or(CoreError::Math)?;
    let tickers: Vec<Ticker> = refs.iter().map(|a| a.ticker).collect();
    let borrow_index = bor.cumulative_borrow_rate_bsf;
    require!(borrow_index > 0, CoreError::KaminoLayout);
    drop(sv);
    drop(av);

    // PYUSD debt: the sleeve must hold every live PYUSD reservation after this one (INV-14).
    if pyusd {
        let s = ctx.accounts.sleeve.as_ref().ok_or(CoreError::SleeveMissing)?;
        require_keys_eq!(s.key(), v.pyusd_sleeve, CoreError::InvalidParam);
        let need = v.pyusd_reserved.checked_add(worst).and_then(|x| x.checked_sub(v.pyusd_advanced)).ok_or(CoreError::Math)?;
        require!(s.amount >= need, CoreError::SleeveShort);
    }

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

    // Book the group, the vault, every leg's epoch (concentration) and leg 0's (counts and totals).
    {
        let mut l = ctx.accounts.loss.load_mut()?;
        for (slot, add) in l.losses.iter_mut().zip(&losses) {
            *slot = slot.checked_add(*add).ok_or(CoreError::Math)?;
        }
        l.max_loss = cap.group_worst_after;
        let v = &mut ctx.accounts.vault;
        if l.policy_count == 0 {
            v.add_live(l.group)?;
        }
        l.policy_count = l.policy_count.checked_add(1).ok_or(CoreError::Math)?;
        l.premiums = l.premiums.checked_add(net).ok_or(CoreError::Math)?;
        v.reserved_total = v.reserved_total.checked_sub(group_max_before).and_then(|r| r.checked_add(cap.group_worst_after)).ok_or(CoreError::Math)?;
        v.premiums_unearned = v.premiums_unearned.checked_add(net).ok_or(CoreError::Math)?;
        v.total_premiums = v.total_premiums.checked_add(net).ok_or(CoreError::Math)?;
        v.latest_group = v.latest_group.max(l.group);
        if pyusd {
            v.pyusd_reserved = v.pyusd_reserved.checked_add(worst).ok_or(CoreError::Math)?;
        }
    }
    ctx.accounts.vault_usdc.reload()?;
    require!(ctx.accounts.vault_usdc.amount >= ctx.accounts.vault.reserved_cash()?, CoreError::CashBelowReservation);
    for (i, e) in epochs.iter_mut().enumerate() {
        if i == 0 {
            continue; // the named `epoch` is the same account; booked below
        }
        e.worst_loss_sum = e.worst_loss_sum.checked_add(worst).ok_or(CoreError::Math)?;
        e.exit(ctx.program_id)?;
    }
    let e0 = &mut ctx.accounts.epoch;
    e0.policy_count = e0.policy_count.checked_add(1).ok_or(CoreError::Math)?;
    e0.total_max_payout = e0.total_max_payout.checked_add(max_payout).ok_or(CoreError::Math)?;
    e0.worst_loss_sum = e0.worst_loss_sum.checked_add(worst).ok_or(CoreError::Math)?;
    e0.total_premium = e0.total_premium.checked_add(prem).ok_or(CoreError::Math)?;

    let p = &mut ctx.accounts.policy;
    p.owner = ctx.accounts.buyer.key();
    p.obligation = ctx.accounts.obligation.key();
    p.borrow_reserve = ctx.accounts.borrow_reserve.key();
    p.epoch = ctx.accounts.epoch.key();
    p.ticker = tickers[0];
    p.side = side::DOWN;
    p.state = policy_state::ACTIVE;
    p.bump = ctx.bumps.policy;
    p.collateral_value = snap.collateral_value;
    p.covered_value = snap.leg_covered.iter().sum::<u64>().checked_add(snap.stable_covered).ok_or(CoreError::Math)?;
    p.debt = snap.debt;
    p.liquidation_threshold_wad = 0; // per leg (each reserve's LT); see leg_covered
    p.max_payout = max_payout;
    p.premium = prem;
    p.fee = fee;
    p.worst_loss = worst;
    p.payout = 0;
    p.created_at = clock.unix_timestamp;
    p.advanced = 0;
    p.advanced_at = 0;
    p.shield_loading = loading;
    p.borrow_index_bsf = borrow_index;
    p.debt_growth_cap_wad = cfg.debt_growth_cap_wad;
    p.n_legs = n_legs as u8;
    for (i, t) in tickers.iter().enumerate() {
        p.leg_tickers[8 * i..8 * i + 8].copy_from_slice(t);
        p.leg_covered[i] = snap.leg_covered[i];
    }
    p.stable_covered = snap.stable_covered;
    p.borrow_mint = snap.borrow_mint;
    emit!(MultiCoverBought {
        policy: p.key(),
        owner: p.owner,
        obligation: p.obligation,
        closure_id,
        legs: n_legs as u8,
        covered_value: p.covered_value,
        stable_covered: snap.stable_covered,
        debt: snap.debt,
        borrow_mint: snap.borrow_mint,
        max_payout,
        premium: prem,
        worst_loss: worst,
        util_after_wad: cap.util_after_wad,
    });
    Ok(())
}

#[event]
pub struct MultiCoverBought {
    pub policy: Pubkey,
    pub owner: Pubkey,
    pub obligation: Pubkey,
    pub closure_id: u32,
    pub legs: u8,
    pub covered_value: u64,
    pub stable_covered: u64,
    pub debt: u64,
    pub borrow_mint: Pubkey,
    pub max_payout: u64,
    pub premium: u64,
    pub worst_loss: u64,
    pub util_after_wad: u64,
}

#[derive(Accounts)]
pub struct QuoteCoverMulti<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

/// Read-only multi-collateral quote (app preview, CU measurement): `remaining_accounts` = per leg its `AssetConfig` and
/// its scenario set; `legs` the covered values `C′_i`, `stable` S′, `debt` D, `max_payout`. Utilisation 0 (no vault).
pub fn handle_quote_cover_multi<'info>(
    ctx: Context<'info, QuoteCoverMulti<'info>>,
    legs: Vec<u64>,
    stable: u64,
    debt: u64,
    max_payout: u64,
) -> Result<crate::instructions::quote::Quote> {
    let cfg = &ctx.accounts.config;
    let rem = ctx.remaining_accounts;
    require!(!legs.is_empty() && legs.len() <= MAX_LEGS && rem.len() == 2 * legs.len(), CoreError::InvalidParam);
    require!(max_payout > 0 && max_payout <= debt, CoreError::InvalidParam);
    let mut assets: Vec<AccountLoader<'info, AssetConfig>> = Vec::with_capacity(legs.len());
    let mut sets: Vec<AccountLoader<'info, ScenarioSet>> = Vec::with_capacity(legs.len());
    for i in 0..legs.len() {
        let a: AccountLoader<'info, AssetConfig> = AccountLoader::try_from(&rem[2 * i])?;
        let s: AccountLoader<'info, ScenarioSet> = AccountLoader::try_from(&rem[2 * i + 1])?;
        require_keys_eq!(s.key(), a.load()?.scenario_set, CoreError::InvalidParam);
        require!(a.load()?.gap_factors_ready(), CoreError::StaleGapFactors);
        assets.push(a);
        sets.push(s);
    }
    let av: Vec<_> = assets.iter().map(|a| a.load()).collect::<Result<_>>()?;
    let refs: Vec<&AssetConfig> = av.iter().map(|r| &**r).collect();
    let xr = MultiInputs { legs: &legs, stable, debt: reserved_debt(debt, cfg)?, max_payout };
    let mut losses = vec![0u64; K];
    let worst = policy_losses_multi(&refs, cfg, &xr, &mut losses)?;
    let xp = MultiInputs { debt: priced_debt(debt, cfg)?, ..xr };
    let mut settle = vec![0u64; K];
    settlement_losses_multi(&refs, &xp, &mut settle)?;
    let sv: Vec<_> = sets.iter().map(|s| s.load()).collect::<Result<_>>()?;
    let pricing: Vec<LegPricing> = (0..legs.len())
        .map(|i| LegPricing { z: &sv[i].z[..sv[i].n as usize], sigma_wad: refs[i].sigma_wad, dividend_wad: refs[i].dividend_wad, basis_sigma_wad: refs[i].basis_sigma_wad })
        .collect();
    let (premium, shield_loading) = premium_multi(&pricing, cfg, WEEKEND_CLOSURE_DAYS, 0, &xp, &settle, worst)?;
    Ok(crate::instructions::quote::Quote { premium, worst_loss: worst, util_after_wad: 0, group_worst_after: worst, shield_loading })
}
