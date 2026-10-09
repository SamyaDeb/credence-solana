//! Chunked uploads of scenario and joint sets (larger than one transaction), and on-chain gap factors.
//!
//! Flow: `init_*` → `write_*` in chunks (any order, rewrites allowed) → `finalize_*` with the SHA-256 of the generated
//! file's values. Finalised sets are immutable; a new calibration is a new account (scenario sets: close and recreate
//! is Phase 2; joint sets: new `version`).

use anchor_lang::prelude::*;
use credence_risk_core::{gap_factor, U256};

use crate::math::wad_to_q64_down;
use crate::state::*;
use crate::CoreError;

/// SHA-256 over little-endian i16 values (the hash the loader prints for each generated set).
pub fn hash_i16(chunks: &[&[i16]]) -> [u8; 32] {
    let mut bytes: Vec<&[u8]> = Vec::with_capacity(chunks.len());
    for c in chunks {
        bytes.push(bytemuck::cast_slice(c)); // SBF and every host we use are little-endian
    }
    solana_sha256_hasher::hashv(&bytes).to_bytes()
}

// ---------------------------------------------------------------------------------------------------------------
// Scenario sets
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_type: u8)]
pub struct InitScenarioSet<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init, payer = admin, space = ScenarioSet::SIZE,
        seeds = [SEED_SCENARIOS, ticker.as_ref(), &[closure_type]], bump
    )]
    pub set: AccountLoader<'info, ScenarioSet>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_scenario_set(ctx: Context<InitScenarioSet>, ticker: Ticker, closure_type: u8, n: u16) -> Result<()> {
    require!(n > 0 && n as usize <= N_SCEN, CoreError::InvalidParam);
    // W11: every closure type the calendar produces (OVERNIGHT, WEEKEND, HOLIDAY_WEEKEND).
    require!((closure::OVERNIGHT..=closure::HOLIDAY_WEEKEND).contains(&closure_type), CoreError::InvalidParam);
    let mut s = ctx.accounts.set.load_init()?;
    s.ticker = ticker;
    s.closure_type = closure_type;
    s.n = n;
    s.bump = ctx.bumps.set;
    Ok(())
}

#[derive(Accounts)]
pub struct WriteScenarios<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, owner = crate::ID)]
    pub set: AccountLoader<'info, ScenarioSet>,
}

pub fn handle_write_scenarios(ctx: Context<WriteScenarios>, offset: u16, values: Vec<i16>) -> Result<()> {
    let mut s = ctx.accounts.set.load_mut()?;
    require!(s.finalized == 0, CoreError::AlreadyFinalized);
    let start = offset as usize;
    let end = start.checked_add(values.len()).ok_or(CoreError::InvalidParam)?;
    require!(!values.is_empty() && end <= s.n as usize, CoreError::InvalidParam);
    s.z[start..end].copy_from_slice(&values);
    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeScenarioSet<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, owner = crate::ID)]
    pub set: AccountLoader<'info, ScenarioSet>,
    /// The asset this set prices; it records the set.
    #[account(mut, owner = crate::ID)]
    pub asset: AccountLoader<'info, AssetConfig>,
}

/// Checks the values are sorted ascending and hash to `expected_hash`, then links the set to the asset.
pub fn handle_finalize_scenario_set(ctx: Context<FinalizeScenarioSet>, expected_hash: [u8; 32]) -> Result<()> {
    let mut s = ctx.accounts.set.load_mut()?;
    let mut a = ctx.accounts.asset.load_mut()?;
    require!(s.finalized == 0, CoreError::AlreadyFinalized);
    require!(a.ticker == s.ticker, CoreError::TickerMismatch);
    let z = &s.z[..s.n as usize];
    require!(z.windows(2).all(|w| w[0] <= w[1]), CoreError::NotSorted);
    require!(hash_i16(&[z]) == expected_hash, CoreError::HashMismatch);
    s.hash = expected_hash;
    s.finalized = 1;
    // The asset records its WEEKEND set (the gap factors' σ); other closure types are found by their PDA.
    if s.closure_type == closure::WEEKEND {
        a.scenario_set = ctx.accounts.set.key();
    }
    Ok(())
}

#[derive(Accounts)]
pub struct SetScenarioSigma<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, owner = crate::ID)]
    pub set: AccountLoader<'info, ScenarioSet>,
}

/// σ of a non-WEEKEND closure type for the asset (W11; a WEEKEND set prices on `AssetConfig::sigma_wad`).
pub fn handle_set_scenario_sigma(ctx: Context<SetScenarioSigma>, sigma_wad: u64) -> Result<()> {
    require!(sigma_wad > 0 && sigma_wad as u128 <= crate::math::WAD / 2, CoreError::InvalidParam);
    let mut s = ctx.accounts.set.load_mut()?;
    require!(s.closure_type != closure::WEEKEND, CoreError::InvalidParam);
    s.sigma_wad = sigma_wad;
    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct SetEarnings<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(init_if_needed, payer = admin, space = EarningsCalendar::SIZE, seeds = [SEED_EARNINGS, ticker.as_ref()], bump)]
    pub earnings: Box<Account<'info, EarningsCalendar>>,
    pub system_program: Program<'info, System>,
}

/// The asset's earnings calendar (W11): a closure containing a release prices with σ × `bump_wad` (1× to 8×; the earnings backtest measured up to 5.70×).
pub fn handle_set_earnings(ctx: Context<SetEarnings>, ticker: Ticker, bump_wad: u64, releases: Vec<i64>) -> Result<()> {
    let w = crate::math::WAD as u64;
    require!(bump_wad >= w && bump_wad <= 8 * w && releases.len() <= 32, CoreError::InvalidParam);
    let e = &mut ctx.accounts.earnings;
    e.ticker = ticker;
    e.bump_wad = bump_wad;
    e.releases = [0; 32];
    e.releases[..releases.len()].copy_from_slice(&releases);
    e.bump = ctx.bumps.earnings;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Joint sets
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(version: u32)]
pub struct InitJointSet<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = JointSet::SIZE, seeds = [SEED_JOINT, &version.to_le_bytes()], bump)]
    pub set: AccountLoader<'info, JointSet>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_joint_set(ctx: Context<InitJointSet>, version: u32, tickers: Vec<Ticker>) -> Result<()> {
    require!(!tickers.is_empty() && tickers.len() <= MAX_JOINT_ASSETS, CoreError::InvalidParam);
    for (i, t) in tickers.iter().enumerate() {
        require!(*t != [0u8; 8] && !tickers[..i].contains(t), CoreError::InvalidParam);
    }
    let mut s = ctx.accounts.set.load_init()?;
    s.version = version;
    s.k = K as u16;
    s.n_assets = tickers.len() as u8;
    s.tickers[..tickers.len()].copy_from_slice(&tickers);
    s.bump = ctx.bumps.set;
    Ok(())
}

#[derive(Accounts)]
pub struct WriteJoint<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, owner = crate::ID)]
    pub set: AccountLoader<'info, JointSet>,
}

pub fn handle_write_joint(ctx: Context<WriteJoint>, column: u8, offset: u16, values: Vec<i16>) -> Result<()> {
    let mut s = ctx.accounts.set.load_mut()?;
    require!(s.finalized == 0, CoreError::AlreadyFinalized);
    require!(column < s.n_assets, CoreError::InvalidParam);
    let start = offset as usize;
    let end = start.checked_add(values.len()).ok_or(CoreError::InvalidParam)?;
    require!(!values.is_empty() && end <= K, CoreError::InvalidParam);
    s.z[column as usize][start..end].copy_from_slice(&values);
    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeJointSet<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, owner = crate::ID)]
    pub set: AccountLoader<'info, JointSet>,
}

/// Hash covers columns `0..n_assets` in order, each K values.
pub fn handle_finalize_joint_set(ctx: Context<FinalizeJointSet>, expected_hash: [u8; 32]) -> Result<()> {
    let mut s = ctx.accounts.set.load_mut()?;
    require!(s.finalized == 0, CoreError::AlreadyFinalized);
    let cols: Vec<&[i16]> = s.z[..s.n_assets as usize].iter().map(|c| c.as_slice()).collect();
    require!(hash_i16(&cols) == expected_hash, CoreError::HashMismatch);
    s.hash = expected_hash;
    s.finalized = 1;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Gap factors
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ComputeGapFactors<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, owner = crate::ID)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(owner = crate::ID)]
    pub joint: AccountLoader<'info, JointSet>,
}

/// Computes `g_j` for `j in start..start+count` with risk-core's `gap_factor` (WAD, rounded down), stored as Q64.64
/// rounded down. `start == 0` begins a new computation with the current σ, d, κ and joint set; later chunks must
/// continue where the previous one stopped with the same inputs.
pub fn handle_compute_gap_factors(ctx: Context<ComputeGapFactors>, start: u16, count: u16) -> Result<()> {
    let j = ctx.accounts.joint.load()?;
    let mut a = ctx.accounts.asset.load_mut()?;
    let kappa = ctx.accounts.config.kappa_wad;
    require!(j.finalized == 1, CoreError::NotFinalized);
    let col = a.joint_column as usize;
    require!(col < j.n_assets as usize && (j.tickers[col] == a.ticker || is_alias_of(&a, &j.tickers[col])), CoreError::TickerMismatch);

    if start == 0 {
        a.gf_count = 0;
        a.gf_sigma_wad = a.sigma_wad;
        a.gf_dividend_wad = a.dividend_wad;
        a.gf_kappa_wad = kappa;
        a.gf_joint_hash = j.hash;
        a.joint_set = ctx.accounts.joint.key();
    } else {
        require!(start == a.gf_count, CoreError::InvalidParam);
        require!(
            a.gf_sigma_wad == a.sigma_wad
                && a.gf_dividend_wad == a.dividend_wad
                && a.gf_kappa_wad == kappa
                && a.gf_joint_hash == j.hash,
            CoreError::StaleGapFactors
        );
    }
    let end = (start as usize).checked_add(count as usize).ok_or(CoreError::InvalidParam)?;
    require!(count > 0 && end <= K, CoreError::InvalidParam);

    let (sigma, d, k) = (U256::from(a.sigma_wad), U256::from(a.dividend_wad), U256::from(kappa));
    for i in start as usize..end {
        let g = gap_factor(j.z[col][i], sigma, d, k).map_err(|_| error!(CoreError::Math))?;
        let q = wad_to_q64_down(g).ok_or(CoreError::Math)?;
        a.gap_factors[i] = q.to_le_bytes();
    }
    a.gf_count = end as u16;
    Ok(())
}

/// A Jupiter Lend alias asset `<T>.J` uses `<T>`'s joint column (W12): same xStock, same gaps, netted in one loss
/// vector with `<T>`'s Kamino policies.
fn is_alias_of(a: &AssetConfig, base: &Ticker) -> bool {
    if a.lender != lender::JUPITER as u64 {
        return false;
    }
    let len = a.ticker.iter().position(|b| *b == 0).unwrap_or(8);
    len >= 3 && &a.ticker[len - 2..len] == b".J" && a.ticker[..len - 2] == base[..len - 2] && base[len - 2..].iter().all(|b| *b == 0)
}
