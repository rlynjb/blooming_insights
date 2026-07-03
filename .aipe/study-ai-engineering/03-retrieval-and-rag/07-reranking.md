# Reranking with a cross-encoder

## Subtitle

Two-stage retrieval / cross-encoder rerank — Industry standard.

## Zoom out, then zoom in

Retrieval (dense, sparse, or hybrid) is fast but coarse — it uses independent embeddings for query and doc, then measures distance. A **cross-encoder** takes the query and one candidate doc together as input and outputs a relevance score using full attention across both. Slow but accurate. Two-stage retrieval uses the cheap retriever to narrow to ~50 candidates, then the cross-encoder to polish to top 3–5.

```
  Zoom out — two-stage retrieval

  ┌─ Query ──────────────────────────────────────────┐
  └──────────────────┬───────────────────────────────┘
                     ▼
  ┌─ Stage 1: bi-encoder (embed) retrieve ───────────┐
  │  fast, top-50 candidates                          │
  └──────────────────┬───────────────────────────────┘
                     │  50 candidates
                     ▼
  ┌─ Stage 2: cross-encoder rerank ★ ────────────────┐ ← we are here
  │  slow, top-5 polished ranking                     │
  └──────────────────┬───────────────────────────────┘
                     ▼
                  final top-5
```

## Structure pass

- **Layers:** query → stage 1 (fast) → stage 2 (slow) → results. Three bands.
- **Axis: latency vs precision.** Stage 1 is fast and coarse. Stage 2 is slow and precise. Order matters: coarse-first cuts the expensive stage's input size.
- **Seam:** the boundary between retrieval and reranking. Retrieval returns 50; rerank returns 5.

## How it works

### Move 1 — the mental model

Bi-encoder: `embed(query)` and `embed(doc)` separately, compare with cosine. Cheap because embeddings are precomputed.

Cross-encoder: `score(query, doc)` in one pass with attention across both. Expensive because there's no precomputation — every (query, doc) pair is a fresh call.

```
  Bi-encoder vs cross-encoder — the shape

  Bi-encoder (retrieval):
    embed(query) ──►  q_vec
    embed(doc)   ──►  d_vec  (precomputed)
    score = cosine(q_vec, d_vec)                ← one lookup

  Cross-encoder (rerank):
    score = model(query, doc)                   ← one full call per (q, d)
    → slow but precise
```

### Move 2 — the step-by-step walkthrough

**Where reranking pays for itself.** When the top-50 from stage 1 has the right answer in it, but not at rank 1. Example: a paraphrase-heavy query where the correct doc lands at rank 8 in dense retrieval. Cross-encoder rerank pushes it to rank 1 in ~90% of such cases.

**Where reranking doesn't help.** When stage 1 already puts the right answer at rank 1 (measure this first!) or when stage 1 doesn't retrieve the right doc at all — reranking can't rescue a doc that wasn't in the candidate set.

**Model choice.** `cross-encoder/ms-marco-MiniLM-L-6-v2` from sentence-transformers is a common default — small, runs on CPU, accurate enough. Cohere Rerank v3 is the hosted equivalent.

**For blooming.** No reranking today because no retrieval. If retrieval landed, the decision would be measurement-driven: measure hit@k before rerank; add rerank only if the gap is significant.

Pseudocode:

```
  twoStageRetrieve(query, k=5):
    // stage 1 — fast, coarse
    candidates = hybridRetrieve(query, N=50)
    // stage 2 — slow, precise
    scored = candidates.map(doc => ({
      doc,
      score: crossEncoder.score(query, doc.text)
    }))
    scored.sort(by score desc)
    return scored.slice(0, k)
```

### Move 3 — the principle

Reranking is a quality-vs-latency knob. It earns its place when measurement shows stage 1 is retrieving the right docs but not ranking them well. Add it late, add it when you can prove the win.

## Primary diagram

```
  Two-stage retrieval — full frame

  ┌─ Query ────────────────────────────────────────────┐
  └──────────────────┬─────────────────────────────────┘
                     │
                     ▼
  ┌─ Stage 1: bi-encoder / hybrid ─────────────────────┐
  │  embed + cosine (dense) + BM25 (sparse) + RRF      │
  │  → top-50 candidates                                │
  │  latency: 10-50ms                                   │
  └──────────────────┬─────────────────────────────────┘
                     │
                     ▼
  ┌─ Stage 2: cross-encoder ★ ─────────────────────────┐
  │  model(query, doc) per candidate                    │
  │  → top-5 polished                                   │
  │  latency: 50 candidates × ~10ms each = ~500ms       │
  └──────────────────┬─────────────────────────────────┘
                     │
                     ▼
                 final top-5
```

## Elaborate

The bi-encoder / cross-encoder split is standard in modern IR (from BERT-era through modern retrievers). The name "cross-encoder" refers to encoding query and doc *together*, letting attention span both — which is why it's more accurate and why it can't be precomputed.

For very large corpora (100k+), a third stage sometimes appears: a small LLM used as a judge on the top-5 output, producing a final ranking with reasoning. Extra latency; used only in high-value search paths.

Related: **06-hybrid-retrieval-rrf.md** (stage 1's fusion), **11-rag.md** (where the final top-5 feeds).

## Project exercises

### B3.7 · Measure hit@k before considering rerank

- **Exercise ID:** B3.7 (Case B — not yet implemented)
- **What to build:** Once the would-be investigation-memory index (`B3.1/B3.4`) is live, hand-label 30 anomaly queries with their intended top-3 investigations. Measure hit@1 and hit@3 for the retrieval-only pipeline. Only add reranking if hit@3 < 80%.
- **Why it earns its place:** Discipline over reflex. Interview payoff: "here's how I'd decide whether reranking is worth adding" — measurement-first.
- **Files to touch:** New `eval/retrieval-goldens/`, new `eval/retrieval.eval.ts`.
- **Done when:** the eval prints hit@1 / hit@3 / MRR for the retrieval path; the number is committed as a baseline.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: Should you always rerank?**

No. Rerank when measurement shows stage 1 retrieves the right doc but ranks it wrong. If stage 1 already puts it at rank 1, reranking is wasted latency. If stage 1 doesn't retrieve it at all, rerank can't fix that — improve retrieval first.

**Q: Why not just use the cross-encoder for everything?**

Latency and cost. Cross-encoder scores are ~10ms per pair; scoring a 10k-corpus for one query = 100 seconds. Bi-encoder retrieval narrows to 50 candidates; the cross-encoder then runs on those. Two-stage keeps the expensive model's input bounded.

## See also

- [06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md) — the stage 1 fusion.
- [11-rag.md](11-rag.md) — the pipeline both stages live in.
- [../02-context-and-prompts/02-lost-in-the-middle.md](../02-context-and-prompts/02-lost-in-the-middle.md) — where reranking places the top-1 at prime attention position.
