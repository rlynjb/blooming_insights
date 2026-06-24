# Normalization and duplication

**Industry name(s):** Normalization · single source of truth · denormalization · the "same fact, two places" smell · derived data
**Type:** Industry standard · Language-agnostic

> The DB analog of information hiding. A normalized model stores each fact once; a denormalized one duplicates a fact deliberately to make a read faster. The original framing of this file (2026-06-01) was "this repo has no relational store, but the pattern shows up in the typed shapes — the **Insight↔Anomaly field-copy list** lives in three files and the round-trip is silently lossy." Two things have changed since then. **(1) The schema-side leak has been partly fixed**: `insightToAnomaly` is now colocated with `anomalyToInsight` in `lib/state/insights.ts`, a doc comment names the drop, and `test/state/insights.test.ts` carries the round-trip. The field-copy list now lives in *two* files (the interface and the colocated functions), not three, and the drift is tested. **(2) The brief 2026-06-16 second domain (Olist SQL, 3NF + FKs) is gone** as of PR #8 (commit 62c24d7). The "two relational analogs" framing is back to "one typed-shape analog"; the textbook 3NF contrast case no longer exists in this repo. This file still walks the schema-side story; the wire-format leak is still where the cost remains.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** This concept lives at the **agent loop ↔ route handler ↔ state module** seam. The agent emits an `Anomaly`; the state module stores it as an `Insight`; the route handler converts back to `Anomaly` to feed a downstream agent. Three crossings, three implicit copies of the same field list — and only the first one (the interface in `types.ts`) is a single source.

```
  Zoom out — where the duplication sits

  ┌─ Agent loop band ──────────────────────────────────────┐
  │  monitoring agent emits Anomaly[]                       │
  └──────────────────────────┬─────────────────────────────┘
                             │ Anomaly[]
  ┌─ State module band ──────▼─────────────────────────────┐
  │  lib/state/insights.ts                                  │
  │  anomalyToInsight()    ← COPY #1: 8 fields forward      │
  │  insightToAnomaly()    ← COPY #2: 4 fields back (DROPS 4│
  │                          — now colocated, doc-commented,│
  │                          and tested in insights.test.ts)│
  │  Map<sessionId, { insights, anomalies, investigations }>│
  └──────────────────────────┬─────────────────────────────┘
                             │ Insight to UI, then over the wire as
                             │ ?insight=<JSON>, then back to route
  ┌─ Route handler band ─────▼─────────────────────────────┐
  │  app/api/agent/route.ts: resolveAnomaly()               │
  │  → JSON.parse(?insight=) + insightToAnomaly()           │
  │    (still drops 4 fields — the loss is now SHIPPED      │
  │     across the URL, not just across modules)            │
  └────────────────────────────────────────────────────────┘
                  ▲
                  │  AND in the background:
                  │  lib/mcp/types.ts owns the canonical field list
                  │  (the interface itself)  ← THE TRUTH SOURCE
```

**Zoom in — narrow to the concept.** The question this concept answers: when you add a field to `Anomaly`, how many files have to change in lock-step? In a fully normalized model, the answer is 1 (the interface). In the 2026-06-01 version of this repo, the answer was **3** (the interface, two conversion functions in two files) and TypeScript only caught the first. **Today the answer is 2** — the interface and one file (`lib/state/insights.ts`) that holds both conversions. The two functions can still drift from each other (TypeScript still can't catch the drop because the fields are optional), but the round-trip test in `test/state/insights.test.ts` does. The remaining problem is at the wire-format boundary: the route still reads the dropped fields off the URL param, the four-field projection is still the data that reaches the diagnostic agent. The schema's not the leak source anymore; the wire format is.

---

## Structure pass

**Layers.** Same four-layer stack. The duplication sits at one seam (route ↔ state) plus a parallel "shadow store" pattern (`anomalies` Map alongside `insights` Map).

**Axis: redundancy.** For each fact in the model, how many places store or copy it? Redundancy is the right axis because normalization is *literally* about counting copies. Pick any field — say `Anomaly.evidence` — and trace it: defined once in `types.ts`, copied once in `anomalyToInsight`, dropped silently in `insightToAnomaly`. Three locations involved, only two with the value. That count IS the audit.

**Seams.** Three matter. **Seam 1: types.ts ↔ the field list.** Single owner — clean. **Seam 2: state ↔ route field-copy.** Same fact, two implementations — the leak. **Seam 3: `anomalies` Map ↔ `insights` Map.** A parallel store that holds the *same* anomaly twice — once as a raw `Anomaly`, once embedded as the copied fields inside `Insight`. That's a *deliberate* denormalization (the route needs the raw evidence back for the diagnostic agent), but it isn't documented as one.

```
  Structure pass — redundancy across seams

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  UI · Route · Agent loop · MCP wrapper                    │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  redundancy: how many places store or copy this fact?     │
  │  1 = normalized; 2+ = denormalized (intentional or leak)  │
  └─────────────────────────────┬────────────────────────────┘
                                │  trace across seams
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  S1: types.ts owns the field list      ★ NORMALIZED       │
  │  S2: state ↔ route field-copy          ★ LEAKED (the bug) │
  │  S3: anomalies Map ↔ Insight fields    ★ DENORMALIZED     │
  │                                          (intentional)    │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — How it works
```

---

## How it works

### Move 1 — duplication, three flavors

You know how a Postgres view is just a pre-computed SELECT — same data as the base tables, surfaced in a friendlier shape? That's *intentional* denormalization. Now imagine someone wrote that view as a triggered INSERT into a second table, and then someone else wrote a different INSERT into a third table that has *almost* the same columns but drops a few. The three tables drift; nothing connects them at the schema level. That's the leak. Same shape here, except the "tables" are TypeScript interfaces and the "INSERTs" are conversion functions.

```
  three flavors of duplication — and which one is which here

  FLAVOR              DEFINITION                       IS IT A PROBLEM?
  ──────────────────  ───────────────────────────────  ────────────────────
  normalized          fact lives in 1 place            no — this is the goal
  denormalized        fact deliberately copied for     no IF documented and
  (intentional)       a read-path performance win        single-source-of-truth
                                                         is named
  leaked              same fact in N files, no single  YES — invariant has
  (accidental)        owner, no enforcement that they    no enforcer; drift
                      agree                              is invisible
```

In this repo:

- The `Insight` interface itself **(normalized)** — types.ts is the truth source for the field list.
- The `anomalies` Map alongside the `insights` Map **(intentional denormalization)** — the route needs the raw `Anomaly` back to feed the diagnostic agent, and copying-into-Insight is lossy by design (the headline gets derived, the evidence stays opaque). Storing both is *correct*. It just isn't named as a deliberate denormalization in the code.
- The Insight↔Anomaly field-copy across `anomalyToInsight` and `insightToAnomaly` **(leaked)** — the field list is implicitly co-owned by two functions, and TypeScript can't enforce that they agree.

### Move 2 — the worst case, walked (UPDATED — fix has landed in code)

The Insight↔Anomaly field-copy list. **Two locations now (was 3), only one is the truth source. The drift is now tested.**

```
  the field list — two locations, with the test as the third enforcer

  ┌─ lib/mcp/types.ts ─────────────────────────┐
  │  interface Anomaly {                        │
  │    metric, scope, change, severity,         │  ← TRUTH SOURCE
  │    evidence, impact?, history?, category?   │     (the 8 fields)
  │  }                                          │
  └─────────────────────────────────────────────┘
                       │
        ┌──────────────┴───────────────┐
        │                              │  both colocated in
        ▼                              ▼  lib/state/insights.ts
  ┌─ anomalyToInsight ──┐    ┌─ insightToAnomaly ──┐
  │ COPIES ALL 8:       │    │ COPIES 4:           │
  │   severity          │    │   metric            │
  │   metric            │    │   scope             │
  │   change            │    │   change            │
  │   scope             │    │   severity          │
  │   evidence          │    │ DROPS 4 (deliberate│
  │   impact            │    │   per the doc       │
  │   history           │    │   comment on L47-52)│
  │   category          │    │   evidence          │
  │                     │    │   impact            │
  │ + derives 5 more    │    │   history           │
  │ + deriveInsightFields│   │   category          │
  └─────────┬───────────┘    └─────────┬───────────┘
            │                          │
            └────────────┬─────────────┘
                         │
                         ▼
              ┌─ test/state/insights.test.ts ─┐
              │  round-trip suite — catches    │  ← THIRD ENFORCER
              │  drift on every future change  │     (the test)
              └────────────────────────────────┘
   lib/state/insights.ts L25–L55 (both functions, same module)
```

**What breaks if you add `affectedCustomers` to `Anomaly` (updated trace):**

```
  the change-amplification trace, today

  1. lib/mcp/types.ts            ← interface change
     ✓ TypeScript demands every Anomaly literal include the field
     ...UNLESS the field is marked optional. If optional, the compiler
     stays quiet. Both functions still compile.

  2. lib/state/insights.ts       ← add copy line in anomalyToInsight
                                    AND in insightToAnomaly (if you
                                    want it carried back). BOTH in
                                    the same file now.
     ✗ TypeScript does NOT enforce this.
     ✓ The round-trip test in test/state/insights.test.ts WILL fail
       if the field roundtrips lossy — drift is caught at test time
       instead of at "two days later in production."

  RESULT: the test is the integrity check the compiler can't be.
  This is the same shape as relational integrity: a CHECK constraint
  is what a NOT NULL constraint would be at compile time, but
  enforced at insert time. Here the round-trip test is the CHECK
  constraint at commit time.
```

This is still **change amplification** — but now bounded: one file's worth of edits, with a test gate. The fix is the textbook way to retire a multi-place field-copy: colocate, then assert the invariant. What it did NOT retire: the wire format still sends and receives the full `Insight` JSON via `?insight=`, the route still calls `insightToAnomaly()` on the parsed param, and the four-field projection is still what reaches the diagnostic agent. The smell moved from "schema duplicated across files" to "schema's lossy projection is the wire contract." See the next sub-section.

### Move 2.5 — the wire format is now the leak source

The route handler's `resolveAnomaly()` in `app/api/agent/route.ts` (L35–L60) walks four sources to find the anomaly the user clicked. The **first** source — the highest-priority one — is `?insight=<JSON>` from the browser's `sessionStorage`. The browser ships the full Insight; the route runs `JSON.parse` + the 4-field shape check + `insightToAnomaly`; the 4-field projection is what feeds the diagnostic agent. The other three sources (per-session `anomalies` Map, per-session `insights` Map, demo seed) ALL eventually call `insightToAnomaly` too when the raw Anomaly isn't available.

```
  the wire-format-as-leak — what's actually shipped vs what survives

  ┌─ briefing page ───────────────────────────────────────┐
  │  insight = { id, timestamp, severity, headline,         │
  │              summary, metric, change, scope, source,    │
  │              evidence:[...], impact:"...", history:[...],│
  │              category:'revenue_drop',                   │
  │              revenueImpact:{...}, aov:{...}, funnel:{...}}│
  │              ← 12+ fields                               │
  │  sessionStorage.setItem('selectedInsight', JSON(insight))│
  │  navigate(`/investigate?id=X&insight=${encodeURIComponent(JSON(insight))}`)│
  └──────────────────────────┬──────────────────────────────┘
                             │ URL carries the full JSON (~500-2000 bytes)
                             ▼
  ┌─ route handler ───────────────────────────────────────┐
  │  resolveAnomaly:                                        │
  │    JSON.parse(insightParam)            ← full Insight    │
  │    isPlausibleInsight(parsed)?         ← 4-field check   │
  │    return insightToAnomaly(parsed)     ← DROPS 4 FIELDS │
  │                                          (evidence,      │
  │                                           impact, history,│
  │                                           category)      │
  └──────────────────────────┬──────────────────────────────┘
                             │ Anomaly with empty evidence[]
                             ▼
  ┌─ diagnostic agent ────────────────────────────────────┐
  │  sees: metric, scope, change, severity, evidence=[]    │
  │  does NOT see: the original evidence that found this   │
  │                anomaly. has to re-query the data.       │
  └────────────────────────────────────────────────────────┘
```

The four dropped fields traveled across the URL, hit the route, and got thrown away. The diagnostic agent then has to re-discover the same evidence with a fresh tool call — a wasted round-trip against a 1 req/s rate limit. The schema-side fix retired the *invisible* loss; the wire-format-side loss is **visible** (the code comment names it) but still costly. The next move is to fix the wire format to ship `?id=<insightId>` and rely on the per-session `anomalies` Map for the lookup. The session-scoped state (file 04) makes that lookup safe — different users no longer share a single map.

### Move 2 — the intentional denormalization (not a bug)

The `anomalies` Map in `lib/state/insights.ts` (L6) stores raw `Anomaly` objects keyed by `Insight.id`. The route handler reaches for it via `getAnomaly(insightId)` (L48) when the user clicks an insight and the diagnostic agent needs to investigate. This is a denormalization — every `Anomaly`'s data is *also* stored embedded inside its `Insight`. Why not just walk back from `Insight`?

```
  why the parallel store exists

  ┌─ Anomaly ──────────────┐
  │ metric, scope, change, │
  │ severity, evidence,    │
  │ impact?, history?,     │
  │ category?              │  ← 8 fields, fully agent-emitted
  └────────────┬───────────┘
               │ anomalyToInsight
               ▼
  ┌─ Insight ──────────────┐
  │ id, timestamp, ...     │
  │ severity, metric,      │
  │ change, scope,         │
  │ evidence?, impact?,    │  ← 4 of 8 carried (when present)
  │ history?, category?    │
  │ + headline, summary,   │
  │   source               │  ← 3 derived from Anomaly fields
  │ + revenueImpact?, ...  │  ← 6 derived/optional Tier 1 fields
  └────────────────────────┘

  reverse path: Insight → Anomaly would require:
    - reversing the headline derivation  (lossy — capitalization, spacing)
    - reversing the summary derivation   (lossy)
    - reconstructing evidence            (POSSIBLE — it's carried forward)
    - reconstructing the raw structure   (NO — evidence's `result: unknown`
                                          is opaque to the conversion)

  so the parallel store is correct: the agent's raw Anomaly is the
  source of truth for evidence and the diagnostic agent wants it
  intact. storing both IS the right call. it just isn't named as a
  deliberate denormalization in the code.
```

What breaks if `anomalies` and `insights` Maps drift out of sync — say `putInsights` inserts an Insight but the parallel `anomalies` set fails halfway: `getAnomaly()` returns null for an insightId that has a valid `getInsight()` answer, and the route handler falls back to `insightToAnomaly` (the lossy path). That's an integrity invariant the in-memory store has no way to enforce (file 04 picks this up).

### Move 2 — the derived-field denormalization

`Insight` has 6 derived fields (`revenueImpact`, `aov`, `funnel`, `affectedCustomers`, `history`, `downstreamReady`). The "source" for each is either the agent's evidence or a separate agent's output. `deriveInsightFields()` in `lib/insights/derive.ts` computes one of them (`revenueImpact`) from `Anomaly.evidence` at write time; the others are either agent-emitted or denormalized from a downstream call (`affectedCustomers` is "denormalized from Diagnosis.affectedCustomers.count" per the comment at types.ts L58).

```
  derived fields — who owns them, in priority order

  field              source                              who owns it
  ──────────────     ────────────────────────────        ──────────────────
  revenueImpact?     COMPUTED from Anomaly.evidence      derive.ts (one place)
                     at write time
                     (only when metric matches REVENUE_RE
                      AND direction === 'down')

  aov?               agent-emitted (no derivation fn)    monitoring agent
  funnel?            agent-emitted                       monitoring agent
  history?           agent-emitted                       monitoring agent
                     OR copied from Anomaly.history      anomalyToInsight
                                                          (when present)

  affectedCustomers? DENORMALIZED from                   the comment names it;
                     Diagnosis.affectedCustomers.count   no code path actually
                                                         denormalizes it today.
                                                         the field exists on
                                                         Insight; nothing
                                                         writes it.

  downstreamReady?   agent-route-stamped                 the route that runs
                                                         the investigation
```

What breaks: the comment says `affectedCustomers` is denormalized from `Diagnosis`, but no function in the repo actually does this denormalization (grep for `affectedCustomers =` finds zero writes). The field is declared, the comment is aspirational, the code path doesn't exist. This is a **mid-migration shape** — the interface has been extended for a future write path that hasn't shipped. File 05 covers the pattern (interfaces leading the code).

### Move 2 — the dual-shape Diagnosis (a normalization smell)

The `Diagnosis` interface in `types.ts` has rich `hypothesesConsidered: { hypothesis, supported, reasoning }[]`. The nested `Investigation.diagnosis` shape (also in `types.ts`) has `hypothesesConsidered: string[]`. Same name, different schema.

```
  the dual-shape smell

  standalone Diagnosis (types.ts L95–L104)
    hypothesesConsidered: { hypothesis: string;
                            supported: boolean;
                            reasoning: string }[]

  embedded in Investigation (types.ts L132–L141)
    diagnosis: {
      conclusion: string;
      evidence: string[];
      hypothesesConsidered: string[];        ← LOSSY projection
    }

  what happens when you flatten:
    { hypothesis: "X", supported: true, reasoning: "Y is up 30%" }
      → "X"  (just the hypothesis string)
    you lose the supported flag and the reasoning paragraph.

  is this a deliberate projection or a drift?
    - if deliberate: rename to DiagnosisSummary, write the projection fn,
      have one place own it
    - if drift: replace Investigation.diagnosis with the full Diagnosis
      type, accept the breaking change in any stored Investigation

  current state: same name, different shape — the worst of both worlds.
```

### Move 3 — the principle

Normalization is information hiding for data. The test is the same: **search the codebase for the field list and count occurrences.** One = normalized. Two with one of them named as a deliberate denormalization = correct denormalization. Two or three with no single owner = a leak. In this repo, the `Insight` field list occurs in three files (types, state, route); two of them are not enforced by the compiler. That's the audit, and it's exactly the same finding the software-design audit names — the lens is different (data shape vs information hiding), the bug is the same.

---

## Primary diagram

The duplication audit, ranked.

```
  Normalization audit — ranked

  NORMALIZED (good)
  ─────────────────────────────────────────────────────────────
  1. The interface definitions in types.ts
     8 interfaces, one file, single source of truth for the model.

  2. The CATEGORIES registry in lib/agents/categories.ts
     10 rows, one file. Both the agent prompts (via the checklist)
     and the coverage gate read from this one source.

  3. The schemaCapabilities projection
     Set<string> is computed once from WorkspaceSchema; coverageFor
     reads it. No fact about "what events the workspace has" is
     stored twice.

  INTENTIONAL DENORMALIZATION (correct, but undocumented)
  ─────────────────────────────────────────────────────────────
  1. anomalies Map alongside insights Map (lib/state/insights.ts L6)
     The raw Anomaly is kept so the diagnostic agent can have the
     evidence intact. Correct — but not commented as a deliberate
     denormalization. Add a one-line comment.

  2. The Insight headline + summary + derived fields
     Computed once at write time, stored on the Insight, read N
     times by the UI. Correct: the alternative is recomputing on
     every render.

  LEAKED (debt — drift is invisible)
  ─────────────────────────────────────────────────────────────
  1. Insight↔Anomaly field-copy list                ★ WORST
     three locations:
       lib/mcp/types.ts                  (the interface)
       lib/state/insights.ts L8–L28      (anomalyToInsight)
       app/api/agent/route.ts L29–L31    (insightToAnomaly DROPS 4)
     fix: colocate both functions in lib/state/insights.ts; write
          a round-trip test; OR fix the wire format so the route
          accepts just the insightId (no conversion needed).

  2. Diagnosis vs Investigation.diagnosis           ★ DUAL-SHAPE
     same name, different schema. types.ts L95 vs L132.
     fix: rename the embedded one DiagnosisSummary and write the
          projection function; or unify on the full Diagnosis.

  3. affectedCustomers ghost-field
     declared on Insight (types.ts L59), commented as "denormalized
     from Diagnosis", no code path actually writes it.
     fix: ship the write path or remove the field until it's wired.
```

---

## Implementation in codebase

### Both copy functions, now colocated

```
lib/state/insights.ts  (lines 25–55)

  export function anomalyToInsight(a: Anomaly): Insight {
    const id = crypto.randomUUID();
    const sign = a.change.direction === 'down' ? '-' : '+';
    const headline = `${a.scope.join(' ')} ${a.metric} · ${sign}${Math.abs(a.change.value)}%`.toLowerCase();
    return {
      id, timestamp: new Date().toISOString(),
      severity: a.severity,        ← COPY
      headline,                     ← derived
      summary: ...,                 ← derived
      metric: a.metric,             ← COPY
      change: a.change,             ← COPY
      scope: a.scope,               ← COPY
      source: 'monitoring',         ← stamped
      evidence: a.evidence,         ← COPY
      impact: a.impact,             ← COPY
      history: a.history,           ← COPY
      category: a.category,         ← COPY
      ...deriveInsightFields(a),    ← +5 derived (currently only revenueImpact)
    };
  }

  /**
   * Reverse mapper. Intentionally drops evidence/impact/history/category —
   * the agent loop only needs metric/scope/change/severity to investigate;
   * the rest is regenerated downstream. The dropped fields are tested in
   * test/state/insights.test.ts (round-trip suite).
   */
  export function insightToAnomaly(i: Insight): Anomaly {
    return { metric: i.metric, scope: i.scope, change: i.change,
             severity: i.severity, evidence: [] };
  }
       │
       └─ both functions, one module, one doc comment naming the drop.
          the test/state/insights.test.ts round-trip catches drift on every
          future change. the schema-side leak is retired.
```

### The intentional denormalization — the parallel Maps

```
lib/state/insights.ts  (lines 4–6, 30–42)

  const insights = new Map<string, Insight>();
  const investigations = new Map<string, Investigation>();
  const anomalies = new Map<string, Anomaly>();   ← parallel store
       │
       │ no comment names why the parallel exists. it's because:
       │   - Insight is lossy (evidence stays carried but everything
       │     else is derived/denormalized)
       │   - the diagnostic agent wants the original Anomaly
       │   - so we keep both, keyed by the same id
       │
       └ add a one-line comment: "raw Anomaly kept alongside Insight
         so the diagnostic agent can investigate from the original
         agent output (Insight is a UI-friendly enriched view)."

  export function putInsights(items: Insight[], rawAnomalies?: Anomaly[]): void {
    insights.clear();
    anomalies.clear();
    items.forEach((i, idx) => {
      insights.set(i.id, i);
      if (rawAnomalies?.[idx]) anomalies.set(i.id, rawAnomalies[idx]);
    });
  }
       │
       └─ the parallel insert. the integrity invariant: every key in
          `insights` should have a matching key in `anomalies` IF
          rawAnomalies is passed. file 04 picks up what enforces that.
```

### The derived-field denormalization — revenueImpact

```
lib/insights/derive.ts  (lines 27–40)

  const REVENUE_RE = /revenue|sales|gmv|total_price|spend/i;

  export function deriveInsightFields(anomaly: Anomaly): Partial<Insight> {
    const out: Partial<Insight> = {};
    const cp = findCurrentPrior(anomaly.evidence);   ← scan evidence array
    if (cp && REVENUE_RE.test(anomaly.metric) && anomaly.change.direction === 'down') {
      out.revenueImpact = {
        lostUsd: Math.round(cp.current - cp.prior),   ← computed at write time
        expectedUsd: Math.round(cp.prior),
        currency: 'USD',
      };
    }
    return out;
  }
       │
       └─ this IS the denormalization: revenueImpact is a stored projection
          of evidence + metric + change. computed once at write, read N times
          by the UI. correct denormalization — the input (evidence) is also
          kept on the Insight, so the projection is reproducible if the rules
          change. (the agent can also emit revenueImpact directly; precedence
          is "spread last wins" — the derived value overrides the agent's.)
```

---

## Elaborate

The deeper pattern here is that **derived-field denormalization with no precedence rule is itself a leak.** `Insight.revenueImpact` can be set by three paths: (a) the monitoring agent emits it in the JSON; (b) `deriveInsightFields()` computes it from evidence; (c) some future code might compute it from the diagnostic agent's output. Today the precedence is whatever-runs-last-wins (the spread `...deriveInsightFields(a)` in `anomalyToInsight` overrides whatever the agent emitted). That's an implicit rule. A future contributor adding the third path would have to reverse-engineer which wins. Make it explicit: name a single owner per derived field and stamp the others as fallbacks.

The Insight↔Anomaly leak is *also* a wire-format leak in disguise. The reason the route handler converts `Insight` back to `Anomaly` is that the browser ships the entire `Insight` JSON in a query parameter (`?insight=...`) when navigating to the investigate page. The route doesn't trust that the in-memory `anomalies` Map will have the entry (it might not — Vercel cold start), so it accepts the client-provided shape. If the route accepted just the `insightId` and looked up *whichever store has it* (in-memory → demo seed), the conversion function disappears and the leak retires. The data model is fine; the wire format is the leak source.

A note on storage choice and normalization: in a relational store, the right design here would be *one* `insights` table with a JSONB `evidence` column (the LLM-generated structure is too variable to normalize further). The `anomalies` data lives entirely inside `Insight.evidence` — there's no row that exists in `anomalies` but not in `insights`. The parallel `Map` only exists because the in-memory `Insight` is *also* lossy (derived headline, derived summary), so reconstructing the raw `Anomaly` from `Insight` is not a clean round-trip. A relational schema would skip this problem by keeping the raw evidence as the source and projecting headline/summary at read time (a view), not at write time (a stored field).

## Interview defense

**Q: Walk me through the worst normalization smell in this repo.**
A: The Insight↔Anomaly field-copy list. Same fact ("which fields make up the Anomaly-to-Insight crossing") in three places: the `Anomaly` interface in `types.ts`, `anomalyToInsight()` in `state/insights.ts`, and `insightToAnomaly()` in `api/agent/route.ts`. The first is the truth source. The second copies 8 fields and derives 5. The third copies only 4 and silently drops `evidence`, `impact`, `history`, `category`. Add a new field to `Anomaly` and the round-trip drops it; tests pass; nobody notices until the downstream agent looks for the field. TypeScript can't catch this because the dropped fields are optional. The fix: colocate both conversion functions in `lib/state/insights.ts` with a shared field-copy helper, AND write a round-trip test. Better still: fix the wire format so the route doesn't need to convert at all.

```
  diagram while you talk

                  types.ts (Anomaly interface)
                  ← TRUTH SOURCE for the 8 fields
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
  anomalyToInsight (state)     insightToAnomaly (route)
     copies 8                     copies 4, DROPS 4
     derives 5                    (silent loss)

           field-copy list lives in 3 files;
           TypeScript catches the first, not 2/3
```

**Q: When is denormalization correct vs leaked?**
A: Correct when (a) there's a named single owner, (b) the denormalization is for a documented read-path win, and (c) the source of truth is still derivable from the input. The `anomalies` Map parallel to `insights` is correct denormalization — the raw `Anomaly` is needed for downstream agents that the lossy `Insight` shape can't feed. The Insight↔Anomaly field-copy is leaked because the same list lives in three files with no owner. The `revenueImpact` derived field is borderline: it's computed at write time AND the agent might also emit it, with implicit "spread last wins" precedence — make the precedence explicit and it's correct denormalization.

## See also

- `01-the-data-model-and-its-shape.md` — the 8 interfaces and where the truth source lives for each shape.
- `04-transactions-and-integrity.md` — the per-session sub-maps now make the cross-Map invariant safe across users; runtime guards at the LLM seam.
- `06-access-patterns-and-storage-choice.md` — the wire-format decision that's now the leak source; the move to `?id=` plus per-session lookup.
- `08-the-olist-relational-schema.md` — RETIRED. Historical pattern (3NF, FKs as the contrast case).
- `11-in-process-synthetic-fixture.md` — the SyntheticDataSource: no normalization story (in-memory const literal, no FK, no joins) — the contrast case is now "flat fixture vs typed agent contract."
- `study-software-design/audit.md#information-hiding-and-leakage` — the original framing of the same leak as an information-hiding problem.

---
Updated: 2026-06-16 — schema-side leak status moved from "WORST" to "partly fixed in code"; added Move 2.5 on the wire format as the remaining leak source.
Updated: 2026-06-19 — dropped the Olist 3NF contrast-case framing (the schema is removed); the file's core story (Insight↔Anomaly + wire-format leak) is unchanged.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
