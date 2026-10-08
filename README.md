# Credence (Solana)

**The risk layer for tokenized stocks on Solana.** Tokenized stocks trade 24/7, but the prices lending protocols trust
run 24/5. Credence prices the weekend gap, sells protection against it, and stands ready to buy collateral at Monday's
open, for xStocks positions on Kamino and Jupiter Lend.

This is a new, Solana-native project with a fresh history. It reuses ideas and the fixed-point risk math from the EVM
Credence Finance prototype (Robinhood Chain and Arbitrum, built Sept 27 to Oct 3, 2026). That prior work must be
disclosed in any hackathon submission (see [plan/05-hackathon.md](plan/05-hackathon.md)).

## The plan

Read in order. Each file stands on its own, but later files assume the earlier ones.

| # | File | What it covers |
|---|---|---|
| 0 | [plan/00-decision-new-repo.md](plan/00-decision-new-repo.md) | Why a new repo instead of converting the EVM one, and what carries over |
| 1 | [plan/01-product.md](plan/01-product.md) | The problem, why now, the product, the market, the competition, the business model, the long-term vision |
| 2 | [plan/02-mechanism-design.md](plan/02-mechanism-design.md) | How Gap Cover, the underwriter vault, the oracle and the reopen backstop work, with the math and the rules that keep them safe |
| 3 | [plan/03-architecture.md](plan/03-architecture.md) | Solana programs, accounts, instructions, oracles, Kamino integration, Token-2022 handling, off-chain services, web app |
| 4 | [plan/04-implementation-phases.md](plan/04-implementation-phases.md) | Phase-by-phase build guide, from verification spikes to the hackathon MVP to mainnet and beyond, with acceptance criteria |
| 5 | [plan/05-hackathon.md](plan/05-hackathon.md) | Crypto World's Fair: deadline, track, demo script, pitch outline, disclosure, user interviews |
| 6 | [plan/06-risks-and-open-questions.md](plan/06-risks-and-open-questions.md) | What must be verified before committing, and the risks that could kill the idea |
| 7 | [plan/07-repo-layout-and-setup.md](plan/07-repo-layout-and-setup.md) | Folder structure, toolchain, commands, conventions |
| 8 | [plan/08-research-and-decision-log.md](plan/08-research-and-decision-log.md) | How the idea was chosen, what was rejected, Colosseum data, EVM code-review findings, sources |
| 9 | [plan/09-verification-results.md](plan/09-verification-results.md) | Phase 0 results: toolchain, compute costs, Kamino source review and live market data, xStock mints, Pyth feed ids |

## Run it

Needs Agave 4.3.x (`scripts/env.sh` checks), Anchor 1.2.1, Node 22 with pnpm, and `.env` with `MAINNET_RPC`.

```bash
anchor build --arch v0                                  # program + IDL
cargo test -p credence-core -p credence-risk-core       # LiteSVM suite (real klend from a mainnet snapshot)
scripts/demo.sh                                         # one simulated weekend on a mainnet fork, about 1 minute
cd keeper && pnpm keeper                                # the keeper loop against RPC_URL (default the local fork)
```

Program id (all clusters): `xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q`.

### The app (Next.js, `app/`)

```bash
scripts/demo-app.sh          # fresh mainnet fork + data + two demo LPs + epochs, then the app on http://localhost:3000 (~50 s)
```

Then, in the browser (1440 px or wider records best):

1. **Connect → Demo burner wallet** (a local keypair, for judges without Phantom; Phantom works through the wallet
   standard), then **Fund (fork)**: 10 SOL and 50,000 USDC by a fork cheatcode.
2. **Demo mode → Create position (fork)**: a $50,000-debt SPYx position at D/C′ 0.96, opened through klend on the fork
   and given to your wallet. Or **My weekend risk → Use a real mainnet position**.
3. **My weekend risk**: the position after a klend refresh, the loss table at −5/−8/−12%, the premium from a simulated
   `quote_cover`, and **Buy gap protection** (refresh ×2 + `buy_cover` in one transaction; the Policy is read back).
4. **Demo mode → Friday close → Monday open with gap −8% → Settle**: each transaction with its compute units; the payout
   is repaid into the obligation. Repeat for the next weekend on the same fork.
5. **Underwriters** (vault, LP deposit/withdraw queue, backtest) and **Gap Oracle** (Friday close, Kamino's frozen price,
   the 24/7 xStock price, implied gap, S7).

The app owns its connection to the fork and asks the wallet only to sign. Server routes only run fork cheatcodes, read
`data/` and run the keeper's demo steps; `MAINNET_RPC` never reaches the browser.

```bash
cd app && pnpm test          # unit: golden payout vectors vs Rust, keeper parity, vault numbers vs raw account bytes
cd app && pnpm test:e2e      # Playwright happy path against the running demo-app.sh
```

Screenshots: [docs/app](docs/app).

## What is real and what is simulated

Phase 1 runs on a local mainnet fork and in LiteSVM with mainnet state. This section is kept current as parts land.

| Part | Real | Simulated or substituted |
|---|---|---|
| Kamino (klend) | Mainnet klend and farms binaries, real xStocks Market accounts and obligations (cloned on first use by the surfpool fork); the repay is a real CPI into klend signed by the vault PDA | The demo position is a real near-threshold obligation, but its owner field is rewritten on the fork so the demo wallet can sign `buy_cover`. In the LiteSVM tests, Scope timestamps are re-stamped after the test clock moves (test-only helper) |
| Vault and LPs | Program logic, share math, queues | Demo wallets' USDC comes from a fork cheatcode |
| Friday close and Monday settlement price | Kamino's own oracle: the program reads Kamino's Scope `OraclePrices` account (Chainlink Data Streams + Pyth Pro), the same price klend liquidates on. Free, no API key. The live checkpoints store the real Oct 9 close and Oct 12 open from raw mainnet captures of that account | Pyth push accounts (`XSTOCK`) remain as a fallback; the planned `Equity.US` settlement (`EQUITY`) needs a paid Pyth equities plan (plan/06) |
| Time | Real exchange calendar (XNYS sessions, holidays, half days); real epoch times | The fork's clock jumps to the Friday close and the Monday open (surfpool time travel) |
| The weekend's prices in the demo | Friday close: Kamino's real Scope price (the genuine reading from the real close once the recorder has it; before that, the live Scope value cloned at the start, or in the app the recorder's latest mainnet reading) | Before Oct 9, the close's refresh time is moved to the bell; the Monday open is Kamino's Scope price moved by `DEMO_GAP` (default −8%), which klend also sees. Every demo run lists what it simulated in `data/demo/demo-result.json`; the app lists it on the Demo mode page |
| App demo positions | Real near-threshold mainnet obligations (owner field rewritten on the fork, as above) | The bigger demo position is created on the fork: SPYx given to the demo keeper by cheatcode, then a real klend deposit + borrow, then its owner field set to your wallet |
| Fork upkeep (app and keeper) | — | Scope refresh times are moved to the fork clock before klend refreshes (prices unchanged); after a simulated gap the Scope TWAP is set to the spot price; accounts the fork has never seen are marked local-only before a transaction (surfpool cannot fetch them once its clock passes mainnet's) |
| Gap Oracle page | Kamino's Scope price and the Pyth `Crypto.<T>X/USD` push updates, genuine mainnet readings by the recorder (every 10 s) | The Friday close shown from the fork's epoch is labelled simulated unless it equals the captured real close |

## Status (Oct 8, 2026)

Days 1 to 4.5 done: program (LiteSVM suite), keeper and CLI demo, real-data jobs, and the app (`scripts/demo-app.sh`).
Open: 4.6 (Sunday 8 PM ET live checkpoint; the recorder is running), Day 5.

## Status (Oct 7, 2026)

Phase 0 verification done: `risk-core` builds for Solana on Agave 4.3.0; Kamino repay and liquidation are open to
third parties (v2 instructions accept cross-program calls); Pyth has the needed feeds (API key required). Three design
changes came out of it: precomputed gap factors for compute, a post-open "Gap Payout" for Phase 1 with a "Liquidation
Shield" in Phase 2, and an Agave toolchain upgrade.

Next: the "Before Day 1" list and Day 1 in [plan/04-implementation-phases.md](plan/04-implementation-phases.md).
