# 07 — reranking with a cross-encoder

**Subtitle:** Two-stage retrieval — fast bi-encoder + slow cross-encoder · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** The production-quality move after dense + sparse: take the
top-50 from your retriever, re-score each (query, doc) pair with a
cross-encoder (slow but accurate), return the new top-5.

```
  Zoom out — reranking sits between retrieval and the LLM

  ┌─ retrieval (dense + sparse + RRF) → top-50 ──┐
  │                ▼                              │
  │  ┌─ rerank: cross-encoder per pair ─────┐    │  ← we are here
  │  │  top-50 → score 50 (query, doc) pairs│    │   (Case B)
  │  └──────────────┬───────────────────────┘    │
  │                 ▼                              │
  │           top-5 → LLM context                  │
  └────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — accuracy vs latency.** Bi-encoders embed query
    and docs separately (fast — embed once per doc, query separately).
    Cross-encoders score the (query, doc) pair jointly with full
    attention (slow — pay per pair). Use bi-encoder to narrow, cross-
    encoder to polish.

## How it works

### Move 1 — the mental model

A two-pass interview: phone screen (fast, lots of candidates) then
on-site (slow, fewer candidates). Retrieval is the phone screen, rerank
is the on-site.

```
  Two-stage retrieval

  query
    │
    ▼
  ┌─ Stage 1: bi-encoder retrieval ──┐
  │  embed query, cosine search       │  fast, top-50 (or top-100)
  │  ~ms latency                       │  loose recall
  └──────────────┬────────────────────┘
                 │ 50 candidates
                 ▼
  ┌─ Stage 2: cross-encoder rerank ──┐
  │  full attention on (query, doc)   │  slow, top-5
  │  ~tens-of-ms per pair             │  high precision
  └──────────────┬────────────────────┘
                 │ 5 best
                 ▼
            into LLM context
```

### Move 2 — the step-by-step walkthrough

**Why cross-encoders score better than bi-encoders.** A bi-encoder embeds
the query and the doc separately and compares them with cosine. The
embeddings are computed independently — the doc doesn't know what the
query is. A cross-encoder takes (query, doc) concatenated together as
input, runs full attention across both, and outputs a relevance score.
The doc and query *attend to each other*, which produces a more accurate
relevance judgment.

The cost: bi-encoder = 1 embedding call per doc (precomputed) + 1 for
the query. Cross-encoder = 1 model call *per pair* at query time. For
top-50 candidates that's 50 model calls per query.

**For blooming insights' scale (~100s of corpus items), reranking might
be overkill.** The whole corpus is small; bi-encoder cosine over the
whole thing is already comprehensive. Reranking pays off when:

  → Corpus is large (>1k items), so retrieval recall at top-50 isn't
    guaranteed to include the right answer.
  → Query is ambiguous, and the cross-encoder's joint attention catches
    the right match that the bi-encoder missed.
  → Quality matters enough to pay ~100ms extra latency per query.

**Cross-encoder model options:**
  - `cross-encoder/ms-marco-MiniLM-L-6-v2` — small, fast (~5ms per pair on
    CPU), MS-MARCO trained, the standard baseline.
  - `BAAI/bge-reranker-base` — newer, slightly better quality, same
    latency class.
  - Cohere's `rerank-english-v3.0` — managed API, no local model
    required, ~$2/1k queries.

**Hypothetical wiring for this codebase:**

```typescript
// lib/rag/rerank.ts (Case B)
import { pipeline } from '@xenova/transformers';

let reranker: any = null;
async function getReranker() {
  if (!reranker) {
    reranker = await pipeline('text-classification',
      'Xenova/ms-marco-MiniLM-L-6-v2', { quantized: true });
  }
  return reranker;
}

async function rerank(query: string, candidates: Array<{id: string; text: string}>):
    Promise<Array<{id: string; score: number}>> {
  const r = await getReranker();
  const scored = await Promise.all(candidates.map(async (c) => {
    const out = await r(`${query} [SEP] ${c.text}`);
    return { id: c.id, score: out[0].score as number };
  }));
  return scored.sort((a, b) => b.score - a.score);
}
```

**When to skip reranking.** If your retrieval recall@50 is already
high (>0.95 — the right answer is almost always in the top-50), the
rerank doesn't have much room to improve. Measure before adding.

### Move 3 — the principle

**Don't add reranking until you've measured retrieval recall and found
it lacking.** Reranking is the production polish move; it earns its
place when retrieval quality is the binding constraint, not when it's
already comfortable. For small corpora, retrieval is comfortable by
construction.

## Primary diagram

```
  When reranking earns its place

  ┌─ Small corpus (<1k items) ──────────────┐
  │  retrieval covers everything anyway     │
  │  rerank adds latency for no gain        │
  │  SKIP                                   │
  └─────────────────────────────────────────┘

  ┌─ Medium corpus (1k-100k items) ─────────┐
  │  bi-encoder recall@50 ≈ 0.85            │
  │  cross-encoder lifts precision@5        │
  │  CONSIDER (measure first)               │
  └─────────────────────────────────────────┘

  ┌─ Large corpus (100k+ items) ────────────┐
  │  bi-encoder recall@50 plateaus          │
  │  cross-encoder is the standard upgrade  │
  │  ADD (and tune top-N for rerank)        │
  └─────────────────────────────────────────┘
```

## Elaborate

The bi-encoder + cross-encoder pattern was canonized by Khattab and
Zaharia's ColBERT (2020) and refined by many subsequent papers. Modern
production retrieval stacks (Cohere, Voyage, OpenAI's assistants
retrieval) all use the two-stage pattern internally.

For blooming insights at current scale, reranking is genuinely
unnecessary. If diagnosis-grounding RAG grew into a multi-tenant SaaS
with hundreds of thousands of historical investigations per customer,
the calculus would flip and reranking would land.

## Project exercises

### Exercise — instrument retrieval recall to decide if rerank is worth it

  → **Exercise ID:** `study-ai-eng-03-07.1`
  → **What to build:** Add a small labeled fixture set: 20 (anomaly,
    correct_top_3_prior_diagnoses) pairs. Measure recall@50 on the
    dense+sparse retriever. If recall@50 < 0.90, add reranking and
    re-measure recall@5. If recall@50 ≥ 0.95, skip reranking.
  → **Why it earns its place:** Demonstrates measurement-driven RAG
    tuning. Don't add cross-encoders just because the literature
    recommends them; add them when the metric says they help.
  → **Files to touch:** new `test/rag/recall.test.ts`, new
    `test/fixtures/rag-labels.json`, optionally `lib/rag/rerank.ts`.
  → **Done when:** recall@50 has a number; decision documented in the
    README (rerank yes/no and why).
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: When would you add reranking?**

When measured retrieval recall isn't comfortable. The pattern is two-
stage: bi-encoder cosine retrieves top-50 fast; cross-encoder re-scores
each (query, doc) pair with joint attention for higher precision. Cost
is ~50× more model calls at query time, in exchange for measurable
precision@5 gains.

For this codebase's scale (~100s of investigations) reranking is
overkill — the whole corpus fits in a single bi-encoder pass. Reranking
earns its place at ~10k+ items.

```
  decision rule:
    if recall@50 ≥ 0.95: skip rerank
    if recall@50 < 0.85: definitely add rerank
    in between:          measure precision@5 with vs without
```

**Anchor line:** "Measure first. Reranking earns its place at corpus
scale + ambiguous queries, not by default."

**Q: Why are cross-encoders more accurate than bi-encoders?**

A bi-encoder embeds query and doc separately — the doc doesn't know
what the query is. A cross-encoder takes (query, doc) concatenated
through the transformer, with full attention across both — query and doc
attend to each other, which produces more accurate relevance scoring.
The cost is paying per (query, doc) pair at query time instead of pre-
computing per-doc embeddings.

## See also

  → `01-embeddings.md` — what the bi-encoder produces
  → `06-hybrid-retrieval-rrf.md` — the retriever that feeds reranking
  → `05-evals-and-observability/01-eval-set-types.md` — the golden set you need to measure recall
