//! Curator book cover (W5, task C2; plan/02 "Curator book cover"): a payer covers a book of positions it does not own.
//!
//! - `open_book` creates the `Book` and its USDC escrow (authority: the vault PDA).
//! - `add_book_leg` (Kamino, one xStock), `add_book_leg_multi` (Kamino, several xStocks, USDC or PYUSD debt) and
//!   `add_book_leg_jl` (Jupiter Lend) add one leg each, after the position's refreshes in the same transaction; a
//!   transaction carries as many as compute allows. Each one is the owner's purchase without the owner's signature and
//!   without a premium: the same snapshot (from the chain, never from the payer), the same reserved loss vector into
//!   the weekend's group, the same INV-2, concentration and cash checks, all **in the same instruction**, so two books
//!   (or a book and owners) adding in interleaved transactions can never oversell the vault. A leg is full cover
//!   (`max_payout` = the snapshot debt), side DOWN, WEEKEND epochs without an earnings bump only (A-63). The escrow is
//!   topped up to an upper bound of the book's premium so far ([`pricing::book_escrow_target`]).
//! - `seal_book` prices the book once (`risk-core::book_premium`: one floor, ES diversified on the joint set, loading
//!   summed) and pays it; until then the legs are not cover (no advance, no settlement).
//! - An OPEN book past `expires_at` (`min(bell, opened + BOOK_TTL_SECS)`) is voided leg by leg by anyone
//!   (`void_book_leg`); the escrow goes back through `claim_book_refund`.
//! - `release_book_leg`: the position's owner, before the bell, takes the leg off the book (its reservation leaves the
//!   group; its premium share is owed to the payer if the book was sealed) and the account is closed, so the owner's own
//!   `buy_cover*` in the same transaction creates its policy at the same address. Owner precedence never touches a
//!   payer account, so the payer cannot make it fail.
//!
//! Settlement, the shield and the unpaid-leg exits are in `book_settle.rs`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::TokenAccount as TokenAccountInterface;

use crate::instructions::cover::{concentration_limit, record_policy};
use crate::instructions::cover_multi::check_leg_pricing;
use crate::instructions::jupiter_lend::{jl_snapshot, MAX_CACHE_AGE_SECS};
use crate::instructions::quote::reserved_other;
use crate::instructions::settle::{is_pyusd, release_group};
use crate::jupiter::{read_cache, token_account_basics, PositionView, TickView, VaultConfigView, VaultStateView};
use crate::kamino::{cover_snapshot, cover_snapshot_multi, CoverAccounts, DepositLeg, ObligationView, ReserveView, XSTOCKS_MARKETS};
use crate::math::{free_equity, WAD};
use crate::pricing::{
    book_escrow_target, book_premium, capacity, leg_quote_multi, leg_quote_single, policy_losses, policy_losses_multi, priced_debt,
    reserved_debt, settlement_losses_multi, settlement_losses_single, CoverInputs, LegPricing, LegQuote, MultiInputs,
};
use crate::state::*;
use crate::CoreError;

/// An OPEN book can be sealed for at most this long after it is opened (and never after the bell); then anyone voids
/// it. Bounds how long a payer can hold capacity without paying (plan/02, C2 design §4).
pub const BOOK_TTL_SECS: i64 = 3600;

/// SHA-256 of a loss vector (K × u64 little-endian).
pub(crate) fn loss_hash(losses: &[u64]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[bytemuck::cast_slice(losses)]).to_bytes()
}

// ---------------------------------------------------------------------------------------------------------------
// open_book
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(closure_id: u32, book_id: u32)]
pub struct OpenBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// Any epoch of the closure: its bell bounds the book's life.
    #[account(seeds = [SEED_EPOCH, epoch.ticker.as_ref(), &closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        init, payer = payer, space = Book::SIZE,
        seeds = [SEED_BOOK, payer.key().as_ref(), &closure_id.to_le_bytes(), &book_id.to_le_bytes()], bump
    )]
    pub book: AccountLoader<'info, Book>,
    #[account(
        init, payer = payer, seeds = [SEED_BOOK_ESCROW, book.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = vault, token::token_program = token_program
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ CoreError::InvalidParam)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// Where the escrow's rest and every refund go.
    #[account(token::mint = config.usdc_mint, token::authority = payer, token::token_program = token_program)]
    pub payer_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_book(ctx: Context<OpenBook>, closure_id: u32, book_id: u32) -> Result<()> {
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let e = &ctx.accounts.epoch;
    require!(e.closure_type == closure::WEEKEND, CoreError::UnsupportedClosure); // A-63
    require!(e.state == epoch_state::OPEN && now >= e.sale_open && now < e.bell, CoreError::SalesClosed); // INV-3
    let mut b = ctx.accounts.book.load_init()?;
    b.payer = ctx.accounts.payer.key();
    b.payer_usdc = ctx.accounts.payer_usdc.key();
    b.escrow = ctx.accounts.escrow.key();
    b.created_at = now;
    b.expires_at = e.bell.min(now.checked_add(BOOK_TTL_SECS).ok_or(CoreError::Math)?);
    b.closure_id = closure_id;
    b.book_id = book_id;
    b.state = book_state::OPEN;
    b.bump = ctx.bumps.book;
    b.escrow_bump = ctx.bumps.escrow;
    emit!(BookOpened { book: ctx.accounts.book.key(), payer: b.payer, closure_id, book_id, expires_at: b.expires_at });
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Adding legs
// ---------------------------------------------------------------------------------------------------------------

/// The book is OPEN for this closure and before its expiry.
fn require_open(b: &Book, closure_id: u32, now: i64) -> Result<()> {
    require!(b.state == book_state::OPEN && now < b.expires_at, CoreError::BookNotOpen);
    require!(b.closure_id == closure_id, CoreError::InvalidParam);
    Ok(())
}

/// Books a new leg on its book: sums, its payout losses into the book's vector, counts; returns the escrow target.
fn book_add_leg(b: &mut Book, q: &LegQuote, worst: u64, settle: &[u64], cfg: &Config, util_wad: u64) -> Result<u64> {
    let s = credence_risk_core::book::add_leg(
        &credence_risk_core::BookSums { e: b.sum_e, es: b.sum_es, es_max: b.es_max, loading: b.sum_loading },
        q.e,
        q.es,
        q.loading,
    )
    .map_err(|_| error!(CoreError::Math))?;
    (b.sum_e, b.sum_es, b.es_max, b.sum_loading) = (s.e, s.es, s.es_max, s.loading);
    b.sum_w = b.sum_w.checked_add(q.w).ok_or(CoreError::Math)?;
    b.sum_worst = b.sum_worst.checked_add(worst).ok_or(CoreError::Math)?;
    for (slot, add) in b.losses.iter_mut().zip(settle) {
        *slot = slot.checked_add(*add).ok_or(CoreError::Math)?;
    }
    b.legs_added = b.legs_added.checked_add(1).ok_or(CoreError::Math)?;
    b.legs_live = b.legs_live.checked_add(1).ok_or(CoreError::Math)?;
    book_escrow_target(b, cfg, util_wad)
}

/// Tops the escrow up to `target` from the payer (rounded against the payer: the target is an upper bound).
fn top_up_escrow<'info>(
    b: &mut Book,
    target: u64,
    payer: &Signer<'info>,
    payer_usdc: &Account<'info, TokenAccount>,
    escrow: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    if target <= b.escrowed {
        return Ok(());
    }
    let add = target - b.escrowed;
    token::transfer(
        CpiContext::new(
            token_program.key(),
            Transfer { from: payer_usdc.to_account_info(), to: escrow.to_account_info(), authority: payer.to_account_info() },
        ),
        add,
    )?;
    b.escrowed = target;
    Ok(())
}

/// The fields every leg shares: no owner (no wallet path can name one), the book, the payer's rent, its pricing.
#[allow(clippy::too_many_arguments)]
fn write_leg(p: &mut Policy, book: Pubkey, payer: Pubkey, epoch: &Epoch, epoch_key: Pubkey, obligation: Pubkey, borrow_reserve: Pubkey, bump: u8, q: &LegQuote, losses: &[u64], worst: u64, cfg: &Config, now: i64) {
    p.owner = Pubkey::default();
    p.obligation = obligation;
    p.borrow_reserve = borrow_reserve;
    p.epoch = epoch_key;
    p.ticker = epoch.ticker;
    p.side = side::DOWN;
    p.state = policy_state::ACTIVE;
    p.bump = bump;
    p.premium = 0;
    p.fee = 0;
    p.worst_loss = worst;
    p.payout = 0;
    p.created_at = now;
    p.advanced = 0;
    p.advanced_at = 0;
    p.shield_loading = q.loading;
    p.debt_growth_cap_wad = cfg.debt_growth_cap_wad;
    p.book = book;
    p.rent_payer = payer;
    p.leg_e = q.e;
    p.leg_es = q.es;
    p.leg_w = q.w;
    p.leg_loss_hash = loss_hash(losses);
}

/// Equity, the capacity check (INV-2) and the group's max before, as every purchase (against equity net of queued
/// withdrawals and backstop inventory).
fn check_capacity(v: &Vault, share_supply: u64, l: &LossVector, losses: &[u64], cfg: &Config) -> Result<(crate::pricing::Capacity, u64, u64)> {
    let equity = free_equity(v.cover_equity()?, v.queued_withdraw_shares, share_supply).ok_or(CoreError::Math)?;
    require!(l.settled == 0, CoreError::SalesClosed);
    let cap = capacity(&l.losses, losses, reserved_other(v, l)?, equity, cfg.u_max_wad)?;
    Ok((cap, l.max_loss, equity))
}

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct AddBookLeg<'info> {
    /// The book's payer: pays the leg's rent and the escrow top-up.
    #[account(mut)]
    pub payer: Signer<'info>,
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
    #[account(address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, constraint = book.load()?.payer == payer.key() @ CoreError::Unauthorized)]
    pub book: AccountLoader<'info, Book>,
    #[account(mut, address = book.load()?.escrow @ CoreError::InvalidParam)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = payer, token::token_program = token_program)]
    pub payer_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: klend `Obligation`, decoded and checked by `kamino::cover_snapshot` (any owner: the payer covers it).
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: klend `Reserve` of the deposit; checked by `cover_snapshot`.
    pub deposit_reserve: UncheckedAccount<'info>,
    /// CHECK: klend `Reserve` of the borrow; checked by `cover_snapshot`.
    pub borrow_reserve: UncheckedAccount<'info>,
    /// The leg: the same PDA an owner's policy would use (A-01), so a position is covered at most once per closure.
    #[account(init, payer = payer, space = Policy::SIZE, seeds = [SEED_POLICY, epoch.key().as_ref(), obligation.key().as_ref()], bump)]
    pub policy: Box<Account<'info, Policy>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// One Kamino single-xStock leg (USDC debt), full cover.
pub fn handle_add_book_leg(ctx: Context<AddBookLeg>, _ticker: Ticker, closure_id: u32) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, CoreError::Paused);
    let clock = Clock::get()?;
    require_open(&*ctx.accounts.book.load()?, closure_id, clock.unix_timestamp)?;
    let e = &ctx.accounts.epoch;
    require!(e.closure_type == closure::WEEKEND, CoreError::UnsupportedClosure);
    require!(e.state == epoch_state::OPEN && clock.unix_timestamp >= e.sale_open && clock.unix_timestamp < e.bell, CoreError::SalesClosed);

    let asset = ctx.accounts.asset.load()?;
    require!(asset.lender == lender::KAMINO as u64, CoreError::InvalidParam);
    require!(asset.earnings == 0, CoreError::UnsupportedClosure); // priced as a plain weekend (A-63)
    check_leg_pricing(&asset, &ctx.accounts.scenarios, cfg)?;
    let set = ctx.accounts.scenarios.load()?;

    let ob = ObligationView::load(&ctx.accounts.obligation)?;
    let dep = ReserveView::load(&ctx.accounts.deposit_reserve)?;
    let bor = ReserveView::load(&ctx.accounts.borrow_reserve)?;
    let snap = cover_snapshot(
        &ob,
        &ob.owner, // the payer covers a position it does not own: every other check of the owner's purchase holds
        clock.slot,
        &CoverAccounts {
            deposit_reserve_key: ctx.accounts.deposit_reserve.key(),
            deposit_reserve: &dep,
            borrow_reserve_key: ctx.accounts.borrow_reserve.key(),
            borrow_reserve: &bor,
            asset_mint: asset.mint,
            asset_reserves: asset.kamino_reserves,
            usdc_mint: cfg.usdc_mint,
        },
    )?;
    require!(snap.debt > 0 && snap.debt < snap.covered_value, CoreError::AlreadyLiquidatable);
    require!(bor.cumulative_borrow_rate_bsf > 0, CoreError::KaminoLayout);
    let max_payout = snap.debt;
    let x = CoverInputs { covered_value: snap.covered_value, debt: reserved_debt(snap.debt, cfg)?, max_payout };
    let xp = CoverInputs { debt: priced_debt(snap.debt, cfg)?, ..x };
    let mut losses = vec![0u64; K];
    let worst = policy_losses(&asset, cfg, &x, &mut losses)?;
    let (cap, group_max_before, equity) = check_capacity(&ctx.accounts.vault, ctx.accounts.share_mint.supply, &*ctx.accounts.loss.load()?, &losses, cfg)?;
    let limit = concentration_limit(equity, cfg.u_max_wad, cfg.max_asset_share_wad);
    require!((e.worst_loss_sum as u128) + (worst as u128) <= limit, CoreError::ConcentrationExceeded);
    let z = &set.z[..set.n as usize];
    let q = leg_quote_single(z, cfg, asset.sigma_wad, asset.dividend_wad, asset.basis_sigma_wad, &xp, worst)?;
    let mut settle = vec![0u64; K];
    settlement_losses_single(&asset, &xp, &mut settle)?;
    let borrow_index = bor.cumulative_borrow_rate_bsf;
    drop(asset);
    drop(set);

    {
        let mut l = ctx.accounts.loss.load_mut()?;
        record_policy(&mut ctx.accounts.vault, &mut l, &mut ctx.accounts.epoch, &losses, cap.group_worst_after, group_max_before, worst, max_payout, 0, 0)?;
    }
    require!(ctx.accounts.vault_usdc.amount >= ctx.accounts.vault.reserved_cash()?, CoreError::CashBelowReservation);
    let book_key = ctx.accounts.book.key();
    {
        let mut b = ctx.accounts.book.load_mut()?;
        let target = book_add_leg(&mut b, &q, worst, &settle, cfg, cap.util_after_wad)?;
        let a = &ctx.accounts;
        top_up_escrow(&mut b, target, &a.payer, &a.payer_usdc, &a.escrow, &a.token_program)?;
    }
    let (payer, epoch_key, ob_key, bor_key, bump) =
        (ctx.accounts.payer.key(), ctx.accounts.epoch.key(), ctx.accounts.obligation.key(), ctx.accounts.borrow_reserve.key(), ctx.bumps.policy);
    let cfg = ctx.accounts.config.as_ref().clone();
    let e = ctx.accounts.epoch.as_ref().clone();
    let p = &mut ctx.accounts.policy;
    write_leg(p, book_key, payer, &e, epoch_key, ob_key, bor_key, bump, &q, &losses, worst, &cfg, clock.unix_timestamp);
    p.collateral_value = snap.collateral_value;
    p.covered_value = snap.covered_value;
    p.debt = snap.debt;
    p.liquidation_threshold_wad = snap.liquidation_threshold_wad;
    p.max_payout = max_payout;
    p.borrow_index_bsf = borrow_index;
    p.lender = lender::KAMINO;
    emit_added(book_key, p, cap.util_after_wad);
    Ok(())
}

fn emit_added(book: Pubkey, p: &Policy, util_after_wad: u64) {
    emit!(BookLegAdded {
        book,
        obligation: p.obligation,
        ticker: p.ticker,
        lender: p.lender,
        legs: p.n_legs,
        covered_value: p.covered_value,
        debt: p.debt,
        worst_loss: p.worst_loss,
        expected_loss: p.leg_e,
        expected_shortfall: p.leg_es,
        shield_loading: p.shield_loading,
        util_after_wad,
    });
}

#[derive(Accounts)]
#[instruction(closure_id: u32)]
pub struct AddBookLegMulti<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// Leg 0's epoch for `closure_id` (checked against leg 0 below).
    #[account(mut, constraint = epoch.closure_id == closure_id @ CoreError::InvalidParam)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [SEED_LOSS, &closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, constraint = book.load()?.payer == payer.key() @ CoreError::Unauthorized)]
    pub book: AccountLoader<'info, Book>,
    #[account(mut, address = book.load()?.escrow @ CoreError::InvalidParam)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = payer, token::token_program = token_program)]
    pub payer_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: klend `Obligation` (decoded and checked in `cover_snapshot_multi`).
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: the obligation's borrow reserve (decoded; identity and contents checked).
    pub borrow_reserve: UncheckedAccount<'info>,
    /// The vault's PYUSD sleeve: required for a PYUSD debt (address checked, INV-14).
    pub sleeve: Option<Box<InterfaceAccount<'info, TokenAccountInterface>>>,
    #[account(init, payer = payer, space = Policy::SIZE, seeds = [SEED_POLICY, epoch.key().as_ref(), obligation.key().as_ref()], bump)]
    pub policy: Box<Account<'info, Policy>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: as `buy_cover_multi`: the obligation's deposit reserves in its order, then per leg its
    // `AssetConfig`, WEEKEND scenario set and epoch (writable).
}

/// One Kamino multi-collateral leg (USDC or PYUSD debt), full cover; checks as `buy_cover_multi`.
pub fn handle_add_book_leg_multi<'info>(ctx: Context<'info, AddBookLegMulti<'info>>, closure_id: u32) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, CoreError::Paused);
    let clock = Clock::get()?;
    require_open(&*ctx.accounts.book.load()?, closure_id, clock.unix_timestamp)?;
    let ob = ObligationView::load(&ctx.accounts.obligation)?;
    let market_idx = XSTOCKS_MARKETS.iter().position(|m| *m == ob.lending_market).ok_or(CoreError::MarketNotAllowed)?;
    let n_dep = ob.deposits.len();
    let rem = ctx.remaining_accounts;
    require!(rem.len() >= n_dep, CoreError::InvalidParam);
    let reserves: Vec<ReserveView> = rem[..n_dep].iter().map(ReserveView::load).collect::<Result<_>>()?;
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
            check_leg_pricing(&av, &s, cfg)?;
            require!(av.lender == lender::KAMINO as u64, CoreError::InvalidParam);
            require!(e.ticker == av.ticker && e.closure_id == closure_id && leg_accts[3 * i + 2].is_writable, CoreError::InvalidParam);
            require!(e.closure_type == closure::WEEKEND && av.earnings == 0, CoreError::UnsupportedClosure);
            require!(e.state == epoch_state::OPEN && clock.unix_timestamp >= e.sale_open && clock.unix_timestamp < e.bell, CoreError::SalesClosed);
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
    let mut deps = Vec::with_capacity(n_dep);
    let mut seen = [false; MAX_LEGS];
    for (k, r) in reserves.iter().enumerate() {
        let leg = assets.iter().position(|a| a.load().map(|v| v.kamino_reserves[market_idx] == rem[k].key() && v.mint == r.liquidity_mint).unwrap_or(false));
        if let Some(i) = leg {
            seen[i] = true;
        }
        deps.push(DepositLeg { reserve_key: rem[k].key(), reserve: r, leg });
    }
    require!(seen[..n_legs].iter().all(|x| *x), CoreError::UnsupportedObligation);
    // Legs in order of first appearance among the deposits (A-45): the same leg 0, so the same PDA as the owner's.
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
    let snap = cover_snapshot_multi(&ob, &ob.owner, clock.slot, &deps, n_legs, ctx.accounts.borrow_reserve.key(), &bor, &stable_mints)?;
    let covered_total = snap.leg_covered.iter().try_fold(snap.stable_covered, |a, c| a.checked_add(*c)).ok_or(CoreError::Math)?;
    require!(snap.debt > 0 && snap.debt < covered_total, CoreError::AlreadyLiquidatable);
    let pyusd = snap.borrow_mint == cfg.pyusd_mint && cfg.pyusd_mint != Pubkey::default();
    require!(pyusd || snap.borrow_mint == cfg.usdc_mint, CoreError::UnsupportedObligation);
    let max_payout = snap.debt;

    let av: Vec<_> = assets.iter().map(|a| a.load()).collect::<Result<_>>()?;
    let refs: Vec<&AssetConfig> = av.iter().map(|r| &**r).collect();
    let xr = MultiInputs { legs: &snap.leg_covered, stable: snap.stable_covered, debt: reserved_debt(snap.debt, cfg)?, max_payout };
    let mut losses = vec![0u64; K];
    let worst = policy_losses_multi(&refs, cfg, &xr, &mut losses)?;
    let (cap, group_max_before, equity) = check_capacity(&ctx.accounts.vault, ctx.accounts.share_mint.supply, &*ctx.accounts.loss.load()?, &losses, cfg)?;
    let limit = concentration_limit(equity, cfg.u_max_wad, cfg.max_asset_share_wad);
    for e in epochs.iter() {
        require!((e.worst_loss_sum as u128) + (worst as u128) <= limit, CoreError::ConcentrationExceeded);
    }
    let xp = MultiInputs { debt: priced_debt(snap.debt, cfg)?, ..xr };
    let mut settle = vec![0u64; K];
    settlement_losses_multi(&refs, &xp, &mut settle)?;
    let sv: Vec<_> = sets.iter().map(|s| s.load()).collect::<Result<_>>()?;
    let pricing: Vec<LegPricing> = (0..n_legs)
        .map(|i| LegPricing { z: &sv[i].z[..sv[i].n as usize], sigma_wad: refs[i].sigma_wad, dividend_wad: refs[i].dividend_wad, basis_sigma_wad: refs[i].basis_sigma_wad })
        .collect();
    let q = leg_quote_multi(&pricing, cfg, &xp, &settle, worst)?;
    let tickers: Vec<Ticker> = refs.iter().map(|a| a.ticker).collect();
    let borrow_index = bor.cumulative_borrow_rate_bsf;
    require!(borrow_index > 0, CoreError::KaminoLayout);
    drop(sv);
    drop(av);

    let v = &ctx.accounts.vault;
    if pyusd {
        let s = ctx.accounts.sleeve.as_ref().ok_or(CoreError::SleeveMissing)?;
        require_keys_eq!(s.key(), v.pyusd_sleeve, CoreError::InvalidParam);
        let need = v.pyusd_reserved.checked_add(worst).and_then(|x| x.checked_sub(v.pyusd_advanced)).ok_or(CoreError::Math)?;
        require!(s.amount >= need, CoreError::SleeveShort); // INV-14
    }
    {
        let mut l = ctx.accounts.loss.load_mut()?;
        record_policy(&mut ctx.accounts.vault, &mut l, &mut ctx.accounts.epoch, &losses, cap.group_worst_after, group_max_before, worst, max_payout, 0, 0)?;
        if pyusd {
            let v = &mut ctx.accounts.vault;
            v.pyusd_reserved = v.pyusd_reserved.checked_add(worst).ok_or(CoreError::Math)?;
        }
    }
    require!(ctx.accounts.vault_usdc.amount >= ctx.accounts.vault.reserved_cash()?, CoreError::CashBelowReservation);
    for e in epochs.iter_mut().skip(1) {
        e.worst_loss_sum = e.worst_loss_sum.checked_add(worst).ok_or(CoreError::Math)?;
        e.exit(ctx.program_id)?;
    }
    let book_key = ctx.accounts.book.key();
    {
        let mut b = ctx.accounts.book.load_mut()?;
        let target = book_add_leg(&mut b, &q, worst, &settle, cfg, cap.util_after_wad)?;
        let a = &ctx.accounts;
        top_up_escrow(&mut b, target, &a.payer, &a.payer_usdc, &a.escrow, &a.token_program)?;
    }
    let (payer, epoch_key, ob_key, bor_key, bump) =
        (ctx.accounts.payer.key(), ctx.accounts.epoch.key(), ctx.accounts.obligation.key(), ctx.accounts.borrow_reserve.key(), ctx.bumps.policy);
    let cfg = ctx.accounts.config.as_ref().clone();
    let e = ctx.accounts.epoch.as_ref().clone();
    let p = &mut ctx.accounts.policy;
    write_leg(p, book_key, payer, &e, epoch_key, ob_key, bor_key, bump, &q, &losses, worst, &cfg, clock.unix_timestamp);
    p.ticker = tickers[0];
    p.collateral_value = snap.collateral_value;
    p.covered_value = covered_total;
    p.debt = snap.debt;
    p.liquidation_threshold_wad = 0;
    p.max_payout = max_payout;
    p.borrow_index_bsf = borrow_index;
    p.lender = lender::KAMINO;
    p.n_legs = n_legs as u8;
    for (i, t) in tickers.iter().enumerate() {
        p.leg_tickers[8 * i..8 * i + 8].copy_from_slice(t);
        p.leg_covered[i] = snap.leg_covered[i];
    }
    p.stable_covered = snap.stable_covered;
    p.borrow_mint = snap.borrow_mint;
    emit_added(book_key, p, cap.util_after_wad);
    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: Ticker, closure_id: u32)]
pub struct AddBookLegJl<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
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
    #[account(address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, constraint = book.load()?.payer == payer.key() @ CoreError::Unauthorized)]
    pub book: AccountLoader<'info, Book>,
    #[account(mut, address = book.load()?.escrow @ CoreError::InvalidParam)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = payer, token::token_program = token_program)]
    pub payer_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: Jupiter Lend `Position` (owner, discriminator, vault checked).
    pub position: UncheckedAccount<'info>,
    /// CHECK: the asset's Jupiter USDC vault config (address checked, decoded).
    #[account(address = asset.load()?.lender_vault @ CoreError::InvalidParam)]
    pub vault_config: UncheckedAccount<'info>,
    /// CHECK: the vault's `VaultState` (owner, discriminator, vault id checked).
    pub vault_state: UncheckedAccount<'info>,
    /// CHECK: the position's `Tick` (owner, discriminator, vault and tick checked).
    pub position_tick: UncheckedAccount<'info>,
    /// CHECK: the asset's Chainlink Data Streams cache (address, owner, discriminator checked by `read_cache`).
    pub cache: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = Policy::SIZE, seeds = [SEED_POLICY, epoch.key().as_ref(), position.key().as_ref()], bump)]
    pub policy: Box<Account<'info, Policy>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// One Jupiter Lend leg, full cover; checks as `buy_cover_jl` without the NFT.
pub fn handle_add_book_leg_jl(ctx: Context<AddBookLegJl>, _ticker: Ticker, closure_id: u32) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, CoreError::Paused);
    let clock = Clock::get()?;
    require_open(&*ctx.accounts.book.load()?, closure_id, clock.unix_timestamp)?;
    let e = &ctx.accounts.epoch;
    let asset = ctx.accounts.asset.load()?;
    require!(e.closure_type == closure::WEEKEND && asset.earnings == 0, CoreError::UnsupportedClosure);
    require!(e.state == epoch_state::OPEN && clock.unix_timestamp >= e.sale_open && clock.unix_timestamp < e.bell, CoreError::SalesClosed);
    require!(asset.lender == lender::JUPITER as u64, CoreError::InvalidParam);
    check_leg_pricing(&asset, &ctx.accounts.scenarios, cfg)?;
    let set = ctx.accounts.scenarios.load()?;
    let vc = VaultConfigView::load(&ctx.accounts.vault_config)?;
    require!(vc.supply_token == asset.mint && vc.borrow_token == cfg.usdc_mint, CoreError::JupiterLayout);
    let vs = VaultStateView::load(&ctx.accounts.vault_state)?;
    let pos = PositionView::load(&ctx.accounts.position)?;
    require!(vs.vault_id == vc.vault_id && pos.vault_id == vc.vault_id, CoreError::JupiterLayout);
    let tick = TickView::load(&ctx.accounts.position_tick)?;
    require!(tick.vault_id == vc.vault_id && tick.tick == pos.tick, CoreError::JupiterLayout);
    require!(!tick.is_liquidated && tick.total_ids <= pos.tick_id, CoreError::PositionLiquidated);
    let px = read_cache(&ctx.accounts.cache, &asset.lender_oracle)?;
    require!(!px.suspended && clock.unix_timestamp - px.unix_timestamp <= MAX_CACHE_AGE_SECS, CoreError::BadPrice);
    let snap = jl_snapshot(&pos, &vs, vc.liquidation_threshold_permille, px.price_wad)?;
    require!(snap.debt > 0 && snap.debt < snap.covered_value, CoreError::AlreadyLiquidatable);
    let max_payout = snap.debt;
    let x = CoverInputs { covered_value: snap.covered_value, debt: reserved_debt(snap.debt, cfg)?, max_payout };
    let xp = CoverInputs { debt: priced_debt(snap.debt, cfg)?, ..x };
    let mut losses = vec![0u64; K];
    let worst = policy_losses(&asset, cfg, &x, &mut losses)?;
    let (cap, group_max_before, equity) = check_capacity(&ctx.accounts.vault, ctx.accounts.share_mint.supply, &*ctx.accounts.loss.load()?, &losses, cfg)?;
    require!((e.worst_loss_sum as u128) + (worst as u128) <= concentration_limit(equity, cfg.u_max_wad, cfg.max_asset_share_wad), CoreError::ConcentrationExceeded);
    let q = leg_quote_single(&set.z[..set.n as usize], cfg, asset.sigma_wad, asset.dividend_wad, asset.basis_sigma_wad, &xp, worst)?;
    let mut settle = vec![0u64; K];
    settlement_losses_single(&asset, &xp, &mut settle)?;
    drop(asset);
    drop(set);
    {
        let mut l = ctx.accounts.loss.load_mut()?;
        record_policy(&mut ctx.accounts.vault, &mut l, &mut ctx.accounts.epoch, &losses, cap.group_worst_after, group_max_before, worst, max_payout, 0, 0)?;
    }
    require!(ctx.accounts.vault_usdc.amount >= ctx.accounts.vault.reserved_cash()?, CoreError::CashBelowReservation);
    let book_key = ctx.accounts.book.key();
    {
        let mut b = ctx.accounts.book.load_mut()?;
        let target = book_add_leg(&mut b, &q, worst, &settle, cfg, cap.util_after_wad)?;
        let a = &ctx.accounts;
        top_up_escrow(&mut b, target, &a.payer, &a.payer_usdc, &a.escrow, &a.token_program)?;
    }
    let (payer, epoch_key, pos_key, vc_key, bump) =
        (ctx.accounts.payer.key(), ctx.accounts.epoch.key(), ctx.accounts.position.key(), ctx.accounts.vault_config.key(), ctx.bumps.policy);
    let cfg = ctx.accounts.config.as_ref().clone();
    let e = ctx.accounts.epoch.as_ref().clone();
    let p = &mut ctx.accounts.policy;
    write_leg(p, book_key, payer, &e, epoch_key, pos_key, vc_key, bump, &q, &losses, worst, &cfg, clock.unix_timestamp);
    p.collateral_value = snap.collateral_value;
    p.covered_value = snap.covered_value;
    p.debt = snap.debt;
    p.liquidation_threshold_wad = snap.liquidation_threshold_wad;
    p.max_payout = max_payout;
    p.borrow_index_bsf = vs.borrow_exchange_price as u128;
    p.lender = lender::JUPITER;
    emit_added(book_key, p, cap.util_after_wad);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// seal_book
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SealBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, constraint = book.load()?.payer == payer.key() @ CoreError::Unauthorized)]
    pub book: AccountLoader<'info, Book>,
    #[account(mut, address = book.load()?.escrow @ CoreError::InvalidParam)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = payer, token::token_program = token_program)]
    pub payer_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_LOSS, &book.load()?.closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = vault.fee_account @ CoreError::InvalidParam)]
    pub fee_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Prices the book once and pays: `premium ≤ max_premium` (fee included). The utilisation is the vault's after every
/// leg (each leg already reserved its capacity), rounded UP.
pub fn handle_seal_book<'info>(ctx: Context<'info, SealBook<'info>>, max_premium: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, CoreError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let v = &ctx.accounts.vault;
    let equity = free_equity(v.cover_equity()?, v.queued_withdraw_shares, ctx.accounts.share_mint.supply).ok_or(CoreError::Math)?;
    let limit = (equity as u128) * (cfg.u_max_wad as u128) / WAD;
    require!(limit > 0, CoreError::CapacityExceeded);
    let util = u64::try_from(((v.reserved_total as u128) * WAD).div_ceil(limit)).map_err(|_| error!(CoreError::Math))?;
    let (premium, legs) = {
        let b = ctx.accounts.book.load()?;
        require!(b.state == book_state::OPEN && now < b.expires_at, CoreError::BookNotOpen);
        require!(b.legs_live > 0, CoreError::InvalidParam);
        (book_premium(&b, cfg, util)?, b.legs_live)
    };
    require!(premium <= max_premium, CoreError::PremiumAboveMax);
    let fee = u64::try_from((premium as u128) * (cfg.fee_bps as u128) / 10_000).map_err(|_| error!(CoreError::Math))?;
    let net = premium.checked_sub(fee).ok_or(CoreError::Math)?;

    let a = &ctx.accounts;
    // The escrow is an upper bound at each add's utilisation; if the vault filled up since, the payer adds the rest.
    if a.escrow.amount < premium {
        token::transfer(
            CpiContext::new(a.token_program.key(), Transfer { from: a.payer_usdc.to_account_info(), to: a.escrow.to_account_info(), authority: a.payer.to_account_info() }),
            premium - a.escrow.amount,
        )?;
    }
    let seeds: &[&[u8]] = &[SEED_VAULT, &[a.vault.bump]];
    let from_escrow = |to: AccountInfo<'info>, amount: u64| -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        token::transfer(
            CpiContext::new_with_signer(a.token_program.key(), Transfer { from: a.escrow.to_account_info(), to, authority: a.vault.to_account_info() }, &[seeds]),
            amount,
        )
    };
    from_escrow(a.vault_usdc.to_account_info(), net)?;
    from_escrow(a.fee_account.to_account_info(), fee)?;
    let mut escrow = a.escrow.clone();
    escrow.reload()?;
    from_escrow(a.payer_usdc.to_account_info(), escrow.amount)?;
    token::close_account(CpiContext::new_with_signer(
        a.token_program.key(),
        CloseAccount { account: a.escrow.to_account_info(), destination: a.payer.to_account_info(), authority: a.vault.to_account_info() },
        &[seeds],
    ))?;

    {
        let mut l = ctx.accounts.loss.load_mut()?;
        l.premiums = l.premiums.checked_add(net).ok_or(CoreError::Math)?;
    }
    let v = &mut ctx.accounts.vault;
    v.premiums_unearned = v.premiums_unearned.checked_add(net).ok_or(CoreError::Math)?;
    v.total_premiums = v.total_premiums.checked_add(net).ok_or(CoreError::Math)?;
    let mut b = ctx.accounts.book.load_mut()?;
    b.premium = premium;
    b.fee = fee;
    b.util_wad = util;
    b.w_seal = b.sum_w;
    b.escrowed = 0;
    b.state = book_state::SEALED;
    emit!(BookSealed { book: ctx.accounts.book.key(), legs, premium, fee, util_wad: util, expected_loss: b.sum_e, shield_loading: b.sum_loading });
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Taking a leg off the book: the owner's release (before the bell) and the void of an unsealed book
// ---------------------------------------------------------------------------------------------------------------

/// The leg's assets (leg 0 named, legs 1.. from `rem` as `[asset, epoch]` pairs) and the other legs' epochs.
fn leg_assets_and_epochs<'info>(
    p: &Policy,
    asset0: &AccountLoader<'info, AssetConfig>,
    rem: &'info [AccountInfo<'info>],
    closure_id: u32,
) -> Result<(Vec<AccountLoader<'info, AssetConfig>>, Vec<Account<'info, Epoch>>)> {
    let n = (p.n_legs as usize).max(1);
    require!(rem.len() >= 2 * (n - 1), CoreError::InvalidParam);
    let mut assets = vec![asset0.clone()];
    let mut epochs = Vec::with_capacity(n - 1);
    for i in 1..n {
        let a: AccountLoader<'info, AssetConfig> = AccountLoader::try_from(&rem[2 * (i - 1)])?;
        let e: Account<'info, Epoch> = Account::try_from(&rem[2 * (i - 1) + 1])?;
        let t = a.load()?.ticker;
        require!(t == p.leg_ticker(i) && e.ticker == t && e.closure_id == closure_id && rem[2 * (i - 1) + 1].is_writable, CoreError::InvalidParam);
        assets.push(a);
        epochs.push(e);
    }
    Ok((assets, epochs))
}

/// The leg's reserved loss vector and its payout loss vector, recomputed from its stored snapshot.
fn leg_vectors(p: &Policy, assets: &[&AssetConfig], cfg: &Config) -> Result<(Vec<u64>, Vec<u64>)> {
    let mut reserved = vec![0u64; K];
    let mut settle = vec![0u64; K];
    let (rd, pd) = (reserved_debt(p.debt, cfg)?, priced_debt(p.debt, cfg)?);
    if p.n_legs == 0 {
        let x = CoverInputs { covered_value: p.covered_value, debt: rd, max_payout: p.max_payout };
        policy_losses(assets[0], cfg, &x, &mut reserved)?;
        settlement_losses_single(assets[0], &CoverInputs { debt: pd, ..x }, &mut settle)?;
    } else {
        let n = p.n_legs as usize;
        let x = MultiInputs { legs: &p.leg_covered[..n], stable: p.stable_covered, debt: rd, max_payout: p.max_payout };
        policy_losses_multi(assets, cfg, &x, &mut reserved)?;
        settlement_losses_multi(assets, &MultiInputs { debt: pd, ..x }, &mut settle)?;
    }
    Ok((reserved, settle))
}

/// Undoes a leg's `record_policy`: its reserved losses leave the group when they recompute to the vector it added (same
/// hash; otherwise they stay: over-reserved, safe), the group's max (never below its advances, INV-12) and the vault's
/// reservation follow, the counts and the epochs' concentration totals go back. A group left without policies drops its
/// leftovers; one whose other policies all finished releases.
fn unrecord_leg(v: &mut Vault, l: &mut LossVector, e0: &mut Epoch, others: &mut [Account<Epoch>], p: &Policy, reserved: &[u64], cfg: &Config) -> Result<bool> {
    let matched = loss_hash(reserved) == p.leg_loss_hash;
    if matched {
        for (slot, r) in l.losses.iter_mut().zip(reserved) {
            *slot = slot.checked_sub(*r).ok_or(CoreError::Math)?;
        }
    }
    let new_max = l.losses.iter().copied().max().unwrap_or(0).max(l.advanced);
    v.reserved_total = v.reserved_total.checked_sub(l.max_loss).and_then(|r| r.checked_add(new_max)).ok_or(CoreError::Math)?;
    l.max_loss = new_max;
    l.policy_count = l.policy_count.checked_sub(1).ok_or(CoreError::Math)?;
    if is_pyusd(cfg, p) {
        v.pyusd_reserved = v.pyusd_reserved.checked_sub(p.worst_loss).ok_or(CoreError::Math)?;
    }
    e0.policy_count = e0.policy_count.saturating_sub(1);
    e0.total_max_payout = e0.total_max_payout.saturating_sub(p.max_payout);
    e0.worst_loss_sum = e0.worst_loss_sum.saturating_sub(p.worst_loss);
    for e in others.iter_mut() {
        e.worst_loss_sum = e.worst_loss_sum.saturating_sub(p.worst_loss);
    }
    if l.policy_count == 0 {
        // Nothing left in the group: what stayed reserved (a mismatched recompute) and any premium dust go.
        v.reserved_total = v.reserved_total.checked_sub(l.max_loss).ok_or(CoreError::Math)?;
        l.losses = [0; K];
        l.max_loss = 0;
        v.premiums_unearned = v.premiums_unearned.checked_sub(l.premiums).ok_or(CoreError::Math)?;
        v.equity = v.equity.checked_add(l.premiums).ok_or(CoreError::Math)?;
        l.premiums = 0;
        v.remove_live(l.group)?;
    } else if l.policies_settled == l.policy_count {
        release_group(v, l)?;
    }
    Ok(matched)
}

/// A leg leaves its book: counts; while OPEN its sums and payout losses come off (the max ES stays: conservative).
fn book_drop_leg(b: &mut Book, p: &Policy, settle: Option<&[u64]>) -> Result<()> {
    b.legs_live = b.legs_live.checked_sub(1).ok_or(CoreError::Math)?;
    b.legs_done = b.legs_done.checked_add(1).ok_or(CoreError::Math)?;
    b.sum_worst = b.sum_worst.saturating_sub(p.worst_loss);
    if b.state == book_state::OPEN {
        b.sum_e = b.sum_e.checked_sub(p.leg_e).ok_or(CoreError::Math)?;
        b.sum_es = b.sum_es.checked_sub(p.leg_es).ok_or(CoreError::Math)?;
        b.sum_loading = b.sum_loading.checked_sub(p.shield_loading).ok_or(CoreError::Math)?;
        b.sum_w = b.sum_w.checked_sub(p.leg_w).ok_or(CoreError::Math)?;
        if let Some(s) = settle {
            for (slot, x) in b.losses.iter_mut().zip(s) {
                *slot = slot.saturating_sub(*x);
            }
        }
    }
    Ok(())
}

/// A sealed leg's share of the book's net premium, `⌊net × w / w_seal⌋` (rounded DOWN, against the payer), at most what
/// the group still holds: out of the group's and the vault's unearned premiums into `refund_owed` (INV-15).
pub(crate) fn accrue_refund(b: &mut Book, l: &mut LossVector, v: &mut Vault, w: u64) -> Result<u64> {
    let net = b.premium.checked_sub(b.fee).ok_or(CoreError::Math)?;
    let share = credence_risk_core::leg_share(net, w, b.w_seal).map_err(|_| error!(CoreError::Math))?.min(l.premiums);
    l.premiums -= share;
    v.premiums_unearned = v.premiums_unearned.checked_sub(share).ok_or(CoreError::Math)?;
    v.total_premiums = v.total_premiums.saturating_sub(share);
    b.refund_owed = b.refund_owed.checked_add(share).ok_or(CoreError::Math)?;
    require!(b.refunded.checked_add(b.refund_owed).is_some_and(|t| t <= net), CoreError::Math); // INV-15
    Ok(share)
}

#[derive(Accounts)]
pub struct ReleaseBookLeg<'info> {
    /// The position's owner (Kamino: the obligation's `owner`; Jupiter: the holder of the position NFT).
    pub owner: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch.ticker.as_ref(), &epoch.closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_POLICY, epoch.key().as_ref(), policy.obligation.as_ref()], bump = policy.bump,
        has_one = epoch @ CoreError::InvalidParam,
    )]
    pub policy: Box<Account<'info, Policy>>,
    #[account(mut, seeds = [SEED_LOSS, &epoch.closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = policy.book @ CoreError::NotABookLeg)]
    pub book: AccountLoader<'info, Book>,
    /// Leg 0's asset.
    #[account(seeds = [SEED_ASSET, policy.ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    /// CHECK: `policy.obligation` (address checked): the klend obligation or the Jupiter position, decoded for its owner.
    #[account(address = policy.obligation @ CoreError::InvalidParam)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: Jupiter only: the owner's token account of the position NFT (mint, owner, amount 1 checked).
    pub position_token_account: Option<UncheckedAccount<'info>>,
    /// CHECK: receives the leg's rent (address = `policy.rent_payer`, the book's payer). Crediting lamports cannot fail.
    #[account(mut, address = policy.rent_payer @ CoreError::InvalidParam)]
    pub rent_payer: UncheckedAccount<'info>,
    // remaining_accounts: a multi-collateral leg's legs 1.. as [asset, epoch (writable)] pairs.
}

/// The owner takes their position off a book before the bell (C2 §5): the leg's reservation leaves the group, its share
/// of a sealed book's premium is owed to the payer, and the account is closed (rent to the payer), so the owner's own
/// `buy_cover*` later in the same transaction creates its policy at the same address. Touches no payer token account.
pub fn handle_release_book_leg<'info>(ctx: Context<'info, ReleaseBookLeg<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let p = &ctx.accounts.policy;
    require!(p.book != Pubkey::default(), CoreError::NotABookLeg);
    require!(p.state == policy_state::ACTIVE, CoreError::WrongEpochState);
    // Before the bell only: after it the cover is fixed (a release during the weekend would be a free option).
    require!(now < ctx.accounts.epoch.bell, CoreError::SalesClosed);
    // Nothing is advanced before the bell (the shield window opens after it): nothing to account for twice.
    require!(p.advanced == 0, CoreError::Math);
    let owner = ctx.accounts.owner.key();
    if p.lender == lender::JUPITER {
        let pos = PositionView::load(&ctx.accounts.position)?;
        let ta = ctx.accounts.position_token_account.as_ref().ok_or(CoreError::InvalidParam)?;
        let (mint, holder, amount) = token_account_basics(ta)?;
        require!(mint == pos.position_mint && amount == 1 && holder == owner, CoreError::NotObligationOwner);
    } else {
        require_keys_eq!(ObligationView::load(&ctx.accounts.position)?.owner, owner, CoreError::NotObligationOwner);
    }
    take_leg_off(
        &ctx.accounts.config,
        &mut ctx.accounts.epoch,
        &ctx.accounts.policy,
        &ctx.accounts.loss,
        &mut ctx.accounts.vault,
        &ctx.accounts.book,
        &ctx.accounts.asset,
        ctx.remaining_accounts,
        true,
    )
}

/// Release and void: the leg off the group and the book (and, for a release from a sealed book, its premium share owed).
#[allow(clippy::too_many_arguments)]
fn take_leg_off<'info>(
    cfg: &Config,
    epoch: &mut Account<'info, Epoch>,
    p: &Policy,
    loss: &AccountLoader<'info, LossVector>,
    vault: &mut Account<'info, Vault>,
    book: &AccountLoader<'info, Book>,
    asset0: &AccountLoader<'info, AssetConfig>,
    rem: &'info [AccountInfo<'info>],
    release: bool,
) -> Result<()> {
    let (assets, mut others) = leg_assets_and_epochs(p, asset0, rem, epoch.closure_id)?;
    let av: Vec<_> = assets.iter().map(|a| a.load()).collect::<Result<_>>()?;
    let refs: Vec<&AssetConfig> = av.iter().map(|r| &**r).collect();
    let (reserved, settle) = leg_vectors(p, &refs, cfg)?;
    drop(av);
    let mut b = book.load_mut()?;
    let mut l = loss.load_mut()?;
    let refund = if b.state == book_state::SEALED { accrue_refund(&mut b, &mut l, vault, p.leg_w)? } else { 0 };
    let matched = unrecord_leg(vault, &mut l, epoch, &mut others, p, &reserved, cfg)?;
    book_drop_leg(&mut b, p, matched.then_some(&settle[..]))?;
    for e in others.iter() {
        e.exit(&crate::ID)?;
    }
    emit!(BookLegRemoved { book: book.key(), obligation: p.obligation, released_by_owner: release, refund, reservation_freed: matched });
    Ok(())
}

#[derive(Accounts)]
pub struct VoidBookLeg<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch.ticker.as_ref(), &epoch.closure_id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_POLICY, epoch.key().as_ref(), policy.obligation.as_ref()], bump = policy.bump,
        has_one = epoch @ CoreError::InvalidParam,
    )]
    pub policy: Box<Account<'info, Policy>>,
    #[account(mut, seeds = [SEED_LOSS, &epoch.closure_id.to_le_bytes()], bump = loss.load()?.bump)]
    pub loss: AccountLoader<'info, LossVector>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = policy.book @ CoreError::NotABookLeg)]
    pub book: AccountLoader<'info, Book>,
    #[account(seeds = [SEED_ASSET, policy.ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    /// CHECK: receives the leg's rent (address = `policy.rent_payer`).
    #[account(mut, address = policy.rent_payer @ CoreError::InvalidParam)]
    pub rent_payer: UncheckedAccount<'info>,
    // remaining_accounts: as `release_book_leg`.
}

/// Anyone, once an OPEN book is past `expires_at` (the bell at the latest): the book becomes VOIDED and each leg is
/// taken off the group (capacity released) and closed. Not gated by `paused` (it only unwinds risk).
pub fn handle_void_book_leg<'info>(ctx: Context<'info, VoidBookLeg<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.policy.state == policy_state::ACTIVE, CoreError::WrongEpochState);
    {
        let mut b = ctx.accounts.book.load_mut()?;
        if b.state == book_state::OPEN {
            require!(now >= b.expires_at, CoreError::BookNotExpired);
            b.state = book_state::VOIDED;
            emit!(BookVoided { book: ctx.accounts.book.key(), legs: b.legs_live, escrowed: b.escrowed });
        }
        require!(b.state == book_state::VOIDED, CoreError::BookNotOpen);
    }
    take_leg_off(
        &ctx.accounts.config,
        &mut ctx.accounts.epoch,
        &ctx.accounts.policy,
        &ctx.accounts.loss,
        &mut ctx.accounts.vault,
        &ctx.accounts.book,
        &ctx.accounts.asset,
        ctx.remaining_accounts,
        false,
    )
}

// ---------------------------------------------------------------------------------------------------------------
// Refunds and closing
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ClaimBookRefund<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub book: AccountLoader<'info, Book>,
    /// The escrow, while it exists (a VOIDED book's; a sealed book closed it).
    #[account(mut, address = book.load()?.escrow @ CoreError::InvalidParam)]
    pub escrow: Option<Box<Account<'info, TokenAccount>>>,
    /// CHECK: the payer (address = `book.payer`): receives the escrow's rent.
    #[account(mut, address = book.load()?.payer @ CoreError::InvalidParam)]
    pub payer: UncheckedAccount<'info>,
    #[account(mut, address = book.load()?.payer_usdc @ CoreError::InvalidParam)]
    pub payer_usdc: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Anyone: pays the payer what it is owed: a VOIDED book's whole escrow (and closes it), and the refunds accrued in
/// `refund_owed` (from the vault, already out of the group's premiums).
pub fn handle_claim_book_refund(ctx: Context<ClaimBookRefund>) -> Result<()> {
    let a = &ctx.accounts;
    let seeds: &[&[u8]] = &[SEED_VAULT, &[a.vault.bump]];
    let mut b = a.book.load_mut()?;
    let mut escrow_back = 0u64;
    if let Some(escrow) = &a.escrow {
        require!(b.state == book_state::VOIDED, CoreError::BookNotOpen);
        escrow_back = escrow.amount;
        if escrow_back > 0 {
            token::transfer(
                CpiContext::new_with_signer(a.token_program.key(), Transfer { from: escrow.to_account_info(), to: a.payer_usdc.to_account_info(), authority: a.vault.to_account_info() }, &[seeds]),
                escrow_back,
            )?;
        }
        token::close_account(CpiContext::new_with_signer(
            a.token_program.key(),
            CloseAccount { account: escrow.to_account_info(), destination: a.payer.to_account_info(), authority: a.vault.to_account_info() },
            &[seeds],
        ))?;
        b.escrowed = 0;
    }
    let owed = b.refund_owed;
    if owed > 0 {
        token::transfer(
            CpiContext::new_with_signer(a.token_program.key(), Transfer { from: a.vault_usdc.to_account_info(), to: a.payer_usdc.to_account_info(), authority: a.vault.to_account_info() }, &[seeds]),
            owed,
        )?;
        b.refunded = b.refunded.checked_add(owed).ok_or(CoreError::Math)?;
        b.refund_owed = 0;
    }
    emit!(BookRefundClaimed { book: a.book.key(), escrow: escrow_back, refund: owed, refunded_total: b.refunded });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseBook<'info> {
    pub caller: Signer<'info>,
    #[account(mut, close = payer)]
    pub book: AccountLoader<'info, Book>,
    /// CHECK: the payer (address = `book.payer`): receives the rent.
    #[account(mut, address = book.load()?.payer @ CoreError::InvalidParam)]
    pub payer: UncheckedAccount<'info>,
}

/// Anyone, once every leg is done, every refund paid and the escrow gone: the book's rent back to the payer.
pub fn handle_close_book(ctx: Context<CloseBook>) -> Result<()> {
    let b = ctx.accounts.book.load()?;
    require!(b.state != book_state::OPEN && b.legs_done == b.legs_added && b.refund_owed == 0 && b.escrowed == 0, CoreError::BookNotDone);
    Ok(())
}

#[event]
pub struct BookOpened {
    pub book: Pubkey,
    pub payer: Pubkey,
    pub closure_id: u32,
    pub book_id: u32,
    pub expires_at: i64,
}

#[event]
pub struct BookLegAdded {
    pub book: Pubkey,
    pub obligation: Pubkey,
    pub ticker: Ticker,
    pub lender: u8,
    pub legs: u8,
    pub covered_value: u64,
    pub debt: u64,
    pub worst_loss: u64,
    pub expected_loss: u64,
    pub expected_shortfall: u64,
    pub shield_loading: u64,
    pub util_after_wad: u64,
}

#[event]
pub struct BookSealed {
    pub book: Pubkey,
    pub legs: u32,
    pub premium: u64,
    pub fee: u64,
    pub util_wad: u64,
    pub expected_loss: u64,
    pub shield_loading: u64,
}

#[event]
pub struct BookVoided {
    pub book: Pubkey,
    pub legs: u32,
    pub escrowed: u64,
}

#[event]
pub struct BookLegRemoved {
    pub book: Pubkey,
    pub obligation: Pubkey,
    /// true: the owner released it (owner precedence); false: the unsealed book was voided.
    pub released_by_owner: bool,
    pub refund: u64,
    /// false when the gap factors changed since the leg was added: its reservation stayed in the group.
    pub reservation_freed: bool,
}

#[event]
pub struct BookRefundClaimed {
    pub book: Pubkey,
    pub escrow: u64,
    pub refund: u64,
    pub refunded_total: u64,
}
