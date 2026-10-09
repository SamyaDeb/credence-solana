//! W4: multi-collateral cover and PYUSD on the real klend program with the Sentora xStocks Market snapshot
//! (`common::sn`): `buy_cover_multi` on the real obligations `xkHzu8RC…` (SPYx + NVDAx / PYUSD) and `3cwtNSst…`
//! (SPYx / PYUSD), goldens against the pricing functions and `risk-core::multi`, CU at 1–4 legs, settlement from the
//! PYUSD sleeve into the obligation and to the wallet, the shield on several legs, `fund_sleeve`, and INV-14. One
//! failure test per check of each new instruction.

mod common;

use anchor_lang::{prelude::Pubkey, AnchorDeserialize};
use common::*;
use credence_core::{instructions::cover_multi::MultiCoverBought, pricing, state::*, CoreError, Quote};
use credence_risk_core::{loss_multi, Leg};
use solana_keypair::Keypair;
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000;
const SLEEVE: u64 = 400_000_000_000; // 400k PYUSD
const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;
const WINDOW_START: i64 = OCT12_OPEN - 48_600;
const CLOSES: [(&str, f64); 3] = [("SPYx", 777.05), ("NVDAx", 183.20), ("QQQx", 610.40)];
const MULT: f64 = 1.0057;

struct World {
    env: Env,
    single: Keypair,
    multi: Keypair,
    single_usdc: Pubkey,
    multi_usdc: Pubkey,
}

/// Phase 1 setup, the klend and Sentora snapshots (both obligations' debts scaled by `debt_num / 100`), shield on,
/// the PYUSD sleeve holding [`SLEEVE`], and USDC for both owners.
fn world(debt_num: u128) -> World {
    let mut env = Env::real(LP);
    let a = env.admin.pubkey();
    let ix = env.ix_set_params(&a, shield_params(a, a));
    env.send_admin(&[ix]).unwrap();
    let (single, multi) = (env.funded(), env.funded());
    env.load_sentora(&single.pubkey(), &multi.pubkey(), |d| ob::scale_debt(d, debt_num, 100));
    env.setup_sleeve(SLEEVE);
    let single_usdc = env.usdc_account(&single.pubkey(), 100_000_000_000);
    let multi_usdc = env.usdc_account(&multi.pubkey(), 100_000_000_000);
    World { env, single, multi, single_usdc, multi_usdc }
}

fn debt_of(env: &Env, obligation: &Pubkey) -> u64 {
    (ob::get_u128(&env.data(obligation), ob::OB_BORROWS + ob::BOR_BORROWED_AMOUNT_SF) >> 60) as u64
}

/// Refreshes + `buy_cover_multi` for the multi obligation on SPYx + NVDAx (cap = the debt).
fn buy_multi(w: &mut World) -> TxResult {
    let k = w.multi.pubkey();
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    let debt = debt_of(&w.env, &sn::OB_MULTI) + 1;
    ixs.push(w.env.ix_buy_cover_multi(&k, w.multi_usdc, sn::OB_MULTI, &["SPYx", "NVDAx"], GROUP_OCT9, debt / 2, u64::MAX, true));
    w.env.send(&ixs, &[&w.multi])
}

fn multi_policy() -> Pubkey {
    policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &sn::OB_MULTI)
}

fn program_cu(logs: &[String]) -> u64 {
    let id = credence_core::ID.to_string();
    logs.iter()
        .filter_map(|l| l.strip_prefix(&format!("Program {id} consumed ")))
        .filter_map(|r| r.split(' ').next()?.parse().ok())
        .max()
        .unwrap_or(0)
}

/// The first event of type `T` in a transaction's logs (`Program data:` lines).
fn event<T: anchor_lang::Event + AnchorDeserialize>(logs: &[String]) -> T {
    use base64::Engine;
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .find(|d| d.starts_with(T::DISCRIMINATOR))
        .map(|d| T::deserialize(&mut &d[T::DISCRIMINATOR.len()..]).unwrap())
        .expect("event")
}

fn sleeve_balance(env: &Env) -> u64 {
    env.token_balance(&Env::sleeve_key())
}

/// INV-14: the sleeve holds every live PYUSD reservation less the advances already paid from it.
fn assert_inv14(env: &Env) {
    let v: Vault = env.anchor(&vault_pda());
    assert!(
        sleeve_balance(env) >= v.pyusd_reserved - v.pyusd_advanced,
        "INV-14: sleeve {} < reserved {} − advanced {}",
        sleeve_balance(env),
        v.pyusd_reserved,
        v.pyusd_advanced
    );
}

fn close_of(t: &str) -> f64 {
    CLOSES.iter().find(|(x, _)| *x == t).unwrap().1
}

/// Stores the Friday close for each ticker (equity source, cross-checked); the clock is Friday after the close.
fn close_all(env: &mut Env, tickers: &[&str]) {
    let a = env.admin.pubkey();
    env.set_time(OCT9_CLOSE + 30);
    for t in tickers {
        let asset: AssetConfig = env.zc(&asset_pda(&ticker(t)));
        let p = env.put_price(&Px::new(asset.feed_equity, close_of(t), OCT9_CLOSE - 1));
        let x = env.put_price(&Px::new(asset.feed_xstock, close_of(t) * MULT, OCT9_CLOSE - 300));
        let ix = env.ix_snapshot(&a, t, GROUP_OCT9, p, Some(x));
        env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{t}: {:?}\n{:#?}", e.err, e.meta.logs));
    }
}

/// Stores the Monday open at `close × (1 + r)` per ticker; then past the settlement window, Scope re-stamped.
fn open_all(env: &mut Env, moves: &[(&str, f64)]) {
    let a = env.admin.pubkey();
    for (t, r) in moves {
        let asset: AssetConfig = env.zc(&asset_pda(&ticker(t)));
        let open = close_of(t) * (1.0 + r);
        let u = env.put_price(&Px::new(asset.feed_equity, open, OCT12_OPEN + 30));
        let x = env.put_price(&Px::new(asset.feed_xstock, open * MULT, OCT12_OPEN + 60));
        env.set_time(OCT12_OPEN + 301);
        let post = env.ix_post(&a, t, GROUP_OCT9, &[u], Some(x));
        env.send_admin(&[post]).unwrap_or_else(|e| panic!("{t}: {:?}\n{:#?}", e.err, e.meta.logs));
    }
    env.svm.warp_to_slot(env.slot() + 10);
    env.freshen_scope();
}

fn settle_multi(w: &mut World, policy: Pubkey, owner_pyusd: Pubkey) -> TxResult {
    let keeper = w.env.funded();
    let p: Policy = w.env.anchor(&policy);
    let mut ixs = sn::refreshes(p.obligation);
    ixs.push(w.env.ix_settle_pyusd(&keeper.pubkey(), policy, owner_pyusd, true));
    w.env.send(&ixs, &[&keeper])
}

/// Every leg's covered value is its deposit's market value × the reserve's own LT (no elevation group), in PYUSD
/// units at klend's PYUSD price; the stablecoin part is 0 here. Checked on the obligation and reserves as klend left
/// them after the refresh in the buy transaction.
fn expected_legs(env: &Env, obligation: &Pubkey) -> Vec<u64> {
    let d = env.data(obligation);
    let bor_amt = ob::get_u128(&d, ob::OB_BORROWS + ob::BOR_BORROWED_AMOUNT_SF);
    let bor_mv = ob::get_u128(&d, ob::OB_BORROWS + ob::BOR_MARKET_VALUE_SF);
    sn::deposits(obligation)
        .iter()
        .enumerate()
        .map(|(k, r)| {
            let mv = ob::get_u128(&d, ob::OB_DEPOSITS + k * ob::DEPOSIT_LEN + ob::DEP_MARKET_VALUE_SF);
            let lt = credence_core::kamino::ReserveView::decode(&env.data(r)).unwrap().liquidation_threshold_pct as u128;
            let v = credence_risk_core::U256::from(mv) * credence_risk_core::U256::from(lt) / credence_risk_core::U256::from(100u8);
            u64::try_from(v * credence_risk_core::U256::from(bor_amt) / (credence_risk_core::U256::from(bor_mv) << 60)).unwrap()
        })
        .collect()
}

/// The two-leg buy on the real obligation: the snapshot (each leg = mv × its own LT), the reserved losses and the
/// premium equal the host computation (`pricing::*_multi` on the stored gap factors, and `risk-core::loss_multi` per
/// joint scenario for the settlement losses), the sleeve reservation is booked (INV-14), and the premium is paid in
/// USDC. CU of the instruction printed for plan/09.
#[test]
fn buy_cover_multi_two_legs_golden() {
    let mut w = world(145);
    let r = buy_multi(&mut w).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let cu = program_cu(&r.logs);
    println!("buy_cover_multi 2 legs: program {cu} CU, transaction {} CU", r.compute_units_consumed);
    assert!(cu < 900_000);

    let p: Policy = w.env.anchor(&multi_policy());
    assert_eq!(p.n_legs, 2);
    assert_eq!((p.leg_ticker(0), p.leg_ticker(1)), (ticker("SPYx"), ticker("NVDAx")));
    assert_eq!(p.borrow_mint, PYUSD_MINT);
    assert_eq!(p.stable_covered, 0);
    let want = expected_legs(&w.env, &sn::OB_MULTI);
    assert_eq!(&p.leg_covered[..2], &want[..], "C′_i = mv_i × LT_i in PYUSD units");
    assert_eq!(p.covered_value, want.iter().sum::<u64>());
    println!("D {} PYUSD, C′ SPYx {} NVDAx {}, D/C′ {:.4}", p.debt, want[0], want[1], p.debt as f64 / p.covered_value as f64);

    // Host goldens on the same inputs.
    let c: Config = w.env.anchor(&config_pda());
    let assets: Vec<AssetConfig> = ["SPYx", "NVDAx"].iter().map(|t| w.env.zc(&asset_pda(&ticker(t)))).collect();
    let refs: Vec<&AssetConfig> = assets.iter().collect();
    let legs = &p.leg_covered[..2];
    let xr = pricing::MultiInputs { legs, stable: 0, debt: pricing::reserved_debt(p.debt, &c).unwrap(), max_payout: p.max_payout };
    let mut losses = vec![0u64; K];
    let worst = pricing::policy_losses_multi(&refs, &c, &xr, &mut losses).unwrap();
    assert_eq!(p.worst_loss, worst);
    let xp = pricing::MultiInputs { debt: pricing::priced_debt(p.debt, &c).unwrap(), ..xr };
    let mut settle = vec![0u64; K];
    pricing::settlement_losses_multi(&refs, &xp, &mut settle).unwrap();
    // risk-core reference for every joint scenario: g_i = the stored gap factor (Q64 → WAD, rounded down).
    for j in 0..K {
        let lg: Vec<Leg> = (0..2)
            .map(|i| Leg { covered: legs[i], g: credence_risk_core::U256::from((assets[i].gap_factor_q64(j) * 1_000_000_000_000_000_000u128) >> 64) })
            .collect();
        let rc = loss_multi(xp.debt, xp.max_payout, &lg, 0).unwrap();
        assert!(settle[j].abs_diff(rc) <= 1, "scenario {j}: program {} vs risk-core {rc}", settle[j]);
    }
    let sets: Vec<ScenarioSet> = ["SPYx", "NVDAx"].iter().map(|t| w.env.zc(&scen_pda(&ticker(t), closure::WEEKEND))).collect();
    let lp: Vec<pricing::LegPricing> = (0..2)
        .map(|i| pricing::LegPricing { z: &sets[i].z[..sets[i].n as usize], sigma_wad: assets[i].sigma_wad, dividend_wad: assets[i].dividend_wad, basis_sigma_wad: assets[i].basis_sigma_wad })
        .collect();
    let ev: MultiCoverBought = event(&r.logs);
    let util = ev.util_after_wad;
    let v: Vault = w.env.anchor(&vault_pda());
    let (prem, loading) = pricing::premium_multi(&lp, &c, 3, util, &xp, &settle, worst).unwrap();
    assert_eq!((ev.premium, ev.worst_loss, ev.legs), (p.premium, worst, 2));
    println!("worst {worst}, premium {} (shield loading {loading}), util {:.4}%", p.premium, util as f64 / 1e16);
    assert!(p.premium.abs_diff(prem) <= 1, "premium {} vs host {prem}", p.premium);
    assert_eq!(p.shield_loading, loading);
    assert!(p.premium > 0 && p.premium < p.max_payout);

    // Bookkeeping: the PYUSD reservation (INV-14) and USDC premium.
    assert_eq!(v.pyusd_reserved, worst);
    assert_inv14(&w.env);
    assert_eq!(w.env.token_balance(&w.multi_usdc), 100_000_000_000 - p.premium);
    let e1: Epoch = w.env.anchor(&epoch_pda(&ticker("NVDAx"), GROUP_OCT9));
    assert_eq!(e1.worst_loss_sum, worst, "every leg's epoch carries the policy for concentration");
}

/// One leg through `buy_cover_multi` (the single-SPYx Sentora obligation): the payout rule is the Phase 1 one and the
/// premium is at least the single-asset quote on the same position (max(joint, marginal)).
#[test]
fn buy_cover_multi_one_leg_pyusd() {
    let mut w = world(110);
    let k = w.single.pubkey();
    let mut ixs = sn::refreshes(sn::OB_SINGLE);
    let debt = debt_of(&w.env, &sn::OB_SINGLE);
    ixs.push(w.env.ix_buy_cover_multi(&k, w.single_usdc, sn::OB_SINGLE, &["SPYx"], GROUP_OCT9, debt / 2, u64::MAX, true));
    let r = w.env.send(&ixs, &[&w.single]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("buy_cover_multi 1 leg: program {} CU", program_cu(&r.logs));
    let p: Policy = w.env.anchor(&policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &sn::OB_SINGLE));
    assert_eq!(p.n_legs, 1);
    let c: Config = w.env.anchor(&config_pda());
    let a: AssetConfig = w.env.zc(&asset_pda(&ticker("SPYx")));
    let s: ScenarioSet = w.env.zc(&scen_pda(&ticker("SPYx"), closure::WEEKEND));
    let x = pricing::CoverInputs { covered_value: p.covered_value, debt: pricing::priced_debt(p.debt, &c).unwrap(), max_payout: p.max_payout };
    let util = event::<MultiCoverBought>(&r.logs).util_after_wad;
    println!("D/C′ {:.4}", p.debt as f64 / p.covered_value as f64);
    let single = pricing::premium(&s.z[..s.n as usize], &c, a.sigma_wad, a.dividend_wad, 3, util, &x).unwrap();
    assert!(p.premium >= single + p.shield_loading, "premium {} ≥ marginal {single} + loading {}", p.premium, p.shield_loading);
    assert_inv14(&w.env);
}

/// Pricing CU at 1–4 legs with `quote_cover_multi` (the 4-leg case repeats SPYx: four legs' worth of pricing work; a
/// purchase refuses duplicates), and a real 3-leg purchase on the multi obligation with a QQQx deposit added
/// (test-only: the third deposit is written and the obligation stamped as refreshed, the values made consistent).
#[test]
fn cu_by_leg_count() {
    let mut w = world(145);
    let p_debt = debt_of(&w.env, &sn::OB_MULTI);
    let payer = w.env.funded();
    // D/C′ 0.92 (typical), 0.96 (near the threshold) and 0.99 (worst case for the tail work).
    for ratio in [0.92, 0.96, 0.99] {
        for legs in [&["SPYx"][..], &["SPYx", "NVDAx"], &["SPYx", "NVDAx", "QQQx"], &["SPYx", "NVDAx", "QQQx", "SPYx"]] {
            let n = legs.len() as u64;
            let covered = (p_debt as f64 / ratio) as u64 / n;
            let ix = w.env.ix_quote_cover_multi(legs, vec![covered; legs.len()], 0, p_debt, p_debt / 2);
            w.env.svm.expire_blockhash();
            match w.env.send(&[ix], &[&payer]) {
                Ok(r) => {
                    let q = Quote::deserialize(&mut &r.return_data.data[..]).unwrap();
                    println!("quote_cover_multi D/C′ {ratio} {} legs: program {} CU (premium {}, worst {})", legs.len(), program_cu(&r.logs), q.premium, q.worst_loss);
                }
                Err(e) => println!("quote_cover_multi D/C′ {ratio} {} legs: FAILED {:?}", legs.len(), e.err),
            }
        }
    }

    // A real 3-leg purchase: QQQx deposit added in slot 2 at a third of the SPYx deposit's value.
    let mut d = w.env.data(&sn::OB_MULTI);
    let (o0, o2) = (ob::OB_DEPOSITS, ob::OB_DEPOSITS + 2 * ob::DEPOSIT_LEN);
    let slot0: Vec<u8> = d[o0..o0 + ob::DEPOSIT_LEN].to_vec();
    d[o2..o2 + ob::DEPOSIT_LEN].copy_from_slice(&slot0);
    ob::put(&mut d, o2 + ob::DEP_RESERVE, sn::RESERVE_QQQX.as_ref());
    let mv0 = ob::get_u128(&d, o0 + ob::DEP_MARKET_VALUE_SF);
    ob::put(&mut d, o2 + ob::DEP_MARKET_VALUE_SF, &(mv0 / 3).to_le_bytes());
    let mut unhealthy = 0u128;
    for (k, r) in [sn::RESERVE_SPYX, sn::RESERVE_NVDAX, sn::RESERVE_QQQX].iter().enumerate() {
        let mv = ob::get_u128(&d, ob::OB_DEPOSITS + k * ob::DEPOSIT_LEN + ob::DEP_MARKET_VALUE_SF);
        let lt = credence_core::kamino::ReserveView::decode(&w.env.data(r)).unwrap().liquidation_threshold_pct as u128;
        unhealthy += mv * lt / 100;
    }
    ob::put(&mut d, ob::OB_UNHEALTHY_BORROW_VALUE_SF, &unhealthy.to_le_bytes());
    let slot = w.env.slot();
    ob::put(&mut d, ob::OB_LAST_UPDATE_SLOT, &slot.to_le_bytes());
    d[ob::OB_LAST_UPDATE_STALE] = 0;
    d[ob::OB_LAST_UPDATE_PRICE_STATUS] = 0b0011_1111;
    w.env.put_klend(sn::OB_MULTI, d);
    let k = w.multi.pubkey();
    let mut ix = w.env.ix_buy_cover_multi(&k, w.multi_usdc, sn::OB_MULTI, &["SPYx", "NVDAx", "QQQx"], GROUP_OCT9, p_debt / 2, u64::MAX, true);
    // The third deposit reserve goes after the two the helper lists (obligation order).
    let pos = ix.accounts.iter().position(|m| m.pubkey == sn::RESERVE_NVDAX).unwrap();
    ix.accounts.insert(pos + 1, anchor_lang::solana_program::instruction::AccountMeta::new_readonly(sn::RESERVE_QQQX, false));
    let r = w.env.send(&[ix], &[&w.multi]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("buy_cover_multi 3 legs: program {} CU, transaction {} CU", program_cu(&r.logs), r.compute_units_consumed);
    let p: Policy = w.env.anchor(&multi_policy());
    assert_eq!(p.n_legs, 3);
    assert!(program_cu(&r.logs) < 900_000);
}

/// Settlement of the two-leg PYUSD policy: SPYx −15% and NVDAx −25% at the open. The payout (the multi-leg rule on
/// the debt with interest) is paid from the sleeve into the obligation, the reservation released (INV-14), and a
/// retry refused.
#[test]
fn settle_multi_from_sleeve_into_obligation() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap();
    close_all(&mut w.env, &["SPYx", "NVDAx"]);
    open_all(&mut w.env, &[("SPYx", -0.15), ("NVDAx", -0.25)]);
    let owner_pyusd = w.env.pyusd_account(&w.multi.pubkey(), 0);
    let (debt0, sleeve0) = (debt_of(&w.env, &sn::OB_MULTI), sleeve_balance(&w.env));
    let r = settle_multi(&mut w, multi_policy(), owner_pyusd).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("settle_policy (2 legs, PYUSD): program {} CU", program_cu(&r.logs));
    let p: Policy = w.env.anchor(&multi_policy());
    assert_eq!(p.state, policy_state::SETTLED);
    let e0: Epoch = w.env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    let e1: Epoch = w.env.anchor(&epoch_pda(&ticker("NVDAx"), GROUP_OCT9));
    let debt = accrued_debt_now(&w.env, &p);
    let legs = [
        pricing::LegPrice { covered: p.leg_covered[0], close_wad: e0.close_price_wad, price_wad: e0.settle_price_wad },
        pricing::LegPrice { covered: p.leg_covered[1], close_wad: e1.close_price_wad, price_wad: e1.settle_price_wad },
    ];
    let want = pricing::realized_payout_multi(&legs, 0, debt, p.max_payout).unwrap();
    println!("payout {} PYUSD (debt {} → {})", p.payout, debt0, debt_of(&w.env, &sn::OB_MULTI));
    assert!(want > 0, "a −15% / −25% weekend pays this position");
    assert_eq!(p.payout, want);
    assert_eq!(sleeve0 - sleeve_balance(&w.env), want, "paid from the sleeve");
    assert_eq!(w.env.token_balance(&owner_pyusd), 0, "all into the obligation");
    assert!(debt_of(&w.env, &sn::OB_MULTI) < debt0);
    let v: Vault = w.env.anchor(&vault_pda());
    assert_eq!((v.pyusd_reserved, v.pyusd_advanced), (0, 0), "released");
    assert_inv14(&w.env);
    let again = settle_multi(&mut w, multi_policy(), owner_pyusd);
    assert!(again.is_err());
}

/// One leg flat, one leg up: no payout; the policy settles at 0 and the reservation is released.
#[test]
fn settle_multi_no_gap_pays_nothing() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap();
    close_all(&mut w.env, &["SPYx", "NVDAx"]);
    open_all(&mut w.env, &[("SPYx", 0.0), ("NVDAx", 0.03)]);
    let owner_pyusd = w.env.pyusd_account(&w.multi.pubkey(), 0);
    let sleeve0 = sleeve_balance(&w.env);
    settle_multi(&mut w, multi_policy(), owner_pyusd).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let p: Policy = w.env.anchor(&multi_policy());
    assert_eq!((p.state, p.payout), (policy_state::SETTLED, 0));
    assert_eq!(sleeve_balance(&w.env), sleeve0);
    assert_eq!(w.env.anchor::<Vault>(&vault_pda()).pyusd_reserved, 0);
}

/// A voided leg (its close never stored) counts flat; the other leg's gap still pays.
#[test]
fn settle_multi_voided_leg_counts_flat() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap();
    close_all(&mut w.env, &["SPYx"]); // NVDAx never closes
    let caller = w.env.funded();
    w.env.set_time(OCT9_CLOSE + 7 * 3600);
    let void = w.env.ix_void_epoch(&caller.pubkey(), ticker("NVDAx"), GROUP_OCT9);
    w.env.send(&[void], &[&caller]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    open_all(&mut w.env, &[("SPYx", -0.30)]);
    let owner_pyusd = w.env.pyusd_account(&w.multi.pubkey(), 0);
    settle_multi(&mut w, multi_policy(), owner_pyusd).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let p: Policy = w.env.anchor(&multi_policy());
    let e0: Epoch = w.env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    let legs = [
        pricing::LegPrice { covered: p.leg_covered[0], close_wad: e0.close_price_wad, price_wad: e0.settle_price_wad },
        pricing::LegPrice { covered: p.leg_covered[1], close_wad: 1, price_wad: 1 },
    ];
    assert_eq!(p.payout, pricing::realized_payout_multi(&legs, 0, accrued_debt_now(&w.env, &p), p.max_payout).unwrap());
}

/// Settlement checks: the other legs' epochs are required, in order, settled, and the payout comes from the sleeve.
#[test]
fn settle_multi_failures() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap();
    close_all(&mut w.env, &["SPYx", "NVDAx"]);
    let owner_pyusd = w.env.pyusd_account(&w.multi.pubkey(), 0);
    // NVDAx not settled yet.
    open_all(&mut w.env, &[("SPYx", -0.15)]);
    let e = settle_multi(&mut w, multi_policy(), owner_pyusd).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::WrongEpochState).to_string()), "{:?}", e.err);
    open_all(&mut w.env, &[("NVDAx", -0.25)]);
    let keeper = w.env.funded();
    // Missing leg epoch.
    let mut ix = w.env.ix_settle_pyusd(&keeper.pubkey(), multi_policy(), owner_pyusd, true);
    ix.accounts.pop();
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    ixs.push(ix);
    let e = w.env.send(&ixs, &[&keeper]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::InvalidParam).to_string()), "{:?}", e.err);
    // Another ticker's epoch in the leg slot.
    let mut ix = w.env.ix_settle_pyusd(&keeper.pubkey(), multi_policy(), owner_pyusd, true);
    ix.accounts.last_mut().unwrap().pubkey = epoch_pda(&ticker("QQQx"), GROUP_OCT9);
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    ixs.push(ix);
    let e = w.env.send(&ixs, &[&keeper]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::InvalidParam).to_string()), "{:?}", e.err);
    // Paid from the vault's USDC instead of the sleeve.
    let mut ix = w.env.ix_settle_pyusd(&keeper.pubkey(), multi_policy(), owner_pyusd, true);
    ix.accounts[6].pubkey = vault_usdc_pda();
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    ixs.push(ix);
    assert!(w.env.send(&ixs, &[&keeper]).is_err());
    // Correct accounts settle.
    settle_multi(&mut w, multi_policy(), owner_pyusd).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
}

/// After the grace period a PYUSD policy can be paid to the owner's PYUSD wallet without klend.
#[test]
fn settle_multi_to_wallet_after_grace() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap();
    close_all(&mut w.env, &["SPYx", "NVDAx"]);
    open_all(&mut w.env, &[("SPYx", -0.15), ("NVDAx", -0.25)]);
    let owner_pyusd = w.env.pyusd_account(&w.multi.pubkey(), 0);
    w.env.set_time(OCT12_OPEN + 301 + 3_601);
    let keeper = w.env.funded();
    let p: Policy = w.env.anchor(&multi_policy());
    let mut metas = credence_core::accounts::SettlePolicyToWallet {
        caller: keeper.pubkey(),
        config: config_pda(),
        epoch: p.epoch,
        policy: multi_policy(),
        loss: loss_pda(GROUP_OCT9),
        vault: vault_pda(),
        vault_usdc: Env::sleeve_key(),
        owner_usdc: owner_pyusd,
        usdc_mint: PYUSD_MINT,
        token_program: TOKEN_2022_PROGRAM,
        cash: None,
        owner_cash: None,
        cash_mint: None,
        cash_token_program: None,
    }
    .to_account_metas(None);
    metas.extend(w.env.leg_epochs(&p).into_iter().map(|e| anchor_lang::solana_program::instruction::AccountMeta::new_readonly(e, false)));
    let ix = anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        credence_core::ID,
        &anchor_lang::InstructionData::data(&credence_core::instruction::SettlePolicyToWallet {}),
        metas,
    );
    w.env.send(&[ix], &[&keeper]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let p: Policy = w.env.anchor(&multi_policy());
    assert!(p.payout > 0);
    assert_eq!(w.env.token_balance(&owner_pyusd), p.payout, "the whole payout in PYUSD to the wallet");
    assert_inv14(&w.env);
}
use anchor_lang::ToAccountMetas;

/// The shield on a two-leg PYUSD policy: Sunday night both legs' fair values are down; the advance (the multi-leg
/// target at the marked-down fair values) is repaid from the sleeve into the obligation; INV-14 holds with the advance
/// counted; settlement pays the rule net of it.
#[test]
fn shield_multi_legs_from_sleeve() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    close_all(&mut w.env, &["SPYx", "NVDAx"]);
    let at = WINDOW_START + 3_600;
    w.env.set_time(at);
    let mut pushes = vec![];
    for (t, f) in [("SPYx", -0.10), ("NVDAx", -0.18)] {
        let a: AssetConfig = w.env.zc(&asset_pda(&ticker(t)));
        let e: Epoch = w.env.anchor(&epoch_pda(&ticker(t), GROUP_OCT9));
        pushes.push(w.env.put_push(&Px::new(a.feed_xstock, e.close_price_wad as f64 / 1e18 * (1.0 + f) * 1e0, at - 600)));
    }
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    let keeper = w.env.admin.insecure_clone();
    let sleeve0 = sleeve_balance(&w.env);
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    ixs.push(w.env.ix_shield_pyusd(&keeper.pubkey(), multi_policy(), &pushes));
    let r = w.env.send(&ixs, &[&keeper]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("shield_advance (2 legs, PYUSD): program {} CU", program_cu(&r.logs));
    let p: Policy = w.env.anchor(&multi_policy());
    println!("advanced {} PYUSD of worst {} (cap {})", p.advanced, p.worst_loss, p.max_payout);
    assert!(p.advanced > 0, "both legs down: an advance");
    assert_eq!(sleeve0 - sleeve_balance(&w.env), p.advanced, "from the sleeve");
    let v: Vault = w.env.anchor(&vault_pda());
    assert_eq!(v.pyusd_advanced, p.advanced);
    assert_inv14(&w.env);

    // A leg's push account for another feed is refused.
    let mut bad = pushes.clone();
    bad[1] = pushes[0];
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    ixs.push(w.env.ix_shield_pyusd(&keeper.pubkey(), multi_policy(), &bad));
    let e = w.env.send(&ixs, &[&keeper]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::NotPushAccount).to_string()), "{:?}", e.err);

    // Settlement nets the advance.
    open_all(&mut w.env, &[("SPYx", -0.10), ("NVDAx", -0.18)]);
    let owner_pyusd = w.env.pyusd_account(&w.multi.pubkey(), 0);
    settle_multi(&mut w, multi_policy(), owner_pyusd).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let v: Vault = w.env.anchor(&vault_pda());
    assert_eq!((v.pyusd_reserved, v.pyusd_advanced), (0, 0));
    assert_inv14(&w.env);
}

/// A leg's epoch that is not CLOSED blocks the multi-leg shield.
#[test]
fn shield_multi_leg_epoch_not_closed() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap();
    close_all(&mut w.env, &["SPYx"]);
    let at = WINDOW_START + 3_600;
    w.env.set_time(at);
    let mut pushes = vec![];
    for t in ["SPYx", "NVDAx"] {
        let a: AssetConfig = w.env.zc(&asset_pda(&ticker(t)));
        pushes.push(w.env.put_push(&Px::new(a.feed_xstock, close_of(t) * 0.9, at - 600)));
    }
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    let keeper = w.env.admin.insecure_clone();
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    ixs.push(w.env.ix_shield_pyusd(&keeper.pubkey(), multi_policy(), &pushes));
    let e = w.env.send(&ixs, &[&keeper]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::WrongEpochState).to_string()), "{:?}", e.err);
}

/// INV-14 at purchase: PYUSD cover beyond the sleeve is refused (`SleeveShort`), and without the sleeve account
/// (`SleeveMissing`).
#[test]
fn inv14_sleeve_must_hold_the_reservation() {
    let mut w = world(145);
    w.env.set_token_amount(&Env::sleeve_key(), 1_000_000); // 1 PYUSD
    let e = buy_multi(&mut w).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::SleeveShort).to_string()), "{:?}", e.err);
    w.env.set_token_amount(&Env::sleeve_key(), SLEEVE);
    let k = w.multi.pubkey();
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    let debt = debt_of(&w.env, &sn::OB_MULTI);
    ixs.push(w.env.ix_buy_cover_multi(&k, w.multi_usdc, sn::OB_MULTI, &["SPYx", "NVDAx"], GROUP_OCT9, debt / 2, u64::MAX, false));
    let e = w.env.send(&ixs, &[&w.multi]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::SleeveMissing).to_string()), "{:?}", e.err);
    buy_multi(&mut w).unwrap();
    assert_inv14(&w.env);
}

/// `buy_cover_multi`: one failure test per check.
#[test]
fn buy_cover_multi_failures() {
    let mut w = world(145);
    let k = w.multi.pubkey();
    let debt = debt_of(&w.env, &sn::OB_MULTI);
    let try_ix = |w: &mut World, ix: anchor_lang::solana_program::instruction::Instruction, refresh: bool| -> String {
        let mut ixs = if refresh { sn::refreshes(sn::OB_MULTI) } else { vec![] };
        ixs.push(ix);
        w.env.svm.expire_blockhash();
        let signer = w.multi.insecure_clone();
        format!("{:?}", w.env.send(&ixs, &[&signer]).unwrap_err().err)
    };
    let has = |s: &str, e: CoreError| assert!(s.contains(&code(e).to_string()), "want {e:?}: {s}");
    let base = |w: &World, legs: &[&str], cap: u64, max_prem: u64| w.env.ix_buy_cover_multi(&k, w.multi_usdc, sn::OB_MULTI, legs, GROUP_OCT9, cap, max_prem, true);

    // A deposit not covered by any leg (NVDAx deposit, SPYx leg only).
    let ix = base(&w, &["SPYx"], debt / 2, u64::MAX);
    has(&try_ix(&mut w, ix, true), CoreError::UnsupportedObligation);
    // A leg without a deposit (QQQx).
    let ix = base(&w, &["SPYx", "NVDAx", "QQQx"], debt / 2, u64::MAX);
    has(&try_ix(&mut w, ix, true), CoreError::UnsupportedObligation);
    // The same asset twice.
    let ix = base(&w, &["SPYx", "SPYx"], debt / 2, u64::MAX);
    has(&try_ix(&mut w, ix, true), CoreError::InvalidParam);
    // Leg accounts not a multiple of three.
    let mut ix = base(&w, &["SPYx", "NVDAx"], debt / 2, u64::MAX);
    ix.accounts.pop();
    has(&try_ix(&mut w, ix, true), CoreError::InvalidParam);
    // A leg's epoch read-only.
    let mut ix = base(&w, &["SPYx", "NVDAx"], debt / 2, u64::MAX);
    ix.accounts.last_mut().unwrap().is_writable = false;
    has(&try_ix(&mut w, ix, true), CoreError::InvalidParam);
    // A leg's epoch of another asset.
    let mut ix = base(&w, &["SPYx", "NVDAx"], debt / 2, u64::MAX);
    ix.accounts.last_mut().unwrap().pubkey = epoch_pda(&ticker("QQQx"), GROUP_OCT9);
    has(&try_ix(&mut w, ix, true), CoreError::InvalidParam);
    // A leg's scenario set of another asset.
    let mut ix = base(&w, &["SPYx", "NVDAx"], debt / 2, u64::MAX);
    let n = ix.accounts.len();
    ix.accounts[n - 2].pubkey = scen_pda(&ticker("SPYx"), closure::WEEKEND);
    has(&try_ix(&mut w, ix, true), CoreError::InvalidParam);
    // Deposit reserves out of the obligation's order (caught by the leg order of A-45 first, then by the reserve match).
    let mut ix = base(&w, &["SPYx", "NVDAx"], debt / 2, u64::MAX);
    let i = ix.accounts.iter().position(|m| m.pubkey == sn::RESERVE_SPYX).unwrap();
    ix.accounts.swap(i, i + 1);
    has(&try_ix(&mut w, ix, true), CoreError::InvalidParam);
    // Cap above the debt.
    let ix = base(&w, &["SPYx", "NVDAx"], debt * 2, u64::MAX);
    has(&try_ix(&mut w, ix, true), CoreError::InvalidParam);
    // Premium above the buyer's maximum.
    let ix = base(&w, &["SPYx", "NVDAx"], debt / 2, 1);
    has(&try_ix(&mut w, ix, true), CoreError::PremiumAboveMax);
    // Not refreshed in this slot.
    let ix = base(&w, &["SPYx", "NVDAx"], debt / 2, u64::MAX);
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    has(&try_ix(&mut w, ix, false), CoreError::ObligationNotRefreshed);
    // Signer is not the obligation's owner.
    let other = w.env.funded();
    let ou = w.env.usdc_account(&other.pubkey(), 10_000_000_000);
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    ixs.push(w.env.ix_buy_cover_multi(&other.pubkey(), ou, sn::OB_MULTI, &["SPYx", "NVDAx"], GROUP_OCT9, debt / 2, u64::MAX, true));
    has(&format!("{:?}", w.env.send(&ixs, &[&other]).unwrap_err().err), CoreError::NotObligationOwner);
    // A disabled asset.
    let a = w.env.admin.pubkey();
    let mut p = real_asset_params(2);
    p.enabled = false;
    let ix = w.env.ix_update_asset(&a, ticker("NVDAx"), p);
    w.env.send_admin(&[ix]).unwrap();
    let ix = base(&w, &["SPYx", "NVDAx"], debt / 2, u64::MAX);
    has(&try_ix(&mut w, ix, true), CoreError::AssetDisabled);
    let ix = w.env.ix_update_asset(&a, ticker("NVDAx"), real_asset_params(2));
    w.env.send_admin(&[ix]).unwrap();
    // Paused.
    let ix = w.env.ix_set_paused(&a, true);
    w.env.send_admin(&[ix]).unwrap();
    let ix = base(&w, &["SPYx", "NVDAx"], debt / 2, u64::MAX);
    has(&try_ix(&mut w, ix, true), CoreError::Paused);
    let ix = w.env.ix_set_paused(&a, false);
    w.env.send_admin(&[ix]).unwrap();
    // After the bell.
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker("NVDAx"), GROUP_OCT9));
    let now = w.env.now();
    w.env.set_time(e.bell);
    let ix = base(&w, &["SPYx", "NVDAx"], debt / 2, u64::MAX);
    has(&try_ix(&mut w, ix, true), CoreError::SalesClosed);
    w.env.set_time(now);
    // Everything right: bought.
    buy_multi(&mut w).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
}

fn keeper_accounts(w: &mut World, pyusd: u64) -> (Keypair, Pubkey, Pubkey) {
    let keeper = w.env.admin.insecure_clone();
    let kp = w.env.pyusd_account(&keeper.pubkey(), pyusd);
    let ku = w.env.usdc_account(&keeper.pubkey(), 0);
    (keeper, kp, ku)
}

fn fund(w: &mut World, keeper: &Keypair, kp: Pubkey, ku: Pubkey, pyusd_in: u64, usdc_out: u64, refresh: bool) -> TxResult {
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    let mut ixs = if refresh { vec![sn::refresh_reserve(sn::RESERVE_PYUSD)] } else { vec![] };
    ixs.push(w.env.ix_fund_sleeve(&keeper.pubkey(), kp, ku, pyusd_in, usdc_out));
    w.env.send(&ixs, &[keeper])
}

/// `fund_sleeve`: the keeper sells PYUSD to the sleeve at klend's PYUSD price within the slippage bound; equity moves
/// by the swap cost. Failure per check: not the keeper, reserve not refreshed, slippage, depeg, INV-13, zero amounts.
#[test]
fn fund_sleeve_bounds() {
    let mut w = world(145);
    let (keeper, kp, ku) = keeper_accounts(&mut w, 50_000_000_000);
    let r = credence_core::kamino::ReserveView::decode(&w.env.data(&sn::RESERVE_PYUSD)).unwrap();
    println!("PYUSD klend price {:.6}", r.market_price_sf as f64 / (1u128 << 60) as f64);
    let eq0 = w.env.anchor::<Vault>(&vault_pda()).equity;
    let s0 = sleeve_balance(&w.env);
    let r = fund(&mut w, &keeper, kp, ku, 10_000_000_000, 10_010_000_000, true).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("fund_sleeve: program {} CU", program_cu(&r.logs));
    assert_eq!(sleeve_balance(&w.env) - s0, 10_000_000_000);
    assert_eq!(w.env.token_balance(&ku), 10_010_000_000);
    assert_eq!(eq0 - w.env.anchor::<Vault>(&vault_pda()).equity, 10_000_000, "equity pays the 10 USDC swap cost");

    let has = |r: TxResult, e: CoreError| {
        let s = format!("{:?}", r.unwrap_err().err);
        assert!(s.contains(&code(e).to_string()), "want {e:?}: {s}");
    };
    // Slippage beyond 30 bps.
    has(fund(&mut w, &keeper, kp, ku, 1_000_000_000, 1_004_000_000, true), CoreError::SlippageTooHigh);
    // Reserve not refreshed in this slot.
    has(fund(&mut w, &keeper, kp, ku, 1_000_000_000, 1_000_000_000, false), CoreError::ReserveNotRefreshed);
    // Zero amounts.
    has(fund(&mut w, &keeper, kp, ku, 0, 1, true), CoreError::InvalidParam);
    // Not the keeper.
    let other = w.env.funded();
    let op = w.env.pyusd_account(&other.pubkey(), 1_000_000_000);
    let ou = w.env.usdc_account(&other.pubkey(), 0);
    has(fund(&mut w, &other, op, ou, 1_000_000_000, 1_000_000_000, true), CoreError::Unauthorized);
    // INV-13: never the cash live groups need (cover bought, then the whole cash asked for).
    buy_multi(&mut w).unwrap();
    let cash = w.env.token_balance(&vault_usdc_pda());
    w.env.set_token_amount(&kp, cash);
    has(fund(&mut w, &keeper, kp, ku, cash, cash, true), CoreError::BackstopBudget);
    // A depegged PYUSD (Scope chain 148 at 0.97).
    let now = w.env.now();
    w.env.put_scope(148, 0.97, now);
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    let mut ixs = vec![sn::refresh_reserve(sn::RESERVE_PYUSD)];
    ixs.push(w.env.ix_fund_sleeve(&keeper.pubkey(), kp, ku, 1_000_000_000, 900_000_000));
    let e = w.env.send(&ixs, &[&keeper]).unwrap_err();
    assert_eq!(format!("{:?}", e.err), format!("InstructionError(2, Custom({}))", code(CoreError::Depegged)), "klend prices it, the program refuses it");
}

/// `set_pyusd_sleeve`: admin only, the vault PDA's PYUSD ATA only, not while PYUSD policies are live.
#[test]
fn set_pyusd_sleeve_checks() {
    let mut w = world(145);
    let a = w.env.admin.pubkey();
    let other = w.env.funded();
    let ix = w.env.ix_set_pyusd_sleeve(&other.pubkey(), Env::sleeve_key());
    let e = w.env.send(&[ix], &[&other]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::Unauthorized).to_string()), "{:?}", e.err);
    // A PYUSD account of the vault that is not its ATA.
    let k = Pubkey::new_unique();
    let mut acct = w.env.svm.get_account(&Env::sleeve_key()).unwrap();
    acct.data[64..72].copy_from_slice(&0u64.to_le_bytes());
    w.env.svm.set_account(k, acct).unwrap();
    let ix = w.env.ix_set_pyusd_sleeve(&a, k);
    let e = w.env.send_admin(&[ix]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::InvalidParam).to_string()), "{:?}", e.err);
    // Not while PYUSD policies are live.
    buy_multi(&mut w).unwrap();
    w.env.svm.expire_blockhash();
    let ix = w.env.ix_set_pyusd_sleeve(&a, Env::sleeve_key());
    let e = w.env.send_admin(&[ix]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::InvalidParam).to_string()), "{:?}", e.err);
}

/// An obligation already at or past klend's threshold (D ≥ Σ C′) is refused: klend acts before any weekend move.
#[test]
fn buy_cover_multi_refuses_a_liquidatable_obligation() {
    let mut w = world(170);
    let e = buy_multi(&mut w).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::AlreadyLiquidatable).to_string()), "{:?}", e.err);
}

/// Audit A-43: a PYUSD policy stays a PYUSD policy when the admin changes `Config.pyusd_mint` (its own `borrow_mint`
/// decides where it is paid from), so it still settles from the sleeve and releases its reservation.
#[test]
fn a43_pyusd_policy_settles_after_the_config_mint_changes() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap();
    let a = w.env.admin.pubkey();
    let mut p = shield_params(a, a);
    p.pyusd_mint = Pubkey::default();
    let ix = w.env.ix_set_params(&a, p);
    w.env.send_admin(&[ix]).unwrap();
    close_all(&mut w.env, &["SPYx", "NVDAx"]);
    open_all(&mut w.env, &[("SPYx", -0.15), ("NVDAx", -0.25)]);
    let owner_pyusd = w.env.pyusd_account(&w.multi.pubkey(), 0);
    settle_multi(&mut w, multi_policy(), owner_pyusd).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    assert_eq!(w.env.anchor::<Vault>(&vault_pda()).pyusd_reserved, 0);
    assert_inv14(&w.env);
}

/// Audit A-45: the legs must follow the obligation's deposit order (leg 0 = its first xStock deposit). Otherwise
/// [NVDAx, SPYx] and [SPYx, NVDAx] seed two policy PDAs and the same debt could be covered twice in one weekend.
#[test]
fn a45_legs_out_of_deposit_order_are_refused() {
    let mut w = world(145);
    let k = w.multi.pubkey();
    let debt = debt_of(&w.env, &sn::OB_MULTI);
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    ixs.push(w.env.ix_buy_cover_multi(&k, w.multi_usdc, sn::OB_MULTI, &["NVDAx", "SPYx"], GROUP_OCT9, debt / 2, u64::MAX, true));
    let e = w.env.send(&ixs, &[&w.multi]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::InvalidParam).to_string()), "{:?}", e.err);
    buy_multi(&mut w).unwrap(); // [SPYx, NVDAx]: the deposit order
}

/// `settle_policy_to_wallet` for a PYUSD policy with the USDC fallback accounts (A-44).
fn ix_to_wallet_with_cash(w: &World, caller: &Pubkey, owner_pyusd: Pubkey, owner_usdc: Pubkey) -> anchor_lang::solana_program::instruction::Instruction {
    let p: Policy = w.env.anchor(&multi_policy());
    let mut metas = credence_core::accounts::SettlePolicyToWallet {
        caller: *caller,
        config: config_pda(),
        epoch: p.epoch,
        policy: multi_policy(),
        loss: loss_pda(GROUP_OCT9),
        vault: vault_pda(),
        vault_usdc: Env::sleeve_key(),
        owner_usdc: owner_pyusd,
        usdc_mint: PYUSD_MINT,
        token_program: TOKEN_2022_PROGRAM,
        cash: Some(vault_usdc_pda()),
        owner_cash: Some(owner_usdc),
        cash_mint: Some(USDC_MINT),
        cash_token_program: Some(TOKEN_PROGRAM),
    }
    .to_account_metas(None);
    metas.extend(w.env.leg_epochs(&p).into_iter().map(|e| anchor_lang::solana_program::instruction::AccountMeta::new_readonly(e, false)));
    anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        credence_core::ID,
        &anchor_lang::InstructionData::data(&credence_core::instruction::SettlePolicyToWallet {}),
        metas,
    )
}

/// Audit A-44: a PYUSD payout above what the sleeve holds (a weekend beyond every stress scenario, or the sleeve
/// drained) must not keep the group live forever. After the grace period the wallet fallback pays what the sleeve
/// holds in PYUSD and the rest in USDC from the vault's cash (PYUSD at par), and the group releases.
#[test]
fn a44_payout_above_the_sleeve_still_settles() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap();
    close_all(&mut w.env, &["SPYx", "NVDAx"]);
    open_all(&mut w.env, &[("SPYx", -0.30), ("NVDAx", -0.40)]);
    w.env.set_token_amount(&Env::sleeve_key(), 1_000_000_000); // 1,000 PYUSD left
    let owner_pyusd = w.env.pyusd_account(&w.multi.pubkey(), 0);
    let owner_usdc0 = w.env.token_balance(&w.multi_usdc);
    w.env.set_time(OCT12_OPEN + 301 + 3_601);
    let keeper = w.env.funded();
    let ix = ix_to_wallet_with_cash(&w, &keeper.pubkey(), owner_pyusd, w.multi_usdc);
    w.env.send(&[ix], &[&keeper]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let p: Policy = w.env.anchor(&multi_policy());
    assert_eq!(p.state, policy_state::SETTLED);
    assert_eq!(w.env.token_balance(&owner_pyusd), 1_000_000_000, "the sleeve paid what it held");
    assert_eq!(w.env.token_balance(&w.multi_usdc) - owner_usdc0, p.payout - 1_000_000_000, "the rest in USDC");
    assert_eq!(w.env.anchor::<Vault>(&vault_pda()).pyusd_reserved, 0);
}

/// Audit A-46: surplus PYUSD goes back to USDC. The keeper buys it from the sleeve at no less than klend's price less
/// the slippage bound; the sleeve keeps every live reservation (INV-14); equity moves by the swap's difference. One
/// failure per check: price, INV-14, not the keeper, reserve not refreshed.
#[test]
fn a46_drain_sleeve_returns_surplus_pyusd() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap(); // reserves part of the 400k sleeve
    let keeper = w.env.admin.insecure_clone();
    let kp = w.env.pyusd_account(&keeper.pubkey(), 0);
    let ku = w.env.usdc_account(&keeper.pubkey(), 500_000_000_000);
    let drain = |w: &mut World, k: &Keypair, kp: Pubkey, ku: Pubkey, out: u64, inn: u64, refresh: bool| {
        w.env.svm.warp_to_slot(w.env.slot() + 1);
        w.env.freshen_scope();
        let mut ixs = if refresh { vec![sn::refresh_reserve(sn::RESERVE_PYUSD)] } else { vec![] };
        ixs.push(w.env.ix_drain_sleeve(&k.pubkey(), kp, ku, out, inn));
        w.env.send(&ixs, &[k])
    };
    let has = |r: TxResult, e: CoreError| {
        let s = format!("{:?}", r.unwrap_err().err);
        assert!(s.contains(&code(e).to_string()), "want {e:?}: {s}");
    };
    let v: Vault = w.env.anchor(&vault_pda());
    let surplus = sleeve_balance(&w.env) - (v.pyusd_reserved - v.pyusd_advanced);
    // Below klend's price less 30 bps.
    has(drain(&mut w, &keeper, kp, ku, 100_000_000_000, 99_000_000_000, true), CoreError::SlippageTooHigh);
    // Into the reservation.
    has(drain(&mut w, &keeper, kp, ku, surplus + 1, surplus + 1, true), CoreError::SleeveShort);
    // Reserve not refreshed.
    has(drain(&mut w, &keeper, kp, ku, 1_000_000, 1_000_000, false), CoreError::ReserveNotRefreshed);
    // Not the keeper.
    let other = w.env.funded();
    let op = w.env.pyusd_account(&other.pubkey(), 0);
    let ou = w.env.usdc_account(&other.pubkey(), 10_000_000_000);
    has(drain(&mut w, &other, op, ou, 1_000_000, 1_000_000, true), CoreError::Unauthorized);
    // The whole surplus at par.
    let (eq0, cash0) = (v.equity, w.env.token_balance(&vault_usdc_pda()));
    drain(&mut w, &keeper, kp, ku, surplus, surplus, true).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    assert_eq!(w.env.token_balance(&kp), surplus);
    assert_eq!(w.env.token_balance(&vault_usdc_pda()) - cash0, surplus);
    assert_eq!(w.env.anchor::<Vault>(&vault_pda()).equity, eq0);
    assert_inv14(&w.env);
}

fn ix_refund_multi(w: &World, caller: &Pubkey, with_legs: bool) -> anchor_lang::solana_program::instruction::Instruction {
    let mut ix = w.env.ix_refund(caller, multi_policy(), w.multi_usdc);
    if with_legs {
        let p: Policy = w.env.anchor(&multi_policy());
        ix.accounts.extend(w.env.leg_epochs(&p).into_iter().map(|e| anchor_lang::solana_program::instruction::AccountMeta::new_readonly(e, false)));
    }
    ix
}

/// Audit A-47: a voided leg counts flat whichever leg it is. With leg 0 (SPYx) voided and NVDAx settled −30%, the
/// policy settles on NVDAx's gap (SPYx flat) instead of being refunded; a refund is refused while a leg settled.
#[test]
fn a47_voided_leg_zero_counts_flat_and_the_rest_pays() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap();
    close_all(&mut w.env, &["NVDAx"]); // SPYx (leg 0) never closes
    let caller = w.env.funded();
    w.env.set_time(OCT9_CLOSE + 7 * 3600);
    let void = w.env.ix_void_epoch(&caller.pubkey(), ticker("SPYx"), GROUP_OCT9);
    w.env.send(&[void], &[&caller]).unwrap();
    open_all(&mut w.env, &[("NVDAx", -0.30)]);
    let refund = ix_refund_multi(&w, &caller.pubkey(), true);
    assert!(w.env.send(&[refund], &[&caller]).is_err(), "no refund while a leg settled");
    let owner_pyusd = w.env.pyusd_account(&w.multi.pubkey(), 0);
    settle_multi(&mut w, multi_policy(), owner_pyusd).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let p: Policy = w.env.anchor(&multi_policy());
    let e1: Epoch = w.env.anchor(&epoch_pda(&ticker("NVDAx"), GROUP_OCT9));
    let legs = [
        pricing::LegPrice { covered: p.leg_covered[0], close_wad: 1, price_wad: 1 },
        pricing::LegPrice { covered: p.leg_covered[1], close_wad: e1.close_price_wad, price_wad: e1.settle_price_wad },
    ];
    assert_eq!(p.state, policy_state::SETTLED);
    assert_eq!(p.payout, pricing::realized_payout_multi(&legs, 0, accrued_debt_now(&w.env, &p), p.max_payout).unwrap());
}

/// Audit A-47: every leg voided → the premium is refunded (the legs' epochs passed and checked).
#[test]
fn a47_all_legs_voided_refunds() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap();
    let caller = w.env.funded();
    w.env.set_time(OCT9_CLOSE + 7 * 3600);
    for t in ["SPYx", "NVDAx"] {
        let void = w.env.ix_void_epoch(&caller.pubkey(), ticker(t), GROUP_OCT9);
        w.env.send(&[void], &[&caller]).unwrap();
    }
    let usdc0 = w.env.token_balance(&w.multi_usdc);
    let refund = ix_refund_multi(&w, &caller.pubkey(), true);
    w.env.send(&[refund], &[&caller]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let p: Policy = w.env.anchor(&multi_policy());
    assert_eq!(p.state, policy_state::REFUNDED);
    assert_eq!(w.env.token_balance(&w.multi_usdc) - usdc0, p.premium - p.fee);
    assert_eq!(w.env.anchor::<Vault>(&vault_pda()).pyusd_reserved, 0);
}

/// Audit A-47: with leg 0 voided (no settlement time of its own) the wallet fallback still waits `SETTLE_GRACE` after
/// the other legs settled, so a caller cannot route the payout past the obligation right after the open.
#[test]
fn a47_wallet_fallback_waits_for_the_settled_legs() {
    let mut w = world(145);
    buy_multi(&mut w).unwrap();
    close_all(&mut w.env, &["NVDAx"]);
    let caller = w.env.funded();
    w.env.set_time(OCT9_CLOSE + 7 * 3600);
    let void = w.env.ix_void_epoch(&caller.pubkey(), ticker("SPYx"), GROUP_OCT9);
    w.env.send(&[void], &[&caller]).unwrap();
    open_all(&mut w.env, &[("NVDAx", -0.30)]);
    let owner_pyusd = w.env.pyusd_account(&w.multi.pubkey(), 0);
    let ix = ix_to_wallet_with_cash(&w, &caller.pubkey(), owner_pyusd, w.multi_usdc);
    let e = w.env.send(&[ix], &[&caller]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::TooEarly).to_string()), "{:?}", e.err);
}

/// Audit A-48: `quote_cover_multi` refuses what `buy_cover_multi` refuses (a disabled asset, gap factors stale against
/// the asset's σ), so the app never shows a premium the purchase would not charge.
#[test]
fn a48_quote_refuses_what_the_buy_refuses() {
    let mut w = world(145);
    let payer = w.env.funded();
    let d = debt_of(&w.env, &sn::OB_MULTI);
    let a = w.env.admin.pubkey();
    let mut p = real_asset_params(2);
    p.enabled = false;
    let ix = w.env.ix_update_asset(&a, ticker("NVDAx"), p);
    w.env.send_admin(&[ix]).unwrap();
    let q = w.env.ix_quote_cover_multi(&["SPYx", "NVDAx"], vec![d / 2, d / 2], 0, d, d / 2);
    let e = w.env.send(&[q], &[&payer]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::AssetDisabled).to_string()), "{:?}", e.err);
    let mut p = real_asset_params(2);
    p.sigma_wad += 1_000_000_000_000_000; // σ changed, gap factors not recomputed
    let ix = w.env.ix_update_asset(&a, ticker("NVDAx"), p);
    w.env.send_admin(&[ix]).unwrap();
    w.env.svm.expire_blockhash();
    let q = w.env.ix_quote_cover_multi(&["SPYx", "NVDAx"], vec![d / 2, d / 2], 0, d, d / 2);
    let e = w.env.send(&[q], &[&payer]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::StaleGapFactors).to_string()), "{:?}", e.err);
}

/// Audit A-63: multi-collateral cover prices on the WEEKEND set, σ and 3 days, without the earnings bump, so it is
/// refused on any other closure type and for an asset with an earnings calendar (those sell through `buy_cover`).
#[test]
fn a63_multi_refuses_other_closures_and_earnings() {
    let mut w = world(145);
    let a = w.env.admin.pubkey();
    let ix = w.env.ix_open_group(&a, 20261008);
    w.env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    for t in ["SPYx", "NVDAx"] {
        let ix = w.env.ix_open_epoch(&a, ticker(t), 20261008);
        w.env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    }
    let k = w.multi.pubkey();
    let debt = debt_of(&w.env, &sn::OB_MULTI) + 1;
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    ixs.push(w.env.ix_buy_cover_multi(&k, w.multi_usdc, sn::OB_MULTI, &["SPYx", "NVDAx"], 20261008, debt / 2, u64::MAX, true));
    let e = w.env.send(&ixs, &[&w.multi]).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::UnsupportedClosure).to_string()), "{:#?}", e.meta.logs);
    // An earnings calendar on NVDAx (leg 1): refused on the weekend too.
    let ix = ix_set_earnings(&a, "NVDAx", 3 * WAD, vec![OCT9_CLOSE + 86_400]);
    w.env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let e = buy_multi(&mut w).unwrap_err();
    assert!(format!("{:?}", e.err).contains(&code(CoreError::UnsupportedClosure).to_string()), "{:#?}", e.meta.logs);
    // Cleared (no releases): sold again.
    let ix = ix_set_earnings(&a, "NVDAx", WAD, vec![]);
    w.env.send_admin(&[ix]).unwrap();
    buy_multi(&mut w).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
}

// ---- C2: book legs on multi-collateral and PYUSD positions ----

fn book_open(w: &mut World, payer: &Keypair, payer_usdc: Pubkey) -> Pubkey {
    let ix = w.env.ix_open_book(&payer.pubkey(), payer_usdc, GROUP_OCT9, 1);
    w.env.send(&[ix], &[payer]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    book_pda(&payer.pubkey(), GROUP_OCT9, 1)
}

/// A curator's book holds the two-leg PYUSD position and the one-leg PYUSD position (full cover): the sleeve
/// reservation is booked per leg (INV-14), the book is sealed in USDC, a −15% / −25% Monday pays the multi leg from
/// the sleeve into its obligation, nothing to any wallet; the one-leg position's owner released it before the bell
/// (owner precedence on a PYUSD leg), which took its sleeve reservation with it.
#[test]
fn book_multi_and_pyusd_legs() {
    let mut w = world(145);
    // The one-leg position at its own debt (×1.45 puts it past its threshold).
    let mut d = w.env.data(&sn::OB_SINGLE);
    ob::scale_debt(&mut d, 100, 145);
    w.env.put_klend(sn::OB_SINGLE, d);
    let payer = w.env.funded();
    let payer_usdc = w.env.usdc_account(&payer.pubkey(), 1_000_000_000_000);
    let b = book_open(&mut w, &payer, payer_usdc);
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    ixs.push(w.env.ix_add_book_leg_multi(&payer.pubkey(), payer_usdc, b, sn::OB_MULTI, &["SPYx", "NVDAx"], GROUP_OCT9));
    let r = w.env.send(&ixs, &[&payer]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("add_book_leg_multi (2 legs, PYUSD): program {} CU, transaction {} CU", program_cu(&r.logs), r.compute_units_consumed);
    let mut ixs = sn::refreshes(sn::OB_SINGLE);
    ixs.push(w.env.ix_add_book_leg_multi(&payer.pubkey(), payer_usdc, b, sn::OB_SINGLE, &["SPYx"], GROUP_OCT9));
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    let r = w.env.send(&ixs, &[&payer]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("add_book_leg_multi (1 leg, PYUSD): program {} CU, transaction {} CU", program_cu(&r.logs), r.compute_units_consumed);
    assert_inv14(&w.env);
    let p: Policy = w.env.anchor(&multi_policy());
    assert_eq!((p.n_legs, p.borrow_mint, p.owner, p.max_payout), (2, PYUSD_MINT, Pubkey::default(), p.debt));
    let v: Vault = w.env.anchor(&vault_pda());
    let single_leg = policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &sn::OB_SINGLE);
    let ps: Policy = w.env.anchor(&single_leg);
    assert_eq!(v.pyusd_reserved, p.worst_loss + ps.worst_loss);

    // The one-leg position's owner takes it back before the bell (and could buy its own cover in the same transaction).
    let mut ixs = sn::refreshes(sn::OB_SINGLE);
    ixs.push(w.env.ix_release_book_leg_multi(&w.single.pubkey(), single_leg));
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    let single = w.single.insecure_clone();
    w.env.send(&ixs, &[&single]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let v: Vault = w.env.anchor(&vault_pda());
    assert_eq!(v.pyusd_reserved, p.worst_loss, "the released leg's sleeve reservation went with it");
    assert_inv14(&w.env);

    let ix = w.env.ix_seal_book(&payer.pubkey(), payer_usdc, b, u64::MAX);
    w.env.send(&[ix], &[&payer]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let bk: Book = w.env.zc(&b);
    println!("book (1 multi leg after the release): premium {} USDC base units, loading {}", bk.premium, bk.sum_loading);

    close_all(&mut w.env, &["SPYx", "NVDAx"]);
    open_all(&mut w.env, &[("SPYx", -0.15), ("NVDAx", -0.25)]);
    let owner_pyusd = w.env.pyusd_account(&w.multi.pubkey(), 0);
    let (debt0, sleeve0, payer0, owner_usdc0) =
        (debt_of(&w.env, &sn::OB_MULTI), sleeve_balance(&w.env), w.env.token_balance(&payer_usdc), w.env.token_balance(&w.multi_usdc));
    let keeper = w.env.funded();
    let mut ixs = sn::refreshes(sn::OB_MULTI);
    ixs.push(w.env.ix_settle_book_leg_pyusd(&keeper.pubkey(), multi_policy()));
    let r = w.env.send(&ixs, &[&keeper]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("settle_book_leg (2 legs, PYUSD): program {} CU", program_cu(&r.logs));
    let p: Policy = w.env.anchor(&multi_policy());
    assert_eq!(p.state, policy_state::SETTLED);
    assert!(p.payout > 0 && p.payout <= p.max_payout, "INV-1");
    assert_eq!(sleeve0 - sleeve_balance(&w.env), p.payout, "paid from the sleeve");
    assert!(debt_of(&w.env, &sn::OB_MULTI) < debt0, "into the obligation");
    assert_eq!(
        (w.env.token_balance(&owner_pyusd), w.env.token_balance(&w.multi_usdc), w.env.token_balance(&payer_usdc)),
        (0, owner_usdc0, payer0),
        "no wallet paid"
    );
    let v: Vault = w.env.anchor(&vault_pda());
    assert_eq!((v.pyusd_reserved, v.pyusd_advanced), (0, 0));
    assert_inv14(&w.env);
    let l: LossVector = w.env.zc(&loss_pda(GROUP_OCT9));
    assert_eq!(l.settled, 1);
}
