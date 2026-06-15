# Detection eval — 2026-06-15 (K=10)

Run with Sonnet 4.6, OlistDataSource live, on 3 seeded anomalies.

## Aggregate

| Metric            | Loose (2-of-3)  | Strict (3-of-3) |
|---|---|---|
| Precision (mean)  | 5.0% | 0.0% |
| Precision (std)   | ±15.0% | ±0.0% |
| Recall (mean)     | 6.7% | 0.0% |
| Recall (std)      | ±20.0% | ±0.0% |
| False positives   | 0.2 ±0.6 | 0.4 ±1.2 |

## Per anomaly

| Anomaly                       | Detected (strict) | Detected (loose) |
|---|---|---|
| electronics-spike-w2 | 0/10 (0.0%) | 0/10 (0.0%) |
| sp-revenue-drop-w4 | 0/10 (0.0%) | 1/10 (10.0%) |
| voucher-dropoff-w10-on | 0/10 (0.0%) | 1/10 (10.0%) |

Total Anthropic spend: (not tracked — read the dashboard)
Total runtime: 3:55
