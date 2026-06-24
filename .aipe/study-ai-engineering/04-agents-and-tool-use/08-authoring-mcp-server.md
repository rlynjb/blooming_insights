# Authoring your own MCP server (domain tools, not raw SQL)

> **RETIRED 2026-06-18.** This file was authored against the Olist MCP
> server / Phase 3 eval pipeline, both removed from the codebase. The
> patterns it teaches are real, but the code anchors it cites no longer
> exist. Preserved as a historical record of what was studied.

**Industry name(s):** MCP server authoring, tool surface design, domain-tool vs query-tool tradeoff, structured tool abstraction over an open query interface
**Type:** Industry standard · Project-specific implementation

> Most teams adding tools to an agent reach for the open primitive: `execute_sql`, `query_api`, `run_shell`. The model writes the query, the tool runs it. That works until the eval suite catches the model writing bad queries — wrong joins, expensive scans, accidental injection vectors, queries that return empty because the model guessed at the schema. blooming insights ships **a self-authored sibling MCP server** (`mcp-server-olist/`, ~1800 LOC) that exposes **three domain tools** (`get_metric_timeseries`, `get_segments`, `get_anomaly_context`) over a synthetic SQLite dataset — not an `execute_sql` surface. The agent's job shrinks to "pick the right tool with the right args"; query authoring lives in TypeScript you can test, validate, and reason about.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Authoring an MCP server sits at the Tools layer of the agent stack: between the agent loop (which emits `tool_use` blocks) and the actual data backend. Two shapes occupy this slot. The first — **vendor MCP with open primitives** — is what blooming insights uses for Bloomreach (`execute_analytics_eql` lets the model author EQL, the MCP server runs it). The second — **authored MCP with domain tools** — is what `mcp-server-olist/` does for the synthetic dataset (`get_metric_timeseries` takes a metric + dimension + time_range, returns a typed timeseries; the model never writes SQL). Both shapes share the MCP protocol; they differ on where the query lives.

```
  Zoom out — two shapes for the Tools layer

  ┌─ Agent loop ─────────────────────────────────────┐
  │  runAgentLoop emits tool_use, runs tool, feeds   │
  │  result back → next turn                          │
  └─────────────────────────┬────────────────────────┘
                            │  tool_use { name, input }
            ┌───────────────┴───────────────┐
            ▼                               ▼
  ┌─ Vendor MCP ─────────────┐   ┌─ Authored MCP ────────────┐  ← we are here
  │  open primitive:          │   │  domain tools:             │
  │  execute_analytics_eql    │   │  get_metric_timeseries     │
  │  input: { eql: "..." }    │   │  get_segments              │
  │  model writes the query   │   │  get_anomaly_context       │
  │  ↓                        │   │  input: typed args         │
  │  Bloomreach runs it       │   │  ↓                         │
  │                           │   │  authored TS runs SQL      │
  │  (model owns query        │   │  YOU own query authoring   │
  │   correctness)            │   │   model owns selection)    │
  └───────────────────────────┘   └────────────────────────────┘
       Bloomreach MCP                 mcp-server-olist/
       (live prod)                    (eval + local dev)
```

**Zoom in — narrow to the concept.** The question is: when you control the tool surface — when the MCP server is yours to write — do you expose an open primitive (let the model author queries) or a domain tool (give the model fixed analytics primitives)? The answer trades two costs against each other: open primitives are cheap to author and infinitely flexible but require the model to be correct about query syntax + schema + semantics; domain tools cost authoring effort up front but eliminate whole classes of failure (bad SQL, wrong joins, schema guesses, injection paths). The eval pillar is what makes the tradeoff visible — bad query authoring is exactly the class of failure detection + diagnosis evals can score. How it works walks the three domain tools, the seeded-anomaly contract, and why this codebase chose authoring.

---

## Structure pass

**Layers.** Four layers form the authored MCP path: the agent (emits typed `tool_use` arguments for one of three domain tools), the MCP transport (stdio between the agent's subprocess client and the server), the authored server (`mcp-server-olist/src/server.ts` + per-tool handlers under `src/tools/`), and the SQLite backend (`mcp-server-olist/data/olist.db` — synthetic Olist orders + a `seeded_anomalies` table holding the ground truth). The model never authors SQL; the server's TypeScript does.

**Axis: trust.** Where does query authoring live, and who can the layer above trust to do it correctly? This axis is the right lens because the file's whole frame is "which side of the trust boundary writes the query." For `execute_analytics_eql` (Bloomreach), trust flips at the Provider — the model is trusted to write valid EQL. For `get_metric_timeseries` (authored), trust stays inside your TypeScript — the model is only trusted to pick the right tool and pass typed args. Failure modes shift accordingly.

**Seams.** The cosmetic seam is between the MCP transport and the authored server — both are server-side. The load-bearing seam is between the agent and the domain tool's typed input: trust flips here from "model emitted a structured request" to "your handler validates the args against a schema before touching the DB." A second load-bearing seam is between the open primitive (model authors query) and the domain tool (server authors query): trust for query correctness flips across this entire axis. The split is what makes the eval suite's failure modes different — open primitives fail on bad queries; domain tools fail on bad tool *selection*, which is a much smaller surface.

```
  Structure pass — authoring an MCP server

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  agent (emits tool_use w/ typed args)          │
  │  MCP transport (stdio)                         │
  │  authored server (TS handlers)                 │
  │  SQLite backend (data + seeded_anomalies)      │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  trust: where does query authoring live —      │
  │  in the model or in your TypeScript?           │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  transport↔server: cosmetic                    │
  │  open↔domain primitive: LOAD-BEARING           │
  │    model-authored query → server-authored      │
  │    failure modes shift entirely                │
  │  agent↔typed args: LOAD-BEARING                │
  │    validate at the door, no SQL escapes        │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Think of an authored MCP server as a typed RPC surface over your data, designed for the model — not over the model, like an LLM gateway, and not under it, like a database driver. You pick the abstractions the model needs (not the abstractions a SQL user needs) — a metric over time, a segment breakdown, an anomaly's surrounding context — and you author each one as a TypeScript handler with a Zod-validated input schema. The model only ever sees the tools and their JSON schemas; the SQL is invisible.

```
open primitive vs authored domain tool — same outcome, different trust
─────────────────────────────────────────────────────────────────────
open:    model emits { eql: "SELECT date_trunc('week', ...)" }
         server parses + runs it (model owns syntax + schema knowledge)
         FAILS when model writes bad SQL, guesses schema, etc.

domain:  model emits { metric: "revenue", dimension: "state",
                       segment: "SP", time_range: {...} }
         server runs YOUR pre-authored, parameterized SQL
         FAILS only when model picks the wrong tool or passes wrong args
         (much smaller failure surface)
```

The domain tool is a *higher-leverage abstraction*: each tool's signature collapses a class of valid queries into a typed RPC call. The cost is one round of authoring per primitive; the win is every future call goes through tested code.

---

### The three tools

The authored server exposes exactly three tools, each one a different access pattern over the synthetic dataset.

**`get_metric_timeseries`.** "Give me metric M over time, optionally filtered to segment S." Args: `metric` (`revenue` / `order_count` / `payment_value`), `dimension` (`state` / `category` / `payment_type`), `segment` (optional — e.g., `"SP"`), `time_range` (`{ from, to }`), `bucket` (`day` / `week`). Returns a typed `{ points: [{ bucket_start, value, ... }] }` shape. The model uses this for trend questions: "what does SP revenue look like over the horizon?"

**`get_segments`.** "Break down metric M by dimension D over time-range R." Args: `metric`, `dimension`, `time_range`. Returns `{ segments: [{ segment, value, share }] }` ranked by value. The model uses this for discovery: "which states drive the most revenue this quarter?"

**`get_anomaly_context`.** "Give me everything needed to diagnose a specific anomaly." Args: an anomaly descriptor (`metric`, `dimension`, `segment`, `time_range`). Returns a bundle: the timeseries leading up to the window, sibling segments for comparison, top-line aggregates, sample orders. This is the heaviest tool — it does the multi-query gather the diagnostic agent would otherwise issue 3-5 separate `tool_use` calls to assemble.

```
the three-tool surface — by access pattern
─────────────────────────────────────────────────────────────
"how has X changed over time?"           → get_metric_timeseries
"which segments contribute the most?"     → get_segments
"why did THIS specific anomaly happen?"  → get_anomaly_context
                                              ↑ bundles 3-5 queries
                                                into one round-trip
```

Three tools — not thirty. The right number is the smallest set that covers the access patterns the agent surfaces actually need. Add a fourth only when an eval surfaces a real gap.

### The Zod-validated input schemas

Each tool's handler starts with a Zod schema for its input. The MCP server advertises this schema to the agent (via the standard MCP `tools/list` flow), and the handler parses it on every invocation. If the model passes bad args, the handler returns a tool error — not a SQL error — and the agent sees a structured rejection it can react to.

```
the per-tool handler skeleton (pseudocode)
─────────────────────────────────────────────────────────────
handler get_metric_timeseries(rawArgs):
    args = SCHEMA.parse(rawArgs)         // Zod — throws on bad shape
    if args.time_range outside DATA_HORIZON:
        return tool_error("time_range outside dataset horizon")
    sql = SQL_TEMPLATES[args.metric]      // pre-authored, parameterized
    rows = db.prepare(sql).all(
        args.dimension, args.segment, args.time_range.from, args.time_range.to
    )
    return { points: rows.map(toPoint) }   // typed return
```

Validate-at-the-door is the discipline. The handler trusts nothing about the args until Zod has confirmed them; the SQL is parameterized so no string concat happens; the return shape is typed so the agent's parser never sees ambiguous JSON.

### The seeded-anomaly contract

The authored server has one feature no vendor MCP would: a `seeded_anomalies` table that holds the ground-truth anomalies the dataset was generated with. The seed script (`mcp-server-olist/scripts/seed-olist.ts`) writes ~10k synthetic Olist orders AND records, in the same DB, exactly which anomalies it injected (e.g., `sp-revenue-drop-w4`: state=SP, metric=revenue, multiplier=0.7 applied to week 4). The eval scripts read this table to know what the *correct* answer is.

```
why seeded_anomalies is the eval pillar's keystone
─────────────────────────────────────────────────────────────
seed-olist.ts:
  1. generates ~10k synthetic orders                    ← the data
  2. applies seeded anomalies (multipliers on slices)   ← the perturbation
  3. records each anomaly as a row in seeded_anomalies  ← the ground truth

eval/scripts/run-detection.ts:
  reads seeded_anomalies as the golden set
  runs the live monitoring agent
  scores whether the agent's flagged anomalies match
```

This is what makes the detection eval possible at all — Bloomreach doesn't tell you "there is a real anomaly here, and this is its true magnitude." The authored MCP server does, because you wrote the perturbation that created it.

### Crash isolation via per-run subprocesses

Because the authored server is a Node process you control, the eval driver spawns it fresh per run. Each `K=10` detection run starts a new `mcp-server-olist` subprocess, runs one agent invocation against it, and tears it down. A crash or corruption in run *i* never touches run *i+1*. This is operational hygiene a vendor MCP can't give you — you can't restart Bloomreach between runs.

```
crash isolation per eval run
─────────────────────────────────────────────────────────────
for i in 1..K:
    proc = spawn("node", "mcp-server-olist/dist/src/index.js")
    transport = stdio_to(proc)
    try:
        result[i] = runAgent(transport, anomaly_i)
    catch err:
        result[i] = { error: err }     // recorded, run continues
    finally:
        proc.kill()
```

### When NOT to author your own

Not every MCP integration needs this treatment. Three signals you should:
- you control the backend (your data, your DB) and can model what the model needs
- you need ground truth for an eval (only you can perturb the data and record the truth)
- the model is wasting calls on bad queries against an open primitive (detection eval will tell you)

Three signals you shouldn't:
- the backend is a vendor product (Bloomreach EQL is already the abstraction; re-wrapping it is duplication)
- the access patterns are unbounded (the surface would need 30 tools, not 3 — back to authoring an open primitive)
- there's no eval pressure (without a quality metric, the authoring cost has no payoff)

blooming insights does both — vendor MCP for Bloomreach (live prod), authored MCP for Olist (eval + local). Same agent code, two backends, switched by `bi:mode` via the `DataSource` seam.

### The principle

When you own the backend, author the tool surface the model needs — not the surface a SQL user would write. The model is a typed-RPC client, not a database analyst; the right abstraction is `get_metric_timeseries`, not `execute_sql`. The cost is the authoring effort; the win is that every failure mode an eval can surface is a failure of tool *selection* (a small surface) rather than query *authoring* (an open surface). Combined with the seeded-anomaly contract, this is what made the 4-pillar eval suite possible at all — no ground truth, no eval.

---

## Authoring an MCP server — diagram

This diagram spans the Service layer (the agents that emit tool calls), the Network boundary (stdio MCP transport), the Provider boundary (the authored server process), and the State layer (the SQLite DB + the `seeded_anomalies` ground truth). A reader who sees only this should grasp that the authored server is YOUR code on YOUR data with YOUR query authoring — and that the seeded-anomalies table is what makes the eval pillar load-bearing.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (the agents, same loop)                              │
│                                                                       │
│   MonitoringAgent / DiagnosticAgent / RecommendationAgent / QueryAgent│
│   runAgentLoop emits tool_use { name, input } via DataSource.callTool │
└────────────────────────────────┬──────────────────────────────────────┘
            tool_use ↓                                ↑ tool_result
┌────────────────────────────────▼──────────────────────────────────────┐
│  NETWORK BOUNDARY  (stdio MCP transport)                              │
│   spawn("node", "mcp-server-olist/dist/src/index.js")                 │
│   one fresh subprocess per eval run                                   │
└────────────────────────────────┬──────────────────────────────────────┘
            tool_use ↓                                ↑ tool_result
┌────────────────────────────────▼──────────────────────────────────────┐
│  PROVIDER BOUNDARY  (the AUTHORED server — YOUR TypeScript)           │
│   mcp-server-olist/src/server.ts (MCP wiring)                         │
│   mcp-server-olist/src/tools/                                         │
│     get_metric_timeseries.ts ← Zod schema + parameterized SQL         │
│     get_segments.ts                                                   │
│     get_anomaly_context.ts                                            │
└────────────────────────────────┬──────────────────────────────────────┘
                 SQL ↓                                ↑ rows
┌────────────────────────────────▼──────────────────────────────────────┐
│  STATE LAYER  (SQLite, seeded synthetic data)                         │
│   mcp-server-olist/data/olist.db                                      │
│     ~10k orders + customers + products + payments + reviews           │
│     seeded_anomalies table ← THE GROUND TRUTH (3 rows today)          │
└───────────────────────────────────────────────────────────────────────┘
```

The agent never sees SQL; the model never authors a query; the eval reads `seeded_anomalies` to know what's correct. Three abstractions, three trust boundaries, one stack you wrote end-to-end.

---

## Implementation in codebase

**Case A — implemented.** `mcp-server-olist/` is a sibling Node package, ~1800 LOC of authored TypeScript.

### The MCP server entrypoint

- **File:** `mcp-server-olist/src/index.ts` + `mcp-server-olist/src/server.ts`
- **Role:** Boot the MCP server on stdio, register the three tools, start serving. Spawned as a subprocess by `OlistDataSource` (`lib/data-source/olist-data-source.ts`) for live-sql mode and by every eval run.

### The three tool handlers

- **Files:** `mcp-server-olist/src/tools/get_metric_timeseries.ts`, `get_segments.ts`, `get_anomaly_context.ts`
- **Role:** Each is a Zod-validated handler that takes typed args, runs a parameterized SQL query, and returns a typed result. No open SQL surface.

### The shared schemas

- **File:** `mcp-server-olist/src/schemas.ts`
- **Role:** The Zod schemas the three tools share — metric / dimension / segment / time_range / bucket types — and the JSON-schema export the MCP `tools/list` flow advertises to the agent.

### The DB layer

- **File:** `mcp-server-olist/src/db.ts`
- **Role:** Opens `mcp-server-olist/data/olist.db` (better-sqlite3, synchronous), exposes `prepare()` and a small set of helpers. The DB is read-only at runtime; only the seed script writes.

### The seed script (ground truth)

- **File:** `mcp-server-olist/scripts/seed-olist.ts` (compiled to `dist/scripts/seed-olist.js`; run via `npm run seed`)
- **Role:** Generates ~10k synthetic Olist orders, applies the three seeded anomalies (`sp-revenue-drop-w4`, `electronics-spike-w2`, `voucher-dropoff-w10-on`), and writes both the data AND the `seeded_anomalies` rows. This is the load-bearing script — without it, the eval pillar has no ground truth.

### The DataSource adapter

- **File:** `lib/data-source/olist-data-source.ts`
- **Role:** Implements `DataSource` (from `lib/data-source/types.ts`) by spawning the Olist server as a child process and routing `callTool` / `listTools` over stdio. The route handlers and eval scripts both go through this — they never spawn the subprocess directly.

### npm scripts

- **File:** `mcp-server-olist/package.json`
- **Scripts:** `"build": "tsc -p tsconfig.json"`, `"seed": "tsc -p tsconfig.json && node dist/scripts/seed-olist.js"`, `"start": "node dist/src/index.js"`.

### Tests

- **Directory:** `mcp-server-olist/test/` — Vitest tests for each tool handler (input validation, SQL correctness against a known seed), part of the 269 total.

---

## Elaborate

### Where this pattern comes from

The "domain tool over open primitive" tradeoff predates LLMs. It's the difference between **stored procedures vs ad-hoc SQL** (DB world), **typed RPC vs HTTP query strings** (API world), and **library functions vs eval()** (programming world). Each generation answered the same question: when a less-trusted side authors the request, do you give them an open expression language or a fixed RPC menu? The LLM-MCP version is the latest iteration. MCP itself is the protocol (Anthropic's, late 2024); the design choice — domain tools vs open primitives — is older than MCP and survives every protocol turn.

### The deeper principle

```
who authors the request          who owns correctness     instrument
─────────────────────────         ──────────────────────   ─────────────────
ad-hoc SQL user                   the user                 SQL engine
stored procedure user             DBA who wrote the proc   procedure validation
GraphQL caller                    schema + resolvers       schema validation
LLM with execute_sql              the model                hope + injection guards
LLM with domain tools             YOUR server              Zod + parameterized SQL
```

The instrument that catches bad requests scales with where authoring lives. An open primitive needs runtime guards (every query is a new chance to fail); a domain tool needs schema validation (every call is the same shape). The LLM-as-caller is the *least* trustworthy of the row — its authoring is non-deterministic — so the cost-benefit of authoring tightens further toward domain tools.

### Where this breaks down

1. **Authoring cost grows with surface area.** Three tools is cheap; thirty is a sub-project. If your access patterns are genuinely unbounded — every analysis is novel — domain tools collapse back into an open primitive (one "run any query" tool), and you're back where you started. The right scope for domain tools is the access patterns the eval surfaces actually exercise.

2. **Schema drift on the authored side is silent.** If you add a column to the SQLite DB but forget to expose it through a tool, the agent can't see it — and there's no error, just a smaller surface. The fix is treating tool schemas as code that goes through review like any other API contract.

3. **Domain tools constrain creativity.** A model with `execute_sql` can answer "what's the median order value for users who bought voucher payments at least twice but never card?" — one query. The same question against three domain tools needs the agent to compose them, which it may not do well. You pay for safety with expressiveness; the eval suite tells you when the price gets too high.

### What to explore next

- **A fourth tool for the missing access pattern.** The current detection eval shows strict recall at 0% — the "recent 4w vs baseline 12w" framing can't catch mid-horizon week-specific anomalies. A `detect_outliers(dimension, window=full_horizon, method=z_score)` tool would let the agent ask for statistical outliers across the full horizon in one call. This is exactly the "add a tool when an eval surfaces a real gap" rule applied.
- **Replay-mode for the seed.** Today the seed produces one fixed dataset. A `--seed-rng=42` flag would make the dataset deterministic AND lets evals run on different perturbations without changing the schema — useful for testing how the eval scores under different anomaly intensities.
- **Cross-tool consistency tests.** `get_metric_timeseries` summed over a dimension should equal `get_segments` aggregated. A Vitest property test would catch divergence — the kind of bug that's invisible to the agent but breaks eval interpretability.

---

## Project exercises

### Add a fourth tool — `detect_outliers` — to close the strict-detection gap

- **Exercise ID:** B4.4 (adapted) — surface a real eval-flywheel iteration.
- **What to build:** add `mcp-server-olist/src/tools/detect_outliers.ts` that takes `{ dimension, metric, time_range, method: "zscore" }` and returns the top-K statistical outliers across the full horizon (not just the recent window). Update `mcp-server-olist/src/schemas.ts`, the MCP `tools/list` registration in `server.ts`, and the per-agent allowed-tool sets in `lib/mcp/tools.ts` (add to `monitoringTools`). Re-run `npm run eval:detection -- --K=10` and document the lift (if any) in strict recall.
- **Why it earns its place:** the strict 0% recall finding at `eval/results/2026-06-15-after-fix/summary.md` names this exact tool as Path B ("the real fix"). Building it closes the eval flywheel loop — surface bug → fix at the tool layer, not just the prompt layer → re-score.
- **Files to touch:** `mcp-server-olist/src/tools/detect_outliers.ts` (new), `mcp-server-olist/src/schemas.ts`, `mcp-server-olist/src/server.ts`, `lib/mcp/tools.ts`, `mcp-server-olist/test/detect_outliers.test.ts`, optionally update `lib/agents/prompts/monitoring.md` to teach the agent when to call it.
- **Done when:** a re-run of `npm run eval:detection -- --K=10` shows strict recall > 0% on at least one of the two currently-missed anomalies (sp-revenue-drop-w4 or electronics-spike-w2), and the new tool is exercised in the trace.
- **Estimated effort:** 3-4 hours

### Cross-tool consistency property test

- **Exercise ID:** C4.4 (provenance) — guard the authored surface against silent drift.
- **What to build:** a Vitest property test in `mcp-server-olist/test/consistency.test.ts` that asserts `sum over all segments returned by get_segments == sum of get_metric_timeseries.points` for the same metric / time_range / dimension. Run on each tool change.
- **Why it earns its place:** authored tools can drift independently — fix a bug in one query template, forget to fix the parallel one in another tool, and your evals quietly become inconsistent. Property tests catch this for free.
- **Files to touch:** `mcp-server-olist/test/consistency.test.ts`, possibly `mcp-server-olist/src/db.ts` for any shared helper.
- **Done when:** the property test passes today and fails on a synthetic divergence (e.g., apply a multiplier to one tool's SQL and not the other).
- **Estimated effort:** <1 day

---

## Interview defense

### What an interviewer is really asking

"Why didn't you just give the agent SQL access?" tests whether you understand the tradeoff between open primitives and domain tools, and whether you can name the failure modes the open primitive imports. The junior answer is "it's cleaner." The senior answer is "open primitives push query correctness onto the model, which the detection eval will catch failing on" — and being able to name the specific failure (bad time horizons, wrong schema assumptions) that drove the authoring decision.

### Likely questions

**[mid] Why three tools, not one `execute_sql`?**

Three reasons. **(1) Failure surface.** An open `execute_sql` lets the model write any query — including wrong joins, out-of-horizon dates, expensive scans. Three domain tools collapse all those into "pick the right tool and pass typed args"; the SQL is mine, tested, and parameterized. **(2) Ground truth.** The detection eval needs to score the model's output against seeded anomalies — that only works if I can record what's true. Open primitives can't do that. **(3) Token economics.** `get_anomaly_context` bundles 3-5 queries the diagnostic agent would otherwise issue separately; that's fewer tool calls, fewer billed turns, faster runs.

```
execute_sql:   model writes query → server runs → infinite failure modes
domain tools:  model picks tool   → server runs YOUR query → bounded failure
```

**[senior] You're running the authored server as a subprocess per eval run. Why not pool it?**

Crash isolation. Each K=10 run spawns a fresh subprocess so a crash or corruption in run *i* never touches run *i+1*. The cost is ~100ms of process spawn per run, paid 10 times — irrelevant against ~30-60s per agent run. The win is that any run can crash, the K-series records `runs[i].error`, and the aggregate continues honestly. A vendor MCP can't give you this — you can't restart Bloomreach between runs.

```
per-run spawn → run crash isolated → K series honest
pooled        → run crash leaks state → next run lies
```

**[arch] How do you decide when to add a fourth tool?**

When an eval surfaces a real gap I can't close at the prompt layer. The detection eval (`eval/results/2026-06-15-after-fix/summary.md`) shows strict recall at 0% — the "recent 4w vs baseline 12w" framing in the monitoring prompt fundamentally can't catch mid-horizon week-specific anomalies. Path A (prompt fix) lifted loose recall 5×; Path B is a new `detect_outliers` tool. That's the rule: add a tool when an eval shows the prompt isn't enough.

```
eval shows gap → try prompt fix → if ceiling, add tool
not "the agent might want a tool" — "the eval proves the agent needs one"
```

### The question candidates always dodge

**"Why didn't you just use the existing Bloomreach MCP for evals too?"** Three honest reasons: (1) Bloomreach is rate-limited (~1 req/s) — K=10 monitoring runs at ~6 tool calls each would take ~5 minutes just for tool budget, before any inference; (2) Bloomreach doesn't expose a "this is a seeded anomaly with these properties" table — you can't measure correctness against a ground truth you don't have; (3) Bloomreach auth tokens expire on the alpha (the codebase has auto-reconnect for this exact reason in prod) and an expiring token mid-eval-run poisons the result. The authored server is local, deterministic, ground-truthed, and rate-limit-free. People who say "just use prod" haven't tried to run K=10 evals against an alpha API.

### One-line anchors

- Three domain tools, not `execute_sql` — query authoring lives in my TypeScript, not in the model.
- `seeded_anomalies` table = ground truth = what makes detection eval scorable at all.
- One fresh subprocess per eval run = crash isolation a vendor MCP can't give you.
- Add a tool when an eval shows a real gap (e.g., `detect_outliers` for strict recall at 0%).
- The cost is authoring; the win is bounded failure surface + ground truth.

---

## See also

→ 02-tool-calling.md · → 04-tool-routing.md · → 06-error-recovery.md · → 07-capability-gating.md · → ../05-evals-and-observability/01-eval-set-types.md · → ../05-evals-and-observability/05-regression-evals.md · → ../07-system-design-templates/03-multi-rubric-eval-pipeline.md

---
Updated: 2026-06-16 — new file. Documents the authored `mcp-server-olist/` package: the three domain tools (`get_metric_timeseries`, `get_segments`, `get_anomaly_context`) vs the raw `execute_sql` alternative, the `seeded_anomalies` ground-truth contract, the per-run subprocess crash isolation, and the eval-flywheel rule for adding a fourth tool.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
