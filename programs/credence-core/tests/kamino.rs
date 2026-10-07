//! klend layouts (pinned to commit `a087609`): the real obligation `47wNsqpy…` and the xStocks Market reserves, fetched
//! from mainnet by `scripts/src/fetch-kamino-fixtures.ts`, decode to the same values as klend-sdk.

use anchor_lang::prelude::Pubkey;
use credence_core::kamino::{layout, ObligationView, ReserveView, OBLIGATION_DISC};
use serde_json::Value;
use std::str::FromStr;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/fixtures/{name}.bin", env!("CARGO_MANIFEST_DIR"))).unwrap()
}
fn golden() -> Value {
    let p = format!("{}/tests/fixtures/kamino_golden.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}
fn pk(v: &Value) -> Pubkey {
    Pubkey::from_str(v.as_str().unwrap()).unwrap()
}
fn u128s(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

#[test]
fn obligation_decodes_like_klend_sdk() {
    let g = &golden()["obligation_47wN"];
    let d = fixture("obligation_47wN");
    assert_eq!(d.len(), layout::OBLIGATION_LEN);
    let o = ObligationView::decode(&d).unwrap();
    assert_eq!(o.last_update_slot.to_string(), g["lastUpdateSlot"].as_str().unwrap());
    assert_eq!(o.stale as u64, g["lastUpdateStale"].as_u64().unwrap());
    assert_eq!(o.price_status as u64, g["priceStatus"].as_u64().unwrap());
    assert_eq!(o.lending_market, pk(&g["lendingMarket"]));
    assert_eq!(o.owner, pk(&g["owner"]));
    assert_eq!(o.elevation_group as u64, g["elevationGroup"].as_u64().unwrap());
    assert_eq!(o.deposited_value_sf, u128s(&g["depositedValueSf"]));
    assert_eq!(o.bf_adjusted_debt_value_sf, u128s(&g["borrowFactorAdjustedDebtValueSf"]));
    assert_eq!(o.borrowed_assets_market_value_sf, u128s(&g["borrowedAssetsMarketValueSf"]));
    assert_eq!(o.unhealthy_borrow_value_sf, u128s(&g["unhealthyBorrowValueSf"]));
    let deps = g["deposits"].as_array().unwrap();
    assert_eq!(o.deposits.len(), deps.len());
    for (a, b) in o.deposits.iter().zip(deps) {
        assert_eq!(a.0, pk(&b["reserve"]));
        assert_eq!(a.1, u128s(&b["marketValueSf"]));
    }
    let bors = g["borrows"].as_array().unwrap();
    assert_eq!(o.borrows.len(), bors.len());
    for (a, b) in o.borrows.iter().zip(bors) {
        assert_eq!(a.0, pk(&b["reserve"]));
        assert_eq!(a.1, u128s(&b["borrowedAmountSf"]));
        assert_eq!(a.2, u128s(&b["marketValueSf"]));
    }
}

#[test]
fn reserves_decode_like_klend_sdk() {
    let g = golden();
    for name in ["reserve_SPYx", "reserve_QQQx", "reserve_NVDAx", "reserve_USDC"] {
        let r = ReserveView::decode(&fixture(name)).unwrap();
        let e = &g[name];
        assert_eq!(r.lending_market, pk(&e["lendingMarket"]), "{name}");
        assert_eq!(r.liquidity_mint, pk(&e["mint"]), "{name}");
        assert_eq!(r.supply_vault, pk(&e["supplyVault"]), "{name}");
        assert_eq!(r.token_program, pk(&e["tokenProgram"]), "{name}");
        assert_eq!(r.status as u64, e["status"].as_u64().unwrap(), "{name}");
        assert_eq!(r.liquidation_threshold_pct as u64, e["liquidationThresholdPct"].as_u64().unwrap(), "{name}");
        assert_eq!(r.borrow_factor_pct.to_string(), e["borrowFactorPct"].as_str().unwrap(), "{name}");
    }
}

#[test]
fn decode_rejects_wrong_discriminator_and_length() {
    let mut d = fixture("obligation_47wN");
    assert!(ObligationView::decode(&d[..d.len() - 1]).is_err());
    d[0] ^= 1;
    assert!(ObligationView::decode(&d).is_err());
    // A reserve is not an obligation, and vice versa.
    assert!(ObligationView::decode(&fixture("reserve_USDC")).is_err());
    let mut ob = fixture("obligation_47wN");
    assert!(ReserveView::decode(&ob).is_err());
    ob[..8].copy_from_slice(&OBLIGATION_DISC);
    assert!(ObligationView::decode(&ob).is_ok());
}
