//! Live checkpoints on real Pyth data (task 2.6 Friday close; 5.2 Monday settlement). Not part of the default suite:
//!
//!   cargo test -p credence-core --test live -- --ignored live_close --nocapture
//!
//! Runs the real program in LiteSVM with mainnet state (calendar, assets, sets, Oct 9 epochs opened before the bell)
//! and injects the **genuine** `Crypto.<T>X/USD` `PriceUpdateV2` accounts recorded from mainnet by
//! `scripts/src/record-prices.ts` (owner = Pyth pro receiver, Wormhole-verified on mainnet, bytes unchanged).
//! Settlement source: `XSTOCK` (the Hermes key has no SPY/NVDA equity entitlement): the close is the push
//! account's update in `[close − xstock_settle_window_secs, close]`, 1 h here, because the push accounts update about
//! every 14.5 min in session (the last one 4–14 min before 16:00 ET). Result: `data/live/close-<group>.json`.
//!
//! `LIVE_DRY_RUN=1` re-stamps the newest recorded update into the window to test the pipeline before the close; the
//! output is then `data/live/close-<group>-DRYRUN.json` and must never be used as the real close.

mod common;

use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction, InstructionData, ToAccountMetas};
use common::*;
use credence_core::{accounts as acc, instruction as ix, oracle, state::*};
use solana_account::Account;
use solana_signer::Signer;

const LIVE_CLOSE_WINDOW: u32 = 3600;

struct Recorded {
    file: String,
    pubkey: Pubkey,
    account: Account,
    publish_time: i64,
    price: f64,
}

fn recorded(sym: &str) -> Vec<Recorded> {
    let dir = format!("{}/../../data/live/pyth", env!("CARGO_MANIFEST_DIR"));
    let mut out = vec![];
    for e in std::fs::read_dir(&dir).unwrap_or_else(|_| panic!("{dir} missing: run scripts/src/record-prices.ts")) {
        let path = e.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.starts_with(&format!("{sym}-")) {
            continue;
        }
        let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD.decode(j["account"]["data"][0].as_str().unwrap()).unwrap();
        let u: pyth_solana_receiver_sdk::price_update::PriceUpdateV2 =
            anchor_lang::AccountDeserialize::try_deserialize(&mut data.as_slice()).unwrap();
        out.push(Recorded {
            file: name,
            pubkey: j["pubkey"].as_str().unwrap().parse().unwrap(),
            account: Account {
                lamports: j["account"]["lamports"].as_u64().unwrap(),
                data,
                owner: j["account"]["owner"].as_str().unwrap().parse().unwrap(),
                executable: false,
                rent_epoch: 0,
            },
            publish_time: u.price_message.publish_time,
            price: u.price_message.price as f64 * 10f64.powi(u.price_message.exponent),
        });
    }
    out.sort_by_key(|r| r.publish_time);
    out
}

/// Sets the publish time inside a recorded account (dry run only).
fn restamp(acct: &mut Account, t: i64) {
    let o = if acct.data[40] == 1 { 41 } else { 42 } + 52;
    acct.data[o..o + 8].copy_from_slice(&t.to_le_bytes());
}

#[test]
#[ignore]
fn live_close() {
    let dry = std::env::var("LIVE_DRY_RUN").is_ok();
    let mut env = Env::real(0);
    let admin = env.admin.pubkey();
    let mut p = default_params(admin, admin);
    p.xstock_settle_window_secs = LIVE_CLOSE_WINDOW;
    let ix0 = env.ix_set_params(&admin, p);
    env.send_admin(&[ix0]).unwrap();
    let mut results = vec![];
    for (i, sym) in REAL_TICKERS.iter().enumerate() {
        let mut ap = real_asset_params(i);
        ap.settle_source = oracle::source::XSTOCK;
        let ix1 = env.ix_update_asset(&admin, ticker(sym), ap);
        env.send_admin(&[ix1]).unwrap();
        let tk = ticker(sym);
        let e: Epoch = env.anchor(&epoch_pda(&tk, GROUP_OCT9));
        let from = e.close - LIVE_CLOSE_WINDOW as i64;
        let recs = recorded(sym);
        let pick = if dry {
            recs.last().map(|r| {
                let mut a = r.account.clone();
                restamp(&mut a, e.close - 30);
                (r, a)
            })
        } else {
            recs.iter().rev().find(|r| r.publish_time >= from && r.publish_time <= e.close).map(|r| (r, r.account.clone()))
        };
        let Some((rec, account)) = pick else {
            println!("{sym}: NO recorded update in [{from}, {}] — epoch stays OPEN (recorded: {})", e.close, recs.len());
            results.push(serde_json::json!({ "ticker": sym, "stored": false, "reason": "no push update in window" }));
            continue;
        };
        env.svm.set_account(rec.pubkey, account).unwrap();
        env.set_time(e.close + 60);
        let snap = Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SnapshotClose { ticker: tk, closure_id: GROUP_OCT9 }.data(),
            acc::SnapshotClose {
                caller: admin,
                config: config_pda(),
                asset: asset_pda(&tk),
                epoch: epoch_pda(&tk, GROUP_OCT9),
                mint: REAL_MINTS[i],
                price: rec.pubkey,
                xcheck: None,
            }
            .to_account_metas(None),
        );
        let m = env.send_admin(&[snap]).unwrap_or_else(|e| panic!("{sym}: {:?}\n{:#?}", e.err, e.meta.logs));
        let e: Epoch = env.anchor(&epoch_pda(&tk, GROUP_OCT9));
        assert_eq!(e.state, epoch_state::CLOSED);
        println!(
            "{sym}: close stored {:.6} USD/token (update {} published {}s before the 16:00 ET close, {} CU)",
            e.close_price_wad as f64 / 1e18,
            rec.file,
            e.close - rec.publish_time,
            m.compute_units_consumed
        );
        results.push(serde_json::json!({
            "ticker": sym, "stored": true, "source": "Crypto.<T>X/USD pro push account (mainnet, Full)",
            "closePriceWad": e.close_price_wad.to_string(), "closePrice": rec.price,
            "update": rec.file, "publishTime": rec.publish_time, "closeTime": e.close,
            "secondsBeforeClose": e.close - rec.publish_time, "multiplierWad": e.close_multiplier_wad.to_string(),
        }));
    }
    let name = if dry { format!("close-{GROUP_OCT9}-DRYRUN.json") } else { format!("close-{GROUP_OCT9}.json") };
    let path = format!("{}/../../data/live/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::write(&path, serde_json::to_string_pretty(&serde_json::json!({
        "group": GROUP_OCT9, "dryRun": dry, "closeWindowSecs": LIVE_CLOSE_WINDOW, "results": results,
        "note": "LiteSVM with the real credence_core program and mainnet state; genuine recorded Pyth push accounts",
    })).unwrap()).unwrap();
    println!("wrote {path}");
}

/// SCOPE checkpoint: stores the real Friday close from Kamino's own Scope price (the raw mainnet `OraclePrices`
/// account captured by `scripts/src/capture-scope.ts` into `data/live/scope/`), for every asset in one pass.
///
///   cargo test -p credence-core --test live -- --ignored live_close_scope --nocapture
///
/// Uses the latest capture refreshed in `[close − 60 s, close + 15 min]` (the program's SCOPE window). With
/// `LIVE_DRY_RUN=1` the newest capture is restamped into the window (output `close-scope-<group>-DRYRUN.json`).
#[test]
#[ignore]
fn live_close_scope() {
    use credence_core::oracle::scope;
    let dry = std::env::var("LIVE_DRY_RUN").is_ok();
    let mut env = Env::real(0);
    let admin = env.admin.pubkey();
    let close = env.anchor::<Epoch>(&epoch_pda(&ticker("SPYx"), GROUP_OCT9)).close;
    let dir = format!("{}/../../data/live/scope", env!("CARGO_MANIFEST_DIR"));
    let mut caps: Vec<(i64, String, Account)> = vec![];
    for e in std::fs::read_dir(&dir).unwrap_or_else(|_| panic!("{dir} missing: run scripts/src/capture-scope.ts")) {
        let path = e.unwrap().path();
        let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD.decode(j["account"]["data"][0].as_str().unwrap()).unwrap();
        let ts = scope::decode(&data, 344).unwrap().unix_timestamp;
        let acc = Account {
            lamports: j["account"]["lamports"].as_u64().unwrap(),
            data,
            owner: j["account"]["owner"].as_str().unwrap().parse().unwrap(),
            executable: false,
            rent_epoch: 0,
        };
        caps.push((ts, path.file_name().unwrap().to_string_lossy().to_string(), acc));
    }
    caps.sort_by_key(|c| c.0);
    let pick = if dry {
        caps.last().cloned().map(|(_, f, mut a)| {
            for ch in [344usize, 347, 332] {
                let o = scope::PRICES_OFFSET + ch * scope::ENTRY_LEN + 24;
                a.data[o..o + 8].copy_from_slice(&((close + 20) as u64).to_le_bytes());
            }
            (close + 20, f, a)
        })
    } else {
        caps.iter().rev().find(|c| c.0 >= close - 60 && c.0 <= close + 900).cloned()
    };
    let mut results = vec![];
    match pick {
        None => {
            println!("NO Scope capture refreshed in [{}, {}] ({} captures)", close - 60, close + 900, caps.len());
            results.push(serde_json::json!({ "stored": false, "reason": "no Scope capture in window" }));
        }
        Some((ts, file, acc)) => {
            env.svm.set_account(scope::SCOPE_PRICES, acc).unwrap();
            env.set_time(ts.max(close) + 30);
            for (i, sym) in REAL_TICKERS.iter().enumerate() {
                let mut ap = real_asset_params(i);
                ap.settle_source = oracle::source::SCOPE;
                let ix = env.ix_update_asset(&admin, ticker(sym), ap);
                env.send_admin(&[ix]).unwrap();
                let ix = env.ix_snapshot(&admin, sym, GROUP_OCT9, scope::SCOPE_PRICES, None);
                let m = env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{sym}: {:?}\n{:#?}", e.err, e.meta.logs));
                let e: Epoch = env.anchor(&epoch_pda(&ticker(sym), GROUP_OCT9));
                assert_eq!(e.state, epoch_state::CLOSED);
                println!("{sym}: Kamino Scope close {:.6} USD/token (capture {file}, refreshed {}s after the bell, {} CU)",
                    e.close_price_wad as f64 / 1e18, ts - close, m.compute_units_consumed);
                results.push(serde_json::json!({
                    "ticker": sym, "stored": true, "source": "Kamino Scope OraclePrices (Chainlink Data Streams + Pyth Lazer), raw mainnet account",
                    "closePriceWad": e.close_price_wad.to_string(), "capture": file, "scopeRefreshedAt": ts, "closeTime": close,
                }));
            }
        }
    }
    let name = if dry { format!("close-scope-{GROUP_OCT9}-DRYRUN.json") } else { format!("close-scope-{GROUP_OCT9}.json") };
    let path = format!("{}/../../data/live/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::write(&path, serde_json::to_string_pretty(&serde_json::json!({ "group": GROUP_OCT9, "dryRun": dry, "results": results })).unwrap()).unwrap();
    println!("wrote {path}");
}
