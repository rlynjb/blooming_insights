# 05 — replication, partitioning, quorums

**Industry name(s):** replicas · shards · partition keys · quorum reads/writes · failover
**Type:** Industry standard · Language-agnostic

> **Verdict-first: NOT YET EXERCISED.** blooming insights has **no replication, no partitioning, no quorum protocol, no failover mechanism** — because it has nothing to replicate. There is no database to shard, no Redis cluster to failover, no Cassandra ring to write to with quorum. Vercel runs *multiple instances of the Next.js process* horizontally, but the code treats each instance as if it were the only one — there's no cross-instance state, no leader, no consensus. That isn't a gap to fix; it's the deliberate "no database" architectural choice (see `study-system-design/audit.md#storage-choice-and-durability-boundaries`). This file walks the concepts so they're in your vocabulary, names which Bloomreach-side replication is opaque to us, and pinpoints the *first* feature that would force this whole topic to become real.

---

## Zoom out, then zoom in

```
  Zoom out — the replication picture (what's actually here)

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  one tab → one client → no peers                         │
  │  no replication concern                                  │
  └─────────────────────────┬───────────────────────────────┘
                            │
  ┌─ Service layer ─────────▼───────────────────────────────┐
  │  Vercel runs N instances horizontally                    │
  │  ★ each instance is INDEPENDENT — no shared state ★      │ ← this is the
  │  no leader, no quorum, no failover                       │   topic for us
  │  (this is NOT replication; it's "no coordination")       │
  └─────────────────────────┬───────────────────────────────┘
                            │
  ┌─ Provider layer ────────▼───────────────────────────────┐
  │  Bloomreach MCP — multi-region replication likely, but   │
  │  invisible to us; we see one HTTPS endpoint              │
  │  Anthropic — same: opaque, single-endpoint API           │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** The question this file answers: *if some part of this system needed to be highly available across machines, where would you start?* The honest answer for blooming insights is "you'd start by adding a database and then this whole topic becomes relevant." Today, the topic does not apply. This file teaches the concepts anyway so you can name them in an interview, and so when the first replication-requiring feature arrives you know what to reach for.

---

## Structure pass

**Layers.** Only the service layer is interesting. The client layer is one-user-one-tab; replication doesn't apply. The provider layer is opaque — Bloomreach and Anthropic almost certainly run replicated infrastructure (they'd have to, at their scale), but we see one HTTPS endpoint and have no visibility into how requests are distributed across replicas behind it.

**Axis: who can lose what.** Hold one question across the service layer: *what happens if this instance dies right now, and where does the work resume?* If a Vercel instance dies mid-investigation, the answer is: **nothing resumes**. The in-flight stream errors out at the client. The next request lands on a different instance with an empty Map. The user re-runs from scratch. There's no replica to fail over to because the state isn't replicated anywhere.

**Seams.** Two would-be seams that aren't load-bearing today.

- **Seam: Vercel-instance ↔ Vercel-instance.** The seam where replication *would* live if there were state to replicate. There isn't, so the seam is unused.
- **Seam: our-region ↔ Bloomreach-region.** Geographic seam. Latency varies by where Vercel routes the request from and where Bloomreach serves from. Not under our control. Not visible to our code.

```
  Structure pass — the would-be seams

  ┌─ Vercel inst1 ──┐     ?    ┌─ Vercel inst2 ──┐
  │  Map<id, …>      │ ◄ ──── ► │  Map<id, …>      │   ← no link;
  │                  │           │                  │     no consensus;
  └──────────────────┘           └──────────────────┘     no replication
       │                              │
       │  HTTPS                       │  HTTPS
       ▼                              ▼
  ┌─ Bloomreach API endpoint (opaque single URL) ──────────┐
  │  almost certainly replicated internally                 │
  │  Anthropic too                                          │
  │  we see one URL; their replication is their problem     │
  └─────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You already know that a backup is one extra copy of your data. Replication is the same idea, automated and continuous — multiple machines hold copies, kept in sync, so one dying doesn't lose data and one being slow doesn't slow reads.

```
  The replication kernel — three patterns

  PRIMARY-REPLICA       one machine accepts writes, copies to
                        N read replicas
                        easy to reason about; primary is SPOF for writes

  MULTI-PRIMARY         every machine accepts writes, syncs to all
                        no write SPOF; conflict resolution required
                        (last-write-wins, CRDTs, vector clocks)

  QUORUM (Dynamo-style) write requires W replicas to ack,
                        read requires R, W + R > N for consistency
                        no leader; high availability; tunable

  none of these are exercised in blooming insights — there's
  no state worth replicating yet
```

Partitioning is orthogonal: *what subset of the data does this machine hold?* Partition key picks the shard; routing layer picks the destination. blooming insights has no partitions because there's no data set big enough to need them.

### Move 2 — the moving parts (named, then marked NOT YET EXERCISED)

#### Part 1 — primary-replica

A primary accepts writes; one or more read replicas pull from a replication stream. Replication lag is the staleness window between a write committing on the primary and being visible on the replica. Failover means promoting a replica to primary when the primary dies.

```
  Primary-replica — the kernel

  ┌─ primary ──┐ ── writes ──► ┌─ replica1 ─┐  reads
  │ write log  │ ── stream ───► │  read-only │  served from
  └────────────┘ ── ────────►── └────────────┘  any replica
                              │  ┌─ replica2 ─┐
                              └─►│  read-only │
                                 └────────────┘

  failover: replica promoted to primary when primary dies
  load: reads scale with replica count, writes don't
```

**Status in blooming insights: NOT YET EXERCISED.** Becomes relevant the first time a feature needs durable shared state — a user-facing history of insights ("show me last week's anomalies") would require a database, and that database would want at least one read replica for the briefing's analytical reads.

#### Part 2 — quorum (Dynamo-style)

No leader. Writes require W replicas to ack; reads require R; if W + R > N (total replicas), every read sees the latest write. Trades off latency for availability.

```
  Quorum write — pseudocode

  function write(key, value):
    in parallel, send write to all N replicas
    wait for W acks
    return success  (the other (N-W) replicas eventually catch up)

  function read(key):
    in parallel, read from all N replicas
    wait for R responses
    return the value with the highest version
```

**Status in blooming insights: NOT YET EXERCISED.** Would only become relevant at much larger scale than this app needs — Dynamo, Cassandra, Riak. The "right" first step toward replication for this codebase is a managed database (Postgres, Vercel KV), not a quorum-based store.

#### Part 3 — partitioning (sharding)

Pick a partition key (user_id, organization_id, geographic region). Route each request to the shard that owns its key. Each shard is an independent unit.

```
  Partitioning — the kernel

  request (key=user_42)  ──► router  ──► shard 2 (owns hash(user_42))
  request (key=user_99)  ──► router  ──► shard 0 (owns hash(user_99))

  good partition key:  high cardinality (many distinct values),
                       even distribution (no hot shard),
                       stable (key doesn't change for a record)

  bad partition key:   low cardinality → some shards do all the work
                       skewed → "hot key" problem
                       changing → records have to migrate
```

**Status in blooming insights: NOT YET EXERCISED.** No data is large enough to need partitioning. The natural partition key when it does become relevant is `bi_session` (user-scoped) or `projectId` (workspace-scoped, since Bloomreach is keyed that way). The natural shard would be Vercel KV namespaces or a Postgres schema-per-organization. Not built; not needed yet.

#### Part 4 — failover and the lack-of-leader-election in the codebase

A failover protocol picks a new primary when the current one dies. It requires consensus (Raft, Paxos, or a coordinator like Zookeeper) to avoid split-brain (two primaries thinking they're primary).

```
  Leader election — the question consensus answers

  N nodes; one is supposed to be the leader.
  the current leader's heartbeat stops.
  WHO becomes the next leader, and how do all N agree?

  consensus protocols (Raft, Paxos, ZAB):
    a quorum of N must agree on the new leader
    split-brain is prevented by making the quorum impossible
    for two competing leaders to both achieve
```

**Status in blooming insights: NOT YET EXERCISED.** There IS no leader to elect. No node has a special role. Every Vercel instance is interchangeable; the system simply has no notion of "the instance that owns X." If a feature needed one — for example, a "global lock so two briefings for one user don't run concurrently" — that would force consensus (probably Vercel KV's `SET NX` as a poor-man's lock with TTL, not a real consensus protocol). Not built; not needed.

#### Part 5 — what IS replicated that we can name

Two things in the dependency graph are almost certainly replicated, but invisible to our code.

- **Bloomreach MCP.** A SaaS analytics platform. Inferred: serves traffic from multiple regions, with their own internal replication and routing. We see `https://loomi-mcp-alpha.bloomreach.com/mcp/` and `~1 req/s/user`. Their failover is their problem; if their primary region goes down, our retries either succeed against the failover or fail.
- **Anthropic API.** Same story. Multi-region, multi-tenant, opaque to us. Their availability is their problem.

There's nothing we can do at the codebase to participate in their replication — we're a client, not a peer. The right response to their failure is the partial-failure handling in file 02.

### Move 3 — the principle

**Replication is the answer to "what happens when this dies?" — but only when there's something durable to keep alive.** blooming insights has no durable state outside Bloomreach itself; if the Vercel instance dies, the user retries from scratch and nothing is lost (the briefing was re-derivable; the investigation was re-runnable). Replication is the right tool the moment that stops being true — when there's a feature where "the user wouldn't be able to redo the work." Until then, the right answer to "why no replication?" is "because nothing here would benefit from it" — and saying that plainly is honest distributed-systems thinking, not a confession.

---

## Primary diagram

```
  Replication-shaped concerns in blooming insights — and what they actually look like

  ┌─ within our code ────────────────────────────────────────────────┐
  │                                                                   │
  │  Vercel inst1   inst2   inst3   inst4    (N instances)            │
  │      │           │       │       │                                │
  │      │           │       │       │                                │
  │  ★ each one independent — no leader, no peers ★                    │
  │  ★ in-memory state is per-instance ★                              │
  │                                                                   │
  │  REPLICATION:        not exercised                                │
  │  PARTITIONING:       not exercised                                │
  │  QUORUMS:            not exercised                                │
  │  LEADER ELECTION:    not exercised                                │
  │  FAILOVER:           not exercised                                │
  │                                                                   │
  └─────────────────────────┬────────────────────────────────────────┘
                            │  HTTPS
                            ▼
  ┌─ external (opaque) ──────────────────────────────────────────────┐
  │                                                                   │
  │  Bloomreach MCP:    almost certainly replicated internally;        │
  │                     we see one endpoint                            │
  │  Anthropic API:     same                                           │
  │  Bloomreach IdP:    same                                           │
  │                                                                   │
  │  their replication is their problem; we see failures and retry     │
  └───────────────────────────────────────────────────────────────────┘

  what would force this picture to change:
    feature requiring durable shared state
    → add Postgres or Vercel KV
    → that database has replicas
    → THEN this file becomes load-bearing
```

---

## Implementation in codebase

**Use cases.**

There are none today. Every file path that would normally appear here — connection pools to a primary, read-replica routing, quorum-write configuration, failover handlers — does not exist. The closest thing to "instance-aware logic" is the comment in `lib/mcp/auth.ts:38-104` explaining that the encrypted cookie backend exists precisely *because* there's no cross-instance store, and the auth flow has to survive Vercel routing the connect and callback requests to different instances.

**Code side by side.**

The only place the codebase acknowledges horizontal scaling is in the auth backend selection. Here's the seam between "single-process dev" and "multi-instance production" — and the choice the code makes about it:

```
  lib/mcp/auth.ts  (lines 22-36, 38-104)

  // Storage backend, keyed by our app session id. Three backends, selected by env:
  //   • development → a gitignored file (.auth-cache.json).
  //   • test → in-memory Map (isolated per run).
  //   • production (Vercel) → an encrypted httpOnly cookie, via `withAuthCookies`.
  //     The `connect` and `callback` requests run on different ephemeral
  //     instances, so the browser cookie is the only state both can see.
  const PERSIST = process.env.NODE_ENV === 'development';
  const CACHE_FILE = join(process.cwd(), '.auth-cache.json');
  const memStore = new Map<string, SessionAuthState>();
       │
       └─ this comment IS the codebase's only explicit acknowledgment
          that production is multi-instance. The "shared store" for
          the auth flow is the browser cookie — i.e. the client carries
          the state. Same pattern as bi:diag:<id> in useInvestigation.
          NEITHER is replication; both are "push state to where you can
          see it across instances."
```

```
  lib/state/insights.ts  (lines 4-6)

  const insights = new Map<string, Insight>();             ← per-process;
  const investigations = new Map<string, Investigation>();    no replica
  const anomalies = new Map<string, Anomaly>();              no failover
       │
       └─ this is the gap that file 09 (red-flags audit) ranks as the
          #1 distributed-systems risk. It's not "the wrong design"; it's
          "the right design at hackathon scale, with the cost honestly
          named." Adding replication here means adding a database first.
```

---

## Elaborate

The first feature that would force this whole topic to become real: **a shared workspace where two users can see and react to the same briefing.** Currently each user gets their own (per-bi_session) feed. A shared workspace needs: durable storage (database), cross-instance coordination (so user A's mark-as-resolved is visible to user B in real time), and probably read replicas (the dashboard's read load eclipses the briefing's write load by orders of magnitude). That's when you reach for Postgres + a read replica + Vercel KV for pub/sub.

The second feature: **scheduled briefings (cron-style "run the briefing for org X every morning at 8am").** Scheduled jobs need a leader — exactly one Vercel function should fire per schedule. Vercel's own Cron Jobs feature handles this (the platform IS the leader-election protocol); you'd lean on the platform rather than building consensus yourself.

The pattern: blooming insights doesn't avoid distributed-systems work by being clever; it avoids it by not building features that require it. The day the features arrive, the work arrives with them.

---

## Interview defense

**Q: What does your replication strategy look like?**

There isn't one. Every piece of mutable state in this app is either per-process in-memory or per-tab in sessionStorage — there's nothing durable to replicate. The only "shared" state across requests is the encrypted auth cookie, which the client carries. Vercel runs multiple instances horizontally but the app treats them as independent — no leader election, no quorum, no failover protocol. The first feature that needs shared durable state would force me to add a database, and at that point replication becomes a real decision; until then it's deliberately absent.

```
  the honest answer

  no replicas        ←  no shared state
  no quorum          ←  no peers to vote
  no leader election ←  no role to assign
  no failover        ←  nothing to fail over to

  if instance dies mid-flow:
    in-flight stream errors out
    user retries
    nothing was lost (the work was re-derivable)
```

**Q: Bloomreach is presumably multi-region replicated. Does that change anything for you?**

Their replication is opaque to us — we see one HTTPS endpoint. Their failover is their problem, but it lands on us as a partial-failure event: a 5xx or a timeout that we have to handle. File 02 (partial failure) walks the McpClient retry loop that catches this. We don't participate in their replication; we observe its symptoms.

**Q: What's the first feature that would force you to build real replication?**

A shared workspace where two users see the same briefing. That breaks the per-bi_session model — the data has to live somewhere both sessions can read it. Adding Postgres gets you durable storage, and the moment you have Postgres on Vercel, you probably want a read replica for the analytical reads the dashboard does. That's also when leader election becomes relevant for scheduled jobs — running the briefing at 8am for an org needs exactly one Vercel function to fire, and Vercel Cron Jobs handles that for me as platform-level leader election.

---

## Validate

- **Reconstruct.** Name the three replication patterns (primary-replica, multi-primary, quorum) and one place each is used in industry.
- **Explain.** Why does `lib/mcp/auth.ts:22-36`'s comment cite production-multi-instance as the reason for the encrypted cookie backend? Because connect and callback are two HTTP requests, possibly on different instances; the cookie is the only store both can read. It's the same "push state to the client" pattern as bi:diag:<id>.
- **Apply.** A new feature: scheduled briefings (8am daily for each org). What's the leader-election concern? Two Vercel instances both firing the cron means two briefings, double MCP cost, possibly conflicting writes. What's the fix? Vercel Cron Jobs — the platform IS the leader-election protocol; you lean on it rather than building consensus.
- **Defend.** Why doesn't this codebase implement any of this file's mechanisms? Because there's no state worth replicating today. Implementing replication-shaped infrastructure before you have replication-needing state is overengineering; honest distributed-systems thinking names it as deferred, not absent.

---

## See also

- `01-distributed-system-map.md` — Seam B (the cross-instance gap) is the seam this file is about
- `04-consistency-models-and-staleness.md` — consistency models only matter when there are multiple replicas to be consistent across
- `07-clocks-coordination-and-leadership.md` — also NOT YET EXERCISED, for related reasons
- `09-distributed-systems-red-flags-audit.md` — ranks "in-memory state on serverless" as the #1 risk
- `.aipe/study-system-design/audit.md#storage-choice-and-durability-boundaries` — the architectural take on why no database
