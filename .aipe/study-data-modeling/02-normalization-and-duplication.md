# Normalization and duplication

**Industry term:** Denormalization / single source of truth (SSOT) violation · **Type:** Industry-standard concept, applied here to TypeScript types rather than to SQL tables.

## Zoom out, then zoom in

**Zoom out — where duplication lives.** Only three seams in this repo can produce the "same fact stored twice" problem, because only three places construct records that inline other records:

```
  Where facts can be stored twice — layered view

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  reads Insight — treats it as SSOT (never merges)           │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ Service layer ────────▼────────────────────────────────────┐
  │                                                              │
  │  seam 1: anomalyToInsight  (lib/state/insights.ts:25)        │
  │            derives + splices 5 fields — one-time compute     │
  │                                                              │
  │  seam 2: Diagnosis.affectedCustomers ─► Insight.affectedCus- │
  │            tomers (elsewhere in the pipeline) — cross-record │
  │                                                              │
  │  seam 3: Receipt construction (eval/run.eval.ts:341-395)     │
  │            inlines diagnosis + tool calls + judgment + cost  │
  │            into ONE document                                 │
  │                                                              │
  └────────────────────────┬────────────────────────────────────┘
                           │  serialize
  ┌─ Storage layer ────────▼────────────────────────────────────┐
  │  Map<sessionId, SessionFeed>  (in-memory)                    │
  │  demo-*.json  eval/receipts/*.json                           │
  └─────────────────────────────────────────────────────────────┘
```

**Zoom in — the pattern.** In relational language, "the same fact editable in two places" is a normalization violation and it's the DB analog of information leakage (from software-design's information-hiding). blooming_insights doesn't have tables to normalize, but it has the *type-level* version of the same problem: an interface that includes fields derived from another interface, with no invalidation contract between them.

## Structure pass

### Layers of duplication

Not all duplication is equal. Rank by cost:

```
  Duplication types — cheapest to most expensive

  ┌─ 1. denormalized-for-write (write-once, no lifecycle) ──────┐
  │  Receipt inlines Diagnosis + Recommendation + judgments     │
  │  → written once, never updated → duplication is free        │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ 2. denormalized-for-read (present + past both derivable) ──┐
  │  Insight.revenueImpact, .funnel — recompute from evidence   │
  │  → source of truth stays in Anomaly.evidence, but the       │
  │    derived form lives alongside it → invalidation is silent │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ 3. cross-record copy (worst — two shapes disagree) ────────┐
  │  Diagnosis.affectedCustomers.count ─► Insight.affectedCust. │
  │  → two records, one fact, no owner → true dup               │
  └─────────────────────────────────────────────────────────────┘
```

### One axis: **who owns the fact?**

- `Insight.revenueImpact` — owner: `Anomaly.evidence[0].result.{current,prior}` (derived at construction, `lib/insights/derive.ts:27-38`).
- `Insight.affectedCustomers` — owner: `Diagnosis.affectedCustomers.count`, but stamped onto `Insight` too (the type comment at `lib/mcp/types.ts:58` calls it out: *"denormalized from Diagnosis.affectedCustomers.count"*).
- `Receipt.diagnosis` — owner: the `Diagnosis` returned by the agent; the receipt is a *frozen copy* by definition.

### Seams — where the answer flips

Two seams flip the answer from "one owner" to "two":

- **`lib/state/insights.ts:25-45` — `anomalyToInsight`.** Before the call: `Anomaly` is the fact. After: `Insight` carries the fact **plus derived views of the fact.**
- **The `Insight.affectedCustomers` write path** (produced somewhere in the investigation flow — the type comment names it). Before: `Diagnosis.affectedCustomers.count` is the fact. After: two records carry it.

## How it works

### Move 1 — the mental model

If you've ever cached a computed field on a row (`user.follower_count`, `product.average_rating`), you already know this pattern — and the trap. The shortcut is fast: you don't have to recompute on every read. The cost is the **invalidation problem**: the moment the underlying data changes, the cached copy is stale, and nothing tells you.

```
  The denormalization pattern — the fact, the copy, the missing edge

              (SOURCE OF TRUTH)                    (DERIVED COPY)
              ┌──────────────┐                     ┌──────────────┐
              │  Anomaly     │                     │  Insight     │
              │  .evidence   │──── derive ────────►│ .revenueImpa │
              └──────┬───────┘   (one-way, at     └──────────────┘
                     │            construction)
                     │
                     ▼
              (if this ever changes,
               nothing updates the copy)
                     │
                     ▼
                 STALE
```

For blooming_insights, "if this ever changes" is currently unreachable — the pipeline is one-shot, `Anomaly` is immutable once produced, so the copy is safe. But the *shape* has the vulnerability. The moment any edit path is added ("re-run the diagnosis with different scope"), the copy silently lies.

### Move 2 — the three duplications, walked

#### Duplication A — the derived fields on `Insight`

**File:** `lib/state/insights.ts`
**Function:** `anomalyToInsight` (lines 25-45) — and `deriveInsightFields` at `lib/insights/derive.ts:27-38`
**What happens:**

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
    headline,                                                  // ← derived from a.scope + a.metric + a.change
    summary: `${a.metric} ${a.change.direction} ${Math.abs(a.change.value)}% vs ${a.change.baseline}`.toLowerCase(),
    metric: a.metric,
    change: a.change,                                          // ← copied
    scope: a.scope,                                            // ← copied
    source: 'monitoring',
    evidence: a.evidence,                                      // ← copied by reference
    impact: a.impact,                                          // ← copied
    history: a.history,                                        // ← copied
    category: a.category,                                      // ← copied
    ...deriveInsightFields(a),                                 // ← splices revenueImpact + more
  };
}
```

Every field marked `← copied` is a redundant write. `Anomaly` still exists (`putInsights` keeps `rawAnomalies` in its own Map, `lib/state/insights.ts:65-70`) — so both records live in memory and both carry the same field. The type comment on `Insight.affectedCustomers` (`types.ts:58`) is worth quoting exactly:

```typescript
affectedCustomers?: number; // denormalized from Diagnosis.affectedCustomers.count
```

The word "denormalized" is right there in the source. This is not accidental — it's a deliberate call to make rendering cheap. But the cost is:

**What breaks if you don't rebuild the copy:** `anomalyToInsight` is called once per anomaly in the briefing pipeline. If a downstream code path ever mutated `Anomaly.evidence` (say, to enrich it with a follow-up query result) without re-invoking `anomalyToInsight`, the `Insight.revenueImpact` derived from that evidence would be stale, and no compiler check catches it.

**The fix if it becomes real:** either move the derivations to *read time* (compute on render, delete the field from `Insight`), or introduce a version stamp on `Anomaly.evidence` and `Insight` and refuse to render mismatches. Read-time derivation is cheaper here — the derivations are pure functions of small inputs.

#### Duplication B — `Diagnosis.affectedCustomers.count` copied into `Insight.affectedCustomers`

**Files:** `lib/mcp/types.ts:58` (the type comment) — and wherever the copy is performed (search paths: the investigation-complete handler; the seam is named in the comment even where the assignment is elsewhere).
**What happens:**

```
  Two records, one fact — the classic denormalization anti-pattern

       Diagnosis                          Insight
       ┌──────────────────────┐           ┌──────────────────────┐
       │ affectedCustomers: { │           │ affectedCustomers?:  │
       │   count: 9340,       │  ─copy──► │   9340               │
       │   segmentDescription │           │                      │
       │ }                    │           └──────────────────────┘
       └──────────────────────┘
              │
              │ if any code updates Diagnosis
              │ but not the Insight — silent drift
              ▼
       Insight.affectedCustomers is now a lie
```

**What breaks if the diagnosis is re-run:** the `Insight` card in the feed still shows the old count. Currently unreachable — diagnoses are computed once and never updated — but the *shape* invites the bug.

**The fix if it becomes real:** delete `Insight.affectedCustomers`, add a lookup at render time from the investigation store (`lib/state/insights.ts` — `getInvestigation`). Reading through the diagnosis is 3 lines; the field on `Insight` is a "make the render function trivial" shortcut that costs a normalization violation.

#### Duplication C — the receipt as a denormalized document

**File:** `eval/run.eval.ts` (lines 341-395)
**Function:** the anonymous case body inside `it.each(goldens.map(...))`.

```typescript
// eval/run.eval.ts:341-395 (abridged)
const receipt = {
  runId: sharedRunId,
  case: goldenCase.caseId,
  signalClass: goldenCase.signalClass,
  intent: goldenCase.intent,
  durationMs: { investigate, diagnosisJudge, recommend, recommendationJudge, total },
  model: { agent: 'claude-sonnet-4-6', judge: 'claude-sonnet-4-6' },
  anomaly: { metric, scope, change, severity },      // ← inlined from GoldenCase.anomaly
  diagnosisToolCalls: [...],                         // ← the full trace
  recommendationToolCalls: [...],                    // ← the full trace
  usage: { diagnose, recommend },                    // ← per-agent token+cost
  budget: { limit, snapshot, exceeded, budgetError },// ← whole tracker snapshot
  diagnosis,                                         // ← the whole Diagnosis object
  diagnosisJudgment,                                 // ← the whole judge output
  diagnosisJudgmentError,
  recommendations,                                   // ← the whole Recommendation[]
  recommendationJudgments,                           // ← per-rec judgments
};
```

Every field is a **snapshot of another record at the moment the case ran.** The `anomaly` in the receipt is a copy of `GoldenCase.anomaly`. The `diagnosis` is a copy of what the agent returned. The `usage` is a snapshot of what `summarizeUsage` computed from the trace.

**Is this bad denormalization?** No — this is the **write-once immutable-log** case, and it's the *right* choice. A receipt exists to make the run replayable in isolation. If you had to join against the golden file, the tool-call trace, the judge output, and the pricing table to reconstruct what happened, the whole eval subsystem would be brittle to unrelated code changes. Inlining everything at write time makes each receipt self-contained.

**But the tradeoff is real:** at 10 cases × ~35KB × N runs, the receipts directory is comfortable. At 200 cases × N runs, or if the receipts start being *queried* across runs, the file layout becomes the bottleneck. That's a shape-vs-query mismatch, walked in file 03.

#### Move 2 variant — the load-bearing skeleton of "safe denormalization"

Three parts. Drop any one and the denormalization goes from cheap to costly.

1. **Write-once discipline.** The source can never change *after* the copy is made. `Receipt` gets this for free (the run finishes, the file is written, done). `Insight`-with-derived-fields *has* this, currently, but only by convention — no compiler check prevents mutation.

2. **A named ownership contract.** The type comment on `Insight.affectedCustomers` — *"denormalized from Diagnosis.affectedCustomers.count"* — is that contract, written down. Every denormalized field needs one. Without it, future you doesn't know which side to trust.

3. **A recompute path if the source moves.** `deriveInsightFields` (lib/insights/derive.ts:27) is pure and callable — if evidence ever gets enriched mid-flight, `anomalyToInsight` can be called again to refresh. If a derived field has *no* recompute path (only the original anomalyToInsight can produce it), the denormalization has no escape hatch.

If you're wondering why receipts don't need parts 2 and 3, the answer is part 1: they're immutable by construction. Discipline gets weaker the further you get from "written once, then read forever."

### Move 3 — the principle

**Denormalize on the write path when the record is immutable; normalize on the read path when it isn't.** Immutable logs (receipts, event streams, snapshots) *want* to be denormalized — that's the whole point of the pattern. Records with edit paths (`Insight` in a world where a user could re-scope a diagnosis) want the fact to live in exactly one place, with reads doing the join. The rule you take home: **the invalidation contract is where the design lives.** If you can't name what invalidates a derived field and where that invalidation is enforced, you've built a bug the compiler won't catch. In blooming_insights the contract is *"the pipeline is one-shot"* — as long as that stays true, the denormalization is free. The day it stops being true, the derived fields on `Insight` are the first thing to migrate.

## Primary diagram

The three duplications side by side, ranked by cost.

```
  Denormalization in blooming_insights — three duplications

  ┌─ A. Insight ← Anomaly (derived fields) ──────────────────────┐
  │  cost: low today (one-shot pipeline)                         │
  │  vulnerability: any Anomaly mutation without rerun ─► stale  │
  │  fix if it fires: compute at render, delete the field        │
  └──────────────────────────────────────────────────────────────┘

  ┌─ B. Insight.affectedCustomers ← Diagnosis.affectedCustomers ─┐
  │  cost: medium (cross-record, two owners, comment names it)   │
  │  vulnerability: re-diagnose without re-stamp ─► card lies    │
  │  fix if it fires: read through to Investigation on render    │
  └──────────────────────────────────────────────────────────────┘

  ┌─ C. Receipt inlines everything ──────────────────────────────┐
  │  cost: negligible — this is the correct shape for logs       │
  │  vulnerability: only if you ever want to query ACROSS runs   │
  │  fix if it fires: introduce a store; keep receipts as blobs  │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The distinction between duplication-A (derived, single-record) and duplication-C (frozen log, multi-record) is exactly the distinction between a **materialized view** (SQL) and an **event log** (Kafka / append-only Postgres table). The trade-off framing is identical: materialized views amortize compute at the cost of an invalidation problem; event logs pay serialization cost once for permanent replayability. blooming_insights has one of each — it's just that both live as TypeScript records in memory or JSON on disk, not in a database.

This concept also cross-links to software-design's **information hiding**: normalization is the data analog. A well-normalized schema hides implementation details behind a single source-of-truth column; a denormalized one leaks the same fact across rows. When you see the type comment "*denormalized from…*" in `lib/mcp/types.ts`, that's the developer acknowledging the leak explicitly. → cross-link to `study-software-design/` for the code-level version.

## Interview defense

**Q: "Show me the denormalization in this codebase."**
Answer: "Three places. First, `lib/state/insights.ts:25-45` — `anomalyToInsight` splices five derived fields onto `Insight` at construction time; source of truth stays on `Anomaly.evidence`. Second, `Insight.affectedCustomers` at `lib/mcp/types.ts:58` — the type comment literally says 'denormalized from `Diagnosis.affectedCustomers.count`'. Two records, one fact. Third, the eval receipt at `eval/run.eval.ts:341-395` — it inlines everything (diagnosis, judgments, tool calls, cost) into one 35KB JSON blob per case per run." Draw the three-duplications diagram from Move 1.

**Q: "Are any of those a problem?"**
Answer: "None *today*, because the pipeline is one-shot — anomalies aren't mutated after `anomalyToInsight`, diagnoses aren't re-run into the same `Insight`. But two of the three have no compiler-enforced invalidation contract. The moment we add an edit path, `Insight`-with-derived-fields becomes the first bug. The receipt case is different — that's the immutable-log pattern, and it's the right shape." Anchor: `lib/insights/derive.ts:27-38` for the derivation; `types.ts:58` for the explicit "denormalized" comment.

**Q: "What would you change?"**
Answer: "Delete `Insight.revenueImpact / .aov / .funnel / .affectedCustomers` and derive them at render time from `Anomaly.evidence` + the investigation store. It's a `.map()` in each component and it removes an entire class of stale-copy bug. The performance cost is nothing — this is display-time formatting, not a hot path." Diagram: source-fact-once-then-derive.

## See also

- `01-the-data-model-and-its-shape.md` — the pipeline of shapes each duplication rides on.
- `04-transactions-and-integrity.md` — where invariants would need to live if these copies stopped being safe.
- `07-data-modeling-red-flags-audit.md` — this concept's entries on the consolidated checklist.
