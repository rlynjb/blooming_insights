# Search Ranking System

**Industry name(s):** Search & ranking, retrieval + ranking, top-k relevance serving
**Type:** Industry standard

> Take a free-text query, retrieve candidates from a corpus, score them for relevance, and return the top-k — the canonical two-stage retrieve-then-rank system.

**See also:** [02-tech-support-chatbot.md](02-tech-support-chatbot.md) · [../03-retrieval-and-rag/11-rag.md](../03-retrieval-and-rag/11-rag.md) · [../03-retrieval-and-rag/06-hybrid-retrieval-rrf.md](../03-retrieval-and-rag/06-hybrid-retrieval-rrf.md) · [../03-retrieval-and-rag/07-reranking.md](../03-retrieval-and-rag/07-reranking.md)

This file is a **system-design-template** reframe, not a per-concept study file. It is the verbatim IK-style interview prompt answered with the canonical architecture, then honestly mapped onto blooming insights. The first seven bullets are generic — they hold for any search system. Only the last two are blooming-insights-specific. Provenance: curriculum **C5.10** (build family B5.14, adapted).

---

**The prompt:** Design a search ranking system that takes a user query and returns the top-k most relevant items from a corpus.

**Standard architecture:**

```
                          ┌──────────────────────────────────────────────┐
  user query "red shoes"  │                                              │
        │                 │   QUERY UNDERSTANDING                        │
        ▼                 │   normalize · spell-fix · tokenize           │
  ┌───────────┐           │   expand synonyms · detect intent            │
  │  gateway  │──────────▶│   embed query → q-vector                     │
  └───────────┘           └───────────────────┬──────────────────────────┘
                                              │
                          ┌───────────────────┴──────────────────────────┐
                          │   CANDIDATE RETRIEVAL  (recall-oriented)      │
                          │                                              │
                          │   ┌──────────────┐      ┌──────────────────┐ │
                          │   │ sparse (BM25)│      │ dense (ANN/HNSW) │ │
                          │   │ inverted idx │      │  vector index    │ │
                          │   └──────┬───────┘      └────────┬─────────┘ │
                          │          └──────► fuse (RRF) ◄───┘           │
                          │                  → ~500 candidates           │
                          └───────────────────┬──────────────────────────┘
                                              │
                          ┌───────────────────┴──────────────────────────┐
                          │   RANKING  (precision-oriented)              │
                          │   cross-encoder / GBDT (LambdaMART) /        │
                          │   learned-to-rank over query×doc features    │
                          │   → score every candidate, sort              │
                          └───────────────────┬──────────────────────────┘
                                              │
                          ┌───────────────────┴──────────────────────────┐
                          │   SERVING + LOGGING                          │
                          │   take top-k · render · log impressions      │
                          │   log clicks/dwell → training signal ───┐    │
                          └─────────────────────────────────────────┼────┘
                                                                    │
                                            (feeds offline ranker training)
```

The shape is **two-stage**: a cheap high-recall retriever narrows millions of docs to hundreds, then an expensive high-precision ranker reorders those hundreds. You never run the expensive model over the whole corpus — that is the entire reason the architecture has two stages.

**Data model:**

- **Inverted index** — `term → posting list of doc IDs + term frequencies`. Powers sparse/BM25 retrieval; lexical, exact-match, cheap to update.
- **Vector index** — `doc ID → embedding (e.g. 768-d float32)` stored in an ANN structure (HNSW graph / IVF clusters). Powers dense semantic retrieval.
- **Document store** — `doc ID → {title, body, attributes, freshness, popularity}`. The source of truth and the feature source for the ranker.
- **Feature store / ranking features** — precomputed per-doc signals (CTR, recency, quality score) joined at rank time with query-time signals (BM25 score, vector similarity, query-doc match counts).
- **Interaction log** — append-only `(query, shown doc IDs, clicked doc ID, position, dwell, timestamp)`. This is the relevance label source for training the learned ranker.

**Key components:**

- **Query understanding** — a normalize/expand/embed step. Choice: run a cheap classifier and synonym expansion *before* the embedding call, because cleaning the query off-model is far cheaper than retrieving on a noisy query and is debuggable.
- **Dual retriever (sparse + dense)** — BM25 for exact lexical match, ANN for semantic match, fused with Reciprocal Rank Fusion. Choice: fuse with RRF rather than tuning a weighted score, because RRF needs no score normalization across two incomparable scoring scales.
- **Reranker** — a cross-encoder or gradient-boosted LTR model over the fused candidates. Choice: cross-encoder for quality (it reads query and doc *together*) accepting that it cannot scale past a few hundred candidates — which is exactly why it sits behind the retriever.
- **Serving layer** — slices top-k, renders, and emits impression + click events. Choice: log *impressions* not just clicks, otherwise you cannot compute position-debiased relevance and your training set is silently biased toward whatever the old ranker already surfaced.
- **Training pipeline** — periodically rebuilds the learned ranker from the interaction log. Choice: offline batch retrain on a fixed cadence rather than online learning, because batch is reproducible and you can eval a candidate ranker before it ever touches traffic.

**Scale concerns:**

- **Retrieval latency (hits first, ~1k QPS):** a single ANN index node saturates CPU at roughly 1k QPS for HNSW at p99 budget. Shard the index by doc-ID hash and fan out; the retriever is embarrassingly parallel, the merge step is not.
- **Reranker cost (at ~100 candidates × cross-encoder):** a cross-encoder scoring 100 query-doc pairs is ~100 forward passes per query — at 1k QPS that is 100k inferences/sec. Cap the rerank set (e.g. top-200 from retrieval), batch on GPU, and consider a cheaper distilled reranker for the long tail of queries.
- **Index size & freshness (at ~10M docs):** the HNSW graph for 10M × 768-d float32 is tens of GB of RAM per replica. Past this you quantize vectors (PQ/int8), move to IVF for memory locality, and split hot vs cold partitions. Full reindex also stops being a single job — you need incremental upserts (cross-link [../03-retrieval-and-rag/10-incremental-indexing.md](../03-retrieval-and-rag/10-incremental-indexing.md)).
- **Log volume (at ~1B impressions/day):** raw impression logging at high QPS overwhelms synchronous writes. Sample impressions, batch into a stream (Kafka), and aggregate offline — never block the serving path on a log write.

**Eval framing:**

- **Offline (no traffic):** NDCG@k and MRR against a labelled relevance set; recall@k of the *retriever* alone (a precision ranker cannot fix a candidate set that never contained the right doc). Run these on every candidate ranker before promotion.
- **Online (live traffic):** click-through rate, mean reciprocal rank of clicks, dwell time / pogo-sticking rate, abandonment rate, and the business metric (conversion). Validate with an interleaving experiment or A/B test, never offline metrics alone.
- **The trap:** offline NDCG can rise while online CTR falls if your labels are stale or position-biased. Treat offline as a *gate* (catch regressions) and online as the *decision* (ship or not).

**Common failure modes:**

- **Retriever recall ceiling** — the right doc never enters the candidate set, so no ranker can surface it. Probe: "what's your recall@500?" Mitigation: hybrid sparse+dense retrieval and monitor retriever recall separately from end-to-end NDCG.
- **Position / presentation bias in the training log** — the ranker learns "users click position 1" not "position 1 was relevant," creating a feedback loop. Mitigation: position-debias the log (inverse-propensity weighting) or use randomized exploration on a traffic slice.
- **Stale index** — new/updated docs are invisible until reindex; freshness-sensitive corpora rot fast. Mitigation: incremental indexing with a TTL on staleness and a freshness signal in the ranker.
- **Cold-start queries / docs** — no interaction history means the learned ranker has no signal. Mitigation: fall back to content-only features (BM25 + embedding similarity) for cold items and blend in popularity priors.

**Applies to this codebase:** **No** (a hair of *partially* at most). Blooming insights has no query→corpus search system. There is exactly one ranking *surface* in the entire codebase, and it is tiny: `MonitoringAgent.scan` sorts the model-produced anomaly array by a hardcoded severity rank and slices the top 10 — `const SEV_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1, positive: 0 }` at `lib/agents/monitoring.ts:50`, applied as `[...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10)` at `lib/agents/monitoring.ts:102`. That is a fixed-key top-k over a handful of items the LLM just emitted — not retrieval ranking. There is no corpus, no inverted or vector index, no candidate generation, no learned or cross-encoder ranker, and no click/impression log. What blooming insights calls "retrieval" is not index lookup at all: agents fetch live data by calling Bloomreach MCP tools (`execute_analytics_eql` and friends, declared in `lib/mcp/tools.ts`) on every run, with results bounded by `MAX_TOOL_RESULT_CHARS = 16_000` (`lib/agents/base.ts:29`) and a per-agent `maxToolCalls` budget — it is live tool-call retrieval, deliberately chosen over embedding-RAG (cross-link [../03-retrieval-and-rag/11-rag.md](../03-retrieval-and-rag/11-rag.md)). So the two-stage retrieve-then-rank architecture maps onto nothing here except a `.sort().slice()`.

**How to make it apply:** Build a "search past investigations and insights" surface — the codebase already persists the corpus, it just never searches it. The documents already exist: `getCachedInvestigation` / `saveInvestigation` in `lib/state/investigations.ts` (`:22` / `:30`) hold NDJSON event traces keyed by insight ID, and `listInsights` / `putInsights` in `lib/state/insights.ts` (`:51` / `:29`) hold the insight records. Stage 1 (retrieval): add a query→corpus lookup over those two stores — start with sparse keyword match over insight `headline`/`summary` (built in `lib/state/insights.ts`), which needs no new infrastructure. Stage 2 (signal): in `app/api/agent/route.ts`, log every investigation *open* as a relevance signal — the agent route now runs as split steps (`?step=diagnose` / `?step=recommend`, read at `route.ts:117–118`) and only the combined capture run writes to disk at `saveInvestigation(insightId!, collected)` (`app/api/agent/route.ts:254`); add an open-event log beside that step gate so every step open (not just the cached capture) records a signal. Stage 3 (rank): once enough opens are logged, introduce a reranker that reorders search hits by logged open-frequency + recency, replacing the pure lexical sort. Only then does the generic two-stage diagram describe real blooming insights code. Until a feature needs semantic recall, keep retrieval lexical — the "no vector index until a feature demands it" call is the same deliberate deferral the RAG file defends.

---
Updated: 2026-05-28 — refreshed the codebase-specific bullets only: `monitoring.ts:92`→`:102`, the `saveInvestigation` call `route.ts:162`→`:254` (now gated to the combined capture run), the `?step=` split as the open-signal append point, and corrected `lib/state/insights.ts` / `investigations.ts` line refs. Generic architecture/scale/eval sections unchanged.
