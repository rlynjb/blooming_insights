# production-grade study plan — reading path

> Companion to `blooming-insights-production-grade-plan.md`. Each week's reading is
> the study material you need *before* (or alongside) executing that week's phase.
> Check items off as you go; add notes inline as you read.
>
> Path roots:
> - **blooming study** → `.aipe/study-*/` (domain-anchored to this repo)
> - **aptkit source** → `/Users/rein/Public/aptkit/` (the engine you're wiring)

---

## Week 1 — Learn the seam, prove ONE case  ✅ *implemented (`e511171`)*

Reading list named in the plan's Week 1 block, ordered how to actually read it.

### Required

**1. The *why* / mental model — read first**
`.aipe/study-ai-engineering/05-evals-and-observability/` (in its stated order):

- [ ] `01-eval-set-types.md` — golden / adversarial / regression sets
- [ ] `02-eval-methods.md` — rubric & LLM-as-judge (what `eval/rubrics/diagnosis-quality.ts` *is*)
- [ ] `03-llm-as-judge-bias.md` — position / verbosity / self-preference bias + the calibration discipline (8/8 + 3/3) rebuilt in Week 2
- [ ] `04-llm-observability.md` — traces / spans / replay (sets up Weeks 2–3)

> Domain-anchored to *this* repo's eval history (retired Phase 3; the BRL / calibration / instability bugs). Fastest way to defend the harness cold.

**2. The engine you're wiring — *how it scores***
- [ ] `/Users/rein/Public/aptkit/packages/evals/src/rubric-judge.ts` (244 LOC) — the `RubricJudge` that `eval/run.eval.ts` calls. Same code imported via `@aptkit/core`.

**3. The template your runner copies — *the shape***
- [ ] `/Users/rein/Public/aptkit/packages/agents/rag-query/scripts/eval.ts` — canonical pattern (labeled eval + K value + `scorePrecisionAtK` / `scoreRecallAtK`). Where `eval/run.ts` grows to in Week 2.

### Worth adding (adjacent, not named)

- [ ] `.aipe/study-prompt-engineering/05-eval-driven-iteration.md` — the "pass rates gate prompt changes" loop, which is Week 1's whole point
- [ ] `.aipe/study-prompt-engineering/02-structured-outputs.md` — maps to the receipt's "judge attempts: 1 (clean structured output)"

---

## Week 2 — Golden set + rubrics (Phase 1 complete)  *in progress*

Reading to sharpen the decisions this week forces: how to build a representative
golden set against a static substrate, and how to run a defensible calibration
slice. Both drive real choices that were parked at the end of Week 1
(`e511171`) — see the two-question decision block in the ship log.

### Sessions

- [x] **A — Fix judge context** ✅ *implemented (`b95fe56`)*
      Capture tool-call trace via `hooks.onToolResult`, pass to judge as
      `tool_calls_trace` context. Fixed Week-1 evidence_grounding false
      positive (4→5). Sub-finding: judge caught a real `SyntheticDataSource`
      quirk (`get_event_segmentation` returns identical geo-breakdowns
      regardless of `event` arg) — the eval surfaces the substrate
      limitation as scoring pressure.
- [x] **B — Recommendation rubric** ✅ *implemented (`a2efe57`)*
      Added `eval/rubrics/recommendation-quality.ts` (4 dims: diagnosis_response,
      feature_choice_fit, step_actionability, impact_realism). Runner does
      two-phase judging: diagnose → judge diagnosis; recommend → judge each
      rec independently. Recommendation judge also gets the recommendation
      agent's own tool-call trace as context. Session B's run: 3 recs, all
      `pass_with_notes`; judge caught rec 3 (win-back campaign)
      re-engaging abandoners without addressing the payment-processor
      root cause. Side observation for Session D: root_cause_plausibility
      came back 5 here but 4 on Session A — same anomaly, same substrate.
      Conclusion-stability variance is real and measurable.
- [x] **C — Expand goldens to 10** ✅ *implemented (`b23558d`)*
      10 goldens shipped (has-signal / partial-signal / no-signal / positive
      classes); runner uses `it.each()` + `afterAll()` aggregator per Q1's
      design. Also shipped judge-error resilience (maxTokens 2048 → 4096,
      failure produces a `judge_error` placeholder rather than throwing) and
      a signal-class-aware gate.
      **Findings**:
      · **Escape hatch TRIGGERED** — 3 of 4 diagnosis dimensions had <3
        distinct pass/fail scores across 10 cases. Substrate too
        homogeneous; propose `SyntheticDataSource` expansion as its own
        PR per Q1 option (c).
      · Two systemic prompt gaps for Week 3: `actionable_next_step`
        scored 3/5 on 100% of diagnoses; `feature_choice_fit` scored
        3/5 on 50% of recs.
      · Rec anti-pattern: agent proposes "pause the A/B experiment" as
        a rec on has-signal cases where the primary root cause is the
        payment processor. Judged as `fail` (correctly) on cases 01 + 08.
- [ ] **D — Blind calibration** (protocol per Q2 decision — you score blind)
      I generate `eval/calibration/worksheet-<runId>.json` (anomaly +
      diagnosis, no judgment). You score 4 dimensions × 10 cases (~30–60
      min). Only after you commit labels do I reveal judge scores and
      compute agreement per dimension + per verdict.

### Required

**1. Golden-set design + LLM-as-judge failure modes — load-bearing for the Week 2 decisions**
`.aipe/study-ai-engineering/05-evals-and-observability/` (re-read if Week 1 skipped):

- [ ] `01-eval-set-types.md` — golden-set representativeness; when a
      static substrate is honest vs. theater; what "no-signal" cases
      teach (the ones where the substrate can't support the anomaly
      and the agent should say "insufficient evidence")
- [ ] `03-llm-as-judge-bias.md` — why blind labeling matters for the
      calibration number to be defensible; what agreement measures;
      the 8/8 + 3/3 discipline being rebuilt against Synthetic

**2. The template — its `for (const case of goldens)` shape**
- [ ] `/Users/rein/Public/aptkit/packages/agents/rag-query/scripts/eval.ts` —
      where `eval/run.eval.ts` grows to when we iterate over N cases and
      aggregate per-criterion pass rates. Same template Week 1 pointed at,
      re-read for the iteration + aggregation structure this time.

### Optional — interview framing

- [ ] `.aipe/rehearse-problem-selection/04-success-metrics-and-feedback-loop.md` —
      how the calibration number gets defended in the room ("shipped,
      calibrated 8/8 + 3/3, retired with substrate, next version against
      Synthetic")

### Live decisions this reading unblocks

Two questions Week 1 parked, waiting on this reading:

- **Golden-set expansion approach** — work within the static substrate, or
  expand `SyntheticDataSource` (frozen-core touch)? `01-eval-set-types.md`
  is where the substrate-vs-theater tradeoff lives.
- **Calibration hand-labels** — you score blind, or I score first? The
  answer depends on how blind-labeling failure modes actually work, which
  is `03-llm-as-judge-bias.md`.

---

## Week 3 — Cost + load evidence (Phases 2, 3, 4)

*Reading to add — usage-ledger, prompt caching, model routing, load + fault injection.*

- [ ] _tbd_

---

## Week 4 — Regression gate + ship (Phases 5, 6)

*Reading to add — baseline-vs-candidate gate, replay-runner, CI.*

- [ ] _tbd_
