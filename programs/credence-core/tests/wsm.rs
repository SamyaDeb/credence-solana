//! Weekend-safe market (D1): the program against the real klend binary. See `common/wsm.rs` for the world.

mod common;

use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction, AnchorDeserialize, InstructionData, ToAccountMetas};
use common::km::*;
use common::wsm::*;
use common::*;
use credence_core::{accounts as acc, instruction as ix, state::*, CoreError, Quote};
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
    // klend closed the emptied obligation and refunded its rent through the account to the user's wallet.
    assert!(w.km.env.svm.get_account(&u.obligation).is_none_or(|a| a.data.is_empty()));
    let acct = w.km.env.svm.get_account(&u.account).unwrap();
    assert_eq!(acct.lamports, w.km.env.svm.minimum_balance_for_rent_exemption(acct.data.len()), "only the account's own rent stays");
    // The user can come back: reopen the obligation and deposit again.
    let re = w.ix_reopen(&u);
    w.km.step("wsm_reopen", &[re], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    let d = w.ix_deposit(&u, 5 * 100_000_000);
    w.go("wsm_deposit again", &u, vec![d], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
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

/// The twin of the README's demo, on the weekend-safe market: a covered position at D/C′ ≈ 0.93 meets a −8% weekend.
/// Sunday: the Shield repays into the account's obligation from the vault. Monday: Kamino's own price is −8%; the
/// position stays healthy and settles into the obligation (INV-7, INV-11), and nothing reaches a wallet.
#[test]
fn shield_and_settlement_repay_into_the_account_never_a_wallet() {
    let mut w = W::new(VAULT, MARKET_LP);
    let u = w.user(10, 0);
    open_and_deposit(&mut w, &u, 10);
    let b = w.ix_borrow(&u, 6_100 * 1_000_000);
    w.go("wsm_borrow 6,100 USDC", &u, vec![b], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    in_freeze(&mut w);
    let keeper = w.km.env.funded();
    let c = w.ix_auto_cover(&keeper.pubkey(), &u, GROUP_OCT9);
    w.go("wsm_auto_cover", &u, vec![c], &[&keeper]).unwrap_or_else(|e| panic!("{e}"));
    let policy = w.policy_of(&u);
    w.close_friday();

    // Sunday 21:00 ET: the 24/7 fair value is −8%. The Shield repays from the vault into the obligation.
    let at = W::OPEN - 45_000;
    let price = w.push_fair(-0.08, at);
    let debt_before = w.debt_usdc(&u);
    let wallet_before = (w.km.env.token_balance(&u.usdc), w.km.env.token_balance(&u.coll));
    let vault_before = w.km.env.token_balance(&vault_usdc_pda());
    let mut ixs = w.pre(&u);
    let admin = w.km.env.admin.insecure_clone(); // Config.keeper
    ixs.push(w.ix_shield_wsm(&admin.pubkey(), &u, policy, price));
    w.km.step("shield_advance (wsm obligation)", &ixs, &[&admin]).unwrap_or_else(|e| panic!("{e}"));
    let p: Policy = w.km.env.anchor(&policy);
    assert!(p.advanced > 0, "the Shield advanced");
    let debt_after = w.debt_usdc(&u);
    println!("    advance {} USDC: debt {debt_before:.2} -> {debt_after:.2}", p.advanced as f64 / 1e6);
    assert!((debt_before - debt_after - p.advanced as f64 / 1e6).abs() < 0.5, "the debt fell by the advance (plus klend interest in between)");
    assert_eq!(w.km.env.token_balance(&vault_usdc_pda()), vault_before - p.advanced, "paid by the vault");
    assert_eq!((w.km.env.token_balance(&u.usdc), w.km.env.token_balance(&u.coll)), wallet_before, "no wallet is touched (INV-11)");

    // Monday: Kamino's Scope price is −8% as well; the settlement price is the open.
    w.post_open(-0.08);
    let spy_chain = 344;
    let now = w.km.env.now();
    w.km.env.put_scope(spy_chain, W::SPY_CLOSE * 0.92, now);
    let mut ixs = w.pre(&u);
    ixs.push(w.ix_settle_wsm(&keeper.pubkey(), policy, wsm_usdc_pda(&u.kp.pubkey())));
    // put_scope sets the slot's price; step() re-stamps Scope timestamps but keeps prices.
    w.km.step("settle_policy (repay into the wsm obligation)", &ixs, &[&keeper]).unwrap_or_else(|e| panic!("{e}"));
    let p: Policy = w.km.env.anchor(&policy);
    assert_eq!(p.state, policy_state::SETTLED);
    let health = w.health(&u);
    println!("    settled: payout {} + advance {} USDC; health at Kamino's −8% price: {health:.4}", p.payout as f64 / 1e6, p.advanced as f64 / 1e6);
    assert!(health > 1.0, "the covered position is not liquidatable after the −8% weekend");
    assert_eq!(w.km.env.token_balance(&u.usdc), wallet_before.0, "the payout never reached the user's wallet");
    assert_eq!(w.km.env.token_balance(&u.coll), wallet_before.1);
}

// =====================================================================================================================
// D1.1 attack tests. Each names the attack and what must hold.

fn err_code(r: Result<u64, String>, c: CoreError) {
    let want = format!("Custom({})", code(c));
    match r {
        Ok(_) => panic!("expected {c:?}, the transaction succeeded"),
        Err(e) => assert!(e.contains(&want), "expected {c:?} ({want}), got: {e}"),
    }
}

fn expect_fail(r: Result<u64, String>) {
    assert!(r.is_err(), "expected the transaction to fail");
}

/// A covered account mid-weekend: borrowed, frozen, covered, Friday closed.
fn covered(w: &mut W, spyx: u64, borrow: u64) -> (Wu, Pubkey) {
    let u = w.user(spyx, 0);
    open_and_deposit(w, &u, spyx);
    let b = w.ix_borrow(&u, borrow * 1_000_000);
    w.go("wsm_borrow", &u, vec![b], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    in_freeze(w);
    let keeper = w.km.env.funded();
    let c = w.ix_auto_cover(&keeper.pubkey(), &u, GROUP_OCT9);
    w.go("wsm_auto_cover", &u, vec![c], &[&keeper]).unwrap_or_else(|e| panic!("{e}"));
    let policy = w.policy_of(&u);
    (u, policy)
}

/// `d1_user_isolation`: user A cannot touch user B's obligation through any wrapper instruction (seeds, signer, owner
/// checks), and cannot bypass the wrapper by calling klend on their own obligation.
#[test]
fn d1_user_isolation() {
    let mut w = W::new(VAULT, MARKET_LP);
    let a = w.user(10, 5_000 * 1_000_000);
    let b = w.user(10, 5_000 * 1_000_000);
    open_and_deposit(&mut w, &a, 10);
    open_and_deposit(&mut w, &b, 10);
    let bb = w.ix_borrow(&b, 3_000 * 1_000_000);
    w.go("B borrows", &b, vec![bb], &[&b.kp]).unwrap();
    let before = (w.km.env.data(&b.obligation), w.km.env.data(&b.account));

    // A signs; B's account and obligation are passed in place of A's, instruction by instruction.
    let forge = |mut ix: Instruction, from: &Wu, to: &Wu| {
        for m in ix.accounts.iter_mut() {
            if m.pubkey == from.account { m.pubkey = to.account; }
            if m.pubkey == from.obligation { m.pubkey = to.obligation; }
            if m.pubkey == wsm_usdc_pda(&from.kp.pubkey()) { m.pubkey = wsm_usdc_pda(&to.kp.pubkey()); }
            if m.pubkey == wsm_coll_pda(&from.kp.pubkey()) { m.pubkey = wsm_coll_pda(&to.kp.pubkey()); }
        }
        ix
    };
    let actions = vec![
        ("borrow", forge(w.ix_borrow(&a, 100 * 1_000_000), &a, &b)),
        ("repay", forge(w.ix_repay(&a, 100 * 1_000_000), &a, &b)),
        ("withdraw", forge(w.ix_withdraw(&a, 1_000), &a, &b)),
        ("deposit", forge(w.ix_deposit(&a, 1_000), &a, &b)),
        ("claim", forge(w.ix_claim(&a), &a, &b)),
    ];
    for (name, ix) in actions {
        let mut ixs = w.pre(&b);
        ixs.push(ix);
        let r = w.km.step(&format!("A's {name} on B's accounts"), &ixs, &[&a.kp]);
        expect_fail(r);
    }
    // Only the account is swapped (A's signer, B's PDA seeds): the seeds bind the signer.
    let mut ix = w.ix_withdraw(&a, 1_000);
    for m in ix.accounts.iter_mut() { if m.pubkey == a.account { m.pubkey = b.account; } }
    let mut ixs = w.pre(&a);
    ixs.push(ix);
    expect_fail(w.km.step("A's signer with B's wsm account", &ixs, &[&a.kp]));
    // A cannot call klend directly on their own obligation either: its owner is the program's account, not A.
    let spy = w.km.spy.clone();
    let dest = a.coll;
    let direct = {
        let fake_user = User { kp: a.kp.insecure_clone(), meta: Pubkey::default(), ob: a.obligation };
        w.km.withdraw(&fake_user, &spy, &dest, 1_000)
    };
    let mut ixs = w.pre(&a);
    ixs.push(direct);
    expect_fail(w.km.step("A calls klend withdraw on their own obligation", &ixs, &[&a.kp]));
    let direct = {
        let fake_user = User { kp: a.kp.insecure_clone(), meta: Pubkey::default(), ob: a.obligation };
        w.km.borrow(&fake_user, &w.km.usdc.clone(), &a.usdc, 100 * 1_000_000, None)
    };
    let mut ixs = w.pre(&a);
    ixs.push(direct);
    expect_fail(w.km.step("A calls klend borrow directly (market is BORROW-permissioned)", &ixs, &[&a.kp]));
    assert_eq!((w.km.env.data(&b.obligation), w.km.env.data(&b.account)), before, "B's obligation and account are untouched");
    // A can open a second account? No: one account per user (seeds).
    let o = w.ix_open(&a);
    expect_fail(w.km.step("A opens a second account", &[o], &[&a.kp]));
}

/// `d1_always_exit` (INV-16): repay and withdraw succeed paused, mid-weekend with an active policy, with a pending Shield
/// advance, when flagged, and with the admin and keeper absent.
#[test]
fn d1_always_exit() {
    let mut w = W::new(VAULT, MARKET_LP);
    let (u, policy) = covered(&mut w, 10, 6_100);
    w.close_friday();
    // The Shield advanced on Sunday (a pending advance), and Credence is paused by the guardian.
    let admin = w.km.env.admin.insecure_clone();
    let price = w.push_fair(-0.08, W::OPEN - 45_000);
    let mut ixs = w.pre(&u);
    ixs.push(w.ix_shield_wsm(&admin.pubkey(), &u, policy, price));
    w.km.step("shield", &ixs, &[&admin]).unwrap();
    let pause = w.km.env.ix_set_paused(&admin.pubkey(), true);
    w.km.env.send_admin(&[pause]).unwrap();
    let cfg: Config = w.km.env.anchor(&config_pda());
    assert!(cfg.paused);
    // Mid-weekend (frozen), paused, policy active, advance pending: repay part, then everything, then withdraw.
    credit(&mut w.km.env, &u.usdc, 7_000 * 1_000_000);
    let r = w.ix_repay(&u, 1_000 * 1_000_000);
    w.go("repay 1,000 (paused, mid-weekend, advance pending)", &u, vec![r], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    // Paused and frozen: a withdrawal inside the normal limit passes the guard...
    let x = w.ix_withdraw(&u, 10_000);
    w.go("withdraw dust inside the limit", &u, vec![x], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    // ...one beyond it is refused while there is debt, and repaying lifts it.
    let x = w.ix_withdraw(&u, 600_000_000);
    err_code(w.go("withdraw beyond the normal limit with debt", &u, vec![x], &[&u.kp]), CoreError::WeekendFreeze);
    let r = w.ix_repay(&u, u64::MAX);
    w.go("repay all", &u, vec![r], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    let x = w.ix_withdraw(&u, u64::MAX);
    w.go("withdraw all (paused, frozen, policy active)", &u, vec![x], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    assert!(w.km.env.token_balance(&u.coll) > 9 * 100_000_000, "the collateral is back in the wallet");
    let c = w.ix_claim(&u);
    w.km.step("claim", &[c], &[&u.kp]).unwrap();
    assert!(w.km.env.svm.get_account(&u.obligation).is_none_or(|a| a.data.is_empty()), "klend closed the emptied obligation");
}

/// Withdraw guard (part of INV-16): the freeze judges a withdrawal against the *normal* limit, rounding against the user.
#[test]
fn d1_exit_guard_is_arithmetic_only() {
    let mut w = W::new(VAULT, MARKET_LP);
    let u = w.user(10, 0);
    open_and_deposit(&mut w, &u, 10);
    let b = w.ix_borrow(&u, 4_000 * 1_000_000); // 51% of the collateral: well under the normal 73%
    w.go("borrow 4,000", &u, vec![b], &[&u.kp]).unwrap();
    // Outside a freeze klend's own limit (the market's LTV 80%) applies: 1 SPYx leaves, debt 4,000 on 6,900 of value.
    let first = w.ix_withdraw(&u, 100_000_000);
    w.go("withdraw 1 SPYx outside a freeze (klend limit)", &u, vec![first], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    in_freeze(&mut w);
    // Collateral worth ~7,036 (9 SPYx): at normal 73% the debt 4,000 needs 5,479 of it; ~1,550 may leave = 1.9 SPYx.
    let ok = w.ix_withdraw(&u, 100_000_000);
    w.go("withdraw 1 SPYx in a freeze (within the normal limit)", &u, vec![ok], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    let too_much = w.ix_withdraw(&u, 100_000_000);
    err_code(w.go("withdraw 1 more (past the normal limit)", &u, vec![too_much], &[&u.kp]), CoreError::WeekendFreeze);
}

/// `d1_no_uncovered_weekend` (INV-17): from the freeze on, no wrapper path adds debt; if the cover fails the account is
/// flagged, nothing is borrowed or paid, and borrowing stays blocked.
#[test]
fn d1_no_uncovered_weekend() {
    let mut w = W::new(VAULT, MARKET_LP);
    let u = w.user(10, 0);
    open_and_deposit(&mut w, &u, 10);
    let b = w.ix_borrow(&u, 6_100 * 1_000_000);
    w.go("borrow before the freeze", &u, vec![b], &[&u.kp]).unwrap();
    // Before the freeze nobody can cover (the debt may still grow).
    let keeper = w.km.env.funded();
    let c = w.ix_auto_cover(&keeper.pubkey(), &u, GROUP_OCT9);
    err_code(w.go("auto-cover too early", &u, vec![c], &[&keeper]), CoreError::TooEarly);
    // In the freeze: no new debt.
    in_freeze(&mut w);
    let b = w.ix_borrow(&u, 100 * 1_000_000);
    err_code(w.go("borrow in the freeze", &u, vec![b], &[&u.kp]), CoreError::WeekendFreeze);
    // A fresh account opened and funded inside the freeze cannot borrow either.
    let v = w.user(10, 0);
    open_and_deposit(&mut w, &v, 10);
    let b = w.ix_borrow(&v, 100 * 1_000_000);
    err_code(w.go("new account borrows in the freeze", &v, vec![b], &[&v.kp]), CoreError::WeekendFreeze);

    // The vault cannot hold the cover: the account is flagged, nothing moves.
    let vault_cash = w.km.env.token_balance(&vault_usdc_pda());
    let debt = w.debt_usdc(&u);
    w.km.env.edit_vault(|v| v.equity = 100 * 1_000_000); // equity of 100 USDC: this cover's worst loss does not fit
    let c = w.ix_auto_cover(&keeper.pubkey(), &u, GROUP_OCT9);
    w.go("auto-cover with an empty vault", &u, vec![c], &[&keeper]).unwrap_or_else(|e| panic!("a refused cover must not fail the batch: {e}"));
    let s = state(&w, &u);
    assert_eq!((s.covered_closure, s.cover_failed_closure, s.addon_paid_total), (0, GROUP_OCT9, 0), "flagged");
    assert!((w.debt_usdc(&u) - debt).abs() < 0.01, "nothing was borrowed");
    assert_eq!(w.km.env.token_balance(&vault_usdc_pda()), vault_cash, "nothing was paid");
    assert!(w.km.env.svm.get_account(&w.policy_of(&u)).is_none(), "no policy exists");
    let b = w.ix_borrow(&u, 100 * 1_000_000);
    expect_fail(w.go("flagged account borrows", &u, vec![b], &[&u.kp]));
    // A cover for the account cannot be bought twice for a closure, nor on a closure that is not a weekend.
    // (A flagged account that is later covered clears the flag: see d1_capacity.)
}

/// A position without headroom for the premium is flagged, not covered: the market's own D/C′ limit holds.
#[test]
fn d1_no_headroom_flags_the_account() {
    let mut w = W::new(VAULT, MARKET_LP);
    let u = w.user(10, 0);
    open_and_deposit(&mut w, &u, 10);
    // Borrow to klend's limit (LTV 80% of 7,817 = 6,253): the premium does not fit under it.
    let b = w.ix_borrow(&u, 6_253_500_000);
    w.go("borrow to the market limit", &u, vec![b], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    in_freeze(&mut w);
    let keeper = w.km.env.funded();
    let c = w.ix_auto_cover(&keeper.pubkey(), &u, GROUP_OCT9);
    let before = w.debt_usdc(&u);
    w.go("auto-cover without headroom", &u, vec![c], &[&keeper]).unwrap_or_else(|e| panic!("{e}"));
    let s = state(&w, &u);
    assert_eq!((s.covered_closure, s.cover_failed_closure), (0, GROUP_OCT9));
    assert!((w.debt_usdc(&u) - before).abs() < 0.01);
}

/// The program's `quote_cover` of a cover on the closure's epoch against the vault as it is now.
fn quote_now(w: &mut W, covered: u64, debt: u64, cap: u64) -> Quote {
    let tk = ticker("SPYx");
    let vault: Vault = w.km.env.anchor(&vault_pda());
    let ix = Instruction::new_with_bytes(
        credence_core::ID,
        &ix::QuoteCover { covered_value: covered, debt, max_payout: cap }.data(),
        acc::QuoteCover {
            config: config_pda(),
            asset: asset_pda(&tk),
            scenarios: scen_pda(&tk, closure::WEEKEND),
            vault: Some(vault_pda()),
            loss: Some(loss_pda(GROUP_OCT9)),
            share_mint: Some(vault.share_mint),
            epoch: Some(epoch_pda(&tk, GROUP_OCT9)),
            earnings: Some(earnings_pda(&tk)),
        }
        .to_account_metas(None),
    );
    let m = w.km.env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    Quote::deserialize(&mut m.return_data.data.as_slice()).unwrap()
}

fn frozen_borrower(vault: u64) -> (W, Wu) {
    let mut w = W::new(vault, MARKET_LP);
    let u = w.user(10, 0);
    open_and_deposit(&mut w, &u, 10);
    let b = w.ix_borrow(&u, 6_000 * 1_000_000);
    w.go("borrow", &u, vec![b], &[&u.kp]).unwrap();
    in_freeze(&mut w);
    (w, u)
}

/// `d1_premium_bounded` (INV-18): the borrowed add-on equals the program's own quote of the cover it buys (taken just
/// before, against the same vault), the vault is paid exactly the premium net of the fee, the cover is for at least the
/// debt that exists after the borrow, and the bound the user is shown is the policy's.
#[test]
fn d1_premium_bounded() {
    // Run 1 learns the cover the loop settles on; run 2 (deterministic) quotes that cover just before buying it.
    let (mut w, u) = frozen_borrower(VAULT);
    let keeper = w.km.env.funded();
    let c = w.ix_auto_cover(&keeper.pubkey(), &u, GROUP_OCT9);
    w.go("auto-cover", &u, vec![c], &[&keeper]).unwrap();
    let want: Policy = w.km.env.anchor(&w.policy_of(&u));

    let (mut w, u) = frozen_borrower(VAULT);
    let keeper = w.km.env.funded();
    let quote = quote_now(&mut w, want.covered_value, want.debt, want.max_payout);
    let vault0: Vault = w.km.env.anchor(&vault_pda());
    let cash0 = w.km.env.token_balance(&vault_usdc_pda());
    let debt0 = w.debt_usdc(&u);
    let c = w.ix_auto_cover(&keeper.pubkey(), &u, GROUP_OCT9);
    w.go("auto-cover", &u, vec![c], &[&keeper]).unwrap();
    let p: Policy = w.km.env.anchor(&w.policy_of(&u));
    println!("    premium {} = quote_cover {} (loading {}), debt {debt0:.2} -> cover for {:.2}", p.premium, quote.premium, quote.shield_loading, p.debt as f64 / 1e6);
    assert_eq!(p.premium, quote.premium, "INV-18: the add-on is exactly the quote of the cover it buys");
    assert_eq!(p.debt, want.debt);
    assert!(p.debt as f64 / 1e6 + 1e-6 >= w.debt_usdc(&u) - 0.02, "the cover is for the debt after the premium (interest of the day aside)");
    assert_eq!(w.km.env.token_balance(&wsm_usdc_pda(&u.kp.pubkey())), 0, "nothing is left in transit");
    let vault1: Vault = w.km.env.anchor(&vault_pda());
    assert_eq!(vault1.total_premiums - vault0.total_premiums, p.premium - p.fee, "the vault is paid exactly the net premium");
    assert_eq!(w.km.env.token_balance(&vault_usdc_pda()) - cash0, p.premium - p.fee);
    assert_eq!(state(&w, &u).addon_paid_total, p.premium);
    // The add-on in whole base units, valued upward against the account's headroom, never below the policy's premium.
    assert!(p.premium > 0);
}

/// `d1_wrapper_cpi_only_v2`: every klend instruction a wrapper transaction runs is a v2 one, the refreshes sit in the same
/// transaction, and Jupiter's program in the transaction makes klend refuse.
#[test]
fn d1_wrapper_cpi_only_v2() {
    use sha2::{Digest, Sha256};
    for (name, disc) in [
        ("deposit_reserve_liquidity_and_obligation_collateral_v2", credence_core::wsm_klend::DEPOSIT_V2_DISC),
        ("borrow_obligation_liquidity_v2", credence_core::wsm_klend::BORROW_V2_DISC),
        ("withdraw_obligation_collateral_and_redeem_reserve_collateral_v2", credence_core::wsm_klend::WITHDRAW_V2_DISC),
        ("repay_obligation_liquidity_v2", credence_core::kamino::REPAY_OBLIGATION_LIQUIDITY_V2_DISC),
    ] {
        assert_eq!(disc, <[u8; 8]>::try_from(&Sha256::digest(format!("global:{name}"))[..8]).unwrap(), "{name}");
    }
    let mut w = W::new(VAULT, MARKET_LP);
    let u = w.user(10, 0);
    let o = w.ix_open(&u);
    let m = w.km.env.send(&[o], &[&u.kp]).unwrap();
    let mut klend_ix: Vec<String> = vec![];
    let mut run = |w: &mut W, ixs: Vec<Instruction>, signers: &[&solana_keypair::Keypair], klend_ix: &mut Vec<String>| {
        w.km.env.svm.warp_to_slot(w.km.env.slot() + 1);
        w.km.env.freshen_scope();
        let m = w.km.env.send(&ixs, signers).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
        // The instruction name klend logs right after each of its own invocations.
        let mut in_klend = false;
        for l in &m.logs {
            if l.starts_with("Program KLend") && l.contains("invoke") {
                in_klend = true;
            } else if in_klend && l.starts_with("Program log: Instruction: ") {
                klend_ix.push(l.trim_start_matches("Program log: Instruction: ").to_string());
                in_klend = false;
            }
        }
        m.logs
    };
    let d = w.ix_deposit(&u, 10 * 100_000_000);
    let mut ixs = w.pre(&u);
    ixs.push(d);
    run(&mut w, ixs, &[&u.kp], &mut klend_ix);
    let b = w.ix_borrow(&u, 3_000 * 1_000_000);
    let mut ixs = w.pre(&u);
    ixs.push(b);
    run(&mut w, ixs, &[&u.kp], &mut klend_ix);
    // Jupiter's program in a klend transaction: klend refuses the borrow (RESTRICTED_PROGRAMS).
    let so = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/programs/jl_vaults.so")).unwrap();
    let jup = anchor_lang::pubkey!("jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi");
    w.km.env.svm.add_program(jup, &so).unwrap();
    let b = w.ix_borrow(&u, 100 * 1_000_000);
    let mut ixs = w.pre(&u);
    ixs.push(Instruction { program_id: jup, accounts: vec![], data: vec![0] });
    ixs.push(b);
    expect_fail(w.km.step("borrow in a transaction that contains Jupiter", &ixs, &[&u.kp]));
    credit(&mut w.km.env, &u.usdc, 3_100 * 1_000_000);
    let r = w.ix_repay(&u, u64::MAX);
    let mut ixs = w.pre(&u);
    ixs.push(r);
    run(&mut w, ixs, &[&u.kp], &mut klend_ix);
    let x = w.ix_withdraw(&u, u64::MAX);
    let mut ixs = w.pre(&u);
    ixs.push(x);
    run(&mut w, ixs, &[&u.kp], &mut klend_ix);
    let _ = m;
    println!("    klend instructions run: {klend_ix:?}");
    let names: Vec<&String> = klend_ix.iter().filter(|n| !n.starts_with("Refresh")).collect();
    assert!(!names.is_empty());
    for n in names {
        assert!(n.ends_with("V2"), "klend instruction {n} is not a v2 instruction");
    }
    for n in ["BorrowObligationLiquidity", "DepositReserveLiquidityAndObligationCollateral", "WithdrawObligationCollateralAndRedeemReserveCollateral", "RepayObligationLiquidity"] {
        assert!(!klend_ix.iter().any(|x| x == n), "the v1 instruction {n} ran");
    }
}

/// `d1_capacity`: auto-cover for many accounts never oversells the vault: INV-2, INV-12 and INV-13 hold after each, the
/// ones that do not fit are flagged, and a flag clears once a cover is bought.
#[test]
fn d1_capacity() {
    // A vault of 3k USDC (limit 1.5k at u_max 50%): room for a few covers of ~6k debt near the cap, not for fourteen.
    let mut w = W::new(3_000 * 1_000_000, MARKET_LP);
    // The borrow-time gate would stop the borrowing first; loosen it so the cover-time capacity (INV-2) is what binds.
    let admin = w.km.env.admin.insecure_clone();
    let loose = credence_core::instructions::wsm::WsmParams { worst_loss_ratio_wad: PCT / 100, ..wsm_params() };
    let set = Instruction::new_with_bytes(credence_core::ID, &ix::SetWsmParams { params: loose, normal_ltv_wad: NORMAL_LTV.to_vec(), enabled: vec![true; 3] }.data(),
        acc::SetWsmParams { admin: admin.pubkey(), config: config_pda(), wsm_market: wsm_market_pda() }.to_account_metas(None));
    w.km.step("set_wsm_params (loose borrow gate)", &[set], &[&admin]).unwrap();
    let mut users = vec![];
    for _ in 0..14 {
        let u = w.user(10, 0);
        open_and_deposit(&mut w, &u, 10);
        let b = w.ix_borrow(&u, 6_200 * 1_000_000);
        w.go("borrow", &u, vec![b], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
        users.push(u);
    }
    in_freeze(&mut w);
    let keeper = w.km.env.funded();
    let (mut covered_n, mut flagged_n) = (0, 0);
    for u in &users {
        let c = w.ix_auto_cover(&keeper.pubkey(), u, GROUP_OCT9);
        w.go("auto-cover", u, vec![c], &[&keeper]).unwrap_or_else(|e| panic!("{e}"));
        let s = state(&w, u);
        if s.covered_closure == GROUP_OCT9 { covered_n += 1 } else { assert_eq!(s.cover_failed_closure, GROUP_OCT9); flagged_n += 1 }
        let v: Vault = w.km.env.anchor(&vault_pda());
        println!("    reserved {} of equity {}", v.reserved_total, v.equity);
        let cfg: Config = w.km.env.anchor(&config_pda());
        let limit = (v.equity as u128) * cfg.u_max_wad as u128 / 1_000_000_000_000_000_000u128;
        assert!(v.reserved_total as u128 <= limit, "INV-2: reserved {} within u_max × equity {limit}", v.reserved_total);
        assert!(w.km.env.token_balance(&vault_usdc_pda()) >= v.reserved_cash().unwrap(), "INV-13: cash covers the reservation");
    }
    println!("    {covered_n} covered, {flagged_n} flagged of {}", users.len());
    assert!(covered_n > 0 && flagged_n > 0, "the vault fills up and the rest are flagged, not oversold");
}

/// The borrow-time gate: a borrow the vault could not carry on the next closure is refused, and so is one past the
/// market's debt cap or D/C′ limit.
#[test]
fn d1_borrow_gates() {
    // Vault of 10k USDC (limit 5k at u_max): the gate's 15% worst-loss ratio allows ~33k of market debt.
    let mut w = W::new(10_000 * 1_000_000, MARKET_LP);
    let u = w.user(100, 0);
    open_and_deposit(&mut w, &u, 100); // ~$78k of SPYx
    let b = w.ix_borrow(&u, 40_000 * 1_000_000);
    err_code(w.go("a borrow the vault cannot carry", &u, vec![b], &[&u.kp]), CoreError::CapacityExceeded);
    let b = w.ix_borrow(&u, 30_000 * 1_000_000);
    w.go("a borrow it can", &u, vec![b], &[&u.kp]).unwrap_or_else(|e| panic!("{e}"));
    let b = w.ix_borrow(&u, 10_000 * 1_000_000);
    err_code(w.go("the next 10k, past the vault's room", &u, vec![b], &[&u.kp]), CoreError::CapacityExceeded);

    // The market's D/C′ limit: 0.945 of C′ (0.85 × 78,174 = 66.4k) is 62.8k, above klend's own LTV (80% = 62.5k).
    // With the limits as proposed klend binds first; the program's limit is the backstop if klend's are ever loosened.
    let mut w = W::new(VAULT, MARKET_LP);
    let u = w.user(100, 0);
    open_and_deposit(&mut w, &u, 100);
    let b = w.ix_borrow(&u, 70_000 * 1_000_000);
    err_code(w.go("past the market's D/C′ limit", &u, vec![b], &[&u.kp]), CoreError::AboveMarketLimit);
    // The market's debt cap.
    let admin = w.km.env.admin.insecure_clone();
    let small = credence_core::instructions::wsm::WsmParams { market_debt_cap: 10_000 * 1_000_000, ..wsm_params() };
    let set = Instruction::new_with_bytes(credence_core::ID, &ix::SetWsmParams { params: small, normal_ltv_wad: NORMAL_LTV.to_vec(), enabled: vec![true; 3] }.data(),
        acc::SetWsmParams { admin: admin.pubkey(), config: config_pda(), wsm_market: wsm_market_pda() }.to_account_metas(None));
    w.km.step("set_wsm_params (debt cap 10k)", &[set], &[&admin]).unwrap();
    let b = w.ix_borrow(&u, 20_000 * 1_000_000);
    err_code(w.go("past the market's debt cap", &u, vec![b], &[&u.kp]), CoreError::MarketCapExceeded);
}

/// `d1_shield_and_settle` is `shield_and_settlement_repay_into_the_account_never_a_wallet` above (INV-7, INV-11).

/// `d1_admin_cannot_seize`: no admin or keeper instruction moves a user's collateral or debt except the documented Shield,
/// settlement and liquidation paths; admin parameters cannot lock an exit.
#[test]
fn d1_admin_cannot_seize() {
    let mut w = W::new(VAULT, MARKET_LP);
    let u = w.user(10, 0);
    open_and_deposit(&mut w, &u, 10);
    let b = w.ix_borrow(&u, 4_000 * 1_000_000);
    w.go("borrow", &u, vec![b], &[&u.kp]).unwrap();
    let admin = w.km.env.admin.insecure_clone();
    let before = (w.km.env.data(&u.obligation), w.km.env.data(&u.account));
    // The admin signs every user instruction with the user's accounts.
    for (name, mut ix) in [
        ("withdraw", w.ix_withdraw(&u, u64::MAX)),
        ("borrow", w.ix_borrow(&u, 1_000_000)),
        ("repay", w.ix_repay(&u, 1_000_000)),
        ("deposit", w.ix_deposit(&u, 1_000)),
        ("claim", w.ix_claim(&u)),
    ] {
        for m in ix.accounts.iter_mut() {
            if m.pubkey == u.kp.pubkey() { m.pubkey = admin.pubkey(); }
        }
        let mut ixs = w.pre(&u);
        ixs.push(ix);
        expect_fail(w.km.step(&format!("admin's {name} on the user's account"), &ixs, &[&admin]));
    }
    // Shield and settlement need a policy of the account: with none, the keeper cannot repay or touch the obligation.
    w.close_friday();
    let fake_policy = w.policy_of(&u);
    let price = w.push_fair(-0.08, W::OPEN - 45_000);
    let mut ixs = w.pre(&u);
    ixs.push(w.ix_shield_wsm(&admin.pubkey(), &u, fake_policy, price));
    expect_fail(w.km.step("keeper's Shield without a policy", &ixs, &[&admin]));
    // set_wsm_params cannot raise the market past its hard bounds, cannot disable an exit, and is admin-only.
    let p = credence_core::instructions::wsm::WsmParams { max_dcp_wad: 990 * PCT / 10, ..wsm_params() };
    let bad = Instruction::new_with_bytes(credence_core::ID, &ix::SetWsmParams { params: p, normal_ltv_wad: NORMAL_LTV.to_vec(), enabled: vec![true; 3] }.data(),
        acc::SetWsmParams { admin: admin.pubkey(), config: config_pda(), wsm_market: wsm_market_pda() }.to_account_metas(None));
    err_code(w.km.step("set_wsm_params above the bound", &[bad], &[&admin]), CoreError::InvalidParam);
    let mallory = w.km.env.funded();
    let ok = Instruction::new_with_bytes(credence_core::ID, &ix::SetWsmParams { params: wsm_params(), normal_ltv_wad: NORMAL_LTV.to_vec(), enabled: vec![false; 3] }.data(),
        acc::SetWsmParams { admin: mallory.pubkey(), config: config_pda(), wsm_market: wsm_market_pda() }.to_account_metas(None));
    err_code(w.km.step("set_wsm_params by a stranger", &[ok], &[&mallory]), CoreError::Unauthorized);
    // The admin disables every asset: new accounts stop, the existing account still repays and withdraws.
    let off = Instruction::new_with_bytes(credence_core::ID, &ix::SetWsmParams { params: wsm_params(), normal_ltv_wad: NORMAL_LTV.to_vec(), enabled: vec![false; 3] }.data(),
        acc::SetWsmParams { admin: admin.pubkey(), config: config_pda(), wsm_market: wsm_market_pda() }.to_account_metas(None));
    w.km.step("admin disables the assets", &[off], &[&admin]).unwrap();
    credit(&mut w.km.env, &u.usdc, 4_100 * 1_000_000);
    let r = w.ix_repay(&u, u64::MAX);
    w.go("repay with the asset disabled", &u, vec![r], &[&u.kp]).unwrap();
    let x = w.ix_withdraw(&u, u64::MAX);
    w.go("withdraw with the asset disabled", &u, vec![x], &[&u.kp]).unwrap();
    assert_ne!(Some(before.0), w.km.env.svm.get_account(&u.obligation).map(|a| a.data));
    assert!(w.km.env.token_balance(&u.coll) > 0);
}

/// `d1_liquidation_still_works`: an unhealthy wrapper obligation is liquidated by klend's normal liquidators; the wrapper
/// blocks nothing. An uncovered account (cover refused) is the case: −15% makes it liquidatable.
#[test]
fn d1_liquidation_still_works() {
    let mut w = W::new(VAULT, MARKET_LP);
    let u = w.user(10, 0);
    open_and_deposit(&mut w, &u, 10);
    let b = w.ix_borrow(&u, 6_200 * 1_000_000);
    w.go("borrow", &u, vec![b], &[&u.kp]).unwrap();
    // A −15% move on Kamino's Scope price: past the 85% threshold.
    let now = w.km.env.now();
    w.km.env.put_scope(344, 781.74 * 0.85, now);
    let liq = w.km.env.funded();
    let liq_usdc = w.km.env.usdc_account(&liq.pubkey(), 100_000 * 1_000_000);
    let liq_spy = token_account_2022(&mut w.km.env, &liq.pubkey(), &SPYX_MINT, 0);
    let coll_dest = Pubkey::new_unique();
    let mut cd = token_account_data(&w.km.spy.coll_mint, &liq.pubkey(), 0);
    cd.truncate(165);
    let l = w.km.env.svm.minimum_balance_for_rent_exemption(165);
    w.km.env.svm.set_account(coll_dest, solana_account::Account { lamports: l, data: cd, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
    let ob = User { kp: u.kp.insecure_clone(), meta: Pubkey::default(), ob: u.obligation };
    let mut ixs = w.pre(&u);
    ixs.push(liquidate(&w.km, &liq, &ob.ob, &liq_usdc, &liq_spy, &coll_dest, 2_000 * 1_000_000));
    let debt0 = w.debt_usdc(&u);
    w.km.step("a stranger liquidates the wrapper obligation", &ixs, &[&liq]).unwrap_or_else(|e| panic!("{e}"));
    assert!(w.debt_usdc(&u) < debt0 - 1_000.0, "klend repaid debt for the liquidator");
    assert!(w.km.env.token_balance(&liq_spy) > 0);
    // The wrapper's exits still work on what is left.
    credit(&mut w.km.env, &u.usdc, 6_000 * 1_000_000);
    let r = w.ix_repay(&u, u64::MAX);
    w.go("repay what is left", &u, vec![r], &[&u.kp]).unwrap();
}

/// The Backstop (W2) liquidates a wrapper obligation too: the vault PDA as liquidator, on the weekend-safe market, with the
/// market's reserve found through `WsmMarket` (INV-8, INV-13 are the Backstop's own tests; this proves the new market path).
#[test]
fn d1_backstop_liquidates_a_wrapper_obligation() {
    use credence_core::{kamino::ReserveView, BackstopParams};
    const W18: u64 = 1_000_000_000_000_000_000;
    let mut w = W::new(VAULT, MARKET_LP);
    let u = w.user(10, 0);
    open_and_deposit(&mut w, &u, 10);
    let b = w.ix_borrow(&u, 6_200 * 1_000_000);
    w.go("borrow", &u, vec![b], &[&u.kp]).unwrap();
    let admin = w.km.env.admin.insecure_clone();
    let spy_res = ReserveView::decode(&w.km.env.data(&w.km.spy.key)).unwrap();
    let usdc_res = ReserveView::decode(&w.km.env.data(&w.km.usdc.key)).unwrap();
    let vault = vault_pda();
    let ata = |o: &Pubkey, m: &Pubkey, p: &Pubkey| ata_of(o, m, p);
    let pool = pda(&[SEED_BACKSTOP]);
    let inv = pda(&[SEED_INVENTORY, &ticker("SPYx")]);
    // The pool's SPYx inventory is initialised on Kamino's xStocks reserve (the asset's own); a liquidation uses the vault's
    // ATA for its withdraw reserve's cToken mint (audit A-35), here the weekend-safe market's.
    let kam_spy = ReserveView::decode(&w.km.env.data(&RESERVE_SPYX)).unwrap();
    let mint_data = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/klend/spyx_collateral_mint.bin")).unwrap();
    let l = w.km.env.svm.minimum_balance_for_rent_exemption(mint_data.len());
    w.km.env.svm.set_account(kam_spy.collateral_mint, solana_account::Account { lamports: l, data: mint_data, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
    let init = vec![
        ix_create_ata(&admin.pubkey(), &vault, &SPYX_MINT, &TOKEN_2022_PROGRAM),
        ix_create_ata(&admin.pubkey(), &vault, &kam_spy.collateral_mint, &TOKEN_PROGRAM),
        ix_create_ata(&admin.pubkey(), &vault, &spy_res.collateral_mint, &TOKEN_PROGRAM),
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::InitBackstop {
                params: BackstopParams {
                    max_share_wad: W18 / 4,
                    haircut_wad: W18 / 10,
                    max_discount_wad: W18 / 100 * 15,
                    sale_premium_wad: W18 / 50,
                    sale_discount_wad: W18 / 20,
                    sale_secs: 7_200,
                    max_price_age_secs: 300,
                },
            }
            .data(),
            acc::InitBackstop { admin: admin.pubkey(), config: config_pda(), pool, system_program: anchor_lang::solana_program::system_program::ID }
                .to_account_metas(None),
        ),
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::InitInventory { ticker: ticker("SPYx") }.data(),
            acc::InitInventory {
                admin: admin.pubkey(),
                config: config_pda(),
                asset: asset_pda(&ticker("SPYx")),
                vault,
                inventory: inv,
                reserve: RESERVE_SPYX,
                tokens: ata(&vault, &SPYX_MINT, &TOKEN_2022_PROGRAM),
                ctokens: ata(&vault, &kam_spy.collateral_mint, &TOKEN_PROGRAM),
                token_program: TOKEN_PROGRAM,
                token_2022_program: TOKEN_2022_PROGRAM,
                system_program: anchor_lang::solana_program::system_program::ID,
            }
            .to_account_metas(None),
        ),
    ];
    let r = w.km.env.send_admin(&init);
    match r {
        Ok(_) => {}
        Err(e) => panic!("backstop init: {:?}\n{:#?}", e.err, e.meta.logs),
    }
    let now = w.km.env.now();
    w.km.env.put_scope(344, 781.74 * 0.80, now);
    let keeper = admin.insecure_clone();
    let mut metas = acc::BackstopLiquidate {
        keeper: keeper.pubkey(),
        config: config_pda(),
        pool,
        asset: asset_pda(&ticker("SPYx")),
        inventory: inv,
        vault,
        vault_usdc: vault_usdc_pda(),
        inv_tokens: ata(&vault, &SPYX_MINT, &TOKEN_2022_PROGRAM),
        inv_ctokens: ata(&vault, &spy_res.collateral_mint, &TOKEN_PROGRAM),
        scope_prices: kl::SCOPE,
        obligation: u.obligation,
        lending_market: credence_core::kamino::WSM_MARKET,
        lending_market_authority: w.km.lma,
        repay_reserve: w.km.usdc.key,
        usdc_mint: USDC_MINT,
        repay_reserve_liquidity_supply: usdc_res.supply_vault,
        withdraw_reserve: w.km.spy.key,
        xstock_mint: SPYX_MINT,
        withdraw_reserve_collateral_mint: spy_res.collateral_mint,
        withdraw_reserve_collateral_supply: spy_res.collateral_supply_vault,
        withdraw_reserve_liquidity_supply: spy_res.supply_vault,
        withdraw_reserve_liquidity_fee_receiver: spy_res.fee_vault,
        token_program: TOKEN_PROGRAM,
        token_2022_program: TOKEN_2022_PROGRAM,
        instruction_sysvar: kl::INSTRUCTIONS_SYSVAR,
        collateral_farm_user_state: KLEND,
        collateral_farm_state: KLEND,
        debt_farm_user_state: KLEND,
        debt_farm_state: KLEND,
        farms_program: kl::FARMS,
        klend_program: KLEND,
    }
    .to_account_metas(None);
    metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(wsm_market_pda(), false));
    let liq = Instruction::new_with_bytes(credence_core::ID, &ix::BackstopLiquidate { repay_amount: 1_000 * 1_000_000, min_received: 0 }.data(), metas);
    let debt0 = w.debt_usdc(&u);
    let cash0 = w.km.env.token_balance(&vault_usdc_pda());
    w.go("backstop_liquidate on the weekend-safe market", &u, vec![liq], &[&keeper]).unwrap_or_else(|e| panic!("{e}"));
    let inv_acc: Inventory = w.km.env.anchor(&inv);
    assert!(inv_acc.qty > 0, "the vault booked the xStock it bought");
    assert!(w.debt_usdc(&u) < debt0 - 500.0);
    assert!(w.km.env.token_balance(&vault_usdc_pda()) < cash0);
}

/// One failure test per instruction: the checks each one makes.
#[test]
fn failure_tests_per_instruction() {
    let mut w = W::new(VAULT, MARKET_LP);
    let admin = w.km.env.admin.insecure_clone();
    let mallory = w.km.env.funded();
    // init_wsm_market: a second call (the PDA exists), a stranger, and bounds are refused.
    let again = W::ix_init_wsm_market(&w.km, wsm_params());
    expect_fail(w.km.step("init_wsm_market twice", &[again], &[&admin]));
    let mut ix = W::ix_init_wsm_market(&w.km, wsm_params());
    ix.accounts[0].pubkey = mallory.pubkey();
    expect_fail(w.km.step("init_wsm_market by a stranger", &[ix], &[&mallory]));
    for bad in [
        credence_core::instructions::wsm::WsmParams { max_dcp_wad: 0, ..wsm_params() },
        credence_core::instructions::wsm::WsmParams { freeze_secs: 60, ..wsm_params() },
        credence_core::instructions::wsm::WsmParams { freeze_secs: 10 * 86_400, ..wsm_params() },
        credence_core::instructions::wsm::WsmParams { worst_loss_ratio_wad: 0, ..wsm_params() },
    ] {
        let ix = Instruction::new_with_bytes(credence_core::ID, &ix::SetWsmParams { params: bad, normal_ltv_wad: NORMAL_LTV.to_vec(), enabled: vec![true; 3] }.data(),
            acc::SetWsmParams { admin: admin.pubkey(), config: config_pda(), wsm_market: wsm_market_pda() }.to_account_metas(None));
        err_code(w.km.step("set_wsm_params out of bounds", &[ix], &[&admin]), CoreError::InvalidParam);
    }
    let ix = Instruction::new_with_bytes(credence_core::ID, &ix::SetWsmParams { params: wsm_params(), normal_ltv_wad: vec![PCT * 20; 3], enabled: vec![true; 3] }.data(),
        acc::SetWsmParams { admin: admin.pubkey(), config: config_pda(), wsm_market: wsm_market_pda() }.to_account_metas(None));
    err_code(w.km.step("a normal limit under the floor", &[ix], &[&admin]), CoreError::InvalidParam);

    // wsm_open: paused is refused.
    let u = w.user(10, 0);
    let pause = w.km.env.ix_set_paused(&admin.pubkey(), true);
    w.km.env.send_admin(&[pause]).unwrap();
    let o = w.ix_open(&u);
    err_code(w.km.step("wsm_open while paused", &[o], &[&u.kp]), CoreError::Paused);
    let unpause = w.km.env.ix_set_paused(&admin.pubkey(), false);
    w.km.env.send_admin(&[unpause]).unwrap();
    let o = w.ix_open(&u);
    w.km.step("wsm_open", &[o], &[&u.kp]).unwrap();

    // wsm_deposit: zero, and a reserve that is not the asset's.
    let d = w.ix_deposit(&u, 0);
    err_code(w.go("deposit 0", &u, vec![d], &[&u.kp]), CoreError::InvalidParam);
    let mut d = w.ix_deposit(&u, 1_000_000);
    for m in d.accounts.iter_mut() { if m.pubkey == w.km.spy.key { m.pubkey = w.km.qqq.key; } }
    err_code(w.go("deposit into another reserve", &u, vec![d], &[&u.kp]), CoreError::InvalidParam);
    let d = w.ix_deposit(&u, 10 * 100_000_000);
    w.go("deposit", &u, vec![d], &[&u.kp]).unwrap();

    // wsm_borrow: zero, while paused, a stale obligation (no refresh in the transaction).
    let b = w.ix_borrow(&u, 0);
    err_code(w.go("borrow 0", &u, vec![b], &[&u.kp]), CoreError::InvalidParam);
    let b = w.ix_borrow(&u, 100 * 1_000_000);
    w.km.env.svm.warp_to_slot(w.km.env.slot() + 1);
    w.km.env.freshen_scope();
    err_code(w.km.step("borrow without the refreshes", &[b], &[&u.kp]), CoreError::ObligationNotRefreshed);
    let pause = w.km.env.ix_set_paused(&admin.pubkey(), true);
    w.km.env.send_admin(&[pause]).unwrap();
    let b = w.ix_borrow(&u, 100 * 1_000_000);
    err_code(w.go("borrow while paused", &u, vec![b], &[&u.kp]), CoreError::Paused);
    let o2 = w.user(1, 0);
    let o = w.ix_open(&o2);
    err_code(w.km.step("wsm_open while paused", &[o], &[&o2.kp]), CoreError::Paused);
    let re = w.ix_reopen(&u);
    err_code(w.km.step("wsm_reopen while paused", &[re], &[&u.kp]), CoreError::Paused);
    let unpause = w.km.env.ix_set_paused(&admin.pubkey(), false);
    w.km.env.send_admin(&[unpause]).unwrap();
    // wsm_reopen with the obligation alive.
    let re = w.ix_reopen(&u);
    err_code(w.km.step("wsm_reopen with a live obligation", &[re], &[&u.kp]), CoreError::InvalidParam);

    // wsm_repay with a debt-free obligation: nothing to repay is a klend refusal, not a Credence state.
    let r = w.ix_repay(&u, 1_000_000);
    expect_fail(w.go("repay with no borrow", &u, vec![r], &[&u.kp]));
    // wsm_claim moves only the account's own USDC to the owner's wallet: a stranger's destination is refused.
    let mut c = w.ix_claim(&u);
    for m in c.accounts.iter_mut() { if m.pubkey == u.usdc { m.pubkey = w.km.env.usdc_account(&mallory.pubkey(), 0); } }
    expect_fail(w.km.step("claim to a stranger's account", &[c], &[&u.kp]));

    // wsm_auto_cover: not a weekend closure, twice, paused.
    let keeper = w.km.env.funded();
    let b = w.ix_borrow(&u, 6_000 * 1_000_000);
    w.go("borrow", &u, vec![b], &[&u.kp]).unwrap();
    in_freeze(&mut w);
    let c = w.ix_auto_cover(&keeper.pubkey(), &u, GROUP_OCT9);
    w.go("auto-cover", &u, vec![c], &[&keeper]).unwrap();
    let c = w.ix_auto_cover(&keeper.pubkey(), &u, GROUP_OCT9);
    expect_fail(w.go("auto-cover twice", &u, vec![c], &[&keeper]));
    let pause = w.km.env.ix_set_paused(&admin.pubkey(), true);
    w.km.env.send_admin(&[pause]).unwrap();
    let v = w.user(10, 0);
    let c = w.ix_auto_cover(&keeper.pubkey(), &v, GROUP_OCT9);
    expect_fail(w.km.step("auto-cover for an account that does not exist", &[c], &[&keeper]));
}
