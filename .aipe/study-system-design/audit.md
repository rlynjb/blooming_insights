# audit.md — the 8-lens walk

One `##` section per lens. Each finding is grounded in `file:line`. When a finding is load-bearing enough to earn its own concept file, the audit links to it rather than restating it.

## 1. system-map-and-boundaries

The system is a single Next.js 16 App Router deployment on Vercel Pro plus two external dependencies (Anthropic, Bloomreach loomi connect MCP). There is no database, no queue, no worker. All state lives in per-session in-memory `Map`s and per-user cookies.

Six trust boundaries:

- **browser ↔ Next server** — session cookie (`bi_auth`, AES-256-GCM) established server-side (`lib/mcp/auth.ts:73-77`); no API keys or OAuth tokens ever cross to the browser.
- **Next server ↔ Anthropic** — `ANTHROPIC_API_KEY` in env, never in an env var prefixed `NEXT_PUBLIC_` (checked in every route: `app/api/briefing/route.ts:155`, `app/api/agent/route.ts:153`).
- **Next server ↔ Bloomreach MCP** — OAuth 2.1 with PKCE + Dynamic Client Registration, one client per session, tokens live in the encrypted cookie (prod) or a gitignored file (dev). Details: `04-oauth-boundary.md`.
- **route handler ↔ agent** — the `DataSource` interface (`lib/data-source/types.ts:63-71`) is the only surface between them. Details: `01-datasource-seam.md`.
- **Blooming agent ↔ AptKit runtime** — three-class bridge (`lib/agents/aptkit-adapters.ts`, 260 LOC). Details: `02-aptkit-boundary.md`.
- **live path ↔ offline eval** — the eval harness (`eval/`) only imports from `lib/`, never the reverse (documented in `eval/README.md:52`); production has no idea evals exist.

## 2. request-response-and-data-flow

Three important end-to-end flows.

**Feed flow** (`GET /api/briefing`, streams NDJSON):

```
  bootstrap schema → coverage gate → listTools → MonitoringAgent.scan
    → per-category tool loop → anomalies → anomalyToInsight → session store
```

Per-phase timings recorded in `phases[]` and dumped once per request in the route's `finally` block (`app/api/briefing/route.ts:317-324`). Real baseline p50 (Sonnet 4.6, 10 goldens): `schema_bootstrap` 50s, `list_tools` 38s, `monitoring_scan` 51s, `investigation` 90s.

**Investigation flow** (`GET /api/agent?step=diagnose|recommend`, streams NDJSON):

```
  resolveAnomaly (client → session → demo) → bootstrap → listTools →
    if step=diagnose: DiagnosticAgent.investigate → emit diagnosis, done
    if step=recommend: parse handed-over diagnosis → RecommendationAgent.propose
```

Client hands the diagnosis between steps via `sessionStorage` (`bi:diag:<id>`), not via server state — the Vercel per-instance memory can't be trusted across a page navigation.

**Demo replay** (`?demo=cached` or cached investigation): reads `lib/state/demo-*.json`, emits the same NDJSON events with a `REPLAY_DELAY_MS = 140/180` between them so the UI reveals at a human pace (`app/api/briefing/route.ts:25`, `app/api/agent/route.ts:103`). Same UI code, same event contract — details: `03-ndjson-streaming.md`.

## 3. state-ownership-and-source-of-truth

State is split across five owners; the split is deliberate.

- **Runtime toggle** — `localStorage['bi:mode']`, owned by the browser. Read once on mount (`app/page.tsx:68-84`), migrates legacy `'live'`/`'live-sql'` values to `'live-bloomreach'` inline. Details: `05-demo-vs-live-mode.md`.
- **OAuth session** — encrypted cookie (`bi_auth`, prod) or `.auth-cache.json` (dev), keyed by session id. `AsyncLocalStorage` scopes the read/write per-request so concurrent requests on one instance don't cross-contaminate (`lib/mcp/auth.ts:41-46`).
- **Insights + investigations** — per-session `Map`s in `lib/state/insights.ts:14`. Outer `Map<sessionId, SessionFeed>` never cleared; `putInsights` clears only the inner maps (`lib/state/insights.ts:64-71`) — this is the load-bearing detail that keeps a warm instance from wiping another user's feed.
- **Client-side investigation stash** — `sessionStorage['bi:inv:<step>:<id>']`, populated at stream-complete; back-nav hydrates from it instead of re-running the agents (`lib/hooks/useInvestigation.ts:19-21`, `50-63`).
- **Cached combined investigation** — dev only, on disk (`.investigation-cache.json`), only for the null-step combined capture run (`app/api/agent/route.ts:300-302`).

There is no shared server state across Vercel instances. The system explicitly accepts the "each instance sees its own memory" tradeoff — details: `05-demo-vs-live-mode.md` explains why the client stashes the diagnosis instead of trusting server memory.

## 4. caching-and-invalidation

Two caches in the live path plus one on-disk cache in dev.

- **BloomreachDataSource response cache** (60s TTL, `lib/data-source/bloomreach-data-source.ts`): absorbs repeated tool calls within a single investigation. Not invalidated — TTL is the whole invalidation strategy. Freshness matters less than budget: monitoring re-queries the same window if agents ask twice, and eating a repeat is worse than a 60s stale result.
- **Anthropic prompt cache** on the system prompt (`lib/agents/aptkit-adapters.ts:83-89`): the system prompt is stable across every model turn in an investigation. Wrapping it in `cache_control: { type: 'ephemeral' }` makes the first turn a cache_creation (~1.25×) and every subsequent turn within 5 min a cache_read (~0.1×). For a ~10-turn diagnostic this is roughly an 80% reduction on system-prompt cost. Invalidation is Anthropic's 5-minute TTL; no code path invalidates it.
- **`.investigation-cache.json`** (dev only, gitignored): on-disk cache of the last combined-capture run. Never trusted across sessions in prod; `?live=1` bypasses it.

No CDN cache is set for the streaming routes — both routes emit `Cache-Control: no-store, no-transform` (`app/api/briefing/route.ts:149`, `app/api/agent/route.ts:107`).

## 5. storage-choice-and-durability-boundaries

The honest answer: **there is no persistent datastore**. Three tiers of ephemerality:

- **Runtime memory** — `Map<sessionId, SessionFeed>` (`lib/state/insights.ts:14`). Lost on every cold start / deploy / instance rotation. Acceptable because the client stashes what it needs for back-nav.
- **Cookies** — the encrypted auth cookie is durable across requests but not across users, and never carries business data (only OAuth tokens).
- **Committed JSON** (`lib/state/demo-*.json`) — the demo snapshot. Not a database — a *fixture* that the demo path replays. Version-controlled, updated by dev-only capture tooling.

For the schema shape of `Insight` / `Anomaly` / `Diagnosis` / `Recommendation` see `study-data-modeling` — that's what those types owe callers regardless of where they eventually persist. For the "what would need to change if we actually did add a database" analysis see lens 7 below.

## 6. failure-handling-and-reliability

Three graceful-degradation paths, all wired to real failure modes seen against the alpha Bloomreach server.

- **Token revoke → auto-reconnect.** Bloomreach's alpha revokes tokens after minutes. `lib/hooks/useReconnectPolicy.ts` reacts to an `invalid_token` error message by calling `/api/mcp/reset` and reloading once, guarded by a session-scoped flag so a redirect loop is impossible.
- **Rate limit → retry ladder.** `BloomreachDataSource` parses the server-stated retry window from the error text and sleeps `parsed + 500ms buffer` (`lib/data-source/bloomreach-data-source.ts:49`, `65-71`). Falls back to bounded backoff when no hint is parseable.
- **Budget exceeded → NDJSON error.** `BudgetTracker` checks the accumulated spend *before* each model turn (`lib/agents/aptkit-adapters.ts:63-66`); throws `BudgetExceededError`; caught in the route's try/catch (`app/api/agent/route.ts:303-316`); emitted as a graceful `{ type: 'error', message }` NDJSON event the UI already knows how to render. Details: `06-budget-and-observability.md`.

The route handlers' `finally` blocks are the incident-signal path: `phases[]` + `aborted` + `totalMs` logged as one JSON line per request, so a Vercel filter (`phases.phase = "schema_bootstrap"`) reads across both routes uniformly. Fires even on error, so an OOM/timeout at 299 seconds still leaves a receipt of how much budget was burned.

Offline, the fault-injection decorator (`lib/data-source/fault-injecting.ts`) forces those same failure modes at configurable rates against the synthetic adapter so the load harness exercises the recovery paths deterministically. The four fault kinds — timeout, rate_limit, server_error, malformed_json — are shaped to match Bloomreach's real error envelopes byte-for-byte (`lib/data-source/fault-injecting.ts:112-155`).

Cross-link to `study-distributed-systems` for coordination correctness across the OAuth boundary (the `AsyncLocalStorage` pattern in `lib/mcp/auth.ts` is the local-only mechanism that keeps concurrent requests on one instance from seeing each other's OAuth state; that's a single-process concurrency concern, not distributed).

## 7. scale-bottlenecks-and-evolution

What breaks first at 10× and what stays stable.

**Breaks first at 10× traffic (concurrent users):**

- **Bloomreach rate limit** (~1 req/s per session). Ten concurrent live briefings = ten sessions, so the per-session limit doesn't add up — the rate ladder already handles it per-session. This scales.
- **Vercel Pro 300s max duration.** A single live investigation runs ~100-115s under the rate limit; ten concurrent are still within the budget. Not the bottleneck.
- **In-memory `Map<sessionId, ...>` per instance.** At 100 concurrent users, memory is fine; at 10,000, this becomes the pressure point *if* users start returning to warm instances expecting their state to still be there. Today the client stashes what it needs (`useInvestigation.ts:50-63`), so this scales further than it looks.

**Breaks first at the feature axis, not the traffic axis:**

- **Adding a real database.** Would need to sit behind a new port (`lib/state/insights.ts`'s `putInsights` / `listInsights` signature is the natural boundary). The pattern for how to add it without a caller change is already exercised by the DataSource seam (`01-datasource-seam.md`).
- **Multi-region + shared state.** Would break the "session-scoped in-memory" assumption. The cookie-based OAuth already survives instance rotation; the insights map does not. Session store (Redis) or per-user KV would be the move.
- **Long-running background monitoring.** Today monitoring is on-demand per browser hit. A "scan every workspace overnight" job would need a scheduler (Vercel Cron), a queue for fan-out, and a real store for the resulting feed. This is the biggest gap between "the shape today" and "an actual analyst product."

**Stays stable at 100×:** The `DataSource` seam (four adapters swapped without a caller change is the empirical proof), the AptKit boundary (any provider could be plugged in behind `ModelProvider`), the NDJSON contract (four surfaces speak it; adding a fifth is additive), the demo-mode fallback (a snapshot never gets faster or slower with load).

Cross-link to `study-distributed-systems` for what the multi-region shift specifically would need (coordination, invalidation, consistency).

## 8. system-design-red-flags-audit

Ranked by real risk to the running system, not by architectural taste.

**1. No persistent store; a warm serverless instance is the only source of "your recent feed."** Rated: acceptable today because the demo path is the primary presentation surface and the live path is recovery-oriented. Rated: unacceptable the moment a customer expects "my briefing from this morning." Move: sit a KV/session store behind `putInsights`/`listInsights` in `lib/state/insights.ts`.

**2. Bloomreach's alpha token revoke is a load-bearing UX assumption.** The reconnect policy is well-hardened, but every live session eats a UX event within minutes. Rated: known, mitigated. Move: when Bloomreach ships GA with longer tokens, delete the guard.

**3. Legacy `-legacy.ts` duplicates in `lib/agents/`.** `base-legacy.ts`, `diagnostic-legacy.ts`, `monitoring-legacy.ts`, `recommendation-legacy.ts`, `intent-legacy.ts`, `query-legacy.ts`, `categories-legacy.ts`, `legacy-validate.ts`, `legacy-prompts/` — pre-AptKit implementations kept in-tree during the migration. Rated: dead code shipping in the deploy bundle. Move: schedule removal after the eval baseline confirms the AptKit paths lead by ≥5pp on every rubric dimension.

**4. `page.tsx` at 461 LOC.** Well-organized (three hooks pulled out: `useBriefingStream`, `useReconnectPolicy`, `useDemoCapture`), but this file is the single one every engineer touches when the feed layout changes. Rated: acceptable now; watch for growth. Move: extract the mode toggle + header once a second header customer surface exists.

**5. `SyntheticDataSource` at 516 LOC.** Large because it re-implements the response shapes of ~15 Bloomreach tools. Rated: intentional — this is a test double masquerading as a real adapter, and shrinking it means faking less. Move: none; treat it as fixture code.

**6. Eval `judge_error` count of 6/10 on `root_cause_plausibility` in the current baseline.** (`eval/baseline.json:44-46`) — six cases the judge itself couldn't score. Rated: the baseline captures reality, but the reality is that the judge is fragile on this dimension. Move: tighten the rubric prompt or add a second-pass judge; regeneration gate stays honest either way.

**7. No `lint` step in CI** (documented in `ci.yml:33-38`). Twenty-eight pre-existing errors. Rated: known-and-noted, not a red flag until the number stops shrinking. Move: dedicated cleanup PR.
