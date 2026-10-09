//! W12: Jupiter Lend cover with the real Jupiter Lend binaries (Vaults, Liquidity, Oracle) and a one-slot snapshot of
//! a real SPYx/USDC position of vault 78 (`common::jl`). The alias asset `SPYx.J` (SPYx's scenarios and joint column,
//! settled on Jupiter's Chainlink cache) covers it: `buy_cover_jl` (golden against `jl_snapshot` and the pricing
//! functions), the JUPITER settlement source, `shield_advance_jl` and `settle_policy_jl` paying back through a real
//! `operate` CPI signed by the vault PDA, the wallet path, and one failure test per check.
//!
//! The `operate` accounts depend on the amount, so the fixtures carry them for two amounts: the shield's α × cap
//! (1,000 USDC on a 2,000 cap) and a 3,000 USDC settlement, whose Monday price the test solves for exactly.

mod common;

use anchor_lang::{prelude::Pubkey, solana_program::instruction::{AccountMeta, Instruction}, AnchorDeserialize, InstructionData, ToAccountMetas};
use common::*;
use credence_core::instructions::jupiter_lend::{jl_snapshot, JlSnapshot, JL_DEBT_BUFFER_BPS};
use credence_core::jupiter::{PositionView, VaultStateView};
use credence_core::{accounts as acc, instruction as ix, pricing, state::*, CoreError};
use solana_keypair::Keypair;
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000;
const T: &str = "SPYx.J";
const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;
const WINDOW_START: i64 = OCT12_OPEN - 48_600;
const CAP_SHIELD: u64 = 2_000_000_000;

struct W {
    env: Env,
    snap: serde_json::Value,
    buyer: Keypair,
    buyer_usdc: Pubkey,
    position: Pubkey,
    cache: Pubkey,
    vault_config: Pubkey,
    vault_state: Pubkey,
    tick: Pubkey,
    alt: Pubkey,
    lt_permille: u16,
}

fn k(v: &serde_json::Value) -> Pubkey {
    jl::key(v)
}

/// Phase 1 setup with the shield on, the Jupiter snapshot, the alias asset SPYx.J (Jupiter lender, SPYx's set and joint
/// column, settle source JUPITER) with its Oct 9 epoch, the position's NFT moved to a test buyer, the vault PDA's SPYx
/// account (operate's signer needs one), and the cache priced so the position is at `ratio` = D/C′.
fn world(ratio: f64) -> W {
    let mut env = Env::real(LP);
    let a = env.admin.pubkey();
    let ix0 = env.ix_set_params(&a, shield_params(a, a));
    env.send_admin(&[ix0]).unwrap();
    let snap = env.load_jupiter();
    let (cache, vault_config, oracle) = (k(&snap["cache"]), k(&snap["vaultConfig"]), k(&snap["oracle"]));
    let mut p = real_asset_params(0);
    p.settle_source = credence_core::oracle::source::JUPITER;
    p.kamino_reserves = [Pubkey::default(); 2];
    let add = env.ix_add_asset(&a, ticker(T), SPYX_MINT, p);
    env.send_admin(&[add]).unwrap();
    let set = ix_set_asset_lender(&a, T, vault_config, oracle);
    env.send_admin(&[set]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let z = json_i16(&load_json("data/onchain/SPYx-WEEKEND.json")["z"]);
    env.upload_scenarios(T, &z, 400).unwrap();
    env.compute_gap_factors(T, 2, 128).unwrap();
    let open = env.ix_open_epoch(&a, ticker(T), GROUP_OCT9);
    env.send_admin(&[open]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let create = ix_create_ata(&a, &vault_pda(), &SPYX_MINT, &TOKEN_2022_PROGRAM);
    env.send_admin(&[create]).unwrap();

    let buyer = env.funded();
    let buyer_usdc = env.usdc_account(&buyer.pubkey(), 100_000_000_000);
    let holder = k(&snap["nftHolder"]);
    let mut acct = env.svm.get_account(&holder).unwrap();
    acct.data[32..64].copy_from_slice(buyer.pubkey().as_ref());
    env.svm.set_account(holder, acct).unwrap();
    let lt_permille = u16::from_le_bytes(env.data(&vault_config)[16..18].try_into().unwrap());
    let mut w = W {
        env,
        buyer,
        buyer_usdc,
        position: k(&snap["position"]),
        cache,
        vault_config,
        vault_state: k(&snap["vaultState"]),
        tick: k(&snap["tick"]),
        alt: k(&snap["lookupTable"]),
        lt_permille,
        snap,
    };
    let px = price_for_ratio(&w, ratio);
    let now = w.env.now();
    w.env.put_jl_cache(&w.cache, px, now);
    w
}

fn ix_set_asset_lender(admin: &Pubkey, t: &str, vault: Pubkey, oracle: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SetAssetLender { ticker: ticker(t) }.data(),
        acc::SetAssetLender { admin: *admin, config: config_pda(), asset: asset_pda(&ticker(t)), lender_vault: vault, lender_oracle_config: oracle }
            .to_account_metas(None),
    )
}

fn views(w: &W) -> (PositionView, VaultStateView) {
    let pos = PositionView::decode(&w.env.data(&w.position));
    let d = w.env.data(&w.vault_state);
    let vs = VaultStateView {
        vault_id: u16::from_le_bytes(d[8..10].try_into().unwrap()),
        supply_exchange_price: u64::from_le_bytes(d[99..107].try_into().unwrap()),
        borrow_exchange_price: u64::from_le_bytes(d[107..115].try_into().unwrap()),
    };
    (pos, vs)
}

/// The cache price (WAD) at which the position's D/C′ (with the buffer) is `ratio`.
fn price_for_ratio(w: &W, ratio: f64) -> u128 {
    let (pos, vs) = views(w);
    let s = jl_snapshot(&pos, &vs, w.lt_permille, 1_000 * WAD as u128).unwrap(); // at $1,000
    (1_000.0 * WAD as f64 * s.debt as f64 / (ratio * s.covered_value as f64)) as u128
}

fn snap_now(w: &W) -> JlSnapshot {
    let (pos, vs) = views(w);
    let d = w.env.data(&w.cache);
    let o = jl::cache_price_offset(&d);
    jl_snapshot(&pos, &vs, w.lt_permille, u128::from_le_bytes(d[o..o + 16].try_into().unwrap())).unwrap()
}

fn ix_buy(w: &W, buyer: &Keypair, buyer_usdc: Pubkey, max_payout: u64, max_premium: u64) -> Instruction {
    ix_buy_at(w, buyer, buyer_usdc, max_payout, max_premium, GROUP_OCT9)
}

fn ix_buy_at(w: &W, buyer: &Keypair, buyer_usdc: Pubkey, max_payout: u64, max_premium: u64, closure_id: u32) -> Instruction {
    let epoch = epoch_pda(&ticker(T), closure_id);
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::BuyCoverJl { ticker: ticker(T), closure_id, max_payout, max_premium }.data(),
        acc::BuyCoverJl {
            buyer: buyer.pubkey(),
            config: config_pda(),
            asset: asset_pda(&ticker(T)),
            scenarios: scen_pda(&ticker(T), closure::WEEKEND),
            epoch,
            loss: loss_pda(closure_id),
            vault: vault_pda(),
            vault_usdc: vault_usdc_pda(),
            share_mint: shares_pda(),
            fee_account: w.env.anchor::<Vault>(&vault_pda()).fee_account,
            buyer_usdc,
            position: w.position,
            position_token_account: k(&w.snap["nftHolder"]),
            vault_config: w.vault_config,
            vault_state: w.vault_state,
            position_tick: w.tick,
            cache: w.cache,
            policy: policy_pda(&epoch, &w.position),
            token_program: TOKEN_PROGRAM,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn policy_key(w: &W) -> Pubkey {
    policy_pda(&epoch_pda(&ticker(T), GROUP_OCT9), &w.position)
}

fn buy(w: &mut W, cap: u64) -> TxResult {
    let b = w.buyer.insecure_clone();
    let ix = ix_buy(w, &b, w.buyer_usdc, cap, u64::MAX);
    w.env.send(&[ix], &[&b])
}

/// operate's accounts from the fixture plan (`shield` or `settle`), with the program's checks' expectations.
fn plan(w: &W, name: &str) -> (Vec<AccountMeta>, Vec<u8>) {
    let p = &w.snap["plans"][name];
    let metas = p["metas"].as_array().unwrap().iter().map(|m| AccountMeta { pubkey: k(&m["pubkey"]), is_signer: false, is_writable: m["writable"].as_bool().unwrap() }).collect();
    let indices = p["indices"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
    (metas, indices)
}

fn ix_settle(w: &W, caller: &Pubkey, expected: u64, plan_name: &str, owner_usdc: Pubkey) -> Instruction {
    let p: Policy = w.env.anchor(&policy_key(w));
    let (metas, indices) = plan(w, plan_name);
    let mut accounts = acc::SettlePolicyJl {
        caller: *caller,
        config: config_pda(),
        epoch: p.epoch,
        policy: policy_key(w),
        loss: loss_pda(GROUP_OCT9),
        vault: vault_pda(),
        vault_usdc: vault_usdc_pda(),
        owner_usdc,
        token_program: TOKEN_PROGRAM,
        jl_vaults: jl::VAULTS,
    }
    .to_account_metas(None);
    accounts.extend(metas);
    Instruction::new_with_bytes(credence_core::ID, &ix::SettlePolicyJl { expected, indices }.data(), accounts)
}

fn ix_shield(w: &W, keeper: &Pubkey, expected: u64, push: Pubkey) -> Instruction {
    let p: Policy = w.env.anchor(&policy_key(w));
    let (metas, indices) = plan(w, "shield");
    let mut accounts = acc::ShieldAdvanceJl {
        keeper: *keeper,
        config: config_pda(),
        asset: asset_pda(&ticker(T)),
        epoch: p.epoch,
        policy: policy_key(w),
        loss: loss_pda(GROUP_OCT9),
        vault: vault_pda(),
        vault_usdc: vault_usdc_pda(),
        price_update: push,
        jl_vaults: jl::VAULTS,
    }
    .to_account_metas(None);
    accounts.extend(metas);
    Instruction::new_with_bytes(credence_core::ID, &ix::ShieldAdvanceJl { expected, indices }.data(), accounts)
}

fn ix_snapshot_jl(w: &W, price: Pubkey) -> Instruction {
    let a = w.env.admin.pubkey();
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SnapshotClose { ticker: ticker(T), closure_id: GROUP_OCT9 }.data(),
        acc::SnapshotClose { caller: a, config: config_pda(), asset: asset_pda(&ticker(T)), epoch: epoch_pda(&ticker(T), GROUP_OCT9), mint: SPYX_MINT, price, xcheck: None }
            .to_account_metas(None),
    )
}

fn ix_post_jl(w: &W, price: Pubkey) -> Instruction {
    let a = w.env.admin.pubkey();
    let mut metas = acc::PostSettlement { keeper: a, config: config_pda(), asset: asset_pda(&ticker(T)), epoch: epoch_pda(&ticker(T), GROUP_OCT9), mint: SPYX_MINT, xcheck: None }
        .to_account_metas(None);
    metas.push(AccountMeta::new_readonly(price, false));
    Instruction::new_with_bytes(credence_core::ID, &ix::PostSettlement { ticker: ticker(T), closure_id: GROUP_OCT9 }.data(), metas)
}

fn cache_price(w: &W) -> u128 {
    let d = w.env.data(&w.cache);
    let o = jl::cache_price_offset(&d);
    u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
}

/// Friday close from Jupiter's cache (its price, refreshed 20 s before the close + 30 s clock).
fn close(w: &mut W) {
    let px = cache_price(w);
    w.env.set_time(OCT9_CLOSE + 30);
    let c = w.cache;
    w.env.put_jl_cache(&c, px, OCT9_CLOSE - 20);
    let ix = ix_snapshot_jl(w, c);
    w.env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
}

/// Monday: the cache at `price_wad`, refreshed in the settlement window; post_settlement.
fn open(w: &mut W, price_wad: u128) {
    w.env.set_time(OCT12_OPEN + 75);
    let c = w.cache;
    w.env.put_jl_cache(&c, price_wad, OCT12_OPEN + 70);
    let ix = ix_post_jl(w, c);
    w.env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
}

fn debt_raw_now(w: &W) -> u128 {
    let pos = PositionView::decode(&w.env.data(&w.position));
    credence_risk_core::fluid::debt_raw(pos.supply_raw, pos.tick).unwrap()
}

fn program_cu(logs: &[String]) -> u64 {
    let id = credence_core::ID.to_string();
    logs.iter().filter_map(|l| l.strip_prefix(&format!("Program {id} consumed "))).filter_map(|r| r.split(' ').next()?.parse().ok()).max().unwrap_or(0)
}

fn err_is(r: TxResult, e: CoreError) {
    let s = format!("{:?}", r.unwrap_err().err);
    assert!(s.contains(&code(e).to_string()), "want {e:?}: {s}");
}

/// The purchase: the snapshot is `jl_snapshot` on the position, the vault's exchange prices and the cache (debt from
/// the tick with the 1% buffer, C′ at the vault's LT), and the premium is the single-asset quote plus the shield loading
/// on it, as `buy_cover` prices a Kamino position. CU printed for plan/09.
#[test]
fn buy_cover_jl_golden() {
    let mut w = world(0.93);
    let want = snap_now(&w);
    let r = buy(&mut w, want.debt).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("buy_cover_jl: program {} CU, transaction {} CU", program_cu(&r.logs), r.compute_units_consumed);
    let p: Policy = w.env.anchor(&policy_key(&w));
    assert_eq!((p.covered_value, p.debt, p.collateral_value), (want.covered_value, want.debt, want.collateral_value));
    assert_eq!(p.lender, lender::JUPITER);
    assert_eq!(p.obligation, w.position);
    assert_eq!(p.borrow_reserve, w.vault_config);
    // Debt: Fluid's gross debt from the tick, +1%.
    let (pos, vs) = views(&w);
    let raw = credence_risk_core::fluid::raw_to_tokens(credence_risk_core::fluid::debt_raw(pos.supply_raw, pos.tick).unwrap(), vs.borrow_exchange_price, 6, true).unwrap();
    assert_eq!(p.debt, (raw as u128 * (10_000 + JL_DEBT_BUFFER_BPS as u128)).div_ceil(10_000) as u64);
    println!("position: {} USDC debt (+1% buffer {}), C′ {}, D/C′ {:.4}", raw, p.debt, p.covered_value, p.debt as f64 / p.covered_value as f64);
    // Premium against the host pricing on the same inputs.
    let c: Config = w.env.anchor(&config_pda());
    let a: AssetConfig = w.env.zc(&asset_pda(&ticker(T)));
    let s: ScenarioSet = w.env.zc(&scen_pda(&ticker(T), closure::WEEKEND));
    let ev = r.logs.iter().find_map(|l| l.strip_prefix("Program data: ")).and_then(|b| {
        use base64::Engine;
        let d = base64::engine::general_purpose::STANDARD.decode(b).ok()?;
        credence_core::instructions::cover::CoverBought::deserialize(&mut &d[8..]).ok()
    }).unwrap();
    let xp = pricing::CoverInputs { covered_value: p.covered_value, debt: pricing::priced_debt(p.debt, &c).unwrap(), max_payout: p.max_payout };
    let z = &s.z[..s.n as usize];
    let prem = pricing::premium(z, &c, a.sigma_wad, a.dividend_wad, 3, ev.util_after_wad, &xp).unwrap() + pricing::shield_loading(z, &c, a.sigma_wad, a.basis_sigma_wad, &xp, p.worst_loss).unwrap();
    assert_eq!(p.premium, prem);
    // SPYx.J nets with SPYx in the Oct 9 group: one loss vector.
    let l: LossVector = w.env.zc(&loss_pda(GROUP_OCT9));
    assert_eq!(l.max_loss, p.worst_loss);
}

/// The Liquidation Shield on the Jupiter position: Sunday night the SPYx fair value is −30%; the target is α × cap
/// (1,000 USDC on a 2,000 cap); `expected = u64::MAX` only returns it; then a real `operate` CPI signed by the vault
/// PDA pays it back: the position's debt falls, the vault pays exactly the advance, the owner's wallet is untouched
/// (INV-11), INV-9 and INV-12 hold.
#[test]
fn shield_advance_jl_pays_back_through_operate() {
    // Near the threshold, so the reserved worst loss (INV-12's cap) exceeds α × cap on this 13k-debt position.
    let mut w = world(0.985);
    buy(&mut w, CAP_SHIELD).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    close(&mut w);
    let at = WINDOW_START + 3_600;
    w.env.set_time(at);
    let a: AssetConfig = w.env.zc(&asset_pda(&ticker(T)));
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker(T), GROUP_OCT9));
    let push = w.env.put_push(&Px::new(a.feed_xstock, e.close_price_wad as f64 / 1e18 * 0.7, at - 600));
    // Jupiter's oracle refuses a stale cache in any operate, a payback included (PRICE_TOO_OLD, found here): the
    // shield works on a weekend only while Jupiter's keepers refresh the cache (the close price, refreshed now). Whether
    // they do over a real weekend: keeper/src/jl-oracle-record.ts, plan/09.
    let (c, px) = (w.cache, cache_price(&w));
    w.env.put_jl_cache(&c, px, at - 30);
    let keeper = w.env.admin.insecure_clone();
    // Quote mode.
    let q = ix_shield(&w, &keeper.pubkey(), u64::MAX, push);
    let r = w.env.send_v0(&[q], &[&keeper], &[w.alt]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let add = u64::from_le_bytes(r.return_data.data[..8].try_into().unwrap());
    assert_eq!(add, CAP_SHIELD / 2, "α × cap");
    assert_eq!(w.env.anchor::<Policy>(&policy_key(&w)).advanced, 0, "quote mode changes nothing");
    // A different amount is refused.
    let bad = ix_shield(&w, &keeper.pubkey(), add - 1, push);
    err_is(w.env.send_v0(&[bad], &[&keeper], &[w.alt]), CoreError::AmountMismatch);
    let (debt0, cash0, owner0) = (debt_raw_now(&w), w.env.token_balance(&vault_usdc_pda()), w.env.token_balance(&w.buyer_usdc));
    let ix = ix_shield(&w, &keeper.pubkey(), add, push);
    let r = w.env.send_v0(&[ix], &[&keeper], &[w.alt]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("shield_advance_jl: program {} CU, transaction {} CU", program_cu(&r.logs), r.compute_units_consumed);
    let p: Policy = w.env.anchor(&policy_key(&w));
    assert_eq!(p.advanced, add);
    assert_eq!(cash0 - w.env.token_balance(&vault_usdc_pda()), add, "the vault paid exactly the advance");
    assert!(debt_raw_now(&w) < debt0, "the position's debt fell");
    assert_eq!(w.env.token_balance(&w.buyer_usdc), owner0, "INV-11: nothing to the owner's wallet");
    assert!(p.advanced as u128 <= p.max_payout as u128 / 2, "INV-9");
    let l: LossVector = w.env.zc(&loss_pda(GROUP_OCT9));
    assert!(p.advanced <= p.worst_loss && l.advanced <= l.max_loss, "INV-12");
}

/// Settlement through `operate`: the Monday price solved so the payout rule owes exactly 3,000 USDC; the CPI pays it
/// back into the position (debt down, owner's wallet untouched) and the policy settles. Quote mode first.
#[test]
fn settle_policy_jl_pays_back_into_the_position() {
    let mut w = world(0.93);
    let s0 = snap_now(&w);
    buy(&mut w, s0.debt).unwrap();
    close(&mut w);
    let p: Policy = w.env.anchor(&policy_key(&w));
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker(T), GROUP_OCT9));
    // The open price at which realized_payout(C′, D, cap, close, open) = 3,000 USDC (D unchanged: no interest here).
    let target = 3_000_000_000u64;
    let (mut lo, mut hi) = (e.close_price_wad / 2, e.close_price_wad);
    let owed = |px: u128| pricing::realized_payout(p.covered_value, p.debt, p.max_payout, e.close_price_wad, px).unwrap();
    while hi - lo > 1 {
        let m = (lo + hi) / 2;
        if owed(m) > target { lo = m } else { hi = m }
    }
    let px = if owed(hi) == target { hi } else { lo };
    assert_eq!(owed(px), target, "a price that owes exactly the planned amount");
    open(&mut w, px);
    let caller = w.env.funded();
    let q = ix_settle(&w, &caller.pubkey(), u64::MAX, "settle", w.buyer_usdc);
    let r = w.env.send_v0(&[q], &[&caller], &[w.alt]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    assert_eq!(u64::from_le_bytes(r.return_data.data[..8].try_into().unwrap()), target);
    let (debt0, cash0, owner0) = (debt_raw_now(&w), w.env.token_balance(&vault_usdc_pda()), w.env.token_balance(&w.buyer_usdc));
    let ix = ix_settle(&w, &caller.pubkey(), target, "settle", w.buyer_usdc);
    let r = w.env.send_v0(&[ix], &[&caller], &[w.alt]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("settle_policy_jl: program {} CU, transaction {} CU", program_cu(&r.logs), r.compute_units_consumed);
    let p: Policy = w.env.anchor(&policy_key(&w));
    assert_eq!((p.state, p.payout), (policy_state::SETTLED, target));
    assert_eq!(cash0 - w.env.token_balance(&vault_usdc_pda()), target);
    assert_eq!(w.env.token_balance(&w.buyer_usdc), owner0, "all into the position");
    assert!(debt_raw_now(&w) < debt0);
    let again = ix_settle(&w, &caller.pubkey(), target, "settle", w.buyer_usdc);
    assert!(w.env.send_v0(&[again], &[&caller], &[w.alt]).is_err(), "settled once");
}

/// A capped payout cannot restore the position's health, and Jupiter refuses a payback that leaves it above the
/// threshold: it goes to the owner's wallet, no CPI.
#[test]
fn settle_policy_jl_capped_pays_the_wallet() {
    let mut w = world(0.95);
    buy(&mut w, 1_000_000_000).unwrap();
    close(&mut w);
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker(T), GROUP_OCT9));
    open(&mut w, e.close_price_wad * 80 / 100);
    let caller = w.env.funded();
    let (debt0, owner0) = (debt_raw_now(&w), w.env.token_balance(&w.buyer_usdc));
    let ix = ix_settle(&w, &caller.pubkey(), 1_000_000_000, "settle", w.buyer_usdc);
    w.env.send_v0(&[ix], &[&caller], &[w.alt]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    assert_eq!(w.env.token_balance(&w.buyer_usdc) - owner0, 1_000_000_000);
    assert_eq!(debt_raw_now(&w), debt0, "no payback");
}

/// `buy_cover_jl`: one failure test per check.
#[test]
fn buy_cover_jl_failures() {
    let mut w = world(0.93);
    let d = snap_now(&w).debt;
    let b = w.buyer.insecure_clone();
    let send = |w: &mut W, ix: Instruction, s: &Keypair| { w.env.svm.expire_blockhash(); w.env.send(&[ix], &[s]) };
    // Not the NFT holder.
    let other = w.env.funded();
    let ou = w.env.usdc_account(&other.pubkey(), 1_000_000_000);
    let ix = ix_buy(&w, &other, ou, d, u64::MAX);
    err_is(send(&mut w, ix, &other), CoreError::NotObligationOwner);
    // Cap above the debt.
    let ix = ix_buy(&w, &b, w.buyer_usdc, d + 1, u64::MAX);
    err_is(send(&mut w, ix, &b), CoreError::InvalidParam);
    // Another cache than the asset's.
    let mut ix = ix_buy(&w, &b, w.buyer_usdc, d, u64::MAX);
    let i = ix.accounts.iter().position(|m| m.pubkey == w.cache).unwrap();
    ix.accounts[i].pubkey = k(&w.snap["oracle"]);
    err_is(send(&mut w, ix, &b), CoreError::InvalidParam);
    // A stale cache.
    let (c, px, now) = (w.cache, cache_price(&w), w.env.now());
    w.env.put_jl_cache(&c, px, now - 3_600);
    let ix = ix_buy(&w, &b, w.buyer_usdc, d, u64::MAX);
    err_is(send(&mut w, ix, &b), CoreError::BadPrice);
    w.env.put_jl_cache(&c, px, now);
    // Already past the threshold.
    w.env.put_jl_cache(&c, px * 80 / 100, now);
    let ix = ix_buy(&w, &b, w.buyer_usdc, d / 2, u64::MAX);
    err_is(send(&mut w, ix, &b), CoreError::AlreadyLiquidatable);
    w.env.put_jl_cache(&c, px, now);
    // A liquidated tick.
    let mut t = w.env.svm.get_account(&w.tick).unwrap();
    let saved = t.clone();
    t.data[14] = 1;
    w.env.svm.set_account(w.tick, t).unwrap();
    let ix = ix_buy(&w, &b, w.buyer_usdc, d, u64::MAX);
    err_is(send(&mut w, ix, &b), CoreError::PositionLiquidated);
    w.env.svm.set_account(w.tick, saved).unwrap();
    // Premium above the maximum.
    let ix = ix_buy(&w, &b, w.buyer_usdc, d, 1);
    err_is(send(&mut w, ix, &b), CoreError::PremiumAboveMax);
    // Everything right: bought.
    let ix = ix_buy(&w, &b, w.buyer_usdc, d, u64::MAX);
    send(&mut w, ix, &b).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
}

/// `settle_policy_jl` / `shield_advance_jl`: the pinned operate accounts and the rest of their checks.
#[test]
fn payback_failures() {
    let mut w = world(0.95);
    buy(&mut w, CAP_SHIELD).unwrap();
    let keeper = w.env.admin.insecure_clone();
    let a: AssetConfig = w.env.zc(&asset_pda(&ticker(T)));
    // Shield before the close: the epoch is not CLOSED.
    let push0 = w.env.put_push(&Px::new(a.feed_xstock, 500.0, w.env.now() - 60));
    err_is(w.env.send_v0(&[ix_shield(&w, &keeper.pubkey(), u64::MAX, push0)], &[&keeper], &[w.alt]), CoreError::WrongEpochState);
    close(&mut w);
    let at = WINDOW_START + 3_600;
    w.env.set_time(at);
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker(T), GROUP_OCT9));
    let push = w.env.put_push(&Px::new(a.feed_xstock, e.close_price_wad as f64 / 1e18 * 0.7, at - 600));
    // Not the keeper.
    let other = w.env.funded();
    err_is(w.env.send_v0(&[ix_shield(&w, &other.pubkey(), u64::MAX, push)], &[&other], &[w.alt]), CoreError::Unauthorized);
    // Pinned operate accounts: the signer slot, a recipient, the position, the vault config, the paying account.
    for (slot, with) in [(0usize, Pubkey::new_unique()), (3, keeper.pubkey()), (11, Pubkey::new_unique()), (6, Pubkey::new_unique()), (2, w.buyer_usdc)] {
        let mut ix = ix_shield(&w, &keeper.pubkey(), u64::MAX, push);
        let base = ix.accounts.len() - plan(&w, "shield").0.len();
        ix.accounts[base + slot].pubkey = with;
        err_is(w.env.send_v0(&[ix], &[&keeper], &[w.alt]), CoreError::InvalidParam);
    }
    // Outside the window.
    w.env.set_time(OCT12_OPEN - 1_000);
    err_is(w.env.send_v0(&[ix_shield(&w, &keeper.pubkey(), u64::MAX, push)], &[&keeper], &[w.alt]), CoreError::OutsideShieldWindow);
    // Settlement before the open: not SETTLED.
    let caller = w.env.funded();
    err_is(w.env.send_v0(&[ix_settle(&w, &caller.pubkey(), u64::MAX, "settle", w.buyer_usdc)], &[&caller], &[w.alt]), CoreError::WrongEpochState);
}

/// The JUPITER settlement source: the close must come from the asset's own cache, inside the window.
#[test]
fn jupiter_source_close_checks() {
    let mut w = world(0.93);
    let px = cache_price(&w);
    w.env.set_time(OCT9_CLOSE + 30);
    let c = w.cache;
    // Refreshed outside the close window.
    w.env.put_jl_cache(&c, px, OCT9_CLOSE - 3_600);
    err_is(w.env.send_admin(&[ix_snapshot_jl(&w, c)]), CoreError::PriceOutsideWindow);
    // Another account than the asset's cache.
    w.env.put_jl_cache(&c, px, OCT9_CLOSE - 20);
    w.env.svm.expire_blockhash();
    err_is(w.env.send_admin(&[ix_snapshot_jl(&w, k(&w.snap["oracle"]))]), CoreError::InvalidParam);
    w.env.svm.expire_blockhash();
    w.env.send_admin(&[ix_snapshot_jl(&w, c)]).unwrap();
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker(T), GROUP_OCT9));
    assert_eq!((e.close_price_wad, e.close_source), (px, credence_core::oracle::source::JUPITER));
}

/// `set_asset_lender`: admin only; the oracle must be the vault's.
#[test]
fn set_asset_lender_checks() {
    let mut w = world(0.93);
    let other = w.env.funded();
    let ix = ix_set_asset_lender(&other.pubkey(), T, w.vault_config, k(&w.snap["oracle"]));
    err_is(w.env.send(&[ix], &[&other]), CoreError::Unauthorized);
    // A fresh alias with another account than the vault's oracle.
    let a = w.env.admin.pubkey();
    let mut p = real_asset_params(0);
    p.settle_source = credence_core::oracle::source::JUPITER;
    let add = w.env.ix_add_asset(&a, ticker("SPYz.J"), SPYX_MINT, p);
    w.env.send_admin(&[add]).unwrap();
    let ix = ix_set_asset_lender(&a, "SPYz.J", w.vault_config, w.cache);
    err_is(w.env.send_admin(&[ix]), CoreError::JupiterLayout);
}

/// Audit A-53: a Jupiter Lend policy settles only through `settle_policy_jl` (into the position) or, after the grace
/// period, `settle_policy_to_wallet`. Kamino's `settle_policy` saw a non-klend obligation as "no longer borrows" and
/// paid the wallet at once, skipping the payback; Kamino's `shield_advance` must refuse it too.
#[test]
fn a53_kamino_paths_refuse_a_jupiter_policy() {
    let mut w = world(0.93);
    let d = snap_now(&w).debt;
    buy(&mut w, d).unwrap();
    close(&mut w);
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker(T), GROUP_OCT9));
    open(&mut w, e.close_price_wad * 85 / 100);
    let caller = w.env.funded();
    let ix = w.env.ix_settle(&caller.pubkey(), policy_key(&w), w.buyer_usdc, false);
    err_is(w.env.send(&[ix], &[&caller]), CoreError::InvalidParam);
    assert_eq!(w.env.anchor::<Policy>(&policy_key(&w)).state, policy_state::ACTIVE);
}

/// Audit A-58: `set_asset_lender` turns only a fresh `<T>.J` alias settled on Jupiter's oracle into a Jupiter asset,
/// once: not a Kamino asset (it would sell through both paths on one settle source), not again (its oracle would change
/// between a close and an open).
#[test]
fn a58_set_asset_lender_only_on_a_fresh_jupiter_alias() {
    let mut w = world(0.93);
    let a = w.env.admin.pubkey();
    // Again on SPYx.J.
    let ix = ix_set_asset_lender(&a, T, w.vault_config, k(&w.snap["oracle"]));
    err_is(w.env.send_admin(&[ix]), CoreError::InvalidParam);
    // On the Kamino asset SPYx.
    w.env.svm.expire_blockhash();
    let ix = ix_set_asset_lender(&a, "SPYx", w.vault_config, k(&w.snap["oracle"]));
    err_is(w.env.send_admin(&[ix]), CoreError::InvalidParam);
}

/// Audit A-54 / A-55: quote mode returns the amount and what `operate` will be offered; the offer never exceeds the
/// position's current net debt (a position that owes less than the payout, e.g. after the owner repaid, takes what it
/// owes and the rest goes to the wallet), and is the amount the keeper must build `operate`'s accounts for.
#[test]
fn a54_payback_is_capped_at_the_positions_debt() {
    let mut w = world(0.93);
    let d = snap_now(&w).debt;
    buy(&mut w, d).unwrap();
    close(&mut w);
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker(T), GROUP_OCT9));
    open(&mut w, e.close_price_wad * 50 / 100); // a deep gap: the payout is the cap, about the whole debt
    // The owner repaid most of the debt during the weekend: the position now sits on a much lower tick.
    let mut pa = w.env.svm.get_account(&w.position).unwrap();
    let tick = i32::from_le_bytes(pa.data[47..51].try_into().unwrap());
    pa.data[47..51].copy_from_slice(&(tick - 1_500).to_le_bytes());
    w.env.svm.set_account(w.position, pa).unwrap();
    let caller = w.env.funded();
    let q = ix_settle(&w, &caller.pubkey(), u64::MAX, "settle", w.buyer_usdc);
    let r = w.env.send_v0(&[q], &[&caller], &[w.alt]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    assert_eq!(r.return_data.data.len(), 16, "amount and operate offer");
    let payout = u64::from_le_bytes(r.return_data.data[..8].try_into().unwrap());
    let offer = u64::from_le_bytes(r.return_data.data[8..16].try_into().unwrap());
    let (pos, vs) = views(&w);
    let net = credence_risk_core::fluid::debt_raw(pos.supply_raw, pos.tick).unwrap() - pos.dust_debt_raw as u128;
    let owes = credence_risk_core::fluid::raw_to_tokens(net, vs.borrow_exchange_price, 6, false).unwrap();
    println!("payout {payout}, position owes {owes}, offer {offer}");
    assert!(payout > owes && offer < owes, "offer below what the position owes, the rest to the wallet");
}

/// Audit A-63: Jupiter cover prices on the WEEKEND set, σ and 3 days, without the earnings bump: refused on another
/// closure type and for an asset with an earnings calendar.
#[test]
fn a63_jl_refuses_other_closures_and_earnings() {
    let mut w = world(0.97);
    let a = w.env.admin.pubkey();
    let ix = w.env.ix_open_group(&a, 20261012);
    w.env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let ix = w.env.ix_open_epoch(&a, ticker(T), 20261012);
    w.env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let b = w.buyer.insecure_clone();
    let ix = ix_buy_at(&w, &b, w.buyer_usdc, 1_000_000_000, u64::MAX, 20261012);
    let e = w.env.send(&[ix], &[&b]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::UnsupportedClosure).to_string()), "{:#?}", e.meta.logs);
    let ix = ix_set_earnings(&a, T, 3 * WAD, vec![OCT9_CLOSE + 86_400]);
    w.env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let e = buy(&mut w, 1_000_000_000).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::UnsupportedClosure).to_string()), "{:#?}", e.meta.logs);
    let ix = ix_set_earnings(&a, T, WAD, vec![]);
    w.env.send_admin(&[ix]).unwrap();
    buy(&mut w, 1_000_000_000).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
}
