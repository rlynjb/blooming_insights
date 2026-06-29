# DataSource seam — one interface, two adapters, swappable per request

**Industry name:** provider abstraction / hexagonal-architecture port / dependency-inversion seam · Industry standard

## Zoom out, then zoom in

The agents (monitoring, diagnostic, recommendation, query) don't know
whether they're talking to a live Bloomreach MCP server over HTTPS or to a
deterministic in-memory ecommerce fixture. They hold a `DataSource`. The
factory picks the adapter per request based on `bi:mode`.

You know how `useState` doesn't care whether the state lives in your
component, a context, or a Redux store — the interface (`[value, setter]`)
hides the implementation. Same shape here: `callTool(name, args)` hides
"HTTPS + OAuth + rate-limit + cache" behind the same surface as "look up
this fixture in a switch statement."

```
  Zoom out — where the DataSource seam lives

  ┌─ UI ────────────────────────────────────────────────┐
  │  page.tsx — toggle: demo | live-bloomreach | live-synthetic │
  └────────────────────────┬────────────────────────────┘
                           │
  ┌─ Route handler ────────▼────────────────────────────┐
  │  makeDataSource(mode, sessionId) ★ THE SEAM ★       │ ← we are here
  │                                                      │
  │   abstract surface (lib/data-source/types.ts:63-71): │
  │      callTool(name, args, opts?) → {result, ...}     │
  │      listTools(opts?) → unknown                      │
  └────────────────────────┬────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
  ┌─ Adapter A ───────┐    ┌─ Adapter B ───────────────┐
  │ Bloomreach        │    │ Synthetic                  │
  │ HTTPS + OAuth     │    │ in-process fixtures        │
  │ ~1 req/s + cache  │    │ no network, no rate limit  │
  │ + retry + timeout │    │                            │
  └───────────────────┘    └────────────────────────────┘
```

This file is about the load-bearing architectural move: **put the seam
where the provider could be swapped, then ship two implementations** so
the seam isn't theoretical.

## Structure pass — layers, axis, seams

**Layers:** Route handler → Factory → DataSource interface → concrete
adapter → underlying transport (HTTPS for one, function call for the
other).

**Axis (held constant): "what do callers see, and what does the adapter
hide?"** The interface promises a `{result, durationMs, fromCache}`
envelope — the question is what each layer adds or hides as you cross it.

```
  Axis: what's hidden behind this seam?

  ┌─ Agent (caller) ───────────────────────────────────┐
  │  dataSource.callTool('purchase', {project_id})     │   → SEES: name+args
  │                                                     │     HIDDEN: everything below
  └───────────────────────────┬─────────────────────────┘
                              │
  ┌─ DataSource interface ────▼─────────────────────────┐
  │  {result, durationMs, fromCache}                    │   → contract
  └───────────────────────────┬─────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
  ┌─ BloomreachDataSource ──┐    ┌─ SyntheticDataSource ──────────┐
  │ HIDES: 60s cache,        │   │ HIDES: switch(name) → fixture, │
  │  ~1 req/s spacing,       │   │  deterministic seeded RNG,      │
  │  retry ladder,           │   │  per-tool synthesis             │
  │  30s timeout,            │   │                                 │
  │  OAuth bearer header,    │   │                                 │
  │  HTTP transport          │   │                                 │
  └──────────────────────────┘   └─────────────────────────────────┘
```

**Seams (boundaries where the answer flips):**

- **Agent ↔ DataSource interface** — control-of-implementation flips
  here. Agents previously called `McpClient` directly; the interface
  extraction (Phase 2 PR A) lifted control out without changing
  `McpClient`'s behavior.
- **DataSource interface ↔ concrete adapter** — the substitution seam.
  The factory chooses; nothing else does. `makeDataSource` is the only
  place that names both concrete classes.
- **Concrete adapter ↔ transport** — what's-on-the-wire flips here.
  Bloomreach holds an `SdkTransport` (`lib/mcp/transport.ts:123-165`)
  wrapping the MCP SDK Client; Synthetic holds nothing — it IS the
  transport.

## How it works

### Move 1 — the mental model

The shape is a port and two adapters (hexagonal architecture, Cockburn).
The port — the interface — names what callers need. The adapters
implement it for different backends.

```
  Pattern — port and adapters

           ┌─ port (the interface) ─┐
           │  callTool(name, args)  │
           │  listTools()           │
           └──────────┬─────────────┘
                      │
           ┌──────────┴──────────┐
           ▼                     ▼
       adapter A             adapter B
       (Bloomreach)          (Synthetic)
           │                     │
           ▼                     ▼
       HTTPS + MCP           switch(name) →
       SDK + OAuth +         fixture
       cache + retry
```

What makes a port load-bearing: every consumer of the port stays the
same when the adapter changes. The interface is the API; the adapter is
the implementation; the factory is the choice.

### Move 2 — the step-by-step walkthrough

#### Step 1 — the port (the interface)

The interface is small on purpose. Two methods, both return shapes
mirror the MCP SDK's result envelope so the rename didn't change
behavior.

```typescript
// lib/data-source/types.ts:63-71
export interface DataSource {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult>;

  listTools(opts?: DataSourceListOptions): Promise<unknown>;
}

// lib/data-source/types.ts:53-57
export interface DataSourceCallResult {
  result: unknown;
  durationMs: number;
  fromCache: boolean;
}
```

What's deliberate here:

- `result: unknown` — every consumer casts. The interface doesn't
  pretend to know the shape of every tool's response. `unwrap<T>()`
  (`lib/mcp/schema.ts:36-43`) lives at the call site, not the
  interface.
- `fromCache: boolean` — the agent doesn't care, but the trace surface
  does. The UI's "how this was gathered" panel renders cache hits
  differently. The interface carries the field so the trace doesn't
  have to special-case the adapter.
- `opts?: DataSourceCallOptions` — today only `signal`. The Bloomreach
  adapter accepts MORE options (`cacheTtlMs`, `skipCache`) but those
  live on the concrete class, not the interface — agents would never
  need them.

#### Step 2 — the factory (the choice)

The factory is the one place that knows both adapters exist by name.

```typescript
// lib/data-source/index.ts:67-100 (abridged)
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

  // live-bloomreach — defer to the existing connect path. It owns the OAuth
  // dance, including the case where the session has no valid tokens.
  const conn: ConnectResult = await connectMcp(sessionId);
  if (!conn.ok) {
    return { ok: false, mode, authUrl: conn.authUrl };
  }
  return {
    ok: true, mode,
    dataSource: conn.mcp,
    bootstrap: (signal) => bootstrapSchema(conn.mcp, { signal }),
    dispose: async () => {},
  };
}
```

The factory also returns a `bootstrap` function and a `dispose` callback
— a small lifecycle envelope. Synthetic's bootstrap is `async () =>
syntheticWorkspaceSchema` (no I/O); Bloomreach's runs the real
4-call orchestrator (`list_cloud_organizations`, `list_projects`,
`get_event_schema`, `get_project_overview`).

```
  Factory result shape — the small lifecycle envelope

         ok:  true                  ok: false (Bloomreach only)
         ────                        ───────
         dataSource: DataSource     authUrl: string
         bootstrap()                (browser redirects)
         dispose()
```

#### Step 3 — adapter A: BloomreachDataSource

The Bloomreach adapter wraps an `SdkTransport` and adds 60-second
response caching, ~1 req/s proactive spacing, a retry ladder for
rate-limit errors, and an `AbortSignal` composition with a per-call
30-second timeout.

```typescript
// lib/data-source/bloomreach-data-source.ts:121-152 (abridged)
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;
  // ...
  async callTool<T = unknown>(
    name: string, args: Record<string, unknown>,
    options: CallToolOptions = {},
  ): Promise<CallToolResult<T>> {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
    const ttl = options.cacheTtlMs ?? 60_000;

    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result as T, durationMs: 0, fromCache: true };
      }
    }
    const start = Date.now();
    let result = await this.liveCall(name, args, options.signal);
    // ...retry ladder (see 05-caching-and-rate-limiting.md)...
    return { result: result as T, durationMs: Date.now() - start, fromCache: false };
  }
}
```

The cache, the spacing, the retries, the timeout — none of it leaks
through the interface. Agents see `{result, durationMs, fromCache}`.

#### Step 4 — adapter B: SyntheticDataSource

Synthetic implements the same interface but the body is `switch(name)`
over fixtures.

```typescript
// lib/data-source/synthetic-data-source.ts:1-516 (sketch — abridged for clarity)
export class SyntheticDataSource implements DataSource {
  async callTool(name, args, opts) {
    switch (name) {
      case 'list_cloud_organizations': return { result: {...}, durationMs: 0, fromCache: false };
      case 'get_event_schema':         return { result: {...}, durationMs: 0, fromCache: false };
      case 'execute_analytics_eql':    return synthesizeEql(args);  // deterministic seeded computation
      // ... ~10 tool names matching what monitoring/diagnostic/recommendation expect
    }
  }
  async listTools(): Promise<unknown> { return { tools: SYNTHETIC_TOOLS }; }
}

// Plus an exported `syntheticWorkspaceSchema` for the factory's bootstrap.
```

Synthetic's job: behave well enough that the AGENT LOOP runs end-to-end
against it — same Anthropic SDK calls, same tool_use/tool_result
ping-pong, same NDJSON events out — just with deterministic data. It's
not for unit tests; it's a runnable demo backend.

#### Step 5 — the legacy alias

The old `lib/mcp/client.ts` is a 17-line shim that re-exports
`BloomreachDataSource` as `McpClient` for the four short MCP routes that
need the Bloomreach-specific `skipCache` option:

```typescript
// lib/mcp/client.ts (17 lines, abridged):
export {
  BloomreachDataSource as McpClient,
  McpToolError,
  type CallToolOptions,
  type ListToolsOptions,
  type CallToolResult,
} from '../data-source/bloomreach-data-source';
```

The four callers — `/api/mcp/{call,reset,tools,tools/check,capture}` —
still need the concrete adapter so they can pass `skipCache: true` for
the dev `/debug` force-fresh path. Agents NEVER need this; they narrow
to `DataSource` at construction.

```
  The two consumer styles

  Agent layer (4 wrappers):           4 short MCP routes:
  ────────────────────────            ──────────────────
  constructor(private dataSource:     const conn = await connectMcp(sid);
    McpCaller)                        conn.mcp.callTool(..., { skipCache: true })
  → narrows to {callTool}             → uses concrete BloomreachDataSource
  → swappable                         → not swappable
                                      → fine: these routes are Bloomreach-only by purpose
```

#### Step 6 — how the route uses it

The route handler is the one place that sees both shapes. It uses the
factory to get an opaque `DataSource`, hands that to the agents, and
keeps the bootstrap/dispose callbacks for its own use.

```typescript
// app/api/agent/route.ts:165-181 (abridged)
let dsResult: Awaited<ReturnType<typeof makeDataSource>>;
try {
  dsResult = await makeDataSource(mode, sid);
} catch (e) { /* 500 with redacted message */ }
if (!dsResult.ok) return NextResponse.json({ needsAuth: true, authUrl: dsResult.authUrl }, { status: 401 });

const dataSource = dsResult.dataSource;          // opaque DataSource
const bootstrap  = dsResult.bootstrap;           // closure that runs the schema fetch
const disposeDataSource = dsResult.dispose;      // teardown hook

// ... later, inside the stream ...
const schema = await bootstrap(req.signal);
const rawTools = await dataSource.listTools({ signal: req.signal });
const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
```

### Move 3 — the principle

**The seam earns its keep when an adapter exists on both sides.** An
abstract interface with only one implementation is a guess about a
future need; an abstract interface with two implementations is a fact
about a present one. This codebase has two: live Bloomreach and
synthetic. The synthetic adapter isn't a test double — it's a runnable
backend that lets the rest of the system stay honest about running the
real agent loop without depending on a flaky upstream.

The general lesson: when an external provider is unreliable, slow, or
rate-limited (as Bloomreach's alpha is), the seam in front of it isn't
optimization — it's how you ship at all. Without the synthetic adapter,
every demo would depend on the alpha server being available; with it,
the alpha server is just one of two ways to run.

## Primary diagram

```
  DataSource seam — request to response, both adapters

  ┌─ Route handler ─────────────────────────────────────────────────────────┐
  │                                                                          │
  │  mode = parseLiveMode(...)                                               │
  │  dsResult = await makeDataSource(mode, sid)                              │
  │                                                                          │
  │       ┌─ mode === 'live-synthetic' ─────┐    ┌─ mode === 'live-bloomreach' ─┐
  │       │ new SyntheticDataSource()       │    │ await connectMcp(sid)         │
  │       │ bootstrap = async () =>         │    │   → { ok, mcp } | { authUrl } │
  │       │   syntheticWorkspaceSchema      │    │ bootstrap = (s) =>            │
  │       └─────────────────┬───────────────┘    │   bootstrapSchema(mcp, {s})   │
  │                         │                    └────────────┬──────────────────┘
  │                         ▼                                 ▼
  │                  dsResult.dataSource : DataSource                          │
  │                         │                                                  │
  │                         ▼                                                  │
  │  new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid)         │
  │  await agent.investigate(anomaly, { ..., signal: req.signal })             │
  │           │                                                                │
  │           ▼                                                                │
  │     hooks emit tool_call_* events to the NDJSON stream                     │
  │                                                                            │
  └────────────────────────────────────────────────────────────────────────────┘

  Inside the agent:                                Inside each adapter:
  ─────────────────                                ────────────────────
  toolRegistry.callTool('purchase', {...})         Bloomreach:
      └─ BloomingToolRegistryAdapter.callTool ──►   60s cache → ~1 req/s spacing
         └─ dataSource.callTool('purchase', {...})  → MCP HTTPS POST → retry on 429
                                                    → {result, durationMs, fromCache}

                                                  Synthetic:
                                                    switch ('purchase') → fixture
                                                    → {result, durationMs:0, fromCache:false}
```

## Elaborate

**Where this pattern comes from.** Ports-and-adapters / hexagonal
architecture (Alistair Cockburn, ~2005) is the canonical name. The
older "dependency injection" framing (Fowler, ~2004) is the same shape
seen through a different lens — DI is HOW you wire adapters to ports;
ports-and-adapters is WHY the port exists in the first place.

**The deeper principle.** Substitutability. If you can swap adapter A
for adapter B without changing callers, the seam is real. If you can't,
the interface is decoration. The test that proves the seam: ship two
implementations and run the same code against both. This codebase
passes that test — `bi:mode = live-synthetic` runs the real agents
against fake data; `bi:mode = live-bloomreach` runs them against real
data. Same agent code, same NDJSON contract, same UI.

**Where it breaks.**

- **The interface is too thin to express adapter capabilities.**
  `BloomreachDataSource` accepts `skipCache: true`; `SyntheticDataSource`
  doesn't have a cache. We model this by exposing `skipCache` on the
  concrete class (not the interface) and only the four short MCP routes
  use it. If a future adapter needed cache controls too, we'd have to
  promote `skipCache` to the interface — at which point Synthetic would
  no-op it.
- **The bootstrap closure leaks bootstrap-specific knowledge into the
  factory result.** `makeDataSource` returns `{ bootstrap, dispose }`
  alongside `dataSource` because Bloomreach needs a 4-call orchestrator
  and Synthetic needs a constant. This is a real coupling — a third
  adapter would need to define its own bootstrap, and the factory
  result would still have one slot. Worth living with for now.
- **The `cached` schema is module-level, not per-adapter.** `lib/mcp/
  schema.ts:138` caches across adapter swaps. If you start a request
  with `live-bloomreach` and then flip to `live-synthetic`, the cached
  Bloomreach schema may still be returned to a `live-synthetic`
  bootstrap call. Today this isn't an issue because the synthetic
  bootstrap doesn't call `bootstrapSchema()` — it returns a different
  constant. But it's a sharp edge for a future adapter.

**What to explore next.**

- `04-aptkit-primitive-boundary.md` — the SAME pattern, one layer up
  (agents wrap AptKit primitives via three adapter classes; the
  AnthropicModelProviderAdapter is to AptKit what BloomreachDataSource
  is to agents)
- `05-caching-and-rate-limiting.md` — what's hidden inside the
  Bloomreach adapter
- `01-request-flow.md` — where the factory gets called

## Interview defense

#### Q: "Walk me through your provider abstraction. Why not just use the MCP client directly?"

Two reasons. **One**: the live MCP server is rate-limited and revokes
tokens after minutes — running the full agent loop against it on every
dev save, every test run, every demo run is unworkable. **Two**: I want
the agents to be testable and runnable without a network. The
DataSource seam gives me one interface (`callTool` + `listTools`) and
two adapters: `BloomreachDataSource` (live HTTPS + OAuth + cache +
rate-limit) and `SyntheticDataSource` (in-process fixtures). The
factory picks per request based on `bi:mode`.

```
       agent loop
           │
           ▼
       the port (`DataSource`)
        ┌──┴──┐
        ▼     ▼
    Bloomreach  Synthetic
    (live)      (in-process)
```

The agents never know which one they got. The route handler is the
only place that names both.

**Surface:** "port + two adapters, factory chooses."
**Probe:** if pressed — name the load-bearing test (`bi:mode =
live-synthetic` runs the real agent loop, not a test double).

#### Q: "What's the load-bearing part of this seam — what breaks if you remove it?"

Two pieces are load-bearing. **The interface** itself — without
`DataSource`, agents would import `BloomreachDataSource` directly, and
swapping in Synthetic would require touching every agent constructor.
**The factory** — without `makeDataSource`, every route handler would
have to know about both concrete classes, which is exactly the coupling
the interface was supposed to break.

Optional hardening (not load-bearing):

  → the `{ bootstrap, dispose }` callbacks on the factory result — these
    work around the bootstrap-shape difference, but they're a leak;
    cleaner would be a per-adapter `bootstrap()` method on the interface
  → the `fromCache: boolean` field — only the trace UI uses it; the
    agent doesn't care
  → the legacy `McpClient` re-export — exists so the four short MCP
    routes don't have to migrate; pure compatibility

#### Q: "What changes if you add a third adapter?"

Three things. **One**: a new branch in `makeDataSource` (one switch
arm). **Two**: a new `bootstrap` closure — because the schema-fetch
shape isn't currently in the interface, every adapter needs its own.
**Three**: maybe a new `bi:mode` value and a UI toggle option, if the
mode is user-facing.

The agents don't change. The hooks don't change. The NDJSON contract
doesn't change. That's the proof the seam is real.

Latent concern: if the third adapter needs cache controls (like
Bloomreach's `skipCache`), I'd promote `skipCache` to the interface
and have Synthetic no-op it. Today the four short MCP routes are
explicitly Bloomreach-only, so the leak is contained.

## See also

- `00-overview.md` — where this sits in the whole system
- `04-aptkit-primitive-boundary.md` — the same pattern one layer up
- `05-caching-and-rate-limiting.md` — what's behind the Bloomreach adapter
- `01-request-flow.md` — where the factory is called
- `study-data-modeling` — the `WorkspaceSchema` the bootstrap produces
