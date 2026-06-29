# RFC 01 — No database

**One-line summary.** State lives in an encrypted-cookie session plus an in-memory, session-keyed map; the committed demo snapshot is the reliability path that always works without auth.

---

## Context

The product is a multi-agent analyst over a Bloomreach Engagement workspace. Three things shaped the state story:

- **The agents already have a system of record.** Bloomreach Engagement IS the database — customers, events, revenue, catalogs all live there, queried ad-hoc via EQL through the loomi connect MCP server. Any local store we add would be a *cache of someone else's data*, not source of truth.
- **The alpha MCP server is hostile to long-lived state.** Tokens revoke after minutes; rate limit is ~1 req/s. A live briefing burns 30–90s of stream just to get from "press the button" to "first insight." That cost can't be on the demo path.
- **The product gets shown live.** Recruiter walkthroughs, interview demos, async-shared links. The instant-load path has to work without an OAuth dance — and without depending on whoever holds the freshest token.

So the question wasn't "Postgres or SQLite or KV?" — it was "what data does this app actually own that needs a database in the first place?" Answer: feed snapshots between briefing runs (in-memory is enough), per-user OAuth tokens (a cookie is enough), and demo replay fixtures (a committed JSON file is enough).

---

## Decision

Three stores, each picked for the lifetime of what it holds:

```
  State lives in three places — each scoped to its lifetime

  ┌─ Browser (per user, per device) ─────────────────────┐
  │  encrypted cookie     ←  OAuth tokens + session id   │
  │  (AES-256-GCM)           lib/mcp/auth.ts             │
  │  sessionStorage       ←  in-flight investigation     │
  │                          handoff (step 2 → step 3)   │
  └────────────────────────────┬─────────────────────────┘
                               │  cookie rides every request
                               ▼
  ┌─ Vercel function instance (warm, ephemeral) ─────────┐
  │  Map<sessionId, SessionFeed>                          │
  │  lib/state/insights.ts:14                             │
  │  per-session sub-feed; outer map never cleared        │
  └────────────────────────────┬─────────────────────────┘
                               │  if missing (cold start /
                               │  different instance):
                               ▼
  ┌─ Git (committed, no auth, instant) ──────────────────┐
  │  lib/state/demo-insights.json                         │
  │  lib/state/demo-investigations.json                   │
  │  the reliability path — demo mode replays this        │
  └──────────────────────────────────────────────────────┘
```

**Browser cookie holds identity + OAuth state** (`lib/mcp/auth.ts`). AES-256-GCM, scoped to the session. The cookie IS the session — there's no server-side session table. When the cookie is gone, the session is gone, and the next request bootstraps a fresh OAuth dance.

**Per-instance Map holds the active feed**, keyed by `sessionId` (`lib/state/insights.ts:14`). A single warm Vercel instance serves many users concurrently; without the session key, `putInsights().clear()` would wipe another user's feed mid-briefing. That race is called out in the file's header comment because it was the bug AI-defaulted into during page decomposition.

**Committed JSON snapshot is the reliability path**, served by demo mode (`bi:mode = demo`). It replays from `lib/state/demo-insights.json` instantly, no auth, no rate limit, no token expiry. The dev-only "capture this as the demo snapshot" button runs a live briefing + each investigation and writes the JSON back, so the snapshot stays in sync with whatever the live agents currently produce.

---

## Alternatives considered

### Postgres + Drizzle (the AdvntrCue shape)

The author's previous project (AdvntrCue) uses pgvector + Drizzle + serverless functions on Netlify. Reaching for it again was the natural move.

**Why it lost.** Nothing in this app actually needs a relational store. The data being analyzed lives in Bloomreach. A local Postgres would be either a cache (introduces consistency bugs against a system you don't control) or a write-store (you don't write to Bloomreach from this app). The cost of standing up Postgres + migrations + a connection-pool story bought zero feature.

### Vercel KV (Redis) for session state

KV would solve the "warm instance lost the feed" case directly — same sessionId reads the same feed across instances.

**Why it lost.** It solves a problem that doesn't bite hard. A user who lost their feed re-runs monitoring; one extra 30–90s. The win wasn't worth adding a stateful boundary the demo path doesn't need (demo mode never reads KV). KV stays an open option (see Open Questions) if observability shows the same user re-running briefings repeatedly.

### Server-side session table (any flavor)

A `sessions` table is the textbook move for OAuth-state-per-user.

**Why it lost.** Cookie-as-session works because the OAuth tokens themselves are the only state worth holding, and they're ~2 KB encrypted — well under the 4 KB cookie ceiling. A `sessions` table would force a database choice (back to alternative 1) just to hold what the cookie already carries.

---

## Consequences

**What this cost — owned, not apologized for:**

- **A warm Vercel instance is a soft cache, not a guarantee.** If the user's next request lands on a different instance (or the instance went cold), their feed is gone and they re-run monitoring. The system-design tradeoff is "spend ~60s recompute, save a database." That trade is reasonable here; if traffic ever makes it unreasonable, KV is one PR away.
- **Demo snapshot drift is a real risk.** The committed JSON ages every time the live agents' output shape changes. Mitigated by the dev-only one-click capture button (`app/page.tsx`) — re-running it overwrites both snapshot files with whatever the current agents produce. Not automated; it's a manual check before any demo.
- **No history.** There is no "what did monitoring say yesterday." Each briefing IS the current feed (`putInsights` calls `clear()` on the session's sub-feed first). That's deliberate — the product is "what's the situation NOW" — but it means anything that wants trend-over-time on the *briefing itself* (not on the underlying Bloomreach data) doesn't have a place to read from.
- **No multi-device session.** The session lives in one browser's cookie. Open the link on your phone, it's a fresh session. Fine for this product; would be a blocker for one that expects "log in on desktop, continue on mobile."

**What this bought:**

- **Instant demo, every time.** The committed snapshot loads in milliseconds and never depends on a third party being healthy. This is the load-bearing receipt: every interview demo, every recruiter walkthrough, every async share works.
- **Zero infrastructure to provision.** The app is `git push` + Vercel. No DB, no Redis, no migration runner. The "deployable in one command" property is itself a feature when the product is a portfolio piece.
- **The session-keyed bug got caught and fixed.** A naive AI-defaulted suggestion produced a module-level `Map` (no session key) — that would have been a multi-user data leak. The fix (session-keyed sub-feeds) is now the file's central invariant, called out in `lib/state/insights.ts`'s header. The receipt is the in-file comment that explains why the outer map is never cleared.

---

## Open Questions

- **At what concurrency does in-memory stop being acceptable?** Today, with portfolio-level traffic, it's fine. The trigger to migrate to KV would be observability showing the same `sessionId` re-running briefings on different instances — that's the "feed lost across cold start" signal. Not measured today.
- **Should the demo snapshot be auto-refreshed?** The capture button is manual. A nightly cron that runs the live briefing and writes the snapshot back would close the staleness window, at the cost of a scheduled token-aware live run. Currently rejected (the alpha server's token revocation makes a reliable nightly run hard) but worth revisiting if the upstream stabilizes.
- **Does a future "save this briefing" feature force a real database?** Probably yes, but the entry surface would be one new write path — not a rewrite. The cookie session and the in-memory cache would remain; only the *persisted-briefing* shape would be new.
