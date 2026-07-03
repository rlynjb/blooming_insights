# 08 — Provider abstraction

**Type:** Industry standard. Also called: model provider port, adapter pattern, LLM SDK abstraction.

## Zoom out, then zoom in

The seam that separates "which LLM vendor" from "the agent logic that uses one." In this repo, AptKit owns the port; Blooming owns one adapter (Anthropic).

```
  Zoom out — the ModelProvider port

  ┌─ AptKit agents (provider-neutral) ────────────────────────────────┐
  │  DiagnosticInvestigationAgent, MonitoringAgent, RecommendationAgent│
  │  · every model call: this.model.complete(request)                  │
  │  · never touches an SDK directly                                   │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
                                │  ModelProvider interface (AptKit)
                                │  ★ THIS CONCEPT ★
                                │
  ┌─────────────────────────────▼─────────────────────────────────────┐
  │  AnthropicModelProviderAdapter                                     │
  │  lib/agents/aptkit-adapters.ts:35-121                              │
  │  · maps ModelRequest → Anthropic.Messages.MessageCreateParams      │
  │  · calls anthropic.messages.create                                 │
  │  · maps response.content → ModelContentBlock[]                     │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Anthropic SDK ─────────────▼─────────────────────────────────────┐
  │  @anthropic-ai/sdk (HTTP JSON to api.anthropic.com)                │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. `ModelProvider` is a port (in the hexagonal-architecture sense — the interface the app depends on). `AnthropicModelProviderAdapter` is one adapter satisfying that port. Today it's the only one in this repo; the abstraction paid for itself when the agent layer moved from a hand-rolled loop into AptKit's shared runtime.

## Structure pass

**Layers:**
- Outer: AptKit agents (own no SDK code, only depend on the port)
- Middle: the adapter (SDK-specific, ~85 lines here)
- Inner: `@anthropic-ai/sdk` (vendor-specific HTTP client)

**Axis: dependency direction.**
- Above the port: agents DEPEND ON `ModelProvider` (dependency inversion)
- Below the port: adapter DEPENDS ON both the port AND the SDK
- The port defines the vocabulary (`ModelRequest`, `ModelResponse`, `ModelContentBlock`)

**Seam:** the `ModelProvider` interface (from `@aptkit/core`). Above the seam, everything speaks in typed `ModelRequest` / `ModelResponse` — no SDK types. Below the seam, the adapter maps to whichever vendor's shapes.

## How it works

### Move 1 — the mental model

You've written a `logger.debug()` interface, then had `ConsoleLogger` and `PinoLogger` implementations. Same idea: the port names what the caller needs (`complete(request): Promise<Response>`); the adapter implements it against a specific tool. Swapping loggers is a config change, not a rewrite. Swapping model providers is the same shape.

```
  Port + adapter — the standard pattern

  ┌─── interface (the "port") ───┐
  │  ModelProvider                │
  │    complete(req): Promise<res>│
  └───────────────┬───────────────┘
                  │  implemented by
    ┌─────────────┼─────────────┐
    ▼             ▼             ▼
  Anthropic    OpenAI        Google
  adapter      adapter       adapter
  (this repo)  (potential)   (potential)
    │             │             │
    ▼             ▼             ▼
  @anthropic     openai         @google/
    -ai/sdk      SDK              genai
```

### Move 2 — walk the mechanism

**The port (imported from AptKit).**

`@aptkit/core` defines `ModelProvider`:

```typescript
// simplified from @aptkit/core
export interface ModelProvider {
  readonly id: string;                                    // 'anthropic', 'openai', etc.
  readonly defaultModel: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface ModelRequest {
  messages: ModelMessage[];
  system?: string;
  tools?: ModelTool[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: ModelContentBlock[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}
```

Vocabulary: messages, tools, content blocks. Same shape all three major vendors converged on. AptKit's agents write against this shape and this shape only.

**The adapter (this repo's code).**

`lib/agents/aptkit-adapters.ts:35-121`. `AnthropicModelProviderAdapter implements ModelProvider`. Three things happen inside:

1. **Map `ModelRequest` → Anthropic params.** The `toAnthropicMessage` and `toAnthropicTool` helpers walk the arrays and produce the SDK's `Anthropic.Messages.MessageParam[]` and `Anthropic.Messages.Tool[]`.
2. **Call the SDK.** `this.anthropic.messages.create(params, ...)`.
3. **Map response back.** `response.content.flatMap(toModelContentBlock)` unwraps `text` and `tool_use` blocks into AptKit's `ModelContentBlock[]`.

Plus two orthogonal behaviors the adapter is the right place for (both discussed at length in their own files): **prompt caching** (wraps the system prompt in `cache_control: ephemeral`) and **budget gating** (checks `BudgetTracker.exceeded()` before dispatching, throws `BudgetExceededError` if so).

**Where the adapter is constructed.**

Every agent constructor takes an Anthropic client + creates the adapter:

```typescript
// lib/agents/diagnostic.ts:46-63 (abbreviated)
async investigate(anomaly, hooks = {}) {
  const agent = new AptKitDiagnosticInvestigationAgent({
    model: new AnthropicModelProviderAdapter(
      this.anthropic,
      'diagnostic',
      this.sessionId,
      undefined,             // model — falls back to AGENT_MODEL
      undefined,             // logSite — falls back to default
      hooks.budget,          // the shared BudgetTracker
    ),
    tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks, 'diagnostic'),
  });
  return toBloomingDiagnosis(await agent.investigate(anomaly, { signal: hooks.signal }));
}
```

Every agent (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`) constructs its own adapter instance. Same pattern; the tools registry and trace sink also follow the port-adapter shape.

**Why not one shared adapter instance?**

Each investigation needs its own `BudgetTracker` (the ceiling is per-investigation, not global). Since the tracker is injected into the adapter, the adapter is per-investigation too. Cheap to construct — no SDK reconnect, just a class instance holding references.

### Move 3 — the principle

Depend on the port, not the vendor. Every LLM SDK will change; every LLM provider's pricing will change; every provider's tool-call shape has minor differences. The port is what your agent loop touches; the adapter absorbs the specifics. When the swap happens — new vendor, new SDK version, migration to a self-hosted model — you rewrite one file, not the whole agent layer.

## Primary diagram

The port in full — from agent to SDK, in one frame.

```
  Provider abstraction — the full path

  ┌─ AptKit agent code ────────────────────────────────────────────────┐
  │  class DiagnosticInvestigationAgent {                              │
  │    constructor(cfg: { model: ModelProvider, tools, workspace, ... })│
  │    async investigate(anomaly) {                                    │
  │      const response = await this.model.complete({                  │
  │        messages, system, tools, ...                                │
  │      });                                                            │
  │      // walks content, dispatches tool_use to tools registry       │
  │    }                                                                │
  │  }                                                                  │
  └────────────────────┬───────────────────────────────────────────────┘
                       │  ModelProvider interface
                       │  (no SDK types, no vendor names)
  ┌────────────────────▼───────────────────────────────────────────────┐
  │  class AnthropicModelProviderAdapter implements ModelProvider {    │
  │    async complete(request) {                                       │
  │      if (this.budget?.exceeded()) throw BudgetExceededError;       │
  │      const params = mapRequest(request);   // ModelRequest → SDK   │
  │      params.system = wrapWithCacheControl(request.system);         │
  │      const resp = await this.anthropic.messages.create(params);    │
  │      this.budget?.add(resp.usage);                                 │
  │      return mapResponse(resp);              // SDK → ModelResponse │
  │    }                                                                │
  │  }                                                                  │
  └────────────────────┬───────────────────────────────────────────────┘
                       │  @anthropic-ai/sdk
  ┌────────────────────▼───────────────────────────────────────────────┐
  │  Anthropic SDK client                                               │
  │  · POST https://api.anthropic.com/v1/messages                       │
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Provider convergence made this abstraction cheap. In 2023, OpenAI, Anthropic, and Google had three different tool-call formats. By 2025, they'd converged on essentially the same shape — a JSON Schema tool definition, a tool_use block in the response, a tool_result block in the next user turn. That's why a single `ModelProvider` interface can cover all three without leaking vendor-specific concepts into the port.

The parts that DON'T converge: prompt caching (Anthropic's ephemeral, OpenAI's automatic, Google's cached content), extended thinking / reasoning models (Anthropic's `thinking` parameter, OpenAI's reasoning models with different token accounting), fine-tuned model naming. These leak through as adapter-specific behaviors — this repo's Anthropic adapter has its own `cache_control` wrapping and its own logging; an OpenAI adapter would have its own equivalents.

## Project exercises

### Exercise — a second adapter (OpenAI)

- **Exercise ID:** C1.8-A · Case A (concept exercised; second adapter validates the port).
- **What to build:** `OpenAIModelProviderAdapter` in `lib/agents/aptkit-adapters.ts` (or a new file). Reads `OPENAI_API_KEY`, calls `openai.chat.completions.create()`, maps content blocks. Add a factory `getModelProvider(env)` that picks based on `MODEL_PROVIDER=anthropic|openai`. Run one golden case end-to-end against gpt-4o (or o3-mini) with no changes to the agents themselves.
- **Why it earns its place:** the abstraction has been "used once" (Anthropic-only). Adding a second implementation is where the port either holds or leaks. Interviewer signal: "I built the port before I needed it; here's the second adapter I built when it was tested."
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (add adapter), `lib/agents/base.ts` (add factory + `MODEL_PROVIDER` env), `app/api/agent/route.ts` (read env, pick provider), `__tests__/openai-adapter.test.ts`.
- **Done when:** `MODEL_PROVIDER=openai npm run eval` on one case produces a valid `Diagnosis`, receipt shows OpenAI usage rows, budget accounting works against OpenAI's pricing.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Why not just call Anthropic directly from the agent code?**

Because the agent code isn't mine — it's `@aptkit/core`. Multiple codebases use AptKit's agents; each one plugs in its own provider adapter. The port is what makes that possible: my repo says "here's an Anthropic adapter"; another repo could say "here's an OpenAI adapter"; the agent code and the loop logic are identical.

**Q: What's the shape of the port?**

Three types matter: `ModelRequest` (messages, system, tools, maxTokens, temperature, signal), `ModelResponse` (content blocks, usage, model name), `ModelContentBlock` (a union of `{type: 'text', text}` and `{type: 'tool_use', id, name, input}`). No vendor names in any of those. That's what makes it a real port and not a leaky one.

**Q: What's leaked through the port?**

Two things. Model naming — the port takes a `string` for the model, but the format of that string is vendor-specific (`claude-sonnet-4-6` vs `gpt-4o`). And provider-specific features that don't have port equivalents — Anthropic's `cache_control` breakpoint is applied inside my adapter, not surfaced up to AptKit. That's a tradeoff: the port stays clean, but my adapter has more logic. I'd rather that than a leaky abstraction.

## See also

- `01-what-an-llm-is.md` — the single call the adapter mediates
- `04-structured-outputs.md` — the tool_use shape that survives across providers
- `06-production-serving/01-llm-caching.md` — the Anthropic-specific cache_control breakpoint
- `lib/agents/aptkit-adapters.ts` — the adapter, in full
