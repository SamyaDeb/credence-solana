//! Jupiter Lend cover (W12, task B2): Gap Cover, the Liquidation Shield and settlement on a Jupiter Lend Vaults
//! position, the second lender next to Kamino.
//!
//! - An asset covers one lender. A Jupiter alias asset (`<T>.J`) carries `<T>`'s scenarios and joint column, so both
//!   lenders' policies net in one loss vector per weekend (INV-2), and settles on Jupiter's own oracle (source
//!   `JUPITER`): the payout uses the price the position is valued at, with no basis between them.
//! - `buy_cover_jl`: the buyer holds the position NFT; the snapshot is decoded from the position (raw collateral, tick),
//!   its tick (not liquidated), the vault's state (exchange prices) and the Chainlink cache the vault's oracle reads:
//!   `C′ = LT × col × price`, `D = debt_raw(col, tick)` (Fluid tick math, `risk-core::fluid`, rounded UP). The
//!   gross debt (before Fluid's dust credit) is the one liquidations act on.
//! - `settle_policy_jl` / `shield_advance_jl`: the vault PDA pays back the position's debt with a Vaults `operate`
//!   CPI (`jupiter::operate_payback`; proven on a fork, plan/09). `operate`'s tick accounts depend on the exact amount,
//!   so the keeper first simulates with `expected = u64::MAX`, which only returns the amount (return data), then sends
//!   with `expected` = that amount; any other value is refused (`AmountMismatch`). The program pins the accounts that
//!   matter in `operate`'s list (signer = vault PDA, its USDC = the vault's, the vault config and the position); the
//!   rest Jupiter checks. USDC Jupiter does not take stays in the vault; a position that no longer borrows is paid in
//!   the owner's wallet. Debt is quantised by tick (0.15%): the shield's health buffer covers it.
//! - klend restricts Jupiter's Vaults program: these instructions never share a transaction with klend.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use credence_risk_core::fluid::{debt_raw, raw_to_tokens, MIN_TICK};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::instructions::cover::{concentration_limit, record_policy, CoverBought};
use crate::instructions::quote::{reserved_other, WEEKEND_CLOSURE_DAYS};
use crate::instructions::settle::{finish_policy, payout_due};
use crate::instructions::shield::{ShieldAdvanced, FAIR_BEFORE_CLOSE_SECS, MIN_TOPUP};
use crate::jupiter::{
    op_idx, operate_payback, oracle_single_cache, read_cache, token_account_basics, PositionView, TickView, VaultConfigView,
    VaultStateView, JL_VAULTS_PROGRAM_ID, OPERATE_NAMED,
};
use crate::math::{free_equity, WAD};
use crate::oracle::{check_update, push_account};
use crate::pricing::{
    accrued_debt, capacity, policy_losses, premium, priced_debt, reserved_debt, shield_loading, shield_target, CoverInputs,
    ShieldParams,
};
use crate::state::*;
use crate::CoreError;

/// Jupiter refuses any `operate` that leaves a position above its liquidation threshold, a payback included, and a
/// position's debt sits on a tick (0.15% steps): a payout that restores health to exactly 1 can land a hair above the
/// line and fail. Measured on a fork: Jupiter accepted a payback only below a debt-to-value of 0.8456 on a vault with an
/// 85% threshold (0.5% stricter, the post-payback tick rounded up). A Jupiter policy's debt carries this buffer (1%) in
/// pricing and payout alike, so a payout restores health to at most 1/1.01 of the threshold.
pub const JL_DEBT_BUFFER_BPS: u64 = 100;

/// A purchase prices on a Chainlink cache at most this old (Jupiter's keepers refresh it within seconds in session).
pub const MAX_CACHE_AGE_SECS: i64 = 600;
/// xStocks have 8 decimals, USDC 6.
const XSTOCK_DECIMALS: u8 = 8;
const USDC_DECIMALS: u8 = 6;

// ---------------------------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct SetAssetLender<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_ASSET, ticker.as_ref()], bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    /// CHECK: Jupiter Lend `VaultConfig` of the asset's USDC vault (decoded: owner, discriminator, mints).
    pub lender_vault: UncheckedAccount<'info>,
    /// CHECK: the vault's Jupiter `Oracle` (key = the vault config's; decoded: one Chainlink cache, ×1).
    pub lender_oracle_config: UncheckedAccount<'info>,
}

/// Makes the asset a Jupiter Lend asset (W12): its USDC vault and the Chainlink cache that vault's oracle reads. Only a
/// fresh `<T>.J` alias with the JUPITER settle source, only once (A-58).
pub fn handle_set_asset_lender(ctx: Context<SetAssetLender>, _ticker: Ticker) -> Result<()> {
    let vc = VaultConfigView::load(&ctx.accounts.lender_vault)?;
    let mut a = ctx.accounts.asset.load_mut()?;
    // Once, on a `<T>.J` alias settled on Jupiter's oracle (A-58): never a Kamino asset, never a second time (the
    // cache would change between an epoch's close and its open).
    let len = a.ticker.iter().position(|b| *b == 0).unwrap_or(8);
    require!(
        a.lender == lender::KAMINO as u64 && a.settle_source == crate::oracle::source::JUPITER as u64 && len >= 3 && &a.ticker[len - 2..len] == b".J",
        CoreError::InvalidParam
    );
    require!(vc.supply_token == a.mint && vc.borrow_token == ctx.accounts.config.usdc_mint, CoreError::JupiterLayout);
    require!(vc.vault_type <= 1, CoreError::JupiterLayout); // T1 (0 or 1): plain collateral, plain debt (not a DEX vault)
    require_keys_eq!(ctx.accounts.lender_oracle_config.key(), vc.oracle, CoreError::JupiterLayout);
    let cache = oracle_single_cache(&ctx.accounts.lender_oracle_config)?;
    a.lender = lender::JUPITER as u64;
    a.lender_vault = ctx.accounts.lender_vault.key();
    a.lender_oracle = cache;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// buy_cover_jl
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct BuyCoverJl<'info> {
    /// Buyer: holds the position NFT; pays the premium and the policy's rent.
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(address = asset.load()?.scenario_set @ CoreError::InvalidParam)]
    pub scenarios: AccountLoader<'info, ScenarioSet>,
    #[account(mut, seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump = epoch.bump)]
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
    /// CHECK: Jupiter Lend `Position` (owner, discriminator, vault checked).
    pub position: UncheckedAccount<'info>,
    /// CHECK: the buyer's token account of the position NFT (mint, owner = buyer, amount 1 checked).
    pub position_token_account: UncheckedAccount<'info>,
    /// CHECK: the asset's Jupiter USDC vault config (address checked, decoded).
    #[account(address = asset.load()?.lender_vault @ CoreError::InvalidParam)]
    pub vault_config: UncheckedAccount<'info>,
    /// CHECK: the vault's `VaultState` (owner, discriminator, vault id checked).
    pub vault_state: UncheckedAccount<'info>,
    /// CHECK: the position's `Tick` (owner, discriminator, vault and tick checked).
    pub position_tick: UncheckedAccount<'info>,
    /// CHECK: the asset's Chainlink Data Streams cache (address, owner, discriminator checked by `read_cache`).
    pub cache: UncheckedAccount<'info>,
    #[account(
        init, payer = buyer, space = Policy::SIZE,
        seeds = [SEED_POLICY, epoch.key().as_ref(), position.key().as_ref()], bump
    )]
    pub policy: Box<Account<'info, Policy>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// The snapshot of a Jupiter Lend position, USDC base units: collateral value and C′ rounded DOWN, debt UP.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JlSnapshot {
    pub collateral_value: u64,
    pub covered_value: u64,
    pub debt: u64,
    pub liquidation_threshold_wad: u64,
}

/// `C = col × price` (col in 8-decimal xStock units, price USD per token WAD), `C′ = C × LT`, `D` from the tick plus
/// [`JL_DEBT_BUFFER_BPS`] (rounded UP).
pub fn jl_snapshot(pos: &PositionView, vs: &VaultStateView, lt_permille: u16, price_wad: u128) -> Result<JlSnapshot> {
    require!(!pos.is_supply_only && pos.tick > MIN_TICK, CoreError::UnsupportedObligation); // no debt
    require!(lt_permille > 0 && lt_permille < 1000, CoreError::JupiterLayout);
    let m = |_| error!(CoreError::Math);
    let col = raw_to_tokens(pos.supply_raw as u128, vs.supply_exchange_price, XSTOCK_DECIMALS, false).map_err(m)?;
    let draw = debt_raw(pos.supply_raw, pos.tick).map_err(m)?;
    let debt0 = raw_to_tokens(draw, vs.borrow_exchange_price, USDC_DECIMALS, true).map_err(m)?;
    let debt = u64::try_from((debt0 as u128 * (10_000 + JL_DEBT_BUFFER_BPS) as u128).div_ceil(10_000)).map_err(|_| error!(CoreError::Math))?;
    // USDC base units: col (1e8) × price (1e18) / 1e18 / 1e2.
    let value = (col as u128).checked_mul(price_wad).ok_or(CoreError::Math)? / WAD / 100;
    let covered = value * (lt_permille as u128) / 1000;
    let c = |x: u128| u64::try_from(x).map_err(|_| error!(CoreError::Math));
    Ok(JlSnapshot { collateral_value: c(value)?, covered_value: c(covered)?, debt, liquidation_threshold_wad: c(lt_permille as u128 * WAD / 1000)? })
}

/// Buys `DOWN` gap cover for `closure_id` on the buyer's Jupiter Lend position (one xStock, USDC debt).
pub fn handle_buy_cover_jl(ctx: Context<BuyCoverJl>, _ticker: Ticker, _closure_id: u32, max_payout: u64, max_premium: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, CoreError::Paused);
    let clock = Clock::get()?;
    let e = &ctx.accounts.epoch;
    require!(e.state == epoch_state::OPEN, CoreError::SalesClosed);
    require!(clock.unix_timestamp >= e.sale_open && clock.unix_timestamp < e.bell, CoreError::SalesClosed); // INV-3

    let asset = ctx.accounts.asset.load()?;
    require!(asset.enabled == 1, CoreError::AssetDisabled);
    require!(asset.lender == lender::JUPITER as u64, CoreError::InvalidParam);
    require!(
        asset.gap_factors_ready()
            && asset.gf_sigma_wad == asset.sigma_wad
            && asset.gf_dividend_wad == asset.dividend_wad
            && asset.gf_kappa_wad == cfg.kappa_wad,
        CoreError::StaleGapFactors
    );
    let set = ctx.accounts.scenarios.load()?;
    require!(set.finalized == 1, CoreError::NotFinalized);

    // The position: in the asset's vault, owned by the buyer (NFT), not liquidated; the vault's exchange prices and
    // the cache its oracle reads, fresh.
    let vc = VaultConfigView::load(&ctx.accounts.vault_config)?;
    require!(vc.supply_token == asset.mint && vc.borrow_token == cfg.usdc_mint, CoreError::JupiterLayout);
    let vs = VaultStateView::load(&ctx.accounts.vault_state)?;
    let pos = PositionView::load(&ctx.accounts.position)?;
    require!(vs.vault_id == vc.vault_id && pos.vault_id == vc.vault_id, CoreError::JupiterLayout);
    let (nft_mint, nft_owner, nft_amount) = token_account_basics(&ctx.accounts.position_token_account)?;
    require!(nft_mint == pos.position_mint && nft_amount == 1, CoreError::InvalidParam);
    require_keys_eq!(nft_owner, ctx.accounts.buyer.key(), CoreError::NotObligationOwner);
    let tick = TickView::load(&ctx.accounts.position_tick)?;
    require!(tick.vault_id == vc.vault_id && tick.tick == pos.tick, CoreError::JupiterLayout);
    require!(!tick.is_liquidated && tick.total_ids <= pos.tick_id, CoreError::PositionLiquidated);
    let px = read_cache(&ctx.accounts.cache, &asset.lender_oracle)?;
    require!(!px.suspended && clock.unix_timestamp - px.unix_timestamp <= MAX_CACHE_AGE_SECS, CoreError::BadPrice);
    let snap = jl_snapshot(&pos, &vs, vc.liquidation_threshold_permille, px.price_wad)?;
    require!(max_payout > 0 && max_payout <= snap.debt, CoreError::InvalidParam);
    require!(snap.debt < snap.covered_value, CoreError::AlreadyLiquidatable);

    // Losses, capacity (INV-2, netted with every other policy of the weekend), concentration, premium: as buy_cover.
    let x = CoverInputs { covered_value: snap.covered_value, debt: reserved_debt(snap.debt, cfg)?, max_payout };
    let xp = CoverInputs { debt: priced_debt(snap.debt, cfg)?, ..x };
    let mut losses = vec![0u64; K];
    let worst = policy_losses(&asset, cfg, &x, &mut losses)?;
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
    let loading = shield_loading(z, cfg, asset.sigma_wad, asset.basis_sigma_wad, &xp, worst)?;
    let prem = premium(z, cfg, asset.sigma_wad, asset.dividend_wad, WEEKEND_CLOSURE_DAYS, cap.util_after_wad, &xp)?
        .checked_add(loading)
        .ok_or(CoreError::Math)?;
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
    p.obligation = ctx.accounts.position.key();
    p.borrow_reserve = ctx.accounts.vault_config.key();
    p.epoch = ctx.accounts.epoch.key();
    p.ticker = ctx.accounts.epoch.ticker;
    p.side = side::DOWN;
    p.state = policy_state::ACTIVE;
    p.bump = ctx.bumps.policy;
    p.collateral_value = snap.collateral_value;
    p.covered_value = snap.covered_value;
    p.debt = snap.debt;
    p.liquidation_threshold_wad = snap.liquidation_threshold_wad;
    p.max_payout = max_payout;
    p.premium = prem;
    p.fee = fee;
    p.worst_loss = worst;
    p.payout = 0;
    p.created_at = clock.unix_timestamp;
    p.advanced = 0;
    p.advanced_at = 0;
    p.shield_loading = loading;
    // Interest: the vault's borrow exchange price plays klend's cumulative borrow index (task 1.2).
    p.borrow_index_bsf = vs.borrow_exchange_price as u128;
    p.debt_growth_cap_wad = ctx.accounts.config.debt_growth_cap_wad;
    p.lender = lender::JUPITER;
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

// ---------------------------------------------------------------------------------------------------------------
// Payback through operate (settlement, shield)
// ---------------------------------------------------------------------------------------------------------------

/// What to offer `operate` for a payback of at most `amount`: Jupiter takes one base unit more than offered (its debt
/// rounds up; measured on a fork: 5,000.000001 USDC for 5,000), so it is offered one less.
fn offer(amount: u64) -> u64 {
    amount.saturating_sub(1).max(1)
}

/// `operate`'s accounts in the remaining accounts: the ones the program depends on pinned. Returns whether the
/// position still borrows (tick above the minimum, not supply-only) and the vault's current borrow exchange price.
fn check_operate_accounts(rem: &[AccountInfo], p: &Policy, vault: &Pubkey, vault_usdc: &Pubkey) -> Result<(bool, u64)> {
    require!(rem.len() >= OPERATE_NAMED, CoreError::InvalidParam);
    require_keys_eq!(*rem[op_idx::SIGNER].key, *vault, CoreError::InvalidParam);
    require_keys_eq!(*rem[op_idx::SIGNER_BORROW_TOKEN_ACCOUNT].key, *vault_usdc, CoreError::InvalidParam);
    // No recipient on a payback (Anchor's None = the program id): nothing can be withdrawn to someone else.
    for i in [op_idx::RECIPIENT, op_idx::RECIPIENT_BORROW_TOKEN_ACCOUNT, op_idx::RECIPIENT_SUPPLY_TOKEN_ACCOUNT] {
        require_keys_eq!(*rem[i].key, JL_VAULTS_PROGRAM_ID, CoreError::InvalidParam);
    }
    require_keys_eq!(*rem[op_idx::VAULT_CONFIG].key, p.borrow_reserve, CoreError::InvalidParam);
    require_keys_eq!(*rem[op_idx::POSITION].key, p.obligation, CoreError::InvalidParam);
    let vc = VaultConfigView::load(&rem[op_idx::VAULT_CONFIG])?;
    let vs = VaultStateView::load(&rem[op_idx::VAULT_STATE])?;
    require!(vs.vault_id == vc.vault_id, CoreError::JupiterLayout);
    let pos = PositionView::load(&rem[op_idx::POSITION])?;
    require!(pos.vault_id == vc.vault_id, CoreError::JupiterLayout);
    Ok((!pos.is_supply_only && pos.tick > MIN_TICK, vs.borrow_exchange_price))
}

#[derive(Accounts)]
pub struct SettlePolicyJl<'info> {
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
    /// The policy owner's USDC account: what Jupiter does not take (or all of it, if the position no longer borrows).
    #[account(mut, token::mint = config.usdc_mint, token::authority = policy.owner, token::token_program = token_program)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Jupiter Lend Vaults program (address checked).
    #[account(address = JL_VAULTS_PROGRAM_ID @ CoreError::InvalidParam)]
    pub jl_vaults: UncheckedAccount<'info>,
    // remaining_accounts: operate's accounts in IDL order (signer = the vault PDA, its USDC = vault_usdc, no
    // recipient), then operate's own remaining accounts, as `@jup-ag/lend` builds them for the amount.
}

/// Settles a Jupiter Lend policy: the payout rule on the epoch's Jupiter-oracle prices and the debt with the vault's
/// interest since purchase, paid back into the position (operate CPI), the rest to the owner. `expected = u64::MAX`
/// only returns the amount (return data, u64 LE) for the keeper to build `operate`'s accounts.
pub fn handle_settle_policy_jl<'info>(ctx: Context<'info, SettlePolicyJl<'info>>, expected: u64, indices: Vec<u8>) -> Result<()> {
    let p = &ctx.accounts.policy;
    require!(p.lender == lender::JUPITER, CoreError::InvalidParam);
    let rem = ctx.remaining_accounts;
    let vault_key = ctx.accounts.vault.key();
    let (borrows, borrow_ex) = check_operate_accounts(rem, p, &vault_key, &ctx.accounts.vault_usdc.key())?;
    let debt = if borrows { accrued_debt(p, borrow_ex as u128)? } else { p.debt };
    let group_premiums = ctx.accounts.loss.load()?.premiums;
    let (payout, shortfall) = payout_due(&ctx.accounts.epoch, p, &ctx.accounts.vault, group_premiums, debt, &[])?;
    if expected == u64::MAX {
        set_return_data(&payout.to_le_bytes());
        return Ok(());
    }
    require!(expected == payout, CoreError::AmountMismatch);
    // Into the position only when the payout restores health: Jupiter refuses a payback that leaves it above the
    // threshold, so a payout cut by the cap or by a shortfall goes to the owner's wallet instead.
    let owed = crate::pricing::realized_payout(p.covered_value, debt, u64::MAX, ctx.accounts.epoch.close_price_wad, ctx.accounts.epoch.settle_price_wad)?;
    let restores = p.advanced.checked_add(payout).is_some_and(|t| t >= owed);
    let mut repaid = 0u64;
    if payout > 0 && borrows && restores {
        let before = ctx.accounts.vault_usdc.amount;
        let seeds: &[&[u8]] = &[SEED_VAULT, &[ctx.accounts.vault.bump]];
        operate_payback(&ctx.accounts.jl_vaults, rem, &vault_key, offer(payout), USDC_DECIMALS, &indices, &[seeds])?;
        ctx.accounts.vault_usdc.reload()?;
        repaid = before.checked_sub(ctx.accounts.vault_usdc.amount).ok_or(CoreError::Math)?;
        require!(repaid <= payout, CoreError::Math); // at most the debt, and the offer + 1 unit (see `offer`)
    }
    let rest = payout - repaid;
    if rest > 0 {
        let seeds: &[&[u8]] = &[SEED_VAULT, &[ctx.accounts.vault.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer { from: ctx.accounts.vault_usdc.to_account_info(), to: ctx.accounts.owner_usdc.to_account_info(), authority: ctx.accounts.vault.to_account_info() },
                &[seeds],
            ),
            rest,
        )?;
    }
    let a = &mut *ctx.accounts;
    finish_policy(&mut a.vault, &mut *a.loss.load_mut()?, &mut a.epoch, &mut a.policy, payout, repaid, shortfall, false)
}

#[derive(Accounts)]
pub struct ShieldAdvanceJl<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.keeper == keeper.key() @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, epoch.ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
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
    /// The weekend fair value: Pyth's push account for the asset's `Crypto.<T>X/USD` feed (address checked).
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    /// CHECK: Jupiter Lend Vaults program (address checked).
    #[account(address = JL_VAULTS_PROGRAM_ID @ CoreError::InvalidParam)]
    pub jl_vaults: UncheckedAccount<'info>,
    // remaining_accounts: operate's accounts, as in settle_policy_jl.
}

/// The Liquidation Shield on a Jupiter Lend position: the same window, fair-value checks, target and caps as
/// `shield_advance` (INV-9, INV-11, INV-12), paid back through `operate`. `expected = u64::MAX` only returns the amount.
pub fn handle_shield_advance_jl<'info>(ctx: Context<'info, ShieldAdvanceJl<'info>>, expected: u64, indices: Vec<u8>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, CoreError::Paused);
    require!(cfg.shield_alpha_wad > 0, CoreError::ShieldOff);
    let e = &ctx.accounts.epoch;
    require!(e.state == epoch_state::CLOSED, CoreError::WrongEpochState);
    let p = &ctx.accounts.policy;
    require!(p.state == policy_state::ACTIVE && p.lender == lender::JUPITER, CoreError::WrongEpochState);
    let now = Clock::get()?.unix_timestamp;
    let from = e.open.checked_sub(cfg.shield_start_before_open_secs as i64).ok_or(CoreError::Math)?;
    let to = e.open.checked_sub(cfg.shield_deadline_before_open_secs as i64).ok_or(CoreError::Math)?;
    require!(now >= from && now <= to, CoreError::OutsideShieldWindow);
    let feed = ctx.accounts.asset.load()?.feed_xstock;
    require_keys_eq!(ctx.accounts.price_update.key(), push_account(&feed), CoreError::NotPushAccount);
    let oldest = now
        .checked_sub(cfg.shield_max_age_secs as i64)
        .ok_or(CoreError::Math)?
        .max(e.close.checked_sub(FAIR_BEFORE_CLOSE_SECS).ok_or(CoreError::Math)?);
    let fair = check_update(&ctx.accounts.price_update, &feed, oldest, now, cfg.max_conf_bps)?;

    let rem = ctx.remaining_accounts;
    let vault_key = ctx.accounts.vault.key();
    let (borrows, borrow_ex) = check_operate_accounts(rem, p, &vault_key, &ctx.accounts.vault_usdc.key())?;
    require!(borrows, CoreError::NoDebtToAdvance); // INV-11: only into a position that still borrows
    let debt = accrued_debt(p, borrow_ex as u128)?;
    let target = shield_target(p.covered_value, debt, p.max_payout, e.close_price_wad, fair.price_wad, &ShieldParams::from_config(cfg))?
        .min(p.worst_loss); // INV-12 (A-32)
    let group_left = {
        let l = ctx.accounts.loss.load()?;
        require!(l.settled == 0, CoreError::WrongEpochState);
        l.max_loss.saturating_sub(l.advanced)
    };
    let mut add = target.saturating_sub(p.advanced).min(group_left).min(ctx.accounts.vault.cover_equity()?);
    if p.advanced > 0 && add < MIN_TOPUP {
        add = 0;
    }
    if expected == u64::MAX {
        set_return_data(&add.to_le_bytes());
        return Ok(());
    }
    require!(expected == add, CoreError::AmountMismatch);
    if add == 0 {
        return Ok(());
    }
    let before = ctx.accounts.vault_usdc.amount;
    let seeds: &[&[u8]] = &[SEED_VAULT, &[ctx.accounts.vault.bump]];
    operate_payback(&ctx.accounts.jl_vaults, rem, &vault_key, offer(add), USDC_DECIMALS, &indices, &[seeds])?;
    ctx.accounts.vault_usdc.reload()?;
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
    let alpha_cap = (p.max_payout as u128) * (a.config.shield_alpha_wad as u128) / WAD;
    require!(p.advanced as u128 <= alpha_cap, CoreError::Math); // INV-9
    let v = &mut a.vault;
    v.equity = v.equity.checked_sub(repaid).ok_or(CoreError::VaultInsolvent)?;
    v.advanced_live = v.advanced_live.checked_add(repaid).ok_or(CoreError::Math)?;
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
