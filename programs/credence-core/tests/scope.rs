//! SCOPE settlement source: Kamino's own Scope price (Chainlink Data Streams + Pyth Pro), read directly. Decoding of
//! the real mainnet Scope account, the close and settlement windows, halts, account substitution, and the full
//! lifecycle with real klend settling into the obligation on Scope prices.

mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use credence_core::{oracle::{self, scope}, pricing, state::*, CoreError};
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000;
const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;
const OCT13_OPEN: i64 = 1_791_898_200;
const SPY_CHAIN: usize = 344;

fn to_scope(env: &mut Env, i: usize) {
    let a = env.admin.pubkey();
    let mut p = real_asset_params(i);
    p.settle_source = oracle::source::SCOPE;
    let ix = env.ix_update_asset(&a, ticker(REAL_TICKERS[i]), p);
    env.send_admin(&[ix]).unwrap();
}

fn snapshot(env: &mut Env, t: &str, price: Pubkey) -> TxResult {
    let k = env.admin.pubkey();
    let ix = env.ix_snapshot(&k, t, GROUP_OCT9, price, None);
    env.send_admin(&[ix])
}

fn post(env: &mut Env, t: &str, updates: &[Pubkey]) -> TxResult {
    let k = env.admin.pubkey();
    let ix = env.ix_post(&k, t, GROUP_OCT9, updates, None);
    env.send_admin(&[ix])
}

/// The program decodes the real mainnet Scope account (klend snapshot fixture) to the values scope-sdk reads.
#[test]
fn decodes_real_scope_account() {
    let data = std::fs::read(format!("{}/tests/fixtures/klend/scope_prices.bin", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let snap = kl::snapshot();
    for (t, chain) in [("SPYx", 344u64), ("QQQx", 347), ("NVDAx", 332)] {
        let p = scope::decode(&data, chain).unwrap();
        assert_eq!(p.unix_timestamp, snap["scope"][t]["unixTimestamp"].as_i64().unwrap(), "{t}");
        let usd = p.price_wad as f64 / 1e18;
        println!("{t}: Scope chain {chain} = {usd:.6} USD at {}", p.unix_timestamp);
        assert!(usd > 100.0 && usd < 2_000.0, "{t} {usd}");
    }
    assert_eq!(scope::decode(&data, 512).unwrap_err(), CoreError::InvalidParam.into());
    let mut bad = data.clone();
    bad[0] ^= 1;
    assert_eq!(scope::decode(&bad, 344).unwrap_err(), CoreError::NotScopePrices.into());
}

/// Close: Scope's value refreshed in [close − 60 s, close + 15 min]; only Kamino's Scope account is accepted.
#[test]
fn scope_close_window_and_account_checks() {
    let mut env = Env::real(0);
    to_scope(&mut env, 0);
    env.set_time(OCT9_CLOSE + 30);
    // Too old (before close − close_window_secs).
    env.put_scope(SPY_CHAIN, 777.05, OCT9_CLOSE - 61);
    assert_err(snapshot(&mut env, "SPYx", SCOPE_PRICES), code(CoreError::PriceOutsideWindow));
    // A Pyth update in the price slot is refused for a SCOPE asset.
    let a: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    let pyth = env.put_price(&Px::new(a.feed_xstock, 777.05, OCT9_CLOSE - 1));
    assert_err(snapshot(&mut env, "SPYx", pyth), code(CoreError::NotScopePrices));
    // A copy of Scope's data at another address, or Scope's address owned by another program.
    let fake = Pubkey::new_unique();
    let mut acc = env.svm.get_account(&SCOPE_PRICES).unwrap();
    env.svm.set_account(fake, acc.clone()).unwrap();
    assert_err(snapshot(&mut env, "SPYx", fake), code(CoreError::NotScopePrices));
    acc.owner = Pubkey::new_unique();
    env.svm.set_account(SCOPE_PRICES, acc.clone()).unwrap();
    assert_err(snapshot(&mut env, "SPYx", SCOPE_PRICES), code(CoreError::NotScopePrices));
    acc.owner = scope::SCOPE_PROGRAM_ID;
    env.svm.set_account(SCOPE_PRICES, acc).unwrap();
    // Refreshed after the window.
    env.set_time(OCT9_CLOSE + 1_000);
    env.put_scope(SPY_CHAIN, 777.05, OCT9_CLOSE + 901);
    assert_err(snapshot(&mut env, "SPYx", SCOPE_PRICES), code(CoreError::PriceOutsideWindow));
    // Refreshed 20 s after the bell, value frozen at the close.
    env.put_scope(SPY_CHAIN, 781.52, OCT9_CLOSE + 20);
    snapshot(&mut env, "SPYx", SCOPE_PRICES).unwrap();
    let e: Epoch = env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    assert_eq!((e.state, e.close_price_wad), (epoch_state::CLOSED, 781_520_000_000_000_000_000));
}

/// Audit A-02: the close window runs to 15 minutes after the bell and QQQx's Scope price moves after hours, so if
/// anyone could call `snapshot_close`, a policy holder would wait for the highest QQQx price in that window and store it
/// as the close (a larger gap, a larger payout). Only the keeper stores the close, as only the keeper posts settlement.
#[test]
fn only_the_keeper_stores_the_close() {
    let mut env = Env::real(0);
    to_scope(&mut env, 1);
    let qqq = 347;
    env.set_time(OCT9_CLOSE + 300);
    env.put_scope(qqq, 762.40, OCT9_CLOSE + 290); // 0.25% above the 4 PM print, five minutes after the bell
    let holder = env.funded();
    let ix = env.ix_snapshot(&holder.pubkey(), "QQQx", GROUP_OCT9, SCOPE_PRICES, None);
    assert_err(env.send(&[ix], &[&holder]), code(CoreError::Unauthorized));
    let e: Epoch = env.anchor(&epoch_pda(&ticker("QQQx"), GROUP_OCT9));
    assert_eq!(e.state, epoch_state::OPEN);
    snapshot(&mut env, "QQQx", SCOPE_PRICES).unwrap();
}

/// Settlement: from open + 60 s, Scope refreshed in [open + 60 s, open + 6 min], one account; halt after the window.
#[test]
fn scope_settlement_window_and_halt() {
    let mut env = Env::real(0);
    to_scope(&mut env, 2);
    let nv = 332;
    env.set_time(OCT9_CLOSE + 30);
    env.put_scope(nv, 237.50, OCT9_CLOSE + 10);
    snapshot(&mut env, "NVDAx", SCOPE_PRICES).unwrap();

    // Pre-market price refreshed at the open: not yet.
    env.put_scope(nv, 228.0, OCT12_OPEN + 5);
    env.set_time(OCT12_OPEN + 30);
    assert_err(post(&mut env, "NVDAx", &[SCOPE_PRICES]), code(CoreError::TooEarly));
    env.set_time(OCT12_OPEN + 61);
    assert_err(post(&mut env, "NVDAx", &[SCOPE_PRICES]), code(CoreError::PriceOutsideWindow));
    env.put_scope(nv, 226.0, OCT12_OPEN + 61);
    assert_err(post(&mut env, "NVDAx", &[SCOPE_PRICES, SCOPE_PRICES]), code(CoreError::InvalidParam));
    let k = env.admin.pubkey();
    let ix = env.ix_halt(&k, "NVDAx", GROUP_OCT9);
    assert_err(env.send_admin(&[ix]), code(CoreError::TooEarly));
    post(&mut env, "NVDAx", &[SCOPE_PRICES]).unwrap();
    let e: Epoch = env.anchor(&epoch_pda(&ticker("NVDAx"), GROUP_OCT9));
    assert_eq!((e.state, e.settle_price_wad, e.settled_at), (epoch_state::SETTLED, 226 * 10u128.pow(18), OCT12_OPEN + 61));

    // SPYx on SCOPE with no refresh in its window: halt after open + 6 min, retry Tuesday.
    to_scope(&mut env, 0);
    env.put_scope(SPY_CHAIN, 781.52, OCT9_CLOSE + 10);
    env.set_time(OCT9_CLOSE + 40);
    snapshot(&mut env, "SPYx", SCOPE_PRICES).unwrap();
    env.set_time(OCT12_OPEN + 360);
    let ix = env.ix_halt(&k, "SPYx", GROUP_OCT9);
    assert_err(env.send_admin(&[ix.clone()]), code(CoreError::TooEarly));
    env.set_time(OCT12_OPEN + 361);
    env.send_admin(&[ix]).unwrap();
    let e: Epoch = env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    assert_eq!((e.state, e.open), (epoch_state::HALTED, OCT13_OPEN));
    env.put_scope(SPY_CHAIN, 770.0, OCT13_OPEN + 90);
    env.set_time(OCT13_OPEN + 95);
    post(&mut env, "SPYx", &[SCOPE_PRICES]).unwrap();
}

/// Asset registration refuses a Scope chain outside the account.
#[test]
fn scope_chain_bounds() {
    let mut env = Env::real(0);
    let a = env.admin.pubkey();
    let mut p = real_asset_params(0);
    p.scope_chain = 512;
    let ix = env.ix_update_asset(&a, ticker("SPYx"), p);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));
}

/// Full lifecycle on Kamino's own price with the real klend program: buy cover on the obligation, Friday close and
/// Monday open from Scope chain 344 (SPYx −10% at the open), settle_policy repays into the obligation.
#[test]
fn scope_lifecycle_settles_into_real_obligation() {
    let mut env = Env::real(LP);
    to_scope(&mut env, 0);
    let owner = env.funded();
    env.load_klend_with(&owner.pubkey(), |d| ob::scale_debt(d, 125, 100));
    let owner_usdc = env.usdc_account(&owner.pubkey(), 100_000_000_000);
    let mut ixs = kl::refreshes();
    let debt = (kl::debt_sf(&env) >> 60) as u64;
    ixs.push(env.ix_buy_cover(&BuyArgs {
        buyer: owner.pubkey(),
        buyer_usdc: owner_usdc,
        obligation: OBLIGATION_47WN,
        deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"),
        closure_id: GROUP_OCT9,
        max_payout: debt / 5,
        max_premium: u64::MAX,
    }));
    env.send(&ixs, &[&owner]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let policy = policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &OBLIGATION_47WN);

    // Friday: Kamino's price frozen at the close.
    env.set_time(OCT9_CLOSE + 45);
    env.put_scope(SPY_CHAIN, 781.52, OCT9_CLOSE + 30);
    snapshot(&mut env, "SPYx", SCOPE_PRICES).unwrap();
    // Monday: Kamino's own price opens 10% lower; the keeper reads it a minute after the open.
    env.svm.warp_to_slot(env.slot() + 10);
    env.set_time(OCT12_OPEN + 75);
    env.freshen_scope(); // every Scope entry refreshed now (klend's price-age check), then the gapped SPYx
    env.put_scope(SPY_CHAIN, 781.52 * 0.9, OCT12_OPEN + 75);
    let m = post(&mut env, "SPYx", &[SCOPE_PRICES]).unwrap();
    println!("post_settlement (SCOPE): {} CU", m.compute_units_consumed);
    let p: Policy = env.anchor(&policy);
    let e: Epoch = env.anchor(&p.epoch);
    let want = pricing::realized_payout(p.covered_value, p.debt, p.max_payout, e.close_price_wad, e.settle_price_wad).unwrap();
    let approx = p.debt as f64 - p.covered_value as f64 * 0.9;
    assert!((want as f64 - approx).abs() < 2.0, "payout {want} vs D − 0.9 C′ = {approx}");

    let keeper = env.funded();
    env.send(&kl::refreshes(), &[&keeper]).unwrap(); // accrue the weekend's interest first, then measure
    env.svm.warp_to_slot(env.slot() + 1);
    env.freshen_scope();
    env.put_scope(SPY_CHAIN, 781.52 * 0.9, OCT12_OPEN + 75);
    let debt_before = kl::debt_sf(&env);
    let mut ixs = kl::refreshes();
    ixs.push(env.ix_settle(&keeper.pubkey(), policy, owner_usdc, true));
    let m = env.send(&ixs, &[&keeper]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("refreshes + settle_policy on Scope prices: {} CU", m.compute_units_consumed);
    assert_eq!(env.anchor::<Policy>(&policy).payout, want);
    let fell = (debt_before - kl::debt_sf(&env)) >> 60;
    assert!(fell.abs_diff(want as u128) <= 1, "debt fell {fell}, payout {want}");
}
