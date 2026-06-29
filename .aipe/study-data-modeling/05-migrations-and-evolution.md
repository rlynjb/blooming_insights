# Migrations and evolution

*Backward-compatible schema evolution (industry standard) · Language-agnostic*

## Zoom out, then zoom in

In a SQL world, schema evolution is a problem of *live data*. You have rows in production; a column rename needs a write-old / write-both / read-new / drop-old dance. A destructive `DROP COLUMN` mid-deploy bricks every running pod that still selects it. The whole "migrations" discipline — Alembic, Knex, Drizzle — exists because the data outlives the code.

This repo has no live SQL data and no migrations. But it has a long-lived data artifact: the **committed JSON snapshots** (`lib/state/demo-insights.json`, `lib/state/demo-investigations.json`) that the demo mode replays. They were captured against an older version of the entity types; they have to keep validating across every type change you ship. That constraint is the substitute for migrations — and the technique that makes it work is small, blunt, and load-bearing.

```
  Zoom out — where evolution shows up

  ┌─ UI layer ───────────────────────────────────────────┐
  │  expects the LATEST shape of Insight/Diagnosis/Rec   │
  │  has fallback rendering when optional fields absent  │
  └────────────────────────┬─────────────────────────────┘
                           │
  ┌─ Service layer ────────▼─────────────────────────────┐
  │  /api/briefing serves either:                        │
  │    • live agent run (always new shape) — or          │
  │    • demo-insights.json (CAPTURED LAST RELEASE)      │ ← the evolution
  │                                                        │   pressure
  └────────────────────────┬─────────────────────────────┘
                           │
  ┌─ Storage layer ────────▼─────────────────────────────┐
  │  ★ THE LONG-LIVED ARTIFACT ★                          │
  │  lib/state/demo-insights.json       (committed)      │ ← we are here
  │  lib/state/demo-investigations.json (committed)      │
  │  serialized Insight[] / { [id]: AgentEvent[] }       │
  └──────────────────────────────────────────────────────┘
```

**Zoom in.** The discipline is one rule: **every new field is optional**. Combine that with **type guards that only check required fields** (covered in `04`) and you get backward compatibility for free. There are no version numbers on the JSON, no schema migrations, no "if version === 1 …" branches. The shape evolves by accretion; old data stays valid because it's missing only optional fields.

## Structure pass

**Layers.** Evolution pressure points are at three altitudes:

- **Type layer** — adding/removing/renaming fields on `Insight`, `Diagnosis`, `Recommendation`. The change you actually want to ship.
- **Storage layer** — the committed JSON snapshot, captured under the OLD types. Has to keep deserializing under the NEW types.
- **UI layer** — components that read the new fields, but render gracefully when those fields are absent (because the snapshot doesn't have them).

**Axis traced — "what does a release-day type change cost me?"** Hold that question across the three layers:

```
  Trace the evolution-cost axis

  add a new field?
    type:     1 line of code
    storage:  snapshot has the field missing → MUST be optional
    UI:       must handle absence → fallback render

  remove a required field?
    type:     1 line of code
    storage:  snapshot still HAS the field → ignored on read (OK)
    UI:       was probably reading it → has to be updated
    + agents prompted to emit it → prompt has to change
    + validator checked for it → validator has to change

  rename a field?
    same as add + remove → DOUBLE COST
    plus the snapshot will validate as "new field missing"
    → recapture the snapshot

  add a new variant to AgentEvent?
    type:     1 line of code
    storage:  snapshot won't emit it → fine
    UI:       must handle the new type in switch → exhaustiveness check
              fails at compile time (good!)
```

**Seams.** Two boundaries do the evolution work:

1. **The serializer ↔ deserializer boundary** at `JSON.parse(readFileSync(DEMO_FILE))`. The reader treats parsed JSON as `Insight[]`, no `unknown`-to-`Insight` validation step. The compatibility is implicit in the type's optional fields.
2. **The validator ↔ snapshot boundary** at `isAnomalyArray` etc. These run on LIVE agent output, not the snapshot — but they encode the same rule: "required fields must be there, optional fields can be missing."

The discipline is enforced by code review and the test suite, not by any runtime check. The forcing function is the demo snapshot itself: ship a breaking change, the demo replay breaks loudly the next time someone loads `?demo=cached`.

## How it works

### Move 1 — the mental model

You know how `package.json` semver works — patch is `+`-only, minor is `+`-only, major is breaking? Apply that mental model field-by-field:

```
  The pattern — schema evolution as field-level semver

   add an optional field                 → PATCH (backward compatible)
   add a required field                  → MAJOR (breaks old snapshots)
   remove an optional field              → MAJOR (consumer might use it)
   remove a required field               → MAJOR (always)
   rename a field                        → MAJOR (= remove + add)
   widen a type (string → string | num)  → PATCH (consumers handle either)
   narrow a type (string → 'a' | 'b')    → MAJOR (rejects old values)
```

The discipline is: **stay on patch as long as possible**. Every change above the line is free; every change below the line requires recapturing the demo snapshot (which means running the live agents, committing the new JSON, and verifying both demo and live paths still work).

```
  The shape — backward compatibility from optional fields

   release N      release N+1      release N+2
   ──────────     ──────────       ──────────
   Insight {      Insight {        Insight {
     id           id               id
     timestamp    timestamp        timestamp
     metric       metric           metric
     change       change           change
     severity     severity         severity
     scope[]      scope[]          scope[]
     source       source           source
                  evidence?  ◄──── added                  ┐
                  impact?    ◄──── added                  │ all PATCH
                                   revenueImpact? ◄────── ┘ adds
                                   affectedCustomers?
                                   downstreamReady?
   }              }                }

   snapshot from release N still validates under release N+2's type
   (every added field is optional)
```

### Move 2 — the discipline, walked through real evolution

#### Move 2.1 — the optional-field rule, in the type

Every "business-owner enrichment" added to `Insight` after the initial release is marked `?`:

```ts
// lib/mcp/types.ts:54-62
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

The comment encodes the rule: "All optional + derived from the existing evidence, so older snapshots still validate and render." That's the discipline written down — and notice the second half ("derived from the existing evidence") which is the *other* half of the compatibility story. New fields aren't just optional; they're *computable* from older fields, so the UI can derive them on the fly when reading an old snapshot (covered in `lib/insights/derive.ts`).

#### Move 2.2 — the optional-field rule, in the validator

The shape gate doesn't even *look at* optional fields:

```ts
// lib/mcp/validate.ts:17-27 — isAnomalyArray (recap from 04)
export function isAnomalyArray(v: unknown): v is Anomaly[] {
  return Array.isArray(v) && v.every((a) =>
    !!a && typeof a === 'object' &&
    typeof (a as any).metric === 'string' &&        // required
    Array.isArray((a as any).scope) &&              // required
    !!(a as any).change && /* ... */ &&             // required
    SEVERITIES.includes((a as any).severity)        // required
  );
  // evidence, impact, history, category — NOT checked
}
```

This is the validator-side enforcement of the rule: required is checked, optional is ignored. The agent can emit a 2025-shape Anomaly that's missing `category` (a 2026 addition), and the validator still passes it. Same the other direction: an LLM that emits the new optional field while the validator hasn't been updated yet — also fine.

#### Move 2.3 — the dual-shape acceptance (`estimatedImpact`)

The hardest evolution case in this codebase is when a field changed *shape*, not just got added. `Recommendation.estimatedImpact` used to be a string ("3-5% revenue lift"); it's now a richer object. The type accepts both:

```ts
// lib/mcp/types.ts:108-110
export type EstimatedImpact =
  | string
  | { range: string; rangeUsd?: { low: number; high: number }; assumption: string };
```

And the validator accepts both:

```ts
// lib/mcp/validate.ts:46-48 — isRecommendationArray
const impactOk =
  typeof x.estimatedImpact === 'string' ||
  (!!x.estimatedImpact && typeof x.estimatedImpact === 'object' && typeof x.estimatedImpact.range === 'string');
```

And the UI helper normalizes both:

```ts
// lib/insights/derive.ts:4-9
export function impactRange(e: EstimatedImpact): string {
  return typeof e === 'string' ? e : e.range;
}
export function impactAssumption(e: EstimatedImpact): string | null {
  return typeof e === 'string' ? null : (e.assumption?.trim() || null);
}
```

This is **dual-shape acceptance** — a union type with a normalizer at the consumer. Three lines in each of three files, and a 2024-shape demo snapshot keeps rendering while new agent runs emit the richer shape. The cost: every consumer of `estimatedImpact` has to call `impactRange()` instead of reading `.range` directly. The win: no migration, no recapture.

```
  Dual-shape acceptance — same field, two shapes accepted

  legacy snapshot                      new agent run
  ───────────────                      ──────────────
  estimatedImpact:                     estimatedImpact: {
    "3-5% revenue lift"                  range: "3-5% revenue lift",
                                         rangeUsd: { low: 12000, high: 20000 },
                                         assumption: "based on Q3 baseline"
                                       }
        │                                       │
        │                                       │
        └─────────►  impactRange(e)  ◄──────────┘
                          │
                          ▼
                    "3-5% revenue lift"
                    (consumer never branches)
```

#### Move 2.4 — the discriminated union (`AgentEvent`) — compile-time exhaustiveness

The wire envelope is the one place evolution gets *helpful* compile-time enforcement. Adding a new variant to `AgentEvent`:

```ts
// hypothetical: add a 'coverage_item' variant to AgentEvent
export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | ...
  | { type: 'coverage_item'; item: CoverageItem };   // ← new
```

Every `switch (e.type)` consumer that doesn't handle `'coverage_item'` now fails the TypeScript exhaustiveness check. (In practice, the route at `/api/briefing` already declares `BriefingEvent = AgentEvent | { type: 'coverage_item'; ... }` as a local widening — that's the right pattern: extend the union in one place, fix the consumer right there.)

```
  Adding to a discriminated union — compile-time forcing function

  before:                       after:
  switch (e.type) {             switch (e.type) {
    case 'reasoning_step':...     case 'reasoning_step':...
    case 'insight':...            case 'insight':...
    case 'done':...               case 'done':...
    case 'error':...              case 'error':...
  }                               // missing 'coverage_item' → TS error
                                }
```

The contrast with the entity types: adding `Insight.affectedCustomers?` is *silent* — old consumers ignore it, new ones use it, no compile-time prompt to update anything. The discriminated union's exhaustiveness check is the *one* place evolution forces a code change.

#### Move 2.5 — Phase A (now) vs Phase B (would-be database)

Today, evolution is "edit the type, run the tests, commit." Tomorrow, if user-generated data lands, evolution gets a real migration story:

```
  Phase A (today)                       Phase B (if user data lands)
  ───────────────                       ─────────────────────────────
  edit lib/mcp/types.ts                 edit migration file (SQL or
       (add Field? to Insight)          Drizzle/Prisma migration)

  edit lib/mcp/validate.ts (if          + edit ORM model / Zod schema
       a new required field)

  edit consumers to handle absence      + edit consumers same as A

  re-run live capture if breaking       + write a backfill migration
       (npm run capture:demo)             that populates the new
                                          column for existing rows

  commit JSON + code together           + run migration against prod
                                          DB (zero-downtime sequence)

  what doesn't change between A and B:
    → the optional-field discipline    (still required on read)
    → the dual-shape acceptance        (still the only safe rename)
    → the discriminated union pattern  (still TS-enforced exhaustiveness)
```

The takeaway: the Phase A discipline doesn't disappear when you add a database. It just adds a layer (the migration file) that has to follow the same rules. Phase B *strengthens* the discipline (now the DB engine can also check); it doesn't replace it.

### Move 2 variant — the load-bearing skeleton

Three parts; strip any one and demo replay breaks on the next release:

1. **Every new field is `?`.** Drop this and the next added field rejects every committed snapshot. The discipline is convention-only — no test enforces "all new fields are optional" — but code review catches it because the snapshot test for `?demo=cached` would break.

2. **The validators check only required fields.** Drop this (start validating optional fields) and old snapshots fail the gate even though the type accepts them. The validators are the runtime arm of the discipline.

3. **Dual-shape acceptance with a normalizer at the consumer (`impactRange`).** Drop this and the only way to evolve a field's shape is a full recapture + simultaneous code change. The normalizer is the cheap escape valve for "I need to evolve a field's shape without bumping major."

Hardening on top: `deriveInsightFields` in `lib/insights/derive.ts:27-39` *computes* missing fields from older fields — that's a third layer (compatibility through derivation, not just optionality). When the agent doesn't emit `revenueImpact` but the snapshot has `evidence.current/prior`, the UI derives it.

### Move 3 — the principle

When you can't (or won't) version your stored data, **make every additive change a no-op for old consumers**. Optional fields are the cheap way; dual-shape acceptance is the harder one; recapture is the last resort. The system that gets this right ships features without a single migration file — but pays for it by having every entity field be a maybe and every consumer be a defensive reader. The system that gets it wrong adds a required field, breaks the demo, and learns the rule the hard way.

## Primary diagram

The full evolution map — every technique, every cost, every escape valve.

```
  Schema evolution — techniques and their costs

  ┌─ ADDITIVE CHANGES (free — no migration needed) ─────────────────────┐
  │                                                                      │
  │  add an optional field to an entity                                  │
  │     Insight.foo?: T                                                  │
  │     → old snapshots: missing field, still validate                   │
  │     → consumers: read with ?. or `??` default                        │
  │     → cost: ZERO                                                     │
  │                                                                      │
  │  add a variant to a discriminated union                              │
  │     AgentEvent = ... | { type: 'newKind'; ... }                      │
  │     → old streams: never emit it, fine                               │
  │     → consumers: TypeScript exhaustiveness fails → forced fix        │
  │     → cost: ONE compile error, fix the switch                        │
  │                                                                      │
  │  widen a field's type                                                │
  │     impact: string  →  impact: string | { range; assumption }        │
  │     + add a normalizer at the consumer (impactRange)                 │
  │     → old snapshots: still valid (string)                            │
  │     → new emissions: validator accepts both                          │
  │     → cost: ONE normalizer function                                  │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ BREAKING CHANGES (require recapture or worse) ─────────────────────┐
  │                                                                      │
  │  add a REQUIRED field                                                │
  │     → old snapshots: missing it, validator REJECTS                   │
  │     → fix: recapture the demo (npm run capture:demo)                 │
  │     → cost: live agent run + commit                                  │
  │                                                                      │
  │  rename a field                                                      │
  │     → == add new required + remove old                               │
  │     → consumers + agents + validator all change                      │
  │     → cost: recapture + all-layers code change                       │
  │                                                                      │
  │  narrow a field's type                                               │
  │     'a' | 'b' | 'c'  →  'a' | 'b'                                    │
  │     → old snapshots may contain 'c' → REJECTED                       │
  │     → cost: recapture + check no live emission of 'c'                │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ THE INVARIANT ENFORCED BY THE DEMO ────────────────────────────────┐
  │                                                                      │
  │  Whenever you commit a type change, also load `?demo=cached`         │
  │  locally. If the demo renders without errors, the evolution was      │
  │  backward-compatible. If it doesn't, the change was breaking and     │
  │  needs a recapture. The demo IS the migration test.                  │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The closest industry analog is **Protocol Buffers' approach to schema evolution**: every field has a tag number, never reused; new fields are optional by default; removing a field marks it deprecated but doesn't reuse its tag; widening a numeric type is fine; narrowing is breaking. Same shape of rules, same motive — keep wire formats and stored data compatible across versions without explicit migrations.

The contrast with what most apps do: most apps run a real migration framework (Alembic, Drizzle, Knex) because they have a database with live user data, and "just make it optional" doesn't work when the column is `NOT NULL` and the migration has to backfill. Here, the data has no "users" — it has one author (the LLM) and one reader (the UI). That collapsing of the data lifecycle is *what makes* the optional-field discipline sufficient. The day the data has users (annotations, dismissals, saved investigations), the discipline by itself stops being enough and a migration story has to land.

For the *recapture* path: there's a one-click "capture this as the demo snapshot" button (the dev-only `?` route at `/api/mcp/capture-demo`, described in the project context). That's the operational tool that turns "breaking change" from "ship a migration file" into "click the button, commit the new JSON." The button is the migration framework's substitute — and it's cheap because there's no foreign data to preserve.

## Interview defense

**Q: There are no migration files. How does the schema evolve?**

> The data isn't in a database — it's in committed JSON files (`lib/state/demo-*.json`) that the demo mode replays. The evolution discipline is "every new field is optional." Combined with type guards that only check required fields, old snapshots stay valid across releases. For shape changes (string → object), there's dual-shape acceptance: the type is a union, the validator accepts either form, and a normalizer at the consumer (`impactRange` in `lib/insights/derive.ts`) hides the branch from the UI. When a change is breaking (new required field, rename, type narrow), the only move is to recapture the demo snapshot via the dev-only `/api/mcp/capture-demo` route.

```
   evolution playbook

   additive  → mark new field as `?`, ship                  (free)
   widen     → union type + normalizer at consumer          (1 file)
   breaking  → recapture demo via capture-demo route        (manual)
```

**Q: What's the load-bearing detail people miss?**

> The validators *don't check optional fields*. If they did, every new optional field would reject every old snapshot the moment it shipped — the discipline would invert into a migration-every-release problem. Forgiveness on optional fields is what lets the validator stay the runtime gate AND lets the schema grow. Same principle as Protobuf's "unknown fields are preserved, new fields are optional by default."

**Q: When would this discipline stop being enough?**

> When the data has actual users. Today there are two "writers" (the LLM and the dev capturing the snapshot) and one consumer (the UI). The data is throw-away — re-running the agents produces fresh anomalies, the demo is recapturable. If the product added "save this investigation," "annotate this insight," or "user accounts," then user data is in the store, and the optional-field move stops being enough — because adding a `notes?` field is fine but adding a `notes_format_version` would force a migration over data you don't own.
>
> The signal that the discipline broke would be: the demo snapshot loads fine but a real user's saved data fails to deserialize. That's when you import Drizzle and write the first migration.

```
   when the discipline breaks

   today (no user data):                  tomorrow (user data):
   demo snapshot is the only              every user's saved data is
   long-lived artifact → optional         the long-lived artifact → migration
   fields handle every additive change    framework required for renames + drops
```

## See also

- `01-the-data-model-and-its-shape.md` — the entity shapes that get evolved.
- `04-transactions-and-integrity.md` — the validators that enforce the "required-only" half of the discipline.
- `06-access-patterns-and-storage-choice.md` — when adding user data would force a real database (and a real migration framework).
