# 06 · Load harness — semaphore-bounded concurrency

**Bounded worker pool · Industry standard.** Also called
*counting semaphore*, *worker-per-slot*, or *fixed-K concurrency
limiter*. Fundamental for any load generator that mustn't
overshoot its own budget.

## Zoom out — where the harness sits

Offline. The load harness runs as a Vitest job (`npm run eval:load`)
against the `SyntheticDataSource` — not against the live
Bloomreach MCP server. That's a deliberate choice: firing 20
investigations at the live server would burn the ~1 req/s rate
budget in seconds. Synthetic keeps the harness fast and cheap; the
graceful-degradation story is defended separately by the
fault-injecting decorator (§07).

```
  Zoom out — the harness and what it drives

  ┌─ CLI (npm run eval:load) ────────────────────────────────────┐
  │  LOAD_N=20 · LOAD_CONCURRENCY=3 · BUDGET_MAX_USD=2.0          │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  Vitest
  ┌─ eval/load.eval.ts ───────────▼──────────────────────────────┐
  │                                                                │
  │   ★ SEMAPHORE: K workers pulling from a shared queue ★         │
  │                                                                │
  │   for each worker:                                             │
  │     while queue not empty:                                     │
  │       index = queue.shift()                                    │
  │       runOneInvestigation(index)                               │
  │                                                                │
  │   Promise.all(workers) → aggregate → receipt                  │
  └───────────────────┬───────────────────┬──────────────────────┘
                      │                   │
        ┌─────────────▼─────┐   ┌─────────▼──────────────────┐
        │ Anthropic API      │   │ SyntheticDataSource         │
        │ (real cost)        │   │ (in-process, 0ms tool time) │
        └────────────────────┘   └─────────────────────────────┘
```

**Zoom in — bounded parallelism.** You could `Promise.all(20
investigations)` and let the runtime run all 20 concurrently.
That's what the semaphore stops you from doing. Fixed K workers
means at most K investigations are in flight; the other N–K wait
in the queue. Bounded fan-out is what makes load-generation
predictable — both in cost per unit time and in what you're
measuring.

## Structure pass — layers, axis, seams

**Layers.** CLI env → runner config → worker pool → per-investigation
work.

**Axis: what bounds each layer's parallelism?**

```
  Axis — "how many things run at once?"

  ┌─ layer ─────────────┐   bound          who enforces it
  │ CLI                 │   LOAD_N total    (queue size)
  ├─────────────────────┤
  │ worker pool         │   LOAD_CONCURRENCY (fixed K worker fns)
  ├─────────────────────┤
  │ per investigation   │   1 at a time     (single-threaded ReAct)
  ├─────────────────────┤
  │ Anthropic API       │   K rps           (K workers × 1 call/turn)
  └─────────────────────┘
```

**Seams.** The seam is `queue.shift()` inside `worker()`. That's
the atomic "give me the next unit of work" — the semaphore
semantics come from the single-threaded event loop guaranteeing
that `shift()` is uncontended. In a threaded language you'd need a
mutex; in Node, the event-loop-serialized shift IS the mutex.

## How it works

### Move 1 — the mental model

You already know how a thread pool with a fixed size works: N
tasks queued, K worker threads pull from the queue, when all
workers idle and queue empty, done. This is that pattern in
async-await form, where the "threads" are just coroutines all
sharing one thread.

```
  Pattern — fixed-K workers, one shared queue

  queue = [0, 1, 2, …, N-1]     ← indices of goldens to run

  worker(0):                    worker(1):        worker(2):
    while queue not empty:        (same)            (same)
      i = queue.shift()
      run investigation i

  Promise.all([worker(0), worker(1), worker(2)])

  ┌── time ──►
  w0:  ▓▓▓▓ i=0 ▓▓▓▓  ▓▓▓▓ i=3 ▓▓▓▓  ▓▓▓▓ i=6 ▓▓▓▓
  w1:  ▓▓▓▓ i=1 ▓▓▓▓▓▓  ▓▓▓▓ i=4 ▓▓▓▓  ▓▓▓▓ i=7 ▓▓▓
  w2:  ▓▓▓▓ i=2 ▓▓▓▓  ▓▓▓▓ i=5 ▓▓▓▓▓▓  ▓▓▓▓ i=8 ▓▓▓▓

  at most K=3 concurrent · rest wait in queue
```

**Skeleton part everyone forgets.** The workers don't get pre-
assigned indices. Each worker pulls WHEN it's free — so if worker
1's investigation takes 200s and worker 2's takes 100s, worker 2
grabs the next work item without waiting for worker 1. This is
what makes the pool work-conserving: no worker is ever idle when
work remains.

### Move 2 — walking the mechanism

#### The config

`eval/load.eval.ts:89-91`:

```ts
const LOAD_N = Number(process.env.LOAD_N ?? '20');
const LOAD_CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? '3');
const BUDGET_PER_INVESTIGATION_USD = Number(process.env.BUDGET_MAX_USD ?? '2.0');
```

**Three env knobs.** N is the total work; K is the parallelism; the
cost ceiling is a bound each worker respects independently (each
investigation gets its own `BudgetTracker` — see §05). Defaults
are chosen for a "real load" run: N=20 at K=3 is roughly
`20 × 250s / 3 ≈ 1667s ≈ 28 min` at ~$1.80 total spend. Smoke
runs override to `LOAD_N=2 LOAD_CONCURRENCY=1`.

#### The queue and workers

`eval/load.eval.ts:170-211`:

```ts
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
      const inv = await runOneInvestigation(index, golden.caseId, golden.signalClass, golden, workerId);
      results.push(inv);
      // …log per-investigation
    } catch (err) {
      // …log failure, push a failure record; don't rethrow
    }
  }
}

const workers = Array.from({ length: LOAD_CONCURRENCY }, (_, i) => worker(i));
await Promise.all(workers);
```

**Why `queue.shift()` in a plain array works.** Node.js is
single-threaded per event-loop iteration; `Array.prototype.shift`
runs synchronously and is atomic with respect to other JS code.
Two workers cannot both "see" queue.length > 0 and both shift the
same index — the second one gets `undefined` and returns. No
mutex, no lock, no atomic counter. The event loop IS the
synchronization primitive.

**Why errors don't stop the pool.** The `try/catch` inside the
worker converts a thrown investigation into a failure *record*.
The worker continues to the next queue entry. If we rethrew, the
worker would die and the pool would silently drop to K-1 for the
rest of the run. That's a common load-harness bug — surfaced as
"why did my 20-run report only have 17 investigations?" Named as
a bug the shape of this code avoids.

**Rotating goldens for N > pool size.** `caseIdx = index % goldens.length`
(`load.eval.ts:178`). There are 10 goldens; at N=20 we cycle
through each twice, at N=50 five times. This is deliberate —
comment at `load.eval.ts:15-17` names it: varied metrics /
scopes / severities across every run, no-signal cases in the
pool stress the "insufficient evidence" path under load. Not 20
happy-path copies.

#### The per-investigation budget

`eval/load.eval.ts:265`:

```ts
const budget = new BudgetTracker({ maxCostUsd: BUDGET_PER_INVESTIGATION_USD });
```

**Each investigation gets its own tracker.** So worker 0's
investigation 0 can't burn through worker 1's budget. This is what
lets the pool run 3 concurrent investigations at $2 ceiling each
without needing a global tracker — the total spend cap is
implicitly `LOAD_N × BUDGET_PER_INVESTIGATION_USD` in the worst
case, but practically ~$0.09/investigation so ~$1.80 at N=20. See
`05-budget-ceiling-check-before-dispatch.md` for the tracker
mechanics.

#### The receipt aggregation

`eval/load.eval.ts:326-333`:

```ts
function percentiles(arr: readonly number[]): { p50, p95, p99, max, mean } {
  if (arr.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const mean = Math.round(sorted.reduce((s, n) => s + n, 0) / sorted.length);
  return { p50: pct(50), p95: pct(95), p99: pct(99), max: sorted[sorted.length - 1], mean };
}
```

**Percentile calculation, honest form.** The `pct(p)` uses
`Math.floor((p / 100) * sorted.length)` clamped to `sorted.length
- 1`. For N=20 and p95, that's index 19 = the max. For N=100 and
p95, that's index 95 = the 96th-smallest. This is the "nearest-
rank" method — simple, doesn't interpolate, doesn't lie about
precision. At small N the p99 collapses to the max, which is what
the report emits (and why `max` is also shown alongside p99).

### Move 3 — the principle

Bound the fan-out; measure the distribution, not the mean. The
semaphore bounds fan-out so the harness itself doesn't overwhelm
the system it's measuring. Distribution measurement means p50 AND
p95 AND p99 AND max — the mean alone hides tail behavior, which
is exactly what a load test is supposed to expose. This is the
harness equivalent of the load-bearing lesson from §01: name three
axes; report all four.

## Primary diagram

```
  The full load run — semaphore in action

  npm run eval:load LOAD_N=6 LOAD_CONCURRENCY=3
                          │
                          ▼
  queue = [0, 1, 2, 3, 4, 5]
                          │
                          ▼
  Promise.all([worker(0), worker(1), worker(2)])
                          │
   ┌──────────────────────┼──────────────────────┐
   │                      │                      │
   ▼                      ▼                      ▼
  w0                    w1                    w2
  │ shift → 0            shift → 1            shift → 2
  │ invest(0) …          invest(1) …          invest(2) …
  │       ▼                   ▼                   ▼
  │ shift → 3            shift → 4            shift → 5
  │ invest(3) …          invest(4) …          invest(5) …
  │       ▼                   ▼                   ▼
  │ shift → undef        shift → undef        shift → undef
  │ return               return               return
  │       │                   │                   │
   └──────┴───────────────────┴───────────────────┘
                          │
                          ▼
  results = [i0, i1, i2, i3, i4, i5]
  results.sort((a,b) => a.index - b.index)
  percentiles(...) → receipt
  writeFileSync(load-<runId>.json, receipt)
```

## Elaborate

**Where the pattern comes from.** Bounded worker pools are one of
the oldest concurrency patterns — Java's `ExecutorService`, Go's
worker pools with buffered channels, Python's `concurrent.futures`.
The Node async-await variant is more recent but structurally
identical: coroutines instead of threads, event loop instead of
scheduler, `.shift()` instead of a lock-protected dequeue.

**Alternatives considered (implicitly).** A more sophisticated
harness would use `p-limit` or similar — a library that returns a
function you wrap each task in. Same semantics, less code, one
more dependency. For this repo's scale (one N-run type, no need
for prioritization) the inline queue is right-sized.

**Cross-link.** `study-runtime-systems` walks WHY `queue.shift()`
is atomic in the single-threaded event loop — the async primitive
that makes the semaphore-without-a-lock work. `study-testing`
walks the eval design (fixtures, judges, receipts) that the load
harness reuses without judges.

## Interview defense

### Q1 · "Walk me through your load harness."

**Answer.** Semaphore-based bounded concurrency. Two env knobs:
`LOAD_N` (total investigations to run) and `LOAD_CONCURRENCY`
(how many run in parallel). We build a queue of `N` indices, spawn
`K` async worker functions, and each worker loops: pull the next
index off the queue, run one full investigation, push the result,
repeat until the queue is empty. `Promise.all` on the K workers
waits until all workers see an empty queue. Errors are caught per-
investigation and recorded as failure entries — one thrown
investigation doesn't kill the pool. After all workers finish, we
sort results by index, compute per-phase p50/p95/p99/max/mean
across successes, aggregate cost and tokens, and emit a JSON
receipt to `eval/load-receipts/load-<runId>.json`. Runs against
`SyntheticDataSource` so it doesn't burn the live Bloomreach rate
budget; the fault-injecting decorator wraps the datasource when
fault rates are set.

```
  queue: [0..N-1]           ┌─ w0 ┐
   │  shift() = atomic     │      │→
   ▼  in event loop         │─ w1 ┤→  Promise.all(workers) → receipt
   K workers pull → run     │      │→
                            └─ w2 ┘
```

**One-line anchor.** "K async workers atomically shifting from a
shared queue — event-loop-serialized dequeue is the semaphore."

### Q2 · "Why not just `Promise.all(N investigations)`?"

**Answer.** Two problems. First, unbounded fan-out spikes the
Anthropic API concurrent-request rate — a 20-way Promise.all fires
20 first-turn calls at once, and the rate limit response tail
becomes the dominant latency. Second, unbounded parallelism means
the harness measurement is dominated by contention, not by the
system's actual throughput at a chosen K. The whole point of a
load test is to characterize behavior at a specific concurrency;
you can't do that if the harness sets K = whatever the runtime
decides. Fixed K is the discipline — vary K across runs to build
a saturation curve.

**One-line anchor.** "Unbounded fan-out measures the harness's
overhead, not the system's throughput."

### Q3 · "How do you compute p99 with only 20 samples?"

**Answer.** Honestly — we don't. The nearest-rank method with 20
samples puts p99 at `floor(0.99 × 20) = 19`, which is the max.
The receipt reports both p99 and max explicitly so it's obvious
they collapse at small N. Real p99 needs ~100+ samples; the load
harness is dimensioned for N=20 as a smoke, N=50+ as a real run.
The reporting shape is honest at both scales: at N=20 the max IS
the p99; at N=100 they diverge and the tail behavior separates.

**One-line anchor.** "At N=20 p99 collapses to max; report both
so the collapse is visible."

### Q4 · "What breaks if one worker's investigation hangs forever?"

**Answer.** The whole `Promise.all` waits for it. The eval runner
has an outer timeout (`load.eval.ts:228` — `Math.max(600_000, ((N
× 300_000) / K) × 1.5)`), so a wedged worker fails the test after
that budget elapses. Inside the investigation, the tool timeout
(30s) and the route-level model calls (each is HTTP with its own
timeout via `AbortSignal`) bound any single call. The one gap:
there's no per-investigation timeout at the load harness layer —
if one case genuinely takes 10 minutes and the outer timeout is
30 minutes, we wait. This is named as a known bound; the fix
would be `AbortSignal.timeout(600_000)` per investigation.

**One-line anchor.** "Outer Vitest timeout catches hangs; inner
30s tool timeout bounds any single call; per-investigation
timeout is a missing layer."

## See also

- `05-budget-ceiling-check-before-dispatch.md` — the cost
  ceiling each investigation enforces independently.
- `07-fault-injecting-decorator.md` — the graceful-degradation
  story the harness runs on top of.
- `01-route-budget-and-timeout-composition.md` — the deadline
  composition each investigation obeys, though the harness runs
  outside the route.
- `study-runtime-systems` — event-loop atomicity of `Array.shift`
  and why the semaphore doesn't need a lock.
- `study-testing` — the eval framework the harness lives inside.
