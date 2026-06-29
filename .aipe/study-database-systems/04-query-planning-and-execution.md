# Query planning and execution

Industry standard · Query processor internals

## Zoom out — where a query planner would live, and what's there instead

A SQL query planner parses your query, builds a logical plan, costs alternative physical plans against statistics, picks the cheapest one, and executes it through a tree of operators (scan, filter, join, hash, sort, limit). This codebase has **no query language and no planner.** The closest thing to query planning lives in the agent layer, where Claude decides which EQL strings to send to Bloomreach — and the planner of those EQL queries lives at the provider, not here.

```
  Zoom out — where query planning would happen (and what's there)

  ┌─ UI / agent layer ──────────────────────────────────────────┐
  │  Claude (sonnet-4-6) decides: "run execute_analytics_eql"    │
  │   with this metric, this window, this scope                  │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ tool call
  ┌─ Adapter layer ────────────────▼──────────────────────────────┐
  │  BloomreachDataSource — sends EQL string upstream, no parsing│
  └───────────────────────────────┬──────────────────────────────┘
                                  │ MCP / HTTP
  ┌─ Provider — owns the planner ─▼──────────────────────────────┐
  │  Bloomreach Engagement                                        │
  │  parses EQL → logical plan → physical plan → execution        │
  │  THIS is where query planning lives                           │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Local "queries" ─── you-are-here for this guide ────────────┐
  │  Map.get(id)              ← "SELECT WHERE id = ?"             │
  │  Map.values() + filter    ← "SELECT WHERE …" scan + filter    │
  │  no joins, no aggregates, no plan tree                        │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — the question this concept answers

In a real DB: "how does the engine decide HOW to execute a query?" Here: "what queries do we even run, and against what?" The honest answer in two parts: (1) the *interesting* queries are EQL run upstream by the provider, planned by them; (2) the *local* queries are `Map.get` for primary key and `Map.values().filter()` for everything else — there is no plan because there's nothing to choose between.

## Structure pass — the skeleton

### Two query worlds in this app

  - **Upstream (Bloomreach + EQL).** Real query language. Real planner. Real execution. We're a client; we never see the plan. The agent constructs the EQL string from natural-language reasoning.
  - **Local (the Maps).** Two operations only: `Map.get(id)` for PK, `Map.values()` for full scan. No language to parse, no plan to build, no execution operators.

### Axis: who decides the query plan?

```
  The "plan decision" axis, by layer

  ┌─ agent layer ───────────────────────────────┐
  │  LLM decides WHICH EQL queries to issue     │   ← "what to ask"
  └─────────────────────────────────────────────┘
       ┌─ provider ──────────────────────────────┐
       │  Bloomreach decides HOW to execute EQL  │   ← "how to answer"
       └─────────────────────────────────────────┘
            ┌─ local state ──────────────────────┐
            │  call site decides Map.get or scan │   ← no plan; static
            └────────────────────────────────────┘
```

The interesting "plan" is the agent's choice of which EQL to issue. That belongs to `study-ai-engineering`, not here — but it's worth naming because it's where the closest-to-database-planning decision in this codebase actually happens.

### Seams

The seam that matters: **the adapter passes EQL strings through opaquely.** The local code does not parse, rewrite, or plan EQL. Whatever string the agent constructs is the string the provider executes. That's a deliberate boundary — it keeps the local code provider-agnostic at the DataSource interface (`lib/data-source/types.ts`) and means changing engines would not change anything in this repo's "planning" because there's none to change.

## How it works

### Move 1 — the mental model

If you've ever written a `users.filter(u => u.role === 'admin')` instead of an `await db.users.findMany({ where: { role: 'admin' } })` — that's the difference. The first is local, the second goes through a planner. This codebase has the first kind for local state and delegates the second kind entirely to Bloomreach.

```
  The shape — two query kinds in this codebase

   LOCAL QUERIES (no planner)               REMOTE QUERIES (provider plans)

   Map.get(id)                              callTool('execute_analytics_eql', {
   Map.values().filter(…)                     query: 'SELECT count(...)'
   ↓                                        })
   call site picks the access pattern       ↓
   no choice to plan                        Bloomreach parses + plans + runs
```

### Move 2 — the walkthrough

#### Local "query 1" — `SELECT WHERE id = ?` (here: `getInsight`)

```ts
// lib/state/insights.ts:73-75
export function getInsight(sessionId: string, id: string): Insight | null {
  return state.get(sessionId)?.insights.get(id) ?? null;
}
```

Annotation:
  - Equivalent SQL: `SELECT * FROM insights WHERE session_id = ? AND id = ? LIMIT 1;`.
  - The plan a real engine would pick: index seek on a composite `(session_id, id)` primary key. Two `Map.get` calls is the in-memory equivalent — same `O(1)` cost, no plan to choose.
  - There is no result-set caching here beyond the Map being the source of truth. The cache exists one layer down (BloomreachDataSource), where it caches the *upstream* query result.

#### Local "query 2" — `SELECT * WHERE session_id = ?` (here: `listInsights`)

```ts
// lib/state/insights.ts:81-84
export function listInsights(sessionId: string): Insight[] {
  const s = state.get(sessionId);
  return s ? [...s.insights.values()] : [];
}
```

Annotation:
  - Equivalent SQL: `SELECT * FROM insights WHERE session_id = ?`. No WHERE on insight fields, no ORDER BY, no LIMIT.
  - Plan: index scan on `session_id` to find the namespace, then a full table scan within that namespace.
  - The actual execution: one `Map.get` (`O(1)`) plus one materialize-iterator-to-array (`O(n)` where n is per-session row count, today low double digits).

There are no joins, no aggregates, no sub-queries, no group-by, no window functions. There IS a sort sometimes — but it lives in React (`useMemo` sorting by severity or timestamp), not in the state layer.

#### Local "query 3" — the implicit filter pattern

The UI routinely renders subsets of the full list. This is where the lack of a planner is visible: every filter is a JS expression over the full materialized array.

```ts
// hypothetical UI shape (the actual code lives in feed components)
const insights = await fetch('/api/briefing').then(r => r.json());
const critical = insights.filter(i => i.severity === 'critical');
```

Annotation:
  - In a real DB this would be `SELECT * FROM insights WHERE severity = 'critical'`. The planner would pick between an index scan on `(severity)` and a sequential scan + filter, depending on statistics.
  - Here, every call site fetches all rows and filters in JS. There's no choice to make; the only access path is the scan.
  - The cost stays invisible at small N. The pattern would NOT scale — and the right time to add an index is when the N changes, not preemptively.

#### Upstream queries — the agent constructs EQL strings

The interesting "query planning" decision in this codebase is the agent's. Claude reads a system prompt that tells it the EQL grammar and the Bloomreach metric vocabulary, then reasons: "to detect an anomaly in purchase revenue, I need `sum event purchase.total_price` over the last 90 days and the prior 90 days; let me issue two `execute_analytics_eql` calls."

```ts
// the shape — agent → tool call → adapter → provider
// the actual loop lives in lib/agents/base.ts (runAgentLoop)
const result = await dataSource.callTool('execute_analytics_eql', {
  project_id: projectId,
  query: '<EQL string the agent constructed>',
}, { signal });
```

Annotation:
  - The "plan" the agent decides: which metric, which window, which scope. This is content-level planning, not engine-level.
  - The "plan" the provider decides: how to execute that EQL against Bloomreach's storage. We never see this. We see only the result.
  - The adapter contributes one optimization: the 60s response cache (`lib/data-source/bloomreach-data-source.ts:122,144-148`). If the agent issues the same `name+args` twice within a minute, the second call short-circuits. That's the closest thing in this codebase to a *result-set cache* — and it's the moral equivalent of a materialized view with TTL invalidation.

#### EXPLAIN — there is none

A real database lets you ask `EXPLAIN <query>` and get the plan it would use. There is no equivalent here. The closest analog is the *reasoning trace*: when an agent decides to issue an EQL query, it emits a `reasoning_step` event over NDJSON (`AgentEvent` in `lib/mcp/events.ts`), and the UI's `StatusLog` renders it. That's not a query plan — it's a record of which queries got issued and why — but it serves the same debugging role.

### Move 3 — the principle

A query planner exists to *make hard choices on the user's behalf*. Multiple access paths, multiple join orders, multiple algorithms (hash join vs nested loop vs merge), each with different cost characteristics depending on data statistics. When there's only one access path (the `Map`) and only one access pattern (PK lookup or full scan), there's nothing to plan and no planner to build. The planning question reappears the moment you have *choice* — and choice arrives with secondary indexes, joins, or a real query language.

## Primary diagram

```
  The query story — two layers, very different shapes

  ┌─ The local "query layer" ────────────────────────────────────┐
  │                                                                │
  │   getInsight(id)  ─►  Map.get(sid).get(id)  ─►  O(1) PK seek  │
  │   listInsights()  ─►  Map.get(sid).values()  ─►  O(n) scan    │
  │   anything else   ─►  scan + JS filter                         │
  │                                                                │
  │   no query language · no planner · no plan tree · no EXPLAIN   │
  └────────────────────────────────────────────────────────────────┘
                                  │
                                  │  derivative data only
                                  ▼
  ┌─ The upstream "query layer" (provider) ──────────────────────┐
  │                                                                │
  │   agent (Claude) constructs EQL string                         │
  │      ↓                                                          │
  │   BloomreachDataSource.callTool('execute_analytics_eql', …)    │
  │      ↓  (60s cache hit short-circuits here)                    │
  │   Bloomreach parses + plans + executes                         │
  │      ↓                                                          │
  │   rows return                                                   │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The classic taxonomy (Hellerstein & Stonebraker, Garcia-Molina) splits query processing into parse → rewrite → optimize → execute. This codebase's *local* path collapses all four into "call site." Its *remote* path delegates all four upstream. The interesting middle layer — the EQL the agent constructs — has no static planner; the planning IS the LLM's reasoning, evaluated dynamically per request.

That's an emerging pattern worth naming: in LLM-fronted data systems, the "query planning" shifts from a static cost-based optimizer to a runtime *language model* that chooses queries based on the goal description. The cost model becomes "what does the prompt + the schema description suggest is the cheapest way to answer this," which is a soft, learned cost model rather than a hard, calibrated one. It works well for ad-hoc analytical questions like "what changed in the last 90 days" and badly for queries with tight latency budgets.

For this codebase, the actionable read: if local queries ever grow beyond two-shape (`get` + `list`) — say, "give me insights tagged with this campaign across the last 7 days" — the right move is a real datastore with a real planner, not building a planner into JS.

## Interview defense

> Q: "Walk me through query execution in this app."

Verdict: there are two query worlds and neither has a local planner. Upstream queries are EQL, sent to Bloomreach as opaque strings; the provider parses, plans, and executes them. Local queries are two shapes: `Map.get(id)` for primary key (`O(1)`) and `Map.values()` for full scan (`O(n)`). Everything else — filter by severity, sort by timestamp — happens in JavaScript over the materialized array.

```
  the picture you draw — two layers, two roles

   agent ── EQL string ──►  Bloomreach          (provider plans + runs)
                  ▲
                  │ short-circuit if cached <60s
                  │
            DataSource cache
                  ▲
   local Map ◄── call site picks Map.get vs Map.values
```

The load-bearing point: there is no query plan to choose between because there is no choice. Adding a planner would require first adding the things planners exist for — secondary indexes, joins, alternative access paths.

> Q: "What's the equivalent of EXPLAIN in this codebase?"

The reasoning trace. Every agent decision to issue a tool call (including each EQL query) emits a `reasoning_step` event on the NDJSON stream, which the UI renders in the `StatusLog`. It's not a plan tree — it's a record of which queries got issued and why. For debugging "why did the agent ask this," it's the analog.

> Q: "When would you add a planner?"

When local queries gain a real choice. The first trigger is usually a secondary index — once `WHERE severity = ?` can be served two ways (scan vs index), someone has to choose. The second is joins — joining persisted insights with persisted user preferences, say. Both require a real datastore first; until then, "the planner" is a one-line `if (id) Map.get else Map.values`.

## See also

  - [`03-btree-hash-and-secondary-indexes.md`](./03-btree-hash-and-secondary-indexes.md) — the indexes a planner would choose between
  - [`08-replication-and-read-consistency.md`](./08-replication-and-read-consistency.md) — how the materialized view role gets played by the 60s cache
  - `.aipe/study-ai-engineering/` — how the agent decides which EQL to run
