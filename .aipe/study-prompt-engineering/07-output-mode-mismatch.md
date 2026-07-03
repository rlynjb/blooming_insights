# 07 · Output mode mismatch

**Output format contract / schema mismatch at chain boundary — Industry standard**

## Zoom out, then zoom in

Every chain emits *something*. Every consumer downstream reads it as *some shape*. The bug this concept covers is the silent case where the emitter's shape and the consumer's shape disagree — and neither the model nor the compiler catches it because the JSON parses cleanly, the fields the consumer reads happen to exist, and the mismatch only surfaces when a specific optional field turns out to be structured differently than the consumer assumed. This is the "we shipped it, works in staging, fails on the tenth production case" bug.

```
  Zoom out — where output mode mismatch lives

  ┌─ Chain A (emitter) ─────────────────────────────┐
  │  RecommendationAgent emits estimatedImpact       │
  │  as EITHER a string OR                            │
  │  { range, rangeUsd?, assumption } object          │
  └─────────────────────┬───────────────────────────┘
                        │
  ┌─ ★ THE MISMATCH SEAM ★ ─▼──────────────────────┐
  │  what shape does the consumer expect?           │  ← we are here
  │  a string? an object? tolerant of both?         │
  └─────────────────────┬───────────────────────────┘
                        │
  ┌─ Chain B / UI (consumer) ─▼─────────────────────┐
  │  RecommendationCard reads r.estimatedImpact      │
  │  as { rangeUsd?.low, ... }                        │
  │  breaks silently if it's a string                 │
  └─────────────────────────────────────────────────┘
```

**Zoom in.** Output mode has three dimensions: **format** (JSON vs prose vs tool_use), **shape** (which fields, which types), and **envelope** (fenced in ```json vs raw vs wrapped in a tool_use block). A mismatch on any dimension breaks the consumer. This codebase has one interesting real-world example — `estimatedImpact` is deliberately polymorphic (string OR structured object) because the schema evolved and older data still validates — and that polymorphism is itself a controlled output-mode mismatch that the consumer must handle.

## Structure pass

### Axes — the dimension we're tracing

**Contract sharpness at the boundary.** For every chain-to-chain hand-off, ask: is the output type sharp enough that a mismatch is caught by the compiler, the validator, or the parser? Or is it soft enough that a mismatch only shows up as a runtime NaN, undefined lookup, or wrong-shape render?

### Seams — where mismatches happen

Three seams:

- **Format seam** — emitter says "JSON in a fence"; consumer reads as raw JSON without fence handling. Or emitter emits a tool_use block; consumer parses text.
- **Shape seam** — emitter emits `{ conclusion, evidence, hypothesesConsidered }`; consumer reads `.rootCause` instead of `.conclusion`. Type system catches this if the type is used; runtime crash if the consumer used `any`.
- **Envelope seam** — emitter's output is one item; consumer expects an array. Or emitter's array is empty; consumer assumes `[0]` exists.

### Layered decomposition

"What guarantees this chain's output matches what the next stage reads?" — traced across layers:

```
  "Who enforces the output shape?" — same question, three altitudes

  ┌────────────────────────────────────────────────┐
  │ outer: the TypeScript type                      │  → Recommendation type
  │        (compile-time)                           │    in lib/mcp/types.ts
  └────────────────────────────────────────────────┘
      ┌────────────────────────────────────────────┐
      │ middle: the runtime validator               │  → isRecommendationArray
      │        (post-parse)                         │    in lib/mcp/validate.ts
      └────────────────────────────────────────────┘
          ┌────────────────────────────────────────┐
          │ inner: the model's prompt               │  → the ## Output section
          │        (pre-generation shape)           │    of recommendation.md
          └────────────────────────────────────────┘
```

The three layers overlap; each catches different mismatches. Type system: catches "consumer read the wrong field name." Validator: catches "model returned wrong-shape JSON." Prompt: reduces the rate of wrong-shape JSON at the source.

## How it works

### Move 1 — the mental model

You know how a `fetch()` returns `Response` and if the consumer calls `.json()` on a text-only response you get a parse error at runtime, not compile time — because the `Response` type is intentionally loose? Output mode is the same: the LLM boundary is loose by default (text-in, text-out), and every layer you add (fence delimiter, JSON parse, shape validator, type guard) is a step toward sharpening the contract.

```
  Output mode mismatch — the shape

  ┌── chain A output ──┐            ┌── chain B input ──┐
  │  actually emits:    │            │  expects:          │
  │  { conclusion,      │            │  { conclusion,     │
  │    evidence: [...], │  ★ MATCH ★ │    evidence: [...],│
  │    hypotheses… }    │            │    hypotheses… }   │
  └────────────────────┘            └───────────────────┘

  vs mismatch:

  ┌── chain A output ──┐            ┌── chain B input ──┐
  │  { conclusion,      │            │  { rootCause,      │
  │    evidence: [...], │   MISMATCH │    supportingData, │
  │    hypotheses… }    │─────────▶  │    ...}            │
  └────────────────────┘            └───────────────────┘

  → JSON.parse succeeds
  → consumer reads .rootCause → undefined
  → downstream crash or wrong render
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the model's prompt declares the emission format.**

`@aptkit/prompts/dist/src/recommendation.js:52-70`:

```
## Output

Return ONLY a JSON array in a json fenced block of at most 3 objects. Do NOT include an id field. The system assigns ids after validation.

Each object must have:

- title: string
- rationale: string
- bloomreachFeature: scenario | segment | campaign | voucher | experiment
- steps: string[]
- estimatedImpact: string OR { range: string, rangeUsd?: { low: number, high: number }, assumption: string }
- confidence: high | medium | low
- effort?: low | medium | high
- timeToSetUpMinutes?: number
- readResultInDays?: number
- prerequisites?: { label: string, satisfied: boolean }[]
- successMetric?: string

If you cannot propose grounded actions, return [].
```

Two things worth noting. First, the prompt is explicit about **format** (JSON array), **envelope** (in a `json` fenced block), and **shape** (the per-object schema). Nothing is left to inference. Second, `estimatedImpact` is *deliberately polymorphic* — string OR structured object. That polymorphism is a controlled output-mode allowance, and it's a bug-source-in-waiting if the consumer doesn't handle both shapes.

**Step 2 — the parser strips the envelope.**

`lib/mcp/validate.ts:3-13`:

```ts
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through to substring scan */ }
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error('no parseable json in agent output');
}
```

Fence-first parser (see `02-structured-outputs.md` for the full walkthrough). This catches the envelope-mismatch case where the model wraps the JSON in a fence or preface. If the parser succeeds, the result is `unknown` — no shape guarantees yet.

**Step 3 — the shape validator narrows.**

`lib/mcp/validate.ts:42-57`:

```ts
export function isRecommendationArray(v: unknown): v is Omit<Recommendation, 'id'>[] {
  return Array.isArray(v) && v.every((r) => {
    const x = r as any;
    // estimatedImpact may be the legacy string OR the richer { range, ... } shape
    const impactOk =
      typeof x.estimatedImpact === 'string' ||
      (!!x.estimatedImpact && typeof x.estimatedImpact === 'object' && typeof x.estimatedImpact.range === 'string');
    return !!x && typeof x === 'object'
      && typeof x.title === 'string'
      && typeof x.rationale === 'string'
      && FEATURES.includes(x.bloomreachFeature)
      && Array.isArray(x.steps)
      && impactOk
      && CONFIDENCE.includes(x.confidence);
  });
}
```

The comment on line 46 is the honest note: `estimatedImpact` accepts either shape. This is *both* the fix for the polymorphism *and* the seam where the bug moves downstream. The validator says "yes, this is a valid Recommendation." The consumer must still handle both cases.

```
  Comparison — validator handles polymorphism, consumer must too

  validator's job:                  consumer's job:
  "is this a valid Recommendation?" "render this Recommendation"

  handles: string OR object          must handle: string OR object
                                     via type-narrowing at render
```

**Step 4 — the consumer must handle polymorphism explicitly.**

`components/investigation/RecommendationCard.tsx` (representative snippet — real component has richer rendering):

```tsx
{typeof recommendation.estimatedImpact === 'string' ? (
  <span>{recommendation.estimatedImpact}</span>
) : (
  <span>
    {recommendation.estimatedImpact.range}
    {recommendation.estimatedImpact.rangeUsd && (
      <> (${recommendation.estimatedImpact.rangeUsd.low.toLocaleString()}
       – ${recommendation.estimatedImpact.rangeUsd.high.toLocaleString()})</>
    )}
  </span>
)}
```

The `typeof x === 'string'` check is the type-narrowing gate. Miss it — say a junior refactors and writes `recommendation.estimatedImpact.range` unconditionally — and the string case crashes at render with "cannot read property 'range' of undefined." This is exactly the output-mode-mismatch bug in production shape: schema drift over time (the original shape was string; the new shape is structured), consumer forgot to handle the legacy shape, boom.

**Step 5 — the specific bug in this codebase.**

Look at `parseAgentJson`'s fallback: substring-scan for `[` or `{`. If the model emits recommendations as a JSON *object* wrapped around an array (e.g. `{"recommendations": [...]}`) instead of a bare array, the substring scan returns the object, `isRecommendationArray` returns false, and the whole thing throws. This is one of the load-bearing tightness points — the prompt says "Return ONLY a JSON array," but under model drift (or a smart user injection), the model might return a wrapping object. The fix is either (a) tighten the prompt (already done), or (b) make the validator tolerant of the wrapping shape and unwrap it.

```
  The failure case at parseAgentJson

  model emits:      { "recommendations": [ ... ] }
      ↓
  parseAgentJson:   returns the object
      ↓
  isRecommendationArray:   Array.isArray(obj) → false
      ↓
  validator rejects → thrown error at boundary
```

Not a bug in this codebase's live use (the prompt discipline holds), but a real class of mismatch and a real reason validators exist.

**Step 6 — the eval catches drift.**

Every eval case's receipt writes the `recommendations` array. If the model starts emitting a wrapping object, the receipt's `recommendations` field ends up wrong-shape or throws at write time. Regression is visible immediately in the next eval run's summary block. This is the concrete mechanism by which output-mode mismatches are caught before production: the eval boundary reads the output the same way production does, so any output-mode drift shows up there first.

### Move 2 variant — the load-bearing skeleton

The kernel of preventing output mode mismatch is three moves:

```
  declare shape in prompt → validate at parse → narrow at consume
```

What breaks if you skip each:

- **Skip "declare shape in prompt"** — the model emits whatever feels natural for the last five tokens of prior context. Sometimes JSON, sometimes prose, sometimes JSON with a preface, sometimes an object with a `"result"` wrapper. The consumer catches one of these; the others crash.
- **Skip "validate at parse"** — the parser returns `unknown`; the consumer treats it as `Recommendation[]`. TypeScript is happy (you cast), runtime is not (you crash on `.forEach` of undefined).
- **Skip "narrow at consume"** — the validator accepts polymorphism (string OR object), and the consumer reads `.range` unconditionally. Crashes on the string case.

Hardening layered on top: exhaustive validation with something like Zod (catches nested shape mismatches), fuzz-testing the parser with malformed model outputs, adding output-mode assertions to the eval receipts.

### Move 3 — the principle

**The compiler is not defending your LLM boundary; the validator is.** Every field the model emits is text until proven otherwise, and "proven otherwise" is a runtime check. Mismatches are silent by default because JSON parsing succeeds on shape you didn't intend. The three-move discipline (prompt-declare, parse-validate, consume-narrow) is what makes the mismatches loud.

## Primary diagram

```
  Output mode mismatch — where each layer catches what

  ┌── the prompt ─────────────────────────────────────────────┐
  │  "Return ONLY a JSON array in a json fenced block"        │
  │  "estimatedImpact: string OR { range, rangeUsd?, ... }"    │
  │       ↑                                                   │
  │       reduces mismatch rate at the source                 │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌── model emits ─────────▼──────────────────────────────────┐
  │  text (could be JSON, could be JSON-in-fence, could be    │
  │        preface + JSON, could be object-wrapping-array)    │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌── parseAgentJson ──────▼──────────────────────────────────┐
  │  1. try fence match                                        │
  │  2. fallback: substring [ or { scan                        │
  │  3. throw on neither                                       │
  │       catches: envelope mismatch                          │
  │       misses: shape wrapping (object → array expected)    │
  └────────────────────────┬──────────────────────────────────┘
                           │ unknown
  ┌── isRecommendationArray ▼─────────────────────────────────┐
  │  Array.isArray(v) + per-item field checks                 │
  │  handles: polymorphic estimatedImpact (string OR object)  │
  │       catches: shape mismatch (wrong fields, wrong types) │
  │       misses: nothing beyond the fields it checks         │
  └────────────────────────┬──────────────────────────────────┘
                           │ Omit<Recommendation, 'id'>[]
  ┌── consumer narrows ────▼──────────────────────────────────┐
  │  typeof rec.estimatedImpact === 'string' ? ... : ...      │
  │       catches: the polymorphism the validator accepted    │
  │       misses: only what you forget to narrow              │
  └───────────────────────────────────────────────────────────┘
```

## Elaborate

Output mode mismatch is the specific class of bug that killed my confidence in "just cast the JSON as `any`" as a shortcut. It's the bug most likely to survive local testing (works on the three cases you tried), get caught in staging (fails on the tenth case), and slip into production (fails on a case you didn't anticipate). Every production LLM system has some version of this in its scar tissue.

The polymorphic `estimatedImpact` in this codebase is a good example of a *deliberate* mismatch — the schema evolved (string → structured), older data is still valid, the validator accepts both, and the consumer handles both. That's the healthy shape of schema evolution at the LLM boundary. The unhealthy shape is when nobody noticed the schema drifted and half the consumers still read `.estimatedImpact` as a string — which is what happens when the change ships without an eval that renders the field.

The Anthropic and OpenAI docs both hedge on this specifically: model outputs "should" be well-formed, but "may include additional whitespace or formatting." The docs are being polite. What actually happens: models drift emission style across versions, courteous models add prefaces, and Sonnet 4.6 today emits a slightly different shape than Sonnet 4.6 did last month. The only defense is the three-layer sandwich: prompt declares the shape, validator rejects malformed, consumer narrows what got through.

Related concepts:
- **Structured outputs** (`02-structured-outputs.md`) — the discipline this concept prevents the collapse of.
- **Single-purpose chains** (`06-single-purpose-chains.md`) — the boundaries where mismatches live.
- **Eval-driven iteration** (`05-eval-driven-iteration.md`) — how you catch drift before production.

## Interview defense

**Q: Someone changed the recommendation schema — `estimatedImpact` went from string to a structured object. What breaks and where?**

Anywhere in the codebase that reads `recommendation.estimatedImpact` as a string. If TypeScript is honest (the type is `string | { range, ...}`), the compiler catches it — the reader has to narrow via typeof or destructure. If someone cast to `any` or the type was inferred loosely, the code compiles fine and crashes at runtime when `.range` is undefined on a string. The fix in this codebase is at three layers simultaneously: the prompt says "string OR {range,...}", the validator (`isRecommendationArray` at `lib/mcp/validate.ts:42-57`) accepts either, and the consumer (`RecommendationCard`) narrows with a typeof check. Miss any layer and drift breaks something.

```
  Migration seam — schema change lands at three layers

  prompt:     "estimatedImpact: string OR { range, ...}"
       │
       ▼  validator accepts both
  isRecommendationArray → tolerates both shapes
       │
       ▼  consumer narrows
  RecommendationCard → typeof check → renders per shape
       │
       ▼  eval catches regressions across model versions
  eval/receipts/*.json → next run shows shape drift
```

Anchor: `isRecommendationArray` at `lib/mcp/validate.ts:42-57`, specifically the `impactOk` block on line 46.

**Q: The model started wrapping its recommendations in `{"recommendations": [...]}` instead of a bare array. Do you fix the prompt or the validator?**

Both, with priority on the prompt. The prompt is what shaped the model's emission and can shape it back — one clear line ("Return the bare array, not wrapped in an object") often fixes it. The validator fix is secondary: I'd make it tolerant of the wrapping shape (unwrap if the object has a `.recommendations` key) so future drift doesn't crash. Prompt-fixes are cheap but slow to verify (need an eval run). Validator-fixes are the safety net. Ship both.

```
  Two layers of fix — prompt tightens, validator tolerates

  prompt fix: "Return the bare array, not wrapped"
       reduces mismatch rate at the source
       needs eval to verify

  validator fix: unwrap { recommendations: [...] } if present
       tolerates the drift that the prompt doesn't stop
       ships as a safety net
```

**Q: What's the load-bearing part people forget?**

The polymorphism. Everyone remembers to write a validator. What people forget: the validator can accept multiple shapes for the same field, and the consumer must handle every shape the validator accepts. If the validator's decision tree is broader than the consumer's decision tree, you have a validated-but-still-broken output. The fix: whenever the validator adds a polymorphism (the `estimatedImpact: string | {range,...}` in this codebase), audit every consumer that reads that field and add the narrowing.

Anchor: the `estimatedImpact` handling — validator at `lib/mcp/validate.ts:46`, consumer's typeof check at `components/investigation/RecommendationCard.tsx`.

## See also

- `02-structured-outputs.md` — the contract this concept enforces.
- `05-eval-driven-iteration.md` — how you catch mismatches before production.
- `06-single-purpose-chains.md` — the boundaries between chains where mismatches happen.
