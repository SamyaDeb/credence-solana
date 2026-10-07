//! Task 1.5 golden tests on the real generated data (`data/onchain`, from `scripts/src/gen-onchain.ts`).

mod common;

use common::*;
use credence_core::{math::wad_to_q64_down, state::*};
use credence_risk_core::{gap_factor, quote_cover, PremiumParams, SliceZ, U256};
use serde_json::Value;

fn load(path: &str) -> Value {
    let p = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p}: {e}"))).unwrap()
}
fn zs(v: &Value) -> Vec<i16> {
    v.as_array().unwrap().iter().map(|x| x.as_i64().unwrap() as i16).collect()
}

/// The 1,000-point sets hash as recorded, are sorted, and keep the worst observed scenario.
#[test]
fn onchain_sets_hash_and_keep_worst_point() {
    for t in ["SPYx", "QQQx", "NVDAx"] {
        let f = load(&format!("data/onchain/{t}-WEEKEND.json"));
        let z = zs(&f["z"]);
        assert_eq!(z.len(), N_SCEN);
        assert!(z.windows(2).all(|w| w[0] <= w[1]));
        let hex: String = sha256_i16(&[&z]).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, f["sha256"].as_str().unwrap(), "{t}");
        let src = load(f["source"]["file"].as_str().unwrap());
        let full = zs(&src["z"]);
        assert_eq!(z[0], full[0], "{t}: worst point kept");
    }
}

/// Down-sampling never lowers the premium: min-of-bucket makes every point at least as adverse.
#[test]
fn downsampled_premium_is_conservative() {
    let assets = load("data/onchain/assets.json");
    for a in assets.as_array().unwrap() {
        let t = a["ticker"].as_str().unwrap();
        let f = load(&format!("data/onchain/{t}-WEEKEND.json"));
        let small = zs(&f["z"]);
        let full = zs(&load(f["source"]["file"].as_str().unwrap())["z"]);
        let sigma = U256::from(a["sigmaWad"].as_str().unwrap().parse::<u128>().unwrap());
        // Covered value C' = LT × C (payout rule, plan/02 §2); LTVs from 50% to 95% of LT.
        for (c, d) in [(75_000u64, 40_000u64), (75_000, 60_000), (75_000, 71_000), (55_000, 50_000)] {
            let p = PremiumParams {
                sigma,
                dividend: U256::ZERO,
                kappa: U256::ZERO,
                collateral_value: U256::from(c * 1_000_000),
                debt_projected: U256::from(d * 1_000_000),
                closure_days: 3,
                util_after: U256::from(WAD / 4),
                theta: U256::from(WAD / 5),
                cost_of_cap: U256::from(WAD / 10),
                eta: U256::from(WAD),
                beta: U256::from(WAD / 1000 * 975),
                min_premium: U256::from(1_000_000u64),
            };
            let qs = quote_cover(&SliceZ(&small), &p).unwrap();
            let qf = quote_cover(&SliceZ(&full), &p).unwrap();
            assert!(qs.premium >= qf.premium, "{t} C={c} D={d}: {} < {}", qs.premium, qf.premium);
            assert!(qs.expected_loss >= qf.expected_loss);
            let rel = (qs.premium - qf.premium).to::<u128>() as f64 / qf.premium.to::<u128>() as f64;
            println!("{t} C'={c} D={d}: premium 1000-set {} vs 3000-set {} USDC base (+{:.2}%)", qs.premium, qf.premium, rel * 100.0);
        }
    }
}

/// Real joint set uploaded through the program: hash finalises and every g_j equals risk-core (Q64.64, rounded down).
#[test]
fn real_joint_set_gap_factors_match_risk_core() {
    let joint = load("data/onchain/joint-v1.json");
    let assets = load("data/onchain/assets.json");
    let tickers: Vec<String> = joint["tickers"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
    let cols: Vec<Vec<i16>> = joint["columns"].as_array().unwrap().iter().map(zs).collect();

    let mut env = Env::new();
    env.init_config();
    let mints = [SPYX_MINT, QQQX_MINT, NVDAX_MINT];
    for (i, a) in assets.as_array().unwrap().iter().enumerate() {
        let sigma = a["sigmaWad"].as_str().unwrap().parse::<u64>().unwrap();
        env.add_asset(a["ticker"].as_str().unwrap(), mints[i], sigma, a["jointColumn"].as_u64().unwrap() as u8);
    }
    let trefs: Vec<&str> = tickers.iter().map(|s| s.as_str()).collect();
    env.upload_joint(1, &trefs, &cols, 256).unwrap();
    let j: JointSet = env.zc(&joint_pda(1));
    let hex: String = j.hash.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, joint["sha256"].as_str().unwrap());

    let kappa = U256::from(default_params(Default::default(), Default::default()).kappa_wad);
    for (i, a) in assets.as_array().unwrap().iter().enumerate() {
        let t = a["ticker"].as_str().unwrap();
        env.compute_gap_factors(t, 1, 128).unwrap();
        let st: AssetConfig = env.zc(&asset_pda(&ticker(t)));
        let sigma = U256::from(st.sigma_wad);
        for (jx, z) in cols[i].iter().enumerate() {
            let g = gap_factor(*z, sigma, U256::ZERO, kappa).unwrap();
            assert_eq!(st.gap_factor_q64(jx), wad_to_q64_down(g).unwrap(), "{t} j={jx}");
        }
    }
}
