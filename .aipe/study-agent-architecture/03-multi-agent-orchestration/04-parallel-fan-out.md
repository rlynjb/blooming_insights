# Parallel / fan-out-fan-in

*Industry name: parallel / fan-out / map-reduce agents — Industry standard.*

Independent subtasks run simultaneously, a merger combines. **Not in this repo.** Bloomreach's ~1 req/s rate limit makes parallel calls infeasible without a concurrency cap, and no agent in the repo currently fans out work to concurrent workers.

## Zoom out — where this concept would live

If adopted, it would replace one of the sequential stages — likely a monitoring agent (`MonitoringAgent`) refactor that fans out one worker per category instead of running them sequentially in one ReAct loop.

```
  Where fan-out WOULD live (hypothetical refactor)

  ┌─ Agent layer ──────────────────────────────────────────┐
  │  Today:  MonitoringAgent (one ReAct loop, 6 calls       │
  │           serial across all runnable categories)        │
  │  Future: MonitoringDispatcher → N CategoryWorkers       │ ← would live here
  │           (one worker per category, run in parallel,    │
  │           merged into one anomaly list)                 │
  └─────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **do the subtasks depend on each other?**

```
  Sequential pipeline (today):              Fan-out (hypothetical):
  ──────────────────────────                ───────────────────────
  one ReAct loop scans                      one worker per category,
  N categories serially                     all running in parallel
                                            then merge into one list

  works because: categories don't            wins on: latency — N categories
  depend on each other, but                  in parallel cost the time of
  Bloomreach rate-limit (~1 req/s)           the slowest, not the sum
  forces serialization at the                forced cost: per-worker context
  data-source layer                          setup; concurrency cap to honor
                                             the rate limit
```

## How it works

### Move 1 — the mental model

You know `Promise.all([a(), b(), c()])` — N independent requests, fire all at once, wait for all to settle, merge results. Fan-out is that pattern over agents instead of fetch calls. The constraint that makes it work: the subtasks must be *genuinely independent* — no subtask needs another's output. If they're dependent, it's a pipeline (see `03-sequential-pipeline.md`), not a fan-out.

```
  Parallel fan-out — split + merge

           ┌──────── split ────────┐
           ▼          ▼            ▼
      ┌────────┐ ┌────────┐  ┌────────┐
      │agent 1 │ │agent 2 │  │agent 3 │   (concurrent)
      └────┬───┘ └────┬───┘  └────┬───┘
           └──────────┼───────────┘
                      ▼
              ┌──────────────┐
              │ merge agent  │  synthesizes
              └──────────────┘
```

### Move 2 — what it would look like for the monitoring agent

The MonitoringAgent today runs ONE ReAct loop with `maxToolCalls=6` and an enforced category list in the prompt's `{categories}` slot. The model picks one category, queries it, moves to the next category. Categories are independent — the conversion-drop check doesn't depend on the revenue-drop check — but they run in series because one agent is doing all of them.

A fan-out refactor would:

```
  Hypothetical fan-out monitoring

  ┌─ MonitoringDispatcher ────────────────────────────────────┐
  │  schemaCapabilities → runnableCategories(...)             │
  │  for each runnable category:                              │
  │    spawn CategoryWorker(category, anthropic, dataSource)  │
  │  await Promise.all(workers) WITH concurrency cap          │
  └────────────────────────┬──────────────────────────────────┘
                           ▼ parallel (capped at, say, 3 concurrent)
  ┌─ CategoryWorker (one per runnable category) ─────────────┐
  │  ReAct loop, tighter budget (maxToolCalls=2)              │
  │  prompt: "check ONLY this category: <recipe>"             │
  │  output: Anomaly | null                                   │
  └────────────────────────┬──────────────────────────────────┘
                           ▼
  ┌─ MonitoringMerger ────────────────────────────────────────┐
  │  collect workers' outputs                                 │
  │  filter nulls; sort by severity                           │
  │  emit Anomaly[]                                           │
  └────────────────────────────────────────────────────────────┘
```

The wins:
- **Latency**: 5 categories in parallel cost the time of the slowest, not the sum
- **Tighter prompts per worker**: each worker sees only its category, not all 10
- **Failure isolation**: one worker hitting an error doesn't taint the others

The costs:
- **Concurrency cap mandatory**: Bloomreach rate-limits at ~1 req/s globally; firing 10 workers concurrently triggers 429s. Need a semaphore at the data-source layer to bound concurrency (see `../05-production-serving/02-fan-out-backpressure.md`).
- **Per-worker context setup**: each worker needs the workspace schema injected separately (~5K tokens × N workers vs 1× for the current sequential design)
- **Merger logic**: deduplication, severity reconciliation, "did multiple categories detect the same underlying anomaly" — non-trivial

### Move 3 — the principle

Fan-out wins on latency when subtasks are genuinely independent AND the per-call cost is dominated by latency (not tokens). The Bloomreach rate limit changes the math here: even if the workers fire in parallel, the data source serializes them to ~1 req/s, so the wall-clock win is bounded by `min(N_concurrent_cap, rate_limit_window)`. With a 6-call budget across 5 categories, the upside is ~3-4x latency improvement *if* you can get the concurrency cap to 3-4 concurrent.

## In this codebase

**Not implemented.** No agent in the repo fans out work to concurrent workers. Specific reasons:

- **Bloomreach's ~1 req/s rate limit** (`lib/data-source/bloomreach-data-source.ts` enforces this with proactive spacing + retry). Concurrent calls to the same `dataSource` would either queue at the data-source layer (defeating the parallelism) or 429 the server (waste).
- **No semaphore primitive yet** for capping concurrency below the proactive-spacing limit. Adding fan-out requires building this first.
- **MonitoringAgent's 6-call budget is small enough** that the sequential cost is acceptable — typically 6-10 seconds for a full briefing. The user's review time on the feed dwarfs this; the latency win wouldn't be felt.
- **The 300s Vercel maxDuration** is comfortably above the sequential cost anyway. Fan-out's win is mostly architectural (failure isolation, tighter prompts), not latency.

The natural opportunity: if we ever added a feature like "analyze all 50 customer segments in parallel," sequential would become the bottleneck and fan-out would be the right answer — with backpressure as the load-bearing addition (see `../05-production-serving/02-fan-out-backpressure.md`).

## Primary diagram

The contrast — today's sequential monitoring vs hypothetical fan-out:

```
  Comparison — sequential vs fan-out monitoring

  TODAY (sequential, one MonitoringAgent ReAct loop):
  ┌────────────────────────────────────────────────┐
  │  while not done (maxToolCalls=6):              │
  │    pick category from {categories} slot         │
  │    query it                                     │
  │    accumulate                                   │
  │  total time = sum of all queries (~6-10s)       │
  └────────────────────────────────────────────────┘

  HYPOTHETICAL (fan-out, parallel workers + merger):
  ┌────────────────────────────────────────────────┐
  │  Dispatcher: spawn 1 worker per category       │
  │   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐│
  │   │worker│ │worker│ │worker│ │worker│ │worker││ ← parallel
  │   │ rev  │ │ conv │ │ cart │ │churn │ │ ...  ││   (capped at
  │   └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘│   N concurrent
  │      └────────┴───────┬┴───────┴────────┘     │    by semaphore)
  │                       ▼                        │
  │              ┌──────────────────┐              │
  │              │ Merger: dedupe,  │              │
  │              │ sort by severity │              │
  │              └──────────────────┘              │
  │  total time ≈ slowest worker + merger          │
  │  forced cost: concurrency cap, per-worker      │
  │  context, merger logic                         │
  └────────────────────────────────────────────────┘
```

## Interview defense

**Q: "Why doesn't your monitoring agent fan out across categories?"**

A: Three reasons. First, Bloomreach's ~1 req/s rate limit serializes all calls at the data-source layer anyway — fan-out without a concurrency cap that respects the rate limit would just 429 the server. Second, no semaphore primitive in the codebase yet — adding fan-out requires building backpressure as a prerequisite (`../05-production-serving/02-fan-out-backpressure.md`). Third, the sequential cost is acceptable — a full monitoring scan is 6-10 seconds, well under the user's review time on the feed. The latency win from fan-out wouldn't be felt.

If we added a feature where the per-task budget grew (analyzing 50 customer segments instead of 10 categories), fan-out would become the right answer. The refactor would be: split the MonitoringAgent into a Dispatcher (spawns workers) + N CategoryWorkers (one per category, tighter prompt, smaller budget) + a Merger (dedupes, sorts by severity). The load-bearing addition isn't the fan-out itself — it's the concurrency cap on the data source.

Diagram I'd sketch:

```
  ┌─ Dispatcher ──┐
  └──────┬────────┘
   ┌─────┼─────┬─────┐  ← parallel, capped at N concurrent
   ▼     ▼     ▼     ▼
  [w]   [w]   [w]   [w]
   │     │     │     │
   └─────┴─┬───┴─────┘
           ▼
        merger → Anomaly[]
```

Anchor: "fan-out without backpressure on a rate-limited dependency is the multi-agent version of an unbounded queue — it works in dev, dies in prod."

**Q: "When would fan-out earn its complexity here?"**

A: When the per-task budget exceeds the sequential time budget. Today, MonitoringAgent's 6-call budget against ~1 req/s is ~6-10 seconds total — fine. If we added "scan 50 customer segments per category" (a 10x expansion of the budget), sequential becomes ~60-100 seconds — at the edge of Vercel's 300s but starting to hurt UX. Fan-out at 4-concurrent gets that back to ~15-25 seconds. The breakpoint is "the user can feel the wait." Today they can't; with a 10x budget they would.

## See also

- [`03-sequential-pipeline.md`](./03-sequential-pipeline.md) — the pattern this repo currently uses
- [`../05-production-serving/02-fan-out-backpressure.md`](../05-production-serving/02-fan-out-backpressure.md) — the prerequisite for safely fanning out against a rate-limited provider
- [`09-coordination-failure-modes.md`](./09-coordination-failure-modes.md) — what fan-out exposes you to (tool-call cascade, cost blowup)
