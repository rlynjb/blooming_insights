# Agent evaluation

**Industry name(s):** Trajectory evaluation, agent eval, tool-call accuracy, agent-as-judge
**Type:** Industry standard · Language-agnostic

> Evaluating an agent is harder than evaluating one LLM call because the unit of evaluation is the trajectory, not just the final answer. blooming insights has ~169 vitest tests TDD'd with injected fakes that check the loop's *shape* (parse failures, budget enforcement, forced-final path), and the streamed reasoning trace IS an inspectable trajectory per run — but the automated trajectory-eval harness that would grade those trajectories does not exist yet.


---

## Why care

You've got a React component with a unit test: render it, click a button, assert the output. The test isn't checking *that React rendered* — it's checking that this specific shape of input produces this specific shape of output. A pure function, in test. Now imagine a different kind of test: the component is part of a multi-step wizard with conditional branches, and you want to assert "the user gets to a correct final state" — but the *path* they take depends on what data the server returned at step 2, and you also want to know "did they make it without going through unnecessary steps?" The old unit test still works for one render, but it can't tell you whether the journey was efficient or whether the wizard handled a step-2 failure gracefully.

That second kind of test is the question this file answers: **how do you evaluate something whose unit of work isn't a single input/output but a sequence of decisions across many steps?** Not "does the final answer look right" (that's LLM eval — one call, one output). The architectural question is **how to grade the trajectory** — was the right tool called, in the right order, with the right recovery from errors, in a reasonable number of steps for a reasonable cost?

**Why answering that question matters:** because final-output eval alone misses the failure modes that cost the most. An agent that returns the right answer after 12 tool calls when 4 would have done costs 3× as much and burns its budget on noise. An agent that recovers from a transient 429 silently is *better* than one that fails — but final-output eval doesn't see the difference. An agent that consistently picks `list_email_campaigns` when it should pick `list_sms_campaigns` may still produce an OK-looking recommendation by coincidence, but the trajectory is wrong and it'll break the moment a real user routes by channel.

Without trajectory-aware eval:
- You ship a "fix" that improves final-answer accuracy by 2% and increases tool calls per investigation by 40%
- A regression in tool-call accuracy goes silent because the model coincidentally finds the right answer through wrong tools
- "It worked on my staging anomaly" doesn't reproduce because staging only exercised one trajectory shape
- Cost per investigation creeps up monthly with no one noticing until the bill arrives

With it:
- Each run produces an inspectable trajectory (tool name, args, duration, result, error)
- You can grade trajectories against expected tool shapes (was `execute_analytics_eql` the right first call?)
- You can grade trajectories against frozen "golden" runs to catch regressions
- You can measure efficiency (steps to completion) and recovery (was a 429 absorbed silently?)

One-line summary: **agent eval is unit-testing for a thing that's no longer pure — you grade the path, not just the destination, because the path is what determines the cost and the failure surface.** Here's what blooming insights has built (the trajectory is recorded; the tests cover the loop's shape) and what it hasn't (the trajectory-eval harness that would grade those trajectories automatically).

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

The strategy in plain English: **the trajectory is data you can inspect, freeze, diff, and grade.** Three things have to be true for trajectory eval to be possible: (1) the trajectory is recorded structurally (not just logged as prose), (2) there's a way to compare a new trajectory against an expected shape, and (3) the comparison is cheap enough to run on every PR. blooming insights has (1) — every reasoning step, tool call, result, error, and final output is in `AgentEvent` records (`lib/mcp/events.ts`) and replayable from the cache. It has a partial version of (2) — the unit tests assert *loop-shape* invariants (forced-final paths, parse fallbacks, budget enforcement). It does not have (3) — no automated trajectory-eval harness that runs a frozen anomaly through the loop and scores the new trajectory against a golden one.

### Move 1 — The trajectory exists as a typed record

The technical thing: **`AgentEvent` is a tagged-union type covering every step the agent takes** — reasoning_step, tool_call_start, tool_call_end, diagnosis, recommendation, done, error. The route streams these to the client as NDJSON, and the route also collects them server-side into `collected: AgentEvent[]` and stashes them via `saveInvestigation` (`lib/state/investigations.ts`).

If you're coming from frontend, this is a structured log instead of `console.log` — same idea as Redux action history, where every state transition is a typed action you can replay and inspect, instead of opaque state mutations.

```
the trajectory IS the inspectable artefact — lib/mcp/events.ts

  AgentEvent union (one variant per step kind):
    { type: 'reasoning_step', step: { agent, kind, content } }
    { type: 'tool_call_start', toolName, agent }
    { type: 'tool_call_end', toolName, agent, durationMs, result, error }
    { type: 'diagnosis', diagnosis }
    { type: 'recommendation', recommendation }
    { type: 'done' }
    { type: 'error', message }

  A whole investigation = AgentEvent[].
  Saved by route.ts L254: saveInvestigation(insightId, collected)
  Replayed by route.ts L128: getCachedInvestigation(insightId)
  Inspectable at: /debug · /api/agent?insightId=<id> (replays the array)
```

The practical consequence: every run produces a trajectory you can open and read. The trajectory tells you exactly which tool was called, with which args (visible at tool_call_start), how long it took (durationMs at tool_call_end), whether it errored, and what the final structured output was. The cached investigation in `lib/state/demo-investigations.json` is a frozen example trajectory you can diff a new run against by eye.

The condition under which it works: the trajectory has to be complete and faithful — every step the loop takes has to emit an event. The current shape covers all of `runAgentLoop`'s observable steps because every call to `onToolCall` / `onToolResult` / `onText` is wired through `hooksFor(agent)` (`route.ts` L181–L195) into a `send()` call that pushes into `collected` while streaming to the client. There's no in-loop decision that goes unrecorded.

### Move 2 — Unit tests grade the LOOP, not the trajectory quality

The technical thing: **~169 vitest tests use the injected `Anthropic` and `McpCaller` seams in `base.ts` to drive the loop with fake responses, then assert the loop's reactive behaviour** — parse-failure fallback, the forced-final tool-less path, the budget cap, the schema gate, validators returning safe defaults.

If you're coming from frontend, this is component-testing posture: render with a mock data layer, click through, assert the right callbacks fired. You're testing *that the component reacts correctly to inputs*, not that the data layer's content is correct.

```
the test seams — base.ts L13–L22 (interface for fakes)

  export interface McpCaller {
    callTool(name, args, opts?): Promise<{result, durationMs, fromCache}>;
  }

  Test injects a fake McpCaller + a fake Anthropic with scripted responses.
  Then asserts:
    ✓ when budget spent → tools removed on next turn (forceFinal)
    ✓ when fake returns empty JSON → parseAgentJson throws → caller
      returns safe default (e.g. [] for anomalies)
    ✓ when fake errors → tc.error set, is_error block pushed, loop
      continues
    ✓ schema gate filters anomalies the workspace can't run
    ✓ ...
```

What these tests do well: they pin down the *invariants* of the loop. The forced-final turn always strips tools (`base.ts` L101). A budget overrun always triggers the synthesis instruction. A parse failure always returns the type's safe default rather than throwing through the route. Those invariants are the load-bearing safety properties — if any of them broke, the system would silently misbehave. The 169 tests are how you sleep at night knowing they hold.

What these tests don't do: grade whether the trajectory itself was *good*. They assert "given fake response X, the loop did Y" — they don't assert "given anomaly X, the model's chosen tools and order were optimal." That's the gap a trajectory-eval harness would fill.

The condition under which it works: the fakes have to be representative. A fake `McpCaller` that returns `{count: 42000}` lets the loop run; whether the model actually decides correctly *given that count* is a model-quality question, not a loop-shape question. The tests are deliberately scoped to the latter.

### Move 3 — What's not yet built: the trajectory-eval harness (Case B)

The technical thing: **a harness that runs the real (or near-real) agent loop on a curated set of input cases and scores each resulting trajectory against expected outcomes.**

A trajectory-eval harness, in its mature form, has four pieces:

```
trajectory-eval harness (NOT in this codebase yet)

  ┌─ frozen input set ────────────────────────────────────────┐
  │  ~30–100 representative anomalies / queries / workspaces  │
  │  versioned in the repo, not mocked                        │
  └──────────────────────┬────────────────────────────────────┘
                         ▼
  ┌─ run the agent ───────────────────────────────────────────┐
  │  runAgentLoop on each input → trajectory                  │
  │  may use cached MCP responses for determinism             │
  └──────────────────────┬────────────────────────────────────┘
                         ▼
  ┌─ score the trajectory ────────────────────────────────────┐
  │  metrics:                                                  │
  │    task success rate     (final output passes validators)│
  │    tool-call accuracy    (expected tools called, in order)│
  │    trajectory efficiency (steps & cost to completion)     │
  │    recovery rate         (loop absorbed transient errors) │
  └──────────────────────┬────────────────────────────────────┘
                         ▼
  ┌─ compare vs frozen golden ────────────────────────────────┐
  │  diff new trajectory against last-good trajectory          │
  │  PR comment: "tool calls +2, cost +$0.04, success same"    │
  └────────────────────────────────────────────────────────────┘
```

The practical consequence of NOT having this: model improvements (or regressions) ship blind. A prompt change might improve answer quality and add 3 tool calls per investigation; both are real effects and only the second one shows up in the bill weeks later. The streamed trace makes spot-checking easy (open `/debug`, eyeball the trajectory) but spot-checking 30 inputs by hand doesn't catch slow drift.

Why it's not built (the honest reason): the agent loop is gated behind real MCP calls to a rate-limited remote host. To freeze trajectories, you'd need either (a) cached MCP responses replayable from a fixture file (the seed file is a start) or (b) a mock MCP server that returns deterministic results. Both are real work. The 169 unit tests + the inspectable streamed trace are how the codebase currently catches the failure modes that matter most; trajectory eval is the next escalation if model-quality drift becomes a real concern.

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
What's built (✓) vs what's not yet (✗)

  ┌──────────── LOOP-SHAPE TESTS (✓ built) ──────────────────────┐
  │ ~169 vitest tests with injected Anthropic + McpCaller fakes  │
  │ assert invariants:                                            │
  │   forced-final turn strips tools           (base.ts L101)    │
  │   budget cap triggers synthesisInstruction (base.ts L98)     │
  │   parse failures → safe defaults           (validate.ts)     │
  │   schema gate excludes unrunnable cats     (categories.ts)   │
  └──────────────────────────────────────────────────────────────┘
                            ▲
                            │ test the LOOP, not the trajectory quality
                            │
  ┌──────────── INSPECTABLE TRAJECTORY (✓ built) ────────────────┐
  │ AgentEvent[] streamed as NDJSON + cached server-side          │
  │   tool_call_start { toolName, agent }                          │
  │   tool_call_end { toolName, durationMs, result, error }        │
  │   reasoning_step { kind, content }                             │
  │   diagnosis / recommendation / done / error                    │
  │ stored: lib/state/investigations.ts (Map + dev cache)         │
  │ viewable: /debug, /api/agent?insightId=<id>                    │
  └──────────────────────────────────────────────────────────────┘
                            ▲
                            │ replayable for eye inspection — no harness
                            │
  ┌──────────── TRAJECTORY-EVAL HARNESS (✗ not yet built) ───────┐
  │ would add:                                                    │
  │   frozen input set (30–100 anomalies / queries)               │
  │   deterministic MCP fixtures (replay or mock)                 │
  │   trajectory scoring:                                         │
  │     • task success rate                                       │
  │     • tool-call accuracy (expected tools, expected order)     │
  │     • trajectory efficiency (steps + $ to completion)         │
  │     • recovery rate (was a 429 absorbed cleanly)              │
  │   cross-family judge + frozen golden + human spot-check       │
  │ would catch what unit tests + spot-checks miss:               │
  │   silent regressions in tool choice                           │
  │   cost drift per investigation                                │
  │   recovery degradation under load                             │
  └──────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Case A — partial (loop-shape testing + inspectable trajectory).**

**Loop-shape unit tests (the ~169):**
**Directory:** `tests/` (vitest)
**Seams used:** the `McpCaller` interface (`lib/agents/base.ts` L16–L22) and the Anthropic client passed into `runAgentLoop()` — both injected, no network in tests.

**The streamed trajectory record:**
**File:** `lib/mcp/events.ts` — `AgentEvent` union
**Route boundary:** `app/api/agent/route.ts` — `hooksFor(agent)` (L181–L195) wires `runAgentLoop`'s `onText` / `onToolCall` / `onToolResult` into `send(...)` which appends to `collected: AgentEvent[]` (L171–L175)
**Persistence:** `lib/state/investigations.ts` L11/L22/L30 (in-memory `Map`) + the dev cache file + the committed demo seed
**Inspection surfaces:** `GET /api/agent?insightId=<id>` replays the array; `/debug` views it; the investigation page consumes it via `lib/hooks/useInvestigation.ts`

**Case B — not yet implemented.**

There is no automated trajectory-eval harness in this codebase. The honest reason: the agent loop hits a rate-limited live MCP server, so deterministic trajectory regression requires either replayable MCP fixtures (the seed file is a start) or a mock MCP server, and neither is wired up. The cost so far is model-quality drift would have to be caught by hand-spot-checking the streamed trace, not by an automated diff against a golden trajectory.

```
shape of what would change to build it (not written):
  // tests/eval/trajectories.eval.ts (new)
  for (const goldenInput of frozenAnomalies) {
    const traj = await runMonitoringWithFixedMcp(goldenInput);
    const score = scoreTrajectory(traj, goldenInput.expected);
    expect(score.toolCallAccuracy).toBeGreaterThan(0.9);
    expect(score.steps).toBeLessThan(goldenInput.maxSteps);
    expect(score.taskSuccess).toBe(true);
  }
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
- LLM observability (`../../study-ai-engineering/05-evals-and-observability/04-llm-observability.md`) → the per-call observability story that complements trajectory-level eval
- LLM-as-judge bias (`../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`) → the evaluator paradox in detail
- Eval set types (`../../study-ai-engineering/05-evals-and-observability/01-eval-set-types.md`) → how to construct the frozen input set a trajectory harness needs

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "how do you evaluate your agent," they're testing whether you understand that the trajectory IS the work — not just the final answer — and whether you've built or honestly named what's needed to grade it. The strong signal is distinguishing loop-shape testing (invariants) from trajectory eval (quality of decisions) and saying which one you have. The weak signal is "we have unit tests."

### Likely questions

[mid] Q: What do the 169 tests actually check?

A: They check the loop's *shape* invariants, not trajectory quality. Using injected fakes (the `McpCaller` interface at `lib/agents/base.ts` L16 and a fake Anthropic client), they assert: the forced-final turn strips tools (`base.ts` L101), the synthesis instruction is appended when the budget is spent (L98), parse failures return safe defaults via the `validate.ts` type guards, the schema gate excludes categories the workspace can't run, and every fake tool error correctly pushes an `is_error` block back into messages. They don't check whether the model's chosen tools were the right ones for a real anomaly — that's a different kind of eval.

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

[senior] Q: You said the trajectory is recorded but not graded. Why didn't you build the harness?

A: Because the cost-to-build was high and the failure mode it would catch hadn't shown up yet. The agent loop hits a rate-limited live MCP server, so a deterministic trajectory-eval harness needs either frozen MCP fixtures (about a week of work to cover the loomi surface) or a mock MCP server (also a week). The inspectable streamed trace + the 169 unit tests cover the failure modes I'm currently worried about — safety invariants, parse fallback, budget enforcement. What they miss is silent drift in tool choice or cost per investigation, and so far that drift hasn't manifested as user-visible pain. The day a prompt change ships and the bill goes up unexpectedly, I'd build the harness — and the first thing I'd build is frozen MCP fixtures, because everything else (scorer, golden diff, CI integration) hangs off determinism.

Diagram:
```
   Built                                Not built
   ┌────────────────────────┐          ┌────────────────────────┐
   │ ~169 vitest tests       │         │ frozen input set       │
   │ injected fakes          │         │ deterministic MCP      │
   │ ▼                       │         │ fixtures               │
   │ asserts loop INVARIANTS │         │ trajectory scorer      │
   │ (safety properties)     │         │ golden-diff CI          │
   │                         │         │ cross-family judge     │
   │ TRACE recorded as       │         │ ▼                       │
   │ AgentEvent[]            │         │ would catch:            │
   │ /debug + cache replay   │         │   tool-choice drift     │
   │ inspectable by eye      │         │   cost drift            │
   └────────────────────────┘          │   efficiency drift     │
                                       └────────────────────────┘
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
Q: If you don't have automated trajectory eval, how do you actually know your agent is working today?

A: Honest answer: I rely on three things, none of which is a substitute for trajectory eval. (1) The 169 unit tests catch the safety surface — forced-final, budget caps, parse fallbacks — so I'm confident the loop won't loop forever, hang on a bad parse, or skip its synthesis. (2) The streamed `AgentEvent[]` trace is inspectable on every run (`/debug` and the investigation cache), so I can spot-check trajectories by eye when something feels off; that catches obvious drift but not subtle drift. (3) The cached demo investigations + the unit tests' fake-driven runs give me a rough baseline of what trajectories should look like; if a new run looks much longer or chooses unexpected tools, I'd notice on a spot-check. What I *don't* have is automated detection of subtle drift across runs — tool-choice regressions, slow cost creep, efficiency degradation. That's the gap. The mitigation is: when the absence of the harness starts to bite (a regression slips through, the bill jumps, a prompt change has unclear effects), I'd build the smallest viable harness — 20 frozen anomalies, replayable MCP fixtures, a scorer that diffs trajectories against goldens — rather than a full LangSmith integration up front.

Diagram:
```
   How I know it works today              What I can't catch today
   ┌────────────────────────────┐         ┌────────────────────────────┐
   │ ✓ 169 tests on loop shape  │         │ ✗ tool-choice drift         │
   │ ✓ trace replayable + viewable│        │ ✗ cost-per-trajectory drift │
   │ ✓ demo seed as eyeball baseline│      │ ✗ recovery degradation       │
   │ ✓ unit tests cover parse,    │        │ ✗ subtle quality regressions│
   │   budget, schema gate         │        │                             │
   │                               │        │ → spot-checks of the trace  │
   │ → safety floor + manual eye   │        │   are the only check today  │
   └────────────────────────────┘         └────────────────────────────┘
   Mitigation when it bites: build smallest-viable harness
   (frozen inputs + MCP fixtures + golden diff), not a full SaaS.
```

### One-line anchors
- "The trajectory is the work — grading only the final answer misses the failure modes that cost the most."
- "169 unit tests guard the loop's shape; the trace IS the trajectory record; the harness that would grade trajectories doesn't exist yet."
- "Agent-as-judge has the same blind-spot bias as LLM-as-judge — cross-family judge + frozen goldens + human spot-checks is the production stack."
- "The build cost of a trajectory harness is real (MCP fixtures, scorer, golden diff) — earned the day model-quality drift starts mattering."
- "Determinism in CI starts with MCP fixtures; everything else hangs off that."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the three boxes: loop-shape tests (built, what they assert), inspectable trajectory (built, what's in `AgentEvent`), trajectory-eval harness (not built, what its four parts would be). Label which file or directory each piece lives in (or "absent" for the harness).

Open the file. Compare.

✓ Pass: three boxes correctly labelled, with `tests/` + `base.ts` seams for box 1, `events.ts` + `investigations.ts` for box 2, "not built" for box 3
✗ Fail: re-read How it works moves 1–3, wait 10 minutes, try again.

### Level 2 — Explain it out loud
Explain "how do you evaluate this agent today" to a colleague who just asked "do you have a benchmark?" No notes. Under 90 seconds.

Checkpoints — did you:
- Distinguish loop-shape testing from trajectory-quality eval?
- Name the `AgentEvent[]` trajectory as the inspectable record?
- Be honest that the automated trajectory-eval harness doesn't exist yet?
- Name the evaluator paradox in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A new prompt for the diagnostic agent ships. It improves the conclusion's clarity in your spot-checks, but a week later the monthly bill is up 30%. Without looking at the file: how would you confirm the prompt change caused it, and what's the smallest piece of trajectory-eval infrastructure you'd build first to catch this kind of regression automatically in the future?

Write your answer (3–5 sentences). Then open `lib/state/investigations.ts` L11 and `lib/mcp/events.ts` to verify what data is already structured enough to compute "tool calls per investigation" from.

### Level 4 — Defend the decision you'd change
"If you were starting today with the same MCP host and team size, would you still defer the trajectory-eval harness, or would you build the minimum viable version up front so you have a baseline before the first prompt drift? What would 'minimum viable' include and what would it cost in build hours?"

Reference: the absence of `langsmith`/`braintrust` in `package.json`, the existing `lib/state/demo-investigations.json` as a possible seed.

### Quick check — code reference test
Without opening any files:
- What interface in `base.ts` is the test seam for fake MCP calls?
- What type holds the streamed trajectory records, and what file is it in?
- What function persists a finished investigation server-side?
- Is there a trajectory-eval harness in this repo? (Yes/no + one sentence why.)

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

## See also

→ `01-context-engineering.md` · → `05-guardrails-and-control.md` · → mechanics: `../../study-ai-engineering/05-evals-and-observability/04-llm-observability.md` · → `../../study-ai-engineering/05-evals-and-observability/01-eval-set-types.md` · → `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
