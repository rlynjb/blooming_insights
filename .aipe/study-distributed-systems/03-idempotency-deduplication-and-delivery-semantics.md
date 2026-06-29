# Idempotency, deduplication, and delivery semantics

**Industry name:** read-through cache as dedup layer, idempotent reads · **Type:** Industry standard pattern, applied minimally

## Zoom out, then zoom in

Verdict first: this repo doesn't *write* anywhere through MCP — every tool call is a read (`list_*`, `get_*`, `execute_analytics_eql`). That makes idempotency the easy case, and the 60s response cache in `BloomreachDataSource` is the only deduplication mechanism in the stack. There's no idempotency key, no dedup store, no at-least-once worker contract — because nothing here would benefit from one.

```
  Zoom out — where dedup lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  feed re-mounts, navigation, demo replay                  │
  │  (multiple requests may want the same data)               │
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ Service layer ────────▼─────────────────────────────────┐
  │  /api/briefing · /api/agent                               │
  │  bootstrapSchema → list_cloud_organizations →             │
  │                    list_projects → 4 schema fetches       │
  └────────────────────────┬─────────────────────────────────┘
                           │ callTool(name, args)
  ┌─ Network boundary ─────▼─────────────────────────────────┐
  │  ★ BloomreachDataSource cache ★                            │ ← we are here
  │  60s TTL · key = `${name}:${JSON.stringify(args)}`        │
  │  errors NOT cached                                         │
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ Provider layer ───────▼─────────────────────────────────┐
  │  Bloomreach loomi-MCP — every read is idempotent          │
  └──────────────────────────────────────────────────────────-┘
```

The lesson is small but real: when your upstream is rate-limited and your tools are read-only, the *cache* IS the dedup story. You don't need a Redis Sorted Set with idempotency keys — you need to recognize that two identical reads inside the TTL are the same read.

## Structure pass

### Axis: how many times might the upstream actually be hit?

```
  Trace "upstream-hits" across layers

  Browser            — issues N concurrent requests to /api/briefing
                       (re-mounts, double-clicks, StrictMode dev)
       │
  Service            — each request opens its own stream + agent loop
                       — but only ONE bootstrap inside a hot instance
                         (lib/mcp/schema.ts:190 `cached` memoization)
       │
  BloomreachDataSource — N identical calls inside 60s → 1 upstream hit
                         (cache key includes args)
       │
  Provider           — sees only the non-deduplicated subset
```

The axis-answer collapses as you go down. That collapse is the dedup pattern — nothing magic, just two layers of memoization (per-instance schema + per-instance call cache).

### Seams (load-bearing boundaries)

- `BloomreachDataSource.callTool` ↔ `liveCall` — the cache check is *before* the rate-limited live call. Drop the cache and a repeat investigation pays the full ~1.1s × N spacing again.
- The `isError` guard at line 179 ↔ cache write — drop the guard and a transient failure poisons subsequent reads for the full 60s.
- `bootstrapSchema`'s `cached` ↔ first-call orchestration — drop it and every request re-runs `list_cloud_organizations → list_projects → 4 fetches`, ~6 upstream calls each time at ~1.1s spacing.

### Layered decomposition

```
  "How idempotent is this layer?" — traced across the stack

  ┌─ Bloomreach tools ────────────────────────┐
  │  every tool we call is read-only          │   → naturally idempotent
  │  (list_*, get_*, execute_analytics_eql)   │
  └───────────────────────────────────────────┘
       ┌──────────────────────────────────────┐
       │ BloomreachDataSource cache           │   → key = (name, args)
       │ same args → same response (within 60s)│      pure read-through
       └──────────────────────────────────────┘
            ┌─────────────────────────────────┐
            │ Schema bootstrap memoization    │   → first-caller wins
            │ `cached` module-level variable  │
            └─────────────────────────────────┘
                 ┌────────────────────────────┐
                 │ Insights / investigations  │   → session-scoped Map,
                 │ in-memory state            │      keyed by id; writes
                 │                            │      are last-writer-wins
                 └────────────────────────────┘
```

Same question, four different answers. The axis-answer shifts as you climb back up — and that's why the cache lives where it does (just above the network) rather than higher in the stack.

## How it works

### Move 1 — the mental model

You know how `useMemo(() => expensiveCall(deps), deps)` skips the recompute when deps haven't changed? Same idea — the cache key is `${name}:${JSON.stringify(args)}`, the "recompute" is the rate-limited HTTPS call, and the TTL is 60s. That's it. The interesting part isn't the cache, it's the **two rules around the cache** (errors don't write; the live call still uses spacing) that make the dedup safe.

```
  Cache kernel — the pattern in one picture

           callTool(name, args, {skipCache?, cacheTtlMs?})
                          │
                          ▼
                 key = `${name}:${JSON.stringify(args)}`
                          │
            ┌─────────────┴─────────────┐
            │ skipCache?                │
            │  no                       │  yes
            ▼                           │
       cache.get(key)?                  │
            │                           │
   ┌────────┴────────┐                  │
   │ hit && fresh   │ miss/stale        │
   ▼                ▼                   ▼
{fromCache:true}  liveCall ──────► liveCall
                  + retry ladder   + retry ladder
                       │                │
                       ▼                ▼
                  isError?         isError?
                       │                │
              ┌────────┴────┐    ┌──────┴────┐
              │ yes         │    │ yes       │
              ▼             ▼    ▼           ▼
        return (no       cache.set(key,    return (no
        cache write)     result, ttl)      cache write)
                              │
                              ▼
                         {fromCache:false}
```

### Move 2 — walk the parts

#### Part: the key (composability over collision-resistance)

```ts
// lib/data-source/bloomreach-data-source.ts:144
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;
```

Brutally simple. Two calls match if the tool name matches *and* the arg JSON matches verbatim. That means `{project_id: 'x', segment: 'y'}` and `{segment: 'y', project_id: 'x'}` are different keys (JSON.stringify preserves insertion order for non-numeric keys). The agents always build args in a consistent order, so this isn't a real collision risk — but it's worth knowing the contract.

#### Part: the freshness check (TTL, not LRU)

```ts
// lib/data-source/bloomreach-data-source.ts:147
if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

Two details: `durationMs: 0` (because we didn't make a call) and `fromCache: true` (surfaced in the UI's "how this was gathered" trace, see `app/api/briefing/route.ts:273` — the trace shows cache hits so the user can see WHY a re-run was instant). No LRU eviction — entries linger past their `expiresAt` and are simply not returned on read. The cache grows until the instance restarts, which on Vercel happens often enough to not matter.

#### Part: the isError guard (the rule that saves you)

```ts
// lib/data-source/bloomreach-data-source.ts:179
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
```

Drop this guard and a single transient rate-limit envelope (which already escaped the retry ladder) would cache as the "answer" for `execute_analytics_eql` with those args for the next 60s. Every subsequent call would hit the cache, return the error envelope as if it were data, and the UI would show "this metric is rate-limited" for a minute. The guard is the load-bearing piece.

#### Part: skipCache (the cache-bypass escape hatch)

The two short MCP routes (`/api/mcp/call`, `/api/mcp/capture`) and the dev debug page pass `skipCache: true` so a "force fresh" path exists. **A skipCache call still refreshes the cache (write-through)** — see the comment at line 184:

```ts
// Note: a skipCache call still refreshes the cache (write-through), which is
// the desired behavior for the /debug "force fresh" path.
```

That's a real design choice: a manual refresh shouldn't *also* leave the next caller hitting a stale cache. Industry: this is how `Cache-Control: no-cache` differs from `no-store` — no-cache revalidates and updates, no-store doesn't write at all. We chose `no-cache`-equivalent behavior.

#### Part: schema bootstrap as a second dedup layer

The MCP bootstrap chain (`list_cloud_organizations` → `list_projects` → `get_event_schema` + 3 siblings) runs *every request* the first time, but a module-level `cached` variable in `lib/mcp/schema.ts:190` makes the result sticky for the lifetime of the Node process:

```ts
// lib/mcp/schema.ts:186
export async function bootstrapSchema(
  dataSource: DataSource,
  opts: BootstrapOpts = {},
): Promise<WorkspaceSchema> {
  if (cached) return cached;       // ← per-instance memoization
  const { projectId, projectName } = await resolveProject(dataSource, opts);
  const args = { project_id: projectId };
  // Sequential — the server allows ~1 req/s; BloomreachDataSource already spaces calls.
  const eventSchema = await callOrThrow(dataSource, 'get_event_schema', args, opts);
  const customerProps = await callOrThrow(dataSource, 'get_customer_property_schema', args, opts);
  const catalogs = await callOrThrow(dataSource, 'list_catalogs', args, opts);
  const overview = await callOrThrow(dataSource, 'get_project_overview', args, opts);
  cached = parseWorkspaceSchema({…});
  return cached;
}
```

Two layers of memoization stacked: the schema cache means subsequent *requests* skip the bootstrap entirely; the response cache means subsequent *calls* skip the round-trip. The schema cache is process-scoped so a cold start re-runs it; the response cache is also process-scoped but its TTL would expire long before the instance gets warm anyway.

There's a duplicate-work caveat: **two concurrent first requests will both call `bootstrapSchema` because there's no in-flight lock.** Both run the orchestration; the second writes to `cached` second. Idempotent reads make this safe — wasted bandwidth, not corrupted state. See the red-flags audit.

#### Part: the `fromCache` flag as observability

The cache hit surfaces in the trace. See `app/api/briefing/route.ts:267` — every tool_call_end event carries `durationMs` (0 for cache hits, real ms for live calls). The UI's `ToolCallBlock` reads `durationMs` and renders cache hits as instant — the user sees WHY a re-run is fast.

```
  Execution trace — cache key dedup across a typical run

  call 1: execute_analytics_eql {project_id: x, eql: "session_start ..."}
           → liveCall (1.1s wait + ~500ms upstream) → cache.set, fromCache:false

  call 2 (1s later, same args)
           → cache.get → hit, fromCache:true, durationMs:0

  call 3 (5s later, DIFFERENT args)
           → cache.get → miss → liveCall (1.1s wait + ~500ms upstream)

  call 4 (60.1s later, same as call 1)
           → cache.get → expired → liveCall (refresh)
```

### Move 3 — the principle

**Idempotency is a property of the operation; dedup is the policy you apply to it.** Bloomreach's read tools are naturally idempotent (the property), so we get to apply dedup cheaply as a TTL cache (the policy). If we were *writing* — creating campaigns, publishing scenarios — we'd need the operation to be made idempotent first (idempotency keys, server-side dedup tables) before any client cache could safely deduplicate. The Bloomreach API doesn't expose write tools to us, so this corner of the design space stays empty.

The deeper move: **the cheapest dedup is the one where the operation tolerates re-execution**, so retrying is free. We chose this corner deliberately.

## Primary diagram

```
  Full dedup picture — three layers, one upstream

  ┌─ Browser ────────────────────────────────────────────────────────┐
  │  re-mounts, double-clicks, StrictMode dev → N requests             │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │ HTTPS
  ┌─ /api/briefing /api/agent ───▼───────────────────────────────────┐
  │  per-request: bootstrap, listTools, run agent loop                │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │
  ┌─ Layer 1: bootstrapSchema cache ─────────────────────────────────┐
  │  `cached` module variable (lib/mcp/schema.ts:190)                 │
  │  hit → skip the entire 6-call bootstrap chain                     │
  │  miss → orchestrate: list_cloud_orgs → list_projects → 4 fetches  │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │ callTool(name, args)
  ┌─ Layer 2: BloomreachDataSource cache ────────────────────────────┐
  │  key = `${name}:${JSON.stringify(args)}`                          │
  │  hit + fresh → return {fromCache:true, durationMs:0}              │
  │  miss/stale  → liveCall(+retry) → if !isError → cache.set         │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │ HTTPS (rate-limited, ~1.1s spacing)
  ┌─ Bloomreach loomi-MCP ──────-▼───────────────────────────────────┐
  │  all our tools are reads — naturally idempotent                   │
  └──────────────────────────────────────────────────────────────────-┘
```

## Elaborate

The pattern here is the read-through cache (Hibernate, ORM L2, browser HTTP cache) flavored for an upstream that *charges* you per call via a rate limit rather than per byte. Adjacent industry patterns we deliberately don't use:

- **Idempotency keys (Stripe-style).** Server-side dedup table keyed by a client-supplied UUID; the server records the response for some retention window and replays it on retry. Necessary when the operation has side effects. We don't write, so we don't need them.
- **At-least-once delivery with consumer-side dedup.** Common in message-queue worlds (Kafka offsets + idempotent consumers). We have no queue. The closest analog: the cache key playing the role of a "natural" dedup id.
- **Exactly-once semantics.** A myth at the network layer; achievable as "effectively exactly-once" by combining at-least-once delivery with idempotent operations. Same answer: not exercised here.

If recommendations ever triggered side-effects in Bloomreach (create scenario, publish campaign), this file would need a sibling about the write-side patterns — see `08-sagas-outbox-and-cross-boundary-workflows.md` for the Case B sketch.

What to read next: Stripe's idempotency keys docs; Kafka's "exactly-once semantics" blog post; the HTTP caching spec (RFC 9111) for the vocabulary that informed `skipCache` + write-through.

## Interview defense

**Q: "How do you handle duplicate requests in this system?"**

> "Two layers of memoization, both process-scoped. Layer one is the schema bootstrap — a module-level `cached` variable in `lib/mcp/schema.ts:190` so the first request runs the 6-call orchestration and subsequent requests skip it entirely. Layer two is a TTL response cache (`BloomreachDataSource.cache`) — 60s, keyed by `${tool}:${JSON.stringify(args)}` so repeat reads inside that window return instantly. The two layers stack: identical investigations re-run in under a second."

Diagram:

```
  request → schema cache? → call cache? → liveCall + 1.1s spacing
              hit: skip       hit: return    ↑ only get here on a real miss
```

**Q: "What's the load-bearing detail?"**

> "Errors are not cached. Line 179 of `bloomreach-data-source.ts` checks `isError` before the cache write. Without that, a transient rate-limit envelope that escaped the retry ladder would cache as the 'answer' for that tool+args for the full 60s, and every subsequent call would return the error as if it were data. The guard makes the dedup safe."

**Q: "Why no idempotency keys?"**

> "Every tool we call is a read — `list_*`, `get_*`, `execute_analytics_eql`. Reads are naturally idempotent, so the cache key IS the dedup id, no server-side coordination needed. If we ever start writing — creating Bloomreach scenarios or publishing campaigns from the recommendation agent — we'd need real idempotency keys because the side effects don't tolerate replay. Right now the recommendation agent only proposes actions, it doesn't execute them. That's a deliberate scope choice."

**Q: "What's missing?"**

> "An in-flight lock on the bootstrap. Two concurrent first requests both run the schema orchestration because nothing serializes them. It's safe because reads are idempotent — wasted bandwidth, not corrupted state — but on a busy cold start it could double the bootstrap cost. A `Promise`-valued cache (memoize the in-flight Promise, not just the resolved value) would fix it. Listed in the red-flags audit."

## See also

- `02-partial-failure-timeouts-and-retries.md` — the retry ladder that feeds into the cache.
- `04-consistency-models-and-staleness.md` — what the 60s TTL means for what the user sees.
- `08-sagas-outbox-and-cross-boundary-workflows.md` — Case B: what changes if we start writing.
- `../study-database-systems/` — the storage-engine vocabulary if you want to compare cache patterns.
