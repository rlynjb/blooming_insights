# 04 — Structured outputs

**Type:** Industry standard. Also called: tool calling with schema, JSON mode, function calling.

## Zoom out, then zoom in

The typed boundary between the LLM and the rest of the system. In this repo, the tool_use schema is the ONLY way the model produces actionable output — no free-form JSON parsing, no regex-scraping the assistant text.

```
  Zoom out — where the typed boundary sits

  ┌─ TypeScript world (Anomaly / Diagnosis / Recommendation) ─────────┐
  │   lib/mcp/types.ts — the domain contracts                          │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │  same types
  ┌─ Agent layer ───────────────▼─────────────────────────────────────┐
  │   AptKit agents return typed values                                │
  │   ★ THIS CONCEPT ★ — the schema at the model boundary              │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │  tool_use / tool_result blocks
  ┌─ Anthropic API ─────────────▼─────────────────────────────────────┐
  │   messages.create({tools: [{name, description, input_schema}]})    │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. The model's output that matters is one of two shapes: `text` (free-form; feeds `onText` → `reasoning_step` events → the UI) or `tool_use` (structured; the input matches a JSON Schema you registered as a tool). AptKit's agents use tool_use as the mechanism for the model to say "I've reached my conclusion, here's the final `Diagnosis` in this schema." Not free-form JSON. Not "please output as JSON, thanks." An actual `tool_use` block against a schema.

## Structure pass

**Layers:**
- Outer: TypeScript types (`Anomaly`, `Diagnosis`, `Recommendation`) — what the app renders
- Middle: JSON Schema — what the model is constrained to
- Inner: `tool_use.input` — the raw block the model emits

**Axis: what enforces the shape?**
- Outer: TypeScript at compile time — types can lie about runtime data
- Middle: the Anthropic server refuses to emit `tool_use` blocks whose input doesn't validate against the schema
- Inner: post-processing / validation code as a safety net for shapes that pass the schema but violate business rules

**Seam:** the tool definition passed to `messages.create()`. `input_schema` is the contract. Everything above the seam speaks TypeScript; everything below speaks JSON Schema.

## How it works

### Move 1 — the mental model

You've defined a form component with an input type — `<input type="email">`. The browser rejects `"foo"` before it ever reaches your handler. Structured outputs are that, at the LLM boundary: instead of the model returning `"here's my diagnosis: { \"conclusion\": ... }"` as a string you'd have to parse and validate, it returns a `tool_use` block whose `input` is guaranteed by the API to match the schema you registered.

```
  Structured output as a typed boundary

  ┌───────────────────────┐    tool_use.input matching   ┌──────────────┐
  │  schema (JSON Schema) │ ◄──── the input_schema ───►  │  the model   │
  └───────────┬───────────┘                              └──────┬───────┘
              │                                                  │
              │                                                  ▼
              │                             {type: 'tool_use',
              │                              name: 'submitDiagnosis',
              │                              input: {conclusion: '...',
              │                                      evidence: [...],
              │                                      ...}}
              │                                                  │
              ▼                                                  │
  TypeScript type (Diagnosis) ◄─── typed value on your side ─────┘
  (declared in lib/mcp/types.ts)     (no runtime parsing needed)
```

### Move 2 — walk the mechanism

**Where tools are defined for the model.**

`lib/agents/aptkit-adapters.ts:233-239` — the `toAnthropicTool` helper — is the point where AptKit's `ModelTool` shape becomes Anthropic's `Tool`. `input_schema` passes straight through.

```typescript
// lib/agents/aptkit-adapters.ts:233-239
function toAnthropicTool(tool: ModelTool): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema as Anthropic.Messages.Tool['input_schema'],
  };
}
```

The tools list has two categories in this codebase:
1. **Data tools** — the MCP tools (`execute_analytics_eql`, `list_customers`, etc.) that fetch information from the workspace. Registered via `BloomingToolRegistryAdapter.listTools()`.
2. **Structured-output tools** — internal to AptKit's agent contracts. `DiagnosticInvestigationAgent` and `RecommendationAgent` register a "submit conclusion" tool that the model calls to signal done + return the typed result. The AptKit runtime intercepts that tool call, extracts the `input`, and returns it as the typed `Diagnosis` / `Recommendation[]`.

**The contract lives in `lib/mcp/types.ts`.**

```typescript
// lib/mcp/types.ts (shape reference; not copied verbatim)
export interface Diagnosis {
  conclusion: string;
  evidence: Array<{ tool: string; result: unknown }>;
  hypothesesConsidered: Array<{
    hypothesis: string;
    supported: boolean;
    reasoning: string;
  }>;
  affectedCustomers?: number;
  confidence?: 'high' | 'medium' | 'low';
}
```

`Recommendation` is bigger — `id`, `title`, `rationale`, `bloomreachFeature: 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment'`, `steps[]`, `estimatedImpact`, `confidence`. The union on `bloomreachFeature` is what "structured output" buys you at the domain layer: the UI's `RecommendationCard` can `switch` on that literal type and render the right feature chip.

**What the schema enforces.**

Only the shape — required fields present, types correct, unions in the allowed set. It doesn't enforce that the diagnosis is *right*. It doesn't enforce that the evidence traces to real tool results (that's the eval rubric's `evidence_grounding` dim). But it does mean you never have to write `try { JSON.parse(response.text) } catch { ... }` — the JSON parse errors that plague hand-rolled LLM output disappear at the boundary.

**The one place raw text still leaks through.**

The retired system prompts in `lib/agents/legacy-prompts/*.md` (e.g. `legacy-prompts/diagnostic.md`) had the model return a ```json fenced block that the old `DiagnosticAgent` regex-extracted. That approach IS the "before" picture. The current runtime uses AptKit's schema-based agents and doesn't do this anymore.

### Move 3 — the principle

Types at the boundary or types nowhere. Structured outputs let you have one shape end-to-end: TypeScript `Diagnosis` on the app side, JSON Schema `input_schema` at the model boundary, typed `input` block in the tool_use. Removing the raw-JSON-parse step doesn't just save a few lines — it removes an entire class of failure (malformed JSON, missing field, wrong type) from your production surface.

## Primary diagram

The typed boundary in full — one shape, three representations.

```
  Structured output — one shape, three views

  ┌─ app / UI layer ──────────────────────────────────────────────────┐
  │  interface Diagnosis {                                             │
  │    conclusion: string;                                             │
  │    evidence: Array<{tool: string; result: unknown}>;               │
  │    hypothesesConsidered: Array<{                                   │
  │      hypothesis: string; supported: boolean; reasoning: string;    │
  │    }>;                                                             │
  │    affectedCustomers?: number;                                     │
  │  }                                                                 │
  └────────────────────────────┬──────────────────────────────────────┘
                               │  (same shape, at build time)
  ┌─ agent contract (AptKit) ──▼──────────────────────────────────────┐
  │  tool: {                                                           │
  │    name: 'submitDiagnosis',                                        │
  │    input_schema: {                                                 │
  │      type: 'object',                                               │
  │      required: ['conclusion', 'evidence', 'hypothesesConsidered'], │
  │      properties: {                                                 │
  │        conclusion: {type: 'string'},                               │
  │        evidence: {type: 'array', items: {...}},                    │
  │        ...                                                         │
  │      }                                                             │
  │    }                                                               │
  │  }                                                                 │
  └────────────────────────────┬──────────────────────────────────────┘
                               │  (server-enforced at request time)
  ┌─ model output ─────────────▼──────────────────────────────────────┐
  │  {                                                                 │
  │    type: 'tool_use',                                               │
  │    name: 'submitDiagnosis',                                        │
  │    input: {                                                        │
  │      conclusion: 'Payment processor timeout on credit_card mobile',│
  │      evidence: [...],                                              │
  │      hypothesesConsidered: [...],                                  │
  │      affectedCustomers: 9340                                       │
  │    }                                                               │
  │  }                                                                 │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

Structured outputs came in three waves. First there was "output JSON please" (regex-parsing prose responses; fragile). Then JSON mode (`response_format: {type: 'json_object'}`) — server-side enforces JSON is *valid* but not shape. Then tool calling / function calling (both OpenAI and Anthropic converged on the same shape) — server enforces the JSON Schema. That third wave is what this codebase uses through AptKit's agent contracts.

There's a fourth wave underway — thinking blocks and reasoning models with structured internal state — but Sonnet 4.6 without extended thinking behaves like the "tool calling" wave, which is where this repo sits.

## Project exercises

### Exercise — versioned schemas + migration path

- **Exercise ID:** C1.4-A · Case A (concept exercised).
- **What to build:** `Diagnosis` and `Recommendation` are shipped types read from committed demo snapshots (`lib/state/demo-*.json`). Add a `schemaVersion` field to both types, gate `unwrap`/reader helpers to accept v1 (missing field) and v2 (present); write a small migration test to prove backward-compatibility. This locks the contract so a future field rename doesn't invalidate every committed snapshot.
- **Why it earns its place:** proves you can extend a schema at the LLM boundary without breaking committed demo data. Interviewer signal: "the boundary is typed, and I've thought about how it evolves."
- **Files to touch:** `lib/mcp/types.ts` (add `schemaVersion`), `lib/mcp/validate.ts` (accept both versions), `lib/agents/diagnostic.ts` (populate on write), `__tests__/validate.test.ts` (add migration test).
- **Done when:** existing committed snapshots continue to load; new investigations write `schemaVersion: 2`; a test proves both parse.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Why not just prompt the model to output JSON?**

Because prompted JSON output fails 1-5% of the time on real workloads — missing brace, trailing comma, hallucinated field, wrong type on a nested value. Structured outputs move that failure from "runtime JSON parse error in production" to "the API rejects the malformed tool_use before you see it." The model retries on the API side, not yours.

**Q: What does "server-enforced" actually mean?**

Anthropic's server won't emit a `tool_use` block whose `input` doesn't validate against the `input_schema` you registered. If the model wants to emit a bad shape, the sampling layer rejects that continuation and picks a different token. From your side, if you get a `tool_use` block, its `input` conforms to the schema. Business-rule validation (is the diagnosis actually right?) still happens in your code and evals.

**Q: What's the difference between the schema at the boundary and TypeScript types in `lib/mcp/types.ts`?**

Same shape, different enforcement. TypeScript catches you at compile time — but it lies about runtime data (a wrong cast at parse time and TS believes it forever). The `input_schema` catches at model-emit time. Together they mean the value hits your app already-shaped: no runtime parse errors, no defensive type guards, no "what if evidence is undefined."

## See also

- `lib/mcp/types.ts` — the typed contracts
- `lib/mcp/validate.ts` — the runtime validation seam
- `04-agents-and-tool-use/02-tool-calling.md` — the same tool_use mechanism used for data-fetch tools
- `06-production-serving/03-prompt-injection.md` — schema-constrained outputs are the primary defense
