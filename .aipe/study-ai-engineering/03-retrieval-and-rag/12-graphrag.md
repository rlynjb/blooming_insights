# GraphRAG

## Subtitle

Graph-traversal retrieval / entity-relationship augmented generation — Industry standard.

## Zoom out, then zoom in

GraphRAG extracts entities and relationships from the corpus upfront, then retrieves by traversing the graph from query-mentioned entities. Where plain RAG asks "what's semantically close?", GraphRAG asks "what's structurally related?"

```
  Zoom out — the two RAG shapes

  Plain RAG:
    query → embed → nearest neighbors → augment

  GraphRAG:
    query → extract entities → traverse graph → collect chunks → augment
```

## Structure pass

- **Layers:** entities → relationships → subgraph → chunks. Four bands.
- **Axis: relatedness shape.** Semantic (embeddings) vs structural (graph traversal). Different signal.
- **Seam:** the entity-extraction step. Upfront cost; enables the whole traversal downstream.

## How it works

### Move 1 — the mental model

You know how graph traversal works from BFS/DFS on adjacency lists — you have `Graph.ts` in reincodes and you've walked one many times. GraphRAG is the same primitive applied to a corpus: extract nodes (entities) and edges (relations) once, then traverse at query time.

```
  GraphRAG — the shape

  Upfront (once per corpus):
    docs → LLM extracts entities + relations
           → { entities: [E1, E2, ...],
               relations: [(E1, discussed_in, D1), ...] }
           store as graph

  At query time:
    "what did I decide about auth in the sessions meetings"
       │
       ▼
    parse: entities = [auth, sessions, meetings]
       │
       ▼
    traverse: find nodes near auth ∩ near sessions
       │
       ▼
    collect chunks attached to those nodes
       │
       ▼
    augment prompt with those chunks
```

### Move 2 — the step-by-step walkthrough

**When GraphRAG beats plain RAG.** When relevant docs don't share vocabulary with the query but *are* structurally related. Example: a query about "the auth flow" needs docs tagged with "session management" — different words, related concept. Plain RAG (embedding-only) may miss the connection; GraphRAG follows the `auth ─relates_to→ session_management` edge.

**When plain RAG is enough.** Most cases. GraphRAG has a hefty upfront cost (LLM-extract entities from the whole corpus) and a maintenance cost (re-extract on doc changes). Unless the corpus has strong relational structure worth exploiting, plain RAG wins on complexity budget.

**For blooming.** Overkill for the near-term. Investigation memory is a flat set of records with no rich cross-record relationships. If the codebase grew a "root-cause taxonomy" — a graph of cause → symptom → mitigation nodes accumulated over time — GraphRAG would earn its place. Today, not there.

**Implementation shape.**

- One-time: run an entity+relation extractor on the corpus. Store nodes + edges in any graph store (Neo4j, in-memory `Map<node, Set<edge>>`, sqlite with a relations table).
- Per-query: use an LLM (or NER model) to parse query entities. Traverse the graph N hops. Collect chunks attached to visited nodes. Rank chunks (RRF over frequency-of-visit + optional relevance score).

Pseudocode:

```
  buildGraph(corpus):
    for doc in corpus:
      extracted = LLM.extract(doc, schema={entities, relations})
      graph.addEntities(extracted.entities)
      graph.addRelations(extracted.relations)
      graph.attachChunk(extracted.entities[0], doc.chunk)

  queryGraph(query, k=3):
    queryEntities = LLM.parseEntities(query)
    visited = BFS(graph, queryEntities, maxHops=2)
    chunks = visited.flatMap(node => graph.chunksFor(node))
    return rankByFrequency(chunks).slice(0, k)
```

### Move 3 — the principle

Structural retrieval catches relationships semantic retrieval misses — at the cost of an expensive extraction step. Only earn the cost when the corpus's structure is load-bearing for the queries you actually run.

## Primary diagram

```
  GraphRAG — full frame

  ┌─ Corpus (docs) ─────────────────────────────────────┐
  │  investigations, past diagnoses, EQL queries, ...    │
  └──────────────────┬──────────────────────────────────┘
                     │  one-time
                     ▼
  ┌─ Entity + relation extraction (LLM) ────────────────┐
  │  { entities, relations, chunk_attachments }          │
  └──────────────────┬──────────────────────────────────┘
                     ▼
  ┌─ Graph store ───────────────────────────────────────┐
  │  nodes = entities                                    │
  │  edges = relations                                   │
  │  each node has attached chunks                       │
  └──────────────────┬──────────────────────────────────┘
                     │  at query time
                     ▼
  ┌─ Query parse → entities ────────────────────────────┐
  └──────────────────┬──────────────────────────────────┘
                     ▼
  ┌─ BFS from query entities (maxHops=2) ───────────────┐
  └──────────────────┬──────────────────────────────────┘
                     ▼
  ┌─ Collect + rank chunks ─────────────────────────────┐
  └──────────────────┬──────────────────────────────────┘
                     ▼
  ┌─ Augment prompt (like plain RAG) ───────────────────┐
  └─────────────────────────────────────────────────────┘
```

## Elaborate

GraphRAG (as a named pattern) was popularized by Microsoft Research (2024) and integrated into LangChain and LlamaIndex. Simpler forms — knowledge graphs powering search — predate the term by two decades (Google Knowledge Graph, 2012).

The upfront cost is real. Extracting entities from a 10k-doc corpus with a Sonnet-tier LLM at ~$0.05/doc = $500. Cheaper models (Haiku, gpt-4o-mini) drop it to ~$50 with quality tradeoff. Blooming's would-be corpus at 10k rows would be ~$50 to build the graph — bounded, but not free.

Related: **11-rag.md** (the plain-RAG baseline), **01-embeddings.md** (still used inside GraphRAG for chunk-attachment similarity).

## Project exercises

### B3.12 · Build a root-cause taxonomy graph (thought experiment)

- **Exercise ID:** B3.12 (Case B — hypothetical stretch)
- **What to build:** As a design exercise (not necessarily to ship): sketch the entity extraction over blooming's 10 golden cases. Extract entities like `payment_processor`, `checkout_step`, `mobile_segment`, and relations like `payment_processor causes payment_failure`. Compare against what plain RAG would retrieve.
- **Why it earns its place:** Even as an unshipped exercise, it teaches you when the structural signal beats the semantic one. Interview payoff: "here's the analysis I did to decide GraphRAG wasn't worth it for this codebase (and here's when it would be)."
- **Files to touch:** `docs/graphrag-analysis.md` (or a discussion doc). No production code.
- **Done when:** the analysis names 3 queries where GraphRAG would retrieve differently than plain RAG on the 10-golden corpus, and quantifies whether the difference would improve or degrade the eval.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: Would you build GraphRAG for blooming?**

Not today. The corpus doesn't have the relational density that GraphRAG's upfront cost pays for — 10 golden cases with mostly-independent anomalies. Where GraphRAG earns its place: corpora with strong entity structure — support docs where products/features/errors interconnect, or knowledge bases like a root-cause taxonomy. The load-bearing part: recognize the shape mismatch.

**Q: When would you switch to GraphRAG from plain RAG?**

Two signals. (1) plain-RAG hit@3 is below threshold and the misses share a pattern (queries that need related-not-similar chunks). (2) the corpus has a clear entity graph that's cheap to extract. Absent either, plain RAG is enough.

## See also

- [11-rag.md](11-rag.md) — the plain-RAG baseline.
- [01-embeddings.md](01-embeddings.md) — the sibling primitive.
- [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md) — where memory-shaped retrieval matters.
