# 04 — Acceptance + per-gate rejection

**Industry name:** Negative testing / boundary-value analysis with isolated gates. **Type:** Industry standard.

## Zoom out, then zoom in

`lib/mcp/validate.ts` defines the type guards that gate every LLM-produced JSON before it reaches the rest of the system: `isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`. Each guard is a chain of conditional checks — "is this an array, do all elements have a string `metric`, is the `severity` in the allowed enum, is the `direction` one of {up, down}, …" The tests in `test/mcp/validate.test.ts` follow a disciplined pattern: for **every gate** in the guard, write a test that **fails only because of that one gate**, with every other field held valid via spread. 25 tests, ~half of them isolated-gate rejections.

```
Zoom out — where this pattern protects the system

  ┌─ Agent layer (writes the JSON the guards validate) ──────────┐
  │  DiagnosticAgent.investigate → returns Diagnosis             │
  │  RecommendationAgent.propose → returns Recommendation[]      │
  │  MonitoringAgent.scan        → returns Anomaly[]             │
  └────────────────────────┬─────────────────────────────────────┘
                           │ JSON output from the LLM
                           ▼
  ┌─ ★ TYPE-GUARD LAYER (where this pattern lives) ★ ───────────┐
  │  lib/mcp/validate.ts                                          │
  │     isAnomalyArray(v)        → 6 gates, 6 isolated tests      │  ← we are here
  │     isDiagnosis(v)            → 5 gates, 6 isolated tests      │
  │     isRecommendationArray(v) → 8 gates, 9 isolated tests      │
  │     parseAgentJson(text)     → 3 paths + throw, 5 tests       │
  │                                                                │
  │  25 tests in test/mcp/validate.test.ts                        │
  └────────────────────────┬─────────────────────────────────────┘
                           │ guarded output
                           ▼
  ┌─ State + UI (consumes the validated values) ─────────────────┐
  │  lib/state/* persists; components/* renders                   │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern's kernel is **one rejection test per gate, with every other field held valid via spread** — so when a rejection test fails, it's because of the gate it targets, not because of a different field being missing.

## Structure pass

**Layers:** the guard's gate chain → the test's input variation → the assertion's specificity. **Axis traced:** *which gate is this test exercising?* **The seams where the answer flips:**

```
The axis "which gate is being tested?" — across test variations

  axis traced = "if this test fails, which gate caught it?"

  ┌─ acceptance test ─────────────────────────────┐
  │  isAnomalyArray([good]) → true                │  ALL gates pass —
  └──────────────────────┬───────────────────────┘  positive control

  ┌─ degenerate-but-valid test ───────────────────┐
  │  isAnomalyArray([]) → true                     │  array gate passes,
  └──────────────────────┬───────────────────────┘  no element gates to test

  ┌─ ★ isolated-gate rejection test ★ ────────────┐
  │  isAnomalyArray([{                             │  EXACTLY ONE gate fails:
  │    ...good[0], severity: 'huge'                │  the severity enum check.
  │  }]) → false                                   │  Every other field is the
  └──────────────────────┬───────────────────────┘  KNOWN-GOOD value via spread.

  ┌─ shape-broken rejection test ─────────────────┐
  │  isAnomalyArray({}) → false                    │  array gate fails;
  │  isAnomalyArray([{metric: 'x'}]) → false       │  missing-field gate fails
  └───────────────────────────────────────────────┘  (different from gate-isolated)
```

The flip that matters: **with spread, exactly one gate is responsible for the rejection.** Without spread (writing the object literal from scratch), you've broken multiple fields and the test can no longer tell you *which* gate caught the input — it could be the gate you intended or a different one upstream.

## How it works

### Move 1 — the mental model

For every gate in a guard, there are two tests: one that says "this input passes" and at least one that says "this input fails *because* of this specific gate." The second test holds every other field at its known-good value via spread (`{ ...good[0], severity: 'huge' }`) so that *only* the severity gate has reason to reject. If the test fails, the gate is doing its job; if it passes, the gate is bypassed.

```
The acceptance + isolated-rejection pair — the kernel

  ┌─ the guard (one gate per line) ──────────────┐
  │  isAnomalyArray(v):                          │
  │    v is array                                 │  ← gate A
  │    && v.every(a =>                            │
  │      typeof a.metric === 'string'             │  ← gate B
  │      && Array.isArray(a.scope)                │  ← gate C
  │      && typeof a.change.value === 'number'    │  ← gate D
  │      && a.change.direction in {up, down}      │  ← gate E
  │      && typeof a.change.baseline === 'string' │  ← gate F
  │      && SEVERITIES.includes(a.severity)       │  ← gate G
  │    )                                          │
  └──────────────────────┬───────────────────────┘
                         │
                         ▼
  ┌─ the test set, one acceptance + per-gate rejection ─────────┐
  │                                                              │
  │  good = { metric: 'conversion_rate', scope: ['mobile'],     │
  │           change: { value: -18, direction: 'down',          │
  │                     baseline: '7d' },                        │
  │           severity: 'warning', evidence: [] };              │
  │                                                              │
  │  // acceptance (positive control)                            │
  │  expect(isAnomalyArray([good])).toBe(true)                  │
  │  expect(isAnomalyArray([])).toBe(true)        // degenerate │
  │                                                              │
  │  // per-gate rejections (every other field valid via spread)│
  │  expect(isAnomalyArray({})).toBe(false)                     │  ← gate A
  │  expect(isAnomalyArray([{metric: 'x'}])).toBe(false)        │  ← gate B (and others)
  │  expect(isAnomalyArray([{...good,                            │
  │    change: { value: 1, direction: 'sideways',                │
  │              baseline: '7d' }}])).toBe(false)                │  ← gate E (ISOLATED)
  │  expect(isAnomalyArray([{...good,                            │
  │    severity: 'huge'}])).toBe(false)                          │  ← gate G (ISOLATED)
  └─────────────────────────────────────────────────────────────┘
```

The point of the spread: each isolated rejection test fails *only* if the gate it targets is broken. If you delete the severity enum check from the guard and replace it with `true`, four tests still pass — only "rejects a bad severity" fails. The test points at the exact gate that broke.

### Move 2 — the walkthrough

#### Acceptance + per-gate, the canonical example (isAnomalyArray)

Six gates in the guard, six paired tests in `validate.test.ts` lines 22–30. The acceptance test establishes "the guard *can* return true." Each rejection test breaks exactly one gate while holding every other field valid.

```
Acceptance + per-gate rejection — isAnomalyArray pattern

  acceptance:
    isAnomalyArray([good]) → true      ← positive control:
                                          guard CAN return true
    isAnomalyArray([])     → true      ← degenerate-valid:
                                          empty array is allowed

  per-gate rejection (each isolates ONE gate via spread):
    isAnomalyArray({})                    → false   ← gate A (not an array)
    isAnomalyArray([{metric: 'x'}])       → false   ← gate B (missing fields)
    isAnomalyArray([{...good, change: {value: 1, direction: 'sideways',
                                       baseline: '7d'}}]) → false  ← gate E only
    isAnomalyArray([{...good, severity: 'huge'}])           → false  ← gate G only
```

The spread is the discipline. Without it, the test `isAnomalyArray([{ severity: 'huge' }])` would also fail gates B, C, D, E, F (missing `metric`, `scope`, `change`, etc.) — so the test would pass against a guard with the severity check removed, as long as the missing-field gate caught it instead.

#### The richer case (isRecommendationArray, dual shape)

`isRecommendationArray` has the most interesting gate set because `estimatedImpact` accepts *two* shapes: a legacy string OR a rich `{ range, rangeUsd, assumption }` object that must include `range`. The tests cover both shapes accepting and the object shape rejecting when missing `range` — exactly the kind of test that catches a migration bug.

```
The dual-shape coverage — isRecommendationArray's interesting gate

  the guard's `impactOk` gate (lib/mcp/validate.ts lines 42–57):
    impactOk =
      typeof x.estimatedImpact === 'string'           // legacy
      OR (
        typeof x.estimatedImpact === 'object'          // rich
        AND typeof x.estimatedImpact.range === 'string'  // required field
      )

  the test set (validate.test.ts lines 80–98):
    accept the legacy string shape:
      isRecommendationArray([{...good, estimatedImpact: '+$14k recovered'}])
        → true

    accept the rich object shape:
      isRecommendationArray([{...good, estimatedImpact: {
        range: '+$14k – $23k', rangeUsd: {low: 14000, high: 23000},
        assumption: 'assumes 15–25% reactivation'
      }}]) → true

    reject the rich object missing `range` (the migration trap):
      isRecommendationArray([{...good, estimatedImpact: {assumption: 'x'}}])
        → false                ← if someone refactors the gate to just
                                  "typeof === 'object'" and drops the range
                                  check, THIS test catches it
```

This is exactly the test pattern that protects against an over-eager refactor — "let me simplify this `impactOk` check" silently widens what the guard accepts, and the dual-shape rejection test fails loudly.

#### The throw case (parseAgentJson)

`parseAgentJson` is not a boolean guard; it *throws* when no JSON can be extracted. The rejection-shape assertion changes from `.toBe(false)` to `.toThrow()`. Same discipline — assert the *kind* of failure, not just "the function didn't return success."

```
Throw-path negative testing — parseAgentJson

  acceptance (positive controls — three parsing strategies):
    parseAgentJson('```json\n{"a":1}\n```')  → {a: 1}   ← fenced
    parseAgentJson('{"a":1}')                 → {a: 1}   ← plain
    parseAgentJson('prefix {"a":1} suffix')   → {a: 1}   ← embedded scan

  rejection (throws on no-JSON):
    expect(() => parseAgentJson('no json here')).toThrow()

  why .toThrow() and not .toBe(undefined): the agent classes wrap
  parseAgentJson in try/catch and run a synthesis fallback when it
  throws. The test asserts the throw HAPPENS, which is what the
  catch on the other side depends on. Returning undefined would
  silently bypass the fallback — different bug, different fix.
```

The agent classes (`DiagnosticAgent`, `RecommendationAgent`) build on top of this throw — they wrap `parseAgentJson` in try/catch and run a synthesis fallback when it throws. The throw contract is load-bearing; the test pins it.

### Move 2 variant — the load-bearing skeleton

What is the minimum that makes per-gate rejection coverage useful?

1. **A positive-control acceptance test.** Without it, a guard that always returns `false` also passes every rejection test. Drop this and you can't tell "always rejects" from "rejects this specific bad input."

2. **One rejection test per gate, with every other field valid via spread.** The spread is the discipline. Without it, a rejection test that breaks multiple fields tells you "the guard rejected" but not "the *severity* gate rejected." Spread holds everything else known-good so the gate under test is the only candidate for the rejection.

3. **An assertion on the *kind* of failure.** `.toBe(false)` for boolean guards, `.toThrow(/specific message/)` for throws, `.rejects.toThrow()` for async. Drop this and "the function didn't return success" includes both "rejected for the right reason" and "blew up at the wrong gate or threw an unexpected error."

Skeleton = positive control + isolated per-gate rejection + specific failure shape. Drop any one and the rejection coverage becomes decoration.

### Move 3 — the principle

**A function is defined by what it accepts AND what it rejects; testing only the accept side documents half the contract.** The pattern that works: for every gate, write a test that fails *only* because of that gate. The discipline scales — apply it to the type guards (done well here), then to the agent error paths (gap here: no test scripts a throw from `anthropic.messages.create`), then to the route handlers (gap here too: no `test/api/` directory). The same kernel — isolated per-gate rejection — works at every level.

## Primary diagram

The full pattern, applied across every type guard in the file:

```
Acceptance + per-gate rejection — full map of validate.ts coverage

  ┌─ isAnomalyArray (6 gates) ─────────────────────────────────────┐
  │                                                                 │
  │  acceptance:    [good]                              → true      │
  │  degenerate:    []                                   → true      │
  │  rejection A:   {}                                   → false ← not array
  │  rejection B/D: [{metric:'x'}]                       → false ← missing
  │  rejection E:   [{...good, change:{direction:'…'}}] → false ← direction
  │  rejection G:   [{...good, severity:'huge'}]        → false ← severity
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘

  ┌─ isDiagnosis (5 gates) ────────────────────────────────────────┐
  │                                                                 │
  │  acceptance:    valid diagnosis object               → true      │
  │  degenerate:    arrays of evidence may be empty      → true      │
  │  rejection 1:   null                                  → false    │
  │  rejection 2:   'some string'                        → false    │
  │  rejection 3:   {valid except missing conclusion}    → false    │
  │  rejection 4:   {valid except evidence: 'not array'} → false    │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘

  ┌─ isRecommendationArray (8 gates incl. dual-shape impact) ─────┐
  │                                                                 │
  │  acceptance:    [valid with legacy string impact]    → true     │
  │  acceptance':   [valid with rich object impact]      → true     │
  │  degenerate:    []                                   → true     │
  │  rejection A:   {} (not array)                       → false    │
  │  rejection B:   [bad feature (not in enum)]          → false    │
  │  rejection C:   [bad confidence (not in enum)]       → false    │
  │  rejection D:   [missing steps]                      → false    │
  │  rejection E:   [object impact missing range]        → false ★  │
  │                                                                 │
  │  ★ this is the migration-trap test: if a refactor               │
  │    drops the range check, this is the test that fires.          │
  └────────────────────────────────────────────────────────────────┘

  ┌─ parseAgentJson (3 strategies + 1 throw) ─────────────────────┐
  │                                                                 │
  │  acceptance A:  fenced ```json block                 → parsed   │
  │  acceptance B:  plain JSON                           → parsed   │
  │  acceptance C:  embedded JSON in prose                → parsed   │
  │  rejection:     no JSON anywhere                     → throws   │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case A — isAnomalyArray, the canonical pattern.** Six gates in the guard, six paired tests. The `good` fixture at the top of the `describe` is reused across every test via spread.

```
lib/mcp/validate.ts  (lines 17–27 — the guard)

  export function isAnomalyArray(v: unknown): v is Anomaly[] {
    return Array.isArray(v) && v.every((a) => {
      const x = a as any;
      return !!x && typeof x === 'object'
        && typeof x.metric === 'string'                              ← gate B
        && Array.isArray(x.scope)                                    ← gate C
        && !!x.change && typeof x.change === 'object'
        && typeof x.change.value === 'number'                        ← gate D
        && (x.change.direction === 'up' || x.change.direction === 'down')  ← gate E
        && typeof x.change.baseline === 'string'                     ← gate F
        && SEVERITIES.includes(x.severity);                          ← gate G
    });
  }

test/mcp/validate.test.ts  (lines 22–30 — the test set)

  describe('isAnomalyArray', () => {
    const good = [{
      metric: 'conversion_rate', scope: ['mobile'],
      change: { value: -18, direction: 'down', baseline: '7d' },
      severity: 'warning', evidence: [],
    }];

    it('accepts a well-formed anomaly array', () => {
      expect(isAnomalyArray(good)).toBe(true);            ← acceptance
    });
    it('accepts an empty array', () => {
      expect(isAnomalyArray([])).toBe(true);              ← degenerate-valid
    });
    it('rejects a non-array', () => {
      expect(isAnomalyArray({})).toBe(false);             ← gate A
    });
    it('rejects a missing-field object', () => {
      expect(isAnomalyArray([{ metric: 'x' }])).toBe(false);  ← gates B/C/D…
    });
    it('rejects a bad severity', () => {
      expect(isAnomalyArray([{ ...good[0], severity: 'huge' }])).toBe(false);
                                                          ← gate G, isolated
    });
    it('rejects a bad direction', () => {
      expect(isAnomalyArray([{ ...good[0],
        change: { value: 1, direction: 'sideways', baseline: '7d' } }])).toBe(false);
                                                          ← gate E, isolated
    });
  });
       │
       └─ each rejection test KEEPS every other field valid via spread —
          that isolates the gate being tested. If you also broke another
          field, the test couldn't tell you WHICH gate caught it.
```

**Use case B — the migration-trap test on `isRecommendationArray`.** The dual-shape `estimatedImpact` field is the gate most likely to be silently widened by a refactor. The "object impact missing range" rejection test is the guard against that.

```
lib/mcp/validate.ts  (lines 42–57 — the dual-shape gate)

  export function isRecommendationArray(v): v is Omit<Recommendation, 'id'>[] {
    return Array.isArray(v) && v.every((r) => {
      const x = r as any;
      // estimatedImpact may be the legacy string OR the richer { range, ... } shape
      const impactOk =
        typeof x.estimatedImpact === 'string'                            ← legacy
        || (!!x.estimatedImpact && typeof x.estimatedImpact === 'object'
            && typeof x.estimatedImpact.range === 'string');             ← rich
      return !!x && typeof x === 'object'
        && typeof x.title === 'string'
        && typeof x.rationale === 'string'
        && FEATURES.includes(x.bloomreachFeature)
        && Array.isArray(x.steps)
        && impactOk                                                       ← the gate
        && CONFIDENCE.includes(x.confidence);
    });
  }

test/mcp/validate.test.ts  (lines 84–98 — the two acceptances + the migration trap)

  it('accepts the richer object estimatedImpact shape', () => {
    const rich = { ...good, estimatedImpact: {
      range: '+$14k – $23k recovered this week',
      rangeUsd: { low: 14000, high: 23000 },
      assumption: 'assumes 15–25% reactivation of ~340 buyers at ~$1,124 aov',
    }};
    expect(isRecommendationArray([rich])).toBe(true);     ← rich shape accepted
  });

  it('rejects an object estimatedImpact missing range', () => {
    expect(isRecommendationArray([{ ...good, estimatedImpact:
      { assumption: 'x' } }])).toBe(false);               ← required `range` enforced
       │
       └─ this is exactly the kind of test that catches a refactor that
          drops the range check from the gate — every other test still
          passes; only this one fires.
  });
```

## Elaborate

The "acceptance + per-gate rejection" discipline is descended from boundary-value analysis (Glenford Myers, *The Art of Software Testing*, 1979). The variant that uses object spread to isolate one gate is property-style coverage in disguise — you're holding every other property valid while varying one. Pushed further, this is what `fast-check` (property-based testing in JS) generates automatically, but for small enums and known shapes the hand-rolled pattern in `validate.test.ts` is more readable and just as tight.

There's a deeper connection to **type-driven design**. The type guards in `validate.ts` exist because TypeScript's compile-time guarantees stop at the I/O boundary — JSON from the LLM is `unknown` and has to be narrowed at runtime. The acceptance + per-gate rejection pattern is how you verify the narrowing actually works for every gate the type system claims; it's the runtime counterpart to the type-system claim.

Cross-reference: `study-software-design`'s "deep interface, shallow implementation" — the type guards in `validate.ts` are deep (a small interface: `(v: unknown) => v is T`) and the rejection tests are the leverage that makes the depth real. A shallow interface (one method per gate) would require N times the tests for the same coverage.

## Interview defense

**Q: Why isolate one gate per rejection test?** Because if you write `isAnomalyArray([{ severity: 'huge' }])` you've broken severity AND the `metric`, `scope`, `change` fields. The test fails — but you don't know whether the severity check caught it or one of the missing-required-fields gates did. With spread (`{ ...good[0], severity: 'huge' }`), only severity is bad; if the test fails, it's because of the severity gate specifically. That's the difference between a test that locates the bug and a test that just notices something is wrong.

```
The diagnostic value of isolation

  no-spread rejection                  spread rejection
  ───────────────────                  ────────────────
  isAnomalyArray([{severity:'huge'}])  isAnomalyArray([{...good, severity:'huge'}])
  fails IF severity check broken       fails ONLY IF severity check broken
  fails ALSO IF metric check broken    every other gate held valid via spread
  fails ALSO IF scope check broken     → if it fails, you know which gate
  → test failure doesn't locate bug
```

**Q: Where does this discipline NOT yet apply in this repo?** The agent error paths. Every scripted-Anthropic test asserts on a successful path; none script a throw from `anthropic.messages.create`. The equivalent "isolated rejection" for the agent layer would be: `script the Anthropic SDK to throw a 401 → expect the agent to either reject with a specific error OR emit an error event AND fall back to a default diagnosis`. Today neither contract is locked. That's the same pattern at a different layer, just not built.

**Q: Why `.toThrow()` instead of catching and asserting on the returned undefined?** Because the throw IS the contract. `parseAgentJson` throws on bad input by design — the agent classes wrap it in try/catch and run a synthesis fallback when it throws. If `parseAgentJson` returned `undefined` instead, the fallback path would never run; that's a different bug. The `.toThrow()` assertion pins the contract that downstream code depends on.

## See also

- `audit.md#edge-cases-and-error-paths` — the lens this pattern anchors
- `01-scripted-anthropic-harness.md` — the agent layer that depends on these guards as fallback triggers
- `02-fixture-driven-schema-parser.md` — the parser output that flows into these guards (after parsing)
- `03-vi-stubenv-isolation.md` — the test isolation that lets parallel-worker runs of validate.test.ts stay clean
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
