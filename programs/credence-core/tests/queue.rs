//! Task 3.1: epoch-gated deposits and withdrawals. A request waits for the newest group live when it was made and is
//! applied at the NAV after that group (and every earlier one) settled or was voided (INV-6), with rounding against
//! the LP (INV-5). Queued withdrawals are priced out of new cover's capacity.

mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use credence_core::{math::LOCKED_SHARES, state::*, CoreError, SETTLE_GRACE, VOID_AFTER};
use solana_keypair::Keypair;
use solana_signer::Signer;

const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;
const GROUP_OCT16: u32 = 20261016;
const SPY: f64 = 777.05;

struct Lp {
    kp: Keypair,
    usdc: Pubkey,
    shares: Pubkey,
}

fn lp_deposit(env: &mut Env, amount: u64) -> Lp {
    let (kp, usdc, shares) = env.lp(amount);
    let ix = env.ix_deposit(&kp.pubkey(), usdc, shares, amount);
    env.send(&[ix], &[&kp]).unwrap();
    Lp { kp, usdc, shares }
}

struct Cover {
    usdc: Pubkey,
    policy: Pubkey,
}

/// Cover on a copy of the real obligation (debt scaled by `num/den`) for `group`, bought now.
fn buy(env: &mut Env, group: u32, num: u128, den: u128, cap: u64) -> Result<Cover, String> {
    let kp = env.funded();
    let usdc = env.usdc_account(&kp.pubkey(), 100_000_000_000);
    let obligation = env.put_obligation(&kp.pubkey(), |d| ob::scale_debt(d, num, den));
    let a = BuyArgs {
        buyer: kp.pubkey(),
        buyer_usdc: usdc,
        obligation,
        deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"),
        closure_id: group,
        max_payout: cap,
        max_premium: u64::MAX,
    };
    let ix = env.ix_buy_cover(&a);
    env.send(&[ix], &[&kp]).map_err(|e| format!("{:?}", e.err))?;
    Ok(Cover { usdc, policy: policy_pda(&epoch_pda(&ticker("SPYx"), group), &obligation) })
}

/// Friday close and Monday open for SPYx in the Oct 9 group (EQUITY source, cross-checked), opening at SPY × (1 + r).
fn price_oct9(env: &mut Env, r: f64) {
    let a: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    let k = env.admin.pubkey();
    env.set_time(OCT9_CLOSE + 30);
    let p = env.put_price(&Px::new(a.feed_equity, SPY, OCT9_CLOSE - 1));
    let x = env.put_price(&Px::new(a.feed_xstock, SPY * 1.0057, OCT9_CLOSE - 300));
    let ix = env.ix_snapshot(&k, "SPYx", GROUP_OCT9, p, Some(x));
    env.send_admin(&[ix]).unwrap();
    let u = env.put_price(&Px::new(a.feed_equity, SPY * (1.0 + r), OCT12_OPEN + 30));
    let x = env.put_price(&Px::new(a.feed_xstock, SPY * (1.0 + r) * 1.0057, OCT12_OPEN + 60));
    env.set_time(OCT12_OPEN + 301);
    let ix = env.ix_post(&k, "SPYx", GROUP_OCT9, &[u], Some(x));
    env.send_admin(&[ix]).unwrap();
}

/// Settles a policy through the wallet path (klend is not loaded in these tests), after the grace period.
fn settle_to_wallet(env: &mut Env, c: &Cover) {
    let e: Epoch = env.anchor(&env.anchor::<Policy>(&c.policy).epoch);
    if env.now() < e.settled_at + SETTLE_GRACE {
        env.set_time(e.settled_at + SETTLE_GRACE);
    }
    let k = env.admin.pubkey();
    let ix = env.ix_settle_to_wallet(&k, c.policy, c.usdc);
    env.send_admin(&[ix]).unwrap();
}

fn nav(env: &Env) -> (u64, u64) {
    (env.anchor::<Vault>(&vault_pda()).equity, env.mint_supply(&shares_pda()))
}

/// INV-6: a withdrawal requested while the Oct 9 group is live is paid only after the group settles, at the NAV after
/// settlement (the LP kept bearing the weekend's loss and earning its premium).
#[test]
fn inv6_withdrawal_paid_only_after_its_group_settles() {
    let mut env = Env::real(0);
    let alice = lp_deposit(&mut env, 1_000_000_000_000);
    let bob = lp_deposit(&mut env, 1_000_000_000_000);
    let c = buy(&mut env, GROUP_OCT9, 125, 100, 50_000_000_000).unwrap();
    let premium = env.anchor::<Policy>(&c.policy).premium;

    let shares = env.token_balance(&alice.shares);
    let ix = env.ix_request_withdraw(&alice.kp.pubkey(), alice.shares, shares);
    env.send(&[ix], &[&alice.kp]).unwrap();
    let ticket = withdraw_ticket_pda(&alice.kp.pubkey(), GROUP_OCT9);
    let t: QueueTicket = env.anchor(&ticket);
    assert_eq!((t.wait_group, t.kind, t.amount), (GROUP_OCT9, ticket_kind::WITHDRAW, shares));
    assert_eq!((env.token_balance(&alice.shares), env.token_balance(&share_escrow_pda())), (0, shares + LOCKED_SHARES));
    assert_eq!(env.anchor::<Vault>(&vault_pda()).queued_withdraw_shares, shares);

    let k = env.admin.pubkey();
    let process = |env: &Env| env.ix_process_withdrawal(&k, ticket, alice.usdc);
    assert_err(env.send_admin(&[process(&env)]), code(CoreError::QueueNotReady));
    // The epoch has its settlement price, but the policy is not settled yet: still not paid.
    price_oct9(&mut env, -0.10);
    assert_err(env.send_admin(&[process(&env)]), code(CoreError::QueueNotReady));

    settle_to_wallet(&mut env, &c);
    let payout = env.anchor::<Policy>(&c.policy).payout;
    assert!(payout > 0);
    let (equity, supply) = nav(&env);
    assert_eq!(equity, 2_000_000_000_000 + premium - payout);
    let want = (shares as u128 * equity as u128 / supply as u128) as u64;
    let usdc0 = env.token_balance(&alice.usdc);
    env.send_admin(&[process(&env)]).unwrap();
    assert_eq!(env.token_balance(&alice.usdc) - usdc0, want, "paid at the post-settlement NAV, rounded down");
    assert!(env.svm.get_account(&ticket).map_or(true, |a| a.lamports == 0), "ticket closed");
    let v: Vault = env.anchor(&vault_pda());
    assert_eq!((v.queued_withdraw_shares, v.equity), (0, equity - want));
    assert_eq!(env.token_balance(&share_escrow_pda()), LOCKED_SHARES);
    assert_eq!(env.mint_supply(&shares_pda()), supply - shares);
    // Bob's NAV per share did not fall (INV-5).
    let (e1, s1) = nav(&env);
    assert!(e1 as u128 * supply as u128 >= equity as u128 * s1 as u128);
    assert_eq!(env.token_balance(&vault_usdc_pda()), v.equity, "every USDC accounted for");
    let _ = bob;
}

/// INV-6: a withdrawal queued during a live group whose close never came is paid once the epoch is voided and its
/// policies refunded: at the original NAV, since the premium went back.
#[test]
fn inv6_withdrawal_paid_after_group_voided() {
    let mut env = Env::real(0);
    let alice = lp_deposit(&mut env, 1_000_000_000_000);
    let c = buy(&mut env, GROUP_OCT9, 125, 100, 50_000_000_000).unwrap();
    let shares = env.token_balance(&alice.shares) / 2;
    let ix = env.ix_request_withdraw(&alice.kp.pubkey(), alice.shares, shares);
    env.send(&[ix], &[&alice.kp]).unwrap();
    let ticket = withdraw_ticket_pda(&alice.kp.pubkey(), GROUP_OCT9);
    let k = env.admin.pubkey();
    env.set_time(OCT9_CLOSE + VOID_AFTER);
    assert_err(env.send_admin(&[env.ix_process_withdrawal(&k, ticket, alice.usdc)]), code(CoreError::QueueNotReady));
    let ix = env.ix_void_epoch(&k, ticker("SPYx"), GROUP_OCT9);
    env.send_admin(&[ix]).unwrap();
    assert_err(env.send_admin(&[env.ix_process_withdrawal(&k, ticket, alice.usdc)]), code(CoreError::QueueNotReady));
    let ix = env.ix_refund(&k, c.policy, c.usdc);
    env.send_admin(&[ix]).unwrap();
    let usdc0 = env.token_balance(&alice.usdc);
    env.send_admin(&[env.ix_process_withdrawal(&k, ticket, alice.usdc)]).unwrap();
    assert_eq!(env.token_balance(&alice.usdc) - usdc0, shares, "NAV 1.0: the weekend never happened");
}

/// A deposit during a live group is queued (not equity, no share of this weekend's premium) and minted at the NAV
/// after the group settles. INV-5 for both queued operations: NAV per share never falls.
#[test]
fn inv5_queued_deposit_and_withdrawal_never_lower_nav() {
    let mut env = Env::real(0);
    let alice = lp_deposit(&mut env, 1_000_000_000_007);
    let c = buy(&mut env, GROUP_OCT9, 125, 100, 50_000_000_000).unwrap();
    let premium = env.anchor::<Policy>(&c.policy).premium;

    let (carol, cu, csh) = env.lp(500_000_000_003);
    let ix = env.ix_deposit(&carol.pubkey(), cu, csh, 1_000_000);
    assert_err(env.send(&[ix], &[&carol]), code(CoreError::VaultLocked));
    let ix = env.ix_request_deposit(&carol.pubkey(), cu, 999_999);
    assert_err(env.send(&[ix], &[&carol]), code(CoreError::InvalidParam));
    let ix = env.ix_request_deposit(&carol.pubkey(), cu, 300_000_000_001);
    env.send(&[ix], &[&carol]).unwrap();
    env.svm.warp_to_slot(env.slot() + 1);
    let ix = env.ix_request_deposit(&carol.pubkey(), cu, 200_000_000_002); // adds to the same ticket
    env.send(&[ix], &[&carol]).unwrap();
    let dticket = deposit_ticket_pda(&carol.pubkey(), GROUP_OCT9);
    assert_eq!(env.anchor::<QueueTicket>(&dticket).amount, 500_000_000_003);
    let v: Vault = env.anchor(&vault_pda());
    assert_eq!((v.queued_deposits, v.equity), (500_000_000_003, 1_000_000_000_007), "queued USDC is not equity");

    let k = env.admin.pubkey();
    assert_err(env.send_admin(&[env.ix_process_deposit(&k, dticket, csh, cu)]), code(CoreError::QueueNotReady));
    // Gap up: no payout, the premium is earned by Alice alone.
    price_oct9(&mut env, 0.02);
    settle_to_wallet(&mut env, &c);
    let (e0, s0) = nav(&env);
    assert_eq!(e0, 1_000_000_000_007 + premium);
    env.send_admin(&[env.ix_process_deposit(&k, dticket, csh, cu)]).unwrap();
    let (e1, s1) = nav(&env);
    let minted = env.token_balance(&csh);
    assert_eq!(minted as u128, 500_000_000_003u128 * s0 as u128 / e0 as u128);
    assert_eq!((e1, s1), (e0 + 500_000_000_003, s0 + minted));
    assert!(e1 as u128 * s0 as u128 >= e0 as u128 * s1 as u128, "INV-5: deposit lowered NAV");
    assert_eq!(env.anchor::<Vault>(&vault_pda()).queued_deposits, 0);

    // Withdrawal with no live group: wait group 0, processable at once; NAV does not fall.
    let part = env.token_balance(&alice.shares) / 3;
    let ix = env.ix_request_withdraw(&alice.kp.pubkey(), alice.shares, part);
    env.send(&[ix], &[&alice.kp]).unwrap();
    let wticket = withdraw_ticket_pda(&alice.kp.pubkey(), 0);
    env.send_admin(&[env.ix_process_withdrawal(&k, wticket, alice.usdc)]).unwrap();
    let (e2, s2) = nav(&env);
    assert!(e2 as u128 * s1 as u128 >= e1 as u128 * s2 as u128, "INV-5: withdrawal lowered NAV");
    assert_eq!(env.token_balance(&vault_usdc_pda()), e2);
}

/// New cover is sized without the queued withdrawals: a purchase that fits the vault is refused once most of the
/// equity has asked to leave.
#[test]
fn capacity_excludes_queued_withdrawals() {
    let cap = 20_000_000_000; // 20,000 USDC on a position at D/C′ ≈ 0.98
    let mut free = Env::real(0);
    lp_deposit(&mut free, 100_000_000_000);
    buy(&mut free, GROUP_OCT9, 980, 755, cap).unwrap();

    let mut env = Env::real(0);
    let alice = lp_deposit(&mut env, 100_000_000_000);
    let ix = env.ix_request_withdraw(&alice.kp.pubkey(), alice.shares, 90_000_000_000);
    env.send(&[ix], &[&alice.kp]).unwrap();
    let err = buy(&mut env, GROUP_OCT9, 980, 755, cap).err().unwrap();
    assert!(
        err.contains(&format!("Custom({})", code(CoreError::CapacityExceeded)))
            || err.contains(&format!("Custom({})", code(CoreError::ConcentrationExceeded))),
        "{err}"
    );
}

/// Two groups live (Oct 9 settling while Oct 16 sales run): a ticket waits only for the groups live when it was made.
#[test]
fn withdrawal_waits_only_for_groups_live_at_request() {
    let mut env = Env::real(0);
    let alice = lp_deposit(&mut env, 1_000_000_000_000);
    let bob = lp_deposit(&mut env, 1_000_000_000_000);
    let c9 = buy(&mut env, GROUP_OCT9, 125, 100, 50_000_000_000).unwrap();
    let ix = env.ix_request_withdraw(&alice.kp.pubkey(), alice.shares, 1_000_000_000);
    env.send(&[ix], &[&alice.kp]).unwrap();

    // Monday Oct 12: Oct 9 has its price; Oct 16 sales are open and take a policy before Oct 9's policy settles.
    price_oct9(&mut env, 0.01);
    let k = env.admin.pubkey();
    let ixs = [env.ix_open_group(&k, GROUP_OCT16), env.ix_open_epoch(&k, ticker("SPYx"), GROUP_OCT16)];
    env.send_admin(&ixs).unwrap();
    buy(&mut env, GROUP_OCT16, 125, 100, 50_000_000_000).unwrap();
    let v: Vault = env.anchor(&vault_pda());
    assert_eq!((v.live_groups, v.newest_live()), (2, GROUP_OCT16));
    let ix = env.ix_request_withdraw(&bob.kp.pubkey(), bob.shares, 1_000_000_000);
    env.send(&[ix], &[&bob.kp]).unwrap();
    let (ta, tb) = (withdraw_ticket_pda(&alice.kp.pubkey(), GROUP_OCT9), withdraw_ticket_pda(&bob.kp.pubkey(), GROUP_OCT16));

    settle_to_wallet(&mut env, &c9);
    let v: Vault = env.anchor(&vault_pda());
    assert_eq!((v.live_groups, v.live.iter().filter(|g| **g != 0).collect::<Vec<_>>()), (1, vec![&GROUP_OCT16]));
    env.send_admin(&[env.ix_process_withdrawal(&k, ta, alice.usdc)]).unwrap();
    assert_err(env.send_admin(&[env.ix_process_withdrawal(&k, tb, bob.usdc)]), code(CoreError::QueueNotReady));
}

#[test]
fn queue_failures() {
    let mut env = Env::real(0);
    let alice = lp_deposit(&mut env, 1_000_000_000);
    let k = env.admin.pubkey();
    // Zero shares, more shares than held.
    let ix = env.ix_request_withdraw(&alice.kp.pubkey(), alice.shares, 0);
    assert_err(env.send(&[ix], &[&alice.kp]), code(CoreError::InvalidParam));
    let ix = env.ix_request_withdraw(&alice.kp.pubkey(), alice.shares, 1_000_000_001);
    assert_fails(env.send(&[ix], &[&alice.kp]));
    // Someone else's share account as the source.
    let (mallory, mu, msh) = env.lp(1_000_000);
    let ix = env.ix_request_withdraw(&mallory.pubkey(), alice.shares, 1);
    assert_fails(env.send(&[ix], &[&mallory]));
    // Payout only to the ticket owner's USDC account; shares only to the owner's share account.
    let ix = env.ix_request_withdraw(&alice.kp.pubkey(), alice.shares, 1_000);
    env.send(&[ix], &[&alice.kp]).unwrap();
    let t = withdraw_ticket_pda(&alice.kp.pubkey(), 0);
    assert_fails(env.send_admin(&[env.ix_process_withdrawal(&k, t, mu)]));
    let ix = env.ix_request_deposit(&mallory.pubkey(), mu, 1_000_000);
    env.send(&[ix], &[&mallory]).unwrap();
    let d = deposit_ticket_pda(&mallory.pubkey(), 0);
    assert_fails(env.send_admin(&[env.ix_process_deposit(&k, d, alice.shares, mu)]));
    env.send_admin(&[env.ix_process_deposit(&k, d, msh, mu)]).unwrap();
    // A deposit ticket cannot be paid out as a withdrawal (different seeds and kind).
    let mut ix = env.ix_process_withdrawal(&k, t, alice.usdc);
    ix.accounts[6].pubkey = d;
    assert_fails(env.send_admin(&[ix]));
    let once = env.ix_process_withdrawal(&k, t, alice.usdc);
    env.send_admin(&[once.clone()]).unwrap();
    // Once (the ticket is closed).
    env.svm.warp_to_slot(env.slot() + 1);
    assert_fails(env.send_admin(&[once]));
}

/// Audit A-04: a weekend whose payouts take all of the vault's equity leaves shares outstanding with no value, so a
/// deposit queued during it cannot be priced (no shares at NAV 0). It must not stay locked in the vault forever: the
/// queued USDC goes back to its owner and the ticket closes.
#[test]
fn queued_deposit_refunded_when_vault_cannot_mint() {
    let mut env = Env::real(0);
    let _alice = lp_deposit(&mut env, 1_000_000_000);
    let (bob, bu, bsh) = env.lp(500_000_000);
    let ix = env.ix_request_deposit(&bob.pubkey(), bu, 500_000_000);
    env.send(&[ix], &[&bob]).unwrap();
    env.edit_vault(|v| v.equity = 0); // every USDC of equity paid out on a weekend worse than any stress scenario
    let supply = env.mint_supply(&shares_pda());
    let d = deposit_ticket_pda(&bob.pubkey(), 0);
    let k = env.admin.pubkey();
    env.send_admin(&[env.ix_process_deposit(&k, d, bsh, bu)]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    assert_eq!(env.token_balance(&bu), 500_000_000, "the queued USDC went back");
    assert_eq!((env.token_balance(&bsh), env.mint_supply(&shares_pda())), (0, supply));
    assert_eq!(env.anchor::<Vault>(&vault_pda()).queued_deposits, 0);
    assert!(env.svm.get_account(&d).map_or(true, |a| a.lamports == 0), "ticket closed");
}

/// Audit A-11 (info): changing σ mid-weekend. `update_asset` with a new σ clears the gap factors, so new sales stop
/// (`StaleGapFactors`) until `compute_gap_factors` runs again; open policies are unaffected: their payout is fixed by
/// the snapshot and the realised prices (σ never enters it), and the capacity they reserved stays reserved.
#[test]
fn sigma_change_mid_weekend_stops_sales_but_not_open_policies() {
    let mut env = Env::real(0);
    let _lp = lp_deposit(&mut env, 1_000_000_000_000);
    let c = buy(&mut env, GROUP_OCT9, 125, 100, 50_000_000_000).unwrap();
    let reserved = env.anchor::<Vault>(&vault_pda()).reserved_total;

    let admin = env.admin.pubkey();
    let mut p = real_asset_params(0);
    p.sigma_wad *= 2;
    let ix = env.ix_update_asset(&admin, ticker("SPYx"), p);
    env.send_admin(&[ix]).unwrap();
    let refused = buy(&mut env, GROUP_OCT9, 125, 100, 1_000_000_000).err().expect("sales must stop");
    assert!(refused.contains(&format!("Custom({})", code(CoreError::StaleGapFactors))), "{refused}");
    assert_eq!(env.anchor::<Vault>(&vault_pda()).reserved_total, reserved);

    price_oct9(&mut env, -0.10);
    let pol: Policy = env.anchor(&c.policy);
    let e: Epoch = env.anchor(&pol.epoch);
    let want = credence_core::pricing::realized_payout(pol.covered_value, pol.debt, pol.max_payout, e.close_price_wad, e.settle_price_wad).unwrap();
    settle_to_wallet(&mut env, &c);
    assert_eq!(env.anchor::<Policy>(&c.policy).payout, want, "σ does not enter the payout");
    assert!(want > 0);
}

/// Audit A-05: a weekend worse than every joint stress scenario can owe more than the vault's equity (INV-2 bounds the
/// worst *scenario*, not every gap). The last policies to settle must not be stuck with `VaultInsolvent` forever,
/// which would keep their group live and every LP withdrawal waiting on it: a policy is paid what equity remains (never
/// more than its payout, INV-1), and the group releases.
#[test]
fn payouts_beyond_equity_pay_what_remains_and_release_the_group() {
    let mut env = Env::real(0);
    let _lp = lp_deposit(&mut env, 1_000_000_000_000);
    let a = buy(&mut env, GROUP_OCT9, 125, 100, 50_000_000_000).unwrap();
    let b = buy(&mut env, GROUP_OCT9, 125, 100, 50_000_000_000).unwrap();
    price_oct9(&mut env, -0.30);
    let due = |env: &Env, c: &Cover| {
        let p: Policy = env.anchor(&c.policy);
        let e: Epoch = env.anchor(&p.epoch);
        credence_core::pricing::realized_payout(p.covered_value, p.debt, p.max_payout, e.close_price_wad, e.settle_price_wad).unwrap()
    };
    let (da, db) = (due(&env, &a), due(&env, &b));
    // Equity left after the weekend's losses elsewhere: enough for the first policy and part of the second.
    let left = da + db / 3;
    env.edit_vault(|v| v.equity = left);
    // The group's own premiums (still unearned) pay policies before they become LP equity (audit A-14).
    let premiums = env.zc::<LossVector>(&loss_pda(GROUP_OCT9)).premiums;
    settle_to_wallet(&mut env, &a);
    settle_to_wallet(&mut env, &b);
    assert_eq!(env.anchor::<Policy>(&a.policy).payout, da);
    assert_eq!(env.anchor::<Policy>(&b.policy).payout, (left - da + premiums).min(db), "the second policy gets what remains, premiums included");
    let v: Vault = env.anchor(&vault_pda());
    assert_eq!((v.equity, v.premiums_unearned), (0, 0), "nothing of the weekend's premiums went to the LPs");
    let v: Vault = env.anchor(&vault_pda());
    assert_eq!((v.live_groups, v.reserved_total), (0, 0), "the group released");
}

/// Audit A-33: with backstop inventory booked at cost inside equity, a weekend beyond cover equity must draw the payout
/// from cover equity, then the group's premiums, never from the inventory's book value: otherwise equity falls below
/// the inventory's cost, `cover_equity()` fails, and every later settlement of the group with it.
#[test]
fn a33_settlement_never_spends_the_inventorys_book_value() {
    let mut env = Env::real(0);
    let _lp = lp_deposit(&mut env, 1_000_000_000_000);
    let a = buy(&mut env, GROUP_OCT9, 125, 100, 50_000_000_000).unwrap();
    let b = buy(&mut env, GROUP_OCT9, 125, 100, 50_000_000_000).unwrap();
    price_oct9(&mut env, -0.30);
    let due = |env: &Env, c: &Cover| {
        let p: Policy = env.anchor(&c.policy);
        let e: Epoch = env.anchor(&p.epoch);
        credence_core::pricing::realized_payout(p.covered_value, p.debt, p.max_payout, e.close_price_wad, e.settle_price_wad).unwrap()
    };
    let da = due(&env, &a);
    // Cover equity just below the first payout; 600k of equity is inventory at cost (not cash).
    let inv = 600_000_000_000u64;
    env.edit_vault(|v| {
        v.equity = inv + da / 2;
        v.inv[0] = InvSlot { ticker: ticker("SPYx"), cost: inv, mark: inv, value: inv, marked_at: 0 };
    });
    settle_to_wallet(&mut env, &a);
    let v: Vault = env.anchor(&vault_pda());
    assert!(v.equity >= v.inventory_cost().unwrap(), "equity {} fell below the inventory's cost {inv}", v.equity);
    // The group's second policy still settles (cover_equity() works).
    settle_to_wallet(&mut env, &b);
    assert_eq!(env.anchor::<Vault>(&vault_pda()).live_groups, 0);
}
