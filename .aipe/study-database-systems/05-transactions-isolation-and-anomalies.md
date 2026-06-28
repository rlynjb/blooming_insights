# Transactions, isolation, and anomalies

Industry standard · Concurrency correctness

## Zoom out — where transactions would live, and what's there

A transaction is a group of operations that either all happen or none do, observed by other readers as one atomic event. Isolation levels (read-uncommitted, read-committed, repeatable-read, serializable) define what concurrent transactions can see of each other's in-flight work. This codebase has **no transactional boundary anywhere.** Every state write is a single `Map.set`; every read is a single `Map.get`. There's no commit, no rollback, no isolation guarantee — only the JavaScript event loop's run-to-completion semantics.

```
  Zoom out — where transactions would live (and what's there)

  ┌─ Service layer ──────────────────────────────────────────────┐
  │  putInsights(sessionId, items, rawAnomalies?)                 │
  │     clears insights + anomalies for the session               │
  │     then writes both back, one by one                         │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ Map.clear + Map.set (in loop)
  ┌─ State layer ──────────────────▼──────────────────────────────┐
  │  ★ THIS CONCEPT ★                                              │
  │  no BEGIN, no COMMIT, no ROLLBACK                              │
  │  no isolation level configurable                               │
  │  the JS event loop is the ONLY ordering guarantee              │
  │  consequence: a second writer mid-flight could "tear" reads    │
  └────────────────────────────────────────────────────────────────┘
```

## Zoom in — the question this concept answers

In a real DB: "if two operations run concurrently, what does each see of the other, and how do I make multi-step writes safe?" Here: "is there any guarantee that the briefing the UI reads is consistent with what was just written?" Short answer: yes for single-Map-operation reads (the event loop guarantees that), no for any read that spans multiple operations — but the architecture mostly avoids those reads on purpose.

## Structure pass — the skeleton

### The four ACID properties — and which ones we have

  - **Atomicity** — all-or-nothing. **NOT GUARANTEED.** `putInsights` is a `clear` + loop of `set`s. If the process dies mid-loop, the Map is half-populated.
  - **Consistency** — invariants preserved. **APPLICATION-ENFORCED.** No DB to enforce; TypeScript types + validator (`lib/mcp/validate.ts`) do shallow checks.
  - **Isolation** — concurrent ops don't see each other's partial state. **PARTIAL.** Single Map operations are isolated (JS event loop); multi-step write sequences are not.
  - **Durability** — committed writes survive crashes. **NONE.** No disk. → see `07-wal-durability-and-recovery.md`.

### The classical isolation anomalies

```
  anomaly             what it is                              can it happen here?
  ─────────           ───────────────────────────────         ────────────────────
  dirty read          reading another tx's uncommitted writes Maybe — see putInsights
  non-repeatable read same row, second read returns different Yes — between calls
  phantom read        same WHERE, new rows appear             Yes — between calls
  lost update         your write overwrites mine              Yes — last-write-wins
  write skew          two writes that race on a constraint    N/A — no constraint
```

### Axis: where does the ordering guarantee come from?

```
  The "ordering" axis, traced through the stack

  ┌─ HTTP / Vercel ─────────────────────────────────────────┐
  │  no ordering — independent requests on independent      │
  │  ephemeral instances; the same session can land on      │
  │  different processes at the same time                   │
  └─────────────────────────────────────────────────────────┘
       ┌─ Node event loop ───────────────────────────────────┐
       │  run-to-completion: ONE microtask at a time         │
       │  → individual sync ops on a Map are atomic relative │
       │    to other code on the same loop                   │
       └─────────────────────────────────────────────────────┘
            ┌─ Map operations ──────────────────────────────┐
            │  one Map.set or Map.get is a single statement │
            │  → no interleaving WITHIN one op              │
            └───────────────────────────────────────────────┘
```

The ordering guarantee is *per-operation* (JS atomicity) and *per-instance* (the Map only sees its own process). There is no cross-instance ordering, no cross-request transactional grouping.

### Seams

The seam that matters most: **between writes that look atomic and aren't.** `putInsights` looks like one call from the outside; inside, it's a clear + loop. A reader hitting between the clear and the writes sees an empty session. That's the dirty-read shape — accidentally exposed.

## How it works

### Move 1 — the mental model

If you've ever shipped a React component that does `setUsers([]); users.forEach(u => addUser(u))` and watched the UI flash empty for a frame — you've felt the no-transaction problem. Same shape here. The flash is the moment between "everything cleared" and "everything re-populated," and a reader who arrives during the flash sees the empty state as if it were final.

```
  The shape — the no-transaction "window"

  time ────────────────────────────────────────────────────►

  putInsights():
    [Map.clear]                                  ← window opens
                [Map.set #1]
                              [Map.set #2]
                                            …
                                                [Map.set #N]    ← window closes

  a concurrent read that arrives anywhere in the window
  sees a PARTIAL truth — not "before" and not "after"
```

In a real DB, the whole sequence would be wrapped in a transaction and the reader's snapshot would either be "before the BEGIN" or "after the COMMIT." Here, the reader can land in the middle.

### Move 2 — the walkthrough

#### The "transaction" boundary: there isn't one

```ts
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

Annotation:
  - **Line 64** — `sessionState` returns (or creates) the per-session sub-maps. This is the "namespace" boundary; the function never touches another session's data.
  - **Lines 65-66** — `clear()` on insights and anomalies. After these two lines run, the session's insights table is empty.
  - **Lines 67-70** — re-populate, one row at a time. The Map grows from 0 to N entries one entry per loop iteration.
  - **No BEGIN, no COMMIT.** If you wrapped this in `try { ... } catch { rollback() }`, there's no rollback to call. If the loop throws partway, the session ends with a partial Map and no way to undo.

The function is *idempotent at the granularity of the whole call* — if you run it twice with the same input you get the same end state. But it is NOT atomic — a concurrent reader can see the intermediate states.

#### Why the JavaScript event loop saves you (mostly)

```
  The event loop's safety net

  task 1: putInsights(sessionA, [...])      ← starts, runs SYNCHRONOUSLY
            clear · set · set · set · ... · set
            └────────────────────────────┘
                  one synchronous block

  task 2: getInsight(sessionA, "abc")       ← cannot interrupt task 1
            waits until task 1 yields the loop
```

`putInsights` is synchronous from top to bottom — there's no `await`, no `setTimeout`, no `process.nextTick`. So while `putInsights` is mid-loop, *no other code on the same event loop runs*. A `getInsight` request that arrives during `putInsights` gets queued and runs *after* `putInsights` returns.

That's where the practical safety comes from. NOT from a transaction. From the event loop.

The cases where this safety net leaks:
  - **Two warm Vercel instances serving the same session.** Each has its own event loop; they cannot block each other. → see F3 in `audit.md`.
  - **An `async` write path with an `await` inside.** Today `putInsights` has no `await`. The day one is added (say, to write to a real DB), the safety disappears and the function needs real transactional discipline.

#### Reads that span multiple operations

The risky pattern in any no-transaction system: read A, do something based on it, read B, write a decision. Between A and B, the world can change. The repo mostly *avoids* this pattern. Two examples worth pointing at:

  - **`/api/agent` reads the insight, then runs the diagnostic agent against it, then writes the investigation back.** Between read and write, several seconds elapse and several Bloomreach round-trips happen. If a *new* briefing replaces the insights in that window, the investigation still refers to the *old* insight by ID — and the old insight is gone from the Map. The handler defends against this by stashing the insight in `sessionStorage` on the client (`useInvestigation.ts`, `lib/hooks/useBriefingStream.ts:56`) so the client can re-supply it; the server doesn't need to keep it around.
  - **`putInsights` is called from a streaming handler.** The whole briefing is built incrementally; only at the end does `putInsights` get called with the final array. There is no per-anomaly write that a reader could observe mid-build.

Both are *architectural* defenses against the missing transactional guarantee, not engine-level ones.

#### Isolation level — implicit "read-uncommitted" with intra-call atomicity

If we had to label what we have on the classical isolation hierarchy: read-uncommitted with *the modifier that any single Map op is atomic*. A reader can see any synchronous step's intermediate state, but cannot see a half-completed Map.set (because Map.set itself is a single op).

In practice: it would feel like read-committed for the patterns the app actually exercises, because nothing async-yields mid-write. But the *guarantee* is much weaker than read-committed, and the day someone adds an `await` to `putInsights` without thinking, the guarantee silently drops.

### Move 3 — the principle

A transaction is two things: a *grouping* (these N operations are one logical event) and a *guarantee* (other observers see all or none of them). When you have neither, every multi-step write is a potential consistency bug, and the only defense is to *not write that way* — to make state updates idempotent, replaceable, and small enough that they happen in one synchronous burst. That's what this repo does. The transactional discipline lives in the architecture (full re-compute, single-shot replace) rather than in the engine (there is none). It works at this scale; it would not survive any meaningful concurrent write workload.

## Primary diagram

```
  The transaction story — what guarantees, where they come from

  ┌─ "transaction-like" guarantees this codebase has ────────────┐
  │                                                                │
  │  • single Map.set is atomic            (from V8)              │
  │  • synchronous block on one event loop  (from Node)            │
  │  • per-session namespace isolation      (from sessionState)    │
  │                                                                │
  │  → in practice: writes within one putInsights() are atomic    │
  │    relative to reads ON THE SAME INSTANCE on the same loop     │
  └────────────────────────────────────────────────────────────────┘

  ┌─ guarantees this codebase does NOT have ─────────────────────┐
  │                                                                │
  │  • atomicity across instances          (no shared substrate)   │
  │  • atomicity across async boundaries   (no await in writers)   │
  │  • durable commit                      (no disk)               │
  │  • rollback on error                   (no log)                │
  │  • repeatable read                     (re-read can differ)    │
  │  • serializability                     (no concurrency control)│
  │                                                                │
  │  → in practice: this is fine because writes are full          │
  │    replaces, never partial updates, and clients stash the      │
  │    insight they need on their side                             │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The classical reference for isolation is the SQL standard's four levels and Berenson et al.'s "A Critique of ANSI SQL Isolation Levels" (1995), which catalogued the anomalies each level allows. PostgreSQL's MVCC implementation gives you read-committed by default and serializable on request; many embedded engines serialize all writes globally. In-memory KV stores (Redis, Memcached) usually offer per-key atomicity and nothing larger; transactional KV (FoundationDB, etcd) brings serializability with a coordination cost.

This codebase sits at the "per-op atomicity" floor — it's structurally similar to Memcached's contract, just without the network. The interesting move when you finally need transactions is: are they SINGLE-key (`Map.set` is fine), MULTI-key inside one namespace (need a write lock or MVCC), or CROSS-namespace (need a distributed transaction)? The product hasn't asked for any of these yet. When it does, the answer points at a real datastore.

## Interview defense

> Q: "How does this app handle transactional updates?"

Verdict: it doesn't, because it doesn't have any multi-step writes that need to be atomic. Every "write" is either a single `Map.set` (which V8 makes atomic) or a `putInsights` call that's a clear-then-loop happening synchronously on one event loop. The architecture avoids the partial-write problem by making every state update a full replace — there are no patch-style mutations to interleave.

```
  the picture you draw — the no-transaction safety net

   putInsights()  ──synchronous──►  clear · set · set · … · set
                  └────────────── one tick of the loop ──────────┘
                                       readers wait
```

The load-bearing point: this works because the write path is synchronous AND the dataset is computed-from-scratch. Both have to be true. The day either changes — an `await` is added, or partial updates become a pattern — the safety net is gone and we need a real transactional substrate.

> Q: "What's the worst anomaly you could see?"

Two warm Vercel instances serving the same session concurrently can produce torn reads, because each instance has its own Map and event loop. Instance A writes one set of insights; instance B writes another; whichever instance the next request lands on determines what the UI sees. The mitigation is that briefings always replace fully, so eventual divergence resolves on the next run.

> Q: "What's the isolation level?"

If forced onto the SQL hierarchy, read-uncommitted with the caveat that single Map ops are atomic. In practice it behaves like read-committed for the patterns the app actually exercises, because no writer yields the loop mid-write. The guarantee is much weaker than the felt behavior, which is a risk if someone adds an `await` to a writer without realizing what the implicit contract was.

## See also

  - [`06-locks-mvcc-and-concurrency-control.md`](./06-locks-mvcc-and-concurrency-control.md) — what isolation is implemented with, in real DBs
  - [`07-wal-durability-and-recovery.md`](./07-wal-durability-and-recovery.md) — the durability half of ACID
  - [`audit.md`](./audit.md) — F3 (concurrent writes), the operational consequence
