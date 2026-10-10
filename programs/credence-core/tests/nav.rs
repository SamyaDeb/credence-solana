//! D4 NAV-priced asset (research prototype): ONyc on Kamino's OnRe Market, a closure between two daily strikes of a schedule, priced
//! and settled on the lender's own oracle (Kamino's Scope), covered on a REAL ONyc/USDC obligation (a mainnet snapshot, the real klend
//! program; its owner field is rewritten to the test wallet, as the demos do). The NAV moves by a SIMULATED amount; the scenario set
//! and σ are an ASSUMED floor (no down strike exists in the data). Attack tests: wrong strike, stale NAV, halted fund, redemption
//! gate, plus market isolation, the shield refusal and registration failures.

mod common;

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        system_program,
    },
    InstructionData, ToAccountMetas,
};
use common::*;
use credence_core::{
    accounts as acc, calendar::days_from_civil, instruction as ix, oracle::scope, state::*, state_nav::*, AssetParams, CoreError,
};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000;
const USDC: u64 = 1_000_000;
const GROUP: u32 = 20261011; // the strike on Oct 11 00:00 UTC: closes Sat Oct 10 evening ET... the closure runs to Oct 12 00:00 UTC
const ONRE_MARKET: Pubkey = anchor_lang::pubkey!("47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8");
const ONYC_MINT: Pubkey = anchor_lang::pubkey!("5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5");
const RESERVE_ONYC: Pubkey = anchor_lang::pubkey!("6ZxkBSJEqsXA3Kdm2PDAzHLUdPTPUK93Lf4bAezec1UQ");
const DAY: i64 = 86_400;
const SCOPE_ONYC: usize = 350;
const SCOPE_ONYC_TWAP: usize = 478;

fn nav_pda(t: &Ticker) -> Pubkey {
    pda(&[SEED_NAV, t.as_ref()])
}
fn anchor_ts() -> i64 {
    days_from_civil(20261001).unwrap() * DAY
}
fn close_ts() -> i64 {
    days_from_civil(GROUP).unwrap() * DAY
}
fn open_ts() -> i64 {
    close_ts() + DAY
}

struct Onre {
    reserve_usdc: Pubkey,
    supply_vault: Pubkey,
    debt_farm: Pubkey,
    farm_user: Pubkey,
    obligation: Pubkey,
    scope_ts: i64,
}
fn fixtures() -> String {
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/onre").to_string()
}
fn lma() -> Pubkey {
    Pubkey::find_program_address(&[b"lma", ONRE_MARKET.as_ref()], &KLEND).0
}

struct W {
    env: Env,
    on: Onre,
    buyer: Keypair,
    buyer_usdc: Pubkey,
    guardian: Keypair,
    admin: Pubkey,
}

/// Loads klend, farms and the OnRe snapshot; the obligation's owner is `owner`. The clock goes just after the newest Scope price.
fn load_onre(env: &mut Env, owner: &Pubkey) -> Onre {
    let dir = fixtures();
    let progs = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/programs");
    for (name, id) in [("klend", KLEND), ("farms", kl::FARMS)] {
        let so = std::fs::read(format!("{progs}/{name}.so")).unwrap_or_else(|_| panic!("{progs}/{name}.so missing: run scripts/test.sh with MAINNET_RPC"));
        env.svm.add_program(id, &so).unwrap();
    }
    let snap: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/snapshot.json")).unwrap()).unwrap();
    for (name, meta) in snap["accounts"].as_object().unwrap() {
        let mut data = std::fs::read(format!("{dir}/{name}.bin")).unwrap();
        if name == "obligation" {
            ob::put(&mut data, ob::OB_OWNER, owner.as_ref());
        }
        let key: Pubkey = meta["address"].as_str().unwrap().parse().unwrap();
        let owner_prog: Pubkey = meta["owner"].as_str().unwrap().parse().unwrap();
        env.svm
            .set_account(key, Account { lamports: meta["lamports"].as_u64().unwrap(), data, owner: owner_prog, executable: false, rent_epoch: 0 })
            .unwrap();
    }
    let a = |n: &str| -> Pubkey { snap["accounts"][n]["address"].as_str().unwrap().parse().unwrap() };
    let scope_ts = snap["scope"].as_object().unwrap().values().map(|v| v["unixTimestamp"].as_i64().unwrap()).max().unwrap();
    env.svm.warp_to_slot(snap["slot"].as_u64().unwrap() + 1);
    env.set_time(scope_ts + 5);
    Onre {
        reserve_usdc: a("reserve_usdc"),
        supply_vault: a("usdc_supply_vault"),
        debt_farm: a("usdc_debt_farm"),
        farm_user: a("obligation_farm_user_state"),
        obligation: a("obligation"),
        scope_ts,
    }
}

/// Test-only: restamps every Scope entry to the current slot and `unix`, and scales the ONyc price and its TWAP by `mult` against the
/// snapshot's, so klend's refreshes pass its age checks at any test time and the NAV moves by a simulated amount. Never used on-chain.
fn scope_at(env: &mut Env, mult: f64, unix: i64) {
    let orig = std::fs::read(format!("{}/scope_prices.bin", fixtures())).unwrap();
    let mut a = env.svm.get_account(&SCOPE_PRICES).unwrap();
    let slot = env.slot();
    for i in 0..512 {
        let o = scope::PRICES_OFFSET + i * scope::ENTRY_LEN;
        if u64::from_le_bytes(orig[o + 24..o + 32].try_into().unwrap()) == 0 {
            continue;
        }
        a.data[o..o + 16].copy_from_slice(&orig[o..o + 16]);
        a.data[o + 16..o + 24].copy_from_slice(&slot.to_le_bytes());
        a.data[o + 24..o + 32].copy_from_slice(&(unix as u64).to_le_bytes());
        if i == SCOPE_ONYC || i == SCOPE_ONYC_TWAP {
            let v = u64::from_le_bytes(orig[o..o + 8].try_into().unwrap());
            a.data[o..o + 8].copy_from_slice(&((v as f64 * mult).round() as u64).to_le_bytes());
        }
    }
    env.svm.set_account(SCOPE_PRICES, a).unwrap();
}

fn params() -> AssetParams {
    AssetParams {
        feed_equity: [0; 32],
        feed_xstock: [0; 32],
        feed_redemption: [0; 32],
        kamino_reserves: [RESERVE_ONYC, Pubkey::default()],
        sigma_wad: 5_000_000_000_000_000, // the 0.5% floor
        dividend_wad: 0,
        joint_column: 0,
        enabled: true,
        settle_source: credence_core::oracle::source::SCOPE,
        scope_chain: SCOPE_ONYC as u16,
        basis_sigma_wad: 0,
    }
}

fn add_nav_ix(admin: &Pubkey, t: Ticker, p: AssetParams, anchor: i64, interval: u32, mint: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::AddNavAsset { ticker: t, params: p, anchor_ts: anchor, interval_secs: interval }.data(),
        acc::AddNavAsset {
            admin: *admin,
            config: config_pda(),
            asset: asset_pda(&t),
            schedule: nav_pda(&t),
            mint,
            token_program: TOKEN_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn open_nav_ix(payer: &Pubkey, t: Ticker, id: u32) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::OpenNavEpoch { ticker: t, closure_id: id }.data(),
        acc::OpenNavEpoch {
            payer: *payer,
            config: config_pda(),
            asset: asset_pda(&t),
            schedule: nav_pda(&t),
            loss: loss_pda(id),
            epoch: epoch_pda(&t, id),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn halt_nav_ix(keeper: &Pubkey, t: Ticker, id: u32) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::HaltNavEpoch { ticker: t, closure_id: id }.data(),
        acc::HaltNavEpoch { keeper: *keeper, config: config_pda(), schedule: nav_pda(&t), epoch: epoch_pda(&t, id) }.to_account_metas(None),
    )
}

fn gate_ix(who: &Pubkey, t: Ticker, gated: bool) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SetNavGate { gated }.data(),
        acc::SetNavGate { authority: *who, config: config_pda(), schedule: nav_pda(&t) }.to_account_metas(None),
    )
}

fn stop_ix(who: &Pubkey, t: Ticker, id: u32) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::StopNavSales {}.data(),
        acc::StopNavSales { authority: *who, config: config_pda(), epoch: epoch_pda(&t, id) }.to_account_metas(None),
    )
}

fn refresh_reserve(reserve: Pubkey) -> Instruction {
    let mut i = kl::refresh_reserve(reserve);
    i.accounts[1] = AccountMeta::new_readonly(ONRE_MARKET, false);
    i
}
fn refreshes(on: &Onre) -> Vec<Instruction> {
    let mut o = kl::refresh_obligation(on.obligation, &[RESERVE_ONYC, on.reserve_usdc]);
    o.accounts[0] = AccountMeta::new_readonly(ONRE_MARKET, false);
    vec![refresh_reserve(RESERVE_ONYC), refresh_reserve(on.reserve_usdc), o]
}

fn buy_ix(w: &W, t: Ticker, id: u32, max_payout: u64, obligation: Pubkey, deposit_reserve: Pubkey, borrow_reserve: Pubkey) -> Instruction {
    let epoch = epoch_pda(&t, id);
    let ctype = w.env.anchor::<Epoch>(&epoch).closure_type;
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::BuyCover { ticker: t, closure_id: id, max_payout, max_premium: u64::MAX }.data(),
        acc::BuyCover {
            buyer: w.buyer.pubkey(),
            config: config_pda(),
            asset: asset_pda(&t),
            scenarios: scen_pda(&t, ctype),
            epoch,
            earnings: earnings_pda(&t),
            loss: loss_pda(id),
            vault: vault_pda(),
            vault_usdc: vault_usdc_pda(),
            share_mint: shares_pda(),
            fee_account: w.env.anchor::<Vault>(&vault_pda()).fee_account,
            buyer_usdc: w.buyer_usdc,
            obligation,
            deposit_reserve,
            borrow_reserve,
            policy: policy_pda(&epoch, &obligation),
            token_program: TOKEN_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn debt(w: &W) -> u64 {
    (ob::get_u128(&w.env.data(&w.on.obligation), ob::OB_BORROWS + ob::BOR_BORROWED_AMOUNT_SF) >> 60) as u64
}

/// Buys cover on the ONyc obligation with `max_payout` (refreshes + buy in one transaction).
fn buy(w: &mut W, max_payout: u64) -> TxResult {
    let mut ixs = refreshes(&w.on);
    ixs.push(buy_ix(w, ticker("ONyc"), GROUP, max_payout, w.on.obligation, RESERVE_ONYC, w.on.reserve_usdc));
    let b = w.buyer.insecure_clone();
    w.env.send(&ixs, &[&b])
}

fn ok_tx(r: TxResult) -> litesvm::types::TransactionMetadata {
    r.unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs))
}

fn snapshot_ix(keeper: &Pubkey, t: Ticker, id: u32) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SnapshotClose { ticker: t, closure_id: id }.data(),
        acc::SnapshotClose {
            caller: *keeper,
            config: config_pda(),
            asset: asset_pda(&t),
            epoch: epoch_pda(&t, id),
            mint: ONYC_MINT,
            price: SCOPE_PRICES,
            xcheck: None,
        }
        .to_account_metas(None),
    )
}

fn post_ix(keeper: &Pubkey, t: Ticker, id: u32) -> Instruction {
    let mut metas =
        acc::PostSettlement { keeper: *keeper, config: config_pda(), asset: asset_pda(&t), epoch: epoch_pda(&t, id), mint: ONYC_MINT, xcheck: None }
            .to_account_metas(None);
    metas.push(AccountMeta::new_readonly(SCOPE_PRICES, false));
    Instruction::new_with_bytes(credence_core::ID, &ix::PostSettlement { ticker: t, closure_id: id }.data(), metas)
}

fn settle_nav_ix(w: &W, policy: Pubkey) -> Instruction {
    let p: Policy = w.env.anchor(&policy);
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SettlePolicy {}.data(),
        acc::SettlePolicy {
            caller: w.buyer.pubkey(),
            config: config_pda(),
            epoch: p.epoch,
            policy,
            loss: loss_pda(w.env.anchor::<Epoch>(&p.epoch).closure_id),
            vault: vault_pda(),
            vault_usdc: vault_usdc_pda(),
            owner_usdc: w.buyer_usdc,
            usdc_mint: USDC_MINT,
            token_program: TOKEN_PROGRAM,
            obligation: p.obligation,
            lending_market: Some(ONRE_MARKET),
            repay_reserve: Some(w.on.reserve_usdc),
            reserve_destination_liquidity: Some(w.on.supply_vault),
            instruction_sysvar: Some(kl::INSTRUCTIONS_SYSVAR),
            obligation_farm_user_state: Some(w.on.farm_user),
            reserve_farm_state: Some(w.on.debt_farm),
            lending_market_authority: Some(lma()),
            farms_program: Some(kl::FARMS),
            klend_program: Some(KLEND),
        }
        .to_account_metas(None)
        .into_iter()
        .map(|mut m| {
            if m.pubkey == w.on.farm_user || m.pubkey == w.on.debt_farm {
                m.is_writable = true;
            }
            m
        })
        .collect(),
    )
}

/// Everything up to an open NAV closure: LP vault, ONyc registered on the OnRe market with its NAV_STRIKE set, the closure open.
fn world() -> W {
    world_cu().0
}

/// As [`world`], with the compute units of `add_nav_asset` and `open_nav_epoch`.
fn world_cu() -> (W, u64, u64) {
    let mut env = Env::real(LP);
    let (buyer, guardian) = (env.funded(), env.funded());
    let admin = env.admin.pubkey();
    let ix_ = env.ix_set_params(&admin, default_params(guardian.pubkey(), admin));
    env.send_admin(&[ix_]).unwrap();
    let on = load_onre(&mut env, &buyer.pubkey());
    let buyer_usdc = env.usdc_account(&buyer.pubkey(), 100_000 * USDC);
    // The group of the strike's date, then the asset and its schedule, joint column and NAV_STRIKE set.
    let ix_ = env.ix_open_group(&admin, GROUP);
    env.send_admin(&[ix_]).unwrap();
    let cu_add = env.send_admin(&[add_nav_ix(&admin, ticker("ONyc"), params(), anchor_ts(), DAY as u32, ONYC_MINT)]).unwrap().compute_units_consumed;
    let joint = load_json("data/nav/joint-v3.json");
    let col = json_i16(&joint["columns"][0]);
    env.upload_joint(3, &["ONyc"], &[col], 256).unwrap();
    env.compute_gap_factors("ONyc", 3, 128).unwrap();
    let set = load_json("data/nav/ONyc-NAV_STRIKE.json");
    let z = json_i16(&set["z"]);
    let (tk, s) = (ticker("ONyc"), scen_pda(&ticker("ONyc"), closure::NAV_STRIKE));
    let i = env.ix_init_scen(&admin, tk, closure::NAV_STRIKE, z.len() as u16);
    env.send_admin(&[i]).unwrap();
    for (n, c) in z.chunks(400).enumerate() {
        let i = env.ix_write_scen(&admin, s, (n * 400) as u16, c.to_vec());
        env.send_admin(&[i]).unwrap();
    }
    let i = env.ix_finalize_scen(&admin, s, asset_pda(&tk), sha256_i16(&[&z]));
    env.send_admin(&[i]).unwrap();
    let sigma: u64 = set["sigmaWad"].as_str().unwrap().parse().unwrap();
    let i = Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SetScenarioSigma { sigma_wad: sigma }.data(),
        acc::SetScenarioSigma { admin, config: config_pda(), set: s }.to_account_metas(None),
    );
    env.send_admin(&[i]).unwrap();
    let cu_open = env.send_admin(&[open_nav_ix(&admin, tk, GROUP)]).unwrap().compute_units_consumed;
    (W { env, on, buyer, buyer_usdc, guardian, admin }, cu_add, cu_open)
}

fn epoch(w: &W) -> Epoch {
    w.env.anchor(&epoch_pda(&ticker("ONyc"), GROUP))
}
fn pol(w: &W) -> Pubkey {
    policy_pda(&epoch_pda(&ticker("ONyc"), GROUP), &w.on.obligation)
}
fn tk() -> Ticker {
    ticker("ONyc")
}

/// Close stored at the strike: the lender's NAV, unchanged.
fn close_it(w: &mut W) -> u64 {
    w.env.set_time(close_ts() + 30);
    scope_at(&mut w.env, 1.0, close_ts() + 10);
    let a = w.admin;
    ok_tx(w.env.send_admin(&[snapshot_ix(&a, tk(), GROUP)])).compute_units_consumed
}

/// Settlement price at the next strike: the NAV moved by `r` (SIMULATED).
fn settle_it(w: &mut W, r: f64) -> u64 {
    w.env.set_time(open_ts() + 90);
    scope_at(&mut w.env, 1.0 + r, open_ts() + 80);
    let a = w.admin;
    ok_tx(w.env.send_admin(&[post_ix(&a, tk(), GROUP)])).compute_units_consumed
}

// -------------------------------------------------------------------------------------------------------------------
// Happy path
// -------------------------------------------------------------------------------------------------------------------

#[test]
fn nav_asset_registers_and_opens_a_closure_on_its_schedule() {
    let w = world();
    let s: NavSchedule = w.env.anchor(&nav_pda(&tk()));
    assert_eq!((s.anchor_ts, s.interval_secs, s.gated), (anchor_ts(), 86_400, 0));
    let e = epoch(&w);
    assert_eq!((e.closure_type, e.state), (closure::NAV_STRIKE, epoch_state::OPEN));
    assert_eq!((e.close, e.open, e.bell, e.sale_open), (close_ts(), open_ts(), close_ts() - 900, close_ts() - DAY));
    let a: AssetConfig = w.env.zc(&asset_pda(&tk()));
    assert_eq!((a.settle_source, a.scope_chain, a.lender, a.mint), (2, 350, 0, ONYC_MINT));
    assert!(a.gap_factors_ready());
}

#[test]
fn nav_cover_buy_settle_pays_into_the_real_obligation() {
    let mut w = world();
    let d0 = debt(&w);
    let cap = 50_000 * USDC;
    let m = ok_tx(buy(&mut w, cap));
    println!("    CU refreshes + buy_cover (NAV obligation): {}", m.compute_units_consumed);
    let p: Policy = w.env.anchor(&pol(&w));
    assert_eq!((p.max_payout, p.owner, p.side, p.state), (cap, w.buyer.pubkey(), side::DOWN, policy_state::ACTIVE));
    assert!(p.premium >= 1_000_000 && p.premium < cap / 100, "premium {}", p.premium);
    assert_eq!(epoch(&w).policy_count, 1);

    close_it(&mut w);
    // The NAV is marked down 20% at the next strike (SIMULATED): the position's D/C′ is about 0.88, so the debt is no longer covered.
    settle_it(&mut w, -0.20);
    let e = epoch(&w);
    assert_eq!(e.state, epoch_state::SETTLED);
    assert_eq!(e.close_source, 2);
    let ratio = e.settle_price_wad as f64 / e.close_price_wad as f64;
    assert!((ratio - 0.80).abs() < 1e-6, "settle/close {ratio}");

    let owner_before = w.env.token_balance(&w.buyer_usdc);
    let vault_before = w.env.token_balance(&vault_usdc_pda());
    let mut ixs = refreshes(&w.on);
    ixs.push(settle_nav_ix(&w, pol(&w)));
    let b = w.buyer.insecure_clone();
    let m = ok_tx(w.env.send(&ixs, &[&b]));
    println!("    CU refreshes + settle_policy (NAV obligation): {}", m.compute_units_consumed);
    let want = payout_into_obligation(&w.env, &pol(&w));
    let p: Policy = w.env.anchor(&pol(&w));
    assert_eq!(p.state, policy_state::SETTLED);
    assert_eq!(p.payout, want);
    assert!(want > 0 && want <= cap, "payout {want}");
    // The payout repaid the obligation through klend (it went to the debt, not to the wallet).
    let d1 = debt(&w);
    assert!(d1 + want / 2 < d0, "debt {d0} -> {d1}, payout {want}");
    assert_eq!(w.env.token_balance(&w.buyer_usdc), owner_before, "INV-7: nothing paid to the wallet while klend still holds the debt");
    assert_eq!(vault_before - w.env.token_balance(&vault_usdc_pda()), want);
    assert_eq!(w.env.anchor::<LossVector>(&loss_pda(GROUP)).settled, 1);
}

#[test]
fn nav_no_gap_pays_nothing() {
    let mut w = world();
    ok_tx(buy(&mut w, 50_000 * USDC));
    close_it(&mut w);
    settle_it(&mut w, 0.0009); // the NAV rose, as it has every day in the sample
    let mut ixs = refreshes(&w.on);
    ixs.push(settle_nav_ix(&w, pol(&w)));
    let b = w.buyer.insecure_clone();
    let d0 = debt(&w);
    ok_tx(w.env.send(&ixs, &[&b]));
    assert_eq!(w.env.anchor::<Policy>(&pol(&w)).payout, 0);
    assert!(debt(&w) >= d0, "no repayment (accrual only)");
}

// -------------------------------------------------------------------------------------------------------------------
// Attack tests
// -------------------------------------------------------------------------------------------------------------------

/// A wrong strike: a date off the schedule opens nothing; a close cannot be stored before the strike or from a NAV read at another
/// time; a settlement cannot be stored before its window or from a NAV read outside it.
#[test]
fn d4_wrong_strike() {
    let mut w = world();
    let a = w.admin;
    // Off the schedule: a two-day schedule has no strike on the odd dates.
    let mut env2 = Env::real(LP);
    let adm = env2.admin.pubkey();
    let i = env2.ix_open_group(&adm, 20261012);
    env2.send_admin(&[i]).unwrap();
    load_onre(&mut env2, &Keypair::new().pubkey());
    env2.send_admin(&[add_nav_ix(&adm, tk(), params(), anchor_ts(), 2 * DAY as u32, ONYC_MINT)]).unwrap();
    assert_err(env2.send_admin(&[open_nav_ix(&adm, tk(), 20261012)]), code(CoreError::NotAStrike)); // Oct 12 is 11 days from Oct 1
    // Before the anchor, a date that does not exist, and a date whose bell has passed.
    let i = w.env.ix_open_group(&a, 20250101);
    w.env.send_admin(&[i]).unwrap();
    assert_err(w.env.send_admin(&[open_nav_ix(&a, tk(), 20250101)]), code(CoreError::NotAStrike));
    let i = w.env.ix_open_group(&a, 20261012);
    w.env.send_admin(&[i]).unwrap();
    w.env.set_time(open_ts() - 100);
    assert_err(w.env.send_admin(&[open_nav_ix(&a, tk(), 20261012)]), code(CoreError::SalesClosed)); // Oct 12's bell is Oct 11 23:45

    // The close: before the strike, then from a NAV read an hour before it.
    w.env.set_time(close_ts() - 10);
    scope_at(&mut w.env, 1.0, close_ts() - 20);
    assert_err(w.env.send_admin(&[snapshot_ix(&a, tk(), GROUP)]), code(CoreError::TooEarly));
    w.env.set_time(close_ts() + 30);
    scope_at(&mut w.env, 1.0, close_ts() - 3600);
    assert_err(w.env.send_admin(&[snapshot_ix(&a, tk(), GROUP)]), code(CoreError::PriceOutsideWindow));
    // A non-keeper cannot store it at the right moment either.
    scope_at(&mut w.env, 1.0, close_ts() + 10);
    let mallory = w.env.funded();
    assert_err(w.env.send(&[snapshot_ix(&mallory.pubkey(), tk(), GROUP)], &[&mallory]), code(CoreError::Unauthorized));
    ok_tx(w.env.send_admin(&[snapshot_ix(&a, tk(), GROUP)]));

    // The settlement: before its window, from a NAV read before it, then at the next-next strike (outside).
    w.env.set_time(open_ts() + 30);
    scope_at(&mut w.env, 0.9, open_ts() + 20);
    assert_err(w.env.send_admin(&[post_ix(&a, tk(), GROUP)]), code(CoreError::TooEarly));
    w.env.set_time(open_ts() + 90);
    scope_at(&mut w.env, 0.9, open_ts() + 20);
    assert_err(w.env.send_admin(&[post_ix(&a, tk(), GROUP)]), code(CoreError::PriceOutsideWindow));
    assert_err(w.env.send(&[post_ix(&mallory.pubkey(), tk(), GROUP)], &[&mallory]), code(CoreError::Unauthorized));
    assert_eq!(epoch(&w).state, epoch_state::CLOSED, "no refused call changed the epoch");
}

/// Stale NAV: the lender's NAV was not refreshed around the strike. No close is stored; after `VOID_AFTER` anyone voids the closure
/// and the premium comes back.
#[test]
fn d4_stale_nav() {
    let mut w = world();
    ok_tx(buy(&mut w, 50_000 * USDC));
    let paid = w.env.anchor::<Policy>(&pol(&w)).premium;
    // The NAV stays at its snapshot time (a day before the strike).
    w.env.set_time(close_ts() + 600);
    scope_at(&mut w.env, 1.0, close_ts() - DAY);
    let a = w.admin;
    assert_err(w.env.send_admin(&[snapshot_ix(&a, tk(), GROUP)]), code(CoreError::PriceOutsideWindow));
    let anyone = w.env.funded();
    assert_err(w.env.send(&[w.env.ix_void_epoch(&anyone.pubkey(), tk(), GROUP)], &[&anyone]), code(CoreError::TooEarly));
    w.env.set_time(close_ts() + VOID_AFTER_SECS);
    ok_tx(w.env.send(&[w.env.ix_void_epoch(&anyone.pubkey(), tk(), GROUP)], &[&anyone]));
    assert_eq!(epoch(&w).state, epoch_state::VOIDED);
    let before = w.env.token_balance(&w.buyer_usdc);
    ok_tx(w.env.send(&[w.env.ix_refund(&anyone.pubkey(), pol(&w), w.buyer_usdc)], &[&anyone]));
    assert_eq!(w.env.token_balance(&w.buyer_usdc) - before, paid, "the premium is refunded (fee 0)");
    assert_eq!(w.env.anchor::<Policy>(&pol(&w)).state, policy_state::REFUNDED);
}
const VOID_AFTER_SECS: i64 = 6 * 3600;

/// A halted fund: no valid NAV in the settlement window. The keeper cannot halt before the window ends, the calendar halt refuses a NAV
/// closure, the NAV halt moves the window one interval, and the closure settles at the following strike on the same close.
#[test]
fn d4_halted_fund() {
    let mut w = world();
    ok_tx(buy(&mut w, 50_000 * USDC));
    close_it(&mut w);
    let a = w.admin;
    // Inside the window, early: refused.
    w.env.set_time(open_ts() + 200);
    assert_err(w.env.send_admin(&[halt_nav_ix(&a, tk(), GROUP)]), code(CoreError::TooEarly));
    // The calendar halt would look for the next exchange session: refused for a NAV closure.
    let cal = Instruction::new_with_bytes(
        credence_core::ID,
        &ix::HaltEpoch { ticker: tk(), closure_id: GROUP }.data(),
        acc::HaltEpoch { keeper: a, config: config_pda(), asset: asset_pda(&tk()), epoch: epoch_pda(&tk(), GROUP), calendar: calendar_pda() }
            .to_account_metas(None),
    );
    w.env.set_time(open_ts() + 60 + 301 + 5);
    assert_err(w.env.send_admin(&[cal]), code(CoreError::UnsupportedClosure));
    // Not the keeper.
    let mallory = w.env.funded();
    assert_err(w.env.send(&[halt_nav_ix(&mallory.pubkey(), tk(), GROUP)], &[&mallory]), code(CoreError::Unauthorized));
    // After the window: halted, the window moves one interval.
    ok_tx(w.env.send_admin(&[halt_nav_ix(&a, tk(), GROUP)]));
    let e = epoch(&w);
    assert_eq!((e.state, e.open, e.settle_after), (epoch_state::HALTED, open_ts() + DAY, open_ts() + DAY + 300));
    // Halting twice in the same window: refused (the new window has not passed).
    assert_err(w.env.send_admin(&[halt_nav_ix(&a, tk(), GROUP)]), code(CoreError::TooEarly));
    // The old window is closed: a NAV read there no longer settles it.
    scope_at(&mut w.env, 0.8, open_ts() + 80);
    assert_err(w.env.send_admin(&[post_ix(&a, tk(), GROUP)]), code(CoreError::TooEarly));
    // At the next strike's window it settles, on the original close.
    w.env.set_time(open_ts() + DAY + 90);
    scope_at(&mut w.env, 0.8, open_ts() + DAY + 80);
    ok_tx(w.env.send_admin(&[post_ix(&a, tk(), GROUP)]));
    let e = epoch(&w);
    assert_eq!(e.state, epoch_state::SETTLED);
    assert!((e.settle_price_wad as f64 / e.close_price_wad as f64 - 0.8).abs() < 1e-6);
}

/// The redemption gate: the guardian closes it; no new closure opens; only the admin reopens; a stranger can do none of it.
#[test]
fn d4_redemption_gate() {
    let mut w = world();
    let (a, g) = (w.admin, w.guardian.insecure_clone());
    let mallory = w.env.funded();
    assert_err(w.env.send(&[gate_ix(&mallory.pubkey(), tk(), true)], &[&mallory]), code(CoreError::Unauthorized));
    ok_tx(w.env.send(&[gate_ix(&g.pubkey(), tk(), true)], &[&g]));
    assert_eq!(w.env.anchor::<NavSchedule>(&nav_pda(&tk())).gated, 1);
    // No new closure while gated (the next strike's group exists, its bell is ahead).
    let i = w.env.ix_open_group(&a, 20261012);
    w.env.send_admin(&[i]).unwrap();
    w.env.set_time(close_ts() - 3600);
    assert_err(w.env.send_admin(&[open_nav_ix(&a, tk(), 20261012)]), code(CoreError::NavGated));
    // The guardian cannot reopen; a stranger cannot; the admin can, and the closure opens.
    assert_err(w.env.send(&[gate_ix(&g.pubkey(), tk(), false)], &[&g]), code(CoreError::Unauthorized));
    assert_err(w.env.send(&[gate_ix(&mallory.pubkey(), tk(), false)], &[&mallory]), code(CoreError::Unauthorized));
    ok_tx(w.env.send_admin(&[gate_ix(&a, tk(), false)]));
    ok_tx(w.env.send_admin(&[open_nav_ix(&a, tk(), 20261012)]));
    // The admin may also close the gate.
    ok_tx(w.env.send_admin(&[gate_ix(&a, tk(), true)]));
    assert_eq!(w.env.anchor::<NavSchedule>(&nav_pda(&tk())).gated, 1);
}

/// Stopping sales: the guardian ends the sale of an open closure; a purchase after is refused; a policy sold before settles as usual.
#[test]
fn d4_stop_sales() {
    let g_world = |buy_first: bool| {
        let mut w = world();
        if buy_first {
            ok_tx(buy(&mut w, 20_000 * USDC));
        }
        w
    };
    // Stop, then buy: refused.
    let mut w = g_world(false);
    let (a, g) = (w.admin, w.guardian.insecure_clone());
    let mallory = w.env.funded();
    assert_err(w.env.send(&[stop_ix(&mallory.pubkey(), tk(), GROUP)], &[&mallory]), code(CoreError::Unauthorized));
    w.env.set_time(w.env.now() + 1);
    ok_tx(w.env.send(&[stop_ix(&g.pubkey(), tk(), GROUP)], &[&g]));
    assert_eq!(epoch(&w).bell, w.env.now());
    let now = w.env.now();
    scope_at(&mut w.env, 1.0, now);
    assert_err(buy(&mut w, 20_000 * USDC), code(CoreError::SalesClosed));
    assert_err(w.env.send(&[stop_ix(&g.pubkey(), tk(), GROUP)], &[&g]), code(CoreError::SalesClosed)); // the bell has passed
    // An exchange epoch is not stoppable here.
    assert_err(w.env.send_admin(&[stop_ix(&a, ticker("SPYx"), GROUP_OCT9)]), code(CoreError::WrongEpochState));

    // Buy, then stop: the policy settles.
    let mut w = g_world(true);
    w.env.set_time(w.env.now() + 1);
    let g = w.guardian.insecure_clone();
    ok_tx(w.env.send(&[stop_ix(&g.pubkey(), tk(), GROUP)], &[&g]));
    close_it(&mut w);
    settle_it(&mut w, -0.2);
    let mut ixs = refreshes(&w.on);
    ixs.push(settle_nav_ix(&w, pol(&w)));
    let b = w.buyer.insecure_clone();
    ok_tx(w.env.send(&ixs, &[&b]));
    assert!(w.env.anchor::<Policy>(&pol(&w)).payout > 0);
}

/// The Shield does not apply to a NAV closure: there is no second price to act on.
#[test]
fn d4_shield_refused() {
    let mut w = world();
    ok_tx(buy(&mut w, 20_000 * USDC));
    let policy = pol(&w);
    let p: Policy = w.env.anchor(&policy);
    let px = w.env.put_price(&Px::new([9; 32], 1.0, 1));
    let i = Instruction::new_with_bytes(
        credence_core::ID,
        &ix::ShieldAdvance {}.data(),
        acc::ShieldAdvance {
            keeper: w.admin,
            config: config_pda(),
            asset: asset_pda(&tk()),
            epoch: p.epoch,
            policy,
            loss: loss_pda(GROUP),
            vault: vault_pda(),
            vault_usdc: vault_usdc_pda(),
            usdc_mint: USDC_MINT,
            token_program: TOKEN_PROGRAM,
            price_update: px,
            obligation: w.on.obligation,
            lending_market: ONRE_MARKET,
            repay_reserve: w.on.reserve_usdc,
            reserve_destination_liquidity: w.on.supply_vault,
            instruction_sysvar: kl::INSTRUCTIONS_SYSVAR,
            obligation_farm_user_state: w.on.farm_user,
            reserve_farm_state: w.on.debt_farm,
            lending_market_authority: lma(),
            farms_program: kl::FARMS,
            klend_program: KLEND,
        }
        .to_account_metas(None),
    );
    // Shield on in the config, so the refusal is the closure's and not "shield off".
    let a = w.admin;
    let ix_ = w.env.ix_set_params(&a, shield_params(w.guardian.pubkey(), a));
    w.env.send_admin(&[ix_]).unwrap();
    assert_err(w.env.send_admin(&[i]), code(CoreError::UnsupportedClosure));
}

/// A market keeps its own assets: an xStock cannot be covered on an OnRe obligation, nor ONyc on an xStocks one; ONyc epochs price only
/// on the NAV_STRIKE set.
#[test]
fn d4_market_isolation() {
    let mut w = world();
    let b = w.buyer.insecure_clone();
    // SPYx's next weekend (Oct 16) on sale from Monday Oct 12, with the ONyc obligation and reserves: the deposit reserve is not SPYx's.
    let adm = w.admin;
    let i = w.env.ix_open_group(&adm, 20261016);
    w.env.send_admin(&[i]).unwrap();
    let i = w.env.ix_open_epoch(&adm, ticker("SPYx"), 20261016);
    w.env.send_admin(&[i]).unwrap();
    w.env.set_time(OCT8_NOON_ET + 5 * DAY);
    scope_at(&mut w.env, 1.0, OCT8_NOON_ET + 5 * DAY - 5);
    let mut ixs = refreshes(&w.on);
    ixs.push(buy_ix(&w, ticker("SPYx"), 20261016, 10_000 * USDC, w.on.obligation, RESERVE_ONYC, w.on.reserve_usdc));
    assert_err(w.env.send(&ixs, &[&b]), code(CoreError::UnsupportedObligation));
    // ONyc's epoch with an xStocks reserve pair: not the NAV market's reserves.
    w.env.set_time(close_ts() - 3600);
    scope_at(&mut w.env, 1.0, close_ts() - 3605);
    let mut ixs = refreshes(&w.on);
    ixs.push(buy_ix(&w, tk(), GROUP, 10_000 * USDC, w.on.obligation, RESERVE_SPYX, w.on.reserve_usdc));
    assert_err(w.env.send(&ixs, &[&b]), code(CoreError::UnsupportedObligation));
    // Wrong scenario set: ONyc's epoch with its (unrelated) WEEKEND PDA.
    let mut bad = buy_ix(&w, tk(), GROUP, 10_000 * USDC, w.on.obligation, RESERVE_ONYC, w.on.reserve_usdc);
    bad.accounts[3].pubkey = scen_pda(&tk(), closure::WEEKEND); // the `scenarios` account
    let mut ixs = refreshes(&w.on);
    ixs.push(bad);
    assert!(w.env.send(&ixs, &[&b]).is_err());
    // Someone else's obligation: only the owner buys.
    let mallory = w.env.funded();
    let mut d = w.env.data(&w.on.obligation);
    ob::put(&mut d, ob::OB_OWNER, mallory.pubkey().as_ref());
    w.env.put_klend(w.on.obligation, d);
    assert_err(buy(&mut w, 10_000 * USDC), code(CoreError::NotObligationOwner));
}

/// Registration is the admin's, Scope-priced only, with a whole-day schedule and a classic SPL mint.
#[test]
fn d4_registration_failures() {
    let mut env = Env::real(0);
    let a = env.admin.pubkey();
    load_onre(&mut env, &Keypair::new().pubkey());
    let t = tk();
    let mallory = env.funded();
    assert_err(env.send(&[add_nav_ix(&mallory.pubkey(), t, params(), anchor_ts(), 86_400, ONYC_MINT)], &[&mallory]), code(CoreError::Unauthorized));
    let bad = |f: fn(&mut AssetParams)| {
        let mut p = params();
        f(&mut p);
        p
    };
    let sources = [credence_core::oracle::source::EQUITY, credence_core::oracle::source::XSTOCK, credence_core::oracle::source::JUPITER];
    for s in sources {
        let mut p = params();
        p.settle_source = s;
        assert_err(env.send_admin(&[add_nav_ix(&a, t, p, anchor_ts(), 86_400, ONYC_MINT)]), code(CoreError::InvalidParam));
    }
    for p in [
        bad(|p| p.kamino_reserves = [Pubkey::default(), Pubkey::default()]),
        bad(|p| p.kamino_reserves[1] = Pubkey::new_unique()),
        bad(|p| p.feed_equity = [1; 32]),
        bad(|p| p.feed_xstock = [1; 32]),
        bad(|p| p.sigma_wad = 0),
    ] {
        assert_err(env.send_admin(&[add_nav_ix(&a, t, p, anchor_ts(), 86_400, ONYC_MINT)]), code(CoreError::InvalidParam));
    }
    for (anchor, interval) in [(anchor_ts(), 3_600), (anchor_ts(), 86_400 + 1), (anchor_ts(), 8 * 86_400), (anchor_ts(), 0), (0, 86_400)] {
        assert_err(env.send_admin(&[add_nav_ix(&a, t, params(), anchor, interval, ONYC_MINT)]), code(CoreError::InvalidParam));
    }
    // A Token-2022 xStock mint is not a classic SPL mint.
    assert_fails(env.send_admin(&[add_nav_ix(&a, t, params(), anchor_ts(), 86_400, SPYX_MINT)]));
    env.send_admin(&[add_nav_ix(&a, t, params(), anchor_ts(), 86_400, ONYC_MINT)]).unwrap();
    assert_fails(env.send_admin(&[add_nav_ix(&a, t, params(), anchor_ts(), 86_400, ONYC_MINT)])); // twice
}

#[test]
fn nav_compute_units() {
    let (mut w, cu_add, cu_open) = world_cu();
    let m = ok_tx(buy(&mut w, 50_000 * USDC));
    let cu_snap = close_it(&mut w);
    let cu_post = settle_it(&mut w, -0.2);
    let mut ixs = refreshes(&w.on);
    ixs.push(settle_nav_ix(&w, pol(&w)));
    let b = w.buyer.insecure_clone();
    let cu_settle = ok_tx(w.env.send(&ixs, &[&b])).compute_units_consumed;
    println!(
        "    CU add_nav_asset {cu_add}, open_nav_epoch {cu_open}, refreshes + buy_cover {}, snapshot_close {cu_snap}, post_settlement {cu_post}, refreshes + settle_policy {cu_settle}",
        m.compute_units_consumed
    );
    assert!(cu_add < 100_000 && cu_open < 40_000 && cu_snap < 60_000 && cu_post < 60_000);
    assert!(m.compute_units_consumed < 900_000 && cu_settle < 900_000);
}
