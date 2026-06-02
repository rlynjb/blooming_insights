# CPU, memory, and allocation

**Industry name(s):** memory footprint · GC pressure · allocation profile · retention boundary
**Type:** Industry standard · Language-agnostic

> blooming insights is **I/O-bound, not CPU-bound** — the dominant CPU work is `JSON.stringify` on tool results (`lib/agents/base.ts:150`, `lib/mcp/client.ts:102`) and the truncate function clipping at 16k chars. Memory has three watch points: the **messages array grows monotonically** within one `runAgentLoop` invocation (`lib/agents/base.ts:79-172` — each turn appends both the assistant response and a tool_result block), the **in-memory `Map`s** in `lib/state/insights.ts` and `lib/state/investigations.ts` retain state for the warm Vercel instance's lifetime, and the **module-level schema cache** (`lib/mcp/schema.ts:131`) is one ~112KB workspace schema kept alive forever per process. None of these are leaks — they're bounded by either the agent's `maxToolCalls` or by serverless instance death — but none are profiled either.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Server-side Node apps have three memory shapes you have to watch: *per-request* (allocated and released within one request — the messages array), *per-instance* (allocated once, kept alive while the function instance is warm — the in-memory `Map`s, the schema cache), and *per-deploy* (allocated once at module load, lives until the deploy rolls — the constants, the prompt strings read via `readFileSync`). Each shape has a different failure mode: per-request leaks blow one user's request; per-instance growth slowly fills the function's RAM; per-deploy bloat is mostly fine until you have hundreds of agents.

```
  Zoom out — where memory lives           ← we are here (per-instance and per-request bands)

  ┌─ UI (browser) ───────────────────────────────────┐
  │  React state in useInvestigation hook             │
  │  items array grows per investigation              │
  │  released on navigation                           │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Route (per request) ─▼───────────────────────────┐
  │  collected: AgentEvent[]  grows during stream     │
  │  released when stream closes                      │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Agent loop (per request) ─▼──────────────────────┐
  │  messages: MessageParam[]  grows per turn          │  ★ PER-REQUEST GROWTH
  │  toolCalls: ToolCall[]     grows per tool call    │
  │  released when investigate() returns              │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ State (per instance) ─▼──────────────────────────┐
  │  insights: Map<id, Insight>     lives until cold  │  ★ PER-INSTANCE
  │  investigations: Map<id, …>     lives until cold  │
  │  anomalies: Map<id, Anomaly>    lives until cold  │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Module (per deploy) ─▼───────────────────────────┐
  │  PROMPT (readFileSync at import time)             │  per-deploy, ~few KB
  │  cached schema (per instance, not per deploy)     │
  │  AGENT_MODEL constant                             │
  └───────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *which memory grows, when does it release, and what bounds it?* The answer is *all three shapes exist* but *none of them leak* — they're bounded by either the agent's `maxToolCalls`, the serverless instance dying, or the deploy rolling. CPU is mostly *not* the bottleneck because the workload is dominated by waiting on external I/O. Below, you'll see the three memory shapes, the one CPU hot path (JSON serialization of tool results), and the absent profiler that would confirm it.

---

## Structure pass

**Layers.** Three memory shapes (per-request, per-instance, per-deploy) cut across the same five bands. Each shape has a different release boundary.

**Axis: retention lifecycle.** Hold one question constant across every band: *how long does this allocation live, and what releases it?* Lifecycle is the right axis for memory because the *defining* property of an allocation is what frees it. A per-request allocation released by GC at request end is healthy; the same allocation kept alive in a module-level `Map` is a leak. Cost (file 01) and visibility (file 02) sit one altitude up; the lifecycle question is the irreducible one for memory.

**Seams.** Two load-bearing.

- **MEM1: per-request ↔ per-instance.** Move an allocation from a function-local variable to a module-level `Map` and you've changed its lifecycle from "freed at request end" to "lives until the function instance is cold." The `insights` Map in `lib/state/insights.ts:4` is exactly this crossing — it's per-instance state living in module scope, which is *correct* for blooming insights' "stateless agent + in-memory feed" shape but *would* be a leak if a database hadn't been deliberately omitted.
- **MEM2: bounded ↔ unbounded growth.** The messages array in `runAgentLoop` grows monotonically per turn — but is bounded by `maxTurns` (default 8). The `collected` array grows per event — but is bounded by the number of events the agent emits. The in-memory `Map`s grow per insight — but `putInsights` calls `.clear()` first, so the map's size is bounded by one briefing's output. Crossing this seam to *unbounded* growth is what makes a leak; nothing in this codebase has crossed it.

```
  Structure pass — Memory + CPU

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  UI · Route · Agent loop · State · Module         │
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  retention lifecycle: how long does this live,    │
  │  and what releases it?                            │
  └────────────────────────┬─────────────────────────┘
                           │  trace it across layers
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  MEM1: per-request ↔ per-instance   (Map scope)   │
  │  MEM2: bounded ↔ unbounded growth   (cap or grow?)│
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the per-request growth, the per-instance retention, and the CPU hot path.

---

## How it works

### Move 1 — the mental model

You've watched a React component re-render too often and traced it to a stale closure holding onto a big array — same shape here. Memory at runtime is about two things: *what allocates* (the create site) and *what retains* (the reference chain that keeps the GC from freeing it). A request-scoped allocation in a function-local variable is freed as soon as the function returns, because nothing references it after that. The same allocation stored in a module-level `Map` is held forever (until the module is unloaded — which on serverless means until the instance dies).

```
  Pattern — retention chain (what keeps allocations alive)

   allocation site:  new Map() / array.push(x) / new Anthropic()
        │
        ▼
   reference chain that prevents GC:
   ──────────────────────────────────────────────
   function-local:     ── released at function return       ★ shortest
   request-scoped:     ── released at response end (stream close)
   module-level Map:   ── released when module unloaded
   module-level const: ── released when process dies         ★ longest
   ──────────────────────────────────────────────

   if any reference still points to the allocation,
   the GC cannot reclaim it — even if "logically" you're done with it.
```

The model is: **the reference chain decides the lifetime, not the allocation site**. A 100MB blob created in a request handler is freed at request end *if* the handler dropped the reference; it's retained forever *if* a module-level `Map.set(id, blob)` got hold of it. blooming insights uses module-level `Map`s deliberately (the absence of a database is the architectural decision); the trick is that each `Map` has a known bound on size.

---

### Move 2 — the four memory shapes, one at a time

#### Move 2.1 — per-request growth: the messages array

`runAgentLoop` (`lib/agents/base.ts:79-172`) maintains a `messages: MessageParam[]` that starts with one user turn and grows by *two* entries per loop iteration: an assistant turn (the model's response, including any tool_use blocks) and a user turn (a wrapper holding the tool_result blocks).

```
  Pattern — messages array growth per turn

   turn 0: messages = [{ role: 'user', content: userPrompt }]                       (1 item)
        │
        ▼  Anthropic call returns assistant content (incl. tool_use)
   turn 0 ends: messages += assistant + tool_results
                messages = [user_initial, assistant_0, tool_results_0]              (3 items)
        │
        ▼
   turn 1 ends: messages += assistant + tool_results
                messages = [user_initial, asst_0, tr_0, asst_1, tr_1]               (5 items)
        │
        ▼
   ...
        │
        ▼
   turn 7 ends: messages = [user_initial, asst_0..7, tr_0..7]                       (17 items max)

   each item carries tool_results of size ≤ 16_000 chars (truncate cap)
   ⇒ messages array peak: ~8 turns × 16KB × 2 = ~256 KB upper bound per agent

   release: when investigate() returns; the function-local messages goes out of scope.
```

The boundary: this growth is *monotonic within one agent run* but *bounded by maxTurns* (8 by default). 256KB peak per agent × 2 agents = 512KB per investigation — comfortable for any Node process. It's not a leak; the messages array is released as soon as `runAgentLoop` returns.

**The deeper point:** every turn Anthropic re-tokenizes the *entire* messages array (input tokens = sum of all prior turns). That's a *cost* issue (file 01's missing soft budget) more than a memory issue — but it's worth flagging here because the memory and cost shapes are correlated: a big messages array is also an expensive messages array. Prompt prefix caching (absent, see `study-ai-engineering/06/01`) would skip the re-tokenization at the model's side.

#### Move 2.2 — per-instance retention: the in-memory Maps

`lib/state/insights.ts` and `lib/state/investigations.ts` declare module-level `Map`s. On a *warm* Vercel function instance (one that's served a prior request), these Maps retain whatever was put in them.

```
  Pattern — per-instance Map retention

   module load (first request hits a cold instance):
     const insights = new Map<string, Insight>();          ← empty
     const investigations = new Map<string, Investigation>();  ← empty
     const anomalies = new Map<string, Anomaly>();          ← empty

   first /api/briefing request:
     scan → putInsights(items) → insights.clear() → set N entries
     ⇒ insights Map holds N entries (typically 1-10 insights)

   first /api/agent request:
     run → saveInvestigation(id, events) → mem.set(id, events)
     ⇒ investigations Map holds 1 entry of M events (~100-200 events)

   instance stays warm (subsequent requests):
     putInsights replaces insights wholesale every briefing (clear + set)
     saveInvestigation accumulates investigations one per ID until cold

   instance goes cold:
     all Maps are gone with the process — no flush, no persistence
```

The release boundary is **the function instance dying**. Vercel's serverless functions stay warm for some time after a request, then are torn down. The `Map`s die with the process. This is *correct* for the demo-shape product (each user gets fresh state every cold start) but is *also* the reason a database would be needed for real persistence — see `study-system-design/03-state-ownership-and-source-of-truth.md`.

**One growth path:** `investigations.set(id, events)` adds one entry per investigation; nothing ever calls `.delete`. A long-warm instance accumulates investigations until it cools. Bound: number of investigations the user runs within one warm window × ~10-50KB per investigation (the AgentEvent[] array). For demo scale, fine. For a heavier user, eventually noticeable.

#### Move 2.3 — per-instance: the schema cache

`lib/mcp/schema.ts:131` declares `let cached: WorkspaceSchema | null = null` — a module-level variable. `bootstrapSchema` (`lib/mcp/schema.ts:170-192`) returns the cached value if present, otherwise calls 4 MCP tools to build a fresh one.

```
  Pattern — schema cache lifetime

   module load:                         cached = null
   first bootstrapSchema call:          cached = parseWorkspaceSchema(...)   ← ~10-50KB
   subsequent calls (this instance):    returns cached immediately
   instance dies:                       cached gone with the process

   why this matters for memory:
     ONE schema kept alive per warm function instance
     parseWorkspaceSchema produces a fully-expanded object
       (events: { name, properties[], eventCount }[], customerProperties[], catalogs[])
     for a busy workspace with many event types + properties: 30-100KB

   why this matters for latency:
     cold: 4 MCP calls × ~1.5-3s = ~6-12s of bootstrap
     warm: 0 calls, returns in microseconds
     this is the savings every second-investigation-in-a-session gets
```

The schema cache is **per-instance, not per-deploy** — it lives in module scope but is initialized lazily, so two different instances can have different cached schemas (e.g. if they serve different users with different `BLOOMREACH_PROJECT_ID` pins). The `_resetSchemaCache()` test-only helper sets it back to null.

#### Move 2.4 — CPU hot paths: JSON serialization and the truncate function

The CPU profile (inferred, not measured — there's no profiler integration) is dominated by:

```
  Pattern — CPU hot paths (inferred)

   1. JSON.stringify on tool results
      lib/agents/base.ts:150  truncate(JSON.stringify(result))
      lib/mcp/client.ts:102   const cacheKey = `${name}:${JSON.stringify(args)}`
      app/api/agent/route.ts:101  const s = JSON.stringify(v);
      app/api/briefing/route.ts:71 const s = JSON.stringify(v);

      tool results can be 16-100KB before truncation
      ⇒ stringify runs N times per investigation (twice per tool call: once for
        cache key + once for the message body sent to Claude)

   2. The truncate function (lib/agents/base.ts:31)
      O(n) string slice on a stringified blob
      runs once per tool call (in the loop) + once per emit (in the route)

   3. NDJSON encoding (lib/mcp/events.ts:15)
      JSON.stringify per event + '\n'
      runs once per event (~100-200 events per investigation)

   nothing else is CPU-significant:
     - the spacing-gate sleep is wall-clock, not CPU
     - HTTPS + Anthropic round-trips are wall-clock waits
     - the agent loop itself is mostly awaiting external responses
```

The principle: **this workload is I/O-bound by structure**. The per-investigation CPU time is *seconds at most* across ~30-60 NDJSON encodes + 10-20 JSON stringifications + 10-20 truncations. The wall-clock time is ~100s. CPU utilization per investigation is single-digit percent. No flame graph would surface a hot loop; the workload would show as "mostly sleeping on I/O" with brief CPU spikes at every event emission.

---

### Move 3 — the principle

**Lifecycle is the question; size is the answer.** Memory work in Node servers is mostly about *answering "what releases this?"* rather than *measuring "how big is this?"*. Every allocation in blooming insights has a clear release boundary — function return, stream close, instance cold start, deploy roll. None of those boundaries are unbounded. That's why the codebase doesn't leak even though it has no GC tuning, no heap-snapshot integration, and no memory-monitoring APM. The cost: if any of those boundaries breaks (e.g. someone adds a global `events.push(event)` for "easy debugging"), it becomes a leak silently — because nothing measures it.

---

## Primary diagram

The full memory picture — the three shapes, what bounds each, the CPU hot paths.

```
  blooming insights — memory + CPU at a glance

  ┌─ PER-REQUEST (released at function return / stream close) ───────────┐
  │                                                                       │
  │  messages: MessageParam[]                                             │
  │      bounded by maxTurns (8) × 2 entries × ≤16KB truncated tool result│
  │      peak: ~256KB per agent run                                       │
  │      lib/agents/base.ts:79                                            │
  │                                                                       │
  │  toolCalls: ToolCall[]                                                │
  │      bounded by maxToolCalls (4-6)                                    │
  │      peak: ~100KB per agent run                                       │
  │      lib/agents/base.ts:83                                            │
  │                                                                       │
  │  collected: AgentEvent[]                                              │
  │      bounded by total emit count (typically 100-200 events)           │
  │      peak: ~500KB per investigation                                   │
  │      app/api/agent/route.ts:171                                       │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ PER-INSTANCE (released when Vercel function instance cools) ────────┐
  │                                                                       │
  │  insights: Map<id, Insight>                                           │
  │      bounded by .clear() at every briefing (typically 1-10 entries)   │
  │      lib/state/insights.ts:4                                          │
  │                                                                       │
  │  investigations: Map<id, AgentEvent[]>                                │
  │      grows monotonically per investigation in a warm instance         │
  │      no .delete called anywhere                                       │
  │      bound: warm-window length × ~50KB per investigation              │
  │      lib/state/investigations.ts:11                                   │
  │                                                                       │
  │  anomalies: Map<id, Anomaly>                                          │
  │      bounded by .clear() at every briefing                            │
  │      lib/state/insights.ts:6                                          │
  │                                                                       │
  │  cached: WorkspaceSchema | null                                       │
  │      one schema kept alive per warm instance (~30-100KB)              │
  │      lib/mcp/schema.ts:131                                            │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ PER-DEPLOY (released when deploy rolls) ────────────────────────────┐
  │                                                                       │
  │  PROMPT strings (readFileSync at import time)                         │
  │  lib/agents/diagnostic.ts:14, monitoring.ts:13, recommendation.ts:14, │
  │  query.ts:13   →   few KB each, ~10KB total                           │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ CPU HOT PATHS (inferred — no profiler) ─────────────────────────────┐
  │                                                                       │
  │  JSON.stringify (tool results, cache keys, event encodes)             │
  │  truncate (16k cap on tool results; 4k cap on event payloads)         │
  │  NDJSON encoding per event                                            │
  │                                                                       │
  │  per-investigation CPU: single-digit seconds (mostly I/O wait)        │
  │  this is I/O-BOUND, not CPU-BOUND                                     │
  └───────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases — where memory shapes appear

- **The messages array** — grows in every agent's `runAgentLoop` invocation. Released when the agent's `investigate`/`propose`/`scan`/`answer` method returns. Two agents per investigation = two short-lived arrays of ~256KB each.
- **The in-memory Maps** — survive across requests in the same warm function instance. `insights.clear()` at every briefing keeps insights bounded; `investigations.set(...)` accumulates in a warm instance because there's no `delete`.
- **The schema cache** — populated on the first MCP-using request after a cold start; reused for all subsequent requests until the instance dies. Saves ~6-12s of bootstrap per warm request.
- **The collected event array** — grows during one streaming response; released when the stream closes. The peak is ~500KB for a busy investigation with many tool calls.
- **The prompt strings** — read once at module import (`readFileSync`), held for the deploy's lifetime. ~10KB total across all four agent prompts.

### Code side by side

**The messages array — grows per turn, bounded by `maxTurns`, released at function return.**

```
  lib/agents/base.ts  (lines 79–172, abbreviated)

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userPrompt },                  ← initial allocation
  ];

  for (let turn = 0; turn < maxTurns; turn++) {              ← bound: 8 iterations max
    // ...
    const res = await anthropic.messages.create(params);
    messages.push({ role: 'assistant', content: res.content });  ← grows by 1

    // ... if no tool_use: return; loop exits ...

    messages.push({ role: 'user', content: toolResults });    ← grows by 1
  }
  return { finalText: '', toolCalls };                        ← messages goes out of scope here
        │
        └─ peak length: 17 entries (initial + 8×2). Released as soon as
           the loop exits and the function returns. No leak path —
           nothing outside the function references `messages`. The data
           is GC-eligible the moment the agent's caller (the route)
           processes the returned { finalText, toolCalls }.
```

**The in-memory Maps — module-level scope, per-instance lifetime.**

```
  lib/state/insights.ts  (lines 1–7)

  import type { Anomaly, Insight, Investigation } from '../mcp/types';
  import { deriveInsightFields } from '../insights/derive';

  const insights = new Map<string, Insight>();                ← module scope = per-instance
  const investigations = new Map<string, Investigation>();    ← module scope = per-instance
  const anomalies = new Map<string, Anomaly>();               ← module scope = per-instance
        │
        └─ these Maps live until the function instance cools. On a warm
           instance, every subsequent request can read what a prior
           request wrote. This is CORRECT for the in-memory-feed product
           shape but means: (a) two concurrent requests can race on
           putInsights (cf. study-system-design/07), (b) the data is
           lost on every cold start, (c) different instances see
           different data (no shared state).
```

**The clear + set pattern that bounds the insights Map.**

```
  lib/state/insights.ts  (lines 30–42)

  export function putInsights(items: Insight[], rawAnomalies?: Anomaly[]): void {
    // Replace the previous briefing — each run IS the current feed, not an
    // addition. Without clearing, a warm serverless instance (or a long-running
    // dev server) accumulates stale insights from earlier runs, so the feed shows
    // yesterday's anomalies alongside today's. Investigations are keyed separately
    // and untouched here.
    insights.clear();                                          ← BOUND: prevents unbounded growth
    anomalies.clear();
    items.forEach((i, idx) => {
      insights.set(i.id, i);                                   ← rewrite with new entries
      if (rawAnomalies?.[idx]) anomalies.set(i.id, rawAnomalies[idx]);
    });
  }
        │
        └─ this is the explicit bound. Without .clear() at the top, every
           briefing would ADD to the Map and the warm instance's memory
           would grow linearly with the number of briefings the user ran.
           The comment names the exact failure mode it prevents.
           NOTE: investigations.set in the OTHER file has NO equivalent
           .clear, so it DOES grow (slowly) until the instance cools.
```

**The schema cache — one ~100KB blob per warm instance.**

```
  lib/mcp/schema.ts  (lines 131, 170–192)

  let cached: WorkspaceSchema | null = null;                  ← module-level cache

  export async function bootstrapSchema(mcp: McpClient): Promise<WorkspaceSchema> {
    if (cached) return cached;                                 ← HIT: ~0 latency
    const { projectId, projectName } = await resolveProject(mcp);  ← 2 MCP calls
    const args = { project_id: projectId };

    const eventSchema = await callOrThrow(mcp, 'get_event_schema', args);
    const customerProps = await callOrThrow(mcp, 'get_customer_property_schema', args);
    const catalogs = await callOrThrow(mcp, 'list_catalogs', args);
    const overview = await callOrThrow(mcp, 'get_project_overview', args);

    cached = parseWorkspaceSchema({...});                      ← SET: held until instance cools
    return cached;
  }
        │
        └─ the cache is BIASED: the first request after cold start pays
           ~6-12s of bootstrap; every subsequent request in that warm
           instance reads from `cached` in microseconds. The downside is
           a stale schema — if a user adds an event to their workspace,
           the warm instance won't see it until cold restart or until
           _resetSchemaCache() is called (it's only called from tests).
           For a long-warm instance, this could surface as "I added an
           event yesterday and the agent doesn't know about it."
```

**The CPU hot path — stringify on every tool call's cache key + every event.**

```
  lib/mcp/client.ts  (line 102)

  const cacheKey = `${name}:${JSON.stringify(args)}`;        ← stringify on EVERY call
        │
        └─ args is typically small (a project_id and an EQL string),
           so this stringify is cheap (~microseconds). It runs once
           per tool call.

  lib/agents/base.ts  (lines 150)

  resultContent = truncate(JSON.stringify(result));           ← stringify on EVERY tool RESULT
        │
        └─ result can be 16-100KB. The stringify is the most expensive
           CPU operation in a typical investigation. Runs once per
           successful tool call (4-6 per agent × 2 agents = 8-12 times).
```

---

## Elaborate

**Where this pattern comes from.** Server-side memory in Node has always been about *retention chains*, not raw allocations — V8's GC is good enough that allocation cost is negligible for short-lived objects, but anything kept alive by a closure or module-level binding is held forever. The classic Node "memory leak" is a `let cache = {}` at module scope with no eviction; the classic Node "non-leak" is a function-local array that's used and discarded per request. Serverless makes this *easier* to reason about (the process dies on cold start, capping per-instance retention) and *harder* to optimize (you can't measure across invocations cleanly).

**Why the I/O-bound shape changes the calculus.** A CPU-bound workload (data transformation, graph traversal, encryption) needs profiling to find hot loops. An I/O-bound workload (HTTP calls, database queries, LLM round-trips) needs *latency tracking*, not CPU profiling. blooming insights is the second shape — file 03's latency math dominates anything CPU could show. A flame graph would show "mostly sleeping on `await`" with no clear hot loop. That's *not* a reason to skip profiling — it's a reason to profile *only when latency tracking flags something CPU-shaped*, which hasn't happened yet because there's no latency tracking either (file 02).

**The memory leak that *could* land here.** The one path that has *unbounded* growth in a warm instance is `investigations.set(insightId, events)` in `lib/state/investigations.ts:31` — there's no `.delete`, no LRU, no size cap. The bound is the warm-window length × per-investigation event size (~50KB). For demo-scale traffic, fine. For a heavier production load (a user kicking off 100 investigations in a warm window), this would grow to ~5MB per user. Still small in absolute terms, but it's the one place a real leak *could* hide if the warm window grew unexpectedly.

**Connection to adjacent concepts.** File 03 explains why messages-array growth correlates with re-tokenization cost on every turn. File 06 covers the schema cache as a caching pattern (this file covers it as a memory shape). The lifecycle of the in-memory Maps is also the topic of `study-system-design/03-state-ownership-and-source-of-truth.md` and `study-runtime-systems/`.

---

## Interview defense

### Q: Is blooming insights CPU-bound or I/O-bound? Defend your answer.

**Answer:** I/O-bound, by structure. The dominant time in any investigation is wall-clock waiting — Bloomreach's ~1 req/s spacing (1.1s per call × 6-12 calls), Anthropic's per-turn latency (3-10s × 8-16 turns), and rate-limit retry waits. CPU work is per-event JSON serialization plus the truncate function — single-digit seconds across a ~100s investigation. There's no hot loop because the agent loop *is* mostly `await`. A flame graph would show "sleeping on I/O" with brief spikes at each event emission.

```
  CPU vs I/O time per investigation

   I/O wait time:
     spacing       6-12 calls × 1.1s              = ~7-13s
     network       6-12 calls × 0.5-2.5s           = ~3-30s
     Anthropic     8-16 turns × 3-10s              = ~24-160s
                                                    ────
                                                    ~34-200s

   CPU work:
     stringify     ~20-30 calls × microseconds     = <1s
     truncate      ~10 calls × ~ms                 = <1s
     NDJSON emit   ~100-200 events × microseconds  = <1s
                                                    ───
                                                    ~few seconds

   ratio: 100:1 wall-clock-to-CPU at minimum
```

### Q: What memory in this codebase could actually leak, and what bounds it today?

**Answer:** Three candidates. (1) The messages array in `runAgentLoop` — bounded by `maxTurns = 8`, released at function return. Not a leak. (2) The in-memory `insights`/`anomalies` Maps — bounded by `putInsights` calling `.clear()` first. Not a leak. (3) The `investigations` Map in `lib/state/investigations.ts:11` — *no* `.delete`, no LRU, no cap. Grows monotonically until the warm instance cools. For demo scale, ~50KB × ~5-10 investigations per warm window = ~250KB-500KB. For heavier traffic, could grow to a few MB. The instance death is the de-facto bound, which is fine for serverless but would matter on a long-running Node process.

```
  the one unbounded path (bounded only by instance lifetime)

   investigations.set(id, events)  ←  lib/state/investigations.ts:31
        │
        └─ no .delete
        └─ no LRU
        └─ no size cap
        └─ bounded only by warm-window length × per-investigation size
        ⇒ ~50KB × N investigations until cold start
```

### Q: The schema cache is a 30-100KB blob held per instance. Why is that the right call?

**Answer:** The alternative is paying 6-12s of bootstrap on every request. The schema is *stable* (a workspace's events + properties don't change minute-to-minute), so the staleness risk is low. The cost is one ~50KB allocation per warm instance — negligible against Node's heap. The *boundary*: if a user adds an event type and immediately tests it, the warm instance won't see it until cold restart. That's a known tradeoff and the `_resetSchemaCache` helper exists for tests. The fix if it ever bites: a short TTL on the cache (60s, matching the MCP cache), trading a bit of bootstrap latency for staleness bounds.

---

## Validate

**Level 1 — Reconstruct.** Name the three memory shapes in blooming insights and their release boundaries. (Answer: per-request — released at function return or stream close (the messages array, toolCalls, collected events); per-instance — released when the function instance cools (the in-memory `Map`s, the schema cache); per-deploy — released when the deploy rolls (the readFileSync'd prompts, the AGENT_MODEL constant).)

**Level 2 — Explain.** Why is the `investigations` Map (`lib/state/investigations.ts:11`) the one place a memory leak could "hide" in this codebase? (Answer: it grows monotonically with no `.delete`, no LRU, no size cap. Every saved investigation adds an entry; nothing ever removes one. The de-facto bound is the warm function instance dying. For demo-scale traffic the growth is bounded by warm-window length × ~50KB per investigation, which is fine. But the *shape* — unbounded growth with no eviction policy — is the classic Node leak pattern that bites when traffic patterns change.)

**Level 3 — Apply.** A teammate proposes adding a global `recentTools: ToolCall[] = []` and `push`ing every tool call to it "for debugging." Defend or change. (Answer: this is the textbook way to introduce a leak. The array would grow with every tool call in every investigation in every warm instance, with no upper bound. Even at ~10KB per ToolCall and 10 tool calls per investigation, a warm instance running 100 investigations would carry ~10MB of dead state. The fix: if you need the data for debugging, write it to `console.log` (lands in Vercel logs, no in-process retention) or a bounded ring buffer (`if (recentTools.length > 1000) recentTools.shift()`). The principle is *every allocation needs a release boundary*; a bare module-level array has none.)

**Level 4 — Defend.** A reviewer says "you don't have a profiler — how do you know JSON.stringify is the CPU hot path?" Defend. (Answer: I don't *know* — it's an inference from the code shape. The workload is dominated by `await`s on external I/O (Anthropic, Bloomreach, the spacing-gate sleep). The CPU-side work is per-event NDJSON encoding, per-call cache-key construction, per-result stringification + truncation. Without a profiler, I can rank them by *how often they run* and *how much data they touch*, and stringify on the 16-100KB tool results wins both axes. The honest answer is: I should add the profiler to confirm, which is file 02's Meter 5. Until then, the inference is "most likely hot path" not "measured hot path.")

---

## See also

- `02-measurement-baselines-and-profiling.md` — the profiler that would confirm or refute the CPU inference
- `03-latency-throughput-and-tail-behavior.md` — why this workload is I/O-bound by structure
- `05-io-network-and-database-bottlenecks.md` — the I/O that dominates
- `06-caching-batching-and-backpressure.md` — the schema cache from a caching lens
- `.aipe/study-system-design/03-state-ownership-and-source-of-truth.md` — the in-memory Maps as an architectural choice
- `.aipe/study-runtime-systems/` (sibling guide) — the runtime context for the messages-array lifecycle
