# Enrichment derivation

**Industry name(s):** derived/computed fields from existing data (no new I/O); linear scan / find-first; min-by-key reduction (`argmin`); threshold bucketing; shape normalization of a union type
**Type:** Industry standard · Language-agnostic (shown in TypeScript)

> `lib/insights/derive.ts` turns evidence the monitoring agent already computed into business-owner fields — find the first `{current, prior}` pair by linear scan, pick the funnel leak with a `reduce` min-by-key, bucket diagnosis confidence by hypotheses-tested counts, and normalize a string-or-object impact — all pure functions, all O(n) over a handful of items.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The derivation layer lives in `lib/insights/derive.ts` — pure functions that sit between the agents (which emit raw evidence) and the UI (which renders business-owner fields). Three places call into it: `lib/state/insights.ts` L25 spreads `...deriveInsightFields(a)` onto each `Insight` when the briefing route builds it; `lib/agents/diagnostic.ts` L80 labels a `Diagnosis` with `diagnosisConfidence(diag)` before returning it; `components/feed/InsightCard.tsx` L155–L161 runs the funnel-leak `argmin` reduce inline at render. None of it touches the network — every function is a scan or a fold over a handful of items already in hand.

```
Zoom out — where derivation lives

┌─ Agent layer (raw evidence) ───────────────────┐
│  MonitoringAgent → Anomaly[]                   │
│  DiagnosticAgent → Diagnosis                   │
│  RecommendationAgent → EstimatedImpact (union) │
└─────────────────────┬──────────────────────────┘
                      │
┌─ State / build-time mapping ───────────────────┐
│  lib/state/insights.ts L25                     │
│  anomalyToInsight: {...deriveInsightFields(a)} │
└─────────────────────┬──────────────────────────┘
                      │
┌─ Derivation (pure, no I/O) ────────────────────┐  ← we are here
│  ★ lib/insights/derive.ts ★                   │
│    findCurrentPrior · deriveInsightFields      │
│    diagnosisConfidence · hypothesesTested      │
│    impactRange · impactAssumption              │
└─────────────────────┬──────────────────────────┘
                      │
┌─ UI (rendering) ───────────────────────────────┐
│  InsightCard.tsx (funnel-leak argmin reduce)   │
│  EvidencePanel.tsx · RecommendationCard.tsx    │
│  investigationMarkdown.ts (export)             │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you compute the fields a business owner wants to *see* (revenue lost, the leak stage, a confidence label) from the raw evidence an agent already *gathered*, without going back to the source for each one? The answer is to treat any value that is a pure function of data you already hold as a derivation, not a fetch. Each derivation here is a tiny array operation — a linear scan (`findCurrentPrior`), an `argmin` reduce (the funnel leak), a count-and-threshold (`diagnosisConfidence`), or a `typeof` union narrow (`impactRange`/`impactAssumption`) — all `O(n)` over single-digit `n`. The next sections walk each one and show how the same evidence array drives multiple display fields without any extra round-trip.

---

## How it works

**Move 1 — mental model: derivation is a pure projection from evidence to display.**

Each function takes a value the agent produced (an `Anomaly`, a `Diagnosis`, an `EstimatedImpact`) and returns a smaller display-shaped value. No function fetches, mutates input, or holds state. Every one is a fold or a scan over a tiny array.

```
┌─────────────────────────────────────────────────────────────────┐
│  agent output (raw evidence)        derivation        display    │
│                                                                  │
│  Anomaly.evidence[]   ──findCurrentPrior──▶ {current,prior}      │
│                       ──deriveInsightFields─▶ revenueImpact      │
│  Insight.funnel       ──reduce min-by-v────▶ leakKey            │
│  Diagnosis.hyps[]     ──count + bucket─────▶ 'high'|'med'|'low'  │
│  EstimatedImpact      ──typeof normalize───▶ range, assumption   │
└─────────────────────────────────────────────────────────────────┘
```

The boundary is sharp: agents emit evidence; the derivation module emits display fields; components render them. Adding a display field never touches the agent.

### (a) find-first numeric pair — linear scan

A `findCurrentPrior` helper scans an anomaly's `evidence` array for the first element whose `result` carries both a numeric `current` and a numeric `prior`. It returns on the first match; if none, `null`.

```
  evidence: [ e0, e1, e2, … ]
                │
   for each e:  r = e.result
                r.current is number AND r.prior is number ?
                ──yes──▶ return { current: r.current, prior: r.prior }   (stop)
                ──no───▶ next
   fell through ──▶ return null
```

It is `Array.prototype.find` written as a `for` loop so the type narrowing (`typeof r.current === 'number'`) is visible. O(n) over evidence entries; n is the number of tool results on one anomaly — single digits.

The `deriveInsightFields` projection uses that pair: if a pair exists, the metric name matches a revenue-name regex (`/revenue|sales|gmv|total_price|spend/i`), and the change direction is `'down'`, it emits `revenueImpact = { lostUsd: round(current - prior), expectedUsd: round(prior), currency: 'USD' }`. Otherwise it emits an empty object. The UI renders the tile only when the field is present — derivation returns *only what it can compute*.

### (b) the funnel leak point — min-by-key reduce (`argmin`)

In the insight-card component the funnel object `{ view, cart, checkout, purchase }` (each a signed % change vs prior) is first projected into an array of `{ k, v }` pairs, then reduced to the single pair with the smallest `v`:

```
funnel = insight.funnel
funnelStages = funnel
    ? ['view','cart','checkout','purchase'].map(k => ({ k, v: funnel[k] }))
    : []
leakKey = funnelStages.length
    ? funnelStages.reduce((a, b) => b.v < a.v ? b : a).k
    : null
```

`reduce((a, b) => b.v < a.v ? b : a)` with no seed: the accumulator `a` starts as element 0, and each step keeps whichever of `a`/`b` has the smaller `v`. The result is the `{k, v}` with the minimum `v`; `.k` extracts its stage name. This is the classic `argmin` — find the *key* of the minimum, not the minimum value. The empty-array guard (`funnelStages.length ?`) matters because seedless `reduce` on `[]` throws.

```
  funnelStages = [{view,-2},{cart,-5},{checkout,-31},{purchase,-12}]
  reduce min-by-v:
    a={view,-2}
    b={cart,-5}      -5 < -2  → a={cart,-5}
    b={checkout,-31} -31 < -5 → a={checkout,-31}
    b={purchase,-12} -12 < -31? no → a={checkout,-31}
  result.k = "checkout"  →  leakKey = "checkout"  (the worst-dropping stage)
```

### (c) confidence bucketing — count then threshold

A `diagnosisConfidence` helper returns `'high' | 'medium' | 'low'`. It prefers the agent's own `confidence` if set; otherwise it counts supported and tested hypotheses and applies thresholds.

```
  if d.confidence set → return it (agent's own call wins)
  h = d.hypothesesConsidered ?? []
  if h.length === 0 → 'low'         (nothing to reason about)
  supported = count of h where x.supported
  {tested, total} = hypothesesTested(d)   (tested = has non-empty reasoning)
  if supported >= 1 AND tested === total → 'high'    (a cause found, all checked)
  if supported >= 1                      → 'medium'  (a cause found, some skipped)
  else                                   → 'low'     (no cause supported)
```

`hypothesesTested` is itself two `filter`/`length` counts: `tested` = hypotheses with non-empty `reasoning`, `total` = all hypotheses. "Tested" means the agent actually reasoned about it; an untested hypothesis is one the agent ran out of budget (tool calls / rate limit) to investigate.

### (d) impact shape normalization — union narrowing

`EstimatedImpact` is `string | { range: string; rangeUsd?; assumption: string }` — a legacy string or a rich object. `impactRange` and `impactAssumption` collapse the union to a stable display shape so callers never branch on the type:

```
  impactRange(e):       typeof e === 'string' ? e : e.range
  impactAssumption(e):  typeof e === 'string' ? null : (e.assumption?.trim() || null)
```

A bare string has no assumption → `null`. A rich object's assumption is trimmed and, if empty after trimming, also `null`. Callers (the recommendation card, the markdown export) call `impactRange`/`impactAssumption` and render uniformly regardless of which arm of the union they got.

**Move 3 — the principle.** Anything that is a pure function of data you already have is a *derivation*, not a *fetch*. Compute it at the presentation boundary with a scan, a fold, or a `typeof`. The agent's job is to gather evidence; the derivation layer's job is to project that evidence into whatever the UI needs — at zero I/O cost and full determinism.

---

## Enrichment derivation — diagram

Every derivation in this module, with its input, its operation, and its output.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  INPUT (agent-produced)         OPERATION                  OUTPUT          │
│                                                                            │
│  Anomaly.evidence[]                                                        │
│    [{result:{current,prior}}…] ──linear scan, find-first──▶ {current,prior}│
│                                  (findCurrentPrior)           or null      │
│         │                                                                  │
│         ▼ + metric matches REVENUE_RE + direction 'down'                  │
│      deriveInsightFields ─────────────────────────────────▶ revenueImpact  │
│                                  Math.round(current-prior)   {lostUsd,      │
│                                                               expectedUsd}  │
│                                                                            │
│  Insight.funnel                                                            │
│    {view,cart,checkout,purchase} ──map to {k,v}──▶ stages[]                │
│         │                                                                  │
│         ▼ reduce((a,b)=> b.v<a.v ? b : a).k   (argmin, min-by-key)        │
│      leakKey ─────────────────────────────────────────────▶ "checkout"    │
│                                                                            │
│  Diagnosis.hypothesesConsidered[]                                          │
│    [{supported, reasoning}…] ──filter+length counts──▶ supported, tested  │
│         │                       (hypothesesTested)            total        │
│         ▼ threshold bucket (diagnosisConfidence)                          │
│      'high' | 'medium' | 'low' ───────────────────────────▶ confidence    │
│                                                                            │
│  EstimatedImpact                                                           │
│    string | {range, assumption} ──typeof narrow──▶ range, assumption|null  │
│                                  (impactRange/impactAssumption)            │
└──────────────────────────────────────────────────────────────────────────┘
```

The diagram stands alone: four inputs, four pure operations (scan, argmin-reduce, count-and-bucket, union-narrow), four display outputs. No arrow leaves the box to a network or a store — every operation reads only its input argument.

---

## Implementation in codebase

**File:** `lib/insights/derive.ts`
**Function / class:** the whole module — `impactRange`, `impactAssumption`, `findCurrentPrior`, `deriveInsightFields`, `hypothesesTested`, `diagnosisConfidence`
**Line range:** L1–L63

- **`impactRange` / `impactAssumption`** — union normalization, L4–L6 and L7–L9.
- **`findCurrentPrior`** — find-first linear scan, L12–L20.
- **`REVENUE_RE`** — the revenue metric matcher, L22.
- **`deriveInsightFields`** — the only field this codebase derives today (`revenueImpact`), L27–L39; the revenue guard at L30, the rounding at L33–L34.
- **`hypothesesTested`** — two filter/length counts, L42–L48.
- **`diagnosisConfidence`** — prefer-agent-then-bucket, L54–L62; agent-wins short-circuit L55, the three thresholds L60–L62.

**File:** `components/feed/InsightCard.tsx`
**Function / class:** `InsightCard` — the impact tiles and the funnel-leak chip
**Line range:** L132–L161

- **`revenueImpact` tile** — consumes the derived field, L133–L139.
- **funnel projection + leak reduce** — L155–L161 (`funnelStages` map L156–L158, `leakKey` argmin L159–L161).
- **leak chip render** — `▼ leak at {leakKey}` at L314; per-stage highlight `isLeak = s.k === leakKey` at L318.

**Where the derivations are consumed (grepped):**

- `lib/state/insights.ts` L25 — `...deriveInsightFields(a)` spreads the derived fields onto each insight as it is built.
- `components/investigation/EvidencePanel.tsx` L69–L70 — `diagnosisConfidence(diagnosis)` and `hypothesesTested(diagnosis)`.
- `lib/agents/diagnostic.ts` L80 — `diagnosisConfidence(diag)` (the agent labels its own diagnosis with the same bucketing the UI uses).
- `components/investigation/RecommendationCard.tsx` L69–L70 — `impactRange` / `impactAssumption`.
- `lib/export/investigationMarkdown.ts` L57 — `impactRange(r.estimatedImpact)` in the export.

**GitHub links:**
- `lib/insights/derive.ts`: https://github.com/rlynjb/blooming_insights/blob/main/lib/insights/derive.ts
- `findCurrentPrior` (L12–L20): https://github.com/rlynjb/blooming_insights/blob/main/lib/insights/derive.ts#L12-L20
- `diagnosisConfidence` (L54–L62): https://github.com/rlynjb/blooming_insights/blob/main/lib/insights/derive.ts#L54-L62
- funnel leak reduce (`InsightCard.tsx` L155–L161): https://github.com/rlynjb/blooming_insights/blob/main/components/feed/InsightCard.tsx#L155-L161

---

## Step-by-step execution traces

### Trace 1 — the funnel leak `reduce` (argmin / min-by-key)

Input funnel (signed % change vs prior): `{ view: -2, cart: -5, checkout: -31, purchase: -12 }`.

**Step 0 — projection (L156–L158).** Map the four fixed keys into `{k, v}` pairs:
```
funnelStages = [
  { k: 'view',     v: -2  },
  { k: 'cart',     v: -5  },
  { k: 'checkout', v: -31 },
  { k: 'purchase', v: -12 },
]
funnelStages.length = 4  → guard passes, reduce runs
```

**Step 1 — reduce, no seed → accumulator starts at element 0.**
```
a = { k:'view', v:-2 }            (initial accumulator = funnelStages[0])
```

**Step 2 — b = funnelStages[1] = { cart, -5 }.**
```
b.v < a.v ?  -5 < -2 ?  true   → a = { k:'cart', v:-5 }
```

**Step 3 — b = funnelStages[2] = { checkout, -31 }.**
```
b.v < a.v ?  -31 < -5 ?  true  → a = { k:'checkout', v:-31 }
```

**Step 4 — b = funnelStages[3] = { purchase, -12 }.**
```
b.v < a.v ?  -12 < -31 ?  false → a unchanged = { k:'checkout', v:-31 }
```

**Step 5 — reduce returns `a`; `.k` extracts the stage name.**
```
reduce result = { k:'checkout', v:-31 }
leakKey = 'checkout'
```

Render: `▼ leak at checkout` (L314), and the checkout tile gets `isLeak = true` → coral (L318, L335). The leak is the stage that dropped the most, i.e. the minimum signed % — `argmin` over `v`.

Edge case: if `funnel` is `undefined`, `funnelStages = []`, the `funnelStages.length` guard is falsy, `leakKey = null`, and no chip renders. Without the guard, seedless `[].reduce(...)` throws `TypeError: Reduce of empty array with no initial value`.

### Trace 2 — `diagnosisConfidence` bucketing

Input diagnosis (no agent-set `confidence`):
```
d = {
  confidence: undefined,
  hypothesesConsidered: [
    { hypothesis: 'inventory feed stale',  supported: false, reasoning: 'checked feed timestamps, fresh' },
    { hypothesis: 'checkout API latency',  supported: true,  reasoning: 'p95 latency tripled in window' },
    { hypothesis: 'payment provider down', supported: false, reasoning: '' },   // untested (no reasoning)
  ],
}
```

**Step 1 — agent-set confidence? (L55).**
```
d.confidence = undefined  → falsy → do NOT short-circuit; compute it
```

**Step 2 — gather hypotheses (L56).**
```
h = d.hypothesesConsidered  (length 3)
```

**Step 3 — empty guard (L57).**
```
h.length === 0 ?  3 === 0 ?  no → continue
```

**Step 4 — count supported (L58).**
```
supported = h.filter(x => x.supported).length
  h[0].supported = false → drop
  h[1].supported = true  → keep
  h[2].supported = false → drop
supported = 1
```

**Step 5 — `hypothesesTested(d)` (L42–L48, L59).** `tested` = hypotheses with non-empty trimmed `reasoning`:
```
h[0].reasoning = 'checked feed timestamps, fresh' → len > 0 → tested
h[1].reasoning = 'p95 latency tripled in window'  → len > 0 → tested
h[2].reasoning = ''                               → len 0   → NOT tested
tested = 2
total  = 3
```

**Step 6 — thresholds (L60–L62).**
```
supported >= 1 AND tested === total ?  1>=1 AND 2===3 ?  true AND false → no   (not 'high')
supported >= 1 ?                       1 >= 1 ? true                    → 'medium'
```

**Result: `'medium'`** — a cause was supported (checkout latency), but one hypothesis (payment provider) was never tested, so confidence is not `'high'`. The untested hypothesis is the agent running out of tool-call budget — the UI's data-quality note surfaces exactly that.

Contrast — if all three had non-empty reasoning, `tested = 3 = total`, and Step 6's first branch is `1>=1 AND 3===3 → true` → **`'high'`**. If `supported = 0` (no hypothesis confirmed), Step 6 falls through both branches → **`'low'`**.

---

## Elaborate

**Where it comes from.** Derived/computed fields are a foundational data-modeling idea: a *computed property* (a SQL generated column, a spreadsheet formula cell, a Vue `computed`, a React `useMemo`) is a value defined as a pure function of stored values rather than stored itself. The trade is compute-on-read vs. store-and-sync; for cheap functions over small data, compute-on-read wins because it can never go stale relative to its inputs. `derive.ts` is compute-on-read at the presentation boundary.

`argmin` (min-by-key reduce) is the array-fold form of "select the row with the minimum of column X." SQL writes it `ORDER BY v LIMIT 1` or a window function; pandas writes it `df.loc[df.v.idxmin()]`; JavaScript writes it `arr.reduce((a,b)=> b.v<a.v ? b : a)`. All three return the *record*, not just the minimum value.

**The deeper principle.**

```
┌────────────────────────────────────────────────────────────────┐
│  Is this value a function of data I already hold?               │
│                                                                 │
│   yes ──▶ DERIVE it (pure fn, O(n) scan/fold, no I/O)           │
│           never stale relative to inputs; free to add fields    │
│                                                                 │
│   no  ──▶ FETCH it (round-trip, schema change, can go stale)    │
│           needed only when the data isn't already present       │
└────────────────────────────────────────────────────────────────┘
```

`revenueImpact`, `leakKey`, `diagnosisConfidence`, `impactRange` are all on the "yes" branch — every input is already in the `Insight`/`Diagnosis`/`Anomaly` the agent emitted. Putting them on the "no" branch (asking the agent for them) would add prompt surface and a chance for the LLM to compute them inconsistently.

**Where it breaks down.**

1. **`findCurrentPrior` takes the first matching pair, not the relevant one.** If an anomaly's evidence has two tool results each carrying `{current, prior}` (say a revenue query and a sessions query), it returns whichever comes first in the array — not necessarily the revenue one. `deriveInsightFields` then gates on `REVENUE_RE.test(anomaly.metric)`, so a non-revenue first pair would still be labeled revenue if the *metric name* matches. The coupling is metric-name-to-first-pair, which assumes the first numeric pair belongs to the headline metric.

2. **The leak reduce ties on first-min.** If two stages share the same minimum `v` (e.g. cart and checkout both `-31`), `b.v < a.v` is strict `<`, so the *earlier* stage wins the tie (the accumulator is not replaced on equality). For "which stage to highlight" this is a defensible deterministic choice, but it is a choice, not a guarantee that the true bottleneck is highlighted.

3. **Confidence bucketing trusts `reasoning` length as a proxy for "tested."** A hypothesis with a one-word non-empty `reasoning` counts as tested; a thoroughly-investigated hypothesis the agent recorded with empty reasoning counts as untested. The proxy (non-empty string) is coarse.

**What to explore next.**
- `Array.prototype.find` — the stdlib form of `findCurrentPrior`; the hand-written loop is only for visible type narrowing.
- `d3.min` / `d3.least` — `least(arr, accessor)` is `argmin` as a named utility; `min` returns the value, `least` returns the element.
- Memoized selectors (Reselect, `useMemo`) — if any derivation became expensive or ran on every render, wrap it so it recomputes only when its input changes. At this n it is unnecessary.

---

## Interview defense

### What they are really asking

"Why compute these in the component instead of having the API return them?" is asking whether you know the difference between a derived field and a fetched field, whether you can write `argmin` correctly (and guard the empty array), and whether you understand that LLM-emitted arithmetic is less trustworthy than code arithmetic.

### Q + A

**[mid] How do you find which funnel stage is leaking?**

Project the funnel object into `{k, v}` pairs, then `reduce` to the pair with the minimum `v` and take its `.k`. It is `argmin` — I want the stage *name*, not the minimum number, so `Math.min` is the wrong tool. I guard `funnelStages.length` first because a seedless `reduce` on an empty array throws.

```
  [{view,-2},{cart,-5},{checkout,-31},{purchase,-12}]
   reduce min-by-v → {checkout,-31} → .k → "checkout"
```

**[senior] Why derive `revenueImpact` in code instead of asking the agent for it?**

Three reasons. Determinism: `Math.round(current - prior)` is exact; an LLM doing the subtraction can be off. Cost: a derived field is free — no extra prompt round-trip or schema change. Decoupling: the agent emits raw evidence once, and the presentation layer computes whatever it needs from it, so adding a display field never re-prompts the agent. The data is already in the evidence array — `findCurrentPrior` just scans for it.

```
  agent → raw evidence {current, prior}  (once)
  derive → revenueImpact = round(current-prior)  (free, exact, on read)
```

**[arch] What happens if an anomaly's evidence has two `{current, prior}` pairs?**

`findCurrentPrior` returns the first one in array order, not necessarily the headline metric's. `deriveInsightFields` then gates on the *metric name* matching `REVENUE_RE` and direction `down`. So the coupling is "first numeric pair belongs to the headline metric" — true for the current single-metric anomalies, but it would mislabel if an anomaly carried a revenue query and a sessions query and the sessions pair came first. The fix is to key the scan on the evidence entry whose tool matches the metric, not blind first-match.

```
  evidence: [ sessions{cur,prior}, revenue{cur,prior} ]
  findCurrentPrior → sessions pair (first)   ← would be mislabeled revenue
```

### The dodge

**"Isn't a `for` loop with `typeof` checks just a worse `Array.find`?"**

Honest answer: yes, behaviorally it is `evidence.find(e => typeof e.result?.current === 'number' && typeof e.result?.prior === 'number')` then a cast. The loop exists so the `typeof` narrowing produces a typed `{current: number, prior: number}` return without a cast or a non-null assertion — TypeScript narrows cleanly inside the explicit `if`. With `find` I would still need to re-narrow the returned element. The loop trades two lines for no `as`/`!`. For a hot path I would not write it differently; for a cold path it is a readability call.

### Anchors

- `lib/insights/derive.ts` L12–L20 — `findCurrentPrior`, the find-first scan
- `components/feed/InsightCard.tsx` L159–L161 — the leak `argmin` reduce
- `lib/insights/derive.ts` L54–L62 — `diagnosisConfidence` threshold ladder
- `lib/insights/derive.ts` L42–L48 — `hypothesesTested` (the "tested" proxy)
- `lib/insights/derive.ts` L4–L9 — `impactRange`/`impactAssumption` union narrowing

---

## Validate your understanding

### Level 1 — reconstruct

Without looking, write the funnel-leak one-liner: project `{view,cart,checkout,purchase}` into `{k,v}` pairs and `reduce` to the min-by-`v` stage name. Then write the `diagnosisConfidence` threshold ladder (the four return cases in order). Why does each need a guard before it (empty `funnelStages`; empty `hypothesesConsidered`)?

### Level 2 — explain

Open `lib/insights/derive.ts`. Explain why `deriveInsightFields` returns `Partial<Insight>` (only the fields it can compute) rather than a full object. What does the UI do when a field is absent, and why is "return only what you can compute" the right contract for a derivation layer?

### Level 3 — apply

Scenario: a funnel arrives as `{ view: -8, cart: -8, checkout: -3, purchase: -1 }` — view and cart tie at the minimum `-8`. Trace `funnelStages.reduce((a,b)=> b.v<a.v ? b : a)` step by step and state which stage `leakKey` ends up as and why (strict `<` vs `<=`). Cite `components/feed/InsightCard.tsx` L159–L161. Then state what renders at L314.

### Level 4 — defend

A reviewer says: "Move `diagnosisConfidence` into the agent prompt — let the model decide high/medium/low." Defend computing it in `derive.ts` instead. Address determinism, testability, and the fact that the agent's own `confidence` *is* preferred when set (cite `lib/insights/derive.ts` L55). State without hedging when you would let the agent decide and when you would compute it.

### Quick check

- What does `findCurrentPrior` return when no evidence entry has both numeric `current` and `prior`? (`null` — `lib/insights/derive.ts` L19.)
- What is the time complexity of the funnel-leak reduce? (O(n) over funnel stages; here n = 4 → effectively O(1).)
- What does `diagnosisConfidence` return for a diagnosis with one supported hypothesis but one untested one? (`'medium'` — supported ≥ 1 but `tested !== total`; L60–L61.)
- What does `impactAssumption` return for the bare-string arm of `EstimatedImpact`? (`null` — `derive.ts` L8.)
- Where is `deriveInsightFields` actually called, and is it per-render or once? (`lib/state/insights.ts` L25 — once, at insight-build time.)

## See also

→ 05-severity-sort.md · → 04-json-from-prose.md · → ../01-system-design/01-request-flow.md

---
Updated: 2026-05-29 — funnel-leak reduce refreshed to current lines (block L155–L161, `funnelStages` map L156–L158, `leakKey` argmin L159–L161); verified `anomalyToInsight` copies `category` at `lib/state/insights.ts` L25 and `derive.ts` refs unchanged.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
