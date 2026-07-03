# Incremental indexing

## Subtitle

Delta-based re-embed / change-driven index update — Industry standard.

## Zoom out, then zoom in

Two update patterns: **full rebuild** (walk the entire corpus, re-embed everything, swap the index) and **incremental** (track deltas, re-embed only changed rows, merge). Full rebuild is simple and correct but expensive at scale. Incremental is fast but has consistency edge cases.

```
  Zoom out — two update patterns

  Full rebuild (nightly/weekly):
    corpus → re-embed all → swap index
    · simple · correct · expensive

  Incremental (continuous):
    change detection → embed delta → merge
    · fast · complex · has edge cases
```

## Structure pass

- **Layers:** source of change → detection → embed → merge into index. Four bands.
- **Axis: freshness lag.** Full rebuild = whole-corpus lag equal to cadence. Incremental = per-row lag ~= idle-pass interval.
- **Seam:** how you detect change — timestamp, event stream, or explicit stale flag (see **09-stale-embeddings.md**).

## How it works

### Move 1 — the mental model

**Full rebuild** — the whole corpus is re-embedded and the new index atomically replaces the old. Simple: no state to track between runs. Expensive: 10k rows × ~$0.02/M-tokens × ~500 tokens per row = ~$0.10 per full rebuild. Weekly is fine; nightly is affordable.

**Incremental** — only rows that changed since the last pass get re-embedded. Requires: (a) change detection (timestamp column, event stream, or `embedding_stale_at` flag), (b) merge logic (insert new, update changed, delete removed).

```
  Two patterns side by side

  ┌─ Full rebuild ───────────────────┐
  │  cron: nightly                    │
  │  read entire corpus               │
  │  embed everything                 │
  │  swap index atomically            │
  └───────────────────────────────────┘

  ┌─ Incremental ────────────────────┐
  │  cron: every 5 min                │
  │  read WHERE stale_at IS NOT NULL  │
  │  embed deltas only                │
  │  update rows in place             │
  └───────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**For blooming's would-be scale.** ~10k investigations, ~200 tokens each embedded ≈ $0.04 per full rebuild. Cheap enough that full-rebuild nightly is the correct starting choice — simpler and no consistency edge cases. Move to incremental only when full rebuild takes minutes rather than seconds.

**Where incremental beats full at scale.** ~1M rows and up. At that scale, full rebuild costs dollars per run and takes hours; incremental with a 5-min lag pays only for deltas.

**Consistency edge cases in incremental.**

- Row edited during embed pass → embedded text may not match the "current" text; re-mark stale.
- Row deleted → need to also delete from index; requires event-driven signal or scan.
- Model version change → mass mark-stale; re-embed pass sweeps.

**For blooming today.** No index, no update pattern. If retrieval lands, start with full rebuild — one script that walks `investigations`, embeds each, writes to `.investigation-index.json`. Runs on save + on demand.

Pseudocode of an incremental pass:

```
  incrementalUpdate():
    changes = SELECT id, text FROM investigations
              WHERE embedding_stale_at IS NOT NULL
              LIMIT 1000
    for row in changes:
      vec = embed(row.text)
      UPDATE investigations
        SET embedding = ?, embedding_stale_at = NULL
        WHERE id = ? AND embedding_stale_at <= ?  -- guard against races
```

The `<=` in the WHERE clause is the race guard — if the row was re-edited during the embed call, this UPDATE won't fire (its `stale_at` is now newer), and the next pass will pick it up.

### Move 3 — the principle

Start with full rebuild. Move to incremental only when full rebuild is too expensive to run at the required freshness cadence. Incremental buys freshness at the cost of consistency-edge-case complexity — don't take the cost until you need the freshness.

## Primary diagram

```
  Indexing patterns — full frame

  ┌─ Blooming today ───────────────────────────────────┐
  │  no index                                           │
  └────────────────────────────────────────────────────┘

  ┌─ Blooming w/ investigation memory (B3.1) ─────────┐
  │  full rebuild on save                              │
  │  → cheap ($0.04/rebuild @ 10k rows)                │
  │  → simple: no delta tracking                       │
  └────────────────────────────────────────────────────┘

  ┌─ Blooming at 1M+ rows (hypothetical scale) ───────┐
  │  incremental with staleness flag                   │
  │  → freshness within minutes                        │
  │  → race guard in UPDATE prevents lost updates      │
  └────────────────────────────────────────────────────┘
```

## Elaborate

Full rebuild is often the right answer for small-to-medium corpora because it's dead simple. Every mature search stack (Algolia, Elastic, Pinecone) has both patterns available; teams start with full-rebuild and graduate when the numbers force it. The moment to graduate is usually the moment your rebuild takes longer than your freshness SLA.

Related: **09-stale-embeddings.md** (the staleness flag incremental depends on), **11-rag.md** (the pipeline both patterns feed).

## Project exercises

### B3.10 · Full-rebuild endpoint for the would-be investigation index

- **Exercise ID:** B3.10 (Case B — depends on B3.1)
- **What to build:** One-endpoint full rebuild for the investigation-memory index. Read all investigations, re-embed each, write the JSON file. Idempotent; safe to run any time.
- **Why it earns its place:** Simplest correct thing. Ships in ~50 LOC. Interview payoff: "I know when to graduate to incremental (measurement of full-rebuild time vs freshness SLA)."
- **Files to touch:** New `app/api/eval/re-embed/route.ts` (dev-only), reuse `lib/state/investigation-index.ts`.
- **Done when:** POST to the endpoint rebuilds the index end-to-end, returns duration + row count.
- **Estimated effort:** `<1hr` after B3.1 lands.

## Interview defense

**Q: Full rebuild for a growing corpus — how do you decide when to switch?**

Measure two numbers: (1) full rebuild wall-time, (2) required freshness SLA. When (1) approaches (2), switch. For blooming at 10k rows, full rebuild is ~30 seconds; freshness SLA of "next investigation sees updates" is minutes. Full rebuild wins until we're at ~100× current scale.

**Q: What's the trickiest part of incremental?**

Deletes and races. Text edits are easy — the stale flag catches them. Deletes require either an event stream or a periodic sweep to remove orphaned index entries. Concurrent edits during embed require the `stale_at <= embed_start_time` guard in the update to avoid lost updates.

## See also

- [09-stale-embeddings.md](09-stale-embeddings.md) — the flag incremental relies on.
- [11-rag.md](11-rag.md) — the pipeline the index feeds.
- [04-vector-databases.md](04-vector-databases.md) — where the index lives.
