# 05 — Migrations and evolution

**Schema evolution · Case B (no DB, but data DOES persist across commits) · forward-only, optional-fields discipline**

## Zoom out — where this concept lives

Migrations are the change-amplification symptom made physical: code is cheap to change, a schema with live data in it is not. In a database this shows up as `ALTER TABLE` scripts. Here, there's no `ALTER TABLE`, but there is *committed data on disk* — `eval/baseline.json`, `eval/receipts/*.json`, `lib/state/demo-insights.json`, `public/demo/*.json` — that has to survive shape changes.

```
  Zoom out — where "live data" survives commits in this repo

  ┌─ ephemeral tiers (no migration needed) ─────────────┐
  │  tier 1: localStorage (per-browser, resets fine)     │
  │  tier 2: in-memory Map (dies with instance)          │
  │  tier 3: bi_auth cookie (10-day expiry catches you)  │
  │  tier 4: dev-only files (gitignored, throw away)     │
  └──────────────────────────────────────────────────────┘

  ┌─ durable tier (migrations LIVE here) ────────────────┐
  │  tier 5: git-committed JSON                          │
  │    ★ THIS FILE ★ — how do shape changes here NOT     │
  │    break the running app?                            │
  │                                                       │
  │  eval/baseline.json           (regression reference)  │
  │  eval/receipts/*.json         (28 files, historical) │
  │  lib/state/demo-insights.json (demo mode seed)       │
  │  lib/state/demo-investigations.json                  │
  │  public/demo/*.json           (baked golden fixtures)│
  │  eval/goldens/*.ts            (TypeScript, but data) │
  │  eval/calibration/*.json      (worksheet + agreement)│
  └──────────────────────────────────────────────────────┘
```

The question this file answers: **when I change an entity's shape, what breaks on disk — and how do I un-break it?**

## The structure pass — layers, one axis, seams

Hold one axis: **is this shape change safe against the on-disk data?**

```
  Axis: "does changing this field break the committed JSON?"

  ┌── change type ───────────────────────────────────────────┐
  │                                                          │
  │  ADDING an optional field to Insight                     │
  │    → old committed JSONs lack it → validator says OK      │
  │    → new code reads it as undefined → renders fallback    │
  │    ✓ FORWARD-COMPATIBLE                                   │
  │                                                          │
  │  ADDING a required field to Insight                      │
  │    → old committed JSONs lack it → validator would fail  │
  │    → but this repo has no validator on Insight! → runtime │
  │      crash when new code assumes the field exists         │
  │    ✗ NOT FORWARD-COMPATIBLE                               │
  │                                                          │
  │  RENAMING a field on Insight                             │
  │    → old key still on disk under old name                │
  │    → new code reads the old name and gets undefined      │
  │    ✗ NOT FORWARD-COMPATIBLE                               │
  │                                                          │
  │  CHANGING a field's TYPE                                 │
  │    → history: number[] → history: {ts, val}[]            │
  │    → new code loops assuming objects, gets numbers       │
  │    ✗ NOT FORWARD-COMPATIBLE                               │
  │                                                          │
  └──────────────────────────────────────────────────────────┘

  seam: the git commit boundary. Changes to types.ts commit
        instantly; changes to committed JSONs require a separate
        commit (or a regenerate step). The two can drift.
```

The whole discipline in this codebase is **stay in the ✓ row.** Almost every field added since day one has been optional. That's not a strategy for the ✗ rows — it's *lucky-additive*, and the moment a destructive change is needed, there's no migration story ready.

## How it works

### Move 1 — the mental model

You know this from evolving a REST API: adding an optional response field is safe (old clients ignore it, new clients use it); renaming a field breaks old clients (they look for the old name, get nothing); changing a field's type breaks new clients (they parse the old value wrong). Same three cases here, but the "clients" are:

  (a) the running app code (which imports from `lib/mcp/types.ts`),
  (b) the committed JSONs on disk (which are frozen at whatever shape they were committed at), and
  (c) the eval subsystem (which reads receipts across runs and expects the same shape).

```
  The pattern — three "clients" of the schema, three ways to drift

    change            (a) app code           (b) committed JSONs   (c) eval subsystem
    ──────            ───────────────         ───────────────────   ─────────────────
    add optional      compiles, runtime OK   ignores new field     ignores new field
    add required      compiles, RUNTIME      fails to validate     fails to load
                      CRASH                  (if there's a         historical receipts
                                              validator)
    rename field      compiles, reads old    old name still on     old receipts have
                      as undefined           disk, new name         old name; new
                                              missing               receipts have new
    change type       compiles, PARSES       old value has old     type mismatch
                      OLD VALUE WRONG        type                   across runs
```

The load-bearing discipline: **every new field on `Insight`, `Anomaly`, `Recommendation`, `Diagnosis` is declared with `?`.** That handles case (a). It does *nothing* for the other two.

### Move 2 — the current state, and where it breaks

Walk each durable artifact one at a time.

#### Artifact 1 — `lib/state/demo-insights.json` (the demo-mode seed)

**Shape drift risk:** an `Insight` field is renamed or changes type.

**Current state:** the file was seeded when `Insight` had ~10 fields; it's since grown to ~15 optional ones. Because every added field was optional, the seed still validates against the current type — old fields are present, new fields are absent, TS is happy.

**What would break:**
  → Rename `Insight.headline` → `Insight.title`. New code reads `.title`, gets `undefined`. Every demo-mode insight card renders blank.
  → Change `Insight.history: number[]` → `Insight.history: {ts, val}[]`. New code loops `.value` on numbers, silently NaN.

**Current mitigation:** none. If you make either change, you re-generate the seed by hand (there's no script that regenerates it from the current agent) or edit the JSON by hand.

**The fix, when it becomes real:** a `scripts/bake-demo-*.ts` (there's already `scripts/bake-demo-coverage.ts` for related coverage data) that runs the current agent, captures the output, and writes the seed. Then a schema change means: change the type, re-run the bake, commit both.

#### Artifact 2 — `eval/receipts/*.json` (28 committed receipts)

**Shape drift risk:** `Receipt`'s fields grow or shrink; historical receipts become unreadable to the aggregator.

**Current state:** the receipt shape is defined *implicitly* — there's no exported `Receipt` type, only the local `type Receipt = {...}` in `baseline.eval.ts:26-39` for the aggregator's needs. The receipt writer (`run.eval.ts`) writes whatever the current run produces.

That's a real modeling weakness: **the receipt is a big denormalized blob with no canonical shape declaration.** When the receipt grows a new field (say, `budgetSnapshot` was added mid-week 4), old receipts don't have it. The aggregator reads with `.?` and defaults, but there's no test that catches "the field was renamed, all old receipts are silently missing."

**What would break:**
  → Rename `receipt.diagnosisJudgment` → `receipt.diagJudgment`. The aggregator's `r.diagnosisJudgment` becomes undefined; `baseline.json` regenerates with empty verdict distribution. Nobody notices unless they eyeball the numbers.
  → Add `receipt.retryCount` as a required field for the aggregator. Old receipts crash the aggregate.

**Current mitigation:** the aggregator's `Receipt` type is *narrow* (`baseline.eval.ts:26-39` picks only the fields it needs). That accidentally forward-shields it — the wide receipt could grow and the narrow aggregator stays happy.

**The fix, when it becomes real:** move `Receipt` to a `eval/types.ts` alongside `GoldenCase`. Version it: `receipt.schemaVersion: '1' | '2'`. The aggregator switches on version.

#### Artifact 3 — `eval/baseline.json` (the regression reference)

**Shape:** aggregate-only. `runId`, `builtAt`, `caseCount`, `diagnosis: DimensionAggregate`, `recommendation: DimensionAggregate`.

**Shape drift risk:** the aggregator's dimension names change. Regression gate compares aggregates by name; a rename = a false regression.

**Current state:** committed at run `2026-07-03T04-08-28-644Z`. The gate reads it (`eval/gate.eval.ts`), reads a candidate run's aggregate, compares dimension-by-dimension.

```
  The regression-gate loop — where baseline shape matters

  ┌── committed: eval/baseline.json ────────────────┐
  │  perDimensionPassRate: {                         │
  │    root_cause_plausibility: 0.75,                │
  │    evidence_grounding: 0.5,                      │
  │    scope_coherence: 0.75,                        │
  │    actionable_next_step: 0                       │
  │  }                                                │
  └───────────────────────┬──────────────────────────┘
                          │  gate.eval.ts loads both
                          ▼
  ┌── candidate: computed from a fresh run ──────────┐
  │  perDimensionPassRate: {                         │
  │    root_cause_plausibility: 0.80,   ← +5%        │
  │    evidence_grounding: 0.5,                       │
  │    scope_coherence: 0.75,                         │
  │    actionable_next_step: 0.10       ← +10%       │
  │  }                                                │
  └───────────────────────┬──────────────────────────┘
                          ▼
                       compare per-dim → verdict

  the DRIFT case: baseline uses "actionable_next_step"; a rubric
  rev renames it to "next_step_actionability". Gate sees the old
  key as missing → false "regression" of 100% on that dim.
```

**What would break:**
  → Rename a rubric dimension. The baseline has the old name; candidate has the new. Gate reports the old dim as regressed-to-nothing, the new dim as improved-from-nothing.

**Current mitigation:** none. A rubric change requires deliberately re-baselining (`RUN_BASELINE=1 npm run eval:baseline`) and committing the new baseline.

**The fix, when it becomes real:** a `baseline.rubricVersion` field on both the baseline and each receipt. The gate refuses to compare across mismatched versions and emits a "REBASELINE REQUIRED" message.

#### Artifact 4 — `Investigation.diagnosis` shape drift (in-flight, will bite when destructive)

Already flagged in file 02 and file 04. The relevant migration risk: the two shapes `Diagnosis` and `Investigation.diagnosis` will diverge, and the demo `demo-investigations.json` seed was written against one of them. Whichever one gets updated (say, `Diagnosis.hypothesesConsidered` gets a fourth field), the demo seed will validate against the older sibling type but *not* against the newer one.

There's no explicit test that "the demo seed matches the current type." That's the migration test that doesn't exist yet.

### Move 2.5 — current state vs future state

**Current state (Phase A):**
  → Every added field is optional. TypeScript is happy across all committed JSONs.
  → No `schemaVersion` anywhere.
  → No migration scripts. Regeneration is manual.
  → Two shape-drift risks live (Diagnosis vs Investigation.diagnosis, demo seeds).
  → 28 committed receipts, all from one week, all under implicit "receipt shape" contract.

**Future state (Phase B), the version where migrations become real:**

```
  Phase A (today)                        Phase B (when needed)
  ─────────────                          ─────────────────────

  Insight (types.ts):                    Insight (types.ts):
    id: string                             schemaVersion: '2'   ← NEW
    headline: string                       id: string
    ... 15 optional fields ...             title: string        ← RENAMED
                                            ... etc ...

  demo-insights.json:                    demo-insights.json:
    { insights: [{ headline: ... }] }      { schemaVersion: '2',
                                            insights: [{ title: ... }] }

  read path (server):                    read path (server):
    JSON.parse(file)                      readInsightSeed(file):
    → shape assumed                        parsed = JSON.parse(file)
                                           switch (parsed.schemaVersion):
                                             '1': migrateV1toV2(parsed)
                                             '2': parsed
                                             else: throw
```

The migration point is *at the read boundary*, not in a separate step. That's the "read-side migration" pattern: instead of walking all files and rewriting them (dangerous, can't roll back), you version the shape and add a case in the reader for each historical version. Old files stay untouched. If you ever need to compact, you re-run the reader and re-write everything at the current version.

Cost of moving to Phase B: adding `schemaVersion: '1'` to every committed JSON today (a search/replace). Adding a `migrateInsight` function with one case. From there, every future destructive change is a `'2' → '3'` case, and old receipts still load.

**What the migration to Phase B doesn't have to change:** the wire format, the in-memory `Map`, the cookie encryption. All of those are ephemeral tiers where the shape drift dies with the instance/cookie. Migrations only matter for tier 5.

### Move 3 — the principle

The principle: **for every persisted shape, know your migration policy — even if the policy is "regenerate by hand."** The three honest policies:

  1. **Optional-fields-only, forward-only.** Every new field is `?`. No renames, no type changes, no removals. Cheap; works until it doesn't. This is the current policy.
  2. **Read-side migration with schema versions.** Version everything, migrate at the read boundary. Costs a `schemaVersion` field + a `migrate()` per shape. Handles destructive changes safely.
  3. **Rewrite everything on change.** Regenerate all committed JSONs from the current agent every time the shape changes. Works if regeneration is scripted; a horror if it's manual.

Policy 1 is where this repo is. Policy 2 is where it should move the moment a destructive change ships. Policy 3 is where the demo seeds effectively are (regenerate-by-hand), which is why they're a modeling weakness.

## Primary diagram — the migration surface, ranked

```
  Every committed shape in this repo — migration risk, ranked

  ────────────────────────────────────────────────────────────────────────
  artifact                          risk         current    fix path
                                                 policy
  ────────────────────────────────────────────────────────────────────────
  lib/state/demo-*.json             MEDIUM       manual     scripts/bake-*
    (demo mode seeds)                            regen                 +
                                                             schemaVersion

  eval/receipts/*.json              MEDIUM       narrow-    move Receipt
    (28 files, cross-run             (aggregator  shield    to eval/types.ts
     comparison used)                 accident)               + version field

  eval/baseline.json                LOW-MEDIUM   rubric     baseline.
    (regression gate reference)                  version    rubricVersion +
                                                 lives in   gate refuses to
                                                 rubric     compare across

  eval/goldens/*.ts                 LOW         optional-  compile checks
    (TypeScript, compile-checked)                only       most drift for
                                                            us

  public/demo/*.json                LOW         bake       already scripted
    (coverage baked fixture)                    script      via
                                                            scripts/bake-
                                                            demo-coverage.ts

  eval/calibration/*.json           LOW         manual     versioned per-run
    (worksheet + agreement)                     regen       already; safe
  ────────────────────────────────────────────────────────────────────────

  Legend:
    MEDIUM = destructive change here will silently break something
    LOW    = destructive change will fail loud, or the pattern is scripted
```

## Elaborate

Where the pattern comes from: read-side migration is Fowler's *Schemaless Data Migration* pattern from the NoSQL literature — it's what MongoDB, Couchbase, and the "no migrations" school of database use in place of `ALTER TABLE`. The core idea: **store the version alongside the data, migrate at the read boundary, never touch the write side until compaction time.** This lets you deploy the migration code and the schema change in the same commit, with no lockstep between "code deploy" and "data migration ran successfully."

The reason this codebase is *close* to that pattern without formalizing it: TypeScript's `?` gives you a subset of it (the additive case). What's missing is the version discriminator that lets you handle non-additive changes. That's a ~50-line addition that pays off the first time you rename or retype a field.

The reason not to add it *today*: it costs 3 files and 30 minutes; the payoff is zero until the first destructive change. YAGNI applies. The reason to *know it exists*: when the destructive change comes, you don't want to invent this at that moment — you want to have decided it in advance and cut the change in one PR.

Related reading: Martin Fowler on *Evolutionary Database Design* — the same principles ported to a schemaless world. Also worth: the Rails ActiveRecord community's decade of learning that "always add a `NOT NULL default` in migrations" — which is the same lesson as "always mark new fields optional in TypeScript."

## Interview defense

### Q1 — "you have committed JSON on disk. What's your migration story?"

> Optional-fields-only, forward-only. Every new field on `Insight`, `Anomaly`, `Recommendation` is declared with `?`, so old committed JSONs — the demo seeds, the eval receipts, the baseline — still validate against the current types. Adding a field is safe; renaming or retyping isn't.
>
> That's fine for where I am (hackathon-scale, ~40 committed data files, all under my control). It's *not* a strategy for destructive changes. When those come, the move is read-side migration: add a `schemaVersion` field to each persisted shape, add a `migrate(oldVer, data) → currentVer` at the read boundary, keep the historical migrations forever. Then a rename is a version bump, not a lockstep code-plus-data migration.

```
  the ladder of migration policies

  today:   optional-fields-only              works until destructive
  next:    schemaVersion + read-side migrate  handles all changes
  never:   rewrite all files on change        breaks the moment you
                                               forget one
```

Anchor: "today = forward-only; when destructive, add schemaVersion at the read boundary."

### Q2 — "what's the specific migration risk you're carrying today?"

> Two, both in file 02's shape-drift finding. First: `Diagnosis` and `Investigation.diagnosis` are two shapes for the same conceptual entity in the same file. If someone edits one, the other doesn't follow, and the demo `demo-investigations.json` seed will silently validate against the older sibling type. Nothing catches that.
>
> Second: the eval receipts have no exported `Receipt` type. The aggregator declares a *narrow* type locally, which accidentally forward-shields it against added fields, but a rename in the receipt shape would silently make the baseline aggregate empty on that dimension. Nobody would notice unless they eyeball the numbers.
>
> Both are latent, not live. The fix for both is the same: version + type-check at the read boundary.

Anchor: "two live shape-drift risks, both fixable with a `schemaVersion` + `migrate` pair."

### Q3 — "walk me through renaming `Insight.headline` to `Insight.title`."

> Today, one PR:
>
>   1. Rename in `lib/mcp/types.ts:41`.
>   2. Find-replace `headline` → `title` across the codebase (~50 sites: components, tests, agent prompts).
>   3. Regenerate `demo-insights.json` — this is the trap. There's no script; it's a hand-edit or "run the app, screenshot, copy JSON." I'd have to add a `scripts/bake-demo-insights.ts` for this to be safe.
>   4. Regenerate golden receipts — `eval/goldens/*.ts` use `Anomaly` not `Insight`, so no change here.
>   5. Regenerate `eval/baseline.json` — only if the rename touches a rubric dimension name. `headline` → `title` doesn't, so baseline is fine.
>
> That's uncomfortable — step 3 is the risky one, and it doesn't scale. Under Phase B (read-side migration), same rename becomes:
>
>   1. Bump `schemaVersion` on `Insight` from `'1'` to `'2'`.
>   2. Rename in types.
>   3. Add `migrateInsightV1toV2` that maps `.headline` → `.title`.
>   4. Nothing else. Demo seeds and old receipts continue to load because the read boundary migrates them lazily.
>
> That's the migration-cost delta: today's rename touches ~50 sites AND requires regenerating a seed I don't have a script for; Phase B's rename touches 3 sites and skips regeneration entirely.

```
  today's rename cost vs Phase B's rename cost

  today:                          Phase B:
  ──────                          ────────
  1 type rename                   1 type rename
  ~50 call sites                  1 migrate() case
  1 seed regen (no script!) ←  1 schemaVersion bump
  ~200 lines of diff              ~10 lines of diff
```

Anchor: "the read-side-migration pattern turns a 50-site change into a 3-site change."

## See also

- `02-normalization-and-duplication.md` — the shape drift between `Diagnosis` and `Investigation.diagnosis` is the specific migration hazard.
- `04-transactions-and-integrity.md` — the type guards this file assumes at the read boundary.
- `06-access-patterns-and-storage-choice.md` — why "commit JSON, migrate on read" is even viable at this scale.
- `07-data-modeling-red-flags-audit.md` — the "no `schemaVersion` anywhere" red flag is marked here.
