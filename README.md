# Credence (Solana)

**Weekend gap protection for tokenized-stock loans on Kamino.** xStocks trade 24/7, but the price Kamino lends against
stops moving at Friday's 4 PM close and jumps at Monday's open (measured: frozen for six weekends in a row, see [Measured](#measured)).
A borrower near the liquidation threshold cannot react to a gap that has not been priced yet, and a stop-loss cannot
fire on a frozen price. Credence sells, before the Friday bell, protection that pays into the borrower's Kamino
position after the Monday open: exactly the repayment needed to bring it back to its liquidation threshold, capped by
the policy. Premiums are priced on-chain from ten years of weekend gaps; LPs underwrite them in a USDC vault. This is
lending-risk infrastructure for tokenized stocks on Solana: the oracle, the cover and the vault, with a Liquidation
Shield before pre-market next.

Program id (all clusters): **`xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q`** (`programs/credence-core`, Anchor 1.2.1).
Phase 1 runs on a local mainnet fork with real Kamino state; it is not deployed to mainnet.

Videos: demo and pitch links are added here before submission.

## Run it

Needs Agave 4.3.x (`scripts/env.sh` checks and fails fast otherwise), Anchor 1.2.1, Node 22 with pnpm, surfpool
(`scripts/fork/surfpool.sh` finds or installs it) and `.env` with `MAINNET_RPC` (any mainnet RPC; it stays server side).

```bash
anchor build --arch v0      # program + IDL (SBPF v0: the SBPFv3 feature is not active on mainnet)
scripts/test.sh             # LiteSVM suite: 143 tests, 2 ignored (live). Fetches the klend + farms binaries once (BUSL-1.1, never committed)
scripts/demo.sh             # one simulated weekend on a fresh mainnet fork, end to end, about 1 minute
scripts/demo-app.sh         # fresh fork + data + demo LPs + epochs, then the app on http://localhost:3000 (about 50 s)
cd app && pnpm test         # unit: golden payout vectors vs Rust, keeper parity, vault bytes, pay odds
cd app && pnpm test:e2e     # Playwright against the running demo-app.sh: happy path and failure paths (6 tests)
```

Without `.env`, `scripts/test.sh` runs the 125 tests that do not need the klend binaries and says what it skipped.

### In the app (1440 px or wider records best)

1. **Connect → Demo burner wallet** (a local keypair, for judges without Phantom; Phantom works through the wallet
   standard), then **Fund (fork)**: 10 SOL and 50,000 USDC by a fork cheatcode.
2. **Demo mode → Create position (fork)**: a $50,000-debt SPYx position at D/C′ 0.96, opened through klend on the fork
   and given to your wallet. Or **My weekend risk → Use a real mainnet position**.
3. **My weekend risk**: the position after a klend refresh, the loss table at −5/−8/−12%, the premium from a simulated
   `quote_cover` with **the chance it pays anything** (the model's, and how many real closures since 2016 would have
   paid), and **Buy gap protection** (refresh ×2 + `buy_cover` in one transaction; the Policy is read back).
4. **Demo mode → Friday close → Monday open with gap −8% → Settle**: each transaction with its compute units; the payout
   is repaid into the obligation. Repeat for the next weekend on the same fork.
5. **Underwriters** (vault, LP deposit/withdraw queue, backtest) and **Gap Oracle** (Friday close, Kamino's frozen
   price, the 24/7 xStock price, implied gap, S7).

The app owns its connection to the fork and asks the wallet only to sign. Server routes only run fork cheatcodes, read
`data/` and run the keeper's demo steps; `MAINNET_RPC` never reaches the browser. Screenshots: [docs/app](docs/app).

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
| App (Next.js): My weekend risk, Underwriters, Gap Oracle, Demo mode | `app/` |

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
| Fork upkeep (app and keeper) | — | Scope refresh times are moved to the fork clock before klend refreshes (prices unchanged); after a simulated gap the Scope TWAP is set to the spot price; accounts the fork has never seen are marked local-only before a transaction |
| Gap Oracle page | Kamino's Scope price and the Pyth `Crypto.<T>X/USD` push updates, genuine mainnet readings by the recorder (every 10 s) | The Friday close shown from the fork's epoch is labelled simulated unless it equals the captured real close |
| Pricing data | Scenario sets, joint stress set and σ calibrated on Alpaca SIP data, Jan 2016 to Sept 2026; σ floor and closure gaps from Yahoo daily bars | — (personal-use licence, see Known limits) |
| Shadow weekend (`keeper/src/shadow.ts`) | Every eligible real obligation, Kamino's Scope price and the Pyth push updates, read from mainnet every 60 s over the real Oct 9–12 weekend; premiums, shield sizes and payouts from the program's own pricing code | What Credence *would* have done: no transaction is sent, no cover was sold. Premiums assume a model $2M vault covering each position's whole debt; the backstop's buys use klend's liquidation rule as read from its source |

## Invariants and where they are tested

| | Invariant | Test (`programs/credence-core/tests/`) |
|---|---|---|
| INV-1 | payout ≤ max_payout | `settle.rs::inv1_payout_never_exceeds_cap` |
| INV-2 | reserved worst-case losses ≤ u_max × equity at every policy write | `cover.rs::inv2_holds`, `inv2_capacity_refused` |
| INV-3 | no policy after the bell | `cover.rs::inv3_no_sales_after_bell` |
| INV-4 | settlement only on prices published inside the window | `settlement.rs::inv4_settlement_rejects_updates_outside_window` |
| INV-5 | a deposit or withdrawal never lowers NAV per share (book equity, donation-proof) | `vault.rs::inv5_deposit_does_not_dilute`, `queue.rs::inv5_queued_deposit_and_withdrawal_never_lower_nav` |
| INV-6 | withdrawals for a weekend are paid only after it settles (or is voided) | `queue.rs::inv6_withdrawal_paid_only_after_its_group_settles`, `inv6_withdrawal_paid_after_group_voided` |
| INV-7 | a payout into an obligation only reduces its debt; the rest goes to the owner | `settle.rs::inv7_payout_only_reduces_debt_rest_to_wallet` |
| INV-8 | backstop inventory (Phase 2) | — |

## Compute units

Measured on the surfpool mainnet fork with real klend (whole transactions including klend's refreshes):

| Transaction | CU |
|---|---|
| `refresh_reserve` ×2 + `refresh_obligation` + `buy_cover` | 161,000 (LiteSVM 170–180k) |
| `refresh` ×3 + `settle_policy` with the klend repay v2 CPI (USDC debt farm) | 250,000–254,000 |
| `quote_cover` (3,000-point set, capacity included) | 44k–60k typical; worst case 281k (NVDAx at D/C′ 0.995) |
| `snapshot_close` (Kamino Scope) | 11,000–16,000 |
| `post_settlement` (Kamino Scope) | 12,800–18,000 |
| `open_epoch` / `process_deposit` / `process_withdrawal` | 18–22k / 28–31k / 26–30k |

Budget: 900k per instruction, 1.4M per transaction.

## Known limits (Phase 1)

- **Pays after the open, not before liquidation.** Kamino's xStock price moves in Monday pre-market (8–9 AM ET in four
  of five weekends, see [Measured](#measured)), so a position can be liquidated before Phase 1 settles. Phase 1 promises gap
  compensation into the position; the Liquidation Shield (Phase 2) repays before about 7 AM ET.
- **Single collateral, USDC debt.** One xStock deposit against one USDC borrow (531 of 908 positions on Oct 7, $1.22M of
  $3.11M debt). Multi-collateral and PYUSD (Sentora market) are Phase 2.
- **Beyond every stress scenario, first settled is paid first.** Capacity (INV-2) holds the worst of 256 joint stress
  weekends within half of LP equity. A weekend worse than all of them can owe more than equity: policies are then paid
  in settlement order until equity and that weekend's premiums run out, and the rest get what remains (the shortfall is
  in the `PolicySettled` event). A pro-rata haircut is Phase 2. A vault whose equity reaches zero cannot be
  recapitalised (queued deposits are refunded); it would be replaced.
- **Data licence.** The calibration uses Alpaca SIP data under a free personal licence, not cleared for commercial use.
- **Local fork only.** Not deployed to devnet or mainnet; xStock mints are mainnet-only.
- QQQx's Kamino price moves over weekends (its Scope chain follows a 24/7 source), so its gap is not concentrated at
  the open; it is listed but treated with caution.

## Audit

An internal audit before submission (attack first as a failing test, then the fix, one commit each), plus `clippy`, a
code review and a security review as second opinions: 20 findings (1 high, 7 medium, 8 low, 4 info), 17 fixed, 3
recorded as known limits. Table with each finding, its fix commit and its test: [docs/audit/phase1-audit.md](docs/audit/phase1-audit.md).
The high one: an obligation that changed owner before the bell could carry a second policy for the same weekend; the
Policy PDA is now `["policy", epoch, obligation]`. Only the keeper stores the Friday close and the settlement price.

## Prior work

This repository was started on Oct 7, 2026. It reuses, from the EVM Credence Finance prototype (Robinhood Chain
testnet and Arbitrum Sepolia, started Sept 27, 2026): the `risk-core` fixed-point math crate (unmodified), the
mechanism design (Gap Cover, the Friday bell, the reopen backstop), and the scenario, joint-set and σ calibration data
(Alpaca SIP, personal licence; `data/README.md`). New for Solana: the Anchor program, the Kamino integration (obligation
snapshot, repay CPI), the Scope oracle path, the keeper, the data jobs, the app and the pricing changes of Day 5.

## Status (Oct 8, 2026)

Days 1–4, Day 5 pricing and the audit done. Live checkpoints running: the real Oct 9 close (Sat 01:25 IST), S7 over the weekend,
the first post-closure prices (Mon 05:30 IST) and the real Monday settlement (Mon 19:00 IST) go here.

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
