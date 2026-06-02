# Caching and invalidation

**Industry name(s):** cache audit · freshness contract · stale-while-revalidate (not used here)
**Type:** Industry standard · Language-agnostic

> blooming insights has **three caches and one replay store**, and **none of them have explicit invalidation**. The McpClient cache has a 60-second TTL (time-based invalidation, the only kind of automatic invalidation in the system). The module-level schema cache has *no* TTL and dies only on instance recycle. The investigations replay store lives for the instance lifetime, with the committed `demo-*.json` snapshots as a stable backstop. The load-bearing cache is the McpClient's — it's why a 6-tool-call investigation isn't actually 6 distinct Bloomreach round-trips (most are deduped within the 60s window). The most surprising choice is *what's not cached*: query results (`?q=`) are always live, and `tool.callTool` errors are never cached (so a transient 429 doesn't poison the next 60 seconds). The strategy is "cache aggressively, invalidate by process death, accept the staleness for fresh runs." It works *because* the underlying data (today's anomalies) tolerates 60 seconds of staleness fine.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Caching is always a freshness-vs-cost tradeoff. The cost saved is real (one cached `execute_analytics_eql` call is ~1.1s + Anthropic latency saved); the freshness given up is "how stale can this be before the user notices." For most state in this app, the answer is "60 seconds is fine" — and that single number shapes the whole caching layer. The interesting audit lens is: *what's cached, with what TTL, with what invalidation, and what's NOT cached and why?*

```
  Zoom out — where caching lives                  ← we are here (mostly the Provider band)

  ┌─ UI ──────────────────────────────────────────┐
  │  sessionStorage stash (per-step replay-from-stash)│  ← cache-shaped
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Route handler ────▼───────────────────────────┐
  │  getCachedInvestigation()  ← in-process replay   │  ← cache-shaped
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Agent loop ───────▼───────────────────────────┐
  │  (no caching at this layer)                      │
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Provider ─────────▼───────────────────────────┐
  │  McpClient TTL cache (60s)  ★ LOAD-BEARING ★     │
  │  schema cache (module-level, no TTL)             │
  └────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *for every cache (or cache-shaped store) in this app, what triggers a write, what triggers a hit, what triggers an eviction or invalidation, and what's the user-visible freshness contract?* This file inventories all four, names their invalidation strategy (which is mostly "the process dies"), and grades whether the freshness contract matches the data's actual change rate.

---

## Structure pass

**Layers.** Provider band owns the load-bearing cache; route band owns the replay store; UI owns a stash. Three bands, three different cache shapes, all named here.

**Axis: invalidation.** Hold one question constant across the bands: *what causes a cached value to stop being trusted, and how soon after the underlying source changes?* Invalidation is the right axis because caches are uninteresting when they hit; they're interesting when they go stale. The whole audit is "how long can each piece be stale, and does the code's behavior match that constraint?"

**Seams.** Two of interest.

- **C1: TTL boundary in McpClient.** Inside the 60-second window, hits return instantly with `fromCache: true`. After 60 seconds, the next call goes live, refreshes the cache. The TTL is the invalidation. This is the only automatic invalidation anywhere in the system.
- **C2: process boundary for everything else.** The schema cache, the investigations replay store, McpClient's `lastCallAt` — all die on instance recycle. No explicit invalidation; the invalidation strategy is "the process dies and the next process starts fresh."

```
  Structure pass — invalidation strategy by band

  ┌─ 1. LAYERS ────────────────────────────────────────────┐
  │  UI · Route · Agent · Provider                            │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 2. AXIS ────────────────▼────────────────────────────┐
  │  invalidation: what causes a hit to stop being trusted? │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 3. SEAMS ───────────────▼────────────────────────────┐
  │  C1: TTL boundary in McpClient   (60s)  — only automatic│
  │  C2: process boundary, everything else  — instance death │
  └────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You've shipped `Cache-Control` headers and you know SWR / React Query. Same mental shape, simpler implementation. Every cache here is `Map<key, { value, expiresAt }>` (TTL) or `Map<key, value>` (no expiry, never invalidated). The cache lookup is "is this key present and (if TTL) not expired?" — if yes, return the value; otherwise, do the work and put the result in.

```
  The pattern — TTL cache lookup

  callTool(name, args, opts)
       │
       ▼
  key = name + ":" + JSON.stringify(args)
       │
       ▼
  cached = cache.get(key)
       │
       ▼
  if cached && cached.expiresAt > now:
      return { result: cached.value, durationMs: 0, fromCache: true }
       │
       ▼
  result = liveCall(name, args)
       │
       ▼
  if result is not an error:
      cache.set(key, { value: result, expiresAt: now + ttl })
       │
       ▼
  return { result, durationMs, fromCache: false }
```

The shape is universal; the four caches in this app differ in what they store, what key they use, and what their invalidation rule is.

### Move 2 — the four caches, each in turn

#### Cache 1 — McpClient TTL cache (the load-bearing one)

```
  lib/mcp/client.ts
  ─────────────────
  store:        Map<string, { result: unknown; expiresAt: number }>
  key:          `${name}:${JSON.stringify(args)}`
  default TTL:  60 seconds (overridable per-call via cacheTtlMs)
  write:        after every successful live call (NEVER on isError results)
  invalidation: TIME — entries past expiresAt return cache miss
  lifetime:     instance lifetime + per-request-McpClient lifetime
                (a new McpClient is built per request, but the cache lives
                inside that instance for the request's duration)
  bypass:       opts.skipCache = true → ignore cache on read, still write
```

The 60s default is set to absorb *within-investigation repeats*: an agent often runs the same `execute_analytics_eql` twice (once exploring, once confirming), and the second call should be a cache hit. The TTL is short enough that a fresh briefing 60+ seconds later goes live; long enough that a single agent run doesn't keep paying for the same query.

```
  McpClient cache — what gets hit, what stays live

  same args within 60s         → CACHE HIT  (0ms, no MCP call, no rate-limit cost)
  same args after 60s          → MISS, live call, refresh
  same args + skipCache: true  → MISS by force, live call, REFRESH cache anyway
  isError: true result         → never cached (no poisoning future calls)
  transport throw              → never cached (error bubbles up)
```

The `skipCache: true` path is interesting because it still *writes* the cache. The comment in the file calls this out: "a skipCache call still refreshes the cache (write-through), which is the desired behavior for the /debug 'force fresh' path." That's the right call — if you're forcing a fresh fetch, the freshest value should benefit subsequent normal callers.

#### Cache 2 — Module-level schema cache

```
  lib/mcp/schema.ts
  ─────────────────
  store:        let cached: WorkspaceSchema | null = null   (a single slot, not a Map)
  key:          (none — singleton)
  TTL:          NONE
  write:        first bootstrapSchema call on this instance
  invalidation: process restart / instance recycle (or _resetSchemaCache in tests)
  lifetime:     instance lifetime
```

This is the cache with the *longest* effective lifetime and the *weakest* invalidation. It's correct for now because workspace schemas change on the order of weeks (new event types, new catalogs), and Vercel instances recycle on the order of hours to days, so the staleness window is bounded by the recycle frequency. But it's the cache that would surprise you if a customer added a new event type and the same warm instance kept serving — the coverage grid would not pick up the new category until recycle.

```
  Schema cache — singleton, no TTL

  let cached: WorkspaceSchema | null = null
       │
       ▼
  first call:   cached is null  → 4 sequential MCP calls (~5s) → cache the result
  every other:  cached is set   → return it (0ms)
       │
       ▼
  invalidated when:   instance recycles  (or _resetSchemaCache in tests)
                      NOT invalidated by:  upstream schema change, time, deploys
```

#### Cache 3 — Investigations replay store

```
  lib/state/investigations.ts
  ───────────────────────────
  store:        const mem = new Map<string, AgentEvent[]>()
  key:          insightId
  TTL:          NONE
  write:        saveInvestigation(insightId, events)
                (called from /api/agent only on the combined run, NOT per-step)
  read:         getCachedInvestigation(insightId) — waterfall:
                  1. in-process Map
                  2. dev file (.investigation-cache.json) — dev only
                  3. committed demo-investigations.json
  invalidation: process restart (no explicit invalidation)
  lifetime:     instance lifetime + dev file persistence + git for demo
```

This is a *replay store* more than a cache — the route reads from it before doing any work, replays the events at a paced rhythm, and never hits the agent loop. There's no concept of "is this stale" because the data being replayed is the agent's *reasoning trace*, not a freshness-sensitive Bloomreach value. An investigation captured yesterday is still a perfectly valid demo of "what the agent did." The waterfall is the architecture — in-memory if you're on the same warm instance; demo-investigations.json as the stable backstop.

#### Cache 4 — sessionStorage stash (per-step replay-from-stash)

```
  lib/hooks/useInvestigation.ts  (lines 50–63, 132–140)
  ──────────────────────────────
  store:        sessionStorage (browser)
  key:          `bi:inv:${step}:${id}`   ('diagnose' | 'recommend')
  TTL:          NONE (lives for the tab's lifetime)
  write:        on 'done' event from the agent stream
  read:         on hook mount — short-circuits the fetch entirely if present
  invalidation: tab close (sessionStorage semantics)
  lifetime:     per tab
```

This is the user-facing version of the same pattern: if the user navigates away from the investigate page and comes back (or refreshes), the hook reads the stash, hydrates the state, and never re-fetches. It's *strictly cheaper* than the replay shortcut because it doesn't even open the network connection.

### Move 2.5 — what's NOT cached, and why

Three things are pointedly NOT cached. Each is a load-bearing absence.

```
  NOT cached: query results (?q=)
    why:      every query is a live exploration; the user's question may be
              novel (no insight id key); caching free-form text would lock
              in stale Bloomreach data without a clear invalidation policy.
    file:     app/api/agent/route.ts — no cache check on the q-only branch
              (the cache check at L127 only runs when insightId is present)

  NOT cached: tool errors (isError: true results)
    why:      a rate-limit failure or a transient error should NOT poison
              the next 60s of identical calls — the next caller should retry.
    file:     lib/mcp/client.ts L137–L139: "Don't cache error results"

  NOT cached: schema for a different project
    why:      the schema cache is a SINGLETON. If you switched projects mid-
              instance (via BLOOMREACH_PROJECT_ID env change), the cache would
              still return the old project's schema. Not a real concern today
              (the env doesn't change at runtime), but a constraint to know.
    file:     lib/mcp/schema.ts L131 — single slot, not keyed by projectId
```

### Move 3 — the principle

**Invalidation is the hard problem; this codebase punts it by leaning on process death.** Phil Karlton's "two hard things in computer science" applies — and the chosen answer is "let the process recycle handle invalidation." That works *because* the data tolerates it: Bloomreach data changes slowly relative to instance lifetime; agent traces are valid forever (they're history, not state); browser stashes die with the tab and that's fine. The 60-second TTL in McpClient is the *only* time-based invalidation in the system, and it exists for a tightly-scoped reason (within-investigation deduping). The lesson generalizes: caching is cheap when your invalidation strategy can be "the cache dies when the process dies." It gets expensive the moment you need cross-process consistency — which is the day you need a database + cache invalidation messaging, and the day this architecture's punt stops working.

---

## Primary diagram

The full caching topology with every store, every TTL, every invalidation trigger.

```
  Caching topology — four stores, three invalidation strategies

  ┌─ Browser ─────────────────────────────────────────────────────────────────┐
  │                                                                            │
  │  sessionStorage stash                                                      │
  │    key: bi:inv:{step}:{id}                                                  │
  │    write: on 'done' event                                                   │
  │    read: hook mount → short-circuits fetch entirely                         │
  │    INVALIDATION: tab close                                                  │
  └────────────────────────────────────────────────────────────────────────────┘
                            │ if no stash → fetch /api/agent
                            ▼
  ┌─ Route ───────────────────────────────────────────────────────────────────┐
  │                                                                            │
  │  getCachedInvestigation(insightId)  (lib/state/investigations.ts)          │
  │    waterfall: in-mem Map → dev file → demo JSON                            │
  │    write: saveInvestigation (combined run only)                            │
  │    INVALIDATION: process restart (dev file: manual; demo: git commit)      │
  │                                                                            │
  │  ★ NOT CACHED ★  query results (?q=); always live                          │
  └────────────────────────────────────────────────────────────────────────────┘
                            │ live path
                            ▼
  ┌─ Agent loop ─ no cache at this layer ─────────────────────────────────────┐
  └────────────────────────────────────────────────────────────────────────────┘
                            │ every tool call
                            ▼
  ┌─ McpClient ───────────────────────────────────────────────────────────────┐
  │                                                                            │
  │  cache: Map<"{name}:{argsJson}", {result, expiresAt}>                      │
  │  default TTL: 60s (overridable per-call)                                   │
  │  write: every successful live call                                         │
  │  INVALIDATION: TIME (expiresAt) — only automatic invalidation in system   │
  │  ★ NOT CACHED ★  isError: true results                                    │
  │                                                                            │
  │  schema cache (lib/mcp/schema.ts): singleton, no TTL                       │
  │    INVALIDATION: instance recycle                                          │
  └────────────────────────────────────────────────────────────────────────────┘
                            │ on miss
                            ▼
  ┌─ Bloomreach ─ source of truth, owns its own freshness ────────────────────┐
  └────────────────────────────────────────────────────────────────────────────┘

  Invalidation strategies summary:
    TIME           McpClient cache (60s)
    PROCESS DEATH  schema cache, McpClient cache (incidentally), investigations Map
    TAB CLOSE      sessionStorage stash
    GIT COMMIT     demo-*.json
    NEVER          (no NEVER-cache except the absence of caching on query results)
```

---

## Implementation in codebase

### Use cases

**Use case 1 — same investigation, second tool call repeats.** Diagnostic agent runs an EQL query, gets back data, decides to confirm with a follow-up query. The follow-up query happens to have *the same args* as the first (e.g. re-checking the same metric). The McpClient cache hit returns instantly — 0ms vs 1.1s spacing + Bloomreach latency. The 60s TTL absorbs this without affecting freshness from the user's perspective (the data didn't change in those few seconds).

**Use case 2 — fresh briefing on a warm instance.** Page mounts → `/api/briefing` → `bootstrapSchema` is a cache hit (schema cache); ~5s saved. `MonitoringAgent.scan` runs 6 distinct EQL calls — all miss the cache (different args per category) — each one is ~1.1s + Anthropic. Roughly 15–25s end-to-end vs 30–60s on a cold start.

**Use case 3 — user clicks "investigate this insight" on a cached one.** Hook mounts → reads `bi:inv:diagnose:{id}` from sessionStorage → hits the stash → never calls `fetch`. UI hydrates from cached items immediately (single render). If the stash is empty (different tab), the hook calls `fetch('/api/agent?insightId=…&step=diagnose')` → route hits `getCachedInvestigation` → replays at 180ms/event. Either way, no live agent run, no MCP cost.

### Cache file index

| Cache | File · Owner | Lines | TTL · Invalidation |
|---|---|---|---|
| McpClient TTL cache | `lib/mcp/client.ts` · `cache` | L80, L100–L146 | 60s · time |
| McpClient spacing | `lib/mcp/client.ts` · `lastCallAt` | L81, L148–L163 | per-request lifetime |
| Schema cache | `lib/mcp/schema.ts` · `cached` | L131, L170–L196 | none · process restart |
| Investigations replay | `lib/state/investigations.ts` · `mem` + dev file + demo JSON | L11, L22–L41 | none · process restart |
| sessionStorage stash | `lib/hooks/useInvestigation.ts` | L18, L50–L63, L132–L140 | none · tab close |
| sessionStorage insight handoff | `app/page.tsx` · `stashInsights` | L70–L75 | none · tab close |
| insights Map | `lib/state/insights.ts` · `insights` | L4, L30–L42 | none · explicit clear per briefing |

### Sample — the McpClient cache lookup + write

```
  lib/mcp/client.ts  (lines 100–146)  ← annotated

  async callTool<T = unknown>(name, args, options = {}): Promise<CallToolResult<T>> {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
    const ttl = options.cacheTtlMs ?? 60_000;             ← default 60s, override per-call

    if (!options.skipCache) {                              ← skipCache bypasses read…
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result as T, durationMs: 0, fromCache: true };
      }
    }

    const start = Date.now();
    let result = await this.liveCall(name, args);          ← may throw McpToolError

    // retry loop omitted — see file 06 for the rate-limit retry walkthrough …

    const durationMs = Date.now() - start;

    // Don't cache error results — they should not poison the cache.
    if ((result as any)?.isError === true) {               ← C2 — "no cache on error"
      return { result: result as T, durationMs, fromCache: false };
    }

    // Note: a skipCache call still refreshes the cache (write-through), which is
    // the desired behavior for the /debug "force fresh" path.
    const now = Date.now();
    this.cache.set(cacheKey, { result, expiresAt: now + ttl });   ← C1 — TTL write
    return { result: result as T, durationMs, fromCache: false };
  }
       │
       └─ this 30-line method IS the load-bearing caching layer. The TTL
          (line 103), the skipCache bypass (line 105), the no-cache-on-error
          (line 137–139), and the write-through-on-skipCache (line 144) are
          each named load-bearing decisions. The legacy guide
          .aipe/study-system-design-dsa/02-dsa/01-ttl-cache.md walks the
          mechanism at DSA depth — this audit just names the policy choices.
```

### Sample — the investigations replay waterfall

```
  lib/state/investigations.ts  (lines 22–28)  ← annotated

  export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
    if (mem.has(insightId)) return mem.get(insightId)!;                 ← tier 1: in-process
    const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;  ← tier 2: dev file
    if (fromFile) return fromFile;
    const fromDemo = readJson(DEMO_FILE)[insightId];                    ← tier 3: committed JSON
    return fromDemo ?? null;
  }
       │
       └─ the three-tier waterfall IS the cache strategy. In-memory hits are
          fast and warm. Dev file is for "I ran a live investigation once,
          let me see it again without re-running the agent" during development.
          Committed demo JSON is the stable backstop that makes ?demo=cached
          work for any visitor without credentials. There is no invalidation
          at any tier — each one is "is the value present? return it."
```

---

## Elaborate

### Why 60s and not 5 minutes

The 60-second TTL is calibrated to the *intra-investigation* repeat pattern. An agent that runs 6 tool calls in an investigation might repeat 2 of them — once exploring, once confirming — and those repeats happen within the same 30–90 second agent run. A 60s TTL absorbs that. A 5-minute TTL would absorb cross-investigation repeats too (if two users investigate the same insight back-to-back), but it'd also cache a stale Bloomreach value past the point where "fresh briefing" feels fresh. The constant is at the McpClient default and is overridable per-call via `cacheTtlMs`, but no caller currently overrides it. If a future feature ran the monitoring agent *for hours* (a "watch this metric") the per-call override would matter; today, 60s default is fine.

### Why no stale-while-revalidate

SWR is the right pattern for "show the cached value immediately, then fetch the fresh one in the background and update." This codebase doesn't use it because the *streaming* pattern is doing the same job differently: the route emits `step('reading the workspace schema…')` immediately and then writes the fresh data as it arrives, all over one connection. The user gets a "we're working on it" signal in 200ms (like SWR would give a stale cached value in 0ms), then the fresh data flows in. The two patterns solve similar problems with different mechanisms; both are correct for their context. Adopting SWR here would mean serving stale insights immediately while regenerating in the background — which would require a *durable* place for the stale value to live, which means a database, which is exactly the choice this architecture punts on.

### Why no cache on `?q=`

Two reasons. **Operationally**: queries have no stable key (the `q=` string is free-form), so cache hits would be rare and the bookkeeping doesn't pay for itself. **Semantically**: a query is an *exploration* — the user is asking a question they expect a current answer to. Caching "yesterday's answer to today's question" is the wrong call. Investigations are different — they're an interpretation of a specific anomaly that has a stable `insightId`, and the cache is shaped around that key.

### What the schema cache should probably have

A TTL of 1 hour, plus a `force fresh` parameter callable from `/debug`. Today, the only way to invalidate is an instance recycle, which means the cache can be hours-to-days stale if traffic keeps the instance warm. The risk is small (schemas don't change often), but adding a TTL would make the freshness contract *explicit* instead of *incidental*. This is named in file 08 with the move.

### Cross-link to legacy mechanism teaching

- The McpClient TTL cache mechanism (and why the key-as-stringified-args choice) → `.aipe/study-system-design-dsa/02-dsa/01-ttl-cache.md` (DSA mechanism depth)
- The full McpClient choke-point story (cache + spacing + retry together) → `.aipe/study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md`
- The investigations replay shortcut as a pattern (replay-from-cache vs run-live) → `.aipe/study-system-design-dsa/01-system-design/05-streaming-ndjson.md` (sections on cache replay)

---

## Interview defense

**What they are really asking:** can you name every cache in your app, name its TTL and invalidation rule, and explain what's NOT cached and why?

---

**[mid] — What's cached in blooming insights?**

Four stores. McpClient has a TTL cache, 60-second default, keyed by `${toolName}:${JSON.stringify(args)}`. It's the load-bearing one — every MCP call goes through it. The schema cache in `lib/mcp/schema.ts` is a single module-level slot with no TTL — first request on the instance pays, every subsequent one is free. The investigations replay store is a three-tier waterfall: in-memory Map → dev file (dev only) → committed `demo-investigations.json`. And the client has a `sessionStorage` stash keyed by `bi:inv:{step}:{id}` that short-circuits the fetch entirely for re-visits within the same tab. Three things are pointedly NOT cached: free-form queries (no stable key, semantically a current question), tool errors (no poisoning the next 60 seconds), and schemas keyed by project id (the cache is a singleton).

```
  4 caches · 3 invalidation strategies

  McpClient cache     TTL 60s         TIME
  schema cache        no TTL          PROCESS DEATH
  investigations Map  no TTL          PROCESS DEATH
  sessionStorage      no TTL          TAB CLOSE
```

---

**[senior] — Why are tool errors never cached?**

Because a transient rate-limit failure should not poison the next 60 seconds of identical calls. If Bloomreach returns a 429 because we hit the global per-user limit, the right behavior is "retry after the stated penalty window" — and the next caller (which might be a different agent in the same investigation) should also get the chance to retry, not hit a cached error from a peer. The implementation is a 3-line check in `McpClient.callTool` (lib/mcp/client.ts L137–L139): if the result is `isError: true`, return it without writing to the cache. The retry logic above it has already tried 3 times with parsed retry-after waits, so by the time we land on "still erroring," the right answer is "fail loud and don't lock in the failure."

---

**[arch] — The schema cache has no TTL. Defend or fix.**

Defensible today, brittle tomorrow. It's defensible because workspace schemas change on the order of weeks (new event types added by the customer), Vercel instances recycle on the order of hours-to-days under normal traffic, and the cost of a fresh bootstrap is bounded (4 sequential MCP calls, ~5 seconds). The staleness window is incidentally bounded by recycle frequency. It becomes brittle when an instance stays warm under sustained traffic for a customer who *just added* a new event type — the coverage grid won't surface that category until recycle, and there's no mechanism to force a refresh short of redeploying. The fix is a 5-line change: a TTL (1 hour seems right), plus a `force=true` query param on `/api/briefing` for an explicit refresh. I'd add it the day a customer asks "why doesn't my new event type show up."

---

**The dodge — "have you measured cache hit rate?"**

No, not directly. I have anecdotal evidence — running an investigation and watching the trace, I see roughly 1 of 6 tool calls being a cache hit on a second-look pattern. I have no metric for "what fraction of MCP calls are served from cache across all runs," because there's no instrumentation. The McpClient's return type does have a `fromCache: true | false` field exactly so this *could* be instrumented later — wrap the call site, log the flag, aggregate. That's the right next move for production. Today, the cache hit rate is invisible.

---

**One-line anchors:**
- 4 caches, 3 invalidation strategies (TIME, PROCESS DEATH, TAB CLOSE); the only automatic invalidation is the McpClient TTL.
- The "no cache on error" rule (3 lines) is what prevents transient failures from poisoning the next 60 seconds.
- The schema cache having no TTL is the brittlest current choice — the day a customer adds a new event type and complains, the fix is a 5-line TTL + force-fresh param.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, list the 4 caches by TTL/invalidation strategy. For each, name the file and the key shape. Check against the cache file index.

### Level 2 — Explain
Why does `McpClient.callTool` re-write the cache even when `skipCache: true`? Reference `lib/mcp/client.ts` L142–L145 and explain the `/debug` use case.

### Level 3 — Apply
A teammate proposes a "background refresh" mode: every 5 minutes, refresh the insights map. Walk through which caches it would interact with, whether it would invalidate them, and whether the current architecture supports it. Reference `lib/state/insights.ts` and `lib/mcp/schema.ts`.

### Level 4 — Defend
Defend the choice to make the McpClient cache TTL 60 seconds rather than 5 minutes or 5 seconds. What pattern of calls does 60 seconds optimize for, and what would each alternative cost?

### Quick check
- Which is the only automatic invalidation? → McpClient TTL (60s default)
- Which cache survives instance recycle? → none in-process (sessionStorage and the demo JSON survive; everything else doesn't)
- What's NOT cached? → free-form queries (`?q=`), tool errors (`isError: true`), schemas keyed by project (singleton)
- Which file owns the TTL cache implementation? → `lib/mcp/client.ts` L100–L146

---

## See also

→ [03-state-ownership-and-source-of-truth.md](./03-state-ownership-and-source-of-truth.md) · [05-storage-choice-and-durability-boundaries.md](./05-storage-choice-and-durability-boundaries.md) · [06-failure-handling-and-reliability.md](./06-failure-handling-and-reliability.md) · `.aipe/study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md` (McpClient full walkthrough) · `.aipe/study-system-design-dsa/02-dsa/01-ttl-cache.md` (TTL cache mechanism)
