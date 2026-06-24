# Insight ↔ Anomaly silent leak — RESOLVED 2026-06-15

**Industry name(s):** Information leakage · same-knowledge-in-two-places · change amplification · silent field-drop
**Type:** Industry standard · Language-agnostic (historic leak, now resolved — kept as worked example)

> **STATUS: RESOLVED.** The surface fix proposed below has landed. `insightToAnomaly` now lives at `lib/state/insights.ts:53-55`, colocated with its inverse `anomalyToInsight`. The route handler imports it via `import { ..., insightToAnomaly } from '@/lib/state/insights'`. A round-trip test was added at `test/state/insights.test.ts`. Crucially, **the fix wasn't to copy the dropped fields** — it was to mark the drop as intentional with a load-bearing comment (`lib/state/insights.ts:47-52`: "Reverse mapper. Intentionally drops evidence/impact/history/category — the agent loop only needs metric/scope/change/severity to investigate; the rest is regenerated downstream."). The "deeper fix" — change the wire format so the route accepts only `insightId` — was deliberately not done; the cheap fix retired the leak. The verdict — "the worst information leak in the codebase" — was true on 2026-06-02 and is preserved below as a worked example of the colocate-then-comment-then-test fix. The lesson is the *move*: a comment can carry intent TypeScript can't.

> **Original verdict (historical).** The fields that crossed between an `Anomaly` (what the monitoring agent emits) and an `Insight` (what the feed renders) were encoded in three places: the type interfaces in `lib/mcp/types.ts`, the `anomalyToInsight` mapping in `lib/state/insights.ts` (copied 8 fields), and the `insightToAnomaly` mapping in `app/api/agent/route.ts:29-31` (copied 4 of those 8 and silently dropped `evidence`, `impact`, `history`, `category`). Adding a new field to `Anomaly` meant TypeScript caught case (1) but not cases (2) or (3) — the round-trip silently lost data. This was the worst information leak in the codebase. **The fix below is now what the code looks like (surface fix only — the wire format remains unchanged).**

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three modules know the Anomaly/Insight field list — one by necessity (the type interface), two by accident (the two converters living in different files). Trace knowledge ownership down the stack: `lib/mcp/types.ts` is the truth source; the state module owns the canonical mapping (`anomalyToInsight`); the route handler owns the inverse for one specific use case (the browser passes `?insight=<json>` to `/api/agent`, the route has to turn it back into an `Anomaly` for the agent). The route's inverse is the leak — it lives next to the route's other concerns, not next to its inverse.

```
Zoom out — where the field list is encoded

┌─ UI layer ─────────────────────────────────────────────────────┐
│  app/page.tsx · holds Insight[] in component state              │
│              · passes ?insight=<JSON> on click → /api/agent     │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTP query param (the wire format)
┌─ Route handler ──────────▼─────────────────────────────────────┐
│  app/api/agent/route.ts L29–L31                                 │
│  function insightToAnomaly(i: Insight): Anomaly                 │  ← LEAK #1 (copy of field list)
│    copies 4 fields, drops 4 silently                            │
└──────────────────────────┬─────────────────────────────────────┘
                           │ runs runAgentLoop with the rebuilt Anomaly
┌─ Agent layer ────────────▼─────────────────────────────────────┐
│  diagnostic + recommendation agents work on Anomaly             │
└──────────────────────────┬─────────────────────────────────────┘
                           │ scan() returns Anomaly[]
┌─ State module ───────────▼─────────────────────────────────────┐
│  lib/state/insights.ts L8–L28                                   │
│  function anomalyToInsight(a: Anomaly): Insight                 │  ← canonical mapping (lives here)
│    copies 8 fields, derives 5 more                              │
└──────────────────────────┬─────────────────────────────────────┘
                           │ types
┌─ Type definitions ───────▼─────────────────────────────────────┐
│  lib/mcp/types.ts                                               │
│  interface Anomaly  { metric, scope, change, severity,          │  ← TRUTH SOURCE
│                       evidence, impact?, history?, category? }  │
│  interface Insight  { id, timestamp, severity, headline, ... }  │
└─────────────────────────────────────────────────────────────────┘

  three files know the field list; only ONE is enforced by the compiler.
```

**Zoom in — narrow to the concept.** The pattern is the failure of the hiding test: search the codebase for the secret you think is hidden, and count occurrences. A real hide returns one file; a leak returns two or more. Here the "secret" — what fields cross between Anomaly and Insight — lives in three places. The fix is mechanical: colocate both mappings in the state module so they share one diff. The deeper fix is to change the wire format so the leak retires entirely (the route accepts an insight id and looks up the cached anomaly server-side — no conversion needed).

---

## Structure pass

**Layers.** Three for this concept: the **type layer** (`lib/mcp/types.ts` — the interface contracts), the **mapping layer** (the two converter functions), and the **wire layer** (the `?insight=<JSON>` query param that forces the existence of the inverse). The leak crosses all three.

**Axis: knowledge ownership.** For each field that has to cross the Anomaly/Insight boundary, which module owns the decision "this field copies forward, this one derives, this one is dropped"? In a healthy codebase, that decision lives in one place — typically next to the type definition or in a single mapping module. Here it lives in three: the type interfaces declare the field exists; the state module's `anomalyToInsight` copies most of them; the route module's `insightToAnomaly` copies a subset and silently drops the rest.

**Seams.** The load-bearing seam is **route ↔ state ↔ types** — three files that have to agree on a field list TypeScript can't force them to agree on. The compiler enforces (1) the interface itself; it does NOT enforce that two functions copy the same subset, because both functions are valid TypeScript regardless of which fields they touch. That gap between "valid type" and "consistent behavior" is where the leak hides.

```
Structure pass — the three-file leak

┌─ 1. LAYERS ──────────────────────────────────────────────┐
│  Types · Mappings · Wire format                            │
└─────────────────────────────┬────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  knowledge ownership: which file decides "this field      │
│  crosses the Anomaly↔Insight boundary"?                    │
│  hidden = 1 owner; leaked = ≥2 owners                     │
└─────────────────────────────┬────────────────────────────┘
                              │  count owners
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  S1: types.ts          owns the interfaces (compiler-enforced)│
│  S2: state/insights.ts  owns canonical anomaly→insight (8) │
│  S3: api/agent/route.ts owns inverse insight→anomaly (4)   │
│      ★ LEAK — three owners of the same knowledge          │
└─────────────────────────────┬────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the mental model (the leak picture)

You know how `JSON.stringify` and `JSON.parse` are inverses by *design* — the same module owns both, they round-trip cleanly, and a change to one is forced by the other? Now imagine the opposite shape: a third file owns `JSON.stringify`, a different file owns `JSON.parse`, and the second file's parser only handles half the fields the first file's stringifier emits. Round-tripping silently loses the unhandled fields, no error is raised, and TypeScript can't catch it because both functions are individually valid. That's the leak shape here — `anomalyToInsight` and `insightToAnomaly` live in different files, copy different subsets, and the compiler approves both.

```
Hide vs leak — the field-list version

  HIDE                                          LEAK (this case)
  ┌─ types.ts ───────────┐                      ┌─ types.ts ───────────┐
  │ interface Anomaly    │                      │ interface Anomaly    │  truth
  │ interface Insight    │                      │ interface Insight    │
  └──────────┬───────────┘                      └──────────┬───────────┘
             │                                              │
  ┌─ state/insights.ts ─▼┐                      ┌─ state/insights.ts ─▼┐
  │ toInsight(a)         │                      │ anomalyToInsight     │  copy A
  │ toAnomaly(i)         │                      │   (copies 8 fields)  │
  │ — both inverses here  │                      └─────────────────────┘
  └──────────────────────┘                              │
       one owner                                        │ different file!
                                                ┌─ api/agent/route.ts ─▼┐
                                                │ insightToAnomaly      │  copy B
                                                │   (copies 4, drops 4) │
                                                └──────────────────────┘
                                                     three owners; TS approves all
                                                     three; round-trip silently loses data
```

### Move 2 — the kernel (the field-list comparison)

Walk the comparison field by field. The truth source is the `Anomaly` interface in `lib/mcp/types.ts`:

```
Anomaly fields (the truth)        anomalyToInsight       insightToAnomaly
                                  (state, L8–L28)        (route, L29–L31)
─────────────────────────────     ─────────────────      ─────────────────
metric        : string            copy                    copy
scope         : string[]          copy                    copy
change        : { ... }           copy                    copy
severity      : 'p1'|'p2'|'p3'    copy                    copy
evidence      : Evidence[]        copy                    DROP (silent!)
impact?       : ImpactSummary     copy                    DROP (silent!)
history?      : HistoryPoint[]    copy                    DROP (silent!)
category?     : string            copy                    DROP (silent!)
                                  + 5 derived fields:
                                    id, timestamp,
                                    headline, summary,
                                    source
```

Four fields silently drop. The `insightToAnomaly` function isn't *wrong* — it produces a valid `Anomaly` (all required fields present) — but the resulting Anomaly has empty `evidence: []`, missing `impact`, missing `history`, missing `category`. If the diagnostic agent depends on any of those for its prompt or its tool-call strategy, the investigation runs with degraded context and the user never sees a warning.

### Move 2 — the failure mode

```
Pattern — the silent loss on a new field

  step 1: contributor adds a field to Anomaly
    interface Anomaly {
      ...
      affectedCustomers?: number       ← new field
    }

  step 2: TypeScript enforces (1) only
    ✓ lib/mcp/types.ts          — interface change compiles
    ✓ lib/state/insights.ts     — anomalyToInsight still type-checks
                                  (it returns Insight; if Insight didn't
                                  add the field too, it doesn't carry)
    ✓ app/api/agent/route.ts    — insightToAnomaly still type-checks
                                  (the new field is optional; valid to omit)

  step 3: runtime
    - monitoring agent emits Anomaly with affectedCustomers: 12000
    - anomalyToInsight maps it to Insight (if Insight has the field too)
    - browser passes ?insight=<JSON> to /api/agent
    - insightToAnomaly rebuilds Anomaly: affectedCustomers is dropped
    - diagnostic agent runs with affectedCustomers: undefined

  result: tests pass, types compile, data is lost.
  no compile error, no test failure, just a runtime gap.
```

### Move 2 — the fix (two altitudes)

**Surface fix — colocate the mapping.** Move `insightToAnomaly` from `app/api/agent/route.ts` into `lib/state/insights.ts` next to its inverse. Add a round-trip test asserting `toAnomaly(toInsight(a))` preserves every field. The colocation alone retires the leak because both functions now share one diff — any field-list change is one PR touching one file.

```
Surface-fix sketch

  // lib/state/insights.ts
  export function anomalyToInsight(a: Anomaly): Insight { ... }      ← existing
  export function insightToAnomaly(i: Insight): Anomaly { ... }      ← moved here

  // round-trip test (lib/state/insights.test.ts)
  test('Anomaly → Insight → Anomaly preserves every field', () => {
    const a: Anomaly = { metric, scope, change, severity,
                         evidence, impact, history, category,
                         affectedCustomers }  // new field
    expect(insightToAnomaly(anomalyToInsight(a))).toEqual(a)
  })

  // app/api/agent/route.ts
  import { insightToAnomaly } from '@/lib/state/insights'
  // function definition deletes
```

**Deeper fix — change the wire format.** The leak exists because `/api/agent` accepts the full `Insight` shape from the browser as a query param. It doesn't have to — the browser could pass just the insight id and the route could look up the cached anomaly server-side. That retires the inverse entirely.

```
Deeper-fix sketch

  // before
  fetch(`/api/agent?step=diagnose&insight=${encodeURIComponent(JSON.stringify(insight))}`)

  // after
  fetch(`/api/agent?step=diagnose&insightId=${insight.id}`)

  // server-side: look up the cached Anomaly by insight id
  const cached = getCachedAnomaly(insightId)    ← uses lib/state/insights cache
  if (!cached) return notFound()
  const anomaly = cached.anomaly                ← the original Anomaly, intact

  // insightToAnomaly DELETES — there is no round-trip anymore
```

The wire format IS the leak source. Fix the wire format and the leak goes away.

### Move 3 — the principle

The hiding test is adversarial: pick the secret you think is hidden, grep for it, count files. One = real hide. Two or three = leak. TypeScript helps with type-level secrets (interfaces, function signatures) but not with behavioral secrets (which fields a function copies). Behavioral consistency between two functions has to be enforced by either (a) colocating them so a reviewer notices the asymmetry, or (b) a test that asserts the round-trip. Lacking both, the divergence happens silently. The deeper move is to ask *why* the leak exists at all — often it's a consequence of an earlier design decision (here, the wire format) that, if reconsidered, retires the leak entirely.

---

## Primary diagram

The leak in one frame — three files, one knowledge, no compiler enforcement.

```
The Insight↔Anomaly leak — recap

  TRUTH SOURCE
  ┌─ lib/mcp/types.ts ───────────────────────────────────────┐
  │  interface Anomaly { metric, scope, change, severity,    │
  │                      evidence, impact?, history?,         │
  │                      category? }                          │
  │  interface Insight { id, timestamp, severity, headline,   │
  │                      summary, metric, change, scope,      │
  │                      source, evidence?, impact?,          │
  │                      history?, category?, ... }           │
  └─────────────────────────────────────────────────────────┘
                      ▲                       ▲
                      │ compiler enforces     │ compiler enforces
                      │ the signatures        │ the signatures
                      │                       │
  ┌─ lib/state/insights.ts ──────────────────┐ ┌─ app/api/agent/route.ts ──┐
  │  anomalyToInsight(a)                      │ │  insightToAnomaly(i)       │
  │    copies: severity, metric, change,      │ │    copies: metric, scope,  │
  │            scope, evidence, impact,       │ │            change, severity│
  │            history, category   ← 8 fields │ │    drops: evidence, impact,│
  │    derives: id, timestamp, headline,      │ │           history, category│
  │             summary, source                │ │           ← SILENT, 4 fields│
  └─────────────────────────────────────────┘ └──────────────────────────────┘
              ▲ compiler does NOT enforce that these two functions copy the
              │ same subset. both are valid TypeScript. drift is invisible.
              │
              │  flow:
              │    monitoring agent → Anomaly → anomalyToInsight → Insight
              │    browser click    → Insight  → /api/agent (query param)
              │                                  → insightToAnomaly → Anomaly'
              │                                  → diagnostic agent runs on
              │                                    Anomaly' (missing 4 fields)
```

---

## Implementation in codebase

**Use cases.** Three places this leak bites.

- **Adding `affectedCustomers` to `Anomaly`.** The contributor edits `lib/mcp/types.ts` and probably remembers to update `anomalyToInsight` (it's nearby in feel). They forget `insightToAnomaly` because it lives in a different file. The diagnostic agent's prompt template references `${anomaly.affectedCustomers}` and gets `undefined`. Tests pass. The agent's reasoning silently degrades for the round-tripped case.

- **The user investigates an insight from the feed.** Click on an insight card → `/investigate/[id]` → opens an investigation. The investigation route fetches `/api/agent?step=diagnose&insight=<JSON of full Insight>`. The route calls `insightToAnomaly` to rebuild the Anomaly for the agent. The rebuilt Anomaly has `evidence: []` even though the original Anomaly had real evidence — because `insightToAnomaly` (`app/api/agent/route.ts:30`) hardcodes `evidence: []`.

- **Refactoring the Insight type.** Someone renames `Insight.metric` to `Insight.metricName` for clarity. TypeScript flags `anomalyToInsight` (which assigns to `Insight.metric`) and `insightToAnomaly` (which reads `i.metric`). Both compile errors land, the contributor fixes both. Good — the type-level rename was caught. But that's the only case TypeScript catches.

### The canonical mapping (state module)

```
lib/state/insights.ts  (lines 8–28)

  export function anomalyToInsight(a: Anomaly): Insight {
    const id = crypto.randomUUID();                       ← derived
    const sign = a.change.direction === 'down' ? '-' : '+';
    const headline = `${a.scope.join(' ')} ${a.metric} · ${sign}${Math.abs(a.change.value)}%`...
    return {
      id,
      timestamp: new Date().toISOString(),                ← derived
      severity: a.severity,                                ← COPY
      headline,                                            ← derived
      summary: ...,                                        ← derived
      metric: a.metric,                                    ← COPY
      change: a.change,                                    ← COPY
      scope: a.scope,                                      ← COPY
      source: 'monitoring',                                ← stamped
      evidence: a.evidence,                                ← COPY
      impact: a.impact,                                    ← COPY
      history: a.history,                                  ← COPY
      category: a.category,                                ← COPY
      ...deriveInsightFields(a),                           ← enriched
    };
  }
       │
       │  fields copied verbatim:
       │    severity, metric, change, scope, evidence, impact, history, category
       │    (8 fields)
       │
       └─ this function owns the FULL field list. it is the canonical mapping.
```

### The inverse, in a different file (the leak)

```
app/api/agent/route.ts  (lines 29–31)

  function insightToAnomaly(i: Insight): Anomaly {
    return { metric: i.metric, scope: i.scope, change: i.change, severity: i.severity, evidence: [] };
  }
       │
       │  fields copied:
       │    metric, scope, change, severity  ← only 4
       │
       │  fields dropped (silently):
       │    evidence — hardcoded to [] even though Insight.evidence often has data
       │    impact   — silently omitted
       │    history  — silently omitted
       │    category — silently omitted
       │
       └─ TypeScript approves this function because every required Anomaly field
          is present. evidence is `Evidence[]` not `Evidence[] | undefined`, so
          the literal `[]` satisfies the type. the other three are optional,
          so omitting them is fine for the compiler.

          the LEAK is that this function and anomalyToInsight encode the SAME
          knowledge (what fields cross between the two types) but TypeScript
          can't force them to copy the same subset.
```

### The wire format that forces the leak's existence

```
the browser-side call (app/page.tsx and friends):

  const url = `/api/agent?step=diagnose&insight=${encodeURIComponent(JSON.stringify(insight))}`
  fetch(url)

the route side (app/api/agent/route.ts L60–L65):

  const insightParam = req.nextUrl.searchParams.get('insight')
  const insight = insightParam ? JSON.parse(insightParam) as Insight : null
  if (insight) {
    const anomaly = insightToAnomaly(insight)   ← the rebuild call
    runDiagnostic(anomaly, ...)
  }
       │
       └─ the route accepts the full Insight shape from the browser. that's
          why insightToAnomaly exists. change the wire format to accept just
          insight.id (and look up the cached anomaly server-side), and the
          inverse retires entirely.
```

---

## Elaborate

Where this pattern comes from: Ousterhout's "information leakage" is when a fact about the system is encoded in two or more modules, forcing them to change together. The classic example is a file format known by both the writer and the reader as separate definitions — drift one and the round-trip breaks. The shape here is the same; the medium is JavaScript object field lists rather than file bytes.

Adjacent concepts:
- **Pull complexity downward** — the leak persists in part because the wire format pushed the conversion responsibility up to the route. A lower-altitude design (browser sends id, server looks up anomaly) would absorb the conversion entirely.
- **Define errors out of existence** — the same instinct applies to silent data loss. The leak isn't an *error* (no exception); it's a *missed copy* the compiler can't catch. Defining it out means either making TypeScript catch it (via a shared field-list constant) or making the conversion unnecessary (the wire-format fix).
- **Hiding test** — the grep test for hides is the adversarial inverse: grep for the secret, count files. Here `grep -l "metric, scope, change, severity" lib/ app/` returns three matches. That's the audit, mechanized.

A subtle point worth naming: the leak's *behavioral* cost depends on whether downstream code reads the dropped fields. Today, the diagnostic and recommendation agents *don't* heavily use `evidence`, `impact`, `history`, or `category` from the input Anomaly — they regenerate evidence via tool calls. So the leak is currently low-impact. The danger is that a future agent does read those fields, and the breakage is silent rather than loud. Audit findings don't have to be currently-biting; they have to be currently-fragile.

What to read next: the `read-aposd` chapter on information hiding (when present) carries the conceptual treatment. The `01-mcp-client-deep-module.md` file in this guide is the contrast — the strongest hide in the codebase (`parseRetryAfterMs`) is what passes the grep test that this leak fails.

A non-finding worth naming as praise: `parseRetryAfterMs` (now at `lib/data-source/bloomreach-data-source.ts:57-74`) is the strongest hide in the repo precisely because no other file knows the Bloomreach error grammar. The same grep test applied there returns one file. That's what hiding looks like. After the colocation + comment fix, the Anomaly/Insight field list now also passes the test (one file owns the mapping, with the intentional-drop comment carrying the contract).

**Post-fix lesson worth carrying forward.** The grep test was sharp, but it wasn't the whole picture. The leak existed because two converter functions encoded the same knowledge in different files. The fix could have been: (a) make both copy the same fields (rewrites the converters), (b) eliminate one by changing the wire format (rewrites the route + the browser), or (c) colocate the two and use a comment to declare the asymmetry intentional. Option (c) won because the dropped fields *are* intentional — the diagnostic agent regenerates evidence via tool calls and doesn't need the input Anomaly's evidence. The leak wasn't in the *behavior*; it was in the *invisible intent*. A comment can fix that, where TypeScript can't. The lesson generalizes: when two functions diverge by design, name the design in a comment; the leak isn't the asymmetry, it's the silent asymmetry.

## Interview defense

**Q: What's the test for whether something is "hidden" in a codebase, and where does this codebase fail it?**
A: Pick the secret you think is hidden, grep for it, count files. One file = real hide; two or more = leak. The strongest hide here is the Bloomreach retry-after grammar in `lib/mcp/client.ts:31-38` — grep for `/retry-after/` and exactly one file matches. The worst leak is the Anomaly/Insight field list: grep for the field combination `metric, scope, change, severity` and three files match (`types.ts`, `state/insights.ts:8-28`, `api/agent/route.ts:29-31`). The first encodes the truth (the interface); the second is the canonical mapping (8 fields copied); the third is an inverse (4 fields copied, 4 silently dropped). TypeScript can't enforce that two functions copy the same subset of fields — both are valid types regardless of which fields they touch. So the divergence is invisible to the compiler and survives every PR until something at runtime depends on a dropped field.

**Q: Walk me through the fix at two altitudes.**
A: Surface fix is mechanical: move `insightToAnomaly` from `app/api/agent/route.ts` into `lib/state/insights.ts` next to `anomalyToInsight`, write the round-trip test that asserts `toAnomaly(toInsight(a))` preserves every field. The colocation alone retires the leak because both functions now share one diff. Deeper fix is to ask why the inverse exists at all — the answer is "the browser passes the full Insight shape as a query param to `/api/agent`." That wire format IS the leak source. Change the wire format so the browser passes just `insightId`, the route looks up the cached anomaly server-side, and `insightToAnomaly` deletes entirely. The round-trip stops being a round-trip — the original Anomaly never had to be rebuilt.

```
Interview-defense diagram — surface fix vs deeper fix

  SURFACE FIX (mechanical, ~30 mins)
  ┌─ lib/state/insights.ts ───────────────────┐
  │  anomalyToInsight (existing)              │
  │  insightToAnomaly (moved from route)      │
  │  + round-trip test (preserves every field)│
  └───────────────────────────────────────────┘
  ┌─ app/api/agent/route.ts ──────────────────┐
  │  import { insightToAnomaly } from ...     │  ← function def deleted
  └───────────────────────────────────────────┘
  → leak narrows from 3 owners to 2; behavior protected by test

  DEEPER FIX (wire-format change, ~1 hour)
  ┌─ browser ─────────────────────────────────┐
  │  fetch(`/api/agent?step=diagnose&         │
  │         insightId=${insight.id}`)         │  ← just the id
  └───────────────────────────────────────────┘
  ┌─ app/api/agent/route.ts ──────────────────┐
  │  const cached = getCachedAnomaly(id)      │
  │  if (!cached) return notFound()           │
  │  runDiagnostic(cached.anomaly)            │  ← no rebuild
  └───────────────────────────────────────────┘
  → leak retires entirely (insightToAnomaly deletes)
```

## See also

- `audit.md` — the information-hiding-and-leakage lens records the resolution and names new hides added by Phase 2 (`makeDataSource` factory, domain-tool surface in `mcp-server-olist/`).
- `01-mcp-client-deep-module.md` — the strongest hide in the codebase (`parseRetryAfterMs`); now passes the same test this fix introduced via comment.
- `04-synthesize-recovery-duplication.md` — RESOLVED, same fix shape (same logic in two places, lifted to one owner).

---
