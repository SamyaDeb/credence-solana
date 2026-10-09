# Scenario sets

Weekend gap sets calibrated on Alpaca SIP data, Jan 2016 to Sept 25, 2026. Gaps `z` are in thousandths of σ; the tail
below the 2.5% quantile is floored by a Student-t (ν = 3) stand-in where that is more severe than history.
i* = ⌈α N⌉ − 1 at α = 0.1%.

| Asset | N | Pooled closures | z at i* | Min z | File |
|---|---:|---:|---:|---:|---|
| SPY | 3000 | 5,663 | −6,276 | −11,084 | `SPY-XNAS-2-d0f2e482.json` |
| NVDA | 3000 | 7,552 | −7,208 | −10,802 | `NVDA-XNAS-2-57154f93.json` |

## Joint stress set (`../joint/joint-38f0d2af.json`)

The 256 worst of 564 non-overnight closures (Apr 2016 – Sept 2026), ranked worst first: four synthetic stress
weekends (peaks-over-threshold / GPD return levels of the basket gap, at 26.7-year and 40-year horizons, basket z
−8.08 and −9.20), then historical closures by the basket's mean z (worst: 2024-08-05, −6.39; then Feb–Mar 2020).
Assets without full history are back-filled by OLS on SPY.
