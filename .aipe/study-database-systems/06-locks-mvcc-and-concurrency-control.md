# 06 · Locks, MVCC, and concurrency control

*Locks, snapshot isolation, optimistic/pessimistic control · Case B*

## Zoom out — where this concept lives

Concurrency control is how a DB lets multiple writers proceed without
letting them stomp each other. Two classical strategies: **locks**
(pessimistic — block until safe) and **MVCC** (optimistic — read your
own snapshot, resolve at commit). This repo has neither in the
classical form, but it has one mechanism that plays the MVCC role
brilliantly and several places where the missing lock is felt.

```
Zoom out — where concurrency control would sit

┌─ two concurrent writers ────────────────────────────────┐
│  request A                        request B             │
│    briefing streaming                briefing streaming │
│    for user X                        for user X (same!)│
└──────────────────────┬──────────────┬───────────────────┘
                       │              │
┌─ ★ THIS CONCEPT ★ ──▼──────────────▼───────────────────┐
│  the concurrency control layer                          │
│    · locks: "wait your turn"                            │
│    · MVCC:  "each txn sees a snapshot"                  │
│    · OCC:   "commit if nobody stomped you"              │
│                                                          │
│  this repo has:                                          │
│    · one MVCC-like pattern (AsyncLocalStorage cookies)  │
│    · zero locks (writes are unguarded)                  │
│    · one implicit optimistic pattern (retry ladder)     │
└──────────────────────┬───────────────────────────────────┘
                       │
┌─ storage ────────────▼───────────────────────────────────┐
│  Map, cookie, git                                       │
└─────────────────────────────────────────────────────────┘
```

## Zoom in — the pattern

**The pattern:** *per-request snapshot isolation via
AsyncLocalStorage, no locks anywhere else.* The auth store is
AsyncLocalStorage-scoped — each request reads a snapshot of the
cookie into a private `ctx.store`, works with it, and writes it back
at commit. That IS Multi-Version Concurrency Control at the request
scope. Everywhere else, writes race.

## Structure pass — one axis across the concurrent surfaces

**Axis: "what happens when two concurrent operations touch the same
row?"** (conflict resolution)

```
Trace conflict resolution across the write sites

  Site                         Concurrent access                Resolution
  ────                         ─────────────────                ──────────
  auth store (bi_auth)         two requests, same session        MVCC (per-req)
                                                                  → last commit
                                                                  → wins the cookie
  ────                         ─────────────────                ──────────
  SessionFeed inner Maps       two briefings, same session       none
                                                                  → interleaved
                                                                  → last .set() wins per key
                                                                  → intermediate .clear() wipes
  ────                         ─────────────────                ──────────
  response cache               two callers, same tool+args       none needed
                                                                  → both would fire liveCall
                                                                  → last write-through wins
                                                                  → both callers see the same
                                                                    stable result eventually
  ────                         ─────────────────                ──────────
  localStorage                 two tabs, same key                 none — browser last-write-wins
                                                                  → no `storage` event listener
                                                                    means the other tab reads stale
  ────                         ─────────────────                ──────────
  MCP rate limit               too many callers in time window   server-side, retry ladder
                                                                  → optimistic (retry) not
                                                                    pessimistic (queue)
```

The seams that matter:

  → **The auth-store seam** — MVCC-like at the request scope. Two
    requests read the cookie, each builds a private snapshot, each
    commits back. Whoever writes the cookie **last** wins for state
    the other request also touched. This is exactly the "lost
    update" hazard in optimistic concurrency; it's tolerable here
    because OAuth writes are rare and the browser only makes one
    at a time.

  → **The SessionFeed seam** — no MVCC. Two `putInsights` calls
    interleave and the intermediate `.clear()` wipes state from
    the other.

  → **The rate-limit seam** — optimistic concurrency control at the
    tool-call level. Two callers race for the ~1 req/s slot; the
    Bloomreach server returns 429 to the loser; the loser retries
    with backoff.

The **most load-bearing choice** is the AsyncLocalStorage-scoped
`ctx.store` in `withAuthCookies`. That's the ONLY concurrency-safe
write path in production. Everywhere else the design accepts that
races may happen because the workload doesn't stress them.

## How it works

### Move 1 — the pattern

Two mental models to hold:

**Pessimistic (locks):** "I take the row, you wait. I finish, you go.
No one ever sees a half-written row." Think a `useMutex` or a
`mutex.acquire() → work → mutex.release()` pattern.

**Optimistic (MVCC / OCC):** "We both read the row, do our work on
private copies, and try to commit. If a conflict is detected at
commit time, the losing txn retries. Nobody ever waits."

```
Pattern — pessimistic vs optimistic, side by side

  Pessimistic (locks)                Optimistic (MVCC / OCC)

  request A: acquire(sid) ──►        request A: read(sid) → snap_A
             read + write                        work on snap_A
             release ──►                         commit(snap_A) ── ok
  request B: acquire(sid) ── blocks   request B: read(sid) → snap_B
             (wait for A)                        work on snap_B
             read + write                        commit(snap_B) ── conflict?
             release                              → if yes, retry
```

Kernel of MVCC — three parts, each with what breaks if missing:

  1. **Read timestamp / snapshot at BEGIN.** Missing → readers see
     partial writes.
  2. **Private workspace.** Missing → writes leak into the shared
     store before commit.
  3. **Conflict check / atomic commit.** Missing → last commit wins
     silently, no way to detect a lost update.

### Move 2 — walk the three concurrency surfaces

Three surfaces to walk: the auth-store MVCC, the missing SessionFeed
lock, and the rate-limit ladder as OCC.

#### Surface 1 — `withAuthCookies` as per-request MVCC

The AsyncLocalStorage pattern in `lib/mcp/auth.ts` implements exactly
the three-part kernel above. Trace it against the kernel:

```typescript
// lib/mcp/auth.ts:86-104 (annotated as MVCC)
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;

  // (1) READ TIMESTAMP: decrypt cookie into a snapshot. This snapshot
  //     is the state "as of the start of this request." Concurrent
  //     requests each get their own snapshot.
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };

  // (2) PRIVATE WORKSPACE: ALS-scoped ctx. Every read/write inside
  //     fn() sees THIS ctx, not the shared cookie. No cross-request
  //     visibility.
  const result = await requestStore.run(ctx, fn);

  // (3) COMMIT: one atomic cookie write publishes the whole workspace.
  //     No conflict detection — last-writer-wins by cookie ordering.
  //     This is the OCC "commit without check" variant.
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
      httpOnly: true, secure: true, sameSite: 'none',
      path: '/', maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

```
Sequence — two concurrent requests on the same warm instance

  Request A (agent)              cookie state              Request B (auth callback)
  ────────────────               ────────────              ────────────────────────
  read cookie → snap_A =         { tokens_old }
    {tokens_old}
  ALS scope: ctx_A
                                                            read cookie → snap_B =
                                                              {tokens_old}
                                                            ALS scope: ctx_B
  work on ctx_A (list tools)     { tokens_old }
    no writes → dirty=false                                 work on ctx_B (save new tokens)
                                                              ctx_B.store.tokens = NEW
                                                              ctx_B.dirty = true

  commit A: dirty=false          { tokens_old }
    → NO cookie write                                       commit B: dirty=true
                                                              → cookie.set(NEW)
                                    { tokens_NEW }

  RESULT: A saw tokens_old the whole time.
          B's commit updated the cookie for the next request.
          No conflict, because A didn't try to write.
```

**In DB terms:** this is **snapshot isolation without write skew
protection.** Each request sees a consistent snapshot; commits are
last-writer-wins. This is fine for the OAuth use case because:

  → OAuth writes are rare (once per authorize + once per token
    refresh)
  → The browser only issues one OAuth request at a time
  → A "lost" write means one refresh got clobbered — the user's
    next request re-authorizes, no data loss

**What breaks if you drop the ALS scope:** without it, provider
methods would touch `cookies()` directly. Then two concurrent
requests would BOTH read the cookie and BOTH write to it — but
Next's request-vs-response cookie split means read-after-write in
the same request returns the OLD value. The pattern that emerges is
worse than "lost updates"; it's "stale reads WITHIN a single
request." The ALS scope isn't about concurrency — it's about
Next's cookie API being deliberately non-transactional per call.

#### Surface 2 — the missing SessionFeed lock

Now the counter-example. `putInsights` in `lib/state/insights.ts` has
no snapshot, no workspace, no commit. Just direct mutation:

```typescript
// lib/state/insights.ts:57-71 (annotated as NO concurrency control)
export function putInsights(sessionId: string, items, rawAnomalies?) {
  const s = sessionState(sessionId);
  s.insights.clear();          // ← direct mutation of shared state
  s.anomalies.clear();          // ← direct mutation of shared state
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);    // ← direct mutation of shared state
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

Any concurrent reader on `listInsights` or `getInsight` sees this
mutation live. If the reader lands mid-loop, they see a partial feed.
There is no snapshot they read from; there is no commit they wait
for.

**Comparison — same operation, MVCC vs not:**

```
Comparison — the two write paths in this codebase

  auth store (MVCC-like)                      SessionFeed (no CC)

  ┌──────────────────────────┐              ┌──────────────────────────┐
  │ read cookie → snap       │              │ (no read step)           │
  │                          │              │                          │
  │ enter ALS scope          │              │ (no scope)               │
  │  ctx.store = snap        │              │                          │
  │                          │              │                          │
  │ fn() mutates ctx.store   │              │ .clear() mutates SHARED  │
  │  (private snapshot)      │              │ .set()   mutates SHARED  │
  │                          │              │                          │
  │ commit: cookie.set(...)  │              │ (no commit step)         │
  │  one atomic publish      │              │                          │
  └──────────────────────────┘              └──────────────────────────┘

  concurrent read: sees                     concurrent read: sees the
  pre-commit snapshot                       intermediate state
  (consistent)                              (partial, wrong)
```

**In DB terms:** the auth store is at approximately **snapshot
isolation**. The SessionFeed is at **READ UNCOMMITTED** (or worse —
"read whatever half-written state is in memory").

#### Surface 3 — the rate-limit ladder as OCC

The rate-limit retry logic in `BloomreachDataSource.callTool` is
**Optimistic Concurrency Control at the network level**. Multiple
callers (across warm instances, across users) share a global
Bloomreach rate-limit window; the "conflict" is detected at the
transport (a 429 response); the "retry" is the resolution.

```typescript
// lib/data-source/bloomreach-data-source.ts:163-174
let retries = 0;
while (isRateLimited(result) && retries < this.maxRetries) {
  retries++;
  const hintMs = parseRetryAfterMs(result);
  const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
  const waitMs = Math.min(
    hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
    this.retryCeilingMs,
  );
  await sleep(waitMs);
  result = await this.liveCall(name, args, options.signal);
}
```

Read this like OCC:

  → **Optimistic assumption:** proceed with the call, assume no
    conflict.
  → **Conflict detection:** the server tells you (429 + retry-after
    message).
  → **Backoff and retry:** wait past the penalty window, try again.
  → **Fuse:** `maxRetries` bounds the retry count so the caller
    doesn't loop forever.

The `RETRY_BUFFER_MS = 500` cushion (`lib/data-source/bloomreach-data-source.ts:49`)
is the "land JUST AFTER the penalty clears" move. Without it, the
retry lands ON the boundary and immediately hits the same 429.

**In DB terms:** this is the classic OCC pattern used by e.g.
Google Spanner's read-modify-write cycle. The optimistic path is
cheap (one call); the pessimistic path (queueing at 1 req/s) would
be simpler but block every caller behind the slowest one.

### Move 2.5 — the OCC/MVCC decision, applied

If you wanted to fix the SessionFeed race, which of these three
approaches would you pick?

```
Comparison — three ways to fix putInsights concurrency

  Approach                       Cost                     Fit for this repo
  ────────                       ────                     ─────────────────
  1. Per-session mutex           serialize briefings      good — briefings ARE
     (pessimistic lock)          for the same user         serial in practice;
                                                            adds a Node.js Mutex
                                                            or async-lock dep
  ────────                       ────                     ─────────────────
  2. Version-tagged writes        detect conflict, abort   overkill — no user
     (optimistic / OCC)           the second briefing     reason for a second
                                                            briefing to WIN over
                                                            the first
  ────────                       ────                     ─────────────────
  3. Append-only + briefingId    never clear, filter by   best fit — matches
     (MVCC)                       latest briefingId       the "each run IS the
                                                            current feed" comment
                                                            without the race
```

Approach 3 is the closest thing to what a real DB with MVCC would
give you. Reads always see a consistent briefing (the latest fully-
committed briefingId). Writes are always appends. There is no
`.clear()`, so there is no race window. The cost is memory — you'd
carry old briefings until eviction — but session-scoped memory is
already the domain here.

This isn't a proposed change; it's the shape you'd draw if you
had to. Naming the shape IS the concurrency-control lesson.

### Move 3 — the principle

**Concurrency control is a promise about what readers see and what
writers can lose.** Pessimistic locks promise readers a consistent
row; the cost is writer wait time. Optimistic MVCC promises writers
a private snapshot; the cost is retries on conflict. No control
promises neither and hopes the workload doesn't punish you.

The auth-store's ALS pattern is a great fit for OAuth (rare writes,
one writer per user). The SessionFeed's no-CC is a great fit for
briefings IF the workload stays "one briefing at a time." The
moment either assumption breaks, you feel the missing control as an
anomaly, not as a slow request.

## Primary diagram — the concurrency-control map

```
Concurrency control in blooming_insights — three surfaces, three stories

  ┌── Surface 1: auth store (per-request MVCC-ish) ──────────────┐
  │                                                                │
  │   Request A                        Request B                   │
  │   ┌────────────┐                    ┌────────────┐             │
  │   │ read cookie│                    │ read cookie│             │
  │   │ → snap_A   │                    │ → snap_B   │             │
  │   └─────┬──────┘                    └─────┬──────┘             │
  │         │ ALS scope                       │ ALS scope           │
  │         ▼                                 ▼                     │
  │   ┌────────────┐                    ┌────────────┐             │
  │   │ work on    │                    │ work on    │             │
  │   │ ctx_A      │                    │ ctx_B      │             │
  │   └─────┬──────┘                    └─────┬──────┘             │
  │         │                                 │                     │
  │         ▼                                 ▼                     │
  │   ┌────────────┐                    ┌────────────┐             │
  │   │ commit A:  │                    │ commit B:  │             │
  │   │  cookie.set│                    │  cookie.set│             │
  │   │  (if dirty)│                    │  (if dirty)│             │
  │   └────────────┘                    └────────────┘             │
  │                                                                 │
  │   guarantee: per-request snapshot isolation                    │
  │   caveat:    last committer wins the cookie (lost updates OK)  │
  └────────────────────────────────────────────────────────────────┘

  ┌── Surface 2: SessionFeed (no CC) ────────────────────────────┐
  │                                                                │
  │   Writer A: clear+set+set+set+set+set                          │
  │             │      │      ↓ any reader here sees partial state │
  │   Writer B:       clear+set+set+set                            │
  │                    ↑ this clear wipes writer A's writes        │
  │                                                                │
  │   guarantee: NONE                                              │
  │   caveat:    tolerated because workload is serial in practice  │
  └────────────────────────────────────────────────────────────────┘

  ┌── Surface 3: rate-limit ladder (OCC) ────────────────────────┐
  │                                                                │
  │   callTool → transport → 429 detected                          │
  │           ↑                     │                              │
  │           │ retry              ▼                              │
  │           └─── parse Retry-After → sleep(hint + 500ms)         │
  │                                                                │
  │   optimistic: proceed, detect conflict server-side             │
  │   fuse:       maxRetries=3, retryCeilingMs=20_000              │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where does the MVCC pattern come from?** From Postgres and Oracle,
where each transaction gets a snapshot of the database as of its
start via versioned rows. Readers never block writers, writers never
block readers, and the DB decides at COMMIT time whether to abort
your transaction because of a conflict. AsyncLocalStorage in Node.js
is a *very lightweight* version of the same idea — private context
per async call chain, no cross-context bleed.

**Why AsyncLocalStorage was the right pick for the auth store.**
Alternatives: (1) pass the store as an argument through every
provider-method call (invasive); (2) use a per-request WeakMap keyed
on a request object (Next.js doesn't hand you a stable request ref
inside route handlers); (3) mutate the cookie per-method (hits the
request/response split). ALS is the least-bad choice.

**When would you upgrade to real locks?** When two things become true
at once: (a) the workload starts producing concurrent writes to the
same session, and (b) you need to enforce an invariant across those
writes that MVCC can't (e.g., "the sum of severity across insights
must equal N"). That's when you reach for `async-lock` or move to a
DB with transaction support.

## Interview defense

**"How does this app handle concurrent OAuth flows?"**

Answer: *"Via AsyncLocalStorage in `withAuthCookies`. Each request
decrypts the cookie into a private `ctx.store` at the start, runs
the handler with the store scoped to that context, then re-encrypts
and writes the cookie once at the end. Two concurrent requests on
the same warm instance each see their own snapshot, and the last
committer wins the cookie. It's per-request snapshot isolation —
close to what MVCC gives you at a much lower cost."*

**"What if two briefings run for the same session at once?"**

Answer: *"That's the concurrency risk in `putInsights`. The function
clears the session's inner Maps then loops `.set()`s — with no
snapshot, no workspace, and no commit boundary. Two concurrent
briefings interleave. If it became a real problem, I'd move to an
append-only shape with a `briefingId` field on each insight;
reads would filter by the latest briefingId. That's MVCC by
convention — no locks needed."*

**"Is the rate-limit retry ladder pessimistic or optimistic?"**

Answer: *"Optimistic. It proceeds with the call assuming no
conflict; the server tells us via a 429 when we hit the
rate-limit window; the ladder parses the retry-after hint,
sleeps past the window plus a 500 ms buffer, and retries. Pessimistic
would be a client-side queue at 1 req/s across all callers on the
same instance — simpler but strictly slower because every caller
waits behind the slowest one."*

The load-bearing skeleton part interviewers routinely forget:
**the ALS `dirty` flag.** MVCC without dirty tracking would commit
on every request even when nothing changed, which is fine
correctness-wise but wasteful — cookies count as bytes in every
response. `dirty` is the "no-op commit" optimization, and it maps
directly to Postgres's "COMMIT of an empty transaction is a no-op."

## See also

  → `05-transactions-isolation-and-anomalies.md` — the shape the
    concurrency control has to preserve
  → `07-wal-durability-and-recovery.md` — the durability side of the
    OCC commit
  → `study-distributed-systems/` — extending these ideas across warm
    instances
  → `study-runtime-systems/` — AsyncLocalStorage as a runtime
    primitive
