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

// ---------------------------------------------------------------------------------------------------------------
// Cover snapshot rules
// ---------------------------------------------------------------------------------------------------------------

use credence_core::kamino::{cover_snapshot, CoverAccounts, CoverSnapshot};

const SPYX_MINT: &str = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

fn reserve(name: &str) -> (Pubkey, ReserveView) {
    (pk(&golden()[name]["address"]), ReserveView::decode(&fixture(name)).unwrap())
}

/// Snapshot of `d` as SPYx cover in the xStocks Market (reserves from the fixtures).
fn snap(d: &[u8], signer: &Pubkey, slot: u64) -> anchor_lang::Result<CoverSnapshot> {
    let ob = ObligationView::decode(d).unwrap();
    let (dk, dr) = reserve("reserve_SPYx");
    let (bk, br) = reserve("reserve_USDC");
    let a = CoverAccounts {
        deposit_reserve_key: dk,
        deposit_reserve: &dr,
        borrow_reserve_key: bk,
        borrow_reserve: &br,
        asset_mint: Pubkey::from_str(SPYX_MINT).unwrap(),
        asset_reserves: [dk, Pubkey::default()],
        usdc_mint: Pubkey::from_str(USDC_MINT).unwrap(),
    };
    cover_snapshot(&ob, signer, slot, &a)
}

/// The real obligation as `refresh_obligation` would leave it in `slot`: not stale, all price checks.
fn refreshed(slot: u64) -> Vec<u8> {
    let mut d = fixture("obligation_47wN");
    d[layout::OB_LAST_UPDATE_SLOT..layout::OB_LAST_UPDATE_SLOT + 8].copy_from_slice(&slot.to_le_bytes());
    d[layout::OB_LAST_UPDATE_STALE] = 0;
    d[layout::OB_LAST_UPDATE_PRICE_STATUS] = 0b0011_1111;
    d
}
fn owner() -> Pubkey {
    pk(&golden()["obligation_47wN"]["owner"])
}
fn err_name(r: anchor_lang::Result<impl std::fmt::Debug>) -> String {
    format!("{:?}", r.unwrap_err())
}

#[test]
fn snapshot_of_real_obligation() {
    let s = snap(&refreshed(500), &owner(), 500).unwrap();
    // plan/09: SPYx $552,925 collateral, $313,136 debt at USDC ≈ 1, LT 75% → D/C′ ≈ 0.755.
    assert_eq!(s.collateral_value, 552_925_318_032);
    assert_eq!(s.debt, 312_976_955_699);
    assert_eq!(s.liquidation_threshold_wad, 750_000_000_000_000_000);
    // C′ in USDC: 414,693.99 USD at the debt's USDC price (313,135.53 USD / 312,976.96 USDC).
    let expect = 414_693.988_524_742_1 * 312_976.955_698_992_2 / 313_135.527_850_160_8 * 1e6;
    assert!((s.covered_value as f64 - expect).abs() < 2.0, "{} vs {expect}", s.covered_value);
    let ratio = s.debt as f64 / s.covered_value as f64;
    assert!((ratio - 0.7551).abs() < 1e-3, "D/C′ = {ratio}");
}

#[test]
fn snapshot_requires_refresh_in_this_slot() {
    assert!(err_name(snap(&refreshed(500), &owner(), 501)).contains("ObligationNotRefreshed"));
    let mut d = refreshed(500);
    d[layout::OB_LAST_UPDATE_STALE] = 1;
    assert!(err_name(snap(&d, &owner(), 500)).contains("ObligationNotRefreshed"));
    let mut d = refreshed(500);
    d[layout::OB_LAST_UPDATE_PRICE_STATUS] = 0b0001_1111; // price usage not allowed
    assert!(err_name(snap(&d, &owner(), 500)).contains("ObligationNotRefreshed"));
}

#[test]
fn snapshot_requires_xstocks_market() {
    let mut d = refreshed(500);
    d[layout::OB_LENDING_MARKET..layout::OB_LENDING_MARKET + 32].copy_from_slice(&[7u8; 32]);
    assert!(err_name(snap(&d, &owner(), 500)).contains("MarketNotAllowed"));
}

/// Review fix 3: only the obligation's owner may buy cover on it.
#[test]
fn snapshot_rejects_non_owner() {
    let stranger = Pubkey::new_unique();
    assert!(err_name(snap(&refreshed(500), &stranger, 500)).contains("NotObligationOwner"));
}

fn put(d: &mut [u8], o: usize, b: &[u8]) {
    d[o..o + b.len()].copy_from_slice(b);
}

/// Review fix 4: one xStock deposit (the asset's own reserve) and one USDC borrow, nothing else.
#[test]
fn snapshot_rejects_multi_collateral_and_non_usdc_debt() {
    use layout::*;
    let unsupported = |d: &[u8]| assert!(err_name(snap(d, &owner(), 500)).contains("UnsupportedObligation"));
    let (qqqx_key, _) = reserve("reserve_QQQx");
    let (usdc_key, _) = reserve("reserve_USDC");

    // A second deposit (QQQx) next to SPYx.
    let mut d = refreshed(500);
    put(&mut d, OB_DEPOSITS + DEPOSIT_LEN + DEP_RESERVE, qqqx_key.as_ref());
    put(&mut d, OB_DEPOSITS + DEPOSIT_LEN + DEP_MARKET_VALUE_SF, &(1u128 << 70).to_le_bytes());
    unsupported(&d);

    // The only deposit is another xStock's reserve.
    let mut d = refreshed(500);
    put(&mut d, OB_DEPOSITS + DEP_RESERVE, qqqx_key.as_ref());
    unsupported(&d);

    // A second borrow.
    let mut d = refreshed(500);
    put(&mut d, OB_BORROWS + BORROW_LEN + BOR_RESERVE, usdc_key.as_ref());
    unsupported(&d);

    // The borrow is not in the USDC reserve passed (e.g. a PYUSD or xStock borrow).
    let mut d = refreshed(500);
    put(&mut d, OB_BORROWS + BOR_RESERVE, qqqx_key.as_ref());
    unsupported(&d);

    // Borrow-factor-adjusted debt differs from the market value (borrow factor > 100%).
    let mut d = refreshed(500);
    let bf = u128::from_le_bytes(d[OB_BF_ADJUSTED_DEBT_VALUE_SF..OB_BF_ADJUSTED_DEBT_VALUE_SF + 16].try_into().unwrap());
    put(&mut d, OB_BF_ADJUSTED_DEBT_VALUE_SF, &(bf + 1).to_le_bytes());
    unsupported(&d);

    // No deposit at all.
    let mut d = refreshed(500);
    put(&mut d, OB_DEPOSITS + DEP_RESERVE, &[0u8; 32]);
    unsupported(&d);
}

/// The SPYx reserve passed for a USDC borrow (wrong mint) or a reserve from another market is refused too.
#[test]
fn snapshot_checks_reserve_accounts() {
    let ob = ObligationView::decode(&refreshed(500)).unwrap();
    let (dk, dr) = reserve("reserve_SPYx");
    let (bk, br) = reserve("reserve_USDC");
    let base = |dr: &ReserveView, br: &ReserveView, bk: Pubkey, mint: &str| {
        let a = CoverAccounts {
            deposit_reserve_key: dk,
            deposit_reserve: dr,
            borrow_reserve_key: bk,
            borrow_reserve: br,
            asset_mint: Pubkey::from_str(mint).unwrap(),
            asset_reserves: [dk, Pubkey::default()],
            usdc_mint: Pubkey::from_str(USDC_MINT).unwrap(),
        };
        cover_snapshot(&ob, &owner(), 500, &a).map(|_| ())
    };
    assert!(base(&dr, &br, bk, SPYX_MINT).is_ok());
    // Asset is NVDAx but the deposit reserve is SPYx's.
    assert!(err_name(base(&dr, &br, bk, "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh")).contains("UnsupportedObligation"));
    // Borrow reserve from another market.
    let mut other = br.clone();
    other.lending_market = Pubkey::new_unique();
    assert!(err_name(base(&dr, &other, bk, SPYX_MINT)).contains("UnsupportedObligation"));
    // Borrow reserve with a borrow factor above 100%.
    let mut bf = br.clone();
    bf.borrow_factor_pct = 125;
    assert!(err_name(base(&dr, &bf, bk, SPYX_MINT)).contains("UnsupportedObligation"));
    // LT cross-check: a reserve claiming LT 80% while klend computed 75%.
    let mut lt = dr.clone();
    lt.liquidation_threshold_pct = 80;
    assert!(err_name(base(&lt, &br, bk, SPYX_MINT)).contains("KaminoLayout"));
}
