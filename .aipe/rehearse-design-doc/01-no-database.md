# RFC-01 — No database

**Decision in one line:** Ship without a database. Auth lives in an encrypted cookie, run-state lives in session-keyed in-memory maps, and the presentation-reliability path is a committed JSON snapshot — not a persisted table.

---

## Context

Blooming insights is a portfolio artifact that a marketer or analyst uses to **watch** a Bloomreach Engagement workspace. The state model is unusual for a Next.js app:

- **Auth state** — an OAuth 2.1 PKCE flow against `loomi-mcp-alpha.bloomreach.com`, whose access tokens are minted per-user and **revoked by the server after minutes**. No user identity persists past the token lifetime anyway.
- **Investigation state** — an in-flight briefing or a running diagnosis needs to survive one page navigation (feed → investigate) and a StrictMode double-mount. It does not need to survive a server restart.
- **Demo state** — the entire product must work in a portfolio review with no Bloomreach account, no network, and no auth.

A database would have to solve one of these three problems well enough to justify the operational surface it adds (schema migrations, a hosted Postgres, connection pooling, a per-request session). None of the three needs it.

The Bloomreach alpha server also constrains what "persistence" would even mean. Tokens die in minutes; a saved "investigation" older than the token that produced it can't be re-run against the same data. Persistence buys nothing for the primary use case.

---

## Decision

Three storage layers, no database:

```
Three storage layers — no shared server-side DB

  ┌─ layer ─────────────┬─ where it lives ────────────────┬─ TTL ───────────┐
  │ auth                │ encrypted cookie                │ token lifetime  │
  │                     │ AES-256-GCM, HttpOnly, Secure   │ (minutes)       │
  │                     │ AsyncLocalStorage in prod       │                 │
  │                     │ file `.auth-cache.json` in dev  │                 │
  ├─────────────────────┼─────────────────────────────────┼─────────────────┤
  │ run state           │ in-memory Map, session-keyed    │ server uptime   │
  │ (insights,          │ `lib/state/insights.ts`         │ + one nav       │
  │  investigations)    │ `lib/state/investigations.ts`   │                 │
  ├─────────────────────┼─────────────────────────────────┼─────────────────┤
  │ demo reliability    │ committed JSON snapshot         │ git history     │
  │                     │ `lib/state/demo-*.json`         │                 │
  └─────────────────────┴─────────────────────────────────┴─────────────────┘
```

Each layer is scoped tightly to what it needs to outlive:

- **The cookie outlives one HTTP request.** The `OAuthClientProvider` in `lib/mcp/auth.ts` reads it via `AsyncLocalStorage` inside a route handler and writes it back on the response.
- **The in-memory map outlives one page navigation.** Feed writes an insight; investigate reads it back by session key. When the Vercel function instance dies, the run state dies with it — that's fine, the user starts a new briefing.
- **The demo snapshot outlives the codebase.** It is git-tracked JSON in `lib/state/demo-insights.json` and `demo-investigations.json`. `/api/briefing?demo=cached` serves it as plain JSON. No auth, no LLM call.

The three layers are independent. The absence of any one doesn't corrupt the others.

---

## Alternatives considered

**(a) Postgres for user identity and past investigations.** The canonical "you'd add this if you were productionizing it" call. Loses because the Bloomreach alpha server revokes tokens in minutes — a "past investigation" saved 20 minutes ago can't be re-run against the workspace it queried. The only real value would be showing a user their own history, which is not what a portfolio artifact is for. Adds a hosted Postgres, a connection pool, migrations, and per-request session-lookup latency, while buying no capability that concurrent-user session-scoping doesn't already deliver.

**(b) Redis or an edge KV for session state.** Considered specifically because Vercel functions can spin down between requests, which means the in-memory Map's contents are not guaranteed to survive a five-minute gap. Loses because the current user flow — click a card, land on `/investigate/[id]` within seconds — always hits a warm function. When the map is cold, the fallback is not "500 error" but "hit `/api/agent` again with the same anomaly, re-run the diagnosis." The re-run is the recovery. KV adds infrastructure and cost for a case the recovery path already handles.

**(c) Persist auth in a server-side session store keyed by a signed cookie.** The classic web-app auth shape. Loses to the encrypted-cookie approach because the token itself dies in minutes — a durable server-side session outlives the thing it holds a reference to. The encrypted cookie is the shortest path to "the OAuth provider gets its token back on each request" without introducing a server-side store just to keep a value that expires anyway.

---

## Consequences

**What this buys:**
- Zero database ops. No schema, no migrations, no connection pool, no hosted-DB cost line, no backups.
- The demo path is provably reliable — `?demo=cached` doesn't touch a network, an LLM, or auth. A portfolio review can't be broken by an outage.
- Concurrent users don't step on each other. Session-keyed maps (fixed in an earlier phase — the "concurrent-user wipe RESOLVED" line in the codebase state) mean each browser tab is isolated by the session cookie.

**What it costs:**
- A Vercel function cold-start loses the in-flight run state. The recovery is "re-run the briefing," which is fast in demo and slow in live — but live is already recovery-oriented because of token revocation, so the failure mode composes.
- No per-user history. A returning user starts from scratch. This is a deliberate scope choice, not a bug.
- The demo snapshot is a committed artifact — updating it requires a code commit. The one-click capture endpoint (`/api/mcp/capture-demo`) exists precisely so this stays a one-command operation.

**What the reviewer will push on:**
> "You'll have to add a database eventually."

Own it. The answer is: yes, when the product acquires a use case that outlives an OAuth token — say, saving a briefing as a shareable link, or letting a team subscribe to weekly anomalies. That use case doesn't exist yet. Adding a database before the use case that needs it is the classic mistake of building substrate for imaginary requirements.

---

## Open questions

- **Vercel KV or Upstash for run state?** If session cold-starts become a real UX complaint (they aren't today), the smallest possible move is KV for the two maps in `lib/state/`. Cheaper and thinner than Postgres.
- **Cookie size ceiling.** The encrypted-cookie approach has a ~4KB envelope. Today the payload is a short token plus PKCE metadata. If Bloomreach starts issuing longer tokens or richer refresh material, the cookie hits its cap and the design forks — either KV-backed session or a smaller stored token with a lookup on the server side.
