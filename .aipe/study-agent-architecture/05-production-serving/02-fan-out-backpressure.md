# Fan-out backpressure

_Industry standard._

## Zoom out, then zoom in

The primitive that turns "many concurrent investigations" into "N concurrent with a semaphore cap." In this repo the canonical case is the eval load harness — `eval/load.eval.ts:171-211` — which runs N investigations at LOAD_CONCURRENCY workers, each worker pulling from a shared queue, errors on one worker not stopping others. The concurrency cap IS the worker count. That's the shape.

```
  Zoom out — where the fan-out lives, per layer

  ┌─ Load harness (LOAD_N=20, LOAD_CONCURRENCY=3) ──────────────┐
  │  worker pool draining a shared index queue                  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ N investigations, K workers
                              ▼
  ┌─ Each worker: runOneInvestigation(index) ───────────────────┐
  │  BudgetTracker + FaultInjectingDataSource + AptKit loop      │
  └───────────────────────────┬─────────────────────────────────┘
                              │ tool calls flow through
                              ▼
  ┌─ BloomreachDataSource / FaultInjectingDataSource ───────────┐
  │  minIntervalMs=1100 spacing gate (the actual ceiling)       │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the load harness's concurrency cap is *upstream* backpressure — bound at the worker layer. The spacing gate is *downstream* backpressure — bound at the transport. Both matter; the transport gate is the one that actually rules under load.

## Structure pass

**Layers:** work queue (shared array) · worker pool (K concurrent) · per-worker investigation · downstream tool calls.
**Axis:** *what bounds "how many things are in flight at once"?*
**Seam:** the semaphore. In classical concurrency-cap patterns it's an explicit semaphore primitive. Here it's implicit in the worker count — K workers each running one investigation at a time equals a K-slot semaphore.

```
  Semaphore = worker count — the implicit form

  Classical semaphore:              This repo's shape:
  ┌─ Semaphore(N=4) ─────┐         ┌─ K workers ──────────┐
  │  acquire(), release()│         │  each pulls one item,│
  │  N slots             │         │  runs it, loops       │
  └──────────────────────┘         └──────────────────────┘

  Same math, different implementation.
  Worker pool is simpler when the caller doesn't need
  fine-grained release control mid-task.
```

## How it works

### Move 1 — the mental model

You've written `Promise.all` over 100 requests and watched the browser open 100 sockets, hit connection limits, and time out. The fix is a concurrency-capped `Promise.all` — a pool that pulls from a queue, K workers deep. That's exactly the load harness's shape. If you've written a worker pool in JavaScript (or a `for await` over batched slices), you already know this pattern.

```
  Pattern: worker pool over a shared queue

  ┌─ Queue: [0, 1, 2, ..., N-1] ─┐
  └───┬───────┬───────┬──────────┘
      │       │       │
   ┌──▼──┐ ┌──▼──┐ ┌──▼──┐
   │ w0  │ │ w1  │ │ w2  │      ← K workers
   └──┬──┘ └──┬──┘ └──┬──┘
      │       │       │
      ▼       ▼       ▼
   run one investigation each; loop until queue empty
```

### Move 2 — the walkthrough

**The queue + worker pool — `eval/load.eval.ts:171-211`.** The load-bearing lines:

```ts
// eval/load.eval.ts:171-211 — semaphore-based fan-out
const runStart = performance.now();
const results: Investigation[] = [];

// Semaphore-based concurrency. queue is an index generator; workers
// pull from it until it's exhausted. Errors don't stop other workers.
const indices = Array.from({ length: LOAD_N }, (_, i) => i);
const queue = [...indices];

async function worker(workerId: number): Promise<void> {
  while (queue.length > 0) {
    const index = queue.shift();
    if (index == null) return;
    const caseIdx = index % goldens.length;
    const golden = goldens[caseIdx];
    const started = performance.now();
    try {
      const inv = await runOneInvestigation(index, golden.caseId, ..., workerId);
      results.push(inv);
    } catch (err) {
      const dur = Math.round(performance.now() - started);
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ /* ...failed shape... */ error: msg });
    }
  }
}

const workers = Array.from({ length: LOAD_CONCURRENCY }, (_, i) => worker(i));
await Promise.all(workers);
```

Line-by-line:

- **`queue = [...indices]`** — the shared work queue. Every worker pulls from the same array via `.shift()`. Node's single-threaded execution model makes this safe: `.shift()` is atomic on the array from the perspective of the event loop.
- **`while (queue.length > 0)`** — worker loops until the queue drains. When it empties, the worker returns; the next `await Promise.all` unblocks once all K workers return.
- **`try/catch inside the loop`** — errors on one investigation push a failed-shape result and continue. One bad case doesn't kill the whole load run. That's the load-bearing property: fault-tolerance at the worker level, not "abort on first error."
- **`Array.from({ length: LOAD_CONCURRENCY }, ...)` + `Promise.all(workers)`** — spawn K workers, await all. The concurrency cap = K. Passing K=1 gives sequential execution; K=3 gives 3-way parallel. That's the semaphore, implicit in the worker count.

**Why worker pool instead of an explicit semaphore.** An explicit semaphore (an `async-mutex`-style primitive) is the textbook shape. The worker pool is equivalent when investigations are atomic units — one worker runs one investigation, no need for `acquire()`/`release()` mid-task. The pool is simpler: one array, K workers, `Promise.all`, done. It also composes better with fault injection — the try/catch wrapper lives naturally inside the worker loop, no separate error-handling story around the semaphore.

**Upward backpressure — where blooming DOESN'T have it.** The classic multi-agent version is a supervisor that stops decomposing when the worker queue grows past a threshold. Blooming's supervisor (in `route.ts`) doesn't decompose at runtime — the topology is deterministic (see `03-multi-agent-orchestration/02-supervisor-worker.md`), so there's nothing to bound upward. If blooming grew a research-assistant shape where a supervisor dynamically fanned out to N workers per query, upward backpressure would become load-bearing: cap the fan-out, don't let the supervisor queue unbounded work.

**Real receipt — the load harness output.** The most recent receipt (`eval/load-receipts/load-2026-07-03T05-21-12-237Z.json`) shows the pattern in action:

- **Config:** N=3, concurrency=1, budgetPerInvestigationUsd=2, faultRates timeout=0.2 malformed_json=0.2.
- **Result:** 3 succeeded, 0 failed. totalMs=283170 (~94s per investigation). p50 total=92707ms. faultTotals: 5 malformed_json + 4 timeout = 9 injected faults across 3 investigations, all recovered gracefully.
- **Cost:** total=$0.21, per-investigation p50=$0.070.

The 0-failed number is the receipt of graceful degradation — 9 faults across 3 investigations, no failed runs. See `03-fault-injection-and-graceful-degradation.md`.

```
  Layers-and-hops — the load harness under load

  ┌─ Test process ──────────────────────────────────────────────┐
  │  build shared queue: [0, 1, ..., N-1]                        │
  │  spawn K workers, each pulling from queue                    │
  └───────────────────────────┬─────────────────────────────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
  ┌─ worker 0 ────┐  ┌─ worker 1 ────┐  ┌─ worker 2 ────┐
  │ runOne(0)     │  │ runOne(1)     │  │ runOne(2)     │
  │  BudgetTracker│  │  BudgetTracker│  │  BudgetTracker│
  │  AptKit loop  │  │  AptKit loop  │  │  AptKit loop  │
  └──────┬────────┘  └──────┬────────┘  └──────┬────────┘
         │                  │                  │
         └──────────────────┼──────────────────┘
                            │ all tool calls funnel through
                            ▼
  ┌─ FaultInjectingDataSource → BloomreachDataSource ───────────┐
  │  minIntervalMs=1100 spacing gate serializes to ~1 req/s     │
  └─────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Bounded concurrency is not optional at the caller layer even when the transport enforces its own limit. The load harness's LOAD_CONCURRENCY cap is what bounds the *Anthropic-side* concurrent model calls (transport limit doesn't help there — each investigation is many Sonnet turns). The transport-side spacing gate is what bounds the *Bloomreach-side* concurrent tool calls. Together they define the effective throughput. Get either wrong and you either underuse capacity or trigger 429s. Get both right and the receipt looks like the one above — bounded latency, bounded cost, faults recovered gracefully.

## Primary diagram

```
  Recap — the fan-out backpressure surface

  Load harness config:
  ┌─────────────────────────────────────────────┐
  │  LOAD_N            = 3                       │
  │  LOAD_CONCURRENCY  = 1  ← the semaphore       │
  │  faultRates        = { timeout: 0.2, ... }   │
  │  budgetPerInvestigationUsd = 2                │
  └─────────────────────────────────────────────┘

  Runtime:
  queue = [0, 1, ..., N-1]
      │
      ▼
  K workers, each: while (queue.length) → runOne(queue.shift())
      │
      ▼
  Each worker → BudgetTracker + AptKit loop + FaultInjecting → Bloomreach
      │
      ▼
  transport-side minIntervalMs=1100 serializes tool calls to ~1/sec
      │
      ▼
  Receipt: 3 succeeded / 0 failed / 9 faults recovered / $0.21 total
```

## Elaborate

The load harness is where blooming's tier-2 story — "graceful degradation under fault injection" — gets exercised. The concurrency cap decides how much parallelism you're testing under. K=1 (sequential) is the honest baseline: how does one investigation handle 20% timeout + 20% malformed_json fault rates? K=3 tests whether the same behavior holds when three investigations compete for the transport limit. K=10 would test whether the caller-side cap gracefully degrades to the transport's ceiling.

The queue's `.shift()` semantics matter for JS specifically: Node's event loop guarantees `.shift()` is atomic (no other worker can shift between one worker's read and its increment). In languages with real threads (Go, Rust) you'd need a mutex or a channel; JS gives you the atomic op for free.

Fault injection makes the receipt meaningful. Without faults, "3 succeeded" is just baseline behavior. With 20% timeout + 20% malformed_json, "3 succeeded" is a real signal — the AptKit agent loop plus `is_error` handling recovered from every injected fault. That's the shape of production readiness: the load harness proves the graceful path exists before real traffic finds a way to break it.

Cross-reference: `study-ai-engineering`'s section on rate limiting and backpressure covers the single-call primitives. This file covers the loop-and-topology version.

## Interview defense

**Q: How is fan-out concurrency bounded in this system?**
A: Two ceilings, in order. Caller-side: the load harness spawns K workers (LOAD_CONCURRENCY) that pull from a shared queue via `.shift()` — Node's atomic op removes the need for a mutex. That's an implicit semaphore of size K. Transport-side: `BloomreachDataSource.minIntervalMs=1100` serializes tool calls to ~1/sec regardless of caller concurrency. Under the two ceilings together, LOAD_CONCURRENCY parallelizes the *Anthropic-side* model work (each worker's Sonnet loop), the transport gate serializes the *Bloomreach-side* tool calls. The most recent receipt at N=3, K=1: 283s total wall-clock, 92s p50 per investigation, $0.21 total, 9 faults recovered across 3 runs, 0 failures.

Diagram: the two ceilings, with the K workers feeding through the transport gate.
Anchor: `eval/load.eval.ts:171-211` (worker pool) + `lib/data-source/bloomreach-data-source.ts:190-198` (transport gate).

**Q: Why not an explicit semaphore primitive?**
A: For atomic units of work — one worker runs one investigation — the worker pool is equivalent to a K-slot semaphore. `acquire()`/`release()` semantics matter when a task splits into sub-phases that each need to hold a slot, or when you want per-slot metadata. The load harness has neither: one investigation = one worker's turn, errors handled inline via try/catch, no need to release mid-task. The worker pool is simpler to read and composes better with fault injection (the try/catch wrapper lives naturally inside the worker loop). If we grew a supervisor that dispatched to N dynamic sub-workers per investigation, an explicit semaphore would earn its keep at the supervisor layer.

Diagram: the worker pool shape beside the classical semaphore shape, showing equivalence.
Anchor: `eval/load.eval.ts:174-208`.

## See also

- `01-rate-limit-compliance.md` — the transport-side ceiling every fan-out passes through.
- `03-fault-injection-and-graceful-degradation.md` — the load harness's tier-2 receipt.
- `04-cost-controls.md` — per-investigation BudgetTracker inside each worker.
- `03-multi-agent-orchestration/04-parallel-fan-out.md` — the topology-level treatment.
