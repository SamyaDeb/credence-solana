//! D2.1 gap tokens (research prototype, not offered): the attack tests, the happy path, a failure test per instruction and
//! the solvency walk. Each attack is a named test (`d2_*`). World: `Env::real`, the Oct 9 weekend, SPYx/QQQx/NVDAx epochs.

mod common;

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        system_program,
    },
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use common::*;
use credence_core::{accounts as acc, instruction as ix, state::*, state_gap::*, CoreError};
use credence_risk_core::gap_token;
use solana_keypair::Keypair;
use solana_signer::Signer;

const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;
const BELL: i64 = OCT9_CLOSE - 900;
const USDC: u64 = 1_000_000;

// -------------------------------------------------------------------------------------------------------------------
// Accounts and instruction builders
// -------------------------------------------------------------------------------------------------------------------

fn series_pda(t: &Ticker, cid: u32) -> Pubkey {
    pda(&[SEED_GSERIES, t, &cid.to_le_bytes()])
}
fn down_pda(series: &Pubkey) -> Pubkey {
    pda(&[SEED_GDOWN, series.as_ref()])
}
fn up_pda(series: &Pubkey) -> Pubkey {
    pda(&[SEED_GUP, series.as_ref()])
}
fn coll_pda(series: &Pubkey) -> Pubkey {
    pda(&[SEED_GCOLL, series.as_ref()])
}

struct S {
    t: Ticker,
    series: Pubkey,
    down: Pubkey,
    up: Pubkey,
    coll: Pubkey,
}
impl S {
    fn new(t: &str) -> S {
        let t = ticker(t);
        let series = series_pda(&t, GROUP_OCT9);
        S { t, series, down: down_pda(&series), up: up_pda(&series), coll: coll_pda(&series) }
    }
}

struct U {
    kp: Keypair,
    usdc: Pubkey,
    down: Pubkey,
    up: Pubkey,
}

fn init_ix(env: &Env, payer: &Pubkey, t: &str) -> Instruction {
    let s = S::new(t);
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::InitGapSeries { ticker: s.t, closure_id: GROUP_OCT9 }.data(),
        acc::InitGapSeries {
            payer: *payer,
            config: config_pda(),
            asset: asset_pda(&s.t),
            scenarios: scen_pda(&s.t, env.anchor::<Epoch>(&epoch_pda(&s.t, GROUP_OCT9)).closure_type),
            epoch: epoch_pda(&s.t, GROUP_OCT9),
            earnings: earnings_pda(&s.t),
            series: s.series,
            down_mint: s.down,
            up_mint: s.up,
            collateral: s.coll,
            usdc_mint: USDC_MINT,
            token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn init(env: &mut Env, t: &str) -> S {
    let payer = env.funded();
    let i = init_ix(env, &payer.pubkey(), t);
    env.send(&[i], &[&payer]).unwrap_or_else(|e| panic!("init {t}: {:?}\n{:#?}", e.err, e.meta.logs));
    S::new(t)
}

fn put_t22(env: &mut Env, key: Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) {
    let data = token_account_data(mint, owner, amount);
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm
        .set_account(key, solana_account::Account { lamports, data, owner: TOKEN_2022_PROGRAM, executable: false, rent_epoch: 0 })
        .unwrap();
}

/// A user with `usdc` USDC and empty DOWN/UP accounts of series `s`.
fn user(env: &mut Env, s: &S, usdc: u64) -> U {
    let kp = env.funded();
    let u = env.usdc_account(&kp.pubkey(), usdc);
    let (d, up) = (Pubkey::new_unique(), Pubkey::new_unique());
    put_t22(env, d, &s.down, &kp.pubkey(), 0);
    put_t22(env, up, &s.up, &kp.pubkey(), 0);
    U { kp, usdc: u, down: d, up }
}

fn mint_ix(s: &S, u: &U, amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::MintGapSet { amount }.data(),
        acc::MintGapSet {
            user: u.kp.pubkey(),
            config: config_pda(),
            series: s.series,
            down_mint: s.down,
            up_mint: s.up,
            collateral: s.coll,
            user_usdc: u.usdc,
            user_down: u.down,
            user_up: u.up,
            token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
        }
        .to_account_metas(None),
    )
}

fn merge_ix(s: &S, u: &U, amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::MergeGapSet { amount }.data(),
        acc::MergeGapSet {
            user: u.kp.pubkey(),
            series: s.series,
            down_mint: s.down,
            up_mint: s.up,
            collateral: s.coll,
            user_usdc: u.usdc,
            user_down: u.down,
            user_up: u.up,
            token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
        }
        .to_account_metas(None),
    )
}

fn settle_accounts(s: &S, caller: &Pubkey) -> Vec<AccountMeta> {
    acc::SettleGapSeries {
        caller: *caller,
        series: s.series,
        epoch: epoch_pda(&s.t, GROUP_OCT9),
        down_mint: s.down,
        up_mint: s.up,
        token_2022_program: TOKEN_2022_PROGRAM,
    }
    .to_account_metas(None)
}

fn settle_ix(s: &S, caller: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(credence_core::ID, &ix::SettleGapSeries {}.data(), settle_accounts(s, caller))
}

fn expire_ix(s: &S, caller: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(credence_core::ID, &ix::ExpireGapSeries {}.data(), settle_accounts(s, caller))
}

fn redeem_ix(s: &S, u: &U, side: u8, amount: u64) -> Instruction {
    let (mint, gap) = if side == gap_side::DOWN { (s.down, u.down) } else { (s.up, u.up) };
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::RedeemGap { side, amount }.data(),
        acc::RedeemGap {
            user: u.kp.pubkey(),
            series: s.series,
            gap_mint: mint,
            collateral: s.coll,
            user_usdc: u.usdc,
            user_gap: gap,
            token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
        }
        .to_account_metas(None),
    )
}

/// Plain Token-2022 transfer (the tokens move by transfer, nothing else).
fn transfer_ix(from: &Pubkey, to: &Pubkey, owner: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(
        TOKEN_2022_PROGRAM,
        &data,
        vec![AccountMeta::new(*from, false), AccountMeta::new(*to, false), AccountMeta::new_readonly(*owner, true)],
    )
}

/// The same instruction signed by `who` instead of `from` (the token accounts stay `from`'s).
fn as_signer(mut i: Instruction, from: &Pubkey, who: &Pubkey) -> Instruction {
    for m in i.accounts.iter_mut() {
        if m.pubkey == *from {
            m.pubkey = *who;
        }
    }
    i
}

fn series(env: &Env, s: &S) -> GapSeries {
    env.anchor(&s.series)
}

fn edit_epoch(env: &mut Env, t: &str, f: impl FnOnce(&mut Epoch)) {
    let key = epoch_pda(&ticker(t), GROUP_OCT9);
    let mut a = env.svm.get_account(&key).unwrap();
    let mut e = Epoch::try_deserialize(&mut a.data.as_slice()).unwrap();
    f(&mut e);
    let mut data = Vec::with_capacity(a.data.len());
    e.try_serialize(&mut data).unwrap();
    data.resize(a.data.len(), 0);
    a.data = data;
    env.svm.set_account(key, a).unwrap();
}

/// The epoch as the keeper leaves it after `post_settlement`: stored close and settlement price.
fn settle_epoch(env: &mut Env, t: &str, close: f64, settle: f64) {
    edit_epoch(env, t, |e| {
        e.state = epoch_state::SETTLED;
        e.close_price_wad = (close * 1e18) as u128;
        e.settle_price_wad = (settle * 1e18) as u128;
        e.close_source = 1;
    });
}

fn next(env: &mut Env) {
    env.svm.warp_to_slot(env.slot() + 1);
}

fn send1(env: &mut Env, i: Instruction, who: &Keypair) -> TxResult {
    next(env);
    env.send(&[i], &[who])
}

fn ok(env: &mut Env, i: Instruction, who: &Keypair) {
    send1(env, i, who).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
}

fn world() -> Env {
    Env::real(0)
}

/// Mints `sets` complete sets for a fresh user.
fn minted(env: &mut Env, s: &S, sets: u64) -> U {
    let u = user(env, s, sets);
    let i = mint_ix(s, &u, sets);
    ok(env, i, &u.kp);
    u
}

// -------------------------------------------------------------------------------------------------------------------
// Happy path
// -------------------------------------------------------------------------------------------------------------------

#[test]
fn series_mint_merge_settle_redeem() {
    let mut env = world();
    let s = init(&mut env, "SPYx");
    let g = series(&env, &s);
    assert_eq!((g.state, g.ticker, g.closure_id), (gap_state::OPEN, s.t, GROUP_OCT9));
    assert_eq!((g.down_mint, g.up_mint, g.collateral), (s.down, s.up, s.coll));
    // k comes from the closure's σ: 2.5 σ rounded up to 0.5%, inside [2%, 30%].
    assert!((gap_token::BAND_MIN_WAD..=gap_token::BAND_MAX_WAD).contains(&g.k_wad));
    assert_eq!(g.bell, BELL);

    let a = user(&mut env, &s, 1_000 * USDC);
    let i = mint_ix(&s, &a, 1_000 * USDC);
    ok(&mut env, i, &a.kp);
    assert_eq!(env.token_balance(&a.usdc), 0);
    assert_eq!((env.token_balance(&a.down), env.token_balance(&a.up)), (1_000 * USDC, 1_000 * USDC));
    assert_eq!(env.token_balance(&s.coll), 1_000 * USDC);
    assert_eq!(series(&env, &s).sets_outstanding, 1_000 * USDC);

    // Merge back 100 sets at par, any time before the rate is fixed.
    let i = merge_ix(&s, &a, 100 * USDC);
    ok(&mut env, i, &a.kp);
    assert_eq!(env.token_balance(&a.usdc), 100 * USDC);
    assert_eq!(env.token_balance(&s.coll), 900 * USDC);
    assert_eq!((env.mint_supply(&s.down), env.mint_supply(&s.up)), (900 * USDC, 900 * USDC));

    // A sends 500 DOWN to B (plain transfer), the closure settles −8% and everyone redeems.
    let b = user(&mut env, &s, 0);
    let t = transfer_ix(&a.down, &b.down, &a.kp.pubkey(), 500 * USDC);
    ok(&mut env, t, &a.kp);
    settle_epoch(&mut env, "SPYx", 100.0, 92.0);
    let anyone = env.funded();
    let i = settle_ix(&s, &anyone.pubkey());
    ok(&mut env, i, &anyone);
    let g = series(&env, &s);
    let r = credence_core::settlement::gap_wad(g.close_price_wad, g.settle_price_wad).unwrap();
    assert_eq!(g.state, gap_state::SETTLED);
    assert_eq!((g.down_micro, g.up_micro), gap_token::split(r, g.k_wad).unwrap());
    assert_eq!(g.down_micro + g.up_micro, 1_000_000);
    assert!(g.down_micro > 500_000, "−8% pays DOWN more than half");
    assert_eq!(g.pool_down + g.pool_up, g.sets_settled);

    let mut paid = 0;
    for (u, side, amt) in [(&b, gap_side::DOWN, 500 * USDC), (&a, gap_side::DOWN, 400 * USDC), (&a, gap_side::UP, 900 * USDC)] {
        let before = env.token_balance(&u.usdc);
        let i = redeem_ix(&s, u, side, amt);
        ok(&mut env, i, &u.kp);
        paid += env.token_balance(&u.usdc) - before;
    }
    // The sum of payouts is the collateral, to the base unit (INV-21), and the series is empty.
    assert_eq!(paid, 900 * USDC);
    assert_eq!(env.token_balance(&s.coll), 0);
    assert_eq!((env.mint_supply(&s.down), env.mint_supply(&s.up)), (0, 0));
}

// -------------------------------------------------------------------------------------------------------------------
// D2.1 attacks
// -------------------------------------------------------------------------------------------------------------------

/// INV-22: no mint without the matching USDC, in the same instruction.
#[test]
fn d2_mint_requires_usdc() {
    let mut env = world();
    let s = init(&mut env, "SPYx");
    // No USDC at all.
    let u = user(&mut env, &s, 0);
    let i = mint_ix(&s, &u, 1);
    assert_fails(send1(&mut env, i, &u.kp));
    // Partial deposit: 10 USDC cannot mint 11 sets.
    let u = user(&mut env, &s, 10 * USDC);
    let i = mint_ix(&s, &u, 11 * USDC);
    assert_fails(send1(&mut env, i, &u.kp));
    // The wrong mint: a token account of another mint (the UP mint) in the USDC slot.
    let mut bad = user(&mut env, &s, 0);
    let fake = Pubkey::new_unique();
    put_t22(&mut env, fake, &s.up, &bad.kp.pubkey(), 50 * USDC);
    bad.usdc = fake;
    let i = mint_ix(&s, &bad, 50 * USDC);
    assert_fails(send1(&mut env, i, &bad.kp));
    // Someone else's USDC account: the signer must own it.
    let victim = env.funded();
    let theirs = env.usdc_account(&victim.pubkey(), 100 * USDC);
    let mut thief = user(&mut env, &s, 0);
    thief.usdc = theirs;
    let i = mint_ix(&s, &thief, 100 * USDC);
    assert_fails(send1(&mut env, i, &thief.kp));
    // Zero amount.
    let u = user(&mut env, &s, USDC);
    let i = mint_ix(&s, &u, 0);
    assert_err(send1(&mut env, i, &u.kp), code(CoreError::InvalidParam));
    // Nothing moved, nothing minted.
    assert_eq!(env.token_balance(&s.coll), 0);
    assert_eq!((env.mint_supply(&s.down), env.mint_supply(&s.up)), (0, 0));
    assert_eq!(series(&env, &s).sets_outstanding, 0);
    // A full deposit mints exactly the amount of each side.
    let u = user(&mut env, &s, 7 * USDC);
    let i = mint_ix(&s, &u, 7 * USDC);
    ok(&mut env, i, &u.kp);
    assert_eq!((env.mint_supply(&s.down), env.mint_supply(&s.up), env.token_balance(&s.coll)), (7 * USDC, 7 * USDC, 7 * USDC));
}

#[test]
fn d2_merge_complete_set_only() {
    let mut env = world();
    let s = init(&mut env, "SPYx");
    let other = init(&mut env, "QQQx");
    let whale = minted(&mut env, &s, 1_000 * USDC);
    let _ = minted(&mut env, &other, 1_000 * USDC);

    // A DOWN without its UP: the UP burn fails, nothing is paid.
    let half = user(&mut env, &s, 0);
    let t = transfer_ix(&whale.down, &half.down, &whale.kp.pubkey(), 100 * USDC);
    ok(&mut env, t, &whale.kp);
    let i = merge_ix(&s, &half, 100 * USDC);
    assert_fails(send1(&mut env, i, &half.kp));
    assert_eq!(env.token_balance(&half.usdc), 0);

    // A set short by one unit.
    let nearly = user(&mut env, &s, 0);
    let t1 = transfer_ix(&whale.down, &nearly.down, &whale.kp.pubkey(), 10 * USDC);
    let t2 = transfer_ix(&whale.up, &nearly.up, &whale.kp.pubkey(), 10 * USDC - 1);
    ok(&mut env, t1, &whale.kp);
    ok(&mut env, t2, &whale.kp);
    let i = merge_ix(&s, &nearly, 10 * USDC);
    assert_fails(send1(&mut env, i, &nearly.kp));

    // One side from another series: the UP slot holds QQQx's UP token account.
    let mut mixed = user(&mut env, &s, 0);
    let t = transfer_ix(&whale.down, &mixed.down, &whale.kp.pubkey(), 5 * USDC);
    ok(&mut env, t, &whale.kp);
    let foreign = Pubkey::new_unique();
    put_t22(&mut env, foreign, &other.up, &mixed.kp.pubkey(), 5 * USDC);
    mixed.up = foreign;
    let i = merge_ix(&s, &mixed, 5 * USDC);
    assert_fails(send1(&mut env, i, &mixed.kp));
    assert_eq!(env.token_balance(&s.coll), 1_000 * USDC);

    // A whole set merges.
    let have = env.token_balance(&whale.down).min(env.token_balance(&whale.up));
    let i = merge_ix(&s, &whale, have);
    ok(&mut env, i, &whale.kp);
    assert_eq!(env.token_balance(&whale.usdc), have);
}

#[test]
fn d2_no_redeem_before_settle() {
    let mut env = world();
    let s = init(&mut env, "SPYx");
    let a = minted(&mut env, &s, 100 * USDC);
    for side in [gap_side::DOWN, gap_side::UP] {
        let i = redeem_ix(&s, &a, side, 10 * USDC);
        assert_err(send1(&mut env, i, &a.kp), code(CoreError::GapSeriesState));
    }
    // Even once the epoch has settled, the series must be settled first.
    settle_epoch(&mut env, "SPYx", 100.0, 100.0);
    let i = redeem_ix(&s, &a, gap_side::DOWN, 10 * USDC);
    assert_err(send1(&mut env, i, &a.kp), code(CoreError::GapSeriesState));
    assert_eq!(env.token_balance(&s.coll), 100 * USDC);
}

#[test]
fn d2_double_redeem() {
    let mut env = world();
    let s = init(&mut env, "SPYx");
    let a = minted(&mut env, &s, 100 * USDC);
    settle_epoch(&mut env, "SPYx", 100.0, 100.0);
    let anyone = env.funded();
    let i = settle_ix(&s, &anyone.pubkey());
    ok(&mut env, i, &anyone);
    let i = redeem_ix(&s, &a, gap_side::DOWN, 100 * USDC);
    ok(&mut env, i, &a.kp);
    let got = env.token_balance(&a.usdc);
    assert_eq!(got, 50 * USDC, "flat price pays half");
    // The burn is the guard: the same tokens cannot redeem twice.
    let i = redeem_ix(&s, &a, gap_side::DOWN, 100 * USDC);
    assert_fails(send1(&mut env, i, &a.kp));
    let i = redeem_ix(&s, &a, gap_side::DOWN, 1);
    assert_fails(send1(&mut env, i, &a.kp));
    // Tokens sent on after redeeming a part cannot be redeemed beyond the balance either.
    assert_eq!(env.token_balance(&a.usdc), got);
    assert_eq!(series(&env, &s).redeemed_down, 100 * USDC);
}

#[test]
fn d2_wrong_series() {
    let mut env = world();
    let a = init(&mut env, "SPYx");
    let b = init(&mut env, "QQQx");
    let ua = minted(&mut env, &a, 100 * USDC);
    let ub = minted(&mut env, &b, 100 * USDC);
    // Series A's tokens against series B's accounts.
    let cross = U { kp: ua.kp.insecure_clone(), usdc: ua.usdc, down: ua.down, up: ua.up };
    let i = merge_ix(&b, &cross, 10 * USDC);
    assert_fails(send1(&mut env, i, &cross.kp));
    // B's collateral account in A's instruction.
    let mut i = merge_ix(&a, &ua, 10 * USDC);
    for m in i.accounts.iter_mut() {
        if m.pubkey == a.coll {
            m.pubkey = b.coll;
        }
    }
    assert_fails(send1(&mut env, i, &ua.kp));
    // Settle and redeem with the wrong side's / series' mint.
    settle_epoch(&mut env, "SPYx", 100.0, 100.0);
    settle_epoch(&mut env, "QQQx", 100.0, 100.0);
    let anyone = env.funded();
    let i = settle_ix(&a, &anyone.pubkey());
    ok(&mut env, i, &anyone);
    let i = settle_ix(&b, &anyone.pubkey());
    ok(&mut env, i, &anyone);
    // A's DOWN account claims side UP: the mint of the account is not the side's mint.
    let i = redeem_ix(&a, &ua, gap_side::DOWN, 10 * USDC);
    let mut wrong_side = i.clone();
    wrong_side.data = ix::RedeemGap { side: gap_side::UP, amount: 10 * USDC }.data();
    assert_err(send1(&mut env, wrong_side, &ua.kp), code(CoreError::WrongGapAccount));
    // B's mint with A's series.
    let mut bad = redeem_ix(&a, &ua, gap_side::DOWN, 10 * USDC);
    for m in bad.accounts.iter_mut() {
        if m.pubkey == a.down {
            m.pubkey = b.down;
        }
    }
    assert_fails(send1(&mut env, bad, &ua.kp));
    // B's tokens redeem only B's collateral.
    let before = env.token_balance(&b.coll);
    let i = redeem_ix(&b, &ub, gap_side::DOWN, 100 * USDC);
    ok(&mut env, i, &ub.kp);
    assert_eq!(before - env.token_balance(&b.coll), 50 * USDC);
    assert_eq!(env.token_balance(&a.coll), 100 * USDC);
}

/// Settles on the epoch's own stored prices and source: a real `snapshot_close` and `post_settlement` (QQQx on its xStock
/// feed), then the series reads them. Nothing about the price is an argument.
#[test]
fn d2_settles_on_epoch_price() {
    let mut env = world();
    let admin = env.admin.pubkey();
    let mut ap = real_asset_params(1);
    ap.settle_source = credence_core::oracle::source::XSTOCK;
    let ix_u = env.ix_update_asset(&admin, ticker("QQQx"), ap);
    env.send_admin(&[ix_u]).unwrap();
    let qqq = init(&mut env, "QQQx");
    let spy = init(&mut env, "SPYx");
    let a = minted(&mut env, &qqq, 1_000 * USDC);

    // Not before the epoch has settled (open, then closed).
    let anyone = env.funded();
    let i = settle_ix(&qqq, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::WrongEpochState));
    let qa: AssetConfig = env.zc(&asset_pda(&ticker("QQQx")));
    env.set_time(OCT9_CLOSE + 30);
    let c = env.put_push(&Px::new(qa.feed_xstock, 600.0, OCT9_CLOSE - 1));
    let snap = env.ix_snapshot(&admin, "QQQx", GROUP_OCT9, c, None);
    env.send_admin(&[snap]).unwrap();
    let i = settle_ix(&qqq, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::WrongEpochState));

    // Monday −10% on the same source.
    let o = env.put_push(&Px::new(qa.feed_xstock, 540.0, OCT12_OPEN + 30));
    env.set_time(OCT12_OPEN + 301);
    let post = env.ix_post(&admin, "QQQx", GROUP_OCT9, &[o], None);
    env.send_admin(&[post]).unwrap();
    let e: Epoch = env.anchor(&epoch_pda(&qqq.t, GROUP_OCT9));
    assert_eq!(e.state, epoch_state::SETTLED);

    // Another series' epoch cannot stand in: SPYx's epoch is still open.
    let mut wrong = settle_ix(&qqq, &anyone.pubkey());
    for m in wrong.accounts.iter_mut() {
        if m.pubkey == epoch_pda(&qqq.t, GROUP_OCT9) {
            m.pubkey = epoch_pda(&spy.t, GROUP_OCT9);
        }
    }
    assert_fails(send1(&mut env, wrong, &anyone));

    let i = settle_ix(&qqq, &anyone.pubkey());
    ok(&mut env, i, &anyone);
    let g = series(&env, &qqq);
    assert_eq!((g.close_price_wad, g.settle_price_wad, g.close_source), (e.close_price_wad, e.settle_price_wad, e.close_source));
    let r = credence_core::settlement::gap_wad(e.close_price_wad, e.settle_price_wad).unwrap();
    assert!(r < -90_000_000_000_000_000 && r > -110_000_000_000_000_000, "−10% on the stored prices: {r}");
    assert_eq!((g.down_micro, g.up_micro), gap_token::split(r, g.k_wad).unwrap());
    // Settled once; the rate is final.
    let i = settle_ix(&qqq, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::GapSeriesState));
    // −10% against a band under 10% pays all to DOWN; inside the band the sum is still the collateral.
    let i = redeem_ix(&qqq, &a, gap_side::DOWN, 1_000 * USDC);
    ok(&mut env, i, &a.kp);
    let i = redeem_ix(&qqq, &a, gap_side::UP, 1_000 * USDC);
    ok(&mut env, i, &a.kp);
    assert_eq!(env.token_balance(&a.usdc), 1_000 * USDC);
    assert_eq!(env.token_balance(&qqq.coll), 0);
}

#[test]
fn d2_void_and_halt() {
    let mut env = world();
    let anyone = env.funded();
    let spy = init(&mut env, "SPYx");
    let qqq = init(&mut env, "QQQx");
    let nvda = init(&mut env, "NVDAx");
    let a = minted(&mut env, &spy, 1_000 * USDC);
    let b = minted(&mut env, &qqq, 1_000 * USDC);
    let c = minted(&mut env, &nvda, 1_000 * USDC);
    let e: Epoch = env.anchor(&epoch_pda(&spy.t, GROUP_OCT9));

    // HALTED waits: no rate, no redeem, the window moves.
    edit_epoch(&mut env, "SPYx", |e| e.state = epoch_state::HALTED);
    let i = settle_ix(&spy, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::WrongEpochState));
    let i = redeem_ix(&spy, &a, gap_side::DOWN, 1);
    assert_err(send1(&mut env, i, &a.kp), code(CoreError::GapSeriesState));
    // ...and the window then settles it normally.
    settle_epoch(&mut env, "SPYx", 100.0, 100.0);
    let i = settle_ix(&spy, &anyone.pubkey());
    ok(&mut env, i, &anyone);
    assert_eq!(series(&env, &spy).down_micro, 500_000);

    // VOIDED (no close ever stored): 0.5 each, a set returns 1.
    env.set_time(OCT9_CLOSE + credence_core::VOID_AFTER);
    let v = env.ix_void_epoch(&anyone.pubkey(), qqq.t, GROUP_OCT9);
    env.send(&[v], &[&anyone]).unwrap();
    let i = settle_ix(&qqq, &anyone.pubkey());
    ok(&mut env, i, &anyone);
    let g = series(&env, &qqq);
    assert_eq!((g.down_micro, g.up_micro, g.close_price_wad, g.settle_price_wad), (500_000, 500_000, 0, 0));
    let before = env.token_balance(&b.usdc);
    for side in [gap_side::DOWN, gap_side::UP] {
        let i = redeem_ix(&qqq, &b, side, 1_000 * USDC);
        ok(&mut env, i, &b.kp);
    }
    assert_eq!(env.token_balance(&b.usdc) - before, 1_000 * USDC);

    // Expiry: only once the epoch should have settled and still has not.
    let i = expire_ix(&nvda, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::TooEarly));
    env.set_time(e.settle_after + GAP_EXPIRY_SECS - 1);
    let i = expire_ix(&nvda, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::TooEarly));
    // A settled epoch cannot be expired, even late.
    let i = expire_ix(&spy, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::GapSeriesState));
    env.set_time(e.settle_after + GAP_EXPIRY_SECS);
    edit_epoch(&mut env, "NVDAx", |e| e.state = epoch_state::HALTED);
    let i = expire_ix(&nvda, &anyone.pubkey());
    ok(&mut env, i, &anyone);
    let g = series(&env, &nvda);
    assert_eq!((g.state, g.down_micro, g.up_micro), (gap_state::EXPIRED, 500_000, 500_000));
    // Once expired the epoch can no longer fix a second rate; both paths are closed.
    settle_epoch(&mut env, "NVDAx", 100.0, 80.0);
    let i = settle_ix(&nvda, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::GapSeriesState));
    let i = expire_ix(&nvda, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::GapSeriesState));
    let before = env.token_balance(&c.usdc);
    let i = redeem_ix(&nvda, &c, gap_side::DOWN, 1_000 * USDC);
    ok(&mut env, i, &c.kp);
    let i = redeem_ix(&nvda, &c, gap_side::UP, 1_000 * USDC);
    ok(&mut env, i, &c.kp);
    assert_eq!(env.token_balance(&c.usdc) - before, 1_000 * USDC);
}

#[test]
fn d2_authorities() {
    let mut env = world();
    let s = init(&mut env, "SPYx");
    let a = minted(&mut env, &s, 100 * USDC);
    let attacker = env.funded();
    for mint in [s.down, s.up] {
        let d = env.data(&mint);
        // Mint authority is the series PDA; no freeze authority; 6 decimals.
        assert_eq!(&d[0..4], &[1, 0, 0, 0]);
        assert_eq!(&d[4..36], s.series.as_ref());
        assert_eq!(d[44], 6);
        assert_eq!(&d[46..50], &[0, 0, 0, 0], "no freeze authority");
        // Exactly MintCloseAuthority (3), MetadataPointer (18) and TokenMetadata (19).
        let t = |ty| credence_core::token22::extension(&d, ty).unwrap();
        assert_eq!(t(3).unwrap(), s.series.as_ref(), "close authority is the series");
        let ptr = t(18).unwrap();
        assert_eq!((&ptr[..32], &ptr[32..64]), (&[0u8; 32][..], mint.as_ref()), "pointer: no authority, points at the mint");
        let meta = t(19).unwrap();
        assert_eq!(&meta[..32], &[0u8; 32], "metadata update authority is None");
        assert_eq!(&meta[32..64], mint.as_ref());
        let text = String::from_utf8_lossy(&meta[64..]).to_string();
        assert!(text.contains("research prototype, not offered") && text.contains("SPYx"), "{text}");
        for banned in [12u16, 14, 1, 21, 26, 6, 8] {
            // permanent delegate, transfer hook, transfer fee config, pausable, default state, non-transferable, ...
            assert!(t(banned).is_none(), "extension {banned} must be absent");
        }
        // Nothing else: after the three known entries the TLV area has no further type.
        let mut o = 166;
        let mut seen = vec![];
        while o + 4 <= d.len() {
            let ty = u16::from_le_bytes([d[o], d[o + 1]]);
            let len = u16::from_le_bytes([d[o + 2], d[o + 3]]) as usize;
            if ty == 0 {
                break;
            }
            seen.push(ty);
            o += 4 + len;
        }
        seen.sort();
        assert_eq!(seen, vec![3, 18, 19]);
    }
    // Nobody but the series mints: a plain MintTo by the attacker, by the user, or by the admin fails.
    let mint_to = |env: &mut Env, who: &Keypair, mint: &Pubkey, to: &Pubkey| {
        let mut data = vec![7u8];
        data.extend_from_slice(&1_000u64.to_le_bytes());
        let i = Instruction::new_with_bytes(
            TOKEN_2022_PROGRAM,
            &data,
            vec![AccountMeta::new(*mint, false), AccountMeta::new(*to, false), AccountMeta::new_readonly(who.pubkey(), true)],
        );
        assert_fails(send1(env, i, who));
    };
    mint_to(&mut env, &attacker, &s.down, &a.down);
    mint_to(&mut env, &a.kp, &s.up, &a.up);
    let admin = env.admin.insecure_clone();
    mint_to(&mut env, &admin, &s.down, &a.down);
    // Nobody can set an authority or freeze: SetAuthority(MintTokens) / FreezeAccount by the attacker.
    let set_auth = Instruction::new_with_bytes(
        TOKEN_2022_PROGRAM,
        &[6u8, 0, 1].iter().copied().chain(attacker.pubkey().to_bytes()).collect::<Vec<u8>>(),
        vec![AccountMeta::new(s.down, false), AccountMeta::new_readonly(attacker.pubkey(), true)],
    );
    assert_fails(send1(&mut env, set_auth, &attacker));
    let freeze = Instruction::new_with_bytes(
        TOKEN_2022_PROGRAM,
        &[10u8],
        vec![AccountMeta::new(a.down, false), AccountMeta::new_readonly(s.down, false), AccountMeta::new_readonly(attacker.pubkey(), true)],
    );
    assert_fails(send1(&mut env, freeze, &attacker));
    // The tokens move freely: a plain transfer between wallets works.
    let b = user(&mut env, &s, 0);
    let t = transfer_ix(&a.down, &b.down, &a.kp.pubkey(), 40 * USDC);
    ok(&mut env, t, &a.kp);
    assert_eq!(env.token_balance(&b.down), 40 * USDC);
    // Once the rate is fixed the mint authority is revoked: no instruction can mint at all.
    settle_epoch(&mut env, "SPYx", 100.0, 100.0);
    let i = settle_ix(&s, &attacker.pubkey());
    ok(&mut env, i, &attacker);
    for mint in [s.down, s.up] {
        assert_eq!(&env.data(&mint)[0..4], &[0, 0, 0, 0], "mint authority None after settle");
    }
    let i = mint_ix(&s, &a, 1);
    assert_err(send1(&mut env, i, &a.kp), code(CoreError::GapSeriesState));
}

#[test]
fn d2_pause() {
    let mut env = world();
    let s = init(&mut env, "SPYx");
    let a = minted(&mut env, &s, 100 * USDC);
    let guardian = env.admin.insecure_clone();
    let p = env.ix_set_paused(&guardian.pubkey(), true);
    env.send(&[p], &[&guardian]).unwrap();
    // New series and new mints stop...
    let payer = env.funded();
    let i = init_ix(&env, &payer.pubkey(), "QQQx");
    assert_err(send1(&mut env, i, &payer), code(CoreError::Paused));
    let u = user(&mut env, &s, 10 * USDC);
    let i = mint_ix(&s, &u, 10 * USDC);
    assert_err(send1(&mut env, i, &u.kp), code(CoreError::Paused));
    // ...merge, settle and redeem always work.
    let i = merge_ix(&s, &a, 20 * USDC);
    ok(&mut env, i, &a.kp);
    assert_eq!(env.token_balance(&a.usdc), 20 * USDC);
    settle_epoch(&mut env, "SPYx", 100.0, 100.0);
    let anyone = env.funded();
    let i = settle_ix(&s, &anyone.pubkey());
    ok(&mut env, i, &anyone);
    for side in [gap_side::DOWN, gap_side::UP] {
        let i = redeem_ix(&s, &a, side, 80 * USDC);
        ok(&mut env, i, &a.kp);
    }
    assert_eq!(env.token_balance(&a.usdc), 100 * USDC);
    assert_eq!(env.token_balance(&s.coll), 0);
}

// -------------------------------------------------------------------------------------------------------------------
// A failure test per instruction
// -------------------------------------------------------------------------------------------------------------------

#[test]
fn init_gap_series_failures() {
    let mut env = world();
    let payer = env.funded();
    // Not an open epoch.
    edit_epoch(&mut env, "QQQx", |e| e.state = epoch_state::CLOSED);
    let i = init_ix(&env, &payer.pubkey(), "QQQx");
    assert_err(send1(&mut env, i, &payer), code(CoreError::WrongEpochState));
    // Past the bell.
    env.set_time(BELL);
    let i = init_ix(&env, &payer.pubkey(), "SPYx");
    assert_err(send1(&mut env, i, &payer), code(CoreError::SalesClosed));
    env.set_time(OCT8_NOON_ET);
    // The wrong Token-2022 program.
    let mut i = init_ix(&env, &payer.pubkey(), "SPYx");
    for m in i.accounts.iter_mut() {
        if m.pubkey == TOKEN_2022_PROGRAM {
            m.pubkey = TOKEN_PROGRAM;
        }
    }
    assert_fails(send1(&mut env, i, &payer));
    // The wrong scenario set (another closure type's PDA) is refused.
    let mut i = init_ix(&env, &payer.pubkey(), "SPYx");
    for m in i.accounts.iter_mut() {
        if m.pubkey == scen_pda(&ticker("SPYx"), 2) {
            m.pubkey = scen_pda(&ticker("QQQx"), 2);
        }
    }
    assert_fails(send1(&mut env, i, &payer));
    // A series is created once.
    let _ = init(&mut env, "SPYx");
    let i = init_ix(&env, &payer.pubkey(), "SPYx");
    assert_fails(send1(&mut env, i, &payer));
}

#[test]
fn mint_gap_set_failures() {
    let mut env = world();
    let s = init(&mut env, "SPYx");
    let u = user(&mut env, &s, 100 * USDC);
    // At the bell and after: sales are closed. Before: fine.
    env.set_time(BELL);
    let i = mint_ix(&s, &u, 10 * USDC);
    assert_err(send1(&mut env, i, &u.kp), code(CoreError::SalesClosed));
    env.set_time(BELL - 1);
    let i = mint_ix(&s, &u, 10 * USDC);
    ok(&mut env, i, &u.kp);
    // The wrong Token-2022 program and the wrong signer.
    let mut i = mint_ix(&s, &u, 10 * USDC);
    for m in i.accounts.iter_mut() {
        if m.pubkey == TOKEN_2022_PROGRAM {
            m.pubkey = TOKEN_PROGRAM;
        }
    }
    assert_fails(send1(&mut env, i, &u.kp));
    let other = env.funded();
    let i = as_signer(mint_ix(&s, &u, 10 * USDC), &u.kp.pubkey(), &other.pubkey());
    assert_fails(send1(&mut env, i, &other));
    // A fake series account is refused (seeds).
    let mut i = mint_ix(&s, &u, 10 * USDC);
    for m in i.accounts.iter_mut() {
        if m.pubkey == s.series {
            m.pubkey = Pubkey::new_unique();
        }
    }
    assert_fails(send1(&mut env, i, &u.kp));
}

#[test]
fn merge_gap_set_failures() {
    let mut env = world();
    let s = init(&mut env, "SPYx");
    let u = minted(&mut env, &s, 10 * USDC);
    let i = merge_ix(&s, &u, 0);
    assert_err(send1(&mut env, i, &u.kp), code(CoreError::InvalidParam));
    let i = merge_ix(&s, &u, 10 * USDC + 1);
    assert_fails(send1(&mut env, i, &u.kp));
    let other = env.funded();
    let i = as_signer(merge_ix(&s, &u, 1), &u.kp.pubkey(), &other.pubkey());
    assert_fails(send1(&mut env, i, &other));
    // After the rate is fixed a merge is a redemption of both sides: it pays the pair's rate, the pair sums to the amount.
    settle_epoch(&mut env, "SPYx", 100.0, 97.0);
    let anyone = env.funded();
    let i = settle_ix(&s, &anyone.pubkey());
    ok(&mut env, i, &anyone);
    let i = merge_ix(&s, &u, 10 * USDC);
    ok(&mut env, i, &u.kp);
    assert_eq!(env.token_balance(&u.usdc), 10 * USDC);
    assert_eq!(env.token_balance(&s.coll), 0);
}

#[test]
fn settle_and_expire_failures() {
    let mut env = world();
    let s = init(&mut env, "SPYx");
    let anyone = env.funded();
    // Epoch still open: wait.
    let i = settle_ix(&s, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::WrongEpochState));
    // Too early to expire.
    let i = expire_ix(&s, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::TooEarly));
    // A settled epoch with a zero price is refused rather than dividing by it.
    edit_epoch(&mut env, "SPYx", |e| {
        e.state = epoch_state::SETTLED;
        e.close_price_wad = 0;
        e.settle_price_wad = 1;
    });
    let i = settle_ix(&s, &anyone.pubkey());
    assert_err(send1(&mut env, i, &anyone), code(CoreError::BadPrice));
    // Another series' mints in the slots.
    let q = init(&mut env, "QQQx");
    settle_epoch(&mut env, "SPYx", 100.0, 100.0);
    let mut i = settle_ix(&s, &anyone.pubkey());
    for m in i.accounts.iter_mut() {
        if m.pubkey == s.down {
            m.pubkey = q.down;
        }
    }
    assert_fails(send1(&mut env, i, &anyone));
}

#[test]
fn redeem_gap_failures() {
    let mut env = world();
    let s = init(&mut env, "SPYx");
    let a = minted(&mut env, &s, 100 * USDC);
    settle_epoch(&mut env, "SPYx", 100.0, 100.0);
    let anyone = env.funded();
    let i = settle_ix(&s, &anyone.pubkey());
    ok(&mut env, i, &anyone);
    let i = redeem_ix(&s, &a, gap_side::DOWN, 0);
    assert_err(send1(&mut env, i, &a.kp), code(CoreError::InvalidParam));
    let i = redeem_ix(&s, &a, 2, 1);
    assert_err(send1(&mut env, i, &a.kp), code(CoreError::GapSide));
    let i = redeem_ix(&s, &a, gap_side::DOWN, 100 * USDC + 1);
    assert_fails(send1(&mut env, i, &a.kp));
    let other = env.funded();
    let i = as_signer(redeem_ix(&s, &a, gap_side::DOWN, 1), &a.kp.pubkey(), &other.pubkey());
    assert_fails(send1(&mut env, i, &other));
    // The USDC destination is the redeemer's own (a thief's account is not accepted for another signer).
    let thief_usdc = env.usdc_account(&other.pubkey(), 0);
    let mut stolen = U { kp: a.kp.insecure_clone(), usdc: thief_usdc, down: a.down, up: a.up };
    stolen.usdc = thief_usdc;
    let i = redeem_ix(&s, &stolen, gap_side::DOWN, 1);
    assert_fails(send1(&mut env, i, &a.kp));
}

// -------------------------------------------------------------------------------------------------------------------
// Solvency walk (INV-20, INV-21, dust ≤ 1 base unit per redemption against the redeemer)
// -------------------------------------------------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next() % n }
    }
}

#[test]
fn d2_solvency() {
    for seed in [1u64, 7, 42, 2026, 5, 11, 13, 99] {
        let mut env = world();
        let s = init(&mut env, "SPYx");
        let mut rng = Rng(seed);
        let users: Vec<U> = (0..4).map(|_| user(&mut env, &s, 1_000_000 * USDC)).collect();
        let mut deposited: u64 = 0;
        // Phase 1: random mints, merges and transfers (before the bell).
        for _ in 0..60 {
            let i = rng.below(4) as usize;
            match rng.below(3) {
                0 => {
                    let amt = 1 + rng.below(5_000_000_001);
                    let ins = mint_ix(&s, &users[i], amt);
                    ok(&mut env, ins, &users[i].kp);
                    deposited += amt;
                }
                1 => {
                    let have = env.token_balance(&users[i].down).min(env.token_balance(&users[i].up));
                    if have > 0 {
                        let amt = 1 + rng.below(have);
                        let ins = merge_ix(&s, &users[i], amt);
                        ok(&mut env, ins, &users[i].kp);
                        deposited -= amt;
                    }
                }
                _ => {
                    let j = rng.below(4) as usize;
                    let (from, to) = if rng.below(2) == 0 { (&users[i].down, &users[j].down) } else { (&users[i].up, &users[j].up) };
                    let have = env.token_balance(from);
                    if have > 0 && i != j {
                        let t = transfer_ix(from, to, &users[i].kp.pubkey(), 1 + rng.below(have));
                        ok(&mut env, t, &users[i].kp);
                    }
                }
            }
            // INV-20 before the rate: the collateral is exactly the sets, and each side's supply is the sets.
            let g = series(&env, &s);
            assert_eq!(env.token_balance(&s.coll), g.sets_outstanding);
            assert_eq!(g.sets_outstanding, deposited);
            assert_eq!((env.mint_supply(&s.down), env.mint_supply(&s.up)), (deposited, deposited));
        }
        // Settle at a random gap in, at and beyond the band.
        // A gap from 1.2 band-widths down to 1.2 up, so most seeds land inside the band (where the split has remainders).
        let k = series(&env, &s).k_wad as f64 / 1e18;
        let r = k * (rng.below(2_401) as f64 / 1_000.0 - 1.2);
        settle_epoch(&mut env, "SPYx", 100.0, 100.0 * (1.0 + r));
        let anyone = env.funded();
        let ins = settle_ix(&s, &anyone.pubkey());
        ok(&mut env, ins, &anyone);
        let g = series(&env, &s);
        assert_eq!(g.down_micro + g.up_micro, 1_000_000, "INV-21");
        assert_eq!(g.pool_down + g.pool_up, g.sets_settled);
        // Phase 2: random redemptions and post-rate merges until empty.
        let mut paid_total: u64 = 0;
        let mut guard = 0;
        while env.mint_supply(&s.down) + env.mint_supply(&s.up) > 0 {
            guard += 1;
            assert!(guard < 5_000);
            let i = rng.below(4) as usize;
            let u = &users[i];
            let (hd, hu) = (env.token_balance(&u.down), env.token_balance(&u.up));
            let before = env.token_balance(&u.usdc);
            let g0 = series(&env, &s);
            if hd.min(hu) > 0 && rng.below(4) == 0 {
                let amt = 1 + rng.below(hd.min(hu));
                let ins = merge_ix(&s, u, amt);
                ok(&mut env, ins, &u.kp);
                let got = env.token_balance(&u.usdc) - before;
                assert!(got <= amt && amt - got <= 1, "merge pays the set to within one base unit: {got} of {amt}");
                paid_total += got;
            } else {
                let side = if rng.below(2) == 0 { gap_side::DOWN } else { gap_side::UP };
                let held = if side == gap_side::DOWN { hd } else { hu };
                if held == 0 {
                    continue;
                }
                let amt = if rng.below(3) == 0 { held } else { 1 + rng.below(held) };
                let ins = redeem_ix(&s, u, side, amt);
                ok(&mut env, ins, &u.kp);
                let got = env.token_balance(&u.usdc) - before;
                let micro = if side == gap_side::DOWN { g0.down_micro } else { g0.up_micro } as u128;
                let exact = amt as u128 * micro;
                // Rounding against the redeemer by less than one base unit (the last redeemer of a side may gain the dust).
                assert!((got as u128 + 1) * 1_000_000 > exact, "dust < 1 against the redeemer: got {got}, exact {}", exact as f64 / 1e6);
                paid_total += got;
            }
            // INV-20 after the rate: the collateral covers exactly what both pools still owe.
            let g = series(&env, &s);
            assert_eq!(env.token_balance(&s.coll), (g.pool_down - g.paid_down) + (g.pool_up - g.paid_up));
            assert!(g.paid_down <= g.pool_down && g.paid_up <= g.pool_up);
        }
        // Everything redeemed: the payouts are the deposits to the base unit, nothing stranded (INV-21).
        assert_eq!(paid_total, deposited, "seed {seed}");
        assert_eq!(env.token_balance(&s.coll), 0);
    }
}

/// Compute units per instruction (recorded in plan/09 and the README).
#[test]
fn gap_compute_units() {
    let mut env = world();
    let payer = env.funded();
    let i = init_ix(&env, &payer.pubkey(), "SPYx");
    let cu_init = send1(&mut env, i, &payer).unwrap().compute_units_consumed;
    let s = S::new("SPYx");
    let u = user(&mut env, &s, 100 * USDC);
    let cu_mint = send1(&mut env, mint_ix(&s, &u, 100 * USDC), &u.kp).unwrap().compute_units_consumed;
    let cu_merge = send1(&mut env, merge_ix(&s, &u, 10 * USDC), &u.kp).unwrap().compute_units_consumed;
    settle_epoch(&mut env, "SPYx", 100.0, 92.0);
    let anyone = env.funded();
    let cu_settle = send1(&mut env, settle_ix(&s, &anyone.pubkey()), &anyone).unwrap().compute_units_consumed;
    let cu_redeem = send1(&mut env, redeem_ix(&s, &u, gap_side::DOWN, 40 * USDC), &u.kp).unwrap().compute_units_consumed;
    let cu_merge_fixed = send1(&mut env, merge_ix(&s, &u, 10 * USDC), &u.kp).unwrap().compute_units_consumed;
    println!("    CU init_gap_series {cu_init}, mint_gap_set {cu_mint}, merge_gap_set {cu_merge} (after the rate {cu_merge_fixed}), settle_gap_series {cu_settle}, redeem_gap {cu_redeem}");
    for (n, cu, max) in [("init", cu_init, 300_000), ("mint", cu_mint, 60_000), ("merge", cu_merge, 60_000), ("settle", cu_settle, 60_000), ("redeem", cu_redeem, 60_000)] {
        assert!(cu < max, "{n}: {cu} CU");
    }
}
