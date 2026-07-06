# RFC-10 — Regression gate (baseline vs candidate)

**Decision in one line:** Every prompt or model change runs through an eval gate that compares candidate per-dimension pass rates against a committed `eval/baseline.json`. Any dimension that regresses by >10 percentage points blocks the change. Absolute pp, not proportional. CI-ready.

---

## Context

Blooming's agents live and die on their prompts. A one-line change to the diagnostic system prompt can silently flip `evidence_grounding` from 50% pass rate to 30% pass rate — the agent still runs, the UI still renders, and the "shows its work" trace still looks reasonable. Only the quality dimension moved, and it moved down.

Manual review of eval outputs doesn't scale. Ten cases × three rubric dimensions × per-case reasoning traces is a lot to hold in your head — and the comparison against "the last known-good state" is where humans lose accuracy. What you want is an automated verdict: "is this candidate at least as good as what we had?"

The baseline runId (`2026-07-03T04-08-28-644Z`) sets the reference. Per-dimension pass rates in that run:

- `root_cause_plausibility`: 75%
- `evidence_grounding`: 50%
- `scope_coherence`: 75%
- `actionable_next_step`: 0%

Those aren't uniformly great — `actionable_next_step` at 0% is a known rubric weakness the diagnostic prompt hasn't cracked. But whatever they are, they're what the current release ships with. The gate's job is to prevent silent drops from those numbers.

---

## Decision

Two eval files at the top level of `eval/`:

- `eval/baseline.eval.ts` — reads all receipts for a specified runId and writes `eval/baseline.json`. Committed. The reference.
- `eval/gate.eval.ts` — reads `baseline.json` + the candidate run's receipts, computes per-dimension pass rate deltas, blocks if any regressed by more than `GATE_MAX_REGRESSION` (default 0.10 = 10 percentage points).

```
The gate — pass rates in, verdict out

  ┌─ committed reference ───────┐    ┌─ candidate run ──────────┐
  │ eval/baseline.json           │    │ receipts/*-{runId}.json  │
  │  · runId                     │    │  · one per eval case     │
  │  · caseCount                 │    │  · diagnosisJudgment     │
  │  · diagnosis.pass-rate-by-dim│    │  · recommendationJudgments│
  │  · recommendation.pass-rate  │    │                          │
  └──────────────┬───────────────┘    └────────────┬─────────────┘
                 │                                  │
                 ▼                                  ▼
                ┌───────────────────────────────────────┐
                │ per-dim delta = candidate − baseline  │
                │ regressed = (-delta > 0.10)            │
                └────────────────┬──────────────────────┘
                                 │
                                 ▼
                       ┌───────────────────┐
                       │ any regressed?    │
                       │  yes → exit(1)    │  ← CI blocks the PR
                       │  no  → exit(0)    │
                       └───────────────────┘
```

The verdict artifact `gate-{candidateRunId}.json` is written alongside `baseline.json` — CI can attach it as a PR comment or a check output. The per-dimension `delta` table prints to stderr in the eval run:

```
[diagnosis]
  root_cause_plausibility       base  75% → cand  62%   Δ -13pp ✗ REGRESSED
  evidence_grounding            base  50% → cand  50%   Δ  +0pp
  scope_coherence               base  75% → cand  75%   Δ  +0pp
  actionable_next_step          base   0% → cand  10%   Δ +10pp
```

Absolute-percentage-point comparison is the load-bearing choice — proportional math (10% drop of a 0% baseline) is undefined. See Alternatives.

Multi-baseline is supported via `BASELINE_LABEL`: `BASELINE_LABEL=v2 npm run eval:baseline` writes `baseline-v2.json`, `BASELINE_LABEL=v2 npm run eval:gate` reads it. Today one baseline is enough; the env-var pattern preserves optionality without adding a config file.

---

## Alternatives considered

**(a) Proportional drop, not absolute pp.** "Block if any dimension dropped by more than 20% of its baseline." Loses at low baselines. `actionable_next_step` sits at 0% today; 20% of 0% is 0%, which either treats any drop as a regression or none. Both are wrong. Absolute pp is the primitive that behaves sanely across the whole pass-rate range.

**(b) Verdict-level gate, not per-dimension.** Compare overall verdict distribution ("of 10 cases, how many `pass` verdicts?") instead of per-dimension. Loses because it's coarser — a case can drop from `pass` to `pass_with_notes` because ONE dimension regressed, or because THREE dimensions regressed. The gate wouldn't distinguish. Per-dimension surfaces exactly which subskill lost — the diff a prompt author needs to fix it.

**(c) Per-case regression, not aggregate.** Block if any single case regressed on any dimension. Loses because per-case verdicts are noisy — LLM-as-judge scores vary run-over-run even with temperature 0 on identical inputs (the judge's own model has non-determinism from batching). Aggregating across cases smooths the signal enough to detect real drift.

**(d) Wait for a real regression before adding the gate.** Loses on the same argument as RFC-07 (budget ceiling): the incident is the wrong forcing function. Once a regression ships, users have already seen the worse output. Prevention is 200 LOC and one config env var — cheap enough to build before the failure.

---

## Consequences

**What this buys:**
- **Silent quality drops become loud.** A one-line prompt change that regresses `evidence_grounding` by 15pp fails the gate. The engineer sees the specific dimension in the CI output.
- **The baseline is a real artifact.** `eval/baseline.json` is committed. Anyone can `cat` it and see the reference numbers. Reviewer-defensible: "what does 'quality' mean here?" → open the file.
- **Absolute pp is legible.** Non-eval-savvy reviewers can read "actionable_next_step went from 0% to 10%" and understand it. Proportional math is not that readable.
- **CI-shaped from day one.** The eval file skips unless `RUN_GATE=1` is set (so local eval runs stay fast) and throws on regression (so CI naturally fails). No special test infrastructure.
- **Multi-baseline workflow is ready.** Env-var `BASELINE_LABEL` lets you keep an old baseline for reference while a new one becomes the gate — the muscle for a real "candidate → new baseline" promotion process.

**Shipped-and-caught receipt (Move 3):** the gate has now caught a real intended-improvement-that-turned-out-to-be-a-regression. A recommendation-agent prompt/tooling change intended to improve rec quality regressed all four recommendation rubric dimensions by 13–23 percentage points in the eval. Baseline vs candidate deltas were loud — no dimension survived, the pass rates dropped in a band that no LLM-judge noise floor could plausibly account for (aggregate judge variance is ~1–2pp). The gate would have blocked the change in CI on the >10pp threshold. The revert landed as commit `be05240`, restoring the baseline behavior. This is the receipt that separates "gate that exists" from "gate that has done its job": the counterfactual isn't hypothetical anymore. The 10pp threshold was calibrated against noise; a real regression clearing 13pp on the least-affected dimension is exactly the shape the gate is designed to catch.

**What it costs:**
- **10 percentage points is a heuristic.** Tighter (5pp) would catch smaller drops but produce more false positives from LLM-judge noise. Looser (20pp) would miss real regressions. 10pp is the current guess; will get calibrated with usage.
- **The baseline gets stale.** As prompts improve, the baseline needs to be re-anchored — otherwise you're gating against a worse reference. No automated "when to promote" rule exists yet. See Open Questions.
- **Judge noise is real.** Some case-level verdicts will flip run-over-run at temperature 0 because of batching non-determinism. The aggregate smooths this, but a suite of ~10 cases isn't enough to fully absorb it. Wider suites help; costlier.
- **New dimensions default to 0% in the baseline.** If a rubric adds a fifth dimension, the baseline's per-dimension map doesn't have it, so its rate defaults to 0% — meaning the candidate can "regress" from 0% to any positive number (positive delta = no regression, safe). The direction is safe, but it means new dimensions aren't gated until a fresh baseline is built.

**What the reviewer will push on:**
> "10 percentage points is arbitrary."

Own it. The framing: "Yes, it's a starting knob. `GATE_MAX_REGRESSION` is env-configurable precisely so tighter thresholds are one variable away. Today's judgment: 10pp is loose enough that the ~1-2pp judge noise doesn't fire the gate, tight enough that a real prompt regression will. When we accumulate enough runs to characterize the noise floor, we tighten."

---

## Open questions

- **How to age baselines.** A baseline from three months ago that's now worse than the current state should stop being the reference. Trigger heuristic: promote a candidate to the new baseline when it beats the current baseline on every dimension for two consecutive runs. Not automated; today it's a manual `RUN_ID=... RUN_BASELINE=1 npm run eval:baseline` step.
- **When to promote a "candidate" to new baseline.** Related to the above. The two-runs-in-a-row heuristic is the current proposal; may want to tighten (three runs) or add case-level minimums.
- **Per-signal-class gates.** The eval cases split into signal classes (`conversion-drop`, `fraud`, `retention-no-signal`, etc.). A prompt change might improve `fraud` while regressing `retention-no-signal`. Today's gate aggregates across classes; a per-class version would surface tradeoffs. Deferred until we hit a real "improved here, regressed there" scenario.
- **Judge model drift.** The judge itself is an LLM. If we swap judge models, verdicts shift systematically — a candidate could "regress" purely because the judge got stricter. Mitigation: pin the judge model version explicitly (already done in the eval config); revisit when the model retires.
