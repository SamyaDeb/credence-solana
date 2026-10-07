//! Credence core program: Gap Cover, underwriter vault and gap oracle (Phase 1).
//!
//! All premium, loss and gap-factor math comes from `credence-risk-core`; this program only adapts it to
//! accounts. See `plan/03-architecture.md`.

use anchor_lang::prelude::*;

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
}
