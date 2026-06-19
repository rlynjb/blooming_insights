# Phase 3 plan — Eval (prove it correct)

> **RETIRED 2026-06-18.** Phase 3 (eval pipeline) has been removed from the
> codebase along with the Olist MCP server it depended on. The 4 portfolio
> numbers it produced (detection 37%/33%, diagnosis 53.3%, recommendation 100%,
> regression 30%) and the committed result paper trail at
> `eval/results/2026-06-15*/` are gone. This plan is preserved as a historical
> record of what was built and measured.

> Execution plan for **Phase 3 (Eval)** of `blooming-insights-portfolio-hardening-plan.md`.
> Phase 3's goal: report detection precision/recall and diagnosis rubric pass-rate as
> numbers, generated against data you control (the 3 seeded anomalies in
> `mcp-server-olist/data/olist.db`).

**Total estimate:** ~4–7 focused days across 4 sub-phases / 4 PRs.
**Discipline:** "Don't change these" list stays frozen. Phase 2's agents + adapters + prompts are the system under measurement; this phase scores them, doesn't change them.
**New artifacts allowed:** `eval/` package, judge prompts + reference diagnoses, scorecard outputs.
**Cost:** ~$1–5 per full eval run (real Anthropic API calls).

---

## Resolved decisions (2026-06-15)

```
Q1. Judge model:        claude-sonnet-4-6 (the working/eval/judge default)
                        Calibrated enough for criterion scoring; affordable
                        across all 4 PRs.
Q2. K (runs):           start K=10 in PR D to validate pipeline.
                        Bump to K=30 once judge spot-check passes.
                        Scripts take --K=<n> flag with K=10 default.
Q3. Match strictness:   report BOTH loose and strict from Step 1.
                        Loose = optimistic ceiling; strict = recruiter
                        number.
Q4. Eval results:       committed to eval/results/<YYYY-MM-DD>/<step>.json.
                        Paper trail for the portfolio defense.
Q5. Live MCP eval:      yes — OlistDataSource subprocess per agent run,
                        same path as production. Bounded by run script.
```

PR D is unblocked. Ready to execute when scheduled.

---

## What this is NOT

```
✗ Not unit tests. The 269-test suite is mock-scripted; this phase
  doesn't add to it. Eval runs make REAL Anthropic API calls + spawn
  the real Olist MCP server.

✗ Not pass/fail. Eval reports NUMBERS — precision, recall, rubric
  pass-rate. Pass/fail thresholds are set by the user looking at the
  numbers, not by an assert in code.

✗ Not the regression test from the source plan's Step 4 (separate
  sub-phase; see PR G).

✗ Not real-time. Eval batches run on demand (npm run eval:*), not in
  CI on every push (cost + latency).
```

---

## Eval scaffold (lands in PR D, used by all 4 steps)

```
eval/
  package.json                  optional sibling package (or just scripts/)
  README.md                     how to run, cost expectations
  fixtures/
    reference-diagnoses.json    one per seeded anomaly (for Step 2 judge)
    reference-recommendations.json  baseline action set (for Step 3 judge)
  judges/
    diagnosis-judge.md          the LLM-as-judge prompt for Step 2
    recommendation-judge.md     same shape for Step 3
  scripts/
    run-detection.ts            Step 1
    run-diagnosis.ts            Step 2
    run-recommendation.ts       Step 3
    run-regression.ts           Step 4
    lib/
      scorer.ts                 matching logic for Step 1
      judge.ts                  LLM-as-judge harness for Steps 2 + 3
      run-agent.ts              direct agent invocation (bypasses routes)
      summary.ts                aggregator: mean / std / CI
  results/
    YYYY-MM-DD/
      detection-K10-loose.json
      detection-K10-strict.json
      diagnosis-K10.json
      recommendation-K10.json
      regression-K1.json
      summary.md                human-readable scorecard

package.json scripts:
  eval:detection        runs Step 1
  eval:diagnosis        runs Step 2
  eval:recommendation   runs Step 3
  eval:regression       runs Step 4
  eval:all              all 4, writes a single summary.md
```

---

## PR D — Step 1: detection precision/recall (~1–2 days)

### What this scores

Run `MonitoringAgent.scan()` against the Olist data; score the emitted insights against the 3 seeded anomalies.

### Inputs

- Olist data via `OlistDataSource` (production path, real subprocess)
- The monitoring agent's existing prompt (Phase 2 PR C wired Olist hints in)
- `seeded_anomalies` table from the SQLite DB (the 3 ground-truth labels)

### Scoring logic

For each run of `agent.scan()`:
- The agent emits N insights (each has `metric`, `scope`, time window in the headline/summary)
- For each insight, attempt to match against each seeded anomaly:

```
LOOSE match (any 2 of 3):
  ✓ metric overlap          (insight.metric == seeded.metric, OR
                              insight mentions seeded.metric in text)
  ✓ segment overlap         (insight.scope mentions seeded.segment, e.g.,
                              insight has 'scope: ["state:SP"]' for SP-anomaly)
  ✓ time window overlap     (insight's reasoning mentions anomaly's
                              start_ts within ±1 week)

STRICT match: 3 of 3 above.
```

- An insight that matches a seeded anomaly = true positive
- Insights matching none = false positives
- Seeded anomalies with no match = false negatives

### Outputs

```json
{
  "run_id": "2026-06-15T...",
  "K": 10,
  "strictness": "loose" | "strict",
  "per_anomaly": {
    "sp-revenue-drop-w4":       { "detected": 9, "missed": 1 },
    "electronics-spike-w2":     { "detected": 7, "missed": 3 },
    "voucher-dropoff-w10-on":   { "detected": 10, "missed": 0 }
  },
  "aggregate": {
    "precision_mean": 0.72,
    "precision_std": 0.11,
    "recall_mean": 0.87,
    "recall_std": 0.08,
    "false_positive_mean": 4.3,
    "false_positive_std": 1.2
  }
}
```

Also write a human-readable `eval/results/<date>/summary.md` that the recruiter narrative pulls from.

### Honest scope

- Matching insights to seeded anomalies is a heuristic. The matcher is itself an artifact worth reviewing — write it explicitly, document the criteria, allow tuning.
- Variance comes from agent stochasticity (Anthropic sampling). K=10 gives ~30% confidence interval; K=30 tightens it.

### Files

```
A  eval/package.json (or root scripts entries)
A  eval/README.md
A  eval/scripts/lib/run-agent.ts          shared: spawn OlistDataSource,
                                            construct + run agent directly
A  eval/scripts/lib/scorer.ts             matching logic (loose + strict)
A  eval/scripts/lib/summary.ts            aggregator
A  eval/scripts/run-detection.ts          entry point
A  eval/results/.gitkeep                  results dir (gitignored content
                                            policy decided per Open Q #4)
A  package.json scripts                   eval:detection
```

### Verification

```
npm test                            269 still passing
npm run eval:detection -- --K=10    runs in ~2-5 min; ~$1
                                    writes eval/results/<date>/detection-K10-*.json
```

---

## PR E — Step 2: diagnosis rubric (LLM-as-judge) (~1–2 days)

### What this scores

For each seeded anomaly, run `DiagnosticAgent.investigate()`. Send the resulting diagnosis to a judge LLM with a reference diagnosis + criterion-based rubric.

### Reference diagnoses (commit to `eval/fixtures/reference-diagnoses.json`)

Three reference diagnoses, one per seeded anomaly:

```json
{
  "sp-revenue-drop-w4": {
    "anomaly_summary": "São Paulo state revenue declined ~30% in week 4",
    "investigation_should_examine": [
      "Which product categories drove the drop",
      "Whether payment types shifted (e.g., voucher → credit_card)",
      "Whether delivery/cancellation rates correlate",
      "Whether the drop concentrates in specific cities"
    ],
    "expected_evidence": [
      "get_metric_timeseries(revenue, dimension=category, filter=state:SP)",
      "get_metric_timeseries(payment_value, dimension=payment_type, filter=state:SP)",
      "get_anomaly_context(metric=revenue, dimension=state, segment=SP, ...)"
    ]
  },
  "electronics-spike-w2": { ... },
  "voucher-dropoff-w10-on": { ... }
}
```

### Judge rubric (criterion-based, anti-bias)

```
1. RIGHT HYPOTHESIS
   Does the diagnosis identify the seeded cause? (matches reference's
   anomaly_summary at >50% semantic overlap)
   Score: 0–2

2. REAL EVIDENCE
   Are the cited tool calls real? Do their results actually support the
   diagnosis? (judge has access to the tool-call transcript)
   Score: 0–2

3. SEGMENT SIZING
   Does the diagnosis acknowledge the magnitude correctly? (the seeded
   anomaly's multiplier — 0.7 for SP drop, 2.5 for electronics, 0.05 for
   voucher — should be roughly reflected in the diagnosis text)
   Score: 0–2

4. CALIBRATED CONFIDENCE
   No overclaiming. Acknowledges what's unknown. Suggests further
   investigation rather than asserting causation from correlation.
   Score: 0–1

5. NO FABRICATION
   Every claim is supported by a tool result. No "I would expect..."
   without evidence.
   Score: 0–2

Total: 0–9. Pass threshold: ≥7.
```

### Judge prompt (commit to `eval/judges/diagnosis-judge.md`)

Structure:
- System: "You are a careful evaluator scoring diagnostic agent outputs.
  Score per the 5-criterion rubric. Use the provided reference diagnosis
  as one valid answer shape — the candidate may differ; score the
  CRITERIA, not the resemblance."
- User: anomaly metadata + reference diagnosis + candidate diagnosis +
  tool-call transcript → ask for criterion scores + brief reasoning per
  criterion + total.

Few-shot anchors: include 2-3 example candidate diagnoses with their
correct scores (one passing, one failing on a specific criterion) to
calibrate the judge.

### Anti-bias measures

- Criterion-based scoring (not 1-5 unanchored)
- Few-shot anchors
- Spot-check: have you (the human) review 10-20 judge outputs to verify
  the judge is calibrated. Document the spot-check rate in `summary.md`.
- Position bias: NOT comparing two candidates side-by-side; one at a time.

### Outputs

```json
{
  "run_id": "2026-06-15T...",
  "K": 10,
  "judge_model": "claude-sonnet-4-7",
  "per_anomaly": {
    "sp-revenue-drop-w4": {
      "runs": [
        { "scores": { "hypothesis": 2, "evidence": 1, "sizing": 2,
                       "calibration": 1, "fabrication": 2 },
          "total": 8, "pass": true },
        ...
      ],
      "pass_rate": 0.8,
      "mean_score": 7.6
    },
    ...
  },
  "aggregate": {
    "pass_rate_mean": 0.73,
    "mean_score": 7.2
  },
  "spot_check": {
    "judge_outputs_reviewed_by_human": 15,
    "agreement_rate": 0.87,
    "notes": "Judge slightly under-scored 'no fabrication' on 2 cases..."
  }
}
```

### Honest scope

- LLM-as-judge has well-documented biases (length, confidence, position). Mitigations: criterion scoring + few-shot anchors + spot-check.
- The reference diagnosis is one of many valid answers; score against criteria, not resemblance.
- Spot-check IS the load-bearing step. Without human verification of the judge, the rubric pass-rate number is unreliable.

### Files

```
A  eval/fixtures/reference-diagnoses.json
A  eval/judges/diagnosis-judge.md
A  eval/scripts/lib/judge.ts            judge harness
A  eval/scripts/run-diagnosis.ts        entry point
M  package.json scripts                  eval:diagnosis
```

---

## PR F — Step 3: recommendation rubric (~0.5–1 day, lighter)

### What this scores

For each anomaly + diagnosis pair, run `RecommendationAgent.propose()`. Judge per recommendation against a lighter 3-criterion rubric.

### Reference recommendations (commit to `eval/fixtures/reference-recommendations.json`)

Per anomaly + diagnosis:

```json
{
  "sp-revenue-drop-w4": [
    "Investigate fulfillment SLA on SP-origin orders in week 4 — were
     deliveries delayed?",
    "Run a targeted promo on top-3 SP-affected categories to recover
     revenue in next 2 weeks",
    "A/B test: voucher campaign in SP to test whether voucher-dropoff
     is causing the revenue drop"
  ],
  ...
}
```

### Judge rubric

```
1. PLAUSIBLE ACTION
   Could a Brazilian e-commerce ops team actually do this? Is it within
   typical capabilities (no "rebuild the warehouse")?
   Score: 0–2

2. SPECIFIC
   Does it name the target (which SKU, which segment, which time window)?
   Not "improve marketing" but "discount electronics in SP by 10% for 2 weeks".
   Score: 0–2

3. IMPACT-SIZED
   Does it acknowledge magnitude — "recover ~X% of revenue", "test against
   N orders", etc.?
   Score: 0–1

Total: 0–5. Pass threshold: ≥4.
```

### Outputs

Same shape as Step 2's per_anomaly + aggregate structure.

### Honest scope

- Recommendation under Olist is intentionally tool-thin (per PR C's Honest scope decision #4). Recommendations are derived from the diagnosis text, not from `list_scenarios`/`list_segmentations`. Score against the 3-criterion rubric; don't penalize for "didn't run more tool calls" since the tools don't exist.
- Recommendations are subjective — calibrate the judge's threshold by spot-checking 10-15 outputs.

### Files

```
A  eval/fixtures/reference-recommendations.json
A  eval/judges/recommendation-judge.md
A  eval/scripts/run-recommendation.ts
M  package.json scripts                eval:recommendation
```

---

## PR G — Step 4: regression eval on the agent loop (~1 day)

### What this scores

Re-run a fixed input set against the agents whenever prompts/models change. Assert structural stability of the output JSON.

### Different from the existing 269 unit tests

The unit tests are mock-scripted — they inject canned Anthropic responses and assert the agent's wrapping logic. They don't catch regressions from prompt or model changes because the mock returns the same thing regardless.

The regression eval:
- Uses the REAL Anthropic API
- Uses a fixed input set (the 3 seeded anomalies + 2-3 manually-crafted "boring" cases)
- Stores the FIRST output as the golden
- On subsequent runs, scores the new output against the golden via structural diff + LLM-as-judge for "semantically close enough"

### Golden set

```
eval/fixtures/regression-golden/
  monitoring-empty.json         no anomalies (boring case)
  monitoring-3-anomalies.json    the 3 seeded
  diagnostic-sp.json              diagnose the SP drop
  diagnostic-electronics.json
  diagnostic-voucher.json
  recommendation-sp.json
  recommendation-electronics.json
  recommendation-voucher.json
  query-revenue-by-state.json     "what's revenue by state last 30 days"
  intent-classify-investigation.json   intent routing
```

10 fixtures. Each fixture is:

```json
{
  "input": { ... },                     // the agent input
  "golden_output": { ... },             // first-run captured output
  "captured_at": "2026-06-15T...",
  "captured_with": {
    "model": "claude-sonnet-4-7",
    "prompt_hash": "sha256:abc123..."
  }
}
```

### Scoring logic

For each fixture, on a re-run:
1. **Structural diff**: required fields present? types match? no new fields?
2. **Semantic similarity** (via LLM-as-judge): "does the new output convey the same conclusion as the golden, allowing minor wording shifts?"

Pass = both checks pass. Report per-fixture + aggregate.

### When this runs

Manual: `npm run eval:regression` before merging any prompt/model change. Not on every push (cost).

### Files

```
A  eval/fixtures/regression-golden/{10 files}
A  eval/scripts/run-regression.ts
M  package.json scripts                eval:regression
```

### Honest scope

- The first capture defines "the right output" — bias the golden by spot-checking 10/10 before locking it in.
- "Semantically close enough" is the hard part; without it, every minor prompt tweak triggers a regression. The judge here is doing similarity scoring, not quality scoring.

---

## Sequencing summary

```
PR D (Step 1):  eval scaffold + detection precision/recall
                ~1–2 days. First credible portfolio number:
                "Detection: precision X%, recall Y%"

PR E (Step 2):  diagnosis rubric + LLM-as-judge
                ~1–2 days. Second portfolio number:
                "Diagnosis rubric pass-rate: Z%"

PR F (Step 3):  recommendation rubric (rides on PR E's judge infra)
                ~0.5–1 day. Third portfolio number:
                "Recommendation rubric pass-rate: W%"

PR G (Step 4):  regression eval against golden set
                ~1 day. Operational story:
                "I gate prompt/model changes with a regression eval"
```

Each PR ends with a `summary.md` update in `eval/results/<date>/` that the recruiter narrative pulls from.

---

## Exit criterion

Per the source plan's Phase 3 exit:

> *"a runnable eval suite with reported numbers; you can state detection precision/recall and diagnosis rubric pass-rate from data you control."*

After PR G ships, the recruiter narrative becomes:

> *"Detection hits X% precision and Y% recall against 3 seeded anomalies in a Brazilian e-commerce dataset. Diagnoses pass a 5-criterion rubric at Z% (LLM-as-judge with human spot-check at agreement rate A%). Recommendations pass a 3-criterion rubric at W%. I gate prompt and model changes with a regression eval against 10 golden cases. The numbers come from data I control, generated by my own MCP server, scored by infrastructure I built."*

---

## Hard rules

```
✗ Don't change Phase 2's agents, prompts, or DataSource adapters.
  This phase MEASURES them.

✗ Don't change the AgentEvent contract or the existing 269 tests.

✗ Don't use the eval suite for development-loop feedback.
  Eval runs cost money and take minutes. Unit tests are still the
  fast iteration loop.

✗ Don't auto-merge prompt changes based on eval scores alone.
  Numbers inform; you decide.

✗ Don't skip the spot-check on the LLM-as-judge.
  An uncalibrated judge produces meaningless numbers.
```

---

## What this plan does NOT cover

- **The Phase 1 (Study) personal-time work.** Read the study guides until you can explain Phase 2's design decisions cold. Independent of code.
- **The next portfolio project** (the agentic RAG engine per the source plan's "After this — the RAG gap" sidebar). Separate planning artifact when Phase 3 ships.
- **Cost optimization of the eval suite.** First eval pass uses Sonnet across the board; if total $$ becomes painful, swap Haiku for Step 1's matching and screening passes.
