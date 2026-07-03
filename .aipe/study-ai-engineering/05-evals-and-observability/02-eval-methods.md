# 02 — Eval methods

**Type:** Industry standard. Also called: eval strategy, scoring methodology.

## Zoom out, then zoom in

The ladder from exact-match to human-eval. This repo uses rubric-based LLM-as-judge with 4 dimensions × 1-5 scale × 3 verdicts.

```
  Zoom out — the ladder (cheap → expensive → precise)

  exact match          → free, brittle
  fuzzy match          → cheap, sloppy
  rubric (LLM-judge)   → cheap-ish, structured  ← ★ THIS CODEBASE ★
  pairwise (A/B)       → cheap, comparative
  human eval           → gold standard, doesn't scale
```

Zoom in. Rubric-based LLM-as-judge is the sweet spot for LLM output scoring at this scale — structured (4 dims), scalable (LLM does the work), and measurable enough that regression detection works (baseline.json + gate.eval.ts). The two rubrics live in `eval/rubrics/`.

## Structure pass

Axis: cost per judgment vs signal per judgment.
- Exact match: near-free per, near-zero signal on generated text
- Rubric-LLM-judge: ~$0.04 per judgment, structured signal across dims
- Human: hours per judgment, high signal

**Seam:** the rubric definition. Above: the judgment call. Below: whatever mechanism scores it (LLM, human, exact-match check).

## How it works

### Move 1

You've picked between assertion styles — `assertEqual` (exact) vs regex vs custom matcher. Same shape at the eval boundary: pick the scoring method that matches the shape of your outputs.

```
  The ladder — pick by output shape

  classifier out {A, B, C}     → exact match
  ID or number                  → exact match
  short generated text          → fuzzy (BLEU, ROUGE) or LLM judge
  long structured output        → rubric with dims
  qualitative preference        → pairwise or human eval
```

### Move 2

**The two rubrics.**

- `eval/rubrics/diagnosis-quality.ts` — 4 dims × 1-5 scale × 3 verdicts.
- `eval/rubrics/recommendation-quality.ts` — same shape, different dims.

Each dim has: `{id, label, description, scale: [{score: 1-5, description}]}`. Verdicts: `pass` (all dims ≥4), `pass_with_notes` (any dim = 3), `fail` (any dim ≤ 2).

Diagnosis dims:
- `root_cause_plausibility` — does the conclusion name a plausible mechanism?
- `evidence_grounding` — does it cite actual signals from the tool results?
- `scope_coherence` — does it stay in the anomaly's scope?
- `actionable_next_step` — is there a specific named next action?

Recommendation dims:
- `diagnosis_response` — does the rec address the root cause?
- `feature_choice_fit` — is `bloomreachFeature` the right lever?
- `step_actionability` — are steps executable, not aspirational?
- `impact_realism` — is `estimatedImpact` proportional?

**The judge.**

`RubricJudge` from `@aptkit/core`. Takes a rubric + subject text + context object. Emits `{dimensions, verdict, fix, reasoning}`. In this repo, ~$0.04 per judgment at `temperature: 0`, `maxTokens: 4096`.

**How the judge is invoked (`eval/run.eval.ts:229-247`):**

```typescript
const diagnosisJudge = new RubricJudge({
  model: judgeModel,
  rubric: diagnosisQualityRubric,
  capabilityId: 'blooming.eval.diagnosis-judge',
  maxTokens: 4096,
  temperature: 0,
});
const result = await diagnosisJudge.judge({
  subject: JSON.stringify(diagnosis, null, 2),
  context: {
    anomaly: JSON.stringify(anomaly, null, 2),
    known_correct_shape: JSON.stringify(goldenCase.knownCorrect, null, 2),
    case_intent: goldenCase.intent,
    signal_class: goldenCase.signalClass,
    tool_calls_trace: formatToolCallTrace(diagnosisToolCalls),
  },
});
```

Notice the `tool_calls_trace` context — the judge sees not just the diagnosis but WHAT TOOL CALLS produced it. That means the `evidence_grounding` dim can verify that cited numbers are traceable to actual tool results.

**Judge-error handling.**

When RubricJudge returns `{ok: false}`, `eval/run.eval.ts:334-339` writes a `judge_error` placeholder. See `01-llm-foundations/04-structured-outputs.md` — structured output failures are the failure mode. In the baseline run, 6/10 diagnosis judgments returned `judge_error` (the model produced JSON the aptkit runtime couldn't parse within maxTokens). The placeholder pattern prevents these from crashing the run.

### Move 3

Match the method to the output shape. Exact match for classifiers, rubric for generative outputs, pairwise for A/B, human for anything subjective. Don't use exact match on generated text and call it "eval failed" when the model paraphrased.

## Primary diagram

```
  Rubric-based LLM-as-judge — this codebase

  ┌─ Input to judge ──────────────────────────────────────────────────┐
  │  subject:  JSON.stringify(diagnosis, null, 2)                     │
  │  context:                                                          │
  │    - anomaly                                                       │
  │    - knownCorrect (golden case guidance)                          │
  │    - signalClass                                                   │
  │    - tool_calls_trace  ← judge can trace claims to real results    │
  └────────────────────────┬──────────────────────────────────────────┘
                           │
  ┌─ Rubric (4 dims × 1-5 × 3 verdicts) ▼─────────────────────────────┐
  │  diagnosisQualityRubric =                                          │
  │    dimensions: [                                                   │
  │      {id: 'root_cause_plausibility', label, scale: [{1..5}]},      │
  │      {id: 'evidence_grounding', ...},                              │
  │      {id: 'scope_coherence', ...},                                 │
  │      {id: 'actionable_next_step', ...},                            │
  │    ]                                                               │
  │    verdicts: [pass, pass_with_notes, fail]                        │
  │    checks: [...binary checks]                                     │
  └────────────────────────┬──────────────────────────────────────────┘
                           │
  ┌─ Judge output ─────────▼──────────────────────────────────────────┐
  │  {                                                                 │
  │    dimensions: {                                                   │
  │      root_cause_plausibility: {score: 4, reason: "…"},             │
  │      evidence_grounding:      {score: 3, reason: "…"},             │
  │      scope_coherence:         {score: 4, reason: "…"},             │
  │      actionable_next_step:    {score: 2, reason: "…"},             │
  │    },                                                              │
  │    verdict: 'fail',   // ← any dim ≤ 2                             │
  │    fix: "add a specific next action",                              │
  │    reasoning: "…",                                                 │
  │  }                                                                 │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

Rubric-based scoring has three big advantages over pass/fail eval:
1. **Structured signal.** Per-dim scores tell you WHICH dimension is weak, not just "it failed."
2. **Regression at dim granularity.** `baseline.json` tracks per-dim pass rates, so a regression in `evidence_grounding` alone can gate the PR without hiding it in an overall pass rate.
3. **Judge disagreement is localized.** Two judges disagreeing on one dim is a smaller issue than disagreeing on overall verdict.

Common alternatives: **BLEU / ROUGE** (n-gram overlap; useful for translation, worthless for divergent-answer eval); **LLM-as-judge on overall quality only** (loses per-dim signal); **pairwise ranking** (works when you have a baseline to compare against).

## Project exercises

### Exercise — pairwise A/B eval for prompt tweaks

- **Exercise ID:** C3.2-B · Case B (rubric exercised; pairwise not).
- **What to build:** for each golden case, run the diagnostic agent with prompt version A vs prompt version B. Present both diagnoses to a third-party judge, ask "which is better and why?". Prompts iterate faster with pairwise than with absolute rubric scores — the judge doesn't have to calibrate.
- **Why it earns its place:** rubric is for measuring absolute quality; pairwise is for comparing changes. Both have their place.
- **Files to touch:** `eval/pairwise.eval.ts` (new), `eval/rubrics/pairwise.ts` (new pairwise rubric).
- **Done when:** running `npm run eval:pairwise` on 5 goldens produces a per-case A vs B verdict, useful for prompt-iteration decisions.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Why rubric instead of exact match?**

Because diagnosis output is generated prose + structured JSON. Exact match on the conclusion sentence never passes — the model paraphrases, and paraphrase isn't wrong. Rubric-based scoring measures WHAT MATTERS (plausibility, evidence grounding, scope, actionability) without punishing legitimate variation.

**Q: What are the rubric dims?**

Four per rubric. Diagnosis: root_cause_plausibility, evidence_grounding, scope_coherence, actionable_next_step. Recommendation: diagnosis_response, feature_choice_fit, step_actionability, impact_realism. Each dim is scored 1-5 with description per score. Verdict is derived: pass if all ≥4, pass_with_notes if any = 3, fail if any ≤ 2.

**Q: How does the judge see the tool calls?**

Passed as context. `tool_calls_trace` is a formatted trace of `--- call N: tool_name --- args: … result: …` per line. That means the `evidence_grounding` dim can verify that numbers cited in the diagnosis actually appear in the tool results. Without the trace, the judge would score `evidence_grounding` on prose plausibility alone.

## See also

- `01-eval-set-types.md` — what gets scored
- `03-llm-as-judge-bias.md` — what the judge can get wrong
- `04-llm-observability.md` — the receipt structure the judgment lands in
- `eval/rubrics/` — the two rubrics
- `eval/run.eval.ts` — the invocation
