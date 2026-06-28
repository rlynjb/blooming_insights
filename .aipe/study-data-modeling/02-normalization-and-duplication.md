# 02 — Normalization and duplication

**Single source of truth / deliberate denormalization · Industry standard**

## Zoom out, then zoom in

Normalization is the *data* analog of information-hiding in code: store
every fact in exactly one place so it can't disagree with itself. The
classic violation is the same row's `total` not matching `SUM(line_items)`
— two places that hold the same fact, drifting apart over time.

```
  Zoom out — where duplication can leak in this codebase

  ┌─ Substrate (Bloomreach / Synthetic) ─────────────┐
  │  Raw events — owned by the substrate, not us     │
  │  (we never duplicate these)                       │
  └────────────────────┬─────────────────────────────┘
                       │  agents query
  ┌─ Agent + state layer ───────────────────────────┐
  │  Anomaly  ──widen──►  Insight   ★ THIS CONCEPT ★ │ ← we are here
  │  (raw)                (enriched + denormalized)   │
  │                                                   │
  │  Investigation { insightId, diagnosis,           │
  │                  recommendations }                │
  │  (also keyed by insightId)                        │
  └────────────────────┬─────────────────────────────┘
                       │  NDJSON stream
  ┌─ UI ────────────────▼────────────────────────────┐
  │  reads, never mutates → no duplication concern   │
  └──────────────────────────────────────────────────┘
```

Zoom in. There are exactly **two duplication policies** worth auditing in
this repo: the deliberate `Anomaly` → `Insight` widening (denormalization
for read speed) and a handful of accidental overlaps that the schema *could*
let drift. The first is correct; the second is what the audit hunts.

---

## Structure pass — the axis is "who can mutate this fact?"

```
  Trace the mutation axis — for any duplicated fact, ask:

  ┌─ source of truth ─┐    seam     ┌─ derived copy ────┐
  │ ★ MUTABLE here ★  │ ═══════════►│ READ-ONLY here    │   safe (cache)
  └───────────────────┘             └───────────────────┘

  ┌─ original ────────┐    seam     ┌─ derived copy ────┐
  │ MUTABLE here      │ ═══════════►│ ★ ALSO MUTABLE ★  │   RED FLAG
  └───────────────────┘             └───────────────────┘
                                    (drift possible)
```

A duplication is safe when only one side can be written. The Insight
widening is safe (the agent never re-edits an Anomaly after emitting it).
The places where two writers exist — the audit names them in
`audit.md`.

---

## How it works

### Move 1 — the mental model

Think of it like the `useState` + `useMemo` pattern in React. You don't
re-derive `expensive(x)` on every render; you cache it. But you also don't
let the cache go stale — the cache key depends on the source. Same idea
here: `Insight` is a `useMemo`-style derived view of `Anomaly`, materialized
into the store so the UI doesn't recompute it on every render.

```
  The widening pattern — one source of truth, one derived view

         ┌──────────────┐
         │   Anomaly    │   the FACT (what changed, by how much)
         │   (source)   │   minimal contract for the diagnostic agent
         └──────┬───────┘
                │  anomalyToInsight (lib/state/insights.ts:25)
                │   ├─ mints an id
                │   ├─ derives headline + summary from change
                │   ├─ runs deriveInsightFields → revenueImpact when applicable
                │   └─ copies evidence/impact/history/category verbatim
                ▼
         ┌──────────────┐
         │   Insight    │   the VIEW (what the UI renders)
         │  (derived)   │   superset of Anomaly + display fields
         └──────────────┘

         BOTH are kept in the session Map, indexed by the same id.
         Anomaly is the input the diagnostic agent needs;
         Insight is what the feed and the investigate page render.
```

The rule: derived data is fine to materialize when (a) the derivation isn't
free, (b) the source never mutates after creation, (c) the cost of storing
both is bounded. All three hold here.

### Move 2 — the duplication policies, one at a time

#### **Policy 1: `Anomaly` → `Insight` widening (deliberate, correct)**

The most visible duplication is also the cheapest to defend. Read the
widening function with the headers in mind:

```typescript
// lib/state/insights.ts:25-45
export function anomalyToInsight(a: Anomaly): Insight {
  const id = crypto.randomUUID();
  const sign = a.change.direction === 'down' ? '-' : '+';
  const headline = `${a.scope.join(' ')} ${a.metric} · ${sign}${Math.abs(a.change.value)}%`.toLowerCase();
  return {
    id,
    timestamp: new Date().toISOString(),
    severity: a.severity,
    headline,
    summary: `${a.metric} ${a.change.direction} ${Math.abs(a.change.value)}% vs ${a.change.baseline}`.toLowerCase(),
    metric: a.metric,
    change: a.change,
    scope: a.scope,
    source: 'monitoring',
    evidence: a.evidence,
    impact: a.impact,
    history: a.history,
    category: a.category,
    ...deriveInsightFields(a),
  };
}
```

Annotation by line:

- **L26 `crypto.randomUUID()`** — the `id` doesn't exist on `Anomaly`; it's
  minted here. This is the join key downstream (Diagnosis, Recommendation,
  AgentEvent cache all use it).
- **L27–28 `headline` + `summary`** — *derived strings* from
  `change.direction` + `change.value`. The fact (`change`) is also kept in
  full one field down. Why both? The headline is a presentation choice
  (lowercased, sign-prefixed) that's easier to compute once than re-format
  in every card render.
- **L31 `change: a.change`** — copied **by reference**. The source object
  is shared, not cloned. Safe because nobody mutates an `Anomaly` after
  emit, but it means a future mutation here would leak into the `Insight`.
  See audit.md → integrity.
- **L33–37 evidence/impact/history/category** — *passed through unchanged*.
  Same fields, same names, same shapes. This is the "no transformation"
  duplication.
- **L38 `...deriveInsightFields(a)`** — spreads in `revenueImpact` (and
  future business-owner fields) computed from the evidence. Fully derived
  — no new facts, just re-shaped existing ones.

```
  What's duplicated, and what its policy is

  field         | Anomaly       | Insight       | policy
  ──────────────┼───────────────┼───────────────┼──────────────────────
  metric        | yes (source)  | yes (verbatim)| pass-through
  scope[]       | yes (source)  | yes (verbatim)| pass-through
  change{}      | yes (source)  | yes (verbatim)| pass-through (shared ref)
  severity      | yes (source)  | yes (verbatim)| pass-through
  evidence[]    | yes (source)  | yes (verbatim)| pass-through (shared ref)
  impact?       | yes (source)  | yes (verbatim)| pass-through
  history?      | yes (source)  | yes (verbatim)| pass-through
  category?     | yes (source)  | yes (verbatim)| pass-through
  headline      |       —       | DERIVED       | computed from change/scope
  summary       |       —       | DERIVED       | computed from change/baseline
  id            |       —       | MINTED        | randomUUID
  timestamp     |       —       | MINTED        | now()
  revenueImpact?|       —       | DERIVED       | from evidence[].current/prior
```

The verdict on this duplication: **safe and right.** Anomalies are
emitted once at briefing time and never mutated; Insights are
write-once-per-briefing too (the `putInsights` function clears the
session sub-map and rebuilds). The lifecycle is "create both together,
read until next briefing, discard both together." There's nowhere for
them to drift.

Reverse mapping exists too:

```typescript
// lib/state/insights.ts:52-55
export function insightToAnomaly(i: Insight): Anomaly {
  return { metric: i.metric, scope: i.scope, change: i.change, severity: i.severity, evidence: [] };
}
```

This deliberately **drops** evidence/impact/history/category — the comment
above it states the policy: the diagnostic agent only needs
`metric/scope/change/severity` to investigate; the rest is regenerated
downstream. That's information-hiding done well — the diagnostic agent
can't *accidentally* depend on a field that wasn't part of its contract.

#### **Policy 2: `Insight.affectedCustomers` denormalized from `Diagnosis.affectedCustomers.count`**

This is the duplication worth scrutinizing. The same number lives in two
places:

```typescript
// lib/mcp/types.ts:58
affectedCustomers?: number; // denormalized from Diagnosis.affectedCustomers.count

// lib/mcp/types.ts:99
affectedCustomers?: { count: number; segmentDescription: string };
```

`Insight.affectedCustomers` is a *number*; `Diagnosis.affectedCustomers`
is an object with `{count, segmentDescription}`. The number on `Insight`
is meant to be the `count` from the diagnosis, copied up so the feed card
can render "9,340 customers affected" without loading the investigation.

```
  The denormalization chain

  Diagnosis.affectedCustomers.count  ── (sometime later) ──►  Insight.affectedCustomers
       │                                                            │
       │   source of truth (diagnostic agent emits this)             │   cached copy (feed card reads)
       │                                                            │
       └──────────────── must stay in sync ─────────────────────────┘

  The risk: there's no code in the repo today that writes
  Insight.affectedCustomers FROM Diagnosis. The comment says
  "denormalized from" but the wiring isn't enforced — it's set
  when the agent emits the insight, before diagnosis exists.
```

This one is **safe in practice today but structurally weak.** The
monitoring agent emits `Insight.affectedCustomers` based on its own
estimate (from `Anomaly.evidence`); the diagnostic agent later emits
`Diagnosis.affectedCustomers` based on its deeper investigation. They can
*and do* disagree — the monitoring estimate is rough, the diagnosis is
refined. The comment "denormalized from Diagnosis" is aspirational, not
enforced.

The fix that would close the loop: when diagnosis finishes, write its
count back to the Insight (a real denormalization with a single writer
path). Until that exists, treat the two values as *independent
estimates*, not one canonical fact. The audit flags this.

#### **Policy 3: the demo JSON files duplicate live state shape**

`lib/state/demo-insights.json` (665 lines) and
`lib/state/demo-investigations.json` (3,487 lines) hold a frozen snapshot
of what a real briefing produced. The duplication is **schema duplication**
— the JSON is *shaped* like `Insight[]` / `Investigation` because it was
written that way by the capture script. The runtime types and the
committed JSON must agree, or the demo replay breaks.

```
  Demo JSON as a frozen "view" of the live type system

  lib/mcp/types.ts          ─── must agree ───►   lib/state/demo-insights.json
       │                                                  │
       │  source of truth                                 │  derived snapshot
       │  (the TypeScript types)                          │  (committed JSON)
       │                                                  │
       └──── add a required field on Insight, ────────────┘
             and the demo snapshot stops validating;
             the demo branch in production breaks.

  Migration discipline: new fields are OPTIONAL so old snapshots
  still parse. See 05-migrations-and-evolution.md.
```

The duplication is *safe by discipline*, not by enforcement — there's no
test that re-validates the demo JSON against the current `Insight` type
on every commit. Adding a required field today would break the demo
silently (the JSON would parse as a plain object, the field would be
`undefined`, and the UI would render empty). The discipline is:
**every new `Insight` field lands as optional, full stop.** The audit
notes that this discipline could be enforced as a test.

#### **Policy 4: the `evidence` field is overloaded**

This isn't duplication of data; it's duplication of the **name**:

```typescript
// lib/mcp/types.ts:48
evidence?: { tool: string; result: unknown }[];     // Insight.evidence — tool envelopes

// lib/mcp/types.ts:88
evidence: { tool: string; result: unknown }[];      // Anomaly.evidence — same shape

// lib/mcp/types.ts:97
evidence: string[];                                  // Diagnosis.evidence — markdown bullets
```

Two different shapes, same field name, all live in `types.ts`. A reader
sees `evidence` in a function signature and has to look at the surrounding
type to know which one it is. The audit flags this as a minor renaming
opportunity (e.g. `Diagnosis.evidence` → `Diagnosis.evidenceBullets`); it
hasn't bitten anyone yet because the consumer code is short.

### Move 3 — the principle

**Denormalization is a cache, not a redefinition.** When you duplicate a
fact deliberately — `Insight` carrying both `change` and `headline`, or
`affectedCustomers` appearing on both `Insight` and `Diagnosis` — the
right framing is: *there is one source of truth and one or more derived
views, and the views can be rebuilt from the source.*

The discipline that keeps denormalization safe is **a single writer per
derived view, and a clear path back to the source.** The
`anomalyToInsight` widening is a textbook example — one function does the
copy, no other code path mutates the derived view. The
`Insight.affectedCustomers` policy is the textbook counter-example today —
two independent writers, no enforcement that they agree.

The generalisation: every cache needs an invalidation story. In a DB
world that's "delete the row when the source changes." Here it's "the
session sub-map gets cleared on every new briefing" (`putInsights` line
65). The cache lifetime IS the invalidation strategy — and it works
because the briefing is the natural unit of consistency.

---

## Primary diagram

The deliberate vs accidental duplications in one frame.

```
  Duplication map for blooming_insights

  ┌─ STATE LAYER ──────────────────────────────────────────────────────┐
  │                                                                    │
  │   ┌──────────────┐  anomalyToInsight  ┌──────────────┐             │
  │   │   Anomaly    │ ──────────────────►│   Insight    │ ◄────┐      │
  │   │  (source)    │  SAFE: 1 writer    │  (view)      │      │      │
  │   └──────────────┘  source immutable  └──────────────┘      │      │
  │                                              ▲              │      │
  │                                              │              │      │
  │                                              │ id           │      │
  │                                              │              │      │
  │   ┌──────────────────────────┐               │              │      │
  │   │       Diagnosis          │   .affectedCustomers.count   │      │
  │   │                          │   ─ ─ ─ ─ aspirationally ─ ─ ┘      │
  │   │  affectedCustomers:{     │   denormalized into                 │
  │   │    count, segmentDesc }  │   Insight.affectedCustomers         │
  │   └──────────────────────────┘   but NOT enforced — RED FLAG       │
  │                                                                    │
  │  evidence overloaded across Anomaly/Insight/Diagnosis (naming      │
  │  duplication, not data duplication) — minor; rename candidate.     │
  │                                                                    │
  └─────────────────┬──────────────────────────────────────────────────┘
                    │  capture script writes
                    ▼
  ┌─ COMMITTED JSON (demo replay) ─────────────────────────────────────┐
  │                                                                    │
  │  demo-insights.json + demo-investigations.json                     │
  │  shape duplicates types.ts — must stay in sync                     │
  │  protected by the "new fields are optional" discipline only        │
  │  RED FLAG (latent): no test re-validates JSON against the types    │
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘

  Verdict:
    SAFE     — Anomaly → Insight widening (single writer, source immutable)
    LATENT   — Insight.affectedCustomers vs Diagnosis.affectedCustomers.count
               (two independent estimates, no enforcement they agree)
    LATENT   — demo JSON vs types.ts (discipline-protected, not test-enforced)
    COSMETIC — `evidence` field name reused across three types
```

---

## Elaborate

Where this comes from: Codd's normal forms (1NF, 2NF, 3NF) are about
preventing update anomalies — the same fact in two rows lets you update
one and forget the other. Denormalization for read speed is the
deliberate inverse, recognized as a real pattern under names like
"materialized view," "read model" (in CQRS), or "denormalized cache."

The seam to **software design**: information-hiding says a module should
expose what callers need and hide the rest. The
`anomalyToInsight` widening is information-hiding done in the data layer
— `Insight` exposes a *display* contract; `Anomaly` exposes an
*investigation* contract. The `insightToAnomaly` reverse mapping
deliberately drops fields so the diagnostic agent can't reach for them.
See `.aipe/study-software-design/` for the code-side analog if it exists.

What to read next: `04-transactions-and-integrity.md` walks how integrity
is enforced *without* a DB to enforce it — the `validate.ts` runtime
checks, the per-session Map isolation, and the gap where two writers can
disagree on `affectedCustomers`.

---

## Interview defense

**Q: "Where do you keep the same fact in two places, and why is that safe?"**

Verdict first: in the `Anomaly → Insight` widening. The widening is safe
because there's exactly one writer (`anomalyToInsight` in
`lib/state/insights.ts:25`) and the source is immutable after emit. The
risky duplication is `Insight.affectedCustomers` vs
`Diagnosis.affectedCustomers.count` — two independent estimates, no code
that reconciles them.

```
  the answer, sketched

  ┌─ SAFE duplication ──────┐
  │  Anomaly ──widen──► Insight    1 writer, source immutable │
  └─────────────────────────┘

  ┌─ RISKY duplication ─────┐
  │  Insight.affectedCustomers ─ ─ ─ Diagnosis.aff'd.count   │
  │                                                          │
  │  two independent estimates — comment says "denormalized" │
  │  but no code enforces it                                 │
  └──────────────────────────────────────────────────────────┘
```

Anchor: "the load-bearing thing people forget is *single writer*. As
soon as two writers exist, the duplication isn't a cache anymore — it's
a contradiction waiting to happen."

**Q: "Why have both `Anomaly` and `Insight` at all? Why not pick one?"**

Verdict first: because they're two contracts for two different consumers.
`Anomaly` is the contract the diagnostic agent needs (minimal:
`metric/scope/change/severity/evidence`). `Insight` is the contract the
UI needs (rich: `headline/summary/revenueImpact/...`). One type couldn't
serve both without one consumer pulling fields it shouldn't depend on.

```
  one type vs two contracts

  ONE type:               TWO types:
  ┌──────────────┐       ┌──────────┐    ┌──────────┐
  │ Anomalysight │       │ Anomaly  │───►│ Insight  │
  │ (everything) │       │ minimal  │    │ enriched │
  └──────────────┘       └──────────┘    └──────────┘
       │                      │               │
       │ both agents see      │ diag agent    │ UI sees
       │ both have to know    │ sees only     │ only what
       │ which fields to read │ what it needs │ it renders
       ▼                      ▼               ▼
  COUPLED                 INDEPENDENT — `insightToAnomaly`
                          deliberately DROPS evidence/impact/...
```

Anchor: "the reverse mapping `insightToAnomaly` deliberately drops fields
— that's the information-hiding signal that the two types are doing
different jobs."

---

## See also

- [`01-the-data-model-and-its-shape.md`](./01-the-data-model-and-its-shape.md)
  — the entity graph and join key
- [`04-transactions-and-integrity.md`](./04-transactions-and-integrity.md)
  — what enforces the invariant that `affectedCustomers` agrees (today:
  nothing)
- [`05-migrations-and-evolution.md`](./05-migrations-and-evolution.md)
  — the optional-field discipline that keeps demo JSON parseable
- [`audit.md`](./audit.md) — the consolidated checklist with this file's
  red flags
