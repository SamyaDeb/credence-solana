//! klend CPIs of the weekend-safe market (D1): every one is a **v2** instruction (they skip `check_refresh_ixs`, so a
//! program may call them; the transaction carries the `refresh_reserve` ×N and `refresh_obligation` before it, and never
//! Jupiter's program). Account orders were run against the mainnet klend binary in `tests/wsm_spike.rs`.
//!
//! The obligation's owner is the user's `["wsm", user]` account, which signs through its seeds. A borrow also needs the
//! market's permissioning authority, the program's `["wsm_auth"]` PDA, as the last account and a signer (klend
//! `check_permissions`).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

use crate::kamino::{FARMS_PROGRAM_ID, KLEND_PROGRAM_ID, WSM_MARKET};
use crate::CoreError;

/// `sha256("global:<name>")[..8]`.
pub const INIT_USER_METADATA_DISC: [u8; 8] = [117, 169, 176, 69, 197, 23, 15, 162];
pub const INIT_OBLIGATION_DISC: [u8; 8] = [251, 10, 231, 76, 27, 11, 159, 96];
pub const DEPOSIT_V2_DISC: [u8; 8] = [216, 224, 191, 27, 204, 151, 102, 175];
pub const BORROW_V2_DISC: [u8; 8] = [161, 128, 143, 245, 171, 199, 194, 6];
pub const WITHDRAW_V2_DISC: [u8; 8] = [235, 52, 119, 152, 149, 197, 20, 7];

/// The klend accounts every action on the market shares.
pub struct Market<'a, 'info> {
    pub market: &'a AccountInfo<'info>,
    pub lma: &'a AccountInfo<'info>,
    pub klend: &'a AccountInfo<'info>,
    pub farms: &'a AccountInfo<'info>,
    pub instruction_sysvar: &'a AccountInfo<'info>,
}

impl Market<'_, '_> {
    /// The market is the weekend-safe one, its authority the market's PDA, and the programs are klend's and farms'.
    pub fn check(&self) -> Result<()> {
        require_keys_eq!(*self.market.key, WSM_MARKET, CoreError::MarketNotAllowed);
        require_keys_eq!(*self.klend.key, KLEND_PROGRAM_ID, CoreError::WrongProgram);
        require_keys_eq!(*self.farms.key, FARMS_PROGRAM_ID, CoreError::WrongProgram);
        require_keys_eq!(*self.market.owner, KLEND_PROGRAM_ID, CoreError::WrongProgram);
        let (lma, _) = Pubkey::find_program_address(&[b"lma", WSM_MARKET.as_ref()], &KLEND_PROGRAM_ID);
        require_keys_eq!(*self.lma.key, lma, CoreError::InvalidParam);
        Ok(())
    }
}

/// The klend obligation address of a `["wsm", user]` account: tag 0, id 0, owner, market, no seeds.
pub fn obligation_address(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[&[0u8], &[0u8], owner.as_ref(), WSM_MARKET.as_ref(), Pubkey::default().as_ref(), Pubkey::default().as_ref()],
        &KLEND_PROGRAM_ID,
    )
    .0
}

pub fn user_metadata_address(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"user_meta", owner.as_ref()], &KLEND_PROGRAM_ID).0
}

fn farm_slot_metas() -> [AccountMeta; 3] {
    // Optional obligation-farm accounts absent (Anchor: klend's own id stands in for `None`), then the farms program.
    [
        AccountMeta::new_readonly(KLEND_PROGRAM_ID, false),
        AccountMeta::new_readonly(KLEND_PROGRAM_ID, false),
        AccountMeta::new_readonly(FARMS_PROGRAM_ID, false),
    ]
}

/// `init_user_metadata` (unless `reopen`: it survives the obligation) then `init_obligation` for `owner` (the user's
/// account, signing through `seeds`), the user paying the rent.
#[allow(clippy::too_many_arguments)]
pub fn open_obligation<'info>(
    m: &Market<'_, 'info>,
    owner: &AccountInfo<'info>,
    fee_payer: &AccountInfo<'info>,
    user_metadata: &AccountInfo<'info>,
    obligation: &AccountInfo<'info>,
    seed_account: &AccountInfo<'info>,
    rent: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    reopen: bool,
    seeds: &[&[u8]],
) -> Result<()> {
    m.check()?;
    require_keys_eq!(*user_metadata.key, user_metadata_address(owner.key), CoreError::InvalidParam);
    require_keys_eq!(*obligation.key, obligation_address(owner.key), CoreError::InvalidParam);
    require_keys_eq!(*seed_account.key, Pubkey::default(), CoreError::InvalidParam);
    let mut d = INIT_USER_METADATA_DISC.to_vec();
    d.extend_from_slice(&[0u8; 32]); // user_lookup_table: none
    if !reopen {
    invoke_signed(
        &Instruction {
            program_id: KLEND_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(*owner.key, true),
                AccountMeta::new(*fee_payer.key, true),
                AccountMeta::new(*user_metadata.key, false),
                AccountMeta::new_readonly(KLEND_PROGRAM_ID, false), // referrer: none
                AccountMeta::new_readonly(*rent.key, false),
                AccountMeta::new_readonly(*system.key, false),
            ],
            data: d,
        },
        &[owner.clone(), fee_payer.clone(), user_metadata.clone(), m.klend.clone(), rent.clone(), system.clone()],
        &[seeds],
    )?;
    }
    let mut d = INIT_OBLIGATION_DISC.to_vec();
    d.extend_from_slice(&[0u8, 0u8]); // tag 0, id 0
    invoke_signed(
        &Instruction {
            program_id: KLEND_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(*owner.key, true),
                AccountMeta::new(*fee_payer.key, true),
                AccountMeta::new(*obligation.key, false),
                AccountMeta::new_readonly(*m.market.key, false),
                AccountMeta::new_readonly(Pubkey::default(), false),
                AccountMeta::new_readonly(Pubkey::default(), false),
                AccountMeta::new_readonly(*user_metadata.key, false),
                AccountMeta::new_readonly(*rent.key, false),
                AccountMeta::new_readonly(*system.key, false),
            ],
            data: d,
        },
        &[
            owner.clone(), fee_payer.clone(), obligation.clone(), m.market.clone(), seed_account.clone(), seed_account.clone(),
            user_metadata.clone(), rent.clone(), system.clone(), m.klend.clone(),
        ],
        &[seeds],
    )?;
    Ok(())
}

/// The reserve-side accounts of a deposit, borrow or withdraw.
pub struct ReserveAccts<'a, 'info> {
    pub reserve: &'a AccountInfo<'info>,
    pub liquidity_mint: &'a AccountInfo<'info>,
    pub liquidity_supply: &'a AccountInfo<'info>,
    pub liquidity_token_program: &'a AccountInfo<'info>,
}

/// `deposit_reserve_liquidity_and_obligation_collateral_v2`: `amount` of the reserve's token from `source` (owned by
/// `owner`) into the obligation as collateral.
#[allow(clippy::too_many_arguments)]
pub fn deposit<'info>(
    m: &Market<'_, 'info>,
    r: &ReserveAccts<'_, 'info>,
    owner: &AccountInfo<'info>,
    obligation: &AccountInfo<'info>,
    collateral_mint: &AccountInfo<'info>,
    collateral_supply: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    collateral_token_program: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    m.check()?;
    let mut d = DEPOSIT_V2_DISC.to_vec();
    d.extend_from_slice(&amount.to_le_bytes());
    let mut metas = vec![
        AccountMeta::new(*owner.key, true),
        AccountMeta::new(*obligation.key, false),
        AccountMeta::new_readonly(*m.market.key, false),
        AccountMeta::new_readonly(*m.lma.key, false),
        AccountMeta::new(*r.reserve.key, false),
        AccountMeta::new_readonly(*r.liquidity_mint.key, false),
        AccountMeta::new(*r.liquidity_supply.key, false),
        AccountMeta::new(*collateral_mint.key, false),
        AccountMeta::new(*collateral_supply.key, false),
        AccountMeta::new(*source.key, false),
        AccountMeta::new_readonly(KLEND_PROGRAM_ID, false), // placeholder user destination collateral: none
        AccountMeta::new_readonly(*collateral_token_program.key, false),
        AccountMeta::new_readonly(*r.liquidity_token_program.key, false),
        AccountMeta::new_readonly(*m.instruction_sysvar.key, false),
    ];
    metas.extend(farm_slot_metas());
    invoke_signed(
        &Instruction { program_id: KLEND_PROGRAM_ID, accounts: metas, data: d },
        &[
            owner.clone(), obligation.clone(), m.market.clone(), m.lma.clone(), r.reserve.clone(), r.liquidity_mint.clone(),
            r.liquidity_supply.clone(), collateral_mint.clone(), collateral_supply.clone(), source.clone(),
            collateral_token_program.clone(), r.liquidity_token_program.clone(), m.instruction_sysvar.clone(), m.farms.clone(),
            m.klend.clone(),
        ],
        &[seeds],
    )?;
    Ok(())
}

/// `borrow_obligation_liquidity_v2`: `amount` of the borrow reserve's token into `dest` (owned by `owner`). The market's
/// permissioning authority `permissioner` (the program's `["wsm_auth"]`) signs as the last account.
#[allow(clippy::too_many_arguments)]
pub fn borrow<'info>(
    m: &Market<'_, 'info>,
    r: &ReserveAccts<'_, 'info>,
    owner: &AccountInfo<'info>,
    obligation: &AccountInfo<'info>,
    fee_vault: &AccountInfo<'info>,
    dest: &AccountInfo<'info>,
    permissioner: &AccountInfo<'info>,
    amount: u64,
    owner_seeds: &[&[u8]],
    permissioner_seeds: &[&[u8]],
) -> Result<()> {
    m.check()?;
    let mut d = BORROW_V2_DISC.to_vec();
    d.extend_from_slice(&amount.to_le_bytes());
    let mut metas = vec![
        AccountMeta::new_readonly(*owner.key, true),
        AccountMeta::new(*obligation.key, false),
        AccountMeta::new_readonly(*m.market.key, false),
        AccountMeta::new_readonly(*m.lma.key, false),
        AccountMeta::new(*r.reserve.key, false),
        AccountMeta::new_readonly(*r.liquidity_mint.key, false),
        AccountMeta::new(*r.liquidity_supply.key, false),
        AccountMeta::new(*fee_vault.key, false),
        AccountMeta::new(*dest.key, false),
        AccountMeta::new_readonly(KLEND_PROGRAM_ID, false), // referrer token state: none
        AccountMeta::new_readonly(*r.liquidity_token_program.key, false),
        AccountMeta::new_readonly(*m.instruction_sysvar.key, false),
    ];
    metas.extend(farm_slot_metas());
    metas.push(AccountMeta::new_readonly(*permissioner.key, true));
    invoke_signed(
        &Instruction { program_id: KLEND_PROGRAM_ID, accounts: metas, data: d },
        &[
            owner.clone(), obligation.clone(), m.market.clone(), m.lma.clone(), r.reserve.clone(), r.liquidity_mint.clone(),
            r.liquidity_supply.clone(), fee_vault.clone(), dest.clone(), r.liquidity_token_program.clone(),
            m.instruction_sysvar.clone(), m.farms.clone(), m.klend.clone(), permissioner.clone(),
        ],
        &[owner_seeds, permissioner_seeds],
    )?;
    Ok(())
}

/// `withdraw_obligation_collateral_and_redeem_reserve_collateral_v2`: `collateral` cTokens (`u64::MAX` = all klend
/// allows) redeemed into `dest` (owned by `owner`). No permissioner: klend cannot gate a withdrawal.
#[allow(clippy::too_many_arguments)]
pub fn withdraw<'info>(
    m: &Market<'_, 'info>,
    r: &ReserveAccts<'_, 'info>,
    owner: &AccountInfo<'info>,
    obligation: &AccountInfo<'info>,
    collateral_mint: &AccountInfo<'info>,
    collateral_supply: &AccountInfo<'info>,
    dest: &AccountInfo<'info>,
    collateral_token_program: &AccountInfo<'info>,
    collateral: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    m.check()?;
    let mut d = WITHDRAW_V2_DISC.to_vec();
    d.extend_from_slice(&collateral.to_le_bytes());
    let mut metas = vec![
        AccountMeta::new(*owner.key, true),
        AccountMeta::new(*obligation.key, false),
        AccountMeta::new_readonly(*m.market.key, false),
        AccountMeta::new_readonly(*m.lma.key, false),
        AccountMeta::new(*r.reserve.key, false),
        AccountMeta::new_readonly(*r.liquidity_mint.key, false),
        AccountMeta::new(*collateral_supply.key, false),
        AccountMeta::new(*collateral_mint.key, false),
        AccountMeta::new(*r.liquidity_supply.key, false),
        AccountMeta::new(*dest.key, false),
        AccountMeta::new_readonly(KLEND_PROGRAM_ID, false), // placeholder user destination collateral: none
        AccountMeta::new_readonly(*collateral_token_program.key, false),
        AccountMeta::new_readonly(*r.liquidity_token_program.key, false),
        AccountMeta::new_readonly(*m.instruction_sysvar.key, false),
    ];
    metas.extend(farm_slot_metas());
    invoke_signed(
        &Instruction { program_id: KLEND_PROGRAM_ID, accounts: metas, data: d },
        &[
            owner.clone(), obligation.clone(), m.market.clone(), m.lma.clone(), r.reserve.clone(), r.liquidity_mint.clone(),
            collateral_supply.clone(), collateral_mint.clone(), r.liquidity_supply.clone(), dest.clone(),
            collateral_token_program.clone(), r.liquidity_token_program.clone(), m.instruction_sysvar.clone(), m.farms.clone(),
            m.klend.clone(),
        ],
        &[seeds],
    )?;
    Ok(())
}
