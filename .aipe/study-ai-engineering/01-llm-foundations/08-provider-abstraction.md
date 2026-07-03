# Provider abstraction

## Subtitle

Dependency inversion for LLM providers / adapter pattern — Industry standard.

## Zoom out, then zoom in

Every agent in this codebase depends on the `ModelProvider` port from `@aptkit/core`, not on the Anthropic SDK directly. The concrete `AnthropicModelProviderAdapter` in `lib/agents/aptkit-adapters.ts:37` is the *only* file that imports the Anthropic SDK type for `messages.create()`. If you wanted to swap OpenAI, Google, or a local model, you'd write one new adapter and change nothing else in the agent layer.

That's the standard "hexagonal / ports-and-adapters" shape, applied to the model provider seam.

```
  Zoom out — the port between agents and providers

  ┌─ Agent code (DiagnosticAgent, RecommendationAgent, ...) ─┐
  │  depends on ModelProvider port                            │
  └───────────────────────┬──────────────────────────────────┘
                          │  ModelProvider.complete(ModelRequest)
                          ▼
  ┌─ Adapter (concrete impl of the port) ★ ────────────────┐ ← we are here
  │  AnthropicModelProviderAdapter                          │
  │  lib/agents/aptkit-adapters.ts:37                       │
  └───────────────────────┬──────────────────────────────────┘
                          │  anthropic.messages.create()
                          ▼
  ┌─ Anthropic SDK ────────────────────────────────────────┐
  │  @anthropic-ai/sdk                                       │
  └────────────────────────────────────────────────────────┘
```

Zoom in: the port is `ModelProvider`; the adapter is `AnthropicModelProviderAdapter`. Same shape whenever this codebase generalizes a boundary — see the parallel case for the data source (`DataSource` port, `McpDataSource` / `SyntheticDataSource` adapters).

## Structure pass

- **Layers:** agent → port → adapter → SDK → HTTP → provider. Six bands.
- **Axis: dependency direction.** Agents depend *on the port*, not on the adapter. The adapter depends on the SDK. That's dependency inversion applied cleanly — the agent doesn't know which provider is on the other side.
- **Seam:** the `ModelProvider` interface itself. Everything above the seam is provider-agnostic; everything below is Anthropic-specific.

## How it works

### Move 1 — the mental model

Think of the interface (`ModelProvider`) as a wall socket. Every consumer (agent) plugs into the same socket. Any provider that can supply the right shape can go behind the wall — Anthropic today, OpenAI tomorrow, a local Ollama variant next week. The consumers don't know or care.

```
  Port + adapter — the pattern

           ┌──────────────────────┐
  agent ──▶│   ModelProvider port │  the "wall socket"
           └──────────┬───────────┘
                      │
                 ┌────┴─────┬─────────────┬──────────┐
                 ▼          ▼             ▼          ▼
        AnthropicAdapter  OpenAIAdapter  Ollama  future...
        (this repo)        (not built)   (not built)
```

The value shows up the day you want to add a second provider. Because agents already depend on the port, adding an adapter is *purely additive* — no touching agents, no touching routes, no touching evals.

### Move 2 — the step-by-step walkthrough

**The port shape.** `ModelProvider` from `@aptkit/core` defines:

```ts
// conceptual — the real definition lives in @aptkit/core
interface ModelProvider {
  readonly id: string;
  readonly defaultModel: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
```

`ModelRequest` carries messages, tools, `maxTokens`, and optional temperature/top_p (see **03-sampling-parameters.md**). `ModelResponse` carries content blocks (text + tool_use) and usage.

**The Anthropic adapter.** `lib/agents/aptkit-adapters.ts:37-105` — one class, ~70 lines. It:

1. Holds the Anthropic SDK client, agent name, session id, model name, and optional budget tracker.
2. On `complete()`, checks the budget ceiling (`lib/agents/aptkit-adapters.ts:65-67`).
3. Translates `ModelRequest.messages` into Anthropic's `{role, content}` shape.
4. Injects the cache_control breakpoint on the system prompt (`lib/agents/aptkit-adapters.ts:75-98`).
5. Calls `anthropic.messages.create()`.
6. Translates the response back into `ModelResponse` shape.

That's the whole adapter contract. Every agent in this repo instantiates this adapter and passes it into aptkit's agent class:

```ts
// lib/agents/diagnostic.ts:48 (inside investigate())
const agent = new AptKitDiagnosticInvestigationAgent({
  model: new AnthropicModelProviderAdapter(
    this.anthropic, 'diagnostic', this.sessionId,
    undefined, undefined, hooks.budget,
  ),
  tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
  workspace: this.schema,
  trace: new BloomingTraceSinkAdapter(hooks, 'diagnostic'),
});
```

Three adapters injected: model provider, tool registry, trace sink. All ports; all swappable.

**The intent classifier reuses the same adapter, different model.** `lib/agents/intent.ts:19` — same class, different constructor argument for `CLASSIFIER_MODEL`. Provider abstraction plus model-per-call gives you fine-grained cost control.

**What's Anthropic-specific and hidden behind the seam.** Cache_control (only Anthropic supports it in this shape), the exact `MessageCreateParams.system` structure with `cache_control: { type: "ephemeral" }`, the `tool_choice` fields. Every one of these is inside the adapter; none leak upward.

Diagram of one call in the port/adapter shape:

```
  One .complete() call — layers-and-hops

  ┌─ agent ────────┐  hop 1: complete(ModelRequest)   ┌─ adapter ─────┐
  │ DiagnosticAgent│ ──────────────────────────────► │ .complete()   │
  └────────────────┘  hop 4: ModelResponse ◄──────── └──────┬────────┘
                                                       hop 2│ anthropic.messages.create()
                                                            ▼
                                                     ┌─ SDK ──────────┐
                                                     │ @anthropic-ai/ │
                                                     │  sdk           │
                                                     └──────┬─────────┘
                                                       hop 3│ HTTP
                                                            ▼
                                                       provider
```

### Move 2.5 — current state vs future state

The `ModelProvider` port is fully live and used by every agent. The Anthropic adapter is the only implementation. The plumbing for a second adapter is real — aptkit's port is provider-neutral by design, and this codebase's agent layer holds no Anthropic types directly.

What would need to change to add OpenAI:

- One new file: `lib/agents/openai-adapter.ts` implementing `ModelProvider`.
- One env / config gate to pick which adapter each agent uses.
- No change to `diagnostic.ts`, `recommendation.ts`, `monitoring.ts`, `query.ts`, `intent.ts`, or any route.

The pricing helper (`lib/agents/pricing.ts`) would grow OpenAI rows; the receipts pipeline already carries a `modelName` so the report would attribute correctly.

### Move 3 — the principle

Depend on ports, not on implementations. When a boundary is likely to change (provider, storage, transport), invert the direction so your consumers depend on an abstraction you own. The concrete implementation becomes a leaf you can swap or add without ripples.

## Primary diagram

```
  Provider abstraction — full frame

  ┌─ Agent layer (5 agents) ────────────────────────────────┐
  │  DiagnosticAgent · RecommendationAgent · MonitoringAgent │
  │  QueryAgent · classifyIntent                              │
  │  all depend on ModelProvider port only                    │
  └──────────────────────┬──────────────────────────────────┘
                         │  ModelRequest → ModelResponse
                         ▼
  ┌─ ModelProvider port (from @aptkit/core) ────────────────┐
  │  interface ModelProvider { complete(req): Promise<res> } │
  └──────────────────────┬──────────────────────────────────┘
                         │  implemented by
                         ▼
  ┌─ Concrete adapters ─────────────────────────────────────┐
  │                                                          │
  │  ★ AnthropicModelProviderAdapter (only impl today)       │
  │      lib/agents/aptkit-adapters.ts:37                    │
  │                                                          │
  │  [OpenAIAdapter — not built; one file to add]           │
  │  [OllamaAdapter — not built; one file to add]           │
  │                                                          │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
                     provider SDK
```

## Elaborate

The pattern this codebase uses matches the shape "ports and adapters" (Alistair Cockburn's hexagonal architecture, ~2005) applied to a single dependency. The value proposition is *swappability at a low blast radius* — swaps happen at a single file, not a code-wide grep.

The port is only worth having when the underlying dependency is expected to change. LLM providers are — every 6-12 months a new model or provider becomes relevant. Storage engines change less; you might not port-abstract Postgres.

Related: **04-structured-outputs.md** (the tool schema surface flows through the port cleanly). The DataSource seam in `lib/data-source/types.ts` — five uses without a caller-surface change — is the parallel case for the data provider port; see the AGENTS.md and the audit files for the systems view.

## Project exercises

### B1.8 · Add a second ModelProvider adapter

- **Exercise ID:** B1.8
- **What to build:** Implement `OpenAIModelProviderAdapter` in `lib/agents/openai-adapter.ts`, mapping OpenAI's `chat.completions` API to aptkit's `ModelProvider` port. Add OpenAI pricing rows to `lib/agents/pricing.ts`. Wire an env flag to let the intent classifier use OpenAI while agents stay on Anthropic.
- **Why it earns its place:** Turns "the port exists" into "the port is proven" — one adapter is architecture, two adapters is evidence.
- **Files to touch:** New `lib/agents/openai-adapter.ts`, extend `lib/agents/pricing.ts` (add gpt-4o + gpt-4o-mini pricing), extend `lib/agents/intent.ts` (env-flag the classifier's provider), new `test/agents/openai-adapter.test.ts`.
- **Done when:** the intent classifier runs on OpenAI with `AI_INTENT_PROVIDER=openai`, receipts carry the correct model + cost, and no agent code changes.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: Why not just call `anthropic.messages.create()` from the agents directly?**

Because the agents would then depend on the Anthropic SDK, and swapping providers would mean touching every agent. Right now the SDK import lives in exactly one file: `lib/agents/aptkit-adapters.ts`. Every agent imports `AnthropicModelProviderAdapter` (or aptkit's port type), never the SDK. The load-bearing part: if I need to add OpenAI tomorrow, I write one file and every agent works.

```
  What changes when we swap providers

  before port:  every agent has `import Anthropic from ...`
                → swap = 5 file changes + evals + judge
  after port:   only the adapter has that import
                → swap = 1 new adapter file, 0 agent changes
```

**Q: Doesn't aptkit already give you provider neutrality?**

Yes — aptkit's `ModelProvider` port is what makes this work. My code writes the *Blooming-side* adapter that maps our concrete Anthropic client into that port. Aptkit ships zero provider adapters itself; the port is the promise, and each app writes its own adapter. In practice this codebase is what proves the port is well-designed — 260 LOC of adapter code, and every eval + observability layer works unchanged.

## See also

- [01-what-an-llm-is.md](01-what-an-llm-is.md) — the primitive the adapter exposes.
- [04-structured-outputs.md](04-structured-outputs.md) — the tool schemas that flow through the port.
- [../06-production-serving/02-llm-cost-optimization.md](../06-production-serving/02-llm-cost-optimization.md) — per-agent model choice, made possible by this abstraction.
