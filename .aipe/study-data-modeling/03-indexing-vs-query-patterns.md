# 03 — Indexing vs query patterns

**Access-pattern-shaped storage · Industry standard**

## Zoom out, then zoom in

The classical question — *do the indexes match the queries the app
actually runs?* — usually means "is there a B-tree on the column we
filter by." In **blooming_insights** the question is the same but the
answer is `Map.get(id)`. There's no DB, so there's also no `EXPLAIN`. The
question worth asking is whether the **Map shape** matches the **access
shape**.

```
  Zoom out — every read path in the app

  ┌─ UI ──────────────────────────────────────────────────────────────┐
  │  feed page         → list all insights for this session           │
  │  investigate/[id]  → get one insight + its diagnosis              │
  │  recommend/[id]    → get one insight + its recommendations        │
  │  StatusLog         → stream new AgentEvents as they arrive        │
  └──────────────────────┬────────────────────────────────────────────┘
                         │  fetch → session cookie → server route
  ┌─ State layer ─────── ▼──── ★ THIS CONCEPT ★ ──────────────────────┐
  │                                                                   │
  │   Map<sessionId, SessionFeed>                                     │ ← we are here
  │       ├─ insights:        Map<insightId, Insight>                 │
  │       ├─ investigations:  Map<insightId, Investigation>           │
  │       └─ anomalies:       Map<insightId, Anomaly>                 │
  │                                                                   │
  │   Map<insightId, AgentEvent[]>  (event log cache)                 │
  │                                                                   │
  └──────────────────────┬────────────────────────────────────────────┘
                         │  cache miss
  ┌─ Substrate ──────────▼────────────────────────────────────────────┐
  │  EQL queries — substrate handles its own indexing                 │
  │  ~1 req/s rate limit; 60s response cache                          │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Two layers run "queries" — the in-process Maps (which serve
every UI read in O(1)) and the substrate (which the agents query via EQL,
where Bloomreach handles indexing). The state layer's Maps **are** the
indexes; the substrate's indexes are not the app's problem. The hot
question for the audit: are the keys right, and is the access pattern
truly key-based?

---

## Structure pass — the axis is "how is this fetched?"

```
  Trace ONE axis — "what's the key for this read?" — across layers

  ┌─ access path ──────────────────────┐
  │  list all insights for a session   │   → key = sessionId
  │  get one insight by id             │   → key = (sessionId, insightId)
  │  get diagnosis for an insight      │   → key = (sessionId, insightId)
  │  stream events as they arrive      │   → key = (sessionId, insightId)
  │  capture demo snapshot             │   → key = insightId (single-tenant)
  └────────────────────────────────────┘

  every read is a primary-key lookup OR a full scan of one session's data.
  no read uses a secondary attribute as the key.
  → a Map is sufficient.
```

The seam to watch: **session boundary.** Reads inside one session are
trivial; cross-session aggregation (e.g. "show me all critical insights
across all users today") would not be a Map lookup — it'd be a full scan
of every session's sub-map. The audit notes this; today the app has no
cross-session read.

---

## How it works

### Move 1 — the mental model

You know how a JS `Map<string, T>` is basically a hash table — `get(key)`
is O(1), `[...map.values()]` is O(n), `delete(key)` is O(1)? That's the
whole index story here. Every access pattern the app needs reduces to one
of those three operations.

```
  The "Map IS the index" pattern

       ┌─ access pattern ─────┐    ┌─ Map operation ──┐
       │  by id               │ ──►│  .get(id)        │  O(1)
       │  list this session   │ ──►│  [...values()]   │  O(n) per session
       │  write a new value   │ ──►│  .set(id, v)     │  O(1)
       │  clear last briefing │ ──►│  .clear()        │  O(n) sub-map
       │  delete one session  │ ──►│  .delete(id)     │  O(1)
       └──────────────────────┘    └──────────────────┘

  No access pattern in the codebase asks for:
    - "all insights with severity = critical" (no SCAN BY ATTRIBUTE)
    - "all sessions modified in the last hour" (no RANGE OVER TIMESTAMPS)
    - "insights sorted by change.value descending" (no SORTED INDEX)
```

The Map is **enough** precisely because every read is keyed. The day the
product asks "show me a leaderboard of which metrics moved the most this
week," the Map stops being enough — you'd need a secondary structure or
a real DB. See `06-access-patterns-and-storage-choice.md`.

### Move 2 — the access patterns, one at a time

#### **Read: feed page (`listInsights(sessionId)`)**

The feed renders every insight for the current session. The read is
**one Map.get + one spread of its values**:

```typescript
// lib/state/insights.ts:81-84
export function listInsights(sessionId: string): Insight[] {
  const s = state.get(sessionId);
  return s ? [...s.insights.values()] : [];
}
```

Annotation:

- **L82 `state.get(sessionId)`** — O(1) hash lookup. The `state` Map is
  the *outer* map; its key is the session UUID from the `bi_session`
  cookie.
- **L83 `[...s.insights.values()]`** — O(n) where n is the number of
  insights *in this session* (typically 5-15 for a briefing). The order
  is insertion order (Map iteration is ordered in JS).

```
  Feed read flow

  Browser           Route                State layer
    │                │                       │
    │  GET /         │                       │
    │ ──────────────►│  bi_session cookie    │
    │                │ ──────────────────────►  state.get(sessionId)   O(1)
    │                │                       │      │
    │                │                       │      ▼ SessionFeed
    │                │                       │  [...insights.values()] O(n)
    │                │ ◄─────────────────────│
    │ ◄──────────────│  Insight[]            │
```

What this gets right: the **outer Map is per-session** specifically so two
warm requests in the same Vercel instance don't iterate each other's
data. Without that scoping, `[...insights.values()]` would return *every
user's* insights from every concurrent session — the exact bleed comment
above `state` warns against (`lib/state/insights.ts:7-13`).

#### **Read: investigate page (`getInsight(sessionId, id)`)**

Two-level lookup, both O(1):

```typescript
// lib/state/insights.ts:73-75
export function getInsight(sessionId: string, id: string): Insight | null {
  return state.get(sessionId)?.insights.get(id) ?? null;
}
```

The compound key `(sessionId, insightId)` is split across **two nested
Maps** rather than concatenated into a single key. This is more code than
`state.get(\`${sessionId}:${id}\`)` would be, but it matches how the data
naturally clusters — a session owns a set of insights; clearing the
session clears them all.

```
  Two-level Map = a tree-shaped index

  state: Map<sessionId, SessionFeed>
   │
   ├─ session-A ─── insights ─── { id1: Insight, id2: Insight, ... }
   │                anomalies ── { id1: Anomaly, id2: Anomaly, ... }
   │                investigations ── { ... }
   │
   └─ session-B ─── insights ─── { id3: Insight, ... }

  benefit: O(1) "drop this session's data" via .delete(sessionId)
  cost:    O(1) lookup is now TWO chained .get() calls
```

#### **Write: end-of-briefing (`putInsights(sessionId, items)`)**

This is the only multi-write operation in the state layer. It clears and
re-fills the session's sub-maps:

```typescript
// lib/state/insights.ts:57-71
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  // Replace the previous briefing for THIS session — each run IS the current
  // feed, not an addition. Without clearing, a warm serverless instance (or a
  // long-running dev server) accumulates stale insights from earlier runs, so
  // the feed shows yesterday's anomalies alongside today's. Investigations are
  // keyed separately and untouched here. Only this session's sub-maps are
  // cleared — never the outer map, never another session's feed.
  const s = sessionState(sessionId);
  s.insights.clear();
  s.anomalies.clear();
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

The clear-then-fill is the **closest thing this codebase has to a
transaction**. It's not atomic (no rollback if `set` throws midway), but
it *is* isolated per session — the comment makes the boundary explicit.
See `04-transactions-and-integrity.md` for the integrity story.

#### **Read: substrate (the actual "query" layer)**

The agents issue EQL queries against the substrate. The "indexing" at this
layer isn't the app's problem — Bloomreach owns the event store and its
indexes. What the app **does** own is the **60s response cache** in
`BloomreachDataSource`:

```typescript
// lib/data-source/bloomreach-data-source.ts:122-152
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  ...

  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    options: CallToolOptions = {},
  ): Promise<CallToolResult<T>> {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
    const ttl = options.cacheTtlMs ?? 60_000;

    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result as T, durationMs: 0, fromCache: true };
      }
    }
    ...
```

The cache key is `name + JSON.stringify(args)`. This is the **deduplication
index** for repeated tool calls during a single briefing — the monitoring
agent and diagnostic agent both call `get_event_schema` early, and the
second call is a Map hit instead of a round trip.

```
  Substrate cache as a dedup index

       ┌─ monitoring agent ─┐                    ┌─ diagnostic agent ─┐
       │  get_event_schema  │                    │  get_event_schema  │
       └─────────┬──────────┘                    └─────────┬──────────┘
                 │                                         │
                 │  cacheKey = "get_event_schema:{...}"    │
                 ▼                                         ▼
       ┌──────────────────────────────────────────────────────────┐
       │  cache.get(cacheKey)                                     │
       │    miss → liveCall → cache.set(key, result, ttl=60s)     │
       │    hit  → return immediately, fromCache:true             │
       └──────────────────────────────────────────────────────────┘
```

The 60s TTL is the load-bearing parameter. Bloomreach rate-limits at ~1
req/s globally per user; without a cache, a single briefing would
re-query the same schema 4-5 times and burn the rate budget.

#### **Read: investigation cache (file-backed in dev)**

The `getCachedInvestigation` function is the only read with a *three-tier
fall-through* in the repo:

```typescript
// lib/state/investigations.ts:22-28
export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
  if (mem.has(insightId)) return mem.get(insightId)!;
  const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;
  if (fromFile) return fromFile;
  const fromDemo = readJson(DEMO_FILE)[insightId];
  return fromDemo ?? null;
}
```

Read order — try memory, fall through to the dev file, fall through to the
committed demo. The "index" here is the same `insightId` key across three
storage tiers; the function abstracts the tier choice from the caller.

```
  Three-tier fall-through

  ┌─ tier 1 ────────────┐
  │  in-process Map     │   O(1) — typical case during a session
  │  (mem)              │
  └──────┬──────────────┘
         │  miss
  ┌──────▼──────────────┐
  │  .investigation-    │   reads the WHOLE file then indexes by key
  │   cache.json (dev)  │   O(file) — not great, but dev-only
  └──────┬──────────────┘
         │  miss
  ┌──────▼──────────────┐
  │  demo-investigations│   reads the WHOLE file (3,487 lines)
  │   .json (committed) │   O(file) — fine for demo (10 fixed insights)
  └─────────────────────┘
```

The audit flags one inefficiency: `readJson(CACHE_FILE)` and
`readJson(DEMO_FILE)` re-parse the entire JSON file on **every read**.
For dev with a handful of cached investigations that's fine; if the cache
grew to thousands, parsing 100KB+ JSON per request would show up in
flamegraphs. The mitigation is to lift the parse into module init —
trivial when needed.

### Move 3 — the principle

**The right "index" is whatever lets every read be O(1) in the access
shape the product actually has.** Here that's a per-session Map, because
every access is keyed by `(sessionId, insightId)`. The day the product
grows a "show me critical insights across all users this hour" view, the
Map stops being enough — that's a `WHERE severity = 'critical' AND
timestamp > NOW() - 1 hour` query, which needs either a sorted index or
a real query engine.

The generalisation: start with the access pattern, then choose the
storage shape. Most codebases get this backwards — they pick PostgreSQL
because that's the default, then discover their access pattern is 100%
key-based and they're paying the cost of relational semantics for
nothing. **blooming_insights** does it right: the access pattern is
trivially keyed, so a `Map` is the entire data layer.

---

## Primary diagram

Every "query" in the app and how it gets answered.

```
  Indexes vs queries — the full map

  ┌─ UI access pattern ──────────────┬─ data path ────────────────────────────────┐
  │                                  │                                            │
  │  feed: list all insights         │  state.get(sessionId).insights.values()    │
  │                                  │  O(1) + O(n)                               │
  │                                  │                                            │
  │  /investigate/[id]: one insight  │  state.get(sessionId).insights.get(id)     │
  │                                  │  O(1) + O(1)                               │
  │                                  │                                            │
  │  /recommend/[id]: investigation  │  state.get(sessionId).investigations       │
  │                                  │  O(1) + O(1)                               │
  │                                  │                                            │
  │  StatusLog: stream events        │  getCachedInvestigation(id) → 3-tier       │
  │                                  │  mem O(1) → file O(file) → demo O(file)    │
  │                                  │                                            │
  │  agent loop: query substrate     │  BloomreachDataSource.callTool             │
  │                                  │  cache.get(name+args) O(1) → liveCall      │
  │                                  │                                            │
  │  (not exercised) cross-session   │  WOULD need: iterate every sub-map         │
  │  aggregation                     │  O(sessions × insights/session)            │
  │                                  │  → buildable target: a real DB             │
  │                                  │                                            │
  └──────────────────────────────────┴────────────────────────────────────────────┘

  Every supported access pattern is O(1) or O(n-in-this-session).
  No N+1 issue today because no read joins across sessions.
```

---

## Elaborate

Where this comes from: the "right structure matches access pattern" rule
is older than DBs. It's why `std::vector` exists alongside `std::list`,
why DynamoDB asks you to design a *partition key* before you write any
data, why Redis offers half a dozen structures (`SET`, `ZSET`, `HASH`,
`LIST`, `STREAM`) — each one is optimal for one access shape.

The seam to **system design**: the choice to keep state in process memory
is a system-design call (no DB, no Redis, no Dynamo). The choice of `Map`
vs `object` vs `Set` for that in-memory state is data modeling. See
`06-access-patterns-and-storage-choice.md` for the system-design
boundary.

What this codebase consciously doesn't do — and is right not to:

- **No secondary indexes.** No "give me all insights with
  severity=critical." If that read appeared, the right move would be a
  second Map keyed by severity, kept in sync by the same writer
  (`putInsights`). Until then, paying for it is waste.
- **No range queries.** No "insights from the last hour." If that read
  appeared, you'd want either a sorted structure or a real DB.
- **No JOINs.** The two-level Map *is* the join — every consumer holds
  the join key (`insightId`) and follows it across maps.

What to read next: `04-transactions-and-integrity.md` walks how multi-Map
writes stay coherent without a transaction primitive.

---

## Interview defense

**Q: "How do you make sure your queries hit indexes?"**

Verdict first: every read in the codebase is a primary-key Map lookup, so
the question doesn't arise — there's no query planner to outsmart. The
state layer is structured around the access pattern: a per-session outer
Map, three keyed inner Maps (insights, investigations, anomalies). Every
UI page reads by `(sessionId, insightId)`; both lookups are O(1).

```
  the answer, sketched

  state: Map<sessionId, SessionFeed>          ← outer Map
   │                                            ★ scoped per user
   ├─ session-A ── { insights:        Map<insightId, Insight> }
   │              { investigations:   Map<insightId, Investigation> }
   │              { anomalies:        Map<insightId, Anomaly> }
   │
   └─ session-B ── { ... }

  feed read:          state.get(sid).insights → [...values()]
  investigate read:   state.get(sid).insights.get(id)
  both O(1) chained.
```

Anchor: "the load-bearing piece is the *outer* Map being per-session —
without that scoping, listing one user's insights would iterate every
user's data in a warm serverless instance."

**Q: "Where would this design break?"**

Verdict first: the day the product wants cross-session aggregation —
"show me all critical insights across all customers today." That's a
`WHERE severity = 'critical'` over every session's sub-map, which is a
full scan with no index to help. The Map shape stops being right; you'd
move to Postgres (or DynamoDB with a GSI).

```
  the access pattern that breaks the Map

  current pattern               cross-session pattern
  ─────────────────             ─────────────────────
  by (sessionId, insightId)     by attribute (severity)
            │                            │
            ▼                            ▼
        Map.get(id)              ITERATE every session,
        O(1)                     iterate every insight
                                 O(sessions × insights/session)
                                      ▲
                                      │
                                 → secondary index or real DB
```

Anchor: "the access pattern is the design input — the moment that input
changes, the storage shape has to change with it. I'd reach for a real
DB the day cross-session reads appeared, not before."

---

## See also

- [`01-the-data-model-and-its-shape.md`](./01-the-data-model-and-its-shape.md)
  — the entities the Maps store
- [`04-transactions-and-integrity.md`](./04-transactions-and-integrity.md)
  — how multi-Map writes stay consistent without a transaction
- [`06-access-patterns-and-storage-choice.md`](./06-access-patterns-and-storage-choice.md)
  — when the access pattern would force you off Maps
- [`audit.md`](./audit.md) — checklist with this file's findings
