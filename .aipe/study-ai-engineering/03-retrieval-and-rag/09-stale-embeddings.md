# 09 — stale embeddings

**Subtitle:** Freshness tracking on embedded text · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** Embeddings go stale when their source text changes. The
embedding still exists, still gets retrieved, but it represents the *old*
content. Result: technically successful retrieval, semantically wrong
answer.

```
  Zoom out — staleness sits at the corpus update boundary

  ┌─ Corpus row ───────────────────────────────┐
  │  source text  | embedding | last_embedded  │  ← we are here
  │  "...edited..."   v_old        2 days ago  │   (Case B)
  │                                             │
  │  ★ STALE: text changed, embedding didn't ★ │
  └─────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — freshness.** Each corpus row has TWO timestamps:
    when its content last changed, when its embedding was last computed.
    Staleness = content_updated_at > embedding_updated_at.

## How it works

### Move 1 — the mental model

Same shape as a stale cache: the data behind the key changed but the
cached value didn't. The fix is the same: invalidate on write, recompute
on access (or schedule).

```
  Lifecycle of an embedding

  initial:                       Day 1
    text:      "We use Sequelize ORM"
    embedding: v_1
    embedded_at: Day 1

  edit:                          Day 30
    text:      "We use Drizzle ORM" (updated!)
    embedding: v_1                 (NOT updated — stale!)
    embedded_at: Day 1
    content_updated_at: Day 30

  query "what ORM do we use?":
    → retrieves v_1 → maps to "Sequelize"
    → user sees wrong answer
```

### Move 2 — the step-by-step walkthrough

**For blooming insights' hypothetical RAG (diagnosis grounding),
staleness is mostly a non-issue.** Investigations are append-only —
once created, the diagnosis text doesn't change. The recommendations
might gain user edits (see `01-llm-foundations/09-user-override-locks.md`),
but those are separate fields you wouldn't include in the embedding.

**Where staleness WOULD bite if you embedded other corpora:**
  - Agent prompts (`lib/agents/legacy-prompts/*.md`) — get edited as the
    prompts evolve. If you RAG over them, every edit needs re-embedding.
  - Schema metadata — Bloomreach project schemas change as new events get
    tracked. A `schemaSummary` embedding would go stale every week.

**The tracking pattern:**

```typescript
// hypothetical lib/rag/store.ts schema
interface CorpusRow {
  id: string;
  text: string;
  embedding: number[];
  content_updated_at: string;     // ISO timestamp
  embedded_at: string;            // ISO timestamp
  embedding_model: string;        // see 02-embedding-model-choice exercise
}

function isStale(row: CorpusRow): boolean {
  return new Date(row.content_updated_at) > new Date(row.embedded_at);
}
```

**Two re-embed strategies:**

  → **Eager:** on every text update, re-embed in the same transaction.
    Simple, correct, adds latency to the write path. Best for low-write
    workloads (which is the diagnosis-grounding case).

  → **Lazy / scheduled:** mark stale, re-embed in a background job
    nightly. Cheaper write path, longer staleness window. Best for
    high-write workloads where the embedding latency would dominate.

The right choice depends on how time-sensitive the retrieval is. For
diagnosis grounding, eager is fine — a new investigation is rare enough
that paying for the embedding inline is invisible.

### Move 3 — the principle

**Track when content changed and when the embedding was last computed.
Staleness is silent — retrieval still succeeds, the answer is just
wrong.** A timestamp pair per row is the minimum discipline; re-embed
synchronously on edit if your write volume allows it.

## Primary diagram

```
  Staleness detection + re-embed

  ┌─ Row state ──────────────────────────────┐
  │  text:                "..."              │
  │  embedding:           [...]              │
  │  content_updated_at:  2026-05-15         │
  │  embedded_at:         2026-04-01         │  ← stale!
  └────────────────┬─────────────────────────┘
                   │
                   ▼  on next access or scheduled job
              ┌─ re-embed ─┐
              │  embed(text) │
              │  store        │
              │  embedded_at  │
              │  = now()      │
              └──────────────┘
                   │
                   ▼
            row fresh again
```

## Elaborate

In larger production RAG systems, staleness is a real operational
concern. Documentation sites that re-publish weekly, knowledge bases
that get edited daily, support ticket corpora that grow constantly —
all need a re-embedding cadence and an SLA on freshness.

For append-only corpora (like blooming insights' investigations), the
staleness problem doesn't exist. New rows get embedded; old rows never
change. This is one reason append-only data shapes are nice to work with
for RAG.

## Project exercises

### Exercise — add `content_updated_at` + `embedded_at` to the store schema

  → **Exercise ID:** `study-ai-eng-03-09.1`
  → **What to build:** Extend `SqliteVecStore` (from `04-vector-databases.md`
    exercise) to track both timestamps. Add `findStale()` that returns
    rows where `content_updated_at > embedded_at`. Add a one-shot script
    that re-embeds all stale rows.
  → **Why it earns its place:** Locks in the staleness discipline before
    it can bite. Cheap to add now; painful to retrofit later.
  → **Files to touch:** `lib/rag/store.ts` (schema), new
    `scripts/re-embed-stale.ts`.
  → **Done when:** Editing a stored row's text and re-querying still
    returns stale embedding (proves the problem); running the re-embed
    script fixes it.
  → **Estimated effort:** `<1hr`

## Interview defense

**Q: How do you keep embeddings fresh?**

Track two timestamps per row: `content_updated_at` (when the text last
changed) and `embedded_at` (when the embedding was last computed).
Staleness = the first is greater than the second. Re-embed on detect.

```
  row:
    text                  "..."
    embedding             [...]
    content_updated_at    2026-05-15  ← changed today
    embedded_at           2026-04-01  ← old vector
                                       → stale, re-embed
```

For low-write corpora, re-embed eagerly (same transaction as the text
update). For high-write corpora, mark stale and re-embed in a scheduled
job.

**Anchor line:** "Two timestamps per row. Staleness is silent —
retrieval succeeds with the wrong answer."

**Q: Does this codebase have a staleness problem?**

Not really — the natural corpus (past investigations) is append-only.
Investigations don't get edited after creation, so embeddings never go
stale. If we expanded the corpus to include things that change (agent
prompts, evolving schemas), staleness tracking would land alongside.

## See also

  → `02-embedding-model-choice.md` — `embedding_model` version is the
    related field
  → `10-incremental-indexing.md` — when re-embedding becomes a regular job
