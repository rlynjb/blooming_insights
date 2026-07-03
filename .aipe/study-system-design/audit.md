# audit.md — Pass 1

The 8-lens architectural audit. Each lens gets one `##` section
grounded in `file:line` evidence. Lenses that don't apply are
named honestly. Cross-links point at the Pass-2 pattern files
where the finding earns a full walkthrough.

The load-bearing story for this repo, up front: the port
(`DataSource`) has now shipped in **five uses** without a caller-
facing interface change — Olist added, Olist removed, Synthetic
added, FaultInjecting decorator, and now `McpDataSource` +
swappable `AuthProvider` (Sessions A–D). That's the receipt the
audit keeps coming back to.

---

## 1. system-map-and-boundaries

**One SPA, four significant runtime boundaries.**

The system is a Next.js 16 SPA (`app/` router, React 19) deployed
to Vercel, with a Node runtime for the four streaming/OAuth
routes. The client is the browser; the "server" is a handful of
route handlers that stream NDJSON. No database, no queue, no
worker pool. Every boundary that matters is a hop between three
layers: browser · Next route handler · external MCP server.

The four boundaries the design actually turns on:

- **Browser ↔ route** — HTTPS, `POST /api/briefing` and
  `/api/agent` return `Content-Type: application/x-ndjson`. Two
  transports ride this hop: a session cookie (see auth, below) and
  the new **per-request MCP config override header**
  (`BI_MCP_CONFIG_HEADER = 'x-bi-mcp-config'`, base64-encoded JSON,
  `lib/mcp/config.ts:37`). The route decodes both, threads them
  into `makeDataSource`, and starts streaming.
  → see `01-request-flow.md` and `06-per-request-config-transport.md`
- **Route ↔ MCP server** — WHATWG-standard `fetch` under an MCP
  SDK `StreamableHTTPClientTransport` (`lib/mcp/connect.ts:100`).
  Rate-limited at ~1 req/s per user; the client (`BloomreachDataSource`,
  which `McpDataSource` re-exports at `lib/data-source/mcp-data-source.ts`)
  adds proactive spacing, a retry ladder that parses the server's
  stated penalty window, and a 60s TTL cache.
  → see `03-provider-abstraction-and-datasource-seam.md`
- **Trust boundary at the MCP URL** — everything before this
  boundary is code the deploy owns; everything after it is a
  server the user has to trust. The bearer token (for
  `authType='bearer'`) rides plaintext to whatever URL the config
  resolves to. The URL itself is user-configurable via the
  settings modal. `components/settings/McpConfigModal.tsx` names
  this in the UI copy.
  → see `02-auth-boundary-and-swappable-mcp.md`
- **Route ↔ agents ↔ AptKit primitive** — the four agent files
  (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`,
  `query.ts`) are thin wrappers over `@aptkit/core@0.3.0`
  primitives. The three-class bridge lives in
  `lib/agents/aptkit-adapters.ts` (263 LOC). This seam is where
  the reusable ReAct loop stops and Blooming-specific concerns
  (Anthropic SDK, Bloomreach tool defs, `AgentEvent` NDJSON) start.
  → see `04-aptkit-agent-primitive-boundary.md`

External dependencies (both under the trust boundary named
above): the Anthropic API (`@anthropic-ai/sdk`, calling
`claude-sonnet-4-6` for the four agents plus
`claude-haiku-4-5-20251001` for `classifyIntent`), and whichever
MCP server the config resolves to (default preset:
`https://loomi-mcp-alpha.bloomreach.com/mcp/`).

## 2. request-response-and-data-flow

**Three end-to-end flows, one shared kernel.**

The three flows the product actually runs (feed briefing,
investigation step 2 / step 3, free-form query) all share the
same shape:

```
  client fetch → route decodes mode + config header →
  makeDataSource → bootstrapSchema (once per process) →
  agent.run() → NDJSON events stream back → readNdjson kernel
  parses each line → UI dispatches per event.type
```

Load-bearing details:

- **The mode branch happens at the route.** `?mode=` is parsed
  by `parseLiveMode(raw)` (`lib/data-source/index.ts:64`). Demo
  is served as static JSON (never gets to `makeDataSource`);
  `live-mcp` and `live-synthetic` both go through the factory.
- **The config header is decoded before commit-to-stream.**
  `decodeConfigHeader(req.headers.get(BI_MCP_CONFIG_HEADER))` at
  `app/api/briefing/route.ts:167` and
  `app/api/agent/route.ts:165`. A missing / malformed header
  returns `null` and the route falls through to env config —
  never a 400; a bad header can't crash the request.
- **Cancellation propagates end-to-end.** `req.signal` from the
  Next.js route is threaded through `bootstrap(signal)` →
  `dataSource.callTool(name, args, { signal })` → the transport
  fetch. When the browser cancels, in-flight tool calls abort.
  → see `01-request-flow.md`

The client-side kernel is `readNdjson` at
`lib/streaming/ndjson.ts:17` — one function, four callers
(`useBriefingStream`, `useInvestigation`, `/api/mcp/capture`,
free-form query). It handles the trailing buffer flush at
end-of-stream and polls `cancelOn` between reads so unmounted
consumers exit cleanly.
→ see `05-streaming-ndjson.md`

## 3. state-ownership-and-source-of-truth

**Four state homes, each with a clear owner.**

There's no database. State lives in four places, each with a
distinct scope and lifetime:

- **`localStorage` (browser, cross-session)** — user
  preferences: `bi:mode` (`'demo' | 'live-mcp' | 'live-synthetic'`,
  read at `lib/hooks/useInvestigation.ts:159` and `useBriefingStream`),
  and `bi:mcp_config` (the `McpConfigOverride`,
  `lib/mcp/config.ts:34`). Persisted across tabs and reloads.
- **`sessionStorage` (browser, tab-scoped)** — the current
  investigation trace + result. `useInvestigation` writes it
  after the stream ends; step 3 and back-navigation hydrate from
  it instantly. Survives StrictMode remounts because the hook
  does NOT cancel the in-flight fetch on cleanup.
- **In-memory maps (route process, request-scoped)** —
  `lib/state/insights.ts` and `lib/state/investigations.ts`.
  Session-keyed, ephemeral. Vercel's cold-start rebuilds them.
- **Encrypted cookie (browser ↔ route, session-scoped)** —
  `bi_auth`. AES-256-GCM store carrying the Bloomreach OAuth
  tokens, PKCE verifier, and DCR client info. Managed by
  `AsyncLocalStorage` in production (`lib/mcp/auth.ts`
  `withAuthCookies`). File-backed in dev.

The **single source of truth** for the workspace data itself is
the configured MCP server. Nothing here caches workspace state
durably. The 60s TTL cache in `BloomreachDataSource` is a
per-process request coalescer, not a store.

**The demo replay path** owns its own tiny world: `lib/state/
demo-insights.json` and `lib/state/demo-investigations.json` are
committed to the repo as the presentation-reliability artifact.
→ see `07-demo-replay-as-reliability.md`

## 4. caching-and-invalidation

**Three cache layers, two of them per-process.**

- **`BloomreachDataSource` per-tool TTL cache** — 60s, keyed on
  `(toolName, args)`. Purpose: absorb the ReAct loop's tendency
  to re-ask the same question on adjacent turns. Invalidation
  is time-based; there's no explicit purge. Set
  `{ skipCache: true }` in the call options to bypass (Bloomreach-
  specific — not on the abstract surface; the 4 short MCP
  routes at `/api/mcp/{call,tools,tools/check,capture}` use it
  directly).
- **`bootstrapSchema` module-scope cache** —
  `lib/mcp/schema.ts:138`. A single `WorkspaceSchema` per
  process. Rationale: the schema doesn't change during a
  request; there's no reason to re-bootstrap. Cleared with
  `_resetSchemaCache()` in tests. In production this is
  effectively long-lived — Vercel's function stays warm.
- **Anthropic prompt-cache (ephemeral)** — set at
  `lib/agents/aptkit-adapters.ts:87`. Ephemeral cache breakpoint
  on the system prompt; the tools ride along transparently. First
  turn is cache_creation (~1.25× cost); subsequent turns within
  ~5 minutes are cache_read (~0.1×). For a diagnostic run's
  ~10 turns, this is roughly an 80% reduction on the system-
  prompt token cost.

The `demo=cached` path bypasses all three caches — it doesn't
go through the factory at all.

## 5. storage-choice-and-durability-boundaries

**Not exercised in the traditional sense.**

There is no database, no persistent user-owned store, no
migration. Every piece of durable state lives in one of:

- git (the committed demo snapshots + the code itself)
- localStorage / sessionStorage (user's browser)
- the encrypted cookie (browser, but the plaintext lives in
  request scope on the server side via `AsyncLocalStorage`)
- the MCP server (the actual workspace data — owned by the
  target the config resolves to)

Two consequences worth naming:

- **`sessionStorage` as durability substitute** —
  `useInvestigation` hydrates step 3 from `sessionStorage` so
  the user can navigate back to step 2 without re-running the
  agents. This trades cross-tab persistence for near-instant
  in-tab persistence, which is the correct call for a session-
  scoped investigation.
- **The demo snapshots as a durability substitute for
  presentation reliability** — committed JSON, replayed
  identically every time. `demo-insights.json` +
  `demo-investigations.json`. The reliable path for portfolio
  presentations where the alpha MCP server is likely to be
  down.
  → see `07-demo-replay-as-reliability.md`

Schema shape and data model details belong to
`study-data-modeling`. Storage-engine internals (MVCC,
transactions, indexes) belong to `study-database-systems` —
neither is exercised here.

## 6. failure-handling-and-reliability

**Four failure classes, each with an owner.**

- **MCP rate-limiting (~1 req/s per user, global).** Owned by
  `BloomreachDataSource` at `lib/data-source/bloomreach-data-source.ts`.
  Proactive spacing (`minIntervalMs = 1100`) + a retry ladder
  that parses the stated penalty window from the 429 body
  (`retryDelayMs = 10_000`, `retryCeilingMs = 20_000`, up to 3
  retries). The 60s cache absorbs repeats.
- **OAuth token revocation.** The Bloomreach alpha server
  revokes tokens after minutes. Owned partly by
  `BloomreachAuthProvider` (`lib/mcp/auth.ts`) and partly by
  the client — the feed page auto-reconnects on an
  `invalid_token` error, guarded so the reload only fires once
  per session.
- **Budget overrun.** `BudgetTracker` at `lib/agents/budget.ts`
  checks before every model turn; `BudgetExceededError` throws
  out of `AnthropicModelProviderAdapter.complete`, propagates
  through AptKit's loop, gets caught by the route's error
  handler, and emits a graceful NDJSON `{ type: 'error' }` event.
- **Injected faults (offline).** `FaultInjectingDataSource` at
  `lib/data-source/fault-injecting.ts` decorates any DataSource
  and forces timeout / 429 / 500 / malformed-JSON at
  configurable rates. Used by the load harness to exercise the
  degradation paths without hitting a live server. Tier-2
  receipt: 9 injected faults across 3 investigations, 0 failed
  investigations.

The reliability path for presentation is the demo replay
(committed snapshot). Cross-link to
`study-distributed-systems` for retry/idempotency vocabulary at
the mechanism level.

## 7. scale-bottlenecks-and-evolution

**The bottleneck at 10x is the MCP server, not this system.**

At 10x current concurrency (say 10 simultaneous investigations),
the MCP server's ~1 req/s per-user global limit becomes the hot
floor. Each investigation runs ~6 tool calls; ceiling at 10s per
call gives ~60s per investigation minimum. The 300s route
`maxDuration` swallows this, but the p90 walk grows linearly with
concurrency at the server side.

What changes at 10x:

- **Per-user MCP servers become the pressure release.** The
  swappable-MCP work (Sessions A–D) is what makes this possible
  — a visitor plugs in their own MCP server via the settings
  modal, bypassing the shared alpha entirely.
  → see `06-per-request-config-transport.md`
- **The in-memory maps in `lib/state/`** stop working at
  serverless scale. They already don't work across a cold start;
  they'd need a Redis or KV move.
- **Prompt cache hit rate is the dominant cost knob.** At 10x,
  the ~80% reduction on the system-prompt token cost is the
  difference between $0.09/investigation and something painful.

What stays stable:

- The `AgentEvent` NDJSON contract survives every scale story
  because it doesn't cross state.
- The DataSource seam survives adapter swaps (already proven
  five times).
- The demo replay path survives everything (it's static JSON).

What would force rearchitecture:

- Multi-tenant durable state (users saving investigations,
  sharing findings). Right now everything is session-scoped;
  this would need real storage and a real auth boundary between
  users, not a session cookie.

## 8. system-design-red-flags-audit

**Ranked, worst first.**

1. **`bi_auth` cookie carries the bearer token in localStorage,
   not in an encrypted cookie.** For `authType='bearer'`, the
   token rides in localStorage (`bi:mcp_config`) and gets sent
   plaintext in the config header on every fetch. The modal
   surfaces this warning (`components/settings/McpConfigModal.tsx`
   trust-boundaries section), but the mitigation is only "don't
   paste production credentials." A future move is to encrypt
   the token into a short-lived cookie server-side. Flagged in
   `lib/mcp/config.ts:22-23` as future work.
2. **In-memory state maps.** `lib/state/insights.ts` and
   `investigations.ts` do not survive a cold start. This is fine
   for a portfolio demo but is the first thing that breaks at
   any real concurrency.
3. **The `BloomreachAuthProvider` name outlives its identity.**
   The class is generic OAuth 2.1 + PKCE + DCR; it works
   against any OAuth-enabled MCP server. The name is preserved
   for import stability; the honest rename would be
   `SessionPersistedOAuthProvider`. Called out at
   `lib/mcp/auth-providers/bloomreach.ts:12-15`.
4. **`bootstrapSchema`'s module-scope cache** — `lib/mcp/schema.ts:138`.
   Works fine when one route process serves one MCP server; if
   the user switches config mid-session, the cached schema is
   from the old target. The switch triggers a page reload
   (`writePersistedConfig` in the modal), which restarts the
   process for the browser, but the route-side memory doesn't
   flush per-request.
5. **Silent malformed-header fallback.** A bad
   `x-bi-mcp-config` header decodes to `null` and the route
   falls through to env config with no error surfaced. Deliberate
   ("a bad header shouldn't crash the request",
   `lib/mcp/config.ts:86-87`), but a debugging visitor sees
   "why isn't my config taking effect?" with no signal.
