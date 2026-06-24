# Trees, tries, and balanced indexes

**Industry name(s):** binary tree, binary search tree (BST), AVL / red-black / B-tree (balanced indexes), trie (prefix tree), suffix tree, k-d tree
**Type:** Industry standard · Language-agnostic

> Hierarchical, navigable structures. A tree gives you O(log N) ops when balanced, O(N) when not. A trie gives you O(M) prefix lookup where M is the key length. Balanced indexes are what databases use under the hood. **This codebase has no real tree algorithm** — the closest thing is the WorkspaceSchema nested object, which is *shaped* like a tree but never *walked* like one.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** **Not yet exercised.** The codebase has no tree algorithms, no tries, no balanced indexes. The two structures that *look* tree-like are (a) the `WorkspaceSchema` nested object literal in `lib/mcp/schema.ts` L8–L18 — an events array, each event with a properties array, plus catalogs — and (b) the React component tree the renderer builds from JSX. Neither is *walked* with a tree algorithm; the schema is read top-down with two flat loops (`for (const e of events) { for (const p of e.properties) {} }`), and the React tree is reconciled by React, not by us. The trees that *would* show up if this codebase had different requirements — file systems, comment threads, AST nodes, DOM walkers, organization charts — aren't here. This chapter teaches the foundation honestly: what trees are, when you reach for them, and what trigger would put one in this repo.

```
Zoom out — what this chapter teaches vs what the repo uses

┌─ UI band ────────────────────────────────────────────────┐
│  React component tree (managed by React, not by us)       │
│  (we don't WALK it; React reconciles it)                  │
└────────────────────────────┬─────────────────────────────┘
                             │
┌─ Schema / data ────────────▼─────────────────────────────┐
│  WorkspaceSchema (lib/mcp/schema.ts L8–L18)               │
│  — nested object literal: events[] → properties[]         │
│  — shaped like a 2-level tree                             │
│  — read with two flat for-loops (NOT a tree walk)         │
│  → close to a tree, but not a tree algorithm              │
└────────────────────────────┬─────────────────────────────┘
                             │
┌─ Everywhere else ──────────▼─────────────────────────────┐
│  flat arrays, hash maps                                   │
│  • no BST, no AVL, no B-tree                              │
│  • no trie / prefix tree                                  │
│  • no segment tree, no Fenwick tree                       │
│  • no k-d tree, no R-tree                                 │
└──────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when does the data stop being "a list of things" and become "a hierarchy of things"? And once it's a hierarchy, when do you need a *balanced* one (databases, ordered lookup) vs an *unbalanced* one (parser ASTs, file systems where structure mirrors meaning) vs a *trie-shaped* one (autocomplete, IP routing, prefix problems)? The codebase doesn't make any of these choices today because the data is shallow and the access patterns are linear. The next sections walk the three tree-family kernels (binary tree, BST/balanced index, trie) and end with an honest list of triggers that would put one in this repo.

---

## Structure pass

**Layers.** Each tree-family structure has the same three-layer stack: the **abstract shape** (every node has children; navigation is parent→child or vice versa), the **invariant** (BST: left < node < right; AVL: heights of children differ by ≤ 1; trie: edges labeled by characters), and the **observed cost** (O(log N) for balanced, O(N) worst-case for unbalanced, O(M) for trie where M is key length). The invariant is the load-bearer — strip it and the structure degrades to a flat list in disguise.

**Axis: state.** Where does each piece of data live, who navigates it, and what's preserved across operations? For a tree, the load-bearing state question is *who maintains the invariant* — the data structure (self-balancing), the caller (manual rebalance), or nobody (degrades over time). The codebase's schema-as-tree has *no* invariant beyond "events have properties," which is why it's not really a tree algorithm — there's nothing to maintain.

**Seams.** Two seams matter; both are absent here because the codebase doesn't take this on. **Seam 1: navigation by index vs by hierarchy.** In a flat array you access by `arr[i]`; in a tree you access by `node.children[i]` recursively. **Seam 2: invariant-preserving op vs invariant-breaking op.** A `set.add` is invariant-preserving; a tree `insert` may rebalance. Where these seams exist in a real tree codebase, they're where the bugs cluster.

```
Structure pass — trees, tries, balanced indexes

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Abstract shape (parent → children) · Invariant      │
│  (BST: left<right; AVL: heights±1; trie: edge=char)  │
│  · Observed cost (O(log N) balanced, O(N) not, O(M)  │
│  trie)                                                │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  state: who maintains the invariant                  │
│  (self-balancing tree / caller / nobody)             │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: navigation by index vs by hierarchy             │
│      (absent — schema is iterated, not navigated)    │
│  S2: invariant-preserving vs invariant-breaking      │
│      (absent — no invariant to preserve)             │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

```
A real tree seam — "is the lookup O(log N) or O(N)?" answered two ways

┌─ Balanced BST ─────┐    seam     ┌─ Unbalanced BST ──────┐
│  invariant: height │ ═════╪═════►│  invariant: ordering   │
│  diff ≤ constant   │  (it flips) │  only (left<right)     │
│  → O(log N) lookup │             │  → O(N) lookup if      │
│                    │             │     pathological        │
└────────────────────┘             └────────────────────────┘
        ▲                                       ▲
        └────── same axis (state), two answers ─┘
                → balanced trees are what databases ship; unbalanced
                  ones are what you get if you don't actively maintain
```

The skeleton is mapped — the rest of this file teaches the family, then ends with what would change to make one appear in this repo.

---

## How it works

### Mental model

A tree is a graph with no cycles, one root, and every non-root node having exactly one parent. The shape is recursive — a tree is either a leaf or a node with a list of subtrees, each of which is a tree.

```
              the kernel: each node points to its children

                            root
                       ┌─────┴─────┐
                       A           B
                    ┌──┴──┐     ┌──┴──┐
                    C     D     E     F      ← these are subtrees,
                  ┌─┴─┐                        themselves trees
                  G   H

  navigation:
    parent → children   (downward, natural recursion)
    child → parent      (only if you store back-pointers)

  size:        N nodes
  depth:       longest path from root to leaf
  balanced:    depth ≈ log N
  pathological: depth = N (a linked list dressed as a tree)
```

Three subfamilies cover almost every tree you meet: **plain hierarchical trees** (file systems, ASTs, DOM, comment threads — structure mirrors meaning, no balancing), **search trees** (BST, AVL, red-black, B-tree — preserve ordering invariant, balanced for O(log N) ops), and **tries** (prefix tree — edge labeled by character, used for autocomplete, IP routing, dictionary lookup).

### Move 1 — plain trees: structure mirrors meaning

A tree where the hierarchy *is* the meaning. No comparison operator, no balancing — just parents and children.

```
node:
  { value: T,
    children: Node[] }

// for navigation:
walk(node):
  visit(node.value)
  for each child in node.children:
    walk(child)             // recursive
```

**Where plain trees show up:**

- **File systems** — `/a/b/c` is a path through a tree; directory listings are children.
- **DOM and React component trees** — every element has children; React's reconciler walks them.
- **ASTs (parser output)** — every expression is a tree node with operands as children; the parser builds the tree, the evaluator walks it.
- **Comment threads** — replies are children of the comment they reply to.
- **Org charts** — each report is a child of their manager.

**Walk algorithms:** depth-first (recurse into each child fully before the next) and breadth-first (visit all children at one depth before going deeper). DFS uses the call stack (or an explicit stack); BFS uses a queue. Both are O(N) total.

```
DFS pre-order:   root, A, C, G, H, D, B, E, F
DFS post-order:  G, H, C, D, A, E, F, B, root
DFS in-order:    only meaningful for BST (left, node, right)
BFS by level:    root, A, B, C, D, E, F, G, H
```

**In this codebase: not yet exercised as an algorithm.** The schema is a 2-level tree (`events → properties`) but the access pattern is `for each event: for each property` — two flat loops, no recursion, no DFS/BFS abstraction. The schema is *shaped* like a tree but *used* like a 2D array.

### Move 2 — search trees and balanced indexes

A binary search tree (BST) is a tree where every node's value is greater than all values in its left subtree and less than all values in its right subtree. This invariant lets you find a value in O(log N) time when the tree is balanced.

```
              BST invariant

                  10
              ┌────┴────┐
              5         15
            ┌─┴─┐     ┌─┴─┐
            3   7     12  20
                       ▲
                       │
   for any node, left subtree < node < right subtree
   recursively true at every level

   find(7):    10 → 5 (less) → 7 (found)        3 comparisons
   find(13):   10 → 15 (greater) → 12 (less) → 13 (not present)
```

**The catch: balance.** If you insert sorted data into a plain BST, it degenerates into a linked list:

```
                  insert: 1, 2, 3, 4, 5  → degenerate

                  1
                   \
                    2
                     \
                      3
                       \
                        4
                         \
                          5    ← depth = N, find = O(N)
```

Real-world BSTs use a balancing strategy:

- **AVL tree** — height-balanced (children's heights differ by ≤ 1); strict invariant, more rotations per op, faster lookups.
- **Red-black tree** — looser balance (some imbalance allowed); fewer rotations per op, slightly slower lookups; what `std::map` (C++) and `TreeMap` (Java) use.
- **B-tree / B+-tree** — multi-way (each node has many children); designed for disk-block I/O; what databases (PostgreSQL, MySQL InnoDB, SQLite) use for indexes.

```
operation     plain BST (worst)   balanced BST     B-tree (disk-aware)
─────────     ─────────────────   ─────────────    ─────────────────────
find          O(N) if unbalanced  O(log N)         O(log_k N) — fewer
                                                    disk seeks
insert        O(N)                O(log N)         O(log_k N)
delete        O(N)                O(log N)         O(log_k N)
in-order      O(N)                O(N)             O(N)
  traversal
```

**Where balanced trees show up:**

- **Database indexes** — every `CREATE INDEX` builds a B-tree under the hood (Postgres, MySQL, SQLite, MongoDB).
- **`std::map`, `std::set`, Java `TreeMap`/`TreeSet`** — ordered associative containers.
- **Range queries** — "find all values between 5 and 10" — trivial in a balanced BST (in-order walk), painful in a hash map.
- **Sorted iteration** — when you need to iterate in key order without re-sorting.

**In this codebase: not yet exercised.** No use of a `TreeMap` equivalent. The closest thing is `.sort()` over an array of 30 anomalies, which is one-shot — no need for an ordered-by-default structure. The JavaScript standard library doesn't ship a balanced BST; if the codebase needed one it would reach for the `sorted-btree` npm package (or roll an array of `{key, value}` pairs kept sorted with binary insertion, which is the same idea at small N).

### Move 3 — tries (prefix trees)

A trie is a tree where *each edge is labeled by a character*, and paths from the root spell out the stored strings. Lookup is O(M) where M is the length of the key.

```
              trie storing "car", "cart", "card", "dog"

                          (root)
                         /      \
                        c        d
                        │        │
                        a        o
                        │        │
                        r        g  ★  ← "dog" terminator
                       /│\
                      t │ d
                      ★ ★ ★    ← terminators mark "this path
                                   is a complete word"

   lookup("car"):    root → c → a → r → ★?   yes → present
   lookup("ca"):     root → c → a → ★?       no → not a word
                                              (but a valid prefix)
   prefix("car"):    walk root → c → a → r, then return all
                     descendants — "car", "cart", "card"
```

**Where tries show up:**

- **Autocomplete** — type "car", get back every word starting with "car" in O(prefix length).
- **IP routing tables** — longest-prefix match for routing packets.
- **Spell checkers** — check membership in O(word length).
- **Dictionary / lexicon** — efficient storage of many words sharing prefixes (common letters share edges).

**In this codebase: not yet exercised.** No autocomplete. No prefix lookup. The closest thing is `text.match(/^(?:json)?/)` regex prefix matching — different mechanism. If the agent intent classifier (`lib/agents/intent.ts`) needed to match user input against a dictionary of known intents efficiently, a trie would fit, but the current implementation is a few regex tests.

### Move 2 variant — the BST kernel (the load-bearing tree-family example)

Even though no BST exists in this codebase, name the kernel because it's the foundation of every balanced index.

```
BST kernel
─────────────────────────────────
  invariant: at every node, left subtree < node < right subtree
  find(x):
    if x == node: return node
    if x < node:  recurse into left subtree
    if x > node:  recurse into right subtree
  insert(x):
    walk to where x would be (using find logic);
    if you fall off the tree, create a leaf there
  delete(x):
    three cases — leaf (just remove), one child (replace with child),
    two children (replace with in-order successor)
```

**Name each part by what breaks when missing:**

```
Removed                       What breaks
──────────────────────────    ─────────────────────────────────────
left < node < right            All ordering guarantees gone. find()
invariant                      becomes O(N) walk of every node.
                               In-order traversal returns garbage.

balanced height                find/insert/delete degrade to O(N)
                               for pathological insertion orders
                               (sorted, reverse-sorted). The tree
                               works but the cost is wrong.

in-order successor logic       Delete leaves a hole; subsequent
in delete                      finds may walk past the hole and
                               return wrong results.
```

**Skeleton vs hardening:**

```
SKELETON (the BST kernel)          HARDENING
─────────────────────────────      ─────────────────────────────────
left < node < right invariant      AVL rotations (height-balance)
find, insert, delete               red-black coloring rules
in-order traversal                 B-tree multi-way nodes (disk)
                                   path compression for very long
                                   chains (skip lists)
```

The kernel is the BST. Everything above (AVL, red-black, B-tree) is engineering on top to fix the balance problem. Your own portfolio (`reincodes/BinarySearchTree.ts`) implements the skeleton.

### Move 3 — the principle

**Trees are how you make navigation cheap when the data has hierarchy.** Hash maps win for unordered lookup; arrays win for sequential iteration; trees win when you need *navigation* — parent/child relationships, range queries, ordered iteration, prefix matching. The codebase doesn't need any of those today, which is why no trees show up. The day a feature needs ordered iteration over a million keys, or autocomplete over thousands of tools, you'll reach for a balanced BST or a trie.

---

## Primary diagram

The tree family — three subfamilies, their invariant, their cost, and their presence in this codebase.

```
                  THE TREE FAMILY

  ┌────────────────────┬────────────────────────┬────────────────────────┐
  │ PLAIN TREE         │ SEARCH TREE            │ TRIE (prefix tree)     │
  │                    │ (BST / AVL / B-tree)   │                        │
  ├────────────────────┼────────────────────────┼────────────────────────┤
  │ invariant: NONE    │ invariant: left<right  │ invariant: edge label  │
  │ (structure mirrors │ (and balance, if it's  │ = character; path =    │
  │  meaning)          │ a balanced variant)    │ stored string           │
  ├────────────────────┼────────────────────────┼────────────────────────┤
  │ walk:              │ find:    O(log N) bal. │ find:    O(M) where    │
  │   DFS O(N)         │          O(N) worst    │          M = key len   │
  │   BFS O(N)         │ insert:  O(log N) bal. │ insert:  O(M)          │
  │                    │ in-order: O(N)         │ prefix:  O(M + K) for  │
  │                    │                        │          K matches     │
  ├────────────────────┼────────────────────────┼────────────────────────┤
  │ used for:          │ used for:              │ used for:              │
  │ • file systems     │ • DB indexes (B-tree)  │ • autocomplete         │
  │ • DOM, React tree  │ • TreeMap/TreeSet      │ • IP routing tables    │
  │ • ASTs             │ • range queries        │ • spell check          │
  │ • comment threads  │ • sorted iteration     │ • dictionaries         │
  ├────────────────────┼────────────────────────┼────────────────────────┤
  │ in repo: NOT YET   │ in repo: NOT YET       │ in repo: NOT YET       │
  │ EXERCISED          │ EXERCISED              │ EXERCISED              │
  │ (schema is shaped  │                        │                        │
  │  like one but read │                        │                        │
  │  with flat loops)  │                        │                        │
  └────────────────────┴────────────────────────┴────────────────────────┘
```

---

## Implementation in codebase

The closest-thing-to-a-tree, named honestly, and the gaps.

### **Schema as a nested object — NOT a tree algorithm (`lib/mcp/schema.ts` L8–L18, L92–L100)**

```ts
// lib/mcp/schema.ts L8–L18
export interface WorkspaceSchema {
  projectId: string;
  projectName: string;
  events: { name: string; properties: string[]; eventCount: number }[];
  customerProperties: string[];
  catalogs: { id: string; name: string }[];
  totalCustomers: number;
  totalEvents: number;
  oldestTimestamp: number | null;
}
```

The shape is a 2-level "tree": `WorkspaceSchema → events[] → properties[]`. But look at how it's actually used:

```ts
// lib/agents/categories.ts L116–L127 (schemaCapabilities)
for (const e of schema.events ?? []) {
  set.add(e.name);
  for (const p of e.properties ?? []) set.add(`${e.name}.${p}`);
}
```

Two flat `for` loops. No recursion. No DFS. No tree navigation. The data *happens to be* a 2-level nested array; the algorithm treats it as a 2D structure and flattens it. If the schema grew to three or four levels (events → property groups → properties → property attributes), the natural rewrite would be a recursive walker — and *that* would be a tree algorithm. Today it isn't.

This is the difference between *data shaped like a tree* and *a tree algorithm*. The codebase has the first; it doesn't have the second.

### **React component tree — managed by React, not by us**

The render output in `app/page.tsx` and `components/feed/InsightCard.tsx` (etc.) produces a JSX tree, which React turns into a Fiber tree internally. React reconciles it — diffs old tree against new, computes minimal DOM mutations. We don't *write* tree-walking code; React does it for us. From the codebase's perspective, the tree is invisible.

This is worth naming because beginners sometimes count "I use React" as "I use a tree algorithm." You don't. React uses the tree algorithm; you use React.

### **No BST, no AVL, no B-tree, no trie**

Confirmed by grep: no `class.*Tree`, no `class.*Trie`, no `class.*Node` for hierarchical data, no `insert`/`delete` BST operations anywhere in `lib/` or `app/`. The user's own portfolio outside this repo (`reincodes/BinarySearchTree.ts`, `reincodes/Tree.ts`) has these — but they haven't been reached for in `blooming_insights`.

### **What would trigger reaching for a tree here?**

Three concrete triggers, ranked by likelihood:

1. **Hierarchical schemas grow.** If Bloomreach's schema added nested property groups (which is likely as the platform evolves), the flat-loop pattern in `schemaCapabilities` would become unmanageable. A recursive walker — a real tree algorithm — would be the right rewrite.

2. **Autocomplete over tools or events.** If the UI added a search box that suggested tools or event names as the user types, a trie would beat a linear regex test once the dataset grows beyond ~100 strings.

3. **Sorted, range-queried local cache.** If the TTL cache needed to answer "give me everything cached in the last 30 seconds" (range query by `expiresAt`), a balanced BST would beat the current `Map` (which can't answer range queries without iterating all entries).

None of these triggers has fired. The chapter is here because they're the structures you reach for when one does.

---

## Elaborate

### Where they come from

**Binary search tree** is one of the oldest data structures — formalized in the 1960s by P. F. Windley, A. D. Booth, and others, though the idea of binary search predates computers. **AVL tree** (Adelson-Velsky and Landis, 1962) was the first balanced BST. **B-tree** (Bayer and McCreight, 1972) was designed for disk-resident databases, where the cost of one disk seek dwarfs the cost of comparing 100 keys — multi-way nodes minimize seeks.

**Trie** is a portmanteau of "retrieval" (René de la Briandais, 1959; Edward Fredkin, 1960). The name is *supposed* to be pronounced "tree" but most people say "try" because "tree" is already taken.

### The deeper principle

**A tree imposes hierarchy on data so navigation becomes cheap.** A flat array makes you scan; a tree makes you descend. The tradeoff is invariant maintenance: every insert and delete potentially rebalances, which is the cost you pay for O(log N) ops.

**Trees vs hash maps** is the recurring choice. Hash maps win for *unordered* operations (membership, lookup by exact key). Trees win for *ordered* operations (range queries, in-order iteration, find-min/max in O(log N), nearest-neighbor by key). A `Map<K, V>` and a `TreeMap<K, V>` have the same interface but different cost profiles — pick by the access pattern.

```
operation                Hash Map        Balanced BST
─────────────────────    ────────────    ──────────────
get by exact key         O(1) avg        O(log N)
membership               O(1) avg        O(log N)
range query              O(N)            O(log N + K)
                          (scan all)      (find start + K results)
iterate in key order     O(N log N)      O(N)
                          (sort first)    (in-order walk)
min / max key            O(N)            O(log N)
                          (scan all)      (leftmost / rightmost)
```

### Where they break down

- **Unbalanced BSTs degrade to linked lists.** Sorted insertion order is the canonical bad case. Always reach for a self-balancing variant unless you can guarantee random insertion.

- **Balanced tree constants beat hash-map constants only above some N.** For N < ~1000, a sorted array with binary search is often faster than a tree because of cache locality. Don't reach for `TreeMap` for tiny data.

- **Tries are memory-heavy for small alphabets and short keys.** Each node stores pointers for every possible next character. A 26-char alphabet with 1000 short strings can blow up to megabytes of pointer overhead. Compressed variants (radix trees, Patricia tries) help.

- **B-tree fanout choice depends on hardware.** Page size, cache-line size, disk-block size — all influence the optimal branching factor. Databases tune this; you usually don't.

### What to explore next

- **Your own `reincodes/BinarySearchTree.ts` and `reincodes/Tree.ts`** — you've built these. The trigger to use them in this codebase hasn't fired. When it does, you'll port them.

- **Segment trees and Fenwick trees** — specialized tree structures for range queries (sum, min, max) over an array. Used in competitive programming, less in production code.

- **Suffix arrays and suffix trees** — for fast substring search over long texts (genome assembly, text search). Probably not relevant to this codebase but high-leverage if you do string-heavy work.

- **Persistent trees (immutable BSTs)** — functional-language data structures where every "update" returns a new tree sharing structure with the old. Used in version-control systems (Git's object database is essentially a Merkle tree of persistent objects).

---

## Interview defense

**What they are really asking.** Whether you can name the three subfamilies (plain, search-balanced, trie), give an example of each, and recognize when the data structure should be a tree vs a hash map vs an array. Senior signal: knowing that BST without balance degrades to O(N). Architect signal: explaining why databases ship B-trees and not in-memory AVL trees.

---

**[mid] "What's a binary search tree, and what does balance buy you?"**

A BST is a tree where every node's value is greater than everything in its left subtree and less than everything in its right subtree. The invariant lets you find a value in O(log N) when the tree is balanced (depth ≈ log N). Without balance, sorted-order insertion degenerates to a linked list — every node has only a right child, depth = N, find = O(N). Self-balancing variants (AVL, red-black) maintain the depth invariant through rotations on every insert/delete, paying a small constant cost per op to guarantee the log bound.

```
balanced              vs    pathological (insert 1,2,3,4,5)

      3                            1
    ┌─┴─┐                           \
    2   4                            2
    │   │                             \
    1   5                              3
                                        \
   depth=2 (~log₂5)                      4
   find=2 ops max                         \
                                           5     depth=5, find=5 ops max
```

---

**[senior] "Why do databases use B-trees instead of in-memory AVL trees for indexes?"**

Because the cost model is different. AVL trees are optimal for in-memory access where every comparison costs the same. B-trees are optimal for *disk-resident* access where one disk seek (~5 ms) costs more than 10,000 in-memory comparisons. A B-tree node holds many keys (often 100-1000) — one disk read fetches a whole node's worth, and you do a binary search within the node (fast in-memory) to pick the next pointer. Total seeks for a billion keys at fanout 100: ~log₁₀₀(10⁹) = ~5 seeks. With an AVL tree the same query would be ~30 seeks (log₂10⁹). Five vs thirty disk seeks is 6× faster.

```
  AVL tree, billion keys, disk-resident:
    ~30 disk seeks × 5 ms each = ~150 ms per lookup

  B-tree, billion keys, fanout 100:
    ~5 disk seeks × 5 ms each = ~25 ms per lookup
```

For RAM-only structures (Java's `TreeMap`, C++'s `std::map`), AVL/red-black wins — disk seeks aren't in the cost model.

---

**[arch] "This codebase has no tree algorithms. Is that a problem? What would trigger you to add one?"**

It's not a problem — the data is genuinely flat. The schema is two levels (events → properties), and the iteration pattern matches the data shape. Three triggers would change my mind: (1) the schema grows more levels and a recursive walker would be cleaner than nested loops; (2) the UI adds autocomplete over a large lexicon (tools, events, customers — anything > 100 entries with prefix lookup), at which point a trie wins decisively over linear regex; (3) the cache or store needs *range queries* (e.g. "all entries expiring in the next 30 seconds"), which a hash map cannot answer cheaply but a balanced BST answers in O(log N + K). Until one of those triggers fires, reaching for a tree is over-engineering. The skill is *recognizing the trigger when it arrives*.

```
  trigger                               structure to reach for
  ─────────────────────────────────     ──────────────────────────
  schema 3+ levels deep                 recursive walker on a
                                        plain tree
  autocomplete over 100+ strings        trie (or radix trie)
  range queries by sortable key         balanced BST (AVL/RB)
  disk-resident sorted index            B-tree
```

---

**The dodge: "but you have a nested object in your codebase — isn't that a tree?"**

Shape vs algorithm. The WorkspaceSchema in `lib/mcp/schema.ts` is *shaped* like a 2-level tree, but the code that uses it (`schemaCapabilities` in `lib/agents/categories.ts` L116–L127) is two flat `for` loops, not a recursive walker. There's no tree-navigation logic — no parent pointer, no depth tracking, no DFS/BFS choice, no balanced-invariant maintenance. Calling that "a tree algorithm" inflates the description. The honest version: the codebase has *trees as data* (nested objects, React's component tree) but doesn't *implement* a tree algorithm anywhere.

---

**Anchors (cite these in your answer)**

- `lib/mcp/schema.ts` L8–L18 — `WorkspaceSchema` interface (shaped like a tree, not walked like one)
- `lib/agents/categories.ts` L116–L127 — flat loops over the schema, the proof that no tree algorithm runs
- (No file paths for BST/trie/balanced index — these are `not yet exercised`.)

---

## See also

→ `03-stacks-queues-deques-and-heaps.md` (heap is a tree-shaped structure, but stored as a flat array — the bridge between this chapter and the previous one) · → `05-graphs-and-traversals.md` (trees are a special case of graphs — acyclic, rooted, one parent per node) · → `08-dsa-foundations-practice-map.md` (where trees rank in the practice plan)
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
