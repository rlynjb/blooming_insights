# Request flow

**Industry name(s):** Layered request/response, controller → service → repository, route handler pipeline
**Type:** Industry standard · Language-agnostic

> A single `GET /api/briefing` call moves through session resolution, OAuth-gated MCP connection, workspace schema bootstrap, an AI agent run, and in-process state before JSON lands in the browser — understanding every hop is what lets you predict latency, debug auth failures, and reason about where state lives.

**See also:** → 02-oauth-boundary.md · → 04-caching-and-rate-limiting.md · → 05-streaming-ndjson.md

---

## Why care

You have a component. It calls `fetch('/api/briefing')` inside a `useEffect`. It shows a spinner while `status === 'loading'`. When the promise resolves it either renders cards or redirects to an auth URL. That is the entire visible behavior — but five distinct subsystems execute between the `fetch` call leaving the browser and the JSON arriving back.

The question this pattern answers: what actually happens between the moment `fetch` fires and the moment `.map((insight) => <InsightCard>)` runs?

**Every layer is a failure domain.** If you do not know the layers, you cannot tell whether a blank feed is a network error, a cookie miss, an OAuth rejection, an MCP rate limit, an agent parse failure, or genuinely zero anomalies. In this codebase the route returns a distinct JSON shape for each case — `{needsAuth, authUrl}` at 401, `{error, trace}` at 500, `{insights: []}` for a clean empty run — and the page branches on all of them (`app/page.tsx` L69–90).

- Before: one undifferentiated `catch` block, every failure looks the same
- After: each layer owns its error shape; the client can route to the right recovery

This is the request/response flow pattern: a layered pipeline where each hop transforms the request, and each layer's output is the next layer's input — the same shape as a middleware stack, a Redux action moving through reducers, or a `Promise` chain.

---

## How it works

### Move 1 — Mental model

The `fetch`-on-mount component is the outer frame. Inside the route every `await` is a layer boundary. Cross a boundary and you hand off to a different subsystem with its own failure modes.

```
┌─────────────────────────────────────────────────────┐
│  Browser                                            │
│  useEffect → fetch('/api/briefing')                 │
│              ↓  HTTP GET                            │
├─────────────────────────────────────────────────────┤
│  Next.js Route Handler  (app/api/briefing/route.ts) │
│  ┌─────────────┐  ┌───────────┐  ┌───────────────┐ │
│  │ session/    │→ │ MCP conn  │→ │ agent run     │ │
│  │ auth gate   │  │ bootstrap │  │ anomaly→JSON  │ │
│  └─────────────┘  └───────────┘  └───────────────┘ │
│              ↓  NextResponse.json(...)              │
├─────────────────────────────────────────────────────┤
│  External MCP server  (Bloomreach, ~1 req/s)        │
└─────────────────────────────────────────────────────┘
```

The route is the controller. `bootstrapSchema` + `connectMcp` are the service layer. `MonitoringAgent.scan` is the processing layer. `anomalyToInsight` + `putInsights` + `listInsights` are the repository layer. The diagram above is the recap — walk each hop below.

### Move 2 — Layered walkthrough

**Hop 1 — The page fetch**

A `useEffect` with an empty dependency array (`app/page.tsx` L47, L96) fires once on mount — the same pattern as any data-fetching component. It reads `window.location.search` to carry `?demo=cached` through (L50–54), builds the URL (L63), and calls `fetch(url)`. State starts at `'loading'` (L35). The concrete consequence: the browser holds an open HTTP connection until the route resolves — up to 60 seconds (`maxDuration = 60`, `route.ts` L23).

```
useEffect fires
  │
  ├─ demoOnly? → url = '/api/briefing?demo=cached'
  │
  └─ else     → url = '/api/briefing' + window.location.search
       │
       └─ fetch(url) ──────────────────► route handler
```

**Hop 2 — Demo short-circuit**

The route checks `?demo=cached` before any network call (L28–36). If the flag is set and `lib/state/demo-insights.json` exists, it reads the file synchronously and returns `NextResponse.json({...snapshot, demo: true})`. No session, no MCP, no agent. The consequence: a public demo works with zero credentials.

```
GET /api/briefing?demo=cached
  │
  ├─ demo=cached AND file exists?
  │     └─ readFileSync(DEMO_FILE) → NextResponse.json  ──► browser
  │
  └─ else → live path (hops 3–7)
```

**Hop 3 — Session resolution**

`getOrCreateSessionId()` (`lib/mcp/session.ts` L5–13) reads the `bi_session` cookie from the Next.js cookie jar. If absent it writes a new `crypto.randomUUID()` with `httpOnly: true, sameSite: 'lax'`. The return value is a string — this is the key that gates all per-session MCP state. The concrete consequence: every browser that has never visited the app starts an OAuth flow on the first request.

```
cookies().get('bi_session')
  │
  ├─ exists → return id
  └─ absent → crypto.randomUUID() → set cookie → return id
```

**Hop 4 — MCP connection and OAuth gate**

`connectMcp(sid)` (`lib/mcp/connect.ts` L40–69) builds a `BloomreachAuthProvider` keyed to the session id, attaches it to a `StreamableHTTPClientTransport`, and calls `client.connect(transport)`. If the session has valid tokens, `client.connect` succeeds and the function returns `{ok: true, mcp: McpClient}`. If not, the SDK fires the OAuth `redirectToAuthorization` callback, the auth provider captures the URL, and the function returns `{ok: false, authUrl}`. The route checks `conn.ok` (L46–48) and returns a 401 with `{needsAuth: true, authUrl}`. The page (`app/page.tsx` L69–71) checks `res.status === 401 && body.needsAuth` and redirects the browser to `body.authUrl`.

```
connectMcp(sid)
  │
  ├─ tokens valid → {ok: true, mcp: McpClient}  → hop 5
  └─ no tokens   → {ok: false, authUrl}
        └─ route: NextResponse.json({needsAuth, authUrl}, {status:401})
              └─ page: window.location.href = authUrl
```

**Hop 5 — Schema bootstrap**

`bootstrapSchema(conn.mcp)` (`lib/mcp/schema.ts` L152–176) checks an in-process module-level cache (`cached`) first. On a cache miss it calls four sequential MCP tools — `get_event_schema`, `get_customer_property_schema`, `list_catalogs`, `get_project_overview` — spaced by the 1100 ms rate-limit interval baked into `McpClient`. The result is a `WorkspaceSchema` object stored in `cached`. The concrete consequence: the first request after a cold function start pays the 4+ second schema cost; subsequent requests within the same function lifetime (Vercel's warm function window) skip it.

```
bootstrapSchema(mcp)
  │
  ├─ cached !== null → return cached  (fast path)
  └─ cold start
        ├─ resolveProject: list_cloud_organizations → list_projects
        ├─ get_event_schema        (1100ms gap)
        ├─ get_customer_property_schema  (1100ms gap)
        ├─ list_catalogs           (1100ms gap)
        ├─ get_project_overview    (1100ms gap)
        └─ parseWorkspaceSchema → cached = result → return
```

**Hop 6 — Agent run**

`new MonitoringAgent(anthropic, conn.mcp, schema, allTools).scan(trace.push)` (`lib/agents/monitoring.ts` L60–93) runs an agentic loop: sends a system prompt containing a token-bounded schema summary plus a user prompt to Claude, receives tool-call requests, executes them against the live MCP server (up to 6 calls, 8 turns), parses the final assistant message as a JSON anomaly array, sorts by severity, and returns at most 10 `Anomaly` objects. Each MCP call appends to the `trace` array in the route's closure (L42, L58). The concrete consequence: this is where most of the 60-second budget is spent.

```
MonitoringAgent.scan()
  │
  ├─ build system prompt (PROMPT + schemaSummary)
  ├─ runAgentLoop (up to 8 turns, 6 tool calls)
  │     ├─ Claude → tool_use request
  │     ├─ mcp.callTool(name, args) → result → trace
  │     └─ Claude → text (final answer)
  ├─ parseAgentJson(finalText) → Anomaly[]
  └─ sort by severity → slice(0, 10) → return
```

**Hop 7 — Mapping and response**

`anomalies.map(anomalyToInsight)` (`lib/state/insights.ts` L7–22) converts each `Anomaly` to an `Insight` with a UUID, a formatted `headline`, and a `summary`. `putInsights(insights, anomalies)` writes both maps in-process (L24–29). `listInsights()` reads back all stored insights (L39–41). The route returns `NextResponse.json({insights, workspace, trace})` (L63–67). The page receives this, sets `setInsights(list)` and `setStatus('loaded')` (L88–90), and the `.map((insight) => <InsightCard key={insight.id}>)` finally runs (L214–216).

```
anomalies.map(anomalyToInsight)
  │
putInsights(insights, anomalies)   ← in-process Map
  │
listInsights()
  │
NextResponse.json({insights, workspace, trace})
  │
page: setInsights(list) → setStatus('loaded') → render cards
```

### Move 2.5 — Live briefing vs cached demo

| Step | Live briefing (no `?demo=cached`) | Cached demo (`?demo=cached`) |
|------|-----------------------------------|------------------------------|
| Auth | Session cookie + OAuth flow | None |
| Data source | MCP server (network) | `lib/state/demo-insights.json` (disk) |
| Agent run | Yes — up to 60 s | No |
| Response shape | `{insights, workspace, trace}` | `{...snapshot, demo: true}` |
| Failure modes | 401, 500, empty | Only file-read error (falls through to live) |

```
         live                          cached demo
fetch('/api/briefing')         fetch('/api/briefing?demo=cached')
         │                                  │
    session check                    file exists?
         │                             yes │  no
    MCP connect ◄────────────────────────  │  └── falls through to live
         │                                 │
    bootstrapSchema               readFileSync
         │                                 │
    agent.scan                    NextResponse.json(snapshot)
         │
    anomalyToInsight
         │
    NextResponse.json
```

### Move 3 — The generalizing principle

Every layer-crossing in this pipeline is an await on I/O that can fail independently. The pattern is: authenticate → fetch context → process → transform → respond. The same shape appears in any backend that fronts an external service: the route is the controller, the session/connect layer is the auth middleware, schema bootstrap is the data-access layer, the agent is the service layer, and `anomalyToInsight` is the mapper. Knowing which layer a failure comes from determines the fix.

The primary diagram below makes all layers and boundaries explicit.

---

## Request flow — diagram

```
Browser / UI layer
┌────────────────────────────────────────────────────────────────────┐
│  HomePage (app/page.tsx)                                           │
│  useEffect → fetch('/api/briefing[?demo=cached]')                  │
│  status: loading → error | empty | loaded                          │
│  401+needsAuth → window.location.href = authUrl                    │
└───────────────────────────────┬────────────────────────────────────┘
                                │ HTTP GET
                    ────────────▼──────────────
                         Network boundary
                    ──────────────────────────
                                │
Route / Service layer (Next.js App Router)
┌───────────────────────────────▼────────────────────────────────────┐
│  GET /api/briefing  (app/api/briefing/route.ts)                    │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Demo gate                                                   │   │
│  │ ?demo=cached + file exists → readFileSync → json → return   │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │ miss                             │
│  ┌──────────────────────────────▼──────────────────────────────┐   │
│  │ Session layer  (lib/mcp/session.ts)                         │   │
│  │ getOrCreateSessionId → cookie 'bi_session'                  │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │ sid                              │
│  ┌──────────────────────────────▼──────────────────────────────┐   │
│  │ Auth/Connect layer  (lib/mcp/connect.ts)                    │   │
│  │ connectMcp(sid) → {ok:true, mcp} | {ok:false, authUrl}      │   │
│  │ ok:false → 401 {needsAuth, authUrl}                         │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │ mcp: McpClient                   │
│  ┌──────────────────────────────▼──────────────────────────────┐   │
│  │ Schema layer  (lib/mcp/schema.ts)                           │   │
│  │ bootstrapSchema(mcp) → WorkspaceSchema (module-cached)      │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │ schema                           │
│  ┌──────────────────────────────▼──────────────────────────────┐   │
│  │ Agent layer  (lib/agents/monitoring.ts)                     │   │
│  │ MonitoringAgent.scan() → Anomaly[]  (≤6 MCP calls)         │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │ anomalies                        │
│  ┌──────────────────────────────▼──────────────────────────────┐   │
│  │ Mapping layer  (lib/state/insights.ts)                      │   │
│  │ anomalyToInsight → putInsights → listInsights               │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │                                  │
│  NextResponse.json({insights, workspace, trace})                   │
└───────────────────────────────┬────────────────────────────────────┘
                                │ HTTP 200
                    ────────────▼──────────────
                         Network boundary
                    ──────────────────────────
                                │
MCP / Provider layer
┌───────────────────────────────▼────────────────────────────────────┐
│  Bloomreach MCP server  (loomi-mcp-alpha.bloomreach.com/mcp/)      │
│  StreamableHTTPClientTransport · ~1 req/s rate limit               │
│  Tools: get_event_schema · get_customer_property_schema            │
│         list_catalogs · get_project_overview · + monitoring set    │
└────────────────────────────────────────────────────────────────────┘
                                │
                    (responses flow back up through the layers above)
```

---

## In this codebase

**File:** `app/page.tsx`
**Function / class:** `HomePage` (default export)
**Line range:** L47–96
**Role:** Fires the `fetch('/api/briefing')` on mount; handles 401+`needsAuth` redirect, error display, empty state, and card render.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/app/page.tsx#L47-L96

---

**File:** `app/api/briefing/route.ts`
**Function / class:** `GET` (named export); `summarizeTrace`; `maxDuration = 60`
**Line range:** L23–77
**Role:** The full pipeline: demo short-circuit (L28–36), session (L44), connect (L45–48), bootstrap (L50), agent (L56–58), mapping (L60–61), response (L63–67), error shape (L68–76).
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/app/api/briefing/route.ts#L23-L77

**Briefing route happy path (pseudocode):**
```
GET /api/briefing
  if ?demo=cached && file exists → return snapshot

  sid  = await getOrCreateSessionId()          // cookie bi_session
  conn = await connectMcp(sid)
  if !conn.ok → 401 { needsAuth, authUrl }

  schema    = await bootstrapSchema(conn.mcp)  // module-cached after first call
  allTools  = await conn.mcp.listTools()
  agent     = new MonitoringAgent(anthropic, conn.mcp, schema, allTools)
  anomalies = await agent.scan(tc => trace.push(tc))

  insights  = anomalies.map(anomalyToInsight)
  putInsights(insights, anomalies)

  return { insights: listInsights(), workspace, trace }
```

---

**File:** `lib/mcp/session.ts`
**Function / class:** `getOrCreateSessionId`; `readSessionId`
**Line range:** L1–18
**Role:** Reads or creates the `bi_session` cookie that keys all per-session OAuth and MCP state.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/session.ts#L1-L18

---

**File:** `lib/mcp/connect.ts`
**Function / class:** `connectMcp`; `completeAuth`; `ConnectResult` type
**Line range:** L40–69
**Role:** Builds the `StreamableHTTPClientTransport` + `BloomreachAuthProvider` and returns either a ready `McpClient` or an `authUrl` for redirect.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/connect.ts#L40-L69

---

**File:** `lib/mcp/schema.ts`
**Function / class:** `bootstrapSchema`; `resolveProject`; `parseWorkspaceSchema`
**Line range:** L152–176
**Role:** Module-level cached `WorkspaceSchema` built from four sequential MCP tool calls.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/schema.ts#L152-L176

---

**File:** `lib/agents/monitoring.ts`
**Function / class:** `MonitoringAgent`; `MonitoringAgent.scan`
**Line range:** L52–93
**Role:** Runs the agentic Claude loop against MCP tools; returns sorted `Anomaly[]`.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/monitoring.ts#L52-L93

---

**File:** `lib/state/insights.ts`
**Function / class:** `anomalyToInsight`; `putInsights`; `listInsights`
**Line range:** L7–41
**Role:** In-process `Map`-backed store; `anomalyToInsight` maps `Anomaly` → `Insight` with a headline and UUID.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/lib/state/insights.ts#L7-L41

---

## Elaborate

### Where this pattern comes from

The layered request/response pipeline is the server-side counterpart to the Redux action chain: a single event (a dispatch, a fetch) travels through a fixed sequence of handlers, each transforming state and handing off to the next. In web servers this crystallized as the middleware stack — Express/Koa/Hapi all formalize it. Next.js App Router route handlers are the modern server-component-era version: a single exported `GET` function is the entry point, and the pipeline is explicit `await` calls rather than framework middleware registration.

### The deeper principle

Each hop in this pipeline is both a transformation and a gate. If a hop fails or returns a sentinel (like `{ok: false}`), the pipeline short-circuits and returns its own error shape. The pattern is: validate early, fail fast, return structured errors.

```
request
  │
  ├─ gate 1: demo flag  ──► return (short-circuit)
  ├─ gate 2: auth       ──► 401  (short-circuit)
  ├─ gate 3: schema     ──► 500  (if MCP unreachable)
  ├─ gate 4: agent      ──► [] anomalies (degrades gracefully)
  └─ gate 5: mapping    ──► {insights: []}
```

Every gate that short-circuits means the layers below never execute. This is the same principle as early-return guards in a React event handler: check preconditions at the top, do the expensive work only when all gates pass.

### Where this breaks down

- **Serverless function lifetime.** The module-level `cached` in `schema.ts` (L130) and the in-process `Map`s in `insights.ts` (L3–5) are process-scoped. On Vercel, each function invocation may land on a different cold container. Two users may each pay the full schema bootstrap cost, and `listInsights()` returns only the insights from the current invocation — not a shared store.
- **The 60-second ceiling.** `maxDuration = 60` (route.ts L23) is Vercel's hard function limit. At ~1 req/s MCP rate and 4 schema calls + up to 6 agent calls + 8 Claude turns, the budget is tight. A slow network or a verbose Claude response can push the total past 60 seconds.
- **OAuth state across invocations.** The PKCE verifier and client info written during `connectMcp` live in the `BloomreachAuthProvider`'s in-memory store. If the OAuth callback lands on a different Vercel function instance, the verifier is gone and `completeAuth` fails.

### What to explore next

- `02-oauth-boundary.md` → how the `BloomreachAuthProvider` captures the PKCE flow and why in-memory persistence breaks across serverless invocations
- `04-caching-and-rate-limiting.md` → the module-level schema cache, `McpClient`'s 60-second response cache, and the 1100 ms rate-limit interval
- `05-streaming-ndjson.md` → the query box uses a different path (streaming NDJSON) instead of a single JSON response — same layered pattern but the response shape is a stream

---

## Tradeoffs

```
Dimension             Per-request agent run           Precomputed / cron'd feed
──────────────────────────────────────────────────────────────────────────────
Freshness             Live at request time            Stale by up to cron interval
Latency               Up to 60 s (function limit)     ~100 ms (DB/file read)
Auth coupling         MCP auth required per request   Auth only at cron time
Cost (AI tokens)      Per page load                   Per cron tick (amortized)
Serverless limits     Strains 60 s maxDuration         Cron job separate from handler
MCP rate limit        6 agent calls + 4 schema calls  Same, but batched not user-driven
Failure surface       User-visible timeout/error       Background failure, silent stale
```

### Sub-block 1 — what we gave up

A per-request agent run means every page load pays the full MCP + Claude latency. At ~1 req/s MCP rate, 4 sequential schema calls alone take ~4.4 seconds minimum. Add 6 agent tool calls and 8 Claude turns and a cold start can easily hit 20–40 seconds. The `maxDuration = 60` ceiling (`route.ts` L23) is a hard wall. Users who land on the page while the agent is still running see the spinner (`status === 'loading'`) for the entire duration.

### Sub-block 2 — what the alternative would have cost

A precomputed feed (cron job writes `lib/state/demo-insights.json` on a schedule, route always reads the file) would reduce page-load latency to milliseconds and eliminate the per-user auth dependency. The cost: the feed is stale. A metric spike at 2:47 AM is invisible until the next cron tick. The cron job needs its own auth token, its own error alerting, and a way to surface "last updated at" so users know when the data is from. The cached demo path (the `?demo=cached` short-circuit, `route.ts` L28–36) is exactly this pattern — a committed snapshot serving as the cron output.

### Sub-block 3 — the breakpoint

The per-request model holds at low traffic. The breakpoint is the intersection of two constraints: the 60-second function limit (`maxDuration = 60`) and the ~1 req/s MCP rate ceiling (verified live, `connect.ts` L51–54). At 1 concurrent user the budget is tight but workable. At 2+ concurrent users both sessions share the same MCP server rate limit — the second user's request starts queuing behind the first. At ~5 concurrent users the MCP server begins returning 429s before the function times out. The `McpClient`'s 1100 ms spacing (`connect.ts` L58) prevents the client from exceeding the limit per session but does not coordinate across sessions. That is the event that makes the cron/precompute model the right call.

---

## Tech reference (industry pairing)

### Next.js App Router route handlers

- **Codebase uses:** `export async function GET(req: NextRequest)` in `app/api/briefing/route.ts`; `export const maxDuration = 60`; `NextResponse.json()`
- **Why it's here:** App Router co-locates the API route with the frontend in one Next.js project; the `GET` export is the route handler; `maxDuration` is the Vercel serverless function timeout
- **Leading today (2026):** Next.js App Router is the de facto standard for React full-stack apps; server components + route handlers in one project is the dominant pattern for Next.js 13+ deployments
- **Why it leads:** Zero-config deployment on Vercel, TypeScript-first, RSC + route handlers in one mental model, active ecosystem and LTS commitment from Vercel
- **Runner-up:** Remix (similar file-based routing, stronger progressive enhancement, owned by Shopify since 2022)

### MCP client/transport (Model Context Protocol)

- **Codebase uses:** `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport` in `lib/mcp/connect.ts` L15–18, L42–44; `McpClient` wrapper in `lib/mcp/client.ts` adding rate-limit spacing
- **Why it's here:** Bloomreach exposes its analytics/CDP tools via an MCP server; the SDK handles OAuth, streaming, and tool-call framing so the agent code only calls `mcp.callTool(name, args)`
- **Leading today (2026):** MCP is Anthropic's open protocol for connecting AI agents to external tools; adoption is accelerating across IDE tools, data platforms, and SaaS APIs; it is the primary way to give Claude structured tool access
- **Why it leads:** Open spec (not Anthropic-proprietary in usage), vendor-neutral tool definitions, streaming transport, built-in OAuth support via `OAuthClientProvider`
- **Runner-up:** OpenAI function calling / tool use over REST (older pattern, not a protocol — each vendor implements its own transport)

### Cookie-based session (`bi_session`)

- **Codebase uses:** `lib/mcp/session.ts` `getOrCreateSessionId` reads/writes `bi_session` with `httpOnly: true, sameSite: 'lax'`; the session id keys the `BloomreachAuthProvider`'s in-memory OAuth state
- **Why it's here:** The MCP OAuth flow requires per-user token storage; a cookie is the simplest way to carry a session id from the browser to the server without a login system; `httpOnly` prevents JS access
- **Leading today (2026):** `httpOnly` cookies for session ids remain the standard — `sameSite: 'lax'` is the default for new cookies in all major frameworks (Next.js, Remix, SvelteKit)
- **Why it leads:** Automatic browser handling, CSRF mitigation via `sameSite`, no client-side JS required to send it, compatible with server-side rendering
- **Runner-up:** JWT in `Authorization: Bearer` header (requires explicit client-side storage + header injection; no automatic browser handling; common in SPAs calling separate APIs)

---

## Summary

The request flow for `/api/briefing` is a six-hop pipeline: the browser's `useEffect` fetch → a demo short-circuit gate → session cookie resolution → OAuth-gated MCP connection → workspace schema bootstrap → an AI agent run → `Anomaly`-to-`Insight` mapping → JSON response → card render. The constraint that forced this shape is the MCP server's ~1 req/s rate limit and the requirement that insights be live at page load time — the agent must run synchronously in the request, which pushes the function to the 60-second `maxDuration` ceiling. The cost is latency: every page load pays the full agent round-trip, and the in-process state stores (`Map` in `insights.ts`, module-level `cached` in `schema.ts`) are process-scoped, which breaks under multi-instance serverless deployment.

- **Shape:** A strict sequential pipeline where each `await` is a layer boundary and a failure domain; short-circuit at any gate returns a distinct JSON error shape.
- **Rule:** The demo `?demo=cached` path is a structural short-circuit, not a feature flag — it bypasses every layer after the file-existence check.
- **Tradeoff:** Per-request agent runs give live data but spend the full latency budget; a precomputed feed would be milliseconds but stale.
- **State:** `WorkspaceSchema` and `Insight` maps are in-process — warm within a function lifetime, reset on cold start; this is a hidden state ownership decision.
- **Failure handling:** Each layer returns a structured error shape (`{needsAuth}`, `{error, trace}`, `{insights: []}`) so the client can branch correctly; the agent degrades to `[]` rather than throwing.
- **System-design checklist:** This file is primarily **step 2 — Request-response flow**; it also touches step 4 (state ownership: in-process maps), step 5 (failure handling: per-layer error shapes), and step 6 (scale concerns: the 60 s ceiling + concurrent-user MCP rate-limit breakpoint).

---

## Interview defense

### What an interviewer is really asking

When they ask "walk me through the request flow," they are checking whether you know: (a) where each await crosses a subsystem boundary, (b) what fails at each boundary and what the error shape is, (c) where state lives and what resets it, (d) what the latency budget is and what eats it. They are not asking for a description of the UI.

### Likely questions

**[mid] "What happens if the user has no session cookie?"**

`getOrCreateSessionId` in `lib/mcp/session.ts` (L5–13) writes a new `bi_session` cookie on the first call. That cookie is immediately used as the key for `connectMcp`. Since there are no stored tokens for a new session id, `connectMcp` returns `{ok: false, authUrl}`. The route returns 401 with `{needsAuth: true, authUrl}`. The page checks `res.status === 401 && body.needsAuth` (`app/page.tsx` L69) and redirects the browser. At scale this means every new visitor pays an OAuth round-trip before seeing any data — the fix is a shared token store so sessions survive across serverless instances.

```
new visitor
  │
  getOrCreateSessionId → new UUID → set cookie
  │
  connectMcp(newId) → no tokens → {ok:false, authUrl}
  │
  route: 401 {needsAuth, authUrl}
  │
  page: window.location.href = authUrl
```

**[senior] "Why is `bootstrapSchema` module-cached and not request-cached? What breaks?"**

`bootstrapSchema` stores its result in a module-level `let cached` (`lib/mcp/schema.ts` L130). Within a single Node process (a warm Vercel function), the second request skips all four MCP calls. The problem: Vercel runs multiple function instances concurrently. Two cold-start invocations each pay the full 4-call schema cost independently, and there is no consistency guarantee between them. If the schema changes between invocations the two instances serve different data. The fix is a shared external cache (KV/Redis) keyed to the project id with a TTL. I would prioritize this as soon as traffic exceeds one warm instance.

```
Instance A (cold)               Instance B (cold, concurrent)
  bootstrapSchema                 bootstrapSchema
  └─ 4 MCP calls → cached_A       └─ 4 MCP calls → cached_B
                                          ↑
                                    independent — may differ
```

**[arch] "How does this design hold up at 100 concurrent users?"**

At 100 concurrent users, 100 function invocations fire simultaneously. Each calls `connectMcp` which opens a `StreamableHTTPClientTransport` to the Bloomreach MCP server. The MCP server enforces ~1 req/s per user globally (verified, `connect.ts` L51–54). At 100 users, even if each session is distinct, the total MCP call volume is 100 × (4 schema + up to 6 agent) = 1,000 calls. The 1100 ms client-side spacing is per-session, not global — it prevents one session from exceeding the limit but does not coordinate across sessions. The MCP server will return 429s. The route has no retry/backoff (noted as Phase 2 in `connect.ts` L54). The 60-second `maxDuration` will be exceeded for most requests. The correct architecture at this scale: a cron job precomputes insights into a durable store (database or blob), the route reads from that store, and the MCP connection is made once per cron tick, not per user.

```
100 concurrent users
  │
  100 × connectMcp ──► Bloomreach MCP (~1 req/s limit)
  │                         │
  │                    429 Too Many Requests
  │                         │
  100 × route timeout ◄────┘  (before 60 s maxDuration)
  │
  fix: cron → durable store → route reads store
       (MCP called once/tick, not once/user)
```

### The question candidates always dodge

**"Why run the monitoring agent live on every page load instead of precomputing it?"**

The honest answer: per-request gives live data with no additional infrastructure — no cron, no durable store, no staleness communication to the user. For a project at early/demo scale with one to a few users, this is the right tradeoff. The `maxDuration = 60` and the `?demo=cached` short-circuit both exist because the authors knew this was the constraint. The precompute path was deferred, not ignored — the demo file (`lib/state/demo-insights.json`) is exactly what a cron output would look like. The breakpoint is clearly identified: when concurrent users push MCP into 429s or when the 60-second limit is regularly hit, you switch. At current scale neither has happened.

```
per-request (current)       precomputed (deferred)
─────────────────────────   ──────────────────────────────
live data every load         stale by cron interval
no extra infra               cron + durable store + TTL
60s ceiling is a wall        ~100ms read is a floor
1 user: fine                 1000 users: fine
100 users: breaks            100 users: fine (1 MCP session)
```

### One-line anchors

- `maxDuration = 60` is not a performance target — it is a hard ceiling that the pipeline was designed to fit under.
- `getOrCreateSessionId` makes the cookie on first visit; `connectMcp` makes it meaningful by binding OAuth tokens to it.
- `bootstrapSchema`'s `cached` variable is process-scoped state — it does not survive a cold start.
- The 401 response with `{needsAuth, authUrl}` is a structured gate, not an error — the page uses it to redirect rather than display an error message.
- The demo short-circuit at L28–36 of `route.ts` is structurally identical to what a precomputed-feed architecture would look like at the route level.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the full pipeline from `useEffect` to card render as a vertical sequence of boxes. Label every box with a function name. Draw the demo short-circuit as a branch. Draw the 401 as a branch. Check your diagram against the primary diagram in `## Request flow — diagram`.

### Level 2 — Explain it out loud

Work through these checkpoints without looking at the file:

- [ ] What state value does `HomePage` start with, and what triggers the `fetch`? (`app/page.tsx` L35, L47)
- [ ] What are the three possible outcomes of `connectMcp`, and what does the route do for each? (`app/api/briefing/route.ts` L45–48, `lib/mcp/connect.ts` L56–67)
- [ ] What does `bootstrapSchema` return on a warm function, and what does it call on a cold start? (`lib/mcp/schema.ts` L154–176)
- [ ] What is the maximum number of MCP tool calls the agent will make, and where is that limit set? (`lib/agents/monitoring.ts` L74)
- [ ] What does the route return when the agent produces no parseable anomaly array? (`lib/agents/monitoring.ts` L85–90, `lib/state/insights.ts` L39–41)

### Level 3 — Apply it to a new scenario

Scenario: You add a second agent that runs after `MonitoringAgent.scan` and calls three more MCP tools. Estimate whether it fits within the existing `maxDuration = 60` budget.

Check your reasoning against `app/api/briefing/route.ts` L23 for the budget and `lib/mcp/connect.ts` L51–58 for the rate-limit spacing. Three additional MCP calls at 1100 ms each = 3.3 seconds minimum added to the pipeline. If the monitoring agent already uses 6 calls (6 × 1.1 s = 6.6 s) plus schema (4 × 1.1 s = 4.4 s) plus Claude latency (estimate 5–15 s per turn × up to 8 turns), the budget is already tight. The second agent's 3 calls add 3.3 s plus its own Claude turns. You need to reduce `maxToolCalls` or `maxTurns` on one of the agents, or run them concurrently (requires careful MCP rate-limit coordination), or move one to a separate route.

### Level 4 — Defend the decision you'd change

The in-process `Map`s in `lib/state/insights.ts` (L3–5) are not shared across Vercel function instances. Two concurrent requests each get their own `insights` map and `listInsights()` returns only the current invocation's insights — not a merged view. `putInsights` followed by `listInsights` in the same request is fine, but any design that expects insights to persist between requests (e.g., a follow-up query that references a previous briefing's insights by id) will silently return nothing on a different instance. The fix: replace the in-process maps with a durable KV store keyed by session id. Defend why the current design was acceptable at launch and where it breaks.

### Quick check — code reference test

Without reading the file, answer:

1. What is the exact cookie name used by `getOrCreateSessionId`? (Check: `lib/mcp/session.ts` L3)
2. What HTTP status does the route return when `conn.ok` is false? (Check: `app/api/briefing/route.ts` L47)
3. What is the hard limit on MCP tool calls inside `MonitoringAgent.scan`? (Check: `lib/agents/monitoring.ts` L74)
4. What does the route export to tell Vercel the function timeout? (Check: `app/api/briefing/route.ts` L23)
5. What file does the demo path read from, and where is the path constructed? (Check: `app/api/briefing/route.ts` L25, L31–34)
