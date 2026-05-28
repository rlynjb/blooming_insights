# GraphRAG (retrieve over relationships, not just similarity)

**Industry name(s):** GraphRAG, knowledge-graph retrieval, entity-relationship RAG, graph-augmented generation
**Type:** Industry standard · Language-agnostic

> GraphRAG retrieves by *traversing relationships* between entities — events relate to properties, insights share a metric — rather than only by vector similarity, so it answers "what is connected to this?" questions a flat embedding index cannot; blooming insights has no graph index, but the Bloomreach schema (events → properties → catalogs) is graph-shaped and `bootstrapSchema` already walks it, so this is study material grounded in a real analog.

**See also:** → 11-rag.md · → 01-embeddings.md · → 06-hybrid-retrieval-rrf.md · → 10-incremental-indexing.md

---

## Why care

The `WorkspaceSchema` blooming insights builds is already a graph, not a flat list. An *event* (`purchase`) has a set of *properties* (`amount`, `currency`); a *catalog* relates to the events that reference it; a customer property links customers to events. `bootstrapSchema` (`lib/mcp/schema.ts` L152–L176) walks this structure with four sequential tool calls — event schema, customer properties, catalogs, overview — and assembles the nodes-and-edges into one `WorkspaceSchema`. That is a graph traversal that produces a graph. Flat embedding retrieval (files 01–10) throws that structure away — it treats every chunk as an independent point and only knows "similar to," never "connected to."

The question GraphRAG answers is: when the answer depends on *relationships* between entities, not just their textual similarity, how do you retrieve by traversing the connections?

**The pivot: vector similarity captures "these mean the same thing" but is blind to "these are linked," and many real questions are about links — shared metrics, shared scope, cause-and-effect chains — that no cosine can see.** "What other insights touch the same metric as this one?" is a *relationship* query: it follows the `metric` edge from one `Insight` to others, not the nearest-vector edge. A flat embedding index would return insights with *similar wording*, missing a differently-worded insight about the exact same metric. GraphRAG retrieves along the edges.

Before graph retrieval:
- Retrieval is similarity-only: nearest vectors, no notion of connection
- "Related insights" returns textually-similar ones, not metric-linked ones
- Multi-hop questions ("what led to what") cannot be answered — there are no edges to follow

After:
- Entities (insights, metrics, scopes, events) are nodes; shared attributes are edges
- "Related to this insight" traverses the `metric`/`scope` edges
- Multi-hop traversal answers connection questions similarity cannot

It is the difference between `array.filter(x => cosine(x.vec, q) > t)` (similarity) and `graph.neighbors(node, edgeType)` (traversal) — and `bootstrapSchema` already does the latter shape over the schema.

---

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

`bootstrapSchema` produces a `WorkspaceSchema` whose shape is nodes and edges, even though it is stored as nested arrays:

```
  WorkspaceSchema as a graph (lib/mcp/schema.ts)
  ──────────────────────────────────────────────────────
  (project)
     ├──has──▶ (event: purchase) ──has──▶ (property: amount)
     │                            └─has──▶ (property: currency)
     ├──has──▶ (event: add_to_cart) ──has──▶ (property: item_id)
     ├──has──▶ (catalog: products) ◀─references── (event: view_item)
     └──has──▶ (customer property: lifetime_value)
```

`bootstrapSchema` (L152–L176) *walks* this: it calls `get_event_schema` (events + their properties), `get_customer_property_schema`, `list_catalogs`, and `get_project_overview`, then `parseWorkspaceSchema` (L73–L124) assembles the edges — each event mapped to its property list (L91–L99). That assembly *is* building a graph from a traversal of the source. The structure is there; it is just not yet *queried* as a graph.

### Insights form a second graph: shared metric and scope

The `Insight` type (`lib/mcp/types.ts` L7–L17) carries `metric: string` and `scope: string[]`. Those are edges waiting to be drawn: two insights about `conversion_rate` share a *metric* edge; two insights scoped to `["mobile", "checkout"]` share a *scope* edge. A "related insights" graph connects insights through these shared attributes.

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

When the answer lives in *relationships* — shared attributes, cause-and-effect chains, entity links — retrieve by traversing edges, not only by comparing vectors, because similarity is blind to connection. Model the entities as a graph (nodes + adjacency), use vector similarity to find an entry point, and traverse edges to gather what is connected. blooming insights' schema is already graph-shaped and `bootstrapSchema` already traverses it; GraphRAG would query that structure as a graph instead of flattening it.

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
│           event-references-catalog (schema.ts L91–L99 already maps   │
│           events→properties — the graph is half-built)              │
└──────────────────────────────────────────────────────────────────────┘
```

Vector similarity finds the start; graph edges find the connected — the schema's nodes-and-edges shape, already walked by `bootstrapSchema`, queried as a graph.

---

## In this codebase

**Not yet implemented (graph retrieval).** blooming insights retrieves live via MCP tool calls + EQL against Bloomreach, with neither a flat embedding index nor a graph index — so there is no edge-traversal retrieval anywhere.

The honest analog is strong and structural: the Bloomreach schema is graph-shaped (events → properties → catalogs; customers → events) and `bootstrapSchema` (`lib/mcp/schema.ts` L152–L176) already *walks* it. It issues four sequential tool calls to gather the event schema, customer properties, catalogs, and overview, then `parseWorkspaceSchema` (L73–L124) assembles the relationships — mapping each event to its property list (L91–L99) and each catalog to its id/name (L105–L108). That assembly is building a graph from a traversal of the source. A second latent graph lives in the `Insight` type (`lib/mcp/types.ts` L7–L17): `metric` and `scope` are edges waiting to be drawn between insights. GraphRAG retrieval over either graph would live in a `lib/mcp/retrieval.ts` reading a graph built in `lib/state/`. The `Project exercises` block below is the primary buildable target.

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

## Tradeoffs

### Graph traversal vs. flat vector retrieval vs. live tools (current)

| Dimension | Graph traversal | Flat vector index | Live tool call (current) |
|---|---|---|---|
| Answers "connected to" | Yes (edges) | No (similarity only) | No |
| Answers "similar to" | Via vector entry | Yes | No |
| Multi-hop reasoning | Yes | No | No |
| Build cost | Entity/edge extraction (or given) | Embed + index | None |
| Maintenance | Node/edge upserts (10) | Vector upserts (10) | None |
| Right when | Relationship/connection questions | Similarity questions | Exact live questions |

**What we gave up (by not having it).** Relationship retrieval — blooming insights cannot answer "what other insights touch this metric or scope?" by traversal; it has no graph to walk. For exact analytics that is fine (those are not relationship questions). The gap is real only for a connection-shaped feature like "related insights," which the codebase does not yet have.

**What the alternative would have cost.** A graph index for the *analytics* data would be over-engineering — analytics questions are exact aggregates, not connection queries, so there are no edges to traverse that EQL does not already express. Even for insights, a *general* knowledge-graph pipeline (entity extraction, relation inference) would be far more machinery than needed, because the relevant edges (`metric`, `scope`) are already exact structured fields — no extraction required.

**The breakpoint.** Flat/live retrieval is correct while questions are "similar to" or exact. A graph retriever becomes warranted the moment a feature asks "what is *connected* to this" — specifically "related insights" over shared `metric`/`scope`. Because those edges are exact fields (`lib/mcp/types.ts` L7–L17), that graph is cheap to build (no embeddings, no extraction), making it the lowest-cost threshold-crossing feature in this whole section.

---

## Tech reference (industry pairing)

### knowledge-graph retrieval

- **Codebase uses:** the analog — `bootstrapSchema` (`lib/mcp/schema.ts` L152–L176) walks the graph-shaped Bloomreach schema; `parseWorkspaceSchema` (L91–L99) assembles event→property edges. No graph *query*.
- **Why it's here (absent as retrieval):** the schema graph is built but used as a flat summary, not traversed for retrieval.
- **Leading today:** Neo4j (property graph) and Microsoft GraphRAG lead knowledge-graph retrieval (2026).
- **Why it leads:** native edge traversal and multi-hop queries that similarity retrieval cannot express.
- **Runner-up:** an in-memory adjacency-list graph (a `Map<nodeId, Edge[]>`) — enough when edges are exact structured fields, as `metric`/`scope` are.

### hybrid vector + graph retrieval

- **Codebase uses:** nothing — no vector entry, no graph traversal.
- **Why it's here (absent):** neither retriever exists; retrieval is live exact querying.
- **Leading today:** vector-entry-then-graph-expand (LlamaIndex/LangChain graph retrievers, Neo4j vector index) leads GraphRAG (2026).
- **Why it leads:** similarity finds where to start, edges find what is connected — covers both relation types.
- **Runner-up:** pure structured-edge graph (no vectors) — the right minimal choice when edges are exact fields, as for "related insights."

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

## Summary

GraphRAG retrieves by traversing relationships between entities — shared attributes, links, multi-hop chains — answering "what is connected to this?" questions that flat vector similarity, which only knows "similar to," cannot. blooming insights has no graph retriever, but its data is genuinely graph-shaped: the Bloomreach schema (events → properties → catalogs) is a graph that `bootstrapSchema` already walks, and the `Insight` type's `metric`/`scope` fields are edges waiting to be drawn. The standout consequence: a "related insights" feature over shared metric/scope is a *pure structured-edge graph* needing no embeddings at all, making it the cheapest threshold-crossing retrieval feature in this section.

**Key points:**
- Vector similarity captures "same meaning"; graph traversal captures "connected" — different relations.
- The Bloomreach schema is graph-shaped and `bootstrapSchema` (`lib/mcp/schema.ts` L152–L176) already walks it.
- `Insight.metric` and `Insight.scope` are edges — "related insights" is a graph query over exact fields.
- Production GraphRAG uses vector similarity for the entry node and edges for expansion.
- "Related insights" needs no embeddings — the edges are exact structured fields, the cheapest graph win.

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

Yes. The Bloomreach schema is a graph (events → properties → catalogs), and `bootstrapSchema` (`lib/mcp/schema.ts` L152–L176) already walks it and assembles event→property edges (L91–L99). Separately, `Insight.metric` and `Insight.scope` (`lib/mcp/types.ts` L7–L17) are edges between insights. The structure is there; it just is not queried as a graph yet.

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

- `lib/mcp/schema.ts` L152–L176 — `bootstrapSchema`: walks the graph-shaped schema (the traversal analog).
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

Scenario: build "related insights." Open `lib/mcp/types.ts` L7–L17 (`Insight.metric`, `Insight.scope`) and `lib/mcp/schema.ts` L152–L176 (`bootstrapSchema`'s traversal-to-build-a-graph pattern). Name the nodes and edges, why no embeddings are needed, and how `relatedInsights(id)` would traverse the shared-metric and shared-scope edges.

### Level 4 — Defend

A colleague wants to build "related insights" with an embedding index ("just embed the headlines and find nearest"). Argue why a structured-edge graph over `metric`/`scope` is both cheaper (no embeddings) and *more correct* (catches a differently-worded same-metric insight that cosine would miss), and when the embedding approach would actually be needed (free-text similarity, not exact-field connection).

### Quick check — code reference test

What graph-shaped data does blooming insights already build and walk, and what edges would a "related insights" graph use? (Answer: `bootstrapSchema` (`lib/mcp/schema.ts` L152–L176) walks the graph-shaped Bloomreach schema and `parseWorkspaceSchema` assembles event→property edges (L91–L99); a "related insights" graph would use the exact structured `metric` and `scope` fields on the `Insight` type (`lib/mcp/types.ts` L7–L17) as edges — no embeddings required.)
