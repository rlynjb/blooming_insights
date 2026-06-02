# Data modeling red-flags audit

**Industry name(s):** Red-flag audit · data-model debt checklist · model smells
**Type:** Capstone · Language-agnostic

> The consolidated checklist. The seven concepts in this guide each name one or more red flags. This file collapses them into one ranked list, scored against THIS repo. **The model is small and the wins are real** — but the worst items (the Insight↔Anomaly leak, the missing cross-Map invariant, the dual-shape `Diagnosis`) are concentrated in three files and one design choice (the wire-format bridge). Fixing all three would take an afternoon and would retire the bulk of the data-modeling debt in the codebase.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A red-flag audit is the one place to step back and rank: of all the smells named across the seven concepts, which ones actually matter for this repo right now? Some are real debt (the leak, the missing invariant). Some are honest "not yet exercised" gaps (no DB constraints, no migration tooling). Some are non-issues at this scale (no normalization at the persistence layer because there's no persistence). The ranking matters: a flat list teaches less than a ranked one that says where to start.

```
  Zoom out — the audit, by severity

  ┌─ CRITICAL (real debt; data loss or invariant broken) ────┐
  │  1. Insight↔Anomaly field-copy leak (3-place, lossy)      │
  └────────────────────────────────────────────────────────────┘

  ┌─ HIGH (real debt; will bite at scale or under change) ───┐
  │  2. Dual-shape Diagnosis (same name, different schema)    │
  │  3. Missing cross-Map invariant (insights ↔ anomalies)    │
  │  4. affectedCustomers ghost field (declared, never written)│
  └────────────────────────────────────────────────────────────┘

  ┌─ MEDIUM (smells, not bugs — naming / discoverability) ───┐
  │  5. Implicit precedence on derived fields (revenueImpact) │
  │  6. Undocumented denormalization (anomalies Map)          │
  │  7. Spec ↔ code drift on Recommendation (the dual spec)   │
  └────────────────────────────────────────────────────────────┘

  ┌─ NOT YET EXERCISED (honest gaps; deferred, not violations)│
  │  8. No DB constraints (no FKs, no UNIQUE, no NOT NULL)    │
  │  9. No migration tooling (markdown prompts are the proxy) │
  │  10. No query / index layer (no DB to query against)      │
  │  11. No transaction layer (in-memory Maps; single-thread)  │
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

### #1 — Insight↔Anomaly field-copy leak (CRITICAL)

**The finding.** The same field list lives in three files: `Anomaly`/`Insight` interfaces in `lib/mcp/types.ts`, `anomalyToInsight` in `lib/state/insights.ts` L8–L28, and `insightToAnomaly` in `app/api/agent/route.ts` L29–L31. `anomalyToInsight` copies 8 fields; `insightToAnomaly` copies only 4 and silently drops `evidence`, `impact`, `history`, `category`. The round-trip is lossy. TypeScript can't catch it because the dropped fields are optional.

**Where covered:** file 02 (this guide) re-frames the software-design audit's findings as a normalization problem.

**Severity:** CRITICAL. Adding a new optional field to `Anomaly` silently drops it on every route round-trip until someone notices. The bug is invisible to tests that don't explicitly round-trip every field.

**The fix (concrete):**
```
  step 1: colocate insightToAnomaly into lib/state/insights.ts
          alongside anomalyToInsight

  step 2: write both as inverses with a shared field-copy helper:
          const FIELD_COPY: (keyof Anomaly & keyof Insight)[] =
            ['metric','scope','change','severity','evidence',
             'impact','history','category'];
          (TypeScript checks the intersection; adding a field to
           BOTH is now one source of truth)

  step 3: write a round-trip test: for every Anomaly, expect
          insightToAnomaly(anomalyToInsight(a)) deep-equals a
          on the copied fields. catches drift on every future add.

  step 4 (better, retires the leak entirely): change the wire format
          so the route accepts only the insightId (not the full Insight
          JSON), and looks it up from anomalies Map → demo seed.
          insightToAnomaly disappears. (this requires the storage
          choice in file 06 to be more durable, which is its own move.)
```

**Time to fix:** ~1 hour for steps 1–3. ~half a day for step 4 (if the storage layer becomes Postgres+Drizzle, see file 06).

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

### #3 — Missing cross-Map invariant (HIGH)

**The finding.** `lib/state/insights.ts` keeps two parallel Maps (`insights` and `anomalies`) that should stay in lockstep — every key in `insights` should have a matching key in `anomalies` when `rawAnomalies` was passed. `putInsights` clears + inserts both non-atomically; nothing checks the invariant. Today it holds because Node is single-threaded and the loop has no I/O. The moment that changes, it doesn't.

**Where covered:** files 02 and 04.

**Severity:** HIGH. Today it's correct by accident. A future refactor (adding `await` between clears, splitting the put across functions, sharing the store across workers) breaks it silently.

**The fix (concrete):**
```
  option A — make the invariant testable:
    add a debug helper assertParallelMaps() called from a test fixture
    that runs after putInsights. catches drift in tests.

  option B — eliminate the parallel store:
    extend Insight with the raw Anomaly as a nested field, or pull
    the raw Anomaly out into an `evidence_raw` slot on Insight.
    one Map, one invariant — the cross-Map invariant disappears.

  option C — graduate to a real store:
    Postgres + FK + ON DELETE CASCADE retires this completely.
    see file 06's buildable target.
```

**Time to fix:** ~1 hour for option A. ~half a day for option B. Option C is the file-06 migration.

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

### #8–11 — Not yet exercised (HONEST GAPS)

These are not violations. They're places where the topic genuinely doesn't apply to this repo's substrate. Naming them honestly matters more than fabricating a finding.

**#8 — No DB constraints.** No relational store, no FKs, no UNIQUE, no NOT NULL, no CHECK. The closest analogs are TypeScript at compile time and the three guards in `validate.ts` at the LLM seam. Cover in file 04.

**#9 — No migration tooling.** No `migrations/` folder, no Drizzle/Prisma, no rollback story. The closest analogs are git diffs on `types.ts` (with the "always optional" rule), the agent prompts evolving alongside the types, and the committed demo seed staying valid. Cover in file 05.

**#10 — No query / index layer.** No DB queries because no DB. The closest analog is the static EQL recipes in `categories.ts` (bundled multi-metric recipes) and the McpClient TTL cache (exact-match content cache). Cover in file 03.

**#11 — No transaction layer.** The in-memory Maps don't have transactions. Today this is fine because Node is single-threaded and the write path has no I/O — but it's not an enforced property. Cover in file 04.

**For all four:** when these stop being honest gaps and become actual needs (the user expects briefings to persist; concurrent writers appear; a new access pattern emerges), the buildable target is Postgres + Drizzle + Vercel Postgres (or Supabase, or Neon). Rein has shipped exactly that pattern in AdvntrCue. Cover in file 06.

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
A: The Insight↔Anomaly field-copy list, encoded in three places: the `Anomaly` interface in `lib/mcp/types.ts` (truth source), `anomalyToInsight` in `lib/state/insights.ts` L8–L28 (copies 8 fields), and `insightToAnomaly` in `app/api/agent/route.ts` L29–L31 (copies 4, drops 4). The round-trip is silently lossy and TypeScript can't catch it because the dropped fields are optional. It's the same finding the software-design audit names (`study-software-design/03-information-hiding-and-leakage.md`), seen through the data-modeling lens instead of the information-hiding lens. The fix is mechanical (colocate the conversions with a shared field-copy helper + a round-trip test) or strategic (fix the wire format so no conversion is needed, which also retires two other smells).

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

- `01-the-data-model-and-its-shape.md` — the 8 interfaces audited here.
- `02-normalization-and-duplication.md` — findings #1, #2, #4, #5, #6.
- `03-indexing-vs-query-patterns.md` — finding #10 (no query layer; the EQL recipes as the cousin).
- `04-transactions-and-integrity.md` — findings #3, #8, #11.
- `05-migrations-and-evolution.md` — findings #7, #9.
- `06-access-patterns-and-storage-choice.md` — the storage migration that retires #3, #8, #11, and reduces #1 to a triviality.
- `study-software-design/03-information-hiding-and-leakage.md` — the same #1 finding, framed as an information leak.
- `study-software-design/08-red-flags-audit.md` — the design-side capstone; this guide's capstone is the data-side complement.
