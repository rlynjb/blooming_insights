# replication-partitioning-and-quorums

*Data replication · Sharding · Quorum reads · Leader failover · Industry standard*

## Zoom out — where this concept lives

This is where honest calls-outs matter more than manufactured findings.
**Almost every concept in this file is `not yet exercised` in this repo.**
There is no data store you own, no replicas, no partition keys, no quorum
reads, no leader failover. What DOES exist that touches this territory:
Vercel's warm-instance model (which behaves like an unreplicated
partition-of-one that can vanish), and the session-id key (which is a
partition boundary in the tenant sense, not the storage sense).

The value of this file is naming what's absent, WHY it's absent, and WHEN
each concept becomes load-bearing enough to build.

```
  Zoom out — where storage lives (or doesn't)

  ┌─ Client layer ────────────────────────────────────┐
  │  sessionStorage / localStorage / cookies          │
  │  (owned by browser; not replicated anywhere)      │
  └───────────────────────┬───────────────────────────┘
                          │
  ┌─ Service layer ───────▼───────────────────────────┐
  │  in-memory Map<sessionId, SessionFeed>            │
  │  in-memory BloomreachDataSource.cache             │
  │  ★ ONE COPY PER WARM INSTANCE ★                   │ ← we are here
  │  ★ NO REPLICATION, NO QUORUM ★                    │
  └───────────────────────┬───────────────────────────┘
                          │
  ┌─ Provider layer ────────────────────────────────────┐
  │  Bloomreach is our source-of-truth; its              │
  │  internal replication is not our concern.            │
  └──────────────────────────────────────────────────────┘
```

## Structure pass

### Layers of "what does replication mean here?"

```
  "how many copies exist of this data, and how do they agree?"

  ┌───────────────────────────────────────────────┐
  │ committed demo snapshots                       │
  │   lib/state/demo-insights.json                 │  1 copy, in git
  │   lib/state/demo-investigations.json           │  agreement: git
  │   (source of truth for demo mode)              │  version control
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ per-warm-instance in-memory Maps              │
      │   N copies exist iff N warm instances exist   │  N copies, no
      │   agreement: NONE (each instance has its own) │  reconciliation
      └───────────────────────────────────────────────┘
          ┌───────────────────────────────────────────┐
          │ browser sessionStorage                    │
          │   1 copy per tab                          │  N × M copies where
          │   agreement: NONE across tabs/browsers    │  N=tabs, M=browsers
          └───────────────────────────────────────────┘
              ┌───────────────────────────────────────┐
              │ Bloomreach (source of truth)           │
              │   internal replication is OUT OF SCOPE │  (their problem)
              └───────────────────────────────────────┘
```

Every layer either has ONE copy or has MULTIPLE copies with NO
reconciliation. Nowhere is there "N copies, reconciled." Which means
there is no quorum machinery to teach. That's the honest map.

### One axis — "what happens when the storage owner dies?"

```
  "when the storage layer dies, what recovers?"

  ┌───────────────────────────────────────────────┐
  │ committed demo snapshots                       │
  │   dies: git repo lost                          │  recovery: restore
  │                                                │  from backup / origin
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ warm instance                                 │
      │   dies: instance evicted / cold-drained       │  recovery: reissue
      │                                                │  the request; server
      │                                                │  reads client-forward
      │                                                │  payload (see file 04)
      └───────────────────────────────────────────────┘
          ┌───────────────────────────────────────────┐
          │ browser sessionStorage                    │
          │   dies: user closes tab                   │  recovery: NONE
          │                                                │  (redo the whole
          │                                                │   investigation)
          └───────────────────────────────────────────┘
```

The interesting thing this file teaches: **the client-forward payload
IS this system's replication story.** Every request carries the state
forward that the server can't guarantee to have. That is not "N-way
replication with quorum reads." It is "the request itself carries a
copy of the state." Different mechanism, similar goal (survive a
storage layer death).

### Seams

- **The session-id key** at `getOrCreateSessionId()` in
  `lib/mcp/session.ts` — is a partition boundary in the multi-tenant
  sense (partition by tenant), NOT in the storage sense (partition data
  by key hash across nodes). Naming it a "partition" without this
  distinction would be misleading.

- **`lib/state/insights.ts:14` outer Map** — a single-shard tenant
  register. Every session lives on the same warm instance's Map; there
  is no "session X hashes to instance A, session Y hashes to instance
  B" logic. Vercel's routing picks an instance per request without
  guaranteeing stickiness.

- **The DataSource seam again** — because the seam abstracts "who
  fetches Bloomreach data," a future replication scheme (e.g. fanning
  reads across two Bloomreach projects) could ship as a decorator or
  a new adapter without touching the agent layer.

## How it works

### Move 1 — the mental model: single-shard, unreplicated, client-forward

You know how a Redis instance without a replica has one copy of the
data, and if the instance dies the data is gone? That's the
consistency picture of this app's server-side state — one copy per
warm instance, gone when the instance is evicted. The "replication" is
that **every request carries the state forward from the client**, so
the loss of any single instance is recoverable by re-issuing the
request.

```
  The pattern — request-carries-state as poor-man's replication

     client (has copy)
         │
         ▼
     request (carries copy in ?insight= or ?diagnosis=)
         │
         ▼
     warm instance A               warm instance B
         │                              │
         │   (each holds a copy, no     │
         │    coordination between      │
         │    them; instance A dying    │
         │    doesn't lose the state    │
         │    because instance B can    │
         │    still read the client's   │
         │    copy on the next request) │
```

This is what "eventual consistency without replicas" looks like in
practice for a stateless-runtime architecture. It works because the
data is small enough to ride in a request, and because the read pattern
is user-scoped (one user, one browser, one authority).

### Move 2 — walk what's present and what's absent

#### Present: session-id as tenant partition

`lib/mcp/session.ts:16` creates a session-id cookie per browser. Every
piece of server-side state is keyed by this. Reads and writes for
different sessions never touch each other's data:

```typescript
// lib/state/insights.ts:14-23 (excerpt)
const state = new Map<string, SessionFeed>();

function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}
```

Bridge from what you know: this is the same shape as multi-tenant
partition-by-tenant-id in a real DB — the tenant key IS the isolation
boundary. Here it happens in memory, but the pattern is identical.

**What this ISN'T: horizontal sharding.** It doesn't distribute
sessions across nodes. All sessions on a warm instance share that
instance's memory. If Vercel spins up more instances, each instance
serves whatever sessions land on it — the routing is at Vercel's
layer, not ours.

#### Present: BloomreachDataSource.cache as instance-local shard

Same instance-locality. Two warm instances serving the same session-id
each cache tool results independently. Section 03 walked this from the
delivery-semantics angle; the consistency angle is: **you have as
many cache copies as warm instances, and they never reconcile.**

Why it's fine: 60s TTL bounds the staleness, and the underlying calls
are read-only so a stale copy is an older number, not a wrong write.

#### Absent: horizontal sharding by data key

There is no sharding logic. No consistent hashing. No shard registry.
Nothing computes `shard = hash(key) % N` anywhere. This is the correct
choice for the current scale — one user at a time, one investigation
at a time, no shared data across users.

When it becomes load-bearing: as soon as you introduce a persistent
data store that outgrows one node (say, storing every historical
investigation in a Postgres table that grows past what one primary
can serve). At that point you'd shard by session-id or user-id and
this file would grow real content.

#### Absent: replication with quorum reads / writes

Zero. There is no N-way replication. There is no quorum. There is no
leader with followers. The client-forward pattern in file 04 is the
closest analog, and it's not the same mechanism — it's "the request
carries a copy" not "the store has N copies."

When it becomes load-bearing: any owned data store that must survive
a single-node failure. The moment you write data you can't tolerate
losing, you need a replicated log or a replicated data store, and the
quorum conversation starts. `not yet exercised` today; would be if
this app grew a "history of every investigation this user has ever
run" feature backed by persistent storage.

#### Absent: leader election / failover

There is no leader. Nothing votes. Nothing has a term. The only
"leadership" concept in the system is the single Anthropic model call
per turn, which is not distributed at all — it's sequential.

When it becomes load-bearing: any coordinator role that must be
singleton (a job scheduler, a background reconciler, a single
consumer for an event stream). Common pattern: use Postgres SKIP
LOCKED or Redis SETNX as poor-man's leader election. Not needed here
because there's nothing that must be a singleton beyond "the one
person using the app right now."

#### The demo snapshot — the closest thing to a replica

`lib/state/demo-insights.json` and `lib/state/demo-investigations.json`
are committed files. Every deployment has an identical copy. In the
loosest sense, this is "replicated" — the file is in git, so every
Vercel instance's filesystem has the same bytes. But this isn't
replication in the distributed-systems sense; it's just deployment.
The file is read-only at runtime. There is no reconciliation, no
version vector, no write path.

Where it looks like consistency: the demo path at
`/api/briefing?demo=cached` replays this snapshot as an NDJSON stream
(`app/api/briefing/route.ts:78-152`), so every user in demo mode sees
the identical replay. That IS "consistent across users" but only
because the source of truth is a static file in git.

### The skeleton — what a shipped replication story would need

Because most concepts are absent, the interview move is to name what
WOULD be needed if any of them shipped. The kernel of a real
replication story:

1. **A durable log** — writes are appended to an ordered log before
   they're considered committed. WAL, Kafka topic, event stream.
2. **N replicas of the log** — followers apply entries in the same
   order the leader wrote them. Same log → same state.
3. **A quorum rule** — reads see committed data (majority-read) or
   accept staleness (single-replica read). Writes ack after N/2+1
   replicas confirm.
4. **A leader election** — one replica is the writer at a time;
   failover elects a new one when it dies.

Named by what breaks if missing:
- **no log** → writes can be interleaved differently across replicas;
  no consistent history to reconcile
- **no replicas** → single-node failure loses the data
- **no quorum** → readers see stale replicas without knowing it
- **no leader** → split-brain: two nodes both accept writes,
  histories diverge

Naming these — even in absentia — is the value of this file.
Recognizing them the day you need them is worth more than pretending
they're here now.

### Move 3 — the principle

**Don't manufacture distributed-systems findings to fill a template.**
The honest map of THIS repo is "one warm instance, no replicas, the
client is the durable copy." That's a legitimate architecture for a
one-user-per-investigation product, and it earns its place by
matching the scale. The lesson isn't "you should build sharding
now." The lesson is: **know which line you're on**, know what each
missing concept would cost to add, and add it the day the scale
demands it — not before.

## Primary diagram — what's present, what's absent

```
  Replication + partitioning, one honest frame

  ┌─ Committed to git (deployment-time "replication") ──────────────────┐
  │  lib/state/demo-insights.json           read-only, identical         │
  │  lib/state/demo-investigations.json     across every Vercel instance │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ Client-side (per-browser copy) ────────────────────────────────────┐
  │  sessionStorage — per-tab                                            │
  │  localStorage    — per-domain                                        │
  │  cookies         — sent with each request                            │
  │  (N users × M tabs = N × M copies, no reconciliation)                │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ Warm instances (per-instance in-memory copy) ──────────────────────┐
  │                                                                      │
  │   instance A                    instance B                           │
  │   ├─ state<sid, feed>           ├─ state<sid, feed>                  │
  │   ├─ BloomreachDataSource       ├─ BloomreachDataSource              │
  │   │  .cache                     │  .cache                            │
  │   │                             │                                    │
  │   │  ← independent copies →                                          │
  │   │  ← no reconciliation →                                           │
  │   │  ← 60s TTL bounds staleness →                                    │
  │                                                                      │
  │  partitioning: sessions are keyed by cookie sid                      │
  │  sharding:     NONE (all sessions live on whichever instance         │
  │                Vercel routes them to)                                │
  │  replication:  NONE (no shared store; instances don't sync)          │
  │  quorum:       NONE (no votes; no consensus)                         │
  │  leader:       NONE (nothing has a term)                             │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ Bloomreach (source of truth) ──────────────────────────────────────┐
  │  Internal replication is Bloomreach's concern, not ours.             │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern of "no shared store, request-carries-state" is a specific
architectural choice. It works when:

- **the data is small** enough to fit in a request or a cookie
- **the read pattern is user-scoped** — no cross-user reads that need
  fresh shared state
- **the write pattern is user-owned** — the user's own actions produce
  the data; no background writer

When any of these breaks, you need a real shared store. This app has
never crossed the line. If it did — say, added a "team view" where
multiple users see a shared workspace analysis — the natural first
move would be:

1. Vercel KV or Upstash Redis for the shared state (managed,
   serverless-friendly, no replication for you to manage)
2. Read from the shared store instead of the in-memory Map
3. Accept eventual consistency; the KV product handles the
   replication and quorum internally

That's a "buy replication as a service" move rather than "build a
replicated log." Which is the correct move for a team of one shipping
a product, not building a database.

Where this file gets rewritten:
- when persistent storage ships (whether it's a Postgres investigation
  history, a Vercel KV, or a Bloomreach webhook receiver that must
  durably capture events)
- when the app grows fan-out to multiple upstream systems (a second
  MCP server, a comparison-analytics API), which introduces
  partition-per-upstream and possibly cross-upstream quorum reads

## Interview defense

### Q: "How does this app handle replication?"

Direct answer:

"It doesn't. There is no data store I own, so there's nothing to
replicate. The closest analog is that every request carries the state
forward from the client — the insight object rides `?insight=<JSON>`,
the diagnosis rides `?diagnosis=<JSON>`. That's not replication in
the storage sense; it's request-carries-state, which works because
the data is small and the read pattern is user-scoped. The moment I
ship persistent per-user history, the natural move is Vercel KV or
Upstash Redis — buy replication as a service rather than build it."

Sketch:

```
     no shared store
          │
          ▼
     each request carries a copy from client
          │
          ▼
     server reads client-forward payload
          │
          ▼
     falls back to in-memory Map (this instance)
     falls back to committed demo snapshot
```

### Q: "What happens if a warm instance dies mid-investigation?"

"The client re-issues the request; the server reconstructs from the
client-forward payload. If the investigation is caught by
`useInvestigation` deliberately NOT cancelling the in-flight fetch on
StrictMode cleanup, the ongoing stream continues on whichever instance
served it. If that instance dies, the stream ends abruptly and the
client sees a truncated NDJSON — the UI shows an error, the user
retries, and the fresh request lands on a new instance which reads
the client's stashed insight from `?insight=<JSON>`. No data loss;
one lost investigation-attempt of wall-clock time."

### Q: "When would you add sharding?"

"When one warm instance's memory can't hold the working set. Concretely:
if I shipped a 'history of every investigation this user has ever run'
feature backed by persistent storage, and that history grew past what
one Postgres primary could serve. I'd shard by user id — same hash,
same shard for a given user's data. Session-scoped writes stay on
one shard. Cross-user reads (team view) need a fan-out. Not needed
today."

## See also

- 04-consistency-models-and-staleness.md — the client-forward pattern
  from the consistency angle
- 07-clocks-coordination-and-leadership.md — no leader election here,
  named honestly
- 09-distributed-systems-red-flags-audit.md — "no shared store" as a
  future risk conditional on product growth
