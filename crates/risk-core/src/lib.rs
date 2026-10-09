//! # credence-risk-core
//!
//! The single source of truth for Credence risk math: gap factors, premiums, expected shortfall and capacity.
//!
//! It builds `no_std` for the on-chain program and with `std` for the backtest and data tools. Both builds run the
//! same integer code, so their outputs are bit-identical. There is no floating point anywhere.
//!
//! Units: loan amounts in loan-token base units, collateral in token base units, prices and ratios
//! in WAD (1e18), standardised scenario gaps `z` as `i16` thousandths of one σ.
//! Rounding: always against the user who is acting, never against solvency. Every function
//! documents its direction.
#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_code)]
#![deny(missing_docs)]

extern crate alloc;

pub mod capacity;
pub mod clearing;
pub mod fixed;
pub mod liquidation;
pub mod premium;
pub mod rates;
pub mod safe_ltv;
pub mod scenarios;
#[cfg(feature = "files")]
pub mod setfile;

pub use alloy_primitives::U256;
pub use capacity::{loss_vector, pool_capacity, uncovered_bound, CapacityResult, UncoveredMarket};
pub use clearing::{blended_price, clear, ClearResult};
pub use fixed::{MathError, MathResult, WAD};
pub use liquidation::{liquidation_lot, preclose_lot, settle_position, Settlement};
pub use premium::{quote_cover, quote_cover_capped, PremiumParams, PremiumQuote};
pub use rates::{accrue_interest, kinked_rate, projected_debt, senior_rate, utilization};
pub use safe_ltv::{
    bell_status, cure_amounts, elapsed_days, gap_factor, gap_factor_at, safe_ltv,
    safe_ltv_from_set, sigma_min_allowed, BellResult, Cures,
};
pub use scenarios::{is_sorted, quantile_index, PackedZ, SliceZ, ZSource};
