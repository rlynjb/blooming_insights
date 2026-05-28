# blooming insights — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Next.js 15 multi-agent AI analyst that watches a Bloomreach Engagement workspace over the loomi connect MCP server and answers "what changed, why, and what should I do" with a transparent, streamed reasoning trace.

**Architecture:** A coordinator agent orchestrates three Claude-powered specialists (monitoring → diagnostic → recommendation). All data access flows through a single `McpClient` (cache + rate limit) talking to the remote loomi connect MCP server over OAuth. The browser consumes agent output as a stream of `AgentEvent` messages (SSE), rendering reasoning steps and tool calls live. No database — insights and sessions live in in-memory maps for the session.

**Tech Stack:** Next.js 15 (app router), TypeScript, Tailwind CSS, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, Server-Sent Events, Vercel deploy. Tests: Vitest.

---

## Build status & corrections (updated 2026-05-27)

Phase 1 has been implemented. A few things diverged from the original plan text below — **Phases 2–6 should use the corrected API surface here, not the older snippets further down.**

**Stack deviations (deliberate, accepted):**
- **Next.js 16.2.6** (not 15), **Tailwind v4** (CSS-first, no `tailwind.config.js`), **React 19**. All app-router patterns in this plan are compatible.
- Fonts load via **`next/font/google`** (Syne, Inter, JetBrains Mono) — no `public/fonts/` dir.

**Auth is SDK-driven OAuth (the plan's hand-rolled `buildAuthorizeUrl`/`exchangeCodeForToken`/`startAuthFlow`/`getSession(token)` model is OBSOLETE).** Verified against the official sample + live discovery probes: Bloomreach uses **OAuth 2.0 Authorization Code + PKCE with Dynamic Client Registration** (no pre-registered `client_id`, no `client_secret`; endpoints auto-discovered via RFC 8414). The MCP SDK drives the whole flow. Actual implemented surface:

- `lib/mcp/auth.ts` — `BloomreachAuthProvider implements OAuthClientProvider`, persistence keyed by app session id in an in-memory `authStore`. Helpers: `hasTokens(sid)`, `clearAuth(sid)`, `consumeState(sid, state)`, `_clearAuthStore()`.
- `lib/mcp/connect.ts` — **`connectMcp(sessionId): Promise<ConnectResult>`** where `ConnectResult = { ok: true; mcp: McpClient } | { ok: false; authUrl: string }`; and **`completeAuth(sessionId, code)`** (calls `transport.finishAuth`). MCP URL has its trailing slash stripped (avoids a 307). Uses `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js` with `{ authProvider }`.
- `lib/mcp/session.ts` — `getOrCreateSessionId()` / `readSessionId()` (cookie `bi_session`). **Phases 2+ must obtain `sessionId` from these and call `connectMcp(sessionId)`** — there is no `getSession(token)` and no bearer token threading.
- Routes: `app/api/mcp/callback/route.ts` (handles `?error`, validates `state`), `app/api/mcp/call/route.ts` (generic tool caller used by `/debug`).

**Tool listing resolved & implemented:** the `__list_tools__` placeholder is really **`client.listTools()`** → `{ tools: [{ name, title, description, inputSchema, outputSchema }] }`. This is now wired: `McpClient.listTools()` (passthrough via `McpTransport`/`SdkTransport`) + a `GET /api/mcp/tools` route + a "list tools" button on `/debug`.

**MCP tool reality (verified live via listTools, 2026-05-27) — this rewrites the Phase 2 schema bootstrap:**
- **Navigation/bootstrap chain (the spec's `bootstrapTools` was incomplete):**
  ```
  list_cloud_organizations   {}                         -> { data: [{ id, name }] }      (NO args; this is the real entry point)
  list_projects              { cloud_organization_id }  -> { data: [{ id, name, category, workspace_id, workspace_name }] }
  <all other Engagement tools> { project_id, ... }
  ```
  `whoami` returns only `{ client_id, scopes, email, access_token }` — it does NOT contain `cloud_organization_id`. Optional middle step: `list_workspaces({cloud_organization_id})`. Shortcut for the feed: `list_projects_with_overview({cloud_organization_id})` returns projects + KPI snapshots in one call.
- **EVERY Engagement data tool requires `project_id` as a required input field.** So `bootstrapSchema` must resolve and cache `cloud_organization_id` + `project_id`, and **every agent must pass `project_id` on every tool call.** Put the resolved `project_id` in `WorkspaceSchema` and inject it into each agent's system prompt with an explicit instruction to pass it to every tool. (`BLOOMREACH_PROJECT_ID` env can seed/override the project selection.)
- **Tool-name corrections for `bootstrapSchema`:** use `get_event_schema({project_id})` → `{ events: [{ type, name, source, used, properties: { default_group: { properties: [...] }}}] }`; use **`get_customer_property_schema({project_id})`** (NOT `get_customer_schema`) for customer properties → `{ properties: [{ property, type, source, used }] }`. `get_customer_schema` is the *identifier* schema (registered/cookie, hard/soft). Catalogs: `list_catalogs({project_id})` → `{ data: [{ _id, name, display_name, type }] }`.
- **Result envelope:** tools return `{ isError, content: [{ type:'text', text }], structuredContent }`. Read **`structuredContent`** — shape `{ success: bool, data | events | properties | policies | campaigns, error: string|null }`. Phase 2 parsers should consume `structuredContent`, falling back to `JSON.parse(content[0].text)`.
- Monitoring/diagnostic/recommendation tool subsets in `lib/mcp/tools.ts` are all valid (every listed tool exists). The analytical workhorse is `execute_analytics_eql({project_id, query})` (EQL). All tools are `readOnlyHint: true`.

**Rate limit (verified live) — affects the whole multi-agent design:** Bloomreach enforces **~1 request/second per user, GLOBALLY** (`"rate limit reached for key 'loomi:global:...' (1 per 1 second)"`). It is not per-connection, so parallel agents share one 1-req/s budget. `connectMcp` now builds `McpClient` with `minIntervalMs: 1100`. Implications for Phase 2+: (a) lean hard on the 60s response cache; (b) agents must be **frugal** with tool calls (a briefing of N calls takes ≥N seconds — watch the 60s Vercel `maxDuration`); (c) the spec's "parallel diagnostic calls" optimization gives little benefit (shared global limit) and the demo cached-mode matters even more; (d) **add retry/backoff on the "Too many requests" `isError` result** as Phase 2 `McpClient` hardening (TDD-able: detect `isError` + rate-limit text → wait → retry).

**`wobbly-ukulele` data shape (captured to `test/fixtures/`, 2026-05-27):** Data-rich but no saved analytics objects.
- `get_project_overview` → 1,173,252 events, 123,162 customers, oldest event 2024-01-01; `event_types_overview` gives per-type counts (purchase 27,046; purchase_item 29,369; view_item 89,717; view_category 102,201; cart_update 38,205; checkout 30,109; campaign 204,917; session_start 34,965; session_end 114,533; page_visit 55,492; return 3,931; loyalty_update 27,046; support_ticket 22,536; …).
- `get_event_schema` → **28 event types, all `used:true`** (standard ecommerce: purchase, purchase_item, view_item, view_category, cart_update, checkout, session_start/end, page_visit, campaign, consent, registration, return, loyalty_update, support_ticket, store_visit, survey, experiment, banner, retargeting, …), each with a `properties.default_group.properties[]` schema. ~112KB fixture.
- `get_customer_property_schema` → 9 customer properties. `get_customer_schema` → identifiers `registered` (hard), `cookie` (soft), `google_analytics` (soft).
- `list_dashboards`, `list_funnels`, `list_segmentations`, `list_catalogs` → **all empty (`data: []`)**.
- **Consequence for the monitoring agent (Task 2.5):** there are no saved dashboards/funnels/trends/segmentations to read, so the monitoring tool subset's `list_dashboards`/`get_dashboard`/`list_trends`/`get_trend`/`list_funnels`/`get_funnel` will return nothing useful here. The agent must **compute metrics ad-hoc via `execute_analytics_eql`** (period-over-period counts, conversion funnels view_item→cart_update→checkout→purchase) and `get_project_overview` for KPIs. Update `prompts/monitoring.md` to instruct EQL-first. There is enough real data that synthetic demo data may be optional (still build `?demo=cached` for resilience).

**Dev auth note:** auth state persists to a gitignored `.auth-cache.json` in development (survives Next hot-reload). The cache key equals the `bi_session` cookie value, so an authenticated session can be replayed from the shell with `curl -H "Cookie: bi_session=$SID"` (useful for capturing fixtures without the browser).

**Phase 2 status & live findings (2026-05-27):** Phase 2 is built, unit-tested (79 tests), builds clean, and verified live end-to-end (auth→MCP→schema bootstrap→monitoring agent→insights→feed). Key learnings from live runs:
- **Latency:** the agent must be hard-capped. `runAgentLoop` takes `maxToolCalls` (monitoring uses 6); a soft prompt cap was ignored (the model made 13 calls → 108s). With the enforced cap, a briefing runs in ~38s — back under the 60s Vercel budget. Each MCP call is ~1.1s (rate limit) + retries, so call count is the dominant latency lever.
- **Data recency (the main quality blocker):** the `wobbly-ukulele` sandbox has **no events in the last 7–14 days** — the data is historical/seeded. So "what changed recently" period-over-period comparisons divide near-zero by near-zero and yield spurious ±100% artifacts. The monitoring prompt now warns about this (anchor via `execute_analytics_eql`'s `execution_time` param to the data's active window; never report from empty windows; return `[]` otherwise), and `scan()` degrades gracefully to `[]` instead of crashing. **For genuinely clean LIVE insights, the real fix is to anchor the whole briefing to the data's active window** — e.g. compute the newest event timestamp at bootstrap and thread `execution_time` into every agent query, or reframe from "last 7d vs prior 7d" to "the most recent populated period." This is a design follow-up (call it Phase 2.5), not a prompt tweak.
- **Demo path:** `?demo=cached` serves `lib/state/demo-insights.json` (a snapshot from a real run) instantly — the reliable path for a live demo, and it sidesteps both the latency and the stale-data issues. The current snapshot's numbers are stale-data artifacts (illustrative of the UI, not real anomalies).
- **Diagnostics:** `/api/briefing` returns a `trace` (each tool call's name/args/ok/error) — invaluable for debugging agent behavior; consider gating it behind a debug flag before production.

**Phase 3 status (2026-05-27):** Built and verified live — clicking a feed card opens `/investigate/[id]`, which streams the diagnostic agent's reasoning over NDJSON (`/api/agent`) and renders it live (reasoning thoughts + collapsible EQL tool calls with timings + diagnosis). Coordinator abstraction skipped for now — `/api/agent` runs the diagnostic agent directly (coordinator/query-routing deferred to Phase 5). Anomaly resolution falls back to `demo-insights.json` so cached-feed clicks work. Streaming infra: `lib/mcp/events.ts` (AgentEvent + NDJSON codec), `runAgentLoop` `onText`/`onToolResult` hooks. Verified live: 18 events in ~42s (6 EQL calls), graceful end.
- **Conclusion quality — RESOLVED (commit `4d9a0f8`):** added a **dedicated tool-less synthesis step** to the diagnostic agent (and a `synthesisInstruction` to `runAgentLoop`'s forced-final turn) — after the investigation loop, if no valid `Diagnosis` was emitted, a focused call hands the model the evidence it already gathered and asks for ONLY the JSON. Verified live: real grounded conclusion ("USA revenue −58.3%, $115,849→$48,317, USA-specific" with 7 evidence items + 5 hypotheses). Also forbade the unsupported `customers matching` EQL clause in the prompt.

**Phase 4 status (2026-05-27):** Built and verified live. The recommendation agent (`lib/agents/recommendation.ts`, same injectable + dedicated-synthesis + graceful pattern; `maxToolCalls: 4`) proposes ≤3 actions grounded in Bloomreach features (scenario/segment/campaign/voucher/experiment), validated by `isRecommendationArray` (id assigned post-validation). `/api/agent` now streams diagnosis → then runs the recommendation agent → emits one `recommendation` event each (with agent-attributed `tool_call_*`/`reasoning_step` events via `hooksFor('recommendation')`), then `done`. The investigation view renders `RecommendationCard`s in the right column. Verified live: 3 recommendations (segment/campaign/scenario) with rationale + steps + impact + confidence.
- **LATENCY is now the top deploy blocker:** a full live investigation (diagnostic + recommendation, back-to-back, each ~capped tool calls @ ~1.1s + dedicated synthesis) took **~115s** — well over Vercel's 60s `maxDuration`. It streams progress so it's watchable locally, but for a deployable/snappy demo the fix is to **cache investigations** (snapshot diagnosis + recommendations per insight id, like `demo-insights.json`; serve cached-first, regenerate in the background). This is the highest-value next infra task. Secondary levers: run diagnostic + recommendation concurrently is NOT possible (recommendation needs the diagnosis), but the recommendation agent rarely needs tool calls (it reasons from the diagnosis) — consider `maxToolCalls: 1–2` to trim its latency.

**Env (`.env.example`, committed):** `ANTHROPIC_API_KEY`, `BLOOMREACH_MCP_URL`, `NEXT_PUBLIC_APP_NAME`, `APP_ORIGIN`. No `BLOOMREACH_CLIENT_ID`/`PROJECT_ID` (DCR + runtime discovery).

**Outstanding for Phase 1 acceptance (needs live Bloomreach creds — not yet done):** run the real auth round-trip on `/debug`, confirm ≥4 tools return JSON, capture response fixtures (`test/fixtures/*.json`) for the Phase 2 schema parser, and deploy a Vercel preview. The OAuth flow is written to the documented SDK behavior but has **not** been exercised against live auth — see the `LIVE-VERIFICATION` block atop `connect.ts`. In-memory `authStore` works per-process (fine locally); a shared store (KV/Redis) is needed before multi-instance/serverless deploy.

---

## Testing strategy (read first)

This build straddles two worlds, and the plan tests each differently:

- **Pure logic → TDD with Vitest.** Cache TTL/eviction, the rate limiter, schema parsing, intent classification, `AgentEvent` (de)serialization, and JSON-result validation are deterministic. Write the failing test first, then the code. The `McpClient` takes an injectable transport so the underlying MCP `Client` can be faked in tests.
- **Live integration → manual verification via `/debug` + Vercel preview.** OAuth, real MCP tool calls, the Claude tool-use loops, and SSE streaming depend on external services whose response shapes are only known at runtime. These are verified against the spec's own acceptance criteria on a deployed preview, not unit-mocked. Mocking unknown MCP response shapes would fabricate false confidence.

Where a phase says "verify (manual)", the engineer runs the app/preview and confirms the stated acceptance criterion. Where it says "Run: `npx vitest ...`", expect a real pass/fail.

**Why response shapes are deferred:** Phase 1 produces the `/debug` page specifically so the real shapes of `whoami`, `get_project_overview`, `get_event_schema`, etc. can be captured. Phases 2+ parse those shapes. Tasks that depend on a real shape say so explicitly and instruct capturing a fixture during Phase 1 — that fixture then drives a TDD parser test. This is not a placeholder; it is sequencing parsing work behind the discovery that must precede it.

---

## File structure

Created/modified across the plan, by responsibility:

```
/app
  layout.tsx                    # fonts, design tokens, dark shell           [P1]
  page.tsx                      # insight feed homepage                      [P2]
  globals.css                   # tailwind + token CSS vars                  [P1]
  /debug/page.tsx               # manual MCP tool caller (dev harness)       [P1]
  /investigate/[id]/page.tsx    # deep-dive view (3-col)                     [P3]
  /api
    /mcp/callback/route.ts      # oauth redirect handler                     [P1]
    /briefing/route.ts          # morning briefing generation                [P2]
    /agent/route.ts             # sse endpoint: investigate + query          [P3,P5]

/components
  /feed/InsightCard.tsx         # one insight card                           [P2]
  /feed/SeverityBadge.tsx       # severity dot/shape                         [P2]
  /investigation/ReasoningTrace.tsx   # timeline of steps                    [P3]
  /investigation/ToolCallBlock.tsx    # collapsible tool call                [P3]
  /investigation/EvidencePanel.tsx    # diagnosis + evidence                 [P3]
  /investigation/RecommendationCard.tsx                                      [P4]
  /chat/QueryBox.tsx            # fixed-bottom query input                   [P5]
  /chat/StreamingResponse.tsx   # progressive text render                    [P5]
  /shared/AgentBadge.tsx        # which agent produced what                  [P3]
  /shared/Skeleton.tsx          # animate-pulse loaders                      [P2]

/lib
  /mcp
    types.ts                    # Insight, ToolCall, ReasoningStep, etc.     [P1]
    events.ts                   # AgentEvent type + encode/decode for sse    [P3]
    transport.ts                # McpTransport interface + real impl         [P1]
    client.ts                   # McpClient: callTool + cache + rate limit   [P1]
    auth.ts                     # oauth flow, in-memory session map          [P1]
    session.ts                  # cookie<->session id helper                 [P1]
    tools.ts                    # typed tool-name subsets per agent          [P1]
    schema.ts                   # bootstrap workspace schema discovery       [P2]
    validate.ts                 # validate/parse tool results & agent json   [P2]
    demo-cache.ts               # cached tool responses for ?demo=cached     [P2]
  /agents
    base.ts                     # shared Claude tool-use loop helper         [P2]
    monitoring.ts               # specialist 1                               [P2]
    diagnostic.ts               # specialist 2                               [P3]
    recommendation.ts           # specialist 3                               [P4]
    coordinator.ts              # orchestrator (briefing/investigate/query)  [P2,P5]
    intent.ts                   # query intent classifier                    [P5]
    prompts/
      monitoring.md  diagnostic.md  recommendation.md  coordinator.md        [per phase]
  /state
    insights.ts                 # in-memory insight + investigation cache    [P2]
  /design
    tokens.ts                   # colors, fonts, spacing                     [P1]

/test                           # vitest specs mirror /lib paths
/public/fonts                   # Syne, JetBrains Mono, Inter                [P1]
vitest.config.ts                                                            [P1]
```

`[Pn]` = phase the file first lands in. Files that change together (mcp client + transport + auth; each agent + its prompt) live together.

---

# Phase 1 — Foundation

**Goal:** Prove the MCP connection end-to-end: authenticate against Bloomreach and render real JSON from ≥4 MCP tools on a deployed Vercel preview.

**Acceptance:** From a deployed Vercel preview you can authenticate with Bloomreach and see a JSON response from at least 4 MCP tools (`whoami`, `list_projects`, `get_project_overview`, `list_dashboards`) on `/debug`.

---

### Task 1.1: Scaffold the Next.js app

**Files:**
- Create: project root files via scaffolder
- Modify: `package.json`, `tsconfig.json`

- [ ] **Step 1: Scaffold**

Run from a temp dir and move contents in, since the repo already has files (the spec + `docs/`). To avoid clobbering, scaffold into a subfolder then move:

```bash
cd /Users/rein/Public/blooming_insights
npx create-next-app@latest .app-scaffold \
  --typescript --tailwind --app --eslint \
  --src-dir false --import-alias "@/*" --use-npm --no-turbopack
```

- [ ] **Step 2: Merge scaffold into repo root**

```bash
cd /Users/rein/Public/blooming_insights
# move everything except node_modules and .git
rsync -a --exclude node_modules --exclude .git .app-scaffold/ ./
rm -rf .app-scaffold
npm install
```

- [ ] **Step 3: Verify dev server boots**

Run: `npm run dev` then open `http://localhost:3000`
Expected: Next.js default page renders, no errors in terminal.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold next.js 15 app router + tailwind + ts"
```

---

### Task 1.2: Install dependencies and Vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install runtime + test deps**

```bash
npm install @anthropic-ai/sdk @modelcontextprotocol/sdk
npm install -D vitest
```

- [ ] **Step 2: Add vitest config**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Add test script**

In `package.json` `"scripts"`, add: `"test": "vitest run"`.

- [ ] **Step 4: Verify vitest runs (no tests yet)**

Run: `npx vitest run`
Expected: "No test files found" — exits 0. Tooling is wired.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add anthropic + mcp sdks and vitest"
```

---

### Task 1.3: Design tokens, fonts, dark shell

**Files:**
- Create: `lib/design/tokens.ts`
- Create: `public/fonts/` (Syne, JetBrains Mono, Inter — woff2)
- Modify: `app/globals.css`, `app/layout.tsx`

- [ ] **Step 1: Tokens**

```ts
// lib/design/tokens.ts
export const colors = {
  bg: { base: '#0f1923', surface: '#1a2332', elevated: '#243040', border: '#2d3a4d' },
  text: { primary: '#e8edf2', secondary: '#8b9bb0', tertiary: '#5a6878' },
  accent: { teal: '#00d9a3', coral: '#fb7185', amber: '#fbbf24', purple: '#a78bfa' },
} as const;

export const fonts = { display: 'Syne', body: 'Inter', mono: 'JetBrains Mono' } as const;
```

- [ ] **Step 2: Expose tokens as CSS vars + base styles**

In `app/globals.css`, after the tailwind imports, add a `:root` block defining `--bg-base`, `--bg-surface`, `--bg-elevated`, `--border`, `--text-primary`, `--text-secondary`, `--text-tertiary`, and the four accent vars, mapped to the hex values above. Set `body { background: var(--bg-base); color: var(--text-primary); font-family: Inter, sans-serif; }`. Add a base rule capping border radius: `*:where(button, input, .card) { border-radius: 4px; }`.

- [ ] **Step 3: Load fonts and dark shell in layout**

In `app/layout.tsx`: load the three fonts via `next/font/local` from `public/fonts/`, set `<html lang="en" className="dark">`, apply the body font class. Title from `process.env.NEXT_PUBLIC_APP_NAME`.

- [ ] **Step 4: Verify (manual)**

Run: `npm run dev`, open `/`
Expected: dark navy background, light text, fonts applied. (Default page content is fine; styling is what we check.)

- [ ] **Step 5: Commit**

```bash
git add lib/design/tokens.ts app/globals.css app/layout.tsx public/fonts
git commit -m "feat: design tokens, fonts, dark shell"
```

---

### Task 1.4: Core types

**Files:**
- Create: `lib/mcp/types.ts`

- [ ] **Step 1: Port the data model verbatim from the spec**

Copy the full type block from the spec's "data model → types" section into `lib/mcp/types.ts`: `Severity`, `Insight`, `ToolCall`, `ReasoningStep`, `Investigation`, `Recommendation`, `AgentName`. Add the agent output schemas from the agents section: `Anomaly`, `Diagnosis` (with `hypothesesConsidered: { hypothesis: string; supported: boolean; reasoning: string }[]`). Export everything.

> Reconcile the two `Recommendation` shapes in the spec: the data-model version and the recommendation-agent version differ (`steps`, `bloomreachFeature` union). Use the **richer** recommendation-agent shape as canonical:
> ```ts
> export interface Recommendation {
>   id: string;
>   title: string;
>   rationale: string;
>   bloomreachFeature: 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment';
>   steps: string[];
>   estimatedImpact: string;
>   confidence: 'high' | 'medium' | 'low';
> }
> ```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/mcp/types.ts
git commit -m "feat: core mcp/agent data model types"
```

---

### Task 1.5: MCP transport seam

**Files:**
- Create: `lib/mcp/transport.ts`

This is the injection seam that makes `McpClient` testable without a live server.

- [ ] **Step 1: Define the interface + real implementation skeleton**

```ts
// lib/mcp/transport.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

/** Minimal surface McpClient depends on. Real impl wraps the MCP SDK Client;
 *  tests provide a fake. */
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Wraps a connected MCP SDK Client. Connection/auth handled in auth.ts. */
export class SdkTransport implements McpTransport {
  constructor(private client: Client) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.client.callTool({ name, arguments: args });
    return res;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If the SDK's `callTool` signature differs in the installed version, adapt the wrapper here — this file is the only place that touches the raw SDK call shape.)

- [ ] **Step 3: Commit**

```bash
git add lib/mcp/transport.ts
git commit -m "feat: mcp transport seam (SdkTransport + interface)"
```

---

### Task 1.6: McpClient — cache + rate limit (TDD)

**Files:**
- Create: `test/mcp/client.test.ts`
- Create: `lib/mcp/client.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/mcp/client.test.ts
import { describe, it, expect, vi } from 'vitest';
import { McpClient } from '../../lib/mcp/client';
import type { McpTransport } from '../../lib/mcp/transport';

function fakeTransport(impl: (name: string) => unknown): McpTransport & { calls: number } {
  const t = {
    calls: 0,
    async callTool(name: string) { t.calls++; return impl(name); },
  };
  return t;
}

describe('McpClient', () => {
  it('returns the transport result and marks fromCache=false on a miss', async () => {
    const t = fakeTransport(() => ({ ok: 1 }));
    const c = new McpClient(t);
    const r = await c.callTool('whoami', {});
    expect(r.result).toEqual({ ok: 1 });
    expect(r.fromCache).toBe(false);
    expect(t.calls).toBe(1);
  });

  it('serves a cached result within ttl without hitting the transport', async () => {
    const t = fakeTransport(() => ({ ok: 1 }));
    const c = new McpClient(t);
    await c.callTool('whoami', {});
    const r2 = await c.callTool('whoami', {});
    expect(r2.fromCache).toBe(true);
    expect(t.calls).toBe(1);
  });

  it('caches per name+args', async () => {
    const t = fakeTransport((n) => ({ n }));
    const c = new McpClient(t);
    await c.callTool('get_trend', { a: 1 });
    await c.callTool('get_trend', { a: 2 });
    expect(t.calls).toBe(2);
  });

  it('skipCache bypasses the cache', async () => {
    const t = fakeTransport(() => ({ ok: 1 }));
    const c = new McpClient(t);
    await c.callTool('whoami', {});
    await c.callTool('whoami', {}, { skipCache: true });
    expect(t.calls).toBe(2);
  });

  it('expires cache after ttl', async () => {
    vi.useFakeTimers();
    const t = fakeTransport(() => ({ ok: 1 }));
    const c = new McpClient(t);
    await c.callTool('whoami', {}, { cacheTtlMs: 1000 });
    vi.advanceTimersByTime(1001);
    await c.callTool('whoami', {}, { cacheTtlMs: 1000 });
    expect(t.calls).toBe(2);
    vi.useRealTimers();
  });

  it('rate limits to minIntervalMs between live calls', async () => {
    vi.useFakeTimers();
    const t = fakeTransport((n) => ({ n }));
    const c = new McpClient(t, { minIntervalMs: 200 });
    const p1 = c.callTool('a', {});
    await vi.runAllTimersAsync();
    await p1;
    const start = Date.now();
    const p2 = c.callTool('b', {});
    await vi.advanceTimersByTimeAsync(199);
    let done = false;
    p2.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false); // still waiting on the 200ms floor
    await vi.advanceTimersByTimeAsync(1);
    await p2;
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/mcp/client.test.ts`
Expected: FAIL — `McpClient` not found / not constructable.

- [ ] **Step 3: Implement McpClient**

```ts
// lib/mcp/client.ts
import type { McpTransport } from './transport';

export interface CallToolOptions { cacheTtlMs?: number; skipCache?: boolean; }
export interface CallToolResult<T = unknown> { result: T; durationMs: number; fromCache: boolean; }
interface ClientOpts { minIntervalMs?: number; }

export class McpClient {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;
  private minIntervalMs: number;

  constructor(private transport: McpTransport, opts: ClientOpts = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 200;
  }

  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    options: CallToolOptions = {},
  ): Promise<CallToolResult<T>> {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
    const ttl = options.cacheTtlMs ?? 60_000;

    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result as T, durationMs: 0, fromCache: true };
      }
    }

    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }

    const start = Date.now();
    const result = await this.transport.callTool(name, args);
    const durationMs = Date.now() - start;
    this.lastCallAt = Date.now();

    this.cache.set(cacheKey, { result, expiresAt: Date.now() + ttl });
    return { result: result as T, durationMs, fromCache: false };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/mcp/client.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add test/mcp/client.test.ts lib/mcp/client.ts
git commit -m "feat: McpClient with cache + rate limit (tdd)"
```

---

### Task 1.7: Tool subsets per agent

**Files:**
- Create: `lib/mcp/tools.ts`

- [ ] **Step 1: Port the tool-name arrays from the spec**

Copy `monitoringTools`, `diagnosticTools`, `recommendationTools`, `bootstrapTools` exactly as listed in the spec's "tools per agent" section, each `as const`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/mcp/tools.ts
git commit -m "feat: per-agent mcp tool subsets"
```

---

### Task 1.8: Session helper (TDD)

**Files:**
- Create: `test/mcp/auth.test.ts`
- Create: `lib/mcp/auth.ts`
- Create: `lib/mcp/session.ts`

The in-memory session map and its expiry are pure logic and worth a test. The OAuth URL building / code exchange are integration and verified via `/debug` against the live IdP.

- [ ] **Step 1: Write the failing test for the session store**

```ts
// test/mcp/auth.test.ts
import { describe, it, expect, vi } from 'vitest';
import { putSession, getSession, _clearAllSessions } from '../../lib/mcp/auth';

describe('session store', () => {
  it('stores and retrieves a live session', async () => {
    _clearAllSessions();
    putSession('sid-1', { token: 't', expiresAt: Date.now() + 10_000 });
    const s = await getSession('sid-1');
    expect(s?.token).toBe('t');
  });

  it('returns null for an expired session', async () => {
    _clearAllSessions();
    putSession('sid-2', { token: 't', expiresAt: Date.now() - 1 });
    expect(await getSession('sid-2')).toBeNull();
  });

  it('returns null for an unknown session', async () => {
    _clearAllSessions();
    expect(await getSession('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/mcp/auth.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Implement auth.ts (session store + OAuth flow scaffold)**

```ts
// lib/mcp/auth.ts
export interface McpSession { token: string; expiresAt: number; }

const sessions = new Map<string, McpSession>();
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export function putSession(sessionId: string, session: McpSession): void {
  sessions.set(sessionId, session);
}

export async function getSession(sessionId: string): Promise<McpSession | null> {
  const s = sessions.get(sessionId);
  if (!s || s.expiresAt < Date.now()) return null;
  return s;
}

/** test-only */
export function _clearAllSessions(): void { sessions.clear(); }

// --- OAuth flow (integration; verified via /debug against the live IdP) ---
// Follow the official bloomreach ts sample for exact params/endpoints:
//   github.com/bloomreach/loomi-connect-mcp-client-examples
const pendingStates = new Map<string, true>();

export async function startAuthFlow(): Promise<{ authUrl: string; state: string }> {
  const state = crypto.randomUUID();
  pendingStates.set(state, true);
  const redirectUri = `${process.env.APP_ORIGIN ?? ''}/api/mcp/callback`;
  // Build the authorize URL per the bloomreach sample (client_id, scope, response_type=code,
  // redirect_uri, state). Point at the loomi connect IdP authorize endpoint.
  const authUrl = buildAuthorizeUrl({ redirectUri, state });
  return { authUrl, state };
}

export async function handleCallback(code: string, state: string): Promise<McpSession> {
  if (!pendingStates.delete(state)) throw new Error('unknown oauth state');
  // Exchange `code` for an access token at the token endpoint (per the sample),
  // compute expiresAt (= now + expires_in, capped at THIRTY_DAYS).
  const token = await exchangeCodeForToken(code, `${process.env.APP_ORIGIN ?? ''}/api/mcp/callback`);
  const session: McpSession = { token: token.access_token, expiresAt: Date.now() + Math.min(token.expires_in * 1000, THIRTY_DAYS) };
  return session;
}

// Implemented against the bloomreach sample once its endpoints are confirmed in Task 1.10.
declare function buildAuthorizeUrl(o: { redirectUri: string; state: string }): string;
declare function exchangeCodeForToken(code: string, redirectUri: string): Promise<{ access_token: string; expires_in: number }>;
```

> Note: the two `declare function` lines are intentional scaffolding to be replaced in Task 1.10 with real implementations once the bloomreach sample's endpoints are confirmed. They keep the session-store TDD green now without inventing IdP URLs.

- [ ] **Step 4: Implement session.ts (cookie ↔ session id)**

```ts
// lib/mcp/session.ts
import { cookies } from 'next/headers';

const COOKIE = 'bi_session';

export async function getOrCreateSessionId(): Promise<string> {
  const jar = await cookies();
  let id = jar.get(COOKIE)?.value;
  if (!id) {
    id = crypto.randomUUID();
    jar.set(COOKIE, id, { httpOnly: true, sameSite: 'lax', path: '/' });
  }
  return id;
}

export async function readSessionId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE)?.value ?? null;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/mcp/auth.test.ts`
Expected: PASS (3). (`auth.ts` typechecks via the `declare` stubs.)

- [ ] **Step 6: Commit**

```bash
git add test/mcp/auth.test.ts lib/mcp/auth.ts lib/mcp/session.ts
git commit -m "feat: session store (tdd) + oauth flow scaffold + cookie helper"
```

---

### Task 1.9: Clone + run the bloomreach sample (de-risk OAuth)

**Files:** none in this repo (reference work)

- [ ] **Step 1: Clone and run the official sample locally**

```bash
git clone https://github.com/bloomreach/loomi-connect-mcp-client-examples /tmp/br-mcp-sample
cd /tmp/br-mcp-sample && cat README.md
```

Follow its README to get one successful authenticated tool call locally.

- [ ] **Step 2: Record the OAuth specifics**

Note in a scratch file the authorize endpoint, token endpoint, required scopes, `client_id` source, and how the SDK `Client` connects to `BLOOMREACH_MCP_URL` (transport type — Streamable HTTP vs SSE). These drive Task 1.10 and 1.11.

- [ ] **Step 3: Confirm transport type**

Determine which `@modelcontextprotocol/sdk` transport the remote server needs (e.g. `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`). This is what `SdkTransport`/the connect step will use.

(No commit — this is reference gathering.)

---

### Task 1.10: Wire real OAuth + MCP connection

**Files:**
- Modify: `lib/mcp/auth.ts` (replace the `declare` stubs)
- Create: `lib/mcp/connect.ts`
- Create: `app/api/mcp/callback/route.ts`
- Create/modify: `.env.local`, `.env.example`

- [ ] **Step 1: Env files**

Create `.env.example` (committed) and `.env.local` (gitignored) with the spec's variables plus `APP_ORIGIN`:

```bash
ANTHROPIC_API_KEY=
BLOOMREACH_MCP_URL=https://loomi-mcp-alpha.bloomreach.com/mcp/
BLOOMREACH_PROJECT_ID=
NEXT_PUBLIC_APP_NAME="blooming insights"
APP_ORIGIN=http://localhost:3000
BLOOMREACH_CLIENT_ID=
```

- [ ] **Step 2: Replace the OAuth stubs in auth.ts**

Replace `buildAuthorizeUrl` and `exchangeCodeForToken` `declare`s with real implementations using the endpoints/params confirmed in Task 1.9. Use `URLSearchParams` for the authorize URL and `fetch` for the token POST.

- [ ] **Step 3: Connection factory**

```ts
// lib/mcp/connect.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// import the transport class confirmed in Task 1.9, e.g.:
// import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SdkTransport } from './transport';
import { McpClient } from './client';

/** Build a ready McpClient for a given bearer token. */
export async function connectMcp(token: string): Promise<McpClient> {
  const url = new URL(process.env.BLOOMREACH_MCP_URL!);
  const transport = /* new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) */ undefined as any;
  const client = new Client({ name: 'blooming-insights', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return new McpClient(new SdkTransport(client));
}
```

> Fill the transport construction line with the exact class/options from Task 1.9. Keep all SDK-version-specific shape in this file.

- [ ] **Step 4: Callback route**

```ts
// app/api/mcp/callback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { handleCallback, putSession } from '@/lib/mcp/auth';
import { getOrCreateSessionId } from '@/lib/mcp/session';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  if (!code || !state) return NextResponse.json({ error: 'missing code/state' }, { status: 400 });
  try {
    const session = await handleCallback(code, state);
    const sid = await getOrCreateSessionId();
    putSession(sid, session);
    return NextResponse.redirect(new URL('/debug', req.url));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 401 });
  }
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/mcp/auth.ts lib/mcp/connect.ts app/api/mcp/callback/route.ts .env.example
git commit -m "feat: real oauth + mcp connection factory + callback route"
```

---

### Task 1.11: `/debug` page — call any MCP tool

**Files:**
- Create: `app/api/mcp/call/route.ts`
- Create: `app/debug/page.tsx`

- [ ] **Step 1: Generic tool-call API**

```ts
// app/api/mcp/call/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { readSessionId } from '@/lib/mcp/session';
import { getSession, startAuthFlow } from '@/lib/mcp/auth';
import { connectMcp } from '@/lib/mcp/connect';

export async function POST(req: NextRequest) {
  const { name, args } = await req.json();
  const sid = await readSessionId();
  const session = sid ? await getSession(sid) : null;
  if (!session) {
    const { authUrl } = await startAuthFlow();
    return NextResponse.json({ needsAuth: true, authUrl }, { status: 401 });
  }
  const mcp = await connectMcp(session.token);
  const r = await mcp.callTool(name, args ?? {}, { skipCache: true });
  return NextResponse.json({ result: r.result, durationMs: r.durationMs });
}
```

- [ ] **Step 2: Debug UI**

`app/debug/page.tsx` is a client component: a text input for tool name, a textarea for JSON args, a "call" button, and four preset buttons (`whoami`, `list_projects`, `get_project_overview`, `list_dashboards`). It POSTs to `/api/mcp/call`. On a `401 needsAuth` response it `window.open(authUrl, '_blank')`. It renders the raw JSON result in a `<pre className="font-mono">` and shows `durationMs`.

- [ ] **Step 3: Verify locally (manual)**

Run: `npm run dev`, open `/debug`, click `whoami`.
Expected: auth tab opens on first call; after auth, JSON appears for `whoami`. Then `list_projects`, `get_project_overview`, `list_dashboards` each return JSON.

- [ ] **Step 4: Capture fixtures (feeds Phase 2)**

Save the JSON results of `get_project_overview`, `get_event_schema`, `get_customer_schema`, and `list_catalogs` into `test/fixtures/` as `*.json`. These drive the Phase 2 schema-parser TDD.

```bash
mkdir -p test/fixtures
# paste each captured response into test/fixtures/<tool>.json
```

- [ ] **Step 5: Commit**

```bash
git add app/api/mcp/call/route.ts app/debug/page.tsx test/fixtures
git commit -m "feat: /debug mcp tool harness + capture schema fixtures"
```

---

### Task 1.12: Deploy preview + prove acceptance

**Files:** none (deploy)

- [ ] **Step 1: Push and deploy**

```bash
git push
```

Connect the repo to Vercel (or `npx vercel`), set all env vars from `.env.example` in the Vercel project, set `APP_ORIGIN` to the preview origin, and add the preview callback URL to the Bloomreach OAuth app's allowed redirect URIs.

- [ ] **Step 2: Verify acceptance (manual, on preview)**

Open `<preview-url>/debug`, authenticate, call the four preset tools.
Expected: JSON from all four. **Phase 1 acceptance met.** Confirm SSE viability early by noting the route handler runtime works on Vercel.

---

# Phase 2 — Monitoring agent + feed (build cached path here too)

**Goal:** Real insights generated from real `wobbly-ukulele` data, rendered as cards. The `?demo=cached` replay path is built now (moved up from Phase 6 per the spec's demo-data strategy).

**Acceptance:** Opening the deployed app shows 3–5 real insights generated from `wobbly-ukulele` data. `?demo=cached` shows the same insights from cached tool responses with MCP offline.

---

### Task 2.1: Schema bootstrap parser (TDD against fixtures)

**Files:**
- Create: `test/mcp/schema.test.ts`
- Create: `lib/mcp/schema.ts`

- [ ] **Step 1: Failing test using the captured fixtures**

```ts
// test/mcp/schema.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorkspaceSchema } from '../../lib/mcp/schema';

const load = (f: string) => JSON.parse(readFileSync(`test/fixtures/${f}`, 'utf8'));

describe('parseWorkspaceSchema', () => {
  it('extracts project id/name, events, customer props, catalogs', () => {
    const schema = parseWorkspaceSchema({
      project: load('get_project_overview.json'),
      events: load('get_event_schema.json'),
      customer: load('get_customer_schema.json'),
      catalogs: load('list_catalogs.json'),
    });
    expect(schema.projectId).toBeTruthy();
    expect(Array.isArray(schema.events)).toBe(true);
    expect(Array.isArray(schema.customerProperties)).toBe(true);
    expect(Array.isArray(schema.catalogs)).toBe(true);
  });
});
```

> The exact field assertions get tightened to the real fixture shapes once captured. Write the assertions against the actual JSON you saved in Task 1.11.

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/mcp/schema.test.ts`
Expected: FAIL — `parseWorkspaceSchema` not found.

- [ ] **Step 3: Implement parser + bootstrap**

```ts
// lib/mcp/schema.ts
import type { McpClient } from './client';

export interface WorkspaceSchema {
  projectId: string;
  projectName: string;
  events: { name: string; properties: string[] }[];
  customerProperties: string[];
  catalogs: { id: string; name: string }[];
}

export function parseWorkspaceSchema(raw: {
  project: any; events: any; customer: any; catalogs: any;
}): WorkspaceSchema {
  // Map the real fixture shapes captured in Task 1.11 into WorkspaceSchema.
  // (Field paths written against the actual JSON.)
  return {
    projectId: raw.project /* .id */,
    projectName: raw.project /* .name */,
    events: raw.events /* .map(...) */,
    customerProperties: raw.customer /* .map(...) */,
    catalogs: raw.catalogs /* .map(...) */,
  } as WorkspaceSchema;
}

let cached: WorkspaceSchema | null = null;
export async function bootstrapSchema(client: McpClient): Promise<WorkspaceSchema> {
  if (cached) return cached;
  const [project, events, customer, catalogs] = await Promise.all([
    client.callTool('get_project_overview', {}),
    client.callTool('get_event_schema', {}),
    client.callTool('get_customer_schema', {}),
    client.callTool('list_catalogs', {}),
  ]);
  cached = parseWorkspaceSchema({
    project: project.result, events: events.result,
    customer: customer.result, catalogs: catalogs.result,
  });
  return cached;
}
export function _resetSchemaCache() { cached = null; }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/mcp/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/mcp/schema.test.ts lib/mcp/schema.ts
git commit -m "feat: workspace schema bootstrap + parser (tdd vs fixtures)"
```

---

### Task 2.2: Result validation (TDD)

**Files:**
- Create: `test/mcp/validate.test.ts`
- Create: `lib/mcp/validate.ts`

Mitigates the "agent hallucinates tool results" risk: every agent JSON output is validated before it flows forward.

- [ ] **Step 1: Failing test**

```ts
// test/mcp/validate.test.ts
import { describe, it, expect } from 'vitest';
import { parseAgentJson, isAnomalyArray } from '../../lib/mcp/validate';

describe('parseAgentJson', () => {
  it('extracts a json array from a fenced code block', () => {
    const txt = 'here:\n```json\n[{"metric":"x"}]\n```';
    expect(parseAgentJson(txt)).toEqual([{ metric: 'x' }]);
  });
  it('parses bare json', () => {
    expect(parseAgentJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('throws on unparseable text', () => {
    expect(() => parseAgentJson('no json here')).toThrow();
  });
});

describe('isAnomalyArray', () => {
  it('accepts a well-formed anomaly array', () => {
    expect(isAnomalyArray([{ metric: 'conversion_rate', scope: ['mobile'],
      change: { value: -18, direction: 'down', baseline: '7d' }, severity: 'warning', evidence: [] }])).toBe(true);
  });
  it('rejects a missing-field object', () => {
    expect(isAnomalyArray([{ metric: 'x' }])).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/mcp/validate.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Implement**

```ts
// lib/mcp/validate.ts
import type { Anomaly, Severity } from './types';

export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const trimmed = candidate.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('no parseable json in agent output');
}

const SEVERITIES: Severity[] = ['critical', 'warning', 'info', 'positive'];

export function isAnomalyArray(v: unknown): v is Anomaly[] {
  return Array.isArray(v) && v.every((a: any) =>
    typeof a?.metric === 'string' &&
    Array.isArray(a?.scope) &&
    a?.change && typeof a.change.value === 'number' &&
    (a.change.direction === 'up' || a.change.direction === 'down') &&
    typeof a.change.baseline === 'string' &&
    SEVERITIES.includes(a?.severity));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/mcp/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/mcp/validate.test.ts lib/mcp/validate.ts
git commit -m "feat: agent json parsing + anomaly validation (tdd)"
```

---

### Task 2.3: Shared agent tool-use loop

**Files:**
- Create: `lib/agents/base.ts`

- [ ] **Step 1: Implement a reusable Claude tool-use loop**

```ts
// lib/agents/base.ts
import Anthropic from '@anthropic-ai/sdk';
import type { McpClient } from '../mcp/client';
import type { AgentName, ToolCall } from '../mcp/types';

export interface AgentRunResult { finalText: string; toolCalls: ToolCall[]; }

const MODEL = 'claude-opus-4-7';

/** Runs a Claude conversation where every tool is an MCP tool from `allowedTools`,
 *  executed through McpClient. Emits each tool call via onToolCall (for sse). */
export async function runAgentLoop(opts: {
  anthropic: Anthropic;
  mcp: McpClient;
  agent: AgentName;
  system: string;
  userPrompt: string;
  allowedTools: readonly string[];
  toolSchemas: Anthropic.Tool[];   // name+input_schema per allowed tool
  onToolCall?: (tc: ToolCall) => void;
  maxTurns?: number;
}): Promise<AgentRunResult> {
  const { anthropic, mcp, agent, system, userPrompt, toolSchemas, onToolCall } = opts;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];
  const toolCalls: ToolCall[] = [];
  const maxTurns = opts.maxTurns ?? 8;

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 4096, system, tools: toolSchemas, messages,
    });
    messages.push({ role: 'assistant', content: res.content });

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = res.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n');
      return { finalText: text, toolCalls };
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const tc: ToolCall = { id: tu.id, agent, toolName: tu.name, args: tu.input as Record<string, unknown> };
      onToolCall?.(tc);
      try {
        const r = await mcp.callTool(tu.name, tu.input as Record<string, unknown>);
        tc.result = r.result; tc.durationMs = r.durationMs;
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(r.result).slice(0, 20_000) });
      } catch (e) {
        tc.error = String(e);
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: String(e) });
      }
      toolCalls.push(tc);
    }
    messages.push({ role: 'user', content: results });
  }
  return { finalText: '', toolCalls };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (Adjust `Anthropic.*` type names to the installed SDK version if needed.)

- [ ] **Step 3: Commit**

```bash
git add lib/agents/base.ts
git commit -m "feat: shared claude+mcp tool-use loop"
```

---

### Task 2.4: Tool-schema builder

**Files:**
- Create: `test/agents/tool-schemas.test.ts`
- Create: `lib/agents/tool-schemas.ts`

Claude's tool-use needs JSON-schema per tool. We expose the MCP server's tool list, filtered to an agent's subset.

- [ ] **Step 1: Failing test**

```ts
// test/agents/tool-schemas.test.ts
import { describe, it, expect } from 'vitest';
import { filterToolSchemas } from '../../lib/agents/tool-schemas';

describe('filterToolSchemas', () => {
  it('keeps only allowed tools and maps to anthropic shape', () => {
    const all = [
      { name: 'get_trend', description: 'd', inputSchema: { type: 'object', properties: {} } },
      { name: 'secret_tool', description: 'd', inputSchema: { type: 'object', properties: {} } },
    ];
    const out = filterToolSchemas(all as any, ['get_trend']);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('get_trend');
    expect(out[0].input_schema).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/agents/tool-schemas.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// lib/agents/tool-schemas.ts
import type Anthropic from '@anthropic-ai/sdk';

export interface McpToolDef { name: string; description?: string; inputSchema: object; }

export function filterToolSchemas(all: McpToolDef[], allowed: readonly string[]): Anthropic.Tool[] {
  const set = new Set(allowed);
  return all.filter((t) => set.has(t.name)).map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }));
}
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add test/agents/tool-schemas.test.ts lib/agents/tool-schemas.ts
git commit -m "feat: filter mcp tool list into anthropic tool schemas (tdd)"
```

---

### Task 2.5: Monitoring agent + prompt

**Files:**
- Create: `lib/agents/prompts/monitoring.md`
- Create: `lib/agents/monitoring.ts`

- [ ] **Step 1: Prompt**

Copy the monitoring prompt skeleton verbatim from the spec into `lib/agents/prompts/monitoring.md`, keeping the `{schema}` placeholder.

- [ ] **Step 2: Implement the agent**

```ts
// lib/agents/monitoring.ts
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpClient } from '../mcp/client';
import type { WorkspaceSchema } from '../mcp/schema';
import type { Anomaly, ToolCall } from '../mcp/types';
import { monitoringTools } from '../mcp/tools';
import { runAgentLoop } from './base';
import { filterToolSchemas, type McpToolDef } from './tool-schemas';
import { parseAgentJson, isAnomalyArray } from '../mcp/validate';

const PROMPT = readFileSync(join(process.cwd(), 'lib/agents/prompts/monitoring.md'), 'utf8');

export class MonitoringAgent {
  constructor(
    private anthropic: Anthropic,
    private mcp: McpClient,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
  ) {}

  async scan(onToolCall?: (tc: ToolCall) => void): Promise<Anomaly[]> {
    const system = PROMPT.replace('{schema}', JSON.stringify(this.schema));
    const { finalText } = await runAgentLoop({
      anthropic: this.anthropic, mcp: this.mcp, agent: 'monitoring',
      system, userPrompt: 'scan the workspace and return the anomaly array.',
      allowedTools: monitoringTools,
      toolSchemas: filterToolSchemas(this.allTools, monitoringTools),
      onToolCall,
    });
    const parsed = parseAgentJson(finalText);
    if (!isAnomalyArray(parsed)) throw new Error('monitoring agent returned invalid anomalies');
    return parsed.sort((a, b) => sevRank(b.severity) - sevRank(a.severity)).slice(0, 10);
  }
}

function sevRank(s: string) { return { critical: 3, warning: 2, info: 1, positive: 0 }[s] ?? 0; }
```

- [ ] **Step 3: Typecheck** — `npx tsc --noEmit` → no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/agents/prompts/monitoring.md lib/agents/monitoring.ts
git commit -m "feat: monitoring agent + prompt"
```

---

### Task 2.6: Insight state + anomaly→insight mapping

**Files:**
- Create: `test/state/insights.test.ts`
- Create: `lib/state/insights.ts`

- [ ] **Step 1: Failing test**

```ts
// test/state/insights.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { anomalyToInsight, putInsights, getInsight, listInsights, _clear } from '../../lib/state/insights';

const anomaly = { metric: 'conversion_rate', scope: ['mobile', 'checkout'],
  change: { value: -18, direction: 'down' as const, baseline: '7d' },
  severity: 'warning' as const, evidence: [] };

describe('insight state', () => {
  beforeEach(() => _clear());
  it('maps an anomaly to an insight with a stable id', () => {
    const i = anomalyToInsight(anomaly);
    expect(i.id).toBeTruthy();
    expect(i.severity).toBe('warning');
    expect(i.metric).toBe('conversion_rate');
    expect(i.source).toBe('monitoring');
    expect(i.headline.toLowerCase()).toBe(i.headline);
  });
  it('stores and retrieves by id', () => {
    const i = anomalyToInsight(anomaly);
    putInsights([i]);
    expect(getInsight(i.id)?.id).toBe(i.id);
    expect(listInsights()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement**

```ts
// lib/state/insights.ts
import type { Anomaly, Insight, Investigation } from '../mcp/types';

const insights = new Map<string, Insight>();
const investigations = new Map<string, Investigation>();
const anomalies = new Map<string, Anomaly>();

export function anomalyToInsight(a: Anomaly): Insight {
  const id = crypto.randomUUID();
  const dir = a.change.direction === 'down' ? '-' : '+';
  const headline = `${a.scope.join(' ')} ${a.metric} · ${dir}${Math.abs(a.change.value)}%`.toLowerCase();
  return {
    id, timestamp: new Date().toISOString(), severity: a.severity, headline,
    summary: `${a.metric} ${a.change.direction} ${Math.abs(a.change.value)}% vs ${a.change.baseline}`,
    metric: a.metric, change: a.change, scope: a.scope, source: 'monitoring',
  };
}

export function putInsights(items: Insight[], rawAnomalies?: Anomaly[]) {
  items.forEach((i, idx) => { insights.set(i.id, i); if (rawAnomalies?.[idx]) anomalies.set(i.id, rawAnomalies[idx]); });
}
export function getInsight(id: string) { return insights.get(id) ?? null; }
export function getAnomaly(id: string) { return anomalies.get(id) ?? null; }
export function listInsights() { return [...insights.values()]; }
export function putInvestigation(inv: Investigation) { investigations.set(inv.insightId, inv); }
export function getInvestigation(id: string) { return investigations.get(id) ?? null; }
export function _clear() { insights.clear(); investigations.clear(); anomalies.clear(); }
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add test/state/insights.test.ts lib/state/insights.ts
git commit -m "feat: in-memory insight state + anomaly→insight mapping (tdd)"
```

---

### Task 2.7: Demo cache path (`?demo=cached`)

**Files:**
- Create: `lib/mcp/demo-cache.ts`

- [ ] **Step 1: Implement a transport that replays captured fixtures**

```ts
// lib/mcp/demo-cache.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { McpTransport } from './transport';
import { McpClient } from './client';

/** Replays test/fixtures/<tool>.json so the demo runs with MCP offline. */
class DemoTransport implements McpTransport {
  async callTool(name: string): Promise<unknown> {
    const f = join(process.cwd(), 'test/fixtures', `${name}.json`);
    if (!existsSync(f)) return {};
    return JSON.parse(readFileSync(f, 'utf8'));
  }
}

export function demoMcpClient(): McpClient {
  return new McpClient(new DemoTransport(), { minIntervalMs: 0 });
}
```

> Capture extra fixtures for the demo-script tools (the ones the monitoring agent calls) during a Phase 2 dry run, so cached mode produces real-looking insights.

- [ ] **Step 2: Typecheck** — no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/mcp/demo-cache.ts
git commit -m "feat: demo cached transport for ?demo=cached"
```

---

### Task 2.8: `/api/briefing` route

**Files:**
- Create: `app/api/briefing/route.ts`

- [ ] **Step 1: Implement**

```ts
// app/api/briefing/route.ts
import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { readSessionId } from '@/lib/mcp/session';
import { getSession, startAuthFlow } from '@/lib/mcp/auth';
import { connectMcp } from '@/lib/mcp/connect';
import { demoMcpClient } from '@/lib/mcp/demo-cache';
import { bootstrapSchema } from '@/lib/mcp/schema';
import { MonitoringAgent } from '@/lib/agents/monitoring';
import { anomalyToInsight, putInsights, listInsights } from '@/lib/state/insights';
import type { McpToolDef } from '@/lib/agents/tool-schemas';

export const maxDuration = 60; // vercel function timeout

export async function GET(req: NextRequest) {
  const demo = req.nextUrl.searchParams.get('demo') === 'cached';
  let mcp;
  if (demo) {
    mcp = demoMcpClient();
  } else {
    const sid = await readSessionId();
    const session = sid ? await getSession(sid) : null;
    if (!session) { const { authUrl } = await startAuthFlow(); return NextResponse.json({ needsAuth: true, authUrl }, { status: 401 }); }
    mcp = await connectMcp(session.token);
  }

  const schema = await bootstrapSchema(mcp);
  const toolList = await mcp.callTool('__list_tools__', {}).catch(() => ({ result: [] }));
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const agent = new MonitoringAgent(anthropic, mcp, schema, (toolList.result as McpToolDef[]) ?? []);

  const anomalies = await agent.scan();
  const insights = anomalies.map(anomalyToInsight);
  putInsights(insights, anomalies);
  return NextResponse.json({ insights: listInsights() });
}
```

> `__list_tools__` is a placeholder for however the MCP SDK exposes the tool list (`client.listTools()`). Wire the real call in `connect.ts`/`McpClient` and pass the list through — confirm the method name from the SDK in Task 1.9 and adjust. The monitoring tool schemas come from this list.

- [ ] **Step 2: Verify (manual)** — `npm run dev`, GET `/api/briefing?demo=cached`.
Expected: JSON `{ insights: [...] }` with mapped cards from fixtures. Then test live (authed) and confirm 3–5 insights from real data.

- [ ] **Step 3: Commit**

```bash
git add app/api/briefing/route.ts
git commit -m "feat: /api/briefing route (live + cached)"
```

---

### Task 2.9: Feed UI + cards

**Files:**
- Create: `components/feed/SeverityBadge.tsx`, `components/feed/InsightCard.tsx`, `components/shared/Skeleton.tsx`
- Modify: `app/page.tsx`

- [ ] **Step 1: SeverityBadge** — maps `Severity` to a colored dot/shape using the accent tokens (teal positive, amber warning, coral critical, secondary info). No emoji.

- [ ] **Step 2: InsightCard** — renders mono headline, one-line summary, meta row (timestamp, scope tags), `investigate →` affordance on hover, links to `/investigate/${id}`. Generous vertical spacing.

- [ ] **Step 3: Skeleton** — `animate-pulse` block using `--bg-surface`.

- [ ] **Step 4: Feed page** — `app/page.tsx` is a client component that fetches `/api/briefing` (preserving a `?demo=cached` query param), shows `Skeleton`s while loading, then maps insights to `InsightCard`s with `motion-safe:animate-in fade-in slide-in-from-bottom-2 duration-500`. On `401 needsAuth`, open `authUrl`.

- [ ] **Step 5: Verify (manual)** — open `/` and `/?demo=cached`.
Expected: 3–5 cards render, dark theme, mono headlines, severity dots. **Phase 2 acceptance met.**

- [ ] **Step 6: Commit**

```bash
git add components/feed components/shared/Skeleton.tsx app/page.tsx
git commit -m "feat: insight feed ui with cards + skeletons"
```

---

# Phase 3 — Diagnostic agent + investigation view (SSE)

**Goal:** Clicking an insight streams the diagnostic agent's reasoning in real time, including visible MCP tool calls.

**Acceptance:** Clicking any insight card opens an investigation view where the diagnostic agent's reasoning streams in step by step, including visible MCP tool calls and their results.

---

### Task 3.1: AgentEvent codec (TDD)

**Files:**
- Create: `test/mcp/events.test.ts`, `lib/mcp/events.ts`

- [ ] **Step 1: Failing test**

```ts
// test/mcp/events.test.ts
import { describe, it, expect } from 'vitest';
import { encodeEvent, decodeEvent, type AgentEvent } from '../../lib/mcp/events';

describe('AgentEvent codec', () => {
  it('round-trips an event as one ndjson line', () => {
    const e: AgentEvent = { type: 'done' };
    const line = encodeEvent(e);
    expect(line.endsWith('\n')).toBe(true);
    expect(decodeEvent(line.trim())).toEqual(e);
  });
  it('round-trips a tool_call_start', () => {
    const e: AgentEvent = { type: 'tool_call_start', toolName: 'get_funnel', agent: 'diagnostic' };
    expect(decodeEvent(encodeEvent(e).trim())).toEqual(e);
  });
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — define the `AgentEvent` union exactly as in the spec's "sse contract" section, plus:

```ts
// lib/mcp/events.ts (after the AgentEvent union)
export function encodeEvent(e: AgentEvent): string { return JSON.stringify(e) + '\n'; }
export function decodeEvent(line: string): AgentEvent { return JSON.parse(line) as AgentEvent; }
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add test/mcp/events.test.ts lib/mcp/events.ts
git commit -m "feat: AgentEvent type + ndjson codec (tdd)"
```

---

### Task 3.2: Diagnostic agent + prompt

**Files:**
- Create: `lib/agents/prompts/diagnostic.md`, `lib/agents/diagnostic.ts`

- [ ] **Step 1: Prompt** — copy the diagnostic prompt skeleton verbatim from the spec, keeping `{schema}` and `{anomaly}` placeholders.

- [ ] **Step 2: Implement** — mirror `MonitoringAgent` (Task 2.5) but: `investigate(anomaly: Anomaly, onToolCall?)` returns a `Diagnosis`. Substitute `{schema}` and `{anomaly}` (JSON-stringified) into the system prompt. Use `diagnosticTools` and `filterToolSchemas`. Parse with `parseAgentJson`; add an `isDiagnosis(v): v is Diagnosis` guard to `validate.ts` (test it the same way as `isAnomalyArray`: one accept, one reject) and validate before returning.

- [ ] **Step 3: Verify (manual)** — temporary script or `/debug` button calling `investigate` on a fixture anomaly.
Expected: a `Diagnosis` object with conclusion + evidence + hypotheses.

- [ ] **Step 4: Commit**

```bash
git add lib/agents/prompts/diagnostic.md lib/agents/diagnostic.ts lib/mcp/validate.ts test/mcp/validate.test.ts
git commit -m "feat: diagnostic agent + prompt + diagnosis validation"
```

---

### Task 3.3: Coordinator (briefing + investigate, streaming)

**Files:**
- Create: `lib/agents/prompts/coordinator.md`, `lib/agents/coordinator.ts`

- [ ] **Step 1: Prompt** — copy the coordinator prompt skeleton; if the spec leaves it implicit, write a short system prompt describing the three modes from the spec's coordinator section.

- [ ] **Step 2: Implement** — a `Coordinator` holding `anthropic`, `mcp`, `schema`, `allTools`, instantiating the three agents. Implement:
  - `generateBriefing(): Promise<Insight[]>` — monitoring scan → top 3 anomalies diagnosed in parallel (`Promise.all`) → recommendations (Phase 4 fills this; for now attach diagnosis) → assemble insights via `anomalyToInsight` + `putInvestigation`.
  - `async *investigate(insightId): AsyncGenerator<AgentEvent>` — read cached anomaly via `getAnomaly`, run the diagnostic agent with an `onToolCall` callback that yields `tool_call_start`/`tool_call_end` and `reasoning_step` events, then yield a `diagnosis` event and `done`. Persist the `Investigation`.

  Use an internal queue (push events from the `onToolCall` callback, drain in the generator) so callback-emitted events interleave with the awaited final diagnosis. Keep this in one place — it's the trickiest control flow.

- [ ] **Step 3: Typecheck** — no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/agents/prompts/coordinator.md lib/agents/coordinator.ts
git commit -m "feat: coordinator briefing + streaming investigate"
```

> Refactor `/api/briefing` (Task 2.8) to call `coordinator.generateBriefing()` instead of the monitoring agent directly. Commit that change here.

---

### Task 3.4: `/api/agent` SSE endpoint

**Files:**
- Create: `app/api/agent/route.ts`

- [ ] **Step 1: Implement a streaming route**

```ts
// app/api/agent/route.ts
import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { readSessionId } from '@/lib/mcp/session';
import { getSession } from '@/lib/mcp/auth';
import { connectMcp } from '@/lib/mcp/connect';
import { demoMcpClient } from '@/lib/mcp/demo-cache';
import { bootstrapSchema } from '@/lib/mcp/schema';
import { Coordinator } from '@/lib/agents/coordinator';
import { encodeEvent } from '@/lib/mcp/events';
import type { McpToolDef } from '@/lib/agents/tool-schemas';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const insightId = req.nextUrl.searchParams.get('insightId');
  const query = req.nextUrl.searchParams.get('q');
  const demo = req.nextUrl.searchParams.get('demo') === 'cached';

  let mcp;
  if (demo) mcp = demoMcpClient();
  else {
    const sid = await readSessionId();
    const session = sid ? await getSession(sid) : null;
    if (!session) return new Response('unauthorized', { status: 401 });
    mcp = await connectMcp(session.token);
  }
  const schema = await bootstrapSchema(mcp);
  const toolList = await mcp.callTool('__list_tools__', {}).catch(() => ({ result: [] }));
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const coordinator = new Coordinator(anthropic, mcp, schema, (toolList.result as McpToolDef[]) ?? []);

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        const gen = insightId ? coordinator.investigate(insightId) : coordinator.handleQuery(query!);
        for await (const event of gen) controller.enqueue(enc.encode(encodeEvent(event)));
      } catch (e) {
        controller.enqueue(enc.encode(encodeEvent({ type: 'error', message: String(e) })));
      } finally { controller.close(); }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
```

> `handleQuery` is implemented in Phase 5; until then the `q` branch can throw "not implemented".

- [ ] **Step 2: Verify (manual)** — `curl -N 'http://localhost:3000/api/agent?insightId=<id>&demo=cached'` after a cached briefing populated state.
Expected: a stream of ndjson `AgentEvent` lines ending in `{"type":"done"}`.

- [ ] **Step 3: Commit**

```bash
git add app/api/agent/route.ts
git commit -m "feat: /api/agent sse streaming endpoint"
```

---

### Task 3.5: Investigation view + reasoning trace UI

**Files:**
- Create: `components/shared/AgentBadge.tsx`, `components/investigation/ToolCallBlock.tsx`, `components/investigation/ReasoningTrace.tsx`, `components/investigation/EvidencePanel.tsx`
- Create: `app/investigate/[id]/page.tsx`

- [ ] **Step 1: AgentBadge** — small labeled chip colored per agent (`purple` reasoning accent for diagnostic, teal monitoring, etc.), mono font.

- [ ] **Step 2: ToolCallBlock** — collapsible: header shows mono `toolName` + `durationMs`, expands to a `<pre>` of `result` JSON. Error state in coral.

- [ ] **Step 3: ReasoningTrace** — vertical timeline; each `ReasoningStep` is a card with `AgentBadge` + content; if `kind==='tool_call'` render a `ToolCallBlock`.

- [ ] **Step 4: EvidencePanel** — diagnosis conclusion (plain language), evidence list, collapsible hypotheses-considered.

- [ ] **Step 5: Page** — client component for `/investigate/[id]`. On mount, open `new EventSource('/api/agent?insightId=' + id + demoSuffix)`, accumulate events into state (steps array, diagnosis), render three columns (trace left, diagnosis center, recommendations right — right column placeholder until Phase 4), stacked on mobile. Show skeletons until first event. Close the source on `done`.

  > `EventSource` only does GET and expects `data:` framing. Either (a) emit proper SSE `data: <json>\n\n` frames from the route and parse `event.data`, or (b) consume the raw ndjson stream with `fetch` + a `ReadableStream` reader. Pick one and keep the route's framing consistent with the client. Recommended: SSE `data:` framing so `EventSource` works directly.

- [ ] **Step 6: Verify (manual)** — open `/?demo=cached`, click a card.
Expected: investigation view streams reasoning steps and tool calls live, diagnosis appears. **Phase 3 acceptance met (cached).** Then verify live on preview.

- [ ] **Step 7: Commit**

```bash
git add components/shared/AgentBadge.tsx components/investigation app/investigate
git commit -m "feat: investigation view with streaming reasoning trace"
```

> If you chose SSE `data:` framing, update `app/api/agent/route.ts` to wrap each line as `data: <json>\n\n` and commit that adjustment here.

---

# Phase 4 — Recommendation agent

**Goal:** Each investigation ends with 2–3 actionable recommendations.

**Acceptance:** Every investigation view shows 2–3 recommendations with bloomreach feature tags and impact estimates.

---

### Task 4.1: Recommendation agent + prompt

**Files:**
- Create: `lib/agents/prompts/recommendation.md`, `lib/agents/recommendation.ts`
- Modify: `lib/mcp/validate.ts`, `test/mcp/validate.test.ts`

- [ ] **Step 1: Prompt** — copy the recommendation prompt skeleton verbatim, keeping `{diagnosis}`.

- [ ] **Step 2: Validation** — add `isRecommendationArray(v): v is Recommendation[]` to `validate.ts` checking `title`, `rationale`, `bloomreachFeature ∈ {scenario,segment,campaign,voucher,experiment}`, `steps: string[]`, `estimatedImpact`, `confidence ∈ {high,medium,low}`. Add accept/reject tests (TDD: write first, run fail, implement, run pass).

- [ ] **Step 3: Implement agent** — `propose(anomaly, diagnosis, onToolCall?): Promise<Recommendation[]>` mirroring the others, using `recommendationTools`, substituting `{diagnosis}`, parsing + validating, assigning `id = crypto.randomUUID()` to each, ordering by predicted impact (keep agent's order), capping at 3.

- [ ] **Step 4: Verify (manual)** — run against a fixture diagnosis.
Expected: 2–3 valid `Recommendation`s.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/prompts/recommendation.md lib/agents/recommendation.ts lib/mcp/validate.ts test/mcp/validate.test.ts
git commit -m "feat: recommendation agent + prompt + validation (tdd)"
```

---

### Task 4.2: Wire recommendations into coordinator + stream

**Files:**
- Modify: `lib/agents/coordinator.ts`

- [ ] **Step 1: Extend `investigate`** — after the diagnosis event, invoke `recommendationAgent.propose(...)` (with the same `onToolCall` → event plumbing), yield a `recommendation` event per recommendation, then `done`. Store recs on the `Investigation`.

- [ ] **Step 2: Extend `generateBriefing`** — for each diagnosed anomaly, call `propose` and attach recs to the persisted `Investigation`.

- [ ] **Step 3: Verify (manual)** — cached investigate stream now includes `recommendation` events.

- [ ] **Step 4: Commit**

```bash
git add lib/agents/coordinator.ts
git commit -m "feat: coordinator emits recommendations after diagnosis"
```

---

### Task 4.3: RecommendationCard + right column

**Files:**
- Create: `components/investigation/RecommendationCard.tsx`
- Modify: `app/investigate/[id]/page.tsx`

- [ ] **Step 1: RecommendationCard** — title, rationale, mono `bloomreachFeature` tag, ordered `steps`, `estimatedImpact`, confidence indicator (color by level). Sharp corners.

- [ ] **Step 2: Wire right column** — accumulate `recommendation` events into state; render cards in the right column (stacked below diagnosis on mobile).

- [ ] **Step 3: Verify (manual)** — `/?demo=cached` → click card → recommendations populate the right column. **Phase 4 acceptance met.** Verify live on preview.

- [ ] **Step 4: Commit**

```bash
git add components/investigation/RecommendationCard.tsx app/investigate/[id]/page.tsx
git commit -m "feat: recommendation cards in investigation right column"
```

---

# Phase 5 — Query box (global)

**Goal:** Free-form natural-language queries route through the coordinator and stream a reasoning trace.

**Acceptance:** Typing "show me which products lost engagement among returning customers last week" returns a coherent answer with a reasoning trace.

---

### Task 5.1: Intent classifier (TDD)

**Files:**
- Create: `test/agents/intent.test.ts`, `lib/agents/intent.ts`

The classifier has a deterministic, testable contract (string → one of three intents) even though it calls Claude. Test the **parser** of the classification output, not the model call.

- [ ] **Step 1: Failing test**

```ts
// test/agents/intent.test.ts
import { describe, it, expect } from 'vitest';
import { parseIntent } from '../../lib/agents/intent';

describe('parseIntent', () => {
  it('reads a clean intent token', () => {
    expect(parseIntent('diagnostic')).toBe('diagnostic');
    expect(parseIntent('  MONITORING ')).toBe('monitoring');
  });
  it('falls back to diagnostic on garbage', () => {
    expect(parseIntent('???')).toBe('diagnostic');
  });
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement**

```ts
// lib/agents/intent.ts
import Anthropic from '@anthropic-ai/sdk';

export type Intent = 'monitoring' | 'diagnostic' | 'recommendation';

export function parseIntent(raw: string): Intent {
  const t = raw.trim().toLowerCase();
  if (t.includes('monitoring')) return 'monitoring';
  if (t.includes('recommendation')) return 'recommendation';
  if (t.includes('diagnostic')) return 'diagnostic';
  return 'diagnostic';
}

export async function classifyIntent(anthropic: Anthropic, query: string): Promise<Intent> {
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 16,
    system: 'Classify the user query as exactly one word: monitoring (what changed), diagnostic (why), or recommendation (what to do). Reply with only the word.',
    messages: [{ role: 'user', content: query }],
  });
  const text = res.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('');
  return parseIntent(text);
}
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add test/agents/intent.test.ts lib/agents/intent.ts
git commit -m "feat: query intent classifier (tdd parser)"
```

---

### Task 5.2: Coordinator `handleQuery`

**Files:**
- Modify: `lib/agents/coordinator.ts`

- [ ] **Step 1: Implement** — `async *handleQuery(query): AsyncGenerator<AgentEvent>`: classify intent; route to the matching specialist(s) with the event plumbing (yield `reasoning_step`/`tool_call_*`); for cross-cutting queries run monitoring→diagnostic→recommendation in sequence; yield a final synthesis as `reasoning_step` (kind `conclusion`) and any `insight`/`diagnosis`/`recommendation` events the path produced; end with `done`.

- [ ] **Step 2: Wire the `q` branch in `/api/agent`** — replace the "not implemented" throw with `coordinator.handleQuery(query!)`.

- [ ] **Step 3: Verify (manual)** — `curl -N '/api/agent?q=which+products+lost+engagement&demo=cached'`.
Expected: streamed events ending in `done`.

- [ ] **Step 4: Commit**

```bash
git add lib/agents/coordinator.ts app/api/agent/route.ts
git commit -m "feat: coordinator handleQuery routing + sse wiring"
```

---

### Task 5.3: QueryBox + StreamingResponse

**Files:**
- Create: `components/chat/StreamingResponse.tsx`, `components/chat/QueryBox.tsx`
- Modify: `app/page.tsx`, `app/investigate/[id]/page.tsx`, `app/layout.tsx`

- [ ] **Step 1: StreamingResponse** — renders accumulated `AgentEvent`s (reuses `ReasoningTrace`); optional character-by-character typing on the final conclusion text (~12ms/char).

- [ ] **Step 2: QueryBox** — fixed-bottom input; on submit opens `EventSource('/api/agent?q=' + encodeURIComponent(query) + demoSuffix)`, streams into a `StreamingResponse`. Lowercase placeholder, mono input.

- [ ] **Step 3: Mount** — feed page: render the query result as a pinned card at the top. Investigation page: render it in a spawned side panel. Add `QueryBox` to both (or to `layout.tsx` if always-on).

- [ ] **Step 4: Verify (manual)** — type the spec's example query on `/?demo=cached`.
Expected: coherent streamed answer with a reasoning trace. **Phase 5 acceptance met.** Verify live on preview.

- [ ] **Step 5: Commit**

```bash
git add components/chat app/page.tsx app/investigate/[id]/page.tsx app/layout.tsx
git commit -m "feat: global query box with streaming response"
```

---

# Phase 6 — Polish (if time)

Each item is independent; do in priority order. Commit after each.

- [ ] **6.1 Status indicator** — corner pill showing `monitoring → diagnostic → recommendation`, lighting the active stage from streamed `tool_call_start` events' `agent`. (Makes the multi-agent architecture visible.)
- [ ] **6.2 Motion polish** — fade-up on insight cards, one transition per element (`motion-safe:animate-in fade-in slide-in-from-bottom-2 duration-500`).
- [ ] **6.3 Loading/empty/error states** — skeletons during agent work; empty state when 0 insights; coral error card on `{type:'error'}`.
- [ ] **6.4 Shareable investigation URLs** — investigation already keyed by id; ensure the page reconstructs from cached `Investigation` (via `getInvestigation`) without re-streaming if already complete.
- [ ] **6.5 Export reasoning trace as markdown** — button that serializes the current `Investigation` to `.md` and downloads it.
- [ ] **6.6 Briefing autorefresh / cron** — optional Vercel cron hitting `/api/briefing` on a schedule.
- [ ] **6.7 One-click apply** — out of scope for read-only MCP; defer to "what's next" per the spec (transactional email REST API). Leave a stubbed disabled button only.

---

## Demo delivery (non-code, do before the pitch)

Tracked here so it isn't forgotten — see the spec's "demo delivery" section for full detail. Not code tasks:

- [ ] Dedicated clean Chrome profile; hide bookmarks/dock/menubar; zoom 110–125%.
- [ ] Mac display set to 1080p; dark mode OS + app; quit notifiers.
- [ ] Full dry run on venue wifi 30 min before; full dry run with wifi off proving `?demo=cached`.
- [ ] Phone hotspot backup.
- [ ] Run the 90-second flow ≥5 times; time it; rehearse transitions.
- [ ] Prep one-sentence answers to the three anticipated judge questions.

---

## Self-review against the spec

**Spec coverage:**
- Stack (Next 15 / TS / Tailwind / Anthropic SDK / MCP SDK / SSE / Vercel / no DB) → Tasks 1.1–1.2, deploy 1.12. ✓
- Env vars → Task 1.10 Step 1. ✓
- Design tokens / fonts / ui rules (lowercase, ≤4px radius, mono numerics, no emoji) → Task 1.3 + enforced in each UI task. ✓
- Data model types (incl. reconciling the two `Recommendation` shapes) → Task 1.4. ✓
- MCP auth (OAuth, in-memory sessions, 30-day expiry, callback) → Tasks 1.8–1.10. ✓
- MCP client (cache + rate limit, `CallToolResult`) → Task 1.6. ✓
- Tool subsets per agent + bootstrap tools → Task 1.7. ✓
- Schema bootstrap → Task 2.1. ✓
- Monitoring/diagnostic/recommendation agents + their prompts + output schemas → 2.5, 3.2, 4.1. ✓
- Coordinator (briefing/investigate/query modes) → 2.8/3.3, 3.4, 5.2. ✓
- SSE contract (`AgentEvent` union) → Task 3.1. ✓
- UI surfaces: feed, investigation (3-col), global query box → 2.9, 3.5+4.3, 5.3. ✓
- Demo cached path (moved into Phase 2 per spec) → Task 2.7. ✓
- Phased acceptance criteria → stated under each phase, verified in the last task of each. ✓
- Risks (rate limits/caching, parallel calls, demo mode, hallucination validation, sse-in-prod-early) → cache 1.6, parallel 3.3, demo 2.7, validation 2.2/3.2/4.1, sse-early 1.12/3.4. ✓
- Demo delivery + pitch → tracked as non-code checklist. ✓

**Known runtime-dependent points (deliberate, not placeholders):** exact OAuth endpoints/transport class (resolved in Task 1.9 against the official sample), the MCP SDK's tool-list method name (`__list_tools__` marker, resolved in 1.9), and real MCP response field paths for `parseWorkspaceSchema` (resolved against fixtures captured in Task 1.11). Each is sequenced behind the discovery step that must precede it, with the discovery step explicit in the plan.

**Type consistency:** `Recommendation` uses the canonical shape from Task 1.4 everywhere (`steps`, 5-member `bloomreachFeature` union). `McpClient.callTool` signature is consistent across 1.6/2.x/3.x. `AgentEvent` defined once in 3.1 and consumed by 3.4/3.5/5.x. Agent classes share the `scan/investigate/propose(...onToolCall?)` convention.
