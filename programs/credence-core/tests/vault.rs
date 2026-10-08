//! Task 2.1: vault init, deposits and LP shares (INV-5, donation attack). Queues: task 3.1.

mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use credence_core::{math::LOCKED_SHARES, state::*, CoreError};
use solana_signer::Signer;

fn setup() -> (Env, Pubkey) {
    let mut env = Env::new();
    env.init_config();
    let fee = env.init_vault();
    (env, fee)
}

#[test]
fn init_vault_happy_and_failures() {
    let (mut env, fee) = setup();
    let v: Vault = env.anchor(&vault_pda());
    assert_eq!(v.usdc, vault_usdc_pda());
    assert_eq!(v.share_mint, shares_pda());
    assert_eq!(v.fee_account, fee);
    assert_eq!(v.equity, 0);
    assert_eq!(env.data(&vault_pda()).len(), Vault::SIZE);
    // Vault USDC account: USDC mint, owned by the vault PDA. Share mint: 6 decimals, authority the vault PDA.
    let d = env.data(&vault_usdc_pda());
    assert_eq!(&d[0..32], USDC_MINT.as_ref());
    assert_eq!(&d[32..64], vault_pda().as_ref());
    let m = env.data(&shares_pda());
    assert_eq!(&m[4..36], vault_pda().as_ref());
    assert_eq!(m[44], 6);
    // Twice fails.
    let a = env.admin.pubkey();
    let ix = env.ix_init_vault(&a, fee);
    assert_fails(env.send_admin(&[ix]));
}

#[test]
fn init_vault_rejects_non_admin_and_wrong_fee_mint() {
    let mut env = Env::new();
    env.init_config();
    let mallory = env.funded();
    let fee = env.usdc_account(&mallory.pubkey(), 0);
    let ix = env.ix_init_vault(&mallory.pubkey(), fee);
    assert_err(env.send(&[ix], &[&mallory]), code(CoreError::Unauthorized));
    // Fee account with a non-USDC mint.
    let a = env.admin.pubkey();
    let bad = Pubkey::new_unique();
    env.put_token_account(bad, &Pubkey::new_unique(), &a, 0);
    let ix = env.ix_init_vault(&a, bad);
    assert_fails(env.send_admin(&[ix]));
}

#[test]
fn first_deposit_one_to_one_then_at_nav() {
    let (mut env, _) = setup();
    let (alice, au, ash) = env.lp(1_000_000_000);
    let ix = env.ix_deposit(&alice.pubkey(), au, ash, 400_000_000);
    env.send(&[ix], &[&alice]).unwrap();
    assert_eq!(env.token_balance(&ash), 400_000_000 - LOCKED_SHARES, "first deposit 1:1, one share locked");
    assert_eq!(env.token_balance(&share_escrow_pda()), LOCKED_SHARES);
    assert_eq!(env.mint_supply(&shares_pda()), 400_000_000);
    assert_eq!(env.anchor::<Vault>(&vault_pda()).equity, 400_000_000);
    assert_eq!(env.token_balance(&vault_usdc_pda()), 400_000_000);

    // Equity grows by 100 USDC (released premiums; simulated): NAV = 500 / 400 = 1.25.
    env.edit_vault(|v| v.equity += 100_000_000);
    let (bob, bu, bsh) = env.lp(1_000_000_000);
    let ix = env.ix_deposit(&bob.pubkey(), bu, bsh, 333_333_333);
    env.send(&[ix], &[&bob]).unwrap();
    // ⌊333,333,333 × 400,000,000 / 500,000,000⌋ = 266,666,666 (rounded down, against Bob).
    assert_eq!(env.token_balance(&bsh), 266_666_666);
    assert_eq!(env.mint_supply(&shares_pda()), 666_666_666);
    assert_eq!(env.anchor::<Vault>(&vault_pda()).equity, 833_333_333);
}

/// INV-5: a deposit alone never lowers NAV per share; it can raise it by rounding dust only.
#[test]
fn inv5_deposit_does_not_dilute() {
    let (mut env, _) = setup();
    let (alice, au, ash) = env.lp(10_000_000_000);
    let ix = env.ix_deposit(&alice.pubkey(), au, ash, 1_000_000_007);
    env.send(&[ix], &[&alice]).unwrap();
    env.edit_vault(|v| v.equity += 333_333_337);
    for amount in [1u64, 7, 999_999, 123_456_789, 5_000_000_001] {
        let (lp, u, sh) = env.lp(amount);
        let (e0, s0) = (env.anchor::<Vault>(&vault_pda()).equity, env.mint_supply(&shares_pda()));
        let ix = env.ix_deposit(&lp.pubkey(), u, sh, amount);
        let r = env.send(&[ix], &[&lp]);
        if r.is_err() {
            // Too small to mint one share at this NAV: refused, nothing changes.
            assert_eq!(env.anchor::<Vault>(&vault_pda()).equity, e0);
            continue;
        }
        let (e1, s1) = (env.anchor::<Vault>(&vault_pda()).equity, env.mint_supply(&shares_pda()));
        // e1/s1 ≥ e0/s0, and the depositor gave up less than one share's worth.
        assert!(e1 as u128 * s0 as u128 >= e0 as u128 * s1 as u128, "NAV fell on deposit of {amount}");
        let minted = s1 - s0;
        assert!((amount as u128 * s0 as u128) - (minted as u128 * e0 as u128) < e0 as u128);
    }
}

/// A direct USDC transfer to the vault (a "donation") must not change share pricing.
#[test]
fn donation_does_not_change_share_price() {
    let (mut env, _) = setup();
    let (alice, au, ash) = env.lp(1_000_000_000);
    let ix = env.ix_deposit(&alice.pubkey(), au, ash, 2_000_000);
    env.send(&[ix], &[&alice]).unwrap();
    // Attacker sends 1,000,000 USDC straight to the vault's token account.
    let bal = env.token_balance(&vault_usdc_pda());
    env.put_token_account(vault_usdc_pda(), &USDC_MINT, &vault_pda(), bal + 1_000_000_000_000);
    let (bob, bu, bsh) = env.lp(1_000_000);
    let ix = env.ix_deposit(&bob.pubkey(), bu, bsh, 1_000_000);
    env.send(&[ix], &[&bob]).unwrap();
    assert_eq!(env.token_balance(&bsh), 1_000_000, "share price must ignore the token balance");
    assert_eq!(env.anchor::<Vault>(&vault_pda()).equity, 3_000_000);
}

#[test]
fn deposit_failures() {
    let (mut env, _) = setup();
    let (alice, au, ash) = env.lp(1_000_000_000);
    // Zero amount.
    let ix = env.ix_deposit(&alice.pubkey(), au, ash, 0);
    assert_err(env.send(&[ix], &[&alice]), code(CoreError::InvalidParam));
    // A first deposit no larger than the locked share (audit A-03).
    let ix = env.ix_deposit(&alice.pubkey(), au, ash, LOCKED_SHARES);
    assert_err(env.send(&[ix], &[&alice]), code(CoreError::InvalidParam));
    // The locked shares must go to the vault's escrow, not to an account of the depositor's choice.
    let mine = Pubkey::new_unique();
    env.put_token_account(mine, &shares_pda(), &alice.pubkey(), 0);
    let mut ix = env.ix_deposit(&alice.pubkey(), au, ash, 2_000_000);
    ix.accounts[7].pubkey = mine;
    assert_err(env.send(&[ix], &[&alice]), code(CoreError::InvalidParam));
    // Someone else's USDC account as the source.
    let (bob, bu, _) = env.lp(1_000_000_000);
    let ix = env.ix_deposit(&alice.pubkey(), bu, ash, 1_000_000);
    assert_fails(env.send(&[ix], &[&alice]));
    // A fake vault USDC account.
    let fake = env.usdc_account(&alice.pubkey(), 0);
    let mut ix = env.ix_deposit(&alice.pubkey(), au, ash, 1_000_000);
    ix.accounts[3].pubkey = fake;
    assert_err(env.send(&[ix], &[&alice]), code(CoreError::InvalidParam));
    // A share account of another mint.
    let other = Pubkey::new_unique();
    env.put_token_account(other, &USDC_MINT, &alice.pubkey(), 0);
    let ix = env.ix_deposit(&alice.pubkey(), au, other, 1_000_000);
    assert_fails(env.send(&[ix], &[&alice]));
    // While a group is live, direct deposits are refused (they queue, task 3.1).
    env.edit_vault(|v| v.live_groups = 1);
    let ix = env.ix_deposit(&bob.pubkey(), bu, ash, 1_000_000);
    assert_err(env.send(&[ix], &[&bob]), code(CoreError::VaultLocked));
    // A wiped-out vault (shares outstanding, no equity) refuses deposits instead of minting at an infinite price.
    env.edit_vault(|v| v.live_groups = 0);
    let ix = env.ix_deposit(&alice.pubkey(), au, ash, 2_000_000);
    env.send(&[ix], &[&alice]).unwrap();
    env.edit_vault(|v| v.equity = 0);
    let ix = env.ix_deposit(&alice.pubkey(), au, ash, 1_000_000);
    assert_err(env.send(&[ix], &[&alice]), code(CoreError::Math));
}

/// Audit A-03: first-depositor share inflation. An attacker is the first LP with 2 base units (2 shares), then raises
/// equity without minting shares: a policy with a 1-base-unit cap fits the 1-unit capacity and still pays the 5 USDC
/// minimum premium, which the group's settlement releases to equity (simulated here with `edit_vault`). NAV is then
/// about 2.5 USDC per base-unit share, so the next deposit loses up to a share's worth to rounding, and anything below
/// 2.5 USDC mints nothing. The vault's first deposit must therefore leave shares nobody can redeem.
#[test]
fn first_depositor_cannot_inflate_share_price() {
    let (mut env, _) = setup();
    let (attacker, au, ash) = env.lp(10_000_000);
    // The smallest first deposit the program accepts: 2 base units, or just above the locked minimum.
    let first = env.ix_deposit(&attacker.pubkey(), au, ash, 2);
    if env.send(&[first], &[&attacker]).is_err() {
        let first = env.ix_deposit(&attacker.pubkey(), au, ash, 1_000_002);
        env.send(&[first], &[&attacker]).unwrap();
    }
    env.edit_vault(|v| v.equity += 5_000_000); // the attacker's own premium, released at settlement

    let (victim, vu, vsh) = env.lp(9_000_000);
    let ix = env.ix_deposit(&victim.pubkey(), vu, vsh, 9_000_000);
    env.send(&[ix], &[&victim]).unwrap();
    let v: Vault = env.anchor(&vault_pda());
    let supply = env.mint_supply(&shares_pda());
    let worth = env.token_balance(&vsh) as u128 * v.equity as u128 / supply as u128;
    println!("victim deposited 9.000000 USDC, holds shares worth {:.6} USDC", worth as f64 / 1e6);
    assert!(9_000_000 - worth < 100, "the victim lost {} base units to rounding", 9_000_000 - worth);
}
