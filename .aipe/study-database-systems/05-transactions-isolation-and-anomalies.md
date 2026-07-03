# Transactions, isolation, and anomalies

*ACID + isolation levels / Language-agnostic*

## Zoom out, then zoom in

You know how in Postgres you write `BEGIN; UPDATE ...; UPDATE ...; COMMIT;` and if the second `UPDATE` fails everything rolls back — that's atomicity. You know how `READ COMMITTED` sees committed rows only, while `REPEATABLE READ` sees the same snapshot for the whole txn — that's isolation. This repo has none of the machinery. It has one atomic unit — *the JavaScript event-loop turn* — and one isolation boundary — *the sessionId*. This file walks the standard model, then names which anomalies are impossible here, which are possible, and which the repo silently ignores.

```
  Zoom out — where "atomicity" and "isolation" live

  ┌─ UI (browser) ─────────────────────────────────────────────┐
  │  a card click → sessionStorage stash → nav to investigate   │
  │  (client-side state; single reader)                         │
  └────────────────────────┬───────────────────────────────────┘
                           │  HTTP + bi_session cookie
  ┌─ Service (Vercel warm instance) ▼──────────────────────────┐
  │                                                             │
  │  ★ session Map<sessionId, SessionFeed>     insights.ts:14   │ ← this file's scope
  │  ★ AsyncLocalStorage-scoped auth store     auth.ts:47       │
  │  ★ 60s TTL response cache                  bloomreach-…:122 │
  │                                                             │
  │  atomic unit:   one synchronous JS turn                     │
  │  isolation:     sessionId (outer Map key) +                 │
  │                 request-scoped ALS (auth store)             │
  │                                                             │
  └────────────────────────┬───────────────────────────────────┘
                           │
  ┌─ Provider (Bloomreach) ▼──────────────────────────────────┐
  │  their txns / isolation are opaque; we never see them      │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** The reason there's no `BEGIN/COMMIT` here is that the writes are so tiny — replacing one session's feed, updating one auth cookie — that Node's event loop already gives you the atomicity you'd need. But that means the isolation levels you *have* are two: "one JS turn" and "one request scope." Anything wider needs a real DB.

## Structure pass

**Axis to hold constant: what's the atomic unit — how much can fail together?**

```
  "how much can fail as one unit?" — traced across the layers

  ┌─ synchronous JS statements ─────────────────────────────┐
  │  the JS turn is atomic — no other code can interleave   │  → atomic unit = turn
  │  between `s.insights.clear()` and `s.insights.set(...)` │
  └─────────────────────────────────────────────────────────┘
      ┌─ across an `await` ─────────────────────────────────────┐
      │  event loop resumes other pending work; state you       │  → atomic unit ends
      │  read before the await may be stale after               │    at every await
      └────────────────────────────────────────────────────────┘
          ┌─ across the request boundary ─────────────────────────┐
          │  the ALS-scoped auth store flushes to the cookie once │  → atomic unit =
          │  at the end of the request (auth.ts:86-104)           │    the whole request
          └───────────────────────────────────────────────────────┘
              ┌─ across MCP tool calls ─────────────────────────────┐
              │  no cross-tool atomicity. Each callTool is its own    │  → no atomic unit
              │  attempt. Retries on rate-limit are not "the same     │    beyond one call
              │  transaction," they're new attempts.                  │
              └───────────────────────────────────────────────────────┘
```

Two visible atomic units: the JS turn (for local `Map` writes) and the request (for the auth cookie). The seam that flips the axis is **every `await`**. That's the interesting one, because you can accidentally hold "old" state across it if you cache values in locals — see the auth-cookie discussion below.

## How it works

### Move 1 — the mental model

The classic anomaly taxonomy, minus SQL:

```
  the four canonical anomalies

  dirty read      → txn A reads txn B's uncommitted write, B rolls back
  non-repeatable  → same query in txn A returns different rows on re-read
  phantom read    → same range query returns different row COUNT on re-read
  lost update     → txn A reads X, txn B reads X, both write X+1, one wins
  write skew      → both txns pass a check, both write, invariant broken
```

Standard isolation levels are what you buy against each:

```
  isolation levels — what they prevent

  READ UNCOMMITTED   → prevents nothing (rare in production)
  READ COMMITTED     → prevents dirty reads
  REPEATABLE READ    → also prevents non-repeatable + phantom (in MVCC engines)
  SERIALIZABLE       → prevents all anomalies, including write skew
```

This repo runs at what you might call "session-scoped serializable" — the sessionId partitions every dataset so cross-session anomalies don't exist. Within a session there is exactly one write path per key, so intra-session write skew doesn't exist either. What you *can* still hit are the anomalies that come from `await` — read-then-await-then-write patterns where the "then" hides a state change.

The kernel:

```
  what's atomic here — the JS-turn rule

  turn N-1:    other request running
             ─────────────────────── ← turn ends
  turn N:      putInsights(sid, items) {
                  s.insights.clear()          ┐
                  s.anomalies.clear()         │  ONE atomic block:
                  for each item:              │  no other code
                     s.insights.set(id, i)    │  can observe an
                     s.anomalies.set(id, a)   │  intermediate state.
               }                              ┘
             ─────────────────────── ← turn ends
  turn N+1:    next microtask, next request, next tool result...
```

Every synchronous block bracketed by turn boundaries IS a transaction. The line `s.insights.clear()` cannot possibly interleave with another handler's `s.insights.set(...)` because Node's event loop doesn't multitask synchronous code. That's the whole guarantee, and it's real.

### Move 2 — the primitives walked

**`putInsights` — the replace-the-briefing atomic write.**

```ts
// lib/state/insights.ts:57-71
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  const s = sessionState(sessionId);       // (1) get-or-create session's row group
  s.insights.clear();                      // (2) wipe this session's insights
  s.anomalies.clear();                     // (3) wipe this session's anomalies
  items.forEach((i, idx) => {              // (4) re-populate — synchronously
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

The four steps run in one turn. Between (2) and (4), the session has an empty feed — but no other code on this warm instance can observe that empty state because the whole function is `void`, no `await`, no yield. In DB terms this is `DELETE FROM insights WHERE session_id = ?; INSERT ... FROM values(...)` wrapped in `BEGIN/COMMIT`, and the isolation comes free from the runtime.

The bug this shape *fixed* is documented in the header comment at `insights.ts:5-7`:

> A single warm Vercel instance serves many users concurrently, so module-level Maps would bleed between sessions — and putInsights' clear() would wipe another user's feed mid-briefing.

Pre-fix: one flat `Map<insightId, Insight>` at module scope. `putInsights` for user B calls `clear()`, wiping user A's simultaneous briefing. That's the equivalent of a `TRUNCATE TABLE insights` in every session's transaction. The fix — session-keying the outer Map — is the "isolation level" this code chose.

**`saveInvestigation` — write-through to two backing stores.**

```ts
// lib/state/investigations.ts:30-41
export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
  mem.set(insightId, events);              // (1) write to in-memory
  if (PERSIST) {
    const all = readJson(CACHE_FILE);      // (2) read the file
    all[insightId] = events;               // (3) mutate the object
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(all));  // (4) rewrite the file
    } catch { /* best effort */ }
  }
}
```

This is dev-only (`PERSIST = NODE_ENV === 'development'`). Read-modify-write on a JSON file. It's *not* atomic across (2)-(4) with respect to other concurrent writes to the same file — if two dev routes both saved investigations at the same instant, one could clobber the other's write between the readJson and the writeFileSync. In practice: one dev server, one user, doesn't matter. In production: this whole branch is dead code (`PERSIST` is false), and there's no shared filesystem to race on anyway.

That's the honest characterization: **the write skew here is real, and the mitigation is "there's only one writer, dev-only."**

**AsyncLocalStorage-scoped auth store — request-atomic cookie flush.**

```ts
// lib/mcp/auth.ts:86-104
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
      httpOnly: true, secure: true, sameSite: 'none', path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

This is the closest thing to a real transaction in the repo:

1. **BEGIN** — decrypt the cookie into `ctx.store`, seed AsyncLocalStorage.
2. Every `readState`/`patchState` call inside `fn()` reads from and writes to `ctx.store`, not the cookie directly (see `readAll`/`writeAll` at `auth.ts:113-142`).
3. **COMMIT** — if any write happened (`ctx.dirty`), re-encrypt and `set` the cookie once.

That's snapshot isolation at the request granularity: within the request, the auth state is a consistent snapshot; between requests, the new snapshot only becomes visible after the response commits the cookie. The specific bug this defended against is described in the comments at `auth.ts:41-46`:

> To avoid Next's request-vs-response cookie split (a read *after* a set in the same request returns the OLD value)...

That's a *non-repeatable read within one request*. Without the ALS shim you'd `patchState({ tokens: T })` then immediately `readState()` and get the OLD value — the write went to the response cookie, the read comes from the request cookie. The ALS store is the "we buffer both in the same place until commit" trick.

**MCP retry loop is NOT a transaction.**

```ts
// lib/data-source/bloomreach-data-source.ts:163-175
let retries = 0;
while (isRateLimited(result) && retries < this.maxRetries) {
  retries++;
  const hintMs = parseRetryAfterMs(result);
  const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
  const waitMs = Math.min(hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs, this.retryCeilingMs);
  await sleep(waitMs);
  result = await this.liveCall(name, args, options.signal);
}
```

Each retry is a fresh call. There is no cross-call atomicity — if the first attempt executed a side effect and only the response was rate-limited (unlikely for read-only EQL, but possible for mutating tools), the retry double-executes. This is why *every tool used by this repo is read-only*. The design accepts "no atomicity across the retry" by *never mutating* through MCP.

### Move 2 variant — the load-bearing skeleton

What's the smallest atomicity story this repo needs?

1. **The JS-turn atomicity of `putInsights`.** Add an `await` inside the loop and cross-session bleed comes back through the front door — one user's briefing could be half-written when the next user's request starts a new turn.
2. **The sessionId in the outer Map key.** Remove it and every isolation guarantee collapses to "one user total."
3. **The ALS store in `withAuthCookies`.** Remove it and the OAuth handshake sees stale token state within the callback request.

The rest — file-write best-effort in `saveInvestigation`, retry backoff — is hardening.

### Move 3 — the principle

**Pick your atomic unit consciously and don't cross it.** In this repo the units are the JS turn (for Map writes) and the request (for the auth cookie). Every write is designed to fit inside one unit. When you're tempted to add an `await` between a `clear()` and a `set()`, or a `readState()` and a `patchState()`, that's the moment you've silently downgraded your isolation level. Real databases hide this behind `BEGIN/COMMIT`; here it's on you to see it.

## Primary diagram

```
  Atomicity + isolation, the whole picture

  ┌─ turn atomicity (in-memory writes) ────────────────────────┐
  │                                                             │
  │  event loop turn:                                           │
  │    putInsights(sid, items) {                                │
  │        s.insights.clear();          ┐                       │
  │        s.anomalies.clear();         │  ← this whole block   │
  │        for i in items:              │    is atomic — no     │
  │           s.insights.set(...);      │    interleave possible │
  │           s.anomalies.set(...);     │                       │
  │    }                                ┘                       │
  │                                                             │
  │    lib/state/insights.ts:57-71                              │
  └─────────────────────────────────────────────────────────────┘

  ┌─ session isolation (per-user "database") ──────────────────┐
  │                                                             │
  │  state = Map<sessionId, SessionFeed>                        │
  │                                                             │
  │    session A               session B                        │
  │      insights:                insights:                     │
  │        {A1,A2,A3}               {B1,B2}                     │
  │                                                             │
  │    putInsights(A, [...]) NEVER touches B's inner Maps       │
  │                                                             │
  │    lib/state/insights.ts:14, 25-71                          │
  └─────────────────────────────────────────────────────────────┘

  ┌─ request isolation (auth cookie) ──────────────────────────┐
  │                                                             │
  │  request N:                                                 │
  │    BEGIN   → decrypt cookie → ALS ctx.store                 │
  │    fn() runs; many readState / patchState calls hit ctx     │
  │    COMMIT  → if dirty, re-encrypt + set cookie              │
  │                                                             │
  │  request N+1: sees the freshly-set cookie                   │
  │                                                             │
  │    lib/mcp/auth.ts:86-104                                   │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The interesting philosophical point: **this repo has serializable isolation for free, but only because the concurrency pattern is degenerate.** Each session has exactly one writer per request; each request runs on one warm-instance turn at a time. Node's event loop enforces "one turn at a time" and the sessionId enforces "one user's data at a time." You could argue the repo is *always* running at SERIALIZABLE — every read-write is a single-turn operation, so the entire history serializes trivially into "turn 1 by user A, turn 2 by user B, ..." with no conflict.

That falls apart the instant you introduce:
- A shared mutable resource across sessions (e.g. a global rate-limiter's token bucket).
- A multi-turn operation that has to span `await` (e.g. "load X, compute, save X" over the same key).
- A shared filesystem in production (Vercel doesn't give you one; this is why the dev-file backend at `investigations.ts:30-41` isn't used in prod).

For now, none of those exist, so the "no isolation machinery" answer is defensible. Concrete anomaly the repo is exposed to today:

- **Non-repeatable read across `await` in `withAuthCookies`** — solved via the ALS store.
- **Lost update on `.investigation-cache.json` in dev** — accepted; single-writer environment.
- **Write skew across sessions** — impossible by shape (sessions don't share keys).
- **Phantom reads in `listInsights`** — impossible; the "range" is one session's inner Map, no other writer.

### `not yet exercised`

- **`BEGIN/COMMIT`, savepoints, distributed 2PC.** No engine.
- **Explicit isolation-level configuration.** No engine.
- **MVCC snapshot / undo log.** No engine.
- **Deadlock detection.** No locks that could deadlock.
- **Serializable snapshot isolation (SSI) conflict tracking.** No.

## Interview defense

**Q: "How does this app avoid two users' briefings clobbering each other?"**

Model answer: "Two mechanisms, layered. The outer key of the state Map is the sessionId — `lib/state/insights.ts:14`, `Map<sessionId, SessionFeed>`. Each session has its own inner Maps for insights, anomalies, and investigations, so `clear()`-then-repopulate touches only that session's data. That's the isolation boundary. The atomicity boundary is the JS turn: `putInsights` at `insights.ts:57-71` is fully synchronous — no `await` between the clears and the sets. Node's single-threaded event loop cannot interleave two of those, so a concurrent handler either sees the full old feed or the full new feed, never a half-written one. Together: session-scoped, turn-atomic writes. In DB terms it's serializable, but only because the shape is degenerate — one writer per session per turn."

Diagram to sketch: the "turn atomicity + session isolation" primary diagram, top and middle boxes.

**Q: "Where can a race still happen?"**

Model answer: "Two places. First: `saveInvestigation` in `lib/state/investigations.ts:30-41` does a read-modify-write on `.investigation-cache.json` in dev. Two simultaneous writes could lose one. Mitigation is 'it's dev-only, one developer, one process' — production doesn't run this branch (`PERSIST` gates it). Second, and more interesting: any future code that spans an `await` between a read and a write of the same session key. `putInsights` today is safe because it's synchronous end-to-end; adding `await` inside would break that guarantee silently. The `withAuthCookies` pattern at `auth.ts:86-104` is the model to copy — it buffers writes into an ALS-scoped store and flushes once at the request boundary, which is how you get 'request-atomic' when a single turn isn't enough."

Anchor: sync writes = turn-atomic; async writes need ALS-style buffering to stay atomic.

**Q: "What isolation level would you say this runs at?"**

Model answer: "Effectively SERIALIZABLE, and it's a lucky consequence of the shape rather than a configuration. The sessionId key means no two txns ever touch the same rows. The JS-turn atomicity means any single txn is indivisible from the outside. Together you get the strongest isolation level for free. The moment the shape changes — a global shared resource, a cross-session query surface, a multi-turn write — you'd want to move to something real. Until then, calling it 'SERIALIZABLE by construction' is honest."

Anchor: SERIALIZABLE by construction — session key + JS turn = no interleave possible.

## See also

- `01-database-systems-map.md` — the state topology this file zooms in on.
- `06-locks-mvcc-and-concurrency-control.md` — why no locks are needed given the atomicity story here.
- `07-wal-durability-and-recovery.md` — what happens to "committed" state on warm-instance death.
- `study-runtime-systems` — the event-loop mechanics that make the JS-turn atomicity real.
