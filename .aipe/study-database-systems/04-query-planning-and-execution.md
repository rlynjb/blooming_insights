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

**Not yet exercised — but the upstream half is, in a way that matters.**

We do not run a query planner. We don't write SQL. What we DO do is hand Bloomreach EQL strings (an analytics query language) through `execute_analytics_eql`, and Bloomreach's planner runs on the other side of the network. So query planning exists in our request flow — it just happens in someone else's process. The teaching that still matters: **how the agent constructs EQL, what we observe, and what an N+1 looks like at this layer.**

The single thing in our codebase that looks anything like a planner: `lib/agents/monitoring.ts` decides which tools to call in which order, based on which categories the coverage gate marked runnable. That's not a query planner — it's a tool dispatcher — but it's the closest analog.

### When this becomes load-bearing

The moment we own SQL: a Postgres for saved insights, a DuckDB for ad-hoc rollups, anything where we can run `EXPLAIN`. Until then, the relevant skills are:

- spotting an EQL N+1 in the agent loop (we have one — see Move 2c)
- reading the rate-limit signal as a planner-side feedback loop
- knowing what an EXPLAIN would tell us if we had one

## Structure pass

The system has two query-planning altitudes worth distinguishing:

```
  axis: "who decides what query to run next?"

  ┌─ outer: monitoring/diagnostic agent loop ───────┐
  │  Claude decides the next tool call (EQL string)  │  → LLM is the planner
  └────────────────────┬─────────────────────────────┘
                       │
  ┌─ inner: Bloomreach EQL execution ────────────────┐
  │  Bloomreach picks indexes, join order, etc.      │  → DB is the planner
  └──────────────────────────────────────────────────┘
```

The seam is the MCP tool call boundary. We see what Claude asked for and what came back. We never see what Bloomreach did to answer it.

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

### Move 3 — the principle

**Planning is where declarative meets physical.** SQL says what; the planner picks how. The whole reason SQL won as an interface is that the planner can change its mind as the data shape changes — same query, faster execution next quarter when you add an index. You give up imperative control to buy the freedom to re-tune later. The day you're hand-writing the plan (like we sort-of do in `lib/agents/monitoring.ts`), you've given up that lever.

## Primary diagram

Skipped — no codebase instance to recap end-to-end.

## Implementation in codebase

### Use cases

- **Every monitoring run** emits a sequence of EQL queries through `execute_analytics_eql`. The schema-gate decides which queries run; the order is sequential because of the rate limit.
- **Every investigation** runs a smaller set of follow-up queries scoped to the anomaly's category.

### The closest cousin (it really is just a tool dispatcher)

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
We don't plan SQL — we don't write any. The closest pattern is the monitoring agent's loop: it issues one EQL query per category through an MCP tool, and Bloomreach's engine plans each one on the other side of the network. The agent is the dispatcher; Bloomreach is the executor. We never see the plan. If I were debugging a slow EQL, the only signals I have are duration on the tool call and whatever Bloomreach surfaces in its response.

Diagram: the two-altitude planning picture — outer LLM loop, inner Bloomreach engine, MCP boundary in between.

Anchor: `lib/agents/monitoring.ts` L1-120; tool calls go through `lib/mcp/client.ts` L97-146.

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
- `03-btree-hash-and-secondary-indexes` — the planner's choices depend on what's indexed
- `study-agent-architecture` — the agent loop, which is the "planner" here
