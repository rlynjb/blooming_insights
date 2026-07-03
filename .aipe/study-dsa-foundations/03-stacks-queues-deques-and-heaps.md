# Stacks, queues, deques, and heaps

*Ordering disciplines · priority queues · Industry standard*

## Zoom out, then zoom in

Ordering disciplines are just rules for "which item do I pick next?" LIFO (stack — newest first). FIFO (queue — oldest first). Priority (heap — most-important first). This codebase reaches for exactly one of these as a load-bearing move — a FIFO queue for the load harness — and misses one obvious opportunity for a heap. The picture:

```
  Zoom out — where ordering disciplines live in blooming_insights

  ┌─ UI layer ───────────────────────────────────────────────────┐
  │  (nothing here — React handles its own scheduling)           │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Route + agent layer ───▼────────────────────────────────────┐
  │  · monitoring-legacy.ts:136 — sort + slice(10)               │
  │    ★ HEAP-SHAPED PROBLEM, SOLVED WITH SORT ★                 │
  │  · aptkit's internal message queue (opaque to this code)     │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Eval / load layer ─────▼────────────────────────────────────┐
  │  ★ THIS CONCEPT LIVES HERE ★                                 │
  │  · load.eval.ts:169-211 — FIFO index queue + K workers       │
  │    (hand-rolled semaphore, no library)                       │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** Every ordering discipline is a container with a *policy*. The container is usually an array (or a heap-backed array); the policy is what makes it a stack vs a queue vs a heap. Get the policy right and the "which item next?" question collapses to one call.

## Structure pass

**Layers.** Two altitudes:
  1. the *interface* (push/pop, enqueue/dequeue, insert/peek-max)
  2. the *implementation* (array, linked list, heap-backed array)

**Axis: what's the cost of `pop`?** Trace it down:
  - stack (LIFO array push/pop) → O(1) both
  - queue (FIFO with `Array.shift()`) → O(1) push, O(n) shift *(what the load harness uses)*
  - deque (both ends O(1)) → needs a circular buffer or linked list *(not exercised here)*
  - min-heap (priority queue) → O(log n) insert, O(log n) extract-min *(you built this in reincodes; this repo hasn't used it yet)*

**Seams.** The load-bearing seam is between *whatever pop policy* and *the underlying container's cost*. `Array.shift()` is O(n) even though it feels like O(1) — that shift is fine when the queue is small, expensive when it isn't. Naming that gap is the interview signal.

## How it works

### Move 1 — the policies, in one picture

You know these from work. A stack is a stack of plates — last one on is the first one off. A queue is a checkout line — first come, first served. A heap is triage — most severe patient first regardless of arrival time. Same *container*, different *ordering rule*.

```
  Ordering disciplines — same container, different rule

  STACK (LIFO):        QUEUE (FIFO):       PRIORITY QUEUE:
                                            (min-heap here)
    push │  pop        enqueue    dequeue    insert   extract-min
      │   ▲              │            ▲         │           ▲
      ▼   │              ▼            │         ▼           │
    ┌───────┐         ┌───────────────┐      ┌───────────────┐
    │ C ← top│        │ A B C D E → out│     │  1  ← min     │
    │ B     │        │                │      │  3   5        │
    │ A     │        └───────────────┘      │  7  8  9  6   │
    └───────┘           head       tail      └───────────────┘
    O(1)/O(1)           O(1)/O(1)*            O(log n) / O(log n)

  * O(1) if implemented as a circular buffer or linked list; O(n)
    shift if the naive Array.shift() is used (this repo's harness)
```

The heap's shape matters here — it's a *nearly-complete binary tree* stored as an array where `parent(i) = (i-1)/2`, `leftChild(i) = 2i+1`. That layout is what makes `heapifyUp` and `heapifyDown` cache-friendly and lets extract-min be O(log n). You built this in `reincodes/BinaryHeap.ts` — the primitive is already in your head.

### Move 2 — the FIFO load-harness queue (the actual load-bearing use)

This is the one place ordering discipline is load-bearing in the repo. The pattern: LOAD_N tasks, K concurrent workers, one shared FIFO queue of indices. Workers pull until the queue is empty.

```
  Semaphore-based concurrency — K workers, one shared FIFO

  queue: [0, 1, 2, 3, 4, ..., N-1]        ← index generator

    worker 0 ───► shift() → 0 ───► runOneInvestigation(0)
    worker 1 ───► shift() → 1 ───► runOneInvestigation(1)  ← in flight
    worker 2 ───► shift() → 2 ───► runOneInvestigation(2)  ← in flight
    (worker 0 finishes)
    worker 0 ───► shift() → 3 ───► runOneInvestigation(3)  ← picks up
    ...
    queue empty → all workers return → Promise.all resolves
```

The code — the whole primitive fits in ~40 lines:

```ts
// eval/load.eval.ts:169-211 — hand-rolled semaphore
// Semaphore-based concurrency. queue is an index generator; workers
// pull from it until it's exhausted. Errors don't stop other workers.
const indices = Array.from({ length: LOAD_N }, (_, i) => i);
const queue = [...indices];                              // ← FIFO buffer

async function worker(workerId: number): Promise<void> {
  while (queue.length > 0) {                             // ← policy check
    const index = queue.shift();                         // ← O(n) shift (small n, fine)
    if (index == null) return;
    const caseIdx = index % goldens.length;
    const golden = goldens[caseIdx];
    const started = performance.now();
    try {
      const inv = await runOneInvestigation(index, golden.caseId, golden.signalClass, golden, workerId);
      results.push(inv);                                 // ← unordered accumulator
      // ...
    } catch (err) {
      // ...error path also pushes a synthetic Investigation
    }
  }
}

const workers = Array.from({ length: LOAD_CONCURRENCY }, (_, i) => worker(i));
await Promise.all(workers);                              // ← wait for all K to drain
```

Three load-bearing parts, each of which breaks something specific if you remove it:

  **1. The shared queue.** Without it, each worker would need its own slice of indices — the fastest worker would finish first and idle while slower workers grind through their slices. The shared queue is what makes "K workers, work-stealing on completion" work. Remove it and you get *static partitioning*, which is the wrong shape when task duration varies.

  **2. The `while (queue.length > 0)` loop with `shift()` inside.** Without this the worker would only handle one task and terminate. The while loop is what makes it a *worker* rather than a *one-shot*. The subtle correctness bit: `queue.length > 0` check + `queue.shift()` isn't atomic in most languages, but *is* atomic here because JS's event loop runs each `await`-free block to completion. Port this to Go or Rust and you'd need a mutex.

  **3. The `Promise.all(workers)`.** Without it, the outer scope would return before any worker finished — you'd write receipts for zero completed investigations. `Promise.all` is the barrier that says "everybody has to be done."

**Optional hardening (not part of the skeleton):** the try/catch around `runOneInvestigation` — a worker that hits an error doesn't stop other workers. Removing it turns one failed investigation into a whole-run failure. Worth having, but conceptually separate from the ordering discipline.

### Move 2 — the heap-shaped problem this repo solves with sort (the missed opportunity)

This is the interview-worth signal for this file. `monitoring-legacy.ts:136` needs the 10 most-severe anomalies out of an array. The current code sorts the whole thing:

```ts
// lib/agents/monitoring-legacy.ts:136 — sort + slice(10)
return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
```

That's O(n log n) time, O(n) space. For the current use — one LLM turn's worth of anomalies, always small — it's fine. If `parsed` had hundreds or thousands of entries, a min-heap of size 10 would be the honest answer:

```
  Top-K with a size-K min-heap — the "keep the K best so far" pattern

  heap capacity: K = 10  (keep 10 largest severity)

  for each item in the array:
    if heap.size < K:
      heap.insert(item)                    ← O(log K) fill phase
    else if item.severity > heap.peekMin().severity:
      heap.extractMin()                    ← O(log K) — evict smallest kept
      heap.insert(item)                    ← O(log K) — add newcomer
    else:
      skip                                 ← item can't be top K
                                             (heap.peekMin() is O(1))

  result: heap now holds the top 10, in any order.
  total time: O(n × log K) = O(n × log 10) = O(n)
  total space: O(K) = O(10)
```

Trace it — say 20 items, keep top 3:

```
  Execution trace — keep top 3 by severity

  input severities: [5, 2, 8, 1, 7, 3, 9, 4, 6, ...]

  step  action                          heap (min at top)
  ────────────────────────────────────────────────────
   1    insert 5                        [5]
   2    insert 2                        [2, 5]
   3    insert 8                        [2, 5, 8]        ← full
   4    1 < min(2)? no → skip           [2, 5, 8]
   5    7 > min(2)? yes → evict 2       [5, 7, 8]
   6    3 > min(5)? no → skip           [5, 7, 8]
   7    9 > min(5)? yes → evict 5       [7, 8, 9]
   8    4 > min(7)? no → skip           [7, 8, 9]
   9    6 > min(7)? no → skip           [7, 8, 9]        ← final
```

You already have the primitive:

```ts
// reincodes/PriorityQueue.ts (your own code)
// heap-backed with updatePriority — enqueue / dequeue / value→index lookup
```

Swap is:

```ts
// what the top-K would look like with your PriorityQueue
const topK = new MinPriorityQueue<Anomaly>((a) => SEV_RANK[a.severity]);
for (const item of parsed) {
  if (topK.size < 10) topK.enqueue(item);
  else if (SEV_RANK[item.severity] > topK.peek()!.priority) {
    topK.dequeue();
    topK.enqueue(item);
  }
}
return topK.toArray();  // any order; caller sorts if display order matters
```

Why isn't this in the repo? Because `parsed` is always tiny. The signal for the interview is: "I looked at this, I picked sort because n is small, and here's the exact swap when n grows." That's the shape of the answer for every "why didn't you use the fancy data structure?" question in a senior interview.

### Move 3 — the principle

**Ordering discipline is a policy, not a container.** The container is almost always an array (or a heap-backed array). The interesting choice is the *rule* by which you pick the next item. FIFO for fair scheduling. LIFO for backtracking / undo. Priority for triage. Match the rule to the problem and the code writes itself; mismatch and you'll end up sort-slicing on a hot path.

## Primary diagram

The whole story: one queue that's load-bearing in the harness, one heap-shaped problem the repo solves with sort today, one primitive you've already built in `reincodes` that would win when the shape flips.

```
  Ordering disciplines in blooming_insights — where they live and where they should

  ┌─ FIFO QUEUE (load harness) ────────────────────────────────┐
  │                                                             │
  │  eval/load.eval.ts:169-211                                  │
  │  · shared index array + K workers pulling shift()           │
  │  · Array.shift() is O(n) but n stays small — fine           │
  │  · hand-rolled semaphore, no library                        │
  │                                                             │
  │  interview signal: "I own the concurrency primitive"        │
  └─────────────────────────────────────────────────────────────┘

  ┌─ HEAP-SHAPED PROBLEM (currently sort) ─────────────────────┐
  │                                                             │
  │  lib/agents/monitoring-legacy.ts:136                        │
  │  · sort + slice(10) — O(n log n) on a small n               │
  │  · size-10 min-heap → O(n log 10) = O(n) when n grows       │
  │                                                             │
  │  interview signal: "the swap is one file (reincodes)        │
  │  away — I built the PriorityQueue, I know when to reach     │
  │  for it and when not to."                                   │
  └─────────────────────────────────────────────────────────────┘

  ┌─ NOT YET EXERCISED ────────────────────────────────────────┐
  │                                                             │
  │  · deque (both ends O(1))                                   │
  │  · double-ended priority queue                              │
  │  · monotonic queue / stack (sliding-window max)             │
  │                                                             │
  │  none of these show up in this repo yet                     │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

Heaps come from Williams (1964) with heapsort. The array-backed complete-binary-tree layout is the trick — parents at `(i-1)/2`, children at `2i+1` and `2i+2`. No pointers, cache-friendly, `sift-up` and `sift-down` are just index arithmetic. The Fibonacci heap (Fredman & Tarjan, 1984) buys you O(1) amortized `decreaseKey` for algorithms like Dijkstra and Prim, but the constants are big enough that a binary heap wins in practice for most sizes — the one in `reincodes` is exactly the right implementation.

Deques (`std::deque` in C++, `collections.deque` in Python) are typically a doubly-linked list of blocks, giving O(1) push/pop at both ends *and* random access. JS doesn't have a built-in deque — every "queue" in a JS codebase is either an array (with O(n) `shift`) or a hand-rolled linked list. `Array` with a head cursor (never actually shift, just increment an index) gets you O(1) enqueue/dequeue at the cost of memory that grows until you compact.

The "shared work queue with K workers" pattern is the shape of every worker pool: `worker_threads` in Node, `ThreadPoolExecutor` in Python, goroutines with a channel in Go, `tokio::spawn` with an `mpsc` channel in Rust. Same skeleton, different concurrency primitives. The load harness reaches for none of them because JS's single-threaded event loop makes the naive version correct.

The top-K pattern is a classic. Introselect / quickselect gets you O(n) *expected* time without a heap, but the constants are ugly and the code is fragile. Size-K heap is O(n log K), which is effectively O(n) for small K and much simpler to write correctly. Facebook's `select-k-out-of-n` benchmarks in the mid-2010s settled on heap for K < 100 and quickselect for K ≥ 100.

Related reading: CLRS chapters 6 (heapsort + priority queues), 10 (elementary data structures), Sedgewick chapter 2.4 (priority queues). For the concurrency angle, "The Art of Multiprocessor Programming" (Herlihy & Shavit) is the deeper text.

## Interview defense

**Q: The load harness uses `Array.shift()`, which is O(n). Why is that fine here?**

Two reasons. First, N stays small — LOAD_N defaults to 20, tops out around 100-200 in practice. O(n) shifts on a 200-element array are hundreds of nanoseconds, dwarfed by the milliseconds per investigation. Second, the alternative — a head-index cursor that never shifts — trades one perf annoyance for a memory-lifetime one (the array keeps growing until you compact). Not worth the complexity at this scale. If N crossed 10,000 tasks in one run, I'd swap for a head cursor or a real deque.

```
  Cost math — why shift() is fine

  N = 200 tasks
  average shift depth: N/2 = 100 element moves
  cost per move: ~1 ns
  total: 200 tasks × 100 ns = 20 μs of shift work
  compared to: 200 × 10s investigation time = 2000 seconds
  → shift cost is 10^-8 of total work — invisible
```

**Anchor:** "`Array.shift()` is O(n) but n stays tiny — visible in a benchmark, invisible in this workload."

**Q: `monitoring-legacy.ts:136` does sort-and-slice-10. When would you swap for a heap?**

When `parsed` reliably exceeds ~50 items. Below that, sort is faster in practice — Timsort's constants beat the heap's, and the code is one line. Above that, the O(n log n) vs O(n log 10) = O(n) gap opens up. The right answer isn't "always use a heap for top-K" — it's "know when N flips the tradeoff." I've implemented the min-heap and priority queue from scratch in `reincodes/BinaryHeap.ts` and `PriorityQueue.ts`, so I could make the swap with confidence when the workload demands it — right now it doesn't.

```
  Sort vs heap for top-K — the flip point

  N=10       sort wins (constants)
  N=50       tie
  N=1000     heap wins (n log n / n → 10× less work)
  N=1M       heap wins big
```

**Anchor:** "Sort wins for small n; heap wins past ~50-100; I've built the primitive so the swap is a one-line change when N crosses over."

**Q: If two workers race on `queue.shift()`, don't you get a bug?**

Not in JavaScript. The event loop runs each synchronous block to completion — a worker's `queue.length > 0` check and its immediately-following `queue.shift()` happen atomically because there's no `await` between them. No other worker can touch the queue until the current one hits an await. Port this pattern to Go or Rust and you'd need a mutex around both operations, or a channel that serializes access. The interview signal: "this is safe *because of the runtime model*, not because of the data structure — I know the difference."

```
  Why JS makes this safe — the atomic block

  worker code:
    while (queue.length > 0) {   ← check
      const index = queue.shift();  ← modify
      ...
      await something();          ← ONLY here does another
                                    worker get a chance to run
    }
```

**Anchor:** "Safe here because JS runs the check-then-modify as one event-loop turn; in a real-threaded language this would need a lock."

## See also

  → `01-complexity-and-cost-models.md` — the O(n log n) vs O(n log K) math the top-K story rests on
  → `04-trees-tries-and-balanced-indexes.md` — where the binary heap's tree shape gets its full treatment
  → `06-sorting-searching-and-selection.md` — the sort at the other end of the top-K tradeoff
  → `study-runtime-systems` — where the event-loop atomicity story lives in full
