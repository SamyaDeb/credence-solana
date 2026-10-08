//! W1: `shield_advance` with the real klend program (LiteSVM snapshot, `common::kl`), settlement net of advances, and
//! the shield loading in the premium. Lifecycle: refreshes + `buy_cover` on `47wNsqpy…` (debt scaled toward its
//! threshold) → `snapshot_close` → Sunday night: the push account's fair value drops → refreshes + `shield_advance`
//! (repay v2 CPI signed by the vault PDA) → `post_settlement` → refreshes + `settle_policy`. Named invariant tests
//! INV-9 to INV-11; one failure test per check of the instruction.

mod common;

use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction, AnchorDeserialize, InstructionData, ToAccountMetas};
use common::*;
use credence_core::{accounts as acc, instruction as ix, math::WAD as WAD128, pricing, state::*, ConfigParams, CoreError, Quote};
use credence_risk_core::{shield_loading, ShieldLoadingParams, SliceZ};
use solana_keypair::Keypair;
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000;
const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;
/// Sunday 20:00 ET and Monday 07:00 ET before the Oct 12 open (the default window).
const WINDOW_START: i64 = OCT12_OPEN - 48_600;
const DEADLINE: i64 = OCT12_OPEN - 9_000;
const SPY_CLOSE: f64 = 777.05;
const MULT: f64 = 1.0057;

struct World {
    env: Env,
    owner: Keypair,
    owner_usdc: Pubkey,
    policy: Pubkey,
    feed: [u8; 32],
    /// Friday close per token, USD (as stored on the epoch).
    close: f64,
}

/// Shield on (W1 defaults); cover bought on the snapshot obligation with its debt scaled by `debt_num / 100`
/// (127 ≈ D/C′ 0.96); the Friday close stored. The clock is then Friday after the close.
fn world(debt_num: u128) -> World {
    let mut env = Env::real(LP);
    let a = env.admin.pubkey();
    let ix = env.ix_set_params(&a, shield_params(a, a));
    env.send_admin(&[ix]).unwrap();
    let owner = env.funded();
    env.load_klend_with(&owner.pubkey(), |d| ob::scale_debt(d, debt_num, 100));
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
        max_payout: debt,
        max_premium: u64::MAX,
    }));
    env.send(&ixs, &[&owner]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let policy = policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &OBLIGATION_47WN);
    let asset: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    env.set_time(OCT9_CLOSE + 30);
    let p = env.put_price(&Px::new(asset.feed_equity, SPY_CLOSE, OCT9_CLOSE - 1));
    let x = env.put_price(&Px::new(asset.feed_xstock, SPY_CLOSE * MULT, OCT9_CLOSE - 300));
    let snap = env.ix_snapshot(&a, "SPYx", GROUP_OCT9, p, Some(x));
    env.send_admin(&[snap]).unwrap();
    let e: Epoch = env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    World { env, owner, owner_usdc, policy, feed: asset.feed_xstock, close: e.close_price_wad as f64 / 1e18 }
}

/// Puts a fair value `close × (1 + f)` in the asset's push account, published `age` seconds before `at` (the time the
/// shield will read it; the clock is moved there).
fn fair(w: &mut World, f: f64, age: i64, at: i64) -> Pubkey {
    w.env.set_time(at);
    w.env.put_push(&Px::new(w.feed, w.close * (1.0 + f), at - age))
}

/// Refreshes + `shield_advance` signed by `keeper` at time `t`; the transaction's result.
fn advance(w: &mut World, keeper: &Keypair, t: i64, price: Pubkey) -> TxResult {
    w.env.set_time(t);
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_shield(&keeper.pubkey(), w.policy, price));
    w.env.send(&ixs, &[keeper])
}

/// The program's own CU for this instruction, from the runtime log line of its top-level invocation.
fn program_cu(logs: &[String]) -> u64 {
    let id = credence_core::ID.to_string();
    logs.iter()
        .filter_map(|l| l.strip_prefix(&format!("Program {id} consumed ")))
        .filter_map(|r| r.split(' ').next()?.parse().ok())
        .max()
        .unwrap_or(0)
}

/// Stores the Monday open at `close × (1 + r)` (equity source, cross-checked) and moves past the window.
fn settle_price(w: &mut World, r: f64) {
    let a = w.env.admin.pubkey();
    let open = SPY_CLOSE * (1.0 + r);
    let u = w.env.put_price(&Px::new(w.env.zc::<AssetConfig>(&asset_pda(&ticker("SPYx"))).feed_equity, open, OCT12_OPEN + 30));
    let x = w.env.put_price(&Px::new(w.feed, open * MULT, OCT12_OPEN + 60));
    w.env.set_time(OCT12_OPEN + 301);
    let post = w.env.ix_post(&a, "SPYx", GROUP_OCT9, &[u], Some(x));
    w.env.send_admin(&[post]).unwrap();
    w.env.svm.warp_to_slot(w.env.slot() + 10);
    w.env.freshen_scope();
}

fn settle(w: &mut World) -> TxResult {
    let keeper = w.env.funded();
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_settle(&keeper.pubkey(), w.policy, w.owner_usdc, true));
    w.env.send(&ixs, &[&keeper])
}

fn target(w: &World, f: f64) -> u64 {
    let p: Policy = w.env.anchor(&w.policy);
    let e: Epoch = w.env.anchor(&p.epoch);
    let c: Config = w.env.anchor(&config_pda());
    let fair = ((w.close * (1.0 + f)) * 1e8).round() as u128 * 10_000_000_000;
    // Sized on the debt with klend's interest since purchase (task 1.2), capped at the policy's reserved worst-case
    // loss (INV-12, A-32). Call it after the transaction that refreshed the reserve.
    pricing::shield_target(p.covered_value, accrued_debt_now(&w.env, &p), p.max_payout, e.close_price_wad, fair, &pricing::ShieldParams::from_config(&c))
        .unwrap()
        .min(p.worst_loss)
}

/// The money shot at the instruction level: Sunday 21:00 ET the fair value is −8%; the shield repays the target into
/// the obligation (debt falls by it, the vault's cash and equity fall by it, the owner's wallet is untouched), and a
/// keeper retry is a no-op.
#[test]
fn shield_advance_repays_into_obligation_before_the_move() {
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    let px = fair(&mut w, -0.08, 600, WINDOW_START + 3600);
    let want = target(&w, -0.08);
    let p: Policy = w.env.anchor(&w.policy);
    println!("D {} C′ {} cap {} → target at −8% {want} (α·cap {})", p.debt, p.covered_value, p.max_payout, p.max_payout / 2);
    assert!(want > 0 && want < p.max_payout / 2, "an advance below α·cap");

    w.env.send(&kl::refreshes(), &[&keeper]).unwrap();
    let debt0 = kl::debt_sf(&w.env);
    let cash0 = w.env.token_balance(&vault_usdc_pda());
    let v0: Vault = w.env.anchor(&vault_pda());
    let wallet0 = w.env.token_balance(&w.owner_usdc);
    let m = advance(&mut w, &keeper, WINDOW_START + 3600, px).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("refreshes + shield_advance: {} CU (transaction), {} CU (shield_advance incl. repay CPI)", m.compute_units_consumed, program_cu(&m.logs));
    assert!(m.compute_units_consumed < 1_400_000 && program_cu(&m.logs) < 900_000);
    let want = target(&w, -0.08); // on the reserve's index as the advance's refresh left it

    let p: Policy = w.env.anchor(&w.policy);
    assert_eq!(p.advanced, want);
    assert_eq!(p.advanced_at, WINDOW_START + 3600);
    assert_eq!(w.env.token_balance(&vault_usdc_pda()), cash0 - want);
    let v: Vault = w.env.anchor(&vault_pda());
    assert_eq!(v.equity, v0.equity - want, "the advance is an early payout: equity drops now");
    let fell = (debt0 - kl::debt_sf(&w.env)) >> 60;
    assert!(fell.abs_diff(want as u128) <= 1, "debt fell {fell}, advanced {want}");
    assert_eq!(w.env.token_balance(&w.owner_usdc), wallet0, "nothing to the owner's wallet");

    // Retry with the same price (and one slot later): nothing moves.
    let again = advance(&mut w, &keeper, WINDOW_START + 3660, px).unwrap();
    assert_eq!(w.env.anchor::<Policy>(&w.policy).advanced, want);
    assert_eq!(w.env.token_balance(&vault_usdc_pda()), cash0 - want);
    println!("idempotent retry: {} CU", again.compute_units_consumed);
}

/// Settlement after an advance pays only the remainder: open −10% → payout rule F > advanced A; the obligation gets
/// F − A at settlement, and the policy's total payout is F. INV-10.
#[test]
fn settlement_pays_the_remainder_net_of_the_advance() {
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    let px = fair(&mut w, -0.08, 600, WINDOW_START + 3600);
    advance(&mut w, &keeper, WINDOW_START + 3600, px).unwrap();
    let a = w.env.anchor::<Policy>(&w.policy).advanced;
    settle_price(&mut w, -0.10);
    let cash0 = w.env.token_balance(&vault_usdc_pda());
    settle(&mut w).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let f = payout_into_obligation(&w.env, &w.policy);
    assert!(f > a, "the open fell further than the fair value: F {f} > A {a}");
    let p: Policy = w.env.anchor(&w.policy);
    assert_eq!(p.payout, f, "advance + remainder = the payout rule");
    assert_eq!(cash0 - w.env.token_balance(&vault_usdc_pda()), f - a, "settlement paid only F − A");
    assert!(p.advanced + (f - a) <= p.max_payout, "INV-10");
    let e: Epoch = w.env.anchor(&p.epoch);
    assert_eq!(e.total_payout, f);
}

/// When the open is kinder than the weekend fair value (fair −8%, open +1%), the payout rule is 0: settlement pays
/// nothing and the advance stays the vault's loss (booked in equity at the advance); the group still releases.
#[test]
fn an_advance_above_the_payout_is_the_vaults_loss() {
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    let px = fair(&mut w, -0.08, 600, WINDOW_START + 3600);
    advance(&mut w, &keeper, WINDOW_START + 3600, px).unwrap();
    let a = w.env.anchor::<Policy>(&w.policy).advanced;
    let v0: Vault = w.env.anchor(&vault_pda());
    settle_price(&mut w, 0.01);
    let cash0 = w.env.token_balance(&vault_usdc_pda());
    settle(&mut w).unwrap();
    let p: Policy = w.env.anchor(&w.policy);
    assert_eq!((p.state, p.payout), (policy_state::SETTLED, a));
    assert_eq!(w.env.token_balance(&vault_usdc_pda()), cash0, "nothing more paid");
    let v: Vault = w.env.anchor(&vault_pda());
    let l: LossVector = w.env.zc(&loss_pda(GROUP_OCT9));
    assert_eq!(v.live_groups, 0);
    assert_eq!(v.equity, v0.equity + l.premiums, "premiums released; the advance stays out of equity");
}

/// INV-9: advances never exceed α × max_payout, however far the fair value falls and however often the keeper tops
/// up; a lower fair value later in the window adds to the advance.
#[test]
fn inv9_advanced_never_exceeds_alpha_cap() {
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    let alpha_cap = (w.env.anchor::<Policy>(&w.policy).max_payout as u128 * WAD128 / 2 / WAD128) as u64;
    let mut last = 0;
    for (i, f) in [-0.03, -0.06, -0.12, -0.25, -0.40, -0.60].iter().enumerate() {
        let px = fair(&mut w, *f, 60, WINDOW_START + 600 * (i as i64 + 1));
        advance(&mut w, &keeper, WINDOW_START + 600 * (i as i64 + 1), px).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
        let p: Policy = w.env.anchor(&w.policy);
        assert!(p.advanced <= alpha_cap, "INV-9 at fair {f}: {} > {alpha_cap}", p.advanced);
        assert!(p.advanced >= last, "advances only grow");
        last = p.advanced;
    }
    let worst = w.env.anchor::<Policy>(&w.policy).worst_loss;
    assert_eq!(last, alpha_cap.min(worst), "a deep drop advances exactly min(α·cap, reserved worst loss) (INV-12)");
    // The sizing rule itself over many inputs (program function).
    for f in [-0.9f64, -0.5, -0.2, -0.08, -0.02, 0.0, 0.05] {
        assert!(target(&w, f) <= alpha_cap);
    }
}

/// INV-10: advanced + settlement payout ≤ max_payout for every open, above or below the fair value.
#[test]
fn inv10_advances_plus_settlement_never_exceed_the_cap() {
    for r in [-0.60, -0.15, -0.08, -0.02, 0.03] {
        let mut w = world(127);
        let keeper = w.env.admin.insecure_clone();
        let px = fair(&mut w, -0.20, 60, WINDOW_START + 600);
        advance(&mut w, &keeper, WINDOW_START + 600, px).unwrap();
        settle_price(&mut w, r);
        settle(&mut w).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
        let p: Policy = w.env.anchor(&w.policy);
        assert!(p.payout <= p.max_payout, "INV-10 at open {r}: {} > {}", p.payout, p.max_payout);
        assert!(p.payout >= p.advanced);
    }
}

/// INV-11: an advance only reduces the obligation's debt and never reaches a wallet. (a) Every USDC that leaves the
/// vault is debt repaid. (b) If the owner repaid nearly all debt first, klend takes only what is owed and the rest stays
/// in the vault (not the wallet). (c) A fully repaid obligation gets no advance at all.
#[test]
fn inv11_advance_only_reduces_debt_never_pays_a_wallet() {
    // (b)
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    w.env.send(&kl::refreshes(), &[&w.owner]).unwrap();
    let debt = (kl::debt_sf(&w.env) >> 60) as u64;
    let big = w.env.usdc_account(&w.owner.pubkey(), debt);
    let mut ixs = kl::refreshes();
    ixs.push(kl::repay_v2(w.owner.pubkey(), big, debt - 50_000_000));
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    w.env.send(&ixs, &[&w.owner]).unwrap();
    let outstanding = kl::debt_sf(&w.env) >> 60;
    let px = fair(&mut w, -0.08, 600, WINDOW_START + 600);
    assert!(target(&w, -0.08) as u128 > outstanding, "the target exceeds what is still owed");
    let cash0 = w.env.token_balance(&vault_usdc_pda());
    let wallet0 = w.env.token_balance(&w.owner_usdc);
    advance(&mut w, &keeper, WINDOW_START + 600, px).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let left = cash0 - w.env.token_balance(&vault_usdc_pda());
    // klend took the debt only: what was owed on Friday plus the weekend's interest (well under 0.1%), not the target.
    assert!(left as u128 >= outstanding && (left as u128) < outstanding + outstanding / 1000, "klend took the debt only: {left} vs {outstanding}");
    assert!(left < target(&w, -0.08));
    assert_eq!(w.env.anchor::<Policy>(&w.policy).advanced, left);
    assert_eq!(w.env.token_balance(&w.owner_usdc), wallet0, "nothing to the wallet");
    assert!(kl::debt_sf(&w.env) >> 60 == 0);
    // (c) now the debt is gone: a deeper fair value finds nothing to advance into.
    let px = fair(&mut w, -0.30, 60, WINDOW_START + 1200);
    // klend dropped the empty borrow, so the refresh lists the deposit reserve only (as the keeper builds it from the
    // obligation's own reserves).
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    let ixs = vec![
        kl::refresh_reserve(RESERVE_SPYX),
        kl::refresh_obligation(OBLIGATION_47WN, &[RESERVE_SPYX]),
        w.env.ix_shield(&keeper.pubkey(), w.policy, px),
    ];
    assert_err(w.env.send(&ixs, &[&keeper]), code(CoreError::NoDebtToAdvance));
    assert_eq!(w.env.token_balance(&w.owner_usdc), wallet0);
}

/// One failure test per check of the instruction.
#[test]
fn shield_advance_refuses_what_it_must() {
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    let px = fair(&mut w, -0.08, 600, WINDOW_START + 600);

    // Signer is not the keeper.
    let stranger = w.env.funded();
    assert_err(advance(&mut w, &stranger, WINDOW_START + 600, px), code(CoreError::Unauthorized));
    // Before the window and after the deadline.
    assert_err(advance(&mut w, &keeper, WINDOW_START - 1, px), code(CoreError::OutsideShieldWindow));
    assert_err(advance(&mut w, &keeper, DEADLINE + 1, px), code(CoreError::OutsideShieldWindow));
    // A genuine-looking update that is not the push account (the keeper could choose among such accounts).
    w.env.set_time(WINDOW_START + 600);
    let now = w.env.now();
    let other = w.env.put_price(&Px::new(w.feed, w.close * 0.92, now - 60));
    assert_err(advance(&mut w, &keeper, WINDOW_START + 600, other), code(CoreError::NotPushAccount));
    // Older than shield_max_age (36 h).
    let stale = fair(&mut w, -0.08, 36 * 3600 + 1, WINDOW_START + 600);
    assert_err(advance(&mut w, &keeper, WINDOW_START + 600, stale), code(CoreError::PriceOutsideWindow));
    // Partially verified.
    let mut px_partial = Px::new(w.feed, w.close * 0.92, now - 60);
    px_partial.full = false;
    let partial = w.env.put_push(&px_partial);
    assert_err(advance(&mut w, &keeper, WINDOW_START + 600, partial), code(CoreError::PriceNotVerified));
    // Confidence wider than max_conf_bps (0.5%).
    let mut px_wide = Px::new(w.feed, w.close * 0.92, now - 60);
    px_wide.conf = (px_wide.price / 100) as u64;
    let wide = w.env.put_push(&px_wide);
    assert_err(advance(&mut w, &keeper, WINDOW_START + 600, wide), code(CoreError::PriceConfidenceTooWide));
    // Paused.
    let a = w.env.admin.pubkey();
    let ix = w.env.ix_set_paused(&a, true);
    w.env.send_admin(&[ix]).unwrap();
    let px = fair(&mut w, -0.08, 60, WINDOW_START + 600);
    assert_err(advance(&mut w, &keeper, WINDOW_START + 600, px), code(CoreError::Paused));
    let ix = w.env.ix_set_paused(&a, false);
    w.env.send_admin(&[ix]).unwrap();
    // Shield off.
    let ix = w.env.ix_set_params(&a, default_params(a, a));
    w.env.send_admin(&[ix]).unwrap();
    assert_err(advance(&mut w, &keeper, WINDOW_START + 600, px), code(CoreError::ShieldOff));
    assert_eq!(w.env.anchor::<Policy>(&w.policy).advanced, 0, "nothing moved");
}

/// The epoch must hold its Friday close: before `snapshot_close` there is nothing to size against.
#[test]
fn shield_advance_needs_the_close() {
    let mut env = Env::real(LP);
    let a = env.admin.pubkey();
    let ix = env.ix_set_params(&a, shield_params(a, a));
    env.send_admin(&[ix]).unwrap();
    let owner = env.funded();
    env.load_klend_with(&owner.pubkey(), |d| ob::scale_debt(d, 127, 100));
    let owner_usdc = env.usdc_account(&owner.pubkey(), 100_000_000_000);
    let debt = (kl::debt_sf(&env) >> 60) as u64;
    let mut ixs = kl::refreshes();
    ixs.push(env.ix_buy_cover(&BuyArgs {
        buyer: owner.pubkey(), buyer_usdc: owner_usdc, obligation: OBLIGATION_47WN, deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"), closure_id: GROUP_OCT9, max_payout: debt, max_premium: u64::MAX,
    }));
    env.send(&ixs, &[&owner]).unwrap();
    let asset: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    let policy = policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &OBLIGATION_47WN);
    let mut w = World { env, owner, owner_usdc, policy, feed: asset.feed_xstock, close: SPY_CLOSE * MULT };
    let px = fair(&mut w, -0.08, 60, WINDOW_START + 600);
    let keeper = w.env.admin.insecure_clone();
    assert_err(advance(&mut w, &keeper, WINDOW_START + 600, px), code(CoreError::WrongEpochState));
}

/// Golden: the on-chain premium is `pricing::premium` + `risk-core::shield_loading` exactly (quote_cover on the real
/// SPYx set with σ_b set on the asset), and the loading is 0 with the shield off.
#[test]
fn premium_includes_the_shield_loading_golden() {
    let mut env = Env::real(LP);
    let a = env.admin.pubkey();
    let sets = json_i16(&load_json("data/onchain/SPYx-WEEKEND.json")["z"]);
    let mut params = real_asset_params(0);
    params.basis_sigma_wad = 3_000_000_000_000_000; // σ_b 0.3%
    let ix = env.ix_update_asset(&a, ticker("SPYx"), params);
    env.send_admin(&[ix]).unwrap();
    let quote = |env: &mut Env, c: u64, d: u64| -> Quote {
        let ix = Instruction::new_with_bytes(
            credence_core::ID,
            &ix::QuoteCover { covered_value: c, debt: d, max_payout: d }.data(),
            acc::QuoteCover { config: config_pda(), asset: asset_pda(&ticker("SPYx")), scenarios: scen_pda(&ticker("SPYx"), closure::WEEKEND), vault: None, loss: None, share_mint: None }
                .to_account_metas(None),
        );
        let m = env.send_admin(&[ix]).unwrap();
        Quote::deserialize(&mut &m.return_data.data[..]).unwrap()
    };
    let off = quote(&mut env, 52_083_333_333, 50_000_000_000);
    assert_eq!(off.shield_loading, 0);
    let ix = env.ix_set_params(&a, shield_params(a, a));
    env.send_admin(&[ix]).unwrap();
    let cfg: Config = env.anchor(&config_pda());
    let asset: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    for (c, d) in [(52_083_333_333u64, 50_000_000_000u64), (447_536_918, 429_611_768), (100_000_000_000, 80_000_000_000), (100_000_000_000, 99_000_000_000)] {
        let q = quote(&mut env, c, d);
        let dp = credence_risk_core::priced_debt(d, cfg.debt_growth_est_wad).unwrap(); // priced with the expected interest
        let want = shield_loading(&SliceZ(&sets), &ShieldLoadingParams {
            sigma: asset.sigma_wad, basis_sigma: asset.basis_sigma_wad, covered: c, debt: dp, cap: d,
            alpha: cfg.shield_alpha_wad, buffer: cfg.shield_buffer_wad, health: cfg.shield_health_wad, lambda: cfg.shield_lambda_wad,
            advance_cap: q.worst_loss,
        }).unwrap();
        let x = pricing::CoverInputs { covered_value: c, debt: dp, max_payout: d };
        let base = pricing::premium(&sets, &cfg, asset.sigma_wad, 0, credence_core::WEEKEND_CLOSURE_DAYS, 0, &x).unwrap();
        println!("D/C′ {:.3}: premium {} = cover {} + loading {} (E {}, {} scenarios read)", d as f64 / c as f64, q.premium, base, q.shield_loading, want.expected_loss, want.visited);
        assert_eq!(q.shield_loading, want.loading);
        assert_eq!(q.premium, base + want.loading);
    }
}

/// Compute: quote_cover (the premium and capacity path buy_cover runs) with the shield loading, worst cases near the
/// threshold on the real sets, σ_b from the basis study. Instruction < 900k CU.
#[test]
fn quote_with_shield_loading_compute_worst_case() {
    let mut env = Env::real(LP);
    let a = env.admin.pubkey();
    let ix = env.ix_set_params(&a, shield_params(a, a));
    env.send_admin(&[ix]).unwrap();
    for (i, t) in ["SPYx", "QQQx", "NVDAx"].iter().enumerate() {
        let mut params = real_asset_params(i);
        params.basis_sigma_wad = [3_020_000_000_000_000u64, 11_854_000_000_000_000, 16_490_000_000_000_000][i];
        let ix = env.ix_update_asset(&a, ticker(t), params);
        env.send_admin(&[ix]).unwrap();
        for ratio_bps in [9_600u64, 9_900, 9_950] {
            let c = 100_000_000_000u64;
            let d = c / 10_000 * ratio_bps;
            let ix = Instruction::new_with_bytes(
                credence_core::ID,
                &ix::QuoteCover { covered_value: c, debt: d, max_payout: d }.data(),
                acc::QuoteCover { config: config_pda(), asset: asset_pda(&ticker(t)), scenarios: scen_pda(&ticker(t), closure::WEEKEND), vault: None, loss: None, share_mint: None }
                    .to_account_metas(None),
            );
            let m = env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{t} {ratio_bps}: {:?}", e.err));
            let q = Quote::deserialize(&mut &m.return_data.data[..]).unwrap();
            println!("{t} D/C′ {:.3}: quote_cover with loading {} CU (premium {:.2}, loading {:.2} USDC)", ratio_bps as f64 / 1e4, m.compute_units_consumed, q.premium as f64 / 1e6, q.shield_loading as f64 / 1e6);
            assert!(m.compute_units_consumed < 900_000);
        }
    }
}

/// Audit A-21: on a reserve without a debt farm klend expects its own program id in both farm slots, and the runtime
/// demotes that id to read-only (klend is invoked in the same transaction), so a `mut` constraint on the slots made the
/// advance impossible. The USDC reserve fixture is patched to have no debt farm.
#[test]
fn a21_shield_advance_on_a_reserve_without_a_debt_farm() {
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    let mut r = w.env.svm.get_account(&RESERVE_USDC).unwrap();
    r.data[96..128].copy_from_slice(&[0u8; 32]); // Reserve.farm_debt = default
    w.env.svm.set_account(RESERVE_USDC, r).unwrap();
    let px = fair(&mut w, -0.08, 600, WINDOW_START + 600);
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_shield_farms(&keeper.pubkey(), w.policy, px, None));
    w.env.send(&ixs, &[&keeper]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    assert_eq!(w.env.anchor::<Policy>(&w.policy).advanced, target(&w, -0.08));
}

/// Audit A-25: a fair value must be from around the close or later. With `shield_max_age_secs` at its 72 h bound a
/// Friday mid-session update would be accepted on Sunday night and sized against the close it predates.
#[test]
fn a25_fair_value_must_not_predate_the_close() {
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    let a = w.env.admin.pubkey();
    let ix = w.env.ix_set_params(&a, ConfigParams { shield_max_age_secs: 72 * 3600, ..shield_params(a, a) });
    w.env.send_admin(&[ix]).unwrap();
    let t = WINDOW_START + 600;
    let old = w.env.put_push(&Px::new(w.feed, w.close * 0.92, OCT9_CLOSE - 7 * 3600)); // Friday 13:00 UTC
    assert_err(advance(&mut w, &keeper, t, old), code(CoreError::PriceOutsideWindow));
    // The last push before the close (4–14 min early on Fridays) is still accepted when nothing came after it.
    let last = w.env.put_push(&Px::new(w.feed, w.close * 0.92, OCT9_CLOSE - 600));
    advance(&mut w, &keeper, t, last).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
}

/// Audit A-26: a HALTED epoch's open moves to the next session, which would open a second shield window after
/// Monday's open, when Kamino's price is already live; the loading prices one frozen weekend only.
#[test]
fn a26_no_shield_after_a_halt() {
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    let a = w.env.admin.pubkey();
    w.env.set_time(OCT12_OPEN + 3600);
    let ix = w.env.ix_halt(&a, "SPYx", GROUP_OCT9);
    w.env.send_admin(&[ix]).unwrap();
    let tue_open = w.env.anchor::<Epoch>(&epoch_pda(&ticker("SPYx"), GROUP_OCT9)).open;
    let t = tue_open - 48_600 + 600; // inside the window the moved open would give
    let px = fair(&mut w, -0.08, 60, t);
    assert_err(advance(&mut w, &keeper, t, px), code(CoreError::WrongEpochState));
}

/// Audit A-28: an obligation that was closed (no longer a klend account) gets no advance and a clear error.
#[test]
fn a28_closed_obligation_gets_no_advance() {
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    let px = fair(&mut w, -0.08, 60, WINDOW_START + 600);
    w.env.svm.set_account(OBLIGATION_47WN, solana_account::Account { lamports: 0, data: vec![], owner: Pubkey::default(), executable: false, rent_epoch: 0 }).unwrap();
    let ix = w.env.ix_shield(&keeper.pubkey(), w.policy, px);
    assert_err(w.env.send(&[ix], &[&keeper]), code(CoreError::NoDebtToAdvance));
}

/// INV-12 (A-32): a group's advances never exceed its reserved `max_loss`, and each policy's never its `worst_loss`.
#[test]
fn inv12_group_advances_within_reserved_capacity() {
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    for (i, f) in [-0.05, -0.20, -0.60].iter().enumerate() {
        let t = WINDOW_START + 600 * (i as i64 + 1);
        let px = fair(&mut w, *f, 60, t);
        advance(&mut w, &keeper, t, px).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
        let p: Policy = w.env.anchor(&w.policy);
        let l: LossVector = w.env.zc(&loss_pda(GROUP_OCT9));
        assert!(p.advanced <= p.worst_loss, "policy advanced {} > worst {}", p.advanced, p.worst_loss);
        assert_eq!(l.advanced, p.advanced, "the group total tracks its only policy");
        assert!(l.advanced <= l.max_loss, "INV-12: group advanced {} > reserved {}", l.advanced, l.max_loss);
    }
}

/// A-32 (review, Oct 9): the vault never loses more on a weekend group than the worst-case loss it reserved for it
/// (INV-2 in spirit). A covered borrower or a thin weekend market pushes the 24/7 fair value far down (−40%), the
/// shield advances, and the open is flat: the loss is the whole advance. Before the fix the capacity vector held only
/// settlement losses, so the advance could exceed the group's reserved `max_loss` many times over.
#[test]
fn a32_shield_loss_never_exceeds_the_groups_reserved_capacity() {
    let mut w = world(127);
    let keeper = w.env.admin.insecure_clone();
    let reserved = w.env.zc::<LossVector>(&loss_pda(GROUP_OCT9)).max_loss;
    let px = fair(&mut w, -0.40, 60, WINDOW_START + 3600);
    let _ = advance(&mut w, &keeper, WINDOW_START + 3600, px);
    let p: Policy = w.env.anchor(&w.policy);
    assert!(
        p.advanced <= reserved,
        "shield advanced {} USDC base units against {} reserved for the group",
        p.advanced,
        reserved
    );
}

/// Task 1.2 (A-32 follow-up): the reservation now includes the shield's own sizing (buffer included, fair value k·σ_b
/// below each joint scenario), so on a normal weekend INV-12 does not bind: at fair −5% and −8% the policy is advanced
/// the full sized target, not its old settlement-only worst loss. (A fair value beyond the worst joint scenario, about
/// −10% here, is still capped: that is INV-12 working, `inv12_…` and `a32_…`.)
#[test]
fn reservation_covers_the_full_advance_on_a_normal_weekend() {
    for f in [-0.05, -0.08] {
        let mut w = world(127);
        let keeper = w.env.admin.insecure_clone();
        let p: Policy = w.env.anchor(&w.policy);
        let e: Epoch = w.env.anchor(&p.epoch);
        let c: Config = w.env.anchor(&config_pda());
        let _ = (e, c);
        let px = fair(&mut w, f, 600, WINDOW_START + 3600);
        advance(&mut w, &keeper, WINDOW_START + 3600, px).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
        let fair_wad = ((w.close * (1.0 + f)) * 1e8).round() as u128 * 10_000_000_000;
        let e: Epoch = w.env.anchor(&p.epoch);
        let c: Config = w.env.anchor(&config_pda());
        let sized = pricing::shield_target(p.covered_value, accrued_debt_now(&w.env, &p), p.max_payout, e.close_price_wad, fair_wad, &pricing::ShieldParams::from_config(&c)).unwrap();
        println!("fair {f}: sized {sized} (debt with interest), reserved worst {}", p.worst_loss);
        assert!(p.worst_loss >= sized, "reservation {} below the sized advance {sized}", p.worst_loss);
        let p: Policy = w.env.anchor(&w.policy);
        assert_eq!(p.advanced, sized, "INV-12 must not bind on a normal weekend");
        let l: LossVector = w.env.zc(&loss_pda(GROUP_OCT9));
        assert!(l.advanced <= l.max_loss);
    }
}

/// W3 stress: with idle cash lent and the USDC reserve at 100% utilisation, the shield still advances, from cash.
#[test]
fn shield_advances_from_cash_at_full_utilisation() {
    let mut w = world(127);
    w.env.setup_yield(0);
    w.env.rebalance(false).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let v: Vault = w.env.anchor(&vault_pda());
    assert!(v.lent_value > 0);
    w.env.make_usdc_reserve_illiquid();
    let keeper = w.env.admin.insecure_clone();
    let px = fair(&mut w, -0.08, 600, WINDOW_START + 3600);
    let cash0 = w.env.token_balance(&vault_usdc_pda());
    let k0 = w.env.token_balance(&v.kusdc);
    advance(&mut w, &keeper, WINDOW_START + 3600, px).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let a = w.env.anchor::<Policy>(&w.policy).advanced;
    assert!(a > 0 && a == target(&w, -0.08));
    assert_eq!(cash0 - w.env.token_balance(&vault_usdc_pda()), a, "advanced from cash");
    assert_eq!(w.env.token_balance(&v.kusdc), k0);
}
