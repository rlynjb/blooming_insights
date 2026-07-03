# 01 · Database systems map

*The persistence hierarchy · Case B (there is no database)*

## Zoom out — where this concept lives

You're used to seeing a diagram where a service layer talks to "the
database" — one box, one arrow, one storage system. That box is missing
here. What replaces it is a **stack of six storage tiers**, each doing a
subset of the jobs a real DB does. This concept file's job is to draw
that whole stack so every other file in this study can point at it.

```
Zoom out — where the "database" would sit in a normal Next.js app

┌─ UI layer (React) ──────────────────────────────────────────────┐
│  app/page.tsx  →  useBriefingStream  →  fetch('/api/briefing') │
└────────────────────────────────┬───────────────────────────────┘
                                 │ HTTPS + bi_session cookie
┌─ Service layer (Next route) ───▼───────────────────────────────┐
│  route handler  →  agent loop  →  DataSource (port)            │
└────────────────────────────────┬───────────────────────────────┘
                                 │
┌─ Storage layer ────────────────▼───────────────────────────────┐
│                                                                 │
│   ★ THIS CONCEPT — the six tiers replacing "the database" ★    │
│                                                                 │
│   1. localStorage      2. sessionStorage   3. in-mem Map       │
│   4. signed cookies    5. .auth-cache.json 6. git-committed    │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

## Zoom in — the pattern

**The pattern:** *persistence-tier hierarchy without a datastore.* Every
tier has a different failure mode, a different scope, a different
lifespan. Together they cover what a single DB would cover in a
conventional app — and expose the mechanics you normally never see,
because a DB hides them behind ACID.

## Structure pass — one axis across all six tiers

Pick an axis. Trace it. Watch it flip.

**Axis: "how long does the data live?"** (durability)

```
Trace durability across all six tiers — the answer flips at every seam

  Tier                       Lives until...                Load-bearing seam
  ─────────────────────────  ────────────────────────────  ─────────────────
  1. localStorage            user clears browser data      cookie <-> js
  2. sessionStorage          tab closes                    tab boundary
  3. server in-mem Map       cold start / redeploy         instance boundary
  4. signed cookie           10 days OR AUTH_SECRET change crypto boundary
  5. .auth-cache.json        `rm` or dev restart           dev / prod
  6. git commit              you `git push --force`        commit graph

  → durability strictly grows as you go down
  → each seam is where a DB engineer would ordinarily draw the fsync line
```

**The seams that matter** — where the axis-answer flips:

  → **Tier 2 → Tier 3** (tab → server memory): a browser tab close
    kills sessionStorage, but the server's Map survives (until cold
    start). A "second tab, same user" reads the same server Map.

  → **Tier 3 → Tier 4** (server memory → signed cookie): the ONE seam
    that carries production durability. Below Tier 3, data dies on
    redeploy. Above Tier 4, it survives across Vercel warm instances.

  → **Tier 5 → Tier 6** (dev file → git): the dev/prod split. Tier 5
    only exists locally (gitignored). Tier 6 is the only tier that
    survives a `git clone` on a fresh machine.

The **most load-bearing seam** is Tier 3 → Tier 4. That's your fsync
boundary. Above it, the browser or the cookie carries the state
somewhere durable. Below it, one cold start and it's gone.

## How it works

### Move 1 — the pattern

You've built with `useState` — data lives in a React component and dies
when the component unmounts. Now imagine that scaled up: **every tier in
this stack is a `useState` at a different altitude**, with a different
"when does it unmount" rule. That's the shape.

```
The persistence hierarchy — pattern skeleton

  client                                server
  ──────                                ──────

  ┌ localStorage ┐  ────browser────► ┌ signed cookies ┐
  │  bi:mode     │                    │  bi_auth       │  ── AES-256-GCM
  │  bi:mcp_config│                   │  bi_session    │
  └──────────────┘                    └────────────────┘
         │                                    │
         │                                    │
         ▼                                    ▼
  ┌ sessionStorage ┐                  ┌ in-mem Map ────┐
  │  bi:insight:*  │                  │  SessionFeed    │
  │  bi:diag:*     │                  │  <sessionId,…>  │  ── warm-only
  │  bi:inv:*      │                  └────────────────┘
  └────────────────┘                           │
                                                │
                                                ▼
                                       ┌ file system ──┐
                                       │ .auth-cache   │  ── dev-only
                                       │  .json        │
                                       └───────────────┘
                                                │
                                                ▼
                                       ┌ git-committed ┐
                                       │ eval/         │
                                       │  baseline.json│  ── durable
                                       │  receipts/*   │
                                       │ lib/state/    │
                                       │  demo-*.json  │
                                       └───────────────┘
```

Every arrow is a hop with a labeled seam. The pattern's kernel is: **the
tier's scope determines its consistency model.** Client tiers are
per-browser; server tiers are per-instance; cookie tiers are per-user;
git tiers are per-deploy.

### Move 2 — walk it, tier by tier

Each sub-section is one tier. One diagram. One code anchor. The
"what breaks if you take it away" test at the end.

#### Tier 1 — localStorage (`bi:mode`, `bi:mcp_config`)

Browser-owned key-value store. You've used it: `localStorage.setItem`.
Here it holds **two** things, each doing a job a DB would do:

```
Layers-and-hops — the mode switch, from click to route

┌─ UI layer ─────────────────┐
│  page.tsx onClick          │
└──────────────┬─────────────┘
               │ hop 1: switchMode('live-mcp')
               ▼
┌─ localStorage ─────────────┐
│  bi:mode → 'live-mcp'      │  ← Tier 1 write
└──────────────┬─────────────┘
               │ hop 2: setState → re-render
               ▼
┌─ useBriefingStream ────────┐
│  fetch('/api/briefing      │
│    ?mode=live-mcp')        │  ← the tier fans out to the network
└────────────────────────────┘
```

`app/page.tsx:79` reads the persisted mode on mount. `app/page.tsx:108`
writes it on toggle. `lib/mcp/config.ts:107` reads the MCP override.
`lib/mcp/config.ts:134` writes it. Both wrap the call in
`try/catch` — Safari private mode throws on `setItem`.

```typescript
// lib/mcp/config.ts:106-117
export function readPersistedConfig(): McpConfigOverride | null {
  if (typeof localStorage === 'undefined') return null;    // SSR-safe: no window on the server
  try {
    const raw = localStorage.getItem(BI_MCP_CONFIG_KEY);   // KV read by string key
    if (!raw) return null;
    const parsed = JSON.parse(raw);                        // stored as JSON
    if (!isMcpConfigOverride(parsed)) return null;         // validate before trusting
    return normalizeConfig(parsed);
  } catch {
    return null;                                            // storage blocked → treat as unset
  }
}
```

**What breaks if you drop it:** the user's chosen MCP server (or their
custom bearer token, or the fact that they picked `live-mcp` over
`live-synthetic`) is forgotten on every page load. The app still works
— it just defaults every time.

#### Tier 2 — sessionStorage (per-tab caches)

Same API as localStorage; different lifespan. Dies on tab close. Used
here as a **cross-page cache**: when the feed page fetches an insight,
it stashes it under `bi:insight:<id>` (`useBriefingStream.ts:57`) so the
investigate page can find it without hitting the server again.

```
Sequence — feed writes, investigate reads (same tab, different route)

  briefing route          feed page          sessionStorage        investigate page
  ──────────────          ─────────          ──────────────        ────────────────
   emit 'insight' ──────► setInsights
                          stashInsights ───► setItem(bi:insight:<id>)
                                              │
                                              │ (tab still open)
                                              │
                                              ▼
                                              ◄──── getItem(bi:insight:<id>)
                                                    ← useInvestigation.ts:175
```

`lib/hooks/useInvestigation.ts:175` reads the stash and passes it to
`/api/agent?insight=<url-encoded-json>`. Why this exists: on Vercel, the
briefing and the investigation can hit **different warm instances**, so
Tier 3 (in-mem Map) is unreliable across a page navigation. Tier 2
carries the data across the seam.

**What breaks if you drop it:** the investigate page has to look the
insight up via server-side `getInsight(sessionId, id)` (Tier 3) — which
misses on a cross-instance route. In that case the browser has to
re-fetch the whole briefing, which takes seconds.

#### Tier 3 — server in-memory Map (`SessionFeed`)

The closest thing this repo has to a "table."

```typescript
// lib/state/insights.ts:8-14
type SessionFeed = {
  insights: Map<string, Insight>;                          // primary "insights" table
  investigations: Map<string, Investigation>;              // primary "investigations" table
  anomalies: Map<string, Anomaly>;                         // primary "anomalies" table
};

const state = new Map<string, SessionFeed>();              // partitioned by sessionId
```

The outer `Map<sessionId, SessionFeed>` is your **partition key** (the
`sessionId` cookie). Inside, three sibling maps play the role of three
tables. `insight.id` is the row key.

The comment above this in the actual file names the exact reason it's
partitioned:

```typescript
// lib/state/insights.ts:5-8
// Session-scoped feed state. A single warm Vercel instance serves many users
// concurrently, so module-level Maps would bleed between sessions — and
// putInsights' clear() would wipe another user's feed mid-briefing. Each
// session gets its own sub-feed; the outer map is never cleared by a request.
```

That comment IS the story of case B. In a real DB, `PRIMARY KEY
(sessionId, insight_id)` would handle it. Here, a nested map does.

**What breaks if you drop it:** the agent loop still works (it writes
via `putInsights`, reads via `getInsight`), but every read after a
process restart hits an empty map. Users see "insight not found" until
they re-run the briefing.

#### Tier 4 — server-signed cookies (`bi_auth`, `bi_session`)

Two cookies, two jobs:

  → **`bi_session`** — the sessionId UUID, per-user, HttpOnly. This is
    the partition key for Tier 3. Created in `lib/mcp/session.ts:16-24`.

  → **`bi_auth`** — AES-256-GCM encrypted OAuth state (client info,
    tokens, PKCE verifier). This is the ONLY tier that survives a
    Vercel redeploy AND rides between warm instances.

```
The bi_auth cookie — one row of a "durable_auth_state" table

┌─ Client (browser) ─────────────────────────────────────────┐
│  cookie: bi_auth = base64url(iv || tag || ciphertext)      │
│  · HttpOnly (JS can't read)                                 │
│  · SameSite=None (survives OAuth cross-site redirect)      │
│  · Secure (HTTPS-only)                                      │
│  · max-age = 10 days                                        │
└────────────┬───────────────────────────────────────────────┘
             │ hop: every request auto-includes bi_auth
             ▼
┌─ Service · withAuthCookies() ──────────────────────────────┐
│  decryptStore(raw) using sha256(AUTH_SECRET) as AES key    │
│  → Store (typed record shape)                              │
│  → AsyncLocalStorage-scoped, per-request                   │
│                                                             │
│  fn() runs — many read/writes to the ALS store             │
│                                                             │
│  if ctx.dirty:                                              │
│    encryptStore(ctx.store) → set cookie in the response    │
└────────────────────────────────────────────────────────────┘
```

```typescript
// lib/mcp/auth.ts:86-104
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();     // dev/test uses file/mem
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);            // ALS carries ctx to every reader
  if (ctx.dirty) {                                            // write-back once, at commit time
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
      httpOnly: true, secure: true, sameSite: 'none',
      path: '/', maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

**Read this like a database:** `withAuthCookies` is `BEGIN`; `ctx` is
the transaction's private snapshot; every provider method reads/writes
`ctx`; `if ctx.dirty: set cookie` is `COMMIT`. The AES-GCM tag is the
row's checksum. `decryptStore` catches a bad tag and returns `{}` —
that's your "corrupted row → treat as null."

**What breaks if you drop it:** every OAuth flow completes… and then
loses its tokens on the next request. The user re-authenticates on
every page load. There is no durability path for OAuth in production
without this cookie.

#### Tier 5 — file system (dev only)

`.auth-cache.json` at the repo root, gitignored. Written by
`writeAll()` in `lib/mcp/auth.ts:137-141` when `PERSIST` is true
(`NODE_ENV === 'development'`).

Why it exists: Next's dev server re-evaluates modules on hot-reload,
which wipes the in-memory Map mid-OAuth-flow. The PKCE verifier and DCR
client info have to survive between `connect` and `callback`. Dev
persists to disk; test uses an isolated in-mem map; prod uses the
cookie above.

**What breaks if you drop it:** every dev hot-reload during OAuth
kills the flow with `no PKCE code_verifier stored for this session`
(the throw at `lib/mcp/auth.ts:215`).

#### Tier 6 — git-committed

Three artifacts here play three different DB roles:

| File                            | Role                    | Refreshed by                |
| ------------------------------- | ----------------------- | --------------------------- |
| `eval/baseline.json`            | committed reference row | `npm run eval:baseline`     |
| `eval/receipts/*.json`          | append-only judged runs | `npm run eval`              |
| `lib/state/demo-insights.json`  | frozen read replica     | `/api/mcp/capture-demo`     |

**`baseline.json`** is the row the CI regression gate compares
candidate runs against. Look at the shape:

```typescript
// eval/baseline.json (excerpt)
{
  "runId": "2026-07-03T04-08-28-644Z",
  "builtAt": "2026-07-03T05:29:44.727Z",
  "caseCount": 10,
  "diagnosis": {
    "perDimensionPassRate": {
      "root_cause_plausibility": 0.75,
      "evidence_grounding": 0.5,
      "scope_coherence": 0.75,
      "actionable_next_step": 0
    },
    ...
  }
}
```

The gate at `eval/gate.eval.ts:74` reads this file, computes a
candidate `baseline` from the latest receipts, and blocks if any
`perDimensionPassRate` regresses by more than `GATE_MAX_REGRESSION`.

**In DB terms:** `baseline.json` is a single row; the CI gate is a
`SELECT` that compares two rows and fails on a threshold delta; the
receipts folder is the audit log.

**What breaks if you drop them:** the CI gate has nothing to compare
against and every eval run passes silently; demo mode has no snapshot
to replay, so a fresh visitor sees a spinner and no data.

### Move 3 — the principle

**A database is not a place; it's a set of jobs.** Storage, indexing,
consistency, durability, backup, recovery — every one of those exists
somewhere. When there's no DB, you can see the jobs clearly because each
one lives in a different tier with a different failure mode.

The moment you add Postgres, all six of these merge into "the database"
and become opaque. You lose the ability to reason about individual
guarantees — which is exactly what makes a real DB *easier* to use and
*harder* to reason about at the same time.

## Primary diagram — the whole persistence stack

```
The persistence hierarchy — one frame, all six tiers

  ┌─ CLIENT ─────────────────────────────────────────────────────┐
  │                                                               │
  │   Tier 1: localStorage                                        │
  │   ┌──────────────────────────────┐                            │
  │   │ bi:mode      · 'live-mcp'    │  ← per-browser, long-lived │
  │   │ bi:mcp_config · JSON blob    │                            │
  │   └──────────────────────────────┘                            │
  │                                                               │
  │   Tier 2: sessionStorage                                      │
  │   ┌──────────────────────────────┐                            │
  │   │ bi:insight:<id>              │  ← per-tab, dies on close  │
  │   │ bi:diag:<id>                 │                            │
  │   │ bi:inv:<step>:<id>           │                            │
  │   └──────────────────────────────┘                            │
  │                                                               │
  └──────────────────────────┬───────────────────────────────────┘
                             │ HTTPS
                             │ (cookies auto-attach)
  ┌─ SERVER ─────────────────▼───────────────────────────────────┐
  │                                                               │
  │   Tier 3: in-memory Map (per-warm-instance)                   │
  │   ┌──────────────────────────────────────────────┐            │
  │   │ Map<sessionId, {insights, investigations,    │            │
  │   │                 anomalies}>                  │            │
  │   └──────────────────────────────────────────────┘            │
  │                    │                                          │
  │                    │ partition key ← bi_session cookie        │
  │                    ▼                                          │
  │   Tier 4: signed cookies                                      │
  │   ┌──────────────────────────────────────────────┐            │
  │   │ bi_session  · UUID (HttpOnly, SameSite=None) │            │
  │   │ bi_auth     · AES-256-GCM(store) 10d TTL     │  ← durable │
  │   └──────────────────────────────────────────────┘            │
  │                                                               │
  │   Tier 5: .auth-cache.json (DEV ONLY)                         │
  │   ┌──────────────────────────────────────────────┐            │
  │   │ file at cwd, gitignored, JSON                │            │
  │   └──────────────────────────────────────────────┘            │
  │                                                               │
  └──────────────────────────┬───────────────────────────────────┘
                             │ git push
                             ▼
  ┌─ Tier 6: git-committed (durable, versioned) ─────────────────┐
  │                                                               │
  │   eval/baseline.json           ← reference row for CI gate   │
  │   eval/receipts/*.json         ← append-only judged runs     │
  │   lib/state/demo-insights.json ← frozen read replica         │
  │   lib/state/demo-investigations.json                          │
  │                                                               │
  │   backup: git tag study-pre-regen-2026-07-03-p2               │
  │   rollback: git revert / git reset --hard <tag>               │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where does this pattern come from?** It comes from **shipping without
a datastore**. Every startup engineer who wired up "just a JSON file for
now" has invented some version of Tier 6. Every extension author with
`chrome.storage` has invented Tier 1. Every ephemeral serverless
function ever deployed has bumped into Tier 3's problem.

The interesting move in this repo is that all six tiers are being used
**deliberately** — each with a job the others can't do. That's rarer.
Most no-DB codebases pick one tier (usually localStorage) and try to
force every job through it.

**When does this pattern stop working?** Three cases:

  → You need **cross-user reads**. Every tier here is per-user or
    per-instance. A "top 10 insights across all users" query is
    impossible without a real DB.

  → You need **write coordination**. Concurrent writes to the same
    row are undefined here — the last writer wins, silently. A real DB
    gives you either a transaction or an error.

  → You need **cross-instance state that ISN'T per-user**. The cookie
    story only works because each user carries their own state. A
    global counter that all users increment can't ride the cookie.

At any of those three, you reach for Postgres. Until then, this stack
is genuinely cheaper — no schema migrations, no ORM, no connection
pool, no backup strategy that isn't "git."

## Interview defense

**"Walk me through the persistence story for this app."**

Answer, in the order to say it: *"There is no database. Persistence is
a six-tier hierarchy — localStorage and sessionStorage on the client,
an in-memory Map on the server per warm instance, then signed cookies
carrying encrypted OAuth state across instances, a dev-only file
cache, and finally git as the most durable layer. Each tier does one
job a database would do. The load-bearing seam is the cookie — it's the
only tier that survives a redeploy AND rides between warm instances
in production."*

Then draw the primary diagram above. That's the whole story on one
board.

**"What's the fsync equivalent in this system?"**

Answer: *"There are two, at different scopes. For per-user OAuth state,
it's the AES-GCM cookie write in `withAuthCookies` — one write-back per
request at commit time, exactly like `COMMIT` flushes the WAL. For
committed artifacts like `eval/baseline.json`, it's `git commit` — the
commit hash is the LSN."*

**"What breaks first under load?"**

Answer: *"Tier 3, the in-memory Map, because it's per-warm-instance.
Two concurrent briefings for the same user landing on different Vercel
instances see two different Maps. sessionStorage carries the insight
across the page navigation, but the anomaly-to-insight lookup on the
investigate route silently misses. The fix would be either a real
shared store, or shorter-lived state that lives in the cookie."*

The load-bearing skeleton part interviewers routinely forget:
**AsyncLocalStorage-scoped commit** in `withAuthCookies`. Without it,
the cookie gets set on every provider-method call and hits Next's
request-vs-response split — you read the OLD value in the same
request. Naming that seam signals you built the thing, not just read
about it.

## See also

  → `02-records-pages-and-storage-layout.md` — the row shape at each
    tier
  → `03-btree-hash-and-secondary-indexes.md` — how each tier's index
    is built
  → `07-wal-durability-and-recovery.md` — Tier 6 walked as WAL + backup
  → `08-replication-and-read-consistency.md` — Tier 6's `demo-*.json`
    as the frozen replica
