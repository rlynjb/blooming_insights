# Audit — 8-lens system-design walk

One section per lens. Each finding cites `file:line` or `not yet exercised`
honestly. When a lens turns up a load-bearing pattern, this audit cross-links
to its dedicated file in Pass 2.

## 1. system-map-and-boundaries

The full system map lives in `00-overview.md` — this section names the
boundaries and what flips across each.

**Components:**

- **Browser** — Next.js client (`app/page.tsx:1-461`,
  `app/investigate/[id]/page.tsx`, `app/investigate/[id]/recommend/page.tsx`).
  Owns presentation state and three storage slots: `localStorage`,
  `sessionStorage`, in-memory React state.
- **Route handlers** — two streaming routes
  (`app/api/briefing/route.ts:1-336`, `app/api/agent/route.ts:1-345`) plus
  six short helpers under `app/api/mcp/`.
- **DataSource layer** — abstract surface in
  `lib/data-source/types.ts:63-71`; factory in `lib/data-source/index.ts:67-100`;
  two adapters: `BloomreachDataSource`
  (`lib/data-source/bloomreach-data-source.ts:121-214`) and
  `SyntheticDataSource` (`lib/data-source/synthetic-data-source.ts`, 516 LOC).
- **Agent layer** — five Blooming wrappers (`lib/agents/{monitoring,
  diagnostic, recommendation, query, intent}.ts`) over `@aptkit/core@0.3.0`,
  bridged by three adapters in `lib/agents/aptkit-adapters.ts:1-206`.
- **MCP transport** — `lib/mcp/connect.ts:64-112` (the connect handshake),
  `lib/mcp/transport.ts:123-165` (`SdkTransport` over
  `@modelcontextprotocol/sdk`), `lib/mcp/auth.ts:160-218`
  (`BloomreachAuthProvider` implementing the SDK's `OAuthClientProvider`).
- **External dependencies** — Bloomreach loomi connect MCP server
  (`https://loomi-mcp-alpha.bloomreach.com/mcp`); Anthropic SDK
  (`claude-sonnet-4-6` for agents, `claude-haiku-4-5-20251001` for intent
  classification, set in `lib/agents/base.ts:7` and `lib/agents/intent.ts:16`).

**Trust boundaries:**

- **Browser ↔ Service** — every state-changing request carries
  `bi_session`; auth-gated routes additionally require a valid `bi_auth`
  cookie. Setup throws (e.g. missing `AUTH_SECRET`) return a JSON 500
  with the redacted message (`app/api/briefing/route.ts:170-179`,
  `app/api/agent/route.ts:167-174`).
- **Service ↔ Bloomreach** — `BloomreachAuthProvider`
  (`lib/mcp/auth.ts:160-218`) holds the OAuth client info, PKCE verifier,
  and tokens; transport-level errors flow through `McpToolError`
  (`lib/data-source/bloomreach-data-source.ts:101-110`) carrying the
  redacted server detail.
- **Service ↔ Anthropic** — direct `Anthropic` SDK client; no proxy.

→ Deep walk: `01-request-flow.md`, `02-oauth-boundary.md`.

## 2. request-response-and-data-flow

Two flows carry the product. Both produce NDJSON.

**Briefing flow (feed load)** — `GET /api/briefing?mode=...`

```
  briefing flow (live)

  Browser → route handler → DataSource factory → schema bootstrap
    → schemaCapabilities + coverageReport (10 categories)
    → MonitoringAgent.scan(runnable, hooks)
    → for each category: AptKit loop calls model+tools, hooks emit NDJSON
    → anomalies → insights → putInsights(sid, ...) → stream
  ─ done ─
```

**Investigation flow (card click → step 2 → step 3)** — `GET /api/agent`

```
  investigation flow (live)

  Browser stashes the insight in sessionStorage, navigates with ?insight=...
  Step 2: ?insightId=ID&step=diagnose&insight=...
    → route handler resolves anomaly (param → in-memory → demo seed)
    → DiagnosticAgent.investigate(anomaly) → diagnosis → stream
  Browser stashes the diagnosis (sessionStorage key `bi:diag:ID`).
  Step 3: ?insightId=ID&step=recommend&diagnosis=...
    → RecommendationAgent.propose(anomaly, diagnosis) → recs → stream
```

**Parallel work** — none on the hot path. Schema bootstrap, list_tools,
intent classify, and each agent scan run sequentially because the live
provider is rate-limited at ~1 req/s globally per user
(`lib/mcp/connect.ts:86-100`). Promise.all would just cause back-to-back
429s.

**Cancellation** — `req.signal` is threaded all the way down:
`bootstrap(req.signal)` → `dataSource.listTools({ signal })` → agent loops
(`hooks.signal`) → `anthropic.messages.create({ signal })` →
`SdkTransport.callTool` composes the client signal with a per-call 30s
timeout (`lib/mcp/transport.ts:131-146`).

→ Deep walk: `01-request-flow.md`, `06-streaming-ndjson.md`,
`07-multi-agent-orchestration.md`.

## 3. state-ownership-and-source-of-truth

Five storage slots; each owns a different lifetime.

| Slot                          | Lifetime          | Owner            | Notes                               |
| ----------------------------- | ----------------- | ---------------- | ----------------------------------- |
| In-memory `Map<sid, feed>`    | warm instance     | server module    | `lib/state/insights.ts:14`          |
| In-memory investigations      | warm instance     | server module    | `lib/state/investigations.ts:11`    |
| `.investigation-cache.json`   | dev process only  | filesystem (dev) | `lib/state/investigations.ts:7-9`   |
| `lib/state/demo-*.json`       | forever (git)     | repo             | committed demo snapshot             |
| `bi_session` cookie           | browser session   | client (HTTP-only)| `lib/mcp/session.ts:3`             |
| `bi_auth` cookie (encrypted)  | 10 days           | client (HTTP-only)| `lib/mcp/auth.ts:48-104`           |
| `localStorage` (`bi:mode`)    | persistent        | browser          | `app/page.tsx:73-83`                |
| `sessionStorage`              | tab session       | browser          | `bi:insight:<id>`, `bi:diag:<id>`, `bi:reconnecting`, `bi:inv:<step>:<id>` |

**Critical design choice — session-keyed state.** `lib/state/insights.ts:14`
keys the outer Map by `sessionId`, NOT by metric or by global. Without
this, `putInsights(...)` clearing the map mid-briefing would wipe another
user's feed on the same warm Vercel instance
(`lib/state/insights.ts:60-71`).

**Source of truth per concept:**

- **Workspace schema** — Bloomreach is the truth; cached in-process via
  `bootstrapSchema()`'s module-level `cached` (`lib/mcp/schema.ts:138`).
  Synthetic mode returns a fixed schema (`syntheticWorkspaceSchema`).
- **Insights / anomalies** — server-keyed by session; the client also
  stashes each to `sessionStorage` so the investigation request survives
  a cross-instance hop (`useBriefingStream.ts:53-60`).
- **Diagnosis (step 2 → 3)** — stashed to `sessionStorage` under
  `bi:diag:<id>` and handed back via the `?diagnosis=` query parameter,
  because step 3 may land on a different Vercel instance than step 2.

→ Deep walk: `08-client-stream-handoff.md`.

## 4. caching-and-invalidation

Three caches, three different freshness contracts.

- **DataSource tool-result cache** — `BloomreachDataSource` keeps a
  60-second `Map<name:argsJson, {result, expiresAt}>`
  (`lib/data-source/bloomreach-data-source.ts:122, 144-152`). Skipped via
  `skipCache: true` (used by `/api/mcp/call/route.ts:33` and capture
  paths). Error results are NEVER cached (line 179-181) — a 401 must not
  poison the cache and pin every subsequent call at "unauthorized."
- **Schema bootstrap cache** — module-level singleton at
  `lib/mcp/schema.ts:138`. The Bloomreach schema is large (~112 KB) and
  doesn't change per request; one fetch per warm instance is enough. No
  invalidation: a redeploy is the implicit refresh.
- **Investigation cache** — combined-run replay cache
  (`lib/state/investigations.ts`). Only the legacy combined run
  (`step == null`) is cached to disk (`app/api/agent/route.ts:301-302`).
  Split steps are handed off via the client's `sessionStorage`.

**Invalidation strategy:** time-based for tool results (60s), session-scoped
for insights (overwrites on each briefing), build-scoped for the schema
(no invalidation). No event-driven invalidation anywhere — there is no
publisher we'd subscribe to.

→ Deep walk: `05-caching-and-rate-limiting.md`.

## 5. storage-choice-and-durability-boundaries

**There is no database.** Every persistence story is a JSON file, a cookie,
or an in-memory `Map`.

- **Why no DB:** the product analyzes Bloomreach data — the workspace IS
  the database. Adding our own would introduce a sync problem we don't
  have.
- **Demo snapshot durability** (`lib/state/demo-*.json`) — committed to
  git, replayed by `?demo=cached`. The reliable presentation path; the
  alpha server's token revocation can't break it.
- **Auth-cache durability** — dev: `.auth-cache.json` (gitignored, plain).
  Prod: AES-256-GCM-encrypted cookie under `AUTH_SECRET`. Tampered or
  rotated-secret cookies decrypt to `{}` and are treated as "no auth"
  (`lib/mcp/auth.ts:76-79`).
- **Investigation-cache durability** — dev: `.investigation-cache.json`
  (gitignored). Prod: in-memory only. A cold instance loses the cache;
  the demo seed (`lib/state/demo-investigations.json`) is the fallback.

**Durability guarantees this codebase makes:**

- Insights are best-effort, session-scoped — a redeploy or instance churn
  wipes them. The client stashes insights to `sessionStorage` so a
  cross-instance hop in the investigation flow still works
  (`useBriefingStream.ts:53-60`).
- Cookies survive 10 days (`AUTH_COOKIE_MAX_AGE`,
  `lib/mcp/auth.ts:49`).
- Demo snapshot is forever (git).

Schema-shape and field-by-field invariants are not this guide's job —
they live in `study-data-modeling`.

→ Deep walk: cross-link to `study-data-modeling` for `WorkspaceSchema` /
`Insight` / `Anomaly` / `Diagnosis` / `Recommendation` field-by-field.

## 6. failure-handling-and-reliability

The codebase faces three categories of failure, and handles each
differently.

**Slow / rate-limited dependency (Bloomreach ~1 req/s)** — see
`lib/data-source/bloomreach-data-source.ts:154-174`. Proactive
inter-call spacing (`minIntervalMs: 1100` from
`lib/mcp/connect.ts:97`) sits below the 60s response cache. When a 429
lands anyway, `isRateLimited(result)` detects it from the error envelope
text and `parseRetryAfterMs` extracts the server-stated window
(`bloomreach-data-source.ts:51-71`); the retry waits that window
+ `RETRY_BUFFER_MS` (500ms) and tries again, up to `maxRetries: 3`.

**Token revocation (the alpha server revokes after minutes)** —
`useReconnectPolicy` (`lib/hooks/useReconnectPolicy.ts:33-123`) owns the
one-shot reset+reload dance. The regex `AUTH_ERROR_RE_AUTO` matches the
known shapes (`invalid_token|unauthor|forbidden|401|session expired|
reconnect`). A `sessionStorage` flag (`bi:reconnecting`) prevents the
reload loop on the second consecutive failure.

**Client cancellation (tab close / navigation / unmount)** — every async
boundary checks `req.signal.aborted`; in the routes,
`if (e instanceof DOMException && e.name === 'AbortError') return;`
suppresses the error event so the client (which is gone) doesn't get
spurious noise. The `finally` block still runs so the per-request
console-log summary records how much budget was burned before cancel.

**Graceful degradation:**

- Demo mode (`?demo=cached`) — the reliable, credential-free fallback for
  presentations; serves the committed snapshot.
- Synthetic mode (`live-synthetic`) — runs the real agent loop against
  in-process data; no auth, no rate limit. Used when Bloomreach is down
  or rate-limited.
- The four short MCP routes (`/api/mcp/{call,reset,tools,capture}`) keep
  using `BloomreachDataSource` directly so they can pass `skipCache:
  true` for the dev `/debug` force-fresh path.

**What's not handled:** no circuit breaker, no bulkhead, no health probes,
no liveness check. The system relies on Vercel's per-request isolation
and the 300s `maxDuration` ceiling
(`app/api/{briefing,agent}/route.ts:19,22`).

→ Coordination mechanics (consensus, failover, replication) belong to
`study-distributed-systems`. This codebase doesn't implement any of those —
it accepts the partial-failure realities of one alpha provider.

## 7. scale-bottlenecks-and-evolution

What breaks first at higher load.

**At 10x current load (10x concurrent users):**

- The Bloomreach alpha is the binding constraint. Rate limit is **per
  user, global**, so 10x users don't change the per-user budget — but the
  per-user 300s window is already tight. A single investigation runs
  ~100-115s today (comment, `app/api/agent/route.ts:21`); 6 calls × 10s
  retry wait would blow it.
- In-memory state grows linearly with concurrent sessions
  (`Map<sessionId, SessionFeed>`). Vercel instances are ephemeral, so
  this isn't a memory leak — but a cold-start loses the cache and the
  next request pays full bootstrap latency.

**At 100x:**

- The schema bootstrap cache (`lib/mcp/schema.ts:138`) is *per
  instance*. 100 warm instances each bootstrap once. A shared cache
  (Redis, Vercel KV) would amortize this.
- The investigation cache, today, only persists across a single warm
  instance + a dev file. Cross-instance investigation replay would need
  the same shared store.
- Token-revocation handling is one-shot per browser session. A
  fleet-wide revocation event (Bloomreach key rotation) would manifest
  as every active session simultaneously hitting the reconnect dance.

**What stays stable:**

- The DataSource seam absorbs a backend swap with one line per route.
  Swapping the live data source from Bloomreach to a hypothetical
  faster provider doesn't touch agents, hooks, or UI.
- The NDJSON contract (`lib/mcp/events.ts:4-12`) is forward-compatible —
  new event types are additive; old clients ignore unknown lines (the
  reader silently skips malformed lines too,
  `lib/streaming/ndjson.ts:42-49`).

**What would force a rearchitecture:**

- A real database (we want to persist user-facing state across deploys).
  Today's `Map`-and-`sessionStorage` story is the right one for a demo
  product; a multi-user SaaS needs Postgres or similar.
- A queue (long-running investigations beyond the 300s ceiling). Today
  the route IS the unit of work; queueing would split request from
  execution and require a separate job runner.
- Multi-tenant auth (we currently assume one Bloomreach org per
  installation; `resolveProject` in `lib/mcp/schema.ts:166-184` reads
  `BLOOMREACH_PROJECT_ID` from env and picks one).

## 8. system-design-red-flags-audit

Ranked architectural risks, each grounded in real evidence. Not a code
review — this is the architecture's failure modes.

### R1 — token-revocation cascades

The alpha Bloomreach server revokes tokens after minutes
(`app/api/agent/route.ts:21` comment, plus the dedicated
`useReconnectPolicy` hook). The reconnect dance is one-shot per browser
session — a second consecutive failure deliberately does NOT reload, to
prevent an infinite loop. Cost: an active user mid-investigation can lose
their work to a token revocation; they get the explicit reconnect button
in the error UI (`app/page.tsx:302-333`). Acceptable for an alpha
provider; would need refresh-token plumbing for a real product.

### R2 — module-level schema cache, no invalidation

`lib/mcp/schema.ts:138` (`let cached: WorkspaceSchema | null = null`) is a
module-level singleton. If the Bloomreach workspace's event schema
changes (a new event type, a new property), the cache holds the stale
version until the next cold start. Today's tradeoff is right — the
schema doesn't change during a demo — but worth flagging.

### R3 — investigation handoff via query string

Step 3's `?diagnosis=...` (`app/api/agent/route.ts:117, 269`) carries the
diagnosis JSON in the URL. Browsers cap URL length around 8KB; a long
diagnosis with verbose evidence could exceed that. The fallback path
(no diagnosis param → `throw new Error('no diagnosis was handed over')`)
fails cleanly but unhelpfully.

### R4 — `bi_auth` cookie size growth

The auth cookie holds the full `Store` (`Record<sessionId, SessionAuthState>`)
encrypted (`lib/mcp/auth.ts:62-67`). Today's design stores ONLY the
current session's state under the session id key, so the cookie carries
one entry. But the type signature allows multiple — a refactor that
multi-keys it could push past the 4KB cookie ceiling.

### R5 — sequential bootstrap calls inside the 300s budget

`bootstrapSchema` runs four MCP calls sequentially
(`lib/mcp/schema.ts:195-198`). At ~1 req/s + occasional 10s rate-limit
retry, the bootstrap alone can eat 10-40s of the route budget. The
schema cache hides this on warm instances, but a cold one (or after a
deploy) pays the full cost.

### R6 — no observability beyond `console.log`

The summary line at the end of each request
(`app/api/{briefing,agent}/route.ts:317-338,331-339`) is the entire
observability story. There's no metric emission, no trace, no error
tracking integration. Vercel's log search is the only debugging path. For
an alpha + demo product this is the right call; a real product needs
proper telemetry.

### R7 — no rate limit on our own routes

The Bloomreach side is rate-limited; our `/api/briefing` and `/api/agent`
routes are not. A misbehaving client (or a tab-spam scenario) could fire
multiple concurrent briefings, each consuming the per-user Bloomreach
budget. The 300s `maxDuration` is a per-request ceiling, not a fleet
budget.
