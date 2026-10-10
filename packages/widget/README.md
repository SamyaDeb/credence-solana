# @credence/widget

Gap protection next to a lending position: the weekend gap, the position's risk, a quote and a buy button, and the status of
the cover afterwards. A React component built on [`@credence/sdk`](../sdk/README.md).

**Status:** built and tested against the local mainnet fork. `credence_core` is not deployed anywhere else, so the widget
refuses to build a transaction on mainnet, and the package is **not published**. Wording in anything you build on it: "gap
protection", "risk data", never "insurance".

**It never holds keys, never creates its own RPC connection and never signs on its own.** The host passes `connection` and
`wallet`; a transaction reaches the wallet only after a person presses *Buy cover*, and only after it was built by the SDK,
simulated and shape-checked (`shapeProblem`: exactly the compute-budget pair, klend's refreshes, one credence_core buy, the
wallet as only signer, no lookup tables; one leading `release_book_leg` is allowed for a position held by a curator's book).

```tsx
import { CredenceProtect } from '@credence/widget';
import '@credence/widget/style.css';

<CredenceProtect connection={connection} wallet={wallet} position={obligationAddress} lender="kamino" />
```

| Prop | |
|---|---|
| `connection` | the host's `Connection` (required) |
| `wallet` | `{ publicKey, signTransaction }` from the host's wallet adapter, or `null` (read-only view) |
| `position` | the Kamino obligation address (string or `PublicKey`) |
| `lender` | `"kamino"` (`"jupiter"` is recognised and explained, not supported here yet: use the Protect Action) |
| `slippageBps` | `max_premium` = the quote + this (default 100), via the SDK's `withSlippage` |
| `upkeep` | fork-only hooks `{ scopeFresh, offline }` the host can provide (restamp Scope prices; mark accounts local-only). Omit anywhere else |
| `theme` | `"auto"` (system), `"light"`, `"dark"`; or override the `--cr-*` CSS variables |

Smaller parts, for hosts that lay it out themselves: `GapLine`, `RiskTable`, `QuoteBuy`, `CoverStatus`, and the functions
under them: `loadPosition`, `quoteFor`, `buildPurchase`, `purchase`, `followPolicy`.

## What it shows

1. **Gap line:** the 24/7 price vs the Friday close, the lender's price vs the same close, and whether the lender's price is
   still frozen and for how long (`readFeeds`, `feedProblems`).
2. **Risk:** D/C′, in how many of the asset's weekend scenarios the position is liquidatable, and the repayment a −5 / −8 / −12%
   Monday would need (`riskView` in the SDK; vector-tested against the Rust payout rule).
3. **Quote and buy:** the premium is the program's `quote_cover` simulated; the transaction is built by `buyCover` (which puts
   `release_book_leg` first if a book holds the position), simulated, then the wallet signs. After confirmation: the signature
   and the compute units.
4. **Status:** the policy state, Shield advances and settlement, from the account and `parseEvents`.

There is no pricing or risk arithmetic in the widget; every number is the SDK's or a simulated instruction's
(`test/guards.test.tsx` `c4b_no_js_math`, `test/render.test.tsx`).

## Safety

- On connect (`loadPosition`), before any position is read: the connection's genesis hash is checked (**mainnet is refused**,
  the widget says "fork") and `checkProgram` compares the cluster's program with the IDL this widget was built with (a
  mismatch is refused with the reason).
- `CoreError` messages from a failed simulation are decoded (`CoreError::Name (code): message`).
- Inputs are validated (`position` base58 / `PublicKey`, `lender` one of two words); nothing is rendered with `innerHTML`.
- **One copy of three libraries.** `@solana/web3.js`, `@anchor-lang/core` and `bn.js` (and React) must resolve to one copy in
  the host's bundle, or `PublicKey` identity breaks. A key from another copy is detected and reported by name
  (`SingleCopyError`). Vite: `resolve.alias` + `dedupe` (see `examples/host/vite.config.ts`); Next: `turbopack.resolveAlias` /
  `webpack` alias (see `app/next.config.ts`).

## Install and build

```
cd packages/widget && pnpm install && pnpm build     # builds the SDK, then tsup (ESM + CJS + types) and style.css
pnpm test                                           # unit + attack tests + the bundle-size budget
cd examples/host && pnpm install && pnpm dev        # the sample host (needs the fork: scripts/demo-app.sh)
```

**Bundle budget** (enforced in `test/size.test.ts`): the widget's own code, gzip: ESM ≤ 10 KB, CJS ≤ 11 KB, CSS ≤ 2 KB. At
first measurement it was 6.6 KB, 7.0 KB and 1.3 KB; the budget is about 1.5× that, enough for a few features and not for a
dependency sneaking in. React, the SDK, web3.js, anchor and bn.js are peers and stay out of the bundle. A host's real
cost is those peers: the sample host's production build is ~317 KB gzip, almost all of it web3.js, anchor and the SDK.

## End to end

`examples/host/e2e/widget.spec.ts` (Playwright, on the fork): connect the burner → the gap line and risk → buy → the policy
appears → run the demo weekend → the settlement shows.

```
FORK_PORT=8949 PORT=3005 scripts/demo-app.sh            # fork + app
cd packages/widget/examples/host && APP_URL=http://localhost:3005 FORK_PORT=8949 HOST_PORT=3006 pnpm exec playwright test
```

## Not in this version

- Jupiter Lend positions and multi-collateral Kamino obligations (the Protect Action covers them).
- Overnight and holiday closures: the widget sells the weekend epoch only, like the Action.
- Wallet adapters: `wallet` is the minimal `{ publicKey, signTransaction }`; connecting a wallet is the host's job.
