//! Task 1.6: quote_cover + capacity on real data. Golden equivalence with risk-core and compute measurement.

mod common;

use anchor_lang::{
    prelude::Pubkey, solana_program::instruction::Instruction, AnchorDeserialize, Discriminator, InstructionData,
    ToAccountMetas,
};
use common::*;
use credence_core::{
    accounts as acc, instruction as ix, pricing, state::*, CoreError, Quote, WEEKEND_CLOSURE_DAYS,
};
use credence_risk_core::{
    fixed::{ceil_div, mul_div_up, mul_wad_up},
    premium::scenario_loss,
    PremiumParams, U256,
};
use serde_json::Value;
use solana_signer::Signer;
use solana_account::Account;

fn load(path: &str) -> Value {
    let p = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}
fn zs(v: &Value) -> Vec<i16> {
    v.as_array().unwrap().iter().map(|x| x.as_i64().unwrap() as i16).collect()
}

const TICKERS: [&str; 3] = ["SPYx", "QQQx", "NVDAx"];
const MINTS: [Pubkey; 3] = [SPYX_MINT, QQQX_MINT, NVDAX_MINT];
const GROUP: u32 = 20261009;

/// Real data (`data/onchain`: the calibrated 3,000-point sets, joint v1) on LiteSVM.
fn setup() -> (Env, Vec<Vec<i16>>, Vec<Vec<i16>>) {
    let mut env = Env::new();
    let a = env.admin.pubkey();
    let ix = env.ix_init_config(&a, default_params(a, a));
    env.send_admin(&[ix]).unwrap();
    let assets = load("data/onchain/assets.json");
    let joint = load("data/onchain/joint-v1.json");
    let cols: Vec<Vec<i16>> = joint["columns"].as_array().unwrap().iter().map(zs).collect();
    let mut sets = vec![];
    for (i, t) in TICKERS.iter().enumerate() {
        let sigma = assets[i]["sigmaWad"].as_str().unwrap().parse::<u64>().unwrap();
        env.add_asset(t, MINTS[i], sigma, i as u8);
        let f = load(&format!("data/onchain/{t}-WEEKEND.json"));
        let z = zs(&f["z"]);
        env.upload_scenarios(t, &z, 400).unwrap();
        sets.push(z);
    }
    env.upload_joint(1, &TICKERS, &cols, 256).unwrap();
    for t in TICKERS {
        env.compute_gap_factors(t, 1, 128).unwrap();
    }
    (env, sets, cols)
}

/// Writes a Vault and a LossVector directly, to put the quote at exact capacity boundaries.
fn put_vault(env: &mut Env, equity: u64, reserved_other: u64, group_losses: [u64; K]) -> (Pubkey, Pubkey, Pubkey) {
    let vault = pda(&[SEED_VAULT]);
    let share_mint = Pubkey::new_unique();
    env.put_mint(share_mint, &vault, equity, 6);
    let (_, vbump) = Pubkey::find_program_address(&[SEED_VAULT], &credence_core::ID);
    let max_loss = *group_losses.iter().max().unwrap();
    let v = Vault {
        usdc: Pubkey::new_unique(),
        share_mint,
        fee_account: Pubkey::new_unique(),
        share_escrow: Pubkey::new_unique(),
        equity,
        reserved_total: reserved_other + max_loss,
        premiums_unearned: 0,
        queued_deposits: 0,
        queued_withdraw_shares: 0,
        total_premiums: 0,
        total_payouts: 0,
        live_groups: 1,
        latest_group: GROUP,
        live: [GROUP, 0, 0, 0, 0, 0, 0, 0],
        bump: vbump,
        usdc_bump: 0,
        mint_bump: 0,
        escrow_bump: 0,
    };
    let mut data = Vault::DISCRIMINATOR.to_vec();
    anchor_lang::AnchorSerialize::serialize(&v, &mut data).unwrap();
    data.resize(Vault::SIZE, 0);
    env.svm.set_account(vault, Account { lamports: 10_000_000, data, owner: credence_core::ID, executable: false, rent_epoch: 0 }).unwrap();

    let loss = pda(&[SEED_LOSS, &GROUP.to_le_bytes()]);
    let lv = LossVector {
        losses: group_losses,
        max_loss,
        premiums: 0,
        group: GROUP,
        policy_count: 0,
        policies_settled: 0,
        settled: 0,
        bump: 0,
        _pad: [0; 2],
    };
    let mut data = LossVector::DISCRIMINATOR.to_vec();
    data.extend_from_slice(bytemuck::bytes_of(&lv));
    env.svm.set_account(loss, Account { lamports: 10_000_000, data, owner: credence_core::ID, executable: false, rent_epoch: 0 }).unwrap();
    (vault, loss, share_mint)
}

fn ix_quote(t: &str, vault: Option<(Pubkey, Pubkey, Pubkey)>, c: u64, d: u64, cap: u64) -> Instruction {
    let tk = ticker(t);
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::QuoteCover { covered_value: c, debt: d, max_payout: cap }.data(),
        acc::QuoteCover {
            config: config_pda(),
            asset: asset_pda(&tk),
            scenarios: scen_pda(&tk, closure::WEEKEND),
            vault: vault.map(|v| v.0),
            loss: vault.map(|v| v.1),
            share_mint: vault.map(|v| v.2),
        }
        .to_account_metas(None),
    )
}

fn quote(env: &mut Env, t: &str, vault: Option<(Pubkey, Pubkey, Pubkey)>, c: u64, d: u64, cap: u64) -> (Quote, u64) {
    let ix = ix_quote(t, vault, c, d, cap);
    let m = env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{t}: {:?}\n{:#?}", e.err, e.meta.logs));
    (Quote::deserialize(&mut m.return_data.data.as_slice()).unwrap(), m.compute_units_consumed)
}

/// Independent reference for the capped premium: losses min(cap, L_k) from risk-core's U256 `scenario_loss`, then
/// F-4.3 restated. The on-chain premium must equal it exactly.
fn reference_premium(z: &[i16], sigma: u64, c: u64, d: u64, cap: u64, util: u64) -> u64 {
    let cfg = default_params(Pubkey::default(), Pubkey::default());
    let p = PremiumParams {
        sigma: U256::from(sigma),
        dividend: U256::ZERO,
        kappa: U256::ZERO,
        collateral_value: U256::from(c),
        debt_projected: U256::from(d),
        closure_days: WEEKEND_CLOSURE_DAYS,
        util_after: U256::from(util),
        theta: U256::from(cfg.theta_wad),
        cost_of_cap: U256::from(cfg.cost_of_cap_wad),
        eta: U256::from(cfg.eta_wad),
        beta: U256::from(cfg.beta_wad),
        min_premium: U256::ZERO,
    };
    let wad = U256::from(WAD);
    let n = z.len();
    let losses: Vec<U256> = z.iter().map(|zk| scenario_loss(*zk, &p).unwrap().min(U256::from(cap))).collect();
    let m = mul_div_up(wad - p.beta, U256::from(n), wad).unwrap().max(U256::from(1u8)).to::<usize>();
    let el = ceil_div(losses.iter().fold(U256::ZERO, |a, b| a + b), U256::from(n)).unwrap();
    let es = ceil_div(losses[..m].iter().fold(U256::ZERO, |a, b| a + b), U256::from(m)).unwrap();
    let tau = mul_div_up(U256::from(WEEKEND_CLOSURE_DAYS), wad, U256::from(365u16)).unwrap();
    let base = mul_wad_up(wad + p.theta, el).unwrap() + mul_wad_up(mul_wad_up(p.cost_of_cap, tau).unwrap(), es).unwrap();
    let mult = wad + mul_wad_up(p.eta, mul_wad_up(p.util_after, p.util_after).unwrap()).unwrap();
    mul_wad_up(mult, base).unwrap().to::<u64>().max(cfg.min_premium)
}

/// Positions: covered value C′ = LT × C and debt D, as D/C′ from comfortable to almost liquidatable.
fn positions() -> Vec<(u64, u64, u64)> {
    let c = 100_000_000_000u64; // C′ = 100,000 USDC
    [0.50, 0.80, 0.90, 0.95, 0.98, 0.995]
        .iter()
        .map(|r| {
            let d = (c as f64 * r) as u64;
            (c, d, d / 4) // cap 25% of the debt
        })
        .collect()
}

#[test]
fn premium_golden_matches_reference() {
    let (mut env, sets, _) = setup();
    let utils = [0u64, WAD / 4];
    for (i, t) in TICKERS.iter().enumerate() {
        let sigma = env.zc::<AssetConfig>(&asset_pda(&ticker(t))).sigma_wad;
        for (c, d, cap) in positions() {
            for (u_i, util) in utils.iter().enumerate() {
                // util = 0 without capacity accounts; util > 0 via a vault sized to give roughly that utilisation.
                let (q, _) = if u_i == 0 {
                    quote(&mut env, t, None, c, d, cap)
                } else {
                    let v = put_vault(&mut env, 4 * 2 * cap, 0, [0; K]);
                    quote(&mut env, t, Some(v), c, d, cap)
                };
                let reference = reference_premium(&sets[i], sigma, c, d, cap, if u_i == 0 { 0 } else { q.util_after_wad });
                assert_eq!(q.premium, reference, "{t} D={d} u={}", q.util_after_wad);
                let _ = util;
            }
        }
    }
}

#[test]
fn loss_vector_golden_matches_risk_core() {
    let (env, _, cols) = setup();
    for (i, t) in TICKERS.iter().enumerate() {
        let a: AssetConfig = env.zc(&asset_pda(&ticker(t)));
        for (c, d, cap) in positions() {
            let x = pricing::CoverInputs { covered_value: c, debt: d, max_payout: cap };
            let mut out = vec![0u64; K];
            let worst = pricing::policy_losses(&a, &x, &mut out).unwrap();
            let p = PremiumParams {
                sigma: U256::from(a.sigma_wad),
                dividend: U256::ZERO,
                kappa: U256::ZERO,
                collateral_value: U256::from(c),
                debt_projected: U256::from(d),
                closure_days: 3,
                util_after: U256::ZERO,
                theta: U256::ZERO,
                cost_of_cap: U256::ZERO,
                eta: U256::ZERO,
                beta: U256::from(WAD / 2),
                min_premium: U256::ZERO,
            };
            for j in 0..K {
                let r = scenario_loss(cols[i][j], &p).unwrap().min(U256::from(cap)).to::<u64>();
                // Q64.64 g ≤ WAD g, so the on-chain loss is never smaller and at most one base unit larger.
                assert!(out[j] >= r && out[j] - r <= 1, "{t} j={j}: {} vs {r}", out[j]);
            }
            assert_eq!(worst, *out.iter().max().unwrap());
        }
    }
}

#[test]
fn quote_failures() {
    let (mut env, _, _) = setup();
    let (c, d) = (100_000_000_000, 90_000_000_000);
    // Cap above debt.
    let ix = ix_quote("SPYx", None, c, d, d + 1);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));
    // Scenario set of another asset.
    let mut ix = ix_quote("SPYx", None, c, d, d / 2);
    ix.accounts[2].pubkey = scen_pda(&ticker("NVDAx"), closure::WEEKEND);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));
    // Capacity: a vault with tiny equity (INV-2).
    let v = put_vault(&mut env, 1_000_000, 0, [0; K]);
    let ix = ix_quote("NVDAx", Some(v), c, d, d / 2);
    assert_err(env.send_admin(&[ix]), code(CoreError::CapacityExceeded));
    // Stale gap factors after a σ change.
    let admin = env.admin.pubkey();
    let ix = env.ix_update_asset(&admin, ticker("SPYx"), asset_params(WAD / 50, 0));
    env.send_admin(&[ix]).unwrap();
    let ix = ix_quote("SPYx", None, c, d, d / 2);
    assert_err(env.send_admin(&[ix]), code(CoreError::StaleGapFactors));
}

/// INV-2 at the boundary: exactly at the limit passes, one unit over fails.
#[test]
fn capacity_boundary() {
    let (mut env, _, _) = setup();
    let (c, d, cap) = (100_000_000_000u64, 95_000_000_000u64, 20_000_000_000u64);
    let a: AssetConfig = env.zc(&asset_pda(&ticker("NVDAx")));
    let mut out = vec![0u64; K];
    let worst = pricing::policy_losses(&a, &pricing::CoverInputs { covered_value: c, debt: d, max_payout: cap }, &mut out).unwrap();
    let reserved = 7_000_000u64;
    // u_max = 50%: limit = equity / 2. equity = 2 × (worst + reserved) is exactly at the limit.
    let v = put_vault(&mut env, 2 * (worst + reserved), reserved, [0; K]);
    let (q, _) = quote(&mut env, "NVDAx", Some(v), c, d, cap);
    assert_eq!(q.util_after_wad, WAD);
    let v = put_vault(&mut env, 2 * (worst + reserved) - 2, reserved, [0; K]);
    let ix = ix_quote("NVDAx", Some(v), c, d, cap);
    assert_err(env.send_admin(&[ix]), code(CoreError::CapacityExceeded));
}

/// Compute units for quote + capacity on the real 3,000-point sets (README, Compute units).
#[test]
fn compute_units_real_data() {
    let (mut env, sets, _) = setup();
    let mut worst_cu = 0;
    for t in TICKERS {
        let mut row = vec![];
        for (c, d, cap) in positions() {
            let v = put_vault(&mut env, 1_000_000_000_000, 0, [1_000_000; K]);
            let (_, cu_cap) = quote(&mut env, t, Some(v), c, d, cap);
            let (q, cu) = quote(&mut env, t, None, c, d, cap);
            worst_cu = worst_cu.max(cu_cap);
            row.push(format!("D/C'={:.3}: {cu_cap} CU (no capacity {cu}), premium {:.2} USDC", d as f64 / c as f64, q.premium as f64 / 1e6));
        }
        println!("n={} {t}:\n  {}", sets[0].len(), row.join("\n  "));
    }
    println!("worst quote+capacity CU: {worst_cu}");
    assert!(worst_cu < 900_000, "over budget: {worst_cu}");
}
