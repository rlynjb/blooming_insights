# 02 · Structured outputs via tool calling and schemas

**Industry name:** *structured outputs* / *tool calling* / *JSON mode* · Industry standard

## Zoom out — where the shape gets enforced

The structured-output surface is a two-part story: the model boundary (where the provider constrains what the model can emit) and the app boundary (where your validator checks what actually arrived). In this repo, both exist. Draw them together.

```
  Zoom out — where the shape gets enforced

  ┌─ Agent layer ────────────────────────────────────────────┐
  │  DiagnosticAgent.investigate()                            │
  │    hands off to @aptkit/core, which drives the loop       │
  └────────────────────────┬─────────────────────────────────┘
                           │  tools[] passed at request time
  ┌─ Provider boundary ────▼─────────────────────────────────┐
  │  ★ THIS BLOCK ★                                            │ ← we are here
  │  Anthropic constrains tool_use blocks to the tool's        │
  │  input_schema (JSON Schema). Model cannot emit an          │
  │  invalid tool_use payload.                                 │
  └────────────────────────┬─────────────────────────────────┘
                           │  response.content flat map
  ┌─ App boundary ─────────▼─────────────────────────────────┐
  │  lib/mcp/validate.ts                                      │
  │    parseAgentJson() — strips fence, substring-scan fallback│
  │    isDiagnosis(), isRecommendationArray() — shape guard    │
  └───────────────────────────────────────────────────────────┘
```

## Zoom in — two enforcement points, one shape

The provider gives you structural guarantees. Tool inputs conform to a JSON Schema. But the *final* output — the diagnosis JSON at the end of the investigation — isn't a tool call in this codebase; it's the last assistant text block after the loop terminates. That output is *not* provider-schema-enforced. Which is why `lib/mcp/validate.ts` exists.

Two enforcement points, then. Structured *tool* calling for the intermediate steps. Structured *shape checking* on the final answer. Both matter. Blog posts usually teach only the first.

## Structure pass — layers, axis, seams

Trace one axis: *who is responsible for the shape being correct*, from the model outward.

- **Layer 1 — model.** The model chooses what tokens to emit.
- **Layer 2 — provider (Anthropic).** For `tool_use` blocks, the provider enforces the tool's `input_schema`. For plain text, it doesn't.
- **Layer 3 — SDK.** The Anthropic SDK returns `response.content` as a discriminated union of blocks. Type-safe at the TS boundary.
- **Layer 4 — adapter.** `AnthropicModelProviderAdapter.complete()` flat-maps `response.content` through `toModelContentBlock` at `lib/agents/aptkit-adapters.ts:112-119`. Text blocks stay text; tool-use blocks stay tool-use.
- **Layer 5 — validator.** `lib/mcp/validate.ts` — `parseAgentJson()` + `isDiagnosis()` / `isRecommendationArray()`. Runs on the *final* payload.

**The seam:** between provider-enforced structure (tool calls) and app-enforced structure (the final JSON). This is the load-bearing seam in the pattern — the reason validators still exist in a tool-calling world.

## How it works

### Move 1 — the shape

You've written a `fetch()` that expects JSON back. You know the pattern: server sends `Content-Type: application/json`, your code does `res.json()`, then you either trust the shape or you validate it with Zod / io-ts / a hand-rolled guard. Structured outputs is the same story, one layer up. The provider's "Content-Type" is `tool_use` (structural guarantee) or `text` (no guarantee). Your validator is the code that either trusts or checks.

```
  Pattern — structured output as a two-boundary problem

     model ───► [ tool_use ]  ── provider-enforced ─►  app trusts it
                     ▲
                     │  input_schema constrains what
                     │  the model can emit at all
                     │
     model ───► [ text     ]  ── nothing enforces  ─►  app validates it
                     │
                     └── parseAgentJson + isDiagnosis
                         at lib/mcp/validate.ts
```

Two paths. Different guarantees. Same reader has to know which one they're on.

### Move 2 — walking the enforcement points

#### The tool boundary (structural)

`AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:59-120` passes `params.tools = request.tools.map(toAnthropicTool)` on every call. `toAnthropicTool` at `:233-239` maps aptkit's `ModelTool` to Anthropic's `Tool` shape:

```
function toAnthropicTool(tool: ModelTool): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema as Anthropic.Messages.Tool['input_schema'],
  };
}
```

`input_schema` is JSON Schema. Anthropic uses it server-side to constrain what the model can emit as a `tool_use` block. The model literally cannot emit tokens that would produce an invalid `input`. This is the strong guarantee.

The tools themselves come from `BloomingToolRegistryAdapter.listTools()` at `lib/agents/aptkit-adapters.ts:130-136`, which passes through the MCP tools from `SyntheticDataSource` or the real Bloomreach MCP server. Their schemas are declared in TypeScript at `lib/agents/tool-schemas.ts` (definitions the MCP server publishes).

```
  Layers-and-hops — tool-use path

  ┌─ Agent ────────────┐
  │ investigate()       │
  └────────┬────────────┘
           │ tools[]
  ┌─ Adapter ──────────▼─┐
  │ toAnthropicTool()    │
  │ input_schema mapped  │
  └────────┬─────────────┘
           │ params.tools = [...]
  ┌─ Anthropic API ────▼─┐
  │ constrains tool_use  │  ← structural guarantee
  │ to input_schema      │
  └────────┬─────────────┘
           │ response.content
  ┌─ toModelContentBlock ▼┐
  │ discriminates:        │
  │  text │ tool_use      │
  └───────────────────────┘
```

#### The final-answer boundary (validator-enforced)

The last thing the diagnostic agent emits is not a tool call — it's assistant text containing a fenced JSON block. That text is not schema-enforced by Anthropic. The prompt at `lib/agents/legacy-prompts/diagnostic.md:60-82` asks for a specific shape. The model *usually* complies. Sometimes it doesn't.

`parseAgentJson()` at `lib/mcp/validate.ts:3-13`:

```
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

Three layers of forgiveness:

1. **Try to strip the ` ```json ` fence.** Most common shape.
2. **If no fence, try to parse raw.** Model dropped the fence.
3. **Substring scan for first `[`/`{` to last `]`/`}`.** Model prepended "Here's the analysis:" or appended a signoff paragraph.

Then `isDiagnosis()` at `:29-35` narrows the parsed value to the `Diagnosis` type:

```
export function isDiagnosis(v: unknown): v is Diagnosis {
  if (!v || typeof v !== 'object') return false;
  const d = v as any;
  return typeof d.conclusion === 'string'
    && Array.isArray(d.evidence)
    && Array.isArray(d.hypothesesConsidered);
}
```

Only three fields are checked here — the load-bearing ones. Anything else is optional. That's a deliberate call: strict validation on the final answer would reject usable outputs where the model added a helpful extra field.

`isRecommendationArray()` at `:42-57` is stricter — it checks `bloomreachFeature` is in the enum, `confidence` is in the enum, and the `estimatedImpact` union is one of the two allowed shapes. The stricter validation matches the higher-stakes output.

#### The Zod / Pydantic equivalent

This repo hand-rolls the type guards. In OpenAI-flavor Python code, the same pattern is Pydantic (`class Diagnosis(BaseModel): …`) or Zod (`z.object({...}).parse(raw)`) — either lets you say "coerce or throw" declaratively. In this repo the guards are terser but achieve the same thing. The pattern is: parse, validate, then trust downstream.

### Move 2 variant — the load-bearing skeleton

What's the smallest structured-output pattern still worth calling structured-output?

1. **Provider-side schema.** Drop it, and the model emits any JSON shape it feels like. Recovery is on you.
2. **Parse step.** Drop it, and downstream code sees a raw string and has to parse per-callsite. Errors scatter.
3. **Shape check.** Drop it, and a valid-JSON-but-wrong-shape output propagates. The chain works fine on runs 1-5, breaks in production run 47.
4. **Retry on schema fail.** Drop it, and one bad output halts the whole investigation.

The kernel is: schema + parse + shape check + retry. `@aptkit/core`'s `RubricJudge` (which we cite in `05-eval-driven-iteration.md`) makes retries visible — `rjResult.attempts.length` at `eval/run.eval.ts:312-323` records how many tries the judge took. When it hits `>1`, a schema fail happened silently.

Hardening layered on top: rich validation (Zod), typed clients, JSON Schema draft-2020 features, discriminated unions across output modes. None of that is the skeleton — it's polish.

### Move 3 — the principle

**Provider-side schema is the strong guarantee; app-side validator is the safety net.** Every serious LLM pipeline has both. The model boundary constrains what the model *can* emit for tool calls; the app boundary catches everything else — the model's final text response, the field the model added that you didn't ask for, the day the provider silently changes something. Don't trust one without the other. In 2026, "just use JSON mode" is a 60% answer.

## Primary diagram

```
  Structured output — the full recap

  MODEL side                          APP side
  ┌──────────────────────┐           ┌────────────────────────┐
  │ tool_use (structural │  ── loop ►│ trusted, no validator  │
  │ guarantee via        │           │ needed (input schema   │
  │ input_schema)        │           │ enforced provider-side)│
  └──────────────────────┘           └────────────────────────┘
  ┌──────────────────────┐           ┌────────────────────────┐
  │ final text with      │  ─ once ─►│ parseAgentJson()       │
  │ fenced JSON          │           │ (strips fence, substring│
  │                      │           │  fallback)             │
  │                      │           │       ▼                │
  │                      │           │ isDiagnosis() /        │
  │                      │           │ isRecommendationArray()│
  └──────────────────────┘           └────────────────────────┘
                                       │
                                       ▼
                                     downstream trusts
                                     the shape
```

## Elaborate

I have shipped six features that depend on structured output. Every one of them broke at least once because someone added "and please be concise" to a prompt that was relying on schema mode. The model started returning schema-conformant JSON *inside* a markdown code fence as a courtesy. Parser broke.

The three defenses that survive that failure mode:

- **Provider-side schema for tool calls.** Real structural guarantee. If a bug reaches you here, it's a provider bug, not yours.
- **Validator on the parse boundary.** `parseAgentJson()` in this repo has three fallbacks precisely because I've seen all three in production. The substring scan looks paranoid until the day it saves you.
- **Retry with a stricter prompt on schema fail.** The pattern is: log the raw output, retry once with "your last response was not valid JSON in the expected shape; return only JSON," give up after 2-3 tries. `RubricJudge` in `@aptkit/core` implements this exact shape — you can see the retry count on every case receipt.

The vendor differences at time of writing:

- **Anthropic** — tool calling enforces `input_schema` strictly. No JSON mode as such; you can ask for JSON in text and hope, but it's not guaranteed.
- **OpenAI** — `response_format: { type: "json_object" }` for JSON mode; `response_format: { type: "json_schema", ... }` for structured outputs with a schema. Tool calls also enforced.
- **Google Gemini** — `responseSchema` on the request enforces a shape.

The pattern (schema + validate + retry) transfers across all three. The specific field name changes; the discipline doesn't.

When *not* to use structured output: open-ended generation (write me a story about X), exploratory chains where you want the model to freely reason, and any case where you're going to hand the raw text to a human anyway. Structuring open text is a category error — the model will keep trying to fit the box and you'll degrade the output quality without gaining anything.

## Interview defense

**Q: You said the tool calls are provider-schema-enforced. Why is there still a validator in the codebase?**

The tool call payloads are enforced. The final answer isn't a tool call — it's a text block with fenced JSON. Provider doesn't constrain plain text. So the validator at `lib/mcp/validate.ts` catches the remaining ~5% failure modes: model wraps JSON in prose, model drops a field, model returns a fenced block inside another fenced block. `parseAgentJson()` has three fallback layers — fence strip, raw parse, substring scan. `isDiagnosis()` narrows the parsed value. Both together are the app-side safety net for the one boundary the provider doesn't cover.

```
  provider enforces:  tool_use  ✓
  app enforces:       final text ✓  ← via validate.ts
```

Anchor: `lib/mcp/validate.ts:3-35`.

**Q: What's the failure mode where you learned this the hard way?**

The polite-model failure. You ask for JSON. The prompt is clean, the schema is declared, everything looks right. The model — trying to be helpful — returns valid JSON *inside* a markdown code fence, then adds "Let me know if you'd like me to elaborate!" as a courtesy. Your `JSON.parse(text)` throws. First few days after ship you see it 5% of the time. Then a model upgrade lands and it happens 40% of the time. Fence-stripping fixes it. Substring scan catches the case where the model also prepends "Here's the analysis:". The lesson: your parser has to be forgiving even when your prompt is strict, because model behavior drifts across upgrades.

```
  clean prompt  ──► polite model  ──► fenced JSON + signoff
                                              │
                                              ▼
                                     parser needs 3 fallbacks
```

Anchor: `lib/mcp/validate.ts:6-12` — the substring-scan fallback exists exactly for this.

## See also

- 01 · anatomy — where the output shape declaration lives in the prompt.
- 04 · token budgeting — schema declarations consume tokens; big schemas are expensive.
- 07 · output mode mismatch — the failure mode where two chains disagree about the shape.
- 05 · eval-driven iteration — the RubricJudge uses this pattern and exposes retry counts in every receipt.
