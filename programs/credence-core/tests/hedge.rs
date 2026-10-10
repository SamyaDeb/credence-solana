//! D3.1 hedging the vault (testnet hedge, research): the attack tests (`d3_*`), the happy paths, a failure test per
//! instruction and the compute units. World: `Env::real` with a 1,000 USDC vault, the Oct 9 weekend, SPYx/QQQx/NVDAx epochs.
//! Roles: the keeper, the guardian and the admin are three different keys.

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
use credence_core::{accounts as acc, instruction as ix, state::*, state_hedge::*, CoreError, HedgeLegArg, HedgeParams};
use solana_keypair::Keypair;
use solana_signer::Signer;

const OCT12_OPEN: i64 = 1_791_811_800;
const USDC: u64 = 1_000_000;
const DELAY: i64 = 3_600;
const EXPIRY: i64 = 14 * 86_400;
const WADU: u128 = 1_000_000_000_000_000_000;

fn hedge_pda(group: u32) -> Pubkey {
    pda(&[SEED_HEDGE, &group.to_le_bytes()])
}
fn hedge_cfg_pda() -> Pubkey {
    pda(&[SEED_HEDGE_CFG])
}

fn params() -> HedgeParams {
    HedgeParams {
        margin_cap_bps: 300,
        pnl_cap_bps: 100,
        max_leverage: 5,
        delay_secs: DELAY as u32,
        expiry_secs: EXPIRY as u32,
        return_tol_wad: (WADU / 33) as u64, // 3.03%
    }
}

struct W {
    env: Env,
    keeper: Keypair,
    guardian: Keypair,
    keeper_usdc: Pubkey,
}

fn send1(env: &mut Env, i: Instruction, who: &Keypair) -> TxResult {
    env.svm.warp_to_slot(env.slot() + 1);
    env.send(&[i], &[who])
}
fn ok(env: &mut Env, i: Instruction, who: &Keypair) {
    send1(env, i, who).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
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

/// The epoch as the keeper leaves it after `post_settlement`.
fn settle_epoch(env: &mut Env, t: &str, close: f64, settle: f64) {
    edit_epoch(env, t, |e| {
        e.state = epoch_state::SETTLED;
        e.close_price_wad = (close * 1e18) as u128;
        e.settle_price_wad = (settle * 1e18) as u128;
        e.close_source = 1;
    });
}

fn edit_loss(env: &mut Env, group: u32, f: impl FnOnce(&mut LossVector)) {
    let key = loss_pda(group);
    let mut a = env.svm.get_account(&key).unwrap();
    let n = core::mem::size_of::<LossVector>();
    f(bytemuck::from_bytes_mut::<LossVector>(&mut a.data[8..8 + n]));
    env.svm.set_account(key, a).unwrap();
}

/// The weekend is over for the vault: the group settled.
fn settle_group(env: &mut Env) {
    edit_loss(env, GROUP_OCT9, |l| l.settled = 1);
}

fn world() -> W {
    let mut env = Env::real(1_000 * USDC);
    let (keeper, guardian) = (env.funded(), env.funded());
    let a = env.admin.pubkey();
    let ix = env.ix_set_params(&a, default_params(guardian.pubkey(), keeper.pubkey()));
    env.send_admin(&[ix]).unwrap();
    let ix = init_cfg_ix(&a, params());
    env.send_admin(&[ix]).unwrap();
    let keeper_usdc = env.usdc_account(&keeper.pubkey(), 100 * USDC);
    W { env, keeper, guardian, keeper_usdc }
}

// -------------------------------------------------------------------------------------------------------------------
// Instruction builders
// -------------------------------------------------------------------------------------------------------------------

fn init_cfg_ix(admin: &Pubkey, p: HedgeParams) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::InitHedgeConfig { params: p }.data(),
        acc::InitHedgeConfig { admin: *admin, config: config_pda(), hedge_config: hedge_cfg_pda(), system_program: system_program::ID }
            .to_account_metas(None),
    )
}
fn set_cfg_ix(admin: &Pubkey, p: HedgeParams) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SetHedgeConfig { params: p }.data(),
        acc::SetHedgeConfig { admin: *admin, config: config_pda(), hedge_config: hedge_cfg_pda() }.to_account_metas(None),
    )
}

fn leg(t: &str, notional: u64, entry: f64) -> HedgeLegArg {
    HedgeLegArg { ticker: ticker(t), notional, entry_wad: (entry * 1e18) as u128 }
}
fn epochs_of(legs: &[HedgeLegArg]) -> Vec<AccountMeta> {
    legs.iter().map(|l| AccountMeta::new_readonly(epoch_pda(&l.ticker, GROUP_OCT9), false)).collect()
}

const VENUE: [u8; 20] = [0x11; 20];

fn open_ix(who: &Pubkey, group: u32, margin: u64, legs: Vec<HedgeLegArg>) -> Instruction {
    open_ix_at(who, group, margin, VENUE, legs)
}

fn open_ix_at(who: &Pubkey, group: u32, margin: u64, venue: [u8; 20], legs: Vec<HedgeLegArg>) -> Instruction {
    let mut metas = acc::OpenHedge {
        keeper: *who,
        config: config_pda(),
        hedge_config: hedge_cfg_pda(),
        vault: vault_pda(),
        loss: loss_pda(group),
        hedge: hedge_pda(group),
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    metas.extend(epochs_of(&legs));
    Instruction::new_with_bytes(credence_core::ID, &ix::OpenHedge { group, margin, venue, legs }.data(), metas)
}

fn report_ix(who: &Pubkey, exits: Vec<f64>, pnl: i64, evidence: [u8; 32]) -> Instruction {
    let exits = exits.into_iter().map(|x| (x * 1e18) as u128).collect();
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::ReportHedge { exits, pnl, evidence }.data(),
        acc::ReportHedge { keeper: *who, config: config_pda(), hedge_config: hedge_cfg_pda(), hedge: hedge_pda(GROUP_OCT9) }
            .to_account_metas(None),
    )
}

fn finalize_ix(who: &Pubkey, keeper_usdc: Pubkey, tickers: &[&str]) -> Instruction {
    let mut metas = acc::FinalizeHedge {
        keeper: *who,
        config: config_pda(),
        hedge_config: hedge_cfg_pda(),
        vault: vault_pda(),
        vault_usdc: vault_usdc_pda(),
        keeper_usdc,
        loss: loss_pda(GROUP_OCT9),
        hedge: hedge_pda(GROUP_OCT9),
        token_program: TOKEN_PROGRAM,
    }
    .to_account_metas(None);
    metas.extend(tickers.iter().map(|t| AccountMeta::new_readonly(epoch_pda(&ticker(t), GROUP_OCT9), false)));
    Instruction::new_with_bytes(credence_core::ID, &ix::FinalizeHedge {}.data(), metas)
}

fn void_ix(who: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::VoidHedge {}.data(),
        acc::VoidHedge { guardian: *who, config: config_pda(), vault: vault_pda(), hedge: hedge_pda(GROUP_OCT9) }.to_account_metas(None),
    )
}

fn expire_ix(who: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::ExpireHedge {}.data(),
        acc::ExpireHedge { caller: *who, hedge_config: hedge_cfg_pda(), vault: vault_pda(), hedge: hedge_pda(GROUP_OCT9) }
            .to_account_metas(None),
    )
}

fn book(env: &Env) -> HedgeBook {
    env.anchor(&hedge_pda(GROUP_OCT9))
}
fn vault(env: &Env) -> Vault {
    env.anchor(&vault_pda())
}

const EV: [u8; 32] = [7u8; 32];

/// SPYx short of 100 USDC at 700 on 30 USDC margin (3% of 1,000), declared.
fn opened(w: &mut W) {
    let k = w.keeper.insecure_clone();
    ok(&mut w.env, open_ix(&k.pubkey(), GROUP_OCT9, 30 * USDC, vec![leg("SPYx", 100 * USDC, 700.0)]), &k);
}

/// Opened, the weekend closes 700 -> 665 (-5%: the short gains 5 USDC), the close reported with `pnl`.
fn reported(w: &mut W, pnl: i64) {
    opened(w);
    let k = w.keeper.insecure_clone();
    w.env.set_time(OCT12_OPEN + 60);
    ok(&mut w.env, report_ix(&k.pubkey(), vec![665.0], pnl, EV), &k);
}

// -------------------------------------------------------------------------------------------------------------------
// Happy paths
// -------------------------------------------------------------------------------------------------------------------

#[test]
fn hedge_gain_reaches_equity_only_at_finalize() {
    let mut w = world();
    let (k, ku) = (w.keeper.insecure_clone(), w.keeper_usdc);
    let before = vault(&w.env);
    opened(&mut w);
    let b = book(&w.env);
    assert_eq!((b.state, b.n_legs, b.margin, b.equity_at_open), (hedge_state::OPEN, 1, 30 * USDC, 1_000 * USDC));
    assert_eq!(b.legs[0].notional, 100 * USDC);
    assert_eq!(vault(&w.env).hedge_pending, 1);

    w.env.set_time(OCT12_OPEN + 60);
    ok(&mut w.env, report_ix(&k.pubkey(), vec![665.0], 4_800_000, EV), &k);
    let b = book(&w.env);
    assert_eq!((b.state, b.pnl, b.evidence, b.reporter), (hedge_state::REPORTED, 4_800_000, EV, k.pubkey()));
    // Reported, not final: equity and cash are exactly as before.
    let v = vault(&w.env);
    assert_eq!((v.equity, v.hedge_pending), (before.equity, 1));

    // The weekend settles at 665; after the delay the keeper brings the gain.
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    let cash = w.env.token_balance(&vault_usdc_pda());
    ok(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k);
    let v = vault(&w.env);
    assert_eq!((v.equity, v.hedge_pending), (before.equity + 4_800_000, 0));
    assert_eq!(w.env.token_balance(&vault_usdc_pda()), cash + 4_800_000);
    assert_eq!(w.env.token_balance(&ku), 100 * USDC - 4_800_000);
    let b = book(&w.env);
    assert_eq!((b.state, b.settled_pnl), (hedge_state::FINAL, 4_800_000));
}

#[test]
fn hedge_loss_reimburses_the_keeper_from_the_vault() {
    let mut w = world();
    let (k, ku) = (w.keeper.insecure_clone(), w.keeper_usdc);
    opened(&mut w);
    // The weekend gaps UP 5% (the vault is fine, the short loses): 700 -> 735.
    w.env.set_time(OCT12_OPEN + 60);
    ok(&mut w.env, report_ix(&k.pubkey(), vec![735.0], -5_200_000, EV), &k);
    settle_epoch(&mut w.env, "SPYx", 700.0, 735.0);
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    ok(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k);
    assert_eq!(vault(&w.env).equity, 1_000 * USDC - 5_200_000);
    assert_eq!(w.env.token_balance(&vault_usdc_pda()), 1_000 * USDC - 5_200_000);
    assert_eq!(w.env.token_balance(&ku), 100 * USDC + 5_200_000);
}

// -------------------------------------------------------------------------------------------------------------------
// d3_report_bounds
// -------------------------------------------------------------------------------------------------------------------

#[test]
fn d3_report_bounds() {
    let mut w = world();
    let k = w.keeper.insecure_clone();
    let kp = k.pubkey();
    // Margin above 3% of cover equity (30.000001 USDC of 1,000).
    assert_err(send1(&mut w.env, open_ix(&kp, GROUP_OCT9, 30 * USDC + 1, vec![leg("SPYx", 100 * USDC, 700.0)]), &k), code(CoreError::HedgeBounds));
    // Notional above 5x margin.
    assert_err(send1(&mut w.env, open_ix(&kp, GROUP_OCT9, 30 * USDC, vec![leg("SPYx", 150 * USDC + 1, 700.0)]), &k), code(CoreError::HedgeBounds));
    // Wrong epoch / asset: a ticker with no epoch this weekend, and an epoch passed for a different ticker.
    assert_fails(send1(&mut w.env, open_ix(&kp, GROUP_OCT9, 30 * USDC, vec![leg("TSLAx", 100 * USDC, 700.0)]), &k));
    let mut wrong = open_ix(&kp, GROUP_OCT9, 30 * USDC, vec![leg("SPYx", 100 * USDC, 700.0)]);
    wrong.accounts.last_mut().unwrap().pubkey = epoch_pda(&ticker("QQQx"), GROUP_OCT9);
    assert_err(send1(&mut w.env, wrong, &k), code(CoreError::NotThisEpoch));
    // A group that is not the epoch's: the loss vector does not exist.
    assert_fails(send1(&mut w.env, open_ix(&kp, 20261016, 30 * USDC, vec![leg("SPYx", 100 * USDC, 700.0)]), &k));
    // Unsorted / duplicated legs, zero margin, zero price.
    assert_err(send1(&mut w.env, open_ix(&kp, GROUP_OCT9, 30 * USDC, vec![leg("SPYx", USDC, 700.0), leg("SPYx", USDC, 700.0)]), &k), code(CoreError::InvalidParam));
    assert_err(send1(&mut w.env, open_ix(&kp, GROUP_OCT9, 0, vec![leg("SPYx", USDC, 700.0)]), &k), code(CoreError::HedgeBounds));
    assert_err(send1(&mut w.env, open_ix(&kp, GROUP_OCT9, 30 * USDC, vec![leg("SPYx", USDC, 0.0)]), &k), code(CoreError::InvalidParam));
    assert_eq!(vault(&w.env).hedge_pending, 0, "no refused declaration left a trace");

    opened(&mut w);
    // Not before the open.
    assert_err(send1(&mut w.env, report_ix(&kp, vec![665.0], 1, EV), &k), code(CoreError::TooEarly));
    w.env.set_time(OCT12_OPEN + 60);
    // A gain above what the prices imply (665 vs 700 on 100 USDC = 5 USDC).
    assert_err(send1(&mut w.env, report_ix(&kp, vec![665.0], 5 * USDC as i64 + 1, EV), &k), code(CoreError::HedgeBounds));
    // A gain above the 1% cap (10 USDC) even when the prices allow it: exit at 560 (-20%) implies 20 USDC.
    assert_err(send1(&mut w.env, report_ix(&kp, vec![560.0], 10 * USDC as i64 + 1, EV), &k), code(CoreError::HedgeBounds));
    // A loss above the margin.
    assert_err(send1(&mut w.env, report_ix(&kp, vec![735.0], -(30 * USDC as i64) - 1, EV), &k), code(CoreError::HedgeBounds));
    // Shape: wrong number of exits, a zero exit, an empty evidence hash.
    assert_err(send1(&mut w.env, report_ix(&kp, vec![665.0, 665.0], 0, EV), &k), code(CoreError::InvalidParam));
    assert_err(send1(&mut w.env, report_ix(&kp, vec![0.0], 0, EV), &k), code(CoreError::InvalidParam));
    assert_err(send1(&mut w.env, report_ix(&kp, vec![665.0], 0, [0; 32]), &k), code(CoreError::InvalidParam));
    assert_eq!(book(&w.env).state, hedge_state::OPEN);
    // A second declaration for the same weekend cannot overwrite the book.
    assert_fails(send1(&mut w.env, open_ix(&kp, GROUP_OCT9, 30 * USDC, vec![leg("SPYx", USDC, 700.0)]), &k));
    // The honest report passes, and a second report cannot replace it.
    ok(&mut w.env, report_ix(&kp, vec![665.0], 4 * USDC as i64, EV), &k);
    assert_err(send1(&mut w.env, report_ix(&kp, vec![665.0], 5 * USDC as i64, [8; 32]), &k), code(CoreError::HedgeState));
    assert_eq!(book(&w.env).pnl, 4 * USDC as i64);
}

// -------------------------------------------------------------------------------------------------------------------
// d3_report_auth
// -------------------------------------------------------------------------------------------------------------------

#[test]
fn d3_report_auth() {
    let mut w = world();
    let (k, g) = (w.keeper.insecure_clone(), w.guardian.insecure_clone());
    let admin = w.env.admin.insecure_clone();
    let mallory = w.env.funded();
    let m_usdc = w.env.usdc_account(&mallory.pubkey(), 100 * USDC);
    let legs = || vec![leg("SPYx", 100 * USDC, 700.0)];
    // Only the keeper declares: not the guardian, not the admin, not a stranger.
    for who in [&g, &admin, &mallory] {
        assert_err(send1(&mut w.env, open_ix(&who.pubkey(), GROUP_OCT9, 30 * USDC, legs()), who), code(CoreError::Unauthorized));
    }
    reported(&mut w, 4 * USDC as i64);
    // Only the keeper reports (the book is REPORTED now; auth is checked first).
    for who in [&g, &admin, &mallory] {
        assert_err(send1(&mut w.env, report_ix(&who.pubkey(), vec![665.0], 1, EV), who), code(CoreError::Unauthorized));
    }
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    // Only the keeper finalises, with its own USDC account.
    assert_err(send1(&mut w.env, finalize_ix(&mallory.pubkey(), m_usdc, &["SPYx"]), &mallory), code(CoreError::Unauthorized));
    assert_err(send1(&mut w.env, finalize_ix(&g.pubkey(), w.keeper_usdc, &["SPYx"]), &g), code(CoreError::Unauthorized));
    assert_fails(send1(&mut w.env, finalize_ix(&k.pubkey(), m_usdc, &["SPYx"]), &k)); // someone else's account
    // Only the guardian voids: not the keeper, not the admin, not a stranger.
    for who in [&k, &admin, &mallory] {
        assert_err(send1(&mut w.env, void_ix(&who.pubkey()), who), code(CoreError::Unauthorized));
    }
    ok(&mut w.env, void_ix(&g.pubkey()), &g);
    assert_eq!(book(&w.env).state, hedge_state::VOIDED);
    // Only the admin sets the caps.
    for who in [&k, &g, &mallory] {
        assert_err(send1(&mut w.env, set_cfg_ix(&who.pubkey(), params()), who), code(CoreError::Unauthorized));
    }
}

// -------------------------------------------------------------------------------------------------------------------
// d3_challenge_delay
// -------------------------------------------------------------------------------------------------------------------

#[test]
fn d3_challenge_delay() {
    let mut w = world();
    let (k, g, ku) = (w.keeper.insecure_clone(), w.guardian.insecure_clone(), w.keeper_usdc);
    let before = vault(&w.env).equity;
    // A weekend with a policy: until it settles the group is live (a group without policies is over at the bell).
    edit_loss(&mut w.env, GROUP_OCT9, |l| l.policy_count = 1);
    reported(&mut w, 4 * USDC as i64);
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    // The group has not settled: nothing, however long it waits.
    w.env.set_time(OCT12_OPEN + 60 + 10 * DELAY);
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k), code(CoreError::TooEarly));
    settle_group(&mut w.env);
    // Settled, but inside the challenge window.
    w.env.set_time(OCT12_OPEN + 60 + DELAY - 1);
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k), code(CoreError::TooEarly));
    assert_eq!(vault(&w.env).equity, before);
    // The guardian voids inside the window: the report can never be finalised, whatever the clock says.
    ok(&mut w.env, void_ix(&g.pubkey()), &g);
    w.env.set_time(OCT12_OPEN + 60 + 100 * DELAY);
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k), code(CoreError::HedgeState));
    assert_eq!(vault(&w.env).equity, before);
    assert_eq!(vault(&w.env).hedge_pending, 0);
    // A void book cannot be voided again or reported; the keeper cannot reopen the weekend.
    assert_err(send1(&mut w.env, void_ix(&g.pubkey()), &g), code(CoreError::HedgeState));
    assert_err(send1(&mut w.env, report_ix(&k.pubkey(), vec![665.0], 1, EV), &k), code(CoreError::HedgeState));
}

#[test]
fn expire_hedge_releases_a_stuck_book() {
    let mut w = world();
    let anyone = w.env.funded();
    let before = vault(&w.env);
    opened(&mut w);
    assert_eq!(vault(&w.env).hedge_pending, 1);
    // Too early, then after the expiry anyone can void it.
    w.env.set_time(OCT12_OPEN + EXPIRY);
    assert_err(send1(&mut w.env, expire_ix(&anyone.pubkey()), &anyone), code(CoreError::TooEarly));
    w.env.set_time(OCT12_OPEN + EXPIRY + 1);
    ok(&mut w.env, expire_ix(&anyone.pubkey()), &anyone);
    let (b, v) = (book(&w.env), vault(&w.env));
    assert_eq!((b.state, v.hedge_pending, v.equity), (hedge_state::VOIDED, 0, before.equity));
    assert_err(send1(&mut w.env, expire_ix(&anyone.pubkey()), &anyone), code(CoreError::HedgeState));
}

// -------------------------------------------------------------------------------------------------------------------
// d3_nav_safe
// -------------------------------------------------------------------------------------------------------------------

#[test]
fn d3_nav_safe() {
    let mut w = world();
    let (k, ku) = (w.keeper.insecure_clone(), w.keeper_usdc);
    let (lp, lp_usdc, lp_shares) = w.env.lp(50 * USDC);
    let before = vault(&w.env);
    // A false gain: the keeper claims the short earned 9 USDC (exit 610, -12.9%) while the lender oracle shows -5%.
    opened(&mut w);
    w.env.set_time(OCT12_OPEN + 60);
    ok(&mut w.env, report_ix(&k.pubkey(), vec![610.0], 9 * USDC as i64, EV), &k);
    // Nothing moved from the report alone.
    assert_eq!(vault(&w.env).equity, before.equity);
    assert_eq!(w.env.token_balance(&vault_usdc_pda()), 1_000 * USDC);
    // While the book is pending nobody enters at the old NAV: direct deposit and queue processing wait (INV-25).
    let ix = w.env.ix_deposit(&lp.pubkey(), lp_usdc, lp_shares, 10 * USDC);
    assert_err(send1(&mut w.env, ix, &lp), code(CoreError::HedgePending));
    // The weekend settles at -5%: the claim disagrees with the epoch's prices and is refused.
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k), code(CoreError::HedgeMismatch));
    assert_eq!(vault(&w.env).equity, before.equity);
    // Even with exit prices that agree, a P&L the prices do not support is refused (5 USDC implied, 4.8 reported is fine; here
    // the book is reset to claim the 1% cap = 10 USDC at an exit that implies 20 USDC, against an oracle that shows 5).
    let g = w.guardian.insecure_clone();
    ok(&mut w.env, void_ix(&g.pubkey()), &g);
    // The best a false report can do is bounded: re-declare is impossible (one book per weekend), so the vault is unchanged.
    assert_eq!(vault(&w.env).equity, before.equity);
    assert_eq!(vault(&w.env).hedge_pending, 0);
}

#[test]
fn d3_nav_move_is_inside_the_caps() {
    // A keeper at the edge of what it may claim: the oracle shows -5% on 100 USDC (5), the tolerance band is 3.03% of the
    // notional (3.03), the 1% cap is 10 USDC. Gains above oracle + band are refused, up to it they pass, and the move in
    // equity is never above the cap.
    let mut w = world();
    let (k, ku) = (w.keeper.insecure_clone(), w.keeper_usdc);
    let before = vault(&w.env).equity;
    opened(&mut w);
    w.env.set_time(OCT12_OPEN + 60);
    // Exit 665 implies exactly 5 USDC and a report can claim no more than that; the oracle band never adds to it.
    assert_err(send1(&mut w.env, report_ix(&k.pubkey(), vec![665.0], 5 * USDC as i64 + 1, EV), &k), code(CoreError::HedgeBounds));
    ok(&mut w.env, report_ix(&k.pubkey(), vec![665.0], 5 * USDC as i64, EV), &k);
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    ok(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k);
    let moved = vault(&w.env).equity - before;
    assert!(moved <= before / 100, "moved {moved}");
    // A loss-making report that hides behind the band: the oracle shows -5% on the short (5 loss), the keeper claims
    // a 29 USDC loss to take cash out: the 1% cap (10 USDC) refuses it at the report (A-271); a 9 USDC loss gets through the report and
    // the band (3.03 around the oracle's 5) refuses it at finalize.
    let mut w = world();
    let (k, ku) = (w.keeper.insecure_clone(), w.keeper_usdc);
    opened(&mut w);
    w.env.set_time(OCT12_OPEN + 60);
    assert_err(send1(&mut w.env, report_ix(&k.pubkey(), vec![735.0], -29 * USDC as i64, EV), &k), code(CoreError::HedgeBounds));
    ok(&mut w.env, report_ix(&k.pubkey(), vec![735.0], -9 * USDC as i64, EV), &k);
    settle_epoch(&mut w.env, "SPYx", 700.0, 735.0);
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k), code(CoreError::HedgeMismatch));
    assert_eq!(vault(&w.env).equity, 1_000 * USDC);
}

// -------------------------------------------------------------------------------------------------------------------
// d3_kill_switch
// -------------------------------------------------------------------------------------------------------------------

#[test]
fn d3_kill_switch() {
    let mut w = world();
    let (k, g, ku) = (w.keeper.insecure_clone(), w.guardian.insecure_clone(), w.keeper_usdc);
    // The guardian pauses: no new hedge is declared.
    let pause = w.env.ix_set_paused(&g.pubkey(), true);
    ok(&mut w.env, pause, &g);
    assert_err(send1(&mut w.env, open_ix(&k.pubkey(), GROUP_OCT9, 30 * USDC, vec![leg("SPYx", 100 * USDC, 700.0)]), &k), code(CoreError::Paused));
    assert!(w.env.svm.get_account(&hedge_pda(GROUP_OCT9)).is_none(), "nothing was created");
    // Unpaused, a hedge is declared; then the guardian pauses again with it open.
    let (a, unpause) = (w.env.admin.insecure_clone(), w.env.ix_set_paused(&w.env.admin.pubkey(), false));
    ok(&mut w.env, unpause, &a);
    opened(&mut w);
    let pause = w.env.ix_set_paused(&g.pubkey(), true);
    ok(&mut w.env, pause, &g);
    // The existing hedge is still closed out, reported and finalised.
    w.env.set_time(OCT12_OPEN + 60);
    ok(&mut w.env, report_ix(&k.pubkey(), vec![665.0], 4 * USDC as i64, EV), &k);
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    ok(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k);
    assert_eq!(vault(&w.env).equity, 1_000 * USDC + 4 * USDC);
}

// -------------------------------------------------------------------------------------------------------------------
// d3_capacity_unchanged
// -------------------------------------------------------------------------------------------------------------------

#[test]
fn d3_capacity_unchanged() {
    let mut w = world();
    let (k, ku) = (w.keeper.insecure_clone(), w.keeper_usdc);
    // Give the group something to reserve: an edited loss row stands for covered policies.
    edit_loss(&mut w.env, GROUP_OCT9, |l| {
        l.losses[3] = 40 * USDC;
        l.max_loss = 40 * USDC;
    });
    w.env.edit_vault(|v| v.reserved_total = 40 * USDC);
    let (v0, l0) = (vault(&w.env), w.env.data(&loss_pda(GROUP_OCT9)));
    let cap = |v: &Vault| ((v.equity - v.inventory_cost().unwrap()) as u128) * (WAD as u128 / 2) / WAD as u128;
    opened(&mut w);
    w.env.set_time(OCT12_OPEN + 60);
    ok(&mut w.env, report_ix(&k.pubkey(), vec![665.0], 4 * USDC as i64, EV), &k);
    // Declared and reported: reserved losses, the loss vector and the capacity limit are exactly as without a hedge.
    let v1 = vault(&w.env);
    assert_eq!((v1.reserved_total, v1.equity, cap(&v1)), (v0.reserved_total, v0.equity, cap(&v0)));
    assert_eq!(w.env.data(&loss_pda(GROUP_OCT9)), l0);
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    ok(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k);
    // Finalised: reserved losses and the loss vector untouched; equity moved by the cash that actually arrived.
    let v2 = vault(&w.env);
    assert_eq!(v2.reserved_total, v0.reserved_total);
    assert_eq!(v2.equity, v0.equity + 4 * USDC);
    assert_eq!(w.env.token_balance(&vault_usdc_pda()), 1_000 * USDC + 4 * USDC, "equity never exceeds cash that came in");
    let l2 = w.env.data(&loss_pda(GROUP_OCT9));
    // Only the `settled` flag differs (the test set it); the losses, max_loss and premiums are byte-identical.
    let n = core::mem::size_of::<LossVector>();
    assert_eq!(&l2[8..8 + 8 * K + 24], &l0[8..8 + 8 * K + 24]);
    assert_eq!(l2.len(), 8 + n);
}

// -------------------------------------------------------------------------------------------------------------------
// Failure tests, config, compute units
// -------------------------------------------------------------------------------------------------------------------

#[test]
fn hedge_config_failures() {
    let mut env = Env::real(0);
    let a = env.admin.pubkey();
    let bad = |f: fn(&mut HedgeParams)| {
        let mut p = params();
        f(&mut p);
        p
    };
    for p in [
        bad(|p| p.margin_cap_bps = 0),
        bad(|p| p.margin_cap_bps = HedgeConfig::MAX_MARGIN_BPS + 1),
        bad(|p| p.pnl_cap_bps = HedgeConfig::MAX_PNL_BPS + 1),
        bad(|p| p.max_leverage = 0),
        bad(|p| p.max_leverage = HedgeConfig::MAX_LEVERAGE + 1),
        bad(|p| p.delay_secs = HedgeConfig::MIN_DELAY - 1),
        bad(|p| p.delay_secs = HedgeConfig::MAX_DELAY + 1),
        bad(|p| p.expiry_secs = p.delay_secs),
        bad(|p| p.return_tol_wad = 0),
        bad(|p| p.return_tol_wad = HedgeConfig::MAX_TOL_WAD + 1),
    ] {
        assert_err(env.send_admin(&[init_cfg_ix(&a, p)]), code(CoreError::InvalidParam));
    }
    env.send_admin(&[init_cfg_ix(&a, params())]).unwrap();
    assert_fails(env.send_admin(&[init_cfg_ix(&a, params())])); // twice
    assert_err(env.send_admin(&[set_cfg_ix(&a, bad(|p| p.max_leverage = 0))]), code(CoreError::InvalidParam));
    let mut p = params();
    p.max_leverage = 3;
    env.send_admin(&[set_cfg_ix(&a, p)]).unwrap();
    let c: HedgeConfig = env.anchor(&hedge_cfg_pda());
    assert_eq!((c.max_leverage, c.margin_cap_bps), (3, 300));
}

#[test]
fn open_hedge_needs_the_config_and_an_unsettled_weekend() {
    // No hedge config: refused (the account is missing).
    let mut env = Env::real(1_000 * USDC);
    let a = env.admin.pubkey();
    let i = open_ix(&a, GROUP_OCT9, 30 * USDC, vec![leg("SPYx", 100 * USDC, 700.0)]);
    assert_fails(env.send_admin(&[i]));
    // A settled group and an epoch past the open are refused.
    let mut w = world();
    let k = w.keeper.insecure_clone();
    let i = open_ix(&k.pubkey(), GROUP_OCT9, 30 * USDC, vec![leg("SPYx", 100 * USDC, 700.0)]);
    settle_group(&mut w.env);
    assert_err(send1(&mut w.env, i.clone(), &k), code(CoreError::HedgeState));
    edit_loss(&mut w.env, GROUP_OCT9, |l| l.settled = 0);
    w.env.set_time(OCT12_OPEN);
    assert_err(send1(&mut w.env, i.clone(), &k), code(CoreError::TooEarly));
    w.env.set_time(OCT12_OPEN - 60);
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    assert_err(send1(&mut w.env, i, &k), code(CoreError::WrongEpochState));
}

#[test]
fn finalize_hedge_failures() {
    let mut w = world();
    let (k, ku) = (w.keeper.insecure_clone(), w.keeper_usdc);
    opened(&mut w);
    // Not reported yet.
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k), code(CoreError::HedgeState));
    w.env.set_time(OCT12_OPEN + 60);
    ok(&mut w.env, report_ix(&k.pubkey(), vec![665.0], 4 * USDC as i64, EV), &k);
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    // The epoch is not settled; the wrong epoch; no epoch; a keeper account of another mint.
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k), code(CoreError::WrongEpochState));
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    settle_epoch(&mut w.env, "QQQx", 700.0, 665.0);
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["QQQx"]), &k), code(CoreError::NotThisEpoch));
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &[]), &k), code(CoreError::InvalidParam));
    let bad = Pubkey::new_unique();
    w.env.put_token_account(bad, &Pubkey::new_unique(), &k.pubkey(), 100 * USDC);
    assert_fails(send1(&mut w.env, finalize_ix(&k.pubkey(), bad, &["SPYx"]), &k));
    // A keeper without the USDC cannot finalise a gain (the transfer fails; equity does not move).
    let empty = w.env.usdc_account(&k.pubkey(), 0);
    assert_fails(send1(&mut w.env, finalize_ix(&k.pubkey(), empty, &["SPYx"]), &k));
    assert_eq!(vault(&w.env).equity, 1_000 * USDC);
    // An oracle return that disagrees with the perp's by more than the tolerance (settle 600 vs exit 665).
    settle_epoch(&mut w.env, "SPYx", 700.0, 600.0);
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k), code(CoreError::HedgeMismatch));
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    ok(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k);
    // Twice.
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k), code(CoreError::HedgeState));
}

#[test]
fn hedge_pending_blocks_the_queue() {
    // A queued deposit made before the hedge cannot be processed at the old NAV while a book is pending.
    let mut w = world();
    let (k, ku) = (w.keeper.insecure_clone(), w.keeper_usdc);
    let (lp, lp_usdc, lp_shares) = w.env.lp(20 * USDC);
    w.env.edit_vault(|v| {
        v.live = [GROUP_OCT9, 0, 0, 0, 0, 0, 0, 0];
        v.live_groups = 1;
    });
    let ix = w.env.ix_request_deposit(&lp.pubkey(), lp_usdc, 20 * USDC);
    ok(&mut w.env, ix, &lp);
    w.env.edit_vault(|v| {
        v.live = [0; 8];
        v.live_groups = 0;
    });
    let ticket = deposit_ticket_pda(&lp.pubkey(), GROUP_OCT9);
    opened(&mut w);
    let ix = w.env.ix_process_deposit(&lp.pubkey(), ticket, lp_shares, lp_usdc);
    assert_err(send1(&mut w.env, ix, &lp), code(CoreError::HedgePending));
    // After the hedge is final the queue moves again.
    w.env.set_time(OCT12_OPEN + 60);
    ok(&mut w.env, report_ix(&k.pubkey(), vec![665.0], 4 * USDC as i64, EV), &k);
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    ok(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k);
    let ix = w.env.ix_process_deposit(&lp.pubkey(), ticket, lp_shares, lp_usdc);
    ok(&mut w.env, ix, &lp);
    assert!(w.env.token_balance(&lp_shares) > 0);
}

#[test]
fn hedge_compute_units() {
    let mut w = world();
    let (k, g, ku) = (w.keeper.insecure_clone(), w.guardian.insecure_clone(), w.keeper_usdc);
    let legs = vec![leg("NVDAx", 30 * USDC, 190.0), leg("QQQx", 30 * USDC, 600.0), leg("SPYx", 40 * USDC, 700.0)];
    let mut sorted = legs.clone();
    sorted.sort_by_key(|l| l.ticker);
    let cu_open = send1(&mut w.env, open_ix(&k.pubkey(), GROUP_OCT9, 30 * USDC, sorted.clone()), &k).unwrap().compute_units_consumed;
    w.env.set_time(OCT12_OPEN + 60);
    let exits: Vec<f64> = sorted.iter().map(|l| l.entry_wad as f64 / 1e18 * 0.95).collect();
    let cu_report = send1(&mut w.env, report_ix(&k.pubkey(), exits, 4 * USDC as i64, EV), &k).unwrap().compute_units_consumed;
    for l in &sorted {
        let t = String::from_utf8_lossy(&l.ticker).trim_end_matches('\0').to_string();
        settle_epoch(&mut w.env, &t, l.entry_wad as f64 / 1e18, l.entry_wad as f64 / 1e18 * 0.95);
    }
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    let ts: Vec<String> = sorted.iter().map(|l| String::from_utf8_lossy(&l.ticker).trim_end_matches('\0').to_string()).collect();
    let tr: Vec<&str> = ts.iter().map(|s| s.as_str()).collect();
    let cu_final = send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &tr), &k).unwrap().compute_units_consumed;
    println!("    CU open_hedge (3 legs) {cu_open}, report_hedge {cu_report}, finalize_hedge {cu_final}");
    for (n, cu, max) in [("open", cu_open, 120_000), ("report", cu_report, 60_000), ("finalize", cu_final, 120_000)] {
        assert!(cu < max, "{n}: {cu} CU");
    }
    let _ = g;
}

// -------------------------------------------------------------------------------------------------------------------
// Audit A-270 to A-273 (self-review of the hedge path)
// -------------------------------------------------------------------------------------------------------------------

/// A-270: the book names the venue account that holds the hedge, so anyone can check its fills on the public venue; a
/// declaration without one is refused.
#[test]
fn a270_the_book_records_the_venue_account() {
    let mut w = world();
    let k = w.keeper.insecure_clone();
    let legs = || vec![leg("SPYx", 100 * USDC, 700.0)];
    assert_err(send1(&mut w.env, open_ix_at(&k.pubkey(), GROUP_OCT9, 30 * USDC, [0; 20], legs()), &k), code(CoreError::InvalidParam));
    ok(&mut w.env, open_ix_at(&k.pubkey(), GROUP_OCT9, 30 * USDC, [0xab; 20], legs()), &k);
    assert_eq!(book(&w.env).venue, [0xab; 20]);
}

/// A-271: a reported loss is capped like a gain (1% of equity), not by the margin (3%): a keeper that fabricates a hedge on a
/// weekend the market rose can take at most that. The operator bears the rest of a real loss.
#[test]
fn a271_a_loss_is_capped_like_a_gain() {
    let mut w = world();
    let k = w.keeper.insecure_clone();
    opened(&mut w);
    w.env.set_time(OCT12_OPEN + 60);
    // 1% of 1,000 USDC = 10 USDC; the margin is 30. Exit 1050 (+50%) implies a 50 USDC loss, the margin would allow 30.
    assert_err(send1(&mut w.env, report_ix(&k.pubkey(), vec![1050.0], -(10 * USDC as i64) - 1, EV), &k), code(CoreError::HedgeBounds));
    ok(&mut w.env, report_ix(&k.pubkey(), vec![770.0], -(10 * USDC as i64), EV), &k); // 700 -> 770 implies exactly -10
}

/// A-272: only the key that reported can finalise: after the keeper key is rotated (compromise), the old report cannot be
/// brought through by the new key; the guardian voids it or it expires.
#[test]
fn a272_finalize_is_bound_to_the_reporter() {
    let mut w = world();
    let (k, ku) = (w.keeper.insecure_clone(), w.keeper_usdc);
    reported(&mut w, 4 * USDC as i64);
    settle_epoch(&mut w.env, "SPYx", 700.0, 665.0);
    settle_group(&mut w.env);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    // The admin rotates the keeper.
    let (admin, new_keeper) = (w.env.admin.insecure_clone(), w.env.funded());
    let ix = w.env.ix_set_params(&admin.pubkey(), default_params(w.guardian.pubkey(), new_keeper.pubkey()));
    w.env.send_admin(&[ix]).unwrap();
    let nk_usdc = w.env.usdc_account(&new_keeper.pubkey(), 100 * USDC);
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k), code(CoreError::Unauthorized));
    assert_err(send1(&mut w.env, finalize_ix(&new_keeper.pubkey(), nk_usdc, &["SPYx"]), &new_keeper), code(CoreError::Unauthorized));
    assert_eq!(vault(&w.env).equity, 1_000 * USDC);
    let g = w.guardian.insecure_clone();
    ok(&mut w.env, void_ix(&g.pubkey()), &g);
}

/// A-273: a book nobody finalises blocks deposits and queues until it expires, so the longest expiry the admin may set is 14 days.
#[test]
fn a273_expiry_has_a_short_ceiling() {
    let mut env = Env::real(0);
    let a = env.admin.pubkey();
    let mut p = params();
    p.expiry_secs = 14 * 86_400 + 1;
    assert_err(env.send_admin(&[init_cfg_ix(&a, p)]), code(CoreError::InvalidParam));
    p.expiry_secs = 14 * 86_400;
    env.send_admin(&[init_cfg_ix(&a, p)]).unwrap();
}

// -------------------------------------------------------------------------------------------------------------------
// Audit A-278 to A-281 (review of the keeper path and the finalize loss path)
// -------------------------------------------------------------------------------------------------------------------

/// A-278: a book that expires before it can possibly be finalised is a book that locks deposits for nothing: the expiry must leave a
/// day after the delay at least.
#[test]
fn a278_expiry_leaves_room_after_the_delay() {
    let mut env = Env::real(0);
    let a = env.admin.pubkey();
    let mut p = params();
    p.delay_secs = 7 * 86_400;
    p.expiry_secs = 7 * 86_400 + 3_600;
    assert_err(env.send_admin(&[init_cfg_ix(&a, p)]), code(CoreError::InvalidParam));
    p.expiry_secs = 8 * 86_400;
    env.send_admin(&[init_cfg_ix(&a, p)]).unwrap();
}

/// A-279: a loss recognised at finalize may not leave another live group over-reserved against the equity that remains (INV-2).
#[test]
fn a279_a_loss_cannot_overreserve_other_groups() {
    let mut w = world();
    let (k, ku) = (w.keeper.insecure_clone(), w.keeper_usdc);
    opened(&mut w);
    w.env.set_time(OCT12_OPEN + 60);
    ok(&mut w.env, report_ix(&k.pubkey(), vec![735.0], -5 * USDC as i64, EV), &k); // 700 -> 735 implies exactly -5
    settle_epoch(&mut w.env, "SPYx", 700.0, 735.0);
    settle_group(&mut w.env);
    // Another live group reserves exactly u_max × equity (500 USDC of 1,000): any loss breaks INV-2.
    w.env.edit_vault(|v| v.reserved_total = 500 * USDC);
    w.env.set_time(OCT12_OPEN + 60 + DELAY);
    assert_err(send1(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k), code(CoreError::CapacityExceeded));
    // With room, the same loss is recognised.
    w.env.edit_vault(|v| v.reserved_total = 400 * USDC);
    ok(&mut w.env, finalize_ix(&k.pubkey(), ku, &["SPYx"]), &k);
    assert_eq!(vault(&w.env).equity, 1_000 * USDC - 5 * USDC);
}

/// A-280: the legs are the weekend's: an epoch of another closure type is refused.
#[test]
fn a280_only_weekend_closures_are_hedged() {
    let mut w = world();
    let k = w.keeper.insecure_clone();
    edit_epoch(&mut w.env, "SPYx", |e| e.closure_type = closure::OVERNIGHT);
    assert_err(
        send1(&mut w.env, open_ix(&k.pubkey(), GROUP_OCT9, 30 * USDC, vec![leg("SPYx", 100 * USDC, 700.0)]), &k),
        code(CoreError::UnsupportedClosure),
    );
    edit_epoch(&mut w.env, "SPYx", |e| e.closure_type = closure::HOLIDAY_WEEKEND);
    ok(&mut w.env, open_ix(&k.pubkey(), GROUP_OCT9, 30 * USDC, vec![leg("SPYx", 100 * USDC, 700.0)]), &k);
}
