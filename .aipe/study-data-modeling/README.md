# blooming insights — data modeling audit (typed schemas + an in-process synthetic fixture)

> The shape question: **does the data's shape match how it's actually read and written — and can it stay correct?** Most data-modeling guides anchor on a relational schema with migrations, FKs, and indexes. This repo's data-modeling work has two layers today (2026-06-19): (1) the TypeScript interfaces in `lib/mcp/types.ts` are the contract every agent crosses — schemas-as-types, integrity-by-runtime-guard at the LLM seam. (2) The `lib/data-source/synthetic-data-source.ts` module is an **in-process synthetic fixture** — a `SyntheticDataSource` class that implements the same `DataSource` interface as `BloomreachDataSource` and returns hand-authored const literals through the standard tool-result envelope. The 2026-06-16 second persistence layer (the Olist SQLite warehouse with FKs, indexes, NOT NULL, WAL) was removed in PR #8 (commit 62c24d7) along with the eval pipeline that read it.

## The verdict, up front

The typed-schema work is **strong**. `lib/mcp/types.ts` carries 8 interfaces that pin every shape the four agents pass between each other — `Insight`, `Anomaly`, `Diagnosis`, `Recommendation`, `CoverageReport`, `ToolCall`, `ReasoningStep`, `Investigation`. The compiler enforces the shape across module boundaries. The runtime guards (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`) re-enforce it at the **LLM seam** — the one boundary where TypeScript can't see (the model emits JSON-as-string).

The **in-process synthetic fixture** is the new second domain. `SyntheticDataSource` implements the same `DataSource.callTool(name, args)` / `listTools()` surface as `BloomreachDataSource`, dispatches on tool name in a switch, and returns const literals through the standard `{ structuredContent, content }` result envelope. The agent loop above this seam cannot tell the difference between this and a live Bloomreach call. The data is deterministic by construction (every payload is source code, no PRNG, no `Date.now()`), but **no contract test asserts this** — the determinism is an emergent property of the const literals, not a stated invariant. File 11 walks this as a data-modeling-for-test pattern.

The **previous top finding (`price_brl` unit-in-name failure) is resolved-by-deletion**. The Olist SQLite schema is gone; no `_brl` column exists in the current codebase. The 2026-06-16 audit's #1 CRITICAL has been removed from the active ranking (file 07 walks the rerank). File 10 keeps the historical write-up as a pattern artifact with a RETIRED banner.

The remaining leaks are at the agent contract. The **Insight↔Anomaly field-copy** finding is half-fixed in code (`insightToAnomaly` is colocated with `anomalyToInsight` in `lib/state/insights.ts`, with a doc comment naming the drop and a round-trip test in `test/state/insights.test.ts`). The wire format still ships the full `Insight` JSON via `?insight=<JSON>` and the route still calls `insightToAnomaly` to project it back to a 4-field `Anomaly` for the diagnostic agent — so the *cost* of the leak (one extra tool call per investigation) is still real. File 02 carries the updated story; file 07 puts this at the top of the audit.

```
  the audit at a glance (2026-06-19)

  ┌─ typed schema (the agent contract) ─────────────┐
  │  lib/mcp/types.ts        ★ STRONG — one source  │
  │  lib/mcp/validate.ts     ★ STRONG — runtime guard│
  │  lib/mcp/schema.ts       ★ STRONG — both bootstraps│
  │  lib/agents/categories.ts ★ STRONG — capability gate│
  └─────────────────────────────────────────────────┘
                       │
                       │  now sits next to…
                       ▼
  ┌─ in-process synthetic fixture (file 11) ────────┐
  │  lib/data-source/synthetic-data-source.ts        │
  │  SyntheticDataSource implements DataSource       │
  │  10 events: purchase / view_item / session_start │
  │  / cart_update / checkout / search / email_open  │
  │  / voucher_redeemed / return / payment_failure   │
  │  757,710 events · 126,420 customers              │
  │  data horizon: 2025-12-01 → 2026-06-01 (182 d)   │
  │  ★ deterministic by construction (no PRNG)       │
  │  ★ NO contract test asserting that (audit #7)    │
  └─────────────────────────────────────────────────┘
                       │
                       │  the original leak, now partly retired
                       ▼
  ┌─ shape leaks (same fact, two places) ──────────┐
  │  insightToAnomaly now colocated + round-trip    │ ← FIXED in code
  │    test in test/state/insights.test.ts          │
  │  wire-format-as-state still drops 4 fields      │ ← TOP FINDING
  │  Recommendation defined TWICE in the spec       │
  │  (resolved by a "use the richer one" comment)   │
  └─────────────────────────────────────────────────┘
                       │
                       │  topics back to "not yet exercised"
                       ▼
  ┌─ honest gaps (Olist removal returned these) ───┐
  │  DB constraints (FK, NOT NULL)                  │
  │  Migration tooling                              │
  │  Index-vs-query layer                           │
  │  Transactions, WAL durability                   │
  │  Multi-writer concurrency on shared rows        │
  │  Durable storage for UI state                   │
  └─────────────────────────────────────────────────┘
```

## What "data modeling" means in this repo

The spec asks for schema shape, normalization, indexes-vs-queries, integrity, migrations, and access patterns. **As of 2026-06-19, the relational topics are back to "not yet exercised"** — they activated briefly with the Phase 2 Olist DB (2026-06-16) and deactivated when PR #8 removed it (2026-06-18). The honest read:

- **Schema shape** → applies for the agent contract (the 8 interfaces). The second derivation of `WorkspaceSchema` is now the synthetic const literal, not the Olist SQLite schema. File 01 walks the contract; file 11 walks the synthetic fixture.
- **Normalization** → applies in the typed-shape sense. The Insight↔Anomaly field-copy that file 02 audits is the story. No relational normalization to contrast with anymore (Olist is gone).
- **Indexes vs queries** → not exercised. No SQL. The Bloomreach EQL recipes are still there as the cousin pattern for the rate-limited upstream.
- **Integrity** → applies at the typed-shape level: TypeScript at module boundaries + three guards in `validate.ts` at the LLM seam + per-session sub-maps in `lib/state/insights.ts`. No DB-level FK / NOT NULL / pragma story.
- **Migrations** → not exercised. The typed-shape evolution under git is still the only story (file 05).
- **Access patterns + storage choice** → applies. Three layers: per-session in-memory `Map`s for live UI, committed `demo-*.json` for the demo path, in-process synthetic fixture for the live-synthetic mode. File 06 walks the three.
- **Determinism in test data** → applies, in a new way. The synthetic fixture is deterministic by construction (const literals); no PRNG, no `Date.now()`, no seed needed. The contract isn't asserted in code — that's audit finding #7.

## The schema diagram — what the model looks like

Two persistence layers sit side by side. The **agent contract** layer (`lib/mcp/types.ts` interfaces, in-memory per-session `Map`s) holds the live UI state. The **in-process synthetic fixture** layer (`SyntheticDataSource`, const literals) substitutes for the Bloomreach upstream when the user picks the live-synthetic mode. The Bloomreach upstream itself remains read-only at this layer; the synthetic adapter mimics its tool surface.

The entity diagram below shows both, with the `WorkspaceSchema` interface as the duck-typed bridge — same shape, two derivations (`bootstrapSchema(BloomreachDataSource)` and the `syntheticWorkspaceSchema` const). Note the direction of the dashed arrow on the agent side: `Insight` is the **enriched view** of `Anomaly`, not its parent. The mapping is one-way at write-time and lossy at read-time (the wire-format leak — see file 02).

```
  the model — both layers, side by side

  ┌─ AGENT CONTRACT (typed interfaces; in-memory) ───────────────┐
  │                                                                │
  │  WorkspaceSchema  (one interface, two derivations)             │
  │   ├ bootstrapSchema(BloomreachDataSource)  from MCP introspection│
  │   └ syntheticWorkspaceSchema               top-level const literal│
  │                          │                                     │
  │                          │ schemaCapabilities() / dataHorizon  │
  │                          ▼                                     │
  │  ┌─ Anomaly ────┐ ──anomalyToInsight──► ┌─ Insight ────────┐  │
  │  │ metric       │  8 copied + 5 derived │ id (uuid PK)     │  │
  │  │ scope[]      │ ◄─insightToAnomaly──  │ timestamp        │  │
  │  │ change       │  4 copied, 4 DROPPED  │ + Anomaly fields │  │
  │  │ severity     │  (now colocated +     │ + 6 derived T1   │  │
  │  │ evidence     │   round-trip tested)  │   enrichments    │  │
  │  │ impact?      │                       └────────┬─────────┘  │
  │  │ history?     │                                │            │
  │  │ category?    │                                ▼            │
  │  └──────────────┘            Map<sessionId, SessionFeed>      │
  │                                  ├ insights:      Map<id, I>  │
  │                                  ├ anomalies:     Map<id, A>  │
  │                                  └ investigations:Map<iid, V> │
  │                              (session-scoped — multi-user)    │
  └──────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ wire format ?insight=<JSON>
                                  │ still drops 4 fields (file 02)
                                  │
  ┌─ IN-PROCESS SYNTHETIC FIXTURE (lib/data-source/) ────────────┐
  │                                                                │
  │  class SyntheticDataSource implements DataSource {            │
  │    callTool(name, args) — switch over the 30+ tool names      │
  │    listTools()          — derived from MCP `tools` module     │
  │  }                                                             │
  │                                                                │
  │  const literals returned through ok({ structuredContent,...}):│
  │    analyticsResult  ← shared by execute_analytics +           │
  │                       execute_analytics_eql                    │
  │    customers, segments, scenarios, campaigns, catalogItems    │
  │    ...                                                         │
  │                                                                │
  │  ★ data IS the source code — no disk, no DB, no PRNG          │
  │  ★ used by live-synthetic mode in makeDataSource()            │
  │                                                                │
  │  determinism contract: not asserted in code today              │
  │    (audit #7; file 11 walks the pattern + the fix)            │
  └──────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ DataSource.callTool() — agents
                                  │ cannot distinguish this from
                                  │ a live Bloomreach call
                                  │
  ┌─ COMMITTED DEMO SEEDS (lib/state/) ──────────────────────────┐
  │  demo-insights.json         ← 12 insights with full context  │
  │  demo-investigations.json   ← matching investigations         │
  │  ★ git-tracked, durable forever                              │
  │  ★ replayed verbatim in demo mode (no agent run)             │
  └──────────────────────────────────────────────────────────────┘
```

The original **Insight ↔ Anomaly leak** has been **partially retired in code**: `insightToAnomaly` is now colocated with `anomalyToInsight` in `lib/state/insights.ts` (L25–L55), a doc comment names the four fields it deliberately drops (`evidence`, `impact`, `history`, `category`), and the round-trip is tested in `test/state/insights.test.ts`. The drop itself is still real — it's now an explicit design choice, not an oversight — and the same wire-format path in the route still relies on it. File 02 carries the updated framing: same shape, two layers of duplication, one of them now documented and tested.

## How to read this guide

Eleven files, dependency order. Three of them carry RETIRED banners — the patterns they teach are still real (the body of file 09's determinism story is the closest cousin of file 11), but the code anchors they cite are gone:

```
  .aipe/study-data-modeling/
    README.md                                 (you are here — both layers + the synthetic fixture)
    01-the-data-model-and-its-shape.md        the 8 interfaces + WorkspaceSchema dual derivation
    02-normalization-and-duplication.md       the Insight↔Anomaly story (now partly fixed)
    03-indexing-vs-query-patterns.md          (Bloomreach EQL recipes only; no SQL today)
    04-transactions-and-integrity.md          session-scoped Maps + LLM-seam guards
    05-migrations-and-evolution.md            git-evolves-types; the spec ↔ code drift
    06-access-patterns-and-storage-choice.md  three storage layers (Maps + seed + synthetic)
    07-data-modeling-red-flags-audit.md       capstone — re-ranked 2026-06-19
    08-the-olist-relational-schema.md         RETIRED — historical (Olist removed PR #8)
    09-deterministic-synthetic-data.md        RETIRED — pattern lives on in file 11
    10-units-in-column-names.md               RETIRED — resolved-by-deletion (no _brl columns)
    11-in-process-synthetic-fixture.md        the new SyntheticDataSource concept (NEW 2026-06-19)
```

## The top three calls, ranked

1. **Switch the wire format from `?insight=<JSON>` to `?id=<insightId>`.** The original "field-copy in 3 files" finding is half-fixed: the conversion is colocated, documented, and tested. But the wire format still SHIPS the full Insight JSON in the URL and the route still drops 4 fields converting it back. The diagnostic agent then has to re-discover the dropped evidence with a fresh tool call against a 1 req/s rate limit. Switching to `?id=<insightId>` plus a per-session lookup retires the drop entirely; the session-scoped Map already makes the lookup safe. File 02 walks the move.

2. **Add a determinism contract to `SyntheticDataSource`.** The synthetic adapter is the only fake-data surface in the repo, and the agent loop / evals / UI all depend on it returning identical bytes call after call. Today nothing asserts that. Add a doc comment naming the contract ("no PRNG, no `Date.now()`") + a byte-equality test in `test/data-source/synthetic-data-source.test.ts` that calls `execute_analytics` twice and compares the JSON. ~30 min of work; catches the day someone introduces non-determinism. File 11 walks the pattern.

3. **Resolve the dual-shape `Diagnosis`.** `lib/mcp/types.ts` defines `Diagnosis` (L95–L104) with rich `hypothesesConsidered: { hypothesis, supported, reasoning }[]`. The `Investigation.diagnosis` inline shape (L132–L141) uses `hypothesesConsidered: string[]`. Same name, different schema. Either unify (`Investigation.diagnosis: Diagnosis`, accept the breaking change in stored snapshots) or rename + project (`DiagnosisSummary` + `summarizeDiagnosis()`). File 02 + file 05 cover both options.

## What this guide does NOT find

This repo's **runtime UI state still has no relational store** — the per-session `Map`s in `lib/state/insights.ts` are still the briefing store, lost on Vercel cold start, bridged by the wire-format-as-state pattern (file 06). The buildable target named in the 2026-06-01 version — a Postgres/SQLite for `insights`/`investigations` — has never shipped for UI state. (It briefly shipped for synthetic analytics in Phase 2, then got removed.) The runtime gap remains.

The synthetic adapter also doesn't exercise **schema evolution** — every change to `syntheticWorkspaceSchema` is a code edit + a process restart. That's fine for fixture data, but it means "how do you evolve a schema while the live data is also evolving" is still not a question this codebase has answered. When that becomes a real requirement (e.g. if the UI starts persisting briefings to a real DB), the answer would be Drizzle + `drizzle/` migration files, exactly the pattern AdvntrCue uses.

---
Updated: 2026-06-19 — Olist removal landed in PR #8; the SQLite second domain is gone; second derivation of `WorkspaceSchema` swapped to the in-process synthetic fixture; `price_brl` resolved-by-deletion; top-3 reranked; file count 10 → 11 (added file 11 for the new pattern).
Updated: 2026-06-16 — added the Olist relational layer + units-in-name finding + leak fix; 7 → 10 files.
