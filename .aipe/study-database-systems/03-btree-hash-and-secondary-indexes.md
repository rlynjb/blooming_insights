# B-tree, hash, and secondary indexes

*Index structures / Language-agnostic*

## Zoom out, then zoom in

You've built a hash map, and you've built a BST (`BinarySearchTree.ts`), and you know the difference: hash is `O(1)` exact-match, tree is `O(log n)` ordered — range scans, sort orders, prefix lookups. A real DB gives you both, plus B-trees, plus secondary indexes, plus multi-column composite ones. This repo has exactly one lookup structure: a hash map. This file walks the standard toolbox, then names what's here and what's `not yet exercised`.

```
  Zoom out — where lookups live

  ┌─ UI ─────────────────────────────────────────────────────┐
  │  card click → sessionStorage stash → route by insightId   │
  └────────────────────┬─────────────────────────────────────┘
                       │  insightId (PK)
  ┌─ Service ──────────▼─────────────────────────────────────┐
  │                                                          │
  │  ★ Map<insightId, Insight>          insights.ts:14         │ ← hash-only "PK index"
  │  ★ Map<"tool:args", cached result>  bloomreach-…:122      │ ← hash-only "query cache"
  │                                                          │
  │  no B-tree · no ordered index · no secondary index        │
  │                                                          │
  └────────────────────┬─────────────────────────────────────┘
                       │
  ┌─ Provider (Bloomreach) ▼─────────────────────────────────┐
  │  the real indexes are over there; opaque to us            │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** The whole "index strategy" in this repo is: everything is looked up by exact key, so hash maps everywhere. The only reason that works is that the read patterns *never* need ordering, prefix matches, or range scans. If that changes, you'd feel the missing indexes immediately.

## Structure pass

**Axis to hold constant: lookup shape — is this an exact-match, an ordered scan, or a prefix?**

```
  "what does the read want?" — traced across the app

  ┌─ read #1: feed render ──────────────────────────────────┐
  │  listInsights(sessionId)                                 │
  │    → iterate the entire per-session Map (no key filter)  │  → full scan, not indexed
  │    → returns [...s.insights.values()]                    │
  │      insights.ts:81-84                                   │
  └─────────────────────────────────────────────────────────┘
      ┌─ read #2: single-insight lookup ──────────────────────┐
      │  getInsight(sessionId, id)                             │
      │    → hash on sessionId, hash on id                     │  → PK-exact-match, indexed
      │      insights.ts:73-79                                 │
      └───────────────────────────────────────────────────────┘
          ┌─ read #3: cached tool call ─────────────────────────┐
          │  cache.get(`${name}:${JSON.stringify(args)}`)         │
          │    → hash on the string key                           │  → exact-match, indexed
          │      bloomreach-data-source.ts:144-152                │
          └───────────────────────────────────────────────────────┘
              ┌─ read #4: gate baseline lookup ─────────────────────┐
              │  readdirSync(RECEIPTS_DIR).filter(f.endsWith(runId))  │
              │    → filesystem scan filtered by suffix               │ → linear scan
              │      gate.eval.ts:64-66                               │
              └───────────────────────────────────────────────────────┘
```

Two exact-match hash lookups, two linear scans. The seam that flips the axis is **the outer collection boundary**: within a session, we index by PK; across sessions or across runIds, we scan. That's fine because the scan cardinality is always tiny (≤ 10 insights per session, ≤ 28 receipts on disk).

## How it works

### Move 1 — the mental model

Real databases give you a menu:

```
  the four workhorse index shapes

  hash index          B-tree              LSM tree            covering index
  ──────────          ──────              ────────            ──────────────
  O(1) exact           O(log n) range      write-optimized     avoids table lookup
  no ordering          ordered scans       tombstones+compact  index has all cols
  small keys           default in most     Cassandra, RocksDB  eliminates the heap
                       RDBMSes                                  read entirely
```

This repo picks *only* the leftmost column, and picks it twice: once for point-lookups of insights by id, once for point-lookups of MCP responses by `(tool, args)`. Everything else is either a full scan (small n) or a re-fetch (cache miss).

The kernel of a hash index:

```
  hash-index kernel — what has to be true for O(1) exact-match

  1. a key with a stable hash    ← primitives / strings work; objects need serialization
  2. a bucket array              ← the underlying storage
  3. collision resolution        ← chaining or open addressing
  4. equality check on hit       ← hash alone isn't enough; verify

  what breaks if you remove:
    key stability   → moved buckets, missed lookups
    equality check  → wrong-row returns (hash collision looks like a hit)
```

Every JS `Map` gives you those four for free. You never *choose* the hash function; you just get one.

### Move 2 — the primitives walked

**Primary-key hash index — the session Map.**

```ts
// lib/state/insights.ts:73-79
export function getInsight(sessionId: string, id: string): Insight | null {
  return state.get(sessionId)?.insights.get(id) ?? null;
}

export function getAnomaly(sessionId: string, id: string): Anomaly | null {
  return state.get(sessionId)?.anomalies.get(id) ?? null;
}
```

Two hash lookups per call: outer Map by sessionId, inner Map by insight id. Both `O(1)` average, both guaranteed by V8's `Map` implementation (hash table under the hood, with strict equality on collision).

Notice the failure mode: cold-start returns `null` for every id, because the outer Map is fresh. That's the point at which "no persistence" starts to look like a design choice with teeth — the client-side card-click flow in `app/page.tsx` stashes the whole `Insight` into `sessionStorage` (see `useInvestigation.ts`) so the investigation route can rebuild from the client if the server-side Map has vanished. The client is the fallback for the missing "durable PK index."

**Composite-key hash index — the response cache.**

```ts
// lib/data-source/bloomreach-data-source.ts:144-152
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

The key is `tool_name + serialized_args`. In DB terms this is a *composite covering index* over `(name, args)` where the "table" is `(name, args, result, expiresAt)` and the index IS the table (V8's Map, no heap lookup). Fields not in the key can't be queried; that's what "covering" means — every read is answered from the index alone.

The subtle correctness bit: `JSON.stringify(args)` is not canonical. `{a:1, b:2}` and `{b:2, a:1}` serialize differently and thus miss each other's cache entries. In practice this doesn't bite because agents build args objects the same way every time — same key order per tool. But if you ever refactored the arg-building order, you'd silently double your cache miss rate. That's a real-DB-people-forget-this-too failure mode, called out because the fix (canonical JSON, or a sorted-keys serializer) is one function away.

**Not an index at all — the ~1 req/s spacing.**

```ts
// lib/data-source/bloomreach-data-source.ts:190-205
private async liveCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  ...
}
```

Not an index — a *rate governor*. Included because it changes what the cache is for: not "avoid the network" but "avoid the multi-second penalty window." A cache hit here is worth 200-10,000ms depending on retry state, not just the round-trip time. That's why the 60s TTL is so long — one call being cachable is worth more than one hit.

**Full scan — feed render.**

```ts
// lib/state/insights.ts:81-84
export function listInsights(sessionId: string): Insight[] {
  const s = state.get(sessionId);
  return s ? [...s.insights.values()] : [];
}
```

Full iteration of the per-session inner Map. In DB terms this is a `SELECT * FROM insights WHERE session_id = ?` with no `ORDER BY` (return order is JS Map's insertion order — the order `putInsights` wrote them, which is the ranked order the monitoring agent produced). No secondary index because none is needed; the cardinality is 3-10 rows per session.

**Filesystem scan — the regression gate.**

```ts
// eval/gate.eval.ts:63-67
const candidateRunId = pickRunId(process.env.RUN_ID);
const files = readdirSync(RECEIPTS_DIR)
  .filter((f) => f.endsWith(`${candidateRunId}.json`))
  .sort();
if (files.length === 0) throw new Error(`No receipts for candidate runId ${candidateRunId}`);
```

`readdirSync` returns every filename in the receipts dir; the filter is a suffix match on the runId. That's `O(n)` in the number of receipts (28 today). If receipt count grew to 10k, the filter would still be fine because `endsWith` is trivial, but you'd want a *directory-per-run* layout instead (a filesystem-level "index"). Today the cost is negligible.

### Move 2 variant — the load-bearing skeleton

The minimum-viable "index layer" for this repo is exactly:

1. **The outer `Map<sessionId, SessionFeed>`.** Remove it and you're back to cross-session bleed (see `05-transactions-isolation-and-anomalies.md`).
2. **The inner `Map<insightId, Insight>`.** Remove it and every card-click has to re-run the briefing. The whole "click a card, see the investigation" flow depends on the PK lookup being cheap and correct.
3. **The `${name}:${JSON.stringify(args)}` cache key.** Remove it (or lose canonicality) and rate-limit retries dominate every briefing.

The rest — `getAnomaly` as a distinct lookup, `listInsights` as a values-iterator, the receipt-file scan — is convenience, not skeleton.

### Move 3 — the principle

**Index the exact-match reads; scan the ordered ones only if `n` stays small.** The repo commits to only having small-`n` scans (a session's insights, a run's receipts) and hash indexes the rest. That's fine at this scale. The interesting question is where the boundary lives — how large can `n` get before you'd add a secondary index? In this repo the answer is "not applicable, we don't do that kind of read." That's a shape decision, not a laziness one.

## Primary diagram

```
  Every index in this repo, one picture

  ┌─ hash-index #1: session-keyed feed ───────────────────────┐
  │                                                            │
  │     sessionId ──► Map<sessionId, SessionFeed>              │
  │                        │                                   │
  │                        ▼                                   │
  │              SessionFeed { insights, anomalies, ... }      │
  │                        │                                   │
  │        insightId ──►   ▼                                   │
  │                  Map<insightId, Insight>                   │
  │                        │                                   │
  │                        ▼                                   │
  │                    Insight (row)                           │
  │                                                            │
  │   two hash hops, O(1) each                                 │
  │   lib/state/insights.ts:14, 73-84                          │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ hash-index #2: BloomreachDataSource TTL cache ───────────┐
  │                                                            │
  │     (toolName, argsObj)                                    │
  │           │                                                │
  │           ▼                                                │
  │     `${name}:${JSON.stringify(args)}`  ─── cache key       │
  │           │                                                │
  │           ▼                                                │
  │     Map<key, {result, expiresAt}>                          │
  │           │                                                │
  │           ▼                                                │
  │     result  ← if expiresAt > now                           │
  │                                                            │
  │   one hash hop, O(1)                                       │
  │   lib/data-source/bloomreach-data-source.ts:122, 144-152   │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ full scans (no index) ───────────────────────────────────┐
  │                                                            │
  │     listInsights(sessionId)                                │
  │       → [...s.insights.values()]                           │
  │       → cardinality ≤ 10 per session                       │
  │                                                            │
  │     gate.eval.ts filesystem scan                           │
  │       → readdirSync + endsWith(runId)                      │
  │       → cardinality ≤ 28 today                             │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The reason to reach for a B-tree in a real DB is *ordered access* — `ORDER BY created_at`, `WHERE score BETWEEN a AND b`, `LIKE 'prefix%'`. This repo doesn't do any of that. The insights are already ranked by the agent that produced them (severity, then agent-picked order); the receipts are looked up by exact runId; the tools by exact name-plus-args. Ordering has nowhere to be useful, so a B-tree would just be code you'd have to maintain.

If the app grew a "search across all users' insights" feature, or a "top 100 anomalies by change % this week" surface, you'd hit two walls at once: no cross-session index (the outer key is sessionId, not category or timestamp), and no ordered structure to `LIMIT` cheaply. That's the moment to introduce Postgres. Not before.

### `not yet exercised`

- **B-tree / LSM-tree / any ordered index.** No sort-order query anywhere in the code today.
- **Secondary index (e.g. by severity, by category, by timestamp).** No non-PK lookup exists.
- **Composite index over more than two columns.** The cache key is composite over `(name, args)` but flat-serialized.
- **Covering index that avoids a heap lookup.** N/A — the Map values ARE the rows; nothing to "cover" past.
- **Index-only scans, index selectivity, cardinality estimation.** No planner, no estimator.
- **Bloom filters, hash indexes over disk pages.** In-memory only.

## Interview defense

**Q: "How does a lookup by insight id resolve here, from click to render?"**

Model answer: "Two hash hops on the server, plus a client-side fallback. Client stashes the whole `Insight` into `sessionStorage` on card-click (see `useInvestigation.ts`). Route lands on `app/investigate/[id]/page.tsx`, hits `/api/agent`. Server does `getAnomaly(sessionId, id)` which is `state.get(sessionId)?.anomalies.get(id)` at `insights.ts:73-79` — outer Map by sessionId, inner Map by id, O(1) each. If both hit, we investigate. If either misses (warm-start wiped the outer map, say), the route falls back to the client-provided `?insight=` param — `resolveAnomaly` in `app/api/agent/route.ts:35-49` re-derives from that. The client is the durable-index fallback for the missing server-side persistence."

Diagram to sketch: two-hop hash lookup with the client-stash fallback arrow.

**Q: "What's the failure mode of the cache key?"**

Model answer: "The key is `${name}:${JSON.stringify(args)}` at `bloomreach-data-source.ts:144`. `JSON.stringify` isn't canonical — same args in different key order serialize differently. So if two call sites built args objects with different key insertion order, they'd cache-miss each other silently. In practice they don't, because the agents build args from the same tool-schema-driven code path every time. But it's the kind of bug that lands as a *performance regression* rather than a wrong-answer regression — the rate-limit retries start dominating and nobody knows why. The fix is a sorted-keys serializer or a canonical JSON stringify; one function change."

Anchor: cache key is a hash of a non-canonical serialization — same args, different order, different key.

**Q: "Would you add Postgres?"**

Model answer: "Not for the current read patterns. Every real query is either a PK lookup (small n, session-scoped) or a batch scan (tiny n). Postgres wouldn't make either faster; it'd just add operational surface. The moment I'd introduce it: when a cross-session read pattern appears — 'search across all users' anomalies,' 'trend a metric over the last 90 days of insights' — because that's the moment the outer session key stops being the right partition and you'd want a secondary index on category or timestamp. Until then, `Map` is the right primitive."

Anchor: cross-session read is the trigger for a real database.

## See also

- `01-database-systems-map.md` — where these indexes sit in the whole picture.
- `02-records-pages-and-storage-layout.md` — the rows these indexes point at.
- `04-query-planning-and-execution.md` — how the planner would use these (spoiler: no planner here).
- `07-wal-durability-and-recovery.md` — what makes the "warm-start wipes the index" cost tolerable.
