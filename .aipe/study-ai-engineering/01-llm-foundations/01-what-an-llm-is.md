# What an LLM actually is

## Subtitle

Large Language Model / next-token predictor — Industry standard.

## Zoom out, then zoom in

Every agent in this repo — monitoring, diagnostic, recommendation, query, intent — sits on top of one primitive: an Anthropic Sonnet or Haiku model call. Before any layer of agent framework, before any tool, before any prompt engineering, there's a function that takes tokens in and produces tokens out. That function is the LLM.

```
  Zoom out — where the LLM sits in the stack

  ┌─ UI layer (Next.js) ────────────────────────────────────┐
  │  InsightCard · StatusLog · InvestigationSubject          │
  └─────────────────────────┬────────────────────────────────┘
                            │  NDJSON
  ┌─ Route layer ──────────▼──────────────────────────────────┐
  │  app/api/briefing/route.ts  ·  app/api/agent/route.ts     │
  └─────────────────────────┬────────────────────────────────┘
                            │
  ┌─ Agent layer ──────────▼──────────────────────────────────┐
  │  DiagnosticAgent  RecommendationAgent  MonitoringAgent ...│
  └─────────────────────────┬────────────────────────────────┘
                            │  ModelRequest (aptkit port)
  ┌─ Provider adapter ─────▼──────────────────────────────────┐
  │  ★ AnthropicModelProviderAdapter.complete() ★             │ ← we are here
  │  lib/agents/aptkit-adapters.ts:57                         │
  └─────────────────────────┬────────────────────────────────┘
                            │  Anthropic SDK
  ┌─ Provider ─────────────▼──────────────────────────────────┐
  │  claude-sonnet-4-6 (predicts next token, streams back)    │
  └────────────────────────────────────────────────────────────┘
```

Everything above the star box is *your code*. Everything below it is a hosted service you send tokens to and get tokens back from. When you're debugging an agent, the mental split matters: bugs above the box are yours to fix in TypeScript, bugs below the box are prompt / model / cost / provider issues.

## Structure pass

- **Layers:** UI → route → agent → provider adapter → provider. Five bands.
- **Axis: who decides the next action?** Above the model, *code* decides (route picks an agent; agent picks a tool schema; adapter picks a model). Inside the model, the *model* decides (which tokens come next). Below the model, *the provider* decides (which weights, which sampler). The seam where the axis flips is the `AnthropicModelProviderAdapter.complete()` call — everything above is deterministic control flow, everything at and below is stochastic.
- **Seam:** the `ModelProvider` port from `@aptkit/core`. That's the boundary where "TS control flow" hands off to "next-token prediction." Study everything else through the lens of "how does this help the model decide the right next tokens."

## How it works

### Move 1 — the mental model

An LLM is a function. Input: a sequence of tokens (the whole prompt — system + user + prior turns + tool results). Output: a probability distribution over the next token in the vocabulary. Sample from the distribution, append the sampled token to the input, repeat until you hit an end-of-message token or a hard limit.

That's it. Not a database, not a reasoner, not a planner. Anything that looks like reasoning is a side effect of the model having been trained to predict what tokens usually follow "let me think step by step."

```
  The LLM as a function — the shape

  Input (tokens)
     │
     ▼
  ┌─────────────────────────────┐
  │           LLM               │
  │  P(next_token | context)    │  ← a probability distribution
  └──────────────┬──────────────┘
                 │  sample one token from the distribution
                 ▼
             next token
                 │
                 ▼
     append to input, loop until stop
```

You know how a `fetch()` call has loading / success / error states? An LLM call has the same three, plus one extra: *the response was well-formed but wrong*. That fourth state is the one every layer above the model exists to catch.

### Move 2 — the step-by-step walkthrough

Walk one real invocation from this codebase.

**The call site.** `DiagnosticAgent.investigate()` in `lib/agents/diagnostic.ts:47` calls into aptkit's `DiagnosticInvestigationAgent.investigate()`, which loops. Each loop iteration calls `ModelProvider.complete()` on the adapter, which is the actual model call. Every model call goes through this method:

```ts
// lib/agents/aptkit-adapters.ts:57
async complete(request: ModelRequest): Promise<ModelResponse> {
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: this.defaultModel,
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages.map(toAnthropicMessage),
  };
  // ... adds tools, system prompt with cache_control, then:
  const response = await this.anthropic.messages.create(params);
```

The five things that matter on this call:

**The model** — `claude-sonnet-4-6` for agents, `claude-haiku-4-5-20251001` for the intent classifier. Sonnet is the smart one; Haiku is the cheap one. Same underlying primitive, different weights.

**The messages** — the whole conversation so far, converted to Anthropic's `{role, content}` shape. The `system` prompt is separated out because Anthropic wants it there specifically.

**The tools** — a list of `{name, description, input_schema}` objects. This is how the model "knows about" the MCP tools it can call. See `lib/agents/tool-schemas.ts:9` for how the schemas are filtered per agent.

**The `max_tokens` cap** — 4096 by default. This is the hard ceiling on *output* tokens. Input is separately bounded by the model's context window (200k for Sonnet 4.6).

**The stop condition** — the model decides when to stop by emitting an `end_turn` stop reason. Your code doesn't decide; the model does. If it never stops, the `max_tokens` cap catches it.

Diagram of one turn:

```
  One model turn — layers-and-hops

  ┌─ TS caller ───┐  hop 1: complete(ModelRequest)    ┌─ Adapter ────┐
  │ agent loop    │ ────────────────────────────────► │ complete()   │
  └───────────────┘  hop 4: ModelResponse ◄────────── └──────┬───────┘
                                                        hop 2│ POST /v1/messages
                                                             ▼
                                                      ┌─ Anthropic ─┐
                                                      │  Sonnet 4.6 │
                                                      └──────┬──────┘
                                                        hop 3│ text + tool_use
                                                             ▼
                                                        response JSON
```

### Move 3 — the principle

Every layer above the model exists because *the model is a function that predicts tokens*. It doesn't know your database. It doesn't remember yesterday's conversation. It doesn't reason unless the trained weights happen to have learned a reasoning pattern for input shapes like yours. Everything you build — RAG, agent loops, tool calling, evals — is scaffolding to compensate for that.

When you catch yourself thinking of the model as a colleague, back up. It's an input-output function. Colleagues push back; the model complies.

## Primary diagram

```
  The whole primitive in one frame

  ┌─────────────────────────────────────────────────────────┐
  │  Agent (TS control flow — deterministic)                │
  │  · picks the tool schema                                │
  │  · assembles messages                                   │
  │  · sets max_tokens, temperature, cache_control          │
  └──────────────────────┬──────────────────────────────────┘
                         │ ModelRequest
                         ▼
  ┌─────────────────────────────────────────────────────────┐
  │  AnthropicModelProviderAdapter (lib/agents/aptkit-       │
  │  adapters.ts:57) — the seam                              │
  │  · budget check                                          │
  │  · attach cache_control breakpoint                       │
  │  · call anthropic.messages.create()                      │
  └──────────────────────┬──────────────────────────────────┘
                         │ HTTP POST
                         ▼
  ┌─────────────────────────────────────────────────────────┐
  │  Anthropic (weights, sampler — stochastic)               │
  │  · reads full context                                    │
  │  · predicts next-token distribution                      │
  │  · samples until stop or max_tokens                      │
  └──────────────────────┬──────────────────────────────────┘
                         │ ModelResponse (text, tool_use, usage)
                         ▼
                     back to agent
```

## Elaborate

The LLM-as-function framing came from the early days of GPT-3 (2020) when the interface was literally `openai.Completion.create(prompt: str) -> str`. Chat-tuned models added the `role: system | user | assistant` structure; tool-calling models added `tool_use` and `tool_result` message types. Underneath, still a function: tokens in, tokens out.

The two things that break this mental model in practice:

**Stateful features.** Prompt caching, memory tools, message batches with prior context — these look like the model "remembers" things. It doesn't. Something in the provider's infrastructure is stashing the context and prepending it. The function stays the same.

**Reasoning models.** Claude 4.5+ and OpenAI's o-series do internal "thinking" tokens that the model emits before the visible response. Still tokens. Still a function. The visible output is just filtered.

Related: **04-agents-and-tool-use/02-tool-calling.md** for how tool calls fit into this input/output shape. **06-production-serving/01-llm-caching.md** for what prompt caching does to the input side.

## Project exercises

### B1.1 · Diagram the model boundary in your codebase

- **Exercise ID:** B1.1
- **What to build:** A one-page architecture diagram of blooming_insights that shows every place the codebase calls the Anthropic API, and every layer of abstraction between the call site and the SDK.
- **Why it earns its place:** Interviewers ask "how does your codebase talk to the model?" The candidate who can whiteboard `agent → adapter → SDK → provider` with real file paths wins every time.
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (the adapter), `lib/agents/intent.ts` (the classifier's direct call), `eval/rubrics/*.ts` (judge calls). Output: `.aipe/study-ai-engineering/00-overview.md` gets a `## Model boundary` section.
- **Done when:** the diagram names every file that instantiates the Anthropic SDK client and every file that calls `.messages.create()`.
- **Estimated effort:** `<1hr`.

## Interview defense

**Q: If the model is just a function, why do agents feel like they reason?**

The reasoning is a side effect of training. Models were trained on text where reasoning steps are written out in sequence — "first check X, then Y, then conclude Z." So when you prompt for a similar pattern (or the model has been RLHF'd to produce one by default), the output *looks like* reasoning. It's next-token prediction all the way down. The load-bearing part: the model doesn't have a scratchpad you can inspect; the visible output *is* the "reasoning." If you want to verify the reasoning is sound, you have to either check every step against ground truth or accept the risk.

```
  Reasoning as an output shape, not an internal state

  training data has "Step 1: ... Step 2: ... Conclusion: ..."
                         │
                         ▼
  model learns to emit tokens in that shape
                         │
                         ▼
  output LOOKS like reasoning
  but is next-token prediction the whole way
```

**Q: What's the difference between the model and the agent?**

The model is the primitive: a function that takes messages + tools, returns a message (text or tool call). The agent is the loop around it: "if the response is text, we're done; if it's a tool call, run the tool, append the result to messages, loop." Aptkit's `DiagnosticInvestigationAgent` is that loop, hardcoded for one purpose. See **04-agents-and-tool-use/01-agents-vs-chains.md**.

**Q: Why do you use different models for different agents?**

Cost/capability tradeoff, one axis. Intent classification is a one-shot text-in / label-out task — Haiku handles it at ~5× lower cost and lower latency. The agent loops are multi-turn, tool-using, and quality-sensitive — Sonnet is worth the money. The judge is quality-critical (its output is what gates the eval), so it also gets Sonnet. Same primitive, three different model IDs.

## See also

- [08-provider-abstraction.md](08-provider-abstraction.md) — how the same primitive is swappable across providers.
- [02-tokenization.md](02-tokenization.md) — what "tokens in, tokens out" actually means at the byte level.
- [../04-agents-and-tool-use/01-agents-vs-chains.md](../04-agents-and-tool-use/01-agents-vs-chains.md) — the loop around this primitive.
