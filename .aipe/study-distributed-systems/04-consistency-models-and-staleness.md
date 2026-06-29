# Consistency models and staleness

**Industry name:** read-your-writes consistency, TTL-bounded staleness, monotonic reads · **Type:** Industry standard vocabulary, applied minimally

## Zoom out, then zoom in

Verdict first: there are exactly two places staleness can bite this repo, and one of them is per-instance memory.

```
  Zoom out — where staleness lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  insights feed, investigation pages                       │
  └──────────────────────────────────────────────────────────┘

  ┌─ Service layer — Vercel serverless ──────────────────────┐
  │                                                           │
  │  per-instance state:                                      │
  │    • insights/investigations Maps  ← session-scoped       │
  │    • schema cache (`cached`)        ← process-scoped      │ ← staleness lives here too
  │    • BloomreachDataSource cache     ← 60s TTL             │ ← AND here
  │                                                           │
  └──────────────────────────────────────────────────────────┘
                              │
  ┌─ Provider layer ─────────▼───────────────────────────────┐
  │  Bloomreach loomi-MCP — single source of truth            │
  │  No replication on our side; no eventual consistency       │
  │  concerns from a replica lag                              │
  └──────────────────────────────────────────────────────────-┘
```

The two stale-data risks:

1. **The 60s response cache.** A metric you just queried, then queried again 30s later, returns the *first* answer. Bounded staleness — capped at 60s — but real.
2. **The per-instance memory split.** Two Vercel instances see different `insights` Maps. A briefing run on instance A leaves an investigation lookup on instance B with no anomaly to investigate. That's where the `?insight=` URL param exists — it's the workaround.

Most of the heavy distributed-systems consistency vocabulary (linearizability, causal consistency, eventual consistency with conflict resolution, CRDTs) is **Case B — not exercised**. There's no replica, no second writer, no concurrent update path. The vocabulary is here so you can defend the absence.

## Structure pass

### Axis: what does "freshness" mean at this layer?

```
  Trace "freshness" across the stack

  Browser              — wants: the data as of "now I clicked Refresh"
                       — gets: as of the last NDJSON event

  /api/briefing route  — wants: the data as of THIS request
                       — gets: a mix — schema is process-lifetime stale;
                                       each tool call is up to 60s stale

  BloomreachDataSource — wants: as of `expiresAt`
                       — gets: deterministic — TTL-bounded by construction

  Bloomreach loomi-MCP — wants: the truth
                       — gets: the truth (single source)
```

The axis-answer differs at each layer. The interesting flips:

- **At the cache boundary** — `now I clicked Refresh` translates to `up to 60s stale` for any read repeated within the window.
- **At the per-instance boundary** — what one instance sees in its `insights` Map is invisible to another instance. The `?insight=` URL param threads the Insight ITSELF across instances rather than its id, because the id-to-insight lookup is per-instance.

### Seams (load-bearing boundaries)

- `BloomreachDataSource.cache` lookup ↔ live call — drop the cache and there's no staleness; add the cache and you trade freshness for cost. The default 60s TTL is the chosen point.
- `resolveAnomaly` (`app/api/agent/route.ts:35`) is the ↔ between an `insightId` URL param and the actual Anomaly to investigate. It tries three sources in order: client-passed `?insight=` blob, per-instance Map, demo snapshot — a deliberate hedge against the per-instance staleness problem.
- The `bi_session` cookie ↔ the per-session sub-maps in `lib/state/insights.ts:14`. Same instance + same session = consistent view. Different instance = empty view.

### Layered decomposition

```
  "How does staleness propagate?" — held constant

  ┌─ Bloomreach ─────────────────────────────────────┐
  │  the data changes when business events happen     │
  │  (a customer buys, a campaign launches)           │
  └────────────────────┬─────────────────────────────┘
                       │  → up to 60s of "cache holds the old answer"
  ┌─ BloomreachData ───▼─────────────────────────────┐
  │  Source.cache: same args → same answer for 60s    │
  └────────────────────┬─────────────────────────────┘
                       │  → no cross-call staleness once the cache is bypassed
  ┌─ Agent loop ───────▼─────────────────────────────┐
  │  consumes the cache result as ground truth        │
  └────────────────────┬─────────────────────────────┘
                       │  → "the agent's reasoning was based on the cache snapshot"
  ┌─ Insight in feed ──▼─────────────────────────────┐
  │  insight.timestamp = when the agent ran           │
  │  evidence carries the actual data the agent saw   │
  └──────────────────────────────────────────────────┘
```

The contrast: at the lowest layer, staleness is "the cache might be 30s out of date." At the highest layer, it's "the briefing reflects the workspace as of the timestamp on the card." The vocabulary changes (epsilon-time, snapshot, evidence) but the underlying question is the same.

## How it works

### Move 1 — the mental model

You know how `useState`'s value is whatever was last set, even if the database has since changed? Same shape: when you cache a tool result for 60s, the *answer* the agent gets is whatever was returned the first time, regardless of what Bloomreach now says. That's not a bug — it's the contract. The model name is **bounded staleness**: not "fresh," not "eventually consistent in the limit," but "guaranteed not more than 60s out of date."

```
  Staleness model — the picture

      t=0       BloomreachDataSource.callTool(eql_q1, args) → MISS → liveCall
                cache.set(key, R1, expiresAt: t=60)
                returns R1

      t=15      same args → HIT → returns R1 (15s stale)

      t=30      same args → HIT → returns R1 (30s stale)
                (meanwhile, Bloomreach has the real R2)

      t=61      same args → MISS (expired) → liveCall → returns R2
                cache.set(key, R2, expiresAt: t=121)

  the user can read R1 anywhere in [t=0, t=60); after that, R2.
  monotonic reads? NO — a different instance with no cache could return R2 at t=20.
```

The "no monotonic reads" arrow is the load-bearing surprise. Same user, two browser tabs, two Vercel instances → instant inconsistency window during the cache TTL.

### Move 2 — walk the parts

#### Part: the cache is the only "staleness" knob

The TTL is the entire model. It's set per call (`cacheTtlMs` option, default 60_000 — `lib/data-source/bloomreach-data-source.ts:145`) and applies uniformly. We don't have a more granular model — no "always-fresh for execute_analytics_eql, never-stale for list_projects" matrix. The 60s default was chosen to absorb the worst case of a re-mount loop without making the data feel stale to a human watching a feed update.

```ts
// lib/data-source/bloomreach-data-source.ts:139
async callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  options: CallToolOptions = {},
): Promise<CallToolResult<T>> {
  const cacheKey = `${name}:${JSON.stringify(args)}`;
  const ttl = options.cacheTtlMs ?? 60_000;
  // …
}
```

#### Part: per-instance state IS a consistency surface

Vercel's serverless instances are independent. The session-scoped state map (`lib/state/insights.ts:14`) keeps:

```ts
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};

const state = new Map<string, SessionFeed>();
```

That `state` lives in the process. A briefing run that fills the Map on instance A leaves instance B's Map empty, even for the same session cookie. The investigation route knows this and threads the workaround:

```ts
// app/api/agent/route.ts:35
function resolveAnomaly(sessionId: string, insightId: string, insightParam?: string | null): Anomaly | null {
  if (insightParam) {                                  // ← preferred: client passed the blob
    try {
      const i = JSON.parse(insightParam) as Insight;
      if (i && typeof i.metric === 'string' && i.change && Array.isArray(i.scope) && i.severity) {
        return insightToAnomaly(i);
      }
    } catch { /* … */ }
  }
  const a = getAnomaly(sessionId, insightId);          // ← fallback: same-instance lookup
  if (a) return a;
  const i = getInsight(sessionId, insightId);
  if (i) return insightToAnomaly(i);
  try {
    if (existsSync(DEMO_FILE)) { /* … */ }              // ← final fallback: demo snapshot
  } catch { /* … */ }
  return null;
}
```

The `?insight=` query param is the cross-instance consistency hack. The feed page stashes the full Insight in `sessionStorage`, then writes `?insight=<JSON>` into the URL when navigating to investigate — so the investigate route's instance has the data it needs regardless of which instance fielded the briefing.

```
  Execution trace — cross-instance investigate flow

  client                                    instance A          instance B
  ──────                                    ──────────          ──────────
  GET /api/briefing      ──────────────►   build feed,
                                            putInsights(sid, …)
                         ◄────────────── NDJSON insight events

  click InsightCard → stash JSON in sessionStorage

  GET /api/agent?insightId=xyz&insight=<JSON>  ─────────►        resolveAnomaly:
                                                                  insightParam → JSON.parse
                                                                  → run investigation
                                                                  (NEVER reads its empty Map)
```

This is "session affinity by convention" — the *client* carries enough state that any instance can serve any request. Industry: this is the same idea as `Cookie: jwt=…` in a stateless API, except the cookie is in the URL because it's only needed for this one hop.

#### Part: insight.timestamp pins the snapshot

`lib/state/insights.ts:26`:

```ts
export function anomalyToInsight(a: Anomaly): Insight {
  const id = crypto.randomUUID();
  // …
  return {
    id,
    timestamp: new Date().toISOString(),                 // ← when the agent ran
    severity: a.severity,
    // …
    evidence: a.evidence,                                 // ← the data the agent SAW
    // …
  };
}
```

Two staleness anchors on every Insight: `timestamp` (when the briefing ran) and `evidence` (the actual tool result the agent based the conclusion on). The UI doesn't promise the data is fresh as of right-now; it promises the briefing was generated at that timestamp from those exact tool calls. That's a different consistency contract, and it's the honest one.

#### Part: the schema cache as monotonic-read violation

Process-lifetime memoization (`lib/mcp/schema.ts:190`) holds the schema for as long as the Node process lives:

```ts
if (cached) return cached;
```

If Bloomreach adds a new event type after the instance warmed up, the agents won't see it until the instance restarts. This is a process-lifetime staleness bound, not a TTL one. In practice Vercel cycles instances often enough that this hasn't bitten — but the failure mode is real: long-warm instance + new event type = agent doesn't know it exists.

There's a `_resetSchemaCache()` test hook at line 211 but no production reset. A real fix would be a TTL here too (say, 5 minutes), or an LRU on schema with the project_id as the key in case the user switches workspaces.

### Move 3 — the principle

**The consistency model you actually have is the weakest link in your read path.** Here that link is the 60s cache for live reads + process-lifetime for the schema. Naming it bounded staleness — and being explicit about the bound — is more useful than wishing for strong consistency. The architectural pressure that gets you out of this corner (Redis, CDN with cache invalidation, server-sent invalidation messages) is real but expensive; we don't pay it because 60s is plenty fresh for a "what changed this period" analytics workflow.

For the UI side: showing `insight.timestamp` next to every card is the cheapest possible "you're reading a snapshot" disclosure. The user sees the time and decides if it's fresh enough.

## Primary diagram

```
  Full consistency picture — what staleness exists, and what bounds it

  ┌─ Browser ─────────────────────────────────────────────────────────┐
  │  reads: as-of insight.timestamp + evidence (the actual tool data)  │
  └────────────────────────────┬──────────────────────────────────────┘
                               │ ?insight=<JSON> hops the per-instance gap
  ┌─ Vercel instance A ────────▼──────┐    ┌─ Vercel instance B ──────┐
  │  insights Map: populated           │    │  insights Map: EMPTY     │
  │  bootstrap cache: populated        │    │  bootstrap cache: empty  │
  │  data-source cache: populated      │    │  data-source cache:empty │
  └────────────────────────────┬──────┘    └─────────────┬────────────┘
                               │                          │
                               ├──────── shared ──────────┤
                               │                          │
                  ┌────────────▼──────────────────────────▼─────────┐
                  │  bi_session cookie + bi_auth cookie              │
                  │  (only state both instances can see)             │
                  └─────────────────────────┬────────────────────────┘
                                            │ HTTPS Bearer
                  ┌─────────────────────────▼────────────────────────┐
                  │  Bloomreach loomi-MCP — single source of truth    │
                  │  (per-call: cache may serve up to 60s stale)      │
                  └──────────────────────────────────────────────────-┘

  Staleness windows:
    response cache       — up to 60s, deterministic
    schema cache         — process lifetime (cold-start bounded)
    per-instance maps    — INFINITE staleness across instances
                            (worked around by passing the blob in the URL)
```

## Elaborate

The textbook consistency models you'd reach for in a real distributed system:

- **Linearizable / strong consistency** — every read sees the latest write, globally ordered. Achieved by paying coordination overhead (Raft, Paxos). Not applicable here; there's no consensus group.
- **Sequential consistency** — operations appear to execute in *some* total order consistent with each process's program order. Same kind of overhead.
- **Causal consistency** — if op A "happened before" op B, all observers see them in that order. Vector clocks land here. We don't track causality.
- **Eventual consistency** — replicas converge given no new writes. Common in NoSQL stores. Not applicable: we have no replicas.
- **Bounded staleness** — reads may be up to N seconds / K versions old. **This is the model we actually have.** TTL caches are the simplest implementation.
- **Read-your-writes** — a process sees its own writes immediately. **Sort-of true here** within an instance + session; broken across instances (where the `?insight=` URL hack restores it).
- **Monotonic reads** — once a process sees value V, it never sees an older value. **Not guaranteed here** — bouncing between instances during a cache window can show R2 then R1.

The architectural ceiling is honest: we have one upstream, no replicas, no concurrency control. Adding replication would introduce eventual consistency as a new concern; right now it isn't one because there's nothing to be inconsistent against.

What to read next: Werner Vogels "Eventually Consistent — Revisited"; the Jepsen consistency cheat sheet; Martin Kleppmann's *Designing Data-Intensive Applications* ch. 9.

## Interview defense

**Q: "What consistency model does this system provide?"**

> "Bounded staleness, with two different bounds depending on where you look. The 60-second response cache in `BloomreachDataSource` means any repeated read is up to 60s stale by construction. The per-instance Vercel memory is *infinitely* stale across instances — a briefing on instance A is invisible to instance B. We work around the second one by stashing the Insight JSON in `sessionStorage` and threading it through the investigate URL as `?insight=<JSON>`, so any instance can serve the investigation regardless of which one fielded the briefing. Honest answer: not strongly consistent, but the staleness is bounded and surfaced — every insight card shows its timestamp."

Diagram:

```
  reads: ≤ 60s stale (cache)
  insights Map: ∞ stale across instances → URL param hack
  Insight.timestamp: the snapshot disclosure
```

**Q: "What's the load-bearing detail?"**

> "Two things. First, the `?insight=<JSON>` URL hack — the feed page stashes the Insight, the URL carries the JSON to the investigate route. That bypasses the per-instance staleness problem without needing a real shared store. Second, the `evidence` array on every Insight — the agent's conclusion travels with the actual tool result it was based on. The UI doesn't promise the data is fresh; it promises 'this is what the agent saw at this timestamp.' That's a different consistency contract, and it's the right one for an analyst tool."

**Q: "What's NOT exercised here?"**

> "Anything that needs replication. No CRDTs, no vector clocks, no eventual-consistency conflict resolution, no read-your-writes guarantees across instances. There's no second writer to conflict with — Bloomreach is the only source of truth and we only read. The day someone adds a Postgres replica or a second region, this whole file gets rewritten."

**Q: "What about the schema cache?"**

> "Process-lifetime staleness. If Bloomreach adds a new event type after the instance warmed up, the agents won't see it until the instance restarts. Vercel cycles instances often enough that this hasn't bitten, but it's listed in the red-flags audit — the fix is a TTL on `cached` in `lib/mcp/schema.ts:190`, maybe 5 minutes, or making the schema cache an LRU keyed by `project_id` in case the user switches workspaces."

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the cache as a dedup story.
- `07-clocks-coordination-and-leadership.md` — the encrypted-cookie pattern that hops the same per-instance gap for auth state.
- `09-distributed-systems-red-flags-audit.md` — the schema-cache lifetime and the per-instance throttle gap are both listed there.
- `../study-database-systems/` — the storage-side vocabulary for ACID, isolation, and snapshot semantics.
