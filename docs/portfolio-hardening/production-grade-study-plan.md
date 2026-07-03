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
- [x] **D — Blind calibration** — pipeline shipped; PILOT (AI-vs-AI) run
      complete; real human blind pass still pending
      Part 1 (tooling) ✅ — `eval/generate-worksheet.eval.ts` +
      `eval/compute-agreement.eval.ts` + `eval/calibration/README.md`,
      npm scripts `eval:worksheet` and `eval:agreement`.

      Part 2 (labeling) — **PILOT run only (AI-vs-AI)** — I filled the
      worksheet with `labelerMode: pilot-ai-vs-ai` after user opted
      into the "validate the pipeline, redo with real labels later"
      path. Both labeler and judge are Claude; this measures rubric
      self-consistency, NOT judge-vs-human agreement. Receipt is
      stamped with an explicit `pilotWarning` field to prevent
      accidental interview use.

      Part 3 (agreement) ✅ — `eval/calibration/agreement-<runId>.json`
      emitted. Real numbers from the pilot:
      · Verdict agreement:       6/6 (100%)   — 4 no-judge cases skipped
      · Exact-match dimensions:  13/24 (54%)
      · Within-1 dimensions:     24/24 (100%) — no delta > 1
      · Direction of disagreement: judge skews warmer on
        `root_cause_plausibility` and `evidence_grounding`
      · `actionable_next_step`   scored 3 across all cases (both sides)
        — locks in the top Week-3 prompt-improvement target

      Real Session D closes when a blind human pass produces a receipt
      with `labelerMode: human`. Deferred until user regenerates
      study materials + revisits with more depth.

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

Reading to sharpen the three decisions this week demands: how to shape
observability without over-instrumenting, which prompt-caching seams
actually pay, and what makes a synthetic load number honest vs. theater.

### Prereq (from Week 2)

Substrate expansion is **not required** for Week 3. Phase 2 (observability)
measures tokens/cost/latency which vary with prompt length + iterations,
not with substrate content. Phase 3 (cost controls) is agent-side. Phase 4
(load + fault injection) gets its variety from varied *input anomalies*
(we have 10 diverse goldens), not from varied *tool responses*. Substrate
expansion becomes load-bearing at Week 5 (regression gate needs signal
variance) or at the real-blind-calibration re-run (better interview
receipt). Defer until then.

### Required

**1. Observability — what to measure, what NOT to instrument**
`.aipe/study-ai-engineering/05-evals-and-observability/`:

- [ ] `04-llm-observability.md` — traces / spans / replay; what a
      production trace-record actually contains; the anti-pattern of
      "instrument everything then debug the instrumentation."
      Load-bearing for Phase 2's `summarizeUsage` + `estimateCost`
      aggregation.

**2. Cost controls — the two levers that pay**
`.aipe/study-ai-engineering/06-production-serving/`:

- [ ] `01-llm-caching.md` — Anthropic cache-control mechanics; what
      cache_creation vs cache_read tokens cost; the "stable prefixes"
      pattern (system prompt + WorkspaceSchema) that pays biggest.
- [ ] `02-llm-cost-optimization.md` — cheap-model routing (Haiku for
      intent / classification / structured extraction) vs. escalation
      to Sonnet for reasoning-hard steps. Which decisions justify the
      escalation cost, and which don't. Also covers the token-budget
      lever (`schemaSummary` in this codebase).
- [ ] `04-rate-limiting-backpressure.md` — re-read the spacing-gate-vs-
      backpressure distinction (already sharp in the codebase's own
      `study-performance-engineering/`) — informs Phase 4's load
      harness pacing.
- [ ] `05-retry-circuit-breaker.md` — relevant for Phase 4's fault
      injection design (what failures a decorator should simulate,
      what recovery patterns already exist in `BloomreachDataSource`).

**3. Load + fault injection**
`.aipe/study-performance-engineering/`:

- [ ] `01-spacing-gate-vs-backpressure.md` — the load-bearing teaching
      point in this repo (`minIntervalMs = 1100` is rate-limit
      compliance, NOT backpressure). Directly relevant to how the
      load harness paces its N-per-second issuance.
- [ ] `05-streaming-perceived-latency.md` — how p50 / p95 / p99 map to
      user-visible experience; when p99 lies (small N, happy-path
      distribution). The plan's warning about "not N happy-path
      copies" lives here.

### Optional — interview framing

- [ ] `.aipe/rehearse-interview-defense/04-the-scale-story.md` — three
      scale scenarios and what breaks first at 10x. The tier-2 story
      Phase 4 arms you to defend.
- [ ] `.aipe/rehearse-design-doc/` — cost controls as RFC shape (once
      Phase 3 ships, its shape becomes an RFC candidate).

### Live decisions this reading unblocks

- **Prompt-cache seam choice** — cache just the system prompt, or also
  the WorkspaceSchema? Cost of a cache miss vs. cache read informs
  the answer; `01-prompt-caching.md` has the math.
- **Model-routing threshold** — where does Haiku stop being enough?
  `02-model-routing.md` names the pattern: cheap-model owns extraction
  and classification; Sonnet owns synthesis. Practice on
  `classifyIntent` first.
- **Load harness N + pace** — how many investigations at what rate?
  `01-spacing-gate-vs-backpressure.md` + the codebase's existing
  `minIntervalMs = 1100` set the ceiling; the plan's "sustained ~1
  req/s" is the target.

---

## Week 4 — Regression gate + ship (Phases 5, 6)

*Reading to add — baseline-vs-candidate gate, replay-runner, CI.*

- [ ] _tbd_
