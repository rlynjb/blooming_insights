# Replication, Partitioning, and Quorums

*Industry name: replicas · shards · quorum reads · Type: Industry standard*

## Zoom out — where this concept lives

Not yet exercised in this repo. That's the honest answer, and this file explains why and when it becomes relevant.

```
  Zoom out — the replication surface in this repo

  ┌─ Client band ──────────────────────────────────────────┐
  │  browser (single per user, no replicas)                │
  └─────────────────────────┬──────────────────────────────┘
                            │
  ┌─ Server band ───────────▼──────────────────────────────┐
  │  Vercel functions — auto-scaled but NOT replicated for  │
  │  consistency. Each function instance is independent;    │
  │  no leader, no follower, no quorum.                     │
  └─────────────────────────┬──────────────────────────────┘
                            │
  ┌─ External ──────────────▼──────────────────────────────┐
  │  MCP server (Bloomreach) — from our vantage point, one │
  │  URL. Its internal replication is out of scope.        │
  └────────────────────────────────────────────────────────┘

  ★ NOT YET EXERCISED ★ — no replicas, no shards, no quorum
```

## Zoom in — narrow to the concept

Replication means running N copies of the same data or the same service, so a failure of any single copy doesn't stop the whole. Partitioning (sharding) means splitting data across N nodes so no single node holds the full set. Quorums are the rule about how many of the N have to agree before a write commits or a read is trusted.

**None of that applies to this repo right now.** The reasons are worth walking through, because they explain what would trigger a change.

## Structure pass

### Layers — where replication *could* live if it mattered

- **Server layer**: Vercel functions are already run in multiple instances by the platform, but purely for scale — they don't coordinate. That's not replication in the CAP-theorem sense; it's independent stateless workers.
- **Cache layer**: the 60 s response cache is per-instance, unshared. Not replicated. Not partitioned.
- **State layer**: no database. Insight/investigation state is in-memory (per instance) or in a committed demo JSON (read-only, no writes).
- **External**: whatever the MCP server does internally — we don't participate.

### One axis held constant — "how many copies are there?"

```
  Axis: number of copies at each layer

  browser         →  ONE per user
  Vercel function →  many, but independent stateless workers
  response cache  →  ONE per instance (many total, unshared)
  investigations  →  ONE per instance (many total, unshared)
  auth cookie     →  ONE per browser (crypto-shared read across
                     ALL instances → effectively N replicas)
  MCP server      →  ONE URL (opaque; may be N behind a load balancer)
```

The auth cookie is the interesting entry. It IS replicated across all Vercel instances — but the replication happens by *cryptographic shared secret*, not by protocol. That's a corner case worth naming: **encryption under a shared key is a replication substitute for read-mostly, browser-authoritative state.**

### Seams

No load-bearing seams for replication in this repo, because replication doesn't exist here yet. The seam that *would* be load-bearing if it did: the cache. Right now `bloomreach-data-source.ts:122` — `private cache = new Map<string, {...}>()` — is a local Map. A future replication story would swap the Map for a shared KV client behind the same interface.

## How it works

### Move 1 — the mental model

You've written a redundant fetch fallback: primary API, fallback URL if it fails. That's the informal shape of "two replicas with primary-secondary." A real replication protocol goes further: multiple copies stay in sync via a write path (leader propagates to followers, or all peers gossip), and reads pick from any live copy.

```
  The pattern — a replicated read, informally

  read request
       │
       ▼
   ┌───────────────────────┐
   │  replica selector     │  round-robin? closest? healthy?
   └───────┬───────────────┘
           │
           ▼
   ┌───────────────────────┐
   │  replica N (of {1..M})│
   │  serves the read      │
   └───────────────────────┘

   correctness rule (quorum):
     writes go to ≥ W replicas
     reads pull from ≥ R replicas
     R + W > M  → linearizable
     R + W ≤ M  → eventual
```

**None of this exists in this codebase.** Not a critique — the product doesn't need it yet. Naming the shape lets you spot where it would slot in later.

### Move 2 — the walkthrough

This section explains what would trigger each pattern to become relevant.

#### Replication — when it matters

Replication earns its complexity budget when:

1. **Availability under single-node failure** is a hard requirement. Right now Vercel handles this at the function level — if instance A dies mid-request, the browser retries and gets instance B. No app-level replication needed.

2. **Read-heavy workloads** exceed what one node can serve. Not the case here — every user runs at most one investigation at a time, at ~1 req/s to MCP.

3. **Geographic distribution** requires local reads. Not the case here — one region, one MCP endpoint.

**What would flip this**: a persistent app-owned database (Postgres, etc.) that stored investigation history, user preferences, or shared state. That database would need replication for HA. Vercel Postgres + replicas is the standard shape.

#### Partitioning — when it matters

Sharding earns its budget when a single node can't hold or serve the whole dataset. Two variants:

- **Data partitioning**: rows split by key across nodes (user_id % 4 → shard).
- **Compute partitioning**: work split across workers (job_id → queue).

This repo has neither. The investigation Map has ~10 entries in demo mode; the response cache holds at most a few dozen keys per instance. Below any threshold.

**What would flip this**: multi-tenant investigations where each tenant's cache is large. Partition by session id or by tenant id, key the cache with a prefix, route reads to the right shard.

#### Quorums — when they matter

Quorum reads/writes matter when you have multiple replicas AND you need a stronger consistency than "eventual." R + W > M gives you linearizability across N replicas. See Dynamo, Cassandra, Riak.

This repo has no replicas, so no quorum. If it grew to a shared cache with replicas, and if there were multiple writers, quorum would enter the vocabulary — but a single-writer read-mostly cache doesn't need quorum reads.

#### Failover — the poor-cousin of replication

Failover — "primary fails, promote secondary" — is a lightweight replication story. This repo has one variant of it: the DataSource port lets you fall back from `live-mcp` to `live-synthetic` by URL param (`?mode=live-synthetic`). That's a manual failover, not automatic:

```
  Manual failover via the DataSource port

  URL: ?mode=live-mcp           URL: ?mode=live-synthetic
          │                              │
          ▼                              ▼
   makeDataSource(...)          makeDataSource(...)
          │                              │
   McpDataSource            SyntheticDataSource
   (live network hop)        (in-process fake)

   same interface behind both; agent loop indifferent
```

Not a distributed-systems failover in the coordination sense, but a real substitution seam. See `lib/data-source/index.ts:84`.

#### The auth cookie — a replication substitute

Called out in the map and consistency files, but worth restating: the auth cookie IS effectively replicated across every Vercel instance, because the browser holds it and every instance can decrypt it. That's not "replication" in the protocol sense; it's **the browser as a source of truth, with a shared cryptographic key.**

```
  Cross-instance state without a coordination protocol

  Browser holds cookie ─┐
                        │
                        │  every request rides the cookie
                        │
   ┌────────────────────┼────────────────────┐
   │                    │                    │
   ▼                    ▼                    ▼
 Instance A         Instance B          Instance C
 aesKey(SECRET)     aesKey(SECRET)      aesKey(SECRET)
       ↓                 ↓                    ↓
 decrypts             decrypts            decrypts
 same view            same view           same view

 no gossip. no consensus. no election.
 shared secret = shared truth.
```

This is a design choice worth studying: **encryption under a shared key can substitute for a replication protocol when the state is browser-authoritative and read-mostly.** Stripe uses similar tricks (encrypted session tokens); Rails uses `signed_cookies`. Read `lib/mcp/auth.ts:38-46` for the comment on why.

### Move 3 — the principle

**Not building replication is a valid answer when the product doesn't demand it.** Replication is expensive: a consensus protocol (Raft, Paxos), a coordinator, failover logic, split-brain protection. Any of those cost weeks. If the failure modes your product cares about are already handled by simpler mechanisms — Vercel's platform-level function retries, a per-call timeout, an encrypted cookie for cross-instance state — you don't need distributed-systems machinery. The skill is recognizing when you *would*.

## Primary diagram

The negative space, one frame:

```
  What ISN'T here — the replication surface, drawn to scale

  ┌─ what IS here ─────────────────────────────────────────┐
  │  browser owns durable state                             │
  │  Vercel instances (stateless workers, platform-scaled)  │
  │  60s response cache PER instance (unshared)             │
  │  encrypted auth cookie (shared-key read across insts)   │
  │  one MCP server URL (opaque; may be N behind LB)        │
  └────────────────────────────────────────────────────────┘

  ┌─ what would earn a replication story ──────────────────┐
  │  ★ app-owned database (currently: none)                 │
  │      would need: replicas for HA, WAL streaming         │
  │                                                         │
  │  ★ shared cross-instance cache (currently: none)        │
  │      would need: shared KV (Vercel KV, Redis)           │
  │      quorum only if multi-writer                        │
  │                                                         │
  │  ★ multi-region deploy (currently: single region)       │
  │      would need: geo-replicated data, tail-latency LB   │
  │                                                         │
  │  ★ background job queue (currently: none)               │
  │      would need: durable queue with at-least-once       │
  │      + idempotency keys                                 │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

The vocabulary this file names — replication, partitioning, quorums, failover, split-brain — is the whole heart of the CAP theorem and its descendants (PACELC). Cassandra, DynamoDB, Kafka, etcd, CockroachDB all trade off replicas vs latency vs consistency along these axes.

The reason this repo doesn't have any of it: **the state that matters lives in the browser or in the tenant's MCP server**, neither of which is our replication problem. The app is stateless in the strict sense. Vercel handles scale, the browser handles durability, the MCP server handles its own consistency.

**When this becomes relevant**: the moment the app owns a datastore. Investigation history stored per-user for search, team-level shared insights, saved queries — any of those adds a database, and a production database needs a replica for HA. Then partitioning (by tenant), then quorums (if multi-writer). See `study-database-systems` for the storage-side vocabulary.

## Interview defense

**Q: "Does your system have replicas?"**

A: Not in the coordination sense. Vercel runs my functions in multiple instances for scale, but they're independent stateless workers — no leader-follower, no gossip, no quorum. The only cross-instance state is the encrypted auth cookie, which achieves consistency by construction (shared AES key, browser-durable value) rather than by protocol.

**Q: "Why not?"**

A: The product doesn't hold any app-owned durable state yet. Investigation history is either per-instance in-memory (opportunistic, lost on cold start) or in a committed demo snapshot (read-only). There's nothing worth replicating. When the app grows a database — for user history, saved insights, team sharing — replicas become the first HA move, and I'd reach for Vercel Postgres with a read replica or a hosted Postgres with WAL streaming.

**Q: "What about the MCP server itself — is it replicated?"**

A: From our vantage point, we see one URL. The Bloomreach team may run it behind a load balancer with multiple backends, but that's transparent to us. What we *do* handle is the failure profile that any single-URL endpoint exposes: timeouts, rate limits, 5xx. The retry ladder is our answer to "one endpoint can fail" without needing our own replication story.

## See also

- `01-distributed-system-map.md` — the map that shows why replication isn't needed here.
- `04-consistency-models-and-staleness.md` — the auth cookie's cross-instance consistency.
- `study-database-systems` — where replication would live if the app grew a datastore.
