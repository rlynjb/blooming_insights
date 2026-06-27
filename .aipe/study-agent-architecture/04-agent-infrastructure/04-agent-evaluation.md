# Agent evaluation

**Industry name(s):** Trajectory evaluation, agent eval, tool-call accuracy, agent-as-judge, LLM-as-judge rubric
**Type:** Industry standard · Language-agnostic

> Evaluating an agent is harder than evaluating one LLM call because the unit of evaluation is the trajectory, not just the final answer. blooming insights has the *substrate* — 221 unit tests under `test/` check the loop's *shape* (parse failures, budget enforcement, forced-final path) with injected fakes, and every run produces an inspectable `AgentEvent[]` trajectory streamed as NDJSON. It does **not** have an automated trajectory-eval harness in the repo today — the Phase 3 four-pillar pipeline lived under `eval/` and ran against the sibling `mcp-server-olist/` subprocess; both directories were removed in PR #8 (commit 62c24d7). The honest current measurement story is structural tests + spot-checks against the inspectable trajectory.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Agent evaluation lives *orthogonal* to the request flow — it doesn't run inside any band, it grades them. blooming insights has two of the three layers wired: the trajectory is *recorded* (tool name, args, result, duration) in the route's NDJSON stream, and the unit tests assert loop-shape invariants with injected fakes. The trajectory-grade harness — the runners that would spend real Anthropic dollars to score real agent output against seeded ground truth — is absent from the active repo today.

```
  Zoom out — where agent evaluation lives

  ┌─ Route handler (deterministic pipeline) ────────┐
  │  app/api/agent/route.ts                          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Agent runtime (AptKit) ▼────────────────────────┐
  │  AptKit agent classes emit trace events           │
  │  (tool, args, duration, result, error)            │
  │  through BloomingTraceSinkAdapter                 │
  └─────────────────────────┬────────────────────────┘
                            │  recorded trajectory
  Orthogonal to request flow (eval-time):
  ┌─ Eval band ─────────────┴────────────────────────┐  ← we are here
  │  ★ test/* (221 unit tests, injected fakes) ★     │
  │  ★ AgentEvent[] inspectable per-run trajectory ★ │
  │                                                   │
  │  ABSENT (was once at .aipe-listed Phase 3, removed│
  │  in PR #8 commit 62c24d7 along with the eval/    │
  │  pipeline + the mcp-server-olist subprocess it    │
  │  ran against):                                    │
  │   ✗ automated trajectory-eval harness             │
  │   ✗ seeded ground-truth dataset                   │
  │   ✗ portfolio numbers (detection / diagnosis /    │
  │     recommendation / regression)                  │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you evaluate something whose unit of work isn't a single input/output but a sequence of decisions? Final-output eval alone misses the failure modes that cost the most — an agent that returns the right answer after 12 tool calls when 4 would have done; an agent that recovers from a 429 silently; an agent that picks the wrong tool but stumbles into a right-looking answer. Trajectory-aware eval grades the path, not just the destination. Below, you'll see what the substrate covers and exactly where the automated harness *would* sit — honestly named as absent today.

---

## Structure pass

**Layers.** Agent evaluation sits orthogonal to the request flow — its own band that grades the others. Three layers today: the **Live request band** (what runs in production — route → AptKit agent → DataSource, emitting NDJSON trace events as it goes), the **Recorded trajectory** (the stream of `{tool, args, duration, result, error}` events the loop emits, persisted to `lib/state/investigations.ts` as in-memory + dev cache), and the **Loop-shape unit tests** (221 vitest tests under `test/` with injected `DataSource` + Anthropic fakes — assert invariants). A fourth layer — the trajectory-grade eval harness — would sit below those; it is absent today.

**Axis: guarantees.** What does the eval promise vs what does it merely best-effort observe — and at what moment in the lifecycle (request-time deterministic check vs offline probabilistic grade)? This is the right axis because the entire discipline of agent evaluation is about *layering different kinds of guarantees onto different stages*. A schema gate at request time is a hard guarantee (parse or fail); a loop-shape unit test is a hard rule applied offline against a fake-driven seam; an LLM-as-judge rubric score (if it existed) would be a probabilistic measurement across K runs. Pick the wrong axis (control, say) and the eval band looks like just "another call into the loop" — guarantees is what makes the three layers (and the fourth's absence) legible.

**Seams.** Two seams matter. Seam 1 sits between the live request band and the recorded trajectory — guarantees flip from "request-time deterministic check (schema parse, coverage gate)" to "observed event stream you can replay later." Seam 2 sits between the recorded trajectory and the (absent) eval harness — guarantees flip from "this happened" (a fact about one run) to "this is the rate at which our agent surfaces a known anomaly across K=10 runs" (a statistical claim with ground truth). Seam 2 is the load-bearing one: it's the boundary between observability and evaluation, and it's the boundary this codebase does NOT cross today.

```
  Structure pass — Agent evaluation

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Live request band (emits NDJSON trace)        │
  │  Recorded trajectory (event stream)            │
  │  Loop-shape unit tests (221, injected fakes)   │
  │  Trajectory-grade eval harness  ◄── ABSENT     │
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
  │  Seam 2: Recorded trajectory ↔ (Eval harness)  │
  │          (one run "happened" → K runs scored   │
  │          against seeded ground truth)          │
  │          ★ load-bearing — observability ↔ eval │
  │          NOT crossed in this repo today        │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the unit-of-evaluation expansion, what the substrate covers, and exactly what would be required to put the harness layer back.

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

The strategy in plain English: **the trajectory is data you can inspect, freeze, diff, and grade.** Three things have to be true for trajectory eval to be possible: (1) the trajectory is recorded structurally (not just logged as prose), (2) there's a way to compare a new trajectory or its output against an expected shape, and (3) the comparison is cheap enough to run on demand. blooming insights has (1) — every reasoning step, tool call, result, error, and final output is in a tagged-union `AgentEvent` record streamed live and persisted in-memory. It has (2) for invariants — the unit tests assert *loop-shape* properties — but not for output quality against seeded ground truth. (3) is moot today because the comparison surface (a seeded dataset + a runner + a judge) doesn't exist in the repo.

### Move 1 — The trajectory exists as a typed record

The technical thing: **an `AgentEvent` tagged-union type covers every step the agent takes** — reasoning_step, tool_call_start, tool_call_end, diagnosis, recommendation, done, error. The route streams these to the client as NDJSON, and the route also collects them server-side into a `collected: AgentEvent[]` buffer and stashes them via the save-investigation function. The events come from `BloomingTraceSinkAdapter` translating AptKit's `CapabilityEvent` into Blooming's existing hook surface.

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

The condition under which it works: the trajectory has to be complete and faithful — every step the AptKit loop takes has to emit an event. The current shape covers all of the AptKit agent's observable steps because the `BloomingTraceSinkAdapter` (`lib/agents/aptkit-adapters.ts:100–142`) forwards every `CapabilityEvent` AptKit emits into a `send()` call that pushes into the collected buffer while streaming to the client. There's no in-loop decision that goes unrecorded.

**Where the streamed trajectory record lives in the repo.** The `AgentEvent` union is in `lib/mcp/events.ts`. The source of events is `BloomingTraceSinkAdapter` at `lib/agents/aptkit-adapters.ts:100–142` — translates AptKit's `CapabilityEvent` ({step | tool_call_start | tool_call_end}) into the Blooming `onText` / `onToolCall` / `onToolResult` hooks. The route boundary is `app/api/agent/route.ts` — wires the adapter's hooks into a `send(...)` that appends to a `collected: AgentEvent[]` buffer while streaming each event to the client. Persistence: `lib/state/investigations.ts` (in-memory `Map`) + the dev cache file + the committed demo seed. Inspection surfaces: `GET /api/agent?insightId=<id>` replays the array; `/debug` views it; the investigation page consumes it via `lib/hooks/useInvestigation.ts`. The closest committed artefact to a frozen captured trajectory is `lib/state/demo-investigations.json` — diff a new run against it by eye.

### Move 2 — Unit tests grade the LOOP, not the trajectory quality

The technical thing: **221 vitest tests use the injected model client and `DataSource`/`McpCaller` seams** to drive the loop with fake responses, then assert the loop's reactive behaviour — parse-failure fallback, the forced-final tool-less path, the budget cap, the schema gate, validators returning safe defaults. The tests cover both the legacy `runAgentLoop` path (preserved at `lib/agents/base-legacy.ts`) and the AptKit wrappers' integration points (the three adapter classes in `lib/agents/aptkit-adapters.ts`).

If you're coming from frontend, this is component-testing posture: render with a mock data layer, click through, assert the right callbacks fired. You're testing *that the component reacts correctly to inputs*, not that the data layer's content is correct.

```
the test seams — a small interface for fakes

  interface McpCaller {
    call_tool(name, args, opts?): Promise<{result, duration_ms, from_cache}>
  }

  Test injects a fake MCP caller + a fake model client with scripted responses.
  Then asserts (against the legacy loop where the budget logic is owned by
  Blooming, OR against the AptKit adapters where the boundary contracts live):
    ✓ when budget spent → tools removed on next turn (force_final)
    ✓ when fake returns empty JSON → parser throws → caller
      returns safe default (e.g. [] for anomalies)
    ✓ when fake errors → tc.error set, is_error block pushed, loop
      continues
    ✓ schema gate filters anomalies the workspace can't run
    ✓ adapter event translation: AptKit CapabilityEvent → Blooming ToolCall
```

What these tests do well: they pin down the *invariants* of the loop and the adapter boundary. The forced-final turn always strips tools (legacy path). The adapter always emits a Blooming `ToolCall` for every AptKit `tool_call_start`. A parse failure always returns the type's safe default rather than throwing through the route. Those invariants are the load-bearing safety properties — if any of them broke, the system would silently misbehave. The 221 tests are how you sleep at night knowing they hold.

What these tests don't do: grade whether the trajectory itself was *good*. They assert "given fake response X, the loop did Y" — they don't assert "given anomaly X, the model's chosen tools and order were optimal." That's the gap a trajectory-eval harness would fill, and it's absent from this repo today.

The condition under which it works: the fakes have to be representative. A fake `McpCaller` that returns `{count: 42000}` lets the loop run; whether the model actually decides correctly *given that count* is a model-quality question, not a loop-shape question. The tests are deliberately scoped to the latter.

**Where the loop-shape tests live in the repo.** Directory: `test/` — 221 tests covering the legacy `runAgentLoop` path, the AptKit adapter boundary, the MCP boundary, state, streaming, and the data-source adapters. Seams used: the `McpCaller` type alias (`lib/agents/base.ts:14` — `Pick<DataSource, 'callTool'>`) and the Anthropic client passed into the agent wrappers — both injected, no network in tests. The `DataSource` interface (`lib/data-source/types.ts`) is the contract every fake satisfies.

### Move 3 — The trajectory-grade harness, honestly named as absent

The technical thing: **there is no automated trajectory-eval harness in this repo today.** A previous iteration of this codebase shipped one — the four-pillar suite under `eval/` (detection / diagnosis / recommendation / regression), with seeded ground truth in the sibling `mcp-server-olist/` subprocess and rubric prompts versioned at `eval/judges/*.md`. PR #8 (commit 62c24d7) removed both `eval/` and `mcp-server-olist/` as part of a broader scoping decision. The substrate that would let one come back lives intact: the `AgentEvent[]` is structured, the agents are constructed with fully injectable seams (`DataSource`, the Anthropic SDK), and the AptKit migration makes spawning K agent runs cheap (no subprocess to manage).

```
what the harness WOULD do (absent today)

  ┌─ seeded ground truth ─────────────────────────────────────┐
  │  a dataset with known anomalies the agent never sees      │
  │  (the removed mcp-server-olist had 3 such anomalies        │
  │   in a SQLite table called `seeded_anomalies`)             │
  └──────────────────────┬────────────────────────────────────┘
                         ▼
  ┌─ run each agent K=10 times against the dataset ───────────┐
  │  K=10 fresh agent runs per anomaly per eval                │
  │  fresh DataSource per run so one error doesn't poison K    │
  └──────────────────────┬────────────────────────────────────┘
                         ▼
  ┌─ score against the right yardstick per pillar ────────────┐
  │  detection      → deterministic matcher (metric +          │
  │                   segment + time-window)                   │
  │  diagnosis      → LLM judge over a rubric                  │
  │  recommendation → LLM judge over a rubric                  │
  │  regression     → capture-and-score against frozen goldens │
  └──────────────────────┬────────────────────────────────────┘
                         ▼
  ┌─ write artefacts ─────────────────────────────────────────┐
  │  per-run JSON + summary.md + judge-prompt versioning      │
  └────────────────────────────────────────────────────────────┘
```

The practical consequence of absence: model improvements (or regressions) ship blind today — a prompt change either looks better in spot-checks or it doesn't; there's no K=10 reproducible measurement against a fixed dataset. The streamed trace still makes spot-checking easy (open `/debug`, eyeball the trajectory). Spot-checking is the only line of defence above the loop-shape unit tests.

The condition under which a harness could come back: pick a dataset (or generate one with the AptKit `SyntheticDataSource` as the substrate), wire one runner per pillar that drives the existing agents end-to-end, commit the rubric prompts so reproducibility lives in the file. The AptKit migration actually lowered this cost — the agents are constructible with fully fake-able adapters, so the runner doesn't need a subprocess or a real Bloomreach session to do its work. The reason this hasn't shipped is *scoping*, not infeasibility.

### Move 4 — The evaluator paradox (why agent-as-judge needs care, when it returns)

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

The reframe to hand the reader: **trajectory eval IS an eval problem, with all the same biases as LLM-as-judge** (covered in the ai-engineering LLM-as-judge file). The honest production answer is a stack: frozen golden trajectories for deterministic regression, a different-family judge for new-shape grading, human spot-checks as the floor. Whenever this codebase grows a harness back, this is the discipline that has to land with it.

### The principle

**Evaluating something that takes a path means grading the path.** Final-output eval is a strict subset of trajectory eval; passing the former doesn't imply anything about the latter. The discipline is to (1) record the trajectory structurally so it's inspectable, (2) test the loop's *shape* invariants with fast unit tests that don't depend on the model, and (3) build a separate trajectory-eval harness with frozen inputs and structured metrics when model-quality drift becomes a load-bearing concern. blooming insights has (1) and (2) and honestly doesn't have (3) today — the unit tests guard the safety surface, the streamed trace guards observability, and the absence of (3) means model-quality changes ship without automated regression detection above spot-checks.

The full picture is below.

---

## Agent evaluation — diagram

```
Two layers built (✓), one absent (✗)

  ┌──────────── LOOP-SHAPE TESTS (✓ built) ──────────────────────┐
  │ 221 vitest tests under test/ with injected DataSource +       │
  │ Anthropic fakes assert invariants on both paths:              │
  │   legacy path: forced-final turn strips tools                 │
  │   legacy path: budget cap triggers synthesis instruction      │
  │   parse failures → safe defaults                              │
  │   schema gate excludes unrunnable categories                  │
  │   adapter contract: AptKit CapabilityEvent → Blooming ToolCall│
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
  │ source: BloomingTraceSinkAdapter (aptkit-adapters.ts:100–142) │
  │ stored: in-process state map + dev cache                       │
  │ viewable: /debug, /api/agent?insightId=<id>                    │
  └──────────────────────────────────────────────────────────────┘
                            ▲
                            │ replayable for eye inspection
                            │
  ┌──────────── TRAJECTORY-GRADE HARNESS (✗ absent) ─────────────┐
  │ would: drive K=10 agent runs against seeded ground truth      │
  │ would: score deterministically (detection) or via LLM judge   │
  │        (diagnosis · recommendation) or via capture-and-score  │
  │        (regression)                                            │
  │                                                                │
  │ previously lived at eval/scripts/run-*.ts against              │
  │ mcp-server-olist/; both removed in PR #8 commit 62c24d7        │
  │                                                                │
  │ substrate to rebuild: AptKit-backed agents are fully           │
  │ fake-able through DataSource + adapter seams, so a runner      │
  │ can drive them without a subprocess or live Bloomreach session │
  └──────────────────────────────────────────────────────────────┘
```

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
- AptKit runtime layer (`06-aptkit-runtime-layer.md`) → why "agents are fully fake-able through DataSource + adapter seams" is true in this repo
- LLM observability (`../../study-ai-engineering/05-evals-and-observability/04-llm-observability.md`) → the per-call observability story that complements trajectory-level eval
- LLM-as-judge bias (`../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`) → the evaluator paradox in detail
- Eval set types (`../../study-ai-engineering/05-evals-and-observability/01-eval-set-types.md`) → how to construct the frozen input set a trajectory harness needs

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "how do you evaluate your agent," they're testing whether you understand that the trajectory IS the work — not just the final answer — and whether you've built or honestly named what's needed to grade it. The strong signal is distinguishing loop-shape testing (invariants) from trajectory/output eval (quality of decisions) and naming both — including, when applicable, naming what's *not* built and why.

### Likely questions

[mid] Q: What do the 221 tests actually check?

A: They check the loop's *shape* invariants, not output quality. Using injected fakes (the `McpCaller` alias = `Pick<DataSource, 'callTool'>` at `lib/agents/base.ts:14`, and a fake Anthropic client), they assert: the legacy `runAgentLoop`'s forced-final turn strips tools, the synthesis instruction is appended when the budget is spent, parse failures return safe defaults via the `validate.ts` type guards, the schema gate excludes categories the workspace can't run, every fake tool error correctly pushes an `is_error` block back into messages, and the `BloomingTraceSinkAdapter` translates each AptKit `CapabilityEvent` into the expected Blooming `ToolCall` shape. They don't check whether the model's chosen tools were the right ones for a real anomaly — that's what an automated trajectory-eval harness would do, and that harness isn't in the repo today.

Diagram:
```
   Fake McpCaller        loop / adapter         Assertion
   ──────────────        ──────────────         ──────────
   {result: {}}      →   parse fails    →     returns []
                                              (safe default)
   {error: 429}      →   feeds is_error →     loop continues,
                                              tc.error set
   budget spent      →   forceFinal=true →    no tools in
                                              request params
   AptKit event      →   adapter translates → Blooming ToolCall
                                              with right hook
```

[senior] Q: You have unit tests and a trajectory. What's missing, and what would it cost to fill the gap?

A: The missing piece is an automated trajectory-eval harness — runners that drive K agent runs against seeded ground truth and score the output. A previous iteration of this codebase had one (the four-pillar suite under `eval/`, scoring against `mcp-server-olist/`'s `seeded_anomalies` table); both directories were removed in PR #8 commit 62c24d7 as part of a broader scoping decision. The cost to bring it back is lower than it was the first time, because the AptKit migration made the agents fully fake-able through their `DataSource` + adapter seams — no subprocess to manage, no live Bloomreach session needed. The build would be: pick (or generate) a seeded dataset, write one runner per pillar that constructs the existing agent classes with a fake-data `DataSource`, commit the rubric prompts so reproducibility lives in the file. The hard parts that always remain: ensuring the judge isn't the same model family as the actor (the evaluator paradox), and resisting the temptation to chase the metric instead of the model behavior.

Diagram:
```
   What's present (✓)              What's absent (✗)
   ──────────────────              ──────────────────
   AgentEvent[] trajectory          K=10 runner per pillar
   per run, persisted               seeded ground truth
                                    rubric prompts (versioned)
   221 unit tests on                deterministic detection
   loop shape + adapter             match (metric · segment · window)
   contract                         LLM judge with cross-family
                                    backstop
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
Q: You named the absent harness. Why hasn't it shipped yet?

A: Honest answer: scoping. A previous iteration shipped one — four runners under `eval/`, scoring against three seeded anomalies in a sibling `mcp-server-olist/` SQLite dataset, with K=10 batches and rubric prompts versioned alongside the code. That work was removed in PR #8 along with the `mcp-server-olist/` package and `eval/` directory, as part of a broader decision to scope the repo back toward the wrappers + adapters + UI surface and lean on `@aptkit/core` for the agent-runtime contracts (which is where the migration to AptKit's agent classes landed). The substrate that *let* that harness exist is still here — the agents are fully fake-able, the trajectory is structured, the `SyntheticDataSource` (`lib/data-source/synthetic-data-source.ts`, 516 LOC) is a Blooming-owned replacement for the seeded-data role the Olist subprocess used to play. Rebuilding the harness is a deliberate next move, not a missing capability; what's missing today is the runner files + the rubric prompts + a small fixture set, not the agent surface area.

Diagram:
```
   What got removed in PR #8         What stayed (rebuilds enabled)
   ──────────────────────────         ──────────────────────────────
   eval/scripts/run-*.ts             AgentEvent[] structured trace
   eval/judges/*.md                  Fully fake-able agent seams
   eval/results/*                    SyntheticDataSource (516 LOC)
   mcp-server-olist/ (sibling pkg)   AptKit's reusable agent classes
   seeded_anomalies SQLite table     221 unit tests on loop shape
                                     The shape of the harness itself
                                     (the work just hasn't shipped)
```

### One-line anchors
- "The trajectory is the work — grading only the final answer misses the failure modes that cost the most."
- "221 unit tests guard the loop's shape and the AptKit adapter contract; the automated trajectory harness is absent from the repo today."
- "Loop-shape testing and trajectory eval are different disciplines. We have one; we don't (yet) have the other."
- "The AptKit migration made the agents fully fake-able — a harness rebuild is scoping work, not missing-substrate work."
- "When a harness comes back: cross-family judge, frozen goldens, human spot-checks — all three, not one."

---

## See also

→ `01-context-engineering.md` · → `05-guardrails-and-control.md` · → `06-aptkit-runtime-layer.md` · → mechanics: `../../study-ai-engineering/05-evals-and-observability/04-llm-observability.md` · → `../../study-ai-engineering/05-evals-and-observability/01-eval-set-types.md` · → `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`

---
