# 04 — Acceptance with per-gate rejection
*Industry name: positive/negative path testing with per-field invariants. Type: Industry standard (the discipline behind robust JSON schema validators).*

## Zoom out — where this pattern lives

```
  the validators sit BETWEEN the LLM and the rest of the system

  ┌─ Agent layer ────────────────────────────────────────────────────┐
  │  runAgentLoop returns finalText (a string from Claude)            │
  └─────────────────────────────┬────────────────────────────────────┘
                                │   parseAgentJson(finalText) → unknown
  ┌─ Validator layer ──────────▼────────────────────────────────────┐
  │  lib/agents/legacy-validate.ts                                   │
  │  ★ THESE TYPE GUARDS ARE THE GATE ★                              │
  │    isAnomalyArray(value): value is Anomaly[]                     │
  │    isDiagnosis(value): value is Diagnosis                        │
  │    isRecommendationArray(value): value is Omit<Recommendation,'id'>[]│
  └─────────────────────────────┬────────────────────────────────────┘
                                │   only typed values pass
  ┌─ State + UI layer ─────────▼────────────────────────────────────┐
  │  putInsights(...) → InsightCard.tsx reads the typed shape        │
  │  EvidencePanel reads Diagnosis fields by name                    │
  │  RecommendationCard reads bloomreachFeature enum                 │
  └──────────────────────────────────────────────────────────────────┘
```

The validators are a one-way membrane: malformed LLM output is rejected
at this layer, never reaches state or UI. The test file proves that
membrane is **per-field tight** — not just "this object passes" but
"this object fails *specifically because* the severity is invalid."

## Structure pass — the skeleton this pattern hangs on

**Layers:** LLM output → parser → type guard → typed downstream.

**Axis: trust — what does the downstream code assume about its input?**

```
  trust flips at the validator boundary

  ┌─ upstream ──┐  seam: isAnomalyArray(x)  ┌─ downstream ───────┐
  │  unknown    │ ═══════════════════════════│  trusted as        │
  │  (from LLM, │  (the predicate returns    │  Anomaly[] —       │
  │   could be  │   true XOR false)          │  every field       │
  │   anything) │                            │  guaranteed        │
  └─────────────┘                            │  present + typed   │
                                             └────────────────────┘
       ▲                                              ▲
       └── same axis (trust), flipped by one predicate ┘
           → the predicate IS the trust boundary;
             every field it doesn't check is a trust hole
```

The discipline here: the test must prove the predicate is **tight on
both sides**. A well-formed value must pass; a value malformed in any
specific way must fail. If one rejection is missing, that's a hole the
LLM will eventually find.

**The seam that matters:** every enum value. Severities, directions,
features, confidence levels — these are the most likely places for an
LLM to drift ("medium-low" instead of "low," "warning!" instead of
"warning"), so they get a dedicated rejection per test.

## How it works

### Move 1 — the mental model

You know how a form input's `type="email"` accepts `a@b.com` but
rejects `not-an-email`? Same shape one altitude up: the validator
accepts a well-formed object but rejects every specific kind of
malformation. The test's job is to enumerate the malformations.

```
  The pattern — one acceptance, N rejections

         ┌──────────────────────────┐
         │  ACCEPTANCE              │  ← prove the predicate
         │  good = { ... }          │     accepts a well-formed value
         │  expect(guard(good))     │
         │    .toBe(true)            │
         └──────────────────────────┘
                       │
                       │  then, for each FIELD the predicate checks:
                       ▼
         ┌──────────────────────────┐
         │  REJECTION                │  ← prove the predicate
         │  bad = { ...good,         │     specifically rejects the
         │    severity: 'huge' }     │     malformation
         │  expect(guard([bad]))     │
         │    .toBe(false)           │
         └──────────────────────────┘
                       │
                       │  repeat per field / per enum / per missing key
                       ▼
              ALL FIELDS COVERED?
              the predicate is "tight" — no field is unchecked
```

The shape is symmetric: one positive test per shape, one negative
test per **distinct rejection reason**. If the predicate checks five
things, the test file has at least six `it()` for that predicate
(1 accept + 5 reject).

### Move 2 — the step-by-step walkthrough

#### Step 1 — the validator itself, named so the test knows what to assert

```ts
// lib/agents/legacy-validate.ts:17-26 (annotated)
const SEVERITIES: Severity[] = ['critical', 'warning', 'info', 'positive'];

export function isAnomalyArray(v: unknown): v is Anomaly[] {
  return Array.isArray(v) && v.every((a) =>
    !!a && typeof a === 'object' &&
    typeof (a as any).metric === 'string' &&                  // ← gate 1
    Array.isArray((a as any).scope) &&                        // ← gate 2
    !!(a as any).change && typeof (a as any).change.value === 'number' && // gate 3
    ((a as any).change.direction === 'up' ||
     (a as any).change.direction === 'down') &&               // ← gate 4
    typeof (a as any).change.baseline === 'string' &&         // ← gate 5
    SEVERITIES.includes((a as any).severity)                  // ← gate 6
  );
}
```

Six gates. Six fields the guard insists on. The test enumerates them.

#### Step 2 — start with one acceptance

```ts
// test/mcp/validate.test.ts:22-30 (start of the block)
describe('isAnomalyArray', () => {
  const good = [{
    metric: 'conversion_rate',
    scope: ['mobile'],
    change: { value: -18, direction: 'down', baseline: '7d' },
    severity: 'warning',
    evidence: [],
  }];

  it('accepts a well-formed anomaly array', () => {
    expect(isAnomalyArray(good)).toBe(true);
  });
  it('accepts an empty array', () => {
    expect(isAnomalyArray([])).toBe(true);
  });
```

Two acceptances — one with a real item, one with an empty array. The
empty case is its own assertion because "empty is valid" is a real
choice the predicate makes (an empty `[]` passes; a non-array `{}`
doesn't, see next step).

#### Step 3 — one rejection per field, per enum

```ts
// test/mcp/validate.test.ts:26-30 (the rejection battery)
  it('rejects a non-array', () => {
    expect(isAnomalyArray({})).toBe(false);
  });
  it('rejects a missing-field object', () => {
    expect(isAnomalyArray([{ metric: 'x' }])).toBe(false);
  });
  it('rejects a bad severity', () => {
    expect(isAnomalyArray([{ ...good[0], severity: 'huge' }])).toBe(false);
  });
  it('rejects a bad direction', () => {
    expect(isAnomalyArray([{ ...good[0], change: {
      value: 1, direction: 'sideways', baseline: '7d',
    } }])).toBe(false);
  });
});
```

Four rejections. Each one names the **specific reason** the value
should fail:

```
  rejection                     what it proves
  ──────────────────────────    ─────────────────────────────────────
  non-array                     the top-level Array.isArray gate fires
  missing fields                a partial object doesn't sneak through
                                "well, it had a metric, ship it"
  bad severity                  the SEVERITIES enum is enforced;
                                an LLM that says 'huge' is caught
  bad direction                 the 'up'|'down' literal is enforced;
                                'sideways' is caught
```

The pattern: take `good[0]`, spread it, override **one** field with a
malformation, assert false. The spread is load-bearing — it isolates
the rejection cause. If you wrote `expect(isAnomalyArray([
{ severity: 'huge' }]))`, the test would fail for THREE reasons (missing
metric, missing scope, bad severity) and you'd lose the per-gate signal.

#### Step 4 — apply the same discipline to a richer object

The `isRecommendationArray` block is the longest in the file because
the type has the most enums:

```ts
// test/mcp/validate.test.ts:69-120 (annotated highlights)
describe('isRecommendationArray', () => {
  const good = {
    title: '…',
    rationale: '…',
    bloomreachFeature: 'scenario',                            // ← enum 1
    steps: ['…'],
    estimatedImpact: '…',                                     // ← polymorphic
    confidence: 'medium',                                     // ← enum 2
  };

  it('accepts a well-formed (id-less) recommendation array', () => {
    expect(isRecommendationArray([good])).toBe(true);
  });

  it('accepts the richer object estimatedImpact shape', () => {     // ← BOTH
    const rich = { ...good, estimatedImpact: {                       //   shapes
      range: '+$14k – $23k recovered this week',                     //   pass
      rangeUsd: { low: 14000, high: 23000 },
      assumption: 'assumes 15–25% reactivation of ~340 buyers...',
    }};
    expect(isRecommendationArray([rich])).toBe(true);
  });

  it('rejects an object estimatedImpact missing range', () => {      // ← but
    expect(isRecommendationArray([                                   //   not
      { ...good, estimatedImpact: { assumption: 'x' } }              //   any
    ])).toBe(false);                                                 //   object
  });

  it('accepts an empty array', () => {...});
  it('rejects a non-array', () => {...});
  it('rejects a bad bloomreachFeature', () => {                      // ← enum 1
    expect(isRecommendationArray([{ ...good, bloomreachFeature: 'webhook' }])).toBe(false);
  });
  it('rejects a bad confidence', () => {                             // ← enum 2
    expect(isRecommendationArray([{ ...good, confidence: 'certain' }])).toBe(false);
  });
  it('rejects a missing steps field', () => {                        // ← required
    const { steps: _s, ...rest } = good;
    expect(isRecommendationArray([rest])).toBe(false);
  });
});
```

Eight `it()`. Three acceptances (good, rich impact shape, empty
array). Five rejections (non-array, missing range on rich impact, bad
feature, bad confidence, missing steps). **Every gate the predicate
checks has its own rejection.**

#### Step 5 — what the "polymorphic field" case teaches

`estimatedImpact` can be either a string OR an object with `range`.
The validator handles both — and the test PROVES both branches.
That's the load-bearing move when a field has a union type:

```
  polymorphic field test discipline

  field union               required test cases
  ──────────────────────    ──────────────────────────────────
  T | U                     1 acceptance of T (it #1)
                            1 acceptance of U (it #2)
                            1 rejection of a malformed T (it #3)
                            1 rejection of a malformed U (it #N)
                            1 rejection of neither (e.g. number)

  this is what makes the union safe — if the test only covers ONE
  branch, the other branch can drift silently
```

The `it()` count rises faster on polymorphic fields. That's the cost
of the union; the test discipline keeps it honest.

#### Step 6 — what this catches, in concrete terms

```
  scenario                                         what catches it
  ─────────────────────────────────────────────    ────────────────────────────
  Claude returns severity='warning!' (extra '!')  isAnomalyArray rejects →
                                                   the route's catch falls back
                                                   to a derived insight (see
                                                   lib/insights/derive.ts);
                                                   the UI never sees malformed
                                                   data
  Claude omits the `steps` field on a              isRecommendationArray
   recommendation                                  rejects → the route returns
                                                   [] for that batch instead of
                                                   shipping a card the UI can't
                                                   render
  Claude returns                                   the polymorphic test's
   estimatedImpact: { assumption: 'x' }            "rejects missing range"
   (object shape without range)                    gate fires → the impact is
                                                   excluded
  the validator itself is refactored               EVERY existing rejection
   incompatibly                                    test flips — the test file
                                                   becomes the regression
                                                   detector
```

Strip this pattern out and you lose the proof that the validator
membrane is tight. The agent loop's parse-step still runs, but it
becomes a "trust the parser" leap of faith — and that's exactly the
leap the membrane was built to remove.

### Move 2 variant — the load-bearing skeleton

The kernel of acceptance + per-gate rejection is three discipline
points. Drop any and the pattern degrades into "we tested the happy
path."

```
  THE KERNEL — three parts, what breaks if missing

  1. ONE ACCEPTANCE NAMED 'good' (the canonical shape)
     a single object the rest of the test spreads + overrides
     → without a stable 'good', each rejection test has to
       reconstruct the well-formed shape inline; drift between
       acceptance and rejection creates "rejected for wrong reason"
       false positives

  2. ONE REJECTION PER DISTINCT FAILURE REASON
     spread good, override ONE field, assert false
     → without the spread + single override, a rejection fires for
       multiple reasons and you can't tell WHICH gate caught it;
       silent drift in one gate goes undetected because another gate
       still rejects

  3. BOTH BRANCHES OF EVERY UNION (the polymorphic case)
     when a field is T | U, one acceptance per branch + one
     rejection per branch + one rejection of "neither"
     → without it, one branch of the union can break silently
       because the other branch's test still passes
```

These three are the irreducible kernel. Optional hardening on top:
property-based testing (fast-check), schema-derived test generators,
mutation testing to verify rejection coverage. Useful, not load-bearing
in this repo.

The interview-payoff move: name the **"one rejection per distinct
reason"** rule. Most people remember "test the happy path + a couple
of failures." The discipline is that *every gate the predicate
checks* gets its own targeted rejection — and the spread-then-override
pattern is what makes that test isolatable.

### Move 3 — the principle

**The validator's contract isn't "this object passes" — it's "these
malformations specifically fail."** Acceptance tests are necessary but
weak; they prove the gate is at least permissive enough. Rejection
tests are what prove the gate is *correct* — that it catches the
specific failures it's supposed to.

In a domain where the input source is a non-deterministic process (an
LLM), the per-gate discipline becomes load-bearing rather than
defensive. The LLM WILL produce malformations eventually; the test's
job is to prove the validator catches each named class. Anything
unchecked is a silent corruption path.

## Primary diagram — the whole pattern in one frame

```
  ACCEPTANCE WITH PER-GATE REJECTION — one frame

  ┌─ THE VALIDATOR (lib/agents/legacy-validate.ts) ───────────────────┐
  │  isAnomalyArray(v): v is Anomaly[]                                 │
  │    gates: [is-array, every-item-has-metric, scope-is-array,        │
  │            change-has-numeric-value, direction-in-{up,down},       │
  │            baseline-is-string, severity-in-SEVERITIES]             │
  └──────────────────────────┬───────────────────────────────────────┘
                             │
  ┌─ THE TEST (test/mcp/validate.test.ts) ──────────────────────────┐
  │                          ▼                                        │
  │   const good = { metric, scope, change, severity, evidence }     │
  │                                                                  │
  │   ACCEPT:                                                        │
  │   ✓ isAnomalyArray(good)         → true                          │
  │   ✓ isAnomalyArray([])           → true (empty is valid)         │
  │                                                                  │
  │   REJECT (one per gate):                                         │
  │   ✗ isAnomalyArray({})                              [non-array]  │
  │   ✗ isAnomalyArray([{ metric: 'x' }])               [missing]    │
  │   ✗ isAnomalyArray([{...good, severity: 'huge'}])  [bad enum]   │
  │   ✗ isAnomalyArray([{...good, change.direction:'sideways'}])    │
  │                                                     [bad literal]│
  │                                                                  │
  │   pattern: spread good, override ONE field, assert false         │
  └──────────────────────────────────────────────────────────────────┘

  25 it() across 4 validators (parseAgentJson + 3 type guards) =
   the entire LLM→UI membrane is tested per-field
```

## Elaborate

This is the discipline behind every robust JSON schema validator —
Ajv, Joi, Zod, Pydantic, Yup all enforce it at the library level. What's
notable about this codebase is that the validators are **hand-rolled
type guards**, not a schema library, and the test discipline reproduces
what a schema library would do automatically.

The tradeoff:

```
  hand-rolled type guards           schema library (e.g. Zod)
  ────────────────────────────      ─────────────────────────────────
  one function, plain TS            schema-as-data, derive parser from it
  no dependency                     dependency
  tests must enumerate gates        tests can rely on the library's
                                    field-by-field error messages
  the gates ARE the contract        the schema IS the contract,
                                    the parser is generated
  cheap for ~5 types                pays for itself as types grow
```

This repo's choice (hand-rolled) is right for the current scale: three
types, total ~50 lines of validator code, no need to ship a runtime
schema library to the browser. The cost is the test discipline — every
new gate in the validator must come with a new rejection test, by
hand. When the codebase grows to 10+ types or the validators start
nesting, a switch to Zod (or AJV) would pay off; the test discipline
named here is what would survive that switch unchanged.

The deeper lineage: this is the **partition-testing** approach from
formal methods, applied lightly. The input space of the validator is
partitioned into "all valid inputs" and "all invalid inputs." The
test picks one representative from "valid" and one representative per
named **invalidity class** ("non-array," "bad enum," "missing field").
Partition testing's bite is that it doesn't try to enumerate every
possible invalid input — it groups them by the rule that catches them,
which is exactly the per-gate discipline above.

Where this connects to AI work specifically: when the input source is
an LLM, the **invalidity classes** become a useful artifact in their
own right. Every named rejection is also a hypothesis about how the
LLM might fail. The test file becomes a record of "we've considered
the LLM might do X" — and the empty-rejection space is the unconsidered
failure-mode space.

## Interview defense

**Q: "Why not just test that valid input passes?"**

Because validating against a non-deterministic input source (an LLM)
means the invalid cases are the ones I'll see in production. The
positive test proves the gate is at least permissive enough for good
input. The negative tests prove the gate catches each *specific*
malformation an LLM might produce — bad severity, bad direction, missing
field, wrong polymorphic branch. Anything I don't test for is a silent
corruption path: a bad value flows through the validator into state,
the UI tries to render it, and the bug surfaces three layers away from
the cause.

The diagram I'd draw: the validator membrane between agent layer and
state layer, with the test enumerating every named hole the test
believes the membrane closes.

*anchor:* `test/mcp/validate.test.ts:22-30` for the `isAnomalyArray`
block — clearest example of one acceptance + one rejection per gate.

**Q: "What's the load-bearing part everyone forgets?"**

The spread-then-override pattern: `{ ...good, severity: 'huge' }`. The
naive version writes the malformed object from scratch, which makes
the test pass for the WRONG reason — it fails on three gates at once
(missing metric, missing scope, bad severity) and you can't tell
which gate actually caught it. If the bad-severity gate were silently
removed, the test would still pass because the missing-metric gate
catches it. The spread + single override isolates the rejection to
the gate you're testing, so removing that gate fails the test for the
right reason.

It's the same discipline as a unit test that mocks one collaborator
at a time — isolation is what makes the failure signal sharp.

*anchor:* `test/mcp/validate.test.ts:28-29` — the spread is one
character (`...good`) and it's load-bearing.

**Q: "What about polymorphic fields like estimatedImpact (string OR
object)?"**

Same discipline applied to each branch. The test file has:
- one acceptance of the string shape (the legacy form)
- one acceptance of the object shape (the rich form)
- one rejection of an object missing the required `range` field
- the array-level rejections (non-array, etc.) still apply

The trap I'd avoid in an interview: claiming the union is "tested" with
one acceptance and one rejection. A union of T | U needs **both**
acceptance branches AND a rejection per branch — because otherwise one
branch can drift silently while the other branch's test passes.

*anchor:* `test/mcp/validate.test.ts:80-99` for the polymorphic block
on `estimatedImpact`.

## See also

  → `02-fixture-driven-schema-parser-tests.md` — the parser layer one
    altitude up (raw envelope → unwrap → object). The validators in
    this file run on whatever the parser produces.
  → `01-scripted-anthropic-harness.md` — the layer one altitude
    down. The harness produces the `finalText`; `parseAgentJson` +
    these validators turn it into a typed value.
  → `audit.md` lens 5 (edge cases + error paths) — names this
    discipline as the right shape for LLM-from-JSON seams.
