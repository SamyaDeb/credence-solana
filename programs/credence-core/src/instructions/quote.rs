//! `quote_cover`: read-only premium and capacity preview (app quote, compute measurement). `buy_cover` runs the same
//! code path and then writes state.

use anchor_lang::prelude::*;

use crate::pricing::{capacity, policy_losses, premium, CoverInputs};
use crate::state::*;
use crate::CoreError;

/// Closure length used for τ in the premium, days (a regular weekend: Friday close to Monday open ≈ 2.73 days,
/// rounded up).
pub const WEEKEND_CLOSURE_DAYS: u16 = 3;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quote {
    /// USDC base units, rounded up.
    pub premium: u64,
    /// max_j policy loss, USDC.
    pub worst_loss: u64,
    /// Utilisation after the policy, WAD (0 when no vault is passed).
    pub util_after_wad: u64,
    pub group_worst_after: u64,
}

#[derive(Accounts)]
pub struct QuoteCover<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [SEED_ASSET, asset.load()?.ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(address = asset.load()?.scenario_set @ CoreError::InvalidParam)]
    pub scenarios: AccountLoader<'info, ScenarioSet>,
    /// Optional: with the vault and the group's loss vector, the quote includes capacity and utilisation.
    #[account(seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Option<Account<'info, Vault>>,
    pub loss: Option<AccountLoader<'info, LossVector>>,
}

/// Reserved worst-case loss of every live group except `l` (`vault.reserved_total` includes `l.max_loss` once `l`
/// has a policy).
pub fn reserved_other(v: &Vault, l: &LossVector) -> Result<u64> {
    v.reserved_total.checked_sub(l.max_loss).ok_or_else(|| error!(CoreError::Math))
}

pub fn handle_quote_cover(ctx: Context<QuoteCover>, covered_value: u64, debt: u64, max_payout: u64) -> Result<Quote> {
    let cfg = &ctx.accounts.config;
    let a = ctx.accounts.asset.load()?;
    let s = ctx.accounts.scenarios.load()?;
    require!(s.finalized == 1, CoreError::NotFinalized);
    require!(
        a.gap_factors_ready()
            && a.gf_sigma_wad == a.sigma_wad
            && a.gf_dividend_wad == a.dividend_wad
            && a.gf_kappa_wad == cfg.kappa_wad,
        CoreError::StaleGapFactors
    );
    require!(max_payout > 0 && max_payout <= debt, CoreError::InvalidParam);
    let x = CoverInputs { covered_value, debt, max_payout };

    let mut losses = vec![0u64; K];
    let worst_loss = policy_losses(&a, &x, &mut losses)?;

    let (util_after_wad, group_worst_after) = match (&ctx.accounts.vault, &ctx.accounts.loss) {
        (Some(v), Some(l)) => {
            let l = l.load()?;
            require!(l.settled == 0, CoreError::InvalidParam);
            let c = capacity(&l.losses, &losses, reserved_other(v, &l)?, v.equity, cfg.u_max_wad)?;
            (c.util_after_wad, c.group_worst_after)
        }
        _ => (0, worst_loss),
    };
    let p = premium(&s.z[..s.n as usize], cfg, a.sigma_wad, a.dividend_wad, WEEKEND_CLOSURE_DAYS, util_after_wad, &x)?;
    Ok(Quote { premium: p, worst_loss, util_after_wad, group_worst_after })
}
