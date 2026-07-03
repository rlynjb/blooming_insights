# Data modeling — the audit at a glance

**Type:** Audit summary · verdict-first · read this first.

## The one-line verdict

blooming_insights has **no operational database.** Persistent data is JSON files on disk (committed demo snapshots + gitignored dev caches + eval receipts) plus per-request in-memory maps. That's the right call for a demo-first Next.js app that mostly re-derives from Bloomreach on every run — but it means most classical data-modeling concerns (indexes, transactions, migrations) are **not exercised.** The interesting data-modeling story is elsewhere: **denormalized JSON receipts** in `eval/`, an **in-memory session-partitioned Map** in `lib/state/`, and **capability-marker optional fields** on the receipt shape that carry which observability layer produced them.

## Where persistent data actually lives

The whole persistence surface in one picture — nothing is hidden behind an ORM, so this diagram *is* the schema.

```
  blooming_insights — every place data outlives one function call

  ┌─ Runtime state (dies with the process) ───────────────────────────┐
  │  lib/state/insights.ts                                            │
  │    Map<sessionId, { insights, investigations, anomalies }>        │
  │  lib/mcp/schema.ts   module-level `cached: WorkspaceSchema | null`│
  │  lib/agents/budget.ts  `new BudgetTracker()` per-investigation    │
  └────────────────────────────┬──────────────────────────────────────┘
                               │  serialize
  ┌─ Dev-only file caches (gitignored) ───▼────────────────────────────┐
  │  .investigation-cache.json    { insightId → AgentEvent[] }        │
  │  .auth-cache.json             OAuth tokens (dev only, plaintext)   │
  └────────────────────────────┬──────────────────────────────────────┘
                               │  once — "capture this as demo"
  ┌─ Committed reference JSON (checked in) ▼──────────────────────────┐
  │  lib/state/demo-insights.json         (~665 lines)                │
  │  lib/state/demo-investigations.json   (~3487 lines)               │
  │  eval/goldens/*.ts                    (10 GoldenCase records)     │
  │  eval/baseline.json                   (regression-gate reference) │
  └────────────────────────────┬──────────────────────────────────────┘
                               │  eval run produces
  ┌─ Ephemeral run artifacts (gitignored) ▼───────────────────────────┐
  │  eval/receipts/*.json          (10 · ~35KB each, per run)         │
  │  eval/load-receipts/load-*.json                                   │
  │  eval/calibration/worksheet-*.json + agreement-*.json             │
  └───────────────────────────────────────────────────────────────────┘
```

Notice: no rows, no tables, no indexes, no foreign keys, no migrations directory. That's the finding — this repo is a **file-oriented store** with a **denormalized document per case**, and its data-modeling weight sits in the *shape* of those documents (`Insight`, `Receipt`) not in relational structure.

## The three highest-cost findings

Ranked worst-first. The full walkthrough for each is in the linked concept file.

### 1. `Insight` bakes 4+ derived facts alongside the source of truth — no invalidation story

**Where:** `lib/mcp/types.ts:36-62`, populated at `lib/state/insights.ts:25-45` via `deriveInsightFields(a)` and the `...deriveInsightFields(a)` spread.

`Insight` is the union of the raw `Anomaly` fields (`metric`, `scope`, `change`, `severity`, `evidence`, `impact`) *plus* five derived enrichments spliced in at construction time: `revenueImpact`, `aov`, `funnel`, `affectedCustomers`, `downstreamReady`. Later, `Diagnosis.affectedCustomers.count` is **also denormalized** into `Insight.affectedCustomers` as a second write path. If the underlying evidence changes, nothing recomputes. This is the DB-normalization anti-pattern rendered in TypeScript: **the same fact editable in two places, with no trigger to keep them in sync.** Cost is currently zero because the pipeline is one-shot (compute → serialize → done), but it's a debt trap the moment anything mutates. → see `02-normalization-and-duplication.md`.

### 2. Session-partitioned in-memory Map is the entire "database" — and it silently drops on cold start

**Where:** `lib/state/insights.ts:7-23` — `const state = new Map<string, SessionFeed>()`.

The feed lives in a module-level `Map` keyed by session id, with each session getting its own `{ insights, investigations, anomalies }` sub-maps. The comment on line 6-11 is honest about the *why*: warm Vercel instances would otherwise bleed sessions together. But the shape has zero durability: a redeploy, a cold start, or a warm instance being reaped drops every in-flight investigation. There's no write-through to disk in production (dev writes to `.investigation-cache.json` and prod skips it — `investigations.ts:7`). The recovery story is "re-run the briefing," which the streaming UI is architected around. Honest, but worth naming: **the access pattern is write-once-per-request-read-many-times-per-request, and the store matches that pattern, but doesn't survive one process boundary.** → see `06-access-patterns-and-storage-choice.md`.

### 3. Receipts are ~35KB denormalized blobs with **optional fields as capability signals** — a query pattern the file layout can't answer

**Where:** `eval/run.eval.ts:341-395` (receipt construction), `eval/receipts/*.json` (10 per run × ~35KB), `eval/baseline.eval.ts:26-39` (the aggregation shape that reads them).

Each receipt is a self-contained JSON blob per (case × run): golden metadata + duration breakdown + model + anomaly + full tool-call trace × 2 + usage/cost × 2 + budget snapshot + diagnosis + judgment × 2. Every "did the observability wiring turn on for this run?" question is encoded as **optional presence:** `usage?` (Phase-2 tokens+cost), `budget?` (Phase-3 ceiling), `faultTotals?` (fault injection). This is legitimate document-store design — a Mongo record would look the same — but the *query pattern is relational:* `baseline.eval.ts` and `gate.eval.ts` do `readdirSync + filter-by-runId-suffix + full-file-parse × N` to aggregate per-dimension pass rates. That's a table scan against a filesystem, done in Node process memory, every gate run. It works at 10 cases; it doesn't at 200. → see `03-indexing-vs-query-patterns.md`.

## One-line verdict per concept

| File | Verdict |
|---|---|
| `01-the-data-model-and-its-shape.md` | Entities are TypeScript interfaces in `lib/mcp/types.ts`; no relational schema. 7 core entities + 4 eval-subsystem shapes. |
| `02-normalization-and-duplication.md` | Two live duplications: `Insight` bakes derived fields + copies `Diagnosis.affectedCustomers.count`. Zero-cost today, debt trap tomorrow. |
| `03-indexing-vs-query-patterns.md` | No indexes exist (no DB). Filesystem is scanned via `readdirSync + endsWith(runId)` — linear per run. Fine at 10, doesn't scale. |
| `04-transactions-and-integrity.md` | Integrity is enforced entirely in TypeScript (`validate.ts`, discriminated unions). No transactional writes; two multi-step operations that would need atomicity are the `saveInvestigation` file-write and the eval receipt write. |
| `05-migrations-and-evolution.md` | No migrations directory. Schema evolves by adding optional fields (`usage?`, `budget?`, `faultTotals?`) — the "backward-compatible additive change" discipline is real and it lives in TypeScript types. |
| `06-access-patterns-and-storage-choice.md` | Access shape is write-once-read-few-times per session; a session-Map + JSON files fit. The eval receipt storage is document-shaped but queried relationally. |
| `07-data-modeling-red-flags-audit.md` | Consolidated checklist. 3 red flags fire; 4 are N/A because the substrate is missing. |

## Read the file that fires the finding

Nothing in this guide is generic. Every claim is bound to a file path + line range in **blooming_insights**. Open the file next to the concept and read them side by side — that's the point.

## See also

- `01-the-data-model-and-its-shape.md` — the entity map.
- `02-normalization-and-duplication.md` — the `Insight` denormalization walkthrough.
- `03-indexing-vs-query-patterns.md` — the eval-receipt aggregation query.
- `06-access-patterns-and-storage-choice.md` — why no database is the right call *and* the honest cost of that call.
- `07-data-modeling-red-flags-audit.md` — the capstone checklist.
