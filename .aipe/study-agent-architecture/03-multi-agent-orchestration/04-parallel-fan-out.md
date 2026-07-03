# Parallel fan-out / fan-in

_Industry standard._

## Zoom out, then zoom in

Independent subtasks run simultaneously; a merger combines the results. In this repo the pattern is *partial* — monitoring fans out over ~10 anomaly categories concurrently (fan-out over queries), but not over multiple worker *agents*. This file covers the shape as it exists and what the "fan out over agents" upgrade would require.

```
  Zoom out — the fan-out that currently lives here

  ┌─ /api/briefing ──────────────────────────────────────────────┐
  │  new MonitoringAgent(...).scan(hooks, runnableCategories)    │
  └──────────────────────┬───────────────────────────────────────┘
                         ▼
  ┌─ AptKit's AnomalyMonitoringAgent (inside node_modules) ──────┐
  │  fans out over ~10 categories concurrently                   │
  │  each category = one prompt shape + one EQL recipe           │
  │  merges results into Anomaly[]                               │
  └──────────────────────┬───────────────────────────────────────┘
                         ▼
                     ~10 anomalies
```

Zoom in: this is fan-out over *category queries within a single agent*, not fan-out over separate agents. The distinction matters — full multi-agent fan-out means N worker agents each running their own ReAct loop, which this repo does not do today. If diagnostic sub-questions grew (e.g. "check funnel AND check traffic AND check segment mix in parallel"), fan-out over agents would earn its overhead.

## Structure pass

**Layers:** decompose · dispatch (concurrent) · limit (concurrency cap) · merge.
**Axis:** *are the subtasks genuinely independent, or does one depend on another's output?*
**Seam:** the concurrency cap. Without it, fan-out becomes an unbounded queue that hammers the rate limit.

```
  Fan-out vs pipeline — the decision

  Fan-out (independent):        Pipeline (dependent):
  A ─┐                          A ─► B ─► C
  B ─┼─► merge                  (must run in order)
  C ─┘

  latency: max(A,B,C)           latency: sum(A,B,C)
  fails if merge can't combine  fails if any stage errors
```

## How it works

### Move 1 — the mental model

You've written `await Promise.all([fetchA(), fetchB(), fetchC()])` before, then merged the three responses into one view. Fan-out is that shape at the agent layer. The load harness (`eval/load.eval.ts`) uses this shape at the eval layer — N investigations, K concurrent workers.

```
  Pattern: fan-out / fan-in

           ┌────── decompose ──────┐
           ▼          ▼            ▼
      ┌────────┐ ┌────────┐  ┌────────┐
      │ task 1 │ │ task 2 │  │ task 3 │   ← concurrent
      └────┬───┘ └────┬───┘  └────┬───┘
           └──────────┼───────────┘
                      ▼
              ┌──────────────┐
              │  merge       │
              └──────────────┘
```

### Move 2 — the walkthrough

**Fan-out that IS implemented — monitoring over categories.** The monitoring agent runs 10 category checks concurrently. The fan-out lives inside AptKit's `AnomalyMonitoringAgent`, not in blooming code. Blooming's job is to build the category list and pass it in:

```ts
// lib/agents/monitoring.ts:82-93
async scan(hooks?: MonitorHooks, categories: AnomalyCategory[] = []): Promise<Anomaly[]> {
  const agent = new AptKitAnomalyMonitoringAgent({
    model: new AnthropicModelProviderAdapter(this.anthropic, 'monitoring', this.sessionId),
    tools: toolRegistry,
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks ?? {}, 'monitoring'),
    categories: categories.length ? toAptKitCategories(categories, this.schema.projectId) : [],
  });
  return (await agent.scan({ signal: hooks?.signal })).map(toBloomingAnomaly);
}
```

Line-by-line:

- **`categories`** — up to 10 runnable categories (funnel conversion, revenue trend, purchase volume, etc.), filtered against the workspace schema by `runnableCategories(available)`.
- **`agent.scan(...)`** — AptKit fans out one query per category. Each category is an independent EQL, no cross-category dependency.
- **The 1 req/s throttle inside `BloomreachDataSource`** — bounds the actual concurrency downstream. Even if AptKit fires 10 category queries at once, `minIntervalMs=1100` in `bloomreach-data-source.ts:135-137` serializes them to ~1/sec. This is de-facto backpressure — the rate limiter shapes the fan-out even when the caller doesn't cap it.

**Fan-out at the eval layer — load harness.** `eval/load.eval.ts:171-211` is the canonical fan-out-with-concurrency-cap in this repo:

```ts
// eval/load.eval.ts:171-211 — semaphore-based fan-out
const indices = Array.from({ length: LOAD_N }, (_, i) => i);
const queue = [...indices];

async function worker(workerId: number): Promise<void> {
  while (queue.length > 0) {
    const index = queue.shift();
    if (index == null) return;
    const golden = goldens[index % goldens.length];
    try {
      const inv = await runOneInvestigation(index, golden.caseId, ...);
      results.push(inv);
    } catch (err) {
      results.push({ ...failedShape });
    }
  }
}

const workers = Array.from({ length: LOAD_CONCURRENCY }, (_, i) => worker(i));
await Promise.all(workers);
```

Line-by-line:

- **`queue = [...indices]`** — the shared work queue. Every worker pulls from the same array.
- **`while (queue.length > 0)`** — the worker keeps pulling until nothing's left. Errors on one task don't stop other workers (the `try/catch` swallows and pushes a failed-shape result).
- **`Array.from({ length: LOAD_CONCURRENCY }, ...)`** — spawn K workers, each an independent async task. K is the concurrency cap — the semaphore is *implicit in the worker count*.
- **`await Promise.all(workers)`** — the fan-in. Waits for every worker to drain. Return order is not guaranteed; the results are sorted by `.index` at the end.

The receipt from the recent run: N=3 at K=1 (sequential), `totalMs=283170`, `p50 total=92707ms`, cost `p50=$0.070`. Cranking K to 3 would cut wall-clock ~3x if the provider's rate limit allows.

**Why fan-out over AGENTS isn't here (yet).** The diagnostic loop runs one worker at a time. If diagnostic broke into sub-questions ("check funnel", "check traffic", "check segment mix"), each could run as a parallel worker agent. Today the diagnostic prompt asks the model to consider all of them within one loop. The shape earns its overhead when: (a) the sub-questions are genuinely independent, (b) the total sub-question latency is high enough that parallelism buys meaningful time, and (c) the merge is simple (concatenate evidence, not resolve conflicts).

```
  Layers-and-hops — where the fan-out lives today

  ┌─ /api/briefing (route handler) ──────────┐
  │  MonitoringAgent.scan(runnableCategories)│
  └──────────────────┬───────────────────────┘
                     ▼
  ┌─ AptKit (node_modules) ─────────────────┐
  │  10 concurrent category queries          │  ← fan-out here
  └──────────────────┬───────────────────────┘
                     ▼
  ┌─ BloomreachDataSource ───────────────────┐
  │  minIntervalMs=1100 → serializes to ~1/s │  ← backpressure here
  └──────────────────┬───────────────────────┘
                     ▼
  ┌─ Bloomreach MCP server ──────────────────┐
```

### Move 3 — the principle

Fan-out is `Promise.all` with a concurrency cap. The cap is not optional — an uncapped fan-out becomes an unbounded queue the moment the underlying service rate-limits. Two questions decide whether the shape earns its overhead: (a) are the subtasks truly independent, and (b) is the merge simple? If either answer is no, a sequential pipeline is the safer default. Blooming does fan-out at the *query* layer (categories inside monitoring) and at the *eval* layer (load harness), but not at the *agent* layer — that upgrade waits for a workload where diagnostic naturally decomposes into parallel sub-questions.

## Primary diagram

```
  Recap — the two fan-outs that exist, and the one that doesn't

  Fan-out A: monitoring categories (query-level)
  ┌─────────────────────────────────────────────┐
  │  MonitoringAgent — one agent, N EQL queries │
  │  ~10 categories concurrent → merged anomaly │
  │  Concurrency: bounded by MCP 1 req/s        │
  └─────────────────────────────────────────────┘

  Fan-out B: eval load harness (case-level)
  ┌─────────────────────────────────────────────┐
  │  eval/load.eval.ts — N cases, K workers      │
  │  semaphore cap = K; queue drains             │
  │  Concurrency: LOAD_CONCURRENCY env var       │
  └─────────────────────────────────────────────┘

  Not implemented: fan-out over agents
  ┌─────────────────────────────────────────────┐
  │  Would look like: DiagnosticAgent split into │
  │  parallel sub-question workers, results       │
  │  merged into one Diagnosis                   │
  │  Adopt when: sub-questions genuinely          │
  │  independent AND merge is simple             │
  └─────────────────────────────────────────────┘
```

## Elaborate

The reason blooming does query-level fan-out but not agent-level fan-out is a coverage-versus-depth call. Monitoring needs to scan ~10 categories every briefing — that's inherently many independent queries, so fan-out is free wall-clock. Diagnostic needs to go deep on one question — that's inherently sequential (each turn's evidence shapes the next turn's query), so fan-out doesn't apply within one investigation.

The eval-layer fan-out in `load.eval.ts` is where blooming's concurrency discipline actually shows. The load harness is where the tier-2 story of "graceful degradation under fault injection" gets exercised — N cases, K workers, fault rates configured, receipts written. The receipt lists per-investigation cost and fault totals so you can see how degradation compounds under load without failing the run.

The bound on effective concurrency is the provider's rate limit divided by per-call duration (`05-production-serving/01-rate-limit-compliance.md`). Fan-out past that ceiling doesn't buy speed — it buys 429s and retry ladders.

## Interview defense

**Q: Where does this codebase fan out, and where does it stay sequential?**
A: Fan-out at the query layer inside monitoring — AptKit's `AnomalyMonitoringAgent` runs ~10 category EQL queries concurrently, with the `BloomreachDataSource` rate limiter (`minIntervalMs=1100`) providing implicit backpressure. Fan-out at the eval layer in `load.eval.ts` — a semaphore-based worker pool draining a shared queue. Sequential at the agent layer for diagnose → recommend, because recommend has a hard data dependency on diagnosis. The agent-layer fan-out would earn its keep only if diagnostic decomposed into independent sub-questions, which it currently doesn't.

Diagram: the three-tier picture — monitoring fan-out, eval fan-out, sequential agent pipeline.
Anchor: `lib/agents/monitoring.ts:82-93` + `eval/load.eval.ts:171-211`.

**Q: What bounds the fan-out concurrency?**
A: Two ceilings, in order. The explicit one is the worker count (K workers pulling from the shared queue in the eval harness, or the category count inside monitoring). The implicit one that actually dominates in production is the `BloomreachDataSource` rate limiter — `minIntervalMs=1100` serializes tool calls to ~1/sec regardless of how many the fan-out issued. The lesson: caller-side concurrency caps are for early bounding; the downstream limiter is what the system *actually* runs at. If you crank LOAD_CONCURRENCY past the rate limit divided by per-call duration, you get 429s and the retry ladder eats the parallelism you were trying to buy.

Diagram: the caller-cap and the transport-cap as two gates the request must pass through.
Anchor: `lib/data-source/bloomreach-data-source.ts:135-137` (the `minIntervalMs`).

## See also

- `03-sequential-pipeline.md` — the other shape (and why diagnose → recommend fits it).
- `05-production-serving/02-fan-out-backpressure.md` — the eval harness in detail.
- `05-production-serving/01-rate-limit-compliance.md` — the ceiling that bounds actual fan-out.
- `09-coordination-failure-modes.md` — synthesis failures at the merge point.
