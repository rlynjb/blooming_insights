# Stacks, Queues, Deques, and Heaps

Stack (LIFO) · queue (FIFO) · deque · heap (priority queue) — Industry standard

## Zoom out — where this concept lives

In `blooming_insights`, exactly one of these four is genuinely exercised — a queue, per tool name, inside the trace-sink adapter. Stacks and deques don't show up; the heap (priority queue) doesn't show up either, even though the top-K anomaly ranking is one of its textbook use cases. The diagram marks where the one real queue lives.

```
  Zoom out — ordering disciplines across the system

  ┌─ UI (browser) ─────────────────────────────────────────────────┐
  │  (no stack / queue / deque / heap exercised)                    │
  │  the ReasoningTrace renders an array in arrival order — that's │
  │  array iteration, not a queue                                   │
  └────────────────────────────────────────────────────────────────┘
                          ▼
  ┌─ Service (Next API) ───────────────────────────────────────────┐
  │  ★ queue (FIFO array used push+shift) ★                         │   ← the one
  │  activeToolCalls: Map<toolName, ToolCall[]>                     │
  │  pairs tool_call_start ↔ tool_call_end per tool                 │
  │                                                                 │
  │  top-K anomaly ranking — uses sort+slice (file 06),             │
  │  NOT a heap; n is small enough that the gap is academic         │
  └────────────────────────────────────────────────────────────────┘
                          ▼
  ┌─ Storage (Bloomreach) ─────────────────────────────────────────┐
  │  (opaque server-side)                                           │
  └────────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

A stack answers "who's last in?" (LIFO), a queue answers "who's first in?" (FIFO), a deque answers both, and a heap answers "who's smallest (or largest)?" The four are all linear-ish structures distinguished by **which end you're allowed to touch**.

`blooming_insights` uses one queue, naturally, because the AptKit trace sink emits a `tool_call_start` *event*, then later a `tool_call_end` *event*, and the adapter needs to pair them in order. The other three structures are not yet exercised. They are the next things to drill — heaps especially, because the top-K pattern is unavoidable once `n` grows and DSA interviews ask for it constantly.

## Structure pass — layers · axes · seams

One axis traced: **which end of the structure are you allowed to add to or remove from?**

```
  one axis — "which ends can you touch?"

  stack (LIFO)        ┌────────────────┐
                      │  push    pop   │
                      │   ↓      ↑     │     one end, both ops
                      │  ┌──────────┐  │
                      │  │  ████████│  │
                      │  └──────────┘  │
                      └────────────────┘

  queue (FIFO)        ┌────────────────┐
                      │ enqueue  dequeue│
                      │   ↓        ↑   │     two ends, one each
                      │  ┌──────────┐  │
                      │  │████████  │  │
                      │  └──────────┘  │
                      └────────────────┘

  deque              ┌────────────────┐
                      │ push  pop      │
                      │  ↓    ↑        │     two ends, both ops each
                      │  ┌──────────┐  │
                      │  │████████  │  │
                      │  └──────────┘  │
                      │       ↑    ↓   │
                      │      pop  push │
                      └────────────────┘

  heap (priority Q)   ┌────────────────┐
                      │ insert  pop-min │
                      │   ↓       ↑    │     ordered access by priority,
                      │  ┌──────────┐  │     internal tree shape (file 04)
                      │  │   ▲      │  │
                      │  │  ▲ ▲     │  │
                      │  └──────────┘  │
                      └────────────────┘
```

- **layers**: same UI / service / storage three. The discipline lives at the service layer.
- **axis**: which end you touch. Flips between stack, queue, deque.
- **seam**: the contract on the structure — if a caller pushes and pops at the same end, you've got a stack; if they push one end and pop the other, that's a queue. The implementation underneath might be the same array; the discipline is what makes it one or the other.

## How it works

### Move 1 — the mental model

A queue is a line at a coffee shop: people join at the back, leave at the front, **first-in-first-out**. A stack is a stack of plates: you put on top, take from top, **last-in-first-out**. A deque is a hallway with two doors. A heap is a doctor's triage queue: the order you arrived doesn't matter; the most critical patient goes first.

In code, the cheap implementations:

```
  the four structures, JS-flavored

  stack:   const s = [];  s.push(x);   s.pop();          // O(1) both
  queue:   const q = [];  q.push(x);   q.shift();        // O(1) push, O(n) shift!
  deque:   const d = [];  d.push/pop/unshift/shift        // shift/unshift are O(n) in JS arrays
  heap:    hand-rolled tree-in-array, or use a library    // O(log n) insert + pop-min
```

The JS-specific gotcha: `Array.prototype.shift` is O(n) (it re-indexes the whole array). For small queues, this doesn't matter and is what the codebase uses. For large hot queues, you reach for a real deque implementation (a linked list, or a circular buffer, or a two-stack trick).

### Move 2 — the moving parts

#### the queue you do have — `activeToolCalls`

The AptKit trace sink converts two events into a `ToolCall` pairing: a `tool_call_start` (which carries the args) and a `tool_call_end` (which carries `durationMs`, `result`, `error`). The pairing needs FIFO discipline because two simultaneous calls of the same tool need to pair start1↔end1 and start2↔end2, not crossed.

```ts
// lib/agents/aptkit-adapters.ts:101 + 114-129
private readonly activeToolCalls = new Map<string, ToolCall[]>();

emit(event: CapabilityEvent): void {
  if (event.type === 'step') {
    this.hooks.onText?.(event.content);
    return;
  }

  if (event.type === 'tool_call_start') {
    const toolCall = this.toBloomingToolCall(event);
    const existing = this.activeToolCalls.get(event.toolName) ?? [];
    existing.push(toolCall);                                  // enqueue at back
    this.activeToolCalls.set(event.toolName, existing);
    this.hooks.onToolCall?.(toolCall);
    return;
  }

  if (event.type === 'tool_call_end') {
    const toolCall = this.activeToolCalls.get(event.toolName)?.shift()  // dequeue at front
      ?? this.toBloomingToolCall(event);
    toolCall.durationMs = event.durationMs;
    toolCall.result = event.result;
    toolCall.error = event.error;
    this.hooks.onToolResult?.(toolCall);
  }
}
```

Read line by line:

- **`new Map<string, ToolCall[]>()`** — a Map of queues, keyed on tool name. Each tool name gets its own FIFO lane.
- **`existing.push(toolCall)`** — enqueue. The new in-flight call goes at the back of the per-tool queue.
- **`activeToolCalls.get(event.toolName)?.shift()`** — dequeue. Pull the oldest in-flight call (the front), pair the end event's `durationMs`/`result`/`error` onto it.
- **`?? this.toBloomingToolCall(event)`** — the fallback if no start was queued (shouldn't happen, defensive). This is the contract: an end without a start synthesizes a bare ToolCall from the end event's data.

What breaks without per-tool lanes: imagine `execute_analytics_eql` and `get_overview` both in flight. If they shared one global queue, the order of `_end` events (which can interleave based on server response time) would pair them wrong — `get_overview_end` might pop the `execute_analytics_eql_start` because it arrived first. The Map gives each tool name its own queue, so end events only pop from the same-name lane.

```
  execution trace — two interleaved calls, same tool

  state:  activeToolCalls = {}

  EVENT  tool_call_start eql                                          (call_id=1)
  →  activeToolCalls = { eql: [tc1] }

  EVENT  tool_call_start eql                                          (call_id=2)
  →  activeToolCalls = { eql: [tc1, tc2] }

  EVENT  tool_call_end   eql   (call_id=1, ms=2300)
  →  shift() = tc1
  →  activeToolCalls = { eql: [tc2] }
  →  tc1.durationMs = 2300; onToolResult(tc1)

  EVENT  tool_call_end   eql   (call_id=2, ms=4100)
  →  shift() = tc2
  →  activeToolCalls = { eql: [] }
  →  tc2.durationMs = 4100; onToolResult(tc2)

  FIFO holds — call 1 paired with the first end, call 2 with the second
```

Bridge from what you know: you've used this pattern any time you've matched request IDs to responses in a WebSocket client. The Map-of-queues is the multi-channel version of it — one queue per channel.

#### the cost note — `shift()` is O(n), and that's fine here

`Array.prototype.shift` removes the first element and re-indexes all remaining elements. That's O(n). For the activeToolCalls queue, n is "how many of the same tool are in flight at the same time," which in practice is 0-2. The constant is microseconds. **Reaching for a real linked-list deque would be over-engineering at this scale.**

The lesson: pick the right structure for the scale. The discipline (FIFO) is what's load-bearing; the implementation (a JS array used as a queue) is fine until n grows.

```
  when push+shift on an array stops being fine

  n ≤ ~10:   irrelevant — microseconds either way
  n ≈ 1000:  noticeable — ms per shift
  n ≈ 100k:  catastrophic — seconds per shift

  this codebase: n in [0, 2].   stays an array forever.
```

#### the heap you don't have — top-K ranking

The monitoring agent picks the top 10 anomalies by severity:

```ts
// lib/agents/monitoring-legacy.ts:136
return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
```

This is the textbook "top-K" pattern, and the textbook answer is **a fixed-size min-heap of size K**: walk the array, push each element, pop the min when size exceeds K. End cost O(n log K) instead of O(n log n) for the full sort.

But — n is at most ~10 here (the prompt asks for at most 10 anomalies). K=10 and n=10. Sort+slice is fine. The heap version would be the right call if n grew to, say, 10⁶ anomaly candidates and K stayed at 10.

```
  comparison — sort+slice vs top-K heap

  sort + slice                top-K heap (size K=10)
  ────────────────             ──────────────────────
  spread:    O(n)              walk array:   O(n)
  sort:      O(n log n)        per element:  O(log K)
  slice:     O(k)              total:        O(n log K)

  n=10:      negligible        negligible        same
  n=10^6:    20 M ops          ~33 M ops?  no — log K = 3.3, log n = 20
                                            so heap is ~6× cheaper
```

What breaks if you ship sort+slice at scale: at n=10⁶ you allocate a 10⁶-element copy, sort the whole thing, then throw away 999_990 entries. Memory + time you didn't need. The heap streams through and never holds more than K.

For now: not yet exercised, but file 06 (sorting) walks the sort code, and the heap is the upgrade path when `n` grows. Build a `BinaryHeap` from scratch once for your portfolio (you already have one in `reincodes`) — that's the interview asset.

#### the stack and deque — not yet exercised

No stack in this codebase. No deque. The agent loop runs as a flat `for (let turn = 0; turn < maxTurns; ...)` (`lib/agents/base-legacy.ts:114`), so there's no call-stack-style structure to expose. There's no scheduled job queue, no undo/redo, no BFS frontier, no monotonic-stack pattern.

This is honest absence, not a gap to fix in the code. The gap is in your DSA practice surface: every interview that asks for parens-matching, expression evaluation, sliding-window max, or BFS layer-by-layer wants one of these structures. File 08 (the practice map) ranks them.

### Move 3 — the principle

Stacks, queues, and deques are all *the same array* with **different contracts on which end you may touch**. The contract is the load-bearing part, not the implementation. A heap is a different shape (a tree, file 04), because asking for the smallest element fast requires structural invariants the line-of-people structures don't have. **Pick the structure by the discipline the caller needs, not by the language's syntax.**

## Primary diagram

The recap — what this codebase exercises (one queue) and what it doesn't (three other structures plus the heap), with the per-tool queue drawn in detail.

```
  ordering disciplines in blooming_insights

  EXERCISED ─────────────────────────────────────────────────────────
  queue (FIFO array, per tool name)
   activeToolCalls: Map<toolName, ToolCall[]>
   push at back on tool_call_start, shift at front on tool_call_end
   pairs start ↔ end deterministically across interleaved calls

   ┌────── eql ───────┐  ┌──── get_overview ────┐
   │  [tc1, tc2, tc3] │  │  [tcA]               │   one queue per tool
   │   ↑shift  push↓  │  │  ↑shift  push↓       │   name = one lane
   └──────────────────┘  └──────────────────────┘

  NOT YET EXERCISED ─────────────────────────────────────────────────
  stack (LIFO)    — would show up in recursion, expression eval, undo
  deque           — sliding-window max, BFS+caching combinations
  heap / PQ       — top-K (today: sort+slice over n≤10, fine for now)
                    Dijkstra, event-loop priority, scheduler
```

## Elaborate

The queue / stack / deque distinction goes back to the earliest days of computing — Knuth's *Art of Computer Programming* vol. 1 walks them as "linear lists" with different access disciplines. The deque (double-ended queue) is older than the name; "deque" was Knuth's coinage.

**Heaps are a Williams (1964) invention**, originally for heapsort. The binary heap stored in an array — parent at `i`, children at `2i+1` and `2i+2` — is the canonical implementation, walked in file 04 where it lives as a tree. The Fibonacci heap (Fredman + Tarjan, 1984) is the asymptotically-better cousin used in advanced Dijkstra analyses, mostly irrelevant in practice because the constants are large.

**Where you'll hit the heap pattern next in your portfolio**: a real priority queue is the right structure for any "scheduler" — picking which anomaly to investigate first (by severity), which tool call to retry first (by elapsed time), which streaming chunk to render first (by priority). The agent loop today is naive FIFO over the tool-use list returned from Anthropic; if you ever wanted "investigate the most severe anomaly first, then the next-most-severe," that's a heap.

Read next: file 04 (the heap's underlying tree shape, the BST that is `not yet exercised` here), file 06 (the sort that the heap would replace at scale).

## Interview defense

### Q: Why a Map of arrays in `activeToolCalls` instead of one global queue?

Per-tool FIFO. Two calls of *different* tools can be in flight simultaneously, and their `_end` events can arrive in either order (server response time decides). A single global queue would pair a `get_overview_end` with the oldest unpaired `_start` event regardless of name, so an `execute_analytics_eql_start` could get crossed with a `get_overview_end`. The Map gives each tool name its own FIFO lane: an end event only ever pops from the same-name queue.

```
  the bug a single global queue would have

  global queue:   [eql_start_1, overview_start, eql_start_2]
  event arrives:  overview_end
  shift() pops:   eql_start_1    ← WRONG. crossed pairing.

  Map per tool:   { eql: [tc1, tc2], overview: [tcA] }
  event arrives:  overview_end
  shift() pops:   tcA            ← correct.
```

Two starts of the *same* tool still need FIFO (the order they were enqueued), which the per-tool queue handles naturally.

Anchor: `lib/agents/aptkit-adapters.ts:101, 114-129`.

### Q: When would you replace `[...].sort().slice(0, K)` with a heap?

When `n` is large and `K` is small. The sort is O(n log n), the heap top-K is O(n log K). At n=10 and K=10 they're identical (and the sort is simpler code, so it wins). At n=10⁶ and K=10, log n ≈ 20 vs log K ≈ 3.3 — the heap is ~6× cheaper and never allocates the full sorted copy.

The blooming_insights case is the first one: the prompt caps anomalies at ~10. Sort+slice is correct here. The trigger to switch would be "the agent starts emitting hundreds of candidates and we pick the top 10" — then the heap is the right reach.

```
  the decision

  ┌──────────────────────┬──────────────────────┐
  │ n small (≤ ~100)     │ sort + slice          │
  │ n large, K small     │ fixed-size heap       │
  │ K large (~n)         │ sort + slice          │
  │ streaming / unknown n│ heap (you can't sort) │
  └──────────────────────┴──────────────────────┘
```

The streaming row is the important one for interview signal: if results arrive over time and you don't know n, sort isn't even available — you must maintain the top-K as you go, which is exactly what a fixed-size heap does.

Anchor: `lib/agents/monitoring-legacy.ts:136` (where sort+slice lives today).

### Q: Is `Array.prototype.shift` O(1) or O(n) — and does it matter here?

O(n). `shift` removes the first element and re-indexes every remaining element (since JS arrays are dense, indexed structures). For the `activeToolCalls` queue, n is "how many of this tool are in flight simultaneously" — practically 0 to 2 — so the constant is microseconds and it doesn't matter.

It would matter at scale. A queue with thousands of pending items, popped one per loop iteration, becomes O(n²) total — every shift re-indexes the rest. Real solutions: a linked-list deque, a circular buffer with head/tail indices, or the two-stack trick (push onto stack A, when popping flip A onto stack B; amortized O(1) per pop).

```
  why a hot queue can't be a JS array

  n=10:          10 × 10 = 100 ops total — fine
  n=10000:       10000 × 10000 = 100M ops — seconds
  n=1M:          1M × 1M = 1 trillion ops — minutes/hours
```

For `activeToolCalls`, sticking with the array is right because the scale guarantees the constant. The principle is **"the right structure depends on the scale, not the abstraction"** — same FIFO discipline, different implementation underneath.

Anchor: `lib/agents/aptkit-adapters.ts:118-124`.

## See also

- 02-arrays-strings-and-hash-maps.md — for the Map-of-X pattern (`activeToolCalls` is Map of queues).
- 04-trees-tries-and-balanced-indexes.md — where the heap's tree structure is teached.
- 06-sorting-searching-and-selection.md — for the sort+slice that the heap would replace.
- 08-dsa-foundations-practice-map.md — for where heap/stack/deque rank in the practice plan.
