# @credence/sdk

Quote, buy and follow Credence gap protection on Solana, and read the Gap Oracle feed. TypeScript, ESM + CJS, typed from the
program's IDL (Anchor 1.2.1, `@anchor-lang/core`), works in Node and the browser.

**Status:** built against the local mainnet fork. `credence_core` is not deployed anywhere else, so the package is **not
published** (`pnpm pack` produces a clean tarball). Wording in anything you build on it: "gap protection", "risk data",
never "insurance".

**It never holds keys and never sends.** Every builder returns unsigned instructions; the wallet signs. It prices nothing:
premiums, losses, probabilities and tick math come from the program (simulated instructions) or from `risk-core` through the
helpers named below.

```ts
import { Connection } from '@solana/web3.js';
import { checkProgram, program, readFeeds, feedProblems, chainNow } from '@credence/sdk';

const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
await checkProgram(conn);                       // refuses a program whose IDL / layout differs from this SDK's
for (const f of await readFeeds(program(conn))) console.log(f.ticker, f.flagNames, feedProblems(f, await chainNow(conn), 3600));
```

## Install and build

```
cd packages/sdk && pnpm install && pnpm build     # syncs the IDL from `anchor build`, then tsup (ESM + CJS + types)
pnpm test                                         # unit tests (golden GapFeed bytes from the program)
pnpm pack:check                                   # builds and packs to ../../.pack
```

The IDL (`src/idl.json`) and its sha256 (`src/idl-hash.ts`) are generated from `target/idl/credence_core.json`; run
`anchor build --arch v0` first. Install `@solana/web3.js@1.99.0` and `@anchor-lang/core@1.2.1` next to it (peer
dependencies, so there is one `PublicKey` class).

## Reads

| What | Call |
|---|---|
| Gap Oracle feeds | `readFeed(conn, ticker)`, `readFeeds(prog)`, `decodeFeed(key, data)`, `feedProblems(feed, now, maxAge)` |
| Epochs, policies | `loadEpochs`, `currentEpoch`, `salesState`, `policiesOf`, `policyView` |
| Vault | `loadVault` → NAV per share, premiums earned, capacity limit, utilisation (`vaultFigures`), tickets; the LP APY split in `yield` |
| Books | `readBook`, `readBooksOf`, `bookLegStatus`, `readBookLeg` |
| Positions | Kamino: `obligationsOf`, `decodeObligation`, `loadReserves`, `snapshot`, `ineligibility`; Jupiter Lend: `decodeJlPosition` |
| Events | `parseEvents(logs)`: `CoverBought`, `ShieldAdvanced`, `PolicySettled`, `BookOpened`, `BookLegAdded`, `BookSealed`, `BookVoided`, `BookLegRemoved`, `BookLegSettled`, `BookRefundClaimed`, `GapFeedUpdated`, … |

Jupiter positions are decoded to their raw fields (vault, NFT, tick). The SDK has **no Fluid tick math**: debt and
collateral of a Jupiter position come from simulating the program (`quoteByBuy`), so there is one implementation
(`risk-core::fluid`, golden-tested) and the SDK adds no copy (audit A-62).

## Quotes

- One position: `quoteSingle` simulates `quote_cover`, `quoteMulti` simulates `quote_cover_multi`, `quoteByBuy` reads the
  Policy a simulated buy would create (Jupiter Lend). The premium is the program's return data.
- A book (many positions, one premium) does not fit one simulated instruction. The SDK calls the program's own pricing
  (`pricing::leg_quote_*` + `risk-core::book_premium`, `examples/book_quote.rs`) in one of two ways:
  - `bookQuoteHttp(baseUrl, { ids, target })`: the app's `/api/book-quote` (browser or Node);
  - `bookQuoteLocal(root, request)` from `@credence/sdk/node`: spawns the helper (needs the repo and `cargo build -p credence-core --example book_quote`).

  Both give the same answer field for field (`app/test/sdk-book-quote.test.ts`). A WASM build was not chosen: the leg
  quotes live in `credence-core::pricing`, which depends on the Anchor program crate.

## Builders

```ts
const { ixs, policy } = await buyCover(prog, { kind: 'kamino', buyer, feeAccount, maxPayout, maxPremium: withSlippage(quote.premium, 100), asset, epoch, obligation, o, reserves });
```

`kind` is `'kamino'` (`side: 'up'` for shorts), `'kamino-multi'` or `'jupiter'`. The result is the lender's refreshes plus the
buy; `release` (from `readBookLeg`) prepends `release_book_leg`. `assertNoJupiterWithKlend` runs inside every builder: Jupiter
Lend's program (or any `*_jl` instruction) never shares a transaction with klend (`MixedLenderError`).

### Books

`openBook` → `addBookLegs` (batches: 6 Kamino or 3 Jupiter legs per v0 transaction, with a lookup table from
`bookLookupAddresses` + `lookupTableIxs`) → `sealBook(maxPremium: defaultSealMax(escrowed))`. A closed tab resumes: `bookLegStatus`
reads which positions are already legs of this book, which are covered elsewhere (adding them would fail) and which are pending.
`voidBookLeg` (anyone, after the expiry) and `claimBookRefund` (refunds only go to the payer's recorded account) finish a book.

### Gap Oracle feed

`updateGapFeed(prog, asset, feedClosure(await loadSessions(prog), now))` builds the permissionless crank. The program derives
or checks every input account, so a wrong account fails the instruction instead of changing a price. A feed value is `0`
when its flag says the input was missing or failed a check (`feed.flagNames`, `feed.blocked`): test flags first.

## Errors and safety

`CoreError` (mapped from the IDL by code, with the simulation logs), `ProgramError` (klend), `TxError`. `redact()` removes RPC
keys and URLs from any text; every SDK error message goes through it. Never put a key in the SDK, a client bundle or a log.

## Examples

`examples/` has runnable scripts (`pnpm tsx examples/read-feed.ts` against a fork from `scripts/demo-app.sh`; `quote-and-buy.ts`;
`book-flow.ts`). They typecheck with the package (`pnpm typecheck`).
