//! Weekend-safe market (D1): the program against the real klend binary. See `common/wsm.rs` for the world.

mod common;

use anchor_lang::{prelude::Pubkey, InstructionData, ToAccountMetas};
use common::km::*;
use common::wsm::*;
use common::*;
use credence_core::{accounts as acc, instruction as ix, state::*, CoreError};
use solana_signer::Signer;

const VAULT: u64 = 2_000_000_000_000; // the vault's LP equity: 2M USDC
const MARKET_LP: u64 = 1_000_000_000_000; // external USDC lender: 1M

fn open_and_deposit(w: &mut W, u: &Wu, spyx: u64) {
    let o = w.ix_open(u);
    w.km.step("wsm_open", &[o], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    let d = w.ix_deposit(u, spyx * 100_000_000);
    w.go("wsm_deposit", u, vec![d], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
}

#[test]
fn happy_path_open_deposit_borrow_repay_withdraw() {
    let mut w = W::new(VAULT, MARKET_LP);
    let u = w.user(10, 0);
    open_and_deposit(&mut w, &u, 10); // 10 SPYx ~ $7.8k
    let b = w.ix_borrow(&u, 6_000 * 1_000_000); // 77% of the collateral value: above Kamino's 73%
    w.go("wsm_borrow 6,000 USDC", &u, vec![b], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(w.km.env.token_balance(&u.usdc), 6_000 * 1_000_000);
    let obl: u128 = w.km.env.data(&u.obligation).len() as u128;
    assert!(obl > 0);
    // Repay everything (+ interest dust) and take the collateral back.
    credit(&mut w.km.env, &u.usdc, 6_100 * 1_000_000);
    let r = w.ix_repay(&u, u64::MAX);
    w.go("wsm_repay all", &u, vec![r], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    assert!(w.km.env.token_balance(&u.usdc) > 90_000_000, "the unused part came back");
    assert_eq!(w.km.env.token_balance(&wsm_usdc_pda(&u.kp.pubkey())), 0);
    let x = w.ix_withdraw(&u, u64::MAX);
    w.go("wsm_withdraw all", &u, vec![x], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(w.km.env.token_balance(&u.coll), 10 * 100_000_000);
}

const OCT9_CLOSE: i64 = 1_791_576_000;
const BELL: i64 = OCT9_CLOSE - 900;
const FREEZE: i64 = 4 * 3600;

fn in_freeze(w: &mut W) {
    w.km.env.set_time(BELL - 3_600);
}

fn state(w: &W, u: &Wu) -> credence_core::instructions::wsm::WsmAccount {
    w.km.env.anchor(&u.account)
}

/// A borrower at D/C′ ≈ 0.93 (the market's cap is 0.945), covered: the premium is borrowed onto the account and paid to
/// the vault, the policy is the account's, the cover is for the debt that exists after the premium.
#[test]
fn auto_cover_charges_the_premium_to_the_account_and_covers_the_new_debt() {
    let mut w = W::new(VAULT, MARKET_LP);
    let u = w.user(10, 0);
    open_and_deposit(&mut w, &u, 10);
    let b = w.ix_borrow(&u, 6_100 * 1_000_000);
    w.go("wsm_borrow 6,100 USDC", &u, vec![b], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    let debt0 = w.debt_usdc(&u);
    in_freeze(&mut w);
    let vault0: Vault = w.km.env.anchor(&vault_pda());
    let keeper = w.km.env.funded();
    let c = w.ix_auto_cover(&keeper.pubkey(), &u, GROUP_OCT9);
    let cu = w.go("wsm_auto_cover", &u, vec![c], &[&keeper]).unwrap_or_else(|e| panic!("{e}"));
    println!("    (with refreshes) {cu} CU");
    let s = state(&w, &u);
    assert_eq!((s.covered_closure, s.cover_failed_closure), (GROUP_OCT9, 0));
    let pol: Policy = w.km.env.anchor(&policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &u.obligation));
    assert_eq!(pol.owner, u.account);
    assert_eq!(pol.state, policy_state::ACTIVE);
    assert_eq!(pol.max_payout, pol.debt, "full cover");
    assert_eq!(s.addon_paid_total, pol.premium, "the add-on is exactly the policy's premium");
    let debt1 = w.debt_usdc(&u);
    println!("    debt {debt0:.4} -> {debt1:.4} USDC; premium {} (fee {}), policy debt {}", pol.premium, pol.fee, pol.debt);
    let grew = debt1 - debt0 - pol.premium as f64 / 1e6; // klend's interest over the day between the two
    assert!((0.0..0.05).contains(&grew), "the premium is on the account's debt (interest {grew})");
    assert!(pol.debt as f64 / 1e6 >= debt1 - 1e-4, "the cover is for at least the debt after the premium");
    let vault1: Vault = w.km.env.anchor(&vault_pda());
    assert_eq!(vault1.total_premiums - vault0.total_premiums, pol.premium - pol.fee);
    assert_eq!(w.km.env.token_balance(&wsm_usdc_pda(&u.kp.pubkey())), 0, "nothing stays in transit");
    // The premium as an APR on the debt (README: the add-on).
    println!("    add-on: {:.2}% a year of the debt", pol.premium as f64 * 52.0 / pol.debt as f64 * 100.0);
}
