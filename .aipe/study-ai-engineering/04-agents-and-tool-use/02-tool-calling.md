# Tool calling

*Industry standard — model emits `tool_use` blocks; your code executes; result feeds back*

## Zoom out — where this concept lives

Every agent in this codebase calls tools the same way: the model gets a list of tool schemas (filtered from the MCP server's `listTools()` output), it emits a `tool_use` block when it wants to call one, the adapter executes through the `DataSource` port, and the result becomes a `tool_result` content block that feeds back on the next turn.

```
  Zoom out — tool calling in the stack

  ┌─ Agent layer ───────────────────────────────────────────┐
  │  AptKit agents drive the loop                            │
  │  emit tool_use blocks                                    │
  └──────────────────────┬──────────────────────────────────┘
                         │  port: ToolRegistry
                         ▼
  ┌─ ★ Adapter (aptkit-adapters.ts:72-94) ★ ────────────────┐ ← we are here
  │  BloomingToolRegistryAdapter                            │
  │   - listTools() → filtered MCP tools                    │
  │   - callTool(name, args) → DataSource.callTool          │
  └──────────────────────┬──────────────────────────────────┘
                         │  port: DataSource
                         ▼
  ┌─ DataSource (Bloomreach / Synthetic) ───────────────────┐
  │  callTool runs the MCP tool, returns result envelope    │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** Tool calling here is a two-port chain: `ToolRegistry` (AptKit's port) → adapter → `DataSource` (this codebase's port) → adapter (Bloomreach/Synthetic) → server. The agent only ever knows about `ToolRegistry`.

## Structure pass — layers · axes · seams

**Layers:** model → tool_use block → adapter → DataSource → server.

**Axis: who picks the tool?** The LLM picks (from the schemas it was shown). Your code's role is execute-and-report, not choose.

**Seam:** the `ToolRegistry.callTool()` method at `lib/agents/aptkit-adapters.ts:88-94`. That's where the agent's request becomes a real DataSource call.

## How it works

### Move 1 — the mental model

You know how a Unix shell hands a command to a binary, then captures its output for the next pipe? Tool calling is the same shape, applied to LLM calls. The model is the shell ("I want to run X"); your code is the OS layer that runs X and pipes the output back.

```
  Tool calling — the shell analogy

  ┌─ Model (the shell) ─────────────────────────────────────┐
  │  "I'd like to run execute_analytics_eql with this EQL"  │
  │  emits: { type: 'tool_use', name, input: { eql, ... } } │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─ Your code (the OS) ────────────────────────────────────┐
  │  dataSource.callTool(name, input) → result               │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─ Model on next turn ────────────────────────────────────┐
  │  sees: { type: 'tool_result', tool_use_id, content }    │
  │  decides what to do next                                │
  └─────────────────────────────────────────────────────────┘

  After the analogy: real engineering shape.
  The "tool_use" block is structured (name + JSON-schema-valid input);
  your callTool implementation is a function from (name, input) → result;
  the loop is a while-loop around model.complete().
```

### Move 2 — the step-by-step walkthrough

**Part 1 — tools are filtered before they reach the model.**

`lib/agents/tool-schemas.ts:9-21` narrows the full MCP tool list to a per-agent allowlist:

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

Monitoring gets 13 (`lib/mcp/tools.ts:6-14`), diagnostic gets 17, recommendation gets 7. Each agent's prompt only ever carries its allowed tools — the model literally cannot emit a `tool_use` for a tool outside the allowlist.

**Part 2 — the adapter routes tool calls through the DataSource port.**

`BloomingToolRegistryAdapter` at `lib/agents/aptkit-adapters.ts:72-94`:

```typescript
export class BloomingToolRegistryAdapter implements ToolRegistry {
  constructor(
    private readonly dataSource: McpCaller,
    private readonly allTools: McpToolDef[],
  ) {}

  listTools(): ToolDefinition[] {
    return this.allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ result: unknown; durationMs: number }> {
    const { result, durationMs } = await this.dataSource.callTool(name, args, options);
    return { result, durationMs };
  }
}
```

The adapter is structurally trivial — it satisfies AptKit's `ToolRegistry` interface using the codebase's existing `DataSource` port. AptKit doesn't know about MCP, OAuth, rate-limiting, or the 60s cache — all of that lives behind `DataSource.callTool()`.

**Part 3 — the LLM's tool call goes through three boundaries.**

```
  One tool call, end to end

  Model decides to call execute_analytics_eql:
    emits { type:'tool_use', id:'toolu_01abc', name:'execute_analytics_eql',
             input: { project_id, eql: 'select count event purchase in last 90 days' } }
                       │
                       ▼  AptKit loop receives it
                       │
   ToolRegistry.callTool('execute_analytics_eql', input):
                       │
                       ▼  routed to BloomingToolRegistryAdapter
                       │
   DataSource.callTool('execute_analytics_eql', input):
                       │
                       ▼  routed to BloomreachDataSource (or Synthetic)
                       │
   Bloomreach MCP server executes, returns result envelope
                       │
                       ▼  back up through the same boundaries
                       │
   AptKit loop appends: { type:'tool_result', tool_use_id:'toolu_01abc',
                          content: ... } to the message history
                       │
                       ▼  next model.complete() call sees it
```

The boundaries are: AptKit ↔ this codebase's adapter ↔ DataSource port ↔ MCP transport ↔ Bloomreach server. Each is a swap point.

**Part 4 — the schemas come from the live server, not from this codebase.**

`app/api/agent/route.ts:243-247`:

```typescript
const rawTools = await dataSource.listTools({ signal: req.signal });
const allTools: McpToolDef[] = Array.isArray((rawTools as { tools?: unknown })?.tools)
  ? (rawTools as { tools: McpToolDef[] }).tools
  : [];
```

The Bloomreach MCP server defines the tool shapes (name, description, JSON Schema for input). The codebase reads them at session start, caches them on the `allTools` array, and passes them to the agents. If Bloomreach adds a tool, the agents see it on the next session.

This is unusual in LLM apps: the tool surface isn't hardcoded — it's discovered. The allowlist at `lib/mcp/tools.ts` is the only thing pinned (so adding a tool server-side doesn't automatically grant the agent access).

### Move 3 — the principle

**Tool calling is a typed function call across a model-code boundary.** The schema is the type signature; the model is the caller; your code is the implementation. Get the schema right and the rest is structural. The two ports in this codebase (`ToolRegistry` from AptKit, `DataSource` from this repo) compose: AptKit holds the agent's view of the tool surface; the DataSource holds the *implementation* of that surface.

## Primary diagram — the full recap

```
  Tool calling: schema-in, schema-out, two ports compose

  ┌─ Session start ──────────────────────────────────────────────┐
  │  dataSource.listTools() → raw MCP tools                      │
  │   ↓                                                          │
  │  filtered per-agent: monitoring(13), diagnostic(17),         │
  │                      recommendation(7), query(union)         │
  └──────────────────────┬───────────────────────────────────────┘
                         │  passed to AptKit agent
                         ▼
  ┌─ Per-call ───────────────────────────────────────────────────┐
  │                                                              │
  │  model.complete(messages, tools)                             │
  │      ↓                                                       │
  │  ContentBlock[] including possible tool_use                  │
  │      ↓                                                       │
  │  for each tool_use:                                          │
  │     ToolRegistry.callTool(name, input)                        │
  │       ↓                                                      │
  │     BloomingToolRegistryAdapter ─→ DataSource.callTool        │
  │       ↓                                                      │
  │     BloomreachDataSource (cache check → rate space → MCP)    │
  │     OR SyntheticDataSource (in-memory)                       │
  │       ↓                                                      │
  │     { result, durationMs, fromCache } back up                │
  │       ↓                                                      │
  │     trace hook fires: tool_call_end event                    │
  │       ↓                                                      │
  │     append tool_result to message history                    │
  │      ↓                                                       │
  │  loop or break (when LLM emits no tool_use)                  │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why the schemas come from MCP and not from this codebase.** The Bloomreach MCP server is the canonical owner of "what tools exist." If this codebase hardcoded the schemas, they'd drift from the server's. By discovering them at session start (`listTools()`), the agents always carry the live shape. The cost is one tool call per session start (`list_tools`); the benefit is no schema-drift bugs.

The `lib/mcp/tool-coverage.ts` cross-check (`crossCheckToolCoverage()`) catches the opposite case: a tool in the allowlist that the server no longer exposes. Surfaced via `GET /api/mcp/tools/check`.

**Why `ToolRegistry` and `DataSource` are two ports, not one.** They could be one — a single port with `listTools()` + `callTool()`. But:

  → **`ToolRegistry`** is AptKit's contract; it's tiny and library-shaped (no auth, no caching, no rate-limiting).
  → **`DataSource`** is this codebase's contract; it lives at a different layer and carries the real-world concerns (OAuth, cache, retry, cancellation).

Keeping them separate means AptKit can be swapped without changing the DataSource, and vice versa. The adapter (`BloomingToolRegistryAdapter`) is the glue — 22 LOC.

**Where the type story is weakest.** The cast at `lib/agents/aptkit-adapters.ts:82`:

```typescript
input_schema: tool.inputSchema as Anthropic.Messages.Tool['input_schema'],
```

Unchecked. If MCP ever ships a tool with malformed JSON Schema, the SDK accepts it and the model is free to emit malformed `tool_use` blocks. The Zod-at-the-result-boundary exercise (`B1.4` in `01-llm-foundations/04-structured-outputs.md`) defends one direction; the other direction (validate the schema itself) isn't defended.

## Project exercises

### Exercise — Validate tool input schemas at session start

  → **Exercise ID:** B4.2
  → **What to build:** After `dataSource.listTools()` returns, run each tool's `inputSchema` through a JSON Schema meta-validator (e.g. `ajv.compile`). Reject any tool whose schema doesn't compile; log a warning naming the broken tool. Add the validator at the same boundary where the allowlist filter runs.
  → **Why it earns its place:** closes the schema-trust gap. Today the codebase trusts MCP to ship valid JSON Schema — if it doesn't, the model emits malformed `tool_use` blocks that fail at runtime. Catching at session start fails fast and loud.
  → **Files to touch:** new `lib/mcp/validate-tool-schema.ts` (the validator), `app/api/agent/route.ts` + `app/api/briefing/route.ts` (run validation after `listTools()`), `test/mcp/validate-tool-schema.test.ts` (cover valid + malformed schemas).
  → **Done when:** a synthetic malformed schema (test fixture) triggers a warning and the tool is dropped from the allowlist, the existing tool surface still passes validation in tests, and no `vi.mock` of ajv is needed (use real validation).
  → **Estimated effort:** 1–4hr.

## Interview defense

**Q: "How does your agent decide which tool to call?"**

The LLM does, from a per-agent allowlist. Monitoring sees 13 tools, diagnostic sees 17, recommendation sees 7. The tool schemas come from the live Bloomreach MCP server at session start via `listTools()` — not hardcoded — so the agents always carry the live shape. The allowlist (`lib/mcp/tools.ts`) is the only pinned surface; adding a tool server-side doesn't grant the agent access until I add its name to the allowlist.

The model emits a `tool_use` block with the tool name and a schema-valid input; the adapter routes through `ToolRegistry.callTool()` → `DataSource.callTool()` → the MCP transport.

*Anchor: "MCP schemas + per-agent allowlist; two ports compose at the adapter."*

**Q: "What happens if Bloomreach changes its tool surface?"**

Two scenarios: (1) Bloomreach *adds* a tool — agents don't see it until I add it to the allowlist at `lib/mcp/tools.ts`, so it's a deliberate opt-in. (2) Bloomreach *removes* a tool the allowlist still references — the agent might pick it, `dataSource.callTool` fails with a real error, the LLM sees the error (`is_error: true`) and adjusts. The `tool-coverage` cross-check at `GET /api/mcp/tools/check` surfaces this mismatch up front so I can update the allowlist before users hit it.

*Anchor: "Pinned allowlist + cross-check endpoint. Adds are opt-in; removes are caught."*

## See also

  → `01-agents-vs-chains.md` — the loop this fits inside
  → `03-react-pattern.md` — the loop's iteration structure
  → `04-tool-routing.md` — the allowlist-by-agent mechanism
  → `01-llm-foundations/04-structured-outputs.md` — the schema-as-contract framing
