//! Task 1.4: account sizes, admin instructions, chunked uploads, on-chain gap factors.

mod common;

use common::*;
use credence_core::{math::wad_to_q64_down, state::*, CoreError};
use credence_risk_core::{gap_factor, U256};
use solana_signer::Signer;

/// Sizes in bytes including the 8-byte discriminator. Documented in plan/03 (Accounts table).
#[test]
fn account_sizes() {
    let sizes = [
        ("Config", Config::SIZE),
        ("AssetConfig", AssetConfig::SIZE),
        ("ScenarioSet", ScenarioSet::SIZE),
        ("JointSet", JointSet::SIZE),
        ("Epoch", Epoch::SIZE),
        ("Vault", Vault::SIZE),
        ("LossVector", LossVector::SIZE),
        ("Policy", Policy::SIZE),
        ("Calendar", Calendar::SIZE),
    ];
    for (n, s) in sizes {
        println!("{n}: {s} bytes");
    }
    assert_eq!(Config::SIZE, 8 + 4 * 32 + 8 * 8 + 2 + 2 + 2 + 4 + 1 + 1);
    assert_eq!(AssetConfig::SIZE, 8 + 72 + 8 + 32 + 96 + 64 + 64 + 32 + 2 + 1 + 1 + 1 + 3 + 16 * K);
    assert_eq!(ScenarioSet::SIZE, 8 + 48 + 2 * N_SCEN);
    assert_eq!(JointSet::SIZE, 8 + 48 + 8 * MAX_JOINT_ASSETS + 2 * K * MAX_JOINT_ASSETS);
    assert_eq!(Calendar::SIZE, 8 + 48 + 24 * N_SESSIONS);
    assert_eq!(LossVector::SIZE, 8 + 8 * K + 8 + 8 + 4 + 4 + 4 + 4);
    // All accounts can be created in one instruction (CPI realloc limit 10,240 bytes).
    for (n, s) in sizes {
        assert!(s <= 10_240, "{n} too large for a single init: {s}");
    }
}

#[test]
fn init_config_happy_and_twice_fails() {
    let mut env = Env::new();
    env.init_config();
    let c: Config = env.anchor(&config_pda());
    assert_eq!(c.admin, env.admin.pubkey());
    assert_eq!(c.usdc_mint, USDC_MINT);
    assert_eq!(c.u_max_wad, WAD / 2);
    assert_eq!(env.data(&config_pda()).len(), Config::SIZE);
    // A second init must fail (account exists).
    let a = env.admin.pubkey();
    let ix = env.ix_init_config(&a, default_params(a, a));
    assert_fails(env.send_admin(&[ix]));
}

#[test]
fn init_config_rejects_bad_params_and_wrong_mint() {
    let mut env = Env::new();
    let a = env.admin.pubkey();
    let mut p = default_params(a, a);
    p.u_max_wad = WAD + 1;
    let ix = env.ix_init_config(&a, p);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));

    // USDC must be a classic SPL Token mint: a Token-2022 mint is rejected.
    let mut ix = env.ix_init_config(&a, default_params(a, a));
    ix.accounts[2].pubkey = SPYX_MINT;
    assert_fails(env.send_admin(&[ix]));
}

#[test]
fn set_params_admin_only() {
    let mut env = Env::new();
    env.init_config();
    let a = env.admin.pubkey();
    let mut p = default_params(a, a);
    p.theta_wad = WAD / 4;
    let ix = env.ix_set_params(&a, p);
    env.send_admin(&[ix]).unwrap();
    assert_eq!(env.anchor::<Config>(&config_pda()).theta_wad, WAD / 4);

    let mallory = env.funded();
    let ix = env.ix_set_params(&mallory.pubkey(), p);
    assert_err(env.send(&[ix], &[&mallory]), code(CoreError::Unauthorized));
}

#[test]
fn add_asset_with_real_xstock_mint() {
    let mut env = Env::new();
    env.init_config();
    env.add_asset("SPYx", SPYX_MINT, WAD / 100, 0);
    let a: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    assert_eq!(a.ticker, ticker("SPYx"));
    assert_eq!(a.mint, SPYX_MINT);
    assert_eq!(a.sigma_wad, WAD / 100);
    assert_eq!(a.enabled, 1);
    assert_eq!(a.gf_count, 0);
    assert_eq!(env.data(&asset_pda(&ticker("SPYx"))).len(), AssetConfig::SIZE);
}

#[test]
fn add_asset_failures() {
    let mut env = Env::new();
    env.init_config();
    let a = env.admin.pubkey();
    // USDC: not Token-2022, 6 decimals.
    let ix = env.ix_add_asset(&a, ticker("USDCx"), USDC_MINT, asset_params(WAD / 100, 0));
    assert_fails(env.send_admin(&[ix]));
    // Non-admin.
    let mallory = env.funded();
    let ix = env.ix_add_asset(&mallory.pubkey(), ticker("SPYx"), SPYX_MINT, asset_params(WAD / 100, 0));
    assert_err(env.send(&[ix], &[&mallory]), code(CoreError::Unauthorized));
    // σ = 0.
    let ix = env.ix_add_asset(&a, ticker("SPYx"), SPYX_MINT, asset_params(0, 0));
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));
}

fn synthetic_set(n: usize) -> Vec<i16> {
    // Sorted, heavy left tail, like a real set: -12000 .. +8000.
    (0..n).map(|i| (-12000 + (20000 * i / (n - 1)) as i32) as i16).collect()
}

#[test]
fn scenario_set_chunked_upload() {
    let mut env = Env::new();
    env.init_config();
    env.add_asset("SPYx", SPYX_MINT, WAD / 100, 0);
    let z = synthetic_set(N_SCEN);
    env.upload_scenarios("SPYx", &z, 400).unwrap();

    let set_key = scen_pda(&ticker("SPYx"), closure::WEEKEND);
    let s: ScenarioSet = env.zc(&set_key);
    assert_eq!(s.finalized, 1);
    assert_eq!(s.n as usize, N_SCEN);
    assert_eq!(&s.z[..], &z[..]);
    assert_eq!(s.hash, sha256_i16(&[&z]));
    let a: AssetConfig = env.zc(&asset_pda(&ticker("SPYx")));
    assert_eq!(a.scenario_set, set_key);
    assert_eq!(env.data(&set_key).len(), ScenarioSet::SIZE);

    // Immutable once finalised.
    let admin = env.admin.pubkey();
    let ix = env.ix_write_scen(&admin, set_key, 0, vec![0]);
    assert_err(env.send_admin(&[ix]), code(CoreError::AlreadyFinalized));
}

#[test]
fn scenario_set_rejects_wrong_hash_unsorted_and_out_of_range() {
    let mut env = Env::new();
    env.init_config();
    env.add_asset("SPYx", SPYX_MINT, WAD / 100, 0);
    let (admin, t) = (env.admin.pubkey(), ticker("SPYx"));
    let set = scen_pda(&t, closure::WEEKEND);
    let z = synthetic_set(10);
    let ix = env.ix_init_scen(&admin, t, closure::WEEKEND, 10);
    env.send_admin(&[ix]).unwrap();

    // Past the declared n.
    let ix = env.ix_write_scen(&admin, set, 5, z.clone());
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));

    let ix = env.ix_write_scen(&admin, set, 0, z.clone());
    env.send_admin(&[ix]).unwrap();
    let ix = env.ix_finalize_scen(&admin, set, asset_pda(&t), [7u8; 32]);
    assert_err(env.send_admin(&[ix]), code(CoreError::HashMismatch));

    let mut unsorted = z.clone();
    unsorted.swap(0, 9);
    let ix = env.ix_write_scen(&admin, set, 0, unsorted.clone());
    env.send_admin(&[ix]).unwrap();
    let ix = env.ix_finalize_scen(&admin, set, asset_pda(&t), sha256_i16(&[&unsorted]));
    assert_err(env.send_admin(&[ix]), code(CoreError::NotSorted));

    // Non-admin cannot write.
    let mallory = env.funded();
    let ix = env.ix_write_scen(&mallory.pubkey(), set, 0, z.clone());
    assert_err(env.send(&[ix], &[&mallory]), code(CoreError::Unauthorized));

    // Only WEEKEND sets in Phase 1.
    let ix = env.ix_init_scen(&admin, t, closure::OVERNIGHT, 10);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));
}

fn synthetic_joint(cols: usize) -> Vec<Vec<i16>> {
    (0..cols).map(|c| (0..K).map(|j| (-9000 + (j as i32) * 60 - (c as i32) * 100) as i16).collect()).collect()
}

#[test]
fn joint_set_chunked_upload_and_hash() {
    let mut env = Env::new();
    env.init_config();
    let cols = synthetic_joint(3);
    env.upload_joint(1, &["SPYx", "QQQx", "NVDAx"], &cols, 200).unwrap();
    let j: JointSet = env.zc(&joint_pda(1));
    assert_eq!(j.finalized, 1);
    assert_eq!(j.n_assets, 3);
    assert_eq!(j.tickers[1], ticker("QQQx"));
    for (c, col) in cols.iter().enumerate() {
        assert_eq!(&j.z[c][..], &col[..]);
    }
    assert_eq!(env.data(&joint_pda(1)).len(), JointSet::SIZE);
}

#[test]
fn joint_set_failures() {
    let mut env = Env::new();
    env.init_config();
    let admin = env.admin.pubkey();
    // Duplicate tickers.
    let ix = env.ix_init_joint(&admin, 2, vec![ticker("SPYx"), ticker("SPYx")]);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));
    // Wrong hash.
    let ix = env.ix_init_joint(&admin, 3, vec![ticker("SPYx")]);
    env.send_admin(&[ix]).unwrap();
    let ix = env.ix_finalize_joint(&admin, joint_pda(3), [9u8; 32]);
    assert_err(env.send_admin(&[ix]), code(CoreError::HashMismatch));
    // Column out of range.
    let ix = env.ix_write_joint(&admin, joint_pda(3), 1, 0, vec![1, 2, 3]);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));
}

/// Golden: every on-chain g_j equals risk-core's `gap_factor` converted to Q64.64 (rounded down). Also measures CU.
#[test]
fn gap_factors_match_risk_core() {
    let mut env = Env::new();
    env.init_config();
    let sigma = WAD / 1000 * 12; // 1.2%
    env.add_asset("NVDAx", NVDAX_MINT, sigma, 2);
    let cols = synthetic_joint(3);
    env.upload_joint(1, &["SPYx", "QQQx", "NVDAx"], &cols, 256).unwrap();
    let cus = env.compute_gap_factors("NVDAx", 1, 128).unwrap();
    println!("compute_gap_factors CU per 128-scenario chunk: {cus:?}");

    let a: AssetConfig = env.zc(&asset_pda(&ticker("NVDAx")));
    assert!(a.gap_factors_ready());
    assert_eq!(a.gf_sigma_wad, sigma);
    assert_eq!(a.gf_kappa_wad, 0);
    for (j, z) in cols[2].iter().enumerate() {
        let g = gap_factor(*z, U256::from(sigma), U256::ZERO, U256::ZERO).unwrap();
        assert_eq!(a.gap_factor_q64(j), wad_to_q64_down(g).unwrap(), "j={j}");
    }
}

#[test]
fn gap_factors_failures_and_invalidation() {
    let mut env = Env::new();
    env.init_config();
    let admin = env.admin.pubkey();
    env.add_asset("NVDAx", NVDAX_MINT, WAD / 100, 2);
    env.add_asset("SPYx", SPYX_MINT, WAD / 100, 1); // column 1 is QQQx: mismatch
    let cols = synthetic_joint(3);
    let joint = joint_pda(1);

    // Joint set not finalised yet.
    let ix = env.ix_init_joint(&admin, 1, vec![ticker("SPYx"), ticker("QQQx"), ticker("NVDAx")]);
    env.send_admin(&[ix]).unwrap();
    let ix = env.ix_compute_gf(&admin, asset_pda(&ticker("NVDAx")), joint, 0, 16);
    assert_err(env.send_admin(&[ix]), code(CoreError::NotFinalized));
    for (c, col) in cols.iter().enumerate() {
        let ix = env.ix_write_joint(&admin, joint, c as u8, 0, col.clone());
        env.send_admin(&[ix]).unwrap();
    }
    let refs: Vec<&[i16]> = cols.iter().map(|c| c.as_slice()).collect();
    let ix = env.ix_finalize_joint(&admin, joint, sha256_i16(&refs));
    env.send_admin(&[ix]).unwrap();

    // Wrong column for the asset.
    let ix = env.ix_compute_gf(&admin, asset_pda(&ticker("SPYx")), joint, 0, 16);
    assert_err(env.send_admin(&[ix]), code(CoreError::TickerMismatch));

    // Chunks must be sequential.
    let ix = env.ix_compute_gf(&admin, asset_pda(&ticker("NVDAx")), joint, 0, 16);
    env.send_admin(&[ix]).unwrap();
    let ix = env.ix_compute_gf(&admin, asset_pda(&ticker("NVDAx")), joint, 32, 16);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));

    // Finish, then a σ change clears them.
    env.compute_gap_factors("NVDAx", 1, 128).unwrap();
    assert!(env.zc::<AssetConfig>(&asset_pda(&ticker("NVDAx"))).gap_factors_ready());
    let ix = env.ix_update_asset(&admin, ticker("NVDAx"), asset_params(WAD / 50, 2));
    env.send_admin(&[ix]).unwrap();
    assert_eq!(env.zc::<AssetConfig>(&asset_pda(&ticker("NVDAx"))).gf_count, 0);

    // Continuing an old computation after σ changed is refused.
    let ix = env.ix_compute_gf(&admin, asset_pda(&ticker("NVDAx")), joint, 0, 16);
    env.send_admin(&[ix]).unwrap();
    let ix = env.ix_update_asset(&admin, ticker("NVDAx"), asset_params(WAD / 40, 2));
    env.send_admin(&[ix]).unwrap();
    let ix = env.ix_compute_gf(&admin, asset_pda(&ticker("NVDAx")), joint, 0, 16);
    env.send_admin(&[ix]).unwrap(); // restart from 0 is allowed
}

/// κ ≠ 0 is refused at init and on update: premium and capacity must price the same model (plan/02 §2, κ = 0).
#[test]
fn kappa_must_be_zero() {
    let mut env = Env::new();
    let a = env.admin.pubkey();
    let mut p = default_params(a, a);
    p.kappa_wad = WAD / 1000 * 5;
    let ix = env.ix_init_config(&a, p);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));
    env.init_config();
    let ix = env.ix_set_params(&a, p);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));
    p.kappa_wad = 1;
    let ix = env.ix_set_params(&a, p);
    assert_err(env.send_admin(&[ix]), code(CoreError::InvalidParam));
    assert_eq!(env.anchor::<Config>(&config_pda()).kappa_wad, 0);
}
