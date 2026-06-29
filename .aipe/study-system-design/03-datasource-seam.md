# datasource-seam

## Port and adapter (industry standard)

The load-bearing seam of the whole repo. A port (the `DataSource` interface in `lib/data-source/types.ts`) plus two adapters (`BloomreachDataSource`, `SyntheticDataSource`) chosen by a factory (`makeDataSource`). Every agent, every route, every helper consumes the port — never an adapter. Two adapter swaps in this seam's history without changing a single caller.

## Zoom out — where this pattern lives

This is the boundary between the deterministic shell of the app (routes, agents, state) and the noisy outside world (an alpha OAuth-protected upstream that rate-limits and revokes tokens). Pull the shell off the upstream and you can swap the upstream for fixtures, for a SQL database, for anything — without rewriting the shell.

```
  Zoom out — the seam as a wall

  ┌─ Service layer (deterministic, in-process) ────────────────────────┐
  │  routes (briefing, agent, mcp/*)                                    │
  │  agents (monitoring, diagnostic, recommendation, query, intent)     │
  │  helpers (bootstrapSchema, anomalyToInsight, putInsights, …)        │
  │                       │                                             │
  │                       │  every consumer holds a `DataSource`        │
  │                       ▼                                             │
  │  ★ THE SEAM ★  `interface DataSource` (`lib/data-source/types.ts`)  │ ← we are here
  │  callTool(name, args, opts) → { result, durationMs, fromCache }     │
  │  listTools(opts)                                                    │
  └────────────────────────┬────────────────────────────────────────────┘
                           │  one of two adapters today
            ┌──────────────┴──────────────┐
            ▼                              ▼
  ┌─ Adapter (Bloomreach) ─┐    ┌─ Adapter (Synthetic) ────┐
  │ HTTPS + OAuth/PKCE/DCR │    │ in-process fixtures      │
  │ rate-limit + cache     │    │ deterministic, no network│
  │ (214 LOC)              │    │ (516 LOC)                │
  └───────────┬────────────┘    └──────────────────────────┘
              │
              ▼
        external server
```

## Structure pass

Three layers exist around this seam: the **client** layer (routes + agents that consume `DataSource`), the **port** layer (the interface itself), the **adapter** layer (concrete implementations). One axis worth tracing across the three: **who depends on whom?**

```
  Axis: dependency direction

  ┌─ client (routes + agents) ──┐    depends on the PORT, not the adapter
  │  hold `DataSource`          │   ═════╪═════►
  └─────────────────────────────┘
       ┌─ port (interface) ────────┐
       │  `interface DataSource`   │
       └───────────────────────────┘
            ▲                  ▲
            │                  │  adapters DEPEND on the port
            │                  │  (they implement it)
  ┌─ adapter (Bloomreach) ─┐  ┌─ adapter (Synthetic) ─┐
  │  implements DataSource │  │  implements DataSource │
  └────────────────────────┘  └────────────────────────┘
```

The dependency direction is the whole point. Without the port, agents would depend on `BloomreachDataSource`; swapping the adapter would mean touching every agent. With the port, the arrows are *inverted* — both the agents and the adapters depend on the same abstraction in the middle, and the agents don't know which adapter they got. This is dependency inversion in textbook form.

Where the axis flips: at the port. Above it, callers *consume* `DataSource`. Below it, adapters *implement* `DataSource`. The interface is the contract that lets both sides change without coordination.

## How it works

### Move 1 — the mental model

You've used a wall socket. Two prongs, a defined voltage, a defined frequency. A lamp doesn't know what powers the grid (coal, solar, nuclear); the grid doesn't know what's plugged in. The socket is the contract; both sides can change independently as long as they keep the contract.

A port is the software wall socket. `DataSource` defines two methods (`callTool`, `listTools`) with a defined argument shape and a defined return envelope (`{ result, durationMs, fromCache }`). Agents are the lamp — they call `callTool` and don't know which adapter is on the other side. Adapters are the grid — they implement `callTool` and don't know which agent is calling them. The factory `makeDataSource(mode, sessionId)` is the choice of which grid to plug into.

```
  The pattern: port + adapters + factory

  ┌──── client (agent) ────┐
  │  needs a DataSource    │
  └───────────┬────────────┘
              │  injected by the route
              ▼
       ┌─ port ─────┐
       │ DataSource │  ◄── interface (the contract)
       └──┬──────┬──┘
          │      │
          │ implemented by         implemented by
          ▼                                       ▼
  ┌─ adapter A ──────────┐         ┌─ adapter B ────────┐
  │ BloomreachDataSource │         │ SyntheticDataSource│
  │ (real, networked)    │         │ (fake, in-process) │
  └──────────┬───────────┘         └────────────────────┘
             │
             ▼
    external Bloomreach server

  factory picks one based on mode:
     'live-bloomreach' → A
     'live-synthetic'  → B
```

### Move 2 — the step-by-step walkthrough

#### the port — the interface

The interface is small on purpose. Two methods, three types:

```ts
// lib/data-source/types.ts:53-71
export interface DataSourceCallResult {
  result: unknown;       // adapters cast at the call site (e.g. unwrap<T>(result))
  durationMs: number;    // observability — surfaced in the UI "how it was gathered" panel
  fromCache: boolean;    // observability — surfaced in trace events
}

export interface DataSource {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult>;

  listTools(opts?: DataSourceListOptions): Promise<unknown>;
}
```

Two design choices worth flagging:

- **`result: unknown` instead of generic `T`.** The interface drops the generic that the concrete adapter carries — the abstract surface is type-erased so callers can't accidentally couple to a specific adapter's return shape. Call sites narrow with `unwrap<T>(result)` in `lib/mcp/schema.ts`, which is part of the port's vocabulary (it lives next to the interface and handles both `structuredContent` and `content[0].text` envelopes).
- **The envelope shape `{ result, durationMs, fromCache }` matches the legacy `McpClient` exactly.** That's the receipt: the rename + lift to a seam (PR A of Phase 2) was a *behavior-preserving* refactor — no caller had to change. Adapters that don't track duration or cache hits return `fromCache: false` and a real-or-zero `durationMs`.

```
  Pattern — the port's surface

  ┌──── DataSource (port) ────┐
  │                            │
  │  callTool(name, args, ?)   │  ──►  { result, durationMs, fromCache }
  │  listTools(?)              │  ──►  unknown   (caller narrows)
  │                            │
  └────────────────────────────┘
       narrow surface →
       broad implementation space
```

#### the adapters — one real, one fake

**`BloomreachDataSource`** (214 LOC, `lib/data-source/bloomreach-data-source.ts`) wraps a connected `StreamableHTTPClientTransport` and adds the upstream's reliability machinery: 60s response cache, 1.1s proactive spacing, rate-limit retry ladder, `AbortSignal` composition. The class declaration is the receipt:

```ts
// lib/data-source/bloomreach-data-source.ts:121-127
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;
  private minIntervalMs: number;
  private maxRetries: number;
  …
}
```

The history matters. This class used to be called `McpClient`, lived at `lib/mcp/client.ts`, and was already shaped to be the Bloomreach adapter — the file's header comment explains the seam wasn't retrofitted: "the seam wasn't retrofitted, the class was already shaped to be the Bloomreach adapter. Lifting `DataSource` over it only changed the TYPE that callers consume." → see `10-rate-limit-aware-mcp-client.md` for the reliability internals.

**`SyntheticDataSource`** (516 LOC, `lib/data-source/synthetic-data-source.ts`) is the second adapter. It implements the same port over deterministic in-process fixtures — a fake Bloomreach workspace, complete with events, customer properties, EQL results. The agent loop runs against it identically; the route layer asks no questions.

```
  Pattern — both adapters, same shape

  ┌─ BloomreachDataSource ──────┐    ┌─ SyntheticDataSource ───┐
  │ implements DataSource       │    │ implements DataSource   │
  │                              │    │                          │
  │ callTool(...) {              │    │ callTool(...) {          │
  │   await rate-limit            │    │   await fixture-lookup    │
  │   await transport.callTool   │    │   return { result, 0, false}│
  │   return { result, ms, cache}│    │ }                        │
  │ }                            │    │                          │
  │ listTools(...) → transport   │    │ listTools(...) → fixtures│
  └──────────────────────────────┘    └──────────────────────────┘
```

The reason the synthetic adapter is *bigger* than the real one: it has to *generate* convincing data. The Bloomreach adapter just *transports* what the server returns. That asymmetry is normal for fakes — they own the data the real adapter borrows.

#### the factory — chooses an adapter for a request

`makeDataSource(mode, sessionId)` is the only place adapters are constructed. The routes never `new BloomreachDataSource(...)` — they call the factory and narrow the result to `DataSource`:

```ts
// lib/data-source/index.ts:67-100
export async function makeDataSource(
  mode: LiveMode,
  sessionId: string,
): Promise<MakeDataSourceResult> {
  if (mode === 'live-synthetic') {
    const dataSource = new SyntheticDataSource();
    return {
      ok: true, mode, dataSource,
      bootstrap: async () => syntheticWorkspaceSchema,
      dispose: async () => {},
    };
  }

  // live-bloomreach — defer to the existing connect path.
  const conn: ConnectResult = await connectMcp(sessionId);
  if (!conn.ok) {
    return { ok: false, mode, authUrl: conn.authUrl };
  }
  const bloomreachDs = conn.mcp;
  return {
    ok: true, mode, dataSource: bloomreachDs,
    bootstrap: (signal?: AbortSignal) => bootstrapSchema(bloomreachDs, { signal }),
    dispose: async () => {},
  };
}
```

Three things the factory does beyond construction:

- **Returns a discriminated union.** `{ ok: true, dataSource, bootstrap, dispose }` on success; `{ ok: false, authUrl }` on the Bloomreach auth-gate failure. Routes branch once, never twice.
- **Closes over the bootstrap step.** Each adapter's "load the workspace schema" call is different — Bloomreach runs the loomi connect orchestrator; Synthetic returns a fixture. The factory bakes that difference into a `bootstrap(signal)` closure so the route just calls `await result.bootstrap(req.signal)` without branching.
- **Provides a dispose closure.** Both adapters return a no-op dispose today (Bloomreach lives across requests via the cookie store; Synthetic has nothing to dispose). The shape exists for future adapters that own a process or a socket — the route's `finally` calls `disposeDataSource()` either way.

```
  Layers-and-hops — the factory's job

  ┌─ route ─────┐  hop 1: makeDataSource('live-bloomreach', sid)
  │  /api/      │ ──────────────────────────────────────────────►
  │  briefing   │                                                  ┌─ factory ──────────┐
  └─────────────┘                                                  │  switch on mode     │
                                                                   └────────┬───────────┘
                                                                            │
                                              ┌─────────────────────────────┴───────────────────┐
                                              │ 'live-synthetic'                'live-bloomreach'│
                                              ▼                                                  ▼
                                  ┌─ new SyntheticDataSource() ┐         ┌─ connectMcp(sid) ──────────┐
                                  │  bootstrap: async () =>     │         │  OAuth dance via provider   │
                                  │    syntheticWorkspaceSchema │         │   ok ? BloomreachDataSource │
                                  │  dispose: no-op             │         │      : { authUrl }          │
                                  └────────────┬────────────────┘         └────────────┬────────────────┘
                                               │                                       │
                                               ▼                                       ▼
                                  hop 2: { ok, dataSource, bootstrap, dispose }
                                  hop 3: route narrows dataSource to `DataSource`
```

#### consumers — agents that hold the port, not the adapter

The agents — `MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent` — accept the port:

```ts
// lib/agents/monitoring.ts:73-80
export class MonitoringAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,         // ← Pick<DataSource, 'callTool'>
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}
  …
}
```

`McpCaller` is even narrower than `DataSource` — it's `Pick<DataSource, 'callTool'>` (`lib/agents/base.ts:14`). The agents don't need `listTools` (the route already called it and handed the result in). Narrowing the dependency to the minimum surface the agent actually uses is the "Interface Segregation" half of SOLID — adapters whose `listTools` is expensive or unavailable could still serve the agent.

The library boundary (the three adapter classes in `lib/agents/aptkit-adapters.ts`) takes the same `McpCaller`:

```ts
// lib/agents/aptkit-adapters.ts:75-79
export class BloomingToolRegistryAdapter implements ToolRegistry {
  constructor(
    private readonly dataSource: McpCaller,
    private readonly allTools: McpToolDef[],
  ) {}
  …
}
```

So the chain reads: route → factory → port → wrapping adapter (`BloomingToolRegistryAdapter`) → library agent (`@aptkit/core`). The library agent calls `tools.callTool(...)`; the wrapping adapter forwards to `dataSource.callTool(...)`; the port resolves to whatever concrete adapter the factory chose.

#### the migration receipt — two swaps without a caller change

The seam has survived two real swaps. The history is recorded in the file headers.

```
  Comparison — the seam's history, side by side

  ┌─ Phase 1 (pre-seam) ─────────────┐  ┌─ Phase 2a ─────────────────────┐
  │ agents hold McpClient (concrete) │  │ DataSource port introduced     │
  │ no factory                       │  │ McpClient renamed →            │
  │ ╳ swap requires touching agents  │  │   BloomreachDataSource          │
  │                                  │  │ agents narrowed to McpCaller    │
  └──────────────────────────────────┘  │ ✓ behavior-preserving rename    │
                                        └────────────┬───────────────────┘
                                                     │
  ┌─ Phase 2b ──────────────────────────────────────▼─────────────────────┐
  │ Olist (SQL) adapter ADDED behind the seam                              │
  │ ✓ agents unchanged — they just got a third adapter to swap to          │
  │ factory grew 'live-sql' branch                                         │
  └──────────────────────────────────┬─────────────────────────────────────┘
                                     │
  ┌─ PR #8 (commit 62c24d7, 2026-06-18) ─▼─────────────────────────────────┐
  │ Olist adapter REMOVED (the eval/ harness retired the same week)         │
  │ ✓ agents unchanged                                                       │
  │ factory's 'live-sql' branch dropped                                      │
  └──────────────────────────────────┬─────────────────────────────────────┘
                                     │
  ┌─ Today ────────────────────────▼──────────────────────────────────────┐
  │ SyntheticDataSource ADDED                                              │
  │ ✓ agents unchanged                                                     │
  │ factory grew 'live-synthetic' branch (lib/data-source/index.ts:71-79)  │
  └────────────────────────────────────────────────────────────────────────┘
```

The receipt: in three changes spanning two adapter additions and one removal, *no agent's signature changed*. That's what a load-bearing seam looks like — the change ledger reads "adapter swap" not "shotgun surgery."

#### the deliberate breach — `connectMcp.ConnectResult.mcp`

There's one place that intentionally holds the concrete adapter, not the port. `ConnectResult.mcp` is typed `BloomreachDataSource`, not `DataSource`:

```ts
// lib/mcp/connect.ts:21-28
/** ConnectResult.mcp is the concrete BloomreachDataSource (not just
 *  `DataSource`) so the 4 short MCP routes — /api/mcp/{call,tools,tools/check,capture}
 *  — keep access to Bloomreach-specific cache controls (skipCache). Agent + route
 *  layers that only need the abstract surface narrow to `DataSource` at their
 *  receive site (bootstrapSchema, agent ctors, etc.). */
export type ConnectResult =
  | { ok: true; mcp: BloomreachDataSource }
  | { ok: false; authUrl: string };
```

Why: `skipCache` is a Bloomreach-specific control (a cache-bypass option for the dev `/api/mcp/call` path). Putting it on the abstract port would force every adapter to model "cache" even when there isn't one (`SyntheticDataSource` has no cache to skip). The breach is deliberate and *scoped* — the four short MCP routes hold the concrete type; everyone else narrows to `DataSource` at the receive site. That's "depend on the port wherever you can, hold the concrete adapter only where you must" in practice.

### Move 3 — the principle

A port earns its keep when it survives an adapter swap *without* the callers changing. This repo has the receipt: three changes (two adds, one remove) and no consumer touched the seam's surface. The transferable lesson: when designing an abstraction, the right test is not "is the interface beautiful" — it's "what would change in the callers if I replaced the implementation tomorrow." If the answer is "nothing," the seam is load-bearing. If the answer is "everything," there's no seam; there's just a class that happens to have an interface.

The dual lesson: a port is *narrow*. `DataSource` has two methods, not twelve. `McpCaller` has one. Every additional method on a port is one more thing every future adapter must implement; every adapter-specific feature on a port is one more leak. Keep the port at the *intersection* of what callers actually need — the rest stays on the concrete adapter where it belongs.

## Primary diagram

```
  datasource-seam — full picture

  ┌─ Clients (depend on the port) ─────────────────────────────────────────┐
  │                                                                         │
  │  app/api/briefing/route.ts        ──► holds DataSource                  │
  │  app/api/agent/route.ts           ──► holds DataSource                  │
  │  app/api/mcp/{call,tools,…}/      ──► hold BloomreachDataSource (escape │
  │                                       hatch for skipCache)              │
  │                                                                         │
  │  MonitoringAgent / DiagnosticAgent / RecommendationAgent / QueryAgent   │
  │     ──► hold McpCaller = Pick<DataSource, 'callTool'>                   │
  │                                                                         │
  │  bootstrapSchema(dataSource: DataSource, opts)                          │
  │  BloomingToolRegistryAdapter(dataSource: McpCaller, allTools)           │
  │                                                                         │
  └────────────────────────────┬────────────────────────────────────────────┘
                               │
  ┌─ Port (the contract) ─────▼────────────────────────────────────────────┐
  │  lib/data-source/types.ts                                                │
  │                                                                          │
  │  interface DataSource {                                                  │
  │    callTool(name, args, opts?) → { result, durationMs, fromCache }       │
  │    listTools(opts?)            → unknown                                 │
  │  }                                                                       │
  │                                                                          │
  │  + DataSourceCallOptions { signal? }                                     │
  │  + DataSourceCallResult  { result, durationMs, fromCache }               │
  │  + ToolDef               (the MCP Tool shape, protocol-agnostic)         │
  │  + ToolResult            (the MCP CallToolResult envelope)               │
  └────────────────────────────┬────────────────────────────────────────────┘
                               │  implemented by:
            ┌──────────────────┴──────────────────┐
            ▼                                      ▼
  ┌─ Adapter ───────────────────────────┐  ┌─ Adapter ──────────────────────┐
  │  BloomreachDataSource                │  │  SyntheticDataSource           │
  │  (lib/data-source/bloomreach-…ts,    │  │  (lib/data-source/synthetic-…ts│
  │   214 LOC)                           │  │   516 LOC)                     │
  │                                       │  │                                │
  │  Wraps StreamableHTTPClientTransport  │  │  In-process fixtures           │
  │  + AES-256-GCM cookie auth           │  │  + deterministic EQL results   │
  │  + 1.1s proactive spacing            │  │  + no network                  │
  │  + rate-limit retry ladder           │  │                                │
  │  + 60s response cache                │  │  syntheticWorkspaceSchema      │
  │  + AbortSignal composition           │  │  (exported alongside)          │
  │                                       │  │                                │
  │  Bloomreach-specific extras:          │  │                                │
  │    CallToolOptions.cacheTtlMs         │  │                                │
  │    CallToolOptions.skipCache          │  │                                │
  │    (NOT on the port — escape via      │  │                                │
  │     ConnectResult.mcp)                │  │                                │
  └──────────────────────────────────────┘  └────────────────────────────────┘
                               ▲
                               │
  ┌─ Factory ─────────────────┴────────────────────────────────────────────┐
  │  makeDataSource(mode: LiveMode, sessionId: string)                       │
  │    'live-synthetic'  → new SyntheticDataSource()                         │
  │    'live-bloomreach' → connectMcp(sid) → BloomreachDataSource OR authUrl │
  │                                                                          │
  │  Returns: { ok: true, dataSource, bootstrap, dispose }                   │
  │       OR  { ok: false, authUrl }                                         │
  └─────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Hexagonal / ports-and-adapters.** This pattern's textbook name is Hexagonal Architecture (Alistair Cockburn, 2005). The shape is older — the GoF Adapter pattern dates to 1994, and `java.sql.Driver` is a port from 1997. The naming has rotated (ports + adapters, hexagonal, "clean architecture," dependency inversion) but the shape is constant: define the contract you want the inside of your app to consume, write adapters for each external system, depend only on the contract.

**Why a factory and not DI.** This repo's "dependency injection" is the factory return value passed by argument. There's no DI container, no decorator-driven registration. The factory returns the adapter, the route receives it, the route hands it to the agent. That's "dependency injection" in the sense Mark Seemann means: passing the dependency at the boundary where the lifetime is known (the request). A DI container would buy nothing here — there's exactly one consumer per request, the lifetime is the request, and the construction is conditional on a runtime mode.

**Why a `DataSource` instead of a `Repository`.** `Repository` is the related pattern from Domain-Driven Design — a collection-like abstraction over a persistent store of *entities*. `DataSource` here is more general: it abstracts a *callable surface* (tools with names and JSON-schema arguments), not a typed collection. The two patterns share dependency inversion; they differ in vocabulary. The MCP tool model maps cleanly to `DataSource`; trying to force it into `Repository` would invent entities that don't exist.

**The `unknown` return — vs. generics.** A generic `DataSource<TResults>` was on the table. It was rejected because (a) tool results have no single shape — each MCP tool returns a different payload, and (b) `unwrap<T>(result)` at the call site is exactly as type-safe as a generic on the port would be, but without forcing the port to model results it can't predict. The current shape preserves the call-site freedom without baking adapter-specific types into the abstraction.

**Where this pattern is most overused.** People reach for ports + adapters when there's only ever going to be one adapter. The receipt this repo has — two swaps already — is the legitimate case. The illegitimate case is "wrapping an SDK in an interface because it might be replaced someday." If the swap never comes, you've paid for the seam (extra file, extra indirection, extra type) and gotten nothing back. The right time to extract a seam is when the second adapter is imminent or the upstream is unreliable enough that swapping is reliability insurance.

## Interview defense

**Q: Why is the `DataSource` interface in this repo a port and not just a class?**

> Because two adapters live behind it today and three changes have crossed the seam without touching consumers. `BloomreachDataSource` is the real one — HTTPS over the MCP transport with OAuth, rate limit, cache. `SyntheticDataSource` is fixtures — in-process, deterministic, no network. The agents and routes hold the port (`DataSource` or its narrower `McpCaller` subset). The factory `makeDataSource(mode, sessionId)` picks the adapter. The receipt that proves the seam earns its keep: when the Olist SQL adapter was added in Phase 2 and removed in PR #8, no agent signature changed; when Synthetic was added, no agent signature changed. That's the test for "is this abstraction load-bearing" — does the change ledger read "swap an adapter" or does it read "touch the world."

```
  the dependency arrows — what makes it a port

  agents ──►  DataSource  ◄── BloomreachDataSource
                  ▲
                  └──────── SyntheticDataSource

  both sides depend on the abstraction in the middle
  → dependency inversion (the inner ring doesn't know the outer ring)
```

**Anchor:** `lib/data-source/types.ts:63-71`, `lib/data-source/index.ts:67-100`.

**Q: Why is there a `skipCache` option on `BloomreachDataSource` but not on the port?**

> Because `skipCache` is Bloomreach-specific — it bypasses the 60s response cache that `BloomreachDataSource` carries. `SyntheticDataSource` has no cache; modeling `skipCache` on the port would force every adapter to either implement a cache or document a no-op. The trade is that the four short MCP routes (`/api/mcp/{call,tools,tools/check,capture}`) need cache bypass for the dev "force fresh" path, so `ConnectResult.mcp` is typed as the concrete `BloomreachDataSource`. Those routes are the deliberate scope of the breach. Everyone else — agents, `bootstrapSchema`, the briefing route — narrows the result to `DataSource`. The principle: depend on the port wherever you can, hold the concrete adapter only where you must.

```
  the scoped breach

  ┌─ most callers ──┐  see DataSource (the port)
  │ agents, routes  │
  └─────────────────┘

  ┌─ 4 short routes ────┐  see BloomreachDataSource (the concrete)
  │ /api/mcp/{call,…}   │  because they need skipCache
  └─────────────────────┘
```

**Anchor:** `lib/mcp/connect.ts:21-28`, `lib/data-source/bloomreach-data-source.ts:22-26`.

**Q: What part of this is the "load-bearing skeleton" — what breaks first if you remove it?**

> Remove the **interface in `types.ts`**, and the seam evaporates. The factory could still pick an adapter, but every consumer would now hold a concrete type — the agents would compile against `BloomreachDataSource`, the route would store `BloomreachDataSource`, and `SyntheticDataSource` would only work if it extended the same class (not a separate adapter — a subclass). The next swap would touch every consumer. The interface is the *whole* of the seam; everything else (the factory, the dispose closure, the two adapters) is hardening layered on top. The kernel is "an `interface` with two methods that two classes implement"; remove it, and the system regresses to "agents depend on Bloomreach forever."

```
  the kernel

  ┌──────────────────────────────────┐
  │  interface DataSource {           │
  │    callTool(name, args, opts?)    │  ← THIS is the seam
  │    listTools(opts?)                │
  │  }                                │
  └──────────────────────────────────┘

  what's hardening (not the kernel):
    factory, dispose closure, bootstrap closure,
    DataSourceCallOptions, fromCache field
```

**Anchor:** `lib/data-source/types.ts:63-71` is the irreducible piece.

## See also

- `01-request-flow.md` — where the factory is called and the port is narrowed
- `02-auth-boundary.md` — what `connectMcp` does before returning the Bloomreach adapter
- `04-aptkit-primitive-boundary.md` — the same dependency-inversion shape, one layer up at the library boundary
- `10-rate-limit-aware-mcp-client.md` — what's *inside* the Bloomreach adapter
