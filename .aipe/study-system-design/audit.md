# System design — audit

> **Verdict-first.** blooming insights is a **Next.js 16 app that hangs four Claude agents off one MCP server, with no database**. The architecture earns its weight from three pieces that show up in every lens below: `runAgentLoop` (one function, four agents — see `06-multi-agent-orchestration.md`), `McpClient` (the single MCP choke-point with TTL cache + spacing + retry — see `04-caching-and-rate-limiting.md`), and the route-level NDJSON streams (long agent runs feel responsive — see `05-streaming-ndjson.md`). The strongest pattern is the absence of a database: state lives in in-memory `Map`s + an encrypted cookie + committed demo JSON, and the architecture is honestly aligned with what it does today. The load-bearing gap is the same `Map` being global to the instance rather than session-keyed — at ~10 concurrent users on one warm Vercel instance, one briefing's `putInsights.clear()` wipes another's. Highest-priority finding: session-key `lib/state/insights.ts` (~30 LOC, eliminates the only correctness issue at any current scale).

---

## system-map-and-boundaries

Five bands. UI is two pages and one hook (`app/page.tsx` L87–L817, `app/investigate/[id]/page.tsx`, `lib/hooks/useInvestigation.ts` L37–L216). Route layer is three NDJSON-streaming handlers, all `maxDuration = 300` (`/api/briefing`, `/api/agent`, `/api/mcp/*`). Agent layer is one shared loop + four agent classes (`lib/agents/base.ts` L48–L176 + monitoring/diagnostic/recommendation/query). Provider layer is `McpClient` (`lib/mcp/client.ts` L79–L172) wrapping `McpTransport` wrapping the MCP SDK with `BloomreachAuthProvider` (`lib/mcp/auth.ts` L86–L218) underneath. External is Bloomreach MCP (data, ~1 req/s/user GLOBAL) and Anthropic (reasoning, `claude-sonnet-4-6`).

**Three real boundaries, one cosmetic.**

- **B1 browser ↔ route** — trust flips HOSTILE → OURS. Enforced by httpOnly `bi_session` UUID + AES-256-GCM encrypted `bi_auth` cookie (`lib/mcp/auth.ts` L51–L79).
- **B2 McpClient ↔ Bloomreach** — trust flips OURS → UPSTREAM + rate flips to ~1 req/s/user. The whole stack is shaped by this latency floor.
- **B3 model output ↔ typed value** — trust flips UNTRUSTED text → TYPED value via `parseAgentJson` + per-shape type guards in `lib/mcp/validate.ts`; mismatch → `FALLBACK`.
- **Cosmetic: route ↔ agent loop** — same process, same `Map`s, same heap. Calling it a "boundary" would lie about what changes when you cross it (nothing). The day we add a queue between the route and the agent, this cosmetic boundary becomes real — that's the file-07 migration in `me.md` shape.

The intra-process CODE → MODEL flip inside the agent loop is a control-flip, not a trust boundary; the model has no privileged access.

→ see `02-oauth-boundary.md` for the B1 mechanism · `04-caching-and-rate-limiting.md` for the B2 defense · `study-security/` for the B3 enforcement detail · `03-provider-abstraction.md` for the `McpCaller` + `McpTransport` seams that make the provider band testable offline.

---

## request-response-and-data-flow

Three live flows + one replay shortcut, all sharing the same NDJSON `AgentEvent` wire format (`lib/mcp/events.ts` L4–L17).

- **Flow 1 — briefing (`/api/briefing`).** Schema bootstrap → coverage gate → monitoring scan → emit `workspace`, `coverage_item ×10`, `tool_call_*`, `insight×N`, `done`. Sequential, 30–60s cold start.
- **Flow 2 — investigation step (`/api/agent?step=…`).** Cache-replay shortcut at the top (`app/api/agent/route.ts` L127–L141): on hit, replay `filterByStep`'d events at 180ms each, never touching MCP or Anthropic. On miss, run live DiagnosticAgent or RecommendationAgent (≤6 tool calls), 30–90s typical.
- **Flow 3 — query (`/api/agent?q=`).** `classifyIntent` → `QueryAgent.answer` → text conclusion. Never cached.

The load-bearing UX trick: the route writes the *first* event (`stepFor(leadAgent, 'thought', 'reading the workspace schema…')`) INSIDE the stream (`app/api/agent/route.ts` L196–L203), so the browser sees a reasoning step in <100ms — long before `bootstrapSchema` finishes the 4 sequential MCP calls. Real latency unchanged; perceived latency drops from "30s blank" to "200ms first event, then activity." Parallelism inside the pipeline buys nothing because the rate limit is global per user.

The most consequential seam in the whole system is route → agent loop: control flips from CODE-decides (the route's fixed pipeline order) to MODEL-decides (Claude picks tools). Every later concern (latency, budget, output validation) hangs off this flip.

→ see `01-request-flow.md` for the briefing hop-by-hop · `05-streaming-ndjson.md` for the wire format mechanics · `07-client-stream-handoff.md` for the client-side reader + step-to-step handoff · `06-multi-agent-orchestration.md` for the CODE → MODEL flip inside the loop.

---

## state-ownership-and-source-of-truth

Eleven pieces of state, seven owners, one source of truth that lives **outside the codebase entirely (Bloomreach)**. Every insight is a transformed Bloomreach query result; every diagnosis is the agent's interpretation of EQL data; the workspace schema is a snapshot of four MCP calls.

State, in lifetime order:

| State | Owner | Lifetime |
|---|---|---|
| `useState` slots | components | per mount |
| `useRef` (startedRef) | `useInvestigation` | per mount |
| `sessionStorage` (`bi:insight:`, `bi:diag:`, `bi:inv:*`) | browser | per tab |
| `localStorage` (`bi:mode`) | browser | per browser |
| `bi_session` cookie | browser | session |
| `bi_auth` cookie (AES-256-GCM) | browser | **10 days** |
| insights/anomalies/investigations `Map`s | Vercel instance | instance lifetime |
| schema cache (singleton, no TTL) | Vercel instance | instance lifetime |
| McpClient cache + lastCallAt | per-request McpClient | request |
| ALS request store | per-request | request |
| dev `.auth-cache.json` / `.investigation-cache.json` | filesystem (dev) | until deleted |
| committed `demo-*.json` | git | per deploy |

The load-bearing fact: **nothing in-process survives an instance recycle in production except the encrypted `bi_auth` cookie and the committed demo JSON**. Everything else has to be re-derived from Bloomreach or re-handed-over via `sessionStorage`. The `bi:insight:{id}` stash + `?insight=` query param waterfall in `app/api/agent/route.ts` `resolveAnomaly` (L37–L62) is what bridges the per-instance-Map gap for live-mode users — without it, an instance hop loses the click target.

The system-of-record being upstream is what makes "no database" work: there's no policy to choose for "how stale can a cached insight be" because the answer is "re-run the briefing." That answer stops being defensible the moment two users want a shared feed or anyone wants yesterday's anomalies.

→ see `07-client-stream-handoff.md` for the `sessionStorage` four-key handoff (`bi:insight:`, `bi:diag:`, `bi:inv:diagnose:`, `bi:inv:recommend:`) and the `startedRef` StrictMode latch · `02-oauth-boundary.md` for the ALS-scoped cookie store + why production needs encryption to survive ephemeral instances.

---

## caching-and-invalidation

Four caches, three invalidation strategies, **none explicit**.

- **McpClient TTL cache** (`lib/mcp/client.ts` L80, L100–L146): `Map<"{name}:{argsJson}", {result, expiresAt}>`, 60s default TTL. Time-based invalidation — the only automatic invalidation in the system. Calibrated for *intra-investigation* repeats: an agent often runs the same EQL twice and the second call is a hit.
- **Schema cache** (`lib/mcp/schema.ts` L131): single module-level slot, **no TTL**, dies only on instance recycle. Correct for now because workspace schemas change on the order of weeks; brittle the day a customer adds a new event type and a warm instance keeps serving for hours.
- **Investigations replay store** (`lib/state/investigations.ts` L11, L22–L41): three-tier waterfall (in-memory `Map` → dev file → committed `demo-investigations.json`). No invalidation — agent traces are valid forever (they're history).
- **sessionStorage stash** (`lib/hooks/useInvestigation.ts` L18, L132–L140): keyed by `bi:inv:{step}:{id}`, short-circuits the fetch on re-visit within the same tab.

**Three load-bearing absences.** Free-form queries (`?q=`) are never cached (no stable key, semantically a current question). Tool errors (`isError: true`) are never cached (`lib/mcp/client.ts` L137–L139) — a transient 429 doesn't poison the next 60 seconds. The schema cache isn't keyed by `projectId` (singleton).

The strategy: **caching is cheap when "the cache dies when the process dies" is an acceptable invalidation rule.** It gets expensive the moment you need cross-process consistency — which is the day you need a database + cache invalidation messaging.

→ see `04-caching-and-rate-limiting.md` for the McpClient TTL cache + spacing + retry mechanics together, including the no-cache-on-error rule that makes the cache and retry loop compose safely.

---

## storage-choice-and-durability-boundaries

Eight storage tiers; **only three (cookies, committed JSON, Bloomreach) are durable beyond instance lifetime in production**. The architecture's most consequential decision is no database, by design — the system-of-record IS Bloomreach.

- **Tier 1 — in-memory `Map` (default).** Insights, investigations, McpClient cache, schema singleton. Instance lifetime; ephemeral by default.
- **Tier 2 — ALS request store** (`lib/mcp/auth.ts` L46–L47, L86–L104). Per-request scratch space; the *only* request-scoped storage. Exists because Next's request/response cookie split breaks read-after-write — the ALS holds the in-memory copy and flushes once at request end.
- **Tier 3 — sessionStorage** (per tab). The cross-instance carrier for live-mode insights.
- **Tier 4 — localStorage** (`bi:mode` only). User preference, persists across browser restarts.
- **Tier 5 — cookies (load-bearing).** `bi_session` (UUID, session) + `bi_auth` (AES-256-GCM, 10 days). **The only production storage that survives instance recycle AND carries application state.** Without it, OAuth couldn't work across Vercel's ephemeral instances — the connect request saves PKCE state on instance A, the callback lands on instance B with a different `Map`, and authentication silently breaks.
- **Tier 6 — filesystem (dev only).** Gated by `PERSIST = NODE_ENV === 'development'` in both `lib/mcp/auth.ts` L34 and `lib/state/investigations.ts` L7. Vercel functions are read-only FS in production.
- **Tier 7 — committed JSON (per deploy).** `demo-insights.json` + `demo-investigations.json` — the demo's stable backstop, treats git as a storage tier.
- **Tier 8 — Bloomreach (upstream).** The actual durable storage; we never write to it (read-only tool whitelist in `lib/mcp/tools.ts`).

**The smallest viable add** if shared feeds become a requirement: Vercel KV (or Upstash Redis) keyed by `orgId`, storing the last briefing's insights as a JSON blob with a 24h TTL. ~$5/month, ~200 LOC. Moves the architecture from "no durable storage" to "one durable cache" without becoming a database app. Postgres is correct only when relational features (history × users × shares with joins) actually exist.

→ see `02-oauth-boundary.md` for the encrypted-cookie mechanism + why Tier 5 is the load-bearing decision · `study-database-systems` is mostly N/A for this repo (no DB engine internals to teach) · `study-data-modeling/` for the `Insight`/`Anomaly`/`Diagnosis`/`Recommendation` schema shapes.

---

## failure-handling-and-reliability

Eight handled paths, one missing. Each handler is small (3–20 lines) and matched to one specific failure mode.

Handled:

1. **Bloomreach rate limit** (`lib/mcp/client.ts` L121–L132). McpClient parses the "Retry after ~N seconds" hint from the 429 body, sleeps `hint + 500ms`, retries — bounded by `maxRetries=3`, each wait capped at `retryCeilingMs=20s`. Silently invisible to the user. **The load-bearing failure handler.**
2. **Transport throw** (network, 5xx). `SdkTransport` captures the HTTP error body and re-throws as `McpToolError`; no retry. Surfaces to the model as `tool_result.is_error: true`.
3. **Agent output non-JSON / wrong shape.** Three-stage graceful degrade: `tryParse → synthesize() → FALLBACK`. The dedicated `synthesize()` call (e.g., `lib/agents/diagnostic.ts` L87–L126) is a *separate* tool-less Anthropic call that hands the model the gathered evidence and asks for the structured shape only. MonitoringAgent uses a lighter `parse → []` (no synthesize).
4. **Route setup error (before stream opens).** Returns JSON 401 (`needsAuth + authUrl`) or 500 with the real message — the wire is still negotiable.
5. **Route mid-stream error.** Emits NDJSON `{type:'error', message}` and closes the controller cleanly. The wire format is committed once the stream opens.
6. **Client one-shot reconnect.** `bi:reconnecting` sessionStorage flag (`app/page.tsx` L410–L427) prevents infinite reconnect loops on persistent 401s.
7. **`useInvestigation` deliberately doesn't cancel on cleanup** (`lib/hooks/useInvestigation.ts` L31–L36). A correctness choice for StrictMode — cancelling would corrupt the trace. The cost: a mid-investigation navigate-away wastes Anthropic/MCP budget.
8. **Tampered/corrupt `bi_auth` cookie.** `decryptStore` catches the GCM tag mismatch and returns `{}` → `connectMcp` returns `{ok:false, authUrl}` → user re-auths. **Fail open to re-auth, not closed to error.**

**Not handled.** No circuit breaker anywhere. If Bloomreach is fully down for 5 minutes, every request burns 3 retries × ~12s = ~36s before failing. Fine at 1 user; costly at 10+ concurrent. ~50 LOC fix in `lib/mcp/client.ts`. Also missing: Anthropic-specific retry beyond SDK defaults; partial-investigation persistence on failure.

The principle: name your failures one by one, give each a handler whose shape matches the failure's shape. Different failures need different handlers; one global "catch and crash" is the wrong answer.

→ see `04-caching-and-rate-limiting.md` for the McpClient retry mechanism in mechanism-level depth · `06-multi-agent-orchestration.md` for the forced-final + synthesize fallback pattern · `02-oauth-boundary.md` for the fail-open-to-re-auth contract · `08-schema-gated-coverage.md` for failure *prevention* (the gate stops the agent from spending budget on impossible categories).

---

## scale-bottlenecks-and-evolution

Three ceilings, fixed order.

- **Ceiling 1 — concurrent users sharing one instance (~10x).** `lib/state/insights.ts` L4 holds one *global* `Map` per Vercel instance; `putInsights.clear()` (L36) is correct for one user but wipes another's data when two land on the same warm instance. User-visible as feed flicker or investigation 404. **Fix:** key the Map by `sessionId` (~30 LOC, no infra change, no UX change). The session id is already present via `getOrCreateSessionId`. This is the only correctness issue in the entire audit and the smallest meaningful fix.
- **Ceiling 2 — 300s route budget vs rate-limit retry pressure (~100x).** Typical combined run is ~70–120s; headroom (~180s) evaporates when Bloomreach is slow + 2 retries land in one investigation. Each retry costs ~12s; at 3 retries × `maxRetries`, a single tool call can burn 36s. **Fix (short-term):** circuit breaker on McpClient (~50 LOC, no external dep). **Fix (long-term):** async worker — POST returns 202 + stream URL, worker runs the agent with no 300s ceiling. Bigger move (queue + durable in-progress state) but removes the budget ceiling entirely.
- **Ceiling 3 — product-shape ceiling (any scale + feature ask).** Three capabilities the architecture can't support: "yesterday's anomalies," "share this feed with my team," "audit who saw what." Each requires durable storage for derived data. **Smallest fix:** Vercel KV keyed by `orgId` (~$5/month). Postgres only when relational features actually exist.

The Bloomreach rate limit doesn't *multiply* with users — it's per-user globally. Each user has their own 1 req/s budget. Adding users doesn't tighten any one user's budget. The 300s budget isn't compute-bound either — the agent layer's CPU work is tiny; latency is all waiting on MCP and Anthropic. Vertical scaling (bigger Vercel function) buys nothing.

**What stays stable across all three migrations.** `McpClient`, `runAgentLoop`, the four agent classes, the NDJSON wire format, the schema-gated coverage, the OAuth provider with PKCE+DCR. The lower bands don't change with scale; only the upper bands (state, route, UI) evolve.

→ see `04-caching-and-rate-limiting.md` for the McpClient mechanism (and the cross-instance gap in its spacing) · `08-schema-gated-coverage.md` for the gate that prevents wasted budget on unsupported categories · `02-oauth-boundary.md` for the encrypted-cookie pattern that enables horizontal scaling.

---

## system-design-red-flags-audit

Twelve patterns evaluated against this codebase. Severity is graded against THIS architecture's actual failure modes, not textbook worst-case.

**FIRES (5, ranked).**

1. **In-memory state in a serverless world** — CRITICAL. `lib/state/insights.ts` L4. Same finding as Ceiling 1 above. ~30 LOC fix.
2. **Retry budget vs route budget (no circuit breaker)** — HIGH. `lib/mcp/client.ts` L121–L132 + `app/api/agent/route.ts` L20. Same finding as Ceiling 2. ~50 LOC fix.
3. **No observability on the 300s ceiling** — HIGH. No `console.time`-style instrumentation; no OpenTelemetry; no structured log emission with phase timings. The day a request hits the wall, no signal which phase ate the time. ~20 LOC of `performance.now()` pairs around schema bootstrap / coverage gate / each agent run. *Add this before the first production incident.*
4. **Schema cache no TTL** — MEDIUM. `lib/mcp/schema.ts` L131. Brittle when a customer adds a new event type and the instance stays warm. ~10 LOC TTL + `force=true` query param.
5. **Fetch can't be cancelled** — LOW. `lib/hooks/useInvestigation.ts` L31–L36. Deliberate (StrictMode correctness). Cost is wasted Anthropic/MCP budget on mid-stream navigate-away. ~15 LOC AbortController on Next router events would fix it.

Plus two LOW fires: per-call retry budget is not global (subset of #2's fix); dev-only FS persistence is fragile (~5 LOC console.warn on FS write failure).

**DOESN'T FIRE — PRAISE (4).** Distributed monolith (this is a clean monolith). Cargo-cult queues (no queue we don't need). God object (4 small agent classes + one deep `runAgentLoop`). Distributed transactions (no DB, tool surface is read-only by construction). Each praise row names a discipline the next contributor could accidentally undo — keep them visible.

**N/A (1).** Sticky sessions — by design we DON'T need them; `bi_auth` cookie carries OAuth state across instance hops.

**Top-3 fix list, ordered by leverage.** (1) Session-key the insights Map (correctness, ~30 LOC, ~10x trigger). (2) Minimal observability (~20 LOC, diagnostic, first incident). (3) Circuit breaker (~50 LOC, scale, ~100x trigger). Total ~100 LOC, no external services, eliminates the top three risks.

The principle: rank by *who-feels-it-first*, not by *book-says-it's-bad*. "Critical" in the abstract (no circuit breaker!) might be HIGH not CRITICAL here because the load doesn't justify it; "obscure" in the abstract (in-memory Map on serverless) is CRITICAL here because it fires at 10 users.

---

## Top 3 ranked findings

1. **Session-key the insights `Map`** — `lib/state/insights.ts` L4, L30–L42 — change `Map<id, Insight>` to `Map<sessionId, Map<id, Insight>>`; thread `sessionId` (already present via `getOrCreateSessionId`) through `putInsights` / `getInsight` / `listInsights` and 3 call sites. ~30 LOC; eliminates the only correctness bug at any current scale.
2. **Add minimal phase-timing observability** — `app/api/briefing/route.ts` L17 and `app/api/agent/route.ts` L20 — add `const t0 = performance.now()` pairs around schema bootstrap, coverage gate, each agent run; emit `console.log({ route, phase, durationMs, sessionId, complete })` on `done`. ~20 LOC; makes the next production incident actually diagnosable.
3. **Circuit breaker on `McpClient`** — `lib/mcp/client.ts` (new state on the class) — track consecutive 5xx per tool; after 5 in a row, open the circuit for 30s and fail fast; close on first success. ~50 LOC, no external dependency; prevents a Bloomreach outage from eating the 300s budget on every concurrent request.
