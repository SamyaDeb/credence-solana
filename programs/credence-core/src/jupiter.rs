//! Jupiter Lend (W12, task B2): the second lender. Read-only views of its Vaults (Borrow) and Oracle accounts, decoded
//! by hand from the published Anchor IDLs (github.com/jup-ag/jupiter-lend, `target/idl`), and the `operate` CPI that
//! pays back a position's debt (verified on a fork: a PDA may pay back anyone's position; plan/09, B2.0 spike).
//!
//! - A position is an NFT: [`PositionView`] holds its raw collateral and its tick; its debt is
//!   `risk-core::fluid::debt_raw(col, tick)` (Fluid's tick math, golden-tested against `@jup-ag/lend`).
//! - Raw amounts are normalised to 9 decimals and divided by the vault's exchange prices ([`VaultStateView`]).
//! - Prices: Jupiter's Oracle reads one Chainlink Data Streams cache per xStock ([`read_cache`]): USD per token, WAD.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::CoreError;

/// Jupiter Lend Vaults (Borrow) program (klend restricts it in the same transaction: never mix the two).
pub const JL_VAULTS_PROGRAM_ID: Pubkey = pubkey!("jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi");
/// Jupiter Lend Oracle program (owner of the Chainlink Data Streams caches).
pub const JL_ORACLE_PROGRAM_ID: Pubkey = pubkey!("jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc");

const DISC_POSITION: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
const DISC_VAULT_CONFIG: [u8; 8] = [99, 86, 43, 216, 184, 102, 119, 77];
const DISC_VAULT_STATE: [u8; 8] = [228, 196, 82, 165, 98, 210, 235, 152];
const DISC_TICK: [u8; 8] = [176, 94, 67, 247, 133, 173, 7, 115];
const DISC_ORACLE: [u8; 8] = [139, 194, 131, 179, 140, 179, 229, 244];
const DISC_CACHE: [u8; 8] = [65, 102, 75, 47, 79, 156, 109, 193];
/// `sha256("global:operate")[..8]`.
pub const OPERATE_DISC: [u8; 8] = [217, 106, 208, 99, 116, 151, 42, 135];
/// Accounts `operate` names before its remaining accounts (IDL order).
pub const OPERATE_NAMED: usize = 35;
/// Positions of the accounts the program pins in `operate`'s list.
pub mod op_idx {
    pub const SIGNER: usize = 0;
    pub const SIGNER_SUPPLY_TOKEN_ACCOUNT: usize = 1;
    pub const SIGNER_BORROW_TOKEN_ACCOUNT: usize = 2;
    pub const RECIPIENT: usize = 3;
    pub const RECIPIENT_BORROW_TOKEN_ACCOUNT: usize = 4;
    pub const RECIPIENT_SUPPLY_TOKEN_ACCOUNT: usize = 5;
    pub const VAULT_CONFIG: usize = 6;
    pub const VAULT_STATE: usize = 7;
    pub const BORROW_TOKEN: usize = 9;
    pub const POSITION: usize = 11;
}

fn data_of<'a>(info: &'a AccountInfo, owner: &Pubkey, disc: &[u8; 8], min_len: usize) -> Result<std::cell::Ref<'a, &'a mut [u8]>> {
    require_keys_eq!(*info.owner, *owner, CoreError::JupiterLayout);
    let d = info.try_borrow_data()?;
    require!(d.len() >= min_len && d[..8] == disc[..], CoreError::JupiterLayout);
    Ok(d)
}
fn rd_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([d[o], d[o + 1]])
}
fn rd_u32(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]])
}
fn rd_i32(d: &[u8], o: usize) -> i32 {
    rd_u32(d, o) as i32
}
fn rd_u64(d: &[u8], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[o..o + 8]);
    u64::from_le_bytes(b)
}
fn rd_u128(d: &[u8], o: usize) -> u128 {
    let mut b = [0u8; 16];
    b.copy_from_slice(&d[o..o + 16]);
    u128::from_le_bytes(b)
}
fn rd_key(d: &[u8], o: usize) -> Pubkey {
    let mut b = [0u8; 32];
    b.copy_from_slice(&d[o..o + 32]);
    Pubkey::new_from_array(b)
}

/// `Position` (Vaults): vault_id u16 @8, nft_id u32 @10, position_mint @14, is_supply_only u8 @46, tick i32 @47,
/// tick_id u32 @51, supply_amount u64 @55, dust_debt_amount u64 @63.
#[derive(Clone, Copy, Debug)]
pub struct PositionView {
    pub vault_id: u16,
    pub nft_id: u32,
    pub position_mint: Pubkey,
    pub is_supply_only: bool,
    pub tick: i32,
    pub tick_id: u32,
    pub supply_raw: u64,
    pub dust_debt_raw: u64,
}
impl PositionView {
    pub fn load(info: &AccountInfo) -> Result<Self> {
        let d = data_of(info, &JL_VAULTS_PROGRAM_ID, &DISC_POSITION, 71)?;
        Ok(Self::decode(&d))
    }
    pub fn decode(d: &[u8]) -> Self {
        Self {
            vault_id: rd_u16(d, 8),
            nft_id: rd_u32(d, 10),
            position_mint: rd_key(d, 14),
            is_supply_only: d[46] != 0,
            tick: rd_i32(d, 47),
            tick_id: rd_u32(d, 51),
            supply_raw: rd_u64(d, 55),
            dust_debt_raw: rd_u64(d, 63),
        }
    }
}

/// `VaultConfig`: vault_id u16 @8, collateral_factor u16 @14, liquidation_threshold u16 @16 (per mille),
/// vault_type u8 @25, oracle @26, supply_token @154, borrow_token @186.
#[derive(Clone, Copy, Debug)]
pub struct VaultConfigView {
    pub vault_id: u16,
    pub liquidation_threshold_permille: u16,
    pub vault_type: u8,
    pub oracle: Pubkey,
    pub supply_token: Pubkey,
    pub borrow_token: Pubkey,
}
impl VaultConfigView {
    pub fn load(info: &AccountInfo) -> Result<Self> {
        let d = data_of(info, &JL_VAULTS_PROGRAM_ID, &DISC_VAULT_CONFIG, 219)?;
        Ok(Self {
            vault_id: rd_u16(&d, 8),
            liquidation_threshold_permille: rd_u16(&d, 16),
            vault_type: d[25],
            oracle: rd_key(&d, 26),
            supply_token: rd_key(&d, 154),
            borrow_token: rd_key(&d, 186),
        })
    }
}

/// `VaultState`: vault_id u16 @8, vault_supply_exchange_price u64 @99, vault_borrow_exchange_price u64 @107.
#[derive(Clone, Copy, Debug)]
pub struct VaultStateView {
    pub vault_id: u16,
    pub supply_exchange_price: u64,
    pub borrow_exchange_price: u64,
}
impl VaultStateView {
    pub fn load(info: &AccountInfo) -> Result<Self> {
        let d = data_of(info, &JL_VAULTS_PROGRAM_ID, &DISC_VAULT_STATE, 127)?;
        Ok(Self { vault_id: rd_u16(&d, 8), supply_exchange_price: rd_u64(&d, 99), borrow_exchange_price: rd_u64(&d, 107) })
    }
}

/// `Tick`: vault_id u16 @8, tick i32 @10, is_liquidated u8 @14, total_ids u32 @15.
#[derive(Clone, Copy, Debug)]
pub struct TickView {
    pub vault_id: u16,
    pub tick: i32,
    pub is_liquidated: bool,
    pub total_ids: u32,
}
impl TickView {
    pub fn load(info: &AccountInfo) -> Result<Self> {
        let d = data_of(info, &JL_VAULTS_PROGRAM_ID, &DISC_TICK, 40)?;
        Ok(Self { vault_id: rd_u16(&d, 8), tick: rd_i32(&d, 10), is_liquidated: d[14] != 0, total_ids: rd_u32(&d, 15) })
    }
}

/// The single source of a vault's `Oracle` account (`nonce u16 @8, sources: vec<{pubkey, invert, multiplier u128,
/// divisor u128, source_type u8}> @10`): it must be one Chainlink Data Streams cache, not inverted, multiplier = divisor
/// = 1 (every xStock vault, Oct 9), so the cache price is the vault's collateral price.
pub fn oracle_single_cache(info: &AccountInfo) -> Result<Pubkey> {
    let d = data_of(info, &JL_ORACLE_PROGRAM_ID, &DISC_ORACLE, 14 + 66)?;
    require!(rd_u32(&d, 10) == 1, CoreError::JupiterLayout);
    let o = 14;
    let (invert, mult, div, ty) = (d[o + 32], rd_u128(&d, o + 33), rd_u128(&d, o + 49), d[o + 65]);
    require!(invert == 0 && mult == 1 && div == 1 && ty == 7, CoreError::JupiterLayout); // 7 = ChainlinkDataStreams
    Ok(rd_key(&d, o))
}

/// A Chainlink Data Streams cache: the price (USD per token, WAD) and when Jupiter's keepers last updated it.
#[derive(Clone, Copy, Debug)]
pub struct CachePrice {
    pub price_wad: u128,
    pub unix_timestamp: i64,
    pub suspended: bool,
}

/// Reads the cache `info` (owner, discriminator and key = `expected` checked): `nonce u16 @8, feeds vec<34 bytes>
/// @10, price u128, last_update_timestamp_price u64, …, generic_data { activation u64, suspended bool, … }`.
pub fn read_cache(info: &AccountInfo, expected: &Pubkey) -> Result<CachePrice> {
    require_keys_eq!(*info.key, *expected, CoreError::InvalidParam);
    let d = data_of(info, &JL_ORACLE_PROGRAM_ID, &DISC_CACHE, 14)?;
    let n = rd_u32(&d, 10) as usize;
    require!(n <= 16, CoreError::JupiterLayout);
    let o = 14 + 34 * n;
    require!(d.len() >= o + 16 + 24 + 9, CoreError::JupiterLayout);
    let price_wad = rd_u128(&d, o);
    let ts = rd_u64(&d, o + 16);
    let suspended = d[o + 16 + 24 + 8] != 0;
    require!(price_wad > 0, CoreError::BadPrice);
    Ok(CachePrice { price_wad, unix_timestamp: i64::try_from(ts).map_err(|_| error!(CoreError::BadPrice))?, suspended })
}

/// A token account's (mint, owner, amount), for either token program (base layout).
pub fn token_account_basics(info: &AccountInfo) -> Result<(Pubkey, Pubkey, u64)> {
    require!(
        *info.owner == anchor_spl::token::ID || *info.owner == anchor_spl::token_2022::ID,
        CoreError::InvalidParam
    );
    let d = info.try_borrow_data()?;
    require!(d.len() >= 165 && d[108] == 1, CoreError::InvalidParam); // initialised
    Ok((rd_key(&d, 0), rd_key(&d, 32), rd_u64(&d, 64)))
}

/// `operate(new_col = 0, new_debt = −amount, DIRECT, indices)` signed by the vault PDA: pays back `amount` borrow-token
/// base units of the position's debt (operate takes token units; Fluid normalises to 9 decimals inside, as
/// `@jup-ag/lend` does only for its own account planning). `accounts` are operate's accounts in IDL order followed by
/// its remaining accounts, as `@jup-ag/lend`'s `getOperateIx` builds them; the caller has pinned the ones that matter
/// (signer, its borrow-token account, vault config, position). Only `vault` is marked signer.
pub fn operate_payback<'info>(
    vaults_program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    vault: &Pubkey,
    amount: u64,
    borrow_decimals: u8,
    remaining_indices: &[u8],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*vaults_program.key, JL_VAULTS_PROGRAM_ID, CoreError::InvalidParam);
    require!(borrow_decimals <= 9, CoreError::JupiterLayout);
    let scaled = amount as i128;
    let mut data = Vec::with_capacity(8 + 16 + 16 + 2 + 4 + remaining_indices.len());
    data.extend_from_slice(&OPERATE_DISC);
    data.extend_from_slice(&0i128.to_le_bytes());
    data.extend_from_slice(&(-scaled).to_le_bytes());
    data.extend_from_slice(&[1u8, 1u8]); // Some(TransferType::DIRECT)
    data.extend_from_slice(&(remaining_indices.len() as u32).to_le_bytes());
    data.extend_from_slice(remaining_indices);
    let metas = accounts
        .iter()
        .map(|a| AccountMeta { pubkey: *a.key, is_signer: *a.key == *vault, is_writable: a.is_writable })
        .collect();
    let mut infos: Vec<AccountInfo<'info>> = accounts.to_vec();
    infos.push(vaults_program.clone());
    invoke_signed(&Instruction { program_id: JL_VAULTS_PROGRAM_ID, accounts: metas, data }, &infos, signer_seeds)?;
    Ok(())
}
