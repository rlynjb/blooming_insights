# Detection eval — 2026-06-15 (K=10)

Run with Sonnet 4.6, OlistDataSource live, on 3 seeded anomalies.

## Aggregate

| Metric            | Loose (2-of-3)  | Strict (3-of-3) |
|---|---|---|
| Precision (mean)  | 37.0% | 0.0% |
| Precision (std)   | ±15.1% | ±0.0% |
| Recall (mean)     | 33.3% | 0.0% |
| Recall (std)      | ±0.0% | ±0.0% |
| False positives   | 2.2 ±1.1 | 3.3 ±1.0 |

## Per anomaly

| Anomaly                       | Detected (strict) | Detected (loose) |
|---|---|---|
| electronics-spike-w2 | 0/10 (0.0%) | 0/10 (0.0%) |
| sp-revenue-drop-w4 | 0/10 (0.0%) | 0/10 (0.0%) |
| voucher-dropoff-w10-on | 0/10 (0.0%) | 10/10 (100.0%) |

Total Anthropic spend: (not tracked — read the dashboard)
Total runtime: 10:43

## Comparison with pre-fix run (`eval/results/2026-06-15/`)

| Metric              | Pre-fix    | Post-fix    | Δ           |
|---|---|---|---|
| Loose precision     | 5.0%       | **37.0%**   | **+32.0**   |
| Loose recall        | 6.7%       | **33.3%**   | **+26.6**   |
| Strict precision    | 0.0%       | 0.0%        | unchanged   |
| Strict recall       | 0.0%       | 0.0%        | unchanged   |
| False positives     | 0.2        | 2.2         | +2.0        |

## Per anomaly Δ

| Anomaly                | Pre-fix loose | Post-fix loose | Δ          |
|---|---|---|---|
| sp-revenue-drop-w4     | 1/10          | 0/10           | −1         |
| electronics-spike-w2   | 0/10          | 0/10           | unchanged  |
| voucher-dropoff-w10-on | 1/10          | **10/10**      | **+9**     |

## Honest interpretation

The fix is a partial win, not a complete one.

What worked:
- Voucher-dropoff went from 1/10 → 10/10 detection (5x → perfect)
- This is the EASIEST anomaly to detect — sustained from week 10+ across
  every subsequent week, dramatic magnitude (×0.05 baseline), shows up in
  payment_value/payment_type queries which the 3-dimension scan now forces
- Loose recall lifted ~5x (6.7% → 33.3%)

What didn't work:
- sp-revenue-drop-w4 went from 1/10 → 0/10 (slight regression)
- electronics-spike-w2 stayed 0/10
- STRICT remained 0% across the board (no time-anchored insights)
- False positives doubled (0.2 → 2.2) — natural side-effect of more breadth

Root cause for the remaining gap: the "recent 4w vs baseline 12w"
framing fundamentally cannot detect mid-horizon week-specific anomalies.

- SP revenue dropped in week 4 of 26; voucher anomaly is in weeks 10+
- The "recent" window (last 4w) covers weeks 23-26 — catches voucher
  perfectly but doesn't touch weeks 2 or 4
- Even when querying weekly granularity, the agent doesn't synthesize
  "is week 4 unusual vs the rest" — it asks "what's recent vs baseline"

## What this means for next iteration

Two paths to lift strict detection:

Path A (prompt-level): Add a sliding-window scan plan to the monitoring
prompt — multiple recent/baseline pairs covering different parts of the
horizon, OR explicit instruction to look for the LARGEST deviation
across all weeks, not just the most recent.

Path B (tool-level): Add a `detect_outliers` tool to the MCP server that
returns statistical outliers across the full horizon using z-score. The
agent calls it once per dimension and reads the result.

Path A is cheaper to try first (~$1-3 + 30 min); Path B is the real fix
(~3-4 hours work). Both are honest eval-flywheel iterations.

## What this means for PR E (diagnosis rubric)

Diagnosis rubric is now CREDIBLE for the voucher anomaly (10/10
detection means the diagnostic agent has real input to diagnose).

For SP-revenue and electronics it's still vacuous — can't diagnose
what wasn't detected.

Three options:
1. Run diagnosis eval against just voucher (N=10; isolated)
2. Wait for Phase 2.6 (sliding window or detect_outliers) → score all 3
3. Bypass detection: have PR E invoke DiagnosticAgent directly on each
   seeded anomaly's metadata. Isolates diagnosis quality from detection.

Option 3 is cleanest — diagnosis evals score the diagnostic agent's
reasoning independently of the detection pipeline.

