# Parallel / fan-out-fan-in

*Industry names: parallel fan-out / scatter-gather / map-reduce · Language-agnostic*

## Zoom out

```
  Zoom out — the latency lever this repo doesn't use (yet)

  ┌─ SECTION C topologies ──────────────────────┐
  │  supervisor-worker  (this repo)              │
  │  sequential pipeline (sub-shape here)        │
  │  ★ parallel fan-out (NOT used here) ★        │ ← we are here
  │  …                                           │
  └──────────────────────────────────────────────┘
```

## Zoom in

Independent subtasks run simultaneously, a merger combines. `Promise.all()` applied to agents. The win is latency — three agents in parallel cost the time of the slowest, not the sum. The constraint is that the subtasks must be genuinely independent. Not currently used in this repo; the diagnostic path is a natural candidate for a future refactor.

## Structure pass

Layers: **split** (task → N independent subtasks) — **workers** (N in parallel) — **merge** (combine results).

Axis to hold constant: **are the subtasks genuinely independent?**

```
  The independence test

  Independent   → fan-out works. Each worker can complete
                  without waiting for the others.
  Dependent     → NOT a fan-out. It's a pipeline in disguise;
                  you'd hit the DAG the moment one worker
                  needs another's output.
  Partial       → the honest case. Some subtasks independent,
                  some dependent. Pick which to parallelize;
                  keep the rest sequential.
```

## How it works

### Move 1 — the shape

You've written `Promise.all([fetchA(), fetchB(), fetchC()])` before. Same instinct, higher altitude — each fetch is a full agent run.

```
  Parallel fan-out — split, run concurrently, merge

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

### Move 2 — where fan-out would fit here (not yet implemented)

**The natural candidate.** The DiagnosticAgent tests hypotheses sequentially today. If it's investigating "revenue drop in USA":

```
  Today (sequential inside diagnostic ReAct):

  turn 1: test hypothesis A (state concentration)
  turn 2: test hypothesis B (product category)
  turn 3: test hypothesis C (payment failure)
  turn 4: emit Diagnosis

  Latency ≈ 4 × (model call + EQL round-trip) ≈ 50s
```

Fan-out version:

```
  Fan-out (hypothetical refactor):

  turn 1: generate hypotheses A, B, C
    │
    ▼
  ┌──── Promise.allSettled ────┐
  │                              │
  │  worker-A tests A            │  in parallel
  │  worker-B tests B            │  (three EQLs concurrent)
  │  worker-C tests C            │
  │                              │
  └────────┬───────────────────┘
           ▼
  merge agent: synthesize findings, emit Diagnosis

  Latency ≈ 1 × turn (generate) + max(A, B, C) + 1 × turn (merge) ≈ 20s
```

**Why it's not implemented yet.**

1. **Baseline p50 (50s) is inside budget.** Vercel Pro maxDuration is 300s; the current pipeline (diag 50s + rec 50s + judges) runs comfortably. Fan-out is a latency lever without a latency problem.
2. **The ~1 req/s MCP spacing limits real parallelism.** Bloomreach's alpha server rate-limits per user globally. Three concurrent EQLs would hit the limiter and serialize anyway. Parallelism only helps once the rate limit is lifted or the DataSource is a faster provider.
3. **aptkit's DiagnosticInvestigationAgent doesn't expose a branching hook.** Adding parallel hypothesis testing would either wrap aptkit at the outer level (multiple aptkit agents, one per hypothesis, merged by a route-level supervisor) or fork the aptkit class. Fork cost is real.

**The concrete refactor spec.**

```
  Fan-out refactor — files, work, risks

  New files:
    lib/agents/hypothesis-worker.ts    (single-hypothesis agent)
    lib/agents/diagnosis-merger.ts     (synthesis agent)

  Changed files:
    lib/agents/diagnostic.ts   — becomes an orchestrator that:
                                  1. generates hypothesis list
                                  2. spawns hypothesis-worker per
                                  3. Promise.allSettled, merges
    app/api/agent/route.ts     — passes budget tracker to each worker
                                  (shared ceiling still enforced)

  Risks:
    - concurrent budget accounting: each worker adds to the shared
      tracker; a fast worker could push the total over before others
      finish. Mitigation: check exceeded() in the mid-loop guard.
    - fan-out concurrency cap: without one, N hypotheses = N concurrent
      MCP calls, blows rate limit. See 05-production-serving/
      02-fan-out-backpressure.md.
    - merge failure: one worker returns malformed output; merger has to
      degrade gracefully (partial synthesis).
```

**The upward-backpressure discipline.** A supervisor spawning workers can fan out faster than the provider's rate limit allows. When the worker queue grows past a threshold, the supervisor should stop decomposing further rather than queue unbounded work. This is covered in `05-production-serving/02-fan-out-backpressure.md` — the runaway-supervisor pattern is the multi-agent version of an unbounded queue.

### Move 3 — the principle

Fan-out is the multi-agent version of `Promise.all()` — the win is latency (max instead of sum), the constraint is independence. When your task genuinely splits into independent subtasks, it's a strong lever; when it doesn't, the fan-out becomes a pipeline in disguise (each worker waits on another's output) and you've paid the complexity without the latency win.

## Primary diagram

```
  Parallel fan-out — the pattern + the guards it needs

  ┌─ Supervisor ────────────────────────────────────────────────┐
  │  decompose task into N independent subtasks                 │
  │  spawn workers up to concurrency cap (see backpressure)     │
  └──────────┬──────────┬──────────┬──────────┬─────────────────┘
             ▼          ▼          ▼          ▼
        ┌────────┐┌────────┐┌────────┐  ...  (up to N workers)
        │worker 1││worker 2││worker 3│       Each is one agent
        │(hypo A)││(hypo B)││(hypo C)│       loop (ReAct)
        └────┬───┘└────┬───┘└────┬───┘
             │         │         │
             └─────────┴─────────┘
                       │ Promise.allSettled
                       ▼
        ┌───────────────────────────────────┐
        │  Merger agent                     │
        │  synthesizes N results             │
        │  handles partial / failed workers  │
        └────────────┬──────────────────────┘
                     ▼
              final structured output

  Guards to remember (in Section 05):
    - concurrency cap (semaphore, N=4 typical)
    - upward backpressure (stop decomposing if queue grows)
    - shared BudgetTracker across all workers
```

## Elaborate

Parallel fan-out is the oldest concurrency pattern in software (Actor model, map-reduce, `Promise.all`). The LLM incarnation surfaced with the AutoGen `GroupChat` broadcast pattern (2023) and matured through LangGraph's `parallel_state` (2024). The interesting recent work is around **structured fan-out with confidence weighting** — workers return not just results but per-result confidence, so the merger weights inputs rather than treating them as equal.

The pattern's most famous production example is Anthropic's own agent evaluation harness — parallel eval agents scoring the same output on different rubrics, merged into a composite score. Same shape as this repo's hypothetical parallel diagnostic.

## Interview defense

**Q: Do you parallelize inside investigations?**

Not yet. Baseline p50 is 50s for diagnostic; Vercel Pro's 300s cap has plenty of headroom, and the ~1 req/s MCP spacing at the DataSource means three concurrent EQLs would hit the limiter and serialize anyway. So fan-out is a latency lever without a latency problem to solve.

Where I'd add it: when latency budget matters (production traffic pressure) or the DataSource becomes a faster provider without rate limits. The refactor is well-scoped — split hypothesis testing into `hypothesis-worker.ts` agents, spawn via `Promise.allSettled`, merge via `diagnosis-merger.ts`. Estimated latency: 50s → 20s. Estimated cost: roughly flat (same tokens, different distribution). The guards I'd need: concurrency cap, shared budget tracker checked mid-loop, upward backpressure so the supervisor doesn't spawn unbounded workers.

*Anchor visual:* the today-vs-fan-out comparison diagram above.

**Q: What if two of the parallel workers depended on each other?**

Then it's not a fan-out. It's a pipeline in disguise, and the "parallel" run would silently serialize on the dependency. The independence test is the first check — if subtasks share intermediate state, keep them sequential or restructure into a proper DAG.

## See also

- **`02-supervisor-worker.md`** — fan-out is one of the supervisor's decomposition options.
- **`08-shared-state-and-message-passing.md`** — how workers see shared context vs pass messages.
- **`09-coordination-failure-modes.md`** — synthesis failure (contradictory worker results) is a fan-out-specific failure.
- **`05-production-serving/02-fan-out-backpressure.md`** — the concurrency cap and upward backpressure fan-out needs.
