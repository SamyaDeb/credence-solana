//! C1 credit unlock (plan/09 "Phase C, C1"): the published numbers against the program.
//!
//! - Golden: for 5 scan positions of the latest `data/unlock/unlock-*.json` at D/C′ 0.90 (one single-asset Kamino, one
//!   multi-collateral, one PYUSD debt, two Jupiter Lend), the u = 0 premium, shield loading and worst loss the file
//!   publishes equal a simulated `quote_cover` / `quote_cover_multi` / alias `quote_cover` on the real data, deployed
//!   parameters and the file's σ_b, to the base unit. A Jupiter alias prices exactly as `buy_cover_jl` does: `<T>.J`'s
//!   WEEKEND set, σ, σ_b and gap factors (`quote_cover` and `buy_cover_jl` call the same `premium` + `shield_loading`).
//! - Capacity: the SPYx single-asset book at 0.90, in the file's sale order, with the helper's model
//!   (`examples/unlock/model.rs`): at the equity the helper says capacity needs, the program's capacity check in
//!   `quote_cover` accepts the last policy on top of the others' losses; 1 base unit less, it refuses.
//!
//! Needs the Jupiter binaries `scripts/test.sh` dumps (for `set_asset_lender`); skips, saying so, without them.

mod common;

#[path = "../examples/unlock/model.rs"]
mod model;

use std::collections::HashMap;

use anchor_lang::{
    prelude::Pubkey, solana_program::instruction::Instruction, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
};
use common::*;
use credence_core::{accounts as acc, instruction as ix, state::*, CoreError, Quote};
use serde_json::Value;
use solana_account::Account;
use solana_signer::Signer;

const T: &str = "0.9";
const GROUP: u32 = 20261009;

fn latest_unlock() -> Option<Value> {
    let dir = format!("{}/../../data/unlock", env!("CARGO_MANIFEST_DIR"));
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|f| f.starts_with("unlock-") && f.ends_with(".json"))
        .collect();
    files.sort();
    Some(serde_json::from_str(&std::fs::read_to_string(format!("{dir}/{}", files.last()?)).ok()?).ok()?)
}

fn jl_binaries() -> bool {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/programs");
    ["jl_vaults", "jl_liquidity", "jl_oracle"].iter().all(|n| std::path::Path::new(&format!("{dir}/{n}.so")).exists())
}

fn u(v: &Value) -> u64 {
    v.as_str().unwrap().parse().unwrap()
}

/// The deployed parameters (`examples/unlock/model.rs::config`) as `set_params` takes them.
fn deployed(admin: Pubkey) -> credence_core::ConfigParams {
    let c = model::config();
    credence_core::ConfigParams {
        u_max_wad: c.u_max_wad,
        max_asset_share_wad: c.max_asset_share_wad,
        theta_wad: c.theta_wad,
        cost_of_cap_wad: c.cost_of_cap_wad,
        eta_wad: c.eta_wad,
        beta_wad: c.beta_wad,
        kappa_wad: c.kappa_wad,
        min_premium: c.min_premium,
        shield_alpha_wad: c.shield_alpha_wad,
        shield_buffer_wad: c.shield_buffer_wad,
        shield_health_wad: c.shield_health_wad,
        shield_lambda_wad: c.shield_lambda_wad,
        shield_reserve_k_wad: c.shield_reserve_k_wad,
        debt_growth_cap_wad: c.debt_growth_cap_wad,
        debt_growth_est_wad: c.debt_growth_est_wad,
        ..default_params(admin, admin)
    }
}

/// Every xStock of `assets.json` and the aliases SPYx.J and TSLAx.J on the real data, with the file's σ_b.
/// `set_asset_lender` requires the alias's mint to be the vault's collateral; the test chain has one Jupiter vault
/// (78, SPYx), so TSLAx.J is registered with SPYx's mint: the quote reads no mint, only TSLAx's σ, set, σ_b and joint
/// column (its gap factors are TSLAx's, `is_alias_of`).
fn setup(basis: &HashMap<String, u64>) -> Env {
    let mut env = Env::new();
    env.init_config();
    let a = env.admin.pubkey();
    let ix0 = env.ix_set_params(&a, deployed(a));
    env.send_admin(&[ix0]).unwrap();
    let assets = load_json("data/onchain/assets.json");
    let joint = load_json("data/onchain/joint-v2.json");
    let cols: Vec<Vec<i16>> = joint["columns"].as_array().unwrap().iter().map(json_i16).collect();
    let tickers: Vec<String> = assets.as_array().unwrap().iter().map(|x| x["ticker"].as_str().unwrap().to_string()).collect();
    for (i, t) in tickers.iter().enumerate() {
        let mut p = real_asset_params(i);
        p.basis_sigma_wad = basis[t];
        let mint: Pubkey = assets[i]["mint"].as_str().unwrap().parse().unwrap();
        let ix = env.ix_add_asset(&a, ticker(t), mint, p);
        env.send_admin(&[ix]).unwrap();
        env.upload_scenarios(t, &json_i16(&load_json(&format!("data/onchain/{t}-WEEKEND.json"))["z"]), 400).unwrap();
    }
    let jt: Vec<&str> = tickers.iter().map(|t| t.as_str()).collect();
    env.upload_joint(2, &jt, &cols, 256).unwrap();
    for t in &tickers {
        env.compute_gap_factors(t, 2, 128).unwrap();
    }
    let snap = env.load_jupiter();
    let (vault_config, oracle) = (jl::key(&snap["vaultConfig"]), jl::key(&snap["oracle"]));
    for base in ["SPYx", "TSLAx"] {
        let i = tickers.iter().position(|t| t == base).unwrap();
        let alias = format!("{base}.J");
        let mut p = real_asset_params(i);
        p.settle_source = credence_core::oracle::source::JUPITER;
        p.kamino_reserves = [Pubkey::default(); 2];
        p.basis_sigma_wad = basis[base];
        let add = env.ix_add_asset(&a, ticker(&alias), SPYX_MINT, p);
        env.send_admin(&[add]).unwrap();
        let set = Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SetAssetLender { ticker: ticker(&alias) }.data(),
            acc::SetAssetLender { admin: a, config: config_pda(), asset: asset_pda(&ticker(&alias)), lender_vault: vault_config, lender_oracle_config: oracle }
                .to_account_metas(None),
        );
        env.send_admin(&[set]).unwrap_or_else(|e| panic!("{alias}: {:?}\n{:#?}", e.err, e.meta.logs));
        env.upload_scenarios(&alias, &json_i16(&load_json(&format!("data/onchain/{base}-WEEKEND.json"))["z"]), 400).unwrap();
        env.compute_gap_factors(&alias, 2, 128).unwrap();
        assert_eq!(env.zc::<AssetConfig>(&asset_pda(&ticker(&alias))).lender, lender::JUPITER as u64);
    }
    env
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
            epoch: None,
            earnings: None,
        }
        .to_account_metas(None),
    )
}

fn simulate(env: &mut Env, ix: Instruction) -> Result<Quote, String> {
    match env.send_admin(&[ix]) {
        Ok(m) => Ok(Quote::deserialize(&mut m.return_data.data.as_slice()).unwrap()),
        Err(e) => Err(format!("{:?}", e.err)),
    }
}

/// The five golden positions: of each kind with a 0.90 target, the one with the most extra debt (well above the
/// 5 USDC minimum premium, so the pricing itself is compared, not the floor).
fn golden_rows(doc: &Value) -> Vec<(&'static str, &Value)> {
    let ps = doc["positions"].as_array().unwrap();
    let pick = |f: &dyn Fn(&Value) -> bool| {
        ps.iter().filter(|p| !p["targets"][T].is_null() && f(p)).max_by_key(|p| u(&p["targets"][T]["extra"])).expect("golden position")
    };
    let legs = |p: &Value| p["legs"].as_array().unwrap().len();
    vec![
        ("single Kamino", pick(&|p| p["path"] == "single")),
        ("multi-collateral", pick(&|p| p["path"] == "multi" && legs(p) > 1 && p["borrow"] == "USDC")),
        ("PYUSD debt", pick(&|p| p["path"] == "multi" && p["borrow"] == "PYUSD")),
        ("Jupiter SPYx.J", pick(&|p| p["path"] == "jupiter" && p["asset"] == "SPYx")),
        ("Jupiter TSLAx.J", pick(&|p| p["path"] == "jupiter" && p["asset"] == "TSLAx")),
    ]
}

fn basis_of(doc: &Value) -> HashMap<String, u64> {
    doc["parameters"]["basisWad"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), u(v))).collect()
}

#[test]
fn unlock_premiums_match_the_program() {
    let Some(doc) = latest_unlock() else {
        eprintln!("SKIPPED: no data/unlock/unlock-*.json (run scripts/src/unlock.ts)");
        return;
    };
    if !jl_binaries() {
        eprintln!("SKIPPED: Jupiter binaries missing (scripts/test.sh dumps them with MAINNET_RPC)");
        return;
    }
    let mut env = setup(&basis_of(&doc));
    for (kind, p) in golden_rows(&doc) {
        let x = &p["targets"][T];
        let (d, q) = (u(&x["debt"]), &x["quote"]);
        let legs: Vec<(String, u64)> =
            p["legs"].as_array().unwrap().iter().map(|l| (l["ticker"].as_str().unwrap().to_string(), u(&l["covered"]))).collect();
        let onchain = if p["path"] == "multi" {
            let names: Vec<&str> = legs.iter().map(|l| l.0.as_str()).collect();
            let ix = env.ix_quote_cover_multi(&names, legs.iter().map(|l| l.1).collect(), u(&p["stable"]), d, d);
            simulate(&mut env, ix)
        } else {
            simulate(&mut env, ix_quote(&legs[0].0, None, legs[0].1, d, d))
        }
        .unwrap_or_else(|e| panic!("{kind} {}: {e}", p["id"]));
        println!(
            "golden {kind:<17} {} {:?}: D_t {d}, premium {} (file {}), loading {}, worst {}",
            p["id"].as_str().unwrap(),
            legs,
            onchain.premium,
            q["premium"].as_str().unwrap(),
            onchain.shield_loading,
            onchain.worst_loss
        );
        assert_eq!(onchain.premium, u(&q["premium"]), "{kind}: premium");
        assert_eq!(onchain.shield_loading, u(&q["loading"]), "{kind}: shield loading");
        assert_eq!(onchain.worst_loss, u(&q["worstLoss"]), "{kind}: worst loss");
    }
}

/// Writes a Vault with `equity` and the group's LossVector (as `tests/pricing.rs` does for capacity boundaries).
fn put_vault(env: &mut Env, equity: u64, group_losses: [u64; K]) -> (Pubkey, Pubkey, Pubkey) {
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
        reserved_total: max_loss,
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
        inv: Default::default(),
        yield_reserve: Default::default(),
        kusdc: Default::default(),
        lent_ctokens: 0,
        lent_value: 0,
        lent_valued_at: 0,
        yield_recognized: 0,
        cash_headroom_wad: 0,
        advanced_live: 0,
        pyusd_sleeve: Default::default(),
        pyusd_reserved: 0,
        pyusd_advanced: 0,
        hedge_pending: 0,
    };
    let mut data = Vault::DISCRIMINATOR.to_vec();
    anchor_lang::AnchorSerialize::serialize(&v, &mut data).unwrap();
    data.resize(Vault::SIZE, 0);
    env.svm.set_account(vault, Account { lamports: 10_000_000, data, owner: credence_core::ID, executable: false, rent_epoch: 0 }).unwrap();
    let loss = pda(&[SEED_LOSS, &GROUP.to_le_bytes()]);
    let lv = LossVector { losses: group_losses, max_loss, group: GROUP, ..bytemuck::Zeroable::zeroed() };
    let mut data = LossVector::DISCRIMINATOR.to_vec();
    data.extend_from_slice(bytemuck::bytes_of(&lv));
    env.svm.set_account(loss, Account { lamports: 10_000_000, data, owner: credence_core::ID, executable: false, rent_epoch: 0 }).unwrap();
    (vault, loss, share_mint)
}

#[test]
fn unlock_capacity_matches_the_program() {
    let Some(doc) = latest_unlock() else {
        eprintln!("SKIPPED: no data/unlock/unlock-*.json (run scripts/src/unlock.ts)");
        return;
    };
    if !jl_binaries() {
        eprintln!("SKIPPED: Jupiter binaries missing (scripts/test.sh dumps them with MAINNET_RPC)");
        return;
    }
    let basis = basis_of(&doc);
    let root = format!("{}/../..", env!("CARGO_MANIFEST_DIR"));
    let m = model::load(&root, &basis).unwrap();
    let mut book: Vec<(String, model::Position)> = doc["positions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["path"] == "single" && p["asset"] == "SPYx" && !p["targets"][T].is_null())
        .map(|p| {
            let l = &p["legs"][0];
            let pos = model::Position {
                id: p["id"].as_str().unwrap().to_string(),
                legs: vec![(m.index["SPYx"], u(&l["covered"]))],
                stable: 0,
                debt: u(&p["targets"][T]["debt"]),
                multi: false,
            };
            (sha256_hex(p["id"].as_str().unwrap()), pos)
        })
        .collect();
    book.sort_by(|a, b| a.0.cmp(&b.0));
    let ps: Vec<model::Position> = book.into_iter().map(|b| b.1).collect();
    assert!(ps.len() > 100, "SPYx book: {} positions", ps.len());
    let priced: Vec<model::Priced> = ps.iter().map(|p| model::price(&m, p, p.debt, 0).unwrap()).collect();
    let need = model::equity_needed(&m, &ps, &priced);
    let n = ps.len();
    let mut others = [0u64; K];
    for pr in &priced[..n - 1] {
        for (g, l) in others.iter_mut().zip(&pr.losses) {
            *g += l;
        }
    }
    // The program's own check, the last policy on top of the others: accepted at the equity, refused 1 base unit below.
    // Only binding if the last policy is in the scenario that binds; otherwise the bound moves to an earlier one.
    let last = &ps[n - 1];
    let mut env = setup(&basis);
    let v = put_vault(&mut env, need.capacity, others);
    let q = simulate(&mut env, ix_quote("SPYx", Some(v), last.legs[0].1, last.debt, last.debt)).expect("accepted at the equity");
    assert_eq!(q.group_worst_after, need.group_worst, "group worst after the book");
    let v = put_vault(&mut env, need.capacity - 1, others);
    let e = simulate(&mut env, ix_quote("SPYx", Some(v), last.legs[0].1, last.debt, last.debt)).expect_err("refused 1 unit below");
    assert!(e.contains(&format!("Custom({})", code(CoreError::CapacityExceeded))), "{e}");
    println!(
        "capacity: SPYx book at {T}: {n} policies, group worst {} → capacity equity {} (program agrees; total equity with concentration {})",
        need.group_worst, need.capacity, need.equity
    );
}

fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}
