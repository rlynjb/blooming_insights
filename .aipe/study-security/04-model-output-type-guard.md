# Model-output type guard

**Type-guard validation at the LLM-output trust boundary** (Language-agnostic primitive).

## Zoom out — where this concept lives

The model's text or tool-result output crosses into trusted code at this seam. The type guard is the gate: model output is untrusted until a runtime check says otherwise.

```
  Zoom out — where the validator sits

  ┌─ Anthropic API (provider) ─────────────────────────┐
  │  Claude — emits text + tool_use blocks              │
  └──────────────┬──────────────────────────────────────┘
                 │ hop 3 reply: text + tool_use
                 ▼
  ┌─ Next.js routes (trusted boundary) ────────────────┐
  │  agent loop                                         │
  │  ┌──────────────────────────────────────────────┐   │
  │  │  ★ parseAgentJson + isAnomalyArray ★        │ ◄─┼── we are here
  │  │  + isDiagnosis + isRecommendationArray        │   │
  │  └──────────────────────────────────────────────┘   │
  │     │                                                │
  │     ▼                                                │
  │  in-memory state · UI render                         │
  └──────────────────────────────────────────────────────┘
```

The principle: model output is hostile until a type guard says otherwise. The model can hallucinate fields, swap types, emit prose where JSON is expected, or smuggle prompt-injected content. The guard is the chokepoint that says "either it has the shape I require, or it doesn't enter."

## Structure pass

**Axes:** trust (model output is untrusted; in-memory state is trusted), failure (a malformed result becomes `[]` or `null`, not a crash; not a render of garbage either), control (the validator decides what proceeds).

**Layers:** model → SDK envelope → defensive parser → type guard → typed state.

**Seam:** the load-bearing seam is the parser/guard pair. Strip either and the downstream code sees `unknown` shaped like garbage; downstream renderers and persisters trust the type assertion that's no longer earned.

**Axis flip at the seam:** before the guard, the value is `unknown`. After the guard's positive return, TypeScript narrows it to `Anomaly[]` / `Diagnosis` / `Omit<Recommendation, 'id'>[]`. The narrowing IS the trust decision — the compiler enforces it from there on.

## How it works

### Move 1 — the mental model

A type guard is **a runtime check that earns a static type**:

```
  Pattern — type guard shape

  function isThing(v: unknown): v is Thing {
    return v !== null
        && typeof v === 'object'
        && /* check every load-bearing field */ ;
  }

  // caller:
  const raw: unknown = parse(modelText);
  if (isThing(raw)) {
    use(raw);   // TS knows raw is Thing here
  } else {
    fallback(); // raw is still unknown here
  }
```

It's the bridge between "the model emitted some JSON" and "I can call `.metric` on it." Without the bridge, the code either (a) trusts the model and crashes when it lies, or (b) defensively checks every field at every use site, scattering the trust decision.

### Move 2 — the step-by-step walkthrough

#### Defensive parser (`parseAgentJson`)

The model is told to emit JSON. It frequently doesn't — it wraps JSON in markdown fences, adds prose around it, emits `prefix { ... } suffix`. The parser tries three strategies in order:

```ts
// lib/mcp/validate.ts:3-13
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

**Three strategies, in order of preference:**
1. **Markdown-fence extraction.** Look for a ```` ```json ```` block; pull the body.
2. **Direct parse.** Hope the text is already clean JSON.
3. **Substring scan.** Find the first `[` or `{` and the last `]` or `}`; parse the slice between.

The parser is intentionally permissive — the model's output is unpredictable, and forcing it into one strict format means burning agent budget on retries when the second turn just adds different framing. The next gate (the type guard) is where strictness lives.

**What breaks if the parser is missing:** every caller must implement its own fence-stripping. The duplicated code drifts; the strictest one becomes the bottleneck, the loosest one becomes the bug.

#### Typed default (`FALLBACK`)

The pattern across the legacy agents: parse → guard → fall back to a typed default on failure. From `monitoring-legacy.ts`:

```ts
// lib/agents/monitoring-legacy.ts:129-136 (paraphrased shape)
let parsed: unknown;
try {
  parsed = parseAgentJson(finalText);
} catch {
  return [];   // typed default: empty Anomaly[]
}
if (!isAnomalyArray(parsed)) return [];
return parsed;
```

The typed default is the safety net — when the model emits garbage or the guard rejects, the downstream code sees `[]` (a valid empty `Anomaly[]`) instead of `unknown`. The UI renders "no anomalies" rather than crashing or showing partial junk.

**What breaks if the fallback is missing:** the parse error or the guard failure has to be handled at every call site. Worse, a missing fallback in a render path means "no model output → blank UI / spinner forever." The fallback says "if I can't trust it, treat it as empty."

#### `isAnomalyArray`

The deepest guard — `Anomaly[]` has the most required structure:

```ts
// lib/mcp/validate.ts:17-27
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

It checks: array? Every element an object with `metric: string`, `scope: array`, `change.value: number`, `change.direction: 'up'|'down'`, `change.baseline: string`, `severity: one of the four enums`. Anything else returns false. The model can add fields freely (forward compatibility); it can't omit or break the required shape.

**Load-bearing parts and what breaks if removed:**
- `Array.isArray(v)` — without it, a single object slips through as a 1-element "array" via `Object.values`.
- `SEVERITIES.includes(a.severity)` — without it, the UI renders a "warning" badge for a model-emitted `severity: "<script>"` (which can't run, but does break the layout).
- The `change.direction` literal check — without it, an unknown direction becomes an unknown arrow glyph.

#### `isDiagnosis` and `isRecommendationArray`

Same shape, smaller schemas:

```ts
// lib/mcp/validate.ts:29-35
export function isDiagnosis(v: unknown): v is Diagnosis {
  if (!v || typeof v !== 'object') return false;
  const d = v as any;
  return typeof d.conclusion === 'string'
    && Array.isArray(d.evidence)
    && Array.isArray(d.hypothesesConsidered);
}
```

Recommendations have the union-membership check on `bloomreachFeature` and the optional-or-rich `estimatedImpact` (the schema migrated from a string to a `{range, ...}` object; the guard accepts both for backward compatibility with older snapshots):

```ts
// lib/mcp/validate.ts:42-57
export function isRecommendationArray(v: unknown): v is Omit<Recommendation, 'id'>[] {
  return Array.isArray(v) && v.every((r) => {
    const x = r as any;
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

Note the schema-evolution gesture — `impactOk` accepts the old string and the new object. Type guards are where schema migrations are absorbed.

### Move 2.5 — current state vs target state

The guards exist in two places — `lib/mcp/validate.ts` (the canonical) and `lib/agents/legacy-validate.ts` (duplicated for legacy). Both are called from the legacy classes only:

```
  Validation wiring — Phase A (today) vs Phase B (target)

  ┌─ Phase A (today) ──────────────────────┐  ┌─ Phase B (target) ──────────────────────┐
  │  Legacy classes:    parse + guard       │  │  Legacy classes:    parse + guard        │
  │  AptKit classes:    SDK type assert     │  │  AptKit classes:    parse + guard at the │
  │                     (toBloomingX)       │  │                     boundary too         │
  │                                          │  │                                          │
  │  Effective on live: type assertion only │  │  Effective on live: validated at boundary│
  └──────────────────────────────────────────┘  └──────────────────────────────────────────┘
```

The legacy paths run the guards; the live AptKit paths don't. The AptKit SDK returns `DiagnosticDiagnosis` and `MonitoringAnomaly[]` as typed objects — but the type is a structural assertion at the TypeScript level, not a runtime check. If AptKit's own internals trust the model, the typed return is just a renamed `unknown`.

The `toBloomingDiagnosis` / `toBloomingAnomaly` adapters bridge between AptKit types and Blooming types — but they're identity coercions:

```ts
// lib/agents/diagnostic.ts:47-49
function toBloomingDiagnosis(diagnosis: DiagnosticDiagnosis): Diagnosis {
  return diagnosis;   // type assertion, not a runtime check
}

// lib/agents/monitoring.ts:111-116
function toBloomingAnomaly(anomaly: MonitoringAnomaly): Anomaly {
  return {
    ...anomaly,
    category: anomaly.category as CategoryId | undefined,
  };
}
```

**Migration cost:** add a `validate.ts`-style guard call inside each `toBloomingX` function; on failure, fall back to the same typed default the legacy path uses (`[]` / `null` per agent). No prompt change.

### Move 3 — the principle

**Type guards earn types at runtime.** Strong static typing doesn't help against data that came from outside the type system — model output, deserialized JSON, network payloads. The runtime check is where the static guarantee is paid for. The pattern compounds: every `unknown` that crosses an external seam should pass through a guard before being typed; every guard rejection should land on a typed default so callers never branch on it. The combination — parse → guard → typed default — turns hostile inputs into a closed type system.

## Primary diagram

```
  Model-output validation — full path through one agent loop

  ┌─ Anthropic API ──────────────────────────────────────┐
  │  reply: { content: [ { type: 'text', text }, ... ] } │
  └────────────────────┬─────────────────────────────────┘
                       │ SDK envelope
                       ▼
  ┌─ Agent loop ─────────────────────────────────────────┐
  │  finalText = concat(text blocks)                      │
  │                                                       │
  │              ┌────────────────────────────┐           │
  │              │ parseAgentJson(finalText)  │           │
  │              │  1. fence extract          │           │
  │              │  2. direct JSON.parse      │           │
  │              │  3. substring scan         │           │
  │              └────────┬───────────────────┘           │
  │                       │                                │
  │              parsed: unknown                           │
  │                       │                                │
  │              ┌────────▼───────────────────┐           │
  │              │ isAnomalyArray(parsed)?    │           │
  │              │  - Array.isArray           │           │
  │              │  - per-element field check │           │
  │              │  - SEVERITIES literal      │           │
  │              └────────┬───────────────────┘           │
  │           yes ◄───────┘────────► no                   │
  │            │                       │                   │
  │            ▼                       ▼                   │
  │      narrowed: Anomaly[]       FALLBACK = []          │
  │            │                       │                   │
  │            ▼                       ▼                   │
  │   ┌─────────────────────────────────────────┐         │
  │   │ in-memory state (lib/state/insights.ts) │         │
  │   │ UI render (components/feed)             │         │
  │   └─────────────────────────────────────────┘         │
  └───────────────────────────────────────────────────────┘

  (legacy path today; the AptKit path skips parse + guard)
```

## Elaborate

The pattern is **TypeScript user-defined type predicates** (`v is T`) layered on a defensive parser. Other languages have analogues — Rust's `serde` strict decoding, Python's Pydantic `BaseModel`, Zod's `safeParse` (the obvious upgrade path for this code: Zod schemas would consolidate the three guards into one declaration with built-in error messages and would handle the legacy-vs-new `estimatedImpact` shape via a union).

The deeper design: **trust at the boundary, not the type system.** TypeScript types are a compile-time fiction at runtime — `as Anomaly[]` is a noop. The guards are where the fiction becomes reality. A codebase that asserts types without runtime checks has the same correctness as untyped code, with worse ergonomics (because the compiler stops warning).

The historical drift this codebase is in the middle of: the migration to `@aptkit/core` moved most agent loops into a typed SDK that *appears* to return safe types. The appearance is load-bearing — the team is trusting AptKit's internals to validate before returning. Whether that trust is earned depends on AptKit's own implementation, which is outside this repo. Re-running the guard at the boundary is cheap insurance and is what the legacy code did.

**Related industry concepts:**
- Type-driven development — types as design, with runtime gates at every external boundary.
- Parse, don't validate — Alexis King's framing: the gate doesn't merely *check* the shape, it *narrows* the type.
- Zod / io-ts / runtypes — TypeScript libraries that do this declaratively.

## Interview defense

**Q: Why a runtime check if TypeScript already types the field?**
**A:** The TypeScript type is a compile-time fiction. At runtime the value is whatever the model emitted. `as Anomaly[]` is a noop; it lies as readily as the model does. The guard is what makes the type real — it earns the narrowing with an actual check. The load-bearing part most people forget is that the guard's return type IS the trust decision: from `isAnomalyArray(v): v is Anomaly[]` returning true, the compiler propagates `Anomaly[]` everywhere downstream. Skip the guard, and every downstream `a.metric` is undefined-when-the-model-misbehaves.

```
  static type     compile-time guarantee
  type guard      runtime guarantee
  → narrowing turns one into the other
```

**Q: Why a defensive parser? Why not require strict JSON from the model?**
**A:** Models drift. The prompt says "emit JSON only"; the model emits ```` ```json {...} ``` ```` half the time, raw `{...}` the other half, occasionally with a "Sure! Here's the JSON:" prefix. Strict requirement means burning a retry turn (which costs latency and Bloomreach rate-limit budget) on framing differences that don't change the data. The parser absorbs the framing; the guard enforces the data. The split keeps strictness where it matters.

**Q: What's the load-bearing part of the guard people forget?**
**A:** The literal-union check (`SEVERITIES.includes(...)`, `FEATURES.includes(...)`). Without it, the model can return `severity: "URGENT"` or `bloomreachFeature: "drop_database"`, the guard passes (it's a string), and the UI breaks downstream rendering. Literal-union enforcement is what makes the guard match the *narrowed* type — `Severity` isn't `string`, it's `'critical' | 'warning' | 'info' | 'positive'`. The guard must check both the type and the values.

**Q: Why a typed default instead of a thrown error?**
**A:** Streaming UI. A throw at this layer would abort the SSE/NDJSON stream and leave the UI staring at an error panel. The typed default lets the agent emit a partial result and the UI render "no anomalies this run" — degraded, not broken. The thrown error is logged server-side; the user-facing surface stays calm.

## See also

- `03-per-agent-tool-allowlist.md` — the sibling control on the *input* boundary (tool list given to the LLM).
- `05-secret-redaction.md` — the sibling output-boundary control on the *log* path.
- `audit.md` § 3 (Input validation), § 7 (LLM and agent security).
- `lib/mcp/validate.ts` — the canonical guards.
- `lib/agents/legacy-validate.ts` — the duplicate that follows the legacy path.
- `test/mcp/validate.test.ts` — the round-trip + edge-case suite.
