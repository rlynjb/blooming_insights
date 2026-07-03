# 10 — Incremental indexing

**Type:** Industry standard. Also called: delta indexing, live index updates.

## Zoom out, then zoom in

**Not exercised in this codebase.** For an append-only corpus of past investigations, incremental indexing is simple; for a mutable one, harder.

## Structure pass

Axis: full rebuild vs live delta. Full rebuild is simple + correct + expensive. Incremental is fast + complex + has consistency edge cases.

## How it works

### Move 1

You've built a DB migration that ran on a schedule (full re-derive) or on write (live). Same choice here.

```
  Full rebuild                    Incremental
  ─────────────                    ─────────────
  walk whole corpus                 track {created, updated, deleted}
  re-embed everything               embed only deltas
  swap index                        merge into live index
  simple, expensive                 fast, has edge cases
```

### Move 2

**Full rebuild.** Nightly cron. Walk corpus, embed everything, atomic swap. Simplicity wins under ~1M docs; expense wins over. Downtime is zero if you dual-write during the swap.

**Incremental.** On row create/update/delete, embed the change and merge into the index. Live behavior. Edge cases: partial failure (embedded but not merged), out-of-order arrivals, tombstones for deletes.

**For this codebase's would-be corpus.** Past investigations are append-only — each investigation writes once, isn't edited, isn't deleted. Incremental is trivial: on investigation completion, embed the diagnosis chunks and append to `lib/state/embeddings.json`. No sweep. No consistency risk.

### Move 3

Prefer append-only sources when you can. They make incremental indexing degenerate to "write once." When mutation is real, incremental costs complexity — pay it only when the corpus is too big to rebuild.

## Primary diagram

```
  Two paths

  Full rebuild
  ────────────
  cron
    │
    ▼
  walk corpus → embed all → swap index → done

  Incremental (append-only case)
  ─────────────
  new investigation completes
    │
    ▼
  chunk diagnosis
    │
    ▼
  embed chunks
    │
    ▼
  append to lib/state/embeddings.json
```

## Elaborate

For mutable corpora at scale, patterns like log-structured merge trees (LSM) or event-sourcing over a Kafka log land the incremental problem into standard database machinery. Overkill at this repo's scale.

## Project exercises

### Exercise — append-only embed on investigation completion

- **Exercise ID:** C2.13-B · Case B (RAG not exercised).
- **What to build:** if the RAG stack from `01-04` is present, wire the embed step to fire on `investigation.complete` (a new event). Append chunks + vectors to the store.
- **Why it earns its place:** the simplest useful incremental indexing shape. Interviewer signal: "I'm append-only, so incremental is trivial — here's what I built."
- **Files to touch:** `lib/state/investigations.ts` (fire event on complete), `lib/rag/embed.ts` (append handler).
- **Done when:** completing a new investigation appends its chunks to the store; retrieval finds them on the next query.
- **Estimated effort:** <1hr on top of the existing embed exercise.

## Interview defense

**Q: Full rebuild or incremental?**

Corpus size + mutation rate. Full rebuild is a nightly cron over the whole set — simple, correct, expensive at scale. Incremental writes each delta live — fast, complex, has consistency edge cases (partial failure, tombstones, ordering).

**Q: When does incremental get complex?**

When mutation is real. Deletes need tombstones. Updates need "which is the current vector for this id." Out-of-order arrivals need reconciliation. Append-only corpora dodge most of it.

**Q: What's this codebase's would-be scale?**

Small enough that full rebuild is fine. If we grew past ~1M chunks, we'd revisit. Below that, "re-embed everything nightly" is one cron and no consistency puzzle.

## See also

- `09-stale-embeddings.md` — the freshness surface incremental would touch
- `04-vector-databases.md` — the store this writes to
