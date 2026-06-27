# Stacks, queues, deques, and heaps

**Industry name(s):** stack (LIFO), queue (FIFO), deque (double-ended queue), heap / priority queue (min-heap, max-heap, binary heap)
**Type:** Industry standard · Language-agnostic

> Four ordering disciplines built on top of arrays/linked lists. Stack = last-in-first-out. Queue = first-in-first-out. Deque = both ends, O(1). Heap = always-extract-the-min-or-max in O(log N). This codebase exercises one of them implicitly (the NDJSON buffer is shaped like a single-slot queue) and `not yet exercised` for the other three.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Of the four ordering disciplines in this chapter, this codebase exercises **one implicitly** and **three not at all**. The NDJSON reader's `buf` string (`lib/hooks/useInvestigation.ts` L184–L208) behaves like a one-element queue — bytes arrive, get framed into records, get dequeued for processing. There's no explicit `Queue` class, no `enqueue`/`dequeue` method, but the *discipline* is there: first byte in is the first byte processed. **Stacks, deques, and heaps are not yet exercised** — the codebase has no recursion deep enough to need a manual stack, no producer/consumer that needs both-end access, and no scheduling-by-priority logic. The four primitives still belong in this guide because they're the next things you reach for when a flat array stops being enough.

```
Zoom out — what this chapter teaches vs what the repo uses

┌─ UI band ────────────────────────────────────────────────┐
│  NDJSON reader: buf string                                │
│  ★ behaves like a 1-slot queue (FIFO by chunk arrival) ★ │  ← we are here
│    (implicit — no Queue class, just the buf invariant)    │
└────────────────────────────┬─────────────────────────────┘
                             │
┌─ Everywhere else ──────────▼─────────────────────────────┐
│  flat arrays, hash maps                                   │
│  • no stack (no manual recursion)                         │  ← not yet exercised
│  • no deque (no double-ended pipeline)                    │  ← not yet exercised
│  • no heap / priority queue (no priority scheduling)      │  ← not yet exercised
└──────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when do you stop treating an array as "just a list" and start picking an *ordering discipline* on top of it? The answer is when one of four constraints starts to matter: **stack** (you need to undo the most recent action — recursion call frames, undo/redo, backtracking); **queue** (you need to process items in arrival order — message queues, BFS frontiers, NDJSON chunks); **deque** (you need both ends — sliding-window algorithms, work-stealing schedulers); **heap** (you need the best item, repeatedly — Dijkstra's algorithm, top-K, event scheduling by ETA). The codebase has the *queue* constraint implicitly (chunks must be processed in arrival order to maintain framing). The other three constraints don't show up here — which is why you don't see those structures. The next sections walk all four kernels and pin the queue one to the NDJSON reader.

---

## Structure pass

**Layers.** Each ordering discipline has the same three-layer stack: the **abstract ordering rule** (LIFO / FIFO / both / by-priority), the **concrete implementation** (array with push/pop, array with push/shift, doubly-linked list, binary heap array), and the **observed cost** (push and pop in O(1) for stack/queue/deque if implemented right; insert and extract-min in O(log N) for heap). The abstract rule is what you pick when reasoning about the problem; the implementation is the cost-engineering that makes it cheap.

**Axis: control.** Who decides what comes out next? **Stack: the most recent push.** **Queue: the oldest insert.** **Deque: the caller, on each operation.** **Heap: the comparator** (the smallest by some ordering). Picking the wrong axis is the whole bug class — using a stack when you needed a queue (BFS becomes DFS, frontier behaves wrong) or a queue when you needed a heap (the "next job" is whatever inserted first, not whatever's most urgent).

**Seams.** Two seams matter; both load-bearing in the *abstract*, but only one is present in this codebase. **Seam 1 (load-bearing, present): "what determines extract order?"** — for the NDJSON reader, the answer is "arrival order" (FIFO), and that answer is what makes the framing correct. Use a stack here (LIFO) and the second chunk would get processed before the first, corrupting every multi-chunk record. **Seam 2 (load-bearing, absent): "do I extract by insertion order or by priority?"** — the codebase never makes this choice because it never has priority-extraction logic. If it did (say, processing anomalies by severity instead of by arrival), the choice would be heap.

```
Structure pass — stacks, queues, deques, heaps

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Abstract ordering rule · Concrete impl (array      │
│  push/pop, ring buffer, doubly-linked list, binary   │
│  heap) · Observed cost (mostly O(1) or O(log N))    │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  control: who decides what comes out next            │
│  (stack: latest, queue: oldest, deque: caller,      │
│   heap: comparator)                                  │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: extract order = arrival ★present (NDJSON buf)   │
│  S2: extract order = priority ☆absent                │
│      (would mean: heap; this codebase has no such    │
│       need yet)                                      │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

```
S1 seam — "which chunk gets processed first?" answered two ways

┌─ Queue (FIFO) ──────┐   seam      ┌─ Stack (LIFO) ─────────┐
│  bytes arrive,      │ ═════╪═════►│  bytes arrive,          │
│  framed in arrival  │  (it could │  framed in REVERSE      │
│  order              │   flip but │  arrival order          │
│                     │   doesn't) │                          │
│  → NDJSON works     │             │  → NDJSON corrupts      │
└─────────────────────┘             └─────────────────────────┘
        ▲                                       ▲
        └────── same axis (control), two answers ─┘
                → the queue discipline is the load-bearer; the codebase
                  chose right (implicitly)
```

The skeleton is mapped — the rest of this file walks all four kernels, and ends with an honest map of which are exercised.

---

## How it works

### Mental model

Four disciplines, four pictures.

```
   STACK (LIFO)               QUEUE (FIFO)
   ────────────               ────────────
        push                       push
         ↓                          ↓
   ┌───────────┐              ┌───────────┐
   │     D     │ ← top         │ A B C D   │
   │     C     │               │           │
   │     B     │              ─┘
   │     A     │
   └───────────┘              dequeue from the LEFT
   pop from the TOP            push to the RIGHT

   "the most recent push       "the oldest insert
    comes out first"            comes out first"

   DEQUE                       HEAP (min-heap)
   ────────────                ────────────
   push/pop both ends           min always at top
   ↕                            tree shape:
   ┌─────────────┐                    1
   │ A B C D E F │              ┌─────┴─────┐
   │             │              3           5
   └─────────────┘            ┌─┴─┐       ┌─┴─┐
   left      right            7   9      8   12

   "the caller decides         extract-min: O(log N)
    which end on each op"     insert:      O(log N)
                               (heapified up/down)
```

The four are *family* — all "extract one element, by some rule" — but the rule and the cost differ. Pick the discipline that matches the problem; the data structure follows.

### Move 1 — stack (LIFO)

A stack is the simplest ordering discipline: last in, first out. Push to the top, pop from the top, peek at the top. That's it.

```
push(x):    arr.push(x)     // O(1)
pop():      return arr.pop() // O(1)
peek():     return arr[arr.length - 1] // O(1)
isEmpty():  return arr.length === 0
size():     return arr.length
```

**Where stacks show up:**

- **Function call stack** — every recursive call pushes a frame; every return pops one. JavaScript's runtime does this for you; you don't see it until you blow it (stack overflow).
- **Undo/redo** — push every change onto an undo stack; pop on Ctrl-Z; push the inverse onto a redo stack.
- **Expression evaluation** — parsing `3 + 4 * (2 - 1)` uses a stack for operators and one for operands (the shunting-yard algorithm).
- **Iterative DFS** — replace the recursive call with an explicit `stack.push(child)` to avoid stack-overflow on deep graphs.

**In this codebase:** `not yet exercised`. There's no recursion deep enough to need a manual stack (the deepest recursion is `mkdir({recursive: true})` in `app/api/mcp/capture/route.ts`, which is in the standard library). There's no undo/redo. There's no expression evaluator. The closest thing is the JavaScript call stack itself, which doesn't count as the codebase exercising the structure — every program has that.

**What would trigger reaching for a stack here?** An interactive query builder that supports undo. A markdown export that needs to balance nested fences. A recursive walk of the schema deep enough to risk stack overflow (currently the schema is two levels deep, fine for runtime recursion).

**Code in this codebase — `not yet exercised`.** No file path. The trigger conditions: if the schema grew deep enough (10+ levels), runtime recursion could overflow and you'd convert to an explicit stack. If the UI added "undo last investigation" you'd push the previous state. If you wrote a query parser for the agent intent (`lib/agents/intent.ts`), the shunting-yard algorithm uses two stacks.

### Move 2 — queue (FIFO)

A queue is first in, first out. Enqueue at one end, dequeue from the other. The naive array implementation is `arr.push` to enqueue and `arr.shift` to dequeue — but `shift` is O(N) because it has to move every other element. The right implementations are a ring buffer (fixed-size array with a head pointer) or a doubly-linked list, both giving O(1) enqueue and dequeue.

```
enqueue(x):  arr.push(x)        // O(1)
dequeue():   return arr.shift() // O(N) ← naive; AVOID in hot paths
peek():      return arr[0]      // O(1)
size():      return arr.length

// proper O(1) dequeue requires:
//   - ring buffer (array + head index + tail index), OR
//   - linked list (head pointer + tail pointer)
```

**Where queues show up:**

- **BFS frontier** — the queue holds nodes to visit; dequeue oldest, enqueue children.
- **Message queues** — process events in arrival order (Kafka, RabbitMQ, Redis Streams).
- **Event loops** — JavaScript's task queue is FIFO; macrotasks are processed in insertion order.
- **Producer/consumer** — one thread produces, another consumes; the queue decouples them.
- **NDJSON streaming** — this codebase's implicit case (see below).

**In this codebase: applies implicitly.** The NDJSON reader's `buf` string (`lib/hooks/useInvestigation.ts` L184–L208) is a *single-slot* queue with a different shape: bytes arrive, get accumulated, get framed at delimiters, and the framed records are processed in arrival order. There's no `Queue` class; the queue discipline is *enforced by the loop structure*. Every chunk that arrives is appended to `buf` after the previous one. Every record extracted by `buf.split('\n')` is processed before the next chunk is read. The framing invariant *requires* FIFO — process the second chunk's records before the first chunk's and the multi-chunk record reconstruction breaks.

```
buf as an implicit FIFO queue (one-slot variant)
─────────────────────────────────────────────────

  network chunk 1 arrives    ──►  buf = "...partial"
                                   │ split + pop
                                   ▼
                              [complete records]  ──► processed FIRST
                              "partial"  ──► saved in buf

  network chunk 2 arrives    ──►  buf = "partial" + chunk2
                                   │ split + pop
                                   ▼
                              [more complete records]  ──► processed AFTER
                              "...partial"  ──► saved in buf

  FIFO discipline: chunk N's records always processed before chunk N+1's.
  No explicit queue, but the discipline is what makes it correct.
```

The "implicit queue" framing is honest: there's no data structure called `Queue` in the code, but the *behavior* is FIFO, and reasoning about it as a queue is what makes the framing invariant defensible.

**Code in this codebase — Queue (implicit FIFO): the NDJSON reader's `buf` (`lib/hooks/useInvestigation.ts` L184–L208).**

```ts
// lib/hooks/useInvestigation.ts L184–L208 (excerpt)
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });   // ← "enqueue" decoded bytes
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';                      // ← save trailing partial
  for (const line of lines) {                   // ← "dequeue" complete records
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line) as AgentEvent);
    } catch { /* ignore */ }
  }
}
```

The `buf` is not a `Queue<string>` — it's a `string`. But it *behaves* like a one-slot queue: bytes go in (appended), records come out (in arrival order), and the discipline is FIFO. The `for (const line of lines)` loop processes records in their arrival order; the saved `buf` between iterations is the queue's "next item to be completed." Walk through what breaks if the discipline were LIFO: chunk 2's records would be processed before chunk 1's tail, so a multi-chunk `tool_call_start` would either be missed or paired with the wrong `tool_call_end`. The reverse-scan reconciliation in `replaceRunningTool` (`useInvestigation.ts` L86–L95) assumes "the running tool I'm closing started before me in the items array" — that assumption depends on the queue discipline up the pipeline.

This is the codebase's only exercise of an ordering discipline beyond raw array order.

### Move 3 — deque (double-ended queue)

A deque (pronounced "deck") supports push and pop at *both* ends, all in O(1). It's the most flexible of the four — strictly more powerful than a stack or a queue. The implementation is usually a doubly-linked list, a circular buffer, or two stacks glued back-to-back.

```
pushFront(x):  // O(1)
pushBack(x):   // O(1)
popFront():    // O(1)
popBack():     // O(1)
```

**Where deques show up:**

- **Sliding window maximum** — the classic "find max in every K-element window" problem; the deque holds candidates for the current window max.
- **Work-stealing schedulers** — each worker has its own deque; pushes/pops its own end, steals from another worker's far end.
- **Browser history** — back goes one way, forward goes the other; new pages truncate the forward stack.
- **Palindrome check** — push all chars, then compare popFront vs popBack until they meet.

**In this codebase:** `not yet exercised`. There's no algorithm that needs both-end access. The NDJSON buffer is single-end (FIFO). The recommendation pipeline is single-direction (anomaly → diagnosis → recommendation, no back-and-forth).

**What would trigger reaching for a deque here?** A sliding-window analysis over the live monitoring stream — e.g. "max severity in the last 60 seconds" updated as events arrive. A back-and-forth UI like a swipeable insight carousel where prefetching happens on both ends.

**Code in this codebase — `not yet exercised`.** No file path. The canonical trigger: a "max severity in last N seconds" live indicator on the monitoring stream — the standard solution is a monotonic deque (push new values at the back, pop from the back while they're smaller than the new value, pop from the front when they fall out of the window). That's the canonical "sliding window max" pattern.

### Move 4 — heap (priority queue)

A heap is a *partially-ordered* binary tree where the parent is always ≤ (min-heap) or ≥ (max-heap) its children. The root is always the min (or max). Insert is O(log N); extract-min is O(log N). Peek at the min is O(1).

**Binary heap kernel:** stored as a flat array. For index `i`:
- Parent is at `(i - 1) / 2`
- Left child is at `2i + 1`
- Right child is at `2i + 2`

```
insert(x):
  arr.push(x)              // add to the end
  heapifyUp(arr.length-1)  // bubble up until parent ≤ x (min-heap)
                           // O(log N)

extractMin():
  min = arr[0]             // root is the min
  last = arr.pop()
  if arr.length > 0:
    arr[0] = last
    heapifyDown(0)         // sift down until arr[i] ≤ children
                           // O(log N)
  return min

peek():  return arr[0]    // O(1)
```

```
A min-heap (numbers smaller = higher priority):

  index:  0    1    2    3    4    5    6
  array: [1,   3,   5,   7,   9,   8,   12]

  drawn as a tree:
                 1                    ← root = min
            ┌────┴────┐
            3         5
          ┌─┴─┐     ┌─┴─┐
          7   9     8   12

  invariant: every node ≤ both children (min-heap)
  NOT sorted: 7 > 5 across siblings, that's OK
```

**Where heaps show up:**

- **Dijkstra's shortest path** — extract-min pops the node with the smallest tentative distance.
- **Top-K** — keep a min-heap of size K; for every new element, if it's bigger than the root, pop and push.
- **Event scheduling** — events sorted by ETA; extract-min always gives "what fires next."
- **Median maintenance** — two heaps (max-heap of lower half, min-heap of upper half) gives the running median.
- **Huffman coding** — build the optimal-prefix tree by repeatedly extracting the two smallest counts.

**In this codebase:** `not yet exercised`. The codebase never needs "the next-highest-priority thing." Anomalies are sorted *once* with `.sort()` (O(N log N) for a one-shot sort) and then `.slice(0, 10)` — that's all the prioritization needed. No streaming priority logic, no scheduling.

**What would trigger reaching for a heap here?** A live monitoring stream where you want to emit "top 5 most severe anomalies seen so far" in real time as new ones arrive. A retry scheduler that fires retries by their wake-up time. A job queue that processes diagnostic investigations in severity order.

**Code in this codebase — `not yet exercised`.** No file path. The anomaly sort (`lib/agents/monitoring.ts` L119) is `.sort()` + `.slice(0, 10)` — O(N log N) for a one-shot sort over N=30. A heap would be O(N + K log N) for top-K, which is marginally faster but completely irrelevant at this N. The user's own portfolio has `reincodes/BinaryHeap.ts` and `PriorityQueue.ts` from scratch, so the *implementation knowledge* exists; the *trigger* hasn't shown up in this codebase yet. The canonical trigger: top-K over a *stream* (anomalies arriving live, always show top 10) — the right data structure is a min-heap of size K, for each incoming item, if it's larger than the root, pop the root and push the item. That's O(log K) per item, O(K) space.

### Move 2 variant — the queue kernel (the one this codebase exercises)

Even though the queue is implicit here, name its kernel because the NDJSON reader's correctness depends on it.

```
QUEUE kernel
─────────────────────────────────
  enqueue (add at one end)
  dequeue (remove from the other end)
  FIFO discipline (enqueue order = dequeue order)
```

**Name each part by what breaks when missing (applied to NDJSON):**

```
Removed                       What breaks
──────────────────────────    ─────────────────────────────────────
FIFO discipline                Chunks processed out of arrival order;
                               multi-chunk records reassemble wrong.
                               Buffer's "trailing partial" assumption
                               (held in buf across iterations) collapses
                               because the "trailing" piece might come
                               from an earlier chunk than what's already
                               framed.

separate enqueue/dequeue       Without a clear "what's in the buffer
ends                           waiting" vs "what's been processed,"
                               you reprocess records or skip them.
                               The split/pop separation IS this seam.

bounded enqueue rate           Unbounded queue grows without limit if
(in general; not in NDJSON)    consumer is slower than producer. The
                               NDJSON buffer dodges this because the
                               network has its own backpressure, but
                               for a general queue this is the failure
                               mode you must guard against.
```

**Skeleton vs hardening:**

```
SKELETON (the queue kernel)        HARDENING
─────────────────────────────      ─────────────────────────────────
enqueue at one end                 bounded capacity (drop oldest /
dequeue at other end               reject newest on full)
FIFO discipline                    backpressure signal to producer
                                   priority extraction (becomes a heap)
                                   double-ended access (becomes a deque)
```

The NDJSON reader ships the kernel and one piece of accidental hardening (TCP-layer backpressure from the network).

### Move 3 — the principle

**Pick the ordering discipline that matches the problem, not the data structure.** Stack vs queue vs deque vs heap are *abstract specifications* — they describe what comes out and in what order. The concrete data structure (array, linked list, binary heap) is the engineering layer underneath. Reasoning at the abstract layer is what lets you say "I need a queue" before you've decided whether it's a ring buffer or a linked list.

---

## Primary diagram

All four ordering disciplines, with their kernel ops, cost, and the codebase's use (or lack of use).

```
                  THE FOUR ORDERING DISCIPLINES

  ┌────────────┬────────────────┬────────────────┬────────────────────┐
  │  STACK     │  QUEUE         │  DEQUE         │  HEAP / PQ         │
  │  (LIFO)    │  (FIFO)        │  (both ends)   │  (by priority)     │
  ├────────────┼────────────────┼────────────────┼────────────────────┤
  │ push  O(1) │ enqueue  O(1)  │ pushFront O(1) │ insert    O(log N) │
  │ pop   O(1) │ dequeue  O(1)* │ pushBack  O(1) │ extractMin O(log N)│
  │ peek  O(1) │ peek     O(1)  │ popFront  O(1) │ peek      O(1)     │
  │            │ *with ring     │ popBack   O(1) │                    │
  │            │  buffer/LL     │                │                    │
  ├────────────┼────────────────┼────────────────┼────────────────────┤
  │ extract:   │ extract:       │ extract:       │ extract:           │
  │ most       │ oldest         │ caller picks   │ smallest/largest   │
  │ recent     │ insert         │ end per call   │ by comparator      │
  │ push       │                │                │                    │
  ├────────────┼────────────────┼────────────────┼────────────────────┤
  │ in repo:   │ in repo:       │ in repo:       │ in repo:           │
  │ NOT YET    │ APPLIES        │ NOT YET        │ NOT YET            │
  │ EXERCISED  │ (implicit:     │ EXERCISED      │ EXERCISED          │
  │            │ NDJSON buf)    │                │                    │
  └────────────┴────────────────┴────────────────┴────────────────────┘

  trigger to start using:
  • stack: need to undo most recent action; iterative DFS
  • queue: need to process in arrival order; BFS frontier
  • deque: need both-end access; sliding window
  • heap:  need "the best one" repeatedly; Dijkstra; top-K stream
```

---

## Elaborate

### Where each comes from

**Stack** — fundamental to expression evaluation (Łukasiewicz, 1920s, reverse Polish notation); built into hardware as the function call stack since the late 1950s.

**Queue** — operations research origin (waiting lines, queuing theory, Erlang 1909). The data structure formalized for OS scheduling in the 1960s.

**Deque** — Knuth uses the term in TAOCP volume 1 (1968). The implementation as "two stacks glued back-to-back" comes from functional-programming research; the array-circular-buffer version is the standard imperative implementation.

**Heap** — invented by J. W. J. Williams (1964) for heapsort. The "binary heap = flat array with index arithmetic" trick is what makes it small enough to teach in one sitting.

### The deeper principle

**Every ordering discipline is a *contract about extraction*.** It tells you what comes out next without telling you how the inside is implemented. That separation is the value:

- A `Queue<T>` is anything that promises FIFO. It might be a `T[]` with `.shift` (bad, O(N) dequeue), a ring buffer (good), a linked list (good), or a distributed Kafka topic (fine, same contract).
- A `PriorityQueue<T>` is anything that promises "extract by lowest comparator value." Binary heap is one implementation; Fibonacci heap is another; a skip list is another. Same contract, different cost profiles.

When you reach for one of these, you're reaching for the *contract*. The data structure is the engineering follow-up.

### Where it breaks down

- **`Array.prototype.shift` is O(N).** Naively implementing a queue as an array with `.push`/`.shift` works correctly but degrades to O(N) per dequeue because every other element shifts down. For small N this is invisible; for N > ~1000 it dominates. The fix is a ring buffer (head pointer + tail pointer in a fixed array) or `Array<T>` with a separate head index that gets reset periodically.

- **Heaps are stable only by accident.** Unlike a stable sort, two items with the same priority will not necessarily come out in insertion order. If you need stability, append a sequence number to the priority key (`{priority: p, seq: n}` compared lexicographically).

- **Deques are easy to implement wrong.** The naive "circular buffer with head and tail indices" has off-by-one errors at the wrap-around. Most languages provide one in the standard library (`collections.deque` in Python, `ArrayDeque` in Java); JavaScript does not, which is why you usually just use an array with the understanding that one end is slow.

### What to explore next

- **Monotonic stacks and deques** — a specialized variant where you maintain an invariant (always increasing, always decreasing) by popping elements that violate it before pushing. The "next greater element" problem and "sliding window max" both use this.

- **Fibonacci heap** — a heap with O(1) amortized insert and decrease-key, used inside the *theoretically* fastest Dijkstra implementations. In practice the constants are bad and a binary heap usually wins, but the data structure is a beautiful exercise in amortized analysis.

- **Treaps and skip lists** — randomized balanced structures that get you O(log N) heap-like ops without the rigid binary-heap shape. Useful when you also need order-by-key, which a heap doesn't support.

- **Your own `reincodes/BinaryHeap.ts` and `PriorityQueue.ts`** — you've already built these from scratch. The trigger to use them in this codebase hasn't fired yet, but the implementations are sitting there.

---

## Interview defense

**What they are really asking.** Whether you can name the four ordering disciplines, name what each is good at, and *pick the right one for a scenario*. Senior signal: knowing that `Array.shift` is O(N) (so a "queue" built that way isn't really a queue at scale). Architect signal: explaining when to reach for a heap over a sorted array (when extracts are streamed, not batched).

---

**[mid] "What's the difference between a stack and a queue?"**

LIFO vs FIFO — the most recent push comes out of a stack first, the oldest insert comes out of a queue first. Both have O(1) push/pop if you implement them right. The picture: a stack is a vertical pile (push on top, pop from top); a queue is a horizontal line (push on the back, pop from the front). The interesting bit is what they enable: a stack lets you undo or recurse (the most recent context is on top); a queue lets you process in arrival order (the oldest is fairest).

```
  stack:   push 1, push 2, push 3, pop → 3
  queue:   enqueue 1, enqueue 2, enqueue 3, dequeue → 1
```

---

**[senior] "When would you use a heap instead of just sorting an array?"**

Two cases. First, when you're doing **top-K over a stream**: items arrive one at a time, and you always want the K smallest (or largest). A min-heap of size K is O(log K) per arrival; re-sorting is O(N log N) per arrival. For K small and N large the heap dominates. Second, when you need **repeated extract-min during a longer algorithm** — Dijkstra's pulls the next-shortest-tentative-distance node O(V) times; each pull is O(log V) with a heap. Sorting once doesn't help because the priorities update mid-algorithm.

```
  scenario                       sort an array     heap
  ─────────────────────────────  ────────────────  ─────────────
  one-shot "give me top 10"      O(N log N)        O(N + K log N) ≈ same
  streaming "always show top 10" O(N log N) per    O(log K) per item
                                  item — bad
  Dijkstra (V extracts, E ops)   doesn't work —    O((V+E) log V)
                                  priorities change
```

In this codebase, `lib/agents/monitoring.ts` L119 uses `.sort().slice(0,10)` — case 1, batched, N=30. A heap would be marginally faster but wouldn't change anything practical. The trigger for a heap would be if anomalies streamed in live and the UI had to always show top 10 as they arrived.

---

**[arch] "The NDJSON reader uses a string `buf` instead of a `Queue<Chunk>`. Why?"**

Because at the byte level there's no useful boundary between "chunks" until you've found a `\n`. A `Queue<Chunk>` would force you to either (a) reassemble across chunks before enqueueing (which is what the current code does inline) or (b) enqueue raw chunks and reassemble at dequeue (which adds latency and another buffer). The FIFO discipline is still load-bearing — `buf` is a *flat* queue of bytes waiting to be framed — but the right data structure for "bytes waiting to be framed" is a string with append + split + pop, not a `Queue<Chunk>`. The decision is "match the data structure to the unit of work": records, not chunks. Cite `lib/hooks/useInvestigation.ts` L184–L208.

```
  Queue<Chunk> (alternative)        string buf (current)
  ────────────────────────────      ──────────────────────
  unit: arbitrary chunk             unit: complete record
  reassembly: per dequeue           reassembly: inline at split
  framing: deferred                  framing: as records appear
  + ordered                          + ordered (implicit FIFO)
  - extra buffer + latency           - has to track partial state
                                      in buf
```

The current design is the right one for this problem; a Queue would be over-engineering.

---

**The dodge: "this codebase has no real ordering disciplines beyond raw arrays — is that a red flag?"**

No, and here's why. Ordering disciplines are a response to *constraints*: undo (stack), arrival-order processing (queue), both-end access (deque), priority extraction (heap). This codebase doesn't have those constraints — the pipeline is linear (anomaly → diagnosis → recommendation), the streaming is single-direction, there's no priority logic. Adding any of those structures preemptively would be ceremony without payoff. The right time to reach for them is when the constraint shows up; until then, raw arrays are the right answer. The skill is *recognizing the constraint when it arrives*. The four kernels in this chapter are what you reach for at that moment.

---

**Anchors (cite these in your answer)**

- `lib/hooks/useInvestigation.ts` L184–L208 — implicit FIFO queue (string buf)
- `lib/hooks/useInvestigation.ts` L86–L95 — `replaceRunningTool` reverse scan (depends on queue ordering up the pipeline)
- `lib/agents/monitoring.ts` L119 — `.sort().slice(0,10)` instead of a heap, justified by N=30 batched
- (No file path for stack/deque/heap — these are `not yet exercised`.)

---

## See also

→ `02-arrays-strings-and-hash-maps.md` (the primitives these are built from) · → `04-trees-tries-and-balanced-indexes.md` (heap is technically a tree-shaped structure; this chapter teaches the array-backed variant) · → `05-graphs-and-traversals.md` (BFS uses a queue, DFS uses a stack — both `not yet exercised` here) · → `.aipe/study-dsa-foundations/02-arrays-strings-and-hash-maps.md` (the full case study of the implicit queue)
