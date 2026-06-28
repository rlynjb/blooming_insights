# WAL, durability, and recovery

Industry standard · Crash recovery internals

## Zoom out — where durability would live, and what's there

A write-ahead log is the mechanism that makes a database survive crashes: every change is appended to an on-disk log *before* the change is applied to the actual data pages, so a crash mid-write can be replayed (REDO) or unwound (UNDO) from the log on restart. Backups, point-in-time recovery, and replication all build on the WAL. This codebase has **no WAL, no durability of any kind, and no recovery path** — because there's no on-disk data of record to recover.

```
  Zoom out — where durability would live (and what's there)

  ┌─ Service layer ──────────────────────────────────────────────┐
  │  putInsights · saveInvestigation                              │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ writes
  ┌─ "Durability" layer ───────────▼──────────────────────────────┐
  │  ★ THIS CONCEPT ★                                              │
  │                                                                │
  │  PRODUCTION:                                                   │
  │    in-memory Map only — no disk, no WAL, no backup             │
  │    process restart → all session state LOST                    │
  │    no recovery path (none needed; data of record is upstream)  │
  │                                                                │
  │  DEVELOPMENT:                                                  │
  │    in-memory Map + best-effort JSON file write                 │
  │    .investigation-cache.json (whole-file rewrite per save)     │
  │    no fsync, no atomic rename — last writer wins               │
  └────────────────────────────────────────────────────────────────┘
                                  │ (durability owned by provider)
                                  ▼
                       Bloomreach Engagement
```

## Zoom in — the question this concept answers

In a real DB: "if the process dies right now, what survives, and how do we get back to a consistent state?" Here: "what's lost on restart, and does it matter?" Answer in one line: **everything in the local Map is lost; nothing of record is lost; the recovery path is 'run the briefing again.'**

## Structure pass — the skeleton

### The four moves of crash-safe durability — and which ones we do

```
  move                        what it is                       this repo
  ────                        ─────────────────                ─────────
  append to log (WAL)         every write → log entry first    NOT DONE
  flush log to disk (fsync)   sync the log before ack          NOT DONE
  apply to data pages         lazy; can happen later           NOT APPLICABLE
  replay on restart           re-do log from last checkpoint   NOT APPLICABLE
```

The chain is sequential: skipping any link breaks the durability story. We skip the first one — there is no log — so the rest is moot.

### What we DO have, by environment

  - **Production (Vercel).** In-memory Map only. Process restart → all state lost. No recovery; the briefing is re-runnable.
  - **Development (Next dev server).** In-memory Map + JSON file. The dev server hot-reloads modules constantly; the file is the only thing that survives a module re-eval. No fsync, no transactional file write.
  - **Auth state in production.** Encrypted httpOnly cookie. The browser IS the durable store for the OAuth tokens. Survives instance death, survives deployment, because it lives outside the server.

### Axis: where does the data of record live?

```
  The "data of record" axis

  ┌─ Bloomreach ──────────────────────────────┐
  │  durable, owned, recoverable — by THEM    │   ← everything that matters
  └───────────────────────────────────────────┘
       ┌─ this repo (production) ──────────────┐
       │  derivative only; loss = re-compute   │   ← nothing to recover
       └───────────────────────────────────────┘
            ┌─ this repo (dev) ──────────────────┐
            │  derivative + a few cached helpers │   ← convenience, not record
            └────────────────────────────────────┘
```

The provider owns durability for the only data that needs durability. Everything in this repo is derivative — losing it costs computation, not information.

### Seams

The seam that matters most: **production vs development.** In production, there is no file persistence at all (`PERSIST = process.env.NODE_ENV === 'development'`). In development, the JSON files exist *only to survive Next's hot-reload* — which would otherwise blow away the in-memory Map every time a `.ts` file is saved. The dev file persistence is a developer-experience tool, not a durability feature.

## How it works

### Move 1 — the mental model

If you've ever run a Node process locally, hit Ctrl-C, restarted it, and watched all your in-memory state vanish — that's the durability story here, in production. The "fix" in normal apps is to back the state with a database; the fix here is to make the state cheaply regeneratable so the user doesn't notice when it's gone.

```
  The shape — durability by NOT needing it

  ┌─ provider (Bloomreach) ─┐
  │  data of record         │  ← survives forever (their problem)
  └─────────────────────────┘
            │
            │  query
            ▼
  ┌─ this process ──────────┐
  │  in-memory Map          │
  │  ──────────             │
  │  ✗ dies on restart      │
  │  ✓ rebuilt by re-query  │  ← the recovery path
  └─────────────────────────┘
```

The recovery path isn't "replay a log." It's "ask Bloomreach again." That works because the local state is *derived* from upstream data; nothing's been computed that can't be re-computed.

### Move 2 — the walkthrough

#### Production: zero durability, by design

The state files (`lib/state/insights.ts`, `lib/state/investigations.ts`) gate file writes behind `PERSIST = process.env.NODE_ENV === 'development'`:

```ts
// lib/state/investigations.ts:7
const PERSIST = process.env.NODE_ENV === 'development';
```

```ts
// lib/state/investigations.ts:30-41
export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
  mem.set(insightId, events);
  if (PERSIST) {
    const all = readJson(CACHE_FILE);
    all[insightId] = events;
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(all));
    } catch {
      /* best effort */
    }
  }
}
```

Annotation:
  - **Line 31** — always write to the in-memory Map. This is the only durable write in production (and "durable" here means "lives until the process dies").
  - **Line 32** — `if (PERSIST)` — in production, this branch never runs. Vercel's filesystem is read-only at runtime; even if we wanted to write, we couldn't.
  - **Lines 33-39** — dev-only path. Read the entire file, splat the new entry on top, write the entire file back. There's no append, no journal, no fsync. The `try/catch` makes a write failure silently best-effort — "if disk is full or the file is locked, just skip the write and the in-memory copy is still good."

The `insights.ts` state file has no file persistence at all, not even in dev — its data is per-briefing-run and replaced wholesale each time. There's nothing to persist between runs.

#### The recovery path: re-run the briefing

If a production instance dies, the next request from the same session lands on a fresh instance with an empty Map. The user clicks "refresh" (or it auto-refreshes), the briefing re-runs, and the state rebuilds in ~10-30 seconds. The recovery operator is the user.

```
  Recovery flow on cold start

  user clicks → briefing API → monitoring agent → Bloomreach queries
                                                       ↓
                                              insights rebuilt
                                                       ↓
                                              putInsights() → fresh Map
                                                       ↓
                                              UI renders normally
```

There is no concept of "recovering to a specific point in time." There's only "recompute the latest." The briefing is idempotent at the run level: same Bloomreach data → same anomalies (modulo the LLM's nondeterminism on borderline cases).

#### Why no WAL — what a WAL would even protect

A WAL exists to convert *partial writes* into *durable atomic writes*. The classic shape:

```
  WAL discipline in a real engine

  1. write [{insert insight 1, insert insight 2, ...}] to log file
  2. fsync the log file (now it's durable)
  3. ack the client: "committed"
  4. lazily apply the writes to data pages
  5. on crash: replay the log from the last checkpoint
```

We skip step 1 because we have no log file. We skip step 2 because we have no fsync to do. We never ack a "commit" because there's no commit boundary — `putInsights` returns when the in-memory Map is updated, and that's all it claims. We don't replay on restart because we don't restart from a checkpointed state; we restart from empty.

The reason this works: **nothing has been written that someone else committed to.** The user never gets a "your briefing is saved" message. The product surface doesn't promise durability, so the engine doesn't need to provide it.

#### The dev-mode JSON files — convenience persistence, not durability

```ts
// lib/state/investigations.ts:9
const DEMO_FILE = join(process.cwd(), 'lib/state/demo-investigations.json');
```

```ts
// lib/state/investigations.ts:13-20
function readJson(path: string): Record<string, AgentEvent[]> {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* ignore */
  }
  return {};
}
```

Annotation:
  - The `try/catch/return {}` shape is the dev file's "recovery": if the file is missing or corrupt (e.g., truncated by a crash mid-write), treat it as empty. There's no log to replay; we just start fresh.
  - This is the right shape for a *cache* (which is all the file is) and the wrong shape for a system of record. A real database would never silently swallow a corrupt data file.
  - In production this code path is unreachable because `PERSIST` is false. The file would not exist on Vercel anyway.

#### The auth cookie — the one production durability story

The OAuth/PKCE state in production is encrypted into an httpOnly cookie:

```ts
// lib/mcp/auth.ts:46-49
interface RequestStore { store: Store; dirty: boolean }
const requestStore = new AsyncLocalStorage<RequestStore>();
const AUTH_COOKIE = 'bi_auth';
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 10; // 10 days, matches token lifetime
```

Annotation:
  - The browser is the durable substrate. It survives instance death, deployments, even browser restarts (until the cookie max-age expires).
  - This is the only production state that crosses instance boundaries. It works because the durable medium (the cookie) is *outside the server*.
  - It's not a WAL, not a backup, not replication — it's a single durable copy with the client. Equivalent to writing to a single replicated KV store from the server's perspective.

This is the architectural escape hatch: when you genuinely need state to survive across instances, you move it *out of the server* — to the browser, to a managed service, or eventually to a real datastore.

### Move 3 — the principle

Durability is a contract: "after I ack your write, the data survives a crash." The cost of providing it is real — a WAL, fsync overhead, recovery logic, backup tooling. When the product makes no durability promise (every operation is re-runnable, every fact lives upstream), all of that cost is wasted weight. The right move is to be honest about which writes need durability and which don't. Most of this codebase's writes don't; the one that does (OAuth) gets its durability from a place that already has it (the browser cookie). Pulling more state into the "needs durability" category is a product decision that should justify its cost.

## Primary diagram

```
  Durability and recovery — the complete picture

  ┌─ writes by environment ───────────────────────────────────────┐
  │                                                                 │
  │   PRODUCTION                          DEVELOPMENT               │
  │   ──────────                          ───────────               │
  │   putInsights        → Map only       Map + (no file)           │
  │   saveInvestigation  → Map only       Map + .investigation-     │
  │                                              cache.json         │
  │   auth state         → cookie         Map + .auth-cache.json    │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘

  ┌─ recovery paths ──────────────────────────────────────────────┐
  │                                                                 │
  │   instance dies                                                 │
  │      ↓                                                          │
  │   next request hits fresh instance                              │
  │      ↓                                                          │
  │   Maps are empty                                                │
  │      ↓                                                          │
  │   client re-supplies (sessionStorage stash) where it can        │
  │   client re-runs briefing where it must                         │
  │   cookie restores auth automatically                            │
  │      ↓                                                          │
  │   system back to working in seconds                             │
  │                                                                 │
  │   the recovery operator: THE USER (or the client re-fetch)      │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The classical WAL design comes from System R and ARIES (Mohan et al., 1992). The five properties — atomicity, durability, repeated history, logical undo, and steal/no-force buffer policy — are what every major engine's recovery system descends from. PostgreSQL, MySQL InnoDB, Oracle all implement variants. Modern systems extend it: distributed WALs (Kafka, replicated logs), append-only log-structured stores (LSM trees in RocksDB, Cassandra, ScyllaDB), shared-disk recovery (Aurora). The shape is remarkably stable across forty years.

This codebase opts out of that lineage entirely, and that's correct *for this product*. It's worth noting where the opt-out would NOT be correct:
  - **System of record.** Any app where losing the user's data is the bug. The "we don't promise durability" line stops working.
  - **Audit log.** Any app where "what happened and when" is itself the artifact. The reasoning trace today is per-request and lost on instance death; turning that into an audit log requires durability.
  - **Long-running computation.** Any app where a multi-minute job produces a result the user expects to retrieve later. Today the briefing fits in one request and the answer comes back synchronously; the day it doesn't, a job table with durable rows lands.

Each of those is a *product* trigger. None are present today.

## Interview defense

> Q: "What's the durability story for this app?"

Verdict: in production, there's no on-disk persistence at all — every Map dies with the process. There's no WAL, no backup, no replication, no recovery procedure. The product doesn't promise durability, so the engine doesn't provide it. The recovery path is "the user clicks refresh and the briefing re-runs against Bloomreach," which works because everything stored locally is derived from upstream data.

```
  the picture you draw — derivative everywhere, durable upstream

   provider ──► (durable, theirs)
        │
        ▼
   in-memory Map ──► (dies on restart, fine because derivable)
        ▲
        │ recovery = re-run briefing
        │
   user clicks refresh
```

The load-bearing point: durability has a cost (WAL, fsync, backups, recovery code). That cost is only worth paying when the data lives only in your system. Nothing canonical lives only here, so nothing here needs durability.

> Q: "What about the dev-mode JSON files?"

Convenience, not durability. Next's dev server hot-reloads modules on every save, which would blow away the in-memory Map and force OAuth re-authentication mid-development. The dev files survive hot-reload. They use whole-file rewrites with `writeFileSync` and no fsync — if the process crashes mid-write, the file is truncated, and the read path treats a corrupt JSON file the same as a missing one. That's fine for a dev cache; it would be unacceptable for a system of record.

> Q: "When would you add a WAL?"

When the product owns canonical data of its own. The two likely triggers are saved investigations (user wants to retrieve them later) and audit logging (compliance or trust requires "what did the agent do, exactly"). Both move state from derivative to authoritative; both make the recovery path "run the briefing again" insufficient. At that point, the decision is which datastore — and whatever you pick, you inherit its WAL. You don't build one.

## See also

  - [`05-transactions-isolation-and-anomalies.md`](./05-transactions-isolation-and-anomalies.md) — the "D" of ACID belongs here
  - [`08-replication-and-read-consistency.md`](./08-replication-and-read-consistency.md) — durability across nodes
  - [`audit.md`](./audit.md) — F2 (state wiped on cold start)
