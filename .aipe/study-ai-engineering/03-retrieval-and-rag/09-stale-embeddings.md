# Stale embeddings

## Subtitle

Freshness tracking / re-embed on source change — Industry standard.

## Zoom out, then zoom in

If a doc's text changes but its embedding doesn't, retrieval returns the *old* semantic content. That's silent bad data — the retrieval mechanically succeeds, but the answer is wrong. The mitigation: track `embedding_stale_at` per row, re-embed on the next idle pass.

```
  Zoom out — the freshness problem

  ┌─ Doc row ─────────────────────────────────────────┐
  │  { id, text, embedding, embedding_stale_at? }     │
  └───────────────────────┬───────────────────────────┘
                          │  text edit
                          ▼
  ┌─ Update ──────────────────────────────────────────┐
  │  set text = newText                                │
  │  set embedding_stale_at = now                      │
  │  (embedding still points to old text's vector)    │
  └───────────────────────┬───────────────────────────┘
                          │  idle re-embed pass
                          ▼
  ┌─ Re-embed ────────────────────────────────────────┐
  │  vec = embed(newText); set embedding = vec         │
  │  clear embedding_stale_at                          │
  └───────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** source text → embedding → staleness flag → re-embed. Four bands.
- **Axis: freshness.** Text and embedding must stay in sync; the stale flag is the "in-sync?" bit.
- **Seam:** the write path. Every text update must also set the stale flag.

## How it works

### Move 1 — the mental model

Two writes on a text edit: update the text, mark the embedding stale. The stale-marker is what makes the re-embed pass targetable — you don't re-embed everything, only rows where `embedding_stale_at IS NOT NULL`.

```
  Stale tracking — the shape

  edit event  →  { text: "new", embedding: "old", stale_at: now }
                        │
                        ▼ background re-embed
                 { text: "new", embedding: "new", stale_at: null }
```

### Move 2 — the step-by-step walkthrough

**For blooming's would-be use case.** If the recommendation feature lets a user edit a rec's title/rationale after the fact (see the field-override exercise in **../01-llm-foundations/09-user-override-locks.md**), and the recommendation index (a future feature) uses those fields, editing the title should mark the row stale for re-embedding.

**When re-embed runs.** Idle pass — a background job or explicit endpoint that walks `WHERE stale_at IS NOT NULL`, re-embeds, clears the flag. Cadence depends on how quickly staleness matters; for slow-moving corpora, nightly is fine.

**What if you don't track staleness?** Two failure modes: (a) periodic full re-embed of the whole corpus (expensive at scale), or (b) never re-embed (silent bad retrieval). The stale flag lets you do incremental re-embed correctly.

Diagram of the write path:

```
  Text edit — one row

  user edits rec title
    │
    ▼
  UPDATE recs SET title = ?, embedding_stale_at = NOW() WHERE id = ?
    │
    ▼ (embedding column unchanged)
    │
  idle pass every N minutes:
    SELECT id, text FROM recs WHERE embedding_stale_at IS NOT NULL
    for each:
      vec = embed(text)
      UPDATE recs SET embedding = ?, embedding_stale_at = NULL WHERE id = ?
```

### Move 3 — the principle

An embedding is a snapshot of the text at embed-time. If you don't track when it went stale, you don't know when to re-embed, and retrieval quality decays silently. Explicit staleness tracking is the price of an incremental re-embed strategy.

## Primary diagram

```
  Freshness tracking — full frame

  ┌─ Row shape ────────────────────────────────────────┐
  │  { id, text, embedding, embedding_stale_at?,       │
  │     embedding_version }                             │
  └────────────────────────────────────────────────────┘

                           │
  ┌─ Write path ─────────▼────────────────────────────┐
  │  on text edit:                                     │
  │    set text = newText                              │
  │    set embedding_stale_at = NOW()                  │
  │    (do NOT recompute embedding inline)             │
  └────────────────────────────────────────────────────┘

                           │
  ┌─ Idle re-embed pass ─▼────────────────────────────┐
  │  every N minutes:                                  │
  │    SELECT * WHERE embedding_stale_at IS NOT NULL   │
  │    for each: embed(text), update row               │
  └────────────────────────────────────────────────────┘

                           │
  ┌─ Model upgrade (rare) ▼───────────────────────────┐
  │  bump embedding_version constant                    │
  │  mark all rows stale (single UPDATE)                │
  │  re-embed pass sweeps the corpus                    │
  └────────────────────────────────────────────────────┘
```

## Elaborate

The `embedding_version` field is orthogonal to the staleness flag but often paired with it. Version tracks *which model produced this vector*; when you upgrade the model, bump the version constant and mark all rows stale. The re-embed pass then rebuilds using the new model.

Related: **02-embedding-model-choice.md** (why version matters), **10-incremental-indexing.md** (the sister pattern for corpus growth).

## Project exercises

### B3.9 · Add embedding_stale_at to the would-be investigation index

- **Exercise ID:** B3.9 (Case B — depends on B3.1)
- **What to build:** When the investigation-memory index (B3.1) lands, add `embedding_stale_at` per row. If the user edits an investigation's summary (a future feature), mark stale. Add an idle re-embed job.
- **Why it earns its place:** Correctness. Interview payoff: naming the failure mode ("silent stale retrieval") and the fix.
- **Files to touch:** `lib/state/investigation-index.ts`, new endpoint `/api/re-embed` (dev tool).
- **Done when:** editing an investigation summary sets the stale flag; a next re-embed run clears it; retrieval reflects the new text.
- **Estimated effort:** `1–4hr` on top of B3.1.

## Interview defense

**Q: What happens if you don't track staleness?**

Two bad options: (1) never re-embed — the corpus drifts and retrieval quality decays silently; (2) always re-embed everything on any change — expensive at scale, and impossible to schedule incrementally. Staleness tracking is what makes incremental re-embed correct.

**Q: How do you handle model upgrades?**

`embedding_version` field. On upgrade: bump the version constant, mark all rows stale with a single UPDATE, let the re-embed pass sweep. During the sweep, queries can use whichever version they find; results converge as re-embed completes.

## See also

- [10-incremental-indexing.md](10-incremental-indexing.md) — the sibling pattern.
- [02-embedding-model-choice.md](02-embedding-model-choice.md) — why version matters.
- [11-rag.md](11-rag.md) — the pipeline this discipline serves.
