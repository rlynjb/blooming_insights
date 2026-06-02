# 05 — Memory, stack, heap, GC, and lifetimes

**Industry name(s):** V8 heap · garbage collection · object lifetime · TTL cache eviction · in-process state
**Type:** Industry standard (V8 / Node.js) · Project-specific application

> **Verdict: memory pressure isn't a real concern at this scale, but lifetimes are.** Every important "cache" or "state" object in the repo lives in the V8 heap of one Node process, and its lifetime is "the warm-instance lifetime" — which means *Vercel decides when it dies*. The TTL on `McpClient.cache` (60s) and the 16KB truncation guard in `runAgentLoop` are the only explicit memory-bounding primitives. Nothing else has an eviction policy: `insights` grows by `putInsights` clearing it; `investigations` grows monotonically until the process is killed; `cached` schema is one object forever. The risk isn't OOM (we'd hit `maxDuration` first); the risk is **stale state when a second warm instance spins up empty and the user sees no insights**. That's a lifetime bug masquerading as a memory bug.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** All app-owned memory lives in the **Server runtime** band. The browser holds React state (component lifetime) and `sessionStorage` (tab lifetime). The Node process holds the V8 heap; the V8 heap holds every `Map`, every `WorkspaceSchema`, every queued NDJSON byte. The interesting question is *not* "how much memory" — it's *"how long do these objects live, and what dies with the process?"*

```
  Where memory lives — and what kills it

  ┌─ Browser V8 (per tab) ──────────────────────────────────────┐
  │  React state   → component unmount kills it                  │
  │  sessionStorage → tab close kills it                         │
  └─────────────────────────│───────────────────────────────────┘
                            │
  ┌─ Vercel function (Node 20 V8) ──────────────────────────────▼┐  ← we are here
  │                                                              │
  │  ┌─ stack ──────────────────────────────────────────────┐    │
  │  │  function locals, async-frame state                   │    │
  │  │  e.g. messages[] in runAgentLoop, collected[] in start │    │
  │  │  lifetime = function/await frame; GC'd on return       │    │
  │  └──────────────────────────────────────────────────────┘    │
  │                                                              │
  │  ┌─ heap (long-lived) ──────────────────────────────────┐    │
  │  │  Map<string, Insight>          ← briefing's current   │    │
  │  │  Map<string, AgentEvent[]>     ← all investigations   │    │
  │  │  let cached: WorkspaceSchema   ← one object, forever │    │
  │  │  Map<string, {result, exp}>    ← MCP cache (TTL=60s) │    │
  │  │  lifetime = warm-instance lifetime; Vercel decides    │    │
  │  └──────────────────────────────────────────────────────┘    │
  │                                                              │
  │  ┌─ heap (short-lived, per request) ────────────────────┐    │
  │  │  AsyncLocalStorage ctx, decrypted store               │    │
  │  │  ReadableStream internal buffer (NDJSON bytes)        │    │
  │  │  lifetime = request lifetime                          │    │
  │  └──────────────────────────────────────────────────────┘    │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in — the concept.** Memory in this app isn't allocated and freed at fine grain — it's *born when a module loads and dies when Vercel evicts the process*. The TTL cache is the one exception, with explicit `expiresAt` checks. Everything else uses V8's GC implicitly (objects unreferenced when a function returns), or never gets unreferenced at all (the module-scope `Map`s).

---

## Structure pass

**Layers.** Three lifetimes nested:
1. **Per-call (stack-allocated, GC'd on return)** — function locals.
2. **Per-request (heap, GC'd when request handler returns)** — ALS contexts, the NDJSON buffer.
3. **Per-warm-instance (heap, GC'd never — until Vercel kills the process)** — module-scope `Map`s, `cached` schema.

**Axis traced: *when does this memory get freed?***

```
  "When does this memory get freed?" — across layers

  ┌─ stack-allocated locals ─────────────────────┐
  │  messages[], toolCalls[], collected[]         │   → freed when fn returns
  │  alive: ~100s during a long agent run         │
  └────────────────────┬─────────────────────────┘
                       │
  ┌─ per-request heap objects ───────────────────▼┐
  │  ALS ctx, ReadableStream buffer                │   → freed when request ends
  │  alive: ≤300s (the maxDuration ceiling)        │
  └────────────────────┬──────────────────────────┘
                       │
  ┌─ module-scope (warm-instance lifetime) ──────▼┐
  │  insights / investigations / cached / .cache  │   → freed when Vercel kills
  │  alive: minutes to hours                       │     the process (no app
  │                                                │     code controls this)
  └───────────────────────────────────────────────┘

  the answer flips at each altitude: the deeper the scope,
  the LESS control we have over the lifetime.
```

**Seams.** Two:

1. **Between request and warm-instance scope.** The boundary where state survives a single request to "help the next one" — or doesn't. Every `Map` in `lib/state/*` and the `cached` schema sit on this boundary.
2. **Between warm-instance and cold-instance.** The Vercel boundary. The repo treats this seam by holding nothing here that MUST survive (everything important is reconstructible from MCP + the encrypted cookie + the committed demo JSON).

---

## How it works

### Move 1 — the mental model

You already know how `const x = [...]` inside a function gets freed when the function returns — V8's GC walks reachability from the roots and drops anything no longer reachable. The interesting object lifetimes in this app aren't function locals, though — they're things you write into a `Map` at module scope that nothing ever removes. As far as V8 is concerned, those objects are alive forever. They only "die" when the process itself dies.

```
  The memory kernel — what alive means in this app

       ┌─ short-lived ─────────────────────────────────┐
       │  function locals → die on return              │
       │  request-scoped → die on response sent        │
       └──────────────────────────────────────────────┘
                              │
                              ▼
       ┌─ long-lived ────────────────────────────────┐
       │  module-scope Map  → die when process dies   │
       │  module-scope let cached → same              │
       │  TTL-cache entries → die at expiresAt OR     │
       │                       on the next .set with  │
       │                       the same key           │
       └─────────────────────────────────────────────┘

  Vercel decides when the process dies. We don't get a callback.
```

### Move 2 — the moving parts

#### 1) The stack — function locals and async frames

Every async function has a *frame*. When the function `await`s, V8 captures the frame's state onto the heap (so it can be restored when the awaited promise resolves) and lets the synchronous call stack unwind. When the await resolves, V8 reconstructs the frame, the local variables are still there, the function continues. From a GC standpoint, an `await`ed function's locals are reachable as long as something (the pending promise, the event loop's pending I/O callback) holds a reference to the frame.

```
  Async function frames — what stays alive across an await

  async function runAgentLoop(...) {
    const messages = [...]    ← captured into the frame on the heap
    const toolCalls = [...]

    for (let turn = 0; turn < maxTurns; turn++) {
      const res = await anthropic.messages.create(params);
                  ▲
                  └─ frame captured: messages, toolCalls, turn are all
                     held alive while we wait (the I/O callback owns
                     the reference). Released once the function returns
                     and the response stream's start() returns too.
      ...
    }
  }
```

What this means in practice: `runAgentLoop`'s `messages[]` array stays alive for the whole run (~100s). It grows as we push assistant/user turns. The history can be hundreds of KB by the end of a multi-turn investigation. GC won't free it until the function returns.

#### 2) The truncation guard — the one explicit memory cap inside the loop

`runAgentLoop` truncates every tool result to 16KB before pushing it into the message history (`lib/agents/base.ts:29-34`). Without it, a single tool result returning a megabyte of JSON would balloon the `messages[]` array on every turn and ALSO bloat every subsequent Anthropic call (since we send the full history every turn — that's how Claude messages work).

```
  The 16KB truncation guard — bounded growth per turn

  agent turn N:
    tool result JSON = 500KB
    truncate → 16KB + "…[truncated]"   ← bounded
    messages.push({ role: 'user', content: [{ type: 'tool_result', content: "…16KB…" }] })

  agent turn N+1:
    anthropic.messages.create({
      messages: [...all prior turns...]   ← grows linearly, but each entry bounded
    })

  without the truncation: messages[] could be megabytes by turn 8;
  each Anthropic call would bill for all of it on every turn.
```

What breaks without it: not OOM in practice (Vercel's 1GB+ default would absorb it), but **token-cost explosion** — every turn re-pays for the full history. The 16KB cap keeps history growth linear-and-cheap.

#### 3) The TTL cache — the one explicit eviction policy

`McpClient.cache` (`lib/mcp/client.ts:80, 102-110, 137-145`) is a `Map<cacheKey, { result, expiresAt }>`. Default TTL is 60s. Eviction is lazy — entries are only removed on the next access that finds them expired. There's no background reaper.

```
  TTL cache — lazy eviction, in-place rewrite

  callTool('get_event_schema', { project_id: 'p1' })
    cacheKey = 'get_event_schema:{"project_id":"p1"}'
    cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now())
      return cached  ← hot path (microseconds; no MCP roundtrip)

    // miss or expired → make the real call
    let result = await this.liveCall(...)
    ...
    this.cache.set(cacheKey, { result, expiresAt: Date.now() + ttl })
                              ▲
                              └─ overwrites the prior expired entry;
                                 doesn't leak.

  the cache can ONLY grow to "number of distinct (tool, args) tuples
  ever queried in the warm-instance lifetime." For one agent run,
  ~6-12 entries; for a long-running warm instance hosting many users,
  potentially hundreds — still small.
```

What breaks without it: every call hits the rate-limited MCP server (~1 req/s) and pays the 1.1s spacing gate. The 60s TTL absorbs repeats (a re-run of the same tool with the same args). The cap-on-growth comes for free from "distinct tuples seen" being inherently bounded by what agents query.

#### 4) The module-scope `Map`s — no eviction, no bound

`lib/state/insights.ts`'s `insights` and `anomalies` Maps are cleared on every `putInsights` (the briefing replaces, doesn't append). Bounded by "the size of one briefing's output" — at most 10 anomalies (`monitoring.ts:119` `.slice(0, 10)`). Tiny.

`lib/state/investigations.ts`'s `mem` Map, in contrast, grows monotonically. Every `saveInvestigation(insightId, events)` adds an entry; nothing ever removes one. Each entry holds the full AgentEvent[] for that investigation (could be dozens of events, each carrying a tool result up to 4KB after the `trunc(...)` in the routes — see `app/api/agent/route.ts:99-103`).

```
  The investigations Map — monotonic growth, bounded by process life

  saveInvestigation('insight-A', eventsA)   ← +1 entry, ~50KB
  saveInvestigation('insight-B', eventsB)   ← +1 entry, ~50KB
  saveInvestigation('insight-C', eventsC)   ← +1 entry, ~50KB
  ...
  (no eviction; the only way to shrink is process restart)

  practical ceiling: a hackathon-scale warm instance handles maybe
  20-50 distinct investigations before Vercel evicts. Total ~1-5MB.
  not a problem TODAY. would become one at production scale.
```

What breaks: nothing yet. Worth knowing: if the app served 1000 distinct investigations on one warm instance (it won't, at current usage), this Map would hit hundreds of MB. The fix would be an LRU cap (e.g. `lru-cache`) or moving the cache off-process (Redis/KV). Documented honestly because the spec asks for it: **not a current problem, but the lever to pull if the access pattern changes**.

#### 5) The `cached` schema — one object for the warm-instance lifetime

`lib/mcp/schema.ts:131` holds `let cached: WorkspaceSchema | null = null`. Once `bootstrapSchema` populates it, it stays populated until the process dies. The object holds the project's event list (capped at 20 events, each at 10 props in `schemaSummary` — but the FULL list in `cached`), customer properties, catalogs, totals. Tens of KB.

```
  cached schema — born once, lives until process death

  request 1 (cold):  cached = null → bootstrap (4 MCP calls, ~5s) → cached = WS{}
  request 2 (warm):  cached truthy → return immediately (microseconds)
  request 100:       cached truthy → return immediately
  ...
  process eviction:  cached is gone, next request cold-bootstraps again

  the GC never frees this object because the module-scope `let` holds
  a reference. that's by design — the cost of bootstrap is too high
  to pay per-request.
```

#### 6) The ReadableStream buffer — short-lived per request

When the route enqueues bytes (`controller.enqueue(encoder.encode(...))`), they go into the platform's `ReadableStream` internal buffer until the client reads them. The buffer is per-request. It's drained as the HTTP body is delivered. When `controller.close()` is called and the body completes, the buffer is GC'd.

```
  NDJSON buffer — bounded by stream lifecycle

  request lifecycle:
    start(controller) {
      send(eventA)   → buffer: [eventA-bytes]
      send(eventB)   → buffer: [eventA-bytes, eventB-bytes]
      (client reads) → buffer: [eventB-bytes]
      send(eventC)   → buffer: [eventB-bytes, eventC-bytes]
      ...
      controller.close()
    }
    response body complete → buffer GC'd

  per-event size: ~100B to ~4KB (tool results truncated to 4000 chars
                   in the route — TRUNC at app/api/agent/route.ts:99).
  total per stream: hundreds of KB to ~1MB for a long investigation.
  GC pressure: negligible.
```

### Move 3 — the principle

**In a process-resident runtime, "lifetime" beats "size" as the thing to reason about.** Most performance bugs in serverless aren't OOM — they're stale-state surprises ("why did my Map come back empty?") or cold-start latency ("why did this request take 5s?"). The right discipline is naming the lifetime of every heap object the way the comments in this repo do for the `cached` schema and for `insights`: who clears it, when, and what happens when the process dies underneath it.

---

## Primary diagram

The full memory + lifetime picture for one warm Node instance:

```
  Memory in one warm Vercel instance — lifetimes named

  ┌─ Node process (V8 heap) ─────────────────────────────────────────────┐
  │                                                                      │
  │  ┌─ MODULE SCOPE (warm-instance lifetime) ─────────────────────────┐ │
  │  │                                                                 │ │
  │  │  insights        Map<string, Insight>     ≤10 entries           │ │
  │  │                  cleared on each putInsights — bounded          │ │
  │  │                                                                 │ │
  │  │  anomalies       Map<string, Anomaly>     ≤10 entries           │ │
  │  │                  cleared with insights                          │ │
  │  │                                                                 │ │
  │  │  investigations  Map<string, AgentEvent[]> MONOTONIC growth     │ │
  │  │                  no eviction; only process restart shrinks      │ │
  │  │                  practical ceiling: 1-5MB at current scale      │ │
  │  │                                                                 │ │
  │  │  cached schema   WorkspaceSchema           one object, ~tens KB │ │
  │  │                  bootstrapped once per warm instance            │ │
  │  │                                                                 │ │
  │  │  (per-request McpClient.cache lives at this scope too, but the  │ │
  │  │   McpClient itself is per-request — so the cache is too)         │ │
  │  └─────────────────────────────────────────────────────────────────┘ │
  │                                                                      │
  │  ┌─ PER-REQUEST (≤300s lifetime, bounded by maxDuration) ──────────┐ │
  │  │                                                                 │ │
  │  │  ALS ctx { store, dirty }     ~few KB (decrypted auth state)    │ │
  │  │  McpClient instance            with its own 60s TTL cache       │ │
  │  │  ReadableStream buffer          NDJSON bytes, drains to client   │ │
  │  │  collected[] (in route)         all events for saveInvestigation │ │
  │  └─────────────────────────────────────────────────────────────────┘ │
  │                                                                      │
  │  ┌─ PER-CALL (function-frame lifetime) ────────────────────────────┐ │
  │  │                                                                 │ │
  │  │  runAgentLoop messages[]   linear growth per turn, bounded by   │ │
  │  │                            16KB truncation per tool_result      │ │
  │  │  toolCalls[]               linear growth per tool call            │ │
  │  │  textBlocks[], toolUses[]   per-turn, GC'd between turns         │ │
  │  └─────────────────────────────────────────────────────────────────┘ │
  │                                                                      │
  └────────────────────────────────│─────────────────────────────────────┘
                                   │  Vercel evicts → ALL of the above
                                   ▼  is gone. Cold start rebuilds.
                                  💀
```

---

## Implementation in codebase

**Use cases.**

- A user opens the briefing — the schema is bootstrapped (cold) or hit from `cached` (warm). The 60s TTL cache makes repeated EQL calls within a run essentially free.
- A user opens an investigation that was already captured — `getCachedInvestigation` hits the `mem` Map for free; the route replays the AgentEvent[] with a paced `setTimeout`.
- The instance has handled 50 distinct investigations — the `mem` Map holds 50 AgentEvent[] arrays, several MB total. No eviction; no problem unless the platform keeps the instance warm for hours.

**Code side by side.**

```
  lib/mcp/client.ts (lines 80, 102-110, 137-145) — the only TTL cache

  private cache = new Map<string, { result: unknown; expiresAt: number }>();
                                                     │
                                                     └─ explicit lifetime stamp

  async callTool<T>(name, args, options = {}) {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
    const ttl = options.cacheTtlMs ?? 60_000;

    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result as T, durationMs: 0, fromCache: true };
              │
              └─ HOT PATH — microseconds. Skips the spacing gate AND the HTTP call.
      }
    }
    // ... make the real call, then:
    this.cache.set(cacheKey, { result, expiresAt: now + ttl });
                              │
                              └─ overwrites prior expired entry in place; bounded growth.
  }
```

```
  lib/agents/base.ts (lines 29-34) — the 16KB cap on per-turn growth

  const MAX_TOOL_RESULT_CHARS = 16_000;

  function truncate(s: string): string {
    if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
    return s.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]';
                                                │
                                                └─ Caps each tool_result entry in the
                                                   message history. Critical because
                                                   we send messages[] in FULL on every
                                                   turn — without truncation, a big
                                                   result lives forever in history,
                                                   costing tokens every turn.
  }
```

```
  lib/state/investigations.ts (lines 11, 30-41) — monotonic in-memory map

  const mem = new Map<string, AgentEvent[]>();   ← module scope, lives until process dies

  export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
    mem.set(insightId, events);   ← APPENDS forever; no eviction
    if (PERSIST) {                 ← dev-only: also write through to disk
      const all = readJson(CACHE_FILE);
      all[insightId] = events;
      try {
        writeFileSync(CACHE_FILE, JSON.stringify(all));
      } catch {
        /* best effort */
      }
    }
  }
       │
       └─ At current scale (tens of investigations per warm instance),
          this is fine. At production scale (thousands), this becomes
          memory bloat. The lever: swap mem for an LRU cache.
```

```
  app/api/agent/route.ts (lines 99-103) — the per-event 4KB truncation

  const TRUNC = 4000;
  const trunc = (v: unknown): unknown => {
    const s = JSON.stringify(v);
    return s && s.length > TRUNC ? s.slice(0, TRUNC) + '…' : v;
  };
       │
       └─ Applied to every tool_result that goes into the NDJSON stream
          (and into the saved AgentEvent[]). Bounds the size of the
          investigation cache entry — without it, one big EQL result
          could make a single cached investigation 100KB+.
```

---

## Elaborate

V8's GC for Node is generational: a "new" space for short-lived objects (most of `runAgentLoop`'s per-turn locals end up here), an "old" space for things that survived a few collections (the module-scope `Map`s, the `cached` schema). The collector runs in the same thread as your JS — a major GC pause shows up as "the loop didn't make progress for X ms." At this app's working-set size (tens of MB at most), GC pauses are sub-millisecond and not worth tuning.

Worth reading next: the V8 "Trash Talk" / Orinoco GC blog series (for the generational model), and Vercel's docs on function memory limits + the trade-off between provisioned memory and CPU share.

---

## Interview defense

**Q: What's the longest-lived heap object in this app, and why is that OK?**
A: The `cached` schema in `lib/mcp/schema.ts:131`. It lives for the warm-instance lifetime — could be minutes to hours. That's deliberate: bootstrapping it costs 4 sequential MCP calls under the 1.1s spacing gate (~4-5s). Paying that on every request would dominate latency. The trade-off: a stale schema if the project's events change while a warm instance is alive. Acceptable because the bootstrap is cheap on cold start, the data is stable for hours at a time, and the `_resetSchemaCache()` test hook gives us an escape valve.

```
  cached schema lifetime — bounded by Vercel, not by code

  cold start    warm reuse       warm reuse      ...      eviction
  ───────────   ───────────      ───────────              ───────────
  bootstrap     return cached    return cached            cached gone
  ~4-5s         microseconds     microseconds             cold-start next
```

**Q: The `investigations` Map grows monotonically. Why isn't that a memory leak you have to fix?**
A: At current scale (a handful of investigations per warm instance lifetime, each ~50KB after the 4KB-per-event truncation), the total is single-digit MB — well under Vercel's default 1GB function memory. It's a *deferred* problem, not an absent one. The honest answer: it's the next thing I'd cap with an LRU before this goes to production with sustained traffic. Today, the platform evicts the process before the Map gets big enough to matter.

---

## Validate

1. **Reconstruct.** Draw the three lifetimes (per-call, per-request, per-warm-instance). Place each piece of state from the codebase into the right tier.
2. **Explain.** Why does `runAgentLoop` keep `messages[]` as a function local instead of caching it module-scope across turns? (Each request needs its own conversation history; sharing would mean every concurrent request sees every other's turns. Function-local is the correct scope.)
3. **Apply.** A new tool returns a 5MB CSV. Where does that get truncated to bound memory growth, and what's the consequence of removing the truncation? (Truncation happens at `lib/agents/base.ts:33` — caps the entry in `messages[]`. Without it, the CSV lives in every subsequent Anthropic call's message history, costing tokens and growing the heap.)
4. **Defend.** Defend the choice to never evict entries from the `investigations` Map. When does this stop being defensible? (Defensible today: at hackathon scale, total memory is a few MB; Vercel evicts the process long before it becomes a problem. Stops being defensible when sustained traffic + warm-instance longevity push it past ~100MB — at which point switch to LRU or move to KV/Redis.)

---

## See also

- `02-processes-threads-and-tasks.md` — the process whose death frees all this memory.
- `04-shared-state-races-and-synchronization.md` — what the module-scope `Map`s share.
- `06-filesystem-streams-and-resource-lifecycle.md` — the OTHER kind of lifetime (file handles, stream controllers).
- `07-backpressure-bounded-work-and-cancellation.md` — the bounds that keep `messages[]` from growing unbounded.
