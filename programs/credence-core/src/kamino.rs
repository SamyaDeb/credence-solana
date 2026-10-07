//! Kamino Lend (`klend`) integration: program ids, market allow-list and the v2 repay CPI.
//!
//! Only `repay_obligation_liquidity_v2` is called from this program. The v1 instruction rejects cross-program calls
//! (`check_refresh_ixs`); v2 does not (klend source, commit `a087609`; fork test in task 1.3). The caller's
//! transaction must contain `refresh_reserve` (each reserve of the obligation) and `refresh_obligation` before this
//! instruction, and must never contain Jupiter's `jupr81Y…` program (klend `RESTRICTED_PROGRAMS`).

use anchor_lang::prelude::*;

use crate::CoreError;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

/// klend program (mainnet and devnet).
pub const KLEND_PROGRAM_ID: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
/// Kamino farms program (repay v2 refreshes the obligation's debt farm through it).
pub const FARMS_PROGRAM_ID: Pubkey = pubkey!("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
/// The two xStocks lending markets whose obligations may be covered.
pub const XSTOCKS_MARKETS: [Pubkey; 2] = [
    pubkey!("5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua"), // xStocks Market
    pubkey!("8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr"), // Sentora xStocks Market
];
/// Never allowed in a transaction that touches klend.
pub const JUPITER_RESTRICTED_PROGRAM_ID: Pubkey = pubkey!("jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi");

/// `sha256("global:repay_obligation_liquidity_v2")[..8]` (matches `@kamino-finance/klend-sdk`).
pub const REPAY_OBLIGATION_LIQUIDITY_V2_DISC: [u8; 8] = [116, 174, 213, 76, 180, 53, 210, 144];
/// `sha256("account:Obligation")[..8]`.
pub const OBLIGATION_DISC: [u8; 8] = [168, 206, 141, 106, 88, 76, 172, 167];

/// Accounts of `repay_obligation_liquidity_v2`, in klend's order.
pub struct RepayV2<'a, 'info> {
    /// Payer of `user_source_liquidity`; klend does not require it to own the obligation.
    pub owner: &'a AccountInfo<'info>,
    pub obligation: &'a AccountInfo<'info>,
    pub lending_market: &'a AccountInfo<'info>,
    pub repay_reserve: &'a AccountInfo<'info>,
    pub reserve_liquidity_mint: &'a AccountInfo<'info>,
    pub reserve_destination_liquidity: &'a AccountInfo<'info>,
    pub user_source_liquidity: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub instruction_sysvar: &'a AccountInfo<'info>,
    /// `None` when the reserve has no debt farm (klend then expects its own program id in this slot).
    pub obligation_farm_user_state: Option<&'a AccountInfo<'info>>,
    pub reserve_farm_state: Option<&'a AccountInfo<'info>>,
    pub lending_market_authority: &'a AccountInfo<'info>,
    pub farms_program: &'a AccountInfo<'info>,
    pub klend_program: &'a AccountInfo<'info>,
}

/// Repays `amount` (liquidity base units) of the obligation's debt in `repay_reserve`, paid from
/// `user_source_liquidity` with `owner` signing through `signer_seeds`.
///
/// klend caps the repayment at the outstanding debt (it repays `min(amount, borrowed)`); `u64::MAX` means "repay all".
pub fn repay_obligation_liquidity_v2(a: &RepayV2<'_, '_>, amount: u64, signer_seeds: &[&[&[u8]]]) -> Result<()> {
    require_keys_eq!(*a.klend_program.key, KLEND_PROGRAM_ID, CoreError::WrongProgram);
    require_keys_eq!(*a.farms_program.key, FARMS_PROGRAM_ID, CoreError::WrongProgram);
    require!(XSTOCKS_MARKETS.contains(a.lending_market.key), CoreError::MarketNotAllowed);

    let farm_slot = |acc: Option<&AccountInfo>| match acc {
        Some(acc) => AccountMeta::new(*acc.key, false),
        None => AccountMeta::new_readonly(KLEND_PROGRAM_ID, false),
    };
    let metas = vec![
        AccountMeta::new_readonly(*a.owner.key, true),
        AccountMeta::new(*a.obligation.key, false),
        AccountMeta::new_readonly(*a.lending_market.key, false),
        AccountMeta::new(*a.repay_reserve.key, false),
        AccountMeta::new_readonly(*a.reserve_liquidity_mint.key, false),
        AccountMeta::new(*a.reserve_destination_liquidity.key, false),
        AccountMeta::new(*a.user_source_liquidity.key, false),
        AccountMeta::new_readonly(*a.token_program.key, false),
        AccountMeta::new_readonly(*a.instruction_sysvar.key, false),
        farm_slot(a.obligation_farm_user_state),
        farm_slot(a.reserve_farm_state),
        AccountMeta::new_readonly(*a.lending_market_authority.key, false),
        AccountMeta::new_readonly(*a.farms_program.key, false),
    ];
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&REPAY_OBLIGATION_LIQUIDITY_V2_DISC);
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction { program_id: KLEND_PROGRAM_ID, accounts: metas, data };

    let mut infos = vec![
        a.owner.clone(),
        a.obligation.clone(),
        a.lending_market.clone(),
        a.repay_reserve.clone(),
        a.reserve_liquidity_mint.clone(),
        a.reserve_destination_liquidity.clone(),
        a.user_source_liquidity.clone(),
        a.token_program.clone(),
        a.instruction_sysvar.clone(),
        a.lending_market_authority.clone(),
        a.farms_program.clone(),
        a.klend_program.clone(),
    ];
    infos.extend(a.obligation_farm_user_state.cloned());
    infos.extend(a.reserve_farm_state.cloned());
    invoke_signed(&ix, &infos, signer_seeds)?;
    Ok(())
}
