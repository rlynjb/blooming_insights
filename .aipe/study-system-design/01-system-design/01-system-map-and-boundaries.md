# System map and boundaries

**Industry name(s):** component diagram · context diagram · trust-and-process boundary map
**Type:** Industry standard · Language-agnostic

> blooming insights has **four process layers and three real boundaries that matter**. The boundaries are: browser↔route (network + cookies + trust), McpClient↔Bloomreach (the rate-limited HTTPS hop that the entire stack is shaped around), and model output↔typed value (the prompt-injection containment that lets the agent layer fail gracefully). Inside the server, route↔agent loop is cosmetic — same process, same `Map`, no flip. The architecture is small *on purpose*; the boundaries that exist do real work.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Boundaries are the most consequential thing in a system map. Inside a boundary, you can refactor freely; across one, you have to maintain a contract. Most "systems" people draw have ten components and three boundaries — blooming insights has five major components and three load-bearing boundaries plus one cosmetic one. Naming which is which is the whole point.

```
  Zoom out — where this concept lives                ← we are here (the whole map)

  ┌─ UI ──────────────────────────────────────────────┐
  │   app/page.tsx · app/investigate/[id]/page.tsx     │
  └────────────────────────┬───────────────────────────┘
                           │  ★ B1 ★  browser → route
                           ▼
  ┌─ Route handlers ──────────────────────────────────┐
  │   /api/briefing · /api/agent · /api/mcp/*          │
  └────────────────────────┬───────────────────────────┘
                              cosmetic — same process
  ┌─ Agent loop ──────────────────────────────────────┐
  │   runAgentLoop · 4 agent classes                   │
  └────────────────────────┬───────────────────────────┘
                           │  CODE → MODEL (intra-process control flip)
  ┌─ Provider/transport ──────────────────────────────┐
  │   McpClient · McpTransport · OAuth provider        │
  └────────────────────────┬───────────────────────────┘
                           │  ★ B2 ★  process → Bloomreach (HTTPS, rate-limited)
                           ▼
  ┌─ External ────────────────────────────────────────┐
  │   Bloomreach MCP server · Anthropic API            │
  └───────────────────────────────────────────────────┘

           agent output text  ★ B3 ★  → type-guard → typed value or FALLBACK
```

**Zoom in — narrow to the concept.** The question is: *for every component on the map, what does it own, what does it depend on, and which boundary does it sit behind?* That answer is the contract — change one component's internals and the other side shouldn't notice; change a contract and you've made a system change. The rest of this file names every component, every boundary, what crosses it, what enforces it, and where it can be tampered with.

---

## Structure pass

**Layers.** Five bands. UI · Route · Agent loop · Provider/transport · External. The middle three live in one Node process per Vercel instance. The first lives in a browser. The last lives across the internet.

**Axis: trust.** Hold one question constant across the bands: *what can each side see, what can each side tamper with, and what enforces the assumption?* Trust is the right axis for the boundary map because trust flips are exactly what makes a boundary load-bearing — a "boundary" with no trust flip is cosmetic (route↔agent loop sits across no boundary at all; they're the same code reading the same `Map`). Control is downstream of trust here — control flips inside the process (CODE↔MODEL inside the agent loop) but trust doesn't, because the model has no privileged access. State ownership (file 03) is the next axis to apply.

**Seams.** Three load-bearing, one cosmetic, one intra-process.

- **B1: Browser → Route.** Trust flips from HOSTILE (user controls everything they send) to OURS (our process). Enforced by httpOnly cookies (`bi_session`, AES-256-GCM encrypted `bi_auth`) and by typed query params in the route handlers.
- **B2: Provider → Bloomreach.** Trust flips from OURS to UPSTREAM (Bloomreach owns authz). Enforced by a per-user OAuth Bearer token plus the read-only tool whitelist in `lib/mcp/tools.ts`. This is the load-bearing system-design boundary because it's the only place latency is bounded by something we don't control (the ~1 req/s rate limit).
- **B3: Model output → typed value.** Trust flips from UNTRUSTED text to TYPED value. Enforced by `parseAgentJson` + a type guard per agent shape; mismatch → `FALLBACK`. Covered in depth by `study-security/`, but it's the reason the agent layer can degrade gracefully when the model emits garbage.
- **Cosmetic: Route → agent loop.** Same process, same memory, no flip. The "boundary" here is just a function call.
- **Intra-process: pipeline → agent loop (control flip).** Control flips from CODE-decides (the route's fixed schema → coverage → scan order) to MODEL-decides (Claude picks which tool to call next). Not a trust boundary — the model has no privileged access — but architecturally important and covered in file 02.

```
  Structure pass — the boundaries

  ┌─ 1. LAYERS ─────────────────────────────────────────────────┐
  │  UI · Route · Agent loop · Provider/transport · External      │
  └─────────────────────────────┬────────────────────────────────┘
                                │
  ┌─ 2. AXIS ───────────────────▼────────────────────────────────┐
  │  trust — who can see/tamper, what enforces the assumption     │
  └─────────────────────────────┬────────────────────────────────┘
                                │
  ┌─ 3. SEAMS ──────────────────▼────────────────────────────────┐
  │  B1: browser → route        (HOSTILE → OURS)        ★         │
  │  B2: provider → Bloomreach  (OURS → UPSTREAM)       ★ load-bearing│
  │  B3: model → typed value    (UNTRUSTED → TYPED)     ★         │
  │  cosmetic: route → agent loop (same process)                   │
  │  intra: pipeline → loop      (CODE → MODEL control)            │
  └───────────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

The system has the shape of a funnel that crosses two real boundaries on the way down and one on the way back up. Down: browser → route (B1) → agent loop → McpClient → Bloomreach (B2). Up: model text → type guard (B3) → NDJSON event → React state. Everything else inside the server is *one process talking to itself* — same `Map`s, same module cache, same `AsyncLocalStorage` context.

```
  The funnel — three boundaries crossed twice

  request                                  response

  Browser ─────► Route                     React  ◄───── NDJSON event
              ★ B1 (cookies)                                       ▲
              ▼                                                    │
  Route   ──── Agent loop  (same process — no boundary)            │
              ▼                                                    │
  Agent ─────► McpClient ─────► Bloomreach                         │
              ▼               ★ B2 (rate-limit)                    │
              │                                                    │
  Agent ◄───── model text                                          │
              ★ B3 (type guard)                                    │
              ▼                                                    │
  typed value or FALLBACK ─────────────────────────────────────────┘
```

### Move 2 — every component, what it owns

#### The UI band

**`app/page.tsx`** — the feed page. Owns: ~14 `useState` slots (status enum, insights array, workspace info, coverage report, mode toggle, reconnect flag, capture state, trace items, query state). Depends on: `/api/briefing` (NDJSON), `/api/agent?q=` (NDJSON for queries), `sessionStorage` (insight handoff to `/investigate`), `localStorage` (mode).

```
  app/page.tsx — what's in the box

  ┌──────────────────────────────────────────────────────┐
  │  client component                                     │
  │                                                       │
  │  state:        status, insights, workspace, coverage, │
  │                mode, reconnecting, capturing, trace,  │
  │                queryCount, errorMessage, …            │
  │                                                       │
  │  effects:      first-mount briefing fetch             │
  │                NDJSON line parser                     │
  │                reconnect-once on 401                  │
  │                                                       │
  │  outputs:      <InsightCard>, <CoverageGrid>,         │
  │                <QueryBox>, status panel               │
  └──────────────────────────────────────────────────────┘
```

**`app/investigate/[id]/page.tsx`** — the investigation step 2 page (diagnose). Owns the rendered diagnosis + the trace for one step. **`app/investigate/[id]/recommend/page.tsx`** — step 3 (decision); reads the handed-over diagnosis from `sessionStorage`. Both are thin wrappers around **`lib/hooks/useInvestigation.ts`** — the hook that owns NDJSON parsing, the run-once guard (StrictMode), per-step `sessionStorage` stash, and the `bi:diag:` handoff.

#### The route band

Three handlers, all GET, all `maxDuration = 300`. Every one of them is a `ReadableStream<Uint8Array>` that emits JSON-line events to its controller.

```
  Route band — the three handlers

  /api/briefing      monitoring scan → coverage tiles + insights
  /api/agent         diagnose|recommend|combined  +  cache-replay  +  ?q=
  /api/mcp/*         OAuth callback · single-tool call · listTools · capture · reset
```

The shape of each: open stream → connect MCP (auth check) → bootstrap schema → run agent → emit events → close. If anything before the stream throws, return JSON (401 with `needsAuth`, 500 with the real error message). Once the stream opens, errors come back as an NDJSON `{type: 'error', message}` event followed by `done`.

#### The agent band

One function (`runAgentLoop` in `lib/agents/base.ts`) plus four agent classes (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`). Each agent is `prompt template + tool subset + type guard + (diag/rec only) synthesize() fallback`. The loop is shared; the per-agent specialization is the prompt and the tool subset.

```
  Agent band — one loop, four agents

  ┌─ MonitoringAgent ─────────────┐  prompt = monitoring.md
  │  tools = monitoringTools       │  guard = isAnomalyArray
  │  maxToolCalls = 6              │  no synthesize()
  └────────────────────────────────┘
  ┌─ DiagnosticAgent ─────────────┐  prompt = diagnostic.md
  │  tools = diagnosticTools       │  guard = isDiagnosis
  │  maxToolCalls = 6              │  + synthesize() fallback
  └────────────────────────────────┘
  ┌─ RecommendationAgent ─────────┐  prompt = recommendation.md
  │  tools = recommendationTools   │  guard = isRecommendationArray
  │  maxToolCalls = 4              │  + synthesize() fallback
  └────────────────────────────────┘
  ┌─ QueryAgent ──────────────────┐  prompt = query.md
  │  tools = queryTools            │  no guard (returns prose)
  │  maxToolCalls = 6              │  no synthesize()
  └────────────────────────────────┘

  all four → runAgentLoop({ anthropic, mcp, system, userPrompt, toolSchemas, … })
```

#### The provider band

**`McpClient`** — the single MCP choke-point. Every tool call from any agent goes through `mcp.callTool(name, args)`. Owns: a TTL cache (`Map<key, {result, expiresAt}>`, default 60s), proactive ~1.1s inter-call spacing (`lastCallAt` instance variable + `sleep(elapsed - minIntervalMs)`), bounded rate-limit retry (parses "retry after N seconds" from the 429 body and waits exactly that long, capped at `retryCeilingMs`), no-cache-on-error (never poisons the cache with `{isError: true}` results).

**`McpTransport`** — an interface (`callTool`, `listTools`). **`SdkTransport`** is the production implementation that wraps the MCP SDK `Client`. Test fakes implement the same interface — no network, no real API keys. **`BloomreachAuthProvider`** sits under that, implementing the SDK's `OAuthClientProvider` with PKCE + Dynamic Client Registration. Its persistence backend is chosen by `NODE_ENV` — file in dev, in-memory in test, AES-256-GCM-encrypted cookie in production.

```
  Provider band — the layered seam

  caller (any agent)
       │
       ▼
  McpClient.callTool        ← TTL cache + spacing + retry
       │
       ▼
  McpTransport (interface)  ← injectable seam (fakes in tests)
       │
       ▼
  SdkTransport.callTool     ← wraps MCP SDK Client; captures HTTP error bodies
       │
       ▼
  StreamableHTTPClientTransport  ← MCP SDK; needs OAuthClientProvider
       │
       ▼
  BloomreachAuthProvider    ← PKCE + DCR; backend = env-chosen
       │
       ▼
  Bloomreach MCP server (HTTPS + Bearer)
```

#### The external band

**Bloomreach loomi-connect MCP server.** Stateful: holds the workspace data (events, customer properties, catalogs, EQL query results). Owns its own authz. Rate limits per user GLOBALLY at ~1 req/s (the limit is stated in 429 error bodies as `(1 per N second)` — we've observed both `(1 per 1 second)` and `(1 per 10 second)`). Every tool call carries `project_id`.

**Anthropic API.** Stateless: the model returns text given messages. We pin `claude-sonnet-4-6` in `AGENT_MODEL`. No retry logic at the Anthropic boundary — if Anthropic returns an error, the agent loop throws and the route catches it.

### Move 3 — the principle

**A boundary is load-bearing only when an axis flips across it.** Three real boundaries here (B1 trust, B2 trust + rate, B3 trust) and one fake (route↔agent loop, no flip). Most "system maps" you see are over-drawn — every function call gets a box, every module a boundary. The honest map is smaller: name only the boundaries where something contractually changes. For this codebase, that's three. Every later file in this guide picks one axis (state ownership, caching, failure, scale) and walks it across these same three boundaries, finding where the answer flips.

---

## Primary diagram

The full boundary map with every component placed and every boundary labelled with what flips.

```
  System map · boundaries marked · what flips at each one

  ┌─ Browser (UNTRUSTED) ────────────────────────────────────────────────────────┐
  │   app/page.tsx (817 LOC, ~14 useState slots)                                  │
  │   app/investigate/[id]/page.tsx + recommend/page.tsx                          │
  │   lib/hooks/useInvestigation.ts  (started-guard + bi:inv:* + bi:diag:*)       │
  │   user input: ?q=, ?insightId=, ?insight=, ?live=1, sessionStorage values     │
  └─────────────────────────────────────┬─────────────────────────────────────────┘
                                        │  B1 ★  TRUST FLIPS (hostile → ours)
                                        │  enforced by: bi_session (httpOnly UUID),
                                        │  bi_auth (AES-256-GCM, SameSite=None+Secure)
                                        ▼
  ┌─ Route handlers (TRUSTED, our process) — maxDuration = 300s ─────────────────┐
  │   /api/briefing · /api/agent · /api/mcp/{callback,call,tools,capture,reset}   │
  │   each opens a ReadableStream<Uint8Array>; emits NDJSON; closes on done/error │
  │                                                                               │
  │   ┌─ Agent loop (same process — NO BOUNDARY) ──────────────────────────┐    │
  │   │   lib/agents/base.ts · runAgentLoop                                  │    │
  │   │   4 callers: MonitoringAgent · DiagnosticAgent · RecommendationAgent │    │
  │   │              · QueryAgent                                            │    │
  │   │   intra-process: CODE → MODEL control flip at every tool_use turn    │    │
  │   └────────────────────────────┬──────────────────────────────────────┘    │
  │                                │  mcp.callTool(name, args)                   │
  │   ┌─ McpClient (single MCP choke-point) ─────────────────────────────┐     │
  │   │   TTL cache · ~1.1s spacing · bounded retry · no-cache-on-error   │     │
  │   └────────────────────────────┬──────────────────────────────────────┘     │
  │                                │  McpTransport.callTool                       │
  │   ┌─ SdkTransport + AuthProvider ────────────────────────────────────┐     │
  │   │   StreamableHTTPClientTransport + OAuthClientProvider (PKCE+DCR)  │     │
  │   │   backend by env: file (dev) · memory (test) · encrypted cookie (prod)│  │
  │   └────────────────────────────┬──────────────────────────────────────┘     │
  └────────────────────────────────│──────────────────────────────────────────────┘
                                   │  B2 ★  TRUST FLIPS (ours → upstream)
                                   │       + RATE LIMITED (~1 req/s/user)
                                   │  enforced by: per-user OAuth Bearer (Bloomreach owns authz)
                                   │              + read-only tool whitelist
                                   ▼
  ┌─ Bloomreach loomi-connect MCP ───────────────────────────────────────────────┐
  │   stateful — workspace data (events, properties, catalogs, EQL)               │
  │   ~1 req/s/user GLOBAL  (stated as "(1 per N second)" in 429 bodies)          │
  └───────────────────────────────────────────────────────────────────────────────┘

  ─── Side flow — every agent invocation: ───────────────────────────────────────────
  ┌─ Anthropic API ─────────────────────┐
  │   claude-sonnet-4-6                   │
  │   stateless (we pass full msg history)│
  └────┬──────────────────────────────────┘
       │ model text response
       │  B3 ★  TRUST FLIPS (untrusted text → typed value)
       │  enforced by: parseAgentJson + isAnomalyArray / isDiagnosis /
       │              isRecommendationArray + FALLBACK constants
       ▼
  ┌─ Validated artifact ──────────────────┐
  │   Anomaly[] | Diagnosis | Recommendation[]│
  │   → NDJSON event → UI → React state    │
  └───────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

**Use case 1 — fresh browser hits the feed.** B1 enforces: no cookies → route's `connectMcp` returns `{ok: false, authUrl}` → route returns `{needsAuth: true, authUrl}` 401 → page redirects browser to Bloomreach IdP. After login, `/api/mcp/callback` exchanges the code, `saveTokens` writes to ALS-scoped store, response sets the encrypted `bi_auth` cookie. Next briefing request finds tokens and proceeds across B2.

**Use case 2 — agent picks a tool.** The CODE→MODEL intra-process control flip. The route's pipeline (`schema → coverage → scan`) is fixed and deterministic; once `MonitoringAgent.scan` is called, control flips: Claude reads the system + tools + prior messages, decides "I want to run `execute_analytics_eql` with these args," emits a `tool_use` block. The loop dispatches through `mcp.callTool`. The model decides how many turns, when to stop, which tool next. The loop bounds the model with `maxToolCalls` and `forceFinal`.

**Use case 3 — Bloomreach returns 429.** B2 enforcement is upstream (rate limit), but McpClient owns the response. It parses the "retry after ~N seconds" text from the error body, sleeps `N + 500ms`, re-calls. Up to `maxRetries` (default 3), each capped at `retryCeilingMs` (20s). Past that, the error result is returned (not cached, never poisoning future calls) and bubbles up to the agent loop, which surfaces it as `tc.error`.

### Component file index

| Component | File · Function | Lines | What it owns |
|---|---|---|---|
| Feed page | `app/page.tsx` · `HomePage` | L1–L817 | ~14 useState slots, NDJSON parser, reconnect policy, mode toggle, demo capture |
| Investigation step | `app/investigate/[id]/page.tsx` + `recommend/page.tsx` | — | Renders the trace, diagnosis, recommendations |
| Investigation hook | `lib/hooks/useInvestigation.ts` · `useInvestigation` | L37–L216 | StrictMode-safe NDJSON reader; per-step stash; diagnosis handoff |
| Briefing route | `app/api/briefing/route.ts` · `GET` | L75–L265 | Schema bootstrap, coverage gate, monitoring scan, demo replay |
| Agent route | `app/api/agent/route.ts` · `GET` | L112–L268 | Investigation steps, cache-replay, query mode |
| MCP routes | `app/api/mcp/{callback,call,tools,capture,reset}/route.ts` | — | OAuth callback, debug tooling, dev-only capture, auth reset |
| Agent loop | `lib/agents/base.ts` · `runAgentLoop` | L48–L176 | The shared tool-use loop; `McpCaller` seam; `forceFinal` synthesis |
| Monitoring agent | `lib/agents/monitoring.ts` · `MonitoringAgent` | L61–L121 | Coverage-gated 10-category scan |
| Diagnostic agent | `lib/agents/diagnostic.ts` · `DiagnosticAgent` | L37–L127 | Investigate one anomaly; `synthesize()` fallback |
| Recommendation agent | `lib/agents/recommendation.ts` · `RecommendationAgent` | L28–L133 | Propose 2–3 actions; `synthesize()` fallback |
| Query agent | `lib/agents/query.ts` · `QueryAgent` | L15–L49 | Free-form question answering |
| MCP client | `lib/mcp/client.ts` · `McpClient` | L79–L172 | TTL cache + spacing + retry + no-cache-on-error |
| MCP transport | `lib/mcp/transport.ts` · `McpTransport` / `SdkTransport` | L7–L74 | Injectable seam + capturing fetch for diagnostics |
| MCP connect | `lib/mcp/connect.ts` · `connectMcp` / `completeAuth` | L59–L122 | Build transport, surface authUrl, exchange code |
| Auth provider | `lib/mcp/auth.ts` · `BloomreachAuthProvider` + `withAuthCookies` | L86–L218 | PKCE + DCR; env-chosen backend; ALS-scoped cookie pattern |
| Schema bootstrap | `lib/mcp/schema.ts` · `bootstrapSchema` | L170–L196 | 4 sequential MCP calls → `WorkspaceSchema`; module-cached |
| Coverage gate | `lib/agents/categories.ts` · `coverageReport` / `runnableCategories` | L131–L160 | Pure schema-capability classification |
| Insights state | `lib/state/insights.ts` | L1–L68 | In-memory `Map`; replaced each briefing |
| Investigations state | `lib/state/investigations.ts` | L1–L46 | In-memory `Map` + dev file + committed demo JSON |

### Sample — the McpCaller seam in action

```
  lib/agents/base.ts  (lines 16–22)

  export interface McpCaller {
    callTool(
      name: string,
      args: Record<string, unknown>,
      opts?: { cacheTtlMs?: number; skipCache?: boolean },
    ): Promise<{ result: unknown; durationMs: number; fromCache: boolean }>;
  }
       │
       └─ this 3-line interface IS the boundary between the agent loop and
          the MCP transport. McpClient implements it for production; tests
          inject a fake that returns canned results — no network, no API
          keys. Without this interface, every test would need a real MCP
          server. Naming a seam this small is what makes the system testable.
```

---

## Elaborate

### Why route↔agent loop isn't a boundary

In a bigger system you'd see a queue here (Kafka, Redis Streams, SQS) — the route hands off the work, returns 202, the agent runs async, the client polls or subscribes. That'd be a real boundary: process flips, state has to be serialized, failure semantics get harder. We don't have any of that. The route calls `agent.investigate(anomaly, hooks)` synchronously and the hooks fire on the route's controller. Same process, same heap, same `Map`s. Calling it a "boundary" would lie about what changes when you cross it (nothing). Naming it as cosmetic is the honest call.

### What the system map doesn't include

- **No queue.** No background work. Every agent run is in-band with a single HTTP request.
- **No database.** State is process-local + cookie + committed JSON. Covered in file 05.
- **No CDN.** Static assets come from Vercel; the streaming responses are `Cache-Control: no-cache, no-transform` and bypass any CDN buffering.
- **No service worker.** No client-side offline mode; if the network drops mid-stream, the UI shows the partial events and an error.
- **No multi-tenant split.** The session is "this browser" — one Bloomreach OAuth identity per session.

### What changes if a boundary moves

The big lever is the route↔agent loop seam. If you wanted to add a "kick off this investigation and come back to it later" pattern, the cosmetic boundary becomes a real one — you'd need a queue, a worker, a way to look up "where is investigation X right now," and the in-memory `Map` in `lib/state/investigations.ts` would have to move out of the process. That's the migration file 07 (scale) sketches. It's not in scope today because there's no use case for async investigations, but the day there is, this boundary gets promoted from cosmetic to load-bearing.

### Cross-link to legacy patterns

The legacy guide walks each boundary's mechanism in depth. Read those for the "how does X actually work" walkthrough:

- B1 mechanism → `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md` (the OAuth + PKCE + DCR flow + the encrypted-cookie pattern)
- The route↔agent loop control flip → `.aipe/study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md` (one shared loop, four agents, the forced-final turn)
- The provider band's testability → `.aipe/study-system-design-dsa/01-system-design/03-provider-abstraction.md` (the McpTransport / McpCaller / Anthropic-as-a-param seams)
- B2's cache + spacing + retry → `.aipe/study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md`
- B3's enforcement → `.aipe/study-security/00-overview.md` and `study-security/07-llm-and-agent-security.md`

---

## Interview defense

**What they are really asking:** can you name every component in your system, name every boundary, and say what flips at each one — without hand-waving?

---

**[mid] — Walk me through the components in blooming insights.**

Five bands. UI is two pages and a hook. The route layer is three NDJSON-streaming handlers — briefing, agent, and an mcp grab-bag for OAuth callback and dev tooling. Underneath the routes is the agent layer — one shared loop (`runAgentLoop`) plus four agent classes (monitoring, diagnostic, recommendation, query). Underneath that is the provider layer — `McpClient` (TTL cache + spacing + retry) wrapping `McpTransport` (an interface, fakeable for tests) wrapping the MCP SDK with an `OAuthClientProvider` for PKCE + Dynamic Client Registration. External is two services — Bloomreach for the data, Anthropic for the reasoning. No database, no queue, no background workers. The shape is shaped by one constraint: ~1 req/s/user against Bloomreach.

```
  five bands · top-down

  UI       app/page.tsx · investigate/[id]/page.tsx · useInvestigation
  Route    /api/briefing · /api/agent · /api/mcp/*
  Agent    runAgentLoop + 4 classes (monitoring, diagnostic, rec, query)
  Provider McpClient + McpTransport + OAuthClientProvider
  External Bloomreach MCP · Anthropic API
```

---

**[senior] — Which of those boundaries are load-bearing and which are cosmetic?**

Three load-bearing. Browser-to-route is real because trust flips from hostile to ours, enforced by an httpOnly UUID cookie plus an AES-256-GCM-encrypted `bi_auth` cookie that holds OAuth state. Provider-to-Bloomreach is the *most* load-bearing because two things flip: trust (Bloomreach owns authz) and rate (~1 req/s/user is the latency floor for everything we do). Model-output-to-typed-value is the third — text from Claude isn't trusted until `parseAgentJson` and a per-shape type guard accept it, falling back to a safe default otherwise. Route-to-agent-loop is *cosmetic* — same process, same `Map`s, no flip. I name it as cosmetic on purpose because that's the load-bearing decision: there's no queue, no background work, no async handoff. Every agent run is in-band with one HTTP request. The day we need to change that, the cosmetic boundary becomes real.

```
  Real (3)                 Cosmetic (1)
  B1: browser → route      route → agent loop
  B2: McpClient → BR        (same process)
  B3: model → typed value
```

---

**[arch] — What boundary would you add first, and what would it cost?**

A queue between the route and the agent loop. Today every investigation is synchronous on a 300s budget; an investigation that needs to wait through three rate-limited retries can use 30s of that on a single tool call. The fix at 10x is "kick off the investigation, return 202, run the agent in a worker, stream events to the client via SSE or a websocket." The cost is real — the in-memory `Map` in `lib/state/investigations.ts` has to move to a durable store (Postgres or KV), the `useInvestigation` hook has to learn to subscribe instead of read, and we now have a worker process to operate. None of that is on the table today because the load doesn't justify it, but I want to name it because the absence of a queue is *the* architectural choice this codebase made — and it'll be the first thing that breaks at 10x. See file 07.

---

**The dodge — "what about microservices?"**

We don't have them and we shouldn't. The whole system is ~5,000 lines of TypeScript shipped by one person. Microservices would split agent/route/provider into three deployables, three failure domains, three sets of operational tooling — for one app that one person owns. The cost would dominate. The honest answer: this app is monolith-shaped because the load is monolith-sized; the boundaries inside the process are already named and clean (`McpCaller`, `McpTransport`); when the load grows, the first split is route ↔ worker (because that's where async work would land), not agent ↔ provider (because those don't have independent scaling needs).

---

**One-line anchors:**
- Five bands · three real boundaries (B1 trust, B2 trust+rate, B3 trust) · one cosmetic (route↔agent loop).
- B2 is load-bearing because *latency* flips across it — everything else inherits the ~1 req/s ceiling.
- The route↔agent loop being cosmetic is *the* design choice; promoting it to real is the file 07 migration.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, draw the five bands and three boundaries. For each boundary, name what flips (trust / rate / control) and the file that enforces it. Check against the primary diagram + the component file index.

### Level 2 — Explain
Why is the route↔agent loop seam cosmetic and not a real boundary? What would have to change about the code for it to become a real boundary? Reference `app/api/briefing/route.ts` L178–L246 and `lib/state/investigations.ts` L11–L40.

### Level 3 — Apply
A teammate proposes adding a "favorites" feature: users can star an insight and revisit it later. Walk through which existing boundary it crosses, what new state it introduces, and which file would own it. Reference `lib/state/insights.ts` and the absence of a database.

### Level 4 — Defend
Defend the choice to have only three trust boundaries instead of, say, separating the agent loop from the route via a queue. When is that the right call, when does it become the wrong one, and what's the migration path?

### Quick check
- Which file owns the TTL cache + spacing + retry? → `lib/mcp/client.ts` L79–L172
- Which file is the McpCaller seam? → `lib/agents/base.ts` L16–L22
- Which file is the encrypted-cookie auth pattern? → `lib/mcp/auth.ts` L86–L104 (`withAuthCookies`)
- Which boundary is cosmetic? → route → agent loop (same process)

---

## See also

→ [02-request-response-and-data-flow.md](./02-request-response-and-data-flow.md) · [03-state-ownership-and-source-of-truth.md](./03-state-ownership-and-source-of-truth.md) · [08-system-design-red-flags-audit.md](./08-system-design-red-flags-audit.md) · `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md` (B1 mechanism) · `.aipe/study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md` (B2 mechanism) · `.aipe/study-security/00-overview.md` (B3 mechanism)
