# Graphs and traversals

*Graph models, BFS, DFS, shortest paths — Industry standard · Case B (not exercised; taught from fundamentals + reincodes anchors)*

## Zoom out — graphs in this codebase (none at runtime)

```
  Graph-shaped things in this codebase
  ────────────────────────────────────

  ┌─ UI layer ────────────────────────────────────┐
  │  no graph state in components                  │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Service layer ────────▼──────────────────────┐
  │  ★ NO GRAPHS AT RUNTIME ★                      │
  │                                                │
  │  Sort-of-graph-shaped at BUILD/DESIGN time:    │
  │    - category dependencies (Set membership,    │
  │      not traversed; agents/categories.ts)      │
  │    - tool coverage (set difference, not        │
  │      reachability; mcp/tool-coverage.ts)       │
  │    - import graph (TypeScript handles it)      │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Provider boundary ────▼──────────────────────┐
  │  agent loop = LLM picks next tool — that's an  │
  │  implicit traversal, but the algorithm is the  │
  │  model's, not yours                            │
  └───────────────────────────────────────────────┘
```

Verdict-first: **this repo has no graph data
structures and no traversal algorithms in the running
code.** The closest thing is the category dependency
check — "does this category require capability X?" —
but it's a single `Set.has(...)` lookup per
dependency, not a traversal. There's no BFS, no DFS,
no shortest-path, no topological sort.

So this file is Case B: teach graphs from fundamentals,
anchored to your reincodes implementations (`Graph.ts`,
`Graph2.ts`, BFS over state spaces in `PG.ts`). The
interview surface for graphs is enormous, and you've
*built* most of it — this file makes that bridge
explicit.

## Structure pass — graph variants and the questions they answer

Three graph dimensions, one question held constant:
*"how do you find what's reachable from here?"*

```
  One question, dimensions of variation
  ─────────────────────────────────────

  "from this node, what's reachable, and how cheaply?"

  ┌─ Directed vs undirected ────────────┐
  │ directed   → edges point one way     │  e.g. import graph
  │ undirected → edges go both ways      │  e.g. friendship
  └─────────────────────────────────────┘

  ┌─ Weighted vs unweighted ────────────┐
  │ unweighted → all edges cost 1        │  → BFS finds shortest
  │ weighted   → edges carry a cost      │  → Dijkstra/Bellman-Ford
  └─────────────────────────────────────┘

  ┌─ Explicit vs implicit ──────────────┐
  │ explicit → adjacency list/matrix     │  e.g. social graph
  │ implicit → neighbors computed from   │  e.g. state-space
  │   rules at traversal time            │    search (your PG.ts)
  └─────────────────────────────────────┘
```

The seam that flips the algorithm choice: **weighted
or not**. Unweighted shortest path is BFS, dead
simple. Weighted shortest path is Dijkstra (non-
negative weights) or Bellman-Ford (any weights, but
slower). Get this wrong in an interview and the rest
of the solution is wasted.

Hand off to How it works.

## How it works

#### Move 1 — the mental model

You already think in graphs every time you debug an
import error: file A imports file B which imports
file C which imports A — *cycle*. That's a graph
problem. The reachable set from your entry point is
"all files that get bundled." The unreachable set is
"dead code." TypeScript's compiler does both with
DFS.

The anchor that works best for you (from reincodes):
your BFS visualizer lighting up cells in a grid. The
grid IS a graph — each cell is a node, each
horizontal/vertical neighbor is an edge — and BFS
sweeps outward in concentric "wavefronts."

```
  BFS — the wavefront expansion
  ─────────────────────────────

  step 0:  S . . .           start at S
           . . . .
           . . . .
           . . . G

  step 1:  S 1 . .           neighbors of S
           1 . . .             added to frontier
           . . . .
           . . . G

  step 2:  S 1 2 .           neighbors of frontier
           1 2 . .             added (if unvisited)
           2 . . .
           . . . G

  ...                        wavefront expands until
                             goal G is found
```

That picture *is* BFS. The data structure that
makes it work is a *queue* (the frontier), a *Set*
of visited nodes, and a loop: dequeue → expand →
enqueue unvisited neighbors → repeat until queue
empty or goal found.

#### Move 2 — the operations, anchored to reincodes

**Graph as adjacency list — your `Graph.ts`**

The two graph representations:

```
  Adjacency list vs matrix
  ────────────────────────

  graph:   A — B
           |   |
           C   D

  adjacency list                 adjacency matrix
  ──────────────                 ────────────────
  A: [B, C]                          A B C D
  B: [A, D]                       A [0 1 1 0]
  C: [A]                          B [1 0 0 1]
  D: [B]                          C [1 0 0 0]
                                  D [0 1 0 0]

  space: O(V + E)                 space: O(V²)
  iterate edges: O(degree)        iterate edges: O(V)
  → great for sparse graphs       → great for dense graphs
```

Anchor to reincodes:

```ts
// reincodes — Graph.ts
class Graph {
  private adjacencyList: Map<vertex, vertex[]>
  addVertex(v)
  addEdge(v1, v2)
  bfs_traversal(start): vertex[]
  dfs_traversal(start): vertex[]
  isGraphValidTree(): boolean
  numberOfConnectedComponents(): number
}
```

The adjacency list is **the right default**: most
real graphs are sparse (V vertices, ~V edges, not V²
edges), so adjacency list wins on space *and* on the
"iterate this vertex's neighbors" hot path that every
traversal needs.

**BFS — the load-bearing skeleton**

This is the algorithm to know cold. The four parts:

1. **Frontier (queue)** — the nodes to expand next,
   processed FIFO. **What breaks without it:** you'd
   need a different ordering (stack → DFS) or no
   ordering → you can't reason about distance.

2. **Visited set** — nodes you've already processed.
   **What breaks without it:** on a cyclic graph,
   you re-enqueue B from A, re-enqueue A from B, and
   never terminate.

3. **Dequeue → expand → enqueue unvisited
   neighbors** — the loop body. **What breaks without
   it:** you've described BFS without doing BFS.

4. **Termination on empty frontier** — the loop ends
   when there's nothing left to expand. **What breaks
   without it:** infinite loop, or wrong answer (you
   miss "is unreachable" as a return value).

```
  BFS pseudocode — the kernel
  ───────────────────────────

  function bfs(graph, start, goal):
    frontier = Queue([start])           // FIFO
    visited  = Set([start])             // mark BEFORE enqueue,
                                        //   not after dequeue,
                                        //   to avoid duplicate enqueues
    distance = Map([start → 0])

    while frontier is not empty:        // ← termination check
      current = frontier.dequeue()
      if current == goal:
        return distance[current]        // found, return cost
      for neighbor in graph.neighbors(current):
        if neighbor not in visited:
          visited.add(neighbor)
          distance[neighbor] = distance[current] + 1
          frontier.enqueue(neighbor)

    return UNREACHABLE                  // frontier emptied, no goal
```

**The most-forgotten part: mark visited BEFORE
enqueue, not after dequeue.** If you mark on dequeue,
multiple parents can enqueue the same node before any
of them processes it — wasted work and wrong
distances in some variants. The interview tell.

**DFS — same shape, swap queue for stack (or use
recursion)**

```
  DFS — depth-first via stack OR recursion
  ────────────────────────────────────────

  iterative                          recursive
  ─────────                          ─────────
  stack = [start]                    function dfs(node):
  visited = Set()                      visited.add(node)
  while stack not empty:               for neighbor in neighbors:
    n = stack.pop()                      if neighbor not in visited:
    if n in visited: continue              dfs(neighbor)
    visited.add(n)
    for nb in neighbors(n):
      if nb not in visited:
        stack.push(nb)

  → both yield the same DFS tree
  → recursion uses the call stack; iterative uses
     an explicit one. Same algorithm.
```

DFS is the algorithm to reach for when the question
is *"is there a path?"* or *"find any cycle"* or
*"order these by dependencies"* (topological sort).
BFS is for *"shortest path in an unweighted graph"*
or *"all nodes within distance K."*

**Dijkstra — BFS with a priority queue**

When edges have weights, BFS no longer gives shortest
path (the "fewest hops" answer is not the "lowest
cost" answer). Dijkstra is the answer for non-
negative weights.

```
  Dijkstra — the change from BFS
  ──────────────────────────────

  BFS:        frontier = Queue (FIFO)
              "next to expand = oldest in queue"

  Dijkstra:   frontier = MinHeap (priority = current cost)
              "next to expand = cheapest known so far"

  everything else is the same — visited set, expand,
  enqueue neighbors with updated cost. The data structure
  swap (Queue → MinHeap) is the entire algorithmic delta.
```

Anchor to reincodes:

```ts
// reincodes — Graph2.ts + PriorityQueue.ts
class Graph2 {
  addNode(id)
  addEdge(from, to, weight)         // weighted edges
  markObstacle(node)                // for grid pathfinding
  // Dijkstra uses PriorityQueue.ts internally
}

// PriorityQueue with updatePriority(value, newPriority)
// → enables "relax the edge" without re-inserting duplicates
```

The PriorityQueue's `updatePriority` is what makes
your Dijkstra implementation textbook-correct rather
than the lazy-Dijkstra variant (which inserts
duplicates and discards stale ones on extract).

**Implicit graph — state-space search (your `PG.ts`)**

The most underrated graph-traversal lesson: **you
don't need to materialise the graph.** If neighbors
can be *computed* from the current node, BFS still
works. Anchor:

```ts
// reincodes — PG.ts (river-crossing puzzle)
// state = (farmer_side, wolf_side, goat_side, cabbage_side)
// neighbors(state) = all states reachable by one valid move
// (no eating, no leaving wolf+goat together)
// BFS finds the shortest sequence of crossings.
```

The neighbors function *is* the graph. You never
build an adjacency list. This is the pattern that
unlocks pathfinding in puzzles, game AI, planning
agents, and (less obviously) the LLM-agent loop —
where each "state" is the conversation so far and
each "neighbor" is a possible next tool call. The
model picks the traversal; you provide the rules.

#### Move 3 — the principle

Graphs are *the* unifying data structure for
"reachability" problems. Pick the algorithm by the
edge-weight model: BFS for unweighted shortest path,
Dijkstra for non-negative weighted, Bellman-Ford for
any weights, DFS for "any path / order / cycle"
problems. The graph itself can be explicit (adjacency
list) or implicit (compute neighbors from rules) —
the traversal kernel is the same either way.

## Primary diagram

```
  Algorithm-selection table — by edge model and question
  ──────────────────────────────────────────────────────

  ┌──────────────────────────────────────────────────────┐
  │ question                          algorithm   cost   │
  ├──────────────────────────────────────────────────────┤
  │ "is there a path?"                DFS or BFS  O(V+E) │
  │ "shortest path, unweighted"       BFS         O(V+E) │
  │ "shortest path, ≥0 weights"       Dijkstra    O(E    │
  │                                                log V)│
  │ "shortest path, any weights"      Bellman-    O(V·E) │
  │                                   Ford               │
  │ "order by dependencies"           Topological O(V+E) │
  │                                   sort (DFS)         │
  │ "any cycle?"                      DFS         O(V+E) │
  │ "connected components"            DFS or BFS  O(V+E) │
  │                                   (repeated)         │
  │ "minimum spanning tree"           Prim/       O(E    │
  │                                   Kruskal     log V) │
  └──────────────────────────────────────────────────────┘

  blooming-insights uses NONE of these at runtime.
  Anchors for hands-on understanding live in reincodes:
    Graph.ts (BFS/DFS/components)   Graph2.ts (weighted)
    PG.ts (BFS over implicit state space)
```

## Elaborate

BFS and DFS were both formalised in the 1950s-60s
(Moore for maze-solving, Dijkstra for shortest path
with weights). The remarkable thing is how few
algorithms are needed to cover most graph workloads:
BFS, DFS, Dijkstra, and topological sort handle
maybe 80% of graph interview questions.

The graph algorithms that *aren't* on this file but
are worth knowing as a step beyond: A* (Dijkstra with
a heuristic, the dominant pathfinding algorithm in
games and robotics), Bellman-Ford (handles negative
weights, but slower; used in distance-vector routing
protocols), Floyd-Warshall (all-pairs shortest path,
O(V³), good for small dense graphs), Kosaraju /
Tarjan (strongly connected components).

The implicit-graph pattern (compute neighbors on the
fly) shows up in: game playing (Chess/Go state
space), constraint satisfaction (Sudoku, n-queens),
agent planning (the LLM-agent loop is literally a
graph search over conversation states), and
pathfinding in continuous spaces (sampled into a
grid).

For deep grounding: CLRS Chapters 22-26 (elementary
graph algorithms, MST, shortest paths). Sedgewick
*Algorithms 4th Ed* §4.1-4.4. The river-crossing
puzzle you implemented is a tiny version of the
"15-puzzle" / "missionaries and cannibals" class —
all solved by BFS over implicit graphs.

## Interview defense

**Q: Walk me through BFS. Name the part most people
forget.**

```
  BFS kernel — mark visited BEFORE enqueue
  ────────────────────────────────────────

  frontier = Queue([start])
  visited = Set([start])              ← mark HERE, not at dequeue

  while frontier not empty:
    n = frontier.dequeue()
    for nb in neighbors(n):
      if nb not in visited:
        visited.add(nb)               ← mark IMMEDIATELY
        frontier.enqueue(nb)
```

Model answer: "Four parts — frontier queue, visited
set, dequeue-expand-enqueue loop, termination on
empty frontier. The part people forget is *when* to
mark visited. If you mark on dequeue instead of on
enqueue, the same node can be enqueued multiple times
by different parents before any of them dequeue it.
That's wasted work and can produce wrong distances
in variants. Mark *before* enqueue. Anchor:
`Graph.ts:bfs_traversal` in reincodes."

**Q: When do you use DFS and when BFS?**

Model answer: "BFS for shortest-path-in-hops and 'all
nodes within K hops.' DFS for 'any path', 'find a
cycle', 'topological sort', and 'recursive
exploration' problems. The split is *what ordering
matters*: BFS gives you breadth-by-distance; DFS
gives you depth-by-recursion. If the question is
'shortest' and edges are unweighted, BFS. If the
question is weighted-shortest, Dijkstra. If the
question is 'is there a path' or 'order these by
deps', DFS is usually simpler."

**Q: Walk me through Dijkstra. How does it differ
from BFS?**

Model answer: "It's BFS with a priority queue instead
of a FIFO queue, and the priority is the cumulative
edge cost from the start. Initialize all distances
to infinity, distance[start]=0, push start into the
min-heap with priority 0. Pop the smallest, for each
neighbor: if `dist[current] + edge_weight <
dist[neighbor]`, update it and push/update in the
heap (the 'relax' step). Repeat until the heap is
empty or you pop the goal. The load-bearing piece
people miss: relax-and-update needs
`updatePriority(node, newDist)` on the priority
queue — my reincodes PriorityQueue keeps a value→
index Map specifically to make that O(log N) instead
of O(N). Anchors: `Graph2.ts`, `PriorityQueue.ts`."

**Q: You implemented a river-crossing puzzle as
BFS — why?**

Model answer: "The puzzle is a graph search: each
*state* is (farmer, wolf, goat, cabbage) sides, each
*edge* is a valid move, and the question is 'shortest
sequence of crossings.' Unweighted shortest path =
BFS. I never built an adjacency list — the neighbors
were computed from the move rules at traversal time.
That's the implicit-graph pattern, and it's the same
pattern that drives game AI, agent planning, and
constraint satisfaction. Anchor: `PG.ts` in
reincodes."

**Q: Why is the agent loop in blooming-insights *not*
graph search?**

Model answer: "The traversal *is* happening — each
state is the conversation, each neighbor is a possible
next tool call — but the algorithm is the LLM's, not
mine. I don't write BFS over conversation states; I
hand the model a tool schema, an iteration budget,
and a goal, and let it pick. The shape is the same
as classical search, but the policy is learned, not
algorithmic. That distinction matters: I can name the
graph structure underneath, but the code doesn't
implement a traversal — it implements a budget and a
tool registry. Anchor: AptKit's agent loop wrapped
in `lib/agents/aptkit-adapters.ts`."

## See also

- `02-arrays-strings-and-hash-maps.md` — adjacency
  list = `Map<vertex, vertex[]>`
- `03-stacks-queues-deques-and-heaps.md` — BFS needs
  a queue; Dijkstra needs a heap
- `04-trees-tries-and-balanced-indexes.md` — trees
  are acyclic, single-parent graphs
- `07-recursion-backtracking-and-dynamic-
  programming.md` — DFS is recursion in disguise
- `08-dsa-foundations-practice-map.md` — union-find,
  topological sort on the practice plan
