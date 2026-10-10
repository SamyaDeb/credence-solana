//! D1.0 spike (weekend-safe market): what the real mainnet klend binary lets a new market do. Creates a market with
//! `init_lending_market`, four reserves (SPYx, QQQx, NVDAx collateral; USDC borrow) priced by Kamino's existing Scope
//! account, then probes permissioning, borrow limits and the exit paths. Findings are in plan/09 (D1.0).
//! Test-only shortcuts: the klend global config account is rewritten so the test admin is the global admin (on mainnet
//! that key is Kamino's), Scope timestamps are re-stamped (`Env::freshen_scope`), token balances are written directly.

mod common;

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::{AccountMeta, Instruction}, system_program},
};
use common::*;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;

use common::km::*;

/// D1.0 question 1: a market with SPYx, QQQx, NVDAx as collateral and USDC as the borrow asset, priced by Scope.
#[test]
fn spike_1_market_with_scope_prices() {
    let mut km = build(None);
    for r in [km.spy.clone(), km.qqq.clone(), km.nvda.clone(), km.usdc.clone()] {
        let ix = km.refresh_reserve(&r);
        km.step(&format!("refresh_reserve {}", r.key), &[ix], &[&km.env.admin.insecure_clone()]).unwrap();
        let d = km.env.data(&r.key);
        let px = u128::from_le_bytes(d[RS_PRICE..RS_PRICE + 16].try_into().unwrap()) as f64 / 2f64.powi(60);
        println!("    market price per base unit x 2^-60 = {px:.12e}");
    }
}

const RS_PRICE: usize = 248;

/// D1.0 question 2: what klend lets a permissioner gate (borrow, deposit, liquidate) and what stays with the owner.
#[test]
fn spike_2_permissioned_borrow_only() {
    let mut km = build(None);
    let _lp = seed_usdc_liquidity(&mut km, 1_000_000 * 1_000_000);
    let alice = km.open_user();
    let (spy_acct, usdc_acct) = deposit_spy(&mut km, &alice, 10); // 10 SPYx ~ $7.8k

    println!("-- before any permissioning");
    borrow_usdc(&mut km, &alice, &usdc_acct, 1_000, None, "open market: Alice borrows 1,000 USDC").unwrap();

    println!("-- permissioning authority = P, permissioned ops = BORROW");
    let p = Keypair::new();
    let owner = km.env.admin.pubkey();
    let ix1 = market_ix(&km, &owner, 42, p.pubkey().as_ref());
    let ix2 = market_ix(&km, &owner, 43, &2u64.to_le_bytes());
    let admin = km.env.admin.insecure_clone();
    km.step("owner sets authority and ops", &[ix1, ix2], &[&admin]).unwrap();

    assert!(borrow_usdc(&mut km, &alice, &usdc_acct, 100, None, "Alice borrows without P").is_err());
    let bob = km.open_user();
    let _ = deposit_spy(&mut km, &bob, 10);
    let bob_usdc = km.env.usdc_account(&bob.kp.pubkey(), 0);
    assert!(borrow_usdc(&mut km, &bob, &bob_usdc, 100, None, "Bob borrows without P").is_err());
    borrow_usdc(&mut km, &alice, &usdc_acct, 100, Some(&p), "Alice borrows with P co-signing").unwrap();

    println!("-- the exits stay with the obligation owner, no permissioner");
    let (spy, usdc_r) = (km.spy.clone(), km.usdc.clone());
    credit(&mut km.env, &usdc_acct, 5_000 * 1_000_000);
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(km.repay(&alice, &usdc_r, &usdc_acct, u64::MAX));
    km.step("Alice repays everything (no P)", &ixs, &[&alice.kp]).unwrap();
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(km.withdraw(&alice, &spy, &spy_acct, u64::MAX));
    km.step("Alice withdraws all collateral (no P)", &ixs, &[&alice.kp]).unwrap();
    let after = km.env.token_balance(&spy_acct);
    println!("  Alice's SPYx back in her wallet: {after}");
    assert!(after > 0);
}

/// D1.0 questions 2 and 4: with a higher limit, what the owner can still do alone (withdraw up to the LTV), and that
/// klend's own liquidators are not gated by a BORROW-only permissioner.
#[test]
fn spike_3_higher_limit_withdraw_and_liquidation() {
    let mut km = build(Some((85, 90)));
    let _lp = seed_usdc_liquidity(&mut km, 1_000_000 * 1_000_000);
    let p = Keypair::new();
    let owner = km.env.admin.pubkey();
    let ix1 = market_ix(&km, &owner, 42, p.pubkey().as_ref());
    let ix2 = market_ix(&km, &owner, 43, &2u64.to_le_bytes());
    let admin = km.env.admin.insecure_clone();
    km.step("owner: permissioner P, ops = BORROW", &[ix1, ix2], &[&admin]).unwrap();

    let alice = km.open_user();
    let (spy_acct, usdc_acct) = deposit_spy(&mut km, &alice, 10); // $7,817
    println!("-- limits: LTV 85 / LT 90 on SPYx");
    borrow_usdc(&mut km, &alice, &usdc_acct, 6_200, Some(&p), "borrow 6,200 USDC (79.3% LTV) with P").unwrap();
    assert!(borrow_usdc(&mut km, &alice, &usdc_acct, 600, Some(&p), "borrow 600 more (87% LTV), P co-signs").is_err());
    borrow_usdc(&mut km, &alice, &usdc_acct, 400, Some(&p), "borrow 400 more (84.4% LTV), P co-signs").unwrap();

    println!("-- the owner alone can push to the LTV by withdrawing (no permissioner on withdraw)");
    let spy = km.spy.clone();
    let before = km.env.token_balance(&spy_acct);
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(km.withdraw(&alice, &spy, &spy_acct, 0_000_000_001)); // 1 base unit of cToken: dust, passes
    km.step("withdraw dust", &ixs, &[&alice.kp]).unwrap();
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(km.withdraw(&alice, &spy, &spy_acct, 5_000_000)); // 0.05 SPYx (~$39) fits under the LTV (klend allows ~$54)
    km.step("withdraw 0.05 SPYx (~$39, inside the LTV), owner alone", &ixs, &[&alice.kp]).unwrap();
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(km.withdraw(&alice, &spy, &spy_acct, 100_000_000)); // 0.1 SPYx: LTV 85.5%
    let r = km.step("withdraw 0.1 SPYx (LTV would be ~85.5%)", &ixs, &[&alice.kp]);
    assert!(r.is_err(), "klend refuses a withdrawal that takes the obligation above its LTV");
    let after = km.env.token_balance(&spy_acct);
    println!("  wallet SPYx before/after: {before} -> {after}");

    println!("-- price falls 8% (Scope SPYx chain 344) then 12%: not liquidatable at LT 90 until LTV crosses 90%");
    let now = km.env.now();
    let liq = km.env.funded();
    let liq_usdc = km.env.usdc_account(&liq.pubkey(), 100_000 * 1_000_000);
    let liq_spy = token_account_2022(&mut km.env, &liq.pubkey(), &SPYX_MINT, 0);
    // a cToken account for the liquidator (classic token program), for klend's collateral destination slot
    let coll_dest = Pubkey::new_unique();
    let mut cd = token_account_data(&km.spy.coll_mint, &liq.pubkey(), 0);
    cd.truncate(165);
    let l = km.env.svm.minimum_balance_for_rent_exemption(165);
    km.env.svm.set_account(coll_dest, Account { lamports: l, data: cd, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
    let px = 781.74;
    km.env.put_scope(344, px * 0.92, now);
    let spy_r = km.spy.clone();
    let usdc_r = km.usdc.clone();
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(liquidate(&km, &liq, &alice.ob, &liq_usdc, &liq_spy, &coll_dest, 1_000 * 1_000_000));
    let r = km.step("liquidator at -8% (LTV ~91.7% of the new value)", &ixs, &[&liq]);
    assert!(r.is_ok(), "a stranger liquidates through a BORROW-only permissioned market: {r:?}");
    let _ = (spy_r, usdc_r);
    assert!(km.env.token_balance(&liq_spy) > 0, "the liquidator received SPYx");
}
