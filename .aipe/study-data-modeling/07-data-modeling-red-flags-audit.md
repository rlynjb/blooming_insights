# Data modeling red-flags audit

**Industry name(s):** Red-flag audit · data-model debt checklist · model smells
**Type:** Capstone · Language-agnostic

> The consolidated checklist, **re-ranked 2026-06-16** after the Phase 2 (Olist DB) and Phase 3 (evals) deltas. Two findings from the original audit have been resolved in code (the schema-side leak, the cross-session invariant). Several "not yet exercised" items have activated for real (FKs, indexes, transactions). One new top finding has surfaced: **the `price_brl` unit-in-name failure**, with a measured downstream cost in the recommendation judge's `impact_sized` score. The model is bigger now (two domains, two persistence layers); the wins are bigger; the debt is more focused.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A red-flag audit is the one place to step back and rank: of all the smells named across the seven concepts, which ones actually matter for this repo right now? Some are real debt (the leak, the missing invariant). Some are honest "not yet exercised" gaps (no DB constraints, no migration tooling). Some are non-issues at this scale (no normalization at the persistence layer because there's no persistence). The ranking matters: a flat list teaches less than a ranked one that says where to start.

```
  Zoom out — the audit, by severity (2026-06-16)

  ┌─ CRITICAL (real debt; measured downstream cost) ──────────┐
  │  1. price_brl unit-in-name failure                         │ ← NEW
  │     (column name lies about units; agent reads as Reais;   │
  │      impact_sized=0 in the recommendation judge)           │
  └────────────────────────────────────────────────────────────┘

  ┌─ HIGH (real debt; will bite at change or scale) ──────────┐
  │  2. Wire-format leak (?insight=<JSON> drops 4 fields)      │ ← was #1, shifted
  │     (schema-side fix shipped; URL-side conversion remains) │
  │  3. Dual-shape Diagnosis (same name, different schema)     │
  │  4. seeded_anomalies description ↔ multiplier drift        │ ← NEW
  │  5. affectedCustomers ghost field (declared, never written)│
  └────────────────────────────────────────────────────────────┘

  ┌─ MEDIUM (smells; cleanup-while-you're-in-there) ──────────┐
  │  6. Implicit precedence on derived fields (revenueImpact)  │
  │  7. Undocumented denormalization (anomalies sub-Map)       │
  │  8. Spec ↔ code drift on Recommendation                    │
  │  9. No EXPLAIN-plan check in CI for the Olist queries      │ ← NEW
  └────────────────────────────────────────────────────────────┘

  ┌─ RESOLVED since 2026-06-01 ────────────────────────────────┐
  │  • Schema-side Insight↔Anomaly field-copy (was #1 CRIT)    │
  │    → insightToAnomaly colocated in lib/state/insights.ts   │
  │      + doc comment + round-trip test                        │
  │  • Cross-session invariant on the in-memory store           │
  │    → state refactored to Map<sessionId, SessionFeed>        │
  │      + cross-session-isolation test in insights.test.ts    │
  │  • "No DB constraints"   → Olist has FK + NOT NULL          │
  │  • "No migration tooling" → drop-and-reseed (legitimate     │
  │     because deterministic + read-only)                      │
  │  • "No query / index layer" → 9 indexes against 3 tools     │
  │  • "No transaction layer"  → SQLite transactions + WAL      │
  └────────────────────────────────────────────────────────────┘

  ┌─ STILL NOT EXERCISED (honest gaps; deferred) ──────────────┐
  │  • Migrations under live data (Olist is read-only + drop-   │
  │    and-reseed; the day either flips, drizzle migrations    │
  │    earn their place)                                        │
  │  • Multi-writer concurrency on shared rows                  │
  │  • Durable storage for UI state (`insights`, `investigations`│
  │    still in per-session memory; cold start still wipes them)│
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this concept answers: where does the data-modeling work actually start? The answer is item #1 — the Insight↔Anomaly leak. It's the highest-severity finding, the most concrete fix, and the one that shows up in three separate audits (this one, `study-software-design/03`, and `study-software-design/08`). Everything else can wait. This file walks the full list, ranked, with the move for each.

---

## Structure pass

**Layers.** Same four-layer stack. The red flags concentrate at two boundaries: the **state ↔ route seam** (the conversion leak, the missing invariant) and the **LLM seam** (the validators are deliberately loose on optionals, which is correct policy but is a smell if misread).

**Axis: severity × concreteness.** For each red flag, two scores: severity (impact if left in place) and concreteness (clarity of the fix). Pick the right axis because the audit is *literally* about ranking — a finding that's high-impact AND has a clear fix is "do this today." High-impact-but-vague is "investigate." Low-impact-with-clear-fix is "while you're in there."

**Seams.** Two matter for the audit specifically. **Seam 1: the state ↔ route boundary.** Where the leak, the missing invariant, and the wire-format-as-bridge all sit. **Seam 2: the validate.ts ↔ LLM boundary.** Where the deliberate looseness can be misread as a debt.

```
  Structure pass — severity × concreteness

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  state ↔ route boundary carries most of the debt          │
  │  validate.ts boundary carries deliberate looseness        │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  severity × concreteness — what to do today vs later     │
  │  high+clear = today; high+vague = investigate;            │
  │  low+clear = while you're in there                        │
  └─────────────────────────────┬────────────────────────────┘
                                │  rank
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  state ↔ route  ★ where most fixes land                  │
  │  LLM boundary   ★ where the looseness is policy, not bug │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — The ranked list
```

---

## How it works

### #1 — `price_brl` unit-in-name failure (CRITICAL — NEW)

**The finding.** The Olist schema declares `order_items.price_brl INTEGER NOT NULL`, `payments.value_brl INTEGER NOT NULL`, and similar columns named `_brl`. The integer is **cents** — the seeder generates values in the range R$15 to R$2,500 stored as 1500..250000 cents. The agent prompts try to disclaim this (`monitoring.md`: "All BRL monetary values are returned as integer cents (e.g. 12450000 is R$ 124 500,00). Divide by 100 when narrating"), but the agent's training data overwhelmingly treats `_brl` as "Brazilian Reais the currency." The model reads the column name as authoritative and the prompt disclaimer as instruction it sometimes drops.

**The measured cost.** `eval/results/2026-06-15/diagnosis-summary.md` showed agent diagnoses narrating R$131,965 AOVs that should have been R$1,319.65 — a 100× scale error that propagates into the recommendation agent's `estimatedImpact`. The recommendation judge's `impact_sized` criterion (`eval/judges/recommendation-judge.md`) penalizes this exact failure mode — and the K=10 baseline run scored 0/10 on the SP-revenue and electronics-spike anomalies that depend on it.

**Severity:** CRITICAL. The downstream cost is measurable (judge scores are committed to `eval/results/`). The failure is in the schema, not in the agent's reasoning — the agent reads the column name correctly; the column name is wrong.

**The fix:** see file 10. Three options:
```
  option A — rename the column:
    price_brl → price_brl_cents (or price_centavos)
    runs through every SQL file + the tool output schemas.

  option B — store as decimal + currency:
    price NUMERIC(10,2) + currency TEXT (always 'BRL')
    invariant becomes "the unit is on the row, not in the name."

  option C — return as Reais in the tool layer:
    keep storage in cents (efficient + exact) but divide by 100 in
    every tool's output. then the wire shape is "_brl is Reais"
    instead of cents, matching the column name's implied semantics.

  option C is the smallest diff; option A is the cleanest.
```

**Time to fix:** ~2 hours for option C. ~half a day for option A (more files touched).

### #2 — Wire-format leak (HIGH, was #1 CRITICAL)

**Status update.** The schema-side half of this finding shipped: `insightToAnomaly` is colocated with `anomalyToInsight` in `lib/state/insights.ts`, a doc comment names the drop, and `test/state/insights.test.ts` has the round-trip test. **What remains** is the wire format itself: the browser still ships the full `Insight` JSON via `?insight=<JSON>`, the route still calls `insightToAnomaly` on the parsed param, and the four fields (`evidence`, `impact`, `history`, `category`) still get dropped — now explicitly, intentionally, but at runtime cost. The diagnostic agent then has to re-query the evidence with an extra tool call.

**Where covered:** file 02 (Move 2.5).

**Severity:** HIGH. The drop is now visible (comments, tests), but the cost is still real: every investigation pays one extra tool call against the 1 req/s rate limit to recover the dropped evidence.

**The fix (concrete):**
```
  switch the wire format from ?insight=<JSON> to ?id=<insightId>.
  the route's resolveAnomaly already walks: wire → session.anomalies →
  session.insights → demo seed. drop the wire-format branch entirely:
  rely on the per-session anomalies Map (file 04 covers the integrity).

  prerequisite: confirm the session-scoped anomalies Map is reliably
  populated by every briefing run before the investigate page loads.
  (it is — putInsights now writes both insights AND anomalies.)
```

**Time to fix:** ~2 hours. The session-scoped state already makes this safe.

### #2 — Dual-shape Diagnosis (HIGH)

**The finding.** `lib/mcp/types.ts` defines `Diagnosis` (L95–L104) with `hypothesesConsidered: { hypothesis, supported, reasoning }[]` — rich. Also defines `Investigation.diagnosis` (L132–L141 inline) with `hypothesesConsidered: string[]` — flat. Same name, different schema. The flat form loses the `supported` flag and the `reasoning` paragraph.

**Where covered:** file 02 (normalization).

**Severity:** HIGH. Anyone reading `Investigation.diagnosis` and assuming it has the full Diagnosis shape will fail at runtime. The `isDiagnosis` guard accepts both because it doesn't validate the inner `hypothesesConsidered` element shape — so the looseness lets the bug travel.

**The fix (two options):**
```
  option A — make them the same shape:
    Investigation.diagnosis: Diagnosis
    accept the breaking change in any stored Investigation (the demo
    seed and dev cache would need re-capture)

  option B — name the projection:
    type DiagnosisSummary = Pick<Diagnosis, 'conclusion' | 'evidence'> & {
      hypothesesConsidered: string[]
    };
    Investigation.diagnosis: DiagnosisSummary
    write the projection function: summarizeDiagnosis(d: Diagnosis): DiagnosisSummary

  option A is cleaner; option B is safer for committed data.
```

**Time to fix:** ~30 min for option B. ~2 hours for option A (re-capture, replace stored data).

### #4 — `seeded_anomalies` description ↔ multiplier drift (HIGH — NEW)

**The finding.** The `seeded_anomalies` table in the Olist DB stores `description TEXT NOT NULL` for each seeded anomaly. The corresponding multiplier (e.g. `_generator.value: 0.7` for SP-revenue-drop) lives **only** in the seed script's `SEEDED_ANOMALIES` constant. The DB row says "Revenue in São Paulo (SP) drops ~30% in week 4"; the seeder applies multiplier 0.7 (a 30% reduction). If a future edit changes the multiplier without updating the description, the eval keeps running against the stale description — and the recall percentage stays valid, but the human reading `seeded_anomalies` is told the wrong thing about what the ground truth means.

**Where covered:** file 09 (this guide's new file on deterministic synthetic data).

**Severity:** HIGH. The DB row is documentation; documentation drift in ground-truth records is a data-modeling smell because the row IS the contract — the evals read it.

**The fix (concrete):**
```
  option A — add the multiplier as a column:
    ALTER TABLE seeded_anomalies ADD COLUMN multiplier REAL NOT NULL;
    populate from SEEDED_ANOMALIES[_].generator.value during seed.
    the description becomes ONE source describing the multiplier;
    the multiplier becomes the authoritative number.

  option B — generate the description from the multiplier:
    SEEDED_ANOMALIES[i].description = describe(SEEDED_ANOMALIES[i].generator)
    one source, multiple projections. drift impossible.
```

**Time to fix:** ~30 min. The fix is one ALTER and one description-builder.

### Cross-session integrity invariant (RESOLVED — NOTE)

The original audit's #3 ("Missing cross-Map invariant") has been resolved in code. The state was refactored to `Map<sessionId, SessionFeed>` and `test/state/insights.test.ts` has explicit cross-session-isolation tests. The intra-session invariant ("every insights key has a matching anomalies key when rawAnomalies was passed") is still not enforced, but the bigger bug (one session wiping another) is gone. File 04 has the updated story.

### #4 — `affectedCustomers` ghost field (HIGH)

**The finding.** `Insight.affectedCustomers?: number` is declared in `lib/mcp/types.ts` L59 with the comment "denormalized from Diagnosis.affectedCustomers.count." No code path in the repo actually writes this field — grep for `affectedCustomers =` finds zero. The field exists; the write doesn't.

**Where covered:** file 02.

**Severity:** HIGH. The UI may render fallback values because the field is always absent; the agent prompts may reference it incorrectly thinking it's available; future readers will assume it works and reach for it.

**The fix (two options):**
```
  option A — ship the write path:
    when an Investigation completes and produces a Diagnosis with
    affectedCustomers.count, update the corresponding Insight in
    place: insights.get(id).affectedCustomers = diag.affectedCustomers.count
    (note: this requires a mutation discipline the current code
     doesn't enforce — the Insight Map values are treated as immutable
     today, by convention only)

  option B — remove the field until it's wired:
    delete the line + the comment. the field can be re-added when the
    write path lands. shipping unused fields is API debt.

  option A is the right call IF affectedCustomers is on the roadmap.
  option B is the right call if it isn't.
```

**Time to fix:** ~30 min for option B. ~2 hours for option A.

### #5 — Implicit precedence on derived fields (MEDIUM)

**The finding.** `Insight.revenueImpact` can be set by: (a) the monitoring agent emitting it in the JSON, (b) `deriveInsightFields()` computing it from evidence, (c) future code computing it from diagnosis. Today the precedence is "spread last wins" — the spread `...deriveInsightFields(a)` in `anomalyToInsight` overrides whatever the agent emitted. That's implicit, not documented.

**Where covered:** file 02.

**Severity:** MEDIUM. Today only one path writes it (the derive function); precedence is theoretical. The smell is that a future contributor adding the third path would have to reverse-engineer the rule.

**The fix:**
```
  step 1: document the precedence in a comment above the spread:
    // PRECEDENCE: derive overrides agent-emitted. the derive function
    // re-computes from evidence which is more reliable than the agent's
    // self-reported number.

  step 2: name the rule for the other derived fields too (aov, funnel,
          affectedCustomers, history, downstreamReady).

  step 3 (optional): make the function explicit:
    return mergeWithDerivePriority(agentEmitted, deriveInsightFields(a))
```

**Time to fix:** ~15 min.

### #6 — Undocumented denormalization (MEDIUM)

**The finding.** The `anomalies` Map in `lib/state/insights.ts` L6 stores raw `Anomaly` objects in parallel with `Insight` objects. This is correct denormalization (the raw evidence is needed for downstream agents) but no comment names it as deliberate. A future contributor reading the code might delete the Map as redundant.

**Where covered:** file 02.

**Severity:** MEDIUM. Today nothing is broken. The risk is a future "cleanup" that breaks the route's fallback chain.

**The fix:**
```
  add a comment above the const:

  // The anomalies Map is a DELIBERATE DENORMALIZATION alongside insights.
  // Insight is a UI-friendly enriched view of Anomaly with derived headline,
  // summary, and Tier 1 fields — the conversion is lossy. The diagnostic
  // agent needs the raw Anomaly's evidence to investigate, so we keep both
  // keyed by Insight.id. resolveAnomaly() in api/agent/route.ts prefers
  // this Map over the lossy insightToAnomaly fallback.
  const anomalies = new Map<string, Anomaly>();
```

**Time to fix:** ~5 min.

### #7 — Spec ↔ code drift on `Recommendation` (MEDIUM)

**The finding.** `blooming-insights-spec.md` defines `Recommendation` twice. The code in `lib/mcp/types.ts` L114–L130 picks the richer one and names the choice in a comment. The spec hasn't been reconciled.

**Where covered:** file 05.

**Severity:** MEDIUM. The comment carries the migration receipt, so a careful editor won't break it. The risk is a sloppy spec-driven "update" by someone who reads the spec first and the code second.

**The fix:**
```
  option A — fix the spec:
    edit blooming-insights-spec.md to remove the older "data model"
    Recommendation definition; have the spec match the code.

  option B — leave the spec, strengthen the comment:
    add a "DO NOT EDIT this interface to match the spec's data-model
    section; the spec is stale" note. the current comment already
    says "use this RICHER one" — make the "don't revert" intent
    explicit.

  option A is better long-term; option B is faster.
```

**Time to fix:** ~20 min for option A.

### #9 — No EXPLAIN-plan check in CI (MEDIUM — NEW)

**The finding.** The 9 indexes in `mcp-server-olist/scripts/seed-olist.ts` are well-chosen against today's three tools. There's no test that runs `EXPLAIN QUERY PLAN` on the canonical queries and asserts they hit an index. A future schema change (a missing `CREATE INDEX` after a column rename, a join predicate added without an index) could regress silently.

**Where covered:** file 03.

**Severity:** MEDIUM. Today's queries are fast. The smell is the missing safety net.

**The fix:** add a test that prepares each canonical query, runs `EXPLAIN QUERY PLAN`, and asserts no `SCAN TABLE` appears. ~30 min.

### Activated topics — what was "not yet exercised" in 2026-06-01

These were honest gaps a year ago. Most are now real. Naming the activations matters:

- **DB constraints.** Olist has FKs (`order_items.order_id → orders(id)`), NOT NULL on every load-bearing column, `PRAGMA foreign_keys = ON`. Active. File 04 covers it.
- **Migration tooling.** Still not exercised in the conventional sense (no `up/down`, no Drizzle). But Olist's "drop-and-reseed" is a legitimate alternative — file 05 names the determinism + read-only invariants that make it work.
- **Query/index layer.** 9 indexes, 3 tools, designed-against-queries discipline. Active. File 03 maps each one.
- **Transaction layer.** Olist seeder wraps bulk inserts in `db.transaction(() => {...})()` (better-sqlite3 sync transactions). Active. WAL gives concurrent-read durability. File 04 covers it.

### Still not exercised — the new honest gaps

- **Migrations under live data.** Olist is read-only at runtime and regenerable. The day the DB starts accepting writes from real users, "drop-and-reseed" stops being a legitimate strategy and Drizzle migrations earn their place.
- **Multi-writer concurrency.** Single-writer (the seeder), many-reader (the tools). No story for "two writers contend on the same row." Out of scope today; in scope the day the DB accepts writes from anywhere but the seeder.
- **Durable storage for UI state.** `insights` / `investigations` still live in per-session in-memory Maps; cold start still wipes them. The Phase-2 work added a relational layer (Olist) for analytics, not for UI. The buildable target named in 2026-06-01 (Postgres for UI state) has shipped only on the analytics side.

When these stop being honest gaps, the buildable target is still Postgres + Drizzle + Vercel Postgres (or Supabase, or Neon) — the same playbook Rein shipped in AdvntrCue.

### The principle

A red-flag audit isn't about finding every smell. It's about *ranking* them so the work starts on what actually matters. In this repo, the work starts on #1 (the Insight↔Anomaly leak) — high-impact, concrete fix, surfaces across three audits. Everything else can wait. The four "not yet exercised" items aren't debt; they're substrate gaps. Calling them debt would be fabrication. Calling them out as deferred is the honest read.

---

## Primary diagram

The capstone — every red flag, by severity and concreteness.

```
  blooming insights — data modeling red flags, ranked

  CRITICAL (do today; high impact + concrete fix)
  ─────────────────────────────────────────────────────────────────
  1. Insight↔Anomaly field-copy leak
     where:  lib/mcp/types.ts ↔ lib/state/insights.ts ↔ app/api/agent/route.ts
     fix:    colocate + helper + round-trip test (~1h)
             OR fix the wire format → leak retires (~½ day)
     also:   covered in study-software-design/03 (the original framing)

  HIGH (do this sprint; real debt, concrete fix)
  ─────────────────────────────────────────────────────────────────
  2. Dual-shape Diagnosis (same name, different schema)
     where:  lib/mcp/types.ts L95 vs L132
     fix:    rename embedded → DiagnosisSummary, write projection fn (~30m)

  3. Missing cross-Map invariant (insights ↔ anomalies)
     where:  lib/state/insights.ts L4–L6
     fix:    assertParallelMaps() in test (~1h)
             OR eliminate the parallel store (~½ day)

  4. affectedCustomers ghost field (declared, never written)
     where:  lib/mcp/types.ts L59
     fix:    remove until wired (~30m)
             OR ship the write path (~2h)

  MEDIUM (smells; while you're in there)
  ─────────────────────────────────────────────────────────────────
  5. Implicit precedence on derived fields (revenueImpact)
     fix:    document the rule in a comment (~15m)

  6. Undocumented denormalization (anomalies Map)
     fix:    add a one-paragraph comment (~5m)

  7. Spec ↔ code drift on Recommendation
     fix:    update the spec to match the code (~20m)

  NOT YET EXERCISED (honest gaps; not debt)
  ─────────────────────────────────────────────────────────────────
  8.  No DB constraints              (substrate-gap; see file 04)
  9.  No migration tooling           (substrate-gap; see file 05)
  10. No query / index layer         (substrate-gap; see file 03)
  11. No transaction layer           (substrate-gap; see file 04)
```

---

## Implementation in codebase

### The top-3 fix locations

```
  the fix targets, in priority order

  ┌─ #1: the leak ──────────────────────────────────────────┐
  │  lib/mcp/types.ts                  ← truth source        │
  │  lib/state/insights.ts  L8–L28     ← copy #1 (rich)      │
  │  app/api/agent/route.ts L29–L31    ← copy #2 (lossy)     │
  │                                                            │
  │  move: colocate the two functions into the state module   │
  │        with a shared FIELD_COPY constant; add round-trip  │
  │        test. fixes the leak in one diff.                  │
  └────────────────────────────────────────────────────────────┘

  ┌─ #2: the dual-shape ────────────────────────────────────┐
  │  lib/mcp/types.ts L95–L104   ← Diagnosis (rich)          │
  │  lib/mcp/types.ts L132–L141  ← Investigation.diagnosis   │
  │                                  (flat, embedded)         │
  │                                                            │
  │  move: rename the embedded one DiagnosisSummary and add   │
  │        a summarizeDiagnosis() projection function.        │
  └────────────────────────────────────────────────────────────┘

  ┌─ #3: the cross-Map invariant ───────────────────────────┐
  │  lib/state/insights.ts L4–L6      ← the parallel Maps    │
  │  lib/state/insights.ts L30–L42    ← putInsights()        │
  │                                                            │
  │  move: add assertParallelMaps() helper + test fixture.    │
  │        documents the invariant and catches drift.         │
  └────────────────────────────────────────────────────────────┘
```

### The honest-gap fix is one move: graduate the storage

```
  the deferred work — when the time comes

  current:     in-memory Maps + JSON-file fallback + demo seed
  buildable:   Postgres (Vercel Postgres / Supabase / Neon)
               + Drizzle for schema + migrations
               + one migration to seed from demo-insights.json

  what this retires:
    - the cross-Map invariant problem (FK + CASCADE)
    - the transaction layer gap (BEGIN / COMMIT)
    - the cold-start durability story (Postgres persists)
    - the wire-format-as-bridge cost (no longer needed)
    - the lossy insightToAnomaly conversion (no conversion needed)
    - the migration story gap (Drizzle's migration files are first-class)

  what it adds:
    - one dependency (Drizzle + the DB driver)
    - one schema file
    - one managed-DB account (Vercel Postgres tier or Supabase)
    - one ops surface (the DB itself)

  prerequisite: a real need for durability. today the demo + portfolio
  context doesn't have one. when the user expects briefings to persist,
  this is the move.
```

---

## Elaborate

The deeper structural point about this audit: **most of the debt is concentrated in one design choice — the wire-format-as-bridge.** The route accepts `?insight=<JSON>` from the browser; the route converts back to `Anomaly`; the conversion is lossy; the leak follows. Fix the storage layer to be durable and the wire format can be just `?id=…`, the conversion disappears, the leak retires. Three findings collapse into one move. That's the kind of leverage a good audit surfaces — finding the *root* design choice that creates multiple smells, rather than fixing each smell individually.

The "not yet exercised" items aren't filler. They're a deliberate honest read: the topic genuinely doesn't apply to this repo's current substrate, and pretending otherwise would fabricate findings. The right framing is: when does each one stop being deferred and start being debt? The answer for all four is "when the storage choice graduates." That's why file 06 names the migration path — it isn't just a storage upgrade; it's the move that activates four "not yet exercised" topics into things worth doing.

A note on what's missing from this audit: **no tests are checked.** A real audit would also check whether the round-trip is tested, whether the cross-Map invariant has a fixture, whether the demo seed validates against the current interface in CI. None of those exist today. The capstone for those would be in `study-testing/`, not here, but a thorough data-modeling audit would feed those test-gap findings forward.

Where the audit lands: this codebase's data-modeling work is *small but mostly clean*. The 8 interfaces are a real schema; the 3 guards do their job; the storage choice is reasonable for the scale. The debt is concentrated in one design choice and three files. That's a healthy ratio — the bones are good; the cleanup is targeted; the buildable target is well-shaped when the time comes.

## Interview defense

**Q: Where's the worst data-modeling problem in this repo?**
A: The Insight↔Anomaly field-copy list, encoded in three places: the `Anomaly` interface in `lib/mcp/types.ts` (truth source), `anomalyToInsight` in `lib/state/insights.ts` L8–L28 (copies 8 fields), and `insightToAnomaly` in `app/api/agent/route.ts` L29–L31 (copies 4, drops 4). The round-trip is silently lossy and TypeScript can't catch it because the dropped fields are optional. It's the same finding the software-design audit names (`study-software-design/audit.md#information-hiding-and-leakage`), seen through the data-modeling lens instead of the information-hiding lens. The fix is mechanical (colocate the conversions with a shared field-copy helper + a round-trip test) or strategic (fix the wire format so no conversion is needed, which also retires two other smells).

**Q: How do you rank what's debt vs what's deferred?**
A: Two scores: severity (impact if left in place) and concreteness (clarity of the fix). High-severity-and-concrete = today. High-and-vague = investigate. Low-and-concrete = while you're in there. "Not yet exercised" = honest gap, not debt — the topic genuinely doesn't apply yet. For this repo, the top-3 are all high-and-concrete: the leak, the dual-shape Diagnosis, the missing cross-Map invariant. The four "not yet exercised" items (no DB constraints, no migrations, no query layer, no transactions) are substrate gaps — they activate when the storage choice graduates, not before.

```
  diagram while you talk

         severity ↑
   high  │ ★ #1 leak       │
         │ ★ #2 dual-shape │
         │ ★ #3 invariant  │
         │ ★ #4 ghost field│
   med   │ ★ #5 precedence │
         │ ★ #6 undoc      │
         │ ★ #7 spec drift │
         └─────────────────→ concreteness
                 high

  not yet exercised: separate axis. fix the substrate, then revisit.
```

## Validate

1. **Reconstruct.** Without opening the files: name the top 3 critical/high red flags by their finding, location, and fix. Which one of them appears in three separate audits (this guide + two software-design files)?

2. **Explain.** Why are items #8–11 ("no DB constraints," etc.) not listed as debt? What's the right framing for them, and when do they become real debt?

3. **Apply.** Pretend you've been hired to spend one day on data-modeling debt in this repo. Pick the top 2 fixes you'd ship, justify the choice with severity-and-concreteness, and name the test you'd write to prevent regression.

4. **Defend.** Someone proposes spending the day adding Zod + a migration tool. Push back: which findings from this audit would Zod/migration tooling actually retire today, and which would it just *prepare* for later? (Hint: Zod retires nothing on the current findings — the guards are loose by deliberate policy, not by sloppiness; migration tooling retires nothing because the storage substrate doesn't exist. Both are pre-investment, not debt-paydown.)

## See also

- `01-the-data-model-and-its-shape.md` — the 8 interfaces + `WorkspaceSchema` dual-derivation.
- `02-normalization-and-duplication.md` — findings #2 (wire-format leak), #5, #6, #7.
- `03-indexing-vs-query-patterns.md` — findings #9 (no EXPLAIN gate); the 9 indexes in detail.
- `04-transactions-and-integrity.md` — Olist FK + WAL; session-scoped invariants.
- `05-migrations-and-evolution.md` — finding #8; drop-and-reseed pattern.
- `06-access-patterns-and-storage-choice.md` — three storage layers; Olist analytics warehouse.
- `08-the-olist-relational-schema.md` — the 7-table schema in detail.
- `09-deterministic-synthetic-data.md` — findings #4 (description ↔ multiplier drift).
- `10-units-in-column-names.md` — finding #1, walked end-to-end with the eval evidence.
- `study-software-design/audit.md#information-hiding-and-leakage` — the original framing of the schema-side leak.

---
Updated: 2026-06-16 — re-ranked the audit post-Phase-2; added #1 (price_brl) and #4 (description drift); promoted "not yet exercised" items #8/#10/#11 to "activated"; named the new honest gaps.
