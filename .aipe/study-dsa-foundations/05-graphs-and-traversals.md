# Graphs and traversals

**Industry name(s):** graph (directed / undirected, weighted / unweighted), adjacency list / adjacency matrix, BFS (breadth-first search), DFS (depth-first search), Dijkstra (shortest path), topological sort, union-find
**Type:** Industry standard · Language-agnostic

> Graphs are how you model relationships that aren't strictly hierarchical: dependencies, social networks, road networks, references, tool dependencies. BFS gives shortest path in unweighted graphs; Dijkstra gives shortest path with weights. **This codebase has no graph algorithm** — the closest thing is the fixed-sequence bootstrap chain in `lib/mcp/schema.ts`, which is a *pipeline*, not a traversal.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** **Not yet exercised.** There is no graph data structure in this codebase, and no traversal algorithm. The two things that *look* like they might be graphs are: (a) the MCP bootstrap chain in `lib/mcp/schema.ts` L151–L192 (`list_cloud_organizations` → `list_projects` → 4 schema tools), which is a fixed-order sequence not a traversal; and (b) the agent dispatch in `lib/agents/intent.ts` and the briefing route, which is also a fixed sequence (monitoring → diagnostic → recommendation) — straight-line orchestration, no branching, no cycles, no "next node to visit" logic. The codebase is *flat*. Graphs are absent because the relationships in the data are flat — anomaly to evidence, diagnosis to anomaly, recommendation to diagnosis, all 1-to-1 or 1-to-N from the source. This chapter teaches the graph foundation honestly and names what would trigger one to appear.

```
Zoom out — what this chapter teaches vs what the repo uses

┌─ Bootstrap chain ─────────────────────────────────────────┐
│  lib/mcp/schema.ts L151–L192                              │
│  list_cloud_organizations → list_projects → 4 schema tools│
│  → FIXED ORDER, not a traversal                           │
│  → no "what's the next tool to call" decision             │
└────────────────────────────┬─────────────────────────────┘
                             │
┌─ Agent pipeline ───────────▼─────────────────────────────┐
│  briefing route / intent.ts                              │
│  monitoring → diagnostic → recommendation                 │
│  → FIXED ORDER, not a traversal                           │
└────────────────────────────┬─────────────────────────────┘
                             │
┌─ Everywhere else ──────────▼─────────────────────────────┐
│  flat arrays, hash maps                                   │
│  • no adjacency list / adjacency matrix                   │  ← not yet exercised
│  • no BFS / DFS                                           │  ← not yet exercised
│  • no Dijkstra / A* / Bellman-Ford                        │  ← not yet exercised
│  • no topological sort                                    │  ← not yet exercised
│  • no union-find / connected components                   │  ← not yet exercised
└──────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when does the data stop being a flat list and become a *graph* — a set of nodes with many-to-many relationships, possibly with cycles, possibly weighted, possibly directed? The answer is when you can ask any of: "what's connected to what?" (BFS/DFS), "what's the shortest path?" (BFS unweighted, Dijkstra weighted), "what's a valid order to process these dependencies?" (topological sort), "are these two things in the same connected component?" (union-find / DFS). The codebase asks none of these questions today. The next sections walk the three load-bearing kernels (representation, BFS, DFS) and end with the triggers that would put a graph in this repo.

---

## Structure pass

**Layers.** Every graph problem has the same three-layer stack: the **representation** (adjacency list = Map<node, neighbors[]>, adjacency matrix = N×N boolean array), the **traversal frontier** (queue for BFS, stack for DFS, priority queue for Dijkstra), and the **visited set** (Set<node> — the load-bearer that prevents revisits and infinite loops on cyclic graphs). Drop the visited set and BFS on a cyclic graph never terminates. Get the representation wrong (matrix when N is huge and sparse) and you blow space.

**Axis: state.** Where does the graph live (in memory, on disk, distributed), who owns the visited set (the traversal call, a global registry), and what's stored per node? For most graph problems the load-bearing state question is *how do you mark a node as visited* — a hash set, a boolean array indexed by node ID, a field on the node itself. Get this wrong and you either revisit nodes (wrong cost, wrong answer) or fail to clean up between traversals (stale visited marks contaminate the next run).

**Seams.** Two seams matter; both are absent here because the codebase doesn't take this on. **Seam 1: tree vs graph (acyclic vs cyclic).** A tree traversal doesn't need a visited set (no cycles); a graph traversal does. **Seam 2: unweighted vs weighted shortest path.** Unweighted: BFS, O(V+E). Weighted with non-negative weights: Dijkstra, O((V+E) log V) with a heap. Negative weights: Bellman-Ford, O(V·E). Picking the wrong algorithm for the wrong weights gives wrong answers (Dijkstra on negative weights produces wrong shortest paths).

```
Structure pass — graphs and traversals

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Representation (adj list / adj matrix) · Frontier   │
│  (queue/stack/heap) · Visited set (Set or boolean    │
│  array)                                              │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  state: where the graph lives, how visited is        │
│  tracked, what's stored per node                     │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: tree vs graph (no cycles vs cycles)             │
│      — absent (no graph at all in this codebase)     │
│  S2: unweighted vs weighted shortest path            │
│      — absent (no shortest path problem here)        │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

```
A real graph seam — "BFS or DFS?" answered two ways

┌─ BFS (queue) ──────┐    seam     ┌─ DFS (stack) ─────────┐
│  frontier: queue   │ ═════╪═════►│  frontier: stack       │
│  explore by levels │  (it flips) │  explore by paths      │
│  shortest path in  │             │  doesn't give shortest │
│  unweighted graph  │             │  path; useful for cycle│
│                    │             │  detection, topo sort  │
└────────────────────┘             └────────────────────────┘
        ▲                                       ▲
        └────── same axis (state), two answers ─┘
                → picking the wrong frontier costs you correctness,
                  not just performance
```

The skeleton is mapped — the rest of this file teaches the family and ends with triggers.

---

## How it works

### Mental model

A graph is a set of nodes (vertices) connected by edges. Edges can be directed (one-way) or undirected (both ways), weighted (with a number) or unweighted. Trees are a special case: connected, acyclic, undirected with a chosen root.

```
              undirected, unweighted graph

                  A ──── B
                  │      │
                  │      │
                  C ──── D
                  │
                  E

              representation as an adjacency list:

                A → [B, C]
                B → [A, D]
                C → [A, D, E]
                D → [B, C]
                E → [C]

              questions you can ask:
              • is X reachable from Y?    (BFS / DFS)
              • shortest path X → Y?       (BFS unweighted, Dijkstra weighted)
              • are X and Y in the same    (DFS / union-find)
                connected component?
              • is there a cycle?          (DFS with visited+in-progress states)
              • valid processing order?    (topological sort, DAG only)
```

The three load-bearing operations are: **represent** the graph (almost always adjacency list — `Map<node, neighbors[]>` — unless the graph is dense, in which case matrix), **traverse** it (BFS or DFS), **track visited** (Set, indexed boolean, or marked node). Everything else (Dijkstra, A*, Bellman-Ford, topo sort, union-find) is a specialization built on top of these three.

### Move 1 — graph representation

**Adjacency list** (almost always the right answer):

```
adjList: Map<NodeId, NodeId[]>

example:
  adjList.get('A') = ['B', 'C']
  adjList.get('B') = ['A', 'D']

space: O(V + E) — one entry per node + one entry per edge
neighbors of X: O(degree(X)) — direct access
edge exists X→Y: O(degree(X)) — scan X's neighbor list
```

**Adjacency matrix** (use only when graph is dense):

```
adjMatrix: boolean[V][V]   (or number[V][V] for weights)

space: O(V²) — even for sparse graphs
neighbors of X: O(V) — scan row X
edge exists X→Y: O(1) — matrix[X][Y]
```

For most real-world graphs (social networks, road networks, dependency graphs, web graphs), the adjacency list wins because they're sparse — average degree is much smaller than V. The matrix wins only when the graph is dense (E ≈ V²) or when O(1) edge-exists is critical.

```
representation         space      neighbors      edge-exists
─────────────────      ──────     ─────────      ────────────
adjacency list         O(V+E)     O(deg)         O(deg)
adjacency matrix       O(V²)      O(V)           O(1)

picking heuristic: adjacency list unless dense or O(1) edge-test is needed
```

### Move 2 — BFS (breadth-first search)

BFS visits nodes in increasing distance from a starting node. Uses a **queue** as the frontier. The visited set prevents revisiting. The discovery order is by *level* — all distance-1 nodes before any distance-2 node, etc. That property is what makes BFS find shortest paths in unweighted graphs.

```
BFS kernel:
  visited = Set()
  queue   = [start]
  visited.add(start)

  while queue not empty:
    node = queue.dequeue()
    visit(node)
    for each neighbor in adjList.get(node):
      if neighbor not in visited:
        visited.add(neighbor)
        queue.enqueue(neighbor)
```

```
BFS execution trace — start at A on this graph:

                  A ──── B
                  │      │
                  C      D
                  │
                  E

  Step  queue        visited       just-visited
  ────  ──────────   ──────────    ───────────────
  init  [A]          {A}           —
  1     [B,C]        {A,B,C}       A    ← expand A → enqueue B,C
  2     [C,D]        {A,B,C,D}     B    ← expand B → D not visited, enqueue
  3     [D,E]        {A,B,C,D,E}   C    ← expand C → E not visited, enqueue
                                          (D already visited — skip)
  4     [E]          {A,B,C,D,E}   D    ← expand D → all neighbors visited
  5     []           {A,B,C,D,E}   E    ← expand E → all neighbors visited

  visit order: A, B, C, D, E
  distance from A: A=0, B=1, C=1, D=2, E=2
```

**Cost:** O(V + E) — each node enqueued once, each edge inspected once.

**Where BFS shows up:**
- **Shortest path in unweighted graph** — first time you reach the target, you're on a shortest path.
- **Web crawling** — explore the web "near a seed URL first."
- **Social network "degrees of separation"** — friend-of-friend-of-friend.
- **Word ladder puzzles** — shortest sequence of word changes.
- **Bipartite-ness check** — color nodes alternately by BFS level.

### Move 3 — DFS (depth-first search)

DFS visits nodes by going as deep as possible before backtracking. Uses a **stack** as the frontier (or recursion, which uses the call stack implicitly). Same visited set. The discovery order is by *depth* — first child of first child of first child, etc.

```
DFS kernel (recursive):
  visited = Set()

  dfs(node):
    if node in visited: return
    visited.add(node)
    visit(node)
    for each neighbor in adjList.get(node):
      dfs(neighbor)

  dfs(start)

DFS kernel (iterative — explicit stack):
  visited = Set()
  stack   = [start]

  while stack not empty:
    node = stack.pop()
    if node in visited: continue
    visited.add(node)
    visit(node)
    for each neighbor in adjList.get(node):
      stack.push(neighbor)
```

```
DFS execution trace — start at A on the same graph (recursive version):

  call            stack frames        visited           visit order so far
  ────────        ─────────────       ──────────        ──────────────────
  dfs(A)          [A]                 {A}               A
  dfs(B)          [A,B]               {A,B}             A,B
  dfs(D)          [A,B,D]             {A,B,D}           A,B,D
  dfs(C)          [A,B,D,C]           {A,B,D,C}         A,B,D,C
  dfs(E)          [A,B,D,C,E]         {A,B,D,C,E}       A,B,D,C,E
  return E        [A,B,D,C]
  return C        [A,B,D]
  return D        [A,B]
  return B        [A]
  return A        []
                                                          done
```

**Cost:** O(V + E) — same as BFS, each node and edge visited once.

**Where DFS shows up:**
- **Connected components** — DFS from every unvisited node; each call discovers one component.
- **Cycle detection** — track three states (white = unvisited, gray = on current path, black = done); a gray→gray edge is a back-edge → cycle.
- **Topological sort** — DFS with post-order; reverse the post-order = a topo order (DAG only).
- **Strongly connected components (Tarjan, Kosaraju)** — DFS with stack-of-roots tracking.
- **Backtracking algorithms** — n-queens, sudoku, maze solving. DFS plus "undo on dead end."

### Move 2 variant — the BFS/DFS shared kernel (the load-bearing graph skeleton)

BFS and DFS share an irreducible kernel. The only difference is the frontier data structure — queue vs stack.

```
GRAPH TRAVERSAL kernel
─────────────────────────────────
  visited set
  frontier (queue for BFS, stack for DFS)
  expand-and-mark loop:
    take from frontier
    if not visited: mark visited, visit, enqueue all neighbors
  termination: frontier empty
```

**Name each part by what BREAKS when missing:**

```
Removed                         What breaks
──────────────────────────      ─────────────────────────────────────
visited set                      Cyclic graphs → infinite loop. Even
                                 on acyclic graphs (trees) you can
                                 revisit shared subtrees → O(2^V)
                                 in the worst case instead of O(V+E).

frontier (queue or stack)        No work to do — you can't track
                                 "what's next." The algorithm has no
                                 forward progress mechanism.

mark-on-enqueue                  Same node enqueued multiple times
(BFS): mark when adding          from different paths. Memory blows up,
to frontier, not when removing   though the algorithm still terminates
                                 if you skip-if-visited on dequeue.

empty-frontier termination       Most-forgotten part. Without the
                                 "while frontier not empty" check, you
                                 either loop forever or hit a null
                                 dereference when the frontier empties
                                 mid-iteration.
```

**Skeleton vs hardening:**

```
SKELETON (the kernel)              HARDENING (specializations)
─────────────────────────────      ─────────────────────────────────
visited set                        edge weights → Dijkstra (heap frontier)
frontier (queue/stack)             negative weights → Bellman-Ford
mark + visit + expand              heuristic guidance → A*
termination on empty               DFS post-order → topological sort
                                   DFS state tracking → cycle detection
                                   path reconstruction (parent pointers)
                                   union-find for connectivity queries
```

The kernel is 5 lines of pseudocode. Every graph algorithm in the wild is a specialization of this kernel — change the frontier (queue → stack → priority queue), change the visited semantics (white/gray/black), add edge weights — and you've named it after the specialization.

### Move 3 — the principle

**A graph is a relation; a traversal is a discipline for visiting it without going in circles.** The visited set is the load-bearing piece — it's what separates a graph algorithm from a tree algorithm and from an infinite loop. The frontier choice (queue vs stack vs heap) is what gives you BFS vs DFS vs Dijkstra. Master those two choices and you've covered 90% of graph-algorithm problems.

---

## Primary diagram

The graph algorithm family — kernel, frontier choices, cost, and presence in this codebase.

```
                  GRAPH ALGORITHMS — ONE KERNEL, MANY FRONTIERS

  ┌─────────────────────────────────────────────────────────────────────┐
  │  shared kernel:                                                      │
  │    visited = Set();  frontier = [start];  mark(start)                │
  │    while frontier not empty:                                         │
  │      node = frontier.take()                                          │
  │      visit(node)                                                     │
  │      for neighbor in adjList[node]:                                  │
  │        if not visited: mark + add-to-frontier                        │
  └─────────────────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
   ┌──────────┐              ┌──────────┐             ┌──────────────┐
   │ frontier │              │ frontier │             │ frontier =   │
   │ = QUEUE  │              │ = STACK  │             │ MIN-HEAP     │
   │ (BFS)    │              │ (DFS)    │             │ (Dijkstra)   │
   └──────────┘              └──────────┘             └──────────────┘
        │                         │                         │
        ▼                         ▼                         ▼
   shortest path in           cycle detection           shortest path
   unweighted graph           topo sort (DAG)           with NON-NEG
   levels-by-level            connected components      weighted edges
                              backtracking
                                                        cost: O((V+E)
   cost: O(V+E)               cost: O(V+E)              log V)
                                                        needs a heap

   in repo: NOT YET           in repo: NOT YET          in repo: NOT YET
   EXERCISED                  EXERCISED                 EXERCISED
```

---

## Implementation in codebase

The closest-things, named honestly. None of these are graph algorithms.

### **The bootstrap chain — a fixed pipeline, NOT a traversal (`lib/mcp/schema.ts` L151–L192)**

```ts
// lib/mcp/schema.ts L154 (resolveProject)
const orgs = unwrap<...>(await callOrThrow(mcp, 'list_cloud_organizations', {})).data;
...
const projects = unwrap<...>(
  await callOrThrow(mcp, 'list_projects', { cloud_organization_id: orgs[0].id }),
).data;

// L178–L181 (bootstrapSchema)
const eventSchema  = await callOrThrow(mcp, 'get_event_schema', args);
const customerProps = await callOrThrow(mcp, 'get_customer_property_schema', args);
const catalogs     = await callOrThrow(mcp, 'list_catalogs', args);
const overview     = await callOrThrow(mcp, 'get_project_overview', args);
```

This *looks* like it might be a graph traversal — call A, use A's result to call B, use B's result to call C, D, E, F. But it isn't a traversal in the algorithmic sense. There's no "what's the next node?" decision. There's no visited set (because there's no risk of revisiting — each call is a different tool). There's no frontier data structure. The order is *fixed at compile time* — six tool calls in a specific sequence, dictated by the data dependencies. That's a **pipeline**, not a traversal.

If you tried to model this as a graph, the "graph" would be a 6-node directed acyclic graph, and the "traversal" would be `for (const tool of [a,b,c,d,e,f]) await call(tool)` — at which point the graph abstraction is pure overhead. The codebase wisely doesn't reach for it.

### **The agent pipeline — also fixed (`app/api/briefing/route.ts`)**

```
monitoringAgent.scan() → diagnosticAgent.investigate() → recommendationAgent.propose()
```

Same pattern: three stages, fixed order, output of stage N is input to stage N+1. Not a graph; not a traversal. A pipeline.

### **No adjacency list, no BFS, no DFS, no Dijkstra**

Confirmed: no `Map<NodeId, Neighbors[]>` anywhere, no `queue` or `stack` used for traversal frontier (the NDJSON `buf` is a one-slot queue but for byte framing, not graph traversal), no `visited` set used in a traversal sense. The user's portfolio (`reincodes/Graph.ts`, `reincodes/Graph2.ts` with BFS, DFS, Dijkstra) has implementations from scratch — but none of them have been reached for in `blooming_insights`.

### **What would trigger reaching for a graph here?**

Three concrete triggers:

1. **Tool dependency resolution.** If an agent's plan involved tools where some require the output of others (e.g. "to call `analyze_funnel`, you first need to call `list_funnel_events`, which requires `list_events`"), the natural representation is a DAG of tool dependencies, and the right algorithm is topological sort to compute call order. Today the bootstrap chain is hardcoded; if it grew to 20+ tools with conditional dependencies, the DAG-based approach would beat the manual sequence.

2. **Cross-insight relationships.** If insights related to each other ("this revenue drop *caused* this funnel leak"), the natural model is a directed graph of insight nodes with "causes" edges. Walking it (DFS from a root insight to find all downstream effects) would be a real graph algorithm. Today insights are flat.

3. **Multi-step recommendation chains.** If a recommendation could only be acted on after a prerequisite recommendation was completed, you'd have a DAG of recommendations and need topological sort (or BFS over "ready-to-execute" recommendations) to surface the right one first. Today recommendations are independent.

None of these triggers has fired. They're plausible product directions, not current requirements.

---

## Elaborate

### Where they come from

**BFS** is implicit in Konrad Zuse's 1945 graph algorithms (the earliest written graph algorithms) and was rediscovered for shortest paths by E. F. Moore in 1959. **DFS** is older still — the basic recursive descent strategy is used in maze-solving algorithms going back centuries. **Dijkstra** published his shortest-path algorithm in 1959 in a single-column paper of about a page.

**Adjacency list vs matrix** is a representation choice that crystallized in the 1960s as computer memory grew large enough to make the choice matter; before that, everything was matrices because memory was packed and arrays were primitive.

### The deeper principle

**A graph is a Map from node to list-of-neighbors.** Once you see that, every graph algorithm reduces to "walk the map in some order, marking what you've seen." The orders are:
- BFS: by distance from start (queue frontier).
- DFS: by depth (stack frontier).
- Dijkstra: by smallest tentative distance (min-heap frontier).
- A*: by smallest tentative distance + heuristic estimate (min-heap with heuristic key).

The mental model "graph = Map<node, neighbors>" is the load-bearer. A `Map<string, string[]>` *is* a graph — you don't need a `Graph` class. Most production code that touches graphs uses this representation directly.

**Trees are a degenerate special case of graphs** — connected, acyclic, with one chosen root. Every tree algorithm is a graph algorithm with the visited-set check optimized away (because there are no cycles).

### Where they break down

- **Visited set blows memory at huge V.** For graphs with billions of nodes (web crawl), even a `Set<NodeId>` is too big. Bloom filters approximate the visited check with bounded false positives.

- **Dijkstra fails on negative-weight edges.** It assumes once you've found the shortest path to a node, you don't need to revisit. Negative weights break that. Use Bellman-Ford (O(V·E)) for negative weights, or Johnson's algorithm (which reweights then uses Dijkstra) for all-pairs shortest paths with negatives.

- **DFS on deeply recursive graphs blows the call stack.** Convert to an iterative DFS with an explicit stack to avoid stack overflow on graphs with paths longer than ~10K nodes (depending on the runtime).

- **Adjacency matrix wastes O(V²) on sparse graphs.** For V=10K with average degree 5, an adjacency list is ~50K entries; an adjacency matrix is ~100M entries. The matrix wins only when E ≈ V² (dense graphs).

### What to explore next

- **Your own `reincodes/Graph.ts` and `Graph2.ts`** — you've built BFS, DFS, Dijkstra, Eulerian paths, connected components, valid-tree checks. The implementations sit there waiting for a trigger to use them in this codebase.

- **Topological sort** — DFS post-order on a DAG, reversed, gives a valid processing order for tasks with dependencies. Essential when you want a "build order" for a graph of dependencies.

- **Union-find (disjoint set)** — answer "are X and Y in the same component?" in nearly O(1) amortized. Used in Kruskal's MST, network connectivity, image segmentation.

- **A*** — Dijkstra with a heuristic estimate that guides the search toward the goal. Used in pathfinding for games and robots.

- **Strongly connected components (SCC)** — Tarjan's or Kosaraju's algorithms. Used in compiler dependency analysis, social network community detection.

---

## Interview defense

**What they are really asking.** Whether you can name the three core graph algorithms (BFS, DFS, Dijkstra), identify which problem each one solves, and reason about representation choice. Senior signal: knowing the visited set is the load-bearer for both correctness and performance. Architect signal: explaining when *not* to reach for a graph (when the data is genuinely a pipeline, not a relation).

---

**[mid] "When would you use BFS instead of DFS?"**

BFS for shortest path in an unweighted graph (it explores by level, so the first time you reach the target is on a shortest path). DFS for "is this reachable" when you don't care about the path length, for cycle detection (track gray/black states), or for topological sort (post-order on a DAG). Both are O(V+E) cost; both need a visited set. The choice is about *what order you want to visit nodes*, not about cost.

```
  problem                                algorithm
  ─────────────────────────────────────  ──────────────
  shortest path, unweighted graph        BFS
  shortest path, weighted (non-neg)      Dijkstra
  shortest path, with negative weights   Bellman-Ford
  is X reachable from Y                  BFS or DFS (either)
  detect cycle                           DFS with gray/black
  valid processing order (DAG)           topo sort (DFS post-order)
  connected components                   DFS (one call per component)
```

---

**[senior] "What's the load-bearing piece of BFS that people forget about?"**

The visited set. Walk BFS without it on a cyclic graph and it never terminates — A's neighbors include B, B's neighbors include A, you keep enqueueing both forever. The visited set is what makes "graph traversal" different from "infinite loop." The second-most-forgotten piece is the empty-frontier termination check — without `while frontier not empty`, you either loop forever or dereference null when the frontier empties mid-iteration.

```
  BFS kernel — name each load-bearing part:

  visited set           ← prevents revisits, prevents infinite loops
  queue frontier        ← maintains FIFO order = exploration by level
  mark on enqueue       ← prevents same node from being enqueued twice
  empty-frontier term.  ← stop condition (most forgotten)
```

In interviews, naming the empty-frontier termination explicitly signals "I've built this; I haven't just read about it."

---

**[arch] "This codebase has no graph algorithm. Is that a problem? When would you add one?"**

It's not a problem — the relationships in the data are flat. The bootstrap chain is a fixed pipeline (6 calls in order), the agent pipeline is a fixed sequence (3 stages), and insights/diagnoses/recommendations are 1-to-1 down the chain. There's no many-to-many relationship to traverse, no cycles to detect, no shortest path to compute. Three triggers would change my mind: (1) tool dependencies grow into a DAG that needs topological sort to compute call order; (2) insights start relating to each other ("this revenue drop caused this funnel leak") and the UI needs to traverse those causal links; (3) recommendations grow prerequisites and the UI needs "what can be acted on right now" — BFS over the "ready" frontier. Until then, reaching for a graph would be over-engineering the data model. The skill is knowing when the data has *truly* become a graph vs when it just feels like one.

---

**The dodge: "you said the bootstrap chain is a 'pipeline, not a traversal' — but it's a sequence of nodes with edges between them. Isn't that a graph?"**

Shape vs algorithm again. A pipeline has the *shape* of a path graph (a chain of nodes), and you could trivially model it as one. But the *algorithm* is "iterate in fixed order," which is `for (const tool of tools) await call(tool)` — there's no graph algorithm running. No visited set (no cycles to fear). No frontier (no "what's next" decision). No representation work (the order is hardcoded). Calling it a graph traversal would inflate the description. The honest version: the bootstrap chain is a fixed pipeline that *happens* to be expressible as a 6-node DAG but is implemented as a 6-line `await` sequence. Cite `lib/mcp/schema.ts` L178–L181.

---

**Anchors (cite these in your answer)**

- `lib/mcp/schema.ts` L151–L192 — bootstrap chain (a fixed pipeline, not a traversal)
- `app/api/briefing/route.ts` — agent pipeline (also fixed, not traversed)
- (No file paths for BFS/DFS/Dijkstra — these are `not yet exercised`.)

---

## See also

→ `03-stacks-queues-deques-and-heaps.md` (BFS needs a queue, DFS needs a stack — both `not yet exercised` here) · → `04-trees-tries-and-balanced-indexes.md` (trees are acyclic graphs with a root; this chapter teaches the more general case) · → `08-dsa-foundations-practice-map.md` (where graph algorithms rank in the practice plan — high, because they're frequent interview topics)
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
