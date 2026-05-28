# Project context

blooming insights — a Next.js multi-agent AI analyst for a Bloomreach Engagement workspace, built on the loomi connect MCP server. It surfaces "what changed, why, and what to do," streaming the agents' reasoning to the UI as a first-class surface.

## Stack
- **Runtime / framework:** Next.js 16 (App Router), React 19, TypeScript. Deployed target: Vercel.
- **AI:** `@anthropic-ai/sdk` (agents run `claude-sonnet-4-6`; intent classifier `claude-haiku-4-5-20251001`).
- **MCP:** `@modelcontextprotocol/sdk` — `StreamableHTTPClientTransport` + an `OAuthClientProvider` (PKCE + Dynamic Client Registration) to the Bloomreach loomi connect server (`https://loomi-mcp-alpha.bloomreach.com/mcp`).
- **Streaming:** newline-delimited JSON (NDJSON) over `ReadableStream`, consumed in the browser via `fetch` + a `ReadableStream` reader (not `EventSource`).
- **Styling:** Tailwind v4 (CSS-first) + CSS custom-property design tokens; dark mode only.
- **Tests:** Vitest (125 tests; pure logic + agent loops TDD'd with injected fakes — no network).
- **No database:** state lives in in-memory maps; in dev, auth + investigations persist to gitignored JSON files (`.auth-cache.json`, `.investigation-cache.json`); committed demo snapshots in `lib/state/demo-*.json`.

## Data model (`lib/mcp/types.ts`)
- `Severity` = critical | warning | info | positive.
- `Insight` { id, timestamp, severity, headline, summary, metric, change{value,direction,baseline}, scope[], source }.
- `Anomaly` { metric, scope[], change, severity, evidence[] } — monitoring agent output.
- `Diagnosis` { conclusion, evidence[], hypothesesConsidered[{hypothesis,supported,reasoning}], affectedCustomers? } — diagnostic agent output.
- `Recommendation` { id, title, rationale, bloomreachFeature, steps[], estimatedImpact, confidence } — recommendation agent output.
- `ToolCall` { id, agent, toolName, args, result?, durationMs?, error? }; `ReasoningStep` { id, agent, kind, content, toolCall? }; `AgentName` = coordinator|monitoring|diagnostic|recommendation.
- `AgentEvent` (`lib/mcp/events.ts`) — the NDJSON streaming contract: reasoning_step | tool_call_start | tool_call_end | insight | diagnosis | recommendation | done | error.
- `WorkspaceSchema` (`lib/mcp/schema.ts`) { projectId, projectName, events[], customerProperties[], catalogs[], totalCustomers, totalEvents, oldestTimestamp }.

## File structure
- `app/` — `page.tsx` (feed), `investigate/[id]/page.tsx` (streaming investigation), `debug/page.tsx` (dev harness), and `api/` routes: `briefing/` (monitoring → insights), `agent/` (NDJSON stream: investigation + query, with cache replay), `mcp/{callback,call,tools,capture}/`.
- `lib/mcp/` — `auth.ts` (OAuthClientProvider + session-scoped store), `connect.ts` (`connectMcp`/`completeAuth`), `client.ts` (`McpClient`: cache + rate-limit + retry), `transport.ts` (`McpTransport` interface + `SdkTransport`), `schema.ts` (bootstrap + parse), `validate.ts` (parse + validators), `events.ts`, `tools.ts`, `session.ts`, `types.ts`.
- `lib/agents/` — `base.ts` (`runAgentLoop` — the shared Claude+MCP tool-use loop), `monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`, `intent.ts`, `tool-schemas.ts`, `prompts/*.md`.
- `lib/state/` — `insights.ts`, `investigations.ts` (+ committed `demo-insights.json`, `demo-investigations.json`).
- `components/` — `feed/`, `investigation/`, `chat/`, `shared/`.

## What must not change
- The `AgentEvent` NDJSON contract (route producers + UI consumers depend on it).
- `McpClient.callTool`'s return shape `{ result, durationMs, fromCache }` and its no-cache-on-error / rate-limit-retry behavior.
- `BloomreachAuthProvider` conforming to the SDK's `OAuthClientProvider` interface.
- The MCP result envelope handling (`unwrap`: prefer `structuredContent`, else `content[0].text`).
- Tool calls must always carry `project_id`; the server rate-limits to ~1 req/sec/user.
