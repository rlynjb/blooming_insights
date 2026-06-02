# blooming insights — data modeling audit (schemas yes, DB no)

> The shape question: **does the data's shape match how it's actually read and written — and can it stay correct?** Most data-modeling guides anchor on a relational schema with migrations, FKs, and indexes. This repo has none of those. What it has — and what this guide audits — is a set of TypeScript interfaces (`lib/mcp/types.ts`), runtime type guards (`lib/mcp/validate.ts`), and an UPSTREAM data model it doesn't own (the Bloomreach event schema, parsed in `lib/mcp/schema.ts`). That's the model. Treat the types as the schema, the guards as the integrity check at the boundary, and the upstream Bloomreach workspace as the source-of-truth store.

## The verdict, up front

The typed-schema work is **strong**. `lib/mcp/types.ts` carries 8 interfaces that pin every shape the four agents pass between each other — `Insight`, `Anomaly`, `Diagnosis`, `Recommendation`, `CoverageReport`, `ToolCall`, `ReasoningStep`, `Investigation`. The compiler enforces the shape across module boundaries. The runtime guards (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`) re-enforce it at the **LLM seam** — the one boundary where TypeScript can't see (the model emits JSON-as-string).

The leaks live elsewhere. The worst is documented already in `study-software-design/audit.md#information-hiding-and-leakage`: the **Insight ↔ Anomaly field-copy list** is encoded in three places (the interface itself, `anomalyToInsight` in state, `insightToAnomaly` in the agent route), and the round-trip silently drops four fields. That's a data-modeling smell — the "same fact stored twice" anti-pattern, but for derived shapes instead of stored rows.

```
  the audit at a glance

  ┌─ schema (typed shapes) ─────────────────────────┐
  │  lib/mcp/types.ts        ★ STRONG — one source  │
  │  lib/mcp/validate.ts     ★ STRONG — runtime guard│
  │  lib/mcp/schema.ts       ★ STRONG — upstream parse│
  │  lib/agents/categories.ts ★ STRONG — capability gate│
  └─────────────────────────────────────────────────┘
                       │
                       │  contrasts with…
                       ▼
  ┌─ shape leaks (same fact, two places) ──────────┐
  │  insightToAnomaly drops 4 fields silently       │  ← the worst
  │  derived fields encoded across types + derive   │
  │  Recommendation defined TWICE in the spec       │
  │  (resolved by a "use the richer one" comment)   │
  └─────────────────────────────────────────────────┘
                       │
                       │  and topics the repo doesn't yet exercise
                       ▼
  ┌─ not yet exercised ────────────────────────────┐
  │  normalization (no relational store)            │
  │  indexes vs queries (no DB queries — EQL is the upstream)│
  │  transactions (no atomic multi-write — Map.set is the write)│
  │  migrations (no schema-as-code; markdown prompts are git-versioned)│
  └─────────────────────────────────────────────────┘
```

## What "data modeling" means in this repo

The spec asks for schema shape, normalization, indexes-vs-queries, integrity, migrations, and access patterns. **Partially Case B applies here**: typed schemas exist, but the relational machinery (FKs, indexes, transactions, migrations) does not. Where the topic doesn't apply, this guide says **not yet exercised** and names what the closest cousin is — not fabrication. The honest read:

- **Schema shape** → applies fully. The 8 interfaces in `lib/mcp/types.ts` ARE the schema; this audit walks them.
- **Normalization** → not yet exercised at the persistence layer (no relational store), but the **derived-field denormalization** in `Insight` (8 optional fields computed from `Anomaly.evidence`) is the closest cousin and gets audited.
- **Indexes vs queries** → not yet exercised in this repo (no DB queries). The closest cousin is the **Bloomreach EQL recipes** in `categories.ts` (one query per category), and they get audited as upstream-store access patterns.
- **Integrity** → partially applies. There are no DB constraints (no FKs, no unique, no not-null). What stands in for them: TypeScript at compile time, the three guards in `validate.ts` at the LLM seam, and three in-memory `Map`s in `lib/state/insights.ts` that have no atomicity story at all.
- **Migrations** → not yet exercised. There's no migration tooling, no schema-as-code. The agent prompts (`lib/agents/prompts/*.md`) are the *only* versioned schema-like artifacts, and they're versioned through git like any other file.
- **Access patterns + storage choice** → applies. The store is in-memory `Map`s (per-process, lost on serverless cold start) with a JSON-file fallback in dev and committed `demo-*.json` seeds for replay. Documented in file 06.

## The schema diagram — what the model looks like

The store the repo owns (its in-memory `Map`s) holds three entities; everything else is computed shapes that cross module boundaries. Below is the entity diagram — note the direction of the dashed arrow: `Insight` is the **enriched view** of `Anomaly`, not its parent. The mapping is one-way at write-time and lossy at read-time (the leak — see file 02).

```
  the model — entities, fields, relationships

  ┌─ UPSTREAM (not owned) ─────────────────────────────────┐
  │  WorkspaceSchema   (parsed from Bloomreach MCP)         │
  │  ─────────────────                                       │
  │  projectId, projectName                                  │
  │  events: { name, properties[], eventCount }[]            │
  │  customerProperties[], catalogs[]                        │
  │  totalCustomers, totalEvents, oldestTimestamp            │
  │                          │                               │
  │                          │ schemaCapabilities()          │
  │                          ▼                               │
  │  Set<string>  (event names + "event.property" + "catalog:name")│
  └──────────────────────────┬─────────────────────────────┘
                             │ coverageFor()
                             ▼
  ┌─ OWNED (in-memory Maps in lib/state/insights.ts) ──────┐
  │                                                          │
  │  ┌─ Anomaly ────────────────┐                            │
  │  │ metric           string  │ ← FK-like into upstream    │
  │  │ scope            string[]│   event/property names     │
  │  │ change           { value, direction, baseline }       │
  │  │ severity         enum-4  │                            │
  │  │ evidence         { tool, result }[]                   │
  │  │ impact?          string  │                            │
  │  │ history?         number[]│                            │
  │  │ category?        enum-10 │ ← FK-like to CATEGORIES[]  │
  │  └────────────┬─────────────┘                            │
  │               │ anomalyToInsight()                       │
  │               │ (8 fields copied + 5 derived)            │
  │               ▼                                          │
  │  ┌─ Insight ────────────────┐                            │
  │  │ id              uuid PK  │ ← stamped at insert        │
  │  │ timestamp       ISO      │ ← stamped at insert        │
  │  │ severity, headline,                                    │
  │  │ summary, metric,                                       │
  │  │ change, scope, source                                  │
  │  │ evidence?, impact?, history?, category?                │
  │  │ ── derived (Tier 1 enrichments) ─────                  │
  │  │ revenueImpact?  { lostUsd, expectedUsd, currency }     │
  │  │ aov?            { current, prior }                     │
  │  │ funnel?         { view, cart, checkout, purchase }     │
  │  │ affectedCustomers?  number  (denormalized from Diagnosis)│
  │  │ history?        number[]                               │
  │  │ downstreamReady? { diagnosis, recommendations }        │
  │  └────────────┬─────────────┘                            │
  │               │ stored by Insight.id                     │
  │               ▼                                          │
  │  insights:        Map<id, Insight>                       │
  │  anomalies:       Map<id, Anomaly>   ← parallel "table"  │
  │  investigations:  Map<insightId, Investigation>          │
  └────────────────────────────────────────────────────────┘
                             ▲
                             │ insightToAnomaly()
                             │ (copies 4 of 8, DROPS 4)  ★ THE LEAK
                             │
  ┌─ ROUTE BOUNDARY ───────────────────────────────────────┐
  │  GET /api/agent?insight=<Insight JSON>                  │
  │  the browser hands the route an Insight; the route      │
  │  converts back to Anomaly to feed the diagnostic agent  │
  └────────────────────────────────────────────────────────┘
```

The **Insight ↔ Anomaly leak** (`insightToAnomaly` drops `evidence`, `impact`, `history`, `category` while `anomalyToInsight` copies all of them) is the worst data-modeling smell in the repo. The software-design audit already flagged it as an information leak; file 02 here re-frames it as a normalization smell — same fact in two places, no single source of truth for the field list.

## How to read this guide

Seven files, dependency order:

```
  .aipe/study-data-modeling/
    README.md                                 (you are here — the model + the leak)
    01-the-data-model-and-its-shape.md        the 8 interfaces, drawn
    02-normalization-and-duplication.md       the Insight↔Anomaly leak, re-framed
    03-indexing-vs-query-patterns.md          not yet exercised + EQL recipes as the cousin
    04-transactions-and-integrity.md          the guards do what FKs can't (LLM seam integrity)
    05-migrations-and-evolution.md            not yet exercised + how prompts evolve
    06-access-patterns-and-storage-choice.md  in-memory Maps + JSON fallback + demo seeds
    07-data-modeling-red-flags-audit.md       capstone — checklist scored against this repo
```

## The top three calls, ranked

1. **Retire the Insight↔Anomaly round-trip.** The leak is the single worst data-modeling problem in this repo. The fix (move `insightToAnomaly` next to `anomalyToInsight`, write a round-trip test, OR fix the wire format to accept just the id) is mechanical. File 02 walks both moves. Same finding the software-design audit names — don't duplicate the analysis; do the work.

2. **Promote the derived-field denormalization to a single computed view.** `deriveInsightFields()` in `lib/insights/derive.ts` computes `revenueImpact` from `Anomaly.evidence` at write time; the `Insight` interface declares ~8 optional Tier 1 fields the agents may also emit; the UI falls back when fields are absent. This is denormalization-without-an-owner — the value lives in three places (evidence, derived field, agent-emitted field) and the precedence rules are implicit. File 02 names the rule.

3. **Decide what "integrity" means at the in-memory store.** `putInsights()` clears both `insights` and `anomalies` Maps on every briefing run; there is no atomicity around the two clears or the inserts. In a real DB this would be a transaction. The current code is correct *because* it's single-process and synchronous — but the moment two routes call `putInsights` concurrently (or the runtime becomes truly multi-worker), the integrity story collapses. File 04 names the invariant and the move.

## What this guide does NOT find

This repo has **no relational store**. No Postgres, no SQLite, no schema files, no migrations, no FKs, no indexes, no transactions, no rollback strategy. The honest framing: the data-modeling discipline that ships with relational stores hasn't been exercised here. When the topic asks "what indexes support which query" or "how are migrations rolled out under live data," the answer is **not yet exercised** — and file 06 names what the buildable target would be (the obvious next move is a single-table Postgres for `insights`/`investigations` so warm-instance memory loss stops being a constraint).
