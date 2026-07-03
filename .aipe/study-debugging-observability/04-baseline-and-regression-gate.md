# 04 · Baseline and regression gate

*Committed reference + regression check — **industry standard***

## Zoom out — where this concept lives

`eval/baseline.json` is a committed file. It's the "known-good" run's
per-dimension pass rates and verdict distributions. `eval/gate.eval.ts`
is a vitest test that reads it, computes the same summary over a
candidate run's receipts, and blocks (test fails) if any dimension has
regressed by more than a threshold.

```
  Zoom out — the gate's seat in the loop

  ┌─ receipts on disk ──────────────────────────────────────┐
  │  eval/receipts/<case>-<runId>.json   (Nx per run)        │
  └────────────────┬────────────────────────────────────────┘
                   │
                   ▼
  ┌─ baseline.eval.ts ──────────────────────────────────────┐
  │  computeBaseline(receipts) → per-dim pass rates + dist   │
  └────────────────┬────────────────────────────────────────┘
                   │
                   ▼
     ┌────────── committed ──────────┐
     │   eval/baseline.json         │
     └────────────────┬─────────────┘
                      │
                      ▼
  ┌─ ★ gate.eval.ts ★ ──────────────────────────────────────┐
  │  candidate baseline vs committed baseline                │
  │  fail if any dim regressed > GATE_MAX_REGRESSION (0.10)  │
  │  emits eval/gate-<runId>.json (gitignored receipt)       │
  └──────────────────────────────────────────────────────────┘
                   │
                   ▼
              CI: vitest exit code
              non-zero → PR blocked
```

Zoom in — this is the layer that turns "the agents are worse today"
into a **test failure on a specific dimension.** No dashboard, no
paging, just `expect(candidate.recommendation.perDimensionPassRate
.impact_realism).toBeGreaterThanOrEqual(baseline - 0.10)`. When the
gate trips, the fail message names the exact dimension that dropped.

## Structure pass — the skeleton

**Axis held constant: what does each layer commit to?**

| Layer | Commits |
|---|---|
| Receipt | per-case verdict + per-dimension score |
| Baseline computation | pure function over receipts |
| Committed baseline | frozen reference numbers |
| Gate | delta between baselines |
| CI | exit code |

Every layer is a **pure function of the layer above**, which means
the gate is auditable: give me the baseline JSON and the candidate
receipts, and I can rerun the gate offline and get the same answer.

**Seams:**

  → seam 1 — **`computeBaseline` as a reusable pure function.** Same
    function computes the committed baseline AND the candidate
    baseline (`gate.eval.ts:70`). This is the "no drift" guarantee:
    if the computation changes, both sides change together.
  → seam 2 — **the threshold as env var.** `GATE_MAX_REGRESSION`
    (`gate.eval.ts:31`) lets you tighten the gate for a specific
    run without editing code — useful when tightening quality bar
    late in a milestone.
  → seam 3 — **the gate receipt.** `eval/gate-<runId>.json` is
    itself gitignored but persists locally; it records exactly which
    dimensions were checked, what deltas were observed, and whether
    the gate passed. Traces of your own quality decisions.

## How it works

### Move 1 — the mental model

You know linting: run `eslint`, if it finds a new error, exit non-
zero, block the PR. This is the LLM-eval version: run `npm run eval`,
if any per-dimension pass rate dropped by more than 10 percentage
points vs the committed baseline, exit non-zero, block the PR.

```
  The pattern — pass rate as a gated CI signal

  ─── committed baseline (frozen) ───
    root_cause_plausibility:       0.75
    evidence_grounding:            0.50
    scope_coherence:               0.75
    actionable_next_step:          0.00
    (recommendation dims...)

  ─── candidate (this PR's run) ────
    root_cause_plausibility:       0.70   Δ  -0.05  ok (< 0.10)
    evidence_grounding:            0.35   Δ  -0.15  FAIL
    scope_coherence:               0.75   Δ   0.00  ok
    actionable_next_step:          0.25   Δ  +0.25  improved
    ...

  gate says: candidate regressed on evidence_grounding
             (0.50 → 0.35, delta -0.15 > threshold 0.10)
  → exit non-zero → PR check red
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the committed baseline shape.**

From `eval/baseline.json` (the current committed reference,
runId `2026-07-03T04-08-28-644Z`):

```json
{
  "runId": "2026-07-03T04-08-28-644Z",
  "builtAt": "2026-07-03T05:29:44.727Z",
  "caseCount": 10,
  "diagnosis": {
    "perDimensionPassRate": {
      "root_cause_plausibility": 0.75,
      "evidence_grounding":      0.50,
      "scope_coherence":         0.75,
      "actionable_next_step":    0.00
    },
    "perDimensionScoreCounts": {
      "root_cause_plausibility": {"1":0,"2":1,"3":0,"4":3,"5":0},
      ...
    },
    "verdictDistribution": {
      "pass_with_notes": 3, "judge_error": 6, "fail": 1
    }
  },
  "recommendation": { ... same shape ... }
}
```

The **numbers here are the current signal, not aspirations.** Read
them as the honest baseline: 6 judge_errors out of 10 diagnosis
judgments (60%) — that's a real observability finding, not a bug in
the gate. It says the judge model can't reliably score diagnoses at
Sonnet 4.6 today, and any regression from here has to be measured
against that reality.

**Part 2 — `computeBaseline` as a pure function.**

The same function computes both sides of the compare
(`gate.eval.ts:70`):

```typescript
const candidate = computeBaseline(candidateRunId, receipts);
```

Because it's a pure function of receipts, the entire gate is
reproducible from the two inputs (baseline JSON + candidate
receipts). No hidden state, no time-dependent branches.

**Part 3 — the gate logic.**

From the file structure:

```typescript
// eval/gate.eval.ts:31
const GATE_MAX_REGRESSION = Number(process.env.GATE_MAX_REGRESSION ?? '0.10');

// ...

const gateResult = evaluateGate(baseline, candidate, GATE_MAX_REGRESSION);

const outPath = resolve(EVAL_DIR, `gate-${candidateRunId}.json`);
writeFileSync(outPath, JSON.stringify(gateResult, null, 2) + '\n', 'utf8');
```

**Part 4 — what breaks if each piece is missing.**

  → **Baseline not committed** — no anchor point; the gate can't run
    at all (it throws with the "Missing baseline at ..." error).
  → **`computeBaseline` reused instead of duplicated** — this is the
    load-bearing DRY. If the summary function drifted between the
    baseline builder and the gate checker, you'd get false
    positives/negatives forever. Same function, same answer.
  → **Threshold as env var, not hardcoded** — makes late-milestone
    tightening (`GATE_MAX_REGRESSION=0.05`) a config change, not a
    code change.
  → **`verdictDistribution` in the baseline** — not gated on today,
    but stored so a future gate rule ("no more than 20% judge_error")
    can be added by reading existing baselines without a new
    computation pass.
  → **Gate receipt written** — makes the gate's decision itself
    auditable. Someone asking "why did this PR pass" can read the
    gate JSON, see exactly which deltas were checked and what
    threshold was in force.

**Part 5 — how it hooks into the normal loop.**

The gate is gated on `RUN_GATE=1` (`gate.eval.ts:29`) — like most of
the eval targets, it uses `describe.skipIf` so `npm test` never
accidentally runs it. Explicit invocation is `npm run eval:gate`.

CI wiring (from the gate.eval.ts header comment):

```
npm run eval && npm run eval:gate
```

The first command produces the candidate receipts; the second
compares. Both are vitest invocations, so both feed CI's normal
"tests passed/failed" signal.

### Move 2 — Layers-and-hops: a PR blocked by the gate

```
  A regression lands, gate catches it

  ┌─ developer ────────────┐
  │  edits prompt in       │
  │  lib/agents/prompts/   │
  │  diagnostic.md         │
  └───────────┬────────────┘
              │  push branch, open PR
              ▼
  ┌─ CI runner ────────────┐
  │  npm run eval          │  ← runs the 10 goldens
  │    │                    │    writes eval/receipts/
  │    │                    │    <case>-<runId>.json ×10
  │    │                    │
  │    ▼                    │
  │  npm run eval:gate      │
  │    │                    │
  │    ├──► read eval/baseline.json  (committed reference)
  │    │                    │
  │    ├──► scan eval/receipts/*-<candidateRunId>.json
  │    │                    │
  │    ├──► candidate = computeBaseline(receipts)
  │    │                    │
  │    ├──► for each dim in ['root_cause_plausibility', ...]:
  │    │       delta = baseline.rate - candidate.rate
  │    │       if delta > GATE_MAX_REGRESSION (0.10):
  │    │           record regression
  │    │                    │
  │    ├──► writeFileSync(eval/gate-<runId>.json,
  │    │                  {baseline, candidate, threshold,
  │    │                   regressions[], verdict})
  │    │                    │
  │    └──► expect(regressions).toEqual([])
  │                         │
  └─────────────┬───────────┘
                │  exit non-zero
                ▼
  ┌─ GitHub ───────────────┐
  │  PR check: RED         │
  │  "gate failed: evidence_grounding dropped 0.50 → 0.35"  │
  └────────────────────────┘
```

### Move 3 — the principle

**Commit a reference and diff against it.** Every debugging problem
in a probabilistic system reduces to "how do I know if this got
worse." Without a committed reference, "worse" is a vibe. With one,
it's a delta. The committed reference plus a pure function that
computes the same summary on both sides plus a threshold plus a CI
gate is the entire mechanism. Once you have this shape, adding new
dimensions (a "confabulation rate" score, a "hallucinated tool call"
detector) is a one-file edit to the summary; the gate architecture
doesn't move.

## Primary diagram

```
  Baseline + regression gate — the whole loop

  ┌────────────────────────────────────────────────────────────────┐
  │ SNAPSHOTTING (rare — done deliberately, committed)             │
  │                                                                │
  │   npm run eval                → receipts/*-<runId>.json         │
  │        │                                                        │
  │        ▼                                                        │
  │   npm run eval:baseline       → eval/baseline.json              │
  │        (via baseline.eval.ts's computeBaseline)                 │
  │        │                                                        │
  │        ▼                                                        │
  │   git commit eval/baseline.json                                │
  │        (the reference for every future gate check)             │
  └────────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────────┐
  │ GATED (every PR / release)                                     │
  │                                                                │
  │   npm run eval                → receipts/*-<candidateRunId>.json│
  │        │                                                        │
  │        ▼                                                        │
  │   npm run eval:gate                                            │
  │     ┌────────────────────────────────────────────────┐         │
  │     │ read eval/baseline.json                        │         │
  │     │ read receipts/*-<candidateRunId>.json          │         │
  │     │                                                │         │
  │     │ candidate = computeBaseline(candidateReceipts) │         │
  │     │                                                │         │
  │     │ for each dim:                                  │         │
  │     │   delta = baseline.rate - candidate.rate       │         │
  │     │   if delta > GATE_MAX_REGRESSION:              │         │
  │     │     regressions.push({dim, before, after})     │         │
  │     │                                                │         │
  │     │ writeFileSync(eval/gate-<runId>.json)          │         │
  │     │ expect(regressions).toEqual([])                │         │
  │     └────────────────────────────────────────────────┘         │
  │        │                                                        │
  │        ▼                                                        │
  │   test passes → PR unblocks    test fails → PR blocked         │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** Regression gates are as old as
`snapshot testing` in Jest — a committed reference file plus a diff
check on every run. What's specific to LLM eval is (1) the reference
is a distribution over dimensions, not a single value, and (2) the
threshold has to allow for run-to-run variance without being so lax
it hides real regressions. GATE_MAX_REGRESSION at 10 percentage
points is a **calibration knob** — it will need to move down as the
substrate gets more stable.

**Cousins that solve the same problem differently.**

  → **LangSmith / Braintrust "compare runs"** — richer UI, but
    requires a hosted service and credentials. Same shape at heart.
  → **Weights & Biases sweeps + guardrails** — heavier, aimed at
    training runs, overkill for a rubric-based eval.
  → **A rolling window baseline** — smooth out variance by
    baselining against the last N runs' median. Not implemented
    here; would be a straightforward extension to
    `baseline.eval.ts`.

**Adjacent to `03-capability-trace-receipts.md`.** Receipts are the
raw material; the baseline is the compressed summary; the gate is
the policy. The receipt shape doesn't need to change to add a new
gate dimension — you only extend the summary function. That's
independent axes of evolution.

## Interview defense

**Q1 · "How do you know if a prompt change made the agent worse?"**

**Model answer.** Every eval run produces per-case receipts with
per-dimension judge scores. `eval/baseline.eval.ts` computes a
summary (per-dimension pass rates + verdict distribution) and
commits it as `eval/baseline.json`. Every PR runs the same eval,
computes the same summary over the new receipts, and
`eval/gate.eval.ts` diffs them. If any dimension regressed by more
than GATE_MAX_REGRESSION (default 10 percentage points), the test
fails and the PR check goes red. The check names the exact
dimension. Anchor: `eval/gate.eval.ts:47-93`.

**Q2 · "Why 10 percentage points as the threshold?"**

**Model answer.** Because the substrate has real run-to-run variance
— Sonnet 4.6 is non-deterministic, the judge is a language model
that sometimes fails to produce parseable output (6/40 judge_error
in the committed baseline), and the golden set is only 10 cases so
one case flipping is 10 percentage points on its own. Below 10, the
gate would fire on noise. Above 10, it would hide real regressions.
The threshold is an env var so I can tighten it (`GATE_MAX_REGRESSION
=0.05`) when I'm confident the substrate is more stable — end of
milestone hardening, for instance.

**Q3 · "What's the load-bearing part of a regression gate people
forget?"**

**Model answer.** The `computeBaseline` function has to be REUSED
across both sides of the compare, not duplicated. `eval/gate.eval.ts:
70` calls `computeBaseline(candidateRunId, receipts)` — the same
function the baseline itself was built from. If the two computations
drifted, the gate would either false-positive (regression detected
when the underlying quality is identical) or false-negative
(regression hidden by different math). The DRY here isn't
stylistic — it's what makes the gate meaningful.

## See also

- `03-capability-trace-receipts.md` — the raw material this gate
  runs on
- `05-fault-injecting-load-harness.md` — a different question over
  the same substrate ("how does it behave under fault load")
