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

**Not yet exercised — we don't write SQL.** Two altitudes worth distinguishing:

1. **The agent layer** (`lib/agents/monitoring.ts`) — Claude decides which MCP tool to call next. That's a tool dispatcher, not a query planner. But the SHAPE is similar: pick an action from a set, run it, observe the result, decide what's next.
2. **Bloomreach upstream** runs the EQL query engine on the other side of the network. We hand it a string, it returns rows. We don't see the plan; we don't see the indexes; we can't tune either.

The interesting teaching here is **the N+1 we DO have** — see Move 2c — which lives at the agent-tool-call layer, not the database layer. Same anti-pattern, different altitude.

### When this becomes load-bearing

The day we own SQL (Postgres for saved insights, etc.), every concept here becomes applicable in our code. Until then, the only "plan" we control is which MCP tool the agent calls next.

## Structure pass

Skipped — no codebase instance.

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

**Where this is reached for in this codebase:**
- **Every monitoring run** emits a sequence of EQL queries through `execute_analytics_eql`. The schema-gate decides which queries run; the order is sequential because of the rate limit. Bloomreach's planner runs each one; we see only the result.
- **Every investigation** runs a smaller set of follow-up queries scoped to the anomaly's category.

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

Side-by-side with the real code:

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

**Move 2d — EXPLAIN, the planner's window.** Every real database lets you print the chosen plan: `EXPLAIN SELECT ...`. Reading EXPLAIN output is the single most valuable skill in database performance work. Without it you're guessing at why a query is slow; with it you can see "ah, it's doing a seq scan because the index is on `(b,a)` not `(a,b)`."

### Move 3 — the principle

**Planning is where declarative meets physical.** SQL says what; the planner picks how. The whole reason SQL won as an interface is that the planner can change its mind as the data shape changes — same query, faster execution next quarter when you add an index. You give up imperative control to buy the freedom to re-tune later. The day you're hand-writing the plan (like we sort-of do in `lib/agents/monitoring.ts`), you've given up that lever.

## Primary diagram

Skipped — no codebase instance to recap.

## Elaborate

The plan-vs-execute split is one of the strongest abstractions in computing — every SQL engine, every Spark job, every Beam pipeline, every Optimizer in TensorFlow does some version of it. The reason it generalizes: any declarative description of work can be re-planned as constraints change, and that re-planning is where the headroom lives.

For an agent system, the "planner" is the LLM and the "executor" is whichever tool gets called. The Claude-as-planner pattern has a different failure mode than a SQL planner: it can be confidently wrong about which tool to call, with no statistics to anchor it. That's why `lib/agents/categories.ts` exists — it's a schema-gate that prunes the planner's option space *before* the LLM sees it, so the LLM can't pick a category whose required signals aren't in the workspace.

Cross-link: `study-agent-architecture` owns the agent loop. This file just notes that the loop sits where a query planner sits in a more traditional stack.

## Interview defense

**Q: "How do queries get planned in your app?"**
We don't plan queries — we don't write SQL. The agents emit EQL strings, Bloomreach's engine plans them on the other side of the network, and we never see the plan. The closest thing to a "planner" in our code is the agent loop: Claude picks which MCP tool to call next, the MCP client dispatches it, we read the result. It's a planner only in the shape sense — pick an action, run it, observe, decide what's next.

Diagram: the agent loop as a single-step planner — pick tool / call / observe / repeat.

Anchor: `lib/agents/monitoring.ts` for the scan loop shape; `lib/agents/categories.ts` for the schema-gate that prunes the option space.

**Q: "Is there an N+1 problem in your code?"**
Yes, at the agent layer. The monitoring scan fires one EQL per category, sequentially, with a 1.1-second rate-limit gap between calls. Ten categories means ~11-15 seconds before the first insight surfaces. We've accepted it because the alternative (one mega-EQL with all categories) loses the schema gate's per-category fail-soft behavior, and Bloomreach doesn't expose a batch endpoint. If they did, the fix would be a single batched call.

Diagram: a vertical timeline showing 10 calls spaced 1.1s apart.

Anchor: `lib/agents/monitoring.ts` (scan loop); `lib/mcp/client.ts` L150-156 (`minIntervalMs` enforcement).

## See also

- `01-database-systems-map` — where the planner half of the boundary actually sits
- `03-btree-hash-and-secondary-indexes` — the indexes a real planner would pick from
- `study-agent-architecture` — the agent loop, which is the outer "planner" here

---
