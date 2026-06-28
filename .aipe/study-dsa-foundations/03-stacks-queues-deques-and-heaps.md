# Stacks, queues, deques, and heaps

*Ordering disciplines and priority queues — Industry standard · Case B (heaps not exercised; sort+slice substitutes)*

## Zoom out — what ordering this repo actually has

```
  Ordering disciplines, where they live (and don't)
  ─────────────────────────────────────────────────

  ┌─ UI layer ─────────────────────────────────────┐
  │  insertion order via Map iteration (FIFO-ish)  │
  └────────────────────────┬───────────────────────┘
                           │
  ┌─ Service layer ────────▼───────────────────────┐
  │  ★ "top-K by severity" via SORT + SLICE        │
  │    lib/agents/monitoring-legacy.ts:136         │
  │  active tool-calls per name (FIFO shift)       │
  │    lib/agents/aptkit-adapters.ts:101,124       │
  └────────────────────────┬───────────────────────┘
                           │
  ┌─ NOT IN THIS REPO ─────▼───────────────────────┐
  │  no priority queue (no scheduler)              │
  │  no real stack (recursion is one level deep)   │
  │  no deque (no sliding window)                  │
  └────────────────────────────────────────────────┘
```

Verdict-first: this repo has **no priority queue, no
stack, no deque**. The one queue-like thing is a
`Map<string, ToolCall[]>` where `.push` / `.shift`
maintains FIFO order per tool name. The one "top-K"
operation in the codebase uses `sort + slice` instead
of a heap — a deliberate tradeoff for N ≤ 30.

So this file does two things:

1. Teach the *exercised* sliver: FIFO via array
   `push/shift`, and the sort+slice substitute for a
   heap.
2. Teach **heaps from fundamentals**, anchored to
   your `BinaryHeap.ts` / `PriorityQueue.ts` in the
   reincodes repo — so the missing primitive is still
   on the table.

## Structure pass — the four disciplines compared

Four primitives, one question held constant: *"which
element comes out next?"*

```
  One question, four answers
  ──────────────────────────

  "which element comes out next?"

  ┌─ Stack (LIFO) ─────────────┐  → the most recent
  │ push/pop at one end        │     pushed
  └────────────────────────────┘

  ┌─ Queue (FIFO) ─────────────┐  → the oldest
  │ enqueue at back, dequeue   │     in line
  │  at front                  │
  └────────────────────────────┘

  ┌─ Deque ────────────────────┐  → either end —
  │ push/pop at BOTH ends      │     "you choose"
  └────────────────────────────┘

  ┌─ Heap / Priority Queue ────┐  → the highest-priority
  │ insert anywhere, extract   │     element (not the oldest,
  │  by PRIORITY               │     not the newest)
  └────────────────────────────┘
```

The seam where these flip: **how `extract-next` is
defined**. Same shape (collection of elements, one
operation that takes one out), but the contract
shifts — and once it shifts, the underlying data
structure has to change. A queue can't answer "give
me the highest priority" in O(log N); for that you
need a heap.

Hand off to How it works.

## How it works

#### Move 1 — the mental model

You already use a stack every time you click "back"
in the browser. You already use a queue every time
you stand in a line. The third primitive — the heap —
is the one most engineers haven't built from scratch
once. The right anchor: **a heap is a "self-sorting
bin"** — you toss elements in any order, and the next
one out is always the smallest (min-heap) or largest
(max-heap), in O(log N).

```
  The four disciplines as shapes
  ──────────────────────────────

  STACK (LIFO)
    │
    │  push →  3 ─► [3]
    │  push →  7 ─► [3, 7]
    │  push →  1 ─► [3, 7, 1]
    │  pop  ←  1                ← last in, first out

  QUEUE (FIFO)
    │
    │  enq →   3 ─► [3]
    │  enq →   7 ─► [3, 7]
    │  enq →   1 ─► [3, 7, 1]
    │  deq ←   3                ← first in, first out

  HEAP (priority)
    │  insert 3 ─►       3
    │  insert 7 ─►      / \
    │                  3   7
    │  insert 1 ─►       1
    │                   / \         ← parent ≤ children
    │                  3   7              (min-heap)
    │  extract-min ← 1
```

The heap's "shape" is a *binary tree stored in an
array* — index 0 is root, index `2i+1` and `2i+2`
are children. The tree always stays balanced because
inserts fill left-to-right. **The break case if you
skip this:** if you used a sorted array, every insert
is O(N) (you shift everything to keep it sorted). The
heap trades "fully sorted" for "the min/max is always
findable" in exchange for O(log N) inserts.

#### Move 2 — the operations, anchored to your code

**FIFO via `Array.push` + `Array.shift` — the only
queue-like discipline in this repo**

```ts
// lib/agents/aptkit-adapters.ts:101
private readonly activeToolCalls = new Map<string, ToolCall[]>();
// ...:114-119  (a tool_call_start event)
const existing = this.activeToolCalls.get(event.toolName) ?? [];
existing.push(toolCall);                              // ← enqueue at back
this.activeToolCalls.set(event.toolName, existing);
// ...:123-124  (a tool_call_end event)
const toolCall = this.activeToolCalls.get(event.toolName)?.shift()
  ?? this.toBloomingToolCall(event);                  // ← dequeue at front
```

This is a real FIFO use-case: the agent may have
multiple in-flight calls to the same tool name, and
the result events have to be matched to the *oldest
unmatched start event*. `push` + `shift` gives that
in two lines.

```
  FIFO trace — two parallel calls to the same tool
  ────────────────────────────────────────────────

  state                          event
  ─────                          ─────
  []                             tool_call_start  toolA  (#1)
  [#1]                           tool_call_start  toolA  (#2)
  [#1, #2]                       tool_call_end    toolA  ← matches #1
  [#2]                            (toolCall.result = first end's payload)
  [#2]                           tool_call_end    toolA  ← matches #2
  []
```

The honest call-out: `Array.prototype.shift` is
**O(N)** in JavaScript (it re-indexes everything).
For tiny arrays (≤ 5 in-flight calls per tool) this
is fine; for a real production queue with thousands
of items, you'd use a linked list or a circular
buffer. This repo's N is bounded by parallelism per
agent step, which is small.

**Top-K via `sort + slice` — the heap substitute**

This is the one place a heap would classically live,
and the repo deliberately doesn't reach for it:

```ts
// lib/agents/monitoring-legacy.ts:136
return [...parsed]
  .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
  .slice(0, 10);
```

The classical heap-of-size-K algorithm for "top-K
from N items":

```
  Top-K via min-heap of size K
  ────────────────────────────

  PSEUDOCODE                              cost
  ──────────                              ────
  let heap = MinHeap()                    O(1)
  for each item in input:                 ┐
    if heap.size < K:                     │
      heap.insert(item)                   │ N iterations,
    elif item > heap.peek():              │ each O(log K)
      heap.extractMin()                   │
      heap.insert(item)                   │ → O(N log K)
  return heap.toArray().sort()            ┘

  vs. sort+slice:                         O(N log N)
```

The verdict: **for N = 10–30 and K = 10, sort+slice
wins on constant factors and reads in one line.** If
N grew to thousands, or this became a streaming top-K
(can't see all of N at once), the heap would win.
That decision is recorded in the cost-model file.

You've actually *built* the heap version. Anchor to
the reincodes repo:

```ts
// reincodes — BinaryHeap.ts
class MinHeap {
  insert(value): void          // O(log N) — heapifyUp
  getMin(): T                  // O(1)     — root is min
  extractMin(): T              // O(log N) — heapifyDown
}

// reincodes — PriorityQueue.ts
class PriorityQueue {
  enqueue(value, priority)     // O(log N) via heap.insert
  dequeue()                    // O(log N) via heap.extractMin
  updatePriority(value, p)     // O(log N) via value→index lookup
}                              //          (the index Map is the key
                               //           insight — without it
                               //           updatePriority is O(N))
```

**The load-bearing skeleton — heap's irreducible
kernel:**

1. **Array-backed tree** — parent at `i`, children at
   `2i+1` and `2i+2`. Without this, you'd need real
   pointers and you'd pay O(N) per operation chasing
   them.

2. **Heap invariant** — parent ≤ both children
   (min-heap) or parent ≥ both (max-heap). **What
   breaks without it:** the root is no longer
   guaranteed to be min/max, so `getMin` lies.

3. **heapifyUp on insert** — after appending at end,
   swap with parent until the invariant holds. **What
   breaks without it:** a new small element stays at
   the bottom and the invariant is violated.

4. **heapifyDown on extract** — after replacing root
   with the last element, swap with the smaller child
   until the invariant holds. **What breaks without
   it:** the new root is wrong (it was the last
   element, probably not the next-smallest).

5. **value→index Map (PriorityQueue only)** — when
   you support `updatePriority(value, newP)`, you
   need O(1) lookup of *where* that value lives in the
   heap. Without it, `updatePriority` is O(N) scan
   then O(log N) sift — defeating the purpose.

```
  Heap operation traces — three inserts then one extract
  ──────────────────────────────────────────────────────

  insert 7:    [7]
                ▲
                └ no parent, done

  insert 3:    [7, 3]
                ▲   ▲
                │   └ parent is 7; 3 < 7 → swap
                ▼
               [3, 7]

  insert 5:    [3, 7, 5]
                       ▲
                       └ parent is 3; 5 > 3 → done

  extractMin: pop 3, move last to root
               [5, 7]                ← 5 was at index 2
                ▲
                └ heapifyDown: 5 < 7, done
              → returns 3
```

#### Move 2.5 — when this repo *would* grow a heap

The honest line: if blooming-insights started
*streaming* anomalies from multiple agents in parallel
and you couldn't see the full set before emitting
top-10, the sort+slice would have to become a heap.
Specifically: if the `MonitoringAgent.scan` returned
an async iterator instead of an array, you'd hold a
min-heap of size K and pop the smallest as each new
candidate arrives. That refactor is not on the
roadmap; the *recognition* of when to do it is.

#### Move 3 — the principle

The four disciplines (stack, queue, deque, heap) all
answer the same question — "which element comes out
next?" — with different contracts. Pick the
discipline by the contract: most recent (stack),
oldest (queue), either-end (deque), highest priority
(heap). The data structure follows from the choice.
And if N is tiny, *no* data structure beats `sort +
slice` for readability; if N is large or streaming,
*only* the heap gives you the right asymptotic.

## Primary diagram

```
  The four disciplines — pick by contract, then by N
  ──────────────────────────────────────────────────

  ┌────────────────────────────────────────────────────────────┐
  │ contract                  data structure        cost       │
  ├────────────────────────────────────────────────────────────┤
  │ "most recent out"         Array.push/pop        O(1)       │
  │ "oldest out"              Array.push/shift      O(N) shift │
  │                           (or linked list)      O(1) both  │
  │ "either end out"          Deque                 O(1) both  │
  │ "highest priority out"    BinaryHeap            O(log N)   │
  │                                                            │
  │ "top-K from a small N"    Array.sort.slice      O(N log N) │
  │                            ← simpler, wins for N small     │
  │                                                            │
  │ "top-K from a large/      Min-heap of size K    O(N log K) │
  │  streaming N"              ← only option for stream        │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Stacks come from compiler/interpreter design — the
call stack is itself a stack of frames, and recursion
is just "let the language manage the stack for you."
Queues come from scheduling — operating systems run
ready-to-execute processes as FIFO (in their
simplest form). Heaps were invented for heapsort
(Williams, 1964) and immediately found use in
Dijkstra's shortest-path algorithm — which is
exactly what you implemented in reincodes.

The most common interview confusion: "priority
queue" is the abstract type, "binary heap" is the
implementation. Other implementations exist (Fibonacci
heap, pairing heap, leftist tree) with better
asymptotic constants on `decrease-key`, but in
practice every working priority queue you'll write is
backed by a binary heap.

The deque shows up in two real production places:
sliding-window algorithms (max in a window — keep
indices in a monotone deque) and double-ended caches
(LRU done with a hash map + doubly-linked list).
Neither is exercised here, but both belong in your
practice plan.

For deep grounding: CLRS Chapter 6 (heapsort and
priority queues), and Sedgewick *Algorithms 4th Ed*
§2.4 (priority queues).

## Interview defense

**Q: Why don't you use a priority queue for the
monitoring agent's top-10?**

```
  The decision — when sort+slice beats a heap
  ───────────────────────────────────────────

  sort+slice          heap of size K
  ──────────          ──────────────
  O(N log N)          O(N log K)
  1 line              ~30 lines (BinaryHeap class)
  wins N ≤ 30         wins N >> K, streaming N
  WHAT WE SHIP        WHAT I'D SWITCH TO IF N GREW
```

Model answer: "The LLM returns 10-30 anomalies. At
that N, the constant factors of TimSort dominate the
log K savings of a heap-of-size-K, and the one-liner
is honest about what it's doing. The heap version
only wins when N grows to thousands, or when I can't
see all of N at once — like if scan became a stream
of anomalies. I've built the heap from scratch in
reincodes (BinaryHeap.ts, PriorityQueue.ts with the
value→index Map for updatePriority); the recognition
that this repo doesn't need it is part of the
tradeoff." Anchor: `lib/agents/monitoring-legacy.ts:136`.

**Q: Name a load-bearing piece of a heap most people
forget.**

Model answer: "Two of them. First, `heapifyDown` on
extract — after you remove the root, you replace it
with the *last* element of the array and sift down.
People remember `heapifyUp` for insert and forget
that extract has its own sift-down. Second, the
value→index Map inside PriorityQueue. Without it,
`updatePriority(value, newP)` is O(N) to find the
value, defeating the heap's purpose. The Map keeps
it O(log N). Skip either and the heap is broken or
slow. Anchors in reincodes: `BinaryHeap.ts`
`PriorityQueue.ts`."

**Q: Where do you use a FIFO in blooming-insights?**

Model answer: "One place: `activeToolCalls:
Map<string, ToolCall[]>` in the AptKit trace
adapter. The agent may have multiple in-flight calls
to the same tool name, and the `tool_call_end` event
has to match the *oldest unmatched start*. So I
`push` on start, `shift` on end. `shift` is O(N) in
JavaScript because the array re-indexes — for N ≤ 5
parallel calls per tool, that's invisible; for a
real production queue I'd use a linked list or a
ring buffer. Anchor: `lib/agents/aptkit-adapters.ts:101,124`."

**Q: What's a deque, and where would you use one?**

Model answer: "A deque (double-ended queue) is push/
pop at both ends, both O(1). The canonical use is
the sliding-window maximum problem: keep a deque of
*indices* in decreasing order of their values, pop
the front when it falls out of the window, pop the
back while it's smaller than the new element. Result
front is always the window's max. The repo doesn't
exercise it — but it's the right shape for any
'rolling max/min over a moving window' problem, which
shows up in rate-limiting and anomaly detection. On
my practice list."

## See also

- `01-complexity-and-cost-models.md` — the
  sort+slice vs heap cost tradeoff worked end-to-end
- `02-arrays-strings-and-hash-maps.md` — `Map<key,
  T[]>` as the queue-per-key pattern
- `06-sorting-searching-and-selection.md` — why
  comparator-based sort is good enough here
- `08-dsa-foundations-practice-map.md` — deque
  (sliding window) is on the practice plan
