# Scenario sets (alpaca, data grade `free-2016`, through 2026-09-25)

Pooling rule and its effect on the tail: ADR-0203. Tail floor (the more severe of history and the t₃ stand-in below the 2.5% quantile): ADR-0204. z in thousandths of σ; i* = ceil(α N) − 1 at α = 0.1%.

| Asset | Closure | N | Pool | z at i* (set) | pooled history | t₃ | values moved by t₃ | min (set) | own N | z at α (own only) | min (own) | padded with weekend | File |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| NVDA | OVERNIGHT | 3000 | 32816 | -11144 | -11144 | -6276 | 0 | -16430 | 2051 | -3961 | -10068 | — | `NVDA-XNAS-1-71b80aa3.json` |
| NVDA | WEEKEND | 3000 | 7552 | -7208 | -7208 | -6276 | 1 | -10802 | 472 | -8500 | -8500 | — | `NVDA-XNAS-2-57154f93.json` |
| NVDA | HOLIDAY_WEEKEND | 1472 | 1472 | -5860 | -5021 | -5860 | 2 | -8502 | 92 | -5355 | -5355 | — | `NVDA-XNAS-3-314c3954.json` |
| AAPL | OVERNIGHT | 3000 | 32816 | -11144 | -11144 | -6276 | 0 | -16430 | 2051 | -10421 | -10647 | — | `AAPL-XNAS-1-93475757.json` |
| AAPL | WEEKEND | 3000 | 7552 | -7208 | -7208 | -6276 | 1 | -10802 | 472 | -9318 | -9318 | — | `AAPL-XNAS-2-d8db8648.json` |
| AAPL | HOLIDAY_WEEKEND | 1472 | 1472 | -5860 | -5021 | -5860 | 2 | -8502 | 92 | -5021 | -5021 | — | `AAPL-XNAS-3-d7a70435.json` |
| TSLA | OVERNIGHT | 3000 | 17171 | -9375 | -9375 | -6276 | 0 | -16496 | 2051 | -7607 | -9859 | — | `TSLA-XNAS-1-6f50c5fa.json` |
| TSLA | WEEKEND | 3000 | 3947 | -7208 | -7208 | -6276 | 0 | -11549 | 472 | -3968 | -3968 | — | `TSLA-XNAS-2-f9786acc.json` |
| TSLA | HOLIDAY_WEEKEND | 3000 | 4711 | -7324 | -7324 | -6276 | 0 | -11549 | 92 | -4805 | -4805 | TSLA, COIN, MSTR, MARA, RIOT, HOOD, PLTR, SHOP, ROKU, AMD, NFLX | `TSLA-XNAS-3-40700cdb.json` |
| COIN | OVERNIGHT | 3000 | 17171 | -9375 | -9375 | -6276 | 0 | -16496 | 1011 | -6561 | -11529 | — | `COIN-XNAS-1-bd858cee.json` |
| COIN | WEEKEND | 3000 | 3947 | -7208 | -7208 | -6276 | 0 | -11549 | 232 | -8515 | -8515 | — | `COIN-XNAS-2-70d84c92.json` |
| COIN | HOLIDAY_WEEKEND | 3000 | 4711 | -7324 | -7324 | -6276 | 0 | -11549 | 43 | -2348 | -2348 | COIN, TSLA, MSTR, MARA, RIOT, HOOD, PLTR, SHOP, ROKU, AMD, NFLX | `COIN-XNAS-3-f59992c4.json` |
| MSFT | OVERNIGHT | 3000 | 32816 | -11144 | -11144 | -6276 | 0 | -16430 | 2051 | -6665 | -11408 | — | `MSFT-XNAS-1-08f68241.json` |
| MSFT | WEEKEND | 3000 | 7552 | -7208 | -7208 | -6276 | 1 | -10802 | 472 | -7528 | -7528 | — | `MSFT-XNAS-2-9267c3c4.json` |
| MSFT | HOLIDAY_WEEKEND | 1472 | 1472 | -5860 | -5021 | -5860 | 2 | -8502 | 92 | -4667 | -4667 | — | `MSFT-XNAS-3-1f1f82ad.json` |
| SPY | OVERNIGHT | 3000 | 24612 | -6276 | -5994 | -6276 | 7 | -10802 | 2051 | -4841 | -8421 | — | `SPY-XNAS-1-d5f23580.json` |
| SPY | WEEKEND | 3000 | 5663 | -6276 | -6121 | -6276 | 1 | -11084 | 472 | -6121 | -6121 | — | `SPY-XNAS-2-d0f2e482.json` |
| SPY | HOLIDAY_WEEKEND | 1104 | 1104 | -5311 | -4404 | -5311 | 4 | -7716 | 92 | -2913 | -2913 | — | `SPY-XNAS-3-9dbaae4c.json` |
| GOOGL | OVERNIGHT | 3000 | 32816 | -11144 | -11144 | -6276 | 0 | -16430 | 2051 | -8833 | -16247 | — | `GOOGL-XNAS-1-45dec169.json` |
| GOOGL | WEEKEND | 3000 | 7552 | -7208 | -7208 | -6276 | 1 | -10802 | 472 | -5222 | -5222 | — | `GOOGL-XNAS-2-d92031c0.json` |
| GOOGL | HOLIDAY_WEEKEND | 1472 | 1472 | -5860 | -5021 | -5860 | 2 | -8502 | 92 | -4670 | -4670 | — | `GOOGL-XNAS-3-f4d2fca8.json` |
| AMZN | OVERNIGHT | 3000 | 32816 | -11144 | -11144 | -6276 | 0 | -16430 | 2051 | -8347 | -13705 | — | `AMZN-XNAS-1-caed5bcf.json` |
| AMZN | WEEKEND | 3000 | 7552 | -7208 | -7208 | -6276 | 1 | -10802 | 472 | -5488 | -5488 | — | `AMZN-XNAS-2-ce59d30d.json` |
| AMZN | HOLIDAY_WEEKEND | 1472 | 1472 | -5860 | -5021 | -5860 | 2 | -8502 | 92 | -4491 | -4491 | — | `AMZN-XNAS-3-e6db72ad.json` |

## Joint stress set (`joint-38f0d2af.json`)

K = 256 worst of 564 non-overnight closures (2016-04-25 → 2026-09-21), ranked by synthetic stress closures first (ADR-0204), then historical closures by equal-weighted mean z of the six assets, ascending (worst first). Back-fill: OLS through the origin of z_a on z_SPY over non-overnight closures where both exist.

| Asset | β to SPY (z) | back-filled closures |
| --- | ---: | ---: |
| NVDA | 0.807 | 0 |
| AAPL | 0.813 | 0 |
| TSLA | 0.539 | 0 |
| COIN | 0.786 | 289 |
| MSFT | 0.843 | 0 |
| GOOGL | 0.853 | 0 |
| AMZN | 0.824 | 0 |

Synthetic stress closures (ADR-0204): POT/GPD return levels of the historical basket z; GPD over the worst 10% of basket z (57 exceedances, ξ = 0.2745, scale 0.6706, 54.2 closures/year, worst observed −6.3894). Shapes: the worst historical closure (2024-08-05) scaled, and all assets equal.

| Horizon | years | closures | basket z |
| --- | ---: | ---: | ---: |
| since2000 | 26.72 | 1448.2 | -8.08 |
| 40y | 40.0 | 2167.9 | -9.2 |

Worst ten:

| # | Reopen session | Closure | basket mean z |
| ---: | --- | --- | ---: |
| 1 | SYN-40y-worstHistorical | SYNTHETIC | -9.200 |
| 2 | SYN-40y-uniform | SYNTHETIC | -9.200 |
| 3 | SYN-since2000-worstHistorical | SYNTHETIC | -8.080 |
| 4 | SYN-since2000-uniform | SYNTHETIC | -8.080 |
| 5 | 2024-08-05 | WEEKEND | -6.389 |
| 6 | 2020-02-24 | WEEKEND | -4.457 |
| 7 | 2020-03-09 | WEEKEND | -4.380 |
| 8 | 2020-09-08 | HOLIDAY_WEEKEND | -4.077 |
| 9 | 2020-03-16 | WEEKEND | -3.670 |
| 10 | 2020-01-27 | WEEKEND | -3.223 |
