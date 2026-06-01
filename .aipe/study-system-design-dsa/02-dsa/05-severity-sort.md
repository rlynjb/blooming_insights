# Rank-mapped sort + set union

**Industry name(s):** comparator sort with a rank/ordinal mapping, top-N truncation; set-union deduplication
**Type:** Industry standard · Language-agnostic

> A rank table converts a string enum into integers so `Array.prototype.sort` can order anomalies by severity, and `new Set` collapses three overlapping tool arrays into one deduplicated union in a single spread.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** `SEV_RANK`'s sort lives inside `MonitoringAgent.scan` (`lib/agents/monitoring.ts` L51 + L119) — it's the last operation before the agent returns its `Anomaly[]` to the briefing route, sandwiched between `parseAgentJson` + `isAnomalyArray` (which produced the array) and `anomalies.map(anomalyToInsight)` (which projects to `Insight[]`). The `queryTools` Set-union (`lib/mcp/tools.ts` L38–L40) lives in the Tools band and is read at module load by `QueryAgent` when it asks `filterToolSchemas` for the deduplicated tool list. Both primitives sit in the Per-agent definitions / Tools layer of the architecture map — pure functions over data already in hand, called once per request.

```
Zoom out — where the sort + dedup live

┌─ Per-agent definitions ────────────────────────┐  ← we are here
│  MonitoringAgent.scan (lib/agents/monitoring.ts)│
│    finalText → parseAgentJson → isAnomalyArray  │
│    ★ [...parsed].sort(SEV_RANK[b]-SEV_RANK[a]) │
│    ★ .slice(0, 10) → return Anomaly[]          │
│                                                  │
│  QueryAgent (reads tools array)                 │
│         ▲                                       │
│         │                                       │
│  Tools band (lib/mcp/tools.ts)                  │
│  ★ queryTools = [...new Set([...m,...d,...r])] │ ← we are here
│      monitoringTools ∪ diagnosticTools ∪        │
│      recommendationTools (first-seen, no dupes) │
└─────────────────────┬──────────────────────────┘
                      │
┌─ Route / mapping ──────────────────────────────┐
│  app/api/briefing/route.ts                     │
│  anomalies.map(anomalyToInsight) → insights[]  │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you impose a custom total order on a non-numeric enum (so `Array.prototype.sort` can do its job), and how do you merge overlapping arrays without duplicates? The answer is a `Record<Severity, number>` rank table that lets the comparator subtract integers (`SEV_RANK[b.severity] - SEV_RANK[a.severity]`) and `[...new Set([...a, ...b, ...c])]` that uses Set's identity rule to collapse three overlapping arrays into one first-seen-wins union. The TypeScript `Record<Severity, number>` type makes adding a new severity to the union a compile-time error if you forget to add it to the rank table. The next sections trace both operations step by step.

---

## Structure pass

**Layers.** The sort + dedup primitives sit in a tight three-layer stack: the **input** (the parsed-but-unordered array — `Anomaly[]` for sort, three overlapping tool arrays for union), the **transform** (the rank table + comparator, or the `new Set` collapse), and the **output** (a sorted, top-N-truncated array, or a deduplicated union). All three layers are pure — no I/O, no async, no state outside the call.

**Axis: cost.** Operations per element, comparisons per call, time complexity? This is the right axis because both primitives ARE cost-shape decisions: the rank table replaces O(N) string comparisons with O(1) integer subtractions inside the comparator (which runs O(N log N) times), and `new Set` replaces an O(N²) cross-product dedup with O(N) hash insertion. State is the obvious alternate (data flows through), but state here is uninteresting — everything is immutable input → immutable output. Pick cost and the rank table reveals itself as the load-bearing optimization; pick state and it looks like decoration.

**Seams.** Two seams matter; both are load-bearing because they're where the cost shape changes. **Seam 1: string severity → integer rank.** Cost flips from "O(N) lexical compare per pair × O(N log N) pairs = O(N² log N) char compares" (naive string compare) to "O(1) integer subtract × O(N log N) pairs = O(N log N)" (rank table). The `SEV_RANK` table is the joint that buys this. **Seam 2: three arrays → Set → array.** Cost flips from "O(N²) cross-product dedup" (naive nested loop) to "O(N) hash insert + O(N) array spread = O(N)" (Set). The `new Set([...a, ...b, ...c])` idiom is the joint.

```
Structure pass — rank-mapped sort + set union

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Input (parsed array) · Transform (rank table +     │
│  comparator, or new Set collapse) · Output          │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  cost: ops per element, comparisons per call, big-O  │
│  shape across the layers                             │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: string severity → integer rank ★load-bearing    │
│      (O(N² log N) char compares → O(N log N) ints)   │
│  S2: three arrays → Set → array ★load-bearing        │
│      (O(N²) cross-product → O(N) hash insert)        │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

```
S1 seam — "how do we compare two severities?" answered two ways

┌─ Without rank table┐    seam     ┌─ With rank table ─────┐
│  cmp("critical",   │ ═════╪═════►│  SEV_RANK[b] -         │
│   "warning"): O(N) │  (it flips) │   SEV_RANK[a]: O(1)    │
│   char compares    │             │  integer subtract       │
└────────────────────┘             └────────────────────────┘
        ▲                                       ▲
        └────── same axis (cost), two answers ─┘
                → the rank table is the cost-flip primitive
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

---

## How it works

**Mental model.** A comparator is a function that returns a number. If the number is negative, `a` sorts before `b`. If positive, `b` sorts before `a`. If zero, their order is unchanged (JS sort is stable). The rank table is the bridge: it maps each string severity to an integer so the comparator has numbers to subtract.

The following diagram shows the string-to-number bridge:

```
  severity string          SEV_RANK table           numeric key
  ───────────────────────────────────────────────────────────────
  "critical"   ──────────▶  { critical: 3 }  ──────▶  3
  "warning"    ──────────▶  { warning:  2 }  ──────▶  2
  "info"       ──────────▶  { info:     1 }  ──────▶  1
  "positive"   ──────────▶  { positive: 0 }  ──────▶  0
  ───────────────────────────────────────────────────────────────
  comparator:  SEV_RANK[b.severity] - SEV_RANK[a.severity]
               ▲ descending: higher rank → earlier position
```

Three sub-operations compose the full pipeline.

### The rank table

`SEV_RANK` is a plain object literal — a Record that maps each `Severity` string to an ordinal integer. The TypeScript type `Record<Severity, number>` enforces that every member of the union is present; if you add a new severity to the union and forget to add it here, `tsc` errors at compile time, not at sort time.

```
  const SEV_RANK: Record<Severity, number> = {
    critical: 3,
    warning:  2,
    info:     1,
    positive: 0,
  };
```

The integers are arbitrary as long as the relative order is correct. They could be `100, 50, 10, 0` — the comparator only looks at the sign of the difference.

### The comparator

```
  (a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]
```

This is **descending** order: `b` minus `a`. When `b` is `critical` (3) and `a` is `info` (1), the result is `3 - 1 = 2` (positive), so `b` moves before `a`. If the expression were `a - b`, critical would sort last. The sign of `b - a` is what descending means.

### Top-N cap

```
  .slice(0, 10)
```

`slice(0, 10)` returns a new array of at most 10 elements starting from index 0. If the sorted array has 6 elements, you get 6. If it has 30, you get 10. It does not mutate the original. This bounds the payload sent downstream regardless of how many anomalies the model returns.

### Set-union dedup

```
  [...new Set<string>([...monitoringTools, ...diagnosticTools, ...recommendationTools])]
```

Spreading three arrays into a single `new Set` constructor iterates all values in insertion order. `Set` ignores duplicates by identity: for primitive strings, two equal strings are identical. The outer spread `[...set]` converts the Set back to an array, preserving the insertion-order of first occurrence. Tools that appear in multiple source arrays survive once — at the position they first appeared.

```
  monitoringTools    diagnosticTools    recommendationTools
  ────────────────   ────────────────   ────────────────────
  execute_analytics  execute_analytics  list_scenarios
  list_dashboards    get_funnel         list_segmentations
  get_funnel         list_customers     list_email_campaigns
                     list_segmentations

  spread all three → Set insertion order (first-seen wins):
  ┌──────────────────────────────────────────────────────────┐
  │ execute_analytics · list_dashboards · get_funnel         │
  │ list_customers · list_segmentations · list_scenarios     │
  │ list_email_campaigns · …                                 │
  └──────────────────────────────────────────────────────────┘
  duplicates across arrays: gone. order: stable, first-seen.
```

---

### Step-by-step execution trace — sort

Input array (after `parseAgentJson`, before sort):

```
  index  severity    SEV_RANK
  ─────────────────────────────
  0      "info"      1
  1      "critical"  3
  2      "warning"   2
  3      "positive"  0
  4      "info"      1
```

JS's Timsort will compare various pairs. Walking through the key comparisons that determine final order (every comparison the engine must resolve, in a representative execution):

```
  Step 1  compare index 1 ("critical",3) vs index 0 ("info",1)
          b=critical(3), a=info(1) → 3 - 1 = +2  → b before a
          partial order: [critical, info, ...]

  Step 2  compare index 2 ("warning",2) vs index 1 ("critical",3)
          b=warning(2), a=critical(3) → 2 - 3 = -1 → a before b
          partial order: [critical, warning, ...]

  Step 3  compare index 2 ("warning",2) vs index 0 ("info",1)
          b=warning(2), a=info(1) → 2 - 1 = +1  → b before a
          partial order: [critical, warning, info, ...]

  Step 4  compare index 3 ("positive",0) vs index 2 ("warning",2)
          b=positive(0), a=warning(2) → 0 - 2 = -2 → a before b
          partial order: [..., warning, positive]

  Step 5  compare index 4 ("info",1) vs index 2 ("warning",2)
          b=info(1), a=warning(2) → 1 - 2 = -1 → a before b

  Step 6  compare index 4 ("info",1) vs index 0 (first "info",1)
          b=info(1), a=info(1) → 1 - 1 = 0  → stable, original order kept
```

Final sorted array before `.slice`:

```
  index  severity    SEV_RANK
  ─────────────────────────────
  0      "critical"  3         ← highest rank first
  1      "warning"   2
  2      "info"      1         ← original index 0 (stable)
  3      "info"      1         ← original index 4 (stable)
  4      "positive"  0
```

After `.slice(0, 10)`: all 5 elements returned (fewer than 10).

---

### Step-by-step execution trace — Set union

Three small arrays for illustration (simplified from the real constants):

```
  monitoringTools   = ["execute_analytics", "list_dashboards", "get_funnel"]
  diagnosticTools   = ["execute_analytics", "get_funnel",      "list_customers"]
  recommendationTools = ["list_scenarios",  "list_segmentations"]
```

```
  new Set([...monitoringTools, ...diagnosticTools, ...recommendationTools])

  insertion order:
  1. "execute_analytics"   → not in Set → ADD     Set: {execute_analytics}
  2. "list_dashboards"     → not in Set → ADD     Set: {execute_analytics, list_dashboards}
  3. "get_funnel"          → not in Set → ADD     Set: {…, get_funnel}
  4. "execute_analytics"   → ALREADY IN → SKIP
  5. "get_funnel"          → ALREADY IN → SKIP
  6. "list_customers"      → not in Set → ADD     Set: {…, list_customers}
  7. "list_scenarios"      → not in Set → ADD     Set: {…, list_scenarios}
  8. "list_segmentations"  → not in Set → ADD     Set: {…, list_segmentations}

  [...set] = ["execute_analytics","list_dashboards","get_funnel",
              "list_customers","list_scenarios","list_segmentations"]
  Length: 6 (down from 8 raw elements)
```

The principle: map categories to a total order via a lookup table; use Set to get deduplication for free as a property of set membership rather than an explicit loop.

---

## Rank-mapped sort + set union — diagram

The primary recap: both operations together.

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  RANK-MAPPED SORT + TOP-N                                        │
  │                                                                  │
  │  Anomaly[]  (raw, from model)                                    │
  │  ┌──────────────────────────────┐                                │
  │  │ {severity:"info"}            │                                │
  │  │ {severity:"critical"}        │  [...parsed]                   │
  │  │ {severity:"warning"}         │  (non-destructive copy)        │
  │  │ {severity:"positive"}        │                                │
  │  └──────────────────────────────┘                                │
  │            │                                                     │
  │            ▼  .sort( (a,b) => SEV_RANK[b.severity]              │
  │                              - SEV_RANK[a.severity] )           │
  │            │                                                     │
  │  ┌──────────────────────────────┐                                │
  │  │ {severity:"critical"}  rank 3│  highest first                 │
  │  │ {severity:"warning"}   rank 2│                                │
  │  │ {severity:"info"}      rank 1│                                │
  │  │ {severity:"positive"}  rank 0│                                │
  │  └──────────────────────────────┘                                │
  │            │                                                     │
  │            ▼  .slice(0, 10)                                      │
  │            │                                                     │
  │  Anomaly[]  (≤10, most severe first)  → returned to caller       │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │  SET-UNION DEDUP                                                  │
  │                                                                  │
  │  monitoringTools     = [A, B, C,    E]                           │
  │  diagnosticTools     = [   B,    D, E, F]                        │
  │  recommendationTools = [         D,    F, G]                     │
  │                                                                  │
  │  [...monitoringTools, ...diagnosticTools, ...recommendationTools]│
  │  = [A, B, C, E, B, D, E, F, D, F, G]   ← raw, with dupes       │
  │                                          │                       │
  │                          new Set(...)    │                       │
  │                                          ▼                       │
  │                         {A, B, C, E, D, F, G}  (first-seen)     │
  │                                          │                       │
  │                          [...set]        ▼                       │
  │                         [A, B, C, E, D, F, G]  ← queryTools     │
  └─────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**File:** `lib/agents/monitoring.ts`
**Function / class:** `SEV_RANK` constant + `MonitoringAgent.scan`
**Line range:** L51 (rank table) · L119 (sort + slice)

```typescript
// lib/agents/monitoring.ts L51
const SEV_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1, positive: 0 };

// lib/agents/monitoring.ts L119
return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
```

GitHub: https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/monitoring.ts#L51
GitHub: https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/monitoring.ts#L119

---

**File:** `lib/mcp/tools.ts`
**Function / class:** `queryTools` (exported const)
**Line range:** L38–L40

```typescript
// lib/mcp/tools.ts L38–L40
export const queryTools = [
  ...new Set<string>([...monitoringTools, ...diagnosticTools, ...recommendationTools]),
] as const;
```

GitHub: https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/tools.ts#L38-L40

---

## Elaborate

**Where it comes from.** Comparator-based sorting is part of the ECMAScript spec (`Array.prototype.sort`, ES2019 mandated stable sort). The pattern of mapping a categorical variable to an ordinal integer before sorting is as old as database `ORDER BY` with a `CASE WHEN` expression — it predates JS. Set theory defines union as the set of all elements from two or more sets with no repetition; JS `Set` is a direct implementation for primitives and object references.

**The deeper principle.** A total order requires that every pair of elements is comparable. The string enum `Severity` has no natural numeric order — the language cannot tell you `"critical" > "warning"`. The rank table is an injection from the enum into the integers (ℕ), borrowing ℕ's total order. The comparator then operates entirely in ℕ. The diagram below shows the injection:

```
  Severity enum          ℕ (integers)
  ──────────────         ─────────────
  "critical"   ──────▶   3
  "warning"    ──────▶   2
  "info"       ──────▶   1
  "positive"   ──────▶   0
  ──────────────         ─────────────
  injective: each string maps to a distinct integer
  total order on ℕ inherited by Severity via SEV_RANK
```

**Where it breaks down.**

- **Ties keep input order** — JS sort is stable (guaranteed since V8 7.0 / Node 11). Two `"info"` anomalies stay in the order they appeared in `parsed`. This is fine here because equal-severity anomalies have no meaningful secondary sort.
- **Missing key → `undefined` → NaN comparison** — if `severity` holds a value not in `SEV_RANK` (e.g. a new enum member added to the union but not to the table), `SEV_RANK[b.severity]` is `undefined`, and `undefined - 1` is `NaN`. `Array.prototype.sort` treats NaN comparisons as 0 (equal), so the item floats to an unpredictable position. TypeScript's `Record<Severity, number>` prevents this at compile time, but only if every path producing an `Anomaly` goes through the type checker.
- **Set dedup is reference/primitive-based** — if `monitoringTools` held objects instead of strings, two objects `{ name: "execute_analytics" }` would not deduplicate even if their properties are equal, because `Set` uses `===` (reference identity) for objects.

**What to explore next.**

- Stable sort guarantees: why V8's Timsort is stable, and what changed in Chrome 70 / Node 11 when it became spec-mandated.
- Multi-key sort: how to chain comparators `(SEV_RANK[b.s] - SEV_RANK[a.s]) || (b.timestamp - a.timestamp)` for a secondary sort within the same severity.
- `Map`-based grouping: how `Map<Severity, Anomaly[]>` can replace both the sort and a downstream `filter` when you need all anomalies of each severity in separate buckets.

---

## Interview defense

**What they are really asking:** can you design a custom sort order for non-numeric data? Do you know how `Array.prototype.sort` comparators work, what stable sort means, and how `Set` handles deduplication? Can you identify the failure modes?

---

**[mid] "How does the sort in `MonitoringAgent.scan` work? Walk me through it."**

The sort uses a rank table `SEV_RANK` declared at `lib/agents/monitoring.ts L51`. Each `Severity` string maps to an integer: critical=3, warning=2, info=1, positive=0. The comparator `SEV_RANK[b.severity] - SEV_RANK[a.severity]` subtracts `a`'s rank from `b`'s rank. When the result is positive, `b` sorts before `a` — that is the descending direction. After the sort, `.slice(0, 10)` caps the array at ten elements.

```
  comparator(a="info", b="critical"):
  SEV_RANK["critical"] - SEV_RANK["info"]
  =  3  -  1  =  +2   →  b before a   ✓ critical surfaces first
```

---

**[senior] "Why a separate `SEV_RANK` constant instead of just storing a numeric severity on the `Anomaly` type and sorting by that?"**

This is the dodge the interviewer expects. The honest answer: storing rank on the `Anomaly` would work, but the rank would be model-generated data. The model emits an Anomaly object; a numeric `rank` field would need to be validated against the allowed range and cross-checked for consistency with the `severity` string. If the model emits `{ severity: "critical", rank: 0 }`, which do you trust?

The rank table is a local compile-time artifact. It never leaves the server, cannot be corrupted by model output, and is enforced complete by the TypeScript type `Record<Severity, number>`. The comparison diagram:

```
  Option A: rank on Anomaly                Option B: SEV_RANK table (current)
  ─────────────────────────────────        ─────────────────────────────────────
  Source of rank: model (runtime)          Source of rank: const (compile time)
  Validation: parse + range check          Validation: tsc enforces Record<K,N>
  Failure mode: model emits wrong rank     Failure mode: missing key → undefined
  Fix: schema validation + fallback        Fix: add key to Record, tsc catches it
```

The SEV_RANK table is the more trustworthy option specifically because anomaly data is model-generated and therefore unreliable.

---

**[arch] "If a new severity level is introduced — say `'urgent'` between `critical` and `warning` — what breaks and what is the blast radius?"**

Two things need updating: the `Severity` type union in `lib/mcp/types.ts`, and `SEV_RANK` in `lib/agents/monitoring.ts L51`. Because `SEV_RANK` is typed `Record<Severity, number>`, adding `'urgent'` to the union without adding it to the table is a compile-time error — `tsc` fails the build. The blast radius is controlled: the type system surfaces the gap before runtime.

The Set union in `queryTools` (`lib/mcp/tools.ts L38–L40`) is unaffected — it operates on tool names, not severities. The `.slice(0, 10)` cap is unaffected. The only runtime risk is the window between deploying new model prompts (that now emit `'urgent'`) and deploying the updated `SEV_RANK` — in that window, `SEV_RANK['urgent']` is `undefined`, the comparator returns NaN for any pair involving `'urgent'`, and those anomalies float to an unpredictable position. The mitigation is a fallback in the comparator: `(SEV_RANK[b.severity] ?? -1) - (SEV_RANK[a.severity] ?? -1)`, which sends unknown severities to the bottom.

---

**Anchors.**

- `lib/agents/monitoring.ts L51` — `SEV_RANK` definition
- `lib/agents/monitoring.ts L119` — sort + slice on the returned anomaly array
- `lib/mcp/tools.ts L38–L40` — `queryTools` Set-union dedup
- `lib/mcp/tools.ts L5–L13` / `L15–L25` / `L27–L34` — the three source tool arrays whose overlaps the Set collapses

---

## Validate your understanding

**Level 1 — reconstruct.** Without looking at the file: write the `SEV_RANK` constant and the sort + slice expression from memory. Then open `lib/agents/monitoring.ts L51` and `L119` and compare. The types, the order of subtraction (`b - a` not `a - b`), and the slice bound (`10`) are the three things most often misremembered.

**Level 2 — explain.** Open `lib/agents/monitoring.ts`. The `scan` method at L69 calls `runAgentLoop`, gets `finalText`, parses it, validates it, and then applies the sort at L119. Explain to a colleague why `[...parsed]` is needed before `.sort(...)` — what would happen if `sort` were called directly on `parsed`? Then explain why `.slice(0, 10)` appears after sort rather than before.

**Level 3 — apply.** Two scenarios anchored to the real files:

Scenario A: An agent returns an anomaly with `severity: "urgent"` — a value not in `SEV_RANK` (`lib/agents/monitoring.ts L51`). What does `SEV_RANK["urgent"]` evaluate to? What does `undefined - 2` evaluate to? What does `Array.prototype.sort` do when the comparator returns `NaN`? Where in the sorted array does the `"urgent"` anomaly end up — and is that the right behavior?

Scenario B: `monitoringTools` and `diagnosticTools` both contain `"execute_analytics"` (`lib/mcp/tools.ts L11` and `L16`). Trace through `new Set([...monitoringTools, ...diagnosticTools, ...recommendationTools])` at `lib/mcp/tools.ts L39`. At what position in the iteration does the second `"execute_analytics"` appear? Does the Set insert it? What is the length of `queryTools` vs the sum of the three source array lengths? Does the Set preserve the order of first occurrence?

**Level 4 — defend.** A teammate suggests replacing the `SEV_RANK` object with an array: `const SEV_ORDER = ['critical', 'warning', 'info', 'positive']` and using `SEV_ORDER.indexOf(b.severity) - SEV_ORDER.indexOf(a.severity)` as the comparator. What is the time complexity of `indexOf` per comparison? What does `indexOf` return for an unknown severity? What is the arithmetic result of `indexOf(unknown) - indexOf("info")` = `-1 - 1 = -2`? Is `-2` the correct signal (unknown sorts before warning)? Compare this to `SEV_RANK[unknown] - SEV_RANK["info"]` = `undefined - 1 = NaN`. Which failure mode is worse, and why?

**Quick check.**

- What is the result of `SEV_RANK["critical"] - SEV_RANK["positive"]`? What does that sign mean for sort order?
- Why does `[...new Set([...a, ...b])]` preserve insertion order?
- If `sort` is stable and two anomalies share `severity: "info"`, which appears first in the output?
- What TypeScript type on `SEV_RANK` ensures every `Severity` member has an entry?
- What does `.slice(0, 10)` return if the sorted array has only 3 elements?

## See also

→ 04-json-from-prose.md · → ../01-system-design/06-multi-agent-orchestration.md

---
Updated: 2026-05-28 — refreshed code references to current line numbers (sort + slice moved L92 → L102; `SEV_RANK` and `queryTools` refs unchanged)

---
Updated: 2026-05-29 — sort + slice moved L102 → L119; `SEV_RANK` now L51 (was cited L50); `scan` method L69 (was L68); `queryTools` refs unchanged.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
