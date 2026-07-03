# 03 — Provider abstraction · the DataSource seam

**Industry name:** port and adapter (hexagonal architecture) with a factory selection. *Type: Industry standard.*

## Zoom out, then zoom in

Every agent in this app calls `dataSource.callTool(name, args)`.
Not once do they know whether the tool is real (MCP over HTTPS)
or synthetic (in-process fake data) or wrapped in a fault
injector. The port is called `DataSource`; the adapters are
`McpDataSource` (Bloomreach preset), `SyntheticDataSource`, and
the `FaultInjectingDataSource` decorator.

This is the load-bearing seam of the whole repo. It has now
shipped in **five uses** without a single caller-facing surface
change. That receipt is what makes this pattern the senior-signal
story of the codebase.

```
  Zoom out — where the DataSource seam sits

  ┌─ Service layer ─────────────────────────────────────────┐
  │  route handlers → makeDataSource(mode, sid, override)   │
  │  agents  → dataSource.callTool(name, args, { signal })  │
  └────────────────────────┬────────────────────────────────┘
                           │  ★ port: DataSource ★
  ┌─ Adapter layer ────────▼────────────────────────────────┐
  │  McpDataSource (BloomreachDataSource under the hood)    │
  │  SyntheticDataSource                                    │
  │  FaultInjectingDataSource (decorator wraps any adapter) │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Provider layer ───────▼────────────────────────────────┐
  │  MCP server  |  in-process fake data  |  forced fault   │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is textbook Hexagonal Architecture:
callers depend on the port (an interface); adapters implement
the port; a factory picks one. What makes this repo's story
worth studying isn't the pattern — everyone knows the pattern —
it's the receipt.

## Structure pass

Two layers (caller / adapter), one axis: **who owns the
protocol details?**

```
  Axis "who owns protocol details?" — trace it across the seam

  ┌─ Callers ────────────────────────────────────────────┐
  │ agents:        care about a tool result envelope     │
  │ route:         cares about the auth-gate case        │
  │ bootstrap:     cares about the schema shape          │
  │                                                       │
  │  none of them know: MCP, HTTP, rate limits, OAuth    │
  └────────────────────────┬─────────────────────────────┘
                           │  seam: DataSource
  ┌─ Adapters ──────────────▼────────────────────────────┐
  │ McpDataSource:  MCP transport, 1 req/s spacing,      │
  │                 429 retry ladder, 60s cache          │
  │ Synthetic:      in-process dispatch, no I/O          │
  │ FaultInjecting: xorshift PRNG, injected errors       │
  │                                                       │
  │  ★ each fully owns "how the tool result is fetched" ★│
  └──────────────────────────────────────────────────────┘
```

The seam is `DataSource` at `lib/data-source/types.ts:63-71`.
Two methods: `callTool` and `listTools`. Above the seam, no code
knows anything about HTTP, OAuth, rate limits, or MCP. Below the
seam, each adapter fully owns its transport. That's why the
axis "who owns protocol details?" flips cleanly at this
boundary.

## How it works

### Move 1 — the mental model

You've written a component that takes a `data` prop, and the
parent decides whether to pass real data or a Storybook mock.
Same idea, at the service layer. There's one interface, and
whichever thing the factory hands the agents implements it.

```
  Pattern — port / adapter / factory

  ┌────────────────────────┐
  │  DataSource (port)     │  callTool, listTools
  └──────────┬─────────────┘
             │ implements
     ┌───────┼───────┬────────────────┐
     ▼       ▼       ▼                ▼
   McpDS   SyntheticDS   FaultInjectingDS(inner)
   (real   (fake in-      (decorator — wraps any
    MCP)    process)       adapter, forces faults)
             ▲                  ▲
             │                  │
     ┌───────┴──────────────────┴───────┐
     │   makeDataSource(mode, sid,      │
     │                  override)       │  (factory)
     └───────────────────────────────────┘
```

### Move 2 — step by step

**Part 1: the port.** Two methods, both returning promises,
neither containing anything protocol-specific.

```ts
// lib/data-source/types.ts:63-71
export interface DataSource {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,   // just { signal? }
  ): Promise<DataSourceCallResult>; // { result, durationMs, fromCache }

  listTools(opts?: DataSourceListOptions): Promise<unknown>;
}
```

The `{ result, durationMs, fromCache }` envelope is the
receipt shape every adapter has to produce. `result` stays
`unknown` — call sites cast via `unwrap<T>()` in
`lib/mcp/schema.ts:36`. Adapters that don't track duration or
cache hits return `durationMs: 0, fromCache: false`
(SyntheticDataSource does exactly that).

**Part 2: adapter 1 — the MCP client (Bloomreach preset).**
Real MCP over HTTPS with all the ceremony: proactive spacing,
retry-with-window-parse, TTL cache.

```ts
// lib/data-source/bloomreach-data-source.ts:121-138 (constructor + defaults)
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private minIntervalMs: number;   // proactive spacing
  private retryDelayMs: number;    // parsed from 429 body
  private retryCeilingMs: number;
  private maxRetries: number;

  constructor(transport: Transport, opts: {
    minIntervalMs?: number;
    retryDelayMs?: number;
    retryCeilingMs?: number;
    maxRetries?: number;
  } = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 200;
    this.retryDelayMs = opts.retryDelayMs ?? 10_000;
    // ...
  }
}
```

`McpDataSource` is a thin re-export
(`lib/data-source/mcp-data-source.ts:18-21`) —
`BloomreachDataSource` is generic enough (the retry hint parser
reads standard `retry-after`-style server responses) that the
rename is a marker of intent, not a new class:

```ts
export {
  BloomreachDataSource as McpDataSource,
  McpToolError,
} from './bloomreach-data-source';
```

**Part 3: adapter 2 — the synthetic in-process source.** Same
interface, no I/O.

```ts
// lib/data-source/synthetic-data-source.ts:314-331
export class SyntheticDataSource implements DataSource {
  async listTools(): Promise<{ tools: ToolDef[] }> {
    return { tools: toolDefs };
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<DataSourceCallResult> {
    const started = Date.now();
    const payload = this.dispatch(name, args);
    return { result: payload, durationMs: Date.now() - started, fromCache: false };
  }
  // ...
}
```

The `dispatch` switch handles ~40 tool names, each returning a
Bloomreach-shaped envelope — `{ structuredContent, content: [{
type: 'text', text: JSON.stringify(payload) }] }`. The agent
loop, `unwrap`, `bootstrapSchema`, none of it can tell the
difference from real MCP output.

**Part 4: adapter 3 — the fault-injecting decorator.** The
decorator pattern in miniature: wraps any DataSource, forces
failures at configurable rates, preserves the interface.

```ts
// lib/data-source/fault-injecting.ts:65-110  (annotated skeleton)
export class FaultInjectingDataSource implements DataSource {
  constructor(
    private readonly inner: DataSource,      // ← wraps any adapter
    private readonly options: FaultInjectorOptions,
  ) {}

  async callTool(name, args, opts): Promise<DataSourceCallResult> {
    this.callIndex += 1;
    const roll = this.random();
    const r = this.options.rates;

    let acc = 0;
    if (r.timeout    && roll < (acc += r.timeout))    return this.fireTimeout(name);
    if (r.rateLimit  && roll < (acc += r.rateLimit))  return this.fireRateLimit(name);
    if (r.serverError && roll < (acc += r.serverError)) return this.fireServerError(name);
    if (r.malformedJson && roll < (acc += r.malformedJson)) return this.fireMalformedJson(name);

    return this.inner.callTool(name, args, opts);  // ← pass through
  }

  listTools(opts) { return this.inner.listTools(opts); }  // ← bootstrap stays clean
}
```

Two design details worth naming. First, the decorator wraps any
adapter — the tier-2 receipt runs faults against `SyntheticDataSource`
in the load harness, not the live MCP. Second, `listTools` is
never faulted — bootstrap should never randomly fail; if it did,
the agent's cold start would flake and mask real behavior.

**Part 5: the factory.** One function, three branches. Its job
is small on purpose — routes never construct adapters directly.

```
  Layers-and-hops — makeDataSource decisions

  route  ────────►  makeDataSource(mode, sid, override)
                          │
                    ┌─────┴──────────────────────┐
                    │ mode === 'live-synthetic'  │  → new SyntheticDataSource()
                    │ mode === 'live-mcp'        │  → connectMcp(sid, override)
                    └────────────┬───────────────┘
                                 │
                        ┌────────┴──────────┐
                        │ conn.ok === false │ → 401 { authUrl } upward
                        │ conn.ok === true  │ → return McpDataSource
                        └───────────────────┘
```

```ts
// lib/data-source/index.ts:84-120  (skeleton)
export async function makeDataSource(
  mode: LiveMode,
  sessionId: string,
  mcpConfigOverride?: McpConfigOverride | null,
): Promise<MakeDataSourceResult> {
  if (mode === 'live-synthetic') {
    const dataSource = new SyntheticDataSource();
    return { ok: true, mode, dataSource,
             bootstrap: async () => syntheticWorkspaceSchema,
             dispose: async () => {} };
  }

  const conn: ConnectResult = await connectMcp(sessionId, mcpConfigOverride);
  if (!conn.ok) return { ok: false, mode, authUrl: conn.authUrl };
  const mcpDs = conn.mcp;
  return { ok: true, mode, dataSource: mcpDs,
           bootstrap: (signal) => bootstrapSchema(mcpDs, { signal }),
           dispose: async () => {} };
}
```

### Move 2 variant — the load-bearing skeleton

Strip the pattern to the minimum that still IS the pattern:

1. **A port** (interface) with methods callers depend on.
2. **≥1 adapter** implementing it — the seam only proves out
   when at least one adapter demonstrates the abstraction wasn't
   just for one implementation.
3. **A factory** callers reach through.

That's the kernel. What breaks if any part is missing:

- Drop the port → callers depend on the concrete adapter,
  every swap becomes a caller change. The seam disappears.
- Drop the factory → each caller site duplicates adapter
  selection. Consistency erodes; one branch will construct the
  wrong one under a subtle condition.
- Ship only one adapter → the abstraction is speculative. It
  might be well-shaped or terrible; you can't tell until a
  second implementation stresses the interface.

Optional hardening — none of these are the pattern:
- Decorator adapters (like FaultInjecting) for cross-cutting
  behavior.
- Bootstrap function on the factory result (this repo does
  this because the schema-fetch shape differs per adapter).
- Dispose hooks for lifecycle.

**The receipt — five uses without a caller-surface change.**
This is the interview-defense move for this pattern.

```
  Five stress-tests on the same seam, one caller-surface — no changes

  #1  Olist SQL adapter added         (Phase 2 exploration)
  #2  Olist SQL adapter removed       (PR #8)
  #3  SyntheticDataSource added       (offline demo path)
  #4  FaultInjectingDataSource        (Week 4B chaos harness)
  #5  McpDataSource + AuthProvider    (Session B swappable-MCP)
      generalization                   Bloomreach → one preset

  callers changed across all five:  agents=0  routes=0  bootstrap=0
```

That's how you know the abstraction is right-shaped. Each of
those five was a real pressure — not a hypothetical. The
callers not noticing is the load-bearing evidence.

### Move 3 — the principle

An abstraction is worth its cost when it survives real pressure
without the callers noticing. Ship it once, and you don't know
if the shape is right. Ship it a second time, and you learn.
Ship it five times without a caller-surface change and you've
earned the pattern — the shape held up under actually different
implementations, not just "we might swap this someday." Most
Hexagonal-Architecture papers stop at "here's the port and one
adapter." The receipt is the interesting part.

## Primary diagram

```
  DataSource seam — full recap

  ┌─ Caller side — no protocol knowledge ─────────────────┐
  │  agents           bootstrapSchema        route handlers│
  │  runAgentLoop     resolveProject         send(NDJSON)  │
  │           ┌─────────────┴─────────┐                   │
  │           │  DataSource (port)    │                   │
  │           │   callTool, listTools │                   │
  │           └────────┬──────────────┘                   │
  └────────────────────┼──────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┬───────────────────┐
        │              │              │                   │
        ▼              ▼              ▼                   ▼
  McpDataSource  SyntheticDataSource  FaultInjecting(any) [any future]
  (Bloomreach     in-process fake     decorator: wraps    example: a self-
   preset by      data (39 tools)     Synthetic or MCP;   hosted MCP with
   default —      no I/O              forces timeout/     bearer auth is
   generic)                           429/500/malformed   already covered
        ▲              ▲              ▲                   by strategy #2
        │              │              │
        └──────┬───────┴──────┬───────┘
               │              │
               ▼              ▼
             makeDataSource (factory)
               │
               ▼
             route decides mode + reads override →
             factory constructs the adapter → returns
             { ok, mode, dataSource, bootstrap, dispose }
```

## Elaborate

The port/adapter idea is Alistair Cockburn's Hexagonal
Architecture from 2005. It shows up under many names — Ports and
Adapters, Onion Architecture, Clean Architecture. The value
proposition is identical everywhere: the domain code doesn't
depend on infrastructure; infrastructure depends on domain-
shaped interfaces.

The decorator adapter (`FaultInjectingDataSource`) is the
Gang-of-Four decorator pattern in miniature. Because it
implements the same interface it wraps, it can be composed:
`FaultInjecting(FaultInjecting(Synthetic))` type-checks and
works, though this repo doesn't stack them. Redis client
libraries do this a lot: sentinel-aware decorator wrapping a
retry decorator wrapping a base client.

Where this repo could go next: an MCP adapter for a self-
hosted MCP server (already covered by the current `McpDataSource`
+ bearer or anonymous auth strategies — that's why the
swappable-MCP work counts as a *sixth-use-ready* seam even if
it hasn't shipped a distinct adapter).

## Interview defense

**Q: Why does the receipt matter more than the pattern?**

A: Everyone knows Hexagonal. The interesting question is
whether an abstraction earns its complexity. Five different
implementations pressured the same interface — Olist SQL,
Synthetic in-process, FaultInjecting decorator, and the
generalization to McpDataSource + swappable AuthProvider. Zero
caller-side changes. That's what makes it worth building; the
pattern name alone doesn't.

**Q: What's the one thing about this seam people forget?**

A: The `{ result, durationMs, fromCache }` envelope. The seam
isn't "callTool returns whatever" — the *shape* of the response
is part of the contract. `fromCache: false` isn't optional;
`durationMs: 0` isn't optional. Adapters that don't track those
have to lie honestly. That's what lets the UI's "how this was
gathered" panel work identically across adapters.

**Q: What would force you to change the port?**

A: Streaming tool results. The port assumes a promise-of-a-
result shape; if an MCP server ever returned a streaming tool
result mid-tool-call (not the current SDK's shape), you'd need
to either add a second method or return an `AsyncIterable`. So
far the SDK hasn't gone there, so the port hasn't had to.

**Q: When would you NOT reach for this pattern?**

A: When you have one implementation and no realistic pressure
for a second. Building a port speculatively — "just in case we
swap the database someday" — is where hexagonal architecture
gets a bad reputation. You need a real reason. This repo had
one (offline-first demos, load harness chaos, and the swappable-
MCP work) — that's what earned it.

## See also

- `02-auth-boundary-and-swappable-mcp.md` — same strategy
  pattern at a different altitude (the AuthProvider trio)
- `04-aptkit-agent-primitive-boundary.md` — another abstraction
  boundary this repo owns, where the pressure came from
  extracting reusable agent primitives
- `01-request-flow.md` — where `makeDataSource` sits in the
  request path
