//! Admin instructions: global config and asset registry.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint as MintInterface;

use crate::math::WAD;
use crate::state::*;
use crate::CoreError;

/// Upper bound of `min_premium` (1,000 USDC).
pub const MAX_MIN_PREMIUM: u64 = 1_000_000_000;

/// Upper bound of `xstock_settle_window_secs`.
pub const MAX_XSTOCK_WINDOW: i64 = 3600;

/// Global parameters, all WAD unless noted.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigParams {
    pub guardian: Pubkey,
    pub keeper: Pubkey,
    pub u_max_wad: u64,
    pub max_asset_share_wad: u64,
    pub theta_wad: u64,
    pub cost_of_cap_wad: u64,
    pub eta_wad: u64,
    pub beta_wad: u64,
    pub kappa_wad: u64,
    /// USDC base units.
    pub min_premium: u64,
    pub fee_bps: u16,
    pub max_conf_bps: u16,
    pub xcheck_bps: u16,
    pub close_window_secs: u32,
    pub xstock_settle_window_secs: u32,
    pub shield_alpha_wad: u64,
    pub shield_buffer_wad: u64,
    pub shield_health_wad: u64,
    pub shield_lambda_wad: u64,
    pub shield_max_age_secs: u32,
    pub shield_start_before_open_secs: u32,
    pub shield_deadline_before_open_secs: u32,
    pub shield_reserve_k_wad: u64,
    pub debt_growth_cap_wad: u64,
    pub debt_growth_est_wad: u64,
}

/// Upper bound of the shield's fair-value age and of its window start before the open (72 h).
pub const MAX_SHIELD_SECS: u32 = 72 * 3600;

impl ConfigParams {
    fn validate(&self) -> Result<()> {
        let one = WAD as u64;
        require!(self.u_max_wad > 0 && self.u_max_wad <= one, CoreError::InvalidParam);
        require!(self.max_asset_share_wad > 0 && self.max_asset_share_wad <= one, CoreError::InvalidParam);
        require!(self.beta_wad > 0 && self.beta_wad < one, CoreError::InvalidParam);
        // Phase 1: κ = 0. The Gap Payout rule has no liquidation cost, and `pricing::premium` and the
        // on-chain gap factors must use the same κ or premium and capacity would price different models.
        require!(self.kappa_wad == 0, CoreError::InvalidParam);
        // Premium parameters: a typo must not make cover free or absurdly priced. θ ≤ 10 (the backtest sweep ran
        // 0.2–1.5), cost of capital ≤ 100% a year, η ≤ 10, and a minimum premium in (0, 1,000 USDC].
        require!(self.theta_wad <= 10 * one && self.cost_of_cap_wad <= one && self.eta_wad <= 10 * one, CoreError::InvalidParam);
        require!(self.min_premium > 0 && self.min_premium <= MAX_MIN_PREMIUM, CoreError::InvalidParam);
        require!(self.fee_bps <= 10_000, CoreError::InvalidParam);
        require!(self.max_conf_bps > 0 && self.max_conf_bps <= 1_000, CoreError::InvalidParam);
        require!(self.xcheck_bps > 0 && self.xcheck_bps <= 2_000, CoreError::InvalidParam);
        require!(self.close_window_secs > 0 && self.close_window_secs <= 4 * 3600, CoreError::InvalidParam);
        // Bounded: a later "first update after the open" is less of an opening price.
        require!(
            self.xstock_settle_window_secs > 0 && self.xstock_settle_window_secs as i64 <= MAX_XSTOCK_WINDOW,
            CoreError::InvalidParam
        );
        // Liquidation Shield: α ≤ 100% of the cap (INV-9), buffer ≤ 20%, health margin ≤ 50%, λ ≤ 10; the window
        // starts at most 72 h before the open and ends before it starts; fair values at most 72 h old.
        require!(self.shield_alpha_wad <= one, CoreError::InvalidParam);
        require!(self.shield_buffer_wad <= one / 5 && self.shield_health_wad <= one / 2, CoreError::InvalidParam);
        require!(self.shield_lambda_wad <= 10 * one, CoreError::InvalidParam);
        // k ≤ 10: the reservation's fair-value shift in σ_b (task 1.2).
        require!(self.shield_reserve_k_wad <= 10 * one, CoreError::InvalidParam);
        // Interest a covered debt may accrue before the open: ≤ 10% (a weekend at klend's highest rates is far below).
        require!(self.debt_growth_cap_wad <= one / 10, CoreError::InvalidParam);
        require!(self.debt_growth_est_wad <= self.debt_growth_cap_wad, CoreError::InvalidParam);
        require!(self.shield_max_age_secs > 0 && self.shield_max_age_secs <= MAX_SHIELD_SECS, CoreError::InvalidParam);
        require!(
            self.shield_start_before_open_secs <= MAX_SHIELD_SECS
                && self.shield_deadline_before_open_secs < self.shield_start_before_open_secs,
            CoreError::InvalidParam
        );
        Ok(())
    }

    fn apply(&self, c: &mut Config) {
        c.guardian = self.guardian;
        c.keeper = self.keeper;
        c.u_max_wad = self.u_max_wad;
        c.max_asset_share_wad = self.max_asset_share_wad;
        c.theta_wad = self.theta_wad;
        c.cost_of_cap_wad = self.cost_of_cap_wad;
        c.eta_wad = self.eta_wad;
        c.beta_wad = self.beta_wad;
        c.kappa_wad = self.kappa_wad;
        c.min_premium = self.min_premium;
        c.fee_bps = self.fee_bps;
        c.max_conf_bps = self.max_conf_bps;
        c.xcheck_bps = self.xcheck_bps;
        c.close_window_secs = self.close_window_secs;
        c.xstock_settle_window_secs = self.xstock_settle_window_secs;
        c.shield_alpha_wad = self.shield_alpha_wad;
        c.shield_buffer_wad = self.shield_buffer_wad;
        c.shield_health_wad = self.shield_health_wad;
        c.shield_lambda_wad = self.shield_lambda_wad;
        c.shield_max_age_secs = self.shield_max_age_secs;
        c.shield_start_before_open_secs = self.shield_start_before_open_secs;
        c.shield_deadline_before_open_secs = self.shield_deadline_before_open_secs;
        c.shield_reserve_k_wad = self.shield_reserve_k_wad;
        c.debt_growth_cap_wad = self.debt_growth_cap_wad;
        c.debt_growth_est_wad = self.debt_growth_est_wad;
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = Config::SIZE, seeds = [SEED_CONFIG], bump)]
    pub config: Box<Account<'info, Config>>,
    /// USDC is a classic SPL Token mint.
    #[account(mint::token_program = token_program)]
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_config(ctx: Context<InitConfig>, params: ConfigParams) -> Result<()> {
    params.validate()?;
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.usdc_mint = ctx.accounts.usdc_mint.key();
    c.paused = false;
    c.bump = ctx.bumps.config;
    params.apply(c);
    Ok(())
}

#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
}

/// κ is fixed at 0 in Phase 1 (`ConfigParams::validate`); `gf_kappa_wad` still guards the gap factors if that changes.
pub fn handle_set_params(ctx: Context<SetParams>, params: ConfigParams) -> Result<()> {
    params.validate()?;
    params.apply(&mut ctx.accounts.config);
    Ok(())
}

/// Asset registration arguments.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssetParams {
    pub feed_equity: [u8; 32],
    pub feed_xstock: [u8; 32],
    pub feed_redemption: [u8; 32],
    pub kamino_reserves: [Pubkey; 2],
    pub sigma_wad: u64,
    pub dividend_wad: u64,
    pub joint_column: u8,
    pub enabled: bool,
    /// `oracle::source::EQUITY`, `XSTOCK` or `SCOPE`.
    pub settle_source: u8,
    /// Kamino Scope chain of this xStock (used by the SCOPE source; < 512).
    pub scope_chain: u16,
    /// σ_b for the shield loading, WAD (≤ 20%).
    pub basis_sigma_wad: u64,
}

impl AssetParams {
    fn validate(&self) -> Result<()> {
        // σ per closure above 50% or a dividend above 20% is a data error, not a market.
        require!(self.sigma_wad > 0 && self.sigma_wad <= (WAD / 2) as u64, CoreError::InvalidParam);
        require!(self.dividend_wad <= (WAD / 5) as u64, CoreError::InvalidParam);
        require!((self.joint_column as usize) < MAX_JOINT_ASSETS, CoreError::InvalidParam);
        require!(self.settle_source <= crate::oracle::source::SCOPE, CoreError::InvalidParam);
        require!((self.scope_chain as usize) < crate::oracle::scope::N_CHAINS, CoreError::InvalidParam);
        require!(self.basis_sigma_wad <= (WAD / 5) as u64, CoreError::InvalidParam);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct AddAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = AssetConfig::SIZE, seeds = [SEED_ASSET, ticker.as_ref()], bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    /// xStocks are Token-2022 mints with 8 decimals.
    #[account(mint::token_program = token_program, mint::decimals = 8)]
    pub mint: InterfaceAccount<'info, MintInterface>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_add_asset(ctx: Context<AddAsset>, ticker: Ticker, params: AssetParams) -> Result<()> {
    params.validate()?;
    require!(ticker != [0u8; 8], CoreError::InvalidParam);
    let mut a = ctx.accounts.asset.load_init()?;
    a.ticker = ticker;
    a.mint = ctx.accounts.mint.key();
    a.bump = ctx.bumps.asset;
    apply_asset(&mut a, &params);
    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct UpdateAsset<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_ASSET, ticker.as_ref()], bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
}

pub fn handle_update_asset(ctx: Context<UpdateAsset>, _ticker: Ticker, params: AssetParams) -> Result<()> {
    params.validate()?;
    let mut a = ctx.accounts.asset.load_mut()?;
    apply_asset(&mut a, &params);
    Ok(())
}

/// Any change to σ, d or the joint column clears the gap factors; they must be recomputed before sales.
fn apply_asset(a: &mut AssetConfig, p: &AssetParams) {
    if a.sigma_wad != p.sigma_wad || a.dividend_wad != p.dividend_wad || a.joint_column != p.joint_column {
        a.gf_count = 0;
    }
    a.feed_equity = p.feed_equity;
    a.feed_xstock = p.feed_xstock;
    a.feed_redemption = p.feed_redemption;
    a.kamino_reserves = p.kamino_reserves;
    a.sigma_wad = p.sigma_wad;
    a.dividend_wad = p.dividend_wad;
    a.joint_column = p.joint_column;
    a.enabled = p.enabled as u8;
    a.settle_source = p.settle_source as u64;
    a.scope_chain = p.scope_chain as u64;
    a.basis_sigma_wad = p.basis_sigma_wad;
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

/// The guardian or the admin may pause (risk-reducing); only the admin may unpause.
pub fn handle_set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let c = &mut ctx.accounts.config;
    let who = ctx.accounts.authority.key();
    let allowed = if paused { who == c.guardian || who == c.admin } else { who == c.admin };
    require!(allowed, CoreError::Unauthorized);
    c.paused = paused;
    Ok(())
}

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
}

/// Step one of an admin handover (W6: to the multisig): the admin names the next admin. Proposing the default key
/// cancels a pending handover.
pub fn handle_propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_admin = new_admin;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

/// Step two: the proposed key accepts (so a mistyped key never becomes the admin). The old admin loses every power.
pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    let k = ctx.accounts.new_admin.key();
    require!(c.pending_admin != Pubkey::default() && k == c.pending_admin, CoreError::Unauthorized);
    c.admin = k;
    c.pending_admin = Pubkey::default();
    Ok(())
}
