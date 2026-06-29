# Replication, partitioning, and quorums

*Industry standard — replicas, shards, partition keys, quorum reads/writes, failover.*

## Verdict — `not yet exercised`

The repo has zero replication, zero partitioning, zero quorum machinery, and no datastore it owns. This file exists to draw the absent picture honestly, explain why it's the right shape today, and name the one place where the topic *would* show up if it shipped.

```
  Zoom out — the entire datastore picture

  ┌─ L1: Browser ────────────────────────────────────────────┐
  │  sessionStorage (per-tab, per-origin)                     │
  │  → no replication, no partitioning, no quorum             │
  └─────────────────────────────────────────────────────────┘
                            │
  ┌─ L2: Vercel route ──────▼────────────────────────────────┐
  │  in-memory Maps (per warm instance, session-keyed)        │
  │  ★ no replication ★  → cold restart wipes everything      │
  │  ★ no partitioning ★ → no sharding key, no fan-out        │
  │  ★ no quorum ★      → no replica to agree with             │
  │                                                          │
  │  encrypted cookie (carries OAuth state across instances)  │
  │  → state-on-the-client, not state-on-replicas             │
  └─────────────────────────────────────────────────────────┘
                            │
  ┌─ L3: BloomreachDataSource ──────────────────────────────┐
  │  per-request 60s response cache                           │
  │  → ephemeral, not replicated                              │
  └─────────────────────────────────────────────────────────┘
                            │
  ┌─ L4: Bloomreach MCP ────▼───────────────────────────────┐
  │  workspace store: we don't own it; their replication      │
  │   is opaque to us                                         │
  └─────────────────────────────────────────────────────────┘
```

There is no row in this stack where we choose `(replication factor, partition strategy, quorum)`. That's by design for the product shape today.

## Zoom in — the question this file answers

> What would replication, partitioning, or quorums *be doing* in this codebase if they existed, and why is it correct that they don't?

Three answers: (1) we don't own a datastore, so there's nothing to replicate; (2) we don't have a workload that needs partitioning, because state is per-session and bounded; (3) we don't have multiple writers to agree, so quorums don't apply. The whole topic is `not yet exercised` because we're upstream of every datastore in the design.

## Structure pass — the skeleton (of an absent thing)

### Axes — trace "who owns the data?"

```
  One axis: "who owns the data on this layer?"

  L1 sessionStorage      browser (single owner — the user's tab)
  L2 in-memory Maps      one Vercel instance (single owner per process)
  L2 encrypted cookie    browser (single owner — the user)
  L3 response cache      one request (single owner — the adapter)
  L4 Bloomreach store    Bloomreach (single owner from our perspective)
```

Every layer has *one* owner from the system's perspective. No row reads "two replicas agree on …" or "the shard for tenant X lives on …" — because we never reach that shape. **When the owner is always one, replication / partitioning / quorums never light up.**

### Seams — where replication *would* attach

```
  Where the topic WOULD show up if the product grew it

  if/when…                                this file would teach…
  ──────────                              ─────────────────────
  multi-region Vercel deployment           sticky routing vs. read-from-edge
   (today: single region, irrelevant)      replicas vs. a global store

  shared cache across instances            consistent hashing for partitioning,
   (today: per-instance Maps)               primary-replica or leaderless writes

  user data stored server-side             RPO/RTO, sync vs. async replication,
   (today: cookie + sessionStorage)         quorum reads (R+W>N)

  scaling Bloomreach                       not ours to design — opaque
   (their infra problem)

  scaling Anthropic                        not ours to design — opaque
   (their infra problem)
```

The four "if/when" rows are the realistic adjacent futures. Three of them are deferrals on the product side, not engineering omissions. The fourth (Bloomreach) is permanently somebody else's problem.

## How it works — what the absent picture looks like

### Move 1 — the mental model

> **Replication, partitioning, and quorums are the answer to: "I have data, multiple machines, and I want either survival or scale." This codebase doesn't own data on multiple machines, so the question never arises.**

```
  The triple, drawn against absence

  REPLICATION    answers: "what survives if one machine dies?"
                 here:    nothing survives a cold restart — the
                          design accepts this and re-resolves from
                          the client / the demo snapshot

  PARTITIONING   answers: "how do I split work across machines?"
                 here:    no work to split — each user's request
                          is independent, scoped by sessionId,
                          handled on one instance start-to-finish

  QUORUMS        answers: "how do I get agreement across replicas?"
                 here:    no replicas, no disagreement possible —
                          single owner per layer
```

This is *not* a hand-wave. It's a deliberate posture: pushing state to the client and the opaque upstream means we don't run the replicated/sharded/quorum-managed parts of the system, so we don't owe the corresponding correctness work.

### Move 2 — walk what's not there, one by one

#### Part 1 — no datastore we own (so no replication question)

```
  The five things that could be "data we own" — and what each is today

  candidate                       reality                          ours?
  ────────────                     ────────                          ─────
  user accounts                   none; identity is the bi_session     NO
                                  cookie + Bloomreach OAuth

  briefings + insights            transient in-memory Maps;            NO
                                  rebuild from Bloomreach or demo

  investigations                  cached in-memory + dev file;         NO
                                  rebuild from Bloomreach or demo

  audit logs / events             not persisted; per-phase             NO
                                  console.log only (Vercel logs
                                  are the retention story)

  user content (e.g. saved        not in the product today              N/A
   queries, dashboards)
```

Every row is `NO`. **Without owned data, replication has nothing to replicate.** The state we *do* keep transiently lives on one machine for the duration of one warm-instance lifetime — and the design accepts that loss.

The two pieces of state that *do* need to survive across machines are handled differently:
- **OAuth state** survives via an encrypted cookie carried by the browser (`lib/mcp/auth.ts:38-104`). The cookie is the "shared store" — *the client is the replication target*. See file 07.
- **Investigation handoff state** survives via the browser's `sessionStorage` and the URL params (`?insight=`, `?diagnosis=`). Same trick — *the client is the carrier*. See file 03 and file 01.

This is a real design pattern with a name: **state on the client, not on replicas.** It works when (a) the state is per-user, (b) the client can be trusted with it (or it's encrypted), and (c) the state isn't large enough to bloat every request. All three hold here.

#### Part 2 — no partitioning (because there's no shared workload)

```
  Partitioning kicks in when…                  …here, instead:

  …one user's data is too large for             every user's request fits in
  one machine                                   the 300s route budget on
                                                one instance

  …throughput exceeds one machine's CPU         Vercel auto-scales instances;
                                                each instance handles one
                                                request at a time (functionally)

  …a query needs to fan-out across              every query touches one
  multiple shards                               Bloomreach project (the EQL
                                                runs server-side, not by us)
```

There's nothing to partition because each request is **independent, bounded, and one-owner**. The session is the natural partition key — and Vercel's request routing partitions for us implicitly by hashing the request to *some* instance.

What we don't get for free is **stickiness**: a follow-up request on the same session can land on a different instance, which is the cold-cache hazard from file 04. The fix the codebase chose: *don't rely on stickiness* — design every state read with a "where else could this come from?" fallback. The three-source `resolveAnomaly` (`app/api/agent/route.ts:30-62`) is the canonical example.

#### Part 3 — no quorums (because there are no replicas to agree)

A quorum is a mechanism for *multiple replicas of the same logical value to agree on the current value*. Examples: Raft (leader-elected log replication), Paxos (proposers/acceptors/learners), Dynamo-style (R + W > N).

The whole list is `not yet exercised`:

```
  Quorum mechanisms — none present, none planned

  ─────────────────────────────────────────────────────────
  Raft / Paxos consensus           not present
  Leader election                  not present
  Distributed locks                not present
  R+W > N quorum reads/writes      not present
  Hinted handoff                   not present
  Read repair / anti-entropy       not present
  Vector clocks / version vectors  not present
  ─────────────────────────────────────────────────────────
```

The single-owner property at every layer is what closes the door on this whole family. **If you find yourself wanting a vector clock, you have multiple writers; if you have multiple writers in this system, the design has slipped.**

#### Part 4 — Bloomreach's replication is opaque (and that's correct)

We *are* a client of a replicated, partitioned, quorum-managed system: Bloomreach Engagement is a multi-tenant data platform, almost certainly running with replication and partitioning for its workspace data. **We just don't get to see or design any of it.**

What we do see:
- Reads are *eventually consistent* (events written elsewhere appear in our EQL after some ingest delay)
- Rate-limits are *global per user* — implying their backend coordinates a counter across whatever shard fan-out exists
- Errors surface as `isError: true` envelopes — we don't see partial-quorum semantics

The discipline: **treat the upstream as a black box with documented behavior; don't bake assumptions about its internals into our code.** The retry ladder and the 60s cache don't care whether Bloomreach is one machine or ten thousand.

### Move 2.5 — current state vs future state

```
  Today                                Tomorrow (the realistic next step)
  ──────────────────────────           ─────────────────────────────────────
  no datastore we own                  if we add user accounts / saved
                                        queries / persisted insights:
                                        the question becomes "Postgres
                                        single instance or replicated?"
                                        — answer probably "single instance
                                        first, replicate when RPO matters"

  no replication                       same: defer replication until
                                        there's data worth surviving

  no partitioning                      same: a single Postgres handles
                                        many orders of magnitude more
                                        sessions than this product needs

  no quorums                           same: single-writer, single-reader
                                        is fine for the product's scale
```

The next step on this axis isn't "add Raft." It's "add Postgres (single instance) when we have data worth keeping." Quorums would come — if ever — *much* later, behind a real RPO/RTO requirement we don't have today.

### Move 3 — the principle

> **The cheapest distributed-systems property is the one you don't have to provide. Push state to the upstream you don't own (Bloomreach) and the client you do (encrypted cookie + sessionStorage), and the replication/partitioning/quorum chapter of distributed systems just doesn't apply.**

This isn't a punt — it's a posture. Every system eventually needs durable owned state; when that day arrives, the work is *adding* a datastore, and the file you'll need is the database-systems guide, not this one. Until then, the honest answer to "what's your replication strategy?" is "we don't have data to replicate, and that's intentional."

## Primary diagram — the absence map

```
  Replication / partitioning / quorums — the whole picture is absences

  layer                    replication        partitioning         quorum
  ─────                    ───────────        ────────────         ──────
  L1 Browser               n/a — single tab   n/a                  n/a
  L1 sessionStorage        n/a                n/a                  n/a
  L2 cookie store          carried by client  n/a                  n/a
                            (the client IS the
                            replica)
  L2 in-memory Maps        none — cold        none — per-instance, n/a
                            restart wipes      naturally per-user
  L3 response cache        none               none                 n/a
  L4 Bloomreach            opaque             opaque                opaque
                            (their problem)    (their problem)      (their problem)

  no row says "we run R=2 with W=2 against N=3"
  no row says "tenant X lives on shard 4"
  no row says "wait for majority to ack the write"
  ★ this is the entire shape of the topic in this repo today ★
```

## Elaborate

The classic references for the absent material:

- **Brewer's CAP theorem.** Pick two of consistency, availability, partition-tolerance. *Doesn't apply to this codebase because we don't own a partitioned store. Applies to Bloomreach internally; their choice is opaque to us.*
- **Vogels' eventual consistency** (Werner Vogels, ACM Queue 2008). The model of "all replicas eventually converge to the same value if no new updates are made." *Bloomreach's read consistency model from our side is consistent with this — events written elsewhere appear in our reads with some delay.*
- **Dynamo paper** (DeCandia et al., 2007). The original R+W>N quorum design. *Worth knowing the shape; no part of the codebase uses it.*
- **Raft** (Ongaro & Ousterhout, 2014). The leader-elected log-replication consensus algorithm that powers etcd, Consul, CockroachDB, TiKV. *No use today; the cleanest reference if we ever needed a tiny embedded coordination service.*

The reading recommendation: if you're going to read one paper to fill in the gap this file deliberately leaves, read Werner Vogels' "Eventually Consistent" (the short blog version, not the longer paper). It frames the topic at the altitude this codebase actually cares about — *we're a consumer of an eventually-consistent upstream, not a designer of one.*

## Interview defense

### "What's your replication strategy?"

There is none, and that's the right answer for today. We don't own a datastore — every piece of state lives in one of three places: the browser (sessionStorage, encrypted cookie), in-memory Maps on whichever Vercel instance serves the request (session-keyed, ephemeral), or Bloomreach (opaque to us). The two pieces of state that need to survive across instances — OAuth tokens and investigation handoff context — survive by being carried *on the client*: the encrypted cookie for tokens (AES-256-GCM, 10-day max-age) and sessionStorage + URL params for handoff. The client is the replication target. When the product grows owned data — saved queries, user accounts, persisted briefings — we'd start with a single-instance Postgres and only replicate when an RPO/RTO requirement forced the question.

*Anchor:* `lib/mcp/auth.ts:38-104` — the cookie-as-distributed-state mechanism; `app/api/agent/route.ts:30-62` — the three-source fallback that makes us instance-agnostic.

### "How do you partition user data?"

Implicitly by Vercel's request routing — every user is one session (`bi_session` cookie), every request handles one user, and the session-keyed Maps (`lib/state/insights.ts:14-23`) keep one user's state from bleeding into another's *inside* a warm instance. There's no explicit partition key because each session's data fits in one process, runs in one request budget (300s), and doesn't need to be queried from a second instance. If the product grew shared queries across users, we'd start needing a real partition key (tenant_id) and a real store; we don't yet.

*Anchor:* `lib/state/insights.ts:14` — `state = new Map<string, SessionFeed>()`; the outer Map's key IS the partition.

### "Do you ever need quorum reads or writes?"

No, because there are no replicas to disagree. Every piece of state in this codebase has exactly one owner at a time: one tab for sessionStorage, one instance for in-memory Maps, one adapter (one request) for the response cache, one upstream for Bloomreach data. No multi-writer scenario, no replication, no quorum question. The whole consensus / leader-election / R+W>N family is `not yet exercised`. If the product ever needs cross-region durability with strong consistency, the conversation starts with picking a database that handles quorum internally (Spanner, CockroachDB, DynamoDB) rather than implementing it ourselves — at our scale and team size, rolling our own consensus is the wrong choice.

## See also

- `04-consistency-models-and-staleness.md` — the consistency story for the state we *do* have.
- `07-clocks-coordination-and-leadership.md` — the OAuth state survival mechanism (the client as replica).
- `09-distributed-systems-red-flags-audit.md` — what would change if the product added owned data.
- `.aipe/study-database-systems/` — datastore-local consistency (mostly `not yet exercised` here too).
- `.aipe/study-system-design/` — the architectural shape that keeps the topic small.
