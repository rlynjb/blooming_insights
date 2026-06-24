# 03 — idempotency, deduplication, delivery semantics

**Industry name(s):** idempotency keys · at-most-once / at-least-once / effective-once · request deduplication
**Type:** Industry standard · Language-agnostic

> **Verdict-first:** the codebase gets idempotency *for free* because **every MCP tool it actually calls is a read** (`list_*`, `get_*`, `execute_analytics_eql` on Bloomreach). Reads are idempotent by definition — retry as many times as you like, the world doesn't change. The 60s TTL cache in `BloomreachDataSource` is the **only** deduplication mechanism, keyed by `${toolName}:${JSON.stringify(args)}`. There is **no idempotency key**, **no request ID**, and no server-side dedup because no write call is being made. The moment the app adds a write — `update_segmentation`, `create_voucher`, `trigger_campaign` — this entire chapter changes from "not a concern" to "the central concern." Recommendations are currently *proposed*, not *executed*; that boundary is the load-bearing safety. (Historical note: at the previous refresh this section described an asymmetric cache story across two adapters — `BloomreachDataSource` cached, `OlistDataSource` didn't. The Olist adapter was deleted in PR #8 on 2026-06-18, so the asymmetry is gone; the in-process `SyntheticDataSource` that replaced it returns deterministic fixture data with no cache, by construction.)

---

## Zoom out, then zoom in

```
  Zoom out — where dedup happens (and doesn't)

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  startedRef guard (useInvestigation:43-48)               │
  │  → dedup at the EFFECT layer, not the network layer      │
  └─────────────────────────┬───────────────────────────────┘
                            │
  ┌─ Service layer ─────────▼───────────────────────────────┐
  │  ★ BloomreachDataSource cache (60s TTL, name+args) ★    │ ← we are here
  │  agent loop: NO request ID, NO idempotency key           │
  │  SyntheticDataSource: in-process; no cache (deterministic │
  │  fixtures return identically per-call by construction)   │
  └─────────────────────────┬───────────────────────────────┘
                            │
  ┌─ Provider layer ────────▼───────────────────────────────┐
  │  Bloomreach MCP — every called tool is a READ            │
  │  (writes exist in Bloomreach catalog but NOT YET         │
  │   EXERCISED)                                             │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** The question: *when a tool call retries or runs twice by accident, does the system end up in the right state?* For this codebase the honest answer is: it doesn't matter — every call is a read. But that's a luxury that ends the moment the recommendation agent is allowed to *execute* a recommendation instead of *describe* one. This file walks the current mechanism and labels the absent ones honestly.

---

## Structure pass

**Layers.** Three. Client effect (StrictMode dedup), in-process cache (TTL dedup), provider (no app-level dedup because no writes).

**Axis: delivery semantics.** Hold one question: *if a request runs twice, does the user see the right answer once?* At the client layer, the `startedRef` guard ensures a single fetch even in React StrictMode (mount → cleanup → re-mount). At the in-process layer, the TTL cache makes a duplicate call within 60s return the same cached result — effectively "at-most-once observable within the cache window." At the provider layer, the question doesn't fire because every tool is a read; idempotency is inherent.

**Seams.** Two real, one absent.

- **Seam: client effect ↔ network.** `startedRef.current = true` collapses two effect runs into one fetch. Without it, StrictMode would issue two parallel `/api/agent` requests for the same investigation, doubling MCP call cost.
- **Seam: in-process call ↔ provider.** `BloomreachDataSource.cache` (`lib/data-source/bloomreach-data-source.ts:122, 144-152`) collapses repeated identical calls within 60s into one network round-trip. Cache key is `${name}:${JSON.stringify(args)}`. The in-process `SyntheticDataSource` has no cache and doesn't need one — every `callTool` returns deterministic fixture data via a synchronous `switch`, so a duplicate call costs effectively zero.
- **Seam: idempotency key ↔ provider** — *does not exist*. No request ID is sent, no `Idempotency-Key` header. Bloomreach has no way to dedup a duplicate write even if it wanted to. Currently fine; becomes load-bearing the moment writes are added.

```
  Structure pass — three layers of dedup, last one absent

  ┌─ React effect ────────────────────────────────────────┐
  │  guarantee: one fetch per id+step per mount            │
  │  mechanism: startedRef ref + early return              │
  └────────────────────┬──────────────────────────────────┘
                       │
  ┌─ McpClient ────────▼──────────────────────────────────┐
  │  guarantee: at-most-once network call within 60s TTL   │
  │  mechanism: Map<cacheKey, { result, expiresAt }>       │
  └────────────────────┬──────────────────────────────────┘
                       │
  ┌─ provider (Bloomreach MCP) ───────────────────────────┐
  │  guarantee: irrelevant — every called tool is a read   │
  │  what's NOT YET EXERCISED: any write that needs        │
  │  server-side idempotency                               │
  └────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You already know that `GET /users/42` is safe to retry — every retry returns the same Alice. `POST /transfer { amount: 100 }` is *not* — every retry moves another $100. Idempotency is the property: *executing this twice has the same effect as executing it once.* When it's inherent (reads), you don't think about it. When it's not (writes), you reach for one of three patterns.

```
  The three patterns for write idempotency

  1. NATURAL IDEMPOTENCY      ← PUT /users/42 { name: 'Alice' }
                                 same value → same result, always

  2. IDEMPOTENCY KEY          ← POST + header Idempotency-Key: <uuid>
                                 server keeps a record per key;
                                 second call with same key returns
                                 the first result

  3. CONDITIONAL WRITE        ← UPDATE … WHERE version = N
                                 second call hits version mismatch
                                 and no-ops
```

blooming insights uses pattern 0 — no writes at all. That's the load-bearing detail. The rest of this file explains the in-process dedup that exists for performance (cache) and correctness-under-React-StrictMode (startedRef).

### Move 2 — the moving parts

#### Part 1 — the TTL cache, the only network-layer dedup

`McpClient` keeps a `Map<cacheKey, { result, expiresAt }>` where `cacheKey = '${name}:${JSON.stringify(args)}'`. Default TTL is 60 seconds.

```
  TTL cache — what it dedups

  call 1:  list_funnels({ project_id: 'p1' })
           cacheKey = 'list_funnels:{"project_id":"p1"}'
           not in cache → live call → store with expiresAt = now + 60s

  call 2:  list_funnels({ project_id: 'p1' })   ← within 60s
           cacheKey = same
           in cache AND expiresAt > now → return cached
           durationMs = 0, fromCache = true       ← NO network call

  call 3:  list_funnels({ project_id: 'p1' })   ← 70s later
           cacheKey = same
           in cache BUT expiresAt <= now → live call again

  call 4:  list_funnels({ project_id: 'p2' })   ← different args
           cacheKey = 'list_funnels:{"project_id":"p2"}'
           different key → live call
```

The cache key includes the *serialized* args, so the same tool with different args is a different cache entry. The keys are deterministic only for objects whose property order matches between calls — which they do here because every call site is hand-written, but it's a subtle correctness coupling.

Three boundary conditions:
- **Error results are NOT cached.** `lib/data-source/bloomreach-data-source.ts:178-181` returns without writing to cache when `result.isError === true`. Without this, a transient 429 (containing `isError: true`) would poison the cache for 60s and prevent the retry from succeeding.
- **`skipCache: true` bypasses read but still writes.** The `/debug` "force fresh" path uses this. Write-through, not write-around.
- **Cache is per-process.** Two Vercel instances each have their own cache. A call cached on instance A is not visible to instance B. This is the same Seam B (file 01) problem reappearing — the cache is a local optimization, not a cross-instance contract.

#### Part 2 — the React StrictMode guard

`useInvestigation` (`lib/hooks/useInvestigation.ts:43-48`) uses a ref guard so the effect only runs once per mount, even under StrictMode's mount → unmount → re-mount cycle.

```
  startedRef — the effect-layer dedup

  const startedRef = useRef(false);
  useEffect(() => {
    if (!id) return;
    if (startedRef.current) return;     ← second StrictMode run bails here
    startedRef.current = true;          ← first run claims the slot

    // ... issue the fetch, parse the NDJSON ...
  }, [id, step]);

  why a ref instead of a state:
    state changes re-render; this guard must NOT cause one
    a ref survives across StrictMode's double-invoke
    cleanly because refs don't reset between mount cycles
    when the same component instance is reused
```

The boundary condition that makes this nuanced: the comment in `useInvestigation.ts:33-36` says *"we deliberately do NOT cancel the fetch on effect cleanup."* Cancelling on cleanup *and* guarding with `startedRef` together cancelled the stream and left the logs empty. The chosen tradeoff: live with the in-flight fetch completing after unmount (the `setState`s are no-ops then), in exchange for clean StrictMode behavior. That's an at-most-once *initiation* guarantee with an at-least-once *completion* — the network call WILL finish, even if no one is listening.

#### Part 3 — implicit delivery semantics in the NDJSON stream

Events from `/api/agent` are written one line at a time to a `ReadableStream`. There's no event ID, no resumable cursor, no acknowledgment from client to server. If the client disconnects mid-stream, the server's writer keeps trying to write until it errors out (the controller closes); the client cannot reconnect and resume. Delivery is best-effort, in-order, at-most-once-per-stream.

```
  NDJSON delivery semantics

  server                                      client
  ───────                                     ──────
  send({ type: 'reasoning_step', ... })  →    reader.read() → process
  send({ type: 'tool_call_start', ... })  →    reader.read() → process
  [client disconnects]                         × tab closed
  send({ type: 'tool_call_end', ... })  →     ✗ write fails, stream closes

  no resume protocol. no event ID. no ack.
  delivery is at-most-once per stream:
    - in-order within the stream
    - lost when the connection drops
```

This is fine for live progress display; it would not be fine if the stream were carrying state changes the client *must* see. The cached-replay path (`/api/agent` with no `live=1`) handles re-visits by replaying the entire stored `AgentEvent[]` from disk — not by resuming, but by re-emitting from the start with the same `REPLAY_DELAY_MS` pacing.

#### Part 4 — what NOT YET EXERCISED looks like

The Bloomreach MCP catalog exposes write tools — `update_segmentation`, `create_voucher`, `start_campaign` style operations. The codebase does **not call any of them**. The recommendation agent's output is structured prose (`Recommendation.steps[]`), not actual executions.

```
  the deliberately-not-exercised boundary

  Recommendation agent:
    output: Recommendation { title, rationale, steps[], … }
    effect: rendered as a card the user reads

  what would change if the agent could execute a step:
    1. need an idempotency key per recommendation
       (otherwise a refresh = duplicate voucher)
    2. need server-side dedup (Bloomreach side, OR a write log
       on our side to detect "this recommendation already ran")
    3. need at-least-once semantics with reconciliation, OR
       at-most-once with explicit user-acknowledgment of failure
    4. NDJSON delivery semantics would become inadequate —
       the client MUST know whether the write went through

  none of these are wrong-to-be-absent today.
  all of them become essential the day the recommendation
  agent gets a "execute" button.
```

This is the right kind of NOT YET EXERCISED — explicitly named, scoped to a known feature boundary, with the design pressure that would force the change spelled out.

### Move 3 — the principle

**Idempotency cost is paid where writes happen.** When all your external calls are reads, the entire idempotency apparatus collapses to "use a TTL cache for performance." The moment any external call mutates state, you need to choose between three patterns (natural / key / conditional) and back the chosen one with server-side support. Reading the catalog and using only read tools is a legitimate design choice for a "describe the world" app — it's how blooming insights gets to skip an entire category of distributed-systems work. But it's a property of the *choice*, not an inherent property of the architecture; the day a write enters the call graph, this file's verdict flips.

---

## Primary diagram

```
  Idempotency + dedup — the full picture

  ┌─ client (React) ──────────────────────────────────────────┐
  │                                                            │
  │  useEffect on (id, step):                                  │
  │    if startedRef.current: bail   ◄── EFFECT DEDUP          │
  │    startedRef.current = true                               │
  │    fetch('/api/agent?…')                                   │
  │    parse NDJSON line-by-line                               │
  │    on 'done': sessionStorage.setItem(stash, …)             │
  │                                                            │
  └───────────────────────────────┬───────────────────────────┘
                                  ▼ HTTPS
  ┌─ /api/agent ──────────────────────────────────────────────┐
  │  if cached && !live → replay events 1-by-1 (NO MCP calls) │
  │  else → run agent loop                                    │
  └───────────────────────────────┬───────────────────────────┘
                                  ▼ runAgentLoop
  ┌─ McpClient.callTool ──────────────────────────────────────┐
  │                                                            │
  │   cacheKey = `${name}:${JSON.stringify(args)}`             │
  │                                                            │
  │   ┌─ cache hit (within 60s TTL) ─┐                         │
  │   │  return { fromCache: true,    │                         │
  │   │           durationMs: 0 }     │   ◄── NETWORK DEDUP    │
  │   └───────────────────────────────┘                         │
  │                                                            │
  │   ┌─ cache miss ─┐                                          │
  │   │  liveCall    │                                          │
  │   │  retry loop  │  (file 02)                                │
  │   │  cache.set if !isError                                   │
  │   └──────────────┘                                          │
  │                                                            │
  └───────────────────────────────┬───────────────────────────┘
                                  ▼
  ┌─ Bloomreach MCP ──────────────────────────────────────────┐
  │   all called tools are READS:                              │
  │     list_*, get_*, execute_analytics_eql                   │
  │   idempotent by definition — no dedup needed               │
  │                                                            │
  │   writes (update_*, create_*, start_*) — NOT YET EXERCISED │
  └────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.**
- Re-visiting an investigation page in dev (React StrictMode): without `startedRef`, two fetches would issue; with it, only one runs.
- The schema bootstrap (`bootstrapSchema`) is called by both `/api/agent` and `/api/briefing` within seconds of each other. The four underlying tool calls (`get_event_schema`, `get_customer_property_schema`, `list_catalogs`, `get_project_overview`) are cached for 60s in `McpClient` *and* the parsed `WorkspaceSchema` is cached at the module level for the lifetime of the process. The combined dedup means the second route pays zero network cost.
- The monitoring agent issues several `execute_analytics_eql` calls with different EQL bodies. Each unique EQL is a different cache key. If the agent happens to issue the *same* EQL twice (e.g. re-checking a baseline), the second one returns from cache instantly.

**Code side by side.**

```
  lib/data-source/bloomreach-data-source.ts  (lines 144-152, 178-187)

  const cacheKey = `${name}:${JSON.stringify(args)}`;     ← key includes args
  const ttl = options.cacheTtlMs ?? 60_000;                 deterministically

  if (!options.skipCache) {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {        ← lazy TTL check;
      return {                                                no background eviction
        result: cached.result as T,
        durationMs: 0,
        fromCache: true,                                  ← caller can observe
      };                                                     this for diagnostics
    }
  }

  // ... after live call + retry ...

  if ((result as any)?.isError === true) {
    return { result: result as T, durationMs, fromCache: false };
  }                                                       ← NEVER cache errors

  const now = Date.now();
  this.cache.set(cacheKey, { result, expiresAt: now + ttl });
  return { result: result as T, durationMs, fromCache: false };
       │
       └─ the "don't cache errors" line is load-bearing. Without it,
          a 429 that contained isError: true would be cached for 60s,
          and the next call would return the rate-limit envelope from
          cache without ever retrying. The error → cache miss → retry
          path depends on this.
```

```
  lib/hooks/useInvestigation.ts  (lines 43-48)

  const startedRef = useRef(false);

  useEffect(() => {
    if (!id) return;
    if (startedRef.current) return;     ← second StrictMode run bails
    startedRef.current = true;           ← first run claims the slot

    // ... hydrate from stash, then fetch /api/agent ...
  }, [id, step]);
       │
       └─ this is the only client-side dedup. The fetch itself has
          no AbortController on the cleanup path (deliberate, see
          comment in file at lines 33-36) — so the in-flight request
          completes even after unmount. That's at-most-once initiation
          with at-least-once completion.
```

```
  app/api/agent/route.ts  (lines 127-141)

  const cached = insightId && !live ? getCachedInvestigation(insightId) : null;
  if (cached) {
    const events = step ? filterByStep(cached, step) : cached;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const e of events) {
          controller.enqueue(encoder.encode(encodeEvent(e)));
          await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));   ← paced replay
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: NDJSON_HEADERS });
  }
       │
       └─ the "replay" path. Cached investigations are effectively
          idempotent re-views — the cache key is insightId, the
          payload is deterministic, every replay produces the same
          stream. This is what makes the demo mode safe to refresh.
```

---

## Elaborate

The cache-key approach (`${name}:${JSON.stringify(args)}`) works because every callsite in the codebase passes args as a plain object literal with consistent property order. If two callsites passed `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` for the same logical call, they'd be different cache keys — silent duplication. JavaScript object property iteration order is well-defined for string keys (insertion order), so this is stable in practice, but it's a sharp edge worth knowing about. A defensive fix would be to sort keys before stringifying.

A genuine production-grade dedup would replace the `Map` with a Redis or Vercel KV-backed cache, keyed the same way but cross-instance. That would also let you implement an idempotency-key pattern for future writes — `SET NX` on the key, with the value being the result of the first write. The architecture is small enough that this would be a ~50-line addition to `McpClient`; the reason it isn't there is the same reason there's no database (file 01 of `study-system-design/`).

---

## Interview defense

**Q: How does this app handle duplicate or retried tool calls?**

Two layers. At the effect layer, a ref guard in `useInvestigation` prevents StrictMode from issuing two fetches for the same `(id, step)`. At the network layer, `McpClient` caches every successful call for 60 seconds keyed by `${toolName}:${JSON.stringify(args)}`, so two identical calls within that window cost one network round-trip. Beyond that, the question doesn't really fire — every tool I call is a read.

```
  the two real layers

  React effect    ←  startedRef guard  ←  one fetch per (id,step)
  McpClient       ←  60s TTL Map      ←  one network call per
                                          (toolName, args)
  provider        ←  reads only        ←  no app-level dedup needed
```

**Q: What changes when you add a write?**

Everything in this file flips. I'd need an idempotency key per logical operation — most simply, a UUID generated client-side and sent in the call args, so the server can dedup on its side. Plus the in-memory cache becomes inadequate because it doesn't span Vercel instances — a write retried on a different instance wouldn't see the first attempt's success. So a Vercel KV-backed lookup of "have I issued this idempotency key already?" sitting in front of every write. None of which is built today, because the recommendation agent describes actions instead of taking them — the deliberate "no writes" choice is what lets me skip this whole apparatus.

**Q: What's the load-bearing part of the cache people forget?**

Not caching error results. If a 429 (which arrives as `isError: true` inside HTTP 200) got cached, the next call would return the rate-limit envelope from cache without ever retrying — the retry loop would never run. The one line `if (result.isError === true) return … without cache.set` is what makes the cache safe to combine with the retry loop.

---

---

## See also

- `02-partial-failure-timeouts-and-retries.md` — why the cache MUST skip error results: retries depend on it
- `04-consistency-models-and-staleness.md` — the 60s TTL is also a staleness window
- `08-sagas-outbox-and-cross-boundary-workflows.md` — the user-driven step 2 → step 3 flow has dedup of its own
- `10-transport-agnostic-protocol-design.md` — RETIRED; the Phase-2 record of the no-longer-extant two-adapter cache asymmetry
- `.aipe/study-system-design/audit.md#caching-and-invalidation` — the architectural take on caching
- `.aipe/study-testing/` — the cache + retry tests live in `test/data-source/bloomreach-data-source.test.ts` (and friends)

---
Updated: 2026-06-16 — Verdict + zoom-out cover both adapters' dedup (Bloomreach: 60s TTL; Olist: none); line refs migrated to `lib/data-source/bloomreach-data-source.ts`; flagged the asymmetric cache as a deliberate design choice tied to transport cost.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
