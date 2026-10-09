//! Underwriter vault: init, deposits and LP shares (task 2.1); queued deposits and withdrawals (task 3.1).
//!
//! USDC is a classic SPL Token mint; the vault's USDC account, the share mint and the share escrow are PDAs owned by
//! the SPL Token program with the vault PDA as authority. Share prices always use `vault.equity`, never the token
//! balance.
//!
//! Epoch-gated liquidity (INV-5, INV-6):
//! - `deposit` is immediate only while no group is live. Otherwise `request_deposit` moves the USDC into the vault as
//!   `queued_deposits` (not equity: it neither backs cover nor earns this weekend's premiums).
//! - `request_withdraw` moves the LP's shares into the escrow. They keep their claim on equity, so they still bear the
//!   live groups' losses and earn their premiums, but new cover is sized without them (`math::free_equity`).
//! - Each request waits for the newest group live at the time (`QueueTicket.wait_group`); `process_deposit` /
//!   `process_withdrawal` (anyone; the keeper's `process_queues` job) apply it at the NAV of the moment once no group
//!   up to that one is live, i.e. after it settled or was voided. Rounding is against the LP.
//! - While the protocol is paused, deposits (direct, queued and the processing of queued ones) are refused; withdrawal
//!   requests and processing are not.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::instructions::settle::pay_from_vault;
use crate::math::{deposit_shares, usdc_for_shares, LOCKED_SHARES, WAD};
use crate::state::*;
use crate::CoreError;

/// LP share decimals (same as USDC, so the first deposit mints 1:1).
pub const SHARE_DECIMALS: u8 = 6;

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = Vault::SIZE, seeds = [SEED_VAULT], bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        init, payer = admin, seeds = [SEED_VAULT_USDC], bump,
        token::mint = usdc_mint, token::authority = vault, token::token_program = token_program
    )]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(
        init, payer = admin, seeds = [SEED_SHARES], bump,
        mint::decimals = SHARE_DECIMALS, mint::authority = vault, mint::token_program = token_program
    )]
    pub share_mint: Account<'info, Mint>,
    #[account(
        init, payer = admin, seeds = [SEED_SHARE_ESCROW], bump,
        token::mint = share_mint, token::authority = vault, token::token_program = token_program
    )]
    pub share_escrow: Account<'info, TokenAccount>,
    #[account(address = config.usdc_mint @ CoreError::InvalidParam, mint::token_program = token_program)]
    pub usdc_mint: Account<'info, Mint>,
    /// Protocol fee destination: any USDC account.
    #[account(token::mint = usdc_mint, token::token_program = token_program)]
    pub fee_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_vault(ctx: Context<InitVault>) -> Result<()> {
    let v = &mut ctx.accounts.vault;
    v.usdc = ctx.accounts.vault_usdc.key();
    v.share_mint = ctx.accounts.share_mint.key();
    v.fee_account = ctx.accounts.fee_account.key();
    v.share_escrow = ctx.accounts.share_escrow.key();
    v.bump = ctx.bumps.vault;
    v.usdc_bump = ctx.bumps.vault_usdc;
    v.mint_bump = ctx.bumps.share_mint;
    v.escrow_bump = ctx.bumps.share_escrow;
    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Account<'info, Mint>,
    #[account(
        mut, token::mint = config.usdc_mint, token::authority = depositor, token::token_program = token_program
    )]
    pub depositor_usdc: Account<'info, TokenAccount>,
    /// Receives the shares (any owner; the depositor chooses).
    #[account(mut, token::mint = share_mint, token::token_program = token_program)]
    pub depositor_shares: Account<'info, TokenAccount>,
    /// Receives the locked shares of the vault's first deposit (`math::LOCKED_SHARES`).
    #[account(mut, address = vault.share_escrow @ CoreError::InvalidParam)]
    pub share_escrow: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Deposits `amount` USDC and mints shares at NAV (first deposit 1:1, with `LOCKED_SHARES` of it locked in the escrow),
/// rounded down. Only while no group is live: deposits during a live weekend are queued (task 3.1, INV-6), so an LP
/// cannot join after seeing the risk.
pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, CoreError::InvalidParam);
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    let v = &ctx.accounts.vault;
    require!(v.live_groups == 0, CoreError::VaultLocked);
    let supply = ctx.accounts.share_mint.supply;
    require!(supply > 0 || amount > LOCKED_SHARES, CoreError::InvalidParam);
    // At NAV: book equity with the backstop's inventory at its fresh mark (W2).
    let nav = v.nav_for_deposit(Clock::get()?.unix_timestamp)?; // inventory at full value (A-36)
    let (shares, locked) = deposit_shares(amount, nav, supply).ok_or(CoreError::Math)?;
    require!(shares > 0, CoreError::InvalidParam);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.depositor_usdc.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;
    let seeds: &[&[u8]] = &[SEED_VAULT, &[v.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.depositor_shares.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        shares,
    )?;
    mint_locked(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.share_mint, &ctx.accounts.share_escrow, locked)?;
    let v = &mut ctx.accounts.vault;
    v.equity = v.equity.checked_add(amount).ok_or(CoreError::Math)?;
    let supply = supply.checked_add(shares).and_then(|s| s.checked_add(locked)).ok_or(CoreError::Math)?;
    emit!(Deposited { depositor: ctx.accounts.depositor.key(), amount, shares, equity: v.equity, supply });
    Ok(())
}

/// Mints the first deposit's locked shares into the vault's escrow (no-op for 0).
fn mint_locked<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, Vault>,
    share_mint: &Account<'info, Mint>,
    share_escrow: &Account<'info, TokenAccount>,
    locked: u64,
) -> Result<()> {
    if locked == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[SEED_VAULT, &[vault.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.key(),
            MintTo { mint: share_mint.to_account_info(), to: share_escrow.to_account_info(), authority: vault.to_account_info() },
            &[seeds],
        ),
        locked,
    )
}

/// Minimum queued deposit (1 USDC), so a ticket always mints at least one share at any sane NAV.
pub const MIN_QUEUED_DEPOSIT: u64 = 1_000_000;

#[derive(Accounts)]
pub struct RequestDeposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(
        mut, token::mint = config.usdc_mint, token::authority = depositor, token::token_program = token_program
    )]
    pub depositor_usdc: Account<'info, TokenAccount>,
    #[account(
        init_if_needed, payer = depositor, space = QueueTicket::SIZE,
        seeds = [SEED_DEPOSIT_TICKET, depositor.key().as_ref(), &vault.newest_live().to_le_bytes()], bump
    )]
    pub ticket: Account<'info, QueueTicket>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Queues a deposit of `amount` USDC until every group live now has settled. The USDC moves into the vault at once
/// (`queued_deposits`, not equity).
pub fn handle_request_deposit(ctx: Context<RequestDeposit>, amount: u64) -> Result<()> {
    require!(amount >= MIN_QUEUED_DEPOSIT, CoreError::InvalidParam);
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.depositor_usdc.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;
    let wait_group = ctx.accounts.vault.newest_live();
    let v = &mut ctx.accounts.vault;
    v.queued_deposits = v.queued_deposits.checked_add(amount).ok_or(CoreError::Math)?;
    let t = &mut ctx.accounts.ticket;
    open_ticket(t, ctx.accounts.depositor.key(), wait_group, ticket_kind::DEPOSIT, ctx.bumps.ticket)?;
    t.amount = t.amount.checked_add(amount).ok_or(CoreError::Math)?;
    emit!(QueueRequested { owner: t.owner, kind: t.kind, wait_group, amount, total: t.amount });
    Ok(())
}

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Account<'info, Mint>,
    #[account(mut, address = vault.share_escrow @ CoreError::InvalidParam)]
    pub share_escrow: Account<'info, TokenAccount>,
    #[account(mut, token::mint = share_mint, token::authority = owner, token::token_program = token_program)]
    pub owner_shares: Account<'info, TokenAccount>,
    #[account(
        init_if_needed, payer = owner, space = QueueTicket::SIZE,
        seeds = [SEED_WITHDRAW_TICKET, owner.key().as_ref(), &vault.newest_live().to_le_bytes()], bump
    )]
    pub ticket: Account<'info, QueueTicket>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Queues the redemption of `shares`: they move to the escrow now and are paid at the NAV after every group live now
/// has settled (INV-6). With no live group the ticket can be processed at once.
pub fn handle_request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
    require!(shares > 0, CoreError::InvalidParam);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_shares.to_account_info(),
                to: ctx.accounts.share_escrow.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        shares,
    )?;
    let wait_group = ctx.accounts.vault.newest_live();
    let v = &mut ctx.accounts.vault;
    v.queued_withdraw_shares = v.queued_withdraw_shares.checked_add(shares).ok_or(CoreError::Math)?;
    let t = &mut ctx.accounts.ticket;
    open_ticket(t, ctx.accounts.owner.key(), wait_group, ticket_kind::WITHDRAW, ctx.bumps.ticket)?;
    t.amount = t.amount.checked_add(shares).ok_or(CoreError::Math)?;
    emit!(QueueRequested { owner: t.owner, kind: t.kind, wait_group, amount: shares, total: t.amount });
    Ok(())
}

/// Initialises a fresh ticket, or checks an existing one (same owner, kind and wait group; `init_if_needed` reuse).
fn open_ticket(t: &mut QueueTicket, owner: Pubkey, wait_group: u32, kind: u8, bump: u8) -> Result<()> {
    if t.owner == Pubkey::default() {
        t.owner = owner;
        t.wait_group = wait_group;
        t.kind = kind;
        t.bump = bump;
        t.requested_at = Clock::get()?.unix_timestamp;
    }
    require!(t.owner == owner && t.wait_group == wait_group && t.kind == kind, CoreError::InvalidParam);
    Ok(())
}

#[derive(Accounts)]
pub struct ProcessDeposit<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Account<'info, Mint>,
    #[account(
        mut, close = owner,
        seeds = [SEED_DEPOSIT_TICKET, ticket.owner.as_ref(), &ticket.wait_group.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.kind == ticket_kind::DEPOSIT @ CoreError::InvalidParam,
    )]
    pub ticket: Account<'info, QueueTicket>,
    /// CHECK: the ticket's owner (address checked); receives the ticket's rent.
    #[account(mut, address = ticket.owner @ CoreError::InvalidParam)]
    pub owner: UncheckedAccount<'info>,
    /// Receives the shares: the owner's share account.
    #[account(mut, token::mint = share_mint, token::authority = ticket.owner, token::token_program = token_program)]
    pub owner_shares: Account<'info, TokenAccount>,
    /// Receives the locked shares if this is the vault's first deposit (`math::LOCKED_SHARES`).
    #[account(mut, address = vault.share_escrow @ CoreError::InvalidParam)]
    pub share_escrow: Account<'info, TokenAccount>,
    /// Receives the USDC back if no share can be minted: the owner's USDC account.
    #[account(mut, token::mint = config.usdc_mint, token::authority = ticket.owner, token::token_program = token_program)]
    pub owner_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Applies a queued deposit (anyone may call): mints shares at the current NAV, rounded down (INV-5), and moves the
/// USDC from `queued_deposits` to `equity`. Only once no group up to the ticket's wait group is live. If no share can
/// be minted (shares outstanding but no equity left after a wiped-out weekend, or a NAV above the deposit), the USDC
/// goes back to the owner instead, so a queued deposit is never stuck.
pub fn handle_process_deposit(ctx: Context<ProcessDeposit>) -> Result<()> {
    let (amount, wait_group) = (ctx.accounts.ticket.amount, ctx.accounts.ticket.wait_group);
    require!(!ctx.accounts.config.paused, CoreError::Paused);
    let v = &ctx.accounts.vault;
    require!(!v.live_through(wait_group), CoreError::QueueNotReady);
    let supply = ctx.accounts.share_mint.supply;
    let seeds: &[&[u8]] = &[SEED_VAULT, &[v.bump]];
    let nav = v.nav_for_deposit(Clock::get()?.unix_timestamp)?; // inventory at full value (W2, A-36)
    let Some((shares, locked)) = deposit_shares(amount, nav, supply).filter(|(s, _)| *s > 0) else {
        pay_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.vault_usdc, &ctx.accounts.owner_usdc, amount)?;
        let v = &mut ctx.accounts.vault;
        v.queued_deposits = v.queued_deposits.checked_sub(amount).ok_or(CoreError::Math)?;
        emit!(QueueProcessed { owner: ctx.accounts.ticket.owner, kind: ticket_kind::DEPOSIT, wait_group, usdc: amount, shares: 0, equity: v.equity });
        return Ok(());
    };
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.owner_shares.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        shares,
    )?;
    mint_locked(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.share_mint, &ctx.accounts.share_escrow, locked)?;
    let v = &mut ctx.accounts.vault;
    v.queued_deposits = v.queued_deposits.checked_sub(amount).ok_or(CoreError::Math)?;
    v.equity = v.equity.checked_add(amount).ok_or(CoreError::Math)?;
    emit!(QueueProcessed { owner: ctx.accounts.ticket.owner, kind: ticket_kind::DEPOSIT, wait_group, usdc: amount, shares, equity: v.equity });
    Ok(())
}

#[derive(Accounts)]
pub struct ProcessWithdrawal<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.usdc @ CoreError::InvalidParam)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = vault.share_mint @ CoreError::InvalidParam)]
    pub share_mint: Account<'info, Mint>,
    #[account(mut, address = vault.share_escrow @ CoreError::InvalidParam)]
    pub share_escrow: Account<'info, TokenAccount>,
    #[account(
        mut, close = owner,
        seeds = [SEED_WITHDRAW_TICKET, ticket.owner.as_ref(), &ticket.wait_group.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.kind == ticket_kind::WITHDRAW @ CoreError::InvalidParam,
    )]
    pub ticket: Account<'info, QueueTicket>,
    /// CHECK: the ticket's owner (address checked); receives the ticket's rent.
    #[account(mut, address = ticket.owner @ CoreError::InvalidParam)]
    pub owner: UncheckedAccount<'info>,
    /// Receives the USDC: the owner's USDC account.
    #[account(mut, token::mint = config.usdc_mint, token::authority = ticket.owner, token::token_program = token_program)]
    pub owner_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Pays a queued withdrawal (anyone may call) once no group up to the ticket's wait group is live (INV-6): USDC =
/// ⌊shares × equity / supply⌋ (rounded down, INV-5), the escrowed shares are burned. The remaining equity must still
/// cover the live groups' reservation (INV-2); new cover was sized without these shares (`free_equity`), so this only
/// fails if a live group's losses shrank equity meanwhile, and then the ticket waits for that group too.
pub fn handle_process_withdrawal(ctx: Context<ProcessWithdrawal>) -> Result<()> {
    let (shares, wait_group) = (ctx.accounts.ticket.amount, ctx.accounts.ticket.wait_group);
    let v = &ctx.accounts.vault;
    require!(!v.live_through(wait_group), CoreError::QueueNotReady);
    let supply = ctx.accounts.share_mint.supply;
    // At NAV: book equity with the backstop's inventory at its fresh mark (W2); paid in cash.
    let nav = v.nav(Clock::get()?.unix_timestamp)?;
    let paid = usdc_for_shares(shares, nav, supply).ok_or(CoreError::Math)?;
    let equity_after = v.equity.checked_sub(paid).ok_or(CoreError::Math)?;
    // INV-2 on the equity that can back cover (inventory never does), and INV-13: the cash kept for live groups and
    // queues stays (with inventory, cash is below equity).
    let cover_after = equity_after.checked_sub(v.inventory_cost()?).ok_or(CoreError::CapacityExceeded)?;
    let limit = (cover_after as u128) * (ctx.accounts.config.u_max_wad as u128) / WAD;
    require!(v.reserved_total as u128 <= limit, CoreError::CapacityExceeded);
    let cash_after = ctx.accounts.vault_usdc.amount.checked_sub(paid).ok_or(CoreError::CapacityExceeded)?;
    require!(cash_after >= v.reserved_cash()?, CoreError::CapacityExceeded);

    let seeds: &[&[u8]] = &[SEED_VAULT, &[v.bump]];
    token::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.share_escrow.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        shares,
    )?;
    if paid > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault_usdc.to_account_info(),
                    to: ctx.accounts.owner_usdc.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            paid,
        )?;
    }
    let v = &mut ctx.accounts.vault;
    v.equity = equity_after;
    v.queued_withdraw_shares = v.queued_withdraw_shares.checked_sub(shares).ok_or(CoreError::Math)?;
    emit!(QueueProcessed { owner: ctx.accounts.ticket.owner, kind: ticket_kind::WITHDRAW, wait_group, usdc: paid, shares, equity: v.equity });
    Ok(())
}

#[event]
pub struct QueueRequested {
    pub owner: Pubkey,
    pub kind: u8,
    pub wait_group: u32,
    pub amount: u64,
    pub total: u64,
}

#[event]
pub struct QueueProcessed {
    pub owner: Pubkey,
    pub kind: u8,
    pub wait_group: u32,
    pub usdc: u64,
    pub shares: u64,
    pub equity: u64,
}

#[event]
pub struct Deposited {
    pub depositor: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub equity: u64,
    pub supply: u64,
}
