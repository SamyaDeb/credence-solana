# Evidence (each item with its source file or transaction)

## Code, tests, audit
- Repo: this repository, `master` merge `7a894fd` (Phases A–D) and `phase-w6` (this work). Program id `xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q`, not deployed to mainnet (unaudited).
- Tests at the D3/D4 merge gate (Oct 11), README "Status": `scripts/test.sh` 428 passed, 0 failed, 2 ignored; app unit 294; SDK 45; widget 26; fork Playwright 25/25.
- Audit: `docs/audit/phase1-audit.md`, findings A-01 to A-302 (A-300 to A-302 are W6).
- Runbook dry run: `data/runbook/dryrun-2026-10-11.json`, 12 of 12 steps OK on a mainnet fork against the current program (executable sha256 `9b75c3db2571a5721c14f28d9ebf5c86a00cc9e26db57af449ea3ab501f36035`).
- Build hash: two clean `cargo build-sbf --arch v0` builds on this machine give the same sha256 `9b75c3db…6035`. This is **not** a verifiable build (`solana-verify build` needs the Docker daemon; see README). Verifiable build hash: TBD.

## Data
- Unlock analysis (C1): `data/unlock/`, README "Credit unlock".
- Position scan: `data/positions/positions-20261009.json`.
- Scope timing history: `data/live/s7-history.json`; README "Measured".

## The real Oct 9–12 weekend
- Shadow (read-only on mainnet), partial snapshot Oct 11: 535 of 545 tracked positions covered by the model, 1,218,031.24 USDC of debt, premiums 2,698.62 USDC (`data/shadow/20261009/results.json`, from `book.jsonl`).
- Final shadow results: TBD after Mon 19:00.
- Replay on a fork (owners not rewritten; Monday open placeholder until Monday): `data/replay/20261009/`, TBD after Mon 19:00.
- First post-closure prices (Mon 05:30 IST): TBD after Mon 19:00.

## Public
- Public read-only site (not deployed): `app/src/components/site/`; `/weekend` shows the settled result once `results.json` exists.
- Video: TBD (Phase E).

## Grant scheme (read 2026-10-11, WebFetch)
- https://superteam.fun/earn/grants/solana-foundation-india-grants/ — "Up to 10k USDG"; "Update the community once a week on your progress"; "This grant is only open for people in India"; "The Foundation does its best to respond within 30 days"; milestones "self-described". Header "Open" and a note "Applications Paused".
- https://superteam.fun/earn/grants/Solana-fdn-coindcx-instagrant — the earlier Instagrant, "Closed", up to 15k USDC.
- No "Instagrants" page of Superteam India could be fetched (several URLs returned 404). The 25% upfront figure is unconfirmed.
