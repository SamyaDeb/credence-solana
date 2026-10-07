//! Task 2.2: calendar upload and `open_epoch` for the next four weekends, with times checked in UTC across the
//! Nov 1, 2026 daylight-saving change and the Nov 27 half day. Expected times computed independently (Python
//! zoneinfo, America/New_York).

mod common;

use common::*;
use credence_core::{state::*, CoreError};
use solana_signer::Signer;

const OCT8_NOON_ET: i64 = 1_791_475_200;

fn setup() -> Env {
    let mut env = Env::new();
    env.init_config();
    env.add_asset("SPYx", SPYX_MINT, WAD / 100, 0);
    env.add_asset("NVDAx", NVDAX_MINT, WAD / 100, 2);
    env.upload_calendar();
    env.set_time(OCT8_NOON_ET);
    env
}

fn open(env: &mut Env, t: &str, closure_id: u32) -> TxResult {
    let p = env.admin.pubkey();
    if env.svm.get_account(&loss_pda(closure_id)).is_none() {
        let ix = env.ix_open_group(&p, closure_id);
        env.send_admin(&[ix])?;
    }
    let ix = env.ix_open_epoch(&p, ticker(t), closure_id);
    env.send_admin(&[ix])
}

#[test]
fn calendar_uploaded_and_hashed() {
    let env = setup();
    let c: Calendar = env.zc(&calendar_pda());
    assert_eq!(c.finalized, 1);
    assert_eq!(c.n, 230);
    assert_eq!(c.sessions[0].date, 20261001);
    assert_eq!(env.data(&calendar_pda()).len(), Calendar::SIZE);
}

/// Acceptance 2.2: the next four weekends (Oct 9, 16, 23, 30), with correct bell, close and open in UTC. Oct 30 closes
/// on EDT (UTC−4) and reopens on EST (UTC−5) after US clocks change on Nov 1.
#[test]
fn next_four_weekends_in_utc() {
    let mut env = setup();
    let tk = ticker("SPYx");
    for (closure_id, sale_open, close, open_) in [
        (20261009u32, 1_791_207_000i64, 1_791_576_000i64, 1_791_811_800i64),
        (20261016, 1_791_811_800, 1_792_180_800, 1_792_416_600),
        (20261023, 1_792_416_600, 1_792_785_600, 1_793_021_400),
        (20261030, 1_793_021_400, 1_793_390_400, 1_793_629_800),
    ] {
        open(&mut env, "SPYx", closure_id).unwrap();
        let e: Epoch = env.anchor(&epoch_pda(&tk, closure_id));
        assert_eq!(e.state, epoch_state::OPEN);
        assert_eq!(e.closure_type, closure::WEEKEND);
        assert_eq!((e.ticker, e.closure_id), (tk, closure_id));
        assert_eq!(e.sale_open, sale_open, "{closure_id} sale_open");
        assert_eq!(e.close, close, "{closure_id} close");
        assert_eq!(e.bell, close - 900, "{closure_id} bell");
        assert_eq!(e.open, open_, "{closure_id} open");
        assert_eq!(e.settle_after, open_ + 300, "{closure_id} settle_after");
    }
    // Oct 30: 16:00 EDT = 20:00 UTC; Nov 2: 09:30 EST = 14:30 UTC (a 66.5-hour weekend).
    let e: Epoch = env.anchor(&epoch_pda(&tk, 20261030));
    assert_eq!(e.close % 86_400, 20 * 3600);
    assert_eq!(e.open % 86_400, 14 * 3600 + 1800);
    assert_eq!(e.open - e.close, 66 * 3600 + 1800);
    // A second asset shares the weekend's loss vector.
    open(&mut env, "NVDAx", 20261009).unwrap();
}

/// The Friday after Thanksgiving closes at 13:00 ET: the bell moves with it.
#[test]
fn half_day_friday() {
    let mut env = setup();
    open(&mut env, "SPYx", 20261127).unwrap();
    let e: Epoch = env.anchor(&epoch_pda(&ticker("SPYx"), 20261127));
    assert_eq!(e.close, 1_795_802_400);
    assert_eq!(e.bell, 1_795_802_400 - 900);
    assert_eq!(e.sale_open, 1_795_444_200);
    assert_eq!(e.open, 1_796_049_000);
}

#[test]
fn open_epoch_failures() {
    let mut env = setup();
    // Not a session (Saturday).
    assert_err(open(&mut env, "SPYx", 20261010), code(CoreError::NotASession));
    // A weekday: overnight closure (Phase 1 sells weekends only).
    assert_err(open(&mut env, "SPYx", 20261008), code(CoreError::UnsupportedClosure));
    // Friday before Martin Luther King Day (Mon Jan 18, 2027): holiday weekend.
    assert_err(open(&mut env, "SPYx", 20270115), code(CoreError::UnsupportedClosure));
    // Twice.
    open(&mut env, "SPYx", 20261009).unwrap();
    assert_fails(open(&mut env, "SPYx", 20261009));
    // After the bell (INV-3: no epoch is created to sell into).
    env.set_time(1_791_576_000 - 900);
    assert_err(open(&mut env, "NVDAx", 20261009), code(CoreError::SalesClosed));
    env.set_time(OCT8_NOON_ET);
    // Without the weekend's loss vector.
    let p = env.admin.pubkey();
    let ix = env.ix_open_epoch(&p, ticker("SPYx"), 20261016);
    assert_fails(env.send_admin(&[ix]));
    // Unknown asset.
    assert_fails(open(&mut env, "TSLAx", 20261016));
    // Paused: risk-increasing instructions are refused.
    let ix = env.ix_set_paused(&p, true);
    env.send_admin(&[ix]).unwrap();
    assert_err(open(&mut env, "SPYx", 20261023), code(CoreError::Paused));
}

#[test]
fn calendar_upload_failures() {
    let mut env = Env::new();
    env.init_config();
    let a = env.admin.pubkey();
    let mallory = env.funded();
    let ix = env.ix_init_calendar(&mallory.pubkey(), 3);
    assert_err(env.send(&[ix], &[&mallory]), code(CoreError::Unauthorized));
    let ix = env.ix_init_calendar(&a, 3);
    env.send_admin(&[ix]).unwrap();
    let s = |date, open| SessionArg { date, open, close: open + 23_400 };
    // Out of order.
    let ix = env.ix_write_calendar(&a, 0, vec![s(20261002, 1_790_947_800), s(20261001, 1_790_861_400), s(20261005, 1_791_207_000)]);
    env.send_admin(&[ix]).unwrap();
    let ix = env.ix_finalize_calendar(&a, [0; 32]);
    assert_err(env.send_admin(&[ix]), code(CoreError::NotSorted));
    // Sorted but wrong hash.
    let ix = env.ix_write_calendar(&a, 0, vec![s(20261001, 1_790_861_400), s(20261002, 1_790_947_800), s(20261005, 1_791_207_000)]);
    env.send_admin(&[ix]).unwrap();
    let ix = env.ix_finalize_calendar(&a, [0; 32]);
    assert_err(env.send_admin(&[ix]), code(CoreError::HashMismatch));
    // Past the declared length.
    let ix = env.ix_write_calendar(&a, 2, vec![s(20261005, 1_791_207_000), s(20261006, 1_791_293_400)]);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));
}

#[test]
fn pause_rules() {
    let mut env = setup();
    let a = env.admin.pubkey();
    let mallory = env.funded();
    let ix = env.ix_set_paused(&mallory.pubkey(), true);
    assert_err(env.send(&[ix], &[&mallory]), code(CoreError::Unauthorized));
    let ix = env.ix_set_paused(&a, true);
    env.send_admin(&[ix]).unwrap();
    assert!(env.anchor::<Config>(&config_pda()).paused);
    let ix = env.ix_set_paused(&a, false);
    env.send_admin(&[ix]).unwrap();
    assert!(!env.anchor::<Config>(&config_pda()).paused);
}
