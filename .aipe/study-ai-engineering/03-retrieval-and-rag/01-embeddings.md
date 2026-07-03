# 01 — Embeddings

**Type:** Industry standard. Also called: vector representations, dense embeddings, semantic vectors.

## Zoom out, then zoom in

**Not exercised in this codebase.** The agents query structured event data via MCP tools; no text is embedded.

```
  Zoom out — where embeddings would sit (they don't, today)

  ┌─ Existing data ────────────────────────────────────────────────────┐
  │  Past investigations (Diagnosis + evidence + tool trace)           │
  │  Would-be corpus if RAG were added                                 │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │  (missing) chunk + embed
                                ▼
  ┌─ (missing) Vector store ──────────────────────────────────────────┐
  │  [0.12, -0.84, 0.33, ...]  ← embeddings                            │
  │  ★ THIS CONCEPT ★                                                  │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. An embedding is a fixed-length vector that represents a piece of text in a high-dimensional space where semantically-similar texts land at similar positions. In this codebase there's nothing to embed today — no text corpus, no similarity search. The Case B exercise below is where it would come in.

## Structure pass

**Layers:**
- Outer: readable text ("mobile checkout dropped 18%")
- Middle: vector of 768-3072 floats
- Inner: cosine or dot-product distance to other vectors

**Axis: unit of comparison.**
- Text (outer): strings, comparable by exact or fuzzy match
- Vectors (middle): comparable by geometric distance
- Vector space (inner): pre-trained by embedding model

**Seam:** the embedding model call (`openai.embeddings.create`, `voyageai.embed`, etc.). Text goes in, vector comes out. The vector space is fixed by the model.

## How it works

### Move 1 — the mental model

You've done fuzzy string matching — Levenshtein distance, JaroWinkler. Same idea: convert text to numbers where similar inputs get similar numbers. Embeddings do that at a semantic level. "buy milk" and "purchase dairy" would have close vectors even though they share no letters.

```
  Embeddings map text to points in space
   ↑
   │        stock market
   │        (far away)
   │
   │
   │              buy milk
   │              purchase dairy
   │              (close together)
   └──────────────────────►
```

### Move 2 — walk the mechanism

**A vector, concretely.** Input text goes to an embedding model. Out comes a fixed-length array of floats — 1536 for OpenAI `text-embedding-3-small`, 768 for Cohere `embed-english-v3.0`, 3072 for OpenAI `text-embedding-3-large`. Same input, same vector. Different embedding models, different vectors (not comparable).

**Cosine similarity — the standard distance.**

```
  similarity(a, b) = dot(a, b) / (||a|| × ||b||)

  cos = 1.0  → identical direction  (very similar meaning)
  cos = 0.0  → orthogonal            (unrelated)
  cos = -1.0 → opposite               (rare in practice)
```

In practice with modern embedding models, real-world text pairs sit in a narrow band (0.2 to 0.9 cosine). The threshold that separates "similar" from "not" is empirical per corpus.

**What embeddings don't do.** They don't understand meaning. The model learned during pre-training that certain texts occur in similar contexts, and it emits vectors reflecting that co-occurrence. "milk" and "dairy" are close because they appear in similar contexts, not because the model knows what dairy is.

### Move 3 — the principle

Embeddings turn semantic similarity into a numeric distance. That's the entire operational move — everything else in RAG (chunking, storage, retrieval, reranking) is scaffolding around this one primitive.

## Primary diagram

```
  Where embeddings would sit in a blooming_insights RAG

  text (past diagnosis conclusion)
    │
    ▼  embedding model call
    │
  [768 floats]
    │
    ▼  store in vector DB
    │
  ...on retrieval...
    │
  query text ─embed─► query vector ─cosine─► top-k similar past diagnoses
```

## Elaborate

Embedding models are one-way — you can't decode text from a vector. They're also model-locked: swap `text-embedding-3-small` for `text-embedding-3-large`, and every stored vector is worthless (see `09-stale-embeddings.md`). That's why picking an embedding model is a decision to commit to for the corpus's lifetime.

## Project exercises

### Exercise — embed past diagnoses for similarity retrieval

- **Exercise ID:** C2.4-B · Case B (RAG not exercised).
- **What to build:** on each completed diagnosis, embed the `conclusion` text with OpenAI `text-embedding-3-small`. Store as `{investigationId, conclusion, vector}` in a new SQLite file or in `lib/state/embeddings.json`. Add a "similar past investigations" panel that retrieves top-3 by cosine similarity to the current diagnosis's conclusion.
- **Why it earns its place:** the smallest meaningful RAG in this codebase. Interviewer signal: "I know where retrieval buys value in my product; here's what I built."
- **Files to touch:** `lib/rag/embed.ts` (new — client + store), `lib/state/investigations.ts` (write embeddings on write), `components/investigation/SimilarPastPanel.tsx` (new).
- **Done when:** completing an investigation surfaces 3 similar past investigations by cosine similarity ≥ 0.5.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Do embeddings understand meaning?**

No. They encode co-occurrence in training data — texts that appear in similar contexts get similar vectors. That LOOKS like meaning, and functionally is close enough for retrieval, but the model doesn't know what "milk" is. This matters when you have out-of-distribution text (technical jargon, code identifiers, non-English) — the model may not have learned useful co-occurrence patterns for those.

**Q: What's the vector length matter?**

Larger vectors = more expressive but bigger to store and slower to search. 768 is a common sweet spot (Cohere v3, BGE-base); 1536 is OpenAI's small default; 3072 is OpenAI's large. For a small corpus (< 10K docs), the difference is negligible. At millions of docs, the storage + latency add up.

**Q: Why aren't embeddings in this codebase today?**

Because the agents query structured data, not text. There's no corpus to embed. If we added "past investigations" as searchable text, we'd add embeddings. Case B exercise above walks the shape.

## See also

- `02-embedding-model-choice.md` — picking one and committing
- `09-stale-embeddings.md` — what happens when source text edits
- `04-vector-databases.md` — where they get stored
