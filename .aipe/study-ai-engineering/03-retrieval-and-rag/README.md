# 03 — retrieval and RAG

**Case B for the whole section.** blooming insights does not use embeddings,
does not have a vector store, does not chunk documents, does not perform
semantic retrieval. The agents query Bloomreach via EQL (a relational/event
query language) through MCP tools — that's the "retrieval" they do, and it's
structured queries, not semantic search.

So every concept file in this section teaches the pattern (Case B) and names
the concrete refactor target that would land it in this codebase if you
wanted to add it.

## Files

```
01-embeddings.md                  ← what an embedding is geometrically
02-embedding-model-choice.md      ← picking an embedding model
03-chunking-strategies.md         ← fixed / sentence / structural
04-vector-databases.md            ← pgvector vs sqlite-vec vs Pinecone
05-dense-vs-sparse.md             ← cosine vs BM25
06-hybrid-retrieval-rrf.md        ← combining dense + sparse
07-reranking.md                   ← two-stage retrieval w/ cross-encoder
08-query-rewriting-hyde.md        ← LLM-augmented queries
09-stale-embeddings.md            ← freshness tracking
10-incremental-indexing.md        ← deltas vs full rebuild
11-rag.md                         ← the full pipeline (LOAD-BEARING for the pattern)
12-graphrag.md                    ← graph-traversal retrieval
```

## Why this section is Case B

The agents need data — current revenue, conversion rates, customer counts. They
get it by calling MCP tools (`execute_analytics_eql`,
`list_customers_in_segment`, etc.) that hit Bloomreach Engagement. The
results come back as typed numbers and event records, not as prose chunks.
There's nothing to embed, nothing to chunk, nothing to rank by semantic
similarity.

```
  What "retrieval" looks like here vs RAG

  ┌─ This codebase (structured query) ───────────────┐
  │  agent decides EQL string                        │
  │  → execute_analytics_eql(eql)                    │
  │  → returns { rows: [{country, count, revenue}] } │
  │  → agent reads typed numbers                     │
  └──────────────────────────────────────────────────┘

  ┌─ Classic RAG (semantic retrieval) ───────────────┐
  │  user query → embed → vector search in corpus    │
  │  → returns top-k text chunks                     │
  │  → stuff chunks into context                     │
  │  → LLM answers from chunks                       │
  └──────────────────────────────────────────────────┘
```

## Where RAG WOULD land if added

The most plausible RAG surface in this codebase is **diagnosis grounding**:
when the diagnostic agent concludes "purchases dropped 38% in Brazil due to
checkout funnel collapse," it would help to retrieve and cite *prior
investigations* of similar anomalies (was there a Brazil checkout incident
last quarter? what was the resolution?). That'd need:

  → A corpus of past investigations (text + embeddings). They already exist
    on disk as `Investigation` objects in `lib/state/investigations.ts`.
  → An embedding model + vector store. pgvector if you add a database;
    sqlite-vec if you stay file-only; OpenAI's `text-embedding-3-small`
    for the embedding model.
  → A retrieval step that runs alongside (not inside) the diagnostic agent
    loop, retrieving the top-3 prior diagnoses by the anomaly's metric +
    scope, and adding them to the diagnostic agent's prompt as
    "previously seen similar anomalies."

The exercise blocks in each file name the slice that file's pattern would
own in that future refactor. Read them as a coherent program; doing them all
ships RAG end-to-end.

## What's load-bearing in this section

  → **`11-rag.md`** — the full pipeline. Read this first if you're new to
    RAG; the other files are deepenings of pieces of this pipeline.

  → **`05-dense-vs-sparse.md`** — the choice that determines what "retrieval
    quality" even means.

  → **`07-reranking.md`** — the production-quality move that makes naive
    cosine work in practice.
