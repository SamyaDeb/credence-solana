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
    /// Posts settlement prices and runs queues; anyone may settle policies.
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
    /// Reserved for Phase 2 fields (other closure types).
    pub _reserved: [u64; 2],
    pub ticker: [u8; 8],
    /// xStock mint (Token-2022, 8 decimals).
    pub mint: Pubkey,
    /// Pyth feed ids: `Equity.US.<T>/USD`, `Crypto.<T>X/USD`, `Crypto.<T>X/<T>.RR`.
    pub feed_equity: [u8; 32],
    pub feed_xstock: [u8; 32],
    pub feed_redemption: [u8; 32],
    /// Kamino reserves for this mint: xStocks Market, Sentora xStocks Market (default = not listed).
    pub kamino_reserves: [Pubkey; 2],
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
    pub _pad: [u8; 3],
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
    /// Ascending; only `z[..n]` is meaningful.
    pub z: [i16; N_SCEN],
}
impl ScenarioSet {
    pub const SIZE: usize = 8 + core::mem::size_of::<Self>();
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
    /// Share token account owned by this PDA holding the shares of queued withdrawals until they are paid and burned.
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
pub mod side {
    pub const DOWN: u8 = 0;
    pub const UP: u8 = 1;
}

/// Policy states.
pub mod policy_state {
    pub const ACTIVE: u8 = 0;
    pub const SETTLED: u8 = 1;
    /// Epoch voided; the net premium went back to the owner (`refund_policy`).
    pub const REFUNDED: u8 = 2;
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
    pub payout: u64,
    pub created_at: i64,
}
impl Policy {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}
