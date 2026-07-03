# Migrations and evolution

**Industry term:** Backward-compatible schema evolution / additive-optional migration · **Type:** Industry-standard concept, applied here to TypeScript types + committed JSON snapshots (no DDL, no migration tool).

## Zoom out, then zoom in

**Zoom out — where "migrations" happen.** blooming_insights has no `/migrations` directory, no schema versioning tool, no `ALTER TABLE`. Its persisted data is TypeScript-typed JSON. When the shape changes, the migration story is: **add optional fields to the interface, keep old snapshots valid, let the UI degrade gracefully when a field is absent.**

```
  "migrations" in blooming_insights — where a shape change ripples

  ┌─ single source of type ─────────────────────────────────────┐
  │  lib/mcp/types.ts    (Insight, Anomaly, Diagnosis, ...)     │
  │  eval/goldens/types.ts    (GoldenCase, SignalClass)         │
  └────────────────────────┬────────────────────────────────────┘
                           │  add optional field
                           ▼
  ┌─ producers ─────────────────────────────────────────────────┐
  │  agents emit new field  · new code populates it              │
  │  old code / older run    · new field is undefined            │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ persisted data ────────▼───────────────────────────────────┐
  │  ★ THIS CONCEPT'S PROOF ★                                   │
  │  · demo-insights.json / demo-investigations.json (committed)│
  │  · eval/receipts/*.json (varies across run generations)     │
  │  · eval/baseline.json (committed reference)                 │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ consumers ─────────────▼───────────────────────────────────┐
  │  UI reads Insight — falls back when optional field absent    │
  │  eval/gate.eval.ts reads baseline — tolerates missing dims  │
  │  eval/report.eval.ts reads Receipt.usage (optional!)         │
  └─────────────────────────────────────────────────────────────┘
```

**Zoom in — the pattern.** The migration discipline is *"never make an old snapshot invalid."* Concretely: new fields are added as `?` (optional); no fields are ever renamed or removed; literal-union types get their new member appended, not their old one replaced. Every "capability signal" on the `Receipt` (`usage?`, `budget?`, `faultTotals?`) is a version marker in disguise — its presence tells the reader "this receipt was produced by a version of the code that had this observability layer wired."

## Structure pass

### Layers of evolution

```
  Types of shape change — from cheapest to most disruptive

  ┌─ Additive-optional (routine, safe) ──────────────────────────┐
  │  add `newField?: T` — old snapshots stay valid                │
  │  · Insight.revenueImpact, .aov, .funnel, .history, .category  │
  │  · Diagnosis.confidence, .timeSeries                          │
  │  · Recommendation.effort, .timeToSetUpMinutes, ...            │
  │  · Receipt.usage, .budget, .faultTotals (capability markers)  │
  └────────────────────────┬─────────────────────────────────────┘
                           │
  ┌─ Additive-required (needs a backfill or a default) ──────────┐
  │  add `newField: T` — old snapshots would be INVALID           │
  │  · not used in this repo (would break older run receipts)     │
  └────────────────────────┬─────────────────────────────────────┘
                           │
  ┌─ Widening (add a variant to a union) ────────────────────────┐
  │  add member to literal union — safe if consumers handle DU   │
  │  · CategoryId currently 10 members; adding an 11th is safe    │
  │    IF every switch/if-chain on CategoryId is exhaustive       │
  └────────────────────────┬─────────────────────────────────────┘
                           │
  ┌─ Narrowing (change a required field's shape) ────────────────┐
  │  breaking — old snapshots don't match, no backfill possible   │
  │  · Recommendation.estimatedImpact went string → union of      │
  │    string | { range, rangeUsd?, assumption } — handled by     │
  │    keeping BOTH shapes valid (see validate.ts:46-48)          │
  └──────────────────────────────────────────────────────────────┘
```

### One axis: **can the old shape still be read?**

Trace it across every persisted store:

```
  "can I still read data written by yesterday's code?" — the discipline

  demo snapshots     → yes, always. Older committed JSON must render
                       identically. Optional-field-as-migration keeps this.

  eval receipts      → yes. `Receipt.usage?` present in Phase-2+ runs,
                       absent in pre-Phase-2. `Receipt.budget?` similar
                       (Phase-3). Readers `usage?.diagnose` gracefully.

  eval baseline      → yes. baseline.json has one committed shape;
                       when new dimensions are added to a rubric,
                       gate.eval.ts uses `?? 0` for missing dims
                       (`b.perDimensionPassRate[dim] ?? 0`).

  live in-memory     → not persistent — the question doesn't apply.
```

### Seams — where evolution enters

- **`lib/mcp/types.ts` first-add of `?`** — every time a new optional field is added, the *existence* of previously written data forces the shape to stay backward-compatible. This is a real schema-evolution seam, just enforced by convention (and by 144 tests that read the committed demo).
- **`lib/mcp/validate.ts:46-48` — the `impactOk` check.** This is where a *widening* migration was handled — `estimatedImpact` used to be a string, now it's a string-or-object union, and both pass validation.

## How it works

### Move 1 — the mental model

If you've ever added a nullable column to a Postgres table, you already know this trick. Adding `newColumn INT NULL` doesn't break existing rows (they get NULL) and doesn't break existing SELECTs (they don't mention the column). New writers can populate it; new readers can use it; nothing else changes. The migration is *forward-only* and *cheap*.

blooming_insights runs the same play with TypeScript optional fields:

```
  Additive-optional migration — the pattern

     types.ts:
     ┌─────────────────────────────┐
     │ interface Insight {         │
     │   ...existing fields        │
     │   newField?: NewType;   ◄── added, marked optional
     │ }                           │
     └─────────────────────────────┘
              │
              ▼
     producers:
        old code:  doesn't set newField → undefined       ← still valid
        new code:  sets newField        → populated       ← works

     consumers:
        old code:  doesn't read newField                  ← unaffected
        new code:  reads insight.newField (may be undef)  ← handle fallback
```

Zero coordination cost across producers. The catch is *conservation of typing*: the field is optional forever, so every consumer that reads it must handle `undefined`. The type system enforces that — you can't dereference `insight.newField.someProperty` without narrowing.

### Move 2 — three migrations, walked

Each is a real change that shipped in the current shape of this repo.

#### Migration A — `Insight` gained business-owner enrichments

**File:** `lib/mcp/types.ts` (lines 55-62)

```typescript
// ── business-owner enrichments (Tier 1). All optional + derived from the
//    existing evidence, so older snapshots still validate and render. ──
revenueImpact?: { lostUsd: number; expectedUsd: number; currency: 'USD' };
aov?: { current: number; prior: number };
funnel?: { view: number; cart: number; checkout: number; purchase: number };
affectedCustomers?: number;
history?: number[];
downstreamReady?: { diagnosis: boolean; recommendations: number };
category?: CategoryId;
```

The comment on line 54-55 is the migration doc: *"All optional + derived from the existing evidence, so older snapshots still validate and render."* This is the pattern applied verbatim:

- old committed `demo-insights.json` (any version) has no `revenueImpact` → the type still validates because the field is `?`.
- `deriveInsightFields` at `lib/insights/derive.ts:27-38` populates `revenueImpact` when it can (revenue metrics with a `current`/`prior` in evidence and a `down` direction); returns empty otherwise. New code that calls it on old anomalies works fine.
- UI consumers that read `insight.revenueImpact` must handle `undefined` — TypeScript enforces this.

**What breaks if a field is added *without* the `?`:** every existing committed snapshot fails validation on startup; the demo mode is broken until every JSON file is manually backfilled or edited. This is the DB migration equivalent of `ALTER TABLE ADD COLUMN NOT NULL` without a default — the classic downtime-inducing move.

#### Migration B — `estimatedImpact` widened from string to union

**File:** `lib/mcp/types.ts` (lines 108-110) + `lib/mcp/validate.ts` (lines 46-48)

The type is now a union — string (legacy) OR a richer shape:

```typescript
// types.ts:108-110
export type EstimatedImpact =
  | string
  | { range: string; rangeUsd?: { low: number; high: number }; assumption: string };
```

The validator accepts both:

```typescript
// validate.ts:46-48
const impactOk =
  typeof x.estimatedImpact === 'string' ||
  (!!x.estimatedImpact && typeof x.estimatedImpact === 'object' && typeof x.estimatedImpact.range === 'string');
```

And the read path handles both — `impactRange` at `lib/insights/derive.ts:4-6`:

```typescript
export function impactRange(e: EstimatedImpact): string {
  return typeof e === 'string' ? e : e.range;
}
```

This is a **narrowing-to-widening migration**: the shape got richer, but the old shape stays valid forever. Three consequences:

1. The validator accepts both, so every recommendation from every era passes.
2. Reads use a type guard (`typeof e === 'string'`) to fork on the shape.
3. The type is now stuck as a union — you can't "clean up" by dropping the string variant without invalidating old committed snapshots.

**What breaks if you drop the string variant:** every committed demo-investigation from before the widening fails validation, and every old test fixture breaks. In practice, this migration is one-way — the string case becomes permanent tech debt.

#### Migration C — `Receipt.usage` and `Receipt.budget` as capability signals

**File:** the anonymous receipt shape in `eval/run.eval.ts:341-395` + reader at `eval/report.eval.ts:39-44`

```typescript
// report.eval.ts:39-44 — the reader's declared shape
usage?: {
  diagnose?: UsageRow;
  recommend?: UsageRow;
};
```

The `?` on both levels is doing work: `usage?` means "this receipt might be from before Phase-2 (no usage observability)"; `diagnose?` means "even if usage is present, one of the two agent phases might have failed to report." The reader (`eval/report.eval.ts`) checks for presence at every level:

```typescript
// paraphrased read pattern from report.eval.ts
const u = receipt.usage?.diagnose;
if (u) {
  // safely dereference u.inputTokens, u.costUsd, ...
}
```

This is the **capability-signal pattern**: an optional field's *presence* tells the reader which era of the code produced this record. It's a version marker without a version number.

**Three signals like this in the receipt:**
- `usage?` — Phase-2 (observability wiring).
- `budget?` — Phase-3 (per-investigation ceiling).
- `faultTotals?` on load receipts — fault-injection era.

**What breaks if you make one of these required:** every receipt from before that phase fails validation. Regression gate breaks. Old baseline can't be read. This is why they stay optional.

#### Move 2 variant — the load-bearing skeleton of "safe schema evolution"

Three rules. Each one, if broken, forces a re-write of every persisted snapshot.

1. **Never remove or rename a field.** Old snapshots have the old name; removing it makes them invalid. Renaming is remove-plus-add — same problem.

2. **Add new fields as optional first.** If you need required-ness later, add optional, backfill every existing store, *then* change the type. Blooming_insights doesn't currently do the second step — everything stays optional forever, which is the honest cost of not having a migration tool.

3. **Widen unions instead of narrowing.** Add a variant to `Severity` (add "urgent" as a new member)? Safe. Remove one? Breaking — old snapshots referencing the removed member fail. Same for `BloomreachFeature`, `CategoryId`, `SignalClass`.

Drop rule 1 and you get "why doesn't the demo load?" bugs on git pull. Drop rule 2 and your CI breaks on every add. Drop rule 3 and older evaluation runs stop parsing.

### Move 3 — the principle

**When the schema evolves without a tool, the type file *is* the migration log — read its git history.** Every diff that adds a `?:` is a forward-compatible migration; every diff that changes a required field's type is a breaking change that better be backed by a backfill of every store. blooming_insights lives at the "additive-only" discipline: it never makes an old snapshot invalid, which means it never needs a migration tool. The tradeoff is the optional-field accumulation — the shape gets slowly polluted with fields that are optional-forever. That's the debt you pay to avoid the migration tool. The rule you take home: **schema evolution is a discipline before it's a tool; the tool just enforces the discipline at scale.** Below the "scale" threshold, additive-optional-only + honest type comments is enough.

## Primary diagram

The whole migration story in one frame — every persisted store, every evolution rule, every capability signal.

```
  blooming_insights — schema evolution recap

  ┌─ persisted stores (must stay readable) ─────────────────────┐
  │  · demo-insights.json                                        │
  │  · demo-investigations.json                                  │
  │  · eval/goldens/*.ts   (source, not persisted, but committed)│
  │  · eval/baseline.json                                        │
  │  · eval/receipts/*.json (per run — see capability signals)   │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ evolution discipline (enforced by convention + TS) ────────┐
  │                                                              │
  │  add new field  →  mark `?`  →  handle undefined at reader   │
  │  widen union    →  keep old variant  →  fork on typeof/tag   │
  │  never rename   ·  never remove  ·  never narrow             │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ capability signals in Receipt (era markers) ───────────────┐
  │                                                              │
  │  usage?      Phase-2  (per-agent token+cost observability)   │
  │  budget?     Phase-3  (per-investigation ceiling)            │
  │  faultTotals? load-only (fault-injection era)                │
  │                                                              │
  │  reader: `receipt.usage?.diagnose?.inputTokens ?? 0`         │
  │  presence = "this era was wired"                             │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The additive-optional pattern is Protobuf's default discipline (`optional` is the semantic; every new field is safe to add). Avro is stricter — schemas must be explicitly compatible in one of a few enumerated ways. JSON without a schema tool is the loosest form of all: nothing enforces compatibility except convention + test coverage. blooming_insights lands where a Next.js app of this size naturally does — TypeScript types as the schema, the 144-test suite as the "does the migration still parse?" enforcer, git history of `types.ts` as the migration log.

The capability-signal pattern (optional field = era marker) is the same shape as **feature flags in configuration** — presence signals "this environment has the feature." Similar shape, same reading discipline. When the feature is fully rolled out, the flag becomes redundant but often stays as forever-optional debt. Same for the receipts here — Phase-2 is universal, but `usage?` stays optional because the pre-Phase-2 receipts exist.

## Interview defense

**Q: "How do you migrate the schema in this system?"**
Answer: "There's no migration tool — no `/migrations` directory, no DDL. What we have instead is a discipline: every new field on a persisted shape is optional. The type comment on `Insight` at `lib/mcp/types.ts:54-55` states this literally: 'all optional + derived from the existing evidence, so older snapshots still validate and render.' Consumers of an optional field handle `undefined` — TypeScript enforces that. The type file `lib/mcp/types.ts` is effectively the migration log; its git history is the change record." Draw the additive-optional-migration diagram.

**Q: "Show me a real migration that shipped."**
Answer: "`Recommendation.estimatedImpact` used to be a plain string. It got widened to `string | { range, rangeUsd?, assumption }`. Both variants are still valid — the validator at `lib/mcp/validate.ts:46-48` checks either shape, and readers fork on `typeof e === 'string'` at `lib/insights/derive.ts:4-6`. Old snapshots keep working. The cost is that the string variant is now permanent — you can't clean it up without breaking older committed data." Anchor: the type at `lib/mcp/types.ts:108-110`.

**Q: "What's the risk of this approach?"**
Answer: "Two. First, optional-field creep — every new field is optional forever, which slowly pollutes the shape and makes 'is this required?' impossible to read from the type. Second, no automatic backfill — if you ever decide a new field *should* be required, you have to write a migration script by hand and touch every persisted store. Right now the surface is small enough that neither is painful. At 10x the shape surface, or when the eval receipt count grows past a few hundred runs, either a schema library like Zod or an actual migration tool starts to earn its keep." Anchor: the capability-signal fields in the `Receipt` shape from `eval/run.eval.ts:341-395`.

## See also

- `01-the-data-model-and-its-shape.md` — the shapes being evolved.
- `04-transactions-and-integrity.md` — the runtime validators that make the additive-optional discipline safe.
- `07-data-modeling-red-flags-audit.md` — the "no destructive migrations" entry on the consolidated checklist.
