# Incremental indexing (update the index without rebuilding it)

**Industry name(s):** incremental indexing, upsert/delete, change-data-capture re-indexing, index maintenance
**Type:** Industry standard · Language-agnostic

> A retrieval index is built once but the source keeps changing, so you need to add, update, and delete vectors *in place* rather than re-embedding the whole corpus on every change — an upsert keyed by document id, driven by change-detection; blooming insights has no index, but its append-keyed investigation store is the same "write by key, update in place" shape, so this is study material grounded in a real analog.

**See also:** → 09-stale-embeddings.md · → 04-vector-databases.md · → 03-chunking-strategies.md · → 11-rag.md

---

## Why care

`saveInvestigation(insightId, events)` (`lib/state/investigations.ts`) already does keyed in-place updates: `mem.set(insightId, events)` overwrites the entry for that id, leaving every other investigation untouched. It does not rebuild the whole store to save one investigation — it upserts by key. An embedding index needs the identical operation: when one past investigation changes, update *its* vectors and leave the rest, rather than re-embedding all of them. The difference is only that the value is a vector (and its freshness must be tracked, `09-stale-embeddings.md`), not raw events.

The question incremental indexing answers is: the index was built from a corpus that keeps changing — how do you keep it current without paying to re-embed everything on every change?

**The pivot: re-embedding the entire corpus on every change is correct but O(N) per change, which is unaffordable the moment the corpus or the change-rate grows — so the index must support per-document add/update/delete keyed by id.** A full rebuild for one new investigation re-embeds hundreds of unchanged documents, costs proportional embedding-API calls, and takes the index offline or stale during the rebuild. An incremental upsert touches exactly the changed document: embed it, replace its vector by id, done — O(1) per change, the rest of the index untouched.

Before incremental indexing:
- One document changes; you re-embed the whole corpus to update the index
- Cost and latency scale with corpus size, not with what changed
- The index is stale or offline during each rebuild

After:
- A change-detector finds the changed document
- You upsert *its* vector by id; deleted documents are removed by id
- Cost scales with the *change*, not the corpus; the index stays live

It is `mem.set(insightId, events)` — the keyed upsert the codebase already uses for investigations — applied to vectors.

---

## How it works

**Mental model.** Treat the index as a keyed store you mutate, not a build artifact you regenerate. The codebase already has the right instinct in `saveInvestigation`: `Map.set(key, value)` updates one entry in place. Incremental indexing is the three CRUD-by-key operations — upsert (add or replace), delete — over vectors, gated by change-detection so you only touch what changed.

```
  full rebuild (O(N) per change)        incremental (O(changes))
  ──────────────────────────────        ──────────────────────────────
  for every doc: re-embed, replace      for changed doc: re-embed, upsert
  re-embeds the unchanged               touches only the changed
  index offline/stale during build      index stays live
       │                                     │
       └── correct but unaffordable          └── the production approach
```

The body walks the operations and the change-detection that drives them.

---

### The three operations, keyed by id

An incremental index supports add/update (unified as *upsert*) and delete, each addressed by document id — exactly the key-addressing `saveInvestigation` uses.

```
  ADD     new document        → embed → index.set(docId, {vector, hash, staleAt})
  UPDATE  document changed     → embed → index.set(docId, ...)   (same op as add)
  DELETE  document removed     → index.delete(docId)
                                  (and any chunk vectors derived from it)
```

Add and update are the same upsert — `set` by key overwrites if present, inserts if not — which is why `Map.set` covers both. Delete is the one people forget: a removed source document whose vector lingers will be retrieved as a ghost result.

### Change-detection drives the upserts

You upsert only what changed, detected by comparing a stored content hash (or source version) against the current document — the same change-detection that drives freshness in `09-stale-embeddings.md`.

```
  on a corpus update:
    for each current doc:
      stored = index.get(docId)
      if !stored                       → ADD (new)
      else if hash(doc) != stored.hash → UPDATE (changed)
      else                              → skip (unchanged, no embed cost)
    for each indexed docId not in current corpus → DELETE (gone)
```

The unchanged-skip is where the savings live: a corpus of 500 investigations with 1 changed produces 1 embed call, not 500.

### Chunk-level granularity

If documents are chunked (`03-chunking-strategies.md`), a changed document may have changed only one chunk. Tracking chunks by id (`docId#chunkIndex`) lets you re-embed only the changed chunk, not the whole document — the same upsert pattern one level finer.

```
  investigation 42 edited: only the recommendation section changed
  ┌──────────────────────────────────────────────┐
  │ 42#diagnosis   hash same  → skip               │
  │ 42#hypothesis  hash same  → skip               │
  │ 42#rec         hash diff  → re-embed, upsert    │ ◀── only this
  └──────────────────────────────────────────────┘
```

### The codebase's keyed-upsert analog

`saveInvestigation` (`lib/state/investigations.ts`) is the pattern in miniature: `mem.set(insightId, events)` upserts one investigation by key into an in-memory `Map`, and (in dev) merges into a JSON file by key (`all[insightId] = events`) rather than rewriting unrelated entries. That is incremental indexing's core move — write by key, update in place, leave the rest — already present for raw investigation events. An embedding index would do the same with vectors plus change-detection.

### The principle

Keep the index current by mutating it in place — upsert and delete keyed by document id, gated by change-detection so cost scales with what changed, not with corpus size. A full rebuild is the correct semantics and the wrong economics; the keyed-upsert the codebase already uses for `saveInvestigation` is the right shape, extended with a content hash to skip the unchanged and a delete path to evict ghosts.

---

## Incremental indexing — diagram

This diagram spans the Service layer (change-detection + the three operations) and the State layer (the keyed index). A reader who sees only this should grasp that updates are per-document upserts/deletes, not a full rebuild.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (would live in lib/mcp/embeddings.ts)               │
│                                                                      │
│  corpus update event                                                 │
│      │  change-detection (hash compare, like 09)                    │
│      ├── new doc       → embed → UPSERT by id                       │
│      ├── changed doc   → embed → UPSERT by id (or changed chunk)    │
│      ├── unchanged     → skip (no embed cost)                       │
│      └── removed doc   → DELETE by id (+ derived chunks)            │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ per-document mutations
┌──────────────────────────▼───────────────────────────────────────────┐
│  STATE LAYER  (lib/state/ — keyed index, like investigations.ts)    │
│   Map<docId, {vector, hash, staleAt}>                               │
│   set(id,..) = upsert (add/update)   delete(id) = evict             │
│   ◀── exactly the saveInvestigation `mem.set(insightId, events)` shape │
└──────────────────────────────────────────────────────────────────────┘
```

Cost flows with the number of changes, not the corpus size — the upsert/delete-by-key shape `saveInvestigation` already uses.

---

## In this codebase

**Not yet implemented (incremental embedding indexing).** blooming insights retrieves live via MCP tool calls + EQL, so there is no embedding index to maintain — and a live tool call needs no indexing at all, which is part of the no-RAG rationale (`11-rag.md`): there is no index to keep current because every query reads the source live.

The honest analog is `saveInvestigation` (`lib/state/investigations.ts`): it is keyed in-place upsert. `mem.set(insightId, events)` overwrites exactly the one investigation by key (leaving the rest), and in development it merges into the JSON cache by key (`all[insightId] = events`) instead of rewriting unrelated entries. That is the add/update-by-id core of incremental indexing, minus the change-detection and the delete path. `getCachedInvestigation` (`lib/state/investigations.ts`) is the keyed read. An incremental embedding index would extend this exact pattern in `lib/mcp/embeddings.ts` / `lib/state/` with a content hash (skip unchanged) and a delete path (evict ghosts). The `Project exercises` block below is the primary buildable target.

---

## Elaborate

### Where this pattern comes from

Incremental indexing is foundational to search engines — Lucene/Elasticsearch maintain segments that are merged and updated incrementally rather than rebuilt, and crawlers re-index only changed pages. The database world calls the trigger change-data-capture (CDC): emit an event on every row change and update derived structures (including embedding indexes) from the event stream. The RAG era inherited all of it: every production vector DB exposes `upsert` and `delete` by id, and the standard pipeline is "source change event → re-embed the changed item → upsert," not periodic full rebuilds.

### The deeper principle

```
  derived structure        update strategy           cost per change
  ──────────────────────   ───────────────────────   ───────────────
  embedding index          upsert/delete by id       O(changes)
  full rebuild             re-embed everything        O(N)
  saveInvestigation (HAS)  mem.set by key            O(1)
```

The principle is universal to any derived-from-source structure: maintain it incrementally, keyed, driven by change-detection. A full rebuild is the fallback for when the index is corrupt or the model changed (the `09` model-swap case), not the steady-state update path.

### Where this breaks down

1. **Forgotten deletes leave ghosts.** Upsert-only maintenance never removes vectors for deleted documents, so retrieval returns results pointing at content that no longer exists. The delete path is as important as the upsert and is the most commonly omitted.

2. **Concurrent updates can race.** Two upserts of the same id (a re-run finishing while an edit lands) can interleave; without ordering or a version check, the index can end up with the older vector. `saveInvestigation`'s `mem.set` has the same last-write-wins exposure for investigations.

3. **Incremental indexes drift over time.** Many small upserts can leave an ANN index (`04`) sub-optimally structured (fragmented graph, unbalanced clusters), degrading recall until a periodic compaction/rebuild. Incremental is the steady state; an occasional rebuild is still needed.

### What to explore next

- **Stale embeddings** (`09-stale-embeddings.md`): change-detection is shared between freshness and incremental update.
- **Vector databases** (`04-vector-databases.md`): `upsert`/`delete` are native vector-DB operations; ANN indexes need periodic compaction.
- **Chunking** (`03-chunking-strategies.md`): chunk-level ids enable re-embedding only the changed chunk.

---

## Tradeoffs

### Incremental upsert/delete vs. full rebuild vs. live retrieval (current)

| Dimension | Incremental (upsert/delete) | Full rebuild | Live tool call (current) |
|---|---|---|---|
| Cost per change | O(changes) | O(N) | N/A — no index |
| Index availability during update | Live | Stale/offline | Always live |
| Delete handling | Explicit delete by id | Implicit (gone after rebuild) | N/A |
| Bookkeeping | Content hash + ids | None | None |
| ANN structure quality | Degrades, needs compaction | Optimal after rebuild | N/A |
| Right when | Corpus changes often | Rare changes / model swap | Source is a live API |

**What we gave up (by not having it).** Nothing — live retrieval has no index to maintain, so there is no incremental-update cost at all. That is a genuine advantage of the live-tool approach (`11-rag.md`): you never re-embed, never upsert, never compact, because there is no derived structure to keep in sync with the source.

**What the alternative would have cost.** An embedding index buys semantic search at the price of perpetual maintenance: change-detection, per-document upserts, a delete path, and periodic ANN compaction. For data that is already a live API, that is ongoing operational cost to keep a copy in sync with a source you could just read directly.

**The breakpoint.** Live-only (no index) is correct while every query reads the source live. Incremental indexing becomes necessary only when a feature needs an embedding index over content that *isn't* a live API (past investigation narratives) *and* that corpus changes — at which point full rebuilds are too expensive and per-document upsert/delete keyed by id (extending `saveInvestigation`'s pattern) is the required approach.

---

## Tech reference (industry pairing)

### keyed upsert / delete

- **Codebase uses:** the analog — `saveInvestigation` `mem.set(insightId, events)` and JSON merge `all[insightId] = events` (`lib/state/investigations.ts`); keyed read `getCachedInvestigation`. No vectors.
- **Why it's here (absent for vectors):** there is no embedding index; investigations are upserted by key but never embedded.
- **Leading today:** vector-DB native `upsert`/`delete` by id (Pinecone, Qdrant, Weaviate) leads incremental indexing (2026).
- **Why it leads:** per-document mutation keeps the index live and costs scale with change, not corpus size.
- **Runner-up:** Elasticsearch incremental segment updates — the search-engine lineage of the same idea.

### change-data-capture / change-detection

- **Codebase uses:** nothing for re-indexing; investigations are overwritten wholesale by key with no hash compare.
- **Why it's here (absent):** no derived index needs selective updates.
- **Leading today:** CDC pipelines (Debezium, source-change events) driving re-embed-on-change lead production RAG maintenance (2026).
- **Why it leads:** updates the index from the authoritative change stream — no polling, minimal re-embedding.
- **Runner-up:** content-hash polling — compare a stored hash on a schedule; simpler, higher latency than event-driven.

---

## Project exercises

### Build incremental upsert/delete for the embedding index

- **Exercise ID:** B2A.4 / B2B.1 (adapted) — the primary buildable target.
- **What to build:** extend the embedding index (`09`) with `upsert(docId, text)` (embed + replace by id, skip if the content hash matches) and `remove(docId)` (delete the vector and its derived chunk vectors). Drive it from a change-detector that compares hashes, mirroring `saveInvestigation`'s keyed-write pattern. Track chunks by `docId#chunkIndex` so only changed chunks re-embed.
- **Why it earns its place:** demonstrates you maintain an index in place with cost proportional to change — including the delete path most candidates forget — extending the codebase's own keyed-upsert pattern.
- **Files to touch:** new `lib/state/embedding-index.ts` (`upsert`/`remove` by id + hash skip), `lib/mcp/embeddings.ts` (embed-on-change), `lib/state/investigations.ts` (emit a change signal on `saveInvestigation`), new `test/state/embedding-index.test.ts` (upsert skips unchanged, delete evicts ghosts, chunk-level update).
- **Done when:** changing one investigation re-embeds only its changed chunk, an unchanged investigation triggers zero embed calls, and a deleted investigation's vectors are evicted so it cannot be retrieved.
- **Estimated effort:** 1–2 days

### Add periodic ANN compaction with a drift check

- **Exercise ID:** C2.12 (adapted) — incremental-index maintenance.
- **What to build:** after many incremental upserts, detect index drift (e.g. a recall regression on a fixed eval set) and trigger a periodic full rebuild/compaction, keeping incremental as the steady-state path and rebuild as the occasional repair.
- **Why it earns its place:** shows you know incremental indexes degrade over time and that a periodic rebuild is still needed — the maintenance nuance.
- **Files to touch:** `lib/state/embedding-index.ts` (compaction + drift check), new `scripts/index-compact.ts`, `test/state/embedding-index.test.ts`.
- **Done when:** a recall regression on the eval set after many upserts triggers a rebuild that restores recall, with incremental updates remaining the default.
- **Estimated effort:** 1–4hr

---

## Summary

A retrieval index is built once but its source keeps changing, so it must be maintained by per-document upsert (add/update) and delete keyed by id, gated by change-detection so cost scales with what changed rather than with corpus size — a full rebuild is correct semantics but O(N) wrong economics. blooming insights has no index, but `saveInvestigation`'s `mem.set(insightId, events)` is exactly the keyed in-place upsert the pattern needs, missing only change-detection and a delete path. Live tool retrieval needs no index at all, which is part of why the codebase deferred RAG — there is nothing to keep in sync.

**Key points:**
- Maintain the index in place — upsert and delete by document id, not full rebuilds.
- Change-detection (content hash) skips the unchanged, so cost scales with the change.
- The delete path is the most commonly forgotten — omit it and deleted docs become ghost results.
- `saveInvestigation`'s `mem.set` by key is the codebase's existing keyed-upsert shape.
- Incremental indexes drift; a periodic compaction/rebuild is still occasionally needed.

---

## Interview defense

### What an interviewer is really asking

"How do you keep a vector index up to date?" tests whether you reach for incremental upsert/delete instead of periodic full rebuilds. The senior signal is naming change-detection-driven per-document upserts, remembering the delete path (ghosts), noting that incremental indexes drift and need occasional compaction, and — here — pointing at `saveInvestigation`'s keyed `mem.set` as the existing pattern to extend.

### Likely questions

**[mid] Why not just rebuild the whole index when something changes?**

Because a rebuild re-embeds every document to update one — O(N) per change, with the index stale or offline during the build. Incremental indexing embeds only the changed document and upserts its vector by id, so cost scales with the change, not the corpus. It is `Map.set(id, vector)`, the same shape as `saveInvestigation`.

```
rebuild: re-embed all 500 to update 1 (O(N))
upsert:  embed 1, set by id (O(changes))
```

**[senior] What operation do people forget, and what breaks without it?**

Delete. Upsert-only maintenance never removes vectors for deleted source documents, so retrieval returns ghost results pointing at content that no longer exists. Delete-by-id (plus deleting derived chunk vectors) is as essential as upsert and is the most commonly omitted operation.

```
doc deleted, vector lingers → retrieved as ghost
fix: index.delete(docId) + delete its chunks
```

**[arch] Is incremental indexing enough on its own?**

No — incremental is the steady-state path, but many small upserts degrade an ANN index's structure (fragmented graph, unbalanced clusters), lowering recall over time. You still need a periodic compaction/full rebuild as repair, triggered by a recall regression on a fixed eval set. Incremental for the common case, rebuild for maintenance and for the model-swap full-invalidation case from `09`.

```
incremental upserts → drift → recall regression
periodic compaction/rebuild → restore recall
```

### The question candidates always dodge

**"What about deletes?"** Most candidates describe add/update and stop. A removed source document whose vector stays in the index is a silent correctness bug — the retriever surfaces a result for content that is gone. Naming the delete path (and deleting derived chunk vectors) unprompted is the senior signal.

### One-line anchors

- `lib/state/investigations.ts` — `saveInvestigation` `mem.set(insightId, events)`: keyed in-place upsert, the pattern to extend.
- `lib/state/investigations.ts` — `all[insightId] = events`: keyed JSON merge, not a full rewrite.
- Upsert + delete by id, driven by change-detection — cost scales with change.
- The delete path is the forgotten one; omit it and deleted docs become ghosts.
- Incremental indexes drift; a periodic compaction/rebuild is still needed.

---

## Validate

### Level 1 — Reconstruct

From memory, list the three incremental-index operations (upsert covering add+update, delete) keyed by id, and the change-detection that decides which to run. State what full rebuild costs vs. incremental.

### Level 2 — Explain

Out loud: why does change-detection (content hash) make incremental cost scale with the change rather than the corpus? What breaks if you skip the delete path?

### Level 3 — Apply

Scenario: a past investigation is edited and one section changes. Open `lib/state/investigations.ts` (`saveInvestigation` keyed upsert) and explain how you would extend it to an embedding index: where the hash compare goes, how chunk-level ids (`docId#chunkIndex`) let only the changed section re-embed, and where the delete path lives for removed investigations.

### Level 4 — Defend

A colleague proposes a nightly full re-embed of the whole corpus "for simplicity." Argue the cost (O(N) embedding calls, stale window during the rebuild) versus change-detection-driven upserts, and concede the cases where a full rebuild is still right (a model swap from `09`, or recovering from index drift).

### Quick check — code reference test

What keyed in-place update does blooming insights already perform, and what two things would an incremental embedding index add to it? (Answer: `saveInvestigation` upserts one investigation by key — `mem.set(insightId, events)` and the JSON merge `all[insightId] = events` in `lib/state/investigations.ts`; an incremental embedding index would add change-detection — a content hash to skip unchanged documents — and a delete path to evict vectors for removed documents.)
