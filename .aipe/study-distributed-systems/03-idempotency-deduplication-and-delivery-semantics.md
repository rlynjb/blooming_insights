# Idempotency, Deduplication, and Delivery Semantics

*Industry name: at-most-once / at-least-once / effectively-exactly-once · Type: Industry standard*

## Zoom out — where this concept lives

Idempotency is the property that lets you retry safely. If you charge a card twice because the first response got lost, that's a bug. If you fetch the same event count twice, that's fine — same answer either way. The retry ladder in `02-partial-failure-timeouts-and-retries.md` is only safe *because* the tool calls it retries are read-only.

```
  Zoom out — where delivery semantics get decided

  ┌─ Client band ──────────────────────────────────────────┐
  │  browser (no dedup logic — trusts the server)          │
  └─────────────────────────┬──────────────────────────────┘
                            │
  ┌─ Server band ───────────▼──────────────────────────────┐
  │  route.ts   agent loop decides which tools to call     │
  │                    │                                    │
  │  ┌─ McpDataSource ▼───────────────────────────────┐    │
  │  │  ★ THIS FILE: what "retry" means for a tool ★   │    │
  │  │                                                 │    │
  │  │  · retry ladder (invocation-level)              │    │
  │  │  · 60s response cache (absorbs duplicates)      │    │
  │  │  · assumes: tools are read-only, idempotent    │    │
  │  └────────────────────┬────────────────────────────┘    │
  └───────────────────────┼─────────────────────────────────┘
                          │
                          ▼
                    ┌──────────┐
                    │MCP server│
                    │ (tools)  │
                    └──────────┘
```

The whole picture rests on one contract: **every MCP tool this repo calls is read-only.** `list_cloud_organizations`, `list_projects`, `get_event_schema`, `run_query`. Nothing writes. That contract is what makes the retry ladder correct and the 60 s cache safe.

## Zoom in — narrow to the concept

Three delivery semantics show up in the literature:

- **at-most-once** — the message may or may not arrive; it never arrives twice
- **at-least-once** — the message arrives, possibly twice or more
- **effectively-exactly-once** — the message arrives once as far as the receiver's state is concerned (achieved via idempotency keys + dedup on the receiver)

This repo lives at **at-most-once from the transport, effectively-once-per-cache-window at the McpDataSource layer**, and that's fine because tools are read-only. This file walks why that's the right choice and where it breaks if tools ever gain side effects.

## Structure pass

### Layers

- **Agent loop** — decides *what* to call. May call the same tool twice with the same args, or the same tool twice with slightly-different args.
- **McpDataSource** — deduplicates identical (name + args) calls inside the 60 s window via the response cache.
- **Transport** — one HTTPS request per attempt. At-most-once semantics: if a call throws, we don't know if the server received it.

### One axis held constant — "who sees a duplicate?"

```
  Axis: duplicate visibility, traced across layers

  agent loop    → may issue the same call twice
                  (model decides based on prior tool_result)

  McpDataSource → cache key = name+args stringified
                  identical call within 60s = ONE server round-trip
                  effectively-once per cache window

  transport     → every attempt = one HTTP request
                  at-most-once semantics; no dedup

  MCP server    → sees whatever we send; some tools might dedup
                  internally, but we don't rely on it
```

The flip that matters: **the model can duplicate calls with intent, and the cache absorbs it.** That's the design.

### Seams

- **agent loop ↔ McpDataSource**: the seam where "the model's next tool call" turns into "should we hit the server?" The cache lookup is here.
- **McpDataSource ↔ transport**: the seam where an in-memory hit avoids an HTTP request entirely.

## How it works

### Move 1 — the mental model

You already know the shape: it's memoization with a TTL. `useMemo` for HTTP. The wrinkle in a distributed setting is that memoization is only safe when the underlying function is a *pure read* — no side effects. This repo enforces that by convention: only read tools go through this cache.

```
  The pattern — memoize a read, at-most-once the underlying wire

  agent asks for tool T with args A
        │
        ▼
  ┌─────────────────┐
  │ cache lookup    │  key = "T:JSON.stringify(A)"
  │ (per-instance)  │
  └────────┬────────┘
           │
      hit?─┴─miss
           │
          hit:                         miss:
     return cached                fire liveCall
     fromCache=true                       │
                                          ▼
                                  ┌───────────────┐
                                  │ retry ladder  │
                                  └───────┬───────┘
                                          │
                                    result:isError?
                                     yes ─┴─ no
                                          │
                                     no cache write     cache write, TTL 60s
                                     return             return fromCache=false
```

The kernel: **cache key = name + args, TTL bounded, no writes on error.** The retry ladder sits inside the miss branch. That layering is what makes retries safe: a retried call that succeeds writes to the cache once; subsequent duplicates hit the cache, not the server.

### Move 2 — the walkthrough

#### The cache key — how "identical" is defined

The identity of a call is `${name}:${JSON.stringify(args)}` (`bloomreach-data-source.ts:144`):

```ts
// lib/data-source/bloomreach-data-source.ts:144
const cacheKey = `${name}:${JSON.stringify(args)}`;
```

`JSON.stringify` is not deterministic across object key ordering in general, but the args map at the call site is always constructed in the same order by the agent loop (the model produces JSON in a stable order, and the AptKit adapter passes it through unchanged). This works because the args come from ONE producer, not from arbitrary clients.

**Failure mode this hides**: if two different call sites passed the same logical args in different orders (`{a: 1, b: 2}` vs `{b: 2, a: 1}`), they'd cache-miss and duplicate the call. In this repo, that doesn't happen — the model is the only producer.

```
  Cache key uniqueness — one producer, deterministic ordering

  model → tool_use block → args (stable order per tool schema)
                            │
                            ▼
                    JSON.stringify → deterministic key
                            │
                            ▼
                       cache lookup
```

#### The 60 s TTL — a policy, not a correctness rule

The default `cacheTtlMs = 60_000` (`bloomreach-data-source.ts:145`). The `/api/mcp/call` route can override it per-call. Why 60 s?

- A single investigation runs 100-115 s under the ~1 req/s Bloomreach limit. Most repeat lookups happen within that window.
- After 60 s, the underlying data might have shifted (new events landed). We'd rather re-fetch than serve stale.
- The route budget is 300 s (`maxDuration = 300`), so within one request the cache always holds.

**This is at-most-once with a TTL twist**: the same call within 60 s hits the cache exactly once; after 60 s it becomes a fresh at-most-once call.

#### skipCache — the escape hatch

The `/debug` "force fresh" path passes `skipCache: true`:

```ts
// lib/data-source/bloomreach-data-source.ts:147
if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

Notice the comment upstream at line 184: *"a skipCache call still refreshes the cache (write-through), which is the desired behavior for the /debug 'force fresh' path."* That's a deliberate write-through: skipCache bypasses the read, but the successful result still updates the cache for future hits. This is only correct because tools are read-only — for a write tool, write-through would be a bug (you'd cache the response to a mutation).

#### no-cache-on-error — the correctness knob (recap)

This one's covered in file 02, but it's an idempotency decision too. If a tool call returns `isError: true`, we don't cache it. Why: an error is not a valid "answer" — the next duplicate call should re-try the server. If we cached errors, we'd effectively memoize a transient failure.

```
  Cache write decision — idempotency angle

  result ok           → cache 60s   (memoize the read)
  result isError=true → no cache     (don't memoize a transient failure)
  throws              → propagates   (no cache write; caller sees typed error)
```

#### The retry ladder's safety — why at-most-once works

The retry ladder retries **successful-but-rate-limited results**, not thrown errors. That's important for idempotency:

- A 429 result means the server received the call and refused it. It did NOT execute anything. Retrying is safe.
- A thrown timeout (`HTTP 0`) means the server *may or may not* have received the call. For a read-only tool that's fine; the retry is safe. For a write tool it would be a bug.

The reason the retry ladder can be aggressive without an idempotency key is the read-only contract. Every tool the repo calls today is a query (`list_*`, `get_*`, `run_query`), not a mutation.

#### The agent loop's role — where "duplicates" come from

Duplicates aren't a bug in this repo; they're a feature. The model may call `run_query` twice with slightly-different args because it's reasoning about two hypotheses. If it calls with *identical* args (same query, same filters), the cache absorbs it — no wasted round-trip.

```
  Model duplicates — the cache absorbs them

  turn 1:  run_query(metric='revenue', period='2026-06')  → server
  turn 2:  run_query(metric='revenue', period='2026-06')  → cache hit
  turn 3:  run_query(metric='revenue', period='2026-05')  → server (different args)
  turn 4:  run_query(metric='revenue', period='2026-06')  → still cache hit
```

The AptKit agent loop doesn't dedupe internally — it lets the DataSource handle it. The tracker adapter (`aptkit-adapters.ts:180`) surfaces `durationMs` from the cache hit as `0`, so the UI can show "cached" in the trace.

### Move 2.5 — current state vs future state

The whole picture depends on **read-only tools**. If a write tool gets added (e.g. `create_campaign`, `update_segment`), this whole design breaks. The migration would need three additions:

```
  Phase A (now):         Phase B (if writes land):
  ────────────           ─────────────────────────

  · read-only tools      · read tools + write tools
    at the seam            explicitly split at the seam
  · cache absorbs        · cache ONLY reads;
    all duplicates         writes bypass cache entirely
  · retry ladder         · retry ladder ONLY safe for reads;
    always safe            writes need idempotency keys
                         · write tools need
                           receiver-side dedup
                           (idempotency key ↔ dedup table)
```

The current AptKit tool schemas don't distinguish read/write. Adding writes without adding the distinction is the failure mode. See the audit (file 09) for this risk.

### Move 3 — the principle

**Retries are safe if and only if the underlying operation is idempotent.** This repo ships a 3-retry ladder plus a 60 s cache and it's correct — because every tool it calls is a pure read. That's a load-bearing invariant, not an incidental one. The moment it changes, the retry ladder becomes a bug (double-execute) and the cache becomes a security issue (memoize a mutation response).

## Primary diagram

The full picture — where duplicates come from, where they die:

```
  Duplicate flow — from model turns to server round-trips

  turn N model output: tool_use { name, args }
       │
       ▼
  ┌────────────────────────────────────────────────┐
  │ AptKit agent loop                               │
  │  no dedup — passes through to DataSource        │
  └───────────────────────┬────────────────────────┘
                          │
                          ▼
  ┌────────────────────────────────────────────────┐
  │ McpDataSource.callTool                          │
  │                                                 │
  │  cacheKey = `${name}:${JSON.stringify(args)}`   │
  │  skipCache? false ──┐                           │
  │                     │                           │
  │  cache.get(key) → hit + not expired?            │
  │       ├─ yes ──► return {fromCache: true, ...}  │
  │       │           (no server round-trip)        │
  │       ▼                                         │
  │  miss:                                          │
  │   liveCall(...) → retry ladder → result         │
  │                                                 │
  │  result.isError?                                │
  │       ├─ yes ──► return, don't cache            │
  │       │                                         │
  │       ▼                                         │
  │   cache.set(key, {result, expires: now+60s})    │
  │   return {fromCache: false, ...}                │
  └───────────────────────┬────────────────────────┘
                          │  HTTPS (only on miss)
                          ▼
                    ┌──────────┐
                    │MCP server│  ← at-most-once from here
                    └──────────┘  ← any tool must be read-only
```

## Elaborate

The classic "exactly-once" story in distributed systems is: producer stamps every message with a unique key, receiver keeps a dedup table indexed by that key. That's **effectively-once at the receiver**. Kafka's transactional producer, Stripe's `Idempotency-Key` header, RabbitMQ's dedup plugin — all the same shape.

This repo doesn't need any of that machinery because it never writes. The 60 s cache is a *client-side* dedup, and it's only safe because there's no server-side state to worry about.

**Fault injection interaction**: the FaultInjectingDataSource in `lib/data-source/fault-injecting.ts` can inject a `malformed_json` fault (line 148) that returns `isError: false` but with garbage content. This would normally be a nightmare for delivery semantics — the caller thinks it succeeded, memoizes a broken response, and every retry hits the poisoned cache. But the agent's downstream `unwrap()` parse (see `lib/mcp/schema.ts`) rejects the garbage, and the model reasons around a failed tool result. The cache DOES get poisoned for 60 s in this scenario, though, since `isError: false`. That's a known small hole — file 09 audits it.

Related: **the auth cookie** is the ONE thing this repo does that requires cross-instance idempotency, and it's handled by AES-256-GCM encryption keyed on `AUTH_SECRET` (`lib/mcp/auth.ts:62`). Any Vercel instance can decrypt any cookie, so a request that lands on a different instance than the one that set the cookie still works. That's the closest thing to "distributed state" in this repo, and it's handled by cryptographic construction, not by a dedup table.

## Interview defense

**Q: "Are your tool retries safe?"**

A: Yes, because every MCP tool the repo calls is read-only. The retry ladder retries *successful-but-rate-limited* results (429s that carry text saying "retry after X seconds"). A 429 means the server received the call and refused it — no state changed — so retrying is safe. Thrown errors (timeouts) aren't retried at the invocation level, so the "did the server receive it or not?" question doesn't arise.

```
   at-most-once   →   read-only tool   →   retry safe
   at-least-once  →   read-only tool   →   still safe (idempotent)
   at-least-once  →   write tool       →   BUG (double-execute)
```

**Load-bearing invariant**: read-only tools. If a write tool ever lands, the retry ladder becomes a bug.

**Q: "How does your cache avoid duplicate calls?"**

A: Cache key is `${name}:${JSON.stringify(args)}`. Same tool + same args within 60 s = one server round-trip. The model may issue duplicates as it explores hypotheses; the cache absorbs them. `fromCache: true` on the result lets the UI show it as a cache hit.

**Load-bearing gotcha**: `JSON.stringify` is only deterministic here because the model is the only producer. If two clients constructed the same args in different key orders, they'd cache-miss and duplicate — that's not a bug today, it's an assumption that could bite later.

**Q: "What if a tool returns isError — do you memoize it?"**

A: No. `bloomreach-data-source.ts:178` — the cache write is gated on `!result.isError`. Errors shouldn't poison the cache. The next duplicate call should re-try the server, since the error might have been transient. This is a small circuit-breaker-adjacent decision: don't propagate a bad state as if it were good.

**Anchor**: `lib/data-source/bloomreach-data-source.ts:144` (cache key) and `:178` (no-cache-on-error).

## See also

- `02-partial-failure-timeouts-and-retries.md` — the retry ladder that this file's invariant makes safe.
- `04-consistency-models-and-staleness.md` — the 60 s TTL is a staleness bound.
- `09-distributed-systems-red-flags-audit.md` — what happens if a write tool ever lands.
