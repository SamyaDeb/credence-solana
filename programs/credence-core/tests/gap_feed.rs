//! C3.1 the Gap Oracle feed: `init_gap_feed`, `set_gap_feed_params`, the permissionless `update_gap_feed`.
//! Attack tests first: a price at another address, a Scope-shaped account not owned by Scope, the wrong Jupiter oracle,
//! another asset's epoch, stale inputs, updates faster than the limit, no funds moved, and the feed's P(gap < −x) equal
//! to `risk-core` on the same inputs.

mod common;

use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction, InstructionData, ToAccountMetas};
use common::*;
use credence_core::{
    accounts as acc, instruction as ix,
    oracle::{self, push_account},
    state::{feed_flag as ff, *},
    CoreError,
};
use litesvm::types::FailedTransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;

const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;
const SPY_CHAIN: usize = 344;
const MIN_SLOTS: u32 = 10;
const MAX_AGE: u32 = 3_600;

fn feed_pda(t: &str) -> Pubkey {
    pda(&[SEED_FEED, &ticker(t)])
}

fn ix_init(admin: &Pubkey, t: &str, min_slots: u32, max_age: u32) -> Instruction {
    let tk = ticker(t);
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::InitGapFeed { ticker: tk, min_update_slots: min_slots, max_input_age_secs: max_age }.data(),
        acc::InitGapFeed { admin: *admin, config: config_pda(), asset: asset_pda(&tk), feed: feed_pda(t),
            system_program: anchor_lang::solana_program::system_program::ID }
            .to_account_metas(None),
    )
}

fn ix_set(admin: &Pubkey, t: &str, min_slots: u32, max_age: u32) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SetGapFeedParams { ticker: ticker(t), min_update_slots: min_slots, max_input_age_secs: max_age }.data(),
        acc::SetGapFeedParams { admin: *admin, config: config_pda(), feed: feed_pda(t) }.to_account_metas(None),
    )
}

/// The derived accounts of one `update_gap_feed`; a test overrides one to attack it.
#[derive(Clone)]
struct Upd {
    t: &'static str,
    closure_id: u32,
    closure_type: u8,
    scenario: Option<Pubkey>,
    epoch: Option<Pubkey>,
    fair: Option<Pubkey>,
    lender: Option<Pubkey>,
}

impl Upd {
    fn kamino(t: &'static str) -> Self {
        Upd { t, closure_id: GROUP_OCT9, closure_type: closure::WEEKEND, scenario: None, epoch: None, fair: None, lender: None }
    }
    fn ix(&self, env: &Env) -> Instruction {
        let tk = ticker(self.t);
        let a: AssetConfig = env.zc(&asset_pda(&tk));
        let lender = self.lender.unwrap_or(if a.lender == lender::JUPITER as u64 { a.lender_oracle } else { SCOPE_PRICES });
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::UpdateGapFeed { ticker: tk }.data(),
            acc::UpdateGapFeed {
                config: config_pda(),
                asset: asset_pda(&tk),
                calendar: calendar_pda(),
                feed: feed_pda(self.t),
                scenario: self.scenario.unwrap_or_else(|| scen_pda(&tk, self.closure_type)),
                epoch: self.epoch.unwrap_or_else(|| epoch_pda(&tk, self.closure_id)),
                fair: self.fair.unwrap_or_else(|| push_account(&a.feed_xstock)),
                lender,
            }
            .to_account_metas(None),
        )
    }
}

fn crank(env: &mut Env, payer: &Keypair, u: &Upd) -> TxResult {
    let i = u.ix(env);
    env.send(&[i], &[payer])
}

fn feed(env: &Env, t: &str) -> GapFeed {
    env.zc(&feed_pda(t))
}

fn to_scope(env: &mut Env, i: usize) {
    let a = env.admin.pubkey();
    let mut p = real_asset_params(i);
    p.settle_source = oracle::source::SCOPE;
    let ix = env.ix_update_asset(&a, ticker(REAL_TICKERS[i]), p);
    env.send_admin(&[ix]).unwrap();
}

struct W {
    env: Env,
    payer: Keypair,
}

/// SPYx on the Scope source, feeds initialised, the clock just after the Oct 9 close with the close stored from Scope
/// (781.52) and Pyth's push account for SPYx at `fair_usd` published 100 s ago.
fn world(fair_usd: f64) -> W {
    let mut env = Env::real(0);
    let a = env.admin.pubkey();
    to_scope(&mut env, 0);
    for t in REAL_TICKERS {
        env.send_admin(&[ix_init(&a, t, MIN_SLOTS, MAX_AGE)]).unwrap();
    }
    env.set_time(OCT9_CLOSE + 30);
    env.put_scope(SPY_CHAIN, 781.52, OCT9_CLOSE + 10);
    let k = env.admin.pubkey();
    let snap = env.ix_snapshot(&k, "SPYx", GROUP_OCT9, SCOPE_PRICES, None);
    env.send_admin(&[snap]).unwrap();
    // Sunday evening.
    env.set_time(OCT12_OPEN - 12 * 3600);
    let asset: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    let now = env.now();
    env.put_push(&Px::new(asset.feed_xstock, fair_usd, now - 100));
    let payer = env.funded();
    W { env, payer }
}

fn z_of(t: &str) -> Vec<i16> {
    json_i16(&load_json(&format!("data/onchain/{t}-WEEKEND.json"))["z"])
}

#[test]
fn c3_happy_path_kamino() {
    let mut w = world(750.0);
    let u = Upd::kamino("SPYx");
    let m = crank(&mut w.env, &w.payer, &u).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("update_gap_feed (Kamino asset, Scope lender): {} CU", m.compute_units_consumed);
    assert!(m.compute_units_consumed < 100_000);
    let f = feed(&w.env, "SPYx");
    assert_eq!(f.flags & ff::BLOCKING, 0, "flags {:#x}", f.flags);
    // The lender's price (Scope, refreshed at the close) has not moved since the close: frozen, gap 0.
    assert_ne!(f.flags & ff::LENDER_FROZEN, 0);
    assert_eq!((f.closure_id, f.closure_type, f.updates), (GROUP_OCT9, closure::WEEKEND, 1));
    assert_eq!((f.close_ts, f.next_open), (OCT9_CLOSE, OCT12_OPEN));
    assert_eq!(f.close_price_wad(), 781_520_000_000_000_000_000);
    assert_eq!(f.fair_price_wad(), 750_000_000_000_000_000_000);
    assert_eq!(f.lender_price_wad(), 781_520_000_000_000_000_000);
    // 750 / 781.52 − 1 = −4.0331…%, rounded down.
    let g = f.implied_gap_fair_wad();
    assert!((-40_340_000_000_000_000..=-40_330_000_000_000_000).contains(&g), "{g}");
    assert_eq!(f.implied_gap_lender_wad(), 0);
    assert_eq!(f.fair_verification, 1);
    assert!(f.fair_conf_bps <= 1);
}

/// Golden: the feed's P(gap < −x) equals risk-core on the same σ and set, and the app's rule (odds.ts modelPays).
#[test]
fn c3_probabilities_match_risk_core() {
    let mut w = world(780.0);
    crank(&mut w.env, &w.payer, &Upd::kamino("SPYx")).unwrap();
    let f = feed(&w.env, "SPYx");
    let a: AssetConfig = w.env.zc(&asset_pda(&ticker("SPYx")));
    let z = z_of("SPYx");
    assert_eq!((f.sigma_wad, f.n_scen as usize), (a.sigma_wad, z.len()));
    let set = credence_risk_core::SliceZ(&z);
    let want = |x: u64| credence_risk_core::gap_prob_wad(&set, a.sigma_wad, x).unwrap();
    assert_eq!(f.p_lt_5_wad, want(50_000_000_000_000_000));
    assert_eq!(f.p_lt_8_wad, want(80_000_000_000_000_000));
    assert_eq!(f.p_lt_12_wad, want(120_000_000_000_000_000));
    assert!(f.p_lt_5_wad >= f.p_lt_8_wad && f.p_lt_8_wad >= f.p_lt_12_wad && f.p_lt_5_wad > 0);
    // The app's rule, scenario by scenario (D/C′ = 1 − x; both sides divided by C′ = WAD).
    let wad = WAD as i128;
    for (x, p) in [(5i128, f.p_lt_5_wad), (8, f.p_lt_8_wad), (12, f.p_lt_12_wad)] {
        let x = x * wad / 100;
        let pays = z.iter().filter(|&&zi| (wad - x) * 1000 > (1000 * wad + a.sigma_wad as i128 * zi as i128).max(0)).count() as u128;
        assert_eq!(p as u128, (pays * wad as u128).div_ceil(z.len() as u128));
    }
}

#[test]
fn c3_fake_push_account() {
    let mut w = world(750.0);
    // A genuine-looking, fully verified price account for SPYx's feed, but not at Pyth's push address.
    let a: AssetConfig = w.env.zc(&asset_pda(&ticker("SPYx")));
    let now = w.env.now();
    let fake = w.env.put_price(&Px::new(a.feed_xstock, 100.0, now - 10));
    let mut u = Upd::kamino("SPYx");
    u.fair = Some(fake);
    assert_err(crank(&mut w.env, &w.payer, &u), code(CoreError::NotPushAccount));
    // Another asset's push account.
    let other: AssetConfig = w.env.zc(&asset_pda(&ticker("QQQx")));
    u.fair = Some(push_account(&other.feed_xstock));
    assert_err(crank(&mut w.env, &w.payer, &u), code(CoreError::NotPushAccount));
    assert_eq!(feed(&w.env, "SPYx").updates, 0);
    // At the right address but not owned by the Pyth receiver.
    let push = push_account(&a.feed_xstock);
    let mut px = Px::new(a.feed_xstock, 100.0, now - 10);
    px.owner = Some(Pubkey::new_unique());
    w.env.put_price_at(push, &px);
    let u = Upd::kamino("SPYx");
    assert!(crank(&mut w.env, &w.payer, &u).is_err());
    assert_eq!(feed(&w.env, "SPYx").updates, 0);
}

#[test]
fn c3_fake_scope() {
    let mut w = world(750.0);
    // A Scope-shaped account at another address, owned by anyone.
    let mut real = w.env.svm.get_account(&SCOPE_PRICES).unwrap();
    let fake = Pubkey::new_unique();
    w.env.svm.set_account(fake, real.clone()).unwrap();
    let mut u = Upd::kamino("SPYx");
    u.lender = Some(fake);
    assert_err(crank(&mut w.env, &w.payer, &u), code(CoreError::NotScopePrices));
    // At Scope's address but not owned by Scope.
    real.owner = Pubkey::new_unique();
    w.env.svm.set_account(SCOPE_PRICES, real).unwrap();
    assert_err(crank(&mut w.env, &w.payer, &Upd::kamino("SPYx")), code(CoreError::NotScopePrices));
    assert_eq!(feed(&w.env, "SPYx").updates, 0);
}

#[test]
fn c3_wrong_epoch() {
    let mut w = world(750.0);
    // Another asset's epoch of the same closure.
    let mut u = Upd::kamino("SPYx");
    u.epoch = Some(epoch_pda(&ticker("QQQx"), GROUP_OCT9));
    assert_err(crank(&mut w.env, &w.payer, &u), code(CoreError::NotThisEpoch));
    // Another closure's epoch address.
    u.epoch = Some(epoch_pda(&ticker("SPYx"), 20261016));
    assert_err(crank(&mut w.env, &w.payer, &u), code(CoreError::NotThisEpoch));
    // QQQx's epoch is open (no close stored): not an error, but no close and no implied gap.
    w.env.put_scope(347, 530.0, OCT9_CLOSE);
    crank(&mut w.env, &w.payer, &Upd::kamino("QQQx")).unwrap();
    let f = feed(&w.env, "QQQx");
    assert_ne!(f.flags & ff::NO_CLOSE, 0);
    assert_eq!((f.close_price_wad(), f.implied_gap_fair_wad(), f.implied_gap_lender_wad()), (0, 0, 0));
    assert_eq!(f.epoch_state, epoch_state::OPEN);
    // Its P(gap) needs only σ and the set.
    assert!(f.p_lt_5_wad > 0);
}

#[test]
fn c3_stale_inputs_flagged() {
    let mut w = world(750.0);
    let a: AssetConfig = w.env.zc(&asset_pda(&ticker("SPYx")));
    let cfg: Config = w.env.anchor(&config_pda());
    let now = w.env.now();
    let u = Upd::kamino("SPYx");
    let step = |w: &mut W, px: Px| -> GapFeed {
        w.env.put_push(&px);
        w.env.svm.warp_to_slot(w.env.slot() + MIN_SLOTS as u64 + 1);
        crank(&mut w.env, &w.payer, &u).unwrap();
        feed(&w.env, "SPYx")
    };
    // Older than shield_max_age_secs.
    let f = step(&mut w, Px::new(a.feed_xstock, 750.0, now - cfg.shield_max_age_secs as i64 - 1));
    assert_ne!(f.flags & ff::STALE_FAIR, 0);
    assert_eq!((f.fair_price_wad(), f.implied_gap_fair_wad()), (0, 0));
    // From the future.
    let f = step(&mut w, Px::new(a.feed_xstock, 750.0, now + 3_600));
    assert_ne!(f.flags & ff::STALE_FAIR, 0);
    // Partially verified.
    let mut px = Px::new(a.feed_xstock, 750.0, now - 10);
    px.full = false;
    let f = step(&mut w, px);
    assert_ne!(f.flags & ff::FAIR_UNVERIFIED, 0);
    assert_eq!(f.fair_price_wad(), 0);
    // Confidence wider than max_conf_bps.
    let mut px = Px::new(a.feed_xstock, 750.0, now - 10);
    px.conf = (px.price as u64 / 10_000) * (cfg.max_conf_bps as u64 + 50);
    let f = step(&mut w, px);
    assert_ne!(f.flags & ff::FAIR_OUTSIDE_CONF, 0);
    assert_eq!((f.fair_price_wad(), f.implied_gap_fair_wad()), (0, 0));
    assert!(f.fair_conf_bps > cfg.max_conf_bps as u32);
    // A good update clears every flag.
    let f = step(&mut w, Px::new(a.feed_xstock, 760.0, now - 10));
    assert_eq!(f.flags & ff::BLOCKING, 0);
    assert_eq!(f.fair_price_wad(), 760_000_000_000_000_000_000);
}

#[test]
fn c3_missing_inputs_flagged_not_defaulted() {
    let mut w = world(750.0);
    // No push account at all, and a Scope account that does not exist.
    w.env.svm.set_account(push_account(&w.env.zc::<AssetConfig>(&asset_pda(&ticker("SPYx"))).feed_xstock), solana_account::Account::default()).unwrap();
    w.env.svm.set_account(SCOPE_PRICES, solana_account::Account::default()).unwrap();
    crank(&mut w.env, &w.payer, &Upd::kamino("SPYx")).unwrap();
    let f = feed(&w.env, "SPYx");
    assert_eq!(f.flags & (ff::MISSING_FAIR | ff::MISSING_LENDER), ff::MISSING_FAIR | ff::MISSING_LENDER);
    assert_eq!((f.fair_price_wad(), f.lender_price_wad(), f.implied_gap_fair_wad(), f.implied_gap_lender_wad()), (0, 0, 0, 0));
    // The close and the probabilities do not depend on them.
    assert_eq!(f.close_price_wad(), 781_520_000_000_000_000_000);
    assert!(f.p_lt_8_wad > 0);
}

/// Thursday night: the overnight closure has no scenario set and no epoch in this world: both flagged, numbers 0.
#[test]
fn c3_missing_scenarios_and_epoch_flagged() {
    let mut env = Env::real(0);
    let a = env.admin.pubkey();
    env.send_admin(&[ix_init(&a, "SPYx", MIN_SLOTS, MAX_AGE)]).unwrap();
    let payer = env.funded();
    let mut u = Upd::kamino("SPYx");
    u.closure_id = 20261008;
    u.closure_type = closure::OVERNIGHT;
    crank(&mut env, &payer, &u).unwrap();
    let f = feed(&env, "SPYx");
    assert_eq!((f.closure_id, f.closure_type), (20261008, closure::OVERNIGHT));
    assert_eq!(f.flags & (ff::NO_SCENARIOS | ff::NO_CLOSE), ff::NO_SCENARIOS | ff::NO_CLOSE);
    assert_eq!((f.sigma_wad, f.p_lt_5_wad, f.p_lt_8_wad, f.p_lt_12_wad, f.n_scen), (0, 0, 0, 0, 0));
    // The weekend set is not accepted for an overnight closure.
    let mut bad = u.clone();
    bad.scenario = Some(scen_pda(&ticker("SPYx"), closure::WEEKEND));
    env.svm.warp_to_slot(env.slot() + MIN_SLOTS as u64 + 1);
    assert_err(crank(&mut env, &payer, &bad), code(CoreError::NotThisScenarioSet));
}

#[test]
fn c3_rate_limit() {
    let mut w = world(750.0);
    let u = Upd::kamino("SPYx");
    crank(&mut w.env, &w.payer, &u).unwrap();
    let s0 = feed(&w.env, "SPYx").last_update_slot;
    w.env.svm.warp_to_slot(s0 + MIN_SLOTS as u64 - 1);
    assert_err(crank(&mut w.env, &w.payer, &u), code(CoreError::FeedTooSoon));
    w.env.svm.warp_to_slot(s0 + MIN_SLOTS as u64);
    crank(&mut w.env, &w.payer, &u).unwrap();
    assert_eq!(feed(&w.env, "SPYx").updates, 2);
    // The admin can change the limit; an unauthorised caller cannot.
    let a = w.env.admin.pubkey();
    w.env.send_admin(&[ix_set(&a, "SPYx", 0, MAX_AGE)]).unwrap();
    w.env.svm.expire_blockhash();
    crank(&mut w.env, &w.payer, &u).unwrap();
    assert_err(w.env.send(&[ix_set(&w.payer.pubkey(), "SPYx", 0, MAX_AGE)], &[&w.payer]), code(CoreError::Unauthorized));
}

#[test]
fn c3_no_funds_moved() {
    let mut w = world(750.0);
    let u = Upd::kamino("SPYx");
    let i = u.ix(&w.env);
    let keys: Vec<Pubkey> = i.accounts.iter().map(|m| m.pubkey).collect();
    let tracked: Vec<Pubkey> = keys.iter().copied().chain([vault_usdc_pda(), vault_pda(), config_pda()]).collect();
    let snap = |env: &Env| -> Vec<(u64, Vec<u8>)> {
        tracked.iter().map(|k| env.svm.get_account(k).map(|a| (a.lamports, a.data)).unwrap_or_default()).collect()
    };
    let before = snap(&w.env);
    let fee_payer_before = w.env.svm.get_balance(&w.payer.pubkey()).unwrap();
    crank(&mut w.env, &w.payer, &u).unwrap();
    let after = snap(&w.env);
    for (k, (b, a)) in tracked.iter().zip(before.iter().zip(after.iter())) {
        assert_eq!(b.0, a.0, "lamports of {k} changed");
        if *k != feed_pda("SPYx") {
            assert_eq!(b.1, a.1, "data of {k} changed");
        }
    }
    // The payer only paid the transaction fee.
    assert_eq!(fee_payer_before - w.env.svm.get_balance(&w.payer.pubkey()).unwrap(), 5_000);
    assert_eq!(w.env.token_balance(&vault_usdc_pda()), 0);
}

#[test]
fn c3_paused_is_a_flag() {
    let mut w = world(750.0);
    let a = w.env.admin.pubkey();
    let p = w.env.ix_set_paused(&a, true);
    w.env.send_admin(&[p]).unwrap();
    crank(&mut w.env, &w.payer, &Upd::kamino("SPYx")).unwrap();
    assert_ne!(feed(&w.env, "SPYx").flags & ff::PAUSED, 0);
}

#[test]
fn c3_admin_and_init_failures() {
    let mut env = Env::real(0);
    let a = env.admin.pubkey();
    let stranger = env.funded();
    assert_err(env.send(&[ix_init(&stranger.pubkey(), "SPYx", 10, 3600)], &[&stranger]), code(CoreError::Unauthorized));
    assert_err(env.send_admin(&[ix_init(&a, "SPYx", 10_001, 3600)]), code(CoreError::InvalidParam));
    assert_err(env.send_admin(&[ix_init(&a, "SPYx", 10, 59)]), code(CoreError::InvalidParam));
    assert_err(env.send_admin(&[ix_init(&a, "SPYx", 10, 86_401)]), code(CoreError::InvalidParam));
    // An asset that does not exist cannot get a feed.
    assert!(env.send_admin(&[ix_init(&a, "TSLAx", 10, 3600)]).is_err());
    env.send_admin(&[ix_init(&a, "SPYx", 10, 3600)]).unwrap();
    assert_eq!(GapFeed::SIZE, 216);
    assert_eq!(env.data(&feed_pda("SPYx")).len(), GapFeed::SIZE);
    env.svm.expire_blockhash();
    assert!(env.send_admin(&[ix_init(&a, "SPYx", 10, 3600)]).is_err(), "a second init must fail");
    assert_err(env.send_admin(&[ix_set(&a, "SPYx", 10, 30)]), code(CoreError::InvalidParam));
    // The crank on a feed that was never created fails.
    let payer = env.funded();
    let mut u = Upd::kamino("QQQx");
    u.closure_id = GROUP_OCT9;
    let r: Result<_, FailedTransactionMetadata> = crank(&mut env, &payer, &u);
    assert!(r.is_err());
}

// ---------------------------------------------------------------------------------------------------------------
// Jupiter alias (SPYx.J): the lender price is Jupiter's Chainlink cache
// ---------------------------------------------------------------------------------------------------------------

const JT: &str = "SPYx.J";

struct JW {
    w: W,
    cache: Pubkey,
}

/// The alias asset with Jupiter as lender, its epoch's close stored from the cache at 700 USD, the feed initialised,
/// SPYx's push account at `fair_usd`, the clock on Sunday evening.
fn jupiter_world(fair_usd: f64) -> JW {
    let mut env = Env::real(0);
    let a = env.admin.pubkey();
    let snap = env.load_jupiter();
    let (cache, vault_config, oracle) = (jl::key(&snap["cache"]), jl::key(&snap["vaultConfig"]), jl::key(&snap["oracle"]));
    let mut p = real_asset_params(0);
    p.settle_source = oracle::source::JUPITER;
    p.kamino_reserves = [Pubkey::default(); 2];
    let add = env.ix_add_asset(&a, ticker(JT), SPYX_MINT, p);
    env.send_admin(&[add]).unwrap();
    let set = Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SetAssetLender { ticker: ticker(JT) }.data(),
        acc::SetAssetLender { admin: a, config: config_pda(), asset: asset_pda(&ticker(JT)), lender_vault: vault_config, lender_oracle_config: oracle }
            .to_account_metas(None),
    );
    env.send_admin(&[set]).unwrap();
    env.upload_scenarios(JT, &z_of("SPYx"), 400).unwrap();
    env.compute_gap_factors(JT, 2, 128).unwrap();
    let open = env.ix_open_epoch(&a, ticker(JT), GROUP_OCT9);
    env.send_admin(&[open]).unwrap();
    env.send_admin(&[ix_init(&a, JT, MIN_SLOTS, MAX_AGE)]).unwrap();
    env.set_time(OCT9_CLOSE + 30);
    let px = 700u128 * 10u128.pow(18);
    env.put_jl_cache(&cache, px, OCT9_CLOSE - 20);
    let snapshot = Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SnapshotClose { ticker: ticker(JT), closure_id: GROUP_OCT9 }.data(),
        acc::SnapshotClose { caller: a, config: config_pda(), asset: asset_pda(&ticker(JT)), epoch: epoch_pda(&ticker(JT), GROUP_OCT9), mint: SPYX_MINT, price: cache, xcheck: None }
            .to_account_metas(None),
    );
    env.send_admin(&[snapshot]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    env.set_time(OCT12_OPEN - 12 * 3600);
    let asset: AssetConfig = env.zc(&asset_pda(&ticker(JT)));
    let now = env.now();
    env.put_push(&Px::new(asset.feed_xstock, fair_usd, now - 100));
    let payer = env.funded();
    JW { w: W { env, payer }, cache }
}

fn jupiter_upd() -> Upd {
    Upd { t: JT, closure_id: GROUP_OCT9, closure_type: closure::WEEKEND, scenario: None, epoch: None, fair: None, lender: None }
}

#[test]
fn c3_happy_path_jupiter() {
    let mut j = jupiter_world(665.0);
    let m = crank(&mut j.w.env, &j.w.payer, &jupiter_upd()).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("update_gap_feed (Jupiter alias): {} CU", m.compute_units_consumed);
    assert!(m.compute_units_consumed < 100_000);
    let f = feed(&j.w.env, JT);
    assert_eq!(f.flags & ff::BLOCKING, 0, "flags {:#x}", f.flags);
    assert_eq!(f.lender, lender::JUPITER);
    assert_ne!(f.flags & ff::LENDER_FROZEN, 0);
    assert_eq!(f.close_price_wad(), 700 * 10u128.pow(18));
    assert_eq!(f.lender_price_wad(), 700 * 10u128.pow(18));
    assert_eq!(f.lender_ts, OCT9_CLOSE - 20);
    assert_eq!(f.implied_gap_lender_wad(), 0);
    // 665 / 700 − 1 = −5%.
    assert_eq!(f.implied_gap_fair_wad(), -50_000_000_000_000_000);
    // The alias carries SPYx's set: the same probabilities.
    let a: AssetConfig = j.w.env.zc(&asset_pda(&ticker(JT)));
    let z = z_of("SPYx");
    let want = credence_risk_core::gap_prob_wad(&credence_risk_core::SliceZ(&z), a.sigma_wad, 80_000_000_000_000_000).unwrap();
    assert_eq!(f.p_lt_8_wad, want);
}

#[test]
fn c3_fake_jupiter_oracle() {
    let mut j = jupiter_world(665.0);
    // A copy of the real cache at another address.
    let real = j.w.env.svm.get_account(&j.cache).unwrap();
    let fake = Pubkey::new_unique();
    j.w.env.svm.set_account(fake, real).unwrap();
    let mut u = jupiter_upd();
    u.lender = Some(fake);
    assert_err(crank(&mut j.w.env, &j.w.payer, &u), code(CoreError::NotLenderOracle));
    // Scope's account for an alias.
    u.lender = Some(SCOPE_PRICES);
    j.w.env.put_scope(SPY_CHAIN, 781.52, OCT9_CLOSE);
    assert_err(crank(&mut j.w.env, &j.w.payer, &u), code(CoreError::NotLenderOracle));
    // And a Jupiter cache for a Kamino asset.
    let mut k = Upd::kamino("SPYx");
    k.lender = Some(j.cache);
    assert!(crank(&mut j.w.env, &j.w.payer, &k).is_err());
    // The right address, owned by someone else.
    let mut real = j.w.env.svm.get_account(&j.cache).unwrap();
    real.owner = Pubkey::new_unique();
    j.w.env.svm.set_account(j.cache, real).unwrap();
    assert!(crank(&mut j.w.env, &j.w.payer, &jupiter_upd()).is_err());
    assert_eq!(feed(&j.w.env, JT).updates, 0);
}
