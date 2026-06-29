# What an LLM actually is

*Industry standard — autoregressive next-token predictor*

## Zoom out — where this concept lives

Before the agent loop, before tool calling, before any of the agent-shaped scaffolding — the thing at the bottom of the stack is just a function. Text in, text out. Five agents in this codebase, one shared shape underneath all of them.

```
  Zoom out — the LLM box in the stack

  ┌─ UI / Route / Agent layers ──────────────────┐
  │  (everything that decides WHAT to send the   │
  │   model and WHAT to do with what comes back) │
  └────────────────────┬─────────────────────────┘
                       │
                       ▼
  ┌─ ★ THE LLM ★  ────────────────────────────────┐ ← we are here
  │  one function: tokens in → tokens out         │
  │  every Anthropic call from this repo lands    │
  │  here through one adapter method              │
  │  (lib/agents/aptkit-adapters.ts:42)           │
  └────────────────────┬─────────────────────────┘
                       │  HTTPS
                       ▼
  ┌─ Anthropic API ──────────────────────────────┐
  │  claude-sonnet-4-6  (agents)                 │
  │  claude-haiku-4-5-20251001  (intent)         │
  └──────────────────────────────────────────────┘
```

**Zoom in.** Everything you'll learn about prompts, agents, RAG, evals is built on top of this one box. The whole field is "how to put the right tokens *in* so the model writes the right tokens *out*." Five agents in this repo, one IO shape underneath all of them — and most LLM bugs come from treating the model as more than it is.

## Structure pass — layers · axes · seams

**Layers** (one axis traced through them):

  → **Caller layer** — agent code with structured intent (`MonitoringAgent.scan()`, `DiagnosticAgent.investigate()`).
  → **Adapter layer** — `AnthropicModelProviderAdapter` converts to/from the SDK's shape.
  → **LLM layer** — Anthropic API; pure function on tokens.

**Axis: who decides what happens next?**

  → Caller: CODE decides — fixed sequence (bootstrap → scan → emit).
  → Adapter: CODE decides — translation only, no policy.
  → LLM: MODEL decides — picks the next token from the learned distribution.

**Seam:** the moment your control flow crosses from "your code decides" to "the model decides" is the adapter's `complete()` call. That's where the contract changes. Inside `complete()` you hand the model a prompt and tools; the model hands back text or a tool-use request. You don't control which.

That seam — the line where determinism flips to probability — is the load-bearing one. Most "the model did something weird" debugging starts by drawing this line and asking "which side of it caused the surprise?"

## How it works

### Move 1 — the mental model

You know how `fetch()` is just `request → response`? The LLM is just `tokens → tokens`. Same shape. The Anthropic SDK call is more elaborate than `fetch()`, but the kernel is a pure function: hand it a token sequence, get a token sequence back.

```
  The LLM as a pure function

  input tokens  →  ┌──────────────────────────┐  →  output tokens
                   │   LLM (next-token        │
                   │   predictor, applied     │
                   │   one token at a time    │
                   │   until a stop token)    │
                   └──────────────────────────┘

  it is NOT a database
  it is NOT a reasoner
  it is NOT a planner
  it IS a function from tokens to tokens
```

The reasoning you see in agent traces? That's just the model writing tokens that *look like* reasoning. The tool calls? Just structured tokens the model was trained to emit when given a tool schema. The "I need to think about this" thoughts? Tokens. All of it.

### Move 2 — the step-by-step walkthrough

**Part 1 — the input is one prompt, not a conversation.**

When `MonitoringAgent.scan()` runs, AptKit eventually calls into `AnthropicModelProviderAdapter.complete()` with a `ModelRequest`. That request carries:

  → a system prompt (the agent's role and rules)
  → a `messages[]` array (user turns, assistant turns, tool results — all concatenated)
  → a `tools[]` array (the MCP tools the agent is allowed to call)

```
  Input shape — what hits the API

  ┌─ system ──────────────────────────────────────┐
  │  "You are the monitoring agent in blooming…"  │
  └───────────────────────────────────────────────┘
  ┌─ messages[] ──────────────────────────────────┐
  │  { role: 'user',      content: 'scan...' }    │
  │  { role: 'assistant', content: [tool_use] }   │ ← prior turn
  │  { role: 'user',      content: [tool_result] }│ ← tool result
  │  { role: 'assistant', content: [tool_use] }   │ ← prior turn
  │  ...                                           │
  └───────────────────────────────────────────────┘
  ┌─ tools[] ─────────────────────────────────────┐
  │  [{ name: 'execute_analytics_eql', ... }, …] │
  └───────────────────────────────────────────────┘
                          │
                          ▼  the model treats the WHOLE thing
                             as one prompt and predicts what
                             token comes next
```

There's no real "conversation." The model has no memory between calls. Every call rebuilds the whole context.

**Part 2 — the call itself.**

The adapter's `complete()` method is the entire LLM call surface for this codebase. From `lib/agents/aptkit-adapters.ts:42-70`:

```typescript
async complete(request: ModelRequest): Promise<ModelResponse> {
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: this.defaultModel,                                   // claude-sonnet-4-6 (or haiku for intent)
    max_tokens: request.maxTokens ?? 4096,                      // hard cap on output
    messages: request.messages.map(toAnthropicMessage),         // map AptKit → SDK shape
  };

  if (request.system) params.system = request.system;           // system prompt
  if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

  const response = await this.anthropic.messages.create(        // ← THE CALL
    params,
    request.signal ? { signal: request.signal } : undefined,    // route cancellation
  );

  console.log(JSON.stringify({                                  // per-call usage log
    site: this.logSite,
    sessionId: this.sessionId,
    usage: response.usage,                                       // input + output tokens
  }));

  return { content: response.content.flatMap(toModelContentBlock), ... };
}
```

Three things to notice:

  1. **`messages.create()`, not `messages.stream()`.** This codebase doesn't stream LLM tokens. See `05-streaming.md` for why.
  2. **`max_tokens: 4096`** is the hard output cap. The model stops generating at 4096 tokens regardless of whether it was done.
  3. **`response.usage`** is logged on every call. That's the only telemetry the AI stack has today (`05-evals-and-observability/04-llm-observability.md`).

**Part 3 — the output is content blocks, not a string.**

The response carries an array of `ContentBlock`s, each either `{ type: 'text', text }` or `{ type: 'tool_use', id, name, input }`. The adapter flattens them to AptKit's `ModelContentBlock[]` shape via `toModelContentBlock()` at `lib/agents/aptkit-adapters.ts:154-167`. The agent loop then iterates: if there's a `tool_use`, execute it and feed the result back; if there's `text`, keep accumulating.

```
  Output shape — what comes back

  ┌─ content[] ───────────────────────────────────┐
  │  { type: 'text', text: 'I need to check…' }   │ ← thoughts
  │  { type: 'tool_use', id, name, input }        │ ← tool call
  │  { type: 'text', text: 'Now let me…' }        │ ← more thoughts
  │  { type: 'tool_use', id, name, input }        │ ← another tool call
  └───────────────────────────────────────────────┘
  ┌─ usage ───────────────────────────────────────┐
  │  { input_tokens: 1247, output_tokens: 318 }   │ ← the bill
  └───────────────────────────────────────────────┘
```

### Move 3 — the principle

**The LLM is one function call surface. Everything else is scaffolding.** Treat it as a function and most of the bugs become obvious — they're either (a) wrong tokens going in, or (b) tokens coming out being misinterpreted by your scaffolding. The model itself is rarely the bug.

## Primary diagram — the full recap

```
  The LLM call in this codebase, end to end

  ┌─ Agent (lib/agents/monitoring.ts:78) ──────────────────────┐
  │  agent.scan() — runs the AptKit loop                       │
  └────────────────────┬───────────────────────────────────────┘
                       │  loop iteration: build ModelRequest
                       ▼
  ┌─ Adapter (lib/agents/aptkit-adapters.ts:42) ───────────────┐
  │  AnthropicModelProviderAdapter.complete(request):           │
  │    map AptKit shape → SDK shape                             │
  │    call anthropic.messages.create(params)                   │
  │    log response.usage                                       │
  │    map SDK shape → AptKit ModelResponse                     │
  └────────────────────┬───────────────────────────────────────┘
                       │  HTTPS (Anthropic SDK)
                       ▼
  ┌─ LLM (Anthropic API) ──────────────────────────────────────┐
  │  predict next token, next token, next token,                │
  │  ... until stop token or max_tokens                         │
  └────────────────────┬───────────────────────────────────────┘
                       │  ContentBlock[] + usage
                       ▼
  ┌─ Adapter → agent loop → next iteration or done             │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The "an LLM is a next-token predictor" framing isn't poetic — it's mechanical. The model has a vocabulary (Anthropic's tokenizer has ~100k entries; see `02-tokenization.md`), and at each step it produces a probability distribution over that vocabulary. The sampler picks one token (`03-sampling-parameters.md`). That token gets appended to the input, and the model runs again. Repeat until a stop token.

The "intelligence" is statistical: the model has seen so many `prompt → continuation` pairs in training that its conditional probability `P(next_token | prompt_so_far)` carries useful structure. Tool use is the same trick — the model was trained on lots of `(prompt with tool schema) → (tool_use block)` pairs, so when you hand it a tool schema, the tokens it predicts include the tool-use structure.

**Where this codebase leans on the framing:** the agents never treat the model as a "thinker." They give it a tool schema, log its token usage, and parse the output blocks. The reasoning trace in the UI is the model's tokens, presented as if it were thought — useful for the user, but not what's happening underneath.

## Project exercises

### Exercise — Stream LLM tokens to the UI

  → **Exercise ID:** B1.1 (curriculum: token streaming foundation)
  → **What to build:** Add an optional streaming path to `AnthropicModelProviderAdapter` (a new `streamComplete(request): AsyncIterable<ModelContentBlock>` method) and an opt-in flag at the route layer that switches the recommendation agent to stream its rationale as it's generated. Keep the non-streaming `complete()` for everything else.
  → **Why it earns its place:** the recommendation rationale is the most user-visible piece of generated text in the app — streaming it would cut perceived latency from ~12s to first-token in <1s. Forces you to design around stream cancellation + structured-output parsing on partial tokens.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts` (add streaming method), `lib/agents/recommendation.ts` (opt-in flag), `app/api/agent/route.ts` (route streaming tokens onto the existing NDJSON `AgentEvent` channel as a new `text_delta` event), `components/investigation/RecommendationCard.tsx` (render partial tokens).
  → **Done when:** opening the recommend step shows the rationale text appearing token-by-token, the tests around `parseRecommendations` still pass on the full final text, and `req.signal` cancellation cleanly aborts an in-flight stream.
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "What's actually happening when your monitoring agent runs?"**

Six tool calls, each one is a round-trip: build a prompt with the conversation-so-far and the tool schema, call `anthropic.messages.create()`, get back content blocks. If the model emitted a `tool_use` block, execute the EQL through the `DataSource`, feed the result back as a `tool_result` content block, loop. The model itself is stateless — every call rebuilds the whole context.

```
  one agent run = N LLM calls, stateless each time

  call 1: [system + user]                          → text + tool_use
  call 2: [system + user + assistant + tool_result] → text + tool_use
  call 3: [system + ... + tool_result + tool_result] → text + tool_use
  ...
  call N: [system + everything] → text (final answer)
```

*Anchor: "The LLM is a stateless function — the loop is on my side, the SDK is in `aptkit-adapters.ts:42`."*

**Q: "Why are you logging `response.usage` from inside the adapter?"**

The adapter is the only place every LLM call funnels through, so it's the only place I can guarantee per-call telemetry without instrumenting every agent. Both monitoring and intent classifiers emit a JSON line with `{ site, sessionId, usage }`. Vercel log filter on `site` gives me per-agent token volume. It's not a real observability story — see `05-evals-and-observability/04-llm-observability.md` — but it's the cheap version that works today.

*Anchor: "One log line per LLM call, emitted from the adapter, filterable by `site`."*

## See also

  → `02-tokenization.md` — what those `usage.input_tokens` numbers actually measure
  → `04-structured-outputs.md` — how tool calling enforces a typed output contract
  → `05-streaming.md` — why this app streams reasoning, not LLM tokens
  → `08-provider-abstraction.md` — the `ModelProvider` port that lets the adapter be swapped
  → `04-agents-and-tool-use/01-agents-vs-chains.md` — the loop wrapping this function
