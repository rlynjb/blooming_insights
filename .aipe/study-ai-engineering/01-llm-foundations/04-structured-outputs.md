# Structured outputs

*Industry standard — tool calling as the structured-output mechanism*

## Zoom out — where this concept lives

When you want the model to return typed data, not free prose, you have two options: ask for JSON in the prompt and hope, or give the model a tool schema and let the SDK enforce it. This codebase takes option 2 — every "structured output" is technically a `tool_use` content block, and the schema is the typed contract.

```
  Zoom out — structured output as a tool-use block

  ┌─ Agent layer ────────────────────────────────┐
  │  needs typed output:                          │
  │  Anomaly[], Diagnosis, Recommendation[]       │
  └────────────────────┬─────────────────────────┘
                       │  build ModelRequest with tools[]
                       ▼
  ┌─ ★ Adapter sets tools on the request ★ ──────┐ ← we are here
  │  toAnthropicTool(tool) at aptkit-adapters:78 │
  │  passes name + description + inputSchema      │
  └────────────────────┬─────────────────────────┘
                       │
                       ▼
  ┌─ Anthropic API ──────────────────────────────┐
  │  model constrained to emit either text OR a   │
  │  tool_use block matching one of the schemas   │
  └──────────────────────────────────────────────┘
```

**Zoom in.** No JSON-mode, no Zod schema at the LLM boundary. The structured-output contract IS the tool schema. Every `Anomaly`, `Diagnosis`, `Recommendation` in this codebase comes out as a `tool_use` block — typed, validated, parsed.

## Structure pass — layers · axes · seams

**Layers:** TypeScript type → MCP tool inputSchema (JSON Schema) → Anthropic tools[] → model output (`tool_use` block) → parsed back to typed object.

**Axis: where does the type contract live?** TypeScript: at compile time, on your side. JSON Schema: at runtime, in the tool definition. The boundary is `lib/agents/aptkit-adapters.ts:78` — the conversion that hands a JSON-schema-typed tool to the SDK.

**Seam:** the `inputSchema` field on the tool definition. That's where your TypeScript types become runtime constraints the model is held to.

## How it works

### Move 1 — the mental model

You know how a TypeScript function signature constrains what the caller can pass? A tool schema is the same idea, applied at the LLM boundary. The model is the "caller"; the schema is the signature; the parser is the runtime guard.

```
  Tool calling as a typed function call across a boundary

  ┌─ Your TypeScript ─────────────────────────────┐
  │  type Anomaly = {                             │
  │    metric: string;                            │
  │    scope: string[];                           │
  │    change: { value, direction, baseline };    │
  │    severity: 'critical'|'warning'|'info'|...; │
  │  };                                           │
  └────────────────────┬──────────────────────────┘
                       │  expressed as JSON Schema
                       ▼
  ┌─ Tool schema ─────────────────────────────────┐
  │  { name: 'emit_anomaly',                      │
  │    description: '...',                        │
  │    input_schema: {                            │
  │      type: 'object',                          │
  │      properties: { metric, scope, change, ...} │
  │    } }                                        │
  └────────────────────┬──────────────────────────┘
                       │  passed to model as tools[]
                       ▼
  ┌─ Model output ────────────────────────────────┐
  │  { type: 'tool_use', name: 'emit_anomaly',   │
  │    input: { metric: 'conversion_rate', ... } }│
  │  ← input is constrained to match the schema │
  └───────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Part 1 — tool schemas come from MCP, not from this app.**

This is unusual but load-bearing: the agents don't define their own tool schemas. They get them from the Bloomreach MCP server via `dataSource.listTools()` at `app/api/agent/route.ts:243-247`. So the entire tool surface — `execute_analytics_eql`, `list_funnels`, `get_event_segmentation`, etc. — is defined upstream.

From `lib/agents/aptkit-adapters.ts:78-84`:

```typescript
function toAnthropicTool(tool: ModelTool): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema as Anthropic.Messages.Tool['input_schema'],
  };
}
```

Three fields. The `input_schema` is plain JSON Schema. Anthropic validates the model's output against it.

**Part 2 — agent allowlists narrow the surface.**

Each agent only gets a subset of the MCP server's tools (`lib/mcp/tools.ts`). Monitoring gets 13, diagnostic gets 17, recommendation gets 7. The filtering happens at `lib/agents/tool-schemas.ts:9-21`:

```typescript
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

This is structural prompt-injection defense: the model literally cannot emit a tool name outside its agent's allowlist. The recommendation agent has no way to call `execute_analytics_eql` — it's not in its tool list.

**Part 3 — the agent's structured output is what AptKit reduces from the tool calls.**

Here's the subtle part: when `MonitoringAgent.scan()` returns `Anomaly[]`, it's not because the model emitted an `Anomaly[]` directly. It's because AptKit's `AnomalyMonitoringAgent` runs the tool-call loop, collects the results, and synthesizes the typed `MonitoringAnomaly[]` from the accumulated evidence. The boundary at `lib/agents/monitoring.ts:88` then maps `MonitoringAnomaly → Anomaly`:

```typescript
return (await agent.scan({ signal: hooks?.signal })).map(toBloomingAnomaly);
```

The structured output you see at the agent boundary is the *result* of many tool-use blocks, parsed and reduced. The schema-enforcement happens at the per-tool level inside the loop.

### Move 3 — the principle

**The schema is the contract; the loop reduces tool-use blocks into the agent's output type.** This is a different shape from "ask the model for JSON" — it's typed at the call level, not the response level. The tradeoff: you can't get arbitrary structured outputs without defining a tool for them. Worth it because tool schemas are already on the wire (MCP).

## Primary diagram — the full recap

```
  Structured outputs end to end

  ┌─ MCP server (Bloomreach) ──────────────────────────────────┐
  │  defines tools with JSON Schema input_schema               │
  │  example: { name: 'execute_analytics_eql',                 │
  │             input_schema: { type:'object', properties:{    │
  │               project_id, eql, execution_time              │
  │             }, required: ['project_id', 'eql']             │
  │          } }                                               │
  └────────────────────┬───────────────────────────────────────┘
                       │  listTools() at session start
                       ▼
  ┌─ Agent allowlist filter (tool-schemas.ts:9) ───────────────┐
  │  narrow to this agent's allowed tools                      │
  └────────────────────┬───────────────────────────────────────┘
                       │  pass tools[] to model
                       ▼
  ┌─ Model — constrained to schema ────────────────────────────┐
  │  emits tool_use blocks with input matching schema          │
  │  { type:'tool_use', name:'execute_analytics_eql',          │
  │    input:{ project_id:'…', eql:'select count event…' } }   │
  └────────────────────┬───────────────────────────────────────┘
                       │  AptKit loop executes the tool, feeds result
                       ▼
  ┌─ Agent boundary — typed return ────────────────────────────┐
  │  AnomalyMonitoringAgent.scan() → MonitoringAnomaly[]       │
  │  toBloomingAnomaly() → Anomaly[]                           │
  │  (the structured output the route layer emits)             │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why this codebase doesn't use JSON mode or Zod.** Two reasons:

  1. **The tool surface is already typed.** MCP tools come with JSON Schema definitions. Wrapping them in an additional Zod layer would duplicate the contract.
  2. **The agents produce reduced outputs, not raw model outputs.** `Anomaly[]` is the *result* of running the loop, not the model's direct response. The schema enforcement that matters is at the per-tool-call level, not the per-agent-return level.

**The tradeoff named.** If you ever need an agent to return something that isn't reducible from MCP tool calls (e.g. a freeform poem), this pattern doesn't help. You'd need to introduce a synthetic "emit_response" tool with a schema matching your typed output and have the model call it as the last step. The recommendation agent comes closest to this pattern: it eventually calls a synthesis step that emits `Recommendation[]` as structured output.

**Where the type story is weakest.** The cast at `lib/agents/aptkit-adapters.ts:82` — `tool.inputSchema as Anthropic.Messages.Tool['input_schema']` — is unchecked. If the MCP server ever ships a tool with an invalid JSON Schema, the SDK will accept it and the model will be free to emit invalid `tool_use` blocks. There's no runtime validation step here.

## Project exercises

### Exercise — Add Zod validation at the tool-call result boundary

  → **Exercise ID:** B1.4
  → **What to build:** Define Zod schemas for the four most-used Bloomreach tool result envelopes (`execute_analytics_eql` result, `get_event_schema`, `list_funnels`, `get_funnel`). Wrap `BloomingToolRegistryAdapter.callTool()` to parse the result through the Zod schema if one matches, log a warning when validation fails, and pass the typed result through.
  → **Why it earns its place:** the cast at `aptkit-adapters.ts:82` is the weakest point in the type story. The model is constrained by schema on the way *in*, but tool *results* coming back from MCP are typed as `unknown` and passed back to the model verbatim. Zod parsing at the boundary catches silent schema drift from the server.
  → **Files to touch:** new file `lib/data-source/result-schemas.ts` (Zod schemas), `lib/agents/aptkit-adapters.ts` (wrap `callTool`'s return), `test/data-source/result-schemas.test.ts` (cover the four envelope shapes), `test/agents/aptkit-adapters.test.ts` (assert validation warnings + passthrough behavior).
  → **Done when:** running the synthetic data source through the full agent loop produces zero validation warnings, and an artificially-broken envelope (test fixture) raises a warning without breaking the loop.
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "How do you get structured output from your agents?"**

Tool calling. Each agent receives a filtered subset of MCP tool schemas (JSON Schema). The model can emit either text or a `tool_use` block; the `tool_use` blocks are schema-constrained. AptKit's reusable agents collect tool results across the loop and reduce them to typed outputs — `Anomaly[]`, `Diagnosis`, `Recommendation[]`. The contract lives at the per-tool-call level, not the per-response level.

*Anchor: "Tool schemas are the contract; the agent loop reduces tool calls into the typed return."*

**Q: "What stops the recommendation agent from running EQL queries?"**

Allowlist at `lib/mcp/tools.ts:28-36`. The recommendation agent gets 7 tools — `list_scenarios`, `get_scenario`, `list_segmentations`, etc. — and `execute_analytics_eql` isn't in the list. `filterToolSchemas()` at `lib/agents/tool-schemas.ts:9` only ships those 7 schemas to the model. There's no way for the model to emit a `tool_use` for a tool it doesn't have a schema for — the SDK would reject it.

*Anchor: "Allowlist at `tools.ts`; filter at `tool-schemas.ts:9`; the model literally cannot pick what isn't shipped."*

## See also

  → `04-agents-and-tool-use/02-tool-calling.md` — the loop that uses these schemas
  → `04-agents-and-tool-use/04-tool-routing.md` — how intent classification picks the agent (and therefore the allowlist)
  → `06-production-serving/03-prompt-injection.md` — how this pattern doubles as injection defense
