# Transactions and integrity

**Industry name(s):** Transactions · atomicity · constraints · invariants · type guards as integrity check
**Type:** Industry standard · Language-agnostic

> **Partially applies.** There are no database constraints because there's no database — no FKs, no UNIQUE, no NOT NULL, no CHECK. What stands in for them is layered: TypeScript at compile time, three runtime guards in `lib/mcp/validate.ts` at the **LLM seam** (the one boundary the compiler can't see), and three in-memory `Map`s that have **no atomicity story at all**. The strong half of this is the LLM-seam guards — they're correctly placed, narrow, and fail closed (invalid JSON returns `[]` and the briefing degrades gracefully). The weak half is the in-memory store: `putInsights` clears and re-fills two parallel Maps with no transactional boundary, which is fine *because* it's single-process and synchronous, but the moment that assumption breaks the integrity story collapses.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Integrity questions span three layers in this repo, with sharply different mechanisms at each. The **LLM seam** uses runtime type guards (since TypeScript can't see what the model emits). The **route ↔ state seam** has no integrity check at all (two Maps are cleared and re-filled in sequence; the only invariant — "every insight in `insights` should have its raw `Anomaly` in `anomalies`" — has no enforcer). The **wire format seam** (browser → route via `?insight=`) parses + validates the shape inline.

```
  Zoom out — what enforces integrity, where

  ┌─ UI client band ──────────────────────────────────────────┐
  │  trusts the typed shape from the route                     │
  │  (no validation on read — assumes the route is honest)     │
  └────────────────────────────┬──────────────────────────────┘
                               │ Insight JSON (?insight=…)
  ┌─ Route handler band ───────▼──────────────────────────────┐
  │  app/api/agent/route.ts                                    │
  │  - inline shape validation on ?insight= param              │
  │  - putInsights() clears 2 Maps non-atomically              │
  │  - no cross-Map invariant enforcement                       │
  └────────────────────────────┬──────────────────────────────┘
                               │ Anomaly[] | Diagnosis | Recommendation[]
  ┌─ Agent loop band ──────────▼──────────────────────────────┐
  │  agents emit JSON-as-string                                │
  │  validate.ts narrows each shape  ★ THE INTEGRITY LAYER ★   │
  │  fails closed: invalid JSON → [] / null → graceful degrade │
  └────────────────────────────┬──────────────────────────────┘
                               │ JSON in tool results
  ┌─ MCP wrapper band ─────────▼──────────────────────────────┐
  │  McpClient parses tool results; error envelopes flagged    │
  │  via isError=true; surfaced as McpToolError                │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this concept answers: when something writes the model, what guarantees the result is consistent? Two paths matter here. At the **LLM seam**, three type guards are the integrity check — without them, the agent could emit `{ banana: true }` and the rest of the pipeline would crash later. At the **in-memory store**, nothing is the integrity check — the invariant "insights and anomalies stay paired" is held by the code that writes them, not by the store. That's the partial-applicability of this topic.

---

## Structure pass

**Layers.** Same four-layer stack. The two integrity-relevant layers are the **agent loop band** (where the LLM seam sits) and the **state module band** (where the in-memory Maps live).

**Axis: invariant enforcement.** For each invariant the model relies on, what enforces it — the compiler, a runtime check, a transaction, or hopeful code? This is the right axis because integrity is *literally* about which mechanism prevents which inconsistency. Cost is wrong (most checks are free); failure is wrong (these checks PREVENT failure, they don't propagate it). Invariant enforcement pops the seams: at every boundary, which side enforces which fact.

**Seams.** Three matter. **Seam 1: LLM ↔ agent code.** Enforced by `validate.ts` — three guards, fails closed. Strong. **Seam 2: route ↔ in-memory store.** Enforced by ... the code that calls `putInsights`, hoping it passes both `items` and `rawAnomalies` correctly. No transaction. **Seam 3: wire format ↔ route.** Enforced inline in `resolveAnomaly` — checks `metric`, `change`, `scope`, `severity` exist before trusting the JSON. Narrow but present.

```
  Structure pass — invariant enforcement across seams

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  UI · Route · Agent loop · MCP wrapper                    │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  invariant enforcement: what guards each fact, at each    │
  │  layer boundary? (compiler / runtime / transaction / hope)│
  └─────────────────────────────┬────────────────────────────┘
                                │  trace across seams
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  S1: LLM ↔ agent     ★ RUNTIME GUARDS (validate.ts)      │
  │  S2: route ↔ store   ★ HOPE (no atomicity, no FK check)  │
  │  S3: wire ↔ route    ★ INLINE SHAPE CHECK (narrow)       │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — How it works
```

---

## How it works

### Move 1 — integrity is the boundary, not the body

You know how a TypeScript type narrows `string | null` to `string` inside an `if (x != null)` block? That's a compile-time integrity check — the compiler refuses to let you reach `.length` until you prove it's non-null. Now imagine the value isn't `string | null` — it's a JSON blob you just parsed from an LLM response. The type system can't help; you're back to runtime checks at the boundary. That's exactly the situation at the LLM seam. The three guards in `validate.ts` do for runtime what the compiler does at compile time — narrow the type *at the boundary* before any downstream code touches it.

```
  the boundary picture — where integrity lives

  ┌─ untrusted ──────────────┐                ┌─ trusted ────────────────┐
  │ model output (string)    │  → guard? →    │ Anomaly[]                │
  │ JSON.parse → unknown     │                │ Diagnosis | null         │
  │ "anything could be here" │                │ Recommendation[]         │
  └──────────────────────────┘                └──────────────────────────┘
                              ▲
                              │
                       this is THE seam
                       (the only place TypeScript can't help)
```

**Skeleton parts of a runtime guard at this seam:**

1. **Parse step** — turn the model's string into a structured value (`parseAgentJson` in `validate.ts` handles fenced ```json blocks, falls back to substring scan).
2. **Shape check** — narrow to the expected interface (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray` check field names + types).
3. **Fail-closed return** — when the check fails, return a neutral value the caller can degrade on (`[]`, `null`).

Drop step 1 and the guard chokes on the agent's typical fenced output. Drop step 2 and downstream code crashes on missing fields. Drop step 3 — return `throw` instead — and one malformed JSON crashes the whole briefing run.

### Move 2 — the LLM-seam guards, walked

`lib/mcp/validate.ts` has three guards plus a parser. **One operation per guard:**

#### `parseAgentJson(text)` — the parser

Handles three shapes the agent emits: a fenced ```json block (most common), bare JSON, or JSON embedded in prose. **One operation per fallback:**

```
  parseAgentJson — three fallbacks in order

  step 1:  fenced block?      /```(?:json)?\s*([\s\S]*?)```/
            yes → JSON.parse  the contents
            no  → step 2

  step 2:  trimmed input is direct JSON?
            yes → JSON.parse  the trimmed text
            no  → step 3

  step 3:  scan for first '[' or '{', last ']' or '}'
            extract substring → JSON.parse
            fail → throw 'no parseable json in agent output'

  what breaks if you drop step 1: 90% of agent outputs (fenced blocks)
                                  fail because the ``` confuses JSON.parse
  what breaks if you drop step 3: any agent output with leading prose
                                  ("Here are the anomalies: [...]") fails
```

#### `isAnomalyArray(v)` — the Anomaly[] shape guard

The richest guard. **One field per line, all required fields checked:**

```
  isAnomalyArray — the check, field by field

  Array.isArray(v) AND every element:
    typeof element === 'object'
    AND typeof metric === 'string'
    AND Array.isArray(scope)
    AND typeof change === 'object'
    AND typeof change.value === 'number'
    AND change.direction in ('up' | 'down')
    AND typeof change.baseline === 'string'
    AND severity in ('critical' | 'warning' | 'info' | 'positive')

  what's NOT checked:
    - evidence (required on the interface, but defaulted by callers)
    - impact, history, category (all optional)
    - that scope[] contains strings (Array.isArray is enough at this seam)

  what happens on a failed check:
    isAnomalyArray returns false → the calling agent returns []
    (the briefing degrades to "no anomalies" rather than crashing)
```

What breaks if you tighten this guard to require `evidence`: agents that happen to omit it (older runs, demo replays) fail the guard. The current guard is **permissive on optionals, strict on required-required-for-rendering** — a deliberate looseness so the pipeline degrades gracefully on the broadest set of agent outputs.

#### `isDiagnosis(v)` — the Diagnosis shape guard

Simpler. Three fields, all required:

```
  isDiagnosis — the check

  typeof v === 'object' && v !== null
    AND typeof conclusion === 'string'
    AND Array.isArray(evidence)
    AND Array.isArray(hypothesesConsidered)

  what's NOT checked:
    - whether hypothesesConsidered elements have the rich
      { hypothesis, supported, reasoning } shape — accepts string[]
      too (this is how Investigation.diagnosis's lossy form sneaks
      through; file 02 covers that)
    - confidence (optional, derived if missing)
    - affectedCustomers, timeSeries (both optional)

  what happens on a failed check:
    isDiagnosis returns false → the agent falls back to FALLBACK
    constant { conclusion: 'Insufficient data...', evidence: [], hypothesesConsidered: [] }
```

#### `isRecommendationArray(v)` — the Recommendation[] shape guard

Validates the **id-less** shape the agent emits (the system assigns ids after validation — see `recommendation.ts` L75). The `estimatedImpact` field is union-typed (string OR `{ range, ... }`) and both branches are checked:

```
  isRecommendationArray — the check

  Array.isArray(v) AND every element:
    typeof === 'object'
    AND typeof title === 'string'
    AND typeof rationale === 'string'
    AND bloomreachFeature in ('scenario'|'segment'|'campaign'|'voucher'|'experiment')
    AND Array.isArray(steps)
    AND estimatedImpact is:
       typeof === 'string'  OR  (object && typeof estimatedImpact.range === 'string')
    AND confidence in ('high'|'medium'|'low')

  what's NOT checked:
    - id (deliberate — agent emits id-less; system assigns)
    - effort, timeToSetUpMinutes, readResultInDays, prerequisites,
      successMetric (all Tier 1 optional)
    - estimatedImpact.rangeUsd structure (loose — accepted as-is)
```

### Move 2 — the in-memory store has no atomicity story

The opposite end of the spectrum. The in-memory Maps in `lib/state/insights.ts` have **no transactional boundary**. `putInsights` clears both `insights` and `anomalies`, then iterates the new items and inserts both. If a JS exception fired mid-loop (it can't today — there's no I/O in the loop — but in principle), the store would be in a half-cleared state.

```
  putInsights — what it actually does, in order

  1. insights.clear()       ← Map A cleared
  2. anomalies.clear()      ← Map B cleared
  3. for each item:
       a. insights.set(i.id, i)
       b. if rawAnomalies[idx]: anomalies.set(i.id, rawAnomalies[idx])
  4. (no commit; no error path)

  what's atomic:                   what's NOT atomic:
    each Map.set call (within        the sequence of 2 clears
    a Map: thread-safe by Node       the sequence of N inserts
    single-thread)                   the cross-Map invariant
                                     "every insights key has an
                                      anomalies key"
```

In a relational store this would be:
```sql
BEGIN;
DELETE FROM insights;
DELETE FROM anomalies;
INSERT INTO insights VALUES (...);
INSERT INTO anomalies VALUES (...);
COMMIT;
```
…with `ON DELETE CASCADE` on the FK `anomalies.insight_id → insights.id`, so the parallel store can't drift.

**What breaks today: nothing, because Node is single-threaded and the loop has no I/O.** A thrown exception in step 3 *would* leave the Maps half-populated, but no realistic code path throws there. The integrity story is: "the runtime model makes the invariant trivially true." That holds as long as the runtime model holds. When the runtime shifts (truly multi-worker, or any I/O in the write path), the story fails silently — the next reader sees a half-cleared store.

### Move 2 — the wire-format integrity check

The only place the route handler validates an *external* shape: `resolveAnomaly` in `app/api/agent/route.ts` (L37–L47) parses the `?insight=` query parameter as JSON and checks four fields before trusting it.

```
  resolveAnomaly — the inline guard

  if (insightParam) {
    try {
      const i = JSON.parse(insightParam) as Insight;
      if (i && typeof i.metric === 'string'
            && i.change
            && Array.isArray(i.scope)
            && i.severity) {
        return insightToAnomaly(i);    ← trusted path
      }
    } catch {
      /* malformed param — fall through to server-side lookup */
    }
  }
  // fallthrough: try in-memory, then demo seed

  what's checked:    metric (string), change (truthy), scope (array), severity (truthy)
  what's NOT checked: that change has value/direction/baseline; that severity is a valid enum
                      value; that scope is a string array
  why fail-soft:     wire-format manipulation shouldn't crash the route. fall through
                     to the server-side lookup; if that also fails, return 404.
```

This is **defense-in-depth** for one specific seam: the browser can send anything in the URL query string, so the route validates inline. The check is intentionally loose — it's a sanity gate, not a full schema validation. The compiler can't help (the cast `as Insight` is a *promise*, not a check).

### Move 3 — the principle

Integrity lives at boundaries. The compiler covers the in-language boundaries; runtime guards cover the language boundaries (JSON-from-LLM, JSON-from-URL); transactions cover the store boundaries. This repo's strong half is the LLM-seam guards — correctly placed, fail-closed, permissive on optionals. Its weak half is the missing store-level integrity: no atomicity, no FK, no cross-Map invariant enforcement. That weakness is **inherited from the storage choice** (in-memory `Map`), not from the code. The moment the store grows up — Postgres, SQLite, even a disk-backed kv — the FK constraint plus the transaction will retire the weakness for free.

---

## Primary diagram

The integrity layers, recap.

```
  Integrity — what guards what, where

  ┌─ LLM seam ────────────────────────────────────────────────┐
  │   model output (string)                                    │
  │         │                                                   │
  │         ▼                                                   │
  │   parseAgentJson — handles fenced/bare/embedded JSON       │
  │         │                                                   │
  │         ▼                                                   │
  │   isAnomalyArray | isDiagnosis | isRecommendationArray     │
  │         │                                                   │
  │         ▼                                                   │
  │   trusted typed value OR fail-closed neutral ([], null)    │
  │   ★ STRONG: 3 guards, narrow, fail-soft, well-placed       │
  └────────────────────────────────────────────────────────────┘

  ┌─ wire format seam ────────────────────────────────────────┐
  │   ?insight=<JSON> from browser                              │
  │         │                                                    │
  │         ▼                                                    │
  │   JSON.parse + inline 4-field shape check                   │
  │         │                                                    │
  │         ▼                                                    │
  │   trusted Insight OR fall through to server-side lookup     │
  │   ★ OK: narrow check, sensible fallback                     │
  └────────────────────────────────────────────────────────────┘

  ┌─ in-memory store ─────────────────────────────────────────┐
  │   putInsights:                                              │
  │     insights.clear() + anomalies.clear() + N pairs of set   │
  │         │                                                    │
  │         ▼                                                    │
  │   NO transaction. NO FK. NO cross-Map invariant enforcement │
  │   ★ WEAK: holds today only because the runtime is           │
  │     single-threaded and the loop has no I/O                 │
  └────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### The three runtime guards

```
lib/mcp/validate.ts  (lines 1–57)

  export function parseAgentJson(text: string): unknown {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fence ? fence[1] : text).trim();
    try { return JSON.parse(candidate); }
    catch { /* fall through to substring scan */ }
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('no parseable json in agent output');
  }
       │
       └─ three-fallback parser. the fenced-block case is the
          common path; the substring scan is the "agent wrote prose
          around the JSON" recovery.

  const SEVERITIES: Severity[] = ['critical', 'warning', 'info', 'positive'];

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
       │
       └─ the workhorse. note the `v is Anomaly[]` type predicate —
          this is how TypeScript narrows the type for callers after a
          true return. cast through `as any` for the field accesses
          (the input is `unknown`); the predicate then rebinds the
          narrowed type at the call site.
```

### The fail-closed pattern at the agent layer

```
lib/agents/monitoring.ts  (lines 112–119)

  let parsed: unknown;
  try {
    parsed = parseAgentJson(finalText);
  } catch {
    return [];                       ← fail-closed: empty briefing
  }
  if (!isAnomalyArray(parsed)) return [];   ← fail-closed: empty briefing
  return [...parsed]
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
    .slice(0, 10);
       │
       └─ the two return-[] paths are the integrity gate. invalid JSON
          OR wrong shape → empty array. the briefing renders "no
          anomalies found" rather than crashing on a malformed field
          access in the UI.
```

### The non-atomic store write

```
lib/state/insights.ts  (lines 30–42)

  export function putInsights(items: Insight[], rawAnomalies?: Anomaly[]): void {
    // Replace the previous briefing — each run IS the current feed, not an
    // addition. Without clearing, a warm serverless instance accumulates
    // stale insights from earlier runs ...
    insights.clear();                     ← 1
    anomalies.clear();                    ← 2
    items.forEach((i, idx) => {
      insights.set(i.id, i);              ← 3a
      if (rawAnomalies?.[idx]) anomalies.set(i.id, rawAnomalies[idx]);  ← 3b
    });
  }
       │
       └─ no transaction. holds today because: (a) Node is single-threaded,
          (b) the loop has no I/O. if either changes, the cross-Map
          invariant ("every insights key has an anomalies key when
          rawAnomalies was passed") becomes a possible-violation. the
          fix is mechanical: a real store with FK + transactional clear.
```

### The wire-format inline check

```
app/api/agent/route.ts  (lines 37–47)

  if (insightParam) {
    try {
      const i = JSON.parse(insightParam) as Insight;
      if (i && typeof i.metric === 'string'
            && i.change
            && Array.isArray(i.scope)
            && i.severity) {
        return insightToAnomaly(i);
      }
    } catch {
      /* malformed param — fall through to the server-side lookup */
    }
  }
       │
       └─ narrow 4-field check. fail-soft: any malformed input falls
          through to the in-memory lookup, then the demo seed. the
          route returns 404 only if all three sources are empty.
```

---

## Elaborate

The interesting tension in this design: the LLM-seam guards are stricter than the wire-format guard. The LLM seam validates 7 fields (`isAnomalyArray`); the wire-format seam validates 4. Why? Because the LLM seam is *adversarial-by-default* — the model can hallucinate any shape. The wire-format seam is *trusted-by-default* — the JSON came from the same app's own `?insight=` link, just round-tripped through the browser. The asymmetry is correct, but worth noting: if the route ever accepts `?insight=` from outside the app (a saved link, a webhook), the 4-field check is too loose. Today the trust model is "the browser is honest"; if that breaks, tighten the gate.

A subtle point about the guards: they're hand-rolled, but they exist *because TypeScript can't help here*. A common reaction is "use Zod and derive both the type and the guard from one source." That would replace 50 lines of hand-rolled checks with 30 lines of Zod schemas, gain runtime introspection, and lose nothing — except the dependency. For this repo's size (3 guards), the hand-rolled path is fine. At 8+ guards or a single shape that's edited often, Zod earns its place.

The deeper integrity story: **the LLM seam is the only place where the system actively distrusts its own components.** Everywhere else, the code trusts: the route trusts the state module, the state module trusts the agent, the agent trusts the MCP wrapper. That trust is *fine* when both sides are typed and tested. At the LLM seam it isn't, because the model isn't typed and can't be tested for every shape it might emit. That's why the guards earn their place. Generalizing: any time you parse JSON from an untyped source, you're at an integrity seam — typed contract on one side, free-form text on the other. The guard is non-optional.

A point on FKs that don't exist: the closest thing to an FK in this repo is `Investigation.insightId`. Today it's "the key the investigation is stored under in the `investigations` Map" — which is trivially consistent because the only writer is `putInvestigation`, which uses the same id as both the field and the Map key. If those ever diverged (say, an investigation stored under a normalized hash but referencing the raw id), you'd want an FK constraint. The relational migration would catch this for free.

## Interview defense

**Q: How does this repo enforce data integrity?**
A: Three layers, three mechanisms. TypeScript at every in-language boundary — the compiler catches mismatched shapes between modules. Runtime guards at the **LLM seam** — `validate.ts` has three guards (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`) that narrow `unknown` to the expected type before downstream code touches it. Inline shape checks at the **wire-format seam** — `resolveAnomaly` validates four fields of the `?insight=` query param before trusting it. The in-memory store has *no* atomicity — `putInsights` clears two Maps non-transactionally — but it holds today because Node is single-threaded and the write path has no I/O.

**Q: Walk me through the most important integrity check in the repo.**
A: The `isAnomalyArray` guard in `lib/mcp/validate.ts` (L17–L27). The monitoring agent emits a JSON string; `parseAgentJson` handles fenced/bare/embedded shapes; `isAnomalyArray` checks the seven required fields per element. The guard is a TypeScript type predicate (`v is Anomaly[]`) so callers get narrowing for free after a true return. The fail-closed return — `[]` on any malformed input — is the load-bearing piece: the briefing degrades to "no anomalies" rather than crashing the route. Drop that fail-closed and one bad LLM response takes down the whole feed.

```
  diagram while you talk

  model output (string)
        │
        ▼
  parseAgentJson  ← fenced ```json | bare | substring scan
        │
        ▼  unknown
  isAnomalyArray  ← checks 7 fields per element
        │
   ┌────┴────┐
   ▼         ▼
  true       false
   │           │
   ▼           ▼
  Anomaly[]   return []  ← fail-closed; briefing renders "no anomalies"
```

## Validate

1. **Reconstruct.** Without opening the file: name the three runtime guards in `lib/mcp/validate.ts`. For each, name the boundary it protects and the fail-closed return.

2. **Explain.** Why does `parseAgentJson` have three fallbacks (fenced block, bare JSON, substring scan)? What real LLM output shapes does each handle, and what fails if you drop the substring scan?

3. **Apply.** A new agent emits `{ surprise: 'X' }[]` as its output. Trace: which guard catches it (or fails to catch it)? What's the fail-closed return, and what does the user see in the UI?

4. **Defend.** Someone says "Node is single-threaded, so `putInsights` is already atomic — you don't need a transaction." Counter the argument. (Hint: the JS *event loop* is single-threaded but the *write path* can grow I/O — a future caller awaiting between clear and set would re-introduce the race; also, "single-process" stops being true the moment you scale to multiple serverless instances.)

## See also

- `01-the-data-model-and-its-shape.md` — the 8 interfaces the guards narrow to.
- `02-normalization-and-duplication.md` — the cross-Map invariant (`insights` ↔ `anomalies` keyed alignment) and why no current code path enforces it.
- `05-migrations-and-evolution.md` — why the guards are deliberately permissive on optional fields (so older snapshots still validate).
- `06-access-patterns-and-storage-choice.md` — the in-memory storage choice is what removes the transactional layer; a relational migration retires the weakness.
- `study-software-design/audit.md#information-hiding-and-leakage` — the LLM-seam parsing logic is a strong hide (no caller knows the JSON-extraction fallback chain).
