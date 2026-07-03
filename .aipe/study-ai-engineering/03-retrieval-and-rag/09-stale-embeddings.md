# 09 — Stale embeddings

**Type:** Industry standard. Also called: embedding freshness, index invalidation.

## Zoom out, then zoom in

**Not exercised in this codebase.** If RAG were added, edits to source text would leave the vectors out of sync until re-embedded.

## Structure pass

Axis: does the vector reflect the current text? Yes = fresh; no = stale.

## How it works

### Move 1

You've cached a query result and had it go stale when the underlying row changed. Same problem, LLM-scale.

```
  Day 1:  text = "We use Sequelize ORM"      vector = e_v1
  Day 30: text = "We use Drizzle ORM"         vector = STILL e_v1

  Query "what ORM do we use?" → retrieves e_v1 → answer wrong.
```

### Move 2

**The problem.** Embeddings are a derivative of source text. If source changes, embeddings must be recomputed. If you skip that, retrieval succeeds (top-k still comes back) but the answer is based on stale content.

**The fix.** Track `embedding_stale_at` per row. On text change, mark stale. Re-embed in an idle pass, or on-read (lazy invalidation).

**For this codebase.** If past diagnoses are ever edited (they aren't today — read-only), this becomes a concern. If the corpus is append-only (which past diagnoses would be), staleness is only a concern if the diagnosis schema evolves and existing rows need re-embedding.

### Move 3

Any embedded corpus that mutates needs freshness tracking. Skip it and every mutation silently corrupts retrieval.

## Primary diagram

```
  Freshness tracking

  {
    id: '...',
    text: '...',
    text_updated_at: 2026-06-30T14:00:00Z,
    embedding: [...],
    embedding_computed_at: 2026-06-15T09:00:00Z,   ← stale (older than text)
    embedding_stale: true,
  }

  Reader-side: check `embedding_stale`; recompute on read, or skip
  the result if freshness matters.

  Writer-side: text update sets `embedding_stale = true`.
  Background job: sweep stale rows, re-embed, mark fresh.
```

## Elaborate

Idle re-embedding is common. Every row has an update timestamp; a background job re-embeds rows whose text has changed since the vector was computed. Trade: reader-side you may briefly serve stale content.

Lazy re-embedding on read is safer but slower — every retrieval checks freshness, re-embeds if stale. Simpler consistency; higher read latency.

## Project exercises

### Exercise — freshness tracking on the past-investigation embeddings

- **Exercise ID:** C2.12-B · Case B (RAG not exercised).
- **What to build:** if any Case B RAG add includes editable source text, add `embedding_stale_at` per row. Sweep + re-embed in a scheduled job.
- **Why it earns its place:** freshness is a real production concern; naming it in a design is a differentiator.
- **Files to touch:** `lib/rag/store.ts`, `lib/state/investigations.ts`.
- **Done when:** editing source text sets stale flag; sweep clears it.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: What causes staleness?**

Source text mutation between embedding computation and retrieval time. The vector reflects the OLD text; the retrieved doc's live text has since changed.

**Q: How do you detect it?**

`text_updated_at > embedding_computed_at` → stale. That's the boolean.

**Q: Fix strategies?**

Idle re-embed (background sweep) or lazy re-embed (compute on read for stale rows). Idle is faster reads, slightly stale writes. Lazy is slow reads on the freshness edge, always-fresh retrieval.

## See also

- `10-incremental-indexing.md` — the write path that would touch this
- `01-embeddings.md` — the primitive being invalidated
