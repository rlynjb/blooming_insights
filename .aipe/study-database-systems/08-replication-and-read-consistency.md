# Replication and read consistency

Industry standard · Distributed storage internals

## Zoom out — where replication would live, and what's there instead

Replication is the mechanism that gives a database high availability and read scale: the same data lives on multiple nodes (primary + replicas, or multi-primary with consensus), and reads can be served from any of them. Read consistency defines what the replica is allowed to show you — the latest write (strong), eventually-the-latest (eventual), or a snapshot from when you started (snapshot isolation). This codebase has **no database, no replication mechanism, and no consistency contract — but it does have one structure that resembles a frozen read replica: the committed `demo-*.json` snapshot.**

```
  Zoom out — where replication would live (and what's there)

  ┌─ Service layer ──────────────────────────────────────────────┐
  │  /api/briefing  /api/agent                                    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
  ┌─ Two "read paths" ────────────▼───────────────────────────────┐
  │  ★ THIS CONCEPT ★                                              │
  │                                                                │
  │  LIVE PATH                          DEMO PATH                  │
  │  ─────────                          ─────────                  │
  │  agent runs against Bloomreach      reads demo-*.json files    │
  │  60s response cache on top          frozen at last capture     │
  │                                                                │
  │  ↑ "primary" (fresh, expensive)     ↑ "frozen read replica"    │
  │    rate-limited at provider           deterministic, instant   │
  └────────────────────────────────────────────────────────────────┘
                                  │
  ┌─ Multi-instance heap ──────────▼──────────────────────────────┐
  │  each Vercel instance holds its OWN in-memory Map             │
  │  → instances diverge; no replication between them              │
  │  → not a "replica set" — independent caches that don't sync   │
  └────────────────────────────────────────────────────────────────┘
```

## Zoom in — the question this concept answers

In a real DB: "how do replicas stay in sync, and what staleness do my reads tolerate?" Here, three honest answers depending on which "replica" you mean:
  1. **The demo snapshot** is a frozen, immutable, deterministic "read replica" that ages until manually re-captured.
  2. **The 60s response cache** is a per-instance lazy "cache replica" with a fixed TTL — read-your-own-writes if you write through it, eventually-consistent otherwise.
  3. **Multi-instance Maps** are independent stores that *look* like replicas but never sync; "consistency" between them is whatever the next briefing run produces.

## Structure pass — the skeleton

### The three "replica" shapes in this codebase

```
  shape                  what it is                          consistency model
  ─────                  ──────────────────                  ─────────────────
  demo-*.json            committed snapshot of one run       FROZEN (never updates)
  60s response cache     per-instance TTL cache over EQL     stale ≤60s per key
  multi-instance Map     independent heaps per Vercel proc   divergent, no sync
```

None of them are a "replica" in the strict sense (no replication protocol, no log shipping, no consensus). All three are *cache-shaped* artifacts that play replica-like roles.

### Axis: where does freshness come from?

```
  The "freshness" axis, across the three replica analogs

  demo-*.json:          frozen at capture time (manual refresh only)
  60s response cache:   refreshed on miss after expiry
  multi-instance Map:   refreshed on each briefing re-run
  Bloomreach (primary): always fresh by definition
```

Each "replica" has a different staleness contract, and the contracts are NOT explicit anywhere in code — they're emergent properties of the cache mechanics. That's the risk: a reader who doesn't know the contract may treat a stale read as fresh.

### Seams

The seam that matters: **the demo/live toggle.** When the UI switches between demo mode (read from snapshot) and live mode (read from Bloomreach with cache), it switches between two *different consistency models* without saying so. Demo guarantees deterministic replay; live guarantees ≤60s staleness per query. The same UI renders both identically — the user has to know which one they're looking at.

## How it works

### Move 1 — the mental model

If you've ever used a CDN that caches your API responses, served a stale page from the cache while the origin was being re-fetched, and shown the user "data as of 30 seconds ago" — that's exactly the consistency model of the 60s response cache. The demo snapshot is a different shape: imagine taking a screenshot of your API responses at one moment, committing them to git, and serving the screenshot when you don't want to hit the origin. That's `demo-*.json`.

```
  The shape — three "replicas," three freshness contracts

   Bloomreach              ← primary; always fresh
        │
        │ tool calls (rate-limited ~1 req/s)
        ▼
   60s response cache       ← per-instance; ≤60s staleness
        │
        │ tool result
        ▼
   in-memory Map            ← per-instance; written on briefing
        │
        │ HTTP read
        ▼
   UI (live mode)

   ────────────────────────────────────────────────────────

   demo-*.json (committed)  ← frozen snapshot; staleness = (now - capture-time)
        │
        │ direct read
        ▼
   UI (demo mode)
```

### Move 2 — the walkthrough

#### The frozen read replica (the demo snapshot)

The two JSON files are committed in `lib/state/demo-insights.json` and `lib/state/demo-investigations.json`. They capture one live briefing run end-to-end, including the agent's reasoning trace, every tool call, and every result.

```ts
// lib/state/investigations.ts:9
const DEMO_FILE = join(process.cwd(), 'lib/state/demo-investigations.json');
```

```ts
// lib/state/investigations.ts:22-28
export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
  if (mem.has(insightId)) return mem.get(insightId)!;
  const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;
  if (fromFile) return fromFile;
  const fromDemo = readJson(DEMO_FILE)[insightId];
  return fromDemo ?? null;
}
```

Annotation:
  - **Line 26** — the demo file is the *last* fallback in the read chain. In-memory first, dev cache second, committed snapshot third. The snapshot is the always-available default.
  - This is the moral equivalent of a read replica that was perfect at one moment and hasn't received any replication since. In real-DB terms, it's "infinite lag" — and that's the deliberate trade for "zero failure mode."
  - The refresh mechanism is a dev-only one-click capture script in `app/page.tsx` (the "capture this as the demo snapshot" button). There's no automatic replication, no lag monitor, no failover. Manual refresh is the only way to update.

In replica vocabulary: this is a **manually-promoted snapshot replica.** It serves stale reads forever (or until someone re-captures). The consistency model is "deterministic but old."

#### The per-instance TTL cache (the 60s response cache)

`BloomreachDataSource` caches every successful tool call result for 60 seconds:

```ts
// lib/data-source/bloomreach-data-source.ts:122,144-148
private cache = new Map<string, { result: unknown; expiresAt: number }>();
// ...
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

Annotation:
  - **Line 122** — one cache per `BloomreachDataSource` instance, which is one per session (constructed in `lib/mcp/connect.ts`). Different sessions don't share cache hits.
  - **Line 145** — TTL is 60s by default. The agent loop never overrides; only debug tooling does.
  - **Lines 147-152** — if the key exists AND hasn't expired, return the cached result tagged `fromCache: true`. The flag flows out to the UI's tool-call trace.

In consistency terms: this is a **read-after-write consistent** cache for queries you've made within the last 60s (you'll see your own cached writes), and **eventually consistent up to 60s** for queries someone else made. There's no invalidation — entries simply expire. A real-DB analog: the buffer pool with TTL-based eviction (which isn't quite how real buffer pools work, but the staleness shape is the same).

The cost of this shape: **a briefing kicked off 30s after a previous one returns mostly-cached numbers.** For 90-day window queries, that's invisible — the underlying metric doesn't move meaningfully in 30 seconds. For tighter-window queries, it would be a real correctness issue.

#### Accidental "replication" — the multi-instance Map divergence

Two Vercel instances serving the same session each hold their own Map. They look like replicas from the outside (same session ID, same data shape) but they don't sync with each other.

```
  The divergence picture

  instance A's Map                      instance B's Map
  ┌────────────────────────┐            ┌────────────────────────┐
  │ session-X:             │            │ session-X:             │
  │   insights: { A1, A2 } │            │   insights: { } empty  │
  └────────────────────────┘            └────────────────────────┘
       (ran briefing here)                   (cold start, no briefing yet)
            │                                        │
            └──── never replicate ───────────────────┘
            user can hit either, sees different data
```

In replica vocabulary: this is the *anti-pattern* — replicas that don't replicate. The consistency model is "whatever instance you happen to land on," which is no consistency at all. The mitigation lives outside the replica layer: the client stashes data in `sessionStorage` (`lib/hooks/useBriefingStream.ts:56`) so the data follows the *user*, not the *instance*. Effectively, the client becomes a poor-man's distributed cache that bridges the divergence.

This is fine because the data isn't of record. If the user lands on instance B with an empty Map, they re-run the briefing or the client re-supplies what it has. No data is lost; just some computation is redone.

#### What read consistency the live path actually offers

If you ask "what does the UI in live mode actually guarantee about freshness?" — the honest answer:
  - **Within one briefing run:** every query the agent issues is at most 60s stale (because the cache filled within the same run for repeated queries, or it was a fresh upstream call for new queries).
  - **Across briefing runs within 60s:** repeated queries return identical cached results. The two briefings will land on the same underlying data.
  - **Across briefing runs >60s apart:** every query goes upstream fresh. Two runs may produce different anomalies as Bloomreach data shifts.
  - **Across two instances simultaneously:** they don't see each other. Whichever instance runs the next briefing first wins; the other instance's view is irrelevant.

None of these guarantees are surfaced to the UI. The UI shows "live" or "demo" and the user reasons about freshness from the label.

#### What the demo path guarantees

  - **Deterministic.** Every run returns identical content. Useful for testing UI changes against a stable backdrop.
  - **Instant.** No network, no rate limit, no LLM call. The snapshot reads from `lib/state/demo-*.json` synchronously.
  - **Stale.** The data is exactly as fresh as the last commit to those files. The "capture this as the demo snapshot" dev tool refreshes it; CI does not.

The deliberate trade: **reliable demo > fresh demo.** The alpha MCP server is unreliable enough during demo windows that a frozen replica is the better presentation path. That's an explicit architectural choice, surfaced in the project context.

### Move 3 — the principle

Replication is the answer to two different questions: *availability* (can I read when one node is down?) and *scale* (can I serve more reads than one node can?). Cache is the answer to a third question: *latency/cost* (can I avoid the expensive read?). The shapes overlap — both are "data lives in multiple places" — but the consistency contracts diverge. Real replication asks "how stale can the replica be relative to the primary?" (lag bound). Cache asks "how stale can the cached value be relative to truth?" (TTL or invalidation policy). Treating one like the other is how stale-data bugs ship. This codebase has caches (the 60s response cache and the demo snapshot) and pretends they aren't replicas — which is correct, because they don't promise the contract a replica would.

## Primary diagram

```
  Replication and read consistency — the complete picture

  ┌─ provider ────────────────────────────────────────────────────┐
  │  Bloomreach Engagement (primary, source of truth)              │
  │  consistency: whatever they offer (opaque to us)               │
  └────────────────────────────────┬──────────────────────────────┘
                                   │ live queries (~1 req/s)
  ┌─ data-source cache ────────────▼──────────────────────────────┐
  │  Map<"name:args", {result, expiresAt}>                         │
  │  contract: read-after-write within 60s window                  │
  │           eventually-consistent up to 60s for others           │
  │  scope:   per-instance (not shared across processes)           │
  │  invalidation: TTL only, no explicit invalidation              │
  └────────────────────────────────┬──────────────────────────────┘
                                   │ tool results
  ┌─ per-instance state ───────────▼──────────────────────────────┐
  │  Map<sessionId, SessionFeed>                                   │
  │  contract: instance-local, last-write-wins on collision        │
  │  divergence: instances do NOT sync; client mitigates           │
  └────────────────────────────────────────────────────────────────┘

  ────────────────────────────────────────────────────────────────

  ┌─ demo path (parallel read path) ───────────────────────────────┐
  │  lib/state/demo-insights.json                                  │
  │  lib/state/demo-investigations.json                            │
  │  contract: frozen at last capture (manual refresh)             │
  │  scope:   global (committed to repo, identical for all users)  │
  │  invalidation: dev "capture" command rewrites the files        │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The classical references for replication consistency are the consistency-model papers (Lamport's "Time, Clocks, and the Ordering of Events," Brewer's CAP, Vogels' "Eventually Consistent"). The hierarchy from strongest to weakest: linearizable → sequential → causal → eventual → no-consistency. Real DBs sit at different points: Postgres primary-replica is read-your-own-writes if you read your own primary, eventually consistent on replicas, with a measurable lag. DynamoDB offers eventual or strong reads as a per-request flag. Spanner offers external consistency via TrueTime. Cassandra tunes per-query via R+W>N quorum.

The "cache as quasi-replica" pattern this codebase uses has its own lineage: CDN edge caches, Cloudflare Workers KV, Vercel's own Edge Cache. The shape is always: a TTL-bounded cache layer that absorbs read load, with no invalidation other than expiry. It works well when staleness within the TTL is acceptable, and badly when downstream-of-the-cache writes need to be visible immediately.

The demo snapshot is something more specific: a **golden snapshot.** Used for deterministic UI development, demo reliability, and regression testing. In other ecosystems this is the role of fixture files, recorded HTTP responses (VCR-style), or test-mode mocks. Here it's promoted to a runtime path — the same UI renders against it as against live.

## Interview defense

> Q: "How does this app handle read consistency?"

Verdict: there are three "replica-like" surfaces, each with a different consistency contract, and none of them are formally a replica. The 60s response cache on the data-source adapter offers read-after-write within the window and eventual consistency up to 60s for others. The committed demo snapshot is a frozen golden snapshot, deterministic but as old as the last manual capture. Multi-instance heaps are accidental "replicas" that don't sync at all — divergence is mitigated by stashing data on the client in sessionStorage.

```
  the picture you draw — three replica-like surfaces

   60s cache         ≤60s stale, per-instance
   demo-*.json       frozen at capture, deterministic
   multi-instance    divergent, no sync, client bridges
```

The load-bearing point: none of these promise the strong-consistency contract of a real replica, and the architecture is built around that. Live mode says "things might be up to 60s old" (silently). Demo mode says "this is the captured replay" (via the demo/live toggle).

> Q: "What's the worst inconsistency you could see?"

Two instances diverging on a session is the loudest case — the user sees different data depending on which Vercel instance answered their request. The user-visible symptom is "the briefing I just saw is now empty," which is annoying but recoverable (refresh re-runs). The 60s cache rarely manifests because the queried metrics use 90-day windows that don't move meaningfully in a minute.

> Q: "When would real replication enter the picture?"

When a single instance can't handle the read load AND there's data of record to replicate. Today neither is true — the local state is derivative (no need to replicate it) and the upstream (Bloomreach) handles replication on its side. The day local data of record exists (saved investigations, audit log), the replication question lands at the same time as the datastore question.

## See also

  - [`07-wal-durability-and-recovery.md`](./07-wal-durability-and-recovery.md) — durability is the precondition for replication
  - [`04-query-planning-and-execution.md`](./04-query-planning-and-execution.md) — how the 60s cache acts as a materialized view
  - [`audit.md`](./audit.md) — F4 (60s cache staleness), F5 (demo snapshot as frozen replica)
