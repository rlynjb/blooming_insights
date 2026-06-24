# Authored MCP server — the far side of the adapter

> **RETIRED 2026-06-18.** This file was authored against the Olist MCP
> server / Phase 3 eval pipeline, both removed from the codebase. The
> patterns it teaches are real, but the code anchors it cites no longer
> exist. Preserved as a historical record of what was studied.

**Industry name(s):** custom protocol server, domain-shaped tool surface, ports-and-adapters far side, in-process MCP
**Type:** Industry standard · Language-agnostic

> Most teams using MCP consume a server someone else wrote. `mcp-server-olist` is the opposite shape — a server you author, built around the *exact* tool surface your agent needs, running as a child process of the consumer. The architectural lesson is what you keep OFF the tool surface, not what you put on it.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** `mcp-server-olist` is a sibling package — `mcp-server-olist/` next to `app/`, `lib/`, `eval/` — not a dependency. ~1800 LOC, three tools, one SQLite database, one stdio transport. When the parent app runs in `live-sql` mode, `OlistDataSource` (`lib/data-source/olist-data-source.ts`) spawns this server as a Node subprocess, talks to it over `StdioClientTransport` (JSON-RPC frames over stdin/stdout), and tears it down via `dispose()`. The server is the **far side** of the adapter pattern: where `BloomreachDataSource` talks to a vendor's HTTPS MCP endpoint, `OlistDataSource` talks to a server *this codebase owns*.

```
Zoom out — where mcp-server-olist lives

┌─ Parent app (blooming_insights/) ──────────────────┐
│  app/api/briefing  →  agents  →  DataSource        │
│  app/api/agent     →  agents  →  DataSource        │
│         │  via makeDataSource('live-sql', sid)      │
│         ▼                                           │
│  lib/data-source/olist-data-source.ts               │
│  OlistDataSource (subprocess spawner)               │
└─────────────────────┬──────────────────────────────┘
                      │  StdioClientTransport
                      │  (JSON-RPC frames on stdin/stdout)
┌─ mcp-server-olist (sibling package) ───────────────┐ ★ we are here ★
│  src/index.ts              (process entry)         │
│  src/server.ts             (MCP server + dispatch)│
│  src/db.ts                 (better-sqlite3 wrapper)│
│  src/schemas.ts            (JSON Schemas + validate)│
│  src/tools/                                         │
│    get_metric_timeseries.ts   (~212 LOC)           │
│    get_segments.ts            (~105 LOC)           │
│    get_anomaly_context.ts     (~284 LOC)           │
│  data/olist.db                (3.6 MB, committed)  │
│  data/olist.db-shm            (WAL shared mem)     │
│  data/olist.db-wal            (WAL log)            │
└────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when do you author your own MCP server instead of consuming someone else's? And once you do, what shape should the tool surface take? The answer here is opinionated: author one when (a) you want *ground truth* that your agent doesn't have access to in production (the 3 seeded anomalies are the answer key for the eval pipeline), and (b) you want the *vocabulary* of the tools to match your agent's actual workflow, not the underlying database. This server exposes three domain tools (`get_metric_timeseries`, `get_segments`, `get_anomaly_context`) — NOT a generic `execute_sql` tool. The agent never writes SQL; it asks for "the metric in this window grouped by this dimension" and the tool's handler writes the SQL. The next sections walk the subprocess lifecycle, the domain-tool design as the adapter's far side, and the architectural choice that's NOT on the tool surface.

---

## Structure pass

**Layers.** Five layers per request. The **transport** (stdio — JSON-RPC frames over stdin/stdout), the **MCP server** (`Server` from `@modelcontextprotocol/sdk` + a request-handler dispatch table), the **tool handler dispatch** (the `callTool(db, name, args)` switch in `server.ts` L79–L108), the **per-tool implementation** (`validateInput` + `execute(db, validated)` per tool), and the **SQLite** read-only DB (better-sqlite3, synchronous driver). Five layers, one process, one read-only DB file, one parent process keeping it alive over stdin.

**Axis: trust.** What does each layer trust the upstream layer to have validated? This is the right axis because the whole reason for the multi-layer split is **trust assignment**: the transport trusts the parent to send well-formed JSON-RPC; the server trusts the dispatch table to route the right tool; the dispatch trusts the tool's `validateInput` to reject bad arguments before they touch SQL; the tool's `execute` trusts the validator to have shaped the input. State and control work but flatten things: state would frame it as "the DB is read-only" (boring); control would frame it as "the parent decides what to call" (also boring). Trust pops the seam at the validator — that's where untrusted JSON becomes typed input.

**Seams.** Three seams matter; one is load-bearing. **Seam 1: transport → server.** Trust flips from "an external process sent us JSON" to "we have a valid MCP request envelope." MCP SDK handles this — protocol-level only. **Seam 2 (load-bearing): dispatch → validator.** Trust flips from "the model picked this tool" to "we have type-safe, schema-validated input." Every tool's `validateInput()` returns either a typed-input object OR a string error message that becomes an `isError: true` envelope — the handler **never** throws to the SDK. This seam is what makes the server robust: bad model output never crashes the subprocess. **Seam 3: validator → SQL.** Trust flips from "typed input" to "prepared SQL with bound params." The tools never string-interpolate user input into SQL; better-sqlite3's prepared statements bind values, eliminating injection at the layer below.

```
Structure pass — authored MCP server

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  stdio transport · MCP server · dispatch · tool     │
│  validator+execute · SQLite (read-only, WAL)         │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  trust: what does each layer trust the upstream to   │
│  have validated?                                     │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: transport → server   (raw JSON → MCP envelope) │
│  S2: dispatch → validator ★load-bearing             │
│      (model output → typed input or isError)        │
│  S3: validator → SQL      (typed input → bound      │
│      prepared statement)                             │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

---

## How it works

### Move 1 — Mental model

Think of `mcp-server-olist` as a long-running CLI program: it reads JSON-RPC requests from stdin, writes responses to stdout, logs to stderr, and never exits until stdin closes. The parent process spawns it once per `OlistDataSource` instance, sends N tool calls during the agent's run, and kills it on `dispose()`. SQL execution is *synchronous* because better-sqlite3 is a sync driver — the event loop sits idle during DB reads. That's fine here: a single-user, read-only, in-process MCP server doesn't need async I/O concurrency.

```
parent process                child process (mcp-server-olist)
─────────────────             ──────────────────────────────────
spawn(node, src/index.js)  ──► startServer()
                                  ├─ openDb()              [SQLite read-only + WAL]
                                  ├─ buildServer(db)       [register 3 tools]
                                  └─ connect(StdioServerTransport)
                                       │
stdin frame {callTool} ───────────────► server.dispatch
                                              │
                                              ▼
                                       callTool(db, name, args):
                                         validateInput()  → string error? → isError envelope
                                                              else
                                         execute(db, validated)
                                                              │
                                                              ▼
                                         {content: [{text: JSON}], structuredContent: {...}}
                                                              │
stdout frame {result} ◄───────────────────────────────────────┘

dispose() →  kill subprocess  → SQLite connection closed by OS
```

The shape is *unusually simple* for an MCP server. No HTTP, no auth, no rate limits, no retry, no caching. One process, one DB, three tools. That simplicity is the whole point: the server only does what the agent needs.

---

### Move 2 — Layered walkthrough

The five components are not equal. **The validator (seam 2) is the load-bearing one** — it's what makes the server robust against bad model output AND what defines the contract the agents read. **The tool surface design is the surprising one** — three domain tools instead of one generic `execute_sql` tool, and the reasoning is a design decision worth understanding before reading the code.

**Component 1 — The process entry**

`src/index.ts` is 25 lines. It calls `startServer()`, logs a ready line to stderr, and waits for stdin to close. The stdio transport keeps the event loop alive; nothing else to do. Stderr-only logging is mandatory — `StdioServerTransport` reserves stdout for MCP protocol frames, and anything written to stdout corrupts the JSON-RPC stream.

```
src/index.ts
  ├─ startServer()              [returns once connect() resolves]
  ├─ process.stderr.write("[mcp-server-olist] ready (stdio)\n")
  └─ (event loop idle, stdin pipe holds it open)
```

The boundary condition: if any other code in the process writes to `process.stdout`, the parent's MCP client will fail to parse the next frame and the subprocess effectively crashes. That's why every log line in every tool goes to stderr.

**Component 2 — The MCP server + dispatch**

`src/server.ts` builds the MCP `Server`, registers two request handlers (`ListToolsRequestSchema`, `CallToolRequestSchema`), and exports a pure `callTool(db, name, args)` function the test suite calls directly without spinning up stdio.

```
buildServer(db):
    server = new Server({name, version}, {capabilities: {tools: {}}})

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS,   # 3 tools with name/description/inputSchema
    }))

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      return callTool(db, req.params.name, req.params.arguments)
    })

    return server
```

The TOOL_DEFINITIONS array is 3 entries. Each one's `description` is written for the model (the agent's prompt sees this), and each one's `inputSchema` is a JSON Schema the model uses to fill its arguments. The descriptions are *task-shaped*, not API-shaped — `"Use this as the primary 'what changed?' query"` (`get_metric_timeseries`), not `"GET /timeseries"`.

**Component 3 — Validator-as-contract (the load-bearing seam)**

Every tool implementation exports `validateInput(raw): string | TypedInput`. If validation fails, returns a string error. If it succeeds, returns the typed-input object. The dispatch reads this:

```
callTool(db, name, args):
    try:
      switch name:
        case 'get_metric_timeseries':
          validated = get_metric_timeseries.validateInput(args)
          if isString(validated): return errorEnvelope("invalid input: " + validated)
          return successEnvelope(get_metric_timeseries.execute(db, validated))
        ...
    catch err:
      return errorEnvelope("tool error: " + err.message)
```

The string-or-typed-input pattern is the trust seam. The handler **never** throws to the MCP SDK — a thrown exception would propagate up the transport layer and potentially corrupt the JSON-RPC frame. Instead, every failure mode becomes `{content: [{text: msg}], isError: true}` — same envelope as the success path with one bit flipped. The agent's loop reads `isError: true` and feeds it back to the model as `tool_result.is_error: true`, which the model handles natively.

```
What can go wrong?              How is it surfaced?
────────────────────────       ─────────────────────────────────────────
bad JSON Schema validation     errorEnvelope("invalid input: <reason>")
DB throw (rare; read-only)     errorEnvelope("tool error: " + err.message)
unknown tool name              errorEnvelope("unknown tool: " + name)

network failure?                N/A — there's no network
auth failure?                   N/A — there's no auth
rate limit?                     N/A — SQLite doesn't rate-limit
```

The list of "N/A" failure modes is the architecture's strongest feature. Every category of failure that complicates a HTTPS MCP server is gone here. The tradeoff is honest: zero scaling, single-process, single-machine, single-user — but at this scale (one eval driver running K=10 sequentially), none of those matter.

**Component 4 — Per-tool implementation (the domain-shaped surface)**

Each of the three tools has the same shape: `validateInput(raw): string | Input`, `execute(db, input): Output`. The `execute` function writes SQL using better-sqlite3 prepared statements (bound params, no string interpolation), reads typed rows, shapes them into the documented output, and returns. No async I/O — better-sqlite3 is synchronous.

The three tools are deliberately task-shaped:

```
TOOL NAME              MAPS TO AGENT'S WORKFLOW           WOULD-BE-SQL EQUIVALENT
─────────────────────  ──────────────────────────────     ─────────────────────────────
get_metric_timeseries  "what changed in this window?"     SELECT date_trunc(...),
                       Primary query for monitoring +     SUM(metric) FROM orders
                       diagnostic agents.                  WHERE ... GROUP BY ...

get_segments           "what dimensions exist?"           SELECT DISTINCT state,
                       Discovery tool — lists distinct    COUNT(*), SUM(price)
                       values of a dimension with metric  FROM orders
                       totals, so the agent can pick      GROUP BY state
                       what to drill into.                ORDER BY ...

get_anomaly_context    "for this flagged anomaly, what    Three sub-queries: the segment's
                       are the supporting numbers AND     window value, related segments'
                       sample orders?"                    moves, sample orders. Combined
                       Evidence-gathering for diagnostic  output the diagnostic agent
                       agent's `evidence[]`.              cites verbatim.
```

The three are NOT "list events", "get customer", "query catalog". They're "what changed", "what segments exist", "explain this anomaly" — the three questions the diagnostic agent's *prompt* asks. The tool surface mirrors the agent's reasoning shape, not the database schema.

**Component 5 — SQLite (read-only, WAL)**

`src/db.ts` opens `data/olist.db` read-only with `journal_mode = WAL` and `foreign_keys = ON`. Read-only is enforced at the OS level — the MCP server *cannot* mutate the DB. The 3.6 MB committed DB contains 6 tables (orders, order_items, customers, sellers, products, payments) seeded from the Olist Brazilian e-commerce dataset, plus a `seeded_anomalies` table with 3 hand-crafted ground-truth anomalies (SP-state revenue drop, electronics order_count spike, voucher payment_type collapse) used by the eval pipeline.

```
data/olist.db  (3.6 MB, committed to git)
  ├─ orders              (real Olist data, 26-week window)
  ├─ order_items
  ├─ customers
  ├─ sellers
  ├─ products
  ├─ payments
  └─ seeded_anomalies    (3 rows — the EVAL GROUND TRUTH)
```

The `seeded_anomalies` table is the load-bearing detail for the eval pipeline (`09-eval-pipeline.md`): it's how detection-pillar scoring knows what the agent *should* find. The DB is committed (not regenerated) so two evals running on different machines compare against the same ground truth.

---

### Move 2.5 — The surprising design: no `execute_sql` tool

This server intentionally does **not** expose a raw `execute_sql` tool. The agent never writes SQL. The reasoning is worth unpacking because it's the opposite choice most teams would make first.

```
The choice that wasn't made:        The choice that was made:
─────────────────────────────       ──────────────────────────────────
TOOL: execute_sql                   3 domain tools:
  args: { query: string }             get_metric_timeseries
                                      get_segments
agent prompt would need:              get_anomaly_context
  - full schema description
  - SQL dialect (SQLite vs Postgres)
  - injection caveats
  - per-query intent classification
  - rate-limit reasoning
                                    agent prompt needs:
                                      - "use get_metric_timeseries for
                                         'what changed?' questions"
                                      - "use get_segments to discover"
                                      - "use get_anomaly_context for
                                         evidence-gathering"
```

Three forces drove the decision: (1) **the agent's reasoning is task-shaped, not query-shaped** — the monitoring agent asks "what changed?", not "what's the SUM-GROUP-BY for orders.total_price?" Matching the tool surface to the reasoning shape means the prompt is shorter and the model's tool-use is more accurate. (2) **the same agent code runs against Bloomreach** — Bloomreach exposes EQL (event-shaped queries), not SQL. If the Olist tools were SQL-shaped, the agents would have *two* mental models depending on backend. Domain tools let the same prompt drive both backends with the same tool-call vocabulary. (3) **fabrication risk** — a model writing SQL has a much wider failure surface than a model picking from three named tools with JSON Schema arguments. The domain tools constrain the model's degrees of freedom.

The cost: every new question the agent might ask requires a new tool. Adding "give me YoY growth" means a new `get_yoy_growth` tool + JSON Schema + execute function + prompt update. The codebase accepts that cost because the *current* agent only asks three questions, and a server with three deliberately-narrow tools is more maintainable than a server with one fully-general tool.

---

### Move 3 — The principle

**Author the protocol server when your agent's reasoning shape differs from the underlying API shape.** A SQL database is a query API. An agent reasoning about anomalies is a task API. Authoring the MCP server in the middle lets you translate once, in code you own, rather than translating per-call in the model's tool-use reasoning. This is the same principle as a BFF (backend-for-frontend) layer in a UI architecture: a thin server that shapes upstream APIs to the consumer's exact needs.

---

## Authored MCP server — diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PARENT PROCESS  (blooming_insights)                                         │
│                                                                              │
│  app/api/briefing  →  makeDataSource('live-sql', sid)                       │
│       │                       │                                              │
│       ▼                       ▼                                              │
│  agent.scan(hooks, runnable)  OlistDataSource                                │
│       │                       │                                              │
│       │                       │  spawn (Node, src/index.js)                  │
│       │                       │  StdioClientTransport                        │
│       │                       │  stdin/stdout pipe                           │
└───────┼───────────────────────┼──────────────────────────────────────────────┘
        │                       │
        │                       │  JSON-RPC frames on stdin/stdout
        │                       │
┌───────┼───────────────────────▼──────────────────────────────────────────────┐
│  CHILD PROCESS  (mcp-server-olist subprocess)                                │
│                                                                              │
│       │ stderr: "[mcp-server-olist] ready (stdio)"                           │
│       │                                                                       │
│       ▼                                                                       │
│  src/index.ts → startServer() → buildServer(openDb()) → server.connect()    │
│                                       │                                       │
│                                       ▼                                       │
│  ┌─ MCP Server + Dispatch ────────────────────────────────────────────┐     │
│  │  setRequestHandler(ListToolsRequestSchema)  → TOOL_DEFINITIONS    │     │
│  │  setRequestHandler(CallToolRequestSchema)   → callTool(db, n, a)  │     │
│  └────────────────┬────────────────────────────────────────────────────┘     │
│                   │ name + args                                              │
│                   ▼                                                          │
│  ┌─ Dispatch (server.ts L79-L108) ────────────────────────────────────┐     │
│  │  switch name:                                                       │     │
│  │    case 'get_metric_timeseries' → validate + execute                │     │
│  │    case 'get_segments'          → validate + execute                │     │
│  │    case 'get_anomaly_context'   → validate + execute                │     │
│  │    default                      → errorEnvelope("unknown tool: …") │     │
│  └────────────────┬────────────────────────────────────────────────────┘     │
│                   │ validated input                                          │
│                   ▼                                                          │
│  ┌─ Per-tool execute(db, input) ──────────────────────────────────────┐     │
│  │  db.prepare(...).all(...)   ← bound prepared statements             │     │
│  │  shape rows → typed Output                                          │     │
│  └────────────────┬────────────────────────────────────────────────────┘     │
│                   │ Output                                                   │
│                   ▼                                                          │
│  ┌─ Envelope ─────────────────────────────────────────────────────────┐     │
│  │  { content: [{text: JSON.stringify(out)}],                          │     │
│  │    structuredContent: { data: out } }                               │     │
│  └────────────────┬────────────────────────────────────────────────────┘     │
│                   │                                                          │
│                   ▼                                                          │
│  ┌─ SQLite (data/olist.db, read-only, WAL) ──────────────────────────┐     │
│  │  orders · order_items · customers · sellers · products · payments  │     │
│  │  seeded_anomalies  ★ EVAL GROUND TRUTH ★                          │     │
│  └────────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
```

Parent owns the lifecycle; child owns the protocol + DB. The boundary is one OS pipe carrying JSON-RPC frames. Tear down the pipe and the child exits cleanly.

---

## Implementation in codebase

**File:** `mcp-server-olist/src/index.ts`
**Function / class:** `main()` (L10–L23)
**Line range:** L1–L25
**Role:** Process entry — bootstraps the MCP server, logs ready to stderr, lets stdin keep the event loop alive. The whole file is 25 lines because there's nothing else to do — `startServer()` returns once the SDK's `connect()` resolves and the request handlers are registered.
**GitHub:** `mcp-server-olist/src/index.ts`

---

**File:** `mcp-server-olist/src/server.ts`
**Function / class:** `TOOL_DEFINITIONS` (L32–L51); `callTool(db, name, args)` (L79–L108); `buildServer(db)` (L113–L133); `startServer()` (L137–L143); envelope helpers (L54–L74)
**Line range:** L1–L143
**Role:** The dispatch + envelope layer. `callTool` is the pure function the test suite imports directly. `buildServer` registers the two MCP request handlers (`ListToolsRequestSchema`, `CallToolRequestSchema`). `startServer` opens the DB, builds the server, connects stdio.
**GitHub:** `mcp-server-olist/src/server.ts`

```typescript
// server.ts L79–L108 — the dispatch (verbatim)
export function callTool(
  db: Database.Database,
  name: string,
  args: unknown,
): ReturnType<typeof successEnvelope> | ReturnType<typeof errorEnvelope> {
  try {
    switch (name) {
      case 'get_metric_timeseries': {
        const validated = getMetricTimeseries.validateInput(args);
        if (typeof validated === 'string') return errorEnvelope(`invalid input: ${validated}`);
        return successEnvelope(getMetricTimeseries.execute(db, validated));
      }
      case 'get_segments': {
        const validated = getSegments.validateInput(args);
        if (typeof validated === 'string') return errorEnvelope(`invalid input: ${validated}`);
        return successEnvelope(getSegments.execute(db, validated));
      }
      case 'get_anomaly_context': {
        const validated = getAnomalyContext.validateInput(args);
        if (typeof validated === 'string') return errorEnvelope(`invalid input: ${validated}`);
        return successEnvelope(getAnomalyContext.execute(db, validated));
      }
      default:
        return errorEnvelope(`unknown tool: ${name}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorEnvelope(`tool error: ${msg}`);
  }
}
```

The `try/catch` around the switch is the load-bearing safety net — the SDK's request handler never sees an exception, only an envelope. Everything that goes wrong becomes `isError: true`.

---

**File:** `mcp-server-olist/src/db.ts`
**Function / class:** `openDb(path)` (L32–L43); `resolveDbPath()` (L18–L27); `truncateEpoch(epoch, granularity)` (L67–L77); `epochToIsoDate` / `isoDateToEpoch` (L47–L62)
**Line range:** L1–L77
**Role:** SQLite wrapper. Opens the DB read-only + WAL + foreign_keys ON. Stays a thin shim over better-sqlite3 — no connection pool, no async, no caching (better-sqlite3 caches prepared statements transparently).
**GitHub:** `mcp-server-olist/src/db.ts`

`resolveDbPath()` walks up from the source file location to find the package root — this lets the DB resolve correctly whether the server is invoked from `npm run start`, spawned as a subprocess from the parent, or imported in a vitest test.

---

**File:** `mcp-server-olist/src/tools/get_metric_timeseries.ts` (~212 LOC)
**Function / class:** `validateInput(raw): string | Input`; `execute(db, input): Output`
**Role:** Tool 1 — the agent's primary "what changed?" query. Aggregates a metric over a time window, optional dimension grouping and filter. Prepared SQL via better-sqlite3.
**GitHub:** `mcp-server-olist/src/tools/get_metric_timeseries.ts`

---

**File:** `mcp-server-olist/src/tools/get_segments.ts` (~105 LOC)
**Function / class:** same shape — `validateInput` + `execute`
**Role:** Tool 2 — discovery. Lists distinct values of a dimension with order_count + revenue. The agent uses this to find what to filter on before drilling in with `get_metric_timeseries`.
**GitHub:** `mcp-server-olist/src/tools/get_segments.ts`

---

**File:** `mcp-server-olist/src/tools/get_anomaly_context.ts` (~284 LOC)
**Function / class:** same shape — `validateInput` + `execute` (L1–L60 visible)
**Role:** Tool 3 — evidence-gathering for the diagnostic agent. Given a flagged anomaly (segment + window) and a baseline window, returns `anomaly_summary`, `related_segments`, and up to 10 representative orders. The diagnostic agent reads this verbatim into `evidence[]`.
**GitHub:** `mcp-server-olist/src/tools/get_anomaly_context.ts`

---

**File:** `mcp-server-olist/data/olist.db` (3.6 MB, committed)
**Tables:** `orders`, `order_items`, `customers`, `sellers`, `products`, `payments`, `seeded_anomalies`
**Role:** The data. Seeded from the Olist Brazilian e-commerce dataset (real customer/order data from 2016–2018, 26-week window). The `seeded_anomalies` table contains 3 hand-crafted ground-truth anomalies the eval pipeline scores against. Committed because the eval depends on a stable seed across machines.

---

**File:** `lib/data-source/olist-data-source.ts` L82–L91 (`defaultServerEntry()`)
**Role:** The parent-side path resolution that locates `mcp-server-olist/dist/src/index.js` at runtime. Walks up from the file location until it finds the sibling package. This is the load-bearing detail that lets the subprocess spawn work both in dev (from `lib/data-source/`) and from any compiled output position.

---

## Elaborate

### Where this pattern comes from

The MCP (Model Context Protocol) was introduced by Anthropic in late 2024 as a standardized way for LLM clients to call external tools. The protocol is JSON-RPC over a transport (stdio for local servers, HTTPS for remote). The vast majority of MCP servers in the wild are **consumed** — Anthropic, GitHub, and others publish servers; LLM applications connect to them. Authoring your own is the rarer pattern, and it's worth its own concept file because the design constraints flip: instead of asking "how do I call this vendor's server?", you ask "what tool surface should my server expose?"

The pattern echoes a few older ideas: **Backend-for-Frontend** (Sam Newman, 2013) — a thin server shaping upstream APIs for one specific consumer; **CQRS** (Greg Young) — separating read-shaped APIs from write-shaped APIs; **GraphQL resolvers** — domain-shaped query surface over a generic database. The novelty here is that the consumer is an LLM, not a frontend or a microservice, so the tool descriptions are written for a model's reasoning loop, not a developer's autocomplete.

### The deeper principle

**Author the protocol server when the cost of teaching the agent your DB schema exceeds the cost of teaching the server your DB schema.** If you expose `execute_sql`, every prompt has to describe the schema, the dialect, the join idioms, the safe-query patterns. If you expose three domain tools, the agent's prompt teaches it three tool names and when to use each. The decision flips on (a) how many distinct questions the agent asks (few → domain tools win; many → SQL wins) and (b) how stable the question shape is (stable → domain tools; exploratory → SQL).

Here: three questions, stable shape — domain tools win comfortably.

### Where it breaks down

**One new question = one new tool.** The day the agent needs "average order value by week", you can't ad-hoc it — you write a new `get_aov_timeseries` tool, a new JSON Schema, a new execute function, a prompt update, and a new test. For a small agent surface this is fine; for an agent doing exploratory data analysis it's intractable.

**Single-process, single-machine.** This server can't scale horizontally. Two parallel agents need two subprocesses (each gets its own); ten parallel agents need ten subprocesses. SQLite WAL mode allows concurrent reads, so the same DB file could back multiple subprocesses, but the subprocess spawn cost (~50ms cold start) is the floor on parallelism. For eval (sequential K=10), that's fine.

**No live data.** The DB is committed. New data requires re-seeding from a fresh source and committing the new `.db` file. For an eval dataset this is correct (stable ground truth); for a production data source it'd be a deployment nightmare.

**Stderr-only logging.** Any `console.log` in any tool corrupts the MCP frame stream. The codebase enforces stderr by convention (`process.stderr.write` in `index.ts`), but a developer adding `console.log("debug")` to a tool handler would silently break the JSON-RPC protocol. A lint rule banning `console.log` in `mcp-server-olist/src/` would be a defensible addition.

### What to explore next

- **Resources (in addition to tools).** MCP supports a `resources` concept — read-only data the model can attach to its context (e.g., a schema document). The Olist server doesn't expose any; the schema is synthesized client-side in `lib/mcp/schema.ts` `olistWorkspaceSchema()`. Worth comparing the two approaches.
- **Prompts (in addition to tools).** MCP supports server-side reusable prompts. Could be used here to centralize the per-tool usage instructions instead of duplicating them in the agent prompts. Tradeoff: more coupling between server and client prompt strategy.
- **Switching to HTTPS transport.** If you wanted to run `mcp-server-olist` as a remote service (not a subprocess), swap `StdioServerTransport` for `StreamableHTTPServerTransport`. The dispatch + tool code is unchanged.
- **A second authored server.** What's the second domain that would warrant its own MCP server? (Hypothesis: a server fronting product analytics — Amplitude / Mixpanel — with domain tools like `get_funnel`, `get_retention_cohort`.)

---

## Interview defense

**What they're really asking:** "Do you understand when to author a protocol vs consume one, and can you defend the design choices in this specific server?"

---

**[mid] Why is the SQLite DB read-only? What would break if it weren't?**

Read-only is a defense, not a constraint. (1) **The agent has no business writing.** Every tool in the server is a read query; there's no `insert_order` or `update_customer` tool. Making the DB read-only enforces this at the OS layer — even if a bug let SQL flow from user input to a write statement (it can't, because the tools never write), the DB would reject it. (2) **The DB is committed and shared.** Two evals running on different machines compare against the same ground truth. If the server could mutate the DB, an eval run on machine A could subtly change the seeded data and machine B's next run would score differently. (3) **WAL mode + read-only = concurrent reads work.** If we ever wanted to spawn multiple subprocesses against the same DB file (e.g., for parallel K iterations), read-only + WAL lets that work without lock contention. Read-only is the cheap insurance against three different failure modes at once.

---

**[senior] You expose three task-shaped tools instead of one `execute_sql` tool. Walk me through how you'd defend that against someone who says "just give the agent SQL access — it's more flexible."**

Two-paragraph defense. (1) **Flexibility cuts both ways.** Giving the agent SQL means the agent's tool-use surface is "any valid SQL string against this schema" — that's an infinite vocabulary the prompt has to teach AND the model has to navigate. With three domain tools, the surface is "three tool names with JSON-schema-constrained arguments" — finite, enumerable, validatable. The model's accuracy goes up because the search space is smaller; the prompt's length goes down because there's less to teach. (2) **The same prompt drives Bloomreach.** Bloomreach exposes EQL (event-shaped queries), NOT SQL. The agents have to work over both backends. If Olist tools were SQL-shaped, the agents would need two mental models — "SQL when Olist, EQL when Bloomreach" — and the prompt would branch on backend. Domain tools let the same prompt drive both backends with the same tool vocabulary; the *implementation* differs (SQL behind Olist, EQL behind Bloomreach), but the *interface the agent sees* is consistent.

The honest residual cost: every new question the agent might ask requires a new tool. The codebase accepts this because the agent's question vocabulary is small (3) and stable. The day the agent needs to do exploratory data analysis, that calculus flips.

---

**[arch] How would you scale this server to support 100 concurrent agents?**

Three layers of fix. (1) **Subprocess pool.** Today, one parent → one subprocess (`OlistDataSource.connect()` spawns it). For 100 concurrent agents, you'd want a pool of N subprocesses (N = CPU cores × some factor), with the parent picking a free one per call. The MCP server stays single-process; the parent does the multiplexing. (2) **HTTPS transport.** Swap `StdioServerTransport` for `StreamableHTTPServerTransport`. The subprocess pool becomes a Kubernetes Deployment, parents become HTTP clients. Adds a network hop but unlocks horizontal scaling. (3) **Database fan-out.** SQLite WAL mode allows concurrent reads from the same file but not concurrent writes — fine here because the server is read-only. If the DB grew large enough to be the bottleneck, switch to a real DB (Postgres) — but at that point the simplicity advantage of "ship a 3.6 MB .db file" evaporates. The honest framing: this server's design is right for the *current* scale (sequential K=10 eval) and would be wrong at 100 concurrent agents. Don't bake the scaling in until the load justifies it.

```
Today (sequential):      100 concurrent (proposed):
─────────────────────    ───────────────────────────────────
parent → 1 subprocess    parent → HTTP pool → N subprocesses
StdioTransport           StreamableHTTPTransport
single .db (read-only)   single .db (read-only, WAL, multi-read)
~50ms spawn per agent    ~5ms HTTP per call, pool warm
```

---

**The dodge: "Isn't this just over-engineering — why not skip MCP entirely and import the SQLite client into the parent process?"**

That's a legitimate question; the answer is twofold. (1) **Parity with the Bloomreach path.** The parent talks to Bloomreach over an MCP server. If Olist were imported directly, the agent code would need a different path for "talk to MCP" vs "talk to local SQLite" — defeating the whole point of the `DataSource` interface. By making Olist also an MCP server, the agent layer sees the same shape for both backends. (2) **Eval realism.** The eval pipeline measures the agent system as it runs in production — including the MCP protocol overhead, the JSON-RPC parse/serialize cost, the subprocess spawn latency. An imported-SQLite eval would measure "the agent + SQLite", not "the agent + MCP". The protocol overhead is small (~1-2ms per call) but the eval should reflect the production shape.

The cost paid for that decision: ~1800 LOC of server code that wouldn't exist if we just imported better-sqlite3 in `lib/data-source/`. The codebase accepts that cost as the price of architectural symmetry.

---

**Anchors:**
- `mcp-server-olist/src/server.ts` L79–L108: `callTool()` dispatch — the trust seam
- `mcp-server-olist/src/server.ts` L113–L133: `buildServer()` — MCP request-handler registration
- `mcp-server-olist/src/server.ts` L32–L51: `TOOL_DEFINITIONS` — the three task-shaped tools
- `mcp-server-olist/src/index.ts` L16: stderr-only readiness log (stdout is the protocol wire)
- `mcp-server-olist/src/db.ts` L32–L43: `openDb()` — read-only + WAL + foreign_keys ON
- `mcp-server-olist/data/olist.db` `seeded_anomalies` table: the eval ground truth
- `lib/data-source/olist-data-source.ts` L82–L91: parent-side subprocess entry-point resolution
- `lib/data-source/olist-data-source.ts` L127–L141: `StdioClientTransport` spawn

---

## See also

→ [audit.md](./audit.md) (system-map-and-boundaries lens — the new authored sibling package) · [03-provider-abstraction.md](./03-provider-abstraction.md) (this server is the far side of `OlistDataSource`) · [01-request-flow.md](./01-request-flow.md) (the `live-sql` mode that spawns this server) · [08-schema-gated-coverage.md](./08-schema-gated-coverage.md) (why this server has no schema-discovery tools — the parent synthesizes the schema instead) · [09-eval-pipeline.md](./09-eval-pipeline.md) (the seeded anomalies in this DB are the eval ground truth)

---
Updated: 2026-06-16 — initial generation. Documents `mcp-server-olist/` (~1800 LOC sibling package) introduced in Phase 2 of the DataSource seam work as the second adapter's far side. Framed as a 5-layer authored-MCP-server architecture: stdio transport → MCP server → dispatch → validator+execute → SQLite. Three domain tools (`get_metric_timeseries`, `get_segments`, `get_anomaly_context`) — explicitly NOT `execute_sql` — with the design rationale around prompt complexity, fabrication risk, and Bloomreach-vocabulary parity. The `seeded_anomalies` SQLite table is named as the eval pipeline's load-bearing ground truth.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
