# Chunking strategies

## Subtitle

Document splitting for retrieval / chunk-as-unit — Industry standard.

## Zoom out, then zoom in

If blooming grows past-investigation memory (see **01-embeddings.md**'s exercise), each investigation record is already a natural chunk — it has a bounded shape (`anomaly + diagnosis`) and doesn't need splitting. The chunking question is a non-question for this corpus. For a different candidate corpus — product catalog descriptions, docs — chunking would matter.

This file covers chunking as a concept because the codebase would need it if the ecommerce workspace's *catalog* were indexed for retrieval (~10k+ product descriptions).

```
  Zoom out — where chunking would live

  ┌─ Would-be corpus (catalog descriptions, ~10k rows) ─┐
  │  each ~200-1000 tokens                               │
  └───────────────────────┬──────────────────────────────┘
                          │  chunk() ← we are here
                          ▼
  ┌─ Chunks (one embedding per chunk) ★ ────────────────┐
  │  target: 200-500 tokens each                         │
  └──────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** raw document → chunk boundaries → chunks → embeddings. Four bands.
- **Axis: coherence.** A chunk should be self-contained enough that its embedding represents its content correctly.
- **Seam:** the boundary decision. Fixed-size, sentence-window, and structural each pick the seam differently.

## How it works

### Move 1 — the mental model

Three strategies:

```
  Three chunking shapes

  Fixed-size (N tokens):
  ┌────────────┬────────────┬────────────┐
  │ tokens 1-N │ tokens N-2N│ tokens 2N-3N│
  └────────────┴────────────┴────────────┘
  simple; boundaries may split sentences

  Sentence-window (N sentences per chunk):
  ┌────────────┬────────────┬────────────┐
  │ 4 sentences│ 4 sentences│ 4 sentences│
  └────────────┴────────────┴────────────┘
  clean boundaries; may vary in token count

  Structural (heading/section/JSON path):
  ┌────────────┬────────────┬────────────┐
  │ heading 1  │ heading 2  │ heading 3  │
  │  + body    │  + body    │  + body    │
  └────────────┴────────────┴────────────┘
  highest coherence; requires parsing
```

### Move 2 — the step-by-step walkthrough

**For catalog descriptions.** Structural. Each product is one chunk — `{id, name, description, category, price}` serialized to text. No splitting needed; each product is already a coherent unit under ~500 tokens.

**For long documents (support docs, runbooks).** Sentence-window with overlap. Common values: 5 sentences per chunk, 1 sentence overlap. Overlap ensures context spanning chunk boundaries isn't lost.

**For code.** Structural — chunk by function or class. Cross-references are then resolved at retrieval time by fetching adjacent chunks.

**Where the chunker would live.** If blooming added catalog retrieval, one file — `lib/mcp/catalog-index.ts` — with a `buildIndex(catalog: Catalog[])` function that produces `{id, chunkText, embedding}` rows. No chunker needed for the initial implementation; each catalog row *is* a chunk.

Pseudocode of a would-be catalog indexer:

```
  buildCatalogIndex(catalog):
    rows = []
    for product in catalog:
      text = product.name + " · " + product.description
           + " · category: " + product.category
      vec = embed(text)
      rows.push({ id: product.id, text, vec })
    return rows
  // no splitting; each product is one chunk
```

### Move 3 — the principle

The chunk is the unit of retrieval. A chunk too small lacks context ("2.5%" without knowing what metric); a chunk too large dilutes relevance (a chunk that mentions 10 topics fires on queries about any one of them). Structural boundaries when they exist; sentence-window with overlap otherwise; fixed-size only when the input has no discoverable structure.

## Primary diagram

```
  Chunking — full frame

  ┌─ Source doc ───────────────────────────────────────┐
  │  raw text / JSON / structured document              │
  └───────────────────────┬────────────────────────────┘
                          │
                          ▼
  ┌─ Strategy pick ────────────────────────────────────┐
  │  structural if doc has heading/section tree         │
  │  sentence-window if long prose                      │
  │  fixed-size only as fallback                        │
  └───────────────────────┬────────────────────────────┘
                          │
                          ▼
  ┌─ Chunks ───────────────────────────────────────────┐
  │  target 200-500 tokens; each self-contained         │
  │  optional overlap to preserve context               │
  └───────────────────────┬────────────────────────────┘
                          │
                          ▼
  ┌─ Embed each chunk → index ─────────────────────────┐
  └────────────────────────────────────────────────────┘
```

## Elaborate

Chunking is the most-tuned part of any RAG stack. Common failures: chunks that split a step-by-step instruction across the boundary (fixed-size on procedural text), chunks that include headers with the wrong body (structural on poorly-nested markdown), chunks so big they retrieve for every query (over-inclusive).

Related: **11-rag.md** (chunks feed retrieval), **07-reranking.md** (recovering when the chunk boundary was wrong).

## Project exercises

### B3.3 · Add catalog retrieval as a specialized tool

- **Exercise ID:** B3.3 (Case B — not yet implemented)
- **What to build:** New MCP tool `retrieve_catalog(query)` that embeds the query, returns top-5 matching product descriptions. Chunker: one product = one chunk. Index in memory for the demo workspace, sqlite-vec in prod.
- **Why it earns its place:** Turns "catalog is 10k rows" from a context-window problem into a retrieval problem. Directly reduces token cost on catalog-related recommendations.
- **Files to touch:** New `lib/mcp/catalog-index.ts`, extend `lib/agents/tool-schemas.ts` to register the new tool, extend `lib/agents/monitoring.ts` and recommendation prompt.
- **Done when:** for a workspace with 10k+ catalog items, a "which category drove the drop" question triggers retrieval instead of dumping the catalog into context; receipt shows tokens saved.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: How would you chunk investigation memory?**

I wouldn't. Each investigation is already a bounded record with a fixed schema. The chunk is the whole investigation record; no splitting needed. Load-bearing: recognize when the corpus already has natural chunks and don't invent a chunker just to have one.

**Q: What about very long documents?**

Sentence-window with 5 sentences per chunk, 1 sentence overlap. Overlap catches cross-boundary references. If the document has structural markers (markdown headings), prefer structural — the coherence per chunk is markedly higher.

## See also

- [11-rag.md](11-rag.md) — the pipeline chunks feed.
- [01-embeddings.md](01-embeddings.md) — what each chunk becomes.
- [07-reranking.md](07-reranking.md) — the fix when chunk boundaries mismatch the query.
