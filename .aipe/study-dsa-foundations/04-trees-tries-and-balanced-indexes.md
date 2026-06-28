# Trees, tries, and balanced indexes

*Hierarchies, ordered structures, prefixes — Industry standard · Case B (not exercised; taught from fundamentals + reincodes anchors)*

## Zoom out — what tree structure this repo has (none)

```
  Tree shapes in this codebase
  ────────────────────────────

  ┌─ UI layer ────────────────────────────────────┐
  │  React component tree (framework — not your    │
  │  data structure; you don't traverse it)        │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Service layer ────────▼──────────────────────┐
  │  ★ NO TREES AT RUNTIME ★                       │
  │  All data is flat:                             │
  │    - anomalies[]    (sorted array)             │
  │    - insights Map<id, Insight>                 │
  │    - schema.events[] (sorted by count)         │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Provider boundary ────▼──────────────────────┐
  │  no DB → no B-tree indexes either              │
  │  (Bloomreach indexes are remote and opaque)    │
  └───────────────────────────────────────────────┘
```

Verdict-first: **this repo has no tree data
structures at runtime.** The agent output is flat
(arrays of anomalies, arrays of recommendations); the
state is keyed by id (Maps), not nested. There's no
database, so no B-tree indexes. The React component
tree is a framework concern, not a data structure
you walk.

So this file is Case B: teach trees from
fundamentals, anchored to your `BinarySearchTree.ts`
and `Tree.ts` in the reincodes repo. The interview
surface is real even when the production code
doesn't reach for them.

## Structure pass — five tree shapes, one question

Five tree shapes, one question held constant: *"what
do the children-of-a-node represent?"*

```
  One question, five answers
  ──────────────────────────

  "what do a node's children represent?"

  ┌─ General tree (n-ary) ──────────┐
  │ children = "things nested under"│  → org chart, file system,
  │ no ordering between siblings    │    React component tree
  └─────────────────────────────────┘

  ┌─ Binary search tree ────────────┐
  │ left child < parent < right     │  → ordered set with
  │ children                        │    O(log N) search
  └─────────────────────────────────┘

  ┌─ Trie (prefix tree) ────────────┐
  │ children = "next character"     │  → autocomplete,
  │ keyed by character              │    routing tables
  └─────────────────────────────────┘

  ┌─ Heap (covered in 03) ──────────┐
  │ children = "larger than parent" │  → priority queue
  │ (min-heap)                      │
  └─────────────────────────────────┘

  ┌─ B-tree / B+-tree ──────────────┐
  │ children = "sorted ranges of    │  → database indexes
  │ keys"; many keys per node       │    (Postgres, SQLite)
  └─────────────────────────────────┘
```

The seam where these flip: **the children-ordering
contract**. BST orders by key, trie orders by
character position, heap orders by priority, B-tree
groups by range. Same tree shape — different
contract on the edges. The contract is the data
structure.

Hand off to How it works.

## How it works

#### Move 1 — the mental model

You already use trees as the *shape of files* on your
laptop: `Documents/projects/blooming/lib/state/`. Each
directory is a node, its children are subdirectories
or files. The whole filesystem is a general tree.
That's the simplest possible anchor.

```
  General tree — the simplest shape
  ─────────────────────────────────

                   root
                 ╱  │  ╲
              ╱     │     ╲
            A       B       C       ← children: any number
           ╱│╲      │
          D E F     G                ← grandchildren: same shape
```

The interesting trees in computing add a *constraint*
on which child goes where, and that constraint is the
whole magic.

```
  BST — the constraint that buys you O(log N) search
  ──────────────────────────────────────────────────

                   5
                 ╱   ╲
               3       8             ← left < parent < right
              ╱ ╲     ╱ ╲                holds RECURSIVELY
             1   4   7   9             at every node

  search for 7: 7 > 5 → right
                7 < 8 → left
                hit                ← O(log N) if balanced
```

If the tree stays balanced (left and right subtrees
roughly equal depth), search is O(log N). If it
degenerates into a linked list (insert sorted keys
into a plain BST → all-right-children), search
collapses to O(N). That's why "balanced" matters and
why production code uses self-balancing variants —
red-black trees (Java's `TreeMap`, C++ `std::map`),
AVL trees, or B-trees (databases).

#### Move 2 — the operations, anchored to reincodes

**BST insert / search / delete**

You've built this end-to-end. Anchor to the reincodes
repo:

```ts
// reincodes — BinarySearchTree.ts
class BinarySearchTree {
  insert(value)        // recursive + iterative
  search(value)        // O(log N) balanced, O(N) worst
  delete(value)        // three cases: leaf, one child, two children
  inorderTraversal()   // yields sorted order
  preorderTraversal()
  postorderTraversal()
  successor(node)      // smallest value > node
  predecessor(node)    // largest value < node
}
```

**The load-bearing skeleton — BST's irreducible
parts:**

1. **The BST property** — `left.value < node.value <
   right.value`, recursively. **What breaks without
   it:** the tree is just a binary tree; search is
   O(N) and you've gained nothing over a list.

2. **Recursive structure** — each subtree is itself a
   BST. **What breaks without it:** you can't write
   recursive operations cleanly; insert, search,
   traversal all become awkward state machines.

3. **In-order traversal yields sorted order** — this
   is the BST's secret payoff. Any time you want "all
   values in sorted order without sorting", an in-
   order walk does it in O(N). **What breaks without
   it:** you've built a slower set.

4. **Three-case delete** — leaf (just remove), one
   child (replace with child), two children (replace
   with in-order successor, then delete successor).
   **What breaks without it:** deletes leave dangling
   subtrees or break the BST property.

```
  Insert trace — inserting 6 into the BST above
  ─────────────────────────────────────────────

  start at root: 5      6 > 5 → go right
       │
       ▼
  at node 8:            6 < 8 → go left
       │
       ▼
  at node 7:            6 < 7 → go left
       │
       ▼
  left is null:         place 6 here

  result:
                   5
                 ╱   ╲
               3       8
              ╱ ╲     ╱ ╲
             1   4   7   9
                    ╱
                   6
```

**Three traversal orders — same tree, three readings**

```
  Same tree, three traversal orders
  ─────────────────────────────────

  tree:        5
             ╱   ╲
           3       8
          ╱ ╲
         1   4

  pre-order  (root, left, right):  5, 3, 1, 4, 8
                                   ▲  ← root first
                                      ← used for "copy a tree"

  in-order   (left, root, right):  1, 3, 4, 5, 8
                                            ▲ root in middle
                                   ← sorted! the BST payoff

  post-order (left, right, root):  1, 4, 3, 8, 5
                                                ▲ root last
                                   ← used for "free a tree"
                                     (children before parent)
```

You've built all three in reincodes
(`BinarySearchTree.ts`), and the general n-ary
version with generators in `Tree.ts`. The generator
version is the right pattern for arbitrary-depth
recursion when you want lazy iteration rather than
"build the full list, then return."

**Trie — the prefix tree**

A trie is a tree where edges are labeled with
characters and any path from root to a marked node
spells a word. The whole point: prefix lookup is
O(length-of-prefix), independent of how many words
are stored.

```
  Trie storing: cat, car, can, dog
  ────────────────────────────────

           root
          / | \ \
         c  d
        /    \
       a     o
      /|\     \
     t r n     g
     ★ ★ ★     ★         ★ = end-of-word marker

  search "ca": walk c → a, return all descendants
               of node "ca" → cat, car, can
               cost: O(2) for the walk, O(K) for the
               descendants where K = matching words
```

**The load-bearing skeleton — trie's irreducible
parts:**

1. **Edge per character** — typically stored as
   `Map<char, TrieNode>` or `Array<TrieNode | null>`
   of size 26. **What breaks without it:** you can't
   distinguish "cat" from "car" — they'd collapse to
   the same path.

2. **End-of-word marker** — a boolean on each node.
   **What breaks without it:** you can't tell "cat"
   (a word) from "cats" (its prefix-extension). Every
   prefix would look like a word.

3. **Recursive structure** — each subtree under a
   character node is itself a trie of the suffixes.
   **What breaks without it:** insert/search are
   imperative state machines instead of clean
   recursion.

This repo doesn't have a trie. If it grew an
autocomplete for "type a metric name," that's where
a trie would fit. On the practice list.

**B-tree — what the database does**

A B-tree is a balanced tree where each node holds
many keys (often 100-1000) and has one more child
than keys. The goal: minimize disk I/O. With branch
factor 100, a B-tree of 10 million entries is only 3
levels deep — three disk reads to find any record.

```
  B-tree shape — many keys per node
  ─────────────────────────────────

  ┌────────────────────────────────────────────┐
  │       [ 10, 20, 30, 40, 50 ]               │  ← internal node
  └──┬──┬──┬──┬──┬──┬──────────────────────────┘
     │  │  │  │  │  └─→ subtree of keys > 50
     │  │  │  │  └────→ subtree of keys 40-50
     │  │  │  └───────→ subtree of keys 30-40
     │  │  └──────────→ subtree of keys 20-30
     │  └─────────────→ subtree of keys 10-20
     └────────────────→ subtree of keys < 10

  every leaf is at the same depth
  internal nodes are kept ~half full (B-tree invariant)
  → guarantees O(log_B N) height
```

This repo has no database, so no B-tree indexes.
Bloomreach's storage on the other side of the MCP
call almost certainly uses one (Postgres, ClickHouse,
something), but it's opaque to you. The lesson stays
on the practice list: when you grow a database here,
the indexes you create *are* B-trees, and the cost
model is "one B-tree page = one disk seek = ~1ms."

#### Move 3 — the principle

A tree is "a hierarchy with a constraint on children."
Pick the constraint by the workload: BST for ordered
sets, trie for prefix queries, B-tree for disk-paged
indexes, heap for priority extraction. The constraint
determines the cost model — O(log N) when balanced,
O(N) when degenerated, O(log_B N) when packed. The
shape is generic; the constraint is the engineering.

## Primary diagram

```
  Five tree shapes — pick by the question you're asking
  ─────────────────────────────────────────────────────

  ┌────────────────────────────────────────────────────────┐
  │ workload                          shape       cost     │
  ├────────────────────────────────────────────────────────┤
  │ "nested under, no ordering"       general     O(N)     │
  │ "ordered set, search by key"      BST         O(log N) │
  │ "ordered set, MUST stay fast"     red-black/  O(log N) │
  │                                   AVL          guaranteed
  │ "search by prefix"                trie        O(L)     │
  │ "highest priority first"          heap        O(log N) │
  │ "ordered index, disk-paged"       B-tree      O(log_B N)│
  └────────────────────────────────────────────────────────┘

  blooming-insights uses NONE of these at runtime.
  Anchors for hands-on understanding live in reincodes:
    BinarySearchTree.ts   Tree.ts   BinaryHeap.ts
```

## Elaborate

The reason BSTs were invented: arrays let you search
in O(log N) but inserts are O(N). Linked lists let
you insert in O(1) but searches are O(N). BSTs are
the compromise: O(log N) for both, *if* you can keep
them balanced.

Self-balancing variants (red-black trees, AVL trees,
B-trees) solve the "if balanced" problem by re-
arranging the tree on each insert. The cost is added
complexity per operation; the win is the asymptotic
holds in the worst case. In practice you reach for a
language's built-in (Java `TreeMap`, C++ `std::map`,
Python `sortedcontainers.SortedDict`) rather than
implementing red-black trees yourself.

Tries show up in routing (URL prefixes), autocomplete
(longest matching prefix), and IP lookup
(longest-prefix-match on subnet routes). The radix
tree is a compressed trie where chains of single-
child nodes are collapsed — Linux's kernel routing
table uses a radix trie.

B-trees were invented for disk-based databases
(Bayer & McCreight, 1972) and are still the default
index structure in Postgres, MySQL, SQLite,
ClickHouse, and most relational stores. The reason
they beat BSTs on disk: a single B-tree node is one
disk page (4-16KB), and disk I/O dominates everything
— so trees with more keys per node and shallower
depth win.

For deep grounding: CLRS Chapter 12 (binary search
trees), Chapter 13 (red-black trees), Chapter 18
(B-trees). Sedgewick *Algorithms 4th Ed* §3.2-3.3.

## Interview defense

**Q: Why doesn't this repo use any tree data
structures?**

Model answer: "The workload doesn't ask for one. The
state is keyed (Maps), the data is flat (arrays of
anomalies), and there's no database — so no B-tree
indexes either. The only tree in the system is
React's component tree, which is a framework concern,
not a data structure I walk. If I grew an
autocomplete on metric names, I'd reach for a trie;
if I grew a database, I'd reach for B-tree indexes.
The recognition that these aren't needed *yet* is
part of the call. Anchors for the actual
implementations live in my reincodes repo:
`BinarySearchTree.ts`, `Tree.ts`."

**Q: Walk me through BST delete.**

```
  BST delete — three cases
  ────────────────────────

  case 1: leaf            case 2: one child       case 3: two children
  ───────────────         ─────────────────       ───────────────────
        5                       5                       5
       / \                     / \                     / \
      3   8                   3   8                   3   8
     /                       /                       / \
    1                       1                       1   4
                              \                          \
                               2                          (find successor:
                                                          smallest in right
                                                          subtree, copy
                                                          value, delete
                                                          that node)
  delete 1:               delete 1:               delete 3:
  just remove it          replace with 2          copy 4 up, delete 4
       5                       5                       5
       / \                     / \                     / \
      3   8                   2   8                   4   8
                                                       / \
                                                      1   (4 gone)
```

Model answer: "Three cases. Leaf — just unlink it,
parent's pointer becomes null. One child — replace
the node with its child, parent's pointer now points
to the grandchild. Two children — find the in-order
*successor* (smallest value in the right subtree,
which is the leftmost descendant of `node.right`),
copy its value into the node, then delete the
successor node (which is guaranteed to have at most
one child, reducing to case 1 or 2). Forgetting case
3 is the most common slip. Anchor:
`BinarySearchTree.ts` in reincodes."

**Q: What does a trie buy you that a Set of strings
doesn't?**

Model answer: "Prefix queries. `set.has('cat')` is
O(1), great. `give me every word starting with 'ca'`
on a Set is O(N) — you scan every entry. On a trie,
you walk to the 'ca' node in O(2) and yield every
descendant. The cost depends on *matches*, not on
total entries. That's why autocomplete and routing
tables use tries — the workload is prefix-shaped, and
the data structure has to match the workload."

**Q: Why is the database index a B-tree and not a
red-black tree?**

Model answer: "Disk I/O. A red-black tree has 2
children per node; a B-tree has 100-1000. For 10
million records, the red-black tree is ~24 levels
deep, the B-tree is ~3. Every level is a disk seek.
Three seeks vs twenty-four seeks is the whole story.
The B-tree was *designed* for disk; the red-black
tree was designed for in-memory ordered maps."

## See also

- `02-arrays-strings-and-hash-maps.md` — why this
  repo uses Maps everywhere instead of trees
- `03-stacks-queues-deques-and-heaps.md` — the heap
  is itself an array-backed tree
- `05-graphs-and-traversals.md` — trees are a
  special case of graphs (no cycles, one parent)
- `08-dsa-foundations-practice-map.md` — trie and
  union-find on the practice plan
