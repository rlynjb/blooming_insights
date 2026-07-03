# Dense vs sparse retrieval

## Subtitle

Semantic (embedding) vs lexical (BM25) matching — Industry standard.

## Zoom out, then zoom in

Two retrieval families, different failure modes. Dense (embedding + cosine) catches paraphrases; sparse (BM25 over tokens) catches exact terms. Neither is strictly better; production systems use both.

```
  Zoom out — two retrieval families

  ┌─ Query ─────────────────────────────────────────────┐
  │  "how do I fix the auth bug"                        │
  └──────────┬──────────────────────────┬──────────────┘
             │                          │
             ▼                          ▼
  ┌─ Dense (embed + cosine) ─┐   ┌─ Sparse (BM25) ────┐
  │  paraphrase-tolerant     │   │  exact-term-precise│
  │  → "login broken"        │   │  → "CVE-2024-1234" │
  └──────────────────────────┘   └────────────────────┘
```

## Structure pass

- **Layers:** query → dense path AND sparse path → merged results. Two parallel bands.
- **Axis: match type.** Dense: semantic. Sparse: lexical. Different failure modes; different wins.
- **Seam:** the ranking merge (see **06-hybrid-retrieval-rrf.md**).

## How it works

### Move 1 — the mental model

Dense: embed query, embed corpus, cosine similarity. Recall is high for paraphrases; precision degrades on rare or exact terms.

Sparse: BM25 over tokenized text. Precision is high on exact-term matches; misses paraphrases entirely.

```
  Dense vs sparse — the shape

  Dense pipeline:
    query ─► embed ─► cosine vs corpus ─► top-k

  Sparse pipeline:
    query ─► tokenize ─► BM25 (term freq × inverse doc freq) ─► top-k

  Hybrid: run both, fuse the rankings (RRF)
```

### Move 2 — the step-by-step walkthrough

**Dense — where paraphrase wins.** Query "conversion dropped last week" against a diagnosis embedded as "checkout completion decline over trailing 7d." Different words, similar meaning; embeddings put them nearby. BM25 would miss entirely.

**Sparse — where exact terms win.** Query "SKU-4293" (an exact product identifier) against a catalog. Embeddings might return nearby SKUs by semantic proximity (which is *wrong* for an ID); BM25 returns exactly that SKU or nothing. Similarly: dates, error codes, product names, versions.

**Where blooming's would-be corpus needs both.** Investigation memory: dense wins because the same anomaly type has many paraphrase-shaped variants across sessions. EQL query library: sparse wins because EQL literals (event names, property names, functions) are lexical — the model should retrieve queries with matching event names.

**Implementation notes.** BM25 is a small function: term frequency × inverse doc frequency, tunable with `k1` (~1.5) and `b` (~0.75) constants. `@node-rs/bm25` or similar libraries make this a two-line integration. No new infrastructure needed.

Pseudocode of a hybrid retrieval for investigation memory:

```
  hybridRetrieveDiagnoses(query, k=3):
    denseHits  = denseIndex.search(embed(query), k=10)
    sparseHits = bm25Index.search(tokenize(query), k=10)
    return rrfMerge(denseHits, sparseHits, k=3)   // see file 06
```

### Move 3 — the principle

Use both when the corpus has both semantic and lexical structure. When it doesn't (pure code, pure IDs), sparse alone; when it doesn't (pure prose with no proper nouns), dense alone. Hybrid is the default when in doubt.

## Primary diagram

```
  Dense + sparse — full frame

  ┌─ Query ─────────────────────────────────────────────┐
  │  "why did mobile revenue drop"                       │
  └──────────┬──────────────────────────┬───────────────┘
             │                          │
             ▼                          ▼
  ┌─ DENSE PATH ────────────┐  ┌─ SPARSE PATH ──────────┐
  │  embed(query) → vec      │  │  tokenize(query)       │
  │  cosine vs corpus vecs   │  │  BM25 vs corpus tokens │
  │  → [doc3, doc7, doc1]    │  │  → [doc7, doc5, doc2]  │
  └──────────┬──────────────┘  └──────────┬─────────────┘
             │                            │
             └──────────┬─────────────────┘
                        │
                        ▼
  ┌─ RRF fusion (see 06-hybrid-retrieval-rrf.md) ───────┐
  │  merges rankings by reciprocal rank                  │
  └─────────────────────────────────────────────────────┘
```

## Elaborate

BM25 (Robertson & Zaragoza, 2009) is a strong baseline that predates transformers by a decade. It still wins on exact-match tasks. The lesson: newer isn't better for every failure mode; understand what your query mix looks like before picking a single family.

Related: **06-hybrid-retrieval-rrf.md** (how to merge), **11-rag.md** (where hybrid retrieval feeds).

## Project exercises

### B3.5 · Add sparse retrieval to the would-be EQL library

- **Exercise ID:** B3.5 (Case B — not yet implemented)
- **What to build:** As part of the EQL query library retrofit (see sub-section README), add BM25 over the EQL text as a second retrieval path. Merge with dense via RRF.
- **Why it earns its place:** EQL identifiers are lexical (`event.purchase.total_price` is a token that matters exactly); dense-only retrieval would miss exact matches. Interview payoff: understanding retrieval-family failure modes.
- **Files to touch:** New `lib/eql/library.ts`, add `@node-rs/bm25` dep or equivalent tiny implementation.
- **Done when:** for a query matching an exact EQL literal, sparse retrieves the right query at rank 1; dense-only would rank it 3-5.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: When would you not use dense retrieval?**

Corpora dominated by exact-match tokens: code, EQL, SKUs, error codes. Embeddings degrade on rare/uncommon tokens — the model was never trained to distinguish `SKU-4293` from `SKU-4294`, so they end up nearby in vector space. BM25 sees them as distinct tokens and ranks correctly. Load-bearing: knowing when the corpus's structure argues against embeddings.

**Q: Why not just always do hybrid?**

Extra latency and complexity. If measurement shows dense-only is good enough (say, top-3 recall > 90%), running BM25 in parallel is wasted work. Hybrid is the fallback when either alone is insufficient — and you measure to know which case you're in.

## See also

- [06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md) — the fusion.
- [11-rag.md](11-rag.md) — the pipeline both live in.
- [../05-evals-and-observability/01-eval-set-types.md](../05-evals-and-observability/01-eval-set-types.md) — how to measure retrieval quality.
