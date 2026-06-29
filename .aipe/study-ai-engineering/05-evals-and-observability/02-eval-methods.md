# Eval methods

*Industry standard — exact match · fuzzy · rubric · LLM-as-judge · pairwise · human*

## Zoom out — where this concept lives

Once you have an eval set (`01-eval-set-types.md`), you need a scoring method. Six standard methods, ordered cheap-to-expensive. The retired Phase 3 suite leaned on **LLM-as-judge** because the agents emit prose (diagnoses, recommendations) that exact-match couldn't score. The next iteration will mix exact-match (for structured fields) + LLM-as-judge (for prose) + human spot-check (for calibration).

```
  Zoom out — methods, cheap to expensive

  cheap, automated                          expensive, high-signal
   ────────────────                          ──────────────────────
   exact match  →  fuzzy match  →  rubric  →  LLM-as-judge  →  pairwise  →  human eval

   What this codebase needs:
    - exact match on structured fields (metric, scope, severity)
    - LLM-as-judge on prose (conclusion, rationale)
    - human spot-check to calibrate the judge (Phase 3 used 8/8 + 3/3)
```

**Zoom in.** Cheap methods scale; expensive methods anchor. The Phase 3 suite's LLM-as-judge wasn't trusted blindly — it was calibrated against a small manual spot-check (8 of 8 + 3 of 3 agreed), then trusted at scale.

## Structure pass — layers · axes · seams

**Layers:** agent output → scoring method → score → aggregated result.

**Axis: cost vs signal.** Exact match: cheap, low signal (only works for byte-identical outputs). Human eval: expensive, highest signal. LLM-as-judge: in between, requires calibration.

**Seam:** the choice of method per *field*. Same eval set can use exact-match for `metric`, rubric for `conclusion`, LLM-as-judge for `rationale`. One eval, multiple methods.

## How it works

### Move 1 — the mental model

You know how a test assertion can be `===` (exact), `toMatch(regex)` (loose), or `toMatchSnapshot()` (rubric-like)? Same shape — different assertion strengths for different field shapes.

```
  Methods at a glance

  ┌──────────────────────┬──────────────────────────────────────┐
  │ Method               │ Use when                             │
  ├──────────────────────┼──────────────────────────────────────┤
  │ Exact match          │ Structured outputs (enum, ID,        │
  │                      │  scoped tuple). Score: 0/1           │
  │                      │ Example: metric == 'revenue_drop'    │
  ├──────────────────────┼──────────────────────────────────────┤
  │ Fuzzy match          │ Prose where wording varies but        │
  │                      │  semantics shouldn't                  │
  │                      │ Example: BLEU-style overlap on        │
  │                      │  expected keywords                    │
  ├──────────────────────┼──────────────────────────────────────┤
  │ Rubric               │ Multi-criteria scoring (tone,         │
  │                      │  accuracy, structure)                  │
  │                      │ Example: human rates each on 1-5      │
  │                      │  Likert per dimension                  │
  ├──────────────────────┼──────────────────────────────────────┤
  │ LLM-as-judge         │ Scalable rubric. LLM scores using    │
  │                      │  the same rubric a human would.      │
  │                      │ Cheap; biased; needs calibration     │
  │                      │  (see 03-llm-as-judge-bias.md)       │
  ├──────────────────────┼──────────────────────────────────────┤
  │ Pairwise             │ "Is A better than B?" for             │
  │                      │  comparing prompt or model variants  │
  ├──────────────────────┼──────────────────────────────────────┤
  │ Human eval           │ Calibration gold standard.            │
  │                      │  Slow; doesn't scale; the anchor for  │
  │                      │  every cheaper method                 │
  └──────────────────────┴──────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Part 1 — what the retired Phase 3 suite used.**

  → **Detection pillar.** Exact-match on `metric` (did the agent find the right anomaly?). Exact-match on `scope` (did it localize to the right country/segment?). Threshold check on `change.value` (did it report the right magnitude?).
  → **Diagnosis pillar.** LLM-as-judge with a rubric:
    - Did the conclusion identify the *right cause*?
    - Did the evidence cite the *correct tool results*?
    - Did the hypotheses considered include the *actual cause* as one of them?
    Each rated 1-5. Aggregate score = mean.
  → **Recommendation pillar.** LLM-as-judge with a rubric:
    - Is the proposed Bloomreach feature appropriate?
    - Are the steps actionable?
    - Is the estimated impact plausible?
  → **Regression pillar.** Per-bug exact-match assertions (e.g. "AOV must not exceed R$10,000 in BRL workspace").

LLM-as-judge for both diagnosis and recommendation = ~30 LLM-judge calls per K=10 run (3 dimensions × 10 runs). At Sonnet judge cost ≈ $0.05 per call, ~$1.50 per pillar per K=10 run. Not free, not breaking the bank.

**Part 2 — the calibration that made LLM-as-judge trusted.**

8/8 + 3/3 manual spot-check: 8 random samples from the diagnosis pillar were manually scored by a human; LLM-as-judge agreed on all 8. 3 random samples from the recommendation pillar; agreed on all 3. Trust threshold met; full eval ran with LLM-as-judge.

This isn't "the LLM is always right"; it's "the LLM agrees with the human on the cases we checked, so trust it for the cases we don't have time to check." Calibration is the *only* way to make LLM-as-judge defensible.

**Part 3 — what the next iteration needs.**

```
  Per-field method choice for the next eval iteration

  ┌────────────────────────────┬──────────────────┬─────────────────────┐
  │ Field                      │ Method            │ Why                 │
  ├────────────────────────────┼──────────────────┼─────────────────────┤
  │ Anomaly.metric             │ Exact match       │ Enum, byte-identical│
  │ Anomaly.scope[]            │ Exact match       │ Set equality        │
  │ Anomaly.severity           │ Exact match       │ Enum                │
  │ Anomaly.change.direction   │ Exact match       │ Enum                │
  │ Anomaly.change.value (±)   │ Threshold (±10%)  │ Fuzzy ≈             │
  ├────────────────────────────┼──────────────────┼─────────────────────┤
  │ Diagnosis.conclusion       │ LLM-as-judge      │ Prose, semantic     │
  │ Diagnosis.evidence[]       │ LLM-as-judge      │ Multi-sentence list │
  │ Diagnosis.hypotheses[]     │ LLM-as-judge      │ Same as above       │
  ├────────────────────────────┼──────────────────┼─────────────────────┤
  │ Recommendation.feature     │ Exact match       │ Enum                │
  │ Recommendation.title       │ LLM-as-judge      │ Prose               │
  │ Recommendation.steps[]     │ LLM-as-judge      │ Actionability       │
  │ Recommendation.confidence  │ Distribution check│ NOT exact — measure │
  │                            │ across K=30 runs  │  calibration spread │
  └────────────────────────────┴──────────────────┴─────────────────────┘
```

**Part 4 — pairwise for prompt iteration.**

Pairwise eval is best when iterating on the agent's prompt. Question becomes "is prompt-v2 better than prompt-v1 on the same input?" instead of "does prompt-v2 hit some absolute quality bar?" Pairwise is more reliable than absolute scoring because the judge only has to compare, not measure. Phase 3 didn't use pairwise; the next iteration probably should for prompt revisions.

### Move 3 — the principle

**Pick the method per field, not per eval.** Exact match for structured; LLM-as-judge for prose; threshold for numeric near-equality; pairwise for variant comparison. The eval framework that ships with this codebase eventually should accept all of them and let each field declare its method.

## Primary diagram — the full recap

```
  Eval methods for this codebase, per field

  Anomaly output:
   ┌─ metric          ─ exact match          (enum)
   ├─ scope[]         ─ exact match          (set equality)
   ├─ severity        ─ exact match          (enum)
   ├─ change.dir      ─ exact match          (enum)
   └─ change.value    ─ threshold (±10%)     (fuzzy numeric)

  Diagnosis output:
   ┌─ conclusion      ─ LLM-as-judge         (prose rubric)
   ├─ evidence[]      ─ LLM-as-judge         (citation accuracy)
   └─ hypotheses[]    ─ LLM-as-judge         (coverage rubric)

  Recommendation output:
   ┌─ feature         ─ exact match          (enum)
   ├─ title           ─ LLM-as-judge         (prose)
   ├─ steps[]         ─ LLM-as-judge         (actionability)
   └─ confidence      ─ distribution check   (calibration over K runs)

  Cross-field:
   ─ Prompt iteration ─ pairwise             (v2 vs v1)
   ─ Calibration       ─ human spot-check    (anchor for LLM-as-judge)
```

## Elaborate

**Why LLM-as-judge needs the human anchor.** LLM-as-judge alone is cheap but biased (position, verbosity, self-preference — see `03-llm-as-judge-bias.md`). Without a small manual spot-check (Phase 3 used 8/8 + 3/3), you have no way to know if the judge's scores are tracking real quality or some bias artifact. The anchor is what makes the judge defensible.

The discipline: every time you change the rubric, re-run the human spot-check. The judge can drift; the human check catches the drift.

**Why exact match for `feature` even though it's prose-adjacent.** `Recommendation.bloomreachFeature` is a typed enum (`'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment'`). The agent emits one of these or it's structurally wrong. Exact match is the right method — no rubric needed.

The pattern: any field with a finite, typed set of valid values gets exact match. Any field with prose gets LLM-as-judge (with rubric and calibration). Numeric fields get threshold-fuzzy. Don't reach for the expensive method where the cheap one suffices.

**The pairwise trap to avoid.** Pairwise eval can mislead if you compare against a weak baseline. "v2 is better than v1" is meaningless if v1 was already bad — you need an *absolute* anchor (golden set) somewhere in the loop. Use pairwise for iteration, golden for grounding.

## Project exercises

### Exercise — Multi-method eval runner with per-field method declarations

  → **Exercise ID:** B5.2
  → **What to build:** Build the `eval/run.ts` from `B5.1` (in `01-eval-set-types.md`) to accept a per-field method declaration: `{ field: 'Anomaly.metric', method: 'exact-match' }`, `{ field: 'Diagnosis.conclusion', method: 'llm-judge', rubric: {...} }`, etc. Use the right method for each field; aggregate scores into a per-anomaly + overall report.
  → **Why it earns its place:** lets one eval suite cover both structured outputs (exact match) and prose (LLM-as-judge) without bolting two separate runners together. Forces the runner to be method-agnostic, which makes adding pairwise or threshold methods cheap later.
  → **Files to touch:** `eval/run.ts` (the runner), new `eval/methods.ts` (the method implementations), `eval/seeds.ts` (the per-field declarations alongside expected outputs), `eval/judge.ts` (the LLM-judge implementation with rubric support).
  → **Done when:** running `npm run eval` produces a report showing per-field method + score, the LLM-judge calls go through the existing `BloomreachDataSource` rate-limit machinery (don't re-implement), and the report distinguishes between "exact-match fail" and "LLM-judge low score" so a regression is debuggable.
  → **Estimated effort:** ≥1 week.

## Interview defense

**Q: "How do you score your agent's outputs?"**

Method per field. Structured fields (`metric`, `severity`, `bloomreachFeature`) use exact-match — they're typed enums. Numeric fields with tolerance (`change.value`) use threshold-fuzzy (±10%). Prose fields (`conclusion`, `rationale`, recommendation steps) use LLM-as-judge with a rubric, calibrated against a small human spot-check (Phase 3 used 8/8 + 3/3 — manual check matched LLM-judge on all of them). For calibration itself (e.g. `confidence` distribution), distribution checks across K runs.

Don't reach for LLM-judge where exact match works; don't trust LLM-judge without the human anchor.

*Anchor: "Per-field method; LLM-judge needs human calibration; the Phase 3 8/8 + 3/3 is the template."*

**Q: "What did Phase 3's LLM-as-judge cost?"**

Roughly $1.50 per pillar per K=10 run, judging at the Sonnet rate. For the 4 pillars × K=10 × 3 seeded anomalies, the per-iteration cost was around $20-30. Not free, not breaking the bank — eval is real money but tractable relative to the value of catching conclusion instability and binary calibration before they reach users.

The next iteration will use the same shape — LLM-judge at Sonnet, calibrated by spot-check, same cost order. Maybe lower if I use Haiku as judge for the simpler rubric items; that's a tradeoff between cost and judge-bias.

*Anchor: "$20-30 per full Phase 3 iteration; comparable for next; Haiku-as-judge for cheap rubric items is a tradeoff."*

## See also

  → `01-eval-set-types.md` — the eval sets these methods score
  → `03-llm-as-judge-bias.md` — the bias modes the calibration is defending against
  → `04-llm-observability.md` — the telemetry that complements eval (different but related)
