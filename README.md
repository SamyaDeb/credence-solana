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

## Status (Oct 7, 2026)

Phase 0 verification done: `risk-core` builds for Solana on Agave 4.3.0; Kamino repay and liquidation are open to
third parties (v2 instructions accept cross-program calls); Pyth has the needed feeds (API key required). Three design
changes came out of it: precomputed gap factors for compute, a post-open "Gap Payout" for Phase 1 with a "Liquidation
Shield" in Phase 2, and an Agave toolchain upgrade.

Next: the "Before Day 1" list and Day 1 in [plan/04-implementation-phases.md](plan/04-implementation-phases.md).
