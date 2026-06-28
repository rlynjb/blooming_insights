# 08 — provider abstraction

**Subtitle:** `ModelProvider` adapter pattern · Industry standard (load-bearing)

## Zoom out, then zoom in

`@aptkit/core@0.3.0` defines the abstract `ModelProvider` interface. Blooming
implements it once, in `AnthropicModelProviderAdapter`. AptKit runs every
agent loop through this seam without knowing Anthropic exists. That's the
whole reason AptKit is reusable — and the whole reason swapping providers in
blooming insights is a 30-line job.

```
  Zoom out — the provider seam

  ┌─ AptKit core (@aptkit/core@0.3.0) ─────────────────────┐
  │  AnomalyMonitoringAgent · DiagnosticInvestigationAgent  │
  │  RecommendationAgent · QueryAgent · classifyIntent      │
  │       ▲                                                 │
  │       │ holds a ModelProvider reference                 │
  │       │ (provider-neutral interface — messages, tools,  │
  │       │  system, maxTokens, signal)                     │
  │       ▼                                                 │
  └─────────┼───────────────────────────────────────────────┘
            │ implements ModelProvider
  ┌─────────┴────────────────────────────────────────────────┐
  │  ★ AnthropicModelProviderAdapter — lib/agents/aptkit-    │
  │     adapters.ts:26-72 (30 LOC; the WHOLE provider seam) │  ← we are here
  └─────────┬────────────────────────────────────────────────┘
            │ uses Anthropic SDK directly
            ▼
  ┌─────────────────────────────────────────────────────────┐
  │  @anthropic-ai/sdk · api.anthropic.com                  │
  │  messages.create({model, messages, system, tools, …})   │
  └─────────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — dependency direction.** AptKit depends on the
    `ModelProvider` interface; Blooming's adapter depends on AptKit's
    interface AND on the Anthropic SDK. The dependency points from concrete
    *into* abstract — classic adapter pattern. AptKit never imports
    `@anthropic-ai/sdk`, never sees `Anthropic.Messages.MessageParam`.

  → **The seam is the file `lib/agents/aptkit-adapters.ts`.** 207 lines,
    three adapter classes:
    - `AnthropicModelProviderAdapter` — the LLM seam (this file).
    - `BloomingToolRegistryAdapter` — the data source seam (see
      `04-agents-and-tool-use/02-tool-calling.md`).
    - `BloomingTraceSinkAdapter` — the trace seam (see
      `04-agents-and-tool-use/01-agents-vs-chains.md`).

  → **Axis flip at the seam:** above (AptKit), control flow is
    provider-neutral; below (the adapter), control flow is Anthropic-
    specific (auth header, SSE/non-SSE, retry, types). The flip is what
    makes the seam load-bearing.

## How it works

### Move 1 — the mental model

You've written this exact shape in a frontend codebase: a `useAuth()` hook
that returns `{ user, signIn, signOut }` without specifying whether the
backend is Firebase, Auth0, or your own JWT server. The hook is the
interface; the implementation is the adapter. Swap providers, no consuming
code changes.

```
  The provider seam as a wall socket

  ┌─ AptKit (the appliance) ─────────────────┐
  │  needs ModelProvider                     │
  │      .complete(request) → ModelResponse  │
  │      .id      ('anthropic', 'openai', …) │
  │      .defaultModel                       │
  └──────────────┬───────────────────────────┘
                 │ plug
                 ▼
  ┌─ AnthropicModelProviderAdapter ──────────┐
  │  implements ModelProvider                │
  │  uses Anthropic SDK underneath           │
  └──────────────────────────────────────────┘

  Swap the plug, swap the wiring underneath, the appliance doesn't know.
```

### Move 2 — the step-by-step walkthrough

**The interface — what AptKit demands.** From the imports in
`lib/agents/aptkit-adapters.ts:2-14`, AptKit exposes:

```typescript
type ModelProvider = {
  readonly id: string;
  readonly defaultModel: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
};

type ModelRequest = {
  messages: ModelMessage[];
  system?: string;
  tools?: ModelTool[];
  maxTokens?: number;
  signal?: AbortSignal;
};

type ModelResponse = {
  content: ModelContentBlock[];   // text | tool_use
  usage: { inputTokens: number; outputTokens: number };
  model: string;
};
```

That's the contract. Three fields on the provider, four on the request, three
on the response. AptKit's agent classes call `provider.complete(request)` in
a loop and parse `content` for text or tool_use blocks.

**The implementation — Blooming's adapter.** `AnthropicModelProviderAdapter`
(`lib/agents/aptkit-adapters.ts:26-72`):

```typescript
export class AnthropicModelProviderAdapter implements ModelProvider {
  readonly id = 'anthropic';
  readonly defaultModel: string;
  private readonly logSite: string;

  constructor(
    private readonly anthropic: Anthropic,
    agent: AgentName,
    private readonly sessionId?: string,
    model = AGENT_MODEL,                              // 'claude-sonnet-4-6'
    logSite = `agents/${agent}:aptkit-model`,
  ) {
    this.defaultModel = model;
    this.logSite = logSite;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.defaultModel,
      max_tokens: request.maxTokens ?? 4096,
      messages: request.messages.map(toAnthropicMessage),  // ← translation
    };
    if (request.system) params.system = request.system;
    if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

    const response = await this.anthropic.messages.create(
      params,
      request.signal ? { signal: request.signal } : undefined,
    );

    console.log(JSON.stringify({                            // ← logging
      site: this.logSite,
      sessionId: this.sessionId,
      usage: response.usage,
    }));

    return {
      content: response.content.flatMap(toModelContentBlock),  // ← translation
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
    };
  }
}
```

Walk it:

  → **Constructor (lines 31-40):** takes the Anthropic client, the agent
    name (for the log site label), the session id (for log filtering), and
    an optional model override (so the intent classifier can pass haiku).

  → **`complete()` (lines 42-71):** builds Anthropic-specific params from
    the provider-neutral request, calls the SDK, translates the response
    back, returns the provider-neutral shape. The two `.map(...)` calls on
    lines 47 and 64 are the translation layer — the only place the
    `ModelContentBlock` shape gets matched against
    `Anthropic.Messages.ContentBlock`.

  → **The signal threading (line 54):** the route's `req.signal` arrives
    here via AptKit's loop and gets passed to `anthropic.messages.create`.
    When the browser navigates away, this is the line that lets the
    in-flight HTTP call cancel.

**The translation helpers (lines 144-202).** These are private to the
adapter file:

  → `toAnthropicMessage` — maps `ModelMessage` ({role, content}) to
    `Anthropic.Messages.MessageParam`. Three content shapes: text,
    tool_use, tool_result.

  → `toAnthropicTool` — maps `ModelTool` ({name, description, inputSchema})
    to `Anthropic.Messages.Tool` (renames `inputSchema` → `input_schema`).

  → `toModelContentBlock` — the reverse direction. Drops thinking blocks
    (Anthropic sometimes emits these when extended thinking is enabled; the
    AptKit model doesn't have a `thinking` content variant, so they get
    dropped). Maps text and tool_use through.

These three functions are the *entire* Anthropic-specific surface area. To
add an OpenAI provider, you'd write three parallel functions
(`toOpenAIMessage`, etc.) and a `OpenAIModelProviderAdapter` class. The
agent code (`lib/agents/monitoring.ts`, `diagnostic.ts`, etc.) would not
change.

**Where the swap would happen.** Right now `lib/agents/monitoring.ts:85`:

```typescript
model: new AnthropicModelProviderAdapter(this.anthropic, 'monitoring', this.sessionId),
```

To swap providers, this line becomes:

```typescript
model: provider === 'openai'
  ? new OpenAIModelProviderAdapter(this.openai, 'monitoring', this.sessionId)
  : new AnthropicModelProviderAdapter(this.anthropic, 'monitoring', this.sessionId),
```

And every agent file gets the same conditional. Or — cleaner — a factory in
`lib/agents/base.ts` that takes `provider` and returns the matching adapter,
called once per agent construction. The factory pattern is the standard move
once you have more than one provider.

### Move 3 — the principle

**The adapter holds all the provider-specific knowledge. The agent code holds
none.** That asymmetry is what lets the codebase evolve. A new model release
on Anthropic (Sonnet 5) lands as a string constant change. A new provider
(Google Gemini) lands as a new adapter file. A new agent (e.g. a fraud
detector) lands as a new agent class that takes a `ModelProvider` and
doesn't care which one. Three changes, three different files, zero
cross-pollution.

## Primary diagram

```
  The full provider seam — read top to bottom

  ┌─ Agent classes (lib/agents/*.ts) ───────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent│
  │  QueryAgent · classifyIntent                            │
  │       │                                                 │
  │       ▼ each constructs                                 │
  │  new AnthropicModelProviderAdapter(                     │
  │    this.anthropic,         ← injected Anthropic client  │
  │    'monitoring' | 'diagnostic' | …,                     │
  │    this.sessionId,                                      │
  │    model? = AGENT_MODEL,   ← intent overrides to haiku  │
  │  )                                                       │
  └────────────────────────┬────────────────────────────────┘
                           │ passes adapter to AptKit
                           ▼
  ┌─ AptKit agent (e.g. DiagnosticInvestigationAgent) ──────┐
  │  constructor({ model, tools, workspace, trace }) {      │
  │    this.modelProvider = model;                          │
  │  }                                                      │
  │  while (not done) {                                     │
  │    const response = await this.modelProvider.complete({ │
  │      messages, system, tools, signal                    │
  │    });                                                  │
  │    // dispatch text or tool_use…                        │
  │  }                                                      │
  └────────────────────────┬────────────────────────────────┘
                           │ provider.complete(req)
                           ▼
  ┌─ AnthropicModelProviderAdapter.complete() ──────────────┐
  │  request.messages.map(toAnthropicMessage)               │
  │  request.tools?.map(toAnthropicTool)                    │
  │  await anthropic.messages.create(params, {signal})      │
  │  log usage                                              │
  │  return { content: …, usage: {…}, model }                │
  └────────────────────────┬────────────────────────────────┘
                           │ HTTPS
                           ▼
  ┌─ api.anthropic.com ─────────────────────────────────────┐
  │  POST /v1/messages                                      │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

The adapter pattern was canonical before LLMs (Gang of Four book, 1994). The
LLM era has made it the dominant pattern at provider boundaries because
providers shift fast: model releases monthly, pricing changes, capability
upgrades (vision, audio, extended thinking). Pinning to a single SDK at
every call site is technical debt waiting to happen.

LangChain made the pattern famous (`BaseChatModel`); AptKit's `ModelProvider`
is a leaner version of the same shape. The leaner-ness matters: AptKit's
interface is three properties + one method. LangChain's `BaseChatModel` is
dozens of methods, hooks, callbacks, and serialization helpers. The smaller
interface is easier to implement (Blooming's adapter is 30 lines vs ~300 for
a LangChain provider).

The single-provider state today reflects scope, not principle. blooming
insights doesn't need multi-provider yet; the user is running their own keys
against Anthropic for development and demo, and the alpha Bloomreach server's
rate limit is the binding constraint, not the Anthropic side. When that
changes — when the product becomes user-facing with provider-level cost
budgets — the adapter pattern is what makes "let's try Gemini for the
intent classifier and see if it's cheaper" a Tuesday-afternoon experiment
rather than a refactor.

## Project exercises

### Exercise — add an `OpenAIModelProviderAdapter`

  → **Exercise ID:** `study-ai-eng-08.1`
  → **What to build:** Implement `OpenAIModelProviderAdapter` against the
    same `ModelProvider` interface, using `openai.chat.completions.create`
    underneath. Write the three translation helpers (messages, tools,
    content blocks). Add a `MODEL_PROVIDER=openai|anthropic` env var to
    pick the provider at agent-construction time.
  → **Why it earns its place:** "Show me how you'd swap providers" is a
    common interview question. The answer "I added 30 more lines and one
    env var" lands much better than "we're tightly coupled to Anthropic."
  → **Files to touch:** new `lib/agents/openai-adapter.ts` (alongside
    `aptkit-adapters.ts`), `lib/agents/base.ts` (factory),
    `lib/agents/monitoring.ts` / `diagnostic.ts` / `recommendation.ts` /
    `query.ts` / `intent.ts` (each picks via factory), `package.json`
    (`openai` dep), tests.
  → **Done when:** `MODEL_PROVIDER=openai npm run dev` runs the same agents
    against `gpt-4o` (or the configured model) with no other code change.
  → **Estimated effort:** `1–2 days`

### Exercise — extract a `lib/agents/providers/` directory

  → **Exercise ID:** `study-ai-eng-08.2`
  → **What to build:** Refactor `lib/agents/aptkit-adapters.ts` so the three
    adapter classes each live in their own file:
    `providers/anthropic-model.ts`, `providers/blooming-tools.ts`,
    `providers/blooming-trace.ts`. Re-export from a barrel. Sets up the
    file structure for future providers.
  → **Why it earns its place:** Tiny refactor, but it's the difference
    between "one file with 207 lines" and "a directory of adapters." The
    second shape signals provider-multiplicity is expected.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts` (split), every
    importer (just a path update), barrel file.
  → **Done when:** Each adapter has its own file, no behavior change, tests
    pass.
  → **Estimated effort:** `<1hr`

## Interview defense

**Q: How would you swap from Anthropic to OpenAI in this codebase?**

```
  One adapter file, one factory in base.ts.

  Today:
    new AnthropicModelProviderAdapter(this.anthropic, agent, sessionId)

  After:
    makeModelProvider(provider, ...args)
       │
       ├── 'anthropic' → AnthropicModelProviderAdapter (existing)
       └── 'openai'    → OpenAIModelProviderAdapter (new, ~40 LOC)
```

AptKit defines a `ModelProvider` interface (`id`, `defaultModel`,
`complete(request) → response`). Blooming implements it in
`lib/agents/aptkit-adapters.ts:26-72` — 30 lines for Anthropic, three
translation helpers (`toAnthropicMessage`, `toAnthropicTool`,
`toModelContentBlock`) for the type mapping. A second provider is the same
shape with different SDK calls.

**Anchor line:** "The agent code never imports `@anthropic-ai/sdk`. Only the
adapter does. That's the property that makes the swap a 40-line addition."

**Q: What's the load-bearing part of the adapter?**

The translation helpers. The `.complete()` method is mostly a passthrough —
the interesting work is in the three converters that turn AptKit's
provider-neutral types into Anthropic-specific types and back. If you forgot
to handle `tool_result` in `toAnthropicContentBlock`, multi-turn loops
silently corrupt their conversation history. If you forgot to drop unknown
content types in `toModelContentBlock`, future Anthropic features (thinking
blocks, citations) would break the parse.

**Anchor line:** "The 30 lines of `.complete()` are passthrough. The 50 lines
of translation are where bugs hide."

## See also

  → `01-what-an-llm-is.md` — the one method (`complete`) the adapter implements
  → `04-agents-and-tool-use/02-tool-calling.md` — the parallel `ToolRegistry` adapter
  → `06-token-economics.md` — what cost-per-provider comparisons buy you
