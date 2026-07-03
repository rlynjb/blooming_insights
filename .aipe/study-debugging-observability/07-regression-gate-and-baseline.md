# 07 — Regression gate + baseline

**Committed reference distribution + per-dimension delta gate** —
Industry standard.

## Zoom out — where this concept lives

The last layer of the observability pile: a committed `baseline.json`
records the per-dimension pass rates from a known-good eval run;
`gate.eval.ts` compares any candidate run against it and fails the CI
check if any dimension regresses by more than 10 percentage points.
Receipts on disk become a *numeric* verdict about "did the last change
regress the agent."

```
  Zoom out — regression gate in the pipeline

  ┌─ Developer's laptop ──────────────────────────────────────┐
  │  npm run eval  ─►  receipts/*.json                         │
  │  npm run eval:baseline  ─►  eval/baseline.json  (commit)   │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌─ CI (PR check) ────────▼──────────────────────────────────┐
  │  npm run eval  ─►  receipts/*.json                         │
  │  npm run eval:gate  ─►  gate-<runId>.json  ← we are here   │
  │       │                                                    │
  │       └─ non-zero exit on regression                       │
  │             → PR check fails                               │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — what it is.** Two files: `baseline.json` (committed,
per-dimension pass rates) and `gate.eval.ts` (per-run comparator).
The comparator reads receipts + baseline, computes per-dimension
delta, blocks on regression greater than 10pp.

## Structure pass

**Layers.** Receipts (per-case ground truth) · baseline builder
(receipts → per-dimension rates) · baseline file (committed) ·
candidate builder (same math, new run) · gate (delta + threshold) ·
CI (exit code + message).

**One axis held constant: guarantees.** What can each layer promise
its downstream?

```
  "what does each layer promise?"

  ┌───────────────────────────────────────┐
  │ receipts: per-case verdicts             │   → GROUND TRUTH
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ baseline: aggregated snapshot        │   → REFERENCE (stable, committed)
      └─────────────────────────────────────┘
          ┌────────────────────────────────┐
          │ candidate: same shape as baseline│  → COMPARABLE
          └────────────────────────────────┘
              ┌────────────────────────────┐
              │ gate: delta ≤ threshold     │  → BINARY VERDICT
              └────────────────────────────┘

  each layer narrows the promise: file → aggregate → comparable → verdict.
  the CI exit code is one bit; everything above it is calibrated to that bit.
```

**Seams.** Two important ones:

- **receipts ↔ baseline builder** — `computeBaseline(runId, receipts)`
  (from `eval/baseline.eval.ts`). The reducer that turns per-case
  verdicts into per-dimension pass rates. Same reducer runs against
  the baseline receipts (once, committed) and against the candidate
  receipts (every CI run).
- **baseline ↔ candidate** — both must have the same dimension list.
  If a dimension exists in the baseline but not the candidate, or
  vice versa, the gate defaults the missing side to 0
  (`gate.eval.ts:126-128`).

## How it works

### Move 1 — the mental model

You know how a `git diff` between two commits shows every changed
line? Same idea, but the "commits" are eval runs and the "changed
lines" are per-dimension pass rates. The baseline is one commit
frozen in time (`eval/baseline.json`); every PR is a candidate commit;
the gate is `git diff --numstat` with a size threshold that fails the
check.

```
  The gate — one number per dimension, compared

     baseline (committed reference)     candidate (this PR's run)

     diagnosis:                         diagnosis:
       root_cause_plausibility  0.75      root_cause_plausibility  0.60
       evidence_grounding       0.50      evidence_grounding       0.65
       scope_coherence          0.75      scope_coherence          0.75
       actionable_next_step     0.00      actionable_next_step     0.10

     recommendation:                    recommendation:
       diagnosis_response       0.48      diagnosis_response       0.52
       feature_choice_fit       0.62      feature_choice_fit       0.60
       step_actionability       1.00      step_actionability       1.00
       impact_realism           0.43      impact_realism           0.30

                                                     ▲
                                                     │
                                    delta:  Δ = candidate − baseline
                                            regressed if Δ < −0.10

     ────── VERDICT ──────
     root_cause_plausibility:  Δ -15pp ← BLOCKS  (regressed)
     impact_realism:           Δ -13pp ← BLOCKS  (regressed)
     others: within threshold
```

### Move 2 — the mechanism, step by step

**Part A — the receipt-reducer (`computeBaseline`).** Same code
computes both baseline and candidate. Reads per-case receipts,
aggregates per-dimension pass rates (score >= 4 = pass), per-dimension
score distributions, per-verdict counts.

Real code from `eval/gate.eval.ts:34-47` (the receipt shape as the
gate sees it):

```ts
type Receipt = {
  case: string;
  signalClass: string;
  diagnosisJudgment: {
    verdict: string;
    dimensions: Record<string, { score: number }>;
  };
  recommendationJudgments: Array<{
    judgment: {
      verdict: string;
      dimensions: Record<string, { score: number }>;
    };
  }>;
};
```

Minimal shape. The gate doesn't care about tool calls, or usage, or
budget snapshots — it only cares about the judgment. That narrow read
is important: **the gate's contract is small, so the receipt shape
can evolve without breaking it.**

**Part B — the committed baseline.** One file, committed, shared
across the team. The build step is `npm run eval:baseline` (calls
`baseline.eval.ts`), which runs the same reducer against the latest
receipts and writes `eval/baseline.json`.

The shape (from `eval/baseline.json`):

```json
{
  "runId": "2026-07-03T04-08-28-644Z",
  "builtAt": "2026-07-03T05:29:44.727Z",
  "caseCount": 10,
  "diagnosis": {
    "perDimensionPassRate": {
      "root_cause_plausibility": 0.75,
      "evidence_grounding": 0.5,
      "scope_coherence": 0.75,
      "actionable_next_step": 0
    },
    "perDimensionScoreCounts": { /* full 1..5 histogram per dim */ },
    "verdictDistribution": {
      "pass_with_notes": 3,
      "judge_error": 6,
      "fail": 1
    }
  },
  "recommendation": {
    "perDimensionPassRate": {
      "diagnosis_response": 0.476,
      "feature_choice_fit": 0.619,
      "step_actionability": 1.0,
      "impact_realism": 0.429
    },
    ...
  }
}
```

Two things stand out:

- The `runId` embedded in the baseline is provenance — someone can
  trace exactly which receipts built it.
- The `caseCount: 10` is a safety check. If a candidate run has a
  different case count (someone added or removed a golden), the
  numbers stop being comparable at face value.

**Part C — the gate itself.** Compute candidate baseline from
receipts; diff per-dimension; block if any dimension's drop exceeds
threshold.

Real code from `eval/gate.eval.ts:112-148`:

```ts
function evaluateGate(
  baseline: Baseline,
  candidate: Baseline,
  maxRegression: number,
): GateResult {
  const deltas: Delta[] = [];
  for (const scope of ['diagnosis', 'recommendation'] as const) {
    const b = baseline[scope];
    const c = candidate[scope];
    const dims = new Set([
      ...Object.keys(b.perDimensionPassRate),
      ...Object.keys(c.perDimensionPassRate),
    ]);
    for (const dim of dims) {
      const bRate = b.perDimensionPassRate[dim] ?? 0;
      const cRate = c.perDimensionPassRate[dim] ?? 0;
      const delta = cRate - bRate; // negative = regression
      deltas.push({
        dimension: dim,
        scope,
        baselinePassRate: bRate,
        candidatePassRate: cRate,
        delta,
        regressed: -delta > maxRegression,
      });
    }
  }
  const blockingDimensions = deltas.filter((d) => d.regressed);
  return {
    ok: blockingDimensions.length === 0,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    gateMaxRegression: maxRegression,
    deltas,
    blockingDimensions,
  };
}
```

Two things worth naming:

- **`regressed: -delta > maxRegression`** — the threshold is one-sided.
  Positive deltas (candidate better than baseline) are always
  welcome; only drops beyond the threshold block. This is what makes
  the gate a *regression* check, not a full-equality check.
- **The dim set is the union.** New dimensions in the candidate get
  the baseline default `0`; missing dimensions in the candidate get
  the baseline as the reference. In practice this is defensive — the
  goldens don't change per PR — but it's the right default when they
  do.

**Part D — the writable output.** Every gate run writes its own
`gate-<runId>.json` next to the baseline. This is the audit trail —
if a PR was blocked, the exact numbers that blocked it live on disk.

Real code from `eval/gate.eval.ts:76-88`:

```ts
const outPath = resolve(
  EVAL_DIR,
  `gate-${candidateRunId}.json`,
);
writeFileSync(outPath, JSON.stringify(gateResult, null, 2) + '\n', 'utf8');

printSummary(gateResult, baseline, candidate);

if (!gateResult.ok) {
  throw new Error(
    `Regression gate FAILED. ${gateResult.blockingDimensions.length} dimension(s) regressed by more than ${GATE_MAX_REGRESSION}. See ${outPath}.`,
  );
}

expect(gateResult.ok).toBe(true);
```

`throw` here becomes vitest's test-fail, which becomes a non-zero
exit code, which fails the CI check. The message names the exact
gate file so the PR author can grep it.

**Part E — the console summary.** Human-readable table printed to
stderr during the run.

Real code from `eval/gate.eval.ts:150-174`:

```ts
function printSummary(gate: GateResult, baseline: Baseline, candidate: Baseline): void {
  console.error(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
  console.error(`║ Phase-5 regression gate                                                     ║`);
  console.error(`╚══════════════════════════════════════════════════════════════════════════════╝`);
  console.error(`\n  Baseline runId:    ${gate.baselineRunId} (${baseline.caseCount} cases)`);
  console.error(`  Candidate runId:   ${gate.candidateRunId} (${candidate.caseCount} cases)`);
  console.error(`  Max allowed drop:  ${gate.gateMaxRegression} (${Math.round(gate.gateMaxRegression * 100)} pp)`);
  console.error(`\n  Per-dimension pass-rate delta (candidate − baseline)`);
  console.error('─'.repeat(78));
  for (const scope of ['diagnosis', 'recommendation'] as const) {
    console.error(`  [${scope}]`);
    for (const d of gate.deltas.filter((x) => x.scope === scope)) {
      const bp = (d.baselinePassRate * 100).toFixed(0);
      const cp = (d.candidatePassRate * 100).toFixed(0);
      const dp = (d.delta * 100).toFixed(0);
      const sign = d.delta >= 0 ? '+' : '';
      const flag = d.regressed ? ' ✗ REGRESSED' : '';
      console.error(
        `    ${d.dimension.padEnd(30)}  base ${bp.padStart(3)}% → cand ${cp.padStart(3)}%   Δ ${sign}${dp}pp${flag}`,
      );
    }
  }
  console.error('');
  console.error(gate.ok ? '  ✓ GATE PASSED' : `  ✗ GATE FAILED — ${gate.blockingDimensions.length} regressed dimension(s)`);
  console.error('');
}
```

CI logs get the same table the local dev gets — same debugging
surface across environments.

### Move 2 variant — the load-bearing skeleton

The kernel:

```
  committed reference (baseline.json)
  + same reducer producing baseline + candidate (shape parity)
  + per-dimension delta (baseline − candidate)
  + one-sided regression threshold (drops only)
  + hard-fail on breach (non-zero exit)
```

- **Drop the committed reference** and the gate is comparing against
  nothing — every run is a first run, no regressions possible.
- **Drop shape parity in the reducer** and the baseline and candidate
  aren't comparable at face value. If baseline has 4 dimensions and
  candidate has 5, which set is the ground truth?
- **Drop the one-sided threshold** and every random-fluctuation
  improvement blocks the gate. False positives kill trust; the gate
  gets ignored.
- **Drop the hard-fail** and the gate is just a report — no actual
  blocking. PRs merge with regressions silently.

Skeleton vs hardening:

- **Skeleton:** committed baseline + delta + threshold + hard-fail.
- **Hardening:** the union-of-dimensions default (schema drift
  safety); the per-run `gate-<runId>.json` audit trail; the
  environment-controlled threshold (`GATE_MAX_REGRESSION`); the
  console summary that shows every delta (not just the blocking
  ones) so a PR author can see momentum.

### Move 3 — the principle

**Turn a distribution into a decision.** Receipts on their own are
data; a baseline is a reference; the gate is the *decision* — one
binary answer to "should this land?" The whole reason receipts exist
is to feed this decision cheaply and repeatably.

The move that makes this cheap: **shape parity between baseline and
candidate.** Same reducer, same output shape, deltas are trivial.
When the shape drifts, the comparison stops being one line of code
and becomes a schema migration problem.

## Primary diagram

```
  Regression gate + baseline — full picture

  ┌─ Once, at baseline commit time ────────────────────────────────┐
  │                                                                 │
  │  npm run eval                                                   │
  │    → eval/receipts/*.json   (per-case receipts, 10 cases)      │
  │                                                                 │
  │  npm run eval:baseline                                          │
  │    → reads receipts                                             │
  │    → computeBaseline(runId, receipts)                          │
  │    → writes eval/baseline.json  ← COMMITTED                    │
  │                                                                 │
  │  Baseline shape:                                                │
  │    { runId, builtAt, caseCount,                                 │
  │      diagnosis: {                                               │
  │        perDimensionPassRate: { dim: 0..1 },                     │
  │        perDimensionScoreCounts: { dim: { 1:n, 2:n, ..., 5:n } },│
  │        verdictDistribution: { pass, pass_with_notes, ... }      │
  │      },                                                         │
  │      recommendation: { ...same shape... } }                     │
  │                                                                 │
  └───────────────────────────────┬────────────────────────────────┘
                                  │
                                  │  git commit eval/baseline.json
                                  ▼
  ┌─ Every PR ─────────────────────────────────────────────────────┐
  │                                                                 │
  │  1. RUN                                                         │
  │     npm run eval  → eval/receipts/*.json (candidate)           │
  │                                                                 │
  │  2. GATE                                                        │
  │     npm run eval:gate                                           │
  │       ─ reads eval/baseline.json                                │
  │       ─ pickRunId(env or latest) → candidate receipts           │
  │       ─ candidate = computeBaseline(candidateRunId, receipts)  │
  │       ─ evaluateGate(baseline, candidate, GATE_MAX_REGRESSION) │
  │                                                                 │
  │  3. COMPUTE DELTAS                                              │
  │     for each scope in [diagnosis, recommendation]:              │
  │       for each dim in union(baseline.dims, candidate.dims):    │
  │         delta = candidate.rate - baseline.rate                  │
  │         regressed = -delta > GATE_MAX_REGRESSION (default 0.10)│
  │                                                                 │
  │  4. WRITE AUDIT + REPORT                                        │
  │     writeFileSync(eval/gate-<candidateRunId>.json)             │
  │     printSummary(gate, baseline, candidate) → stderr            │
  │                                                                 │
  │  5. VERDICT                                                     │
  │     if any dim.regressed → throw → CI check fails               │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘

  ── Concrete: today's baseline (runId 2026-07-03T04-08-28-644Z) ──
    diagnosis dims:      4 (root_cause_plausibility, evidence_grounding,
                            scope_coherence, actionable_next_step)
    recommendation dims: 4 (diagnosis_response, feature_choice_fit,
                            step_actionability, impact_realism)
    threshold:           0.10 (10 percentage points)
    total dims gated:    8
```

## Elaborate

The regression-gate pattern shows up in every mature CI pipeline:

- **Snapshot testing** (Jest, Vitest snapshots) — same shape at unit
  scale. The snapshot is the baseline; a diff blocks.
- **Coverage gates** — same shape at coverage percentage: baseline
  coverage percent, threshold on drop.
- **Perf regression bots** (Speedometer, Chromium's perf infra) —
  same shape at latency percentiles.
- **Model eval frameworks** (OpenAI evals, Anthropic evals) — same
  shape at judge scores.

The Blooming-specific choice is *aggregate-level regression, not
per-case*. A single case flipping pass → fail doesn't block; only
the aggregate pass rate per dimension does. This is intentional:
LLM output is noisy, so a single-case flip is likely noise. The
10pp threshold is calibrated to be tight enough to catch a real
degradation but loose enough that a single case flipping doesn't
trigger.

The failure mode this defends against is real and named: a
diagnostic-agent prompt tweak in Session B might improve one
dimension while quietly regressing another. Without the gate, the
per-dimension regression is invisible until someone runs the eval and
notices numbers moved.

The judge_error verdict in the baseline (`verdictDistribution.judge_error: 6`
for diagnosis) is honest: 6 of 10 cases had judge failures during the
baseline run. Those don't count against the pass rate but they do
show up in the verdict distribution. The gate today gates on
per-dimension pass rate; a future extension could also gate on
judge_error rate (spec is TODO).

Adjacent concepts:

- **A/B test analysis** — same math, different context (two prompts
  running in parallel instead of before/after).
- **Statistical process control** (SPC) — the whole discipline of
  "when has a metric moved beyond noise." The 10pp threshold is a
  crude version; a real SPC chart would use control limits derived
  from variance.
- The AptKit `RubricJudge` — the primitive that produces the
  per-dimension scores in the first place.

## Interview defense

**Q: Why per-dimension pass rate and not overall accuracy?**

Because a single "accuracy" number hides which dimension moved. If
overall pass rate is unchanged but `evidence_grounding` dropped from
0.5 to 0.3 while `scope_coherence` rose to compensate, the agent
is *worse* at citing evidence and the overall number lied about it.
Per-dimension exposes the tradeoff.

Anchor: `eval/baseline.json` shows 4 dimensions per scope; the gate
computes 8 deltas per PR.

**Q: Why 10 percentage points as the threshold?**

Because the eval is 10 cases and the judge is stochastic — a single
case flipping is 10pp of variance on a per-dimension pass rate.
Setting the threshold *at* one case's worth of variance means "one
case flipping is noise; two or more flipping is signal." Under an
environment override (`GATE_MAX_REGRESSION=0.05`) the gate can be
tightened for high-stakes PRs.

**Q: What if the goldens change between baseline and candidate?**

Then `caseCount` shifts and the numbers stop being directly
comparable. The gate today would still run — union of dims, missing
sides default to 0 — but the interpretation is muddy. The right move
is to rebuild the baseline any time the golden set changes; that's a
deliberate "yes I'm resetting the reference" step.

**Q: What's the load-bearing part?**

Shape parity between baseline and candidate. `computeBaseline` runs
once to build the baseline (committed) and again to build the
candidate. Same reducer, same output shape, one-line diff. If shape
parity broke, every gate run would need a schema migration.

Anchor: `eval/gate.eval.ts:69-72` — `const candidate = computeBaseline(candidateRunId, receipts)` uses the same function as the baseline builder.

## See also

- `02-receipts-as-evidence.md` — the receipts that populate both
  baseline and candidate.
- `study-testing` — the goldens themselves + the judge rubrics that
  produce the per-dimension scores.
- The `eval/baseline.eval.ts` script — the exact reducer that lands
  the baseline shape on disk.
