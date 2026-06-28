# 02 — embedding model choice

**Subtitle:** Decision tree for picking an embedding model · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** Once you decide to add RAG (`11-rag.md`), the next decision is
which embedding model. It's a one-way choice — switching means re-embedding
the entire corpus.

```
  Zoom out — embedding model lives at the embed.ts seam

  ┌─ lib/rag/embed.ts (hypothetical) ──────────────────┐
  │  embed(text) → number[]                             │  ← we are here
  │  ★ MODEL CHOICE ★                                  │   (Case B)
  └─────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — switching cost.** Re-embedding 10k items at
    OpenAI's `text-embedding-3-small` is ~$0.20 and ~30 minutes; at a local
    `BAAI/bge-small` it's free but ~2 hours. The cost is small; the
    *interruption* is bigger (the index is being rebuilt; queries fall back
    to stale embeddings or return errors during the swap).

## How it works

### Move 1 — the mental model

Same shape as "pick a database for new project": no universal winner,
defaults that cover 80% of cases, edge cases that demand specialized
choices.

```
  Decision tree

  What's the use case?
    │
    ├── English, general purpose, hosted OK
    │   → text-embedding-3-small (OpenAI, 1536d, ~$0.02/M tok)
    │
    ├── Multilingual or domain-specific
    │   → Cohere embed-v3, BGE-multilingual, Voyage
    │
    ├── Privacy-critical, on-device / local
    │   → sentence-transformers (BAAI/bge-small-en, etc.)
    │
    └── Code, technical text
        → text-embedding-3-large (OpenAI) or voyage-code-2
```

### Move 2 — the step-by-step walkthrough

**For blooming insights' hypothetical RAG (diagnosis grounding) the right
default is `text-embedding-3-small`.** Reasoning:

  → Corpus is English (diagnosis text written by the agent, conclusions and
    evidence).
  → Corpus is small (10s to 100s of past investigations even after a year
    of use). Embedding cost is trivial regardless of provider.
  → Privacy is moderate: investigation data is the user's own workspace
    metrics, not user-identifying content. Sending to OpenAI is acceptable
    if the user is already sending the same data to Anthropic.
  → Quality bar is "find roughly similar past anomalies" — not "rank with
    state-of-the-art recall." `text-embedding-3-small` is well within the
    quality envelope.

**Where the larger model would matter:** if you also wanted to embed the
underlying *EQL queries* the diagnostic agent ran and match on those, then
`text-embedding-3-large` (3072d) or a code-specific embedder might score
better — code tokens have different distribution from prose.

**The provider seam.** Same shape as `01-llm-foundations/08-provider-abstraction.md`
but at the embedding boundary:

```typescript
// Hypothetical lib/rag/embed.ts
interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

class OpenAIEmbeddingProvider implements EmbeddingProvider { /* … */ }
class LocalEmbeddingProvider implements EmbeddingProvider {  // @xenova/transformers
  /* … */
}
```

Switching providers means re-embedding the corpus. Dimension changes mean
re-building the index. Storing `embedding_model_version` per row lets you
detect mismatches and trigger a re-embed.

### Move 3 — the principle

**Pick the smallest model that meets your quality bar; the cost difference
is rounding error on a small corpus.** Don't over-engineer the choice at
start; defaults plus a `embedding_model_version` column give you a clean
swap path when you genuinely need to upgrade.

## Primary diagram

```
  Model choice → re-embed cost → dimension impact

  ┌─ text-embedding-3-small ───────────────────────┐
  │  dims: 1536    cost: $0.02/M tokens             │
  │  10k investigations × ~500 tok each = 5M tok    │
  │  → ~$0.10 to (re-)embed entire corpus           │
  └─────────────────────────────────────────────────┘

  ┌─ text-embedding-3-large ───────────────────────┐
  │  dims: 3072    cost: $0.13/M tokens             │
  │  → ~$0.65 to (re-)embed                         │
  │  → 2x storage for vectors                       │
  └─────────────────────────────────────────────────┘

  ┌─ Local (BAAI/bge-small-en via @xenova) ────────┐
  │  dims: 384     cost: $0 + slower                │
  │  → ~2 hours CPU to (re-)embed on a Mac          │
  │  → smaller vectors, smaller index               │
  └─────────────────────────────────────────────────┘
```

## Elaborate

The MTEB benchmark (Massive Text Embedding Benchmark) is the standard
reference for cross-provider quality comparison. Current top performers
include `voyage-3-large`, `BAAI/bge-en-icl`, `gte-Qwen2-7B-instruct`.
For most general-purpose use cases the gap between top performers is small
(within 1-3% on most retrieval tasks).

The decision against `text-embedding-3-large` for this codebase is
deliberate: 2x cost, 2x storage, no measurable quality gain for short
diagnosis texts. Reach for it when (a) the corpus has long technical
content where small models lose nuance, or (b) you're at the ceiling of
small-model quality and need the lift.

## Project exercises

### Exercise — pin embedding model version + re-embed migration

  → **Exercise ID:** `study-ai-eng-03-02.1`
  → **What to build:** When storing an embedding, also store
    `embedding_model: string` (e.g. `'text-embedding-3-small@1'`). On
    query, if the corpus has mixed model versions, error or re-embed the
    minority. Add a one-shot script `scripts/re-embed.ts` that walks the
    corpus and re-embeds everything to a target model.
  → **Why it earns its place:** Migration discipline — model versions WILL
    change. Without a version column, mixed-version queries silently
    return garbage similarity scores.
  → **Files to touch:** `lib/rag/store.ts` (add `embedding_model` field),
    `lib/rag/embed.ts` (report model id), new
    `scripts/re-embed.ts`.
  → **Done when:** Storing two investigations under different model
    versions and querying surfaces a "mixed versions" error or auto-
    migrates one.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: How would you pick an embedding model for this codebase?**

`text-embedding-3-small` from OpenAI as the default. English corpus,
small (~100s of investigations), moderate privacy, quality bar is "find
roughly similar past diagnoses." The model is the standard baseline; the
cost is trivial ($0.10 to embed 10k items); the dimensionality (1536)
fits comfortably in sqlite-vec.

If we needed multilingual support or had to keep data fully on-device,
the choice would shift to a local `BAAI/bge-small-en` via
`@xenova/transformers`.

**Anchor line:** "Smallest model that meets the quality bar; the cost
difference is rounding error at this scale."

**Q: What's the load-bearing fact people forget about embedding model
choice?**

It's a one-way decision. Switching means re-embedding the entire corpus.
On 10k items at OpenAI rates that's a $0.10, 30-minute job — cheap, but
during the swap the index is being rebuilt. Stamping every row with
`embedding_model_version` is the discipline that makes the migration
safe.

## See also

  → `01-embeddings.md` — what the model produces
  → `04-vector-databases.md` — where the vectors live (dimensionality matters here)
  → `09-stale-embeddings.md` — version drift over time
