# Database systems map — the storage picture in this repo

*Storage topology / Language-agnostic*

## Zoom out, then zoom in

You know how most Next apps have exactly one Postgres they pray to? This one has none. So when you ask "which datastore does this hit," the honest answer is a list of five things, none of which is a database. Here's where each one sits:

```
  Zoom out — where every "storage" primitive lives

  ┌─ UI (browser) ─────────────────────────────────────────────┐
  │  React 19 + Next 16 App Router                              │
  │  sessionStorage (client-only, per tab)                      │
  │  localStorage: bi:mode = 'demo' | 'live'   app/page.tsx     │
  └─────────────────────────┬──────────────────────────────────┘
                            │  HTTP + NDJSON stream
  ┌─ Service (Vercel serverless) ─────▼───────────────────────┐
  │                                                            │
  │  ★ session Map<sessionId, SessionFeed>  ★ session cookie   │
  │    lib/state/insights.ts:14              lib/mcp/session.ts │
  │                                                            │
  │  ★ 60s TTL response cache               ★ bi_auth cookie   │
  │    bloomreach-data-source.ts:122         lib/mcp/auth.ts    │
  │                                                            │
  │                                                            │ ← this file's scope
  └─────────────────────────┬──────────────────────────────────┘
                            │  MCP tool call
  ┌─ Provider (Bloomreach) ─▼──────────────────────────────────┐
  │  execute_analytics_eql — the real database over there      │
  └────────────────────────────────────────────────────────────┘

  ┌─ git (deploy-time storage) ────────────────────────────────┐
  │  lib/state/demo-*.json   — frozen "replica" of a briefing  │
  │  eval/baseline.json      — committed reference row         │
  │  eval/receipts/*.json    — 28 rows, one per run+case       │
  │  eval/goldens/*.ts       — fixture "seed data"             │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** Every storage-engine responsibility (hold rows, look them up fast, keep them across failures, replicate them for cheap reads) shows up somewhere in this repo — just never inside a database. This file names which primitive plays which role, and where the boundaries are.

## Structure pass

**Axis to hold constant: durability — how long does the write survive?**

Three layers, one question:

```
  "how long does a write survive?" — traced across every storage primitive

  ┌─ in-memory state ─────────────────────────────────┐
  │  session Map, TTL cache, McpClient cache          │
  │                                                    │ → survives until warm-instance dies
  │                                                    │   (minutes to hours; Vercel decides)
  └───────────────────────────────────────────────────┘
      ┌─ per-request cookie ────────────────────────────────┐
      │  bi_session (opaque id), bi_auth (encrypted state)   │
      │                                                      │ → survives 10 days on the client
      │                                                      │   (bi_auth maxAge; auth.ts:49)
      └─────────────────────────────────────────────────────┘
          ┌─ committed files in git ────────────────────────────┐
          │  demo-*.json, baseline.json, receipts/*.json         │
          │                                                      │ → survives forever
          │                                                      │   (or until we retag/regen)
          └─────────────────────────────────────────────────────┘
```

The seam that flips the axis: **the network boundary between the browser and Vercel.** On the server side, every write is a warm-instance thing — cold-start eats it. Cross that seam back to the browser, and durability jumps to "10 days on the client" (`bi_auth`) or "as long as the tab lives" (`sessionStorage`). Cross it again to git, and durability jumps to "forever."

That's the load-bearing insight: **the server owns no durable state.** Every long-lived byte is either on the client or in the repo. Everything in RAM is a cache with extra steps.

## How it works

### Move 1 — the mental model

Think of the way a `fetch()` call to a real Postgres app works: request lands → handler pulls a connection from a pool → runs `SELECT` → returns rows → connection goes back. Now delete the connection pool, delete Postgres, and replace both with "look it up in a `Map`." That's this repo.

The kernel:

```
  the request-time storage kernel

              ┌─────────────────────────────────────┐
              │  request arrives                    │
              └────────────────┬────────────────────┘
                               │
        ┌──────────────────────┴──────────────────────┐
        │                                              │
        ▼                                              ▼
  ┌───────────────┐                          ┌──────────────────┐
  │ needs auth?   │                          │ needs data?      │
  │ read bi_auth  │                          │ check TTL cache  │
  │ (cookie)      │                          │ (Map, 60s)       │
  └───────┬───────┘                          └────────┬─────────┘
          │                                            │
          ▼                                            ▼ miss
  ┌───────────────┐                          ┌──────────────────┐
  │ decrypt into  │                          │ call MCP tool    │
  │ ALS store     │                          │ → Bloomreach     │
  │ (per-request) │                          │ → cache result   │
  └───────┬───────┘                          └────────┬─────────┘
          │                                            │
          └───────────────┬────────────────────────────┘
                          ▼
              ┌─────────────────────────────────────┐
              │ agents run, write results into      │
              │ session Map<sessionId, SessionFeed> │
              │ (in-memory, warm-instance-scoped)   │
              └─────────────────────────────────────┘
```

Every arrow above is either a Map lookup, a cookie read, or a remote MCP call. There is nothing to `SELECT` from and nothing to `INSERT` into locally.

### Move 2 — the five storage primitives, walked

**The session Map (session-scoped in-memory "tables").**

```
  lib/state/insights.ts:14
  ────────────────────────
  const state = new Map<string, SessionFeed>();

  where SessionFeed = {
    insights:       Map<insightId, Insight>       ← current briefing
    investigations: Map<investigationId, ...>     ← per-anomaly deep dive
    anomalies:      Map<insightId, Anomaly>       ← raw pre-derived form
  }
```

The outer key is the session id from the `bi_session` cookie (`lib/mcp/session.ts:16-24`). Each session gets its own inner triple; the outer map is never cleared by request-scoped code. In DB terms: three "tables" per user, but only for as long as this Vercel instance stays warm. `putInsights` (`insights.ts:57-71`) does the equivalent of `DELETE FROM insights WHERE session_id = ?; INSERT ...` — replace-the-briefing, atomic only because the JS turn between `clear()` and the last `.set()` cannot yield.

Anchored code, annotated:

```ts
// lib/state/insights.ts:57-71
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  const s = sessionState(sessionId);   // get-or-create the per-session "schema"
  s.insights.clear();                  // wipe THIS session's rows only
  s.anomalies.clear();                 //   (never touches other sessions)
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);           // primary-key insert
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

The comment above it (`insights.ts:5-7`) names the bug this shape fixed: a plain module-level Map's `clear()` would wipe another user's feed mid-briefing on a warm serverless instance. The session-keying is the fix — a table per session, not one table shared.

**The 60s TTL response cache (a per-warm-instance "materialized view").**

```
  lib/data-source/bloomreach-data-source.ts:122
  ─────────────────────────────────────────────
  private cache = new Map<string, { result: unknown; expiresAt: number }>();

  key = `${toolName}:${JSON.stringify(args)}`   ← exact-match hash lookup only
  ttl = 60_000 ms (options.cacheTtlMs override) ← per-call, not per-key
```

This is the closest thing this repo has to an index. It's a hash table keyed by the tool name and its full argument object, so `get_project_overview({project_id: X})` on call 2 within 60s returns instantly. No range scan, no prefix match, no partial key — same args or nothing. Error results are deliberately not cached (`bloomreach-data-source.ts:179-181`) so a transient 429 doesn't poison the next 60 seconds of reads.

**`bi_auth` — the encrypted-cookie durability layer.**

```
  lib/mcp/auth.ts:38-104
  ──────────────────────
  cookie name:   bi_auth
  encryption:    AES-256-GCM with 12-byte IV, 16-byte tag
  key derivation: sha256(AUTH_SECRET) → 32 bytes
  max-age:       10 days (matches Bloomreach token lifetime)
  scope:         httpOnly, secure, sameSite=none, path=/
```

Because Vercel gives you a fresh serverless instance between the OAuth `authorize` redirect and the callback, an in-memory store loses the PKCE verifier every time. The cookie is what makes the OAuth handshake work at all in production. `AsyncLocalStorage` (`auth.ts:47`) is the trick: seed a store from the cookie once at request start (`auth.ts:86-104`), let the OAuth SDK do its dozen synchronous reads/writes against the ALS-scoped store, flush back to the cookie once at request end. That flush pattern is how you get around Next's request-vs-response cookie split — read-after-set in the same request returns the OLD value unless you route both through your own in-memory shadow.

**Committed JSON as "read replica" (deploy-time storage).**

```
  lib/state/demo-insights.json          665 lines  — one full briefing
  lib/state/demo-investigations.json  3,487 lines  — 8+ investigations
  public/demo/                                     — served static
```

`app/api/briefing/route.ts:78-149` reads `lib/state/demo-insights.json` when the URL has `?demo=cached` and replays it as an NDJSON stream at a "readable pace" (see the `PACE_MS` constant in the same file). This is the same pattern as a Postgres follower: pre-computed data, no primary hit, deliberately stale. The refresh policy is manual (`app/page.tsx` has a dev-only "capture as demo snapshot" button that runs the live agents and writes these files).

**`eval/baseline.json` — a committed reference row.**

```
  eval/baseline.json:1-92
  ───────────────────────
  {
    "runId":     "2026-07-03T04-08-28-644Z",
    "builtAt":   "2026-07-03T05:29:44.727Z",
    "caseCount": 10,
    "diagnosis":       { perDimensionPassRate: {...}, verdictDistribution: {...} },
    "recommendation":  { perDimensionPassRate: {...}, verdictDistribution: {...} }
  }
```

Read by `eval/gate.eval.ts:49-91` as `readFileSync(baselinePath, 'utf8')`, parsed as one row, compared field-by-field to a freshly-computed `candidate`. If any dimension in `perDimensionPassRate` drops by more than `GATE_MAX_REGRESSION` (default 0.10), the gate fails. That's a SELECT-then-compare against a committed row. The receipts in `eval/receipts/` (28 JSON files at time of writing) are the raw scored cases from which each baseline gets `computeBaseline(runId, receipts)` (`baseline.eval.ts:53`) aggregated — one row of raw data per (case × runId).

### Move 2 variant — the load-bearing skeleton (what breaks if you remove it)

The absolute minimum this "storage layer" needs to keep working:

1. **The `Map<sessionId, ...>` outer key.** Remove the session id and put everything in a flat module-level Map, and `putInsights`' `clear()` wipes every user's feed on every briefing. This is the fix that already shipped; the code comment at `insights.ts:5-7` narrates it explicitly.
2. **The 60s TTL response cache.** Remove it and every repeated `list_cloud_organizations` (the MCP bootstrap chain runs it on every call — see `~/.claude/projects/.../MEMORY.md`) hits Bloomreach's ~1 req/s rate limit and the whole briefing stalls. This is not a nice-to-have; it's what makes the app usable.
3. **The `AsyncLocalStorage` wrapping around cookie reads.** Remove it and the OAuth SDK's read-then-set-then-read pattern reads the OLD cookie mid-request, which either sends the wrong PKCE verifier or wipes the tokens. This is the least intuitive of the three and the one an interviewer will poke at.

Everything else — the eval receipts, the demo JSON, the `bi_session` cookie — is hardening, not skeleton.

### Move 3 — the principle

**Choose your durability boundary and put everything on one side of it.** This repo's boundary is "the request." Every write dies when the request ends *unless* it lands in a cookie or in git. That's not "no persistence"; it's persistence with two very deliberate long-term homes (client cookie, source repo) and a disposable middle. When the read pattern is "warm-start-friendly + eventual truth" and the write pattern is "one user's briefing at a time," an actual database is dead weight. When the read pattern grows past that (analytics, cross-session queries, audit trails), the disposable middle stops being enough and you buy a database — but not before.

## Primary diagram

```
  The full storage picture, every arrow labelled

  ┌─ browser ─────────────────────────────────────────────────┐
  │  sessionStorage       localStorage: bi:mode                │
  └────────┬────────────────────┬──────────────────────────────┘
           │ HTTP + cookies      │
           │                     │
  ┌────────▼──────────────┐   ┌──▼──────────────────────────────┐
  │  bi_session (opaque)  │   │  bi_auth (AES-256-GCM)          │
  │  session id (UUID)    │   │  OAuth tokens + PKCE verifier   │
  │  session.ts:16-24     │   │  auth.ts:38-104                 │
  └────────┬──────────────┘   └──┬──────────────────────────────┘
           │                     │ decrypt into ALS
           │                     │ auth.ts:86-104
           ▼                     ▼
  ┌─ Vercel serverless (warm instance) ────────────────────────┐
  │                                                             │
  │  session Map<sessionId, SessionFeed>                        │
  │    insights.ts:14 — three inner Maps per session            │
  │      ├── insights (rows)                                    │
  │      ├── investigations (rows)                              │
  │      └── anomalies (rows, pre-derived)                      │
  │                                                             │
  │  BloomreachDataSource.cache: Map<"tool:args", {result,exp}> │
  │    bloomreach-data-source.ts:122 — 60s TTL                  │
  │                                                             │
  └──────────────────────────┬──────────────────────────────────┘
                             │ callTool (MCP over HTTPS)
                             ▼
  ┌─ Bloomreach loomi connect MCP ─────────────────────────────┐
  │  execute_analytics_eql over the wobbly-ukulele workspace   │
  │  the actual RDBMS lives here, we don't touch it            │
  └────────────────────────────────────────────────────────────┘

  ┌─ git (source of truth for deploy-time storage) ────────────┐
  │  lib/state/demo-insights.json        ─┐                     │
  │  lib/state/demo-investigations.json  ─┤ read replica         │
  │  public/demo/*                       ─┘                     │
  │  eval/baseline.json                     ← committed row      │
  │  eval/receipts/*.json (28 rows)         ← per-run scores     │
  │  eval/goldens/*.ts                      ← seed fixtures      │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The "no DB" choice is not an oversight — it's a shape. Bloomreach is the database. This app is a *reader with reasoning*, not a system of record. The rows it produces (an Insight, an Investigation) are ephemeral analyst thinking, not customer data. If a user comes back tomorrow, running the briefing again is *the right answer* — the underlying event stream has moved.

Given that, the interesting mechanics all cluster around three questions:

1. **How do you keep two concurrent users' briefings apart with just `Map`s?** → per-session inner maps (`insights.ts:14`).
2. **How do you keep OAuth alive across serverless instances with no session store?** → the encrypted cookie (`auth.ts:38-104`).
3. **How do you demo without hitting the flaky alpha backend?** → committed JSON as a replica (`briefing/route.ts:78-149`).

The rest of this study guide walks each mechanism at DB depth: how a real engine solves it, and what the corresponding move looks like here.

Adjacent reading:
- `study-runtime-systems` for why `putInsights` is atomic without a lock.
- `study-distributed-systems` for the AsyncLocalStorage request-scoping pattern.
- `study-data-modeling` for the *shape* of the rows this layer stores.

## Interview defense

**Q: "Where does state live in this app?"**

Model answer: "Three places, at three durability tiers. In-memory per warm serverless instance: a `Map<sessionId, SessionFeed>` at `lib/state/insights.ts:14` for the current briefing, and a 60s TTL response cache inside `BloomreachDataSource` at `lib/data-source/bloomreach-data-source.ts:122`. On the client for ten days: an encrypted `bi_auth` cookie holding OAuth tokens and the PKCE verifier, at `lib/mcp/auth.ts:38-104`. In git forever: `lib/state/demo-*.json` as a replayable snapshot, `eval/baseline.json` as the regression reference row. The load-bearing part is that the server owns *no durable state* — every long-lived byte is on the client or in the repo."

Diagram to sketch: the three-band durability diagram from the structure pass (in-memory / cookie / git), with the seam labelled.

**Q: "You said the session Map's `clear()` is safe. Prove it."**

Model answer: "`putInsights` at `insights.ts:57-71` runs synchronously — no `await` between the `clear()` calls and the final `.set()`. Node's event loop is single-threaded, so nothing else on this warm instance can observe an intermediate state; the JS turn is the atomic unit. Two concurrent HTTP requests to the same instance are two different turns — one runs to completion before the other starts its `clear()`. The bug that this fixed was cross-session contamination, not intra-session — that's what the session-keying is for. See the comment at `insights.ts:5-7`."

Anchor: `Map.set` doesn't await; the event loop is your lock.

**Q: "Why a cookie for OAuth state instead of a Redis or Vercel KV?"**

Model answer: "Cost, simplicity, and it works. The alpha Bloomreach server revokes tokens after minutes, so 'long-lived server-side session' has no operational value — refresh-and-reconnect is the recovery path anyway. Encrypting the state and putting it on the client with AES-256-GCM keeps the whole app stateless server-side. The trick that actually makes it work is the `AsyncLocalStorage` scoping at `auth.ts:47`: the OAuth SDK reads and writes the store many times per request, and Next's cookies API returns *stale* values within a request after a set. So we decrypt once at the top of the request into an ALS store, run everything against that, and re-encrypt-and-set once at the bottom (`auth.ts:86-104`). The cookie is the durability layer; the ALS is the consistency layer *within* a request."

Anchor: request-scoped ALS wraps a cookie that survives 10 days on the client.

## See also

- `02-records-pages-and-storage-layout.md` — how records physically live in the primitives we just named.
- `03-btree-hash-and-secondary-indexes.md` — why the 60s cache is a hash-only index and what a B-tree would buy you.
- `07-wal-durability-and-recovery.md` — why the cookie is the whole durability story.
- `08-replication-and-read-consistency.md` — the demo snapshot as a read replica.
