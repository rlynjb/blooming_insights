# Trees, Tries, and Balanced Indexes

Binary tree · binary search tree · heap (as tree) · trie · balanced tree (AVL, red-black) — Industry standard

## Zoom out — where this concept lives

**Not yet exercised** in `blooming_insights`. The structures don't show up in any layer of the running system — there's no hierarchical data the code walks recursively, no ordered set kept in a tree, no prefix-completion problem. The diagram marks where a tree *would* fit if the code ever needed one.

```
  Zoom out — where trees would fit (if exercised)

  ┌─ UI (browser) ─────────────────────────────────────────────────┐
  │  React renders a component tree — that's an internal React tree │
  │  the code doesn't build or walk one explicitly                  │
  └────────────────────────────────────────────────────────────────┘
  ┌─ Service ──────────────────────────────────────────────────────┐
  │  ★ where a heap WOULD live ★                                    │
  │  top-K anomaly ranking — currently sort+slice (file 03, 06)     │
  │  would be a tree-in-array heap when n grows                     │
  │                                                                 │
  │  where a trie WOULD live: no prefix completion, no autocomplete │
  │  the categories list is 10 strings — trie would be overkill      │
  └────────────────────────────────────────────────────────────────┘
  ┌─ Storage (Bloomreach) ─────────────────────────────────────────┐
  │  the database's internal indexes are almost certainly trees     │
  │  (B-tree / LSM), but we DON'T see them — Bloomreach is opaque   │
  │  cross-link: study-database-systems for that depth              │
  └────────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

A tree is a hash map's cousin that gives up O(1) lookup to get **ordered traversal** for free. You can ask "smallest first," "all values between 100 and 200 in order," "longest matching prefix" — questions a hash map can't answer cheaply.

Four flavors matter:

- **binary tree** — every node has up to 2 children; the shape, no rules on values.
- **binary search tree (BST)** — left < node < right; ordered lookups in O(log n) when balanced.
- **heap** — every node ≤ children (min-heap) or ≥ children (max-heap); the parent is the extreme. Always balanced; stored in an array.
- **trie (prefix tree)** — each edge is a character; walking from root spells a string. Used for autocomplete, IP routing, dictionary lookups.

The honest framing for this repo: **none of this is wired up yet**, but you already have these primitives implemented in your `reincodes` portfolio (`BinarySearchTree.ts`, `BinaryHeap.ts`, `Tree.ts`). The teaching here points back to your own code and names the seam where they'd land in `blooming_insights` if the surface grew.

## Structure pass — layers · axes · seams

One axis traced: **what ordering does the structure preserve?**

```
  one axis — "what order does the structure preserve?"

  ┌─ array ──────────────────────────────────────────────────────┐
  │  preserves: insertion order                                   │
  │  ordered lookup: O(n) scan                                    │
  └──────────────────────────────────────────────────────────────┘
  ┌─ hash map / set ─────────────────────────────────────────────┐
  │  preserves: insertion order (in JS)                           │
  │  ordered lookup BY KEY: not directly — you'd sort the keys   │
  │                          (O(n log n)) every time              │
  └──────────────────────────────────────────────────────────────┘
  ┌─ binary search tree ─────────────────────────────────────────┐
  │  preserves: sorted order, by the comparator                   │
  │  ordered lookup: O(log n) min / max / pred / succ / range    │
  │  the seam: O(1) lookup gives way to O(log n) for ordered ops │
  └──────────────────────────────────────────────────────────────┘
  ┌─ heap ───────────────────────────────────────────────────────┐
  │  preserves: ONE end of the order (min OR max), not both       │
  │  ordered lookup: O(1) peek-min, O(log n) extract-min          │
  └──────────────────────────────────────────────────────────────┘
  ┌─ trie ───────────────────────────────────────────────────────┐
  │  preserves: shared prefixes                                   │
  │  ordered lookup: O(prefix length) — independent of n!         │
  └──────────────────────────────────────────────────────────────┘
```

- **layers**: not exercised — the layer column is the same one as the rest of the system, but no tree node lives in any of them.
- **axis**: ordering preserved. Each structure trades a different invariant for a different kind of cheap query.
- **seam**: the boundary is "do I need to look up by exact key, by range, by prefix, or by extreme?" Each answer pulls a different structure off the shelf.

## How it works

### Move 1 — the mental model

A tree is a hierarchy of nodes where each node has a value and pointers to its children. **The "binary" part means at most two children, left and right.** What makes a BST useful is the *invariant*: every value in the left subtree is less than the node's value, every value in the right subtree is greater. That invariant is what makes `find`, `insert`, `delete`, `min`, `max`, `predecessor`, `successor`, and `inorder traversal` each cost O(log n) instead of O(n).

You already know this shape from `reincodes/BinarySearchTree.ts` — the insert that walks left if smaller, right if greater, recursively until it hits a `null`. Same shape every time:

```
  BST — the kernel

                  ┌─ 50 ─┐
                 /         \
              ┌ 30 ┐       ┌ 70 ┐
             /     \       /     \
           20      40    60      80

  search 40:  start at 50 — 40 < 50 → go left
              at 30        — 40 > 30 → go right
              at 40        — found
              path length = O(log n) when balanced
```

A heap is *also* a binary tree, but with a different invariant: every parent ≤ its children. That makes the root always the minimum, and you can answer "what's smallest?" in O(1). Insertion is O(log n): drop in at the next leaf slot, then bubble up until the parent invariant holds.

A trie isn't binary — its branching factor is the alphabet size. Each edge is a character; each node represents a prefix. Used for autocomplete: walk the trie character by character, the subtree under your stopping node is the set of completions.

### Move 2 — the moving parts

#### the BST kernel — the load-bearing parts

You've already built this in `reincodes`. The structural pass tells you which parts are kernel:

```
  BST kernel — what you can't remove

  1. node:          { value, left, right }    — the cell
  2. invariant:     left.value < node.value < right.value
  3. insert:        walk by comparator, insert at first null
  4. search:        walk by comparator, return at match or null
  5. delete:        if leaf → null; if one child → replace; if two →
                    swap with inorder successor, then delete that leaf

  remove the invariant → it becomes a generic binary tree;
       lookups go O(n) (no way to know which subtree)
  remove the rebalance → it stays a BST but degrades to O(n) on
       sorted input (becomes a linked list)
  remove inorder traversal → you can't get "all values in order"
       cheaply; the structure loses half its point
```

Bridge from what you know: this is the same `if (target < node) go left else go right` discipline as binary search over an array (file 06). The BST is "binary search but the array is allowed to grow and shrink between queries." A balanced BST gives you the same O(log n) lookup as binary search PLUS O(log n) insert and delete, where the sorted array gives you O(n) insert and delete.

#### why a *balanced* BST is the production answer

A plain BST degrades. Insert 1, 2, 3, 4, 5 into a fresh BST and you get a right-leaning linked list — every operation becomes O(n).

```
  what degrades a plain BST

  insert 1, 2, 3, 4, 5:

        1
         \
          2
           \
            3
             \
              4
               \
                5     ← height = 5, search worst case O(n)

  a balanced BST (AVL, red-black) re-rotates on each insert
  to keep height = O(log n). same operations, same O(log n).
```

**AVL trees and red-black trees** are the two industry-standard self-balancing BSTs. Red-black is what most language standard libraries use (Java TreeMap, C++ std::map). The rotation logic is fiddly to write but the *behavior* is what you need to know for interviews: every insert/delete may rotate, height stays O(log n), all queries stay O(log n).

#### the heap as tree, stored in an array

The heap's invariant — parent ≤ both children (min-heap) — lets you store the tree in a flat array with no pointers. Parent at index `i`, children at `2i+1` and `2i+2`. The shape stays balanced because you always insert at the next free slot (filling left-to-right, level by level).

```
  binary min-heap — array layout

  array:  [ 5, 8, 12, 17, 25, 19, 33 ]
            0  1   2   3   4   5   6

  as tree:
                 ┌─ 5 ─┐
                /       \
             ┌ 8 ┐    ┌ 12 ┐
            /     \   /      \
          17    25  19      33

  parent(i) = (i-1) / 2
  left(i)   = 2i + 1
  right(i)  = 2i + 2

  peek-min:    array[0]        O(1)
  insert:      push to end, bubble up        O(log n)
  extract-min: swap [0] with last, pop, sift down   O(log n)
```

You have this in `reincodes/BinaryHeap.ts` — heapifyUp + heapifyDown. The lesson here is **the same data structure (tree, array) supports very different queries depending on the invariant you maintain over it.** Heap with parent ≤ child invariant: O(1) min. BST with left < parent < right invariant: O(log n) range queries. Same nodes, different rules, different jobs.

#### the trie — when prefix is the question

```
  trie — example for {"car", "cat", "card", "dog"}

         (root)
         /     \
        c       d
        |       |
        a       o
       / \      |
      r   t●    g●
     /|
    d●

  ● marks "end of a word"
  walking "ca" lands at node "a" — completions: "r" subtree + "t●"
  → "car", "card", "cat"
```

Each character is an edge. Lookup of a word is O(word length), **independent of how many words are stored**. That's the killer feature: 10⁶ words, prefix lookup still costs the length of the prefix.

Where this would show up in `blooming_insights` if the surface grew: an autocomplete on EQL query terms, an autocomplete on tool names, a prefix-routing layer. None of that exists today.

#### the seam — when does a tree beat a Map?

```
  the decision

  ┌──────────────────────────────────┬──────────────────────────┐
  │ question you need to answer       │ structure                 │
  ├──────────────────────────────────┼──────────────────────────┤
  │ "is this key here?"              │ hash map (O(1))           │
  │ "what's at position k?"          │ array (O(1))              │
  │ "what's smallest?"               │ heap (O(1) peek)          │
  │ "what's between A and B?"        │ balanced BST (O(log n))   │
  │ "all in sorted order"            │ balanced BST (O(n))       │
  │ "complete this prefix"           │ trie (O(prefix len))      │
  │ "n-th smallest"                  │ order-statistic tree      │
  │ "sum over a range"               │ segment tree / Fenwick    │
  └──────────────────────────────────┴──────────────────────────┘
```

`blooming_insights` only ever asks the first two questions today. That's why the structures column is empty. The list above is the **interview** surface — and most of these will show up in DSA rounds whether or not your shipped code reaches for them.

### Move 3 — the principle

Trees give you **structured order** in exchange for slightly slower point-lookup. The choice of tree is the choice of *which* order matters: total order (BST), extreme-of-order (heap), shared-prefix order (trie), range-aggregate order (segment tree). The hash map answers "is this key here?" and stops; trees answer the harder questions about *how* keys relate.

## Primary diagram

The recap — what's not exercised, and where each tree would land if it were.

```
  trees / tries / heaps in blooming_insights — the empty shelf

  NOT YET EXERCISED in any layer of the running code.

  ┌─ binary tree     ┐
  │  no hierarchy walked recursively in the codebase            │
  └──────────────────┘

  ┌─ binary search tree ┐
  │  would land here:  an in-memory ordered index of insights    │
  │  by severity (for range queries). today: linear scan + sort. │
  └─────────────────────┘

  ┌─ heap (priority queue) ┐
  │  would land here:  top-K anomaly ranking when n grows         │
  │  today: sort+slice over n=10 (file 03, file 06)               │
  └────────────────────────┘

  ┌─ trie ┐
  │  would land here:  EQL term autocomplete, tool-name prefix    │
  │  routing. today: no prefix-driven UI surface.                 │
  └───────┘

  ┌─ balanced BST (AVL / red-black) ┐
  │  the production form of BST — keeps height O(log n)            │
  │  no use case in this repo yet. interview-only for now.         │
  └────────────────────────────────┘

  cross-link: study-database-systems teaches the storage-engine
  trees (B-tree, LSM) the Bloomreach side almost certainly uses
  internally but that you don't see from this codebase.
```

## Elaborate

The BST goes back to the 1960s; the AVL tree (Adelson-Velsky + Landis, 1962) was the first self-balancing variant. **Red-black trees** (Bayer 1972 as "symmetric binary B-trees," then Guibas + Sedgewick 1978 as the modern name) became the default in standard libraries because the rotations are slightly cheaper than AVL's on average. The two are interchangeable for practical purposes — both keep height O(log n), both support all the standard operations in O(log n).

The trie (de la Briandais, 1959; Fredkin, 1960) is older than the BST as a name in print but less common in everyday code. Variants worth knowing for interviews: **compressed trie / radix tree** (collapse single-child chains; used in network routing tables and in Linux's `/proc` directory), **suffix tree / suffix array** (string matching across all substrings — Ukkonen's algorithm builds one in O(n)).

The heap as we know it is Williams (1964) for heapsort. The min-heap and max-heap are just the same shape with the comparator flipped. **Where heaps come up beyond top-K**: Dijkstra's shortest path (the priority queue), Huffman coding, event-loop schedulers, the OS run-queue in some kernels.

**Don't reach for these in this codebase unless the surface changes.** The honest move is to keep your `reincodes` portfolio sharp — that's the interview asset. If `blooming_insights` ever grows a feature that needs ordered traversal, range queries, or prefix matching, the implementation work is small because you already have the primitives written.

Read next: file 05 (graphs — also not yet exercised here, also worth drilling for interviews), file 06 (the sort that a heap would replace at scale), file 08 (where these structures rank in your practice plan).

## Interview defense

### Q: Why a balanced BST and not just a sorted array?

A sorted array supports **binary search** (file 06) in O(log n) — same as a balanced BST for lookup. The difference is what insert and delete cost:

```
  same lookup, very different mutation cost

                       sorted array        balanced BST
  find         O(log n)             O(log n)
  insert       O(n)  (shift to keep order)  O(log n) (walk + rebalance)
  delete       O(n)  (shift)                O(log n)
  min / max    O(1)                         O(log n) (walk to leftmost/rightmost)
  range scan   O(log n + k)                 O(log n + k)
```

If the data is **read-mostly**, the sorted array wins on the constants — it's contiguous in memory, the lookups are cache-friendly. If the data **changes during the workload** — inserts and deletes interleaved with queries — the BST wins because the array's per-insert O(n) eats you alive.

The honest call: in `blooming_insights` neither is needed; the data is either tiny (10 anomalies) or hash-keyed. The BST is the answer when you have **both** ordered queries AND mutations during the workload.

Anchor: your `reincodes/BinarySearchTree.ts` (no live use here yet).

### Q: A heap is also a tree — how is it different from a BST?

Different invariant, different question answered fast. A BST keeps **total order across siblings** (left < node < right), so you can answer "all values between A and B" in O(log n + k). A heap keeps only **parent ≤ both children** — no order *between siblings* — so you can only answer "what's the extreme?" cheaply.

The tradeoff:

```
  same nodes, two different invariants, two different jobs

  BST                          heap (min-heap)
   ┌── 50 ──┐                  ┌── 5 ──┐
   /         \                 /        \
  30         70              8          12
  / \        / \            / \         / \
 20 40     60 80          17 25       19 33

  ordered scan ◀──── inorder traversal ──── O(n) sorted output
  "between 35 and 65"  O(log n + k)
  predecessor / successor: O(log n)

                              "smallest?"     O(1)
                              "pop smallest"  O(log n)
                              "all in order"  O(n log n) — pop n times
                              "between A and B" — NOT supported cheaply
```

The lesson: **same data structure (binary tree, even storable in an array) supports very different queries depending on the invariant you keep over it.** Pick the invariant by the question you care about.

Anchor: your `reincodes/BinaryHeap.ts` and `reincodes/PriorityQueue.ts`.

### Q: When is a trie the right answer over a hash map?

When the questions are about **shared prefixes**. A hash map keyed on strings can tell you "is this exact string in here?" in O(1). It cannot tell you cheaply:

- "all strings starting with `car`" — the hash gives you no locality; you'd scan every key.
- "longest prefix in the set that matches my input" — same problem.

A trie's prefix lookup costs **O(prefix length)** — independent of how many strings are stored. 10⁶ strings, prefix lookup still costs the length of the prefix.

```
  the decision

  exact-match only:       hash map (O(1), simpler)
  prefix queries:         trie (O(len))
  range over sort order:  balanced BST (O(log n))
```

Real-world tries: autocomplete UIs, IP routing (longest-prefix match on the destination address), DNS lookup, spell-check dictionaries, JIT compilers' string interning.

Not yet exercised here. The interview question typically goes: "build autocomplete for a million words" — the answer is a trie, and the optional follow-up is "what about the worst case where every word is a unique prefix?" (space blows up; reach for a radix tree / DAWG).

Anchor: not in this repo. Cross-link to file 08 for where this ranks in the practice plan.

## See also

- 03-stacks-queues-deques-and-heaps.md — where the heap is named as the upgrade for the sort+slice top-K.
- 05-graphs-and-traversals.md — a graph is a generalized tree (multiple parents allowed).
- 06-sorting-searching-and-selection.md — binary search is the BST's array-flavored cousin.
- 07-recursion-backtracking-and-dynamic-programming.md — tree walks are recursion's canonical example.
- 08-dsa-foundations-practice-map.md — where trees/tries/heaps rank in the practice plan.
- `.aipe/study-database-systems/` — for the B-tree / LSM-tree the storage engine almost certainly uses internally (cross-link, not duplicate).
