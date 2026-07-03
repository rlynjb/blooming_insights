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
  - Click / interaction logs with `{query, doc_id, position, clicked, dwell_time}` for offline learning

- **Key components:**
  - *Query understanding*: rewrites query for better retrieval (synonym expansion, typo correction, HyDE). Decision: rule-based for latency, LLM-rewritten for hard queries only.
  - *Retrieval*: hybrid dense + sparse with RRF fusion. Decision: keep both; sparse catches exact terms, dense catches paraphrases.
  - *Ranking*: cross-encoder rerank on top-N candidates. Decision: only rerank when retrieval confidence is low (gated by bi-encoder margin) to bound latency.
  - *Serving*: cache top-k per query for repeated queries, instrument with traces (latency per stage, retrieval recall@k).

- **Scale concerns:**
  - At ~10M docs: ANN index size exceeds RAM on single node. Solution: shard by doc id range, query all shards in parallel.
  - At ~1k QPS: cross-encoder rerank becomes latency bottleneck. Solution: cache reranks for popular queries, distill cross-encoder to smaller model for cold queries.
  - At ~100M+ docs: full corpus re-embed on embedding model upgrade becomes multi-day. Solution: incremental indexing with `embedding_version` per doc, dual-serve during migration.

- **Eval framing:**
  - Offline: hit@k, MRR, NDCG on a held-out query-doc relevance set.
  - Online: click-through rate at position 1–3, dwell time, query reformulation rate (drops when ranking is good).
  - "No-click is not a negative label" — a user not clicking doesn't mean the result was bad; they may have read the snippet and gotten their answer.

- **Common failure modes:**
  - Stale index → query for current product returns deprecated docs. Mitigation: `embedding_stale_at` tracking, re-embed on edit.
  - Cold queries (never seen before) → no click data to learn from. Mitigation: query similarity to known queries, fall back to sparse-only retrieval.
  - Position bias in training data → model learns "position 1 is good" not "this doc is good." Mitigation: inverse propensity scoring or randomization in some sessions.
  - Lost-in-the-middle for LLM-summary results → if results feed a downstream LLM, mid-ranked results get ignored. Mitigation: surface top-3 only or restructure the prompt.

- **Applies to this codebase:** `partially`. blooming does not run a search ranking system today — there is no user-typed "search my history" surface, no click logs, no learned ranker. What blooming does have is *structurally similar* to the retrieval layer of a search ranking system: MCP tools that take a query (an EQL) and return matching rows (products, events, customers) from a corpus (the Bloomreach workspace). The monitoring agent effectively runs a "search" over the workspace's event stream, ranking anomalies by severity. Missing: click logs, learned ranker, offline hit@k eval, cold-start handling.

- **How to make it apply:**
  - Add a "search past investigations" UI surface (a search box on the feed page) that queries the would-be investigation memory index (see `B3.1` in **../03-retrieval-and-rag/01-embeddings.md**).
  - Instrument click logs — when a user opens a search result, log `{query, investigation_id, position, clicked_at}`.
  - After ~500 logged clicks, introduce a learned reranker on top of cosine similarity. Score by cosine + click-through-rate probability.
  - Wire the retrieval quality (hit@k on a hand-labeled goldens set) into the existing eval baseline in `eval/`.
  - Files to touch: new `app/search/page.tsx`, `lib/state/investigation-index.ts` (from `B3.1`), new `lib/state/click-log.ts`, extend `eval/` with `search.eval.ts` and `eval/search-goldens/`.
  - References the retrieval sub-section's exercises: `B3.1` (embeddings), `B3.4` (index), `B3.5` (sparse), `B3.6` (RRF), `B3.7` (measure hit@k), `B3.11` (aggregate).
