# Audit — system design lenses, grounded in this repo

Walks the 8 system-design lenses against the codebase. Each `##` section is one lens. When a finding is large enough to deserve its own pattern file, the lens cross-links to it instead of restating.

## system-map-and-boundaries

The system has six load-bearing layers — browser, Next.js routes, factory, port (`DataSource`), adapters, external provider — plus an agent runtime layer that sits beside the routes and an in-process state layer that survives across requests on a warm instance. See `00-overview.md` for the full map.

The boundaries that matter:

- **UI ↔ route boundary** — HTTP, `content-type: application/x-ndjson`. The wire contract is the `AgentEvent` union in `lib/mcp/events.ts`. → see `01-request-flow.md`.
- **Route ↔ adapter boundary** — the port (`DataSource`) at `lib/data-source/types.ts:63-71`. Two adapters today, two swaps in the seam's history without a caller change. → see `03-datasource-seam.md`.
- **Adapter ↔ external boundary** — HTTPS via `StreamableHTTPClientTransport`, OAuth/PKCE/DCR session in the cookie. → see `02-auth-boundary.md`.
- **Repo ↔ library boundary** — the three AptKit adapter classes at `lib/agents/aptkit-adapters.ts:26,75,100`. Library owns the loop, repo owns the boundary. → see `04-aptkit-primitive-boundary.md`.
- **Trust boundary** — the Bloomreach server is the only externally-trusted surface; the synthetic adapter eliminates it for the local mode. AnthropicAPI is trusted-by-key (`ANTHROPIC_API_KEY`). No user-supplied tool call is executed without a prior schema introspection.

External dependencies (third-party reach): `@anthropic-ai/sdk`, `@aptkit/core@0.3.0`, `@modelcontextprotocol/sdk`, the Bloomreach loomi connect server. Deployment target: Vercel Pro (`maxDuration = 300` on `/api/briefing` and `/api/agent`).

## request-response-and-data-flow

Two important request flows. The third (dev-only capture) is operational tooling.

**1. The briefing flow** — `GET /api/briefing?mode=…`:

```
  browser → fetch → /api/briefing → getOrCreateSessionId → makeDataSource
       → bootstrap (Bloomreach orchestrator) → schema
       → schemaCapabilities → coverageReport (10-cat checklist)
       → listTools → MonitoringAgent.scan (AptKit loop)
            → callTool ↔ DataSource (per category)
            → emit reasoning_step / tool_call_start / tool_call_end events
       → anomalies → anomalyToInsight → putInsights(sessionId, …)
       → emit insight events → emit done
```

The whole pipeline streams as NDJSON; the UI renders each insight as it arrives. Five phases are timed (`schema_bootstrap`, `coverage_gate`, `list_tools`, `monitoring_scan`, and the wall-clock total) and logged in the route's `finally` so the per-request line fires even on error (`app/api/briefing/route.ts:202-207, 317-324`). → see `01-request-flow.md`.

**2. The investigation flow** — `POST /api/agent` (with `step=diagnose|recommend`): the browser carries the `Insight` across instances by stashing it in `sessionStorage`, since on Vercel the briefing and the investigation can land on different functions. The diagnostic step returns a `Diagnosis`; the recommendation step takes that `Diagnosis` as input and produces `Recommendation`s.

Parallel work: none in the hot path — the agent loop is sequential (the model decides what to call next). Fan-out lives inside the monitoring scan, where AptKit can run multiple categories concurrently within the rate-limit envelope. Waterfalls: the briefing's `bootstrap → listTools → scan` is a forced sequence (the agent needs the tool schemas to plan).

## state-ownership-and-source-of-truth

Five state owners, each with a different lifetime:

| State | Owner | Lifetime | Notes |
|-------|-------|----------|-------|
| Session identity | `bi_session` cookie | 10 days (matches token life) | `httpOnly`, `SameSite=None` + `Secure` in prod, `Lax` in dev (`lib/mcp/session.ts:10-14`) |
| OAuth tokens (prod) | encrypted cookie `bi_auth` | 10 days | AES-256-GCM under `AUTH_SECRET`, seeded into `AsyncLocalStorage` per request (`lib/mcp/auth.ts:34-78`) |
| OAuth tokens (dev) | gitignored file `.auth-cache.json` | until manually cleared | survives hot-reload; never committed |
| Feed state | `Map<sessionId, SessionFeed>` in `lib/state/insights.ts` | warm-instance lifetime | per-session keying eliminates cross-user wipe |
| UI replay/back-nav | `sessionStorage` | tab lifetime | `useInvestigation` writes the result so step-3 + back-nav hydrate instantly |

Demo snapshots (`lib/state/demo-insights.json`, `lib/state/demo-investigations.json`) are committed JSON — the durable, deterministic source of truth for the demo path. → see `07-in-memory-state-ownership.md` and `08-demo-replay-as-reliability.md`.

There is no SQL DB and no Redis. Every other state question lands in one of the five owners above.

## caching-and-invalidation

Two caches, both inside the Bloomreach adapter (the only place upstream calls happen):

1. **Response cache** — `Map<name+args, {result, expiresAt}>`, 60s TTL by default (`lib/data-source/bloomreach-data-source.ts:122, 144-152`). Absorbs the same EQL query repeated across categories within one briefing run, which is the common case. Skipped via `skipCache` on dev paths (`/api/mcp/call`, `/api/mcp/capture`). **Errors are not cached** (`bloomreach-data-source.ts:178-181`) — a transient 5xx must not poison the next minute.
2. **Tool-list** — not cached. Listed once per request via `dataSource.listTools` (`app/api/briefing/route.ts:250`). The tool set is stable per connection and listed rarely; caching would just add complexity.

Invalidation strategy: time-based only (60s expiry). No explicit invalidation surface — the briefing's 1-minute repeat cost is intentional. The synthetic adapter does no caching (it's a deterministic in-process fixture; cache adds nothing).

→ see `10-rate-limit-aware-mcp-client.md` for how caching, spacing, and retry compose.

## storage-choice-and-durability-boundaries

**There is no durable database.** This is a deliberate choice with three load-bearing consequences:

- The feed `Map` lives in process memory; a Vercel cold-start drops it. The demo snapshot file is the durable fallback.
- OAuth tokens persist in an encrypted cookie (prod) or a gitignored file (dev) — both of which survive deployment rollovers, but neither of which is a shared store across regions.
- Each session is a self-contained world: no cross-session aggregation, no analytics-on-analytics, no longitudinal trends.

What would change if a DB were added: storage durability moves from the cookie to the DB; the agent's history becomes queryable across sessions; a worker queue likely shows up to decouple the briefing scan from the request. None of those are needed today. The system's job is to read live workspace data, not to remember its own outputs.

Cross-link: foundation-level engine concerns belong to `study-database-systems`; schema-shape concerns belong to `study-data-modeling` (the `Insight` / `Anomaly` / `Diagnosis` / `Recommendation` wire types are the data model in lieu of a schema).

## failure-handling-and-reliability

Five failure modes, each with a named recovery path:

1. **Bloomreach rate limit (1 req/s, sometimes 1-per-10s)** — the adapter parses the server's stated window from the error text, sleeps that long plus a 500ms buffer, retries up to 3 times, with a 20s ceiling per wait (`bloomreach-data-source.ts:157-174`). Proactive spacing at 1.1s between calls prevents the first hit in most cases (`lib/mcp/connect.ts:96-100`). → see `10-rate-limit-aware-mcp-client.md`.
2. **Bloomreach token revocation (alpha-server reality, minutes after issue)** — the UI hook `useReconnectPolicy` detects an auth-shaped error message, fires one reset + reload, and guards against re-firing in the same session. The error event flows through the NDJSON stream's `error` case; the policy is consulted before the message is surfaced (`lib/hooks/useBriefingStream.ts:274-284`). → see `02-auth-boundary.md`.
3. **Per-request client cancel (tab close, mode flip, navigation)** — every async layer threads `signal`: `req.signal` from the route, threaded into `bootstrap(req.signal)`, `dataSource.listTools({signal})`, `dataSource.callTool({signal})`, and the Anthropic SDK's `{signal}` option. The route's `catch` swallows `AbortError` (it's not an error) but still runs the `finally` to log the partial-budget consumed (`app/api/briefing/route.ts:290-296`).
4. **Setup throw (missing `ANTHROPIC_API_KEY`, missing `AUTH_SECRET`)** — caught before the stream is committed so the route can return JSON with the real message instead of opening a stream and emitting an error (`app/api/briefing/route.ts:166-178`).
5. **Demo as the reliable fallback** — when Bloomreach is unreachable, slow, or the auth has rotted, the user flips to the demo mode and the committed snapshot replays as if it were a live NDJSON stream. The presentation path is never dependent on the live path. → see `08-demo-replay-as-reliability.md`.

Graceful degradation: monitoring runs only the **runnable** categories (the schema-gated subset); unsupported categories surface in the coverage grid as `no data source` or `limited` instead of failing the briefing. → see `09-schema-gated-coverage.md`.

Cross-link: coordination-correctness concerns under failure (exactly-once, consensus, ordering across instances) belong to `study-distributed-systems`. This repo's failure handling is single-process, single-request scoped.

## scale-bottlenecks-and-evolution

What breaks first at 10x:

- **Bloomreach rate limit** is the dominant constraint at any load. The 1-per-1s or 1-per-10s ceiling is per-user-global; 10 concurrent users do not get 10x throughput because the limit is enforced upstream. Mitigation today is the 60s response cache (absorbs the common case of repeated queries within a briefing) plus the synthetic adapter for any non-Bloomreach-specific work.
- **In-process state** scales by the count of warm Vercel instances. A burst that creates 50 sessions on one warm instance is fine; a burst that spreads across 50 instances means none of them have the others' feed state. Today that's invisible because feed state is per-session, not cross-session; if it ever needs to be cross-session, a shared store (Redis) replaces the `Map`.
- **`maxDuration = 300`** caps the live briefing at five minutes. The monitoring scan with 10 categories and ~6 tool calls each easily fits, but a workspace with deeper history could push it; the natural mitigation is to split the scan across requests (one category at a time) and have the UI orchestrate.

What stays stable: the port (`DataSource`), the AptKit primitive boundary, the streaming kernel, the session-scoped state model. None of those need to change for 10x users.

What would force rearchitecture at 100x:

- a need to share feed state across instances → adds Redis or a DB
- a need to cross-tenant aggregate → ends the "session is the world" model
- a need to react to events from Bloomreach (push, not pull) → introduces a webhook surface or a queue

## system-design-red-flags-audit

Ranked architectural risks, each grounded.

1. **The Bloomreach upstream is alpha-grade.** The OAuth tokens revoke after minutes, the rate limit is severe and sometimes-10s, and the error envelopes have at least two shapes the adapter has to parse (`bloomreach-data-source.ts:64-71`). The demo path exists in part because the live path cannot be presentation-reliable. *Risk: demo dependency.* Mitigation: the seam abstraction means the live path can swap to a non-alpha provider without touching callers (synthetic already proves the swap works).
2. **No durable database.** This is a deliberate choice and is currently fine — there's no cross-session need — but it is a *design ceiling*: the system cannot remember anything across cold starts beyond what's committed to git. *Risk: any feature requiring history-of-history.* Mitigation: not needed yet; add a DB when the feature shows up.
3. **`@aptkit/core` is at `0.3.0`.** A pre-1.0 library on the critical path. The legacy hand-rolled loop preserved at `lib/agents/base-legacy.ts` is the rollback receipt. *Risk: breaking change in 0.4 forces a bridge update.* Mitigation: the three adapter classes are the only place that touches the library — the blast radius of a library change is 206 LOC, not the whole agent layer.
4. **Two adapters live behind `DataSource` today (Bloomreach + Synthetic), and the synthetic adapter is 516 LOC of fixtures.** That's more code than the real adapter (214 LOC). *Risk: drift between adapters.* Mitigation: both implement the same port, and the same agent loop runs against both — drift surfaces as a test failure.
5. **OAuth + cookie storage logic is hand-rolled** (`lib/mcp/auth.ts`, 259 LOC). AES-256-GCM, AsyncLocalStorage seeded per request, dev/test/prod branching. The code is careful and tested but is not the kind of thing one wants to write twice. *Risk: subtle auth bugs.* Mitigation: the surface is narrow (`OAuthClientProvider` interface), and a single `_clearAuthStore` test helper lets the test suite reset between cases.

Findings 1, 4, 5 have dedicated pattern files. Findings 2, 3 stay in the audit — they are decisions, not patterns.
