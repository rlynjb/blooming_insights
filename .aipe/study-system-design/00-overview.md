# Overview — the system map

**Industry name(s):** system map · component diagram · trust-and-data topology
**Type:** Industry standard · Language-agnostic

> blooming insights is a **Next.js 16 (App Router) app that hangs four Claude agents off one MCP server, with no database**. The whole architecture earns its weight from three load-bearing pieces: `runAgentLoop` (one function, four agents), `McpClient` (the single MCP choke-point — cache + spacing + retry), and the route-level NDJSON streams that turn long agent runs into a UI that's *visibly working* before it's done. The most surprising choice is the deliberate absence of a database — state lives in in-memory `Map`s plus an encrypted-cookie auth store plus committed demo JSON. That choice buys deploy simplicity at hackathon scale and silently costs durability across Vercel instances; everything in this guide follows from that decision.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Four bands. The **UI** is two pages (`app/page.tsx` feed, `app/investigate/[id]/page.tsx` investigation) plus a hook (`useInvestigation`) that reads NDJSON from a `fetch` body. The **route layer** is three handlers (`/api/briefing`, `/api/agent`, `/api/mcp/*`) that each open a `ReadableStream`, run an agent, and emit one JSON line per progress event. The **agent layer** is one shared loop (`runAgentLoop`) plus four agent classes (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`) — each is `prompt + tool subset + validator + dedicated synthesis call`. The **provider/transport** layer is `McpClient` wrapping `McpTransport` wrapping the MCP SDK, with `BloomreachAuthProvider` (OAuth PKCE + DCR) sitting under it. The external world is the Bloomreach loomi-connect MCP server (rate-limited ~1 req/s/user) and the Anthropic API (the reasoning engine).

```
  blooming insights — the whole system in one frame

  ┌─ UI (Next.js 16 App Router, React 19, client components) ──────────────────┐
  │                                                                            │
  │   app/page.tsx          app/investigate/[id]/page.tsx        QueryBox      │
  │   feed + status         /diagnose + /recommend trace          ?q=          │
  │        │  fetch /api/briefing      │ useInvestigation(id,step) │            │
  │        │  (or ?demo=cached)        │ → /api/agent?step=…      │            │
  └────────│───────────────────────────│──────────────────────────│────────────┘
           │                           │                          │
           ▼  Network boundary (HTTPS · NDJSON · chunked stream)   ▼
  ┌─ Route layer (Next route handlers, maxDuration = 300s) ────────────────────┐
  │                                                                            │
  │   /api/briefing          /api/agent (NDJSON)         /api/mcp/*            │
  │   monitoring scan        diagnose|recommend|combined  callback · call ·    │
  │   coverage gate first    cache-replay  ▲  live agent  tools · capture      │
  │        │                    │ filterByStep(events,step)   │                 │
  │        ▼                    ▼                              │                 │
  │   ┌──────────────────────────────────────────────────────────────┐         │
  │   │ lib/agents/base.ts  runAgentLoop  (shared Claude tool loop)  │         │
  │   │   4 callers · monitoring · diagnostic · recommendation · query │         │
  │   │   each = prompt + tool subset + validator + synthesize() fallback│         │
  │   └────────────────────────┬─────────────────────────────────────┘         │
  │        Anthropic SDK       │ McpClient.callTool                            │
  │        (claude-sonnet-4-6) ▼                                                │
  │   ┌─ Provider/transport seam ───────────────────────────────────┐          │
  │   │ lib/mcp/client.ts     McpClient  (TTL cache + ~1.1s spacing  │          │
  │   │                                    + bounded retry on 429)   │          │
  │   │ lib/mcp/transport.ts  McpTransport ⇠ SdkTransport (+ fakes)  │          │
  │   │ lib/mcp/connect.ts    connectMcp / completeAuth              │          │
  │   │ lib/mcp/auth.ts       BloomreachAuthProvider (PKCE + DCR)    │          │
  │   └────────────────────────┬─────────────────────────────────────┘          │
  └────────────────────────────│───────────────────────────────────────────────┘
                               │  HTTPS + Bearer (per-user OAuth token)
  ┌─ State (process-local) ────┴──┐   ┌─ External providers ─────────────────┐
  │ lib/state/insights.ts          │   │ Bloomreach loomi-connect MCP server  │
  │ lib/state/investigations.ts    │   │   (StreamableHTTPClientTransport,    │
  │   in-memory Map + dev file      │   │    ~1 req/s/user GLOBAL limit)       │
  │   + committed demo-*.json       │   │ Anthropic API (claude-sonnet-4-6)    │
  │   + module-cached schema        │   └──────────────────────────────────────┘
  └─────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this whole guide answers is: *where do data, state, and work live in blooming insights, how do they move, where do the boundaries fail, and what changes at 10x?* Every other file picks one audit lens (system map, request/response, state ownership, caching, storage, failure, scale, red flags) and walks that lens across this map. By the end you should be able to point at any box, name what it owns, name what crosses each arrow, and predict what breaks first when the load goes up.

---

## Structure pass

**Layers.** Four. UI · Route · Agent loop · Provider/transport. The UI is React state machines; the routes are NDJSON-streaming handlers; the agent loop is `runAgentLoop` driving Claude tool-use; the provider layer is `McpClient` brokering MCP calls with cache + spacing + retry. Two external services hang off the bottom — Bloomreach MCP (data) and Anthropic (reasoning).

**Axis: state ownership.** Hold one question constant across every layer: *who owns the state at this layer, and how long does it live?* This is the right axis for the overview because the codebase's most consequential design choice is the absence of a database — and state ownership is the lens where that choice changes the answer at every altitude. Control would also work, but it'd flatten the storage decision into "the route runs the agent"; trust pops the security boundaries (file 01) but not the storage ones; failure (file 06) is downstream of state — once you know who owns it, you know who can lose it.

**Seams.** Four load-bearing, one cosmetic. **Seam 1 (browser ↔ route)** flips state ownership from "client `useState` + `sessionStorage`" to "server in-memory `Map`" — the only state that survives this seam in production is the encrypted `bi_auth` cookie and whatever the client stashes in `sessionStorage`. **Seam 2 (route ↔ agent loop)** is cosmetic — same process, same `Map`, no flip. **Seam 3 (agent loop ↔ McpClient)** flips control from CODE-decides (the route's fixed pipeline) to MODEL-decides (Claude picks the next tool) — every tool the model chooses crosses this seam. **Seam 4 (McpClient ↔ Bloomreach)** flips state ownership from "ours (cache, lastCallAt counter)" to "Bloomreach's (the actual workspace data, the rate-limit budget)" — and it's where the system is slowest and most failure-prone. **Seam 5 (model output ↔ typed value)** flips trust from "any text Claude emits" to "matches a type guard or hits `FALLBACK`" — covered in depth in `study-security/`, but it's why the agent layer can degrade gracefully.

```
  Structure pass — the ownership topology

  ┌─ 1. LAYERS ───────────────────────────────────────────┐
  │  UI · Route · Agent loop · Provider/transport          │
  │  (+ external: Bloomreach MCP, Anthropic API)           │
  └───────────────────────────┬───────────────────────────┘
                              │  pick the axis
  ┌─ 2. AXIS ────────────────▼────────────────────────────┐
  │  state ownership: who owns it, and how long?           │
  └───────────────────────────┬───────────────────────────┘
                              │  trace it down, mark the flips
  ┌─ 3. SEAMS ───────────────▼────────────────────────────┐
  │  S1: browser → route       (client state → server Map) │
  │  S2: route → agent loop    (cosmetic — same Map)       │
  │  S3: agent loop → McpClient (CODE → MODEL decides)     │
  │  S4: McpClient → Bloomreach (ours → upstream + 429s)  ★│
  │  S5: model → typed value   (text → guard or FALLBACK)  │
  └───────────────────────────┬───────────────────────────┘
                              ▼
                      the eight audit files
                      walk each lens across these layers
```

S4 is the load-bearing seam for system design. It's where the ~1 req/s rate limit lives, it's where every retry adds latency to the 300s budget, and it's the seam that the entire `McpClient` (TTL cache + spacing + bounded retry) exists to defend.

---

## How it works

### Move 1 — the mental model

Three things move through this system, and each one has a different ownership story.

```
  Three things moving, three ownership stories

  REQUESTS    UI → route → agent → McpClient → Bloomreach
              owned by the request lifecycle; gone when it ends

  EVENTS      agent → NDJSON stream → useInvestigation → React state
              owned by the route's `collected: AgentEvent[]` buffer
              + the client's `useState` items array

  STATE       in-memory Map (process) + encrypted cookie (request)
              + committed demo JSON (build) + module-cached schema (process)
              NO database — every layer either holds it briefly or hands it back
```

**Requests** flow top-down once and unwind bottom-up. **Events** stream the other way — every meaningful step in an agent run becomes one JSON line emitted back to the browser. **State** is the surprising one: there's no Postgres, no Redis, no KV. Insights live in a process-local `Map<string, Insight>` until the next briefing replaces them; investigations live in another `Map` until the process restarts; auth lives in an encrypted cookie that survives across requests but not across browsers; the schema lives in a module-level `cached` variable until the process restarts.

### Move 2 — what each band owns

#### The UI band

Two pages and a hook. The feed (`app/page.tsx`) owns ~14 `useState` slots — current insights, workspace metadata, coverage report, status enum, mode toggle (demo vs live), reconnect flag, capture state, trace items, query state. The investigation page (`app/investigate/[id]/page.tsx`) owns the rendered diagnosis + recommendations for one step. The hook (`useInvestigation`) owns the NDJSON parser, the `sessionStorage` stash/hydrate for re-visits, and the `bi:diag:` handoff that carries the diagnosis from step 2 to step 3. Browser-side persistence is `sessionStorage`-only — no IndexedDB, no service worker.

```
  UI band — what it owns

  ┌─ app/page.tsx ────────────────────┐
  │  ~14 useState slots                │
  │  briefing fetch + NDJSON parser    │
  │  reconnect-once policy             │
  │  demo-capture POST                 │
  │  mode toggle (localStorage)        │
  └────────────────────────────────────┘
  ┌─ app/investigate/[id]/page.tsx ───┐
  │  trace + diagnosis + recs          │
  │  uses useInvestigation(id, step)   │
  └────────────────────────────────────┘
  ┌─ lib/hooks/useInvestigation.ts ───┐
  │  startedRef guard (StrictMode)     │
  │  bi:inv:* stash per step           │
  │  bi:diag:* handoff to step 3       │
  └────────────────────────────────────┘
```

#### The route band

Three handlers, all GET, all NDJSON-streaming, all `maxDuration = 300`. `/api/briefing` runs the monitoring agent and emits coverage tiles + insights. `/api/agent` runs the diagnostic + recommendation agents, or replays a cached investigation, or answers a free-form `?q=`. `/api/mcp/*` is OAuth callback + introspection + dev-only capture tools. Every route opens a `ReadableStream`, writes JSON-line events to its controller, and closes on `done` or `error`.

```
  Route band — what it owns

  /api/briefing      monitoring scan + coverage gate
                     emits: workspace, coverage_item ×10, tool_*, insight, done
  /api/agent         diagnose|recommend|combined + cache-replay + ?q=
                     emits: reasoning_step, tool_*, diagnosis, recommendation, done
  /api/mcp/callback  OAuth code exchange
  /api/mcp/call      single-tool caller (used by /debug)
  /api/mcp/tools     listTools
  /api/mcp/capture   dev-only — snapshot a briefing
  /api/mcp/capture-demo  dev-only — snapshot an investigation
  /api/mcp/reset     clear auth cookie
```

#### The agent band

One loop, four agents. `runAgentLoop` (lib/agents/base.ts) drives Claude in a multi-turn tool-use conversation: model emits tool_use → loop dispatches through `McpCaller.callTool` → loop appends result as tool_result → loop calls model again. Termination is bounded three ways: `maxTurns` (default 8), `maxToolCalls` (per agent, hard cap), and a *forced final turn* that drops tools and appends a synthesis instruction so the model produces structured output instead of "thinking" forever. The four agents each pick a tool subset, a prompt, an output type guard, and (for diagnostic + recommendation) a dedicated tool-less `synthesize()` fallback if the loop ends without parseable JSON.

#### The provider band

`McpClient` is the single MCP choke-point — every tool call goes through it. It owns three concerns: a TTL cache (default 60s, keyed by tool name + args), proactive ~1.1s inter-call spacing (the Bloomreach server allows ~1 req/s globally per user), and bounded rate-limit retry that parses the server's "Retry after ~N seconds" hint and waits exactly that long. Underneath it sits `McpTransport` (an interface) with `SdkTransport` (production) or test fakes. Under that sits `BloomreachAuthProvider`, which implements the MCP SDK's `OAuthClientProvider` with PKCE + Dynamic Client Registration and a backend chosen by `NODE_ENV` (encrypted cookie in production, file in dev, in-memory in tests).

### Move 3 — the principle

**The architecture's shape comes from one constraint: ~1 req/s/user against Bloomreach.** That single fact explains the TTL cache (don't re-fetch what we just fetched), the proactive spacing (don't get rate-limited), the bounded retries (don't blow the 300s budget when we do), the `maxToolCalls` cap on every agent (an investigation that needs 30 tool calls would take 30+ seconds before counting model latency), the absence of a database (we're a thin agentic shell, not a system-of-record), and the schema-gated coverage check (don't waste tool calls on categories the workspace can't support). Once you see that the whole stack is shaped by one external rate limit, the design choices stop looking unusual and start looking inevitable.

---

## Primary diagram

The full recap visual — every component, every layer, every external dependency, every flow.

```
  blooming insights — the system map, with every arrow labelled

  ┌─ UI (React 19, client components) ─────────────────────────────────────────────┐
  │                                                                                 │
  │   app/page.tsx                  app/investigate/[id]/page.tsx                   │
  │     useState ×14                  useInvestigation(id, step)                    │
  │     fetch(/api/briefing) ──┐        ├─ stash in bi:inv:{step}:{id}              │
  │     NDJSON parser          │        ├─ hand diagnosis → bi:diag:{id}            │
  │     reconnect-once         │        └─ fetch(/api/agent?step=…)                  │
  │     mode = localStorage    │                            │                        │
  └────────────────────────────│────────────────────────────│───────────────────────┘
                               │                            │
                               │ HTTPS + cookies            │ HTTPS + cookies
                               │ (bi_session + bi_auth)     │
                               ▼                            ▼
  ┌─ Route handlers (Next App Router, maxDuration = 300s) ─────────────────────────┐
  │                                                                                 │
  │  /api/briefing                              /api/agent                          │
  │  ┌────────────────────────────┐             ┌─────────────────────────────┐    │
  │  │ withAuthCookies (ALS) →    │             │ if cached && !live → replay │    │
  │  │ connectMcp(sessionId)      │             │   filterByStep(events,step) │    │
  │  │ bootstrapSchema (cached)   │             │ else:                       │    │
  │  │ schemaCapabilities         │             │   connectMcp · schema       │    │
  │  │ coverageReport ×10 tiles   │             │   diag.investigate +        │    │
  │  │ MonitoringAgent.scan(runnable)             │   rec.propose (or step)     │    │
  │  │ for insight: send event     │             │ saveInvestigation if combined│   │
  │  └────────────┬───────────────┘             └─────────┬───────────────────┘    │
  │               │ ReadableStream                          │ ReadableStream         │
  │               │ NDJSON-encoded AgentEvents              │ NDJSON-encoded events │
  └───────────────│─────────────────────────────────────────│────────────────────────┘
                  │                                          │
                  ▼                                          ▼
  ┌─ Agent loop (lib/agents/base.ts · runAgentLoop) ───────────────────────────────┐
  │                                                                                 │
  │   for turn in 0..maxTurns:                                                      │
  │     if forceFinal: drop tools, append synthesisInstruction                      │
  │     anthropic.messages.create(model='claude-sonnet-4-6', ...)                   │
  │     for tool_use in response:                                                   │
  │       mcp.callTool(name, args)  ◄── McpCaller seam (fakeable in tests)         │
  │     append tool_results, loop                                                   │
  │                                                                                 │
  │   four agents: monitoring · diagnostic · recommendation · query                 │
  │   each: prompt + tool subset + type guard (+ synthesize() fallback)             │
  └───────────────────────────┬────────────────────────────────────────────────────┘
                              │  every tool call
                              ▼
  ┌─ McpClient (lib/mcp/client.ts) — the single MCP choke-point ───────────────────┐
  │                                                                                 │
  │   cache  = Map<"${name}:${argsJson}", { result, expiresAt }> · ttl 60s          │
  │   space  = sleep(minIntervalMs - elapsed) before each live call                 │
  │   retry  = while isRateLimited(result) && retries < maxRetries:                 │
  │              wait(parseRetryAfterMs(result) || backoff, capped at ceiling)      │
  │              re-call                                                            │
  │   error  = never cache `isError: true` results                                  │
  └───────────────────────────┬────────────────────────────────────────────────────┘
                              │  McpTransport.callTool
                              ▼
  ┌─ SdkTransport + BloomreachAuthProvider (lib/mcp/transport.ts, lib/mcp/auth.ts)─┐
  │                                                                                 │
  │   StreamableHTTPClientTransport (MCP SDK)                                       │
  │   makeCapturingFetch → records non-OK response bodies for diagnostics           │
  │   OAuthClientProvider impl: PKCE + DCR                                          │
  │     state backend by env: cookie (prod) · file (dev) · memory (test)            │
  └───────────────────────────┬────────────────────────────────────────────────────┘
                              │  HTTPS + Authorization: Bearer <token>
                              ▼
  ┌─ External providers ────────────────────────────────────────────────────────────┐
  │   Bloomreach loomi-connect MCP server                                            │
  │     tools: list_cloud_organizations, list_projects, get_event_schema,            │
  │            get_customer_property_schema, list_catalogs, get_project_overview,   │
  │            execute_analytics_eql, get_segmentation, run_aggregate, …             │
  │     rate limit: ~1 req/s/user GLOBAL (stated as "1 per N seconds" in 429 body)  │
  │                                                                                 │
  │   Anthropic API · model = claude-sonnet-4-6                                     │
  │     reasoning for every agent loop                                              │
  └─────────────────────────────────────────────────────────────────────────────────┘

  ─── state (process-local) ─────────────────────────────────────────────────────────
  lib/state/insights.ts        Map<id, Insight>            replaced each briefing
  lib/state/investigations.ts  Map<id, AgentEvent[]> + dev file + demo-*.json
  lib/mcp/schema.ts            module-level `cached: WorkspaceSchema | null`
  lib/mcp/auth.ts              encrypted bi_auth cookie (prod) / .auth-cache.json (dev)
```

---

## Legend — one line per box

- **app/page.tsx** — the feed (morning briefing). Owns ~14 `useState` slots: status, insights, workspace, coverage, mode, reconnect flag, capture state, trace items. Fetches `/api/briefing` (or `?demo=cached`); parses NDJSON; renders `InsightCard`s; reconnects once on auth failure. → `/api/briefing`, `/api/agent?q=`, `useState`+`sessionStorage`.
- **app/investigate/[id]/page.tsx** — step 2 (diagnosis). Calls `useInvestigation(id, 'diagnose')`; renders the reasoning trace + diagnosis; links to step 3. → `/api/agent`, `useInvestigation`, `sessionStorage` (`bi:diag:`).
- **app/investigate/[id]/recommend/page.tsx** — step 3 (decision). Calls `useInvestigation(id, 'recommend')` with the diagnosis handed over via `sessionStorage`. → `/api/agent`, `sessionStorage` (`bi:diag:`, `bi:insight:`).
- **lib/hooks/useInvestigation.ts** — client NDJSON reader with a started-guard (run-once-per-mount under React StrictMode), per-step stash (`bi:inv:`), and diagnosis handoff (`bi:diag:`). Falls back to `bi:insight:` for cross-Vercel-instance lookup. → `/api/agent`, `sessionStorage`.
- **/api/briefing** — bootstraps the schema, **gates the 10-category anomaly checklist against it** (`coverage`), runs `MonitoringAgent.scan` on only the runnable categories, and streams insights as NDJSON — or, on `?demo=cached`, replays the committed snapshot as a paced NDJSON stream. → `connectMcp`, `bootstrapSchema`, `lib/agents/categories`, `MonitoringAgent`, `lib/state/insights`.
- **/api/agent** — NDJSON stream with a `step` param: `diagnose` runs the diagnostic agent only, `recommend` runs the recommendation agent only (with handed-over diagnosis), `step=null` is the combined run used by demo-capture. Demo replays a cached investigation filtered by step. Also serves `?q=` for free-form queries. → `runAgentLoop`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`, `lib/state/investigations`.
- **/api/mcp/*** — OAuth callback (`completeAuth`), single-tool caller (`call`, used by `/debug`), `listTools`, dev-only `capture` / `capture-demo`, and `reset` (clears auth cookie). → `connectMcp`, `auth.ts`.
- **lib/agents/base.ts `runAgentLoop`** — the one Claude+MCP tool-use loop all four agents share. Bounded by `maxTurns` and `maxToolCalls`; forces a final synthesis turn when the budget is spent. Both Anthropic and MCP are injected (`McpCaller` interface) so tests can run with fakes. → Anthropic SDK, `McpClient` (via `McpCaller`).
- **MonitoringAgent / DiagnosticAgent / RecommendationAgent / QueryAgent** — each is `prompt + filtered tool subset + output type guard + (diagnostic/recommendation) dedicated synthesis call`. Each calls `runAgentLoop` with its own `maxToolCalls` (6, 6, 4, 6). → `runAgentLoop`, `lib/mcp/validate`, `lib/mcp/tools`.
- **lib/agents/categories.ts** — fixed 10-category anomaly checklist (`CATEGORIES`) + a pure schema-capability gate (`schemaCapabilities` → `coverageReport` / `runnableCategories`) that classifies each category `full` / `limited` / `unavailable` against the live schema *before* monitoring spends any budget. Pure, fully unit-tested. → `bootstrapSchema`, `MonitoringAgent.scan`.
- **components/feed/CoverageGrid.tsx** — renders the 10-category coverage grid: clear / amber-limited / firing / dashed ghost tiles, plus pending skeletons while the verdict streams in (`coverage_item`). → consumes the gate's `CoverageReport`.
- **lib/mcp/client.ts `McpClient`** — the single MCP choke-point: TTL cache (60s default), ~1.1s inter-call spacing, bounded rate-limit retry that parses "retry after N seconds", no-cache-on-error. → `McpTransport`.
- **lib/mcp/transport.ts** — `McpTransport` interface + `SdkTransport` (wraps the MCP SDK `Client`) + `makeCapturingFetch` (records non-OK response bodies so tool errors carry the real server text). → MCP SDK.
- **lib/mcp/connect.ts** — `connectMcp(sessionId)` (builds transport + provider, connects, captures authorize URL on auth-failure) and `completeAuth(code)` (callback code exchange). Both wrapped in `withAuthCookies` (no-op in dev/test). → `auth.ts`, MCP SDK.
- **lib/mcp/auth.ts `BloomreachAuthProvider`** — implements the SDK's `OAuthClientProvider` (PKCE + DCR). Session-keyed store, backend chosen by `NODE_ENV`: dev → `.auth-cache.json`; prod → AES-256-GCM encrypted `bi_auth` cookie, seeded/flushed per request via `withAuthCookies` + `AsyncLocalStorage`; tests → in-memory. → MCP SDK auth flow.
- **lib/mcp/schema.ts** — `bootstrapSchema(mcp)` calls four MCP tools in sequence (event schema, customer props, catalogs, overview) and assembles a `WorkspaceSchema`. Cached at module level (process-local) — first request pays, subsequent ones don't. → `McpClient`.
- **lib/state/insights.ts / investigations.ts** — process-local `Map`s; dev file caches; committed `demo-insights.json` / `demo-investigations.json` for the creds-free demo. No database. Each briefing **replaces** the insights map (no append). → routes.
- **Bloomreach loomi-connect MCP** — the data source; every tool call carries `project_id`; **~1 req/sec/user GLOBAL limit** (stated in the 429 body). → via `StreamableHTTPClientTransport`.
- **Anthropic API** — the reasoning engine for every agent. → via `@anthropic-ai/sdk`, model `claude-sonnet-4-6`.

---

## Implementation in codebase

The map above is the index. The eight audit files below each pick one lens and walk it down through these layers. Each file: opens with the verdict, names what's strong and what's weak, and grounds every claim in a `file:line` reference.

| File | Lens | Verdict in one line |
|---|---|---|
| 01 | system-map-and-boundaries | Three real trust/process boundaries; one fake (route→agent is same process); the load-bearing one is McpClient↔Bloomreach (rate limit) |
| 02 | request-response-and-data-flow | Every request is a one-way NDJSON stream with a fixed pipeline outside, a model-decides loop inside, and a cache-replay shortcut at the front |
| 03 | state-ownership-and-source-of-truth | The system-of-record is Bloomreach; everything in-process is derived; the only durable client state is `sessionStorage` + the encrypted auth cookie |
| 04 | caching-and-invalidation | Three caches (TTL 60s in McpClient, module schema, sessionStorage stash) — none have explicit invalidation; restart is the invalidation strategy |
| 05 | storage-choice-and-durability-boundaries | No database; in-memory + cookie + committed JSON; the deliberate choice and its honest cost at instance-cycling |
| 06 | failure-handling-and-reliability | Bounded retry on rate limits; graceful-degrade on every agent output; one reconnect-once policy in the feed; no retry on transport errors |
| 07 | scale-bottlenecks-and-evolution | The 1 req/s rate limit is the first ceiling; in-memory state cycling is the second; the 300s budget is the third — each forces a different next step |
| 08 | system-design-red-flags-audit | Ranked list with file refs; the top three: in-memory state in serverless, single rate-limit retry budget for a 6-call investigation, no observability on the 300s budget |

---

## Elaborate

### Why no database

The system-of-record IS Bloomreach. Every fact the user sees originates there — events, customer properties, catalogs, EQL results. Insights and investigations are *derived artifacts* — the output of running an agent against that data. Adding a database would mean choosing where to draw the freshness line ("how stale can a cached insight be before we re-run the monitoring agent?") which is exactly the question the absence of a DB punts on. The current answer: "re-run on every briefing; the result IS the current feed." That's defensible for hackathon scale; it stops being defensible the moment two users want a shared feed or one user wants to look at last week's anomalies.

### What this map doesn't show

Two things the eight audit files cover but the diagram doesn't make obvious:

- **The model→typed-value gate.** Every agent's output passes through `parseAgentJson` + a type guard (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`) and falls back to a safe default if it doesn't match. This is the load-bearing defense against prompt-injection and against the model just emitting prose instead of JSON. Lives in `lib/mcp/validate.ts` + each agent file's `FALLBACK`.
- **The dedicated synthesis call.** When the agent loop ends without parseable JSON, `DiagnosticAgent.synthesize` and `RecommendationAgent.synthesize` run a separate tool-less Anthropic call that hands the model the evidence it already gathered and asks for the structured answer only. This is duplicated across two agents (a debt called out in `study-software-design/`) but it's *why* an investigation almost always returns something usable instead of silently failing.

### The legacy guide

The earlier `.aipe/study-system-design-dsa/` is now the archive. The legacy `01-system-design/` files (request-flow, oauth-boundary, provider-abstraction, caching-and-rate-limiting, streaming-ndjson, multi-agent-orchestration, client-stream-handoff, schema-gated-coverage) walk each of those *patterns* in mechanism-level depth — they're the right place to look when you want the "how does X work" walkthrough. This new guide treats the same codebase through *audit lenses* — what's strong, what's weak, what changes at scale. The two are complementary; this guide cites the legacy files as evidence rather than re-teaching the mechanism.

---

## Sections

- **[README.md](README.md)** — the eight audit lenses, in reading order.

---

Updated: 2026-06-01 — Initial generation as v1.55 audit-shaped guide; legacy `.aipe/study-system-design-dsa/01-system-design/*` retained as archive (cited, not duplicated).
