# Embedding model choice

## Subtitle

Model selection tree / one-way decision — Industry standard.

## Zoom out, then zoom in

If blooming ever ships retrieval, the embedding-model choice is the highest-blast-radius decision in that layer. Every stored vector is coupled to the model that produced it — switching models means re-embedding every row in the index. Bounded corpus (say 10k investigations, ~$0.05 to re-embed with a hosted model), still not free.

```
  Zoom out — where the choice bites

  ┌─ ingest ──────────────────────────┐
  │  text ─► embed(v1) ─► store vec   │
  └────────────────┬───────────────────┘
                   │
  ┌─ query ─────── ▼ ──────────────────┐
  │  text ─► embed(v1) ─► compare      │
  │                    ↑                │
  │  MUST match ingest model exactly    │
  └────────────────────────────────────┘

  Switch models → re-embed EVERYTHING (one-way)
```

Zoom in: pick deliberately. The wrong choice is expensive to reverse.

## Structure pass

- **Layers:** use case → model family → provider → dimension → cost. Five bands.
- **Axis: cost per vector.** Text-embedding-3-small: ~$0.02/M tokens. Voyage-3: ~$0.06/M. On-device sentence-transformers: free after model download.
- **Seam:** the embedding function call. Once chosen, it's cemented into the corpus's stored vectors.

## How it works

### Move 1 — the mental model

Decision tree by use case:

```
  Embedding model choice — the decision tree

  Use case?
    │
    ├── English, general purpose, low-cost, hosted
    │   → text-embedding-3-small (OpenAI, 1536 dims, $0.02/M)
    │
    ├── Multilingual or high-recall required
    │   → cohere embed-v3 · voyage-3 · BGE-large
    │
    ├── Code / structured text
    │   → voyage-code-2 · text-embedding-3-large
    │
    └── Privacy-critical, on-device
        → sentence-transformers (all-MiniLM, ~90 MB, free)
```

### Move 2 — the step-by-step walkthrough

**For blooming's would-be use cases.** English business text (diagnoses, EQL queries), small corpus (~10k rows realistic), latency-tolerant (embedding runs on save, not on interactive path). `text-embedding-3-small` is the right default: cheap, well-behaved, 1536 dims easy to index.

**When you'd upgrade.** If retrieval quality is poor and you can measure it (with a hit@k eval on a held-out set), upgrade to `text-embedding-3-large` (3072 dims, ~$0.13/M) or `voyage-3` (~$0.06/M, slightly better on English quality benchmarks). Don't upgrade without evidence — the cost and re-embed pain don't repay themselves.

**When you'd go on-device.** If you decide investigations should never leave the deploy environment (a compliance concern that doesn't yet apply to blooming), `all-MiniLM-L6-v2` at 384 dims runs comfortably on Node.js and costs nothing after download. Quality is markedly worse than hosted, but adequate for coarse similarity.

Diagram of the family tradeoffs:

```
  Model families — the tradeoff space

  ┌──────────────────┬───────┬─────────┬────────────────┐
  │ family           │ dims  │ cost/M  │ where it wins  │
  ├──────────────────┼───────┼─────────┼────────────────┤
  │ text-emb-3-small │ 1536  │ $0.02   │ default        │
  │ text-emb-3-large │ 3072  │ $0.13   │ quality upgrade│
  │ voyage-3         │ 1024  │ $0.06   │ English recall │
  │ cohere-embed-v3  │ 1024  │ $0.10   │ multilingual   │
  │ sentence-t local │ 384   │ free    │ on-device      │
  └──────────────────┴───────┴─────────┴────────────────┘
```

### Move 3 — the principle

Pick the cheapest family whose quality you've measured to be adequate. Never upgrade on faith — measure hit@k before and after. Because switching is one-way, treat the choice like a database engine choice, not a library pick.

## Primary diagram

```
  Embedding model choice — full frame

  ┌─ Requirements ────────────────────────────────────┐
  │  language (English? multi?), latency, privacy,    │
  │  budget, corpus size                              │
  └───────────────────┬──────────────────────────────┘
                      │
                      ▼
  ┌─ Family shortlist ────────────────────────────────┐
  │  · hosted general → text-embedding-3-small         │
  │  · hosted quality → voyage-3 / text-embedding-3-lg │
  │  · on-device      → sentence-transformers          │
  └───────────────────┬──────────────────────────────┘
                      │
                      ▼
  ┌─ Measurement ─────────────────────────────────────┐
  │  hit@k on 100 hand-labeled queries                 │
  │  vs 50 hand-labeled negatives                      │
  └───────────────────┬──────────────────────────────┘
                      │
                      ▼
  ┌─ Commit ──────────────────────────────────────────┐
  │  cement the choice; re-embed only on measured need │
  └───────────────────────────────────────────────────┘
```

## Elaborate

Embedding models rotate every 6–12 months. text-embedding-ada-002 was the OpenAI default for two years; 3-small/large replaced it in 2024. Voyage, Cohere, and BGE turn over models on a similar cadence. Pick a family with the strongest year-over-year track record for stability.

Related: **01-embeddings.md** (what the vectors are), **09-stale-embeddings.md** (what to do when the model upgrades).

## Project exercises

### B3.2 · Set the embedding model constant

- **Exercise ID:** B3.2 (Case B — not yet implemented)
- **What to build:** As part of the investigation-memory retrofit (B3.1), commit a `EMBEDDING_MODEL = 'text-embedding-3-small'` constant to `lib/state/investigation-index.ts` and document the choice in a comment. The comment names the alternatives considered and cites hit@k measurement thresholds for when to upgrade.
- **Why it earns its place:** Turns "pick a model" into "pick a model and defend it with numbers." Interview payoff: "I know which one and I know why."
- **Files to touch:** `lib/state/investigation-index.ts` (constant + doc comment), `docs/embedding-model.md` (measurement protocol).
- **Done when:** the constant is committed with the ADR-style comment; the measurement protocol names the golden set + hit@k threshold that would trigger an upgrade.
- **Estimated effort:** `<1hr`.

## Interview defense

**Q: If you had to pick today for blooming, which model?**

`text-embedding-3-small`. Reasons: English-only corpus, low cost, 1536 dims easy to index in sqlite-vec, and I don't have evidence yet that quality is inadequate. If I measured hit@k on a golden set and saw < 60% top-3 recall, I'd move to voyage-3 or text-embedding-3-large and re-embed the corpus (bounded pain at 10k rows).

**Q: Why not just use whatever is cheapest?**

Cost is a factor, not the factor. If the quality is 30% worse for 5× cheaper, retrieval will surface the wrong neighbors and the augmentation is worse than no retrieval. Measure quality first; optimize cost second.

## See also

- [01-embeddings.md](01-embeddings.md) — the primitive this chooses among.
- [09-stale-embeddings.md](09-stale-embeddings.md) — dealing with model upgrades.
- [11-rag.md](11-rag.md) — where the choice's quality gets measured.
