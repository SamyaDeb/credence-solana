# Handoff: Phase B → Phase C (Oct 9, 2026)

For the Phase C session (Distribution: W5 curator cover, W17 Gap Oracle feed + SDK, W19 Actions / alerts / widget,
W7 public site). Read this after `README.md` and `docs/audit/phase1-audit.md`. Phase B's own results are in
[phase-b-report.md](phase-b-report.md).

## Where `master` is

- `master` = `1642a49` (the B4 merge): Phase 1, Phase A (W1 Shield, W2 Backstop, W3 yield vault), and Phase B (B1 W4
  multi-collateral + PYUSD, B2 W12 Jupiter Lend, B3 W11 Cover v2, B4 W16 every listed xStock). Phase B is closed.
- Green from a fresh clone (Oct 9, only `.env` copied in): `scripts/demo.sh` green in 760 s (keeper 0 failed in every step); `scripts/test.sh` **278 passed**, 2 ignored (live; run `anchor build --arch v0` first); `scripts/demo-app.sh` ready in 410 s; app unit **60 passed**, 3 skipped; Playwright **16/16** in 9.8 min.
- **Run `anchor build --arch v0` before `scripts/test.sh` in a fresh clone.** The Rust tests `include_bytes!` the
  built program (`target/deploy/credence_core.so`); `demo.sh` and `demo-app.sh` build it themselves, `test.sh` does not.
  A fresh build needs about 10 GB of disk.
- Ports: another fork is often on 8899 and an app on 3000. Use `FORK_PORT=8909` and `PORT=3001` (and
  `APP_URL=http://localhost:3001` for `pnpm test:e2e`).

## Do not touch

The background jobs: `record-prices.ts`, the `capture-scope.ts` jobs, the shadow keeper (`~/Downloads/credence-shadow`,
detached `c6cf63c`, `scripts/live/shadow.sh 20261009`), `jl-oracle-record.ts`, the `caffeinate` processes. They write
under `data/live/`, `data/shadow/20261009/` and `data/jupiter/`; commit their output, never restart them.

## The program surface Phase C builds on

Program `xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q` (Anchor 1.2.1, SBPF v0). Accounts, PDAs and the instruction list
are in `plan/03` (keep it current when you add instructions).

- **Quote:** `quote_cover` (single asset, with the epoch: prices exactly as the purchase does), `quote_cover_multi`.
  Both return the quote as instruction return data and change no state: an SDK `quote()` or a Blink's quote step
  simulates them.
- **Buy:** `buy_cover` (Kamino, DOWN), `buy_cover_up` (Kamino shorts, paid to the wallet), `buy_cover_multi` (up to 8
  legs, USDC or PYUSD), `buy_cover_jl` (Jupiter Lend). The Policy PDA is `["policy", epoch, obligation]` (A-01):
  **one policy per obligation per epoch.** Curator book cover (W5) must keep that rule or define its own seed.
- **Owner rule:** every buy path today requires the position's owner to sign (Kamino: the obligation's owner; Jupiter: the holder of
  the position NFT). W5 (a payer covering obligations it does
  not own) is new: payouts and advances must still go only into the obligation (INV-7, INV-11), and a closed
  obligation must refund, never pay a wallet.
- **Shield / settle:** `shield_advance` (+ `_jl`), `settle_policy` (+ `_jl`, `_to_wallet`), keeper-only
  `snapshot_close`, `post_settlement`, `halt_epoch`, `void_epoch`, `refund_policy`.
- **Weekend-only paths:** multi-collateral and Jupiter cover sell plain WEEKEND epochs only (A-63). Overnight and
  holiday epochs exist for single-asset Kamino cover. The keeper's demos choose weekend epochs (`ea06b66`).
- **Account layouts** grew without migrations (A-19, A-51, A-59, A-68): fine on a fresh fork, a redeploy over old state
  is not supported.

## Data the Gap Oracle (W17) can reuse

- `data/onchain/assets.json`: the eight assets, mints, Pyth feeds (equity, xStock push account, redemption), Kamino
  reserves and Scope chains, Jupiter vault (`TSLAx.J`), σ per closure type (`sigmaByType`) and where each σ comes from
  (`sigmaSource`).
- **σ for MSTRx and HOODx changed at the Phase B close (A-72):** max(COIN σ × ratio, own last-104-weekend σ, long-run
  floor): MSTRx 4.90%, HOODx 3.74% weekend (were 3.68% and 2.84%). Anything that shows σ or P(gap < −x%) for them must
  read `assets.json`, not a copied number.
- `data/sigma/sigma-floor.json` (long-run and last-104-weekend σ per asset), `data/sigma/closure-gaps.json` (every
  historical gap per asset), `data/shield-basis.json` (σ_b).
- `pricing::shield_target`, `pricing::premium` and `examples/shadow_quote.rs` give the same numbers as the program
  off-chain; the shadow keeper already uses them.

## Open items Phase C inherits

| Item | Why it matters for C | Where |
|---|---|---|
| The live price recorder and the Oracle page cover **three assets** (SPYx, QQQx, NVDAx) | W7 "Oracle page updates live" and W17 `GapFeed` need all eight; extend `record-prices.ts` (`SCOPE_CHAINS`, feeds) and the Oracle page from `assets.json`. Do not restart the running recorder mid-weekend; run a second one for the new five | A-72; `scripts/src/record-prices.ts` |
| **CRCLx is not covered** (Kamino lists it, 93 positions hold it; no calibrated history) | Coverage numbers must keep saying so; the app already does (A-71) | README W16 |
| JupUSD debt on Jupiter Lend not covered | Same | README W12 |
| Jupiter's oracle refuses stale prices in every `operate` | If Jupiter does not refresh xStock prices at weekends, no Sunday-night payback (shield included) on Jupiter. `jl-oracle-record.ts` is recording Oct 9–12: read `data/jupiter/` before promising Jupiter shielding in a Blink or widget | plan/06 |
| Live scan keeps the single-asset rule; QQQx's σ ratio is a constant | Risk numbers in alerts (W19) for multi-collateral positions come from the scan | A-72 |
| A-52 (settlement helper duplication), A-62 (three copies of Fluid tick math; only risk-core golden-tested) | The SDK (W17) should import one implementation, not add a fourth | audit |
| A-50 (PYUSD capacity counted twice), A-57 (`shield_advance_jl` has no "restores health" guard) | Known limits; mention in the SDK docs | audit |

## Market facts (scan Oct 9)

- Eligible positions: Kamino 623 at B1 → **1,230** at B4; Jupiter Lend 1,045 at B2 → **1,197** at B4; both lenders
  **2,427** (`data/positions/positions-20261009.json`). The Phase C prompt says 1,046 for Jupiter at B2 and the README
  1,045; check the scan file before quoting either.
- Borrowers protect themselves by under-borrowing (debt-weighted median D/C′ 0.76 Kamino, 0.71 Jupiter), so
  repayment needed at a −8% gap is near zero today: the product is "unlock the headroom", not "rescue the book".
- 87 SPYx shorts on Kamino (UP cover's market).

## What the app, pitch and grant pack should show

- **Coverage:** eight xStocks on Kamino plus TSLAx on Jupiter; 2,427 eligible positions on two lenders; CRCLx and JupUSD
  debt named as not covered.
- **Premiums per $1,000 of cover** for one position on every asset (`keeper/src/assets-demo.ts`, README W16), with
  MSTRx and HOODx at their new σ.
- **Cover v2:** shorts (UP, netted against longs), overnights, holidays and the earnings bump; HALT is deliberately not
  sold (plan/06).
- **Proof level:** fork-proven with real klend and Jupiter binaries; nothing on mainnet (owner decision, unaudited);
  mainnet is read-only. Audit: 73 findings so far (7 high, 32 medium, 20 low, 14 info): 63 fixed, 8 known limits, 2
  open.
- **Shadow weekend:** results land after the real Monday open (Mon Oct 12, 19:00 IST). Until then say "running".
- **Freeze:** Mon Oct 12, 12:00 IST. Only what is merged into `master` is shown.

## C1: credit unlock (Phase C, Oct 9 night)

What cover would allow, not measured demand. Method `unlock.v1` in plan/09 ("Phase C, C1"); headline in README
"Credit unlock".

- **Read:** `data/unlock/unlock-<yyyymmdd>.json` (latest: `20261009`, from the Oct 9 scan), or `GET /api/unlock`
  (summary; `?positions=1` adds the 2,427 rows). `aggregates.total` / `byLender` / `byLenderAsset` / `pyusd` per target
  (`"0.85"`, `"0.9"`, `"0.95"`), `capacity[target].slices` (LP equity for 25/50/100% of the unlocked book and the
  binding rule), `capacity[target].lpLine`, `excluded`, `borrowApr` (with sources), `inputs` (sha256 of every input).
  The `.md` has the pitch tables. Always show the `caveat` field next to any number from it.
- **Regenerate:** `cd scripts && pnpm tsx src/unlock.ts [--scan data/positions/positions-<date>.json]` (refuses a scan
  older than 24 h: re-run `positions.ts` first; reads two Kamino reserves and Jupiter's vault API for the borrow APR,
  read-only). Then `cargo test -p credence-core --test unlock` and `app/test/unlock.test.ts` check the new file.
- **C2 (curator page):** per-asset rows are `aggregates.byLenderAsset.<lender>.<asset>.targets[t]`; quote the
  debt-weighted cost and the `bySize` buckets, not the median (2,274 of 2,390 positions at 0.90 pay the 5 USDC minimum).
- **C3 (Gap Oracle / SDK):** `examples/unlock_quote.rs` + `examples/unlock/model.rs` are the program's pricing for
  any of the eight assets, multi-collateral and the `<T>.J` aliases, driven by `assets.json` (no ticker list); the
  SDK's `quote()` should simulate `quote_cover` / `quote_cover_multi` (golden-equal to the helper, `tests/unlock.rs`)
  rather than re-implement it. `examples/shadow_quote.rs` is unchanged (the running shadow keeper).
- **C5 (site):** safe sentences are listed in plan/09 C1 results, each with its field.
- **Open:** the Shield's buffer b = 2% is below σ_b for TSLAx (3.3%), HOODx (4.8%) and MSTRx (6.4%): with the fair
  value 1 σ_b above the open their residual risk is 0.8–2.8% at D/C′ 0.90. A per-asset b (≥ σ_b) is a parameter
  decision for the owner, not made here.
