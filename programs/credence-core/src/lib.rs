//! Credence core program: Gap Cover, underwriter vault and gap oracle (Phase 1).
//!
//! All premium, loss and gap-factor math comes from `credence-risk-core`; this program only adapts it to
//! accounts. Overview and invariants: README.md.

use anchor_lang::prelude::*;

pub mod calendar;
pub mod instructions;
pub mod jupiter;
pub mod kamino;
pub mod math;
pub mod oracle;
pub mod pricing;
pub mod state;
pub mod token22;

pub use instructions::*;
pub use state::*;

declare_id!("xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q");

#[program]
pub mod credence_core {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, params: ConfigParams) -> Result<()> {
        instructions::admin::handle_init_config(ctx, params)
    }

    pub fn set_params(ctx: Context<SetParams>, params: ConfigParams) -> Result<()> {
        instructions::admin::handle_set_params(ctx, params)
    }

    /// Admin handover, step one (W6): the admin proposes the next admin (e.g. the multisig's vault).
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::handle_propose_admin(ctx, new_admin)
    }

    /// Admin handover, step two: the proposed admin accepts.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::handle_accept_admin(ctx)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::admin::handle_set_paused(ctx, paused)
    }

    pub fn add_asset(ctx: Context<AddAsset>, ticker: Ticker, params: AssetParams) -> Result<()> {
        instructions::admin::handle_add_asset(ctx, ticker, params)
    }

    pub fn update_asset(ctx: Context<UpdateAsset>, ticker: Ticker, params: AssetParams) -> Result<()> {
        instructions::admin::handle_update_asset(ctx, ticker, params)
    }

    pub fn init_scenario_set(ctx: Context<InitScenarioSet>, ticker: Ticker, closure_type: u8, n: u16) -> Result<()> {
        instructions::upload::handle_init_scenario_set(ctx, ticker, closure_type, n)
    }

    pub fn write_scenarios(ctx: Context<WriteScenarios>, offset: u16, values: Vec<i16>) -> Result<()> {
        instructions::upload::handle_write_scenarios(ctx, offset, values)
    }

    pub fn finalize_scenario_set(ctx: Context<FinalizeScenarioSet>, expected_hash: [u8; 32]) -> Result<()> {
        instructions::upload::handle_finalize_scenario_set(ctx, expected_hash)
    }

    pub fn init_joint_set(ctx: Context<InitJointSet>, version: u32, tickers: Vec<Ticker>) -> Result<()> {
        instructions::upload::handle_init_joint_set(ctx, version, tickers)
    }

    pub fn write_joint(ctx: Context<WriteJoint>, column: u8, offset: u16, values: Vec<i16>) -> Result<()> {
        instructions::upload::handle_write_joint(ctx, column, offset, values)
    }

    pub fn finalize_joint_set(ctx: Context<FinalizeJointSet>, expected_hash: [u8; 32]) -> Result<()> {
        instructions::upload::handle_finalize_joint_set(ctx, expected_hash)
    }

    pub fn compute_gap_factors(ctx: Context<ComputeGapFactors>, start: u16, count: u16) -> Result<()> {
        instructions::upload::handle_compute_gap_factors(ctx, start, count)
    }

    pub fn init_calendar(ctx: Context<InitCalendar>, venue: [u8; 8], n: u16) -> Result<()> {
        instructions::epoch::handle_init_calendar(ctx, venue, n)
    }

    pub fn write_calendar(ctx: Context<WriteCalendar>, offset: u16, sessions: Vec<SessionArg>) -> Result<()> {
        instructions::epoch::handle_write_calendar(ctx, offset, sessions)
    }

    pub fn finalize_calendar(ctx: Context<FinalizeCalendar>, expected_hash: [u8; 32]) -> Result<()> {
        instructions::epoch::handle_finalize_calendar(ctx, expected_hash)
    }

    pub fn open_group(ctx: Context<OpenGroup>, group: u32) -> Result<()> {
        instructions::epoch::handle_open_group(ctx, group)
    }

    pub fn open_epoch(ctx: Context<OpenEpoch>, ticker: Ticker, closure_id: u32) -> Result<()> {
        instructions::epoch::handle_open_epoch(ctx, ticker, closure_id)
    }

    /// Buys gap cover on the buyer's refreshed Kamino obligation (see `instructions::cover`).
    pub fn buy_cover(
        ctx: Context<BuyCover>,
        ticker: Ticker,
        closure_id: u32,
        max_payout: u64,
        max_premium: u64,
    ) -> Result<()> {
        instructions::cover::handle_buy_cover(ctx, ticker, closure_id, max_payout, max_premium)
    }

    /// Multi-collateral cover (W4): several xStock deposits and stablecoins, USDC or PYUSD debt (see
    /// `instructions::cover_multi` for the remaining accounts).
    pub fn buy_cover_multi<'info>(
        ctx: Context<'info, BuyCoverMulti<'info>>,
        closure_id: u32,
        max_payout: u64,
        max_premium: u64,
    ) -> Result<()> {
        instructions::cover_multi::handle_buy_cover_multi(ctx, closure_id, max_payout, max_premium)
    }

    /// Read-only multi-collateral quote (W4): per leg its asset and scenario set as remaining accounts.
    pub fn quote_cover_multi<'info>(
        ctx: Context<'info, QuoteCoverMulti<'info>>,
        legs: Vec<u64>,
        stable: u64,
        debt: u64,
        max_payout: u64,
    ) -> Result<Quote> {
        instructions::cover_multi::handle_quote_cover_multi(ctx, legs, stable, debt, max_payout)
    }

    /// The vault PDA's PYUSD ATA becomes the PYUSD sleeve (admin, W4).
    pub fn set_pyusd_sleeve(ctx: Context<SetPyusdSleeve>) -> Result<()> {
        instructions::sleeve::handle_set_pyusd_sleeve(ctx)
    }

    /// The keeper sells PYUSD (bought on Jupiter in its own transaction) to the vault's sleeve, at most at klend's
    /// PYUSD price plus the slippage bound (keeper, W4).
    pub fn fund_sleeve(ctx: Context<FundSleeve>, pyusd_in: u64, usdc_out: u64) -> Result<()> {
        instructions::sleeve::handle_fund_sleeve(ctx, pyusd_in, usdc_out)
    }

    /// The keeper buys surplus PYUSD back from the sleeve for USDC, at least at klend's price less the slippage bound;
    /// the sleeve keeps INV-14 (keeper, W4, audit A-46).
    pub fn drain_sleeve(ctx: Context<DrainSleeve>, pyusd_out: u64, usdc_in: u64) -> Result<()> {
        instructions::sleeve::handle_drain_sleeve(ctx, pyusd_out, usdc_in)
    }

    /// Makes an asset a Jupiter Lend asset: its USDC vault and the Chainlink cache its oracle reads (admin, W12).
    pub fn set_asset_lender(ctx: Context<SetAssetLender>, ticker: Ticker) -> Result<()> {
        instructions::jupiter_lend::handle_set_asset_lender(ctx, ticker)
    }

    /// Gap Cover on a Jupiter Lend position (W12): the buyer holds the position NFT.
    pub fn buy_cover_jl(ctx: Context<BuyCoverJl>, ticker: Ticker, closure_id: u32, max_payout: u64, max_premium: u64) -> Result<()> {
        instructions::jupiter_lend::handle_buy_cover_jl(ctx, ticker, closure_id, max_payout, max_premium)
    }

    /// Settles a Jupiter Lend policy into its position (operate CPI); `expected = u64::MAX` only returns the amount.
    pub fn settle_policy_jl<'info>(ctx: Context<'info, SettlePolicyJl<'info>>, expected: u64, indices: Vec<u8>) -> Result<()> {
        instructions::jupiter_lend::handle_settle_policy_jl(ctx, expected, indices)
    }

    /// The Liquidation Shield on a Jupiter Lend position (keeper); `expected = u64::MAX` only returns the amount.
    pub fn shield_advance_jl<'info>(ctx: Context<'info, ShieldAdvanceJl<'info>>, expected: u64, indices: Vec<u8>) -> Result<()> {
        instructions::jupiter_lend::handle_shield_advance_jl(ctx, expected, indices)
    }

    /// σ of a non-WEEKEND scenario set (admin, W11).
    pub fn set_scenario_sigma(ctx: Context<SetScenarioSigma>, sigma_wad: u64) -> Result<()> {
        instructions::upload::handle_set_scenario_sigma(ctx, sigma_wad)
    }

    /// An asset's earnings releases and σ bump (admin, W11).
    pub fn set_earnings(ctx: Context<SetEarnings>, ticker: Ticker, bump_wad: u64, releases: Vec<i64>) -> Result<()> {
        instructions::upload::handle_set_earnings(ctx, ticker, bump_wad, releases)
    }

    /// Gap Cover side UP on a Kamino short (an xStock borrowed against stablecoins; W11): paid in USDC to the wallet.
    pub fn buy_cover_up<'info>(ctx: Context<'info, BuyCoverUp<'info>>, ticker: Ticker, closure_id: u32, max_payout: u64, max_premium: u64) -> Result<()> {
        instructions::cover_up::handle_buy_cover_up(ctx, ticker, closure_id, max_payout, max_premium)
    }

    pub fn snapshot_close(ctx: Context<SnapshotClose>, ticker: Ticker, closure_id: u32) -> Result<()> {
        instructions::settlement::handle_snapshot_close(ctx, ticker, closure_id)
    }

    pub fn post_settlement<'info>(
        ctx: Context<'info, PostSettlement<'info>>,
        ticker: Ticker,
        closure_id: u32,
    ) -> Result<()> {
        instructions::settlement::handle_post_settlement(ctx, ticker, closure_id)
    }

    pub fn halt_epoch(ctx: Context<HaltEpoch>, ticker: Ticker, closure_id: u32) -> Result<()> {
        instructions::settlement::handle_halt_epoch(ctx, ticker, closure_id)
    }

    /// Pays one policy after its epoch settled: into the obligation (repay v2 CPI) while it has debt, rest to the owner.
    pub fn settle_policy<'info>(ctx: Context<'info, SettlePolicy<'info>>) -> Result<()> {
        instructions::settle::handle_settle_policy(ctx)
    }

    /// Liquidation Shield (W1): repays into a covered obligation before Kamino's pre-market move, sized from the
    /// weekend fair value (see `instructions::shield`). Keeper only.
    pub fn shield_advance<'info>(ctx: Context<'info, ShieldAdvance<'info>>) -> Result<()> {
        instructions::shield::handle_shield_advance(ctx)
    }
    /// Pays an active policy to the owner's wallet, `SETTLE_GRACE` after the settlement price, without calling klend.
    pub fn settle_policy_to_wallet(ctx: Context<SettlePolicyToWallet>) -> Result<()> {
        instructions::settle::handle_settle_policy_to_wallet(ctx)
    }

    /// Voids an epoch whose Friday close was never stored, `VOID_AFTER` past the close (anyone).
    pub fn void_epoch(ctx: Context<VoidEpoch>, ticker: Ticker, closure_id: u32) -> Result<()> {
        instructions::void::handle_void_epoch(ctx, ticker, closure_id)
    }

    /// Refunds one policy of a voided epoch (net premium to the owner) and releases the group like settlement (anyone).
    pub fn refund_policy<'info>(ctx: Context<'info, RefundPolicy<'info>>) -> Result<()> {
        instructions::void::handle_refund_policy(ctx)
    }

    pub fn init_vault(ctx: Context<InitVault>) -> Result<()> {
        instructions::vault::handle_init_vault(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::vault::handle_deposit(ctx, amount)
    }

    /// Queues a deposit until the groups live now have settled (task 3.1).
    pub fn request_deposit(ctx: Context<RequestDeposit>, amount: u64) -> Result<()> {
        instructions::vault::handle_request_deposit(ctx, amount)
    }

    /// Queues a withdrawal of LP shares until the groups live now have settled (task 3.1, INV-6).
    pub fn request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
        instructions::vault::handle_request_withdraw(ctx, shares)
    }

    /// Applies a queued deposit at the current NAV (anyone; keeper `process_queues`).
    pub fn process_deposit(ctx: Context<ProcessDeposit>) -> Result<()> {
        instructions::vault::handle_process_deposit(ctx)
    }

    /// Pays a queued withdrawal at the current NAV (anyone; keeper `process_queues`).
    pub fn process_withdrawal(ctx: Context<ProcessWithdrawal>) -> Result<()> {
        instructions::vault::handle_process_withdrawal(ctx)
    }

    /// Monday Backstop (W2): pool parameters (admin).
    pub fn init_backstop(ctx: Context<InitBackstop>, params: BackstopParams) -> Result<()> {
        instructions::backstop::handle_init_backstop(ctx, params)
    }

    pub fn set_backstop_params(ctx: Context<SetBackstopParams>, params: BackstopParams) -> Result<()> {
        instructions::backstop::handle_set_backstop_params(ctx, params)
    }

    /// One xStock's inventory, held in the vault PDA's ATAs (admin).
    pub fn init_inventory(ctx: Context<InitInventory>, ticker: Ticker) -> Result<()> {
        instructions::backstop::handle_init_inventory(ctx, ticker)
    }

    /// Liquidates an unhealthy Kamino obligation through the vault PDA (klend v2 CPI) and books the collateral as
    /// inventory (keeper; INV-8, INV-13).
    pub fn backstop_liquidate<'info>(
        ctx: Context<'info, BackstopLiquidate<'info>>,
        repay_amount: u64,
        min_received: u64,
    ) -> Result<()> {
        instructions::backstop::handle_backstop_liquidate(ctx, repay_amount, min_received)
    }

    /// Marks one xStock's inventory at Scope × (1 − haircut) for NAV (anyone).
    pub fn mark_inventory(ctx: Context<MarkInventory>) -> Result<()> {
        instructions::backstop::handle_mark_inventory(ctx)
    }

    /// Opens a Dutch auction of `lot` raw units (keeper).
    pub fn start_sale(ctx: Context<StartSale>, lot: u64) -> Result<()> {
        instructions::backstop::handle_start_sale(ctx, lot)
    }

    /// Buys `qty` raw units at the auction's current price, at most `max_price_wad` per token (anyone).
    pub fn buy_from_sale(ctx: Context<BuyFromSale>, qty: u64, max_price_wad: u128) -> Result<()> {
        instructions::backstop::handle_buy_from_sale(ctx, qty, max_price_wad)
    }

    /// Ends an auction; unsold units stay for the next sale (keeper; anyone after the decay).
    pub fn close_sale(ctx: Context<CloseSale>) -> Result<()> {
        instructions::backstop::handle_close_sale(ctx)
    }

    /// Yield vault (W3): the klend USDC reserve idle cash is lent to, and the cash kept above the buffer (admin).
    pub fn set_yield_reserve(ctx: Context<SetYieldReserve>, cash_headroom_wad: u64) -> Result<()> {
        instructions::yield_vault::handle_set_yield_reserve(ctx, cash_headroom_wad)
    }

    /// Lends cash above the buffer to the USDC reserve or redeems below it, and books the yield (keeper; INV-5).
    pub fn rebalance(ctx: Context<Rebalance>) -> Result<()> {
        instructions::yield_vault::handle_rebalance(ctx)
    }

    /// Books the lending position's yield on a reserve refreshed this slot, without moving anything (anyone).
    pub fn value_yield(ctx: Context<ValueYield>) -> Result<()> {
        instructions::yield_vault::handle_value_yield(ctx)
    }

    // ---- Curator book cover (C2, W5): instructions::book and instructions::book_settle ----

    /// Opens a book for `closure_id` (any payer): the `Book` and its USDC escrow.
    pub fn open_book(ctx: Context<OpenBook>, closure_id: u32, book_id: u32) -> Result<()> {
        instructions::book::handle_open_book(ctx, closure_id, book_id)
    }

    /// Adds a Kamino single-xStock position to an open book (after its refreshes in the same transaction).
    pub fn add_book_leg(ctx: Context<AddBookLeg>, ticker: Ticker, closure_id: u32) -> Result<()> {
        instructions::book::handle_add_book_leg(ctx, ticker, closure_id)
    }

    /// Adds a Kamino multi-collateral position (remaining accounts as `buy_cover_multi`).
    pub fn add_book_leg_multi<'info>(ctx: Context<'info, AddBookLegMulti<'info>>, closure_id: u32) -> Result<()> {
        instructions::book::handle_add_book_leg_multi(ctx, closure_id)
    }

    /// Adds a Jupiter Lend position.
    pub fn add_book_leg_jl(ctx: Context<AddBookLegJl>, ticker: Ticker, closure_id: u32) -> Result<()> {
        instructions::book::handle_add_book_leg_jl(ctx, ticker, closure_id)
    }

    /// Prices the book once (`risk-core::book_premium`) and pays it from the escrow.
    pub fn seal_book<'info>(ctx: Context<'info, SealBook<'info>>, max_premium: u64) -> Result<()> {
        instructions::book::handle_seal_book(ctx, max_premium)
    }

    /// The position's owner takes it off a book before the bell (owner precedence; then `buy_cover*` in the same tx).
    pub fn release_book_leg<'info>(ctx: Context<'info, ReleaseBookLeg<'info>>) -> Result<()> {
        instructions::book::handle_release_book_leg(ctx)
    }

    /// Anyone: voids a leg of a book left unsealed past its expiry.
    pub fn void_book_leg<'info>(ctx: Context<'info, VoidBookLeg<'info>>) -> Result<()> {
        instructions::book::handle_void_book_leg(ctx)
    }

    /// Anyone: pays the payer a voided book's escrow and the refunds owed.
    pub fn claim_book_refund(ctx: Context<ClaimBookRefund>) -> Result<()> {
        instructions::book::handle_claim_book_refund(ctx)
    }

    /// Anyone: closes a finished book (rent to the payer).
    pub fn close_book(ctx: Context<CloseBook>) -> Result<()> {
        instructions::book::handle_close_book(ctx)
    }

    /// The Liquidation Shield on a Kamino book leg (keeper).
    pub fn shield_book_leg<'info>(ctx: Context<'info, ShieldBookLeg<'info>>) -> Result<()> {
        instructions::book_settle::handle_shield_book_leg(ctx)
    }

    /// The Liquidation Shield on a Jupiter book leg (keeper); `expected = u64::MAX` only returns the amount.
    pub fn shield_book_leg_jl<'info>(ctx: Context<'info, ShieldBookLegJl<'info>>, expected: u64, indices: Vec<u8>) -> Result<()> {
        instructions::book_settle::handle_shield_book_leg_jl(ctx, expected, indices)
    }

    /// Settles a Kamino book leg into its obligation (anyone); never a wallet.
    pub fn settle_book_leg<'info>(ctx: Context<'info, SettleBookLeg<'info>>) -> Result<()> {
        instructions::book_settle::handle_settle_book_leg(ctx)
    }

    /// Settles a Jupiter book leg into its position (anyone); `expected = u64::MAX` only returns the amount.
    pub fn settle_book_leg_jl<'info>(ctx: Context<'info, SettleBookLegJl<'info>>, expected: u64, indices: Vec<u8>) -> Result<()> {
        instructions::book_settle::handle_settle_book_leg_jl(ctx, expected, indices)
    }

    /// Anyone: finishes a leg unpaid (voided epoch, or after the grace), its share refunded when owed (A-84).
    pub fn close_out_book_leg<'info>(ctx: Context<'info, CloseOutBookLeg<'info>>) -> Result<()> {
        instructions::book_settle::handle_close_out_book_leg(ctx)
    }

    /// Anyone: a finished leg's rent back to its payer once the group has released.
    pub fn close_book_leg(ctx: Context<CloseBookLeg>) -> Result<()> {
        instructions::book_settle::handle_close_book_leg(ctx)
    }

    /// Creates the Gap Oracle feed of an asset (C3): admin only, nothing else can create or write it.
    pub fn init_gap_feed(ctx: Context<InitGapFeed>, ticker: Ticker, min_update_slots: u32, max_input_age_secs: u32) -> Result<()> {
        instructions::gap_feed::handle_init_gap_feed(ctx, ticker, min_update_slots, max_input_age_secs)
    }

    pub fn set_gap_feed_params(ctx: Context<SetGapFeedParams>, ticker: Ticker, min_update_slots: u32, max_input_age_secs: u32) -> Result<()> {
        instructions::gap_feed::handle_set_gap_feed_params(ctx, ticker, min_update_slots, max_input_age_secs)
    }

    /// Permissionless crank (C3): refreshes the asset's `GapFeed` from accounts whose addresses the program derives.
    pub fn update_gap_feed(ctx: Context<UpdateGapFeed>, ticker: Ticker) -> Result<()> {
        instructions::gap_feed::handle_update_gap_feed(ctx, ticker)
    }

    /// Read-only premium and capacity preview. Inputs in USDC base units; `covered_value` is LT × collateral value.
    pub fn quote_cover(ctx: Context<QuoteCover>, covered_value: u64, debt: u64, max_payout: u64) -> Result<Quote> {
        instructions::quote::handle_quote_cover(ctx, covered_value, debt, max_payout)
    }
}

#[error_code]
pub enum CoreError {
    #[msg("risk-core math error")]
    Math,
    #[msg("unexpected program id for a Kamino account")]
    WrongProgram,
    #[msg("lending market is not one of the two xStocks markets")]
    MarketNotAllowed,
    #[msg("signer is not authorised for this instruction")]
    Unauthorized,
    #[msg("invalid parameter")]
    InvalidParam,
    #[msg("set is already finalised")]
    AlreadyFinalized,
    #[msg("set is not finalised")]
    NotFinalized,
    #[msg("values are not sorted ascending")]
    NotSorted,
    #[msg("hash does not match the uploaded values")]
    HashMismatch,
    #[msg("ticker does not match")]
    TickerMismatch,
    #[msg("gap factors are stale or incomplete")]
    StaleGapFactors,
    #[msg("vault capacity exceeded (INV-2)")]
    CapacityExceeded,
    #[msg("account data does not match the pinned klend layout")]
    KaminoLayout,
    #[msg("obligation was not refreshed in this slot (refresh_reserve + refresh_obligation first)")]
    ObligationNotRefreshed,
    #[msg("signer is not the obligation owner")]
    NotObligationOwner,
    #[msg("Phase 1 covers obligations with one xStock deposit and one USDC borrow only")]
    UnsupportedObligation,
    #[msg("a group is live: deposits and withdrawals are queued until it settles")]
    VaultLocked,
    #[msg("protocol is paused")]
    Paused,
    #[msg("asset is disabled")]
    AssetDisabled,
    #[msg("closure_id is not a session in the calendar (or is its last session)")]
    NotASession,
    #[msg("unsupported closure: this cover sells plain weekends only (no other closure type, no earnings calendar; use buy_cover)")]
    UnsupportedClosure,
    #[msg("cover sales for this epoch are closed (INV-3)")]
    SalesClosed,
    #[msg("one asset's worst covered loss would exceed max_asset_share x u_max x equity")]
    ConcentrationExceeded,
    #[msg("premium is above max_premium")]
    PremiumAboveMax,
    #[msg("price update is not fully Wormhole-verified")]
    PriceNotVerified,
    #[msg("price update is for another feed")]
    WrongFeed,
    #[msg("price update published outside the window (INV-4)")]
    PriceOutsideWindow,
    #[msg("price is not positive or has an unsupported exponent")]
    BadPrice,
    #[msg("price confidence interval too wide")]
    PriceConfidenceTooWide,
    #[msg("updates must have strictly increasing publish times")]
    DuplicateUpdate,
    #[msg("equity-based price disagrees with the xStock price beyond tolerance")]
    CrossCheckFailed,
    #[msg("epoch is not in the right state for this instruction")]
    WrongEpochState,
    #[msg("too early for this instruction")]
    TooEarly,
    #[msg("payout exceeds vault equity")]
    VaultInsolvent,
    #[msg("the obligation has debt: pass the Kamino repay accounts")]
    KaminoAccountsMissing,
    #[msg("XSTOCK source: the price must come from Pyth's push account for the feed")]
    NotPushAccount,
    #[msg("not Kamino's Scope OraclePrices account")]
    NotScopePrices,
    #[msg("too many groups live at once")]
    TooManyLiveGroups,
    #[msg("a group this request waits for has not settled yet (INV-6)")]
    QueueNotReady,
    #[msg("the Liquidation Shield is off (shield_alpha_wad = 0)")]
    ShieldOff,
    #[msg("outside the shield window (Sunday 20:00 ET to the shield deadline before the open)")]
    OutsideShieldWindow,
    #[msg("the obligation no longer borrows from the policy's reserve: nothing to advance into")]
    NoDebtToAdvance,
    #[msg("an inventory mark is stale: call mark_inventory first")]
    StaleInventoryMark,
    #[msg("the backstop holds the maximum number of xStocks")]
    TooManyInventories,
    #[msg("the xStock mint is paused by its issuer")]
    MintPaused,
    #[msg("the xStock mint has a transfer hook: refused until reviewed")]
    TransferHookEnabled,
    #[msg("the Scope price is too old")]
    StalePrice,
    #[msg("backstop budget: cash kept for live cover groups and queues, or the pool's share of equity (INV-13)")]
    BackstopBudget,
    #[msg("klend liquidated nothing")]
    NothingLiquidated,
    #[msg("the vault would receive collateral it did not fully pay for (INV-8)")]
    Inv8,
    #[msg("no sale in the right state")]
    SaleState,
    #[msg("auction price is above max_price")]
    PriceAboveMax,
    #[msg("the lending position's valuation is stale: rebalance first")]
    StaleYieldValuation,
    #[msg("the klend reserve was not refreshed in this slot")]
    ReserveNotRefreshed,
    #[msg("vault cash does not back this cover: rebalance first")]
    CashBelowReservation,
    #[msg("the vault has an open lending position on another reserve")]
    YieldPositionOpen,
    #[msg("a PYUSD debt needs the vault's PYUSD sleeve account")]
    SleeveMissing,
    #[msg("the PYUSD sleeve does not hold the live PYUSD reservations (INV-14): fund_sleeve first")]
    SleeveShort,
    #[msg("PYUSD is below its peg floor")]
    Depegged,
    #[msg("the vault would pay more than PYUSD's price plus the slippage bound")]
    SlippageTooHigh,
    #[msg("the obligation is already at or past klend's liquidation threshold")]
    AlreadyLiquidatable,
    #[msg("unexpected Jupiter Lend account layout, owner or vault")]
    JupiterLayout,
    #[msg("the Jupiter Lend position was liquidated (its tick or branch moved)")]
    PositionLiquidated,
    #[msg("the amount differs from what the program computes now (simulate with u64::MAX to read it)")]
    AmountMismatch,
    #[msg("a book leg settles, advances and refunds through the book instructions (C2)")]
    BookLeg,
    #[msg("not a book leg")]
    NotABookLeg,
    #[msg("the book is not open for legs (sealed, voided or past its expiry)")]
    BookNotOpen,
    #[msg("the book is not sealed")]
    BookNotSealed,
    #[msg("the book has not expired: it can still be sealed")]
    BookNotExpired,
    #[msg("the book is not done: legs or refunds are outstanding")]
    BookNotDone,
    #[msg("the gap feed was updated less than min_update_slots ago")]
    FeedTooSoon,
    #[msg("the account is not this closure's epoch for this asset")]
    NotThisEpoch,
    #[msg("the account is not the asset's scenario set for this closure type")]
    NotThisScenarioSet,
    #[msg("the account is not the lender's oracle account for this asset")]
    NotLenderOracle,
}
