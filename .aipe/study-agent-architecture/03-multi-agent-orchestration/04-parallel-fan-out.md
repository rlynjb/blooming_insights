# Parallel / fan-out-fan-in

**Industry standard.** Independent subtasks run simultaneously, a merger combines. **Not exercised** in this codebase — no parallel agents, no merger.

## Zoom out, then zoom in

Sits at the orchestration layer as an alternative to sequential pipelining when the subtasks are genuinely independent.

```
  Zoom out — where this WOULD live

  ┌─ Orchestration layer ───────────────────────────┐
  │  Today: sequential pipeline                      │
  │  Would: ★ fan-out N concurrent agents ★         │ ← we are here
  │         ★ fan-in: merge their outputs ★         │
  └──────────────────────────────────────────────────┘
```

## Structure pass

Layers: split (decide the subtasks) → N concurrent agent runs → merge (a fan-in agent or pure code combines results).

**Axis traced — "what makes this possible?":** subtask independence. If any subtask depends on another's output, it's a pipeline, not a fan-out. The fan-out shape is reserved for the case where the work splits with zero cross-task dependencies.

**Seam:** the merge function. Whether it's pure code (concat arrays, take the union) or an LLM call (synthesize across results) is the load-bearing call. Code merging is cheap and predictable; LLM merging is expensive and brings the synthesis-failure problem from `09-coordination-failure-modes.md`.

## How it works

### Move 1 — the mental model

You know `Promise.all([a, b, c])` over independent requests, then a reduce that combines them. Three fetches fire concurrently, you wait for the slowest, you merge the results. The fan-out agent topology is exactly that — three agents in parallel, you wait for the slowest, a merge step combines.

```
  Fan-out / fan-in

           ┌──────── split ────────┐
           ▼          ▼            ▼
      ┌────────┐ ┌────────┐  ┌────────┐
      │agent 1 │ │agent 2 │  │agent 3 │   (concurrent)
      └────┬───┘ └────┬───┘  └────┬───┘
           └──────────┼───────────┘
                      ▼
              ┌──────────────┐
              │ merge agent  │  synthesizes
              │ (or code)    │
              └──────────────┘
```

The win is latency. Three agents at 10 seconds each in parallel = 10 seconds + merge cost. Three agents sequentially = 30 seconds + merge cost. The constraint that makes parallelism possible: no agent's input depends on another's output.

### Move 2 — step by step

#### Where this could land in this repo

The monitoring agent today scans up to 6 EQL queries sequentially against the runnable categories (`maxToolCalls=6` in `monitoring-agent.js:56`). The bottleneck is wall-clock — at the rate-limited tier (~1 req/s), 6 queries take ~6-10s on the wire alone, plus per-call model-decision overhead.

A fan-out version would split the categories — say, 3 sets of 2 categories each — and run 3 monitoring agents in parallel. The merge would be a `concat` of the resulting anomaly arrays plus a re-sort by severity (the same `severityRank` sort the AptKit class already does). The latency drops by roughly 3x; the cost stays the same (same total queries, same total tokens).

```ts
// hypothetical fan-out version of monitoring scan (not implemented)
async function fanOutMonitoring(
  schema: WorkspaceSchema,
  categories: AnomalyCategory[],
  // ... ports
): Promise<Anomaly[]> {
  const groups = chunk(categories, 3);  // 3 groups, ~3 cats each
  const concurrentResults = await Promise.all(
    groups.map(group =>
      new MonitoringAgent(anthropic, ds, schema, allTools, sid)
        .scan(hooks, group)
    )
  );
  // merge: flatten + re-sort by severity
  return concurrentResults
    .flat()
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity])
    .slice(0, 10);
}
```

The fan-in here is pure code (concat + sort), not an LLM merger. That keeps the synthesis-failure mode off the table — no model has to reconcile contradictory anomalies because each agent scans different categories.

#### Why this isn't in the repo today

Two reasons:

1. **The wall-clock isn't the bottleneck.** The monitoring scan typically completes in 30-60s end to end, well under the 300s Vercel budget. The user experience isn't degraded by the latency at this scale.
2. **The MCP rate limit serializes anyway.** `BloomreachDataSource.minIntervalMs=200ms` enforces global per-user spacing across all calls. Three parallel agents would still wait their turn at the wire. The parallelism would only help if the per-call wall-clock was dominated by the LLM's reasoning time rather than the MCP tool wait — which isn't the dominant case in this repo.

Both reasons would change if the workspace grew much larger (more categories to scan) or the MCP rate limit relaxed. Either change would tip the fan-out from "not worth the complexity" to "worth the complexity."

#### The backpressure problem fan-out introduces

When a supervisor spawns workers, it can spawn faster than the provider's rate limit allows. The classic mistake: "split 12 subtasks, fire 12 agents in parallel," then hit 429s on tokens 4-12. The mitigation — concurrency caps with backpressure — is covered in `05-production-serving/02-fan-out-backpressure.md`. Even though this repo doesn't run fan-out, the `minIntervalMs` primitive in `BloomreachDataSource` is the same primitive a fan-out cap would use.

### Move 3 — the principle

**Fan-out earns its overhead only when the subtasks are genuinely independent AND the wall-clock matters.** The first condition is structural (no cross-task dependencies). The second is operational (parallelism wins on time, not on cost). Most production agent pipelines that "feel like they should be parallel" are actually pipeline-shaped (each subtask wants the previous one's output) or wall-clock-acceptable (sequential is fine, latency budget isn't tight). When both conditions are met, fan-out is a meaningful 2-5x latency win for ~no cost change.

## Primary diagram

```
  Fan-out monitoring scan (hypothetical)

  ┌─ orchestrator (route handler) ───────────────────────────────┐
  │   runnable = runnableCategories(capabilities)  // ~10 cats   │
  │   groups = chunk(runnable, ~3 per group)                     │
  │                                                                │
  │   ┌─ Promise.all (concurrency capped by minIntervalMs at      │
  │   │   the data-source layer; effectively serialized at MCP) ──┐
  │   ▼                                                            │
  │  ┌────────────┐  ┌────────────┐  ┌────────────┐               │
  │  │MonitorAgent│  │MonitorAgent│  │MonitorAgent│  (3 ReAct      │
  │  │  group A   │  │  group B   │  │  group C   │   loops in     │
  │  │  scan()    │  │  scan()    │  │  scan()    │   parallel)    │
  │  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘               │
  │        │               │                │                       │
  │        └────────────┐  │  ┌─────────────┘                       │
  │                     ▼  ▼  ▼                                     │
  │                  ┌─────────────────┐                            │
  │                  │ pure-code merge  │                            │
  │                  │ flat → sort by   │  no LLM merger             │
  │                  │ severity →      │  (avoids synthesis         │
  │                  │ slice(0,10)     │   failure modes)            │
  │                  └─────────────────┘                            │
  │                          │                                       │
  │                          ▼                                       │
  │                     final Anomaly[]                              │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The fan-out pattern composes naturally with supervisor-worker — the supervisor splits the task, fans out workers, fans in their results. The supervisor + fan-out shape is the canonical "multi-agent research assistant" topology (`06-orchestration-system-design-templates/01-multi-agent-research-assistant.md`).

The fan-in choice is more important than the fan-out choice. Pure-code merging (concat, sort, dedupe) is cheap and predictable; LLM merging is expensive and brings synthesis failure modes (the LLM might average contradictory results instead of surfacing the conflict, or hallucinate a synthesis that doesn't follow from the inputs). The production heuristic: use code merging when the merge is structural (union of arrays, sum of counts, sort by score) and only use an LLM merger when the merge is genuinely *interpretive* (summarize across N research findings into a coherent narrative). Most production fan-outs find a way to make the merge structural.

The Anthropic multi-agent research blog post (2025) gives a concrete number: their fan-out research assistant runs 3-5 parallel sub-research agents per question and gets a 3-5x latency improvement over sequential. The cost stays roughly equal — same total tokens, just done concurrently. The fan-in is an LLM synthesis (interpretive merge), which they accept the cost of because the use case demands narrative output.

## Interview defense

> **Q: Could you fan-out the monitoring scan to reduce latency?**
>
> Structurally, yes — the 10 anomaly categories don't depend on each other, so they could split across 3-4 parallel monitoring agents. Operationally, it doesn't help today because the wall-clock bottleneck is the MCP rate limit (~1 req/s). The Bloomreach server is per-user rate-limited, so parallel agents would still serialize at the wire — `BloomreachDataSource.minIntervalMs=200ms` enforces global spacing. The parallelism would only win if the per-call wait was dominated by LLM reasoning time, which it isn't. If the rate limit relaxed or the workspace grew much larger, fan-out becomes worth it; today the 30-60s end-to-end is well under the 300s Vercel budget.

> **Q: If you did add fan-out, what's the merge strategy?**
>
> Pure-code merge: flatten the per-agent anomaly arrays, sort by severity using the existing `severityRank` map from `monitoring-agent.js:18`, slice the top 10. No LLM in the merge path. Each agent scans different categories so there are no cross-agent duplicates to dedupe and no contradictions to reconcile — the merge is genuinely structural. Adding an LLM merger would invite the synthesis-failure mode (`09-coordination-failure-modes.md`) for no gain — there's nothing interpretive to do.

> **Q: What about the backpressure problem fan-out introduces?**
>
> A real concern at scale. A supervisor that spawns workers faster than the provider can serve them just queues up rate-limit errors. The mitigation is concurrency capping with backpressure — `BloomreachDataSource.minIntervalMs` is the primitive at the data-source layer; a fan-out cap would also limit how many concurrent worker agents can fire `tool_use` simultaneously. Even without fan-out, the rate-limit retry ladder in `BloomreachDataSource` handles the 429-class failures by sleeping and retrying. The full fan-out + backpressure story lives in `05-production-serving/02-fan-out-backpressure.md`.

## See also

- → `02-supervisor-worker.md` — the natural pair to fan-out (supervisor splits, fans out workers)
- → `05-production-serving/02-fan-out-backpressure.md` — the production controls fan-out requires
- → `09-coordination-failure-modes.md` — what goes wrong when the merge is an LLM instead of code
- → `06-orchestration-system-design-templates/01-multi-agent-research-assistant.md` — the canonical fan-out template
