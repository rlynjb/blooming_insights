# Transactions, Isolation, and Anomalies

## Subtitle

How a database guarantees a group of operations behaves like one · Industry standard.

## Zoom out, then zoom in

```
  Zoom out — where transactions sit in a normal app

  ┌─ App ──────────────────────────────────────────┐
  │  BEGIN; UPDATE; UPDATE; COMMIT;                │
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ Database ─────────▼───────────────────────────┐
  │  ★ TRANSACTIONS ★                              │
  │  atomicity (all or nothing)                    │
  │  consistency (constraints hold)                 │
  │  isolation (concurrent txns don't see each      │
  │             other's in-progress writes)         │
  │  durability (committed survives a crash)        │
  └────────────────────────────────────────────────┘
```

### Verdict for this codebase

**Partially exercised — Olist seed wraps a bulk insert in `db.transaction(...)`. Main app has none.**

Two altitudes:

- **Main app:** still no `BEGIN` / `COMMIT`. Every state mutation is a single Map operation:
  - `putInsights()` calls `clear()` then sets entries (not atomic, see 06)
  - `saveInvestigation()` is one `mem.set()` plus an optional file write
  - `patchState()` in auth is one `writeAll()` call
- **Olist seed** (`mcp-server-olist/scripts/seed-olist.ts` L508-544): one explicit ACID transaction wraps all ~30k inserts across 7 tables. SQLite's default isolation is **serializable** (one writer at a time, full isolation), so this is the strongest level by default.

```
  the one real transaction in this repo
  (mcp-server-olist/scripts/seed-olist.ts L508-544)

  const allInsert = db.transaction(() => {
    for (const c of customers) insertCustomer.run(...);    ← 5000 inserts
    for (const p of products) insertProduct.run(...);      ← 800 inserts
    for (const o of allOrders) {                            ← ~10000 orders
      insertOrder.run(...);
      for (const it of o.items) insertItem.run(...);        ← items per order
      for (const p of o.payments) insertPayment.run(...);   ← payments per order
      if (o.review) insertReview.run(...);
    }
    for (const a of SEEDED_ANOMALIES) insertAnomaly.run(...);
  });
  allInsert();    ← BEGIN; ... 30k inserts ...; COMMIT
       │
       └─ better-sqlite3's db.transaction(fn) returns a wrapped function. when
          called, it BEGINs, runs the body, COMMITs on success, ROLLBACKs on
          throw. ~30k inserts in one transaction is the right shape: rolling
          back 30k separate auto-commits would be 30k fsync hits; one transaction
          is one fsync at COMMIT. The seed takes <2s on a laptop because of this.
```

### When this becomes load-bearing for the main app

### When this becomes load-bearing for the main app

The trigger is **any feature where two related rows must change together or not at all.**

```
  features that would force this concept

  "save an insight + record the save event in audit log"
     → both rows write or neither: transaction needed

  "transfer a credit from user A to user B"           (classic example)
     → both balance updates atomic: transaction needed

  "create an investigation + its 12 reasoning steps"
     → 13 rows must commit together or rollback

  "update insight's status to 'archived' only if
   current status is 'active' (optimistic concurrency)"
     → SELECT FOR UPDATE or version column needed
```

Today: zero of these exist. Every state mutation here is single-row, so there's nothing to make atomic.

## Structure pass

Skipped — no codebase instance.

## How it works

### Move 1 — the mental model

A transaction is a fence around a group of operations. Inside the fence, the database promises: either all of them happen, or none of them do, and other transactions don't see partial results. The fence is what lets you write `transfer money from A to B` as two updates instead of as some single atomic balance-swap operation.

```
  the pattern — transaction lifecycle

       BEGIN
         │
         ├─ UPDATE accounts SET balance = balance - 100 WHERE id = A
         │
         ├─ UPDATE accounts SET balance = balance + 100 WHERE id = B
         │
         ├─ ... if anything throws ...
         │       ROLLBACK   ←  both writes undone, B never saw +100
         │
         └─ COMMIT          ←  both writes visible to others atomically
```

### Move 2 — the moving parts

**Move 2a — ACID.** The properties a transactional engine claims:

- **A**tomicity — all writes commit or none do (undo log + recovery)
- **C**onsistency — constraints (`NOT NULL`, `CHECK`, FK) hold across the txn boundary
- **I**solation — concurrent txns don't see each other's in-progress state (level configurable)
- **D**urability — committed writes survive a crash (WAL — see 07)

**Move 2b — isolation levels, the dial.** ANSI SQL names four levels; the higher you go, the fewer anomalies are possible, the more contention you pay for.

```
  the four-level dial

  read uncommitted    can see another txn's uncommitted writes (dirty reads)
                      almost no engine actually offers this; Postgres treats
                      it as read committed

  read committed      Postgres default. only sees committed data. but the
                      same query in the same txn can return different rows
                      if another txn commits between two reads (non-repeatable
                      read)

  repeatable read     every read in this txn sees the same snapshot. cannot
                      see another txn's commits made after our txn started.
                      mostly fixes non-repeatable reads. phantoms still
                      possible.

  serializable        the highest level. behaves AS IF txns ran one at a
                      time, in some serial order. Postgres uses SSI (Serializable
                      Snapshot Isolation) to detect violations and abort one.
```

**Move 2c — the anomalies.** Each anomaly is a category of "this happened concurrently and now your data is wrong":

- **dirty read** — read uncommitted data; if that txn rolls back, you read something that never existed
- **non-repeatable read** — re-read same row, get different value because someone committed in between
- **phantom read** — re-run same query (e.g. `WHERE x > 5`), get a row that didn't exist last time
- **lost update** — both txns read X, both write X+1, second commit overwrites first; you lost a write
- **write skew** — both txns read overlapping sets, write disjoint rows; constraint that should hold across the set is now violated (the on-call doctors case)

Bridge: think of two browser tabs both editing the same Google Doc without operational transform. Without isolation, both write their changes and one wins silently — that's lost update.

### Move 3 — the principle

**Transactions are a contract that lets you write code as if you were alone.** Without them, every multi-write operation must be hand-coded to be re-entrant and conflict-aware — which is exactly the trap concurrent programming has always been. The whole reason relational databases beat hand-rolled storage layers is that ACID transactions are *correct by default*, where the alternative is correct-if-you-think-of-everything.

## Primary diagram

Skipped — no codebase instance.

## Implementation in codebase

### Use cases

- **`mcp-server-olist/scripts/seed-olist.ts`** wraps the entire ~30k-row bulk insert in `db.transaction(() => { ... })()` (L508-544). One BEGIN, one COMMIT, one fsync at the end. The seed runs in <2s because of this; without the transaction it would be 30k auto-commits = 30k fsync hits = minutes.
- **Read-only tool calls** from the MCP server are NOT wrapped in explicit transactions — SQLite gives each `db.prepare(sql).all(...)` an implicit read transaction, which under WAL mode is a consistent snapshot of the DB.
- **Main-app cookie writes** in `lib/mcp/auth.ts` `withAuthCookies` — the closest transaction-shaped code in the main app (read-modify-write coalesced per request).

### The real transaction — Olist seed

```
  mcp-server-olist/scripts/seed-olist.ts  (lines 508–544)

  const allInsert = db.transaction(() => {
    for (const c of customers) insertCustomer.run(c.id, c.state, c.city);
    for (const p of products) insertProduct.run(p.id, p.category, p.weight_g);
    const knownCustomerIds = new Set(customers.map((c) => c.id));
    for (const o of allOrders) {
      if (!knownCustomerIds.has(o.customer.id)) {
        insertCustomer.run(o.customer.id, o.customer.state, o.customer.city);
        knownCustomerIds.add(o.customer.id);
      }
      insertOrder.run(o.id, o.customer.id, o.status, o.purchase_ts, o.delivered_ts);
      for (const it of o.items) insertItem.run(...);
      for (const p of o.payments) insertPayment.run(...);
      if (o.review) insertReview.run(...);
    }
    for (const a of SEEDED_ANOMALIES) insertAnomaly.run(...);
  });
  allInsert();
       │
       └─ what each ACID property means here:
          A (atomicity)   — if any of the 30k inserts fail (FK violation,
                            unique constraint), ALL roll back. No half-seeded
                            DB possible.
          C (consistency) — FK constraints checked at COMMIT; PRAGMA foreign_keys
                            is ON when the seed reopens the DB (db.ts L41).
          I (isolation)   — SQLite is serializable by default. No other writer
                            could interleave (and we have none here anyway —
                            the seed is the only writer).
          D (durability)  — at COMMIT, SQLite fsyncs the WAL; the DB file then
                            gets checkpointed later. The committed binary
                            in git captures the post-commit state.
```

### The closest cousin — Node's single-threaded "isolation" (main app)

```
  lib/state/insights.ts  (lines 30–42)

  export function putInsights(items, rawAnomalies?) {
    insights.clear();              ← operation 1
    anomalies.clear();             ← operation 2
    items.forEach((i, idx) => {    ← operations 3...N
      insights.set(i.id, i);
      if (rawAnomalies?.[idx])
        anomalies.set(i.id, rawAnomalies[idx]);
    });
  }
       │
       └─ this function does N+2 mutations. it runs to completion within
          one tick of the event loop — meaning no OTHER synchronous code
          on the same instance can observe intermediate state. that's the
          closest thing to "transaction isolation" we have, and it only
          holds because the body has zero awaits.
          
          if you added an `await` between clear() and the forEach loop,
          another concurrent request handler could run during the await,
          observe insights.size === 0, and act on it. Node's single-thread
          gives you atomicity FOR FREE only when there's no await inside
          the critical section.
          
          across TWO instances (Vercel scale-out) there's no isolation at
          all — both can race, both can clear and re-fill in interleaved
          order, and the resulting Map state on each is a partial mix.
          named in section 06.
```

```
  lib/mcp/auth.ts  (lines 86–104)

  export async function withAuthCookies(fn) {
    if (NODE_ENV !== 'production') return fn();
    const raw = (await cookies()).get(AUTH_COOKIE)?.value;
    const ctx = { store: raw ? decryptStore(raw) : {}, dirty: false };
    const result = await requestStore.run(ctx, fn);
    if (ctx.dirty) {
      (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {...});
    }
    return result;
  }
       │
       └─ this is the most transaction-shaped code in the repo. it does:
          BEGIN: read the cookie, decrypt to a request-scoped store
          BODY:  fn() runs with the store as the source of truth
          COMMIT: if dirty, re-encrypt and write the cookie back
          
          it's a 2-phase pattern: read once, mutate in-memory many times,
          flush once. Without it, every provider call (saveTokens,
          saveClientInformation, saveCodeVerifier) would read-modify-write
          the cookie and the request-vs-response cookie split would tear.
          this isn't ACID — there's no rollback if the request errors mid-
          way (the cookie just doesn't get written, which is the right
          behavior here) — but the SHAPE is transactional.
```

## Elaborate

The ACID acronym was coined by Härder and Reuter in 1983, and isolation has been the contested property ever since. Lower isolation levels exist because higher ones are expensive — serializable transactions abort more often under contention, and the retry cost is real. Most production Postgres systems run at read-committed and accept the anomalies they can — that's a sane default, not a bug.

For an app like blooming insights, the practical question once you add a database is not "do I want ACID" (yes) but "do I want serializable or repeatable read." The honest answer is usually "read committed plus carefully placed `SELECT FOR UPDATE` where you have invariants across rows." The day a feature here demands a multi-row invariant, you'll meet this concept for real.

Cross-link: `06-locks-mvcc-and-concurrency-control` is the mechanism that implements isolation. This file is the contract; that file is the enforcement.

## Interview defense

**Q: "Do you have any transactional code in this app?"**
One real one. The Olist seed script (`mcp-server-olist/scripts/seed-olist.ts` L508-544) wraps ~30k inserts across 7 tables in `db.transaction(() => { ... })`. better-sqlite3 emits BEGIN at function entry, COMMIT on return, ROLLBACK on throw. The seed runs in <2s because of this — without the transaction, 30k auto-commits would be 30k fsync hits and take minutes. SQLite's default isolation is serializable, so this is the strongest level by default. In the main Next.js app there's no engine, so no BEGIN/COMMIT — the closest pattern is the `withAuthCookies` wrapper in `lib/mcp/auth.ts` L86-104, which is 2-phase-shape (read once, mutate in memory, write once at exit) without being ACID.

Diagram: the BEGIN-body-COMMIT shape, with `db.transaction(() => ...)` named explicitly.

Anchor: `mcp-server-olist/scripts/seed-olist.ts` L508-544 (real transaction); `lib/mcp/auth.ts` L86-104 (transaction-shaped, not ACID).

**Q: "If you added a save-favorites feature with Postgres, what isolation level would you pick?"**
Read committed, the Postgres default. Save-favorites is a single-row insert per favorite — there's no multi-row invariant. If we later added "your top 10 favorites" with a hard cap, I'd reach for `SERIALIZABLE` on just the insert path (or `SELECT FOR UPDATE` on the cap check) — but I wouldn't pay the cost across all queries.

Diagram: the isolation-level dial with read-committed circled.

Anchor: no DB exists yet; this is a hypothetical I'd flag as such.

## Validate

**Level 1 — reconstruct.** From memory, name the four ANSI isolation levels and one anomaly each one fixes.

**Level 2 — explain.** Why does `putInsights()` work "atomically enough" today even without a transaction? (Answer: Node's single-threaded event loop, no awaits in the body, single instance most of the time. Each of these falsehoods is a real failure mode — see section 06.)

**Level 3 — apply.** Suppose we add an audit log: every insight save also writes an `audit_events` row. What can go wrong if we don't wrap both in a transaction? (Answer: insight save succeeds, audit write fails, no row in audit referring to a save that happened — silent data loss for compliance use cases.)

**Level 4 — defend.** Argue against using `SERIALIZABLE` everywhere "just to be safe." (Answer: SSI aborts retry-heavy workloads under contention, and most queries don't have multi-row invariants. The right move is read-committed by default, escalate per-query where invariants exist. Premature `SERIALIZABLE` makes the system slower and adds retry handling everywhere for benefit you don't need.)

## See also

- `06-locks-mvcc-and-concurrency-control` — how isolation actually gets enforced
- `07-wal-durability-and-recovery` — the D in ACID (now exercised in Olist)
- `10-embedded-sqlite-fixture` — better-sqlite3's `db.transaction(fn)` API
- `01-database-systems-map` — the Map state that today has neither A, C, I, nor D

---
Updated: 2026-06-16 — partially exercised; Olist seed transaction at mcp-server-olist/scripts/seed-olist.ts L508-544 named with all four ACID properties grounded. Main-app verdict unchanged.
