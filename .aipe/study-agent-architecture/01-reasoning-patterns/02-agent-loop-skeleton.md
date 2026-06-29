# The agent loop skeleton

**Industry standard.** The kernel every named reasoning pattern instantiates.

## Zoom out, then zoom in

Sits in the runtime — below the agent class, above the model provider. Every named pattern (ReAct, plan-and-execute, reflexion, every multi-agent topology) is this skeleton with a different step function or composition rule.

```
  Zoom out — where this concept lives

  ┌─ Reasoning layer ───────────────────────────────┐
  │  MonitoringAgent.scan()  →  AptKit class .scan()│
  └────────────────────────────┬────────────────────┘
                               │  delegates to
  ┌─ Runtime layer ───────────▼────────────────────┐
  │  ★ runAgentLoop (the skeleton) ★                │ ← we are here
  │  for (turn = 0; turn < maxTurns; ...)           │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ Provider layer ──────────▼────────────────────┐
  │  ModelProvider.complete()  + ToolRegistry.callTool()│
  └─────────────────────────────────────────────────┘
```

Chains-vs-agents told you "is there a loop at all." This file tells you "what's in the loop, and which parts are load-bearing." Same skeleton runs the monitoring scan, the diagnostic investigation, and the recommendation proposal — three agents, one shape.

## Structure pass

Layers: model call (one turn) → message accumulator (the running conversation) → tool harness (executes the model's emitted intent).

**Axis traced — "what breaks if I remove this?":** the load-bearing test from the spec. Removing the message accumulator: every turn is amnesiac, you get N independent calls. Removing the tool harness: the model can ask for tools but nothing runs them. Removing the iteration cap: the model can loop forever.

**Seam — the model never touches the tool directly.** The model emits a `tool_use` intent in its response content; the harness reads that, calls the tool, appends the result as a `tool_result` block to the next user message. That boundary IS the safety story (no model-to-tool side channel) and the observability story (every call passes through the trace sink).

## How it works

### Move 1 — the mental model

You know the shape of `Array.prototype.reduce` — a callback runs against each element, an accumulator carries state forward, the loop terminates when there are no more elements. An agent loop is the same shape, with two extra wrinkles: the model decides whether there's a "next element" (the next tool to call), and the loop also has a hard budget cap so a runaway model can't burn forever.

```
  The kernel — the smallest thing that's still an agent

  ┌──────────────────────────────────────────────────┐
  │  state = [initial user prompt]                    │
  │  while (turn < maxTurns):                         │
  │     response = model.complete(state)              │← the step function
  │     state.push(response)                          │← accumulate
  │     if (response has no tool_use):                │
  │         return final text  ◄── SUCCESS EXIT       │
  │     for each tool_use in response:                │
  │         result = tools.callTool(name, args)       │← execute
  │         state.push(tool_result(result))           │← accumulate
  │  return fallback / final-forced text  ◄─ BUDGET   │
  └──────────────────────────────────────────────────┘
```

Four load-bearing parts. Two exits, both required. Everything else is hardening.

### Move 2 — step by step (load-bearing skeleton)

Open `node_modules/@aptkit/core/node_modules/@aptkit/runtime/dist/src/run-agent-loop.js`. The whole file is 138 lines; the kernel is lines 20-105.

#### Part 1 — state (the message accumulator)

```js
// run-agent-loop.js:22
const messages = [{ role: 'user', content: userPrompt }];
```

A single array. Every turn appends the model's response *and* (if the model called tools) the tool results as the next user message. The next `model.complete(messages)` gets the whole history — that's how the model knows what it already asked, what came back, and what it already tried.

**What breaks if you remove it:** every turn is amnesiac. The model sees only the initial prompt. It re-asks the same tool, gets the same answer, never makes progress. The thing that makes it a *loop* and not N independent calls is this accumulator.

You can see it being used: line 48 (`messages.push({ role: 'assistant', content: response.content })`) and line 104 (`messages.push({ role: 'user', content: toolResults })`).

#### Part 2 — the step function (the single LLM call)

```js
// run-agent-loop.js:29-35
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,
  maxTokens,
  signal,
});
```

One call to the model provider per turn. This is the only "smart" part of the loop — everything else is plumbing. The model gets the system prompt, the running conversation, the available tools (or no tools, on the forced final turn — see below), and emits a response that has either `text` blocks, `tool_use` blocks, or both.

The `ModelProvider` port is generic (`@aptkit/runtime/dist/src/model-provider.d.ts`); the Blooming repo adapts Anthropic to it in `AnthropicModelProviderAdapter` (`lib/agents/aptkit-adapters.ts:26-72`). Swapping providers — OpenAI, Gemini, a local model — is one adapter class, not a rewrite of the loop.

**What breaks if you remove it:** nothing decides the next action. You'd be running a `for` loop with no body. The model is what makes it an agent.

#### Part 3 — execute (run the tool, feed the result back)

```js
// run-agent-loop.js:59-103 (the per-tool-use inner block, abridged)
for (const toolUse of toolUses) {
  // trace start
  let isError = false, resultContent;
  try {
    const { result, durationMs } = await tools.callTool(
      toolUse.name, toolUse.input, { signal },
    );
    resultContent = truncate(JSON.stringify(result));
  } catch (error) {
    isError = true;
    resultContent = truncate(JSON.stringify({ error: error.message }));
  }
  // trace end
  toolResults.push({
    type: 'tool_result',
    toolUseId: toolUse.id,
    content: resultContent,
    ...(isError ? { isError: true } : {}),
  });
}
messages.push({ role: 'user', content: toolResults });
```

The model emits *intent* (an array of `tool_use` blocks naming tools and their args). The harness reads that, calls each one through the `ToolRegistry` port, packages the result back as a `tool_result` block in a user message, and goes around the loop.

**The seam:** the model never touches the tool directly. It emits a JSON-like intent; the harness owns the actual call. That boundary is what makes the per-agent tool allowlist (`anomalyMonitoringToolPolicy.allowedTools`) work — the model can only call what the harness exposes. It's also what makes the trace sink possible — every call passes through the harness, every call gets logged.

**What breaks if you remove it:** the model asks for tools but nothing runs them. You'd see infinite `tool_use` emissions in the trace and zero actual tool calls. Some hobby agent loops have this exact bug.

The Blooming bridge is `BloomingToolRegistryAdapter` (`lib/agents/aptkit-adapters.ts:75-97`):

```ts
// lib/agents/aptkit-adapters.ts:89-96
async callTool(name, args, options?) {
  const { result, durationMs } = await this.dataSource.callTool(name, args, options);
  return { result, durationMs };
}
```

Eight lines. The `DataSource` port (`lib/data-source/types.ts:63-71`) is on one side; the AptKit `ToolRegistry` port is on the other; this adapter is the bridge. The MCP transport + rate-limit retry + 60s cache all live under `dataSource.callTool` — the agent loop sees none of that.

#### Part 4 — termination (TWO exits, both required)

This is the part people actually forget. The loop has two ways out.

**Success exit** — the model said "I'm done":

```js
// run-agent-loop.js:54-57
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {
  finalText = text;
  break;
}
```

The model's response had no `tool_use` blocks. It emitted only text. The harness interprets that as "this is the final answer" and breaks out.

**Budget exit** — the `for` loop completed without `break`:

```js
// run-agent-loop.js:25
for (let turn = 0; turn < maxTurns; turn += 1) { ... }
```

`maxTurns` defaults to 8 (line 21). The monitoring agent additionally enforces `maxToolCalls = 6` (`@aptkit/agent-anomaly-monitoring/.../monitoring-agent.js:56`). When the budget runs out the loop just exits; `finalText` keeps whatever value the last successful synthesis produced (often the empty string, which is why monitoring's `tryParseAnomalies` returns `[]` on failure).

**What breaks if you remove the budget exit:** the model can loop forever. Nothing in the kernel guarantees it ever emits a tool-free response. An agent shipped without a budget cap burns tokens in a silent loop until you notice the bill. The cap is not bolt-on hardening; **it is part of the skeleton.**

Naming the budget exit unprompted in an interview signals you actually built one of these, not just read about it.

#### The forced final turn (a small twist on termination)

AptKit adds a wrinkle the canonical kernel description doesn't have. On the *last* turn (or when `maxToolCalls` is spent), it strips the tool definitions from the request *and* injects a synthesis instruction:

```js
// run-agent-loop.js:27-32 (the relevant part)
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,  // ← no tools on the final turn
  ...
});
```

Without this, the model on its last allowed turn might emit another `tool_use` (which the harness would then have to ignore, since the budget is spent). With it, the model is forced to synthesize from what it already has. The monitoring agent's synthesis instruction is "Stop querying now and output your final answer. Respond with ONLY a JSON array of anomaly objects in a json fence, or [] if nothing meaningful was found, based on the data you have already gathered" (`@aptkit/agent-anomaly-monitoring/.../monitoring-agent.js:57`). Test coverage lives in `test/agents/synthesis-instruction.test.ts`.

Everything past these four parts (plus the forced-final twist) is **optional hardening**, not skeleton:

- retry/backoff on tool failure (in `BloomreachDataSource`, not the loop)
- scratchpad/memory store when state outgrows the context window (not in this repo — the loops are short enough)
- step-transition logging for observability (the `CapabilityTraceSink` port)
- structured-output validation before you trust the final text (`tryParseAnomalies`, `tryParseDiagnosis`, etc. — applied *after* the loop returns)
- the recovery prompt (a second pass that re-asks the model with just the evidence — see `04-agent-infrastructure/04-agent-evaluation.md`)

#### Single-turn vs multi-turn isn't two patterns

It's the same skeleton with `maxTurns=1` vs `maxTurns=8`. A one-pass detector exits the `while` after one step; a multi-step retrieval loop runs it several times. The intent classifier (`classifyIntent` in `lib/agents/intent.ts`) is the single-turn case — no tools, one call, parse the answer. Same skeleton, smaller loop count.

### Move 3 — the principle

**An agent is `step + execute + accumulate + terminate`, and termination needs BOTH a success condition and a hard budget.** Naming the budget exit unprompted is the signal you built one. The four parts compose into every other named pattern: ReAct is this skeleton with a Thought-Action-Observation prompt; plan-and-execute is two of these skeletons stacked (one for planning, one per execute step); reflexion is this skeleton with the step function wrapping a critic call. Multi-agent is N of these skeletons composed — but only "N independent loops merged" when the agents are genuinely independent (true fan-out). The moment one agent's output feeds another, you're traversing a dependency DAG of agents and you need an orchestrator and a merge strategy — covered in `03-multi-agent-orchestration/`.

## Primary diagram

```
  The full skeleton — the kernel + the forced-final twist

  ┌─ runAgentLoop  (node_modules/.../runtime/.../run-agent-loop.js) ────┐
  │                                                                     │
  │  messages = [user prompt]                                           │
  │  toolCalls = []                                                     │
  │                                                                     │
  │  for turn in 0..maxTurns-1:                                         │
  │     ┌────────────────────────────────────────────────────────────┐  │
  │     │  signal.throwIfAborted()                                    │  │
  │     │  forceFinal = (last turn) OR (maxToolCalls reached)         │  │
  │     │                                                             │  │
  │     │  ┌─ model.complete ──────────────────────────────────────┐  │  │
  │     │  │ system  : base prompt (+ synthesis instr if forceFinal│  │  │
  │     │  │ messages: running conversation                        │  │  │
  │     │  │ tools   : toolSchemas (or NONE if forceFinal)         │  │  │
  │     │  └───────────────────────────────────────────────────────┘  │  │
  │     │            │                                                │  │
  │     │            ▼                                                │  │
  │     │  response = { content: [text|tool_use, ...], usage }        │  │
  │     │  emit trace(model_usage, step)                              │  │
  │     │  messages.push({role:assistant, content:response.content})  │  │
  │     │                                                             │  │
  │     │  toolUses = response.content.filter(type=tool_use)          │  │
  │     │  if toolUses.empty:                                         │  │
  │     │     finalText = text                                        │  │
  │     │     break  ◄────────────────── SUCCESS EXIT                 │  │
  │     │                                                             │  │
  │     │  for toolUse in toolUses:                                   │  │
  │     │     emit trace(tool_call_start)                             │  │
  │     │     try: result = tools.callTool(name, args, {signal})      │  │
  │     │     catch e: result = {error: e.message}, isError = true   │  │
  │     │     emit trace(tool_call_end)                               │  │
  │     │     toolResults.push(tool_result block)                     │  │
  │     │                                                             │  │
  │     │  messages.push({role:user, content:toolResults})            │  │
  │     └────────────────────────────────────────────────────────────┘  │
  │  end for  ◄──────────────────────────── BUDGET EXIT                 │
  │                                                                     │
  │  if parseResult provided: parsed = parseResult(finalText)           │
  │  if parsed == null && recoveryPrompt provided:                      │
  │      recoveryText = runRecoveryTurn(...)  // single-shot recovery    │
  │      parsed = parseResult(recoveryText)                             │
  │                                                                     │
  │  return { finalText, toolCalls, parsed }                            │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The canonical "agent kernel" diagram in most agent-framework documentation shows three boxes (Thought, Action, Observation) and a loop arrow. That's accurate for ReAct *as a prompting strategy* but it hides the load-bearing termination story. The two-exits framing — success and budget — is the part that separates an agent you can ship from an agent you can't.

The forced final turn is a less-discussed but production-essential trick. Without it, your last-turn behavior is "the model emits another tool_use; the harness discards it; the final text is whatever leaked into the response by accident." With it, the last-turn behavior is "the model has no tool option; the harness asks for synthesis explicitly; the final text is structured." The Anthropic SDK docs cover the mechanics; the *escalation* to having this in your kernel comes from one production debugging session where you watch the model burn its budget on a tool that didn't help and then emit empty text.

The recovery prompt (lines 106-114) is a smaller-stakes equivalent for structured-output failures. When `tryParseAnomalies(finalText)` returns null — the model didn't emit a valid JSON array — the harness runs a *single* additional model call with just the tool-call evidence and a "convert this to the structured form" instruction. It's bounded (one call, no tools) so it can't blow the budget; it's gated (only fires when `parseResult` returns null AND `recoveryPrompt` is provided) so it only runs when needed. In this repo, only `AnomalyMonitoringAgent` configures a `recoveryPrompt` (`monitoring-agent.js:59`); the other agents either parse trivially or accept the raw text.

## Interview defense

> **Q: Sketch the agent loop. What are the load-bearing parts?**
>
> Four parts: state, step, execute, terminate. State is the message accumulator — without it every turn is amnesiac. Step is the single model call — the only "smart" part. Execute is the tool harness — the model emits intent, the harness runs the tool. Terminate has TWO exits: success (model emits no `tool_use`, harness breaks) and budget (the `for` loop hits `maxTurns`). Both are required. Without the budget exit, the model can loop forever and burn tokens silently — that's the part people forget when they read about ReAct in a blog post and ship it.
>
> Anchor: `node_modules/.../runtime/.../run-agent-loop.js:25-57`.

> **Q: Why does the harness sit between the model and the tools?**
>
> Three reasons. Safety: the per-agent tool allowlist (`anomalyMonitoringToolPolicy.allowedTools`) only works because the model can't call anything not in the harness's registry. Observability: every call passes through the trace sink, which is how the UI gets its "how this was gathered" panel — the `CapabilityTraceSink` adapter emits `tool_call_start` / `_end` events on the NDJSON wire. Substitution: the model emits a JSON intent; the harness can swap in a fake tool registry for tests (which is how the 144 Vitest tests run without network). The model-to-tool boundary IS the control story.

> **Q: What's the forced final turn and why does AptKit have it?**
>
> On the last allowed turn — `turn === maxTurns - 1` OR `maxToolCalls` is spent — the harness strips the tool definitions from the request and prepends a synthesis instruction to the system prompt. Without it the model might emit another `tool_use` block the harness has no budget to run; the final text would be empty or partial. With it the model has no choice but to synthesize from what it already has. For the monitoring agent the synthesis instruction is literally "Stop querying now and output your final answer. Respond with ONLY a JSON array of anomaly objects, or []."
>
> Anchor: `run-agent-loop.js:27-32`; AptKit adds this on top of the canonical kernel.

## See also

- → `01-chains-vs-agents.md` — the *outer* layer that wraps this skeleton
- → `03-react.md` — the prompting strategy this skeleton runs in this repo
- → `04-agent-infrastructure/05-guardrails-and-control.md` — the full control envelope around this skeleton
- → `05-production-serving/03-per-tool-circuit-breaking.md` — what `tools.callTool` does under the hood in `BloomreachDataSource`
- → cross-reference (when generated): `study-ai-engineering`'s `04-agents-and-tool-use/03-react-pattern.md` — the prompt-level Thought-Action-Observation mechanics
