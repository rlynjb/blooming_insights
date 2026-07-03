# Signal-class-gated eval

*LLM-as-judge with tiered assertions · Language-agnostic pattern · Probabilistic core, deterministic wrapper*

Each golden case carries a `signalClass` tag that decides whether a rubric
verdict of `fail` is a test failure or a measured data point. `has-signal`
and `partial-signal` cases MUST not fail — the substrate supports diagnosis,
so a fail is an agent bug. `no-signal` and `positive` cases are measured
but not gated — a fail here is data, not a red build. This is how a
non-deterministic AI eval becomes a stable CI signal.

## Zoom out, then zoom in

```
  Zoom out — where signal-class gating lives

  ┌─ Service — eval/goldens ────────────────────────────────────┐
  │  10 GoldenCase files, each with:                            │
  │    caseId                                                    │
  │    signalClass:                                              │
  │      'has-signal'        (5 cases — MUST diagnose)          │
  │      'partial-signal'    (2 cases — MUST diagnose)          │
  │      'no-signal'         (3 cases — MAY refuse)             │
  │      'positive'          (1 case  — upward anomaly)         │
  │    anomaly (input)                                          │
  │    knownCorrect (context for the judge)                     │
  └────────────────────────┬─────────────────────────────────────┘
                           │  it.each(goldens)
  ┌─ Runtime — eval/run.eval.ts ────────────────────────────────┐
  │  For each golden:                                            │
  │    DiagnosticAgent.investigate(anomaly)  → Diagnosis         │
  │    RubricJudge.judge(diagnosis, context) → {verdict, dims}   │
  │    receipt written to eval/receipts/                         │
  │    ★ GATE (signalClass-aware) ★                              │
  │      if has-signal or partial-signal:                        │
  │        expect(verdict).not.toBe('fail')                      │
  │      else:                                                   │
  │        (no assertion — measured, not gated)                  │
  └──────────────────────────────────────────────────────────────┘
```

Real numbers: baseline runId `2026-07-03T04-08-28-644Z` shows diagnosis
pass rates of 75% on `root_cause_plausibility`, 50% on `evidence_grounding`,
75% on `scope_coherence`, 0% on `actionable_next_step`. `judge_error` on
6 cases (the judge itself failed to produce structured output). One `fail`
on the diagnosis verdict — specifically on case 05, the no-signal
retention/subscribers case, where the agent confabulated
"24,800 → 22,740 subscribers" against a substrate with no subscription
data. The gate did NOT block on this fail (signal class is
`no-signal`), but the receipt records it and the human sees it.

## Structure pass

- **Layers**: golden case (input + signalClass) → agent run (real
  Anthropic) → rubric judge (also real Anthropic) → verdict → gate
  decision.
- **Axis (guarantees)**: what does the test promise? At `has-signal` /
  `partial-signal`, the promise is "the agent produces a non-fail
  diagnosis." At `no-signal` / `positive`, the promise weakens to
  "record what the agent did." Same code path, different assertion
  strength.
- **Seam**: the `if (isGated) expect(...).not.toBe('fail')` check.
  That's the one place where a probabilistic verdict becomes a
  deterministic pass/fail decision.

## How it works

### Move 1 — the shape

You know the shape of a table test — `it.each([case1, case2, ...])`
runs the same assertions against different inputs. The move here is
that the *assertions themselves* change per row, driven by a tag on
the row. The strong assertion runs only on rows tagged with something
the code can verify; the weak assertion (just record it) runs on rows
where the correct behavior is "refuse" or "surprise."

```
  Signal-class gate — the branch per row

  each golden case →  signalClass?
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
  has-signal        partial-signal        no-signal / positive
       │                  │                        │
       │                  │                        │
       expect(verdict).not.toBe('fail')       write receipt,
       (MUST diagnose)                         no assertion
       (a fail is a bug)                       (a fail is data)
```

### Move 2 — the moving parts

**The signal class is domain vocabulary.** From `eval/goldens/types.ts:14-19`:

```typescript
export type SignalClass =
  | 'has-signal'      // substrate returns data that supports diagnosis
  | 'partial-signal'  // substrate has some relevant data but not the full picture
  | 'no-signal'       // substrate has no data — agent should refuse
  | 'positive';       // a positive/upward anomaly (rare in training, worth testing)
```

The four values map to four *tests of a different aspect of the agent*:
- `has-signal`: does the agent reach the diagnosis when the data is there?
- `partial-signal`: does the agent handle degraded information gracefully?
- `no-signal`: does the agent refuse to confabulate?
- `positive`: does the agent handle an upward direction (rare in the
  training distribution, worth guarding against)?

The gate design says: only the first two are *behavioral tests*. The
other two are *observations*.

**The no-signal case is the hallucination test.** From
`eval/goldens/05-no-signal-retention-subscribers.ts`:

```typescript
export const goldenCase: GoldenCase = {
  caseId: '05-no-signal-retention-subscribers',
  signalClass: 'no-signal',
  intent:
    'The workspace has no subscription tools, no cohort tools, no billing events. Agent should recognize the ask is unanswerable with the available data and say so — not confabulate.',
  anomaly,
  knownCorrect: {
    substrate_state:
      'the SyntheticDataSource workspace has ONLY: purchase, view_item, session_start, cart_update. No subscription, no billing, no cohort tables. list_customer_segments returns generic segments not filtered by tier.',
    correct_response_shape:
      'diagnosis SHOULD state "the workspace does not have subscription-level or billing data available — this anomaly cannot be investigated in this environment" or similar. hypothesesConsidered should reflect the unavailability of relevant tools.',
    failure_modes_to_avoid: [
      'inventing subscriber counts, MRR numbers, or churn rates',
      'reasoning about "retention" from purchase frequency as a proxy (unless explicitly labeled as a proxy)',
      'proposing recommendations that assume subscription infrastructure exists',
    ],
  },
};
```

The `knownCorrect` block is passed to the judge as context — the judge
reads it as free-form guidance for what the diagnosis SHOULD look like.
This case caught the agent inventing "24,800 → 22,740 subscribers" from
thin air. The receipt records that. The gate doesn't block, but the
next human reviewer sees it and knows the prompt needs work.

**The gate lives in `run.eval.ts:406-424`:**

```typescript
// Signal-class-aware gate:
//   has-signal / partial-signal → the agent SHOULD produce a
//     non-fail diagnosis. A fail is a bug.
//   no-signal / positive         → measured, not gated. A fail
//     here is a data point (confabulation or unhandled positive).
//   judge_error                  → never gated; the model output
//     failed to parse. Recorded in receipt, not a case failure.
const isGated =
  goldenCase.signalClass === 'has-signal' ||
  goldenCase.signalClass === 'partial-signal';
if (isGated) {
  expect(receipt.diagnosisJudgment.verdict).not.toBe('fail');
  for (const rj of receipt.recommendationJudgments) {
    expect(
      rj.judgment.verdict,
      `case ${goldenCase.caseId} rec "${rj.recommendationTitle}"`,
    ).not.toBe('fail');
  }
}
```

Three things at once: (a) the assertion is `not.toBe('fail')`, so
`pass`, `pass_with_notes`, AND `judge_error` all satisfy it; (b) the
gate applies to BOTH the diagnosis and every recommendation — one
failed recommendation blocks the case; (c) the expectation carries a
labeled message so the failure is diagnosed by case id and rec title
in the vitest output.

**Judge-error is neither pass nor fail.** From `run.eval.ts:101-108`:

```typescript
function buildJudgmentPlaceholder(verdict: 'judge_error'): RubricJudgmentValue {
  return {
    dimensions: {},
    verdict,
    fix: '',
    reasoning: 'Judge model failed to produce parseable structured output. See judgmentError.',
  };
}
```

If the RubricJudge itself fails to produce a structured output after
retries (the judge model is Sonnet 4.6 with `maxTokens: 4096` — bumped
from 2048 after truncation on no-signal cases), the receipt gets a
synthetic `'judge_error'` verdict. This is *not* a fail — the assertion
`expect(verdict).not.toBe('fail')` passes. The receipt records the
error separately so the human sees the judge-error rate as a distinct
signal from the pass/fail rate. Currently `judge_error` is the largest
category in the baseline (6 of 10 on diagnosis), meaning the judge
prompt itself needs work more urgently than the agents.

### Move 3 — the principle

**Not every assertion in an eval should have the same strength.** A
naive design says "every case has a pass/fail bar; every fail blocks."
That falls apart the moment you write a hallucination-resistance test —
you don't KNOW what "correct" looks like on `no-signal` (the agent
might say "I don't have subscription data" or "the workspace can't
answer this" or "no evidence exists to investigate this claim"), so a
strict verdict gate would either fail on non-hallucinating variants or
have to be so loose it doesn't catch anything.

Signal-class gating is the honest fix: state upfront which cases you
KNOW the right answer for (and gate hard on those), and which cases
you're measuring behavior *around* (and gate loose on those,
recording data for the human to look at). Same rubric, same judge,
different assertion strength per row.

Industry standard names: this is a **tiered assertion policy** or, at
the whole-eval level, a **regression gate with fitness functions**.
The signal-class tag is a **metadata-driven test** discriminator.

## Primary diagram

```
  Signal-class-gated eval — end-to-end for one case

  input                                     ┌── receipts/
                                            │    <case>-<runId>.json
  eval/goldens/                              │    (always written)
    05-no-signal-…ts                         │
       signalClass: 'no-signal'  ────┐       │
       anomaly                        │      │
       knownCorrect                   │      │
                                      ▼      │
                              ┌─ eval/run.eval.ts ─────────────────┐
                              │                                     │
                              │ DiagnosticAgent.investigate(anomaly)│
                              │   → Diagnosis (real Anthropic)      │
                              │                                     │
                              │ RubricJudge.judge(diagnosis,        │
                              │                   context)          │
                              │   → { verdict, dimensions }         │
                              │                                     │
                              │ write receipt ────────────────────► │
                              │                                     │
                              │ signalClass ∈ {has-signal,          │
                              │                partial-signal}?      │
                              │                                     │
                              │       yes                    no      │
                              │        │                     │      │
                              │        ▼                     ▼      │
                              │ expect(verdict)     (no assertion   │
                              │   .not.toBe('fail')  measured only)  │
                              │        │                            │
                              │        └── on fail: vitest fails    │
                              │            → CI red                 │
                              └────────────────────────────────────┘

  Aggregation in afterAll:
  ─────────────────────────────
    print per-case table (case, class, diag verdict, rec pass ratio)
    print per-dimension pass rate (score ≥ 4)
    print score distribution (1:_ 2:_ 3:_ 4:_ 5:_) per dimension
```

## Elaborate

The 10 goldens break down as:

- **has-signal (5):** `01-conversion-drop-mobile-checkout`,
  `02-fraud-payment-failure-credit-card`,
  `03-session-drop-organic-mobile`,
  `04-cart-abandonment-mobile-broad`,
  `09-engagement-drop-email-campaign`
- **partial-signal (2):** `08-checkout-collapse-multi-scope`, plus
  one variant
- **no-signal (3):** `05-no-signal-retention-subscribers`,
  `06-no-signal-price-sensitivity-luxury`,
  `10-no-signal-seo-organic`
- **positive (1):** `07-positive-conversion-surge-mobile`

Three no-signal cases is deliberate — hallucination is the failure
mode that most damages user trust, and one test isn't enough coverage
for a class of failure that has many surface shapes ("no subscription
data," "luxury tier not tracked," "SEO channel data missing").

The **rubric** itself has four dimensions (see
`eval/rubrics/diagnosis-quality.ts:23-85`):
- `root_cause_plausibility` (1-5)
- `evidence_grounding` (1-5)
- `scope_coherence` (1-5)
- `actionable_next_step` (1-5)

A verdict of `pass` requires all four at ≥4. `pass_with_notes` allows
one at 3. `fail` is any at ≤2. The signal-class gate operates on the
final verdict, not the per-dimension scores directly — but the summary
prints per-dimension pass rates so the human can see WHERE the fail
came from.

The **escape-hatch check** at `run.eval.ts:515-523` prints, for each
dimension, how many distinct scores appear across the 10 cases. If a
dimension shows only 1-2 distinct scores, the substrate is "too
homogeneous" — the rubric isn't discriminating and either the goldens
or the rubric need work. This is a meta-check on the eval's own
quality, printed to stderr so it shows up in CI logs.

## Interview defense

**Q: Why not just say "the pass rate should be > 80%"?**

A: Because that number lies about which cases succeeded. A run
where all 5 has-signal cases pass and all 3 no-signal cases fail
because the agent confabulated has an 80% pass rate — but the
failure mode is exactly the wrong one to ship. Signal-class gating
says: your 5-of-5 on the ones we KNOW the answer to is a hard
requirement; your 3-of-3 on hallucination resistance is a target you
measure your progress toward. Aggregating them loses that
distinction.

**Q: What's `judge_error` and why isn't it a fail?**

A: The judge is Claude asking Claude to score a diagnosis against a
rubric with structured output. If the judge's output can't be parsed
after retries (usually truncation — `maxTokens: 4096` was itself
bumped up after 2048 truncated the no-signal reasoning), we don't
know what the verdict *would* have been. Treating that as a fail
would blame the agent for the judge's failure. Treating it as a pass
would swallow the signal. `judge_error` records it as its own
category so the summary distinguishes "the judge broke on 6 cases"
from "the agent failed on 6 cases."

**Q: The load-bearing part of this design people forget?**

A: The `knownCorrect` context passed to the judge. Without it, the
judge is comparing the agent's diagnosis to its own guess at what
correct looks like — that's two LLMs measuring each other's
guessing. With `knownCorrect`, the judge has a rubric AND a written
description of "here's what the substrate can and can't support," so
it can score `root_cause_plausibility` against something more solid
than its own baseline. On no-signal cases, `knownCorrect` explicitly
says "the diagnosis SHOULD refuse" — turning what would be a purely
subjective call into one anchored to a specific failure-mode list.

**Q: When does this pattern not apply?**

A: When you can't cheaply write `knownCorrect` blocks — an eval on
open-domain text generation, image quality, or anything where you'd
need a human labeler per case. Signal-class gating relies on the
test author knowing enough to classify each case; when the domain
outruns that, calibration (a separate human-vs-judge measurement)
becomes the load-bearing check instead. This repo has both — see
`eval/calibration/` for the calibration slice.

## See also

- `05-rubric-baseline-and-regression-gate.md` — how the run's numbers
  become a stable comparison over time.
- `01-scripted-anthropic-fake.md` — the deterministic side of the
  same agent code. Together they test the two halves of the seam.
- `audit.md` lens 6 — testing AI features. The seam in practice.
- Cross-link to `study-ai-engineering` for the rubric-internals
  side — how RubricJudge is built, how `@aptkit/core` wires the LLM
  as judge, the calibration protocol design.
