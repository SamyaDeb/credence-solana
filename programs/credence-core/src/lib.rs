//! Credence core program: Gap Cover, underwriter vault and gap oracle (Phase 1).
//!
//! All premium, loss and gap-factor math comes from `credence-risk-core`; this program only adapts it to
//! accounts. See `plan/03-architecture.md`.

use anchor_lang::prelude::*;

pub mod calendar;
pub mod instructions;
pub mod kamino;
pub mod math;
pub mod pricing;
pub mod state;

pub use instructions::*;
pub use state::*;

declare_id!("xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q");

#[program]
pub mod credence_core {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, params: ConfigParams) -> Result<()> {
        instructions::admin::handle_init_config(ctx, params)
    }

    pub fn set_params(ctx: Context<SetParams>, params: ConfigParams) -> Result<()> {
        instructions::admin::handle_set_params(ctx, params)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::admin::handle_set_paused(ctx, paused)
    }

    pub fn add_asset(ctx: Context<AddAsset>, ticker: Ticker, params: AssetParams) -> Result<()> {
        instructions::admin::handle_add_asset(ctx, ticker, params)
    }

    pub fn update_asset(ctx: Context<UpdateAsset>, ticker: Ticker, params: AssetParams) -> Result<()> {
        instructions::admin::handle_update_asset(ctx, ticker, params)
    }

    pub fn init_scenario_set(ctx: Context<InitScenarioSet>, ticker: Ticker, closure_type: u8, n: u16) -> Result<()> {
        instructions::upload::handle_init_scenario_set(ctx, ticker, closure_type, n)
    }

    pub fn write_scenarios(ctx: Context<WriteScenarios>, offset: u16, values: Vec<i16>) -> Result<()> {
        instructions::upload::handle_write_scenarios(ctx, offset, values)
    }

    pub fn finalize_scenario_set(ctx: Context<FinalizeScenarioSet>, expected_hash: [u8; 32]) -> Result<()> {
        instructions::upload::handle_finalize_scenario_set(ctx, expected_hash)
    }

    pub fn init_joint_set(ctx: Context<InitJointSet>, version: u32, tickers: Vec<Ticker>) -> Result<()> {
        instructions::upload::handle_init_joint_set(ctx, version, tickers)
    }

    pub fn write_joint(ctx: Context<WriteJoint>, column: u8, offset: u16, values: Vec<i16>) -> Result<()> {
        instructions::upload::handle_write_joint(ctx, column, offset, values)
    }

    pub fn finalize_joint_set(ctx: Context<FinalizeJointSet>, expected_hash: [u8; 32]) -> Result<()> {
        instructions::upload::handle_finalize_joint_set(ctx, expected_hash)
    }

    pub fn compute_gap_factors(ctx: Context<ComputeGapFactors>, start: u16, count: u16) -> Result<()> {
        instructions::upload::handle_compute_gap_factors(ctx, start, count)
    }

    pub fn init_calendar(ctx: Context<InitCalendar>, venue: [u8; 8], n: u16) -> Result<()> {
        instructions::epoch::handle_init_calendar(ctx, venue, n)
    }

    pub fn write_calendar(ctx: Context<WriteCalendar>, offset: u16, sessions: Vec<SessionArg>) -> Result<()> {
        instructions::epoch::handle_write_calendar(ctx, offset, sessions)
    }

    pub fn finalize_calendar(ctx: Context<FinalizeCalendar>, expected_hash: [u8; 32]) -> Result<()> {
        instructions::epoch::handle_finalize_calendar(ctx, expected_hash)
    }

    pub fn open_group(ctx: Context<OpenGroup>, group: u32) -> Result<()> {
        instructions::epoch::handle_open_group(ctx, group)
    }

    pub fn open_epoch(ctx: Context<OpenEpoch>, ticker: Ticker, closure_id: u32) -> Result<()> {
        instructions::epoch::handle_open_epoch(ctx, ticker, closure_id)
    }

    pub fn init_vault(ctx: Context<InitVault>) -> Result<()> {
        instructions::vault::handle_init_vault(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::vault::handle_deposit(ctx, amount)
    }

    /// Read-only premium and capacity preview. Inputs in USDC base units; `covered_value` is LT × collateral value.
    pub fn quote_cover(ctx: Context<QuoteCover>, covered_value: u64, debt: u64, max_payout: u64) -> Result<Quote> {
        instructions::quote::handle_quote_cover(ctx, covered_value, debt, max_payout)
    }
}

#[error_code]
pub enum CoreError {
    #[msg("risk-core math error")]
    Math,
    #[msg("unexpected program id for a Kamino account")]
    WrongProgram,
    #[msg("lending market is not one of the two xStocks markets")]
    MarketNotAllowed,
    #[msg("signer is not authorised for this instruction")]
    Unauthorized,
    #[msg("invalid parameter")]
    InvalidParam,
    #[msg("set is already finalised")]
    AlreadyFinalized,
    #[msg("set is not finalised")]
    NotFinalized,
    #[msg("values are not sorted ascending")]
    NotSorted,
    #[msg("hash does not match the uploaded values")]
    HashMismatch,
    #[msg("ticker does not match")]
    TickerMismatch,
    #[msg("gap factors are stale or incomplete")]
    StaleGapFactors,
    #[msg("vault capacity exceeded (INV-2)")]
    CapacityExceeded,
    #[msg("account data does not match the pinned klend layout")]
    KaminoLayout,
    #[msg("obligation was not refreshed in this slot (refresh_reserve + refresh_obligation first)")]
    ObligationNotRefreshed,
    #[msg("signer is not the obligation owner")]
    NotObligationOwner,
    #[msg("Phase 1 covers obligations with one xStock deposit and one USDC borrow only")]
    UnsupportedObligation,
    #[msg("a group is live: deposits and withdrawals are queued until it settles")]
    VaultLocked,
    #[msg("protocol is paused")]
    Paused,
    #[msg("asset is disabled")]
    AssetDisabled,
    #[msg("closure_id is not a session in the calendar (or is its last session)")]
    NotASession,
    #[msg("Phase 1 sells WEEKEND closures only")]
    UnsupportedClosure,
    #[msg("cover sales for this epoch are closed (INV-3)")]
    SalesClosed,
}
