# 03 — type guard as runtime validator

*Industry term:* **type guard** (TypeScript), one form of **runtime
validation** — Language-agnostic

## Zoom out, then zoom in

You've written `if (data && typeof data.id === 'string') { ... }` in
a fetch handler. Same shape — except the result narrows the type so
the rest of the function can treat `data` as a typed object instead of
`unknown`. The repo uses this at the agent ↔ JSON boundary, where the
LLM hands back text and the route needs to know if it's a valid
`Anomaly[]` before doing anything with it.

```
  Zoom out — where this layer lives

  ┌─ Agents (lib/agents) ────────────────────────────────────┐
  │  runAgentLoop returns finalText: string                   │
  │             │                                              │
  │             ▼                                              │
  │  parseAgentJson(finalText) → unknown                       │
  │             │                                              │
  │             ▼                                              │
  │  ★ THIS LAYER ★  isAnomalyArray / isDiagnosis /            │ ← we are here
  │                  isRecommendationArray                     │
  │             │                                              │
  │             ▼                                              │
  │  if (true)  → typed Anomaly[] / Diagnosis / Rec[]          │
  │  if (false) → fallback / [] / log + drop                   │
  └────────────────────────────────────────────────────────────┘
                │
  ┌─ State / UI ────────────────────────────────────────────┐
  │  putInsights(sid, insights, anomalies)                    │
  │  emit('insight', insight) ─► NDJSON to the UI            │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** TypeScript's static type system stops at the program
boundary. The compiler can't know what an LLM will hand back, or what
shape a captured demo snapshot has after a year on disk. **Type guards**
re-cross that boundary in the *other* direction: at runtime, examine
the value, decide if it matches the type, and return a `value is T`
predicate that narrows the static type for the rest of the function.
This repo uses three of them, all in
`lib/mcp/validate.ts`, for the three agent outputs that have a shape
the UI cares about.

## Structure pass

**Layers — three altitudes the value travels through:**
- outer: untyped/external — the LLM's text answer (a `string`)
- middle: parsed but untyped — `parseAgentJson(text)` returns `unknown`
- inner: typed — after `isAnomalyArray(parsed)` returns `true`, the
  rest of the function treats it as `Anomaly[]`

**One axis held constant — *what does TypeScript know about this
value?***
- outer: it's a `string`. TS knows nothing about the structure.
- middle: it's `unknown`. TS refuses to let you access any property —
  you can't even index it without an assertion.
- inner: it's `Anomaly[]`. Full autocomplete, full type checking
  downstream.

**The seam — where the axis flips:** at the type-guard call. Below
that line, `parsed.metric` is a compile error. Above it,
`parsed[0].metric` is a typed `string`. The flip happens with no cast,
no `as`, no `any` — just a function returning `value is T`.

## How it works

### Move 1 — the mental model

A **type guard** is a function whose return type is a TypeScript
*predicate*: `function isFoo(v: unknown): v is Foo`. When it returns
`true`, the compiler narrows `v` to `Foo` for the rest of the
enclosing scope. When it returns `false`, you handle the bad case.
The function body itself does whatever runtime checks you want —
`typeof`, `Array.isArray`, `instanceof`, a JSON Schema validator, a
zod schema. The point is that the return type *informs the type
system* about what the runtime check proved.

```
  The type-narrowing kernel

  parsed: unknown
       │
       ▼
   isAnomalyArray(parsed)?       ← runtime check
       │
       ├─ true  ──►  parsed: Anomaly[]      ← TS narrows here
       │            (use it: parsed[0].severity, etc.)
       │
       └─ false ──►  parsed: unknown        ← still unknown
                    (the else branch handles it: fallback / drop / log)
```

The two parts of the skeleton: (1) the runtime predicate body — what
do you actually check? — and (2) the `value is T` return type — what
do you promise the compiler if the check passed? Drop either and the
move falls apart. A predicate body without the `is` annotation just
returns `boolean` and doesn't narrow the type. An `is` annotation
with no real check is a lie that the compiler can't catch.

### Move 2 — the step-by-step walkthrough

**The check body — what counts as valid?** From
`lib/mcp/validate.ts:17-27`:

```typescript
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
```

Read it top-down: it's an `Array.isArray` gate, then for every
element, walk the required fields and check shape + value (severity
must be one of the four known strings, direction must be `up` or
`down`). The `as any` casts inside the predicate body are
deliberate — *inside* the guard you have to lie to the compiler about
`v`'s shape to access fields; the `is` return type then re-establishes
the truth at the call site.

**The reject cases — what does the guard *not* let through?**
`test/mcp/validate.test.ts:22-30` walks them:

```
  Reject cases that earn the guard its keep

  guard input                                        result
  ───────────────────────────────────────────        ────────
  []                                                 true  (empty array OK)
  [{ metric: 'conversion_rate', ..., severity:      true  (well-formed)
    'warning', change: { value: -18, direction:
    'down', baseline: '7d' }, evidence: [] }]
  {}                              (not an array)     false
  [{ metric: 'x' }]              (missing fields)    false
  [{ ...good, severity: 'huge' }] (bad severity)     false
  [{ ...good, change: {                              false
    ..., direction: 'sideways' } }]  (bad enum)
```

The test pins the bad cases explicitly — the guard isn't trusted by
inspection, it's trusted by what it rejects. That's the difference
between "I think this is safe" and "the suite proves these specific
attacks fail." 25 tests across the three guards
(`test/mcp/validate.test.ts` — `parseAgentJson` 5, `isAnomalyArray` 6,
`isDiagnosis` 6, `isRecommendationArray` 8).

**Use it.** From `lib/agents/monitoring-legacy.ts` (paraphrased — the
real call site):

```typescript
const result = await runAgentLoop({ anthropic, dataSource, ... });
const parsed = parseAgentJson(result.finalText);
//     ^^^^^^ : unknown                                  ← TS knows nothing
if (!isAnomalyArray(parsed)) {
  return [];                                             // ← graceful empty
}
// from here on, `parsed` is Anomaly[]
return parsed.slice(0, 10).sort(...);
//     ^^^^^^ : Anomaly[]                                ← TS knows everything
```

The two `return` branches are the whole shape: validated → use it;
not validated → return a safe empty value. No throw, no crash, no
poisoned UI. The "graceful empty" branch is what makes the
monitoring agent robust to a model that returns prose instead of
JSON (`test/agents/monitoring.test.ts:284-300, 302-315`).

**Layers-and-hops — the validation hop in the bigger flow:**

```
  Where the guard sits in the briefing flow — labelled hops

  ┌─ Bloomreach ─┐  hop 1: tool result        ┌─ runAgentLoop ──┐
  │   MCP server │ ─────────────────────────► │  base-legacy    │
  └──────────────┘                            └────────┬────────┘
                                                       │
                       hop 2: messages.create          │
                                                       ▼
                                              ┌─ Anthropic SDK ─┐
                                              │  Claude Sonnet  │
                                              └────────┬────────┘
                                                       │
                       hop 3: finalText (string)       │
                                                       ▼
                                              ┌─ parseAgentJson ┐
                                              │  fence + scan   │
                                              └────────┬────────┘
                                                       │
                       hop 4: parsed (unknown)         │
                                                       ▼
                                              ┌─ isAnomalyArray ┐ ← guard hop
                                              │  predicate body │
                                              └────────┬────────┘
                                                       │
                          ┌────────────────────────────┴───────────┐
                          │                                        │
                          ▼ true                                   ▼ false
                  parsed: Anomaly[]                        return []  (safe)
                          │
                          ▼ hop 5: putInsights / NDJSON emit
                  ┌─ UI / state ─────┐
                  │  insight cards   │
                  └──────────────────┘
```

The guard is the one hop on this path where untrusted data becomes
typed data. Every hop downstream from there can assume the shape.
Every hop upstream can produce whatever it wants.

**The fallback shape matters too.** `isDiagnosis` returns false →
DiagnosticAgent returns `{ conclusion: 'Insufficient data...',
evidence: [], hypothesesConsidered: [] }` — a real `Diagnosis`, not
`null`. The UI never has to handle a missing diagnosis case because
*the agent always produces one*. The validation defines what counts
as "real"; the agent's fallback closes the loop so downstream code
doesn't fork.

### Move 3 — the principle

**Re-cross the type boundary at every input source.** TypeScript is
sound only as deep as its inputs — the compiler trusts `JSON.parse`'s
`any` return, trusts `Response.json()`'s `any` return, and trusts
anything you `as`-cast. Type guards convert those untrusted boundaries
back into trusted ones, with the proof being a runtime check the test
suite can interrogate. The smaller the untyped surface inside your
code, the less the static type system is lying to you.

## Primary diagram

```
  The full pattern — three-stage funnel from text to typed value

  ┌─ Agent loop output ──────────────────────────────────────────────────┐
  │  finalText: string  =  "```json\n[{\"metric\":\"x\",...}]\n```"      │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 ▼  parseAgentJson — strip fence + scan
  ┌─ Parsed JSON (untrusted) ────────────────────────────────────────────┐
  │  parsed: unknown                                                      │
  │                                                                       │
  │  TS WON'T let you do parsed[0].metric                                 │
  │  TS WON'T let you do (parsed as any[]).length                         │
  │  the type literally has no methods or properties                     │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 ▼  isAnomalyArray — runtime predicate
                          ┌──────┴───────┐
                          │              │
                          ▼ true         ▼ false
  ┌─ Typed value ──────────────┐  ┌─ Safe fallback ───────────────────┐
  │  parsed: Anomaly[]          │  │  return [] (briefing has 0 cards) │
  │                             │  │  return FALLBACK (diagnostic)     │
  │  parsed[0].severity is one  │  │  return [] (recommendation)       │
  │  of 'critical' | 'warning'  │  │                                   │
  │  | 'info' | 'positive'      │  │  → UI never crashes, never sees   │
  │                             │  │    a half-parsed shape            │
  │  parsed[0].change.direction │  └───────────────────────────────────┘
  │  is 'up' | 'down'           │
  │                             │
  │  → ready to .slice, .sort,  │
  │    emit, render             │
  └─────────────────────────────┘
```

## Elaborate

The TypeScript-specific magic is the `value is T` syntax —
[user-defined type guards](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates),
introduced in TS 1.6. Other languages have analogues:
Rust's `match` + pattern destructuring,
Python's `TypeGuard` (PEP 647), Scala's pattern matching with sealed
traits. The shape generalizes: at any boundary where untyped data
arrives, run a check that the static type system can lift into a
narrowing.

The alternative is what this repo *didn't* reach for: a runtime
schema library (`zod`, `valibot`, `io-ts`, `ajv`). They give you a
single source of truth (define the schema once, get the static type
and the runtime check together) at the cost of an extra dependency
and a small bundle hit. For three shapes with stable fields, a
hand-rolled guard is a defensible call — and the 25 tests across the
three guards prove the cases. If the shape count grew to ten or
started changing every sprint, the calculus would flip toward `zod`.

The `as any` casts inside the guard bodies are a known TypeScript
limitation: inside a predicate you're examining an `unknown`, but
checking `typeof (v as { metric: unknown }).metric === 'string'` is
even noisier than `(v as any).metric`. The trade-off is contained to
*inside* the guard; the `is` annotation re-establishes safety the
moment the function returns.

The split between `parseAgentJson` (text → `unknown`) and the guards
(`unknown` → typed) is itself the right decomposition. The parser
handles fence stripping + substring scanning + `JSON.parse`; the
guards handle shape. Mixing them would have meant a 60-line monster;
splitting them gives 20 tests on parsing and 25 on validation,
each isolated to one concern.

## Interview defense

**Q: Why not just `JSON.parse(text) as Anomaly[]` and skip the guard?**

`as` is a lie to the compiler. The runtime value might be `null`,
`{}`, `'a string'`, or `[{ severity: 'huge' }]` — and `as Anomaly[]`
makes none of those errors visible until the UI tries to render
`undefined.severity`. The guard is the place where the runtime
*proves* the shape and the compiler *believes* the proof. It's the
difference between "we hope this is right" and "we checked, here are
the 25 tests for the bad cases we rejected."

**Q: Load-bearing part of this kernel — what breaks if it's missing?**

The fallback branch. The guard rejecting a bad shape only matters if
the *else* branch returns something usable. Without
`if (!isAnomalyArray(parsed)) return [];`, the function throws on a
bad shape, the route's catch block emits an `error` event, and the UI
shows "something went wrong" — for every Claude response that
happened to misformat one field. With the fallback, the briefing
silently shows "0 anomalies" — degraded but functional. Validation
without a graceful-empty path is the pattern half-built;
`test/agents/monitoring.test.ts:284-300, 302-315` pin both halves.

```
  The fallback is what makes validation safe-to-deploy

  guard says false      no fallback                 with fallback
  ────────────────      ──────────────              ──────────────
  → throw              → 500 to user                → empty briefing
  → blank page         → no UI at all               → degraded, recoverable
  → user retries       → user retries               → next scan likely fine
```

**Q: What ISN'T this catching?**

Two things. First, *semantic* validity. The guard accepts
`severity: 'critical'` with `change.value: 0` — a "critical 0%
change," which is nonsense but type-valid. Second, *cross-field*
constraints — direction `down` with a positive value, or evidence
that doesn't match the metric. Those would need either richer guards
or a schema library with constraint hooks. For now they live in the
prompt (the LLM is *asked* not to do them) and in spot-check eval
review, not in the static defense.

## See also

  → `02-mcp-as-callable-port.md` — the boundary above (where the LLM
    output arrives)
  → `04-real-fixture-snapshot-test.md` — the parallel defense at the
    Bloomreach response boundary
  → `audit.md` lens 5 — edge-cases-and-error-paths, where the
    reject-case tests earn the guards their keep
