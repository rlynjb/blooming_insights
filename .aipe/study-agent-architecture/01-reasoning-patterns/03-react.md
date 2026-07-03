# ReAct — the baseline this repo uses

*Industry name: ReAct (Reasoning + Acting) · Language-agnostic*

## Zoom out

```
  Zoom out — ReAct is one shape of step()

  ┌─ agent loop skeleton (kernel) ───────────────┐
  │  step + execute + accumulate + terminate     │
  │        │                                     │
  │        ▼                                     │
  │  step() shapes:                              │
  │    ★ ReAct (default — this repo) ★           │ ← we are here
  │    plan-and-execute                          │
  │    reflexion (adds critic on top)            │
  │    tree of thoughts (branches step())        │
  └──────────────────────────────────────────────┘
```

## Zoom in

ReAct interleaves reasoning and action in one loop: the model thinks aloud, calls a tool, observes the result, thinks again. It's the default single-agent pattern — the strong prior is to start here before any fancier pattern. Every worker in this repo (Monitoring, Diagnostic, Recommendation, Query) is a ReAct loop.

Mechanics of the Thought-Action-Observation exchange are covered in `.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`. This file's job is placement: where ReAct sits in the family and when you'd escalate past it.

## Structure pass

Layers: **route** — **agent instance** — **step function (ReAct-shaped)** — **tool**.

Axis to hold constant: **who decides the next tool?**

```
  One question, held constant — where the LLM's freedom lives

  "who chooses the next tool call?"

  ┌────────────────────────────────────────────────┐
  │ outer route: pipeline                          │  → CODE decides stage
  └────────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ inside stage: aptkit ReAct loop           │  → LLM decides tool
      └──────────────────────────────────────────┘
          ┌────────────────────────────────────┐
          │ inside tool: EQL execution         │  → data-source runs it
          └────────────────────────────────────┘
```

The LLM's freedom is scoped to a single altitude — "which of these MCP tools next, with what args." Everything above and below is deterministic.

## How it works

### Move 1 — the shape

You've written a `while` loop with a `switch` inside — each iteration reads state, picks a branch, does the branch, loops. ReAct is that pattern where the `switch` is an LLM call and the branches are tool names.

```
  ReAct — the Thought-Action-Observation loop

  ┌──────────────────────────────────────────────────┐
  │  turn 1: Thought  "let me check X"               │
  │          Action   → execute_analytics_eql(…)     │
  │          Obs      ← 42.3% down                   │
  │                                                  │
  │  turn 2: Thought  "so it might be Y"             │
  │          Action   → execute_analytics_eql(…)     │
  │          Obs      ← isolated to USA              │
  │                                                  │
  │  turn 3: Thought  "confident enough"             │
  │          Final    → Diagnosis JSON               │
  └──────────────────────────────────────────────────┘
```

### Move 2 — the specific instance in this repo

**Where the loop lives.** `lib/agents/diagnostic.ts:36-67` constructs an `AptKitDiagnosticInvestigationAgent` and calls `agent.investigate(anomaly)`. The aptkit class owns the actual while-loop; the DiagnosticAgent class is a compatibility wrapper that binds the three adapters.

**The three adapters that make ReAct work.** aptkit knows about "a model provider," "a tool registry," "a trace sink" — it does not know about Anthropic, MCP, or the Blooming NDJSON format. The bridge is `lib/agents/aptkit-adapters.ts`:

```ts
// lib/agents/aptkit-adapters.ts (roles)
class AnthropicModelProviderAdapter implements ModelProvider {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (this.budget?.exceeded()) throw new BudgetExceededError(...);
    // dispatch anthropic.messages.create with cache_control on the system prompt
    // return { content, stopReason, usage }
  }
}
class BloomingToolRegistryAdapter implements ToolRegistry {
  async executeToolCall(name, args, signal) {
    return this.dataSource.callTool(name, args, { signal });
  }
}
class BloomingTraceSinkAdapter implements CapabilityTraceSink {
  onEvent(event: CapabilityEvent) {
    // translate to Blooming AgentEvent + fire hooks.onToolCall/onText/onCapabilityEvent
  }
}
```

Each adapter is one of the four skeleton parts from `02-agent-loop-skeleton.md`: model → the step function, tool registry → execute, trace sink → observability on top of accumulate. Terminate is inside aptkit itself (iteration cap) plus the budget adapter check.

**The escalation gate — why start with ReAct.** Every worker in this repo defaulted to ReAct. That was a decision, not an accident. The rule:

```
  ReAct is the default. Escalate only when a specific failure names itself.

  Default to ReAct.
    │
    ├─ measure: success rate, tool-call accuracy, latency, cost
    │
    └─ only escalate when a SPECIFIC failure mode is identified
       that ReAct cannot address:
         → plan-and-execute if you need a global plan (structured tasks)
         → reflexion if output quality is uneven (add critic)
         → multi-agent if the failure is genuinely decomposable
```

For diagnostic investigations, ReAct is the right pick because the path is genuinely dynamic — the next hypothesis to test depends on what the last EQL returned. A plan-and-execute here would build a stale plan on turn 1 and burn budget re-planning as observations came in.

**What the ReAct loop looks like on a real diagnostic run** (from a captured trace):

```
  Real trace — diagnosing "USA purchase_revenue · -38.4%"

  turn 1: agent reads anomaly + schema summary
          → execute_analytics_eql: "sum event purchase.total_price"
            group by customer.state, current 90d vs prior 90d
          ← Texas down 82%, California down 12%, others flat

  turn 2: agent hypothesizes: "concentrated in one state"
          → execute_analytics_eql: "count event checkout by state"
            with checkout_step=payment
          ← Texas checkouts halved at payment step

  turn 3: agent hypothesizes: "payment failure spike in TX"
          → execute_analytics_eql: "count event payment_failure by state"
          ← Texas payment_failure up 340%, others flat

  turn 4: agent emits final Diagnosis:
          conclusion: "payment failure spike concentrated in Texas"
          evidence: [3 EQL queries + raw counts]
          affectedCustomers: ~4,200 in TX
```

Four turns, three tool calls, one final structured output. Nothing else in the code named "check Texas payment_failures" — the model chose that path by reading its own turn-2 observation.

### Move 3 — the principle

Most teams jump past ReAct prematurely. Naming "I built a ReAct baseline, measured it, and escalated only when [specific failure]" is a stronger signal than reaching for multi-agent first. The pattern's real power is its ordinariness — it's the simplest thing that works, and most tasks don't need anything more.

## Primary diagram

```
  ReAct — the load-bearing shape in this repo

  ┌─ DiagnosticAgent (compatibility wrapper) ────────────────────┐
  │  new AptKitDiagnosticInvestigationAgent({                   │
  │    model:  AnthropicModelProviderAdapter (Sonnet 4.6)       │
  │    tools:  BloomingToolRegistryAdapter    (DataSource)       │
  │    trace:  BloomingTraceSinkAdapter        (NDJSON hooks)    │
  │  }).investigate(anomaly)                                     │
  └──────────────────────┬──────────────────────────────────────┘
                         │ aptkit runs the loop:
                         ▼
  ┌────────────────────────────────────────────────────────────┐
  │  while not done:                                            │
  │    ┌────────────────┐  content: [text, tool_use]            │
  │    │ Thought (text) │◄─────────────────────────────┐        │
  │    └────────┬───────┘                              │        │
  │             ▼ tool_use                             │         │
  │    ┌────────────────┐                              │         │
  │    │ Action         │  DataSource.callTool         │         │
  │    │ (tool_use)     │  (via BloomingToolRegistry)  │         │
  │    └────────┬───────┘                              │         │
  │             ▼ result                               │         │
  │    ┌────────────────┐                              │         │
  │    │ Observation    │  append tool_result block ───┘         │
  │    │ (tool_result)  │                                        │
  │    └────────────────┘                                        │
  │                                                              │
  │  final → Diagnosis (structured JSON output)                  │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

ReAct was named by Yao et al. (Google Brain / Princeton, Oct 2022) — the paper showed that interleaving reasoning traces with actions beat pure chain-of-thought on HotpotQA and beat pure action-taking on ALFWorld. The interleaving is the whole point: reasoning grounds action (fewer bad tool calls), action grounds reasoning (fewer hallucinated facts).

The Anthropic + OpenAI tool-calling APIs make ReAct almost invisible — the model emits `tool_use` blocks natively, the harness runs them, the reasoning traces are the text that comes back interleaved. You often don't see the "Thought/Action/Observation" scaffolding because it's implicit in the message shape. That's why teams sometimes think they're not using ReAct when they are.

**What comes after ReAct.** When ReAct hits a ceiling, the two most common escalations are plan-and-execute (for tasks with a clear global plan — see `04-plan-and-execute.md`) and reflexion (add a critic loop on top — see `05-reflexion-self-critique.md`). Both keep the ReAct kernel; both add structure around it.

## Interview defense

**Q: Why did you pick ReAct for the diagnostic agent?**

The diagnostic path is dynamic — the next hypothesis to test depends on what the last EQL returned. A plan-and-execute here would build a plan on turn 1 (before seeing any data) and burn budget re-planning as observations came in. ReAct's per-turn reasoning is a better fit for the exploratory shape.

I also treat ReAct as the default across all four agents in the repo (monitoring, diagnostic, recommendation, query) — the escalation rule is "measure ReAct first, escalate only when a specific failure mode names itself." None of them has hit that ceiling yet.

*Anchor visual:* the three-adapter diagram above.

**Q: What tells you it's time to escalate past ReAct?**

Two signals. First, the model burns budget without converging — same shape as a bad tool call, but repeated. That's when plan-and-execute helps (commit to a plan up front, execute cheaply). Second, output quality is uneven — some diagnoses good, some sloppy. That's when reflexion helps (critic scores, loop on low-confidence).

I haven't hit either yet in this repo. The baseline is p50 50s / ~$0.09 per case, and quality passes the LLM-as-judge rubric. If either drifted, escalation would be the next move.

## See also

- **`02-agent-loop-skeleton.md`** — the kernel this pattern instantiates.
- **`04-plan-and-execute.md`** — the escalation for structured tasks.
- **`05-reflexion-self-critique.md`** — the critic-loop escalation.
- **`.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`** — Thought/Action/Observation mechanics.
