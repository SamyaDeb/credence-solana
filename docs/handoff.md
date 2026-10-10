# Handoff: Phase B → Phase C (Oct 9, 2026; C2 added Oct 10)

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

**At the C2 merge (Oct 10, fresh clone, `.env` only):** `scripts/test.sh` 310 passed, 2 ignored; `scripts/demo.sh` green in
921 s (book step included); `scripts/demo-app.sh` ready in 230 s; app unit 65 passed, 3 skipped; Playwright 18/18 in
11.1 min. Use `FORK_PORT=8919 PORT=3002` when another session holds 8899/3000, and `RPC_URL=http://127.0.0.1:8919` for
`pnpm test:e2e` (two specs read the chain directly). The demos now run on a weekend too (A-85).

## D3 and D4 (Oct 11, branch `phase-d34`)

- **D3 hedging is built, testnet only** ([README, "Hedging (D3)"](../README.md#hedging-d3-testnet-venue-trust-model-caps)). Program:
  `state_hedge.rs`, `instructions/hedge.rs` (`init/set_hedge_config`, `open_hedge`, `report_hedge`, `finalize_hedge`, `void_hedge`,
  `expire_hedge`), one appended field `Vault.hedge_pending` (a fresh fork only, as every layout change since A-19). Math:
  `risk-core::hedge`, helper `examples/hedge_delta.rs`. Keeper: `keeper/src/hedge/` (venue interface, the Hyperliquid testnet
  adapter, signing, the job, `probe.ts`); the job is off unless `HEDGE=1` and `HEDGE_TESTNET_KEY`. App: the hedge section of
  Underwrite. Backtest: `BT_HEDGE=1`, `data/backtest/gap-cover-backtest-hedge*.json`. Audit A-270 to A-273 (+ review findings).
- **To run a testnet round trip** (not done: no key was provided): create a Hyperliquid testnet API wallet, fund the account
  with testnet USDC from the faucet, put `HEDGE_TESTNET_KEY=0x…` in `.env`, have the admin call `init_hedge_config` (3% / 1% / 5x /
  24 h / 5 d / 3%), run the keeper with `HEDGE=1`. **On the testnet `xyz:SP500` is delisted**; NVDA, TSLA, AAPL, HOOD, MSTR and
  XYZ100 are listed and thin (the testnet marks drift from the oracle by up to 5%, so the 3% return tolerance may refuse a report there).
- **Limits to know before trusting it:** the trust assumption in the README (a compromised keeper key: at most 1% of cover equity
  per weekend, unless the guardian voids inside the delay); the costs exceed the benefit in the backtest; tracking error vs the
  xStock is unmeasured; funding assumptions are labelled. **What remains for mainnet:** an external audit of the hedge path (the
  report bounds, the oracle band, the key custody), a legal review, a custody design for the venue key (HSM or multisig, not
  a hot env var), a measured basis study per instrument, and a venue risk review.
- **D4 is built as a research prototype on the fork** ([README, "NAV-priced assets (D4)"](../README.md#nav-priced-assets-d4-research-prototype)):
  closure type `NAV_STRIKE` (4) with a per-asset `NavSchedule`, `add_nav_asset` / `open_nav_epoch` / `halt_nav_epoch` / `set_nav_gate` /
  `stop_nav_sales` (`instructions/nav.rs`, `state_nav.rs`, `calendar::nav_times`), ONyc on Kamino's OnRe Market (`kamino::NAV_MARKETS`; the reserve
  sits in `AssetConfig.kamino_reserves[0]`), settlement on the lender's own Scope chain. Data: `data/nav/` (`scripts/src/nav-assets.ts` the
  study, `gen-nav.ts` the assumed scenario set and joint column v3), fixtures `tests/fixtures/onre` (`scripts/src/fetch-onre-snapshot.ts`).
  Keeper: `nav.ts` (opens closures, halts); demo `nav-demo.ts` (`ONLY_NAV=1 scripts/demo.sh`). **The σ (0.5% floor, Student-t) is an
  assumption: the data has no down strike.** In the demo harness the whole Scope account must be restamped when the fork clock has travelled
  weeks (klend flags the NAV reserve's TWAP otherwise). A `DEMO_NAV_AT=<unix>` hook starts the demo later on the fork's clock.
- **Review follow-ups** (audit A-278 to A-289): the keeper's hedge job records each venue step before the next (state file `keeper/.hedge-state.json`);
  a report that failed is retried from the recorded exits, a declaration that failed from the recorded fills; the job expires a stuck book.
- Ports used: `FORK_PORT=8989`, `PORT=3010`. `keeper/node_modules` in a new worktree may be a symlink into another worktree: run
  `pnpm install` there before adding packages (`@msgpack/msgpack`, `@noble/*` were added for the hedge signer).

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
  mainnet is read-only. Audit: 83 findings so far (7 high, 34 medium, 26 low, 16 info): 72 fixed, 9 known limits, 2
  open (A-74 to A-83 from the C1 merge review).
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
- **Tests at the C1 merge:** `scripts/test.sh` 283 passed (278 + the golden pair in `tests/unlock.rs` and the helper's
  three property tests), app unit 63 passed (+3, `app/test/unlock.test.ts`). `demo.sh`, `demo-app.sh` and Playwright
  were not re-run: C1 changes no program, keeper or UI code.
- **Open:** the Shield's buffer b = 2% is below σ_b for TSLAx (3.3%), HOODx (4.8%) and MSTRx (6.4%): with the fair
  value 1 σ_b above the open their residual risk is 0.8–2.8% at D/C′ 0.90. A per-asset b (≥ σ_b) is a parameter
  decision for the owner, not made here.

## C2: curator book cover (Phase C, Oct 10)

A payer (a curator or vault manager) covers a book of positions it does not own: Kamino single and multi-collateral
(USDC and PYUSD) and Jupiter Lend in one book, WEEKEND epochs only, side DOWN, full cover per leg. Design and the owner's
sign-off: plan/02 "Curator book cover"; decisions made while building: plan/06 "C2 decisions"; numbers: plan/09
"Phase C, C2"; README "Curator book cover (C2)".

**Program surface (new).**

| Instruction | Who | Notes |
|---|---|---|
| `open_book(closure_id, book_id)` | any payer | `Book` PDA `["book", payer, closure_id, book_id]` + USDC escrow `["book_escrow", book]`; expires `min(bell, now + 1 h)` |
| `add_book_leg` / `add_book_leg_multi` / `add_book_leg_jl` | the book's payer | one leg each, after the refreshes; a leg is a `Policy` at the usual PDA with `book` set, `owner` = default; capacity reserved in the same instruction |
| `seal_book(max_premium)` | payer | `risk-core::book_premium`: one minimum premium, ES diversified on the joint set, loading summed |
| `release_book_leg` | the position's owner, before the bell | then the owner's own `buy_cover*` in the same transaction (owner precedence) |
| `void_book_leg` | anyone, OPEN book past its expiry | capacity released, leg closed |
| `shield_book_leg` / `_jl`, `settle_book_leg` / `_jl` | keeper / anyone | into the position only, never a wallet |
| `close_out_book_leg` | anyone | voided epoch, or after `SETTLE_GRACE`: unpaid, share refunded if a payout was owed (A-84) |
| `claim_book_refund`, `close_book_leg`, `close_book` | anyone | refunds only to the payer's recorded USDC account; rent back to the payer |

The owner-policy paths (`settle_policy`, `settle_policy_to_wallet`, `settle_policy_jl`, `shield_advance*`,
`refund_policy`) refuse a leg (`BookLeg`). `Policy` grew to 565 bytes (book, rent payer, leg E/ES/weight, loss hash);
`Book` is 2,312 bytes (zero-copy). Layouts changed without a migration (fresh fork only, A-19).

**What C3 (Gap Oracle feed + SDK) needs from books.**
- A book quote is `examples/book_quote.rs` (stdin JSON, C1's position format; the app's `/api/book-quote` runs it). It
  uses the program's own `pricing::leg_quote_single` / `leg_quote_multi` and `risk-core::book_premium`; a 1-leg book
  equals `quote_cover`'s premium (app test `book-quote.test.ts`). The SDK should call the same helper (or port it to
  WASM through `risk-core`), not re-implement it. A whole book does not fit one simulated instruction's compute.
- Buying: `open_book`, then batches of `add_book_leg*` (keeper/src/book-demo.ts: a lookup table of the shared
  accounts, up to 6 Kamino legs per v0 transaction; Jupiter 3–6), `seal_book`. Check the policy PDAs first: a position
  already covered (by its owner or another book) fails its instruction.
- Owner precedence for a wallet SDK: when the position's policy PDA holds a leg (`book` ≠ default), prepend
  `release_book_leg` to the owner's `buy_cover*`.
- Events: `BookOpened`, `BookLegAdded`, `BookSealed`, `BookVoided`, `BookLegRemoved`, `BookLegSettled`, `BookRefundClaimed`.

**What C5 (public site) can say.** Quote only from plan/09 "Phase C, C2" and data/demo/book-result.json, with what is
simulated. Safe sentences: "a curator covers a book of N real positions for one premium"; "one minimum premium per
book instead of one per position"; "payouts only go into the positions"; "an owner can always buy its own cover: the
book's leg is released and its share refunded". Not safe: any claim about demand, or a saving figure without the
book it was measured on.

**Open after C2.** The per-asset Shield buffer (owner decision, C1); `BOOK_TTL_SECS` is a constant, not config; the
Curator page buys Kamino xStocks and Jupiter legs (Sentora PYUSD legs through the keeper path).

## C4a: the Protect Action and Friday alerts (Phase C, Oct 10)

README: "Protect my position (Action) and Friday alerts (C4a)". No program change. Audit A-110 to A-134.

- **Routes (app).** `GET|POST|OPTIONS /api/actions/protect?position=…&lender=kamino|jupiter[&cap=full|need8|need12]`
  (handler `handleProtect` in `lib/actions/protect.ts`, injectable `ProtectDeps`: chain, limiter, network),
  `/actions.json`, `/api/alerts/{config,nonce,subscribe,unsubscribe}` (`api/alerts/_lib/alerts.ts`, one handler).
  The public read-only site (`NEXT_PUBLIC_NETWORK=mainnet`) refuses the Action's POST and every alert write (403).
- **The chain port C4b should reuse.** `ProtectChain` (`load`, `quote`, `build`) is the whole contract; `ForkChain`
  (`lib/actions/fork-chain.ts`) implements it on the fork RPC. A widget on the C3 SDK should implement the same three
  methods over the SDK's quote/build and keep `shapeProblem` (`lib/actions/shape.ts`) as its last check: exactly the
  compute-budget pair, klend refreshes (Kamino only), one lender-specific buy last, the wallet as only signer, no lookup
  tables. A position with a Policy already is `Position.policy` (GET disabled, POST 409).
- **Blink adapter.** `lib/actions/blink-adapter.ts` (`@dialectlabs/blinks` 0.22.5): fork chain id only, Dialect's
  proxy off (A-112), message signing refused, `shapeProblem` before the burner signs. It is what `/app/protect` renders;
  a wallet cannot use the fork Action (wallets fetch against mainnet), so C5's demo clip shows the in-app Blink.
- **Alert job and store.** `keeper/src/alerts.ts` (`runAlerts`, `alertWindow` from the XNYS calendar, `alertText`,
  `quoteHelper`), `keeper/src/alerts-store.ts` (subscribers, nonces, link codes, per-closure ledger under `data/alerts/`,
  atomic writes, a lock with a heartbeat), `keeper/src/alerts-telegram.ts` (getUpdates poller), `alerts-transports.ts`
  (Telegram, web push to the push services' hosts only). Signed messages: `lib/actions/alerts-message.ts` (domain, wallet,
  action, channel, threshold, nonce, issuedAt, expiresAt). Logs hold counts only.
- **The pricing helper.** `target/release/examples/unlock_quote`, op `assess` (`examples/unlock/assess.rs`): one JSON
  line in, one out; closure-aware (`closureId` = the session the closure follows). C3's SDK can call the same op or
  simulate `quote_cover`; the golden fixture is `app/test/fixtures/alerts-quote-golden.json`.
- **C5 safe sentences.** "Gap protection on a local mainnet fork; not live; not insurance"; the Action quotes are the
  program's own, simulated; alerts are opt-in and wallet-signed. Do not say wallets can buy it today.
- **Not done / for C4b.** Weekend epochs only in the Action; push/Telegram delivery tested with mocks unless
  `TELEGRAM_BOT_TOKEN` is set; the known limits A-130 to A-134 in the README.

## C3: Gap Oracle feed, sample consumer, SDK (Phase C, Oct 10)

Design and decisions: plan/02 "Gap Oracle feed, consumer and SDK", plan/03 "GapFeed", plan/06 "C3 decisions"; README
"Gap Oracle feed and SDK (C3)"; audit A-135 to A-157 (C4a's review had already used A-130 to A-134).

**Program surface (new).** `init_gap_feed(ticker, min_update_slots, max_input_age_secs)` and `set_gap_feed_params` (admin),
`update_gap_feed(ticker)` (anyone). `GapFeed` is 224 bytes at `["feed", ticker]`; layouts changed without a migration (fresh
fork only, as before). `gap_feed::compute` is the one function behind the instruction and `examples/gap_feed.rs`.
`programs/gap-consumer` is a fork-only example (not deployed anywhere); the keeper's `feeds` job inits and cranks every feed every
`FEED_EVERY_SECS` (300) and logs flags.

**What C4b (the widget) needs from the SDK.** `readFeeds`/`feedProblems` for the "is the lender still frozen" line;
`quoteSingle`/`quoteMulti`/`quoteByBuy` + `withSlippage` + `buyCover` for the buy; `parseEvents` to follow a policy;
`checkProgram` on connect. Build the SDK first (`pnpm --dir packages/sdk build`; the app's `pnpm dev|build|test` does it). The SDK
is a `link:` dependency: any new app/widget project that links it must also force one copy of `@solana/web3.js`,
`@anchor-lang/core` and `bn.js` (see `app/next.config.ts`, `app/vitest.config.ts`), or `PublicKey` identity breaks.
The Action route already builds through `buyCover`; its quote path (`fork-chain.ts`) still has its own simulation code.

**What C5 (the public site) can say.** From the feed: "the 24/7 price says X vs the Friday close; the lender's price has not moved
for N minutes" per asset, and the three probabilities (P(gap < −5/−8/−12%) from ten years of weekend gaps and the asset's σ). The
public page computes them off-chain from mainnet data: say so. Safe: "a permissionless crank that no caller can feed a price to".
Not safe: "on mainnet", "live feed" (the account exists on the fork only), any claim about demand. The five assets added by
the second recorder have 'frozen' only after 30 minutes of history.

**Open after C3.**
- The per-asset Shield buffer (owner decision from C1).
- A-155: `record-prices.ts` (the running recorder) still writes unredacted error text into the tracked `events-*.jsonl`; apply the
  `scrub` from `record-prices-more.ts` when it is next restarted. Grep `events-*.jsonl` for `api-key` before committing them.
- The feed ignores the earnings bump (`EARNINGS_ASSET` marks assets that have one); the closure rule and flag bits exist in
  Rust, the SDK and the keeper (A-151).
- The mainnet Oracle page needs `scripts/src/gap-feed-mainnet.ts` re-run to refresh `data/live/gap-feed-mainnet.json`
  (it is not a daemon); `CREDENCE_DATA_ROOT` points it and the second recorder at the checkout the first recorder writes to.
- The Friday close capture (`close-checkpoint.log` of Oct 9) failed to compile its test at the bell
  (`tests/common/mod.rs` embeds `target/deploy/credence_core.so`, which was not built) and the wrapper still logged `exit 0`;
  only the DRYRUN files exist. Not part of C3; found by a review pass over the working tree.

## C4b and C5: the widget and the public site (Phase C closed, Oct 10)

README: "Widget (C4b)" and "Public read-only site (C5)"; plan/06 "C4b and C5 decisions"; audit A-160 to A-171
(`phase-c45`). No program change; `scripts/test.sh` is unchanged (332 passed, 2 ignored).

- **Widget.** `packages/widget`: `CredenceProtect`, `GapLine`, `RiskTable`, `QuoteBuy`, `CoverStatus` and the functions under
  them (`loadPosition`, `quoteFor`, `buildPurchase`, `purchase`, `followPolicy`). Kamino single-collateral weekend epochs only.
  `purchase.ts` is the only file that signs or sends. The sample host is `examples/host` (Vite, single-copy aliases); its
  Playwright spec needs the fork (`FORK_PORT=8949 PORT=3005 scripts/demo-app.sh`, then `APP_URL=… FORK_PORT=… pnpm exec
  playwright test` in the host folder). Risk (`riskView`, payout rule, odds) and `shapeProblem` now live in the SDK; the app
  re-exports them.
- **Not done in C4b:** Jupiter Lend and multi-collateral in the widget; the Action's own quote path (`fork-chain.ts`) still
  has its own simulation code (a golden pass before the freeze was not worth the risk).
- **Public site.** Pages `/`, `/about`, `/mainnet`, `/unlock`, `/proof`, `/weekend`, `/roadmap`, `/disclosure`, all from
  `data/site/snapshot.json`. **Refresh steps** (the owner's machine, the recorders' checkout):
  1. `cd scripts && CREDENCE_DATA_ROOT=<recorders' checkout> pnpm tsx src/gap-feed-mainnet.ts` (Oracle numbers; needs `.env`)
  2. `SHADOW_ROOT=<shadow checkout> CREDENCE_DATA_ROOT=<same> pnpm tsx src/site-snapshot.ts`, after editing
     `data/site/proof-input.json` if the test counts changed
  3. commit `data/site/snapshot.json`, redeploy. The Oracle section reads stale after 2 h by design.
- **Monday 19:00 IST (Oct 12):** the shadow keeper's summary becomes final (`phase: "final"`). Re-run step 2 with the shadow
  checkout (read only; never edit the running keeper's files), commit, redeploy: `/weekend` then shows "Final" and the totals.
  Data and wording only after the 12:00 freeze. Re-run `gap-feed-mainnet.ts` first so `/mainnet` is not stale at judging.
- **Safe sentences for the pitch and video** (each on a page with its source): the positioning line; "computed off-chain from
  mainnet data"; "fork-proven against Kamino's and Jupiter Lend's real programs; nothing on mainnet; audit first"; the unlock
  headline with "what cover would allow, not measured demand"; the book numbers "on this book, fork demo". Not safe: insurance,
  live on mainnet, live feed, any demand claim, a verifiable-build claim (no hash was produced).
- **Deploy (open):** needs the owner's approval of host, domain and variables. Vercel, root directory `app`; env
  `NEXT_PUBLIC_NETWORK=mainnet`, `MAINNET_RPC`, `TRUST_PROXY=1`, `NEXT_PUBLIC_SITE_URL` (the public origin, for the OG image);
  never commit them. Check on the live URL: every page, `scripts/secret-grep.mjs` is for the build output (run it on the build
  before upload), Lighthouse on `/` and `/mainnet`. Untested on a real host: that the traced `data/site/snapshot.json` is found
  at `ROOT` in the serverless function (the other data routes use the same path).
- **Known limits added:** CSP allows inline scripts (no nonce); the widget's polling is per component; the mobile landing
  Lighthouse performance is 90 (the margin is thin; the landing's video and images are the cost).
- **For Phase D and the pitch/video session:** the per-asset Shield buffer is still the owner's decision (C1); the widget
  and the Action share `shapeProblem` but not their quote path; the build hash needs Docker (runbook §0).

## D1: weekend-safe market (Phase D, Oct 10)

A klend market where every borrow is covered automatically (fork-proven only). Design and the owner's approval: plan/09
"Phase D, D1.0" (local); README "Weekend-safe market (D1)".

| Instruction | Who | What |
|---|---|---|
| `init_wsm_market(params, assets)` | admin | `WsmMarket` PDA `["wsm_market"]`: the USDC reserve, each asset's klend reserve and normal LTV, D/C′ cap, freeze length, debt cap, worst-loss ratio; reads the reserves it lists |
| `set_wsm_params` | admin | bounded parameters and per-asset `enabled` (disabling stops new accounts, never an exit) |
| `wsm_open(ticker)` / `wsm_reopen` | user | `WsmAccount` `["wsm", user]`, its `["wsm_usdc", user]` and `["wsm_coll", user]`, and the klend user metadata + obligation it owns; reopen after klend closed an emptied obligation |
| `wsm_deposit`, `wsm_borrow` | user | v2 CPIs; borrow refused paused / in the freeze / past the D/C′ cap, debt cap or the vault's room |
| `wsm_repay`, `wsm_withdraw`, `wsm_claim` | user | exits: no config, pause, policy or vault is read; withdraw has the freeze guard |
| `wsm_auto_cover(ticker, closure_id)` | anyone, from `freeze_secs` before the bell | borrows the premium on the account, pays the vault and fee, writes a full-cover policy owned by the account (`rent_payer` carries the user: payouts go to `wsm_usdc`); refused cover = flag, nothing moves |

- `kamino::WSM_MARKET` is a fork-only address constant; Shield, settlement, refund and the Backstop accept it (`repay_market_allowed`;
  the Backstop finds the reserve through `WsmMarket`, passed as a remaining account).
- `cover.rs` was split: `price_cover` / `commit_policy` are `buy_cover`'s pricing and write, reused by `wsm_auto_cover` (the premium
  iterates to a fixed point: the cover is for the debt after the premium). `ObligationView` gained deposit amounts and the allowed borrow value.
- Keeper: `keeper/src/wsm.ts` (the Friday job, in `tick`; a v0 transaction with a lookup table), `wsm-market.ts` (fork-only market
  builder), `wsm-demo.ts`, `app-step.ts wsm-setup|wsm-freeze|wsm-pause`. The generic Shield and settlement jobs handle account policies.
- SDK `wsm*` builders and readers (`packages/sdk/src/wsm.ts`); app page `/app/weekend-safe`; Playwright `e2e/wsm.spec.ts`.
- **For D2 (gap tokens) and the pitch:** an account policy is an ordinary policy (owner = the account), so a gap token over it needs
  the same payout destination rule (A-190); the add-on APR and the "borrow 9.8% more and survive −8%" demo numbers are in
  `data/demo/wsm-result.json`; the live-market path needs a multisig market owner, a per-deployment `WSM_MARKET` and a weekday-move backtest for the thresholds.


## D2: gap tokens (Phase D, Oct 10): research prototype, not offered

Two tokens per asset and closure that split a fully collateralized USDC by the weekend gap (fork-proven only). Design and the
owner's approval: plan/11 (local); README "Gap tokens (D2)". **A legal review comes before any offer; none has happened.**

| Instruction | Who | What |
|---|---|---|
| `init_gap_series(ticker, closure_id)` | anyone | `GapSeries` `["gseries", ticker, closure_id]`, the two Token-2022 mints `["gdown"/"gup", series]` and the USDC collateral `["gcoll", series]`; band from the closure's σ; open epoch, before the bell, not paused |
| `mint_gap_set(amount)` | anyone with USDC | deposits `amount` and mints `amount` of each side in one instruction; until the bell; not while paused (INV-22) |
| `merge_gap_set(amount)` | holder | burns a set; before the rate pays `amount`, after it redeems both sides at the rate; never reads `paused` |
| `settle_gap_series`, `expire_gap_series` | anyone | fix the rate from the series' own epoch (SETTLED → split of `gap_wad(close, settle)`, VOIDED → 0.5) or 14 days after `settle_after` while unsettled (0.5); revoke the mint authority |
| `redeem_gap(side, amount)` | holder | burns one side and pays `floor(amount × share)`; the last redeemer of a side takes its pool's remainder |

- Math: `crates/risk-core/src/gap_token.rs` (band, split, payout, `redeem_amount`); the SDK's `gapBand` / `gapSplit` are a display
  port checked against `crates/risk-core/tests/gap_token_golden.rs` (`GEN_GAP_GOLDEN=1` rewrites `packages/sdk/test/fixtures/gap-golden.json`).
- Keeper: `keeper/src/gap.ts` (job `gap` in `tick`; opening is opt-in `GAP_TOKENS=1`, `GAP_TICKERS`, `GAP_OVERNIGHT=1`; settling and
  expiring are always on), `gap-demo.ts` (step `gap-tokens` of `scripts/demo.sh`, `ONLY_GAP=1`), `app-step.ts gap-open`.
- SDK `gap.ts`; app page `/app/gap-tokens` (nav: "Gap tokens (prototype)", fork only); Playwright `e2e/gap.spec.ts`.
- **Decided without asking** (plan/06): post-rate `merge_gap_set` redeems both sides; UP's pool is the complement of DOWN's; the
  disclaimer is in the mint name and URI; the curve in the app is the vector-tested port.
- **For D3 (the vault hedging with gap tokens):** the vault pays out when a stock gaps down, so it would hold GAP-DOWN (which pays
  more the further the stock falls) against its cover book, i.e. buy DOWN from a counterparty who wants UP. Needs: a market or an OTC counterparty (there is none), a rule for
  which series and how much (the band is 2.5 σ and the cover's loss is not linear in the gap), the vault holding Token-2022
  assets (the Backstop already does for xStocks), and the legal review. A series per epoch costs about 0.01 SOL of rent and nothing
  closes the two mints after full redemption yet.
- **Not done:** closing the mints after full redemption; a market; mainnet anything.
