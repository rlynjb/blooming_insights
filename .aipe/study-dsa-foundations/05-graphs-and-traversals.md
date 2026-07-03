# Graphs and traversals

Industry names: graph, directed acyclic graph (DAG), adjacency list, BFS, DFS, topological sort, shortest path. Type: Industry standard.

## Zoom out — no graphs in the code, one graph in the data model

Nothing in this repo *executes* a graph traversal. The nearest thing to graph-shaped data is `category.requires` at `lib/agents/categories.ts:32` — an anomaly category listing which MCP tools it depends on. That's structurally a bipartite dependency graph (category ↔ tool), but it's stored as a flat array and queried with a linear filter. No adjacency list, no BFS, no DFS.

```
  Where a graph shape *could* land, but doesn't yet

  ┌─ Service layer ─────────────────────────────────┐
  │  category.requires: string[]   ← FLAT ARRAY     │
  │  (structurally a DAG: category → tools)         │
  │  currently:  requires.filter(t => !avail.has(t))│
  └─────────────────────────────────────────────────┘

  not yet exercised: adjacency list / matrix
  not yet exercised: BFS
  not yet exercised: DFS
  not yet exercised: topological sort
  not yet exercised: shortest path (Dijkstra, BFS on unweighted)
  not yet exercised: cycle detection
```

## Structure pass — the graph axis is *reachability*

Axis: **which nodes can I reach from a given start, and how far apart are they?**

- **Graph shape** — nodes and edges, directed or undirected, weighted or not.
- **Adjacency representation** — list (sparse) or matrix (dense). List is what you'll use 95% of the time.
- **Traversal discipline** — BFS (queue, level-by-level, shortest path in edges) or DFS (stack or recursion, deep first, cycle detection).

The seam is the *frontier*: BFS keeps a queue of "seen but not yet expanded" nodes; DFS keeps a stack. Same skeleton (frontier + visited set + expand step), different container. If you know that one difference, you know 80% of graph algorithms.

## How it works — the two kernels

### Move 1 — the graph kernel

A graph is a set of nodes and a set of edges between them. Edges can be directed or not, weighted or not, and the graph can have cycles or not. All the vocabulary follows from those four toggles.

```
  Graph kernel — nodes, edges, and the four toggles

       [ A ] ──► [ B ]        directed: yes
        │         │           weighted: no
        ▼         ▼           cyclic:   no (this one)
       [ C ] ──► [ D ]        connected: yes


  toggles:
    directed?    A─B means both ways vs A→B one way
    weighted?    edge carries a cost / distance
    cyclic?      cycles allowed?  (tree = graph with no cycles)
    connected?   every node reachable from every other?
```

Almost every graph algorithm you'll see is *a traversal + a state annotation*. The state annotation is what makes it interesting:

- Traverse + count edges to reach = shortest path (BFS on unweighted).
- Traverse + accumulate weights = Dijkstra (BFS + priority queue).
- Traverse + record entry/exit times = topological sort, cycle detection (DFS).

### Move 2 — the two traversal kernels

**BFS — breadth-first search, the shortest-path kernel.**

```
  BFS kernel

  frontier = queue of nodes to expand next
  visited  = set of nodes already seen

  frontier.enqueue(start)
  visited.add(start)
  while frontier not empty:
    node = frontier.dequeue()
    for each neighbor of node:
      if neighbor not in visited:
        visited.add(neighbor)              // ← BEFORE enqueue, not on dequeue
        frontier.enqueue(neighbor)

  terminates when frontier empty (no more reachable nodes)
```

The load-bearing parts, by what breaks if you remove them:

1. **`visited` set.** Drop it and you revisit nodes; on a cyclic graph, you never terminate. This is the same protection the depth cap gives in `formatError` at `lib/mcp/transport.ts:82-97` — see `04-trees-tries-and-balanced-indexes.md`.
2. **`visited.add` *before* enqueue, not on dequeue.** Do it on dequeue and the same node can enter the frontier many times before it's finally dequeued — the visited set stops enforcing uniqueness in the frontier itself.
3. **Empty-frontier termination.** BFS ends when nothing new is reachable, not when the graph is "done." This is the part people forget in interviews — name it and you signal you built the thing.

Execution trace on the toggle-graph above, starting from A:

```
  BFS trace from A

  step  frontier     visited     action
  0     [A]          {A}         init
  1     []           {A}         dequeue A, look at B, C
  2     [B, C]       {A,B,C}     enqueue B and C
  3     [C]          {A,B,C}     dequeue B, look at D
  4     [C, D]       {A,B,C,D}   enqueue D
  5     [D]          {A,B,C,D}   dequeue C, look at D (already visited, skip)
  6     []           {A,B,C,D}   dequeue D, no unvisited neighbors
  7     (empty — terminate)
```

**DFS — depth-first search, the cycle-detection kernel.**

```
  DFS kernel

  visited  = set of nodes already seen

  function dfs(node):
    if node in visited: return
    visited.add(node)
    for each neighbor of node:
      dfs(neighbor)                        // ← recursive expansion

  # or iterative with an explicit stack:
  stack = [start]
  while stack not empty:
    node = stack.pop()
    if node in visited: continue
    visited.add(node)
    for each neighbor: stack.push(neighbor)
```

The only difference from BFS is the *container* — a stack (LIFO) instead of a queue (FIFO). The visited-set rule is identical. Everything else — pre-order vs post-order actions, entry/exit timestamping, back-edge detection — sits on top of that same kernel.

### Move 2 (continued) — where a graph would land in this repo

**`category.requires` — a DAG hiding in an array** — `lib/agents/categories.ts:32`.

```ts
// lib/agents/categories.ts:31-33
export function missingFor(category: AnomalyCategory, available: Set<string>): string[] {
  return [...category.requires, ...(category.enriches ?? [])].filter((dep) => !available.has(dep));
}
```

This treats requirements as a flat list — "here are the tools this category needs; which ones are missing?" It's a one-hop check.

But structurally it's the start of a bipartite dependency graph: **category → tool**. If tools ever developed their own dependencies (tool X needs tool Y), you'd get a real DAG and would need topological-sort-shaped reasoning: "in what order can I resolve dependencies, and is there a cycle?"

Two shapes you'd reach for at that point:

**Topological sort** — the "safe order to do dependent work" answer. Kernel:

```
  Topological sort (Kahn's algorithm — BFS variant)

  in_degree = { node → count of incoming edges }
  frontier  = queue of all nodes with in_degree == 0
  order     = []

  while frontier not empty:
    node = frontier.dequeue()
    order.append(node)
    for each neighbor:
      in_degree[neighbor] -= 1
      if in_degree[neighbor] == 0:
        frontier.enqueue(neighbor)

  if len(order) != len(nodes): CYCLE DETECTED
```

Ships as-a-side-effect: if any nodes remain after the loop, there was a cycle in the graph.

**Cycle detection with DFS** — the tri-color marking pattern (white = unvisited, gray = in-progress, black = done). Encountering a gray node during DFS is a back-edge — a cycle.

The repo doesn't yet need either. Flag them and move on.

### Move 3 — the principle

Graphs generalize everything you've already met: trees are acyclic graphs, linked lists are graphs where every node has one outgoing edge. What makes graph algorithms special is the *reachability* question, and the answer always has the same skeleton — a frontier container (queue = BFS, stack = DFS, priority queue = Dijkstra) plus a visited set plus a per-node expand step. If you can name those three parts, you can rebuild any graph algorithm from scratch.

## Primary diagram — BFS vs DFS side by side

```
  Same graph, two traversals — the frontier container is the whole difference

  graph:              [ A ] ── [ B ]
                       │        │
                       │        │
                      [ C ] ── [ D ]

  BFS from A:                        DFS from A:
  frontier = QUEUE (FIFO)            frontier = STACK (LIFO)

  step  frontier  action              step  stack     action
  0     [A]       start                0     [A]       start
  1     [B, C]    dequeue A            1     [B, C]    pop A, push neighbors
  2     [C, D]    dequeue B, push D    2     [B]       pop C (went depth-first)
  3     [D, D]*   dequeue C            3     [B, D]    pop D's neighbor list
  4     [D]       dequeue D            4     [B]       pop D
  5     []        done                 5     []        pop B, done

  * visited-check keeps duplicates out

  BFS finds shortest path (in edges) — level by level
  DFS finds structure  (order, cycles) — spine by spine
```

## Elaborate

BFS and DFS both come from graph theory in the 1950s-60s (Moore's BFS, 1959, for maze routing at Bell Labs). Dijkstra's algorithm (1959) is the shortest-path variant of BFS with a priority queue — the reason `03-stacks-queues-deques-and-heaps.md` matters for graph work.

Topological sort is the underpinning of every build system (make, npm install order, terraform dependency graph), every course-prerequisite checker, and every deadlock-detection algorithm. If your codebase ever needs "here's a set of things that depend on each other, do them in the right order," reach for it.

For interviews, the graph questions that pay: **number of islands** (grid BFS/DFS), **course schedule** (topological sort), **network delay time** (Dijkstra), **word ladder** (BFS on implicit graph). Practice the BFS/DFS skeleton until you can write it without thinking; the puzzle changes but the frontier + visited + expand shape doesn't.

The interview trap: forgetting the visited set. Every interviewer knows this and asks you to trace through a cyclic graph — if you skip the set, the traversal loops. Naming it up front (before you write the loop) signals experience.

## Interview defense

**Q: There's no BFS or DFS in this repo. Talk through the kernel anyway.**

Answer: Both algorithms share the same skeleton — a frontier container, a visited set, and an expand step. BFS uses a queue and finds shortest-path-in-edges by processing level by level. DFS uses a stack (or recursion) and goes deep first, useful for cycle detection and topological ordering.

The load-bearing parts, in order: initialize frontier with the start node, initialize visited with the start; while the frontier isn't empty, pull one, mark its neighbors visited before enqueuing them, and repeat. The most-forgotten part is marking visited *before* enqueue — do it on dequeue and duplicates flood the frontier.

```
  BFS/DFS shared kernel

  frontier ← container(start)
  visited  ← set{start}

  while frontier not empty:
    node = pull from frontier
    for each neighbor:
      if neighbor not in visited:
        visited.add(neighbor)   ← BEFORE enqueue
        frontier.push(neighbor)

  container = QUEUE → BFS
  container = STACK → DFS
```

**Q: Where in this codebase does a graph shape *almost* appear?**

Answer: `category.requires` at `lib/agents/categories.ts:32`. Each anomaly category names the MCP tools it needs; today that's a flat array and the check is `requires.filter(t => !available.has(t))`. Structurally it's a bipartite graph (category → tool), and if tools ever grew inter-dependencies it'd become a DAG needing topological-sort-shaped reasoning to answer "in what order can I resolve dependencies, and is there a cycle?"

```
  Bipartite dependency graph, currently a flat list

  today:      category.requires = ["get_customer", "get_events"]  (array)
             lookup: filter over Set                              (O(n))

  tomorrow:  if tools depended on tools too:
             graph = { tool → its own deps }
             need: topological order to resolve; cycle detection
```

Anchor: `lib/agents/categories.ts:31-33`.

**Q: BFS vs DFS — pick the wrong one and what breaks?**

Answer: BFS finds shortest path in edges — pick DFS instead and you get *a* path, not the shortest. DFS finds structural properties like cycles and topological order — pick BFS instead and you can't do post-order cleanup or entry/exit timestamps. The container (queue vs stack) is the whole difference; picking the wrong one gives you the wrong invariants.

## See also

- `03-stacks-queues-deques-and-heaps.md` — the frontier container: queue for BFS, stack for DFS, priority queue for Dijkstra.
- `04-trees-tries-and-balanced-indexes.md` — trees are graphs without cycles; the visited set isn't needed.
- `07-recursion-backtracking-and-dynamic-programming.md` — DFS is naturally recursive; backtracking is DFS on a search space.
- `.aipe/study-system-design/` — where the dependency graph shape would land at the architecture level.
