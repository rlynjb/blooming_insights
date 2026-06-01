# GraphRAG (retrieve over relationships, not just similarity)

**Industry name(s):** GraphRAG, knowledge-graph retrieval, entity-relationship RAG, graph-augmented generation
**Type:** Industry standard · Language-agnostic

> GraphRAG retrieves by *traversing relationships* between entities — events relate to properties, insights share a metric — rather than only by vector similarity, so it answers "what is connected to this?" questions a flat embedding index cannot; blooming insights has no graph index, but the Bloomreach schema (events → properties → catalogs) is graph-shaped and `bootstrapSchema` already walks it, so this is study material grounded in a real analog.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** GraphRAG is a retrieval pipeline that swaps the Vector store for a *graph store* and the cosine retriever for *edge traversal*. The Indexer extracts entities + relationships, the Graph store holds nodes and edges, and the Retriever walks the connections — not the embedding space. blooming insights already builds a graph-shaped artifact: `bootstrapSchema` (`lib/mcp/schema.ts` L170–L192) walks event/property/catalog/customer-property links with four sequential tool calls and assembles a `WorkspaceSchema`. The graph *shape* is in the codebase; the graph *retrieval* is not.

```
  Zoom out — where GraphRAG sits (WOULD BE)

  ┌─ Source documents / entities ────────────────────┐
  │  insights (Insight), schema nodes, events, scopes │
  └─────────────────────────┬────────────────────────┘
                            │  extract entities + edges
  ┌─ Indexer (entity + relation extraction) ─────────┐
  │  for each doc: nodes + typed edges                │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Graph store ───────────▼────────────────────────┐
  │  nodes: Insight, Metric, Scope, Event             │
  │  edges: same_metric, same_scope, caused_by, …     │
  └─────────────────────────┬────────────────────────┘
                            │  query
  ┌─ Retriever (traversal) ─▼────────────────────────┐  ← we are here
  │  ★ graph.neighbors(node, edgeType, depth) ★      │
  │  multi-hop: insight → metric → other insights     │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ LLM context ───────────▼────────────────────────┐
  └──────────────────────────────────────────────────┘

  In this codebase: Not yet implemented — String.includes
  intent matching in lib/agents/intent.ts is what exists
  instead; the schema graph IS built (bootstrapSchema walks
  nodes and edges), but no traversal-as-retrieval consumes it.
```

**Zoom in — narrow to the concept.** The question is: when the answer depends on *relationships* between entities — not just textual similarity — how do you retrieve by traversing the connections? Vector similarity captures "these mean the same thing" but is blind to "these are linked," and many real questions are about links (shared metrics, shared scope, cause-and-effect chains). How it works walks the entity-extraction step, edge typing, traversal queries, and the rule that the more your domain is a graph, the more cosine alone misses.

---

## Structure pass

**Layers.** Four WOULD-BE layers swap the embedding pipeline for a graph one: source entities + relationships, the indexer that extracts nodes and typed edges, the graph store, and the retriever that traverses edges instead of cosine-scoring vectors. blooming insights already builds the graph *shape* (`bootstrapSchema` walks events → properties → catalogs); it just doesn't yet *retrieve* over it.

**Axis: state.** What's the shape of the state each layer operates on — flat document vectors, or a graph of nodes-and-edges? This axis is the right lens because GraphRAG is fundamentally a state-model swap from "bag of vectors" to "typed graph." Lifecycle is similar to vector RAG; the upstream change is what *kind of thing* the index represents. Vector cosine is blind to "linked to"; graph traversal is built for it.

**Seams.** The cosmetic seam is between the indexer's extract step and the graph store — both are nodes-and-edges. The load-bearing WOULD-BE seam is between the graph store and the retriever: state-shape determines what queries are *expressible*. Cosine answers "what means the same as this?"; traversal answers "what is linked to this via edge type X, depth N?" These are different questions, and only the second is expressible with a graph state-model. A second observation: this is the seam where blooming insights' partial implementation lives — the graph is built, the traversal-as-retrieval is absent.

```
  Structure pass — GraphRAG (WOULD BE)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  source entities + relationships               │
  │  indexer (extract nodes + typed edges)         │
  │  graph store (nodes, edges)                    │
  │  retriever (edge traversal, multi-hop)         │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  state: flat vectors vs typed graph — what     │
  │  KIND of state does each layer hold?           │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  indexer↔graph store: cosmetic                 │
  │  graph store↔retriever: LOAD-BEARING           │
  │    state-shape decides what queries are        │
  │    expressible (cosine vs traversal)           │
  │    today: graph built, traversal absent        │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** A knowledge graph is the data structure you already reach for when entities reference each other: a `Map<nodeId, Node>` plus a `Map<nodeId, Edge[]>` adjacency list — the normalized shape, not a flat array of independent rows. Retrieval is traversal: start at a node, follow edges of a given type, collect neighbors, optionally hop again. Vector similarity finds an *entry point*; graph edges find what is *connected*.

```
  flat embedding index            knowledge graph
  ──────────────────────────      ──────────────────────────────
  [vec][vec][vec][vec]            (insight)──metric──▶(insight)
  only "nearest to q"                  │
  no relationships                    scope
                                       ▼
                                   (insight)
  retrieve = nearest-k            retrieve = traverse edges from a node
```

The body walks the graph shape, the traversal, and the hybrid that combines it with vector entry.

---

### The schema is already a graph

The schema bootstrap produces a `WorkspaceSchema` whose shape is nodes and edges, even though it is stored as nested arrays:

```
  WorkspaceSchema as a graph
  ──────────────────────────────────────────────────────
  (project)
     ├──has──▶ (event: purchase) ──has──▶ (property: amount)
     │                            └─has──▶ (property: currency)
     ├──has──▶ (event: add_to_cart) ──has──▶ (property: item_id)
     ├──has──▶ (catalog: products) ◀─references── (event: view_item)
     └──has──▶ (customer property: lifetime_value)
```

The bootstrap *walks* this: it calls `get_event_schema` (events + their properties), `get_customer_property_schema`, `list_catalogs`, and `get_project_overview`, then a parser assembles the edges — each event mapped to its property list. That assembly *is* building a graph from a traversal of the source. The structure is there; it is just not yet *queried* as a graph.

### Insights form a second graph: shared metric and scope

The `Insight` type carries `metric: string` and `scope: string[]`. Those are edges waiting to be drawn: two insights about `conversion_rate` share a *metric* edge; two insights scoped to `["mobile", "checkout"]` share a *scope* edge. A "related insights" graph connects insights through these shared attributes.

```
  insight A: metric=conversion_rate, scope=[mobile, checkout]
  insight B: metric=conversion_rate, scope=[desktop]
  insight C: metric=revenue,         scope=[mobile, checkout]

       A ──metric──▶ B        (both conversion_rate)
       A ──scope───▶ C        (both mobile+checkout)
       B            C         (no shared attribute → no edge)
```

"Related to A" traverses both edge types: B (shared metric) and C (shared scope). A flat embedding index would miss B if it were worded differently, and would not distinguish a metric-link from a scope-link.

### Graph retrieval: traverse from a node

Given a starting node (an insight, an event), graph retrieval follows edges to collect related nodes, optionally multi-hop, and returns the connected subgraph as context.

```
  query: "what's related to insight A?"
  start at A
    ├─ follow metric edge  → B
    ├─ follow scope edge   → C
    └─ (hop 2 from B) follow metric edge → D (also conversion_rate)
  return {A, B, C, D} as grounding context
```

Multi-hop is the power: it surfaces transitively-connected entities (D, two hops away) that share no direct similarity with A but are linked through B.

### Hybrid: vector for entry, graph for expansion

The production GraphRAG pattern combines both retrievers (`06`): use vector similarity to *find the entry node* (the insight closest to a free-text query), then traverse the graph to *expand* to connected nodes. Similarity answers "where do I start"; the graph answers "what is connected."

```
  free-text query ──vector──▶ entry node (nearest insight)
                                 │ graph traversal
                                 ▼
                            connected subgraph (shared metric/scope, multi-hop)
                                 │
                                 ▼
                            context → LLM → answer
```

### The principle

When the answer lives in *relationships* — shared attributes, cause-and-effect chains, entity links — retrieve by traversing edges, not only by comparing vectors, because similarity is blind to connection. Model the entities as a graph (nodes + adjacency), use vector similarity to find an entry point, and traverse edges to gather what is connected. This system's schema is already graph-shaped and the bootstrap already traverses it; GraphRAG would query that structure as a graph instead of flattening it.

---

## GraphRAG — diagram

This diagram spans the Service layer (the hybrid retriever) and the State layer (the graph). A reader who sees only this should grasp that vector similarity finds an entry node and graph traversal expands to connected nodes.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (would live in lib/mcp/retrieval.ts)                │
│                                                                      │
│   query                                                              │
│     │  vector similarity (01/04) — find the ENTRY node              │
│     ▼                                                                │
│   entry node (nearest insight/event)                                │
│     │  graph traversal — follow EDGES                               │
│     ▼                                                                │
│   connected subgraph (shared metric/scope, multi-hop)               │
│     │                                                                │
│     ▼  context → LLM (runAgentLoop) → grounded answer               │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ reads the graph
┌──────────────────────────▼───────────────────────────────────────────┐
│  STATE LAYER  (lib/state/, built like bootstrapSchema walks)        │
│   nodes:  insights, metrics, scopes, events, properties             │
│   edges:  shared-metric, shared-scope, event-has-property,          │
│           event-references-catalog (schema.ts already maps   │
│           events→properties — the graph is half-built)              │
└──────────────────────────────────────────────────────────────────────┘
```

Vector similarity finds the start; graph edges find the connected — the schema's nodes-and-edges shape, already walked by `bootstrapSchema`, queried as a graph.

---

## Implementation in codebase

**Not yet implemented (graph retrieval).** blooming insights retrieves live via MCP tool calls + EQL against Bloomreach, with neither a flat embedding index nor a graph index — so there is no edge-traversal retrieval anywhere.

The honest analog is strong and structural: the Bloomreach schema is graph-shaped (events → properties → catalogs; customers → events) and `bootstrapSchema` (`lib/mcp/schema.ts` L170–L192) already *walks* it. It issues four sequential tool calls to gather the event schema, customer properties, catalogs, and overview, then `parseWorkspaceSchema` (L73–L124) assembles the relationships — mapping each event to its property list (L91–L99) and each catalog to its id/name (L105–L108). That assembly is building a graph from a traversal of the source. A second latent graph lives in the `Insight` type (`lib/mcp/types.ts` L7–L17): `metric` and `scope` are edges waiting to be drawn between insights. GraphRAG retrieval over either graph would live in a `lib/mcp/retrieval.ts` reading a graph built in `lib/state/`. The `Project exercises` block below is the primary buildable target.

---

## Elaborate

### Where this pattern comes from

Knowledge graphs are decades old (semantic web, RDF, property graphs in Neo4j). GraphRAG specifically — using a knowledge graph as the retrieval substrate for an LLM — was formalized by Microsoft Research's GraphRAG (2024), which built an entity-relationship graph from a corpus and used community summaries plus traversal to answer global questions a flat index could not (e.g. "what are the main themes across all documents?"). The pattern's appeal is answering *connection* and *aggregation* questions — multi-hop reasoning, "what relates to what" — that pure similarity retrieval fundamentally cannot.

### The deeper principle

```
  question shape               retriever
  ─────────────────────────    ──────────────────────────────
  "similar to this"            vector index (similarity)
  "connected to this"          graph traversal (edges)
  "themes across everything"   graph + community summaries
  "find entry, then expand"    hybrid (vector entry + graph hop)
```

Similarity and connection are different relations, and a flat index only encodes the first. The senior insight is matching the retriever to the *question's relation*: textual similarity to a vector index, entity relationships to a graph. Many products need both, fused (`06`).

### Where this breaks down

1. **Building the graph is the hard part.** Extracting reliable entities and edges from free text (entity resolution, relation extraction) is error-prone; a wrong edge sends traversal to wrong neighbors. blooming insights sidesteps this for the schema (the edges are explicit in the API) and for insights (`metric`/`scope` are structured fields) — the easy case where edges are given, not inferred.

2. **Traversal can explode.** Multi-hop from a highly-connected node fans out exponentially; without hop limits and edge-type filtering, a 3-hop traversal can pull in most of the graph as "context," blowing the prompt budget.

3. **Graphs need incremental maintenance too.** A new insight adds nodes and edges; a re-run changes them. The graph index has the same staleness/incremental-update problem as a vector index (`09`/`10`) — edges drift from the source.

### What to explore next

- **RAG** (`11-rag.md`): GraphRAG is a retriever variant; the same "add it only when a feature needs it" rule applies.
- **Hybrid retrieval** (`06-hybrid-retrieval-rrf.md`): vector-entry + graph-expansion is a hybrid pattern.
- **Incremental indexing** (`10-incremental-indexing.md`): keeping graph nodes/edges current as insights change.

### Honest scoping note

Like all of this section, GraphRAG is Case B and subject to the same threshold rule as `11-rag.md`: it earns its place only when a feature needs *relationship* retrieval. The "related insights" feature is exactly that feature — and notably, it can be built *without* embeddings at all, because the edges (`metric`, `scope`) are exact structured fields. That makes it the cheapest graph-retrieval win: a pure structured-edge graph, no vector index required.

---

## Project exercises

### Build a "related insights" graph over shared metric and scope

- **Exercise ID:** B2A.8 (adapted) — the primary buildable target, and the cheapest threshold-crossing feature in this section (no embeddings needed).
- **What to build:** model insights as graph nodes with edges drawn between any two that share a `metric` or overlap in `scope` (`lib/mcp/types.ts` L7–L17). Expose `relatedInsights(insightId)` that traverses those edges (optionally multi-hop) to return connected insights, surfaced in the UI as "related insights." Build the graph from the structured fields directly — no vector index required.
- **Why it earns its place:** demonstrates you recognize a *relationship* question (shared metric/scope) that similarity cannot answer, and that you built a graph retriever from exact edges with zero embedding cost — the precise-tool-for-the-question signal.
- **Files to touch:** new `lib/state/insight-graph.ts` (adjacency list keyed by `metric`/`scope`, built like `bootstrapSchema` assembles edges), `lib/state/insights.ts` (feed insights in on `putInsights`), new `lib/mcp/retrieval.ts` (`relatedInsights` traversal), the investigate UI (`app/investigate/[id]/page.tsx`) to render related insights, new `test/state/insight-graph.test.ts`.
- **Done when:** opening an insight shows other insights linked by the same `metric` and by overlapping `scope`, including a differently-worded one a flat similarity search would miss, with no embedding index involved.
- **Estimated effort:** 1–2 days

### Add vector-entry + graph-expansion for free-text "related work" queries

- **Exercise ID:** C2.13 (adapted) — hybrid GraphRAG.
- **What to build:** combine the embedding retriever (`01`/`05`) with the insight graph: a free-text query finds the nearest insight by cosine (vector entry), then traverses the `metric`/`scope` edges to expand to connected insights (graph expansion), grounding the answer in the connected subgraph.
- **Why it earns its place:** shows you fuse the two relation types — similarity for entry, edges for expansion — the production GraphRAG pattern.
- **Files to touch:** `lib/mcp/retrieval.ts` (hybrid `relatedByQuery`), `lib/state/insight-graph.ts` (traversal), `lib/mcp/embeddings.ts` + `lib/mcp/vector-store.ts` (vector entry), `test/mcp/retrieval.test.ts`.
- **Done when:** a free-text query lands on the nearest insight by similarity and then surfaces metric/scope-connected insights that share no wording with the query, bounded by a hop limit.
- **Estimated effort:** 1–2 days

---

## Interview defense

### What an interviewer is really asking

"What is GraphRAG and when would you use it?" tests whether you distinguish similarity retrieval from relationship retrieval. The senior signal is naming the "connected to" vs. "similar to" split, recognizing graph-shaped data (the schema, insights' shared metric/scope), the vector-entry + graph-expansion hybrid, and that when edges are exact structured fields you need no embeddings at all.

### Likely questions

**[mid] How is GraphRAG different from regular RAG?**

Regular RAG retrieves the nearest vectors — "similar to this." GraphRAG traverses edges between entities — "connected to this." Two insights about the same metric are *connected* even if worded differently; a flat vector index would miss the differently-worded one, but a graph follows the shared-metric edge.

```
vector RAG: nearest vectors (similar wording)
GraphRAG:   follow edges (shared metric/scope), even if worded differently
```

**[senior] blooming insights has no graph index — but is its data graph-shaped?**

Yes. The Bloomreach schema is a graph (events → properties → catalogs), and `bootstrapSchema` (`lib/mcp/schema.ts` L170–L192) already walks it and assembles event→property edges (L91–L99). Separately, `Insight.metric` and `Insight.scope` (`lib/mcp/types.ts` L7–L17) are edges between insights. The structure is there; it just is not queried as a graph yet.

```
bootstrapSchema walks: event ──has──▶ property, ──references──▶ catalog
Insight: metric, scope = edges between insights (waiting to be drawn)
```

**[arch] You're building "related insights." Do you need embeddings?**

No — and that is the elegant part. The edges (`metric`, `scope`) are exact structured fields, so the graph is built directly from them: connect any two insights sharing a metric or overlapping scope, then traverse. No embedding, no vector index, no extraction. It is the cheapest threshold-crossing retrieval feature because the relationships are given, not inferred.

```
related = traverse shared-metric and shared-scope edges
edges are exact fields → no embeddings, no extraction
```

### The question candidates always dodge

**"When is a graph the wrong retriever?"** When the question is "similar to," not "connected to," or when building the graph requires error-prone entity/relation extraction that costs more than the answer is worth. Candidates over-reach for GraphRAG on similarity questions. The senior move is matching the retriever to the question's *relation* — and noting that GraphRAG is cheap only when edges are explicit (as `metric`/`scope` are) and expensive when they must be extracted from free text.

### One-line anchors

- `lib/mcp/schema.ts` L170–L192 — `bootstrapSchema`: walks the graph-shaped schema (the traversal analog).
- `lib/mcp/schema.ts` L91–L99 — `parseWorkspaceSchema`: assembles event→property edges.
- `lib/mcp/types.ts` L7–L17 — `Insight.metric` / `Insight.scope`: edges between insights.
- Vector similarity = "similar to"; graph traversal = "connected to" — different relations.
- "Related insights" needs no embeddings — its edges are exact structured fields.

---

## Validate

### Level 1 — Reconstruct

From memory, draw a flat vector index next to a knowledge graph, and state what each can answer ("similar to" vs. "connected to"). Draw three insights connected by shared `metric` and `scope` edges.

### Level 2 — Explain

Out loud: why is vector similarity blind to relationships? Why does the vector-entry + graph-expansion hybrid cover both relation types?

### Level 3 — Apply

Scenario: build "related insights." Open `lib/mcp/types.ts` L7–L17 (`Insight.metric`, `Insight.scope`) and `lib/mcp/schema.ts` L170–L192 (`bootstrapSchema`'s traversal-to-build-a-graph pattern). Name the nodes and edges, why no embeddings are needed, and how `relatedInsights(id)` would traverse the shared-metric and shared-scope edges.

### Level 4 — Defend

A colleague wants to build "related insights" with an embedding index ("just embed the headlines and find nearest"). Argue why a structured-edge graph over `metric`/`scope` is both cheaper (no embeddings) and *more correct* (catches a differently-worded same-metric insight that cosine would miss), and when the embedding approach would actually be needed (free-text similarity, not exact-field connection).

### Quick check — code reference test

What graph-shaped data does blooming insights already build and walk, and what edges would a "related insights" graph use? (Answer: `bootstrapSchema` (`lib/mcp/schema.ts` L170–L192) walks the graph-shaped Bloomreach schema and `parseWorkspaceSchema` assembles event→property edges (L91–L99); a "related insights" graph would use the exact structured `metric` and `scope` fields on the `Insight` type (`lib/mcp/types.ts` L7–L17) as edges — no embeddings required.)

## See also

→ 11-rag.md · → 01-embeddings.md · → 06-hybrid-retrieval-rrf.md · → 10-incremental-indexing.md

---
Updated: 2026-05-28 — corrected one stale ref: `bootstrapSchema` moved to `lib/mcp/schema.ts` L170–L192 (was L152–L176). Case-B rationale (graph-shaped schema, no graph query yet) unchanged.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
