//! Task 1.5 golden tests on the real generated data (`data/onchain`, from `scripts/src/gen-onchain.ts`).

mod common;

use common::*;
use credence_core::{math::wad_to_q64_down, state::*};
use credence_risk_core::{gap_factor, U256};
use serde_json::Value;

fn load(path: &str) -> Value {
    let p = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p}: {e}"))).unwrap()
}
fn zs(v: &Value) -> Vec<i16> {
    v.as_array().unwrap().iter().map(|x| x.as_i64().unwrap() as i16).collect()
}

/// The on-chain sets are the full calibrated sets: same values as the source file, sorted, hash as recorded.
#[test]
fn onchain_sets_equal_calibrated_sets() {
    for t in ["SPYx", "QQQx", "NVDAx", "TSLAx", "GOOGLx", "AAPLx", "MSTRx", "HOODx"] {
        let f = load(&format!("data/onchain/{t}-WEEKEND.json"));
        let z = zs(&f["z"]);
        assert_eq!(z.len(), N_SCEN);
        assert!(z.windows(2).all(|w| w[0] <= w[1]));
        let hex: String = sha256_i16(&[&z]).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, f["sha256"].as_str().unwrap(), "{t}");
        let src = load(f["source"]["file"].as_str().unwrap());
        assert_eq!(z, zs(&src["z"]), "{t}");
    }
}

/// Real joint set uploaded through the program: hash finalises and every g_j equals risk-core (Q64.64, rounded down).
#[test]
fn real_joint_set_gap_factors_match_risk_core() {
    let joint = load("data/onchain/joint-v2.json");
    let assets = load("data/onchain/assets.json");
    let tickers: Vec<String> = joint["tickers"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
    let cols: Vec<Vec<i16>> = joint["columns"].as_array().unwrap().iter().map(zs).collect();

    let mut env = Env::new();
    env.init_config();
    for a in assets.as_array().unwrap() {
        let sigma = a["sigmaWad"].as_str().unwrap().parse::<u64>().unwrap();
        let mint: anchor_lang::prelude::Pubkey = a["mint"].as_str().unwrap().parse().unwrap();
        env.add_asset(a["ticker"].as_str().unwrap(), mint, sigma, a["jointColumn"].as_u64().unwrap() as u8);
    }
    let trefs: Vec<&str> = tickers.iter().map(|s| s.as_str()).collect();
    env.upload_joint(2, &trefs, &cols, 256).unwrap();
    let j: JointSet = env.zc(&joint_pda(2));
    let hex: String = j.hash.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, joint["sha256"].as_str().unwrap());

    let kappa = U256::from(default_params(Default::default(), Default::default()).kappa_wad);
    for (i, a) in assets.as_array().unwrap().iter().enumerate() {
        let t = a["ticker"].as_str().unwrap();
        env.compute_gap_factors(t, 2, 128).unwrap();
        let st: AssetConfig = env.zc(&asset_pda(&ticker(t)));
        let sigma = U256::from(st.sigma_wad);
        for (jx, z) in cols[i].iter().enumerate() {
            let g = gap_factor(*z, sigma, U256::ZERO, kappa).unwrap();
            assert_eq!(st.gap_factor_q64(jx), wad_to_q64_down(g).unwrap(), "{t} j={jx}");
        }
    }
}
