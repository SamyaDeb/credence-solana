# Credence

**Weekend gap protection for tokenized-stock loans on Kamino.**

xStocks trade around the clock, but the price Kamino lends against stops at Friday's 4 PM ET close and jumps when the
market reopens. A borrower close to the liquidation threshold cannot react to a gap that has not been priced yet, and
a stop-loss cannot fire on a frozen price.

Credence sells one-weekend protection before the Friday bell. After the Monday open it repays into the borrower's
Kamino position exactly what brings the loan back to its liquidation threshold, up to the policy's cap. Premiums are
priced on-chain from ten years of weekend gaps, and liquidity providers underwrite the risk in a USDC vault.

| | |
|---|---|
| Program | `credence_core` (Anchor 1.2.1) |
| Program ID | `xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q` |
| Lending venue | Kamino Lend, xStocks Market (SPYx, QQQx, NVDAx against USDC) |
| Oracle | Kamino's Scope price (the same price Kamino liquidates on), with Pyth as fallback |
| Status | Runs end to end on a local mainnet fork against real Kamino state. Not deployed to mainnet. |

## Contents

- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [The app](#the-app)
- [Pricing](#pricing)
- [Security](#security)
- [Performance](#performance)
- [Research](#research)
- [Limitations](#limitations)
- [Roadmap](#roadmap)

## How it works

```
 Friday, before the bell (until 15 min before 4 PM ET)     Monday, after the 9:30 AM ET open
 ─────────────────────────────────────────────────         ──────────────────────────────────────────────
 borrower ── refresh_reserve ×2, refresh_obligation,       keeper ── post_settlement (Kamino's Scope price,
             buy_cover(max_payout, max_premium) ──┐                  first update inside the window)
                                                  │        anyone ── refresh ×3, settle_policy ──┐
   credence_core                                  ▼                                              ▼
   ├─ reads the Kamino obligation (debt with interest, C′ = LT × collateral)   payout = min(cap, D − C′ · open / close)
   ├─ premium from the asset's 3,000-scenario weekend set                      repaid into the obligation through a
   ├─ capacity: 256 joint stress weekends ≤ 50% of vault equity                vault-signed Kamino repay CPI; any
   └─ USDC premium → vault, Policy account                                     remainder goes to the owner
 keeper ── snapshot_close at 4 PM (Kamino's Scope price)    LPs ── deposit / queued withdrawal, paid after settlement
```

1. **Quote and buy.** Before the bell, a borrower buys cover for one Kamino obligation. The program reads the
   obligation directly, prices the policy over the asset's scenario set, checks vault capacity and records a Policy.
2. **Close.** At 4 PM ET the keeper stores Kamino's Scope price as the Friday close. No policy can be sold after the bell.
3. **Settle.** After the open, the keeper posts the first price published inside the settlement window. Anyone can then
   settle a policy: the payout is repaid into the obligation by a CPI to Kamino, signed by the vault.
4. **Underwrite.** LPs deposit USDC and receive shares. Deposits and withdrawals made during a live weekend are queued
   and processed after it settles.

If the close or the settlement price is missed, the weekend is voided and premiums are refunded.

## Repository layout

| Path | Contents |
|---|---|
| `programs/credence-core` | Anchor program: config, assets, scenario and joint sets, exchange calendar, epochs, cover, settlement, vault and queues |
| `crates/risk-core` | `no_std` fixed-point risk math: gap factors, premium, expected shortfall, capacity. Property and golden tests |
| `keeper/` | Off-chain keeper: opens epochs, snapshots the close, posts settlement, settles policies, processes queues |
| `app/` | Next.js app: landing page and the borrower, underwriter and risk dashboards |
| `scripts/` | Data jobs (on-chain data generation, positions scan, oracle recorders, σ floor) and fork tooling |
| `data/` | Calibrated scenario sets, joint stress set, σ, calendars, backtest and mainnet snapshots ([data/README.md](data/README.md)) |
| `docs/` | Security audit and app screenshots |

## Getting started

### Prerequisites

- Agave 4.3.x (`scripts/env.sh` checks the toolchain)
- Anchor 1.2.1
- Node 22 and pnpm
- [surfpool](https://github.com/txtx/surfpool) for the mainnet fork (`scripts/fork/surfpool.sh` installs it if missing)
- A mainnet RPC URL in `.env` as `MAINNET_RPC` (used server-side only)

### Build and test

```bash
anchor build --arch v0   # program + IDL (SBPF v0, the version active on mainnet)
scripts/test.sh          # program suite on LiteSVM: 143 tests (+2 live tests, ignored by default)
```

The tests that run against the real Kamino program download the klend and farms binaries on first use (BUSL-1.1, not
committed); this needs `MAINNET_RPC`. Without it, `scripts/test.sh` runs the remaining 125 tests and reports what it
skipped.

### Run on a mainnet fork

```bash
scripts/demo.sh          # one simulated weekend end to end on a fresh fork (~1 min)
scripts/demo-app.sh      # fresh fork, data, demo LPs and epochs, then the app on http://localhost:3000
```

### App tests

```bash
cd app
pnpm test                # unit: payout vectors vs Rust, keeper parity, vault accounts, odds, Kamino reserve figures
pnpm test:e2e            # Playwright, against a running scripts/demo-app.sh
```

## The app

The landing page is at `/` and the app at `/app`.

| Page | Purpose |
|---|---|
| Overview | Your Kamino xStocks positions with cover status, the coming weekend's schedule, your LP position, recent activity |
| Markets | SPYx, QQQx and NVDAx on Kamino: price, LTV limits, deposits, USDC borrow rate, σ, modelled worst gap, cover price |
| Borrow | Weekend check per position, Kamino deposit / borrow / repay / withdraw, loss table at −5 / −8 / −12%, **Buy gap cover** |
| Underwrite | The vault, deposits and queued withdrawals, weekends as epochs, the backtest |
| Risk | Gap Oracle (Friday close, Kamino's frozen price, the 24/7 xStock price, implied gap), capacity and concentration |
| Alerts | Close approaching on an uncovered position, cover bought, settlement posted, payout received, LP ticket ready |
| Account, Settings | Wallet, balances, policies, payouts, LP shares; local preferences |
| Faucet, Demo *(fork only)* | Fund a wallet, create a demo position, step through Friday close → Monday open → settlement |

Every transaction is simulated before it is signed and shows its signature and compute units. Server routes build
Kamino instructions with klend-sdk and never expose `MAINNET_RPC` to the browser. Screenshots: [docs/app](docs/app).

### Read-only mainnet mode

Building with `NEXT_PUBLIC_NETWORK=mainnet` produces a public, read-only view of Solana mainnet:

- the browser reads mainnet through the app's `/api/rpc` proxy, which allows read methods only;
- **Risk** shows the Gap Oracle live and scans the weekend exposure of Kamino's xStocks borrowers;
- **Markets** and **Overview** read Kamino's reserves and the connected wallet's positions;
- nothing is signed or sent, and fork-only pages are hidden.

To deploy on Vercel, set the root directory to `app` and set `NEXT_PUBLIC_NETWORK=mainnet` and `MAINNET_RPC`
(server-only).

## Pricing

Premium = max(minimum, m(u) × [(1 + θ) · E[L] + c · τ · ES₉₇.₅]), computed on-chain over the asset's 3,000-scenario set,
where m(u) = 1 + η u² loads for vault utilisation.

| Parameter | Value |
|---|---|
| θ (expected-loss loading) | 1.0 |
| c (cost of capital) | 10% a year |
| η (utilisation loading) | 1 |
| β (expected-shortfall level) | 97.5% |
| u_max (capacity) | 50% of vault equity |
| Minimum premium | 5 USDC |
| σ | max(recent, long-run 2016–2026 weekend σ): SPY 0.94%, QQQ 1.03%, NVDA 2.15% |

**Backtest.** A model book of 120 policies ($25k each, debt-to-threshold 0.80–0.98) on $2M of LP equity, replayed
through ten years of dated weekends: **2.2% a year on LP equity, 41% loss ratio, worst weekend −3.9% of equity**
(2019-01-28, NVDA −13.6%). A $50k SPYx position at 96% of its threshold pays about 8.7 USDC for a weekend, with a
0.63% modelled chance of any payout. Data: [data/backtest](data/backtest).

## Security

### Invariants

| | Invariant | Test (`programs/credence-core/tests/`) |
|---|---|---|
| INV-1 | A payout never exceeds the policy's cap | `settle.rs::inv1_payout_never_exceeds_cap` |
| INV-2 | Reserved worst-case losses ≤ u_max × equity at every policy write | `cover.rs::inv2_holds`, `inv2_capacity_refused` |
| INV-3 | No policy is sold after the bell | `cover.rs::inv3_no_sales_after_bell` |
| INV-4 | Settlement uses only prices published inside the window | `settlement.rs::inv4_settlement_rejects_updates_outside_window` |
| INV-5 | A deposit or withdrawal never lowers NAV per share | `vault.rs::inv5_deposit_does_not_dilute`, `queue.rs::inv5_…` |
| INV-6 | Withdrawals for a weekend are paid only after it settles or is voided | `queue.rs::inv6_…` |
| INV-7 | A payout only reduces the obligation's debt; any remainder goes to the owner | `settle.rs::inv7_payout_only_reduces_debt_rest_to_wallet` |

### Audit

An internal audit wrote each attack as a failing test before fixing it. It found 20 issues (1 high, 7 medium, 8 low,
4 info): 17 are fixed and 3 are documented limitations. Full report: [docs/audit/phase1-audit.md](docs/audit/phase1-audit.md).

Only the keeper can store the Friday close and the settlement price. The RPC proxy, the server routes and the build
output were checked for secret leakage.

## Performance

Measured on a mainnet fork with the real Kamino program (whole transactions, including Kamino's refreshes):

| Transaction | Compute units |
|---|---|
| `refresh_reserve` ×2 + `refresh_obligation` + `buy_cover` | ~161,000 |
| `refresh` ×3 + `settle_policy` with the Kamino repay CPI | 250,000–254,000 |
| `quote_cover` (3,000 scenarios, capacity included) | 44,000–60,000 typical; 281,000 worst case |
| `snapshot_close` / `post_settlement` | 11,000–18,000 |
| `open_epoch` / `process_deposit` / `process_withdrawal` | 18,000–31,000 |

## Research

All figures come from mainnet reads or fork runs; the data files are in `data/`.

**Kamino's xStock price is frozen over the weekend.** SPYx and NVDAx did not change once between Friday 20:00 and
Monday 11:00 UTC in six consecutive weekends (Aug 28 – Oct 2, 2026). The gap reaches Kamino in Monday pre-market
(8–9 AM ET). Kamino prices xStocks through Scope as the most recent of Chainlink Data Streams and Pyth; Chainlink's 24/5
feeds publish nothing at weekends. Data: `data/live/s7-history.json`.

**Exposure.** On Oct 7, 2026, 908 Kamino obligations borrowed USDC against SPYx, QQQx or NVDAx: $3.11M of debt on
$9.08M of collateral. 531 of them (one xStock deposit, one USDC borrow, $1.22M of debt) are eligible for cover today.
Data: `data/positions/`.

**Kamino integration.** A third-party program can repay a Kamino obligation with `repay_obligation_liquidity_v2` by
CPI (v1 instructions reject CPI). The xStocks Market's USDC reserve has a debt farm, so the repay also needs the
obligation's farm user state. A paused market blocks repayment; `settle_policy_to_wallet` covers that case.

## Limitations

- **Pays after the open, not before liquidation.** Kamino's price moves in Monday pre-market, so a position can be
  liquidated before settlement. Cover compensates the gap; it does not prevent the liquidation.
- **One collateral, USDC debt.** Only obligations with a single xStock deposit and a single USDC borrow are eligible.
- **Beyond every stress scenario, policies are paid in settlement order.** Capacity holds the worst of 256 joint stress
  weekends within half of LP equity. A worse weekend can owe more than equity plus premiums; the shortfall is emitted
  in `PolicySettled`.
- **A vault wiped to zero equity cannot be recapitalised.** It would be replaced by a new vault.
- **Data licence.** The calibration uses Alpaca SIP data under a personal licence, not cleared for commercial use.
- **QQQx.** Its Kamino price moves over weekends (its Scope chain follows a 24/7 source), so its gap is not
  concentrated at the open.

## Roadmap

- **Liquidation Shield:** repay before Kamino's Monday pre-market move, sized from the 24/7 xStock price.
- **Monday backstop:** pre-committed liquidity that takes over positions still breaking at the open.
- **Pro-rata payouts** when a weekend exceeds every stress scenario.
- **Wider eligibility:** multi-collateral obligations and other stablecoin debt.
- **Mainnet:** licensed calibration data, an external audit and an account migration path.
