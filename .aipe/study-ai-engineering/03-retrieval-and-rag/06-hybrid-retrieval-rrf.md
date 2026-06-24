# Hybrid retrieval + Reciprocal Rank Fusion (run both, fuse the rankings)

**Industry name(s):** hybrid search, dense+sparse fusion, Reciprocal Rank Fusion (RRF), rank fusion
**Type:** Industry standard · Language-agnostic

> Hybrid retrieval runs a dense (meaning) and a sparse (exact-term) search in parallel and merges their rankings — Reciprocal Rank Fusion combines two ranked lists using only positions, no score calibration — so a query gets both the synonym hits and the exact-term hits; blooming insights runs only one retrieval (sparse EQL), so this is study material and a buildable target.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Hybrid retrieval is the *fusion step* that sits after both a dense and a sparse retriever in a retrieval pipeline. RRF is the fusion *algorithm* — a position-based merge of two ranked lists into one. blooming insights has neither retriever and no fusion step; this layer would receive top-k from each side and emit one ranked list to the LLM context.

```
  Zoom out — where hybrid + RRF sits (WOULD BE)

  ┌─ Query ──────────────────────────────────────────┐
  └─────────────────────────┬────────────────────────┘
              ┌─────────────┴────────────┐
              ▼                          ▼
  ┌─ Sparse retriever ─┐      ┌─ Dense retriever ─┐
  │  BM25 ranked list   │      │  cosine ranked list│
  │  scores: unbounded  │      │  scores: [0, 1]   │
  └────────────┬────────┘      └─────────┬─────────┘
               │ ranked positions          │ ranked positions
               └────────────┬──────────────┘
                            ▼
  ┌─ Hybrid fusion (RRF) ──────────────────────────┐  ← we are here
  │  ★ score(d) = Σ 1/(k + rank_list(d)) ★          │
  │  ignore raw scores; fuse by RANK only            │
  └─────────────────────────┬──────────────────────┘
                            │  one ranked list
  ┌─ Reranker / LLM context ▼──────────────────────┐
  │  top-k goes into the prompt                     │
  └─────────────────────────────────────────────────┘

  In this codebase: Not yet implemented — String.includes
  intent matching in lib/agents/intent.ts is what exists
  instead; there is no dense retriever to fuse with.
```

**Zoom in — narrow to the concept.** The question is: how do you fuse two (or more) ranked lists into one when the lists' scores are on different, uncomparable scales? A cosine similarity is in [0, 1]; a BM25 score is unbounded — adding them lets BM25 dominate, and calibrating them against each other is corpus-specific and fragile. RRF sidesteps calibration entirely by summing reciprocal *ranks* instead of scores. How it works walks the formula, the one constant (`k ≈ 60`), and why a document near the top of *either* list rises in the fused result.

---

## Structure pass

**Layers.** Three WOULD-BE layers: two parallel retrievers (sparse BM25 and dense cosine), the RRF fusion layer that merges their ranked lists into one, and the reranker / LLM context that consumes the fused list. Each retriever emits its top-k; RRF runs over positions, not scores.

**Axis: state.** What state does each layer consume — *raw scores* on incompatible scales, or *positions* (ranks) on compatible scales? This axis is the right lens because RRF's whole trick is *state simplification*: throw away the unbounded BM25 scores and the [0,1] cosines, keep only the rank-positions, which are comparable. Cost is downstream of this state choice; the upstream move is the lossy projection from "score" to "position."

**Seams.** The cosmetic seam is between the two retrievers — they both emit ranked lists. The load-bearing WOULD-BE seam is between the retrievers and the RRF fusion layer: state flips here from "scored ranked list (incompatible scales)" to "rank-only list (sum of 1/(k+rank))." This is the seam the RRF algorithm exists to bridge. The next seam (fusion → reranker) is cosmetic at this resolution — both consume ranked candidates.

```
  Structure pass — hybrid retrieval + RRF (WOULD BE)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  sparse retriever (BM25 ranked list)           │
  │  dense retriever (cosine ranked list)          │
  │  RRF fusion (positions, not scores)            │
  │  (downstream: reranker / LLM context)          │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  state: raw scores (incompatible) vs           │
  │  positions (comparable)?                       │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  sparse↔dense: cosmetic (both ranked lists)    │
  │  retrievers↔RRF: LOAD-BEARING                  │
  │    scored lists → rank-only fusion             │
  │    avoids score calibration entirely           │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Picture two leaderboards for the same set of players, scored by different games. You cannot average a chess Elo with a tennis ranking — different scales. But you *can* say "give each player points based on their *position* on each board: 1st place is worth a lot, 50th place almost nothing," then total the points. RRF is exactly that points system over ranked retrieval lists.

```
  dense list (by cosine)      sparse list (by BM25)
  ──────────────────────      ──────────────────────
  1. doc_B                    1. doc_A
  2. doc_A                    2. doc_C
  3. doc_D                    3. doc_B
       │                           │
       └──── fuse by POSITION ─────┘
             (ignore the raw scores entirely)
```

The body walks the fusion math and where it earns its keep.

---

### Run both retrievers in parallel

A hybrid retriever issues the query to both indexes at once — the dense vector index and the sparse keyword/EQL index — and collects each as a *ranked list* of document IDs. The scores come along but RRF will not use them.

```
  query "abandoned mobile purchases"
     ├────────────────────────────┬─────────────────────────┐
     ▼                            ▼                          │
  DENSE retrieval              SPARSE retrieval              │
  embed + cosine               keyword/EQL                  │
  → [doc_B, doc_A, doc_D]      → [doc_A, doc_C, doc_B]      │
     (catches "cart"=          (catches exact               │
      "checkout" synonym)       "mobile" term)              │
```

Running in parallel keeps latency at max(dense, sparse), not their sum — like firing two `fetch`es with `Promise.all` rather than awaiting sequentially.

### Reciprocal Rank Fusion: the formula

For each document, sum across the lists `1 / (k + rank)`, where `rank` is its 1-based position in that list and `k` is a smoothing constant (the standard default is 60). A document absent from a list contributes 0 for that list.

```
  RRF(doc) = Σ_lists  1 / (k + rank_in_list)        k = 60

  doc_A: dense rank 2, sparse rank 1
         = 1/(60+2) + 1/(60+1) = 0.01613 + 0.01639 = 0.03252
  doc_B: dense rank 1, sparse rank 3
         = 1/(60+1) + 1/(60+3) = 0.01639 + 0.01587 = 0.03226
  doc_C: dense rank —, sparse rank 2
         = 0        + 1/(60+2) = 0.01613
  doc_D: dense rank 3, sparse rank —
         = 1/(60+3) + 0        = 0.01587
```

Re-sort by the fused score: `doc_A, doc_B, doc_C, doc_D`. `doc_A` wins because it ranked highly in *both* lists; a document ranked #1 in one but absent in the other can still be beaten by one that placed well in both. That cross-list agreement is exactly what hybrid is supposed to reward.

### Why `k` exists and why position beats score

The constant `k` (60) flattens the curve so the gap between rank 1 and rank 2 is not enormous — without it, rank-1 would dominate everything. Larger `k` makes the lists more equal-weighted; smaller `k` makes top ranks more decisive. The deeper point: by using only `rank`, RRF never touches the cosine-vs-BM25 scale mismatch.

```
  contribution by rank (k=60)
  rank 1  → 0.01639   ◀── biggest
  rank 2  → 0.01613
  rank 10 → 0.01429
  rank 50 → 0.00909   ◀── small but non-zero
  absent  → 0
       └── smooth decay, scale-free
```

### Hybrid for blooming insights' would-be features

The query that needs hybrid is "find past investigations like this mobile-checkout problem." Sparse catches the exact term "mobile" and the exact event `checkout_started`; dense catches an old investigation that called it "cart drop-off on phones" — different words, same meaning. RRF fuses both so the result has the exact-term hits *and* the paraphrase hits. The analytics path stays sparse-only (it has no meaning axis); hybrid applies only to the free-text investigation corpus.

### The principle

When two retrievers disagree because they measure different things, the robust way to combine them is to trust *agreement on position*, not to reconcile their incomparable scores. Reciprocal Rank Fusion is the minimal expression of that idea: sum reciprocal ranks, sort, done — no calibration, one constant, and a document that both methods like rises to the top. It is the rank-merge you would reach for any time you must combine two orderings produced by different metrics.

---

## Hybrid retrieval + RRF — diagram

This diagram spans the Service layer (parallel retrievers + fusion). A reader who sees only this should grasp that two retrievers run in parallel and a position-based fusion merges them without touching raw scores.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (would live in lib/mcp/retrieval.ts)                │
│                                                                      │
│   query                                                              │
│     │  Promise.all (parallel)                                        │
│     ├──────────────────────────┬─────────────────────────────────┐  │
│     ▼                          ▼                                  │  │
│  DENSE (embedding cosine)   SPARSE (keyword / EQL)               │  │
│  → ranked list L_d          → ranked list L_s                    │  │
│     │                          │                                 │  │
│     └────────────┬─────────────┘                                 │  │
│                  ▼                                                │  │
│        Reciprocal Rank Fusion                                    │  │
│        RRF(doc) = Σ 1/(k + rank),  k = 60                        │  │
│        (uses POSITIONS, ignores raw scores)                     │  │
│                  │                                                │  │
│                  ▼                                                │  │
│        re-sort → fused top-k → (optional) rerank (07)           │  │
└──────────────────────────────────────────────────────────────────────┘
```

The fusion node is the whole point: it merges two orderings using only positions, so the cosine-vs-BM25 scale mismatch never matters.

---

## Implementation in codebase

**Not yet implemented.** blooming insights retrieves live via a single sparse path — `execute_analytics_eql` against Bloomreach — so there is no second (dense) retriever to fuse and no rank fusion anywhere.

There is no honest in-codebase analog beyond the sparse leg itself: the agents already do exact-term EQL retrieval (`lib/mcp/tools.ts` L11/L16), which would be one of the two lists a hybrid retriever fuses. Hybrid retrieval has nothing to fuse it *with* until the dense path from `05-dense-vs-sparse.md` exists. When both legs exist, the fusion would live in a `lib/mcp/retrieval.ts` `hybridSearch` over the past-investigation corpus (`lib/state/investigations.ts`); the analytics path stays sparse-only because aggregates have no meaning axis. The `Project exercises` block below is the primary buildable target.

---

## Elaborate

### Where this pattern comes from

Rank fusion predates RAG — it comes from metasearch (combining results from multiple search engines) and information-retrieval research. Reciprocal Rank Fusion specifically is from Cormack, Clarke & Buettcher (2009), who showed a dead-simple position-based fusion outperformed more elaborate score-combination methods. The RAG wave adopted it as the default hybrid-search combiner precisely because it needs no per-corpus tuning: every major vector DB (Weaviate, Qdrant, OpenSearch, pgvector + a keyword index) now offers RRF hybrid search out of the box.

### The deeper principle

```
  combining two rankings        method                requires
  ──────────────────────────    ──────────────────    ───────────────────
  same scale scores             weighted sum          comparable scales
  different scale scores        score normalization   per-corpus calibration
  any scores, robustly          RRF (rank-based)      one constant k
```

RRF wins the "any scores, robustly" row because it discards the scores. The general lesson: when inputs are on incomparable scales, rank-transform them before combining — the same reason you would sort-then-merge rather than arithmetic-combine two differently-scaled metrics in a frontend leaderboard.

### Where this breaks down

1. **RRF discards score magnitude, which sometimes matters.** A document that is a *runaway* #1 in dense (cosine 0.95 vs. 0.4 for #2) contributes the same rank-1 amount as a barely-#1. When the score gap is meaningful signal, pure rank fusion throws it away. Weighted hybrid (normalized score sum) keeps it, at the cost of calibration.

2. **`k` is a hidden knob.** The default 60 works broadly but tunes the relative influence of top ranks. A wrong `k` can let a deep-tail match in one list outweigh a strong match in another. It is rarely tuned, which is mostly a feature, occasionally a trap.

3. **Two retrievers, two failure surfaces.** Hybrid doubles the retrieval infrastructure (a vector index *and* a keyword index, both kept in sync). For a corpus where one axis suffices (e.g. exact analytics), hybrid is pure overhead.

### What to explore next

- **Reranking** (`07-reranking.md`): a cross-encoder rerank over the fused top-k is the standard next stage — fuse for recall, rerank for precision.
- **Dense vs. sparse** (`05-dense-vs-sparse.md`): the two legs hybrid fuses and why each is needed.
- **Weighted hybrid / score normalization:** the alternative to RRF when score magnitude carries signal.

---

## Project exercises

### Add hybrid search over past investigations with RRF fusion

- **Exercise ID:** B2A.10 (adapted) — the primary buildable target.
- **What to build:** once the dense (`05`) and a keyword retriever over investigation text both exist, write `hybridSearch(query, k)` that runs both in parallel (`Promise.all`), fuses their ranked lists with RRF (`k = 60`), and returns the fused top-k. The analytics path stays sparse-only.
- **Why it earns its place:** demonstrates you fuse incomparable rankings by position rather than by reconciling cosine and BM25 scales — the exact reasoning that separates working hybrid search from a broken score-add.
- **Files to touch:** new `lib/mcp/retrieval.ts` (`hybridSearch` + `rrfFuse`), `lib/mcp/vector-store.ts` (dense leg), a keyword index over `lib/state/investigations.ts` text, new `test/mcp/retrieval.test.ts`.
- **Done when:** a mixed query (exact event name + paraphrase) surfaces both the exact-term match and the synonym match in the fused top-k, and the fusion uses only ranks (no raw-score arithmetic).
- **Estimated effort:** 1–2 days

### Compare RRF vs. naive score-addition on the same query set

- **Exercise ID:** C2.5 (adapted) — why rank fusion beats score-add.
- **What to build:** a harness that fuses the dense and sparse lists two ways — RRF and naive `cosine + BM25` addition — and shows the score-add result is dominated by unbounded BM25 while RRF gives balanced fused rankings.
- **Why it earns its place:** makes the scale-mismatch failure concrete and proves RRF's scale-independence, the core interview point.
- **Files to touch:** new `scripts/rrf-vs-scoreadd.ts`, `lib/mcp/retrieval.ts` (both fusion methods), `test/mcp/retrieval.test.ts`.
- **Done when:** the harness shows naive addition lets a high-BM25 low-cosine doc dominate, while RRF keeps a both-lists document on top.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"How do you combine dense and sparse retrieval?" tests whether you know the score-scale trap and the position-based fix. The senior signal is naming RRF, explaining why it ignores raw scores (cosine vs. BM25 are incomparable), citing the `1/(k+rank)` formula with `k=60`, and knowing when hybrid is *not* worth it (single-axis corpora like exact analytics).

### Likely questions

**[mid] Why can't you just add the cosine and BM25 scores?**

Because they are on different scales — cosine is bounded [0,1], BM25 is unbounded — so the sum is dominated by whichever has the larger range (BM25). Adding them is like adding a price to a rating. RRF sidesteps this by combining rank positions instead of raw scores.

```
cosine 0.8 + BM25 14.2 → BM25 dominates (wrong)
RRF: 1/(60+rank) per list → scale-free
```

**[senior] Walk me through the RRF formula and why `k` is there.**

For each document, sum `1/(k + rank)` over the lists it appears in, with `rank` 1-based and `k=60`. A doc absent from a list adds 0. `k` flattens the curve so rank-1 does not crush everything — larger `k` weights lists more equally, smaller `k` makes top ranks decisive. Then re-sort by the fused total.

```
RRF(doc) = Σ 1/(k+rank), k=60
doc in both lists near top → wins over doc #1 in only one
```

**[arch] When is hybrid retrieval not worth the cost?**

When the corpus has only one useful axis. blooming insights' analytics is exact — there is no meaning axis, so a dense leg contributes nothing and you would maintain a second index for zero recall gain. Hybrid earns its cost only on a mixed-query free-text corpus (past investigations), where some queries are exact-term and some are paraphrase.

```
exact analytics → sparse only (hybrid = overhead)
free-text mixed → hybrid + RRF (both axes needed)
```

### The question candidates always dodge

**"What does RRF throw away?"** Score magnitude. A runaway #1 (cosine 0.95 vs. 0.4 for #2) contributes the same rank-1 amount as a barely-#1. When that gap is real signal, pure rank fusion loses it, and weighted score-normalization is the alternative. Naming this limitation — not just praising RRF's simplicity — is the senior signal.

### One-line anchors

- `lib/mcp/tools.ts` L11/L16 — `execute_analytics_eql`: the sparse leg, the only retriever today.
- RRF: `Σ 1/(k + rank)`, `k = 60` — fuse by position, ignore raw scores.
- Cosine and BM25 are incomparable scales; that is why you fuse by rank.
- Cross-list agreement wins: a both-lists doc beats a one-list #1.
- Hybrid is overhead for single-axis corpora like exact analytics.

---

## See also

→ 05-dense-vs-sparse.md · → 07-reranking.md · → 01-embeddings.md · → 11-rag.md
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
