# RAG concepts not yet exercised

*Industry standard — honest gap inventory for the rest of the retrieval discipline*

## Zoom out — where this concept lives

The base spec walks 12 RAG concepts. Two — `01-schema-as-retrieval.md` and `02-schema-gated-coverage.md` — are actually exercised here. The other ten are not. This file names each, explains what it WOULD look like in this codebase if it landed, and is honest about why none of them are pressing today.

```
  Zoom out — what's in the spec vs what's in the code

  ┌─ Spec's RAG sub-section ─────────────────────────────────┐
  │  ✓ schema-as-retrieval         (this codebase)            │
  │  ✓ schema-gated coverage       (this codebase)            │
  │  ✗ embeddings                  not yet exercised          │
  │  ✗ embedding model choice      not yet exercised          │
  │  ✗ chunking strategies         not yet exercised          │
  │  ✗ vector databases            not yet exercised          │
  │  ✗ dense vs sparse retrieval   not yet exercised          │
  │  ✗ hybrid retrieval with RRF   not yet exercised          │
  │  ✗ reranking                   not yet exercised          │
  │  ✗ query rewriting and HyDE    not yet exercised          │
  │  ✗ stale embeddings            not yet exercised          │
  │  ✗ incremental indexing        not yet exercised          │
  │  ✗ RAG (classical)             not yet exercised          │
  │  ✗ GraphRAG                    not yet exercised          │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** This codebase reasons over a *small, structured* corpus (workspace schema). The classical RAG stack (embed → ANN → retrieve → augment) solves the *large, unstructured* corpus problem. Different shape; different solution. The file is here so the audit can be honest, not aspirational.

## Structure pass — layers · axes · seams

**Layers:** corpus → indexing → retrieval → augmentation.

**Axis: where's the corpus's shape on the structured-vs-unstructured spectrum?** This codebase: structured (a typed schema). Classical RAG: unstructured (a pile of documents).

**Seam:** there *isn't* one today. If unstructured retrieval ever shows up here (e.g. Bloomreach docs become a corpus the agent searches), the natural seam is the agent's tool list — a new `search_docs` tool would join the existing 13+ MCP tools.

## How it works

### Move 1 — the mental model

You know how a hash map is the right data structure for `O(1)` key lookup, but you'd use a B-tree for range queries? Same shape here — the retrieval pattern should match the corpus shape. Schema retrieval (this codebase) and vector retrieval (classical RAG) are different data structures for different access patterns.

```
  Two retrieval shapes — match the corpus

  Schema retrieval                    Vector retrieval
   ───────────────                     ────────────────
   Corpus: typed, finite               Corpus: text, large
   "events, properties, catalogs"      "thousands of docs"

   Lookup: read the whole thing        Lookup: embed query,
                                        find top-k similar

   Cost:   bootstrap once + cache      Cost: embed at index time
                                        + ANN at query time

   Bite:   schema drift                 Bite: stale embeddings,
                                        chunking, reranking,
                                        lost-in-the-middle, ...

   Right when: small, structured corpus    Right when: large, unstructured
```

### Move 2 — the step-by-step walkthrough

Each concept below gets one paragraph: what it is, what it would look like if it landed, why it doesn't apply today.

**Part 1 — embeddings and embedding model choice.**

  → **Concept.** Text → vector in N-dim space; similar meanings end up close.
  → **Where it would land.** If a `lib/retrieval/embed.ts` module appeared (e.g. for Bloomreach docs search), it'd embed chunks at index time and queries at lookup time. Likely model: `text-embedding-3-small` (English, hosted, cheap baseline).
  → **Why not today.** No unstructured corpus to embed. The workspace schema is already typed; the data accessed via EQL is queried fresh per turn.

**Part 2 — chunking strategies.**

  → **Concept.** Split documents into chunks (fixed-size, sentence-window, structural) so each chunk is a meaningful retrievable unit.
  → **Where it would land.** Bloomreach docs would chunk by markdown heading (structural chunking, ~200-500 tokens per chunk).
  → **Why not today.** Nothing to chunk.

**Part 3 — vector databases.**

  → **Concept.** Storage layer for vectors + ANN index. Options: pgvector (Postgres), sqlite-vec (local), Pinecone/Weaviate/Qdrant (managed).
  → **Where it would land.** This codebase has no database at all (in-memory state + session cookies; see `study-system-design`). Adding a vector DB would mean adding a DB. The Vercel deployment shape favors managed (Pinecone, Qdrant Cloud) over self-hosted Postgres+pgvector for ops simplicity.
  → **Why not today.** No corpus, no DB.

**Part 4 — dense vs sparse retrieval, hybrid RRF.**

  → **Concept.** Dense (embeddings) catches paraphrases; sparse (BM25) catches exact terms; hybrid combines both, fused with Reciprocal Rank Fusion.
  → **Where it would land.** Bloomreach docs are technical — code identifiers, exact event names — so sparse would matter as much as dense. Hybrid via RRF would be the right shape.
  → **Why not today.** No corpus.

**Part 5 — reranking with a cross-encoder.**

  → **Concept.** Bi-encoder retrieves top-50 fast; cross-encoder reranks to top-5 with full attention on the (query, doc) pair.
  → **Where it would land.** Only worth it once measured retrieval hit@k is bad. Premature for a codebase that doesn't retrieve at all.
  → **Why not today.** No corpus.

**Part 6 — query rewriting and HyDE.**

  → **Concept.** LLM rewrites the query (or generates a hypothetical answer to embed) to bridge query-document vocabulary gaps.
  → **Where it would land.** If users ask vague questions ("fix the auth thing"), an LLM rewrite to retrievable terms would help. Adds an LLM call per query.
  → **Why not today.** The intent classifier already exists (`01-llm-foundations/07-heuristic-before-llm.md`); it shapes routing, not retrieval. There's no retrieval to enhance.

**Part 7 — stale embeddings.**

  → **Concept.** Document text changes; embedding doesn't update; lookups return outdated content.
  → **Where it would land.** If Bloomreach docs were embedded, freshness would need an `embedding_stale_at` per row + a re-embed pass.
  → **Why not today.** Nothing embedded; nothing to go stale.

**Part 8 — incremental indexing.**

  → **Concept.** Track per-doc changes (created/updated/deleted) → re-embed only deltas → merge into index.
  → **Where it would land.** Required once the corpus is too big to nightly-rebuild and too live to wait for batch.
  → **Why not today.** No index.

**Part 9 — RAG (the full pipeline).**

  → **Concept.** Retrieve top-k chunks → stuff into prompt → LLM generates answer from retrieved context.
  → **Where it would land.** Bloomreach docs RAG would let the query agent answer "how do I configure a scenario for X?" type questions with citations.
  → **Why not today.** The query agent answers from live workspace data via EQL — that's the substrate the user actually cares about. Docs RAG would be an adjacent feature, not a replacement.

**Part 10 — GraphRAG.**

  → **Concept.** Entities and relationships extracted from the corpus upfront; queries traverse the graph; retrieval follows structural relations, not vocabulary similarity.
  → **Where it would land.** Bloomreach workspaces ARE graph-shaped (customers → events → products; segments → campaigns → scenarios). A GraphRAG over Bloomreach metadata would let the agent traverse relationships ("show me the campaigns for the segment that bought from this scenario").
  → **Why not today.** The graph traversal currently lives inside EQL queries themselves (joins, lookups). The agent reaches it through tool calls, not through a pre-extracted graph index.

### Move 3 — the principle

**Honest gap > aspirational gap.** Every concept above is real and important in *some* codebase. None is pressing in *this* codebase today, because the corpus shape is small, structured, and freshly-queryable. The audit's value is naming the gap clearly so a future "we should add docs RAG" decision starts from a real list of what's involved.

## Primary diagram — the full recap

```
  The RAG concept inventory mapped to this codebase

  Concept                              Status in this codebase
  ───────────────────────────────────────────────────────────────────
  Embeddings                           not yet exercised — no corpus
  Embedding model choice               n/a
  Chunking strategies                  n/a — nothing to chunk
  Vector databases                     n/a — no DB in this codebase
  Dense vs sparse retrieval            n/a
  Hybrid retrieval with RRF            n/a
  Reranking (cross-encoder)            n/a — no retrieval to rerank
  Query rewriting and HyDE             n/a — intent classifier is the only LLM-routing
  Stale embeddings                     n/a — nothing embedded
  Incremental indexing                 n/a — no index
  RAG (classical)                      n/a — schema-as-retrieval is the local equivalent
  GraphRAG                             n/a — graph traversal lives in EQL today

  What IS here:
  ───────────────────────────────────────────────────────────────────
  Schema-as-retrieval                  ✓ see 01-schema-as-retrieval.md
  Schema-gated coverage                ✓ see 02-schema-gated-coverage.md
```

## Elaborate

**Why this file is one consolidated walk, not ten files.** Each concept gets a fair name + a one-paragraph "what it would look like here" + a one-sentence "why not today." A separate file per concept would be 80% repetition ("not implemented because there's no corpus") and 20% actual content. Consolidating makes the honest-gap-inventory the file's actual content.

**The Bloomreach docs case is the most likely future surface.** If unstructured retrieval ever lands here, it's the Bloomreach docs corpus that triggers it. The shape would be: chunk docs by markdown heading → embed with a hosted model (`text-embedding-3-small` likely) → store in a managed vector DB (Pinecone or Qdrant Cloud to avoid adding a Postgres dependency) → new `search_docs` MCP-style tool → query agent gains a "look this up in the docs" capability. None of this is on the roadmap; it's the natural shape if it ever shows up.

**GraphRAG is the second-most-likely.** Bloomreach workspaces are graph-shaped (customer → event → product, segment → campaign → scenario). Extracting that graph upfront and letting the agent traverse it would replace some of the multi-call EQL chains the diagnostic agent runs today. Higher payoff than docs RAG; bigger lift to implement.

## Project exercises

### Exercise — Bloomreach docs RAG as a single tool surface

  → **Exercise ID:** B3.3
  → **What to build:** Chunk the Bloomreach docs by markdown heading, embed with `text-embedding-3-small`, store in `lib/retrieval/docs.json` (a flat JSON file — corpus is small enough not to need a DB). Add a `search_docs(query: string, limit: number)` tool exposed via `SyntheticDataSource.listTools()` (so it doesn't require Bloomreach MCP). Query agent gains the capability to look up docs when the user's question is about *how* to configure something rather than *what* the data says.
  → **Why it earns its place:** turns the largest "not yet exercised" gap into a real, scoped exercise. Forces you through the full embed → chunk → retrieve → augment pipeline at a corpus size where you can verify hit@k manually. Adds a genuinely useful product capability (the query agent currently can't answer "how do I configure a scenario?" questions).
  → **Files to touch:** new `lib/retrieval/docs.ts` (chunker + embedder + lookup), new `lib/retrieval/docs.json` (committed embeddings), `lib/data-source/synthetic-data-source.ts` (add `search_docs` to tool list), `lib/agents/query.ts` or AptKit prompt (extend to handle docs queries), `test/retrieval/docs.test.ts` (cover chunking, embedding shape, top-k lookup).
  → **Done when:** the query agent can answer "how do I set up a voucher scenario?" with retrieved doc citations, the embedding lookup is sub-100ms (corpus is small), and the synthetic data source path works without Bloomreach auth.
  → **Estimated effort:** ≥1 week.

## Interview defense

**Q: "Why doesn't your codebase have RAG?"**

Because the corpus shape doesn't justify it. This app reasons over a *small, structured* corpus — the Bloomreach workspace schema — which I retrieve once at session start, cache, and summarize into the agent's prompt. Classical RAG (embed → ANN → retrieve → augment) solves the *large, unstructured* corpus problem. Different shape; different solution.

The honest gap is the Bloomreach docs corpus — if the product needed "how do I configure this?" answers, docs RAG would be the right shape. Not on the roadmap today.

*Anchor: "Small structured corpus → schema-as-retrieval. RAG is for unstructured. `B3.3` is the docs path if it ever lands."*

**Q: "What's the load-bearing test for whether RAG is the right shape?"**

Three questions: Is the corpus large (>~1000 documents)? Is it unstructured (free text, not typed records)? Does the user's query land on a *subset* of it (not the whole thing)? If all three are yes, RAG. If any is no, a simpler retrieval pattern likely beats it. This codebase fails all three for the workspace schema corpus — it's small (~50-200 events), structured (typed), and the agent reads the whole shape every turn.

*Anchor: "Large + unstructured + subset queries → RAG. Otherwise simpler retrieval."*

## See also

  → `01-schema-as-retrieval.md` — the retrieval pattern that IS exercised
  → `02-schema-gated-coverage.md` — the gating layer on top of it
  → `audit.md` — the audit's lens 3 names the same gap
