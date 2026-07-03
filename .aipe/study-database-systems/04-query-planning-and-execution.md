# Query planning and execution

*Query execution / Language-agnostic*

## Zoom out, then zoom in

You know how in Postgres you write SQL, the planner picks between "seq scan" and "index scan" and various join algorithms, and `EXPLAIN` shows you what it chose? This repo has none of that machinery. It has agents that pick their own EQL queries against Bloomreach, and it has hardcoded scan-shaped reads on the local Maps. There is no plan to explain because there is nothing to plan.

```
  Zoom out — where "query execution" happens

  ┌─ UI ─────────────────────────────────────────────────────┐
  │  a card render is a "SELECT" against the session Map      │
  └────────────────────┬─────────────────────────────────────┘
                       │
  ┌─ Service ──────────▼─────────────────────────────────────┐
  │                                                          │
  │  ★ agent-generated EQL → sent to Bloomreach              │ ← this file's scope
  │    lib/agents/*.ts + lib/agents/prompts/*.md              │
  │                                                          │
  │  ★ hardcoded Map iteration/filter                         │
  │    listInsights, resolveAnomaly, gate.eval.ts scans       │
  │                                                          │
  │  no planner · no EXPLAIN · no join algorithm choice        │
  │                                                          │
  └────────────────────┬─────────────────────────────────────┘
                       │ execute_analytics_eql (MCP tool)
  ┌─ Provider (Bloomreach) ▼─────────────────────────────────┐
  │  their planner runs EQL, returns rows                     │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** The "planner" in this repo is *the agent's prompt*. The monitoring agent decides what EQL to run based on how it's prompted; Bloomreach executes it. Everything local is fixed-shape access — no query language, no choices to make.

## Structure pass

**Axis to hold constant: who decides the access shape?**

```
  "who chooses the query shape?" — traced across the layers

  ┌─ agent layer ────────────────────────────────────────────┐
  │  the monitoring/diagnostic/recommendation agent decides   │  → LLM decides
  │  which tool + which EQL to send                           │
  │  lib/agents/base.ts (runAgentLoop)                        │
  └──────────────────────────────────────────────────────────┘
      ┌─ MCP client ────────────────────────────────────────────┐
      │  BloomreachDataSource caches, spaces, retries — but       │  → CODE decides
      │  never rewrites the tool call                             │    (pass-through)
      │  lib/data-source/bloomreach-data-source.ts               │
      └─────────────────────────────────────────────────────────┘
          ┌─ Bloomreach execution ─────────────────────────────────┐
          │  their planner runs EQL. Opaque. Latency + rate limits  │ → their planner
          │  are what we observe.                                   │
          └────────────────────────────────────────────────────────┘
```

The seam that flips the axis: **the MCP boundary between our code and Bloomreach.** On our side, no query is ever rewritten or replanned; on their side, EQL gets planned properly. That's why the interesting execution mechanics here are agent-side (which EQL to send) rather than engine-side (how to run it).

## How it works

### Move 1 — the mental model

Standard shape of a query in a real DB:

```
  standard planner path

  SQL ──► parser ──► logical plan ──► planner ──► physical plan
                                        │
                                        └── picks index-scan vs seq-scan,
                                            hash-join vs merge-join,
                                            sort strategy, etc.
                                        │
                                        ▼
                                     executor
                                        │
                                        ▼
                                     rows out
```

This repo's shape:

```
  this-repo path — the "planner" is a prompt

  agent turn ──► LLM decides tool + args ──► MCP tool call
                        │
                        └── tool = execute_analytics_eql
                            args = { eql, timezone, ... }
                        │
                        ▼
                Bloomreach executes (opaque)
                        │
                        ▼
                    result JSON
                        │
                        ▼
                agent unwraps, may plan another turn
```

The load-bearing insight: **query planning happens in prompt space.** The `lib/agents/prompts/*.md` files (monitoring, diagnostic, recommendation, query) describe *how* the agent should decide what to query. `lib/agents/tool-schemas.ts` describes *what* the agent can call. The LLM picks the next tool call each turn — that's the planning step. There is no `EXPLAIN` for it.

### Move 2 — the primitives walked

**The agent loop is the executor.**

```
  lib/agents/base.ts — runAgentLoop skeleton
  ──────────────────
  loop:
    send message history + tool schemas to Claude
    receive: (a) text response  OR  (b) tool_use block(s)
    if tool_use:
      for each tool_use:
        result = dataSource.callTool(name, args, { signal })
        append tool_result to history
      continue
    else:
      break  (agent said "done")
```

That's the shape. It's not a query planner in the DBMS sense — it's an interactive planner where each step is one tool call, and the model picks the next step based on what came back. The `for each tool_use` fan-out is the closest thing to *parallel scans* in the codebase: multiple tools can be called in one turn.

**The tool call is the query.**

Every read from Bloomreach goes through one tool. The catalog lives at `lib/mcp/tools.ts`. The three most-used ones in the analytical path:

```
  bootstrap chain (every request replays it):
    list_cloud_organizations   → get org id
    list_projects              → get project_id
                                 (see MEMORY.md — bootstrap chain rule)

  analytical:
    execute_analytics_eql      → the actual "SELECT" — pass EQL, get rows
    get_project_overview       → workspace-level facts
    get_event_schema           → what event types exist
```

`execute_analytics_eql` is the only tool that takes a query language as argument. Everything else is fixed-shape ("give me the customer schema," "list catalogs"). That's the seam where "our code" ends and "their planner" begins.

**Caching = plan reuse.**

```ts
// lib/data-source/bloomreach-data-source.ts:144-152
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

Same tool + same args = cached result for 60s. In DB terms this is *prepared-statement result caching* — you're not saving on planning (the plan wasn't ours), you're saving on execution and network. The cache key IS the full query; there's no plan-shape reuse below that granularity.

**Local "queries" are hardcoded scan shapes.**

```ts
// lib/state/insights.ts:81-84
export function listInsights(sessionId: string): Insight[] {
  const s = state.get(sessionId);
  return s ? [...s.insights.values()] : [];
}
```

This is a `SELECT * FROM insights WHERE session_id = ? ORDER BY insertion_order`. Fixed shape. No `WHERE severity = 'critical'`, no `LIMIT`, no `ORDER BY severity DESC`. The caller sorts or filters in the UI if needed. Same for `resolveAnomaly` at `app/api/agent/route.ts:35-49` — two point-lookups (`getAnomaly` then fallback to `getInsight`), no planner choice.

**The "join" step lives at the composition layer.**

```ts
// app/api/agent/route.ts:35-49
function resolveAnomaly(sessionId: string, insightId: string, insightParam?: string | null): Anomaly | null {
  const a = getAnomaly(sessionId, insightId);
  if (a) return a;
  const i = getInsight(sessionId, insightId);
  if (i) return insightToAnomaly(i);
  ...
}
```

Two "table" lookups keyed by the same id — the `anomalies` inner Map first, then fall back to `insights` and back-derive. That's a *nested-loop join with early exit* on a table of size 1. In a real DB the planner would decide "hash join, merge join, or nested loop" based on cardinality estimates; here the cardinality is 1 and the join is spelled out inline.

**Gate: full-scan-with-filter over the receipts directory.**

```ts
// eval/gate.eval.ts:63-71
const candidateRunId = pickRunId(process.env.RUN_ID);
const files = readdirSync(RECEIPTS_DIR)
  .filter((f) => f.endsWith(`${candidateRunId}.json`))
  .sort();
if (files.length === 0) throw new Error(`No receipts for candidate runId ${candidateRunId}`);

const receipts: Receipt[] = files.map(
  (f) => JSON.parse(readFileSync(resolve(RECEIPTS_DIR, f), 'utf8')) as Receipt,
);
const candidate = computeBaseline(candidateRunId, receipts);
```

That's a `SELECT * FROM receipts WHERE run_id = ?` executed as:
1. **Scan** — readdirSync the whole dir (28 entries).
2. **Filter** — string-suffix match on the filename.
3. **Materialize** — JSON.parse each match.
4. **Aggregate** — `computeBaseline` folds them into one Baseline row.

Then step 5 is a *lookup join* against the committed baseline row:

```ts
// eval/gate.eval.ts:53-58
const baselinePath = resolve(EVAL_DIR, baselineFile);
let baseline: Baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
}
```

Read one row (`eval/baseline.json`). Compare per-dimension pass rates against the candidate. This IS a query with a real plan — filter, materialize, aggregate, lookup — just spelled out in TypeScript rather than SQL.

### Move 2 variant — the load-bearing skeleton

The minimum viable "execution layer" here is:

1. **The agent loop's tool-use fan-out.** `runAgentLoop` at `lib/agents/base.ts`. Remove it and the agents can't run multi-step diagnoses — the whole "form hypothesis → test with EQL → refine" flow depends on iterated tool calls.
2. **`execute_analytics_eql` as the sole analytical query surface.** Remove it and there is no way to compute a metric that isn't in a pre-built tool. The whole "period-over-period 90d" method (`context.md`) depends on it.
3. **The response cache as plan-reuse.** Remove it and the bootstrap chain (list_cloud_organizations + list_projects on every call) burns 3 real requests per agent turn, hitting the ~1 req/s limit within seconds.

The rest — `listInsights` returning insertion order, the receipts filter+sort — is optimization or shape choice.

### Move 3 — the principle

**When the planner isn't yours, cache aggressively and rate-govern honestly.** You can't optimize Bloomreach's query plan from outside — you can only avoid asking it twice and avoid asking it too fast. The 60s TTL + ~1 req/s spacing + parsed retry-after ladder (`bloomreach-data-source.ts:64-72, 163-174`) is what makes an alpha rate-limited backend usable. The "planning" work you do here is *at the agent prompt layer*: teach the agent to pick queries that answer the question with fewer round-trips. That's the actual query-optimization surface in an AI-agent-in-front-of-a-DB shape.

## Primary diagram

```
  Query execution end to end

  ┌─ agent turn ──────────────────────────────────────────────┐
  │                                                            │
  │  Claude decides:  "call execute_analytics_eql with EQL X"  │  ← the "planner"
  │                        │                                   │
  └────────────────────────┼───────────────────────────────────┘
                           │
                           ▼
  ┌─ BloomreachDataSource.callTool ───────────────────────────┐
  │  1. compute cacheKey = `${name}:${JSON.stringify(args)}`   │
  │  2. check cache; return if hit                             │  ← plan reuse
  │  3. proactive ~1 req/s spacing                             │  ← rate governor
  │  4. transport.callTool → over the wire                     │
  │  5. on rate-limit: parse retry-after, retry ≤ maxRetries   │
  │  6. cache successful result 60s                            │
  │                                                            │
  │  bloomreach-data-source.ts:139-188                         │
  └────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
  ┌─ Bloomreach loomi connect ───────────────────────────────┐
  │  their planner runs EQL, returns { structuredContent }    │
  └────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
  ┌─ back into the agent loop ───────────────────────────────┐
  │  unwrap<T>(result) — prefer structuredContent, else       │
  │  content[0].text                                          │
  │  lib/mcp/schema.ts:33-42                                  │
  │                                                           │
  │  append tool_result to message history, loop again        │
  └───────────────────────────────────────────────────────────┘
```

## Elaborate

There's a real analog to database query optimization here, and it's *prompt engineering*. The monitoring agent's prompt (`lib/agents/prompts/monitoring.md`) is the query-plan hint layer — it teaches the LLM which tools to reach for first, how to batch, how to compose EQL for 90-day windows. Bad prompts = expensive plans = burned rate-limit budget. This is the surface the app actually spends time optimizing, and it maps neatly onto DB planner tuning:

- **Cardinality estimates** ↔ the prompt tells the agent "there are ~N countries; only drill down when the global change is > threshold."
- **Index hint** ↔ "prefer `get_event_schema` before writing EQL that references event properties."
- **Materialized view** ↔ the 60s cache — same call, no re-run.
- **Query rewrite** ↔ the agent restating the question after a failed tool call.

`study-ai-engineering` and `study-prompt-engineering` own this thread; here it's just enough to say *the query-optimization surface exists*, it's just not where you'd expect.

### `not yet exercised`

- **`EXPLAIN` / `EXPLAIN ANALYZE` on any local query.** No local planner to explain.
- **Join algorithms — hash join, merge join, nested loop.** The only "join" is a two-hash-lookup composition in `resolveAnomaly`.
- **Query rewrite / view expansion / CTE optimization.** No SQL locally.
- **Cost-based optimization, statistics collection, ANALYZE.** No planner.
- **Prepared statements / parameterized query caching at the DBMS layer.** Cache keys are computed by us; there's no separate "plan cache."
- **N+1 detection.** No ORM issuing per-row queries — the agent decides shot count directly.

## Interview defense

**Q: "How does query execution work here?"**

Model answer: "There's a two-layer split. Locally there's no planner — every read is a hardcoded scan or a hash lookup. The 'planner' in the DBMS sense lives across the MCP boundary, inside Bloomreach. Between the two, `BloomreachDataSource.callTool` at `lib/data-source/bloomreach-data-source.ts:139-188` handles the parts that a DBMS would call plan-reuse and rate-governance: a 60s response cache keyed by `${name}:${JSON.stringify(args)}`, proactive ~1 req/s spacing, and a retry ladder that parses Bloomreach's own retry-after hint. The interesting 'query optimization' surface isn't SQL — it's the agent's prompt, which decides which tools to call in what order. That's where round-trip count comes from."

Diagram to sketch: the "query execution end to end" primary diagram — agent decides, cache checks, wire crosses, unwrap, loop.

**Q: "How does the app avoid N+1?"**

Model answer: "By design, not by tooling. There's no ORM issuing per-row queries. The agent gets a batch of tools per turn and can fan out in one message — that's the parallel-scan analog. The tool-use handling in `runAgentLoop` iterates every `tool_use` block in one response, so 'give me the schemas for these 5 events' is one turn, not five. The place N+1 could bite is if the *prompt* asked the agent to loop over N things one at a time; that's caught at eval time in `eval/receipts/` when the tool-call count exceeds budget. The per-investigation budget ceiling landed in Week 3D — it's the guardrail."

Anchor: agent fan-out per turn + eval-time budget ceiling replaces DB-side N+1 detection.

## See also

- `01-database-systems-map.md` — where this executor sits in the storage picture.
- `03-btree-hash-and-secondary-indexes.md` — the local hash lookups that stand in for indexed reads.
- `05-transactions-isolation-and-anomalies.md` — atomicity of the multi-tool agent turn.
- `08-replication-and-read-consistency.md` — the demo replay as a cached "materialized view."
