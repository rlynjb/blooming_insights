# 05 · Transactions, isolation, and anomalies

*Atomicity, isolation levels, and the anomalies you inherit for free · Case B*

## Zoom out — where this concept lives

Transactions are the DB feature that lets you say "these writes are
one unit." Isolation levels are the DB knob that says "these reads see
a consistent snapshot despite concurrent writers." This repo has
**neither** — no BEGIN/COMMIT, no isolation level, no per-row versioning.
Every write is `map.set()`; every read is `map.get()`. That means every
classical concurrency anomaly is available to you for free, and you
have to reason about them explicitly.

```
Zoom out — where transactions would sit in a normal app

┌─ business logic ──────────────────────────────────────┐
│  save briefing:                                        │
│    put insights[]                                      │
│    put investigations[]                                │
│    stamp coverage report                               │
│  ↑ in a DB this would be ONE transaction               │
└──────────────────────────┬────────────────────────────┘
                           │
┌─ ★ THIS CONCEPT ★ ──────▼────────────────────────────┐
│  atomicity      — all-or-none writes                  │
│  isolation      — reads see a consistent snapshot     │
│  durability     — commits survive crashes             │
│  consistency    — invariants hold across the writes   │
│                                                        │
│  this repo has:                                        │
│    · no atomicity (writes are per-.set())            │
│    · no isolation (reads race with writers)          │
│    · one durability tier (cookie)                    │
│    · consistency enforced ONLY by comments            │
└──────────────────────────┬────────────────────────────┘
                           │
┌─ storage ────────────────▼────────────────────────────┐
│  Map, cookie, git                                     │
└───────────────────────────────────────────────────────┘
```

## Zoom in — the pattern

**The pattern:** *no transactions, one intentional "commit boundary"
per request.* The only place in the codebase that looks like a
transaction is `withAuthCookies` in `lib/mcp/auth.ts` — it BEGINs an
AsyncLocalStorage-scoped store, lets the request do many writes, and
COMMITs by flushing the cookie once. Everywhere else, writes commit
one at a time and races are possible.

## Structure pass — one axis across the writes

**Axis: "at what point is a write visible to another reader?"**
(visibility / commit boundary)

```
Trace write-visibility across the write sites

  Write site                    Commit boundary                Race window?
  ─────────────                 ─────────────────              ────────────
  putInsights (feed)            per .set() (no commit at all)   YES
  putInvestigation              per .set() (no commit at all)   YES
  withAuthCookies (auth)        one cookie.set() at end          NO (per-req)
  writePersistedConfig          per localStorage.setItem()       cross-tab race
  eval receipts write           per writeFileSync                between runs
  demo snapshot write           per writeFileSync                per capture
```

The seams that matter:

  → **The `putInsights` seam** — the outer Map is not cleared, but
    the inner sub-map is unconditionally `.clear()`-ed at the top of
    the function. That's the biggest anomaly surface in the codebase:
    a concurrent second briefing wipes the first mid-flight. This is
    the exact case that a DB transaction would eliminate.

  → **The `withAuthCookies` seam** — this is the ONE place that
    behaves like a transaction. Everything inside `requestStore.run`
    reads/writes a private snapshot; the commit happens exactly once
    at the end via `cookies().set`. That discipline is the reason
    OAuth flows work at all.

  → **The `eval/receipts` seam** — writes are per-case, in filename
    order, isolated between runs because runId is in the filename.
    No two runs touch the same file. That's a **naming-convention
    transaction**: isolation by physical path, not by lock.

The **most load-bearing move** is the AsyncLocalStorage-scoped
transaction in `withAuthCookies`. That's the only place the codebase
enforces a commit boundary. Everywhere else, invariants ride on
comments and prayer.

## How it works

### Move 1 — the pattern

You know a `useEffect` cleanup function that runs before the next
effect fires. That "start-do-end" shape — set up context, do work,
tear down — is exactly what a database transaction is. `BEGIN` sets
up, `COMMIT` tears down and publishes.

```
Transaction — pattern skeleton

  BEGIN
    ┌─────────────────────────┐
    │ private snapshot        │
    │ of the store            │
    │                         │
    │ writes go HERE          │
    │ reads go HERE (isolated │
    │ from other txns)        │
    └───────────┬─────────────┘
                │
                ▼
  COMMIT
    ┌─────────────────────────┐
    │ atomic publish          │
    │ to the shared store     │
    └─────────────────────────┘

  What breaks if there is no BEGIN/COMMIT:
    - a reader in the middle sees partial writes
    - two writers racing produce interleaved results
    - a crash mid-work leaves the store half-updated
```

The kernel is three parts:

  1. **The private snapshot** (aka the "workspace") — what the
     transaction reads/writes. Isolated from other in-flight txns.
  2. **The commit** — the atomic publish to the shared store.
  3. **The abort** — the "throw away the workspace, don't publish"
     path. **What breaks without abort:** every error leaks partial
     state into the shared store. In this repo, most write paths
     have no abort concept at all.

### Move 2 — walk the three write sites

Three concrete write sites in the code, three different stories.

#### Site 1 — `putInsights` (the race)

The most anomaly-rich write site in the repo:

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
  s.insights.clear();                                   // ← wipe
  s.anomalies.clear();                                  // ← wipe
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);                            // ← per-.set() write
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

Read the shape: `.clear()` → loop `.set()`. In DB terms this is
`DELETE FROM ... WHERE sessionId = ?; INSERT ...` — two statements,
no wrapping transaction. If any reader lands between the `.clear()`
and the last `.set()`, they see either **an empty feed** or a
**partial feed**. Both are wrong.

```
Sequence — the race window (two concurrent briefings, same session)

  briefing A                    inner state             briefing B
  ──────────                    ───────────             ──────────
  clear()      ──────────►     [empty]
  set(A1)      ──────────►     [A1]
  set(A2)      ──────────►     [A1, A2]
                                                        clear()  ── wipes A!
                                                        set(B1)
  set(A3)      ──────────►     [B1, A3]      ← INTERLEAVED
                                                        set(B2)
                                [B1, A3, B2]
  ──── reader lands here ──►   [B1, A3, B2]  ← ANOMALY
```

**In DB terms:** this is a **dirty write** on the "insights" table.
Two concurrent updates to the same session key with no wrapping
transaction. A real DB would either serialize them (repeatable-read
isolation) or reject one (serializable). Here neither happens.

**Why the code accepts this:** because the caller pattern is "one
active user, one briefing at a time." The odds of a real user
triggering two overlapping briefings for the same session are low.
But **the code doesn't enforce that**; the human pattern does.

**What would fix it:**

  → *Optimistic*: version-tag each briefing, only commit `.set()`s
    that match the version at start. Second briefing sees a
    mismatch and aborts.

  → *Pessimistic*: a lock per sessionId. Second briefing waits
    until the first completes.

  → *MVCC*: never clear; add a `briefingId` to each insight; reads
    filter by the latest briefingId. This is the "immutable
    append-only" style.

The comment above `putInsights` names the reason for the clear (avoid
accumulating stale insights across runs). It does not name the race.
That's the finding to flag.

#### Site 2 — `withAuthCookies` (the one transaction)

Now the counter-example — a real, working transaction pattern:

```typescript
// lib/mcp/auth.ts:86-104
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };  // BEGIN
  const result = await requestStore.run(ctx, fn);        // do work in ALS scope
  if (ctx.dirty) {                                        // COMMIT (if any write happened)
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
      httpOnly: true, secure: true, sameSite: 'none',
      path: '/', maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

Trace it as a transaction:

  1. **BEGIN**: decrypt the cookie, build `ctx = { store, dirty }`,
     enter the ALS scope.
  2. **Work**: `fn()` runs. Every provider method inside reads/writes
     `ctx.store` via `readAll()` / `writeAll()` (which detect the
     ALS scope and use it).
  3. **COMMIT**: after `fn()` returns, if `ctx.dirty`, re-encrypt
     the whole store and set the cookie. That's the atomic publish.

Look at the writer side:

```typescript
// lib/mcp/auth.ts:125-142
function writeAll(store: Store): void {
  const ctx = requestStore.getStore();
  if (ctx) {
    ctx.store = store;
    ctx.dirty = true;                          // mark for commit at request end
    return;                                     // no cookie touched here
  }
  // ... fallthrough to memStore or file
}
```

**Each provider-method write updates the ALS-scoped store and sets
`dirty = true`. NO COOKIE IS WRITTEN INSIDE `fn()`.** All writes
accumulate in the private snapshot; only the outer `withAuthCookies`
publishes.

Why this discipline exists — the comment names it:

```typescript
// lib/mcp/auth.ts:39-45
// To avoid Next's request-vs-response cookie split (a read *after* a set in the
// same request returns the OLD value), we never touch the cookie per
// provider-method call. `withAuthCookies` seeds an AsyncLocalStorage-scoped store
// from the cookie ONCE at the start of the request and flushes it back ONCE at
// the end; the provider's many synchronous read/write calls hit that store in
// between. Each request gets its own ALS context, so concurrent requests on one
// instance never share state.
```

That comment IS the isolation guarantee. **Each request has its own
ALS context → concurrent requests on one Vercel instance never share
state.** In DB terms, this is **snapshot isolation** at the request
level: each request sees a consistent snapshot of the store as of
its start, and only its own writes are visible to itself until
commit.

**In DB terms:** `withAuthCookies` is a *serialized transaction per
request*. The commit is atomic (one cookie set). The isolation is
strong (no other request sees your ALS-scoped writes). The abort is
implicit — if `fn()` throws, `ctx.dirty` may or may not be set, but
you can wrap in `try/finally` if you want stricter abort semantics.

**What breaks without this discipline:** the AGENT would set a
cookie per provider-method call and hit Next's cookie split — reads
after writes in the same request return the OLD value. That was the
original bug this pattern fixes. Naming Next's request-vs-response
cookie split is the interview signal here.

#### Site 3 — `eval/receipts/*.json` (isolation by naming)

The eval receipt writes are the third pattern: **no in-process
concurrency at all, isolation enforced by the file name.**

Each receipt file is named `<caseId>-<runId>.json`. Two concurrent
eval runs have different `runId`s (they're timestamps down to the
millisecond) → different filenames → no conflict.

```
Comparison — three isolation strategies in this codebase

  putInsights                withAuthCookies              eval receipts
  ─────────────              ────────────────             ─────────────
  no isolation               per-request snapshot         per-run filename
  (dirty-write race)         (via AsyncLocalStorage)      (physical isolation)

  reader sees:               reader sees:                 reader sees:
    interleaved              atomic post-commit           complete file only
    partial state            or nothing new               (fs.writeFileSync is
                                                          synchronous)

  fixes needed:              works as designed            works as designed
    lock, version,           for OAuth writes             for eval runs
    or MVCC
```

In DB terms, the eval receipts pattern is like **partitioning by runId
and appending only** — each run gets its own physical file, and the
`readdirSync` in the gate is the "scan the partition" operation.

### Move 2.5 — the anomalies you get for free

Every classical anomaly is available in this codebase. Here's each
one, with the site that exposes it:

```
Anomaly matrix — where each classical anomaly lives in this repo

  Anomaly            Where it happens                       Fix if you cared
  ────────           ─────────────────                      ────────────────
  Dirty read         listInsights during putInsights        wrap in txn
                     — sees post-clear, pre-set state
  ────────           ─────────────────                      ────────────────
  Dirty write        two putInsights, same session          lock or version
  ────────           ─────────────────                      ────────────────
  Lost update        two setMode() in different tabs        cross-tab msg
                     race on localStorage bi:mode
  ────────           ─────────────────                      ────────────────
  Non-repeatable     listInsights called twice in a         snapshot iso
     read            handler with a putInsights in between
  ────────           ─────────────────                      ────────────────
  Phantom read       add new insight between two listInsights snapshot iso
  ────────           ─────────────────                      ────────────────
  Write skew         not yet exercised — no cross-row       serializable iso
                     invariants in this codebase
```

Most of these are **theoretical in practice** because the human
usage pattern (one user, one session, one briefing at a time) doesn't
exercise the race. That's the honest framing — the code accepts the
anomalies because the workload doesn't trigger them.

### Move 3 — the principle

**A transaction is a shape you draw around code, not a feature you
turn on.** When there's no DB, you draw it yourself with
AsyncLocalStorage, mutexes, versioning, or naming conventions. When
there IS a DB, `BEGIN` / `COMMIT` is the shape.

The reason `withAuthCookies` reads like a transaction and
`putInsights` reads like a race is that ONE of them consciously
drew the shape and the other didn't. The concept of "transaction"
survives the absence of a database — it just becomes your job to
enforce it.

## Primary diagram — the two shapes side by side

```
The transaction question in blooming_insights — one shape, one no-shape

  ┌── SHAPE (withAuthCookies) ────────────────────────────────────┐
  │                                                                │
  │   BEGIN                                                        │
  │     ctx = { store: decrypt(cookie), dirty: false }            │
  │     enter AsyncLocalStorage scope                              │
  │                                                                │
  │       ┌────────────────────────────────────────────┐          │
  │       │ fn() runs                                   │          │
  │       │                                             │          │
  │       │  provider.saveTokens(t)  ─► ctx.store.tokens = t     │
  │       │                              ctx.dirty = true         │
  │       │  provider.saveClientInformation(ci) ─► ctx.store... │
  │       │                                        ctx.dirty=true │
  │       └────────────────────────────────────────────┘          │
  │                                                                │
  │   COMMIT                                                       │
  │     if ctx.dirty:                                              │
  │       cookies().set(AUTH_COOKIE, encrypt(ctx.store), {…})     │
  │     leave ALS scope                                            │
  │                                                                │
  │   isolation: PER-REQUEST snapshot                              │
  │   atomicity: one cookie write publishes N logical writes       │
  └────────────────────────────────────────────────────────────────┘

  ┌── NO-SHAPE (putInsights) ─────────────────────────────────────┐
  │                                                                │
  │   ┌── caller enters ──┐                                        │
  │   │                    │                                        │
  │   ▼                    │                                        │
  │   sessionState(sid).insights.clear()                            │
  │   sessionState(sid).anomalies.clear()                           │
  │                                                                 │
  │       ← reader can land HERE, see empty feed                    │
  │                                                                 │
  │   for each insight:                                             │
  │     s.insights.set(id, insight)                                 │
  │     s.anomalies.set(id, anomaly)                                │
  │                                                                 │
  │       ← reader can land HERE, see PARTIAL feed                  │
  │                                                                 │
  │   return                                                        │
  │                                                                 │
  │   isolation: NONE                                               │
  │   atomicity: NONE                                               │
  │   remedy:    caller pattern (one briefing at a time)            │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where does the "transaction as a shape" idea come from?** From
every system that had to invent transactions before a DB. Filesystems
have `rename()` as an atomic commit. Redis has `MULTI` / `EXEC` as a
pipeline transaction. Git has the commit as a snapshot transaction
(the working tree is the private workspace; `git commit` is COMMIT;
`git reset` is ABORT). The instinct is universal because concurrent
writers show up in every system that has more than one writer.

**Isolation levels are the ONLY reason a DB is hard to reason
about.** ACID transactions in a single-writer world are trivial. The
complexity comes from letting multiple writers proceed AT THE SAME
TIME and defining what each one sees of the others. This repo skips
that complexity by having one writer per session — the same reason
SQLite is popular for embedded apps.

**When would you add real transactions here?** When you gain any of
three things: a cross-user query (aggregating across sessions),
concurrent writers to the same session (e.g., a shared team
briefing), or a durability boundary that isn't the cookie (e.g.,
"keep this briefing across redeploys"). All three point at Postgres.

## Interview defense

**"How does this app handle concurrent writes?"**

Answer: *"It mostly doesn't — and that's a deliberate choice. There's
exactly one transaction-shaped code path, `withAuthCookies` in
`lib/mcp/auth.ts`, which uses AsyncLocalStorage to isolate an OAuth
store per request and commit it as a single cookie write at the end.
Everywhere else — the briefing feed, the investigations, the
localStorage config — writes are per-`.set()` with no isolation, and
the code relies on the human usage pattern (one active briefing at a
time per session) to avoid races."*

**"What's the worst race in the codebase?"**

Answer: *"`putInsights` in `lib/state/insights.ts:57`. It clears the
session's inner Maps, then loops `.set()`s. A concurrent reader can
land in the clear-then-set window and see either an empty feed or a
partially-written feed. The fix would be either a per-session lock,
an optimistic version tag on the briefing, or an append-only
briefing-id shape that never mutates old entries."*

**"How does OAuth avoid this problem?"**

Answer: *"AsyncLocalStorage. `withAuthCookies` runs the request
handler inside an ALS scope with a `ctx = { store, dirty }` object.
Every provider-method write updates `ctx.store` and marks `dirty =
true` — NO COOKIE is touched during the request. When the handler
returns, if `dirty` is set, ONE cookie write publishes all
accumulated writes atomically. This exists specifically because
Next's cookies API has a request-vs-response split: a read after a
set in the same request returns the OLD value. Deferring the commit
to end-of-request avoids that."*

The load-bearing skeleton part interviewers routinely forget: **the
`ctx.dirty` flag.** Without it, every request writes the cookie
even when nothing changed, which is wasted bandwidth AND resets the
10-day max-age unnecessarily. The `dirty` flag is what makes the
cookie write conditional — same reason a DB skips COMMIT-time WAL
writes when nothing dirty happened.

## See also

  → `01-database-systems-map.md` — the six tiers each write lands in
  → `06-locks-mvcc-and-concurrency-control.md` — the AsyncLocalStorage
    pattern as "per-request MVCC"
  → `07-wal-durability-and-recovery.md` — the cookie commit as the
    fsync boundary
  → `study-distributed-systems/` — the same concerns raised again
    with warm-instance boundaries
