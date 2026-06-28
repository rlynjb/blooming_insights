# 06 — hybrid retrieval with RRF

**Subtitle:** Reciprocal Rank Fusion of dense + sparse top-k · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** Combine dense (cosine) and sparse (BM25) top-k lists into one
ranking. The standard fusion is RRF — Reciprocal Rank Fusion — because it
doesn't require normalizing scores between the two methods.

```
  Zoom out — hybrid sits AFTER both retrievers, BEFORE the LLM

  ┌─ query ─────────────────────────────────────────┐
  │  ┌─ dense top-10 ──┐    ┌─ sparse top-10 ────┐  │
  │  └────────┬────────┘    └─────────┬──────────┘  │
  │           │                       │              │
  │           └─────────┬─────────────┘              │
  │                     ▼                            │  ← we are here
  │                ┌─ RRF fuse ─┐                    │   (Case B)
  │                └─────┬──────┘                    │
  │                      ▼                            │
  │              top-k (fused)                       │
  └──────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — score commensurability.** Cosine scores and BM25
    scores live on different scales (cosine: 0-1; BM25: unbounded
    positive). RRF sidesteps the problem by using *rank* not score —
    each method "votes" by where it ranked each doc.

## How it works

### Move 1 — the mental model

Voting by position. You and your friend each ranked the same restaurants;
you can't compare your 1-10 scale to their A-F scale, but you can both
agree "your #1 and their #1 are co-winners; your #5 and their nothing is
weaker."

```
  RRF — vote by rank

  for each doc d in (dense ∪ sparse):
    score(d) = sum over each method m of
                 1 / (k + rank_in_m(d))    where k = 60

  // a doc in BOTH lists adds two terms — naturally fused
  // a doc in ONE list adds one term — naturally penalized
  // higher rank → smaller denominator → larger score contribution
```

### Move 2 — the step-by-step walkthrough

**The constant `k = 60`** is the standard value from the original RRF
paper (Cormack et al., 2009). It's a smoothing constant: small enough
that rank position matters, large enough that rank-1 doesn't completely
dominate. You can tune it; 60 is a fine default.

**A worked example.** Two retrievers, top-3 each:

```
  dense:  doc3 (rank 1), doc7 (rank 2), doc1 (rank 3)
  sparse: doc7 (rank 1), doc2 (rank 2), doc5 (rank 3)

  RRF with k=60:

  doc7: 1/(60+2) [from dense] + 1/(60+1) [from sparse]
      = 0.01613 + 0.01639 = 0.03252  ← highest (in both lists)

  doc3: 1/(60+1) + 0 = 0.01639      ← dense only, but rank 1
  doc1: 1/(60+3) + 0 = 0.01587      ← dense only, rank 3
  doc2: 0 + 1/(60+2) = 0.01613      ← sparse only, rank 2
  doc5: 0 + 1/(60+3) = 0.01587      ← sparse only, rank 3

  fused ranking: doc7, doc3, doc2, doc1, doc5
```

doc7 wins because it's in both lists at high rank. Single-list docs trail.

**Hypothetical implementation for this codebase:**

```typescript
// lib/rag/hybrid.ts
interface Ranked { id: string; rank: number }

function rrf(lists: Ranked[][], k = 60): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (const { id, rank } of list) {
      const prev = scores.get(id) ?? 0;
      scores.set(id, prev + 1 / (k + rank));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

async function hybridSearch(query: string, topK = 10) {
  const dense = await store.cosineSearch(await embed(query), { topK });
  const sparse = await sparseStore.searchSparse(query, { topK });
  const denseRanked: Ranked[] = dense.map((r, i) => ({ id: r.id, rank: i + 1 }));
  const sparseRanked: Ranked[] = sparse.map((r, i) => ({ id: r.id, rank: i + 1 }));
  return rrf([denseRanked, sparseRanked]).slice(0, topK);
}
```

### Move 3 — the principle

**Combine retrievers by rank, not by score.** Different retrievers produce
incommensurable scores; ranks are universal. RRF is one line of math, no
training data needed, and consistently beats either method alone on most
benchmarks. Reach for cross-encoder reranking (next file) only after RRF
is already in place.

## Primary diagram

```
  Hybrid retrieval pipeline

  ┌─ query ────────────────────────────────────────┐
  │                                                │
  ├─►  ┌─ embed → cosineSearch ────┐ → top-10A     │
  │    │  semantic match           │              │
  │    └────────────────────────────┘              │
  │                                                │
  └─►  ┌─ tokenize → BM25 search ──┐ → top-10B     │
       │  keyword overlap          │              │
       └────────────────────────────┘              │
                                                   │
                          ▼                         │
                  ┌─ RRF fuse ─────┐                │
                  │  score(d) = Σ  │                │
                  │   1/(k + rank) │                │
                  └────────┬───────┘                │
                           ▼                         │
                     top-k (fused)                   │
                           │                         │
                           ▼                         │
                  pass to LLM as context             │
```

## Elaborate

The RRF paper benchmarked it against more sophisticated combination
methods (CombSUM with normalization, CombMNZ) and found it consistently
competitive without any score normalization or training. The simplicity
is the strength — drop it in, no tuning needed.

The next sophistication step past RRF is **cross-encoder reranking**
(see `07-reranking.md`): take the fused top-50, re-score each
(query, doc) pair with a full-attention model, return the new top-k.
Adds latency but bumps quality measurably.

## Project exercises

### Exercise — add hybrid search to the diagnosis-grounding pipeline

  → **Exercise ID:** `study-ai-eng-03-06.1`
  → **What to build:** With sparse (`05-dense-vs-sparse.md` ex 1) and
    dense (`11-rag.md` ex 1) both wired, add `lib/rag/hybrid.ts`
    exporting `hybridSearch(query, topK)`. Use it in `/api/agent` instead
    of cosine-only. Measure hit@3 on the labeled fixture before and
    after — should improve.
  → **Why it earns its place:** The fusion step is one line of math and
    consistently improves quality. Demonstrates "I know dense isn't
    enough."
  → **Files to touch:** new `lib/rag/hybrid.ts`, `app/api/agent/route.ts`
    (use `hybridSearch`), `test/rag/hybrid.test.ts`.
  → **Done when:** hit@3 metric on the fixture set is ≥ the dense-only
    baseline.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: How would you combine dense and sparse retrievers?**

Reciprocal Rank Fusion (RRF). For each doc that appears in either list,
sum `1 / (k + rank)` across the lists where it appears (k=60 standard).
Top-k by fused score. No normalization needed — RRF uses rank, not
score, which dodges the cosine-vs-BM25 score-scale mismatch.

```
  doc7 ranked 2nd in dense AND 1st in sparse:
    score = 1/(60+2) + 1/(60+1) = 0.0325  ← wins

  doc3 ranked 1st in dense only:
    score = 1/(60+1) + 0 = 0.0164
```

**Anchor line:** "RRF — votes by rank, no normalization. One function,
strict improvement over either method alone."

**Q: Why not just normalize scores and add them?**

Cosine and BM25 scores aren't naturally on the same scale; any
normalization you pick (min-max, z-score) is a choice with consequences.
RRF sidesteps the problem by using rank, which is intrinsically scale-
free. It's the lazy answer that turns out to work well — exactly the
right shape of solution for a fusion step.

## See also

  → `05-dense-vs-sparse.md` — the two top-k lists this fuses
  → `07-reranking.md` — the quality step that runs AFTER hybrid
