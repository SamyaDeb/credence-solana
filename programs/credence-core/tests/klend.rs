//! Real klend in LiteSVM (snapshot of mainnet, see `common::kl`): the refreshes and a direct repay v2 work, so
//! `settle_policy`'s repay CPI can be tested here and not only on the fork.

mod common;

use common::*;
use solana_signer::Signer;

#[test]
fn refresh_and_repay_with_real_klend() {
    let mut env = Env::new();
    let payer = env.funded();
    env.load_klend(&payer.pubkey());
    let src = env.usdc_account(&payer.pubkey(), 1_000_000_000_000);
    let before = kl::debt_sf(&env);
    let mut ixs = kl::refreshes();
    let m = env.send(&ixs, &[&payer]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("3 refreshes: {} CU", m.compute_units_consumed);
    let refreshed = kl::debt_sf(&env);
    assert!(refreshed >= before, "interest accrues");
    ixs.push(kl::repay_v2(payer.pubkey(), src, 10_000_000_000));
    env.svm.warp_to_slot(env.slot() + 1);
    let m = env.send(&ixs, &[&payer]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("refreshes + repay 10,000 USDC: {} CU", m.compute_units_consumed);
    let after = kl::debt_sf(&env);
    let repaid = (refreshed - after) >> 60;
    assert!((9_999_999_000..=10_000_001_000).contains(&repaid), "repaid {repaid}");
    assert_eq!(env.token_balance(&src), 1_000_000_000_000 - 10_000_000_000);
}
