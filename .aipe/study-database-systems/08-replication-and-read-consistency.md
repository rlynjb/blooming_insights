# Replication and Read Consistency

## Subtitle

How a database keeps multiple copies of data in sync and what reads see across them · Industry standard.

## Zoom out, then zoom in

```
  Zoom out — where replication sits in a normal app

  ┌─ App ──────────────────────────────────────────┐
  │  one read query, one write query               │
  └──────────────┬───────────────┬─────────────────┘
                 │ writes go here │ reads can go here
  ┌─ Primary ───▼────┐  ┌─ Replica ▼─────────┐
  │  accepts writes  │  │  reads from log    │
  └────┬─────────────┘  └────────────────────┘
       │ WAL stream
       └─────────────────────────────────►
                                ★ THIS GUIDE ★
                              (lag, consistency
                               level, failover)
```

### Verdict for this codebase

**Not yet exercised in the database sense — but the same FAMILY of problem (read consistency across multiple stores) does exist here, and it's the second-most-real database concern we have after the rate limit (06).**

There is no primary database, so no replica. What we DO have, that exhibits the same shape of problem: **every warm Vercel instance has its own in-memory state.** Two users hitting two instances see two different "current briefings" — not because of replication lag, but because there's no shared store at all.

This is one altitude up from classical replication. Classical replication: one primary, N replicas, eventually consistent under network lag. Ours: N stateless functions, each with their own private cache, no replica relationship at all. The reader-side problem (stale data, divergence) is the same family — the cause is different.

### When this becomes load-bearing

```
  triggers that make replication / consistency a real concern

  shared rate-limit budget across instances (already named in 06)
     → no shared store today; each instance counts independently

  saved insights visible across instances
     → as soon as state is per-user-durable, "which copy do I read"
       becomes a real question

  read replicas to scale reads
     → only matters once primary is the bottleneck; not us yet

  multi-region deployment
     → cross-region lag is measured in tens of ms; matters for
       read-after-write UX
```

## Structure pass

```
  axis: "if I write here, when can a different reader see it?"

  ┌─ same Map in same instance ───────────────┐
  │  immediately. same memory, no network.    │  → strong, no lag
  └────────────────────────────────────────────┘
                                  │
                                  │  cross an instance boundary
                                  ▼
  ┌─ different Vercel instance ──────────────┐
  │  never (today). no shared store; the     │  → no consistency at all
  │  other instance has its own private Map. │     — different "truths"
  └───────────────────────────────────────────┘
                                  │
                                  │  if we had a shared store
                                  ▼
  ┌─ shared store (e.g. Vercel KV) ──────────┐
  │  immediately (KV is strongly consistent  │  → strong consistency at
  │  within a region) or after ~ms (cross-   │     cost of a network hop
  │  region replication)                     │
  └───────────────────────────────────────────┘
                                  │
                                  │  if we add Postgres + read replicas
                                  ▼
  ┌─ Postgres primary + replica ─────────────┐
  │  writes hit primary. replicas trail by   │  → eventual consistency;
  │  WAL ship latency (typically <100ms).     │     "read your writes" may
  │  read-after-write on a replica can miss   │     fail on replica unless
  │  the just-written row.                    │     you route reads to primary
  └───────────────────────────────────────────┘
```

The seam is each storage boundary. Each one changes the answer to "when can a different reader see my write."

## How it works

### Move 1 — the mental model

A primary database accepts writes. Each write goes into the WAL. Replicas stream the WAL and apply it to their own copy. Reads from replicas see whatever the WAL has shipped so far — which is "the primary as of `now - lag`."

```
  the pattern — primary + replica via WAL streaming

       writes ──► primary ──► WAL ──► network ──► replica
                                                    │
                                                    ▼
                                                 read

       lag = network RTT + replica apply time
       typically <100ms for healthy systems
       can spike to seconds under load
```

The contract the replica makes: "I'm at most `lag` seconds behind the primary." The contract it does NOT make: "if you read from me right after writing to the primary, you'll see your write." That guarantee is **read-your-writes**, and it requires extra work — usually routing reads-after-writes back to the primary for a short window.

### Move 2 — the moving parts

**Move 2a — sync vs async replication.** Sync: primary waits for replica to ack the WAL before returning COMMIT. Strong durability, slow commits, single-replica-failure stalls writes. Async: primary returns immediately, replica catches up later. Fast commits, possible data loss on primary failure.

**Move 2b — consistency levels for the read path.**

- **eventual** — eventually all replicas converge. No "when" promised. Default for most replicated systems.
- **read-your-writes** — your own writes are visible to your subsequent reads. Implemented by sticky-session-to-primary or by a per-client high-water-mark.
- **monotonic reads** — you never see time go backwards. Once you've seen a row at v=5, you won't later see v=4 from a lagged replica.
- **strong / linearizable** — reads always see the latest committed value. Expensive; usually only the primary can serve these.

**Move 2c — failover.** Primary dies. A replica is promoted. Outstanding writes that hadn't shipped yet are lost (async) or ack-blocked (sync). Failover orchestration is a hard problem — split-brain (two nodes both think they're primary) is the canonical failure mode.

```
  bridge: think of a master React Query cache + multiple browser tabs. one
          tab mutates, optimistically updates its own cache, then revalidates
          from the server. other tabs don't see the change until they
          revalidate too. tabs are "replicas"; the server is "primary."
          mental model transfers exactly — you've already shipped this.
```

**Move 2d — the codebase's version of this problem (the real teaching here).**

We don't have a primary. We don't have replicas. We have N stateless serverless instances, each with their own Maps. The shape is:

```
  shape — divergence-by-design

  user A's briefing request → instance 1
        instance 1's putInsights() fills its Map with insights {A1, A2, A3}

  user B's investigation request → instance 2
        instance 2 looks up insight A1 in its Map — NOT THERE
        instance 2 falls through to the demo file, or to the client-sent blob

  user A's next investigation request → instance 3 (different again)
        instance 3 has neither A1 in its Map nor a sticky route to instance 1
        falls through to the client-sent blob (?insight=... query param)

  → the SOLE consistency guarantee here is "the client sends the data with
     every request." that's why app/api/agent/route.ts L37-47 exists — it's
     a "carry your own state" pattern that bypasses the server's lack of
     shared store.
```

This is closer to **stateless web architecture circa 2005 with cookies as the state vehicle** than it is to anything modern replicated. Which is correct for the scale, but you should know that's what you're shipping.

### Move 3 — the principle

**Read consistency is a contract about WHEN, not IF.** Every multi-copy system gives up some "when" — the only choice is which guarantee you buy and at what cost. Strong consistency costs latency. Eventual costs UX surprises. Read-your-writes costs routing complexity. Whichever you pick, the application has to be designed knowing which guarantee it has. The mistake is assuming "the data will be there" without naming the contract — and that's exactly the kind of mistake this codebase would make under load, today, because no contract is named.

## Primary diagram

```
  blooming insights — multi-instance divergence (the real shape)

  ┌─ user A's browser ──────┐         ┌─ user B's browser ──────┐
  │  sessionStorage holds   │         │  sessionStorage holds   │
  │  {A1, A2, A3}           │         │  {B1, B2}                │
  └────────────┬────────────┘         └────────────┬────────────┘
               │                                    │
               │  HTTP                              │  HTTP
               ▼                                    ▼
       ┌─ Vercel ─────────────────────────────────────────────────┐
       │                                                            │
       │  instance 1                  instance 2                    │
       │  ┌──────────────┐            ┌──────────────┐              │
       │  │ Map A1,A2,A3 │            │ Map B1,B2    │              │
       │  └──────────────┘            └──────────────┘              │
       │       ↑                            ↑                       │
       │       │ no shared store, no replication, no failover       │
       │       │                                                    │
       └───────┴────────────────────────────────────────────────────┘
                              │
                              ▼
                       ┌─ Bloomreach ─┐
                       │  the actual  │
                       │  source of   │
                       │  truth       │
                       └──────────────┘

  consistency model: "client carries its own state via cookies + query params."
  contract: weak. no "read your writes" on the server side.
  this works because users don't expect cross-instance state today.
```

## Implementation in codebase

### Use cases

- **Cross-request investigation lookup** uses three fallbacks because the server can't be trusted to have the state (`app/api/agent/route.ts` L37-47):
  1. `?insight=...` query param (client-sent blob)
  2. `getAnomaly(insightId)` / `getInsight(insightId)` from the in-memory Map (this-instance hit, otherwise miss)
  3. Demo fixture lookup

### Code side by side

```
  app/api/agent/route.ts  (lines 37–62)

  function resolveAnomaly(insightId, insightParam?) {
    if (insightParam) {                          ← FIRST TRY: client-sent blob.
      try {                                         this is the "consistency
        const i = JSON.parse(insightParam) as Insight;
        if (i && ...validates...) {                fix" — every request carries
          return insightToAnomaly(i);              its own data, so cross-
        }                                          instance lookup becomes
      } catch { /* fall through */ }              moot.
    }
    const a = getAnomaly(insightId);             ← SECOND TRY: in-memory.
    if (a) return a;                                only works on same instance
    const i = getInsight(insightId);                that ran the briefing.
    if (i) return insightToAnomaly(i);
    try {                                        ← THIRD TRY: demo file.
      if (existsSync(DEMO_FILE)) { ... }            committed fixture; always
    } catch { /* ignore */ }                       present, never "correct"
    return null;                                    for a live briefing.
  }
       │
       └─ the three-tier fallback IS the consistency model. the comment in
          the source ("the only source that survives Vercel's per-instance
          memory") names the problem explicitly. without the client-carried
          blob, this function would return null whenever the user's next
          request hit a different instance than the briefing did — which is
          most of the time on a scaled-out deployment.
```

```
  app/api/briefing/route.ts (the briefing happens here; insights are
                              written to instance-local state)

  // somewhere in the stream handler:
  const insights = anomalies.map(anomalyToInsight);
  putInsights(insights, anomalies);              ← writes to THIS instance's Map.
  for (const insight of listInsights())            no other instance sees these
    send({ type: 'insight', insight });           insights at any consistency
                                                   level.
       │
       └─ each call to /api/briefing produces a "current briefing" that is
          local to one instance. there is no "the" current briefing across
          the deployment.
```

## Elaborate

Replication algorithms divide into log-shipping (Postgres, MySQL) and consensus-based (Raft in CockroachDB, Paxos in Spanner). Log-shipping is simpler and faster but doesn't handle primary-failover gracefully without external orchestration. Consensus is slower per write but handles failover automatically — every write goes through a quorum, so there's no question who's primary.

For blooming insights, the relevant migration when consistency matters is to a single shared store (Vercel KV / Upstash). That gives you strong consistency within a region for free — KV writes are linearizable on the primary, and reads see your writes immediately. You don't need replication; you need shared state. The day you outgrow KV is the day you need Postgres + replicas, which is a different conversation again.

Cross-link: `study-distributed-systems` owns the consensus / log-shipping deep dive. This file is just the consistency contract.

## Interview defense

**Q: "What's your read consistency story?"**
Per-instance Maps with a client-carried fallback. There's no shared store, so two requests on two instances see two different "current briefings" — that's by design at this scale, not a bug, but it's a sharp edge. The mitigation is `app/api/agent/route.ts` L37-47: every navigation from the feed to an investigation carries the insight blob in a query param, so the investigation route doesn't have to find the insight in shared state — it just unpacks the blob the client sent. The honest framing is "the client is the source of truth between the feed render and the investigation request."

Diagram: the multi-instance picture with the client-carry arrow drawn explicitly.

Anchor: `app/api/agent/route.ts` L37-47.

**Q: "If you added saved insights with Postgres, what consistency level would you read at?"**
Read-your-writes from the same web session. Route all reads to the primary for a user who's just written, by a sticky-session token or by a "wrote within last 30s" cookie. Other users' reads can hit replicas. This is the standard recipe for a read-mostly workload that needs UX-level consistency without paying primary-lookup latency on every read.

Diagram: primary + replica with a routed-to-primary arrow for fresh writes.

Anchor: hypothetical; flag in interview.

## See also

- `06-locks-mvcc-and-concurrency-control` — the same problem at a finer altitude
- `07-wal-durability-and-recovery` — replication ships the WAL
- `01-database-systems-map` — the per-instance Maps that DON'T replicate
- `study-distributed-systems` — consensus algorithms when you need them
- `study-system-design` — when to reach for KV vs Postgres vs nothing

---
