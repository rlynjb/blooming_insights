# Structured outputs

## Subtitle

Tool-call schemas / JSON-mode constraints — Industry standard.

## Zoom out, then zoom in

Every typed thing this codebase pulls out of the model — `Diagnosis`, `Recommendation[]`, `RubricJudgment`, `QueryIntent`, `Anomaly[]` — comes through a *schema-constrained output* path. The model doesn't emit free text you then hand-parse; it emits either a tool call whose input matches a JSON schema, or a JSON blob the judge parses against a `RubricDefinition`. The schema is the contract; the model output is checked against it, at runtime, before your code trusts it.

```
  Zoom out — where schemas gate the model

  ┌─ Agent code (TS, typed) ─────────────────────────────┐
  │  Diagnosis, Recommendation, Anomaly (lib/mcp/types.ts)│
  └───────────────────────┬──────────────────────────────┘
                          │  passed to aptkit as
                          │  ToolDefinition[] / structured output schema
                          ▼
  ┌─ AnthropicModelProviderAdapter ─────────────────────┐
  │  MessageCreateParams.tools = [{name, description,    │
  │                                input_schema}]        │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ Anthropic ─────────────────────────────────────────┐
  │  model constrained to emit tool_use with            │
  │  ★ input matching the schema ★                       │ ← we are here
  └──────────────────────────────────────────────────────┘
```

Zoom in: the schema is what makes the output typed at compile time and valid at runtime. Without it, you're back to regex on free text.

## Structure pass

- **Layers:** TS type → JSON schema → tool_use input → parse → TS type again. Five bands, but the shape is roundtrip.
- **Axis: trust.** Above the schema boundary, TS types are trusted. Below the boundary, the raw model output is untrusted until it passes schema validation. The validator flips trust.
- **Seam:** the tool `input_schema` field on `MessageCreateParams.tools`. That's the boundary. Anthropic guarantees the tool_use `input` matches the schema; your `input_schema` is the contract you hand across the seam.

## How it works

### Move 1 — the mental model

You know how TypeScript gives you typed contracts at function boundaries — `function classify(text: string): Intent` and both sides trust the compiler? A JSON schema gives you the same thing at the LLM boundary. The model reads the schema as part of the prompt; when it decides to call the tool, the provider constrains the output tokens to match the schema.

```
  Schema as a runtime contract

  ┌─ your code (compile-time typed) ─────────────────────┐
  │  type Diagnosis = { conclusion: string,               │
  │                     evidence: string[], ... }         │
  └───────────────────────┬──────────────────────────────┘
                          │  translated to JSON schema
                          ▼
  ┌─ passed to model as tool definition ────────────────┐
  │  { name: "submit_diagnosis",                         │
  │    input_schema: {                                   │
  │      type: "object",                                 │
  │      properties: { conclusion: {type: "string"},     │
  │                    evidence: {type: "array", ...} } }│
  └───────────────────────┬──────────────────────────────┘
                          │  model emits tool_use
                          ▼
  ┌─ tool_use.input matches the schema ─────────────────┐
  │  parse → back to Diagnosis at runtime               │
  └──────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Where the schemas are defined.** Two places, for two different concerns.

**Agent tool schemas.** `lib/agents/tool-schemas.ts:9` — the `filterToolSchemas()` helper packages MCP tool defs (`McpToolDef[]`) into Anthropic-compatible `Tool[]`:

```ts
// lib/agents/tool-schemas.ts:9
export function filterToolSchemas(
  all: McpToolDef[],
  allowed: readonly string[],
): Anthropic.Messages.Tool[] {
  const set = new Set(allowed);
  return all
    .filter((t) => set.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
    }));
}
```

The MCP tools already come with an `inputSchema` from the Bloomreach server — this codebase relays that schema straight to Anthropic. The schema is what constrains the model's tool call arguments.

**Rubric output schema.** `eval/rubrics/diagnosis-quality.ts:16` — the `RubricDefinition` (from `@aptkit/core`) is passed to `RubricJudge`, which itself uses aptkit's typed output pathway to make the judge emit `{ verdict, dimensions: { score, rationale }[] }` in a schema-checked shape. No free-text judge output ever hits your code; the judge either emits a valid `RubricJudgment` or errors, in which case the receipt records `judge_error` (see `eval/run.eval.ts`).

**How the model actually complies.** Anthropic's tool-use path uses constrained decoding — during generation, tokens that would break the JSON schema get their probability zeroed. The model can't emit invalid JSON if it wants to; the sampler blocks it. That's stronger than "please respond in JSON" prompting; it's structurally enforced.

Execution trace of a diagnostic turn that ends in a diagnosis:

```
  Structured output — turn ending in a submit_diagnosis tool call

  turn N-1:  model emits tool_use for execute_analytics_eql
  turn N-1:  your code returns tool_result
  turn N:    model reads all evidence, decides it's done
  turn N:    model emits tool_use { name: "submit_diagnosis",
                                    input: { conclusion: "...",
                                             evidence: [...],
                                             hypothesesConsidered: [...] } }
             ↑
             input MUST match the schema — the sampler blocks any token
             that would break it
  agent loop reads the tool_use, casts to Diagnosis, returns
```

### Move 3 — the principle

Every LLM output your code depends on should have a runtime schema. Without one, you're either hand-parsing free text (fragile) or trusting the model to output valid JSON on prompt instruction alone (also fragile). The schema is what makes the boundary safe to program against.

## Primary diagram

```
  Structured output — full frame

  ┌─ TS: define the shape ─────────────────────────────────┐
  │  type Diagnosis = { conclusion, evidence, ... }        │
  └──────────────────────┬─────────────────────────────────┘
                         │  translated to
                         ▼
  ┌─ JSON schema in tool.input_schema ─────────────────────┐
  │  { type: "object", properties: {...}, required: [...]} │
  └──────────────────────┬─────────────────────────────────┘
                         │  ships in MessageCreateParams
                         ▼
  ┌─ Anthropic constrained decoding ───────────────────────┐
  │  sampler blocks tokens that break schema               │
  └──────────────────────┬─────────────────────────────────┘
                         │  response.content: tool_use
                         │  with valid input
                         ▼
  ┌─ Agent parses tool_use.input → Diagnosis ──────────────┐
  │  compile-time typed, runtime-validated                 │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

Three ways providers support structured output today:

- **Tool-calling** (what this codebase uses everywhere) — the model emits `tool_use` blocks whose `input` matches an `input_schema`. Provider-enforced.
- **JSON mode** — the model is prompted to return JSON; the provider validates it's syntactically valid JSON (but not that it matches any schema).
- **Structured outputs / strict-JSON** — a newer path where the provider guarantees the output matches a full JSON schema (not just is-JSON). Anthropic's tool-use is effectively this; OpenAI has an explicit `response_format: { type: "json_schema" }`.

The codebase uses tool-calling because MCP tools already have schemas — the agents don't invent new schemas; they relay MCP's. This makes structured output "free" as far as new schema work goes.

Related: **04-agents-and-tool-use/02-tool-calling.md** (the tool_use / tool_result loop this schema flows through). **05-evals-and-observability/03-llm-as-judge-bias.md** (how RubricJudge uses the same pattern for scoring output).

## Project exercises

### B1.4 · Add a Zod-runtime check between tool_use and typed cast

- **Exercise ID:** B1.4
- **What to build:** In `lib/agents/aptkit-adapters.ts`'s `BloomingToolRegistryAdapter`, add an assertion that every `tool_use.input` matches the tool's declared JSON schema (via a lightweight validator like `ajv`). Currently the codebase trusts Anthropic's constrained decoding — a defensive validator would catch schema drift if the MCP server updates a tool's input shape without the codebase noticing.
- **Why it earns its place:** Belt-and-suspenders. The interview payoff is showing you understand "provider guarantees the schema" and "your code should defensively check anyway" are complementary, not redundant.
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (add validator to `BloomingToolRegistryAdapter.execute()`), `test/agents/tool-schemas.test.ts` (add malformed-input test).
- **Done when:** a test that feeds a malformed `tool_use.input` results in a caught error and the agent loop receives a `tool_result` with `is_error: true` rather than the malformed input propagating downstream.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: What stops the model from emitting invalid JSON in a tool call?**

The sampler. During tool_use generation, tokens whose emission would produce a JSON prefix that can't extend to a valid schema-matching JSON blob get their logits masked to zero. So the model literally cannot emit invalid JSON on that path. That's stronger than prompt-based "please respond in JSON" — it's structurally enforced. Load-bearing: if you removed the schema, you'd fall back to the prompt-only path and start seeing malformed JSON at a small but non-zero rate.

**Q: How do you know the eval judge's output is well-formed?**

Two layers. First, `RubricJudge` (from `@aptkit/core`) uses tool-calling internally with a schema derived from the `RubricDefinition`. Second, on parse failure (e.g., token cap hit mid-JSON), `eval/run.eval.ts` catches the error and records a `judge_error` placeholder in the receipt instead of crashing. The `judge_error` count is a signal — if it climbs, the token cap is too low or the rubric is too complex.

## See also

- [../04-agents-and-tool-use/02-tool-calling.md](../04-agents-and-tool-use/02-tool-calling.md) — the tool loop this schema lives in.
- [../05-evals-and-observability/03-llm-as-judge-bias.md](../05-evals-and-observability/03-llm-as-judge-bias.md) — how the same pattern powers the judge.
- [08-provider-abstraction.md](08-provider-abstraction.md) — how the schema surface stays portable across providers.
