//! W11 (Cover v2) with the real klend program: side UP on a real SPYx short of the xStocks Market (`9LsbmcjT…`, USDC
//! deposits, SPYx debt; `scripts/src/fetch-short-obligation.ts`), netting with a DOWN policy in one loss vector,
//! OVERNIGHT and HOLIDAY_WEEKEND closures priced on their own sets and σ, and the earnings σ bump. Goldens against the
//! pricing functions (`risk-core::up`), one failure test per new check.

mod common;

use anchor_lang::{prelude::Pubkey, solana_program::instruction::{AccountMeta, Instruction}, AnchorDeserialize, InstructionData, ToAccountMetas};
use common::*;
use credence_core::{accounts as acc, instruction as ix, pricing, state::*, CoreError};
use solana_keypair::Keypair;
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000;
const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;
const SPY_CLOSE: f64 = 777.05;
const MULT: f64 = 1.0057;

fn short_key() -> Pubkey {
    load_json("programs/credence-core/tests/fixtures/klend/short.json")["address"].as_str().unwrap().parse().unwrap()
}

/// Phase 1 + klend snapshot, the short re-owned by a fresh buyer with its debt scaled by `num / 100`.
fn world(num: u128) -> (Env, Keypair, Pubkey, Pubkey) {
    let mut env = Env::real(LP);
    let b = env.funded();
    env.load_klend(&b.pubkey());
    let mut d = fixture("klend/obligation_short");
    ob::put(&mut d, ob::OB_OWNER, b.pubkey().as_ref());
    ob::scale_debt(&mut d, num, 100);
    // Test setup: the short was fetched after the klend snapshot, so its borrow's cumulative-rate index is newer than
    // the snapshot's SPYx reserve (klend: "interest rate is negative"). It takes the reserve's index (32 bytes at +32).
    let r = env.data(&RESERVE_SPYX);
    let o = credence_core::kamino::layout::RS_LIQUIDITY_CUMULATIVE_BORROW_RATE_BSF;
    let idx = r[o..o + 32].to_vec();
    ob::put(&mut d, ob::OB_BORROWS + 32, &idx);
    let key = short_key();
    env.put_klend(key, d);
    let usdc = env.usdc_account(&b.pubkey(), 100_000_000_000);
    (env, b, usdc, key)
}

fn refreshes_short(key: Pubkey) -> Vec<Instruction> {
    vec![kl::refresh_reserve(RESERVE_SPYX), kl::refresh_reserve(RESERVE_USDC), kl::refresh_obligation(key, &[RESERVE_USDC, RESERVE_SPYX])]
}

fn ix_buy_up(env: &Env, buyer: &Pubkey, buyer_usdc: Pubkey, obligation: Pubkey, closure_id: u32, cap: u64, max_premium: u64) -> Instruction {
    let t = ticker("SPYx");
    let epoch = epoch_pda(&t, closure_id);
    let closure_type = env.anchor::<Epoch>(&epoch).closure_type;
    let mut metas = acc::BuyCoverUp {
        buyer: *buyer,
        config: config_pda(),
        asset: asset_pda(&t),
        scenarios: scen_pda(&t, closure_type),
        epoch,
        earnings: earnings_pda(&t),
        loss: loss_pda(closure_id),
        vault: vault_pda(),
        vault_usdc: vault_usdc_pda(),
        share_mint: shares_pda(),
        fee_account: env.anchor::<Vault>(&vault_pda()).fee_account,
        buyer_usdc,
        obligation,
        borrow_reserve: RESERVE_SPYX,
        policy: policy_pda(&epoch, &obligation),
        token_program: TOKEN_PROGRAM,
        system_program: anchor_lang::solana_program::system_program::ID,
    }
    .to_account_metas(None);
    metas.push(AccountMeta::new_readonly(RESERVE_USDC, false));
    Instruction::new_with_bytes(credence_core::ID, &ix::BuyCoverUp { ticker: t, closure_id, max_payout: cap, max_premium }.data(), metas)
}

fn debt_value(env: &Env, key: &Pubkey) -> u64 {
    ((ob::get_u128(&env.data(key), ob::OB_BF_ADJUSTED_DEBT_VALUE_SF) * 1_000_000) >> 60) as u64
}

fn buy_up(env: &mut Env, b: &Keypair, usdc: Pubkey, key: Pubkey, closure_id: u32) -> TxResult {
    let mut ixs = refreshes_short(key);
    let cap = debt_value(env, &key) / 2;
    ixs.push(ix_buy_up(env, &b.pubkey(), usdc, key, closure_id, cap, u64::MAX));
    env.send(&ixs, &[b])
}

fn program_cu(logs: &[String]) -> u64 {
    let id = credence_core::ID.to_string();
    logs.iter().filter_map(|l| l.strip_prefix(&format!("Program {id} consumed "))).filter_map(|r| r.split(' ').next()?.parse().ok()).max().unwrap_or(0)
}

fn event_util(logs: &[String]) -> u64 {
    use base64::Engine;
    logs.iter().filter_map(|l| l.strip_prefix("Program data: ")).filter_map(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .find_map(|d| credence_core::instructions::cover::CoverBought::deserialize(&mut &d[8..]).ok()).unwrap().util_after_wad
}

/// The UP purchase on the real short at D/C′ ≈ 0.98 (its debt × 1.14 on the snapshot's prices; joint set v2's up tail
/// reaches +4.2% for SPYx, so a short further from its threshold reserves nothing): C′ and D are klend's own (unhealthy borrow value, borrow-factor
/// adjusted debt value); the reserved losses equal `pricing::policy_losses_up` (in the up scenarios only) and the
/// premium `pricing::premium_up` on the WEEKEND set.
#[test]
fn buy_cover_up_golden() {
    let (mut env, b, usdc, key) = world(114);
    let r = buy_up(&mut env, &b, usdc, key, GROUP_OCT9).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("buy_cover_up: program {} CU, transaction {} CU", program_cu(&r.logs), r.compute_units_consumed);
    let p: Policy = env.anchor(&policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &key));
    assert_eq!(p.side, side::UP);
    let d = env.data(&key);
    assert_eq!(p.covered_value, ((ob::get_u128(&d, ob::OB_UNHEALTHY_BORROW_VALUE_SF) * 1_000_000) >> 60) as u64);
    assert_eq!(p.debt, debt_value(&env, &key) + 1, "D rounded up");
    println!("short: D {} C′ {} D/C′ {:.4}", p.debt, p.covered_value, p.debt as f64 / p.covered_value as f64);
    let c: Config = env.anchor(&config_pda());
    let a: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    let x = pricing::CoverInputs { covered_value: p.covered_value, debt: pricing::reserved_debt(p.debt, &c).unwrap(), max_payout: p.max_payout };
    let mut losses = vec![0u64; K];
    let worst = pricing::policy_losses_up(&a, &x, WAD, &mut losses).unwrap();
    assert_eq!(p.worst_loss, worst);
    assert!(worst > 0, "an up gap hurts a short near its threshold");
    let l: LossVector = env.zc(&loss_pda(GROUP_OCT9));
    assert_eq!(&l.losses[..], &losses[..]);
    let s: ScenarioSet = env.zc(&scen_pda(&ticker("SPYx"), closure::WEEKEND));
    let xp = pricing::CoverInputs { debt: pricing::priced_debt(p.debt, &c).unwrap(), ..x };
    let prem = pricing::premium_up(&s.z[..s.n as usize], &c, a.sigma_wad, 3, event_util(&r.logs), &xp).unwrap();
    assert_eq!(p.premium, prem);
    // Its losses are in the up scenarios: zero where SPYx falls.
    let down = (0..K).filter(|j| a.gap_factor_q64(*j) < (1u128 << 64)).count();
    assert!((0..K).filter(|j| a.gap_factor_q64(*j) < (1u128 << 64)).all(|j| losses[j] == 0) && down > 0);
}

/// Netting: a DOWN policy (the long `47wNsqpy…` near its threshold) and an UP policy (the short) on SPYx in the same
/// weekend reserve less together than apart: their losses sit in opposite scenarios of one loss vector (INV-2 on the
/// netted vector).
#[test]
fn netting_lowers_reserved_capacity() {
    let (mut env, b, usdc, key) = world(114);
    // The long: 47wNsqpy… re-owned by the same buyer, its debt scaled to D/C′ ≈ 0.96.
    let mut d = fixture("obligation_47wN");
    ob::put(&mut d, ob::OB_OWNER, b.pubkey().as_ref());
    ob::scale_debt(&mut d, 127, 100);
    env.put_klend(OBLIGATION_47WN, d);
    let mut ixs = kl::refreshes();
    let debt = (kl::debt_sf(&env) >> 60) as u64;
    ixs.push(env.ix_buy_cover(&BuyArgs { buyer: b.pubkey(), buyer_usdc: usdc, obligation: OBLIGATION_47WN, deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"), closure_id: GROUP_OCT9, max_payout: debt, max_premium: u64::MAX }));
    env.send(&ixs, &[&b]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let down: Policy = env.anchor(&policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &OBLIGATION_47WN));
    let max_down = env.zc::<LossVector>(&loss_pda(GROUP_OCT9)).max_loss;
    buy_up(&mut env, &b, usdc, key, GROUP_OCT9).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let up: Policy = env.anchor(&policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &key));
    let l: LossVector = env.zc(&loss_pda(GROUP_OCT9));
    println!("worst DOWN {} + worst UP {} = {}; netted group max {}", down.worst_loss, up.worst_loss, down.worst_loss + up.worst_loss, l.max_loss);
    assert_eq!(max_down, down.worst_loss);
    assert!(l.max_loss < down.worst_loss + up.worst_loss, "a balanced book reserves less than the sum");
    assert_eq!(l.max_loss, max_down.max(up.worst_loss), "opposite scenarios: the group needs only the larger side");
    assert_eq!(env.anchor::<Vault>(&vault_pda()).reserved_total, l.max_loss);
}

/// Stores the Friday close and the Monday open at `close × (1 + r)` for SPYx (equity source, cross-checked).
fn close_and_open(env: &mut Env, r: f64) {
    let a = env.admin.pubkey();
    let asset: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    env.set_time(OCT9_CLOSE + 30);
    let p = env.put_price(&Px::new(asset.feed_equity, SPY_CLOSE, OCT9_CLOSE - 1));
    let x = env.put_price(&Px::new(asset.feed_xstock, SPY_CLOSE * MULT, OCT9_CLOSE - 300));
    let snap = env.ix_snapshot(&a, "SPYx", GROUP_OCT9, p, Some(x));
    env.send_admin(&[snap]).unwrap();
    let open = SPY_CLOSE * (1.0 + r);
    let u = env.put_price(&Px::new(asset.feed_equity, open, OCT12_OPEN + 30));
    let x2 = env.put_price(&Px::new(asset.feed_xstock, open * MULT, OCT12_OPEN + 60));
    env.set_time(OCT12_OPEN + 301);
    let post = env.ix_post(&a, "SPYx", GROUP_OCT9, &[u], Some(x2));
    env.send_admin(&[post]).unwrap();
    env.svm.warp_to_slot(env.slot() + 10);
    env.freshen_scope();
}

/// UP settlement: SPYx opens +12%; the payout (`realized_payout_up` on the debt with the xStock reserve's interest)
/// goes to the owner's USDC wallet, the short itself untouched (USDC cannot repay its SPYx debt). A −8% open pays 0.
#[test]
fn settle_up_pays_the_wallet() {
    for (r, pays) in [(0.12, true), (-0.08, false)] {
        let (mut env, b, usdc, key) = world(110);
        buy_up(&mut env, &b, usdc, key, GROUP_OCT9).unwrap();
        close_and_open(&mut env, r);
        let policy = policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &key);
        let keeper = env.funded();
        let debt0 = ob::get_u128(&env.data(&key), ob::OB_BORROWS + ob::BOR_BORROWED_AMOUNT_SF);
        let w0 = env.token_balance(&usdc);
        let mut ixs = refreshes_short(key);
        let mut ix = env.ix_settle(&keeper.pubkey(), policy, usdc, true);
        for m in ix.accounts.iter_mut() {
            if m.pubkey == RESERVE_USDC {
                m.pubkey = RESERVE_SPYX; // the policy's borrow reserve: the xStock's (its interest index)
            }
        }
        ixs.push(ix);
        let res = env.send(&ixs, &[&keeper]);
        let p: Policy = env.anchor(&policy);
        if res.is_err() {
            panic!("{:?}", res.unwrap_err().meta.logs);
        }
        let e: Epoch = env.anchor(&p.epoch);
        let want = pricing::realized_payout_up(p.covered_value, accrued_debt_now(&env, &p), p.max_payout, e.close_price_wad, e.settle_price_wad).unwrap();
        println!("UP at {:+.0}%: payout {} (want {want})", r * 100.0, p.payout);
        assert_eq!(p.state, policy_state::SETTLED);
        assert_eq!(p.payout, want);
        assert_eq!(pays, want > 0);
        assert_eq!(env.token_balance(&usdc) - w0, want, "to the wallet");
        assert_eq!(ob::get_u128(&env.data(&key), ob::OB_BORROWS + ob::BOR_BORROWED_AMOUNT_SF) >= debt0, true, "the short's debt is not repaid");
    }
}

/// `buy_cover_up` and the up side elsewhere: one failure per check.
#[test]
fn buy_cover_up_failures() {
    let (mut env, b, usdc, key) = world(110);
    let has = |s: String, e: CoreError| assert!(s.contains(&code(e).to_string()), "want {e:?}: {s}");
    let cap = debt_value(&env, &key) / 2;
    let send = |env: &mut Env, ixs: Vec<Instruction>, s: &Keypair| { env.svm.expire_blockhash(); format!("{:?}", env.send(&ixs, &[s]).unwrap_err().err) };
    // Not the owner.
    let other = env.funded();
    let ou = env.usdc_account(&other.pubkey(), 1_000_000_000);
    let mut ixs = refreshes_short(key);
    ixs.push(ix_buy_up(&env, &other.pubkey(), ou, key, GROUP_OCT9, cap, u64::MAX));
    has(send(&mut env, ixs, &other), CoreError::NotObligationOwner);
    // Cap above the debt.
    let mut ixs = refreshes_short(key);
    ixs.push(ix_buy_up(&env, &b.pubkey(), usdc, key, GROUP_OCT9, cap * 3, u64::MAX));
    has(send(&mut env, ixs, &b), CoreError::InvalidParam);
    // The wrong deposit-reserve list (none).
    let mut ixs = refreshes_short(key);
    let mut ix = ix_buy_up(&env, &b.pubkey(), usdc, key, GROUP_OCT9, cap, u64::MAX);
    ix.accounts.pop();
    ixs.push(ix);
    has(send(&mut env, ixs, &b), CoreError::InvalidParam);
    // A long through the up path: 47wNsqpy… borrows USDC, not SPYx.
    let mut d = fixture("obligation_47wN");
    ob::put(&mut d, ob::OB_OWNER, b.pubkey().as_ref());
    env.put_klend(OBLIGATION_47WN, d);
    let mut ixs = kl::refreshes();
    let mut ix = ix_buy_up(&env, &b.pubkey(), usdc, OBLIGATION_47WN, GROUP_OCT9, 1_000_000, u64::MAX);
    let n = ix.accounts.len();
    ix.accounts[n - 1] = AccountMeta::new_readonly(RESERVE_SPYX, false); // its deposit reserve
    ixs.push(ix);
    has(send(&mut env, ixs, &b), CoreError::UnsupportedObligation);
    // Premium above the maximum.
    let mut ixs = refreshes_short(key);
    ixs.push(ix_buy_up(&env, &b.pubkey(), usdc, key, GROUP_OCT9, cap, 1));
    has(send(&mut env, ixs, &b), CoreError::PremiumAboveMax);
    // Already past the threshold.
    let (mut env2, b2, usdc2, key2) = world(200);
    let mut ixs = refreshes_short(key2);
    ixs.push(ix_buy_up(&env2, &b2.pubkey(), usdc2, key2, GROUP_OCT9, 1_000_000, u64::MAX));
    has(send(&mut env2, ixs, &b2), CoreError::AlreadyLiquidatable);
    // Everything right: bought; then the shield refuses an UP policy.
    buy_up(&mut env, &b, usdc, key, GROUP_OCT9).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
}

/// Uploads `t`'s set of `closure_type` from `data/onchain/<t>-<NAME>.json` with its σ.
fn upload_closure_set(env: &mut Env, t: &str, closure_type: u8, name: &str) -> u64 {
    let f = load_json(&format!("data/onchain/{t}-{name}.json"));
    let z = json_i16(&f["z"]);
    let (a, tk) = (env.admin.pubkey(), ticker(t));
    let set = scen_pda(&tk, closure_type);
    let ix = env.ix_init_scen(&a, tk, closure_type, z.len() as u16);
    env.send_admin(&[ix]).unwrap();
    for (i, c) in z.chunks(400).enumerate() {
        let ix = env.ix_write_scen(&a, set, (i * 400) as u16, c.to_vec());
        env.send_admin(&[ix]).unwrap();
    }
    let ix = env.ix_finalize_scen(&a, set, asset_pda(&tk), sha256_i16(&[&z]));
    env.send_admin(&[ix]).unwrap();
    let sigma: u64 = f["sigmaWad"].as_str().unwrap().parse().unwrap();
    let ix = Instruction::new_with_bytes(credence_core::ID, &ix::SetScenarioSigma { sigma_wad: sigma }.data(),
        acc::SetScenarioSigma { admin: a, config: config_pda(), set }.to_account_metas(None));
    env.send_admin(&[ix]).unwrap();
    sigma
}

/// Buys DOWN cover on 47wNsqpy… (debt × 1.27) for `closure_id`; the policy.
fn buy_down(env: &mut Env, b: &Keypair, usdc: Pubkey, closure_id: u32) -> Policy {
    let mut d = fixture("obligation_47wN");
    ob::put(&mut d, ob::OB_OWNER, b.pubkey().as_ref());
    ob::scale_debt(&mut d, 127, 100);
    let slot = env.slot();
    ob::put(&mut d, ob::OB_LAST_UPDATE_SLOT, &slot.to_le_bytes());
    env.put_klend(OBLIGATION_47WN, d);
    let mut ixs = kl::refreshes();
    let debt = (kl::debt_sf(env) >> 60) as u64;
    ixs.push(env.ix_buy_cover(&BuyArgs { buyer: b.pubkey(), buyer_usdc: usdc, obligation: OBLIGATION_47WN, deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"), closure_id, max_payout: debt, max_premium: u64::MAX }));
    env.send(&ixs, &[b]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    env.anchor(&policy_pda(&epoch_pda(&ticker("SPYx"), closure_id), &OBLIGATION_47WN))
}

/// OVERNIGHT: Thursday Oct 8 → Friday Oct 9 is one night. The epoch opens with its type, `buy_cover` prices on the
/// OVERNIGHT set, its σ and 1 day; the premium is below the weekend's for the same position; without the set the
/// purchase is refused.
#[test]
fn overnight_cover_prices_on_its_own_set() {
    let (mut env, b, usdc, _) = world(110);
    let a = env.admin.pubkey();
    let ix = env.ix_open_group(&a, 20261008);
    env.send_admin(&[ix]).unwrap();
    let ix = env.ix_open_epoch(&a, ticker("SPYx"), 20261008);
    env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    assert_eq!(env.anchor::<Epoch>(&epoch_pda(&ticker("SPYx"), 20261008)).closure_type, closure::OVERNIGHT);
    // No OVERNIGHT set yet: refused.
    let mut d = fixture("obligation_47wN");
    ob::put(&mut d, ob::OB_OWNER, b.pubkey().as_ref());
    ob::scale_debt(&mut d, 127, 100);
    env.put_klend(OBLIGATION_47WN, d);
    let mut ixs = kl::refreshes();
    let debt = (kl::debt_sf(&env) >> 60) as u64;
    ixs.push(env.ix_buy_cover(&BuyArgs { buyer: b.pubkey(), buyer_usdc: usdc, obligation: OBLIGATION_47WN, deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"), closure_id: 20261008, max_payout: debt, max_premium: u64::MAX }));
    assert!(env.send(&ixs, &[&b]).is_err(), "no OVERNIGHT set: refused");
    let sigma = upload_closure_set(&mut env, "SPYx", closure::OVERNIGHT, "OVERNIGHT");
    let night = buy_down(&mut env, &b, usdc, 20261008);
    // The same position for the weekend (another policy PDA: another epoch).
    let weekend = buy_down(&mut env, &b, usdc, GROUP_OCT9);
    let c: Config = env.anchor(&config_pda());
    let s: ScenarioSet = env.zc(&scen_pda(&ticker("SPYx"), closure::OVERNIGHT));
    let a: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    let xp = pricing::CoverInputs { covered_value: night.covered_value, debt: pricing::priced_debt(night.debt, &c).unwrap(), max_payout: night.max_payout };
    let z = &s.z[..s.n as usize];
    let l1 = pricing::shield_loading(z, &c, sigma, a.basis_sigma_wad, &xp, night.worst_loss).unwrap();
    println!("premium overnight {} (σ {:.3}%, 1 day, loading {l1}) vs weekend {} (σ {:.3}%, 3 days)", night.premium, sigma as f64 / 1e16, weekend.premium, a.sigma_wad as f64 / 1e16);
    assert!(night.premium < weekend.premium, "a night costs less than a weekend");
    assert_eq!(night.shield_loading, l1);
}

/// HOLIDAY_WEEKEND: Friday Jan 15, 2027 → Tuesday Jan 19 (Martin Luther King Day). Opens with its type and prices on
/// the HOLIDAY_WEEKEND set, its σ and 4 days.
#[test]
fn holiday_weekend_cover() {
    let (mut env, b, usdc, _) = world(110);
    let a = env.admin.pubkey();
    // Monday Jan 11, 2027 (the sale opens with the week's first session), Scope re-stamped.
    env.set_time(1_799_682_000 + 3_600);
    env.svm.warp_to_slot(env.slot() + 100);
    env.freshen_scope();
    let ix = env.ix_open_group(&a, 20270115);
    env.send_admin(&[ix]).unwrap();
    let ix = env.ix_open_epoch(&a, ticker("SPYx"), 20270115);
    env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let e: Epoch = env.anchor(&epoch_pda(&ticker("SPYx"), 20270115));
    assert_eq!(e.closure_type, closure::HOLIDAY_WEEKEND);
    upload_closure_set(&mut env, "SPYx", closure::HOLIDAY_WEEKEND, "HOLIDAY_WEEKEND");
    let p = buy_down(&mut env, &b, usdc, 20270115);
    let c: Config = env.anchor(&config_pda());
    let s: ScenarioSet = env.zc(&scen_pda(&ticker("SPYx"), closure::HOLIDAY_WEEKEND));
    let a: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    let days = ((e.open - e.close) as u64).div_ceil(86_400) as u16;
    assert_eq!(days, 4);
    let xp = pricing::CoverInputs { covered_value: p.covered_value, debt: pricing::priced_debt(p.debt, &c).unwrap(), max_payout: p.max_payout };
    let z = &s.z[..s.n as usize];
    let base = pricing::premium(z, &c, s.sigma_wad, a.dividend_wad, days, 0, &xp).unwrap();
    println!("holiday weekend premium {} (base at u = 0: {base}, σ {:.3}%, {days} days)", p.premium, s.sigma_wad as f64 / 1e16);
    assert!(p.premium >= base);
}

/// Earnings: a release inside the weekend multiplies σ by the bump; the premium and the reserved worst loss are higher
/// than without it, and the bump scales the capacity gap factors.
#[test]
fn earnings_release_bumps_sigma() {
    let base = {
        let (mut env, b, usdc, _) = world(110);
        buy_down(&mut env, &b, usdc, GROUP_OCT9)
    };
    let (mut env, b, usdc, _) = world(110);
    let a = env.admin.pubkey();
    let t = ticker("SPYx");
    let set = |bump_wad: u64| Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SetEarnings { ticker: t, bump_wad, releases: vec![OCT9_CLOSE + 3_600 * 24] }.data(),
        acc::SetEarnings { admin: a, config: config_pda(), asset: asset_pda(&t), earnings: earnings_pda(&t), system_program: anchor_lang::solana_program::system_program::ID }
            .to_account_metas(None),
    );
    // The bump is 1× to 8× (the earnings backtest measured up to 5.70×).
    for bad in [WAD - 1, 8 * WAD + 1] {
        assert!(format!("{:?}", env.send_admin(&[set(bad)]).unwrap_err().err).contains(&code(CoreError::InvalidParam).to_string()));
    }
    env.send_admin(&[set(8 * WAD)]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    env.send_admin(&[set(2 * WAD)]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    // The earnings account cannot be left out: another account in its slot is refused.
    {
        let mut d = fixture("obligation_47wN");
        ob::put(&mut d, ob::OB_OWNER, b.pubkey().as_ref());
        ob::scale_debt(&mut d, 127, 100);
        env.put_klend(OBLIGATION_47WN, d);
        let mut ixs = kl::refreshes();
        let mut ix = env.ix_buy_cover(&BuyArgs { buyer: b.pubkey(), buyer_usdc: usdc, obligation: OBLIGATION_47WN, deposit_reserve: RESERVE_SPYX,
            ticker: t, closure_id: GROUP_OCT9, max_payout: 1_000_000, max_premium: u64::MAX });
        for m in ix.accounts.iter_mut() {
            if m.pubkey == earnings_pda(&t) {
                m.pubkey = Pubkey::new_unique();
            }
        }
        ixs.push(ix);
        assert!(format!("{:?}", env.send(&ixs, &[&b]).unwrap_err().err).contains(&code(CoreError::InvalidParam).to_string()));
    }
    let bumped = buy_down(&mut env, &b, usdc, GROUP_OCT9);
    println!("premium without / with an earnings release: {} / {}; worst {} / {}", base.premium, bumped.premium, base.worst_loss, bumped.worst_loss);
    assert!(bumped.premium > base.premium && bumped.worst_loss >= base.worst_loss);
}


/// Audit A-64: the UP side reserves and prices the up move itself. The stored gap factors are the DOWN side's
/// `(1 + r − d)(1 − κ)`: a dividend (or κ) lowered every UP loss, while xStock's multiplier makes the payout's price
/// ratio ignore the dividend. With a 2% dividend the UP policy reserves and costs what it does without one.
#[test]
fn a64_up_ignores_dividend_and_kappa() {
    let (mut env, b, usdc, key) = world(114);
    buy_up(&mut env, &b, usdc, key, GROUP_OCT9).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let p0: Policy = env.anchor(&policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &key));

    let (mut env, b, usdc, key) = world(114);
    let a = env.admin.pubkey();
    let mut params = real_asset_params(0);
    params.dividend_wad = 20_000_000_000_000_000; // 2%
    let ix = env.ix_update_asset(&a, ticker("SPYx"), params);
    env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    env.compute_gap_factors("SPYx", 2, 128).unwrap();
    buy_up(&mut env, &b, usdc, key, GROUP_OCT9).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let p1: Policy = env.anchor(&policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &key));
    println!("UP worst / premium without a dividend {} / {}, with 2% {} / {}", p0.worst_loss, p0.premium, p1.worst_loss, p1.premium);
    assert!(p1.worst_loss >= p0.worst_loss, "a dividend must not lower the UP reservation");
    assert_eq!(p1.premium, p0.premium);
}
