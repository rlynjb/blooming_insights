# Provider / transport abstraction

**Industry name(s):** Dependency inversion, Strategy pattern, Adapter pattern, ports-and-adapters (hexagonal)
**Type:** Industry standard · Language-agnostic

> Code that depends on a thin interface it owns — not on the vendor SDK it happens to use — can be tested with a plain object fake and swapped to a different backend without touching callers.

**See also:** → 01-request-flow.md · → 04-caching-and-rate-limiting.md · → 06-multi-agent-orchestration.md

---

## Why care

You wrote a `<UserList />` component that calls `fetch('/api/users')` directly inside `useEffect`. The component works in the browser. Now you write a test. The test environment has no network, so `fetch` errors, or you're forced to intercept it with `msw` or `vi.mock`. Neither option is great: `msw` is a full interceptor layer, and `vi.mock` ties the test to the import path of whatever `fetch` polyfill you're using. What you really want is to pass the data-fetcher as a prop — `<UserList fetchUsers={fn} />` — so the test hands in a function that returns a fixed array, no network required. That prop is the seam.

The question this pattern answers: how do you test code that drives a network service or vendor SDK without touching the network?

**The stakes are concrete.** The agent loop in this codebase makes real Anthropic API calls and real MCP tool calls. Without an injectable seam every agent test needs live API keys, an active MCP server, and patience for ~1 req/s rate limits. With the seam, 125 tests run offline in ~0.5 s.

Before the seam:
- tests require `ANTHROPIC_API_KEY` in the environment
- a flaky network connection fails the entire test suite
- CI costs real tokens on every run
- rate-limit retries in `McpClient` can't be triggered deterministically

After the seam:
- tests pass no-network, no-key, in under a second
- fakes return scripted responses, including errors and rate-limit payloads
- retry logic is exercised deterministically by returning a failing result first
- the Anthropic client or MCP SDK can be swapped by changing one constructor argument

It is passing your dependency as a prop, but for a backend client.

---

## How it works

A caller asks for behaviour through an interface it owns. The real implementation satisfies that interface by delegating to the vendor SDK. A fake implementation satisfies the same interface with a plain object. The caller never knows which it got.

```
┌────────────────────────────────────────────────┐
│                   Caller                        │
│  (McpClient, runAgentLoop, your component)      │
└──────────────────────┬─────────────────────────┘
                       │ depends on interface only
                       ▼
          ┌────────────────────────┐
          │     Owned interface    │
          │  McpTransport          │
          │  McpCaller             │
          │  (fetchUsers prop)     │
          └────────┬───────────────┘
                   │
       ┌───────────┴────────────┐
       ▼                        ▼
┌──────────────┐       ┌──────────────────┐
│  Real impl   │       │   Fake / test    │
│  SdkTransport│       │   fakeTransport  │
│  McpClient   │       │   buildFakeMcp   │
│  (prod)      │       │   (tests)        │
└──────┬───────┘       └──────────────────┘
       │
       ▼
 Vendor SDK / network
 (@modelcontextprotocol/sdk, @anthropic-ai/sdk)
```

The interface sits between the caller and the vendor. Tests plug in the right branch; production plugs in the left.

### The McpTransport interface

`McpTransport` is the two-method surface defined in `lib/mcp/transport.ts` L7–L10:

```typescript
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<unknown>;
}
```

Two methods. No import from `@modelcontextprotocol/sdk`. `McpClient` imports this interface, not the SDK class. Any object with those two signatures satisfies it — the TypeScript compiler enforces nothing more.

```
McpTransport interface
┌─────────────────────────────────────────────────┐
│  callTool(name, args) → Promise<unknown>         │
│  listTools()          → Promise<unknown>         │
└─────────────────────────────────────────────────┘
         ▲                         ▲
         │ implements               │ structurally satisfies
  SdkTransport               fakeTransport (test)
```

### SdkTransport, the real implementation

`SdkTransport` (`lib/mcp/transport.ts` L41–L74) holds a `Client` from the MCP SDK and delegates. Its constructor also accepts an optional `httpErrors?: HttpErrorHolder` (L42–L45): the transport pairs with a capturing fetch (`makeCapturingFetch`, L24–L36) that records the body of any non-OK HTTP response into the holder, so a failed tool call can throw the *real* server error text instead of a generic "Unauthorized":

```typescript
export class SdkTransport implements McpTransport {
  constructor(private client: Client) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.client.callTool({ name, arguments: args });
    return res;
  }
  async listTools(): Promise<unknown> {
    return this.client.listTools();
  }
}
```

The `implements McpTransport` clause is belt-and-suspenders — TypeScript would also accept structural matching without the keyword. The keyword is documentation: it declares intent and makes the compiler tell you immediately if the SDK changes a method signature.

### The fake in tests

`test/mcp/client.test.ts` L5–L12 defines a plain-object fake that satisfies `McpTransport`:

```typescript
function fakeTransport(impl: (name: string) => unknown): McpTransport & { calls: number } {
  const t = {
    calls: 0,
    async callTool(name: string) { t.calls++; return impl(name); },
    async listTools() { return { tools: [] }; },
  };
  return t;
}
```

It is not a class. It is not a mock created by `vi.mock`. It is a plain object that happens to have the right shape. It also counts calls so tests can assert how many times the transport was hit — handy for verifying cache behaviour.

```
fakeTransport({ calls: 0, callTool, listTools })
         │
         │  passed to constructor
         ▼
new McpClient(fakeTransport)   ← no SDK, no network
         │
         │  test calls
         ▼
c.callTool('whoami', {})       ← hits the fake's counter
```

### McpCaller — the same trick one layer up

Agents need to call MCP tools, but they should not be coupled to the full `McpClient` class with its cache, retry logic, and rate-limiter. `lib/agents/base.ts` L16–L22 defines a one-method surface:

```typescript
export interface McpCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { cacheTtlMs?: number; skipCache?: boolean },
  ): Promise<{ result: unknown; durationMs: number; fromCache: boolean }>;
}
```

`McpClient` never says `implements McpCaller`. It does not need to — TypeScript's structural typing means any object whose `callTool` signature is a superset of what `McpCaller` demands is accepted without ceremony. In production, `McpClient` is passed; in tests, a hand-written fake is passed.

```
McpCaller interface    McpClient (prod)
┌────────────┐         ┌───────────────────┐
│ callTool   │◀────────│ callTool + cache  │  structurally satisfies
│            │         │ + retry + rate    │
└────────────┘         └───────────────────┘
      ▲
      │  also satisfies (structurally)
┌─────────────────────────┐
│ buildFakeMcp (test)     │
│ { callTool: async fn }  │
└─────────────────────────┘
```

`test/agents/base.test.ts` L76–L83:

```typescript
function buildFakeMcp(impl: (name: string, args: Record<string, unknown>) => Promise<unknown>): McpCaller {
  return {
    async callTool(name, args) {
      const result = await impl(name, args);
      return { result, durationMs: 1, fromCache: false };
    },
  };
}
```

### Injecting Anthropic as a parameter

`runAgentLoop` takes `anthropic: Anthropic` as a named parameter (`lib/agents/base.ts` L48–L62). There is no singleton import, no module-level `new Anthropic()`. The parameter type is the SDK's own `Anthropic` class — but TypeScript structural typing means tests can pass any object that satisfies the shape the loop actually uses.

`test/agents/base.test.ts` L16–L56 builds a scripted fake and casts it:

```typescript
const anthropic = {
  messages: { create },   // vi.fn() returning scripted responses
};
// ...
await runAgentLoop({
  anthropic: anthropic as unknown as Anthropic,
  mcp,
  // ...
});
```

The `as unknown as Anthropic` cast is honest: the fake only implements the slice of the Anthropic SDK that `runAgentLoop` actually calls (`messages.create`). The double cast (`as unknown` first) tells the compiler "I know what I'm doing." This is standard practice when injecting narrow fakes for a complex third-party type.

### The principle

Depend on interfaces you own, not on vendors. Every interface in this codebase (`McpTransport`, `McpCaller`) is defined in the codebase itself, not re-exported from the SDK. The codebase controls the surface. If the SDK changes, exactly one file changes — the adapter — and all callers are unaffected.

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

## In this codebase

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

## Tradeoffs

| Dimension              | Thin interface + adapter (this codebase)      | Call the SDK directly everywhere          |
|------------------------|-----------------------------------------------|-------------------------------------------|
| **Test setup**         | Pass a plain-object fake; no network          | Must mock the SDK module or have live keys|
| **Test speed**         | ~0.5 s for 125 tests offline                  | Seconds per test waiting on network       |
| **Files to maintain**  | Extra: `transport.ts` interface + `SdkTransport`; fakes in tests | Fewer files; SDK is used inline     |
| **SDK swap**           | Change one file (`SdkTransport`)              | Change every call site                    |
| **Type safety**        | `callTool` returns `unknown`; callers cast    | SDK's full typed return available inline  |
| **Interface drift**    | Interface lags new SDK features until updated | SDK's full surface always available       |

**What this approach gave up:** one extra file per abstraction layer; an interface that must be kept in sync when the SDK adds methods; `unknown` return types instead of SDK-typed responses.

**What calling the SDK directly costs:** agent and client tests become integration tests requiring live credentials; flaky CI when the network is slow; no way to trigger rate-limit retry paths deterministically; changing the SDK client means updating every call site.

**The breakpoint:** when the slice of the SDK surface the app actually uses grows beyond 3–4 methods, the interface maintenance cost rises sharply. At 10+ methods, consider a generated adapter or accept the coupling.

---

## Tech reference (industry pairing)

### @modelcontextprotocol/sdk client

- The `Client` class is wrapped by `SdkTransport`, never imported by `McpClient` or agents.
- `client.callTool({ name, arguments })` — note `arguments` (not `args`) is the SDK's parameter key; `SdkTransport.callTool` bridges the naming difference.
- `client.listTools()` returns a typed object; `SdkTransport` returns it as `Promise<unknown>` to keep the interface simple.
- Connection and authentication are handled upstream (in `auth.ts`/`connect.ts`); `SdkTransport` receives an already-connected `Client`.
- The SDK is a compile-time and runtime dependency only in files that construct `SdkTransport` — the rest of the codebase is SDK-free.

### Vitest (injection-based testing)

- `vi.fn()` creates a tracked mock function; `buildFakeAnthropic` uses it to build scripted Anthropic responses (`base.test.ts` L23`).
- `vi.useFakeTimers()` / `vi.advanceTimersByTime()` let `client.test.ts` test time-dependent behaviour (TTL expiry, rate-limit intervals) without real sleeps.
- No `vi.mock('module')` calls anywhere in the agent or MCP tests — the injection approach makes module mocking unnecessary.
- `expect(create).toHaveBeenCalledTimes(n)` verifies how many Anthropic API turns the loop consumed — only possible because `create` is a `vi.fn()`.
- Tests are in `describe` blocks per class/function; each `it` constructs its own fake, avoiding shared state between cases.

### TypeScript structural typing

- TypeScript checks compatibility by shape, not by name. An object `{ callTool: async fn, listTools: async fn }` satisfies `McpTransport` without `implements McpTransport`.
- `McpClient` satisfies `McpCaller` because its `callTool` signature is a superset of `McpCaller.callTool` — `McpClient` accepts an extra optional `opts` parameter.
- The `as unknown as Anthropic` double cast (`base.test.ts` L128) is a TypeScript pattern for injecting a narrow fake of a complex type when the narrow slice is all the code under test actually uses.
- `implements McpTransport` on `SdkTransport` is documentation; the compiler would also accept a structurally-matching class without the keyword.
- TypeScript's structural typing is the mechanism that makes the pattern lightweight: no registration, no decorator, no DI container — just the right shape.

---

## Summary

**Part 1 recap:** `McpClient` depends on `McpTransport` (a two-method interface it owns) rather than on the MCP SDK's `Client` class. `SdkTransport` is the one file that knows about the SDK. `runAgentLoop` takes both `anthropic` and `mcp` as injected parameters. Tests pass plain-object fakes for both, enabling 125 offline tests in ~0.5 s.

- This is the `D` in SOLID applied at the SDK boundary: own the interface, wrap the vendor.
- TypeScript structural typing is the mechanism — no DI framework or decorator needed.
- The seam is the same thing as passing a data-fetcher as a prop to `<UserList />` — same idea, same motivation, backend spelling.
- Tag `2. Request-response flow` — the seam sits directly in the path of every tool call from agent → MCP server; understanding it is prerequisite to following the request flow end-to-end.
- Tag `5. Failure handling` — because the transport is injectable, error scenarios (transport throws, rate-limit payload returned) are injected via fakes in `client.test.ts` L89–L198; the seam is what makes failure-path testing deterministic.
- This is primarily a `4. State ownership` / architecture boundary: the service layer owns its interface; the provider layer owns the SDK coupling.

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

---
Updated: 2026-05-28 — refreshed code references to current line numbers; added a note on the capturing-fetch error seam (`HttpErrorHolder`/`makeCapturingFetch`) and `McpToolError`
