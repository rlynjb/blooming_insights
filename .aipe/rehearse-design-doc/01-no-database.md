# RFC 01 — No database

**Decision:** Run the entire app with **zero managed database**. Auth lives in
an encrypted cookie; feed/investigation state lives in a session-keyed
in-memory `Map` on the warm Vercel instance; the demo snapshot is a committed
JSON file that doubles as the reliability path.

## Context

`blooming_insights` is a multi-agent analyst that produces a 30–90 second
NDJSON briefing per session. Three pieces of state exist per user:

  → **OAuth tokens** for Bloomreach (PKCE + Dynamic Client Registration)
  → **The current briefing** — insights + investigations + raw anomalies
  → **The investigation handoff** — diagnosis from step 2 → recommendation
    in step 3

The product is a portfolio piece deployed to Vercel Pro. Users arrive, run
one briefing, click through to an investigation, see a recommendation, leave.
Nothing persists across sessions by design — every briefing IS the current
state.

The default move in a "Next.js app with state" is to reach for Postgres or
Vercel KV. That was the alternative on the table. It lost.

## Goals

  → Survive a portfolio demo with **zero infrastructure cost** (no DB, no
    KV, no Redis)
  → Tolerate Vercel's stateless serverless model — instances spin up cold,
    warm, and die without warning
  → Survive **concurrent users on the same warm instance** without one
    user's data bleeding into another's
  → Give a recruiter clicking the link a **reliable** briefing in <1 second,
    every time, even when the upstream Bloomreach alpha server is
    rate-limited or has revoked tokens

## Non-goals

  → Cross-session history. You cannot come back tomorrow and see yesterday's
    briefing. Out of scope by design.
  → Multi-device sync for the same user. The session cookie is per-browser.
  → Audit log / compliance trail. The product is "analyst that shows its
    work" within a session, not "analyst-of-record."

## The decision

Three storage layers, none of them a database:

```
  Storage layers — what lives where, and for how long

  ┌─ Browser ─────────────────────────────────────────────────────┐
  │  localStorage  bi:mode          (user pref, survives reloads) │
  │  sessionStorage investigation/<id>  (step 2→3 handoff hydrate)│
  │  cookie       bi_session        (session UUID, HttpOnly)      │
  │  cookie       bi_auth_enc       (encrypted OAuth blob, prod)  │
  └───────────────┬───────────────────────────────────────────────┘
                  │  every request carries the cookies
                  ▼
  ┌─ Vercel warm instance (in-process Map) ───────────────────────┐
  │  lib/state/insights.ts                                        │
  │    Map<sessionId, SessionFeed>                                │
  │      └─ insights / investigations / anomalies                 │
  │  → wiped on cold start, scoped per session in-flight          │
  └───────────────┬───────────────────────────────────────────────┘
                  │  reads on cold start fall back to ↓
                  ▼
  ┌─ Git-committed snapshots (the reliability floor) ─────────────┐
  │  lib/state/demo-insights.json                                 │
  │  lib/state/demo-investigations.json                           │
  │  → replayed instantly when ?demo=cached or bi:mode=demo       │
  └───────────────────────────────────────────────────────────────┘
```

**The verdict-first read:** auth is a cookie, working state is a Map keyed by
session UUID, and the demo path is a JSON file checked into git. Each layer
holds a different *kind* of state with a different *lifetime*. None of them
need a managed DB to do their job.

### The load-bearing part: session-keying the in-memory state

The earliest version of `lib/state/insights.ts` had a module-level
`Map<string, Insight>` — one global map, keyed by insight ID. On a single
warm Vercel instance serving two users, **user B's `putInsights()` call
clears the whole map and wipes user A's in-flight feed.** This was the bug
the AI suggested and the code shipped before a concurrency re-read caught it.

The fix is one indirection — key the outer map by session ID, and clear only
the inner session's sub-feed:

```ts
// lib/state/insights.ts:7-23
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};

const state = new Map<string, SessionFeed>();   // outer map: NEVER cleared

function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}
```

And the clear at `lib/state/insights.ts:57-71` only nukes the *inner* maps for
the current `sessionId`:

```ts
export function putInsights(sessionId: string, items: Insight[], ...): void {
  const s = sessionState(sessionId);
  s.insights.clear();   // this session only
  s.anomalies.clear();
  ...
}
```

The session ID itself comes from a cookie set in `lib/mcp/session.ts:16-24` —
created on first request, persisted with `HttpOnly + SameSite=None + Secure`
in production so it survives the cross-site OAuth redirect.

## Alternatives considered

### Alternative A — Vercel KV (Redis)

The obvious choice for ephemeral session state on Vercel. Drop-in
key-value store, serverless-friendly, scales to zero.

**Why it lost:** Cost and complexity for state that genuinely does not need to
outlive the request. A briefing takes 30–90s; a recruiter spends 2–5 minutes
on the site total. Persisting state across instances buys nothing for the
product's actual usage pattern. Adding KV adds:

  → A free-tier ceiling to monitor
  → An environment variable to manage
  → A failure mode (KV down → site down) that doesn't exist today
  → Serialization overhead on the hot path

The in-memory Map serves a single session perfectly for the lifetime of the
warm instance. Cold start drops it, but cold start also re-runs the briefing,
so the user sees a fresh result — not a regression.

### Alternative B — Postgres / Drizzle

The pattern used in `AdvntrCue` (the previous project in the portfolio).
pgvector for embeddings, Drizzle for schema, Neon for hosting.

**Why it lost:** Wrong shape. AdvntrCue stores documents + conversation
history that need to persist for the user across visits — RAG over a corpus
the user grew over time. `blooming_insights` stores a single in-flight
briefing per session. The first is a database problem; the second is a Map
problem. Using Postgres for the second is malpractice by overspec.

### Alternative C — File-backed dev cache + production DB

Persist to `.investigation-cache.json` in dev (which the code already does)
and to a DB in prod.

**Why it lost:** Two different storage models behind one interface is two
behaviors to test. The cookie-encrypted auth store already does this split
(`lib/mcp/auth.ts` — `AsyncLocalStorage` in prod, file in dev) and it's
the most fragile part of the code. Doubling the surface for state that
doesn't need persistence is a step backward.

## Tradeoffs accepted

  → **State dies on cold start.** A recruiter who closes the laptop and comes
    back an hour later runs a fresh briefing. This is fine — the briefing is
    the product, not a database row.
  → **State dies on Vercel instance churn mid-session.** Rare on Vercel Pro,
    not zero. The demo snapshot is the fallback for "the live path broke"
    cases. In live mode, a mid-stream instance death surfaces as a stream
    error and the user hits "retry."
  → **No history across sessions.** Cannot show "your briefing from last
    week." Out of scope by design — the product is real-time monitoring,
    not a journal.
  → **Concurrent-user safety is enforced by code, not by the storage layer.**
    The session-keying is correct because the Map is structured that way; a
    junior contributor who reaches into `state` directly could break it.
    Mitigated by the `_clear(sessionId?)` convention in tests and the
    comment block at the top of `lib/state/insights.ts:5-7`.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Memory leak — sessions never garbage-collected from the outer map | Acceptable at portfolio scale (~10 concurrent sessions max). At product scale, add a TTL eviction in `sessionState()`. |
| Two browser tabs of the same user race-clearing each other's feed | Both tabs share the same session cookie → same `SessionFeed` → last write wins. Documented as intentional; the briefing is idempotent. |
| Demo snapshot drifts from the live agent's output shape | `lib/mcp/validate.ts` validates snapshot shape on load; CI fails the build if the demo JSON doesn't validate. |
| OAuth cookie blob too large for browser limits | Encrypted blob is ~1KB; well under the 4KB cookie ceiling. Token refresh keeps it small. |

## Rollout / migration

Already shipped. The migration was *from* a leaky module-level Map *to* the
session-keyed Map; one PR, surgical, covered by `test/state/insights.test.ts`.
The cookie + encrypted-auth-store split landed earlier as part of the OAuth
work.

If a future product need (history, multi-device) forces a database, the
migration path is one-way and clear: add a Postgres/Drizzle layer behind the
`putInsights/getInsight/listInsights` functions in `lib/state/insights.ts` —
the call sites already pass `sessionId` so the seam already exists.

## Open questions

  → **When do we need a real database?** Probably the day the product gains a
    "save this briefing" or "compare to last week" feature. Until then, the
    Map is correct.
  → **Should the demo snapshot be regenerated on every deploy?** Today it is
    captured manually via the dev-only `/api/mcp/capture-demo` route. A
    nightly cron against the live Bloomreach alpha would keep it fresh, but
    the alpha server's token-revocation policy makes scheduled capture
    fragile. Acceptable for portfolio; revisit at product scale.
  → **Session cleanup policy.** Today the outer `state` Map grows
    monotonically until the Vercel instance dies. At portfolio scale this is
    a no-op; at product scale it needs a TTL or LRU.

---

**Coach note:** When a reviewer asks "no database, seriously?" the answer is
*"no managed DB; state is in a session-keyed Map and the demo path is a git-
committed JSON snapshot."* The two specifics — session-keyed (not global) and
git-committed (not gone on deploy) — are what turn "no database" from
amateur-hour into a deliberate choice.
