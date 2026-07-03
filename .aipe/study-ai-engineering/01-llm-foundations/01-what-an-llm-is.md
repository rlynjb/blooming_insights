# 01 — What an LLM actually is

**Type:** Industry standard. Also called: the model, the completion API, the next-token predictor.

## Zoom out, then zoom in

Where this sits in the stack — everything else in this repo hangs off this box.

```
  Zoom out — the LLM inside blooming_insights

  ┌─ UI ──────────────────────────────────────────────────────────────┐
  │  StatusLog renders reasoning_step events from the agent           │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Route (Next.js) ───────────▼─────────────────────────────────────┐
  │  app/api/agent/route.ts invokes DiagnosticAgent                   │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Agent layer ───────────────▼─────────────────────────────────────┐
  │  AptKit's DiagnosticInvestigationAgent runs a ReAct-shaped loop   │
  │  · each loop iteration calls…                                      │
  │  ┌──────────────────────────────────────────────────────────┐     │
  │  │  ★ THIS CONCEPT ★                                         │ ← we
  │  │  Anthropic.messages.create({model, messages, tools})      │  are
  │  │  the model — a function from message-list → content-list  │  here
  │  └──────────────────────────────────────────────────────────┘     │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Tools (DataSource seam) ───▼─────────────────────────────────────┐
  │  BloomreachDataSource.callTool(name, args) → EQL result            │
  └───────────────────────────────────────────────────────────────────┘
```

Now zoom in. Everyone thinks they know what an LLM is until they debug one. The right mental model is boring: **the LLM is a function.** Input is a list of messages (some text, some structured tool_use / tool_result blocks). Output is a list of content blocks (some text, some structured tool_use requests). Nothing else. Not a database. Not a planner. Not an actor with intent. The reasoning, planning, and acting all happen in a loop *around* the model — the model just produces the next content block, one turn at a time.

## Structure pass

Skeleton before mechanics — one axis (**who decides control flow?**) traced across the layers Move 2 will walk.

**Layers this concept sits inside:**
- Outer: the agent loop (AptKit's `DiagnosticInvestigationAgent.investigate()`)
- Middle: the model call (`Anthropic.messages.create()`)
- Inner: the model itself (a black-box next-token predictor)

**Axis: control flow.**
- Outer (loop): CODE decides — the loop's `while (not-done) { call model; run tools; }` is deterministic.
- Middle (model call): the MODEL decides which content blocks come back — text? tool_use? which tool?
- Inner (model): stateless — no memory of the previous call. The whole "conversation" is passed back in every turn.

**Seams:**
- The `ModelProvider` port (AptKit interface) between agent loop and model call — this is where prompt caching and budget checks are inserted. The axis flips here (CODE → MODEL).
- The Anthropic SDK boundary — HTTP request/response, the wire format.

## How it works

### Move 1 — the mental model

You've called `fetch()` a thousand times. `fetch('/api/data', {method: 'POST', body: JSON.stringify(x)}).then(r => r.json())`. Idempotent from the caller's view: same input, response comes back. `Anthropic.messages.create()` is the same shape. The catch: same input doesn't always give same output (sampling — see `03-sampling-parameters.md`), and the output includes both text blocks *and* structured "please run this tool for me" requests (`tool_use` blocks).

```
  The IO shape of a single model call

    ┌──────────────────────────┐
    │  messages: [              │  ← full conversation, every turn
    │    {role: system, ...},   │
    │    {role: user, ...},     │
    │    {role: assistant, ...},│
    │    {role: user,           │
    │     content: [            │
    │       {type: tool_result} │
    │     ]},                    │
    │  ],                        │
    │  tools: [...definitions]  │
    │                            │
    │              ─── model ───►│
    │                            │
    │  content: [                │  ← the model's next turn
    │    {type: text, ...},     │
    │    {type: tool_use,       │
    │     name: 'execute_eql',  │
    │     input: {...}},         │
    │  ]                         │
    └──────────────────────────┘

  no memory across calls. every turn re-sends the whole history.
```

### Move 2 — walk the mechanism

**One call, in one place.**

The single load-bearing call site is `AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:59-120`. The whole rest of the agent stack — the ReAct loop, the tool registry, the trace sink — reduces to arranging what goes into the messages array and what to do with the content array that comes back.

```typescript
// lib/agents/aptkit-adapters.ts:59-120 (abbreviated)
async complete(request: ModelRequest): Promise<ModelResponse> {
  // Budget gate — see 06/02-cost-optimization.md
  if (this.budget?.exceeded()) throw new BudgetExceededError(...);

  const params = {
    model: this.defaultModel,               // "claude-sonnet-4-6"
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages.map(toAnthropicMessage),
  };

  if (request.system) {
    // Prompt caching — see 06/01-llm-caching.md
    params.system = [{
      type: 'text',
      text: request.system,
      cache_control: { type: 'ephemeral' },
    }];
  }
  if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

  const response = await this.anthropic.messages.create(params, ...);

  // Budget accumulation
  this.budget?.add({
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  return {
    content: response.content.flatMap(toModelContentBlock),
    usage: { inputTokens: ..., outputTokens: ... },
    model: response.model,
  };
}
```

That's the whole interface with the model in this codebase. One method. Everything else — the loop, the tools, the streaming, the budget, the caching — is built on this ONE call.

**What's stateless.**

The model doesn't remember. If the diagnostic agent has done 5 turns of tool calls, the 6th call has to pass ALL 5 previous turns' messages back. This is where the "context window fills up" problem comes from (`02-context-and-prompts/01-context-window.md`) and why prompt caching matters so much (`06-production-serving/01-llm-caching.md` — the system prompt is stable across all 5-10 turns in one investigation, so it can be cached once and reused).

**What comes back.**

`response.content` is an array of blocks. In this repo we care about two: `{type: 'text', text: '...'}` (which the trace sink forwards as `onText` → `reasoning_step` events → the UI's `StatusLog`) and `{type: 'tool_use', id, name, input}` (which the AptKit loop then dispatches through `BloomingToolRegistryAdapter.callTool()`). A third type — `tool_result` — is what the loop puts IN a subsequent user message to hand the tool's output back.

**What the model can't do.**

It can't run the tool. That's the "brain vs hands" split (`04-agents-and-tool-use/02-tool-calling.md`). It can't call back to you. It can't retain state. It can't reach into your database. If you didn't put something in the messages array, the model doesn't know it.

### Move 3 — the principle

The model is a function; the intelligence is in the loop. Most "LLM bugs" are actually loop bugs — wrong messages passed in, tool result mishandled, budget ceiling hit, cache invalidated. When something looks wrong, the first question is not "why did the model do that" but "what messages array did the model actually see?" AptKit's trace sink exists to make that question answerable.

## Primary diagram

Everything the model call touches in this repo, in one frame.

```
  One turn of the loop — what the model sees, what comes back

  ┌─ agent loop (AptKit) ──────────────────────────────────────────────┐
  │                                                                    │
  │   messages array (grows each turn)                                 │
  │   ┌────────────────────────────────────────────────────────────┐  │
  │   │  system:    diagnostic prompt (cached ★)                    │  │
  │   │  user:      the anomaly to investigate                     │  │
  │   │  assistant: previous thought                                │  │
  │   │  user:      previous tool_result                            │  │
  │   │  ...                                                        │  │
  │   └──────────┬─────────────────────────────────────────────────┘  │
  │              │                                                    │
  │              ▼                                                    │
  │   ┌────────────────────────────────────────────────────────────┐  │
  │   │  AnthropicModelProviderAdapter.complete()                   │  │
  │   │  · budget check (throws if exceeded)                        │  │
  │   │  · wrap system with cache_control: ephemeral                │  │
  │   │  · Anthropic.messages.create(...) ← THE MODEL CALL          │  │
  │   │  · accumulate usage into budget                             │  │
  │   └──────────┬─────────────────────────────────────────────────┘  │
  │              │                                                    │
  │              ▼                                                    │
  │   response.content = [                                             │
  │     {type: 'text', text: 'I need to check payment_failure rates'}  │
  │     {type: 'tool_use', name: 'execute_analytics_eql', input: {…}} │
  │   ]                                                                │
  │              │                                                    │
  │              ▼                                                    │
  │   loop dispatches tool_use → BloomingToolRegistryAdapter →         │
  │     BloomreachDataSource.callTool() → tool_result appended to      │
  │     messages → next turn                                           │
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The IO abstraction is deliberate. Anthropic's API surface is nearly identical to OpenAI's chat.completions and to Google's GenerativeModel.generateContent — text-in, structured-out, tools-as-first-class. That convergence is why `@aptkit/core`'s `ModelProvider` interface exists: model-provider-neutral above, provider-specific below. In this repo the neutrality has already paid off once when the agent loop moved from a hand-rolled loop into AptKit's shared runtime; the ModelProvider port meant the swap was purely internal.

What sits under the "function" abstraction is not our problem in this codebase. It's a decoder-only transformer, trained on next-token prediction with RLHF fine-tuning, running behind an autoscaled inference cluster. We interact with it through HTTP JSON. The abstraction holds.

## Project exercises

### Exercise — swap the model provider

- **Exercise ID:** C1.1-A · Case A (concept exercised).
- **What to build:** an OpenAI `ModelProvider` adapter that satisfies AptKit's `ModelProvider` interface, alongside `AnthropicModelProviderAdapter`. Wire a factory (`getModelProvider(env)`) that picks based on `MODEL_PROVIDER` env var. Verify one golden case runs end-to-end against gpt-4o (or o3-mini) without any change to the agents or the loop.
- **Why it earns its place:** proves the provider seam holds beyond the model it was built for. Interviewer signal: "I moved my model layer from hand-rolled Anthropic to an AptKit port; here's the concrete second adapter I built when the abstraction was tested."
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (add `OpenAIModelProviderAdapter`), `lib/agents/base.ts` (add provider factory), `app/api/agent/route.ts` (read env, pick provider), one integration test in `__tests__/`.
- **Done when:** running one case in `eval/run.eval.ts` with `MODEL_PROVIDER=openai` produces a valid `Diagnosis` and receipts show OpenAI usage rows.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: What's the difference between calling `Anthropic.messages.create()` and running an agent?**

The messages call is one function invocation — messages in, content out, stateless. The agent is a loop around that call: build the messages array (system prompt + user turn + growing history + tool results), call the model, look at the content, if there's a tool_use block run the tool and append a tool_result to the messages, call again, until the model returns only text and no more tool_use blocks. AptKit owns the loop; my repo owns the adapter that provides the "call the model" primitive.

```
  agent = loop { model_call() + run_tools() + append_results() }
                  ▲
                  └── this is the only place the LLM is actually invoked
```

**Q: What's in memory between turns of the loop?**

Nothing model-side. The model is stateless. Between turns, the messages array — held in the loop — grows. Every call re-sends the whole history. That's the entire "memory" mechanism. This is why prompt caching matters so much: the front of every turn's messages array is IDENTICAL, so wrapping the system prompt with a cache breakpoint means Anthropic's server returns cache-read tokens (~10% of input cost) after the first turn.

**Q: Why the ModelProvider port?**

Because otherwise the loop and the tools would be coupled to a specific SDK. The port lets AptKit's agent loop be one library used across multiple codebases with different providers. In this repo it hasn't been swapped yet (Anthropic-only in production), but the abstraction paid for itself when moving from hand-rolled Anthropic → AptKit's shared runtime — the swap was purely internal.

## See also

- `02-tokenization.md` — what a "token" is and why context and cost are measured in tokens
- `04-structured-outputs.md` — the tool_use / tool_result blocks that are the real output shape
- `05-streaming.md` — how the SDK exposes token-by-token deltas
- `08-provider-abstraction.md` — the `ModelProvider` port in detail
- `04-agents-and-tool-use/01-agents-vs-chains.md` — the loop that wraps this function
- `06-production-serving/01-llm-caching.md` — why the system prompt is wrapped in `cache_control`
