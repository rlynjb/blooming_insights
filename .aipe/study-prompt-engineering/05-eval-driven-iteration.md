# 05 · Eval-driven prompt iteration

**Industry name:** *eval-driven prompt iteration* / *LLM-as-judge* / *rubric-driven judgment* · Industry standard

## Zoom out — where the eval sits in the pipeline

The eval harness is a sidecar. It runs the exact same agents the production route runs, against the same synthetic data source, and grades the outputs with a rubric judge.

```
  Zoom out — the eval harness as a sidecar

  ┌─ Production path ─────────────────────────────────────────┐
  │  briefing route → MonitoringAgent → DiagnosticAgent →      │
  │                   RecommendationAgent → NDJSON stream to UI │
  └────────────────────────────────────────────────────────────┘

  ┌─ Eval sidecar (npm run eval) ─────────────────────────────┐
  │  eval/run.eval.ts                                          │
  │    for each of 10 goldens:                                 │
  │      diagnose(golden.anomaly) → diagnosis                  │
  │      RubricJudge(diagnosisQualityRubric).judge(diagnosis)  │
  │      recommend(golden.anomaly, diagnosis) → recs           │
  │      for each rec: RubricJudge(recQualityRubric).judge(rec)│
  │      write receipt to eval/receipts/<case>-<runId>.json    │
  │                                                            │
  │  ★ THIS BLOCK — the whole discipline ★                    │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — three artifacts, one discipline

The eval discipline in this codebase is three artifacts:

1. **The golden set** — `eval/goldens/*` — 10 hand-curated cases spanning `has-signal`, `partial-signal`, `no-signal`, and `positive` classes.
2. **The rubrics** — `eval/rubrics/{diagnosis,recommendation}-quality.ts` — 4 dimensions × 1-5 scale × 3 verdicts each.
3. **The receipts** — `eval/receipts/<caseId>-<runId>.json` — one file per case per run, capturing every input, every output, every judgment, every tool call.

The receipt is the artifact that lets you compare runs. Same case, different run = you can diff the judgments and see whether your prompt change made it better, worse, or noisy.

## Structure pass — layers, axis, seams

Trace one axis: *who is producing what*, from the top of the eval to the receipt on disk.

- **Layer 1 — the golden case** (`GoldenCase`). Human-authored. Fixed. Names the anomaly + intent + `knownCorrect` shape + signal class.
- **Layer 2 — the agent under test.** Same code as production. Produces diagnosis + recommendations.
- **Layer 3 — the rubric definition.** A `RubricDefinition` (from `@aptkit/core`) — dimensions, verdicts, checks. Domain-specific data.
- **Layer 4 — the judge.** `RubricJudge` — a general-purpose LLM-as-judge engine. Takes rubric + subject + context, returns structured judgment.
- **Layer 5 — the receipt.** JSON file. Every input, output, and judgment for one case in one run.

**The seam:** between rubric definition (domain data, lives in this repo) and rubric engine (`RubricJudge`, lives in `@aptkit/core`). Same shape as the seam in concept 03 — the reusable engine is packaged, the domain-specific content stays here.

## How it works

### Move 1 — the shape

You've written tests before. Same pattern here, one layer up. A test has:

- **Input** — the fixture / arrange step.
- **Assertion** — what the output has to be.
- **Recorded outcome** — pass or fail.

Eval-driven iteration is that pattern applied to LLM outputs where the assertion is fuzzy. Instead of `expect(x).toEqual(y)`, the assertion is a *rubric* — a 4-dimension × 5-point scoring rubric evaluated by a second LLM. Instead of pass / fail, the outcome is `pass` / `pass_with_notes` / `fail` plus a per-dimension score plus a `fix` string.

```
  Pattern — LLM eval as testing, one layer up

  fixture               subject under test      grading
  ┌─────────────┐       ┌──────────────────┐   ┌──────────────┐
  │ golden case │ ────► │ DiagnosticAgent  │ ─►│ RubricJudge   │
  │  · anomaly  │       │  runs same code  │   │  scores 4 dims │
  │  · intent   │       │  as production   │   │  emits verdict │
  │  · known-   │       └──────────────────┘   └──────┬───────┘
  │    correct  │                                     │
  │  · signal-  │                                     ▼
  │    class    │                              ┌──────────────┐
  └─────────────┘                              │ receipt.json │
                                               └──────────────┘
```

The gold isn't in the `pass` / `fail` bit. It's in the receipt. When you change a prompt and re-run, you compare receipts. The dimension scores and the `fix` fields tell you *what* changed.

### Move 2 — walking the mechanism

#### The golden set — one case per intent shape

`eval/goldens/*` (browsed via receipts):

- `01-conversion-drop-mobile-checkout` — `has-signal`. Canonical happy path. Substrate has co-occurring payment_failure signal; agent should name payment processor as the primary mechanism.
- `04-cart-abandonment-mobile-broad` — `has-signal`. Multi-cause anomaly with red-herring risk (SP over-weighting).
- `05-no-signal-retention-subscribers` — `no-signal`. Substrate lacks subscription data. Correct answer: acknowledge the gap. Failure mode: confabulate subscriber counts.
- `07-positive-conversion-surge-mobile` — `positive`. Correct answer: recognize and characterize.
- `10-no-signal-seo-organic` — `no-signal`. SEO / SERP-shaped question that Bloomreach doesn't answer at all.

Each `GoldenCase` at `eval/goldens/types.ts` carries:

- `anomaly` — the input.
- `intent` — a paragraph of "what a correct diagnosis looks like for this case."
- `knownCorrect` — a JSON structure of "correct shape" notes — the specific traps, the specific numbers.
- `signalClass` — the meta-label that determines whether this case is *gated* (assertion enforced) or *measured* (recorded, not enforced).

At `eval/run.eval.ts:413-424`:

```
const isGated =
  goldenCase.signalClass === 'has-signal' ||
  goldenCase.signalClass === 'partial-signal';
if (isGated) {
  expect(receipt.diagnosisJudgment.verdict).not.toBe('fail');
  for (const rj of receipt.recommendationJudgments) {
    expect(rj.judgment.verdict).not.toBe('fail');
  }
}
```

`has-signal` and `partial-signal` cases must not fail — a fail is a regression. `no-signal` and `positive` cases are measured — their outcomes are recorded but not gated, because "the agent confabulated" or "the agent handled a positive correctly" are data points, not correctness invariants.

#### The rubric — 4 dimensions × 1-5 scale × 3 verdicts

`eval/rubrics/diagnosis-quality.ts:15-108` defines the diagnosis rubric. Structure:

```
export const diagnosisQualityRubric: RubricDefinition = {
  id: 'blooming-diagnosis-quality-v1',
  title: 'Diagnosis quality',
  task: `Judge a diagnosis produced by an AI analyst investigating an ecommerce anomaly. …`,
  dimensions: [
    { id: 'root_cause_plausibility', label: '…', description: '…', scale: [1..5 with descriptions] },
    { id: 'evidence_grounding',      label: '…', description: '…', scale: [1..5] },
    { id: 'scope_coherence',         label: '…', description: '…', scale: [1..5] },
    { id: 'actionable_next_step',    label: '…', description: '…', scale: [1..5] },
  ],
  verdicts: [
    { verdict: 'pass',            description: 'All four dimensions ≥4.' },
    { verdict: 'pass_with_notes', description: 'Overall usable but one or more at 3.' },
    { verdict: 'fail',            description: 'Any dimension ≤2.' },
  ],
  checks: [
    'cites at least one number from the tool results',
    'stays within the anomaly scope',
    'names at least one specific action',
    'does not invent numbers not present in the evidence',
  ],
};
```

Four dimensions. Each with a 1-5 scale where each point has a written description ("Restates the symptom; no mechanism named" through "Specific mechanism, evidence directly supports it, and rival mechanisms are considered"). Three verdicts derived from the dimension scores. Four binary sanity checks.

The rubric is *structured prompting*. It's not a natural-language "please grade this diagnosis." It's a data structure the `RubricJudge` engine turns into a system + user prompt for the judge model, then parses the response into a typed judgment.

The recommendation rubric at `eval/rubrics/recommendation-quality.ts` has the same shape — 4 dimensions × 5-point scale × 3 verdicts × 4 checks — but its dimensions are different (`diagnosis_response`, `feature_choice_fit`, `step_actionability`, `impact_realism`), and its task prompt explicitly says "you will receive the DIAGNOSIS that this recommendation is responding to as context. Recommendations are graded relative to that diagnosis, not in the abstract."

That "relative to that diagnosis" is the load-bearing bit. A recommendation that would be great for a *different* problem still scores badly if it doesn't address *this* diagnosis's root cause. Without that framing, the judge would score generically-well-written recs as good even when they miss the mark.

#### The judge context — what lets a judge distinguish grounded from invented

The diagnosis judge is called with:

```
diagnosisJudge.judge({
  subject: JSON.stringify(diagnosis, null, 2),
  context: {
    anomaly:            JSON.stringify(goldenCase.anomaly, null, 2),
    known_correct_shape: JSON.stringify(goldenCase.knownCorrect, null, 2),
    case_intent:        goldenCase.intent,
    signal_class:       goldenCase.signalClass,
    tool_calls_trace:   formatToolCallTrace(diagnosisToolCalls),
  },
});
```

`eval/run.eval.ts:238-247`. Five context fields:

- **anomaly** — the input the diagnosis was supposed to explain.
- **known_correct_shape** — human-written notes on the correct shape for *this* case (trap flags, expected mechanism).
- **case_intent** — one paragraph on what a correct diagnosis looks like.
- **signal_class** — meta-label.
- **tool_calls_trace** — the actual tool calls the agent made, with results (truncated to 4000 chars).

That last one — `tool_calls_trace` — is the load-bearing addition. Without it, a judge scoring a diagnosis has no way to tell whether the numbers cited in the diagnosis actually came from a tool result, or whether the agent made them up. With it, the judge can literally cross-reference every claim against the trace.

From receipt `05-no-signal-retention-subscribers-2026-07-03T02-12-17-099Z.json`, the judge writes:

> "The diagnosis cites numbers (31.2% payment failure rise, 4,820 high-risk customers, 18.4% conversion drop) but these numbers originate from tools that do not exist in the workspace or returned synthetic data unrelated to subscription/billing events. The known_correct_shape explicitly flags inventing subscriber counts, churn rates, and MRR numbers as a failure mode. Every cited number is either invented or from a tool whose output is synthetic noise, not grounded in actual subscription signals."

That entire finding is only possible because the judge saw the tool_calls_trace and could see that no tool actually returned "4,820 high-risk customers." Without the trace, the judge would have taken the number at face value and given the diagnosis a higher score on `evidence_grounding`. This is the *judge-as-secondary-prompt* discipline: the judge needs its own context, or it grades in a vacuum.

The recommendation judge gets a slightly different context set at `eval/run.eval.ts:298-304`:

```
{
  anomaly: JSON.stringify(goldenCase.anomaly, null, 2),
  diagnosis: JSON.stringify(diagnosis, null, 2),
  case_intent: goldenCase.intent,
  signal_class: goldenCase.signalClass,
  tool_calls_trace: recommendationTraceForJudge,
}
```

No `known_correct_shape` (that's diagnosis-specific), but *diagnosis* is passed so the judge can score the rec relative to the actual diagnosis the agent produced (not the golden's known-correct diagnosis). That relative framing prevents the judge from grading recs against an ideal diagnosis when the actual diagnosis was flawed.

#### The receipt — one file per case per run

`eval/receipts/<caseId>-<runId>.json` at `eval/run.eval.ts:341-395` captures:

- `runId`, `case`, `signalClass`, `intent`
- `durationMs` — investigate, judge, recommend, judge, total
- `model` — `{ agent: 'claude-sonnet-4-6', judge: 'claude-sonnet-4-6' }`
- `anomaly`, `diagnosisToolCalls[]`, `recommendationToolCalls[]`
- `usage` — per-invocation input/output tokens and cost
- `budget` — snapshot of the shared `BudgetTracker`
- `diagnosis`, `diagnosisJudgment`, `diagnosisJudgmentError`, `diagnosisJudgeAttempts`
- `recommendations[]`, `recommendationJudgments[]`

Everything you need to bisect a regression. The critical bits: `diagnosisJudgeAttempts` (retry count — if >1, the judge model failed to produce parseable JSON on the first try), `diagnosisJudgmentError` (string when the judge produced no parseable output at all, and the receipt fills in a `judge_error` verdict placeholder to keep aggregation stable).

The `afterAll` block at `eval/run.eval.ts:429-525` walks all the receipts from one runId and prints:

- Per-case verdicts (`diag: pass_with_notes`, `recs: 2/3`)
- Per-dimension pass rate across all cases (`root_cause_plausibility 6/10 (60%) dist [1:0 2:1 3:3 4:4 5:2]`)
- Escape-hatch check — at least 3 distinct scores per dimension, or the substrate is too homogeneous

That escape-hatch check is the meta-discipline: if every case scores a 5 on a dimension, the dimension isn't measuring anything — it's a flatline. Force the goldens to span at least 3 distinct outcomes per dimension.

### Move 2 variant — the load-bearing skeleton

The kernel of eval-driven iteration:

1. **A golden set that spans the intent shapes.** Drop it and you're grading on demo data. This repo has 10 cases across 4 signal classes.
2. **A rubric with multi-dimensional scoring, not just pass/fail.** Drop it and you can't tell *what* got worse. Score-per-dimension is what enables diffing.
3. **Judge context that includes the tool trace.** Drop it and the judge grades hallucinated numbers as correct because they look plausible.
4. **Per-case receipts stored on disk.** Drop it and you can't diff runs. This is the artifact that makes iteration measurable.
5. **A pre-declared gating rule that separates regressions from measurements.** `has-signal` gated, `no-signal` measured. Without it, a positive golden that the model handles surprisingly badly halts the whole eval.

Hardening on top: judgment stability testing (run the same case N times, check variance), calibration slices (compare judge scores to human scores on a subset), per-dimension trend charts, cost dashboards. None of that is the skeleton — the skeleton is: goldens + rubric + judge with context + receipt + gating rule.

### Move 3 — the principle

**The senior-vs-junior dividing line: a junior iterates by vibes ("the response feels better now"). A senior iterates against an eval set.** Skipping evals isn't faster; it's slower, because you'll iterate in circles. Every prompt change you make without an eval is a lottery ticket — sometimes you improve the model, sometimes you regress on a case you're not tracking, and either way you can't tell. The eval is the differencing engine. When it says "root_cause_plausibility went from avg 4.2 to avg 3.6," that's a real signal. When your gut says "the response feels better," that's not.

Hamel Husain's writing is the canonical reference here. He's been saying this for two years, and every time an engineer skips the eval they end up rediscovering the same wall. Read his stuff before you touch a production prompt.

## Primary diagram

```
  Eval-driven iteration — the full recap

  ┌─ Fixture layer ──────────────────────────────────────────────┐
  │  goldens/                                                     │
  │    01-conversion-drop-mobile-checkout    (has-signal, gated)  │
  │    02-fraud-payment-failure-credit-card  (has-signal, gated)  │
  │    03-session-drop-organic-mobile        (has-signal, gated)  │
  │    04-cart-abandonment-mobile-broad      (partial, gated)     │
  │    05-no-signal-retention-subscribers    (no-signal, measured)│
  │    06-no-signal-price-sensitivity-luxury (no-signal, measured)│
  │    07-positive-conversion-surge-mobile   (positive, measured) │
  │    …                                                          │
  └────────────────────────┬─────────────────────────────────────┘
                           │  for each case:
  ┌─ Agent under test ─────▼─────────────────────────────────────┐
  │  DiagnosticAgent.investigate(anomaly) → diagnosis             │
  │  RecommendationAgent.propose(anomaly, diagnosis) → recs       │
  │  budget tracker shared across both                            │
  └────────────────────────┬─────────────────────────────────────┘
                           │
  ┌─ Judge layer ──────────▼─────────────────────────────────────┐
  │  diagnosisJudge = new RubricJudge({ rubric: diagQualityRubric })│
  │    .judge({ subject, context: {                               │
  │       anomaly, known_correct_shape, case_intent,              │
  │       signal_class, tool_calls_trace                          │
  │    }})                                                        │
  │  recommendationJudge = new RubricJudge({ rubric: recQuality })│
  │    per rec, context: { anomaly, diagnosis, intent, class,     │
  │                        tool_calls_trace }                     │
  └────────────────────────┬─────────────────────────────────────┘
                           │
  ┌─ Receipt ─────────────▼─────────────────────────────────────┐
  │  eval/receipts/<case>-<runId>.json                            │
  │    diagnosis + judgment + toolCalls + usage + cost + attempts │
  │    everything needed to diff two runs                         │
  └────────────────────────┬─────────────────────────────────────┘
                           │
  ┌─ afterAll aggregation ▼─────────────────────────────────────┐
  │  per-case verdicts table                                     │
  │  per-dimension pass rate                                     │
  │  escape-hatch check (≥3 distinct scores per dim)             │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

The judgment stability variance in this repo is real and worth naming. Between runs `2026-07-03T02-12-17-099Z`, `2026-07-03T02-47-24-392Z`, and `2026-07-03T04-08-28-644Z`, the same case scored `root_cause_plausibility` at 4 and at 5 depending on the run — same anomaly, same agent code, same rubric. The judge model is nondeterministic at temperature 0 (Anthropic doesn't guarantee determinism), and the reasoning path shifts slightly each time.

The pragmatic response: don't chase noise. A one-point change on one dimension on one case across two runs is inside the variance envelope. A one-point change across all cases in a dimension is a real signal. This is exactly why the aggregation table in `afterAll` reports per-dimension averages across the whole set — the average is more stable than any single score.

The alternative — bumping to `temperature: 0` (already done at `eval/run.eval.ts:236,283`) plus running each judgment N=3 times and taking the median — would tighten the variance but triple the cost. This repo hasn't paid that yet. If a specific dimension's variance gets loud enough to hide real signal, that's when to invest.

The rec anti-pattern from the baseline evidence: on has-signal cases where the diagnosis correctly identifies "payment processor" as the primary root cause, the recommendation would sometimes propose "pause the A/B experiment" (a secondary contributor mentioned in the diagnosis). The judge scored those `diagnosis_response = 2` (fail) because the rec was addressing a symptom rather than the diagnosed cause. This shows up in `receipts/04-cart-abandonment-mobile-broad-*.json`. That kind of specific, actionable, prompt-fixable finding is exactly what an eval discipline earns you — you couldn't have found this reading logs.

The eval takes 15-40 minutes for 10 cases against Anthropic Sonnet. That's the price. It's low enough to run on every meaningful prompt change, high enough that you don't run it on every commit. Hamel's advice: put the fast subset (2-3 cases) on CI, run the full set nightly and before shipping.

## Interview defense

**Q: How do you know a prompt change is an improvement?**

You don't, unless you have an eval. In this codebase the eval is `npm run eval` — 10 golden cases, each run through the real DiagnosticAgent and RecommendationAgent, each output graded by a `RubricJudge` on a 4-dimension × 5-point rubric. Every run writes per-case receipts to `eval/receipts/`. Diffing two receipts tells you which dimensions moved and by how much. Without that, you're iterating by vibes and you'll regress on cases you're not tracking. Hamel Husain has been the canonical voice on this for the last couple of years.

```
   prompt v1   ──► eval  ──► receipts v1  ┐
                                          │  diff
   prompt v2   ──► eval  ──► receipts v2  ┘
```

Anchor: `eval/run.eval.ts`, `eval/rubrics/diagnosis-quality.ts`, `eval/receipts/`.

**Q: The judge scores vary across runs — how do you tell noise from signal?**

Between runs on the same case, `root_cause_plausibility` can score 4 or 5 for the same output. That's judge nondeterminism, even at temperature 0. The pragmatic move: don't chase single-case single-dimension changes. Compare per-dimension averages across the whole golden set — the average is stable in a way individual scores aren't. The `afterAll` block at `eval/run.eval.ts:429-525` prints exactly that: per-dimension pass rate and score distribution across all 10 cases. When an aggregate moves by 10%+, that's a real signal. When one dimension on one case moves by one point, that's noise.

```
   single case, single dim, single run  ← noise
   ───────────────
   all cases, single dim, avg          ← signal
```

Anchor: `eval/run.eval.ts:479-513` (the dimension aggregator).

**Q: Why does the judge need the tool trace as context?**

Without the tool trace, the judge can't tell whether a number cited in the diagnosis actually came from a tool result or whether the agent made it up. Receipt `05-no-signal-retention-subscribers-2026-07-03T02-12-17-099Z.json` is the canonical example: the diagnosis confidently cites "4,820 high-risk customers" and "31.2% payment failure rise" — numbers that no tool in the workspace could have produced. Only because the judge sees the actual tool trace can it write: "these numbers originate from tools that do not exist in the workspace." That finding drives the `evidence_grounding` score to 1. Without the trace, the same diagnosis would look grounded and score higher. Judge context is a prompt engineering choice, and the tool trace is the load-bearing field.

```
  judge context = { anomaly, diagnosis, intent, signal_class, tool_calls_trace }
                                                                     ▲
                                                          the load-bearing addition
```

Anchor: `eval/run.eval.ts:238-247` (diagnosis judge context), `eval/run.eval.ts:298-304` (rec judge context).

## See also

- 02 · structured outputs — the RubricJudge uses structured output; `attempts` on the receipt records retries.
- 03 · prompts as code — the rubric is versioned inline (`id: 'blooming-diagnosis-quality-v1'`).
- 10 · self-critique — the judge is self-critique's cousin, but with a distinct agent doing the critique.
- 04 · token budgeting — the per-case receipts include input/output tokens per call, which is how you measure a token-budget change's impact.
