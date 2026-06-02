# Provider / transport abstraction

**Industry name(s):** Dependency inversion, Strategy pattern, Adapter pattern, ports-and-adapters (hexagonal)
**Type:** Industry standard · Language-agnostic

> Code that depends on a thin interface it owns — not on the vendor SDK it happens to use — can be tested with a plain object fake and swapped to a different backend without touching callers.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The provider/transport abstraction is a vertical seam, not a horizontal band — it cuts through the Agent loop band (`McpCaller` interface) and the Provider wrappers band (`McpTransport` interface), separating "code that depends on a behavior" from "code that talks to the vendor SDK." `runAgentLoop` depends on an `McpCaller`; `McpClient` depends on an `McpTransport`. The two real implementations (`McpClient` itself, `SdkTransport`) live in production; the two test fakes (`buildFakeMcp`, `fakeTransport`) live in `test/`. This is why 125 tests run offline without an API key or an MCP server — the seam is everywhere a vendor edge would have been.

```
Zoom out — where the provider/transport seam lives

┌─ Agent loop ───────────────────────────────────┐
│  runAgentLoop(opts: { anthropic, mcp, ... })   │
│  depends on ↓                                  │
│  ★ McpCaller ★  (lib/agents/base.ts L16–L22)  │ ← seam #1
│         │                  │                   │
│   McpClient        buildFakeMcp (test)         │
│  (prod)            base.test.ts                │
└─────────────────────┬──────────────────────────┘
                      │  depends on ↓
┌─ Provider wrappers ─▼──────────────────────────┐  ← we are here
│  McpClient (cache · spacing · retry)           │
│  depends on ↓                                  │
│  ★ McpTransport ★  (lib/mcp/transport.ts L7) │ ← seam #2
│         │                  │                   │
│   SdkTransport     fakeTransport (test)        │
│  (prod)            client.test.ts              │
└─────────────────────┬──────────────────────────┘
                      │
┌─ Vendor SDKs ──────────────────────────────────┐
│  @modelcontextprotocol/sdk · @anthropic-ai/sdk │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you test code that drives a vendor SDK without touching the network or paying for tokens? The answer is two narrow interfaces this codebase *owns* — `McpTransport` (two methods: `callTool`, `listTools`) and `McpCaller` (one method: `callTool`) — and constructor/parameter injection at the edges (`new McpClient(transport)`, `runAgentLoop({ anthropic, mcp })`). Production passes real implementations; tests pass plain objects that satisfy the same shape. The next sections walk both interfaces and the two flavors of injection.

---

## Structure pass

**Layers.** The provider abstraction is a vertical stack, not a horizontal one. Four layers: the **caller** (any code that needs MCP behavior — `runAgentLoop`, `McpClient` itself), the **owned interface** (`McpCaller` and `McpTransport` — TypeScript types this codebase defines), the **implementation slot** (the concrete object that satisfies the interface — real `McpClient`/`SdkTransport` in prod, plain-object fakes in tests), and the **vendor SDK / network** (the `@modelcontextprotocol/sdk` calls and the wire). Two seams sit between four layers — this is the load-bearing detail that makes the whole codebase testable offline.

**Axis: dependency.** Which direction does the type-arrow point at each layer boundary? This is the right axis because the entire reason this abstraction exists is dependency *inversion* — flipping who points at whom. State and control work but flatten things: state would frame it as "where do tool results live" (everywhere — boring); control would frame it as "who calls callTool" (the caller — also boring). Dependency pops the seam: in a naive design the caller depends on the SDK; here the caller depends on a type *this codebase owns*, and the SDK is the thing that depends on satisfying it. That arrow-flip is the whole pattern.

**Seams.** Two seams matter; both are load-bearing because they're the *same pattern* repeated. **Seam 1: caller → owned interface.** Dependency flips from "I import vendor types" to "I import my own interface type." Cosmetic if the interface mirrors the SDK exactly — load-bearing because it doesn't (the owned interfaces are narrower: two methods, not the full SDK surface). **Seam 2: owned interface → implementation slot.** Dependency flips from TYPE to OBJECT, and the object can be a real SDK adapter or a plain-object test fake — the type can't tell. This seam is why 125 tests run with no network: every place a vendor edge would be is instead a swap point.

```
Structure pass — provider abstraction

┌─ 1. LAYERS ────────────────────────────────────────────┐
│  Caller · Owned interface (McpCaller/McpTransport) ·   │
│  Implementation slot · Vendor SDK / network            │
└───────────────────────────┬────────────────────────────┘
                            │  pick the axis
┌─ 2. AXIS ────────────────▼─────────────────────────────┐
│  dependency: which way does the type-arrow point at    │
│  each boundary?                                        │
└───────────────────────────┬────────────────────────────┘
                            │  trace across layers, find flips
┌─ 3. SEAMS ───────────────▼─────────────────────────────┐
│  S1: caller → owned interface (vendor types → own type)│
│  S2: owned interface → impl slot ★load-bearing         │
│      (TYPE → OBJECT; real adapter or test fake)        │
└───────────────────────────┬────────────────────────────┘
                            ▼
                    Block 4 — How it works
```

```
S2 seam — "what satisfies this type?" answered two ways

┌─ Owned interface ─┐    seam     ┌─ Implementation slot ──┐
│  type McpCaller = │ ═════╪═════►│  prod: SdkTransport →   │
│  { callTool(...) }│  (it flips) │        vendor SDK       │
│                   │             │  test: { callTool: fn } │
└───────────────────┘             └─────────────────────────┘
        ▲                                       ▲
        └──── same axis (dependency), two answers ─┘
              → this is why 125 tests run offline
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

---

## How it works

A caller asks for behaviour through an interface it owns. The real implementation satisfies that interface by delegating to the vendor SDK. A fake implementation satisfies the same interface with a plain object. The caller never knows which it got.

```
┌────────────────────────────────────────────────┐
│                   Caller                        │
│  (provider wrapper, agent loop, your component) │
└──────────────────────┬─────────────────────────┘
                       │ depends on interface only
                       ▼
          ┌────────────────────────┐
          │     Owned interface    │
          │  Transport             │
          │  Caller                │
          └────────┬───────────────┘
                   │
       ┌───────────┴────────────┐
       ▼                        ▼
┌──────────────┐       ┌──────────────────┐
│  Real impl   │       │   Fake / test    │
│  SDK adapter │       │   plain object   │
│  (prod)      │       │   (tests)        │
└──────┬───────┘       └──────────────────┘
       │
       ▼
 Vendor SDK / network
```

The interface sits between the caller and the vendor. Tests plug in the right branch; production plugs in the left. The load-bearing piece below is *the fake* — the SDK adapter is the obvious half, but it's the plain-object fake (5 lines, no framework) that's the actual value: it's why 125 tests run with no API key and no MCP server.

### The transport interface

The transport is a two-method surface defined in this codebase, not imported from the vendor SDK:

```
interface Transport:
    callTool(name, args)  → Promise<result>
    listTools()           → Promise<tool_list>
```

Two methods. No vendor SDK import here. The provider wrapper imports this interface, not the SDK class. Any object with those two signatures satisfies it — the type system enforces nothing more.

```
Transport interface
┌─────────────────────────────────────────────────┐
│  callTool(name, args) → Promise<unknown>         │
│  listTools()          → Promise<unknown>         │
└─────────────────────────────────────────────────┘
         ▲                         ▲
         │ implements               │ structurally satisfies
  SDK adapter                  fake transport (test)
```

### The SDK adapter, the real implementation

The SDK adapter holds a `Client` from the vendor SDK and delegates. Its constructor also accepts an optional error-capture holder: the adapter pairs with a capturing `fetch` that records the body of any non-OK HTTP response into the holder, so a failed tool call can throw the *real* server error text instead of a generic "Unauthorized":

```
class SdkAdapter implements Transport:
    constructor(client):
        self.client = client

    callTool(name, args):
        return await self.client.callTool({ name, arguments: args })

    listTools():
        return await self.client.listTools()
```

The `implements Transport` clause is belt-and-suspenders — TypeScript's structural typing would also accept the same shape without the keyword. The keyword is documentation: it declares intent and makes the compiler tell you immediately if the SDK changes a method signature.

### The fake in tests

A test fake is a plain object that satisfies the transport interface:

```
fakeTransport(impl):
    t = {
      calls: 0,
      callTool(name)  ─▶  t.calls += 1; return impl(name),
      listTools()     ─▶  return { tools: [] },
    }
    return t
```

It is not a class. It is not a mock created by a mocking framework. It is a plain object that happens to have the right shape. It also counts calls so tests can assert how many times the transport was hit — handy for verifying cache behaviour.

```
fakeTransport({ calls: 0, callTool, listTools })
         │
         │  passed to constructor
         ▼
new ProviderWrapper(fakeTransport)   ← no SDK, no network
         │
         │  test calls
         ▼
wrapper.callTool('whoami', {})       ← hits the fake's counter
```

### Caller — the same trick one layer up

Agents need to call tools, but they should not be coupled to the full provider wrapper class with its cache, retry logic, and rate-limiter. A one-method surface lives in the agent module:

```
interface Caller:
    callTool(
      name,
      args,
      opts?: { cacheTtlMs?, skipCache? },
    ) → Promise<{ result, durationMs, fromCache }>
```

The provider wrapper never explicitly says `implements Caller`. It does not need to — structural typing means any object whose `callTool` signature is a superset of what `Caller` demands is accepted without ceremony. In production, the real wrapper is passed; in tests, a hand-written fake is passed.

```
Caller interface       Provider wrapper (prod)
┌────────────┐         ┌───────────────────┐
│ callTool   │◀────────│ callTool + cache  │  structurally satisfies
│            │         │ + retry + rate    │
└────────────┘         └───────────────────┘
      ▲
      │  also satisfies (structurally)
┌─────────────────────────┐
│ fake caller (test)      │
│ { callTool: async fn }  │
└─────────────────────────┘
```

A test fake matching the `Caller` shape:

```
buildFakeMcp(impl):
    return {
      callTool(name, args):
          result = await impl(name, args)
          return { result, durationMs: 1, fromCache: false }
    }
```

### Injecting the provider SDK as a parameter

The shared agent loop takes the provider SDK client as a named parameter. There is no singleton import, no module-level `new Provider()`. The parameter type is the SDK's own client class — but structural typing means tests can pass any object that satisfies the shape the loop actually uses.

A scripted fake, cast to the SDK type at the call site:

```
anthropic = {
  messages: { create },   # spy returning scripted responses
}
// ...
runAgentLoop({
  anthropic: anthropic as unknown as Anthropic,
  mcp,
  // ...
})
```

The `as unknown as Anthropic` cast is honest: the fake only implements the slice of the SDK that the agent loop actually calls (`messages.create`). The double cast (`as unknown` first) tells the compiler "I know what I'm doing." This is standard practice when injecting narrow fakes for a complex third-party type.

### The principle

Depend on interfaces you own, not on vendors. Every interface in this pattern (`Transport`, `Caller`) is defined inside the codebase, not re-exported from the SDK. The codebase controls the surface. If the SDK changes, exactly one file changes — the adapter — and all callers are unaffected.

---

## Provider / transport abstraction — diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER                                                           │
│                                                                          │
│   McpClient                       runAgentLoop (lib/agents/base.ts)     │
│   constructor(transport: McpTransport)   opts: { anthropic, mcp }       │
│   liveCall → transport.callTool          mcp.callTool → McpCaller        │
│                                          anthropic.messages.create       │
└──────────────────────┬───────────────────────────┬──────────────────────┘
                       │                           │
             McpTransport interface          McpCaller interface
             (lib/mcp/transport.ts)          (lib/agents/base.ts)
                       │                           │
          ┌────────────┴──────┐         ┌──────────┴───────────┐
          ▼                   ▼         ▼                       ▼
┌──────────────────┐  ┌────────────┐  ┌──────────────┐  ┌──────────────┐
│  PROVIDER LAYER  │  │ TEST LAYER │  │ PROVIDER     │  │ TEST LAYER   │
│                  │  │            │  │              │  │              │
│  SdkTransport    │  │fakeTransport  │  McpClient   │  │buildFakeMcp  │
│  implements      │  │(client.test)  │  (prod)      │  │(base.test)   │
│  McpTransport    │  │            │  │              │  │              │
└────────┬─────────┘  └────────────┘  └──────┬───────┘  └──────────────┘
         │                                    │
         ▼                                    │  ┌──────────────────────┐
┌──────────────────────┐                      │  │ buildFakeAnthropic   │
│  @modelcontextprotocol│                     │  │ (base.test)          │
│  /sdk Client         │                      │  │ scripted responses   │
│  client.callTool()   │                      │  │ vi.fn()              │
│  client.listTools()  │                      │  └──────────────────────┘
└──────────────────────┘                      │
                                              ▼
                                    @anthropic-ai/sdk
                                    (production only)
```

The two interface boundaries are the seam. Everything above the seam is testable offline. Everything below the seam is swappable without touching callers.

---

## Implementation in codebase

### lib/mcp/transport.ts

**Interface** (L7–L10): `McpTransport` — the two-method contract callers depend on.
**Capturing-fetch error seam** (`HttpErrorHolder` L15–L17, `makeCapturingFetch` L24–L36): a `fetch` wrapper that stashes the body of any non-OK response so transport errors carry the real server text.
**Real impl** (L41–L74): `SdkTransport` — wraps `Client` from `@modelcontextprotocol/sdk` (and an optional `HttpErrorHolder`, L42–L45). The only file that imports the SDK client class.

GitHub: `lib/mcp/transport.ts`

```typescript
// L7–L10
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<unknown>;
}
```

### lib/mcp/client.ts

**Constructor** (L87–L95): `McpClient` receives `private transport: McpTransport`. Imports only the interface, never `SdkTransport` or the MCP SDK.

```typescript
// L87–L95
constructor(private transport: McpTransport, opts: ClientOpts = {}) {
  this.minIntervalMs = opts.minIntervalMs ?? 200;
  this.maxRetries = opts.maxRetries ?? 3;
  this.retryDelayMs = opts.retryDelayMs ?? 10_000;
  this.retryCeilingMs = opts.retryCeilingMs ?? 20_000;
}
```

**Live call** (L148–L163): `liveCall` delegates to `this.transport.callTool` — the only place the transport is actually called. A thrown transport error is re-tagged as a `McpToolError` (`lib/mcp/client.ts` L68–L77) carrying the tool name and the captured server detail.

GitHub: `lib/mcp/client.ts`

### lib/agents/base.ts

**McpCaller interface** (L16–L22): one-method surface agents depend on.
**runAgentLoop signature** (L48–L62): takes `anthropic: Anthropic` and `mcp: McpCaller` as named params — both injectable.

```typescript
// L16–L22
export interface McpCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { cacheTtlMs?: number; skipCache?: boolean },
  ): Promise<{ result: unknown; durationMs: number; fromCache: boolean }>;
}
```

GitHub: `lib/agents/base.ts`

### test/mcp/client.test.ts

**fakeTransport** (L5–L12): plain object satisfying `McpTransport`, counting calls. Every one of the 14 tests in this file passes a `fakeTransport` to `new McpClient(t)` — no real MCP connection required.

### test/agents/base.test.ts

**buildFakeAnthropic** (L16–L56): constructs a `{ messages: { create: vi.fn() } }` object with scripted response sequences, cast `as unknown as Anthropic` at the call site.
**buildFakeMcp** (L76–L83): plain object satisfying `McpCaller`.

Both fakes are passed directly into `runAgentLoop` at test call sites (e.g., L127–L135).

GitHub: `test/agents/base.test.ts`

---

## Elaborate

### Where it comes from

This is dependency inversion (the D in SOLID): high-level modules should not depend on low-level modules; both should depend on abstractions. Ports-and-adapters (hexagonal architecture) uses the same idea at a larger scale: the application core defines "ports" (interfaces); "adapters" (concrete implementations) plug in from outside. `McpTransport` and `McpCaller` are ports. `SdkTransport` and `McpClient` are adapters.

### The deeper principle

```
┌──────────────────────────────────────────┐
│  High-level policy                       │
│  (agent loop logic, cache policy)        │
│  depends on ▼                            │
├──────────────────────────────────────────┤
│  Abstraction (interface you own)         │
│  McpTransport / McpCaller                │
│  depends on ▲ (nothing)                  │
├──────────────────────────────────────────┤
│  Low-level detail (vendor SDK)           │
│  SdkTransport / Anthropic client         │
│  depends on ▲ (the interface)            │
└──────────────────────────────────────────┘
```

The dependency arrows all point toward the interface layer. Neither the policy layer nor the detail layer knows about the other directly.

### Where it breaks down

The interface is a commitment. If the MCP SDK adds a method callers need — say, `listResources` — the interface must be updated, `SdkTransport` must implement it, and every fake in tests must add it (or TypeScript will refuse to compile). For a two-method surface this is cheap. For a surface that mirrors dozens of SDK methods, the maintenance cost rises and the interface becomes a leaky abstraction that must track every SDK change.

A second failure mode: the interface hides capability. `SdkTransport.callTool` collapses the SDK's typed result into `Promise<unknown>`. Callers lose the SDK's response type information and must cast. This is a deliberate tradeoff for testability.

### What to explore next

- How `McpClient`'s cache and rate-limiter sit between the interface seam and the caller — they are only possible because the transport is injectable (`04-caching-and-rate-limiting.md`).
- How the four agents each receive the same `McpCaller` interface but build different system prompts and tool schemas (`06-multi-agent-orchestration.md`).
- TypeScript structural typing: understand why `McpClient` satisfies `McpCaller` without `implements McpCaller` — search for "duck typing" and "structural vs nominal type systems."

---

## Interview defense

**What they're really asking:** "Do you understand why this code is structured this way, and can you distinguish deliberate design from accidental complexity?"

---

**[mid] Why does `McpClient` take a `McpTransport` in its constructor instead of just creating an `SdkTransport` internally?**

So the test can pass a fake. If `McpClient` constructs `SdkTransport` internally, the only way to test it without a live MCP server is to intercept the `@modelcontextprotocol/sdk` module — which couples tests to the module system and import paths. Passing the transport in makes every test a matter of constructing a plain object. The cache, retry, and rate-limit logic in `McpClient` is all exercised in `test/mcp/client.test.ts` using `fakeTransport` objects that never touch a socket.

---

**[senior] `runAgentLoop` takes `anthropic: Anthropic` and `mcp: McpCaller` as parameters. What would break if instead you imported `new Anthropic()` at the top of `base.ts` and used it as a module-level singleton?**

```
Current (injectable)            Singleton import
┌───────────────────────┐      ┌───────────────────────┐
│ runAgentLoop({        │      │ import anthropic from  │
│   anthropic,          │      │   '@anthropic-ai/sdk'  │
│   mcp, ...            │      │                        │
│ })                    │      │ const client = new     │
│   ▲                   │      │   Anthropic()          │
│   │ injected fake     │      │                        │
│ tests: no keys needed │      │ tests: need real keys  │
└───────────────────────┘      │ or vi.mock the module  │
                               └───────────────────────┘
```

With a module-level singleton: (1) every test that calls `runAgentLoop` makes a real Anthropic API request; (2) `ANTHROPIC_API_KEY` must be present in every CI environment; (3) you cannot script responses to test specific tool-call sequences; (4) rate limits can fail tests non-deterministically. The parameter injection costs one extra argument per call site and gains complete test control.

---

**[arch] This pattern adds an interface and an adapter file per vendor. At what scale does that cost outweigh the benefit?**

```
Low vendor-surface (2 methods)       High vendor-surface (15+ methods)
┌──────────────────────────┐         ┌──────────────────────────────┐
│ McpTransport             │         │ BigVendorInterface           │
│  callTool                │         │  methodA … methodP           │
│  listTools               │         │  every SDK change → 3 files  │
│                          │         │  every fake → 15 methods     │
│  easy to maintain        │         │                              │
│  fakes are 5-line objects│         │  interface is a leaky mirror │
└──────────────────────────┘         └──────────────────────────────┘
```

The pattern pays when the app uses a small, stable slice of a vendor API. It breaks down when: (a) the interface must mirror 10+ methods and any SDK change cascades through interface + adapter + all fakes; (b) the SDK's rich return types get erased to `unknown` at the interface boundary, requiring unsafe casts everywhere; (c) multiple teams own different adapters and the interface becomes a coordination bottleneck. The alternative at that scale is accepting the SDK coupling and using integration tests with a local stub server (or the SDK's own test utilities if they exist).

---

**The dodge: "Isn't this interface just indirection you don't need for one SDK?"**

Honest answer: for a codebase that will never swap the MCP SDK and has good integration-test infrastructure, yes — the interface adds a file and a maintenance obligation for modest gain. The gain here is specific: the agent loop must be unit-tested cheaply because it contains branching logic (tool-call budget, synthesis instruction, maxTurns exit) that is impractical to exercise against a live API. The interface is not here for future SDK swapping — it is here for the 8 test cases in `base.test.ts` that each script a different response sequence.

```
Without the seam         With the seam
┌──────────────────┐    ┌──────────────────────────────┐
│ test budget logic│    │ test budget logic             │
│ → needs live API │    │ → scripted fake               │
│ → ~2s per test   │    │ → <5ms per test               │
│ → needs API key  │    │ → no key                      │
│ → non-deterministic    │ → deterministic               │
└──────────────────┘    └──────────────────────────────┘
```

---

**Anchors:**
- `lib/mcp/transport.ts` L7–L10: the two-method interface that is the seam
- `lib/mcp/client.ts` L87: constructor injection — `private transport: McpTransport`
- `lib/agents/base.ts` L16–L22: `McpCaller`, the one-method surface for agents
- `lib/agents/base.ts` L49–L50: `runAgentLoop` opts — `anthropic: Anthropic; mcp: McpCaller`
- `test/mcp/client.test.ts` L5–L12: `fakeTransport` — the plain object that proves the seam works

---

## Validate your understanding

### Level 1 — Reconstruct

Without looking at the code, draw the three-layer structure: service layer, interface layer, provider layer. Place `McpClient`, `SdkTransport`, `McpTransport`, and `fakeTransport` into the correct layer. Add the test layer as a parallel branch to the provider layer. Check your diagram against the primary diagram in this file.

### Level 2 — Explain

Open `lib/mcp/transport.ts`. Read L7–L10 (`McpTransport`) and L41–L74 (`SdkTransport`). Explain in one sentence why `McpClient` imports `McpTransport` but not `SdkTransport` or `Client`. Then explain what would break in `test/mcp/client.test.ts` if `McpClient` constructed `SdkTransport` internally instead of receiving a transport.

### Level 3 — Apply

Scenario: you need to add request logging to every MCP tool call — log the tool name, arguments, and duration to the console before and after each live call.

Where does the logging code go? The options are `SdkTransport.callTool` (provider layer), `McpClient.liveCall` (service layer), or a new `LoggingTransport` that wraps `SdkTransport`.

Cite:
- `lib/mcp/client.ts` L148–L163 (`liveCall`) — this is where the spacing gate runs and the transport is called.
- `lib/mcp/transport.ts` L47–L59 — this is where the raw SDK call happens.

Answer: logging belongs in `McpClient.liveCall` (L148–L163) if you want it co-located with rate-limit enforcement. It belongs in a wrapping `LoggingTransport` if you want the transport layer to be independently observable without touching `McpClient`. Both work. What stays untouched in either case: `SdkTransport`, all test fakes (they satisfy `McpTransport` and do not need to log), and `runAgentLoop`.

### Level 4 — Defend

A teammate proposes: "The `McpCaller` interface is pointless — `McpClient` is the only thing that satisfies it, so we should just type `mcp` as `McpClient` in `runAgentLoop`." Formulate a two-sentence rebuttal grounded in `test/agents/base.test.ts` L76–L83. Then acknowledge the one case where the teammate would be right.

### Quick check

- What are the two methods on `McpTransport`?
- Which file is the only one that imports `Client` from `@modelcontextprotocol/sdk`?
- Why does `buildFakeAnthropic` use `as unknown as Anthropic` rather than constructing a real `Anthropic` instance?
- Name one thing `fakeTransport` tracks that lets tests verify caching behaviour.
- In `runAgentLoop`, what is the parameter type of `mcp` and why is it not `McpClient`?

## See also

→ [audit.md](./audit.md) (system-map-and-boundaries lens — `McpCaller` + `McpTransport` seams) · [01-request-flow.md](./01-request-flow.md) · [04-caching-and-rate-limiting.md](./04-caching-and-rate-limiting.md) · [06-multi-agent-orchestration.md](./06-multi-agent-orchestration.md)

---
Updated: 2026-06-02 — promoted from legacy archive `.aipe/study-system-design/` into v1.59.2 audit-style layout; See also cross-links re-pointed to sibling pattern files + audit.md lens.
Updated: 2026-05-28 — refreshed code references to current line numbers; added a note on the capturing-fetch error seam (`HttpErrorHolder`/`makeCapturingFetch`) and `McpToolError`
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-05-31 — Applied study.md v1.52 voice trait (verdict first, then rank what matters) — clarity edits to Move 2.
