# 06 — Hybrid retrieval with RRF

**Type:** Industry standard. Also called: Reciprocal Rank Fusion.

## Zoom out, then zoom in

**Not exercised in this codebase.** RRF combines dense + sparse results without needing to normalize scores between them.

## Structure pass

Axis: how do you merge two ranked lists with incompatible score scales? Answer: rank-based fusion; each list "votes" by position.

## How it works

### Move 1

You have two ranked lists (dense top-k, sparse top-k). Their scores aren't on the same scale (cosine is [-1, 1]; BM25 is unbounded). You need a way to merge that's robust to that. RRF is that way.

```
  RRF — vote by rank, not by score

  score(doc) = sum over lists of  1 / (k + rank_in_list)
  (k is a constant, typically 60)

  a doc ranked #1 in one list and #3 in another beats
  a doc ranked #1 in one list but absent from the other.
```

### Move 2

Formula: `score(doc) = Σ 1/(k + rank_i)` where `rank_i` is the doc's rank in list i (or ∞ if absent), and `k` is a smoothing constant (60 is Cormack et al.'s default from the 2009 paper).

**Why rank not raw score.** Because a cosine of 0.85 and a BM25 of 15.3 aren't comparable. Ranks are. Doc that shows up in the top of BOTH lists wins the fusion.

**Why k = 60.** Damps the influence of a single list's top item, so a doc that's #1 in list A and #10 in list B still has a chance. Higher k = more egalitarian, lower k = more winner-take-all. 60 is empirically robust across corpora.

### Move 3

RRF is the boring right default for hybrid retrieval. Score normalization (min-max, z-score) is fragile across queries; rank fusion isn't.

## Primary diagram

```
  RRF worked example

  Dense top:  [D3, D7, D1, D9]
  Sparse top: [D7, D2, D5, D3]

  scores (k=60):
    D3: 1/(60+1) + 1/(60+4) = 0.0164 + 0.0156 = 0.032
    D7: 1/(60+2) + 1/(60+1) = 0.0161 + 0.0164 = 0.033
    D1: 1/(60+3)             = 0.0159
    D9: 1/(60+4)             = 0.0156
    D2: 1/(60+2)             = 0.0161
    D5: 1/(60+3)             = 0.0159

  Fused ranking: [D7, D3, D2, D1, D5, D9]
  (D7 wins — in top-2 of both lists)
```

## Elaborate

RRF assumes both lists are ranking the same underlying corpus. If dense searches over one index and sparse over another, that's fine — as long as the docs are the same set of things.

## Project exercises

### Exercise — implement RRF fusion

- **Exercise ID:** C2.9-B · Case B (RAG not exercised).
- **What to build:** `fuseRRF(lists: string[][], k = 60): string[]` in `lib/rag/rrf.ts`. Takes N ranked lists of doc ids, returns fused ranking.
- **Why it earns its place:** the standard fusion primitive. Interviewer signal: "I fuse without normalizing scores; here's why RRF beats score-based fusion."
- **Files to touch:** `lib/rag/rrf.ts` (new), `lib/rag/retrieve.ts` (call fusion).
- **Done when:** unit test verifies the worked example above.
- **Estimated effort:** <1hr.

## Interview defense

**Q: Why RRF over score normalization?**

Score normalization is fragile. Cosine 0.85 might be top-1 in one query and top-100 in another; min-max normalization doesn't fix that. Ranks are stable — top-1 is always top-1 regardless of what the query is. RRF trades rank-precision (loses the numeric spread) for cross-list robustness.

**Q: What does k control?**

Smoothing. Higher k = flatter contribution per rank; a doc's rank matters less. Lower k = top ranks dominate. 60 is the "just works" value from Cormack et al.'s original paper; production systems rarely tune it.

**Q: What if a doc is only in one list?**

Its score is just `1/(k + rank)` from that single list. It can still rank in the fused output, but a doc in BOTH lists (even at middling rank in each) tends to beat it. That's the whole point — the fusion rewards agreement.

## See also

- `05-dense-vs-sparse.md` — the two lists this fuses
- `07-reranking.md` — the next stage that can polish the fused top
