# Stacks, queues, deques, and heaps

Industry names: LIFO stack, FIFO queue, double-ended queue, priority queue / binary heap. Type: Industry standard.

## Zoom out — one live queue, zero heaps

There's exactly one place in this repo where a queue is load-bearing: the load-eval worker pool at `eval/load.eval.ts:171-211`. That's the anchor for this whole chapter. Stacks, deques, and heaps are all `not yet exercised` — but one of them (a binary heap for top-K selection) would be the right upgrade for `monitoring-legacy.ts:136`, so we'll teach the primitive against that as a "what would fit."

```
  Where ordering disciplines show up

  ┌─ Service layer ─────────────────────────────────┐
  │  monitoring: sort + slice(10) as pseudo-heap    │  ← where a heap would fit
  │  (not yet exercised: real priority queue)       │
  └────────────────────┬────────────────────────────┘
                       │
  ┌─ Eval layer ───────▼────────────────────────────┐
  │  load harness: index queue + K workers          │  ← the live queue
  │  ★ THIS IS THE LOAD-BEARING SPOT ★              │
  └─────────────────────────────────────────────────┘

  not yet exercised: LIFO stack (agent loop is not a stack)
  not yet exercised: deque (no double-ended access)
  not yet exercised: binary heap / priority queue
```

## Structure pass — trace *ordering discipline* across the container types

Axis: **what does this container promise about pull order?**

- **Stack** (LIFO): last in, first out. Answer: "the most recent thing."
- **Queue** (FIFO): first in, first out. Answer: "the oldest waiting thing."
- **Deque**: both ends. Answer: "either end, your choice."
- **Priority queue / heap**: highest priority first. Answer: "whichever thing scored highest."

The seam is the answer to the question "what should come out next?" That's the axis every ordered container disagrees about. If you can name which discipline you need, you've picked the container.

In this repo, only FIFO is used — and even that with the caveat that `queue.shift()` on an Array is O(n), not the O(1) a real queue would give you.

## How it works — the worker pool + the missing heap

### Move 1 — the queue kernel

You already know the shape from a coffee line: things arrive at the back, get served from the front, and the counter doesn't care what any customer wants until it's their turn.

```
  FIFO queue kernel

     enqueue ──►  [ a │ b │ c │ d ]  ──► dequeue
                   ↑                  ↑
                   tail (add here)    head (remove here)

  what makes it a queue: adding at one end, removing at the other
  what breaks it       : mid-container access (that's a list, not a queue)
```

The load-bearing invariant: **workers pulling from the queue are guaranteed to see each item exactly once, without coordinating with each other.** In a multi-threaded runtime you'd need a lock. In JavaScript, the single-threaded event loop is the lock — `queue.shift()` is atomic because nothing else can run until it returns.

### Move 2 — the load harness (worker pool)

**Semaphore-style concurrency with an index queue** — `eval/load.eval.ts:171-211`.

The load harness runs N investigations at concurrency K. The idea: build a queue of indices, spawn K worker functions, let each worker pull-and-process until the queue is empty. Errors in one worker don't stop the others.

```
  Worker-pool pattern (K=3, N=8)

  queue:  [0, 1, 2, 3, 4, 5, 6, 7]        ← shared index queue

  workers:  ┌─ w0 ─┐   ┌─ w1 ─┐   ┌─ w2 ─┐
            │ pull │   │ pull │   │ pull │   ← each pulls one at a time
            └──┬───┘   └──┬───┘   └──┬───┘
               │          │          │
              [0]        [1]        [2]     ← concurrent (network-bound)
               │          │          │
              done       done       done
               │          │          │
               ▼          ▼          ▼
              [3]        [4]        [5]     ← next pulls
               │          │          │
              done       fails      done    ← w1's failure doesn't stop w0/w2
               │                     │
               ▼                     ▼
              [6]                   [7]
               │                     │
              done                  done

  termination: every worker loop exits when queue.length === 0
```

Real code, side by side:

```ts
// eval/load.eval.ts:171-211
const indices = Array.from({ length: LOAD_N }, (_, i) => i);
const queue = [...indices];                       // ← the FIFO queue

async function worker(workerId: number): Promise<void> {
  while (queue.length > 0) {                      // ← loop until empty
    const index = queue.shift();                  // ← dequeue (O(n) — see note)
    if (index == null) return;                    // ← guard: another worker won the race
    const caseIdx = index % goldens.length;
    const golden = goldens[caseIdx];
    const started = performance.now();
    try {
      const inv = await runOneInvestigation(...);  // ← the network-bound work
      results.push(inv);
    } catch (err) {
      // ← per-item try/catch: failures don't stop other workers
      results.push({ index, ...errorShape });
    }
  }
}

const workers = Array.from({ length: LOAD_CONCURRENCY }, (_, i) => worker(i));
await Promise.all(workers);                       // ← wait for all K to drain the queue
```

**Load-bearing parts, by what breaks if you remove them:**

1. **`while (queue.length > 0)` loop.** Drop it and each worker processes exactly one item then exits — total throughput = K items, not N.
2. **`queue.shift()` returning `undefined` on empty.** With the `if (index == null) return;` guard, this handles the case where two workers both saw `queue.length > 0` but the other one shifted first. Without it, one worker would try to process `undefined`.
3. **The per-item `try/catch`.** Without it, one thrown error would reject the worker's promise, and while `Promise.all` would fail-fast, the other running workers would keep going — but any *later* items in the queue would never be picked up because the failed worker never returns to its loop.

**The single-threaded event loop is the lock.** This works without a mutex because JavaScript can't interleave synchronous code. `queue.shift()` runs to completion before any other JS runs. The moment you `await`, other workers get a turn — but they can't corrupt each other's local state, only the shared queue, and the queue is only touched at synchronous shift/length points.

**The O(n) shift trap.** `Array.prototype.shift()` on a JS array is O(n) — it re-indexes every remaining element. At N=20, K=3, that's fine. At N=100_000 it isn't; you'd want a real queue (linked list, or head-pointer + never-shrink array). Flag it and move on:

```
  Cost of dequeue

  Array.shift()      O(n)   ← current, fine at N ≤ ~10k
  linked-list shift  O(1)
  ring buffer        O(1)   ← preferred at scale
```

### Move 2 (continued) — where a heap would fit

**`not yet exercised`: binary heap / priority queue.**

The load-bearing example the repo *doesn't* build is a top-K selection. Look at `lib/agents/monitoring-legacy.ts:136`:

```ts
// lib/agents/monitoring-legacy.ts:136
return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
```

Sort everything, take the first 10. Cost: O(n log n). At n=50 that's ~280 ops. If the anomaly count ever grew (imagine n=50_000), sort would still cost ~780_000 ops — but a real top-K would be O(n log 10) ≈ 170_000 ops. Order of magnitude.

Kernel of a binary heap (max-heap, for "highest severity first"):

```
  Binary heap — a complete binary tree stored as an array

       [ 9 ]                         array: [9, 7, 8, 3, 6, 5, 4]
       /   \                          index:  0  1  2  3  4  5  6
     [7]   [8]
     / \   / \                       parent(i)  = floor((i-1)/2)
   [3][6][5][4]                      leftChild  = 2i + 1
                                     rightChild = 2i + 2

  invariant: every parent ≥ its children (max-heap)

  push(x):  append x at the end; "sift up" — swap with parent while larger
            → O(log n)

  pop():    take root; move last element to root; "sift down" — swap with
            larger child while smaller → O(log n)

  peek():   read root → O(1)
```

Pseudocode for top-K with a min-heap of size K (the canonical form — hold the K largest by maintaining a min-heap and pushing/popping):

```
  topK(items, K):
    heap = empty min-heap
    for item in items:                       // O(n)
      if heap.size < K:
        heap.push(item)                       // O(log K)
      else if item > heap.peek():
        heap.pop()                            // O(log K)
        heap.push(item)                       // O(log K)
    return heap.toSortedArray()               // O(K log K)

  total: O(n log K + K log K)  =  O(n log K)
```

Contrast: current sort-and-slice is `O(n log n)`. At K=10 fixed and large n, top-K wins hard. The repo doesn't yet need this, but flag it for future maintainers if n ever grows.

### Move 3 — the principle

Ordering discipline is a contract, not a container. Ask "what should come out next?" — the answer picks the primitive. FIFO for fair scheduling (load harness), LIFO for depth-first backtracking (not present), priority order for top-K under budget (the missing heap). The load-bearing skill is not knowing how heaps work — it's recognizing "top-K under a budget" as the shape when it walks past you.

## Primary diagram — ordering disciplines and where they live

```
  Four containers, one axis: "what comes out next?"

  ┌─ Stack (LIFO) ──────────────┐   NOT YET EXERCISED
  │  push → [a][b][c]           │   would fit: DFS, backtracking
  │  pop  ← last-in             │   ("agent loop" is NOT a stack —
  └─────────────────────────────┘    it's a linear iteration)

  ┌─ Queue (FIFO) ──────────────┐   LIVE: load harness
  │  [a][b][c] ← enqueue at end │
  │  dequeue front → a          │   file: eval/load.eval.ts:171-211
  │                             │   cost: O(n) shift on Array
  └─────────────────────────────┘   fix at scale: linked list / ring buffer

  ┌─ Deque ─────────────────────┐   NOT YET EXERCISED
  │  add/remove either end      │   would fit: sliding window
  └─────────────────────────────┘

  ┌─ Heap / priority queue ─────┐   NOT YET EXERCISED
  │  root = highest priority    │   would fit: top-K severity anomalies
  │  O(log n) push, O(log n) pop│   (currently sort-and-slice at
  │  O(1) peek                  │    monitoring-legacy.ts:136)
  └─────────────────────────────┘
```

## Elaborate

The worker-pool pattern shows up under many names — **thread pool** (Java), **executor** (Rust), **goroutine pool** (Go). In JavaScript it looks minimal because the runtime does the scheduling for you: no locks, no threads, just an event loop and a shared array. The tradeoff is that the pool is bounded by *your* concurrency limit, not the CPU's — you're managing outbound network calls, not compute parallelism.

Binary heaps were invented by J.W.J. Williams in 1964 for heapsort. The array-as-implicit-tree trick (parent at `(i-1)/2`) is the elegant part — you get O(log n) push/pop without any pointers. For interviews, learn **heapify in O(n)** (build a heap from an unsorted array by sift-down from the middle inward — subtler than the O(n log n) push-each-one approach). And know **Fibonacci heaps** exist even if you'll never implement one — they get O(1) amortized push and are the reason Dijkstra's algorithm is O(E + V log V) instead of O(E log V).

The deque story that isn't in this codebase but is a classic interview shape: **sliding window maximum in O(n) with a monotonic deque.** Worth practicing.

## Interview defense

**Q: Walk me through the load harness's concurrency model.**

Answer: It's a semaphore-style worker pool over a shared FIFO index queue. Build `queue = [0, 1, ... N-1]`, spawn K worker functions, each worker loops `while (queue.length > 0)` and pulls with `queue.shift()`. Wrap the work in per-item try/catch so one investigation's failure doesn't stop the others. `Promise.all(workers)` waits for all K workers to drain the queue.

The single-threaded event loop is the lock — `queue.shift()` runs atomically because JavaScript can't interleave synchronous code. The `if (index == null) return;` guard handles the race where two workers both saw `queue.length > 0` but only one won the shift.

```
  Worker pool — atomicity from the event loop

  worker 0:  check length → shift → await work ─────────►
  worker 1:  check length → shift → await work ───►
  worker 2:  check length → shift → await work ─────►

  ← synchronous check-and-shift never interleaves
  ← the moment you await, other workers get a turn
```

Anchor: `eval/load.eval.ts:171-211`.

**Q: What's the cost of `queue.shift()` here, and when does it matter?**

Answer: O(n). `Array.prototype.shift()` re-indexes every remaining element. At the current N=20 with K=3, that's ~200 element moves total over the whole run — invisible. At N=100_000 it'd be quadratic total work, ~5 billion moves. The fix at scale is a real queue: a linked list gives O(1) shift, or a ring buffer with head/tail pointers.

Anchor: `eval/load.eval.ts:176`.

**Q: Where in this repo would a binary heap fit better than what's there today?**

Answer: `lib/agents/monitoring-legacy.ts:136` does `sort + slice(10)` for top-severity anomalies — O(n log n). A min-heap of size K would give O(n log K), which is asymptotically better once K stays fixed at 10 and n grows. Today n is `~50` so the difference is invisible; if the anomaly count ever grew to thousands, swapping to a bounded heap would be the right move. The kernel is push-if-heap.size<K, else if item > heap.peek() pop-and-push.

```
  Top-K by heap

  n items ──► heap of size K (K << n) ──► K largest
       O(log K) per push/pop, O(n log K) total
       vs. sort's O(n log n)
```

Anchor: `lib/agents/monitoring-legacy.ts:136`.

## See also

- `02-arrays-strings-and-hash-maps.md` — the results Array that receives worker output.
- `06-sorting-searching-and-selection.md` — the sort-and-slice that a heap would replace.
- `.aipe/study-runtime-systems/` — the event-loop as implicit lock.
- `.aipe/study-distributed-systems/` — worker pools generalize to real distributed queues.
