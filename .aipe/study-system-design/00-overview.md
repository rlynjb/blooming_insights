# Overview — the system map

**Industry name(s):** system map · component diagram · trust-and-data topology
**Type:** Industry standard · Language-agnostic

> blooming insights is a **Next.js 16 (App Router) app that hangs five Claude agents (from `@aptkit/core@0.3.0`) off a swappable `DataSource` backend, with no database for app state**. The whole architecture earns its weight from FIVE load-bearing pieces: the AptKit agent primitives (`@aptkit/core` provides `AnomalyMonitoringAgent`, `DiagnosticInvestigationAgent`, etc.); three Blooming-owned bridge classes in `lib/agents/aptkit-adapters.ts` that adapt this codebase's Anthropic SDK + DataSource + streaming hooks to AptKit's generic `ModelProvider` / `ToolRegistry` / `CapabilityTraceSink` primitives; `BloomreachDataSource` (the prod MCP choke-point — cache + spacing + retry); the route-level NDJSON streams that turn long agent runs into a UI that's *visibly working* before it's done; and the OAuth-on-Vercel encrypted cookie store that makes per-user MCP sessions survive Vercel's ephemeral instances. The architecture's most consequential 2026-06 changes: the `DataSource` interface (`lib/data-source/types.ts`) — a two-method seam (`callTool`, `listTools`) that lets the SAME agent code drive Bloomreach Engagement OR a Blooming-owned in-process `SyntheticDataSource`, picked at runtime by `bi:mode = 'demo' | 'live-bloomreach' | 'live-synthetic'`; and the AptKit refactor (commit 6e2aaff), which pulled the multi-turn tool-use loop out of `lib/agents/base.ts` into `@aptkit/core` and replaced ~600 LOC of hand-rolled agent code with ~50-LOC bridge classes. The most surprising choice is the deliberate absence of an app-state database — state lives in in-memory `Map`s plus an encrypted-cookie auth store plus committed demo JSON. That choice buys deploy simplicity at hackathon scale and silently costs durability across Vercel instances; everything in this guide follows from that decision.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Four bands. The **UI** is two pages (`app/page.tsx` feed, `app/investigate/[id]/page.tsx` investigation) plus a hook (`useInvestigation`) that reads NDJSON from a `fetch` body. The **route layer** is three handlers (`/api/briefing`, `/api/agent`, `/api/mcp/*`) that each open a `ReadableStream`, branch on `bi:mode` to pick the adapter, run an agent, and emit one JSON line per progress event. The **agent layer** is five thin classes (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`, `IntentAgent`) — each ~50 LOC. Each constructs an AptKit agent from `@aptkit/core@0.3.0` using three Blooming-owned bridge classes in `lib/agents/aptkit-adapters.ts` that adapt Anthropic SDK ↔ `ModelProvider`, `DataSource` ↔ `ToolRegistry`, and streaming hooks ↔ `CapabilityTraceSink`. The **provider/transport** layer is the `DataSource` interface (`callTool`, `listTools`) with two real implementations — `BloomreachDataSource` (wrapping `McpTransport` over HTTPS, with `BloomreachAuthProvider` PKCE+DCR underneath) and `SyntheticDataSource` (in-process, in-memory fixture data, no underlying transport). The external world is the Bloomreach loomi-connect MCP server (rate-limited ~1 req/s/user, only reached in `live-bloomreach` mode) and the Anthropic API (the reasoning engine).

```
  blooming insights — the whole system in one frame

  ┌─ UI (Next.js 16 App Router, React 19, client components) ──────────────────┐
  │                                                                            │
  │   app/page.tsx          app/investigate/[id]/page.tsx        QueryBox      │
  │   feed + status         /diagnose + /recommend trace          ?q=          │
  │   3-way toggle:         useInvestigation(id, step)            (live only)  │
  │   demo | live-bloomreach | live-synthetic                                  │
  │        │  fetch /api/briefing?mode=…                                       │
  │        │  (or ?demo=cached)        │ → /api/agent?step=…                   │
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
  │   ┌─ Agent classes (~50 LOC each, lib/agents/*.ts) ─────────────────────┐  │
  │   │ MonitoringAgent · DiagnosticAgent · RecommendationAgent ·            │  │
  │   │ QueryAgent · IntentAgent                                              │  │
  │   │   each constructs an @aptkit/core agent from three adapter classes:   │  │
  │   │     AnthropicModelProviderAdapter                                     │  │
  │   │     BloomingToolRegistryAdapter                                       │  │
  │   │     BloomingTraceSinkAdapter                                          │  │
  │   │   (defined in lib/agents/aptkit-adapters.ts, ~206 LOC)                │  │
  │   └──────────────────────────┬───────────────────────────────────────────┘  │
  │                               │ AptKit's internal tool-use loop drives:    │
  │        Anthropic SDK ◄────────┤   ModelProvider.complete (Anthropic)       │
  │        (claude-sonnet-4-6)    │   ToolRegistry.callTool (DataSource)       │
  │                               │   CapabilityTraceSink.emit (NDJSON hooks)  │
  │                               ▼                                            │
  │   ┌─ DataSource seam — picked by makeDataSource(mode, sid) ──────────┐    │
  │   │ lib/data-source/types.ts    DataSource interface (callTool, listTools)│
  │   │ lib/data-source/index.ts    makeDataSource(mode, sessionId)         │  │
  │   │                                                                     │  │
  │   │ ┌── live-bloomreach ─────────┐  ┌── live-synthetic (NEW 2026-06) ─┐│  │
  │   │ │ BloomreachDataSource       │  │ SyntheticDataSource             ││  │
  │   │ │ (lib/data-source/          │  │ (lib/data-source/               ││  │
  │   │ │  bloomreach-data-source.ts)│  │  synthetic-data-source.ts)      ││  │
  │   │ │ TTL cache + ~1.1s spacing  │  │ ~516 LOC, IN-PROCESS            ││  │
  │   │ │ + bounded retry on 429     │  │ switch(name) → fixture data     ││  │
  │   │ │      │                     │  │ ~0–1 ms per call                ││  │
  │   │ │      ▼                     │  │ NO transport, NO auth,          ││  │
  │   │ │ McpTransport (lower seam)  │  │ NO rate limit, NO network       ││  │
  │   │ │ SdkTransport ⇠ MCP SDK     │  └─────────────────────────────────┘│  │
  │   │ │      │                     │                                      │  │
  │   │ │ BloomreachAuthProvider     │                                      │  │
  │   │ │ (PKCE + DCR + AES-cookie)  │                                      │  │
  │   │ └────────────────────────────┘                                      │  │
  │   │ lib/mcp/client.ts = backwards-compat shim re-exporting Bloomreach   │  │
  │   └─────────────┬───────────────────────────┬──────────────────────────┘  │
  └─────────────────│───────────────────────────│─────────────────────────────┘
                    │ HTTPS + Bearer             │ (in-process — no network)
                    │ (per-user OAuth token)     │
  ┌─ State (process-local) ────┐                ▼
  │ lib/state/insights.ts       │  ┌─ External providers ───────────────────────┐
  │ lib/state/investigations.ts │  │ Bloomreach loomi-connect MCP server         │
  │   in-memory Map + dev file  │  │   (~1 req/s/user GLOBAL limit)              │
  │   + committed demo-*.json   │  │ Anthropic API (claude-sonnet-4-6)           │
  │   + module-cached schema    │  └─────────────────────────────────────────────┘
  └─────────────────────────────┘
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

Five agents, no shared in-house loop — the multi-turn tool-use loop now lives in `@aptkit/core@0.3.0`. Each Blooming agent class (`lib/agents/{monitoring,diagnostic,recommendation,query,intent}.ts`, ~50 LOC each) constructs the AptKit agent for its role and hands it three Blooming-owned adapter instances. `AnthropicModelProviderAdapter` adapts the Anthropic SDK to AptKit's `ModelProvider` (translates `MessageCreateParams` ↔ `ModelRequest`). `BloomingToolRegistryAdapter` adapts `DataSource` to AptKit's `ToolRegistry` (`callTool` → `dataSource.callTool`). `BloomingTraceSinkAdapter` adapts AptKit's `CapabilityEvent` stream back to Blooming's hooks (`onToolCall`, `onToolResult`, `onText`) so the route's NDJSON producer keeps working unchanged. AptKit handles termination internally (max turns, forced final synthesis); Blooming's domain layer only owns the system prompts, tool schemas, and the back-and-forth `Anomaly`/`Diagnosis`/`Recommendation` type mappings. Legacy hand-rolled implementations are preserved under `*-legacy.ts` for reference, NOT on the active path.

#### The provider band

`BloomreachDataSource` is the MCP choke-point for the `live-bloomreach` mode — every tool call goes through it. It owns three concerns: a TTL cache (default 60s, keyed by tool name + args), proactive ~1.1s inter-call spacing (the Bloomreach server allows ~1 req/s globally per user), and bounded rate-limit retry that parses the server's "Retry after ~N seconds" hint and waits exactly that long. Underneath it sits `McpTransport` (an interface) with `SdkTransport` (production) or test fakes. Under that sits `BloomreachAuthProvider`, which implements the MCP SDK's `OAuthClientProvider` with PKCE + Dynamic Client Registration and a backend chosen by `NODE_ENV` (encrypted cookie in production, file in dev, in-memory in tests). For the `live-synthetic` mode, `SyntheticDataSource` (`lib/data-source/synthetic-data-source.ts`) is the choke-point instead — same `DataSource` interface (`callTool`, `listTools`), but no cache (every call resolves in ~0–1 ms anyway), no spacing (no rate limit to respect), no retry (in-process calls don't fail transiently), and no transport (the data lives in module-level `const` arrays in the same file as the adapter).

### Move 3 — the principle

**The architecture's shape comes from one external constraint and one internal discipline.** The external constraint is ~1 req/s/user against Bloomreach — that single fact explains the TTL cache (don't re-fetch what we just fetched), the proactive spacing (don't get rate-limited), the bounded retries (don't blow the 300s budget when we do), the `maxToolCalls` cap on every agent (an investigation that needs 30 tool calls would take 30+ seconds before counting model latency), the absence of a database (we're a thin agentic shell, not a system-of-record), and the schema-gated coverage check (don't waste tool calls on categories the workspace can't support). The internal discipline is the **"generic primitive + domain adapter"** pattern, applied at TWO seams: at the `DataSource` boundary (one interface, two adapters: Bloomreach over HTTPS, Synthetic in-process), and at the AptKit boundary (`ModelProvider`/`ToolRegistry`/`CapabilityTraceSink` upstream, three Blooming-owned adapter classes that own all the translation). Once you see those two shaping forces, every design choice — including the ones that look unusual at first glance, like the synthetic adapter living next to the production one — starts looking inevitable.

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
- **lib/agents/aptkit-adapters.ts (NEW 2026-06)** — three Blooming-owned bridge classes that adapt this codebase's runtime objects to AptKit's generic primitives. `AnthropicModelProviderAdapter` (Anthropic SDK → `ModelProvider`), `BloomingToolRegistryAdapter` (`DataSource` → `ToolRegistry`), `BloomingTraceSinkAdapter` (Blooming hooks ← `CapabilityTraceSink`). The only file in the codebase that imports BOTH Anthropic SDK types AND `@aptkit/core` types. ~206 LOC. → `@aptkit/core`, `@anthropic-ai/sdk`, `DataSource`. See [11-aptkit-primitive-adapters.md](./11-aptkit-primitive-adapters.md).
- **MonitoringAgent / DiagnosticAgent / RecommendationAgent / QueryAgent / IntentAgent** — each ~50 LOC; constructs the corresponding `@aptkit/core` agent (`AnomalyMonitoringAgent`, `DiagnosticInvestigationAgent`, `RecommendationAgent`, `QueryAgent`, `IntentAgent`) and hands it the three Blooming adapter instances. Owns the per-agent system prompt selection, tool schema filtering, and AptKit-output ↔ Blooming-type mapping. Legacy hand-rolled implementations preserved under `*-legacy.ts`. → `@aptkit/core`, `aptkit-adapters.ts`.
- **lib/agents/categories.ts** — fixed 10-category anomaly checklist (`CATEGORIES`) + a pure schema-capability gate (`schemaCapabilities` → `coverageReport` / `runnableCategories`) that classifies each category `full` / `limited` / `unavailable` against the live schema *before* monitoring spends any budget. Pure, fully unit-tested. → `bootstrapSchema`, `MonitoringAgent.scan`.
- **components/feed/CoverageGrid.tsx** — renders the 10-category coverage grid: clear / amber-limited / firing / dashed ghost tiles, plus pending skeletons while the verdict streams in (`coverage_item`). → consumes the gate's `CoverageReport`.
- **lib/data-source/bloomreach-data-source.ts `BloomreachDataSource`** — the `live-bloomreach` choke-point: TTL cache (60s default), ~1.1s inter-call spacing, bounded rate-limit retry that parses "retry after N seconds", no-cache-on-error. → `McpTransport`.
- **lib/data-source/synthetic-data-source.ts `SyntheticDataSource` (NEW 2026-06)** — the `live-synthetic` choke-point: ~516 LOC, IN-PROCESS. Implements `DataSource`. `callTool` dispatches by tool name to a switch statement that returns module-level fixture data (customers, campaigns, scenarios, segments, catalog items, analytics, segmentations) wrapped in the same `{structuredContent, content}` envelope Bloomreach returns. No transport, no auth, no rate limit, ~0–1 ms per call, deterministic across runs. Also exports `syntheticWorkspaceSchema` (the hardcoded schema `bootstrap()` returns in `live-synthetic` mode). → no dependencies. See [12-synthetic-data-source.md](./12-synthetic-data-source.md).
- **lib/mcp/transport.ts** — `McpTransport` interface + `SdkTransport` (wraps the MCP SDK `Client`) + `makeCapturingFetch` (records non-OK response bodies so tool errors carry the real server text). → MCP SDK.
- **lib/mcp/connect.ts** — `connectMcp(sessionId)` (builds transport + provider, connects, captures authorize URL on auth-failure) and `completeAuth(code)` (callback code exchange). Both wrapped in `withAuthCookies` (no-op in dev/test). → `auth.ts`, MCP SDK.
- **lib/mcp/auth.ts `BloomreachAuthProvider`** — implements the SDK's `OAuthClientProvider` (PKCE + DCR). Session-keyed store, backend chosen by `NODE_ENV`: dev → `.auth-cache.json`; prod → AES-256-GCM encrypted `bi_auth` cookie, seeded/flushed per request via `withAuthCookies` + `AsyncLocalStorage`; tests → in-memory. → MCP SDK auth flow.
- **lib/mcp/schema.ts** — `bootstrapSchema(mcp)` calls four MCP tools in sequence (event schema, customer props, catalogs, overview) and assembles a `WorkspaceSchema`. Cached at module level (process-local) — first request pays, subsequent ones don't. → `McpClient`.
- **lib/state/insights.ts / investigations.ts** — process-local `Map`s; dev file caches; committed `demo-insights.json` / `demo-investigations.json` for the creds-free demo. No database. Each briefing **replaces** the insights map (no append). → routes.
- **Bloomreach loomi-connect MCP** — the data source; every tool call carries `project_id`; **~1 req/sec/user GLOBAL limit** (stated in the 429 body). → via `StreamableHTTPClientTransport`.
- **Anthropic API** — the reasoning engine for every agent. → via `@anthropic-ai/sdk`, model `claude-sonnet-4-6`.

---

## Implementation in codebase

The map above is the index. **Reading order:** start with [audit.md](./audit.md) — Pass 1, one section per lens, the one-pass survey of the architecture against the 8-lens inventory. Then drop into the Pass 2 pattern files — each picks one named architectural pattern this codebase actually exercises and walks the mechanism in mechanism-level depth.

| File | Type | What you get |
|---|---|---|
| [audit.md](./audit.md) | Pass 1 audit | 8 lens sections + ranked top-3 findings. Verdict-first, cross-linked into each pattern file. |
| [01-request-flow.md](./01-request-flow.md) | Pattern | The seven-hop briefing pipeline; gates, layer crossings, the demo short-circuit, the three runtime modes. |
| [02-oauth-boundary.md](./02-oauth-boundary.md) | Pattern | OAuth 2.0 + PKCE + DCR via the MCP SDK's `OAuthClientProvider`; the encrypted-cookie store + ALS pattern that survives Vercel's ephemeral instances. |
| [03-provider-abstraction.md](./03-provider-abstraction.md) | Pattern | Two-seam vertical stack — upper `DataSource` (three implementations: Bloomreach + Synthetic + the abstract interface) + lower `McpTransport` (HTTP-SDK swap, Bloomreach-only); `makeDataSource(mode, sessionId)` factory. |
| [04-caching-and-rate-limiting.md](./04-caching-and-rate-limiting.md) | Pattern | The `BloomreachDataSource.callTool` four-stage funnel: cache check → spacing gate → live call → bounded retry; never cache on error. |
| [05-streaming-ndjson.md](./05-streaming-ndjson.md) | Pattern | Producer/consumer over `ReadableStream`; the `AgentEvent` discriminated union; line-buffering kernel; why `fetch`-stream and not `EventSource`. |
| [06-multi-agent-orchestration.md](./06-multi-agent-orchestration.md) | Pattern | Five agents from `@aptkit/core`, bridged through three Blooming-owned adapter classes; per-agent prompt/tool subset; same agents over swappable `DataSource`. |
| [07-client-stream-handoff.md](./07-client-stream-handoff.md) | Pattern | The `useInvestigation` hook: `startedRef` StrictMode latch + four `sessionStorage` keys that bridge boundaries the server can't. |
| [08-schema-gated-coverage.md](./08-schema-gated-coverage.md) | Pattern | The pure schema-capability gate that scopes monitoring's tool-call budget to runnable categories before any EQL fires. |
| [11-aptkit-primitive-adapters.md](./11-aptkit-primitive-adapters.md) | Pattern | The three adapter classes (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`) that translate Blooming runtime objects into AptKit's generic primitives. The senior "generic primitive + domain adapter" pattern. |
| [12-synthetic-data-source.md](./12-synthetic-data-source.md) | Pattern | The Blooming-owned in-process synthetic adapter — same `DataSource` interface as Bloomreach, no OAuth/network/rate-limit; the "two adapters, one interface, different failure modes" lesson. |
| [09-eval-pipeline.md](./09-eval-pipeline.md) | RETIRED | Historical artifact (eval suite removed in PR #8, 2026-06-18). Banner preserved. |
| [10-authored-mcp-server.md](./10-authored-mcp-server.md) | RETIRED | Historical artifact (Olist MCP server removed in PR #8, 2026-06-18). Banner preserved. |

---

## Elaborate

### Why no database

The system-of-record IS Bloomreach. Every fact the user sees originates there — events, customer properties, catalogs, EQL results. Insights and investigations are *derived artifacts* — the output of running an agent against that data. Adding a database would mean choosing where to draw the freshness line ("how stale can a cached insight be before we re-run the monitoring agent?") which is exactly the question the absence of a DB punts on. The current answer: "re-run on every briefing; the result IS the current feed." That's defensible for hackathon scale; it stops being defensible the moment two users want a shared feed or one user wants to look at last week's anomalies.

### What this map doesn't show

Two things `audit.md` covers but the diagram doesn't make obvious:

- **The model→typed-value gate (now inside AptKit).** Every agent's output passes through AptKit's typed return shapes (`MonitoringAnomaly`, `DiagnosticDiagnosis`, etc.); the Blooming agent class maps each back to the Blooming domain type (`Anomaly`, `Diagnosis`). The validation + fallback discipline used to live in `lib/mcp/validate.ts` + each agent file's `FALLBACK`; with the AptKit refactor it moved upstream into `@aptkit/core` (the legacy version is preserved under `lib/agents/legacy-validate.ts` for reference). → see `audit.md` (failure-handling-and-reliability lens, path 3) and [06-multi-agent-orchestration.md](./06-multi-agent-orchestration.md).
- **The two-seam adapter pattern, applied twice.** The codebase teaches the same lesson at two altitudes. (1) `DataSource` is a thin Blooming-owned interface; two adapters (`BloomreachDataSource` over HTTPS+OAuth, `SyntheticDataSource` in-process) satisfy it; a factory picks one at request time. (2) `@aptkit/core` exports thin generic interfaces (`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`); three Blooming adapter classes satisfy them with this codebase's runtime objects (Anthropic SDK, DataSource, streaming hooks). Same shape, two boundaries. → see [03-provider-abstraction.md](./03-provider-abstraction.md), [11-aptkit-primitive-adapters.md](./11-aptkit-primitive-adapters.md), [12-synthetic-data-source.md](./12-synthetic-data-source.md).

### The legacy archive

The earlier `.aipe/study-system-design/` is preserved as the curriculum-DSA companion. Its `02-dsa/*` files teach mechanism-level depth for primitives (TTL cache, line-buffering, rate-limit retry, JSON-from-prose, set-membership coverage gate) — the pattern files in this guide cite them when DSA depth is useful. Its `01-system-design/*` files are the source the Pass 2 pattern files in *this* guide were promoted from; refer to the in-guide versions ([01-request-flow.md](./01-request-flow.md) … [08-schema-gated-coverage.md](./08-schema-gated-coverage.md)) — they carry the same content with refreshed cross-links into `audit.md`.

---

## Sections

- **[README.md](README.md)** — reading order: audit.md first, then the 10 discovered-pattern files.

---
