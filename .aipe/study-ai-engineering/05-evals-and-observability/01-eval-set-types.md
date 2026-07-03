# 01 — Eval set types

**Type:** Industry standard. Also called: golden set, adversarial set, regression set.

## Zoom out, then zoom in

Three eval set types, each catching a different failure mode. This repo has one type (golden) fully built; the other two are Case B / partially exercised.

```
  Zoom out — the three eval sets

  ┌─ Golden set (this repo — 10 cases in eval/goldens/) ──────────────┐
  │  hand-curated "right" cases; measures baseline quality             │
  │  ★ THIS CONCEPT — the goldens ★                                    │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Adversarial set (Case B) ────────────────────────────────────────┐
  │  designed to break; edge cases, prompt injection, ambiguous        │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Regression set (partial — eval/baseline.json) ───────────────────┐
  │  frozen production failures; prevents re-introducing bugs          │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. The 10 goldens in `eval/goldens/` cover four signal classes: `has-signal` (substrate supports diagnosis), `partial-signal` (some data missing), `no-signal` (should refuse), `positive` (upward anomaly, rare in training). Adversarial + regression are Case B.

## Structure pass

Axis: what failure mode does the set catch?
- Golden: does the agent produce the right answer on canonical cases?
- Adversarial: does the agent break on edge cases / attacks?
- Regression: does a past failure re-appear?

**Seam:** the eval receipt. All three sets read into the same receipt shape (`eval/receipts/*.json`), aggregated by `baseline.eval.ts`.

## How it works

### Move 1

You've written unit tests, integration tests, load tests — each catches different bugs. Eval sets are the same, three-tier structure at the LLM boundary.

```
  Three sets, three failure modes

  golden         → happy path fails silently          → measures baseline
  adversarial    → attacker or edge case exposes flaw → measures robustness
  regression     → known bug creeps back in           → prevents re-intro
```

### Move 2

**Golden set — this repo's 10 cases.**

`eval/goldens/index.ts` collects 10 golden cases:
- `01-conversion-drop-mobile-checkout` (has-signal) — canonical happy path
- `02-fraud-payment-failure-credit-card` (has-signal) — fraud detection
- `03-session-drop-organic-mobile` (has-signal) — traffic drop
- `04-cart-abandonment-mobile-broad` (has-signal) — broad-scope funnel
- `05-no-signal-retention-subscribers` (no-signal) — should refuse
- `06-no-signal-price-sensitivity-luxury` (no-signal) — should refuse
- `07-positive-conversion-surge-mobile` (positive) — upward anomaly
- `08-checkout-collapse-multi-scope` (has-signal) — multi-scope
- `09-engagement-drop-email-campaign` (partial-signal) — campaign metric missing
- `10-no-signal-seo-organic` (no-signal) — should refuse

Each case has `{caseId, signalClass, intent, anomaly, knownCorrect}` (`eval/goldens/types.ts`). The `knownCorrect` field is free-form guidance for the LLM judge about what the diagnosis SHOULD reflect.

**Signal-class-aware gating.**

`eval/run.eval.ts:406-424` treats gated (has-signal, partial-signal) and measured (no-signal, positive) cases differently. Gated: the test FAILS if the judge verdict is `fail`. Measured: the test always passes, and the verdict is a data point. This is what lets no-signal cases test hallucination resistance without turning a "correct refusal" into a test failure.

**Adversarial set — Case B.**

Not built today. Candidates for adversarial cases:
- Prompt injection: an anomaly whose text contains "ignore previous instructions" attacks
- Ambiguous scope: an anomaly with contradictory scope tags
- Data poisoning: an anomaly whose evidence has NaN / null / malformed values
- Lost-in-the-middle: an anomaly whose critical detail is buried mid-context (see `02-context-and-prompts/02-lost-in-the-middle.md`)

**Regression set — partial (via baseline.json).**

`eval/baseline.eval.ts` computes per-dim pass rates from a run's receipts and writes `eval/baseline.json`. `eval/gate.eval.ts` compares a candidate run against baseline and fails if any dim regresses by > `GATE_MAX_REGRESSION` (default 0.10). This is regression detection at the DIMENSION level, not the case level.

A per-case regression set would grow over time as production failures are added. Not built today because production traffic is nil, but the shape is there.

### Move 3

Three sets, three purposes. Golden measures baseline quality; adversarial measures robustness; regression prevents re-introduction. Each is a distinct discipline — building only goldens (this repo's state) catches baseline drift but misses attack-shaped and known-bug-shaped failures.

## Primary diagram

```
  Eval sets in this codebase

  ┌─ eval/goldens/ ───────────────────────────────────────────────────┐
  │  01-conversion-drop-mobile-checkout      (has-signal)              │
  │  02-fraud-payment-failure-credit-card    (has-signal)              │
  │  03-session-drop-organic-mobile          (has-signal)              │
  │  04-cart-abandonment-mobile-broad        (has-signal)              │
  │  05-no-signal-retention-subscribers      (no-signal)  ← gated skip │
  │  06-no-signal-price-sensitivity-luxury   (no-signal)  ← gated skip │
  │  07-positive-conversion-surge-mobile     (positive)   ← measure    │
  │  08-checkout-collapse-multi-scope        (has-signal)              │
  │  09-engagement-drop-email-campaign       (partial-signal)          │
  │  10-no-signal-seo-organic                (no-signal)  ← gated skip │
  │                                                                   │
  │  → run.eval.ts iterates via it.each()                             │
  │  → receipt per case in eval/receipts/                              │
  │  → aggregated in baseline.json                                     │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ eval/baseline.json (regression reference) ───────────────────────┐
  │  per-dim pass rates, per-verdict distribution                     │
  │  → gate.eval.ts compares candidate vs baseline                    │
  │  → fails if any dim regresses by > GATE_MAX_REGRESSION            │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ adversarial set (Case B — not built) ────────────────────────────┐
  │  prompt injection, ambiguous scope, malformed evidence            │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The golden/adversarial/regression triad is standard in ML engineering. In LLM eval it maps directly: golden = canonical cases, adversarial = red-team, regression = frozen production failures. Modern LLM eval frameworks (Braintrust, Weights & Biases, Langfuse) support all three natively.

Beyond the triad, some teams add: **stability set** (same case run N times to measure output variance) and **A/B set** (candidate vs baseline on the same case with pairwise comparison). Neither is built here.

## Project exercises

### Exercise — adversarial set with 5 prompt-injection variants

- **Exercise ID:** C3.1-B · Case B (adversarial not built).
- **What to build:** add `eval/goldens/adversarial/` with 5 cases: (1) anomaly text contains "ignore previous instructions"; (2) anomaly evidence includes contradictory numbers; (3) anomaly scope has an out-of-schema value; (4) anomaly with no impact context; (5) anomaly whose severity contradicts the change magnitude. Extend `eval/run.eval.ts` to iterate the adversarial set separately. Rubric: agent should refuse or note the anomaly is malformed, not confabulate.
- **Why it earns its place:** measures robustness explicitly. Interviewer signal: "my agents survive attempts to break them; here's the measured proof."
- **Files to touch:** `eval/goldens/adversarial/*.ts`, `eval/goldens/index.ts` (add adversarial re-export), `eval/run.eval.ts` (add adversarial iteration).
- **Done when:** running eval prints a separate "adversarial pass rate" section; 5 cases show whether the agent refuses / notes / confabulates.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: What eval sets do you have?**

Golden set (10 cases in `eval/goldens/`), signal-class-tagged. Regression detection via `eval/baseline.json` + `eval/gate.eval.ts`. Adversarial set is Case B — I know the shape and haven't built it because I've focused on the tier-2 story of "hardening what exists" first.

**Q: What's a signal class?**

A tag on each golden case describing what the substrate can support. Four values: `has-signal`, `partial-signal`, `no-signal`, `positive`. Gates in the harness treat them differently — has-signal/partial-signal cases FAIL the test on judge=fail. No-signal/positive cases are measured but never gate the test. This lets me test hallucination resistance (no-signal → agent should refuse) without turning a correct refusal into a test failure.

```
  gated:     has-signal, partial-signal  → judge=fail → test fails
  measured:  no-signal, positive         → judge=fail → data point
```

**Q: Why not more goldens?**

Because 10 is enough to detect the failure modes at this stage — coverage of the four signal classes, coverage of different metric shapes (revenue, conversion, session count, cart), coverage of scope granularity (mobile-only vs multi-scope). The tier-2 constraint isn't case count; it's rubric quality and observability.

## See also

- `02-eval-methods.md` — how each case is scored
- `03-llm-as-judge-bias.md` — what the judge can get wrong
- `04-llm-observability.md` — the receipt each case produces
- `eval/goldens/` — the goldens
- `eval/baseline.json` — the regression reference
