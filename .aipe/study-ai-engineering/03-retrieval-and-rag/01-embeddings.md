# Embeddings

## Subtitle

Vector representation of text / dense semantic embedding — Industry standard.

## Zoom out, then zoom in

This codebase does not currently produce embeddings. The concept file exists because two candidate refactors would introduce them: past-investigation memory (embed the diagnosis text of every completed investigation) and EQL query library (embed each working query with its anomaly context).

```
  Zoom out — where embeddings would fit

  ┌─ Agent code ────────────────────────────────────────┐
  │  today: no embeddings                                │
  │  tomorrow: embed on save (investigations) or         │
  │            embed on demand (workspace catalog)       │
  └───────────────────────┬──────────────────────────────┘
                          ▼
  ┌─ Vector store (new — not yet built) ★ ──────────────┐ ← we are here
  │  candidate: sqlite-vec (local, no infra)             │
  │  candidate: pgvector (if Postgres added)             │
  └──────────────────────────────────────────────────────┘
```

Zoom in: an embedding is a text-to-vector function. Similar meanings end up at nearby vectors. Vector distance ≈ semantic distance, approximately.

## Structure pass

- **Layers:** text → embedding model → vector → distance function → nearest neighbors. Five bands.
- **Axis: representation.** Text is discrete symbols; vectors are dense numeric. The seam is the embedding model — the boundary that converts one to the other.
- **Seam:** the embedding call itself. It's the only place text becomes vector.

## How it works

### Move 1 — the mental model

A vector in N-dimensional space (typically 768–3072 dims). Each text maps to one vector. Distance between two vectors correlates with semantic similarity.

```
  Embedding — the shape

  "conversion drop mobile checkout"
                 │
                 ▼  embed()
                 │
     [0.12, -0.84, 0.33, ..., 0.07]   ← 1536 dims

  Compared to:
  "payment failure spike credit card" → nearby
  "customer retention rate"           → far

  2D projection (cartoon):
       ↑
       │ · "retention rate"
       │
       │
       │       · "conversion drop"
       │           · "payment failure"
       │
       └─────────────────────────────►
```

### Move 2 — the step-by-step walkthrough

**What the model does.** An embedding model is a transformer trained (or fine-tuned) so that texts with similar meanings produce nearby output vectors. You send text over an API; you get back a fixed-dimension float array.

**What a refactor here would look like.** For past-investigation memory:

- On completed investigation, embed the concatenation of `anomaly.metric + anomaly.scope + diagnosis.conclusion` — one embedding per investigation.
- Store `{investigationId, embedding, diagnosis}` in a table (new `.investigation-index.json` in dev, sqlite-vec in prod).
- On new investigation, embed the incoming anomaly the same way, look up top-3 nearest neighbors by cosine similarity, inject their diagnoses as few-shot context.

Pseudocode of the embed-and-store step:

```
  onInvestigationComplete(inv):
    text = inv.anomaly.metric
         + " " + inv.anomaly.scope.join(",")
         + " " + inv.diagnosis.conclusion
    vec = embed(text)                     // Anthropic voyage or OpenAI ada
    store { id: inv.id, vec, inv }
```

**What the retrieval step looks like at query time:**

```
  onNewInvestigation(anomaly):
    text = anomaly.metric + " " + anomaly.scope.join(",")
    q = embed(text)
    topK = index.nearestNeighbors(q, k=3)    // cosine similarity
    if topK[0].distance < 0.3:                // "close enough"
      inject topK as few-shot in system prompt
    else:
      no augmentation
```

### Move 3 — the principle

Embeddings buy you semantic similarity as a distance function. You get to "find things like this thing" for free (or close to it — see cost math in **../01-llm-foundations/06-token-economics.md**). The tradeoff: the embedding is a lossy compression — two different sentences can have similar embeddings for the wrong reasons, and reranking (see **07-reranking.md**) is the standard fix.

## Primary diagram

```
  Embeddings + retrieval — the shape (would-be refactor)

  ┌─ Ingest ──────────────────────────┐
  │  investigation completes           │
  │       │                            │
  │       ▼                            │
  │  embed(anomaly + diagnosis)        │
  │       │                            │
  │       ▼                            │
  │  index.upsert({id, vec, inv})      │
  └────────────────────────────────────┘

  ┌─ Query ───────────────────────────┐
  │  new anomaly arrives               │
  │       │                            │
  │       ▼                            │
  │  q = embed(anomaly)                │
  │       │                            │
  │       ▼                            │
  │  topK = index.nearestNeighbors(q)  │
  │       │                            │
  │       ▼                            │
  │  inject topK into diagnostic prompt│
  └────────────────────────────────────┘
```

## Elaborate

The embedding-as-distance-function idea comes from word embeddings (word2vec, GloVe, 2013–14) and generalized to sentences with sentence-transformers (~2019) and modern hosted APIs (OpenAI, Cohere, Anthropic Voyage). The dimension count is a design choice — higher-dim tends to be more accurate but costs more storage.

Related: **02-embedding-model-choice.md** (which model to pick), **04-vector-databases.md** (where to store the vectors), **07-reranking.md** (fixing the lossy-compression failure mode).

## Project exercises

### B3.1 · Add investigation-memory retrieval to the diagnostic agent

- **Exercise ID:** B3.1 (Case B — not yet implemented)
- **What to build:** On every completed investigation, embed the anomaly + diagnosis and store `{id, vec, inv}` in `.investigation-index.json`. On new investigation, retrieve top-3 nearest neighbors and inject as few-shot context if distance < 0.3.
- **Why it earns its place:** The strongest RAG case in this codebase — memory of prior investigations directly improves diagnosis quality on recurring anomaly types. Measurable via the existing eval baseline.
- **Files to touch:** New `lib/state/investigation-index.ts`, hook into `lib/state/investigations.ts:saveInvestigation` for the embed-on-save, extend `lib/agents/diagnostic.ts` to inject retrieved context.
- **Done when:** rerunning the baseline with memory enabled shows a measurable change (up or down) in `root_cause_plausibility` pass rate; embeddings cost < $0.001/investigation.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: You don't have embeddings today. Why is that the right call?**

The corpus doesn't yet exist. Past-investigation memory needs a corpus of past investigations; the codebase writes those to state but doesn't accumulate cross-session yet. Adding embeddings before the corpus is scaffolding for a load that doesn't exist. The concept file names the exact refactor and its exercise (`B3.1`) — I know what to build first if I decide the memory is worth the added complexity.

**Q: If you add embeddings, which model?**

Voyage-3 or OpenAI text-embedding-3-small — see **02-embedding-model-choice.md** for the decision tree. Cost is trivial (~$0.02/M tokens); the load-bearing choice is picking a family that's stable enough that re-embedding on model upgrades is bounded.

## See also

- [02-embedding-model-choice.md](02-embedding-model-choice.md) — which family to pick.
- [11-rag.md](11-rag.md) — the full pipeline embeddings feed.
- [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md) — the memory shape retrieval would power.
