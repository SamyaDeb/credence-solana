//! Weekend-safe market (D1, "Layer 4"): a klend market in which every borrow is covered automatically.
//!
//! **Custody.** The market is permissioned for BORROW to this program's `["wsm_auth"]` PDA, so only a Credence
//! instruction can open debt in it. Each user has a `["wsm", user]` account that owns one klend obligation (one xStock
//! deposit, one USDC borrow); every klend call is a v2 CPI signed by that account. The user's `wsm_repay` and
//! `wsm_withdraw` read **no config, no pause flag, no policy and no vault**: they check the user's signature, the account's
//! seeds and klend's own state, then call klend. No admin or keeper instruction moves an obligation's collateral or debt;
//! the Shield and settlement reduce debt only (INV-7, INV-11) and klend's liquidation is open to everyone.
//!
//! **The weekend.** From `freeze_secs` before an upcoming weekend (or holiday weekend) closure's bell until its settlement
//! window ends, an account cannot increase its debt and cannot withdraw collateral past the market's normal limit
//! (the "freeze"). In that window `wsm_auto_cover` (anyone) borrows the premium on the account, pays the vault and writes
//! a full-cover policy. If the vault cannot hold the cover or the account has no headroom for the premium, nothing is
//! borrowed, the account is flagged (`cover_failed_closure`) and the instruction succeeds so a batch continues.
//!
//! Rounding is against the acting user wherever a number decides whether they may act; premiums are the program's own
//! pricing, rounded up.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{self, Mint as MintInterface, TokenAccount as TokenAccountInterface, TokenInterface, TransferChecked};

use crate::instructions::epoch::VENUE_XNYS;
use crate::calendar::{epoch_times, EpochTimes};
use crate::instructions::cover::{commit_policy, price_cover, PriceIn};
use crate::kamino::{ObligationView, ReserveView, PRICE_STATUS_ALL_CHECKS, SF_SHIFT, WSM_MARKET};
use crate::math::{free_equity, WAD};
use crate::state::*;
use crate::wsm_klend::{self as kl, Market, ReserveAccts};
use crate::CoreError;
use credence_risk_core::U256;

pub const SEED_WSM_MARKET: &[u8] = b"wsm_market";
pub const SEED_WSM_AUTH: &[u8] = b"wsm_auth";
pub const SEED_WSM: &[u8] = b"wsm";
pub const SEED_WSM_USDC: &[u8] = b"wsm_usdc";
pub const SEED_WSM_COLL: &[u8] = b"wsm_coll";
pub const MAX_WSM_ASSETS: usize = 8;

/// Bounds `set_wsm_params` enforces, so no parameter can turn the guards into a lock (INV-16) or the limit into a
/// free-for-all.
pub const MIN_NORMAL_LTV_WAD: u64 = 400_000_000_000_000_000; // 0.40
pub const MAX_NORMAL_LTV_WAD: u64 = 950_000_000_000_000_000; // 0.95
pub const MAX_DCP_WAD: u64 = 950_000_000_000_000_000; // the market never lends beyond D/C′ 0.95
pub const MIN_FREEZE_SECS: u32 = 3_600;
pub const MAX_FREEZE_SECS: u32 = 86_400;

impl WsmAsset {
    pub const SPACE: usize = 8 + 32 + 8 + 1;
}

/// One collateral asset of the market.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct WsmAsset {
    pub ticker: Ticker,
    /// The klend reserve of this xStock in the weekend-safe market.
    pub reserve: Pubkey,
    /// The market's normal limit for this asset (Kamino's LTV today), WAD: during a freeze a withdrawal may not leave the
    /// debt above this share of the remaining collateral's value.
    pub normal_ltv_wad: u64,
    pub enabled: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct WsmParams {
    /// Borrows keep D/C′ (debt over LT × collateral) at or under this, WAD (≤ [`MAX_DCP_WAD`]).
    pub max_dcp_wad: u64,
    /// The freeze starts this long before the closure's bell.
    pub freeze_secs: u32,
    /// The market's total USDC debt may not exceed this (base units).
    pub market_debt_cap: u64,
    /// Capacity gate at borrow time: total debt × this ratio ≤ u_max × cover equity. Conservative worst-loss share of
    /// the debt at the market's maximum D/C′ (plan/09 D1.0: 6% SPYx, 9% QQQx, 12% NVDAx at 0.85).
    pub worst_loss_ratio_wad: u64,
}

impl WsmParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.max_dcp_wad > 0 && self.max_dcp_wad <= MAX_DCP_WAD, CoreError::InvalidParam);
        require!((MIN_FREEZE_SECS..=MAX_FREEZE_SECS).contains(&self.freeze_secs), CoreError::InvalidParam);
        require!(self.worst_loss_ratio_wad > 0 && self.worst_loss_ratio_wad <= WAD as u64, CoreError::InvalidParam);
        Ok(())
    }
}

/// The weekend-safe market's program-side parameters. Seeds `["wsm_market"]`.
#[account]
pub struct WsmMarket {
    pub bump: u8,
    pub auth_bump: u8,
    /// The market's USDC borrow reserve.
    pub usdc_reserve: Pubkey,
    pub n_assets: u8,
    pub assets: [WsmAsset; MAX_WSM_ASSETS],
    pub max_dcp_wad: u64,
    pub freeze_secs: u32,
    pub market_debt_cap: u64,
    pub worst_loss_ratio_wad: u64,
}

impl WsmMarket {
    /// Bytes after the discriminator.
    pub const INIT_SPACE: usize = 1 + 1 + 32 + 1 + WsmAsset::SPACE * MAX_WSM_ASSETS + 8 + 4 + 8 + 8;
    pub fn asset(&self, ticker: &Ticker) -> Result<&WsmAsset> {
        self.assets[..self.n_assets as usize].iter().find(|a| &a.ticker == ticker).ok_or_else(|| error!(CoreError::AssetDisabled))
    }
}

/// A user's account. Seeds `["wsm", user]`; owns the klend obligation, `["wsm_usdc", user]` (USDC in transit and
/// payout rests) and `["wsm_coll", user]` (the xStock in transit).
#[account]
pub struct WsmAccount {
    pub user: Pubkey,
    pub ticker: Ticker,
    pub obligation: Pubkey,
    pub bump: u8,
    pub opened_at: i64,
    /// The closure (Friday's session date) this account was last covered for, 0 = never.
    pub covered_closure: u32,
    /// The closure whose cover could not be bought (capacity or headroom), 0 = none. Cleared by a later cover.
    pub cover_failed_closure: u32,
    /// Premiums borrowed and paid so far (the weekend add-on, USDC base units).
    pub addon_paid_total: u64,
}

impl WsmAccount {
    /// Bytes after the discriminator.
    pub const INIT_SPACE: usize = 32 + 8 + 32 + 1 + 8 + 4 + 4 + 8;
    pub fn signer_seeds<'a>(user: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
        [SEED_WSM, user.as_ref(), bump]
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)

/// The next closure that needs cover at `now`: the first whose settlement window has not ended, skipping overnights
/// (the market's overnight gaps are not covered, README Known limits).
pub fn next_cover_closure(sessions: &[Session], now: i64) -> Option<EpochTimes> {
    // Sessions that closed more than a week ago cannot hold a closure that is still ahead.
    let start = sessions.partition_point(|s| s.close.saturating_add(8 * 86_400) < now);
    for i in start..sessions.len().saturating_sub(1) {
        if let Some(t) = epoch_times(sessions, sessions[i].date) {
            if t.settle_after > now && t.closure_type != closure::OVERNIGHT {
                return Some(t);
            }
        }
    }
    None
}

/// True in `[bell − freeze_secs, settle_after)` of the next weekend closure.
pub fn in_freeze(sessions: &[Session], now: i64, freeze_secs: u32) -> bool {
    next_cover_closure(sessions, now).is_some_and(|t| now >= t.bell.saturating_sub(freeze_secs as i64) && now < t.settle_after)
}

/// `debt_value / remaining collateral value ≤ normal_ltv` after withdrawing `w` cTokens of a deposit of `dep_amount`
/// cTokens worth `dep_mv_sf`. Rounds against the user: the remaining value rounds DOWN. `debt_sf`: the obligation's
/// borrowed assets' market value (USDC at borrow factor 100%).
pub fn withdraw_within_normal(dep_mv_sf: u128, dep_amount: u64, w: u64, debt_sf: u128, normal_ltv_wad: u64) -> bool {
    if debt_sf == 0 {
        return true;
    }
    if w >= dep_amount || dep_amount == 0 {
        return false; // all collateral out with debt outstanding
    }
    let remaining = U256::from(dep_mv_sf) * U256::from(dep_amount - w) / U256::from(dep_amount);
    U256::from(debt_sf) * U256::from(WAD) <= U256::from(normal_ltv_wad) * remaining
}

/// A debt value (USD × 2^60) of `amount` base units of a token with `decimals` at `price_sf` (USD per whole token ×
/// 2^60), rounded UP.
pub fn value_sf_up(amount: u64, price_sf: u128, decimals: u64) -> Result<u128> {
    let num = U256::from(amount) * U256::from(price_sf);
    let den = U256::from(10u8).pow(U256::from(decimals));
    u128::try_from((num + den - U256::from(1u8)) / den).map_err(|_| error!(CoreError::Math))
}

/// `debt_after / (LT × collateral) ≤ max_dcp` with the debt value `debt_sf` and klend's `unhealthy_borrow_value`.
pub fn dcp_within(debt_sf: u128, unhealthy_sf: u128, max_dcp_wad: u64) -> bool {
    U256::from(debt_sf) * U256::from(WAD) <= U256::from(max_dcp_wad) * U256::from(unhealthy_sf)
}

fn is_core(e: &Error, c: CoreError) -> bool {
    matches!(e, Error::AnchorError(a) if a.error_code_number == u32::from(c))
}

fn require_fresh(ob: &ObligationView, slot: u64) -> Result<()> {
    require!(ob.last_update_slot == slot && ob.stale == 0 && ob.price_status == PRICE_STATUS_ALL_CHECKS, CoreError::ObligationNotRefreshed);
    Ok(())
}

fn calendar_sessions<'a>(cal: &'a Calendar) -> &'a [Session] {
    &cal.sessions[..(cal.n as usize).min(cal.sessions.len())]
}

/// A freeze decision for exits that never fails: an unusable calendar means "not in a freeze".
fn freeze_now(cal: &AccountLoader<Calendar>, now: i64, freeze_secs: u32) -> bool {
    match cal.load() {
        Ok(c) if c.finalized == 1 => in_freeze(calendar_sessions(&c), now, freeze_secs),
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Admin

#[derive(Accounts)]
pub struct InitWsmMarket<'info> {
    #[account(mut, address = config.admin @ CoreError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = 8 + WsmMarket::INIT_SPACE, seeds = [SEED_WSM_MARKET], bump)]
    pub wsm_market: Box<Account<'info, WsmMarket>>,
    /// CHECK: klend Reserve of USDC in the weekend-safe market, decoded and checked below.
    pub usdc_reserve: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    // remaining: for each asset, its `AssetConfig` PDA then its klend Reserve in the weekend-safe market.
}

/// One asset of `init_wsm_market`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct WsmAssetInit {
    pub ticker: Ticker,
    pub normal_ltv_wad: u64,
}

pub fn handle_init_wsm_market<'info>(
    ctx: Context<'info, InitWsmMarket<'info>>,
    params: WsmParams,
    assets: Vec<WsmAssetInit>,
) -> Result<()> {
    params.validate()?;
    require!(!assets.is_empty() && assets.len() <= MAX_WSM_ASSETS, CoreError::InvalidParam);
    require!(ctx.remaining_accounts.len() == assets.len() * 2, CoreError::InvalidParam);
    let usdc = ReserveView::load(&ctx.accounts.usdc_reserve)?;
    require_keys_eq!(usdc.lending_market, WSM_MARKET, CoreError::MarketNotAllowed);
    require_keys_eq!(usdc.liquidity_mint, ctx.accounts.config.usdc_mint, CoreError::InvalidParam);
    require!(usdc.borrow_factor_pct == 100, CoreError::UnsupportedObligation);
    let m = &mut ctx.accounts.wsm_market;
    m.bump = ctx.bumps.wsm_market;
    m.auth_bump = Pubkey::find_program_address(&[SEED_WSM_AUTH], &crate::ID).1;
    m.usdc_reserve = ctx.accounts.usdc_reserve.key();
    m.n_assets = assets.len() as u8;
    m.max_dcp_wad = params.max_dcp_wad;
    m.freeze_secs = params.freeze_secs;
    m.market_debt_cap = params.market_debt_cap;
    m.worst_loss_ratio_wad = params.worst_loss_ratio_wad;
    for (i, a) in assets.iter().enumerate() {
        require!((MIN_NORMAL_LTV_WAD..=MAX_NORMAL_LTV_WAD).contains(&a.normal_ltv_wad), CoreError::InvalidParam);
        let asset_info = &ctx.remaining_accounts[2 * i];
        let reserve_info = &ctx.remaining_accounts[2 * i + 1];
        let asset: AccountLoader<AssetConfig> = AccountLoader::try_from(asset_info)?;
        let ac = asset.load()?;
        require_keys_eq!(asset_info.key(), Pubkey::find_program_address(&[SEED_ASSET, a.ticker.as_ref()], &crate::ID).0, CoreError::InvalidParam);
        require!(ac.ticker == a.ticker && ac.lender == lender::KAMINO as u64, CoreError::InvalidParam);
        let r = ReserveView::load(reserve_info)?;
        require_keys_eq!(r.lending_market, WSM_MARKET, CoreError::MarketNotAllowed);
        require_keys_eq!(r.liquidity_mint, ac.mint, CoreError::InvalidParam);
        require!(!m.assets[..i].iter().any(|x| x.ticker == a.ticker), CoreError::InvalidParam);
        m.assets[i] = WsmAsset { ticker: a.ticker, reserve: reserve_info.key(), normal_ltv_wad: a.normal_ltv_wad, enabled: true };
    }
    Ok(())
}

#[derive(Accounts)]
pub struct SetWsmParams<'info> {
    #[account(address = config.admin @ CoreError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_WSM_MARKET], bump = wsm_market.bump)]
    pub wsm_market: Box<Account<'info, WsmMarket>>,
}

/// Sets the market parameters and each asset's normal limit and `enabled` flag (a disabled asset admits no new account;
/// existing ones keep every exit).
pub fn handle_set_wsm_params(ctx: Context<SetWsmParams>, params: WsmParams, normal_ltv_wad: Vec<u64>, enabled: Vec<bool>) -> Result<()> {
    params.validate()?;
    let m = &mut ctx.accounts.wsm_market;
    require!(normal_ltv_wad.len() == m.n_assets as usize && enabled.len() == m.n_assets as usize, CoreError::InvalidParam);
    for (i, (n, e)) in normal_ltv_wad.iter().zip(&enabled).enumerate() {
        require!((MIN_NORMAL_LTV_WAD..=MAX_NORMAL_LTV_WAD).contains(n), CoreError::InvalidParam);
        m.assets[i].normal_ltv_wad = *n;
        m.assets[i].enabled = *e;
    }
    m.max_dcp_wad = params.max_dcp_wad;
    m.freeze_secs = params.freeze_secs;
    m.market_debt_cap = params.market_debt_cap;
    m.worst_loss_ratio_wad = params.worst_loss_ratio_wad;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// wsm_open

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct WsmOpen<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_WSM_MARKET], bump = wsm_market.bump)]
    pub wsm_market: Box<Account<'info, WsmMarket>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(init, payer = user, space = 8 + WsmAccount::INIT_SPACE, seeds = [SEED_WSM, user.key().as_ref()], bump)]
    pub wsm_account: Box<Account<'info, WsmAccount>>,
    #[account(
        init, payer = user, seeds = [SEED_WSM_USDC, user.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = wsm_account, token::token_program = token_program,
    )]
    pub wsm_usdc: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(
        init, payer = user, seeds = [SEED_WSM_COLL, user.key().as_ref()], bump,
        token::mint = coll_mint, token::authority = wsm_account, token::token_program = token_2022_program,
    )]
    pub wsm_coll: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(address = config.usdc_mint @ CoreError::InvalidParam)]
    pub usdc_mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(address = asset.load()?.mint @ CoreError::InvalidParam)]
    pub coll_mint: Box<InterfaceAccount<'info, MintInterface>>,
    /// CHECK: the weekend-safe klend market (`Market::check`).
    pub klend_market: UncheckedAccount<'info>,
    /// CHECK: klend's market authority PDA (`Market::check`).
    pub klend_lma: UncheckedAccount<'info>,
    /// CHECK: klend `UserMetadata` PDA of the account, created here.
    #[account(mut)]
    pub user_metadata: UncheckedAccount<'info>,
    /// CHECK: klend `Obligation` PDA of the account, created here.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: klend's program id; the obligation's seed accounts are the default key, the system program.
    pub klend_program: UncheckedAccount<'info>,
    /// CHECK: Kamino farms program (checked by `Market::check`).
    pub farms_program: UncheckedAccount<'info>,
    /// CHECK: instructions sysvar (klend's argument).
    pub instruction_sysvar: UncheckedAccount<'info>,
    /// CHECK: rent sysvar (klend's argument).
    pub rent: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Creates the user's account, its two token accounts and its klend obligation. Pause stops it (new risk).
pub fn handle_wsm_open(ctx: Context<WsmOpen>, ticker: Ticker) -> Result<()> {
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    require!(ctx.accounts.wsm_market.asset(&ticker)?.enabled, CoreError::AssetDisabled);
    require_keys_eq!(ctx.accounts.token_program.key(), anchor_spl::token::ID, CoreError::WrongProgram);
    require_keys_eq!(ctx.accounts.token_2022_program.key(), anchor_spl::token_2022::ID, CoreError::WrongProgram);
    let user = ctx.accounts.user.key();
    let a = &mut ctx.accounts.wsm_account;
    a.user = user;
    a.ticker = ticker;
    a.bump = ctx.bumps.wsm_account;
    a.opened_at = Clock::get()?.unix_timestamp;
    a.covered_closure = 0;
    a.cover_failed_closure = 0;
    a.addon_paid_total = 0;
    a.obligation = kl::obligation_address(&a.key());
    require_keys_eq!(ctx.accounts.obligation.key(), a.obligation, CoreError::InvalidParam);
    let bump = [a.bump];
    let seeds = WsmAccount::signer_seeds(&user, &bump);
    let (account_info, user_info) = (ctx.accounts.wsm_account.to_account_info(), ctx.accounts.user.to_account_info());
    kl::open_obligation(
        &Market {
            market: ctx.accounts.klend_market.as_ref(),
            lma: ctx.accounts.klend_lma.as_ref(),
            klend: ctx.accounts.klend_program.as_ref(),
            farms: ctx.accounts.farms_program.as_ref(),
            instruction_sysvar: ctx.accounts.instruction_sysvar.as_ref(),
        },
        &account_info,
        &user_info,
        ctx.accounts.user_metadata.as_ref(),
        ctx.accounts.obligation.as_ref(),
        ctx.accounts.system_program.as_ref(),
        ctx.accounts.rent.as_ref(),
        ctx.accounts.system_program.as_ref(),
        &seeds,
    )?;
    emit!(WsmOpened { user, ticker, account: ctx.accounts.wsm_account.key(), obligation: ctx.accounts.obligation.key() });
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// The klend accounts the user instructions share

/// Common to deposit, borrow, repay and withdraw: the account, its obligation and the klend market.
#[derive(Accounts)]
pub struct WsmKlend<'info> {
    /// CHECK: the weekend-safe klend market (`Market::check`).
    pub klend_market: UncheckedAccount<'info>,
    /// CHECK: klend's market authority PDA (`Market::check`).
    pub klend_lma: UncheckedAccount<'info>,
    /// CHECK: klend's program id (`Market::check`).
    pub klend_program: UncheckedAccount<'info>,
    /// CHECK: Kamino farms program (`Market::check`).
    pub farms_program: UncheckedAccount<'info>,
    /// CHECK: instructions sysvar (klend's argument).
    pub instruction_sysvar: UncheckedAccount<'info>,
}

macro_rules! market {
    ($k:expr) => {
        Market {
            market: $k.klend_market.as_ref(),
            lma: $k.klend_lma.as_ref(),
            klend: $k.klend_program.as_ref(),
            farms: $k.farms_program.as_ref(),
            instruction_sysvar: $k.instruction_sysvar.as_ref(),
        }
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// wsm_deposit

#[derive(Accounts)]
pub struct WsmDeposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [SEED_WSM, user.key().as_ref()], bump = wsm_account.bump, has_one = user)]
    pub wsm_account: Box<Account<'info, WsmAccount>>,
    #[account(seeds = [SEED_WSM_MARKET], bump = wsm_market.bump)]
    pub wsm_market: Box<Account<'info, WsmMarket>>,
    #[account(mut, seeds = [SEED_WSM_COLL, user.key().as_ref()], bump, token::authority = wsm_account)]
    pub wsm_coll: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(mut, token::mint = coll_mint, token::authority = user)]
    pub user_coll: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    pub coll_mint: Box<InterfaceAccount<'info, MintInterface>>,
    /// CHECK: the account's klend obligation (address checked against `wsm_account`).
    #[account(mut, address = wsm_account.obligation @ CoreError::InvalidParam)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: the asset's klend reserve in the weekend-safe market (address checked against `wsm_market`).
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: klend `reserve.liquidity.supply_vault` (klend checks it against the reserve).
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: klend `reserve.collateral.mint_pubkey` (klend checks it).
    #[account(mut)]
    pub reserve_collateral_mint: UncheckedAccount<'info>,
    /// CHECK: klend `reserve.collateral.supply_vault` (klend checks it).
    #[account(mut)]
    pub reserve_collateral_supply: UncheckedAccount<'info>,
    pub klend: WsmKlend<'info>,
    pub collateral_token_program: Program<'info, Token>,
    pub token_2022_program: Interface<'info, TokenInterface>,
}

/// Adds collateral (risk-reducing, so allowed while paused). Moves `amount` of the xStock from the user's wallet into the
/// account's transit account and into the klend obligation.
pub fn handle_wsm_deposit(ctx: Context<WsmDeposit>, amount: u64) -> Result<()> {
    require!(amount > 0, CoreError::InvalidParam);
    require_keys_eq!(ctx.accounts.token_2022_program.key(), anchor_spl::token_2022::ID, CoreError::WrongProgram);
    let a = &ctx.accounts;
    let asset = a.wsm_market.asset(&a.wsm_account.ticker)?;
    require_keys_eq!(a.reserve.key(), asset.reserve, CoreError::InvalidParam);
    require_keys_eq!(a.wsm_coll.mint, a.coll_mint.key(), CoreError::InvalidParam);
    let ob = ObligationView::load(&a.obligation)?;
    require_keys_eq!(ob.owner, a.wsm_account.key(), CoreError::NotObligationOwner);
    require_keys_eq!(ob.lending_market, WSM_MARKET, CoreError::MarketNotAllowed);
    // One collateral reserve per account (the cover prices one xStock).
    require!(ob.deposits.iter().all(|(r, _)| *r == asset.reserve), CoreError::UnsupportedObligation);
    token_interface::transfer_checked(
        CpiContext::new(
            a.token_2022_program.key(),
            TransferChecked {
                from: a.user_coll.to_account_info(),
                mint: a.coll_mint.to_account_info(),
                to: a.wsm_coll.to_account_info(),
                authority: a.user.to_account_info(),
            },
        ),
        amount,
        a.coll_mint.decimals,
    )?;
    let (user, bump) = (a.user.key(), [a.wsm_account.bump]);
    let seeds = WsmAccount::signer_seeds(&user, &bump);
    kl::deposit(
        &market!(a.klend),
        &ReserveAccts {
            reserve: a.reserve.as_ref(),
            liquidity_mint: &a.coll_mint.to_account_info(),
            liquidity_supply: a.reserve_liquidity_supply.as_ref(),
            liquidity_token_program: a.token_2022_program.as_ref(),
        },
        &a.wsm_account.to_account_info(),
        a.obligation.as_ref(),
        a.reserve_collateral_mint.as_ref(),
        a.reserve_collateral_supply.as_ref(),
        &a.wsm_coll.to_account_info(),
        a.collateral_token_program.as_ref(),
        amount,
        &seeds,
    )?;
    emit!(WsmDeposited { user, amount });
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// wsm_borrow

#[derive(Accounts)]
pub struct WsmBorrow<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_WSM_MARKET], bump = wsm_market.bump)]
    pub wsm_market: Box<Account<'info, WsmMarket>>,
    #[account(mut, seeds = [SEED_WSM, user.key().as_ref()], bump = wsm_account.bump, has_one = user)]
    pub wsm_account: Box<Account<'info, WsmAccount>>,
    #[account(seeds = [SEED_CALENDAR, VENUE_XNYS.as_ref()], bump = calendar.load()?.bump)]
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(mut, seeds = [SEED_WSM_USDC, user.key().as_ref()], bump, token::authority = wsm_account)]
    pub wsm_usdc: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = user)]
    pub user_usdc: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(address = config.usdc_mint @ CoreError::InvalidParam)]
    pub usdc_mint: Box<InterfaceAccount<'info, MintInterface>>,
    /// CHECK: the account's klend obligation.
    #[account(mut, address = wsm_account.obligation @ CoreError::InvalidParam)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: the market's USDC reserve (address checked against `wsm_market`).
    #[account(mut, address = wsm_market.usdc_reserve @ CoreError::InvalidParam)]
    pub usdc_reserve: UncheckedAccount<'info>,
    /// CHECK: klend `reserve.liquidity.supply_vault` (klend checks it).
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: klend `reserve.liquidity.fee_vault` (klend checks it).
    #[account(mut)]
    pub reserve_fee_vault: UncheckedAccount<'info>,
    /// CHECK: the program's `["wsm_auth"]` PDA, the market's permissioning authority; signs through its seeds.
    #[account(seeds = [SEED_WSM_AUTH], bump = wsm_market.auth_bump)]
    pub wsm_auth: UncheckedAccount<'info>,
    pub klend: WsmKlend<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Borrows `amount` USDC against the account's collateral. Refused while paused, in a freeze, above the market's D/C′
/// limit, past its debt cap, or when the vault could not cover the market's debt (capacity gate).
pub fn handle_wsm_borrow(mut ctx: Context<WsmBorrow>, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.config.paused, CoreError::Paused);
    require!(amount > 0, CoreError::InvalidParam);
    require_keys_eq!(a.token_program.key(), anchor_spl::token::ID, CoreError::WrongProgram);
    let clock = Clock::get()?;
    // The weekend is closed to new debt (INV-17): the account is covered at the freeze's debt and no more.
    require!(!freeze_now(&a.calendar, clock.unix_timestamp, a.wsm_market.freeze_secs), CoreError::WeekendFreeze);
    require!(a.wsm_market.asset(&a.wsm_account.ticker)?.enabled, CoreError::AssetDisabled);
    let ob = ObligationView::load(&a.obligation)?;
    require_keys_eq!(ob.owner, a.wsm_account.key(), CoreError::NotObligationOwner);
    require_keys_eq!(ob.lending_market, WSM_MARKET, CoreError::MarketNotAllowed);
    require_fresh(&ob, clock.slot)?;
    require!(ob.deposits.len() == 1 && ob.borrows.len() <= 1, CoreError::UnsupportedObligation);
    require!(ob.borrows.iter().all(|(r, _, _)| *r == a.wsm_market.usdc_reserve), CoreError::UnsupportedObligation);
    let usdc = ReserveView::load(&a.usdc_reserve)?;
    require_keys_eq!(usdc.lending_market, WSM_MARKET, CoreError::MarketNotAllowed);
    require!(usdc.last_update_slot == clock.slot && usdc.stale == 0, CoreError::ObligationNotRefreshed);
    // D/C′ after the borrow, rounding the new debt UP (against the user).
    let add = value_sf_up(amount, usdc.market_price_sf, usdc.mint_decimals)?;
    let debt_after = ob.bf_adjusted_debt_value_sf.checked_add(add).ok_or(CoreError::Math)?;
    require!(dcp_within(debt_after, ob.unhealthy_borrow_value_sf, a.wsm_market.max_dcp_wad), CoreError::AboveMarketLimit);
    // The market's total debt (the reserve's borrowed amount: only this program can borrow in this market).
    let total_after = (usdc.borrowed_amount_sf >> SF_SHIFT).checked_add(amount as u128).ok_or(CoreError::Math)?;
    require!(total_after <= a.wsm_market.market_debt_cap as u128, CoreError::MarketCapExceeded);
    // Capacity gate: the vault must be able to carry cover for the market's whole debt at its worst-loss ratio.
    let equity = free_equity(a.vault.cover_equity()?, a.vault.queued_withdraw_shares, a.share_mint.supply).ok_or(CoreError::Math)?;
    let need = total_after * (a.wsm_market.worst_loss_ratio_wad as u128) / (WAD as u128) + 1;
    let limit = (equity as u128) * (a.config.u_max_wad as u128) / (WAD as u128);
    require!(need <= limit, CoreError::CapacityExceeded);

    let (user, bump) = (a.user.key(), [a.wsm_account.bump]);
    let owner_seeds = WsmAccount::signer_seeds(&user, &bump);
    let auth_bump = [a.wsm_market.auth_bump];
    let auth_seeds: [&[u8]; 2] = [SEED_WSM_AUTH, &auth_bump];
    let before = a.wsm_usdc.amount;
    kl::borrow(
        &market!(a.klend),
        &ReserveAccts {
            reserve: a.usdc_reserve.as_ref(),
            liquidity_mint: &a.usdc_mint.to_account_info(),
            liquidity_supply: a.reserve_liquidity_supply.as_ref(),
            liquidity_token_program: a.token_program.as_ref(),
        },
        &a.wsm_account.to_account_info(),
        a.obligation.as_ref(),
        a.reserve_fee_vault.as_ref(),
        &a.wsm_usdc.to_account_info(),
        a.wsm_auth.as_ref(),
        amount,
        &owner_seeds,
        &auth_seeds,
    )?;
    let a = &mut ctx.accounts;
    a.wsm_usdc.reload()?;
    let got = a.wsm_usdc.amount.checked_sub(before).ok_or(CoreError::Math)?;
    // The user receives what klend paid (the origination fee, if the reserve has one, is klend's).
    transfer_usdc(&a.token_program, &a.wsm_usdc, &a.user_usdc, &a.usdc_mint, &a.wsm_account, &user, got)?;
    emit!(WsmBorrowed { user, amount: got });
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// wsm_repay: an exit. It reads no config, pause flag, policy, vault, calendar or market parameter.

#[derive(Accounts)]
pub struct WsmRepay<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [SEED_WSM, user.key().as_ref()], bump = wsm_account.bump, has_one = user)]
    pub wsm_account: Box<Account<'info, WsmAccount>>,
    #[account(mut, seeds = [SEED_WSM_USDC, user.key().as_ref()], bump, token::mint = usdc_mint, token::authority = wsm_account)]
    pub wsm_usdc: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    pub usdc_mint: Box<InterfaceAccount<'info, MintInterface>>,
    /// CHECK: the account's klend obligation.
    #[account(mut, address = wsm_account.obligation @ CoreError::InvalidParam)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: the obligation's borrow reserve (checked against the obligation; klend checks the market).
    #[account(mut)]
    pub usdc_reserve: UncheckedAccount<'info>,
    /// CHECK: klend `reserve.liquidity.supply_vault` (klend checks it).
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,
    pub klend: WsmKlend<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Repays up to `amount` USDC (`u64::MAX` = all the user's wallet holds, capped by the debt). Whatever klend does not
/// take, and any payout rest in the account's USDC, goes back to the user's wallet.
pub fn handle_wsm_repay(mut ctx: Context<WsmRepay>, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    require_keys_eq!(a.token_program.key(), anchor_spl::token::ID, CoreError::WrongProgram);
    let ob = ObligationView::load(&a.obligation)?;
    require_keys_eq!(ob.owner, a.wsm_account.key(), CoreError::NotObligationOwner);
    require_keys_eq!(ob.lending_market, WSM_MARKET, CoreError::MarketNotAllowed);
    require!(ob.borrows.len() == 1 && ob.borrows[0].0 == a.usdc_reserve.key(), CoreError::UnsupportedObligation);
    require_keys_eq!(ReserveView::load(&a.usdc_reserve)?.liquidity_mint, a.usdc_mint.key(), CoreError::InvalidParam);
    let user = a.user.key();
    let bump = [a.wsm_account.bump];
    let seeds = WsmAccount::signer_seeds(&user, &bump);
    let pay = amount.min(a.user_usdc.amount);
    // The user pays into the account's transit account; klend repays from it.
    token_interface::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.user_usdc.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.wsm_usdc.to_account_info(),
                authority: a.user.to_account_info(),
            },
        ),
        pay,
        a.usdc_mint.decimals,
    )?;
    let in_account = a.wsm_usdc.amount.checked_add(pay).ok_or(CoreError::Math)?;
    let wsm_info = a.wsm_account.to_account_info();
    crate::kamino::repay_obligation_liquidity_v2(
        &crate::kamino::RepayV2 {
            owner: &wsm_info,
            obligation: a.obligation.as_ref(),
            lending_market: a.klend.klend_market.as_ref(),
            repay_reserve: a.usdc_reserve.as_ref(),
            reserve_liquidity_mint: &a.usdc_mint.to_account_info(),
            reserve_destination_liquidity: a.reserve_liquidity_supply.as_ref(),
            user_source_liquidity: &a.wsm_usdc.to_account_info(),
            token_program: a.token_program.as_ref(),
            instruction_sysvar: a.klend.instruction_sysvar.as_ref(),
            // The market's reserves have no debt farm: klend expects its own id in these slots.
            obligation_farm_user_state: None,
            reserve_farm_state: None,
            lending_market_authority: a.klend.klend_lma.as_ref(),
            farms_program: a.klend.farms_program.as_ref(),
            klend_program: a.klend.klend_program.as_ref(),
        },
        // Never more than was put in this call plus what the account already holds.
        in_account,
        &[&seeds],
    )?;
    let a = &mut ctx.accounts;
    a.wsm_usdc.reload()?;
    let rest = a.wsm_usdc.amount;
    transfer_usdc(&a.token_program, &a.wsm_usdc, &a.user_usdc, &a.usdc_mint, &a.wsm_account, &user, rest)?;
    emit!(WsmRepaid { user, repaid: in_account.saturating_sub(rest) });
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// wsm_claim: an exit for payout rests

#[derive(Accounts)]
pub struct WsmClaim<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [SEED_WSM, user.key().as_ref()], bump = wsm_account.bump, has_one = user)]
    pub wsm_account: Box<Account<'info, WsmAccount>>,
    #[account(mut, seeds = [SEED_WSM_USDC, user.key().as_ref()], bump, token::mint = usdc_mint, token::authority = wsm_account)]
    pub wsm_usdc: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    pub usdc_mint: Box<InterfaceAccount<'info, MintInterface>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Moves what the account's USDC holds (a payout's rest, an unused repayment) to the user's wallet.
pub fn handle_wsm_claim(ctx: Context<WsmClaim>) -> Result<()> {
    let a = &ctx.accounts;
    require_keys_eq!(a.token_program.key(), anchor_spl::token::ID, CoreError::WrongProgram);
    let user = a.user.key();
    let n = a.wsm_usdc.amount;
    transfer_usdc(&a.token_program, &a.wsm_usdc, &a.user_usdc, &a.usdc_mint, &a.wsm_account, &user, n)
}

// ---------------------------------------------------------------------------------------------------------------------
// wsm_withdraw: an exit with one arithmetic guard

#[derive(Accounts)]
pub struct WsmWithdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [SEED_WSM, user.key().as_ref()], bump = wsm_account.bump, has_one = user)]
    pub wsm_account: Box<Account<'info, WsmAccount>>,
    #[account(seeds = [SEED_WSM_MARKET], bump = wsm_market.bump)]
    pub wsm_market: Box<Account<'info, WsmMarket>>,
    /// Read for the freeze only; an unusable calendar means no freeze (the guard fails open for exits).
    #[account(seeds = [SEED_CALENDAR, VENUE_XNYS.as_ref()], bump = calendar.load()?.bump)]
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(mut, seeds = [SEED_WSM_COLL, user.key().as_ref()], bump, token::authority = wsm_account)]
    pub wsm_coll: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(mut, token::mint = coll_mint, token::authority = user)]
    pub user_coll: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    pub coll_mint: Box<InterfaceAccount<'info, MintInterface>>,
    /// CHECK: the account's klend obligation.
    #[account(mut, address = wsm_account.obligation @ CoreError::InvalidParam)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: the obligation's deposit reserve (checked against the obligation; klend checks the market).
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: klend `reserve.liquidity.supply_vault` (klend checks it).
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: klend `reserve.collateral.mint_pubkey` (klend checks it).
    #[account(mut)]
    pub reserve_collateral_mint: UncheckedAccount<'info>,
    /// CHECK: klend `reserve.collateral.supply_vault` (klend checks it).
    #[account(mut)]
    pub reserve_collateral_supply: UncheckedAccount<'info>,
    pub klend: WsmKlend<'info>,
    pub collateral_token_program: Program<'info, Token>,
    pub token_2022_program: Interface<'info, TokenInterface>,
}

/// Withdraws `collateral` cTokens (`u64::MAX` = all klend allows; klend caps it at the obligation's LTV). Allowed while
/// paused, mid-weekend, with a policy or a Shield advance. The one guard: in a freeze, a withdrawal that would leave the
/// debt above the market's normal limit is refused. Repay first (always possible) and it passes; an account without debt
/// withdraws everything.
pub fn handle_wsm_withdraw(mut ctx: Context<WsmWithdraw>, collateral: u64) -> Result<()> {
    let a = &ctx.accounts;
    require_keys_eq!(a.token_2022_program.key(), anchor_spl::token_2022::ID, CoreError::WrongProgram);
    let ob = ObligationView::load(&a.obligation)?;
    require_keys_eq!(ob.owner, a.wsm_account.key(), CoreError::NotObligationOwner);
    require_keys_eq!(ob.lending_market, WSM_MARKET, CoreError::MarketNotAllowed);
    require!(ob.deposits.len() == 1 && ob.deposits[0].0 == a.reserve.key(), CoreError::UnsupportedObligation);
    require_keys_eq!(a.wsm_coll.mint, a.coll_mint.key(), CoreError::InvalidParam);
    let clock = Clock::get()?;
    if freeze_now(&a.calendar, clock.unix_timestamp, a.wsm_market.freeze_secs) && ob.borrowed_assets_market_value_sf > 0 {
        require_fresh(&ob, clock.slot)?;
        let normal = a.wsm_market.asset(&a.wsm_account.ticker)?.normal_ltv_wad;
        // `u64::MAX` asks klend for everything it allows: judged as the whole deposit, which only an account without debt may take.
        let w = if collateral == u64::MAX { ob.deposit_amounts[0] } else { collateral };
        require!(
            withdraw_within_normal(ob.deposits[0].1, ob.deposit_amounts[0], w, ob.borrowed_assets_market_value_sf, normal),
            CoreError::WeekendFreeze
        );
    }
    let (user, bump) = (a.user.key(), [a.wsm_account.bump]);
    let seeds = WsmAccount::signer_seeds(&user, &bump);
    let before = a.wsm_coll.amount;
    kl::withdraw(
        &market!(a.klend),
        &ReserveAccts {
            reserve: a.reserve.as_ref(),
            liquidity_mint: &a.coll_mint.to_account_info(),
            liquidity_supply: a.reserve_liquidity_supply.as_ref(),
            liquidity_token_program: a.token_2022_program.as_ref(),
        },
        &a.wsm_account.to_account_info(),
        a.obligation.as_ref(),
        a.reserve_collateral_mint.as_ref(),
        a.reserve_collateral_supply.as_ref(),
        &a.wsm_coll.to_account_info(),
        a.collateral_token_program.as_ref(),
        collateral,
        &seeds,
    )?;
    let a = &mut ctx.accounts;
    a.wsm_coll.reload()?;
    let got = a.wsm_coll.amount.checked_sub(before).ok_or(CoreError::Math)?;
    let acct_info = a.wsm_account.to_account_info();
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_2022_program.key(),
            TransferChecked {
                from: a.wsm_coll.to_account_info(),
                mint: a.coll_mint.to_account_info(),
                to: a.user_coll.to_account_info(),
                authority: acct_info,
            },
            &[&seeds],
        ),
        got,
        a.coll_mint.decimals,
    )?;
    emit!(WsmWithdrawn { user, amount: got });
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// wsm_auto_cover

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct WsmAutoCover<'info> {
    /// Anyone: pays the policy's rent and gets nothing back; the premium comes from the account's own borrow.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_WSM_MARKET], bump = wsm_market.bump)]
    pub wsm_market: Box<Account<'info, WsmMarket>>,
    #[account(mut, seeds = [SEED_WSM, wsm_account.user.as_ref()], bump = wsm_account.bump, constraint = wsm_account.ticker == ticker @ CoreError::TickerMismatch)]
    pub wsm_account: Box<Account<'info, WsmAccount>>,
    #[account(mut, seeds = [SEED_WSM_USDC, wsm_account.user.as_ref()], bump, token::authority = wsm_account)]
    pub wsm_usdc: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
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
    pub share_mint: Box<Account<'info, anchor_spl::token::Mint>>,
    #[account(mut, address = vault.fee_account @ CoreError::InvalidParam)]
    pub fee_account: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ CoreError::InvalidParam)]
    pub usdc_mint: Box<Account<'info, anchor_spl::token::Mint>>,
    /// CHECK: the account's klend obligation.
    #[account(mut, address = wsm_account.obligation @ CoreError::InvalidParam)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: the asset's reserve in the weekend-safe market (address checked against `wsm_market`).
    #[account(address = wsm_market.asset(&ticker)?.reserve @ CoreError::InvalidParam)]
    pub deposit_reserve: UncheckedAccount<'info>,
    /// CHECK: the market's USDC reserve (address checked against `wsm_market`).
    #[account(mut, address = wsm_market.usdc_reserve @ CoreError::InvalidParam)]
    pub usdc_reserve: UncheckedAccount<'info>,
    /// CHECK: klend `reserve.liquidity.supply_vault` (klend checks it).
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: klend `reserve.liquidity.fee_vault` (klend checks it).
    #[account(mut)]
    pub reserve_fee_vault: UncheckedAccount<'info>,
    /// CHECK: the program's `["wsm_auth"]` PDA, the market's permissioning authority.
    #[account(seeds = [SEED_WSM_AUTH], bump = wsm_market.auth_bump)]
    pub wsm_auth: UncheckedAccount<'info>,
    /// CHECK: the policy PDA, created here only when the cover is bought (a refused cover leaves nothing behind).
    #[account(mut, seeds = [SEED_POLICY, epoch.key().as_ref(), obligation.key().as_ref()], bump)]
    pub policy: UncheckedAccount<'info>,
    pub klend: WsmKlend<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Why a cover was refused (event only).
pub mod cover_failed {
    pub const CAPACITY: u8 = 1;
    pub const CONCENTRATION: u8 = 2;
    pub const HEADROOM: u8 = 3;
}

/// Buys the account's full cover for the weekend closure `closure_id`, between the freeze's start and the bell, charging
/// the premium to the account's own debt.
pub fn handle_wsm_auto_cover<'info>(mut ctx: Context<'info, WsmAutoCover<'info>>, ticker: Ticker, closure_id: u32) -> Result<()> {
    let clock = Clock::get()?;
    // Decide first, with only shared borrows: a refused cover touches nothing but the account's flag.
    let decision: std::result::Result<crate::instructions::cover::Priced, u8> = {
        let a = &ctx.accounts;
        require!(!a.config.paused, CoreError::Paused);
        let e = &a.epoch;
        // Weekend or holiday weekend only; never earlier than the freeze (so no debt is added after the cover).
        require!(e.closure_type == closure::WEEKEND || e.closure_type == closure::HOLIDAY_WEEKEND, CoreError::UnsupportedClosure);
        require!(clock.unix_timestamp >= e.bell.saturating_sub(a.wsm_market.freeze_secs as i64), CoreError::TooEarly);
        require!(a.wsm_account.covered_closure != closure_id, CoreError::InvalidParam);
        // One cover per closure per position (A-01): the policy PDA must not exist yet.
        require!(a.policy.data_is_empty() && *a.policy.owner == anchor_lang::system_program::ID, CoreError::InvalidParam);
        let asset = a.asset.load()?;
        let wsm_reserve = a.wsm_market.asset(&ticker)?.reserve;
        let ob = ObligationView::load(&a.obligation)?;
        require_keys_eq!(ob.owner, a.wsm_account.key(), CoreError::NotObligationOwner);
        require_fresh(&ob, clock.slot)?;
        let usdc = ReserveView::load(&a.usdc_reserve)?;
        require!(usdc.last_update_slot == clock.slot && usdc.stale == 0, CoreError::ObligationNotRefreshed);
        require!(!ob.borrows.is_empty() && ob.borrows[0].0 == a.wsm_market.usdc_reserve, CoreError::UnsupportedObligation);

        let input = PriceIn {
            cfg: &a.config,
            asset: &asset,
            scenarios: &a.scenarios,
            epoch: &a.epoch,
            earnings: a.earnings.as_ref(),
            vault: &a.vault,
            share_supply: a.share_mint.supply,
            loss: &a.loss,
            obligation: a.obligation.as_ref(),
            deposit_reserve: a.deposit_reserve.as_ref(),
            borrow_reserve: a.usdc_reserve.as_ref(),
            owner: a.wsm_account.key(),
            clock: &clock,
        };
        // The cover is for the debt that exists after the premium is borrowed: iterate the premium to its fixed point
        // (it is monotone in the debt and grows by a few base units per step).
        let priced = (|| -> Result<crate::instructions::cover::Priced> {
            let mut extra = 0u64;
            let mut pr = price_cover(&input, None, Some(wsm_reserve), extra)?;
            for _ in 0..4 {
                if pr.prem <= extra {
                    break;
                }
                extra = pr.prem;
                pr = price_cover(&input, None, Some(wsm_reserve), extra)?;
            }
            require!(pr.prem <= extra, CoreError::Math);
            Ok(pr)
        })();
        match priced {
            Ok(pr) => {
                // Headroom for the premium: klend's allowed borrow value and the market's D/C′ limit, premium valued UP.
                let prem_value = value_sf_up(pr.prem, usdc.market_price_sf, usdc.mint_decimals)?;
                let debt_after = ob.bf_adjusted_debt_value_sf.checked_add(prem_value).ok_or(CoreError::Math)?;
                if debt_after > ob.allowed_borrow_value_sf || !dcp_within(debt_after, ob.unhealthy_borrow_value_sf, a.wsm_market.max_dcp_wad) {
                    Err(cover_failed::HEADROOM)
                } else {
                    Ok(pr)
                }
            }
            Err(e) if is_core(&e, CoreError::CapacityExceeded) => Err(cover_failed::CAPACITY),
            Err(e) if is_core(&e, CoreError::ConcentrationExceeded) => Err(cover_failed::CONCENTRATION),
            Err(e) => return Err(e),
        }
    };
    let pr = match decision {
        Ok(pr) => pr,
        Err(reason) => {
            // A refused cover: nothing was borrowed, paid or created; the account is flagged and the call succeeds.
            let user = ctx.accounts.wsm_account.user;
            ctx.accounts.wsm_account.cover_failed_closure = closure_id;
            emit!(WsmCoverFailed { user, closure_id, reason });
            return Ok(());
        }
    };
    let a = &ctx.accounts;
    // 1. Borrow the premium onto the account's debt, into its USDC.
    let user = a.wsm_account.user;
    let bump = [a.wsm_account.bump];
    let owner_seeds = WsmAccount::signer_seeds(&user, &bump);
    let auth_bump = [a.wsm_market.auth_bump];
    let auth_seeds: [&[u8]; 2] = [SEED_WSM_AUTH, &auth_bump];
    let before = a.wsm_usdc.amount;
    kl::borrow(
        &market!(a.klend),
        &ReserveAccts {
            reserve: a.usdc_reserve.as_ref(),
            liquidity_mint: &a.usdc_mint.to_account_info(),
            liquidity_supply: a.reserve_liquidity_supply.as_ref(),
            liquidity_token_program: a.token_program.as_ref(),
        },
        &a.wsm_account.to_account_info(),
        a.obligation.as_ref(),
        a.reserve_fee_vault.as_ref(),
        &a.wsm_usdc.to_account_info(),
        a.wsm_auth.as_ref(),
        pr.prem,
        &owner_seeds,
        &auth_seeds,
    )?;
    let a = &mut ctx.accounts;
    a.wsm_usdc.reload()?;
    // INV-18: exactly the quoted premium arrived, and exactly that is paid; nothing else leaves the account.
    require!(a.wsm_usdc.amount.checked_sub(before) == Some(pr.prem), CoreError::Math);

    // 2. The vault and the fee account are paid from it.
    let acct_info = a.wsm_account.to_account_info();
    for (to, amt) in [(a.vault_usdc.to_account_info(), pr.net), (a.fee_account.to_account_info(), pr.fee)] {
        if amt > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    a.token_program.key(),
                    Transfer { from: a.wsm_usdc.to_account_info(), to, authority: acct_info.clone() },
                    &[&owner_seeds],
                ),
                amt,
            )?;
        }
    }

    // 3. The policy: created now (also when the address was pre-funded), written by the shared commit.
    let (epoch_key, ob_key) = (a.epoch.key(), a.obligation.key());
    let policy_bump = ctx.bumps.policy;
    let pbump = [policy_bump];
    let pseeds: [&[u8]; 4] = [SEED_POLICY, epoch_key.as_ref(), ob_key.as_ref(), &pbump];
    let rent = Rent::get()?.minimum_balance(Policy::SIZE);
    let have = a.policy.lamports();
    let sys = a.system_program.key();
    if have == 0 {
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                sys,
                anchor_lang::system_program::CreateAccount { from: a.payer.to_account_info(), to: a.policy.to_account_info() },
                &[&pseeds],
            ),
            rent,
            Policy::SIZE as u64,
            &crate::ID,
        )?;
    } else {
        // Someone sent lamports to the address first: top up, allocate and assign instead (what `init` does).
        if have < rent {
            anchor_lang::system_program::transfer(
                CpiContext::new(sys, anchor_lang::system_program::Transfer { from: a.payer.to_account_info(), to: a.policy.to_account_info() }),
                rent - have,
            )?;
        }
        anchor_lang::system_program::allocate(
            CpiContext::new_with_signer(sys, anchor_lang::system_program::Allocate { account_to_allocate: a.policy.to_account_info() }, &[&pseeds]),
            Policy::SIZE as u64,
        )?;
        anchor_lang::system_program::assign(
            CpiContext::new_with_signer(sys, anchor_lang::system_program::Assign { account_to_assign: a.policy.to_account_info() }, &[&pseeds]),
            &crate::ID,
        )?;
    }
    let mut policy = {
        let mut d = a.policy.try_borrow_mut_data()?;
        d[..8].copy_from_slice(Policy::DISCRIMINATOR);
        Policy::try_deserialize_unchecked(&mut &d[..])?
    };
    commit_policy(
        &mut a.vault,
        &a.loss,
        &mut a.epoch,
        &mut a.vault_usdc,
        &mut policy,
        &pr,
        a.wsm_account.key(),
        ob_key,
        a.usdc_reserve.key(),
        epoch_key,
        policy_bump,
        a.config.debt_growth_cap_wad,
        clock.unix_timestamp,
    )?;
    policy.rent_payer = a.payer.key();
    {
        let mut d = a.policy.try_borrow_mut_data()?;
        policy.try_serialize(&mut &mut d[..])?;
    }
    let w = &mut a.wsm_account;
    w.covered_closure = closure_id;
    w.cover_failed_closure = 0;
    w.addon_paid_total = w.addon_paid_total.checked_add(pr.prem).ok_or(CoreError::Math)?;
    emit!(WsmCovered {
        user,
        policy: a.policy.key(),
        closure_id,
        covered_value: pr.snap.covered_value,
        debt: pr.snap.debt,
        premium: pr.prem,
        worst_loss: pr.worst,
    });
    Ok(())
}

fn transfer_usdc<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccountInterface>,
    to: &InterfaceAccount<'info, TokenAccountInterface>,
    mint: &InterfaceAccount<'info, MintInterface>,
    wsm: &Account<'info, WsmAccount>,
    user: &Pubkey,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump = [wsm.bump];
    let seeds = WsmAccount::signer_seeds(user, &bump);
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: wsm.to_account_info() },
            &[&seeds],
        ),
        amount,
        mint.decimals,
    )
}

#[event]
pub struct WsmOpened {
    pub user: Pubkey,
    pub ticker: Ticker,
    pub account: Pubkey,
    pub obligation: Pubkey,
}
#[event]
pub struct WsmDeposited {
    pub user: Pubkey,
    pub amount: u64,
}
#[event]
pub struct WsmBorrowed {
    pub user: Pubkey,
    pub amount: u64,
}
#[event]
pub struct WsmRepaid {
    pub user: Pubkey,
    pub repaid: u64,
}
#[event]
pub struct WsmWithdrawn {
    pub user: Pubkey,
    pub amount: u64,
}
#[event]
pub struct WsmCovered {
    pub user: Pubkey,
    pub policy: Pubkey,
    pub closure_id: u32,
    pub covered_value: u64,
    pub debt: u64,
    pub premium: u64,
    pub worst_loss: u64,
}
#[event]
pub struct WsmCoverFailed {
    pub user: Pubkey,
    pub closure_id: u32,
    pub reason: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::SETTLE_WINDOW;

    const WAD64: u64 = 1_000_000_000_000_000_000;
    const fn pct(p: u64) -> u64 {
        p * (WAD64 / 100)
    }

    #[test]
    fn withdraw_guard_rounds_against_the_user() {
        let mv = 1_000u128 << 60;
        // 1000 USD of collateral, 100 cTokens, 700 USD of debt, normal LTV 0.70: nothing may leave.
        assert!(withdraw_within_normal(mv, 100, 0, 700u128 << 60, pct(70)));
        assert!(!withdraw_within_normal(mv, 100, 1, 700u128 << 60, pct(70)));
        // Debt of 600: 14 cTokens may leave (remaining 860 × 0.70 = 602 ≥ 600), 15 may not (850 × 0.7 = 595).
        assert!(withdraw_within_normal(mv, 100, 14, 600u128 << 60, pct(70)));
        assert!(!withdraw_within_normal(mv, 100, 15, 600u128 << 60, pct(70)));
        // No debt: everything may leave; debt but all collateral: refused.
        assert!(withdraw_within_normal(mv, 100, 100, 0, pct(70)));
        assert!(!withdraw_within_normal(mv, 100, 100, 1, pct(70)));
    }

    #[test]
    fn dcp_and_value_round_against_the_user() {
        assert!(dcp_within(94, 100, pct(94)));
        assert!(!dcp_within(95, 100, pct(94)));
        // 1 base unit of a 6-decimal token at $0.9998 is 0.9998e-6 USD: rounds up to one 2^60 unit's worth, not down to 0.
        assert!(value_sf_up(1, (0.9998 * (1u128 << 60) as f64) as u128, 6).unwrap() > 0);
    }

    fn s(date: u32, open: i64, close: i64) -> Session {
        Session { date, _pad: 0, open, close }
    }

    #[test]
    fn freeze_covers_the_weekend_and_skips_overnights() {
        // Wed, Thu, Fri, Mon sessions (dates 2026-10-07/08/09/12); times are made-up but ordered.
        let day = 86_400i64;
        let v = [s(20261007, 100 * day, 100 * day + 3_600), s(20261008, 101 * day, 101 * day + 3_600), s(20261009, 102 * day, 102 * day + 3_600), s(20261012, 105 * day, 105 * day + 3_600), s(20261013, 106 * day, 106 * day + 3_600)];
        let freeze = 4 * 3_600;
        let bell_fri = 102 * day + 3_600 - 15 * 60;
        // Thursday evening: the next cover closure is the Friday→Monday weekend; the Thu→Fri overnight is skipped.
        let thu_eve = 101 * day + 7_200;
        assert_eq!(next_cover_closure(&v, thu_eve).map(|t| t.closure_type), Some(closure::WEEKEND));
        assert!(!in_freeze(&v, thu_eve, freeze));
        // From bell − freeze: frozen, through the weekend, until Monday's open + the settlement window.
        assert!(in_freeze(&v, bell_fri - freeze as i64, freeze));
        assert!(in_freeze(&v, 104 * day, freeze));
        let mon_open = 105 * day;
        assert!(in_freeze(&v, mon_open + SETTLE_WINDOW - 1, freeze));
        assert!(!in_freeze(&v, mon_open + SETTLE_WINDOW, freeze));
    }
}
