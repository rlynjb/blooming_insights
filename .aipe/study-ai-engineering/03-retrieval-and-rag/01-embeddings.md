# 01 — embeddings (geometrically)

**Subtitle:** Text → vector in N-dimensional space · Industry standard (Case B)

## Zoom out, then zoom in

**Case B in this codebase.** No embedding model is called; no vector is
stored. This file teaches the primitive that every other file in this
section uses.

```
  Zoom out — where embeddings WOULD live

  ┌─ blooming insights ─────────────────────────────┐
  │  ┌─ NEW: lib/rag/embed.ts ────────────────────┐ │  ← we are here
  │  │  embed(text) → number[]  (e.g. 1536 dims)   │ │   (Case B)
  │  └──────────────────────────────────────────────┘ │
  │  upsert(insightId, vec) → sqlite-vec / pgvector  │
  └──────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — similarity.** An embedding model maps text →
    vector such that *semantically similar text → nearby vectors*. The
    geometry is what matters; the specific number 1536 doesn't.

  → **The seam (Case B):** between text input and numeric output. Today
    nothing in the codebase crosses this seam; the diagnostic agent
    operates on Bloomreach event counts, not text similarities.

## How it works

### Move 1 — the mental model

A coordinate system where "buy milk" and "purchase dairy" land close
together because they mean similar things, and "stock market" lands far
away. You don't pick the coordinates — the embedding model learned them
during its training, by pulling together texts that appear in similar
contexts and pushing apart texts that don't.

```
  Text → vector → geometric similarity

  "buy milk"        → [0.12, -0.84, 0.33, …, 0.07]    (1536 dims)
  "purchase dairy"  → [0.15, -0.79, 0.31, …, 0.09]    ← cosine ≈ 0.98 (close)
  "stock market"    → [-0.42, 0.61, 0.18, …, -0.23]   ← cosine ≈ 0.15 (far)

  2D projection (cartoon — real embeddings are high-dim):

       ↑
       │  • "stock market"
       │
       │
       │           • "buy milk"
       │             • "purchase dairy"
       └─────────────────────────────────→
```

### Move 2 — the step-by-step walkthrough

**The hypothetical embed call** (Case B — not in repo):

```typescript
// lib/rag/embed.ts (would live here)
async function embed(text: string): Promise<number[]> {
  const result = await openai.embeddings.create({
    model: 'text-embedding-3-small',   // 1536 dimensions
    input: text,
  });
  return result.data[0].embedding;
}
```

**Cosine similarity — the comparison primitive:**

```typescript
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

  → Range: -1 to 1 (in practice for normalized embeddings, 0 to 1).
  → 1.0 = identical direction (semantically near-identical).
  → ~0.7+ = similar in meaning.
  → ~0.3 = vaguely related.
  → ~0 = unrelated.

**What the model is doing under the hood.** A pre-trained transformer
encoder reads the text, runs it through ~6-24 transformer layers, and
outputs the hidden state at the [CLS] token (or a mean of all token
hidden states). That's the vector. The model was trained on enormous text
corpora with contrastive loss — texts that appear in similar contexts get
pulled together, texts that don't get pushed apart.

You don't have to understand any of that to use embeddings. What matters
is the contract: *similar input text → nearby output vector*.

**What it gives you.** A numeric similarity score between any two pieces of
text — even text it's never seen. A user searches "fix the auth thing" and
your corpus has a doc titled "Debugging JWT verification errors" — cosine
similarity would catch the connection even though there's no word overlap.

**What it does NOT give you.** Meaning. The model has no idea what "milk"
is. It learned that texts about milk cluster together because they appear
in similar contexts. Push it slightly outside its training distribution
(a new product category, a niche jargon) and similarity scores get noisy.

### Move 3 — the principle

**Embeddings are a learned coordinate system, not a meaning system.** They
work brilliantly inside the distribution they were trained on; they degrade
gracefully outside it. Don't treat cosine similarity as a truth function —
treat it as a ranking signal. Always combine with another signal
(reranking, sparse search, business rules) before trusting the top-k.

## Primary diagram

```
  Embeddings as the coordinate system that powers RAG

  ┌─ Text inputs ─────────────────────────────┐
  │  "buy milk"                                │
  │  "purchase dairy"                          │
  │  "stock market"                            │
  └──────────────────┬─────────────────────────┘
                     │  embed (one model call per text)
                     ▼
  ┌─ Vectors (in same N-dim space) ───────────┐
  │  [0.12, -0.84, …]                          │
  │  [0.15, -0.79, …]   ← close to "buy milk" │
  │  [-0.42, 0.61, …]   ← far from both       │
  └──────────────────┬─────────────────────────┘
                     │  cosine similarity
                     ▼
  ┌─ Pairwise similarity scores ──────────────┐
  │  sim(milk, dairy)   = 0.98                 │
  │  sim(milk, market)  = 0.15                 │
  │  sim(dairy, market) = 0.12                 │
  └────────────────────────────────────────────┘
```

## Elaborate

The embedding paradigm shifted with word2vec (Mikolov, 2013), matured with
BERT-style sentence transformers (2019-2020), and became the substrate of
RAG with OpenAI's text-embedding models (2022 onward). Modern embedding
models output 384-3072 dimensional vectors; bigger isn't always better
(retrieval quality plateaus past ~768 dims for most general-purpose text).

For *this codebase's* hypothetical RAG layer, OpenAI's
`text-embedding-3-small` (1536d, ~$0.02/M tokens, ~5ms latency) is the
canonical starting point. The decision tree from
`02-embedding-model-choice.md` walks the alternatives.

## Project exercises

### Exercise — implement embed.ts as the foundation

  → **Exercise ID:** `study-ai-eng-03-01.1`
  → **What to build:** `lib/rag/embed.ts` exporting `embed(text: string):
    Promise<number[]>`. Wraps OpenAI's `embeddings.create` with
    `text-embedding-3-small`. Add a `embedBatch(texts: string[]):
    Promise<number[][]>` that batches via the API's array input form
    (saves round trips). Add a unit test with two semantically-similar
    strings asserting `cosineSim` > 0.7.
  → **Why it earns its place:** First brick in the RAG layer. Everything
    else (storage, retrieval, reranking) depends on it.
  → **Files to touch:** new `lib/rag/embed.ts`, new `lib/rag/cosine.ts`,
    `package.json` (`openai` dep), new `test/rag/embed.test.ts`.
  → **Done when:** `embed("buy milk")` and `embed("purchase dairy")` have
    cosine sim > 0.7 in a test; `embed("buy milk")` and `embed("stock
    market")` have cosine sim < 0.4.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: What is an embedding?**

A vector in a high-dimensional space (typically 384-1536 dimensions) where
semantically similar text lands at nearby positions. Produced by a
pre-trained transformer encoder (like
`text-embedding-3-small`); compared with cosine similarity. Range -1 to 1,
in practice ~0 to 1 for normalized embeddings.

```
  embed("buy milk")     → [0.12, -0.84, 0.33, …]
  embed("purchase dairy") → [0.15, -0.79, 0.31, …]   ← cosine ≈ 0.98
  embed("stock market")  → [-0.42, 0.61, 0.18, …]   ← cosine ≈ 0.15
```

**Anchor line:** "A coordinate system where 'similar meaning' becomes
'nearby position.' The model learned the coordinates; you read them out."

**Q: What does an embedding NOT do?**

It doesn't understand meaning. It learned that certain texts cluster
together because they appear in similar contexts. Inside the training
distribution it's brilliant; outside it (a brand-new product category,
niche jargon, a different language than English) similarity scores get
noisy. Always combine with another signal before trusting top-k —
reranking or sparse search or business rules.

## See also

  → `02-embedding-model-choice.md` — picking which model produces the vectors
  → `04-vector-databases.md` — where the vectors live for fast lookup
  → `05-dense-vs-sparse.md` — when cosine wins, when keyword overlap wins
