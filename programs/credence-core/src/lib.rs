//! Credence core program: Gap Cover, underwriter vault and gap oracle (Phase 1).
//!
//! All premium, loss and gap-factor math comes from `credence-risk-core`; this program only adapts it to
//! accounts. See `plan/03-architecture.md`.

use anchor_lang::prelude::*;
use credence_risk_core::{gap_factor, U256};

declare_id!("xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q");

#[program]
pub mod credence_core {
    use super::*;

    /// Link check (task 1.2): returns `gap_factor(z, σ, d, κ)` from `risk-core` as WAD via return data.
    /// Removed once real instructions use `risk-core`.
    pub fn ping_gap_factor(_ctx: Context<Ping>, z: i16, sigma: u64, dividend: u64, kappa: u64) -> Result<u128> {
        let g = gap_factor(z, U256::from(sigma), U256::from(dividend), U256::from(kappa))
            .map_err(|_| error!(CoreError::Math))?;
        u128::try_from(g).map_err(|_| error!(CoreError::Math))
    }
}

#[derive(Accounts)]
pub struct Ping {}

#[error_code]
pub enum CoreError {
    #[msg("risk-core math error")]
    Math,
}
