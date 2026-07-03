# 07 — Reranking with a cross-encoder

**Type:** Industry standard. Also called: cross-encoder rerank, two-stage retrieval.

## Zoom out, then zoom in

**Not exercised in this codebase.** Reranking sits after retrieval and improves top-k precision at the cost of latency.

## Structure pass

Axis: quality-vs-latency tradeoff. Bi-encoder retrieval is fast but coarse. Cross-encoder rerank is slow but precise. Two-stage combines them.

## How it works

### Move 1

You've paginated a DB query — fetch a bigger candidate set cheaply, then filter the top-k precisely. Same shape here.

```
  Query
    │
    ▼
  bi-encoder retrieve → top-50 candidates (~1-10ms)
    │
    ▼
  cross-encoder rerank → top-5 precise         (~50-500ms)
```

### Move 2

**Bi-encoder.** Query embedding + doc embeddings, cosine. Fast because query is embedded once, docs are pre-embedded. Coarse because each doc's embedding is independent of the query.

**Cross-encoder.** A small model that takes query + doc as a joint input, outputs a relevance score. Attends jointly to both. Much more precise. Slow because the model has to run PER query-doc pair.

**Why two stages.** Cross-encoding all N docs is expensive. Cross-encoding just the top-50 from the bi-encoder is affordable and captures most of the precision win.

**When it earns its place.** When retrieval quality is measurably bad — hit@k below your target on a held-out eval set. Add rerank; measure the improvement; keep it if the improvement is meaningful. Don't add speculatively.

### Move 3

Two-stage retrieval is the boring right pattern. Skip stage 2 when stage 1 is precise enough; skip stage 1 when the corpus is small enough to cross-encode entirely. In between (the common case), do both.

## Primary diagram

```
  Two-stage retrieval

  ┌──────────────────────────────┐
  │ Stage 1: bi-encoder retrieve │  fast, coarse, top-50
  │  (cosine similarity)         │
  └──────────────┬───────────────┘
                 │  50 candidates
                 ▼
  ┌──────────────────────────────┐
  │ Stage 2: cross-encoder rerank│  slow, precise, top-5
  │  (query + doc joint attention)│
  └──────────────┬───────────────┘
                 │
                 ▼
            Top 5 ranked
```

## Elaborate

Cross-encoders like `cross-encoder/ms-marco-MiniLM-L-6-v2` (Hugging Face) run in ~10ms per pair on CPU. Cohere and Voyage sell hosted rerank endpoints (Cohere Rerank v3 is the popular one). Both APIs take query + doc list, return relevance-scored ranking.

## Project exercises

### Exercise — Cohere Rerank on the fused top-20

- **Exercise ID:** C2.10-B · Case B (RAG not exercised).
- **What to build:** if `06-hybrid-retrieval-rrf.md`'s hybrid retrieval is present, add a Cohere Rerank pass on the top-20 from RRF. Measure hit@5 vs no-rerank on a held-out set.
- **Why it earns its place:** shows you know rerank is a measurement decision, not a habit. Interviewer signal: "I added rerank because hit@5 was below target; here's the before/after."
- **Files to touch:** `lib/rag/rerank.ts` (new), `lib/rag/retrieve.ts` (chain after RRF).
- **Done when:** report shows hit@5 with and without rerank on a held-out set of 10 query-doc pairs.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Do you always add rerank?**

No. Only when I've measured that retrieval quality is below target. Rerank adds ~100ms of latency; on a corpus where hit@5 is already 90%, that's a bad trade. On one where hit@5 is 60%, rerank often pushes it to 80% and the latency is worth it.

**Q: Why not skip bi-encoder and cross-encode everything?**

Cost. Cross-encoding 1M docs per query would be seconds of compute per query. Bi-encoder → top-50 → cross-encode is what makes the joint expressiveness affordable.

**Q: Hosted rerank vs local?**

Local models (Hugging Face cross-encoders) are 10-30ms/pair on CPU, free to run. Hosted rerank (Cohere, Voyage) is often ~50-200ms + network + fees, but stronger models on hard tasks. For a small production app, start local.

## See also

- `05-dense-vs-sparse.md` — stage 1 candidates
- `06-hybrid-retrieval-rrf.md` — fused stage 1 input
