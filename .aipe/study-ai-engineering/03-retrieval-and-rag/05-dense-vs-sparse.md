# 05 — Dense vs sparse retrieval

**Type:** Industry standard. Also called: semantic vs lexical retrieval, embedding search vs BM25.

## Zoom out, then zoom in

**Not exercised in this codebase.** Both retrieval styles would need building; hybrid (combine both) is the strong default.

```
  Dense (embeddings)      Sparse (BM25 / keyword)
  · captures paraphrase    · captures exact terms
  · misses rare tokens     · misses paraphrase
  ─── hybrid combines both ──
```

## Structure pass

Axis: what's the retrieval match on? Dense = semantic direction. Sparse = term frequency × inverse doc frequency. Hybrid = both, fused.

## How it works

### Move 1

Dense embedding search finds "similar meaning." Sparse (BM25) finds "shared rare terms." Each has failure modes the other covers.

```
  Query: "how to fix the auth bug"

  Dense: finds  "login broken", "session errors"       ← paraphrase win
  Sparse: finds "auth", "bug"                          ← exact-term win
  Hybrid: finds both, ranks combined                   ← default
```

### Move 2

**Dense retrieval.** Embed the query, cosine-search over stored vectors, return top-k. Strengths: catches paraphrases ("cart abandonment" retrieves "shoppers not completing checkout"). Weakness: struggles on rare tokens, IDs, code snippets that weren't well-represented in the embedding model's training.

**Sparse retrieval (BM25).** Term-based. `score = idf(term) × (tf × (k+1)) / (tf + k × (1 - b + b × dl/avgdl))`. Standard IR algorithm. Strengths: exact-term matches, product IDs, error codes. Weakness: paraphrase fails ("issue" won't find "problem").

**Hybrid = both, fused with RRF (see next file).**

For this codebase's would-be corpus (past diagnoses), the query would often be another anomaly's text — paraphrase-heavy but sometimes containing specific metric names ("conversion_rate"). Hybrid would be the right default.

### Move 3

Dense wins on semantic, sparse wins on lexical. Real production retrieval uses both. Skipping sparse because embeddings feel "smarter" leaves easy recall on the floor.

## Primary diagram

```
  Query
    │
    ├── dense embedding ─cosine─► [doc7, doc3, doc1]
    │                                       (semantic top)
    └── sparse (BM25) ─── term ────► [doc7, doc2, doc5]
                                            (lexical top)

           merge with RRF (next file) → final ranking
```

## Elaborate

Modern practical retrieval uses hybrid + optional rerank. The "sparse is dead, embeddings replace it" claim from ~2020 didn't survive contact with production — BM25 keeps catching things embeddings miss. Elasticsearch and Postgres both support hybrid natively.

## Project exercises

### Exercise — hybrid retrieval over past diagnoses

- **Exercise ID:** C2.8-B · Case B (RAG not exercised).
- **What to build:** if the RAG stack from `01-04` is present, add a BM25 index alongside the vector store. Retrieve top-20 from each, fuse with RRF (see `06-hybrid-retrieval-rrf.md`).
- **Why it earns its place:** proves you know hybrid is the default. Interviewer signal: "I don't rely on embeddings alone."
- **Files to touch:** `lib/rag/bm25.ts` (new), `lib/rag/retrieve.ts` (hybrid entry point).
- **Done when:** retrieval on a query with a rare metric name returns docs BM25 alone would find, and paraphrase queries return docs dense alone would find.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Dense only vs hybrid?**

Hybrid unless you've measured that sparse adds zero recall on your corpus. Skipping sparse because embeddings feel smarter costs you exact-term recall. BM25 is 40+ years old and still catches things state-of-the-art embeddings miss.

**Q: Why does BM25 work?**

Because term frequency × inverse doc frequency captures a real signal: rare terms that appear often in one doc are strong evidence of that doc's topic. It's a hand-crafted feature that transformer-learned features don't consistently reproduce.

**Q: When is dense enough alone?**

Corpora where every query is a well-formed sentence and every doc is prose. Legal briefs, research papers. When your queries have identifiers, error codes, product SKUs, snippets of code — hybrid is a clear win.

## See also

- `06-hybrid-retrieval-rrf.md` — the fusion algorithm
- `01-embeddings.md` — the dense side
