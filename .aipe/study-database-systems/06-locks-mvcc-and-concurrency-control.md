# Locks, MVCC, and concurrency control

Industry standard · Concurrency control internals

## Zoom out — where concurrency control would live, and what's there

In a real database, concurrency control is the mechanism that enforces isolation: row locks, page locks, table locks, or MVCC (multi-version concurrency control) where each transaction sees a snapshot of the database as it was when the transaction started. This codebase has **none of these mechanisms.** Concurrency is "handled" by being single-threaded inside a Node process and by partitioning state per session — there's no contested resource because writers don't share enough state to contest.

```
  Zoom out — where concurrency control would live (and what's there)

  ┌─ Multiple concurrent requests ───────────────────────────────┐
  │  user A · briefing run                                        │
  │  user B · investigation                                       │
  │  user A · second briefing run (rapid)                         │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ each request → its own event-loop tick
  ┌─ Node event loop ──────────────▼──────────────────────────────┐
  │  ★ THIS CONCEPT ★                                              │
  │  single-threaded run-to-completion                             │
  │  → no two writers execute simultaneously on one instance       │
  │  → no need for row locks, page locks, MVCC                     │
  │  → BUT also no protection across instances                     │
  └────────────────────────────────────────────────────────────────┘
                                  │
  ┌─ State (partitioned by session) ▼─────────────────────────────┐
  │  Map<sessionId, SessionFeed>                                  │
  │  → cross-session "concurrency" is structurally impossible:    │
  │    writer A and writer B touch different sub-maps             │
  │  → intra-session concurrency: last-write-wins                 │
  └────────────────────────────────────────────────────────────────┘
```

## Zoom in — the question this concept answers

In a real DB: "when two transactions want the same row, who waits, and what does the other see while it waits?" Here: "is there any situation where two writes step on each other?" Short answer: only when two warm Vercel instances serve the same session at the same time, and even then, the consequence is "the second briefing wins" — not a corruption, not a deadlock, not a phantom.

## Structure pass — the skeleton

### Two concurrency-control families to know

  - **Pessimistic (locks).** Acquire a lock before touching the row; other writers block until you release. Defaults in MySQL InnoDB's older isolation modes, SQL Server. Avoids conflicts by preventing them. Cost: contention, potential deadlocks.
  - **Optimistic (MVCC).** Each writer creates a new version of the row; readers see the version that existed at their transaction start. Conflicts detected at commit time. Defaults in PostgreSQL, Oracle, modern SQL Server (snapshot isolation). Cost: storage for old versions, vacuum overhead.

### What this codebase uses: neither — structural avoidance

The codebase's concurrency story isn't a third strategy. It's the absence of contention by design:

  - **Per-session partitioning.** Different sessions write to different sub-maps. No lock needed; the resource isn't shared.
  - **Single event loop.** Within one instance, no two writers execute at the same instant. The loop itself is the lock.
  - **Last-write-wins on the rare collision.** Two writers on the same session on different instances: whoever wrote most recently to the local Map of the instance that serves the next read wins. No coordination, no detection, no recovery.

### Axis: where does the conflict prevention come from?

```
  The "conflict prevention" axis

  ┌─ cross-session ─────────────────────────────────────────────┐
  │  prevention: partitioning (different sub-maps)              │
  └─────────────────────────────────────────────────────────────┘
       ┌─ same session, same instance ───────────────────────────┐
       │  prevention: event-loop serialization                   │
       └─────────────────────────────────────────────────────────┘
            ┌─ same session, different instances ─────────────────┐
            │  prevention: NONE — last-write-wins, instance-local │
            └─────────────────────────────────────────────────────┘
```

The leftmost two layers are bulletproof. The third layer is the one where a real DB would step in with locks or MVCC — and where this codebase relies on the architectural choice that every briefing fully replaces the previous one.

### Seams

The seam that matters: **the gap between "two requests from one user" and "two instances serving them."** Vercel does not pin a session to an instance. The user can't tell which instance answered their last request. If two requests land on different instances, the in-memory Maps are independent — they don't see each other's writes at all.

## How it works

### Move 1 — the mental model

If you've ever written a React `useState` setter and not worried about two setters racing — you already have the intuition. JavaScript's single-threaded event loop gives you that for free *inside one tick*. This codebase's local state writes are essentially the same shape: synchronous, single-loop, no races. The complication is just that "the loop" is per-instance, and there can be multiple instances.

```
  The shape — three layers of concurrency, three answers

  ┌─ different sessions ─────────┐
  │  writer A → SessionFeed A    │   no shared resource
  │  writer B → SessionFeed B    │   → no possible conflict
  └──────────────────────────────┘

  ┌─ same session, one instance ─┐
  │  writer A · writer B         │   event loop serializes them
  │  one finishes before the     │   → no concurrent access
  │  other starts                │
  └──────────────────────────────┘

  ┌─ same session, two instances ┐
  │  instance 1 Map · instance 2 │   two independent Maps
  │  Map don't see each other     │   → "concurrency" by divergence
  └──────────────────────────────┘
```

### Move 2 — the walkthrough

#### Cross-session partitioning is the first line of defense

```ts
// lib/state/insights.ts:14-23
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

Annotation:
  - Each session gets its OWN inner `SessionFeed` with its own three inner Maps.
  - Two concurrent writers on different sessions touch *different* sub-maps. There's literally no shared resource for them to contend over.
  - The outer Map is *never cleared* by request code (`_clear` is test-only at `lib/state/insights.ts:95-101`). So one session's writes can't accidentally invalidate another's namespace.

This is the strongest concurrency-control move in the codebase — and it's not a control mechanism, it's an architectural one. The contention doesn't exist because the resource was split.

#### Within one instance, the event loop IS the lock

Every state-mutating function in `lib/state/insights.ts` is synchronous. Look at `putInsights` (`lib/state/insights.ts:57-71`), `putInvestigation` (`lib/state/insights.ts:86-88`), `getInsight` (`lib/state/insights.ts:73-75`) — no `await`, no `Promise`, no `setTimeout`. Each runs as one synchronous block.

```
  Per-instance concurrency, illustrated

  time ───────────────────────────────────────────►

  request 1:  [ putInsights starts ─── ends ]
  request 2:                                  [ getInsight ]   ← waits for request 1 to yield
  request 3:                                                [ putInsights starts ─── ends ]
```

JavaScript's run-to-completion guarantee means: while `request 1`'s `putInsights` is executing, no other request handler can touch the Maps. The event loop doesn't preempt. So even though `putInsights` does `clear() + N×set()`, no concurrent reader observes the intermediate state — they wait.

This is the closest thing in the codebase to a database "lock," and it comes for free from the runtime.

#### Across instances, there's no shared substrate at all

Vercel serverless functions are ephemeral. A briefing kicked off at T=0 may land on instance A; the same session's investigation at T=5 may land on instance B. Each has its own process, its own heap, its own `Map<sessionId, SessionFeed>`.

```
  Two-instance divergence

  instance A's Map                      instance B's Map
  ┌────────────────────────┐            ┌────────────────────────┐
  │ session-X: SessionFeed │            │ session-X: SessionFeed │
  │   insights: { A1, A2 } │            │   insights: { } (empty)│
  └────────────────────────┘            └────────────────────────┘
       (just ran briefing)                   (cold start, hasn't seen this session)
```

If the next request from session-X lands on instance B, `getInsight` returns `null` even though instance A has the data. The user sees "no insights" and re-runs the briefing. That's the operational consequence of having no shared store.

Two things make this tolerable:
  1. The client stashes insights in `sessionStorage` on the browser side (`lib/hooks/useBriefingStream.ts:56` — `bi:insight:<id>`). When the user navigates to investigate, the client re-supplies the insight via the request, so the server doesn't need to find it in its own Map.
  2. Briefings are cheap to re-run. A full re-compute is the architectural fallback for "this instance doesn't have it."

#### Last-write-wins on the response cache too

```ts
// lib/data-source/bloomreach-data-source.ts:185-187
const now = Date.now();
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
return { result: result as T, durationMs: 0, fromCache: false };
```

Annotation:
  - Two concurrent calls with the same `cacheKey` may both pass the cache miss check and both issue live calls. Both will write their result to the cache. Last write wins.
  - The cache key includes `JSON.stringify(args)`, so this only happens for *identical* concurrent calls. With ~1 req/s spacing (`minIntervalMs = 200`), the window is small.
  - There's no cache stampede protection (no "single-flight" mechanism). For a hot identical query, two parallel requests both pay the upstream cost. Acceptable at this scale; would be a real problem at higher concurrency.

This is a deliberate trade. The complexity of single-flight (a `Map<key, Promise<result>>` to coalesce in-flight requests) wasn't earned at the current rate-limit-throttled scale.

#### Deadlocks — not possible by construction

Deadlocks require two writers each holding a lock the other wants. There are no locks here. There is no waiting state. A writer either runs (synchronously) or doesn't run yet (the event loop hasn't reached it). Two writers can't be in a "waiting for each other" state because no acquisition step exists.

That's a quiet win — no deadlock detection logic, no deadlock victim selection, no timeout-and-retry on lock acquisition. None of it is needed.

### Move 3 — the principle

Concurrency control exists to mediate access to a *shared resource*. When the design eliminates sharing — partition the state, run single-threaded within a partition, accept that cross-partition state can diverge — the need for explicit control disappears. The cost is paid elsewhere: in the architecture (full re-compute as the recovery path), in the UX (occasionally re-running a briefing after a cold start), in the limits of what the system can offer (no consistent global view of any session). It's the right shape for a stateless service whose canonical data lives upstream; it would be the wrong shape for a system of record.

## Primary diagram

```
  Concurrency control — the three layers and their guarantees

  ┌─ cross-session ──────────────────────────────────────────────┐
  │  guarantee: NO conflict possible                              │
  │  mechanism: partitioning (different sub-maps in outer Map)    │
  │  evidence:  lib/state/insights.ts:14-23 (sessionState)        │
  └────────────────────────────────────────────────────────────────┘
       ┌─ same session, same instance ───────────────────────────┐
       │  guarantee: serialized writes, atomic reads/writes      │
       │  mechanism: Node event loop (run-to-completion)          │
       │  evidence:  no `await` in any state-mutating function    │
       └─────────────────────────────────────────────────────────┘
            ┌─ same session, different instances ─────────────────┐
            │  guarantee: NONE — last-write-wins, instance-local  │
            │  mechanism: client stashes data in sessionStorage,  │
            │             briefings are full re-computes          │
            │  evidence:  useBriefingStream.ts:56 (bi:insight:<id>)│
            └─────────────────────────────────────────────────────┘
```

## Elaborate

The canonical reference for concurrency control is Gray & Reuter ("Transaction Processing"). The two-strategy split (locking vs MVCC) maps to where the cost falls: locks pay at acquisition time and risk contention; MVCC pays in storage and vacuum but lets readers never block writers (and vice versa). Modern engines (Postgres, Oracle, SQL Server snapshot isolation) lean MVCC because the readers-don't-block-writers property dominates the operational story.

The "structural avoidance" pattern this codebase uses has its own lineage. Akka actors, Elixir/Erlang processes, and CRDTs all share a similar shape: avoid sharing the resource so contention can't arise. The CRDT angle is particularly relevant for the multi-instance case — if you wanted the two-instance Maps to converge without a single source of truth, you'd reach for a CRDT (something like LWW-Element-Set). The architecture today says: don't try. Use a single source of truth (the provider) and treat local state as ephemeral.

For this codebase, the actionable note: if Vercel-style multi-instance becomes a felt problem (users repeatedly seeing "no insights, run again"), the right fix is *not* to add locking — it's to add a shared store (Redis, KV, Postgres) so both instances see the same data. That's a datastore decision, which traces back to audit finding F1.

## Interview defense

> Q: "How does this app handle concurrent writes?"

Verdict: by avoiding contention rather than mediating it. State is partitioned per session, so concurrent writers on different sessions touch different sub-maps. Within a single instance, the Node event loop serializes writers automatically — every state mutation is synchronous, so no two writers can execute at the same instant. The unmitigated case is two warm Vercel instances serving the same session, where each instance has its own Map; last-write-wins, and the client mitigates by stashing data in `sessionStorage` and the architecture mitigates by making briefings cheap to re-run.

```
  the picture you draw — three layers, three guarantees

   cross-session    │ partitioning           │ rock-solid
   same instance    │ event loop             │ serialized
   diff instances   │ NONE                   │ last-write-wins
```

The load-bearing point: there's no lock manager and no MVCC because there's no contested resource. The session-keying eliminates the contention; the event loop handles what remains; the multi-instance case is accepted as a UX cost the architecture is built around.

> Q: "Could you deadlock this thing?"

No, by construction. Deadlocks require two writers each holding a lock the other wants. There are no locks. There is no waiting state. A writer either runs synchronously or hasn't been scheduled yet.

> Q: "When would MVCC enter the picture?"

The day a shared datastore lands. Postgres for the datastore means MVCC for free; an embedded file-backed engine means serialized writes; Redis means single-threaded per-key ops. Each of those brings its own concurrency-control model that you'd inherit rather than build. Building MVCC in JavaScript is not on the path — the path is "use a database that does it for you."

## See also

  - [`05-transactions-isolation-and-anomalies.md`](./05-transactions-isolation-and-anomalies.md) — the isolation guarantees concurrency control enforces
  - [`08-replication-and-read-consistency.md`](./08-replication-and-read-consistency.md) — the multi-instance divergence case in detail
  - [`audit.md`](./audit.md) — F3 (concurrent writes on the same session)
