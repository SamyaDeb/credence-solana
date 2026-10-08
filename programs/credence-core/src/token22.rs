//! Token-2022 mint checks for the backstop's xStock transfers (plan/02 §6). xStocks carry PermanentDelegate, Pausable,
//! ScaledUiAmount and a (disabled) TransferHook. Before any transfer of inventory the program reads the mint:
//!
//! - **Pausable** (extension 26: authority, `paused` bool): a paused mint is refused up front (the backstop and the
//!   auction wait, plan/02 "Issuer pauses the token").
//! - **TransferHook** (extension 14: authority, program id): only the null program is accepted. A hook enabled later
//!   would need its extra accounts and runs code we have not reviewed, so the transfer is refused until reviewed.
//!
//! The Scaled UI multiplier does not enter here: the backstop prices per raw unit on Kamino's Scope basis (the
//! multiplier is already inside it); only display converts to UI amounts. Permanent-delegate risk (the issuer can move
//! inventory) is disclosed, not checked.

use anchor_lang::prelude::*;

use crate::CoreError;

/// `ExtensionType::TransferHook`.
pub const EXT_TRANSFER_HOOK: u16 = 14;
/// `ExtensionType::Pausable`.
pub const EXT_PAUSABLE: u16 = 26;
const MINT_ACCOUNT_TYPE_OFFSET: usize = 165;

/// The value of extension `ty` in a Token-2022 mint's TLV data, if present.
pub fn extension(mint_data: &[u8], ty: u16) -> Result<Option<&[u8]>> {
    if mint_data.len() <= MINT_ACCOUNT_TYPE_OFFSET {
        return Ok(None);
    }
    require!(mint_data[MINT_ACCOUNT_TYPE_OFFSET] == 1, CoreError::InvalidParam); // AccountType::Mint
    let mut o = MINT_ACCOUNT_TYPE_OFFSET + 1;
    while o + 4 <= mint_data.len() {
        let t = u16::from_le_bytes([mint_data[o], mint_data[o + 1]]);
        let len = u16::from_le_bytes([mint_data[o + 2], mint_data[o + 3]]) as usize;
        let v = mint_data.get(o + 4..o + 4 + len).ok_or(CoreError::InvalidParam)?;
        if t == ty {
            return Ok(Some(v));
        }
        if t == 0 {
            break;
        }
        o += 4 + len;
    }
    Ok(None)
}

/// Refuses a paused mint or one with a transfer hook program set.
pub fn require_transferable(mint_data: &[u8]) -> Result<()> {
    if let Some(v) = extension(mint_data, EXT_PAUSABLE)? {
        require!(v.len() == 33, CoreError::InvalidParam);
        require!(v[32] == 0, CoreError::MintPaused);
    }
    if let Some(v) = extension(mint_data, EXT_TRANSFER_HOOK)? {
        require!(v.len() == 64, CoreError::InvalidParam);
        require!(v[32..64].iter().all(|b| *b == 0), CoreError::TransferHookEnabled);
    }
    Ok(())
}
