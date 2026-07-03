# The agent loop skeleton

*Industry names: agent control loop / agent kernel · Language-agnostic*

## Zoom out

```
  Zoom out — every named pattern in this section is this kernel

  ┌─ Section 01 files ──────────────────────────────────┐
  │  chains-vs-agents  → is there a loop at all?         │
  │  ★ AGENT LOOP SKELETON ★  → what's inside the loop  │ ← we are here
  │  react            ┐                                  │
  │  plan-and-execute │  each is this skeleton with a    │
  │  reflexion        │  different step() function       │
  │  tree-of-thoughts │                                  │
  │  routing         ┘                                   │
  └─────────────────────────────────────────────────────┘
```

## Zoom in

Before we name any pattern, isolate the kernel they all share. ReAct, plan-and-execute, reflexion, and every SECTION C topology are this same skeleton with a different step function. Teach it once here so every other file can refer back.

## Structure pass

Layers of the loop: **the outer harness** (deterministic — retries, budget, logging) — **the loop body** (LLM call + tool execution) — **the tool** (deterministic side effect or query).

Axis to hold constant: **what breaks if this part is missing?**

That axis is the whole point of this file. Each of the four parts below is named by what breaks without it — not by definition.

## How it works

### Move 1 — the mental model

An agent loop is `while (not done) { pick, do, observe }`. That's it. What makes it dangerous is the "not done" — nothing guarantees the model ever emits done, so the loop needs two exit conditions, not one. Miss the second one and your agent burns tokens in a silent cycle.

```
  The kernel — the smallest thing that is still an agent

  ┌──────────────────────────────────────────────────────┐
  │  runLoop(state, tools):                              │
  │    while not done:                                   │
  │      action = step(state)      ← the only smart part │
  │      if action.is_final:                             │
  │        return action.output    ← success exit        │
  │      result = execute(action, tools)                 │
  │      state  = update(state, result)                  │
  │      if budget_exceeded(state):                      │
  │        return fallback(state)  ← budget exit         │
  └──────────────────────────────────────────────────────┘
```

### Move 2 — the four load-bearing parts, each by what breaks

**State (accumulate).** Without it, every turn is amnesiac and you have N independent LLM calls, not a loop. State is what makes it a loop.

In this repo: aptkit carries state as a `ModelMessage[]` inside the agent (see `AnthropicModelProviderAdapter.complete()` in `lib/agents/aptkit-adapters.ts`). Each turn appends assistant messages + tool_result blocks. Miss the append and turn 2's model call has no idea what happened in turn 1.

**Step function (the single LLM call).** Without it, nothing chooses the next action. This is the only "smart" part; everything else is plumbing. Every named pattern below (ReAct, plan-and-execute, reflexion) is a different way to prompt this one call.

In this repo: the model is Sonnet 4.6 (`AGENT_MODEL` in `lib/agents/base.ts`), dispatched via `anthropic.messages.create(...)` in the adapter. The system prompt (aptkit-owned, per agent role) shapes how the model decides.

**Execute (run the tool, feed the result back).** The model emits *intent* — a `ToolUseBlock` saying "call execute_analytics_eql with these args." The harness runs it via the `DataSource`, wraps the result in a `tool_result` block, appends it to state. The model never touches the tool directly, and that boundary IS the control / safety story.

In this repo: `BloomingToolRegistryAdapter.executeToolCall()` in `lib/agents/aptkit-adapters.ts` — it calls `dataSource.callTool(...)`, catches errors, wraps them in the tool_result shape aptkit expects.

**Termination — TWO exits, both required.** This is the part people forget.

```
  Termination — TWO exits, and naming both is the point

  ┌─ success exit ──────────────────────────────┐
  │  model emits final structured output        │
  │  (e.g. Diagnosis JSON — action.is_final)    │
  └─────────────────────────────────────────────┘
  ┌─ budget exit ───────────────────────────────┐
  │  max iterations reached (aptkit cap)        │
  │  OR total tokens/USD past the ceiling       │
  │  (BudgetTracker.exceeded()) → fallback       │
  └─────────────────────────────────────────────┘
```

The success exit is obvious. The budget exit is the one that matters — nothing guarantees the model ever reaches the success exit. It can cycle tool calls indefinitely. The cap is not bolt-on hardening; it is part of the skeleton.

In this repo, the budget exit lives in `lib/agents/aptkit-adapters.ts:60`:

```ts
async complete(request: ModelRequest): Promise<ModelResponse> {
  // Phase-3 budget-ceiling gate: check BEFORE dispatching the API call
  // so a runaway loop can't burn additional cost after the ceiling has
  // already been hit.
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }
  // … dispatch anthropic.messages.create
}
```

The `BudgetTracker` (in `lib/agents/budget.ts:33-70`) accumulates input+output tokens, converts to USD via `estimateAnthropicCost`, and answers `exceeded()`. The route handler creates one tracker per investigation and passes it via `hooks.budget` — the same tracker is shared across diagnostic + recommendation so a runaway diagnostic can't leave a full budget for recommendation. When it throws, the route catches and emits a graceful NDJSON `error` event.

Miss this and one long-tail investigation spends $5 while the UI shows a spinner.

### Move 2 variant — single-turn vs multi-turn is not two patterns

It is the same skeleton with a different iteration count. A one-pass detector exits the `while` after one step; a multi-step retrieval loop runs it several times. Same kernel, different loop count. Don't teach these as different concepts — they aren't.

### Move 3 — the principle

Everything past the four parts is **optional hardening**, not skeleton:

- retry/backoff on tool failure
- scratchpad/memory when state outgrows the window
- step-transition logging for observability
- structured-output validation before you trust `action.is_final`

The interview-grade point: an agent is `step + execute + accumulate + terminate`, and termination needs BOTH a success condition and a hard budget. Naming the budget unprompted is the signal that you have actually shipped an agent loop, not just read about one.

**Bridge to SECTION C:** multi-agent is not a new primitive — it is N of this skeleton composed. It's only "N independent loops merged" when the agents are genuinely independent (true fan-out / fan-in). The moment one agent needs another's output you are traversing a *dependency DAG of agents* with a coordinator and a merge strategy, not running N copies of one loop. See `03-multi-agent-orchestration/`.

## Primary diagram

```
  The agent loop skeleton — the four parts and their guards

  ┌────────────────────────────────────────────────────────────────┐
  │                       runLoop(state, tools)                    │
  │                                                                │
  │                        ┌──────────────────┐                    │
  │  ┌───────────────► ┌───┤ 1. STEP          │                    │
  │  │                 │   │  the LLM call    │                    │
  │  │                 │   │  (Anthropic API) │                    │
  │  │                 │   └────────┬─────────┘                    │
  │  │                 │            │ action                       │
  │  │                 │            ▼                              │
  │  │           ┌─────┴──────────┐┌──────────────┐                │
  │  │           │ IS_FINAL? ─── yes ──► return output (SUCCESS)   │
  │  │           └────┬───────────┘└──────────────┘                │
  │  │                │ no                                         │
  │  │                ▼                                            │
  │  │           ┌────────────────┐                                │
  │  │           │ 2. EXECUTE     │  DataSource.callTool           │
  │  │           │  tool call      │                                │
  │  │           └────┬───────────┘                                │
  │  │                │ result                                     │
  │  │                ▼                                            │
  │  │           ┌────────────────┐                                │
  │  │           │ 3. UPDATE STATE│  append tool_result to msgs    │
  │  │           └────┬───────────┘                                │
  │  │                │                                            │
  │  │                ▼                                            │
  │  │           ┌────────────────┐                                │
  │  └───────────┤ 4. BUDGET OK?  │─── no ──► return fallback      │
  │              │  BudgetTracker │           (BUDGET EXIT)        │
  │              └────────────────┘                                │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The name "agent loop" is used loosely; more precise is "tool-using reasoning loop." The pattern goes back to AI-lab research on planning + reactivity (SOAR, ACT-R), and the modern shape crystallized when ChatGPT plugins exposed the observation-in / action-out interface at scale (2023). Every current framework — LangGraph, AutoGen, CrewAI, aptkit, the OpenAI Assistants API — implements this kernel plus a set of hardening choices. Understanding the kernel means you can read any of them in an afternoon.

The most important recent refinement is the budget primitive as a first-class concept (rather than just "we retry 3 times"). It's what turns a demo into something you can ship — because the failure mode of an unbounded loop isn't slow, it's expensive-and-silent.

## Interview defense

**Q: What are the parts of an agent loop?**

Step, execute, accumulate, terminate. The one people miss is termination — it's not one condition, it's two: success (model emits done) and budget (max iterations, max tokens, max USD). If you don't ship the budget exit, nothing guarantees the loop ever ends.

In this repo the budget exit is `BudgetTracker.exceeded()` checked before every model call in the adapter (`lib/agents/aptkit-adapters.ts:60`). One tracker per investigation, shared across diagnostic and recommendation, so a runaway diagnostic can't burn recommendation's budget.

*Anchor visual:* the four-parts diagram, with the budget guard on the return path.

**Q: When does the budget exit fire in practice?**

Two shapes I've seen. First, model can't reach a confident conclusion — keeps calling tools without emitting the final structured output. Second, the tool keeps returning something unexpected (429s, malformed JSON, silent zeroes) and the model keeps trying different queries. Both look identical from outside (spinner never stops); the budget is what makes them recoverable.

**Q: What's the difference between single-turn and multi-turn?**

Loop count. Same kernel. A one-pass classifier is the loop with `is_final=true` on turn 1. Not two patterns — one pattern, different iteration counts.

## See also

- **`01-chains-vs-agents.md`** — the boundary above this file (is there a loop at all).
- **`03-react.md`** — the specific step-function shape this repo uses.
- **`04-agent-infrastructure/05-guardrails-and-control.md`** — the full control envelope; this file argues the budget is part of the skeleton, not hardening.
- **`.aipe/study-ai-engineering/04-agents-and-tool-use/`** — mechanics of the individual tool call.
