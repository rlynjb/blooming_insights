# 03 · type-guard-trust-boundary

**Defensive parsing + structural validation** · Industry standard
(parse-don't-validate / type-guarded deserialization)

## Zoom out — where this lives

Claude returns strings. The route needs typed objects. Between those
two facts sits the most-often-attacked seam in any LLM app: **what
happens when the model returns malformed, truncated, or wrong-shape
JSON?**

```
  Zoom out — the third trust boundary

  ┌─ Provider ────────────────────────────────────────────────────┐
  │ Bloomreach MCP server                                          │
  └──────────────────────┬─────────────────────────────────────────┘
                         │  tool_use_result (JSON in MCP envelope)
                         ▼
  ┌─ Service (Anthropic side) ────────────────────────────────────┐
  │ Claude                                                         │
  │  └─ emits final assistant message: a STRING, maybe with        │
  │     ```json fences, maybe with trailing prose, maybe truncated │
  └──────────────────────┬─────────────────────────────────────────┘
                         │  Anthropic SDK response.content[].text
                         ▼
  ┌─ Service (our route) ─────────────────────────────────────────┐
  │ ★ parseAgentJson + type guard + FALLBACK ★                     │ ← we are here
  │  • parseAgentJson  → tolerant string→unknown                   │
  │  • isAnomalyArray  / isDiagnosis / isRecommendationArray       │
  │  • FALLBACK constant when the shape doesn't match              │
  └──────────────────────┬─────────────────────────────────────────┘
                         │  typed value (Anomaly[] / Diagnosis / …)
                         ▼
  ┌─ UI ──────────────────────────────────────────────────────────┐
  │ React (JSX auto-escape on every render path)                  │
  └────────────────────────────────────────────────────────────────┘
```

The pattern: **never let an unparsed string flow into a typed sink.**
The route stays alive even when the model returns nonsense.

## Structure pass

  → **Layers.** Three: the *raw response string* layer, the *parsed
    `unknown`* layer (after `parseAgentJson`), and the *typed value*
    layer (after the type guard). Each layer narrows the trust.

  → **Axis to hold constant: "how typed is this value, and what's
    the consequence of trusting it?"**

    ```
      altitude              type          consequence of trusting
      ───────────────       ───────       ─────────────────────────
      Claude's response     string        could be literally anything
      after parseAgentJson  unknown       valid JSON, no shape claim
      after isAnomalyArray  Anomaly[]     safe to .map() / .filter() /
                                          send to UI as cards
    ```

    The whole point of the boundary: don't skip altitudes.

  → **Seams.** Two load-bearing joints:
    - **string ↔ unknown** (`parseAgentJson`, `lib/mcp/validate.ts:3-13`).
      Tolerates fences, prose, partial garbage — fails loudly if no
      JSON candidate exists.
    - **unknown ↔ T** (per-shape guards `isAnomalyArray`,
      `isDiagnosis`, `isRecommendationArray`,
      `lib/mcp/validate.ts:17-57`). Returns `boolean` while narrowing
      the type, so the call site reads `if (!isAnomalyArray(v))
      return FALLBACK`.

## How it works

### Move 1 — the mental model

You know how `JSON.parse(req.body)` would crash your server if the
client sent `'{invalid'`? Same problem at the model boundary, with
extra failure modes: the model can wrap JSON in markdown fences, write
a paragraph after the JSON, hallucinate a field with the wrong type,
or return an empty string after a tool error. The pattern is "parse
defensively, then *prove* the shape before you trust it."

```
  the pattern — three layers, two narrowings

  ┌─ raw model output ──────────────────────────────────┐
  │ "```json\n[{\"metric\":\"…\",…}]\n```\nDone."        │
  └─────────────────────────┬───────────────────────────┘
                            │  parseAgentJson
                            │  (strip fence, parse JSON)
                            ▼
  ┌─ unknown ───────────────────────────────────────────┐
  │ [{ metric: "…", scope: […], change: {…}, … }]        │
  │ (it's *some* JSON value, but TypeScript can't say    │
  │  what shape)                                         │
  └─────────────────────────┬───────────────────────────┘
                            │  isAnomalyArray(v)
                            │  (predicate: returns v is Anomaly[])
                            ▼
  ┌─ Anomaly[] ─────────────────────────────────────────┐
  │ now safe to .map(anomalyToInsight) and stream as    │
  │ insight events                                       │
  └─────────────────────────────────────────────────────┘
```

This is "parse, don't validate" — Alexis King's name for the same
shape. The idea: don't write `validate(x) ? useTypedX : reject`; write
`parse(x) -> Maybe<TypedX>`, where after parse the type system
*guarantees* what you have. TypeScript type predicates (`v is T`) are
how JS expresses that.

### Move 2 — the step-by-step walkthrough

#### a · the defensive parser (`parseAgentJson`) — tolerant string-to-unknown

The model wraps JSON in fences. It writes "Here's your data:" before
the JSON. It writes "Hope that helps!" after. It might split a string
across two messages and the assembled buffer contains both. Three
falls in order: fence → direct parse → substring scan.

```
  the parse ladder — three attempts, fail loudly only at the end

  input string
        │
        ▼
  ┌─ attempt 1: ```fence``` ─────────────────────────────┐
  │ match /```(?:json)?\s*([\s\S]*?)```/i                 │
  │ if found: candidate = fence body                     │
  │ else:     candidate = the whole input                │
  └──────────┬───────────────────────────────────────────┘
             │  JSON.parse(candidate.trim())
             ▼
  ┌─ attempt 2: direct parse ────────────────────────────┐
  │ success → return value                                │
  │ throw   → fall through                                │
  └──────────┬───────────────────────────────────────────┘
             │
             ▼
  ┌─ attempt 3: substring scan ──────────────────────────┐
  │ find first '[' or '{'                                 │
  │ find last  ']' or '}'                                 │
  │ JSON.parse(slice between them)                       │
  └──────────┬───────────────────────────────────────────┘
             │  still no parse?
             ▼
       throw new Error('no parseable json in agent output')
```

Real code (`lib/mcp/validate.ts:3-13`):

```ts
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);    // ← attempt 1: strip fence
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); }                          // ← attempt 2: direct
  catch { /* fall through to substring scan */ }
  const start = candidate.search(/[[{]/);                        // ← attempt 3: scan
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error('no parseable json in agent output');
}
```

What breaks if removed: drop attempt 1 → the most common case
(Claude wrapping JSON in ```` ```json `````) immediately fails the
direct parse. Drop attempt 3 → a model response like "I'll return
[{...}] now" with prose around the JSON fails parsing. Keep only
attempt 2 → ~30% of real responses crash the route.

Return type is `unknown` *on purpose*. Returning `any` would let the
caller skip the type guard and TypeScript wouldn't catch it. `unknown`
forces the next step.

#### b · the type-guard predicate — `v is Anomaly[]`

TypeScript's type predicate syntax: a function that returns `boolean`
but whose signature says "if I return true, treat the input as `T`."
The call site benefits: `if (!isAnomalyArray(v)) return FALLBACK;`
narrows `v` to `Anomaly[]` for the rest of the function.

```
  the predicate shape — structural, field-by-field

  isAnomalyArray(v) checks:
    Array.isArray(v)                                ← it's an array
    && every element:
       ├─ is a non-null object
       ├─ has metric: string
       ├─ has scope: array
       ├─ has change.value: number
       ├─ has change.direction: 'up' | 'down'
       ├─ has change.baseline: string
       └─ has severity: one of the 4 known severities
```

Real code (`lib/mcp/validate.ts:17-27`):

```ts
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

What breaks if removed: drop the `SEVERITIES.includes` check → the
model can write `severity: "URGENT"` and the route happily renders an
unknown severity in the UI (probably renders as a missing CSS class,
visible-but-broken). Drop the `typeof === 'object'` check → a `null`
or primitive sneaks past `Array.isArray(v)` element-wise checks and
throws on the first property access downstream. The skeleton: prove
every field the downstream actually reads, type-by-type.

Three guards in this style (`lib/mcp/validate.ts`):
  → `isAnomalyArray` — the monitoring agent's output
  → `isDiagnosis` — the diagnostic agent's output
  → `isRecommendationArray` — the recommendation agent's output

Each is the *exact* shape the route needs at the seam — not more,
not less. The Recommendation guard even handles a legacy + current
shape for `estimatedImpact` (`:46-49`), accepting either a string or
`{ range, ... }`, because the data evolved.

#### c · the typed default (`FALLBACK`) — what runs when the shape doesn't match

A type guard returns `boolean`; the call site decides what to do on
false. The pattern in this repo is "swap in a typed `FALLBACK`
constant and continue the loop." That's how the route survives a
single bad model response without taking down the request.

Real code (`lib/agents/diagnostic-legacy.ts:14-16`, `100-103`):

```ts
const FALLBACK: Diagnosis = {
  conclusion: '…',
  evidence: [],
  hypothesesConsidered: [],
  // … typed-shape stand-in
};

// …in the call site…
const parsed = isDiagnosis(maybe) ? maybe : null;
const diag = parsed ?? FALLBACK;
```

(The current AptKit-shaped agents have moved this pattern inside the
adapter; the legacy files at `lib/agents/diagnostic-legacy.ts:16` and
`lib/agents/base-legacy.ts:266` are the canonical readable
documentation of the trust seam in this repo.)

What breaks if removed: drop the FALLBACK → `null` flows into the UI
and crashes the render path on the first `diagnosis.conclusion` read.
The whole point is that the *next* request from the user shouldn't
fail just because the model went off the rails this once.

#### d · the natural-language answer — React handles it

For free-form answers (the QueryAgent's NL response), there's no JSON
to validate. The protection is at the *render* layer:
`{answer}` inside JSX auto-escapes any HTML / script tags. No
`dangerouslySetInnerHTML` in the answer path — verified by
`grep -rn dangerouslySetInnerHTML components app` returning no hits.

```
  the render path — JSX expression auto-escapes

  ┌─ Claude returns ─────────────────────────────────────┐
  │ "Revenue is down 38% in <script>alert(1)</script>"   │
  └─────────────────────────┬────────────────────────────┘
                            │  fetch → AgentEvent → setAnswer
                            ▼
  ┌─ StreamingResponse.tsx:218 ──────────────────────────┐
  │ <div>{answer}</div>                                   │
  │ React auto-escapes < > & " → entity references       │
  └─────────────────────────┬────────────────────────────┘
                            ▼
  ┌─ rendered HTML ──────────────────────────────────────┐
  │ <div>Revenue is down 38% in                          │
  │   &lt;script&gt;alert(1)&lt;/script&gt;</div>        │
  └──────────────────────────────────────────────────────┘
```

This is what "auto-escape" buys you for free — but it's worth knowing
*because* future code that switches to a markdown renderer (which
many LLM UIs do) loses this protection unless the renderer sanitizes
HTML.

### Move 3 — the principle

Treat model output exactly like user input: **string until proven
otherwise, never let an unproven value into a typed sink.** Type
predicates are the language-level expression of that. The same
discipline applies to any external string source — webhook payloads,
URL parameters, file contents, environment variables. The pattern
transfers; the guard names change. (Zod, Yup, io-ts, ArkType — they
all build the same shape with better ergonomics; the hand-rolled
version here is what those libraries compile to.)

## Primary diagram

```
  the full third-boundary flow — one tour, every gate labelled

  ┌─ MCP tool result ────────────────────────────────────────┐
  │ JSON envelope from Bloomreach                            │
  └─────────────────────────┬────────────────────────────────┘
                            │
                            ▼
  ┌─ Claude (agent loop iteration) ──────────────────────────┐
  │ reads result, decides next action OR emits final message │
  └─────────────────────────┬────────────────────────────────┘
                            │  final assistant message (string)
                            ▼
  ╔═══ TRUST BOUNDARY 3 ═══════════════════════════════════╗
  ║                                                          ║
  ║  parseAgentJson(text)                                    ║
  ║   ├─ strip ```json fence                                 ║
  ║   ├─ try JSON.parse                                      ║
  ║   └─ scan for [{…}] / {…} substring                      ║
  ║                            │ unknown                     ║
  ║                            ▼                             ║
  ║  isAnomalyArray(v)        OR  isDiagnosis(v)             ║
  ║   ├─ Array.isArray                                       ║
  ║   ├─ each item: shape + types match                      ║
  ║   └─ enum-valued fields in the known set                 ║
  ║                            │ boolean (narrowing)         ║
  ║              true  ───────►├◄─────── false               ║
  ║              │             │             │               ║
  ║              ▼             │             ▼               ║
  ║       typed value          │        FALLBACK constant    ║
  ║       (Anomaly[],          │        (typed empty/        ║
  ║        Diagnosis, …)       │         placeholder shape)  ║
  ║                            │                             ║
  ╚════════════════════════════╪═════════════════════════════╝
                               │  same downstream type, either way
                               ▼
  ┌─ Service (rest of route) ────────────────────────────────┐
  │ anomalyToInsight / saveInvestigation / etc.              │
  └─────────────────────────┬────────────────────────────────┘
                            │ Insight / Diagnosis / Recommendation
                            ▼
  ┌─ NDJSON stream ──────────────────────────────────────────┐
  │ events: insight | diagnosis | recommendation | done      │
  └─────────────────────────┬────────────────────────────────┘
                            ▼
  ┌─ UI ─────────────────────────────────────────────────────┐
  │ JSX expression auto-escape on every text render path     │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The phrase "parse, don't validate" comes from Alexis King's 2019 post
about Haskell, but it generalizes everywhere: the work of validation
should *narrow the type* of the value, not just produce a `bool`
alongside the still-untyped value. TypeScript's `v is T` type
predicates compile to a runtime `boolean` but inform the type checker;
that's how `if (!isAnomalyArray(v)) return …` lets the rest of the
function treat `v` as `Anomaly[]`.

Adjacent libraries:
  → **Zod** — `z.array(z.object({ metric: z.string(), … })).safeParse(v)`
    returns `{ success: true, data: Anomaly[] }` or
    `{ success: false, error }`. Same shape, less boilerplate, plus
    auto-derived TypeScript types.
  → **Anthropic's tool use** — when you define a tool with an
    `input_schema`, the SDK validates Claude's arguments against the
    schema *before* invoking your handler. That's the same boundary,
    one layer in.

For prompt-injection: this boundary doesn't *stop* prompt injection
(which would manifest as Claude calling an inappropriate tool, or
emitting deceptive content). It bounds the *blast radius*: a
prompt-injected response that returns `{evil:true}` is rejected at
`isDiagnosis` and replaced with `FALLBACK`. The damage from
"the model emitted weird stuff" is bounded to "this request returned
the fallback." Pair this with the read-only tool allowlist in
`04-read-only-tool-whitelist.md` for the full picture.

## Interview defense

### Q1. "Why not just use `JSON.parse` and trust the model's structured output mode?"

Anthropic's structured output (tool use with `input_schema`) is
*great* — it validates the model's tool *arguments* before invoking
the handler. But the *final assistant message* in the agent loop is
not tool input; it's free-form text the model emits when it decides
it's done. That message can be JSON-shaped (the prompt asks for it),
prose-shaped, fenced-JSON-shaped, or anything else. `JSON.parse` on
its own dies on the markdown fence Claude uses in ~half the calls.
`parseAgentJson` is the tolerant front-end; the type guards are the
shape-enforcing back-end. Together they're "what structured output
gives you for tool args, but for the final message."

**One-line anchor:** "Structured output covers tool *args*; the
agent's final *message* is still free-form. Parse it tolerantly,
then prove the shape."

### Q2. "What stops Claude from returning a prompt injection that calls a destructive tool?"

```
  the layered defense — three controls, in order

  ┌─ 1. tool allowlist ─────────────────────────────────┐
  │ lib/mcp/tools.ts — no write/delete tool exists       │
  │ in any agent's allowlist. The model literally        │
  │ cannot ask for one.                                  │
  └─────────────────────────────────────────────────────┘
  ┌─ 2. type-guarded output ────────────────────────────┐
  │ if the model returns a "fake tool call" in JSON,     │
  │ isAnomalyArray / isDiagnosis / isRecommendationArray │
  │ reject the shape and fall back.                      │
  └─────────────────────────────────────────────────────┘
  ┌─ 3. JSX auto-escape ────────────────────────────────┐
  │ if injected content survives as natural-language     │
  │ text, React escapes it on render.                    │
  └─────────────────────────────────────────────────────┘
```

This boundary (parse + guard + fallback) is **layer 2**. Layer 1
(`04-read-only-tool-whitelist.md`) is the bigger lever — by
construction, the model can only call read tools. Layer 3 (auto-
escape) catches anything that flows into the UI as text.

**One-line anchor:** "Three layers — the tool allowlist makes destructive
calls impossible, the type guard rejects malformed shapes, the JSX
escape catches HTML in text. Each is the answer to a different prompt
injection."

### Q3. "What's the cost of FALLBACK silently swallowing model failures?"

It's real. A pattern of falling back means real bugs in the prompt or
the model could appear as "the agent always returns the same empty
diagnosis." The mitigations in this repo:

  → **Logging.** The route logs the per-phase timing
    (`recordPhase('diagnostic_investigate', …)` in
    `app/api/agent/route.ts:283`) so you can see if the agent ran but
    produced FALLBACK.
  → **NDJSON stream visibility.** The user sees every tool call in
    the StatusLog panel; a FALLBACK conclusion paired with no real
    tool calls is an obvious signal something's off.
  → **Test fixtures.** Real responses from prior runs are committed
    to `test/fixtures/` and the type guards are unit-tested against
    them — so when the model's output drifts, the test catches it
    before prod does.

If this app grew, the next step would be metric-counting FALLBACK
firings per agent per day and alerting on a spike.

**One-line anchor:** "Real cost. Mitigated by per-phase timing logs,
the StatusLog visibility, and fixture-driven guard tests; the next
step is a FALLBACK-fired counter."

## See also

  → `04-read-only-tool-whitelist.md` — the matching control on the
    *input* side: the agent's tool set is curated so it can't call
    a destructive tool even if it wanted to.
  → `audit.md` § lens 3 (input-validation-and-injection) and § lens 7
    (llm-and-agent-security) for the wider context.
  → `study-testing/` — the fixture-driven test pattern that keeps
    these guards honest as the model drifts.
