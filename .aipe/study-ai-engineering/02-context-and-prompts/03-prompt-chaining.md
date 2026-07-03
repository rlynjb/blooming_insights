# 03 — Prompt chaining

**Type:** Industry standard. Also called: pipeline of prompts, multi-stage LLM, sequential agents.

## Zoom out, then zoom in

The load-bearing pattern in this codebase's product logic. The diagnose → recommend flow is a chain: two stages, each with one job, connected by a typed handoff.

```
  Zoom out — the product's chain, in one frame

  ┌─ Product flow ────────────────────────────────────────────────────┐
  │                                                                   │
  │  Anomaly                                                          │
  │     │                                                             │
  │     ▼                                                             │
  │  ┌─────────────────────────┐                                      │
  │  │  DiagnosticAgent         │  one job: diagnose the cause         │
  │  │  (Sonnet, ≤6 tool calls) │  produces Diagnosis                  │
  │  └──────────┬──────────────┘                                      │
  │             │  Diagnosis (structured)                              │
  │             ▼                                                     │
  │  ┌─────────────────────────┐                                      │
  │  │  RecommendationAgent     │  one job: propose the action         │
  │  │  (Sonnet, own tool loop) │  produces Recommendation[]           │
  │  └──────────┬──────────────┘                                      │
  │             │  Recommendation[]                                   │
  │             ▼                                                     │
  │        UI renders                                                 │
  │                                                                   │
  │  ★ THIS CONCEPT ★                                                 │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Each stage is a full agent (ReAct loop, tools, streaming trace). The handoff is a typed object (`Diagnosis`), not the raw trace. Both stages share one `BudgetTracker` so the ceiling counts total spend across both.

## Structure pass

**Layers:**
- Outer: the product-facing chain (feed → investigate → recommend)
- Middle: the two agents and their trace surfaces
- Inner: each agent's own tool-use loop

**Axis: what flows between stages?**
- Between stages: the typed conclusion (`Diagnosis`), NOT the trace
- Within a stage: raw messages array, tool_use, tool_result
- To the UI: streamed `AgentEvent` NDJSON

**Seam:** the `Diagnosis` object handed to `RecommendationAgent.propose(anomaly, diagnosis)`. Above: two independent agents. Below: shared budget, shared session id.

## How it works

### Move 1 — the mental model

You've written a POST handler that calls a fetch, awaits it, then passes its parsed body to another fetch. Two sequential external calls, connected by a data handoff. Prompt chaining is the same, except each "call" is a full LLM agent with its own tool loop.

```
  Chain — sequential stages, typed handoff between

  ┌─── Stage 1 ────────┐          ┌─── Stage 2 ────────┐
  │  DiagnosticAgent    │          │  RecommendationAgent│
  │                     │          │                     │
  │  input:  Anomaly    │          │  input:  Anomaly    │
  │                     │          │          + Diagnosis│
  │  tools:  MCP tools  │          │  tools:  MCP tools  │
  │                     │          │                     │
  │  output: Diagnosis  │──handoff─►│  output: Rec[]     │
  └─────────────────────┘  (typed) └─────────────────────┘
       ~50s p50                          ~51s p50
       ~$0.03-0.05                       ~$0.04-0.06

                    total ≈ 100-110s, ~$0.09
                    (shared BudgetTracker)
```

### Move 2 — walk the mechanism

**The handoff site.**

`eval/run.eval.ts:198-269` (also `app/api/agent/route.ts` for live). Two agent invocations, sequential, sharing state:

```typescript
// eval/run.eval.ts:189-269 (abbreviated)
const budget = new BudgetTracker({ maxCostUsd: budgetLimitUsd });

// ─── diagnose ────────────────────────────────────
const diagnosticAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sessionId);
const diagnosis = await diagnosticAgent.investigate(anomaly, {
  onToolResult: (tc) => diagnosisToolCalls.push({ ...tc }),
  onCapabilityEvent: (ev) => diagnosisTrace.push(ev),
  budget,                    // ← shared tracker, first phase
});

// ─── recommend ───────────────────────────────────
const recommendationAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools, sessionId);
const recommendations = await recommendationAgent.propose(
  anomaly,
  diagnosis,                 // ← the typed handoff
  {
    onToolResult: (tc) => recommendationToolCalls.push({ ...tc }),
    onCapabilityEvent: (ev) => recommendationTrace.push(ev),
    budget,                  // ← same tracker, continues accumulating
  },
);
```

**What's typed at the boundary.**

The `Diagnosis` object (`lib/mcp/types.ts`) — `{conclusion, evidence[], hypothesesConsidered[], affectedCustomers?, confidence?}`. Not the diagnostic agent's trace, not its messages array, not its tool call history. Just the structured conclusion. The RecommendationAgent takes that conclusion + the original anomaly and starts its own loop with a fresh messages array.

**Why the trace doesn't cross.**

Because the recommendation agent's job is different: propose a lever + rationale + steps. It doesn't need to re-reason about the evidence — that work is done, encoded in the `Diagnosis.evidence` field. Passing the raw trace would balloon the recommendation agent's input context AND invite it to re-litigate the diagnosis instead of building on it.

**Shared budget, split agents.**

`BudgetTracker` is created once at the top of the investigation. Injected into BOTH agents' `AgentHooks.budget`. Every model turn in EITHER agent adds to the same running total. If diagnose eats up 90% of the budget, recommend gets checked against the remaining 10% before its first model turn. This is the `06-production-serving/02-llm-cost-optimization.md` mechanism at the chain level.

**Two chains in one product.**

There's a second chain in this codebase: monitoring → diagnostic → recommendation. Monitoring produces `Anomaly[]`; the user clicks one; diagnostic + recommendation run over the chosen anomaly. That's a chain with a human-in-the-loop step in the middle (the user's click).

### Move 3 — the principle

Chain when each stage has one job. Two agents, each with a narrow task, connected by a typed handoff — that's easier to debug, cheaper to iterate on (change one stage without retesting the other), and easier to evaluate (separate rubrics per stage). One monster agent doing "diagnose and recommend in one loop" would blur the failure modes and make it impossible to tell which part broke.

## Primary diagram

```
  The diagnose → recommend chain — the load-bearing product flow

  ┌─ start ───────────────────────────────────────────────────────────┐
  │  Anomaly (from monitoring or user selection)                      │
  │  BudgetTracker created (default $2 ceiling)                       │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Stage 1: Diagnostic ───────▼─────────────────────────────────────┐
  │                                                                   │
  │  DiagnosticAgent.investigate(anomaly, { budget, hooks })           │
  │      │                                                             │
  │      ▼                                                             │
  │  AptKit's DiagnosticInvestigationAgent runs its loop               │
  │  ~5-10 model turns                                                 │
  │  ≤6 tool calls (execute_analytics_eql etc.)                        │
  │  budget accumulates: ~$0.03-0.05 spent                             │
  │  streams: reasoning_step, tool_call_start, tool_call_end           │
  │      │                                                             │
  │      ▼                                                             │
  │  returns: Diagnosis { conclusion, evidence[], hypotheses[] }       │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │  typed handoff
  ┌─ Stage 2: Recommendation ───▼─────────────────────────────────────┐
  │                                                                   │
  │  RecommendationAgent.propose(anomaly, diagnosis, { budget, hooks })│
  │      │                                                             │
  │      ▼                                                             │
  │  AptKit's RecommendationAgent runs its own loop                    │
  │  budget continues from where diagnose left off                     │
  │  fresh messages array (not passed the diagnose trace)              │
  │      │                                                             │
  │      ▼                                                             │
  │  returns: Recommendation[] { title, feature, steps[], impact }    │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
                            UI renders
```

## Elaborate

Alternative to chaining: one big agent that does both jobs in one loop. That's viable — GPT-4 or Sonnet can absolutely handle a "diagnose then recommend" prompt in a single agent invocation. The reasons this repo chains anyway:

1. **Evaluability.** Two rubrics, one per stage (`diagnosis-quality.ts`, `recommendation-quality.ts`). If the whole thing were one agent, the rubric would have to score both jobs at once and it would be hard to say "the diagnosis was fine but the recommendation missed."
2. **Streaming shape.** The product surfaces two distinct pages (investigate → recommend), each with its own status log. Two agents fit that shape naturally; one agent would need artificial phase markers.
3. **Independent iteration.** Improving the recommendation prompt without retesting diagnose is cheaper. Chain lets you split ownership.

Chaining is a common pattern in production LLM systems. Examples: RAG (retrieve → generate as a chain), question-decomposition (break question → solve sub-questions → synthesize), refinement (draft → critique → revise). All share the shape: multiple stages, typed handoff, each stage narrowly scoped.

## Project exercises

### Exercise — swap the sequence for parallel diagnostics

- **Exercise ID:** C2.3-A · Case A (chain exercised; alt shape explores parallel).
- **What to build:** on the feed page, when the user clicks an anomaly, run diagnose AND a shorter "quick recommendation" in parallel (against the same anomaly, both without the other's output). Compare quality vs the sequential chain in an eval. Under what conditions does parallelism buy speed without hurting quality?
- **Why it earns its place:** shows you understand chaining is a design choice, not the only shape. Interviewer signal: "here's when I'd chain, here's when I'd parallelize, and here's how I measured the tradeoff."
- **Files to touch:** `lib/agents/quick-recommendation.ts` (new; simpler prompt, no diagnosis input), `app/api/agent/route.ts` (parallel path), extend `eval/run.eval.ts` to run both shapes.
- **Done when:** report shows time-to-first-recommendation and quality-vs-sequential across 5 golden cases.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Why chain diagnose and recommend instead of one big agent?**

Three reasons. First, evaluability — I have separate rubrics per stage, so I can measure "the diagnosis is good but the recommendation is off" without ambiguity. Second, streaming — the product has two pages (investigate + recommend); two agents map to that split naturally. Third, iteration — I can change the recommendation prompt without re-running diagnose evals. If it were one loop, every prompt change would invalidate the whole rubric surface.

**Q: What's actually passed between stages?**

The typed `Diagnosis` object — conclusion, evidence array, hypotheses considered. NOT the diagnostic agent's messages array or tool call trace. The recommendation agent starts with a fresh messages array; the diagnosis becomes context in its first user message. Passing the whole trace would balloon the recommendation input AND invite the model to re-litigate the diagnosis instead of building on it.

```
  Handoff shape

  Diagnostic agent → [Diagnosis object] → Recommendation agent
                        ↑
                    just the conclusion, not the trace
```

**Q: How is cost tracked across the chain?**

One `BudgetTracker` instance is created at the top of the investigation and passed as `AgentHooks.budget` to BOTH agents. Every model turn in either agent adds to the same accumulator. If diagnose burns through most of the ceiling, recommend gets checked against what's left before its first model turn. Shared state, not per-agent quotas.

## See also

- `04-agents-and-tool-use/01-agents-vs-chains.md` — the shape distinction between an agent and a chain
- `eval/run.eval.ts:198-269` — the two-stage handoff in the eval runner
- `lib/agents/diagnostic.ts`, `lib/agents/recommendation.ts` — the two stages
- `lib/agents/budget.ts` — the shared ceiling that spans both
