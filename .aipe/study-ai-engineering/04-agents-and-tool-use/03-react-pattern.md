# ReAct pattern

*Industry standard — Thought → Action → Observation loop*

## Zoom out — where this concept lives

Inside each agent in this codebase, the LLM doesn't make a single call and stop. It loops: think → call a tool → observe the result → think again, until it has enough to answer. That's the ReAct pattern. The loop itself lives in `@aptkit/core`; this codebase observes it via the trace hooks that turn each loop iteration into a UI event.

```
  Zoom out — ReAct inside each agent

  ┌─ Agent invocation ──────────────────────────────────────┐
  │  diagAgent.investigate(anomaly) returns one Diagnosis   │
  └──────────────────────┬──────────────────────────────────┘
                         │  inside this call:
                         ▼
  ┌─ ★ ReAct loop ★ (inside @aptkit/core) ──────────────────┐ ← we are here
  │                                                          │
  │  ┌────────────────────────────────────────────────────┐ │
  │  │  Thought    (LLM emits text reasoning)              │ │
  │  │  Action     (LLM emits tool_use block)              │ │
  │  │  Observation (your code executes tool → tool_result)│ │
  │  └─────────────────┬──────────────────────────────────┘ │
  │                    │  loop until LLM emits no tool_use   │
  │                    ▼  or call budget hits                │
  │  ┌────────────────────────────────────────────────────┐ │
  │  │  Final synthesis (LLM emits structured output)     │ │
  │  └────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** ReAct is the dominant inner loop for LLM agents — externalize reasoning between actions, so you can debug WHY the agent chose action N when the result of action N-1 came back the way it did.

## Structure pass — layers · axes · seams

**Layers:** Thought → Action → Observation → repeat.

**Axis: what's externalized to the message history?** All three. Thoughts become assistant `text` blocks. Actions become `tool_use` blocks. Observations become `tool_result` blocks. By the end of an N-iteration loop, the message history has every step the agent took, in order.

**Seam:** the LLM call boundary. After every `model.complete()` call, the loop inspects the response: if it contains a `tool_use`, execute it and append a `tool_result`, then loop. If not, the loop exits and the agent synthesizes its final answer.

## How it works

### Move 1 — the mental model

You know how a debugger lets you step through a function and watch the variables change? ReAct is that, externalized into the LLM's own message history. Each Thought is what the agent was thinking; each Action is what it did; each Observation is what it learned. The trace is a record of the agent's reasoning *as it happened*, not after the fact.

```
  The ReAct loop — kernel

  initialize: messages = [system + initial user task]

  ┌─── while not done ──────────────────────────────────────┐
  │                                                          │
  │   response = model.complete(messages, tools)             │
  │                                                          │
  │   for each block in response.content:                    │
  │     if block.type == 'text':                             │
  │       remember the Thought (assistant message)           │
  │     if block.type == 'tool_use':                         │
  │       result = tool_registry.callTool(block.name, block.input)│
  │       append { tool_use_id, content: result } as tool_result │
  │                                                          │
  │   if no tool_use blocks this turn:                       │
  │     done = true   (LLM declined to act → final answer)   │
  │                                                          │
  │   if iterations >= budget:                               │
  │     done = true   (forced — see Move 2 Part 4)           │
  │                                                          │
  └──────────────────────────────────────────────────────────┘

  return synthesized final output (Anomaly[], Diagnosis, etc.)
```

The kernel is **5 parts**, each one breaks the loop if you remove it:

  1. **Message history that accumulates.** Without it, each `complete()` call has no memory of what happened before; the loop just makes the same call forever.
  2. **Tool execution + result feedback.** Without it, the LLM emits `tool_use` but never sees the result; it can't make progress.
  3. **Done-condition (no tool_use this turn).** Without it, the loop runs forever once the LLM decides it's done.
  4. **Budget cap.** Without it, an LLM that gets stuck calling the same tool repeatedly burns infinite tokens.
  5. **Final synthesis.** Without it, you have a trace but no typed output for the caller.

### Move 2 — the step-by-step walkthrough

**Part 1 — the loop runs in AptKit; this codebase observes it.**

The actual loop code is inside `@aptkit/core`. From this codebase's vantage point, you can see the loop happen through the trace events. `BloomingTraceSinkAdapter.emit()` at `lib/agents/aptkit-adapters.ts:108-128` translates each loop iteration's events:

```typescript
emit(event: CapabilityEvent): void {
  if (event.type === 'step') {
    this.hooks.onText?.(event.content);                    // ← Thought (text)
    return;
  }

  if (event.type === 'tool_call_start') {                  // ← Action (tool_use)
    const toolCall = this.toBloomingToolCall(event);
    // ...
    this.hooks.onToolCall?.(toolCall);
    return;
  }

  if (event.type === 'tool_call_end') {                    // ← Observation (tool_result)
    const toolCall = this.activeToolCalls.get(event.toolName)?.shift() ?? this.toBloomingToolCall(event);
    toolCall.durationMs = event.durationMs;
    toolCall.result = event.result;
    toolCall.error = event.error;
    this.hooks.onToolResult?.(toolCall);
  }
}
```

Three event types correspond to ReAct's three steps: `step` (Thought), `tool_call_start` (Action), `tool_call_end` (Observation).

**Part 2 — the trace is the product.**

The UI's `StatusLog` panel renders the trace as it streams. From `app/api/agent/route.ts:193-211`:

```typescript
const hooksFor = (agent: AgentName) => ({
  onText: (t: string) => {
    if (t.trim()) stepFor(agent, 'thought', t);             // → 'reasoning_step' event
  },
  onToolCall: (tc: ToolCall) => send({
    type: 'tool_call_start', toolName: tc.toolName, agent,  // → 'tool_call_start' event
  }),
  onToolResult: (tc: ToolCall) => send({
    type: 'tool_call_end', toolName: tc.toolName, agent,    // → 'tool_call_end' event
    durationMs: tc.durationMs ?? 0,
    result: trunc(tc.result),
    error: tc.error,
  }),
});
```

Each agent loop iteration produces 2-3 NDJSON events on the wire (one or more `reasoning_step`, one `tool_call_start`, one `tool_call_end`). The user sees the agent's reasoning happen.

**Part 3 — an example trace, walked.**

```
  One diagnostic investigation, ReAct trace

  iter 1 ─ Thought:    "I need to check if revenue dropped globally or in a specific country…"
        ─ Action:     execute_analytics_eql(eql='select count event purchase by customer.country…')
        ─ Observation: { 'USA': 1024, 'CAN': 220, 'GBR': 180, ... }

  iter 2 ─ Thought:    "USA stands out. Let me check the funnel for USA users…"
        ─ Action:     get_funnel(funnel_id='checkout', segment={ country='USA' })
        ─ Observation: { view: 14200, cart: 2100, checkout: 800, purchase: 200 }

  iter 3 ─ Thought:    "Cart-to-checkout dropped from typical 50% to 38%. Let me check if a campaign changed…"
        ─ Action:     list_email_campaigns(start_date='2026-04-01', end_date='2026-06-28')
        ─ Observation: [{ name:'Spring USA promo', end_date:'2026-05-15' }, ...]

  iter 4 ─ Thought:    "Spring USA promo ended May 15. Cart-to-checkout drop started June 1. Likely related."
        ─ (no tool_use) → loop exits

  Final synthesis: Diagnosis { conclusion: "Cart abandonment in USA spiked
                               after the Spring promo ended…",
                               hypothesesConsidered: [...] }
```

Four iterations, three tool calls, one final synthesis. The trace shows WHY each tool was called — the agent's reasoning is externalized.

**Part 4 — the budget cap is load-bearing.**

The monitoring agent's prompt at `lib/agents/legacy-prompts/monitoring.md:18` enforces a hard cap:

```
3. Make at most 6 tool calls total, then stop and return your JSON answer. Be decisive — do NOT re-run variations of the same query. After 6 calls you will be forced to answer with whatever you have.
```

Without the cap, an agent that gets stuck in a "let me try one more variation" pattern burns tokens forever. With it, the loop exits at iteration 6 even if the LLM wants to keep going.

This is the kernel's part-4: drop the budget cap and any LLM that gets stuck calling the same tool repeatedly burns infinite tokens. AptKit's reusable agents each carry their own internal budget; the prompt cap is belt-and-suspenders.

### Move 3 — the principle

**Externalize reasoning between actions and you can debug WHY.** The trace turns a black-box agent into a glass-box agent. When the diagnosis is wrong, you can read the trace and see exactly which observation the agent misread. ReAct is the structural commitment to "no decision is made without leaving a record."

## Primary diagram — the full recap

```
  ReAct loop in this codebase, with the trace hooks attached

  ┌─ Caller (e.g. diagAgent.investigate(anomaly)) ──────────────┐
  │  initial messages = [system + user "investigate this"]      │
  └──────────────────────┬──────────────────────────────────────┘
                         │  AptKit loop starts
                         ▼
  ┌─ ReAct iteration ───────────────────────────────────────────┐
  │                                                              │
  │  ┌─ model.complete(messages, tools) ─┐                      │
  │  │                                    │                      │
  │  │  response: ContentBlock[]          │                      │
  │  │   - text  ("I need to check…")     │ → trace.emit({ type:'step', content:'I need to…' })
  │  │   - tool_use { name, input }       │ → trace.emit({ type:'tool_call_start', ... })
  │  └────────────────────────────────────┘                      │
  │                  ↓                                            │
  │  for each tool_use:                                           │
  │     toolRegistry.callTool(name, input)                        │
  │       → durationMs, result                  │ → trace.emit({ type:'tool_call_end', ... })
  │     append { type:'tool_result', content } to messages        │
  │                  ↓                                            │
  │  if no tool_use this turn OR budget hit → break loop          │
  │  else loop again                                              │
  └──────────────────────────────────────────────────────────────┘
                         │
                         ▼
  ┌─ Final synthesis ───────────────────────────────────────────┐
  │  reduce accumulated tool results into typed output          │
  │  (Anomaly[], Diagnosis, Recommendation[], string)           │
  └─────────────────────────────────────────────────────────────┘
                         │
                         ▼  through BloomingTraceSinkAdapter
                         ▼  through hooks
                         ▼  through route layer NDJSON
                         ▼  to UI StatusLog
```

## Elaborate

**Why ReAct's reasoning text matters even if it's not "real" reasoning.** The model isn't actually reasoning — it's predicting tokens that look like reasoning. But empirically, *forcing* the model to emit those tokens before its action improves action quality (the "let's think step by step" finding from CoT prompting). The reasoning text is a structural lever: it gets the model to write into its own context what it's about to do, which constrains the action that follows.

**Why this codebase doesn't roll its own ReAct loop.** Three reasons:

  1. **The loop is non-trivial to get right.** Budget enforcement, error recovery, infinite-loop detection, tool-result truncation — all need to live in the loop. AptKit's agents (`AnomalyMonitoringAgent`, `DiagnosticInvestigationAgent`, etc.) implement all of it.
  2. **Per-agent variants.** Monitoring's loop is checklist-driven; diagnostic's is hypothesis-testing; recommendation's is feature-selection. Each tuned variant is a class in AptKit.
  3. **Adapter glue is cheap.** 206 LOC in `aptkit-adapters.ts` is the entire boundary between this codebase and the loop machinery.

**Where the trace would mislead you.** The reasoning text is the LLM's *narration*, not a guaranteed cause-and-effect explanation. If the agent says "I need to check X" and then calls tool Y, both came from the same model call — the reasoning isn't necessarily what *drove* the tool choice. Read the trace as "what the model decided to externalize about its decision," not as a deterministic explanation.

## Project exercises

### Exercise — Surface ReAct iteration count in the per-call log

  → **Exercise ID:** B4.3
  → **What to build:** Track per-agent-invocation iteration count via the trace sink (count `tool_call_start` events) and emit it in the per-phase log line at the end of the agent's run. Surface as `{ iterations: 6 }` alongside the existing `durationMs`.
  → **Why it earns its place:** budget cap is enforced in the prompt and the library, but the codebase has no visibility into "did the agent hit the cap?" Knowing the iteration count distribution per-agent tells you whether the budget is tight (consistently hits cap → raise it or split the task) or loose (rarely uses 3+ iterations → maybe consolidate).
  → **Files to touch:** `lib/agents/aptkit-adapters.ts` (extend `BloomingTraceSinkAdapter` to count iterations and expose via getter), `app/api/agent/route.ts` + `app/api/briefing/route.ts` (read iteration count and add to the phase log).
  → **Done when:** the per-route summary log line now carries `{ iterations: N }` for each agent invocation, and the test suite has a unit test for the counter logic.
  → **Estimated effort:** 1–4hr.

## Interview defense

**Q: "What's actually inside your agent loop?"**

ReAct — Thought, Action, Observation, repeat. Each LLM call returns content blocks: text becomes Thought (assistant message), `tool_use` blocks become Action (executed by my code), the result feeds back as Observation (`tool_result` block) on the next call. The loop exits when the LLM emits no `tool_use` (it's done) or when the budget cap fires (6 calls for monitoring, varies per agent). The loop itself lives in `@aptkit/core`; this codebase observes it via trace hooks that turn each iteration into UI events streamed to the browser.

The trace is the product surface — users watch the agent's reasoning happen in `StatusLog`.

*Anchor: "Loop in AptKit; trace hooks at `aptkit-adapters.ts:108`; budget caps in the prompt + library."*

**Q: "What's the most-forgotten part of a ReAct loop?"**

The budget cap. People remember "loop until LLM emits no tool_use" — that's the common-case exit. They forget the LLM can get stuck in a "let me try one more variation" pattern, calling the same tool with slightly different args forever. Without a hard iteration cap, that's infinite tokens. Monitoring's prompt enforces 6 max calls; AptKit's library carries its own internal cap. Belt-and-suspenders is the right shape — neither alone is enough.

*Anchor: "Budget cap is the load-bearing part people forget. Prompt + library both enforce."*

## See also

  → `02-tool-calling.md` — the Action part of the loop in detail
  → `06-error-recovery.md` — what happens when an Observation comes back as an error
  → `05-evals-and-observability/04-llm-observability.md` — the trace as telemetry
  → `01-llm-foundations/05-streaming.md` — how trace events stream live to the UI
