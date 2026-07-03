# 04 · Query planning and execution

*Plans, scans, joins, N+1 · Case B (the agent loop is the planner)*

## Zoom out — where this concept lives

In a real DB, a query planner reads your SQL, picks an execution
strategy, and hands the strategy to an executor that walks tables and
indexes. Here you have **no SQL**, but you have something that plays
exactly the same role: **the agent loop**. It reads a hypothesis,
picks the next tool call, and hands the call to an executor
(`DataSource.callTool`) that hits an index (the 60 s cache) or does a
scan (the live MCP round-trip). Same shape, LLM in the planner seat.

```
Zoom out — the query-planning question mapped onto this app

┌─ user intent ────────────────────────────────────────┐
│  "why did mobile checkout conversion drop?"          │
│  ↑ this is your "SQL query"                          │
└──────────────────────────┬───────────────────────────┘
                           │
┌─ ★ THIS CONCEPT ★ ──────▼───────────────────────────┐
│  the planner                                          │
│    · picks the next tool to call                     │
│    · decides args                                    │
│    · reads results, plans the next step              │
│                                                       │
│  the executor                                         │
│    · DataSource.callTool → transport                 │
│    · hits cache OR does a scan                       │
│    · returns typed result                            │
└──────────────────────────┬───────────────────────────┘
                           │
┌─ storage ────────────────▼───────────────────────────┐
│  MCP tools (bloomreach) · SyntheticDataSource        │
│  · 60s response cache (buffer pool)                  │
└──────────────────────────────────────────────────────┘
```

## Zoom in — the pattern

**The pattern:** *plan-then-execute with a cache-checked read path.*
The planner is the LLM inside the agent loop; the executor is the
`DataSource` port. Every tool call is a "query" against a data source;
every cache hit is an index probe; every miss is a scan.

## Structure pass — one axis across the plan/execute layers

**Axis: "who decides what happens next?"** (control flow)

```
Trace control-flow decisions down the layers

  Layer                       Who decides?      Decision cost
  ─────                       ────────────      ─────────────
  intent (SQL analog)         the user          human latency
  ────────────────────────    ─────────────     ─────────────
  planner (agent loop)        the LLM           ~1-3s per turn
  ────────────────────────    ─────────────     ─────────────
  executor (DataSource)       CODE (fixed)      microseconds
  ────────────────────────    ─────────────     ─────────────
  cache probe                 CODE (fixed)      ~0ms
  ────────────────────────    ─────────────     ─────────────
  transport (MCP)             the SERVER        network + rate limit
  ────────────────────────    ─────────────     ─────────────
  results                     THE DATA          fixed by content
```

The important seams:

  → **Intent → Planner** — the intent is opaque; the planner has to
    infer scope, metrics, time windows. This is where a cost-based
    optimizer would live in a real DB. Here it's the LLM's judgment.

  → **Planner → Executor** — this is a hard seam. The LLM outputs a
    tool call; the executor validates args, hits the cache, and does
    the call. The planner does **not** see the cache; it re-decides
    every turn. That's a critical property.

  → **Executor → Transport** — cache vs live is decided here. In DB
    terms this is "buffer pool hit vs disk read."

The **most load-bearing seam** is the Planner → Executor one. The
planner emits a decision *per turn* and can't remember what it just
looked at — the executor's cache is what makes duplicate planning
decisions cheap. If the cache were removed, an LLM that "re-asks" the
same tool would pay full latency every time.

## How it works

### Move 1 — the pattern

You've written a `.filter(...).map(...).find(...)` chain — you know
what a query pipeline looks like. In a DB, the planner turns SQL into
a similar chain (scan → filter → project → aggregate). In this repo
the planner is the LLM and the chain is a sequence of MCP tool calls,
each one narrowing the answer.

```
Query planning + execution — pattern skeleton

  turn 1: LLM plans "list_projects"
      │
      ▼
  executor: callTool('list_projects', {}) ── cache? ── LIVE ── result_1
      │
      ▼
  turn 2: LLM reads result_1, plans "get_metric"
      │
      ▼
  executor: callTool('get_metric', {scope}) ── cache? ── HIT ── result_2
      │
      ▼
  turn 3: LLM has enough → emits `insight`
      │
      ▼
  done
```

The kernel is four parts:

  1. **Plan step** — the LLM produces a next-tool decision from the
     conversation so far.

  2. **Execute step** — the executor validates + probes cache + calls.

  3. **Feed step** — the result goes back to the LLM as context.

  4. **Terminate step** — some emit event (`insight`, `diagnosis`,
     `recommendation`) signals done. **What breaks without this: the
     loop runs forever.** Every agent loop needs a hard iteration
     budget on top; naming that budget is the strongest signal you
     built the thing.

### Move 2 — walk the mechanics

Three moving parts to walk: the executor's cache path, the "scan"
(MCP live call), and the N+1 shape that emerges naturally.

#### Part 1 — the executor's cache path (index probe)

Every tool call runs through `BloomreachDataSource.callTool`. Trace
the decision inside:

```typescript
// lib/data-source/bloomreach-data-source.ts:144-188
async callTool<T = unknown>(name, args, options = {}) {
  const cacheKey = `${name}:${JSON.stringify(args)}`;   // 1) build the key
  const ttl = options.cacheTtlMs ?? 60_000;

  if (!options.skipCache) {
    const cached = this.cache.get(cacheKey);            // 2) probe
    if (cached && cached.expiresAt > Date.now()) {
      return { result: cached.result as T, durationMs: 0, fromCache: true };  // 3) hit
    }
  }

  const start = Date.now();
  let result = await this.liveCall(name, args, options.signal);   // 4) scan

  // rate-limit retry ladder here — see 06-locks-mvcc-and-…
  // ...

  const durationMs = Date.now() - start;
  if ((result as any)?.isError === true) {
    return { result: result as T, durationMs, fromCache: false };  // don't poison
  }

  const now = Date.now();
  this.cache.set(cacheKey, { result, expiresAt: now + ttl });     // 5) write-through
  return { result: result as T, durationMs, fromCache: false };
}
```

Read this like a DB executor:

  → step 1: **compose the lookup key** (identical to how a query hash
    is computed for the plan cache in Postgres)
  → step 2: **probe the cache** (buffer pool lookup)
  → step 3: **hit** — return the cached value with `fromCache: true`
    and `durationMs: 0` (the durability of the answer is TTL, exactly
    like Postgres's shared-buffers eviction)
  → step 4: **scan** — go all the way through the transport to the
    live source (heap scan, in DB terms)
  → step 5: **write-through** — put the result in the cache for the
    next reader (same as Postgres promoting a heap page to shared
    buffers after read)

**Boundary condition — write-through even on skipCache:** the code
comment names it: "a skipCache call still refreshes the cache
(write-through), which is the desired behavior for the /debug 'force
fresh' path." So the debug page forces a live call AND updates the
cache for everyone else's benefit. That's the "force refresh + warm
the pool" pattern.

#### Part 2 — the scan (`liveCall` + rate limiting)

When the cache misses, the executor does the equivalent of a heap
scan — go to the actual data source.

```typescript
// lib/data-source/bloomreach-data-source.ts:190-205
private async liveCall(name, args, signal?) {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));  // 1) throttle
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });   // 2) hop
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

```
Layers-and-hops — one live tool call

┌─ BloomreachDataSource.liveCall ─────────────────────┐
│  elapsed = now - lastCallAt                          │
│  if elapsed < 200ms: sleep(remaining)                │
│  lastCallAt = now                                    │
└──────────────────┬──────────────────────────────────┘
                   │ hop 1: transport.callTool()
                   ▼
┌─ MCP transport (StreamableHTTP over HTTPS) ─────────┐
│  headers: Bearer / OAuth token from bi_auth cookie  │
└──────────────────┬──────────────────────────────────┘
                   │ hop 2: HTTPS POST
                   ▼
┌─ Bloomreach loomi server (external) ────────────────┐
│  MCP tool executes on their side                    │
│  possible: 429 rate-limit response                  │
└──────────────────┬──────────────────────────────────┘
                   │ hop 3: response
                   ▼
┌─ result → back to callTool → cache write ───────────┐
└─────────────────────────────────────────────────────┘
```

The 1 req/s spacing is proactive; the retry ladder on top of it is
reactive. When the server DOES return a 429 with "Retry after ~10
second(s)", the executor parses the hint and waits **before** the
next scan. That's classic **backoff-on-scan**, and it's why the 60 s
route budget (`app/api/agent`) is under constant pressure.

**Boundary condition — the 30s per-call timeout:** the `signal`
threaded through `callTool` is composed of the route-level cancel
signal AND a per-call 30 s timeout (details in
`03-btree-hash-and-secondary-indexes.md`'s discussion of cache
guards). Without it, a single stuck tool call blocks the whole
route until the 60 s route budget kills everything.

#### Part 3 — the N+1 shape (agent-produced)

Here's where things get interesting. In a real DB, an ORM produces
N+1 by looping and fetching one child per row. Here the LLM
produces N+1 by looping and calling one tool per scope.

Imagine the diagnostic agent investigating "why did conversion drop":

```
Execution trace — a diagnostic loop, tool calls in order

  Step  Tool call                             Cost      What it's doing
  ────  ─────────────────────────             ────      ───────────────
  1     list_cloud_organizations              live      bootstrap chain
  2     list_projects                         cache?    bootstrap chain
  3     get_metric(scope=[mobile])            live      the "main" query
  4     get_metric(scope=[mobile, iOS])       live      ── N+1 begins
  5     get_metric(scope=[mobile, Android])   live      │
  6     get_metric(scope=[mobile, Safari])    live      │
  7     get_metric(scope=[mobile, Chrome])    live      ── one call per scope
  8     ...                                             │
  N+1   emit(diagnosis)                                 done
```

Turn 3 is the "main" query; turns 4..N are the "children" (one per
scope refinement). In a real DB this is exactly what an ORM does
when you do `for (const parent of parents) { fetchChildren(parent) }`.
Here it's the LLM asking to narrow.

**What saves this:** the 60 s response cache turns the *second*
occurrence of any given (name, args) into ~0 ms. So if the LLM
re-asks `get_metric(scope=[mobile])` on a later turn, it's free. The
N+1 is only expensive on the first pass through the fan-out.

**What DOESN'T save this:** the fan-out itself. If the LLM decides
to walk 20 scopes on turn 4-24, that's 20 live calls at ~1 req/s
plus any rate-limit retries. At ~200 ms proactive spacing plus
occasional 10 s backoff windows, 20 calls comfortably eat the 60 s
route budget.

The instrumentation exists to see this. Every tool call emits
`tool_call_start` and `tool_call_end` events (see
`lib/mcp/events.ts` and `useInvestigation.ts:114-123`), and the
investigation UI shows the trace in real time. Watching a live
investigation IS watching a query plan execute.

### Move 2.5 — the "buffer pool" analogy in this repo

The 60 s cache is the buffer pool. Not metaphorically — the
mechanics are the same. Trace:

```
Comparison — Postgres shared_buffers vs BloomreachDataSource.cache

  Postgres shared_buffers          BloomreachDataSource.cache
  ─────────────────────           ──────────────────────────
  index-by-page                    index-by-cacheKey
  LRU eviction                     TTL eviction
  contains recently-read heap     contains recently-called tool
  pages                            results
  page misses → disk read          key misses → transport call
  page hits → memory                key hits → in-process return
  writes: WAL-first, buffer next   writes: skip errors, write-through
```

The differences are all in the eviction policy and the fault
domain — Postgres evicts by LRU when the pool fills; this cache
evicts by TTL (whether it's full or not); Postgres invalidates on
transaction commits; this cache never invalidates, it just expires.

### Move 3 — the principle

**Every read is a "how much work" decision.** The cache-first path
turns a 500 ms – 2 s tool call into ~0 ms; the live-scan path is what
happens when the cache doesn't have you covered. Query planning is the
discipline of arranging your reads so the cheap paths cover the common
cases and the expensive paths only run when they must.

In a DB this is what indexes and query hints buy you. Here the same
job is done by (1) the 60 s cache, (2) the LLM's judgment on
which tool to call next, and (3) the fact that the schema bootstrap
is done ONCE per session then reused. When any of those three
breaks — cache miss storm, dumb LLM decisions, per-turn schema re-fetch
— you feel it as latency.

## Primary diagram — the whole plan/execute pipeline

```
Query planning + execution — one frame, all layers

  ┌── INTENT ─────────────────────────────────────────────────────┐
  │                                                                │
  │   user question →  briefing / investigation prompt             │
  │                                                                │
  └────────────────────────────┬───────────────────────────────────┘
                               │
  ┌── PLANNER (agent loop, LLM) ▼─────────────────────────────────┐
  │                                                                │
  │   turn N: read history → pick next tool → emit call            │
  │                                                                │
  └────────────────────────────┬───────────────────────────────────┘
                               │
  ┌── EXECUTOR (DataSource.callTool) ▼────────────────────────────┐
  │                                                                │
  │   compose cacheKey = `${name}:${JSON.stringify(args)}`         │
  │                                                                │
  │   ┌─── probe cache ───┐                                        │
  │   │ hit → return {…, │                                        │
  │   │  fromCache: true} │  ← this is the "buffer pool"           │
  │   └─── miss ──────────┘                                        │
  │                       │                                         │
  │                       ▼                                         │
  │   throttle (1 req/s), transport.callTool                       │
  │   handle rate-limit → parse Retry-After → sleep → retry        │
  │   skip caching errors; write-through on success                │
  │                                                                │
  └────────────────────────────┬───────────────────────────────────┘
                               │
  ┌── TRANSPORT (MCP over HTTPS) ▼────────────────────────────────┐
  │                                                                │
  │   Streamable HTTP + Bearer or OAuth via bi_auth cookie         │
  │                                                                │
  └────────────────────────────┬───────────────────────────────────┘
                               │
  ┌── DATA SOURCE ▼───────────────────────────────────────────────┐
  │                                                                │
  │   Bloomreach loomi server                                      │
  │     — OR —                                                     │
  │   SyntheticDataSource (deterministic, in-process)              │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where does the cache-checked read path come from?** From every
performance-sensitive DB and every RPC client. Postgres has
shared_buffers. Redis IS a cache-only path (no scan behind it).
gRPC clients often ship with a per-method memoizer. The instinct is
universal because the alternative — every read hits the source —
scales linearly with call volume and dies under retry storms.

**When to look at this concept:** whenever a tool call is expensive.
The 60 s TTL was picked with knowledge that Bloomreach data changes
slowly (metrics update every few minutes at most), so a stale-for-60s
answer is fine. If the app were serving payment status, that TTL
would be zero.

**The N+1 pattern in LLM agents deserves its own note.** In an ORM,
you fix N+1 with an eager-load or a join. In an agent, you fix N+1
by **improving the prompt** so the LLM asks for a batched tool
instead of a per-item one — or by giving the tool a scope-list
parameter and teaching the LLM to prefer it. That's a different
kind of query optimization: not "rewrite the plan," but "coach the
planner."

## Interview defense

**"How does a request flow through the system?"**

Answer: *"Three layers. The planner is the LLM inside the agent
loop — it emits a tool decision per turn. The executor is
`DataSource.callTool` — it composes a cache key, probes a 60-second
response cache, and either returns the memoized result or does a
live call. The transport is MCP over HTTPS to Bloomreach (or a
deterministic synthetic in-process fallback). Every call gets a
`fromCache` flag so the trace UI can show cache hits."*

**"What's the query plan for a diagnostic investigation?"**

Answer: *"There's no single plan — the LLM re-plans per turn. But
the shape is stable: bootstrap the schema (once per session, cached),
call `get_metric` for the main scope, then fan out per sub-scope
(the N+1 pattern), then emit the diagnosis. The cache turns
duplicate calls into ~0ms, so the LLM re-asking for the main scope
on turn 5 is free."*

**"What breaks under load?"**

Answer: *"Two things. First, the fan-out — if the LLM decides to
walk 20 scopes, that's 20 live calls at 1 req/s plus any rate-limit
retries, and 20 seconds comfortably eats the 60-second route
budget. Second, the cache write-through — a burst of unique tool
calls fills the cache but doesn't share results, so the buffer pool
doesn't help. The fix would be either a smarter tool with a
scope-list parameter or a shorter 30-second budget on the fan-out
sub-loop."*

The load-bearing skeleton part interviewers routinely forget:
**the hard iteration budget on the agent loop.** Without it, an
LLM can chain tool calls indefinitely. Every query executor needs
a fuse; every DB planner produces a `NestedLoopJoin` or `HashJoin`
node with a bounded size; every agent loop needs a bounded turn
count. Naming that budget signals you built the thing.

## See also

  → `03-btree-hash-and-secondary-indexes.md` — the cache IS an
    index; walking that concept first makes this one land
  → `05-transactions-isolation-and-anomalies.md` — what happens when
    two concurrent plans touch the same cache
  → `study-runtime-systems/` — the 30 s per-call timeout and 60 s
    route budget as bounded work
  → `study-networking/` — the MCP transport hop and its rate-limit
    ladder
