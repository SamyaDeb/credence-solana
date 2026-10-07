//! Kamino Lend (`klend`) integration: program ids, market allow-list, pinned `Obligation` / `Reserve` layouts, the
//! cover snapshot read from a refreshed obligation, and the v2 repay CPI.
//!
//! Only `repay_obligation_liquidity_v2` is called from this program. The v1 instruction rejects cross-program calls
//! (`check_refresh_ixs`); v2 does not (klend source, commit `a087609`; fork test in task 1.3). The caller's
//! transaction must contain `refresh_reserve` (each reserve of the obligation) and `refresh_obligation` before this
//! instruction, and must never contain Jupiter's `jupr81Y…` program (klend `RESTRICTED_PROGRAMS`).

use anchor_lang::prelude::*;
use credence_risk_core::U256;

use crate::math::WAD;
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
/// `sha256("account:Reserve")[..8]`.
pub const RESERVE_DISC: [u8; 8] = [43, 242, 204, 202, 26, 247, 59, 127];

/// klend `PriceStatusFlags::ALL_CHECKS`: price loaded, age, TWAP, TWAP age, heuristic, usage allowed.
pub const PRICE_STATUS_ALL_CHECKS: u8 = 0b0011_1111;
/// klend `Fraction` (U68F60) fractional bits: the `_sf` fields are value × 2^60.
pub const SF_SHIFT: u32 = 60;

/// Byte offsets into klend accounts, **including** the 8-byte discriminator. Pinned to klend commit `a087609`
/// (release 1.25.0); `scripts/src/klend-layout.ts` prints them from klend-sdk's layouts, and `tests/kamino.rs` decodes
/// the real obligation `47wNsqpy…` and its reserves and compares every field with klend-sdk's decode.
pub mod layout {
    pub const OBLIGATION_LEN: usize = 3344;
    pub const OB_LAST_UPDATE_SLOT: usize = 16;
    pub const OB_LAST_UPDATE_STALE: usize = 24;
    pub const OB_LAST_UPDATE_PRICE_STATUS: usize = 25;
    pub const OB_LENDING_MARKET: usize = 32;
    pub const OB_OWNER: usize = 64;
    /// `deposits: [ObligationCollateral; 8]`, 136 bytes each.
    pub const OB_DEPOSITS: usize = 96;
    pub const OB_DEPOSITS_N: usize = 8;
    pub const DEPOSIT_LEN: usize = 136;
    pub const DEP_RESERVE: usize = 0;
    pub const DEP_MARKET_VALUE_SF: usize = 40;
    pub const OB_DEPOSITED_VALUE_SF: usize = 1192;
    /// `borrows: [ObligationLiquidity; 5]`, 200 bytes each.
    pub const OB_BORROWS: usize = 1208;
    pub const OB_BORROWS_N: usize = 5;
    pub const BORROW_LEN: usize = 200;
    pub const BOR_RESERVE: usize = 0;
    pub const BOR_BORROWED_AMOUNT_SF: usize = 88;
    pub const BOR_MARKET_VALUE_SF: usize = 104;
    pub const OB_BF_ADJUSTED_DEBT_VALUE_SF: usize = 2208;
    pub const OB_BORROWED_ASSETS_MARKET_VALUE_SF: usize = 2224;
    pub const OB_UNHEALTHY_BORROW_VALUE_SF: usize = 2256;
    pub const OB_ELEVATION_GROUP: usize = 2285;

    pub const RESERVE_LEN: usize = 8624;
    pub const RS_LENDING_MARKET: usize = 32;
    pub const RS_LIQUIDITY_MINT: usize = 128;
    pub const RS_LIQUIDITY_SUPPLY_VAULT: usize = 160;
    pub const RS_LIQUIDITY_TOKEN_PROGRAM: usize = 408;
    pub const RS_CONFIG_STATUS: usize = 4856;
    pub const RS_CONFIG_LIQUIDATION_THRESHOLD_PCT: usize = 4873;
    pub const RS_CONFIG_BORROW_FACTOR_PCT: usize = 5008;
}

fn rd_pubkey(d: &[u8], o: usize) -> Result<Pubkey> {
    let b: [u8; 32] = d.get(o..o + 32).ok_or(CoreError::KaminoLayout)?.try_into().map_err(|_| CoreError::KaminoLayout)?;
    Ok(Pubkey::new_from_array(b))
}
fn rd_u128(d: &[u8], o: usize) -> Result<u128> {
    let b: [u8; 16] = d.get(o..o + 16).ok_or(CoreError::KaminoLayout)?.try_into().map_err(|_| CoreError::KaminoLayout)?;
    Ok(u128::from_le_bytes(b))
}
fn rd_u64(d: &[u8], o: usize) -> Result<u64> {
    let b: [u8; 8] = d.get(o..o + 8).ok_or(CoreError::KaminoLayout)?.try_into().map_err(|_| CoreError::KaminoLayout)?;
    Ok(u64::from_le_bytes(b))
}
fn rd_u8(d: &[u8], o: usize) -> Result<u8> {
    d.get(o).copied().ok_or_else(|| error!(CoreError::KaminoLayout))
}

/// The fields of a klend `Obligation` that cover reads. Values are klend's own (`_sf` = USD × 2^60, amounts in token
/// base units × 2^60), as of the obligation's last refresh.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObligationView {
    pub last_update_slot: u64,
    pub stale: u8,
    pub price_status: u8,
    pub lending_market: Pubkey,
    pub owner: Pubkey,
    /// Active deposits (reserve ≠ default): (reserve, market_value_sf).
    pub deposits: Vec<(Pubkey, u128)>,
    /// Active borrows (reserve ≠ default): (reserve, borrowed_amount_sf, market_value_sf).
    pub borrows: Vec<(Pubkey, u128, u128)>,
    pub deposited_value_sf: u128,
    pub bf_adjusted_debt_value_sf: u128,
    pub borrowed_assets_market_value_sf: u128,
    pub unhealthy_borrow_value_sf: u128,
    pub elevation_group: u8,
}

impl ObligationView {
    /// Decodes an account owned by klend. Checks the owner program, the length and the `Obligation` discriminator.
    pub fn load(acc: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*acc.owner, KLEND_PROGRAM_ID, CoreError::WrongProgram);
        let d = acc.try_borrow_data()?;
        Self::decode(&d)
    }

    /// Decodes raw account data (length and discriminator checked; the owner check is the caller's, see [`Self::load`]).
    pub fn decode(d: &[u8]) -> Result<Self> {
        use layout::*;
        require!(d.len() == OBLIGATION_LEN && d[..8] == OBLIGATION_DISC, CoreError::KaminoLayout);
        let mut deposits = Vec::with_capacity(1);
        for i in 0..OB_DEPOSITS_N {
            let o = OB_DEPOSITS + i * DEPOSIT_LEN;
            let reserve = rd_pubkey(d, o + DEP_RESERVE)?;
            if reserve != Pubkey::default() {
                deposits.push((reserve, rd_u128(d, o + DEP_MARKET_VALUE_SF)?));
            }
        }
        let mut borrows = Vec::with_capacity(1);
        for i in 0..OB_BORROWS_N {
            let o = OB_BORROWS + i * BORROW_LEN;
            let reserve = rd_pubkey(d, o + BOR_RESERVE)?;
            if reserve != Pubkey::default() {
                borrows.push((reserve, rd_u128(d, o + BOR_BORROWED_AMOUNT_SF)?, rd_u128(d, o + BOR_MARKET_VALUE_SF)?));
            }
        }
        Ok(Self {
            last_update_slot: rd_u64(d, OB_LAST_UPDATE_SLOT)?,
            stale: rd_u8(d, OB_LAST_UPDATE_STALE)?,
            price_status: rd_u8(d, OB_LAST_UPDATE_PRICE_STATUS)?,
            lending_market: rd_pubkey(d, OB_LENDING_MARKET)?,
            owner: rd_pubkey(d, OB_OWNER)?,
            deposits,
            borrows,
            deposited_value_sf: rd_u128(d, OB_DEPOSITED_VALUE_SF)?,
            bf_adjusted_debt_value_sf: rd_u128(d, OB_BF_ADJUSTED_DEBT_VALUE_SF)?,
            borrowed_assets_market_value_sf: rd_u128(d, OB_BORROWED_ASSETS_MARKET_VALUE_SF)?,
            unhealthy_borrow_value_sf: rd_u128(d, OB_UNHEALTHY_BORROW_VALUE_SF)?,
            elevation_group: rd_u8(d, OB_ELEVATION_GROUP)?,
        })
    }
}

/// The fields of a klend `Reserve` that cover reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReserveView {
    pub lending_market: Pubkey,
    pub liquidity_mint: Pubkey,
    pub supply_vault: Pubkey,
    pub token_program: Pubkey,
    pub status: u8,
    pub liquidation_threshold_pct: u8,
    pub borrow_factor_pct: u64,
}

impl ReserveView {
    pub fn load(acc: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*acc.owner, KLEND_PROGRAM_ID, CoreError::WrongProgram);
        let d = acc.try_borrow_data()?;
        Self::decode(&d)
    }

    pub fn decode(d: &[u8]) -> Result<Self> {
        use layout::*;
        require!(d.len() == RESERVE_LEN && d[..8] == RESERVE_DISC, CoreError::KaminoLayout);
        Ok(Self {
            lending_market: rd_pubkey(d, RS_LENDING_MARKET)?,
            liquidity_mint: rd_pubkey(d, RS_LIQUIDITY_MINT)?,
            supply_vault: rd_pubkey(d, RS_LIQUIDITY_SUPPLY_VAULT)?,
            token_program: rd_pubkey(d, RS_LIQUIDITY_TOKEN_PROGRAM)?,
            status: rd_u8(d, RS_CONFIG_STATUS)?,
            liquidation_threshold_pct: rd_u8(d, RS_CONFIG_LIQUIDATION_THRESHOLD_PCT)?,
            borrow_factor_pct: rd_u64(d, RS_CONFIG_BORROW_FACTOR_PCT)?,
        })
    }
}

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
