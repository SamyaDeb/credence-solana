//! Monday Backstop (W2): the vault liquidates unhealthy xStock positions itself at the move, holds the collateral as
//! inventory and resells it through a Dutch auction.
//!
//! - `init_backstop` / `set_backstop_params` (admin): the pool's caps and the auction's shape.
//! - `init_inventory` (admin): one `Inventory` per xStock, holding units in the vault PDA's ATAs.
//! - `backstop_liquidate(repay_amount, min_received)` (keeper; any unhealthy obligation of the two xStocks markets):
//!   the caller's transaction refreshes both reserves and the obligation, then the program calls klend's
//!   `liquidate_obligation_and_redeem_reserve_collateral_v2` with the **vault PDA** as liquidator (PDA-signed CPI,
//!   proven on the fork, `b5a0318`). klend decides whether the obligation is liquidatable, the close factor and the bonus.
//!   USDC spent and units received are measured before and after.
//! - `mark_inventory` (anyone): the NAV mark, Scope × (1 − haircut), rounded down.
//! - `start_sale` (keeper) / `buy_from_sale` (anyone) / `close_sale` (keeper; anyone after the decay): a Dutch auction
//!   from Scope × (1 + p0) down to Scope × (1 − d_max) over T, partial fills, unsold units stay for the next sale.
//!   Never Jupiter: klend restricts Jupiter's program in its transactions (`RESTRICTED_PROGRAMS`), and a sale never
//!   touches klend, so resale is always its own transaction.
//!
//! Invariants:
//! - **INV-8** (EVM Credence bug 2): the vault never takes collateral it did not fully pay for. Units received ≤ what
//!   the USDC spent buys at the committed price Scope × (1 − κ) (`risk-core::paid_for_qty`), every cToken is redeemed
//!   in the same instruction, and only measured units are booked.
//! - **INV-13**: the backstop never spends the cash kept for live cover groups and queues
//!   (`Vault::reserved_cash`: reserved worst-case losses + unearned premiums + queued deposits), and its open
//!   inventory at cost stays ≤ `max_share × equity`. Inventory never backs cover (`Vault::cover_equity`).
//!
//! Accounting: a purchase turns cash into inventory at cost (equity unchanged). A sale realises
//! `proceeds − cost basis of the units sold` into equity (`risk-core::cost_portion`, rounded UP, so P&L is never
//! flattered). NAV for share prices marks open inventory at Scope × (1 − haircut) (`Vault::nav`).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Mint as MintInterface, TokenAccount as TokenAccountInterface, TransferChecked};
use credence_risk_core::{cost_portion, dutch_price, inventory_mark, lot_cost, paid_for_qty, U256};

use crate::instructions::settle::INSTRUCTIONS_SYSVAR_ID;
use crate::kamino::{
    liquidate_obligation_and_redeem_reserve_collateral_v2, LiquidateV2, ObligationView, ReserveView, KLEND_PROGRAM_ID,
    XSTOCKS_MARKETS,
};
use crate::math::WAD;
use crate::oracle::scope;
use crate::state::*;
use crate::token22::require_transferable;
use crate::CoreError;

/// USDC decimals.
const USDC_DECIMALS: u32 = 6;

/// `10^(18 + token_decimals − 6)`: `qty × price_wad / scale` is USDC base units.
pub fn value_scale(token_decimals: u8) -> Result<u128> {
    let e = 18u32.checked_add(token_decimals as u32).and_then(|x| x.checked_sub(USDC_DECIMALS)).ok_or(CoreError::Math)?;
    10u128.checked_pow(e).ok_or_else(|| error!(CoreError::Math))
}

/// Backstop parameters (admin), WAD unless noted.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BackstopParams {
    pub max_share_wad: u64,
    pub haircut_wad: u64,
    pub max_discount_wad: u64,
    pub sale_premium_wad: u64,
    pub sale_discount_wad: u64,
    pub sale_secs: u32,
    pub max_price_age_secs: u32,
}

impl BackstopParams {
    fn validate(&self) -> Result<()> {
        let one = WAD as u64;
        // A share of at most half the vault; a haircut, a committed discount and an auction floor below 50%; an
        // auction start at most +20% over Scope, decaying over 1 minute to 7 days; Scope prices at most 10 minutes old.
        require!(self.max_share_wad <= one / 2, CoreError::InvalidParam);
        require!(self.haircut_wad < one / 2 && self.max_discount_wad < one / 2, CoreError::InvalidParam);
        require!(self.sale_discount_wad < one / 2 && self.sale_premium_wad <= one / 5, CoreError::InvalidParam);
        require!(self.sale_secs >= 60 && self.sale_secs <= 7 * 86_400, CoreError::InvalidParam);
        require!(self.max_price_age_secs > 0 && self.max_price_age_secs <= 600, CoreError::InvalidParam);
        Ok(())
    }

    fn apply(&self, p: &mut BackstopPool) {
        p.max_share_wad = self.max_share_wad;
        p.haircut_wad = self.haircut_wad;
        p.max_discount_wad = self.max_discount_wad;
        p.sale_premium_wad = self.sale_premium_wad;
        p.sale_discount_wad = self.sale_discount_wad;
        p.sale_secs = self.sale_secs;
        p.max_price_age_secs = self.max_price_age_secs;
    }
}

#[derive(Accounts)]
pub struct InitBackstop<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = BackstopPool::SIZE, seeds = [SEED_BACKSTOP], bump)]
    pub pool: Box<Account<'info, BackstopPool>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_backstop(ctx: Context<InitBackstop>, params: BackstopParams) -> Result<()> {
    params.validate()?;
    let p = &mut ctx.accounts.pool;
    params.apply(p);
    p.bump = ctx.bumps.pool;
    Ok(())
}

#[derive(Accounts)]
pub struct SetBackstopParams<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_BACKSTOP], bump = pool.bump)]
    pub pool: Box<Account<'info, BackstopPool>>,
}

pub fn handle_set_backstop_params(ctx: Context<SetBackstopParams>, params: BackstopParams) -> Result<()> {
    params.validate()?;
    params.apply(&mut ctx.accounts.pool);
    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct InitInventory<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(init, payer = admin, space = Inventory::SIZE, seeds = [SEED_INVENTORY, ticker.as_ref()], bump)]
    pub inventory: Box<Account<'info, Inventory>>,
    /// CHECK: one of the asset's Kamino reserves (checked); decoded for its cToken mint.
    pub reserve: UncheckedAccount<'info>,
    /// The vault PDA's ATA for the xStock (Token-2022; created by the client, checked here).
    #[account(
        associated_token::mint = asset.load()?.mint, associated_token::authority = vault,
        associated_token::token_program = token_2022_program,
    )]
    pub tokens: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    /// The vault PDA's ATA for the reserve's cToken mint (SPL Token).
    #[account(token::authority = vault, token::token_program = token_program)]
    pub ctokens: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_inventory(ctx: Context<InitInventory>, ticker: Ticker) -> Result<()> {
    let a = ctx.accounts.asset.load()?;
    require!(a.kamino_reserves.contains(ctx.accounts.reserve.key) && *ctx.accounts.reserve.key != Pubkey::default(), CoreError::InvalidParam);
    let r = ReserveView::load(&ctx.accounts.reserve)?;
    require_keys_eq!(r.liquidity_mint, a.mint, CoreError::InvalidParam);
    let want = get_associated_token_address_with_program_id(&ctx.accounts.vault.key(), &r.collateral_mint, &Token::id());
    require_keys_eq!(ctx.accounts.ctokens.key(), want, CoreError::InvalidParam);
    require_keys_eq!(ctx.accounts.ctokens.mint, r.collateral_mint, CoreError::InvalidParam);
    let inv = &mut ctx.accounts.inventory;
    inv.ticker = ticker;
    inv.mint = a.mint;
    inv.tokens = ctx.accounts.tokens.key();
    inv.ctokens = ctx.accounts.ctokens.key();
    inv.bump = ctx.bumps.inventory;
    Ok(())
}

#[derive(Accounts)]
pub struct BackstopLiquidate<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.keeper == keeper.key() @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_BACKSTOP], bump = pool.bump)]
    pub pool: Box<Account<'info, BackstopPool>>,
    #[account(seeds = [SEED_ASSET, inventory.ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(mut, seeds = [SEED_INVENTORY, inventory.ticker.as_ref()], bump = inventory.bump)]
    pub inventory: Box<Account<'info, Inventory>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = inventory.tokens @ CoreError::InvalidParam)]
    pub inv_tokens: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    /// The vault PDA's ATA for the withdraw reserve's cToken mint (checked in the handler): each xStocks market's
    /// reserve has its own cToken mint (audit A-35).
    #[account(mut, token::authority = vault, token::token_program = token_program)]
    pub inv_ctokens: Box<Account<'info, TokenAccount>>,
    /// CHECK: Kamino's Scope `OraclePrices` (address and owner checked in `scope::read`).
    pub scope_prices: UncheckedAccount<'info>,
    /// CHECK: klend `Obligation` (owner, discriminator, market checked); klend validates the rest.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: one of the two xStocks markets (checked).
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: `["lma", market]` under klend (klend checks).
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: a USDC reserve of the market (decoded and checked).
    #[account(mut)]
    pub repay_reserve: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ CoreError::InvalidParam)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: the repay reserve's supply vault (checked against the decoded reserve).
    #[account(mut)]
    pub repay_reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: the asset's reserve in this market (checked).
    #[account(mut)]
    pub withdraw_reserve: UncheckedAccount<'info>,
    #[account(address = inventory.mint @ CoreError::InvalidParam)]
    pub xstock_mint: Box<InterfaceAccount<'info, MintInterface>>,
    /// CHECK: the withdraw reserve's cToken mint (checked).
    #[account(mut)]
    pub withdraw_reserve_collateral_mint: UncheckedAccount<'info>,
    /// CHECK: checked against the decoded reserve.
    #[account(mut)]
    pub withdraw_reserve_collateral_supply: UncheckedAccount<'info>,
    /// CHECK: checked against the decoded reserve.
    #[account(mut)]
    pub withdraw_reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: checked against the decoded reserve.
    #[account(mut)]
    pub withdraw_reserve_liquidity_fee_receiver: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    /// CHECK: instructions sysvar (address checked).
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
    /// CHECK: farm slots (klend checks); the klend program id when the reserve has no farm. Not `mut` (A-21).
    pub collateral_farm_user_state: UncheckedAccount<'info>,
    /// CHECK: as above.
    pub collateral_farm_state: UncheckedAccount<'info>,
    /// CHECK: as above.
    pub debt_farm_user_state: UncheckedAccount<'info>,
    /// CHECK: as above.
    pub debt_farm_state: UncheckedAccount<'info>,
    /// CHECK: program id checked in the CPI helper.
    pub farms_program: UncheckedAccount<'info>,
    /// CHECK: program id checked in the CPI helper.
    pub klend_program: UncheckedAccount<'info>,
}

/// Liquidates up to `repay_amount` USDC of an unhealthy obligation's debt through the vault PDA and books the redeemed
/// xStock as inventory. `min_received` (raw units) is passed to klend as slippage protection.
pub fn handle_backstop_liquidate<'info>(
    ctx: Context<'info, BackstopLiquidate<'info>>,
    repay_amount: u64,
    min_received: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    require!(repay_amount > 0, CoreError::InvalidParam);
    let a = &ctx.accounts;
    let now = Clock::get()?.unix_timestamp;

    // Accounts: market allow-listed and the obligation's; the asset's reserve in this market; a USDC repay reserve.
    let market_idx = XSTOCKS_MARKETS.iter().position(|m| m == a.lending_market.key).ok_or(CoreError::MarketNotAllowed)?;
    let ob = ObligationView::load(&a.obligation)?;
    require_keys_eq!(ob.lending_market, *a.lending_market.key, CoreError::MarketNotAllowed);
    let (asset_mint, asset_reserve, chain) = {
        let asset = a.asset.load()?;
        (asset.mint, asset.kamino_reserves[market_idx], asset.scope_chain)
    };
    require_keys_eq!(*a.withdraw_reserve.key, asset_reserve, CoreError::InvalidParam);
    let wr = ReserveView::load(&a.withdraw_reserve)?;
    require!(wr.lending_market == ob.lending_market && wr.liquidity_mint == asset_mint, CoreError::InvalidParam);
    require_keys_eq!(*a.withdraw_reserve_collateral_mint.key, wr.collateral_mint, CoreError::InvalidParam);
    require_keys_eq!(a.inv_ctokens.mint, wr.collateral_mint, CoreError::InvalidParam);
    let want = get_associated_token_address_with_program_id(&a.vault.key(), &wr.collateral_mint, &Token::id());
    require_keys_eq!(a.inv_ctokens.key(), want, CoreError::InvalidParam); // A-35
    require_keys_eq!(*a.withdraw_reserve_collateral_supply.key, wr.collateral_supply_vault, CoreError::InvalidParam);
    require_keys_eq!(*a.withdraw_reserve_liquidity_supply.key, wr.supply_vault, CoreError::InvalidParam);
    require_keys_eq!(*a.withdraw_reserve_liquidity_fee_receiver.key, wr.fee_vault, CoreError::InvalidParam);
    let rr = ReserveView::load(&a.repay_reserve)?;
    require!(rr.lending_market == ob.lending_market && rr.liquidity_mint == a.config.usdc_mint, CoreError::InvalidParam);
    require_keys_eq!(*a.repay_reserve_liquidity_supply.key, rr.supply_vault, CoreError::InvalidParam);
    // Token-2022: refuse a paused mint or a transfer hook (the redeem transfers the xStock to the vault).
    require_transferable(&a.xstock_mint.to_account_info().try_borrow_data()?)?;

    // The price klend liquidates on (refreshed in this transaction), for INV-8 and the mark.
    let px = scope::read(&a.scope_prices, chain)?;
    require!(now.saturating_sub(px.unix_timestamp) <= a.pool.max_price_age_secs as i64, CoreError::StalePrice);

    // INV-13 before the CPI, on the most klend may take: cash kept for live groups and queues is never spent, and the
    // open inventory at cost stays within the pool's share of equity.
    let cash = a.vault_usdc.amount;
    let reserved = a.vault.reserved_cash()?;
    require!(cash.checked_sub(repay_amount).is_some_and(|left| left >= reserved), CoreError::BackstopBudget);
    let share_cap = (a.vault.equity as u128) * (a.pool.max_share_wad as u128) / WAD;
    let open_after = (a.vault.inventory_cost()? as u128).checked_add(repay_amount as u128).ok_or(CoreError::Math)?;
    require!(open_after <= share_cap, CoreError::BackstopBudget);

    let (usdc0, x0, c0) = (cash, a.inv_tokens.amount, a.inv_ctokens.amount);
    let seeds: &[&[u8]] = &[SEED_VAULT, &[a.vault.bump]];
    let opt = |x: &UncheckedAccount<'info>| if *x.key == KLEND_PROGRAM_ID { None } else { Some(x.to_account_info()) };
    let (cu, cs, du, ds) = (
        opt(&a.collateral_farm_user_state),
        opt(&a.collateral_farm_state),
        opt(&a.debt_farm_user_state),
        opt(&a.debt_farm_state),
    );
    liquidate_obligation_and_redeem_reserve_collateral_v2(
        &LiquidateV2 {
            liquidator: &a.vault.to_account_info(),
            obligation: a.obligation.as_ref(),
            lending_market: a.lending_market.as_ref(),
            lending_market_authority: a.lending_market_authority.as_ref(),
            repay_reserve: a.repay_reserve.as_ref(),
            repay_reserve_liquidity_mint: &a.usdc_mint.to_account_info(),
            repay_reserve_liquidity_supply: a.repay_reserve_liquidity_supply.as_ref(),
            withdraw_reserve: a.withdraw_reserve.as_ref(),
            withdraw_reserve_liquidity_mint: &a.xstock_mint.to_account_info(),
            withdraw_reserve_collateral_mint: a.withdraw_reserve_collateral_mint.as_ref(),
            withdraw_reserve_collateral_supply: a.withdraw_reserve_collateral_supply.as_ref(),
            withdraw_reserve_liquidity_supply: a.withdraw_reserve_liquidity_supply.as_ref(),
            withdraw_reserve_liquidity_fee_receiver: a.withdraw_reserve_liquidity_fee_receiver.as_ref(),
            user_source_liquidity: &a.vault_usdc.to_account_info(),
            user_destination_collateral: &a.inv_ctokens.to_account_info(),
            user_destination_liquidity: &a.inv_tokens.to_account_info(),
            collateral_token_program: a.token_program.as_ref(),
            repay_liquidity_token_program: a.token_program.as_ref(),
            withdraw_liquidity_token_program: a.token_2022_program.as_ref(),
            instruction_sysvar: a.instruction_sysvar.as_ref(),
            collateral_farm_user_state: cu.as_ref(),
            collateral_farm_state: cs.as_ref(),
            debt_farm_user_state: du.as_ref(),
            debt_farm_state: ds.as_ref(),
            farms_program: a.farms_program.as_ref(),
            klend_program: a.klend_program.as_ref(),
        },
        repay_amount,
        min_received,
        &[seeds],
    )?;

    let a = &mut *ctx.accounts;
    a.vault_usdc.reload()?;
    a.inv_tokens.reload()?;
    a.inv_ctokens.reload()?;
    let spent = usdc0.checked_sub(a.vault_usdc.amount).ok_or(CoreError::Math)?;
    let received = a.inv_tokens.amount.checked_sub(x0).ok_or(CoreError::Math)?;
    require!(spent > 0 && spent <= repay_amount && received > 0, CoreError::NothingLiquidated);
    // Every cToken was redeemed: the vault holds no collateral it did not turn into units here (INV-8).
    require!(a.inv_ctokens.amount == c0, CoreError::Inv8);
    // INV-8: units received ≤ what `spent` buys at the committed price Scope × (1 − κ).
    let scale = value_scale(a.xstock_mint.decimals)?;
    let bound = paid_for_qty(spent, px.price_wad, a.pool.max_discount_wad, scale).map_err(|_| error!(CoreError::Math))?;
    require!(received <= bound, CoreError::Inv8);

    let inv = &mut a.inventory;
    inv.qty = inv.qty.checked_add(received).ok_or(CoreError::Math)?;
    inv.cost = inv.cost.checked_add(spent).ok_or(CoreError::Math)?;
    inv.bought = inv.bought.checked_add(received).ok_or(CoreError::Math)?;
    let mark = inventory_mark(inv.qty, px.price_wad, a.pool.haircut_wad, scale).map_err(|_| error!(CoreError::Math))?;
    let (qty, cost, ticker) = (inv.qty, inv.cost, inv.ticker);
    let value = lot_cost(qty, px.price_wad, scale).map_err(|_| error!(CoreError::Math))?;
    let slot = a.vault.inv_slot(&ticker)?;
    slot.cost = cost;
    slot.mark = mark;
    slot.value = value;
    slot.marked_at = now;
    // INV-13 after, on what klend actually took.
    require!(a.vault_usdc.amount >= a.vault.reserved_cash()?, CoreError::BackstopBudget);
    require!(a.vault.inventory_cost()? as u128 <= share_cap, CoreError::BackstopBudget);
    let p = &mut a.pool;
    p.spent = p.spent.checked_add(spent).ok_or(CoreError::Math)?;
    p.liquidations = p.liquidations.checked_add(1).ok_or(CoreError::Math)?;
    emit!(BackstopLiquidated {
        obligation: a.obligation.key(),
        ticker,
        spent,
        received,
        price_wad: px.price_wad,
        inventory_qty: qty,
        inventory_cost: cost,
        mark,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct MarkInventory<'info> {
    #[account(seeds = [SEED_BACKSTOP], bump = pool.bump)]
    pub pool: Box<Account<'info, BackstopPool>>,
    #[account(seeds = [SEED_ASSET, inventory.ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(seeds = [SEED_INVENTORY, inventory.ticker.as_ref()], bump = inventory.bump)]
    pub inventory: Box<Account<'info, Inventory>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(address = inventory.mint @ CoreError::InvalidParam)]
    pub xstock_mint: Box<InterfaceAccount<'info, MintInterface>>,
    /// CHECK: Kamino's Scope `OraclePrices` (checked in `scope::read`).
    pub scope_prices: UncheckedAccount<'info>,
}

/// Marks one xStock's inventory for NAV (anyone): `qty × Scope × (1 − haircut)`, rounded down.
pub fn handle_mark_inventory(ctx: Context<MarkInventory>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let chain = ctx.accounts.asset.load()?.scope_chain;
    let px = scope::read(&ctx.accounts.scope_prices, chain)?;
    require!(now.saturating_sub(px.unix_timestamp) <= ctx.accounts.pool.max_price_age_secs as i64, CoreError::StalePrice);
    let inv = &ctx.accounts.inventory;
    let scale = value_scale(ctx.accounts.xstock_mint.decimals)?;
    let mark = inventory_mark(inv.qty, px.price_wad, ctx.accounts.pool.haircut_wad, scale).map_err(|_| error!(CoreError::Math))?;
    let value = lot_cost(inv.qty, px.price_wad, scale).map_err(|_| error!(CoreError::Math))?;
    let (ticker, cost, qty) = (inv.ticker, inv.cost, inv.qty);
    let slot = ctx.accounts.vault.inv_slot(&ticker)?;
    slot.cost = cost;
    slot.mark = mark;
    slot.value = value;
    slot.marked_at = now;
    emit!(InventoryMarked { ticker, qty, cost, mark, price_wad: px.price_wad });
    Ok(())
}

#[derive(Accounts)]
pub struct StartSale<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.keeper == keeper.key() @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_BACKSTOP], bump = pool.bump)]
    pub pool: Box<Account<'info, BackstopPool>>,
    #[account(seeds = [SEED_ASSET, inventory.ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(mut, seeds = [SEED_INVENTORY, inventory.ticker.as_ref()], bump = inventory.bump)]
    pub inventory: Box<Account<'info, Inventory>>,
    /// CHECK: Kamino's Scope `OraclePrices` (checked in `scope::read`).
    pub scope_prices: UncheckedAccount<'info>,
}

/// Opens a Dutch auction of `lot` units: from Scope × (1 + p0) to Scope × (1 − d_max) over `sale_secs` (keeper).
pub fn handle_start_sale(ctx: Context<StartSale>, lot: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let chain = ctx.accounts.asset.load()?.scope_chain;
    let p = &ctx.accounts.pool;
    let px = scope::read(&ctx.accounts.scope_prices, chain)?;
    require!(now.saturating_sub(px.unix_timestamp) <= p.max_price_age_secs as i64, CoreError::StalePrice);
    let inv = &mut ctx.accounts.inventory;
    require!(inv.sale_active == 0, CoreError::SaleState);
    require!(lot > 0 && lot <= inv.qty, CoreError::InvalidParam);
    // Start rounds UP, floor rounds UP: the buyer pays more. 256-bit: a WAD price times a WAD factor overflows 128 bits.
    let w = U256::from(WAD);
    let scaled = |f: u128| u128::try_from((U256::from(px.price_wad) * U256::from(f)).div_ceil(w)).map_err(|_| error!(CoreError::Math));
    let start = scaled(WAD + p.sale_premium_wad as u128)?;
    let floor = scaled(WAD - p.sale_discount_wad as u128)?;
    inv.sale_active = 1;
    inv.lot_left = lot;
    inv.start_price_wad = start;
    inv.floor_price_wad = floor;
    inv.sale_started_at = now;
    inv.sale_secs = p.sale_secs;
    emit!(SaleStarted { ticker: inv.ticker, lot, start_price_wad: start, floor_price_wad: floor, sale_secs: p.sale_secs });
    Ok(())
}

#[derive(Accounts)]
pub struct BuyFromSale<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_BACKSTOP], bump = pool.bump)]
    pub pool: Box<Account<'info, BackstopPool>>,
    #[account(mut, seeds = [SEED_INVENTORY, inventory.ticker.as_ref()], bump = inventory.bump)]
    pub inventory: Box<Account<'info, Inventory>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = inventory.tokens @ CoreError::InvalidParam)]
    pub inv_tokens: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    #[account(address = inventory.mint @ CoreError::InvalidParam)]
    pub xstock_mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,
    /// Receives the units: any xStock account (Token-2022) of the buyer's choosing.
    #[account(mut, token::mint = xstock_mint, token::token_program = token_2022_program)]
    pub buyer_tokens: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Buys `qty` raw units at the auction's current price (anyone), paying at most `max_price_wad` per whole token.
/// Partial fills: the lot shrinks by `qty`. Realises `proceeds − cost basis of the units` into equity.
pub fn handle_buy_from_sale(ctx: Context<BuyFromSale>, qty: u64, max_price_wad: u128) -> Result<()> {
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    require_transferable(&ctx.accounts.xstock_mint.to_account_info().try_borrow_data()?)?;
    let now = Clock::get()?.unix_timestamp;
    let inv = &ctx.accounts.inventory;
    require!(inv.sale_active == 1, CoreError::SaleState);
    require!(qty > 0 && qty <= inv.lot_left && qty <= inv.qty, CoreError::InvalidParam);
    let price = dutch_price(inv.start_price_wad, inv.floor_price_wad, inv.sale_started_at, inv.sale_secs as i64, now)
        .map_err(|_| error!(CoreError::Math))?;
    require!(price <= max_price_wad, CoreError::PriceAboveMax);
    let decimals = ctx.accounts.xstock_mint.decimals;
    let proceeds = lot_cost(qty, price, value_scale(decimals)?).map_err(|_| error!(CoreError::Math))?;
    require!(proceeds > 0, CoreError::InvalidParam);
    let basis = cost_portion(inv.cost, inv.qty, qty).map_err(|_| error!(CoreError::Math))?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.buyer_usdc.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        proceeds,
    )?;
    let seeds: &[&[u8]] = &[SEED_VAULT, &[ctx.accounts.vault.bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            TransferChecked {
                from: ctx.accounts.inv_tokens.to_account_info(),
                mint: ctx.accounts.xstock_mint.to_account_info(),
                to: ctx.accounts.buyer_tokens.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        qty,
        decimals,
    )?;

    let a = &mut *ctx.accounts;
    let inv = &mut a.inventory;
    // The mark of the units sold leaves NAV with them, rounded UP (what stays marked is never above the old mark).
    let (ticker, qty_before) = (inv.ticker, inv.qty);
    inv.qty -= qty;
    inv.cost -= basis;
    inv.lot_left -= qty;
    inv.sold = inv.sold.checked_add(qty).ok_or(CoreError::Math)?;
    if inv.lot_left == 0 || inv.qty == 0 {
        inv.sale_active = 0;
    }
    let (cost_left, qty_left) = (inv.cost, inv.qty);
    let slot = a.vault.inv_slot(&ticker)?;
    let mark_out = cost_portion(slot.mark, qty_before, qty).map_err(|_| error!(CoreError::Math))?;
    slot.mark -= mark_out;
    // The full value leaving with the units, rounded DOWN (what stays priced for deposits is never below its share).
    let value_out = u64::try_from((slot.value as u128) * (qty as u128) / (qty_before as u128)).map_err(|_| CoreError::Math)?;
    slot.value -= value_out;
    slot.cost = cost_left;
    if qty_left == 0 {
        *slot = InvSlot::default();
    }
    // Realised P&L into equity: proceeds − basis (the cash came in, the basis left the inventory).
    let v = &mut a.vault;
    let pnl = (proceeds as i128) - (basis as i128);
    v.equity = if pnl >= 0 {
        v.equity.checked_add(pnl as u64).ok_or(CoreError::Math)?
    } else {
        v.equity.checked_sub((-pnl) as u64).ok_or(CoreError::VaultInsolvent)?
    };
    let p = &mut a.pool;
    p.sales_proceeds = p.sales_proceeds.checked_add(proceeds).ok_or(CoreError::Math)?;
    p.realized_pnl = p.realized_pnl.checked_add(i64::try_from(pnl).map_err(|_| CoreError::Math)?).ok_or(CoreError::Math)?;
    p.fills = p.fills.checked_add(1).ok_or(CoreError::Math)?;
    emit!(SaleFilled { ticker, buyer: a.buyer.key(), qty, price_wad: price, proceeds, cost_basis: basis, pnl: pnl as i64 });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseSale<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_INVENTORY, inventory.ticker.as_ref()], bump = inventory.bump)]
    pub inventory: Box<Account<'info, Inventory>>,
}

/// Ends the sale: the keeper any time, anyone once the decay is over. Unsold units stay in the inventory for the next
/// `start_sale`. Not gated by `paused` (it reduces nothing but an offer).
pub fn handle_close_sale(ctx: Context<CloseSale>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let inv = &mut ctx.accounts.inventory;
    require!(inv.sale_active == 1, CoreError::SaleState);
    let ended = now >= inv.sale_started_at.saturating_add(inv.sale_secs as i64);
    require!(ended || ctx.accounts.caller.key() == ctx.accounts.config.keeper, CoreError::Unauthorized);
    inv.sale_active = 0;
    let unsold = inv.lot_left;
    inv.lot_left = 0;
    emit!(SaleClosed { ticker: inv.ticker, unsold });
    Ok(())
}

#[event]
pub struct BackstopLiquidated {
    pub obligation: Pubkey,
    pub ticker: Ticker,
    /// USDC the vault paid klend.
    pub spent: u64,
    /// Raw xStock units redeemed into the inventory.
    pub received: u64,
    pub price_wad: u128,
    pub inventory_qty: u64,
    pub inventory_cost: u64,
    pub mark: u64,
}

#[event]
pub struct InventoryMarked {
    pub ticker: Ticker,
    pub qty: u64,
    pub cost: u64,
    pub mark: u64,
    pub price_wad: u128,
}

#[event]
pub struct SaleStarted {
    pub ticker: Ticker,
    pub lot: u64,
    pub start_price_wad: u128,
    pub floor_price_wad: u128,
    pub sale_secs: u32,
}

#[event]
pub struct SaleFilled {
    pub ticker: Ticker,
    pub buyer: Pubkey,
    pub qty: u64,
    pub price_wad: u128,
    pub proceeds: u64,
    pub cost_basis: u64,
    pub pnl: i64,
}

#[event]
pub struct SaleClosed {
    pub ticker: Ticker,
    pub unsold: u64,
}
