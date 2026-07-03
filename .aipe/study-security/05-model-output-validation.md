# 05 — model-output-validation

**Industry name(s):** Model-output gating; structured-output validator;
LLM-response-to-app-state seam. Type: Industry standard (in AI systems).

## Zoom out — where this concept lives

Between the Anthropic model (untrusted output) and the app's state (the
`Anomaly` / `Diagnosis` / `Recommendation` types that drive UI rendering
and persistence) sits a validator seam. The model is powerful, plausible-
sounding, and wrong just often enough to require a gate.

```
  Zoom out — the model→state seam

  ┌─ Provider (Anthropic) ─────────────────────────────┐
  │  claude-sonnet-4-6 · returns text w/ JSON in a code │
  │  fence, or freeform prose that CLAIMS to be json    │
  └────────────────────┬───────────────────────────────┘
                       │  raw string
  ┌─ agents/{monitoring,diagnostic,recommendation}.ts ─▼┐
  │  parseAgentJson + isAnomalyArray | isDiagnosis |    │
  │  isRecommendationArray                              │
  │  ★ THIS SEAM ★  ← we are here                        │
  └────────────────────┬───────────────────────────────┘
                       │  narrowed shape (or throw)
  ┌─ Service (app state) ▼────────────────────────────┐
  │  putInsights · saveInvestigation                   │
  └────────────────────┬───────────────────────────────┘
                       │
  ┌─ UI (browser) ─────▼──────────────────────────────┐
  │  InsightCard · RecommendationCard                  │
  └───────────────────────────────────────────────────┘
```

Every rendered anomaly, diagnosis, or recommendation crossed this seam.
Model → text → parse → guard → typed object → state → UI.

## Structure pass

**Layers.** model → raw text → parser (extract JSON) → type guard → app
type → state → UI.

**Axis: trust — where does the LLM's plausible-but-wrong output stop being
authoritative?**

```
  One axis — trust — flips at the guard

  model text:  HOSTILE — plausible-sounding, might be malformed,
                         might have wrong enum values, might
                         hallucinate fields
      │
  parseAgentJson: extracts JSON from a possibly-fenced string
                  (fail → throw)
      │
  ─────── isAnomalyArray / isDiagnosis / isRecommendationArray ───────
                                          ★ trust flips here ★
      │
  narrowed:    TRUSTED shape (Anomaly[] | Diagnosis | Recommendation[])
      │
  state:       persisted and rendered without further validation
```

**Seams that matter.**

  → `parseAgentJson` (`lib/mcp/validate.ts:3-13`) — the extractor. Handles
    code-fenced JSON, unfenced JSON, and prose-with-JSON-inside.
  → `isAnomalyArray` / `isDiagnosis` / `isRecommendationArray`
    (`lib/mcp/validate.ts:17-57`) — the guards. Enforce enum membership on
    the fields that drive UI branching (severity, direction, feature,
    confidence).

## How it works

Two moves: get the JSON out of whatever the model returned; then verify
the extracted value matches the expected shape.

### Move 1 — the mental model

You know how `JSON.parse` throws on any invalid JSON? That's the wrong
tool alone here — the model returns JSON *inside* prose or fences half
the time. `parseAgentJson` is a fenced-first, then unfenced, then
substring-scan extractor.

```
  The extractor kernel — try the tightest form first, fall back progressively

  input: raw model text
      │
      ▼
  ┌─ try code fence ────────────────────┐
  │  match ```json ... ``` or ``` ... ```│
  │  → JSON.parse the inside             │
  └──────────────┬──────────────────────┘
                 │ fail
                 ▼
  ┌─ try whole string ──────────────────┐
  │  → JSON.parse the trimmed input      │
  └──────────────┬──────────────────────┘
                 │ fail
                 ▼
  ┌─ try substring ─────────────────────┐
  │  find first [ or { and last ] or }   │
  │  → JSON.parse that slice             │
  └──────────────┬──────────────────────┘
                 │ fail
                 ▼
             throw
```

Three failure modes progressively — model returns pure JSON (fast path),
model returns JSON with prose around it (substring scan handles), model
returns something unparseable (throw).

Then the type guards check the extracted shape.

### Move 2 — the step-by-step walkthrough

**parseAgentJson — extractor.**

```ts
// lib/mcp/validate.ts:3-13
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error('no parseable json in agent output');
}
```

Trace it on `"Sure! Here's the anomaly list: [ { ...} ]. Hope that helps!"`:

```
  Execution trace — prose-wrapped JSON

  step 1: fence regex match?  no
          candidate = "Sure! Here's ... helps!" (trimmed)
  step 2: JSON.parse(candidate)  → throws (not JSON)
  step 3: candidate.search(/[[{]/) → index of '[' (~40)
          candidate.lastIndexOf(']') → some index
          lastIndexOf('}') → -1 or earlier
          start >= 0 && end > start? yes
  step 4: JSON.parse(candidate.slice(start, end + 1))  → [{...}] ✓
```

Trace on ` ```json\n[ {...} ]\n``` `:

```
  Execution trace — fenced JSON

  step 1: fence regex match?  yes
          candidate = "[ {...} ]" (inside the fence, trimmed)
  step 2: JSON.parse(candidate) → [{...}] ✓
```

**isAnomalyArray — array + per-element shape.**

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

The load-bearing checks — the ones that would break UI if wrong:

  → `severity` must be one of four exact strings. The UI branches on this to
    color-code the dot (critical=red, warning=amber, info=blue, positive=
    green). An out-of-range value would render as a broken chip.
  → `change.direction` must be `'up' | 'down'`. Drives the arrow icon.
  → `change.value` must be a number. Drives the % chip and the prior-vs-now
    bar chart.

Every enum check is a hard gate. A hallucinated severity of `"medium"` (a
plausible-sounding value not in the enum) rejects the whole anomaly array,
returning it to the agent for retry — better than half-rendered chips.

**isDiagnosis — shallower.**

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

Three fields checked, none of the array elements' shapes verified. Why:
`Evidence` and `HypothesisConsidered` have string-heavy fields the UI
renders verbatim (`ReactMarkdown`-style) — a malformed sub-element renders
as ugly text, not as a crash. The tradeoff earned: fewer false rejections
against a model that gets the array shape right and the sub-shapes
slightly wrong sometimes.

**isRecommendationArray — enum-heavy, id-less.**

```ts
// lib/mcp/validate.ts:37-57
const FEATURES = ['scenario', 'segment', 'campaign', 'voucher', 'experiment'];
const CONFIDENCE = ['high', 'medium', 'low'];

export function isRecommendationArray(v: unknown): v is Omit<Recommendation, 'id'>[] {
  return Array.isArray(v) && v.every((r) => {
    const x = r as any;
    // estimatedImpact may be the legacy string OR the richer { range, ... } shape
    const impactOk =
      typeof x.estimatedImpact === 'string' ||
      (!!x.estimatedImpact && typeof x.estimatedImpact === 'object'
        && typeof x.estimatedImpact.range === 'string');
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

Two shape-migration accommodations:

  → `id` is intentionally validated as absent (the type is
    `Omit<Recommendation, 'id'>[]`). The agent proposes; the system assigns
    ids downstream. Validating id would either mean "reject valid agent
    output" or "trust ids the agent invented."
  → `estimatedImpact` accepts both legacy string and current object shape.
    Old committed demo snapshots have the string form; new ones have the
    richer form. Both must validate so older snapshots survive.

The enum gates are the same discipline as `isAnomalyArray` —
`bloomreachFeature` must be one of five, `confidence` must be one of three.
UI branches on both.

**Where the guards actually run.** The agent loop reads the model's final
message, calls `parseAgentJson` on it, then feeds the result into the
matching guard:

```
  Agent loop → validator seam

  monitoring:      parseAgentJson → isAnomalyArray       → Anomaly[]
  diagnostic:      parseAgentJson → isDiagnosis          → Diagnosis
  recommendation:  parseAgentJson → isRecommendationArray → Recommendation[]
```

On guard failure, the agent typically retries (up to a small budget). On
retry exhaustion, the request errors out with the last raw output logged —
but by that point, `redactSecrets` (see `06-secret-redaction-in-errors.md`)
has already stripped anything token-shaped from the string.

### Move 2 variant — the load-bearing skeleton

The kernel: **extract → guard → narrow → persist**. Each step catches a
different failure class.

  → Drop the extractor and prose-wrapped JSON never parses; every agent
    turn is a rejection.
  → Drop the guard's enum checks and hallucinated `severity: "medium"` or
    `bloomreachFeature: "workflow"` reach the UI, which branches on those
    values and renders broken chips or worse (silent fallthrough).
  → Drop the `Array.isArray` check on the outer type and a lone anomaly
    object passes `isAnomalyArray` accidentally when `.every` skips over
    non-arrays.
  → Drop the id-less accommodation and every recommendation array from
    the agent rejects because the agent (correctly) doesn't invent ids.

Hardening on top: the fenced-first extractor path (fast path for well-
behaved responses), the impact-shape backward-compat branch (old snapshots
still validate), retry-on-guard-failure at the agent loop layer.

### Move 3 — the principle

**Model output is not code — treat it like a network response from an
untrusted server.** The model is plausible-sounding, high-throughput, and
wrong just often enough that structural validation is not optional. The
right gate is at the boundary between "raw model output" and "app state
that drives rendering." Anywhere before that boundary is too early
(you're constraining the model unnecessarily); anywhere after is too late
(broken state has already reached the UI).

## Primary diagram

```
  Full picture — one agent turn from Anthropic to InsightCard

  ┌─ Anthropic (claude-sonnet-4-6) ────────────────────┐
  │  final message content:                            │
  │  "Based on the analysis:\n```json\n[{...}]\n```"    │
  └────────────────────┬───────────────────────────────┘
                       │  raw string
  ┌─ MonitoringAgent (lib/agents/monitoring.ts) ──────▼┐
  │  const raw = message.content[0].text;              │
  │                                                    │
  │  ┌─ parseAgentJson(raw) ─────────────────────────┐ │
  │  │  1. try fenced JSON  → hit                    │ │
  │  │  2. return parsed unknown                     │ │
  │  └──────────────────────┬────────────────────────┘ │
  │                         ▼                          │
  │  ┌─ isAnomalyArray(parsed) ──────────────────────┐ │
  │  │  Array.isArray? yes                           │ │
  │  │  every element:                               │ │
  │  │    typeof metric === 'string'? yes            │ │
  │  │    change.value: number? yes                  │ │
  │  │    change.direction in {up, down}? yes         │ │
  │  │    severity in SEVERITIES? yes                │ │
  │  │  → return true (narrows to Anomaly[])         │ │
  │  └──────────────────────┬────────────────────────┘ │
  │                         ▼                          │
  │  const anomalies: Anomaly[] = parsed;              │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ lib/state/insights.ts ▼──────────────────────────┐
  │  putInsights(sid, anomalies.map(anomalyToInsight)) │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ UI (InsightCard.tsx) ─▼──────────────────────────┐
  │  <SeverityDot severity={i.severity} />             │
  │  → branches on 'critical' | 'warning' | 'info'     │
  │  → color-codes safely (enum was gated)             │
  └───────────────────────────────────────────────────┘
```

## Elaborate

Where the pattern comes from: structured-output-with-schema-validation
is one of the oldest patterns in LLM apps — Guardrails (2023), Instructor
(2023-24), zod-integrated OpenAI SDK usage (also 2023). This repo's shape
is hand-written type guards, chosen because the types are shallow and
the app already types them in TypeScript.

Adjacent patterns:

  → **Schema-first (zod / io-ts).** Same discipline, more machinery. Auto-
    derives error messages; couples the type and the guard in one place.
    For a bigger surface it earns its dep cost; for four types it's overkill.
  → **Retry loop with guard.** When the guard fails, feed the parse error
    back to the model with "try again, here's what's wrong." Some agents
    do; this repo relies on the agent loop's natural retry (it doesn't
    hand back the specific validation error).
  → **Grammar-constrained decoding.** JSON-schema-forcing at the token
    level (server-side, model-side). The strongest available defense;
    not exposed by the Anthropic API surface this repo uses.

**Field-level trust, spelled out.**

  → **Enums (severity, direction, bloomreachFeature, confidence)** —
    strictly gated. Wrong value = reject.
  → **Numbers (change.value)** — type-checked. NaN and Infinity pass
    `typeof === 'number'` but would render weirdly; not currently rejected.
  → **Free-text (metric, conclusion, title, rationale)** — string check
    only; content trusted. Prompt-injection risk lives here (a
    hallucinated `rationale` containing HTML tags is escaped by React;
    a hallucinated `rationale` containing "click this suspicious link"
    is rendered as text and the user sees it).
  → **Arrays without element checks (evidence, hypothesesConsidered,
    steps)** — length checked, contents trusted. UI renders items as
    markdown strings.

The layering: strict at the choke points that drive UI branching (enums),
loose where the UI is a passive renderer (strings, arrays).

## Interview defense

**Q: Why type guards instead of zod?**

A: Four types, three fields each on average — the whole validate.ts file
is 57 lines. A schema library would double the LOC to derive what's
already inline, plus add ~50KB of runtime for edge functions. The
readability tradeoff also cuts the other way: `SEVERITIES.includes(x.severity)`
reads exactly like the compile-time union, so anyone editing the code
sees the runtime check right next to the type. Zod would add indirection
for no clear gain at this size. At 40+ fields I'd flip; not here.

Anchor: `lib/mcp/validate.ts:15` (SEVERITIES) and `:17-27` (the guard).

**Q: The guard passes but the model still hallucinated a fake metric name.
What defends against that?**

A: Nothing at the validator layer — the metric string is user-facing text
that the UI renders verbatim. Structural validation defends against
malformed output; semantic validation (does this metric actually exist in
the workspace?) lives elsewhere. Two mitigations upstream: (1) the prompt
gives the model the workspace schema (via `schemaSummary` in
`lib/agents/monitoring.ts:19-60`), so the model is anchored to real event
names; (2) evidence entries reference tool calls the agent actually made,
so a hallucinated metric would have no evidence. Neither is a hard gate —
they're prompt-level defenses. The hard gate would be a downstream check:
"does this metric name appear in schema.events?" That's a design tradeoff
— strictness costs the agent flexibility to name derived metrics
(`purchase_conversion_rate` is not in the schema but is legitimate).

Anchor: `lib/mcp/schema.ts` (the schema shape) and
`lib/agents/monitoring.ts:19-60` (schemaSummary going into the prompt).

**Q: What breaks if the guard is stripped?**

A: The enum-branching UI code renders undefined states. Concrete example:
`SeverityDot` maps `severity` to a color; an out-of-range value passes
through the map and returns undefined, so the dot renders with no color
(browser default: no fill). `RecommendationCard`'s feature chip has five
icons; a sixth invented feature renders as a blank chip. `change.direction`
drives an up/down arrow; a non-enum value would render as neither, or as
the default fallthrough. None of these crash the app. All of them ship
visibly broken state to the user. The guard is the difference between
"agent output looks wrong" and "app looks broken."

Anchor: `lib/mcp/validate.ts:15, 25, 37-38` (all four enum lists).

## See also

- `04-server-side-config-validation.md` — same type-guard shape at the config layer
- `audit.md` §7 — the wider LLM/agent security picture, including the tool-scope regression
- `06-secret-redaction-in-errors.md` — what happens when the guard's error message flows to logs
