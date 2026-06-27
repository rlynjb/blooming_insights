# Data modeling red-flags audit

**Industry name(s):** Red-flag audit · data-model debt checklist · model smells
**Type:** Capstone · Language-agnostic

> The consolidated checklist, **re-ranked 2026-06-19** after the Olist/eval removal. The previous #1 CRITICAL finding (the `price_brl` unit-in-name failure) has been **resolved-by-deletion** — the Olist schema is gone, the `_brl` columns are gone, the eval pipeline that measured the cost is gone. The Phase 2 activations (FKs, indexes, transactions, designed-against-queries indexes) are also gone — back to "not yet exercised" honest gaps. What's left is the original schema-side audit (the typed `Insight↔Anomaly` contract, the wire-format leak, the dual-shape Diagnosis) plus the **new** in-process synthetic fixture (`lib/data-source/synthetic-data-source.ts`, file 11). The model is smaller again; the wins are concentrated at the agent contract; the debt is the wire format and a handful of typed-shape smells.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A red-flag audit is the one place to step back and rank: of all the smells named across the seven concepts, which ones actually matter for this repo right now? Some are real debt (the leak, the missing invariant). Some are honest "not yet exercised" gaps (no DB constraints, no migration tooling). Some are non-issues at this scale (no normalization at the persistence layer because there's no persistence). The ranking matters: a flat list teaches less than a ranked one that says where to start.

```
  Zoom out — the audit, by severity (2026-06-19)

  ┌─ HIGH (real debt; will bite at change or scale) ──────────┐
  │  1. Wire-format leak (?insight=<JSON> drops 4 fields)      │ ← top finding
  │     (schema-side fix shipped; URL-side conversion remains) │
  │  2. Dual-shape Diagnosis (same name, different schema)     │
  │  3. affectedCustomers ghost field (declared, never written)│
  └────────────────────────────────────────────────────────────┘

  ┌─ MEDIUM (smells; cleanup-while-you're-in-there) ──────────┐
  │  4. Implicit precedence on derived fields (revenueImpact)  │
  │  5. Undocumented denormalization (anomalies sub-Map)       │
  │  6. Spec ↔ code drift on Recommendation                    │
  │  7. SyntheticDataSource fixture has no determinism contract │ ← NEW (file 11)
  │     (same fixed JSON every call; no seed, no contract test) │
  └────────────────────────────────────────────────────────────┘

  ┌─ RESOLVED since 2026-06-01 ────────────────────────────────┐
  │  • Schema-side Insight↔Anomaly field-copy (was #1 CRIT)    │
  │    → insightToAnomaly colocated in lib/state/insights.ts   │
  │      + doc comment + round-trip test                        │
  │  • Cross-session invariant on the in-memory store           │
  │    → state refactored to Map<sessionId, SessionFeed>        │
  │      + cross-session-isolation test in insights.test.ts    │
  └────────────────────────────────────────────────────────────┘

  ┌─ RESOLVED-BY-DELETION (PR #8, commit 62c24d7) ─────────────┐
  │  • price_brl unit-in-name failure (was #1 CRITICAL)        │
  │    → Olist schema removed; no _brl columns exist           │
  │  • seeded_anomalies description ↔ multiplier drift          │
  │    → seeded_anomalies table removed; eval pipeline removed │
  │  • No EXPLAIN-plan check in CI for the Olist queries        │
  │    → no Olist queries left to plan-check                   │
  └────────────────────────────────────────────────────────────┘

  ┌─ STILL NOT EXERCISED (honest gaps; deferred) ──────────────┐
  │  • DB constraints (FK / NOT NULL) — no DB                  │
  │  • Migrations under live data — no live-write store         │
  │  • Index-vs-query layer — no SQL                            │
  │  • Multi-writer concurrency on shared rows                  │
  │  • Durable storage for UI state (`insights`, `investigations`│
  │    still in per-session memory; cold start still wipes them)│
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this concept answers: where does the data-modeling work actually start? The answer is item #1 — the wire-format leak. It's the highest-severity finding remaining (the old #1, the `price_brl` units bug, is gone with the Olist schema). The leak shows up in three separate audits (this one, `study-software-design/03`, and `study-software-design/08`). Everything else can wait. This file walks the full list, ranked, with the move for each.

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

### #0 — `price_brl` unit-in-name failure (RESOLVED-BY-DELETION)

**Status (2026-06-19).** This was the #1 CRITICAL finding in the 2026-06-16 audit. It is no longer applicable. The Olist MCP server (`mcp-server-olist/`), its `SCHEMA_SQL` (including the `_brl`-suffixed columns), the eval pipeline (`eval/`) that measured the downstream cost, and the agent prompts that disclaimed it were all removed in **PR #8, commit 62c24d7**. No `_brl` column exists in the current codebase; no SQL schema exists at all.

The pattern itself (unit-in-column-name lies cause LLM narration drift) is still real — file 10 keeps the historical write-up with a RETIRED banner. But there is nothing in this repo today to rank against this finding. **Removed from the active ranking.**

### #1 — Wire-format leak (HIGH — now the top remaining finding)

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

### Cross-session integrity invariant (RESOLVED — NOTE)

The original audit's #3 ("Missing cross-Map invariant") has been resolved in code. The state was refactored to `Map<sessionId, SessionFeed>` and `test/state/insights.test.ts` has explicit cross-session-isolation tests. The intra-session invariant ("every insights key has a matching anomalies key when rawAnomalies was passed") is still not enforced, but the bigger bug (one session wiping another) is gone. File 04 has the updated story.

### #3 — `affectedCustomers` ghost field (HIGH)

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

### #4 — Implicit precedence on derived fields (MEDIUM)

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

### #5 — Undocumented denormalization (MEDIUM)

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

### #6 — Spec ↔ code drift on `Recommendation` (MEDIUM)

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

### #7 — SyntheticDataSource fixture has no determinism contract (MEDIUM — NEW)

**The finding.** `lib/data-source/synthetic-data-source.ts` ships an in-process `SyntheticDataSource` that exposes the same tool surface as Bloomreach, returning hand-authored fixture JSON. Today every call to `execute_analytics` / `execute_analytics_eql` returns the **same fixed payload** — the constant `analyticsResult` (L275–L307). There's no seeded PRNG, no per-query variation, no contract test asserting "running this twice produces identical bytes." That's fine for a UI fixture (the demo path wants stability), but the schema-level invariant ("the synthetic source is a deterministic clone of a real Bloomreach response shape") isn't named anywhere.

**Where covered:** file 11 (the new in-process synthetic fixture concept).

**Severity:** MEDIUM. The data is stable today only because it's a constant. The smell is no test, no doc comment, no schema-level statement of "what makes this synthetic data trustworthy." A future edit that introduces `Math.random()` inside `dispatch()` (for, say, faking timestamps) would break determinism silently — and that's the seam the live/synthetic toggle in `lib/data-source/index.ts` depends on.

**The fix:**
```
  step 1: add a doc comment to SyntheticDataSource naming the contract:
    "Every call returns deterministic bytes. The fixture is hand-
     authored, not generated; no PRNG, no Date.now(). If you add
     variation, seed it."

  step 2: add a contract test in test/data-source/synthetic-data-source.test.ts:
    expect(JSON.stringify(await ds.callTool('execute_analytics', {})))
      .toEqual(JSON.stringify(await ds.callTool('execute_analytics', {})))
    runs every CI; catches the day someone introduces non-determinism.
```

**Time to fix:** ~30 min.

### Activated topics — what was "not yet exercised" in 2026-06-01

These were honest gaps a year ago. The Phase 2 Olist DB activated them for real (2026-06-16). The Olist removal (2026-06-18, PR #8) **de-activated** them. They're back to honest gaps:

- **DB constraints.** No DB. Not exercised.
- **Migration tooling.** No DB to migrate. Not exercised.
- **Query/index layer.** No SQL. Not exercised.
- **Transaction layer.** No DB. Not exercised.

The activation history matters: it proves the codebase *can* exercise these patterns (Phase 2 shipped them); the current absence is a deliberate scope choice (synthetic data lives in-process now), not a missing capability.

### Still not exercised — the honest gaps

- **Multi-writer concurrency.** No multi-writer surface anywhere; agents read, the state module writes from one route at a time.
- **Durable storage for UI state.** `insights` / `investigations` still live in per-session in-memory Maps; cold start still wipes them. The buildable target named in 2026-06-01 (Postgres for UI state) has never shipped — Phase 2 shipped it for analytics (Olist) instead, then removed it.

When these stop being honest gaps, the buildable target is still Postgres + Drizzle + Vercel Postgres (or Supabase, or Neon) — the same playbook Rein shipped in AdvntrCue.

### The principle

A red-flag audit isn't about finding every smell. It's about *ranking* them so the work starts on what actually matters. In this repo, the work starts on #1 (the wire-format leak) — high-impact, concrete fix, surfaces across three audits. Everything else can wait. The four "not yet exercised" items aren't debt; they're substrate gaps. Calling them debt would be fabrication. Calling them out as deferred is the honest read.

**A note on resolved-by-deletion.** The 2026-06-16 #1 (`price_brl`) is the cleanest case of "a finding goes away because the code does." It wasn't fixed; it was removed. That's still a legitimate audit outcome — the right action is to mark the finding as no-longer-applicable and rerank, not to keep a phantom item at the top of the list. The historical file (file 10) stays as a pattern artifact; the audit pretends it's not there because, for this repo today, it isn't.

### Code in this codebase

The repo anchors for the top-priority fix targets and the deferred substrate-graduation move.

#### The top-3 fix locations

```
  the fix targets, in priority order (2026-06-19)

  ┌─ #1: the wire-format leak ──────────────────────────────┐
  │  lib/mcp/types.ts                  ← truth source        │
  │  lib/state/insights.ts (colocated) ← both conversions    │
  │  app/api/agent/route.ts            ← resolveAnomaly() –  │
  │                                       wire branch is the │
  │                                       remaining leak     │
  │                                                            │
  │  move: switch wire format to ?id=<insightId>; rely on the │
  │        per-session anomalies Map for the lookup. retires  │
  │        the lossy round-trip end-to-end.                   │
  └────────────────────────────────────────────────────────────┘

  ┌─ #2: the dual-shape ────────────────────────────────────┐
  │  lib/mcp/types.ts L95–L104   ← Diagnosis (rich)          │
  │  lib/mcp/types.ts L132–L141  ← Investigation.diagnosis   │
  │                                  (flat, embedded)         │
  │                                                            │
  │  move: rename the embedded one DiagnosisSummary and add   │
  │        a summarizeDiagnosis() projection function.        │
  └────────────────────────────────────────────────────────────┘

  ┌─ #7: the synthetic determinism contract ────────────────┐
  │  lib/data-source/synthetic-data-source.ts L275–L307      │
  │  test/data-source/synthetic-data-source.test.ts          │
  │                                                            │
  │  move: doc comment naming the "no PRNG, no Date.now()"   │
  │        contract + a byte-equality test on two adjacent   │
  │        callTool() invocations.                            │
  └────────────────────────────────────────────────────────────┘
```

#### The honest-gap fix is one move: graduate the storage

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

## Primary diagram

The capstone — every red flag, by severity and concreteness.

```
  blooming insights — data modeling red flags, ranked (2026-06-19)

  HIGH (do this sprint; real debt, concrete fix)
  ─────────────────────────────────────────────────────────────────
  1. Wire-format leak (?insight=<JSON> still drops 4 fields)
     where:  app/api/agent/route.ts → insightToAnomaly()
     fix:    switch wire format to ?id=<insightId> + session lookup (~2h)
     also:   covered in study-software-design/03 (the original framing)

  2. Dual-shape Diagnosis (same name, different schema)
     where:  lib/mcp/types.ts L95 vs L132
     fix:    rename embedded → DiagnosisSummary, write projection fn (~30m)

  3. affectedCustomers ghost field (declared, never written)
     where:  lib/mcp/types.ts L59
     fix:    remove until wired (~30m)
             OR ship the write path (~2h)

  MEDIUM (smells; while you're in there)
  ─────────────────────────────────────────────────────────────────
  4. Implicit precedence on derived fields (revenueImpact)
     fix:    document the rule in a comment (~15m)

  5. Undocumented denormalization (anomalies Map)
     fix:    add a one-paragraph comment (~5m)

  6. Spec ↔ code drift on Recommendation
     fix:    update the spec to match the code (~20m)

  7. SyntheticDataSource has no determinism contract
     where:  lib/data-source/synthetic-data-source.ts L275–L307
     fix:    doc comment naming the contract + a round-trip test (~30m)

  RESOLVED-BY-DELETION (PR #8, commit 62c24d7 — 2026-06-18)
  ─────────────────────────────────────────────────────────────────
  • price_brl unit-in-name failure (was #1 CRITICAL)
  • seeded_anomalies description ↔ multiplier drift (was #4 HIGH)
  • No EXPLAIN-plan check for the Olist queries (was #9 MEDIUM)

  NOT YET EXERCISED (honest gaps; not debt)
  ─────────────────────────────────────────────────────────────────
  8.  No DB constraints              (substrate-gap; no DB)
  9.  No migration tooling           (substrate-gap; no DB)
  10. No query / index layer         (substrate-gap; no SQL)
  11. No transaction layer           (substrate-gap; no DB)
```

---

## Elaborate

The deeper structural point about this audit: **most of the remaining debt is concentrated in one design choice — the wire-format-as-bridge.** The route accepts `?insight=<JSON>` from the browser; the route converts back to `Anomaly`; the conversion is lossy; the leak follows. Switch the wire format to `?id=<insightId>` and rely on the per-session `anomalies` Map — the conversion disappears, the leak retires, and findings #1, #3, and (partially) #5 collapse into one move. That's the kind of leverage a good audit surfaces — finding the *root* design choice that creates multiple smells, rather than fixing each smell individually.

The "not yet exercised" items aren't filler. They're a deliberate honest read: the topic genuinely doesn't apply to this repo's current substrate, and pretending otherwise would fabricate findings. The right framing is: when does each one stop being deferred and start being debt? The answer for all four is "when the storage choice graduates." Phase 2 graduated it (Olist DB activated four topics); PR #8 retracted it (the topics deactivated). The audit's honest gaps track the substrate, not the wishlist.

A note on what's missing from this audit: **no tests are checked.** A real audit would also check whether the round-trip is tested, whether the cross-Map invariant has a fixture, whether the demo seed validates against the current interface in CI. None of those exist today. The capstone for those would be in `study-testing/`, not here, but a thorough data-modeling audit would feed those test-gap findings forward.

Where the audit lands: this codebase's data-modeling work is *small but mostly clean*. The 8 interfaces are a real schema; the 3 guards do their job; the storage choice is reasonable for the scale. The debt is concentrated in one design choice and three files. That's a healthy ratio — the bones are good; the cleanup is targeted; the buildable target is well-shaped when the time comes.

## Interview defense

**Q: Where's the worst data-modeling problem in this repo today?**
A: The wire-format leak. The browser ships the full `Insight` JSON via `?insight=<JSON>`; the route's `resolveAnomaly()` runs `insightToAnomaly()` on the parsed param; the four-field projection (drops `evidence`, `impact`, `history`, `category`) is what reaches the diagnostic agent. The schema-side half of this finding was resolved in code (`insightToAnomaly` colocated with `anomalyToInsight` in `lib/state/insights.ts`, doc comment naming the drop, round-trip test in `test/state/insights.test.ts`), but the wire shape is unchanged — every investigation pays one extra tool call against the 1 req/s rate limit to recover the dropped evidence. It's the same finding the software-design audit names (`study-software-design/audit.md#information-hiding-and-leakage`), seen through the data-modeling lens instead of the information-hiding lens. The fix is strategic: switch the wire format to `?id=<insightId>` and rely on the per-session `anomalies` Map for the lookup.

**Q: How do you rank what's debt vs what's deferred?**
A: Two scores: severity (impact if left in place) and concreteness (clarity of the fix). High-severity-and-concrete = today. High-and-vague = investigate. Low-and-concrete = while you're in there. "Not yet exercised" = honest gap, not debt — the topic genuinely doesn't apply yet. For this repo, the top-3 are all high-and-concrete: the leak, the dual-shape Diagnosis, the missing cross-Map invariant. The four "not yet exercised" items (no DB constraints, no migrations, no query layer, no transactions) are substrate gaps — they activate when the storage choice graduates, not before.

```
  diagram while you talk

         severity ↑
   high  │ ★ #1 wire leak  │
         │ ★ #2 dual-shape │
         │ ★ #3 ghost field│
   med   │ ★ #4 precedence │
         │ ★ #5 undoc      │
         │ ★ #6 spec drift │
         │ ★ #7 synth det. │
         └─────────────────→ concreteness
                 high

  resolved-by-deletion: separate axis. mark + rerank.
  not yet exercised:    separate axis. fix the substrate, then revisit.
```

## See also

- `01-the-data-model-and-its-shape.md` — the 8 interfaces + `WorkspaceSchema` dual-derivation (Bloomreach + Synthetic).
- `02-normalization-and-duplication.md` — findings #1 (wire-format leak), #4, #5, #6.
- `03-indexing-vs-query-patterns.md` — no SQL → not exercised; the EQL recipes for the upstream remain.
- `04-transactions-and-integrity.md` — session-scoped invariants; agent-contract guards at the LLM seam.
- `05-migrations-and-evolution.md` — git-evolves-types; the spec ↔ code drift on `Recommendation`.
- `06-access-patterns-and-storage-choice.md` — three storage layers (Maps + dev cache + demo seed + in-process synthetic).
- `08-the-olist-relational-schema.md` — RETIRED. Historical pattern (designed-against-queries 3NF).
- `09-deterministic-synthetic-data.md` — RETIRED. The pattern still applies to the new `SyntheticDataSource` (see file 11); the body's mulberry32/SQLite anchors are gone.
- `10-units-in-column-names.md` — RETIRED. The `price_brl` bug is resolved-by-deletion in this repo.
- `11-in-process-synthetic-fixture.md` — the new SyntheticDataSource concept: in-process deterministic fake data through the same agent-facing interface as the live adapter.
- `study-software-design/audit.md#information-hiding-and-leakage` — the original framing of the schema-side leak.

---
