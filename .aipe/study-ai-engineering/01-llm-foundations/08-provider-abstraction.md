# Provider abstraction

*Industry standard — provider port / dependency inversion*

## Zoom out — where this concept lives

Every agent in this codebase talks to *a* model provider, not *the* Anthropic SDK. The port lives in `@aptkit/core` as `ModelProvider`; the adapter that wires it to Anthropic is 30 lines at `lib/agents/aptkit-adapters.ts:25-71`. Switching to Bedrock, Vertex AI, or a local model is a one-file change.

```
  Zoom out — the provider port at the boundary

  ┌─ Agent layer ────────────────────────────────────────────┐
  │  AptKit's reusable agents (AnomalyMonitoringAgent, etc.) │
  │  depend on the port `ModelProvider`, NOT the SDK          │
  └─────────────────────┬────────────────────────────────────┘
                        │  ModelProvider interface
                        ▼
  ┌─ ★ Adapter (aptkit-adapters.ts:25) ★ ─────────────────────┐ ← we are here
  │  AnthropicModelProviderAdapter implements ModelProvider   │
  │  one method that matters: complete(ModelRequest)          │
  └─────────────────────┬────────────────────────────────────┘
                        │  Anthropic SDK call
                        ▼
  ┌─ Provider ───────────────────────────────────────────────┐
  │  @anthropic-ai/sdk — claude-sonnet-4-6 / claude-haiku-4-5│
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** Classic dependency inversion: agents depend on the abstraction (port), not on the SDK (adapter). The port surface is small — `complete()` plus some types. Anything that can implement the port can be the provider.

## Structure pass — layers · axes · seams

**Layers:** agent → port → adapter → SDK → provider API.

**Axis: who depends on whom?** Agents depend on `ModelProvider`. `AnthropicModelProviderAdapter` depends on `Anthropic`. Dependency arrows point *into* the port, never out of it. This is what makes the swap cheap.

**Seam:** the `ModelProvider` interface from `@aptkit/core`. That's the contract. Every method on it is a method an alternative adapter would have to implement.

## How it works

### Move 1 — the mental model

You know how a wall socket is the interface, and lamps/toasters/chargers are all interchangeable as long as they have the right plug? Same idea here. `ModelProvider` is the socket; `AnthropicModelProviderAdapter` is one plug; a `BedrockModelProviderAdapter` or `OllamaModelProviderAdapter` would be other plugs. The agent code is the lamp — it doesn't care which plug is in.

```
  Provider port: the socket-and-plug analogy

  ┌─ AptKit agents (lamps, toasters, chargers) ──────────────┐
  │  AnomalyMonitoringAgent, DiagnosticInvestigationAgent,   │
  │  RecommendationAgent, QueryAgent                         │
  │  → all call: modelProvider.complete(request)             │
  └──────────────────────┬───────────────────────────────────┘
                         │  ▷▶ ModelProvider (the socket)
                         ▼
  ┌─ One plug today ─────────────────────────────────────────┐
  │  AnthropicModelProviderAdapter (Anthropic SDK)           │
  └──────────────────────────────────────────────────────────┘
  ┌─ Future plugs (none in repo today) ──────────────────────┐
  │  BedrockModelProviderAdapter (AWS Bedrock)               │
  │  VertexModelProviderAdapter  (Google Vertex AI)          │
  │  OllamaModelProviderAdapter  (local model server)        │
  └──────────────────────────────────────────────────────────┘
```

After the analogy: the engineering primitive is *port + adapter*. The port is the contract (interface). The adapter implements the contract for one specific provider. The lamp keeps working when you change plugs.

### Move 2 — the step-by-step walkthrough

**Part 1 — the port is from AptKit.**

The `ModelProvider` interface lives in `@aptkit/core` (not in this repo). From the import at `lib/agents/aptkit-adapters.ts:5-13`:

```typescript
import {
  type CapabilityEvent,
  type CapabilityTraceSink,
  type ModelContentBlock,
  type ModelMessage,
  type ModelProvider,                      // ← the port
  type ModelRequest,
  type ModelResponse,
  type ModelTool,
  ...
} from '@aptkit/core';
```

The port shape (inferred from the adapter):

```typescript
interface ModelProvider {
  readonly id: string;
  readonly defaultModel: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
  // streamComplete?(request): AsyncIterable<…>   // would-be future addition
}
```

The interface is tiny on purpose: small ports are cheap to implement.

**Part 2 — the adapter is 30 LOC of real work.**

The Anthropic adapter at `lib/agents/aptkit-adapters.ts:25-71` does four things:

  1. **Maps AptKit's `ModelRequest` to Anthropic's `MessageCreateParams`.** Lines 42-51.
  2. **Calls the SDK.** Line 53. Threads `request.signal` through to `AbortController` if present.
  3. **Logs `response.usage`.** Lines 55-60. Per-call telemetry, one place.
  4. **Maps Anthropic's response back to `ModelResponse`.** Lines 62-70. Flattens content blocks via `toModelContentBlock()`.

```typescript
async complete(request: ModelRequest): Promise<ModelResponse> {
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: this.defaultModel,
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages.map(toAnthropicMessage),       // ← shape map
  };

  if (request.system) params.system = request.system;
  if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

  const response = await this.anthropic.messages.create(
    params,
    request.signal ? { signal: request.signal } : undefined,  // ← cancellation
  );

  console.log(JSON.stringify({                                // ← telemetry
    site: this.logSite,
    sessionId: this.sessionId,
    usage: response.usage,
  }));

  return {
    content: response.content.flatMap(toModelContentBlock),   // ← shape map back
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    model: response.model,
  };
}
```

Three pure-function helpers do the shape mapping: `toAnthropicMessage`, `toAnthropicContentBlock`, `toAnthropicTool` (lines 144-168), and the inverse `toModelContentBlock` (lines 154-167).

**Part 3 — the agents never know which provider is plugged in.**

From `lib/agents/monitoring.ts:84-90`:

```typescript
const agent = new AptKitAnomalyMonitoringAgent({
  model: new AnthropicModelProviderAdapter(this.anthropic, 'monitoring', this.sessionId),
  tools: toolRegistry,
  workspace: this.schema,
  trace: new BloomingTraceSinkAdapter(hooks ?? {}, 'monitoring'),
  categories: categories.length ? toAptKitCategories(categories, this.schema.projectId) : [],
});
```

The agent gets handed a `ModelProvider`. It doesn't care which one. To swap to Bedrock: implement `BedrockModelProviderAdapter`, change the `new AnthropicModelProviderAdapter(...)` call to `new BedrockModelProviderAdapter(...)`. The agent code is untouched.

**Part 4 — the per-agent logSite trick.**

Each agent constructor passes a different `agent` label to the adapter constructor, and the adapter uses it to build `logSite` (`lib/agents/aptkit-adapters.ts:31-37`):

```typescript
constructor(
  private readonly anthropic: Anthropic,
  agent: AgentName,                              // ← per-agent label
  private readonly sessionId?: string,
  model = AGENT_MODEL,
  logSite = `agents/${agent}:aptkit-model`,      // ← derived log site
) {
  this.defaultModel = model;
  this.logSite = logSite;
}
```

So the log lines from monitoring are tagged `"agents/monitoring:aptkit-model"`, diagnostic gets `"agents/diagnostic:aptkit-model"`, etc. The intent classifier overrides the model + log site explicitly (`lib/agents/intent.ts:23-29`). One adapter, per-agent telemetry, all at the port boundary.

### Move 3 — the principle

**Depend on the abstraction; only the adapter knows the SDK.** The port surface is tiny (one `complete()` method that matters); the adapter is 30 LOC. The swap cost — Anthropic → Bedrock, Bedrock → Ollama — is one file. This is dependency inversion, applied at the LLM boundary.

## Primary diagram — the full recap

```
  Provider abstraction in this codebase

  ┌─ Agent layer ────────────────────────────────────────────────┐
  │  Blooming wrappers (MonitoringAgent, DiagnosticAgent, …)     │
  │  pass a ModelProvider to AptKit's reusable agents            │
  └──────────────────────┬───────────────────────────────────────┘
                         │  port: ModelProvider (@aptkit/core)
                         │  methods: complete(request)
                         │           id, defaultModel
                         ▼
  ┌─ Adapter (lib/agents/aptkit-adapters.ts:25) ─────────────────┐
  │  AnthropicModelProviderAdapter                                │
  │   - holds: Anthropic SDK client, agent label, sessionId      │
  │   - logSite derived from agent label for per-agent telemetry │
  │   - complete():                                              │
  │     1. map AptKit ModelRequest → SDK params                  │
  │     2. anthropic.messages.create(params, { signal })         │
  │     3. log response.usage                                    │
  │     4. map SDK response → AptKit ModelResponse               │
  └──────────────────────┬───────────────────────────────────────┘
                         │  @anthropic-ai/sdk
                         ▼
  ┌─ Anthropic API ──────────────────────────────────────────────┐
  │  claude-sonnet-4-6  (default — agents)                       │
  │  claude-haiku-4-5-20251001  (intent classifier override)     │
  └──────────────────────────────────────────────────────────────┘

  To swap providers: implement ModelProvider against the new SDK,
                     change `new AnthropicModelProviderAdapter(…)`
                     to `new BedrockModelProviderAdapter(…)`.
                     Agent code, route code, prompt files all untouched.
```

## Elaborate

**Why the port lives in AptKit, not in this codebase.** AptKit is a reusable agent runtime — its design goal is to host loops that don't know which model is underneath. Putting `ModelProvider` in the library and adapters in the consuming codebases is the natural seam: library owns the contract, app owns the wire.

**Why this is dependency inversion, not just dependency injection.** DI is just "pass dependencies as constructor args" — the agents could have been written to take `anthropic: Anthropic` directly. The key move is *depending on the abstraction*: AptKit's `AnomalyMonitoringAgent` is parameterized over `ModelProvider`, not over Anthropic. Inversion is the *direction of the dependency arrow* (agent → port → adapter → SDK), not the mechanism of passing it.

**Where the abstraction is thinnest.** Two places:

  1. **`ModelTool` mapping.** The adapter at `toAnthropicTool()` (line 78) casts `tool.inputSchema as Anthropic.Messages.Tool['input_schema']`. If a future provider has a different tool-schema dialect (Bedrock's tool schema is slightly different from Anthropic's), the adapter needs explicit translation. Not a port problem; an adapter problem.
  2. **Streaming.** The port doesn't have `streamComplete()` today. If a future agent wants streaming, the port grows a method and every adapter has to implement it (or throw `NotImplemented`). See `05-streaming.md` for why this isn't pressing yet.

## Project exercises

### Exercise — Add a SyntheticModelProvider for deterministic tests

  → **Exercise ID:** B1.8
  → **What to build:** Implement `SyntheticModelProviderAdapter` that returns canned `ModelResponse`s keyed by request hash. Use it in `test/` to remove every `vi.mock('@anthropic-ai/sdk', …)` call — the test runs against a real `ModelProvider` interface, just with deterministic responses.
  → **Why it earns its place:** the test suite currently mocks the Anthropic SDK directly (24 test files, many with provider mocks). A `SyntheticModelProviderAdapter` would replace those mocks with a real adapter that satisfies the port, giving the tests stronger guarantees about port conformance.
  → **Files to touch:** new `lib/agents/synthetic-model-provider.ts`, refactor `test/agents/*.test.ts` to construct `SyntheticModelProviderAdapter` instead of mocking the SDK, document the canned-response pattern in a test helper.
  → **Done when:** `vi.mock('@anthropic-ai/sdk', …)` appears in zero test files, all 221 existing tests still pass, and adding a new test only requires defining the canned response shape (no SDK mocking boilerplate).
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "How would you swap Anthropic for AWS Bedrock?"**

Implement `BedrockModelProviderAdapter` against the `ModelProvider` interface from `@aptkit/core` — about 30 LOC of mapping logic between Bedrock's SDK and AptKit's request/response shapes. Change the `new AnthropicModelProviderAdapter(...)` call at each agent constructor to use the Bedrock adapter. Agent code, prompts, route layer, UI — all untouched. The port boundary is small enough that the adapter is the only place provider differences live.

*Anchor: "One adapter class implements the port; agent code never knows. `aptkit-adapters.ts:25`."*

**Q: "Why a port for the model provider but not for the prompts?"**

The model provider varies (Anthropic today, Bedrock tomorrow). The prompts vary per agent but not per provider — they're consumed by *whichever* provider is plugged in. If we ever needed to ship different prompts per provider family (e.g. shorter prompts for cheaper models), the prompt files would need a layer above them — a prompt strategy port. We don't have that need today. Adding ports for things that aren't swappable is overhead without payoff.

*Anchor: "Port what varies along the axis you actually swap. Provider swap → ModelProvider port; prompt swap → not currently needed."*

## See also

  → `01-what-an-llm-is.md` — the function the port abstracts
  → `04-agents-and-tool-use/02-tool-calling.md` — the tool-registry port (same pattern, different boundary)
  → `study-system-design/03-datasource-seam.md` — the DataSource port (third instance of the pattern in this repo)
