//! W3 yield vault on real klend (task 1.4): `rebalance` lends the vault's cash above its buffer to the xStocks Market
//! USDC reserve (`deposit_reserve_liquidity` CPI) and redeems below it (`redeem_reserve_collateral` CPI), neither with
//! klend's refresh instructions in the transaction; yield is booked only at `rebalance` (INV-5); at 100% utilisation
//! settlement, shield advances and withdrawals still pay from cash.

mod common;

use common::*;
use credence_core::{kamino::ReserveView, state::*, CoreError};
use credence_risk_core::ctoken_value;
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000; // 2M USDC
const W: u64 = 1_000_000_000_000_000_000;

fn env_with_yield(headroom_wad: u64) -> Env {
    let mut env = Env::real(LP);
    let owner = env.funded();
    env.load_klend(&owner.pubkey());
    env.setup_yield(headroom_wad);
    env
}

fn value_now(env: &Env) -> u64 {
    let r = ReserveView::decode(&env.data(&RESERVE_USDC)).unwrap();
    let v: Vault = env.anchor(&vault_pda());
    ctoken_value(env.token_balance(&v.kusdc), r.total_supply_sf().unwrap(), r.collateral_mint_total_supply).unwrap()
}

/// Verification first (plan/10 W3): klend's deposit and redeem need no refresh instruction in the transaction, through
/// a PDA-signed CPI. With no live group the buffer is the 10% headroom: 1.8M of the 2M is lent; then a group's
/// reservation raises the buffer and `rebalance` redeems to it.
#[test]
fn rebalance_lends_and_redeems_without_refresh_instructions() {
    let mut env = env_with_yield(W / 10);
    let v0: Vault = env.anchor(&vault_pda());
    let m = env.rebalance(false).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("rebalance (deposit, no refresh ix): {} CU", m.compute_units_consumed);
    let v: Vault = env.anchor(&vault_pda());
    let cash = env.token_balance(&vault_usdc_pda());
    assert_eq!(cash, LP / 10, "cash at the buffer: 10% headroom of 2M");
    assert!(v.lent_ctokens > 0 && v.lent_ctokens == env.token_balance(&v.kusdc));
    assert_eq!(v.lent_value, value_now(&env));
    // Lent at par, minus klend's rounding (a few base units): the only "yield" of a deposit.
    assert!(v.lent_value <= LP - LP / 10 && LP - LP / 10 - v.lent_value <= 2, "lent value {}", v.lent_value);
    assert!(v0.equity - v.equity <= 2);

    // A live group reserves 600k: the buffer is 600k + headroom, so the vault redeems about 600k (no refresh ix again).
    let mut vv: Vault = env.anchor(&vault_pda());
    vv.reserved_total = 600_000_000_000;
    put_vault_state(&mut env, &vv);
    let m = env.rebalance(false).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("rebalance (redeem, no refresh ix): {} CU", m.compute_units_consumed);
    let cash = env.token_balance(&vault_usdc_pda());
    let v: Vault = env.anchor(&vault_pda());
    let buffer = 600_000_000_000 + (v.cover_equity().unwrap() as u128 * (W / 10) as u128).div_ceil(W as u128) as u64;
    assert!(cash >= buffer && cash - buffer <= 2, "cash {cash} vs buffer {buffer}");
    assert_eq!(v.lent_value, value_now(&env));
}

/// INV-5: yield accrues in klend every slot but reaches equity (and share prices) only at `rebalance`. While anything is
/// lent, share prices refuse a valuation older than 15 minutes; after the rebalance, the new NAV prices the deposit.
#[test]
fn yield_is_recognised_only_at_rebalance() {
    let mut env = env_with_yield(W / 10);
    env.rebalance(false).unwrap();
    let v0: Vault = env.anchor(&vault_pda());
    // Thirty days of klend interest (slots and clock).
    env.svm.warp_to_slot(env.slot() + 30 * 216_000);
    env.set_time(env.now() + 30 * 86_400);
    assert_eq!(env.anchor::<Vault>(&vault_pda()).equity, v0.equity, "nothing booked without a rebalance");
    let (lp, u, sh) = env.lp(10_000_000_000);
    let dep = env.ix_deposit(&lp.pubkey(), u, sh, 10_000_000_000);
    assert_err(env.send(&[dep.clone()], &[&lp]), code(CoreError::StaleYieldValuation));
    // Rebalance with a refresh (cash is at the buffer, so nothing moves; klend's refresh accrues the interest).
    let m = env.rebalance(true).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("refresh_reserve + rebalance (no move): {} CU", m.compute_units_consumed);
    let v: Vault = env.anchor(&vault_pda());
    let y = v.equity - v0.equity;
    println!("30 days on {} USDC lent: yield {} USDC ({:.2}%/yr)", v0.lent_value as f64 / 1e6, y as f64 / 1e6, y as f64 / v0.lent_value as f64 * 365.0 / 30.0 * 100.0);
    assert!(y > 0 && y as i64 == v.yield_recognized - v0.yield_recognized);
    assert_eq!(v.lent_value, value_now(&env));
    // The deposit now prices at the higher NAV: fewer shares than at par.
    let supply = env.mint_supply(&v.share_mint);
    env.send(&[dep], &[&lp]).unwrap();
    let minted = env.mint_supply(&v.share_mint) - supply;
    assert_eq!(minted as u128, 10_000_000_000u128 * supply as u128 / v.nav(env.now()).unwrap() as u128);
    assert!(minted < 10_000_000_000);
}

/// At 100% utilisation nothing can be redeemed: `rebalance` books the position and skips the redemption instead of
/// failing; cover the cash does not back is refused (`CashBelowReservation`).
#[test]
fn illiquid_reserve_rebalance_skips_and_cover_needs_cash() {
    let mut env = env_with_yield(0);
    env.rebalance(false).unwrap(); // everything lent: no buffer at all
    assert_eq!(env.token_balance(&vault_usdc_pda()), 0);
    env.make_usdc_reserve_illiquid();
    let mut vv: Vault = env.anchor(&vault_pda());
    vv.reserved_total = 100_000_000_000;
    put_vault_state(&mut env, &vv);
    env.rebalance(true).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    assert_eq!(env.token_balance(&vault_usdc_pda()), 0, "nothing could be redeemed");
    // A buyer: cover would add a reservation the cash cannot back.
    let mut vv: Vault = env.anchor(&vault_pda());
    vv.reserved_total = 0;
    put_vault_state(&mut env, &vv);
    let owner = env.funded();
    env.load_klend_with(&owner.pubkey(), |d| ob::scale_debt(d, 125, 100));
    env.make_usdc_reserve_illiquid();
    let ou = env.usdc_account(&owner.pubkey(), 100_000_000_000);
    let debt = (kl::debt_sf(&env) >> 60) as u64;
    let mut ixs = kl::refreshes();
    ixs.push(env.ix_buy_cover(&BuyArgs {
        buyer: owner.pubkey(), buyer_usdc: ou, obligation: OBLIGATION_47WN, deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"), closure_id: GROUP_OCT9, max_payout: debt / 5, max_premium: u64::MAX,
    }));
    env.svm.warp_to_slot(env.slot() + 1);
    env.freshen_scope();
    assert_err(env.send(&ixs, &[&owner]), code(CoreError::CashBelowReservation));
}

#[test]
fn rebalance_refuses_what_it_must() {
    let mut env = env_with_yield(W / 10);
    // Not the keeper.
    let s = env.funded();
    let ix = env.ix_rebalance(&s.pubkey(), false);
    assert_err(env.send(&[kl::refresh_reserve(RESERVE_USDC), ix], &[&s]), code(CoreError::Unauthorized));
    // Nothing to move and no refresh: the valuation needs a reserve refreshed this slot.
    env.rebalance(false).unwrap();
    assert_err(env.rebalance(false), code(CoreError::ReserveNotRefreshed));
    // Paused: no new lending, but a redemption (risk-reducing) still runs.
    let a = env.admin.pubkey();
    let ix = env.ix_set_paused(&a, true);
    env.send_admin(&[ix]).unwrap();
    let mut vv: Vault = env.anchor(&vault_pda());
    vv.reserved_total = 300_000_000_000;
    put_vault_state(&mut env, &vv);
    env.rebalance(true).unwrap();
    assert!(env.token_balance(&vault_usdc_pda()) >= 300_000_000_000);
    // set_yield_reserve: not a USDC reserve; another reserve while lent.
    let v: Vault = env.anchor(&vault_pda());
    let mut ix = credence_set_yield(&env, RESERVE_SPYX, v.kusdc);
    assert_err(env.send_admin(&[ix.clone()]), code(CoreError::InvalidParam));
    ix.accounts[3].pubkey = RESERVE_USDC;
    env.send_admin(&[ix]).unwrap(); // the same reserve again is fine
    let _ = W;
}

fn credence_set_yield(env: &Env, reserve: anchor_lang::prelude::Pubkey, kusdc: anchor_lang::prelude::Pubkey) -> anchor_lang::solana_program::instruction::Instruction {
    use anchor_lang::{InstructionData, ToAccountMetas};
    use credence_core::{accounts as acc, instruction as ix};
    anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SetYieldReserve { cash_headroom_wad: W / 10 }.data(),
        acc::SetYieldReserve { admin: env.admin.pubkey(), config: config_pda(), vault: vault_pda(), reserve, kusdc, token_program: TOKEN_PROGRAM }
            .to_account_metas(None),
    )
}

fn put_vault_state(env: &mut Env, v: &Vault) {
    use anchor_lang::{AnchorSerialize, Discriminator};
    let key = vault_pda();
    let old = env.svm.get_account(&key).unwrap();
    let mut data = Vault::DISCRIMINATOR.to_vec();
    v.serialize(&mut data).unwrap();
    data.resize(old.data.len(), 0);
    env.svm.set_account(key, solana_account::Account { data, ..old }).unwrap();
}

/// W3 stress (plan/10: "a test where the reserve is at 100% utilisation and settlement still pays"): an LP queues a
/// withdrawal while a covered weekend is live; the keeper lends everything above the buffer; the USDC reserve then goes
/// to 100% utilisation, so nothing can be redeemed. At the open the policy settles into the obligation and the queued
/// withdrawal is paid, both from cash, and `rebalance` still books the position without failing.
#[test]
fn stress_full_utilisation_settlement_and_withdrawal_pay_from_cash() {
    use anchor_lang::{solana_program::instruction::{AccountMeta, Instruction}, InstructionData, ToAccountMetas};
    use credence_core::{accounts as acc, instruction as ix};
    const OCT9_CLOSE: i64 = 1_791_576_000;
    const OCT12_OPEN: i64 = 1_791_811_800;
    const SPY_CLOSE: f64 = 777.05;

    let mut env = Env::real(0);
    let owner = env.funded();
    env.load_klend_with(&owner.pubkey(), |d| ob::scale_debt(d, 125, 100));
    env.setup_yield(0); // no headroom: everything above the buffer is lent
    // The LP, and the cover.
    let (lp, lu, lsh) = env.lp(LP);
    let dep = env.ix_deposit(&lp.pubkey(), lu, lsh, LP);
    env.send(&[dep], &[&lp]).unwrap();
    let owner_usdc = env.usdc_account(&owner.pubkey(), 100_000_000_000);
    let debt = (kl::debt_sf(&env) >> 60) as u64;
    let mut ixs = kl::refreshes();
    ixs.push(env.ix_buy_cover(&BuyArgs {
        buyer: owner.pubkey(), buyer_usdc: owner_usdc, obligation: OBLIGATION_47WN, deposit_reserve: RESERVE_SPYX,
        ticker: ticker("SPYx"), closure_id: GROUP_OCT9, max_payout: debt / 5, max_premium: u64::MAX,
    }));
    env.send(&ixs, &[&owner]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let policy = policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &OBLIGATION_47WN);
    // A quarter of the LP's shares queued for withdrawal while the group is live.
    let shares = env.token_balance(&lsh) / 4;
    let rq = env.ix_request_withdraw(&lp.pubkey(), lsh, shares);
    env.send(&[rq], &[&lp]).unwrap();
    // The keeper lends the rest; the buffer keeps the group's reservation, the premium and the queued withdrawal.
    env.rebalance(false).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let v: Vault = env.anchor(&vault_pda());
    let cash = env.token_balance(&vault_usdc_pda());
    println!("lent {} USDC; cash {} USDC = buffer (reserved {}, premiums {}, queued withdrawal)", v.lent_value as f64 / 1e6, cash as f64 / 1e6, v.reserved_total as f64 / 1e6, v.premiums_unearned as f64 / 1e6);
    assert!(v.lent_value > LP / 2, "most of the vault is lent");
    // 100% utilisation from here on.
    env.make_usdc_reserve_illiquid();

    // Close and open (−10%), as tests/settle.rs.
    let asset: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    let admin = env.admin.pubkey();
    let tk = ticker("SPYx");
    env.set_time(OCT9_CLOSE + 30);
    let p = env.put_price(&Px::new(asset.feed_equity, SPY_CLOSE, OCT9_CLOSE - 1));
    let x = env.put_price(&Px::new(asset.feed_xstock, SPY_CLOSE * 1.0057, OCT9_CLOSE - 300));
    let snap = Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SnapshotClose { ticker: tk, closure_id: GROUP_OCT9 }.data(),
        acc::SnapshotClose { caller: admin, config: config_pda(), asset: asset_pda(&tk), epoch: epoch_pda(&tk, GROUP_OCT9), mint: SPYX_MINT, price: p, xcheck: Some(x) }
            .to_account_metas(None),
    );
    env.send_admin(&[snap]).unwrap();
    let open_px = SPY_CLOSE * 0.9;
    let u = env.put_price(&Px::new(asset.feed_equity, open_px, OCT12_OPEN + 30));
    let x = env.put_price(&Px::new(asset.feed_xstock, open_px * 1.0057, OCT12_OPEN + 60));
    env.set_time(OCT12_OPEN + 301);
    let mut metas = acc::PostSettlement { keeper: admin, config: config_pda(), asset: asset_pda(&tk), epoch: epoch_pda(&tk, GROUP_OCT9), mint: SPYX_MINT, xcheck: Some(x) }
        .to_account_metas(None);
    metas.push(AccountMeta::new_readonly(u, false));
    env.send_admin(&[Instruction::new_with_bytes(credence_core::ID, &ix::PostSettlement { ticker: tk, closure_id: GROUP_OCT9 }.data(), metas)]).unwrap();
    env.svm.warp_to_slot(env.slot() + 10);
    env.freshen_scope();

    // Settlement into the obligation, from cash.
    let cash0 = env.token_balance(&vault_usdc_pda());
    let k0 = env.token_balance(&v.kusdc);
    let keeper = env.funded();
    let mut ixs = kl::refreshes();
    ixs.push(env.ix_settle(&keeper.pubkey(), policy, owner_usdc, true));
    env.send(&ixs, &[&keeper]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let paid = env.anchor::<Policy>(&policy).payout;
    assert!(paid > 0);
    assert_eq!(cash0 - env.token_balance(&vault_usdc_pda()), paid, "the payout came from cash");
    assert_eq!(env.token_balance(&v.kusdc), k0, "nothing was redeemed (none could be)");
    // The queued withdrawal, from cash, after a rebalance that cannot redeem (refresh: the valuation must be fresh).
    env.rebalance(true).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let ticket = withdraw_ticket_pda(&lp.pubkey(), GROUP_OCT9);
    let lp_usdc0 = env.token_balance(&lu);
    let cash1 = env.token_balance(&vault_usdc_pda());
    let pw = env.ix_process_withdrawal(&keeper.pubkey(), ticket, lu);
    env.send(&[pw], &[&keeper]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let got = env.token_balance(&lu) - lp_usdc0;
    println!("100% utilisation: payout {} USDC and withdrawal {} USDC paid from cash; {} USDC still lent", paid as f64 / 1e6, got as f64 / 1e6, env.anchor::<Vault>(&vault_pda()).lent_value as f64 / 1e6);
    assert!(got > 0 && cash1 - env.token_balance(&vault_usdc_pda()) == got);
}

/// `value_yield` (anyone): a depositor's own transaction refreshes the reserve and books the yield, then deposits at
/// the fresh NAV; without the refresh it is refused.
#[test]
fn value_yield_lets_a_deposit_carry_its_own_valuation() {
    use anchor_lang::{solana_program::instruction::Instruction, InstructionData, ToAccountMetas};
    use credence_core::{accounts as acc, instruction as ix};
    let mut env = env_with_yield(W / 10);
    env.rebalance(false).unwrap();
    env.svm.warp_to_slot(env.slot() + 216_000);
    env.set_time(env.now() + 86_400);
    env.freshen_scope();
    let v0: Vault = env.anchor(&vault_pda());
    let vy = Instruction::new_with_bytes(
        credence_core::ID,
        &ix::ValueYield {}.data(),
        acc::ValueYield { vault: vault_pda(), kusdc: v0.kusdc, reserve: RESERVE_USDC }.to_account_metas(None),
    );
    let (lp, u, sh) = env.lp(10_000_000_000);
    assert_err(env.send(&[vy.clone()], &[&lp]), code(CoreError::ReserveNotRefreshed));
    let dep = env.ix_deposit(&lp.pubkey(), u, sh, 10_000_000_000);
    let m = env.send(&[kl::refresh_reserve(RESERVE_USDC), vy, dep], &[&lp]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("refresh_reserve + value_yield + deposit: {} CU", m.compute_units_consumed);
    let v: Vault = env.anchor(&vault_pda());
    assert!(v.yield_recognized > v0.yield_recognized && v.lent_value > v0.lent_value);
}
