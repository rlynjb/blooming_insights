# Tool calling

**Industry name(s):** function calling, tool use, the brain/hands split, `tool_use`/`tool_result` protocol
**Type:** Industry standard · Language-agnostic

> The model emits a `tool_use` block naming a tool and its arguments; your code runs the tool and feeds the result back as a `tool_result` — the model is the brain that decides, your loop is the hands that act. blooming insights wires Bloomreach MCP tools into Claude via `filterToolSchemas`, and `runAgentLoop` executes each call through an injected `McpCaller`.

**See also:** → 01-agents-vs-chains.md · → 03-react-pattern.md · → 04-tool-routing.md · → 06-error-recovery.md · → ../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md

---

## Why care

A language model cannot run code. It produces tokens — that is the entire surface of its capability. When you call `anthropic.messages.create`, what comes back is text and, optionally, a structured request that says "I would like to call `execute_analytics_eql` with these arguments." The model does not — cannot — execute that call. It has no network socket, no file handle, no database connection. It only *describes* the call it wants. Your code is the only thing in the system that can actually reach Bloomreach.

The question this file answers: how does a model that can only emit tokens cause a real query to run against a real backend, and get the real answer back?

**Answering it matters because the entire value of an agent collapses without it.** A model reasoning about analytics with no live data is a confident guesser — it will hallucinate funnel numbers. Tool calling is the mechanism that grounds every claim in a real query result. Get the protocol wrong and you get one of two failures: the model "calls" a tool but your code never runs it (the model talks to a wall), or your code runs it but never feeds the result back (the model is blind to what it just requested). The `tool_use` → run → `tool_result` round-trip is the contract that makes the difference between a chatbot and an analyst.

Before and after the round-trip:

```
Without tool calling                    With tool calling (this codebase)
────────────────────────────────       ────────────────────────────────────
model: "mobile conversion likely        model: tool_use execute_analytics_eql
        dropped ~15%"                           {eql, project_id}
        (made up — no data)             code:  runs it against Bloomreach
                                        model: "mobile conversion dropped 18%
                                                vs the 7-day baseline" (grounded)
```

One-line summary: **the model is the brain that decides which tool and with what arguments; your loop is the hands that run it and hand the result back.**

---

## How it works

**Mental model.** Tool calling is a typed function-call boundary where the *caller* is a model and the *dispatcher* is your code. You have written this shape before without an LLM: a message handler that receives `{ type: 'SAVE', payload }` over a `postMessage`, looks up the handler for `type`, runs it, and posts a reply back. The model's `tool_use` block is that message; `filterToolSchemas` is the registry of which messages are legal; `mcp.callTool` is the dispatcher; the `tool_result` block is the reply. The model never touches the dispatcher — it only sends messages the dispatcher understands.

```
ONE round-trip
────────────────────────────────────────────────────────────
 model  ──tool_use { name, input }──→  your loop
                                          │ look up name, run it
 model  ←──tool_result { content }────  your loop  ←── Bloomreach MCP
        (next turn: model reads the result and decides again)
```

The schemas tell the model what is callable; the loop does the calling; the result re-enters the conversation as the next user turn. Three pieces: the *schema* (what the model may request), the *caller* (the seam that runs it), and the *round-trip* (request out, result back).

---

### The schema: what the model is allowed to request

The model can only request tools it has been *shown*. `filterToolSchemas` (`tool-schemas.ts` L9–L21) takes the full list of Bloomreach MCP tool definitions (`McpToolDef`, L3–L7) and produces the Anthropic `Tool[]` shape the API expects — but only for the names in the `allowed` subset.

```
tool-schemas.ts — filterToolSchemas(all, allowed)   (L9–L21)
─────────────────────────────────────────────────────────────
 McpToolDef (from MCP)            Anthropic.Messages.Tool (to model)
 { name,                          { name,
   description?,        ──map──→     description: description ?? '',
   inputSchema: object }            input_schema: inputSchema }
                                  filtered to: set.has(t.name)   (L15)
```

The transform is mechanical: rename `inputSchema` → `input_schema`, default a missing description to `''`, and drop any tool not in the allowed set (L15 `set.has(t.name)`). The *filtering* is the load-bearing part — it is also routing, covered in 04-tool-routing.md. For tool calling itself, the point is: the array handed to the API at `base.ts` L101 (`params.tools = toolSchemas`) is the complete, exhaustive description of every action the model can request this turn.

---

### The caller seam: McpCaller

Your code needs a single, typed function that "runs a named tool with arguments and returns a result." That seam is the `McpCaller` interface (`base.ts` L16–L22).

```
base.ts — McpCaller   (L16–L22)
─────────────────────────────────────────────────────────────
 interface McpCaller {
   callTool(
     name: string,
     args: Record<string, unknown>,
     opts?: { cacheTtlMs?; skipCache? },
   ): Promise<{ result; durationMs; fromCache }>;
 }
```

`runAgentLoop` depends on this interface, not on the concrete `McpClient` class. In production the real `McpClient` (which adds caching, spacing, and retry) is passed in; in tests a fake that returns canned results is passed in. The model's `tool_use` block carries `name` and `input`, which map exactly onto `callTool`'s first two arguments — the interface is shaped to receive a model's request directly. This is the brain/hands seam made concrete: the model produces `name` + `input`, the `McpCaller` is the hand that runs it.

---

### The round-trip: request out, result back

The actual execution lives in `runAgentLoop`'s per-tool loop (`base.ts` L129–L171). For each `tool_use` block in the model's response, the loop runs the tool and builds a matching `tool_result` block keyed by `tool_use_id`.

```
base.ts — per-tool loop   (L129–L171)
─────────────────────────────────────────────────────────────
 for tu of toolUses:                              L129
   tc = { id: tu.id, agent, toolName: tu.name, args: tu.input }  L130
   onToolCall?.(tc)                               L138  (stream "action")
   try:
     { result, durationMs } = await mcp.callTool(tu.name, tu.input)  L144  ← HANDS
     tc.result = result; tc.durationMs = durationMs                  L148
     resultContent = truncate(JSON.stringify(result))               L150
   catch err:
     tc.error = message; resultContent = {error}                    L153–155
   toolResults.push({ type:'tool_result', tool_use_id: tu.id, content: resultContent })  L161–167
 messages.push({ role:'user', content: toolResults })   L171  ← result re-enters conversation
```

Three details make this correct. First, **`tool_use_id` pairing** (L163): the `tool_result` carries the same `id` as the `tool_use` it answers, so the model knows which request this result belongs to when there are multiple parallel tool calls in one turn. Second, **truncation** (L150, `MAX_TOOL_RESULT_CHARS = 16_000` at L29): a giant Bloomreach payload is sliced before it re-enters the context, so one fat result cannot blow the token budget (see context management). Third, **errors are data** (L151–L155): a thrown error becomes a `tool_result` with `is_error: true` rather than crashing the loop — the model sees the failure and can adapt (06-error-recovery.md). The result is pushed as a `role: 'user'` message (L171) because, from the model's perspective, the tool result is new information from the outside world — the same role a human question would occupy.

---

### Every MCP tool carries project_id

Bloomreach MCP tools are multi-tenant: every analytics tool needs a `project_id` to know *which* workspace to query. The model does not invent it — it is injected into the system prompt. Each agent's `system` string runs `.replace(/\{project_id\}/g, this.schema.projectId)` (`diagnostic.ts` L48, `recommendation.ts` L43, `monitoring.ts` L71, `query.ts` L27) before the loop starts, so the model reads the real project id in its instructions and includes it in the `input` of every `tool_use` block. The argument the model emits — `{ eql: "...", project_id: "..." }` — is what `mcp.callTool` forwards verbatim to Bloomreach.

```
schema.projectId ──.replace('{project_id}')──→ system prompt
                                                    │ model reads it
 model: tool_use execute_analytics_eql { eql, project_id }  ← model includes it
                                                    │
 mcp.callTool(name, { eql, project_id }) ──────────→ Bloomreach (correct tenant)
```

---

### The principle

**Separate deciding from doing.** The model is good at deciding *what* to ask and *how* to phrase the arguments; it is structurally incapable of *doing* the call. Keep the decision in the model (it sees the schemas and emits a request) and keep the execution in code (the loop runs it and validates the result). The `tool_use`/`tool_result` protocol is the wire format for that split. Any system where the model "calls an API" is really this: the model describes the call, your code makes it. Owning the dispatcher is owning the trust boundary — the model proposes, your code disposes.

---

## Tool calling — diagram

The diagram spans three layers. The Model layer decides; the Loop layer (your code) dispatches; the Provider boundary runs the real call. The schema flows down (what is callable) and the result flows up (what happened).

```
┌──────────────────────────────────────────────────────────────────────┐
│  MODEL LAYER (brain — decides)   @anthropic-ai/sdk                     │
│                                                                       │
│  sees: toolSchemas (Tool[])  +  system prompt (with project_id)      │
│  emits: tool_use { id, name: "execute_analytics_eql",                │
│                    input: { eql, project_id } }                       │
└───────────────────────────────┬───────────────────────────────────────┘
            tool_use ↓                          ↑ tool_result
┌───────────────────────────────▼───────────────────────────────────────┐
│  LOOP LAYER (hands — dispatches)   lib/agents/base.ts L129–171        │
│                                                                       │
│  filterToolSchemas(all, allowed) ──→ toolSchemas (handed up)         │
│  for tu of toolUses:                                                  │
│    onToolCall(tc)                          ← stream the action        │
│    { result, durationMs } = mcp.callTool(tu.name, tu.input)  L144    │
│    resultContent = truncate(JSON.stringify(result))   (16k cap)      │
│    tool_result { tool_use_id: tu.id, content }                       │
│  messages.push(user: toolResults)   L171   ← result re-enters context │
└───────────────────────────────┬───────────────────────────────────────┘
                    mcp.callTool  │  (McpCaller interface — injectable)
┌───────────────────────────────▼───────────────────────────────────────┐
│  PROVIDER BOUNDARY   lib/mcp/  ·  Bloomreach MCP                       │
│  McpClient (prod: cache + spacing + retry)  /  fake (tests)           │
│  raw analytics result  ──────────────────────────────────────────────┤
└──────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: the model names the tool, the loop runs it, the result comes back up, and the seam (`McpCaller`) is swappable.

---

## In this codebase

**Case A — implemented.**

### Schema mapping (MCP defs → Anthropic tools)

- **File:** `lib/agents/tool-schemas.ts`
- **Function / class:** `filterToolSchemas` (+ `McpToolDef` interface L3–L7)
- **Line range:** L9–L21
- **Role:** Maps `McpToolDef[]` → `Anthropic.Messages.Tool[]`, renaming `inputSchema` → `input_schema`, defaulting `description` to `''`, and filtering to the allowed name set (L15).

### The caller seam

- **File:** `lib/agents/base.ts`
- **Function / class:** `McpCaller` interface
- **Line range:** L16–L22
- **Role:** The single typed boundary `runAgentLoop` depends on; `callTool(name, args, opts?) => { result, durationMs, fromCache }`. Production `McpClient` and test fakes both satisfy it structurally.

### The round-trip executor

- **File:** `lib/agents/base.ts`
- **Function / class:** `runAgentLoop` — per-tool execution loop
- **Line range:** L129–L171; tools attached to the request at L101; `mcp.callTool` at L144; `tool_result` built at L161–L167; pushed as user turn at L171
- **Role:** For each `tool_use` block, runs the tool, captures `durationMs`, truncates the payload (`MAX_TOOL_RESULT_CHARS = 16_000`, L29), and feeds a `tool_result` keyed by `tool_use_id` back into `messages`.

### Per-agent tool subsets

- **File:** `lib/mcp/tools.ts`
- **Function / class:** `monitoringTools` / `diagnosticTools` / `recommendationTools` / `queryTools`
- **Line range:** L5–L13, L15–L25, L27–L34, L38–L40
- **Role:** The name arrays passed as `allowed` into `filterToolSchemas` — each agent is shown only its relevant tools. (Routing detail in 04-tool-routing.md.)

### project_id injection

- **File:** `lib/agents/diagnostic.ts` L48 (`recommendation.ts` L43, `monitoring.ts` L71, `query.ts` L27)
- **Function / class:** system-prompt construction in each agent's entry method
- **Line range:** the `.replace(/\{project_id\}/g, this.schema.projectId)` call
- **Role:** Injects the real workspace id into the prompt so the model includes `project_id` in every tool call's `input`.

**Pseudocode — one tool round-trip** (`base.ts` L116–L171):

```typescript
const toolUses = res.content.filter(b => b.type === 'tool_use');   // L116
if (toolUses.length === 0) return { finalText, toolCalls };        // L121 (no call → done)

const toolResults = [];
for (const tu of toolUses) {                                        // L129
  onToolCall?.(tc);                                                 // L138 (action event)
  const { result, durationMs } = await mcp.callTool(tu.name, tu.input);  // L144 (HANDS)
  toolResults.push({
    type: 'tool_result',
    tool_use_id: tu.id,                                             // L163 (pairing)
    content: truncate(JSON.stringify(result)),                      // L150/164 (16k cap)
  });
}
messages.push({ role: 'user', content: toolResults });             // L171 (result back)
```

---

## Elaborate

### Where this pattern comes from

Tool use / function calling was popularized by OpenAI's June 2023 function-calling release and formalized across providers since. Anthropic's tool-use API expresses it as `tool_use` content blocks in the assistant message and `tool_result` blocks in the following user message — the exact shapes this codebase manipulates. The Model Context Protocol (MCP), the layer blooming insights uses to reach Bloomreach, generalizes this further: tools are *discovered* at runtime (`conn.mcp.listTools()` in `route.ts` L203) rather than hard-coded, so the available action set is whatever the connected MCP server exposes, mapped on the fly by `filterToolSchemas`.

### The deeper principle

A model is a pure function from tokens to tokens; it has no side effects. Every side effect in an agentic system happens in *your* code, triggered by a token pattern the model emits. This is why "the model called the API" is always a simplification — the model emitted a request; your dispatcher made the call. Internalizing this changes how you reason about security and reliability: the model is untrusted input to your dispatcher, and the dispatcher is where validation, scoping, rate limiting, and auditing must live. blooming insights puts caching, spacing, and retry in `McpClient` (the dispatcher), not in the model's path — exactly because the dispatcher is the only place that *can* enforce them.

### Where this breaks down

The model emits arguments as free-form JSON conforming to the tool's `input_schema`, but the schema is advisory — the model can emit malformed or semantically wrong arguments (a bad EQL string, a stale `project_id`). The loop forwards them verbatim (`base.ts` L144). There is no argument validation between the model and Bloomreach; a wrong argument becomes a failed `tool_result` the model must recover from, rather than a caught error. It also breaks under *many* tools: with ~40 tools in scope the model's selection accuracy degrades, which is why the subsets exist. And there is no argument sanitization on the free-form `q` path — the model's tool arguments are derived from unsanitized user input (see the prompt-injection note in 06-error-recovery.md and the RAG section).

### What to explore next

- **MCP (Model Context Protocol)** — the discovery-and-transport layer that lets a client expose tools to any model; read how `conn.mcp.listTools()` populates `allTools` at `route.ts` L203–L206.
- **JSON Schema for tool inputs** — the `input_schema` field is a JSON Schema; constrained-decoding providers can enforce it at the token level (Anthropic does not at this codebase's vintage).
- **Parallel tool use** — Anthropic models can emit multiple `tool_use` blocks in one turn; `base.ts` L129's `for` loop already handles the batch — trace what happens when `toolUses.length > 1`.

---

## Tradeoffs

### Comparison: MCP tool calling via injectable McpCaller vs alternatives

| Dimension | This codebase (MCP + McpCaller seam) | Hard-coded SDK calls in the loop | Constrained-decoding tool args |
|---|---|---|---|
| Tool discovery | Runtime via `listTools` (any MCP server) | Compile-time, fixed | Runtime or compile-time |
| Testability | High — inject a fake `McpCaller` | Low — must mock the SDK/network | Depends |
| Argument validity | Advisory schema; model can emit bad args | Same | Enforced at token level |
| Coupling | Loop knows only the interface | Loop knows the concrete client | Tied to provider feature |
| Provider portability | Tool layer is MCP-agnostic | Locked to one SDK shape | Locked to providers that support it |

**What we gave up.** Argument-level validation. The loop forwards the model's `input` straight to `mcp.callTool` (L144) with no schema check between model and backend. A malformed EQL string reaches Bloomreach and comes back as an error `tool_result`. We accept "fail at the backend, let the model retry" over "validate every argument shape in the loop" because the MCP server already validates and returns structured errors, and adding a second validation layer would duplicate the schema and rot independently.

**What the alternative would have cost.** Hard-coding the Anthropic SDK calls and the Bloomreach client directly in the loop would have removed the `McpCaller` indirection — but every unit test would then need to mock the network or hold a real API key, and swapping the cache/retry behavior would mean editing the loop instead of swapping a constructor argument. The injectable seam is one interface for a large testability win.

**The breakpoint.** This design is right while wrong tool arguments are rare and recoverable. It stops being right if a wrong argument can cause an *expensive or irreversible* side effect (a write, a bulk export, a billable operation). At that point you must validate arguments in the dispatcher before the call, not after — the model-as-untrusted-input principle becomes a hard gate rather than a retry path. blooming insights is read-only analytics, so the breakpoint has not been reached.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk tool use (tool_use / tool_result)

- **Codebase uses:** `params.tools = toolSchemas` (`base.ts` L101); reads `tool_use` blocks (L116); builds `tool_result` blocks keyed by `tool_use_id` (L161–L167).
- **Why it's here:** It is the wire protocol that turns a model's request into an executable call and feeds the answer back.
- **Leading today:** Anthropic tool use and OpenAI function calling are the two adoption-leading protocols in 2026.
- **Why it leads:** First-class block types, parallel tool calls, and large context windows make agentic loops viable without a framework.
- **Runner-up:** Gemini function calling — capable, growing, slightly less mature multi-tool ergonomics.

### Model Context Protocol (MCP)

- **Codebase uses:** Bloomreach tools are discovered via `conn.mcp.listTools()` (`route.ts` L203) and mapped by `filterToolSchemas`; transported through `McpClient`/`SdkTransport`.
- **Why it's here:** It decouples the tool set from the code — the available actions are whatever the MCP server exposes, not a hard-coded list.
- **Leading today:** MCP is the innovation-leading tool-interop standard in 2026, with fast-growing adoption.
- **Why it leads:** Runtime discovery, a uniform tool shape across servers, and provider-agnostic transport.
- **Runner-up:** OpenAI plugins / custom function registries — provider-specific, less portable.

### JSON Schema (input_schema)

- **Codebase uses:** `McpToolDef.inputSchema` is passed through as `input_schema` (`tool-schemas.ts` L19), the contract the model fills.
- **Why it's here:** It tells the model the shape of arguments a tool accepts.
- **Leading today:** JSON Schema is the adoption-leading tool-argument contract in 2026.
- **Why it leads:** Universal, language-agnostic, and natively understood by every major model's tool layer.
- **Runner-up:** Provider-proprietary argument schemas — narrower, non-portable.

---

## Project exercises

### Validate tool arguments in the dispatcher before the call

- **Exercise ID:** C4.1 (adapted to blooming insights)
- **What to build:** In `runAgentLoop`'s per-tool loop, validate `tu.input` against the tool's `inputSchema` (carried in `allTools`) before calling `mcp.callTool`; on a schema mismatch, skip the call and return a structured `is_error` `tool_result` so the model self-corrects without a wasted Bloomreach round-trip.
- **Why it earns its place:** Demonstrates you understand the model-as-untrusted-input principle and can move validation into the dispatcher (the trust boundary).
- **Files to touch:** `lib/agents/base.ts` (L129–L160); pass `allTools` into `runAgentLoop`; `test/agents/base.test.ts`.
- **Done when:** A `tool_use` with arguments that violate the schema produces an `is_error` `tool_result` and zero network calls, and valid arguments behave exactly as before.
- **Estimated effort:** 1–4hr

### Surface tool argument + result sizes in the trace

- **Exercise ID:** C4.1 (adapted to blooming insights)
- **What to build:** Extend the `tool_call_end` event (`lib/mcp/events.ts`) and the per-tool loop to report the pre-truncation byte size of each result and whether truncation fired (result exceeded `MAX_TOOL_RESULT_CHARS`), then show it in `/debug` and the investigate trace.
- **Why it earns its place:** Shows you can observe the brain/hands boundary and reason about token budget at the tool level — a production-readiness signal.
- **Files to touch:** `lib/agents/base.ts` (L150), `lib/mcp/events.ts` (L7), `app/api/agent/route.ts` (`hooksFor`, L181–L195), `app/debug/page.tsx`.
- **Done when:** Every tool call in a trace shows its raw result size and a truncation flag, and a result over 16,000 chars is visibly marked truncated.
- **Estimated effort:** 1–4hr

---

## Summary

A model can only emit tokens, so it never runs a tool — it emits a `tool_use` block describing the call it wants, and your code runs it and feeds back a `tool_result`. blooming insights maps Bloomreach MCP tools into the Anthropic `Tool[]` shape with `filterToolSchemas` (`tool-schemas.ts` L9–L21), executes each call through the injectable `McpCaller` seam (`base.ts` L16–L22), and pairs every result to its request by `tool_use_id` before pushing it back as a user turn (`base.ts` L129–L171). Every MCP tool carries a `project_id` injected into the system prompt. The brain decides; the hands act.

Key points:
- The model describes the call; your loop (`base.ts` L144) makes it — "the model called the API" is always a simplification.
- `filterToolSchemas` is the registry of legal requests; `McpCaller` is the dispatcher; `tool_result` keyed by `tool_use_id` is the reply.
- Results are truncated at `MAX_TOOL_RESULT_CHARS = 16_000` (L29) before re-entering the context, and errors become `is_error` results rather than crashes.
- `project_id` is injected into the prompt (`.replace('{project_id}')`), not invented by the model.
- The dispatcher is the trust boundary; validation, scoping, and rate limiting live there, not in the model's path.

---

## Interview defense

### What an interviewer is really asking

"How does your agent call tools?" tests whether you know the model cannot execute anything — whether you can articulate the `tool_use` → run → `tool_result` round-trip, name where the actual call happens in code, and identify the dispatcher as the trust boundary. A weak answer says "the model calls the function." A strong answer says "the model emits a request, my loop dispatches it, and here is the line."

### Likely questions

**[mid] "Walk me through one tool round-trip, line by line."**

The model returns content blocks; the loop filters for `tool_use` (`base.ts` L116). For each, it builds a `ToolCall`, fires `onToolCall` (L138), then `await mcp.callTool(tu.name, tu.input)` (L144) — that line is where the real Bloomreach call happens. The result is truncated (L150) and packed into a `tool_result` carrying the same `tool_use_id` (L163). All results are pushed back as one `role: 'user'` message (L171), and the loop iterates so the model can read them.

```
tool_use {id:A, name, input} ──→ mcp.callTool(name, input)  L144
                              ←── { result }
tool_result {tool_use_id:A, content: truncate(result)}  L161  ──push as user──→ next turn
```

**[senior] "Why does the result come back as a `role: 'user'` message, and why key it by `tool_use_id`?"**

Role `user` because, to the model, a tool result is new information arriving from the outside world — the same conversational position a human message occupies; the assistant turn was the `tool_use` request. The `tool_use_id` pairing matters when a single turn emits multiple `tool_use` blocks (parallel tool use): without the id, the model could not match which result answers which request. `base.ts` L163 sets `tool_use_id: tu.id` exactly so the batch in L171 is unambiguous.

```
turn emits 2 tool_use: id=A (funnels), id=B (events)
results pushed together:
  tool_result {tool_use_id:A, ...}   ← model maps to the funnels request
  tool_result {tool_use_id:B, ...}   ← model maps to the events request
```

**[arch] "The model emits the EQL string and the project_id. Where is that validated before it hits Bloomreach?"**

It is not validated in the loop — `base.ts` L144 forwards `tu.input` verbatim. A wrong EQL string fails at Bloomreach and returns as an error `tool_result` the model must recover from. `project_id` is not model-invented; it is injected into the prompt via `.replace('{project_id}')`. This is defensible for read-only analytics, but the moment a tool has an expensive or irreversible side effect, argument validation must move into the dispatcher before the call — the model is untrusted input.

```
model input ──verbatim──→ mcp.callTool ──→ Bloomreach
              (no gate)                     bad arg → error tool_result → model retries
read-only: fine          write/billable: add a validation gate here ↑
```

### The question candidates always dodge

**"Can the model run the tool itself?"**

No — and candidates dodge by saying "the model calls the tool" as if the model has a runtime. It does not. The model emits tokens forming a `tool_use` block; the *only* thing that executes is `mcp.callTool` at `base.ts` L144, which is your code. Every side effect in the system originates from your dispatcher reacting to a token pattern. Owning that distinction is what separates "I used an agent framework" from "I understand what an agent is."

### One-line anchors

- `lib/agents/base.ts` L144 — `await mcp.callTool(tu.name, tu.input)` — the only line that actually runs a tool.
- `lib/agents/base.ts` L116 / L121 — model emits `tool_use`; no `tool_use` means the loop is done.
- `lib/agents/base.ts` L163 — `tool_use_id: tu.id` — pairs each result to its request.
- `lib/agents/tool-schemas.ts` L9–L21 — `filterToolSchemas` — MCP defs become the model's callable registry.
- `lib/agents/base.ts` L16–L22 — `McpCaller` — the injectable dispatcher seam.

---

## Validate

### Level 1 — Reconstruct

From memory, draw one tool round-trip: model emits `tool_use { name, input }` → loop runs `mcp.callTool` → loop builds `tool_result { tool_use_id }` → pushed back as `role: 'user'`. Label which side is the brain and which is the hands.

### Level 2 — Explain

Out loud: explain why a language model cannot run a tool, and why "the model called the API" is a simplification. Name the exact line where the real call happens.

### Level 3 — Apply

Scenario: a teammate reports the model "called `execute_analytics_eql` but nothing happened — no Bloomreach traffic." Where do you look? Check `lib/agents/base.ts` L116–L144: is the response producing `tool_use` blocks (L116)? Is `mcp.callTool` being reached (L144)? Is `params.tools` set this turn (L101 — on a `forceFinal` turn tools are omitted, so the model *cannot* emit `tool_use`)? Walk the path and name which check fails.

### Level 4 — Defend

A reviewer says: "Drop the `McpCaller` interface and call the Bloomreach client directly in the loop — fewer types." Defend the seam using unit-test isolation (no network, no API key) and the ability to swap cache/retry behavior by changing a constructor argument rather than the loop.

### Quick check — code reference test

What does `runAgentLoop` set as the `content` of a `tool_result`, and what caps its size? (Answer: `truncate(JSON.stringify(result))` — capped at `MAX_TOOL_RESULT_CHARS = 16_000`, `lib/agents/base.ts` L29 / L150.)

---
Updated: 2026-05-28 — Corrected `set.has` to L15, refreshed `route.ts` `listTools` (L203) and `hooksFor` (L181–195) refs, and updated the per-agent `project_id`-injection line numbers.
