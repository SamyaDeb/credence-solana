//! Account layouts. PDA seeds are in `pdas` and on each account below; sizes below include the 8-byte discriminator
//! and are asserted in `tests/accounts.rs`.
//!
//! Units: money in USDC base units (`u64`, 6 decimals); prices and ratios in WAD (1e18); scenario gaps `z` as `i16`
//! thousandths of one σ; on-chain gap factors in Q64.64 (`u128` stored as 16 little-endian bytes so zero-copy accounts
//! stay 8-byte aligned).

use anchor_lang::prelude::*;

/// Ticker padded with zeros to 8 bytes, e.g. `b"SPYx\0\0\0\0"`. Used as a PDA seed.
pub type Ticker = [u8; 8];

/// Joint stress scenarios per joint set (K = 256).
pub const K: usize = 256;
/// Maximum points per on-chain scenario set (the calibrated sets have 3,000).
pub const N_SCEN: usize = 3000;
/// Maximum assets (columns) in a joint set.
pub const MAX_JOINT_ASSETS: usize = 8;

pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_ASSET: &[u8] = b"asset";
pub const SEED_SCENARIOS: &[u8] = b"scen";
pub const SEED_JOINT: &[u8] = b"joint";
pub const SEED_EPOCH: &[u8] = b"epoch";
pub const SEED_VAULT: &[u8] = b"vault";
pub const SEED_LOSS: &[u8] = b"loss";
pub const SEED_POLICY: &[u8] = b"policy";
pub const SEED_CALENDAR: &[u8] = b"calendar";
pub const SEED_VAULT_USDC: &[u8] = b"vault_usdc";
pub const SEED_SHARES: &[u8] = b"shares";
pub const SEED_SHARE_ESCROW: &[u8] = b"share_escrow";
pub const SEED_DEPOSIT_TICKET: &[u8] = b"dep";
pub const SEED_WITHDRAW_TICKET: &[u8] = b"wd";
pub const SEED_BACKSTOP: &[u8] = b"backstop";
pub const SEED_INVENTORY: &[u8] = b"inventory";
pub const SEED_EARNINGS: &[u8] = b"earnings";
pub const SEED_BOOK: &[u8] = b"book";
pub const SEED_BOOK_ESCROW: &[u8] = b"book_escrow";
pub const SEED_FEED: &[u8] = b"feed";

/// xStock legs a multi-collateral policy can cover (klend allows 8 deposits).
pub const MAX_LEGS: usize = 8;

/// xStocks the backstop can hold at once (one `Vault.inv` slot each).
pub const MAX_INV: usize = 4;
/// An inventory mark older than this is stale: share prices (deposits, withdrawals) wait for a fresh
/// `mark_inventory` while the vault holds inventory (W2).
pub const MARK_MAX_AGE_SECS: i64 = 900;

/// Groups with unsettled policies the vault tracks at once (the keeper opens four weekends ahead; sales for the next
/// weekend can overlap the settlement of the last one).
pub const MAX_LIVE_GROUPS: usize = 8;

/// Closure types. Phase 1 sells `WEEKEND` only.
pub mod closure {
    pub const OVERNIGHT: u8 = 1;
    pub const WEEKEND: u8 = 2;
    pub const HOLIDAY_WEEKEND: u8 = 3;
}

/// Global parameters. Seeds `["config"]`. Size [`Config::SIZE`].
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// May only reduce risk (pause).
    pub guardian: Pubkey,
    /// Stores the Friday close and the settlement price and runs queues; anyone may settle policies.
    pub keeper: Pubkey,
    /// SPL Token USDC mint (classic Token program).
    pub usdc_mint: Pubkey,
    /// u_max, WAD: reserved worst-case loss ≤ u_max × equity (INV-2).
    pub u_max_wad: u64,
    /// One asset's worst covered loss ≤ max_asset_share × u_max × equity, WAD.
    pub max_asset_share_wad: u64,
    /// Premium parameters (risk-core F-4.3), WAD unless noted.
    pub theta_wad: u64,
    pub cost_of_cap_wad: u64,
    pub eta_wad: u64,
    pub beta_wad: u64,
    /// κ, liquidation cost, WAD. Enters the gap factors.
    pub kappa_wad: u64,
    /// Floor premium, USDC base units.
    pub min_premium: u64,
    /// Protocol fee on premiums, basis points.
    pub fee_bps: u16,
    /// Pyth confidence bound: conf ≤ max_conf_bps × price / 10,000.
    pub max_conf_bps: u16,
    /// Equity-based price vs `Crypto.<T>X/USD` cross-check tolerance, basis points.
    pub xcheck_bps: u16,
    /// EQUITY source: the Friday close is the update published in `[close − close_window_secs, close]`.
    pub close_window_secs: u32,
    /// XSTOCK source (Pyth push accounts, one update about every 14.5 min in session): the close is the push account's
    /// update in `[close − w, close]` and the settlement price its first update in `[open, open + w]`; w ≤ 1 h.
    pub xstock_settle_window_secs: u32,
    /// Liquidation Shield (W1). α: an advance never exceeds `α × max_payout` (INV-9); 0 disables the shield (and its
    /// premium loading).
    pub shield_alpha_wad: u64,
    /// b: the weekend fair value is marked down by b before sizing an advance.
    pub shield_buffer_wad: u64,
    /// h: an advance restores a projected health of `1 + h` at the marked-down fair value (the "prevent" case).
    pub shield_health_wad: u64,
    /// λ: premium loading on the expected shield loss `E[max(0, advance − payout)]`.
    pub shield_lambda_wad: u64,
    /// Oldest fair-value update an advance may use, seconds (weekend pushes are deviation-driven, plan/06).
    pub shield_max_age_secs: u32,
    /// Shield window, seconds before the epoch's next open (from the calendar, so a holiday moves it): from
    /// `open − start` (Sunday 20:00 ET for a 09:30 Monday open) to `open − deadline` (Monday 07:00 ET).
    pub shield_start_before_open_secs: u32,
    pub shield_deadline_before_open_secs: u32,
    /// k: the capacity check reserves, per joint scenario, the advance the shield would make at a fair value `k·σ_b`
    /// below the scenario's gap (task 1.2), WAD. Default 2.
    pub shield_reserve_k_wad: u64,
    /// The most a covered debt may grow by interest between purchase and the open, WAD (task 1.2; default 0.5%).
    /// Capacity reserves `D × (1 + cap)`; the shield and settlement into the obligation use the interest klend
    /// actually accrued on the snapshot, up to it.
    pub debt_growth_cap_wad: u64,
    /// The interest premiums price, WAD (default 0.1%: the USDC reserve's 5.5% borrow APY over a week, Oct 9): the
    /// premium is an expectation, the reservation the cap. ≤ `debt_growth_cap_wad`.
    pub debt_growth_est_wad: u64,
    /// Proposed next admin (`propose_admin`), default when none: the handover completes when it accepts (W6).
    pub pending_admin: Pubkey,
    /// PYUSD (Token-2022), the Sentora xStocks Market's debt (W4): cover on PYUSD debt pays from the vault's PYUSD sleeve.
    pub pyusd_mint: Pubkey,
    /// `fund_sleeve` pays at most PYUSD × its klend price × (1 + this), basis points (the keeper's Jupiter swap cost).
    pub sleeve_slippage_bps: u16,
    pub paused: bool,
    pub bump: u8,
}
impl Config {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

/// Per-asset configuration plus precomputed `WEEKEND` gap factors. Seeds `["asset", ticker]`. Zero-copy,
/// size [`AssetConfig::SIZE`].
///
/// `gap_factors[j] = gap_factor(z_joint[j][joint_column], σ, d, κ)` (risk-core, WAD, rounded down) converted to Q64.64
/// rounded down. Computed on-chain by `compute_gap_factors` from the finalised joint set, never uploaded. Any change of
/// σ, d, κ or the joint set clears `gf_count`, and `buy_cover` refuses the asset until all K are recomputed.
#[account(zero_copy)]
#[repr(C)]
pub struct AssetConfig {
    /// σ for `WEEKEND` closures, WAD.
    pub sigma_wad: u64,
    /// Known dividend inside the closure, fraction of price, WAD.
    pub dividend_wad: u64,
    /// σ, d, κ used for the stored gap factors (detects stale factors).
    pub gf_sigma_wad: u64,
    pub gf_dividend_wad: u64,
    pub gf_kappa_wad: u64,
    /// Settlement price source (`oracle::source`: 0 = EQUITY × multiplier, 1 = XSTOCK push, 2 = Kamino's SCOPE),
    /// widened to keep the zero-copy layout 8-byte aligned.
    pub settle_source: u64,
    /// The asset's chain in Kamino's Scope `OraclePrices` (SCOPE source): SPYx 344, QQQx 347, NVDAx 332.
    pub scope_chain: u64,
    /// σ_b: standard deviation of the weekend fair value against the open, as a return, WAD (basis study,
    /// `data/shield-basis.json`). Prices the shield loading.
    pub basis_sigma_wad: u64,
    /// The lender this asset's policies cover (W12): [`lender::KAMINO`] or [`lender::JUPITER`]. A Jupiter Lend alias asset
    /// (ticker `<T>.J`) carries the same scenarios and joint column as `<T>`, so both lenders' policies net in one loss
    /// vector, and settles on Jupiter's own oracle (settle source `JUPITER`).
    pub lender: u64,
    pub ticker: [u8; 8],
    /// xStock mint (Token-2022, 8 decimals).
    pub mint: Pubkey,
    /// Pyth feed ids: `Equity.US.<T>/USD`, `Crypto.<T>X/USD`, `Crypto.<T>X/<T>.RR`.
    pub feed_equity: [u8; 32],
    pub feed_xstock: [u8; 32],
    pub feed_redemption: [u8; 32],
    /// Kamino reserves for this mint: xStocks Market, Sentora xStocks Market (default = not listed).
    pub kamino_reserves: [Pubkey; 2],
    /// Jupiter Lend (`lender == JUPITER`): the Chainlink Data Streams cache its vaults price this xStock with, and its
    /// USDC vault's `VaultConfig` (default otherwise).
    pub lender_oracle: Pubkey,
    pub lender_vault: Pubkey,
    /// `WEEKEND` scenario set and the joint set the gap factors were computed from.
    pub scenario_set: Pubkey,
    pub joint_set: Pubkey,
    /// Hash of the joint set the stored gap factors came from.
    pub gf_joint_hash: [u8; 32],
    /// Number of valid gap factors (computed in chunks; must reach K before sales).
    pub gf_count: u16,
    /// Column of this asset in the joint set.
    pub joint_column: u8,
    pub enabled: u8,
    pub bump: u8,
    /// 1 when the asset has an earnings calendar with a bump above 1× and at least one release (`set_earnings`, W11):
    /// cover that prices without the bump (`buy_cover_multi`, `buy_cover_jl`) is then refused (audit A-63).
    pub earnings: u8,
    /// The earnings calendar PDA's bump (a single `create_program_address` in `closure_terms`).
    pub earnings_bump: u8,
    pub _pad: [u8; 1],
    /// Q64.64 gap factors, one per joint scenario.
    pub gap_factors: [[u8; 16]; K],
}
impl AssetConfig {
    pub const SIZE: usize = 8 + core::mem::size_of::<Self>();

    pub fn gap_factor_q64(&self, j: usize) -> u128 {
        u128::from_le_bytes(self.gap_factors[j])
    }
    pub fn gap_factors_ready(&self) -> bool {
        self.gf_count as usize == K
    }
}

/// Sorted standardised gaps for one asset and closure type. Seeds `["scen", ticker, [closure_type]]`. Zero-copy,
/// size [`ScenarioSet::SIZE`]. Written in chunks, then `finalize` checks the sort and the SHA-256 of `z` (little-endian
/// i16) against the hash of the generated file (task 1.5).
#[account(zero_copy)]
#[repr(C)]
pub struct ScenarioSet {
    pub hash: [u8; 32],
    pub ticker: [u8; 8],
    pub n: u16,
    pub closure_type: u8,
    pub finalized: u8,
    pub bump: u8,
    pub _pad: [u8; 3],
    /// σ of this closure type for the asset, WAD (W11). The WEEKEND set prices on `AssetConfig::sigma_wad` (which its
    /// gap factors are computed from); OVERNIGHT and HOLIDAY_WEEKEND sets price on this (`set_scenario_sigma`).
    pub sigma_wad: u64,
    /// Ascending; only `z[..n]` is meaningful.
    pub z: [i16; N_SCEN],
}
impl ScenarioSet {
    pub const SIZE: usize = 8 + core::mem::size_of::<Self>();
}

/// Earnings releases of an asset (W11, admin-set). Seeds `["earnings", ticker]`. A closure that contains one prices
/// with σ × `bump_wad` (premium and capacity). Unused slots are 0.
#[account]
#[derive(InitSpace)]
pub struct EarningsCalendar {
    pub ticker: [u8; 8],
    /// σ multiplier for a closure containing a release, WAD (1× to 8×, `set_earnings`).
    pub bump_wad: u64,
    /// Release times (Unix seconds); a release at `t` is in the closure `(close, open]`.
    pub releases: [i64; 32],
    pub bump: u8,
}
impl EarningsCalendar {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    /// The σ multiplier for the closure `(close, open]`: `bump_wad` if a release falls in it, else 1 (WAD).
    pub fn multiplier(&self, close: i64, open: i64) -> u64 {
        if self.releases.iter().any(|t| *t > close && *t <= open) { self.bump_wad } else { crate::math::WAD as u64 }
    }
}

/// K joint stress weekends across listed assets. Seeds `["joint", version_le_bytes]`. Zero-copy, size
/// [`JointSet::SIZE`]. Column `a` holds asset `tickers[a]`. Same chunked write + hash finalise as `ScenarioSet`; the
/// hash covers `z[..n_assets]` column by column.
#[account(zero_copy)]
#[repr(C)]
pub struct JointSet {
    pub hash: [u8; 32],
    pub version: u32,
    pub k: u16,
    pub n_assets: u8,
    pub finalized: u8,
    pub bump: u8,
    pub _pad: [u8; 7],
    pub tickers: [Ticker; MAX_JOINT_ASSETS],
    pub z: [[i16; K]; MAX_JOINT_ASSETS],
}
impl JointSet {
    pub const SIZE: usize = 8 + core::mem::size_of::<Self>();
}

/// Maximum regular sessions in a `Calendar` (about 14 months of NYSE sessions).
pub const N_SESSIONS: usize = 300;

/// One regular session. `date` is the US/Eastern date as `yyyymmdd`; `open` and `close` are Unix seconds (UTC).
#[zero_copy]
#[derive(Debug, PartialEq, Eq)]
#[repr(C)]
pub struct Session {
    pub date: u32,
    pub _pad: u32,
    pub open: i64,
    pub close: i64,
}

/// Instruction argument form of [`Session`] (20 bytes in borsh, no padding).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionArg {
    pub date: u32,
    pub open: i64,
    pub close: i64,
}
impl From<SessionArg> for Session {
    fn from(a: SessionArg) -> Self {
        Session { date: a.date, _pad: 0, open: a.open, close: a.close }
    }
}

/// Regular sessions of a venue, ascending. Seeds `["calendar", venue8]` (`XNYS\0\0\0\0`). Zero-copy, size
/// [`Calendar::SIZE`]. Generated from the Pyth `Equity.US` schedule string (`scripts/src/gen-calendar.ts`), uploaded in
/// chunks and finalised with the SHA-256 over `date u32 ‖ open i64 ‖ close i64` (little-endian) of each session.
#[account(zero_copy)]
#[repr(C)]
pub struct Calendar {
    pub hash: [u8; 32],
    pub venue: [u8; 8],
    pub n: u16,
    pub finalized: u8,
    pub bump: u8,
    pub _pad: [u8; 4],
    pub sessions: [Session; N_SESSIONS],
}
impl Calendar {
    pub const SIZE: usize = 8 + core::mem::size_of::<Self>();
}

/// Epoch states.
pub mod epoch_state {
    /// Created; sales open between `sale_open` and `bell`.
    pub const OPEN: u8 = 0;
    /// Friday close stored.
    pub const CLOSED: u8 = 1;
    /// Settlement price stored; policies can settle.
    pub const SETTLED: u8 = 2;
    /// Asset halted at the open; waiting for a valid window.
    pub const HALTED: u8 = 3;
    /// The Friday close was never stored (`void_epoch`, `VOID_AFTER` past the close); premiums are refunded.
    pub const VOIDED: u8 = 4;
}

/// One closure for one asset. Seeds `["epoch", ticker, closure_id_le_bytes]`. Size [`Epoch::SIZE`].
///
/// `closure_id` is the US/Eastern calendar date of the closing session as `yyyymmdd` (e.g. 20261009 for the weekend
/// starting Friday Oct 9, 2026). All assets' epochs for one weekend share it, which is also the `LossVector` group.
#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub ticker: [u8; 8],
    pub closure_id: u32,
    pub closure_type: u8,
    pub state: u8,
    pub bump: u8,
    /// Unix seconds (UTC).
    pub sale_open: i64,
    pub bell: i64,
    pub close: i64,
    pub open: i64,
    pub settle_after: i64,
    /// When `post_settlement` stored the settlement price (0 before). `settle_policy_to_wallet` waits `SETTLE_GRACE`
    /// after it.
    pub settled_at: i64,
    /// Friday close per raw xStock token unit at the close, WAD USD (share price × multiplier).
    pub close_price_wad: u128,
    /// Scaled UI multiplier (or Pyth redemption rate) at the close, WAD.
    pub close_multiplier_wad: u128,
    /// Opening price per raw xStock token unit, WAD USD.
    pub settle_price_wad: u128,
    pub settle_multiplier_wad: u128,
    pub policy_count: u32,
    pub policies_settled: u32,
    /// Sum of policies' `max_payout`, USDC.
    pub total_max_payout: u64,
    /// Sum of policies' worst joint-scenario loss, USDC (concentration cap; conservative upper bound).
    pub worst_loss_sum: u64,
    pub total_premium: u64,
    pub total_payout: u64,
    /// `oracle::source` of the stored close. Settlement (and halting) uses this source, not the asset's current one: the
    /// payout is settle / close, so both must come from one source.
    pub close_source: u8,
}
impl Epoch {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

/// The underwriter vault. Seeds `["vault"]`; it is also the authority of the USDC token account (`["vault_usdc"]`), the
/// LP share mint (`["shares"]`) and the share escrow of queued withdrawals (`["share_escrow"]`). Size [`Vault::SIZE`].
///
/// Accounting (all USDC base units). The token balance of `usdc` is at least
/// `equity + premiums_unearned + queued_deposits`; anything above that (a direct transfer, a "donation") is ignored:
/// share prices use `equity`, never the token balance.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// USDC token account owned by this PDA (SPL Token).
    pub usdc: Pubkey,
    /// LP share mint (SPL Token, 6 decimals), authority this PDA.
    pub share_mint: Pubkey,
    /// Protocol fee destination (USDC token account, any owner), set at init.
    pub fee_account: Pubkey,
    /// Share token account owned by this PDA holding the shares of queued withdrawals until they are paid and burned,
    /// and the first deposit's `math::LOCKED_SHARES`, which are never redeemed.
    pub share_escrow: Pubkey,
    /// LP equity backing cover (excludes unearned premiums and queued deposits). NAV per share = equity / supply.
    pub equity: u64,
    /// Σ over live groups of `LossVector.max_loss` (INV-2: ≤ u_max × equity at every policy write).
    pub reserved_total: u64,
    /// Premiums (net of fee) of live groups, released to `equity` when the group's last policy settles.
    pub premiums_unearned: u64,
    /// Queued deposits (USDC held, not yet equity) and withdrawals (shares held in escrow), applied after every group
    /// live when they were requested has settled (INV-5, INV-6).
    pub queued_deposits: u64,
    pub queued_withdraw_shares: u64,
    /// Lifetime totals (display).
    pub total_premiums: u64,
    pub total_payouts: u64,
    /// Groups (closure ids) with policies not yet all settled, and the most recent group that took a policy.
    pub live_groups: u32,
    pub latest_group: u32,
    /// The live groups' ids (0 = free slot); `live_groups` of them are non-zero.
    pub live: [u32; MAX_LIVE_GROUPS],
    pub bump: u8,
    pub usdc_bump: u8,
    pub mint_bump: u8,
    pub escrow_bump: u8,
    /// Monday Backstop inventory (W2), one slot per xStock held. Bought with vault cash; `equity` is unchanged by a
    /// purchase (cash became inventory at cost) and moves by the realised P&L at each sale. Share prices use
    /// [`Vault::nav`]; capacity for cover uses [`Vault::cover_equity`] (inventory never backs cover).
    pub inv: [InvSlot; MAX_INV],
    /// Yield vault (W3): surplus cash over the buffer is lent to this klend USDC reserve (xStocks Market); the vault
    /// holds its cTokens (kUSDC) in `kusdc` (the vault PDA's ATA). `lent_value` is the position's value at its last
    /// recognition, inside `equity`; yield enters equity only at `rebalance` (INV-5). `cash_headroom_wad` of cover
    /// equity is kept in cash on top of the buffer, for cover sold between rebalances.
    pub yield_reserve: Pubkey,
    pub kusdc: Pubkey,
    pub lent_ctokens: u64,
    pub lent_value: u64,
    pub lent_valued_at: i64,
    pub yield_recognized: i64,
    pub cash_headroom_wad: u64,
    /// Σ shield advances of live groups (each `LossVector.advanced`): already paid from cash out of the groups'
    /// reservations, so INV-13 does not keep them in cash twice (audit A-34).
    pub advanced_live: u64,
    /// W4: the vault PDA's PYUSD account (Token-2022 ATA) and what live PYUSD policies need from it: Σ worst loss less
    /// Σ advances already paid (INV-14: the sleeve holds at least that).
    pub pyusd_sleeve: Pubkey,
    pub pyusd_reserved: u64,
    pub pyusd_advanced: u64,
}

/// One xStock held by the backstop, as the vault books it.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InvSlot {
    /// Zero = a free slot.
    pub ticker: [u8; 8],
    /// Cost basis of the units held, USDC.
    pub cost: u64,
    /// NAV mark: `held × Scope × (1 − haircut)`, rounded DOWN, as of `marked_at` (prices redemptions).
    pub mark: u64,
    /// `held × Scope`, rounded UP, at the same time (prices deposits, audit A-36).
    pub value: u64,
    pub marked_at: i64,
}
impl Vault {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    /// Records `group` as live (its first policy). Fails when `MAX_LIVE_GROUPS` groups are already live.
    pub fn add_live(&mut self, group: u32) -> Result<()> {
        let slot = self.live.iter_mut().find(|g| **g == 0).ok_or(crate::CoreError::TooManyLiveGroups)?;
        *slot = group;
        self.live_groups = self.live_groups.checked_add(1).ok_or(crate::CoreError::Math)?;
        Ok(())
    }

    /// Removes `group` (its last policy finished).
    pub fn remove_live(&mut self, group: u32) -> Result<()> {
        let slot = self.live.iter_mut().find(|g| **g == group).ok_or(crate::CoreError::Math)?;
        *slot = 0;
        self.live_groups = self.live_groups.checked_sub(1).ok_or(crate::CoreError::Math)?;
        Ok(())
    }

    /// The newest live group, 0 if none: what a queue request made now waits for.
    pub fn newest_live(&self) -> u32 {
        self.live.iter().copied().max().unwrap_or(0)
    }

    /// True while any group up to and including `group` is live (a ticket waiting for `group` is not ready).
    pub fn live_through(&self, group: u32) -> bool {
        self.live.iter().any(|g| *g != 0 && *g <= group)
    }

    /// Σ cost basis of the backstop's inventory, USDC.
    pub fn inventory_cost(&self) -> Result<u64> {
        self.inv.iter().try_fold(0u64, |a, s| a.checked_add(s.cost)).ok_or_else(|| error!(crate::CoreError::Math))
    }

    /// Equity that may back cover (INV-2, INV-13): book equity less the inventory's cost. Inventory is not cash and is
    /// never counted on to pay a claim.
    pub fn cover_equity(&self) -> Result<u64> {
        self.equity.checked_sub(self.inventory_cost()?).ok_or_else(|| error!(crate::CoreError::Math))
    }

    /// NAV for share prices: `equity − Σ cost + Σ mark`, every held slot's mark at most [`MARK_MAX_AGE_SECS`] old (W2).
    /// Without inventory it is `equity`. The mark is Scope × (1 − haircut), rounded down, so NAV never counts the
    /// inventory above what a haircut sale would fetch.
    pub fn nav(&self, now: i64) -> Result<u64> {
        // The lending position is inside equity at its last valuation; share prices need it recent (W3).
        require!(
            self.lent_ctokens == 0 || now.saturating_sub(self.lent_valued_at) <= MARK_MAX_AGE_SECS,
            crate::CoreError::StaleYieldValuation
        );
        let mut nav = self.equity;
        for s in self.inv.iter().filter(|s| s.ticker != [0; 8] && (s.cost > 0 || s.mark > 0)) {
            require!(now.saturating_sub(s.marked_at) <= MARK_MAX_AGE_SECS, crate::CoreError::StaleInventoryMark);
            nav = nav.checked_sub(s.cost).and_then(|x| x.checked_add(s.mark)).ok_or(crate::CoreError::Math)?;
        }
        Ok(nav)
    }

    /// NAV without the freshness checks (for sizing the cash buffer, never for share prices).
    pub fn nav_unchecked(&self) -> Result<u64> {
        let mut nav = self.equity;
        for s in self.inv.iter().filter(|s| s.ticker != [0; 8]) {
            nav = nav.checked_sub(s.cost).and_then(|x| x.checked_add(s.mark)).ok_or(crate::CoreError::Math)?;
        }
        Ok(nav)
    }

    /// NAV for a deposit: like [`Vault::nav`] but inventory at its full Scope value (rounded up), never the haircut mark,
    /// so a depositor never buys shares below the inventory's value (audit A-36). The haircut stays on redemptions.
    pub fn nav_for_deposit(&self, now: i64) -> Result<u64> {
        let haircut = self.nav(now)?; // freshness checks
        let mut adj = haircut;
        for s in self.inv.iter().filter(|s| s.ticker != [0; 8] && (s.cost > 0 || s.mark > 0)) {
            adj = adj.checked_sub(s.mark).and_then(|x| x.checked_add(s.value.max(s.mark))).ok_or(crate::CoreError::Math)?;
        }
        Ok(adj)
    }

    /// The slot of `ticker`, taking a free one if it has none.
    pub fn inv_slot(&mut self, ticker: &[u8; 8]) -> Result<&mut InvSlot> {
        let i = match self.inv.iter().position(|s| s.ticker == *ticker) {
            Some(i) => i,
            None => self.inv.iter().position(|s| s.ticker == [0; 8]).ok_or(crate::CoreError::TooManyInventories)?,
        };
        self.inv[i].ticker = *ticker;
        Ok(&mut self.inv[i])
    }

    /// Cash the vault must keep for live cover groups and queues (INV-13): every group's reserved worst-case loss less
    /// the shield advances already paid out of it (A-34), the premiums that a void would refund, and queued deposits (the
    /// depositors' money).
    pub fn reserved_cash(&self) -> Result<u64> {
        self.reserved_total
            .checked_sub(self.advanced_live)
            .and_then(|x| x.checked_add(self.premiums_unearned))
            .and_then(|x| x.checked_add(self.queued_deposits))
            .ok_or_else(|| error!(crate::CoreError::Math))
    }
}

/// Monday Backstop parameters and totals (W2). Seeds `["backstop"]`. Size [`BackstopPool::SIZE`].
///
/// The pool is a capped share of the vault: it spends vault cash (never the cash INV-13 keeps for live cover groups
/// and queues), and its open inventory at cost never exceeds `max_share × equity`.
#[account]
#[derive(InitSpace)]
pub struct BackstopPool {
    /// Open inventory at cost ≤ max_share × equity, WAD.
    pub max_share_wad: u64,
    /// NAV mark haircut on Scope, WAD.
    pub haircut_wad: u64,
    /// κ: INV-8's committed price is Scope × (1 − κ); a liquidation that delivers more than its payment buys at that
    /// price fails. WAD.
    pub max_discount_wad: u64,
    /// Dutch auction: starts at Scope × (1 + p0), decays to Scope × (1 − d_max) over `sale_secs`. WAD, WAD, seconds.
    pub sale_premium_wad: u64,
    pub sale_discount_wad: u64,
    pub sale_secs: u32,
    /// Oldest Scope price a backstop instruction accepts, seconds.
    pub max_price_age_secs: u32,
    /// Lifetime totals: USDC spent on liquidations, raw units received, USDC from sales, realised P&L (signed).
    pub spent: u64,
    pub sales_proceeds: u64,
    pub realized_pnl: i64,
    pub liquidations: u32,
    pub fills: u32,
    pub bump: u8,
}
impl BackstopPool {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

/// One xStock's backstop inventory and its Dutch auction (W2). Seeds `["inventory", ticker]`. Size [`Inventory::SIZE`].
///
/// The units sit in the vault PDA's associated token account for the mint (Token-2022); a liquidation's cTokens pass
/// through the vault PDA's cToken ATA and are redeemed in the same instruction. `qty` is the inventory's book, the
/// token balance can only be higher (someone sent tokens), never used.
#[account]
#[derive(InitSpace)]
pub struct Inventory {
    pub ticker: [u8; 8],
    pub mint: Pubkey,
    /// The vault PDA's ATA for `mint` (Token-2022), and its cToken ATA for the reserve given at init (SPL Token).
    /// `ctokens` is informational since audit A-35: a liquidation uses the vault's ATA for its own withdraw reserve's
    /// cToken mint, so obligations of either xStocks market can be liquidated.
    pub tokens: Pubkey,
    pub ctokens: Pubkey,
    /// Units held (raw) and their cost basis (USDC).
    pub qty: u64,
    pub cost: u64,
    /// Sale state: 1 while a lot is on sale.
    pub sale_active: u8,
    pub bump: u8,
    /// Units still offered in the current sale (≤ qty).
    pub lot_left: u64,
    /// Price per whole token, WAD USD (Scope basis): start and floor of the decay, fixed at `start_sale`.
    pub start_price_wad: u128,
    pub floor_price_wad: u128,
    pub sale_started_at: i64,
    pub sale_secs: u32,
    /// Lifetime per asset: units bought, units sold.
    pub bought: u64,
    pub sold: u64,
}
impl Inventory {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

/// Queue kinds.
pub mod ticket_kind {
    pub const DEPOSIT: u8 = 0;
    pub const WITHDRAW: u8 = 1;
}

/// A queued deposit (USDC held in the vault) or withdrawal (shares held in escrow). Seeds `["dep" | "wd", owner,
/// wait_group_le_bytes]`; repeated requests for the same wait group add up. Processed (and closed, rent to the owner)
/// once no group up to `wait_group` is live, at the NAV of that moment. Size [`QueueTicket::SIZE`].
#[account]
#[derive(InitSpace)]
pub struct QueueTicket {
    pub owner: Pubkey,
    /// The newest group live at the request (0 = none): every group up to it must have settled.
    pub wait_group: u32,
    pub kind: u8,
    pub bump: u8,
    /// USDC base units (deposit) or shares (withdrawal).
    pub amount: u64,
    pub requested_at: i64,
}
impl QueueTicket {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

/// Aggregate loss per joint scenario for one group (one weekend across all assets). Seeds `["loss", group_le_bytes]`.
/// Zero-copy, size [`LossVector::SIZE`].
#[account(zero_copy)]
#[repr(C)]
pub struct LossVector {
    /// Σ over policies of loss_j, USDC, rounded up per policy.
    pub losses: [u64; K],
    /// max_j losses[j], kept current on every write.
    pub max_loss: u64,
    /// Premiums of this group's policies net of fee, USDC (moved from `premiums_unearned` to `equity` at the end).
    pub premiums: u64,
    /// Σ Liquidation Shield advances of this group's policies, USDC (W1). Never above `max_loss`, the worst-case loss
    /// the capacity check reserved for the group (INV-12, audit A-32).
    pub advanced: u64,
    pub group: u32,
    pub policy_count: u32,
    pub policies_settled: u32,
    /// 1 once every policy of the group settled; capacity and premiums released.
    pub settled: u8,
    pub bump: u8,
    pub _pad: [u8; 2],
}
impl LossVector {
    pub const SIZE: usize = 8 + core::mem::size_of::<Self>();
}

/// Policy sides. Phase 1: `DOWN` only.
/// Lenders whose positions are covered (W12).
pub mod lender {
    pub const KAMINO: u8 = 0;
    pub const JUPITER: u8 = 1;
}

pub mod side {
    pub const DOWN: u8 = 0;
    pub const UP: u8 = 1;
}

/// Policy states.
pub mod policy_state {
    pub const ACTIVE: u8 = 0;
    pub const SETTLED: u8 = 1;
    /// Epoch voided; the net premium went back to the owner (`refund_policy`). For a book leg (C2): finished unpaid
    /// (`close_out_book_leg`), its premium share refunded to the payer.
    pub const REFUNDED: u8 = 2;
}

/// Book states (C2).
pub mod book_state {
    /// Legs are being added; nothing paid yet but the escrow.
    pub const OPEN: u8 = 0;
    /// Premium paid; legs are cover.
    pub const SEALED: u8 = 1;
    /// Not sealed before `expires_at`: legs are voided one by one (`void_book_leg`), the escrow goes back.
    pub const VOIDED: u8 = 2;
}

/// A curator book (C2, W5): a payer covers positions it does not own. Seeds `["book", payer, closure_id_u32_le,
/// book_id_u32_le]`. Zero-copy (its own K-scenario payout loss vector), size [`Book::SIZE`]. Each leg is a `Policy` at
/// the usual `["policy", epoch, obligation]` PDA with `book` = this account (A-01: one cover per position per closure).
///
/// Money: `escrowed` USDC sits in the escrow token account `["book_escrow", book]` until `seal_book`; then `premium` is
/// paid (net to the vault, `fee` to the fee account) and the escrow's rest goes back. Refunds (a released or unpaid
/// leg's share of the net premium) accrue in `refund_owed` and are paid by `claim_book_refund`, so no other path ever
/// touches the payer's token account. INV-15: `refunded + refund_owed ≤ premium − fee`.
#[account(zero_copy)]
#[repr(C)]
pub struct Book {
    /// Σ legs' capped payout loss per joint scenario (priced debt), USDC: the book's own distribution (ES_J).
    pub losses: [u64; K],
    pub payer: Pubkey,
    /// Where refunds and the escrow's rest go (the payer's USDC account at `open_book`).
    pub payer_usdc: Pubkey,
    pub escrow: Pubkey,
    pub created_at: i64,
    /// `min(bell, created_at + BOOK_TTL_SECS)`: an OPEN book after this is voided.
    pub expires_at: i64,
    /// Σ E_i, Σ ES_i, max ES_i, Σ loading_i of the live legs (`risk-core::BookSums`).
    pub sum_e: u64,
    pub sum_es: u64,
    pub es_max: u64,
    pub sum_loading: u64,
    /// Σ w_i of the live legs; fixed into `w_seal` at seal (refund shares divide by it).
    pub sum_w: u64,
    pub w_seal: u64,
    /// Σ worst_loss of the live legs (INV-16: the book's advances never exceed it).
    pub sum_worst: u64,
    /// USDC moved into the escrow so far.
    pub escrowed: u64,
    /// Premium paid at seal (fee included), the fee, and the utilisation it was priced at.
    pub premium: u64,
    pub fee: u64,
    pub util_wad: u64,
    pub refund_owed: u64,
    pub refunded: u64,
    /// Shield advances and settlement payouts into the legs' positions.
    pub advanced: u64,
    pub paid_out: u64,
    pub closure_id: u32,
    pub book_id: u32,
    pub legs_added: u32,
    /// Legs still the book's (added − released − voided).
    pub legs_live: u32,
    /// Legs finished: settled, closed out unpaid, released or voided. The book is done at `legs_done == legs_added`.
    pub legs_done: u32,
    pub state: u8,
    pub bump: u8,
    pub escrow_bump: u8,
    pub _pad: [u8; 1],
}
impl Book {
    pub const SIZE: usize = 8 + core::mem::size_of::<Self>();
}

/// One cover policy. Seeds `["policy", epoch, obligation]`: one policy per obligation per weekend, whoever owns it (klend
/// lets an obligation change owner, so the owner must not be part of the seeds). Wallet-only cover (Phase 2) needs its
/// own seeds.
/// Size [`Policy::SIZE`]. Everything that determines the payout is fixed at purchase.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub owner: Pubkey,
    pub obligation: Pubkey,
    /// The obligation's USDC borrow reserve at purchase. Settlement repays into the obligation only while this reserve
    /// is still one of its borrows with a non-zero amount; otherwise the payout goes to the owner's wallet.
    pub borrow_reserve: Pubkey,
    pub epoch: Pubkey,
    pub ticker: [u8; 8],
    pub side: u8,
    pub state: u8,
    pub bump: u8,
    /// Covered xStock's market value at purchase, USDC (informational).
    pub collateral_value: u64,
    /// C′ = LT × collateral value in USDC at purchase (klend's unhealthy borrow value); the payout uses this.
    pub covered_value: u64,
    /// Debt at purchase, USDC.
    pub debt: u64,
    /// Liquidation threshold at purchase, WAD.
    pub liquidation_threshold_wad: u64,
    /// Hard cap (INV-1), USDC.
    pub max_payout: u64,
    /// Premium paid, fee included, USDC.
    pub premium: u64,
    /// Protocol fee part of `premium` (sent to the fee account), USDC. A void refunds `premium − fee`.
    pub fee: u64,
    /// max_j loss_j, USDC.
    pub worst_loss: u64,
    /// Total paid out on this policy: shield advances plus the settlement remainder, USDC.
    pub payout: u64,
    pub created_at: i64,
    /// Liquidation Shield advances repaid into the obligation so far, USDC (INV-9: ≤ α × max_payout). Settlement pays
    /// `max(0, payout rule − advanced)`; an advance above the payout rule is the vault's loss.
    pub advanced: u64,
    /// Time of the last advance (0 = none).
    pub advanced_at: i64,
    /// Shield loading part of `premium`, USDC.
    pub shield_loading: u64,
    /// The borrow reserve's cumulative borrow-rate index at purchase (klend U68F60): interest on `debt` since then is
    /// `debt × (index now / this − 1)` (task 1.2).
    pub borrow_index_bsf: u128,
    /// `Config.debt_growth_cap_wad` at purchase: the most interest the shield and settlement count (fixed at purchase).
    pub debt_growth_cap_wad: u64,
    /// W4 multi-collateral: 0 for a Phase 1 policy (one xStock, `covered_value`); else the number of xStock legs, each
    /// with its ticker and covered value `C′_i = LT_i × C_i` (debt units), and the stablecoin collateral `S′`. The
    /// policy's `epoch` is leg 0's; the other legs' epochs are the same group's. `covered_value` = Σ C′_i + S′.
    pub n_legs: u8,
    /// Leg tickers, 8 bytes each (flat: Anchor's InitSpace does not size nested arrays).
    pub leg_tickers: [u8; 8 * MAX_LEGS],
    pub leg_covered: [u64; MAX_LEGS],
    pub stable_covered: u64,
    /// The debt's mint: USDC, or PYUSD (Sentora); the payout is in it. Default = USDC (Phase 1 policies).
    pub borrow_mint: Pubkey,
    /// [`lender::KAMINO`] (`obligation` a klend obligation, `borrow_reserve` its reserve) or [`lender::JUPITER`]
    /// (`obligation` a Jupiter Lend `Position`, `borrow_reserve` its `VaultConfig`; `borrow_index_bsf` the vault's
    /// borrow exchange price at purchase). W12.
    pub lender: u8,
    /// C2: the `Book` this policy is a leg of; default = an owner's policy. A leg's `owner` is the default key: no path
    /// pays a leg to a wallet (INV-7, INV-11).
    pub book: Pubkey,
    /// C2: who paid this account's rent and gets it back when a leg is released, voided or closed (default = the owner).
    pub rent_payer: Pubkey,
    /// C2: the leg's standalone E[L] and ES_β (USDC, rounded UP; `risk-core::book`) and its refund weight
    /// `w = max(1, (1 + θ)E + cτ·ES + loading)`.
    pub leg_e: u64,
    pub leg_es: u64,
    pub leg_w: u64,
    /// C2: SHA-256 of the leg's reserved loss vector (K × u64 LE) as added to the group: a release or void subtracts the
    /// recomputed vector only when it hashes the same (the gap factors did not change since); otherwise the reservation
    /// stays (over-reserved, safe).
    pub leg_loss_hash: [u8; 32],
}
impl Policy {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    /// D1: the user of a weekend-safe market account whose policy this is (`owner` is the program's `["wsm", user]` PDA,
    /// `rent_payer` carries the user; an owner policy has neither a book nor a `rent_payer`). Anything paid "to the
    /// owner" must go to `["wsm_usdc", user]`, the one account the user can claim from (audit A-190).
    pub fn wsm_user(&self) -> Option<Pubkey> {
        (self.book == Pubkey::default() && self.rent_payer != Pubkey::default()).then_some(self.rent_payer)
    }

    /// True when `dest` is where a payout or refund to this policy's owner may go: the owner's own token account for an
    /// owner policy, the claimable `["wsm_usdc", user]` account for a weekend-safe market policy.
    pub fn payout_destination_ok(&self, dest: &Pubkey) -> bool {
        match self.wsm_user() {
            Some(user) => *dest == Pubkey::find_program_address(&[b"wsm_usdc", user.as_ref()], &crate::ID).0,
            None => true,
        }
    }

    /// Leg `i`'s ticker (W4).
    pub fn leg_ticker(&self, i: usize) -> Ticker {
        let mut t = [0u8; 8];
        t.copy_from_slice(&self.leg_tickers[8 * i..8 * i + 8]);
        t
    }
}

/// `GapFeed.flags` (C3). Blocking flags mean a number in the feed must not be used; informational ones qualify it.
pub mod feed_flag {
    /// Fair-value (Pyth push) account empty.
    pub const MISSING_FAIR: u32 = 1 << 0;
    /// Lender price account empty, or its entry unset.
    pub const MISSING_LENDER: u32 = 1 << 1;
    /// The closure's epoch is missing or its Friday close is not stored yet.
    pub const NO_CLOSE: u32 = 1 << 2;
    /// No finalised scenario set for the closure type.
    pub const NO_SCENARIOS: u32 = 1 << 3;
    /// Fair value older than `shield_max_age_secs` (or from the future).
    pub const STALE_FAIR: u32 = 1 << 4;
    /// `config.paused`.
    pub const PAUSED: u32 = 1 << 5;
    /// Fair value is not `Full`-verified.
    pub const FAIR_UNVERIFIED: u32 = 1 << 6;
    /// Fair value's confidence is wider than `max_conf_bps`.
    pub const FAIR_OUTSIDE_CONF: u32 = 1 << 7;
    /// Jupiter's cache is suspended.
    pub const LENDER_SUSPENDED: u32 = 1 << 8;
    /// Informational: after the close, the lender's price has not changed for `FROZEN_AFTER_SECS` as the cranks saw it (the
    /// point of the feed: the weekend move has not reached the lender).
    pub const LENDER_FROZEN: u32 = 1 << 16;
    /// Informational: the lender's price is older than `max_input_age_secs`.
    pub const LENDER_STALE: u32 = 1 << 17;
    /// Informational: the asset has an earnings bump; the feed's σ does not apply it (v1).
    pub const EARNINGS_ASSET: u32 = 1 << 18;
    pub const BLOCKING: u32 = 0xFFFF;
}

/// The Gap Oracle feed of one asset (C3). Seeds `["feed", ticker]`. Zero-copy, size [`GapFeed::SIZE`]. Written only by
/// `update_gap_feed` from addresses the program derives; a value is 0 when its flag says the input is missing.
/// WAD values are little-endian 16-byte fields (i128 for the implied gaps), read with the accessors.
#[account(zero_copy)]
#[repr(C)]
pub struct GapFeed {
    pub ticker: [u8; 8],
    /// Friday (or session) close of the closure and the next open, Unix seconds.
    pub close_ts: i64,
    pub next_open: i64,
    pub fair_publish_ts: i64,
    pub lender_ts: i64,
    /// When the lender's price last changed as the cranks saw it (a first sighting counts as a change): `LENDER_FROZEN`
    /// needs it unchanged for `FROZEN_AFTER_SECS`. Scope's own refresh time keeps advancing while its value is frozen.
    pub lender_since_ts: i64,
    pub last_update_ts: i64,
    pub last_update_slot: u64,
    pub updates: u64,
    /// σ of the closure type and P(gap < −5% / −8% / −12%), WAD (rounded up).
    pub sigma_wad: u64,
    pub p_lt_5_wad: u64,
    pub p_lt_8_wad: u64,
    pub p_lt_12_wad: u64,
    /// Per raw xStock token unit, WAD USD (the epoch's close and the two prices compared with it).
    pub close_price: [u8; 16],
    pub fair_price: [u8; 16],
    pub lender_price: [u8; 16],
    /// fair ÷ close − 1 and lender ÷ close − 1, signed WAD (i128).
    pub implied_gap_fair: [u8; 16],
    pub implied_gap_lender: [u8; 16],
    pub flags: u32,
    pub closure_id: u32,
    pub min_update_slots: u32,
    pub max_input_age_secs: u32,
    pub fair_conf_bps: u32,
    pub n_scen: u16,
    pub bump: u8,
    /// [`lender`]: which lender price the feed reads (Scope for Kamino, the Chainlink cache for Jupiter).
    pub lender: u8,
    pub closure_type: u8,
    pub close_source: u8,
    pub epoch_state: u8,
    pub fair_verification: u8,
    pub _pad: [u8; 4],
}
impl GapFeed {
    pub const SIZE: usize = 8 + core::mem::size_of::<Self>();
    pub fn close_price_wad(&self) -> u128 {
        u128::from_le_bytes(self.close_price)
    }
    pub fn fair_price_wad(&self) -> u128 {
        u128::from_le_bytes(self.fair_price)
    }
    pub fn lender_price_wad(&self) -> u128 {
        u128::from_le_bytes(self.lender_price)
    }
    pub fn implied_gap_fair_wad(&self) -> i128 {
        i128::from_le_bytes(self.implied_gap_fair)
    }
    pub fn implied_gap_lender_wad(&self) -> i128 {
        i128::from_le_bytes(self.implied_gap_lender)
    }
}
