# Structured outputs

**Industry standard** · output contract, defensive parser, type guard

## Zoom out — where the structured-output boundary lives

Four of blooming's five agents (monitoring, diagnostic, recommendation, intent) end their work by emitting a structured value the rest of the app consumes typed: `Anomaly[]`, `Diagnosis`, `Recommendation[]`, `Intent`. The query agent doesn't — it streams prose. That asymmetry is the whole point of this concept: structured output is one tool in the kit, not the default for every LLM call.

```
  Zoom out — model-output boundary, four agents go through it

  ┌─ Model layer ────────────────────────────────────────────┐
  │  Anthropic returns assistant.content[]                    │
  │    — text blocks (possibly with a ```json fence)          │
  │    — tool_use blocks (handled separately by the loop)     │
  └──────────────────────────┬───────────────────────────────┘
                             │  finalText (raw string)
  ┌─ ★ VALIDATOR LAYER ★ ───▼───────────────────────────────┐ ← we are here
  │  lib/mcp/validate.ts                                      │
  │    parseAgentJson()      ← defensive parser               │
  │    isAnomalyArray()      ← type guard                     │
  │    isDiagnosis()         ← type guard                     │
  │    isRecommendationArray()  ← type guard                  │
  └──────────────────────────┬───────────────────────────────┘
                             │  typed value (or null)
  ┌─ App layer ─────────────▼────────────────────────────────┐
  │  state stores · UI cards · markdown export                │
  └──────────────────────────────────────────────────────────┘
```

## Zoom in

The pattern: declare the output schema in the prompt, parse defensively at the boundary, validate against a type guard, fail safe on mismatch. blooming doesn't use OpenAI-style JSON mode (Anthropic SDK doesn't have a one-to-one equivalent and the tools-with-schemas approach changes the conversation contract); it uses the *prompt-declared schema + ```json fence + defensive parse + type guard* pattern. That pattern works across providers and degrades gracefully when the model wraps JSON in markdown by accident — which is the specific bug this concept exists to teach.

## Structure pass

**Layers.** Three: the *contract declaration* (the `## Output` section of the system prompt), the *string-to-JSON parse* (`parseAgentJson`), and the *JSON-to-typed-value guard* (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`).

**Axis traced — trust.** Hold one question constant: *what's trusted at each layer?*

```
  Axis = trust — what does each layer believe about the input?

  ┌─ contract declaration ────────────────────────────────────┐
  │   trusts: NOTHING about the runtime input                  │
  │   asserts: "the model SHOULD emit this shape"              │
  └──────────────────────────┬───────────────────────────────┘
                             │
  ┌─ defensive parser ──────▼────────────────────────────────┐
  │   trusts: input is text; might contain a fence; might be  │
  │           raw JSON; might be JSON inside other prose       │
  │   asserts: "I'll extract SOMETHING parseable, or throw"    │
  └──────────────────────────┬───────────────────────────────┘
                             │
  ┌─ type guard ────────────▼────────────────────────────────┐
  │   trusts: input is `unknown`                              │
  │   asserts: "either this is a valid Anomaly[], or it's     │
  │            not — narrow the type or return false"          │
  └──────────────────────────────────────────────────────────┘
```

**Seams.** Two. The first is the model → parser seam, where the contract becomes a string and the parser is the only thing standing between you and a 500. The second is the parser → type-guard seam, where you've successfully parsed JSON but the shape might still be wrong (the model returned the right structure for *yesterday's* schema, or it dropped a required field). Both seams need to fail safe; neither should throw all the way up to the UI.

## How it works

### Move 1 — the four-step pattern

You know how a typed REST API works: the server says "I'll return JSON matching this schema," the client parses, validates against a runtime check (like `zod` or a hand-rolled guard), and degrades gracefully if the validation fails. Structured outputs from an LLM are the same shape, except the "server" is a language model and the schema is declared in prose.

```
  Structured-output pattern — four steps, each independently fallible

  step 1: DECLARE in the prompt
    ┌──────────────────────────────────────────┐
    │ ## Output                                 │
    │ Return ONLY a JSON array... wrapped in    │
    │ a ```json fenced block:                   │
    │ [{ "metric": "...", "category": "..." }]  │
    └──────────────────────────────────────────┘
                  │
  step 2: PARSE defensively
    ┌──────────────────────────────────────────┐
    │ const text = finalText;                   │
    │ // strip ```json ... ``` if present       │
    │ // try JSON.parse                         │
    │ // fall back to substring scan            │
    └──────────────────────────────────────────┘
                  │
  step 3: VALIDATE with a type guard
    ┌──────────────────────────────────────────┐
    │ if (!isAnomalyArray(parsed)) return [];   │
    │ // parsed is now narrowed to Anomaly[]    │
    └──────────────────────────────────────────┘
                  │
  step 4: DEGRADE on failure
    ┌──────────────────────────────────────────┐
    │ // empty array, not exception             │
    │ // route still emits `done` event         │
    │ // UI renders an empty state, not 500     │
    └──────────────────────────────────────────┘
```

### Move 2 — the contract declaration

The `## Output` section of `lib/agents/legacy-prompts/monitoring.md` is the contract. Three things land here: the format wrapper (```json fence), the array shape, and the field-by-field rules. Read it as the schema you wrote in a comment for your colleague — except the colleague is the model and the comment is the contract.

```
  lib/agents/legacy-prompts/monitoring.md (lines 70-96, the contract)
  ┌────────────────────────────────────────────────────────────┐
  │ Return ONLY a JSON array of anomaly objects, at most 10    │
  │ items, sorted by severity..., wrapped in a ```json fenced  │
  │ block:                                                      │
  │                                                             │
  │ [                                                           │
  │   {                                                         │
  │     "metric": "purchase_revenue",                           │
  │     "category": "revenue_drop",                             │
  │     "scope": ["global"],                                    │
  │     "change": { "value": 30.0, "direction": "down", ... }, │
  │     "severity": "critical",                                 │
  │     "impact": "Revenue down 30%...",                        │
  │     "evidence": [{ "tool": "...", "result": {...} }]        │
  │   }                                                         │
  │ ]                                                           │
  │                                                             │
  │ Field rules:                                                │
  │ - `category` — REQUIRED. the checklist `id` ...             │
  │ - `metric` — short snake_case name ...                      │
  │ - `severity` — `"critical"` (>20%...), `"warning"` ...      │
  └────────────────────────────────────────────────────────────┘
```

Two things to notice. **The example IS the few-shot** — there's no separate few-shot block; the worked example doubles as the format pin (concept #8 covers why this works). **The field rules are not redundant with the example** — they constrain what the model can put *in* the slots (severity must be one of four strings, `change.direction` must be `"up"` or `"down"`), which is the part the type guard later enforces.

### Move 2 — parseAgentJson, the defensive parser

Here's the parser at `lib/mcp/validate.ts:3-13`:

```
  lib/mcp/validate.ts:3-13 — parseAgentJson
  ┌──────────────────────────────────────────────────────────┐
  │ export function parseAgentJson(text: string): unknown {   │
  │   const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i); │ ← step A: strip fence
  │   const candidate = (fence ? fence[1] : text).trim();     │
  │   try { return JSON.parse(candidate); }                   │ ← step B: try clean parse
  │   catch { /* fall through to substring scan */ }          │
  │   const start = candidate.search(/[[{]/);                 │ ← step C: find first [ or {
  │   const end = Math.max(candidate.lastIndexOf(']'),        │
  │                        candidate.lastIndexOf('}'));       │
  │   if (start >= 0 && end > start) {                        │
  │     return JSON.parse(candidate.slice(start, end + 1));   │ ← step D: re-parse
  │   }                                                       │
  │   throw new Error('no parseable json in agent output');   │ ← only if all 3 attempts fail
  │ }                                                         │
  └──────────────────────────────────────────────────────────┘
```

Three attempts in order, each more lenient than the last. **Step A** handles the documented case — the model put JSON inside a ```json fence as the prompt asked. **Step B** is the happy path — strip the fence, parse clean. **Step C and D** are the bug-catcher: when the model wrote a sentence before the JSON ("Here are the anomalies I found:\n\n```json\n[...]\n```") and forgot the fence, the substring scan finds the first `[` and the last `]` and parses what's between.

This is the *courteous-model bug* in code. The internet advice says "use JSON mode." Production says "use JSON mode AND assume the model will sometimes politely wrap the schema-conformant JSON in a markdown code fence or chatty preamble, AND have a parser that survives it." The substring scan looks ugly. It is. It also saves the briefing from failing whenever the model is feeling chatty.

### Move 2 — the type guard

The parser returns `unknown`. The type guard narrows it to `Anomaly[]`. Here's `isAnomalyArray` at `lib/mcp/validate.ts:17-27`:

```
  lib/mcp/validate.ts:17-27 — isAnomalyArray
  ┌──────────────────────────────────────────────────────────┐
  │ export function isAnomalyArray(v: unknown): v is Anomaly[]│
  │ {                                                          │
  │   return Array.isArray(v) && v.every((a) =>                │
  │     !!a && typeof a === 'object' &&                        │
  │     typeof (a as any).metric === 'string' &&               │
  │     Array.isArray((a as any).scope) &&                     │
  │     !!(a as any).change && typeof (a as any).change.value  │
  │                              === 'number' &&               │
  │     ((a as any).change.direction === 'up' ||               │
  │      (a as any).change.direction === 'down') &&            │
  │     typeof (a as any).change.baseline === 'string' &&      │
  │     SEVERITIES.includes((a as any).severity)               │
  │   );                                                       │
  │ }                                                          │
  └──────────────────────────────────────────────────────────┘
```

The `v is Anomaly[]` return type is TypeScript's narrowing operator — after `if (isAnomalyArray(x))`, the compiler knows `x` is `Anomaly[]` in that branch. Two things this guard does *not* do that you might expect a schema validator (Zod, Pydantic) to do: it doesn't return the validation errors (just true/false), and it doesn't strip extra fields. Extra fields pass through to the UI — that's deliberate for newer optional fields (`history`, `aov`, etc.) so older snapshots still validate against newer types.

The discipline here: the guard checks the load-bearing fields, the ones the UI absolutely needs to render. Optional enrichments are not checked because their absence is fine; their wrongness is fine too (they just won't render). This is a deliberate choice — a stricter guard would reject more output, but the failure mode (no card rendered, user sees empty state) is worse than the failure mode of lax validation (extra fields silently ignored).

### Move 2 — degradation, the missing fourth step

Read the call-site of `parseAgentJson` in the legacy monitoring agent (`lib/agents/monitoring-legacy.ts:128-136`):

```
  // lib/agents/monitoring-legacy.ts:128-136
  let parsed: unknown;
  try {
    parsed = parseAgentJson(finalText);
  } catch {
    return [];                              // ← parse failed → empty array
  }
  if (!isAnomalyArray(parsed)) return [];   // ← shape failed → empty array
  return [...parsed]
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
    .slice(0, 10);
```

Both failure modes degrade to `[]`. The route still streams a `done` event. The UI renders "no anomalies found" not "500 server error." This is the contract the rest of the app depends on: the monitoring agent always returns an `Anomaly[]`, possibly empty, never throws. The user sees an empty state, not a crash.

### Move 2 — when to NOT use structured output

The query agent is the counter-example. It answers free-form questions in prose:

```
  // lib/agents/legacy-prompts/query.md:46-50
  ## Output
  Give a clear, concise answer in plain prose — a few sentences;
  you may use short markdown bullets. Cite the key numbers you
  found. If you couldn't get the data, say so plainly. No JSON
  shape is required — just the answer text.
```

There's no `parseAgentJson`, no `isQueryAnswer` guard, no type narrowing. The route streams the text straight to the UI. Why? Because the consumer (a chat panel) is built for prose, the question is open-ended ("what's the conversion by country?" vs "give me the recent purchase count"), and forcing JSON would either limit the answer or require a schema that's expressive enough to cover any answer — which is just prose with extra steps.

The rule: structured output where the consumer is code, prose where the consumer is a human. Four of blooming's five agents have code consumers (state stores, card components). One has a human consumer. That's the split.

### Move 3 — the principle

Structured output from an LLM is a contract that lives in three places — declared in the prompt, parsed defensively, validated by a type guard — and degrades to a safe empty value on mismatch. The contract is enforced *at the boundary*, not by trusting the model. Anything that crosses the model-output seam without going through all four steps is a bug waiting to ship.

## Primary diagram

```
  Structured-output pipeline — model out to typed in

  ┌─ MODEL ────────────────────────────────────────────────────┐
  │  Anthropic returns:                                         │
  │    response.content[]                                        │
  │      └─ TextBlock("Here you go:\n\n```json\n[...]\n```")    │
  └────────────────────────────────┬───────────────────────────┘
                                   │  text blocks joined → finalText
  ┌─ PARSE (lib/mcp/validate.ts:3) ▼───────────────────────────┐
  │  parseAgentJson(finalText):                                 │
  │    1. /```(?:json)?...```/   — strip fence                  │
  │    2. JSON.parse(candidate)  — happy path                   │
  │    3. substring scan + parse — chatty-preamble fallback     │
  │    throws if all 3 fail                                     │
  └────────────────────────────────┬───────────────────────────┘
                                   │  unknown
  ┌─ GUARD (lib/mcp/validate.ts:17)▼───────────────────────────┐
  │  isAnomalyArray(parsed):                                    │
  │    Array.isArray && every(a => required fields present     │
  │      && severity ∈ {critical, warning, info, positive}     │
  │      && change.direction ∈ {up, down})                     │
  │  narrows unknown → Anomaly[]                                │
  └────────────────────────────────┬───────────────────────────┘
                                   │  Anomaly[] | empty array
  ┌─ DEGRADE (call-site) ──────────▼───────────────────────────┐
  │  try { parsed = parseAgentJson(finalText) }                 │
  │  catch { return [] }                                        │
  │  if (!isAnomalyArray(parsed)) return [];                    │
  │  return parsed.sort(...).slice(0, 10);                      │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The four-step pattern (declare → parse → validate → degrade) is provider-neutral. Anthropic doesn't have OpenAI's `response_format: { type: 'json_object' }` mode and doesn't have Google's typed-output mode; what it does have is reliable adherence to a prompt-declared schema. The pattern in this codebase works because the four-step discipline doesn't depend on provider features — it depends on treating the model output as `unknown` and proving it's the shape you wanted.

When providers ship JSON mode (OpenAI did first, then Google), the temptation is to think "I can skip the parser and the guard now." You can't. JSON mode guarantees the output parses as JSON; it doesn't guarantee the shape matches your schema. You still need the type guard. The mode buys you one layer of confidence (parse will succeed), not two.

The other thing to know: tool-calling can be used as a structured-output mechanism, and it's stricter than prompt-declared JSON. When the model emits a `tool_use` block, the SDK validates the `input` against the tool's `inputSchema`. blooming uses tool-calling for *side effects* (querying MCP), not for *output shape* — the agents emit their final answer as text, not as a synthetic "return_answer" tool call. That's a deliberate choice: it keeps the conversation contract simple (every agent's final assistant turn is text-only) and lets the same code path serve agents that want streaming text (query) and agents that want structured output (the other four).

Hamel Husain's writing on evals (eugeneyan.com aggregates a lot of the same ground) has a recurring theme that lands here: *test the boundary, not the brain*. The model is opaque; the boundary is observable. The type guards in `lib/mcp/validate.ts` are the boundary, and any test that wants to verify "the monitoring agent produces good anomalies" has to verify them at that boundary, not by reading the agent's mind.

## Interview defense

**Q: Walk through the courteous-model bug. What's the failure mode and what does the fix look like?**

A: The model is asked to return JSON in a ```json fence. Most of the time it does. Sometimes — especially after a prompt update that adds prose-style instructions ("be concise," "explain your reasoning") — it gets chatty and prepends "Here are the anomalies I found:" before the fence. Or it forgets the fence entirely and emits the JSON with a trailing "Let me know if you need anything else!" Naive `JSON.parse(finalText)` throws on both. The fix is the substring scan in `parseAgentJson` (lib/mcp/validate.ts:9-12): after the fence-strip and clean parse both fail, find the first `[` or `{` and the last `]` or `}`, slice between, parse. Recovers ~95% of chatty outputs. The remaining ~5% (genuinely malformed JSON) hit the empty-array degrade. The UI shows "no anomalies"; the user retries; the on-call engineer sees the captured raw output in the next morning's log review.

```
  what I'd sketch:

  prompt asks for: ```json [...] ```
  model sends:     "Here you go:\n```json\n[...]\n```"   ← fence-strip handles
  model sends:     "Here you go:\n[...]\n"               ← substring-scan handles
  model sends:     "Sorry, I couldn't..."                ← throw → degrade to []
```

**Q: Why type guards instead of a schema library like Zod?**

A: Two reasons specific to this codebase. **Newer optional fields** — `Anomaly` has grown `history`, `aov`, `affectedCustomers` over time, and older committed snapshots in `lib/state/demo-*.json` need to validate against the newer type. A strict schema library that rejects unknown fields or requires every declared field would either reject the demo snapshots or force a migration on every type change. The hand-rolled guard checks only the load-bearing fields the UI needs. **Failure mode preference** — when the model returns a slightly-off shape (extra fields, missing optional), the guard lets it through and the UI renders what it can. With Zod the call-site would have to choose between strict (reject and show empty) and `.partial()` (allow anything), and "allow anything" defeats the point. The guard is the goldilocks middle.

```
  guard contract:

  required & load-bearing  ─►  checked, narrows the type
  optional & enriching     ─►  not checked, renders if present
  extra & unknown          ─►  passed through, ignored

  failure shape: false (caller chooses fallback)
```

## See also

- [01-anatomy.md](./01-anatomy.md) — where the `## Output` contract sits in the prompt template
- [07-output-mode-mismatch.md](./07-output-mode-mismatch.md) — the JSON-vs-prose split this concept depends on
- [10-self-critique.md](./10-self-critique.md) — the one-turn recovery that fires when the type guard returns false
- [12-prompt-injection-defense.md](./12-prompt-injection-defense.md) — why a strict output schema is itself a defense
