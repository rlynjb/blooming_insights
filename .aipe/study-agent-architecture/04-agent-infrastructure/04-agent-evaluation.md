# Agent evaluation

**Industry name(s):** Trajectory evaluation, agent eval, tool-call accuracy, agent-as-judge, LLM-as-judge rubric
**Type:** Industry standard · Language-agnostic

> Evaluating an agent is harder than evaluating one LLM call because the unit of evaluation is the trajectory, not just the final answer. blooming insights has 269 unit tests across the app and the authored MCP server that check the loop's *shape* (parse failures, budget enforcement, forced-final path), the streamed `AgentEvent[]` is an inspectable trajectory per run — **and** Phase 3 added a four-pillar evaluation suite (detection precision/recall, diagnosis rubric, recommendation rubric, regression) under `eval/` that spends real Anthropic dollars to score real agent output against seeded ground truth. The four portfolio numbers (37% / 33.3% detection · 53.3% diagnosis · 100% recommendation · 30% regression baseline) are the honest measurement of what this codebase can defend.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Agent evaluation lives *orthogonal* to the request flow — it doesn't run inside any band, it grades them. blooming insights now has the full eval band wired: the trajectory is *recorded* (tool name, args, result, duration) in the route's NDJSON stream, the unit tests assert loop-shape invariants with injected fakes, and Phase 3's `eval/scripts/run-*.ts` runners spend real Anthropic dollars to drive the live agents against a seeded `mcp-server-olist` subprocess and score each output against a rubric or a captured golden.

```
  Zoom out — where agent evaluation lives

  ┌─ Route handler (deterministic pipeline) ────────┐
  │  app/api/agent/route.ts                          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Shared agent loop ─────▼────────────────────────┐
  │  runAgentLoop emits trace events                 │
  │  (tool, args, duration, result, error)            │
  └─────────────────────────┬────────────────────────┘
                            │  recorded trajectory
  Orthogonal to request flow (eval-time):
  ┌─ Eval band ─────────────┴────────────────────────┐  ← we are here
  │  ★ test/* (269 unit tests, injected fakes) ★     │
  │  ★ eval/scripts/run-detection.ts (precision/    │
  │     recall vs 3 seeded anomalies, K=10) ★        │
  │  ★ eval/scripts/run-diagnosis.ts (5-criterion   │
  │     rubric, Sonnet-as-judge, ≥7 = pass) ★        │
  │  ★ eval/scripts/run-recommendation.ts (3-       │
  │     criterion rubric, ≥4 = pass) ★               │
  │  ★ eval/scripts/run-regression.ts (capture +    │
  │     score against captured goldens) ★            │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you evaluate something whose unit of work isn't a single input/output but a sequence of decisions? Final-output eval alone misses the failure modes that cost the most — an agent that returns the right answer after 12 tool calls when 4 would have done; an agent that recovers from a 429 silently; an agent that picks the wrong tool but stumbles into a right-looking answer. Trajectory-aware eval grades the path, not just the destination. Below, you'll see how each of the four eval pillars maps onto that gap — and how PR D → PR E → PR F → PR G's chain demonstrates the eval flywheel: a measurement surfaces a real bug, a fix lands, the next measurement either confirms or catches recurrence.

---

## Structure pass

**Layers.** Agent evaluation sits orthogonal to the request flow — its own band that grades the others. Four layers: the **Live request band** (what runs in production — route → agent loop → DataSource, emitting NDJSON trace events as it goes), the **Recorded trajectory** (the stream of `{tool, args, duration, result, error}` events the loop emits, persisted to `lib/state/investigations.ts` and to `eval/results/<date>/` for the eval runners), the **Loop-shape unit tests** (269 vitest tests across `test/` and `mcp-server-olist/test/` with injected `DataSource` + Anthropic fakes — assert invariants), and the **Trajectory-grade eval harness** (`eval/scripts/run-*.ts` — runs the real agents against seeded Olist ground truth, scores via deterministic matchers OR a Sonnet-as-judge rubric, writes JSON + `summary.md` per dated run).

**Axis: guarantees.** What does the eval promise vs what does it merely best-effort observe — and at what moment in the lifecycle (request-time deterministic check vs offline probabilistic grade)? This is the right axis because the entire discipline of agent evaluation is about *layering different kinds of guarantees onto different stages*. A schema gate at request time is a hard guarantee (parse or fail); a deterministic detection match (LOOSE / STRICT) is a hard rule applied offline; an LLM-as-judge rubric score is a probabilistic measurement across K runs. Pick the wrong axis (control, say) and the eval band looks like just "another call into the loop" — guarantees is what makes the four-pillar split legible.

**Seams.** Two seams matter. Seam 1 sits between the live request band and the recorded trajectory — guarantees flip from "request-time deterministic check (schema parse, coverage gate)" to "observed event stream you can replay later." Seam 2 sits between the recorded trajectory and the eval harness — guarantees flip from "this happened" (a fact about one run) to "this is the rate at which our agent surfaces a known anomaly across K=10 runs" (a statistical claim with ground truth). Seam 2 is the load-bearing one: it's the boundary between observability and evaluation, and it's the boundary Phase 3 crossed — the four eval runners each plant their own foot on the harness side of that seam, with `eval/judges/*.md` versioning the rubric prompts alongside the code.

```
  Structure pass — Agent evaluation

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Live request band (emits NDJSON trace)        │
  │  Recorded trajectory (event stream)            │
  │  Loop-shape unit tests (269, injected fakes)   │
  │  Trajectory-grade eval harness (4 runners)     │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  guarantees: hard request-time check vs        │
  │              probabilistic offline grade?      │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: Live band ↔ Recorded trajectory       │
  │          (sync deterministic check →           │
  │          observed event stream)                │
  │  Seam 2: Recorded trajectory ↔ Eval harness    │
  │          (one run "happened" → K runs scored   │
  │          against seeded ground truth)          │
  │          ★ load-bearing — observability ↔ eval │
  │  Phase 3 crossed Seam 2 with the four runners  │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the unit-of-evaluation expansion, what each of the four eval pillars measures, and how the eval flywheel turns measurements into shipped fixes.

---

## How it works

**The mental model: the unit of evaluation expands from {input → output} to {input → trajectory → output}.** A single-LLM-call eval grades one Q/A pair. An agent eval grades a sequence: what tool got called first, what came back, what got called next, did the model recover when a call errored, how many steps did it take, what did it cost. Same instinct as upgrading from a unit test of one render to an integration test that walks a multi-step flow — and the same expansion of what could go wrong.

```
the unit of evaluation expands

  LLM eval                Agent eval (trajectory)
  ┌──────────────┐        ┌──────────────────────────────┐
  │ input        │        │ input                         │
  │   ▼          │        │   ▼                            │
  │ output       │        │ tool_use_1 → result_1         │
  │   ▼          │        │   ▼                            │
  │ score        │        │ tool_use_2 → result_2         │
  └──────────────┘        │   ▼ ...                         │
                          │ final output                    │
                          │   ▼                            │
                          │ score the WHOLE PATH:           │
                          │   right tools? right order?     │
                          │   step count? cost? recovery?   │
                          └──────────────────────────────┘
```

The strategy in plain English: **the trajectory is data you can inspect, freeze, diff, and grade.** Three things have to be true for trajectory eval to be possible: (1) the trajectory is recorded structurally (not just logged as prose), (2) there's a way to compare a new trajectory or its output against an expected shape, and (3) the comparison is cheap enough to run on demand. blooming insights has all three: (1) every reasoning step, tool call, result, error, and final output is in a tagged-union `AgentEvent` record streamed live and persisted; (2) the unit tests assert *loop-shape* invariants AND the four eval runners assert *output-quality* claims against seeded ground truth and captured goldens; (3) `npm run eval:detection -- --K=10` runs ~10 minutes and costs ~$1-3 — cheap enough to gate on a prompt change, not on every PR. The harness is opt-in (not in CI yet) by deliberate choice: it spends real money, and the goldens drift faster than the prompts do, so re-baselining is the bigger ongoing cost than running it.

### Move 1 — The trajectory exists as a typed record

The technical thing: **an `AgentEvent` tagged-union type covers every step the agent takes** — reasoning_step, tool_call_start, tool_call_end, diagnosis, recommendation, done, error. The route streams these to the client as NDJSON, and the route also collects them server-side into a `collected: AgentEvent[]` buffer and stashes them via the save-investigation function.

If you're coming from frontend, this is a structured log instead of `console.log` — same idea as Redux action history, where every state transition is a typed action you can replay and inspect, instead of opaque state mutations.

```
the trajectory IS the inspectable artefact

  AgentEvent union (one variant per step kind):
    { type: 'reasoning_step', step: { agent, kind, content } }
    { type: 'tool_call_start', tool_name, agent }
    { type: 'tool_call_end', tool_name, agent, duration_ms, result, error }
    { type: 'diagnosis', diagnosis }
    { type: 'recommendation', recommendation }
    { type: 'done' }
    { type: 'error', message }

  A whole investigation = AgentEvent[].
  Saved by the route handler: save_investigation(insight_id, collected)
  Replayed by the route handler: get_cached_investigation(insight_id)
  Inspectable at: /debug · /api/agent?insightId=<id> (replays the array)
```

The practical consequence: every run produces a trajectory you can open and read. The trajectory tells you exactly which tool was called, with which args (visible at tool_call_start), how long it took (duration_ms at tool_call_end), whether it errored, and what the final structured output was. A committed demo-investigations seed file is a frozen example trajectory you can diff a new run against by eye.

The condition under which it works: the trajectory has to be complete and faithful — every step the loop takes has to emit an event. The current shape covers all of the shared loop's observable steps because every call to its on-text / on-tool-call / on-tool-result hooks is wired through a per-agent hooks helper into a `send()` call that pushes into the collected buffer while streaming to the client. There's no in-loop decision that goes unrecorded.

### Move 2 — Unit tests grade the LOOP, not the trajectory quality

The technical thing: **269 vitest tests use the injected model client and `DataSource`/`McpCaller` seams in the shared agent loop to drive the loop with fake responses**, then assert the loop's reactive behaviour — parse-failure fallback, the forced-final tool-less path, the budget cap, the schema gate, validators returning safe defaults. 226 of the 269 sit under `test/` covering the app; the other 43 sit under `mcp-server-olist/test/` covering the authored MCP server's three domain tools and SQLite query layer.

If you're coming from frontend, this is component-testing posture: render with a mock data layer, click through, assert the right callbacks fired. You're testing *that the component reacts correctly to inputs*, not that the data layer's content is correct.

```
the test seams — a small interface for fakes

  interface McpCaller {
    call_tool(name, args, opts?): Promise<{result, duration_ms, from_cache}>
  }

  Test injects a fake MCP caller + a fake model client with scripted responses.
  Then asserts:
    ✓ when budget spent → tools removed on next turn (force_final)
    ✓ when fake returns empty JSON → parser throws → caller
      returns safe default (e.g. [] for anomalies)
    ✓ when fake errors → tc.error set, is_error block pushed, loop
      continues
    ✓ schema gate filters anomalies the workspace can't run
    ✓ ...
```

What these tests do well: they pin down the *invariants* of the loop. The forced-final turn always strips tools. A budget overrun always triggers the synthesis instruction. A parse failure always returns the type's safe default rather than throwing through the route. Those invariants are the load-bearing safety properties — if any of them broke, the system would silently misbehave. The 269 tests are how you sleep at night knowing they hold.

What these tests don't do: grade whether the trajectory itself was *good*. They assert "given fake response X, the loop did Y" — they don't assert "given anomaly X, the model's chosen tools and order were optimal." That's the gap the Phase 3 eval suite fills.

The condition under which it works: the fakes have to be representative. A fake `McpCaller` that returns `{count: 42000}` lets the loop run; whether the model actually decides correctly *given that count* is a model-quality question, not a loop-shape question. The tests are deliberately scoped to the latter.

### Move 3 — The four-pillar eval suite (the harness Phase 3 built)

The technical thing: **four runners under `eval/scripts/` that each drive the real agent loop against the seeded Olist subprocess, score the output against a known-good rubric or matcher, and write per-run JSON plus a `summary.md` to a dated results directory.** Each pillar measures a different unit of evaluation: detection grades *what was surfaced*, diagnosis grades *the reasoning that followed*, recommendation grades *the action proposed*, regression grades *the drift between captures*. The seed data in `mcp-server-olist/data/olist.db` carries three ground-truth anomalies (the `seeded_anomalies` table): `sp-revenue-drop-w4` (critical, ×0.7), `electronics-spike-w2` (warning, ×2.5), `voucher-dropoff-w10-on` (critical, ×0.05). The agent under test never knows they're there.

```
the four-pillar eval suite (built in Phase 3)

  ┌─ seeded ground truth ─────────────────────────────────────┐
  │  mcp-server-olist/data/olist.db                            │
  │    seeded_anomalies table — 3 ground-truth records         │
  │    + ~10k synthetic Olist rows + 6-month data horizon      │
  └──────────────────────┬────────────────────────────────────┘
                         ▼
  ┌─ run each agent against the live Olist subprocess ────────┐
  │  K=10 fresh agent runs per anomaly per eval                │
  │  fresh subprocess per run (one crash doesn't poison K)     │
  │  EVAL_RUN_TAG env var stamps each run for the audit trail  │
  └──────────────────────┬────────────────────────────────────┘
                         ▼
  ┌─ score against the right yardstick per pillar ────────────┐
  │  detection      → deterministic matcher (metric +          │
  │                   segment + time-window, 2/3 = LOOSE,      │
  │                   3/3 = STRICT)                            │
  │  diagnosis      → Sonnet 4.6 judge, 5-criterion rubric,    │
  │                   pass ≥ 7 (root cause · evidence ·         │
  │                   hypotheses · scope · impact)             │
  │  recommendation → Sonnet 4.6 judge, 3-criterion rubric,    │
  │                   pass ≥ 4 (specificity · feature fit ·    │
  │                   impact plausibility)                     │
  │  regression     → 2-mode (capture | score) — capture       │
  │                   freezes a golden, score diffs current    │
  │                   output structurally + via a similarity   │
  │                   judge                                    │
  └──────────────────────┬────────────────────────────────────┘
                         ▼
  ┌─ write artefacts ─────────────────────────────────────────┐
  │  eval/results/<YYYY-MM-DD>[<-tag>]/                        │
  │    <pillar>-K10-{loose,strict}.json                        │
  │    <pillar>-K10-raw.json    (audit trail)                  │
  │    summary.md               (human-readable scorecard)     │
  │  + eval/judges/*.md          (rubric prompts, versioned)   │
  └────────────────────────────────────────────────────────────┘
```

The practical consequence: model improvements (or regressions) no longer ship blind. A prompt change either lifts the detection number across a K=10 rerun or it doesn't; either lifts the diagnosis rubric score or it doesn't. The streamed trace still makes spot-checking easy (open `/debug`, eyeball the trajectory) — but spot-checking is now the supplement to the numbers, not the only line of defence.

The condition under which it works: the seeded anomalies must be *the* anomalies the test data contains. If the synthetic Olist generator accidentally introduced a fourth pattern strong enough for the agent to find, every detection of it counts as a false positive against ground truth — even though it's a real signal. The deterministic generator + the `seeded_anomalies` table are the contract; deviations there silently invalidate every score.

**The eval flywheel — what this actually buys.** The four pillars don't matter in isolation; they matter as a closed loop. The PR D → PR E → PR F → PR G chain shows it end to end:

  → **PR D (detection)** surfaced a 5% LOOSE recall on the first run — the monitoring agent was anchoring on "last 90 days" framing from the Bloomreach-era prompt, and on Olist's 6-month horizon that window landed past the seeded anomalies.
  → **Phase 2.5 fix** rewrote the monitoring prompt with the `DATA HORIZON` block + the 3-dim scan plan. Reran detection: voucher detection lifted 1/10 → 10/10, LOOSE recall lifted ~5x to 33.3%. The fix landed because the number changed.
  → **PR E (diagnosis)** surfaced a unit-conversion bug — the diagnostic agent was reading BRL `payment_value` as Reais in one query and cents in the next, so its conclusions sometimes silently swung by ~100x. The 5-criterion judge caught it as an "evidence grounding" failure; a prompt fix patched it.
  → **PR F (recommendation)** reran with the BRL fix in. The judge caught the unit bug recurring at run 8 of K=10 — a real measurement that the fix wasn't tight enough yet, surfaced before it could ship to users.
  → **PR G (regression)** added the capture-and-score flow that now diffs every prompt change against a 10-fixture golden set. The 30% baseline is honest: monitoring/diagnostic outputs drift semantically more than the prompt structure changed, which is exactly the signal the regression eval exists to surface.

This loop — measurement → fix → re-measurement → discovery of the next thing — is what a working eval system looks like. The numbers aren't the point; the loop is.

### Move 4 — The evaluator paradox (why agent-as-judge needs care)

The technical thing: **if you use an LLM to grade an agent's trajectory, the judge model shares blind spots with the actor model** — especially if they're from the same provider family.

If you're coming from frontend, this is the "tests written by the same dev who wrote the code" problem at scale: the same misconceptions that produced the wrong code produce the wrong test. With LLMs, the same training-data biases that produced the wrong trajectory produce a wrong "this trajectory looks fine" grade.

```
the evaluator paradox

   Anthropic-actor agent  ──► trajectory  ──► Anthropic-judge grades
                                                "looks fine"
                                                        │
                                                        ▼
                                             same-family blind spots
                                             → judge approves a wrong
                                               trajectory because both
                                               models miss the same thing

  Mitigations:
   • use a different model family for the judge (cross-family check)
   • freeze GOLDEN trajectories (deterministic comparison, not LLM grade)
   • human spot-checks on a sample (catches what neither model catches)
```

The reframe to hand the reader: **trajectory eval IS an eval problem, with all the same biases as LLM-as-judge** (covered in the ai-engineering LLM-as-judge file). The honest production answer is a stack: frozen golden trajectories for deterministic regression, a different-family judge for new-shape grading, human spot-checks as the floor. Skipping any of those biases the result; relying on only one of them produces high confidence in a poorly-graded system.

### The principle

**Evaluating something that takes a path means grading the path.** Final-output eval is a strict subset of trajectory eval; passing the former doesn't imply anything about the latter. The discipline is to (1) record the trajectory structurally so it's inspectable, (2) test the loop's *shape* invariants with fast unit tests that don't depend on the model, and (3) build a separate trajectory-eval harness with frozen inputs and structured metrics when model-quality drift becomes a load-bearing concern. blooming insights has (1) and (2) and honestly doesn't have (3) yet — the unit tests guard the safety surface, the streamed trace guards observability, and the absence of (3) means model-quality changes ship without automated regression detection above spot-checks.

The full picture is below.

---

## Agent evaluation — diagram

```
Three layers, all built (✓)

  ┌──────────── LOOP-SHAPE TESTS (✓ built) ──────────────────────┐
  │ 269 vitest tests (226 app + 43 mcp-server-olist) with         │
  │ injected DataSource + Anthropic fakes assert invariants:      │
  │   forced-final turn strips tools                              │
  │   budget cap triggers synthesis instruction                   │
  │   parse failures → safe defaults                              │
  │   schema gate excludes unrunnable categories                  │
  └──────────────────────────────────────────────────────────────┘
                            ▲
                            │ test the LOOP, not the trajectory quality
                            │
  ┌──────────── INSPECTABLE TRAJECTORY (✓ built) ────────────────┐
  │ AgentEvent[] streamed as NDJSON + cached server-side          │
  │   tool_call_start { tool_name, agent }                         │
  │   tool_call_end { tool_name, duration_ms, result, error }      │
  │   reasoning_step { kind, content }                             │
  │   diagnosis / recommendation / done / error                    │
  │ stored: in-process state map + dev cache                       │
  │ viewable: /debug, /api/agent?insightId=<id>                    │
  └──────────────────────────────────────────────────────────────┘
                            ▲
                            │ replayable for eye inspection
                            │ AND consumed by the eval runners below
                            │
  ┌──────────── PHASE 3 EVAL SUITE (✓ built) ────────────────────┐
  │ ground truth: 3 seeded anomalies in mcp-server-olist/data    │
  │ K=10 runs per anomaly, fresh subprocess per run               │
  │ EVAL_RUN_TAG env var stamps each batch                        │
  │                                                                │
  │ ┌─ DETECTION ──────────────── 37% LOOSE p · 33.3% recall ──┐ │
  │ │  run-detection.ts + scorer.ts (deterministic 3-criterion) │ │
  │ │  metric · segment · time-window match                     │ │
  │ └───────────────────────────────────────────────────────────┘ │
  │ ┌─ DIAGNOSIS ──────────────── 53.3% pass rate ─────────────┐ │
  │ │  run-diagnosis.ts + judge.ts (Sonnet 4.6 judge, ≥7 pass) │ │
  │ │  5-criterion rubric in eval/judges/diagnosis-judge.md    │ │
  │ └───────────────────────────────────────────────────────────┘ │
  │ ┌─ RECOMMENDATION ─────────── 100% pass rate ──────────────┐ │
  │ │  run-recommendation.ts + judge-rec.ts (≥4 pass)          │ │
  │ │  3-criterion rubric in eval/judges/recommendation-judge.md│ │
  │ └───────────────────────────────────────────────────────────┘ │
  │ ┌─ REGRESSION ─────────────── 30% baseline pass rate ──────┐ │
  │ │  run-regression.ts (capture | score modes)               │ │
  │ │  structural-diff.ts + similarity-judge.ts                 │ │
  │ │  10 golden fixtures across the 4 agent stages            │ │
  │ └───────────────────────────────────────────────────────────┘ │
  │                                                                │
  │ The flywheel: PR D detection gap → Phase 2.5 prompt fix →    │
  │ PR E BRL bug → PR F judge catches recurrence → PR G regression│
  │ surfaces conclusion-stability drift across the suite           │
  └──────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

All three layers are built.

**Loop-shape unit tests (the 269):**
**Directories:** `test/` (226 tests covering the app's agents, MCP boundary, state, streaming, data-source adapters) and `mcp-server-olist/test/` (43 tests covering the authored MCP server: domain tools, SQLite query layer, server boot)
**Seams used:** the `McpCaller` type alias (`lib/agents/base.ts:24` — `Pick<DataSource, 'callTool'>`) and the Anthropic client passed into `runAgentLoop()` — both injected, no network in tests. The `DataSource` interface (`lib/data-source/types.ts`) is the contract every fake satisfies.

**The streamed trajectory record:**
**File:** `lib/mcp/events.ts` — `AgentEvent` union
**Route boundary:** `app/api/agent/route.ts` — wires `runAgentLoop`'s `onText` / `onToolCall` / `onToolResult` into a `send(...)` that appends to a `collected: AgentEvent[]` buffer while streaming each event to the client.
**Persistence:** `lib/state/investigations.ts` (in-memory `Map`) + the dev cache file + the committed demo seed
**Inspection surfaces:** `GET /api/agent?insightId=<id>` replays the array; `/debug` views it; the investigation page consumes it via `lib/hooks/useInvestigation.ts`

**Phase 3 eval suite (the four runners):**

```
eval/
  scripts/
    run-detection.ts          ← MonitoringAgent.scan × K=10 against
                                  seeded Olist; LOOSE/STRICT scoring
    run-diagnosis.ts          ← DiagnosticAgent + Sonnet-as-judge
                                  over 5-criterion rubric (≥7 pass)
    run-recommendation.ts     ← RecommendationAgent + Sonnet-as-judge
                                  over 3-criterion rubric (≥4 pass)
    run-regression.ts         ← capture | score mode against 10
                                  golden fixtures across all agents
    lib/
      run-agent.ts            ← spawns OlistDataSource subprocess,
                                  drives one agent end-to-end
      scorer.ts               ← deterministic 3-criterion detection
                                  matcher (metric · segment · window)
      judge.ts / judge-rec.ts ← LLM-as-judge calls with the rubric
      structural-diff.ts      ← regression structural pass
      similarity-judge.ts     ← regression semantic pass
      summary.ts              ← K-run aggregator + summary.md renderer
  judges/
    diagnosis-judge.md        ← 5-criterion rubric prompt (versioned)
    recommendation-judge.md   ← 3-criterion rubric prompt (versioned)
    similarity-judge.md       ← regression similarity prompt (versioned)
  fixtures/                   ← reference diagnoses, judge anchors
  results/<YYYY-MM-DD>[-tag]/ ← dated batches, committed:
    detection-K10-{loose,strict,raw}.json
    summary.md
```

```
shape of one run (real, from eval/scripts/run-detection.ts):
  // K=10, one fresh subprocess per run, EVAL_RUN_TAG stamps the batch
  for (let i = 0; i < K; i++) {
    const result = await runMonitoringAgentOnce({ … });   // spawn + drive
    const matches = scoreRun(result.insights, seeded);    // 3-criterion
    runs.push({ index: i, looseHits, strictHits, falsePositives });
  }
  const summary = aggregate(runs);                         // p/r per anomaly
  writeFileSync(resultsDir + 'summary.md',
                renderSummaryMarkdown(summary, runs));
```

The eval runners are opt-in (`npm run eval:detection -- --K=10`), not in CI — they spend real Anthropic budget. The `eval/judges/*.md` files are the versioned rubric prompts; treating them as code is the answer to "what does it mean for an LLM-as-judge to be reproducible" — the rubric is reproducible because its prompt is committed.

---

## Elaborate

### Where this pattern comes from

Trajectory evaluation as a discipline emerged from the gap between LLM benchmarks (single-turn, single-output) and the failure modes of real agents in production. Papers like AgentBench (2023) and ToolBench (2023) defined trajectory scoring metrics — task success rate, tool-call accuracy, step efficiency, recovery — that are now standard in agent-eval tooling (LangSmith, Braintrust, Anthropic's evaluation features). The motivating observation was that two agents producing the same final answer can have wildly different costs, robustness, and failure modes, and final-answer eval can't see the difference.

### The deeper principle

**The unit of evaluation has to match the unit of work.** If the work is "answer one question," final-answer eval suffices. If the work is "make a sequence of decisions whose cost depends on the sequence," you have to grade the sequence. The same principle applies in non-LLM systems: if a microservice's "work" is one request/response, you test that; if its "work" is a saga across multiple services, you test the saga.

```
  unit of work             →  unit of eval                  →  metrics
  one LLM call              →  one I/O pair                  →  output quality
  one tool call            →  one call's correctness         →  tool-call success
  one agent run            →  one trajectory                 →  +efficiency, recovery
  multi-agent topology     →  inter-agent message exchange  →  +handoff quality
```

### Where this breaks down

Trajectory eval breaks down when the "right" trajectory isn't unique — when two different tool orderings can both be correct, the rigid golden-trajectory comparison flags one as a regression for no reason. Mitigations: score by *outcome groupings* (was a relevant tool called, in some sensible order) rather than exact tool-by-tool match; allow multiple golden trajectories per input; use a judge for new shapes the golden set doesn't cover. The honest version: trajectory eval is itself a design problem, not a bolt-on test.

### What to explore next
- Guardrails and control (`05-guardrails-and-control.md`) → the loop-shape invariants the unit tests already guard
- LLM observability (`../../study-ai-engineering/05-evals-and-observability/04-llm-observability.md`) → the per-call observability story that complements trajectory-level eval
- LLM-as-judge bias (`../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`) → the evaluator paradox in detail
- Eval set types (`../../study-ai-engineering/05-evals-and-observability/01-eval-set-types.md`) → how to construct the frozen input set a trajectory harness needs

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "how do you evaluate your agent," they're testing whether you understand that the trajectory IS the work — not just the final answer — and whether you've built or honestly named what's needed to grade it. The strong signal is distinguishing loop-shape testing (invariants) from trajectory/output eval (quality of decisions) and naming both, with real numbers. The weakest signal is "we have unit tests"; the strongest is "we have four eval pillars, here are the portfolio numbers, here is the flywheel that produced them."

### Likely questions

[mid] Q: What do the 269 tests actually check?

A: They check the loop's *shape* invariants, not output quality. Using injected fakes (the `McpCaller` alias = `Pick<DataSource, 'callTool'>` at `lib/agents/base.ts:24`, and a fake Anthropic client), they assert: the forced-final turn strips tools, the synthesis instruction is appended when the budget is spent, parse failures return safe defaults via the `validate.ts` type guards, the schema gate excludes categories the workspace can't run, and every fake tool error correctly pushes an `is_error` block back into messages. 226 cover the app's loop and 43 cover the authored `mcp-server-olist`'s domain tools + SQLite layer. They don't check whether the model's chosen tools were the right ones for a real anomaly — that's what the four Phase 3 evals are for.

Diagram:
```
   Fake McpCaller        runAgentLoop          Assertion
   ──────────────        ────────────          ──────────
   {result: {}}      →   parse fails    →     returns []
                                              (safe default)
   {error: 429}      →   feeds is_error →     loop continues,
                                              tc.error set
   budget spent      →   forceFinal=true →    no tools in
                                              request params
```

[senior] Q: You have four eval pillars and four portfolio numbers. Which one is load-bearing?

A: Detection — for two reasons. First, it's the only one with deterministic scoring against seeded ground truth, no LLM judge in the loop, so the number is reproducible across rate-limit retries and judge-prompt drift. Second, detection is upstream: if monitoring doesn't surface the anomaly, the diagnostic and recommendation evals never see it, so the 53.3% / 100% downstream numbers are conditional on detection's 37% / 33.3%. The recommendation 100% is suspicious-by-design — it's the loosest rubric and the easiest stage, so it tells me the rubric has headroom but not that the recommendation agent is "done." The regression 30% is the most informative for catching drift between captures, but the baseline carries judge-shape noise I haven't tuned out yet. Net: detection is the number to defend, diagnosis is the rubric to keep tight, recommendation is the headroom to watch, regression is the ongoing drift gauge. They're a system, not four independent claims.

Diagram:
```
   The four numbers, ranked by what they actually claim
   ┌────────────────────────────────────────────────────┐
   │ DETECTION 37% LOOSE p / 33.3% recall                │
   │   load-bearing — deterministic, upstream            │
   │   PR D → Phase 2.5 fix → voucher 1/10 → 10/10       │
   │                                                     │
   │ DIAGNOSIS 53.3% pass                                │
   │   conditional on detection; Sonnet-judge noise      │
   │   PR E surfaced BRL cents-vs-Reais unit bug         │
   │                                                     │
   │ RECOMMENDATION 100% pass                            │
   │   rubric headroom; honest but not decisive          │
   │   PR F caught BRL bug recurring at run 8/10         │
   │                                                     │
   │ REGRESSION 30% baseline                             │
   │   drift gauge across the 10-fixture golden set      │
   │   PR G — captures monitoring/diagnostic drift       │
   └────────────────────────────────────────────────────┘
```

[arch] Q: If you were grading trajectories with an LLM judge, how would you avoid the evaluator paradox?

A: Three layers. First, freeze deterministic golden trajectories for the inputs whose right answer is knowable — those become unit-test-shaped regression checks, no judge involved. Second, when you need a judge for new-shape grading (the input isn't in the golden set), use a different model family from the actor — if the actor is Anthropic, the judge is OpenAI or vice versa, so same-family blind spots don't cancel out. Third, sample-grade by humans on a slice every release — even 20 hand-graded trajectories per release catch what neither golden diff nor cross-family judge catches. The combination is the actual production answer; relying on only one of them is naive.

Diagram:
```
  ┌ Frozen goldens ────► deterministic regression on known inputs
  ┌ Cross-family judge ► grades new-shape trajectories
  ┌ Human spot-check  ► catches what both above miss

  Anthropic-actor agent
        │
        ▼ trajectory
        │
        ├── golden diff (deterministic — wins where it applies)
        ├── OpenAI judge (cross-family — better than same-family)
        └── human sample (the floor under both)
```

### The question candidates always dodge
Q: Your judge is Sonnet 4.6. Your actor is Sonnet 4.6. Doesn't that bias the diagnosis and recommendation scores upward?

A: Yes, and it's the single biggest caveat on those two numbers. Same-family judge shares the actor's blind spots — the unit-conversion bug PR E caught is exactly the kind of failure both models *should* miss in the same direction. The reason I kept it that way is constraint, not principle: a different-family judge means a second API key, a second SDK, a different output-format quirk to plumb through `eval/scripts/lib/judge.ts`, and rubric prompts that translate cleanly. None of that is hard; it's just work that wasn't on the K=10-first-run critical path. The honest mitigation is the layered stack: detection is deterministic (judge-free), so it's the anchor; the regression eval's structural pass is also judge-free; the similarity judge runs over text content where same-family blind spots are smaller (semantic equivalence, not chain-of-thought validation); the diagnosis and recommendation rubrics are the ones to view with the most skepticism. The next thing I'd build is a cross-family backstop on the diagnosis judge — likely GPT-4 — and compare its scores against Sonnet's on the same K=10 batch. If they correlate, the bias is small; if they don't, the diagnosis number drops to "Sonnet thinks it's fine" and I'd publish both.

Diagram:
```
   Where the same-family bias hurts most       Where it hurts least
   ┌────────────────────────────────────┐      ┌────────────────────────────┐
   │ DIAGNOSIS rubric                    │      │ DETECTION (deterministic)  │
   │   5 criteria, model judges reasoning│      │   3-criterion matcher,     │
   │   ← MOST exposed to blind spots     │      │   no LLM in the loop       │
   │                                     │      │   ← unbiased anchor        │
   │ RECOMMENDATION rubric               │      │                            │
   │   3 criteria, model judges plausibility│   │ REGRESSION structural pass │
   │   ← also exposed                    │      │   field-by-field diff      │
   │                                     │      │   ← unbiased               │
   │ SIMILARITY judge (regression)       │      │                            │
   │   semantic equivalence of text      │      │ UNIT TESTS                 │
   │   ← partially exposed               │      │   loop-shape, injected     │
   │                                     │      │   fakes ← unbiased         │
   └────────────────────────────────────┘      └────────────────────────────┘
   Next move: add cross-family (GPT-4) judge as a backstop on
   diagnosis; publish both scores if they diverge.
```

### One-line anchors
- "The trajectory is the work — grading only the final answer misses the failure modes that cost the most."
- "269 unit tests guard the loop's shape; the four eval pillars (detection · diagnosis · recommendation · regression) grade the outputs against seeded ground truth."
- "Detection is the load-bearing eval — deterministic, upstream, no judge in the loop. Everything else is conditional on it."
- "The seeded Olist dataset is what made the harness tractable: three known anomalies in `mcp-server-olist/data/olist.db`, the agent never told they're there."
- "Same-family judge (Sonnet actor + Sonnet judge) is the live caveat on the diagnosis/recommendation numbers — a cross-family backstop is the next move."
- "The eval flywheel: PR D surfaces a gap → Phase 2.5 prompt fix → PR F's judge catches recurrence → PR G's regression eval surfaces drift. The number isn't the win; the loop is."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the three boxes: loop-shape tests (269, what they assert), inspectable trajectory (what's in `AgentEvent`), the four-pillar Phase 3 eval suite (detection · diagnosis · recommendation · regression — what each scores against). Label which file or directory each piece lives in.

Open the file. Compare.

✓ Pass: three boxes correctly labelled, with `test/` + `base.ts:24` `McpCaller` seam for box 1, `events.ts` + `investigations.ts` for box 2, `eval/scripts/run-*.ts` + `eval/judges/*.md` + the four portfolio numbers (37%/33.3% · 53.3% · 100% · 30%) for box 3
✗ Fail: re-read How it works moves 1–3, wait 10 minutes, try again.

### Level 2 — Explain it out loud
Explain "how do you evaluate this agent today" to a colleague who just asked "do you have a benchmark?" No notes. Under 90 seconds.

Checkpoints — did you:
- Distinguish loop-shape testing (269 tests, unit-test-shaped) from output-quality eval (the four Phase 3 pillars)?
- Name the `AgentEvent[]` trajectory as the inspectable record AND the input to the regression eval?
- Cite at least two of the four portfolio numbers and which pillar each comes from?
- Name the same-family judge bias as the live caveat on the diagnosis/recommendation scores?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A new prompt for the diagnostic agent ships. It improves the conclusion's clarity in your spot-checks, but a week later the monthly bill is up 30%. Without looking at the file: how would you confirm the prompt change caused it, and what's the smallest piece of trajectory-eval infrastructure you'd build first to catch this kind of regression automatically in the future?

Write your answer (3–5 sentences). Then open `lib/state/investigations.ts` L11 and `lib/mcp/events.ts` to verify what data is already structured enough to compute "tool calls per investigation" from.

### Level 4 — Defend the decision you'd change
"If you were starting today with the same MCP host and team size, would you still defer the trajectory-eval harness, or would you build the minimum viable version up front so you have a baseline before the first prompt drift? What would 'minimum viable' include and what would it cost in build hours?"

Reference: the absence of `langsmith`/`braintrust` in `package.json`, the existing `lib/state/demo-investigations.json` as a possible seed.

### Quick check — code reference test
Without opening any files:
- What type alias in `base.ts` is the test seam for fake tool calls, and what interface is it derived from?
- What type holds the streamed trajectory records, and what file is it in?
- What function persists a finished investigation server-side?
- Name the four eval pillars and the directory they live under. Which one is judge-free?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

## See also

→ `01-context-engineering.md` · → `05-guardrails-and-control.md` · → mechanics: `../../study-ai-engineering/05-evals-and-observability/04-llm-observability.md` · → `../../study-ai-engineering/05-evals-and-observability/01-eval-set-types.md` · → `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-16 — Phase 3 landed: replaced "trajectory-eval harness absent" framing with the four-pillar suite (detection precision/recall · diagnosis 5-criterion rubric · recommendation 3-criterion rubric · regression capture+score), anchored to `eval/scripts/run-*.ts` and `eval/judges/*.md`, with the four portfolio numbers (37%/33.3% · 53.3% · 100% · 30%) and the PR D→E→F→G flywheel as the load-bearing narrative. Test count updated 169 → 269 (226 app + 43 mcp-server-olist). McpCaller seam relocated to `lib/agents/base.ts:24` as `Pick<DataSource, 'callTool'>`. Same-family-judge bias re-spotlit as the live caveat on diagnosis/recommendation numbers.
