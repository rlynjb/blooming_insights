# Trees, tries, and balanced indexes

Industry names: rooted tree, binary tree, trie / prefix tree, AVL / red-black tree, B-tree. Type: Industry standard.

## Zoom out — the honest verdict: `not yet exercised`

This is a service-and-transport codebase built around linear scans of small collections (40 tools, 10 anomalies, 20 investigations). Nothing here needs a balanced tree; nothing here needs a trie. The one *shape* that resembles a tree walk is the error-cause chain in `formatError()` at `lib/mcp/transport.ts:82-97` — but that's a degenerate tree (every node has degree 1), bounded at depth 5, and walked with a while loop, not recursion.

```
  Trees in this codebase — the honest map

  ┌─ Service layer ─────────────────────────────────┐
  │  (no trees)                                     │
  └─────────────────────────────────────────────────┘

  ┌─ Transport layer ───────────────────────────────┐
  │  formatError: walk error.cause chain            │  ← degenerate tree
  │  (depth ≤ 5, degree 1 → basically a list)       │
  └─────────────────────────────────────────────────┘

  not yet exercised:  binary search tree
  not yet exercised:  AVL / red-black balanced tree
  not yet exercised:  trie / prefix tree
  not yet exercised:  B-tree / B+tree (would be the storage engine)
  not yet exercised:  segment tree / Fenwick tree
```

That's not a criticism — the domain doesn't call for them yet. The chapter's job is to teach the primitives so the reader recognizes when a tree *would* land, and to name the one repo spot that's tree-shaped.

## Structure pass — trees are the "hierarchy" axis

Axis: **do children have an intrinsic order, and does structure need to stay balanced?**

- **Rooted tree**: hierarchy with no key ordering. Filesystem directories, DOM. Balance doesn't matter.
- **Binary search tree**: keys ordered left < parent < right; O(log n) if balanced, O(n) if not.
- **Balanced BST (AVL, red-black)**: guaranteed balance through rotation; O(log n) worst-case for all ops.
- **Trie**: keys are sequences (strings); depth = key length; branching = alphabet size.
- **B-tree**: high-branching factor, shallow depth; the disk-friendly variant that databases use.

The seam between these is *the invariant that must hold on every insert*. Different invariants demand different rebalancing work. Understanding which invariant applies is more than half the vocabulary.

## How it works — the one anchor + the missing primitives

### Move 1 — the tree kernel

A tree is a set of nodes where each has zero or one parent and any number of children, no cycles. You already know the shape from filesystems.

```
  Tree kernel — root, edges, leaves

              [ root ]
             /    │    \
        [ a ]   [ b ]   [ c ]
        /   \             │
     [ d ] [ e ]         [ f ]
                          │
                        [ leaf ]

  what makes it a tree: exactly one path from root to any node
  what breaks it       : a back-edge → cycle → no longer a tree
```

The mechanics that matter for every tree:
- **Traversal order** (pre-order, in-order, post-order) determines what the algorithm sees when.
- **Depth vs breadth** (DFS vs BFS) picks a stack vs a queue.
- **Balance** (or lack of it) turns O(log n) operations into O(n).

### Move 2 — the one repo anchor

**`formatError` — bounded traversal of a degenerate tree** — `lib/mcp/transport.ts:82-97`.

Errors in Node have a `cause` property; a wrapper error's cause is the error underneath. `formatError` walks that chain to assemble a single log-line, redacting nested tokens along the way. It's structurally a tree walk, but every node has exactly one child (or zero), so it degenerates to a list — and even then, walked with a bounded loop, not recursion.

```
  The cause chain — a tree with degree 1

  error A "callTool failed"
     │  .cause
     ▼
  error B "HTTP 401"
     │  .cause
     ▼
  error C "invalid token …tk_abc…"
     │  .cause
     ▼
    null

  formatError walks top → bottom, joins with "caused by:",
  stops at depth 5 or when .cause is null
```

Real code:

```ts
// lib/mcp/transport.ts:82-97
export function formatError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < 5) {                     // ← bounded traversal
    if (cur instanceof Error) {
      parts.push(cur.stack ?? cur.message);
      cur = (cur as { cause?: unknown }).cause;   // ← descend one child
    } else {
      parts.push(String(cur));
      cur = null;                                 // ← terminate on non-Error
    }
    depth++;
  }
  return parts.join('\n  caused by: ');
}
```

**Load-bearing parts:**

1. **`depth < 5` cap.** The one part you *always* forget on a recursive traversal. Without it, a circularly-linked `cause` (rare but possible) would infinite-loop. This is exactly the same protection a graph BFS's `visited` set gives you, in the degenerate case where "visited" collapses to a depth counter.
2. **`cur instanceof Error` branch.** The tree's leaves aren't always `Error` — someone could throw a plain object or string. Handle it, terminate.
3. **`parts.join('\n  caused by: ')`.** This is the in-order projection: walk root-first, join with a separator. The output preserves cause order.

**Why written iteratively, not recursively?** Two reasons. First, recursion in JS has a call-stack limit around 10k frames — with a depth cap of 5, iterative is still safer as a habit. Second, the iterative shape makes the depth cap obvious; a recursive version with a depth parameter is easier to mis-write. See `07-recursion-backtracking-and-dynamic-programming.md` for when recursion is the better choice.

### Move 2 (continued) — where the missing primitives would land

**`not yet exercised`: a trie for tool-schema lookup.**

Today, `filterToolSchemas` at `lib/agents/tool-schemas.ts:13-15` uses `Set.has(t.name)` — O(1) per name, O(n) total to scan all tools. At 40 tools this is invisible.

If the tool catalog ever grew to thousands *and* names shared common prefixes (e.g. `bloomreach.customer.get`, `bloomreach.customer.list`, `bloomreach.customer.update`), a trie would let you route by prefix and prune whole subtrees at once. Kernel:

```
  Trie — one node per prefix character

  root
   │
   ├─ 'b' ── 'l' ── 'o' ── 'o' ── ... ── "bloomreach.customer.get"
   │                              └── ... "bloomreach.customer.list"
   │                              └── ... "bloomreach.customer.update"
   │
   └─ 'e' ── 'v' ── 'a' ── 'l' ── ... "eval.run"
```

Trie ops:
- `insert(word)`: walk from root, create nodes for each character; O(|word|).
- `search(word)`: walk from root; O(|word|); returns true only at terminal marker.
- `startsWith(prefix)`: walk from root; return the subtree; O(|prefix|).

For membership tests, a hash set wins (O(1) vs O(|word|)). Tries win when the *prefix operations* matter — autocomplete, longest-common-prefix, dictionary compression.

**`not yet exercised`: a balanced BST for percentile queries.**

`percentiles()` at `eval/report.eval.ts:161` sorts the whole array every time. If percentiles were computed streaming — added one value at a time and queried repeatedly — an **order-statistic tree** (red-black BST with subtree counts) would give O(log n) insert and O(log n) k-th-largest.

That's not built here, and probably shouldn't be — the eval runs batch. But it's the answer to "how would you compute running percentiles at scale?" if you got asked.

### Move 3 — the principle

Trees earn their place when the *hierarchy* is intrinsic to the data or when the *log-depth* buys you a query you can't get from a hash map — ordered lookups, range queries, prefix matches. This codebase doesn't have any of those needs at its current scale. The reader's job is to recognize the shape when it arrives (or when it should).

## Primary diagram — the tree family, mapped to fits

```
  Tree family — what each one solves, and where it would fit here

  ┌─ Rooted tree ────────────────────────────┐   fits: filesystem, DOM
  │  parent → children, no cycles            │   NOT PRESENT
  └──────────────────────────────────────────┘

  ┌─ Degenerate list-tree ───────────────────┐   fits: error.cause chain
  │  each node has degree ≤ 1                │   LIVE at lib/mcp/transport.ts:82
  └──────────────────────────────────────────┘

  ┌─ Binary search tree ─────────────────────┐   fits: ordered set with
  │  left < parent < right                   │        range queries
  └──────────────────────────────────────────┘   NOT PRESENT

  ┌─ Balanced BST (AVL, red-black) ──────────┐   fits: order-statistic
  │  rotation keeps depth ≤ 2·log₂(n)        │        percentiles
  └──────────────────────────────────────────┘   NOT PRESENT — would replace
                                                  percentiles() at scale

  ┌─ Trie / prefix tree ─────────────────────┐   fits: tool-name routing
  │  depth = key length, branch = alphabet   │        (only worth it at
  └──────────────────────────────────────────┘        thousands of names)
                                                  NOT PRESENT

  ┌─ B-tree / B+tree ────────────────────────┐   fits: disk indexes
  │  high branching factor, shallow depth    │   NOT PRESENT — the database
  │                                          │        is Bloomreach's problem
  └──────────────────────────────────────────┘
```

## Elaborate

Trees are the reader's home turf per `me.md` — you've built binary search trees before. What might be less familiar is the **rotation** trick that makes AVL and red-black trees work: after an insert unbalances the tree, one or two local pointer-swaps restore the invariant without touching the rest. Practicing rotations by hand once is worth the hour — you'll never forget the shape.

For interview prep, the tree topics that pay: **serialize/deserialize a binary tree** (Google favorite), **lowest common ancestor** (Meta), **kth-smallest in a BST** (in-order traversal + counter, extends naturally to order-statistic trees).

The trie question that always comes up: **word search II** on LeetCode — walk a 2D grid, match against a set of words, prune by prefix. It's a trie + DFS + backtracking mash-up that ties this chapter to `07-recursion-backtracking-and-dynamic-programming.md`.

B-trees are the reason your database's index is fast. If you want to *see* one, sqlite's `.dump` prints the shape of its B+tree. Every leaf is an index page.

## Interview defense

**Q: There's no tree in this repo — but there is a chain walk. Talk about it.**

Answer: `formatError` at `lib/mcp/transport.ts:82-97` walks an error's `cause` chain top-down, capped at depth 5, joining messages with "caused by:". It's structurally a tree walk, but every node has degree 1, so it degenerates to a list — and it's written iteratively with a while loop, not recursively.

The load-bearing part is the depth cap. A circular cause reference (rare but possible) would infinite-loop without it. That's the same protection a BFS's `visited` set gives you on a real graph — in the degenerate case, "visited" collapses to a depth counter.

```
  Bounded traversal — depth counter as "visited" in a degenerate tree

  depth = 0    error A
                  │  .cause
  depth = 1    error B
                  │
   ...
  depth = 5    STOP  ← safety cap; never rely on the graph being finite
```

Anchor: `lib/mcp/transport.ts:82-97`.

**Q: Where would you reach for a trie in this codebase?**

Answer: I wouldn't today. Tool-name lookup is `Set.has(name)` — O(1) — and there are 40 tools. A trie would be premature. If the catalog grew to thousands of names *and* callers wanted prefix operations (autocomplete, group-by-namespace), then a trie earns its keep because `startsWith(prefix)` returns a whole subtree in O(|prefix|) instead of O(n) filter.

```
  Set vs Trie — when the trie earns its place

  Set:    membership only, O(1)                        ← current fit
  Trie:   prefix ops, O(|prefix|) subtree return       ← would need
                                                          "list tools starting with X"
```

Anchor: `lib/agents/tool-schemas.ts:13`.

**Q: If you wanted running percentiles instead of batch, what would you build?**

Answer: An order-statistic tree — a red-black BST where each node stores the size of its subtree. Insert is O(log n); k-th-largest is O(log n) by walking down and choosing left or right based on subtree counts. That replaces the current sort-then-index at `eval/report.eval.ts:161-179`, which is O(n log n) per query, batch-only.

For very large streams, the practical answer is a **t-digest** — you give up exact percentiles for a compact sketch that answers p99 in constant memory. That's what production observability stacks (Datadog, Prometheus) actually use.

```
  Percentile strategies

  batch sort + index  :  O(n log n)      ← current (report.eval.ts:161)
  order-statistic BST :  O(log n) insert, O(log n) query   ← streaming, exact
  t-digest             :  O(1) memory, approximate         ← streaming, at scale
```

Anchor: `eval/report.eval.ts:161`.

## See also

- `03-stacks-queues-deques-and-heaps.md` — a binary heap *is* a tree (stored as an array).
- `05-graphs-and-traversals.md` — trees are the special case of graphs without cycles.
- `07-recursion-backtracking-and-dynamic-programming.md` — recursive tree traversal, which this repo doesn't do.
- `.aipe/study-database-systems/` — B-trees as the storage engine's backbone.
