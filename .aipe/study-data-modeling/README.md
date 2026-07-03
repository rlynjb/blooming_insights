# Study — Data Modeling (blooming insights)

The through-line for this guide:

> **does the shape of the data match how it's actually read and written — and can it stay correct?**

That question sounds abstract until you notice this repo doesn't have a database. No Postgres. No SQLite. No Prisma schema. What it has instead is a *lattice* of small persistence tiers — localStorage, an in-memory `Map`, a signed cookie, a dev-only JSON file, a git-committed baseline — each holding a different fact for a different lifetime. The "schema" is the union of the TypeScript shapes that flow through those tiers.

That is worth studying. Most data-modeling instincts assume a table. When there's no table, the modeling doesn't disappear — it scatters into type unions, discriminated variants, and validation guards. And it can still go wrong the same ways: the same fact stored twice, a required invariant enforced only in the client, a shape evolving on disk with no migration path.

## The two partition seams (stated up front)

This guide sits between two neighbors:

```
  ┌── study-system-design ──────────────────────────────────┐
  │  WHICH datastore, sharding, replicas, scaling shape.     │
  │  "use Postgres, add a read replica" lives there.         │
  └──────────────────────────────────────────────────────────┘
                        ▲
                        │  seam 1
                        ▼
  ┌── study-data-modeling  (this guide) ────────────────────┐
  │  the SHAPE of persistent data: schema, normalization,    │
  │  indexes vs queries, integrity, migrations, evolution.   │
  │  "this shape is wrong / this fact leaks" lives here.     │
  └──────────────────────────────────────────────────────────┘
                        ▲
                        │  seam 2
                        ▼
  ┌── study-dsa-foundations ────────────────────────────────┐
  │  IN-MEMORY data structures + algorithms. A heap in RAM   │
  │  is DSA; a B-tree index on disk is data modeling.        │
  └──────────────────────────────────────────────────────────┘
```

  → **Seam 1 (vs system-design):** "add a Redis for the session Map" is system-design. "the `SessionFeed` shape denormalizes `Insight` fields from `Anomaly` and both must stay coherent" is data modeling.
  → **Seam 2 (vs DSA):** the `Map<sessionId, SessionFeed>` uses a `Map` — that's DSA. The *decision* to key persistent state by `sessionId` at all is data modeling.
  → **Cross-link:** normalization is information-hiding for data — single source of truth, no fact stored twice. When you see it, look at software-design's information-hiding concept; don't re-teach it.

## The five-tier persistence lattice (the schema, at a glance)

There is no ERD to draw because there are no tables. Instead there are **five tiers**, each with different durability, different visibility, and different write authority. Every persistent fact in this app lives in exactly one of these — or, in a handful of cases, several, which is where the modeling risk concentrates.

```
  The persistence lattice — five tiers, ranked by durability

  tier                          durability          write authority    example
  ────                          ──────────          ────────────────   ────────────────────────
  1. localStorage (browser)     until user clears   the browser        bi:mode, bi:mcp_config
     sessionStorage (browser)   until tab close     the browser        bi:insight:{id}

  2. in-memory Map (server)     until instance      the running        Map<sessionId, SessionFeed>
                                cools               request            in lib/state/insights.ts

  3. signed cookie (server →    ~10 days,           the server         bi_auth (AES-256-GCM)
     browser)                   AUTH_SECRET-rot     writes; browser    bi_session (SameSite=None)
                                invalidates all     replays

  4. dev-only file system       until you `rm`      dev server         .auth-cache.json
                                                    only               .investigation-cache.json

  5. git-committed              until a commit      you, the           eval/baseline.json
     (durable)                                       engineer           public/demo/*.json
                                                                        lib/state/demo-*.json
```

Each concept file below picks up one axis of this lattice and follows it end-to-end.

## Reading order

```
  01 → the data model and its shape             (zoom out — the whole picture)
  02 → normalization and duplication            (single source of truth)
  03 → indexing vs query patterns               (the DB analog when there's no DB)
  04 → transactions and integrity               (invariants — DB or hopeful code?)
  05 → migrations and evolution                 (how shapes change over time)
  06 → access patterns and storage choice       (does shape match access?)
  07 → data-modeling red flags — audit          (the checklist, marked)
```

Each file is a full concept walk with a load-bearing diagram, mechanics, and interview defense. The last file is the audit — the consolidated red-flag checklist marked against this specific repo.

## The one-line verdict

The shapes are **richer than you'd expect for a no-DB app** — discriminated unions, denormalized read models, base64-JSON wire formats, encrypted cookie stores — and the modeling discipline is uneven. The strong parts are the wire-format validation (`isMcpConfigOverride` rejects on every field), the session-scoped keying (`Map<sessionId, SessionFeed>` instead of module-level state), and the layered fallback chain (`in-memory → dev file → committed demo`). The weak parts are the round-trip lossiness of `insightToAnomaly` (silently drops evidence/impact/history), the two-source-of-truth risk on `Recommendation` (spec has two shapes, only one wins), and the receipts folder growing without a rotation strategy.

The audit in file 07 marks each of those against a red-flag list.
