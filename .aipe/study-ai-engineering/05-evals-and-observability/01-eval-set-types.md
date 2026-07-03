# Eval set types

## Subtitle

Golden / adversarial / regression set — Industry standard.

## Zoom out, then zoom in

blooming's eval set is 10 hand-curated golden cases in `eval/goldens/01-*.ts` through `10-*.ts`. Four signal classes: `has-signal` (canonical happy path), `no-signal` (agent should say "I don't know"), `multi-scope` (compound anomaly), `positive` (an *up* anomaly — surge, not drop). The known-failure cases (01 + 08) are effectively a regression set now — any refactor that reintroduces the "pause the A/B" recommendation on those cases will fail the gate.

```
  Zoom out — three eval-set roles, one file layout

  ┌─ eval/goldens/ ────────────────────────────────────┐
  │  10 files, each one golden case                     │
  │  hand-curated, "this is the right answer"           │
  └───────────────────────┬────────────────────────────┘
                          │  each has signalClass
                          ▼
  ┌─ Signal classes (4) ★ ─────────────────────────────┐ ← we are here
  │  has-signal, no-signal, multi-scope, positive       │
  └───────────────────────┬────────────────────────────┘
                          │  known-failure cases
                          ▼
  ┌─ De-facto regression set ──────────────────────────┐
  │  cases 01 + 08 (A/B experiment failure)             │
  │  eval/gate.eval.ts blocks on any dim regressing >10pp│
  └────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** eval case → signal class → judged output → aggregate. Four bands.
- **Axis: coverage.** Each signal class covers one shape of failure. Uneven distribution is fine — the point is to have one exemplar of each shape.
- **Seam:** the golden case type (`eval/goldens/types.ts`). It's the contract every case implements.

## How it works

### Move 1 — the mental model

Three set types, each with a purpose:

```
  Three eval sets — role and shape

  ┌─ Golden ──────────────────────────────────────────┐
  │  hand-curated "this is the right answer"           │
  │  purpose: measure baseline quality                 │
  │  size: 10-100 items, high signal per item          │
  └────────────────────────────────────────────────────┘

  ┌─ Adversarial ─────────────────────────────────────┐
  │  designed to break — edge cases, injection attempts│
  │  purpose: measure robustness                       │
  │  size: 20-50 items                                 │
  └────────────────────────────────────────────────────┘

  ┌─ Regression ──────────────────────────────────────┐
  │  bugs you caught in production, frozen             │
  │  purpose: prevent re-introduction                  │
  │  size: grows over time                             │
  └────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**The blooming golden set.** 10 cases, one per file (`eval/goldens/01-*.ts` through `10-*.ts`). Each defines:

- An `Anomaly` — what the monitoring scan handed off.
- A `signalClass` — one of `has-signal`, `no-signal`, `multi-scope`, `positive`.
- An `intent` — English description of what a good diagnosis should look like.
- `knownCorrect` — hand-curated expected root cause, co-occurring signals, red herrings to avoid.

Example (case 01, `eval/goldens/01-conversion-drop-mobile-checkout.ts`):

```ts
export const goldenCase: GoldenCase = {
  caseId: '01-conversion-drop-mobile-checkout',
  signalClass: 'has-signal',
  intent: 'The canonical happy path — clear anomaly, ...',
  anomaly: { metric: 'conversion_rate', scope: ['mobile', 'checkout', 'SP'], ...},
  knownCorrect: {
    primary_signal: 'checkout → purchase step is where the funnel breaks; ...',
    co_occurring_signal: 'payment_failure_rate rose 31.2%',
    most_likely_root_cause_candidates: ['payment processor issue ...'],
    scope_should_stay_within: ['mobile', 'checkout', 'SP', 'credit_card'],
    red_herrings_to_avoid: ['desktop conversion', 'top-of-funnel', ...],
  },
};
```

**Why 4 signal classes.** Different failure modes surface on different anomaly shapes. `no-signal` cases (05, 06, 10) test "does the agent admit ignorance?" — a wrongly-confident diagnosis on a null anomaly is a specific bug. `multi-scope` (08) tests "does it stay coherent across multiple simultaneous drops?" — a specific compound-shape bug. `positive` (07) tests "does it treat a *surge* as its own kind of anomaly?" — often the model reflexively frames a positive change as a problem.

**The regression set that's implicit.** blooming doesn't have a separate `eval/regressions/` folder because the known-failure modes are already encoded in the 10 goldens. Cases 01 + 08 both have the "pause the A/B experiment" failure baked into the eval — if a refactor makes them worse (dropping the `diagnosis_response` pass rate), the gate blocks (see **02-eval-methods.md**).

**Adversarial set that's not there yet.** No dedicated adversarial set today. Would target: prompt-injection payloads in the anomaly's `impact` text, EQL query hallucinations, out-of-scope questions. Named as a gap; see the exercise below.

Diagram of the 4 signal classes:

```
  Signal-class coverage — one exemplar of each

  ┌──────────────┬────────────────────────┬───────────────┐
  │ signalClass  │ what it tests           │ case IDs      │
  ├──────────────┼────────────────────────┼───────────────┤
  │ has-signal   │ canonical diagnosis path│ 01, 02, 03, 04│
  │              │ · substrate has evidence│ 09             │
  │              │ · agent should find it  │               │
  ├──────────────┼────────────────────────┼───────────────┤
  │ no-signal    │ null anomaly            │ 05, 06, 10    │
  │              │ · agent should admit    │               │
  │              │   "I don't know"        │               │
  ├──────────────┼────────────────────────┼───────────────┤
  │ multi-scope  │ compound anomaly across │ 08            │
  │              │ multiple segments       │               │
  ├──────────────┼────────────────────────┼───────────────┤
  │ positive     │ metric surged (not      │ 07            │
  │              │ dropped)                │               │
  └──────────────┴────────────────────────┴───────────────┘
```

### Move 3 — the principle

The set is the contract. Coverage per signal-class matters more than raw case count. 10 well-shaped cases spanning 4 classes is stronger evidence than 100 cases all of one shape.

## Primary diagram

```
  blooming eval sets — full frame

  ┌─ eval/goldens/ (LIVE, 10 files) ────────────────────┐
  │                                                      │
  │  ┌─ has-signal (5) ─┬─ no-signal (3) ─┐              │
  │  │  01, 02, 03, 04, │ 05, 06, 10       │              │
  │  │  09              │                  │              │
  │  └──────────────────┴──────────────────┘              │
  │  ┌─ multi-scope (1) ┬─ positive (1) ──┐              │
  │  │  08              │ 07               │              │
  │  └──────────────────┴──────────────────┘              │
  │                                                      │
  │  each case: Anomaly + signalClass + intent +          │
  │             knownCorrect                              │
  └─────────────────────────────────────────────────────┘

  ┌─ eval/baseline.json (LIVE) ─────────────────────────┐
  │  runId 2026-07-03T04-08-28-644Z                      │
  │  per-dim pass rates, per-case receipts               │
  │  → regression gate reads this                        │
  └─────────────────────────────────────────────────────┘

  ┌─ eval/adversarial/ (not yet) ───────────────────────┐
  │  · prompt-injection payloads                         │
  │  · EQL hallucinations                                │
  │  · out-of-scope QueryBox inputs                      │
  └─────────────────────────────────────────────────────┘
```

## Elaborate

Golden sets are the load-bearing eval type. Adversarial and regression sets add coverage for specific concerns but don't replace the "hand-curated correctness" of goldens. blooming's specific choice — small (10) but signal-class-diverse — is deliberate: each class exercises a distinct failure shape, so the receipts tell you *what* broke, not just *whether* something broke.

The regression-through-goldens pattern (where known-failure cases live in the golden set with an accepted low score) is one option; a separate regressions folder is another. Both let the gate catch reintroductions.

Related: **02-eval-methods.md** (how the golden set is scored), **04-llm-observability.md** (how the results become a receipt).

## Project exercises

### B5.1 · Add an adversarial set

- **Exercise ID:** B5.1 (Case B — not yet implemented)
- **What to build:** 5–10 adversarial cases in `eval/adversarial/`. Types: (a) prompt-injection payloads in `anomaly.impact` text; (b) EQL-hallucination temptations (anomaly evidence that mentions non-existent event names); (c) out-of-scope inputs (QueryBox text unrelated to analytics).
- **Why it earns its place:** Closes a real gap. Adversarial coverage catches failure modes the golden set doesn't exercise.
- **Files to touch:** New `eval/adversarial/*.ts`, extend `eval/run.eval.ts` to score adversarial cases with a pass/fail (not rubric — pass = "agent refused / handled gracefully").
- **Done when:** the adversarial suite runs in CI alongside the golden set; results feed a separate baseline row.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: Why 10 cases — isn't that small?**

Deliberate. Ten hand-curated cases across four signal classes gives me one exemplar per failure shape. Adding a 50th `has-signal` case doesn't teach me anything new; adding an adversarial suite would (see `B5.1`). The load-bearing part: the coverage per class matters more than raw case count. Each case's `intent` + `knownCorrect` is a 30-minute investment per case — 10 is where I could keep quality high; 100 would degrade to noise.

**Q: You said cases 01 and 08 both failed. Why keep them at all?**

They're the regression set. Their known failure is baked in — the recommendation-quality rubric's `diagnosis_response` dimension scores 2 on both, and the baseline records the failure explicitly. If a refactor makes them worse (say the score drops to 1), the gate blocks. If a refactor fixes them (score 3+), the baseline updates. Load-bearing: known failures documented in the eval are stronger than known failures documented in a comment.

## See also

- [02-eval-methods.md](02-eval-methods.md) — the rubrics that score these cases.
- [04-llm-observability.md](04-llm-observability.md) — how results become receipts.
- [../04-agents-and-tool-use/06-error-recovery.md](../04-agents-and-tool-use/06-error-recovery.md) — the graceful-degradation receipt.
