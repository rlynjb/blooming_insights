# Replication and read consistency

*Replication / Language-agnostic*

## Zoom out, then zoom in

You know how a Postgres primary streams its WAL to one or more replicas, apps can send read-only queries to a follower for scale, and you have to think about *lag* — the follower might return "yesterday's" data — that's replication. This repo has no streaming replication, no primary/follower topology, no read-your-writes protocol. What it has is one *pre-captured JSON snapshot* that serves reads on the demo path, and a bank of *committed eval receipts* that serve as historical rows. Both are frozen replicas. This file names the pattern each plays, and the freshness bounds each accepts.

```
  Zoom out — where "read replicas" live in this repo

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  the feed page: reads live OR replays committed snapshot   │
  │    ?demo=cached  →  reads /lib/state/demo-insights.json    │
  │    (default live) →  reads the agent output stream          │
  │  toggle persisted in localStorage `bi:mode`                │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌─ Service (Vercel) ─────▼──────────────────────────────────┐
  │                                                            │
  │  briefing route: two branches                              │
  │    demo branch  →  readFileSync(DEMO_FILE) → NDJSON replay │  ← this file's scope
  │    live branch  →  runs the monitoring agent               │
  │                                                            │
  │  agent route: two branches                                 │
  │    cache hit    →  getCachedInvestigation → replay         │
  │    cache miss   →  live agent run                          │
  │                                                            │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌─ Bloomreach ▼─────────────────────────────────────────────┐
  │  the primary. always live. every read is a network call.  │
  └────────────────────────────────────────────────────────────┘

  ┌─ git (frozen replicas) ────────────────────────────────────┐
  │  lib/state/demo-insights.json           the feed replica    │
  │  lib/state/demo-investigations.json     the drill-down replica│
  │  eval/baseline.json                     the reference "row"  │
  │  eval/receipts/*.json                   historical eval rows │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** The demo snapshot is a real replica pattern — pre-computed, deliberately stale, faster to read, no auth. The refresh policy is *manual*, not streaming. That's the trade you make when your presentation reliability matters more than freshness.

## Structure pass

**Axis to hold constant: how stale is this read allowed to be?**

```
  "how fresh must this read be?" — traced across the read paths

  ┌─ live briefing (?demo=live) ───────────────────────────────┐
  │  agent runs, hits Bloomreach at query time                  │  → fresh (as of the
  │  app/api/briefing/route.ts:151+                             │    execute_analytics_eql call)
  └────────────────────────────────────────────────────────────┘
      ┌─ live briefing + 60s cache ─────────────────────────────────┐
      │  same tool + args within 60s → cached result                 │  → up to 60s stale
      │  bloomreach-data-source.ts:144-152                           │
      └─────────────────────────────────────────────────────────────┘
          ┌─ demo replay (?demo=cached) ────────────────────────────────┐
          │  readFileSync(lib/state/demo-insights.json)                   │  → stale until
          │  app/api/briefing/route.ts:78-149                             │    someone re-captures
          └──────────────────────────────────────────────────────────────┘
              ┌─ cached investigation replay ───────────────────────────────┐
              │  getCachedInvestigation → mem, then dev file, then demo file │  → stale by design
              │  lib/state/investigations.ts:22-28                            │    (idempotent replay)
              └──────────────────────────────────────────────────────────────┘
                  ┌─ eval baseline read ────────────────────────────────────────┐
                  │  readFileSync(eval/baseline.json)                             │  → stale by intent
                  │  eval/gate.eval.ts:53-58                                      │    (frozen reference)
                  └──────────────────────────────────────────────────────────────┘
```

The seam that flips the axis is **the "how does this replica get updated" question**. The 60s cache updates on its own (TTL expiry + next real call). The demo snapshot updates only when a dev runs the capture flow. The baseline updates only when a PR changes it. As you go down the list, the write frequency drops from "seconds" to "months."

## How it works

### Move 1 — the mental model

Standard replication kernel:

```
  standard primary → follower replication

  primary                            follower
  ───────                            ────────
  write X                            (lags)
    │
    ▼
  append to WAL
    │
    ▼
  ship WAL entry over the wire ──►  apply WAL entry
    │                                 │
    ▼                                 ▼
  return commit                     "now up to LSN N"

  reader on follower may see version N-k (lag = k)
```

This repo's shape (Case B: no engine, but the pattern is there):

```
  this-repo pattern — snapshot as replica, manual "replication"

  live path (source of truth)      snapshot (frozen replica)
  ────────────────────────         ──────────────────────────
  agent hits Bloomreach            lib/state/demo-*.json
    │                                  │
    ▼                                  ▼
  produces Insights + trace        served by /api/briefing?demo=cached
    │                                  │
    ▼                                  ▼
  dev clicks "capture snapshot"    replay at PACE_MS = pretty pace
    │
    ▼
  writes lib/state/demo-*.json
    │
    ▼
  dev commits the file             ← this IS the replication step
```

The load-bearing insight: **the "replication lag" is however long since the last capture-and-commit**. That's minutes when a dev is actively iterating, hours between commits, indefinitely on a stable snapshot that isn't due for refresh. Same phenomenon as a lagging Postgres follower, just at a coarser cadence.

### Move 2 — the primitives walked

**The demo snapshot as read replica.**

```ts
// app/api/briefing/route.ts:78-96 (abridged)
const demo = req.nextUrl.searchParams.get('demo') === 'cached';

if (demo) {
  let snapshot: DemoSnapshot | null = null;
  try {
    snapshot = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as DemoSnapshot;
  } catch {
    snapshot = null;
  }
  if (snapshot) {
    const snap = snapshot;
    // NDJSON replay from the snapshot, paced at PACE_MS
    ...
```

Server-side: read the whole JSON file, stream it back as NDJSON at a "readable" pace so the demo doesn't just flash the answer. `DEMO_FILE` points at `lib/state/demo-insights.json` (`briefing/route.ts` header constants). This is the same read pattern a Postgres follower serves — no primary hit, pre-computed, deliberately stale.

The client toggles between live and demo via `localStorage` `bi:mode` (see `app/page.tsx`). Default is `demo`, which is a design choice: presentation reliability > freshness, because the alpha Bloomreach server revokes tokens after minutes and rate-limits hard.

**The investigation cache = a layered replica chain.**

```ts
// lib/state/investigations.ts:22-28
export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
  if (mem.has(insightId)) return mem.get(insightId)!;                 // (1) warm-instance mem
  const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined; // (2) dev file
  if (fromFile) return fromFile;
  const fromDemo = readJson(DEMO_FILE)[insightId];                    // (3) committed demo
  return fromDemo ?? null;
}
```

Three tiers of freshness, checked in order:
1. **In-memory (this warm instance)** — the freshest replica. Populated by any live agent run that finished on this instance.
2. **`.investigation-cache.json` (dev only)** — the file that survives dev-server restarts. Same freshness as the last dev run.
3. **`demo-investigations.json` (committed)** — the coldest tier. Only refreshed when a dev commits.

Read-through: the first hit wins. Miss → live agent run (see `app/api/agent/route.ts:107-130`). This is a *cache hierarchy* with clearly different lag characteristics per tier, and the code walks them in the order that maximizes freshness.

**The 60s TTL cache = a within-warm-instance replica.**

```ts
// lib/data-source/bloomreach-data-source.ts:144-187
if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
...
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
```

In DB terms this is a *result cache* — every `(tool, args)` gets its own replica of the last-seen result, expiring in 60 seconds. Consistency is *bounded staleness*: no reader sees data older than 60s. When a stale entry is read (impossible today because of TTL, but conceptually), the cost is one round-trip's latency to refresh.

The refresh policy is *lazy expiration*: the entry sits there past 60s until someone reads it and forces a re-fetch. Errors are excluded (`bloomreach-data-source.ts:179-181`) so a transient rate-limit never gets replicated for 60 seconds — that would be a *poisoned replica*.

**`eval/baseline.json` = the pinned reference replica.**

```ts
// eval/gate.eval.ts:53-58
const baselinePath = resolve(EVAL_DIR, baselineFile);
let baseline: Baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
} catch {
  throw new Error(`Missing baseline at ${baselinePath}. ...`);
}
```

The baseline is a *frozen reference* — the row every candidate run gets compared to. In DB terms it's a materialized view over an older set of receipts, pinned indefinitely until someone rebuilds it (`npm run eval:baseline` at `eval/baseline.eval.ts:41-65`). Refresh policy: manual, code-reviewed, git-committed. Lag: whatever the age of `builtAt` in the file (`2026-07-03T05:29:44.727Z` at time of writing).

The receipts themselves (`eval/receipts/*.json`, 28 rows) are the *append-only log* the baseline is materialized from. When you run `npm run eval:baseline`, it's essentially:

```
  SELECT
    computeBaseline(receipts)
  FROM
    receipts
  WHERE
    runId = :latestOrSpecified
```

...and the result is written to `eval/baseline.json`. That's a snapshot of a snapshot. `eval/baseline.eval.ts:42-65` is the "job" that materializes it.

### Move 2 variant — the load-bearing skeleton

Minimum viable "replica" story:

1. **The `lib/state/demo-*.json` files.** Remove them and the default `?demo=cached` path fails — the app loses its no-auth demo mode and every visitor has to run the full OAuth handshake to see anything.
2. **The read-through cascade in `getCachedInvestigation`.** Remove tiers and either warm-instance freshness (tier 1) or committed replay (tier 3) becomes lost — the "step 3 hydrates instantly on back-nav" UX depends on tier 1; the demo path depends on tier 3.
3. **`eval/baseline.json` as a pinned reference.** Remove it and the regression gate has nothing to compare against; every PR is either "no gate" or "compute a fresh baseline" (which regresses to noise).

Rest is nice-to-have.

### Move 3 — the principle

**Pick your replica's refresh cadence to match the read's freshness requirement, and be honest about the lag.** Real streaming replication chases zero lag; here we accept "hours" (the demo snapshot), "60 seconds" (the TTL cache), or "indefinite" (the baseline). Each choice is defensible when the *read* doesn't need better. The presentation demo doesn't need real numbers; the eval gate doesn't need this week's baseline. When the read pattern's freshness requirement tightens (real customer analytics dashboard, cross-session query surface), the manual-refresh model breaks and you need streaming replication for real.

## Primary diagram

```
  Every replica and its refresh policy

  ┌─ tier 1: in-memory result cache (per warm instance) ────────┐
  │                                                              │
  │  BloomreachDataSource.cache: Map<key, {result, expiresAt}>   │
  │    refresh: lazy on TTL expiry (60s)                         │
  │    lag: 0–60s                                                │
  │    lib/data-source/bloomreach-data-source.ts:122, 144-187    │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ tier 2: in-memory investigation cache (per warm instance) ┐
  │                                                              │
  │  investigations.ts mem: Map<insightId, AgentEvent[]>          │
  │    refresh: written by live agent runs                       │
  │    lag: 0 (this instance's own writes)                       │
  │    lib/state/investigations.ts:11, 22-41                     │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ tier 3: dev-only file cache ──────────────────────────────┐
  │                                                              │
  │  .investigation-cache.json (gitignored)                      │
  │    refresh: dev routes write on cache miss                   │
  │    lag: dev-machine freshness                                │
  │    lib/state/investigations.ts:30-41                         │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ tier 4: committed demo snapshot (production replica) ─────┐
  │                                                              │
  │  lib/state/demo-insights.json                                │
  │  lib/state/demo-investigations.json                          │
  │    refresh: manual, dev clicks "capture" then commits        │
  │    lag: since last commit                                    │
  │    served by /api/briefing?demo=cached                       │
  │    app/api/briefing/route.ts:78-149                          │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ tier 5: committed eval reference ─────────────────────────┐
  │                                                              │
  │  eval/baseline.json — the pinned regression reference        │
  │    refresh: `npm run eval:baseline` writes it; commit it     │
  │    lag: since last rebuild                                   │
  │    eval/baseline.eval.ts:42-65                               │
  │    eval/gate.eval.ts:53-91                                   │
  │                                                              │
  │  eval/receipts/*.json — the append-only "log" it's built from│
  │    28 rows, one per (case × runId)                           │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The interesting thing about the demo snapshot pattern is that it inverts the usual "eventual consistency" tradeoff. In a normal replica, the primary is the truth and the replica lags. Here the *replica is deliberately more stable than the primary* — the primary (Bloomreach alpha) is unreliable (rate-limited, token-revoking), so the replica (`lib/state/demo-*.json`) is what you show to a viewer who has to see the app work *right now*. The primary is only reached for updates. That's a pattern you see in local-first apps and in developer-preview demos, but rarely in the replication literature — the replica isn't a scale device, it's a *reliability device*.

The eval baseline is a different flavor: an *analytical replica* in the classic sense. Receipts are the row-level log; the baseline is the aggregated view; the gate is the query against the view. If receipts count grew (100 cases × 100 runs = 10,000 rows), you might introduce a per-runId subdirectory (a filesystem "index" — see `03-btree-hash-and-secondary-indexes.md`'s "not yet exercised" list). Today it's fine.

`study-system-design` owns "why did you pick this architecture"; here we own the mechanics of "how does the replica stay coherent enough to be useful." The demo snapshot's "just recapture and commit" refresh loop is the honest answer.

### `not yet exercised`

- **Streaming replication / logical decoding (Postgres, Debezium).** No engine, no log to ship.
- **Leader / follower topology.** N/A — the "primary" is Bloomreach (managed).
- **Failover / promotion / split-brain resolution.** N/A.
- **Quorum reads / writes (Dynamo-style N/R/W).** No cluster.
- **Read-your-writes consistency guarantees.** The client-side `sessionStorage` stash is a per-user RYW hack (client holds its own writes), not a server-side guarantee.
- **Monotonic reads / bounded staleness protocols.** No versioning to compare against.
- **Multi-region replication, geo-replication lag budgets.** No multi-region setup.

## Interview defense

**Q: "How do you handle read replicas here?"**

Model answer: "Two real replica patterns, both frozen rather than streaming. The demo snapshot at `lib/state/demo-insights.json` and `demo-investigations.json` is a *reliability replica* — pre-captured, no auth needed, served by `/api/briefing?demo=cached` at `app/api/briefing/route.ts:78-149`. Its refresh policy is 'a dev clicks capture, commits the file' — deliberate, not automated, because presentation reliability matters more than freshness given the alpha backend's unreliability. The eval baseline at `eval/baseline.json` is an *analytical replica* — one aggregated row materialized from the `eval/receipts/*.json` row log via `computeBaseline(runId, receipts)` at `eval/baseline.eval.ts`. It's the pinned reference the regression gate compares candidates against. Refresh is `npm run eval:baseline` + git commit; the lag is 'since last rebuild.' Neither is real streaming replication, but both are the same pattern — a stale copy that serves reads faster than the primary."

Diagram to sketch: the five-tier replica stack from tier 1 (in-mem TTL cache) to tier 5 (committed eval receipts).

**Q: "What's the freshness story on the 60s TTL cache?"**

Model answer: "Bounded staleness of 60 seconds per (tool, args). Reader-facing: any tool call within 60s of an earlier identical call sees the earlier result — `lib/data-source/bloomreach-data-source.ts:144-152`. The cache is per warm instance, so two Vercel instances have independent caches; a call cached on instance A won't help a reader on instance B. Poisoning is prevented by not caching errors — `bloomreach-data-source.ts:179-181` — so a transient rate-limit doesn't lock in a 'fail for 60 seconds' state. If freshness needs to be tighter (say, 5 seconds), you drop the TTL; if looser, you raise it. Today 60s is picked to absorb the bootstrap chain — every request replays `list_cloud_organizations` and `list_projects`, and caching those saves 2 real calls per request against a ~1 req/s limit."

Anchor: bounded staleness = TTL; errors excluded so no poisoning.

**Q: "How would you scale if the workload grew?"**

Model answer: "The replicas as they stand don't scale — they're presentation devices, not throughput devices. If read load grew past what one Vercel warm instance can serve, I'd promote the 60s cache to a shared tier (Vercel KV, Redis) so instances share hits, and I'd let the demo snapshot stay committed since it's a static file the CDN already caches. If cross-user analytical reads showed up (search across all users' insights, historical trending), that's the moment I'd introduce a real database — Postgres with a follower for reads — because the manual-refresh snapshot model breaks the moment freshness needs to be tighter than 'when a dev remembers to re-capture.' Not before."

Anchor: current replicas are reliability/presentation, not scale; introduce real replication when read-freshness requirements tighten.

## See also

- `01-database-systems-map.md` — where these replicas fit in the whole storage picture.
- `04-query-planning-and-execution.md` — how the cache acts as plan-reuse.
- `07-wal-durability-and-recovery.md` — the other side of "committed JSON in git" as durability.
- `study-system-design` — the higher-level "why this architecture" question.
