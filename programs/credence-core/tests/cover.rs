//! Task 2.3: `buy_cover` on the real Kamino obligation `47wNsqpy…` (fixture), real scenario sets and joint set.
//! Premium = off-chain risk-core quote (golden); INV-2 (capacity), INV-3 (bell), concentration, slippage, and every
//! account check.

mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use credence_core::{
    kamino::{cover_snapshot, CoverAccounts, ObligationView, ReserveView},
    pricing, state::*, CoreError, WEEKEND_CLOSURE_DAYS,
};
use credence_risk_core::{quote_cover_capped, PremiumParams, SliceZ, U256};
use solana_keypair::Keypair;
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000; // 2,000,000 USDC

struct Buyer {
    kp: Keypair,
    usdc: Pubkey,
    obligation: Pubkey,
}

/// A buyer owning a copy of the real obligation, with its debt scaled by `num/den` (1/1 = as on mainnet).
fn buyer(env: &mut Env, num: u128, den: u128) -> Buyer {
    let kp = env.funded();
    let usdc = env.usdc_account(&kp.pubkey(), 100_000_000_000);
    let obligation = env.put_obligation(&kp.pubkey(), |d| ob::scale_debt(d, num, den));
    Buyer { kp, usdc, obligation }
}

fn args(b: &Buyer, t: &str, max_payout: u64, max_premium: u64) -> BuyArgs {
    BuyArgs {
        buyer: b.kp.pubkey(),
        buyer_usdc: b.usdc,
        obligation: b.obligation,
        deposit_reserve: RESERVE_SPYX,
        ticker: ticker(t),
        closure_id: GROUP_OCT9,
        max_payout,
        max_premium,
    }
}

fn buy(env: &mut Env, a: &BuyArgs, kp: &Keypair) -> TxResult {
    let ix = env.ix_buy_cover(a);
    env.send(&[ix], &[kp])
}

/// Snapshot of `b`'s obligation computed on the host with the same decoder (for expected values).
fn snapshot(env: &Env, b: &Buyer) -> credence_core::kamino::CoverSnapshot {
    let ob = ObligationView::decode(&env.data(&b.obligation)).unwrap();
    let dep = ReserveView::decode(&env.data(&RESERVE_SPYX)).unwrap();
    let bor = ReserveView::decode(&env.data(&RESERVE_USDC)).unwrap();
    let a = CoverAccounts {
        deposit_reserve_key: RESERVE_SPYX,
        deposit_reserve: &dep,
        borrow_reserve_key: RESERVE_USDC,
        borrow_reserve: &bor,
        asset_mint: SPYX_MINT,
        asset_reserves: [RESERVE_SPYX, Pubkey::default()],
        usdc_mint: USDC_MINT,
    };
    cover_snapshot(&ob, &b.kp.pubkey(), env.slot(), &a).unwrap()
}

/// Off-chain quote straight from risk-core (`quote_cover_capped`), with u from the vault state before the purchase.
/// Capacity reserved on the debt plus the interest cap, the premium priced on the expected interest (task 1.2).
fn golden_premium(env: &Env, t: &str, covered: u64, debt: u64, cap: u64) -> (u64, u64) {
    let cfg: Config = env.anchor(&config_pda());
    let reserved = credence_risk_core::priced_debt(debt, cfg.debt_growth_cap_wad).unwrap();
    let debt = credence_risk_core::priced_debt(debt, cfg.debt_growth_est_wad).unwrap();
    let a: AssetConfig = env.zc(&asset_pda(&ticker(t)));
    let v: Vault = env.anchor(&vault_pda());
    let l: LossVector = env.zc(&loss_pda(GROUP_OCT9));
    let x = pricing::CoverInputs { covered_value: covered, debt: reserved, max_payout: cap };
    let mut losses = vec![0u64; K];
    pricing::policy_losses(&a, &cfg, &x, &mut losses).unwrap();
    let c = pricing::capacity(&l.losses, &losses, v.reserved_total - l.max_loss, v.equity, cfg.u_max_wad).unwrap();
    let z = json_i16(&load_json(&format!("data/onchain/{t}-WEEKEND.json"))["z"]);
    let p = PremiumParams {
        sigma: U256::from(a.sigma_wad),
        dividend: U256::ZERO,
        kappa: U256::ZERO,
        collateral_value: U256::from(covered),
        debt_projected: U256::from(debt),
        closure_days: WEEKEND_CLOSURE_DAYS,
        util_after: U256::from(c.util_after_wad),
        theta: U256::from(cfg.theta_wad),
        cost_of_cap: U256::from(cfg.cost_of_cap_wad),
        eta: U256::from(cfg.eta_wad),
        beta: U256::from(cfg.beta_wad),
        min_premium: U256::from(cfg.min_premium),
    };
    let q = quote_cover_capped(&SliceZ(&z), &p, U256::from(cap)).unwrap();
    (q.premium.to::<u64>(), *losses.iter().max().unwrap())
}

/// Golden: the real obligation (D/C′ = 0.755) pays the 1 USDC floor; policy, loss vector, epoch and vault agree.
#[test]
fn buy_cover_real_obligation() {
    let mut env = Env::real(LP);
    let b = buyer(&mut env, 1, 1);
    let s = snapshot(&env, &b);
    let cap = s.debt / 4;
    let (want, worst) = golden_premium(&env, "SPYx", s.covered_value, s.debt, cap);
    assert_eq!(want, 1_000_000, "far from threshold: floor premium");
    let a = args(&b, "SPYx", cap, want);
    let m = buy(&mut env, &a, &b.kp).unwrap();
    println!("buy_cover (D/C' = 0.755): {} CU", m.compute_units_consumed);

    let epoch = epoch_pda(&ticker("SPYx"), GROUP_OCT9);
    let p: Policy = env.anchor(&policy_pda(&epoch, &b.obligation));
    assert_eq!((p.owner, p.obligation, p.epoch), (b.kp.pubkey(), b.obligation, epoch));
    assert_eq!((p.covered_value, p.debt, p.collateral_value), (s.covered_value, s.debt, s.collateral_value));
    assert_eq!(p.liquidation_threshold_wad, 750_000_000_000_000_000);
    assert_eq!((p.max_payout, p.premium, p.worst_loss), (cap, want, worst));
    assert_eq!((p.state, p.side, p.payout), (policy_state::ACTIVE, side::DOWN, 0));
    assert_eq!(env.token_balance(&b.usdc), 100_000_000_000 - want);
    assert_eq!(env.token_balance(&vault_usdc_pda()), LP + want);
    let v: Vault = env.anchor(&vault_pda());
    assert_eq!((v.premiums_unearned, v.live_groups, v.latest_group, v.equity), (want, 1, GROUP_OCT9, LP));
    let e: Epoch = env.anchor(&epoch);
    assert_eq!((e.policy_count, e.total_premium, e.total_max_payout, e.worst_loss_sum), (1, want, cap, worst));
    let l: LossVector = env.zc(&loss_pda(GROUP_OCT9));
    assert_eq!((l.policy_count, l.premiums, l.max_loss), (1, want, worst));
    assert_eq!(v.reserved_total, l.max_loss);
}

/// Golden on near-threshold positions (D/C′ from 0.95 to 0.99): premium equals the off-chain quote exactly, and the
/// buys stack in one group with INV-2 holding after each write.
#[test]
fn buy_cover_premium_golden_near_threshold() {
    let mut env = Env::real(LP);
    let cfg: Config = env.anchor(&config_pda());
    let mut worst_cu = 0;
    // D/C′ = 0.755 × num/den.
    for (num, den) in [(950u128, 755u128), (970, 755), (980, 755), (990, 755)] {
        let b = buyer(&mut env, num, den);
        let s = snapshot(&env, &b);
        let cap = s.debt / 10;
        let (want, _) = golden_premium(&env, "SPYx", s.covered_value, s.debt, cap);
        let m = buy(&mut env, &args(&b, "SPYx", cap, want), &b.kp).unwrap();
        worst_cu = worst_cu.max(m.compute_units_consumed);
        let p: Policy = env.anchor(&policy_pda(&epoch_pda(&ticker("SPYx"), GROUP_OCT9), &b.obligation));
        println!(
            "D/C'={:.3}: premium {:.2} USDC on cap {:.0} USDC, worst loss {:.0}, {} CU",
            s.debt as f64 / s.covered_value as f64,
            p.premium as f64 / 1e6,
            cap as f64 / 1e6,
            p.worst_loss as f64 / 1e6,
            m.compute_units_consumed
        );
        assert_eq!(p.premium, want);
        assert!(want > cfg.min_premium, "near threshold pays more than the floor");
        inv2_holds(&env);
    }
    println!("buy_cover worst CU (no refreshes): {worst_cu}");
    assert!(worst_cu < 900_000);
}

/// INV-2: reserved worst-case losses ≤ u_max × equity, and the vault's reservation equals the group's max loss.
fn inv2_holds(env: &Env) {
    let cfg: Config = env.anchor(&config_pda());
    let v: Vault = env.anchor(&vault_pda());
    let l: LossVector = env.zc(&loss_pda(GROUP_OCT9));
    assert_eq!(l.max_loss, *l.losses.iter().max().unwrap());
    assert_eq!(v.reserved_total, l.max_loss);
    assert!((v.reserved_total as u128) * (WAD as u128) <= (v.equity as u128) * (cfg.u_max_wad as u128));
}

/// INV-2: a policy that would push the worst joint loss over u_max × equity is refused, and state is unchanged.
#[test]
fn inv2_capacity_refused() {
    let mut env = Env::real(20_000_000_000); // 20,000 USDC of equity, u_max 50%: 10,000 USDC of capacity
    let b = buyer(&mut env, 990, 755);
    let s = snapshot(&env, &b);
    let before: LossVector = env.zc(&loss_pda(GROUP_OCT9));
    let r = buy(&mut env, &args(&b, "SPYx", s.debt / 2, u64::MAX), &b.kp);
    assert_err(r, code(CoreError::CapacityExceeded));
    let after: LossVector = env.zc(&loss_pda(GROUP_OCT9));
    assert_eq!(before.losses, after.losses);
    // A smaller cap fits.
    buy(&mut env, &args(&b, "SPYx", 1_000_000_000, u64::MAX), &b.kp).unwrap();
    inv2_holds(&env);
}

/// INV-3: no policy before `sale_open` or from the bell on.
#[test]
fn inv3_no_sales_after_bell() {
    let mut env = Env::real(LP);
    let e: Epoch = env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    let b = buyer(&mut env, 1, 1);
    let a = args(&b, "SPYx", 1_000_000_000, u64::MAX);
    env.set_time(e.bell);
    assert_err(buy(&mut env, &a, &b.kp), code(CoreError::SalesClosed));
    env.set_time(e.close + 3 * 86_400);
    assert_err(buy(&mut env, &a, &b.kp), code(CoreError::SalesClosed));
    env.set_time(e.sale_open - 1);
    assert_err(buy(&mut env, &a, &b.kp), code(CoreError::SalesClosed));
    env.set_time(e.bell - 1);
    buy(&mut env, &a, &b.kp).unwrap();
}

#[test]
fn concentration_cap() {
    let mut env = Env::real(LP);
    // max_asset_share 1% of u_max × equity = 10,000 USDC per asset.
    let admin = env.admin.pubkey();
    let mut p = default_params(admin, admin);
    p.max_asset_share_wad = WAD / 100;
    let ix = env.ix_set_params(&admin, p);
    env.send_admin(&[ix]).unwrap();
    let b = buyer(&mut env, 990, 755);
    let s = snapshot(&env, &b);
    assert_err(buy(&mut env, &args(&b, "SPYx", s.debt / 4, u64::MAX), &b.kp), code(CoreError::ConcentrationExceeded));
    buy(&mut env, &args(&b, "SPYx", 5_000_000_000, u64::MAX), &b.kp).unwrap();
}

#[test]
fn slippage_and_fee() {
    let mut env = Env::real(LP);
    let admin = env.admin.pubkey();
    let mut p = default_params(admin, admin);
    p.fee_bps = 1_000; // 10%
    let ix = env.ix_set_params(&admin, p);
    env.send_admin(&[ix]).unwrap();
    let b = buyer(&mut env, 980, 755);
    let s = snapshot(&env, &b);
    let cap = s.debt / 10;
    let (want, _) = golden_premium(&env, "SPYx", s.covered_value, s.debt, cap);
    assert_err(buy(&mut env, &args(&b, "SPYx", cap, want - 1), &b.kp), code(CoreError::PremiumAboveMax));
    buy(&mut env, &args(&b, "SPYx", cap, want), &b.kp).unwrap();
    let fee = want / 10;
    let v: Vault = env.anchor(&vault_pda());
    assert_eq!(env.token_balance(&v.fee_account), fee);
    assert_eq!(v.premiums_unearned, want - fee);
    assert_eq!(env.token_balance(&vault_usdc_pda()), LP + want - fee);
}

#[test]
fn buy_cover_failures() {
    let mut env = Env::real(LP);
    let b = buyer(&mut env, 1, 1);
    let s = snapshot(&env, &b);
    // Cap above the debt, or zero.
    assert_err(buy(&mut env, &args(&b, "SPYx", s.debt + 1, u64::MAX), &b.kp), code(CoreError::InvalidParam));
    assert_err(buy(&mut env, &args(&b, "SPYx", 0, u64::MAX), &b.kp), code(CoreError::InvalidParam));
    // Someone else's obligation (review fix 3).
    let mallory = env.funded();
    let musdc = env.usdc_account(&mallory.pubkey(), 100_000_000_000);
    let mut a = args(&b, "SPYx", 1_000_000_000, u64::MAX);
    a.buyer = mallory.pubkey();
    a.buyer_usdc = musdc;
    assert_err(buy(&mut env, &a, &mallory), code(CoreError::NotObligationOwner));
    // Wrong asset for the obligation's collateral (NVDAx cover on a SPYx deposit).
    let a = args(&b, "NVDAx", 1_000_000_000, u64::MAX);
    assert_err(buy(&mut env, &a, &b.kp), code(CoreError::UnsupportedObligation));
    // Not refreshed in this slot.
    env.svm.warp_to_slot(env.slot() + 1);
    assert_err(buy(&mut env, &args(&b, "SPYx", 1_000_000_000, u64::MAX), &b.kp), code(CoreError::ObligationNotRefreshed));
    // A look-alike obligation not owned by klend.
    let fake = Pubkey::new_unique();
    let mut acct = env.svm.get_account(&b.obligation).unwrap();
    acct.owner = Pubkey::new_unique();
    env.svm.set_account(fake, acct).unwrap();
    let mut a = args(&b, "SPYx", 1_000_000_000, u64::MAX);
    a.obligation = fake;
    assert_err(buy(&mut env, &a, &b.kp), code(CoreError::WrongProgram));
    // Multi-collateral obligation (review fix 4).
    let b2 = buyer(&mut env, 1, 1);
    let mut d = env.data(&b2.obligation);
    ob::put(&mut d, ob::OB_DEPOSITS + ob::DEPOSIT_LEN, RESERVE_QQQX.as_ref());
    ob::put(&mut d, ob::OB_DEPOSITS + ob::DEPOSIT_LEN + ob::DEP_MARKET_VALUE_SF, &(1u128 << 70).to_le_bytes());
    env.put_klend(b2.obligation, d);
    assert_err(buy(&mut env, &args(&b2, "SPYx", 1_000_000_000, u64::MAX), &b2.kp), code(CoreError::UnsupportedObligation));
    // One policy per obligation per epoch.
    let b3 = buyer(&mut env, 1, 1);
    buy(&mut env, &args(&b3, "SPYx", 1_000_000_000, u64::MAX), &b3.kp).unwrap();
    assert_fails(buy(&mut env, &args(&b3, "SPYx", 1_000_000_000, u64::MAX), &b3.kp));
    // Paused.
    let admin = env.admin.pubkey();
    let ix = env.ix_set_paused(&admin, true);
    env.send_admin(&[ix]).unwrap();
    let b4 = buyer(&mut env, 1, 1);
    assert_err(buy(&mut env, &args(&b4, "SPYx", 1_000_000_000, u64::MAX), &b4.kp), code(CoreError::Paused));
}

/// Audit A-01: klend lets an obligation change owner (`approve/accept_obligation_ownership`). The owner after the
/// transfer must not be able to buy a second policy on the same obligation for the same weekend: each would pay the
/// full repay-needed amount into one position.
#[test]
fn one_policy_per_obligation_across_owners() {
    let mut env = Env::real(LP);
    let b = buyer(&mut env, 980, 755);
    buy(&mut env, &args(&b, "SPYx", 1_000_000_000, u64::MAX), &b.kp).unwrap();
    // The obligation moves to a new owner before the bell.
    let next = env.funded();
    let next_usdc = env.usdc_account(&next.pubkey(), 100_000_000_000);
    let mut d = env.data(&b.obligation);
    ob::put(&mut d, ob::OB_OWNER, next.pubkey().as_ref());
    env.put_klend(b.obligation, d);
    let mut a = args(&b, "SPYx", 1_000_000_000, u64::MAX);
    a.buyer = next.pubkey();
    a.buyer_usdc = next_usdc;
    assert_fails(buy(&mut env, &a, &next));
    let e: Epoch = env.anchor(&epoch_pda(&ticker("SPYx"), GROUP_OCT9));
    assert_eq!(e.policy_count, 1);
    assert_eq!(env.token_balance(&next_usdc), 100_000_000_000);
}

/// A fake vault USDC account, share mint (its supply prices queued withdrawals) or fee account is refused.
#[test]
fn buy_cover_rejects_substituted_token_accounts() {
    let mut env = Env::real(LP);
    let b = buyer(&mut env, 1, 1);
    let a = args(&b, "SPYx", 1_000_000_000, u64::MAX);
    let attacker = env.usdc_account(&b.kp.pubkey(), 0);
    let fake_mint = anchor_lang::prelude::Pubkey::new_unique();
    env.put_mint(fake_mint, &b.kp.pubkey(), u64::MAX / 2, 6);
    for (idx, key) in [(7usize, attacker), (8, fake_mint), (9, attacker)] {
        let mut ix = env.ix_buy_cover(&a);
        ix.accounts[idx].pubkey = key;
        assert_err(env.send(&[ix], &[&b.kp]), code(CoreError::InvalidParam));
    }
}
