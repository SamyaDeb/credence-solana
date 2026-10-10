//! Gap tokens (D2): **research prototype, not offered**. A derivative that pays on a stock price is a legal question
//! before it is a technical one; nothing here is live, and a legal review comes before any offer.
//!
//! Per (asset, closure) one series with two Token-2022 mints, GAP-DOWN and GAP-UP, 6 decimals, mint authority the series
//! PDA, no freeze authority, no permanent delegate, no transfer hook. 1 USDC mints 1 DOWN + 1 UP (a complete set). Before
//! the rate is fixed a complete set merges back into 1 USDC. After the closure settles on the epoch's own stored close and
//! settlement price, the 1 USDC per set is split by the gap (`risk-core::gap_token`): DOWN's share rounds down, UP's is the
//! complement, so a set pays exactly 1 USDC. Nobody owes anything: every token is backed by USDC in the series' collateral
//! account. A voided epoch pays 0.5 each; an epoch that never settles lets anyone expire the series at 0.5 each.
//!
//! Invariants (README): INV-20 collateral covers what is owed, INV-21 the two sides add up to one set, INV-22 only
//! `mint_gap_set` mints and only against the deposit made in the same instruction.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_spl::token_2022_extensions::{
    metadata_pointer_initialize, mint_close_authority_initialize, token_metadata_initialize, token_metadata_update_authority,
    MetadataPointerInitialize, MintCloseAuthorityInitialize, TokenMetadataInitialize, TokenMetadataUpdateAuthority,
};
use anchor_spl::token_2022::{initialize_mint2, InitializeMint2};
use anchor_spl::token_interface::{self, spl_token_2022::instruction::AuthorityType, Burn, Mint as MintInterface, MintTo, SetAuthority, TokenAccount as TokenAccountInterface};
use credence_risk_core::gap_token;

use crate::instructions::quote::closure_terms;
use crate::settlement::gap_wad;
use crate::state::*;
use crate::state_gap::*;
use crate::CoreError;

/// Token-2022 mint with MintCloseAuthority + MetadataPointer: 82 base + padding to 165, account type, two TLV entries.
const MINT_BASE_LEN: usize = 165 + 1 + (4 + 32) + (4 + 64);

fn meta_len(name: &str, symbol: &str, uri: &str) -> usize {
    // TLV header, update authority, mint, three strings with a u32 length each, the (empty) additional-metadata vec.
    4 + 32 + 32 + (4 + name.len()) + (4 + symbol.len()) + (4 + uri.len()) + 4
}

fn ticker_str(t: &[u8; 8]) -> String {
    String::from_utf8_lossy(&t[..t.iter().position(|b| *b == 0).unwrap_or(8)]).into_owned()
}

// ---------------------------------------------------------------------------------------------------------------
// init_gap_series
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct InitGapSeries<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    /// The asset's scenario set for the epoch's closure type (PDA checked by `closure_terms`): the band comes from its σ.
    pub scenarios: AccountLoader<'info, ScenarioSet>,
    #[account(seeds = [SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    /// CHECK: the asset's `["earnings", ticker]` PDA (checked by `closure_terms`), initialised or not.
    pub earnings: UncheckedAccount<'info>,
    #[account(
        init, payer = payer, space = GapSeries::SIZE,
        seeds = [SEED_GSERIES, ticker.as_ref(), &closure_id.to_le_bytes()], bump
    )]
    pub series: Box<Account<'info, GapSeries>>,
    /// CHECK: created here at its PDA `["gdown", series]` as a Token-2022 mint.
    #[account(mut, seeds = [SEED_GDOWN, series.key().as_ref()], bump)]
    pub down_mint: UncheckedAccount<'info>,
    /// CHECK: created here at its PDA `["gup", series]` as a Token-2022 mint.
    #[account(mut, seeds = [SEED_GUP, series.key().as_ref()], bump)]
    pub up_mint: UncheckedAccount<'info>,
    #[account(
        init, payer = payer, token::mint = usdc_mint, token::authority = series, token::token_program = token_program,
        seeds = [SEED_GCOLL, series.key().as_ref()], bump
    )]
    pub collateral: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ CoreError::InvalidParam)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022 (checked in the handler).
    pub token_2022_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
fn create_gap_mint<'info>(
    payer: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    mint_seeds: &[&[u8]],
    series: &AccountInfo<'info>,
    series_seeds: &[&[u8]],
    token_2022: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    let lamports = Rent::get()?.minimum_balance(MINT_BASE_LEN + meta_len(&name, &symbol, &uri));
    if mint.lamports() == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(*system.key, system_program::CreateAccount { from: payer.clone(), to: mint.clone() }, &[mint_seeds]),
            lamports,
            MINT_BASE_LEN as u64,
            token_2022.key,
        )?;
    } else {
        // Audit A-220: the address derives from public seeds, so anyone can send it lamports first, and `create_account` fails on
        // an address that holds any. Top it up, then allocate and assign it (only the program can sign for the address).
        let missing = lamports.saturating_sub(mint.lamports());
        if missing > 0 {
            system_program::transfer(CpiContext::new(*system.key, system_program::Transfer { from: payer.clone(), to: mint.clone() }), missing)?;
        }
        system_program::allocate(CpiContext::new_with_signer(*system.key, system_program::Allocate { account_to_allocate: mint.clone() }, &[mint_seeds]), MINT_BASE_LEN as u64)?;
        system_program::assign(CpiContext::new_with_signer(*system.key, system_program::Assign { account_to_assign: mint.clone() }, &[mint_seeds]), token_2022.key)?;
    }
    mint_close_authority_initialize(
        CpiContext::new(*token_2022.key, MintCloseAuthorityInitialize { token_program_id: token_2022.clone(), mint: mint.clone() }),
        Some(series.key),
    )?;
    // No authority: the pointer can never be moved.
    metadata_pointer_initialize(
        CpiContext::new(*token_2022.key, MetadataPointerInitialize { token_program_id: token_2022.clone(), mint: mint.clone() }),
        None,
        Some(*mint.key),
    )?;
    // Mint authority the series PDA, no freeze authority.
    initialize_mint2(
        CpiContext::new(*token_2022.key, InitializeMint2 { mint: mint.clone() }),
        GAP_DECIMALS,
        series.key,
        None,
    )?;
    let signer: &[&[&[u8]]] = &[series_seeds];
    token_metadata_initialize(
        CpiContext::new_with_signer(
            *token_2022.key,
            TokenMetadataInitialize {
                program_id: token_2022.clone(),
                metadata: mint.clone(),
                update_authority: series.clone(),
                mint_authority: series.clone(),
                mint: mint.clone(),
            },
            signer,
        ),
        name,
        symbol,
        uri,
    )?;
    // The metadata is immutable from here.
    token_metadata_update_authority(
        CpiContext::new_with_signer(
            *token_2022.key,
            TokenMetadataUpdateAuthority {
                program_id: token_2022.clone(),
                metadata: mint.clone(),
                current_authority: series.clone(),
                new_authority: token_2022.clone(),
            },
            signer,
        ),
        anchor_spl::token_2022_extensions::spl_pod::optional_keys::OptionalNonZeroPubkey::default(),
    )?;
    Ok(())
}

/// Creates the series for an open epoch: the band, two Token-2022 mints and the collateral account, all derived from the
/// epoch and the asset. Anyone may pay for it; there is no parameter to choose.
pub fn handle_init_gap_series(ctx: Context<InitGapSeries>, ticker: Ticker, closure_id: u32) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.config.paused, CoreError::Paused);
    require_keys_eq!(a.token_2022_program.key(), anchor_spl::token_2022::ID, CoreError::WrongProgram);
    let asset = a.asset.load()?;
    require!(asset.enabled == 1, CoreError::AssetDisabled);
    let e = &a.epoch;
    require!(e.state == epoch_state::OPEN, CoreError::WrongEpochState);
    let now = Clock::get()?.unix_timestamp;
    require!(now < e.bell, CoreError::SalesClosed);
    let set = a.scenarios.load()?;
    let terms = closure_terms(&asset, &set, &a.scenarios.key(), e, &a.earnings)?;
    let k = gap_token::band_k(terms.sigma_wad);
    drop(asset);
    drop(set);

    let series_key = a.series.key();
    let (down_bump, up_bump) = (ctx.bumps.down_mint, ctx.bumps.up_mint);
    let series_bump = ctx.bumps.series;
    let cid = closure_id.to_le_bytes();
    let tk = ticker_str(&ticker);
    let day = closure_id.to_string();
    let series_seeds: &[&[u8]] = &[SEED_GSERIES, ticker.as_ref(), &cid, &[series_bump]];
    let uri = GAP_DISCLAIMER.to_string();
    let (payer, series, t22, sys) = (a.payer.to_account_info(), a.series.to_account_info(), a.token_2022_program.to_account_info(), a.system_program.to_account_info());
    create_gap_mint(
        &payer,
        &a.down_mint.to_account_info(),
        &[SEED_GDOWN, series_key.as_ref(), &[down_bump]],
        &series,
        series_seeds,
        &t22,
        &sys,
        format!("Credence gap DOWN {tk} {day} ({GAP_DISCLAIMER})"),
        "gDOWN".to_string(),
        uri.clone(),
    )?;
    create_gap_mint(
        &payer,
        &a.up_mint.to_account_info(),
        &[SEED_GUP, series_key.as_ref(), &[up_bump]],
        &series,
        series_seeds,
        &t22,
        &sys,
        format!("Credence gap UP {tk} {day} ({GAP_DISCLAIMER})"),
        "gUP".to_string(),
        uri,
    )?;

    let (down_mint, up_mint, collateral) = (a.down_mint.key(), a.up_mint.key(), a.collateral.key());
    let expires_at = e.settle_after.checked_add(GAP_EXPIRY_SECS).ok_or(CoreError::Math)?;
    let (bell, closure_type) = (e.bell, e.closure_type);
    let s = &mut ctx.accounts.series;
    s.ticker = ticker;
    s.closure_id = closure_id;
    s.closure_type = closure_type;
    s.state = gap_state::OPEN;
    s.bump = series_bump;
    s.down_mint = down_mint;
    s.up_mint = up_mint;
    s.collateral = collateral;
    s.k_wad = k;
    s.bell = bell;
    s.expires_at = expires_at;
    emit!(GapSeriesOpened { ticker, closure_id, series: series_key, down_mint, up_mint, k_wad: k, bell });
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// mint_gap_set / merge_gap_set
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct MintGapSet<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_GSERIES, series.ticker.as_ref(), &series.closure_id.to_le_bytes()], bump = series.bump)]
    pub series: Box<Account<'info, GapSeries>>,
    #[account(mut, address = series.down_mint @ CoreError::WrongGapAccount)]
    pub down_mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(mut, address = series.up_mint @ CoreError::WrongGapAccount)]
    pub up_mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(mut, address = series.collateral @ CoreError::WrongGapAccount)]
    pub collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = user, token::token_program = token_program)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = down_mint, token::authority = user, token::token_program = token_2022_program)]
    pub user_down: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(mut, token::mint = up_mint, token::authority = user, token::token_program = token_2022_program)]
    pub user_up: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022 (checked in the handler).
    pub token_2022_program: UncheckedAccount<'info>,
}

/// Deposits `amount` USDC and mints `amount` of each side, in one instruction (INV-22). Open series only, until the bell,
/// and not while paused.
pub fn handle_mint_gap_set(ctx: Context<MintGapSet>, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.config.paused, CoreError::Paused);
    require!(amount > 0, CoreError::InvalidParam);
    require_keys_eq!(a.token_2022_program.key(), anchor_spl::token_2022::ID, CoreError::WrongProgram);
    require!(a.series.state == gap_state::OPEN, CoreError::GapSeriesState);
    require!(Clock::get()?.unix_timestamp < a.series.bell, CoreError::SalesClosed);

    token::transfer(
        CpiContext::new(
            a.token_program.key(),
            Transfer { from: a.user_usdc.to_account_info(), to: a.collateral.to_account_info(), authority: a.user.to_account_info() },
        ),
        amount,
    )?;
    let cid = a.series.closure_id.to_le_bytes();
    let seeds: &[&[u8]] = &[SEED_GSERIES, a.series.ticker.as_ref(), &cid, &[a.series.bump]];
    for (mint, to) in [(&a.down_mint, &a.user_down), (&a.up_mint, &a.user_up)] {
        token_interface::mint_to(
            CpiContext::new_with_signer(
                a.token_2022_program.key(),
                MintTo { mint: mint.to_account_info(), to: to.to_account_info(), authority: a.series.to_account_info() },
                &[seeds],
            ),
            amount,
        )?;
    }
    let s = &mut ctx.accounts.series;
    s.sets_outstanding = s.sets_outstanding.checked_add(amount).ok_or(CoreError::Math)?;
    emit!(GapSetMinted { series: s.key(), user: ctx.accounts.user.key(), amount });
    Ok(())
}

#[derive(Accounts)]
pub struct MergeGapSet<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [SEED_GSERIES, series.ticker.as_ref(), &series.closure_id.to_le_bytes()], bump = series.bump)]
    pub series: Box<Account<'info, GapSeries>>,
    #[account(mut, address = series.down_mint @ CoreError::WrongGapAccount)]
    pub down_mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(mut, address = series.up_mint @ CoreError::WrongGapAccount)]
    pub up_mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(mut, address = series.collateral @ CoreError::WrongGapAccount)]
    pub collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = collateral.mint, token::authority = user, token::token_program = token_program)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = down_mint, token::authority = user, token::token_program = token_2022_program)]
    pub user_down: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(mut, token::mint = up_mint, token::authority = user, token::token_program = token_2022_program)]
    pub user_up: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022 (checked in the handler).
    pub token_2022_program: UncheckedAccount<'info>,
}

/// Burns `amount` of DOWN and of UP of this series and pays USDC. Never checks `paused`. Before the rate is fixed it pays
/// exactly `amount`; afterwards it is a redemption of both sides at the fixed rate (each side floors, so the pair pays
/// `amount` or one base unit less).
pub fn handle_merge_gap_set(ctx: Context<MergeGapSet>, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(amount > 0, CoreError::InvalidParam);
    require_keys_eq!(a.token_2022_program.key(), anchor_spl::token_2022::ID, CoreError::WrongProgram);
    // Burn first: the burn is what makes a second merge of the same tokens impossible.
    for (mint, from) in [(&a.down_mint, &a.user_down), (&a.up_mint, &a.user_up)] {
        token_interface::burn(
            CpiContext::new(
                a.token_2022_program.key(),
                Burn { mint: mint.to_account_info(), from: from.to_account_info(), authority: a.user.to_account_info() },
            ),
            amount,
        )?;
    }
    let s = &mut ctx.accounts.series;
    let pay = if s.fixed() {
        let d = redeem_side(s, gap_side::DOWN, amount)?;
        let u = redeem_side(s, gap_side::UP, amount)?;
        d.checked_add(u).ok_or(CoreError::Math)?
    } else {
        s.sets_outstanding = s.sets_outstanding.checked_sub(amount).ok_or(CoreError::GapAmount)?;
        amount
    };
    pay_from_collateral(&ctx.accounts, pay)?;
    emit!(GapSetMerged { series: ctx.accounts.series.key(), user: ctx.accounts.user.key(), amount, paid: pay });
    Ok(())
}

fn pay_from_collateral(a: &MergeGapSet, pay: u64) -> Result<()> {
    let cid = a.series.closure_id.to_le_bytes();
    let seeds: &[&[u8]] = &[SEED_GSERIES, a.series.ticker.as_ref(), &cid, &[a.series.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.key(),
            Transfer { from: a.collateral.to_account_info(), to: a.user_usdc.to_account_info(), authority: a.series.to_account_info() },
            &[seeds],
        ),
        pay,
    )
}

// ---------------------------------------------------------------------------------------------------------------
// settle_gap_series / expire_gap_series
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SettleGapSeries<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [SEED_GSERIES, series.ticker.as_ref(), &series.closure_id.to_le_bytes()], bump = series.bump)]
    pub series: Box<Account<'info, GapSeries>>,
    /// The series' own epoch, derived from the series; nothing about the price is passed in.
    #[account(seeds = [SEED_EPOCH, series.ticker.as_ref(), &series.closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, address = series.down_mint @ CoreError::WrongGapAccount)]
    pub down_mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(mut, address = series.up_mint @ CoreError::WrongGapAccount)]
    pub up_mint: Box<InterfaceAccount<'info, MintInterface>>,
    /// CHECK: Token-2022 (checked in the handler).
    pub token_2022_program: UncheckedAccount<'info>,
}

/// Fixes the rate and revokes the mint authority, so no instruction can mint afterwards. The rate is final.
fn fix_rate(ctx: &mut Context<SettleGapSeries>, new_state: u8, down_micro: u32, prices: (u128, u128, u8)) -> Result<()> {
    let a = &ctx.accounts;
    let cid = a.series.closure_id.to_le_bytes();
    let seeds: &[&[u8]] = &[SEED_GSERIES, a.series.ticker.as_ref(), &cid, &[a.series.bump]];
    for mint in [&a.down_mint, &a.up_mint] {
        token_interface::set_authority(
            CpiContext::new_with_signer(
                a.token_2022_program.key(),
                SetAuthority { current_authority: a.series.to_account_info(), account_or_mint: mint.to_account_info() },
                &[seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;
    }
    let s = &mut ctx.accounts.series;
    let sets = s.sets_outstanding;
    let up = gap_token::up_micro(down_micro);
    let pool_down = gap_token::side_pool(sets, down_micro).map_err(|_| error!(CoreError::Math))?;
    s.state = new_state;
    s.down_micro = down_micro;
    s.up_micro = up;
    s.close_price_wad = prices.0;
    s.settle_price_wad = prices.1;
    s.close_source = prices.2;
    s.settled_at = Clock::get()?.unix_timestamp;
    s.sets_settled = sets;
    s.pool_down = pool_down;
    // UP's pool is the complement: the two pools add up to the sets exactly (INV-21).
    s.pool_up = sets.checked_sub(pool_down).ok_or(CoreError::Math)?;
    emit!(GapSeriesSettled { series: s.key(), state: new_state, down_micro, up_micro: up, sets });
    Ok(())
}

/// Permissionless. Reads the series' epoch: SETTLED → the split of `gap_wad(close, settle)` from the epoch's stored prices
/// and source; VOIDED (no close was ever stored) → 0.5 each; anything else (open, closed, halted) waits.
pub fn handle_settle_gap_series(mut ctx: Context<SettleGapSeries>) -> Result<()> {
    require_keys_eq!(ctx.accounts.token_2022_program.key(), anchor_spl::token_2022::ID, CoreError::WrongProgram);
    require!(ctx.accounts.series.state == gap_state::OPEN, CoreError::GapSeriesState);
    let e = &ctx.accounts.epoch;
    let (down, prices) = match e.state {
        epoch_state::SETTLED => {
            require!(e.close_price_wad > 0 && e.settle_price_wad > 0, CoreError::BadPrice);
            let r = gap_wad(e.close_price_wad, e.settle_price_wad)?;
            let d = gap_token::down_micro(r, ctx.accounts.series.k_wad).map_err(|_| error!(CoreError::Math))?;
            (d, (e.close_price_wad, e.settle_price_wad, e.close_source))
        }
        epoch_state::VOIDED => (gap_token::SET_MICRO / 2, (0, 0, e.close_source)),
        _ => return err!(CoreError::WrongEpochState),
    };
    fix_rate(&mut ctx, gap_state::SETTLED, down, prices)
}

/// Permissionless, `GAP_EXPIRY_SECS` after the epoch should have settled and only if it still has not (not SETTLED, not
/// VOIDED): 0.5 each, a refund. Once the rate is fixed either way, the other path is refused.
pub fn handle_expire_gap_series(mut ctx: Context<SettleGapSeries>) -> Result<()> {
    require_keys_eq!(ctx.accounts.token_2022_program.key(), anchor_spl::token_2022::ID, CoreError::WrongProgram);
    require!(ctx.accounts.series.state == gap_state::OPEN, CoreError::GapSeriesState);
    let e = &ctx.accounts.epoch;
    require!(e.state != epoch_state::SETTLED && e.state != epoch_state::VOIDED, CoreError::WrongEpochState);
    require!(Clock::get()?.unix_timestamp >= ctx.accounts.series.expires_at, CoreError::TooEarly);
    let src = e.close_source;
    fix_rate(&mut ctx, gap_state::EXPIRED, gap_token::SET_MICRO / 2, (0, 0, src))
}

// ---------------------------------------------------------------------------------------------------------------
// redeem_gap
// ---------------------------------------------------------------------------------------------------------------

/// What `amount` tokens of `side` pay, and the bookkeeping. The last redeemer of a side takes its pool's remainder.
fn redeem_side(s: &mut GapSeries, side: u8, amount: u64) -> Result<u64> {
    require!(s.fixed(), CoreError::GapSeriesState);
    let (micro, pool, redeemed, paid) = match side {
        gap_side::DOWN => (s.down_micro, s.pool_down, s.redeemed_down, s.paid_down),
        gap_side::UP => (s.up_micro, s.pool_up, s.redeemed_up, s.paid_up),
        _ => return err!(CoreError::GapSide),
    };
    let remaining = s.sets_settled.checked_sub(redeemed).ok_or(CoreError::Math)?;
    let left = pool.checked_sub(paid).ok_or(CoreError::Math)?;
    let pay = gap_token::redeem_amount(amount, remaining, left, micro).map_err(|_| error!(CoreError::GapAmount))?;
    let redeemed = redeemed.checked_add(amount).ok_or(CoreError::Math)?;
    let paid = paid.checked_add(pay).ok_or(CoreError::Math)?;
    if side == gap_side::DOWN {
        s.redeemed_down = redeemed;
        s.paid_down = paid;
    } else {
        s.redeemed_up = redeemed;
        s.paid_up = paid;
    }
    Ok(pay)
}

#[derive(Accounts)]
pub struct RedeemGap<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [SEED_GSERIES, series.ticker.as_ref(), &series.closure_id.to_le_bytes()], bump = series.bump)]
    pub series: Box<Account<'info, GapSeries>>,
    /// The mint of the side being redeemed (checked against the series in the handler).
    #[account(mut)]
    pub gap_mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(mut, address = series.collateral @ CoreError::WrongGapAccount)]
    pub collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = collateral.mint, token::authority = user, token::token_program = token_program)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = gap_mint, token::authority = user, token::token_program = token_2022_program)]
    pub user_gap: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022 (checked in the handler).
    pub token_2022_program: UncheckedAccount<'info>,
}

/// Burns `amount` tokens of `side` (0 DOWN, 1 UP) and pays their share at the fixed rate. Only once the rate is fixed.
/// Rounds against the redeemer by less than one base unit; never checks `paused`.
pub fn handle_redeem_gap(ctx: Context<RedeemGap>, side: u8, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(amount > 0, CoreError::InvalidParam);
    require_keys_eq!(a.token_2022_program.key(), anchor_spl::token_2022::ID, CoreError::WrongProgram);
    let want = match side {
        gap_side::DOWN => a.series.down_mint,
        gap_side::UP => a.series.up_mint,
        _ => return err!(CoreError::GapSide),
    };
    require_keys_eq!(a.gap_mint.key(), want, CoreError::WrongGapAccount);
    require!(a.series.fixed(), CoreError::GapSeriesState);
    token_interface::burn(
        CpiContext::new(
            a.token_2022_program.key(),
            Burn { mint: a.gap_mint.to_account_info(), from: a.user_gap.to_account_info(), authority: a.user.to_account_info() },
        ),
        amount,
    )?;
    let pay = redeem_side(&mut ctx.accounts.series, side, amount)?;
    let a = &ctx.accounts;
    let cid = a.series.closure_id.to_le_bytes();
    let seeds: &[&[u8]] = &[SEED_GSERIES, a.series.ticker.as_ref(), &cid, &[a.series.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.key(),
            Transfer { from: a.collateral.to_account_info(), to: a.user_usdc.to_account_info(), authority: a.series.to_account_info() },
            &[seeds],
        ),
        pay,
    )?;
    emit!(GapRedeemed { series: a.series.key(), user: a.user.key(), side, amount, paid: pay });
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------------

#[event]
pub struct GapSeriesOpened {
    pub ticker: Ticker,
    pub closure_id: u32,
    pub series: Pubkey,
    pub down_mint: Pubkey,
    pub up_mint: Pubkey,
    pub k_wad: u128,
    pub bell: i64,
}

#[event]
pub struct GapSetMinted {
    pub series: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct GapSetMerged {
    pub series: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub paid: u64,
}

#[event]
pub struct GapSeriesSettled {
    pub series: Pubkey,
    pub state: u8,
    pub down_micro: u32,
    pub up_micro: u32,
    pub sets: u64,
}

#[event]
pub struct GapRedeemed {
    pub series: Pubkey,
    pub user: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub paid: u64,
}
