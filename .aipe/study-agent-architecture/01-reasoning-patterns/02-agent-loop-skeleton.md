# The agent loop skeleton

*Industry name: agent loop / tool-use loop — Industry standard. The kernel.*

The single most load-bearing file in this guide. Every agent in this repo is the same kernel with a different prompt. Learn this and you understand all four.

## Zoom out — where this concept lives

The kernel lives one layer down from the Blooming wrapper classes — inside `@aptkit/core@0.3.0`'s `runAgentLoop`. The wrappers (`MonitoringAgent`, `DiagnosticAgent`, …) are 20-50 LOC each; the loop they all call is 80 lines in one file in the AptKit package.

```
  Where the kernel lives in blooming insights

  ┌─ UI / Service layers ────────────────────────────────────────┐
  │  route.ts → new DiagnosticAgent(...).investigate(anomaly)   │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Agent wrapper layer (lib/agents/diagnostic.ts) ─────────────┐
  │  thin: instantiates AptKit class, awaits its method          │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ AptKit class layer (@aptkit/agent-diagnostic-investigation) ┐
  │  builds the prompt, picks the tool policy, then calls...     │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ The kernel (@aptkit/runtime/run-agent-loop.ts) ─★ HERE ★ ───┐
  │  while not done {                                             │
  │    step → execute → accumulate → terminate                    │
  │  }                                                            │
  └──────────────────────────────────────────────────────────────┘
```

## Structure pass — one axis, four parts

Hold one axis constant and trace it across the loop: **what breaks if you remove this part?** Four parts make the kernel; lose any one and it's not an agent loop anymore.

```
  Four parts, named by what breaks if removed

  ┌─ state (accumulate) ───────────────────────────────────────┐
  │  drop it → every turn is amnesiac; you have N independent  │
  │  LLM calls, not a loop. STATE IS what makes it a loop.     │
  ├─ step (model.complete) ────────────────────────────────────┤
  │  drop it → nothing picks the next action. The only "smart" │
  │  part; everything else is plumbing.                         │
  ├─ execute (tools.callTool) ─────────────────────────────────┤
  │  drop it → the model emits intent into the void; nothing   │
  │  happens. The harness runs the tool; the model never does. │
  │  This boundary IS the safety story.                         │
  ├─ termination (two exits!) ─────────────────────────────────┤
  │  drop it → the loop runs forever. NOT ONE EXIT — two:      │
  │   success: model emits text with no tool_use block          │
  │   budget:  maxToolCalls or maxTurns reached → force final   │
  │  the budget exit is the one people forget.                  │
  └────────────────────────────────────────────────────────────┘
```

That's the skeleton. Everything else — retry/backoff, caching, observability, structured-output validation — is hardening layered on top. Naming the budget exit unprompted is how you signal you've actually shipped an agent loop.

## How it works

### Move 1 — the mental model

It's a `while` loop where the body of the loop is one LLM call plus one tool call. You already know `while` loops — `while (queue.length)` shifts an item and processes it. This is the same shape, except `step(state)` is an LLM call that decides what to dequeue next.

```
  The agent loop — kernel shape

  ┌──────────────────────────────────────────────────────┐
  │  state = []                                          │
  │  while not done {                                    │
  │    ┌─ step ──────────────────────────────────────┐  │
  │    │  action = model.complete(state)             │  │
  │    │  → returns one of:                          │  │
  │    │     • text block (final answer)             │  │
  │    │     • tool_use block (action to run)        │  │
  │    └─────────────────────────────────────────────┘  │
  │                                                       │
  │    if action.is_final → return action.output         │
  │                                                       │
  │    ┌─ execute ───────────────────────────────────┐  │
  │    │  result = tools.callTool(action)            │  │
  │    │  → real side-effect: runs the tool         │  │
  │    └─────────────────────────────────────────────┘  │
  │                                                       │
  │    ┌─ accumulate ────────────────────────────────┐  │
  │    │  state.push(action, result)                 │  │
  │    └─────────────────────────────────────────────┘  │
  │                                                       │
  │    ┌─ terminate (budget) ────────────────────────┐  │
  │    │  if toolCalls.length >= maxToolCalls:       │  │
  │    │    force a tools-less synthesis turn → exit │  │
  │    └─────────────────────────────────────────────┘  │
  │  }                                                    │
  └──────────────────────────────────────────────────────┘
```

### Move 2 — walk it part by part

The kernel from AptKit's source. Each part below is one of the four load-bearing skeleton parts; the code is from `@aptkit/runtime`'s `runAgentLoop`. The Blooming wrappers add no loop logic — the loop is wholly inherited.

**Part 1: state (accumulate)**

State is the Anthropic message array. Every turn appends the assistant's response and the tool results, so the next call has the full history. Strip this and every turn is independent — that's not a loop, it's N calls.

In Blooming's `base-legacy.ts:107-109` (which mirrors AptKit's kernel one-for-one for revertibility):

```typescript
const messages: Anthropic.Messages.MessageParam[] = [
  { role: 'user', content: userPrompt },
];
```

Then on each turn:

```typescript
// base-legacy.ts:138 — append the assistant turn
messages.push({ role: 'assistant', content: res.content });
// base-legacy.ts:205 — append the tool results as the next user turn
messages.push({ role: 'user', content: toolResults });
```

What breaks without it: the model on turn 3 has no memory of turn 1's tool result. It would re-query the same thing or hallucinate the answer.

**Part 2: step (the single LLM call)**

One call per turn. The model gets the full state, the system prompt, the tools, and emits content blocks. From `base-legacy.ts:124-134`:

```typescript
const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
  model: AGENT_MODEL,
  max_tokens: maxTokens,
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
};
if (!forceFinal) params.tools = toolSchemas;
const res = await anthropic.messages.create(params, signal ? { signal } : undefined);
```

Note the `if (!forceFinal) params.tools = toolSchemas` — when the loop is forcing termination, the tools are omitted so the model MUST emit text instead of another tool call. This is the budget exit's mechanism, not its decision.

What breaks without it: there's no decider. The loop has nothing to wait on; nothing knows what tool to call next.

**Part 3: execute (run the tool, feed the result back)**

The model emits `tool_use` blocks; the harness runs them through the injected `dataSource.callTool` and feeds the result back as a `tool_result`. From `base-legacy.ts:162-201`:

```typescript
for (const tu of toolUses) {
  const tc: ToolCall = { id: tu.id, agent, toolName: tu.name, args: tu.input as Record<string, unknown> };
  onToolCall?.(tc);
  let isError = false;
  let resultContent: string;
  try {
    const { result, durationMs } = await dataSource.callTool(
      tu.name,
      tu.input as Record<string, unknown>,
      signal ? { signal } : undefined,
    );
    tc.result = result;
    tc.durationMs = durationMs;
    resultContent = truncate(JSON.stringify(result));
  } catch (err) {
    isError = true;
    const message = err instanceof Error ? err.message : String(err);
    tc.error = message;
    resultContent = truncate(JSON.stringify({ error: message }));
  }
  toolCalls.push(tc);
  onToolResult?.(tc);
  toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: resultContent, ...(isError ? { is_error: true } : {}) });
}
```

The boundary is critical: **the model never touches `dataSource.callTool` directly**. It emits intent (a `tool_use` block); the harness validates the name + args and runs it. That's the control story. The model can hallucinate a tool call to `delete_everything` — the harness either has it in the tool policy or it doesn't.

What breaks without it: the model says "I'd call execute_analytics_eql with this query" — and nothing runs. No data comes back. The loop has nothing to accumulate.

**Part 4: termination — TWO exits, both required**

Success exit (the obvious one): the model returns content with no `tool_use` blocks, meaning it decided it has enough to answer. From `base-legacy.ts:149-157`:

```typescript
const toolUses = res.content.filter(
  (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
);
if (toolUses.length === 0) {
  finalText = textBlocks.map((b) => b.text).join('');
  break;
}
```

Budget exit (the one that matters): on the final allowed turn OR once `maxToolCalls` is hit, the loop omits `tools` from the request so the model has no choice but to emit text. From `base-legacy.ts:120-133`:

```typescript
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;
// ...
if (!forceFinal) params.tools = toolSchemas;
```

And the synthesis instruction is appended to the system prompt on this turn so the model knows to STOP querying and synthesize:

```typescript
// base-legacy.ts:230-232 (buildSynthesisInstruction)
export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}
```

What breaks without it: the model can cycle tool calls indefinitely. Nothing guarantees it'll ever say "I'm done." An agent shipped without the budget exit burns tokens in a silent loop until the request times out. **The cap is not bolt-on hardening; it is part of the skeleton.**

**The numbers in this repo:**

| Agent | maxTurns | maxToolCalls | Synthesis instruction (excerpt) |
|---|---|---|---|
| Monitoring | 8 | 6 | "Stop querying now and output your final answer. Respond with ONLY a JSON array..." |
| Diagnostic | 8 | 6 | "Stop investigating now and output your final answer. Respond with ONLY a single JSON object..." |
| Recommendation | 6 | 4 | "Stop querying now and output your final answer. Respond with ONLY a JSON array of at most 3 recommendation objects..." |
| Query | 8 | 6 | "Now answer the user question directly and concisely in plain prose..." |

Recommendation's tighter budget reflects what it's doing: mostly reasoning from a diagnosis it already has, with a few tool calls to check existing scenarios/segments. The others explore more, so they get more budget.

### Move 2.5 — current state vs the legacy alternative

This repo carries two implementations of the kernel side by side, and the active path is clear:

```
  Current state — what runs vs what's preserved

  ACTIVE PATH:
  ┌──────────────────────────────────────────────────────┐
  │  lib/agents/{monitoring,diagnostic,recommendation,    │
  │  query}.ts  → 20-50 LOC each, instantiate AptKit class│
  │              ↓                                         │
  │  @aptkit/agent-*  → builds prompt + tool policy + calls│
  │              ↓                                         │
  │  @aptkit/runtime/runAgentLoop  → the kernel            │
  └──────────────────────────────────────────────────────┘

  PRESERVED (REVERTIBILITY ONLY — not called by active path):
  ┌──────────────────────────────────────────────────────┐
  │  lib/agents/base-legacy.ts:86-222                     │
  │  Blooming's hand-rolled runAgentLoop, identical kernel│
  │  shape. Kept so a one-line `import` swap reverts the  │
  │  AptKit migration if needed.                          │
  └──────────────────────────────────────────────────────┘
```

Both implementations have the same four parts. Reading them side by side is the cheapest way to convince yourself the kernel really is the kernel — different code, same skeleton.

### Move 3 — the principle

An agent is `step + execute + accumulate + terminate`, and termination needs BOTH a success condition and a hard budget. Naming the budget exit unprompted is the signal that you've actually shipped an agent loop, not just read about one. Production agents die the same death every time: model picks a tool that's flaky → tool errors → model retries → tool errors → repeat until budget burns. The cap is what makes the loop *finite*; the synthesis instruction is what makes the cap *produce output*.

## Primary diagram

The full skeleton with all four parts labelled, plus the two exits, plus the synthesis turn:

```
  The agent loop kernel — every loop in this repo

  ┌──────────────────────────────────────────────────────────────┐
  │  AptKit runAgentLoop  (@aptkit/runtime/run-agent-loop.ts)    │
  │                                                                │
  │  state = [user message]                                       │
  │  toolCalls = []                                               │
  │                                                                │
  │  for turn in 0..maxTurns {                                    │
  │                                                                │
  │    forceFinal = (turn == maxTurns-1)                          │
  │              || (toolCalls.length >= maxToolCalls)            │
  │                                                                │
  │    ┌─ STEP ────────────────────────────────────────────────┐  │
  │    │  params = { system, messages, tools (UNLESS forceFinal),│  │
  │    │             model, maxTokens }                           │  │
  │    │  if forceFinal: append synthesisInstruction to system   │  │
  │    │  res = anthropic.messages.create(params, {signal})      │  │
  │    └────────────────────────────────────────────────────────┘  │
  │                                                                │
  │    state.push({assistant: res.content})                       │
  │                                                                │
  │    ┌─ SUCCESS EXIT ────────────────────────────────────────┐  │
  │    │  if no tool_use blocks → return                       │  │
  │    └────────────────────────────────────────────────────────┘  │
  │                                                                │
  │    ┌─ EXECUTE ─────────────────────────────────────────────┐  │
  │    │  for each tool_use block:                              │  │
  │    │    result = dataSource.callTool(name, args, {signal}) │  │
  │    │    toolCalls.push(...); tool_result block ready       │  │
  │    └────────────────────────────────────────────────────────┘  │
  │                                                                │
  │    ┌─ ACCUMULATE ──────────────────────────────────────────┐  │
  │    │  state.push({user: tool_result blocks})                │  │
  │    └────────────────────────────────────────────────────────┘  │
  │  }                                                            │
  │  ↑ BUDGET EXIT happens via forceFinal at top of next turn     │
  │                                                                │
  │  ┌─ RECOVERY (optional, one extra tool-less turn) ────────┐  │
  │  │  if parseResult(finalText) === null:                    │  │
  │  │    runRecoveryTurn with recoveryPrompt(toolCalls)       │  │
  │  └─────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The loop shape is older than ReAct. It's the same thing you'd build for an iterative numerical solver: candidate solution → score → refine → terminate. ReAct's 2022 contribution was the realization that "the action" could be a tool call against the outside world (not just an internal refinement), and that the model could reason out loud about which tool to call — which gave you observability into the loop. The kernel didn't change; the action expanded.

The forced-final synthesis turn is the production-scarred addition. Early agent implementations would let the model loop forever, hit the request timeout, and return nothing — wasted tokens and a UX failure. Forcing the final turn to drop the tools guarantees the model emits *something* even if it would rather keep querying. This is why every AptKit agent in this repo has a `synthesisInstruction` baked in at the class level — it's not optional.

The recovery turn (one extra tool-less call when `parseResult` returns null) is the second production-scarred addition. The model sometimes emits text that doesn't match the expected JSON shape — usually because the synthesis instruction got drowned by the conversation history. A dedicated recovery prompt with just the evidence and the schema gets a clean second attempt.

## Interview defense

**Q: "Walk me through your agent loop. What are the parts?"**

A: Four parts, and naming the fourth is the point. State (accumulate), step (the one LLM call per turn), execute (the harness runs the tool, the model never does), and **termination — two exits, both required**: success when the model emits text with no tool_use block, and budget when `maxToolCalls` is reached. The budget exit triggers a forced-final turn where the loop drops the tools from the request so the model has to synthesize. In this repo: monitoring/diagnostic/query get 8 turns and 6 tool calls; recommendation gets 6 and 4 because it's reasoning from a diagnosis it already has.

Diagram I'd sketch:

```
  while not done {
    step → execute → accumulate
  }
  exits: success (no tool_use) OR budget (maxToolCalls → force synth)
```

Anchor: "the budget exit is what people forget. Without it, one flaky tool plus a loop equals the entire budget burned on retries."

**Q: "What would break first if I deleted the maxToolCalls cap?"**

A: The model would cycle tool calls until the Anthropic request timed out, return nothing, and the route would emit an error after burning ~$2-5 in tokens. We've seen this in production-scarred postmortems from other systems: the model picks a tool that 429s, sees the error, retries, sees the same error, retries, repeat. The cap turns "infinite retry" into "6 retries then synthesize what you've got." The synthesis instruction is the second half of the fix — without it, the forced-final turn still wouldn't produce parseable JSON; with it, the model knows it's the last turn and the format it has to hit.

## See also

- [`03-react.md`](./03-react.md) — the prompt shape that fills the kernel
- [`../04-agent-infrastructure/05-guardrails-and-control.md`](../04-agent-infrastructure/05-guardrails-and-control.md) — the full control envelope around the loop
- [`../04-agent-infrastructure/04-agent-evaluation.md`](../04-agent-infrastructure/04-agent-evaluation.md) — what the trajectory looks like when you read it back
- [`../05-production-serving/03-per-tool-circuit-breaking.md`](../05-production-serving/03-per-tool-circuit-breaking.md) — what the budget exit doesn't catch
