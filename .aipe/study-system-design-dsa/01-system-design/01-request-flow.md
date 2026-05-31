# Request flow

**Industry name(s):** Layered request/response, controller → service → repository, route handler pipeline
**Type:** Industry standard · Language-agnostic

> A single `GET /api/briefing` call moves through session resolution, OAuth-gated MCP connection, workspace schema bootstrap, an AI agent run, and in-process state before JSON lands in the browser — understanding every hop is what lets you predict latency, debug auth failures, and reason about where state lives.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Request flow is the spine — it spans every band in the blooming insights stack, from the `useEffect` in `app/page.tsx` to the Bloomreach MCP server over HTTPS. The other concepts in this guide each live in one band (TTL cache sits inside Provider wrappers, OAuth sits at the connect boundary, etc.); this one is the road they all travel down in order. Once you can name every `await` in `app/api/briefing/route.ts` and the band it crosses, every other concept slots into a place you already know.

```
Zoom out — where request flow lives        ← we are here (every band)

┌─ UI ───────────────────────────────────────────┐
│  app/page.tsx · fetch('/api/briefing')         │ ★ SPANS ★
└─────────────────────┬──────────────────────────┘
                      │
┌─ Route handler ─────▼──────────────────────────┐
│  app/api/briefing/route.ts (NDJSON stream)     │ ★ SPANS ★
└─────────────────────┬──────────────────────────┘
                      │
┌─ Session + OAuth gate ─────────────────────────┐
│  lib/mcp/session.ts · lib/mcp/connect.ts       │ ★ SPANS ★
└─────────────────────┬──────────────────────────┘
                      │
┌─ Schema + coverage gate ───────────────────────┐
│  lib/mcp/schema.ts · lib/agents/categories.ts  │ ★ SPANS ★
└─────────────────────┬──────────────────────────┘
                      │
┌─ Agent (MonitoringAgent.scan) ─────────────────┐
│  lib/agents/monitoring.ts → runAgentLoop       │ ★ SPANS ★
└─────────────────────┬──────────────────────────┘
                      │
┌─ Provider wrappers + MCP transport ────────────┐
│  lib/mcp/client.ts (cache · spacing · retry)   │ ★ SPANS ★
└─────────────────────┬──────────────────────────┘
                      │  HTTPS
┌─ External ─────────────────────────────────────┐
│  Bloomreach MCP server                         │ ★ SPANS ★
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: what happens between `fetch('/api/briefing')` firing and `.map((insight) => <InsightCard>)` running? Request flow names every layer-crossing `await` in that path and what owns each one. Every band is also a failure domain with its own error shape — 401 `{needsAuth, authUrl}`, a 500 setup throw, an NDJSON `error` event mid-stream, or a clean `done` with no insights — and the page branches on all of them. Below, you'll walk hop by hop with the file path and line range that owns each transition.

---

## How it works

### Move 1 — Mental model

The fetch-on-mount component is the outer frame. Inside the route every `await` is a layer boundary. Cross a boundary and you hand off to a different subsystem with its own failure modes.

```
┌─────────────────────────────────────────────────────┐
│  Browser                                            │
│  useEffect → fetch(briefing endpoint)               │
│              ↓  HTTP GET                            │
├─────────────────────────────────────────────────────┤
│  Route handler                                      │
│  ┌─────────────┐  ┌───────────┐  ┌───────────────┐ │
│  │ session/    │→ │ MCP conn  │→ │ agent run     │ │
│  │ auth gate   │  │ bootstrap │  │ anomaly→JSON  │ │
│  └─────────────┘  └───────────┘  └───────────────┘ │
│              ↓  NDJSON stream                       │
├─────────────────────────────────────────────────────┤
│  External MCP server  (~1 req/s)                    │
└─────────────────────────────────────────────────────┘
```

The route handler is the controller. The schema bootstrap and MCP connect call are the service layer. The monitoring agent is the processing layer. The anomaly-to-insight mapper plus the in-process state map are the repository layer. The diagram above is the recap — walk each hop below.

### Move 2 — Layered walkthrough

**Hop 1 — The page fetch**

An effect keyed on the resolved demo/live mode fires once persisted state has been read — the same pattern as any data-fetching component. The runtime demo/live toggle picks the URL: demo mode appends a query flag, live mode uses no suffix. State starts at `loading`. The concrete consequence: the browser holds an open HTTP connection until the route resolves — up to the function's hard ceiling (5 minutes on the platform tier this app targets).

```
effect fires (mode resolved)
  │
  ├─ demo mode? → url = briefing_endpoint + "?demo=cached"
  │
  └─ else       → url = briefing_endpoint
       │
       └─ fetch(url) ──────────────────► route handler
```

**Hop 2 — Demo short-circuit (paced NDJSON replay)**

The route handler checks the demo flag before any network call. If the flag is set and the recorded snapshot file exists, it reads the file synchronously, then *replays the snapshot as a paced NDJSON stream* — it does NOT return a single JSON blob. The replay mirrors the live event order exactly: a workspace event → the coverage checklist + per-tile coverage events → the recorded tool-call trace → insight cards → a terminal `done` event, each event spaced by a fixed delay (around 140 ms). No session, no MCP, no agent. The consequence: a public demo works with zero credentials AND reveals progressively — the feed animates identically to a live run.

```
GET briefing?demo=cached
  │
  ├─ demo=cached AND snapshot file exists?
  │     └─ read snapshot → ReadableStream (NDJSON, ~140 ms/event):
  │          {workspace}
  │          {step "matching…checklist"} → per category: {step}+{coverage_item}
  │          recorded trace: {tool_call_start}{tool_call_end}…
  │          {insight}…
  │          {done}                                     ──► browser
  │
  └─ else → live path (hops 3–7)
```

**Hop 3 — Session resolution**

The session helper reads the session cookie from the framework's cookie jar. If absent it writes a new UUID with cookie options tuned to the environment: `httpOnly: true, sameSite: none, secure: true` in prod (so the cookie survives the cross-site OAuth round trip), `sameSite: lax` in dev. The return value is a string — this is the key that gates all per-session MCP state. The concrete consequence: every browser that has never visited the app starts an OAuth flow on the first request.

```
cookies.get(session_cookie_name)
  │
  ├─ exists → return id
  └─ absent → new_uuid() → set cookie → return id
```

**Hop 4 — MCP connection and OAuth gate**

The connect helper is async and wraps its inner connect path in an auth-cookie context — in prod that seeds the encrypted-cookie auth store from the request and flushes it once (see 02-oauth-boundary.md); in dev/test it is a passthrough. The inner path derives a host-based redirect URI for the provider, builds an OAuth provider keyed to the session id, attaches it to the SDK's HTTP transport, and calls `connect`. If the session has valid tokens, connect succeeds and the function returns `{ok: true, mcp}`. If not, the SDK fires the `redirectToAuthorization` callback, the auth provider captures the URL, and the function returns `{ok: false, authUrl}`. The route runs session resolution plus connect inside a try/catch so a setup throw — a missing cookie-encryption secret breaking the auth store in prod — returns the real error message instead of a bare 500; it then checks the `ok` flag and returns a 401 with `{needsAuth: true, authUrl}`. The page checks for `status === 401 && body.needsAuth` and redirects the browser to `authUrl`.

```
connectMcp(sid)
  │
  ├─ tokens valid → {ok: true, mcp}  → hop 5
  └─ no tokens   → {ok: false, authUrl}
        └─ route: NDJSON not started → JSON {needsAuth, authUrl}, status 401
              └─ page: window.location.href = authUrl
```

**Hop 5 — Schema bootstrap**

The schema bootstrap helper checks an in-process module-level cache first. On a cache miss it calls four sequential MCP tools — `get_event_schema`, `get_customer_property_schema`, `list_catalogs`, `get_project_overview` — spaced by the ~1100 ms rate-limit interval baked into the MCP client wrapper. The result is a `WorkspaceSchema` object stored in the module-level cache. The concrete consequence: the first request after a cold function start pays the 4+ second schema cost; subsequent requests within the same function lifetime (the platform's warm function window) skip it.

```
bootstrapSchema(mcp)
  │
  ├─ cached_schema != null → return cached  (fast path)
  └─ cold start
        ├─ resolveProject: list_cloud_organizations → list_projects
        ├─ get_event_schema              (~1100 ms gap)
        ├─ get_customer_property_schema  (~1100 ms gap)
        ├─ list_catalogs                 (~1100 ms gap)
        ├─ get_project_overview          (~1100 ms gap)
        └─ parse → cached_schema = result → return
```

**Hop 5.5 — Coverage gate**

Between schema bootstrap and the agent run the route gates the fixed 10-category anomaly checklist against the live schema. Three pure functions in the category module do the work: a capabilities pass flattens the schema into a `Set` of event names plus `event.property` and `catalog:<name>` strings; a report pass classifies every category as `full`/`limited`/`unavailable`; a runnable pass keeps only the `full` + `limited` ones. The route then narrates the gate as a per-category checklist — it emits a step line `"matching the workspace schema to the 10-category anomaly checklist…"`, then per category a reasoning step line plus a `coverage_item` event so the UI grid fills tile-by-tile. Finally the agent's scan is gated to only the runnable categories. The concrete consequence: the agent never spends its 6-call EQL budget probing a category this workspace's events can't support (no `return` event → no return-spike category), and the user watches the coverage grid resolve before the agent starts.

```
schema (from hop 5)
  │
  ├─ schemaCapabilities(schema)   → Set{ event, event.prop, catalog:name }
  │
  ├─ coverageReport(capabilities) → 10 × {category, coverage: full|limited|unavailable}
  │     └─ step "matching…checklist…" + per category: step + {coverage_item}
  │
  └─ runnableCategories(capabilities) → AnomalyCategory[] (full + limited only)
        │
        └─► agent.scan(hooks, runnable)   ← agent gated to runnable categories (hop 6)
```

**Hop 6 — Agent run (gated to runnable categories)**

The monitoring agent runs an agentic loop with two arguments — an optional hooks object and the runnable category list from the coverage gate. The agent only checks categories the live schema can support. Internally it builds a per-category checklist string from those categories and injects it into the system prompt alongside a token-bounded schema summary, sends prompt-plus-user-message to the LLM provider, receives tool-call requests, executes them against the live MCP server (up to 6 calls and 8 turns), parses the final assistant message as a JSON anomaly array, sorts by severity, and returns at most 10 anomalies. Instead of a trace array, the agent takes a hooks object (`onToolCall`/`onToolResult`/`onText`); the route's hooks emit NDJSON events into the stream — a brief tool-call description for the live status line and a truncated tool result for the gathered trace. The concrete consequence: this is where most of the 5-minute budget is spent.

```
MonitoringAgent.scan(hooks, runnable)
  │
  ├─ build per-category checklist from runnable → inject into prompt
  ├─ build system prompt (PROMPT + schemaSummary + checklist)
  ├─ agent loop (up to 8 turns, 6 tool calls)
  │     ├─ LLM → tool_use request
  │     ├─ call tool → result → hooks → NDJSON event
  │     └─ LLM → text (final answer)
  ├─ parse JSON → Anomaly[]
  └─ sort by severity → slice(0, 10) → return
```

**Hop 7 — Mapping and response**

The mapper converts each `Anomaly` to an `Insight` with a UUID, a formatted `headline`, and a `summary`. It also sets `impact` (the agent's one-sentence business impact), `history` (the weekly sparkline series), and spreads in the derived business-owner fields built from the evidence (see 06-enrichment-derivation.md). A write helper clears and rewrites the in-process state maps. A read helper reads back all stored insights. The route streams them as NDJSON `insight` events followed by a `done` event, not a single JSON body. The page collects them and on `done` sets `insights = collected` and `status = "loaded"`, and the card list finally renders.

```
anomalies.map(anomalyToInsight)
  │
putInsights(insights, anomalies)   ← in-process Map
  │
listInsights()
  │
send({insight}) per insight → send({done})   ← NDJSON stream
  │
page: collect → on done: setInsights(collected) → setStatus("loaded") → render cards
```

### Move 2.5 — Live briefing vs cached demo

The demo/live choice is a **runtime toggle**, not a build flag: the page reads a persisted `mode` from local storage, and live mode hits the bare endpoint while demo mode appends `?demo=cached`. A mode-switch handler persists the choice and re-runs the fetch effect.

| Step | Live briefing (no demo flag) | Cached demo (`?demo=cached`) |
|------|------------------------------|------------------------------|
| Auth | Session cookie + OAuth flow (prod: encrypted-cookie store) | None |
| Data source | MCP server (network) | A committed snapshot file (disk) |
| Agent run | Yes — up to 5 min | No — replays a captured snapshot |
| Response shape | NDJSON stream: `workspace` → `coverage_item` tiles → `tool_call_*` → `insight` → `done` | Same NDJSON event order, replayed at ~140 ms / event |
| Failure modes | 401 (pre-stream), 500 (setup throw), `error` event mid-stream, empty | Only file parse error (falls through to live) |

Both paths now emit the SAME NDJSON event sequence — demo just replays a recorded snapshot at a fixed pace instead of computing it live.

```
         live                          cached demo
fetch(briefing)                fetch(briefing?demo=cached)
         │                                  │
    session check                    snapshot file exists?
         │                             yes │  no
    MCP connect ◄────────────────────────  │  └── falls through to live
         │                                 │
    bootstrapSchema               read snapshot + parse JSON
         │                                 │
    coverage gate                 ReadableStream replay (~140 ms/event):
    agent.scan                      {workspace}→{coverage_item}…
         │                          →recorded {tool_call_*}…→{insight}…→{done}
    anomalyToInsight
         │
    NDJSON: {workspace}→{coverage_item}…{insight}…{done}
```

### Move 3 — The generalizing principle

Every layer-crossing in this pipeline is an `await` on I/O that can fail independently. The pattern is: authenticate → fetch context → process → transform → respond. The same shape appears in any backend that fronts an external service: the route handler is the controller, the session/connect layer is the auth middleware, schema bootstrap is the data-access layer, the agent is the service layer, and the anomaly-to-insight mapper is the data mapper. Knowing which layer a failure comes from determines the fix.

The primary diagram below makes all layers and boundaries explicit.

---

## Request flow — diagram

```
Browser / UI layer
┌────────────────────────────────────────────────────────────────────┐
│  HomePage (app/page.tsx)                                           │
│  useEffect[mode,ready] → fetch('/api/briefing[?demo=cached]')      │
│  status: loading → error | empty | loaded                          │
│  401+needsAuth → window.location.href = authUrl                    │
│  live: read NDJSON stream (workspace/tool_call/insight/done)       │
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
│  │ connectMcp(sid) = withAuthCookies(connectMcpInner)          │   │
│  │   → {ok:true, mcp} | {ok:false, authUrl}                    │   │
│  │ wrapped in try/catch → 500 {error} on setup throw           │   │
│  │ ok:false → 401 {needsAuth, authUrl}                         │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │ mcp: McpClient                   │
│  ┌──────────────────────────────▼──────────────────────────────┐   │
│  │ Schema layer  (lib/mcp/schema.ts)                           │   │
│  │ bootstrapSchema(mcp) → WorkspaceSchema (module-cached)      │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │ schema                           │
│  ┌──────────────────────────────▼──────────────────────────────┐   │
│  │ Coverage gate  (lib/agents/categories.ts)                   │   │
│  │ schemaCapabilities → coverageReport → runnableCategories    │   │
│  │ per category: step + {coverage_item}  (grid fills tile-wise)│   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │ runnable: AnomalyCategory[]      │
│  ┌──────────────────────────────▼──────────────────────────────┐   │
│  │ Agent layer  (lib/agents/monitoring.ts)                     │   │
│  │ MonitoringAgent.scan(hooks, runnable) → Anomaly[] (≤6 calls)│   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │ anomalies                        │
│  ┌──────────────────────────────▼──────────────────────────────┐   │
│  │ Mapping layer  (lib/state/insights.ts)                      │   │
│  │ anomalyToInsight → putInsights → listInsights               │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │                                  │
│  ReadableStream NDJSON: {workspace}…{coverage_item}…{insight}…{done} | {error} │
└───────────────────────────────┬────────────────────────────────────┘
                                │ HTTP 200 (x-ndjson)
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

## Implementation in codebase

**File:** `app/page.tsx`
**Function / class:** `HomePage` (default export); the `[mode, ready]` briefing fetch effect
**Line range:** L87–455 (`HomePage`); L248–455 (briefing fetch effect)
**Role:** 2-column layout with a runtime demo/live toggle and dev-only capture button. Resolves `localStorage` `bi:mode` (L119–129), fires the briefing fetch when mode is ready, handles 401+`needsAuth` redirect (L272–277), error display, empty state, the NDJSON live stream, and card render (L682).
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/app/page.tsx#L87-L455

---

**File:** `app/api/briefing/route.ts`
**Function / class:** `GET` (named export); `describeToolCall`; `trunc`; `coverageChecklistSteps`; `maxDuration = 300`; `REPLAY_DELAY_MS = 140`
**Line range:** L75–265
**Role:** The full pipeline: demo short-circuit that now *replays* the snapshot as a paced NDJSON stream (L76–151, `existsSync(DEMO_FILE)` L84, replay loop L97–149 at `REPLAY_DELAY_MS = 140`), API-key guard (L153–155), session + connect wrapped in try/catch (L161–171), 401 gate (L172–174), then a live NDJSON `ReadableStream` (L178–264): bootstrap (L189) + `workspace` event (L190–197), coverage gate `schemaCapabilities`/`coverageReport`/`runnableCategories` + per-category `step`/`coverage_item` (L199–212), `agent.scan(hooks, runnable)` (L223–240), mapping + `insight`/`done` events (L242–246), `error` event on throw (L247–252).
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/app/api/briefing/route.ts#L75-L265

**Briefing route happy path (pseudocode):**
```
GET /api/briefing
  if ?demo=cached && file exists →            // paced NDJSON replay, not a JSON blob
    snapshot = JSON.parse(readFileSync(DEMO_FILE))
    return ReadableStream(NDJSON, REPLAY_DELAY_MS=140 per event):
      send {workspace}
      send {step "matching…checklist"}; for each coverage row: send {step}+{coverage_item}
      for each recorded trace item: send {tool_call_start}/{tool_call_end} | {step}
      for each insight: send {insight}; send {done}
  if !ANTHROPIC_API_KEY → 500 { error }

  try:                                         // setup throw → real error, not bare 500
    sid  = await getOrCreateSessionId()        // cookie bi_session
    conn = await connectMcp(sid)               // wraps connectMcpInner in withAuthCookies
  catch e → 500 { error: '/api/briefing setup · ' + e.message }
  if !conn.ok → 401 { needsAuth, authUrl }

  return ReadableStream(NDJSON):
    schema    = await bootstrapSchema(mcp)     // module-cached after first call
    send { workspace }
    // coverage gate: match the live schema to the 10-category checklist
    capabilities = schemaCapabilities(schema)
    coverage     = coverageReport(capabilities)     // full | limited | unavailable
    runnable     = runnableCategories(capabilities) // full + limited only
    step('matching…checklist…')
    for each item of coverage: step(line); send { coverage_item: item }
    allTools  = await mcp.listTools()
    agent     = new MonitoringAgent(anthropic, mcp, schema, allTools)
    anomalies = await agent.scan({ onToolCall, onToolResult, onText }, runnable)  // gated; each → BriefingEvent
    insights  = anomalies.map(anomalyToInsight)
    putInsights(insights, anomalies)
    for insight of listInsights(): send { insight }
    send { done }                              // catch → send { error }
```

---

**File:** `lib/mcp/session.ts`
**Function / class:** `getOrCreateSessionId`; `readSessionId`; `sessionCookieOpts`
**Line range:** L10–29 (`sessionCookieOpts` L10–14, `getOrCreateSessionId` L16–24, `readSessionId` L26–29)
**Role:** Reads or creates the `bi_session` cookie that keys all per-session OAuth and MCP state; `sessionCookieOpts` picks `SameSite=None; Secure` in prod (survives the cross-site OAuth round trip), `Lax` in dev.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/session.ts#L10-L29

---

**File:** `lib/mcp/connect.ts`
**Function / class:** `connectMcp` (async, wraps `connectMcpInner` in `withAuthCookies`); `redirectUri` (async, host-based); `completeAuth`; `ConnectResult` type
**Line range:** L31–122 (`redirectUri` L31–52, `connectMcp` L59–64, `connectMcpInner` L66–107, `completeAuth` L114–122)
**Role:** Derives a host-based `redirectUri()` (from `x-forwarded-host` in prod), builds the `StreamableHTTPClientTransport` + `BloomreachAuthProvider`, and returns either a ready `McpClient` or an `authUrl` for redirect — all inside `withAuthCookies` so the prod encrypted-cookie store is seeded/flushed once per request.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/connect.ts#L31-L122

---

**File:** `lib/mcp/schema.ts`
**Function / class:** `bootstrapSchema`; `resolveProject`; `parseWorkspaceSchema`
**Line range:** L170–192 (`bootstrapSchema`); `cached` at L131
**Role:** Module-level cached `WorkspaceSchema` built from four sequential MCP tool calls.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/schema.ts#L170-L192

---

**File:** `lib/agents/monitoring.ts`
**Function / class:** `MonitoringAgent`; `MonitoringAgent.scan`
**Line range:** L61–121 (`scan` L69–120, `maxToolCalls` L101)
**Role:** Runs the agentic Claude loop against MCP tools. `scan(hooks?, categories: AnomalyCategory[] = [])` (L69) builds a per-category checklist from the passed `categories` (the runnable set from the route's coverage gate) and injects it into the prompt (L73–86), then returns sorted `Anomaly[]`.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/monitoring.ts#L61-L121

---

**File:** `lib/agents/categories.ts`
**Function / class:** `schemaCapabilities`; `coverageReport`; `runnableCategories`; `CATEGORIES`
**Line range:** L116–160 (`schemaCapabilities` L116–127, `coverageReport` L144–155, `runnableCategories` L158–160; `CATEGORIES` registry L19–112)
**Role:** The coverage gate (hop 5.5). `schemaCapabilities` flattens the schema into a capability `Set`; `coverageReport` classifies each of the 10 `CATEGORIES` as `full`/`limited`/`unavailable`; `runnableCategories` returns the `full` + `limited` ones that the route hands to `MonitoringAgent.scan`.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/categories.ts#L116-L160

---

**File:** `lib/state/insights.ts`
**Function / class:** `anomalyToInsight`; `putInsights`; `listInsights`
**Line range:** L8–53 (`anomalyToInsight` L8–27, `putInsights` L29–41, `listInsights` L51–53)
**Role:** In-process `Map`-backed store; `anomalyToInsight` maps `Anomaly` → `Insight` with a headline and UUID, and also sets `impact`, `history`, and spreads `...deriveInsightFields(a)`.
**GitHub:** https://github.com/rlynjb/blooming_insights/blob/main/lib/state/insights.ts#L8-L53

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

- **Serverless function lifetime.** The module-level `cached` in `schema.ts` (L131) and the in-process `Map`s in `insights.ts` (L4–6) are process-scoped. On Vercel, each function invocation may land on a different cold container. Two users may each pay the full schema bootstrap cost, and `listInsights()` returns only the insights from the current invocation — not a shared store.
- **The 300-second ceiling.** `maxDuration = 300` (route.ts L17) is Vercel Pro's hard function limit (Hobby is 60 s). At ~1 req/s MCP rate and 4 schema calls + up to 6 agent calls + 8 Claude turns, the budget is comfortable but finite. A slow network or a verbose Claude response eats into it.
- **OAuth state across invocations.** The PKCE verifier and client info written during `connectMcp` live in the `BloomreachAuthProvider`'s in-memory store. If the OAuth callback lands on a different Vercel function instance, the verifier is gone and `completeAuth` fails.

### What to explore next

- `02-oauth-boundary.md` → how the `BloomreachAuthProvider` captures the PKCE flow and why in-memory persistence breaks across serverless invocations
- `04-caching-and-rate-limiting.md` → the module-level schema cache, `McpClient`'s 60-second response cache, and the 1100 ms rate-limit interval
- `05-streaming-ndjson.md` → the query box uses a different path (streaming NDJSON) instead of a single JSON response — same layered pattern but the response shape is a stream

---

## Interview defense

### What an interviewer is really asking

When they ask "walk me through the request flow," they are checking whether you know: (a) where each await crosses a subsystem boundary, (b) what fails at each boundary and what the error shape is, (c) where state lives and what resets it, (d) what the latency budget is and what eats it. They are not asking for a description of the UI.

### Likely questions

**[mid] "What happens if the user has no session cookie?"**

`getOrCreateSessionId` in `lib/mcp/session.ts` (L16–24) writes a new `bi_session` cookie on the first call. That cookie is immediately used as the key for `connectMcp`. Since there are no stored tokens for a new session id, `connectMcp` returns `{ok: false, authUrl}`. The route returns 401 with `{needsAuth: true, authUrl}`. The page checks `res.status === 401 && body.needsAuth` (`app/page.tsx` L272) and redirects the browser. At scale this means every new visitor pays an OAuth round-trip before seeing any data — the production fix (the encrypted-cookie store) lets sessions survive across serverless instances.

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

`bootstrapSchema` stores its result in a module-level `let cached` (`lib/mcp/schema.ts` L131). Within a single Node process (a warm Vercel function), the second request skips all four MCP calls. The problem: Vercel runs multiple function instances concurrently. Two cold-start invocations each pay the full 4-call schema cost independently, and there is no consistency guarantee between them. If the schema changes between invocations the two instances serve different data. The fix is a shared external cache (KV/Redis) keyed to the project id with a TTL. I would prioritize this as soon as traffic exceeds one warm instance.

```
Instance A (cold)               Instance B (cold, concurrent)
  bootstrapSchema                 bootstrapSchema
  └─ 4 MCP calls → cached_A       └─ 4 MCP calls → cached_B
                                          ↑
                                    independent — may differ
```

**[arch] "How does this design hold up at 100 concurrent users?"**

At 100 concurrent users, 100 function invocations fire simultaneously. Each calls `connectMcp` which opens a `StreamableHTTPClientTransport` to the Bloomreach MCP server. The MCP server enforces ~1 req/s per user globally (verified, `connect.ts` L81–88). At 100 users, even if each session is distinct, the total MCP call volume is 100 × (4 schema + up to 6 agent) = 1,000 calls. The 1100 ms client-side spacing is per-session, not global — it prevents one session from exceeding the limit but does not coordinate across sessions. The MCP server will return 429s. The `McpClient` parses the stated window from each 429 and waits it out on retry (`connect.ts` L92–95), but that serializes rather than scales. The 300-second `maxDuration` buys headroom but does not solve the cross-session contention. The correct architecture at this scale: a cron job precomputes insights into a durable store (database or blob), the route reads from that store, and the MCP connection is made once per cron tick, not per user.

```
100 concurrent users
  │
  100 × connectMcp ──► Bloomreach MCP (~1 req/s limit)
  │                         │
  │                    429 Too Many Requests
  │                         │
  100 × route timeout ◄────┘  (before 300 s maxDuration)
  │
  fix: cron → durable store → route reads store
       (MCP called once/tick, not once/user)
```

### The question candidates always dodge

**"Why run the monitoring agent live on every page load instead of precomputing it?"**

The honest answer: per-request gives live data with no additional infrastructure — no cron, no durable store, no staleness communication to the user. For a project at early/demo scale with one to a few users, this is the right tradeoff. The `maxDuration = 300` and the `?demo=cached` short-circuit both exist because the authors knew this was the constraint. The precompute path was deferred, not ignored — the demo file (`lib/state/demo-insights.json`) is exactly what a cron output would look like. The breakpoint is clearly identified: when concurrent users push MCP into 429s or when the 300-second limit is regularly hit, you switch. At current scale neither has happened.

```
per-request (current)       precomputed (deferred)
─────────────────────────   ──────────────────────────────
live data every load         stale by cron interval
no extra infra               cron + durable store + TTL
300s ceiling is a wall       ~100ms read is a floor
1 user: fine                 1000 users: fine
100 users: breaks            100 users: fine (1 MCP session)
```

### One-line anchors

- `maxDuration = 300` (Vercel Pro) is not a performance target — it is a hard ceiling that the pipeline was designed to fit under.
- `getOrCreateSessionId` makes the cookie on first visit; `connectMcp` makes it meaningful by binding OAuth tokens to it.
- `bootstrapSchema`'s `cached` variable is process-scoped state — it does not survive a cold start.
- The 401 response with `{needsAuth, authUrl}` is a structured gate, not an error — the page uses it to redirect rather than display an error message.
- The demo short-circuit at L76–151 of `route.ts` is structurally identical to what a precomputed-feed architecture would look like at the route level — it replays a committed snapshot as NDJSON instead of computing it live.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the full pipeline from `useEffect` to card render as a vertical sequence of boxes. Label every box with a function name. Draw the demo short-circuit as a branch. Draw the 401 as a branch. Check your diagram against the primary diagram in `## Request flow — diagram`.

### Level 2 — Explain it out loud

Work through these checkpoints without looking at the file:

- [ ] What state value does `HomePage` start with, and what triggers the `fetch`? (`app/page.tsx` L88, L248)
- [ ] What are the three possible outcomes of `connectMcp`, and what does the route do for each? (`app/api/briefing/route.ts` L161–174, `lib/mcp/connect.ts` L89–106)
- [ ] What does `bootstrapSchema` return on a warm function, and what does it call on a cold start? (`lib/mcp/schema.ts` L170–192)
- [ ] What is the maximum number of MCP tool calls the agent will make, and where is that limit set? (`lib/agents/monitoring.ts` L101)
- [ ] What does the route return when the agent produces no parseable anomaly array? (`lib/agents/monitoring.ts` L112–119, `lib/state/insights.ts` L51–53)

### Level 3 — Apply it to a new scenario

Scenario: You add a second agent that runs after `MonitoringAgent.scan` and calls three more MCP tools. Estimate whether it fits within the existing `maxDuration = 300` budget.

Check your reasoning against `app/api/briefing/route.ts` L17 for the budget and `lib/mcp/connect.ts` L81–95 for the rate-limit spacing. Three additional MCP calls at 1100 ms each = 3.3 seconds minimum added to the pipeline. If the monitoring agent already uses 6 calls (6 × 1.1 s = 6.6 s) plus schema (4 × 1.1 s = 4.4 s) plus Claude latency (estimate 5–15 s per turn × up to 8 turns), the budget is already tight. The second agent's 3 calls add 3.3 s plus its own Claude turns. You need to reduce `maxToolCalls` or `maxTurns` on one of the agents, or run them concurrently (requires careful MCP rate-limit coordination), or move one to a separate route.

### Level 4 — Defend the decision you'd change

The in-process `Map`s in `lib/state/insights.ts` (L4–6) are not shared across Vercel function instances. Two concurrent requests each get their own `insights` map and `listInsights()` returns only the current invocation's insights — not a merged view. `putInsights` followed by `listInsights` in the same request is fine, but any design that expects insights to persist between requests (e.g., a follow-up query that references a previous briefing's insights by id) will silently return nothing on a different instance. The fix: replace the in-process maps with a durable KV store keyed by session id. Defend why the current design was acceptable at launch and where it breaks.

### Quick check — code reference test

Without reading the file, answer:

1. What is the exact cookie name used by `getOrCreateSessionId`? (Check: `lib/mcp/session.ts` L3)
2. What HTTP status does the route return when `conn.ok` is false? (Check: `app/api/briefing/route.ts` L172–174)
3. What is the hard limit on MCP tool calls inside `MonitoringAgent.scan`? (Check: `lib/agents/monitoring.ts` L101)
4. What does the route export to tell Vercel the function timeout? (Check: `app/api/briefing/route.ts` L17)
5. What file does the demo path read from, and where is the path constructed? (Check: `app/api/briefing/route.ts` L19 (`DEMO_FILE`), L84–87)

## See also

→ 02-oauth-boundary.md · → 04-caching-and-rate-limiting.md · → 05-streaming-ndjson.md

---
Updated: 2026-05-28 — re-derived all "In this codebase" line refs; route now streams NDJSON (`describeToolCall`/`trunc`, no `summarizeTrace`) with `maxDuration = 300`; `connectMcp` is async and wrapped in `withAuthCookies`; setup is in a try/catch returning the real error; noted the runtime `localStorage` `bi:mode` demo/live toggle and `anomalyToInsight`'s `impact`/`history`/`deriveInsightFields`.

---
Updated: 2026-05-29 — added Hop 5.5 coverage gate (`schemaCapabilities`/`coverageReport`/`runnableCategories`, `categories.ts`) with ASCII diagram + folded it into the primary diagram, pseudocode, and Summary; documented the demo path as a paced NDJSON replay (`REPLAY_DELAY_MS = 140`) instead of a plain-JSON blob; updated `MonitoringAgent.scan(hooks, runnable)` to its gated 2-arg signature; re-derived all `route.ts` (now L75–265) and `monitoring.ts` (now L61–121) line refs against the grown files.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
