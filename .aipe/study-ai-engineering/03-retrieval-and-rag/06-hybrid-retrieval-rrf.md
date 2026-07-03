# Hybrid retrieval with RRF

## Subtitle

Reciprocal Rank Fusion / rank-based merge — Industry standard.

## Zoom out, then zoom in

RRF is the merge step that combines dense and sparse retrieval outputs into one ranked list without needing calibrated scores. Each method votes by rank; documents that rank well in either method float to the top; documents ranked well in both dominate.

```
  Zoom out — where RRF fits

  ┌─ Dense retrieval ──┐    ┌─ Sparse retrieval ──┐
  └────────┬───────────┘    └──────────┬──────────┘
           │                           │
           └───────────┬───────────────┘
                       │
                       ▼
  ┌─ ★ RRF fusion ★ ────────────────────────────────┐ ← we are here
  │  score(doc) = Σ 1 / (k + rank_in_method)          │
  └──────────────────────────────────────────────────┘
                       │
                       ▼
                    merged top-k
```

## Structure pass

- **Layers:** two ranked lists → RRF score per doc → merged ranking. Three bands.
- **Axis: contribution.** Each method contributes rank, not score. That normalizes across methods that have incomparable score scales.
- **Seam:** the RRF formula. Simple; robust; no calibration needed.

## How it works

### Move 1 — the mental model

Each document's RRF score is the sum, over methods that ranked it, of `1 / (k + rank)`. `k` is a constant (typically 60). Higher ranks in either method contribute more; appearing in both methods stacks the score.

```
  RRF — the math (k=60)

  doc7 ranked #1 in dense, #1 in sparse
  → RRF = 1/(60+1) + 1/(60+1) = 0.0328

  doc3 ranked #1 in dense only
  → RRF = 1/(60+1) + 0 = 0.0164

  doc5 ranked #2 in sparse only
  → RRF = 0 + 1/(60+2) = 0.0161

  ordering: doc7 (0.0328) > doc3 (0.0164) > doc5 (0.0161)
```

### Move 2 — the step-by-step walkthrough

**Why RRF beats score-normalization.** Dense returns cosine similarities in `[-1, 1]`. BM25 returns unbounded positive scores whose magnitude depends on corpus stats. Normalizing to a common scale (min-max, z-score) requires per-corpus tuning and drifts as the corpus changes. RRF sidesteps this — it uses only rank order, not score magnitude.

**Why `k=60`.** Empirical; the original RRF paper (Cormack, Clarke, Buettcher 2009) tested a range and `k=60` performs well across corpora. Not a magic number; a robust default.

**Implementation.** ~20 lines of code:

```
  rrfMerge(rankings, k=60, topK=3):
    scores = Map<docId, number>
    for ranking in rankings:                    // dense list, sparse list
      for (rank, doc) in enumerate(ranking):
        scores[doc.id] += 1 / (k + rank + 1)   // rank 0-indexed
    sorted = scores entries sorted by score desc
    return sorted.slice(0, topK)
```

Diagram of the merge:

```
  RRF merge — one query

  dense list:  [doc3, doc7, doc1, doc4, doc9]
  sparse list: [doc7, doc2, doc5, doc3, doc8]

  RRF scores (k=60):
    doc3: 1/61 (dense#1) + 1/64 (sparse#4) = 0.0320
    doc7: 1/62 (dense#2) + 1/61 (sparse#1) = 0.0325
    doc1: 1/63 (dense#3)                   = 0.0159
    doc2:                  1/62 (sparse#2) = 0.0161
    doc5:                  1/63 (sparse#3) = 0.0159
    ...

  merged: doc7 > doc3 > doc1 ≈ doc2 ≈ doc5 ...
```

### Move 3 — the principle

Fusion by rank order is more robust than fusion by score. It requires no calibration, adapts across methods that have incomparable scales, and rewards documents that any strong method vouches for while giving priority to documents both methods agree on.

## Primary diagram

```
  Hybrid retrieval with RRF — full frame

  ┌─ Query ───────────────────────────────────────────┐
  │  "why did mobile revenue drop last week"           │
  └────────┬──────────────────────────────────────────┘
           │
           ├──────────────────────────┐
           ▼                          ▼
  ┌─ Dense retriever ─┐    ┌─ Sparse retriever ─┐
  │  embed + cosine   │    │  BM25              │
  │  top-N=10         │    │  top-N=10          │
  └────────┬──────────┘    └────────┬───────────┘
           │                        │
           └──────────┬─────────────┘
                      │
                      ▼
  ┌─ RRF fusion ──────────────────────────────────────┐
  │  score = Σ 1/(k + rank), k=60                      │
  │  sort desc, take top-K=3                           │
  └────────┬──────────────────────────────────────────┘
           │
           ▼
       top-3 for LLM prompt
```

## Elaborate

RRF is used inside many production RAG systems (LlamaIndex, LangChain, Weaviate) as the default fusion when both dense and sparse are configured. Alternative fusion methods (learned rank fusion, weighted sum) can outperform RRF with per-corpus tuning but require training data.

Related: **05-dense-vs-sparse.md** (the two inputs), **07-reranking.md** (a further-quality pass on the RRF output).

## Project exercises

### B3.6 · Add RRF merge to the would-be EQL library

- **Exercise ID:** B3.6 (Case B — not yet implemented)
- **What to build:** After `B3.5` adds sparse retrieval, add RRF fusion so the EQL library returns a merged top-3 rather than dense-only.
- **Why it earns its place:** ~20 LOC change with measurable quality improvement on mixed lexical/semantic queries. Interview payoff: naming the formula and the k=60 default.
- **Files to touch:** `lib/eql/library.ts` (add `rrfMerge()`), `test/eql/library.test.ts` (add fusion tests with known rankings).
- **Done when:** unit test verifies the merged ordering against hand-computed RRF scores; the library exports a `hybridSearch(query, k)` function.
- **Estimated effort:** `<1hr` after `B3.5` is done.

## Interview defense

**Q: Why RRF and not weighted sum?**

Weighted sum requires calibrated scores or a hand-tuned weight per method — which drifts as the corpus grows. RRF uses only ranks, so it's stable across corpora and doesn't need retuning. The load-bearing part: the formula is `1/(k + rank)`, k=60 is a robust default from the original paper, and both methods contribute additively so documents in both rise.

**Q: What's k for?**

A smoothing constant. Small k gives sharp differences between rank 1 and 2; large k flattens them. k=60 was empirically chosen for good behavior across corpus sizes. You can tune it if measurement shows the merge is over- or under-favoring top-1 hits.

## See also

- [05-dense-vs-sparse.md](05-dense-vs-sparse.md) — the two inputs.
- [07-reranking.md](07-reranking.md) — the quality pass after RRF.
- [11-rag.md](11-rag.md) — the full pipeline.
