//! `quote_cover`: read-only premium and capacity preview (app quote, compute measurement). `buy_cover` runs the same
//! code path and then writes state.

use anchor_lang::prelude::*;

use crate::math::free_equity;
use crate::pricing::{capacity, policy_losses_scaled, premium, priced_debt, reserved_debt, shield_loading, CoverInputs};
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
    /// Liquidation Shield loading included in `premium`, USDC (0 while the shield is off).
    pub shield_loading: u64,
}

#[derive(Accounts)]
pub struct QuoteCover<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, asset.load()?.ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    /// The asset's WEEKEND set, or with `epoch` the set of the epoch's closure type (checked in the handler).
    pub scenarios: AccountLoader<'info, ScenarioSet>,
    /// Optional: with the vault, its share mint and the group's loss vector, the quote includes capacity and
    /// utilisation (against equity net of queued withdrawals, as `buy_cover`).
    #[account(seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Option<Account<'info, Vault>>,
    pub loss: Option<AccountLoader<'info, LossVector>>,
    pub share_mint: Option<Account<'info, anchor_spl::token::Mint>>,
    /// Optional (W11, audit A-65): the epoch the cover would be bought on, with its earnings PDA: the quote then prices
    /// on that closure's set, σ (earnings bump included), length and capacity scaling, as `buy_cover`.
    pub epoch: Option<Box<Account<'info, Epoch>>>,
    /// CHECK: the asset's `["earnings", ticker]` PDA (checked by `closure_terms`); required with `epoch`.
    pub earnings: Option<UncheckedAccount<'info>>,
}

/// How a closure prices (W11): σ for its type (the WEEKEND set prices on the asset's σ, others on their set's), times
/// the earnings bump when a release falls inside it; τ in days (open − close, rounded up); and the multiplier the
/// weekend gap factors are scaled by for capacity (`σ / σ_weekend` when above 1, see `pricing::scale_gap_q64`).
#[derive(Clone, Copy, Debug)]
pub struct ClosureTerms {
    pub sigma_wad: u64,
    pub days: u16,
    pub capacity_mult_wad: u64,
}

/// The scenario set must be the asset's PDA for the epoch's closure type (`["scen", ticker, type]`, its stored bump),
/// finalised; `earnings` must be the asset's `["earnings", ticker]` PDA (initialised or not).
pub fn closure_terms(a: &AssetConfig, set: &ScenarioSet, set_key: &Pubkey, e: &Epoch, earnings: &AccountInfo) -> Result<ClosureTerms> {
    let want = Pubkey::create_program_address(&[SEED_SCENARIOS, a.ticker.as_ref(), &[e.closure_type], &[set.bump]], &crate::ID)
        .map_err(|_| error!(CoreError::InvalidParam))?;
    require_keys_eq!(*set_key, want, CoreError::InvalidParam);
    require!(set.ticker == a.ticker && set.closure_type == e.closure_type && set.finalized == 1, CoreError::NotFinalized);
    let base = if e.closure_type == closure::WEEKEND { a.sigma_wad } else { set.sigma_wad };
    require!(base > 0, CoreError::StaleGapFactors);
    let w = crate::math::WAD as u64;
    // The calendar counts only when `set_earnings` flagged the asset; then it must be the asset's PDA (its bump stored).
    let bump = if a.earnings == 1 {
        let ek = Pubkey::create_program_address(&[SEED_EARNINGS, a.ticker.as_ref(), &[a.earnings_bump]], &crate::ID)
            .map_err(|_| error!(CoreError::InvalidParam))?;
        require_keys_eq!(*earnings.key, ek, CoreError::InvalidParam);
        require_keys_eq!(*earnings.owner, crate::ID, CoreError::InvalidParam);
        let d = earnings.try_borrow_data()?;
        EarningsCalendar::try_deserialize(&mut &d[..])?.multiplier(e.close, e.open)
    } else {
        w
    };
    let span = e.open.checked_sub(e.close).ok_or(CoreError::Math)?.max(1);
    let days = u16::try_from((span as u64).div_ceil(86_400)).map_err(|_| error!(CoreError::Math))?;
    // An OVERNIGHT closure over a mid-week holiday spans several nights: σ × √nights (audit A-66).
    let nights = if e.closure_type == closure::OVERNIGHT { days } else { 1 };
    let base = credence_risk_core::premium::sigma_over_nights(credence_risk_core::U256::from(base), nights).map_err(|_| error!(CoreError::Math))?;
    let base = u64::try_from(base).map_err(|_| error!(CoreError::Math))?;
    let sigma = u64::try_from((base as u128) * (bump as u128) / crate::math::WAD).map_err(|_| error!(CoreError::Math))?;
    let mult = u64::try_from((sigma as u128 * crate::math::WAD).div_ceil(a.sigma_wad.max(1) as u128)).map_err(|_| error!(CoreError::Math))?.max(w);
    Ok(ClosureTerms { sigma_wad: sigma, days, capacity_mult_wad: mult })
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
    let terms = match (&ctx.accounts.epoch, &ctx.accounts.earnings) {
        (Some(e), Some(earnings)) => {
            require!(e.ticker == a.ticker, CoreError::InvalidParam);
            closure_terms(&a, &s, &ctx.accounts.scenarios.key(), e, earnings)?
        }
        (None, None) => {
            require_keys_eq!(ctx.accounts.scenarios.key(), a.scenario_set, CoreError::InvalidParam);
            ClosureTerms { sigma_wad: a.sigma_wad, days: WEEKEND_CLOSURE_DAYS, capacity_mult_wad: crate::math::WAD as u64 }
        }
        _ => return err!(CoreError::InvalidParam),
    };
    require!(
        a.gap_factors_ready()
            && a.gf_sigma_wad == a.sigma_wad
            && a.gf_dividend_wad == a.dividend_wad
            && a.gf_kappa_wad == cfg.kappa_wad,
        CoreError::StaleGapFactors
    );
    require!(max_payout > 0 && max_payout <= debt, CoreError::InvalidParam);
    // Reserved on the interest cap, priced on the expected interest (task 1.2), as `buy_cover`.
    let x = CoverInputs { covered_value, debt: reserved_debt(debt, cfg)?, max_payout };
    let xp = CoverInputs { debt: priced_debt(debt, cfg)?, ..x };

    let mut losses = vec![0u64; K];
    let worst_loss = policy_losses_scaled(&a, cfg, &x, terms.capacity_mult_wad, &mut losses)?;

    let (util_after_wad, group_worst_after) = match (&ctx.accounts.vault, &ctx.accounts.loss, &ctx.accounts.share_mint) {
        (Some(v), Some(l), Some(m)) => {
            require_keys_eq!(m.key(), v.share_mint, CoreError::InvalidParam);
            let l = l.load()?;
            require!(l.settled == 0, CoreError::InvalidParam);
            let equity = free_equity(v.cover_equity()?, v.queued_withdraw_shares, m.supply).ok_or(CoreError::Math)?;
            let c = capacity(&l.losses, &losses, reserved_other(v, &l)?, equity, cfg.u_max_wad)?;
            (c.util_after_wad, c.group_worst_after)
        }
        _ => (0, worst_loss),
    };
    let z = &s.z[..s.n as usize];
    let shield_loading = shield_loading(z, cfg, terms.sigma_wad, a.basis_sigma_wad, &xp, worst_loss)?;
    let p = premium(z, cfg, terms.sigma_wad, a.dividend_wad, terms.days, util_after_wad, &xp)?
        .checked_add(shield_loading)
        .ok_or(CoreError::Math)?;
    Ok(Quote { premium: p, worst_loss, util_after_wad, group_worst_after, shield_loading })
}
