# Migrations and evolution

**Industry name(s):** Schema migrations · evolution · backwards compatibility · forward-compatible reads · prompt versioning as schema-as-code · rebuild-from-seed (in lieu of migrations)
**Type:** Industry standard · Language-agnostic

> **The agent contract still evolves softly; the Olist DB evolves by destructive rebuild.** Four axes now. (1) The TypeScript interfaces in `lib/mcp/types.ts` evolve through git diffs with an explicit "add as optional" policy. (2) The agent prompts in `lib/agents/prompts/*.md` are the de-facto schema for what each agent emits, versioned through git. (3) The demo seed JSONs (`lib/state/demo-*.json`) are stored snapshots that have to still validate against the current `Insight` interface — solved by the "all enrichments optional" rule. (4) **NEW: the Olist SQLite schema** lives in `mcp-server-olist/scripts/seed-olist.ts` as a string constant (`SCHEMA_SQL`) and "migrations" are achieved by `unlinkSync(DB_PATH) + recreate`. There's no `ALTER TABLE`, no `up/down`, no rollback — because the DB is a deterministic synthetic dataset (`mulberry32(seed=42)`, file 09), drop-and-reseed gives byte-identical data every time. That's a legitimate "no migrations needed" design choice, NOT a gap. The day the DB starts accepting writes from real users, it stops being legitimate.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three things evolve in this repo, none of them with formal migration tooling. The TypeScript interfaces evolve through git. The markdown agent prompts evolve through git. The committed demo-seed JSON evolves through manual re-capture (`scripts/capture-demo.ts`). The integrity gate that lets all three evolve without breaking each other is the "optional fields everywhere" policy: every Tier-1 enrichment in `Insight`, every newer field in `Anomaly`, and every optional field in `Recommendation` is marked `?` so older snapshots and older agent outputs still validate against the current types.

```
  Zoom out — what evolves, where

  ┌─ Spec band (the requirements doc) ────────────────────────┐
  │  blooming-insights-spec.md                                  │
  │  Recommendation defined TWICE (older + richer)              │
  │  the code chose; the comment names the choice (types.ts L114)│
  └──────────────────────────┬────────────────────────────────┘
                             │
  ┌─ Schema band (TypeScript interfaces) ──▼──────────────────┐
  │  lib/mcp/types.ts                                          │
  │  policy: "add as optional, never remove or rename"          │
  │  enforces: backwards-compat reads (old JSON still parses)   │
  └──────────────────────────┬────────────────────────────────┘
                             │ guards re-check at LLM seam
  ┌─ Prompt band (the agent schemas) ──────▼──────────────────┐
  │  lib/agents/prompts/{monitoring,diagnostic,recommendation,query}.md│
  │  these ARE the schema for what each agent emits             │
  │  versioned through git, no codegen, hand-aligned with types │
  └──────────────────────────┬────────────────────────────────┘
                             │ produces JSON validated by validate.ts
  ┌─ Stored snapshot band (committed demo JSON) ──▼───────────┐
  │  lib/state/demo-insights.json (~12KB, 12 insights)          │
  │  lib/state/demo-investigations.json                         │
  │  treated as "live data under migration" — must validate     │
  │  against the current Insight/Investigation shape            │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this concept answers: when a shape changes, what has to stay working? In a relational world, the answer is the existing rows in the table, the existing application code, and the existing reports/dashboards. Here, the answer is the existing demo snapshot (`demo-insights.json` was captured weeks ago), the existing agent prompts (the LLM might still emit older shapes), and the existing UI render code (which expects optional fields to maybe-be-absent). The migration story is **always-additive, always-optional**.

---

## Structure pass

**Layers.** Same four-layer stack. The interesting layer is the **agent loop band**, where the prompts double as schema-as-code.

**Axis: backwards compatibility.** For each change, which already-shipped artifacts have to keep working? This is the right axis because evolution is *literally* about not-breaking-the-old. Cost is wrong (most changes are free); failure is wrong (most changes don't fail loudly — they fail silently in the old data). Backwards compatibility is the discriminator: if a change keeps the demo seed validating and old agent outputs validating, it's safe; if it doesn't, you have a migration.

**Seams.** Three matter. **Seam 1: spec ↔ code.** The spec is markdown; the code is TypeScript. They can drift (and have — see the dual `Recommendation` definitions). Reconciliation is manual, with a comment in the code naming the chosen shape. **Seam 2: types ↔ stored data.** The demo JSON has to validate against the current `Insight` interface. The "all enrichments optional" rule is what makes this work. **Seam 3: prompts ↔ types.** The agent prompts say "emit this JSON shape"; the validators check that shape; the types declare it. Three places, one schema, manually kept in sync.

```
  Structure pass — backwards compatibility across seams

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  Spec · TypeScript types · Prompts · Stored snapshots     │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  backwards compatibility: does this change keep already-  │
  │  shipped artifacts (demo, old agent outputs) working?     │
  └─────────────────────────────┬────────────────────────────┘
                                │  trace across seams
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  S1: spec ↔ code        ★ MANUAL, drift visible (comment) │
  │  S2: types ↔ stored data ★ ENFORCED ("add as optional")   │
  │  S3: prompts ↔ types    ★ MANUAL, three-place sync        │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — How it works
```

---

## How it works

### Move 1 — the migration shape, in this repo

You know how a Rails migration is "an `up` and a `down`, run in sequence against a versioned database"? None of that exists here. What does exist is a softer pattern: **schema evolves through git, and the "live data" you have to keep validating against is committed alongside the schema** (the demo JSON). The migration story is therefore:

```
  the evolution pattern — three places, one policy

         (1) add the field
                │
                ▼
  ┌─ lib/mcp/types.ts ────────────────┐
  │ interface Insight {                │   ALWAYS optional: `?` marker
  │   ...existing required fields,    │   ALWAYS additive: never remove
  │   newField?: NewType;             │   ALWAYS named explicitly: no
  │ }                                  │   `extends BaseInsight` shortcuts
  └────────────────────────────────────┘
                │
                ▼
  ┌─ lib/agents/prompts/*.md ─────────┐
  │ Update the Output section to       │   the agent learns to emit
  │ describe newField (when to emit,   │   the new field; OLD agent runs
  │ what it means)                     │   are still valid (field absent)
  └────────────────────────────────────┘
                │
                ▼
  ┌─ lib/mcp/validate.ts ─────────────┐
  │ Optionally add a guard check,      │   USUALLY skipped (optionals
  │ but only for required-required-   │   aren't validated at the seam;
  │ for-rendering fields              │   the UI handles absent gracefully)
  └────────────────────────────────────┘
                │
                ▼
  ┌─ lib/state/demo-*.json ───────────┐
  │ Old snapshots still validate       │   no migration needed; the
  │ because the field is optional      │   "always optional" rule
  │ (it just won't render that bit     │   makes evolution free
  │  for old data)                     │
  └────────────────────────────────────┘
```

The contrast with a relational migration is sharp:

```
  RELATIONAL                             THIS REPO
  ────────────────────────────           ──────────────────────────────
  ALTER TABLE insights                   add `newField?: T` to interface
    ADD COLUMN newField TEXT;            (optional)

  UPDATE insights                        no backfill — old rows stay
    SET newField = ... WHERE ...;         absent; UI handles absent

  reversible? yes, via DOWN              reversible? yes, via git revert
  zero-downtime? requires care            zero-downtime? trivially —
  (NOT NULL needs a default)             optionals are always safe

  rollout: deploy migration,              rollout: deploy the code; the
  then deploy code that uses it           agent gradually emits the field
                                          on new runs; old data is fine
```

### Move 2 — the optional-field policy

The comment at `lib/mcp/types.ts` L54 names the policy explicitly:

```
  the policy, in the codebase's own words

  // ── business-owner enrichments (Tier 1). All optional + derived from the
  //    existing evidence, so older snapshots still validate and render. ──
  revenueImpact?: { lostUsd: number; expectedUsd: number; currency: 'USD' };
  aov?: { current: number; prior: number };
  funnel?: { view: number; cart: number; checkout: number; purchase: number };
  affectedCustomers?: number;
  history?: number[];
  downstreamReady?: { diagnosis: boolean; recommendations: number };

  the two halves matter:
    1. "All optional"             — older snapshots still validate
    2. "derived from the existing  — even the new fields are computable
        evidence"                    from already-stored evidence; you
                                     can re-derive them for old rows if
                                     a downstream consumer needs them
```

This is the **forward-compatible read** pattern. New writers might emit the field; old writers don't; both kinds of data round-trip through the same validator. The cost: the UI has to handle "field might be absent" everywhere. That cost is bounded — the UI is rendering one shape with consistent fallbacks.

### Move 2 — the dual-spec Recommendation as a worked example

The spec at `blooming-insights-spec.md` contains **two different `Recommendation` definitions** — one in the "data model" section, one in the "recommendation agent" section. The code in `lib/mcp/types.ts` L114–L130 picks the richer one and names the choice in a comment:

```
  the migration trace — when the spec drifts and the code has to pick

  blooming-insights-spec.md
    "data model" section:
      Recommendation { title, rationale, bloomreachFeature, ... }

    "recommendation agent" section:
      Recommendation { id, title, rationale, bloomreachFeature: 5-member union,
                       steps[], estimatedImpact, confidence, ... }

                          ↓ which one wins?

  lib/mcp/types.ts L113–L114:
    // CANONICAL Recommendation shape. NOTE: the spec contains TWO different
    // Recommendation definitions (one in "data model", one in "recommendation
    // agent"). Use this RICHER one ... everywhere — it has `id`, `steps`, and
    // the 5-member `bloomreachFeature` union.

                          ↓ the implication

  if someone updates the spec, the comment is the only signal that:
    (a) the spec divergence is known
    (b) the code already made a deliberate choice
    (c) the spec's "data model" section is stale

  this is a soft-migration: the code is the truth; the spec is a stale draft;
  the comment carries the migration receipt.
```

What breaks without the comment: a future contributor reads the spec, sees the simpler shape, "fixes" the code to match, and breaks every consumer that uses `steps`, `id`, or the 5-member union. The comment is the **migration documentation in lieu of formal versioning**. It works because the spec is for one reader (Rein) and the codebase is small; at team scale it doesn't.

### Move 2 — the prompts ARE the schema (for what each agent emits)

The four prompt files (`lib/agents/prompts/{monitoring,diagnostic,recommendation,query}.md`) end with an `## Output` section that *literally specifies the JSON shape*. Example from `monitoring.md` L70–L98:

```
  the prompt as schema-as-code (excerpt from monitoring.md)

  ## Output

  Return ONLY a JSON array of anomaly objects, at most 10 items, sorted by
  severity ..., wrapped in a ```json fenced block. Each item:

  [
    {
      "metric": "purchase_revenue",
      "category": "revenue_drop",
      "scope": ["global"],
      "change": { "value": 18.5, "direction": "down", "baseline": "90d" },
      "severity": "critical",
      "impact": "...",
      "evidence": [
        { "tool": "execute_analytics_eql", "result": { "current": 42000, "prior": 51500 } }
      ]
    }
  ]

  Field rules:
  - `category` — REQUIRED. ...
  - `metric` — short snake_case name ...
  - `scope` — `["global"]` unless ...
  ...

  this is THE schema for the Anomaly objects the monitoring agent emits.
  it has to stay aligned with:
    - lib/mcp/types.ts:    interface Anomaly
    - lib/mcp/validate.ts: isAnomalyArray

  there's no codegen. alignment is manual, enforced by:
    - the runtime guard (which rejects shapes that don't match)
    - the agent's repeated runs (a drift surfaces as empty briefings)
```

When a field is added to `Anomaly`, the prompt's `## Output` section has to be updated too, otherwise the agent won't know to emit it. That's a three-place edit (types + validate + prompt), with the runtime guard as the only enforcement that the three agree. **The prompt is git-versioned the same way any other code file is**, which is the closest thing to "schema migration" the repo has.

### Move 2 — the demo seeds as "live data"

`lib/state/demo-insights.json` is a 12-insight snapshot captured by `scripts/capture-demo.ts`. It's checked in. It serves two purposes: (a) the offline demo when no MCP credentials are available, (b) the test fixture for the route handler. It was captured *weeks ago* against an *older shape* of the codebase.

```
  the demo seed as a "live data" stand-in

  when:    captured 2026-05-28 (timestamp in the file)
  by:      scripts/capture-demo.ts running a full agent loop
  shape:   the Insight interface as of that date
  used by: app/api/agent/route.ts (DEMO_FILE fallback)
           app/api/briefing/route.ts (offline mode)
           several tests in test/

  what evolution looks like when the Insight interface changes:

    case A — field added (optional)
      ✓ the demo seed still validates (TypeScript accepts missing optional)
      ✗ the demo seed doesn't show off the new field in the UI
      → option 1: re-capture the demo (run scripts/capture-demo.ts)
      → option 2: manually patch the JSON to add the new field
      → option 3: ignore — the demo's old shape is fine for the offline mode

    case B — field made required
      ✗ the demo seed FAILS to validate
      → must either re-capture or backfill the field on every existing row

    case C — field renamed
      ✗ the demo seed loses the value silently (old name not read)
      → must re-capture or write a migration script

  the policy "always add as optional" makes case A the only path that
  actually happens. cases B and C aren't supported — there's no migration
  tooling, and the seed is the only "live data" so a forward-incompatible
  change would require a manual re-capture.
```

What breaks without this discipline: an incompatible rename ships, the demo route returns invalid data, the UI crashes when no MCP is available — i.e. exactly the kind of regression an integration test would normally catch, except there's no test that validates the demo seed against the current interface. The discipline is the test.

### Move 2 — Olist's "migrations": drop-and-reseed (NEW 2026-06-16)

The Olist DB's schema lives in `mcp-server-olist/scripts/seed-olist.ts` as the `SCHEMA_SQL` constant. To change the schema, you edit the string and run `npm run seed`. The seeder does:

```
  the seed-as-migration pattern

  1. compute DB_PATH                       (mcp-server-olist/data/olist.db)
  2. if (existsSync(DB_PATH)) unlinkSync   ← destructive: delete the file
  3. db = new Database(DB_PATH)             ← fresh empty file
  4. db.exec(SCHEMA_SQL)                    ← create all tables + indexes
  5. db.transaction(() => {                 ← all bulk inserts in one txn
       insert customers, products,
              orders, order_items,
              payments, reviews,
              seeded_anomalies
     })()
  6. (done — DB file is now identical across machines because
      mulberry32(seed=42) is deterministic; see file 09)
```

**What this gives:** zero migration tooling, zero `up/down` scripts, zero rollback story — and it's correct. Because the seed is deterministic, two developers running `npm run seed` end up with byte-identical DBs. Because the schema is destructive-rebuild, "what's the current schema?" is always `SCHEMA_SQL` — no schema-version table, no checking which migrations have applied.

**What this only works because of:** the DB is **read-only at runtime** (only the seeder writes), and the data is **synthetic** (no real customer data to preserve). Both invariants are load-bearing. The moment either flips — the moment a tool starts writing, or the moment the data is real — drop-and-reseed becomes destructive in the bad sense. That's when Drizzle migrations or `node-pg-migrate` would have to land.

**The contrast with the agent-contract side:**

```
  Agent-contract side               Olist DB side
  ───────────────────────────       ────────────────────────────
  evolves softly through git        evolves destructively
  every new field is OPTIONAL       schema is a constant string
  old snapshots still validate      no "old data" — reseed gives
                                     the current shape every time
  no migration tool needed          no migration tool needed
   (because additive only)           (because deterministic + read-only)
  forward-compatible reads          backwards compatibility is NIL
                                     (a SCHEMA_SQL change wipes everything)
```

Both are legitimate "no migration tooling" stories — but for opposite reasons. The agent contract preserves old data by making every change additive. The Olist DB throws away old data by making the data regenerable. Two solutions to "we don't have migrations"; both work for the constraints they live under.

### Move 3 — the principle

Schema evolution is a question of who has to do what when the shape changes. In a relational system with live writers and durable customer data, the answer is "the DBA runs the migration, the app reads the new shape, old data gets backfilled or upcast at read time." Here, the answer splits two ways: the agent contract evolves by **add-only with optional fields** (existing data validates against the new shape automatically), and the Olist DB evolves by **deterministic-rebuild** (no existing data to preserve because the seed regenerates it). Both are "no migration tooling" — and both are right, for the constraints they hold. The day either invariant breaks (data becomes load-bearing for the agent side; the DB starts taking real writes), the soft story stops working.

---

## Primary diagram

Migration paths, recap.

```
  Schema evolution — what changes how

  ┌─ ALWAYS-SAFE CHANGES (no migration needed) ──────────────┐
  │                                                            │
  │   add optional field to an interface                       │
  │     types.ts: foo?: T          ← always allowed            │
  │     old data: still validates  (field absent OK)           │
  │     prompts:  agent learns when prompt updated             │
  │     guards:   no change needed for optionals               │
  │     demo:     still loads; just doesn't show new field     │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ NOT SUPPORTED (would need migration tooling) ───────────┐
  │                                                            │
  │   rename a field         ← breaks demo seed silently       │
  │   make optional required ← breaks demo seed loudly         │
  │   change a field's type  ← breaks demo seed loudly         │
  │   remove a field         ← breaks any consumer reading it  │
  │                                                            │
  │   today's workaround: re-capture demo manually + edit any  │
  │   committed JSON. no rollback story.                       │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ SOFT MIGRATIONS (spec ↔ code drift) ────────────────────┐
  │                                                            │
  │   spec edits a shape definition                            │
  │   code may or may not match                                │
  │   resolution: comment in types.ts names the choice         │
  │     (e.g. "use this RICHER one — the spec has two")        │
  │   enforcement: none (the spec is markdown)                 │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### The optional-field policy in the interface

```
lib/mcp/types.ts  (lines 36–62)

  export interface Insight {
    id: string;                       ← always present
    timestamp: string;                ← always present
    severity: Severity;
    headline: string;
    summary: string;
    metric: string;
    change: { ... };
    scope: string[];
    source: 'monitoring' | 'query';

    // The 4 fields below were added LATER. All optional, so older
    // demo snapshots (captured before they existed) still validate.
    evidence?: { tool: string; result: unknown }[];
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
  }
       │
       └─ the comment IS the migration policy. every new field is
          optional. every reader of an Insight has to handle absent.
          this is the entire migration story for the type itself.
```

### The dual-spec resolution comment

```
lib/mcp/types.ts  (lines 113–116)

  // CANONICAL Recommendation shape. NOTE: the spec contains TWO different
  // Recommendation definitions (one in "data model", one in "recommendation agent").
  // Use this RICHER one (the recommendation-agent version) everywhere — it has `id`,
  // `steps`, and the 5-member `bloomreachFeature` union.
  export interface Recommendation { ... }
       │
       └─ a literal migration-receipt-in-a-comment. tells any future
          editor: the spec drifted, this is the chosen branch, don't
          "correct" the code back to the simpler shape.
```

### The prompt as schema-as-code

```
lib/agents/prompts/monitoring.md  (lines 70–98)

  ## Output

  Return ONLY a JSON array of anomaly objects, at most 10 items ...

  [
    {
      "metric": "purchase_revenue",
      "category": "revenue_drop",
      "scope": ["global"],
      "change": { "value": 18.5, "direction": "down", "baseline": "90d" },
      "severity": "critical",
      "impact": "...",
      "evidence": [
        { "tool": "execute_analytics_eql", "result": { "current": 42000, "prior": 51500 } }
      ]
    }
  ]

  Field rules:
  - `category` — REQUIRED. the checklist `id` this anomaly belongs to ...
  - `metric` — short snake_case name (e.g. `purchase_revenue`, ...).
  - `scope` — `["global"]` unless you located the change in a specific segment/country.
  - `change.value` — magnitude as a positive percentage; ...
  ...
       │
       └─ THIS is what the agent learns the shape from. it has to stay
          aligned with types.ts and validate.ts. there's no codegen,
          no schema-derived prompt — it's hand-written markdown, edited
          alongside the type. git is the migration tool.
```

### The committed snapshot

```
lib/state/demo-insights.json  (12 insights, ~12KB, captured 2026-05-28)

  {
    "insights": [
      {
        "id": "35e00e48-cdb3-4caf-aa92-b8afcea95bae",
        "timestamp": "2026-05-28T23:14:36.313Z",
        "severity": "critical",
        "headline": "global purchases_exceed_sessions · +109.5%",
        ...
        "evidence": [{ "tool": "execute_analytics_eql", "result": { ... } }],
        "impact": "There are 21,570 purchases but only 10,296 session_start ...",
        "downstreamReady": { "diagnosis": true, "recommendations": 3 }
      },
      ...
    ]
  }
       │
       └─ NOTE what's NOT in this row: `revenueImpact`, `aov`, `funnel`,
          `affectedCustomers`, `history`, `category`. all of those are
          optional fields the interface was extended with after the
          capture. the JSON still validates today because each is `?`.
          this is the "live data under migration" story in miniature.
```

---

## Elaborate

The deeper structural choice: the repo **treats the type definition as a contract that one-way evolves**. Adding is always safe; removing or renaming is never tried. This is the same pattern as Protocol Buffers' "always optional, never reuse field numbers" or Avro's "schema evolution with reader/writer schemas" — except enforced socially (a comment, a code review) rather than technically (a schema-evolution tool). For a one-person codebase at this size, social enforcement is fine. At team scale, the right move would be Zod or `io-ts` schemas that derive both the type and the validator, plus a generated JSON Schema the spec and prompts could lint against.

The prompts-as-schema choice is the most interesting in the audit. Most repos keep schema in TypeScript/SQL and prompts as free-form natural language. This repo's prompts are **half English, half schema-spec** — the "Output" sections of every prompt file specify the exact JSON shape, in the same file as the agent's instructions. That's deliberate (the prompt and the schema travel together — change the prompt to demand a new field, you're declaring schema). The downside: the prompt file is the third place the shape is encoded, and the manual alignment is a footgun.

A note on the seed JSONs as live-data analogues. `demo-insights.json` was captured weeks ago and reads against a more recent interface. Today this works because every field added since was optional. If someone made a field required, the demo JSON would fail validation and the offline mode would break. **The "always optional" rule is what holds the migration story together for this committed-data story.** Without it, every interface change would require running `scripts/capture-demo.ts` and committing the regenerated snapshot — a manual step easy to forget. The optional rule retires the chore.

A note on what's NOT here: no schema versioning, no `version: 1` discriminator on `Insight`, no upcast/downcast layer. The implicit assumption is "there's only one version, and it's whatever's in the current types.ts." If the repo ever ships clients that talk to multiple backend versions (a mobile app with stale code), that assumption breaks and the model needs a version field. Not the case today.

## Interview defense

**Q: How does this repo handle schema migrations?**
A: There's no DB, so no migration tooling — but schema still evolves, through three softer paths. (1) The TypeScript interfaces in `lib/mcp/types.ts` evolve through git, with an explicit "always add as optional" policy named in the comment at L54. (2) The agent prompts in `lib/agents/prompts/*.md` carry the output JSON shape — they're the schema for what each agent emits, versioned through git, manually kept aligned with the types. (3) The committed demo seed `lib/state/demo-insights.json` is the closest thing to "live data" — it has to keep validating against the current interface, which works because of the always-optional rule. The pattern that holds this together: forward-compatible reads with optional fields, fail-soft validators that accept superset/subset shapes.

**Q: Walk me through the dual-Recommendation case.**
A: The spec at `blooming-insights-spec.md` defines `Recommendation` twice — a simpler version in the "data model" section and a richer one in the "recommendation agent" section. The code in `lib/mcp/types.ts` L114–L130 picks the richer one and names the choice in a comment: "Use this RICHER one ... everywhere." That comment is a literal migration-receipt-in-a-comment — it tells any future editor that the divergence is known and which branch is canonical. At team scale this is too soft (a comment isn't a tool), but for a one-person repo it's the right weight: the choice is visible, reviewable, and revertable through git.

```
  diagram while you talk

  spec (markdown)         types.ts (TypeScript)
  ──────────────────      ────────────────────────
  Recommendation v1   ─┐
  Recommendation v2   ─┴─→  picks v2 + comment
                            ("RICHER one — has id,
                             steps, 5-member union")

  no codegen. no enforcement. git diff + the comment
  are the migration log.
```

## See also

- `01-the-data-model-and-its-shape.md` — the 8 interfaces that evolve, and the dual-shape `Diagnosis` as a mid-migration smell.
- `02-normalization-and-duplication.md` — the `affectedCustomers` ghost field declared but never written is mid-migration debt.
- `04-transactions-and-integrity.md` — the Olist seed transactions (the rebuild is one atomic operation).
- `06-access-patterns-and-storage-choice.md` — the three storage layers and their durability stories.
- `08-the-olist-relational-schema.md` — `SCHEMA_SQL` lives here.
- `09-deterministic-synthetic-data.md` — `mulberry32(seed=42)` is what makes destructive-rebuild a legitimate migration strategy.
- `study-software-design/audit.md#pull-complexity-downward` — the prompts owning their own output-shape schema is "pull complexity downward" applied to schema evolution.

---
Updated: 2026-06-16 — added the Olist "drop-and-reseed" pattern; named the determinism-and-read-only invariants that make it work; contrasted with the additive-evolution policy on the agent contract.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
