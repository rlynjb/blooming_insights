# Project context

**blooming insights** — a Next.js multi-agent AI analyst for a Bloomreach Engagement workspace, built on the loomi connect MCP server. It runs the loop a human data analyst runs — **what changed → why → what to do** — and streams the agents' reasoning to the UI as a first-class surface, so the user sees not just the answer but how it was reached (which queries, which numbers, which hypotheses).

The workspace under analysis is **ecommerce on Bloomreach Engagement** (project "wobbly-ukulele"): customers, event streams, revenue, and catalogs. There are no saved dashboards/funnels — every metric is computed ad-hoc with EQL, so the agents decide what to query.

---

## Business value (what this is for)

A marketer/analyst on Bloomreach normally has to notice a metric moved, hunt for the cause, and figure out which Bloomreach feature to reach for. blooming insights does that proactively and end-to-end:

1. **Monitoring** — detects significant recent changes (anomalies) in the workspace's ecommerce metrics, ranks them by severity, and states **why each matters** for the business.
2. **Diagnosis** — for any anomaly, investigates the cause: forms and tests hypotheses against the data, cites evidence, and sizes the affected customer segment.
3. **Decision** — proposes concrete Bloomreach actions (scenario / segment / campaign / voucher / experiment) with steps, a confidence level, and an **expected impact**.

Every conclusion carries provenance: the exact tool calls / EQL it ran, the current-vs-prior numbers behind a change, and a streamed log of the agent's thinking. The product's pitch is "an analyst that shows its work."

## The data the business analyzes

All ad-hoc via EQL through the MCP server (`execute_analytics_eql`); no pre-built reports.

- **Events:** `purchase`, `view_item`, `cart_update`, `checkout`, `session_start`, etc. (counts over windows).
- **Revenue:** `sum event purchase.total_price`.
- **Funnel:** view → cart → checkout → purchase conversion rates.
- **Traffic:** `session_start` volume.
- **Segments:** breakdowns by `customer.country` (only when a global change is large enough to localize).
- **Method:** period-over-period on **90-day windows** (current 90d vs prior 90d, derived from 90d & 180d) — short windows hit the dataset's sparse tail and produce bogus ±100% swings, so 90d is enforced. Metrics surface as `Anomaly`s (metric, scope, % change + direction, severity, evidence, impact).

---

## The product / UI — the main artifact

Three stages, shown as a shared **`ProcessStepper`** (monitoring anomalies → investigating the issue → decision & recommendation) that reads identically across pages; the stepper steps are clickable links, and the **current** step stays `active` (never ✓) while the user is on it. Width is `max-w-5xl` on every page. Dark mode only.

### Feed — `app/page.tsx`
- **Header:** "blooming insights / your workspace, in bloom" + the live workspace stats (project name · customer count).
- **Demo / live toggle** (persisted in `localStorage` `bi:mode`, default **demo**): demo replays a committed snapshot instantly (no auth); live runs the agents against Bloomreach.
- **Two-column layout** (matches the investigate pages):
  - **Col 1 (2/3):** the anomaly cards (`InsightCard`), or loading skeletons / empty / a real server-error panel (with a reconnect button on auth errors).
  - **Col 2 (1/3):** **`StatusLog`** — a sticky sidebar that streams the monitoring agent's statuses/logs in real time ("how this briefing was gathered") with query count, an indeterminate progress bar + pulsing dots while running.
- **`QueryBox`** (fixed bottom): free-form "ask anything about your workspace" Q&A — live only; shown but inert in demo with a "switch to live to use" placeholder.
- **Dev-only one-click capture** ("capture this as the demo snapshot"): runs the live briefing + each investigation and writes `lib/state/demo-*.json`.
- **Auto-reconnect:** the alpha MCP server revokes tokens after minutes; on an `invalid_token` error the feed resets auth and reloads once (guarded).

### `InsightCard` — `components/feed/InsightCard.tsx`
Each anomaly card shows: severity dot + **headline** (e.g. `usa purchase_revenue · -38.4%`) → the agent **summary** → **why it matters** (agent-written business impact, with a derived fallback) → **scope** (why global vs a country segment) → a **prior → now comparison** (real current/prior bars from the evidence, else indexed from the real %, with a `--` placeholder when absolute numbers aren't captured) → **via &lt;tool&gt;** (the MCP tool that gathered it). Clicking a card stashes the insight and opens its investigation.

### Investigate — two pages by step
- **Step 2 — `app/investigate/[id]/page.tsx`** ("investigating the issue"): runs the **diagnostic agent only** — the decision is **not** run here. Col 1: an **`InvestigationSubject`** banner (which feed item this is about) above the **`EvidencePanel`** (diagnosis conclusion, affected-customers callout, evidence list, collapsible hypotheses) and a **"see recommendations →"** button. Col 2: `StatusLog` streaming the diagnostic trace.
- **Step 3 — `app/investigate/[id]/recommend/page.tsx`** ("decision & recommendation"): runs the **recommendation agent** with the diagnosis handed over from step 2. Col 1: the subject banner above the **`RecommendationCard`**s (feature chip, confidence dot, title, rationale, numbered steps, and a **highlighted "expected impact"** callout). Col 2: `StatusLog`.
- Both: navigable stepper, markdown **export ↓**, and reconnect-on-auth.

### Shared streaming surface
- **`StatusLog`** (`components/shared/StatusLog.tsx`) wraps **`ReasoningTrace`** (`components/investigation/ReasoningTrace.tsx`) — agent badge + step kind + content + **timestamp** per line, and **`ToolCallBlock`**s (status dot, tool name, duration, expandable JSON result). The same panel appears on the feed and both investigate steps.

---

## Stack
- **Runtime / framework:** Next.js 16 (App Router), React 19, TypeScript. Deployed to Vercel (Pro; `maxDuration = 300` on `/api/briefing` and `/api/agent`). `reactStrictMode` is on (Next default).
- **AI:** `@anthropic-ai/sdk` — agents run `claude-sonnet-4-6`; intent classifier `claude-haiku-4-5-20251001`.
- **MCP:** `@modelcontextprotocol/sdk` — `StreamableHTTPClientTransport` + an `OAuthClientProvider` (PKCE + Dynamic Client Registration) to the Bloomreach loomi connect server (`https://loomi-mcp-alpha.bloomreach.com/mcp`).
- **Streaming:** newline-delimited JSON (NDJSON) over `ReadableStream`, consumed in the browser via `fetch` + a stream reader (not `EventSource`).
- **Styling:** Tailwind v4 (CSS-first) + CSS custom-property design tokens; custom keyframes in `globals.css` (`bi-fade-up`, `bi-progress` indeterminate bar, `bi-dots` loader); dark mode only.
- **Tests:** Vitest (144 tests; pure logic + agent loops TDD'd with injected fakes — no network).
- **No database:** state lives in in-memory maps; in dev, auth + investigations persist to gitignored JSON (`.auth-cache.json`, `.investigation-cache.json`); committed demo snapshots in `lib/state/demo-*.json`.

## Data model (`lib/mcp/types.ts`)
- `Severity` = critical | warning | info | positive.
- `Insight` { id, timestamp, severity, headline, summary, metric, change{value,direction,baseline}, scope[], source, evidence?[{tool,result}], impact? }.
- `Anomaly` { metric, scope[], change, severity, evidence[], impact? } — monitoring agent output.
- `Diagnosis` { conclusion, evidence[], hypothesesConsidered[{hypothesis,supported,reasoning}], affectedCustomers? } — diagnostic agent output.
- `Recommendation` { id, title, rationale, bloomreachFeature: scenario|segment|campaign|voucher|experiment, steps[], estimatedImpact, confidence } — recommendation agent output.
- `ToolCall`, `ReasoningStep`, `AgentName` = coordinator|monitoring|diagnostic|recommendation.
- `AgentEvent` (`lib/mcp/events.ts`) — the NDJSON streaming contract: reasoning_step | tool_call_start | tool_call_end | insight | diagnosis | recommendation | done | error.
- `WorkspaceSchema` (`lib/mcp/schema.ts`) { projectId, projectName, events[], customerProperties[], catalogs[], totalCustomers, totalEvents, oldestTimestamp }.
- `TraceItem` (`components/investigation/ReasoningTrace.tsx`) — the UI trace shape: step | tool, each with optional `ts` (timestamp).

## Architecture / file structure
- **`app/api/`** — `briefing/` (monitoring scan → insights, NDJSON), `agent/` (NDJSON: investigation + free-form query; takes `step=diagnose|recommend|null`, where null = combined run used by the capture; bootstraps inside the stream; replays the demo snapshot filtered to the step; caches the combined run), `mcp/{callback,reset,call,tools,tools/check,capture,capture-demo}/`.
- **`lib/mcp/`** — `auth.ts` (`OAuthClientProvider` + AES-256-GCM encrypted-cookie store via `AsyncLocalStorage` in prod / file in dev), `connect.ts` (`connectMcp`/`completeAuth`, host-based `redirect_uri`), `client.ts` (`McpClient`: cache + ~1 req/s rate-limit + retry), `transport.ts` (`SdkTransport` + capturing fetch for raw error bodies), `schema.ts`, `validate.ts`, `events.ts`, `tools.ts`, `session.ts`, `tool-coverage.ts`, `types.ts`.
- **`lib/agents/`** — `base.ts` (`runAgentLoop` — shared Claude+MCP tool-use loop), `monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`, `intent.ts`, `tool-schemas.ts`, `prompts/*.md`.
- **`lib/state/`** — `insights.ts`, `investigations.ts` (+ committed `demo-insights.json`, `demo-investigations.json`).
- **`lib/hooks/useInvestigation.ts`** — client hook that runs one investigation step, streams its trace/diagnosis/recommendations, and stashes the result in `sessionStorage` (so step 3 and back-nav hydrate instantly; survives StrictMode by NOT cancelling the in-flight fetch on cleanup). **`lib/export/investigationMarkdown.ts`** — shared markdown export.
- **`components/`** — `feed/` (InsightCard, SeverityBadge), `investigation/` (EvidencePanel, RecommendationCard, ReasoningTrace, ToolCallBlock, InvestigationSubject), `chat/` (QueryBox, StreamingResponse), `shared/` (ProcessStepper, StatusLog, AgentBadge, Skeleton).

## Demo vs live (presentation reliability)
- **Demo** (default): `?demo=cached` serves the committed snapshot as plain JSON; investigations replay the committed events (filtered per step). Instant, no auth — the reliable presentation path. Cards/logs/comparison/impact all render from real captured data, with `--` placeholders where a field wasn't captured.
- **Live:** runs the agents against Bloomreach. The alpha server is rate-limited (~1 req/s) and **revokes tokens after minutes**, so live is recovery-oriented (auto-reconnect) — capture a fresh snapshot locally and commit it for the demo.

## What must not change
- The `AgentEvent` NDJSON contract (route producers + UI consumers depend on it).
- `McpClient` return shape `{ result, durationMs, fromCache }` and its no-cache-on-error / rate-limit-retry behavior.
- The `OAuthClientProvider` conformance + the prod encrypted-cookie / dev-file auth store split.
- The MCP result envelope handling (prefer `structuredContent`, else `content[0].text`).
- Tool calls must always carry `project_id`; respect the ~1 req/s limit.
- `Insight` / `Anomaly` / `Diagnosis` / `Recommendation` field names (UI + demo snapshots + validators depend on them); new fields stay optional so older snapshots still validate.
- The demo snapshot keys (`insights`, `workspace`, `trace`) and the per-step replay filter (events tagged by `agent`).
