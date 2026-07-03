# Transactions and integrity

**Industry term:** Atomicity / invariants / constraint enforcement · **Type:** Industry-standard concept, applied here to a repo where "the database" is a `Map` and JSON files — so every constraint lives in TypeScript or in a validator, not in the store.

## Zoom out, then zoom in

**Zoom out — where invariants live.** In a database-backed system, the answer to "who guards this invariant?" is usually one of {DB constraint, transaction boundary, app code, hopeful docstring}. blooming_insights has no database, so the enforcement surface is different: TypeScript types + runtime validators + discriminated unions do the job.

```
  Invariant-enforcement surface in blooming_insights

  ┌─ Compile time (strongest) ──────────────────────────────────┐
  │  TypeScript strict mode                                      │
  │    · discriminated unions (AgentEvent — 8 variants)          │
  │    · required vs optional field distinction                  │
  │    · literal-string unions (Severity, SignalClass,           │
  │      BloomreachFeature)                                      │
  │    · exhaustiveness checks in switch statements              │
  └────────────────────────┬────────────────────────────────────┘
                           │  compiles → runtime shape uncertain
  ┌─ Runtime validators ───▼────────────────────────────────────┐
  │  ★ THIS CONCEPT'S HOME ★                                     │
  │  lib/mcp/validate.ts                                         │
  │    · isAnomalyArray  · isDiagnosis  · isRecommendationArray  │
  │  lib/mcp/schema.ts                                           │
  │    · parseWorkspaceSchema (structural parse from unknown)    │
  │  lib/agents/budget.ts                                        │
  │    · BudgetTracker.exceeded()  → BudgetExceededError         │
  └────────────────────────┬────────────────────────────────────┘
                           │  passes → app trusts the shape
  ┌─ App code (weakest — hopeful) ──────────────────────────────┐
  │  Insight.affectedCustomers ↔ Diagnosis.affectedCustomers.co…│
  │    no runtime check that the copy is fresh                   │
  │  putInsights clear-then-set — not a transaction              │
  │  demo snapshot write ("capture") — multi-file, not atomic    │
  └─────────────────────────────────────────────────────────────┘
```

**Zoom in — the pattern.** Two questions map onto the surface: (1) *what shapes are guaranteed?* — answered by TypeScript + validators; (2) *what multi-step writes must all succeed or all fail?* — answered by nothing in this repo, because there are only two multi-step writes and neither is treated as a transaction. Both are covered below.

## Structure pass

### Layers of invariant

```
  Invariants — where each type lives

  ┌─ shape invariants                                           ┐
  │  "an Anomaly has metric, scope, change.value, ..."          │
  │  → TypeScript type + lib/mcp/validate.ts:isAnomalyArray     │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ value invariants (bounded literals) ───────────────────────┐
  │  "severity is one of critical/warning/info/positive"        │
  │  → literal union type + validator constant array            │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ referential invariants (relations)                         ┐
  │  "an Investigation's insightId points to a real Insight"    │
  │  → NOT ENFORCED — comment in insightToAnomaly (line 47-52) │
  │    acknowledges dropped fields, no cross-ref check          │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ multi-write atomicity                                      ┐
  │  "clear-then-set", demo capture (multi-file write)          │
  │  → NOT ENFORCED — best-effort, no rollback path             │
  └─────────────────────────────────────────────────────────────┘
```

### One axis: **how does an invariant violation get detected?**

```
  "how does a violation get caught?" — trace the answer down

  compile-time invariants   → tsc / eslint at build → "won't compile"
  runtime shape invariants  → is-check throws → route emits error event
  referential invariants    → not caught — the code either accepts
                              the missing reference (Map.get → null)
                              or crashes at deref time
  atomicity invariants      → not caught — partial writes leave the
                              system in a mixed state, no rollback
```

### Seams — where the answer flips

- **The route-handler boundary** — LLM output enters as `unknown`, hits `isAnomalyArray` / `isDiagnosis` / `isRecommendationArray` (`lib/mcp/validate.ts:17-57`), then flows downstream as a typed value. Above the seam: unknown shape from a stochastic source. Below: typed, trusted.
- **The `putInsights` boundary** (`lib/state/insights.ts:57-71`) — the `clear-then-set` on lines 64-70 is where write atomicity would matter, but doesn't exist. Above: a coherent list to publish. Below: mid-write inconsistency is visible to concurrent reads.

## How it works

### Move 1 — the mental model

Two ways to think about this. **Shape invariants** are the compile-time contract: TypeScript checks them once at build time, then they're gone (types are erased). If you trust the code that produced the value (your own code, other typed modules), the invariant carries forward. If you don't (an LLM, an MCP tool result, a JSON file on disk), you need a runtime validator to reintroduce the guarantee.

```
  The shape-invariant pipeline — trust and where it enters

     LLM/MCP/disk                              your code
       │                                          │
       │  produces `unknown`                      │
       ▼                                          ▼
     ┌───────────────┐    passes    ┌───────────────────┐
     │ validator     │ ─────────►   │ Anomaly / Diagn.  │
     │ isAnomalyArray│              │ Recommendation    │
     └───────────────┘              │ (now trusted)     │
       │                            └───────────────────┘
       │  fails
       ▼
     throw / error event
```

**Atomicity invariants** are the promise that multiple writes together either all succeed or none do. In a SQL database you get this with `BEGIN...COMMIT`. In blooming_insights, you don't get it at all — every multi-step write is a sequence of independent operations, and if a crash lands between steps, the store is left mid-write.

```
  Atomicity — the two multi-step writes with no transaction

  putInsights(session, items):
     s.insights.clear();       ◄── after this line, feed is EMPTY
     s.anomalies.clear();      ◄── after this line, anomalies are EMPTY
     items.forEach(setBoth);   ◄── crash here → session sees empty feed

     (a concurrent listInsights() call between clear() and forEach
      returns [] — a read anomaly the type system does NOT catch)

  saveInvestigation(id, events):
     mem.set(id, events);      ◄── memory updated
     if (PERSIST) writeSync(); ◄── crash here → memory has it, file doesn't
                                    on next process, dev file lags memory
```

### Move 2 — the enforcement surface, walked

#### Shape validator — `isAnomalyArray`

**File:** `lib/mcp/validate.ts`
**Function:** `isAnomalyArray` (lines 17-27)

```typescript
export function isAnomalyArray(v: unknown): v is Anomaly[] {
  return Array.isArray(v) && v.every((a) =>
    !!a && typeof a === 'object' &&
    typeof (a as any).metric === 'string' &&
    Array.isArray((a as any).scope) &&
    !!(a as any).change && typeof (a as any).change.value === 'number' &&
    ((a as any).change.direction === 'up' || (a as any).change.direction === 'down') &&
    typeof (a as any).change.baseline === 'string' &&
    SEVERITIES.includes((a as any).severity)
  );
}
```

The pattern is a **type predicate** — a function that both checks shape at runtime *and* narrows the type at the call site (`v is Anomaly[]`). Every required field gets a `typeof` check; the two literal unions (`change.direction`, `severity`) get value-set checks. Optional fields (`impact`, `history`, `category`) are *not* checked — their absence is legal.

**What breaks if the validator is skipped:** the agent's LLM output flows into the state Map as-is. A malformed anomaly (missing `metric`, or `change.value` as a string) would render broken in the UI, or throw at some downstream `.toLowerCase()` call, with no clue where it came from. The validator is the seam that catches "the model wrote garbage" *before* it enters the store.

**What's not caught:** `metric` is `string` — nothing checks it's a recognized metric name. `scope` is `string[]` — nothing checks the strings are known dimensions. These are **soft invariants** the schema doesn't enforce; the receiving UI code has to tolerate whatever comes through.

#### Shape validator — `isRecommendationArray` and the legacy shape

**File:** `lib/mcp/validate.ts`
**Function:** `isRecommendationArray` (lines 42-57)

This one carries a comment worth reading:

```typescript
// The agent emits recommendations WITHOUT an `id` (the system assigns ids after
// validation), so we validate the array of the id-less shape.
export function isRecommendationArray(v: unknown): v is Omit<Recommendation, 'id'>[] {
```

Two things worth naming. First, the `Omit<Recommendation, 'id'>` — the validator handles a **shape variant** (input has no id, output does), which is a legitimate case where the runtime shape doesn't match the compile-time contract 1:1. Second, the `impactOk` check on lines 46-48:

```typescript
const impactOk =
  typeof x.estimatedImpact === 'string' ||
  (!!x.estimatedImpact && typeof x.estimatedImpact === 'object' && typeof x.estimatedImpact.range === 'string');
```

That's a **backward-compatibility gate**: legacy snapshots have `estimatedImpact: string`; newer ones have `{ range, rangeUsd?, assumption }`. Both pass validation. This is the runtime cousin of the optional-field-as-migration pattern in file 05.

#### Structural parser — `parseWorkspaceSchema`

**File:** `lib/mcp/schema.ts`
**Function:** `parseWorkspaceSchema` (lines 81-132)

This one is different from the validators — it doesn't just check, it **transforms**. The MCP tool results come in with their own vendor shape (`event.type`, `properties.default_group.properties[].property`, etc.); the parser walks that shape and produces the domain `WorkspaceSchema`.

```typescript
const events = (eventPayload?.events ?? [])
  .map((e) => ({
    name: e.type,
    properties: (e.properties?.default_group?.properties ?? []).map(
      (p) => p.property,
    ),
    eventCount: eventTypesOverview[e.type]?.event_count ?? 0,
  }))
  .sort((a, b) => b.eventCount - a.eventCount);
```

Every field access is defended with `?.` and `?? default` — the parser is **robust to missing fields.** That's the right shape for a boundary that reads from an external service whose contract might drift. The invariant it enforces: "no matter what Bloomreach returned, we hand downstream code a `WorkspaceSchema` where every field has a defined value."

#### Budget invariant — `BudgetTracker.exceeded()`

**File:** `lib/agents/budget.ts`
**Function:** `BudgetTracker.exceeded` (lines 71-76)

```typescript
exceeded(): boolean {
  const s = this.snapshot();
  if (this.limit.maxTokens != null && s.totalTokens > this.limit.maxTokens) return true;
  if (this.limit.maxCostUsd != null && s.estimatedCostUsd > this.limit.maxCostUsd) return true;
  return false;
}
```

This is the **budget invariant**: no investigation may spend more than N tokens or M USD. The invariant lives on the tracker; it's checked between model turns (by the adapter, before each API call). If it fires, `BudgetExceededError` (lines 85-95) propagates up as a graceful NDJSON `error` event.

This is genuinely enforced, at the right seam (before the network call, not after), with a typed error carrying the snapshot for debugging. Contrast with the multi-write invariants below, which are enforced by nothing.

#### The clear-then-set write — not a transaction

**File:** `lib/state/insights.ts`
**Function:** `putInsights` (lines 57-71)

```typescript
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  const s = sessionState(sessionId);
  s.insights.clear();       // ← step 1
  s.anomalies.clear();      // ← step 2
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });                        // ← step 3
}
```

Between step 2 and step 3, a concurrent `listInsights(sid)` returns `[]`. A concurrent `getInsight(sid, someId)` returns `null` even if the id was in the *previous* feed. Node's single-threaded event loop mitigates this in practice — the whole function runs to completion before any other JS runs — but if `items.forEach` ever awaited (it doesn't today, but the shape allows it), the mid-write state becomes observable.

**What breaks if you added an `await` inside the forEach:** you get partial reads. The safe pattern is **build the new state in a temporary, swap atomically** — mirror-copy on write:

```typescript
// hypothetical safer version
const nextInsights = new Map<string, Insight>();
const nextAnomalies = new Map<string, Anomaly>();
items.forEach((i, idx) => {
  nextInsights.set(i.id, i);
  if (rawAnomalies?.[idx]) nextAnomalies.set(i.id, rawAnomalies[idx]);
});
s.insights = nextInsights;   // atomic reference swap
s.anomalies = nextAnomalies;
```

The current code is fine *because* it never awaits inside the loop. But that's a coupling to Node's execution model, not to a data-modeling contract.

#### The demo capture — multi-file write, no atomicity

**File:** referenced in AGENTS/context (`app/api/mcp/capture-demo`) — writes `lib/state/demo-insights.json` **and** `lib/state/demo-investigations.json` on the same "capture this as the demo snapshot" invocation.

If the first `writeFileSync` succeeds and the second fails (disk full, permission error, process kill), the committed demo state is now inconsistent: the insight list is updated but the investigations don't match. On next demo replay, cards render but investigations are missing or misaligned.

This is a **classic multi-file atomicity problem**. The database analog is: "write two tables, need both, no transaction." The fix is either (a) write both to temp files first, then rename in a specific order, or (b) collapse to a single file with both keys. Option (b) is simpler here and the whole state fits in one JSON blob.

**Currently unnoticed** because the dev workflow is "capture → git diff → commit" — a bad write shows up in the diff before it gets committed. But it's a real integrity gap.

#### Move 2 variant — the load-bearing skeleton of invariants

Three parts. Drop any one and the invariant model has a hole big enough to see through.

1. **A statement of the invariant.** Where is it written down? For `Insight` — the TypeScript interface + the type comment on `affectedCustomers`. For budget — the `BudgetLimit` type + `exceeded()` predicate. For atomicity of `putInsights` — nowhere. That's the gap.

2. **An enforcement seam.** Where does violation get detected? For shape — the validator at the route boundary. For budget — `exceeded()` before every model turn. For atomicity — nothing.

3. **A failure handler.** What happens when violation is detected? For shape — throw + emit `error` NDJSON event. For budget — typed `BudgetExceededError` carrying the snapshot. For atomicity — undefined; the system continues in mixed state.

Drop the statement (part 1) and future engineers don't know the invariant exists. Drop the seam (part 2) and violations are undetected. Drop the handler (part 3) and even detected violations don't have a defined recovery. Blooming_insights has (1)+(2)+(3) for shape and budget; it has *none* of the three for multi-step atomicity. That's the honest gap.

### Move 3 — the principle

**An invariant is a promise, and a promise needs an enforcer.** TypeScript enforces shape at compile time; runtime validators re-enforce it at trust boundaries; a Map-of-Maps enforces session isolation as long as nobody reaches around it. What blooming_insights does *not* enforce is anything that requires a *sequence* of operations — the "these three writes go together" contract. The rule you take home: **whenever your code writes to two places, ask 'what if only the first one succeeds?' — if you can't name a recovery, you have a data-integrity bug waiting.** The fix is often smaller than you'd think — build the new state in a local variable, swap by reference. It's a two-line change that makes the invariant explicit.

## Primary diagram

The invariant surface in one frame — where each type is enforced (or isn't).

```
  Invariant enforcement in blooming_insights

  ┌─ enforced strongly ─────────────────────────────────────────┐
  │                                                              │
  │  compile-time     TS interfaces + literal unions             │
  │                                                              │
  │  route boundary   isAnomalyArray / isDiagnosis /             │
  │                   isRecommendationArray                      │
  │                                                              │
  │  MCP boundary     parseWorkspaceSchema (structural parse)    │
  │                                                              │
  │  per-turn budget  BudgetTracker.exceeded() →                 │
  │                   BudgetExceededError                        │
  └─────────────────────────────────────────────────────────────┘

  ┌─ enforced by convention (no compiler help) ─────────────────┐
  │                                                              │
  │  denormalization  Insight.affectedCustomers ↔                │
  │                   Diagnosis.affectedCustomers.count          │
  │                   (type comment names it, nothing checks)    │
  │                                                              │
  │  pipeline shape   Anomaly → Insight → Diagnosis → Rec        │
  │                   (each stage assumes the last one's shape)  │
  └─────────────────────────────────────────────────────────────┘

  ┌─ not enforced — real gaps ──────────────────────────────────┐
  │                                                              │
  │  clear-then-set   putInsights step-1..3 not atomic           │
  │                   (safe today only because of Node's         │
  │                    single-threaded loop and no await inside) │
  │                                                              │
  │  demo capture     multi-file write, no atomicity             │
  │                   (mitigated by human review in commit diff) │
  │                                                              │
  │  referential      insightToAnomaly drops fields; no check    │
  │                   that dropped fields are recomputable       │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The compile-time-vs-runtime invariant split is TypeScript's answer to **structural typing at the boundary**. The classical Zod / io-ts / Valibot library ecosystem exists to fill exactly this seam — a schema you can both `typeof` in TypeScript *and* validate at runtime. blooming_insights uses hand-rolled predicates instead (`lib/mcp/validate.ts` is ~60 lines). At this size, the hand-rolled version is cheaper than pulling in a library; at 5x the shape surface, a schema library starts to pay off.

The multi-write atomicity gap is the DB analog of a **race window**. In real databases, `SERIALIZABLE` isolation solves it; in in-process state, the "reference swap" pattern (build the new value locally, assign it once) is the equivalent. React reducers do this at every setState — the immutable-swap discipline transfers directly to any in-memory state store.

## Interview defense

**Q: "How do you enforce invariants in this system?"**
Answer: "Three layers. First, TypeScript at compile time — every entity is a strict interface with literal-string unions for bounded values like `Severity` and `BloomreachFeature`. Second, runtime validators at trust boundaries: `lib/mcp/validate.ts` type-predicates the LLM output before it enters state; `lib/mcp/schema.ts:parseWorkspaceSchema` structurally parses MCP tool results. Third, invariants on operational state: `BudgetTracker.exceeded()` at `lib/agents/budget.ts:71-76` guards per-investigation cost before every model turn. The gap is atomicity — `putInsights` does clear-then-set without a swap, so a concurrent read between the clear and the set gets an empty feed. Safe today only because Node's event loop doesn't preempt inside a sync function, but that's coupling to the runtime, not to a data contract." Draw the three-layer diagram.

**Q: "What's your worst integrity risk?"**
Answer: "The demo-capture write. It touches two committed JSON files — `demo-insights.json` and `demo-investigations.json` — sequentially. If the second write fails, the demo state is inconsistent. Today it's mitigated by human review in the commit diff, but that's an operational safeguard, not a code guarantee. Fix is either write-then-rename with a specific order, or collapse both files into one." Anchor: `putInsights` at `lib/state/insights.ts:57-71` for the in-memory equivalent.

## See also

- `02-normalization-and-duplication.md` — the denormalized fields whose invariants are enforced by convention.
- `05-migrations-and-evolution.md` — how the backward-compatibility shape (optional fields) *is* an invariant contract with older snapshots.
- `07-data-modeling-red-flags-audit.md` — the invariants-in-app-code entry on the consolidated checklist.
