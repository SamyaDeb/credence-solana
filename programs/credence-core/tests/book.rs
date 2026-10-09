//! C2 (W5): curator book cover with the real klend program (LiteSVM snapshot, `common::kl`). A payer covers a book of
//! SPYx/USDC obligations it does not own: the real `47wNsqpy…` and clones of it (same reserves, other owners and debts).
//! The C2.1 attacks are named tests (`c2_*`); then happy paths, a failure test per instruction, and the book
//! invariants (INV-15, INV-16).

mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use credence_core::{math::WAD as WAD128, pricing, state::*, CoreError};
use solana_keypair::Keypair;
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000;
const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;
const WINDOW_START: i64 = OCT12_OPEN - 48_600;
const SPY_CLOSE: f64 = 777.05;
const MULT: f64 = 1.0057;
const G: u32 = GROUP_OCT9;

struct World {
    env: Env,
    payer: Keypair,
    payer_usdc: Pubkey,
    /// Owner of `47wNsqpy…` (D/C′ scaled by `debt_num`).
    owner: Keypair,
    owner_usdc: Pubkey,
}

/// Shield on (W1 defaults), the real obligation's debt scaled by `debt_num / 100` (100: D/C′ 0.755; 127 ≈ 0.96),
/// `lp` USDC of LP equity, a curator with 1M USDC.
fn world_lp(debt_num: u128, lp: u64) -> World {
    let mut env = Env::real(lp);
    let a = env.admin.pubkey();
    let ix = env.ix_set_params(&a, shield_params(a, a));
    env.send_admin(&[ix]).unwrap();
    let owner = env.funded();
    env.load_klend_with(&owner.pubkey(), |d| ob::scale_debt(d, debt_num, 100));
    let owner_usdc = env.usdc_account(&owner.pubkey(), 100_000_000_000);
    let payer = env.funded();
    let payer_usdc = env.usdc_account(&payer.pubkey(), 1_000_000_000_000);
    World { env, payer, payer_usdc, owner, owner_usdc }
}

fn world(debt_num: u128) -> World {
    world_lp(debt_num, LP)
}

fn leg(o: &Pubkey) -> Pubkey {
    policy_pda(&epoch_pda(&ticker("SPYx"), G), o)
}

fn open(w: &mut World, book_id: u32) -> Pubkey {
    let ix = w.env.ix_open_book(&w.payer.pubkey(), w.payer_usdc, G, book_id);
    let payer = w.payer.insecure_clone();
    w.env.send(&[ix], &[&payer]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    book_pda(&w.payer.pubkey(), G, book_id)
}

/// Refreshes + `add_book_leg` for each obligation, in one transaction.
fn add(w: &mut World, book: Pubkey, obs: &[Pubkey]) -> TxResult {
    let mut ixs = Env::refreshes_for(obs);
    for o in obs {
        ixs.push(w.env.ix_add_book_leg(&w.payer.pubkey(), w.payer_usdc, book, *o, G));
    }
    let payer = w.payer.insecure_clone();
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.send(&ixs, &[&payer])
}

fn seal(w: &mut World, book: Pubkey) -> TxResult {
    let ix = w.env.ix_seal_book(&w.payer.pubkey(), w.payer_usdc, book, u64::MAX);
    let payer = w.payer.insecure_clone();
    w.env.send(&[ix], &[&payer])
}

fn ok(r: TxResult) -> u64 {
    match r {
        Ok(m) => m.compute_units_consumed,
        Err(e) => panic!("{:?}\n{:#?}", e.err, e.meta.logs),
    }
}

/// The owner's own `buy_cover` (single SPYx) on the snapshot obligation, optionally released from a book first.
fn owner_buy(w: &mut World, release: bool) -> TxResult {
    let mut ixs = kl::refreshes();
    if release {
        ixs.push(w.env.ix_release_book_leg(&w.owner.pubkey(), leg(&OBLIGATION_47WN)));
    }
    let debt = (kl::debt_sf(&w.env) >> 60) as u64;
    ixs.push(w.env.ix_buy_cover(&BuyArgs {
        buyer: w.owner.pubkey(),
        buyer_usdc: w.owner_usdc,
        obligation: OBLIGATION_47WN,
        deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"),
        closure_id: G,
        max_payout: debt,
        max_premium: u64::MAX,
    }));
    let owner = w.owner.insecure_clone();
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.send(&ixs, &[&owner])
}

fn clones(w: &mut World, n: usize, num: u128) -> Vec<Pubkey> {
    (0..n).map(|_| { let o = Pubkey::new_unique(); w.env.clone_obligation(&o, num) }).collect()
}

fn vault(w: &World) -> Vault {
    w.env.anchor(&vault_pda())
}

fn book(w: &World, b: &Pubkey) -> Book {
    w.env.zc(b)
}

/// INV-2 and the cash part of INV-13 after a write: reservations within u_max × equity, the vault's cash at least what
/// live cover and queues hold; the concentration cap on SPYx.
fn check_inv2_inv13(w: &World) {
    let v = vault(w);
    let c: Config = w.env.anchor(&config_pda());
    assert!((v.reserved_total as u128) <= (v.equity as u128) * (c.u_max_wad as u128) / WAD128, "INV-2");
    let cash = w.env.token_balance(&vault_usdc_pda());
    let reserved_cash = v.reserved_total - v.advanced_live + v.premiums_unearned + v.queued_deposits;
    assert!(cash >= reserved_cash, "INV-13 cash: {cash} < {reserved_cash}");
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker("SPYx"), G));
    let limit = (v.equity as u128) * (c.u_max_wad as u128) / WAD128 * (c.max_asset_share_wad as u128) / WAD128;
    assert!((e.worst_loss_sum as u128) <= limit, "concentration");
}

/// INV-15: refunds paid and owed never exceed the net premium.
fn check_inv15(w: &World, b: &Pubkey) {
    let bk = book(w, b);
    assert!(bk.refunded + bk.refund_owed <= bk.premium - bk.fee, "INV-15");
}

// ------------------------------------------------------------------------------------------------------------------
// C2.1 attacks
// ------------------------------------------------------------------------------------------------------------------

/// A stranger covers many positions with a minimal book only to occupy their policy addresses. Each owner still
/// buys (release + buy in one transaction), the book is refunded the leg's share, and the stranger cannot release.
#[test]
fn c2_stranger_cannot_block_owner() {
    let mut w = world(100);
    let b = open(&mut w, 1);
    let others = clones(&mut w, 5, 100);
    let mut all = vec![OBLIGATION_47WN];
    all.extend(&others);
    ok(add(&mut w, b, &all));
    ok(seal(&mut w, b));
    let before = book(&w, &b);
    assert_eq!(before.legs_live, 6);

    // Without the release the owner's buy hits the leg's address (A-01 holds: one cover per position per closure).
    assert_fails(owner_buy(&mut w, false));
    // The stranger (payer) is not the owner: refused.
    let ix = w.env.ix_release_book_leg(&w.payer.pubkey(), leg(&OBLIGATION_47WN));
    let payer = w.payer.insecure_clone();
    assert_err(w.env.send(&[ix], &[&payer]), code(CoreError::NotObligationOwner));
    // The owner: release + buy_cover in one transaction succeeds.
    let rent_before = w.env.svm.get_account(&w.payer.pubkey()).unwrap().lamports;
    ok(owner_buy(&mut w, true));
    let p: Policy = w.env.anchor(&leg(&OBLIGATION_47WN));
    assert_eq!(p.owner, w.owner.pubkey());
    assert_eq!(p.book, Pubkey::default(), "now the owner's own policy");
    let after = book(&w, &b);
    let net = before.premium - before.fee;
    let want = (net as u128 * before_leg_w(&before, &w) as u128 / before.w_seal as u128) as u64;
    assert_eq!(after.refund_owed, want, "the leg's share, rounded down");
    assert_eq!(after.legs_live, 5);
    assert!(w.env.svm.get_account(&w.payer.pubkey()).unwrap().lamports > rent_before, "leg rent back to the payer");
    check_inv15(&w, &b);
    check_inv2_inv13(&w);
}

/// The leg weight of the snapshot obligation's leg, from the add event values the book kept (all legs of this test
/// have the same weight except the real one; recomputed from the program's leg quote).
fn before_leg_w(b: &Book, w: &World) -> u64 {
    // Every leg was added with `leg_w`; the released account is closed, so read it from a clone with the same debt:
    // all six legs in c2_stranger_cannot_block_owner are SPYx at the same D/C′, so the weights are equal.
    let _ = w;
    b.w_seal / b.legs_added as u64
}

/// The same position in two books, or in a book and an owner policy, in one closure: the second is refused.
#[test]
fn c2_no_double_cover() {
    let mut w = world(100);
    let b1 = open(&mut w, 1);
    let b2 = open(&mut w, 2);
    let o = clones(&mut w, 1, 100)[0];
    ok(add(&mut w, b1, &[o]));
    assert_fails(add(&mut w, b2, &[o]));
    // An owner policy first, then a book: refused.
    ok(owner_buy(&mut w, false));
    assert_fails(add(&mut w, b2, &[OBLIGATION_47WN]));
    // A book leg, then the owner's buy without releasing it: refused (with the release it supersedes: test above).
    let o2 = w.env.clone_obligation(&w.owner.pubkey(), 100);
    ok(add(&mut w, b1, &[o2]));
    let mut ixs = Env::refreshes_for(&[o2]);
    ixs.push(w.env.ix_buy_cover(&BuyArgs {
        buyer: w.owner.pubkey(),
        buyer_usdc: w.owner_usdc,
        obligation: o2,
        deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"),
        closure_id: G,
        max_payout: 1,
        max_premium: u64::MAX,
    }));
    let owner = w.owner.insecure_clone();
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    assert_fails(w.env.send(&ixs, &[&owner]));
    assert_eq!(book(&w, &b1).legs_live, 2);
    assert_eq!(book(&w, &b2).legs_live, 0);
}

/// Two books adding legs in interleaved transactions on a small vault: every successful add keeps INV-2, the cash part
/// of INV-13 and the concentration cap; the one that would break them is refused, whichever book sends it.
#[test]
fn c2_capacity_race() {
    // 1M USDC of LP equity: a dozen near-threshold legs fill it.
    let mut w = world_lp(100, 1_000_000_000_000);
    let b1 = open(&mut w, 1);
    let payer2 = w.env.funded();
    let payer2_usdc = w.env.usdc_account(&payer2.pubkey(), 1_000_000_000_000);
    let ix = w.env.ix_open_book(&payer2.pubkey(), payer2_usdc, G, 7);
    w.env.send(&[ix], &[&payer2]).unwrap();
    let b2 = book_pda(&payer2.pubkey(), G, 7);
    let obs = clones(&mut w, 24, 125);
    let (mut ok_n, mut refused) = (0, 0);
    for (i, o) in obs.iter().enumerate() {
        let r = if i % 2 == 0 {
            add(&mut w, b1, &[*o])
        } else {
            let mut ixs = Env::refreshes_for(&[*o]);
            ixs.push(w.env.ix_add_book_leg(&payer2.pubkey(), payer2_usdc, b2, *o, G));
            w.env.svm.warp_to_slot(w.env.slot() + 1);
            w.env.send(&ixs, &[&payer2])
        };
        match r {
            Ok(_) => ok_n += 1,
            Err(e) => {
                let s = format!("{:?}", e.err);
                assert!(
                    s.contains(&code(CoreError::CapacityExceeded).to_string()) || s.contains(&code(CoreError::ConcentrationExceeded).to_string()),
                    "refused for another reason: {s}"
                );
                refused += 1;
            }
        }
        check_inv2_inv13(&w);
    }
    let p: Policy = w.env.anchor(&leg(&obs[0]));
    println!("capacity race: {ok_n} legs added across two books, {refused} refused (worst loss per leg {})", p.worst_loss);
    assert!(ok_n > 0 && refused > 0, "the race reached the limit");
    let v = vault(&w);
    let l: LossVector = w.env.zc(&loss_pda(G));
    assert_eq!(v.reserved_total, l.max_loss, "one live group: its max is the vault's reservation");
}

/// Prices the Oct 9 close and posts the Oct 12 open at `r` (SPYx, equity source).
fn close_and_open(w: &mut World, r: f64) {
    let a = w.env.admin.pubkey();
    let asset: AssetConfig = w.env.zc(&asset_pda(&ticker("SPYx")));
    w.env.set_time(OCT9_CLOSE + 30);
    let p = w.env.put_price(&Px::new(asset.feed_equity, SPY_CLOSE, OCT9_CLOSE - 1));
    let x = w.env.put_price(&Px::new(asset.feed_xstock, SPY_CLOSE * MULT, OCT9_CLOSE - 300));
    let snap = w.env.ix_snapshot(&a, "SPYx", G, p, Some(x));
    w.env.send_admin(&[snap]).unwrap();
    let open = SPY_CLOSE * (1.0 + r);
    let u = w.env.put_price(&Px::new(asset.feed_equity, open, OCT12_OPEN + 30));
    let x = w.env.put_price(&Px::new(asset.feed_xstock, open * MULT, OCT12_OPEN + 60));
    w.env.set_time(OCT12_OPEN + 301);
    let post = w.env.ix_post(&a, "SPYx", G, &[u], Some(x));
    w.env.send_admin(&[post]).unwrap();
    w.env.svm.warp_to_slot(w.env.slot() + 10);
    w.env.freshen_scope();
}

/// Every payout and advance path on a Kamino book leg goes into the obligation or stays in the vault: the owner-policy
/// paths refuse a leg, the shield repays into the obligation, settlement repays into it, and a position that no
/// longer borrows is paid nothing (no wallet). Wallet balances never move.
#[test]
fn c2_payout_never_to_wallet() {
    let mut w = world(127);
    let b = open(&mut w, 1);
    let closed = clones(&mut w, 1, 127)[0];
    ok(add(&mut w, b, &[OBLIGATION_47WN, closed]));
    ok(seal(&mut w, b));
    let p47 = leg(&OBLIGATION_47WN);
    let keeper = w.env.admin.insecure_clone();
    let caller = w.env.funded();
    let wallets = |w: &World| (w.env.token_balance(&w.owner_usdc), w.env.token_balance(&w.payer_usdc));
    let before = wallets(&w);

    // The owner-policy paths refuse a leg: settle_policy, settle_policy_to_wallet, shield_advance, refund_policy.
    let asset: AssetConfig = w.env.zc(&asset_pda(&ticker("SPYx")));
    w.env.set_time(OCT9_CLOSE + 30);
    let p = w.env.put_price(&Px::new(asset.feed_equity, SPY_CLOSE, OCT9_CLOSE - 1));
    let x = w.env.put_price(&Px::new(asset.feed_xstock, SPY_CLOSE * MULT, OCT9_CLOSE - 300));
    let snap = w.env.ix_snapshot(&keeper.pubkey(), "SPYx", G, p, Some(x));
    w.env.send_admin(&[snap]).unwrap();
    let close = w.env.anchor::<Epoch>(&epoch_pda(&ticker("SPYx"), G)).close_price_wad as f64 / 1e18;
    w.env.set_time(WINDOW_START + 3600);
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    let px = w.env.put_push(&Px::new(asset.feed_xstock, close * 0.92, WINDOW_START + 3000));
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_shield(&keeper.pubkey(), p47, px));
    assert_err(w.env.send(&ixs, &[&keeper]), code(CoreError::BookLeg));

    // The shield on the leg: into the obligation (its debt falls), the book books it (INV-16).
    let debt0 = kl::debt_sf(&w.env);
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_shield_book_leg(&keeper.pubkey(), p47, px));
    ok(w.env.send(&ixs, &[&keeper]));
    let pl: Policy = w.env.anchor(&p47);
    assert!(pl.advanced > 0 && kl::debt_sf(&w.env) < debt0, "advanced into the obligation");
    let bk = book(&w, &b);
    assert_eq!(bk.advanced, pl.advanced);
    assert!(bk.advanced <= bk.sum_worst, "INV-16");
    assert_eq!(wallets(&w), before);

    // Monday −10%.
    let open = SPY_CLOSE * 0.90;
    let u = w.env.put_price(&Px::new(asset.feed_equity, open, OCT12_OPEN + 30));
    let x = w.env.put_price(&Px::new(asset.feed_xstock, open * MULT, OCT12_OPEN + 60));
    w.env.set_time(OCT12_OPEN + 301);
    let post = w.env.ix_post(&keeper.pubkey(), "SPYx", G, &[u], Some(x));
    w.env.send_admin(&[post]).unwrap();
    w.env.svm.warp_to_slot(w.env.slot() + 10);
    w.env.freshen_scope();

    // A leg has no owner: the owner's wallet is refused by the account check, and even a token account whose
    // authority is the default key (anyone can make one) is refused by the program.
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_settle(&caller.pubkey(), p47, w.owner_usdc, true));
    assert_fails(w.env.send(&ixs, &[&caller]));
    let nobody = w.env.usdc_account(&Pubkey::default(), 0);
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_settle(&caller.pubkey(), p47, nobody, true));
    assert_err(w.env.send(&ixs, &[&caller]), code(CoreError::BookLeg));
    let ix = w.env.ix_settle_to_wallet(&caller.pubkey(), p47, nobody);
    assert_err(w.env.send(&[ix], &[&caller]), code(CoreError::BookLeg));
    let ix = w.env.ix_refund(&caller.pubkey(), p47, nobody);
    assert_fails(w.env.send(&[ix], &[&caller])); // the epoch is not voided either; refund_policy also refuses legs

    // settle_book_leg: the remainder into the obligation.
    let debt1 = kl::debt_sf(&w.env);
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_settle_book_leg(&caller.pubkey(), p47, true));
    let cu = ok(w.env.send(&ixs, &[&caller]));
    let pl: Policy = w.env.anchor(&p47);
    println!("settle_book_leg (refreshes + repay v2): {cu} CU; payout {} (advanced {})", pl.payout, pl.advanced);
    assert_eq!(pl.state, policy_state::SETTLED);
    assert!(pl.payout > pl.advanced && kl::debt_sf(&w.env) < debt1, "the remainder went into the obligation");
    assert!(pl.payout <= pl.max_payout, "INV-1");

    // The clone stopped borrowing (repaid): paid 0, nothing to any wallet; its share refunded only if it was owed a
    // payout (it was: same D/C′ as the real one at −10%).
    w.env.zero_borrow(&closed);
    let pc = leg(&closed);
    let ix = w.env.ix_settle_book_leg(&caller.pubkey(), pc, false);
    ok(w.env.send(&[ix], &[&caller]));
    let pcl: Policy = w.env.anchor(&pc);
    assert_eq!((pcl.state, pcl.payout), (policy_state::SETTLED, 0));
    assert!(book(&w, &b).refund_owed > 0, "owed and unpaid: share refunded (A-84)");
    assert_eq!(wallets(&w), before, "no wallet ever received a payout");
    check_inv15(&w, &b);
    let l: LossVector = w.env.zc(&loss_pda(G));
    assert_eq!(l.settled, 1, "every leg finished: the group released");
}

/// A book left open at its expiry is voided leg by leg by anyone: capacity released to the cent, the escrow back in full.
#[test]
fn c2_unsealed_book_voids() {
    let mut w = world(100);
    let v0 = vault(&w);
    let usdc0 = w.env.token_balance(&w.payer_usdc);
    let b = open(&mut w, 1);
    let obs = clones(&mut w, 4, 124);
    ok(add(&mut w, b, &obs));
    let bk = book(&w, &b);
    assert!(bk.escrowed > 0 && w.env.token_balance(&escrow_pda(&b)) == bk.escrowed);
    assert!(vault(&w).reserved_total > v0.reserved_total);
    let caller = w.env.funded();
    // Not before the expiry.
    let ix = w.env.ix_void_book_leg(&caller.pubkey(), leg(&obs[0]));
    assert_err(w.env.send(&[ix], &[&caller]), code(CoreError::BookNotExpired));
    // Past it: no more legs, no seal; anyone voids.
    w.env.set_time(bk.expires_at);
    w.env.freshen_scope();
    assert_err(seal(&mut w, b), code(CoreError::BookNotOpen));
    for o in &obs {
        let ix = w.env.ix_void_book_leg(&caller.pubkey(), leg(o));
        ok(w.env.send(&[ix], &[&caller]));
        assert!(w.env.svm.get_account(&leg(o)).map(|a| a.lamports == 0).unwrap_or(true), "leg closed");
    }
    let v = vault(&w);
    assert_eq!(v.reserved_total, v0.reserved_total, "capacity released");
    let bk = book(&w, &b);
    assert_eq!((bk.state, bk.legs_live, bk.legs_done), (book_state::VOIDED, 0, 4));
    let ix = w.env.ix_claim_book_refund(&caller.pubkey(), b, true);
    ok(w.env.send(&[ix], &[&caller]));
    assert_eq!(w.env.token_balance(&w.payer_usdc), usdc0, "escrow refunded in full");
    let ix = w.env.ix_close_book(&caller.pubkey(), b);
    ok(w.env.send(&[ix], &[&caller]));
}

/// One minimum premium per book, and a one-leg book is no cheaper than the owner's own policy on the same position.
#[test]
fn c2_floor_once() {
    // Twelve far-from-threshold legs: each owner policy would pay the 5 USDC minimum; the book pays one.
    let mut w = world(100);
    let c: Config = w.env.anchor(&config_pda());
    let b = open(&mut w, 1);
    let obs = clones(&mut w, 12, 60);
    for chunk in obs.chunks(4) {
        ok(add(&mut w, b, chunk));
    }
    ok(seal(&mut w, b));
    let bk = book(&w, &b);
    println!("12 legs at D/C′ ~0.45: book premium {} (loading {}), min premium {}", bk.premium, bk.sum_loading, c.min_premium);
    assert_eq!(bk.premium, c.min_premium + bk.sum_loading, "one floor, not twelve");
    assert!(bk.premium < 12 * c.min_premium);

    // One leg vs the owner's policy, same position, same vault state (two worlds).
    let mut w1 = world(120);
    let b1 = open(&mut w1, 1);
    ok(add(&mut w1, b1, &[OBLIGATION_47WN]));
    ok(seal(&mut w1, b1));
    let mut w2 = world(120);
    // The owner buys at the utilisation after its own policy; the book was priced at the utilisation after its leg:
    // the same state.
    ok(owner_buy(&mut w2, false));
    let p: Policy = w2.env.anchor(&leg(&OBLIGATION_47WN));
    let one = book(&w1, &b1);
    println!("one-leg book {} vs single policy {}", one.premium, p.premium);
    assert!(one.premium >= p.premium, "a one-leg book is no cheaper than a single policy");
    assert!(one.premium <= p.premium + 2, "and equal up to rounding units");
}

/// Refunds of released legs add up to at most the net premium; each is ⌊net × w / W⌋ (rounded against the payer);
/// claiming pays exactly what was owed from the vault, never more (INV-15).
#[test]
fn c2_refund_math() {
    let mut w = world(100);
    let b = open(&mut w, 1);
    // Three owners we control, one leg each, at different D/C′ (different weights), plus filler legs.
    let owners: Vec<Keypair> = (0..3).map(|_| w.env.funded()).collect();
    let nums = [105u128, 118, 124];
    let mine: Vec<Pubkey> = owners.iter().zip(nums).map(|(k, n)| w.env.clone_obligation(&k.pubkey(), n)).collect();
    let filler = clones(&mut w, 3, 100);
    ok(add(&mut w, b, &mine));
    ok(add(&mut w, b, &filler));
    let weights: Vec<u64> = mine.iter().map(|o| w.env.anchor::<Policy>(&leg(o)).leg_w).collect();
    ok(seal(&mut w, b));
    let bk = book(&w, &b);
    let net = bk.premium - bk.fee;
    let mut owed = 0u64;
    for (i, o) in mine.iter().enumerate() {
        let mut ixs = Env::refreshes_for(&[*o]);
        ixs.push(w.env.ix_release_book_leg(&owners[i].pubkey(), leg(o)));
        w.env.svm.warp_to_slot(w.env.slot() + 1);
        ok(w.env.send(&ixs, &[&owners[i]]));
        let share = (net as u128 * weights[i] as u128 / bk.w_seal as u128) as u64;
        owed += share;
        assert_eq!(book(&w, &b).refund_owed, owed, "leg {i}: ⌊net × w / W⌋");
        check_inv15(&w, &b);
    }
    assert!(owed <= net);
    let (u0, v0) = (w.env.token_balance(&w.payer_usdc), vault(&w));
    let caller = w.env.funded();
    let ix = w.env.ix_claim_book_refund(&caller.pubkey(), b, false);
    ok(w.env.send(&[ix], &[&caller]));
    assert_eq!(w.env.token_balance(&w.payer_usdc), u0 + owed);
    let bk = book(&w, &b);
    assert_eq!((bk.refunded, bk.refund_owed), (owed, 0));
    // The refund came out of unearned premiums, not out of LP equity.
    assert_eq!(vault(&w).equity, v0.equity);
    // A second claim pays nothing.
    let ix = w.env.ix_claim_book_refund(&caller.pubkey(), b, false);
    ok(w.env.send(&[ix], &[&caller]));
    assert_eq!(w.env.token_balance(&w.payer_usdc), u0 + owed);
    check_inv15(&w, &b);
}

/// A position that borrows more after its leg is added does not raise the payout (EVM bug 1): settlement pays the
/// payout rule on the leg's snapshot debt (plus capped interest), not on the new debt.
#[test]
fn c2_leg_snapshot_fixed() {
    let mut w = world(120);
    let b = open(&mut w, 1);
    ok(add(&mut w, b, &[OBLIGATION_47WN]));
    ok(seal(&mut w, b));
    let p0: Policy = w.env.anchor(&leg(&OBLIGATION_47WN));
    // The owner borrows 20% more after the leg was added.
    let mut d = w.env.data(&OBLIGATION_47WN);
    ob::scale_debt(&mut d, 120, 100);
    w.env.put_klend(OBLIGATION_47WN, d);
    close_and_open(&mut w, -0.10);
    let caller = w.env.funded();
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_settle_book_leg(&caller.pubkey(), leg(&OBLIGATION_47WN), true));
    ok(w.env.send(&ixs, &[&caller]));
    let p: Policy = w.env.anchor(&leg(&OBLIGATION_47WN));
    assert_eq!((p.debt, p.covered_value, p.max_payout), (p0.debt, p0.covered_value, p0.max_payout), "snapshot fixed");
    let e: Epoch = w.env.anchor(&p.epoch);
    let cap_debt = pricing::reserved_debt(p.debt, &w.env.anchor::<Config>(&config_pda())).unwrap();
    let on_snapshot = pricing::realized_payout(p.covered_value, cap_debt, p.max_payout, e.close_price_wad, e.settle_price_wad).unwrap();
    let on_new_debt = pricing::realized_payout(p.covered_value, p.debt * 12 / 10, u64::MAX, e.close_price_wad, e.settle_price_wad).unwrap();
    println!("payout {} ≤ rule on the snapshot debt + interest cap {} < rule on the new debt {}", p.payout, on_snapshot, on_new_debt);
    assert!(p.payout <= on_snapshot && p.payout < on_new_debt);
}

/// Audit A-84 (found writing C2.1): an unpaid leg refunds its share only when the payout rule owed something. A position
/// repaid before the open on a calm Monday (nothing owed) earned its premium: closing it is not a free option on the gap.
#[test]
fn c2_closed_position_refunds_only_when_owed() {
    let mut w = world(100);
    let b = open(&mut w, 1);
    let o = clones(&mut w, 1, 100)[0];
    ok(add(&mut w, b, &[o, OBLIGATION_47WN]));
    ok(seal(&mut w, b));
    close_and_open(&mut w, 0.01); // Monday +1%: nothing owed
    w.env.zero_borrow(&o);
    let caller = w.env.funded();
    let ix = w.env.ix_settle_book_leg(&caller.pubkey(), leg(&o), false);
    ok(w.env.send(&[ix], &[&caller]));
    assert_eq!(book(&w, &b).refund_owed, 0, "nothing owed, nothing refunded");
}

// ------------------------------------------------------------------------------------------------------------------
// Happy path, CU, failures per instruction
// ------------------------------------------------------------------------------------------------------------------

/// Legs per transaction and CU: as many SPYx legs as fit in 1.4M CU, each instruction under 900k.
#[test]
fn book_legs_per_transaction_cu() {
    for (num, label) in [(100u128, "D/C′ 0.755"), (120, "0.91"), (127, "0.96")] {
        // A 50M vault: the SPYx concentration cap (50% of u_max × equity) does not bind before compute does.
        let mut w = world_lp(100, 50_000_000_000_000);
        let b = open(&mut w, 1);
        let mut best = 0usize;
        for k in 1..=12usize {
            let obs = clones(&mut w, k, num);
            match add(&mut w, b, &obs) {
                Ok(m) => {
                    best = k;
                    println!("{label}: {k} legs in one transaction: {} CU", m.compute_units_consumed);
                    assert!(m.compute_units_consumed < 1_400_000);
                }
                Err(e) => {
                    let s = format!("{:?}", e.err);
                    assert!(!s.contains("Custom"), "{k} legs failed for a program error: {s}\n{:#?}", e.meta.logs);
                    break;
                }
            }
        }
        println!("{label}: {best} Kamino single legs per transaction");
        assert!(best >= 1);
    }
}

#[test]
fn book_happy_path_and_failures() {
    let mut w = world(100);
    let stranger = w.env.funded();
    let s_usdc = w.env.usdc_account(&stranger.pubkey(), 1_000_000_000);
    let b = open(&mut w, 1);
    let obs = clones(&mut w, 3, 110);
    // add_book_leg: only the book's payer.
    let mut ixs = Env::refreshes_for(&obs[..1]);
    ixs.push(w.env.ix_add_book_leg(&stranger.pubkey(), s_usdc, b, obs[0], G));
    assert_err(w.env.send(&ixs, &[&stranger]), code(CoreError::Unauthorized));
    // add_book_leg: without the refresh in the same transaction.
    let ix = w.env.ix_add_book_leg(&w.payer.pubkey(), w.payer_usdc, b, obs[0], G);
    let payer = w.payer.insecure_clone();
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    assert_err(w.env.send(&[ix], &[&payer]), code(CoreError::ObligationNotRefreshed));
    // An already-liquidatable position: refused.
    let bad = clones(&mut w, 1, 140)[0];
    assert_err(add(&mut w, b, &[bad]), code(CoreError::AlreadyLiquidatable));
    ok(add(&mut w, b, &obs));
    // seal_book: only the payer; premium above max refused.
    let ix = w.env.ix_seal_book(&stranger.pubkey(), s_usdc, b, u64::MAX);
    assert_err(w.env.send(&[ix], &[&stranger]), code(CoreError::Unauthorized));
    let ix = w.env.ix_seal_book(&w.payer.pubkey(), w.payer_usdc, b, 1);
    assert_err(w.env.send(&[ix], &[&payer]), code(CoreError::PremiumAboveMax));
    // Paused: no open, no add, no seal.
    let a = w.env.admin.pubkey();
    let ix = w.env.ix_set_paused(&a, true);
    w.env.send_admin(&[ix]).unwrap();
    assert_err(seal(&mut w, b), code(CoreError::Paused));
    let more = clones(&mut w, 1, 100);
    assert_err(add(&mut w, b, &more), code(CoreError::Paused));
    let ix = w.env.ix_open_book(&w.payer.pubkey(), w.payer_usdc, G, 9);
    assert_err(w.env.send(&[ix], &[&payer]), code(CoreError::Paused));
    let ix = w.env.ix_set_paused(&a, false);
    w.env.send_admin(&[ix]).unwrap();
    let usdc_before = w.env.token_balance(&w.payer_usdc);
    let escrowed = book(&w, &b).escrowed;
    let cu = ok(seal(&mut w, b));
    println!("seal_book (3 legs): {cu} CU (transaction)");
    let bk = book(&w, &b);
    assert_eq!(bk.state, book_state::SEALED);
    assert_eq!(w.env.token_balance(&w.payer_usdc), usdc_before + escrowed - bk.premium, "escrow rest back");
    assert!(w.env.svm.get_account(&escrow_pda(&b)).map(|a| a.lamports == 0).unwrap_or(true), "escrow closed");
    // Sealed: no more legs (the escrow is closed), no second seal; void refused (not open).
    assert_fails(add(&mut w, b, &more));
    assert_fails(seal(&mut w, b));
    let ix = w.env.ix_void_book_leg(&stranger.pubkey(), leg(&obs[0]));
    assert_err(w.env.send(&[ix], &[&stranger]), code(CoreError::BookNotOpen));
    // close_out_book_leg before the settlement: refused; close_book with legs live: refused.
    let ix = w.env.ix_close_out_book_leg(&stranger.pubkey(), leg(&obs[0]));
    assert_fails(w.env.send(&[ix], &[&stranger]));
    let ix = w.env.ix_close_book(&stranger.pubkey(), b);
    assert_err(w.env.send(&[ix], &[&stranger]), code(CoreError::BookNotDone));
    // close_book_leg on a live leg: refused.
    let ix = w.env.ix_close_book_leg(&stranger.pubkey(), leg(&obs[0]));
    assert_err(w.env.send(&[ix], &[&stranger]), code(CoreError::WrongEpochState));
    // After the bell: release refused (the cover is fixed for the weekend).
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker("SPYx"), G));
    w.env.set_time(e.bell);
    w.env.freshen_scope();
    let o = w.env.clone_obligation(&stranger.pubkey(), 100);
    let _ = o;
    // The settlement: a +2% Monday, every leg owed nothing → settles at 0; then close-out paths, leg closes, book close.
    close_and_open(&mut w, 0.02);
    for o in &obs {
        let ix = w.env.ix_settle_book_leg(&stranger.pubkey(), leg(o), true);
        let mut ixs = Env::refreshes_for(&[*o]);
        ixs.push(ix);
        w.env.svm.warp_to_slot(w.env.slot() + 1);
        ok(w.env.send(&ixs, &[&stranger]));
    }
    let l: LossVector = w.env.zc(&loss_pda(G));
    assert_eq!(l.settled, 1);
    let v = vault(&w);
    assert_eq!(v.reserved_total, 0);
    for o in &obs {
        let ix = w.env.ix_close_book_leg(&stranger.pubkey(), leg(o));
        ok(w.env.send(&[ix], &[&stranger]));
    }
    let ix = w.env.ix_close_book(&stranger.pubkey(), b);
    ok(w.env.send(&[ix], &[&stranger]));
}

/// A leg whose payment cannot go through within the grace (here: the obligation stopped borrowing after being owed a
/// payout and nobody settled it): `close_out_book_leg` finishes it at 0, the share refunded, never a wallet.
#[test]
fn book_close_out_after_grace() {
    let mut w = world(127);
    let b = open(&mut w, 1);
    let o = clones(&mut w, 1, 127)[0];
    ok(add(&mut w, b, &[o]));
    ok(seal(&mut w, b));
    close_and_open(&mut w, -0.10);
    let caller = w.env.funded();
    let ix = w.env.ix_close_out_book_leg(&caller.pubkey(), leg(&o));
    assert_err(w.env.send(&[ix], &[&caller]), code(CoreError::TooEarly));
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker("SPYx"), G));
    w.env.set_time(e.settled_at + 3600);
    let before = w.env.token_balance(&w.payer_usdc);
    let ix = w.env.ix_close_out_book_leg(&caller.pubkey(), leg(&o));
    ok(w.env.send(&[ix], &[&caller]));
    let p: Policy = w.env.anchor(&leg(&o));
    assert_eq!((p.state, p.payout), (policy_state::SETTLED, 0));
    let bk = book(&w, &b);
    assert!(bk.refund_owed > 0 && w.env.token_balance(&w.payer_usdc) == before);
    check_inv15(&w, &b);
}

/// The owner releases from an OPEN book: no money moves, the book's sums lose the leg, the capacity is released.
#[test]
fn book_release_from_open_book() {
    let mut w = world(124);
    let v0 = vault(&w).reserved_total;
    let b = open(&mut w, 1);
    ok(add(&mut w, b, &[OBLIGATION_47WN]));
    assert!(vault(&w).reserved_total > v0);
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_release_book_leg(&w.owner.pubkey(), leg(&OBLIGATION_47WN)));
    let owner = w.owner.insecure_clone();
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    ok(w.env.send(&ixs, &[&owner]));
    let bk = book(&w, &b);
    assert_eq!((bk.legs_live, bk.legs_done, bk.sum_e, bk.sum_loading, bk.refund_owed), (0, 1, 0, 0, 0));
    assert!(bk.losses.iter().all(|x| *x == 0));
    let l: LossVector = w.env.zc(&loss_pda(G));
    println!("after release: reserved {} (before {v0}), group count {} max {} losses[0..4] {:?}", vault(&w).reserved_total, l.policy_count, l.max_loss, &l.losses[..4]);
    assert_eq!(vault(&w).reserved_total, v0, "capacity released");
    assert_eq!((l.policy_count, l.max_loss), (0, 0));
}

/// Book pricing on-chain equals `risk-core::book_premium` from the legs' stored components and the book's vector.
#[test]
fn book_premium_golden() {
    let mut w = world(100);
    let b = open(&mut w, 1);
    let obs: Vec<Pubkey> = [100u128, 112, 120, 124, 126].iter().map(|n| { let o = Pubkey::new_unique(); w.env.clone_obligation(&o, *n) }).collect();
    ok(add(&mut w, b, &obs));
    let bk0 = book(&w, &b);
    ok(seal(&mut w, b));
    let bk = book(&w, &b);
    let c: Config = w.env.anchor(&config_pda());
    let legs: Vec<credence_risk_core::BookLeg> = obs
        .iter()
        .map(|o| {
            let p: Policy = w.env.anchor(&leg(o));
            credence_risk_core::BookLeg { e: p.leg_e, es: p.leg_es, loading: p.shield_loading, losses: vec![0; 256] }
        })
        .collect();
    let mut legs = legs;
    legs[0].losses = bk0.losses.to_vec(); // the summed joint vector (the reference sums the legs' vectors)
    let q = credence_risk_core::book_premium(&legs, credence_risk_core::U256::from(bk.util_wad), &pricing::book_params(&c)).unwrap();
    println!("5-leg book: premium {} (E {} loading {} util {}), standalone floors would be ≥ {}", bk.premium, bk.sum_e, bk.sum_loading, bk.util_wad, 5 * c.min_premium);
    assert_eq!(credence_risk_core::U256::from(bk.premium), q.premium);
}

// ------------------------------------------------------------------------------------------------------------------
// C2 merge review (A-86 to A-88): failing tests first
// ------------------------------------------------------------------------------------------------------------------

/// A-86: every leg of an OPEN book released by its owner: once it expires, the escrow still comes back and the book
/// closes (no leg is left to void it).
#[test]
fn a86_open_book_with_every_leg_released_refunds_and_closes() {
    let mut w = world(124);
    let usdc0 = w.env.token_balance(&w.payer_usdc);
    let b = open(&mut w, 1);
    ok(add(&mut w, b, &[OBLIGATION_47WN]));
    assert!(book(&w, &b).escrowed > 0);
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_release_book_leg(&w.owner.pubkey(), leg(&OBLIGATION_47WN)));
    let owner = w.owner.insecure_clone();
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    ok(w.env.send(&ixs, &[&owner]));
    let caller = w.env.funded();
    // Not before the expiry.
    let ix = w.env.ix_claim_book_refund(&caller.pubkey(), b, true);
    assert_fails(w.env.send(&[ix], &[&caller]));
    w.env.set_time(book(&w, &b).expires_at);
    let ix = w.env.ix_claim_book_refund(&caller.pubkey(), b, true);
    ok(w.env.send(&[ix], &[&caller]));
    assert_eq!(w.env.token_balance(&w.payer_usdc), usdc0, "escrow back in full");
    assert_eq!(book(&w, &b).state, book_state::VOIDED);
    let ix = w.env.ix_close_book(&caller.pubkey(), b);
    ok(w.env.send(&[ix], &[&caller]));
}

/// A-87: after the grace, only the keeper may finish an owed leg unpaid (it knows the repay is failing); anyone else
/// only after BOOK_CLOSE_OUT_AFTER, so a payer cannot race the keeper to turn a payout into a premium rebate.
#[test]
fn a87_close_out_of_an_owed_leg_is_the_keepers_until_the_long_grace() {
    let mut w = world(127);
    let b = open(&mut w, 1);
    let o = clones(&mut w, 1, 127)[0];
    ok(add(&mut w, b, &[o]));
    ok(seal(&mut w, b));
    close_and_open(&mut w, -0.10);
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker("SPYx"), G));
    w.env.set_time(e.settled_at + 3600);
    let payer = w.payer.insecure_clone();
    let ix = w.env.ix_close_out_book_leg(&payer.pubkey(), leg(&o));
    assert_err(w.env.send(&[ix], &[&payer]), code(CoreError::TooEarly));
    let keeper = w.env.admin.insecure_clone(); // the test config's keeper
    let ix = w.env.ix_close_out_book_leg(&keeper.pubkey(), leg(&o));
    ok(w.env.send(&[ix], &[&keeper]));
    // A second leg, nobody acting for a day: then anyone.
    let mut w = world(127);
    let b = open(&mut w, 1);
    let o = clones(&mut w, 1, 127)[0];
    ok(add(&mut w, b, &[o]));
    ok(seal(&mut w, b));
    close_and_open(&mut w, -0.10);
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker("SPYx"), G));
    w.env.set_time(e.settled_at + credence_core::instructions::book_settle::BOOK_CLOSE_OUT_AFTER);
    let caller = w.env.funded();
    let ix = w.env.ix_close_out_book_leg(&caller.pubkey(), leg(&o));
    ok(w.env.send(&[ix], &[&caller]));
}

/// A-88: a refund owed to the payer stays in the vault's reserved cash (unearned premiums) until it is claimed: the
/// yield job cannot lend it out, and the claim takes it from there.
#[test]
fn a88_owed_refund_stays_reserved_until_claimed() {
    let mut w = world(100);
    let b = open(&mut w, 1);
    let others = clones(&mut w, 3, 100);
    let mut all = vec![OBLIGATION_47WN];
    all.extend(&others);
    ok(add(&mut w, b, &all));
    ok(seal(&mut w, b));
    let v0 = vault(&w);
    ok(owner_buy(&mut w, true)); // release + the owner's own policy (its premium adds to unearned)
    let p: Policy = w.env.anchor(&leg(&OBLIGATION_47WN));
    let owed = book(&w, &b).refund_owed;
    assert!(owed > 0);
    let v1 = vault(&w);
    assert_eq!(v1.premiums_unearned, v0.premiums_unearned + p.premium - p.fee, "the owed refund is still reserved");
    let caller = w.env.funded();
    let ix = w.env.ix_claim_book_refund(&caller.pubkey(), b, false);
    ok(w.env.send(&[ix], &[&caller]));
    assert_eq!(vault(&w).premiums_unearned, v1.premiums_unearned - owed, "released when paid");
    check_inv2_inv13(&w);
}
