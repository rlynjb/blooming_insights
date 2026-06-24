# Tool calling and MCP

**Industry name(s):** Model Context Protocol (MCP), tool calling, function calling, tool gateway, tool registry, authored MCP server
**Type:** Industry standard · Language-agnostic

> The substrate every reasoning pattern runs on — the model emits structured tool calls, your loop executes them, the result feeds the next turn. blooming insights runs it through MCP, but Phase 2 added a `DataSource` seam **above** MCP so the substrate can swap: one adapter talks to Bloomreach's loomi MCP server over OAuth; a second adapter spawns the sibling-package `mcp-server-olist` subprocess and talks to its three authored domain tools. The agents only know the seam.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Tool calling + MCP lives at the seam between the Shared agent loop and the External world — the Tools band (`lib/tools/*`) defines what's available, the MCP transport band (`lib/mcp/client.ts`) carries the call to the Bloomreach MCP server, and the response flows back as the next observation the model reads. One client, one discovery surface, four agents reuse it — per-agent surfaces are filters at the boundary, not separate tool definitions.

```
  Zoom out — where tool calling + MCP lives

  ┌─ Per-agent definitions ─────────────────────────┐
  │  each agent's tool subset (via filterToolSchemas) │
  └─────────────────────────┬────────────────────────┘
                            │  emits tool_use blocks
  ┌─ Shared agent loop ─────▼────────────────────────┐
  │  runAgentLoop (lib/agents/loop.ts)               │
  │  parses tool_use → dispatches to MCP client       │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Tools + MCP transport ─▼────────────────────────┐  ← we are here
  │  ★ lib/tools/* (tool definitions / filters) ★     │
  │  ★ lib/mcp/client.ts (StreamableHTTPClient) ★     │
  │  one client per request; listTools + callTool     │
  └─────────────────────────┬────────────────────────┘
                            │  HTTPS
  ┌─ External ──────────────▼────────────────────────┐
  │  Bloomreach MCP server (cloud — the tool host)   │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: what's the connective tissue under every reasoning pattern that lets the model actually *do* things — and how do you avoid wiring it per agent? MCP is the `/api` boundary for LLMs: one definition on the server, every agent calls it the same way, the per-agent surface is a filter (`filterToolSchemas`) at the boundary, not a fork. The cost of skipping the protocol is per-agent drift on shared tools; the cost of adopting it is the auth / rate-limit / caching plumbing the tool host imposes, paid once in `lib/mcp/client.ts`. Below, you'll see the discovery + execute mechanics and what each piece of the client's complexity earns.

---

## Structure pass

**Layers.** Four layers stack from model to network: the **Per-agent tool surface** (each agent's filtered subset via `filterToolSchemas` — what tool schemas this agent is even allowed to see), the **Shared agent loop** (`runAgentLoop` — parses `tool_use` blocks, dispatches to the MCP client, pushes results back), the **MCP client + transport** (`lib/mcp/client.ts` — StreamableHTTP, OAuth PKCE+DCR auth, spacing, retry, cache), and the **External MCP server** (Bloomreach's loomi MCP — the actual tool host across HTTPS). Brain → wires → hands, with a filter at the top deciding what the brain can ask for.

**Axis: trust + control.** Two axes braid here because the seams flip both ways. Trust: what can each side see or tamper with — the model can emit any tool call name from its menu (untrusted), our loop validates against the schema (trusted), the MCP client signs the call with our OAuth token (trusted), the external server executes against our project scope (trusted but external). Control: who decides which tool runs — the model picks from its filtered menu (MODEL), the loop dispatches (CODE), the MCP server resolves (EXTERNAL). The two axes flip across different seams, which is the point.

**Seams.** Three seams matter. Seam 1 sits between the Per-agent tool surface and the loop — control + trust both flip from "MODEL emits an intent against an untrusted text channel" to "CODE validates against the filtered schema before dispatching." Seam 2 sits between the loop and the MCP client — trust flips from "CODE running in our process" to "MCP client adding OAuth headers and rate-limit awareness on behalf of our process" (still our trust domain but a different concern). Seam 3 sits between the MCP client and the external server — trust flips from internal to external, control flips from CODE-in-our-process to EXTERNAL (the server resolves bootstrap chain, applies project scoping). Seam 3 is the load-bearing one for *security*: it's where credentials cross a network boundary. Seam 1 is the load-bearing one for *correctness*: it's where the model's untrusted output becomes a typed call.

```
  Structure pass — Tool calling and MCP

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Per-agent tool surface (filterToolSchemas)    │
  │  Shared agent loop (parse + dispatch)          │
  │  MCP client + transport (OAuth, rate, retry)   │
  │  External MCP server (Bloomreach loomi)        │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  trust + control: what can each side see /     │
  │                   tamper with, and who decides │
  │                   what runs?                   │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: Tool surface ↔ Loop                   │
  │          (MODEL untrusted → CODE validated)    │
  │          ★ load-bearing for correctness         │
  │  Seam 2: Loop ↔ MCP client                     │
  │          (CODE in-process → CODE w/ OAuth)     │
  │  Seam 3: MCP client ↔ External server          │
  │          (internal → external, network cross)  │
  │          ★ load-bearing for security            │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the discovery + execute mechanics and what each piece of the client's complexity earns.

---

## How it works

**The mental model: tool calling is brain + hands, MCP is the wiring between them.** The model is the brain — it emits structured tool calls but doesn't execute anything. Your loop is the hands — it runs the call, captures the result, feeds it back. MCP is the contract between them: a JSON-RPC protocol over HTTP that defines how a host (the agent's runtime) discovers what tools a server (Bloomreach's loomi MCP) exposes, calls them, and reads the structured results.

```
brain / hands / wires — the three layers

   ┌─ brain (the model) ──────────────────────────────┐
   │   emits tool_use { name, input }                  │
   │     "execute_analytics_eql with these args"       │
   └──────────────────────┬───────────────────────────┘
                          │
   ┌─ wires (MCP) ────────▼───────────────────────────┐
   │   transport: StreamableHTTP                        │
   │   auth:  OAuth (PKCE + DCR)                        │
   │   client: McpClient — spacing, retry, cache       │
   └──────────────────────┬───────────────────────────┘
                          ▼
   ┌─ hands (the server) ──────────────────────────────┐
   │   Bloomreach loomi MCP runs the tool, returns     │
   │   structured result                                │
   └───────────────────────────────────────────────────┘
                          │
                          ▼
                tool_result fed back to brain
```

The strategy in plain English: **define tools once at the server, discover them once per connection, call them through one client that handles every cross-cutting concern (auth, spacing, retry, cache), and slice the surface per agent at the boundary.** No agent ever speaks HTTP directly to the MCP server. No agent ever defines its own tools. The route stands the connection up once per request, lists the tools once, hands the list (filtered) to each agent that needs it.

### Move 1 — The tool-call round trip (MCP-shaped)

The technical thing: **the `tool_use` → execute → `tool_result` cycle, with MCP as the protocol that defines how the execute step talks to the tool host.**

If you're coming from frontend, this is the `useFetch` round trip — except the consumer is the LLM, the URL is a tool name, and the protocol is JSON-RPC over an HTTP stream instead of REST.

```
the round trip — pseudocode

  turn N:
  ┌────────────────────────────────────────────────┐
  │ model.create({ tools, messages })              │  ← model emits
  │   → res.content includes a tool_use block      │     tool_use
  │     { name: 'analytics_tool', input }          │
  └─────────────────────┬──────────────────────────┘
                        ▼
  ┌────────────────────────────────────────────────┐
  │ for each tool_use:                              │
  │   mcp_client.call_tool(name, input)             │  ← MCP boundary
  │     → { result, duration_ms, from_cache }       │
  │   result_content = truncate(serialize(...))     │
  └─────────────────────┬──────────────────────────┘
                        ▼
  ┌────────────────────────────────────────────────┐
  │ messages.push({                                 │
  │   role: 'user',                                 │  ← tool_result
  │   content: [{ type: 'tool_result', ... }]      │     becomes next
  │ })                                              │     turn's input
  └────────────────────────────────────────────────┘
```

The practical consequence: the model writes the call, your loop executes it, the result becomes the model's *next* observation. The model never executes code — that's the contract — so any guardrail you want lives in the loop's tool-call step (read-only servers, rate-limit retries, schema-validated args). The model writes; your code dispatches.

The condition under which it works: the model's `tool_use.input` has to match the tool's `input_schema`. Schemas mismatched → tool call fails → loop feeds the error back as a `tool_result` with `is_error: true`, the model adapts on the next turn.

### Move 2 — One discovery, sliced per agent

The technical thing: **the tools come from the server (`listTools()`), and a per-agent filter (`filterToolSchemas`) maps the discovered list to each agent's allowed names.**

If you're coming from frontend, this is the codegen pattern in a typed RPC client — one schema source generates one full client, and each consumer imports only the methods it uses. The methods are shared; the import surface is per-consumer.

```
discovery + slicing — pseudocode

  one list_tools() per request
  ┌─────────────────────────────────────────────────┐
  │ raw_tools = await mcp_client.list_tools()       │  ← from MCP server
  │   → ~27 tools, with description + input_schema   │
  └──────────────────────┬──────────────────────────┘
                         │ filter at the boundary
                         ▼
  filter_tool_schemas(all_tools, monitoring_tool_set) ← per-agent slice
  filter_tool_schemas(all_tools, diagnostic_tool_set)
  filter_tool_schemas(all_tools, recommendation_tool_set)
  filter_tool_schemas(all_tools, query_tool_set)
                         │
                         ▼
  each agent's loop receives only its tools
```

The practical consequence: the monitoring agent sees 13 monitoring-shaped tools. The recommendation agent sees 7 propose-shaped tools. When the monitoring agent's loop sends its tool list to the model, the recommendation tools aren't even in the schema — the model can't choose them, can't hallucinate them. The slice is enforced by absence, not by a prompt instruction asking the model "please don't."

The condition under which it works: the allow-list per agent has to match the agent's actual job. The four lists are hand-curated against the agent prompts; the day a prompt change adds a job the tool list doesn't support, the model will reason about a tool it doesn't have and either fail gracefully or hallucinate one.

### Move 3 — One client, one connection, one place for cross-cutting concerns

The technical thing: **the MCP client wrapper is the single dispatcher** — it owns auth (via the OAuth provider), proactive spacing (~1.1s minimum interval between live calls), rate-limit retry with parsed hints + exponential backoff, a 60-second TTL response cache, and the no-cache-on-error rule.

If you're coming from frontend, this is the `httpClient` wrapper your team writes once and shares — base URL, auth header, retry interceptor, response cache, all in one place — so individual `useFetch` callers don't each implement them.

```
one client, all the cross-cutting concerns — pseudocode

  call_tool(name, args)
      │
      ├── 1. cache check (60s TTL by key = name + ':' + serialize(args))
      │      └── hit → return { result, from_cache: true }
      │
      ├── 2. proactive spacing — sleep if < 1100ms since last live call
      │
      ├── 3. live_call (transport.call_tool)
      │
      ├── 4. if rate-limited → parse "per N second" hint, sleep, retry
      │       (capped at max_retries=3, ceiling=20s per wait)
      │
      └── 5. no-cache on error (is_error == true) → return uncached
```

The practical consequence: every agent and every turn benefits from the same retries, the same cache, the same spacing. The monitoring agent's third call to an analytics tool with identical args is a 0ms cache hit (`duration_ms: 0, from_cache: true`). A 429 on the recommendation agent's scenarios-list call waits exactly the window the server told it to wait, then retries automatically — the loop above doesn't know it happened. The agent's only contract with MCP is "I call `call_tool(name, args)` and get back `{ result, duration_ms, from_cache }`."

The condition under which it works: the cache key has to match the *intent* of the call. Serializing the args works because the args fully determine the result for read-only tools. If a tool's output depended on time-of-call or external state, the 60s cache would serve stale results — which is why this codebase's MCP tools are all read-only-by-contract (covered in the guardrails note).

### Move 4 — Auth as a first-class concern (OAuth PKCE + DCR)

The technical thing: **the MCP transport speaks OAuth — Dynamic Client Registration + PKCE — to acquire and refresh tokens to the Bloomreach host.**

If you're coming from frontend, this is the OAuth dance you do for a "Sign in with X" flow — except the *agent's host* is the client, the *user's session* is the credential store, and the protocol is wired through the MCP SDK rather than your own code.

```
auth wiring — the MCP auth provider

  per request:
   1. transport = new streamable_http_transport(mcp_url, { auth_provider })
   2. client.connect(transport)
        │
        ├── if no token → provider redirects to authorize URL
        │     → /api/mcp/callback completes the code exchange
        │     → provider.save_tokens persists to encrypted cookie
        │
        └── if token present → JSON-RPC over HTTP, tokens on requests
```

The practical consequence: the agent never sees credentials. The route opens an authenticated MCP client, passes it down to each agent's constructor, and the agent just calls `call_tool(...)`. Refresh, code exchange, token persistence, and the one-time auto-reconnect on a revoked token (a UI-side handler guarded by a session-storage flag) all live below the agent's contract.

The condition under which it works: the provider's `save_tokens` must persist across requests *for the same session*. That's done via session-cookie-keyed storage, so each user's tokens travel with their session, and a serverless instance that gets a different user's request reads that user's tokens — no cross-user leakage.

### Move 5 — The shape MCP buys vs the alternatives

There are three real shapes for "how does the model do things":

```
                Direct tool defs       MCP                      Tool gateway
                ───────────────        ──────────               ────────────
   tools defined per agent             once on the server       once at a gateway
                in-process             remote, JSON-RPC          remote, HTTP
   discovery   compile-time            runtime listTools()       runtime list/proxy
   reuse       copy/paste              one server, many hosts   one gateway, many
                                                                 model providers
   auth        per-tool                per-server, OAuth-ready  centralised
   rate limit  per-tool                per-server (this code)   centralised
   token cost  full schema in window   full schema in window    full schema in window
                                                                 (sometimes proxied)
   tradeoff    fastest to ship for     extra layer worth it     centralisation costs
                a tiny tool set        when host owns auth +    a coordination point
                                       rate limits + many tools
```

The reframe to hand the reader: **MCP earns its layer when the tool host imposes auth and rate limits, when tool surfaces are shared across multiple agents/hosts, and when tool discovery has to be runtime (not compile-time).** All three are true here. The Bloomreach MCP server owns the auth flow (OAuth, PKCE, DCR), enforces a multi-second rate limit window per user, and exposes ~27 tools that four agents need slices of. Inlining tool defs would mean re-implementing each of those concerns in agent code; a gateway would add an extra hop without a clear payoff against this single host.

### The principle

**Tool calling is a protocol problem, not an integration problem.** The model never executes; your code does. The agent never owns auth or rate limits; the client does. The agent's contract is a four-word call: "call this tool with these args, give me the result." Everything else — discovery, slicing, dispatch, retry, cache, auth — lives in layers below that contract. MCP is the protocol that lets those layers be standardised across hosts (so one server serves any compliant client) and across agents (so one client serves any compliant agent). That's why it's worth the extra layer when the surface is non-trivial.

The full picture is below.

---

## Tool calling and MCP — diagram

```
The full substrate — what every reasoning pattern stands on

  ┌──────────────────── AGENTS (4 of them) ──────────────────────┐
  │ monitoring · diagnostic · recommendation · query              │
  │   all call: shared agent loop({ model, mcp, tool_schemas, …}) │
  └────────────┬───────────────────────────────────┬─────────────┘
               │                                   │
               ▼                                   ▼
  ┌─────────────────────────┐         ┌──────────────────────────┐
  │ filter_tool_schemas     │         │ the shared agent loop    │
  │ per-agent slice:        │         │   model.tool_use   ──┐    │
  │   monitoring set (13)   │         │      ▼               │    │
  │   diagnostic set (17)   │         │   mcp.call_tool ◄────┘    │
  │   recommendation (7)    │         │      ▼                   │
  │   query set (union)     │         │   tool_result → messages │
  └─────────────────────────┘         └──────────┬────────────────┘
                                                  │
                                                  ▼
                ┌───────────────────────────────────────────────┐
                │ MCP client wrapper                            │
                │   60s TTL cache                                │
                │   ~1.1s minimum spacing                        │
                │   parsed-hint retry + backoff                  │
                │   no-cache-on-error                            │
                │   typed error on transport failure             │
                └────────────────────────┬─────────────────────────┘
                                          │
                                          ▼
                ┌───────────────────────────────────────────────┐
                │ SDK transport                                  │
                │   wraps an MCP SDK's streamable HTTP transport │
                └────────────────────────┬─────────────────────────┘
                                          │
                                          ▼
                ┌───────────────────────────────────────────────┐
                │ OAuth provider                                 │
                │   OAuth: PKCE + Dynamic Client Registration    │
                │   tokens persisted to encrypted session cookie │
                └────────────────────────┬─────────────────────────┘
                                          │  authenticated HTTP
                                          ▼
                ┌───────────────────────────────────────────────┐
                │ Bloomreach MCP server                          │
                │   exposes ~27 tools, lists them via JSON-RPC    │
                │   enforces per-user rate limit (~1 req/N sec)  │
                └───────────────────────────────────────────────┘
```

---

## Implementation in codebase

**The loop seam (where MCP is called):**
**File:** `lib/agents/base.ts`
**Function:** `runAgentLoop()` — the `mcp.callTool(...)` call inside the tool_use loop
**Line range:** L143–L150 (call), L161–L171 (tool_result back into messages)

**Per-agent slicing:**
**File:** `lib/agents/tool-schemas.ts`
**Function:** `filterToolSchemas()`
**Line range:** L9–L21

The four allow-lists live in `lib/mcp/tools.ts` L5–L40 (`monitoringTools`, `diagnosticTools`, `recommendationTools`, `queryTools`). Each agent passes one to `filterToolSchemas` at construction (`monitoring.ts` L96, etc.).

**The DataSource seam (the new layer above MCP — Phase 2):**
**File:** `lib/data-source/types.ts` — `DataSource` interface (`callTool` / `listTools` / `dispose`)
**File:** `lib/data-source/index.ts` — `makeDataSource(mode, sessionId)` factory; bootstrap moved here per adapter
**File:** `lib/data-source/bloomreach-data-source.ts` — the relocated `BloomreachDataSource` (was `lib/mcp/client.ts`'s `McpClient`)
**File:** `lib/data-source/olist-data-source.ts` — spawns `mcp-server-olist` via `StdioClientTransport`
**File:** `lib/mcp/client.ts` — now a 17-line backwards-compat re-export (`McpClient` is `BloomreachDataSource`)

**The Bloomreach adapter's cross-cutting concerns:**
**File:** `lib/data-source/bloomreach-data-source.ts`
**Function:** `BloomreachDataSource.callTool()` — same surface as the old `McpClient` (60s TTL cache; ~1.1s spacing; bounded exp-backoff retry; no-cache-on-error)

**The transport (MCP SDK):**
**File:** `lib/mcp/transport.ts` — `SdkTransport` wraps `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport`.
**File:** `lib/mcp/connect.ts` — `BloomreachAuthProvider` implements OAuth (PKCE + DCR); `connectMcp()` wires the transport with `minIntervalMs: 1100, retryDelayMs: 10_000, retryCeilingMs: 20_000, maxRetries: 3` (L92–L96).

**The route boundary (one connect, one listTools per request, then slice):**
**File:** `app/api/agent/route.ts`
**Function:** the `GET` stream `start()` body — reads `?mode=` (default `'live-sql'`), calls `makeDataSource(mode, sid)`, calls `dsResult.bootstrap(signal)` for the schema (which knows per-adapter how to derive it: Bloomreach lists discovery tools; Olist returns the fixed `olistWorkspaceSchema()`), calls `dataSource.listTools({ signal })`, then constructs each agent with the shared `dataSource` + `allTools`.

**The authored MCP server (the new Olist surface — Phase 2):**
**Package:** `mcp-server-olist/` (sibling Node package, ~1800 LOC)
**Tools:** `mcp-server-olist/src/tools/get_metric_timeseries.ts` · `get_segments.ts` · `get_anomaly_context.ts`
**Data:** `mcp-server-olist/data/olist.db` — SQLite, ~10k synthetic rows + a `seeded_anomalies` table holding 3 ground-truth records the agent never sees
**Why three domain tools, not `execute_sql`:** SQL is too sharp an edge for the agent — it would have to derive period-over-period math, segment cuts, and the anomaly-context join itself, every time, blowing the budget on plumbing. The authored tools pre-bake those queries; the agent reasons in domain terms ("revenue last 4w vs prior 12w by state"), and the eval suite (`eval/scripts/run-detection.ts`) becomes tractable because the agent's surface is small enough to score deterministically.

```
shape (not full impl):
  // route.ts — pick mode, factory the adapter, discover, slice per agent
  const mode = req.nextUrl.searchParams.get('mode') === 'live-bloomreach'
             ? 'live-bloomreach' : 'live-sql';
  const dsResult = await makeDataSource(mode, sid);
  if (!dsResult.ok) return redirect(dsResult.authUrl);    // Bloomreach OAuth gate
  const dataSource = dsResult.dataSource;
  const schema     = await dsResult.bootstrap(signal);
  const rawTools   = await dataSource.listTools({ signal });

  const agents = {
    monitoring: new MonitoringAgent(anth, dataSource, schema, rawTools.tools),
    diagnostic: new DiagnosticAgent(anth, dataSource, schema, rawTools.tools),
    recommendation: new RecommendationAgent(anth, dataSource, schema, rawTools.tools),
    query: new QueryAgent(anth, dataSource, schema, rawTools.tools, sid),
  };

  // each agent's loop slices the list per its job
  toolSchemas: filterToolSchemas(this.allTools, monitoringTools), // monitoring.ts

  // base.ts — the round trip (DataSource seam, not McpClient)
  const { result, durationMs, fromCache } = await dataSource.callTool(tu.name, tu.input);
```

---

## Elaborate

### Where this pattern comes from

Tool calling as a structured-output capability went mainstream with OpenAI's function calling (2023) and Anthropic's tool use (2024) — both replaced the earlier pattern of asking the model to emit JSON in free text and then parsing it. The Model Context Protocol (MCP) followed in late 2024 as an open spec by Anthropic for *how hosts and tool servers talk to each other*, the way HTTP standardised how browsers and web servers talk. Before MCP, every host had its own tool-integration shape; MCP's contribution is the same one HTTP made for web: one client can talk to any compliant server.

### The deeper principle

**Standardise the substrate, vary the surfaces.** When many consumers need to call many providers, the cheapest move is to define the protocol once and let everyone slot in. HTTP did it for web servers. REST did it for APIs. gRPC did it for typed RPC. MCP does it for LLM tools. The principle is the same: the more your system has agents-and-tools as a many-to-many graph, the more value standardisation buys — and the more cost per-agent or per-tool integration costs.

```
  Without MCP                With MCP
  ──────────────             ──────────────
  N agents × M tools         N agents → 1 client → 1 server (M tools)
  N×M integrations           N + M (and the protocol is the glue)
  drift per agent            single source of truth
```

### Where this breaks down

MCP earns its layer when there are *multiple* tool servers or *multiple* agents that need the same tools. With one server and one agent, MCP adds a layer for no payoff. The cost shows up as: the model still has to receive the full tool schemas in its window every turn (token cost), the protocol round trip adds latency over a direct in-process call, and a misbehaving MCP server can wedge the whole agent. The mitigations are caching (60s TTL here), spacing (1.1s), and the no-cache-on-error rule — but they're mitigations, not removals.

### What to explore next
- Context engineering (`01-context-engineering.md`) → per-agent tool subsets are a context-engineering decision; this file is the substrate
- Tool calling mechanics (`../../study-ai-engineering/04-agents-and-tool-use/02-tool-calling.md`) → the brain/hands split, in this codebase
- Tool routing (`../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md`) → how to pick which tool/agent for an incoming query
- Capability gating (`../../study-ai-engineering/04-agents-and-tool-use/07-capability-gating.md`) → scope before spend; complements per-agent tool slicing

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "how does your agent call tools," they're testing two things: (1) do you understand the brain/hands split (the model emits, your code dispatches), and (2) did you adopt a standard protocol or invent your own integration shape? The strong signal is naming MCP and the per-agent slicing decision; the weak signal is "we use Anthropic tools."

### Likely questions

[mid] Q: What is MCP and why is it in this codebase?

A: MCP — Model Context Protocol — is an open JSON-RPC-over-HTTP spec for how an LLM host (the thing running the agent loop) talks to a tool server (the thing that owns the tools). In this codebase the tool server is Bloomreach's loomi connect MCP. The route opens one connection per request, calls `listTools()` once to discover the ~27 tools the server exposes, and hands the list (filtered per agent) to each agent's loop. The model emits `tool_use` blocks, my loop calls `mcp.callTool(name, args)`, the result comes back, gets truncated, and gets fed in as the next turn's input. MCP is in here because Bloomreach speaks it and because four agents share the same tool surface — the protocol gives me one client (`McpClient` in `lib/mcp/client.ts`) that owns auth, rate-limit retry, and caching for all of them.

Diagram:
```
   agents (×4) ──► filterToolSchemas ──► runAgentLoop
                                            │
                                            ▼
                                       McpClient
                       ┌────────────────┼────────────────┐
                       ▼                ▼                ▼
                    60s cache       1.1s spacing      OAuth (PKCE)
                       │                ▼
                       └────────► JSON-RPC ──► Bloomreach MCP server
```

[senior] Q: Why MCP instead of just defining the tool schemas directly per agent?

A: Three reasons. First, the cross-cutting concerns: Bloomreach's MCP server requires OAuth (PKCE + DCR) and enforces a multi-second per-user rate-limit window. Putting those in the agent code means re-implementing them per agent — drift, bugs, four 429-storm modes. MCP lets me put them once, in `McpClient`. Second, the surface: 27 tools × 4 agents would be 108 schema definitions if hand-coded; with MCP it's one runtime `listTools()` call and a per-agent allow-list of ~13/17/7 names. Third, swappability — MCP is an open spec, so swapping Bloomreach for another MCP-compliant host (or adding a second host) is a wiring change, not a rewrite. The tradeoff is the extra round trip per call and the 1.1s spacing floor that bakes ~6.6s of wait into every 6-call investigation — but the alternative pays that cost in 429 storms instead.

Diagram:
```
   Chosen (MCP)                       Alternative (direct tool defs)
   ┌────────────────────────┐         ┌────────────────────────┐
   │ 1 McpClient owns:      │         │ each agent owns its    │
   │   OAuth, retry, cache, │         │ schemas + auth + retry │
   │   spacing — once       │         │ — drift, bugs, repeats │
   │                        │         │                        │
   │ +1 HTTP round trip     │         │ in-process call         │
   │ per tool call          │         │ (faster, but pays in    │
   │                        │         │  429 storms otherwise)  │
   └────────────────────────┘         └────────────────────────┘
```

[arch] Q: At 10× concurrent users hitting this same MCP server, what breaks first?

A: The Bloomreach rate-limit window is the first thing that gives. It's per-user, so concurrent users don't directly clash, but if user sessions share OAuth scope or the host enforces a global limit, our 1.1s spacing protects each session — not the host's aggregate. The next thing is the 60s response cache: it's per-`McpClient`, and `McpClient` lives in the warm Vercel container — at 10× users on many cold instances, cache hit rate drops because each instance starts cold. Mitigation is a shared cache layer (Redis) in front of `McpClient`, or moving the cache to the MCP server side. The MCP layer itself scales horizontally — each request stands up its own client, the protocol is stateless above auth.

Diagram:
```
  ┌ Per-request McpClient instance ── scales horizontally ───┐
  ┌ 60s TTL cache (per-instance)   ◄── BREAKS first: cache   │
  │                                   hit rate falls at scale,│
  │                                   needs shared cache       │
  ┌ Bloomreach rate limit          ◄── BREAKS second: per-    │
  │                                   user limits hold; an     │
  │                                   aggregate limit would    │
  │                                   force a queue / fewer    │
  │                                   tool calls per request   │
  └ OAuth (per session)            ── unchanged ──────────────┘
```

### The question candidates always dodge
Q: MCP adds a round trip per tool call. With Bloomreach already speaking HTTP, why not just hit the HTTP API directly and skip the protocol layer?

A: Honest answer: with one host and a single API key, direct HTTP would be a few lines less code. The reasons I didn't go that way are (1) Bloomreach exposes MCP as the supported integration shape — taking the HTTP route means picking a private path that could break unannounced, (2) MCP gave me a standard place for auth, rate-limit retry, and caching that I'd have had to build anyway, and (3) the open MCP spec means a future second tool source (say, Anthropic's own tools, or a custom internal MCP server) plugs in without inventing a second integration shape. The token-cost concern is real — the schemas still go in the model's window every turn — but that's a property of tool calling itself, not of MCP. The thing MCP doesn't *add* is also the thing direct HTTP wouldn't avoid. The thing MCP *does* add (auth + retry + cache shared across agents) is the thing I'd have to build either way.

Diagram:
```
   MCP path (chosen)             Direct HTTP (suggested)
   ┌────────────────────────┐    ┌────────────────────────┐
   │ + standard protocol     │   │ - fewer lines / call   │
   │ + auth provider hook    │   │ - no protocol round    │
   │ + rate-limit retry once │   │   trip                 │
   │ + cache once            │   │                        │
   │ + future host swap free │   │ - tied to a private API│
   │ - 1 round trip / call   │   │   shape (breaks silent)│
   │ - 1.1s spacing floor    │   │ - re-build auth/retry  │
   │                         │   │   per integration       │
   └────────────────────────┘    └────────────────────────┘
```

### One-line anchors
- "MCP is the `/api` boundary for LLMs — one definition on the server, every agent calls it the same way."
- "Per-agent tool slicing happens at the boundary, not in the agent — the wrong tool is never in the window."
- "Cross-cutting concerns (auth, retry, cache, spacing) live once in `McpClient`."
- "MCP earns its layer when the tool host owns auth + rate limits + many tools — all three here."
- "The model writes the call; my loop dispatches it; the result becomes the next observation."

---

## See also

→ `01-context-engineering.md` · → `05-guardrails-and-control.md` · → mechanics: `../../study-ai-engineering/04-agents-and-tool-use/02-tool-calling.md` · → `../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md` · → `../../study-ai-engineering/04-agents-and-tool-use/07-capability-gating.md`

---
