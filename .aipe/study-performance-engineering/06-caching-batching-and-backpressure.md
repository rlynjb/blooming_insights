# Caching, batching, and backpressure

**Industry name(s):** TTL cache · run-cache · prompt-prefix cache · batch · rate-limit compliance · backpressure
**Type:** Industry standard · Language-agnostic

> blooming insights has **two real caches** — the `McpClient` 60-second TTL cache on tool results (`lib/mcp/client.ts:80`) and the module-level `WorkspaceSchema` cache (`lib/mcp/schema.ts:131`) — plus a third **investigation-replay cache** that's really a *demo persistence layer* (`lib/state/investigations.ts:11`). It has **no batching** (Bloomreach's MCP exposes no batch endpoint; Anthropic's `messages` API is one-turn-per-call). It has **no backpressure** — the spacing gate in `McpClient.liveCall` is **rate-limit compliance**, not backpressure. The distinction matters because backpressure needs a queue with depth and an upward signal; this system is single-flight, with no queue and no fan-out. The spacing gate looks like throttling but is actually a *floor*; the cache is what does the heavy lifting on a warm run.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three different patterns sit at the same provider/transport layer and people confuse them: *caching* (don't make the call), *batching* (combine N calls into 1), and *backpressure* (when fan-out outpaces the consumer, signal the producer to stop). They solve different problems. Caching saves the round-trip cost on a hit; batching amortizes per-call overhead across multiple ops; backpressure prevents an unbounded queue when producers are faster than consumers. blooming insights does caching well, has no batching opportunity, and *does not have backpressure* — what looks like it (the spacing gate) is a different thing entirely.

```
  Zoom out — where these three patterns would live          ← we are here

  ┌─ Agent loop ─────────────────────────────────────┐
  │  no batching (per-call conversation turns)       │
  │  no fan-out (sequential single-flight)           │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Provider/transport ▼─────────────────────────────┐
  │  ★ McpClient TTL cache (60s) ★                     │  ← CACHING (real, works)
  │  ★ Schema cache (per-instance, lifetime) ★        │  ← CACHING (real, works)
  │  ★ Investigation replay cache ★                    │  ← REPLAY (not really cache)
  │                                                    │
  │  ★ spacing gate (1100ms floor) ★                   │  ← RATE-LIMIT COMPLIANCE
  │     NOT backpressure — no queue, no signal         │
  │                                                    │
  │  no batching (provider doesn't support it)         │
  │  no prompt-prefix cache (Anthropic feature unused)│
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ External ──────────▼─────────────────────────────┐
  │  Bloomreach: 1 req/s ceiling                       │
  │  Anthropic: free prompt-prefix caching available   │
  └───────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *what's cached, what isn't, what's mistaken for caching/backpressure that isn't, and where would each pattern actually fit?* The answer is *two real caches with clean TTL semantics, one replay-as-persistence layer that masquerades as a cache, no batching opportunity, no backpressure*. Below, you'll see the cache mechanics, the deliberate batching absence, and the spacing-gate-vs-backpressure distinction that pops if you trace the failure axis.

---

## Structure pass

**Layers.** All three patterns live at the Provider/Transport band; the agent loop above and external services below are mostly consumers. The distinction between them is *what they do at that one band*.

**Axis: failure mode.** Hold one question constant across the three patterns: *when this pattern is missing, what fails, and how loudly?* Failure is the right axis because the three patterns solve different *failure modes* — caching fails to a slow call (loud: latency spike), batching fails to a quota burst (loud: 429s), backpressure fails to a memory exhaustion (silent: OOM, queue overflow). Mistaking one for another means you "fix" the wrong failure mode. The spacing gate is the classic example: it looks like throttling/backpressure but is actually a *rate-limit floor* — it solves the 429-storm failure, not the queue-overflow failure.

**Seams.** Two load-bearing.

- **CBB1: hit ↔ miss.** Every cache has this seam. On a hit, the cost flips from "full network round-trip + spacing + maybe retry" to "0 ms, 0 tokens, 0 quota." This is the seam that makes the 60s TTL worth setting — see how often the agent re-derives the same EQL.
- **CBB2: compliance ↔ backpressure.** Same code shape (sleep before the call) but different semantics. Compliance: "the rate limit forbids more than 1/sec, so I sleep to obey." Backpressure: "the consumer is slower than the producer, so I signal the producer to stop." The first is a *constraint*; the second is a *contract*. blooming insights has the first; it has no fan-out, so it doesn't need the second.

```
  Structure pass — Caching + batching + backpressure

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  Agent loop · Provider/transport · External       │
  │  (all three patterns sit at Provider/transport)   │
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  failure mode: what fails when this is missing?   │
  └────────────────────────┬─────────────────────────┘
                           │  trace it across patterns
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  CBB1: hit ↔ miss            (cache leverage)     │
  │  CBB2: compliance ↔ backpressure   ★ load-bearing │
  │        (same sleep, different semantics)          │
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest walks the cache mechanics, the batching absence, and the compliance-vs-backpressure distinction.

---

## How it works

### Move 1 — the mental model

You've put a `useMemo` in a React component to skip recomputing a value when its inputs haven't changed — same shape as a cache. You've debounced an `onChange` to avoid firing a hundred network requests per keystroke — same shape as rate-limit compliance. You've held a `useEffect` cleanup function to abort an in-flight `fetch` when a component unmounts — that's *cancellation*, a sibling of backpressure. blooming insights uses the first two patterns at the provider layer; it doesn't need the third because nothing fans out.

```
  Pattern — three patterns, three failure modes

   CACHING        miss → full cost  /  hit → 0 cost
                  failure when missing: every call pays full price
                  who fixes it: store result, key it well, TTL it sensibly

   BATCHING       1 round-trip → N ops worth of work
                  failure when missing: N round-trips of overhead
                  who fixes it: provider exposes a batch endpoint (NOT HERE)

   BACKPRESSURE   producer signaled when consumer can't keep up
                  failure when missing: unbounded queue → OOM, or dropped work
                  who fixes it: semaphore + queue + upward "stop" signal

   blooming insights:
     caching ✓  (60s TTL + schema cache)
     batching ✗  (no provider support)
     backpressure ✗  (no fan-out → no need)
     looks-like-backpressure ✓  (spacing gate = compliance, not backpressure)
```

The model: **each pattern answers a different question**. "Did I already pay for this?" → cache. "Can I pay for many at once?" → batch. "Is anyone listening to me when I shout?" → backpressure. The spacing gate answers "am I allowed to send another?" — which is *neither* of the three. It's rate-limit compliance: a synchronous self-imposed delay to stay under a quota.

---

### Move 2 — the three caches + the absent batching + the gate that isn't backpressure

#### Move 2.1 — Cache 1: McpClient TTL cache (60s, exact-match)

The `McpClient.cache` is a `Map<string, { result; expiresAt }>` keyed on `${name}:${JSON.stringify(args)}` (`lib/mcp/client.ts:80, 102-110`). Every successful tool call is stored with `expiresAt = now + 60_000`. A subsequent call with identical args within 60s returns the cached result with `durationMs: 0, fromCache: true` — bypassing both the spacing gate *and* the network entirely.

```
  Pattern — Cache 1 (TTL Map keyed on stringified args)

   key:          "execute_analytics_eql:{\"project_id\":\"abc\",\"eql\":\"select count event purchase ...\"}"
   value:        { result: <Bloomreach response>, expiresAt: <now + 60_000> }

   on call:
     check map[key]
     if exists and expiresAt > now:
        return result, durationMs:0, fromCache:true       ← HIT (cost-free)
     else:
        sleep until spacing gate clears
        await transport.callTool(name, args)               ← MISS (~1.5-3s)
        if !isError: map[key] = { result, expiresAt }      ← store (don't poison)
        return result, durationMs:<measured>, fromCache:false

   WHY 60 SECONDS:
     long enough that within one investigation, the agent's revisits
     of the same EQL hit cache (agents often re-derive a query when
     exploring a hypothesis)
     short enough that between investigations, the data isn't stale
     (a fresh briefing should see fresh numbers)

   WHY EXACT-MATCH (no semantic similarity):
     a stale exact-match hit is bounded (the user asked the same question
     twice within 60s — they probably expect the same answer)
     a semantic-similar hit could be subtly wrong (cf. study-agent-architecture/05/01)

   WHY ERROR RESULTS NOT CACHED:
     lib/mcp/client.ts:137 — `if ((result as any)?.isError === true) return ...`
     caching a rate-limit error means the retry happens 60s later regardless
     of whether the rate limit cleared; bypassing the cache for errors lets
     the next call try again immediately (after spacing).
```

The boundary: **the cache is the only thing that turns a Bloomreach round-trip into a 0ms operation**. Every other optimization (spacing, retry, truncation) still pays the network cost; the cache *skips* it. On a warm agent run where the model re-derives 2 of 6 EQL queries, that's ~3-6s saved per agent — a ~3-6% speedup on a ~100s investigation, *and* the saved calls don't count against the rate limit.

#### Move 2.2 — Cache 2: schema cache (module-level, instance lifetime)

`lib/mcp/schema.ts:131` declares `let cached: WorkspaceSchema | null = null`. The first call to `bootstrapSchema` populates it (4-6 MCP calls); every subsequent call in the same warm instance returns the cached value in microseconds.

```
  Pattern — Cache 2 (single-slot, no TTL, per-instance)

   key:          (none — single slot per module)
   value:        WorkspaceSchema | null
   TTL:          none — lives until the function instance cools

   on bootstrap:
     if cached !== null: return cached                ← HIT (~0 ms)
     else: run 4-6 MCP calls (~6-12s); cached = result; return ← MISS

   WHY NO TTL:
     workspace schema doesn't change minute-to-minute. An event being added
     to a workspace happens at deploy / config time, not request time.
     A short TTL would add bootstrap latency without meaningful staleness
     benefit.

   WHY NO INVALIDATION:
     no signal exists from Bloomreach that "your schema changed."
     The de-facto invalidation is cold start (instance dies, cache is gone).
     A test-only _resetSchemaCache() exists for the test path (lib/mcp/schema.ts:194).

   THE STALENESS TRADE:
     if a user adds an event type and immediately runs a briefing, the
     warm instance won't see the new event until cold restart.
     for demo-scale traffic this is invisible (instances cycle frequently).
     for a long-warm-instance production load, this would be a real bug.
     fix if it bites: add a TTL (~60s, matching Cache 1) to bound staleness.
```

The boundary: **Cache 2 saves the most absolute time per warm request (~6-12s) but the least per-investigation**. The 6-12s is paid once per instance; after that, every request in that instance is faster. Cache 1 is the per-request win; Cache 2 is the per-instance win.

#### Move 2.3 — Cache 3: investigation replay (a persistence-layer-as-cache)

`lib/state/investigations.ts` holds `mem: Map<string, AgentEvent[]>`. Completed investigations are stashed there by `saveInvestigation` (`app/api/agent/route.ts:254`); the next request for the same `insightId` (without `?live=1`) replays the events from memory through the NDJSON stream (`app/api/agent/route.ts:127-141`).

```
  Pattern — Cache 3 (replay store)

   key:          insightId (UUID)
   value:        AgentEvent[]   (~100-200 events per investigation)
   eviction:     none (only cleared by instance death or _clearInvestigationCache)
   source:       in-memory Map → dev file → committed demo JSON
                 (lib/state/investigations.ts:22-28, three-source fallback chain)

   on /api/agent?insightId=X:
     if cached and !live: replay cached events at REPLAY_DELAY_MS (180ms) ← REPLAY
     else: run the agent live → save to cache on done                     ← LIVE

   WHY THIS IS NOT REALLY A CACHE:
     a cache says "I already computed this; the result is the same."
     this says "I already showed this to you; here it is again, paced
     for replay." A live re-run with the same anomaly would produce
     a DIFFERENT investigation (different LLM sampling, possibly different
     EQL, different evidence). The "cache" is correct for demo replay
     (showing the snapshot) and for revisiting an investigation in-session,
     NOT for "skip recomputation because the answer is stable."

   WHY IT'S DESIGNED THIS WAY:
     it makes the demo path free (replay a captured run instead of running
     live), enables instant page reloads of past investigations, and gives
     the team a fixture for the UI without depending on the agents.
     the cost is: it can grow unboundedly in a warm instance (no .delete).
     see file 04 for the unbounded-growth note.
```

The boundary: **Cache 3's job is mostly UX (instant page reload, free demo) and dev (committed JSON fixtures), not perf**. It saves ~100s by replaying instead of re-running, but each replay still takes ~30-50s (paced by `REPLAY_DELAY_MS = 180`) — so it's not a "0ms" cache. It's a *persistence layer* that the route handler treats as a cache.

#### Move 2.4 — the absent batching (intentional)

There's no batching anywhere in this codebase. The decision is forced by the providers:

```
  Pattern — batching opportunities (all absent)

   1. Bloomreach MCP — no batch endpoint
      each EQL query is one tool call, one HTTPS POST
      no way to send 3 queries in 1 round-trip
      ⇒ batching IS NOT POSSIBLE at this layer

   2. Anthropic messages.create — no batch (per turn)
      each turn is one HTTPS POST with one messages array
      Anthropic offers batched inference, but only for fire-and-forget
      jobs with long turnaround (hours) — not for the synchronous
      tool-use loop blooming insights runs
      ⇒ batching IS NOT POSSIBLE at this layer

   3. NDJSON event emission — already batched in TCP
      Node's HTTP stack already buffers chunks at the TCP layer;
      explicit micro-batching (e.g. accumulate 10 events, flush together)
      would HURT the streaming UX (events arrive late)
      ⇒ batching WOULD BE WORSE at this layer

   What this means:
     if batching is a perf lever you're reaching for, it's not available.
     the cache (Cache 1) is the closest equivalent — it removes calls
     instead of combining them.
```

The boundary: **"no batching" is an external constraint, not a missed optimization**. The fix isn't "add batching"; the fix is "remove the call entirely" (caching) or "raise the per-user rate ceiling" (upgrade Bloomreach plan).

#### Move 2.5 — the spacing gate is NOT backpressure

This is the load-bearing distinction in the file. The spacing gate (`lib/mcp/client.ts:148-152`) sleeps `minIntervalMs - elapsed` before every call. It *looks* like throttling/backpressure but it's neither.

```
  Pattern — spacing gate vs backpressure (the distinction)

   ──── SPACING GATE (what we have) ──────────────────────────────
   shape:        await sleep(1100 - elapsed_since_last_call) before each call
   purpose:      stay under Bloomreach's "1 req/s/user" rate limit
   trigger:      every call (not conditional on load)
   queue:        none (single-flight by await chain)
   feedback:     none (sleeps deterministically, doesn't signal producer)
   failure mode it prevents: 429 storms (Bloomreach refusing calls)
   ────────────────────────────────────────────────────────────────

   ──── BACKPRESSURE (what we don't have) ────────────────────────
   shape:        bounded queue (depth M) + semaphore (≤K in flight)
                  + upward signal to producer when queue depth hits M
   purpose:      bound memory + dropped-work when producer faster than consumer
   trigger:      only when consumer falls behind (load-conditional)
   queue:        explicit, with depth cap
   feedback:     yes — signal producer to stop spawning
   failure mode it prevents: queue exhaustion / OOM / dropped work
   ────────────────────────────────────────────────────────────────

   WHY blooming insights doesn't NEED backpressure:
     - the topology is sequential (one agent at a time, user-gated)
     - no fan-out (no parallel workers spawned by a supervisor)
     - no queue (each call awaits the previous one in the same async chain)
     - the producer IS the consumer (the agent loop awaits its own tool call)
     ⇒ there's nothing to signal — the producer cannot run ahead

   WHEN blooming insights WOULD need it:
     if the system ever ran agents in parallel (e.g. monitoring the 10
     categories concurrently instead of sequentially in one agent's loop),
     the spawned agents could all hit the spacing gate at the same time
     and the in-process queue (the await chain) would grow. THAT is when
     a semaphore + upward signal becomes necessary.
     cross-ref: study-agent-architecture/05-production-serving/02-fan-out-backpressure.md
```

The principle: **the spacing gate's failure mode is the 429; backpressure's failure mode is OOM**. Same code shape (a `setTimeout`-based sleep), opposite semantics. The 1100ms spacing gate is the right *compliance* solution for a single-flight rate-limited consumer. It would be the wrong *backpressure* solution for a fan-out consumer because it has no queue and no signal — it only knows about *this* call's timing relative to the prior one.

---

### Move 3 — the principle

**Caching saves the call; batching combines the call; backpressure controls who's allowed to make the call**. The three patterns answer different questions and have different failure modes. Mistaking one for another means you write the wrong code — a spacing gate masquerading as backpressure is fine *until you fan out*, at which point the gate fails silently (calls pile up in the await chain; no signal goes to the producer). blooming insights is correct *today* because the topology is sequential; the same code would be wrong tomorrow if a parallel-monitoring feature shipped. Naming what each pattern actually does is what lets you reuse it (or not) safely.

---

## Primary diagram

The full picture — three caches, no batching, a spacing gate that isn't backpressure.

```
  blooming insights — caching, batching, backpressure at a glance

  ┌─ Cache 1: McpClient TTL cache ───────────────────────────────────────┐
  │  key:    name + JSON.stringify(args)                                  │
  │  value:  Bloomreach response                                          │
  │  TTL:    60 seconds                                                   │
  │  hit:    durationMs: 0, fromCache: true   (skips spacing + network)   │
  │  bypass: errors not cached (so retry happens after spacing, not 60s)  │
  │  lib/mcp/client.ts:80, :97-146                                        │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ Cache 2: schema cache (per warm instance) ──────────────────────────┐
  │  key:    (none — single slot)                                         │
  │  value:  WorkspaceSchema                                              │
  │  TTL:    none — lives until instance cools                            │
  │  hit:    ~microseconds (skip ~6-12s of bootstrap)                     │
  │  lib/mcp/schema.ts:131, :170-192                                     │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ Cache 3: investigation replay (persistence-as-cache) ───────────────┐
  │  key:    insightId                                                    │
  │  value:  AgentEvent[]                                                 │
  │  source: in-memory Map → dev file → committed demo JSON               │
  │  use:    replay the events at REPLAY_DELAY_MS=180ms instead of re-run │
  │  caveat: a live re-run would produce DIFFERENT events (LLM sampling)  │
  │          so this is replay/persistence, not perf-cache semantics      │
  │  lib/state/investigations.ts:11-28                                    │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ Batching ─────────────────────────────────────────────────────────────┐
  │  NOT EXERCISED — Bloomreach + Anthropic both expose 1-call-per-op APIs│
  │  no missed optimization; the providers don't support it               │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ Spacing gate (rate-limit COMPLIANCE, NOT backpressure) ─────────────┐
  │  shape:   await sleep(1100 - elapsed_since_last_call)                 │
  │  purpose: stay under Bloomreach 1 req/s/user                          │
  │  trigger: every call (deterministic, not load-conditional)            │
  │  queue:   NONE (single-flight via await chain)                        │
  │  signal:  NONE (no upward "stop" channel)                             │
  │  lib/mcp/client.ts:148-152                                            │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ Backpressure ─────────────────────────────────────────────────────────┐
  │  NOT EXERCISED — no fan-out topology in this codebase                 │
  │  would become necessary IF: parallel agents or per-category fan-out   │
  │  shape would be: semaphore + bounded queue + upward signal            │
  │  cross-ref: study-agent-architecture/05/02-fan-out-backpressure.md    │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ Prompt-prefix cache (Anthropic feature) ─────────────────────────────┐
  │  NOT EXERCISED — Anthropic offers prompt prefix caching for free      │
  │  blooming insights does not enable it (no cache_control breakpoints)  │
  │  cross-ref: study-ai-engineering/06/01-llm-caching.md                 │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases — when each pattern is reached for

- **Cache 1 (TTL cache)** — every MCP tool call goes through `McpClient.callTool`, which checks the cache first. Hits are common when the agent re-derives a query while exploring a hypothesis (e.g. "let me re-run last month's conversion rate to confirm").
- **Cache 2 (schema cache)** — every request that needs the schema (briefing + investigation flows) calls `bootstrapSchema`. The first request after a cold start pays ~6-12s; every subsequent request in that warm instance pays microseconds.
- **Cache 3 (investigation replay)** — the route handler in `/api/agent` checks the investigations Map before running the agent live; demo `?demo=cached` replay path on the briefing route does the same with committed JSON.
- **Spacing gate** — every MCP call goes through `liveCall`, which sleeps as needed. Active *constantly* — every Bloomreach round-trip pays it on every miss.
- **Batching, backpressure, prompt-prefix cache** — not exercised. Reach for backpressure if/when fan-out arrives; reach for prompt-prefix cache as a cheap shrink lever (file 01 of `study-ai-engineering/06`).

### Code side by side

**Cache 1 — the read path, hit and miss.**

```
  lib/mcp/client.ts  (lines 100–146)

  async callTool<T = unknown>(name, args, options): Promise<CallToolResult<T>> {
    const cacheKey = `${name}:${JSON.stringify(args)}`;          ← exact-match key
    const ttl = options.cacheTtlMs ?? 60_000;                    ← 60s default

    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result, durationMs: 0, fromCache: true };  ← HIT (free)
      }
    }

    const start = Date.now();
    let result = await this.liveCall(name, args);                ← MISS (spacing + network)

    // ... retry loop ...

    const durationMs = Date.now() - start;

    if ((result as any)?.isError === true) {                     ← don't cache errors
      return { result, durationMs, fromCache: false };
    }

    const now = Date.now();
    this.cache.set(cacheKey, { result, expiresAt: now + ttl }); ← store on success
    return { result, durationMs, fromCache: false };
  }
        │
        └─ FIVE design decisions in one function:
           (1) exact-match key (no semantic similarity → bounded staleness)
           (2) 60s default TTL (long enough to catch re-derives in one investigation)
           (3) skipCache option for "force fresh" path in /debug
           (4) errors not cached (so a rate-limit doesn't poison for 60s)
           (5) fromCache: true on hit (lets the UI render 0ms or "cached")
```

**Cache 2 — the single-slot module-level cache.**

```
  lib/mcp/schema.ts  (lines 131, 170–192)

  let cached: WorkspaceSchema | null = null;                    ← module-level slot

  export async function bootstrapSchema(mcp: McpClient): Promise<WorkspaceSchema> {
    if (cached) return cached;                                  ← HIT (microseconds)
    const { projectId, projectName } = await resolveProject(mcp);  ← 2 calls
    const args = { project_id: projectId };

    // Sequential — the server allows ~1 req/s; McpClient already spaces calls.
    const eventSchema = await callOrThrow(mcp, 'get_event_schema', args);
    const customerProps = await callOrThrow(mcp, 'get_customer_property_schema', args);
    const catalogs = await callOrThrow(mcp, 'list_catalogs', args);
    const overview = await callOrThrow(mcp, 'get_project_overview', args);

    cached = parseWorkspaceSchema({...});                       ← STORE (lifetime)
    return cached;
  }

  export function _resetSchemaCache(): void {                   ← test-only invalidation
    cached = null;
  }
        │
        └─ no TTL, no eviction, no LRU — the simplest possible cache.
           The cost of simplicity: stale schema until cold restart. The
           bound: cold start happens often on serverless (every ~15min
           of inactivity on Vercel), so staleness is bounded by warm
           window length, which is usually < 1 hour.
```

**Cache 3 — the three-source fallback chain.**

```
  lib/state/investigations.ts  (lines 11–28)

  const mem = new Map<string, AgentEvent[]>();                  ← in-memory primary

  function readJson(path: string): Record<string, AgentEvent[]> {
    try {
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    } catch { /* ignore */ }
    return {};
  }

  export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
    if (mem.has(insightId)) return mem.get(insightId)!;          ← 1. in-memory (this process)
    const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;
    if (fromFile) return fromFile;                                ← 2. dev cache file (dev only)
    const fromDemo = readJson(DEMO_FILE)[insightId];
    return fromDemo ?? null;                                      ← 3. committed demo snapshot
  }
        │
        └─ THREE sources in priority order: in-memory (per-process), dev
           file (dev only), committed demo JSON (always-available fixture).
           This isn't a cache in the "skip recomputation" sense — it's a
           replay store. The committed demo JSON is the load-bearing one:
           it makes the demo work without any credentials.
```

**The spacing gate — the rate-limit compliance, NOT backpressure.**

```
  lib/mcp/client.ts  (lines 148–157)

  private async liveCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const elapsed = Date.now() - this.lastCallAt;               ← time since last call ended
    if (elapsed < this.minIntervalMs) {                          ← under floor?
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));  ← sleep
    }
    try {
      const result = await this.transport.callTool(name, args);  ← actual HTTPS
      this.lastCallAt = Date.now();                              ← restart clock
      return result;
    }
        │
        └─ NOTICE what's NOT here:
           - no queue (single-flight by await chain)
           - no semaphore (no concurrency limit, no fan-out to limit)
           - no upward signal (nothing tells a producer to stop)
           - no load-conditional triggering (sleep fires every call)

           THIS IS RATE-LIMIT COMPLIANCE — a deterministic floor.
           The shape is "sleep before send"; the semantic is "obey the
           1 req/s constraint." The 1100ms is set just above 1000ms
           (the observed window) to leave headroom for clock skew.
```

**Where backpressure WOULD go if fan-out were added — currently absent.**

```
  // ── SPECULATIVE — what fan-out backpressure would look like here ──
  //
  // class MonitoringAgent {
  //   async scan(hooks, categories) {
  //     // CURRENT: ONE agent loop, ONE conversation, 6 tool calls max
  //     // FAN-OUT: 10 concurrent per-category sub-agents
  //     //
  //     // bounded queue would replace `categories.map(c => ...)`:
  //     //   const sem = new Semaphore(MAX_CONCURRENT_PER_USER)
  //     //   const queue = new BoundedQueue(MAX_QUEUE_DEPTH)
  //     //   for (const c of categories) {
  //     //     if (queue.depth >= MAX_QUEUE_DEPTH) STOP_SPAWNING ← upward signal
  //     //     queue.push(() => sem.run(() => runOneCategory(c)))
  //     //   }
  //
  // None of this exists today. The "supervisor" (the route handler) calls
  // ONE agent and awaits it. No queue, no semaphore, no upward signal.
  // Cross-ref: study-agent-architecture/05-production-serving/02-fan-out-backpressure.md
```

---

## Elaborate

**Where these patterns come from.** Caching is older than computing — Babbage's analytical engine had "results memory." Modern web/server-side caching frameworks (Varnish, Redis, browser HTTP cache) all share the TTL pattern. Batching is the OLAP/database optimization that says "amortize per-call overhead by combining ops" (think `INSERT INTO ... VALUES (...), (...), (...)`). Backpressure is the queueing-theory insight that producers faster than consumers cause unbounded queue growth — the fix is to *signal back* to the producer rather than silently buffer. Each pattern has a paper / book / RFC behind it; the practical lesson is that they solve different problems.

**Why batching doesn't fit here even where it might seem to.** You might think "fire 4 EQL queries in parallel from the diagnostic agent." But (a) Bloomreach's rate limit is per-user GLOBAL, so 4 parallel calls would still queue at the spacing gate; (b) the agent's tool calls are *sequential by design* — Claude waits for one result before deciding the next call; (c) even if you could parallelize, Bloomreach's MCP server has no batch endpoint, so 4 calls = 4 HTTPS POSTs no matter what. The closest thing to batching is the cache — it doesn't combine calls, but it removes them.

**Why the prompt-prefix cache is the missing shrink lever.** Anthropic offers free prompt caching: insert `cache_control` markers in your system prompt and the same prefix is re-tokenized once, then served from cache on every subsequent call within ~5 minutes. blooming insights doesn't use this. The system prompts are 5-10KB (the schema summary + the agent's persona). Every turn in the loop re-sends the same prefix — and Anthropic re-tokenizes it every time. Adding `cache_control` would cut input-token cost dramatically on multi-turn loops. The reason it's absent: it's a recent Anthropic feature and the codebase predates the widespread adoption pattern. See `study-ai-engineering/06/01-llm-caching.md` for the full mechanics.

**Connection to adjacent concepts.** File 03 explains why the cache's 0ms hit is the highest-leverage perf fix. File 04 explains the memory cost of the caches (Map size). `study-agent-architecture/05/01-cross-turn-caching.md` walks the three cache scopes (intra-turn, intra-run, cross-run) that the codebase has and the third it deliberately skips. `study-agent-architecture/05/02-fan-out-backpressure.md` walks the topology that would force backpressure to exist.

---

## Interview defense

### Q: blooming insights has a "1.1 second spacing gate" before every MCP call. Is that backpressure?

**Answer:** No — it's rate-limit compliance. Same code shape (sleep before the call), opposite semantic. Backpressure has a queue with depth and an upward signal telling the producer to stop when the queue fills. The spacing gate has no queue (single-flight by await chain), no semaphore (no concurrency to limit), and no signal (it just sleeps deterministically). It fires *every* call regardless of load, not just when the consumer can't keep up. The failure mode it prevents is the 429 storm from Bloomreach; backpressure prevents OOM from unbounded queue growth. blooming insights doesn't need backpressure because there's no fan-out — the producer (the agent loop) is the same goroutine as the consumer (the MCP call). The day someone parallelizes the per-category monitoring scan is the day backpressure becomes necessary.

```
  same code shape, opposite semantic

   SPACING GATE (we have)         BACKPRESSURE (we don't)
   ─────────────────────          ──────────────────────
   await sleep(N - elapsed)        await sleep + semaphore + queue
   purpose: obey rate limit        purpose: bound queue + signal producer
   trigger: every call             trigger: when queue depth → cap
   queue:   none                   queue:   bounded (depth M)
   signal:  none                   signal:  yes (stop spawning)
   needs:   rate limit             needs:   fan-out topology
```

### Q: What's the highest-leverage cache in this codebase, and why?

**Answer:** Cache 1, the McpClient TTL cache (`lib/mcp/client.ts:80`). It returns `durationMs: 0, fromCache: true` on a hit, bypassing *both* the spacing gate (1.1s wait) *and* the network round-trip. Every other optimization in the system still pays the network cost; the cache *removes the call entirely*. On a warm agent run where Claude re-derives 2 of 6 EQL queries (which happens often when exploring hypotheses), that's ~3-6s saved and 2 rate-limit slots returned. The 60s TTL is the right setting because it's long enough to catch intra-investigation re-derives but short enough to keep cross-investigation data fresh. The leverage is asymmetric: the cache is cheap (a `Map`, no infrastructure) and the savings compound with how often the agent revisits a query.

```
  Cache 1's leverage

   per HIT:    save 1.1s spacing + ~0.5-2.5s network = ~1.5-3s
              save 1 rate-limit slot (no quota consumption)
   per MISS:   pay normal cost (the cache adds zero overhead)

   typical investigation with 2 hits out of 12 calls:
     ~3-6s saved (3-6% of typical ~100s)
     2 rate-limit slots returned (reduces retry storm probability)

   the leverage scales with: how often Claude re-derives a query.
   the cap on the leverage: the 60s TTL bounds how stale a hit can be.
```

### Q: Anthropic offers free prompt-prefix caching. Why isn't it enabled?

**Answer:** It's the missing cheap shrink lever. The system prompts are 5-10KB each (schema summary + persona). Every turn in the agent loop re-sends the same prefix, and Anthropic re-tokenizes it every time. Adding `cache_control` markers would cut input-token cost dramatically — the cached portion costs ~10% of the uncached rate. The reason it's absent: prompt caching is a relatively recent Anthropic feature, and the codebase's agent loop predates the adoption pattern. The fix is small (add `cache_control: { type: 'ephemeral' }` to the appropriate content blocks); the win is cumulative across every turn × every agent × every investigation. Cross-ref `.aipe/study-ai-engineering/06/01-llm-caching.md` for the mechanics.

---

## Validate

**Level 1 — Reconstruct.** Name the three caches in blooming insights, their key, value, TTL, and the file:line they live at. (Answer: Cache 1 — `McpClient.cache` in `lib/mcp/client.ts:80`, key `name:JSON.stringify(args)`, value Bloomreach response, TTL 60s. Cache 2 — `cached` in `lib/mcp/schema.ts:131`, single-slot, value WorkspaceSchema, no TTL (instance lifetime). Cache 3 — `mem` in `lib/state/investigations.ts:11`, key insightId, value AgentEvent[], no TTL (instance lifetime; investigation replay).)

**Level 2 — Explain.** Why is the spacing gate "rate-limit compliance" and not "backpressure"? (Answer: backpressure needs a queue with depth and an upward signal to the producer when the queue fills. The spacing gate has neither — it's single-flight (no queue) and fires every call deterministically (no upward signal). Its purpose is obeying Bloomreach's 1 req/s contract (compliance), not bounding queue growth (backpressure). Same code shape, different semantic. The day fan-out arrives, backpressure becomes a different problem the spacing gate doesn't solve.)

**Level 3 — Apply.** A new feature wants to run the 10 monitoring categories in *parallel* sub-agents instead of one sequential agent loop. What perf patterns suddenly matter that don't matter today? (Answer: backpressure (the 10 parallel agents all hit the spacing gate at the same time; in-process await chain grows; no signal goes back to the supervisor that the queue is full); the rate-limit math changes (10 concurrent calls × ~1.1s spacing = 11s wait time for the last call, plus retry storms if any spill); cache hit rate changes (less re-derivation per agent because each agent is narrower → cache hits drop). The fix is a semaphore (limit concurrent calls to 1-2 to respect the rate limit) + the upward signal (cap queue depth and refuse to spawn beyond it). Cross-ref `study-agent-architecture/05/02`.)

**Level 4 — Defend.** A reviewer says "60 seconds is too long for the cache TTL — a workspace event could land in 60 seconds and the cache would serve stale." Defend or change. (Answer: the staleness bound is set by the cache's purpose. The cache exists to catch *intra-investigation re-derives* — Claude exploring a hypothesis often re-runs the same EQL within seconds. 60s is long enough to catch that. For *cross-investigation* freshness, each new investigation kicks off without the prior one's cache state surviving cold start, and within a warm window, 60s is still short enough that any meaningful workspace change (events landing minute-to-minute) shows up on the next briefing. Lowering to 10s would catch more freshness at the cost of more network calls; raising to 600s would amortize more calls at the cost of staler data. 60s is a reasonable middle. If the user reports "I saw stale data," the lever is lowering the TTL or adding a `skipCache` button on the UI.)

---

## See also

- `01-performance-budget.md` — the spacing gate is Budget 4 (rate-limit floor)
- `03-latency-throughput-and-tail-behavior.md` — what the cache hit saves (1.5-3s per call)
- `05-io-network-and-database-bottlenecks.md` — the I/O the cache removes
- `08-performance-red-flags-audit.md` — the missing prompt-prefix cache as a finding
- `.aipe/study-agent-architecture/05-production-serving/01-cross-turn-caching.md` — the three cache scopes (two built, one skipped)
- `.aipe/study-agent-architecture/05-production-serving/02-fan-out-backpressure.md` — the topology that would force backpressure
- `.aipe/study-ai-engineering/06-production-serving/01-llm-caching.md` — the prompt-prefix cache mechanics
