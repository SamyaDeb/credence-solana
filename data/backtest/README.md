# Backtest (alpaca, data grade `free-2016`, through 2026-09-25)

Machine-readable: `backtest-371ff1936fd2fdf6.json`. Every safe LTV, premium, loss vector, capacity check, lot and settlement is risk-core output through `credence_cal.engine` (PyEngine); this report only counts and sums. Method: `credence_cal/backtest.py` (module docstring). Base parameters: α 0.10%, κ 3%, θ 100%, c 15%, η 4, β 97.5%, u_max 50%, pool equity $2,000,000. Synthetic stress levels (ADR-0204): {'since2000': -8.08, '40y': -9.2}.

## Walk-forward (headline, out of sample), from 2018-01-01

Breach frequency vs α (a breach: the realised open factor (1 + r)(1 − κ) below the α-quantile safe factor g_α): **7 / 16651 = 0.0420% [0.0169%, 0.0866%], Kupiec p 0.0074**, expected 16.651.

| Closure type | breaches / trials, 95% CI, Kupiec |
| --- | --- |
| OVERNIGHT | 3 / 13016 = 0.0230% [0.0048%, 0.0673%], Kupiec p 0.0008 |
| WEEKEND | 4 / 2997 = 0.1335% [0.0364%, 0.3414%], Kupiec p 0.5815 |
| HOLIDAY_WEEKEND | 0 / 638 = 0.0000% [0.0000%, 0.5765%], Kupiec p 0.2585 |

| Asset:type | breaches / trials, 95% CI, Kupiec |
| --- | --- |
| AAPL:OVERNIGHT | 0 / 1715 = 0.0000% [0.0000%, 0.2149%], Kupiec p 0.064 |
| AAPL:WEEKEND | 1 / 395 = 0.2532% [0.0064%, 1.4024%], Kupiec p 0.4206 |
| AAPL:HOLIDAY_WEEKEND | 0 / 85 = 0.0000% [0.0000%, 4.2470%], Kupiec p 0.68 |
| AMZN:OVERNIGHT | 0 / 1715 = 0.0000% [0.0000%, 0.2149%], Kupiec p 0.064 |
| AMZN:WEEKEND | 0 / 395 = 0.0000% [0.0000%, 0.9295%], Kupiec p 0.374 |
| AMZN:HOLIDAY_WEEKEND | 0 / 85 = 0.0000% [0.0000%, 4.2470%], Kupiec p 0.68 |
| COIN:OVERNIGHT | 1 / 1011 = 0.0989% [0.0025%, 0.5499%], Kupiec p 0.9913 |
| COIN:WEEKEND | 1 / 232 = 0.4310% [0.0109%, 2.3780%], Kupiec p 0.2386 |
| COIN:HOLIDAY_WEEKEND | 0 / 43 = 0.0000% [0.0000%, 8.2211%], Kupiec p 0.7693 |
| GOOGL:OVERNIGHT | 1 / 1715 = 0.0583% [0.0015%, 0.3244%], Kupiec p 0.5533 |
| GOOGL:WEEKEND | 0 / 395 = 0.0000% [0.0000%, 0.9295%], Kupiec p 0.374 |
| GOOGL:HOLIDAY_WEEKEND | 0 / 85 = 0.0000% [0.0000%, 4.2470%], Kupiec p 0.68 |
| MSFT:OVERNIGHT | 0 / 1715 = 0.0000% [0.0000%, 0.2149%], Kupiec p 0.064 |
| MSFT:WEEKEND | 0 / 395 = 0.0000% [0.0000%, 0.9295%], Kupiec p 0.374 |
| MSFT:HOLIDAY_WEEKEND | 0 / 85 = 0.0000% [0.0000%, 4.2470%], Kupiec p 0.68 |
| NVDA:OVERNIGHT | 1 / 1715 = 0.0583% [0.0015%, 0.3244%], Kupiec p 0.5533 |
| NVDA:WEEKEND | 1 / 395 = 0.2532% [0.0064%, 1.4024%], Kupiec p 0.4206 |
| NVDA:HOLIDAY_WEEKEND | 0 / 85 = 0.0000% [0.0000%, 4.2470%], Kupiec p 0.68 |
| SPY:OVERNIGHT | 0 / 1715 = 0.0000% [0.0000%, 0.2149%], Kupiec p 0.064 |
| SPY:WEEKEND | 1 / 395 = 0.2532% [0.0064%, 1.4024%], Kupiec p 0.4206 |
| SPY:HOLIDAY_WEEKEND | 0 / 85 = 0.0000% [0.0000%, 4.2470%], Kupiec p 0.68 |
| TSLA:OVERNIGHT | 0 / 1715 = 0.0000% [0.0000%, 0.2149%], Kupiec p 0.064 |
| TSLA:WEEKEND | 0 / 395 = 0.0000% [0.0000%, 0.9295%], Kupiec p 0.374 |
| TSLA:HOLIDAY_WEEKEND | 0 / 85 = 0.0000% [0.0000%, 4.2470%], Kupiec p 0.68 |

Pool: 2195 epochs; mean epoch P&L $1,138.39 (sd $1,405.09); total $2,498,756.26; mean annual return on J0 13.88%; premiums $1,522,463.80; shortfalls $13,653.50; liquidations 1495.

Epoch P&L quantiles (USD): {'0.001': 256.97, '0.01': 285.84, '0.05': 336.65, '0.5': 754.2, '0.95': 3354.57}.

Premiums by closure type: OVERNIGHT $1,423,838.93 on 164,883 covers ($8.64 each); WEEKEND $89,824.12 on 36,601 covers ($2.45 each); HOLIDAY_WEEKEND $8,800.74 on 7,685 covers ($1.15 each).

Breach events: NVDA 2018-11-16 OVERNIGHT r -19.30% (σ 1.92%), NVDA 2019-01-28 WEEKEND r -14.74% (σ 1.73%), GOOGL 2019-04-30 OVERNIGHT r -8.14% (σ 0.50%), SPY 2020-03-09 WEEKEND r -7.44% (σ 1.30%), COIN 2022-05-11 OVERNIGHT r -24.86% (σ 2.16%), AAPL 2024-08-05 WEEKEND r -9.45% (σ 1.01%), COIN 2024-08-05 WEEKEND r -20.75% (σ 2.48%).

Worst epoch: 2022-05-11 (OVERNIGHT) $-10,382.79, shortfall $13,653.50 (0.52% of J0). Worst full calendar year: 2021 $141,903.41.

Capacity binding rate (epochs with at least one cover refused): 0.32% (weekend and holiday closures only: 1.46%); 641 of 209169 cover requests refused.

Senior-loss events: 0 (none).

Largest shortfall epochs: 2022-05-11 OVERNIGHT $13,653.50.

## In-sample (every closure since the data start), from 2016-04-22

Breach frequency vs α (a breach: the realised open factor (1 + r)(1 − κ) below the α-quantile safe factor g_α): **6 / 19591 = 0.0306% [0.0112%, 0.0666%], Kupiec p 0.0003**, expected 19.591.

| Closure type | breaches / trials, 95% CI, Kupiec |
| --- | --- |
| OVERNIGHT | 3 / 15368 = 0.0195% [0.0040%, 0.0570%], Kupiec p 0.0001 |
| WEEKEND | 3 / 3536 = 0.0848% [0.0175%, 0.2477%], Kupiec p 0.7696 |
| HOLIDAY_WEEKEND | 0 / 687 = 0.0000% [0.0000%, 0.5355%], Kupiec p 0.241 |

| Asset:type | breaches / trials, 95% CI, Kupiec |
| --- | --- |
| AAPL:OVERNIGHT | 0 / 2051 = 0.0000% [0.0000%, 0.1797%], Kupiec p 0.0428 |
| AAPL:WEEKEND | 1 / 472 = 0.2119% [0.0054%, 1.1747%], Kupiec p 0.5042 |
| AAPL:HOLIDAY_WEEKEND | 0 / 92 = 0.0000% [0.0000%, 3.9303%], Kupiec p 0.6679 |
| AMZN:OVERNIGHT | 0 / 2051 = 0.0000% [0.0000%, 0.1797%], Kupiec p 0.0428 |
| AMZN:WEEKEND | 0 / 472 = 0.0000% [0.0000%, 0.7785%], Kupiec p 0.3311 |
| AMZN:HOLIDAY_WEEKEND | 0 / 92 = 0.0000% [0.0000%, 3.9303%], Kupiec p 0.6679 |
| COIN:OVERNIGHT | 1 / 1011 = 0.0989% [0.0025%, 0.5499%], Kupiec p 0.9913 |
| COIN:WEEKEND | 1 / 232 = 0.4310% [0.0109%, 2.3780%], Kupiec p 0.2386 |
| COIN:HOLIDAY_WEEKEND | 0 / 43 = 0.0000% [0.0000%, 8.2211%], Kupiec p 0.7693 |
| GOOGL:OVERNIGHT | 0 / 2051 = 0.0000% [0.0000%, 0.1797%], Kupiec p 0.0428 |
| GOOGL:WEEKEND | 0 / 472 = 0.0000% [0.0000%, 0.7785%], Kupiec p 0.3311 |
| GOOGL:HOLIDAY_WEEKEND | 0 / 92 = 0.0000% [0.0000%, 3.9303%], Kupiec p 0.6679 |
| MSFT:OVERNIGHT | 1 / 2051 = 0.0488% [0.0012%, 0.2714%], Kupiec p 0.4145 |
| MSFT:WEEKEND | 0 / 472 = 0.0000% [0.0000%, 0.7785%], Kupiec p 0.3311 |
| MSFT:HOLIDAY_WEEKEND | 0 / 92 = 0.0000% [0.0000%, 3.9303%], Kupiec p 0.6679 |
| NVDA:OVERNIGHT | 0 / 2051 = 0.0000% [0.0000%, 0.1797%], Kupiec p 0.0428 |
| NVDA:WEEKEND | 1 / 472 = 0.2119% [0.0054%, 1.1747%], Kupiec p 0.5042 |
| NVDA:HOLIDAY_WEEKEND | 0 / 92 = 0.0000% [0.0000%, 3.9303%], Kupiec p 0.6679 |
| SPY:OVERNIGHT | 1 / 2051 = 0.0488% [0.0012%, 0.2714%], Kupiec p 0.4145 |
| SPY:WEEKEND | 0 / 472 = 0.0000% [0.0000%, 0.7785%], Kupiec p 0.3311 |
| SPY:HOLIDAY_WEEKEND | 0 / 92 = 0.0000% [0.0000%, 3.9303%], Kupiec p 0.6679 |
| TSLA:OVERNIGHT | 0 / 2051 = 0.0000% [0.0000%, 0.1797%], Kupiec p 0.0428 |
| TSLA:WEEKEND | 0 / 472 = 0.0000% [0.0000%, 0.7785%], Kupiec p 0.3311 |
| TSLA:HOLIDAY_WEEKEND | 0 / 92 = 0.0000% [0.0000%, 3.9303%], Kupiec p 0.6679 |

Pool: 2615 epochs; mean epoch P&L $838.72 (sd $1,228.88); total $2,193,259.64; mean annual return on J0 9.97%; premiums $1,079,394.04; shortfalls $12,483.38; liquidations 1578.

Epoch P&L quantiles (USD): {'0.001': 247.89, '0.01': 247.89, '0.05': 247.89, '0.5': 510.26, '0.95': 2694.57}.

Premiums by closure type: OVERNIGHT $957,000.21 on 190,637 covers ($5.02 each); WEEKEND $111,105.72 on 42,975 covers ($2.59 each); HOLIDAY_WEEKEND $11,288.11 on 8,298 covers ($1.36 each).

Breach events: SPY 2016-06-24 OVERNIGHT r -3.41% (σ 0.40%), NVDA 2019-01-28 WEEKEND r -14.74% (σ 1.73%), COIN 2022-05-11 OVERNIGHT r -24.86% (σ 2.16%), AAPL 2024-08-05 WEEKEND r -9.45% (σ 1.01%), COIN 2024-08-05 WEEKEND r -20.75% (σ 2.62%), MSFT 2026-01-29 OVERNIGHT r -8.65% (σ 0.76%).

Worst epoch: 2022-05-11 (OVERNIGHT) $-7,735.67, shortfall $12,483.38 (0.39% of J0). Worst full calendar year: 2017 $90,954.75.

Capacity binding rate (epochs with at least one cover refused): 0.65% (weekend and holiday closures only: 1.60%); 632 of 241910 cover requests refused.

Senior-loss events: 0 (none).

Largest shortfall epochs: 2022-05-11 OVERNIGHT $12,483.38.

## Sensitivity (walk-forward; one parameter moved from the base at a time)

| Parameter | value | breaches / trials | rate | annual return on J0 | premiums | shortfalls | worst epoch | worst year | capacity binding | senior-loss events |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| alpha | 0.0005 | 3 / 16651 | 0.0180% | 14.47% | $1,631,212 | $12,409 | $-9,008 | $149,067 | 0.23% | 0 |
| alpha | 0.001 | 7 / 16651 | 0.0420% | 13.88% | $1,522,464 | $13,654 | $-10,383 | $141,903 | 0.32% | 0 |
| alpha | 0.002 | 24 / 16651 | 0.1441% | 13.66% | $1,478,808 | $13,654 | $-10,399 | $139,544 | 0.50% | 0 |
| alpha | 0.005 | 91 / 16651 | 0.5465% | 12.99% | $1,356,726 | $13,654 | $-10,399 | $139,154 | 1.59% | 0 |
| kappa | 0.02 | 7 / 16651 | 0.0420% | 13.40% | $1,437,687 | $8,471 | $-5,290 | $139,008 | 0.27% | 0 |
| kappa | 0.03 | 7 / 16651 | 0.0420% | 13.88% | $1,522,464 | $13,654 | $-10,383 | $141,903 | 0.32% | 0 |
| kappa | 0.04 | 7 / 16651 | 0.0420% | 14.41% | $1,616,595 | $18,926 | $-15,543 | $145,069 | 0.32% | 0 |
| kappa | 0.05 | 7 / 16651 | 0.0420% | 14.98% | $1,723,363 | $25,922 | $-20,829 | $148,968 | 0.32% | 0 |
| theta | 0.5 | 7 / 16651 | 0.0420% | 11.87% | $1,160,630 | $13,654 | $-10,474 | $130,201 | 0.32% | 0 |
| theta | 1 | 7 / 16651 | 0.0420% | 13.88% | $1,522,464 | $13,654 | $-10,383 | $141,903 | 0.32% | 0 |
| theta | 1.5 | 7 / 16651 | 0.0420% | 15.89% | $1,884,585 | $13,654 | $-10,291 | $153,617 | 0.32% | 0 |
| u_max | 0.4 | 7 / 16651 | 0.0420% | 13.82% | $1,518,107 | $13,654 | $-10,383 | $141,903 | 0.55% | 0 |
| u_max | 0.5 | 7 / 16651 | 0.0420% | 13.88% | $1,522,464 | $13,654 | $-10,383 | $141,903 | 0.32% | 0 |
| u_max | 0.6 | 7 / 16651 | 0.0420% | 13.92% | $1,529,368 | $13,654 | $-10,383 | $141,903 | 0.18% | 0 |
| eta | 2 | 7 / 16651 | 0.0420% | 13.67% | $1,484,610 | $13,654 | $-10,383 | $141,884 | 0.32% | 0 |
| eta | 4 | 7 / 16651 | 0.0420% | 13.88% | $1,522,464 | $13,654 | $-10,383 | $141,903 | 0.32% | 0 |
| eta | 6 | 7 / 16651 | 0.0420% | 14.09% | $1,560,323 | $13,654 | $-10,383 | $141,923 | 0.32% | 0 |
