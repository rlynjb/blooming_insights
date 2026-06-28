# 10 — incremental indexing

**Subtitle:** Deltas vs full rebuild · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** Two patterns for keeping the index up-to-date: full rebuild
(walk all corpus, re-embed everything, swap) and incremental (track
changes, embed only the deltas, merge). For blooming insights' append-
only diagnosis corpus, incremental is the natural shape.

```
  Zoom out — where indexing fits in the data lifecycle

  ┌─ Corpus (lib/state/investigations.ts) ───────┐
  │  append a new investigation                  │
  └────────────────────┬─────────────────────────┘
                       │
                       ▼  ★ INDEX ★
                       │  full rebuild  OR  incremental    ← we are here
                       ▼                                    (Case B)
  ┌─ Vector store ────────────────────────────────┐
  │  upsert(id, vec, meta)                         │
  └────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — write amplification.** Full rebuild re-embeds N
    items per change (huge). Incremental re-embeds 1 (constant).
    Tradeoff: full rebuild is simpler and ensures consistency; incremental
    is faster but has edge cases (concurrent updates, deletion ordering).

## How it works

### Move 1 — the mental model

Same shape as cache invalidation: targeted (this one entry) vs nuclear
(rebuild everything). Targeted is cheaper at steady state; nuclear is
simpler to reason about.

```
  Two patterns

  ┌─ Full rebuild ─────────────────────────────────┐
  │  walk corpus → re-embed everything → swap index │
  │  Simple, correct, expensive                     │
  │  Run nightly or weekly                          │
  │  Good when: corpus < 10k items, batch-oriented  │
  └─────────────────────────────────────────────────┘

  ┌─ Incremental ──────────────────────────────────┐
  │  on add:    upsert new row                      │
  │  on edit:   re-embed + upsert (see 09-stale)   │
  │  on delete: remove from index                   │
  │  Fast, complex, edge-case-prone                 │
  │  Good when: live system, freshness matters      │
  └─────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**For blooming insights' append-only investigation corpus, incremental is
trivial.** No edits, no deletes (well, except cleanup), just appends.
The pattern:

```typescript
// Hypothetical lib/state/investigations.ts (modified)
export async function saveInvestigation(insightId: string, events: AgentEvent[]) {
  // existing: save the investigation as before
  saveToDisk(insightId, events);

  // NEW: also upsert into the vector index
  const inv = reconstructInvestigation(events);
  const vec = await embed(investigationToChunkText(inv));
  await vectorStore.upsert(insightId, vec, {
    conclusion: inv.diagnosis.conclusion,
    created_at: new Date().toISOString(),
  });
}
```

That's it. Every new investigation upserts one row. No rebuild ever
needed for this corpus shape.

**When you'd need full rebuild:**
  - Embedding model upgrade. New model = new vector space = re-embed
    everything. This is the canonical "full rebuild" trigger.
  - Schema change in the chunk text (e.g. decide to include
    recommendations in the chunk after months of only including
    diagnoses).
  - Detected corruption (vectors don't match their source text — rare
    but happens with replication bugs).

**Dual-serve during rebuild.** A naive rebuild flow:
  1. Mark current index as "v1, serving"
  2. Build new index "v2, building" alongside
  3. When v2 is complete, atomic swap: v2 → serving, v1 → archived
  4. Drop v1 after a grace period

This keeps the system queryable during the rebuild. For small corpora
where rebuild takes minutes, you can skip the dual-serve and just halt
queries briefly. For large corpora, dual-serve is essential.

**Deletion ordering.** In an incremental flow, what happens when an
investigation gets deleted? You have to remove the vector from the
index AND from any in-memory cache. If your retrieval has a small
LRU cache (some vector stores do), a recently-deleted row can briefly
still appear in results. Cache invalidation = the same hard problem
it always was.

### Move 3 — the principle

**Prefer incremental indexing for append-only corpora; reserve full
rebuild for embedding-model upgrades and recovery scenarios.** Match
the indexing strategy to the corpus's write pattern. For append-only
(blooming insights' case), incremental is trivially correct; for
edit-heavy, the staleness-tracking from `09-stale-embeddings.md`
becomes the workhorse.

## Primary diagram

```
  Incremental indexing for an append-only corpus

  ┌─ saveInvestigation(id, events) ────────────┐
  │                                            │
  │  1. saveToDisk(id, events)                 │
  │     (existing behavior)                    │
  │                                            │
  │  2. NEW: derive Investigation from events  │
  │                                            │
  │  3. NEW: const text = chunkText(inv)       │
  │                                            │
  │  4. NEW: const vec = await embed(text)     │
  │                                            │
  │  5. NEW: await vectorStore.upsert(id, vec, │
  │           {conclusion, created_at})        │
  │                                            │
  └────────────────────────────────────────────┘

  full rebuild ONLY triggered by:
    - embedding_model upgrade (re-embed all rows)
    - chunk-text schema change (rare)
    - detected corruption (very rare)
```

## Elaborate

The incremental-vs-rebuild distinction is old (database indexing has
faced it for decades). What's specific to LLM embeddings: the
*invalidation trigger* often isn't a content change — it's an embedding-
model upgrade. The model team ships v2 of the embedder; every vector
under v1 is now in a different coordinate system and can't be compared
meaningfully to v2 vectors. The fix is a full re-embed under v2.

This is why `embedding_model_version` (from the exercise in
`02-embedding-model-choice.md`) is the load-bearing field — it's the
trigger that *requires* a rebuild, distinct from any content change.

## Project exercises

### Exercise — wire incremental upsert into `saveInvestigation`

  → **Exercise ID:** `study-ai-eng-03-10.1`
  → **What to build:** Modify `saveInvestigation` in
    `lib/state/investigations.ts` to also call `vectorStore.upsert` with
    the new investigation's embedding. Idempotent (safe to call twice).
    Verify by triggering a fresh diagnostic and confirming the new
    investigation is retrievable on the very next query.
  → **Why it earns its place:** The trivial-but-essential write-side
    wiring. Without it, the vector store is always one investigation
    behind.
  → **Files to touch:** `lib/state/investigations.ts`, new
    `test/state/investigations-rag.test.ts`.
  → **Done when:** A unit test saves an investigation, queries the
    vector store, and finds the new vector at top-1.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: How would you keep the vector index current with the
investigation corpus?**

Incremental upsert on `saveInvestigation`. The corpus is append-only,
so the simplest possible pattern works: every new investigation embeds
and upserts in the same code path as the disk save. No background jobs,
no rebuild cadence, no dual-serve.

```
  saveInvestigation(id, events)
      → save to disk (existing)
      → embed(chunkText) → vectorStore.upsert(id, vec, meta)
```

Full rebuild is reserved for embedding-model upgrades — when the model
changes, every vector is in a new coordinate system and they all need
re-embedding under the new model.

**Anchor line:** "Append-only corpora love incremental indexing. Full
rebuild only when the embedding model changes."

**Q: When would you do dual-serve during rebuild?**

When the corpus is large enough that the rebuild takes more than a few
seconds AND queries can't pause. Build v2 of the index alongside v1,
atomic-swap when complete, drop v1 after a grace period. For this
codebase's scale (hundreds of vectors), rebuild takes seconds and you
can just pause queries briefly. Dual-serve becomes essential at ~10k+
vectors.

## See also

  → `09-stale-embeddings.md` — the edit-aware version of this pattern
  → `02-embedding-model-choice.md` — when full rebuild becomes mandatory
