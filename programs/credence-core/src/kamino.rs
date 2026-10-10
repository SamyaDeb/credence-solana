//! Kamino Lend (`klend`) integration: program ids, market allow-list, pinned `Obligation` / `Reserve` layouts, the
//! cover snapshot read from a refreshed obligation, and the v2 repay CPI.
//!
//! `repay_obligation_liquidity_v2` (settlement, shield) and `liquidate_obligation_and_redeem_reserve_collateral_v2`
//! (W2 backstop) are called from this program. The v1 instruction rejects cross-program calls
//! (`check_refresh_ixs`); v2 does not (klend source, commit `a087609`; fork test in task 1.3). The caller's
//! transaction must contain `refresh_reserve` (each reserve of the obligation) and `refresh_obligation` before this
//! instruction, and must never contain Jupiter's `jupr81Y…` program (klend `RESTRICTED_PROGRAMS`).

use anchor_lang::prelude::*;
use credence_risk_core::U256;

use crate::math::WAD;
use crate::CoreError;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

/// klend program (mainnet and devnet).
pub const KLEND_PROGRAM_ID: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
/// Kamino farms program (repay v2 refreshes the obligation's debt farm through it).
pub const FARMS_PROGRAM_ID: Pubkey = pubkey!("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
/// The two xStocks lending markets whose obligations may be covered.
pub const XSTOCKS_MARKETS: [Pubkey; 2] = [
    pubkey!("5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua"), // xStocks Market
    pubkey!("8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr"), // Sentora xStocks Market
];
/// The weekend-safe lending market (D1): a klend market created for Credence and permissioned for BORROW to the
/// program's `["wsm_auth"]` PDA. Fork-only address (no secret key exists for it: fork tooling writes the account);
/// a live deployment sets its own address here and rebuilds, as for the xStocks markets above.
pub const WSM_MARKET: Pubkey = pubkey!("45PeTGq9mJF9W6zzzSrgNgZjx8stoiYALubvDNTjsHfL");
/// Markets whose obligations the Shield and settlement may repay into: the xStocks markets and the weekend-safe market.
pub fn repay_market_allowed(market: &Pubkey) -> bool {
    XSTOCKS_MARKETS.contains(market) || *market == WSM_MARKET
}
/// Never allowed in a transaction that touches klend.
pub const JUPITER_RESTRICTED_PROGRAM_ID: Pubkey = pubkey!("jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi");

/// `sha256("global:repay_obligation_liquidity_v2")[..8]` (matches `@kamino-finance/klend-sdk`).
pub const REPAY_OBLIGATION_LIQUIDITY_V2_DISC: [u8; 8] = [116, 174, 213, 76, 180, 53, 210, 144];
/// `sha256("global:liquidate_obligation_and_redeem_reserve_collateral_v2")[..8]` (matches klend-sdk).
pub const LIQUIDATE_V2_DISC: [u8; 8] = [162, 161, 35, 143, 30, 187, 185, 103];
/// `sha256("account:Obligation")[..8]`.
pub const OBLIGATION_DISC: [u8; 8] = [168, 206, 141, 106, 88, 76, 172, 167];
/// `sha256("account:Reserve")[..8]`.
pub const RESERVE_DISC: [u8; 8] = [43, 242, 204, 202, 26, 247, 59, 127];

/// klend `PriceStatusFlags::ALL_CHECKS`: price loaded, age, TWAP, TWAP age, heuristic, usage allowed.
pub const PRICE_STATUS_ALL_CHECKS: u8 = 0b0011_1111;
/// klend `Fraction` (U68F60) fractional bits: the `_sf` fields are value × 2^60.
pub const SF_SHIFT: u32 = 60;

/// Byte offsets into klend accounts, **including** the 8-byte discriminator. Pinned to klend commit `a087609`
/// (release 1.25.0); `scripts/src/klend-layout.ts` prints them from klend-sdk's layouts, and `tests/kamino.rs` decodes
/// the real obligation `47wNsqpy…` and its reserves and compares every field with klend-sdk's decode.
pub mod layout {
    pub const OBLIGATION_LEN: usize = 3344;
    pub const OB_LAST_UPDATE_SLOT: usize = 16;
    pub const OB_LAST_UPDATE_STALE: usize = 24;
    pub const OB_LAST_UPDATE_PRICE_STATUS: usize = 25;
    pub const OB_LENDING_MARKET: usize = 32;
    pub const OB_OWNER: usize = 64;
    /// `deposits: [ObligationCollateral; 8]`, 136 bytes each.
    pub const OB_DEPOSITS: usize = 96;
    pub const OB_DEPOSITS_N: usize = 8;
    pub const DEPOSIT_LEN: usize = 136;
    pub const DEP_RESERVE: usize = 0;
    pub const DEP_MARKET_VALUE_SF: usize = 40;
    pub const OB_DEPOSITED_VALUE_SF: usize = 1192;
    /// `borrows: [ObligationLiquidity; 5]`, 200 bytes each.
    pub const OB_BORROWS: usize = 1208;
    pub const OB_BORROWS_N: usize = 5;
    pub const BORROW_LEN: usize = 200;
    pub const BOR_RESERVE: usize = 0;
    pub const BOR_BORROWED_AMOUNT_SF: usize = 88;
    pub const BOR_MARKET_VALUE_SF: usize = 104;
    pub const DEP_DEPOSITED_AMOUNT: usize = 32;
    pub const OB_BF_ADJUSTED_DEBT_VALUE_SF: usize = 2208;
    pub const OB_ALLOWED_BORROW_VALUE_SF: usize = 2240;
    pub const OB_BORROWED_ASSETS_MARKET_VALUE_SF: usize = 2224;
    pub const OB_UNHEALTHY_BORROW_VALUE_SF: usize = 2256;
    pub const OB_ELEVATION_GROUP: usize = 2285;

    pub const RESERVE_LEN: usize = 8624;
    pub const RS_LENDING_MARKET: usize = 32;
    pub const RS_LIQUIDITY_MINT: usize = 128;
    pub const RS_LIQUIDITY_SUPPLY_VAULT: usize = 160;
    pub const RS_LIQUIDITY_TOKEN_PROGRAM: usize = 408;
    pub const RS_LIQUIDITY_FEE_VAULT: usize = 192;
    pub const RS_LIQUIDITY_MARKET_PRICE_SF: usize = 248;
    pub const RS_LIQUIDITY_MINT_DECIMALS: usize = 272;
    pub const RS_COLLATERAL_MINT: usize = 2560;
    pub const RS_COLLATERAL_SUPPLY_VAULT: usize = 2600;
    pub const RS_FARM_COLLATERAL: usize = 64;
    pub const RS_FARM_DEBT: usize = 96;
    pub const RS_LAST_UPDATE_SLOT: usize = 16;
    pub const RS_LAST_UPDATE_STALE: usize = 24;
    pub const RS_LIQUIDITY_AVAILABLE_AMOUNT: usize = 224;
    pub const RS_LIQUIDITY_BORROWED_AMOUNT_SF: usize = 232;
    pub const RS_LIQUIDITY_PROTOCOL_FEES_SF: usize = 344;
    pub const RS_LIQUIDITY_REFERRER_FEES_SF: usize = 360;
    pub const RS_LIQUIDITY_PENDING_REFERRER_FEES_SF: usize = 376;
    pub const RS_COLLATERAL_MINT_TOTAL_SUPPLY: usize = 2592;
    /// `liquidity.cumulative_borrow_rate_bsf`: `BigFractionBytes` (value `[u64; 4]`, U68F60, then padding).
    pub const RS_LIQUIDITY_CUMULATIVE_BORROW_RATE_BSF: usize = 296;
    pub const RS_CONFIG_STATUS: usize = 4856;
    pub const RS_CONFIG_LIQUIDATION_THRESHOLD_PCT: usize = 4873;
    pub const RS_CONFIG_BORROW_FACTOR_PCT: usize = 5008;
}

fn rd_pubkey(d: &[u8], o: usize) -> Result<Pubkey> {
    let b: [u8; 32] = d.get(o..o + 32).ok_or(CoreError::KaminoLayout)?.try_into().map_err(|_| CoreError::KaminoLayout)?;
    Ok(Pubkey::new_from_array(b))
}
fn rd_u128(d: &[u8], o: usize) -> Result<u128> {
    let b: [u8; 16] = d.get(o..o + 16).ok_or(CoreError::KaminoLayout)?.try_into().map_err(|_| CoreError::KaminoLayout)?;
    Ok(u128::from_le_bytes(b))
}
fn rd_u64(d: &[u8], o: usize) -> Result<u64> {
    let b: [u8; 8] = d.get(o..o + 8).ok_or(CoreError::KaminoLayout)?.try_into().map_err(|_| CoreError::KaminoLayout)?;
    Ok(u64::from_le_bytes(b))
}
fn rd_u8(d: &[u8], o: usize) -> Result<u8> {
    d.get(o).copied().ok_or_else(|| error!(CoreError::KaminoLayout))
}

/// The fields of a klend `Obligation` that cover reads. Values are klend's own (`_sf` = USD × 2^60, amounts in token
/// base units × 2^60), as of the obligation's last refresh.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObligationView {
    pub last_update_slot: u64,
    pub stale: u8,
    pub price_status: u8,
    pub lending_market: Pubkey,
    pub owner: Pubkey,
    /// Active deposits (reserve ≠ default): (reserve, market_value_sf).
    pub deposits: Vec<(Pubkey, u128)>,
    /// The cToken amount of each active deposit, in the order of `deposits`.
    pub deposit_amounts: Vec<u64>,
    /// Active borrows (reserve ≠ default): (reserve, borrowed_amount_sf, market_value_sf).
    pub borrows: Vec<(Pubkey, u128, u128)>,
    pub deposited_value_sf: u128,
    pub bf_adjusted_debt_value_sf: u128,
    pub borrowed_assets_market_value_sf: u128,
    /// Σ mv × LTV: what the obligation may borrow up to (klend's `allowed_borrow_value`).
    pub allowed_borrow_value_sf: u128,
    pub unhealthy_borrow_value_sf: u128,
    pub elevation_group: u8,
}

impl ObligationView {
    /// Decodes an account owned by klend. Checks the owner program, the length and the `Obligation` discriminator.
    pub fn load(acc: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*acc.owner, KLEND_PROGRAM_ID, CoreError::WrongProgram);
        let d = acc.try_borrow_data()?;
        Self::decode(&d)
    }

    /// Decodes raw account data (length and discriminator checked; the owner check is the caller's, see [`Self::load`]).
    pub fn decode(d: &[u8]) -> Result<Self> {
        use layout::*;
        require!(d.len() == OBLIGATION_LEN && d[..8] == OBLIGATION_DISC, CoreError::KaminoLayout);
        let mut deposits = Vec::with_capacity(1);
        let mut deposit_amounts = Vec::with_capacity(1);
        for i in 0..OB_DEPOSITS_N {
            let o = OB_DEPOSITS + i * DEPOSIT_LEN;
            let reserve = rd_pubkey(d, o + DEP_RESERVE)?;
            if reserve != Pubkey::default() {
                deposits.push((reserve, rd_u128(d, o + DEP_MARKET_VALUE_SF)?));
                deposit_amounts.push(rd_u64(d, o + DEP_DEPOSITED_AMOUNT)?);
            }
        }
        let mut borrows = Vec::with_capacity(1);
        for i in 0..OB_BORROWS_N {
            let o = OB_BORROWS + i * BORROW_LEN;
            let reserve = rd_pubkey(d, o + BOR_RESERVE)?;
            if reserve != Pubkey::default() {
                borrows.push((reserve, rd_u128(d, o + BOR_BORROWED_AMOUNT_SF)?, rd_u128(d, o + BOR_MARKET_VALUE_SF)?));
            }
        }
        Ok(Self {
            last_update_slot: rd_u64(d, OB_LAST_UPDATE_SLOT)?,
            stale: rd_u8(d, OB_LAST_UPDATE_STALE)?,
            price_status: rd_u8(d, OB_LAST_UPDATE_PRICE_STATUS)?,
            lending_market: rd_pubkey(d, OB_LENDING_MARKET)?,
            owner: rd_pubkey(d, OB_OWNER)?,
            deposits,
            deposit_amounts,
            borrows,
            deposited_value_sf: rd_u128(d, OB_DEPOSITED_VALUE_SF)?,
            bf_adjusted_debt_value_sf: rd_u128(d, OB_BF_ADJUSTED_DEBT_VALUE_SF)?,
            borrowed_assets_market_value_sf: rd_u128(d, OB_BORROWED_ASSETS_MARKET_VALUE_SF)?,
            allowed_borrow_value_sf: rd_u128(d, OB_ALLOWED_BORROW_VALUE_SF)?,
            unhealthy_borrow_value_sf: rd_u128(d, OB_UNHEALTHY_BORROW_VALUE_SF)?,
            elevation_group: rd_u8(d, OB_ELEVATION_GROUP)?,
        })
    }
}

/// The fields of a klend `Reserve` that cover reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReserveView {
    pub lending_market: Pubkey,
    pub liquidity_mint: Pubkey,
    pub supply_vault: Pubkey,
    pub token_program: Pubkey,
    pub status: u8,
    pub liquidation_threshold_pct: u8,
    pub borrow_factor_pct: u64,
    /// klend's cumulative borrow-rate index (U68F60), as of the reserve's last refresh: debt grows by its ratio.
    pub cumulative_borrow_rate_bsf: u128,
    /// Liquidation accounts (W2 backstop): the liquidity fee vault, the cToken mint and supply vault, the farms.
    pub fee_vault: Pubkey,
    pub mint_decimals: u64,
    pub collateral_mint: Pubkey,
    pub collateral_supply_vault: Pubkey,
    pub farm_collateral: Pubkey,
    pub farm_debt: Pubkey,
    /// Yield vault (W3): the reserve's last refresh and the inputs of klend's `total_supply` and exchange rate.
    pub last_update_slot: u64,
    pub stale: u8,
    pub available_amount: u64,
    pub borrowed_amount_sf: u128,
    pub fees_sf: u128,
    pub collateral_mint_total_supply: u64,
    /// The liquidity's USD price as of the reserve's last refresh, × 2^60 (klend `market_price_sf`).
    pub market_price_sf: u128,
}

impl ReserveView {
    /// klend's `Reserve::total_supply` in U68F60: `available × 2^60 + borrowed_sf − protocol and referrer fees`.
    pub fn total_supply_sf(&self) -> Result<u128> {
        (self.available_amount as u128)
            .checked_shl(SF_SHIFT)
            .and_then(|a| a.checked_add(self.borrowed_amount_sf))
            .and_then(|a| a.checked_sub(self.fees_sf))
            .ok_or_else(|| error!(CoreError::KaminoLayout))
    }
}

impl ReserveView {
    pub fn load(acc: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*acc.owner, KLEND_PROGRAM_ID, CoreError::WrongProgram);
        let d = acc.try_borrow_data()?;
        Self::decode(&d)
    }

    pub fn decode(d: &[u8]) -> Result<Self> {
        use layout::*;
        require!(d.len() == RESERVE_LEN && d[..8] == RESERVE_DISC, CoreError::KaminoLayout);
        Ok(Self {
            lending_market: rd_pubkey(d, RS_LENDING_MARKET)?,
            liquidity_mint: rd_pubkey(d, RS_LIQUIDITY_MINT)?,
            supply_vault: rd_pubkey(d, RS_LIQUIDITY_SUPPLY_VAULT)?,
            token_program: rd_pubkey(d, RS_LIQUIDITY_TOKEN_PROGRAM)?,
            status: rd_u8(d, RS_CONFIG_STATUS)?,
            liquidation_threshold_pct: rd_u8(d, RS_CONFIG_LIQUIDATION_THRESHOLD_PCT)?,
            borrow_factor_pct: rd_u64(d, RS_CONFIG_BORROW_FACTOR_PCT)?,
            cumulative_borrow_rate_bsf: {
                // A 256-bit value; the index starts at 1.0 (2^60) and grows with interest, so the high half is 0.
                require!(rd_u128(d, RS_LIQUIDITY_CUMULATIVE_BORROW_RATE_BSF + 16)? == 0, CoreError::KaminoLayout);
                rd_u128(d, RS_LIQUIDITY_CUMULATIVE_BORROW_RATE_BSF)?
            },
            fee_vault: rd_pubkey(d, RS_LIQUIDITY_FEE_VAULT)?,
            mint_decimals: rd_u64(d, RS_LIQUIDITY_MINT_DECIMALS)?,
            collateral_mint: rd_pubkey(d, RS_COLLATERAL_MINT)?,
            collateral_supply_vault: rd_pubkey(d, RS_COLLATERAL_SUPPLY_VAULT)?,
            farm_collateral: rd_pubkey(d, RS_FARM_COLLATERAL)?,
            farm_debt: rd_pubkey(d, RS_FARM_DEBT)?,
            last_update_slot: rd_u64(d, RS_LAST_UPDATE_SLOT)?,
            stale: rd_u8(d, RS_LAST_UPDATE_STALE)?,
            available_amount: rd_u64(d, RS_LIQUIDITY_AVAILABLE_AMOUNT)?,
            borrowed_amount_sf: rd_u128(d, RS_LIQUIDITY_BORROWED_AMOUNT_SF)?,
            fees_sf: rd_u128(d, RS_LIQUIDITY_PROTOCOL_FEES_SF)?
                .checked_add(rd_u128(d, RS_LIQUIDITY_REFERRER_FEES_SF)?)
                .and_then(|x| x.checked_add(rd_u128(d, RS_LIQUIDITY_PENDING_REFERRER_FEES_SF).ok()?))
                .ok_or(CoreError::KaminoLayout)?,
            collateral_mint_total_supply: rd_u64(d, RS_COLLATERAL_MINT_TOTAL_SUPPLY)?,
            market_price_sf: rd_u128(d, RS_LIQUIDITY_MARKET_PRICE_SF)?,
        })
    }
}

/// What `buy_cover` fixes at purchase, in USDC base units unless noted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoverSnapshot {
    /// Covered xStock's market value, USD at par to USDC, rounded DOWN (informational; the payout uses `covered_value`).
    pub collateral_value: u64,
    /// USDC debt including interest to the refresh, rounded UP.
    pub debt: u64,
    /// C′ = LT × C expressed in USDC: klend's `unhealthy_borrow_value` divided by the USDC price klend used for the debt,
    /// rounded DOWN. `debt ≥ covered_value` is exactly klend's liquidation condition at the snapshot prices.
    pub covered_value: u64,
    /// LT = unhealthy_borrow_value / deposited_value, WAD, rounded DOWN (elevation-group aware, as klend computes it).
    pub liquidation_threshold_wad: u64,
}

/// The klend reserves and Credence asset a cover purchase is checked against.
pub struct CoverAccounts<'a> {
    /// The obligation's deposit reserve (passed for `refresh_obligation` anyway) and its key.
    pub deposit_reserve_key: Pubkey,
    pub deposit_reserve: &'a ReserveView,
    /// The obligation's borrow reserve and its key.
    pub borrow_reserve_key: Pubkey,
    pub borrow_reserve: &'a ReserveView,
    /// `AssetConfig.mint` and `AssetConfig.kamino_reserves` of the covered xStock.
    pub asset_mint: Pubkey,
    pub asset_reserves: [Pubkey; 2],
    /// `Config.usdc_mint`.
    pub usdc_mint: Pubkey,
}

/// Snapshot for cover on a refreshed obligation. Phase 1 rules:
///
/// - The obligation was refreshed in this slot (`refresh_reserve` ×N + `refresh_obligation` earlier in the same
///   transaction): `last_update.slot == slot`, not stale, all price checks passed. Interest is only current after a
///   refresh.
/// - Its lending market is one of the two xStocks markets.
/// - The signer is the obligation's `owner`: nobody may buy a wallet-paid put on someone else's position.
/// - Exactly one deposit, in the covered xStock's reserve for that market, and exactly one borrow, in a USDC reserve
///   of the same market with borrow factor 100%. The payout rule uses the whole debt against one xStock's collateral,
///   so any other collateral would make it overpay; a borrow factor above 100% would make klend's liquidation debt
///   differ from the USDC debt that the payout repays.
/// - With no elevation group, klend's LT must equal the deposit reserve's `liquidation_threshold_pct` (cross-check of
///   the layout and of the snapshot). In an elevation group klend's own (group) LT is used.
pub fn cover_snapshot(ob: &ObligationView, signer: &Pubkey, slot: u64, a: &CoverAccounts) -> Result<CoverSnapshot> {
    let market_idx = XSTOCKS_MARKETS.iter().position(|m| *m == ob.lending_market).ok_or(CoreError::MarketNotAllowed)?;
    cover_snapshot_in(ob, signer, slot, a, a.asset_reserves[market_idx])
}

/// [`cover_snapshot`] with the covered asset's deposit reserve given by the caller, who has already decided that the
/// obligation's market is allowed: the weekend-safe market (D1) keeps its reserves in `WsmMarket`, not in `AssetConfig`.
pub fn cover_snapshot_in(ob: &ObligationView, signer: &Pubkey, slot: u64, a: &CoverAccounts, asset_reserve: Pubkey) -> Result<CoverSnapshot> {
    require!(
        ob.last_update_slot == slot && ob.stale == 0 && ob.price_status == PRICE_STATUS_ALL_CHECKS,
        CoreError::ObligationNotRefreshed
    );
    require_keys_eq!(ob.owner, *signer, CoreError::NotObligationOwner);

    require!(ob.deposits.len() == 1 && ob.borrows.len() == 1, CoreError::UnsupportedObligation);
    let (dep_key, dep_mv_sf) = ob.deposits[0];
    let (bor_key, bor_amount_sf, bor_mv_sf) = ob.borrows[0];
    require!(
        dep_key == a.deposit_reserve_key
            && dep_key == asset_reserve
            && a.deposit_reserve.lending_market == ob.lending_market
            && a.deposit_reserve.liquidity_mint == a.asset_mint,
        CoreError::UnsupportedObligation
    );
    require!(
        bor_key == a.borrow_reserve_key
            && a.borrow_reserve.lending_market == ob.lending_market
            && a.borrow_reserve.liquidity_mint == a.usdc_mint
            && a.borrow_reserve.borrow_factor_pct == 100
            && ob.bf_adjusted_debt_value_sf == ob.borrowed_assets_market_value_sf,
        CoreError::UnsupportedObligation
    );
    let s = snapshot_values(dep_mv_sf, bor_amount_sf, bor_mv_sf, ob.unhealthy_borrow_value_sf, ob.deposited_value_sf)?;
    if ob.elevation_group == 0 {
        // klend: unhealthy = mv × LT% in U68F60; allow 1e-9 of rounding in the WAD ratio.
        let reserve_lt = (a.deposit_reserve.liquidation_threshold_pct as u64) * (WAD as u64 / 100);
        require!(s.liquidation_threshold_wad.abs_diff(reserve_lt) <= 1_000_000_000, CoreError::KaminoLayout);
    }
    Ok(s)
}

/// Unit conversion of klend's values (see [`CoverSnapshot`] for each field's rounding).
fn snapshot_values(
    deposit_mv_sf: u128,
    borrowed_amount_sf: u128,
    borrow_mv_sf: u128,
    unhealthy_sf: u128,
    deposited_value_sf: u128,
) -> Result<CoverSnapshot> {
    require!(deposit_mv_sf > 0 && borrow_mv_sf > 0 && deposited_value_sf > 0, CoreError::UnsupportedObligation);
    let one_sf = U256::from(1u8) << SF_SHIFT;
    let to_u64 = |x: U256| u64::try_from(x).map_err(|_| error!(CoreError::Math));
    // D = ⌈amount_sf / 2^60⌉ (base units).
    let debt = to_u64((U256::from(borrowed_amount_sf) + one_sf - U256::from(1u8)) >> SF_SHIFT)?;
    // C = ⌊mv_sf × 1e6 / 2^60⌋.
    let collateral_value = to_u64((U256::from(deposit_mv_sf) * U256::from(1_000_000u32)) >> SF_SHIFT)?;
    // C′ = ⌊unhealthy_usd × amount / debt_usd⌋ = ⌊unhealthy_sf × amount_sf / (borrow_mv_sf × 2^60)⌋.
    let covered_value = to_u64(
        (U256::from(unhealthy_sf) * U256::from(borrowed_amount_sf)) / (U256::from(borrow_mv_sf) << SF_SHIFT),
    )?;
    let lt = to_u64(U256::from(unhealthy_sf) * U256::from(WAD) / U256::from(deposited_value_sf))?;
    Ok(CoverSnapshot { collateral_value, debt, covered_value, liquidation_threshold_wad: lt })
}

/// One deposit of a multi-collateral obligation, as `cover_snapshot_multi` reads it.
pub struct DepositLeg<'a> {
    pub reserve_key: Pubkey,
    pub reserve: &'a ReserveView,
    /// `Some(asset index in `legs` order)` when the reserve is a covered xStock's; `None` for a stablecoin.
    pub leg: Option<usize>,
}

/// What `buy_cover_multi` fixes at purchase (W4), debt units (USDC or PYUSD base units).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MultiSnapshot {
    /// C′_i per leg (the order of the legs the caller passed), rounded DOWN.
    pub leg_covered: Vec<u64>,
    /// S′ = Σ LT_s × stablecoin deposits, rounded DOWN.
    pub stable_covered: u64,
    /// Debt including interest to the refresh, rounded UP.
    pub debt: u64,
    /// Σ market value of all deposits, debt units, rounded DOWN (informational).
    pub collateral_value: u64,
    pub borrow_mint: Pubkey,
}

/// Snapshot for multi-collateral cover (W4). As [`cover_snapshot`], except:
/// - deposits: any mix of covered xStocks (in this market's reserve of an enabled asset) and stablecoins (USDC or PYUSD
///   reserves of this market); anything else (SOL, cbBTC, another xStock) is refused, since it moves at weekends too;
/// - the borrow: exactly one, USDC or PYUSD, borrow factor 100%;
/// - no elevation group (each deposit's own LT is used: `C′_i = mv_i × LT_i`, which must add up to klend's
///   `unhealthy_borrow_value`).
///
/// `deposits` must list the obligation's deposits in its order; `n_legs` is the number of distinct xStock legs.
#[allow(clippy::too_many_arguments)]
pub fn cover_snapshot_multi(
    ob: &ObligationView,
    signer: &Pubkey,
    slot: u64,
    deposits: &[DepositLeg],
    n_legs: usize,
    borrow_key: Pubkey,
    borrow: &ReserveView,
    stable_mints: &[Pubkey],
) -> Result<MultiSnapshot> {
    require!(
        ob.last_update_slot == slot && ob.stale == 0 && ob.price_status == PRICE_STATUS_ALL_CHECKS,
        CoreError::ObligationNotRefreshed
    );
    require!(XSTOCKS_MARKETS.contains(&ob.lending_market), CoreError::MarketNotAllowed);
    require_keys_eq!(ob.owner, *signer, CoreError::NotObligationOwner);
    require!(ob.elevation_group == 0, CoreError::UnsupportedObligation);
    require!(ob.borrows.len() == 1 && ob.deposits.len() == deposits.len() && !deposits.is_empty(), CoreError::UnsupportedObligation);
    let (bor_key, bor_amount_sf, bor_mv_sf) = ob.borrows[0];
    require!(
        bor_key == borrow_key
            && borrow.lending_market == ob.lending_market
            && stable_mints.contains(&borrow.liquidity_mint)
            && borrow.borrow_factor_pct == 100
            && ob.bf_adjusted_debt_value_sf == ob.borrowed_assets_market_value_sf
            && bor_mv_sf > 0,
        CoreError::UnsupportedObligation
    );
    let one_sf = U256::from(1u8) << SF_SHIFT;
    let to_u64 = |x: U256| u64::try_from(x).map_err(|_| error!(CoreError::Math));
    let debt = to_u64((U256::from(bor_amount_sf) + one_sf - U256::from(1u8)) >> SF_SHIFT)?;
    // A USD value (× 2^60) in debt units at the price klend used for the debt: v × amount_sf / (borrow_mv_sf × 2^60).
    let in_debt_units = |v_sf: U256| -> Result<u64> { to_u64(v_sf * U256::from(bor_amount_sf) / (U256::from(bor_mv_sf) << SF_SHIFT)) };
    let mut legs = vec![0u64; n_legs];
    let mut stable_sf = U256::ZERO;
    let mut unhealthy_sf = U256::ZERO;
    let mut deposited_sf = U256::ZERO;
    for (k, (dep_key, dep_mv_sf)) in ob.deposits.iter().enumerate() {
        let d = &deposits[k];
        require!(d.reserve_key == *dep_key && d.reserve.lending_market == ob.lending_market, CoreError::UnsupportedObligation);
        // klend: unhealthy borrow value = Σ mv × LT% (no elevation group).
        let lt_sf = U256::from(*dep_mv_sf) * U256::from(d.reserve.liquidation_threshold_pct) / U256::from(100u8);
        unhealthy_sf += lt_sf;
        deposited_sf += U256::from(*dep_mv_sf);
        match d.leg {
            Some(i) => {
                require!(i < n_legs, CoreError::UnsupportedObligation);
                legs[i] = legs[i].checked_add(in_debt_units(lt_sf)?).ok_or(CoreError::Math)?;
            }
            None => {
                require!(stable_mints.contains(&d.reserve.liquidity_mint), CoreError::UnsupportedObligation);
                stable_sf += lt_sf;
            }
        }
    }
    require!(legs.iter().all(|c| *c > 0), CoreError::UnsupportedObligation);
    // Layout and LT cross-check: our Σ mv × LT against klend's own unhealthy borrow value (rounding: ≤ 1e-9 relative).
    let theirs = U256::from(ob.unhealthy_borrow_value_sf);
    let diff = if unhealthy_sf > theirs { unhealthy_sf - theirs } else { theirs - unhealthy_sf };
    require!(diff * U256::from(1_000_000_000u64) <= theirs.max(U256::from(1u8)), CoreError::KaminoLayout);
    Ok(MultiSnapshot {
        leg_covered: legs,
        stable_covered: in_debt_units(stable_sf)?,
        debt,
        collateral_value: in_debt_units(deposited_sf)?,
        borrow_mint: borrow.liquidity_mint,
    })
}

/// Accounts of `repay_obligation_liquidity_v2`, in klend's order.
pub struct RepayV2<'a, 'info> {
    /// Payer of `user_source_liquidity`; klend does not require it to own the obligation.
    pub owner: &'a AccountInfo<'info>,
    pub obligation: &'a AccountInfo<'info>,
    pub lending_market: &'a AccountInfo<'info>,
    pub repay_reserve: &'a AccountInfo<'info>,
    pub reserve_liquidity_mint: &'a AccountInfo<'info>,
    pub reserve_destination_liquidity: &'a AccountInfo<'info>,
    pub user_source_liquidity: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub instruction_sysvar: &'a AccountInfo<'info>,
    /// `None` when the reserve has no debt farm (klend then expects its own program id in this slot).
    pub obligation_farm_user_state: Option<&'a AccountInfo<'info>>,
    pub reserve_farm_state: Option<&'a AccountInfo<'info>>,
    pub lending_market_authority: &'a AccountInfo<'info>,
    pub farms_program: &'a AccountInfo<'info>,
    pub klend_program: &'a AccountInfo<'info>,
}

/// Repays `amount` (liquidity base units) of the obligation's debt in `repay_reserve`, paid from
/// `user_source_liquidity` with `owner` signing through `signer_seeds`.
///
/// klend caps the repayment at the outstanding debt (it repays `min(amount, borrowed)`); `u64::MAX` means "repay all".
pub fn repay_obligation_liquidity_v2(a: &RepayV2<'_, '_>, amount: u64, signer_seeds: &[&[&[u8]]]) -> Result<()> {
    require_keys_eq!(*a.klend_program.key, KLEND_PROGRAM_ID, CoreError::WrongProgram);
    require_keys_eq!(*a.farms_program.key, FARMS_PROGRAM_ID, CoreError::WrongProgram);
    require!(repay_market_allowed(a.lending_market.key), CoreError::MarketNotAllowed);

    let farm_slot = |acc: Option<&AccountInfo>| match acc {
        Some(acc) => AccountMeta::new(*acc.key, false),
        None => AccountMeta::new_readonly(KLEND_PROGRAM_ID, false),
    };
    let metas = vec![
        AccountMeta::new_readonly(*a.owner.key, true),
        AccountMeta::new(*a.obligation.key, false),
        AccountMeta::new_readonly(*a.lending_market.key, false),
        AccountMeta::new(*a.repay_reserve.key, false),
        AccountMeta::new_readonly(*a.reserve_liquidity_mint.key, false),
        AccountMeta::new(*a.reserve_destination_liquidity.key, false),
        AccountMeta::new(*a.user_source_liquidity.key, false),
        AccountMeta::new_readonly(*a.token_program.key, false),
        AccountMeta::new_readonly(*a.instruction_sysvar.key, false),
        farm_slot(a.obligation_farm_user_state),
        farm_slot(a.reserve_farm_state),
        AccountMeta::new_readonly(*a.lending_market_authority.key, false),
        AccountMeta::new_readonly(*a.farms_program.key, false),
    ];
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&REPAY_OBLIGATION_LIQUIDITY_V2_DISC);
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction { program_id: KLEND_PROGRAM_ID, accounts: metas, data };

    let mut infos = vec![
        a.owner.clone(),
        a.obligation.clone(),
        a.lending_market.clone(),
        a.repay_reserve.clone(),
        a.reserve_liquidity_mint.clone(),
        a.reserve_destination_liquidity.clone(),
        a.user_source_liquidity.clone(),
        a.token_program.clone(),
        a.instruction_sysvar.clone(),
        a.lending_market_authority.clone(),
        a.farms_program.clone(),
        a.klend_program.clone(),
    ];
    infos.extend(a.obligation_farm_user_state.cloned());
    infos.extend(a.reserve_farm_state.cloned());
    invoke_signed(&ix, &infos, signer_seeds)?;
    Ok(())
}

/// Accounts of `liquidate_obligation_and_redeem_reserve_collateral_v2`, in klend's order (klend-sdk codegen).
pub struct LiquidateV2<'a, 'info> {
    /// Signs and pays `user_source_liquidity`; receives the collateral.
    pub liquidator: &'a AccountInfo<'info>,
    pub obligation: &'a AccountInfo<'info>,
    pub lending_market: &'a AccountInfo<'info>,
    pub lending_market_authority: &'a AccountInfo<'info>,
    pub repay_reserve: &'a AccountInfo<'info>,
    pub repay_reserve_liquidity_mint: &'a AccountInfo<'info>,
    pub repay_reserve_liquidity_supply: &'a AccountInfo<'info>,
    pub withdraw_reserve: &'a AccountInfo<'info>,
    pub withdraw_reserve_liquidity_mint: &'a AccountInfo<'info>,
    pub withdraw_reserve_collateral_mint: &'a AccountInfo<'info>,
    pub withdraw_reserve_collateral_supply: &'a AccountInfo<'info>,
    pub withdraw_reserve_liquidity_supply: &'a AccountInfo<'info>,
    pub withdraw_reserve_liquidity_fee_receiver: &'a AccountInfo<'info>,
    pub user_source_liquidity: &'a AccountInfo<'info>,
    pub user_destination_collateral: &'a AccountInfo<'info>,
    pub user_destination_liquidity: &'a AccountInfo<'info>,
    pub collateral_token_program: &'a AccountInfo<'info>,
    pub repay_liquidity_token_program: &'a AccountInfo<'info>,
    pub withdraw_liquidity_token_program: &'a AccountInfo<'info>,
    pub instruction_sysvar: &'a AccountInfo<'info>,
    /// Collateral (withdraw reserve) farm: obligation user state and farm state; `None` → the klend id in the slot.
    pub collateral_farm_user_state: Option<&'a AccountInfo<'info>>,
    pub collateral_farm_state: Option<&'a AccountInfo<'info>>,
    /// Debt (repay reserve) farm, as above.
    pub debt_farm_user_state: Option<&'a AccountInfo<'info>>,
    pub debt_farm_state: Option<&'a AccountInfo<'info>>,
    pub farms_program: &'a AccountInfo<'info>,
    pub klend_program: &'a AccountInfo<'info>,
}

/// Liquidates up to `liquidity_amount` (repay-reserve base units) of the obligation's debt and redeems the collateral
/// to its liquidity (the xStock), `liquidator` signing through `signer_seeds`. klend decides whether the obligation is
/// liquidatable, the close factor and the bonus; it fails if the redeemed liquidity is below `min_received`. v2 accepts
/// cross-program calls (the v1 instruction rejects them, `check_refresh_ixs`). The transaction must refresh both reserves
/// and the obligation first and must not contain Jupiter's program.
pub fn liquidate_obligation_and_redeem_reserve_collateral_v2(
    a: &LiquidateV2<'_, '_>,
    liquidity_amount: u64,
    min_received: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*a.klend_program.key, KLEND_PROGRAM_ID, CoreError::WrongProgram);
    require_keys_eq!(*a.farms_program.key, FARMS_PROGRAM_ID, CoreError::WrongProgram);
    require!(XSTOCKS_MARKETS.contains(a.lending_market.key), CoreError::MarketNotAllowed);
    let slot = |acc: Option<&AccountInfo>| match acc {
        Some(acc) => AccountMeta::new(*acc.key, false),
        None => AccountMeta::new_readonly(KLEND_PROGRAM_ID, false),
    };
    let metas = vec![
        AccountMeta::new_readonly(*a.liquidator.key, true),
        AccountMeta::new(*a.obligation.key, false),
        AccountMeta::new_readonly(*a.lending_market.key, false),
        AccountMeta::new_readonly(*a.lending_market_authority.key, false),
        AccountMeta::new(*a.repay_reserve.key, false),
        AccountMeta::new_readonly(*a.repay_reserve_liquidity_mint.key, false),
        AccountMeta::new(*a.repay_reserve_liquidity_supply.key, false),
        AccountMeta::new(*a.withdraw_reserve.key, false),
        AccountMeta::new_readonly(*a.withdraw_reserve_liquidity_mint.key, false),
        AccountMeta::new(*a.withdraw_reserve_collateral_mint.key, false),
        AccountMeta::new(*a.withdraw_reserve_collateral_supply.key, false),
        AccountMeta::new(*a.withdraw_reserve_liquidity_supply.key, false),
        AccountMeta::new(*a.withdraw_reserve_liquidity_fee_receiver.key, false),
        AccountMeta::new(*a.user_source_liquidity.key, false),
        AccountMeta::new(*a.user_destination_collateral.key, false),
        AccountMeta::new(*a.user_destination_liquidity.key, false),
        AccountMeta::new_readonly(*a.collateral_token_program.key, false),
        AccountMeta::new_readonly(*a.repay_liquidity_token_program.key, false),
        AccountMeta::new_readonly(*a.withdraw_liquidity_token_program.key, false),
        AccountMeta::new_readonly(*a.instruction_sysvar.key, false),
        slot(a.collateral_farm_user_state),
        slot(a.collateral_farm_state),
        slot(a.debt_farm_user_state),
        slot(a.debt_farm_state),
        AccountMeta::new_readonly(*a.farms_program.key, false),
    ];
    let mut data = Vec::with_capacity(32);
    data.extend_from_slice(&LIQUIDATE_V2_DISC);
    data.extend_from_slice(&liquidity_amount.to_le_bytes());
    data.extend_from_slice(&min_received.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // max_allowed_ltv_override_percent: none
    let ix = Instruction { program_id: KLEND_PROGRAM_ID, accounts: metas, data };
    let mut infos = vec![
        a.liquidator.clone(), a.obligation.clone(), a.lending_market.clone(), a.lending_market_authority.clone(),
        a.repay_reserve.clone(), a.repay_reserve_liquidity_mint.clone(), a.repay_reserve_liquidity_supply.clone(),
        a.withdraw_reserve.clone(), a.withdraw_reserve_liquidity_mint.clone(), a.withdraw_reserve_collateral_mint.clone(),
        a.withdraw_reserve_collateral_supply.clone(), a.withdraw_reserve_liquidity_supply.clone(),
        a.withdraw_reserve_liquidity_fee_receiver.clone(), a.user_source_liquidity.clone(),
        a.user_destination_collateral.clone(), a.user_destination_liquidity.clone(), a.collateral_token_program.clone(),
        a.repay_liquidity_token_program.clone(), a.withdraw_liquidity_token_program.clone(), a.instruction_sysvar.clone(),
        a.farms_program.clone(), a.klend_program.clone(),
    ];
    for f in [a.collateral_farm_user_state, a.collateral_farm_state, a.debt_farm_user_state, a.debt_farm_state].into_iter().flatten() {
        infos.push(f.clone());
    }
    invoke_signed(&ix, &infos, signer_seeds)?;
    Ok(())
}

/// `sha256("global:deposit_reserve_liquidity")[..8]` (klend-sdk).
pub const DEPOSIT_RESERVE_LIQUIDITY_DISC: [u8; 8] = [169, 201, 30, 126, 6, 205, 102, 68];
/// `sha256("global:redeem_reserve_collateral")[..8]` (klend-sdk).
pub const REDEEM_RESERVE_COLLATERAL_DISC: [u8; 8] = [234, 117, 181, 125, 185, 142, 220, 29];

/// Accounts of `deposit_reserve_liquidity` / `redeem_reserve_collateral` (W3 yield vault), klend-sdk's names.
pub struct ReserveLiquidity<'a, 'info> {
    pub owner: &'a AccountInfo<'info>,
    pub reserve: &'a AccountInfo<'info>,
    pub lending_market: &'a AccountInfo<'info>,
    pub lending_market_authority: &'a AccountInfo<'info>,
    pub reserve_liquidity_mint: &'a AccountInfo<'info>,
    pub reserve_liquidity_supply: &'a AccountInfo<'info>,
    pub reserve_collateral_mint: &'a AccountInfo<'info>,
    /// The owner's USDC account and its cToken account.
    pub user_liquidity: &'a AccountInfo<'info>,
    pub user_collateral: &'a AccountInfo<'info>,
    pub collateral_token_program: &'a AccountInfo<'info>,
    pub liquidity_token_program: &'a AccountInfo<'info>,
    pub instruction_sysvar: &'a AccountInfo<'info>,
    pub klend_program: &'a AccountInfo<'info>,
}

fn reserve_liquidity_infos<'info>(a: &ReserveLiquidity<'_, 'info>) -> Vec<AccountInfo<'info>> {
    vec![
        a.owner.clone(), a.reserve.clone(), a.lending_market.clone(), a.lending_market_authority.clone(),
        a.reserve_liquidity_mint.clone(), a.reserve_liquidity_supply.clone(), a.reserve_collateral_mint.clone(),
        a.user_liquidity.clone(), a.user_collateral.clone(), a.collateral_token_program.clone(),
        a.liquidity_token_program.clone(), a.instruction_sysvar.clone(), a.klend_program.clone(),
    ]
}

/// Deposits `amount` liquidity into the reserve for cTokens (klend `deposit_reserve_liquidity`), `owner` signing.
pub fn deposit_reserve_liquidity(a: &ReserveLiquidity<'_, '_>, amount: u64, signer_seeds: &[&[&[u8]]]) -> Result<()> {
    require_keys_eq!(*a.klend_program.key, KLEND_PROGRAM_ID, CoreError::WrongProgram);
    require!(XSTOCKS_MARKETS.contains(a.lending_market.key), CoreError::MarketNotAllowed);
    let metas = vec![
        AccountMeta::new_readonly(*a.owner.key, true),
        AccountMeta::new(*a.reserve.key, false),
        AccountMeta::new_readonly(*a.lending_market.key, false),
        AccountMeta::new_readonly(*a.lending_market_authority.key, false),
        AccountMeta::new_readonly(*a.reserve_liquidity_mint.key, false),
        AccountMeta::new(*a.reserve_liquidity_supply.key, false),
        AccountMeta::new(*a.reserve_collateral_mint.key, false),
        AccountMeta::new(*a.user_liquidity.key, false),
        AccountMeta::new(*a.user_collateral.key, false),
        AccountMeta::new_readonly(*a.collateral_token_program.key, false),
        AccountMeta::new_readonly(*a.liquidity_token_program.key, false),
        AccountMeta::new_readonly(*a.instruction_sysvar.key, false),
    ];
    let mut data = DEPOSIT_RESERVE_LIQUIDITY_DISC.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    invoke_signed(&Instruction { program_id: KLEND_PROGRAM_ID, accounts: metas, data }, &reserve_liquidity_infos(a), signer_seeds)?;
    Ok(())
}

/// Redeems `collateral` cTokens for liquidity (klend `redeem_reserve_collateral`), `owner` signing.
pub fn redeem_reserve_collateral(a: &ReserveLiquidity<'_, '_>, collateral: u64, signer_seeds: &[&[&[u8]]]) -> Result<()> {
    require_keys_eq!(*a.klend_program.key, KLEND_PROGRAM_ID, CoreError::WrongProgram);
    require!(XSTOCKS_MARKETS.contains(a.lending_market.key), CoreError::MarketNotAllowed);
    let metas = vec![
        AccountMeta::new_readonly(*a.owner.key, true),
        AccountMeta::new_readonly(*a.lending_market.key, false),
        AccountMeta::new(*a.reserve.key, false),
        AccountMeta::new_readonly(*a.lending_market_authority.key, false),
        AccountMeta::new_readonly(*a.reserve_liquidity_mint.key, false),
        AccountMeta::new(*a.reserve_collateral_mint.key, false),
        AccountMeta::new(*a.reserve_liquidity_supply.key, false),
        AccountMeta::new(*a.user_collateral.key, false),
        AccountMeta::new(*a.user_liquidity.key, false),
        AccountMeta::new_readonly(*a.collateral_token_program.key, false),
        AccountMeta::new_readonly(*a.liquidity_token_program.key, false),
        AccountMeta::new_readonly(*a.instruction_sysvar.key, false),
    ];
    let mut data = REDEEM_RESERVE_COLLATERAL_DISC.to_vec();
    data.extend_from_slice(&collateral.to_le_bytes());
    invoke_signed(&Instruction { program_id: KLEND_PROGRAM_ID, accounts: metas, data }, &reserve_liquidity_infos(a), signer_seeds)?;
    Ok(())
}

/// What `buy_cover_up` fixes at purchase (W11, side UP), USD base units (6 decimals; the payout is USDC at par).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpSnapshot {
    /// C′: the stablecoin deposits at their LT (klend's `unhealthy_borrow_value`), rounded DOWN.
    pub covered_value: u64,
    /// D: the xStock debt's value × its borrow factor (klend's `borrow_factor_adjusted_debt_value`), rounded UP.
    pub debt: u64,
    /// Σ deposits' market value, rounded DOWN (informational).
    pub collateral_value: u64,
}

/// Snapshot of a short position (W11): refreshed this slot, the signer's, no elevation group, one borrow of the
/// asset's xStock reserve in this market, every deposit a stablecoin (USDC or PYUSD). klend's health compares D (the
/// borrow-factor-adjusted debt) with C′ (Σ mv × LT); both are read from the obligation and C′ is cross-checked
/// against the deposits' own LTs.
pub fn cover_snapshot_up(
    ob: &ObligationView,
    signer: &Pubkey,
    slot: u64,
    deposits: &[(Pubkey, &ReserveView)],
    borrow_key: Pubkey,
    borrow: &ReserveView,
    asset_mint: &Pubkey,
    asset_reserves: &[Pubkey; 2],
    stable_mints: &[Pubkey],
) -> Result<UpSnapshot> {
    require!(
        ob.last_update_slot == slot && ob.stale == 0 && ob.price_status == PRICE_STATUS_ALL_CHECKS,
        CoreError::ObligationNotRefreshed
    );
    let market_idx = XSTOCKS_MARKETS.iter().position(|m| *m == ob.lending_market).ok_or(CoreError::MarketNotAllowed)?;
    require_keys_eq!(ob.owner, *signer, CoreError::NotObligationOwner);
    require!(ob.elevation_group == 0, CoreError::UnsupportedObligation);
    require!(ob.borrows.len() == 1 && !deposits.is_empty() && ob.deposits.len() == deposits.len(), CoreError::UnsupportedObligation);
    let (bor_key, _, bor_mv_sf) = ob.borrows[0];
    require!(
        bor_key == borrow_key && borrow_key == asset_reserves[market_idx] && borrow.liquidity_mint == *asset_mint
            && borrow.lending_market == ob.lending_market && bor_mv_sf > 0,
        CoreError::UnsupportedObligation
    );
    let mut unhealthy = U256::ZERO;
    for (k, (dep_key, dep_mv_sf)) in ob.deposits.iter().enumerate() {
        let (key, r) = deposits[k];
        require!(key == *dep_key && r.lending_market == ob.lending_market && stable_mints.contains(&r.liquidity_mint), CoreError::UnsupportedObligation);
        unhealthy += U256::from(*dep_mv_sf) * U256::from(r.liquidation_threshold_pct) / U256::from(100u8);
    }
    let theirs = U256::from(ob.unhealthy_borrow_value_sf);
    let diff = if unhealthy > theirs { unhealthy - theirs } else { theirs - unhealthy };
    require!(diff * U256::from(1_000_000_000u64) <= theirs.max(U256::from(1u8)), CoreError::KaminoLayout);
    let e6 = U256::from(1_000_000u64);
    let one = U256::from(1u8) << SF_SHIFT;
    let to_u64 = |x: U256| u64::try_from(x).map_err(|_| error!(CoreError::Math));
    Ok(UpSnapshot {
        covered_value: to_u64(theirs * e6 >> SF_SHIFT)?,
        debt: to_u64((U256::from(ob.bf_adjusted_debt_value_sf) * e6 + one - U256::from(1u8)) >> SF_SHIFT)?,
        collateral_value: to_u64(U256::from(ob.deposited_value_sf) * e6 >> SF_SHIFT)?,
    })
}
