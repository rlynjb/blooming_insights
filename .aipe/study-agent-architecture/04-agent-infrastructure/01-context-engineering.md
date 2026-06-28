# Context engineering

*Industry name: context engineering — Industry standard. The superset of prompt engineering + RAG.*

The discipline RAG and prompt engineering are subsets of. **Most agent failures are not model failures — they are context failures.** This repo's biggest context-engineering decision: schema-gate the monitoring agent's category list before the model ever sees the prompt, so the model never wastes budget on unsupported categories.

## Zoom out — where this concept lives

Context engineering happens at the agent-construction boundary — the place where you decide what goes into the model's window for the next step. In this repo, that boundary is the AptKit agent classes' constructor, fed by the route handlers.

```
  Where context engineering lives in blooming insights

  ┌─ Service layer ────────────────────────────────────────────┐
  │  /api/briefing route                                        │
  │   schemaCapabilities → coverageReport → runnableCategories  │ ← context decision
  │   feeds runnable categories into MonitoringAgent prompt     │   happens HERE
  │                                                              │
  │   schemaSummary(workspace) ← caps schema at 20×10            │ ← context budget
  └────────────────────┬───────────────────────────────────────┘
                       ▼
  ┌─ Agent layer (the consumer) ───────────────────────────────┐
  │  MonitoringAgent prompt has {categories} and {schema} slots │
  │  Diagnostic/Recommendation/Query prompts have their own     │
  └─────────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **what's in the model's window on this step, and who decided?**

```
  Context engineering — what fills the window

  ┌─ system prompt (large, stable) ──────────────────────────┐
  │  schemaSummary (capped, 20 events × 10 props)            │
  │  categories checklist (runnable only, schema-gated)       │
  │  tool catalog (filtered by tool policy)                  │
  └──────────────────────────────────────────────────────────┘
  ┌─ user message (small, per-task) ──────────────────────────┐
  │  the specific anomaly to investigate / question to answer │
  └──────────────────────────────────────────────────────────┘
  ┌─ accumulated history (grows per turn) ────────────────────┐
  │  prior assistant turns + tool_result blocks               │
  │  bounded by maxTurns + maxToolCalls (sec 02-agent-loop)   │
  └──────────────────────────────────────────────────────────┘
```

The lesson lives in what's NOT in the window:
- NOT the full 112KB workspace schema (capped at 20 events × 10 props)
- NOT the categories the workspace can't run (filtered before injection)
- NOT all tools (filtered by per-agent tool policy)
- NOT other agents' state (message passing, see `../03-multi-agent-orchestration/08-shared-state-and-message-passing.md`)

Each "NOT" is a context-engineering decision.

## How it works

### Move 1 — the mental model

You know cache hit rates — what you keep hot in cache vs evict matters more than the cache implementation. Context engineering is the same: what you put in the model's window matters more than the prompt's wording. The discipline is *curating what fills the window for the next step*. Bigger context windows don't solve this — they make room for more noise.

```
  Context engineering is the superset

  ┌───────────────────────────────────────────────┐
  │            Context engineering                │
  │  (everything the model sees at inference time)│
  │                                               │
  │   ┌─────────────┐  ┌─────────────┐            │
  │   │   prompt    │  │     RAG     │            │
  │   │ engineering │  │ (retrieval) │            │
  │   └─────────────┘  └─────────────┘            │
  │   ┌─────────────┐  ┌─────────────┐            │
  │   │   memory    │  │ tool outputs│            │
  │   └─────────────┘  └─────────────┘            │
  │   ┌─────────────┐  ┌─────────────┐            │
  │   │ history      │  │ user profile│            │
  │   └─────────────┘  └─────────────┘            │
  └───────────────────────────────────────────────┘
```

### Move 2 — the load-bearing context-engineering decisions in this repo

**Decision 1: schema-gate the category checklist.**

The MonitoringAgent's prompt has a `{categories}` slot that lists which anomaly categories to scan. Without context engineering, the prompt would list all 10 categories and let the model figure out which ones it can run against this workspace's data — wasting budget on categories the workspace can't support (e.g., scanning for "search failure" when the workspace has no `search` events).

The fix lives in `lib/agents/categories.ts`:

```typescript
// lib/agents/categories.ts:35-46 — filter categories by what the workspace can actually run
export function coverageReport(available: Set<string>): CoverageReport {
  return aptKitCoverageReport(CATEGORIES.map(toAptKitCategory), available).map((item) => ({
    category: item.category as CategoryId,
    label: item.label,
    coverage: item.coverage,
    ...(item.missing && item.missing.length ? { missing: item.missing } : {}),
  }));
}

export function runnableCategories(available: Set<string>): AnomalyCategory[] {
  return aptKitRunnableCategories(CATEGORIES.map(toAptKitCategory), available).map(toBloomingCategory);
}
```

And in the route handler:

```typescript
// app/api/briefing/route.ts:235-237
const capabilities = schemaCapabilities(schema);
const coverage = coverageReport(capabilities);
const runnable = runnableCategories(capabilities);
```

The runnable list is fed into the agent:

```typescript
// app/api/briefing/route.ts:262
const anomalies = await agent.scan({...}, runnable);
```

What this is: a *pre-prompt filter*. The model never sees categories that can't be run — they're removed before the prompt is rendered. This saves tokens (smaller checklist), saves tool calls (no wasted exploration), and saves UX (the coverage grid shows the user honestly what was checked).

**Decision 2: cap the schema summary.**

The full workspace schema can be 100+ KB. Dropping that into every agent's system prompt is wasteful and would push out into context-bloat territory. The fix lives in `lib/agents/monitoring.ts`:

```typescript
// lib/agents/monitoring.ts:19-60 (paraphrased)
export function schemaSummary(schema: WorkspaceSchema): string {
  const MAX_EVENTS = 20;          // top 20 events only
  const MAX_PROPS_PER_EVENT = 10; // each capped at 10 properties
  const MAX_CPROPS = 30;          // 30 customer properties max

  const eventsText = schema.events
    .slice(0, MAX_EVENTS)
    .map((e) => {
      const props = e.properties.slice(0, MAX_PROPS_PER_EVENT).join(', ');
      return `  - ${e.name} (${e.eventCount}): ${props || '(no properties)'}`;
    })
    .join('\n');
  // ...
}
```

What this is: a budget-aware schema compactor. The top-N events by count are kept; everything else is dropped. The model gets enough to write reasonable EQL without drowning in long-tail events the user almost never cares about.

**Decision 3: filter tools by capability.**

Each AptKit agent has a `toolPolicy` listing only the tools it should see. Even though the route fetches the full MCP tool catalog (~30 tools), the agent's `BloomingToolRegistryAdapter.listTools()` is filtered by the agent's policy before the model sees it:

- `anomalyMonitoringToolPolicy`: 4 tools (`execute_analytics_eql`, `get_metric_timeseries`, `get_segments`, `get_anomaly_context`)
- `diagnosticInvestigationToolPolicy`: 11 tools
- `recommendationToolPolicy`: 13 tools (different set — feature-discovery)
- `queryToolPolicy`: 32 tools (the union — broadest grant)

What this is: principle of least privilege at the tool layer. Each agent only sees the tools it needs; smaller tool grant = shorter prompt = better focus + less risk of the model picking an inappropriate tool.

**Decision 4: message-pass, don't blackboard.**

Covered in `../03-multi-agent-orchestration/08-shared-state-and-message-passing.md`. Each agent's input is exactly what it needs — the DiagnosticAgent gets an Anomaly; the RecommendationAgent gets an Anomaly + Diagnosis. Neither sees the other's full trajectory. **This is context engineering at the topology layer.**

**What's NOT a context-engineering decision in this repo:**

- No long-term memory retrieval (no past investigations indexed for semantic recall). Could be — see `../02-agentic-retrieval/01-agentic-rag.md`.
- No user profile injection (no per-user persona or preference loaded into context). Not relevant for this product yet — one workspace per session.
- No dynamic context compression mid-loop (the agent doesn't summarize its own history when context gets long). The per-agent budget caps make this unnecessary.

### Move 3 — the principle

Prompt engineering gets the first good output; context engineering keeps the thousandth good. Bigger context windows do not solve this — they make room for more noise. The job is curating *what fills the window for the next step*, and in a multi-agent system, *which agent sees what*. Every "NOT in the window" decision is a context-engineering decision; over-filling the window is the default mistake, and the senior move is reading your own prompts and asking what's earning its tokens.

## Primary diagram

The four context-engineering decisions in this repo, mapped to where they live:

```
  Context engineering in blooming insights — what's filtered before injection

  ┌─ schema-gate (lib/agents/categories.ts) ────────────────┐
  │  10 categories → runnable subset (typically 5-8)         │
  │  filtered BEFORE the MonitoringAgent prompt is rendered  │
  └──────────────────────────────────────────────────────────┘

  ┌─ schema summary cap (lib/agents/monitoring.ts) ──────────┐
  │  full schema → top 20 events × 10 props each              │
  │  + 30 customer properties cap                              │
  │  fits in ~5-8KB instead of 100+KB                          │
  └──────────────────────────────────────────────────────────┘

  ┌─ tool policy filter (@aptkit, anomalyMonitoringToolPolicy │
  │  + 3 others) ─────────────────────────────────────────────┐
  │  full MCP catalog (~30 tools)                             │
  │  → 4 (monitoring) / 11 (diagnostic) /                     │
  │    13 (recommendation) / 32 (query — union)               │
  └──────────────────────────────────────────────────────────┘

  ┌─ message passing not blackboard (route handler) ─────────┐
  │  each agent sees only its input arg                       │
  │  DiagnosticAgent: anomaly only                            │
  │  RecommendationAgent: anomaly + diagnosis only            │
  │  no agent sees another agent's tool-call history          │
  └──────────────────────────────────────────────────────────┘

  Combined effect: each agent's prompt fits in a small window,
  containing only what it needs. No lost-in-the-middle. No
  surprise context bloat. Bounded cost per call.
```

## Elaborate

Context engineering crystallized as a term in 2024 when the prompt-engineering community realized that "write a better prompt" wasn't the right framing for agent systems. The model's window contains way more than the prompt — tool outputs, prior turns, retrieved chunks, user profile, system state. The full surface is the *context*; the prompt is just the seed.

The production wisdom: most agent failures trace back to *what was in the window*, not *how the prompt was worded*. Examples:
- The model hallucinated a fact → the right citation wasn't in the retrieved chunks
- The model picked the wrong tool → the tool's description was buried in a 30-tool grant
- The model lost the thread → the conversation history grew past the model's effective attention span
- The model contradicted itself → two agents wrote conflicting state to a shared blackboard

The fixes are all context-level: better retrieval (RAG mechanics), tighter tool grants (principle of least privilege), bounded turn budgets (the kernel from `02-agent-loop-skeleton.md`), message passing instead of blackboards (`../03-multi-agent-orchestration/08-shared-state-and-message-passing.md`). None of these are "write a better prompt"; all of them are "what goes in the window."

The escalation past context engineering is *context compression* — letting an agent summarize its own history when it grows long. This repo doesn't reach for that because the per-agent caps keep histories small enough that compression isn't worth the extra LLM call.

## Interview defense

**Q: "What's the most load-bearing context-engineering decision in your system?"**

A: Schema-gating the monitoring agent's category checklist. The full set of 10 anomaly categories is filtered down to only the categories this workspace can actually run (`runnableCategories(schemaCapabilities(schema))` in `lib/agents/categories.ts:44`). The model never sees a category it can't run, so it doesn't waste budget exploring it. The user sees an honest coverage report in the UI showing which categories were checked, which were skipped, and why. This is context engineering as a UX feature — the filter shapes both what the model does and what the user understands.

Three other decisions matter: capping the schema summary at 20 events × 10 props (`lib/agents/monitoring.ts:24-26`) so the prompt stays in the ~5-8KB range instead of 100+KB; per-agent tool policies (least privilege at the tool layer — monitoring sees 4 tools, query sees the union of 32); message-passing between agents (each agent's input is exactly what it needs, not a shared blackboard).

Diagram I'd sketch:

```
  full schema (100+KB) ── schemaSummary cap ──► top 20 events × 10 props
  10 categories ──── schemaCapabilities + runnableCategories ──► 5-8 runnable
  30 MCP tools ────── tool policy filter ──► 4 (monitoring) / 11 (diag) / ...
  multi-agent state ── message passing ──► each agent sees only its input
       │
       ▼
  the model's context window: only what's needed, nothing extra
```

Anchor: "the runnable-categories filter is the load-bearing decision. Most agent failures are context failures — the schema gate is the first place to spend an engineer's attention because it's where the bad-trajectory cost compounds most quickly."

**Q: "What's NOT in the model's window in your system, and why?"**

A: Four things. The full workspace schema isn't (capped to top 20 events × 10 props each — the long tail is irrelevant for typical anomaly detection). Categories the workspace can't run aren't (schema-gated before injection). Tools outside the per-agent policy aren't (least privilege; monitoring sees 4 tools instead of 30). Other agents' tool-call histories aren't (message passing, not blackboard; each agent gets a digested handoff object, not the upstream trace). Each "NOT" is a deliberate decision. Bigger windows don't fix bad context — they just give it more room.

## See also

- [`02-agent-memory-tiers.md`](./02-agent-memory-tiers.md) — memory tiers shape what's available to be in the window
- [`03-tool-calling-and-mcp.md`](./03-tool-calling-and-mcp.md) — tool grants are context-engineering at the tool layer
- [`../03-multi-agent-orchestration/08-shared-state-and-message-passing.md`](../03-multi-agent-orchestration/08-shared-state-and-message-passing.md) — message-passing is context-engineering at the topology layer
- [`../01-reasoning-patterns/02-agent-loop-skeleton.md`](../01-reasoning-patterns/02-agent-loop-skeleton.md) — the per-turn history budget
- ai-engineering's context-window and lost-in-the-middle files (cross-ref) — the mechanics that justify the discipline
