# Trees, tries, and balanced indexes

*Hierarchical structures · prefix indexes · self-balancing trees · Industry standard*

## Zoom out, then zoom in

This is a Case-B file: the repo doesn't exercise trees, tries, or balanced indexes in any load-bearing way. Naming that up front is the point. But you *have* built these primitives — `reincodes/BinarySearchTree.ts`, `Tree.ts`, `BinaryHeap.ts` — and interviews still ask about them, so this file teaches the primitives from first principles and anchors to your own implementations.

```
  Zoom out — where trees don't (yet) live in blooming_insights

  ┌─ UI layer ───────────────────────────────────────────────────┐
  │  React's virtual DOM is a tree, but that's framework         │
  │  internals — you don't own or walk it directly               │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Agent / route layer ───▼────────────────────────────────────┐
  │  Agent conversations are a *linear* sequence — no branching, │
  │  no tree of alternative reasoning paths                      │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Storage / config ──────▼────────────────────────────────────┐
  │  No database, no ordered index, no in-memory sorted map      │
  │  All state is flat: JSON files, Set<string>, Record<K,V>     │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Where trees LIVE, in your other codebase ──────────────────┐
  │                                                              │
  │  reincodes/BinarySearchTree.ts                               │
  │    · insert / search / delete (rec + iter)                   │
  │    · pre / in / post-order traversals                        │
  │    · successor / predecessor                                 │
  │                                                              │
  │  reincodes/Tree.ts                                           │
  │    · general n-ary tree                                      │
  │    · pre / post traversal via generators                     │
  │    · used in recursion call-stack visualizers                │
  │                                                              │
  │  reincodes/BinaryHeap.ts                                     │
  │    · nearly-complete binary tree stored as an array          │
  │    · heapifyUp / heapifyDown                                 │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** A tree is any hierarchy — each node has zero or more children, one parent (or zero, at the root). Trees show up whenever "contains" is the load-bearing question: file systems, DOMs, ASTs, category hierarchies. Tries specialize trees for prefix lookups; balanced trees (AVL, red-black, B-trees) enforce a height invariant so operations stay O(log n). None of these are load-bearing in blooming_insights *today* — but the primitives are worth knowing cold.

## Structure pass

**Layers.** Two altitudes:
  1. the *shape* (binary vs n-ary, ordered vs unordered, balanced vs not)
  2. the *operation* the shape enables (search, insert, prefix match, range query)

**Axis: how does the tree stay useful as it grows?** Trace it down:
  - unbalanced BST → O(log n) average, O(n) worst-case (a sorted-input insert makes it a linked list)
  - balanced BST (AVL, red-black) → O(log n) guaranteed
  - B-tree → O(log_B n) with B-way branching, tuned for disk pages
  - trie → O(key length), independent of tree size

**Seams.** The load-bearing seam is between *sortedness* and *balance*. A BST that stays balanced gives you sorted iteration + O(log n) operations. Lose either and you either lose the ordering (hash-map) or lose the guarantee (linked list masquerading as a tree). This is why databases reach for B-trees, not naive BSTs — the invariant survives adversarial insert orders.

## How it works

### Move 1 — a tree is a linked structure with a "parent pointer" you can't take back

You already know a linked list: each node points to `next`. A binary tree is that shape with two `next` pointers — `left` and `right`. An n-ary tree just has an array of children. Everything else about trees is what you *do with* the pointers.

```
  A binary tree — the shape

              (10)                 ← root
             /    \
           (5)    (15)             ← level 1
           / \    /  \
         (3) (7)(12)(20)           ← level 2
```

For a *binary search tree*, the invariant is: for every node, everything in the left subtree is smaller, everything in the right subtree is larger. That's what makes `search(x)` an O(log n) descent instead of an O(n) scan — every comparison eliminates half the remaining tree.

For a *heap*, the invariant is: every parent ≤ every child (min-heap) or ≥ (max-heap). No left/right ordering — a heap is looser than a BST. This is why the heap can pack into an array (see file 03) but the BST can't.

### Move 2 — traversals: three ways to walk a tree

You built these in `reincodes/BinarySearchTree.ts`. The three orders are named by *when the node itself gets visited* relative to its children:

```
  Traversal orders — same tree, three walks

  Tree:              (10)
                    /    \
                  (5)   (15)
                  / \    / \
                (3)(7)(12)(20)

  Pre-order:   10 → 5 → 3 → 7 → 15 → 12 → 20
               (visit node, then left, then right)
               → serialize a tree, DFS with visit-first

  In-order:    3 → 5 → 7 → 10 → 12 → 15 → 20
               (left, node, right)
               → BST in-order = sorted output — the killer app

  Post-order:  3 → 7 → 5 → 12 → 20 → 15 → 10
               (left, right, node)
               → free a tree, evaluate an expression tree
```

The pseudocode for all three fits on one screen:

```
  function traverse(node, order):
    if node is null: return
    if order == pre:  visit(node)
    traverse(node.left,  order)
    if order == in:   visit(node)
    traverse(node.right, order)
    if order == post: visit(node)
```

**What breaks if you drop the null check?** The recursion never terminates at a leaf — you'd try to descend into `null.left` and crash. The base case is the load-bearing part.

**What breaks if you swap `left` and `right`?** Nothing structural — you get the mirror-image traversal. In-order on a BST would give you *reverse-sorted* output. Same algorithm, symmetric shape.

Your own code (line ranges from memory of your reincodes DSA portfolio):

```ts
// reincodes/BinarySearchTree.ts — the shape you already own
class BinarySearchTree<T> {
  root: TreeNode<T> | null = null;
  insert(value: T): void { /* ... */ }
  search(value: T): TreeNode<T> | null { /* ... */ }
  delete(value: T): void { /* handles 0, 1, 2 children */ }
  preOrder():  T[] { /* recursive */ }
  inOrder():   T[] { /* recursive — sorted for BST */ }
  postOrder(): T[] { /* recursive */ }
  successor(node: TreeNode<T>): TreeNode<T> | null {
    // if right subtree exists, return leftmost of right
    // otherwise climb until we're a left child
  }
}
```

The tricky operation is `delete` — three cases (leaf, one child, two children) and the two-child case needs the successor. That's the code that separates "I read a chapter" from "I built one."

### Move 2 — balance: why a naive BST breaks

Insert `1, 2, 3, 4, 5` into an empty BST *in that order*. Every new node goes right. You end up with:

```
  Insertion order matters — degenerate BST

  insert 1: (1)
  insert 2: (1) - (2)
  insert 3: (1) - (2) - (3)
  ...
  insert 5: (1) - (2) - (3) - (4) - (5)
             ↑
             this is a linked list wearing a BST hat
             search(5) is O(n), not O(log n)
```

That's the whole reason balanced BSTs exist. AVL trees (Adelson-Velsky & Landis, 1962) rebalance after every insert via *rotations*. Red-black trees (Bayer, 1972 → CLRS chapter 13) do the same with a color invariant that's easier to maintain. B-trees (Bayer & McCreight, 1970) generalize to B-way branching for disk-page-sized nodes.

You *don't* have these implementations in `reincodes` — this is a genuine curriculum gap. The interview signal: "I've built the unbalanced BST from scratch; I know the balancing algorithms conceptually; I haven't implemented an AVL rotation with confidence yet — that's a two-week focused study." That's an honest answer.

### Move 2 — tries: prefix lookups in O(key length)

A trie is a tree where each edge is one character, and each root-to-node path spells out a prefix. It's the primitive behind autocomplete, spell-check, and IP-routing tables.

```
  Trie — one edge per character, prefix lookup in O(key length)

               (root)
              /   |   \
             a    c    t
             |    |    |
            (n) (a)   (o)
             |    |    |
            (d) (t)*  (o)*
             |
            (*)        * = terminal (a complete word ends here)

  words stored: "and", "cat", "too"
  search("cat"): 3 hops = O(len("cat"))
  search("catapult"): 3 hops, then t.next is null → not found
```

The killer property: search cost is independent of *how many* words are in the trie — only the length of the query matters. A dictionary of 100,000 words and a dictionary of 10 words both search "cat" in 3 hops.

Not exercised in this repo. Would become relevant if you built an autocomplete over event property names — pulling every property matching a `page_` prefix from a hundred thousand events would be the exact shape a trie handles well.

### Move 2 — B-trees: the shape databases actually use

Every relational database's primary key index is a B-tree (or a B+ tree). The shape: nodes hold B keys (not one), have B+1 children, and stay balanced by splitting when full. B is chosen so a node fits in one disk page (typically B ≈ 100-1000).

```
  B-tree — B-way branching, tuned for disk pages

              [ 10, 30, 60 ]
             /     |     |    \
     [1,3,5,7] [11,15,25] [31,40] [70,80,90]

  each node is one page read
  height stays ~log_B(n) — for n=1B and B=100, height = 5
  → 5 page reads to find any key, no matter how big the tree
```

Why databases use this: disk I/O dominates. Reading one page (~4-16 KB) to check 100 keys is way faster than 100 separate page reads to check one key each. The B-tree's whole design is "pack as much as possible into one page and stay balanced."

Not exercised in this repo — there's no persistent database. Would become relevant if you added Postgres or SQLite as a receipt store. `reincodes` doesn't have B-tree either — this is an interview-only primitive to know conceptually.

### Move 3 — the principle

**Trees exist to make "contains" and "range" cheap in sorted order.** Every tree variant is a different tradeoff on that theme: unbalanced BST for the raw idea, AVL/red-black for the guarantee, B-tree for the disk-locality, trie for the prefix-lookup, heap for the priority. In this repo none of these earn their keep yet — a Set covers "contains" without ordering, and no data structure needs sorted-order iteration. Know the shapes; know when to reach for them; don't manufacture a use case in code that doesn't need one.

## Primary diagram

The whole family — arrayed by the invariant each maintains — and where each one lives in your work.

```
  Trees / tries / balanced indexes — the family map

  ┌─ SHAPE ──────────────┬─ INVARIANT ──────────┬─ WHERE ────────────┐
  │                       │                        │                     │
  │  binary tree          │  each node ≤ 2 kids    │  no repo use        │
  │                       │                        │                     │
  │  BST                  │  left < node < right   │  reincodes/         │
  │                       │                        │  BinarySearchTree.ts│
  │                       │                        │                     │
  │  balanced BST         │  BST + height          │  not built yet      │
  │  (AVL, red-black)     │  invariant             │  ← curriculum gap   │
  │                       │                        │                     │
  │  B-tree               │  B-way branching,      │  DBs use it;        │
  │                       │  fits in disk page     │  not in your code   │
  │                       │                        │                     │
  │  trie                 │  one edge per          │  not built yet      │
  │                       │  character             │  ← curriculum gap   │
  │                       │                        │                     │
  │  heap                 │  parent ≤ children     │  reincodes/         │
  │                       │  (nearly-complete)     │  BinaryHeap.ts      │
  │                       │                        │                     │
  │  n-ary tree           │  arbitrary children    │  reincodes/Tree.ts  │
  └───────────────────────┴────────────────────────┴─────────────────────┘
```

## Elaborate

Binary search trees date to Windley (1960). The self-balancing family started with AVL (1962), continued with red-black (1972), splay trees (Sleator & Tarjan, 1985), and treaps (Aragon & Seidel, 1989). Each trades a different complexity axis: AVL is strictly balanced (better search, more rotations on insert), red-black is loosely balanced (fewer rotations, slightly deeper), splay trees have great amortized bounds but terrible worst-case per-op, treaps randomize the balance so no input order breaks them.

B-trees (Bayer & McCreight, 1970) and B+ trees are the shape of every production database index — Postgres, MySQL InnoDB, SQLite, MongoDB, all use B-tree variants. The `+` variant keeps all data in leaves and links them in a list, so range scans are efficient. LSM-trees (Log-Structured Merge, O'Neil et al., 1996) are the alternative — used by Cassandra, RocksDB, LevelDB, HBase — trading read cost for write throughput. Every "SSTable" story in a database book is LSM-tree.

Tries got their name from "reTRIEval" (Fredkin, 1960). Compressed variants (radix tree, Patricia trie) are what routing tables use to look up IP prefixes; a `/24` prefix match happens in O(24) hops through a Patricia trie regardless of the full routing-table size. The modern high-performance variant is the Adaptive Radix Tree (ART, 2013), used in newer in-memory databases like DuckDB.

Related reading: CLRS chapters 12 (BSTs), 13 (red-black trees), 18 (B-trees). Sedgewick chapter 3 (search trees, tries). "Database Internals" by Petrov is the practical text on B-trees and LSM in production systems.

## Interview defense

**Q: Why doesn't this codebase use any trees?**

Because the only questions it asks are "is X in this set?" and "give me each item in an unsorted list." Sets and arrays cover both without the constants a tree brings. Trees earn their keep when you need *ordered* iteration, *range* queries, or *prefix* lookups — none of those show up. The moment you add a receipt browser with "show me all receipts between date A and date B," a sorted map (B-tree in a real DB, an ordered array with binary search in memory) starts pulling weight.

```
  When trees vs when hash

  hash set / map    → membership, key/value lookup, unordered
  binary tree       → ordered iteration, range queries
  trie              → prefix lookup, autocomplete
  heap              → next-highest / next-lowest priority
  B-tree            → all of the above, but on disk pages
```

**Anchor:** "Trees earn their keep for ordered / range / prefix questions — this repo asks membership questions, so Set covers it."

**Q: You've built a BST — walk me through delete.**

Three cases. Node has no children: unlink it from its parent, done. Node has one child: replace the node with its child. Node has two children: find the *in-order successor* (leftmost node of the right subtree), copy its value into the node being deleted, then delete the successor (which now has at most one child, so it recurses into a simpler case). The successor is guaranteed to have no left child — that's why it's the leftmost — so the recursive delete terminates.

```
  BST delete — three cases

  case 1: leaf              case 2: one child          case 3: two children
    (5)                       (5)                        (5)
   /   \                     /   \                      /   \
  (3)  (7) ← delete         (3)  (7) ← delete         (3)  (7) ← delete
                                   \                       /  \
                                   (8)                    (6)  (8)

  → parent.right = null    → parent.right = (8)     → copy (6) into (7)
                                                       → delete (6) [now case 1]
```

**Anchor:** "Two-child delete = copy in-order successor's value, then delete the successor (which reduces to case 1 or 2)."

**Q: Why is a red-black tree preferred over AVL in most libraries?**

Red-black trees allow slightly more imbalance — the height ratio between longest and shortest path can be up to 2×, vs AVL's 1.5×. That looser invariant means fewer rotations per insert or delete on average. The trade is slightly deeper trees, so lookups are marginally slower, but the overall throughput on insert-heavy workloads is better. That's why C++ `std::map`, Java's `TreeMap`, Linux kernel schedulers, and a lot of language runtimes reach for red-black. Honest gap: I've read the algorithm but not implemented one from scratch — the rotation cases are the fiddly part, and knowing them cold is a specific study session away.

**Anchor:** "Red-black relaxes the balance invariant → fewer rotations on writes → better throughput on write-heavy workloads. Slightly deeper reads."

**Q: When would you reach for a trie in an app?**

Any autocomplete over a bounded key alphabet. IP-routing tables. Spell-check with edit-distance search (a trie of the dictionary makes candidate generation dramatically faster than a linear scan). In frontend, they show up in libraries like `route-recognizer` for URL routing — matching `/users/:id/posts/:pid` against a request path is a trie walk. Not in this codebase, but if you added property-name autocomplete for the event-schema UI, a trie of property names would give you O(length) lookup no matter how many properties existed.

**Anchor:** "Trie earns its keep the moment 'give me everything with this prefix' shows up as a hot path."

## See also

  → `03-stacks-queues-deques-and-heaps.md` — the heap is a tree; the array-backed representation lives there
  → `05-graphs-and-traversals.md` — trees are graphs with one root and no cycles; DFS on a tree is what these traversals actually are
  → `06-sorting-searching-and-selection.md` — the O(log n) shape that BSTs and binary search share
  → `08-dsa-foundations-practice-map.md` — the ranked plan says which of these to practice first (AVL rotations)
