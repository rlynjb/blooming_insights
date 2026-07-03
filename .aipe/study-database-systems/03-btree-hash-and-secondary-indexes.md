# 03 · B-tree, hash, and secondary indexes

*Index structures and lookup behavior · Case B (hash-only)*

## Zoom out — where this concept lives

An index answers one question: **given a key, which record?** In a
real DB you pick between B-tree (ordered, range-friendly, moderate
write cost) and hash (unordered, exact-match only, cheapest writes).
This repo has no B-trees anywhere — every lookup is exact-match on a
hash. That's not a limitation to feel bad about; it's a natural
consequence of what the code is actually asking of the data.

```
Zoom out — where the "index" question sits

┌─ query side ─────────────────────────────────┐
│  getInsight(sessionId, id)                   │
│  ↑ this is a POINT LOOKUP by exact key       │
└─────────────────────┬────────────────────────┘
                      │
┌─ ★ THIS CONCEPT ★  ▼────────────────────────┐
│  the index — key → record location           │
│                                               │
│  choices in classical DBs:                    │
│    · B-tree   (ordered, range scans)         │
│    · hash     (exact match only, fastest)    │
│    · bitmap, GIN, GiST, …                    │
│                                               │
│  choice in THIS repo:                         │
│    · JS Map only (hash)                       │
│    · no ordering anywhere                     │
└─────────────────────┬────────────────────────┘
                      │
┌─ storage ───────────▼────────────────────────┐
│  the record itself lives here                │
└──────────────────────────────────────────────┘
```

## Zoom in — the pattern

**The pattern:** *hash-only lookup, exact-match everywhere.* Two
"indexes" exist in the runtime: the JS `Map` inside `SessionFeed`
(primary hash index on `insight.id`), and the 60 s response cache
inside `BloomreachDataSource` (secondary hash index on
`${toolName}:${JSON.stringify(args)}`). No B-tree, no range query, no
`ORDER BY`. Every read is `get(key)` or nothing.

## Structure pass — one axis across the two hash indexes

**Axis: "what is the key made of?"** (key composition)

```
Trace key composition across the two indexes

  Index                          Key                    Value
  ─────                          ───                    ─────
  primary (SessionFeed.insights) crypto.randomUUID()    Insight record
  secondary (response cache)     `${name}:${JSON(args)}` cached tool result
```

Two important seams:

  → **Primary index seam** — the key is a UUID. Random. Unordered.
    Perfect for a hash index; **useless for a range query.** "The 10
    most recent insights" cannot be answered by the key alone; you
    have to iterate the whole map and read each record's timestamp.

  → **Secondary index seam** — the key is a *composite string* of
    tool name plus a canonical JSON serialization of the args. This is
    a **derived hash key**: identical calls produce identical keys,
    which is the whole reason the cache works.

The **most load-bearing choice** here is that the response-cache key
uses `JSON.stringify(args)` directly. That means **key equality is
structural, not semantic** — `{a:1,b:2}` and `{b:2,a:1}` are
different cache keys even though they're the same tool call. That
matters when you look at cache hit rates: the agent has to build args
in a stable order or you get near-100% miss.

## How it works

### Move 1 — the pattern

You've used `Object.keys(obj).length` a thousand times. `Map.get(key)`
is the same underlying primitive: hash the key, jump to the bucket,
return the value. That's it. No traversal, no comparison chain, no
sort order.

```
The hash index — pattern skeleton

  key ──► hash function ──► bucket # ──► bucket
                                          │
                                          ▼
                                       [(k1, v1), (k2, v2), …]
                                          │
                                          ▼
                                       find k1 == key
                                          │
                                          ▼
                                       return v1

  cost: O(1) amortized for get / set / delete
  cost: O(N) for "give me all keys with some predicate"
  ordering: NONE (JS Map preserves insertion order but that's
            neither hash-address order nor sort order)
```

The kernel is four parts:

  1. **The hash function** — for `Map<string, …>` it's the JS engine's
     string hash. For the response cache the "hash" is deferred to
     the underlying `Map` too; the composite key is just built first.

  2. **The bucket table** — internal to the engine. You never see it.

  3. **The value slot** — the record itself.

  4. **What breaks without an index at all** — you'd have to scan every
     row for every read. `O(N)` per lookup. The whole DataSource
     `callTool` path is `O(1)` because of this primitive.

### Move 2 — walk the two indexes

Two distinct indexes, two distinct jobs. One diagram per, one code
anchor per, one boundary condition per.

#### Index 1 — the primary hash index (`SessionFeed`)

The nested-Map layout in `lib/state/insights.ts` gives us **two
hash-index probes per lookup**:

```typescript
// lib/state/insights.ts:16-23
function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);           // ← probe 1: outer Map
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);              // lazy create on first write
  }
  return s;
}

// lib/state/insights.ts:73-75
export function getInsight(sessionId: string, id: string): Insight | null {
  return state.get(sessionId)?.insights.get(id) ?? null;   // ← probe 2: inner Map
}
```

Read `getInsight` like SQL: `SELECT insight FROM feed WHERE
sessionId = ? AND insightId = ?`. The composite key is
`(sessionId, insightId)`. The layout resolves it as two nested hash
lookups.

```
Execution trace — one getInsight() call

  Step  variable state
  ────  ──────────────
  0     sessionId="abc-…", id="i-42"
        state = Map { "abc-…" ↦ SessionFeed{…}, "xyz-…" ↦ … }
  1     state.get("abc-…") → SessionFeed{ insights: Map{…}, … }
  2     .insights.get("i-42") → Insight{…}
  3     return
```

**Boundary condition:** if `sessionState()` had NOT been factored
out, and every write did `state.get(sid) ?? initEmpty()` inline, a
missing session on `getInsight` would return `null` (correct) — but
lazy-creating an empty `SessionFeed` on every failed lookup would
leak entries. The guard `state.get(sessionId)?.insights.get(id)` uses
optional chaining specifically to avoid that.

**What breaks if you drop the outer Map:** a single global
`Map<insightId, Insight>` would work for reads but violate the
per-session partitioning — the comment at `lib/state/insights.ts:5-8`
says the exact reason: module-level Maps "bleed between sessions"
and `putInsights` would `clear()` another user's feed. The partition
is enforced by the OUTER index.

#### Index 2 — the response cache (secondary hash on tool + args)

The 60 s response cache inside `BloomreachDataSource` is a secondary
hash index over tool calls. The key IS the derived index; the value
IS the memoized result.

```typescript
// lib/data-source/bloomreach-data-source.ts:122
private cache = new Map<string, { result: unknown; expiresAt: number }>();

// lib/data-source/bloomreach-data-source.ts:144-152
async callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  options: CallToolOptions = {},
): Promise<CallToolResult<T>> {
  const cacheKey = `${name}:${JSON.stringify(args)}`;         // ← derived key
  const ttl = options.cacheTtlMs ?? 60_000;

  if (!options.skipCache) {
    const cached = this.cache.get(cacheKey);                  // ← probe
    if (cached && cached.expiresAt > Date.now()) {            // TTL check
      return { result: cached.result as T, durationMs: 0, fromCache: true };
    }
  }
  // ... fall through to liveCall + write-through
}
```

This is a **secondary index with TTL eviction**. In DB terms it's
close to a materialized view: the cache stores derived data (the
tool result) keyed on a derived key (the composed string). Refresh
is TTL-based, not push-based.

```
Layers-and-hops — a cached vs uncached tool call

  agent code
      │
      │ callTool('get_metric', {scope:['mobile']})
      ▼
┌─ BloomreachDataSource.callTool ─────────────────┐
│  cacheKey = 'get_metric:{"scope":["mobile"]}'   │
│                                                  │
│  ┌─ index probe ─┐                              │
│  │ cache.get(k)  │  ── HIT ──► return in ~0ms   │
│  └───────┬───────┘                              │
│          │ MISS                                  │
│          ▼                                       │
│  liveCall(name, args)                            │
│    │                                             │
│    │  hop: MCP transport → Bloomreach API       │
│    │  (typical: 500ms–2s + rate-limit backoff)  │
│    ▼                                             │
│  cache.set(k, {result, expiresAt: now + ttl})   │
└─────────────────────────────────────────────────┘
```

**Boundary condition — cache poisoning:** the code explicitly skips
caching error results:

```typescript
// lib/data-source/bloomreach-data-source.ts:178-181
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}
```

Without that guard, a transient 500 or rate-limit response would
sit in the cache for 60 seconds and get returned to every subsequent
caller. The comment names it: "Don't cache error results — they
should not poison the cache."

**Boundary condition — key stability:** `JSON.stringify(args)` is
key-order-dependent. `stringify({a:1, b:2})` and `stringify({b:2,
a:1})` produce different strings. **The tool caller must produce
args in stable order** or the cache misses on every call. This isn't
guarded in code; it's an unspoken contract between the agent and the
cache.

**What breaks if you drop the cache:** every duplicate tool call
hits the live MCP endpoint. Given the 1 req/s proactive spacing and
the ~10 s rate-limit backoff, three duplicates can cost you 30
seconds of wall time on the same investigation. The cache is what
makes the 60 s route budget (`app/api/agent`) feasible.

### Move 2.5 — what a B-tree index would buy

The most useful sentence I can write here is what the code is
**intentionally not doing.** There is no B-tree because there is no
range query.

```
Comparison — hash-only today vs a hypothetical B-tree tomorrow

  TODAY (hash-only)                                B-TREE (hypothetical)

  getInsight(sid, id)  ── O(1) exact match         index on insight.timestamp
                                                    → "last 10 insights" is O(log N + 10)
  listInsights(sid)    ── O(N) iterate all                                     
                                                    range predicate on timestamp
  "top severity"       ── O(N) filter + sort       → O(log N + result-size)
                                                    range predicate on severity
```

The current `listInsights` (`lib/state/insights.ts:81-84`) already
does an O(N) iteration. That's fine at the scale of one session's
briefing (typically ≤ 10 insights per run). A B-tree would only pay
off if you started querying across many sessions or across many runs.

**When would you add one?** When the eval receipts folder grows past
a few hundred files AND the CI gate becomes the bottleneck. Then a
B-tree on `runId` (which is already timestamp-shaped) would replace
the `readdirSync + suffix-match + read + parse` chain in
`eval/gate.eval.ts:64-72` with an ordered scan.

### Move 3 — the principle

**An index is a promise about the shape of your queries.** Hash
indexes promise "you only ever ask exact-match questions." B-trees
promise "you might ask ordered or range questions." You choose the
index based on what you're going to ask.

The reason this repo has only hash indexes is that every query it
runs IS exact-match: "give me this session's SessionFeed," "give me
this cached tool result." The moment the app grows a "top 10 X" or
"last 100 Y" view, the choice changes. Until then, hashes are
strictly cheaper.

## Primary diagram — the two hash indexes side by side

```
The two indexes in blooming_insights — both hash, different jobs

  ┌── Primary index: SessionFeed (persistence) ─────────────────┐
  │                                                              │
  │   outer Map<sessionId, SessionFeed>                          │
  │      │                                                       │
  │      ▼                                                       │
  │   inner Map<insightId, Insight>          ← two-level probe   │
  │                                                              │
  │   role:      row lookup by (sessionId, id)                   │
  │   eviction:  never (until process death)                     │
  │   key type:  crypto.randomUUID string                        │
  │   partition: outer level enforces per-user isolation         │
  └──────────────────────────────────────────────────────────────┘

  ┌── Secondary index: response cache (memoization) ────────────┐
  │                                                              │
  │   Map<string, { result: unknown; expiresAt: number }>       │
  │                                                              │
  │   role:      short-lived memoization                        │
  │   eviction:  TTL (60 s default)                             │
  │   key type:  `${toolName}:${JSON.stringify(args)}`         │
  │   guard:     skip errors — do not poison the cache          │
  │   fragility: JSON.stringify is key-order-dependent          │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where does the "hash first, B-tree later" instinct come from?**
Redis. The whole point of Redis is hash-based KV with optional sorted
sets when you need ordering. Postgres flips it: everything is a
B-tree by default (`CREATE INDEX ...` builds a B-tree unless you say
`USING HASH`). The two systems represent the two ends of the
tradeoff: Redis says "exact match is 99% of what you do, optimize
for that"; Postgres says "you don't know the query patterns yet,
give yourself the flexibility."

This repo is closer to the Redis end — everything is exact-match by
key, so hash is the right primitive. If it were a query engine
running arbitrary predicates over user data, it would look more like
Postgres and every field would get a B-tree.

**When indexes become dangerous:** every additional index costs a
write. Insert one row → update N indexes. The response cache is
"free" today because there's exactly ONE cache path per call site.
If you added, say, a per-user response cache AND a global response
cache, every tool call would write to both. That's when index
selection starts to matter.

## Interview defense

**"What indexes does this system have?"**

Answer: *"Two, both hash. The primary is the nested `Map<sessionId,
SessionFeed>` where `SessionFeed` itself holds three inner Maps —
that's a two-level hash probe by (sessionId, insightId). The
secondary is the 60-second response cache inside
`BloomreachDataSource`, keyed on a composite string of tool name
plus a canonical serialization of the args. No B-trees, because no
query in this codebase is ordered or range-based."*

**"Why is the response-cache key `JSON.stringify(args)` and not
something more principled?"**

Answer: *"Speed of implementation, mostly, and the tradeoff was
accepted deliberately. The downside is that stringify is
key-order-dependent, so callers have to produce args in a stable
order or the cache misses. A canonical-JSON library would fix that
at the cost of a dependency and a slightly slower key computation.
Given the args come from a small set of controlled call sites, the
simple version wins."*

**"What happens when the cache holds a bad result?"**

Answer: *"It doesn't, by design — there's an explicit guard at line
178 of the data source that skips caching any result with
`isError=true`. Without that guard, a transient rate-limit or 500
would sit in the cache for 60 seconds and poison every subsequent
lookup with the same args. The comment above the guard names the
reason: 'Don't cache error results — they should not poison the
cache.'"*

The load-bearing skeleton part interviewers routinely forget:
**the TTL eviction is per-key, not global.** Each entry has its own
`expiresAt`; there's no background sweep. Entries live in the map
forever until either overwritten or looked up post-expiration. On a
long-running process that touches many distinct args, this is a slow
memory leak. In practice the process cycles too quickly for it to
matter — but naming the boundary signals you looked at the code.

## See also

  → `01-database-systems-map.md` — the tier each index sits in
  → `02-records-pages-and-storage-layout.md` — the record shape the
    index points at
  → `04-query-planning-and-execution.md` — how the agent uses these
    indexes as it plans tool calls
