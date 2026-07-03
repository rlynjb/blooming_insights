# Context engineering

_Industry standard._

## Zoom out, then zoom in

The discipline that decides *what fills the window on every turn*. Prompt engineering gets the first good output; context engineering keeps the thousandth good. In this repo the surface is small and disciplined: a task-shaped system prompt + a bounded `schemaSummary` + the current investigation's tool trace, all cached by Anthropic's ephemeral cache breakpoint.

```
  Zoom out — what fills each agent's window

  ┌─ System prompt (cached prefix) ──────────────────────────────┐
  │  · task-shaped instructions (investigate / propose / scan)   │
  │  · schemaSummary (top 20 events, 30 customer props, catalogs)│
  │  · tool descriptions (MCP tool defs)                         │
  └───────────────────────┬──────────────────────────────────────┘
                          │ cache_control: ephemeral
                          ▼
  ┌─ Conversation window (grows per turn) ───────────────────────┐
  │  · anomaly (input) / diagnosis (Stage B input)               │
  │  · tool_use ↔ tool_result blocks (each ReAct turn)            │
  │  · model's step text (reasoning)                              │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the system prompt is the *context engineering surface*. Every choice about what to include, exclude, or summarize lives there. Blooming's version is deliberately compact — the full workspace schema is 112KB, but only a ~1-2KB summary reaches the window.

## Structure pass

**Layers:** system prompt (stable across turns) · shared reference data (schemaSummary) · per-investigation input (Anomaly, Diagnosis) · trace (grows per turn).
**Axis:** *does this content change during the loop, or is it stable across every turn?*
**Seam:** the ephemeral-cache breakpoint. Everything above the breakpoint is cached across turns; everything below is fresh. Getting more content into the cached prefix is the single highest-leverage cost lever.

```
  The cache breakpoint — what stays, what refreshes

  ┌─ Cached (system prompt) ───────────────────────────────────┐
  │  task instructions + schemaSummary + tool defs             │  ← stable
  └────────────────────────────────────────────────────────────┘
      cache_control: { type: 'ephemeral' }
  ┌─ Fresh (messages) ─────────────────────────────────────────┐
  │  turn 1: user msg (Anomaly)                                │
  │  turn 2: assistant msg (tool_use) + tool_result            │
  │  turn 3: assistant msg (tool_use) + tool_result            │  ← grows
  │  turn N: assistant msg (final structured output)           │
  └────────────────────────────────────────────────────────────┘
```

## How it works

### Move 1 — the mental model

You've optimized an API endpoint by pulling stable data out of the request path — put it behind a cache, only recompute what changes per request. Context engineering is the same instinct at the LLM layer: identify what's *stable across every turn* (task instructions, schema summary, tools) and put it in the cached prefix. Everything downstream (the conversation) refreshes on every call.

```
  Pattern: cached prefix + fresh tail

  ┌──────────────────────────────┐
  │  Cached prefix               │ ← same across every turn
  │  (system prompt)             │   cache_creation once,
  └──────────────────────────────┘   cache_read every turn after
  ┌──────────────────────────────┐
  │  Fresh tail (messages)       │ ← grows per turn
  └──────────────────────────────┘
```

### Move 2 — the walkthrough

**The schema summary — `lib/agents/monitoring.ts:19-60`.** The workspace schema in full is 112KB — event definitions, customer properties, catalogs, event counts. The summary bounds this to ~1-2KB before it reaches the prompt:

```ts
// lib/agents/monitoring.ts:19-60 — bounded schemaSummary
export function schemaSummary(schema: WorkspaceSchema): string {
  // Top 20 events, each capped at 10 properties
  const MAX_EVENTS = 20;
  const MAX_PROPS_PER_EVENT = 10;
  const eventsText = schema.events
    .slice(0, MAX_EVENTS)
    .map((e) => {
      const props = e.properties.slice(0, MAX_PROPS_PER_EVENT).join(', ');
      return `  - ${e.name} (${e.eventCount}): ${props || '(no properties)'}`;
    })
    .join('\n');
  // ... Customer properties: cap at 30 ...
  return [/* project + counts + horizon + events + customer props + catalogs */].join('\n');
}
```

Line-by-line:

- **`MAX_EVENTS = 20`, `MAX_PROPS_PER_EVENT = 10`.** Two hard caps. If a workspace has 100 events with 50 properties each, the summary still fits. The full data isn't lost — it's still fetchable at tool-call time via `list_events` — but the *prompt* doesn't carry the tail.
- **`.slice(0, MAX_EVENTS)`.** Sort order comes from the schema fetch; blooming trusts Bloomreach's order (implicitly popularity-ranked). If the top-20 misses a niche event the agent needs, the agent can still `execute_analytics_eql` on it — but the *summary* doesn't advertise it.
- **The output is a single string** — plain-text, not JSON. Model reads it directly; no JSON parse tax on the model side.

**The system-prompt cache — `lib/agents/aptkit-adapters.ts:85-89`.** The whole system prompt (task instructions + schemaSummary + tool defs) sits behind Anthropic's ephemeral cache breakpoint:

```ts
// aptkit-adapters.ts:85-89 — the cache breakpoint
if (request.system) {
  params.system = [
    { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
  ];
}
if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);
```

Line-by-line:

- **`cache_control: { type: 'ephemeral' }`** — the load-bearing five characters. Turn 1 is `cache_creation` (~1.25× normal input cost); turns 2-N are `cache_read` (~0.1× normal). For a diagnostic run's ~10 model turns this is roughly an 80% reduction on system-prompt token cost.
- **Tools are cached transparently.** Anthropic caches the `tools` block when the SAME breakpoint is set on `system` — so the one `cache_control` covers both prefixes. No separate tool-cache config needed.
- **The 5-minute TTL applies.** Within a diagnostic run (~50s) the cache always hits. Across sessions or when a run pauses > 5 min, cache misses and pays creation cost again.

**Per-investigation input — the messages, not the system prompt.** The Anomaly (Stage A input) and Diagnosis (Stage B input) go in the *first user message*, not the system prompt. That's the right placement — they change per investigation, so caching them wouldn't help. The system prompt stays stable across investigations; only the input changes.

**In multi-agent — which agent sees what.** Every agent gets the *same* schemaSummary (see `03-multi-agent-orchestration/08-shared-state-and-message-passing.md`), but each gets a *different* task-shaped instruction. DiagnosticAgent's system prompt says "investigate this anomaly, form and test hypotheses"; RecommendationAgent's says "propose Bloomreach actions given this diagnosis." The context routing is per-agent — each specialist sees only what it needs to do its job.

```
  Layers-and-hops — what fills the window on each turn

  ┌─ System prompt (cached) ────────────────────────────────────┐
  │  DiagnosticAgent:                                           │
  │  "You are an analyst. Given an anomaly, investigate the      │
  │   cause. Available data: <schemaSummary>. Tools: <defs>."   │
  └───────────────────────────┬─────────────────────────────────┘
                              │ cache_creation once
                              ▼
  ┌─ Turn 1 messages ───────────────────────────────────────────┐
  │  user: "Anomaly: usa purchase_revenue down 38%..."           │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼
  ┌─ Turn 2 messages (cache_read on system) ────────────────────┐
  │  user: <anomaly>                                             │
  │  assistant: tool_use(execute_analytics_eql, {...})           │
  │  user: tool_result(<query results>)                          │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼
                     ... continues until final output ...
```

### Move 3 — the principle

Context engineering is the discipline of curating what fills the window. Bigger context windows do not fix the problem — they make room for more noise, and lost-in-the-middle attacks the middle of a bloated context. The senior-grade move is the opposite: bound the prefix, cache what's stable, keep the tail lean, decide per-agent what each specialist needs. Blooming's version bounds the schema at 20 events + 30 customer props, caches the whole system prompt via ephemeral breakpoint, and gives each agent a task-specific prompt so the model isn't confused about which mode it's in.

## Primary diagram

```
  Recap — context engineering in this repo

  ┌─ Every agent's system prompt (cached) ──────────────────────┐
  │                                                             │
  │  1. Task-shaped instruction (per agent)                     │
  │     ─ DiagnosticAgent: "investigate the anomaly"            │
  │     ─ RecommendationAgent: "propose Bloomreach actions"      │
  │     ─ MonitoringAgent: "scan for anomalies against 10 cats"  │
  │                                                             │
  │  2. schemaSummary (shared, bounded to ~1-2KB)               │
  │     ─ top 20 events × 10 properties                         │
  │     ─ top 30 customer properties                            │
  │     ─ catalogs, total counts, oldest data                   │
  │                                                             │
  │  3. Tool definitions (MCP tool defs, transparently cached)  │
  │                                                             │
  │  cache_control: ephemeral → 80% cost reduction on prefix    │
  └─────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ Per-investigation messages (fresh) ────────────────────────┐
  │  Anomaly + Diagnosis (Stage B) + tool trace                 │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The reframe to hand a reader who's used to "prompt engineering": most agent failures are not model failures — they're context failures. Stale retrieval, lost-in-the-middle on a bloated context, no user state loaded, the wrong tool outputs in the window. Prompt engineering gets you the first good output; context engineering keeps you at the thousandth good.

Blooming's specific application of the discipline is on two axes:

- **Bound the shared context.** `schemaSummary` caps the workspace schema at ~1-2KB. Without the cap the full 112KB schema would blow the system-prompt budget, poison the cache prefix (bloated prefixes still cost per-token to write), and drown the task-shaped instruction in reference data.
- **Cache the shared context.** The ephemeral cache breakpoint on `system` makes the shared prefix effectively free on turns 2-N. Verified in live logs (cache_creation → cache_read pattern on every ReAct run).

Where blooming deliberately does NOT engineer more context in: user profile, historical investigation context, prior recommendations. Those are episodic/long-term concerns and are called out in `02-agent-memory-tiers.md` — they don't exist here yet.

The multi-agent angle: each agent gets a *task-shaped* system prompt. Legacy `lib/agents/base-legacy.ts` was a single 400+ line prompt covering monitor + diagnose + recommend; the model got confused about which phase it was in. Splitting into three narrow prompts fixed the confusion. That's context engineering at the topology level — the split isn't just about tools, it's about which context each agent's window carries.

## Interview defense

**Q: How is context engineering different from prompt engineering, and where does it show up in this codebase?**
A: Prompt engineering asks "what's the best wording of the instruction?" Context engineering asks "what's the best set of information to put in the window at all?" Prompt engineering gets you the first good output; context engineering keeps you at the thousandth good. Blooming's version has two levers. Bounding: `schemaSummary` caps the workspace schema at ~1-2KB (top 20 events × 10 properties, 30 customer props), so the full 112KB schema never poisons the window. Caching: the ephemeral breakpoint on the system prompt turns the stable prefix into cache_read on turns 2-N, verified in live logs. Per-agent routing: each of the three agents gets a *task-shaped* system prompt, so the model isn't confused about which phase it's in — the previous single-prompt version (legacy `base-legacy.ts`) hit that failure mode.

Diagram: the cached-prefix + fresh-tail picture, with the ~1-2KB summary label and the cache breakpoint marked.
Anchor: `lib/agents/monitoring.ts:19-60` (schemaSummary) + `lib/agents/aptkit-adapters.ts:85-89` (cache breakpoint).

**Q: Why not include the full workspace schema in every prompt — the context window is huge now?**
A: Two reasons. First, cost. Even at cached rates, the tokens still get *written* to the cache on turn 1 (cache_creation is ~1.25× normal input cost). A 112KB schema is roughly 25K tokens; you'd pay ~$0.09 just to write it to cache once, then cache_read at ~$0.0075 per turn — dominating the per-investigation budget. Second, quality. Lost-in-the-middle attacks the middle of a long context — the model's attention degrades on tokens that aren't at the edges. Bounding the summary to 20 events + 30 customer props keeps the *whole* thing in the "high-attention" zone. If a niche event isn't in the summary, the model can still call `execute_analytics_eql` on it directly — the tool provides the fallback, not the prompt.

Diagram: the lost-in-the-middle attention curve over a long context.
Anchor: `lib/agents/monitoring.ts:24-38` (the MAX_EVENTS and MAX_PROPS caps).

## See also

- `03-multi-agent-orchestration/08-shared-state-and-message-passing.md` — the shared-vs-message split that makes context routing possible.
- `05-observability-hook.md` — how token usage per turn gets measured (cache_creation vs cache_read).
- `05-production-serving/04-cost-controls.md` — the cache is the load-bearing cost lever.
- Cross-reference: `.aipe/study-ai-engineering/`'s context-window and lost-in-the-middle files for the mechanics.
