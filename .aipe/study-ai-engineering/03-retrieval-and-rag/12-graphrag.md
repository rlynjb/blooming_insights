# 12 — GraphRAG

**Type:** Industry standard. Also called: entity-relation retrieval, knowledge-graph RAG.

## Zoom out, then zoom in

**Not exercised in this codebase.** GraphRAG extracts entities + relations from a corpus and traverses them at query time instead of / alongside vector similarity.

## Structure pass

Axis: how do you retrieve when relevant docs don't share vocabulary with the query but ARE structurally related?
- Vector RAG: fails — no term overlap, embedding may or may not bridge.
- GraphRAG: succeeds — walks the entity graph explicitly.

## How it works

### Move 1

User asks "what did I decide about auth in the design meetings about session management?" Vector RAG embeds the query, finds top-k semantically similar chunks. If no chunk mentions "auth" AND "session management" AND "design meetings" together, retrieval may miss the right doc.

GraphRAG walks entities: [auth] → related_to → [session_management] → discussed_in → [design_meeting_3] → contains → [chunks]. The traversal finds the right meeting even when text similarity fails.

```
  Entities + relations extracted upfront

  [auth] ──relates_to──► [session management]
     │
     └──discussed_in──► [design meeting #3]
                             │
                             └──contains──► [chunks 12, 13, 14]

  query traverses graph: find entities, walk to chunks, retrieve.
```

### Move 2

**Extraction.** Run an LLM over each doc once, extract `{entity, entity, relation}` triples. Store in a graph DB (Neo4j, Kùzu) or a table.

**Retrieval.** Match query to entities. Walk the graph N hops from those entities. Return chunks associated with visited nodes.

**Combined with vector RAG.** Best of both — graph retrieval finds structurally-related docs; vector retrieval catches paraphrases within them.

**Cost.** Extraction is a big up-front LLM cost (one call per doc, ~$0.005-0.02 each). At 10K docs, that's $50-200 one-time.

**When it beats vector RAG.** Corpora with strong entity structure (meeting notes, project docs, org wikis, code) where the query names an entity or relation rather than a topic. Vector RAG handles topics; GraphRAG handles connections.

### Move 3

GraphRAG shines when the corpus has entity structure and queries traverse it. For text-similarity queries, vector RAG is simpler. Hybrid (both) works when both are cheap enough to run.

## Primary diagram

```
  GraphRAG flow

  ┌─ Ingestion (one-time) ────────────────────────────────────────────┐
  │  for each doc:                                                    │
  │    LLM extract entities + relations → {entity, entity, relation}  │
  │    store in graph DB                                              │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Query time ──────────────────────────────────────────────────────┐
  │  query text                                                       │
  │    │                                                              │
  │    ▼ named-entity extract                                          │
  │  entity ids                                                       │
  │    │                                                              │
  │    ▼ graph traversal                                              │
  │  visited nodes                                                    │
  │    │                                                              │
  │    ▼ pull chunks associated with visited nodes                    │
  │  retrieved chunks                                                 │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

GraphRAG was popularized by Microsoft's 2024 paper of the same name. The core idea (entity extraction + graph traversal) is older — it's the retrieval side of question-answering over knowledge bases. The 2024 GraphRAG paper's contribution was scaling the extraction using LLMs and combining hierarchical community summaries with the entity graph.

## Project exercises

### Exercise — small GraphRAG over agent tool traces

- **Exercise ID:** C2.15-B · Case B (RAG not exercised).
- **What to build:** across past investigations, extract entities `{metric, scope, category, tool}` and relations `{caused_by, co_occurred_with, resolved_by}`. Build a small graph (~few hundred nodes). At query time, extract entities from the incoming anomaly, walk 2 hops, pull chunks.
- **Why it earns its place:** the entity structure IS present (metric-scope-category-tool graph). GraphRAG could add real value for the "similar past" retrieval that vector RAG might miss.
- **Files to touch:** `lib/rag/graph.ts` (new), `lib/rag/retrieve.ts` (add graph traversal branch).
- **Done when:** given an anomaly, the traversal surfaces 3 past investigations with matching entity graph paths, not just semantic similarity.
- **Estimated effort:** 1 week.

## Interview defense

**Q: GraphRAG vs vector RAG?**

Vector RAG on topics; GraphRAG on connections. Query "how do we handle auth" is a topic — vector RAG shines. Query "which decisions link session management to auth" is a connection — GraphRAG shines. Real production often uses both, gated by query shape.

**Q: What's the up-front cost?**

Extraction — one LLM call per doc to pull entities and relations. At 10K docs and Sonnet-cost, that's $50-100 one-time. Ongoing cost is just the incremental extraction on new docs.

**Q: When wouldn't you use it?**

When your corpus is homogeneous prose with weak entity structure (news articles, blog posts). The graph would be trivial and vector RAG would do just as well at a fraction of the setup cost.

## See also

- `11-rag.md` — the umbrella
- `04-agents-and-tool-use/05-agent-memory.md` — agent memory has a graph-shaped variant too
