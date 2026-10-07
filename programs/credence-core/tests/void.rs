//! Review fix 2: `void_epoch` and `refund_policy`. An epoch whose Friday close is never stored is voided `VOID_AFTER`
//! past the close; each policy's net premium goes back to its owner and the group releases as on settlement, also when
//! the group mixes a voided ticker with a settled one.

mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use credence_core::{oracle, state::*, CoreError, SETTLE_GRACE, VOID_AFTER};
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000;
const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;

struct Buyer {
    usdc: Pubkey,
    policy: Pubkey,
}

/// Buys cover on a copy of the real obligation (debt × 1.25) whose deposit is moved to `t`'s reserve, with klend's
/// unhealthy borrow value recomputed at that reserve's liquidation threshold.
fn buy(env: &mut Env, t: &str, reserve: Pubkey) -> Buyer {
    let kp = env.funded();
    let usdc = env.usdc_account(&kp.pubkey(), 100_000_000_000);
    let lt = credence_core::kamino::ReserveView::decode(&env.data(&reserve)).unwrap().liquidation_threshold_pct as u128;
    let obligation = env.put_obligation(&kp.pubkey(), |d| {
        ob::scale_debt(d, 125, 100);
        ob::put(d, ob::OB_DEPOSITS + ob::DEP_RESERVE, reserve.as_ref());
        let unhealthy = ob::get_u128(d, ob::OB_DEPOSITED_VALUE_SF) * lt / 100;
        ob::put(d, ob::OB_UNHEALTHY_BORROW_VALUE_SF, &unhealthy.to_le_bytes());
    });
    let debt = 5_000_000_000; // 5,000 USDC cap
    let a = BuyArgs {
        buyer: kp.pubkey(),
        buyer_usdc: usdc,
        obligation,
        deposit_reserve: reserve,
        ticker: ticker(t),
        closure_id: GROUP_OCT9,
        max_payout: debt,
        max_premium: u64::MAX,
    };
    let ix = env.ix_buy_cover(&a);
    env.send(&[ix], &[&kp]).unwrap_or_else(|e| panic!("{t}: {:?}\n{:#?}", e.err, e.meta.logs));
    let policy = policy_pda(&epoch_pda(&ticker(t), GROUP_OCT9), &kp.pubkey(), &obligation);
    Buyer { usdc, policy }
}

fn set_fee(env: &mut Env, bps: u16) {
    let a = env.admin.pubkey();
    let mut p = default_params(a, a);
    p.fee_bps = bps;
    let ix = env.ix_set_params(&a, p);
    env.send_admin(&[ix]).unwrap();
}

#[test]
fn void_epoch_refunds_net_premium_and_releases_group() {
    let mut env = Env::real(LP);
    set_fee(&mut env, 1_000); // 10%: the fee is not refunded
    let b = buy(&mut env, "SPYx", RESERVE_SPYX);
    let p: Policy = env.anchor(&b.policy);
    assert!(p.fee > 0 && p.fee == p.premium / 10);
    let v0: Vault = env.anchor(&vault_pda());
    assert_eq!((v0.live_groups, v0.premiums_unearned), (1, p.premium - p.fee));
    let anyone = env.funded();
    let spy = ticker("SPYx");

    // Not before close + VOID_AFTER.
    env.set_time(OCT9_CLOSE + VOID_AFTER - 1);
    let ix = env.ix_void_epoch(&anyone.pubkey(), spy, GROUP_OCT9);
    assert_err(env.send(&[ix.clone()], &[&anyone]), code(CoreError::TooEarly));
    // No refund before the void.
    let r = env.ix_refund(&anyone.pubkey(), b.policy, b.usdc);
    assert_err(env.send(&[r.clone()], &[&anyone]), code(CoreError::WrongEpochState));

    env.set_time(OCT9_CLOSE + VOID_AFTER);
    env.send(&[ix.clone()], &[&anyone]).unwrap();
    assert_eq!(env.anchor::<Epoch>(&epoch_pda(&spy, GROUP_OCT9)).state, epoch_state::VOIDED);
    env.svm.warp_to_slot(env.slot() + 1);
    assert_err(env.send(&[ix], &[&anyone]), code(CoreError::WrongEpochState));

    // A voided epoch takes no close, no settlement.
    let a: AssetConfig = env.zc(&asset_pda(&spy));
    let u = env.put_price(&Px::new(a.feed_equity, 777.05, OCT9_CLOSE - 1));
    let x = env.put_price(&Px::new(a.feed_xstock, 777.05 * 1.0057, OCT9_CLOSE - 300));
    let admin = env.admin.pubkey();
    let snap = env.ix_snapshot(&admin, "SPYx", GROUP_OCT9, u, Some(x));
    assert_err(env.send_admin(&[snap]), code(CoreError::WrongEpochState));

    // Refund: net premium back to the owner (only to the owner), group released, equity untouched.
    let other = env.usdc_account(&anyone.pubkey(), 0);
    let bad = env.ix_refund(&anyone.pubkey(), b.policy, other);
    assert_fails(env.send(&[bad], &[&anyone]));
    let wallet0 = env.token_balance(&b.usdc);
    env.send(&[r.clone()], &[&anyone]).unwrap();
    assert_eq!(env.token_balance(&b.usdc) - wallet0, p.premium - p.fee);
    assert_eq!(env.anchor::<Policy>(&b.policy).state, policy_state::REFUNDED);
    let v: Vault = env.anchor(&vault_pda());
    let l: LossVector = env.zc(&loss_pda(GROUP_OCT9));
    assert_eq!(l.settled, 1);
    assert_eq!((v.live_groups, v.reserved_total, v.premiums_unearned, v.equity), (0, 0, 0, LP));
    assert_eq!(env.token_balance(&vault_usdc_pda()), LP);
    let e: Epoch = env.anchor(&epoch_pda(&spy, GROUP_OCT9));
    assert_eq!((e.policies_settled, e.total_premium, e.total_payout), (1, 0, 0));
    // Once.
    env.svm.warp_to_slot(env.slot() + 1);
    assert_err(env.send(&[r], &[&anyone]), code(CoreError::WrongEpochState));
    // Deposits open again.
    let (lp, u, sh) = env.lp(1_000_000);
    let ix = env.ix_deposit(&lp.pubkey(), u, sh, 1_000_000);
    env.send(&[ix], &[&lp]).unwrap();
}

/// A stored close cannot be voided.
#[test]
fn void_refused_once_close_stored() {
    let mut env = Env::real(LP);
    let a: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    env.set_time(OCT9_CLOSE + 30);
    let u = env.put_price(&Px::new(a.feed_equity, 777.05, OCT9_CLOSE - 1));
    let x = env.put_price(&Px::new(a.feed_xstock, 777.05 * 1.0057, OCT9_CLOSE - 300));
    let admin = env.admin.pubkey();
    let snap = env.ix_snapshot(&admin, "SPYx", GROUP_OCT9, u, Some(x));
    env.send_admin(&[snap]).unwrap();
    env.set_time(OCT9_CLOSE + VOID_AFTER);
    let ix = env.ix_void_epoch(&admin, ticker("SPYx"), GROUP_OCT9);
    assert_err(env.send_admin(&[ix]), code(CoreError::WrongEpochState));
}

/// One group, two tickers: SPYx never gets its close and is voided; QQQx closes, settles at a −10% gap and pays. The
/// group releases only when both are done, with only QQQx's premium earned.
#[test]
fn group_mixing_voided_and_settled_ticker_releases() {
    let mut env = Env::real(LP);
    let spy = buy(&mut env, "SPYx", RESERVE_SPYX);
    let qqq = buy(&mut env, "QQQx", RESERVE_QQQX);
    let (ps, pq): (Policy, Policy) = (env.anchor(&spy.policy), env.anchor(&qqq.policy));
    let l: LossVector = env.zc(&loss_pda(GROUP_OCT9));
    assert_eq!((l.policy_count, l.premiums), (2, ps.premium + pq.premium));
    let admin = env.admin.pubkey();

    // QQQx settles on its 24/7 xStock feed (no cross-check needed in the test).
    let mut ap = real_asset_params(1);
    ap.settle_source = oracle::source::XSTOCK;
    let ix = env.ix_update_asset(&admin, ticker("QQQx"), ap);
    env.send_admin(&[ix]).unwrap();
    let qa: AssetConfig = env.zc(&asset_pda(&ticker("QQQx")));
    env.set_time(OCT9_CLOSE + 30);
    let c = env.put_push(&Px::new(qa.feed_xstock, 600.0, OCT9_CLOSE - 1));
    let snap = env.ix_snapshot(&admin, "QQQx", GROUP_OCT9, c, None);
    env.send_admin(&[snap]).unwrap();

    // SPYx: no close; voided and refunded first. The group is still live (QQQx pending).
    env.set_time(OCT9_CLOSE + VOID_AFTER);
    let ix = env.ix_void_epoch(&admin, ticker("SPYx"), GROUP_OCT9);
    env.send_admin(&[ix]).unwrap();
    let r = env.ix_refund(&admin, spy.policy, spy.usdc);
    env.send_admin(&[r]).unwrap();
    let v: Vault = env.anchor(&vault_pda());
    assert_eq!((v.live_groups, v.premiums_unearned), (1, pq.premium));
    assert!(v.reserved_total > 0);

    // QQQx opens 10% down; the policy settles (wallet path after the grace: klend is not loaded in this test).
    let o = env.put_push(&Px::new(qa.feed_xstock, 540.0, OCT12_OPEN + 30));
    env.set_time(OCT12_OPEN + 301);
    let post = env.ix_post(&admin, "QQQx", GROUP_OCT9, &[o], None);
    env.send_admin(&[post]).unwrap();
    let e: Epoch = env.anchor(&epoch_pda(&ticker("QQQx"), GROUP_OCT9));
    let payout = credence_core::pricing::realized_payout(pq.covered_value, pq.debt, pq.max_payout, e.close_price_wad, e.settle_price_wad).unwrap();
    assert!(payout > 0);
    env.set_time(e.settled_at + SETTLE_GRACE);
    let wallet0 = env.token_balance(&qqq.usdc);
    let ix = env.ix_settle_to_wallet(&admin, qqq.policy, qqq.usdc);
    env.send_admin(&[ix]).unwrap();
    assert_eq!(env.token_balance(&qqq.usdc) - wallet0, payout);

    let v: Vault = env.anchor(&vault_pda());
    let l: LossVector = env.zc(&loss_pda(GROUP_OCT9));
    assert_eq!((l.settled, l.policies_settled, l.premiums), (1, 2, pq.premium));
    assert_eq!((v.live_groups, v.reserved_total, v.premiums_unearned), (0, 0, 0));
    assert_eq!(v.equity, LP + pq.premium - payout);
    assert_eq!(env.token_balance(&vault_usdc_pda()), v.equity);
}
