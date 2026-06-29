# 02 — MCP as a callable port

*Industry terms:* the port (`McpCaller`) and the adapter
(`SdkTransport`) — Industry standard (hexagonal architecture)

## Zoom out, then zoom in

You've called `fetch(url)` in a component and later swapped it out for
a `mockFetch` in tests by passing it as a prop. Same idea, two layers
down: the agent loop calls `dataSource.callTool(name, args)`, and the
test passes in a one-method object that returns whatever the test
needs.

```
  Zoom out — where this seam lives

  ┌─ Agents (lib/agents) ──────────────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · ...                    │
  │             │                                                │
  │             │ depends on McpCaller — a 1-method type        │
  │             ▼                                                │
  │  ★ THE PORT ★  type McpCaller = Pick<DataSource, 'callTool'>│ ← we are here
  └─────────────┬────────────────────────────────────────────────┘
                │
  ┌─ Adapters ──▼────────────────────────────────────────────┐
  │  BloomreachDataSource (real)   SyntheticDataSource (demo) │
  │            │                                               │
  │            ▼                                               │
  │  McpClient (cache + rate-limit + retry)                   │
  │            │                                               │
  │            ▼                                               │
  │  SdkTransport (the @modelcontextprotocol/sdk wrapper)     │
  │            │                                               │
  │            ▼                                               │
  │  Bloomreach loomi MCP server (the wire)                   │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** `lib/agents/base.ts:14` is a 14-line file. The entire
file:

```typescript
import type { DataSource } from '../data-source/types';
export const AGENT_MODEL = 'claude-sonnet-4-6';
export type McpCaller = Pick<DataSource, 'callTool'>;
```

That `Pick<DataSource, 'callTool'>` is the seam. The agent loop only
needs `callTool`. The full `DataSource` knows how to `listTools()`
too, but the agent doesn't care about that — so the *type* it asks
for is narrower. Production wires the real Bloomreach adapter
underneath; tests wire a four-line fake. The narrowing pays for
itself the moment you try to build the test fake — you don't have to
write a `listTools()` stub you'll never call.

## Structure pass

**Layers — five depths the call passes through:**
- outer: agent loop (consumer — depends on the port)
- middle 1: `DataSource` adapter (the swap point — Bloomreach vs Synthetic)
- middle 2: `McpClient` (cache + 1 req/s rate limit + retry)
- middle 3: `SdkTransport` (timeout + error enrichment + redaction)
- inner: `@modelcontextprotocol/sdk` `Client` (the wire)

**One axis held constant — *what could fail at this layer*:**
- outer: typo in tool name → caught by `mcp-call-allowlist` 403
- middle 1: bootstrap chain wrong → `bootstrapSchema` throws
- middle 2: rate limit hit → retry with parsed backoff window
- middle 3: server timeout → `HTTP 0: timeout after 30000ms`
- inner: network → SDK throws, transport enriches with captured body

**The seam — where the axis flips for tests:** at `McpCaller`. Above
that seam, agent code that doesn't care which layer failed (it just
gets a result or an `isError: true` envelope). Below it, the whole
adapter stack is irrelevant — the test substitutes the entire chain
with a one-method object.

## How it works

### Move 1 — the mental model

A **port** is the *type* the consumer depends on. An **adapter** is an
implementation of that port. The agent's port is `McpCaller`; the
adapters are `BloomreachDataSource` (production), `SyntheticDataSource`
(demo / dev), and the per-test fakes. The agent loop sees them all as
the same thing because the type signature is the same.

```
  The port + adapter shape

  ┌─ port (McpCaller) ─────────────┐
  │                                 │
  │   callTool(name, args)          │
  │     ─► { result, durationMs,    │  ← the contract every adapter signs
  │          fromCache }            │
  │                                 │
  └────────────────┬────────────────┘
                   │
       ┌───────────┼───────────────────────────┐
       │           │                           │
       ▼           ▼                           ▼
  ┌──────────┐ ┌──────────────┐  ┌─────────────────────────┐
  │ test     │ │ Synthetic    │  │ BloomreachDataSource    │
  │ fake     │ │ DataSource   │  │  (real) → McpClient     │
  │          │ │  (canned)    │  │   → SdkTransport        │
  │          │ │              │  │    → loomi MCP server   │
  └──────────┘ └──────────────┘  └─────────────────────────┘
```

The kernel skeleton is two parts: (1) the typed contract everyone
agrees to, and (2) the dependency-injection move at the call site.
Strip either and the substitution breaks — strip the type and the
test fake's signature drifts; strip the DI and you're back to
module-level `import` and `vi.mock`-based hacking.

### Move 2 — the step-by-step walkthrough

**The port: one type.** `lib/agents/base.ts:9-14`:

```typescript
// the agent-facing subset of DataSource used by AptKit tool-registry
// adapters. Full data sources can list tools, but reusable agents only
// need the callTool execution seam.
export type McpCaller = Pick<DataSource, 'callTool'>;
```

`Pick<DataSource, 'callTool'>` is TypeScript's standard "narrow a type
to just these fields." It produces a type with exactly one method.
Anything that satisfies the full `DataSource` automatically satisfies
`McpCaller`; anything that just implements `callTool` does too.

**The contract: result envelope, never a throw on tool errors.**

```
  callTool contract — three return shapes, never undefined

  success path:    { result: <tool output>, durationMs: 142, fromCache: false }
  cache hit:       { result: <cached>,      durationMs: 0,   fromCache: true }
  tool error:      { result: { isError: true, content: [{type:'text', text: '...'}] },
                     durationMs: ..., fromCache: false }    ← still resolves, not throws
  transport throw: rejects with McpToolError(name, detail)  ← only for transport-level
                                                              failures (HTTP, auth, ...)
```

The distinction matters: an MCP tool *failing* (e.g. an EQL query with
a syntax error) returns `isError: true` in the envelope and the agent
loop turns it into a `tool_result` block with `is_error: true` and
asks the model to recover. The transport itself failing
(`Unauthorized`, network down, timeout) throws. The two paths have
different recovery semantics; the port preserves both.

**The test fake: four lines.**

```typescript
// test/agents/base.test.ts:76-83  — buildFakeMcp

function buildFakeMcp(
  impl: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): McpCaller {
  return {
    async callTool(name, args) {
      const result = await impl(name, args);
      return { result, durationMs: 1, fromCache: false };  // ← envelope shape
    },
  };
}
```

Each test passes a per-test `impl` closure. To simulate a successful
EQL query, return an object. To simulate a *tool* error, return
`{ isError: true, content: [...] }`. To simulate a transport throw —
throw from inside the closure (`test/agents/base.test.ts:196-198`).

**Use it.** The same `runAgentLoop` test from file 01 wires this fake
alongside the scripted Anthropic:

```typescript
// test/agents/base.test.ts:119-135  (the happy-path test)

const mcp = buildFakeMcp(async () => ({
  isError: false,
  content: [],
  structuredContent: { data: { total_customers: 5 } },   // ← what the real
}));                                                      //   Bloomreach
                                                          //   tool returned
                                                          //   in a captured run

const result = await runAgentLoop({
  anthropic: anthropic as unknown as Anthropic,
  dataSource: mcp,                                        // ← inject the fake
  agent: 'monitoring',
  system: '...',
  userPrompt: 'Check the project.',
  toolSchemas: fakeToolSchemas,
  onToolCall,
});
```

The agent loop walks every line of its real production code:
detects the `tool_use` block, calls `dataSource.callTool('get_project_overview', {...})`,
gets back the envelope, builds a `tool_result` content block, sends it
back to the (faked) Anthropic, loops. Nothing about the test wiring
changes the loop's behavior — only the values flowing through it.

**Layers-and-hops — full stack vs test substitute:**

```
  Production vs test — labelled hops, same loop

  PRODUCTION                                  TEST
  ──────────                                  ────
  ┌─ agent loop ─┐  hop 1                    ┌─ agent loop ─┐  hop 1
  │              │ ──► callTool(name, args)  │              │ ──► callTool(name, args)
  └──────────────┘                            └──────────────┘
        │                                           │
        ▼ hop 2                                     ▼ hop 2
  ┌─ Bloomreach   ─┐                          ┌─ buildFakeMcp ─┐
  │   DataSource    │                          │  closure runs  │
  └────────┬────────┘                          └────────┬───────┘
           ▼ hop 3                                      │
  ┌─ McpClient ─────┐                                   │ hop 3
  │  cache check    │                                   ▼
  │  rate-limit gate│                          { result, durationMs, fromCache }
  │  retry policy   │
  └────────┬────────┘                          (return — done)
           ▼ hop 4
  ┌─ SdkTransport ──┐
  │  timeout wrap   │
  │  body capture   │
  │  error enrich   │
  └────────┬────────┘
           ▼ hop 5
  ┌─ @mcp/sdk Client┐
  └────────┬────────┘
           ▼ hop 6  (network)
  ┌─ loomi MCP svr  ┐
  └────────┬────────┘
           │
       (8 more hops back up)
```

Six hops of substrate stay in production; the test collapses them to
two. Every test in `test/agents/` benefits — that's why the suite runs
in 6.2 seconds.

**The McpClient layer is itself tested through the next seam down**
(`McpTransport`). `test/mcp/client.test.ts:5-12` defines a 7-line
`fakeTransport` and uses it to pin: cache hits, cache misses,
per-name+args keying, `skipCache` override, TTL expiry under fake
timers, the 200ms `minIntervalMs` floor, error results not caching,
rate-limit retry with parsed retry-after windows, max-retries
backstop, error-wrapping with `McpToolError`. Same pattern, one
layer deeper.

### Move 3 — the principle

**Narrow the type at the consumer, not at the provider.** The full
`DataSource` is rich (`callTool`, `listTools`, future methods).
Agents don't need the rich version — and asking for less makes the
substitution cheaper. Every line of test stub you don't have to write
is a future drift you can't introduce. The port's job is to be the
*smallest* shape the consumer can survive on.

## Primary diagram

```
  The full pattern — one port, three adapters, one test path

  ┌─ Consumer ─────────────────────────────────────────────────────────┐
  │  runAgentLoop({ dataSource: McpCaller, ... })                       │
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │  depends on the type, not the impl
                                 ▼
  ┌─ Port ─────────────────────────────────────────────────────────────┐
  │  type McpCaller = Pick<DataSource, 'callTool'>                      │
  │                                                                     │
  │  callTool(name: string, args: Record<string,unknown>):              │
  │    Promise<{ result: unknown, durationMs: number, fromCache: bool }>│
  └────────────────────────────────────────────────────────────────────┘
                                 │
            ┌────────────────────┼─────────────────────┐
            │                    │                     │
            ▼                    ▼                     ▼
  ┌─ Production ─────┐  ┌─ Demo/Dev ─────┐  ┌─ Test (per-test) ──────┐
  │ BloomreachData-  │  │ SyntheticData- │  │ buildFakeMcp(closure)  │
  │ Source           │  │ Source         │  │                        │
  │   │              │  │   (canned      │  │ returns:               │
  │   ▼              │  │    fixtures)   │  │  { result: impl(...),  │
  │ McpClient        │  │                │  │    durationMs: 1,      │
  │   │              │  └────────────────┘  │    fromCache: false }  │
  │   ▼              │                       └────────────────────────┘
  │ SdkTransport     │
  │   │              │
  │   ▼              │
  │ @mcp/sdk Client  │
  │   │              │
  │   ▼              │
  │ loomi MCP server │
  └──────────────────┘
```

## Elaborate

The pattern is hexagonal architecture (Cockburn, 2005) — the consumer
depends on a port (an interface), and adapters plug in to satisfy
that port. The vocabulary varies by tradition: "ports and adapters,"
"clean architecture's interface adapters," "dependency inversion,"
"the strategy pattern when you only have one method." They all
describe the same shape: the consumer owns the type, the providers
satisfy it.

What earned this seam in this repo specifically: the project's
DataSource layer (`lib/data-source/`) was extracted from
`McpClient` to support a `live-synthetic` mode where the four agents
run against canned fixtures instead of the Bloomreach server (used
by the demo path and by future eval rigs). The narrowing of
`Pick<DataSource, 'callTool'>` happened because agents shouldn't be
able to call `listTools()` — that's a bootstrap responsibility owned
by the route, not the agent. The type *enforces* that — try
`dataSource.listTools()` inside `runAgentLoop` and TypeScript yells.

What this *doesn't* defend against: an adapter that lies about its
envelope shape. `SyntheticDataSource` could return `{ result: 42 }`
instead of `{ result: 42, durationMs: ..., fromCache: ... }` and
TypeScript would catch it at the adapter boundary, but a runtime
mutation wouldn't. The `synthetic-data-source.test.ts:36-52` test pins
the envelope shape directly to prevent that drift.

## Interview defense

**Q: Why narrow `DataSource` to `McpCaller` instead of just passing
the whole `DataSource`?**

Two reasons. First, the agent loop genuinely doesn't need `listTools`
— that's a bootstrap concern owned by the route. Asking for it would
be lying about the dependency, and the narrower type makes the lie a
compile error. Second, the test fake is smaller: I don't have to
write a fake `listTools` I'll never assert on. Smaller fakes mean
less drift when the production type grows.

```
  Narrow port → small fake

  port = full DataSource              port = Pick<DataSource, 'callTool'>
  ─────────────────────              ──────────────────────────────────
  fake needs callTool + listTools     fake needs callTool only
  + future methods                    → 4 lines
  → 12+ lines, drifts when SDK grows  → never drifts (1 method type)
```

**Q: Load-bearing part of this kernel — what breaks if it's missing?**

The envelope. If `callTool` returned the raw tool output instead of
`{ result, durationMs, fromCache }`, the agent loop would still work
in tests (since the test doesn't care about timing) but the
`StatusLog` UI would stop showing per-tool duration and cache-hit
badges — and the rate-limit policy in `McpClient` would have nowhere
to record the latency it observed. The envelope is the contract that
threads observability through the whole stack. Drop it and you lose
the "show your work" half of the product.

**Q: What ISN'T this catching?**

Whether the real Bloomreach server returns the shape the test stub
fakes. `parseWorkspaceSchema` defends against that — see
`04-real-fixture-snapshot-test.md` — by running real captured
responses through the parser. But if Bloomreach renames a field in
their `execute_analytics_eql` output tomorrow, every test here still
passes and live mode breaks. The synthetic-data-source tests at
least pin the envelope shape (`structuredContent.anomalies[0].category`,
`content[0].text`); the upstream-drift surface is still open.

## See also

  → `01-injected-fake-anthropic-client.md` — the matching pattern at
    the Anthropic boundary
  → `03-type-guard-as-runtime-validator.md` — the line of defense
    *after* the port, where untrusted output meets typed code
  → `04-real-fixture-snapshot-test.md` — the upstream-drift defense
    that DOES exercise real Bloomreach response shapes
