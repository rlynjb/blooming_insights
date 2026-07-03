# The agent loop skeleton

_Industry standard._

## Zoom out, then zoom in

Every ReAct / plan-execute / reflexion pattern — every worker in Section C — is *this same kernel* with a different step function. Learn the kernel once here; the rest is prompt-shaping.

```
  Zoom out — where the skeleton lives

  ┌─ Service ─────────────────────────────────────────────────┐
  │  DiagnosticAgent.investigate(anomaly, hooks)              │
  │  RecommendationAgent.propose(anomaly, diagnosis, hooks)   │
  │  MonitoringAgent.scan(hooks, categories)                  │
  │  QueryAgent.answer(query, intent, hooks)                  │
  └────────────────────────────┬──────────────────────────────┘
                               │  each delegates to
                               ▼
  ┌─ AptKit runtime ──────────────────────────────────────────┐
  │  ★ runAgentLoop(...) — one kernel, four wrappers ★         │
  │  run-agent-loop.js:25-105                                  │
  └────────────────────────────┬──────────────────────────────┘
                               │
  ┌─ ModelProvider / ToolRegistry ───────────▼────────────────┐
  │  AnthropicModelProviderAdapter · BloomingToolRegistry     │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the loop is `step + execute + accumulate + terminate`, and termination has TWO exits. The budget exit is the one people forget.

## Structure pass

**Layers:** state (messages array) · step function (LLM call) · execute (tool dispatch) · termination (two exits).
**Axis:** *what breaks if this part is missing?*
**Seams:** the message-array boundary (accumulate happens here); the tool_use → callTool boundary (execute crosses from model to code).

```
  Four parts of the kernel, ranked by what breaks

  ┌──────────────┬──────────────────────────────────────────┐
  │ state        │ without it: every turn is amnesiac, N    │
  │ (messages[]) │ independent calls, not a loop            │
  ├──────────────┼──────────────────────────────────────────┤
  │ step (LLM)   │ without it: nothing chooses next action  │
  │              │ (the only "smart" part; rest is plumbing)│
  ├──────────────┼──────────────────────────────────────────┤
  │ execute      │ without it: model emits intent, nothing  │
  │ (tool call)  │ runs; also the safety boundary           │
  ├──────────────┼──────────────────────────────────────────┤
  │ terminate    │ TWO exits required:                       │
  │              │  success: model emits final (no tool_use)│
  │              │  budget:  maxTurns / maxToolCalls        │
  │              │ without budget exit: silent burn         │
  └──────────────┴──────────────────────────────────────────┘
```

## How it works

### Move 1 — the mental model

You've written a paginated `fetch` loop before — `while (hasMore) { const page = await fetch(...); results.push(...page); hasMore = page.next; }`. Four parts: state (`results`), the request (`fetch`), accumulate (`push`), termination (`hasMore`). The agent loop is the same shape with `fetch` replaced by `model.complete` and termination is *both* "model said done" AND "we hit the cap".

```
  Pattern: the agent loop kernel

  ┌───────────────────────────────────────────────────────┐
  │   messages = [{ user: prompt }]                       │
  │   for turn in 0..maxTurns:                             │
  │     ┌──────────────┐                                    │
  │     │ step         │ ← LLM decides                     │
  │     │ (LLM call)   │                                    │
  │     └──────┬───────┘                                    │
  │            ▼                                            │
  │       tool_uses?                                        │
  │     ┌───────┴────────┐                                  │
  │     │ none           │ tool_uses                        │
  │     ▼                ▼                                  │
  │  success exit    for each: callTool → tool_result      │
  │  (final text)    append to messages · loop             │
  │                                                          │
  │   if we exit the for without break: BUDGET exit         │
  │   (runtime forces a synthesis turn — see forceFinal)    │
  └───────────────────────────────────────────────────────┘
```

### Move 2 — the load-bearing skeleton walkthrough

**The kernel — `run-agent-loop.js:25-105`.** This is the whole pattern. Nothing removable.

```js
// node_modules/@aptkit/core/node_modules/@aptkit/runtime/dist/src/run-agent-loop.js:25
for (let turn = 0; turn < maxTurns; turn += 1) {
  signal?.throwIfAborted();                                    // ← cancellation seam
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;     // ← BUDGET exit trigger
  const response = await model.complete({
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    tools: forceFinal ? undefined : toolSchemas,               // ← strip tools on final
    ...
  });
  messages.push({ role: 'assistant', content: response.content });   // ← ACCUMULATE
  const toolUses = toolUsesFromContent(response.content);
  if (toolUses.length === 0) { finalText = text; break; }      // ← SUCCESS exit
  for (const toolUse of toolUses) {                             // ← EXECUTE
    const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
    toolResults.push({ type: 'tool_result', toolUseId: toolUse.id, content: ... });
  }
  messages.push({ role: 'user', content: toolResults });        // ← ACCUMULATE
}
```

Line-by-line:

**state** — `messages` array. Every turn pushes assistant response, then tool_result. Without this the model would decide fresh every turn with no memory of what it already queried. That's not a loop, it's a scattershot.

**step** — `model.complete(...)`. The only line where the model runs. In this codebase that call goes through `AnthropicModelProviderAdapter.complete` (`lib/agents/aptkit-adapters.ts:59`), which is where the ephemeral cache breakpoint gets set and the budget tracker gets checked.

**execute** — `tools.callTool(...)`. The model emitted `tool_use` intent; this is where the harness actually runs it. Through `BloomingToolRegistryAdapter.callTool` (`aptkit-adapters.ts:138`) → `dataSource.callTool` → the MCP call. **The model never touches the tool directly** — that boundary is the whole control story. Every guardrail (allowlist, timeout, rate limit, injection defense) hangs here.

**terminate — two exits.** SUCCESS: `toolUses.length === 0` (model returned pure text, `break` the loop). BUDGET: the `for` completes without break — the `forceFinal` flag at `turn === maxTurns - 1` strips `tools` from the request so the model *must* produce final text. This is the load-bearing part. `maxTurns=8` and `maxToolCalls=6` are hard-coded in `diagnostic-agent.js:55-56`; without them a runaway loop burns tokens until Vercel's 300s wall clock kills the request.

```
  Layers-and-hops — one turn of the loop

  ┌─ AptKit runtime ─────────┐  turn N: build request        ┌─ Anthropic API ──┐
  │  run-agent-loop.js:29    │ ────────────────────────────►  │  Sonnet 4.6       │
  │                          │  content blocks + tool_use ◄── │                   │
  └──────────┬───────────────┘                                └───────────────────┘
             │ push assistant to messages
             ▼
  ┌─ AptKit runtime ─────────┐  for each tool_use:            ┌─ BloomingTool    ┐
  │  run-agent-loop.js:59    │ ────────────────────────────►  │  Registry        │
  │                          │  {result, durationMs} ◄────── │  callTool         │
  └──────────┬───────────────┘                                └─────────┬─────────┘
             │                                                          │ dataSource.callTool
             │ push tool_result to messages                             ▼
             │                                                ┌─ BloomreachData  ┐
             └──── loop back to top                           │  MCP over OAuth  │
                                                              └───────────────────┘
```

**Optional hardening (NOT skeleton):**

- **Recovery prompt** — `run-agent-loop.js:110`. If the final text failed to parse (missing JSON), a second turn is fired with a stricter "output ONLY the diagnosis object" prompt. This is *structured-output rescue*, not reflexion — the model isn't critiquing itself, the harness caught a schema violation.
- **BudgetTracker** — `lib/agents/budget.ts`. A hard token/cost ceiling across all agents in one investigation. Checked before *every* `model.complete` in `AnthropicModelProviderAdapter.complete:63`. This is above-and-beyond the `maxTurns` skeleton exit — it protects against runaway even when maxTurns=8 turns are individually cheap.
- **Trace sink** — `BloomingTraceSinkAdapter`. Forwards every `CapabilityEvent` to hooks that push NDJSON to the browser. Observability, not skeleton.
- **`signal?.throwIfAborted()`** — cancellation. Thread from `req.signal` → the loop → the tool call → the Anthropic call. Hardening for the "user closed the tab" case.

### Move 3 — the principle

An agent is `step + execute + accumulate + terminate`, and termination needs BOTH a success condition AND a hard budget. Naming the budget unprompted is the signal you shipped an agent, not read about one. Everything else — reflexion, plan-and-execute, retrieval loops — is a different step-function shape wrapped around this same kernel.

## Primary diagram

```
  Recap — the full agent loop kernel, with hardening seam

  ┌─ SKELETON (irreducible) ──────────────────────────────────┐
  │  messages = [user prompt]                                 │
  │                                                            │
  │  for turn in 0..maxTurns:                                  │
  │    ┌─ step ──────────────────────────────────────────┐    │
  │    │ response = model.complete(messages, tools)      │    │
  │    └────────┬────────────────────────────────────────┘    │
  │             ▼                                              │
  │        tool_uses?                                          │
  │      ┌──────┴──────┐                                       │
  │      │ none        │ tool_uses                             │
  │      ▼             ▼                                       │
  │  SUCCESS EXIT   execute: for each tool_use                 │
  │  return text      result = callTool(name, input)           │
  │                   messages.push(tool_result)                │
  │                                                            │
  │  → after maxTurns: BUDGET EXIT (forceFinal strips tools)   │
  └────────────────────────────────────────────────────────────┘
  ┌─ HARDENING (optional) ────────────────────────────────────┐
  │  cancellation signal · recovery prompt · budget tracker   │
  │  trace sink · retry/backoff · schema validation           │
  └───────────────────────────────────────────────────────────┘
```

## Elaborate

The kernel was first named cleanly in the ReAct paper (Yao et al. 2022) as Thought-Action-Observation. AptKit's `runAgentLoop` is a modern implementation with `forceFinal` handling the budget exit gracefully (strip tools + inject synthesis instruction) instead of the older pattern of raising `MaxIterationsError`. The graceful approach is materially better for user-facing systems because you get *a* diagnosis (based on evidence gathered so far) instead of a 500.

The subtle bit that separates senior from mid: recognizing the recovery prompt in `run-agent-loop.js:116` is NOT reflexion. It only fires if `parseResult` returned null — a schema failure. The model doesn't grade its own answer; the harness noticed it wasn't parseable and fired one rescue turn. Reflexion (see `05-reflexion-self-critique.md`) is fundamentally different.

## Interview defense

**Q: Walk me through the agent loop kernel.**
A: `step + execute + accumulate + terminate`. State is the messages array. Step is the model.complete call. Execute is tools.callTool — the model emits intent, the harness runs it, that boundary is the safety story. Accumulate pushes assistant + tool_result back into messages. Termination is TWO exits: success (model returns pure text) and budget (`maxTurns` / `maxToolCalls` — in AptKit at 8 and 6). The budget exit is not hardening — it's part of the skeleton, because nothing guarantees the model reaches success. Without it a loop burns tokens silently.

Diagram: the four-part kernel + the two exits.
Anchor: `node_modules/@aptkit/core/.../run-agent-loop.js:25-105`.

**Q: What breaks if you remove maxTurns?**
A: The model can cycle tool calls indefinitely — same query, slight variations, no convergence. On Vercel we'd hit the 300s wall clock and 504 the request; on a raw runtime the loop runs until token budget or infra gives out. In diagnose mode that would be ~$0.09 per case ballooning to hours-long stalls. AptKit picks 8 turns because empirically the diagnostic path converges in 5-8 turns; anything past that is thrash, and the graceful forceFinal produces a "based on evidence so far…" diagnosis instead of a 500.

Diagram: the loop counter incrementing past 8, forceFinal firing, strip tools, produce final.
Anchor: `run-agent-loop.js:27-32` (the `forceFinal` branch).

## See also

- `01-chains-vs-agents.md` — when to reach for this kernel at all.
- `03-react.md` — the default prompt shape *inside* the step function.
- `04-agent-infrastructure/05-guardrails-and-control.md` — the BudgetTracker as a control envelope around this kernel.
- Cross-reference: `.aipe/study-ai-engineering/04-agents-and-tool-use/` for the ReAct step-function mechanics.
