# Locks, MVCC, and concurrency control — none, by partition

*Industry standard / Project-specific* — there are zero locks and no MVCC. The repo gets away with this by partitioning state per-session and by relying on Node's single-threaded execution to serialize writes within a session.

## Zoom out, then zoom in

Concurrency control becomes interesting the moment two callers can touch the same row. The repo's whole design is that they can't: every session owns its own sub-maps, every request is its own function invocation, and JavaScript is single-threaded. The one place where two callers *could* hit the same row is the rate-limit-spacing path inside `BloomreachDataSource` — and that's not protected by a lock, it's protected by a single timestamp variable that every caller reads and updates.

```
  Zoom out — where this concept lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  feed + investigation may run in the same browser tab     │
  └────────────────────────────┬─────────────────────────────┘
                               │  HTTP (potentially parallel)
  ┌─ Service layer ────────────▼─────────────────────────────┐
  │  /api/briefing  ──┐                                      │
  │                   │  same Node process, different fn      │
  │  /api/agent     ──┤                                      │
  │                   ▼                                      │
  │  BloomreachDataSource.liveCall                            │
  │    lastCallAt ★ THE ONLY SHARED MUTABLE ★                  │ ← we are here
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ Storage layer ────────────▼─────────────────────────────┐
  │  sessionState (partitioned per sid — no contention)       │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: there are two questions worth asking. (1) Why are there no locks on the session state? Because the partition guarantees one writer at a time per session. (2) Why is `lastCallAt` safe without a lock? Because the worst case is "two callers under-space their requests and the second gets a 429 the retry path handles."

## Structure pass

**Layers:**

```
  L1  per-session state          partitioned, no contention
  L2  per-DataSource cache       single-writer per instance
  L3  lastCallAt timestamp        read-modify-write, no lock
```

**Axis traced: where could two writers race?**

```
  Trace one axis: can two writers race for this state?

  ┌─ L1: sessionState ───────────────────┐
  │  outer Map keyed by sessionId         │   → no race: one sid, one request
  └───────────────────────────────────────┘
                  (it flips)
  ┌─ L2: cache Map ──────────────────────┐
  │  one cache per DataSource instance    │   → races possible but benign
  └───────────────────────────────────────┘
                  (it flips)
  ┌─ L3: lastCallAt number ──────────────┐
  │  one var, every caller reads + writes │   → races possible, handled by retry
  └───────────────────────────────────────┘

  the seam at L3 is where contention is theoretically real and pragmatically absorbed
```

**Seams** — one matters:

- The L2 → L3 boundary is where "no race possible" becomes "race possible but cheap." Above this line you don't need a lock; below it you might, and the repo chose to absorb the cost in the retry path instead.

## How it works

### Move 1 — the mental model

You've used a `Map.get()` then `Map.set()` pattern before — read a value, modify it, write it back. In a single-threaded runtime this is atomic *as long as nothing yields*. As soon as there's an `await` between the read and the write, two callers can interleave. The whole concurrency-control story here is "where are the read-modify-writes, and do any of them have an `await` in the middle?"

```
  The two patterns side by side

  SAFE — fully synchronous:                  RACEY — await in the middle:

  let x = state.get(k)                       let x = state.get(k)
  x.count++                                  x = await fetchUpdated(k)   ◄── yields
  state.set(k, x)                            state.set(k, x)

  no other JS can interleave                 another caller can run between
  here — Node serializes by                  the get and the set, write the
  default                                    same key, and lose updates
```

That's the mental model. The rest is finding the places in the repo where each pattern lives.

### Move 2 — the concurrency story, one part at a time

#### Session state — no contention because of the partition

`sessionState(sid)` returns a per-session sub-feed. Two different sessions never touch the same `Map`. The same session (same `sid`) can in principle make two concurrent requests — e.g. a tab firing `/api/briefing` while another tab fires `/api/agent` — but they touch *different* sub-maps:

- briefing writes `s.insights` and `s.anomalies`
- agent writes `s.investigations`

```
  Per-session sub-feed — three sibling tables, different writers

  s = sessionState(sid)
       │
       ├─ s.insights         ◄── /api/briefing writes (via putInsights)
       ├─ s.investigations   ◄── /api/agent writes (via putInvestigation)
       └─ s.anomalies        ◄── /api/briefing writes (via putInsights)
```

So even within one session there's no shared-row contention. Two writers, two different inner maps. No lock needed.

What *would* contend: two simultaneous `/api/briefing` calls for the same session, both racing into `putInsights`. The second's `.clear()` could land mid-way through the first's `.forEach()`. The UI doesn't trigger this (briefing is a single-button action and the button disables while running) but nothing in the server prevents it. The fix, if it ever became real, would be a per-session `Promise` lock — but again, today it's not happening.

#### Cache — single writer per instance, benign races

The 60s response cache (`bloomreach-data-source.ts:122`) lives on a per-DataSource instance. There's one instance per session at most (constructed by `connectMcp`), so two requests for the same session share a cache. Two concurrent `callTool` calls for the same key can race:

```
  Two concurrent calls with the same key — what happens

  T0: callA: cache.get(k) → MISS
  T0: callB: cache.get(k) → MISS    ← B doesn't see A's pending work
  T1: callA: liveCall → result A
  T2: callB: liveCall → result B    ← duplicate network call
  T3: callA: cache.set(k, resultA)
  T4: callB: cache.set(k, resultB)  ← overwrites A; readers from T4+ see B
```

The race is real and the cost is "one extra upstream call." Both callers get a valid result (whichever one returned for them), the cache ends up holding the most-recent result, and there's no correctness violation — only a missed dedup. The repo accepts this rather than adding a "request coalescing" layer because the two-concurrent-call case is rare (each agent runs sequentially per session).

#### `lastCallAt` — the only true race condition, absorbed by retry

```typescript
// lib/data-source/bloomreach-data-source.ts:190-205
private async liveCall(name, args, signal) {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));  // ◄── yields
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });   // ◄── yields
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

Two `await`s and a read-modify-write of `this.lastCallAt`. Two concurrent callers can both see "elapsed > minIntervalMs," both skip the wait, both fire — and the upstream returns a 429 to whichever one violated the rate limit. The retry path (`bloomreach-data-source.ts:163-174`) parses the wait hint, sleeps, and retries.

**This is the only place in the repo where concurrent execution can produce a wrong-looking result, and it's deliberately absorbed by the retry rather than locked.** The reasoning: a lock would serialize all in-flight calls and cost more than the occasional retry penalty.

```
  lastCallAt — race, then retry absorbs it

  T0: caller1 reads lastCallAt = 0,  elapsed = ∞,  skips wait
  T0: caller2 reads lastCallAt = 0,  elapsed = ∞,  skips wait
  T1: caller1 transport.callTool → ok
  T1: caller2 transport.callTool → 429 rate-limited
  T2: caller1: lastCallAt = T1
  T2: caller2: lastCallAt = T1
  T3: caller2 retry loop sees isRateLimited(result), parses wait,
      sleeps, retries → success on T4
```

No lock, no MVCC, no version chain. The mechanism is "let it race, detect the failure, retry with a backoff."

#### MVCC — none

There are no version chains in this repo. `Map` stores one value per key; an update replaces the previous value. No `xmin`/`xmax`, no readers seeing stale snapshots while a writer commits. The closest thing to a snapshot is the committed JSON in `lib/state/demo-*.json` (frozen at capture time) and the encrypted cookie (one version per request via the dirty bit) — neither of those is MVCC, they're just point-in-time snapshots.

#### Optimistic vs pessimistic — neither applies

Both concurrency models assume contention that needs detection (optimistic) or prevention (pessimistic). The repo doesn't have contention worth either. The cache race is benign; the `lastCallAt` race is absorbed by retry; the session-state writes don't share rows.

### Move 3 — the principle

The strongest concurrency-control technique is **eliminating the contention**. When you partition state by tenant (here: sessionId), one writer at a time per tenant becomes a structural property — no lock needed because no race possible. The remaining races (cache fill, rate-limit spacing) become "benign vs absorbed" decisions you can make explicitly. Locks are what you reach for when the partition can't be drawn cleanly; this repo could draw it cleanly, so it doesn't reach.

## Primary diagram

```
  Concurrency story — three layers, one race that matters

  ┌─ session state ─────────────────────────────────────────┐
  │  partition by sessionId                                  │
  │  no race: outer Map keyed, inner Maps per session         │
  │  contract gap: two same-sid /api/briefing calls could     │
  │                race in putInsights (today, not triggered) │
  └──────────────────────────────────────────────────────────┘

  ┌─ response cache ────────────────────────────────────────┐
  │  per-DataSource Map                                      │
  │  race possible: 2 concurrent miss → 2 live calls → last  │
  │                 writer wins, both callers get valid data │
  │  cost: 1 extra upstream call (benign)                    │
  └──────────────────────────────────────────────────────────┘

  ┌─ lastCallAt timestamp ──────────────────────────────────┐
  │  single number, read-modify-write across awaits          │
  │  race possible: 2 callers skip spacing, 1 gets 429       │
  │  recovery: retry path parses wait hint, sleeps, retries   │
  │  cost: ~10s on the second caller's retry                  │
  └──────────────────────────────────────────────────────────┘

  no locks, no MVCC, no snapshot isolation — by design
```

## Elaborate

The hidden assumption is "Node is single-threaded." That's true for JS execution but not for I/O completions — when two `await`s complete out of order, the order in which the resumed coroutines run is the JS scheduler's call. The repo relies on this for `putInsights` to be atomic (no `await` between the clear and the forEach), and on the retry path to absorb `lastCallAt` races. Both are correct, both are fragile to refactors that add `await`s where there were none.

Compare to a Postgres-backed equivalent: `putInsights` would be `DELETE ... WHERE sid = ?; INSERT ...` inside a transaction. The cache race would be solved by `INSERT ... ON CONFLICT DO NOTHING`. The rate-limit race would be solved by the upstream itself (or a token bucket in a Redis-backed shared store). All of those involve more infrastructure than the current design; the current design is "single-process, single-tenant-per-key, absorb the rest with retries."

The interesting design move is the explicit **"absorb the race rather than lock it"** choice for `lastCallAt`. A lock would serialize every tool call across every session sharing one Bloomreach client — which would multiply the rate-limit cost by the concurrency count. Accepting the occasional 429 + retry is cheaper.

## Interview defense

**Q: How does this app handle concurrent writes to the same state?**

It doesn't, because there's no shared state to contend for. State is partitioned per-session via the outer `Map` in `sessionState(sid)`, and within a session the three sub-maps (`insights`, `investigations`, `anomalies`) have different writers (briefing writes the first two, agent writes the third). No row is ever the target of two simultaneous writers in any normal flow.

**Q: Is there any place where a race condition is possible?**

Two. The 60s response cache can have two concurrent misses for the same key produce two upstream calls — benign, last writer wins, both callers get valid data. And `lastCallAt` in `BloomreachDataSource.liveCall` is a read-modify-write across `await`s — two concurrent callers can both skip the spacing wait, the second gets a 429, and the retry path absorbs it. The repo deliberately chose retry-absorption over locking because a lock would serialize every tool call across every concurrent session.

**Q: What's the load-bearing assumption?**

That Node executes JS synchronously between `await` points. `putInsights` (the only multi-step write on session state) has no `await` between `.clear()` and `.forEach()`, so it's effectively atomic. Add an `await` there and the partition stops being sufficient — you'd need a per-session lock. Today the comment at `lib/state/insights.ts:57-63` warns about WHY of `.clear()` but not the atomicity contract; that's the latent risk.

## See also

- `02-records-pages-and-storage-layout.md` — the partition that makes locks unnecessary
- `05-transactions-isolation-and-anomalies.md` — the multi-step write this concurrency story rests on
- `04-query-planning-and-execution.md` — the retry path that absorbs the `lastCallAt` race
- `09-database-systems-red-flags-audit.md` — the latent risks if these assumptions ever break
