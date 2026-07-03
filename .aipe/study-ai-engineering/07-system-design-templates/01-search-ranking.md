# 01 — Search ranking system design

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
  - *Query understanding*: rewrites query for better retrieval (synonym expansion, typo correction, HyDE). Decision: rule-based for latency, LLM-rewritten for hard queries only.
  - *Retrieval*: hybrid dense + sparse with RRF fusion. Decision: keep both; sparse catches exact terms, dense catches paraphrases.
  - *Ranking*: cross-encoder rerank on top-N candidates. Decision: only rerank when retrieval confidence is low (gated by bi-encoder margin) to bound latency.
  - *Serving*: cache top-k per query for repeated queries, instrument with traces (latency per stage, retrieval recall@k).

- **Scale concerns:**
  - At ~10M docs: ANN index size exceeds RAM on single node. Solution: shard by doc id range, query all shards in parallel.
  - At ~1k QPS: cross-encoder rerank becomes latency bottleneck. Solution: cache reranks for popular queries, distill cross-encoder to smaller model for cold queries.
  - At ~100M+ docs: full corpus re-embed on embedding model upgrade becomes multi-day. Solution: incremental indexing with `embedding_version` per doc, dual-serve during migration.

- **Eval framing:**
  - Offline: hit@k, MRR, NDCG on a held-out query-doc relevance set
  - Online: click-through rate at position 1-3, dwell time, query reformulation rate (drops when ranking is good)
  - "No-click is not a negative label" — a user not clicking doesn't mean the result was bad; they may have read the snippet and gotten their answer

- **Common failure modes:**
  - Stale index → query for current product returns deprecated docs. Mitigation: `embedding_stale_at` tracking, re-embed on edit.
  - Cold queries (never seen before) → no click data to learn from. Mitigation: query similarity to known queries, fall back to sparse-only retrieval.
  - Position bias in training data → model learns "position 1 is good" not "this doc is good." Mitigation: inverse propensity scoring or randomization in some sessions.
  - Lost-in-the-middle for LLM-summary results → if results feed a downstream LLM, mid-ranked results get ignored. Mitigation: surface top-3 only or restructure the prompt.

- **Applies to this codebase:** **no**. `blooming_insights` isn't a search product. The agent's mechanism (ReAct loop over structured MCP tools) isn't retrieval — it's an LLM-driven investigation over live data via typed queries (`execute_analytics_eql`). No inverted index, no vector index, no click logs, no learned ranker. The closest shape here is the monitoring agent's "which anomaly category matches the workspace's data" gate, and even that is rule-based (see `lib/agents/categories.ts:35-42`), not learned ranking.

- **How to make it apply:** the retrofit path would be building the "similar past investigations" retrieval described in `03-retrieval-and-rag/11-rag.md` (Case B). Embed each past `Diagnosis.conclusion`, build a hybrid (dense + sparse) index, add a "similar cases" panel on the investigate page. That gives you:
  - Query understanding: the current anomaly's summary text (Sonnet rewrite optional)
  - Candidate retrieval: hybrid over past-investigation embeddings + BM25 over metric/scope tags
  - Ranking: cross-encoder rerank on top-20 candidates
  - Serving: cache per-anomaly top-3 in `sessionStorage`
  - Logging: which past cases the user opens becomes the training signal for a learned reranker later
  This is a real project. The 9-bullet interview shape maps directly onto a feature the codebase would benefit from. Curriculum Build items: `B2A.9`, `B2A.10`, `B2A.11` (past-investigation RAG add).
