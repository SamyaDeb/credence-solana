# Credence (Solana)

**Weekend gap protection for tokenized-stock loans on Kamino.** xStocks trade 24/7, but the price Kamino lends against
stops moving at Friday's 4 PM close and jumps at Monday's open (measured: frozen for six weekends in a row, plan/09 S7).
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
anchor build --arch v0      # program + IDL (SBPF v0: v3 is not active on mainnet, plan/09 S1)
scripts/test.sh             # LiteSVM suite: 133 tests, 2 ignored (live). Fetches the klend + farms binaries once (BUSL-1.1, never committed)
scripts/demo.sh             # one simulated weekend on a fresh mainnet fork, end to end, about 1 minute
scripts/demo-app.sh         # fresh fork + data + demo LPs + epochs, then the app on http://localhost:3000 (about 50 s)
cd app && pnpm test         # unit: golden payout vectors vs Rust, keeper parity, vault bytes, pay odds
cd app && pnpm test:e2e     # Playwright happy path against the running demo-app.sh (3 tests)
```

Without `.env`, `scripts/test.sh` runs the 117 tests that do not need the klend binaries and says what it skipped.

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
| Design and plan | `plan/` (start with [plan/02](plan/02-mechanism-design.md) and [plan/03](plan/03-architecture.md)) |

## Pricing (decided Day 5)

θ = 1.0, c = 10%, η = 1, β = 97.5%, u_max = 50%, minimum premium 5 USDC, fee 0, and a **σ floor**: σ = max(recent,
long-run 2016–2026 weekend σ) per asset (SPY 0.94%, QQQ 1.03%, NVDA 2.15%), so a calm recent market does not price
Mar 2020 or Apr 2025 as rare. Backtest of a model book (120 policies, D/C′ 0.80–0.98, $25k each, $2M of LP equity)
through ten years of dated weekend shocks (`data/backtest/gap-cover-backtest.json`): **2.2% a year on LP equity, loss
ratio 41%, worst weekend −3.9% of equity** (2019-01-28, NVDA −13.6%). The demo position ($50k at D/C′ 0.96) costs
8.6–8.8 USDC (depending on vault utilisation), and the app shows next to it a **0.63%** modelled chance of any payout and **2 of 571** real closures
since Apr 2016 that would have paid (both March 2020). Sweep and alternatives: plan/09 "Day 5 findings".

## What is real and what is simulated

| Part | Real | Simulated or substituted |
|---|---|---|
| Kamino (klend) | Mainnet klend and farms binaries, real xStocks Market accounts and obligations (cloned on first use by the surfpool fork); the repay is a real CPI into klend signed by the vault PDA | The demo position is a real near-threshold obligation, but its owner field is rewritten on the fork so the demo wallet can sign `buy_cover`. In the LiteSVM tests, Scope timestamps are re-stamped after the test clock moves (test-only helper) |
| Vault and LPs | Program logic, share math, queues | Demo wallets' USDC comes from a fork cheatcode |
| Friday close and Monday settlement price | Kamino's own oracle: the program reads Kamino's Scope `OraclePrices` account (Chainlink Data Streams + Pyth Pro), the same price klend liquidates on. The live checkpoints capture the real Oct 9 close and Oct 12 open from raw mainnet reads of that account (results in plan/09) | Pyth push accounts (`XSTOCK`) remain as a fallback; the planned `Equity.US` settlement (`EQUITY`) needs a paid Pyth equities plan (plan/06) |
| Time | Real exchange calendar (XNYS sessions, holidays, half days); real epoch times | The fork's clock jumps to the Friday close and the Monday open (surfpool time travel) |
| The weekend's prices in the demo | Friday close: Kamino's real Scope price (the genuine reading from the real close once the recorder has it; before that, the live Scope value cloned at the start) | Before Oct 9, the close's refresh time is moved to the bell; the Monday open is Kamino's Scope price moved by `DEMO_GAP` (default −8%), which klend also sees. Every demo run lists what it simulated in `data/demo/demo-result.json`; the app lists it on the Demo mode page |
| App demo positions | Real near-threshold mainnet obligations (owner field rewritten on the fork, as above) | The bigger demo position is created on the fork: SPYx given to the demo keeper by cheatcode, then a real klend deposit + borrow, then its owner field set to your wallet |
| Fork upkeep (app and keeper) | — | Scope refresh times are moved to the fork clock before klend refreshes (prices unchanged); after a simulated gap the Scope TWAP is set to the spot price; accounts the fork has never seen are marked local-only before a transaction |
| Gap Oracle page | Kamino's Scope price and the Pyth `Crypto.<T>X/USD` push updates, genuine mainnet readings by the recorder (every 10 s) | The Friday close shown from the fork's epoch is labelled simulated unless it equals the captured real close |
| Pricing data | Scenario sets, joint stress set and σ calibrated on Alpaca SIP data, Jan 2016 to Sept 2026; σ floor and closure gaps from Yahoo daily bars | — (personal-use licence, see Known limits) |

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

Measured on the surfpool mainnet fork with real klend (whole transactions including klend's refreshes), plan/09:

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
  of five weekends, plan/09 S7), so a position can be liquidated before Phase 1 settles. Phase 1 promises gap
  compensation into the position; the Liquidation Shield (Phase 2) repays before about 7 AM ET.
- **Single collateral, USDC debt.** One xStock deposit against one USDC borrow (531 of 908 positions on Oct 7, $1.22M of
  $3.11M debt). Multi-collateral and PYUSD (Sentora market) are Phase 2.
- **One policy per obligation per weekend relies on the owner key** (plan/06 has the proposed seed change).
- **Data licence.** The calibration uses Alpaca SIP data under a free personal licence, not cleared for commercial use.
- **Local fork only.** Not deployed to devnet or mainnet; xStock mints are mainnet-only.
- QQQx's Kamino price moves over weekends (its Scope chain follows a 24/7 source), so its gap is not concentrated at
  the open; it is listed but treated with caution (plan/06).

## Prior work

This repository was started on Oct 7, 2026. It reuses, from the EVM Credence Finance prototype (Robinhood Chain
testnet and Arbitrum Sepolia, started Sept 27, 2026): the `risk-core` fixed-point math crate (unmodified), the
mechanism design (Gap Cover, the Friday bell, the reopen backstop), and the scenario, joint-set and σ calibration data
(Alpaca SIP, personal licence; `data/README.md`). New for Solana: the Anchor program, the Kamino integration (obligation
snapshot, repay CPI), the Scope oracle path, the keeper, the data jobs, the app and the pricing changes of Day 5.

## Status (Oct 8, 2026)

Days 1–4 and Day 5 pricing done. Live checkpoints running: the real Oct 9 close (Sat 01:25 IST), S7 over the weekend,
the first post-closure prices (Mon 05:30 IST) and the real Monday settlement (Mon 19:00 IST) go into plan/09 and here.

## The plan

| # | File | What it covers |
|---|---|---|
| 0 | [plan/00-decision-new-repo.md](plan/00-decision-new-repo.md) | Why a new repo instead of converting the EVM one, and what carries over |
| 1 | [plan/01-product.md](plan/01-product.md) | The problem, the product, the market, the competition, the business model |
| 2 | [plan/02-mechanism-design.md](plan/02-mechanism-design.md) | Gap Cover, the vault, the oracle and the backstop: the math and the invariants |
| 3 | [plan/03-architecture.md](plan/03-architecture.md) | Accounts, instructions, oracles, Kamino integration, Token-2022, keeper, app |
| 4 | [plan/04-implementation-phases.md](plan/04-implementation-phases.md) | Build phases with acceptance criteria |
| 5 | [plan/05-hackathon.md](plan/05-hackathon.md) | Deadline, demo script, pitch outline, disclosure |
| 6 | [plan/06-risks-and-open-questions.md](plan/06-risks-and-open-questions.md) | Risks, decisions and their reasons |
| 7 | [plan/07-repo-layout-and-setup.md](plan/07-repo-layout-and-setup.md) | Folder structure, toolchain, commands |
| 8 | [plan/08-research-and-decision-log.md](plan/08-research-and-decision-log.md) | How the idea was chosen, sources |
| 9 | [plan/09-verification-results.md](plan/09-verification-results.md) | Everything measured: compute, Kamino, oracles, S7, backtest, Day 5 pricing |
