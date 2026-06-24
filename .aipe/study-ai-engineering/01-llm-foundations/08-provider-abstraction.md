# Provider abstraction (a testability seam, not a multi-provider switch)

**Industry name(s):** dependency injection / inversion of control, provider abstraction, test seam (fakes over network)
**Type:** Industry standard · Language-agnostic

> The agent system injects both its MCP caller (`McpCaller` / `McpTransport`) and its Anthropic client through function parameters so tests can pass fakes and run with no network — but this is a *testability* seam, not multi-LLM-provider switching: there is one provider (Anthropic), no factory, and no way to swap Claude for another model.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Provider abstraction lives at the seam between the Per-agent / Agent loop layer and the Provider band. The agent loop in `lib/agents/base.ts` depends on two narrow interfaces — `McpCaller` (L16–L22) and the injected `anthropic: Anthropic` parameter (L48–L49) — and constructs neither. The Route handler builds the real clients (`new Anthropic` at `app/api/agent/route.ts` L207, `connectMcp` for MCP) and passes them down; tests pass fakes through the same parameter.

```
  Zoom out — where the injection seam sits

  ┌─ Route / Test (chooses implementation) ─────────┐
  │  PROD: new Anthropic(...) + connectMcp           │
  │  TEST: fakeAnthropic + scripted McpCaller        │
  └─────────────────────────┬───────────────────────┘
                            │  passed as parameters
  ┌─ Per-agent + Agent loop ▼───────────────────────┐  ← we are here
  │  ★ runAgentLoop({ anthropic, mcp, ... }) ★      │
  │  depends on:  Anthropic (CONCRETE SDK type)     │
  │               McpCaller (structural interface)  │
  │  constructs:  nothing                           │
  └─────────────────────────┬───────────────────────┘
                            │
  ┌─ Provider wrappers + Provider ──▼──────────────┐
  │  anthropic.messages.create(params)              │
  │  mcp.callTool(name, args)                       │
  │  (one provider; no vendor-neutral interface,    │
  │   no factory, no swap path)                     │
  └─────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you test the loop's logic — budget, tool feedback, forced final turn — without a live API key and a live server on every run? Inject both clients by parameter so a test passes a fake. But be precise about what this buys: a *test seam* is not *provider portability*. blooming insights built the first (fakes over the network — 169 tests run with no key) and stopped short of the second (the `anthropic` param is the concrete SDK type, not a vendor-neutral interface).

---

## Structure pass

**Layers.** Three layers: the chooser (Route in production, test setup in tests) that constructs concrete clients, the agent loop / per-agent code that depends only on the injected parameters (`McpCaller`, `anthropic`), and the provider/MCP transports themselves (Anthropic SDK, MCP HTTPS transport). The agent layer constructs nothing; the chooser constructs everything; the transports do the network.

**Axis: dependency.** Who depends on whom, and which way does the import arrow point? This axis is the right lens because dependency injection IS a dependency-direction inversion: the agent layer would normally `import { Anthropic } from '@anthropic-ai/sdk'` and `new` it; instead the chooser holds that import and passes the instance in. Control would mis-frame (the agent loop always decides what to call); trust isn't moving here; dependency direction is what flips at the seam.

**Seams.** The cosmetic seam is between the agent loop and the SDK call itself — both run on the same provider concretion. The load-bearing seam is the parameter boundary: between the chooser and the agent loop, dependency flips from "concrete classes constructed here" to "no construction, only a shape parameter." Crossing this seam is what makes 169 tests run with no API key. A sideways non-flip worth naming: this is *not* a multi-provider seam — the `anthropic` parameter is the concrete SDK type, not a vendor-neutral interface, so swapping providers would still touch the agent layer.

```
  Structure pass — provider abstraction

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  chooser (route or test) — constructs clients  │
  │  agent loop / per-agent — depends on params    │
  │  provider + MCP transports — do the network    │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  dependency: who depends on whom, and which    │
  │  way does the import arrow point?              │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  agent↔SDK call: cosmetic                      │
  │  chooser↔agent: LOAD-BEARING                   │
  │    "constructs here" → "only consumes param"   │
  │    this is what makes fakes work               │
  │  (NOT a multi-provider seam — concrete type)   │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Two narrow interfaces define the *shape* the agent layer depends on; concrete classes implement them for production; the agent layer receives an implementation by parameter and never constructs one. Swapping the implementation (real → fake) is a different argument, not a code change inside the consumer.

```
the shared agent loop depends on INTERFACES, not classes
      │
  ┌───▼─── McpCaller ───────────────┐   ┌── provider SDK param ──┐
  │ callTool(name, args, opts?)      │   │ concrete SDK type       │
  └──────────────────────────────────┘   └─────────────────────────┘
      ▲                    ▲                  ▲           ▲
   prod MCP client    buildFakeMcp        real client   fake client
   (production)        (tests)            (production)   (tests)

  injection point: runAgentLoop({ provider_sdk, mcp, ... })
```

The consumer is written once against the interface; production and tests differ only in what they pass in. That is dependency injection, and it is the entire mechanism.

---

### The MCP seam: the transport and caller interfaces

There are two narrow interfaces, one nested inside the other's stack. The transport interface is the minimal surface the *client wrapper* depends on — just `callTool` and `listTools`:

```
  interface McpTransport:
      callTool(name, args)  -> Promise<unknown>
      listTools()           -> Promise<unknown>
```

The production transport wraps the real MCP SDK client. A test passes a fake transport instead. The production transport also carries an optional HTTP-error holder populated by a capturing `fetch` wrapper handed to the SDK — it records the body of any non-OK HTTP response (cloning so the SDK can still read it). On a failed call, the transport attaches that captured body to the thrown error so callers see the real server message instead of a bare "Unauthorized." This is error-detail plumbing *behind* the same narrow interface — it does not change the seam's shape (`callTool` / `listTools` still return `Promise<unknown>`), so test fakes are unaffected.

The agent-facing caller interface is what the *agent loop* depends on — the richer caller surface with caching / timing metadata:

```
  interface McpCaller:
      callTool(
        name,
        args,
        opts?: { cacheTtlMs?: number, skipCache?: boolean },
      ) -> Promise<{ result: unknown, durationMs: number, fromCache: boolean }>
```

The intent is explicit in the comment alongside: "Minimal structural interface for an MCP caller so that unit tests can inject a fake without depending on the concrete MCP client class or any network. The production client structurally satisfies this interface." The production client is not even named in the interface — it just *structurally* matches, so a hand-written fake matches too.

```
McpTransport  ── production transport (wraps SDK Client)   ── prod
              ── fake transport                              ── tests
McpCaller     ── production MCP client (structural match)   ── prod
              ── buildFakeMcp / scripted object              ── tests
```

---

### The provider seam: an injected parameter

The shared agent loop takes the provider SDK client as the first field of its options:

```
  async function runAgentLoop(opts: {
      anthropic: ProviderSDK,
      mcp:       McpCaller,
      ...
  })
```

The loop never constructs the provider SDK. It uses the injected instance at the one call site:

```
  response = await provider_sdk.messages.create(params)
```

In production, the route constructs the real client once and passes it down: `new ProviderSDK({ apiKey: env.API_KEY })`, then hands it to each agent's constructor. In tests, a fake object with a `messages.create` method that returns scripted content blocks is passed instead — no key, no network. Every agent takes the provider SDK as a constructor argument, propagating the seam from the route down to the loop.

```
route: new ProviderSDK({apiKey}) ──┐
                                   ├──▶ new DiagnosticAgent(sdk, mcp, ...)
test:  fakeProviderSDK           ──┘        └──▶ runAgentLoop({ sdk, mcp, ... })
                                                       sdk.messages.create()
```

---

### Current state vs. future state — be honest about the gap

```
WHAT EXISTS (testability seam)         WHAT DOES NOT (provider portability)
────────────────────────────────      ──────────────────────────────────────
inject provider SDK by param           a Provider interface (chat/complete)
inject McpCaller by param              an OpenAI/Gemini implementation of it
fakes in tests, no network             a factory: pickProvider(name) → impl
AGENT_MODEL is a hard-coded const      model/provider chosen at runtime/config
```

The injected provider parameter is typed as the *concrete* provider SDK type — not a vendor-neutral `LLMProvider` interface. The loop calls `messages.create` with the provider's specific message / tool / tool-use shapes. Swapping in another vendor would require translating message shapes, tool-call formats, and response parsing — there is no abstraction over that, and no factory to select a provider. The curriculum's "swap one vendor for another" is a **Case B** capability here: study material and a buildable target, not something the codebase does.

What the seam *does* enable, fully and well, is the thing that matters most for a 169-test suite: **fakes over the network.** The model and tool clients are injectable, so the loop's logic is tested deterministically with no key and no server.

---

### The principle

Inject your dependencies behind a narrow interface and you get testability for free; you get *portability* only if the interface is also vendor-neutral. You take the first half deliberately — the seam exists to inject fakes, and the interfaces are exactly as wide as the consumer needs — and stop short of the second half if there is one provider and no requirement to switch. Naming that boundary honestly is the point: this is a test seam, and a real provider factory is the next step, not a present feature.

---

## Provider abstraction — diagram

This diagram spans the route (constructs real clients), the agent layer (depends on interfaces), and the two implementation worlds (production vs. test). A reader who sees only this should grasp that the consumer takes its dependencies as parameters, and that the seam swaps real for fake — not Anthropic for another vendor.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ROUTE / TEST (where implementations are chosen)                     │
│                                                                       │
│  PRODUCTION  app/api/agent/route.ts                                  │
│    new Anthropic({apiKey}) ──┐                                 │
│    connectMcp → McpClient        ──┤                                 │
│  TEST                              │                                 │
│    fakeAnthropic { messages.create }──┤   inject                     │
│    scripted McpCaller             ──┘                                │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  passed as parameters (DI)
┌───────────────────────────▼───────────────────────────────────────────┐
│  AGENT LAYER (depends on INTERFACES, constructs nothing)            │
│                                                                       │
│  runAgentLoop({ anthropic: Anthropic, mcp: McpCaller, ... })         │
│     anthropic.messages.create(params)              base.ts           │
│     mcp.callTool(name, args)                       base.ts           │
│                                                                       │
│  interfaces:  McpCaller  base.ts                                     │
│               McpTransport  transport.ts L7–10                       │
│  NOTE: `anthropic` is the CONCRETE SDK type — not a vendor-neutral   │
│         LLMProvider. No factory. Single provider.                    │
└────────────────────────────────────────────────────────────────────────┘
```

The agent layer depends on interfaces and receives implementations from above. The seam swaps real clients for fakes (testability) — it does not swap Anthropic for another vendor (portability), which would need a vendor-neutral interface and a factory that do not exist.

---

## Implementation in codebase

**Partially addressed — a test seam, not provider portability.** The MCP caller and the Anthropic client are injected by parameter so tests pass fakes and run with no network; but the `anthropic` parameter is the concrete SDK type, there is no vendor-neutral provider interface, and no factory — a single Anthropic provider with no swap path.

### Files, functions, and line ranges

- **MCP transport interface:** `McpTransport` — `lib/mcp/transport.ts` L7–L10; production `SdkTransport` wrapping the SDK `Client` — L41–L74. Error-detail plumbing behind the interface: `HttpErrorHolder` (L15–L17), `makeCapturingFetch` (L24–L36), and the captured-body attach on failure (L52–L58, L66–L72).
- **Tool-error type:** `McpToolError` — `lib/mcp/client.ts` L68–L77, thrown by `McpClient.liveCall` (L161) to tag a failed call with its tool name + the underlying server detail; `errorDetail` (L55–L62) unwraps the nested cause. This is the application-layer counterpart to the transport's captured body — both make a failure legible without widening the `McpCaller` interface.
- **MCP caller interface (agent-facing):** `McpCaller` — `lib/agents/base.ts` L16–L22; intent comment ("inject a fake without depending on the concrete McpClient class or any network") — L11–L14. `McpClient` satisfies it structurally.
- **Injected Anthropic client:** `anthropic: Anthropic` in `runAgentLoop` opts — `lib/agents/base.ts` L48–L49; the single call site — L102. Real client constructed in the route — `app/api/agent/route.ts` L207 (inside the stream's `start`); propagated through each agent's constructor.
- **Hard-coded model identity (no runtime selection):** `AGENT_MODEL = 'claude-sonnet-4-6'` — `lib/agents/base.ts` L9; `CLASSIFIER_MODEL` — `lib/agents/intent.ts` L14.

### Where multi-provider would live

A vendor-neutral `LLMProvider` interface (e.g. `complete(messages, tools, maxTokens) → { text, toolCalls, usage }`) would sit in `lib/agents/` alongside `base.ts`; an `AnthropicProvider` would wrap the current `anthropic.messages.create` call and an `OpenAIProvider` would translate to/from Chat Completions. `runAgentLoop` would take `provider: LLMProvider` instead of `anthropic: Anthropic`, and a factory `createProvider(name)` (driven by config) would choose the implementation. The injection *point* already exists — only the *neutral interface* and the *factory* are missing.

---

## Elaborate

### Where this pattern comes from

Dependency injection / inversion of control is foundational software design (the Dependency Inversion Principle: depend on abstractions, not concretions). Its primary practical payoff has always been *testability* — a unit under test is isolated from slow, networked, or stateful collaborators by injecting test doubles. The "structural interface" flavor here (`McpClient` satisfies `McpCaller` without declaring it) is TypeScript's structural typing doing the work an explicit `implements` would do in a nominal language.

Provider abstraction over LLM vendors is a *related but distinct* application: a vendor-neutral interface plus a factory so the same code runs on different models. Libraries like LangChain's `BaseChatModel`, LiteLLM, and the Vercel AI SDK's provider adapters exist specifically to provide this. Crucially, vendor-neutrality requires the interface to *not* expose any one vendor's shapes — which is exactly where blooming insights' seam stops, because its interface is the concrete Anthropic type.

### The deeper principle

```
inject the dependency           +  vendor-neutral interface
──────────────────────────         ──────────────────────────────
→ TESTABILITY                       → PORTABILITY
  fakes over network                  swap providers in prod
  present in this codebase            absent in this codebase
```

These are two independent properties that happen to share a mechanism (injection). You can have testability without portability — inject the concrete client. You cannot have portability without testability — a neutral interface is injectable by construction. blooming insights sits in the first box: injection for fakes, concrete type, no swap.

### Where this breaks down

1. **Adding a second provider is not a config change — it is a refactor.** Because the seam exposes `anthropic.messages.create` with Anthropic message/tool shapes, supporting OpenAI means rewriting the loop's request building (`lib/agents/base.ts` L92–L101), tool-call extraction (L116–L118), and the synthesis calls — everywhere that touches the concrete API shape. The injection point helps, but it is not sufficient.

2. **`AGENT_MODEL` is a constant, not config.** The model is hard-coded (`lib/agents/base.ts` L9). The doc comment says "Can be swapped at call-site by changing AGENT_MODEL" — which is true for *Anthropic models*, but it is a source edit, not runtime selection, and it cannot reach a different vendor.

3. **The seam can lull you into overstating portability.** A reviewer seeing injected clients might assume provider-swapping is "almost done." It is not — the hard part (the neutral interface and the translation layers) has not been started. Naming the seam as *testability-only* prevents that misread.

### What to explore next

- **A vendor-neutral `LLMProvider` interface + factory:** the actual multi-provider capability (the exercise below).
- **LiteLLM / Vercel AI SDK provider adapters:** off-the-shelf neutral interfaces that translate to many vendors — what you'd reach for instead of hand-rolling.
- **Config-driven model selection:** move `AGENT_MODEL` from a const to environment/config so at least Anthropic-model choice is runtime, a precursor to full provider selection.

---

## Project exercises

### Introduce a vendor-neutral `LLMProvider` behind the injected parameter

- **Exercise ID:** B1.6 (adapted) — provider portability built on the existing seam.
- **What to build:** define an `LLMProvider` interface (e.g. `complete({ system, messages, tools, maxTokens }) → { text, toolCalls, usage }`), implement `AnthropicProvider` wrapping the current `anthropic.messages.create` call, and change `runAgentLoop` to take `provider: LLMProvider` instead of `anthropic: Anthropic`.
- **Why it earns its place:** demonstrates you can tell a test seam from a portability seam and convert the former into the latter without breaking the loop's logic or its tests.
- **Files to touch:** new `lib/agents/provider.ts` (interface + `AnthropicProvider`), `lib/agents/base.ts` (`runAgentLoop` signature + the L102 call), each agent constructor, `app/api/agent/route.ts` (construct the provider), the agent tests (fakes now implement `LLMProvider`).
- **Done when:** all existing tests pass against the new interface, and the loop calls `provider.complete(...)` instead of `anthropic.messages.create(...)`.
- **Estimated effort:** 1–2 days

### Add an `OpenAIProvider` and a config-driven factory

- **Exercise ID:** B1.6 (adapted) — the actual provider swap.
- **What to build:** implement `OpenAIProvider` translating to/from Chat Completions (message shapes, tool-call format, usage), add `createProvider(name)` selecting the implementation from config/env, and prove a diagnostic run works on both.
- **Why it earns its place:** shows you handled the leaky parts — tool-call semantics and structured-output differences — that make portability harder than it looks (→ 04-structured-outputs.md).
- **Files to touch:** new `lib/agents/providers/openai.ts`, `lib/agents/provider.ts` (`createProvider`), `app/api/agent/route.ts` (read the config), config/env wiring.
- **Done when:** a single config value switches a diagnostic investigation between Claude and an OpenAI model, both producing a valid `Diagnosis`.
- **Estimated effort:** 1–2 days

---

## Interview defense

### What an interviewer is really asking

"Is your system provider-agnostic?" tests whether you can tell a test seam from a portability seam. The senior signal is precision: "we inject the client for *testability* — fakes, no network — but it's the concrete Anthropic type, so swapping providers is a refactor, not a flag." Overclaiming portability because you see injected clients is the trap.

### Likely questions

**[mid] How do you test the agent loop without calling Claude or a live MCP server?**

Both are injected. `runAgentLoop` takes `anthropic` and `mcp` as parameters (`lib/agents/base.ts` L48–L62) and constructs neither; tests pass fakes — a scripted `messages.create` and a scripted `McpCaller` — so the loop runs its full logic with no network or key.

```
runAgentLoop({ anthropic: fake, mcp: fake, ... }) → no network, deterministic
```

**[senior] Could you swap Claude for GPT-4 by changing the injected client?**

No — and that's the honest distinction. The injected `anthropic` is the *concrete* SDK type, and the loop calls `anthropic.messages.create` with Anthropic message/tool/`tool_use` shapes (`lib/agents/base.ts` L92–L118). The seam enables *fakes*, not *vendors*. A real swap needs a vendor-neutral `LLMProvider` interface and translation layers — which don't exist. The injection point is the foundation for it, not the feature itself.

```
present: inject real vs fake (same Anthropic shape)
absent:  inject Anthropic vs OpenAI (needs neutral interface + translation)
```

**[arch] Would you build the provider abstraction now?**

Not without a requirement. A vendor-neutral interface plus per-provider translation is real work with a leaky-abstraction risk (vendors differ on tool-call semantics and structured outputs). Building it before a second provider is needed is speculative generality. The trigger is a concrete requirement — cost arbitrage, a reliability fallback, or a customer mandate — at which point the existing injection point is exactly what you build it on.

```
one provider, fast tests → concrete injection (now, correct)
multi-provider required  → neutral interface + factory (then)
```

### The question candidates always dodge

**"You have an abstraction over MCP and an injected Anthropic client — so you're provider-agnostic, right?"** No. The honest answer is that the seam is for *testability*, the `anthropic` parameter is the concrete vendor type, and there is no factory or neutral interface — so it is *not* provider-agnostic. Claiming portability from the presence of injection is the exact overclaim this question baits.

### One-line anchors

- `lib/agents/base.ts` L16–L22 — `McpCaller`, the structural test interface.
- `lib/mcp/transport.ts` L7–L10 — `McpTransport`; `SdkTransport` (prod) at L41–L74; `HttpErrorHolder`/`makeCapturingFetch` at L15–L36.
- `lib/mcp/client.ts` L68–L77 — `McpToolError`, the tool-tagged failure type thrown by `McpClient.liveCall` (L161).
- `lib/agents/base.ts` L48–L62 — injected `anthropic` + `mcp` params; concrete SDK type.
- `lib/agents/base.ts` L9 — `AGENT_MODEL` hard-coded; no runtime/vendor selection.
- Test seam ≠ provider portability: same mechanism, different (and here, only the first) property.

---

## See also

→ 01-what-an-llm-is.md · → 04-structured-outputs.md · → 06-token-economics.md · → 05-streaming.md

---
Updated: 2026-05-28 — Documented the transport's `HttpErrorHolder`/`makeCapturingFetch` error-body capture and `client.ts`'s `McpToolError` (both error-detail plumbing behind the unchanged narrow interface); re-derived transport.ts (`McpTransport` L7–10, `SdkTransport` L41–74) and the route's `new Anthropic` location (now L207, inside the stream).
Updated: 2026-05-29 — Test count 157→169 (both occurrences).
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
