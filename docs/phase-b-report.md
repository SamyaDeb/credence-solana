# Phase B report (closed Oct 9, 2026)

Phase B (coverage) in one page, with Part 1 (finishing Phase A) before it. Details and sources are in the README
sections named below; the next session's starting point is [handoff.md](handoff.md).

## Status per task

| Task | What | Status |
|---|---|---|
| 1.1 | Audit rows A-21 to A-31 | merged |
| 1.2 | Shield capacity (A-32 follow-up): reserve what the shield will do; interest to the open | merged |
| 1.3 | W2 Monday Backstop: `backstop_liquidate`, inventory, Dutch auction, INV-8, INV-13 | merged |
| 1.4 | W3 Yield vault: `rebalance`, `value_yield`, cash-first payouts, 100% utilisation stress test | merged |
| 1.5 | `phase-a` into `master` | merged |
| 1.6 | Mainnet readiness (W6): runbook, monitor, two-step admin handover, dry run on a fork (`b6e6666`, `5c58eeb`) | merged; the verifiable build is not done (needs Docker, runbook §0) |
| 1.7 | Shadow results | in progress: the shadow keeper is running; results after the real open (Mon Oct 12, 19:00 IST) |
| B1 | W4 multi-collateral and PYUSD | merged |
| B2 | W12 Jupiter Lend | merged |
| B3 | W11 Cover v2: UP with netting, OVERNIGHT, HOLIDAY_WEEKEND, earnings bump | merged; HALT deliberately not built (plan/06) |
| B4 | W16 every listed xStock (eight on Kamino, TSLAx on Jupiter) | merged at the Phase B close, with the A-72 σ fix |

## Twin demo (after task 1.2)

Two identical $50k SPYx positions at D/C′ 0.96, A covered (premium 41.15 USDC, of which shield loading 31.85).
Sunday 20:30 ET, fair value −8%: the shield repays **3,094.67 USDC** into A (health 1.042 → 1.109; A-32 had capped it at
2,423.51). Monday 08:00 ET, Kamino −8%: A at health **1.020**, klend refuses to liquidate it; B at 0.957 is liquidated.

## Backstop and yield

- **Backstop:** Credence's vault liquidates B itself through klend's v2 liquidation (vault PDA as liquidator): 10,013.10
  USDC paid, 15.5747 SPYx received (248.69 USDC of bonus at Scope). A buyer takes 7.7874 SPYx in the Dutch auction for
  5,143.77 USDC: realised P&L **+137.22 USDC**; the rest stays on sale.
- **Yield vault:** idle cash lent to the xStocks Market USDC reserve. 30 days on 1.8M lent booked 3,582 USDC (2.42%/yr
  at the snapshot). Backtest book A: LP return 2.22% → **5.90%**/yr (shield off), 7.79% → **11.26%** (shield on).
  At 100% reserve utilisation, settlement, a queued withdrawal and a shield advance all pay from cash.

## Eligible positions (mainnet scans)

| | Phase 1 (Oct 7) | B1 (Oct 9) | B2 (Oct 9) | B4 (Oct 9) |
|---|---|---|---|---|
| Kamino | 531 | 623 (+69 multi-collateral, +29 PYUSD) | 623 | **1,230** |
| Jupiter Lend | — | — | 1,045 | **1,197** (TSLAx) |
| Both lenders | 531 | 623 | 1,668 | **2,427** |

Not covered: Kamino's CRCLx (93 positions, no calibrated history) and JupUSD debt on Jupiter Lend.

## Jupiter Lend spike verdict (B2.0)

**Go, built.** On a fork, a PDA paid 5,000 USDC into a real SPYx position of another owner through `operate` (plan/09).
Cover, shield and settlement now run through `operate` on Jupiter's own oracle; Kamino and Jupiter policies net in one
loss vector. Open: Jupiter's oracle refuses stale prices in every `operate`; if Jupiter does not refresh xStock prices
over a weekend, nobody can pay back a Jupiter position on Sunday night. `jl-oracle-record.ts` is recording Oct 9–12.

## MSTRx and HOODx σ (A-72, fixed at the close)

Pooled on COIN's sets, their σ was COIN's × the ratio, floored at the long-run σ: MSTRx 3.68%, HOODx 2.84%, below their
own last-104-weekend σ (4.90%, 3.74%). MSTR moves a lot at weekends, so cover on both was underpriced. σ is now the
highest of the three: MSTRx **4.90%**, HOODx **3.74%** weekend (overnight 4.43% / 3.38%, holiday 3.79% / 2.89%).
Scenario and joint sets are unchanged (same hashes); the pricing comparison tests (`pricing.rs`) pass on the new σ.
Premium per $1,000 of cover for the demo's reference position (C′ 104,167, debt 100,000, cap 25,000 USDC;
`keeper/src/assets-demo.ts`, fresh clone): MSTRx 122.12 → **174.29**, HOODx 84.40 → **124.71**; the other six unchanged.

## Compute units (new in Phase B; full table in the README)

| Transaction | CU |
|---|---|
| `buy_cover_multi` 1 / 2 / 3 legs (LiteSVM, program only) | 222,972 / 364,482 / 469,851 |
| `quote_cover_multi` 1–4 legs at D/C′ 0.92 / 0.99 | 184k–538k / 524k–743k |
| `settle_policy` 2 legs in PYUSD / `shield_advance` 2 legs / `fund_sleeve` | 88,270 / 100,378 / 30,089 |
| `buy_cover_jl` / `shield_advance_jl` / `settle_policy_jl` | 152,235 / 174,267 / 179,795 |
| `buy_cover_up` at D/C′ 0.978 / 0.987 / 0.995; `settle_policy` UP; `buy_cover` OVERNIGHT (fork) | 136k / 175k / 381k; 204,815; 221,592 |

All under the 900k per-instruction budget; the worst is `quote_cover_multi` with 4 legs at D/C′ 0.99 (743k).

## Tests and invariants

From a fresh clone of the Phase B close (Oct 9, only `.env` copied in):

| Check | Result |
|---|---|
| `scripts/test.sh` (Rust, LiteSVM + risk-core) | **278 passed**, 0 failed, 2 ignored (live) |
| `scripts/demo.sh` | green in 760 s, keeper 0 failed in every step |
| `scripts/demo-app.sh` | ready in 410 s |
| App unit (`pnpm test`) | **60 passed**, 3 skipped |
| Playwright (`pnpm test:e2e`) | **16/16** in 9.8 min |

Two demo bugs found by this check and fixed before the merge: `demo.sh` ran the every-xStock demo after Cover v2, whose
holiday weekend time-travels the fork past every weekend on sale (`e4b618e`); run before it, its keeper passes found
the twin's SPYx inventory with a stale Scope price (`10e7dfa`).

Invariants INV-1 to INV-14 each have a named test (README, Invariants). New in Phase B: INV-14 (the PYUSD sleeve holds
every live PYUSD reservation).

## Audit findings A-33 onward

| Review | Findings | High / medium / low / info | Result |
|---|---|---|---|
| Phase A merge (A-33 to A-42) | 10 | 1 / 6 / 2 / 1 | all fixed |
| B1 W4 (A-43 to A-52) | 10 | 2 / 3 / 2 / 3 | 7 fixed; A-50, A-51 known limits; A-52 open |
| B2 W12 (A-53 to A-62) | 10 | 1 / 3 / 2 / 4 (the audit summary line says 1 / 4 / 2 / 3; the table rows are counted here) | 7 fixed; A-57, A-59 known limits; A-62 open |
| B3 W11 (A-63 to A-68) | 6 | 1 / 4 / 0 / 1 | 5 fixed; A-68 known limit |
| B4 W16 (A-69 to A-73) | 5 | 0 / 3 / 2 / 0 | A-69, A-70, A-71, A-73 fixed; A-72 σ fixed (raised from info to medium), its other points known limits |

Phase B (A-43 to A-73): 31 findings, 4 high, 13 medium, 6 low, 8 info. All findings to date: 73 (7 high, 32 medium,
20 low, 14 info), 63 fixed, 8 known limits, 2 open (A-52, A-62: code duplication, no loss path). Every `/security-review`
pass: no high-confidence vulnerability.

## Shadow weekend

Running read-only on mainnet over Oct 9–12 (`keeper/src/shadow.ts`, no signer). The real close was recorded (Sat 01:15
IST). Results are final after the real Monday open (Mon Oct 12, 19:00 IST) and go in the README.

## Known limits carried forward

- Live price recorder and Oracle page: three assets (SPYx, QQQx, NVDAx), not eight.
- CRCLx and JupUSD debt not covered; the live scan keeps the single-asset rule; QQQx's σ ratio is a constant.
- MSTRx and HOODx share COIN's joint column: perfectly correlated in the capacity model (over-reserves a book holding
  both).
- Account layouts grew without migrations (A-19, A-51, A-59, A-68).
