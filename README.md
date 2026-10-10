# Credence (Solana)

**Weekend gap protection for tokenized-stock loans on Kamino.** xStocks trade 24/7, but the price Kamino lends against
stops moving at Friday's 4 PM close and jumps at Monday's open (measured: frozen for six weekends in a row, see [Measured](#measured)).
A borrower near the liquidation threshold cannot react to a gap that has not been priced yet, and a stop-loss cannot
fire on a frozen price. Credence sells, before the Friday bell, protection that pays into the borrower's Kamino
position after the Monday open: exactly the repayment needed to bring it back to its liquidation threshold, capped by
the policy. Premiums are priced on-chain from ten years of weekend gaps; LPs underwrite them in a USDC vault. This is
lending-risk infrastructure for tokenized stocks on Solana: the oracle, the cover, the vault, and a Liquidation Shield
that repays into the position on Sunday night, sized from the xStock's 24/7 price, before Kamino's pre-market move.

Program id (all clusters): **`xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q`** (`programs/credence-core`, Anchor 1.2.1).
Phase 1 runs on a local mainnet fork with real Kamino state; it is not deployed to mainnet.

Videos: demo and pitch links are added here before submission.

## Run it

Needs Agave 4.3.x (`scripts/env.sh` checks and fails fast otherwise), Anchor 1.2.1, Node 22 with pnpm, surfpool
(`scripts/fork/surfpool.sh` finds or installs it) and `.env` with `MAINNET_RPC` (any mainnet RPC; it stays server side).

```bash
anchor build --arch v0      # program + IDL (SBPF v0: the SBPFv3 feature is not active on mainnet)
scripts/test.sh             # LiteSVM + risk-core suite (counts in Status). Fetches the klend + farms binaries once (BUSL-1.1, never committed)
scripts/demo.sh             # a simulated weekend on a fresh mainnet fork, then the twin demo (shield, backstop, auction, yield vault), about 2 minutes (FORK_PORT=… if 8899 is taken)
scripts/demo-app.sh         # fresh fork + data + demo LPs + epochs, then the app on http://localhost:3000 (about 55 s)
cd app && pnpm test         # unit: golden payout vectors vs Rust, keeper parity, vault bytes, pay odds, klend reserve
                            #   figures vs klend-sdk, calendar, alerts, keeper shield / backstop / resilience
cd app && pnpm test:e2e     # Playwright against the running demo-app.sh: happy path, $50k payout, Kamino round trip,
                            #   vault values, failure paths, twin (shield + backstop + sale), yield split
```

Without `.env`, `scripts/test.sh` runs the 125 tests that do not need the klend binaries and says what it skipped.

### In the app (1440 px or wider records best)

The landing page is at `/`, the app at `/app`. Pages, in the sidebar's order:

| Page | What it shows and does |
|---|---|
| Overview | Your Kamino xStocks positions with Debt / C′ and cover status, the coming weekend's bell, close and open, your LP position, activity from the chain |
| Markets | The eight covered xStocks on Kamino's xStocks Market (W16): Scope price, max LTV and LT, deposits, the USDC borrow rate and utilisation, σ, the modelled 1% worst gap, cover per $1,000 (simulated `quote_cover`), the market's state from the on-chain XNYS calendar |
| Borrow | Each position with the Bell check (repay or add collateral to survive the asset's 1-in-100 weekend gap), **Kamino deposit / borrow / repay / withdraw** (klend-sdk v2 instructions with the refreshes), the loss table at −5/−8/−12%, **Buy gap cover** with the chance it pays, a new position, real mainnet positions to take, your policies |
| Lend, Auctions | "Not live on Solana yet" (the lending product and the reopen backstop come later); no numbers |
| Curator | Cover a book of positions you do not own (C2): market, filters, the book quote next to the sum of standalone quotes, buy in resumable batches, seal, refunds, the book's weekend |
| Underwrite | The vault as stored, deposit or queued deposit, request withdrawal, process tickets, weekends as epochs, the backtest |
| Risk | The Gap Oracle (Friday close real or simulated, Kamino's frozen price, the 24/7 xStock price, implied gap, σ), S7, capacity and per-asset concentration |
| Alerts | Derived in the browser from chain state: the bell for an uncovered position near its threshold, cover bought, close stored, settlement posted, payout, LP ticket ready; unread badge in the sidebar |
| Faucet *(fork)* | Fund 10 SOL and 50,000 USDC, set an xStock balance, create the $50,000 demo position |
| Demo mode *(fork)* | Friday close → Monday open with a chosen gap → settle, each transaction with its CU, the payout into the position, what is simulated |
| Account, Settings | Wallet, balances, policies and payouts, LP shares, activity; local preferences |

The judge's path:

1. **Connect wallet → Demo burner wallet** (a local keypair kept in the browser, for judges without Phantom; Phantom
   works through the wallet standard), then **Faucet → Fund (fork)**.
2. **Demo mode → Create position (fork)**: a $50,000-debt SPYx position at D/C′ 0.96, opened through klend on the fork
   and given to your wallet. Or **Borrow → Use a real mainnet position**.
3. **Borrow**: the position after a klend refresh, the loss table, the premium with **the chance it pays anything**,
   and **Buy gap cover** (refresh ×2 + `buy_cover` in one transaction; the Policy is read back).
4. **Demo mode → Friday close → Monday open −8% → Settle**: the payout is repaid into the obligation.
5. **Underwrite**, **Risk**, **Alerts**, **Account**.

The app owns its connection to the fork and asks the wallet only to sign; every transaction is simulated first and
shows its signature and compute units. Server routes run fork cheatcodes, build Kamino instructions with klend-sdk
(unsigned), read `data/` and run the keeper's demo steps; `MAINNET_RPC` never reaches the browser (build output
grepped: 0 hits). The app listens on 127.0.0.1 only. Screenshots: [docs/app](docs/app).

### Public read-only mode (the site judges can open without installing anything)

`NEXT_PUBLIC_NETWORK=mainnet` builds the same app as a read-only view of Solana mainnet:

- the browser reads mainnet through the app's own `/api/rpc` proxy (read methods only; `getProgramAccounts` only on
  klend or credence_core with filters), so `MAINNET_RPC` and its key stay on the server (build output grepped: 0 hits);
- **Risk** shows the Gap Oracle read live from mainnet (Kamino's Scope account and the Pyth push accounts) and the
  weekend risk of Kamino's xStocks borrowers, scanned live (909 positions, $3.12M of USDC debt, 532 fit Phase 1 on
  Oct 8, by the same method as `scripts/src/positions.ts`), with what a −5/−8/−12% open would need;
- **Markets** and **Overview** read Kamino's reserves and your own positions (connect a wallet; nothing is signed);
- nothing is signed or sent: the fork tools (Faucet, Demo mode, the burner) are hidden and their routes refuse; gap
  cover and the vault say they run on the fork demo until the mainnet pilot exists;
- a notice says the site is not for US persons, as xStocks are not.

Lighthouse on the landing page: performance 91–92, accessibility 98, best practices 100, SEO 100. Deploy (Vercel):
root directory `app`, env `NEXT_PUBLIC_NETWORK=mainnet` and `MAINNET_RPC` (server only); `next.config.ts` traces
the `data/` files the read routes need. Not deployed yet.

## How it works

```
 Friday, before the bell (15 min before 4 PM ET)          Monday, after the 9:30 ET open
 ───────────────────────────────────────────────          ─────────────────────────────────────────────
 borrower ── refresh_reserve ×2, refresh_obligation,      keeper ── post_settlement (Kamino's Scope price,
             buy_cover(max_payout, max_premium) ──┐                  first update inside the window, INV-4)
                                                  │       anyone ── refresh ×3, settle_policy ──┐
   credence_core                                  ▼                                             ▼
   ├─ reads the klend Obligation itself (debt with interest, C′ = LT × collateral)   payout = min(cap, D − C′·open/close)
   ├─ premium = quote over the asset's 3,000-scenario WEEKEND set (risk-core)        repaid into the obligation by a
   ├─ capacity: K = 256 joint stress weekends ≤ u_max × equity (INV-2)               vault-PDA-signed klend repay v2 CPI;
   └─ USDC premium → vault, Policy PDA                                               the rest (if any) to the owner
 keeper ── snapshot_close at 4 PM (Kamino's Scope price)   LPs ── deposit / queued withdraw, paid after settlement
```

| Part | Where |
|---|---|
| Fixed-point risk math (gap factors, premium, ES, capped quote) | `crates/risk-core` (reused from EVM Credence, unmodified; property and golden tests) |
| Program: config, assets, scenario and joint sets, calendar, epochs, cover, settlement, vault and queues | `programs/credence-core` |
| Kamino CPI probe (Day 1 fork test) | `programs/kamino-probe` |
| Keeper: open epochs, snapshot close, post settlement, settle, process queues; fork demo driver | `keeper/` |
| Data jobs: on-chain sets, positions scan, S7, Scope capture, σ floor | `scripts/src` |
| App (Next.js): landing, Overview, Markets, Borrow (Kamino actions + gap cover), Underwrite, Risk (Gap Oracle), Alerts, Faucet, Demo mode, Account, Settings | `app/` |

## Pricing (decided Day 5)

θ = 1.0, c = 10%, η = 1, β = 97.5%, u_max = 50%, minimum premium 5 USDC, fee 0, and a **σ floor**: σ = max(recent,
long-run 2016–2026 weekend σ) per asset (SPY 0.94%, QQQ 1.03%, NVDA 2.15%), so a calm recent market does not price
Mar 2020 or Apr 2025 as rare. Backtest of a model book (120 policies, D/C′ 0.80–0.98, $25k each, $2M of LP equity)
through ten years of dated weekend shocks (`data/backtest/gap-cover-backtest.json`): **2.2% a year on LP equity, loss
ratio 41%, worst weekend −3.9% of equity** (2019-01-28, NVDA −13.6%). The demo position ($50k at D/C′ 0.96) costs
8.6–8.8 USDC (depending on vault utilisation), and the app shows next to it a **0.63%** modelled chance of any payout and **2 of 571** real closures
since Apr 2016 that would have paid (both March 2020). Sweep and alternatives: [Measured](#measured).

## What is real and what is simulated

| Part | Real | Simulated or substituted |
|---|---|---|
| Kamino (klend) | Mainnet klend and farms binaries, real xStocks Market accounts and obligations (cloned on first use by the surfpool fork); the repay is a real CPI into klend signed by the vault PDA | The demo position is a real near-threshold obligation, but its owner field is rewritten on the fork so the demo wallet can sign `buy_cover`. In the LiteSVM tests, Scope timestamps are re-stamped after the test clock moves (test-only helper) |
| Vault and LPs | Program logic, share math, queues | Demo wallets' USDC comes from a fork cheatcode |
| Friday close and Monday settlement price | Kamino's own oracle: the program reads Kamino's Scope `OraclePrices` account (Chainlink Data Streams + Pyth Pro), the same price klend liquidates on. The live checkpoints capture the real Oct 9 close and Oct 12 open from raw mainnet reads of that account (results in this README) | Pyth push accounts (`XSTOCK`) remain as a fallback; the planned `Equity.US` settlement (`EQUITY`) needs a paid Pyth equities plan |
| Time | Real exchange calendar (XNYS sessions, holidays, half days); real epoch times | The fork's clock jumps to the Friday close and the Monday open (surfpool time travel) |
| The weekend's prices in the demo | Friday close: Kamino's real Scope price (the genuine reading from the real close once the recorder has it; before that, the live Scope value cloned at the start) | Before Oct 9, the close's refresh time is moved to the bell; the Monday open is Kamino's Scope price moved by `DEMO_GAP` (default −8%), which klend also sees. Every demo run lists what it simulated in `data/demo/demo-result.json`; the app lists it on the Demo mode page |
| App demo positions | Real near-threshold mainnet obligations (owner field rewritten on the fork, as above) | The bigger demo position is created on the fork: SPYx given to the demo keeper by cheatcode, then a real klend deposit + borrow, then its owner field set to your wallet |
| Fork upkeep (app and keeper) | — | At start, every reserve of the two xStocks markets is copied from mainnet with its vaults and collateral mint in one read (surfpool's lazy clones of a reserve and its vault could disagree and make klend panic); Scope refresh times are moved to the fork clock before klend refreshes (prices unchanged); after a simulated gap the Scope TWAP is set to the spot price; accounts the fork has never seen are marked local-only before a transaction |
| Gap Oracle page | Kamino's Scope price and the Pyth `Crypto.<T>X/USD` push updates, genuine mainnet readings by the recorder (every 10 s) | The Friday close shown from the fork's epoch is labelled simulated unless it equals the captured real close |
| Pricing data | Scenario sets, joint stress set and σ calibrated on Alpaca SIP data, Jan 2016 to Sept 2026; σ floor and closure gaps from Yahoo daily bars | — (personal-use licence, see Known limits) |
| Shadow weekend (`keeper/src/shadow.ts`) | Every eligible real obligation, Kamino's Scope price and the Pyth push updates, read from mainnet every 60 s over the real Oct 9–12 weekend; premiums, shield sizes and payouts from the program's own pricing code | What Credence *would* have done: no transaction is sent, no cover was sold. Premiums assume a model $2M vault covering each position's whole debt; the backstop's buys use klend's liquidation rule as read from its source |
| Protect my position Action and Friday alerts (C4a) | The program's pricing, the real calendar and scan, Telegram / web-push delivery | The transactions are built for the fork (fork chain id, not usable from a wallet); the alert quote uses a 2,000,000 USDC model vault; the demo signs with the burner in the in-app Blink |

## Invariants and where they are tested

| | Invariant | Test (`programs/credence-core/tests/`) |
|---|---|---|
| INV-1 | payout ≤ max_payout | `settle.rs::inv1_payout_never_exceeds_cap` |
| INV-2 | reserved worst-case losses ≤ u_max × equity at every policy write | `cover.rs::inv2_holds`, `inv2_capacity_refused` |
| INV-3 | no policy after the bell | `cover.rs::inv3_no_sales_after_bell` |
| INV-4 | settlement only on prices published inside the window | `settlement.rs::inv4_settlement_rejects_updates_outside_window` |
| INV-5 | a deposit or withdrawal never lowers NAV per share (book equity, donation-proof) | `vault.rs::inv5_deposit_does_not_dilute`, `queue.rs::inv5_queued_deposit_and_withdrawal_never_lower_nav` |
| INV-6 | withdrawals for a weekend are paid only after it settles (or is voided) | `queue.rs::inv6_withdrawal_paid_only_after_its_group_settles`, `inv6_withdrawal_paid_after_group_voided` |
| INV-7 | a payout into an obligation only reduces its debt; the rest goes to the owner (a book leg's rest stays in the vault: never a wallet) | `settle.rs::inv7_payout_only_reduces_debt_rest_to_wallet`; books: `book.rs::c2_payout_never_to_wallet`, `multi.rs::book_multi_and_pyusd_legs`, `jupiter.rs::book_leg_jl_settles_into_the_position` |
| INV-8 | the backstop never receives collateral it did not fully pay for: units ≤ USDC spent at Scope × (1 − κ), every cToken redeemed, only measured units booked | `backstop.rs::inv8_refuses_collateral_it_did_not_pay_for`, `backstop_liquidates_through_the_vault_pda`; risk-core `backstop.rs::inv8_paid_for_never_exceeds_payment` |
| INV-9 | shield advances ≤ α × max_payout | `shield.rs::inv9_advanced_never_exceeds_alpha_cap`; `pricing::tests::shield_target_bounded_and_monotone` |
| INV-10 | advances + settlement payout ≤ max_payout | `shield.rs::inv10_advances_plus_settlement_never_exceed_the_cap` |
| INV-11 | an advance only reduces the obligation's debt, never reaches a wallet | `shield.rs::inv11_advance_only_reduces_debt_never_pays_a_wallet` |
| INV-13 | the backstop never spends the cash kept for live cover groups and queues (reserved losses + unearned premiums + queued deposits), its inventory at cost ≤ its share of equity, and inventory never backs cover | `backstop.rs::inv13_backstop_never_spends_reserved_cash`, `inv13_inventory_does_not_back_cover` |
| INV-14 | the PYUSD sleeve holds every live PYUSD reservation less the advances paid from it; PYUSD cover beyond it is refused | `multi.rs::inv14_sleeve_must_hold_the_reservation`, and checked after each step of every PYUSD test in `multi.rs` |
| INV-12 | a policy's advances ≤ its reserved worst loss, a group's ≤ its reserved `max_loss` (A-32); the reservation includes the shield's own sizing (task 1.2) | `shield.rs::inv12_group_advances_within_reserved_capacity`, `a32_…`, `reservation_covers_the_full_advance_on_a_normal_weekend`; `pricing.rs::loss_vector_with_shield_golden_matches_risk_core` |
| INV-15 | a book's refunds paid and owed ≤ its premium net of the fee; every leg's advances + payout ≤ its cap (C2) | `book.rs::c2_refund_math`, `c2_stranger_cannot_block_owner`, `c2_payout_never_to_wallet`, `book_close_out_after_grace` (checked after each refund); risk-core `book.rs::refunds_never_exceed_the_premium` |
| INV-16 | a book's shield advances ≤ Σ its live legs' reserved worst loss (INV-12 at the book level, C2) | `book.rs::c2_payout_never_to_wallet`, `jupiter.rs::book_leg_jl_pays_only_into_the_position` |

## Compute units

Measured on the surfpool mainnet fork with real klend (whole transactions including klend's refreshes):

| Transaction | CU |
|---|---|
| `refresh_reserve` ×2 + `refresh_obligation` + `buy_cover` | 161,000 (LiteSVM 170–180k) |
| `refresh` ×3 + `settle_policy` with the klend repay v2 CPI (USDC debt farm) | 250,000–254,000 |
| `quote_cover` (3,000-point set, capacity included) | 44k–60k typical; worst case 281k (NVDAx at D/C′ 0.995) |
| `quote_cover` with the shield loading on (W1) | 64k (SPYx at D/C′ 0.96) to 534k (NVDAx at 0.995) |
| `refresh` ×3 + `buy_cover` with the shield loading (W1, fork) | 227,706 |
| `refresh` ×3 + `shield_advance` with the klend repay v2 CPI (W1) | 172,375 (fork); LiteSVM 158,866, of which `shield_advance` 100,190 |
| `refresh` ×3 + `backstop_liquidate` (klend v2 liquidation CPI, the vault PDA as liquidator, W2) | 253,275 (fork); LiteSVM 254,175 |
| `start_sale` / `buy_from_sale` (Token-2022 transfer) / `mark_inventory` | 13,229 / 51,944 (fork; LiteSVM 37,895) / 15,001 |
| `rebalance` (deposit / redeem CPI, no refresh ix) / `refresh_reserve` + `rebalance` (no move) / `value_yield` + deposit | 87,693 / 66,452 / 42,854 / 61,655 (LiteSVM) |
| `buy_cover_multi` 1 / 2 / 3 legs (W4, LiteSVM, program only; 2 legs with refreshes 455,395) | 222,972 / 364,482 / 469,851 |
| `quote_cover_multi` 1–4 legs at D/C′ 0.92 / 0.99 (W4) | 184k–538k / 524k–743k |
| `settle_policy` 2 legs in PYUSD / `shield_advance` 2 legs / `fund_sleeve` (W4, LiteSVM) | 88,270 / 100,378 / 30,089 |
| `buy_cover_jl` / `shield_advance_jl` / `settle_policy_jl` (W12, LiteSVM with Jupiter's binaries; operate CPI) | 152,235 / 174,267 / 179,795 |
| `buy_cover_up` at D/C′ 0.978 / 0.987 / 0.995 (W11, LiteSVM) / `settle_policy` UP to the wallet / `buy_cover` OVERNIGHT (fork, with refreshes) | 136k / 175k / 381k / 204,815 / 221,592 |
| `add_book_leg` (C2): Kamino single, k legs per v0 transaction with a lookup table / multi 2 legs PYUSD / Jupiter (LiteSVM, fork) | 6 legs 1.27–1.38M (LiteSVM), ~246k per leg on the fork / 377,036 program / 185–199k (452k near the threshold) |
| `seal_book` / `settle_book_leg` with refreshes + repay v2 / `shield_book_leg_jl` / `settle_book_leg_jl` (C2) | 43,472 (sorts the 256-scenario vector once) / 183,298 / 183,740 / 184,735 |
| `snapshot_close` (Kamino Scope) | 11,000–16,000 |
| `post_settlement` (Kamino Scope) | 12,800–18,000 |
| `open_epoch` / `process_deposit` / `process_withdrawal` | 18–22k / 28–31k / 26–30k |

Budget: 900k per instruction, 1.4M per transaction.

## Known limits (Phase 1)

- **The shield acts on a 24/7 price that can be hours old.** Weekend Pyth pushes are deviation-driven, so the shield
  accepts fair values up to 36 h old (an old push means the price stayed inside Pyth's band). Its 2% buffer is about
  6.6 σ_b for SPYx: safe, but the vault over-advances whenever the shield acts and the premium prices that in (the
  loading is most of the premium near the threshold). A per-asset buffer is the next step.
- **The shield loading samples 256 points of the scenario set** (the premium uses all 3,000); within 0.3% where it
  matters, and it misses up to $0.60 per $100k of the far tail for positions far from their threshold.
- **Single collateral, USDC debt.** One xStock deposit against one USDC borrow (531 of 908 positions on Oct 7, $1.22M of
  $3.11M debt). Multi-collateral and PYUSD (Sentora market) are Phase 2.
- **Beyond every stress scenario, first settled is paid first.** Capacity (INV-2) holds the worst of 256 joint stress
  weekends within half of LP equity. A weekend worse than all of them can owe more than equity: policies are then paid
  in settlement order until equity and that weekend's premiums run out, and the rest get what remains (the shortfall is
  in the `PolicySettled` event). A pro-rata haircut is Phase 2. A vault whose equity reaches zero cannot be
  recapitalised (queued deposits are refunded); it would be replaced.
- **Curator books (C2).** Account layouts grew without a migration (`Policy` 565 bytes, new `Book`; fresh fork only,
  A-19). A book's lifetime (1 h) is a program constant. A leg is full cover on a plain weekend (no overnight, holiday
  or earnings-bump epochs, A-63). After `SETTLE_GRACE` anyone can finish an unpaid leg at 0 (`close_out_book_leg`): the
  keeper must settle legs within the hour. The Curator page buys Kamino xStocks and Jupiter legs; Sentora (PYUSD) legs
  go through the keeper. The per-asset Shield buffer is still the owner's decision (C1).
- **Data licence.** The calibration uses Alpaca SIP data under a free personal licence, not cleared for commercial use.
- **Local fork only.** Not deployed to devnet or mainnet; xStock mints are mainnet-only.
- QQQx's Kamino price moves over weekends (its Scope chain follows a 24/7 source), so its gap is not concentrated at
  the open; it is listed but treated with caution.

## Audit

An internal audit before submission (attack first as a failing test, then the fix, one commit each), plus `clippy`, a
code review and a security review as second opinions, repeated at every merge: 122 findings to the C4a merge (11
high, 48 medium, 39 low, 24 info), 102 fixed, 18 recorded as known limits, 2 open (code duplication, no loss path). Table with each finding, its fix commit and its test: [docs/audit/phase1-audit.md](docs/audit/phase1-audit.md).
The first high one: an obligation that changed owner before the bell could carry a second policy for the same weekend; the
Policy PDA is now `["policy", epoch, obligation]`. Only the keeper stores the Friday close and the settlement price.

## Prior work

This repository was started on Oct 7, 2026. It reuses, from the EVM Credence Finance prototype (Robinhood Chain
testnet and Arbitrum Sepolia, started Sept 27, 2026): the `risk-core` fixed-point math crate (unmodified), the
mechanism design (Gap Cover, the Friday bell, the reopen backstop), and the scenario, joint-set and σ calibration data
(Alpaca SIP, personal licence; `data/README.md`). New for Solana: the Anchor program, the Kamino integration (obligation
snapshot, repay CPI), the Scope oracle path, the keeper, the data jobs, the app and the pricing changes of Day 5.
The web app's design (landing page with its hero video and images, the app shell, page structure and stylesheets)
comes from the EVM Credence Finance frontend (started Sept 27, 2026) and was rebuilt for Solana: new pages, wallet
standard and demo burner, Anchor and klend reads, Kamino actions, no EVM code.

## Status (Oct 10, 2026)

**Phase C, C2 (curator book cover) is merged** on top of Phase 1, Phase A, Phase B and C1. Coverage: eight xStocks on
Kamino and TSLAx on Jupiter Lend, **2,427** eligible positions on the two lenders (scan Oct 9); a payer can now cover a
book of them for one premium. From a fresh clone (Oct 10, with `.env`): `scripts/test.sh` **310 passed**, 0 failed, 2
ignored (run `anchor build --arch v0` first); `scripts/demo.sh` green in 921 s (every step, the book step included;
started on a Saturday: the demos move the fork's clock into the next sale window, A-85); `scripts/demo-app.sh` ready in
230 s; app unit **65 passed**, 3 skipped; Playwright **18/18** in 11.1 min (`RPC_URL` = the fork when it is not on
8899). Audit findings A-01 to A-97 in [docs/audit/phase1-audit.md](docs/audit/phase1-audit.md) (97: 82 fixed, 13 known
limits, 2 open). Next phase: [docs/handoff.md](docs/handoff.md).

Not done: the verifiable build (needs Docker, runbook §0). Live checkpoints running: the real Oct 9 close (Sat 01:15
IST), the first post-closure prices (Mon 05:30 IST) and the real Monday settlement and shadow results (Mon 19:00 IST)
go here.

## Liquidation Shield (W1)

Kamino's xStock price is frozen all weekend and moves in Monday pre-market (see [Measured](#measured)), so a payout at
the open can come after the liquidation. The shield acts first: between Sunday 20:00 ET and the shield deadline
(Monday 07:00 ET; both from the calendar's next open, so holidays move them), the keeper calls `shield_advance` on each
covered policy with the asset's Pyth `Crypto.<T>X/USD` push account (the xStock token's 24/7 price; Full-verified,
feed-checked, ≤ 36 h old, confidence ≤ 0.5%). The program sizes the advance with the settlement rule itself at the fair
value marked down by a buffer, `min(α × cap, realized_payout(C′, D, cap, close, fair × (1 − b)))` (α 50%, b 2%), and
repays the difference to what it already advanced into the obligation through klend's repay v2 CPI, signed by the
vault PDA. Nothing is ever paid to a wallet; a retry does nothing. Settlement then pays `max(0, payout − advanced)`;
an advance above the payout stays the vault's loss, priced into the premium as `λ × E[max(0, advance − payout)]` (λ 2)
over the scenario set and the measured basis σ_b (`risk-core::shield_loading`).

- **Capacity reserves what the shield will do** (task 1.2, the A-32 follow-up). Each joint scenario reserves
  `max(settlement loss, min(α·cap, the shield's advance at that scenario's gap − k·σ_b))`, k = 2
  (`risk-core::reserved_loss`, golden-tested on-chain), so INV-12 (advances ≤ the reservation) only binds beyond
  k·σ_b of basis, not on a normal weekend.
- **Interest counts** (task 1.2). The debt is fixed at purchase, but klend charges interest on it until the open. The
  shield and settlement into the obligation use the snapshot debt with klend's own interest on it since purchase (the
  borrow reserve's cumulative rate index; new borrowing never counts), capped at 0.5% of it; capacity reserves the
  cap, premiums price the expected 0.1% (the USDC reserve's 5.5% borrow APY over a week, Oct 9). A wallet payout
  (closed obligation) uses the snapshot.

- **Twin demo** (`scripts/demo.sh` runs `keeper/src/twin.ts`; also in the app's demo mode, Playwright `e2e/twin.spec.ts`):
  two identical $50k SPYx positions at D/C′ 0.96, A covered. Sunday 20:30 ET the fair value is −8% and the shield
  repays 3,094.67 USDC into A, the full sized advance with the weekend's interest (health 1.042 → 1.109; A-32 had
  capped it at 2,423.51 before task 1.2); Monday 08:00 ET Kamino's price is −8%: A stays at health **1.020**, B's
  health is 0.957 and a plain third-party liquidator (`keeper/src/liquidator.ts`, klend v2 liquidation) liquidates it
  (10,013 USDC repaid, 15.59 SPYx taken), while klend refuses to liquidate A. A's premium 41.15 USDC (loading 31.85).
- **Basis** (`scripts/src/shield-basis.ts` → `data/shield-basis.json`, push-account history since it began on June 4,
  2026): σ_b of (lowest fair value in force in the window − first price after the open) / close, plus the Pyth-vs-Scope
  spread at the close (A-22, A-23): SPYx 0.34% over 10 weekends, NVDAx 1.86% over 10; QQQX never pushes within an
  hour of the open, so QQQx uses the pooled value.
- **Backtest with the shield** (`BT_SHIELD=1`, `data/backtest/gap-cover-backtest-shield.json`), model book A, after
  task 1.2: LP return 2.22% → 7.79% a year, loss ratio 41.7% → 41.7%, worst weekend −3.96% → −4.85% of equity
  (2019-01-28); utilisation 13.5% → 23.3% (the reservation now includes the shield); the demo position's premium
  9.42 → 41.69 USDC (reserved 2,680.64 → 3,978.55).

## Monday Backstop (W2)

What still liquidates at the move, Credence's vault liquidates itself, at Kamino's own bonus, and resells.

- **`backstop_liquidate`** (keeper): refreshes + klend's `liquidate_obligation_and_redeem_reserve_collateral_v2`
  through a CPI with the **vault PDA as the liquidator** (no keypair path needed: the v2 CPI was proven on the fork,
  `b5a0318`). klend decides who is liquidatable, the close factor and the bonus; the program measures the USDC it paid
  and the xStock it received.
- **INV-8** (EVM Credence bug 2): units received ≤ what the payment buys at the committed price Scope × (1 − κ), κ 15%;
  every cToken is redeemed in the same instruction; only measured units are booked. Attack test: κ = 0 → refused.
- **INV-13**: the backstop spends only cash above what live cover groups and queues need (reserved worst-case losses +
  unearned premiums + queued deposits), holds at most 25% of equity at cost, and inventory never backs cover.
- **Inventory and NAV**: a purchase turns cash into inventory at cost (equity unchanged); share prices use NAV =
  equity − cost + Scope × (1 − 10%) (a mark at most 15 minutes old, `mark_inventory`); a sale realises proceeds − cost
  basis into equity.
- **Resale**: a Dutch auction from Scope + 2% to Scope − 5% over 2 h (`start_sale` / `buy_from_sale` /
  `close_sale`), partial fills, unsold units wait for the next sale. Never Jupiter: a sale never touches klend.
- **Token-2022**: a paused mint or a transfer hook is refused before any transfer; prices are per raw unit on Kamino's
  Scope basis (the Scaled UI multiplier is inside it); the issuer's permanent delegate can claw inventory back
  (disclosed risk).
- **Twin demo**: at Monday 08:00 ET (Kamino −8%) the backstop tries both positions: klend refuses A (health 1.020),
  liquidates B through the vault: 10,013.10 USDC paid, 15.5747 SPYx received (248.69 USDC of bonus at Scope). The
  keeper opens the auction; 30 minutes later a buyer wallet takes 7.7874 SPYx at 660.53 for 5,143.77 USDC: realised
  P&L +137.22 USDC; the rest stays on sale.

## Yield vault (W3)

Idle LP cash earns the xStocks Market USDC reserve's supply rate; premiums and backstop P&L come on top.

- **`rebalance`** (keeper, every pass before the queues): keeps cash at the **buffer** = live groups' reserved worst
  loss (shield included) + unearned premiums + queued deposits + queued withdrawals at NAV + the backstop's unspent
  share + 10% of cover equity, and lends the rest through klend's `deposit_reserve_liquidity` CPI (the vault PDA
  signs); below the buffer it redeems with `redeem_reserve_collateral`, at most what the reserve can pay out.
  **Verified: neither klend instruction needs refresh instructions in the transaction** (klend refreshes the reserve
  itself; `tests/yield_vault.rs`).
- **NAV** = cash + kUSDC at klend's exchange rate (rounded down) + inventory mark. Yield is booked only at `rebalance`
  or `value_yield` (anyone, on a reserve refreshed in the same transaction); share prices refuse a valuation older than
  15 minutes while anything is lent (INV-5).
- **Cash first:** payouts, shield advances, backstop purchases and withdrawals pay from cash; `buy_cover` refuses cover
  that cash does not back. Stress test at **100% utilisation** (nothing redeemable): settlement (21,011 USDC), a
  queued withdrawal (495,523 USDC) and a shield advance all pay from cash.
- **Measured:** 30 days on 1.8M lent booked 3,582 USDC (2.42%/yr at the snapshot); on the fork 974k lent during the
  twin demo. Backtest book A: LP return 2.22% → **5.90%** a year with the supply rate (shield off), 7.79% → **11.26%**
  with the shield (4.42% supply APY, Kamino API Oct 9; 78–83% of equity lent).

## Multi-collateral and PYUSD cover (W4)

Positions with several xStocks, stablecoin deposits or a PYUSD debt (Kamino's Sentora xStocks Market) are covered by
one policy across all their legs (`buy_cover_multi`, up to 8).

- **Payout:** `min(cap, D − Σ_i C′_i (1 + r_i) − S′)` with each deposit's own LT and the stablecoins as S′
  (`risk-core::multi`); settlement waits for every leg's epoch, and a voided leg counts flat. The shield reads every
  leg's own 24/7 price.
- **Premium:** the larger of the joint price (the joint stress scenarios, each asset its own column) and each leg's
  single-asset price with the others flat, plus each leg's shield loading. Paid in USDC.
- **PYUSD:** paid in PYUSD from the vault's PYUSD sleeve. The keeper sells PYUSD to the vault through `fund_sleeve` at
  most at Kamino's PYUSD price + 0.3%, refused below a 0.98 peg. INV-14: PYUSD cover is sold only up to what the
  sleeve holds.
- **Coverage:** eligible mainnet positions 532 → **623** (+69 multi-collateral, +29 PYUSD; scan Oct 9). The 316 left
  mostly hold xStocks not enabled yet (TSLAx, GOOGLx, MSTRx, AAPLx, HOODx, CRCLx).
- **Demo:** `scripts/demo.sh` ends with `keeper/src/multi-demo.ts`: the real Sentora obligation `xkHzu8RC…` (SPYx +
  NVDAx / PYUSD; owner field re-pointed by cheatcode, more PYUSD borrowed through klend to D/C′ 0.87) is covered,
  shielded on both legs (1,761.04 PYUSD on Sunday night) and settled (3,557.10 PYUSD in total). The app shows it under
  Demo → "Multi-collateral cover, paid in PYUSD".
- **Limits:** no elevation group on the multi path; USDC and PYUSD are the only stablecoins; obligations already past
  their threshold are refused. A PYUSD payout above the sleeve (a weekend beyond every stress scenario) waits for the
  keeper to top the sleeve up; the keeper does not swap on Jupiter yet (plan/06).

## Jupiter Lend, the second lender (W12)

Jupiter Lend held about 39% of Solana's tokenized-equity lending in July 2026. Credence covers its xStock positions
too, read from Jupiter's own accounts and paid back through Jupiter's own instruction.

- **Proven first (B2.0):** a program can pay back anyone's Jupiter Lend position through `operate`. On a fork, a PDA
  paid 5,000 USDC into a real SPYx position of another owner (plan/09).
- **Cover:** `buy_cover_jl` reads the position (collateral and debt tick; Fluid's tick math in `risk-core::fluid`,
  bit-exact against Jupiter's SDK), its vault's LT and Jupiter's own price, and settles on Jupiter's oracle, so the
  payout uses the price the position is valued at. Kamino and Jupiter policies net in one loss vector per weekend.
- **Shield and settlement** pay back through `operate`, signed by the vault PDA. Jupiter refuses a payment that leaves a
  position above its threshold, and its debt moves in 0.15% ticks, so a Jupiter policy prices and pays on its debt +
  1%. A capped payout that cannot restore health goes to the owner's wallet.
- **Coverage:** 1,676 Jupiter positions with xStock collateral and debt; **1,045** covered at B2 (SPYx, QQQx, NVDAx
  with USDC debt; JupUSD debt is not covered; TSLAx since W16: 1,197). Both lenders at B2: **1,666** eligible positions (scan Oct 9, totals
  reconciled with each vault's state and Jupiter's API within 0.2%). The app's Risk page lists both side by side.
- **Demo:** `scripts/demo.sh` ends with `keeper/src/jl-demo.ts`: a real Jupiter position covered, shielded (4,781.72
  USDC on Sunday night) and settled (250.24 more on Monday); D/C′ ends at 0.9907. Demo → "Jupiter Lend" in the app.
- **Open question for the weekend:** Jupiter's oracle refuses a stale price in every `operate`, payments included. If
  Jupiter does not refresh its xStock prices over a weekend, nobody can pay back a Jupiter position on Sunday night,
  the shield included. A read-only recorder is watching the Oct 9–12 weekend (plan/06).

## Cover v2: shorts, overnights, holidays, earnings (W11)

- **UP cover for shorts:** a position that borrows an xStock against USDC is hurt by an up gap. UP cover pays
  `min(cap, D × (1 + gap) − C′)` in USDC to the owner's wallet at the open (no shield: USDC cannot repay an xStock
  debt). UP and DOWN policies net in one loss vector (joint set v2: the 192 worst down closures and a 64-scenario up
  tail): a long and a short in the same weekend reserve the larger side, not the sum. 87 SPYx shorts on Kamino (Oct 9).
- **Closure types:** overnight and holiday-weekend epochs, each priced on its own calibrated set, σ and length
  (SPYx σ: overnight 0.69%, weekend 0.94%, holiday 0.80% over 4 days). The keeper opens overnights only with
  `OVERNIGHT_AHEAD` set.
- **Earnings:** an admin calendar per asset multiplies σ for a closure containing a release (1×–8×). Backtest
  (`scripts/src/earnings-backtest.ts`, SEC 8-K Item 2.02 times, 2016–2026): a release night moves 2.85× (MSTR) to
  5.70× (GOOGL) a plain night's σ (plan/09).
- **Multi-collateral and Jupiter cover** sell plain weekends only (no other closure type, no asset with an earnings
  calendar; audit A-63). `quote_cover` with the epoch prices exactly as the purchase does.
- **Not built:** cover for single-stock trading halts (bought with the news known; plan/06).
- **Demo:** `scripts/demo.sh` ends with `keeper/src/cover-v2-demo.ts` (UP + DOWN netted, +8% pays the short 2,617.27
  USDC; overnight −6% → 1,040.95; holiday Dec 24 → 28, −8% → 2,119.63). Demo → "Cover v2" in the app.

## Every listed xStock (W16)

Credence covers the eight xStocks of the plan: SPYx, QQQx, NVDAx, TSLAx, GOOGLx, AAPLx, MSTRx and HOODx, each with
its own WEEKEND, OVERNIGHT and HOLIDAY_WEEKEND sets and σ (TSLAx also on Jupiter Lend as `TSLAx.J`).

| Asset | Scenario sets | WEEKEND σ | OVERNIGHT σ | HOLIDAY σ |
|---|---|---|---|---|
| SPYx | SPY | 0.94% | 0.69% | 0.80% |
| QQQx | SPY, σ × 1.3311 (QQQ/SPY) | 1.03% | 0.75% | 0.87% |
| NVDAx | NVDA | 2.15% | 2.00% | 1.85% |
| TSLAx | TSLA | 2.53% | 2.21% | 3.09% |
| GOOGLx | GOOGL | 1.24% | 1.22% | 1.15% |
| AAPLx | AAPL | 1.45% | 1.28% | 1.30% |
| MSTRx | COIN, σ × 1.2844 (MSTR/COIN) | 4.90% | 4.43% | 3.79% |
| HOODx | COIN, σ × 0.9801 (HOOD/COIN) | 3.74% | 3.38% | 2.89% |

Each σ is floored at the asset's own long-run weekend σ (2016–2026; HOOD from 2021). MSTRx and HOODx, priced on COIN's sets, also
take at least their own last-104-weekend σ (audit A-72): COIN × the ratio gave 3.68% and 2.81%, below MSTR's 4.90% and
HOOD's 3.74%. Eligible positions (scan Oct 9,
the same moment): Kamino 623 → **1,230**, Jupiter Lend 1,045 → **1,197**, both lenders 1,668 → **2,427**. Not covered:
Kamino's CRCLx (listed since 2025, no calibrated history; 93 positions hold it) and JupUSD debt on Jupiter Lend.

`scripts/demo.sh` runs `keeper/src/assets-demo.ts` before Cover v2: `quote_cover` for the same position (C′ 104,167, debt
100,000, cap 25,000 USDC) on every asset, per $1,000 of cover: SPYx 3.34, QQQx 10.13, NVDAx 36.00, TSLAx 70.63, GOOGLx
17.72, AAPLx 25.51, MSTRx 174.29, HOODx 124.71 (122.12 and 84.40 before A-72). Then a real TSLAx obligation (owner field rewritten, borrowed up to D/C′
0.83 through klend) buys weekend cover for 6.49 USDC; TSLAx opens −20.9% (simulated, klend's price band floor) and the
keeper repays 430.04 USDC into it (the start is TSLAx's live Scope price, so these move a little per run).

## Shadow weekend (read-only, mainnet)

`keeper/src/shadow.ts` runs Credence's decision logic against live mainnet over the real Oct 9–12 weekend and sends
**no transactions**: it has no signer at all and reaches the RPC through a read-only wrapper (`app/test/shadow-model.test.ts`
fails if a signer or a send method appears). Every 60 s, for every eligible obligation (the `positions.ts` scan,
refreshed), it logs to `data/shadow/20261009/`: the premium from the program's own pricing (`examples/shadow_quote.rs`,
the same `pricing::premium` and capacity code as `buy_cover`), Kamino's Scope price and the moment it first moves, the
Pyth weekend fair value, what the Liquidation Shield would advance and when (`pricing::shield_target`, α 50%, buffer
2%, health 2%), which positions the move makes liquidatable, what a backstop would buy and at what bonus, and each
position's Gap Cover payout at the real open. `scripts/live/shadow.sh 20261009` runs it unattended (restarts resume
from `state.json`). Results go here after the Monday open.

## Credit unlock (C1, read-only analysis)

**What cover would allow, not measured demand.** Borrowers protect themselves by under-borrowing (debt-weighted median
D/C′ 0.76 on Kamino, 0.71 on Jupiter Lend), so the product is headroom: how much more credit full Gap Cover with the
Liquidation Shield would allow at a target D/C′, at what cost, and with how much LP capital. `scripts/src/unlock.ts`
runs every eligible position of the Oct 9 scan (Kamino 1,230 and Jupiter Lend 1,197: 2,427, $9.01M of debt) through the
program's own pricing (`examples/unlock_quote.rs`: `premium` / `premium_multi` + `shield_loading`, `policy_losses`,
`capacity`, `shield_target`) and writes `data/unlock/unlock-20261009.json` and `.md`; `GET /api/unlock` serves it.

At **D/C′ 0.90**, both lenders (method and every table in the `.md`; plan/09):

| | Kamino | Jupiter Lend | Both |
|---|---:|---:|---:|
| Positions below 0.90 | 1,198 | 1,192 | 2,390 |
| Extra credit cover would allow | $3.16M | $1.33M | **$4.49M** |
| Annualised cover cost, debt-weighted (premium × 52 / extra debt) | 28.5% | 28.5% | 28.5% |
| … positions with ≥ $1k of extra credit (356, $4.18M) | | | 16.9% |
| All-in (borrow APR + cover), debt-weighted | 34.0% | 34.4% | 34.1% |
| P(liquidatable after a weekend) at 0.90 without cover, debt-weighted | 0.47% | 0.17% | 0.36% |
| Residual with cover + Shield, fair value = open | 0.0015% | 0% | 0.001% |
| Residual, Shield's fair value 1 σ_b above the open | 0.29% | 0.09% | 0.22% |
| LP equity for 50% of the unlocked book ($2.29M) | | | **$1.52M** |

- **Cost depends on the asset and the size.** Debt-weighted at 0.90 among positions with ≥ $10k of extra credit:
  QQQx 0.3%, GOOGLx 0.8%, SPYx 1.0% a year; NVDAx, TSLAx, multi-collateral 14–20%; MSTRx 150%. 2,274 of the 2,390
  positions pay the 5 USDC minimum premium (plus loading), which makes the medians meaningless (~290%); the 2,034
  positions with less than $1k of extra credit supply 45% of the premium income.
- **LP capital:** capacity (INV-2) binds before any asset's 50% concentration cap at every target and slice; NVDAx and
  TSLAx come closest. 100% of the 0.90 book ($4.49M) needs $2.48M of LP equity.
- **The Shield's buffer is below σ_b for the volatile assets:** b = 2% while σ_b is 3.3% (TSLAx), 4.8% (HOODx), 6.4%
  (MSTRx). If the weekend fair value reads 1 σ_b above the open, the advance leaves them just over the threshold:
  residual 0.77% (TSLAx), 1.8% (HOODx), 2.8% (MSTRx) at 0.90, against 0 for SPYx, QQQx, NVDAx, GOOGLx, AAPLx.
- **Checks:** the five golden quotes (single Kamino, multi-collateral, PYUSD, SPYx.J, TSLAx.J) equal simulated
  `quote_cover` / `quote_cover_multi` / alias `quote_cover` to the base unit (`tests/unlock.rs`); the capacity bound
  equals the program's own check; every single-asset probability equals the app's `modelPays` / `historyPays`
  (`app/test/unlock.test.ts`); positions and debt reconcile with the scan.
- **Not in the totals:** CRCLx (96 positions), cbBTC (59) and USDG (8) deposits, multi-borrow (28), borrow factor ≠ 100%
  (11) on Kamino; JupUSD debt (480) on Jupiter. Jupiter residuals assume Jupiter's oracle takes the Sunday payback
  (plan/06). Holiday weekends are priced as plain weekends and overnight gaps are not covered.

## Curator book cover (C2)

A curator or vault manager covers a **book** of positions it does not own: Kamino single and multi-collateral (USDC and
PYUSD) and Jupiter Lend positions in one book, for one premium. Payouts and Shield advances only ever go into the
positions; a book never pays a wallet. Design (owner-approved Oct 10): plan/02 "Curator book cover"; decisions:
plan/06 "C2 decisions"; numbers: plan/09 "Phase C, C2".

- **Accounts.** Each leg is a `Policy` at the usual `["policy", epoch, obligation]` PDA (A-01: one cover per position
  per weekend, so a position cannot sit in two books or in a book and its owner's policy), tagged with its `Book`.
- **Flow.** `open_book` → `add_book_leg` / `_multi` / `_jl` (one leg per instruction, after the position's refreshes;
  capacity reserved in the same instruction) → `seal_book` (one premium) → the keeper's `shield_book_leg*` and
  `settle_book_leg*` → `claim_book_refund`. An unsealed book expires after 1 h (or at the bell) and anyone voids it
  (`void_book_leg`): capacity released, escrow back in full.
- **Pricing (`risk-core::book_premium`).** Expected losses add up, the tail term is diversified on the joint stress set
  (never below the riskiest leg's), **one minimum premium per book**, Shield loading summed. A one-leg book is exactly
  the single policy; property tests: never above the legs' standalone premiums, monotone in every leg, order-invariant.
- **Owner precedence.** An owner can always cover its own position: `release_book_leg` + its own `buy_cover*` in one
  transaction (before the bell); the leg's share of the book premium is refunded to the payer, and the payer has no
  way to block it.
- **Refunds (audit A-84).** A leg that cannot be paid (position closed, repaid, a failed CPI past the grace) is refunded
  its share **only if the payout rule owed it something**; otherwise closing a position before the open would be a free
  option on the gap.

**Fork demo** (`scripts/demo.sh` step `book`, `data/demo/book-result.json`; the fresh-clone gate run, Oct 10, weekend
20261113, −8% gap):

| | |
|---|---|
| Book | 22 real positions from the Oct 9 scan: 14 Kamino SPYx (the nearest to their threshold and the largest), 8 Jupiter Lend SPYx (vault 78); 4 TSLAx positions were skipped (liquidated since the scan) |
| Premium | **5.54 USDC for the book vs 110.54 USDC** for the 22 standalone `quote_cover` quotes (−95%): the book pays one minimum premium instead of 22. Its expected loss is 0.057 USDC: the saving on a book of small, mostly far-from-threshold positions is the floors, not diversification |
| Per $ of extra credit (C1, D/C′ 0.90, the 9 legs with C1 extra credit, $326,627) | 0.09% a year for the book vs 1.76% standalone |
| Owner precedence | the owner of `47wNsqpy…` released it and bought its own cover in one transaction (359,076 CU) |
| Closed before the open | `CkftWhyu…` (D/C′ 0.968) repaid in full by its owner on Sunday: paid 0, its share 2.02 USDC refunded (a payout was owed at −8%) |
| −8% weekend | the Shield advanced 38.60 USDC into the 12 near-threshold Kamino legs on Sunday (each left at D/C′ 0.980 at the open, nothing more owed at settlement); the Jupiter legs stayed below their threshold; all 22 legs settled, the group released, keeper 0 failures |
| Compute | Kamino legs in v0 batches with a lookup table: ~249k CU per leg (4 legs ≈ 1.0M per transaction); Jupiter ~183k per leg |

An earlier gate run (Jupiter cache left at another demo's simulated −10%, fixed since) priced a riskier book: 21 legs,
**16,301 vs 16,398 USDC** standalone (−0.6%: near-threshold legs carry real expected loss and Shield loading, which a
book does not discount), and paid **41,726 USDC into three Jupiter positions** through `operate`, never a wallet.

What is simulated: the clock (surfpool time travel), demo wallets' USDC and SOL, two owners (written into real
obligations by cheatcode) and the prices on Sunday and Monday (genuine recorded updates moved −8%). What is real: every
leg is a real mainnet position cloned on the fork, the owner's buy and the full repayment are real klend transactions,
and every Credence instruction is this repo's program.

**App: Curator** (`/app/curator`): pick a market (Kamino xStocks, Sentora, or a Jupiter vault), filter by size and
D/C′, see each position's D/C′, P(liquidatable) today and C1's extra credit at 0.85/0.90, the **book quote next to the
sum of standalone quotes** (`/api/book-quote`, the program's own pricing via `examples/book_quote.rs`), C1's
debt-weighted size buckets, buy in batches with progress (resumable: the book is a PDA, the legs are read back), seal,
claim refunds and follow the book's weekend. Sentora PYUSD legs are quoted there and bought through the keeper path.

## Protect my position (Action) and Friday alerts (C4a)

**What it does.** A Solana Action (spec v2.4, `@solana/actions` 1.6.6) that sells gap protection for one position: GET
`/api/actions/protect?position=…&lender=kamino|jupiter` returns the live quote (the program's own `quote_cover`, or the
buy itself simulated for multi-collateral and Jupiter Lend), POST returns an **unsigned** transaction for the owner (the
Jupiter Lend position's NFT holder) with three caps: the full debt, what a −8% open would need repaid, and what −12%
would. `/actions.json` maps the app to the route; `/app/protect` renders the Action as a Blink (`@dialectlabs/blinks`
0.22.5) inside the app. **Friday alerts** are opt-in: a wallet signs one message (domain, nonce, expiry, channel) and
gets, before the bell of each weekend or holiday closure, one Telegram or browser-push message per position whose −8%
need is over its threshold ("A −8% Monday would need $X … gap protection for this weekend costs $Y … not live; not
insurance"), with a link back to `/app/protect`. Every number is the program's, through one helper (below).

**Real and fork-only.**

| | Real | Fork-only or simulated |
|---|---|---|
| Action metadata, GET quote, transaction layout | The program's pricing; klend refreshes and the buy exactly as the app builds them | The transaction is built against the local fork and carries the fork's chain id (`solana:credence-local-fork`, never a public cluster's). **Wallets render Actions against mainnet, so the demo uses the in-app Blink**, which signs with the demo burner |
| Server | Never signs, never holds a key; the wallet is the only signer and the fee payer | Refuses (403) on the public read-only site |
| Alerts | The Oct 9 mainnet scan's positions, the XNYS calendar, the program's pricing | The vault is a model vault with 2,000,000 USDC of equity; delivery is real Telegram / web push when configured |

**Run it.**

```
FORK_PORT=8909 PORT=3001 scripts/demo-app.sh                      # the fork and the app; open /app/protect
cargo build -p credence-core --example unlock_quote --release      # the pricing helper (once)
pnpm -C keeper alerts --now <unix> --dry                           # the job at a given time with a mocked transport
pnpm -C keeper alerts                                              # every 15 min from cron: sends inside [bell − 4 h, bell)
pnpm -C keeper alerts:telegram                                     # the bot: /start gives a link code, /stop unsubscribes
```

Environment (all in `.env`, **never committed**; the app reads only the public ones): `TELEGRAM_BOT_TOKEN` (keeper only),
`TELEGRAM_BOT_USERNAME`, `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (the private key keeper only),
`ALERTS_APP_URL` (the link in a message), `ALERTS_DOMAINS` (hosts a signed message may name), `ALERTS_DIR`,
`ALERTS_LEAD_SECS`, `ALERTS_MAX_SCAN_AGE_SECS`, `TRUST_PROXY=1` (only behind a proxy that overwrites
`X-Forwarded-For`), `ACTION_BASE_URL`, `ACTION_TIMEOUT_MS`. Subscribers and the sent ledger live in `data/alerts/`
(git-ignored).

**One pricing helper.** The alerts job uses `unlock_quote`'s `assess` op (`examples/unlock/assess.rs`, on C1's
`model::config()`): the closure's own scenario set and σ, its days and the capacity multiplier, as `buy_cover` prices it
(Good Friday = 4-day `HOLIDAY_WEEKEND`, the Wednesday before Thanksgiving = 2-night `OVERNIGHT`). The crate it replaced
(`keeper/alerts-quote`) printed byte-identical numbers on the same inputs.

**Checks.** App unit and attack tests (spec conformance, CORS, rate limit, shape check, nonces, read-only mode, link
codes, locks, service worker), the Action's transaction signed and landed as a Policy on **Kamino** and on **Jupiter
Lend** on the fork (`protect-action.fork.test.ts`), the Blink with Playwright (`e2e/protect.spec.ts`), and a
`next build` grep of `.next` for the values of `MAINNET_RPC` and the Pyth key (0 hits).

**Known limits (C4a).**
- The Action sells **weekend** epochs only; overnight and holiday closures are sold on Borrow. Alerts also fire before
  holiday closures and price them as `buy_cover` would, but their link opens the weekend Action.
- Wallets (Phantom, Backpack) fetch Actions against mainnet: the fork Action is not usable from a wallet, only from the
  in-app Blink, and the public site is read-only.
- Alerts read the Oct 9 scan: positions opened or repaid since are not seen. Delivery is at-least-once if a run is killed
  between a send and its ledger write (A-132); a dead destination is retried once per closure (A-133).
- Lock takeover after a crashed holder is check-then-remove (A-130); a signed message's nonce is spent even when the
  store refuses it (A-131); "unsubscribe" leaves the browser's push subscription (A-134).
- Assumption (no owner call needed): the model vault's equity for alert quotes is 2,000,000 USDC, as in the C1 helper's
  default; a live vault's utilisation would change the premium.

## Gap Oracle feed and SDK (C3)

Other programs and apps can now build on Credence. Everything below runs on the local mainnet fork; nothing is on mainnet.

**`GapFeed` (real on the fork; the mainnet Oracle page computes the same fields off-chain).** One zero-copy account per asset
(`["feed", ticker]`, 224 bytes): the eight xStocks and the Jupiter aliases that exist. `update_gap_feed(ticker)` is a
permissionless crank that reads, from accounts whose addresses the program derives or checks itself, the closure from the
calendar (the one in progress or next), the epoch's stored Friday close, the 24/7 xStock price (Pyth `Crypto.<T>X/USD` push
account, PDA-checked), and the lender's own price (Kamino's Scope, or the Jupiter cache for an alias). It writes the implied
gaps (fair ÷ close − 1 and lender ÷ close − 1), σ of the closure type, **P(gap < −5 / −8 / −12%)** from the asset's scenario
set (`risk-core::gap_prob`, the rule the app's "chance this pays anything" uses), flags, and when it ran. No funds move (no
signer, no token program, no CPI); an input that is missing is a flag and a 0, never a default; a wrong account fails the
instruction (8 attack tests, and each of five removed checks made its test fail). A feed is rate-limited to one update per
`min_update_slots`; the crank still runs when the protocol is paused and sets `PAUSED`. **Frozen** means the lender's value has not changed for
30 minutes after the close as the cranks saw it (Scope's refresh time keeps advancing while its value is frozen).
Compute: **~26.5k CU** per update (Kamino asset and Jupiter alias alike; 24–41k across assets on the fork).
Not done in v1: the earnings bump is not applied to σ (the feed sets `EARNINGS_ASSET`); the Shield buffer decision is still open.

**Sample consumer, `programs/gap-consumer` (fork only).** A toy lender reads a `GapFeed` by account data (no CPI) and sets
`ltv_weekend = max(floor, base × (1 − k × P(gap < −8%)))`, rounded toward the lower LTV. It refuses a wrong owner, a wrong
ticker PDA, a feed never updated, older than its bound, about a closure that is not a weekend, or carrying any blocking flag.
An example of reading the feed, not a recommendation.

**`@credence/sdk` (`packages/sdk`, not published).** Reads (feeds, policies, books and legs, epochs, the vault, positions,
every event), quotes (the program's own `quote_cover*` in a simulation; a book through the program's pricing via the app's
`/api/book-quote` or a spawned `examples/book_quote.rs`, equal field for field), unsigned builders (owner `buyCover` for every
lender with `release_book_leg` first for a book leg, the book flow with resumable batches, `updateGapFeed`; Jupiter's
program never shares a transaction with klend), typed errors, and an IDL/layout check that refuses a different program. The app now
uses it: its chain library is the SDK's, the Action route builds through `buyCover`, the Curator page builds book
instructions with it. README, CHANGELOG and runnable examples: [packages/sdk/README.md](packages/sdk/README.md).

**Oracle page, all eight assets.** Risk → *Gap Oracle feed*: per asset the Friday close, the 24/7 price, the lender's price and
whether it is frozen, the implied gaps, the three probabilities, staleness and flags, with **Crank** (sends `update_gap_feed`
from the connected demo wallet). The public read-only mode shows the same fields computed off-chain by the program's Rust from
mainnet inputs (`scripts/src/gap-feed-mainnet.ts` → `examples/gap_feed.rs`), labelled "computed off-chain from mainnet data;
the feed account is not on mainnet". A second recorder (`scripts/src/record-prices-more.ts`) records the five assets the
first one does not, from Oct 10 03:30 UTC; their "frozen" flag needs 30 minutes of history.

| | Real | Fork only |
|---|---|---|
| Inputs (Scope, Pyth push accounts, Jupiter cache, calendar, scenario sets) | mainnet accounts, read | — |
| The `GapFeed` account, the crank, the consumer | program tested in LiteSVM with the real klend and Jupiter binaries | deployed on the fork |
| Oracle page numbers on mainnet | computed off-chain with the program's Rust | — |

## Measured

Everything below was read from mainnet or measured on the fork; the data files are in the repo.

**When Kamino's xStock price moves** (Kamino API hourly reserve history, `scripts/src/s7-history.ts` →
`data/live/s7-history.json`; live Scope recorder every 10 s, `data/live/events-*.jsonl`):

| Weekend (Fri) | SPYx | NVDAx | QQQx |
|---|---|---|---|
| Aug 28 | flat until Mon 14:00 UTC | first move Mon 13:00; −0.46% by the open | first move Mon 12:00 |
| Sep 4 (Labor Day) | flat through Mon | flat | flat |
| Sep 11 | first move Mon 12:00; −0.67% by the open | first move Mon 12:00; **−3.99% by the open** | moves all weekend |
| Sep 18 | first move Mon 13:00; +0.64% | Mon 13:00; +1.06% | Mon 13:00; +1.26% |
| Sep 25 | flat until Mon 14:00 | flat until Mon 14:00 | flat until Mon 14:00 |
| Oct 2 | first move Mon 12:00; +0.16% | Mon 12:00; +1.22% | moves all weekend |

SPYx and NVDAx did not change once between Friday 20:00 and Monday 11:00 UTC in six weekends; Scope refreshes the
timestamp, not the value. The gap reaches Kamino in pre-market (8–9 AM ET), before the 9:30 open. Kamino's xStock price
is `CappedFloored(MostRecentOf(Chainlink Data Streams, Pyth Lazer))` in Scope (`3t4JZcue…`; chains SPYx 344, QQQx 347,
NVDAx 332); Chainlink's 24/5 feeds publish nothing at weekends, which explains the freeze.

**Who is exposed** (`scripts/src/positions.ts` → `data/positions/positions-20261007.json`, Oct 7 22:20 UTC): 7,015
obligations in the xStocks Market, 32 in Sentora. 908 borrow USDC against SPYx, QQQx or NVDAx: $3.11M of debt on $9.08M
of collateral. 531 fit Phase 1 (one xStock deposit, one USDC borrow): $1.22M of debt. Reserve totals match the Kamino
API within 0.0002%. Kamino API, Oct 7: about $25.6M of xStock collateral and $7.1M of stablecoin debt across the two
xStocks markets; the Sentora market (Kraken's xStocks Vaults) carries $1.93M of debt on $3.13M.

**Kamino integration.** A third-party program can repay a Kamino obligation with `repay_obligation_liquidity_v2` by CPI
(v1 instructions reject CPI); proven on a mainnet fork, debt 305,265.73 → 295,265.73 USDC for a 10,000 USDC repay. The
xStocks Market's USDC reserve has a delegated debt farm, so the repay needs the obligation's farm user state. klend
repays with stale prices; a paused market (`emergency_mode`) blocks it, which `settle_policy_to_wallet` covers.

**Pricing sweep (Day 5,** `programs/credence-core/examples/backtest.rs` with `BT_*` overrides). Book A: D/C′ 0.80–0.98,
$25k policies; C: 0.90–0.99, $100k. Demo position: SPYx, $50k at D/C′ 0.96.

| Parameters | LP %/yr (A / C) | Loss ratio (A / C) | Worst weekend (A / C) | Demo premium | P(pays) |
|---|---|---|---|---|---|
| θ 0.2, $1 minimum, recent σ (before Day 5) | 0.25% / — | 73% / — | −1.98% / — | $1.00 | 0.10% |
| θ 1.0, $5, recent σ | 1.73% / 9.75% | 28% / 46% | −1.95% / −16.6% | $5.00 | 0.10% |
| **θ 1.0, $5, σ floor (deployed)** | **2.17% / 15.6%** | **41% / 42%** | **−3.92% / −21.4%** | **$8.75** | **0.63%** |
| θ 1.0, $10, σ floor | 3.44% / 16.1% | 31% / 41% | −3.90% / −21.4% | $10.00 | 0.63% |
| θ 1.5, $5, σ floor | 2.80% / 22.1% | 35% / 34% | −3.91% / −21.3% | $10.90 | 0.63% |

Worst weekend in every case: 2019-01-28 (NVDA −13.6%). σ floor (`scripts/src/sigma-floor.ts`): root mean square of the
Friday-close → Monday-open log gap over the 484 plain weekends 2016–2026, SPY 0.942%, QQQ 1.028%, NVDA 2.151%. The
floor is applied to a scenario set already standardised by the recency-weighted σ, so tails may be counted twice:
conservative for LPs, dearer for borrowers; revisit with a regime-aware σ before mainnet.

**Fresh clone (Oct 8, after the audit, `6915cea`).** `anchor build --arch v0` 1 min 47 s. Without `.env`,
`scripts/test.sh` runs 125 tests (the 18 real-klend tests need the klend and farms binaries, which it fetches when
`MAINNET_RPC` is set). With only `.env` copied in: `scripts/test.sh` 143 passed, 2 ignored (1 min 9 s);
`scripts/demo.sh` 80 s (keeper 6 transactions, 0 failed, settle 252,477 CU); `scripts/demo-app.sh` ready in 86 s; app
unit tests 18 passed; Playwright 6/6 in 1.2 min.

**Fresh clone of the rebuilt app (Oct 8, `fca2da5`).** With only `.env` copied in (program and IDL from the same
unchanged `programs/` build; the Rust suite was not re-run there because its 10 GB build did not fit the disk):
`scripts/demo-app.sh` ready in 212 s (dependency installs included); app unit tests 31 passed; Playwright 8/8 in
2.2 min; `scripts/demo.sh` 72 s (keeper 6 transactions, 0 failed). On the working repo the suite was also green twice in
a row on a fresh fork (8/8, 3.1 and 1.8 min).
