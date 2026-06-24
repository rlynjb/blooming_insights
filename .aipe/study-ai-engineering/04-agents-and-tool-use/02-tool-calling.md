# Tool calling

**Industry name(s):** function calling, tool use, the brain/hands split, `tool_use`/`tool_result` protocol
**Type:** Industry standard · Language-agnostic

> The model emits a `tool_use` block naming a tool and its arguments; your code runs the tool and feeds the result back as a `tool_result` — the model is the brain that decides, your loop is the hands that act. blooming insights wires Bloomreach MCP tools into Claude via `filterToolSchemas`, and `runAgentLoop` executes each call through an injected `McpCaller`.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Tool calling is the *round-trip* between the Provider (where the model emits `tool_use` requests) and the Tools + MCP transport bands below it (where your code runs them and hands the result back). The Agent loop is the coordinator: it pulls `tool_use` blocks out of the model response (`lib/agents/base.ts` L116–L118), runs each via `mcp.callTool` (L144), and pushes the results back as the next user turn (L161–L171). The model is the brain; your loop is the hands.

```
  Zoom out — the tool-use round-trip

  ┌─ Per-agent + Agent loop ─────────────────────────┐  ← we are here (orchestrator)
  │  runAgentLoop  base.ts L48–176                   │
  │   1. send (system, messages, tools)              │
  │   2. extract tool_use blocks   L116–118          │
  │   3. ★ run via mcp.callTool ★  L144              │
  │   4. push tool_result back     L161–171          │
  │   5. repeat or stop on forceFinal                │
  └─────────────────────────┬────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼ tool_use      │               ▲ tool_result
  ┌─ Provider ──────────┐   │   ┌─ Tools + MCP transport ─┐
  │  model emits        │   │   │  toolSchemas (filtered) │
  │  tool_use {name,    │   │   │  McpClient.callTool     │
  │   input}            │   │   │  → SdkTransport → MCP   │
  └─────────────────────┘   │   └─────────────────────────┘
                            ▼
                          HTTPS → Bloomreach MCP server
```

**Zoom in — narrow to the concept.** The question is: how does a model that can only emit tokens cause a real query to run against a real backend, and get the real answer back? The model never executes anything — it *describes* the call it wants in a structured `tool_use` block. Your loop interprets the description, runs the call, and hands the `tool_result` back so the next turn sees real data. How it works walks the four-step round-trip, the `tool_use_id` pairing that makes results trace back to requests, and the failure modes if either side of the contract drops a block.

---

## Structure pass

**Layers.** Four layers form the round-trip: the model (emits `tool_use` blocks), the agent loop (extracts blocks, dispatches via `mcp.callTool`, pushes results back), the MCP transport (sends HTTPS to the Bloomreach server and returns the JSON), and the tool execution itself on the backend. The model is the brain; everything below is the hands.

**Axis: trust.** What can each layer trust about the bytes from the layer next to it? This axis is the right lens because tool calling is a *call-untrusted-from-untrusted* arrangement — the model emits a structured request your code must validate before executing, and the result coming back is a string the model must integrate without trusting it absolutely. Control is shared in a balanced loop (both layers decide things); the load-bearing question is who-can-tamper-with-what.

**Seams.** The cosmetic seam is between the MCP transport and the tool backend — both are server-side. The load-bearing seam is between the model and the agent loop: trust flips here from "structured `tool_use` describing what to do" to "must be validated against the tool registry (`filterToolSchemas`) before any execution." A second load-bearing seam is between the tool execution and the model on the way back: results re-enter the context as the next user turn, and the `tool_use_id` pairing is the contract that makes results trace back to requests — drop one and the model loses the thread.

```
  Structure pass — tool calling

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  model (emits tool_use blocks)                 │
  │  agent loop (dispatches via mcp.callTool)      │
  │  MCP transport (HTTPS to server)               │
  │  tool execution (backend)                      │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  trust: what can each layer trust about what   │
  │  the layer next to it just said?               │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  transport↔backend: cosmetic                   │
  │  model↔agent loop: LOAD-BEARING                │
  │    tool_use is a REQUEST not a command         │
  │    must be validated before execution          │
  │  tool result↔model (return): LOAD-BEARING      │
  │    tool_use_id is the trace contract           │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Tool calling is a typed function-call boundary where the *caller* is a model and the *dispatcher* is your code. You have written this shape before without an LLM: a message handler that receives `{ type: 'SAVE', payload }` over a `postMessage`, looks up the handler for `type`, runs it, and posts a reply back. The model's `tool_use` block is that message; the tool-schema filter is the registry of which messages are legal; the MCP caller is the dispatcher; the `tool_result` block is the reply. The model never touches the dispatcher — it only sends messages the dispatcher understands.

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

The model can only request tools it has been *shown*. The tool-schema filter takes the full list of MCP tool definitions and produces the provider SDK's `Tool[]` shape the API expects — but only for the names in the `allowed` subset.

```
the tool-schema filter
─────────────────────────────────────────────────────────────
 McpToolDef (from MCP)            ProviderSDK.Tool (to model)
 { name,                          { name,
   description?,        ──map──→     description: description ?? '',
   inputSchema: object }            input_schema: inputSchema }
                                  filtered to: allowed.has(t.name)
```

The transform is mechanical: rename `inputSchema` → `input_schema`, default a missing description to `''`, and drop any tool not in the allowed set. The *filtering* is the load-bearing part — it is also routing, covered in 04-tool-routing.md. For tool calling itself, the point is: the array handed to the API as `params.tools` is the complete, exhaustive description of every action the model can request this turn.

---

### The caller seam: McpCaller

Your code needs a single, typed function that "runs a named tool with arguments and returns a result." That seam is the `McpCaller` interface.

```
  interface McpCaller {
      callTool(
          name: string,
          args: Record<string, unknown>,
          opts?: { cacheTtlMs?, skipCache? },
      ): Promise<{ result, durationMs, fromCache }>
  }
```

The shared agent loop depends on this interface, not on the concrete MCP client class. In production the real client (which adds caching, spacing, and retry) is passed in; in tests a fake that returns canned results is passed in. The model's `tool_use` block carries `name` and `input`, which map exactly onto `callTool`'s first two arguments — the interface is shaped to receive a model's request directly. This is the brain/hands seam made concrete: the model produces `name` + `input`, the `McpCaller` is the hand that runs it.

---

### The round-trip: request out, result back

The actual execution lives in the shared agent loop's per-tool body. For each `tool_use` block in the model's response, the loop runs the tool and builds a matching `tool_result` block keyed by `tool_use_id`.

```
the per-tool loop body
─────────────────────────────────────────────────────────────
 for tu in toolUses:
     tc = { id: tu.id, agent, toolName: tu.name, args: tu.input }
     onToolCall?(tc)                                  # stream "action"
     try:
         { result, durationMs } = await mcp.callTool(tu.name, tu.input)   ← HANDS
         tc.result = result; tc.durationMs = durationMs
         resultContent = truncate(JSON.stringify(result))
     catch err:
         tc.error = err.message; resultContent = { error: err.message }
     toolResults.push({
         type:        "tool_result",
         tool_use_id: tu.id,
         content:     resultContent,
     })
 messages.push({ role: "user", content: toolResults })   ← result re-enters conversation
```

Three details make this correct. First, **`tool_use_id` pairing**: the `tool_result` carries the same `id` as the `tool_use` it answers, so the model knows which request this result belongs to when there are multiple parallel tool calls in one turn. Second, **truncation** (the 16,000-char tool-result cap): a giant payload is sliced before it re-enters the context, so one fat result cannot blow the token budget (see context management). Third, **errors are data**: a thrown error becomes a `tool_result` with `is_error: true` rather than crashing the loop — the model sees the failure and can adapt (06-error-recovery.md). The result is pushed as a `role: "user"` message because, from the model's perspective, the tool result is new information from the outside world — the same role a human question would occupy.

---

### Every MCP tool carries project_id

The MCP tools are multi-tenant: every analytics tool needs a `project_id` to know *which* workspace to query. The model does not invent it — it is injected into the system prompt. Each agent's `system` string runs a `.replace(/{project_id}/g, schema.projectId)` before the loop starts, so the model reads the real project id in its instructions and includes it in the `input` of every `tool_use` block. The argument the model emits — `{ eql: "...", project_id: "..." }` — is what `mcp.callTool` forwards verbatim to the backend.

```
schema.projectId ──.replace('{project_id}')──→ system prompt
                                                    │ model reads it
 model: tool_use execute_analytics_eql { eql, project_id }  ← model includes it
                                                    │
 mcp.callTool(name, { eql, project_id }) ──────────→ backend (correct tenant)
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
│  LOOP LAYER (hands — dispatches)   lib/agents/base.ts                 │
│                                                                       │
│  filterToolSchemas(all, allowed) ──→ toolSchemas (handed up)         │
│  for tu of toolUses:                                                  │
│    onToolCall(tc)                          ← stream the action        │
│    { result, durationMs } = mcp.callTool(tu.name, tu.input)          │
│    resultContent = truncate(JSON.stringify(result))   (16k cap)      │
│    tool_result { tool_use_id: tu.id, content }                       │
│  messages.push(user: toolResults)   ← result re-enters context │
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

## Implementation in codebase

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

## See also

→ 01-agents-vs-chains.md · → 03-react-pattern.md · → 04-tool-routing.md · → 06-error-recovery.md · → ../../study-system-design/06-multi-agent-orchestration.md

---
Updated: 2026-05-28 — Corrected `set.has` to L15, refreshed `route.ts` `listTools` (L203) and `hooksFor` (L181–195) refs, and updated the per-agent `project_id`-injection line numbers.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
