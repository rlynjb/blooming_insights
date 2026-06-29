# Transactions, isolation, and anomalies — the one multi-step write

*Industry standard / Project-specific* — there are no transactions. The only multi-step write in the whole repo is `putInsights`, and the failure window is so small that it's not currently a real risk — but it IS the only place where the concept applies.

## Zoom out, then zoom in

A transaction's job is to make a sequence of writes look atomic to anyone reading. The repo has effectively no concurrent readers of in-memory state (every session is partitioned; see `02`), so the "isolation" half of the concept is mostly absent. What is *not* absent is **atomicity** — and there's exactly one place where it matters: `putInsights` does a `.clear()` followed by a loop of `.set()`, and a crash between those two would leave the session's feed half-written.

```
  Zoom out — where this concept lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  feed reads insights via /api/briefing                    │
  └────────────────────────────┬─────────────────────────────┘
                               │  HTTP / NDJSON
  ┌─ Service layer ────────────▼─────────────────────────────┐
  │  app/api/briefing/route.ts emits insights to stream       │
  │      │                                                    │
  │      ▼                                                    │
  │  putInsights(sid, insights, anomalies)                    │
  │    s.insights.clear()                                     │
  │    s.anomalies.clear()      ★ THE MULTI-STEP WRITE ★      │ ← we are here
  │    items.forEach((i, idx) => {                            │
  │      s.insights.set(i.id, i)                              │
  │      if (rawAnomalies[idx]) s.anomalies.set(i.id, ...)    │
  │    })                                                     │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ Storage layer ────────────▼─────────────────────────────┐
  │  sessionState(sid) (the Map partition)                    │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: this is a 3-statement sequence that should be atomic ("replace the session's feed"). It isn't — JavaScript has no transaction primitive over `Map` — and the visibility window is tiny but non-zero.

## Structure pass

**Layers:**

```
  L1  HTTP request                  one /api/briefing call
  L2  putInsights() function        the multi-step write
  L3  Map operations                 .clear() + .set() per item
```

**Axis traced: atomicity — is the operation visible as all-or-nothing?**

```
  Trace one axis: is the write atomic from a reader's perspective?

  ┌─ L1: HTTP boundary ──────────────────┐
  │  request begins, ends                 │   → atomic from the client
  └──────────────────────────────────────┘
                  (it flips)
  ┌─ L2: putInsights() ──────────────────┐
  │  3 statements, no try/catch wrapper   │   → NOT atomic mid-function
  └──────────────────────────────────────┘
                  (it flips)
  ┌─ L3: Map operations ─────────────────┐
  │  each .clear() / .set() is atomic     │   → atomic per statement
  └──────────────────────────────────────┘

  the seam at L2 is where atomicity disappears
```

**Seams** — one matters:

- The L2 boundary is where the contract should be "replace the feed atomically" and is instead "do these three things in order." The repo doesn't suffer because nothing reads concurrently within a session — but the contract gap is real.

## How it works

### Move 1 — the mental model

You've used `BEGIN ... COMMIT` before — wrap a sequence so partial writes never become visible. The shape here is the same idea, except there's no `BEGIN`. The visibility model is "every `Map` operation is instantly visible; the function is just three sequential operations."

```
  No transaction wrapper — three independent statements

       putInsights(sid, items, rawAnomalies)
              │
              ▼
       ┌──────────────┐
       │ insights.clear() │   ← visible immediately to any reader
       └──────┬───────┘
              │
              ▼
       ┌──────────────┐
       │ anomalies.clear() │  ← visible immediately
       └──────┬───────┘
              │
              ▼
       ┌──────────────────────────┐
       │ for each item: set(i.id, i) │  ← visible per iteration
       └──────────────────────────┘

       a reader landing between any two statements sees a partial state
```

That's the kernel: no atomicity, no isolation level to pick. The rest is "where does that actually bite, and where is it safe?"

### Move 2 — the multi-step write, one part at a time

#### The function itself

```typescript
// lib/state/insights.ts:57-71
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  // Replace the previous briefing for THIS session — each run IS the current
  // feed, not an addition. Without clearing, a warm serverless instance (or a
  // long-running dev server) accumulates stale insights from earlier runs, so
  // the feed shows yesterday's anomalies alongside today's. Investigations are
  // keyed separately and untouched here. Only this session's sub-maps are
  // cleared — never the outer map, never another session's feed.
  const s = sessionState(sessionId);
  s.insights.clear();
  s.anomalies.clear();
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

Three things in order: clear insights, clear anomalies, set each. The comment is honest about the intent ("each run IS the current feed") but doesn't address atomicity.

#### Why it's not (currently) a real anomaly

Node.js is single-threaded for JS code. `putInsights` runs synchronously — there's no `await` between the `.clear()` and the `.forEach()` — so no other JS code on the same instance can interleave between the three statements. The only way to land in the "half-written" state is:

1. The process dies between `.clear()` and the end of `.forEach()` (instance recycle, OOM, fatal error). Probability: near-zero — the function takes microseconds and there's no I/O in the middle.
2. A bug in `.forEach()` throws midway. Probability: also near-zero — the body only does `Map.set()` calls.

So in practice the function behaves atomically. The contract that says it MUST be atomic is just... absent.

#### Where it WOULD bite if anything changed

Two changes would turn this from latent to live:

- **Adding an `await` between the clear and the loop.** A network call, a `crypto` operation, anything that yields the event loop. A reader landing in that window sees an empty feed.
- **A second writer for the same session.** If two concurrent `/api/briefing` requests for the same sessionId interleaved their `putInsights` calls, the second's `.clear()` could wipe the first's `.set()` calls mid-flight. The repo prevents this by serializing per-session at the HTTP layer (each request is a new function invocation; the model loop is awaited) and by the fact that the UI doesn't trigger two briefings at once.

#### The isolation level (such as it is)

Borrowing the SQL vocabulary: this is **read-uncommitted within the function, read-committed across functions.** Inside `putInsights` a hypothetical reader would see dirty intermediate state. Outside `putInsights` (between two completed calls) readers always see the final state of whichever call completed last. There's no snapshot isolation because there's no version chain — every read is from the live `Map`.

#### Dirty-read example (constructed, not observed)

```
  A reader landing mid-putInsights would see:

  t0: insights = { a, b, c }                       (previous briefing)

  t1: putInsights starts
      insights.clear()           ◄── reader at t1.5 sees empty feed
      anomalies.clear()
      forEach iteration 1: set('x', X)  ◄── reader at t1.8 sees { x }
      forEach iteration 2: set('y', Y)
      forEach iteration 3: set('z', Z)

  t2: putInsights returns
      insights = { x, y, z }                       (new briefing)

  reader at t1.5 → empty feed (dirty read)
  reader at t1.8 → { x }       (dirty read)
  reader at t2+  → { x, y, z } (consistent)
```

Today there is no concurrent reader, so this scenario doesn't happen. If `listInsights` were ever called from an async context that could interleave (e.g. a separate request for the same session firing during a briefing), this is the bug it would hit.

### Move 3 — the principle

"Transactions" sound like a feature only databases have, but the underlying need — make a multi-step write look atomic to readers — applies whenever you have shared mutable state. Even with a single-threaded runtime, you can lose the property by adding an `await` between two writes. The honest test is not "do I have a `BEGIN`?" but "if a reader landed between any two of my writes, would the state make sense?" Here, today, no reader can land — so the property holds by construction, not by design.

## Primary diagram

```
  putInsights — the only multi-step write, and its window

  ┌─ caller: /api/briefing stream's .start() ────────────────┐
  │  const insights = anomalies.map(anomalyToInsight)         │
  │  putInsights(sid, insights, anomalies)  ◄── 3 statements │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ putInsights ──────────────▼─────────────────────────────┐
  │                                                            │
  │  s = sessionState(sessionId)                               │
  │                                                            │
  │  ┌─ atomic-by-language (single statement) ──┐             │
  │  │  s.insights.clear()                        │             │
  │  └────────────────────────────────────────────┘             │
  │  ┌─ atomic-by-language ──┐                                  │
  │  │  s.anomalies.clear()  │                                  │
  │  └────────────────────────┘                                  │
  │  ┌─ N iterations, each atomic, sequence is not ─┐           │
  │  │  for each item:                                │           │
  │  │    s.insights.set(i.id, i)                     │           │
  │  │    if (rawAnomalies[idx]) s.anomalies.set(...)│           │
  │  └────────────────────────────────────────────────┘           │
  │                                                            │
  │  ← function returns; full new state visible                │
  └────────────────────────────────────────────────────────────┘

  window-of-inconsistency: nanoseconds, no awaits, no concurrent readers today
  contract risk: a future await between statements would expose this
```

## Elaborate

This is the textbook case for `read-modify-write` discipline in a single-threaded runtime: as long as the modify is fully synchronous, you get atomicity for free. The discipline breaks the moment you add an `await` — and the easiest way to add one accidentally is to introduce telemetry, validation, or a derived-fields recomputation that does I/O. The comment at `lib/state/insights.ts:57-63` warns the developer about the WHY of `.clear()` but not about the atomicity contract; a "DO NOT add `await` here" comment would harden it.

Compare to Postgres: this is the equivalent of a session-scoped UPDATE with no explicit BEGIN, in a system where there's only one connection per session. The implicit transaction is the whole statement. Adding a second statement loses you that — which is exactly the situation here at the function level.

If durability ever matters (someone moves the feed to a real store), this function turns into "begin; delete from insights where session = ?; insert ...; commit." That's a natural mapping; the shape doesn't change, only the substrate.

## Interview defense

**Q: Does this app have transactions?**

No — and it mostly doesn't need them, because every session is partitioned in-memory and there's effectively no concurrent reader of a session's state. The one place the concept applies is `putInsights` in `lib/state/insights.ts:57`, which does `.clear()` followed by `.forEach((i) => set(...))`. That's three statements with no atomicity wrapper. Today it's safe because (a) the function is synchronous — no `await` between statements — and (b) the partition prevents two writers for the same session from interleaving.

**Q: What would break that?**

Adding any `await` between the clear and the forEach. A telemetry call, a validation step that does I/O, anything that yields the event loop. A concurrent reader landing in that window would see an empty feed during a briefing. The fix is either "make the function atomic by construction" (build the new state in a local Map, then swap in one assignment) or "wrap it in a per-session async lock." Today, neither is needed.

**Q: How would you make `putInsights` atomic by construction?**

Build the new sub-maps as locals, then swap them in:

```typescript
const newInsights = new Map<string, Insight>();
const newAnomalies = new Map<string, Anomaly>();
items.forEach((i, idx) => {
  newInsights.set(i.id, i);
  if (rawAnomalies?.[idx]) newAnomalies.set(i.id, rawAnomalies[idx]);
});
s.insights = newInsights;
s.anomalies = newAnomalies;
```

Two assignments at the end; readers see either the old maps or the new, never a mix. The catch: `SessionFeed.insights` is typed as `Map<string, Insight>`, not `readonly`, so the swap typechecks — but it would change the reference identity, which would break code that holds onto a reference to the old map. None of the current callers do that. This is the kind of refactor you'd do *before* adding an `await` to the function, not after.

## See also

- `02-records-pages-and-storage-layout.md` — the partition that makes "no concurrent writers" hold
- `06-locks-mvcc-and-concurrency-control.md` — why there are no locks despite this contract gap
- `07-wal-durability-and-recovery.md` — what happens on a crash mid-`putInsights`
- `09-database-systems-red-flags-audit.md` — this is finding #1
