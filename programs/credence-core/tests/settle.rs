//! Task 2.5: `settle_policy` with the real klend program (LiteSVM snapshot, `common::kl`). The full lifecycle runs:
//! refreshes + `buy_cover` on the obligation `47wNsqpy…` → `snapshot_close` → `post_settlement` → refreshes +
//! `settle_policy` (repay v2 CPI signed by the vault PDA). INV-1 and INV-7 named tests; a −10% gap pays the expected
//! amount.

mod common;

use anchor_lang::{prelude::Pubkey, solana_program::instruction::{AccountMeta, Instruction}, InstructionData, ToAccountMetas};
use common::*;
use credence_core::{accounts as acc, instruction as ix, oracle, pricing, state::*, CoreError};
use solana_keypair::Keypair;
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000;
const OCT9_CLOSE: i64 = 1_791_576_000;
const OCT12_OPEN: i64 = 1_791_811_800;
const SPY_CLOSE: f64 = 777.05;

struct World {
    env: Env,
    owner: Keypair,
    owner_usdc: Pubkey,
    policy: Pubkey,
}

/// Lifecycle up to a settled epoch with SPY opening at `SPY_CLOSE × (1 + r)`. The obligation's debt is scaled by
/// `debt_num / 100` (100 = as on mainnet, D/C′ 0.755; 125 ≈ 0.94). Cap = `cap_pct` % of the debt.
fn world(debt_num: u128, cap_pct: u64, r: f64) -> World {
    let mut env = Env::real(LP);
    let owner = env.funded();
    env.load_klend_with(&owner.pubkey(), |d| ob::scale_debt(d, debt_num, 100));
    let owner_usdc = env.usdc_account(&owner.pubkey(), 100_000_000_000);

    // Buy: refreshes + buy_cover in one transaction (the snapshot comes from the chain).
    let mut ixs = kl::refreshes();
    let debt = (kl::debt_sf(&env) >> 60) as u64;
    let a = BuyArgs {
        buyer: owner.pubkey(),
        buyer_usdc: owner_usdc,
        obligation: OBLIGATION_47WN,
        deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"),
        closure_id: GROUP_OCT9,
        max_payout: debt * cap_pct / 100,
        max_premium: u64::MAX,
    };
    ixs.push(env.ix_buy_cover(&a));
    let m = env.send(&ixs, &[&owner]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("refreshes + buy_cover: {} CU (transaction)", m.compute_units_consumed);
    let policy = policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &owner.pubkey(), &OBLIGATION_47WN);

    // Friday close and Monday open on Pyth (equity × the mint's multiplier, cross-checked).
    let asset: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    let admin = env.admin.pubkey();
    env.set_time(OCT9_CLOSE + 30);
    let p = env.put_price(&Px::new(asset.feed_equity, SPY_CLOSE, OCT9_CLOSE - 1));
    let x = env.put_price(&Px::new(asset.feed_xstock, SPY_CLOSE * 1.0057, OCT9_CLOSE - 300));
    let tk = ticker("SPYx");
    let snap = Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SnapshotClose { ticker: tk, closure_id: GROUP_OCT9 }.data(),
        acc::SnapshotClose {
            caller: admin,
            config: config_pda(),
            asset: asset_pda(&tk),
            epoch: epoch_pda(&tk, GROUP_OCT9),
            mint: SPYX_MINT,
            price: p,
            xcheck: Some(x),
        }
        .to_account_metas(None),
    );
    env.send_admin(&[snap]).unwrap();
    let open_px = SPY_CLOSE * (1.0 + r);
    let u = env.put_price(&Px::new(asset.feed_equity, open_px, OCT12_OPEN + 30));
    let x = env.put_price(&Px::new(asset.feed_xstock, open_px * 1.0057, OCT12_OPEN + 60));
    env.set_time(OCT12_OPEN + 301);
    let mut metas = acc::PostSettlement {
        keeper: admin,
        config: config_pda(),
        asset: asset_pda(&tk),
        epoch: epoch_pda(&tk, GROUP_OCT9),
        mint: SPYX_MINT,
        xcheck: Some(x),
    }
    .to_account_metas(None);
    metas.push(AccountMeta::new_readonly(u, false));
    let post = Instruction::new_with_bytes(credence_core::ID, &ix::PostSettlement { ticker: tk, closure_id: GROUP_OCT9 }.data(), metas);
    env.send_admin(&[post]).unwrap();
    env.svm.warp_to_slot(env.slot() + 10);
    env.freshen_scope();
    World { env, owner, owner_usdc, policy }
}

fn expected_payout(env: &Env, policy: &Pubkey) -> u64 {
    let p: Policy = env.anchor(policy);
    let e: Epoch = env.anchor(&p.epoch);
    pricing::realized_payout(p.covered_value, p.debt, p.max_payout, e.close_price_wad, e.settle_price_wad).unwrap()
}

/// Settles with the refreshes in the same transaction (as the keeper does); returns the transaction's CU.
fn settle(w: &mut World, caller: &Keypair) -> TxResult {
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_settle(&caller.pubkey(), w.policy, w.owner_usdc, true));
    w.env.send(&ixs, &[caller])
}

/// Acceptance 2.5: a −10% gap on a position at D/C′ ≈ 0.94 pays the expected amount, repaid into the obligation.
#[test]
fn minus_ten_percent_gap_pays_expected_amount_into_obligation() {
    let mut w = world(125, 20, -0.10);
    let p: Policy = w.env.anchor(&w.policy);
    let want = expected_payout(&w.env, &w.policy);
    // Independent check of the rule: D − C′ × 0.9 (per-token prices; the multiplier cancels).
    let approx = p.debt as f64 - p.covered_value as f64 * 0.9;
    println!("D {} C' {} cap {} → payout {} (≈ {approx:.0})", p.debt, p.covered_value, p.max_payout, want);
    assert!(want > 0 && want < p.max_payout);
    assert!((want as f64 - approx).abs() < 2.0, "payout {want} vs D − 0.9 C′ = {approx}");

    let keeper = w.env.funded(); // anyone may settle
    w.env.send(&kl::refreshes(), &[&keeper]).unwrap();
    let debt_before = kl::debt_sf(&w.env);
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    let vault_before = w.env.token_balance(&vault_usdc_pda());
    let m = settle(&mut w, &keeper).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("refreshes + settle_policy (repay CPI): {} CU (transaction)", m.compute_units_consumed);
    assert!(m.compute_units_consumed < 1_400_000);

    let p: Policy = w.env.anchor(&w.policy);
    assert_eq!((p.state, p.payout), (policy_state::SETTLED, want));
    assert_eq!(w.env.token_balance(&vault_usdc_pda()), vault_before - want);
    assert_eq!(w.env.token_balance(&w.owner_usdc), 100_000_000_000 - p.premium, "all of it went into the obligation");
    let debt_after = kl::debt_sf(&w.env);
    // Debt fell by the payout (interest over one slot is far below one base unit).
    let fell = (debt_before - debt_after) >> 60;
    assert!(fell.abs_diff(want as u128) <= 1, "debt fell {fell}, payout {want}");
}

/// INV-1: payout ≤ max_payout, even when the gap is far larger than the cap covers.
#[test]
fn inv1_payout_never_exceeds_cap() {
    let mut w = world(125, 5, -0.30);
    let p: Policy = w.env.anchor(&w.policy);
    let uncapped = p.debt as f64 - p.covered_value as f64 * 0.7;
    assert!(uncapped > p.max_payout as f64, "the gap must exceed the cap for this test");
    let keeper = w.env.funded();
    settle(&mut w, &keeper).unwrap();
    let p: Policy = w.env.anchor(&w.policy);
    assert_eq!(p.payout, p.max_payout);
    // Property over gaps and caps with the program's own payout function.
    for cap in [1u64, 1_000_000, p.debt / 3, p.debt] {
        for r in [-0.5f64, -0.2, -0.1, -0.03, 0.0, 0.05] {
            let close = 781_000_000_000_000_000_000u128;
            let settle = (close as f64 * (1.0 + r)) as u128;
            let x = pricing::realized_payout(p.covered_value, p.debt, cap, close, settle).unwrap();
            assert!(x <= cap, "INV-1: payout {x} > cap {cap} at r {r}");
        }
    }
}

/// INV-7: a payout into an obligation only reduces its debt; if the owner repaid most of the debt meanwhile, klend
/// takes only what is owed and the rest goes to the owner's wallet in the same instruction.
#[test]
fn inv7_payout_only_reduces_debt_rest_to_wallet() {
    let mut w = world(125, 20, -0.10);
    let want = expected_payout(&w.env, &w.policy);
    // The owner repays all but 100 USDC of the debt after buying cover.
    w.env.send(&kl::refreshes(), &[&w.owner]).unwrap();
    let debt = (kl::debt_sf(&w.env) >> 60) as u64;
    let big = w.env.usdc_account(&w.owner.pubkey(), debt);
    let mut ixs = kl::refreshes();
    ixs.push(kl::repay_v2(w.owner.pubkey(), big, debt - 100_000_000));
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    w.env.send(&ixs, &[&w.owner]).unwrap();
    let outstanding = kl::debt_sf(&w.env);
    assert!(((outstanding >> 60) as u64) < want, "outstanding debt now below the payout");

    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    let wallet_before = w.env.token_balance(&w.owner_usdc);
    let keeper = w.env.funded();
    settle(&mut w, &keeper).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let after = kl::debt_sf(&w.env);
    assert!(after <= outstanding, "INV-7: debt never rises");
    assert!(after >> 60 == 0, "debt fully repaid");
    let to_wallet = w.env.token_balance(&w.owner_usdc) - wallet_before;
    let repaid = want - to_wallet;
    assert!(repaid as u128 >= outstanding >> 60 && repaid as u128 <= (outstanding >> 60) + 1, "klend took the debt");
    assert_eq!(w.env.anchor::<Policy>(&w.policy).payout, want);
}

/// A gap up pays nothing; the last policy of the group releases premiums to equity and frees capacity.
#[test]
fn gap_up_pays_zero_and_group_releases() {
    let mut w = world(125, 20, 0.02);
    assert_eq!(expected_payout(&w.env, &w.policy), 0);
    let before: Vault = w.env.anchor(&vault_pda());
    assert_eq!(before.live_groups, 1);
    let keeper = w.env.funded();
    settle(&mut w, &keeper).unwrap();
    let v: Vault = w.env.anchor(&vault_pda());
    let l: LossVector = w.env.zc(&loss_pda(GROUP_OCT9));
    assert_eq!(l.settled, 1);
    assert_eq!((v.live_groups, v.reserved_total, v.premiums_unearned), (0, 0, 0));
    assert_eq!(v.equity, before.equity + before.premiums_unearned);
    let e: Epoch = w.env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    assert_eq!((e.policies_settled, e.total_payout), (1, 0));
    // Deposits open again once no group is live.
    let (lp, u, sh) = w.env.lp(1_000_000);
    let ix = w.env.ix_deposit(&lp.pubkey(), u, sh, 1_000_000);
    w.env.send(&[ix], &[&lp]).unwrap();
}

/// A closed obligation (account gone) is paid to the owner's wallet.
#[test]
fn closed_obligation_pays_wallet() {
    let mut w = world(125, 20, -0.10);
    let want = expected_payout(&w.env, &w.policy);
    let mut a = w.env.svm.get_account(&OBLIGATION_47WN).unwrap();
    a.owner = anchor_lang::solana_program::system_program::ID;
    a.data = vec![];
    w.env.svm.set_account(OBLIGATION_47WN, a).unwrap();
    let before = w.env.token_balance(&w.owner_usdc);
    let keeper = w.env.funded();
    let ix = w.env.ix_settle(&keeper.pubkey(), w.policy, w.owner_usdc, false);
    w.env.send(&[ix], &[&keeper]).unwrap();
    assert_eq!(w.env.token_balance(&w.owner_usdc) - before, want);
}

#[test]
fn settle_policy_failures() {
    let mut w = world(125, 20, -0.10);
    let keeper = w.env.funded();
    // Obligation still has debt but no Kamino accounts: refused (the payout must follow the position).
    let ix = w.env.ix_settle(&keeper.pubkey(), w.policy, w.owner_usdc, false);
    assert_err(w.env.send(&[ix], &[&keeper]), code(CoreError::KaminoAccountsMissing));
    // Payout to someone else's USDC account.
    let other = w.env.usdc_account(&keeper.pubkey(), 0);
    let mut ixs = kl::refreshes();
    ixs.push(w.env.ix_settle(&keeper.pubkey(), w.policy, other, true));
    assert_fails(w.env.send(&ixs, &[&keeper]));
    // A repay reserve that is not the obligation's borrow.
    let mut bad = w.env.ix_settle(&keeper.pubkey(), w.policy, w.owner_usdc, true);
    let i = bad.accounts.iter().position(|m| m.pubkey == RESERVE_USDC).unwrap();
    bad.accounts[i].pubkey = RESERVE_SPYX;
    let mut ixs = kl::refreshes();
    ixs.push(bad);
    assert_err(w.env.send(&ixs, &[&keeper]), code(CoreError::InvalidParam));
    // Once, then twice.
    settle(&mut w, &keeper).unwrap();
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    assert_err(settle(&mut w, &keeper), code(CoreError::WrongEpochState));
}

/// Not before the epoch has a settlement price.
#[test]
fn settle_before_settlement_price_fails() {
    let mut env = Env::real(LP);
    let owner = env.funded();
    env.load_klend(&owner.pubkey());
    let owner_usdc = env.usdc_account(&owner.pubkey(), 100_000_000_000);
    let mut ixs = kl::refreshes();
    ixs.push(env.ix_buy_cover(&BuyArgs {
        buyer: owner.pubkey(),
        buyer_usdc: owner_usdc,
        obligation: OBLIGATION_47WN,
        deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"),
        closure_id: GROUP_OCT9,
        max_payout: 1_000_000_000,
        max_premium: u64::MAX,
    }));
    env.send(&ixs, &[&owner]).unwrap();
    let policy = policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &owner.pubkey(), &OBLIGATION_47WN);
    env.svm.warp_to_slot(env.slot() + 1);
    let mut ixs = kl::refreshes();
    ixs.push(env.ix_settle(&owner.pubkey(), policy, owner_usdc, true));
    assert_err(env.send(&ixs, &[&owner]), code(CoreError::WrongEpochState));
    let _ = oracle::source::EQUITY;
}
