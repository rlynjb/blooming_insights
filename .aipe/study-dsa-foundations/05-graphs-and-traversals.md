# Graphs and traversals

*Graph models · BFS · DFS · shortest paths · Industry standard*

## Zoom out, then zoom in

Case B again: no graphs in the load-bearing paths of this repo. The agent's tool-call sequence is a linear list, not a branching tree of alternatives. The MCP protocol is request-response. There's no dependency graph to traverse, no shortest-path problem to solve. The primitives still matter for interviews — and you've built them exhaustively in `reincodes`. This file teaches the mechanics against your own code.

```
  Zoom out — no graph traversal in blooming_insights

  ┌─ UI ────────────────────────────────────────────────────────┐
  │  React components form a tree; you don't traverse it        │
  │  yourself (framework does)                                  │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ Agent ─────────────────▼───────────────────────────────────┐
  │  Tool calls are a *linear* sequence — one after another     │
  │  No branching, no revisits, no cycle detection              │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ Storage / config ──────▼───────────────────────────────────┐
  │  Flat records; no adjacency; no dependencies                │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Where graphs LIVE, in reincodes ──────────────────────────┐
  │                                                              │
  │  Graph.ts (adj list)                                         │
  │    · BFS + DFS traversals                                    │
  │    · Eulerian cycle/path                                     │
  │    · isGraphValidTree                                        │
  │    · numberOfConnectedComponents                             │
  │                                                              │
  │  Graph2.ts (node + edge)                                     │
  │    · weighted edges → supports Dijkstra                      │
  │    · directed / undirected                                   │
  │    · obstacle marking for grid graphs                        │
  │                                                              │
  │  PG.ts                                                       │
  │    · state-space search over river-crossing puzzle           │
  │    · implicit graph from rules                               │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** A graph is a set of nodes (vertices) and a set of edges connecting them. Trees are graphs with a root and no cycles. Trees you can walk with recursion; general graphs need a *visited set* or you loop forever. That's the one difference that matters for the traversal shape.

## Structure pass

**Layers.** Two altitudes:
  1. the *representation* (adjacency list vs adjacency matrix vs implicit)
  2. the *traversal* (BFS, DFS, Dijkstra, A*, topological)

**Axis: what does "next node to visit?" cost?** Trace it down:
  - BFS → dequeue from FIFO — O(1)
  - DFS → pop from LIFO — O(1)
  - Dijkstra → extract-min from priority queue — O(log V)
  - A* → same as Dijkstra + heuristic function call

**Seams.** The load-bearing seam is *the visited set*. Every graph algorithm has one; without it, a cycle turns the algorithm into an infinite loop. Same shape, different frontier data structure (queue for BFS, stack for DFS, heap for Dijkstra) — but *always* a visited set.

## How it works

### Move 1 — a graph is nodes + edges; a traversal is "who's next?"

You know linked lists — every node points to `next`. A tree is that with multiple `next` pointers (children). A graph is that with *any* pointers, no root, cycles allowed.

```
  Graph vs tree — the one difference that matters

  TREE (no cycles, one root):        GRAPH (cycles allowed):

         (A)                              (A) ← ← ← ← ← ┐
        /   \                            /   \          │
      (B)   (C)                        (B) → (C)        │
      / \    \                         │      │         │
    (D)(E)   (F)                       ▼      ▼         │
                                     (D) ← → (E) ─ ─ ─ ─┘

    walk with recursion              walk with visited set
    (base case = leaf)               (base case = already seen)
```

The traversal is: pick a frontier (queue, stack, or heap), pop a node, mark it visited, push its neighbors. Repeat until frontier empty. That's the entire skeleton — everything else is the choice of *which frontier*.

### Move 2 — the traversal kernel: frontier + visited set + expand

Every graph traversal has the same four parts. Naming them is the interview move.

```
  Traversal kernel — the four load-bearing parts

  1. FRONTIER          the set of nodes discovered but not yet expanded
                       BFS: FIFO queue     DFS: LIFO stack     Dijkstra: min-heap

  2. VISITED SET       nodes already expanded (or discovered, depending on variant)
                       Set<NodeId> — the ONE thing without which cycles kill you

  3. EXPAND STEP       pop a node → for each neighbor: if not visited, push to frontier
                       + record visited, + optionally track cost / parent

  4. TERMINATION       frontier is empty                       ← most common
                       OR you found the target node            ← for "shortest path"
                       OR you've expanded N nodes              ← for bounded search
```

Pseudocode for BFS — the whole primitive fits on ten lines:

```
  function bfs(start, target):
    frontier = new Queue()
    visited  = new Set()

    frontier.enqueue(start)
    visited.add(start)

    while frontier is not empty:                    ← TERMINATION
      node = frontier.dequeue()                     ← EXPAND STEP: pop
      if node == target: return "found"

      for each neighbor of node:                    ← EXPAND STEP: expand
        if neighbor not in visited:
          visited.add(neighbor)
          frontier.enqueue(neighbor)

    return "not found"                              ← frontier drained
```

**What breaks if you drop the visited set?** On a cyclic graph, you revisit nodes forever. On a DAG (acyclic directed graph), you don't loop but you do redundant work — the same node gets expanded via every path that reaches it. On a tree you'd survive without it (no cycles), but it's the one part you always add so the primitive is safe by default.

**What breaks if you drop the "if not in visited" check inside expand?** Same as dropping the visited set — you enqueue the same node multiple times, and the queue explodes.

**What breaks if you swap the FIFO for a LIFO?** You get DFS instead of BFS. Same skeleton, different order of exploration.

Your own code (from your reincodes DSA portfolio):

```ts
// reincodes/Graph.ts — the shape you own
class Graph<T> {
  private adjList: Map<T, T[]> = new Map();

  addVertex(v: T): void { /* ... */ }
  addEdge(from: T, to: T): void { /* both directions if undirected */ }

  bfs_traversal(start: T): T[] {
    const visited = new Set<T>();
    const queue: T[] = [start];
    const order: T[] = [];
    visited.add(start);
    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);
      for (const nbr of this.adjList.get(node) ?? []) {
        if (!visited.has(nbr)) {
          visited.add(nbr);
          queue.push(nbr);
        }
      }
    }
    return order;
  }

  dfs_traversal(start: T): T[] { /* same shape, stack instead of queue */ }
}
```

### Move 2 — BFS vs DFS: same skeleton, different exploration order

The picture: same graph, both traversals starting at A. Watch how the frontier grows and drains.

```
  BFS vs DFS — same graph, different order

  Graph:      A
            /   \
           B     C
          / \   / \
         D   E F   G

  BFS (queue):                  DFS (stack):
    frontier   visited            frontier   visited
    [A]        {}                 [A]        {}
    []         {A}                []         {A}
    [B,C]      {A}                [B,C]      {A}
    [C]        {A,B}              [B,F,G]    {A,C}
    [C,D,E]    {A,B}              [B,F]      {A,C,G}
    []         {A,B,C}            [B]        {A,C,G,F}
    [D,E,F,G]  {A,B,C}            [D,E]      {A,B,C,G,F}
    ...                           ...
    order: A B C D E F G          order: A C G F B E D
    (level by level)              (branch to leaf, then backtrack)
```

**When to reach for BFS:** shortest path in an unweighted graph. The first time you dequeue the target, you found it via a minimum-hop path — no other traversal can beat it.

**When to reach for DFS:** cycle detection, topological sort, connected components, "is there any path from A to B?" — anything where you don't care about the shortest path, only whether one exists.

### Move 2 — Dijkstra: BFS with a priority queue

Dijkstra's shortest-path algorithm is BFS with two changes: the frontier is a *min-heap* keyed by distance-from-start, and edges are *weighted*. That's it. Same skeleton, different container.

```
  Dijkstra — swap the FIFO for a heap, track distances

  function dijkstra(graph, start):
    dist = new Map()                              ← distance from start
    dist.set(start, 0)
    frontier = new MinHeap()                      ← keyed by distance
    frontier.insert(start, 0)

    while frontier is not empty:
      node = frontier.extractMin()                 ← nearest unexpanded
      for each (neighbor, weight) in graph.edges(node):
        newDist = dist.get(node) + weight
        if newDist < (dist.get(neighbor) ?? Infinity):
          dist.set(neighbor, newDist)              ← relaxation
          frontier.insert(neighbor, newDist)       ← or decreaseKey

    return dist
```

You built this in `reincodes` with `Graph2.ts` + `PriorityQueue.ts` — the grid-obstacle version animates each expansion. The load-bearing part beyond BFS is *relaxation*: when you discover a shorter path to a node you've already added to the frontier, you update the distance and (in the fancy version) decrease its heap key. The naive version just inserts again and lets the stale entry get popped and skipped later.

**What breaks if you use BFS instead of Dijkstra on a weighted graph?** BFS assumes every edge costs 1 — it finds the fewest-hops path, not the lowest-cost path. On a graph where a two-hop path (weights 1+1=2) beats a one-hop path (weight 10), BFS returns the wrong answer.

### Move 2 — implicit graphs: state-space search (your PG.ts)

`reincodes/PG.ts` is the state-space search over the river-crossing puzzle — a Case-A hands-on example of when a graph is *implicit*. There's no `Graph` object storing edges; each state generates its own successors on demand from the puzzle rules.

```
  Implicit graph — nodes are states, edges are rules

  state: (farmer, wolf, goat, cabbage all on left bank)
              │
              ▼
    generate successors:                     ← this replaces adj list
      · farmer + wolf cross     → (wolf: right, others: left)
      · farmer + goat cross     → (goat: right, others: left)
      · farmer + cabbage cross  → (cabbage: right, others: left)
      · farmer crosses alone    → (farmer: right, others: left)
              │
              ▼
    filter out invalid states (goat eats cabbage, wolf eats goat)
              │
              ▼
    BFS over the implicit graph → shortest solution
```

This is the shape of every search problem — 8-puzzle, N-queens (BFS over partial placements), Rubik's cube. The trick: you never materialize the whole graph; you generate it as you traverse. Space is O(states visited), not O(all possible states).

### Move 3 — the principle

**A graph algorithm is a frontier + a visited set + an expand step.** The frontier's data structure is the *only* thing that changes across BFS / DFS / Dijkstra / A*. Learn the skeleton once, and you can rebuild any variant by asking "what's the frontier?" and "what's the termination?" Everything else is bookkeeping.

## Primary diagram

The whole family — the frontier is the axis of variation, everything else stays the same.

```
  Graph traversals — same skeleton, different frontier

  ┌─ ALGO ─────┬─ FRONTIER ────┬─ TERMINATION ─────┬─ SOLVES ─────────┐
  │             │                │                    │                    │
  │  BFS        │  FIFO queue    │  target dequeued   │  shortest path,   │
  │             │                │  or empty          │  unweighted graph  │
  │             │                │                    │                    │
  │  DFS        │  LIFO stack    │  target popped     │  reachability,    │
  │             │  (or recursion)│  or empty          │  cycle detect,    │
  │             │                │                    │  topo sort         │
  │             │                │                    │                    │
  │  Dijkstra   │  min-heap by   │  target extracted  │  shortest path,   │
  │             │  distance       │  or empty          │  weighted graph   │
  │             │                │                    │                    │
  │  A*         │  min-heap by   │  target extracted  │  shortest path w/ │
  │             │  dist+heuristic│                    │  a good heuristic  │
  │             │                │                    │                    │
  │  Topo sort  │  queue of      │  empty (visits     │  dependency order,│
  │  (Kahn)     │  zero-indegree │  all reachable)    │  build systems     │
  └─────────────┴────────────────┴────────────────────┴────────────────────┘
```

All five share the four kernel parts. The frontier's data structure is what changes.

## Elaborate

Graph algorithms have deep history. Dijkstra (1959) originally intended his shortest-path algorithm to demonstrate the merits of ALGOL 60. BFS predates it — used by Moore (1959) for maze routing, independently by Lee (1961) for wire routing on printed circuits. DFS goes back further to Trémaux (~1876, before computers, for maze solving on paper).

A* (Hart, Nilsson, Raphael, 1968) is Dijkstra plus a heuristic function that estimates remaining distance to the target. When the heuristic is *admissible* (never overestimates), A* is guaranteed to find the shortest path while expanding fewer nodes than Dijkstra. This is what game AIs and route planners use — the heuristic is usually straight-line distance.

The adjacency-list vs adjacency-matrix choice: adjacency list is O(V + E) space, best for sparse graphs (most real-world graphs). Adjacency matrix is O(V²) space, O(1) edge lookup, best for dense graphs or when "is there an edge between A and B?" is a hot question. Your `Graph.ts` uses adjacency list — the right call for the puzzle-shaped graphs in `reincodes`.

Advanced topics you haven't hit yet: min-cut / max-flow (Ford-Fulkerson, Edmonds-Karp — for network flow problems), all-pairs shortest paths (Floyd-Warshall — O(V³), useful for small dense graphs), strongly-connected components (Tarjan's algorithm — one DFS pass, O(V+E)), minimum spanning tree (Prim's — Dijkstra-shaped; Kruskal's — union-find + sorted edges). None of these are in `reincodes` yet; they're common senior-interview questions.

Related reading: CLRS Part VI (graph algorithms, chapters 20-26). Sedgewick chapters 4.1-4.5. For practical use, "Algorithm Design" by Kleinberg & Tardos is the more digestible modern text.

## Interview defense

**Q: When does DFS beat BFS?**

Three cases. Cycle detection — DFS naturally leaves you at a leaf when you're done exploring a branch, so a "gray" marker on the recursion stack tells you if you've hit a back-edge. Topological sort — post-order DFS gives you the reverse topo order for free. Memory-constrained search on a deep graph — BFS's queue can hold every node at the current level (potentially exponential), while DFS's stack only holds one path at a time (linear in depth). BFS wins whenever you need shortest-path in an unweighted graph, because the first dequeue of the target is guaranteed to be minimum hops.

```
  BFS vs DFS — the tradeoff

  BFS wins:  shortest path (unweighted), level-order,
             finding the closest thing

  DFS wins:  cycle detection, topo sort, memory efficiency
             on deep graphs, "does any path exist?"
```

**Anchor:** "BFS for shortest / closest, DFS for cycles / topo / memory-efficient. Both are the same skeleton with a different frontier."

**Q: Walk me through Dijkstra with negative edges.**

You can't — Dijkstra is only correct for non-negative edge weights. The proof: Dijkstra commits when it extracts a node from the priority queue, assuming no later-discovered path can be cheaper. A negative edge breaks that assumption — a longer path with a big negative edge in it could beat the currently-shortest known path. If you need negative edges (and no negative cycles), use Bellman-Ford — it's O(V×E) but handles negatives. If there's a negative cycle, no shortest path exists (you can loop it forever), and Bellman-Ford detects that.

```
  Why Dijkstra fails on negatives

  A → B (weight 1)
  A → C (weight 4)
  B → C (weight -5)     ← negative edge

  Dijkstra path A→C: extract A, extract B (dist 1), extract C (dist 4)
                     but A → B → C = 1 + (-5) = -4 is shorter!
                     Dijkstra missed it because it "committed" to C at cost 4
```

**Anchor:** "Dijkstra commits early — that only works when no path can get cheaper. Negative edges break that; use Bellman-Ford."

**Q: You've built the graph primitives in reincodes. What's a load-bearing part people forget?**

The visited set. It's the ONE thing without which the algorithm doesn't work on cyclic graphs — you loop forever revisiting the same nodes. On a tree it's optional (no cycles), which is why some tree-DFS tutorials skip it and leave people confused when they try to apply the same code to a graph. Naming the visited set as a first-class kernel part — not an implementation detail — is the interview signal for "I've built this from scratch."

**Anchor:** "Visited set is the one part everyone forgets — it's what separates 'traverses' from 'loops forever on cycles.'"

**Q: This codebase doesn't have graphs. Where would one naturally fit?**

Two candidates. First, a *tool-dependency graph* for the agent — if certain MCP tools need to be called in a specific order (list_projects before project_id, for example), a topo-sort over the dependencies would give you a valid order and detect impossible configs. Second, an *agent conversation branch tree* if you added "try alternative reasoning paths" (like Tree of Thoughts) — each node is a partial reasoning state, DFS explores one branch, backtracks if it hits a dead-end. Neither is in the current shape of the app, but both are natural extensions that would earn a real graph.

**Anchor:** "Tool preconditions want a topo sort; Tree-of-Thoughts wants DFS with backtracking — neither is here yet."

## See also

  → `04-trees-tries-and-balanced-indexes.md` — trees are graphs with one root and no cycles; DFS on a tree = the traversals in that file
  → `03-stacks-queues-deques-and-heaps.md` — the frontier data structures live there; BFS/DFS/Dijkstra differ only by which one
  → `07-recursion-backtracking-and-dynamic-programming.md` — DFS is recursion with a graph twist; backtracking is DFS on an implicit graph
  → `08-dsa-foundations-practice-map.md` — the ranked plan says which graph gaps to practice (A*, min-cut, Tarjan's SCC)
