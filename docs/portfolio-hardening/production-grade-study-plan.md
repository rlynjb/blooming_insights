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

### Sessions

- [x] **A — Phase 2 observability wiring** ✅ *implemented (`aca3ec9`)*
      Added optional `onCapabilityEvent` hook to `AgentHooks`; runner
      captures the aptkit trace, feeds it to `summarizeUsage` +
      `estimateCost`; receipt gains `usage.{diagnose,recommend}`.
      New `eval:report` script emits p50/p95/p99 latency per phase +
      per-case tokens/cost + run totals. Zero contract change; existing
      route handlers untouched.
- [x] **B — Phase 3 prompt caching** ✅ *implemented (`89dc82b`)*
      Wrapped the system prompt in an ephemeral cache breakpoint in
      `AnthropicModelProviderAdapter.complete()`. First ReAct-loop turn
      pays cache_creation (~1.25× normal); every subsequent turn within
      5 min reads at ~0.1×. Live logs confirm the pattern —
      `cache_creation_input_tokens 3168` on first call, matching
      `cache_read_input_tokens 3168` on the next.
- [x] **C — Blooming Anthropic pricing helper + routing decision**
      ✅ *implemented (`4616052`)*
      Aptkit's `estimateCost` only knows OpenAI. Added Blooming-side
      `estimateAnthropicCost` covering sonnet/haiku/opus families.
      Runner + report both fall through to it. **Monitoring routing
      DEFERRED** — the eval skips the monitoring step (feeds golden
      anomalies straight to DiagnosticAgent), so there's no cost
      signal on it. Routing monitoring→Haiku blind would be the exact
      anti-pattern the eval flywheel exists to prevent. Come back to
      it when production traffic gives us data.
- [x] **D — Phase 3 per-investigation budget ceiling**
      ✅ *implemented (`9ad134c`)*
      `BudgetTracker` + `BudgetExceededError` in `lib/agents/budget.ts`.
      Threaded through `AgentHooks.budget` → the model adapter's
      constructor. Check-before-dispatch: runaway loops can't burn cost
      after the ceiling. Shared tracker across DiagnosticAgent +
      RecommendationAgent so the ceiling counts total spend. Eval
      runner defaults to `BUDGET_MAX_USD=2.0` (very generous vs
      observed $0.09/case; here as proof-of-pipe).

### Baseline numbers (runId 2026-07-03T04-08-28-644Z)

Real observability from the 10-case run that validated caching + populated
the report script:

```
Per-phase latency p50           diag 50s · d-judge 38s · rec 51s · r-judge 90s
Per-case avg cost               ~$0.09 (agent-side only)
Total 10-case cost              $0.913 (agent) + ~$0.40 (judge estimated)
                                = ~$1.3-1.5 total, well under $3-4 budget
Cache validation                cache_creation → cache_read pattern live
                                in logs (case 09: 3168-token cache hits)
Judge cost gap                  RubricJudge's own trace sink not hooked
                                into the runner — separate wiring later
One rec-judge outlier           case 09 at 675s (multiple retries);
                                systemic issue not indicated
```

### Live decisions this reading unblocks (deferred to later phases)

- **Monitoring routing threshold** — where does Haiku stop being
  enough? Needs production-briefing cost data to decide. Deferred
  until we have that.
- **Load harness N + pace** — for Phase 4 (Week 4). See below.

---

## Week 4 — Phase 4 load + fault, then Phases 5, 6

Week 3 shipped Phases 2 + 3. Phase 4 (load + fault injection) rolls into
Week 4 alongside the original Week-4 material (Phase 5 regression gate +
Phase 6 ops hygiene).

### Sessions

- [x] **A — Phase 4 load harness** ✅ *implemented (`5177b79`)*
      `eval/load.eval.ts`. Semaphore-based worker pool at configurable
      N (LOAD_N) + concurrency K (LOAD_CONCURRENCY). Rotates through the
      10 goldens; no judges (agent-only). Emits load receipt with
      p50/p95/p99 latency + cost distribution + per-investigation
      detail. Smoke test at N=2/K=1: $0.156 total, ~104s per
      investigation.
- [x] **B — Phase 4 fault-injection decorator** ✅ *implemented (`552f0f6`)*
      `lib/data-source/fault-injecting.ts`. Wraps any DataSource with
      configurable per-error probabilities (timeout / rate_limit /
      server_error / malformed_json). Errors mimic Bloomreach's real
      shapes. Deterministic sequence via FAULT_SEED for regression
      tests. **Smoke test at 20% timeout + 20% malformed_json across 3
      investigations: 9 faults injected, 0 investigations failed.
      AptKit's agent loop presents fault errors as tool_result blocks
      with is_error: true; the model reasoned around every one.** Real
      tier-2 graceful degradation, not paper-tier.
- [x] **C — Phase 5 regression gate** ✅ *implemented (`dd7805a`)*
      Two scripts: `eval/baseline.eval.ts` builds `eval/baseline.json`
      from a runId; `eval/gate.eval.ts` compares a candidate run to it
      and blocks if any dimension has regressed by more than
      `GATE_MAX_REGRESSION` (default 10 percentage points). Baseline
      committed at runId 2026-07-03T04-08-28-644Z. Self-check
      (baseline == candidate) shows all deltas = 0pp, gate passes.
- [x] **D — Phase 6 ops hygiene** ✅ *implemented (`a423c26`)*
      `.github/workflows/ci.yml` runs typecheck + `npm test` +
      `npm run build` on every push/PR (lint deliberately omitted —
      28 pre-existing errors; separate cleanup pass). README
      rewritten with tier-2 claims table, one-command repro block, and
      architecture ASCII diagram. All npm scripts verified from a
      clean state.

### Week 4 status

**All four sessions shipped. All six phases from the hardening plan
complete.** Every claim in the plan is backed by code + a receipt.

### Required reading

**1. Load harness — pacing, distribution, and honest p99**
`.aipe/study-performance-engineering/`:

- [ ] `02-rate-limit-retry-ladder.md` — informs both the load harness's
      pacing choice (don't hammer, don't sandbag) and the fault
      decorator's 429/backoff simulation
- [ ] `03-per-call-timeout-ceiling.md` — the 30s per-call timeout in
      `lib/mcp/transport.ts:38` is the ceiling the fault decorator
      forces to fire; understanding when it fires and what happens
      after informs the decorator's error-shape choices

**2. Fault injection — what to simulate**
`.aipe/study-distributed-systems/`:

- [ ] `02-partial-failure-timeouts-and-retries.md` — canonical failure
      shapes (timeout / partial response / 500 / 429 / malformed
      body); the decorator's menu of injections
- [ ] `03-idempotency-deduplication-and-delivery-semantics.md` — why
      the retry ladder is safe without idempotency keys in this repo
      (informs what NOT to simulate — no duplicate-write bugs to
      catch, so the decorator focuses on read-side failure modes)

**3. Regression gate — baseline-vs-candidate methodology**
`.aipe/study-ai-engineering/05-evals-and-observability/`:

- [ ] `02-eval-methods.md` — rubric-driven vs pass-rate vs replay-diff
      methods; the plan's regression gate uses per-criterion pass-rate
      drop as the block signal

**4. CI + testing (Phase 6)**
`.aipe/study-testing/`:

- [ ] `06-scripted-ndjson-integration-harness.md` — the pattern that
      would extend to CI eval-run harness (a scripted 1-case eval as
      a PR check without paying the full 10-case cost per PR)
- [ ] `audit.md` — the 7-lens audit; informs which tests to run in CI
      vs at merge vs at deploy

### Optional — interview framing

- [ ] `.aipe/rehearse-interview-defense/04-the-scale-story.md` — three
      scale scenarios and what breaks first at 10x. Phase 4 (load) is
      what arms this defense.
- [ ] `.aipe/rehearse-interview-defense/05-the-failure-story.md` —
      failure surfaces + graceful degradation. Phase 4 (fault) is
      what arms this defense.

### Live decisions this reading unblocks

- **Load harness N + pacing** — how many investigations, at what rate?
  The plan says "sustained ~1 req/s" but that's the *provider* rate.
  Investigations take 200-250s; issuing one every 15s gives ~15
  in-flight at steady state. Higher = more backpressure signal, lower
  = friendlier to your API budget. Reading informs the right envelope.
- **Fault-injection distribution** — what fraction of calls should
  fail? 100% is not-a-test, 5% is realistic. The decorator's default
  distribution shape (per-error-type independent probability vs.
  correlated bursts) informs how faithful the test is.
- **Regression gate threshold** — how much pass-rate drop blocks the
  PR? Absolute (any dim drops ≥1 point) vs. proportional (≥10%
  relative drop). Reading has the tradeoff.
