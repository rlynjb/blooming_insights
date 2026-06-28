# Replication, partitioning, and quorums

**Industry name:** primary/replica, leader-follower, consistent hashing, quorum reads/writes · **Type:** Industry standard — Case B (not exercised in this repo)

## Zoom out, then zoom in

Verdict, first sentence: **this repo does not replicate or partition any state.** No replica set, no shards, no consistent hashing, no quorum reads. This file is here so you can defend the absence and recognize when the gap would start mattering.

```
  Zoom out — where replication WOULD live (and doesn't)

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  React 19 client                                          │
  └──────────────────────────────────────────────────────────┘

  ┌─ Service layer — Vercel serverless cohort ───────────────┐
  │  N ephemeral instances. They share NOTHING except:        │
  │    • bi_session cookie  (per-user routing)                │
  │    • bi_auth cookie     (auth state)                      │
  │                                                           │
  │  ✗ no replicated state                                    │
  │  ✗ no shared cache layer (Redis, Memcached)               │
  │  ✗ no consistent hashing                                  │
  └──────────────────────────────────────────────────────────┘

  ┌─ Provider layer ─────────────────────────────────────────┐
  │  Bloomreach loomi-MCP — ONE upstream                      │
  │  (its internal replication is opaque to us)               │
  │                                                           │
  │  Anthropic API — ONE upstream                             │
  │  (same — opaque)                                          │
  └──────────────────────────────────────────────────────────┘

  ┌─ "Database" ──────────────────────────────────────────────┐
  │  ✗ no database. Period.                                   │
  │  in-memory Maps (per-instance) + gitignored JSON files    │
  │  for dev auth + committed JSON snapshots for demo replay  │
  └──────────────────────────────────────────────────────────┘
```

If you're studying for a distributed-systems interview, the chapter on replication/partitioning is real — but the truthful answer for this codebase is "not exercised." Read this file to know what you'd be adding when it becomes time.

## Structure pass (compressed — there's no mechanism to walk)

### Axis: where could a replica or shard logically live?

```
  Trace "could-this-replicate?" across the stack

  Browser            — N tabs already exist; client-side replication = none
  Vercel instance    — N instances exist; share nothing → "replication-less"
  Caches             — per-instance, not shared → each replica is its own cache
  State              — per-instance + per-session Maps; never shared
  Datastore          — DOES NOT EXIST. Nothing to replicate.
```

The axis answer is "no" at every layer. There's nowhere replication would land because there's no stateful component that owns durable state.

### Seams (load-bearing absences)

- **No primary/replica seam.** Each Vercel instance is independent and authoritative for its own per-instance memory only. There's no "promote to primary" event because there's no primary.
- **No partition key boundary.** The `bi_session` cookie acts a bit like a routing key (per-user isolation), but Vercel doesn't pin a session to an instance — any instance can serve any request. This means the *opposite* of sharding: any data that needs to span requests has to ride the request itself (cookie, URL param) or live in the upstream.
- **No quorum seam.** No N/W/R decisions to make.

## Move 1 — what the picture would look like if it existed

For contrast, here's the shape this repo would take if a replicated datastore landed.

```
  Hypothetical: what replication WOULD add (not in this repo)

  ┌─ Browser ──────────┐
  └─────────┬──────────┘
            │
  ┌─ Vercel cohort ────┴────────────────────────────┐
  │  load balancer (already exists)                  │
  └──────────┬──────────────────────────────────────┘
             │
   ┌─────────┴─────────────┐
   │                       │
   ▼                       ▼
  ┌─ Replica 1 ──┐    ┌─ Replica 2 ──┐    ┌─ Replica 3 ──┐
  │  primary     │    │  follower     │    │  follower     │
  │  (writes)    │    │  (reads)      │    │  (reads)      │
  └──────┬───────┘    └──────▲────────┘    └──────▲────────┘
         │ async replication │                    │
         └───────────────────┴────────────────────┘

  Adding this would introduce:
    • replica lag (eventual consistency)
    • failover (leader election, split-brain risk)
    • partition key for sharding (consistent hashing)
    • quorum reads/writes (N/W/R tradeoff)
    • client-side read repair OR strong-read on follower miss
```

None of those concerns apply today. The closest analog to "multi-replica" is "the Vercel cohort serves all reads," but every instance hits the same Bloomreach upstream — fan-out, not replication.

## Move 2 — what's actually here, by way of counter-example

### The single-source-of-truth pattern

```ts
// lib/mcp/schema.ts:166
export async function resolveProject(
  dataSource: DataSource,
  opts: BootstrapOpts = {},
): Promise<{ projectId: string; projectName: string }> {
  const orgs = unwrap<{ data: { id: string; name: string }[] }>(
    await callOrThrow(dataSource, 'list_cloud_organizations', {}, opts),
  ).data;
  if (!orgs?.length) throw new Error('no cloud organizations for this user');

  const projects = unwrap<{ data: { id: string; name: string }[] }>(
    await callOrThrow(dataSource, 'list_projects', { cloud_organization_id: orgs[0].id }, opts),
  ).data;
  if (!projects?.length) throw new Error('no projects in organization');

  const pinned = process.env.BLOOMREACH_PROJECT_ID;
  const project = (pinned && projects.find((p) => p.id === pinned)) || projects[0];
  return { projectId: project.id, projectName: project.name };
}
```

The "partition key" here is the user (via the OAuth Bearer token) — Bloomreach handles the multi-tenancy. We pick *one* project (`pinned ?? projects[0]`) and use that for the lifetime of the schema cache. There's no sharding decision to make at our layer.

### The "demo snapshot" as a degenerate datastore

`lib/state/demo-insights.json` (committed) is the only thing in this repo that survives a process restart with no upstream. It's not a database — it's a JSON file the briefing route serves verbatim:

```ts
// app/api/briefing/route.ts:86
if (demo && existsSync(DEMO_FILE)) {
  let snapshot: DemoSnapshot | null = null;
  try {
    snapshot = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as DemoSnapshot;
  } catch {
    snapshot = null;
  }
  if (snapshot) { /* replay */ }
}
```

If this ever became a real datastore (the user can edit notes on an investigation, say), replication would land here. Today it's read-only and ships with the repo, so its "consistency model" is just `git pull`.

### Per-instance in-memory caches — read-replica-shaped, but not replicas

```
  Three Vercel instances, each with its own everything

  ┌─ Instance A ─────────┐ ┌─ Instance B ─────────┐ ┌─ Instance C ─────────┐
  │ insights Map: {…}     │ │ insights Map: {…}     │ │ insights Map: {…}     │
  │ schema cache: {…}     │ │ schema cache: {…}     │ │ schema cache: (cold)  │
  │ data-source cache: {…}│ │ data-source cache: {…}│ │ data-source cache: {…}│
  └──────────┬───────────┘ └──────────┬───────────┘ └──────────┬───────────┘
             └─────────────────────────┴────────────────────────┘
                                       │
                                       ▼
                         ┌─ Bloomreach loomi-MCP ─┐
                         │  the only source of    │
                         │  truth                 │
                         └────────────────────────┘
```

Each instance is its own cache — that *resembles* the "fan-out to N read replicas" pattern, but with two crucial differences: (a) the caches are populated lazily per request, not seeded from a primary; (b) instances never talk to each other. Two requests for the same data hit two different caches, with no coordination between them. That's not replication — it's "every instance is alone."

## What would change if replication landed

A practical, ranked list of what'd need to be added:

1. **Add Redis (or Vercel KV) as a shared cache layer.** The 60s response cache currently in `BloomreachDataSource` becomes a shared layer — instance A's cache hit serves instance B's request. This is the *cheapest* "replication" win and the one we'd reach for first.
2. **Move `insights` and `investigations` Maps out of process.** Same store. Removes the `?insight=` URL param hack from the consistency model.
3. **Add a TTL to the schema cache and move it to Redis too.** Solves the process-lifetime staleness in `lib/mcp/schema.ts:190`.
4. **THEN** start thinking about partitioning (multi-region Vercel + multi-region Redis), at which point quorum reads/writes (W=1, R=2 for example) would become a real choice.
5. **Only THEN** start thinking about Postgres + read replicas, at which point replication lag, failover, and split-brain become concerns.

This list is the migration path. We're at step 0. The honest framing is that this is right-sized for a portfolio project; the same listing as a production roadmap would be sensible at scale.

## Why this doesn't matter (yet)

The volume profile keeps this corner empty:

- One user per session. No fan-out.
- Read-only upstream tools (no writes to dedup, replicate, or order).
- Bounded duration (max 300s per request → instance never needs warm long-running state).
- Demo snapshot is the "shared store" and it's a JSON file in git.

The architectural pressure that *would* push us into real replication: multi-tenant teams sharing a workspace (now you have to share `insights` across users), or letting the user save/edit briefings (now you need a real write path with conflict resolution).

## Primary diagram

```
  Full picture — what's NOT here

  ┌─ Browser ─────────────────────────────────────────────────────────┐
  │  one tab, one user (today)                                         │
  └────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS
  ┌─ Vercel cohort ────────────▼──────────────────────────────────────┐
  │  N independent instances. SHARE NOTHING except cookies.            │
  │                                                                    │
  │  ✗ no Redis        ✗ no leader election    ✗ no shard key          │
  │  ✗ no Postgres     ✗ no consensus group    ✗ no quorum             │
  │  ✗ no failover     ✗ no read repair        ✗ no replication lag    │
  └────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS Bearer
  ┌─ Bloomreach loomi-MCP ─────▼──────────────────────────────────────┐
  │  ONE upstream. Its internal replication is opaque.                 │
  │  (we don't pay coordination cost; we pay rate-limit cost instead)  │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The standard distributed-systems vocabulary for replication and partitioning lives in Kleppmann *Designing Data-Intensive Applications* chapters 5–6 and Lindsey Kuper's distributed-systems lectures. Worth knowing at the vocabulary level for interviews even when not exercised:

- **Synchronous vs asynchronous replication.** Sync = primary waits for follower ack (strong consistency, slow); async = fire-and-forget (fast, replica lag). Most real systems are async or "semi-sync" (wait for at least one follower).
- **Leader-based vs leaderless.** Leader-based (Postgres, MySQL, MongoDB): one writer, many readers. Leaderless (DynamoDB, Cassandra, Riak): writes go to N replicas with W acknowledging, reads go to R replicas — the N/W/R quorum tradeoff.
- **Single-leader vs multi-leader.** Multi-leader (CRDTs, last-write-wins, version vectors) lets multiple regions accept writes; required for active-active multi-region. Conflict resolution is the whole story.
- **Partitioning strategies.** Hash partitioning (uniform distribution, no range scans), range partitioning (range scans cheap, hot-spot risk), consistent hashing (minimal rebalance on node add/remove). Re-sharding is its own hard problem.
- **Quorum math.** N replicas, write to W, read from R; strong consistency requires W + R > N. Common: N=3, W=2, R=2 — tolerate one replica down on either side.

What to read next: Kleppmann ch. 5–6; the DynamoDB paper; the Cassandra docs on tunable consistency; Aphyr's Jepsen reports for what goes wrong in practice.

## Interview defense

**Q: "How do you handle replication in this system?"**

> "I don't. This repo has no replicated state — no Redis, no Postgres, no shared cache, no replica set. The Vercel cohort serves all reads but every instance is independent; they share nothing except cookies. The day this needs to change, the first move is Vercel KV or Redis to hold the response cache and the `insights` maps; the per-instance staleness I work around with a `?insight=<JSON>` URL hack would go away. Only after THAT would partitioning, quorum reads, or a Postgres primary/replica setup become real choices."

Diagram you sketch:

```
  today:   N Vercel instances → 1 Bloomreach (fan-out, no shared cache)

  step 1:  N Vercel instances → 1 Redis (shared 60s cache) → 1 Bloomreach
  step 2:  + Postgres for write state → multi-region → quorum reads
```

**Q: "What would push you into real replication?"**

> "Three triggers: (1) multi-user teams sharing a workspace — `insights` becomes a shared collection. (2) Persistent investigations — the user saves notes, that's a write path with concurrency. (3) Multi-region latency — at which point the shared cache and shared state need to replicate, and the conflict-resolution choices (leader vs leaderless, last-write-wins vs CRDTs) become real. None of those exist today."

**Q: "What's the single closest thing to replication you have?"**

> "The per-instance caches. Three Vercel instances, three independent caches, all pointing at the same Bloomreach upstream — it *resembles* fan-out to read replicas. But there's no coordination, no read repair, no consistency story between them. Each instance is its own little world. That's the honest framing — not replicated, just multiplied."

## See also

- `01-distributed-system-map.md` — the picture this file is the counter-example to.
- `04-consistency-models-and-staleness.md` — the per-instance staleness this file would solve if replication landed.
- `07-clocks-coordination-and-leadership.md` — the encrypted-cookie pattern that hops the per-instance gap for auth specifically.
- `09-distributed-systems-red-flags-audit.md` — listed alongside the per-instance throttling caveat.
