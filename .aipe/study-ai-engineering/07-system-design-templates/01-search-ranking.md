# 01 — search ranking system design

- **The prompt:** "Design a search ranking system that takes a user
  query and returns the top-k most relevant items from a corpus."

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
                 │  N=500 candidates
                 ▼
  ┌──────────────────────────────────┐
  │ Ranking                          │
  │  (cross-encoder OR learned model)│
  └──────────────┬───────────────────┘
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
  - Document corpus with `{id, text, metadata, created_at, embedding}` per item.
  - Inverted index for sparse retrieval (BM25 term → doc IDs).
  - Vector index for dense retrieval (embedding → doc IDs, ANN via HNSW
    for >100k items).
  - Click / interaction logs with `{query, doc_id, position, clicked,
    dwell_time, session_id, ts}` for offline learning of the ranker.

- **Key components:**
  - *Query understanding*: rewrites the query for better retrieval
    (synonym expansion, typo correction, HyDE for ambiguous queries).
    Decision: rule-based for latency, LLM-rewritten for hard queries
    only (gate by query length / OOV ratio).
  - *Retrieval*: hybrid dense + sparse with RRF fusion. Decision: keep
    both — sparse catches exact terms (CVE numbers, brand names),
    dense catches paraphrases.
  - *Ranking*: cross-encoder rerank on top-N candidates. Decision: only
    rerank when retrieval confidence is low (gated by bi-encoder
    margin) to bound latency.
  - *Serving*: cache top-k per (normalized query) for repeated queries;
    instrument with traces (latency per stage, retrieval recall@k,
    rerank impact).

- **Scale concerns:**
  - At ~10M docs: ANN index size exceeds RAM on single node. Solution:
    shard by doc id range, query all shards in parallel, merge top-k.
  - At ~1k QPS: cross-encoder rerank becomes latency bottleneck.
    Solution: cache reranks for popular queries, distill cross-encoder
    to smaller model for cold queries, gate reranking on retrieval
    confidence.
  - At ~100M docs: full corpus re-embed on embedding model upgrade
    becomes multi-day. Solution: incremental indexing with
    `embedding_version` per doc, dual-serve during migration (v1
    index serves while v2 index builds; atomic swap when ready).

- **Eval framing:**
  - Offline: hit@k, MRR, NDCG on a held-out query-doc relevance set.
  - Online: click-through rate at position 1-3, dwell time, query
    reformulation rate (drops when ranking is good).
  - "No-click is not a negative label" — a user not clicking doesn't
    mean the result was bad; they may have read the snippet and gotten
    their answer. Use dwell + scroll signals instead.

- **Common failure modes:**
  - Stale index → query for current product returns deprecated docs.
    Mitigation: `embedding_stale_at` tracking, re-embed on edit
    (see `03-retrieval-and-rag/09-stale-embeddings.md`).
  - Cold queries (never seen before) → no click data to learn from.
    Mitigation: query similarity to known queries, fall back to
    sparse-only retrieval for unseen queries.
  - Position bias in training data → model learns "position 1 is
    good" not "this doc is good." Mitigation: inverse propensity
    scoring, or randomized exploration in some sessions.
  - Lost-in-the-middle for LLM-summary results → if results feed a
    downstream LLM, mid-ranked results get ignored. Mitigation:
    surface top-3 only OR restructure the prompt (see
    `02-context-and-prompts/02-lost-in-the-middle.md`).

- **Applies to this codebase:** **No.** blooming insights does not have
  a search surface. Bloomreach EQL queries return data by metric and
  scope, not by semantic similarity. There's no document corpus, no
  embedding index, no ranking — the user clicks a metric anomaly card
  and gets an investigation, not a ranked list of results.

  The closest analog would be the **diagnosis-grounding RAG**
  hypothesized in `03-retrieval-and-rag/11-rag.md` — past investigations
  ranked by similarity to a current anomaly. That's a retrieval problem
  with ranking, but it's per-investigation (not per-query), and the
  ranking signal is limited to similarity (no learned model on click
  signal, because there's no "click on a diagnosis" surface).

- **How to make it apply:** Two paths.

  **Path A (small, illustrative):** Build a "search my past
  investigations" UI surface on top of the diagnosis-grounding RAG
  from `03-retrieval-and-rag/11-rag.md`. User types a free-form query
  ("BRL revenue drops"), the system retrieves top-10 past investigations
  via dense + sparse + RRF (the patterns from
  `03-retrieval-and-rag/05-dense-vs-sparse.md` and
  `06-hybrid-retrieval-rrf.md`), and ranks them. Instrument click logs
  (which investigation did the user open from the results?) for future
  learned reranker. References exercises 03-11.1, 03-05.1, 03-06.1.

  **Path B (illustrative-only — defend without building):** Walk
  through this template as "I haven't built a search system in
  blooming insights, but I have built RAG-shaped retrieval (diagnosis
  grounding) in my other portfolio work. Here's how I'd apply this
  template to the diagnosis-grounding case — and here's what additional
  work would be needed to make it a real product search surface."

  Path A is the strongest interview signal (you built it); Path B is
  the honest defense when time is limited.
