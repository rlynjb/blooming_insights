# Fan-out backpressure

*Industry name: concurrency limiting / backpressure / semaphore — Industry standard.*

A single LLM call has one outbound request to rate-limit. A fan-out topology fires many concurrent calls from one task — and a supervisor spawning workers can fan out faster than the provider's rate limit allows. **Not in this repo today** (no fan-out), but Bloomreach's ~1 req/s spacing acts as a degenerate global cap. Adding fan-out would require building this layer first.

## Zoom out — where this concept would live

Backpressure lives at the DataSource layer (where the rate-limit constraint is) and at the supervisor layer (where the decision to spawn more workers is made). If/when fan-out is adopted, both need wiring.

```
  Where backpressure WOULD live (the prerequisite for fan-out)

  ┌─ Supervisor layer ───────────────────────────────────────┐
  │  spawn worker? check global concurrency state             │ ← new (if fan-out)
  │  if queue depth > threshold → stop spawning               │
  └─────────────────────┬────────────────────────────────────┘
                        ▼
  ┌─ DataSource layer ───────────────────────────────────────┐
  │  concurrency semaphore (e.g. cap at 4 concurrent calls)  │ ← new (if fan-out)
  │  + existing 1 req/s proactive spacing                     │
  │  + existing rate-limit retry                              │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **what's between the model's intent to call N tools and the provider receiving them?**

```
  Today (no fan-out, all sequential):
  ────────────────────────────────────
  agent → callTool → 1 req/s spacing → MCP
  no concurrency, no semaphore needed

  Hypothetical (fan-out, with backpressure):
  ───────────────────────────────────────────
  supervisor → spawn N workers (concurrently)
       │
       ▼
  workers all call dataSource.callTool
       │
       ▼
  semaphore (cap=N_concurrent) ← BACKPRESSURE
       │  pop up to N concurrent; queue the rest
       ▼
  1 req/s spacing + rate-limit retry
       │
       ▼
  MCP server (sees at most N_concurrent at a time)
```

## How it works

### Move 1 — the mental model

You know the "200 fetches with `Promise.all` open 200 connections at once" anti-pattern — production code reaches for a `limit` helper to cap concurrency. Backpressure for agents is that same primitive at a different layer: the supervisor decomposes into N workers, the workers fire concurrent tool calls, the semaphore caps how many actually hit the provider at once.

```
  Fan-out backpressure — flow control between supervisor and provider

  Supervisor decomposes → 12 worker calls at once
                       │
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Concurrency limiter (semaphore)              │
  │   pop up to N concurrent (N = 4)              │
  │   queue the rest                              │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Provider — receives at most N at a time      │
  └───────────────────────────────────────────────┘
```

### Move 2 — what backpressure would look like in this repo

Bloomreach's MCP server rate-limits at ~1 req/s globally per user — the current `BloomreachDataSource` enforces this with proactive spacing (calls are queued internally and released at ~1 req/s). Sequential agent calls don't trip this; they fire one at a time naturally.

If the monitoring agent (`MonitoringAgent`) were refactored to fan out across categories (see `../03-multi-agent-orchestration/04-parallel-fan-out.md`), say 5 CategoryWorkers running in parallel, all 5 would call `dataSource.callTool` simultaneously. The current spacing would queue them — fan-out becomes serial again at the data-source layer, defeating the parallelism.

The fix would be a concurrency cap **higher than** the spacing's effective throughput, with the spacing still acting as the per-call rate limit. Sketch:

```typescript
// hypothetical addition to BloomreachDataSource
private semaphore = new Semaphore(4); // cap 4 concurrent in-flight

async callTool(name, args, opts) {
  await this.semaphore.acquire();
  try {
    // existing: cache check, spacing, MCP call, retry
    return await this.actualCall(name, args, opts);
  } finally {
    this.semaphore.release();
  }
}
```

With a cap of 4 and ~1 req/s spacing, you'd get roughly 4 concurrent calls cycling through the spacing — effective throughput ~4 req/s instead of 1. Latency for a fan-out of 5 workers drops from ~5s (sequential) to ~1.5-2s (4 in parallel, 1 queued briefly).

**Backpressure upward — the second half of the pattern.**

The supervisor side also needs flow control: when the worker queue grows past a threshold, the supervisor should stop spawning further rather than queue unbounded work. A runaway supervisor that keeps spawning workers is the multi-agent version of an unbounded queue.

Concretely: if MonitoringDispatcher is iterating over 50 customer segments and the semaphore queue is already at 20, the dispatcher should pause spawning until the queue drains below a threshold. This prevents a 10x backlog of pending workers from sitting in memory.

### Move 2.5 — the tradeoff

A low concurrency cap protects the provider but serializes the fan-out (you lose the parallel-latency win that made fan-out worth it). The breakpoint is the provider's rate limit divided by per-call duration:

- Bloomreach: ~1 req/s, ~200-500ms per call → effective throughput ~2-5 req/s without rate-limiting
- Concurrency cap = 4 → fits comfortably under this
- Concurrency cap = 20 → would 429 the server constantly

The cap should be just under "the highest concurrency the provider can sustain without 429ing." For Bloomreach that's probably 3-5. If the task needs more throughput than that, the answer is request a higher limit OR batch within each call, not a higher local cap that just trades queueing for 429s.

### Move 3 — the principle

A runaway supervisor that keeps spawning workers without backpressure is the multi-agent version of an unbounded queue. Three controls compose: a concurrency semaphore at the DataSource layer (bounds in-flight calls), proactive spacing at the same layer (smooths the rate), and upward backpressure at the supervisor layer (stops spawning when the queue grows). All three are needed for production-grade fan-out.

The cheaper alternative: don't fan out. Sequential agents with shared rate-limiting are simpler, and if the latency is acceptable, the complexity isn't earned.

## In this codebase

**Not implemented as a concurrency semaphore** — there's no fan-out today. The ~1 req/s proactive spacing in `BloomreachDataSource` acts as a degenerate "cap at 1 concurrent" — it works because all calls are sequential anyway.

The case for adopting it: when MonitoringAgent's 6-call sequential budget becomes the latency bottleneck (today it's ~6-10s, fine; with a 10x expansion of the budget it becomes painful). At that point, fan-out + backpressure is the right answer; the load-bearing addition isn't the fan-out, it's the semaphore.

## Primary diagram

The contrast — today's degenerate cap vs hypothetical full backpressure:

```
  Comparison — today's degenerate cap vs full backpressure

  TODAY (sequential agents, ~1 req/s spacing as degenerate cap):
  ┌──────────────┐  one call at a time   ┌──────────────┐
  │ agent        │ ─────────────────────► │ ~1 req/s     │  MCP
  │ (sequential) │                        │ spacing      │
  └──────────────┘                        └──────────────┘
  effective: 1 req/s, no actual concurrency

  HYPOTHETICAL (fan-out, with semaphore):
  ┌──────────────┐  spawn N workers       ┌──────────────┐
  │ supervisor   │ ─────────────────────► │ Semaphore    │
  │  spawn cap   │                        │  cap = 4     │  ← BACKPRESSURE
  │  (upward bp) │                        └──────┬───────┘
  └──────────────┘                               │ pop 4 at a time
                                                 ▼
                                          ┌──────────────┐
                                          │ ~1 req/s     │
                                          │ spacing      │
                                          └──────┬───────┘
                                                 ▼
                                                MCP
  effective: ~4 concurrent, ~3-5 req/s; latency cut from 5s to 1.5s
```

## Interview defense

**Q: "What's the backpressure story for your agents?"**

A: Today, sequential — Bloomreach's ~1 req/s rate limit is enforced by proactive spacing in `BloomreachDataSource`, and all agents call sequentially within one ReAct loop. There's no concurrency to limit because there's no fan-out. The degenerate "cap at 1 concurrent" is built into the spacing.

If we adopted fan-out (e.g., MonitoringAgent dispatching N CategoryWorkers in parallel), the load-bearing addition isn't the fan-out itself — it's a concurrency semaphore at the DataSource layer. With a cap of 4 and the existing ~1 req/s spacing, effective throughput goes to ~3-5 req/s, latency for 5 workers drops from ~5s to ~1.5s. The cap should be just under what Bloomreach can sustain without 429ing. The second half of the pattern — upward backpressure at the supervisor (stop spawning when the queue grows past a threshold) — prevents the runaway-supervisor case where the dispatcher keeps adding workers faster than the semaphore can drain them.

Diagram I'd sketch:

```
  today:                              with fan-out:
  agent → 1 req/s spacing → MCP       supervisor → spawn N
                                            │
                                            ▼
                                      semaphore (cap=4) ← bp
                                            │
                                            ▼
                                      1 req/s spacing → MCP
                                            ▲
                                            │
                                      supervisor pauses spawning
                                      if queue > threshold (upward bp)
```

Anchor: "a runaway supervisor that keeps spawning workers without backpressure is the multi-agent version of an unbounded queue. The semaphore is the load-bearing primitive — without it, fan-out is just a faster way to 429 the provider."

**Q: "Why not just turn off the spacing and let the agents go full speed?"**

A: Because the spacing exists to prevent the rate-limit from being tripped. Without it, the first few calls succeed and then the 4th gets a 429. The current spacing trades minor latency (~1s between calls) for never-tripping the rate limit. Removing it just trades the proactive cost for the reactive cost (retry on 429), and the reactive cost is higher because the rate-limit penalty window can be 5-10 seconds. Production wisdom: proactive spacing under the rate limit beats reactive retry around it. The same principle scales to fan-out — cap concurrency just under "what the provider sustains," let the spacing smooth the rate.

## See also

- [`../03-multi-agent-orchestration/04-parallel-fan-out.md`](../03-multi-agent-orchestration/04-parallel-fan-out.md) — the topology that needs this as a prerequisite
- [`03-per-tool-circuit-breaking.md`](./03-per-tool-circuit-breaking.md) — the per-tool version of the same flow-control instinct
- [`../03-multi-agent-orchestration/09-coordination-failure-modes.md`](../03-multi-agent-orchestration/09-coordination-failure-modes.md) — tool-call cascade is what backpressure prevents
- ai-engineering's rate-limit + backpressure files (cross-ref) — the single-call version
