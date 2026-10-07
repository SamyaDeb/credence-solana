//! Task 2.4: `snapshot_close`, `post_settlement`, `halt_epoch` from Pyth `PriceUpdateV2` (INV-4).
//! Real SPYx mint (Scaled UI multiplier 1.003909 → 1.005715 from 2026-06-18), synthetic but realistic updates.

mod common;

use anchor_lang::{prelude::Pubkey, solana_program::instruction::{AccountMeta, Instruction}, InstructionData, ToAccountMetas};
use common::*;
use credence_core::{accounts as acc, instruction as ix, oracle, state::*, CoreError};
use solana_signer::Signer;

const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;
const OCT13_OPEN: i64 = 1_791_898_200;
const MULT_SPYX: f64 = 1.005714560286254;

fn feeds(env: &Env, t: &str) -> ([u8; 32], [u8; 32]) {
    let a: AssetConfig = env.zc(&asset_pda(&ticker(t)));
    (a.feed_equity, a.feed_xstock)
}

fn ix_snapshot(env: &Env, caller: &Pubkey, t: &str, price: Pubkey, xcheck: Option<Pubkey>) -> Instruction {
    let tk = ticker(t);
    let _ = env;
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SnapshotClose { ticker: tk, closure_id: GROUP_OCT9 }.data(),
        acc::SnapshotClose {
            caller: *caller,
            config: config_pda(),
            asset: asset_pda(&tk),
            epoch: epoch_pda(&tk, GROUP_OCT9),
            mint: REAL_MINTS[REAL_TICKERS.iter().position(|x| *x == t).unwrap()],
            price,
            xcheck,
        }
        .to_account_metas(None),
    )
}

fn ix_post(keeper: &Pubkey, t: &str, updates: &[Pubkey], xcheck: Option<Pubkey>) -> Instruction {
    let tk = ticker(t);
    let mut metas = acc::PostSettlement {
        keeper: *keeper,
        config: config_pda(),
        asset: asset_pda(&tk),
        epoch: epoch_pda(&tk, GROUP_OCT9),
        mint: REAL_MINTS[REAL_TICKERS.iter().position(|x| *x == t).unwrap()],
        xcheck,
    }
    .to_account_metas(None);
    metas.extend(updates.iter().map(|k| AccountMeta::new_readonly(*k, false)));
    Instruction::new_with_bytes(credence_core::ID, &ix::PostSettlement { ticker: tk, closure_id: GROUP_OCT9 }.data(), metas)
}

fn ix_halt(keeper: &Pubkey, t: &str) -> Instruction {
    let tk = ticker(t);
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::HaltEpoch { ticker: tk, closure_id: GROUP_OCT9 }.data(),
        acc::HaltEpoch {
            keeper: *keeper,
            config: config_pda(),
            asset: asset_pda(&tk),
            epoch: epoch_pda(&tk, GROUP_OCT9),
            calendar: calendar_pda(),
        }
        .to_account_metas(None),
    )
}

/// Friday close: SPY 777.05 at 15:59:59 ET, SPYX token 781.52 → per token 777.05 × 1.005715.
fn close_spyx(env: &mut Env) {
    let (eq, xs) = feeds(env, "SPYx");
    env.set_time(OCT9_CLOSE + 30);
    let p = env.put_price(&Px::new(eq, 777.05, OCT9_CLOSE - 1));
    let x = env.put_price(&Px::new(xs, 781.52, OCT9_CLOSE - 600));
    let a = env.admin.pubkey();
    let ix = ix_snapshot(env, &a, "SPYx", p, Some(x));
    env.send_admin(&[ix]).unwrap();
}

#[test]
fn multiplier_from_real_mint() {
    let d = fixture("mint_SPYx");
    let before = oracle::scaled_ui_multiplier_wad(&d, 1_781_755_199).unwrap();
    let after = oracle::scaled_ui_multiplier_wad(&d, 1_781_755_200).unwrap();
    assert_eq!(before, 1_003_909_240_011_759_000);
    assert_eq!(after, 1_005_714_560_286_254_000);
    // USDC (classic SPL Token, no extensions): multiplier 1.
    assert_eq!(oracle::scaled_ui_multiplier_wad(&fixture("mint_USDC"), 0).unwrap(), WAD as u128);
}

#[test]
fn snapshot_close_equity_times_multiplier() {
    let mut env = Env::real(0);
    close_spyx(&mut env);
    let e: Epoch = env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    assert_eq!(e.state, epoch_state::CLOSED);
    assert_eq!(e.close_multiplier_wad, 1_005_714_560_286_254_000);
    let want = oracle::per_token(777_050_000_000_000_000_000, 1_005_714_560_286_254_000).unwrap();
    assert_eq!(e.close_price_wad, want);
    assert!(((e.close_price_wad as f64 / 1e18) - 777.05 * MULT_SPYX).abs() < 1e-9);
}

#[test]
fn snapshot_close_failures() {
    let mut env = Env::real(0);
    let (eq, xs) = feeds(&env, "SPYx");
    let a = env.admin.pubkey();
    let x = env.put_price(&Px::new(xs, 781.52, OCT9_CLOSE - 600));
    let mut try_close = |env: &mut Env, p: Px, xcheck: Option<Pubkey>| {
        let k = env.put_price(&p);
        let ix = ix_snapshot(env, &a, "SPYx", k, xcheck);
        env.send_admin(&[ix])
    };
    // Before the close.
    env.set_time(OCT9_CLOSE - 1);
    assert_err(try_close(&mut env, Px::new(eq, 777.05, OCT9_CLOSE - 2), Some(x)), code(CoreError::TooEarly));
    env.set_time(OCT9_CLOSE + 30);
    // INV-4: published before the close window, or after the close.
    assert_err(try_close(&mut env, Px::new(eq, 777.05, OCT9_CLOSE - 61), Some(x)), code(CoreError::PriceOutsideWindow));
    assert_err(try_close(&mut env, Px::new(eq, 777.05, OCT9_CLOSE + 1), Some(x)), code(CoreError::PriceOutsideWindow));
    // Wrong feed (the xStock feed where the equity feed is due).
    assert_err(try_close(&mut env, Px::new(xs, 781.52, OCT9_CLOSE - 1), Some(x)), code(CoreError::WrongFeed));
    // Partially verified.
    let mut p = Px::new(eq, 777.05, OCT9_CLOSE - 1);
    p.full = false;
    assert_err(try_close(&mut env, p, Some(x)), code(CoreError::PriceNotVerified));
    // Confidence 1% > 0.5%.
    let mut p = Px::new(eq, 777.05, OCT9_CLOSE - 1);
    p.conf = (p.price / 100) as u64;
    assert_err(try_close(&mut env, p, Some(x)), code(CoreError::PriceConfidenceTooWide));
    // Not owned by the Pyth receiver.
    let mut p = Px::new(eq, 777.05, OCT9_CLOSE - 1);
    p.owner = Some(Pubkey::new_unique());
    assert_fails(try_close(&mut env, p, Some(x)));
    // Cross-check missing, or 5% away.
    assert_err(try_close(&mut env, Px::new(eq, 777.05, OCT9_CLOSE - 1), None), code(CoreError::CrossCheckFailed));
    let far = env.put_price(&Px::new(xs, 781.52 * 1.05, OCT9_CLOSE - 600));
    assert_err(try_close(&mut env, Px::new(eq, 777.05, OCT9_CLOSE - 1), Some(far)), code(CoreError::CrossCheckFailed));
    // Cross-check update from hours earlier.
    let old = env.put_price(&Px::new(xs, 781.52, OCT9_CLOSE - 3 * 3600));
    assert_err(try_close(&mut env, Px::new(eq, 777.05, OCT9_CLOSE - 1), Some(old)), code(CoreError::PriceOutsideWindow));
    // Valid, then twice.
    try_close(&mut env, Px::new(eq, 777.05, OCT9_CLOSE - 1), Some(x)).unwrap();
    assert_err(try_close(&mut env, Px::new(eq, 777.05, OCT9_CLOSE - 1), Some(x)), code(CoreError::WrongEpochState));
}

/// Settlement averages the window's updates; a −8% open settles at 0.92 × close.
#[test]
fn post_settlement_averages_window() {
    let mut env = Env::real(0);
    close_spyx(&mut env);
    let (eq, xs) = feeds(&env, "SPYx");
    let k = env.admin.pubkey();
    let ups: Vec<Pubkey> = [(714.0, 0), (715.0, 60), (716.0, 240)]
        .iter()
        .map(|(p, dt)| env.put_price(&Px::new(eq, *p, OCT12_OPEN + dt)))
        .collect();
    let x = env.put_price(&Px::new(xs, 719.5, OCT12_OPEN + 120));
    // Not before the window has ended.
    env.set_time(OCT12_OPEN + 299);
    assert_err(env.send_admin(&[ix_post(&k, "SPYx", &ups, Some(x))]), code(CoreError::TooEarly));
    env.set_time(OCT12_OPEN + 301);
    let m = env.send_admin(&[ix_post(&k, "SPYx", &ups, Some(x))]).unwrap();
    println!("post_settlement (3 updates + cross-check): {} CU", m.compute_units_consumed);
    let e: Epoch = env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    assert_eq!(e.state, epoch_state::SETTLED);
    let want = oracle::per_token(715_000_000_000_000_000_000, 1_005_714_560_286_254_000).unwrap();
    assert_eq!(e.settle_price_wad, want);
    let r = e.settle_price_wad as f64 / e.close_price_wad as f64 - 1.0;
    assert!((r - (715.0 / 777.05 - 1.0)).abs() < 1e-12, "gap {r}");
}

/// INV-4: any update outside [open, open + 5 min] fails the whole settlement; so does a repeated update.
#[test]
fn inv4_settlement_rejects_updates_outside_window() {
    let mut env = Env::real(0);
    close_spyx(&mut env);
    let (eq, xs) = feeds(&env, "SPYx");
    let k = env.admin.pubkey();
    env.set_time(OCT12_OPEN + 400);
    let x = env.put_price(&Px::new(xs, 719.5, OCT12_OPEN + 120));
    let good = env.put_price(&Px::new(eq, 715.0, OCT12_OPEN + 10));
    for dt in [-1i64, 301, -3 * 86_400] {
        let bad = env.put_price(&Px::new(eq, 700.0, OCT12_OPEN + dt));
        assert_err(env.send_admin(&[ix_post(&k, "SPYx", &[good, bad], Some(x))]), code(CoreError::PriceOutsideWindow));
    }
    // Same update twice to weight it double.
    assert_err(env.send_admin(&[ix_post(&k, "SPYx", &[good, good], Some(x))]), code(CoreError::DuplicateUpdate));
    // Keeper only.
    let mallory = env.funded();
    let ix = ix_post(&mallory.pubkey(), "SPYx", &[good], Some(x));
    assert_err(env.send(&[ix], &[&mallory]), code(CoreError::Unauthorized));
    // No updates at all.
    assert_err(env.send_admin(&[ix_post(&k, "SPYx", &[], Some(x))]), code(CoreError::InvalidParam));
    let e: Epoch = env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    assert_eq!(e.state, epoch_state::CLOSED);
    env.send_admin(&[ix_post(&k, "SPYx", &[good], Some(x))]).unwrap();
}

/// No valid update at the Monday open: HALTED, retried at Tuesday's open; Monday's updates are then outside the window.
#[test]
fn halt_moves_to_next_session() {
    let mut env = Env::real(0);
    let k = env.admin.pubkey();
    // Not before the close snapshot / not before the window ends.
    assert_err(env.send_admin(&[ix_halt(&k, "SPYx")]), code(CoreError::WrongEpochState));
    close_spyx(&mut env);
    env.set_time(OCT12_OPEN + 300);
    assert_err(env.send_admin(&[ix_halt(&k, "SPYx")]), code(CoreError::TooEarly));
    env.set_time(OCT12_OPEN + 3600);
    env.send_admin(&[ix_halt(&k, "SPYx")]).unwrap();
    let e: Epoch = env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    assert_eq!((e.state, e.open, e.settle_after), (epoch_state::HALTED, OCT13_OPEN, OCT13_OPEN + 300));
    let (eq, xs) = feeds(&env, "SPYx");
    let monday = env.put_price(&Px::new(eq, 715.0, OCT12_OPEN + 10));
    let x = env.put_price(&Px::new(xs, 719.5, OCT13_OPEN));
    env.set_time(OCT13_OPEN + 301);
    assert_err(env.send_admin(&[ix_post(&k, "SPYx", &[monday], Some(x))]), code(CoreError::PriceOutsideWindow));
    let tuesday = env.put_price(&Px::new(eq, 716.0, OCT13_OPEN + 5));
    env.send_admin(&[ix_post(&k, "SPYx", &[tuesday], Some(x))]).unwrap();
    assert_eq!(env.anchor::<Epoch>(&epoch_pda(&ticker("SPYx"), GROUP_OCT9)).state, epoch_state::SETTLED);
}

/// NVDAx on the XSTOCK source (`Crypto.NVDAX/USD`, no multiplier, no cross-check account).
fn nvdax_xstock(env: &mut Env) -> [u8; 32] {
    let a = env.admin.pubkey();
    let mut p = real_asset_params(2);
    p.settle_source = oracle::source::XSTOCK;
    let ix = env.ix_update_asset(&a, ticker("NVDAx"), p);
    env.send_admin(&[ix]).unwrap();
    feeds(env, "NVDAx").1
}

/// The program derives the same push accounts the recorder reads on mainnet.
#[test]
fn push_accounts_match_mainnet() {
    let env = Env::real(0);
    for (t, want) in [
        ("SPYx", "27Tv3HxU34AKxZ8MgfFAA1gCbWa96msMG5BvSWAHkBfj"),
        ("QQQx", "BMcyd2UQqakGbWnNRAC67TLAFhV64dzLVeEyRHKyzmUi"),
        ("NVDAx", "VSgf6jkwrcs9jbLuR57iN1Gk2c68vT9stZe8G6GGix2"),
    ] {
        assert_eq!(oracle::push_account(&feeds(&env, t).1).to_string(), want, "{t}");
    }
}

/// Fallback source: `Crypto.<T>X/USD` directly from the push account; the close window is `xstock_settle_window_secs`
/// (the last push before a 16:00 close comes 4–14 min earlier, plan/09).
#[test]
fn xstock_source_fallback() {
    let mut env = Env::real(0);
    let a = env.admin.pubkey();
    let xs = nvdax_xstock(&mut env);
    let eq = feeds(&env, "NVDAx").0;
    env.set_time(OCT9_CLOSE + 30);
    // The equity feed is the wrong feed (even at the push address of the xStock feed it is refused).
    let wrong = env.put_price_at(oracle::push_account(&xs), &Px::new(eq, 236.0, OCT9_CLOSE - 1));
    let ix = ix_snapshot(&env, &a, "NVDAx", wrong, None);
    assert_err(env.send_admin(&[ix]), code(CoreError::WrongFeed));
    // The right feed, but not from the push account: anyone could post a hand-picked update there.
    let posted = env.put_price(&Px::new(xs, 237.49882181, OCT9_CLOSE - 20));
    let ix = ix_snapshot(&env, &a, "NVDAx", posted, None);
    assert_err(env.send_admin(&[ix]), code(CoreError::NotPushAccount));
    // Older than the window.
    let px = env.put_push(&Px::new(xs, 237.0, OCT9_CLOSE - 3601));
    let ix = ix_snapshot(&env, &a, "NVDAx", px, None);
    assert_err(env.send_admin(&[ix]), code(CoreError::PriceOutsideWindow));
    // The last push, 13.8 min before the close (as on Fri Oct 2: 19:46:12 UTC).
    let px = env.put_push(&Px::new(xs, 237.49882181, OCT9_CLOSE - 828));
    let ix = ix_snapshot(&env, &a, "NVDAx", px, None);
    env.send_admin(&[ix]).unwrap();
    let e: Epoch = env.anchor(&epoch_pda(&ticker("NVDAx"), GROUP_OCT9));
    assert_eq!(e.close_price_wad, 237_498_821_810_000_000_000);
}

/// XSTOCK settles on the first push update at or after the open, as soon as it exists (no 5-minute wait), within
/// `[open, open + xstock_settle_window_secs]`; one update, from the push account.
#[test]
fn xstock_settles_on_first_push_after_open() {
    let mut env = Env::real(0);
    let k = env.admin.pubkey();
    let xs = nvdax_xstock(&mut env);
    env.set_time(OCT9_CLOSE + 30);
    let c = env.put_push(&Px::new(xs, 237.5, OCT9_CLOSE - 828));
    env.send_admin(&[ix_snapshot(&env, &k, "NVDAx", c, None)]).unwrap();

    // Monday before the open: the push account still holds a pre-open update.
    let pre = env.put_push(&Px::new(xs, 230.0, OCT12_OPEN - 60));
    env.set_time(OCT12_OPEN - 1);
    assert_err(env.send_admin(&[ix_post(&k, "NVDAx", &[pre], None)]), code(CoreError::TooEarly));
    env.set_time(OCT12_OPEN + 5);
    assert_err(env.send_admin(&[ix_post(&k, "NVDAx", &[pre], None)]), code(CoreError::PriceOutsideWindow));
    // The first push after the open (12 s after it, as on Mon Oct 5), posted at once.
    let first = env.put_push(&Px::new(xs, 225.0, OCT12_OPEN + 12));
    env.set_time(OCT12_OPEN + 13);
    let other = env.put_price(&Px::new(xs, 226.0, OCT12_OPEN + 20));
    assert_err(env.send_admin(&[ix_post(&k, "NVDAx", &[other], None)]), code(CoreError::NotPushAccount));
    assert_err(env.send_admin(&[ix_post(&k, "NVDAx", &[first, other], None)]), code(CoreError::InvalidParam));
    env.send_admin(&[ix_post(&k, "NVDAx", &[first], None)]).unwrap();
    let e: Epoch = env.anchor(&epoch_pda(&ticker("NVDAx"), GROUP_OCT9));
    assert_eq!((e.state, e.settle_price_wad, e.settled_at), (epoch_state::SETTLED, 225 * 10u128.pow(18), OCT12_OPEN + 13));
}

/// XSTOCK: no push update in `[open, open + w]` → halt only after `open + w`; the window moves to the next session.
#[test]
fn xstock_halts_only_after_its_window() {
    let mut env = Env::real(0);
    let k = env.admin.pubkey();
    let xs = nvdax_xstock(&mut env);
    env.set_time(OCT9_CLOSE + 30);
    let c = env.put_push(&Px::new(xs, 237.5, OCT9_CLOSE - 828));
    env.send_admin(&[ix_snapshot(&env, &k, "NVDAx", c, None)]).unwrap();
    env.set_time(OCT12_OPEN + 3600);
    assert_err(env.send_admin(&[ix_halt(&k, "NVDAx")]), code(CoreError::TooEarly));
    // Too late for the window: an update at open + 1 h + 1 s is refused.
    let late = env.put_push(&Px::new(xs, 225.0, OCT12_OPEN + 3601));
    env.set_time(OCT12_OPEN + 3602);
    assert_err(env.send_admin(&[ix_post(&k, "NVDAx", &[late], None)]), code(CoreError::PriceOutsideWindow));
    env.send_admin(&[ix_halt(&k, "NVDAx")]).unwrap();
    let e: Epoch = env.anchor(&epoch_pda(&ticker("NVDAx"), GROUP_OCT9));
    assert_eq!((e.state, e.open), (epoch_state::HALTED, OCT13_OPEN));
    let tue = env.put_push(&Px::new(xs, 226.0, OCT13_OPEN + 40));
    env.set_time(OCT13_OPEN + 41);
    env.send_admin(&[ix_post(&k, "NVDAx", &[tue], None)]).unwrap();
}

/// `xstock_settle_window_secs` must be in (0, 1 h].
#[test]
fn xstock_window_bounds() {
    let mut env = Env::real(0);
    let a = env.admin.pubkey();
    for (w, ok) in [(0u32, false), (3600, true), (3601, false), (900, true)] {
        let mut p = default_params(a, a);
        p.xstock_settle_window_secs = w;
        let ix = env.ix_set_params(&a, p);
        let r = env.send_admin(&[ix]);
        if ok {
            r.unwrap();
        } else {
            assert_err(r, code(CoreError::InvalidParam));
        }
    }
}
