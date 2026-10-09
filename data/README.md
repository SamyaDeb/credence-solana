# Data

Inputs and outputs of the pricing model. All files are generated; the generator for each is named below.

| Folder | Contents | Produced by |
|---|---|---|
| `scenarios/` | Calibrated weekend gap sets (3,000 standardised gaps each) for SPY and NVDA | Calibration pipeline (Alpaca SIP, Jan 2016 – Sept 2026) |
| `joint/` | Joint stress set: the 256 worst historical and synthetic weekends across assets | Calibration pipeline |
| `sigma/` | Recent weekend σ per asset, the long-run σ floor and every closure's opening gap since 2016 | Calibration pipeline, `scripts/src/sigma-floor.ts` |
| `calendars/` | Reference XNYS session calendar used to cross-check the on-chain one | Exchange holiday lists |
| `onchain/` | What the program stores: per-asset scenario sets, joint set, asset config, calendar | `scripts/src/gen-onchain.ts`, `scripts/src/gen-calendar.ts` |
| `backtest/` | Gap Cover backtest of a model book through ten years of dated weekends | `cargo run -p credence-core --example backtest --release` |
| `positions/` | Snapshot of Kamino xStocks obligations and their weekend exposure | `scripts/src/positions.ts` |
| `live/` | Mainnet oracle readings around the weekend close and open | `scripts/src/record-prices.ts`, `scripts/src/s7-history.ts` |
| `demo/` | The last end-to-end fork run and what it simulated | `scripts/demo.sh` |

**QQQ.** The scenario and joint sets have no QQQ column. QQQx uses SPY's weekend set with a scaled σ; the
derivation is recorded in `onchain/assets.json` (`sigmaSource`) and `scripts/src/gen-onchain.ts`.

**Licence.** The calibration uses Alpaca SIP data under a personal licence that does not cover commercial use. The
sets must be rebuilt on licensed data before a production deployment.
