# Query Planning and Execution

## Subtitle

How a database turns SQL into a sequence of physical operations · Industry standard.

## Zoom out, then zoom in

```
  Zoom out — where the planner sits in a normal app

  ┌─ App ──────────────────────────────────────────┐
  │  SQL string                                    │
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ Parser ───────────▼───────────────────────────┐
  │  SQL → logical tree                            │
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ Planner ──────────▼───────────────────────────┐
  │  ★ THIS GUIDE ★                                │
  │  logical tree → physical plan (which index,    │
  │  which join algo, which sort method)            │
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ Executor ─────────▼───────────────────────────┐
  │  walks the plan, returns rows                  │
  └────────────────────────────────────────────────┘
```

### Verdict for this codebase

**Exercised on the Olist side. We now own SQL.**

Three altitudes of planning:

1. **Agent layer** (`lib/agents/monitoring.ts`) — Claude decides which MCP tool to call next. Not a query planner; a tool dispatcher. Unchanged from before.
2. **Bloomreach mode** — Bloomreach's EQL engine runs on the other side of the network. Opaque to us.
3. **Olist mode (NEW)** — `mcp-server-olist/src/tools/get_metric_timeseries.ts` constructs SQL dynamically (JOIN list depends on metric + dimension + filter), runs `db.prepare(sql).all(params)`, and **SQLite's cost-based planner picks the index** on the other side of the prepared-statement call. We can run `EXPLAIN QUERY PLAN` against this DB and see real output.

The teaching now has three layers of anchors:

- the agent's dispatch loop (still an N+1 against the rate limit)
- the dynamic JOIN construction in `get_metric_timeseries` (logical plan we write)
- SQLite's planner output via EXPLAIN (physical plan it picks)

### When this still becomes load-bearing

For the **main app**, query planning becomes load-bearing the day we own SQL there (Postgres for saved insights, etc.). For the **Olist DB**, it's load-bearing now — every tool call hits the planner.

## Structure pass

The system has THREE query-planning altitudes now worth distinguishing:

```
  axis: "who decides what query to run next, and what physical plan executes?"

  ┌─ outer: monitoring/diagnostic agent loop ───────┐
  │  Claude decides the next tool call               │  → LLM is the dispatcher
  └────────────────────┬─────────────────────────────┘
                       │  MCP tool call boundary
                       ▼
  ┌─ middle: dynamic SQL construction (Olist mode)  │
  │  get_metric_timeseries.ts builds JOIN list +     │  → WE write the logical
  │   WHERE clause from input args                    │     plan, one prepared
  │                                                   │     statement per shape
  └────────────────────┬─────────────────────────────┘
                       │  db.prepare(sql).all(params)
                       ▼
  ┌─ inner: SQLite physical planner ─────────────────┐
  │  picks index per JOIN, decides scan vs seek,     │  → SQLite is the
  │  reads pages from the buffer pool                 │     physical planner
  └──────────────────────────────────────────────────┘
```

The seam at the MCP tool-call boundary changes character in Olist mode: we now own both sides of it. The agent picks the tool; we wrote the SQL; SQLite picks the index. In Bloomreach mode the second altitude doesn't exist (the tool IS the query).

## How it works

### Move 1 — the mental model

A planner takes a declarative query (`SELECT ... WHERE ... ORDER BY ...`) and chooses how to execute it physically. For a single WHERE clause that might mean "use the index on this column" vs "scan the whole table." For a JOIN it might mean "hash join" vs "nested loop" vs "merge join." For a multi-table query with three predicates it's an exponential search over plan trees, pruned by cost estimates.

```
  the pattern — logical plan → physical plan

       SQL:    SELECT * FROM insights WHERE severity='critical' ORDER BY ts DESC LIMIT 10

       logical tree:
         Limit(10)
           └─ Sort(ts DESC)
                └─ Filter(severity='critical')
                     └─ Scan(insights)

       physical plan candidate A — seq scan + sort:
         Limit(10)  ←  cost: scan 50k rows, sort 50k, take 10

       physical plan candidate B — index scan on (severity, ts DESC):
         Limit(10)  ←  cost: walk index, take first 10, done

       planner picks B if the index exists. Otherwise A.
```

### Move 2 — the moving parts

**Move 2a — the cost-based optimizer.** Modern planners estimate cost per plan using table statistics (row count, value distribution, index selectivity). The plan with the lowest estimated cost wins. The estimate can be wrong — stale statistics cause the planner to pick a bad plan with confidence.

**Move 2b — join algorithms.** Three to know:

```
  nested loop   for each row in A: scan B for match. O(N*M). Good for tiny B.
  hash join     build hash of B in memory. Probe with each A. O(N+M). Good
                when one side fits in RAM.
  merge join    sort both, walk in lockstep. O((N+M) log N). Good when both
                are already sorted (e.g. both indexed on the join key).
```

**Move 2c — N+1, the universal anti-pattern.** Fetch a list of N items, then fire N more queries (one per item). N+1 is the default failure mode for ORMs and for any code that loops over a result set. The fix is always one of: a JOIN, a single query with `IN`, or a dataloader-style batch.

```
  bridge: you know how React useEffect inside a .map() can fire N HTTP calls,
          one per list item? same pattern, same fix — batch them.
```

The codebase HAS an N+1, just at the agent layer not the DB layer:

```
  observed shape in lib/agents/monitoring.ts

       for each category in runnableCategories:
          → agent calls execute_analytics_eql with one EQL per category
          → that's 10 sequential MCP calls, ~1.1s apart (rate limit)
          → total: ~11-15s before any insight surfaces

       this is an N+1 at the *tool-call* layer. fixing it would require
       Bloomreach to expose a batch endpoint (it doesn't) or the agent
       to assemble compound EQL (the schema gate makes this brittle).
       so it stays N+1 by acceptance, not by oversight.
```

**Move 2d — EXPLAIN, the planner's window.** Every real database lets you print the chosen plan: `EXPLAIN SELECT ...`. Reading EXPLAIN output is the single most valuable skill in database performance work. Without it you're guessing at why a query is slow; with it you can see "ah, it's doing a seq scan because the index is on `(b,a)` not `(a,b)`."

For Olist specifically, SQLite supports `EXPLAIN QUERY PLAN` — open `data/olist.db` in the sqlite3 CLI, prefix any tool query with it, and you'll see lines like `SEARCH orders USING INDEX idx_orders_purchase_ts (purchase_ts>? AND purchase_ts<?)` for a metric query. That's a real index range scan, the same primitive Postgres would use.

**Move 2e — dynamic SQL construction (Olist mode, the new shape).**

`get_metric_timeseries.ts` doesn't have ONE SQL string. It has a TEMPLATE that branches on input args — which metric, which dimension, which filter. Each unique shape becomes its own prepared statement, cached by better-sqlite3 transparently.

```
  shape — dynamic JOIN list, one prepared statement per concrete query

  input:    metric='revenue', dimension='state', time_range=...

  derived:  needsItems     = true   (revenue needs order_items)
            needsCustomers = true   (state needs customers join)
            needsPayments  = false
            needsProducts  = false

  emitted SQL:
    SELECT o.id AS order_id, o.purchase_ts AS ts,
           oi.price_brl AS amount, c.state AS segment
    FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN customers c ON c.id = o.customer_id
    WHERE o.purchase_ts >= ? AND o.purchase_ts < ?

  what SQLite's planner does next:
    1. WHERE has range predicate on purchase_ts
        → SEARCH orders USING INDEX idx_orders_purchase_ts
    2. JOIN order_items on o.id (PK on orders.id, FK index on items.order_id)
        → SEARCH order_items USING INDEX idx_items_order
    3. JOIN customers on o.customer_id (FK index)
        → SEARCH customers USING INDEX idx_orders_customer reversed
           (actually PK seek on customers.id since orders.customer_id is
           the side with the FK)
    4. bucketing happens in JS (see seed-olist.ts L132-156 comment about
       avoiding SQLite-side date math)
```

The deliberate choice: **buckets are computed in JS, not SQL.** The comment in `get_metric_timeseries.ts` L132-135 calls this out — at ~10k orders, pulling all matching rows + `purchase_ts` and bucketing in TypeScript avoids SQLite-side `strftime`/`unixepoch` calls. At 10M orders the calculus flips and you'd push the bucketing down to SQL. Knowing where that crossover sits is the skill.

### Move 3 — the principle

**Planning is where declarative meets physical.** SQL says what; the planner picks how. The whole reason SQL won as an interface is that the planner can change its mind as the data shape changes — same query, faster execution next quarter when you add an index. You give up imperative control to buy the freedom to re-tune later. The day you're hand-writing the plan (like we sort-of do in `lib/agents/monitoring.ts`), you've given up that lever.

## Primary diagram

```
  query path — agent → MCP tool → SQLite planner → pages

  ┌─ agent ─────────────────────┐
  │  Claude picks the next tool  │
  │  call from the available 3:  │
  │  - get_metric_timeseries     │
  │  - get_segments              │
  │  - get_anomaly_context       │
  └──────────────┬───────────────┘
                 │  MCP stdio JSON envelope
                 ▼
  ┌─ mcp-server-olist subprocess ─────────────────────────────┐
  │  validateAgainstSchema(input)                              │
  │      │                                                     │
  │      ▼                                                     │
  │  build dynamic SQL (joins, WHERE, SELECT cols)             │
  │      │                                                     │
  │      ▼                                                     │
  │  db.prepare(sql).all(params)  ← prepared, cached            │
  │      │                                                     │
  │      ▼                                                     │
  │  ┌─ SQLite engine ────────────────────────────────────┐   │
  │  │  cost-based planner picks index per JOIN            │   │
  │  │  executor walks B-tree pages from buffer pool       │   │
  │  └────────────────────────────────────────────────────┘   │
  │      │                                                     │
  │      ▼                                                     │
  │  rows[] returned to JS                                     │
  │      │                                                     │
  │      ▼                                                     │
  │  bucket by (truncated_ts, segment) IN JS                   │
  │  return points[] to MCP envelope                           │
  └─────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

### Use cases

- **Bloomreach mode — every monitoring run** emits a sequence of EQL queries through `execute_analytics_eql`. The schema-gate decides which queries run; the order is sequential because of the rate limit.
- **Olist mode — every monitoring run** emits a sequence of `get_metric_timeseries` / `get_segments` / `get_anomaly_context` calls; each one constructs SQL dynamically and SQLite plans it.
- **Every investigation** runs a smaller set of follow-up queries scoped to the anomaly's category. In Olist mode, `get_anomaly_context` is the dedicated tool — it runs two windowed aggregates (anomaly window + baseline window) against the same shape.

### Olist — the dynamic SQL builder

```
  mcp-server-olist/src/tools/get_metric_timeseries.ts  (lines 60–158)

  const needsItems =
    input.metric === 'revenue' ||                  ← branch the join list on
    input.metric === 'avg_order_value' ||             which fields the query
    input.dimension === 'category' ||                 actually needs. avoids
    input.filter?.dimension === 'category';           dragging order_items
  const needsPayments = ...                           into a query that only
  const needsProducts = ...                           cares about order count.
  const needsCustomers = ...

  const joins: string[] = [];
  if (needsItems) joins.push('JOIN order_items oi ON oi.order_id = o.id');
  if (needsProducts) joins.push('JOIN products p ON p.id = oi.product_id');
  if (needsCustomers) joins.push('JOIN customers c ON c.id = o.customer_id');
  if (needsPayments) joins.push('JOIN payments pay ON pay.order_id = o.id');

  // metric expression also branches:
  switch (input.metric) {
    case 'revenue':       metricExpr = 'SUM(oi.price_brl)'; break;
    case 'order_count':   metricExpr = 'COUNT(DISTINCT o.id)'; break;
    case 'avg_order_value': metricExpr = 'CAST(SUM(...) AS REAL) / COUNT(DISTINCT o.id)'; break;
    case 'payment_value': metricExpr = 'SUM(pay.value_brl)'; break;
  }

  const sql = `
    SELECT ${selectCols.join(', ')}
    FROM orders o
    ${joins.join('\n      ')}
    WHERE ${where.join(' AND ')}
  `;
  const rows = db.prepare(sql).all(...params);     ← better-sqlite3 caches
                                                      the prepared statement
                                                      by exact SQL string; each
                                                      unique JOIN-list shape
                                                      becomes its own cached
                                                      prepared statement.
       │
       └─ the planning question this code answers is "minimum joins for this
          metric+dimension+filter combination." Dragging in unused joins would
          force SQLite to scan more index pages for no benefit. The branching
          is the manual-side of what a query optimizer does automatically in
          Postgres (where you'd JOIN everything in the FROM clause and trust
          the planner to prune; SQLite's planner does this too but the smaller
          the input plan tree, the faster the planner runs).
```

### The closest cousin in the main app (it really is just a tool dispatcher)

```
  lib/agents/monitoring.ts  (the scan loop, paraphrased — the real impl is
                              an LLM tool-call loop, not an explicit for-each)

  scan(callbacks, runnable):
    for each category in runnable:
       ask Claude to produce an EQL query for this category
       call execute_analytics_eql with that EQL
       parse the result into an Anomaly if the threshold trips
       emit any anomaly through callbacks
       (sleep is implicit — McpClient minIntervalMs=1100 enforces it)
       │
       └─ the "planner" here is Claude, picking the EQL string. The
          "executor" is Bloomreach, running the EQL. We see neither
          half's internals — only the tool call boundary in between.
```

The relevant tunables aren't planner-side, they're rate-limit-side: see `lib/mcp/client.ts` L82-95 (`minIntervalMs`, `retryDelayMs`, `retryCeilingMs`).

## Elaborate

The plan-vs-execute split is one of the strongest abstractions in computing — every SQL engine, every Spark job, every Beam pipeline, every Optimizer in TensorFlow does some version of it. The reason it generalizes: any declarative description of work can be re-planned as constraints change, and that re-planning is where the headroom lives.

For an agent system, the "planner" is the LLM and the "executor" is whichever tool gets called. The Claude-as-planner pattern has a different failure mode than a SQL planner: it can be confidently wrong about which tool to call, with no statistics to anchor it. That's why `lib/agents/categories.ts` exists — it's a schema-gate that prunes the planner's option space *before* the LLM sees it, so the LLM can't pick a category whose required signals aren't in the workspace.

Cross-link: `study-agent-architecture` owns the agent loop. This file just notes that the loop sits where a query planner sits in a more traditional stack.

## Interview defense

**Q: "How do queries get planned in your app?"**
Two modes. In Bloomreach mode, we don't write SQL — the agent emits EQL strings, Bloomreach's engine plans them on the other side of the network, and we never see the plan. In Olist mode (Phase 2), we own the SQL: `mcp-server-olist/src/tools/get_metric_timeseries.ts` constructs a SELECT dynamically (the JOIN list branches on metric + dimension + filter), then `db.prepare(sql).all(params)` hands it to SQLite. SQLite's cost-based planner picks the index per JOIN — you can run `EXPLAIN QUERY PLAN` against `data/olist.db` and see real output. The deliberate split: SQL pulls rows, JS does the time-bucketing (the comment in L132-135 calls out the crossover — at ~10k orders, JS-side bucketing avoids SQLite-side strftime juggling).

Diagram: the three-altitude planning picture from the structure pass — agent dispatcher / dynamic SQL builder / SQLite physical planner.

Anchor: `mcp-server-olist/src/tools/get_metric_timeseries.ts` L60-158 for the dynamic build; `mcp-server-olist/scripts/seed-olist.ts` L236-244 for the indexes the planner picks from.

**Q: "Is there an N+1 problem in your code?"**
Yes, at the agent layer. The monitoring scan fires one EQL per category, sequentially, with a 1.1-second rate-limit gap between calls. Ten categories means ~11-15 seconds before the first insight surfaces. We've accepted it because the alternative (one mega-EQL with all categories) loses the schema gate's per-category fail-soft behavior, and Bloomreach doesn't expose a batch endpoint. If they did, the fix would be a single batched call.

Diagram: a vertical timeline showing 10 calls spaced 1.1s apart.

Anchor: `lib/agents/monitoring.ts` (scan loop); `lib/mcp/client.ts` L150-156 (`minIntervalMs` enforcement).

## Validate

**Level 1 — reconstruct.** Explain what `EXPLAIN` does and why a plan can change without the query changing.

**Level 2 — explain.** Why is the monitoring scan sequential instead of parallel? (Answer: Bloomreach's per-user rate limit; parallel calls would just trigger more 429s and trigger retries that cost more wall time.)

**Level 3 — apply.** Suppose we added a Postgres for saved insights and the dominant query is `SELECT * FROM insights WHERE user_id=? AND severity='critical' ORDER BY created_at DESC LIMIT 20`. What index makes this an index-only scan? (Answer: `(user_id, severity, created_at DESC) INCLUDE (id, headline, summary, ...)` — covers the WHERE, the ORDER BY, and the projected columns.)

**Level 4 — defend.** A teammate proposes parallelizing the monitoring scan. Argue against it for this codebase as it stands. (Answer: the rate limit is global per user, not per call. Ten parallel calls all hit the same window and trigger ten 429 retries; the retry math eats more wall time than the sequential version. We'd need Bloomreach to lift the limit OR a queue with per-request budget tracking before parallel pays off.)

## See also

- `01-database-systems-map` — where the planner half of the boundary actually sits
- `03-btree-hash-and-secondary-indexes` — the 9 indexes the SQLite planner picks from
- `10-embedded-sqlite-fixture` — better-sqlite3 prepared-statement caching
- `study-agent-architecture` — the agent loop, which is the outer "planner" here

---
Updated: 2026-06-16 — Olist mode now exercises real SQL planning; added Move 2e (dynamic SQL construction) + primary diagram + L60-158 anchor in get_metric_timeseries.ts.
