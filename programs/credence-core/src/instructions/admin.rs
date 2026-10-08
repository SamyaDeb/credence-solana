//! Admin instructions: global config and asset registry.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint as MintInterface;

use crate::math::WAD;
use crate::state::*;
use crate::CoreError;

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
}

impl ConfigParams {
    fn validate(&self) -> Result<()> {
        let one = WAD as u64;
        require!(self.u_max_wad > 0 && self.u_max_wad <= one, CoreError::InvalidParam);
        require!(self.max_asset_share_wad > 0 && self.max_asset_share_wad <= one, CoreError::InvalidParam);
        require!(self.beta_wad > 0 && self.beta_wad < one, CoreError::InvalidParam);
        // Phase 1: κ = 0. The Gap Payout rule has no liquidation cost (plan/02 §2), and `pricing::premium` and the
        // on-chain gap factors must use the same κ or premium and capacity would price different models.
        require!(self.kappa_wad == 0, CoreError::InvalidParam);
        require!(self.fee_bps <= 10_000, CoreError::InvalidParam);
        require!(self.max_conf_bps > 0 && self.max_conf_bps <= 1_000, CoreError::InvalidParam);
        require!(self.xcheck_bps > 0 && self.xcheck_bps <= 2_000, CoreError::InvalidParam);
        require!(self.close_window_secs > 0 && self.close_window_secs <= 4 * 3600, CoreError::InvalidParam);
        // Bounded: a later "first update after the open" is less of an opening price (plan/06, settlement window).
        require!(
            self.xstock_settle_window_secs > 0 && self.xstock_settle_window_secs as i64 <= MAX_XSTOCK_WINDOW,
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
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = Config::SIZE, seeds = [SEED_CONFIG], bump)]
    pub config: Account<'info, Config>,
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
    pub config: Account<'info, Config>,
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
}

impl AssetParams {
    fn validate(&self) -> Result<()> {
        // σ per closure above 50% or a dividend above 20% is a data error, not a market.
        require!(self.sigma_wad > 0 && self.sigma_wad <= (WAD / 2) as u64, CoreError::InvalidParam);
        require!(self.dividend_wad <= (WAD / 5) as u64, CoreError::InvalidParam);
        require!((self.joint_column as usize) < MAX_JOINT_ASSETS, CoreError::InvalidParam);
        require!(self.settle_source <= crate::oracle::source::SCOPE, CoreError::InvalidParam);
        require!((self.scope_chain as usize) < crate::oracle::scope::N_CHAINS, CoreError::InvalidParam);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct AddAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Account<'info, Config>,
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
    pub config: Account<'info, Config>,
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
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
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
