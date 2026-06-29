# Search ranking system design

- **The prompt:** "Design a search ranking system that takes a user query and returns the top-k most relevant items from a corpus."

- **Standard architecture:**

```
  Query
    │
    ▼
  ┌──────────────────────────────────┐
  │ Query understanding              │
  │  (tokenize, expand, rewrite)     │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ Candidate retrieval              │
  │  (dense + sparse, top-N)         │
  └──────────────┬───────────────────┘
                 │
                 │  N candidates (N=500)
                 ▼
  ┌──────────────────────────────────┐
  │ Ranking                          │
  │  (cross-encoder, learned model)  │
  └──────────────┬───────────────────┘
                 │
                 │  top-k (k=10)
                 ▼
  ┌──────────────────────────────────┐
  │ Serving + logging                │
  │  (cache, instrument, return)     │
  └──────────────┬───────────────────┘
                 │
                 ▼
              Results
```

- **Data model:**
  - Document corpus with `{id, text, metadata, created_at, embedding}` per item
  - Inverted index for sparse retrieval (BM25 term → doc IDs)
  - Vector index for dense retrieval (embedding → doc IDs, ANN via HNSW)
  - Click/interaction logs with `{query, doc_id, position, clicked, dwell_time}` for offline learning

- **Key components:**
  - *Query understanding:* rewrites query for better retrieval (synonym expansion, typo correction, HyDE). Decision: rule-based for latency, LLM-rewritten for hard queries only.
  - *Retrieval:* hybrid dense + sparse with RRF fusion. Decision: keep both; sparse catches exact terms, dense catches paraphrases.
  - *Ranking:* cross-encoder rerank on top-N candidates. Decision: only rerank when retrieval confidence is low (gated by bi-encoder margin) to bound latency.
  - *Serving:* cache top-k per query for repeated queries, instrument with traces (latency per stage, retrieval recall@k).

- **Scale concerns:**
  - At ~10M docs: ANN index size exceeds RAM on single node. Solution: shard by doc id range, query all shards in parallel.
  - At ~1k QPS: cross-encoder rerank becomes latency bottleneck. Solution: cache reranks for popular queries, distill cross-encoder to smaller model for cold queries.
  - At ~100M+ docs: full corpus re-embed on embedding model upgrade becomes multi-day. Solution: incremental indexing with `embedding_version` per doc, dual-serve during migration.

- **Eval framing:**
  - Offline: hit@k, MRR, NDCG on a held-out query-doc relevance set
  - Online: click-through rate at position 1–3, dwell time, query reformulation rate (drops when ranking is good)
  - "No-click is not a negative label" — a user not clicking doesn't mean the result was bad; they may have read the snippet and gotten their answer

- **Common failure modes:**
  - Stale index → query for current product returns deprecated docs. Mitigation: `embedding_stale_at` tracking, re-embed on edit.
  - Cold queries (never seen before) → no click data to learn from. Mitigation: query similarity to known queries, fall back to sparse-only retrieval.
  - Position bias in training data → model learns "position 1 is good" not "this doc is good." Mitigation: inverse propensity scoring or randomization in some sessions.
  - Lost-in-the-middle for LLM-summary results → if results feed a downstream LLM, mid-ranked results get ignored. Mitigation: surface top-3 only or restructure the prompt.

- **Applies to this codebase:** `partially`.

  Two pieces of a search ranking system exist in blooming_insights, none of the others. Present: (1) the **schema-as-retrieval pattern** at `lib/mcp/schema.ts:174` (`bootstrapSchema`) is the "candidate retrieval" layer's structured analog — the workspace schema is the candidate space, sorted by event count descending at `lib/mcp/schema.ts:107`. (2) The **gating layer** at `lib/agents/categories.ts:46` (`runnableCategories`) is structurally a coarse rerank — it narrows the candidate space by hard rule before any expensive selection.

  Missing: vector embeddings, BM25 sparse index, cross-encoder reranking, click logs, learned ranker, hit@k measurement. The user's "query" today is implicit (the agent reads the whole schema and decides); there is no user query in the search-ranking sense.

  The closest match in product shape would be: the briefing feed is a "ranked list of anomalies." The ranking is severity-based + LLM-scored, not learned from click data. That's a *ranking surface*, just not a search-ranking surface.

- **How to make it apply:**

  Three concrete refactors, in increasing depth:

  1. **Surface the briefing feed as a search-ranked product.** Add a free-form filter UI ("show me revenue anomalies in USA over the last week"), parse via the existing intent classifier, run a structured query against the in-memory feed, return ranked anomalies. Instruments the click logs (`{query, anomalyId, clicked, dwell}`) at the UI boundary. This turns the existing feed into a search-ranking shape without adding a vector store.

  2. **Add docs RAG as a separate search-ranked surface** (`B3.3` in `03-retrieval-and-rag/03-rag-concepts-not-yet-exercised.md`). Chunk Bloomreach docs by markdown heading, embed with `text-embedding-3-small`, store in `lib/retrieval/docs.json`, expose as `search_docs(query, limit)` tool. Now the query agent can answer "how do I configure X?" with retrieved doc citations.

  3. **Learned reranker on logged clicks**, after step 2 has accumulated ~500 clicks. Use a gradient-boosted ranker on per-doc features (recency, click count, query-doc embedding distance). Compare hit@k against the unranked baseline.

  Reference exercises: `B3.3` (docs RAG) is the prerequisite; the learned ranker is post-MVP.
