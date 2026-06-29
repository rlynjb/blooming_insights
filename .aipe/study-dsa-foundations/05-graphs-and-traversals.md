# Graphs and Traversals

Graph · directed / undirected · adjacency list · BFS · DFS · shortest path · topological sort — Industry standard

## Zoom out — where this concept lives

**Not yet exercised** in the running code. There is no explicit graph data structure in `blooming_insights`, no BFS, no DFS, no topological sort, no shortest-path algorithm. The closest thing to a graph is the **categories → required-events dependency map** in `lib/agents/categories-legacy.ts` — that's a bipartite relation, not a graph the code traverses. The agent loop runs as a flat `for` (file 07), not a graph walk.

```
  Zoom out — where a graph would fit (none exercised today)

  ┌─ UI (browser) ─────────────────────────────────────────────────┐
  │  (no graph walked)                                              │
  └────────────────────────────────────────────────────────────────┘
  ┌─ Service ──────────────────────────────────────────────────────┐
  │  ★ where a graph WOULD live ★                                   │
  │  categories ↔ required-events: bipartite relation, but the     │
  │  code answers "are all my requires present?" by Set.has,       │
  │  not by graph traversal. it's a one-step lookup, not a walk.   │
  │                                                                 │
  │  hypothesisspace exploration: the agent loop COULD be modeled  │
  │  as graph search (state = messages so far; edge = next tool    │
  │  call). today it's a flat for-loop with no branching.          │
  └────────────────────────────────────────────────────────────────┘
  ┌─ Storage (Bloomreach) ─────────────────────────────────────────┐
  │  (opaque)                                                       │
  └────────────────────────────────────────────────────────────────┘
```

Cross-link: you have BFS, DFS, Dijkstra, valid-tree check, connected-components, Eulerian cycle, and a river-crossing state-space search already implemented in `reincodes` (`Graph.ts`, `Graph2.ts`, `PG.ts`). The teaching here is to keep those sharp — they're your interview asset — and to name the seam where a graph *would* land in `blooming_insights` if the surface grew.

## Zoom in — the concept

A graph is a set of **nodes** (vertices) connected by **edges**. The two questions you ask of a graph are:

1. "From here, what can I reach?" — answered by traversal (BFS / DFS).
2. "What's the cost to get there?" — answered by shortest-path (Dijkstra / Bellman-Ford / A*).

That's the whole subject. Every other graph algorithm — topological sort, connected components, cycle detection, MST, max-flow — is built on top of those two primitives.

`blooming_insights` doesn't run either question on any data structure today. But almost every interesting backend problem turns into a graph eventually: dependency resolution, build systems, social networks, routing, scheduling, package managers, knowledge graphs, agent state-space search.

## Structure pass — layers · axes · seams

One axis traced: **how is the graph stored, and what does that cost for each operation?**

```
  one axis — "stored as what, costing what?"

  ┌─ adjacency list ─────────────────────────────────────────────┐
  │   Map<nodeId, nodeId[]>                                       │
  │   space:           O(V + E)                                   │
  │   has-edge?:       O(deg(v))  (scan neighbors)                │
  │   iterate edges:   O(deg(v))                                  │
  │   good for:        sparse graphs (most graphs in the wild)    │
  └──────────────────────────────────────────────────────────────┘
  ┌─ adjacency matrix ───────────────────────────────────────────┐
  │   boolean[V][V]                                                │
  │   space:           O(V²)                                       │
  │   has-edge?:       O(1)                                        │
  │   iterate edges:   O(V) per node                               │
  │   good for:        dense graphs, fast edge-existence queries   │
  └──────────────────────────────────────────────────────────────┘
  ┌─ edge list ──────────────────────────────────────────────────┐
  │   [{from, to, weight}, ...]                                    │
  │   space:           O(E)                                        │
  │   has-edge?:       O(E)  (scan list)                           │
  │   good for:        algorithms that walk all edges (Kruskal's,  │
  │                    Bellman-Ford), or as initial input format   │
  └──────────────────────────────────────────────────────────────┘
```

- **layers**: not exercised — no graph layer exists.
- **axis**: storage shape. Each shape trades a different cost.
- **seam**: the boundary between "do I want fast edge existence?" (matrix) and "do I want to walk neighbors?" (list). Most working code wants the list — graphs in the wild are almost always sparse.

## How it works

### Move 1 — the mental model

A graph is **a hash map from each node to its list of neighbors** (the adjacency-list representation, which is what 90% of working code uses). That's it. Everything else — traversal, shortest path, topological order — is "given this map, what can I compute?"

You've built this exact structure in `reincodes/Graph.ts`. The teaching here uses pseudocode (file format prefers pseudocode where the concept is language-agnostic).

```
  graph — the kernel

  type Graph = Map<NodeId, NodeId[]>

  the entire abstract data structure:
     addNode(id):             g.set(id, [])
     addEdge(from, to):       g.get(from).push(to)
                              g.get(to).push(from)    // undirected only
     neighbors(id):           g.get(id)

  every algorithm below operates over this one shape.
```

BFS explores level by level using a **queue**: dequeue a node, enqueue its unvisited neighbors. DFS explores as far as possible down one branch using a **stack** (or recursion's implicit call-stack): pop a node, push its unvisited neighbors. Both are O(V + E) — every node visited once, every edge inspected once.

```
  BFS — the pattern

  start state:    frontier = queue([start])
                  visited  = set({start})

  while frontier not empty:
    node = frontier.dequeue()
    for each neighbor of node:
      if neighbor not in visited:
        visited.add(neighbor)
        frontier.enqueue(neighbor)

  termination: when frontier is empty
```

### Move 2 — the moving parts

#### the load-bearing skeleton of BFS

Three parts. Drop any one and the algorithm becomes wrong.

```
  BFS kernel — what BREAKS when each part is missing

  1. frontier (queue)    — without it: no place to track "to visit next"
                           you can't explore beyond the start

  2. visited (set)       — without it: on a cyclic graph the algorithm
                           revisits nodes infinitely and never terminates
                           on a tree (acyclic) you "get away with it" but
                           do exponential work re-exploring shared subtrees

  3. termination test    — without checking frontier empty: infinite loop
                           on a cycle (combined with missing visited)
                           or undefined exit on a finite graph

  + the FIFO discipline of the queue is what makes it BFS rather than DFS.
    swap to a stack (LIFO) and the SAME algorithm becomes DFS.
```

The interview hook: name the **visited set** as the part people forget. New-grad implementations of BFS routinely ship without it, work fine on the test tree, and blow up the first time someone hands them a cyclic graph. **Saying "the visited set is what guarantees termination on a cyclic graph" signals you've built BFS, not just read about it.**

Bridge from what you know: you've shipped this. `reincodes/Graph.ts:bfs_traversal` walks this kernel. The frontier-queue + visited-set pattern is the same shape as any breadth-explorer you've coded — a file-system walker, a comment-thread expander, a "find all reachable users" query.

#### BFS vs DFS — same structure, two questions

```
  same skeleton, swap the data structure

  BFS (queue, FIFO):              DFS (stack, LIFO):
    frontier.enqueue(neighbor)     frontier.push(neighbor)
    node = frontier.dequeue()      node = frontier.pop()

  what BFS gives you:             what DFS gives you:
    - shortest path in unweighted    - cycle detection (back edge)
      graphs (level = distance)      - topological sort (reverse post-order)
    - level-by-level exploration     - strongly connected components
    - "closest" reachable node       - "deepest" reachable node first
```

The choice depends on the **question** you're answering. "Is there ANY path?" — either works, BFS is safer (won't infinite-loop down a long branch first). "What's the SHORTEST path in an unweighted graph?" — BFS. "Topological sort of a DAG?" — DFS with post-order. "Find a cycle?" — DFS with a stack of currently-on-this-path nodes.

#### shortest path — Dijkstra's pattern

You have this in `reincodes/Graph2.ts` driving the Dijkstra animation that uses your priority queue. The pattern, in pseudocode:

```
  Dijkstra — the pattern (single-source shortest path, non-negative weights)

  distances = Map<node, ∞>;   distances[source] = 0
  pq        = PriorityQueue;  pq.insert(source, 0)
  visited   = Set

  while pq not empty:
    (node, dist) = pq.extractMin()
    if node in visited: continue
    visited.add(node)
    for each (neighbor, weight) in neighbors(node):
      newDist = dist + weight
      if newDist < distances[neighbor]:
        distances[neighbor] = newDist
        pq.insert(neighbor, newDist)

  termination: when pq is empty
```

Dijkstra is BFS with a **priority queue** instead of a regular queue — the next node to visit is the one with the smallest tentative distance, not the next one enqueued. **The data structure swap (queue → priority queue / heap) is what turns "shortest in unweighted" (BFS) into "shortest in weighted" (Dijkstra).** Cost: O((V + E) log V) with a binary heap.

```
  the family — BFS, Dijkstra, A*, all the same shape

  ┌──────────────┬──────────────────┬───────────────────────────────┐
  │ algorithm    │ data structure   │ priority function              │
  ├──────────────┼──────────────────┼───────────────────────────────┤
  │ BFS          │ queue (FIFO)     │ insertion order (== distance   │
  │              │                  │ in unweighted graphs)          │
  │ Dijkstra     │ min-priority Q   │ distance from source           │
  │ A*           │ min-priority Q   │ distance from source +         │
  │              │                  │ heuristic to goal              │
  │ Best-first   │ min-priority Q   │ heuristic only                 │
  └──────────────┴──────────────────┴───────────────────────────────┘

  same kernel: explore-from-frontier, mark visited, expand neighbors
  the only knob: how the frontier picks the next node
```

This is the **load-bearing self-similarity** of graph search: one kernel, parameterized by a comparator. When you can say "BFS is Dijkstra with all weights equal to 1," you've collapsed two algorithms into one — that's the strongest version of the layered-decomposition move.

#### where a graph would land in `blooming_insights`

Two plausible places, neither built:

- **categories with dependencies** — today `categories.requires` is a flat list of event names checked against a Set. If categories ever had inter-category dependencies ("show 'revenue drop' analysis only after 'conversion drop' analysis completes"), that's a DAG and topological sort is the right tool to compute the run order.
- **agent state-space search** — today the agent loop is a flat for: ask Claude, run tool calls, repeat. If you ever wanted "explore multiple hypothesis branches in parallel and pick the highest-confidence one," that's a graph (state = conversation so far; edge = next tool call) and either BFS by turns or best-first with a confidence heuristic is the right structure.

Neither is built. The interview surface is the part to drill — see file 08.

### Move 3 — the principle

A graph is a hash map from each node to its neighbors. Traversal is **explore-from-frontier + mark-visited**, with the data structure of the frontier deciding the order (queue → BFS; stack → DFS; priority queue → Dijkstra / A*). One pattern, three names. **Learn the kernel; the algorithms are parameter choices.**

## Primary diagram

The recap — what's not exercised, the kernel you've shipped in `reincodes`, and the family map.

```
  graphs in blooming_insights — the empty shelf
  (the work lives in your reincodes portfolio; interview surface stays
   sharp by drilling there, not by retrofitting here)

  NOT YET EXERCISED in any layer of the running code.

  ┌─ where a graph WOULD land if the surface grew ─────────────────┐
  │  · category dependencies → topological sort over a DAG          │
  │  · agent multi-hypothesis exploration → best-first search       │
  │  · neither built today; the agent loop is a flat for            │
  └────────────────────────────────────────────────────────────────┘

  ┌─ the kernel you've already shipped (reincodes) ────────────────┐
  │                                                                 │
  │   frontier = queue([start])         ← data structure decides    │
  │   visited  = set({start})              the family member        │
  │                                                                 │
  │   while frontier not empty:                                     │
  │     node = frontier.dequeue()       ← FIFO  → BFS               │
  │                                       LIFO  → DFS               │
  │                                       min-PQ → Dijkstra         │
  │     for neighbor of node:                                       │
  │       if not in visited:                                         │
  │         visited.add(neighbor)                                   │
  │         frontier.enqueue(neighbor)                              │
  │                                                                 │
  │   termination: frontier empty                                   │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘

  ┌─ the family — same kernel, different frontier ────────────────┐
  │   BFS         queue                  shortest in unweighted    │
  │   DFS         stack (or recursion)   topological sort, cycles  │
  │   Dijkstra    min-priority queue     shortest in weighted      │
  │   A*          min-PQ + heuristic     shortest, heuristic guide │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The graph as a formal object goes back to Euler's 1736 paper on the Seven Bridges of Königsberg — the first published graph theory result, and the question was "can you walk every bridge exactly once?" (an Eulerian path problem, which you've coded in `reincodes/Graph.ts`).

**BFS** is Moore (1959), in the context of finding the shortest path through a maze. **DFS** is older as a search strategy but was formalized by Tarjan in the 1970s alongside his cycle and strongly-connected-components algorithms (Tarjan's SCC, 1972 — the canonical DFS application). **Dijkstra** is 1959, allegedly designed in 20 minutes while drinking coffee with his fiancée — the original paper used it to find the shortest train route from Rotterdam to Groningen.

**Where graphs come up in real engineering work** (not just interviews): dependency resolution (npm, cargo, apt), build systems (make, bazel — the build graph is a DAG, topological sort schedules the work), git's commit history (a DAG; rebase walks it), social network features ("friends of friends" = BFS at depth 2), routing (the internet is a graph; OSPF is Dijkstra), serverless cold-start dependency loading, garbage collection (the heap is a graph; mark-and-sweep is DFS).

The interview reflex: when a problem mentions **"dependency," "reachable," "shortest," "ordering with constraints," or "connected"** — that's a graph problem, and the first move is to name the nodes and edges explicitly before reaching for an algorithm.

Read next: file 06 (binary search, which is BST-flavored on a sorted array), file 07 (recursion, which is implicit DFS over the call stack), file 08 (where BFS/DFS/Dijkstra rank in the practice plan — high, because every AI-engineering interview eventually asks for one).

## Interview defense

### Q: BFS vs DFS — when do you pick which?

Same kernel (frontier + visited), different data structure for the frontier (queue → BFS, stack → DFS). Pick by the question:

- **shortest path in an unweighted graph** — BFS. The first time BFS reaches a node, the level you reached it on IS the shortest path (in number of edges). DFS doesn't guarantee that.
- **detect a cycle** — DFS. Walk with a "currently on this path" set; if you see a node already on the path, you've found a back edge.
- **topological sort of a DAG** — DFS post-order, then reverse. The post-order finishes a node after all its descendants, so reversing gives you "dependencies before dependents."
- **memory** — BFS holds the entire frontier (one level wide) in memory; in a wide graph that's huge. DFS holds the path depth. For very wide / shallow graphs, DFS is cheaper; for very deep / narrow graphs, BFS is cheaper.

```
  the load-bearing thing to NOT forget

  the visited set. without it, BFS or DFS on a cyclic graph
  loops forever. on a DAG you "get away with it" but pay
  exponential time re-exploring shared subtrees.

  saying this — that the visited set is what makes the
  algorithm terminate — signals you've built it, not just
  read about it.
```

Anchor: your `reincodes/Graph.ts:bfs_traversal` and `:dfs_traversal`.

### Q: Why a priority queue for Dijkstra and not a regular queue?

Because edge weights aren't all equal. BFS works on unweighted graphs (or graphs where all weights are 1) because **insertion order equals distance from source** — the next node out of the queue is always the next-closest unvisited node. The moment weights vary, that breaks: a node enqueued early might be reachable via a shorter weighted path discovered later.

The priority queue fixes this: always extract the node with the **smallest tentative distance**, so when you finalize a node you can be sure you've found the shortest path to it (because every other path to it would have to go through a not-yet-extracted node, which has a larger distance).

```
  the bug a regular queue would have on weighted edges

  graph:   A --1--> B
           A --10--> C --1--> B

  BFS from A:  enqueue A, dequeue → enqueue B, C
                (B reached, dist=1)
                dequeue B → done with B at dist=1   ← correct

  same graph, but now A --1--> B and A --10--> B (two edges):
   regular queue still works because BFS-by-edges = right answer for hops.

  graph:   A --10--> B
           A --1-->  C --1--> B

  BFS from A (treating as unweighted): B reached in 1 hop, dist labeled 10
  but the real shortest weighted path is A→C→B, total 2.
  BFS gives you the wrong answer.

  Dijkstra: pq starts with (A, 0). extract A.
            enqueue (B, 10), (C, 1).
            extract C (smallest). enqueue (B, 2).
            extract B (smallest, dist=2).  ← correct.
```

Cost: O((V+E) log V) with a binary heap. With a Fibonacci heap it's O(E + V log V), better asymptotically but the constants kill it in practice.

Anchor: your `reincodes/Graph2.ts` with `PriorityQueue.ts` driving the Dijkstra animation.

### Q: When would a graph land in `blooming_insights`?

Two real candidates, neither built:

- **category dependencies** — today `categories.requires` is a flat event-name list checked against a Set. If categories ever depended on each other ("don't run 'revenue drop' until 'conversion drop' produced an answer"), that's a DAG and **topological sort** computes the run order. Cycle detection would warn at config time on bad inputs.
- **agent multi-hypothesis search** — today the agent loop is a flat `for` (one path through). If you wanted the agent to fork — explore "is this a tracking bug?" and "is this a real revenue drop?" in parallel, then pick the higher-confidence branch — that's a **search tree** (state = conversation so far; edge = next tool call) and you'd reach for best-first search with a confidence heuristic.

Neither exists today. **The honest answer in an interview**: "the codebase doesn't exercise graphs yet, but I've shipped BFS, DFS, and Dijkstra in my reincodes portfolio, and the second place a graph would land here is the agent loop the moment we want branching exploration instead of linear conversation." That's both honest and a hook into your shipped work.

Anchors: `lib/agents/categories-legacy.ts` (the flat dep list today), `lib/agents/base-legacy.ts:114` (the flat for-loop agent today), `reincodes/Graph.ts` and `reincodes/Graph2.ts` (your shipped graph work).

## See also

- 03-stacks-queues-deques-and-heaps.md — the frontier data structures that decide BFS vs DFS vs Dijkstra.
- 04-trees-tries-and-balanced-indexes.md — a tree is a graph with extra rules (acyclic, connected, one parent).
- 07-recursion-backtracking-and-dynamic-programming.md — DFS via recursion uses the implicit call stack as the frontier.
- 08-dsa-foundations-practice-map.md — where BFS/DFS/Dijkstra rank in the practice plan (top tier).
