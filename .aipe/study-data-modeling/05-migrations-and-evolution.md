# 05 — Migrations and evolution

**Additive schema change / optional-field discipline · Industry standard**

## Zoom out, then zoom in

The classical question — *how do schema changes ship safely under live
data?* — usually means `CREATE TABLE`, `ALTER TABLE ADD COLUMN`, a
backfill job, a feature flag. In **blooming_insights** there's no DB and
no live persistent data, so the analog migration concern is:
**how do the TypeScript types evolve without breaking older snapshots,
older agent outputs, or the demo replay?**

```
  Zoom out — where "schema change" actually happens

  ┌─ Type system (source of truth) ──────────────────────────────────┐
  │  lib/mcp/types.ts                                                 │
  │  lib/mcp/schema.ts (WorkspaceSchema)                              │
  │  lib/mcp/events.ts (AgentEvent union)                             │
  └──────────────────────┬───────────────────────────────────────────┘
                         │  any new field flows three places
            ┌────────────┼────────────────────┐
            ▼            ▼                    ▼
  ┌─ Agent output ─┐  ┌─ Runtime ─────┐  ┌─ Committed JSON ─────┐
  │  prompts emit  │  │  validators   │  │  demo-insights.json   │
  │  new field     │  │  in           │  │  demo-investigations  │
  │                │  │  validate.ts  │  │  must still parse     │
  └────────────────┘  └───────────────┘  └───────────────────────┘
                                              ★ THIS CONCEPT ★ ← we are here
```

Zoom in. There are no SQL migrations because there's no SQL. But every
type change has three consumers — the agent prompts that emit values, the
validators that accept values, the committed JSON snapshots that already
hold old values. The migration story is the discipline that keeps the
three in sync without an `ALTER TABLE` to lean on.

The verdict up front: **the codebase has exactly one migration
strategy — every new field is optional.** It works because the consumers
all gracefully handle missing fields. It's about to be tested as the type
grows; see the audit for the test that would lock it in.

---

## Structure pass — the axis is "what breaks if I add or remove this field?"

```
  Trace ONE axis — "what breaks?" — across three consumers

  for any field change on, say, Insight:

  ┌─ consumer 1: agent prompt ─────────────────────┐
  │  emits a field that the agent generates        │
  │  ADD optional   → no break (won't emit, fine)  │
  │  ADD required   → BREAKS (validator rejects)   │
  │  REMOVE field   → no break (no longer emitted) │
  └─────────────────────────────────────────────────┘
  ┌─ consumer 2: validate.ts ──────────────────────┐
  │  checks shape of LLM output                    │
  │  ADD optional   → no break                     │
  │  ADD required   → BREAKS old agent runs        │
  │  REMOVE field   → no break (no longer checked) │
  └─────────────────────────────────────────────────┘
  ┌─ consumer 3: committed demo JSON ──────────────┐
  │  frozen snapshots that must still validate     │
  │  ADD optional   → no break                     │
  │  ADD required   → BREAKS demo replay           │
  │  REMOVE field   → no break (extra field okay)  │
  └─────────────────────────────────────────────────┘

  → the axis collapses to one rule:
    every additive change MUST be optional, until a recapture+commit
    makes it safe to promote to required.
```

The seam: the demo JSON commits are the **frozen substrate** of the
migration story. They're the equivalent of "live data in production" —
old shapes that the new code must still read.

---

## How it works

### Move 1 — the mental model

Think of it like adding a column to a Postgres table in production: you
don't add it as `NOT NULL` immediately, because every existing row
violates that constraint. You add it as nullable, backfill, then promote
to `NOT NULL` once every row has a value. Same idea here, but the
"existing rows" are committed JSON snapshots and the "column" is a
TypeScript field.

```
  The additive-only migration pattern

  ┌─ phase 1: add field as optional ─────────────────────┐
  │  field?: T   (interface)                              │
  │  validator does NOT check field                       │
  │  agent prompt MAY emit field                          │
  │  UI checks `if (insight.field) { render }`            │
  │                                                       │
  │  → old snapshots still parse                          │
  │  → new snapshots optionally carry the field           │
  └─────────────────┬─────────────────────────────────────┘
                    │ (later, optional)
                    ▼
  ┌─ phase 2: capture fresh demo snapshot ───────────────┐
  │  one-click capture in dev runs the live agents and    │
  │  writes lib/state/demo-*.json with the new field      │
  │  populated                                            │
  │                                                       │
  │  → demo snapshot now exercises the new field          │
  └─────────────────┬─────────────────────────────────────┘
                    │ (rarely, only after every consumer
                    │  reliably emits + uses the field)
                    ▼
  ┌─ phase 3: promote to required ───────────────────────┐
  │  field: T (no `?`)                                    │
  │  validator now requires it                            │
  │  UI removes the `if (field)` guard                    │
  │  any older snapshot would now fail validation         │
  │                                                       │
  │  → in practice this codebase has NEVER promoted a     │
  │    field — every business-owner enrichment lives as   │
  │    optional. The promotion step is buildable target,  │
  │    not current state.                                 │
  └───────────────────────────────────────────────────────┘
```

Phase 3 hasn't happened yet for any of the enrichment fields
(`revenueImpact`, `aov`, `funnel`, `affectedCustomers`, `history`, …).
They've all stayed optional. The current state is "every enrichment is
phase 1 forever," which is conservative but safe.

### Move 2 — the evolution mechanisms, one at a time

#### **Mechanism 1: optional-field-only additions to interfaces**

Open `lib/mcp/types.ts:36-62` and look at the `Insight` interface. The
required fields are tiny — `id`, `timestamp`, `severity`, `headline`,
`summary`, `metric`, `change`, `scope`, `source`. Everything below
`source: 'monitoring' | 'query'` is optional and labeled with a comment
explaining its provenance:

```typescript
// lib/mcp/types.ts:47-62 (annotated)
  source: 'monitoring' | 'query';
  // how this insight was found: the tool(s) the monitoring agent used and their
  // result (e.g. { current, prior }). Optional — older snapshots lack it.
  evidence?: { tool: string; result: unknown }[];
  // one-sentence business impact, written by the monitoring agent (why this
  // change matters for the business). Optional — older snapshots lack it, so
  // the UI falls back to a derived explanation.
  impact?: string;
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

The comment above each tranche is the migration changelog. It tells the
next reader: this field was added later, older snapshots don't have it,
the UI has a fallback. No commit history needed — the type *itself*
documents its evolution.

This is the entire migration toolkit. Three lines of comment, one `?` per
field. No SQL, no migration runner, no rollback script.

#### **Mechanism 2: discriminated union with both old and new shapes**

The hardest field to evolve was `estimatedImpact` on `Recommendation`.
Old snapshots had it as a *string* ("+$15K MRR"); the new shape is an
*object* ({ range, rangeUsd?, assumption }). Adding a new optional field
wouldn't work — the *type itself* needed two shapes.

```typescript
// lib/mcp/types.ts:108-110
export type EstimatedImpact =
  | string
  | { range: string; rangeUsd?: { low: number; high: number }; assumption: string };
```

This is a **discriminated union by structure** — at runtime,
`typeof e === 'string'` tells you which variant. The helper functions
normalize both shapes for the UI:

```typescript
// lib/insights/derive.ts:3-9
export function impactRange(e: EstimatedImpact): string {
  return typeof e === 'string' ? e : e.range;
}
export function impactAssumption(e: EstimatedImpact): string | null {
  return typeof e === 'string' ? null : (e.assumption?.trim() || null);
}
```

```
  Evolving a field that changed SHAPE, not just got new sub-fields

  before:  estimatedImpact: string             "+$15K MRR"
                          │
                          │ add fields without breaking old snapshots
                          ▼
  after:   estimatedImpact: string | { range, rangeUsd?, assumption }
                                                  ▲
                                                  │ new shape
                                                  │
                          old snapshots still validate (string branch)
                          new agent output emits the object branch
                          UI helpers normalize via impactRange/impactAssumption
```

The validator handles the union:

```typescript
// lib/mcp/validate.ts:46-48
const impactOk =
  typeof x.estimatedImpact === 'string' ||
  (!!x.estimatedImpact && typeof x.estimatedImpact === 'object' && typeof x.estimatedImpact.range === 'string');
```

Both branches pass; only an entirely missing or wrong-typed value
fails. The validator is the **migration gate** — as long as both old
and new shapes pass, the code accepts both at the same time, indefinitely.

This is the same pattern Postgres calls a "expand-contract migration":

```
  expand-contract analogy

  Postgres migration:                  This codebase:
  ────────────────────                 ───────────────
  1. ADD COLUMN new_field NULL          1. estimatedImpact: string | { ... }
  2. backfill: SET new_field = ...      2. agent prompt updated to emit new shape
  3. (deploy app reading new_field)     3. UI helpers read both shapes
  4. DROP COLUMN old_field              4. (never run — old shape kept forever)
```

The codebase stops at step 3. There's no step 4 because there's no need
— keeping both shapes valid costs ~5 lines of validator + ~5 lines of
helper, and removes the entire risk of an old snapshot breaking.

#### **Mechanism 3: the demo JSON snapshot as the migration regression suite**

Every type change has to keep `lib/state/demo-insights.json` (665 lines)
and `lib/state/demo-investigations.json` (3,487 lines) parseable. These
files are the equivalent of **"live data in production"** for migration
testing — frozen real outputs that any change must continue to read.

```
  Demo JSON as the migration regression suite

  ┌─ what the snapshots contain ──────────────────────────────────┐
  │  demo-insights.json:                                          │
  │    - 10+ Insight values from a real briefing                  │
  │    - mix of severities, scopes, with/without evidence         │
  │    - coverage report                                          │
  │                                                               │
  │  demo-investigations.json:                                    │
  │    - AgentEvent[] for each demo insight                       │
  │    - includes tool_call_start/end with substrate results      │
  │    - includes diagnosis + recommendations events              │
  └────────────────────────────────┬──────────────────────────────┘
                                   │
                                   │  every type change must keep
                                   │  these parseable + renderable
                                   ▼
  ┌─ what the demo path exercises ────────────────────────────────┐
  │  /?demo=cached → reads demo-insights.json directly             │
  │  /investigate/[id] → reads demo-investigations.json by id      │
  │                                                                │
  │  if the JSON drifts from the type, the demo silently shows     │
  │  empty fields (no crash) — and that's the WORST outcome,       │
  │  because silent degradation hides regression                   │
  └───────────────────────────────────────────────────────────────┘
```

The risk this leaves open: **adding a required field to `Insight` is
not currently caught by any test.** TypeScript will refuse to compile new
code that constructs an `Insight` without the field. But the JSON file
is loaded with `JSON.parse` → `as Insight` (effectively), so it bypasses
the compile-time check. The UI silently renders with the field undefined.

The audit recommends a test like:

```typescript
// suggested: test/state/demo-snapshot.test.ts (not yet written)
import demoInsights from '@/lib/state/demo-insights.json';
import { isInsight } from '@/lib/mcp/validate';

it('demo-insights.json conforms to current Insight shape', () => {
  demoInsights.insights.forEach((i) => {
    expect(isInsight(i)).toBe(true);
  });
});
```

(`isInsight` would need to be added to `validate.ts`; today only
`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray` exist.)

#### **Mechanism 4: capture script as the data migration runner**

When a new optional field starts being emitted by the agents, the demo
snapshots become **stale** in the sense that they don't exercise the new
field. The fix is the **dev-only one-click capture** (referenced in
project context):

```
  Capture as the data-migration step

  dev:                                        prod:
  ─────                                       ─────
  1. open app at /                            (no migration needed —
  2. switch to live mode                       agents always run fresh)
  3. click "capture this as demo"
  4. live agents run a full briefing          
  5. AgentEvent[] written to                  
     lib/state/demo-*.json                    
  6. commit the JSON                          
  7. now /?demo=cached exercises the          
     new field too                            
```

The capture step is the only "migration runner" in the codebase. It
doesn't transform old data into new shape (no in-place migration); it
*re-derives* a fresh snapshot from the substrate. This is the
recomputability story showing up again — because every value can be
recomputed from upstream, "migration" is just "recapture."

#### **Mechanism 5: process-global cache invalidation (the latent bug)**

One specific evolution risk worth calling out: the `WorkspaceSchema`
cache in `lib/mcp/schema.ts:138` is **process-global**, not
session-scoped:

```typescript
// lib/mcp/schema.ts:138-209 (relevant fragment)
let cached: WorkspaceSchema | null = null;

export async function bootstrapSchema(
  dataSource: DataSource,
  opts: BootstrapOpts = {},
): Promise<WorkspaceSchema> {
  if (cached) return cached;
  ...
  cached = parseWorkspaceSchema({ ... });
  return cached;
}

export function _resetSchemaCache(): void {
  cached = null;
}
```

Today both adapters (Bloomreach with one project, synthetic with one
fixed project) expose the same schema regardless of who's asking, so the
process-global cache is fine. The day a user has **two Bloomreach
workspaces** and switches between them in one Vercel warm instance, the
second workspace sees the first's `WorkspaceSchema` until the next
deploy. That's a multi-workspace evolution that the cache shape doesn't
support.

```
  the latent multi-workspace bug

  user A connects to workspace W1
       │
       ▼
  bootstrapSchema → cached = W1's schema
       │
       │  later, user B (same warm instance) connects to workspace W2
       ▼
  bootstrapSchema → returns CACHED W1, not W2 ← bug

  fix: key the cache by projectId (or by sessionId).
  not done today because the product is single-workspace per session.
```

The audit flags it. The fix is small (`Map<projectId, WorkspaceSchema>`),
but it's not the current state — and the comment in the file would need
updating to match.

### Move 3 — the principle

**Schema evolution without a migration tool requires three disciplines:**

1. **Additive-only changes.** Every new field is optional. You never
   remove a field; you let it stay forever even if no one emits it.
2. **Both shapes valid at the same time.** When a field's *shape*
   changes, the type becomes a union and stays a union — never a
   replacement.
3. **The frozen snapshots are the regression suite.** Old committed
   JSON has to keep parsing and rendering. If you want stronger
   enforcement, add a test that re-validates the JSON against the
   current type.

The generalisation: every long-lived system eventually grows multiple
generations of its own data. With a DB, migrations make this explicit
(and dangerous when run wrong). Without a DB, the discipline is the
same — *don't break old shapes* — but it's enforced by convention rather
than by a migration runner. The convention works as long as someone
notices when it breaks.

---

## Primary diagram

The full migration story in one frame.

```
  Schema evolution map for blooming_insights

  ┌─ TYPE CHANGE (source of truth) ──────────────────────────────────┐
  │                                                                  │
  │  edit lib/mcp/types.ts → add `newField?: T` to Insight           │
  │  (or for shape change: `field: OldShape | NewShape`)             │
  │                                                                  │
  └────────────┬───────────────┬────────────────┬────────────────────┘
               │               │                │
   propagates to:              │                │
               │               │                │
  ┌────────────▼────┐  ┌───────▼────────┐  ┌────▼──────────────────┐
  │ Agent prompt    │  │ validate.ts    │  │ Committed JSON         │
  │                 │  │                │  │                        │
  │ may emit field  │  │ check newField │  │ continues to parse —   │
  │ MAY = optional  │  │ ONLY if you    │  │ field is `undefined`   │
  │ now             │  │ promote to req │  │ for old snapshots      │
  │                 │  │                │  │                        │
  │ when stable →   │  │                │  │ when ready → recapture │
  │ stop being      │  │                │  │ via /?capture=demo,    │
  │ optional in     │  │                │  │ commit refreshed JSON  │
  │ prompt          │  │                │  │                        │
  └─────────────────┘  └────────────────┘  └────────────────────────┘
                                                       │
                                                       │ silent risk:
                                                       │ no test re-validates
                                                       │ JSON against type
                                                       ▼
                                            ┌────────────────────────┐
                                            │ AUDIT FLAG             │
                                            │ add test that          │
                                            │ asserts every insight  │
                                            │ in demo JSON conforms  │
                                            │ to current Insight     │
                                            └────────────────────────┘

  Latent issue (separate): WorkspaceSchema cache is process-global.
  Move to Map<projectId, WorkspaceSchema> the day multi-workspace ships.
```

---

## Elaborate

Where this comes from: the **expand-contract migration** pattern (also
called parallel change, or N+1 versioning) is the canonical safe
deployment pattern for online schema changes. The discipline this
codebase practices — optional-only additions, never-remove, both shapes
valid — is the *expand* phase, indefinitely.

The seam to **distributed systems**: protocol versioning is the same
shape. Protobuf's optional-only-additions, gRPC's *don't reuse field
numbers*, REST APIs' `?v=2` versioning — all of them implement the same
principle. The fact that this codebase has no network protocol of its
own doesn't matter; the type → JSON snapshot relationship is exactly the
same problem.

What this codebase consciously doesn't do — and is right not to:

- **No migration tool.** Drizzle, Prisma, Knex — none would help when
  there's no DB to migrate. The "migration" is editing a `.ts` file and
  recapturing the demo snapshot.
- **No rollback story.** A bad type change is rolled back by editing
  the file. Git is the rollback.
- **No backfill jobs.** Existing data is the demo snapshot; you don't
  backfill it, you recapture it.

What it consciously does — and what would be wrong to remove:

- **The comments above optional fields are migration documentation.**
  They tell the next reader why a field is optional. Removing them
  makes the migration history invisible.
- **The discriminated-union `EstimatedImpact`** is the cheapest example
  of a *shape* change done safely. The pattern should be the default
  for any future shape changes.

What to read next: `06-access-patterns-and-storage-choice.md` walks the
buildable target — the day this codebase would grow real persistence and
need real migrations.

---

## Interview defense

**Q: "How do you ship a schema change safely under live data?"**

Verdict first: by **never removing or making something required.**
Every new field is optional with a comment that says when it was added
and what older snapshots look like without it. The TypeScript type is
the source of truth; the committed demo JSON is the regression suite
that any change has to keep parseable.

```
  the answer, sketched

  add a field:
    ┌─ phase 1: optional ─────────────────────┐
    │  field?: T                              │   safe; old snapshots
    │  validator doesn't require it           │   still parse
    │  UI checks `if (field)` before rendering│
    └────────────────────┬────────────────────┘
                         │
                         │ much later, maybe never
                         ▼
    ┌─ phase 2: recapture demo ───────────────┐
    │  one-click capture script writes fresh   │
    │  JSON with the field populated           │
    │  commit the new JSON                     │
    └────────────────────┬────────────────────┘
                         │
                         │ rarely promoted to required
                         ▼
    ┌─ phase 3: required ─────────────────────┐
    │  field: T                               │
    │  validator requires it                  │
    │  old snapshots would now fail validation│
    │  → in practice this codebase has never  │
    │    promoted; phase 1 forever is OK      │
    └─────────────────────────────────────────┘
```

Anchor: "the load-bearing thing people forget is *expand-contract*.
You add the new shape, you keep the old shape valid, you defer the
'contract' phase indefinitely if it's cheap to keep both. In this
codebase, both have been kept forever — which is conservative but
costs almost nothing."

**Q: "What's the riskiest evolution path in this codebase?"**

Verdict first: **adding a required field to `Insight` would silently
break the demo replay.** TypeScript catches new code that constructs an
`Insight` without the field, but the committed JSON is loaded via
`JSON.parse` and cast — so an old `Insight` missing the new field would
*parse* fine and the UI would render with the field undefined. Silent
degradation, hard to notice in dev.

```
  the silent-degradation path

  add Insight.criticalNewField (required)
      │
      ▼
  type edit:    tsc catches new construction sites ✓
  validator:    rejects new agent output without field ✓
  demo JSON:    parses fine (extra field absent)
               UI renders without that field
               nothing crashes, but the card looks broken
               → silent regression, no test catches it
```

The fix is a runtime validator for the demo JSON (`isInsight` in
`validate.ts`, called from a Vitest test). 30 minutes of work; the
audit recommends it.

Anchor: "silent failures are the dangerous ones — the codebase has a
strong story for *loud* failures (the LLM-output validators reject
malformed shapes), but no story today for *silent* drift between the
type and the committed JSON. That's the gap I'd close first."

---

## See also

- [`01-the-data-model-and-its-shape.md`](./01-the-data-model-and-its-shape.md)
  — the types being evolved
- [`02-normalization-and-duplication.md`](./02-normalization-and-duplication.md)
  — why the demo JSON has to stay in sync with the runtime types
- [`04-transactions-and-integrity.md`](./04-transactions-and-integrity.md)
  — the validator layer that gates new shapes at ingest
- [`06-access-patterns-and-storage-choice.md`](./06-access-patterns-and-storage-choice.md)
  — the buildable target where real migrations would start mattering
- [`audit.md`](./audit.md) — checklist with this file's findings
