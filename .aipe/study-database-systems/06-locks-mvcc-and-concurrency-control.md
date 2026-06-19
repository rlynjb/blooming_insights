# Locks, MVCC, and Concurrency Control

## Subtitle

How a database lets many writers proceed without corrupting each other's data · Industry standard.

## Zoom out, then zoom in

```
  Zoom out — where concurrency control sits in a normal app

  ┌─ App ──────────────────────────────────────────┐
  │  many requests in flight at once               │
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ Database ─────────▼───────────────────────────┐
  │  ★ CONCURRENCY CONTROL ★                       │
  │  pessimistic:  row locks, table locks           │
  │  optimistic:   version columns, MVCC snapshots  │
  │  combined:     SSI = MVCC + conflict detection  │
  └────────────────────────────────────────────────┘
```

### Verdict for this codebase

**Mostly not yet exercised — one real concurrency gap.**

`putInsights()` calls `insights.clear()` then `insights.set()` in a loop. Within a single Node tick on one instance, that's atomic — the event loop won't preempt mid-loop. Across **two warm Vercel instances**, both can hit `/api/briefing` at the same wall-clock moment, both run their own `putInsights()`, and a third request landing on either instance sees whichever instance's last `set()` won. There's no coordination, because there's no shared store.

This isn't "MVCC isn't tuned." It's "no concurrency control is needed at this scale, and there's no engine to tune." Row locks, version columns, snapshot isolation — all primitives we'd reach for once there was a DB. None reached for today.

### When this becomes load-bearing

```
  triggers that flip concurrency from "no problem" to "the problem"

  two users running briefings at once on Vercel
     → today: each instance has its own Map; no coordination
     → fix: shared KV (Upstash), or accept divergence

  two requests editing the same saved insight
     → needs row-level locking or optimistic concurrency on a version column

  rate-limit budget shared across instances
     → today: each instance has its own minIntervalMs counter; spending
              is uncoordinated; total req/s can exceed Bloomreach's cap
     → fix: atomic counter in a shared store (Redis INCR + EXPIRE)
```

The rate-limit gap is the one I'd actually worry about under any real traffic — see Move 2c.

## Structure pass

One axis matters here: **what happens when two writers hit the same resource at the same instant?**

```
  axis: "two concurrent writers on the same key — what happens?"

  ┌─ inside one Node tick ──────────────────┐
  │  impossible — Node is single-threaded.   │  → no concurrency
  │  the loop body runs to completion.        │     to control
  └──────────────────────────────────────────┘
              │
              │  cross an `await` boundary
              ▼
  ┌─ across awaits, same instance ──────────┐
  │  another handler can run during await.   │  → concurrency IS possible;
  │  Map state can be observed mid-update.    │     no lock; first writer
  │                                          │     wins, mutations interleave
  └──────────────────────────────────────────┘
              │
              │  cross an instance boundary
              ▼
  ┌─ across instances on Vercel ────────────┐
  │  two processes, two separate Maps, no    │  → divergence is the default.
  │  shared memory and no shared lock.        │     each instance has its own
  │                                          │     "truth."
  └──────────────────────────────────────────┘
              │
              │  cross a deploy boundary
              ▼
  ┌─ across deploys ─────────────────────────┐
  │  fresh process, fresh Map, nothing        │  → previous state gone
  │  survives                                 │
  └───────────────────────────────────────────┘
```

The seams are the boundaries where the answer flips. Each one is where you'd need to insert a concurrency mechanism if you cared.

## How it works

### Move 1 — the mental model

A database lets many transactions run at once. Without something to coordinate them, they'd corrupt each other's data. The two strategies:

```
  pessimistic vs optimistic — same goal, opposite costs

  pessimistic   "I expect a conflict, so I'll LOCK first."
                acquire lock → do work → release lock
                cost: blocks other writers, can deadlock
                wins when: contention is high; conflicts likely

  optimistic    "I expect no conflict, so I'll work first
                 and check at the end."
                read with version → do work → write with version-check
                cost: retries when the check fails
                wins when: contention is low; conflicts rare
```

**MVCC (Multi-Version Concurrency Control)** is the trick that lets readers and writers not block each other. Each write creates a new version; each transaction reads from the version that was committed when it started. No reader ever waits for a writer.

```
  the pattern — MVCC, three transactions, one row

  time →

  txn A    BEGIN ─────── reads row v3 ──────────── COMMIT
                              │
  txn B           BEGIN ────── reads row v3 ─── updates row → v4 ─── COMMIT
                              │                       │
  txn C                                   BEGIN ─── reads row v4 ───────
                              │                       │
  ────────────────────────────┴───────────────────────┘
       A and B both saw v3 — they never block each other
       C started after B's commit — sees v4
```

### Move 2 — the moving parts

**Move 2a — row locks, the classic.** `SELECT ... FOR UPDATE` takes a row-level lock; other transactions trying to write that row wait. Deadlocks happen when two transactions each hold a lock the other wants — the engine detects the cycle and aborts one with a deadlock error.

**Move 2b — version columns, the optimistic path.** Add `version BIGINT NOT NULL`. Every UPDATE bumps it: `UPDATE ... SET ..., version = version + 1 WHERE id = ? AND version = ?`. If the row's version changed since you read it, the UPDATE affects 0 rows and you retry with the new state. No locks, no waiting — just retries.

```
  bridge: think of an HTTP PUT with `If-Match: "etag123"`. Same idea —
          server rejects if the resource changed since you read it. The
          client retries with the fresh etag.
```

**Move 2c — the real concurrency gap in THIS codebase.**

The MCP client enforces `minIntervalMs=1100` to space calls and stay under Bloomreach's 1-req-per-second cap. That counter is per-instance:

```
  lib/mcp/client.ts L82, L149-156

  private lastCallAt = 0;
  private minIntervalMs: number;
  ...
  private async liveCall(name, args) {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    ...
    this.lastCallAt = Date.now();
    ...
  }
```

Two warm instances each carry their own `lastCallAt`. Two concurrent briefings on two instances can each fire one MCP call per 1.1s — but Bloomreach sees two calls per 1.1s globally. The rate limit then trips, and the retry path (10s back-off) eats the per-investigation budget.

```
  pattern — what breaks when each part is missing

  drop the per-instance lastCallAt    → instant flood of MCP calls, every
                                        retry hits a 10s back-off, route
                                        budget blown
  rely on it across instances         → today's bug under load: rate-limit
                                        retries on Bloomreach's side because
                                        no global coordination exists
  fix: shared counter in Redis        → atomic INCR per window, drop calls
                                        once budget is spent. classic token-
                                        bucket distributed pattern.
```

**Move 2d — what an MVCC fix would look like for `putInsights()`.**

Today `putInsights()` does `clear()` then `set()` in a loop. The non-atomic write is observable across instances. The MVCC-shaped fix (in a real DB):

```
  pseudocode — atomic replace-with-version

  BEGIN
    SELECT version FROM briefings WHERE id = 'current'  → v
    INSERT new briefing as version v+1
    UPDATE briefings SET version = v+1 WHERE id = 'current' AND version = v
       → if 0 rows affected, another briefing won; retry
  COMMIT

  readers always see one consistent version; writers conflict-detect.
```

We don't have this. The acceptable workaround for blooming insights today is: only one briefing runs at a time per user (the UI enforces this), and accept the demo-grade staleness across instances.

### Move 3 — the principle

**Concurrency control is the price of multi-writer correctness.** You can't avoid it by being careful — careful code under load develops races. You either coordinate (locks, versions, MVCC) or you accept that writers can step on each other. The choice between pessimistic and optimistic is just a bet on how often you expect conflicts. For low-contention workloads, optimistic wins; for hot rows, pessimistic does. For this codebase, "no coordination" is the current bet, and the trigger that flips it is "real traffic with concurrent writers."

## Primary diagram

```
  blooming insights — where concurrency actually happens

  ┌─ Vercel ────────────────────────────────────────────────────────────┐
  │                                                                     │
  │  instance A           instance B           instance C               │
  │  ┌──────────┐         ┌──────────┐         ┌──────────┐             │
  │  │ Map      │         │ Map      │         │ Map      │             │
  │  │ {a1, b2} │         │ {c3}     │         │ {}       │             │
  │  │ lastCall=│         │ lastCall=│         │ lastCall=│             │
  │  │   t=100  │         │   t=80   │         │   t=0    │             │
  │  └────┬─────┘         └────┬─────┘         └────┬─────┘             │
  │       │ no shared state, no lock                                    │
  └───────┼───────────────────┼──────────────────┼──────────────────────┘
          │                    │                    │
          └────────────────────┴────────────────────┘
                              │
                              ▼
  ┌─ Bloomreach (rate-limited globally per user) ─────────────────────────┐
  │  sees 3 calls in <1s → 429 → all three instances retry on 10s         │
  │  back-off; investigation budget burns                                 │
  └───────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

### Use cases

- The rate-limit counter (`lastCallAt`) is the only "concurrency primitive" present, and it's instance-local.
- `putInsights()` is the closest thing to a transaction that needs atomicity, and it relies on Node's single-thread within one tick to fake it.

### Code side by side

```
  lib/mcp/client.ts  (lines 148–163)

  private async liveCall(name, args) {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) =>             ← single-instance pacing.
        setTimeout(r, this.minIntervalMs - elapsed));
                                              works because Node runs the
                                              setTimeout on this process's
                                              event loop.
    }
    try {
      const result =
        await this.transport.callTool(name, args);
      this.lastCallAt = Date.now();
      return result;
    } catch (err) {
      this.lastCallAt = Date.now();        ← important: still update on error,
                                              otherwise a thrown error means
                                              the next call doesn't wait.
      throw new McpToolError(name, ...);
    }
  }
       │
       └─ no global coordination. on Vercel with N warm instances, total
          req/s can be Nx the per-instance budget. the McpClient.retry path
          (parseRetryAfterMs, 10s back-off) is the SAFETY NET that absorbs
          this — not a fix. the real fix is a shared rate-limit token bucket
          in something like Upstash Redis, with atomic INCR + EXPIRE.
```

```
  lib/state/insights.ts  (lines 30–42 — repeated from 05 for the concurrency angle)

  export function putInsights(items, rawAnomalies?) {
    insights.clear();              ← within ONE Node tick, this whole
    anomalies.clear();                function body is atomic (no await).
    items.forEach((i, idx) => {       across instances, it's not — instance
      insights.set(i.id, i);          A's clear can run while B is mid-set;
      ...                             both write their own truth.
    });
  }
       │
       └─ the only thing protecting us today is that the UI doesn't kick off
          concurrent briefings. add a "background refresh" feature, or have
          two users in two browser tabs, and the race becomes observable.
          the MVCC fix lives in whatever DB we'd pick — UPSERT with version
          column, or wrap the whole thing in BEGIN/COMMIT.
```

## Elaborate

MVCC dates to System R in the 1970s and is the reason Postgres can run high-throughput OLTP without lock contention killing it. The cost is bloat — every UPDATE creates a new row version, and old versions must be cleaned up (Postgres `VACUUM`). The day a team operates Postgres at scale, they meet VACUUM tuning.

For this codebase, the relevant concurrency primitive isn't MVCC — it's a token bucket. The MCP rate limit is the bottleneck, and a shared bucket is the standard distributed-systems fix (`study-distributed-systems` covers the algorithm). The fact we haven't reached for one tells you about scale, not about technical capability.

Cross-link: `study-distributed-systems` owns coordination across processes; `study-runtime-systems` owns the within-process concurrency model (why a body with no awaits is atomic).

## Interview defense

**Q: "Walk me through the concurrency story in this app."**
Three altitudes. Within one tick of one Node instance, the event loop gives me atomicity for free — a function body with no awaits cannot be interleaved. Across awaits on one instance, I have no lock; any state mutation that crosses an await is observable. Across instances on Vercel, there's no shared state, no coordination, period — each instance has its own Maps and its own `lastCallAt` counter. The fact this works today is a function of low traffic, not of safety.

Diagram: the three-altitude axis diagram from the structure pass.

Anchor: `lib/mcp/client.ts` L82, L149-156 for the per-instance counter; `lib/state/insights.ts` L30-42 for the within-tick atomicity assumption.

**Q: "Where's the most likely production race here?"**
The rate-limit budget. `minIntervalMs` is per-instance. Two warm instances at the same moment can each fire one MCP call per 1.1s — that's 2/s globally — and Bloomreach's cap is 1/s. The retry path (10s back-off) absorbs it, but it eats route-budget time, so under any real concurrent load the user-facing latency degrades. The fix is a shared token bucket; we haven't built one because demo traffic doesn't trigger it.

Diagram: the multi-instance picture with all three pointing at one rate-limited Bloomreach.

Anchor: `lib/mcp/client.ts` L82 (`lastCallAt` is module-scoped per `McpClient` instance, instantiated per request, but the `minIntervalMs` enforcement only sees one instance's history).

**Q: "If you added saved insights with concurrent edits, optimistic or pessimistic?"**
Optimistic. Save-insights is low contention — two users editing the same row at the same instant is rare. A version column on the row, UPDATE with `WHERE id=? AND version=?`, retry on 0-row-affected. Pessimistic locking is overkill for a workload this read-heavy.

Diagram: the version-column UPDATE pattern.

## Validate

**Level 1 — reconstruct.** Explain MVCC in two sentences. Why don't readers block writers under MVCC?

**Level 2 — explain.** Why is `putInsights()` "safe" today and what's the smallest change that would break that safety? (Answer: safe because no await in the body, one instance. Adding any `await` inside the body OR adding any feature that triggers two concurrent briefings on different instances breaks it.)

**Level 3 — apply.** Sketch the shared token-bucket fix for the rate-limit gap. What's the Redis-side primitive? (Answer: `INCR rl:user:{id}:window` then `EXPIRE rl:user:{id}:window 1` on the first increment; reject when the counter exceeds the budget. Pseudocode in `lib/mcp/client.ts` would replace `lastCallAt` with a check against this counter before the call.)

**Level 4 — defend.** Argue against introducing pessimistic row locks for saved-insights "to be safe." (Answer: locks block other writers; under typical save-insights traffic (low contention, mostly different rows), locks are pure overhead. Optimistic concurrency pays only when a conflict actually happens — which is the right cost shape for the workload.)

## See also

- `05-transactions-isolation-and-anomalies` — the contract concurrency control enforces
- `08-replication-and-read-consistency` — the cross-instance divergence problem at a higher altitude
- `01-database-systems-map` — the storage layout that has none of these primitives
- `study-distributed-systems` — coordination across processes
- `study-runtime-systems` — Node's event loop and the within-tick atomicity claim

---
Updated: 2026-06-19 — Olist note removed (sibling SQLite tier gone). Main-app concurrency gap unchanged; the rate-limit-budget-per-instance finding is still the load-bearing concurrency story here.
