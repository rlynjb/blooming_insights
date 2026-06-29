# Audit — data modeling red flags, applied to this repo

Capstone of the data-modeling guide. Each section walks one lens, names
what the code does (or doesn't do), and links to the concept file with
the deep walk. Verdict per lens; severity per finding.

Severity legend: **R** red flag (real risk today) · **L** latent
(safe today, structurally weak) · **C** cosmetic · **OK** intentional
and right · **N/A** lens doesn't apply here.

---

## Lens 1 — the data model and its shape

**Verdict: OK.** The schema is TypeScript interfaces in `lib/mcp/types.ts`
plus `lib/mcp/schema.ts` and `lib/mcp/events.ts`. Five entities, one wire
format, one join key (`Insight.id`). Both data sources (Bloomreach,
synthetic) satisfy the same `WorkspaceSchema` interface — the contract
is the duck-type, enforced at the seam.

→ see [`01-the-data-model-and-its-shape.md`](./01-the-data-model-and-its-shape.md)
for the entity graph + line-by-line type reading.

**Findings:**

- **[OK]** Type-as-schema is the right framing for a no-DB app; every
  layer reads against the same interfaces.
- **[OK]** The duck-typed interface (`WorkspaceSchema`) lets two adapters
  (live MCP, in-process synthetic) substitute freely. `lib/mcp/schema.ts:8-25`.
- **[L]** `evidence: { tool: string; result: unknown }[]` uses `unknown` as
  the escape hatch. Flexible — but the UI defensively scans for
  `{ current, prior }` shapes, so an unknown shape causes silent
  degradation (`--` placeholders). Fix path: replace `unknown` with a
  discriminated union over the known tool families.
- **[C]** The field name `evidence` is overloaded across `Anomaly`,
  `Insight`, and `Diagnosis` with two different shapes (`{tool,result}[]`
  vs `string[]`). Rename `Diagnosis.evidence` to `evidenceBullets` for
  clarity.

---

## Lens 2 — normalization and duplication

**Verdict: mostly OK, one latent risk.** The `Anomaly → Insight`
widening is deliberate denormalization done right: one writer
(`anomalyToInsight`), source immutable after emit, derived view kept in
the same Map for cheap reads. The risky duplication is
`Insight.affectedCustomers` vs `Diagnosis.affectedCustomers.count` —
two independent estimates with no reconciliation.

→ see [`02-normalization-and-duplication.md`](./02-normalization-and-duplication.md)
for the four duplication policies walked one at a time.

**Findings:**

- **[OK]** `anomalyToInsight` (`lib/state/insights.ts:25-45`) — single
  writer, source immutable, derived fields computed once. Textbook
  denormalization-as-cache.
- **[OK]** `insightToAnomaly` deliberately **drops** evidence/impact/
  history/category. Information-hiding done well — the diagnostic
  agent can't accidentally depend on a field outside its contract.
  `lib/state/insights.ts:52-55`.
- **[L]** `Insight.affectedCustomers` (a number) and
  `Diagnosis.affectedCustomers.count` (inside an object) are two
  independent estimates. The comment claims "denormalized from
  Diagnosis" but no code writes the diagnosis count back to the
  insight. Fix path: when diagnosis completes, update the insight's
  `affectedCustomers` to match (single writer, single source).
  `lib/mcp/types.ts:58,99`.
- **[L]** Demo JSON files (`lib/state/demo-{insights,investigations}.json`)
  duplicate the runtime type shape — must stay in sync with `types.ts`
  but no test enforces it. See lens 5.
- **[C]** `evidence` field naming reused across three types. Same shape
  on Anomaly/Insight, different shape on Diagnosis.

---

## Lens 3 — indexing vs query patterns

**Verdict: OK.** The Map shape exactly matches the access pattern:
every UI read is `(sessionId, insightId)`, both lookups are O(1). The
two-level Map (outer keyed by `sessionId`, inner Maps keyed by
`insightId`) supports the natural clustering — clearing a session is
one operation, not a scan. No secondary indexes exist because no read
in the app uses a secondary attribute as the key.

→ see [`03-indexing-vs-query-patterns.md`](./03-indexing-vs-query-patterns.md)
for the per-route access-pattern walk + the substrate cache details.

**Findings:**

- **[OK]** `Map<sessionId, SessionFeed>` matches the per-user access
  pattern; outer Map scoping prevents cross-session bleed.
- **[OK]** Three sub-Maps (`insights`, `investigations`, `anomalies`)
  all keyed by `insightId` — the join is "look up by the same key in
  each Map."
- **[OK]** Substrate response cache (`BloomreachDataSource.cache`, 60s
  TTL) keyed by `name + JSON.stringify(args)` deduplicates repeat
  bootstrap calls during a briefing. `lib/data-source/bloomreach-data-source.ts:122-188`.
- **[L]** `getCachedInvestigation` reads the entire dev-cache JSON file
  on every cache miss (`lib/state/investigations.ts:22-28`). Fine for
  dev with <100 entries; would show in flamegraphs if it grew. Lift
  the parse into module init when needed.
- **[N/A]** No N+1 query patterns — there's no loop issuing per-row
  queries because the app doesn't have per-row reads in the first
  place.
- **[N/A]** No `EXPLAIN`-style query plans to audit; no SQL.

---

## Lens 4 — transactions and integrity

**Verdict: weaker than it looks, but acceptable for now.** Integrity is
enforced by three layers: TypeScript types (compile-time), `validate.ts`
runtime guards on LLM output, per-session Map isolation. There are no
atomicity guarantees on multi-write operations like `putInsights` — but
because all state is recomputable from the substrate, partial-state
corruption is repaired by the next briefing.

→ see [`04-transactions-and-integrity.md`](./04-transactions-and-integrity.md)
for the three-layer integrity model + the gaps nothing enforces.

**Findings:**

- **[OK]** TypeScript types catch compile-time construction errors;
  every value built in code passes through the type system.
- **[OK]** `validate.ts` guards LLM output at the untrusted boundary.
  `isAnomalyArray`, `isDiagnosis`, `isRecommendationArray` reject
  shape-wrong values before they enter the store.
  `lib/mcp/validate.ts:17-58`.
- **[OK]** Per-session Map isolation is the strongest guarantee in
  the codebase. The comment in `lib/state/insights.ts:7-13` is
  load-bearing — anyone refactoring must preserve the outer-Map shape.
- **[L]** `putInsights` clear-then-fill is **not atomic**
  (`lib/state/insights.ts:64-71`). A throw midway leaves a partial
  briefing. Acceptable because the next briefing repairs it; would be
  a real bug if the state were durable.
- **[R]** No cross-write check that
  `Insight.affectedCustomers === Diagnosis.affectedCustomers.count`.
  Two estimates, can disagree, UI shows whichever it has access to.
  Fix: write-back in `saveInvestigation`.
- **[L]** No value-range check on `change.value` — agent could emit
  `value: 50000` (a 50000% change) and it'd pass validation. Fix:
  add bounds check in `isAnomalyArray`.
- **[L]** No consistency check between `change.direction` and
  `sign(change.value)`. Agent emitting `{ direction: 'up', value: -5 }`
  passes today.
- **[L]** No whitelist on `evidence[].tool` — typo in tool name passes
  the type guard, renders as unrenderable evidence. Fix: union of
  known tool names in `validate.ts`.

---

## Lens 5 — migrations and evolution

**Verdict: OK, with one test missing.** The codebase has one migration
discipline: every new field is optional. It works because consumers
gracefully handle missing fields. The `EstimatedImpact` discriminated
union is the textbook example of a *shape* change done safely. The gap
is that no test re-validates the demo JSON against the current types —
silent drift is possible.

→ see [`05-migrations-and-evolution.md`](./05-migrations-and-evolution.md)
for the optional-only discipline + the expand-contract pattern walk.

**Findings:**

- **[OK]** Every business-owner enrichment on `Insight` is optional
  (`revenueImpact?`, `aov?`, `funnel?`, `affectedCustomers?`,
  `history?`, `downstreamReady?`, `category?`). Old snapshots still
  parse and render. `lib/mcp/types.ts:55-61`.
- **[OK]** `EstimatedImpact = string | { range, rangeUsd?, assumption }`
  is a deliberate discriminated union by structure that lets old
  string-shaped values and new object-shaped values coexist
  indefinitely. `lib/mcp/types.ts:108-110`.
- **[OK]** Comments above optional fields document when they were added
  and what older snapshots look like. The migration history lives in
  the type, not in git history alone.
- **[R]** No test re-validates `lib/state/demo-{insights,investigations}.json`
  against the current types on commit. Adding a required field to
  `Insight` would silently break demo rendering with no compile or
  runtime error. **Fix:** add `isInsight` to `validate.ts` and a
  Vitest test that asserts every entry conforms.
- **[L]** `WorkspaceSchema` cache (`lib/mcp/schema.ts:138`) is
  process-global. Fine today because each user has one workspace; if
  multi-workspace support ships, the cache returns stale data for the
  second workspace. Fix: key the cache by `projectId`.
- **[N/A]** No migration tool needed; no database to migrate.
- **[N/A]** No backfill scripts; no in-place data transformation. New
  fields land empty on old snapshots and get filled on recapture.

---

## Lens 6 — access patterns and storage choice

**Verdict: OK.** Every storage tier is fit-for-purpose given the access
pattern. The deliberate no-DB choice is justified by the
recomputability property — every data tier the app owns can be rebuilt
from the substrate. The ceiling is named: cross-session reads would
force a real DB.

→ see [`06-access-patterns-and-storage-choice.md`](./06-access-patterns-and-storage-choice.md)
for the six-tier walk + the buildable Postgres target.

**Findings:**

- **[OK]** Browser localStorage `bi:mode` for user preference — ideal
  use of the API.
- **[OK]** Session cookie `bi_session` for per-user scoping —
  necessary for the in-process Map's per-session isolation.
- **[OK]** AES-256-GCM-encrypted auth cookie in prod, gitignored
  plaintext file in dev. The serverless filesystem constraint forces
  the cookie choice; the dev file is ergonomics. `lib/mcp/auth.ts`.
- **[OK]** In-process `Map<sessionId, SessionFeed>` — matches the
  primary-key access pattern; no DB earns its keep yet.
- **[OK]** Committed demo JSON for the reliable presentation path.
  Frozen content, lives with the code, versioned in git.
- **[OK]** Substrate (Bloomreach / synthetic) is the source of truth;
  the app never writes to it.
- **[L]** No story for **cross-session aggregation.** If the product
  grows "show me all critical insights this week across customers,"
  the Map shape stops being right. Buildable target: Postgres with
  `(severity, created_at)` index, types.ts as the schema source of
  truth via Drizzle.
- **[L]** No story for **scheduled / background jobs.** No cron, no
  worker queue. If alerts ("notify me when X drops") shipped, you'd
  need either Vercel Cron + a DB, or a third-party service.

---

## Lens 7 — data-modeling red flags (consolidated checklist)

The cross-cutting list, marked against this repo. The red flags that
matter most for follow-up are starred.

```
  Severity  Finding                                                              Action
  ────────  ────────────────────────────────────────────────────────────────    ─────────────────────────────────────
  R    ★    No test re-validates demo JSON against current types — silent       Add isInsight + Vitest test
            drift possible if a required field is added.
  R    ★    No write-back from Diagnosis.affectedCustomers to                   Update Insight on diagnosis save
            Insight.affectedCustomers — two independent estimates can disagree.
  ────────  ────────────────────────────────────────────────────────────────    ─────────────────────────────────────
  L         WorkspaceSchema cache process-global, not session/project-scoped.   Map<projectId, WorkspaceSchema>
  L         No value-range / consistency checks on change.value vs              Add bounds + cross-field checks
            change.direction.
  L         No whitelist on evidence[].tool — typos pass validation.            Union of known tool names
  L         putInsights is not atomic; partial state on mid-throw.              Acceptable today; revisit if state
                                                                                becomes durable.
  L         No cross-session aggregation path.                                  Buildable target: Postgres + indexes
  L         No background-job story (no cron, no queue).                        Buildable target: Vercel Cron + DB
  L         readJson re-parses entire file on every cache miss in dev.          Lift parse into module init if cache
                                                                                grows.
  ────────  ────────────────────────────────────────────────────────────────    ─────────────────────────────────────
  C         `evidence` field name overloaded across 3 types with 2 shapes.      Rename Diagnosis.evidence →
                                                                                evidenceBullets.
  C         `result: unknown` on evidence entries — flexible but the UI         Discriminated union over known tool
            silently degrades when shape isn't recognized.                      result shapes.
  ────────  ────────────────────────────────────────────────────────────────    ─────────────────────────────────────
  OK        TypeScript types as schema source of truth.                         Keep.
  OK        Per-session Map isolation.                                          Keep — comment in lib/state/insights.ts
                                                                                is load-bearing documentation.
  OK        Anomaly → Insight widening — single writer, source immutable.       Keep.
  OK        validate.ts runtime guards on LLM output.                           Keep.
  OK        Optional-only additive type evolution.                              Keep — extend with the JSON test
                                                                                above.
  OK        DataSource interface lets adapters substitute.                      Keep — enables the synthetic fixture.
  OK        Substrate-as-truth justifies the no-DB choice.                      Keep — until the access pattern flips.
```

---

## What to fix first

If you do exactly one thing from this audit, do **the demo JSON
validation test**. It's the smallest amount of work (30 minutes) for
the largest reduction in silent-drift risk. Add `isInsight` to
`validate.ts`, write a Vitest test that loads
`lib/state/demo-insights.json` and asserts every entry passes. Same
for `Investigation` and the demo-investigations file.

If you do two things, also fix the **`affectedCustomers` write-back**.
The denormalization comment promises a consistency that nothing
enforces; closing the loop in `saveInvestigation` is mechanical and
removes a real source of UI confusion.

If you do three, scope the **`WorkspaceSchema` cache** by `projectId`.
It's not biting today, but it's the kind of latent bug that surfaces
the day a customer has two workspaces and complains the wrong schema
shows up.

Everything else is L or C — known, named, fine to defer.

---

## What this audit isn't

This audit covers the **shape** of persistent data. It deliberately
doesn't cover:

- **Which datastore to pick** if you grew one — that's system-design.
  `06-access-patterns-and-storage-choice.md` names the buildable
  target; the system-design study guide should walk the choice.
- **Algorithm-level data structures** (heaps, trees, graphs) — that's
  DSA foundations. The Map-of-Maps here is the *access shape*, not the
  *algorithm shape*.
- **Cache invalidation as a system-wide concern** — only the data-side
  invariants live here. The TTL choice for the substrate cache is a
  performance-engineering call.
- **Schema-as-prompt** — when the agents read `WorkspaceSchema` to
  decide what to query, that's a prompt-engineering concern. The
  shape of `WorkspaceSchema` itself is this audit's scope.
