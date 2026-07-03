# Eval methods

## Subtitle

Rubric-based LLM-as-judge / criteria-scored evaluation — Industry standard.

## Zoom out, then zoom in

blooming's eval method is **LLM-as-judge over a rubric**. Two rubrics: `eval/rubrics/diagnosis-quality.ts` and `eval/rubrics/recommendation-quality.ts`. Each has 4 dimensions on a 5-point scale, and each judgment produces one of 3 verdicts: `pass`, `fail`, `unclear`. The judge is Sonnet (same family as the agents); the position/verbosity biases are addressed by shuffling order and capping length. The baseline reports per-dimension pass rates.

```
  Zoom out — where evaluation lives

  ┌─ eval/goldens/ ─────┐    ┌─ eval/rubrics/ ─────────┐
  │  10 cases            │    │  2 rubrics × 4 dims × 5 │
  │  (input to eval)    │    │  scale × 3 verdicts     │
  └──────────┬───────────┘    └──────────┬──────────────┘
             │                            │
             └──────────┬─────────────────┘
                        │
                        ▼
  ┌─ eval/run.eval.ts ★ ─────────────────────────────────┐ ← we are here
  │  · run agents on each case                            │
  │  · judge output against rubric                         │
  │  · write per-case receipt                              │
  │  · aggregate (report.eval.ts) or gate (gate.eval.ts)   │
  └──────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** golden case → agent → judgment → verdict → receipt → aggregate. Six bands.
- **Axis: reliability.** Each layer either boosts or degrades the eval's signal. LLM-as-judge is noisier than exact-match but scales beyond it.
- **Seam:** the rubric itself. The 4-dimension structure is the contract every judgment shares.

## How it works

### Move 1 — the mental model

The ladder of eval methods:

```
  Eval method ladder — cheap → expensive

  ┌──────────────────────┬──────────────────────────────┐
  │ Method               │ When to use                  │
  ├──────────────────────┼──────────────────────────────┤
  │ Exact match          │ Classifiers, structured out, │
  │                      │ IDs                          │
  ├──────────────────────┼──────────────────────────────┤
  │ Fuzzy match          │ Text with acceptable variance│
  ├──────────────────────┼──────────────────────────────┤
  │ Rubric (LLM-judge)   │ Quality of generated text —  │
  │                      │ where blooming lives         │
  ├──────────────────────┼──────────────────────────────┤
  │ Pairwise             │ Comparing two variants       │
  ├──────────────────────┼──────────────────────────────┤
  │ Human eval           │ Highest signal, low scale    │
  └──────────────────────┴──────────────────────────────┘
```

blooming's diagnoses and recommendations are open-ended text — exact match wouldn't fit. Rubric-scored is the right rung.

### Move 2 — the step-by-step walkthrough

**The rubric shape.** `eval/rubrics/diagnosis-quality.ts:16` — `RubricDefinition` from `@aptkit/core`:

- `id`, `title`, `task` (English description of what's being scored)
- `dimensions[]` — 4 dimensions per rubric

Each dimension has an `id`, `label`, `description`, and `scale: { score, description }[]` (1–5 with descriptions for each score).

**Diagnosis rubric dimensions.**

1. `root_cause_plausibility` — does the conclusion name a mechanism, not a symptom restatement? (Score 1 = "restates the symptom"; score 5 = "specific mechanism with rival mechanisms considered")
2. `evidence_grounding` — does the diagnosis cite actual signals from the substrate?
3. `scope_coherence` — does it stay within the anomaly's stated scope?
4. `actionable_next_step` — does it hint at what to look at next? **(baseline pass rate: 0% — systemic prompt gap)**

**Recommendation rubric dimensions.**

1. `diagnosis_response` — does the rec address the diagnosed root cause? (**baseline pass rate: 48% — the case-01+08 failure**)
2. `feature_choice_fit` — is the Bloomreach feature (scenario / segment / campaign / voucher / experiment) appropriate?
3. `step_actionability` — are the steps concrete?
4. `impact_realism` — is the estimated impact grounded?

**The judge call.** `RubricJudge` from `@aptkit/core` takes the rubric + the agent output + the golden context; internally uses tool-calling to force the judge model to emit `{ verdict, dimensions: [{ id, score, rationale }] }` in a schema-checked shape. `max_tokens = 4096` (bumped from the default to prevent mid-JSON truncation on long recs).

**Judge-error resilience.** On parse failure, `eval/run.eval.ts` catches the error and writes a `judge_error` placeholder into the receipt instead of crashing the run. The count of `judge_error` in a run is itself a signal — if it rises, the token cap is too low or the rubric is overly complex.

**Verdict from dimensions.** A "pass" verdict on the whole judgment requires all dimensions score ≥ 3 (empirically calibrated; see **03-llm-as-judge-bias.md**). "Unclear" is used when the judge's rationale contradicts its own scores (a rare failure mode). "Fail" when any dimension < 3.

Diagram of one case's judgment path:

```
  One case's judgment — layers-and-hops

  golden case ─►  DiagnosticAgent.investigate  ─►  Diagnosis
                                                    │
                                                    ▼
                                              RubricJudge (Sonnet)
                                              rubric = diagnosis-quality
                                                    │
                                                    ▼
                                              { verdict: "pass",
                                                dimensions: [
                                                  { id: "root_cause_plausibility",
                                                    score: 4, rationale: "..." },
                                                  { id: "evidence_grounding",
                                                    score: 3, rationale: "..." },
                                                  ...
                                                ] }
                                                    │
                                                    ▼
                                              write eval/receipts/<runId>-01.json
```

### Move 3 — the principle

Rubric-scored LLM-as-judge is the right rung on the ladder for open-ended text. It's noisier than exact-match but scales; the noise is bounded by good rubric design (specific dimensions with anchored scale descriptions). Calibrate against blind human scoring before trusting the numbers.

## Primary diagram

```
  Eval method — full frame

  ┌─ Golden case ──────────────────────────────────────────┐
  │  anomaly + intent + knownCorrect                        │
  └────────────────────┬───────────────────────────────────┘
                       │
                       ▼
  ┌─ Agent runs ───────────────────────────────────────────┐
  │  DiagnosticAgent → Diagnosis                            │
  │  RecommendationAgent → Recommendation[]                 │
  └────────────────────┬───────────────────────────────────┘
                       │
                       ▼
  ┌─ Judge runs (LLM-as-judge) ────────────────────────────┐
  │  RubricJudge(rubric, output, context) →                 │
  │    { verdict, dimensions: [{ score, rationale }] }      │
  │  Sonnet judge; max_tokens=4096; judge_error resilience   │
  └────────────────────┬───────────────────────────────────┘
                       │
                       ▼
  ┌─ Receipt written ──────────────────────────────────────┐
  │  eval/receipts/<runId>-<caseId>.json                    │
  │  contains: verdicts, per-dim scores, per-phase latency, │
  │            per-phase tokens + cost                      │
  └────────────────────┬───────────────────────────────────┘
                       │
                       ▼
  ┌─ Aggregate: report.eval.ts / gate.eval.ts ─────────────┐
  │  · per-dim pass rate across cases                       │
  │  · p50/p95/p99 latency + $ per case                     │
  │  · gate: block if any dim drops >10pp vs baseline       │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

LLM-as-judge became the industry standard around 2023 as human labeling scaled poorly. The tradeoff: bias (see **03-llm-as-judge-bias.md**) for scale + repeatability. Good rubric design keeps bias bounded; blind calibration keeps you honest.

The 4-dim × 5-scale × 3-verdict shape is characteristic. Fewer dimensions (1–2) collapses too much information; more (6+) makes each judgment call too heavy and increases token cost per judgment. Blooming's 4-dim design is empirically calibrated.

Related: **03-llm-as-judge-bias.md** (mitigating judge biases), **04-llm-observability.md** (the receipts pipeline), **../01-llm-foundations/04-structured-outputs.md** (the tool-schema constraint that makes judgment output well-formed).

## Project exercises

### B5.2 · Add pairwise eval for prompt-tuning experiments

- **Exercise ID:** B5.2 (Case B — not yet implemented)
- **What to build:** New `eval/pairwise.eval.ts` that takes two prompt variants (e.g., `diagnostic-v1` vs `diagnostic-v2`) and runs each against the goldens; a judge scores which output is better per case (with position-shuffling to avoid position bias); reports win rate + tie rate.
- **Why it earns its place:** Rubric evals answer "is this good enough"; pairwise answers "is this *better*." Prompt tuning needs pairwise.
- **Files to touch:** New `eval/pairwise.eval.ts`, extend `eval/rubrics/` with a comparative rubric, wire into `package.json` as `npm run eval:pairwise`.
- **Done when:** running the pairwise eval on the current diagnostic prompt vs a modified prompt reports win rate + tie rate + verdict distribution.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: Why 4 dimensions per rubric and not more?**

Each dimension is a judgment call — more dimensions = more tokens per judgment, more chances for judge inconsistency, more scores to interpret. Four is where the signal-per-judgment stays high without token cost exploding. If a fifth dimension emerges as load-bearing (say, "citation accuracy"), I'd add it; adding for its own sake dilutes.

**Q: What does `judge_error` mean in the receipts?**

Judge output failed schema validation, typically because it hit the `max_tokens = 4096` cap mid-JSON. The receipt records a `judge_error` placeholder; the run doesn't crash. In practice: bumping `max_tokens` to 4096 dropped judge_error rate from ~10% to ~1% (empirical). Load-bearing: it's a real production concern for any LLM-as-judge setup.

## See also

- [01-eval-set-types.md](01-eval-set-types.md) — the inputs.
- [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md) — the reliability layer.
- [04-llm-observability.md](04-llm-observability.md) — the output layer.
