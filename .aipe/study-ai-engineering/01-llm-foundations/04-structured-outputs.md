# 04 — structured outputs

**Subtitle:** Lenient extract + runtime type guard · Project-specific (load-bearing)

## Zoom out, then zoom in

Every agent's *final* answer comes back as JSON. The model is asked to emit a
JSON array or object; Blooming extracts it leniently and then validates the
shape with a hand-written type guard. No schema mode, no JSON-mode flag, no
Zod, no tool-call-as-output trick — just `parseAgentJson` + `isAnomalyArray` /
`isDiagnosis` / `isRecommendationArray`.

```
  Zoom out — where the structured-output contract lives

  ┌─ Prompt (lib/agents/legacy-prompts/*.md) ─────────────┐
  │  "Return ONLY a JSON array … wrapped in a ```json     │
  │   fenced block"                                       │
  └────────────────────────┬──────────────────────────────┘
                           │
  ┌─ Agent loop (AptKit) ──▼──────────────────────────────┐
  │  final turn → content[0].text = "```json\n[…]\n```"   │
  └────────────────────────┬──────────────────────────────┘
                           │
  ┌─ ★ THIS CONCEPT ★  lib/mcp/validate.ts ───────────────┐ ← we are here
  │  parseAgentJson(text)  →  unknown                     │
  │  isAnomalyArray(v)    →  v is Anomaly[]               │
  │  isDiagnosis(v)       →  v is Diagnosis               │
  │  isRecommendationArray(v) → v is Omit<Recommendation,'id'>[]│
  └────────────────────────┬──────────────────────────────┘
                           │
  ┌─ NDJSON stream to UI ──▼──────────────────────────────┐
  │  { type: 'insight', insight } · { type: 'diagnosis' } │
  │  { type: 'recommendation', recommendation }           │
  └───────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — trust.** From the prompt's POV, the contract is
    *the model emits JSON in a fenced block*. From the route handler's POV,
    the contract is *parsed JSON that matches one of three shapes*. The
    boundary that converts "model said something" into "validated typed
    object" is `lib/mcp/validate.ts`. Everything above the seam trusts the
    type; everything below the seam trusts the string.

  → **Layers above and below:** above is the typed UI (`Insight[]`,
    `Diagnosis`, `Recommendation[]`); below is the model's free-form text
    output. The 58-line `validate.ts` file is the entire bridge.

  → **The load-bearing part:** the *lenient extract* in `parseAgentJson`.
    Most candidates write `JSON.parse(text)` and call it a day. The model
    sometimes wraps in fences, sometimes adds prose around the JSON,
    sometimes emits trailing whitespace. Lenient parse saves a retry every
    time the model deviates from the exact format.

## How it works

### Move 1 — the mental model

You know how `JSON.parse()` will throw on the slightest deviation? The
extractor here is a two-stage parse: try the strict version first, fall back
to "find the first `[` or `{` and the last `]` or `}` and parse what's
between them." It's the same shape as `try-narrow-then-broad` parsing in any
robust ingest pipeline.

```
  The two-stage parse

  text from model
       │
       ▼
  fence match?  ── yes ──►  parse fence contents
       │ no                       │
       ▼                          │
  parse whole text                │
       │                          │
       ├─── ok ──────────► unknown (return)
       │                          ▲
       ├─── throw                 │
       ▼                          │
  scan for [ or { and ] or }      │
       │                          │
       ▼                          │
  parse the substring  ───────────┘
       │
       ├─── ok ──► unknown (return)
       └─── throw  ──► "no parseable json"
```

Then the unknown gets handed to a type guard, which returns `v is Anomaly[]`
(etc.) — TypeScript's `is` narrowing means everything downstream is typed.

### Move 2 — the step-by-step walkthrough

**Stage 1 — extract.** `parseAgentJson` (`lib/mcp/validate.ts:3-13`):

```typescript
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

The walkthrough:

  → **Line 4:** match a ```` ```json ... ``` ```` fenced block. The `(?:json)?`
    makes the language tag optional — the prompt asks for `json` but the
    model sometimes drops it.

  → **Line 5:** if a fence matched, take its contents; otherwise take the
    whole text. `trim()` handles trailing whitespace which `JSON.parse` is
    fine with anyway but doesn't hurt.

  → **Line 6:** try `JSON.parse(candidate)` first — the happy path. When
    the model is well-behaved this is what runs.

  → **Lines 7-11:** the fallback. Scan for the first opening bracket or
    brace; find the last closing one; parse what's between. This catches
    cases like `Here is the JSON:\n[…]\n\nLet me know if you need…` —
    pure prose wrapping a JSON array.

  → **Line 12:** if nothing parsed, throw. The error message is what the
    route surfaces.

**Stage 2 — validate.** `isAnomalyArray` (`lib/mcp/validate.ts:17-27`):

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

What's being checked:

  → It's an array.
  → Every element is an object with a `metric` string.
  → `scope` is an array (contents not type-checked — they're string-shaped
    by convention but the guard is permissive).
  → `change` has `value: number`, `direction: 'up'|'down'`, `baseline: string`.
  → `severity` is one of the four enum values.

What's *not* checked:

  → `evidence[]` shape (optional in the type).
  → `impact` (optional, agent-emitted, runs through unchecked).
  → `history`, `category` (optional).

This is permissive on purpose. New optional fields land in `Anomaly` without
needing a guard update; older snapshots without the field still validate.

**The same shape repeats for `isDiagnosis` (line 29-35) and
`isRecommendationArray` (line 42-57).** The recommendation guard has one extra
wrinkle — `estimatedImpact` can be a legacy string OR the richer
`{ range, rangeUsd?, assumption }` object:

```typescript
const impactOk =
  typeof x.estimatedImpact === 'string' ||
  (!!x.estimatedImpact && typeof x.estimatedImpact === 'object' &&
   typeof x.estimatedImpact.range === 'string');
```

This is the "older snapshots still validate" rule made concrete. A demo
snapshot captured before the richer shape existed has `estimatedImpact: "30%
uplift"` — string. A new one has `{ range, rangeUsd, assumption }` — object.
Both pass.

**Where these get called.** Inside `@aptkit/core`. Blooming exports the type
guards from `lib/mcp/validate.ts`; AptKit's agent classes use them as the
final-turn validation gate. If the guard returns false, AptKit either retries
the model or throws — depending on the agent.

**Why not a schema-mode flag (Anthropic tool-use as output)?** Sonnet supports
forcing tool-call output as a structuring mechanism. Blooming doesn't use it
because:

  1. The agents *also* use tools for actual side effects (calling MCP). Mixing
     "tools as schema enforcement" with "tools as side-effects" in the same
     loop is muddier than just trusting the validator at the end.
  2. The output shapes already differ per agent. Each agent would need its
     own schema-tool definition; the validator is one file, three guards.
  3. The lenient extract is a strict superset of "JSON mode" — it handles
     fenced blocks, prose-wrapped JSON, and pure JSON without changing the
     model contract.

The tradeoff: when the model genuinely fails to emit valid JSON, we get a
runtime error instead of a guaranteed-shape response. In practice that's been
a parse error logged + retry, not a user-visible failure.

### Move 3 — the principle

**The validator is the contract, not the prompt.** Prompts drift; models
change; sampling adds variance. A runtime type guard at the seam between
"model output" and "typed application code" is what makes the rest of the
system durable. The prompt asks for a shape; the validator verifies it. When
the two disagree, the validator wins.

## Primary diagram

```
  The full extract + validate pipeline

  ┌─ Prompt asks for ```json [...] ``` ───────────────────┐
  │  (e.g. monitoring.md, recommendation.md)              │
  └──────────────────────┬────────────────────────────────┘
                         │ model emits content[0].text
                         ▼
  ┌─ parseAgentJson(text) — validate.ts:3-13 ─────────────┐
  │  1. match fenced block (optional 'json' tag)          │
  │  2. JSON.parse(fence or whole text)                   │
  │  3. on throw: scan [ or { … ] or }                    │
  │  4. JSON.parse(substring)                             │
  │  5. on throw: 'no parseable json in agent output'     │
  └──────────────────────┬────────────────────────────────┘
                         │ unknown
                         ▼
  ┌─ Type guard ──────────────────────────────────────────┐
  │  isAnomalyArray(v)        for MonitoringAgent.scan()   │
  │  isDiagnosis(v)           for DiagnosticAgent.invest()│
  │  isRecommendationArray(v) for RecommendationAgent     │
  │                                                       │
  │  PERMISSIVE: optional fields not checked              │
  │  STRICT: required scalar types + enum values checked  │
  └──────────────────────┬────────────────────────────────┘
                         │ v is Anomaly[] / Diagnosis / Recommendation[]
                         ▼
  ┌─ Typed UI / NDJSON wire ──────────────────────────────┐
  │  Insight (derived from Anomaly + UI metadata)         │
  │  Diagnosis (passes through)                           │
  │  Recommendation (id assigned post-validation)         │
  └───────────────────────────────────────────────────────┘
```

## Elaborate

The choice between "schema-mode at the API" vs "validator at the boundary" is
one of the recurring tension points in LLM application engineering.
Schema-mode buys you a hard guarantee (the API returns a parse-error or a
schema-conforming object); validator-at-boundary buys you flexibility (you can
ship new optional fields without ratcheting both ends).

Blooming picked validator-at-boundary because the data shapes were going to
evolve fast (Tier 1 enrichments in `Insight`: `revenueImpact`, `aov`,
`funnel`, `affectedCustomers`, `history`, `downstreamReady`, `category` — all
added incrementally, all optional). Schema-mode would have meant updating the
schema tool definition every time, plus rejecting older snapshots that don't
have the new field.

The `parseAgentJson` lenient-extract pattern is reusable across any
LLM-produces-JSON product. The exact regex (`/[[{]/` and `lastIndexOf`) is
naive but covers the failure modes that actually appear: prose prefix, prose
suffix, missing or extra fenced block, language tag dropped.

## Project exercises

### Exercise — add `tool_choice: { type: 'tool', name }` as an alternative path

  → **Exercise ID:** `study-ai-eng-04.1`
  → **What to build:** For the monitoring agent's final synthesis turn, define
    a `report_anomalies` tool whose `input_schema` matches `Anomaly[]`, and
    force the model to call it via `tool_choice: { type: 'tool', name:
    'report_anomalies' }`. The tool body is a no-op; the schema-constrained
    input *is* the validated output.
  → **Why it earns its place:** Demonstrates fluency with both patterns —
    you can speak to lenient-extract OR schema-tool, and have an opinion on
    when each wins. The interview answer "I tried both, here's the tradeoff"
    beats either standalone.
  → **Files to touch:** `lib/agents/monitoring.ts` (new branch), the AptKit
    `AnomalyMonitoringAgent` (would need a config flag upstream), test
    coverage in `test/agents/monitoring.test.ts`.
  → **Done when:** A feature-flagged code path runs the monitoring agent with
    schema-tool output, parsed as a tool call's input arg instead of via
    `parseAgentJson`. Both paths produce equivalent results on the demo
    fixtures.
  → **Estimated effort:** `1–2 days` (most of it is the AptKit upstream
    contribution).

### Exercise — add a Zod schema per validator and emit JSON Schema for the prompts

  → **Exercise ID:** `study-ai-eng-04.2`
  → **What to build:** Replace the hand-written type guards in
    `lib/mcp/validate.ts` with Zod schemas (`AnomalySchema.array()`,
    `DiagnosisSchema`, `RecommendationSchema.omit({id:true}).array()`).
    Generate JSON Schema from them and inject into the prompts so the model
    sees a machine-readable contract.
  → **Why it earns its place:** "How do you keep the prompt's contract in
    sync with the validator?" — the answer today is "by hand." Generated
    schema closes the gap.
  → **Files to touch:** `lib/mcp/validate.ts` (rewrite), `lib/mcp/types.ts`
    (Zod types), `lib/agents/legacy-prompts/*.md` (inject schema), tests.
  → **Done when:** `parseAgentJson` is followed by `schema.parse()` instead
    of an `is*` guard. Prompts include a JSON-Schema block derived from the
    same source.
  → **Estimated effort:** `1–2 days`

## Interview defense

**Q: How does blooming insights get reliable JSON out of Claude?**

```
  Two stages — extract leniently, validate strictly.

  model text
   │
   ▼
  parseAgentJson(text)     ← lib/mcp/validate.ts:3-13
   │  1. try fenced block parse
   │  2. fall back to whole-text parse
   │  3. fall back to substring-between-brackets parse
   ▼
  unknown
   │
   ▼
  isAnomalyArray(v)        ← lib/mcp/validate.ts:17-27
   │  type guard returns `v is Anomaly[]`
   ▼
  typed Anomaly[]
```

**Anchor line:** "Extract is permissive, validate is strict — that's how the
prompts stay loose without the application code seeing junk."

**Q: Why not schema-mode (tool-call as structured output)?**

Mainly because the shapes evolve fast and optional fields land monthly
(`Insight` gained `revenueImpact`, `aov`, `funnel`, `affectedCustomers`,
`history`, `downstreamReady`, `category` over the last few iterations). The
hand-written guards check what's *required* and ignore what's optional, so
older demo snapshots still validate. Schema-mode would mean ratcheting both
ends every time.

**Q: What's the load-bearing part of the validator?**

The fallback in `parseAgentJson` — the substring scan (`candidate.search(/[[{]/)`)
that runs when both the fenced-block parse and the whole-text parse throw.
That's the line that converts "model added a friendly intro and outro to the
JSON" from a hard failure into a successful parse. Drop it and the model gets
an entire retry every time it editorializes.

## See also

  → `01-what-an-llm-is.md` — the I/O model that produces the text
  → `03-sampling-parameters.md` — why default temperature is OK with this validator
  → `04-agents-and-tool-use/02-tool-calling.md` — the OTHER place JSON contracts live (input schemas, not output)
