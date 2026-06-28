# Provider / transport abstraction

**Industry name(s):** Dependency inversion, Strategy pattern, Adapter pattern, ports-and-adapters (hexagonal)
**Type:** Industry standard · Language-agnostic

> Code that depends on a thin interface it owns — not on a specific vendor SDK — can be tested with a plain-object fake AND swapped to a different backend without touching callers. The blooming-insights repo exercises both halves of that promise: the agent layer drives Bloomreach OR an in-process Blooming-owned synthetic adapter because of the seam above the adapters, and `BloomreachDataSource`'s internals (cache, spacing, retry) test offline because of the seam below it.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A seam is like the threshold of a doorway: the door doesn't care which side you stand on, the room doesn't know whether you came from inside or outside, and the seam itself is just a shape that's the same on both sides. The provider abstraction is a **vertical stack of two seams**, not one — two thresholds, stacked, each hiding a different kind of swap. The upper seam is the load-bearing one: `DataSource` (`lib/data-source/types.ts`) — a two-method surface (`callTool`, `listTools`) that every agent depends on via the `BloomingToolRegistryAdapter` bridge into `@aptkit/core`. Three implementations live under it — two real, one purely abstract: `BloomreachDataSource` (the live MCP client over Bloomreach Engagement; `lib/data-source/bloomreach-data-source.ts`; the old `McpClient` from `lib/mcp/client.ts` is now a backwards-compat shim re-exporting it) and `SyntheticDataSource` (a Blooming-owned in-process adapter with ~516 LOC of deterministic ecommerce fixture data, no transport, no auth, no network — `lib/data-source/synthetic-data-source.ts`). The third "implementation" is the abstract `DataSource` interface itself, satisfied structurally by test fakes everywhere in the test suite. The lower seam is the older `McpTransport` — still there, still useful, but scoped to the inside of `BloomreachDataSource`: it isolates the `@modelcontextprotocol/sdk` HTTP client so the Bloomreach adapter itself stays unit-testable. Two seams, two jobs: the upper one swaps **backends**; the lower one swaps the **HTTP SDK** inside the Bloomreach adapter.

```
Zoom out — the two-seam vertical stack

┌─ Agent layer ──────────────────────────────────┐
│  AptKit agent classes ← BloomingToolRegistry-  │
│                          Adapter ← DataSource  │
│  depends on ↓                                  │
│  ★ DataSource ★  (lib/data-source/types.ts)    │ ← UPPER seam
│        │                 │              │       │   backend swap
│        │                 │              │       │
│  BloomreachDataSource  SyntheticData    fakes  │
│  (live-bloomreach)     Source           (test) │
│                        (live-synthetic)        │
└─────────────────────┬──────────────────────────┘
                      │
                      │  inside BloomreachDataSource only:
┌─ Bloomreach internals ▼────────────────────────┐
│  cache · spacing · retry · auth                │
│  depends on ↓                                  │
│  ★ McpTransport ★ (lib/mcp/transport.ts)      │ ← LOWER seam (older)
│         │                  │                   │   HTTP SDK swap
│    SdkTransport     fakeTransport (test)       │
│   (prod)            client.test.ts             │
└─────────────────────┬──────────────────────────┘
                      │
┌─ Vendor edges ─────────────────────────────────┐
│  Anthropic SDK · MCP SDK · HTTP transport      │
│  (no subprocess; SyntheticDataSource is in-    │
│   process, no underlying transport)            │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is no longer just "how do you test code that drives a vendor SDK?" It's also "how do you run the same agent stack against two genuinely different backends — a live HTTPS MCP server with OAuth AND a deterministic in-process synthetic data source with no network at all — without the agent layer noticing?" The answer is the `DataSource` interface above and a `makeDataSource(mode, sessionId)` factory in `lib/data-source/index.ts` that returns the adapter pre-connected, along with a `bootstrap(signal)` method (Bloomreach calls real schema-discovery tools; Synthetic returns a hardcoded `syntheticWorkspaceSchema` const because the adapter knows its own schema upfront) and a `dispose()` (both branches are no-ops at present — Bloomreach because the OAuth session outlives the request via the cookie store; Synthetic because there's no resource to release). Three runtime modes (`bi:mode = 'demo' | 'live-bloomreach' | 'live-synthetic'`), two live adapters, one interface. The next sections walk both seams and the factory that stitches them together.

---

## Structure pass

**Layers.** Five layers, two seams. The **caller** (any agent code — the five `lib/agents/{monitoring,diagnostic,recommendation,query,intent}.ts` classes and `BloomingToolRegistryAdapter` in `lib/agents/aptkit-adapters.ts`), the **upper owned interface** (`DataSource` — the backend-swap port), the **adapter** (`BloomreachDataSource` OR `SyntheticDataSource` OR a fake), the **lower owned interface** (`McpTransport` — only inside `BloomreachDataSource`, the HTTP-SDK-swap port), and the **vendor edge** (`@modelcontextprotocol/sdk` Client, `StreamableHTTPClientTransport` for Bloomreach; no vendor for Synthetic because it's in-process). Five layers; two seams; one factory (`makeDataSource(mode, sessionId)`) that hides which adapter the route handler got.

**Axis: dependency.** Which direction does the type-arrow point at each layer boundary? This is the right axis because the entire reason this abstraction exists is dependency *inversion* — flipping who points at whom. In a naive design, the agent would import `Client` from `@modelcontextprotocol/sdk` (or worse, import a concrete adapter when synthetic mode is wanted); here the agent depends on a type *this codebase owns* (`DataSource`), and every concrete adapter is the thing that depends on satisfying it. That arrow-flip is what makes the test suite run offline AND what lets the same agent stack drive two different backends without an `if (mode === ...)` inside the agent.

**Seams.** Two seams, both load-bearing, but they do **different jobs**. **Seam 1 (upper, load-bearing): caller → `DataSource`.** Dependency flips from "agent imports a concrete adapter" to "agent imports a type"; the *adapter* can now be Bloomreach or Synthetic or a fake. This is the **backend swap seam** — it's what makes the synthetic mode possible without rewriting the agent layer. **Seam 2 (lower, older): `BloomreachDataSource` → `McpTransport`.** Dependency flips from "Bloomreach adapter imports the MCP HTTP SDK" to "Bloomreach adapter imports a transport type"; the transport can be `SdkTransport` or `fakeTransport`. This is the **HTTP-SDK swap seam** — it's why the Bloomreach adapter's own unit tests don't need network. The two seams compose: **Synthetic doesn't need the lower seam at all** (it has no transport — its `callTool` dispatches through a switch statement to in-memory fixture data), so it implements `DataSource` directly without an `McpTransport` underneath. That asymmetry is the load-bearing detail: a thin, *truly* abstract upper interface that doesn't leak Bloomreach-isms is what lets a second adapter be shaped completely differently inside.

```
Structure pass — provider abstraction (two seams)

┌─ 1. LAYERS ────────────────────────────────────────────┐
│  Caller · DataSource (upper) · Adapter ·                │
│  McpTransport (lower, Bloomreach only) · Vendor edge   │
└───────────────────────────┬────────────────────────────┘
                            │  pick the axis
┌─ 2. AXIS ────────────────▼─────────────────────────────┐
│  dependency: which way does the type-arrow point at    │
│  each boundary?                                        │
└───────────────────────────┬────────────────────────────┘
                            │  trace across layers, find flips
┌─ 3. SEAMS ───────────────▼─────────────────────────────┐
│  S1: caller → DataSource ★load-bearing                  │
│      backend swap: Bloomreach OR Synthetic OR fake      │
│  S2: BloomreachDataSource → McpTransport               │
│      HTTP-SDK swap, Bloomreach-only (lower seam)        │
└───────────────────────────┬────────────────────────────┘
                            ▼
                    Block 4 — How it works
```

```
S1 seam — "which backend satisfies DataSource?" answered three ways

┌─ DataSource ──────┐    seam     ┌─ Adapter ────────────────────────────┐
│  callTool(name,   │ ═════╪═════►│  live-bloomreach: HTTPS + OAuth      │
│    args, opts)    │  (it flips) │  live-synthetic:  in-process switch  │
│  listTools(opts)  │             │  test:            plain object       │
└───────────────────┘             └──────────────────────────────────────┘
        ▲                                       ▲
        └──── same axis (dependency), three answers ─┘
              → backend swap (prod vs offline-dev)
              → tests structurally satisfy DataSource
              → makeDataSource(mode, sessionId) picks one
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

---

## How it works

**Verdict first.** Two seams stacked vertically, doing different jobs. The upper (`DataSource`) is the one that pays off the abstraction — it's why the same agents drive Bloomreach in prod AND a deterministic in-process synthetic adapter for development/demo, with a runtime switch. The lower (`McpTransport`) is the one that pays off the testability — it's why the Bloomreach adapter itself runs in unit tests without a network. The factory (`makeDataSource(mode, sessionId)`) is the third moving part: it lives at the upper seam and hides which adapter the route handler got, plus owns bootstrap/dispose. The load-bearing question for the upper seam is *how thin can the interface stay while still being useful?* — the answer drives the rest of the file.

```
┌────────────────────────────────────────────────┐
│              Agent code                        │
│  (lib/agents/*.ts → BloomingToolRegistry-      │
│   Adapter → DataSource.callTool)                │
└──────────────────────┬─────────────────────────┘
                       │ depends on DataSource only
                       ▼
          ┌────────────────────────┐
          │  DataSource (upper)    │   2 methods:
          │  callTool, listTools   │   callTool / listTools
          └────────┬───────────────┘
                   │
       ┌───────────┼────────────────────────┐
       ▼           ▼                        ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
│Bloomreach    │  │ Synthetic        │  │   Fake / test    │
│DataSource    │  │ DataSource       │  │   plain object   │
│(prod, live-  │  │ (live-synthetic) │  │   (tests)        │
│ bloomreach)  │  │  in-process,     │  └──────────────────┘
│              │  │  ~516 LOC of     │
│              │  │  fixture data    │
└──────┬───────┘  └──────────────────┘
       │              (no transport — switch-dispatch)
       │ depends on
       │ McpTransport
       ▼
┌──────────────┐
│ SdkTransport │
│ (HTTP MCP)   │
└──────────────┘
```

The upper interface sits between the agent layer and any backend. The lower interface (`McpTransport`) only matters inside `BloomreachDataSource` — `SyntheticDataSource` doesn't use it because there IS no wire to swap; tool calls dispatch through an in-process switch statement against `const`-defined fixture data. The asymmetry is the load-bearing detail: keeping `DataSource` truly abstract (no Bloomreach-isms, no MCP-isms) is what lets the Synthetic adapter be shaped completely differently inside. The fake at the upper seam is still ~5 lines; the fake at the lower seam is still ~5 lines; that's the testability dividend.

### The DataSource interface (the upper seam)

The upper seam is a two-method surface defined in `lib/data-source/types.ts` and consumed by every agent (via the AptKit tool-registry adapter bridge in `lib/agents/aptkit-adapters.ts`):

```
interface DataSource:
    callTool(name, args, opts?: { signal? })
        → Promise<{ result, durationMs, fromCache }>
    listTools(opts?: { signal? })
        → Promise<unknown>
```

Two methods. No MCP types in the signature (the `unknown` return on `listTools` is deliberate — neither caller cares about MCP-specific `Tool` shape; the agent's `tool-schemas.ts` flattens it). The result envelope `{ result, durationMs, fromCache }` matches what `BloomreachDataSource` already returned, so the seam was extracted, not invented — `SyntheticDataSource` returns `fromCache: false` and a real `durationMs` (it computes `Date.now() - started`, which lands at ~0–1 ms); tests can return whatever they want. `dispose` is NOT on the interface — it's added per-adapter where the lifecycle demands it, and the factory exposes it on its own return shape so route handlers can call it symmetrically without the interface itself caring.

```
DataSource interface (upper seam)
┌─────────────────────────────────────────────────┐
│  callTool(name, args, opts?)                     │
│    → Promise<{result, durationMs, fromCache}>    │
│  listTools(opts?)                                │
│    → Promise<unknown>                            │
└─────────────────────────────────────────────────┘
         ▲                    ▲                ▲
         │ implements          │ implements    │ structurally satisfies
  BloomreachDataSource  SyntheticDataSource    fake DataSource
  (live-bloomreach)     (live-synthetic)       (tests)
```

### The factory — `makeDataSource(mode, sessionId)`

The factory in `lib/data-source/index.ts` is the single entry point the route handlers use. It owns three responsibilities: picking the adapter for the requested mode, preparing it for use, and returning a `bootstrap` + `dispose` symmetric across both modes.

```
makeDataSource(mode, sessionId):
    if mode == 'live-synthetic':
        ds = new SyntheticDataSource()      # nothing to connect — in-process
        return {
          ok: true,
          dataSource: ds,
          bootstrap: () -> syntheticWorkspaceSchema,   # module-level const, no I/O
          dispose: () -> {},                # no resource to release
        }
    if mode == 'live-bloomreach':
        conn = connectMcp(sessionId)        # OAuth round-trip
        if not conn.ok:
            return { ok: false, authUrl: conn.authUrl }   # route redirects
        return {
          ok: true,
          dataSource: conn.mcp,
          bootstrap: (sig) -> bootstrapSchema(conn.mcp, sig),  # 4+ MCP calls
          dispose: () -> {},                # session-scoped; lives across requests
        }
```

The asymmetry in `bootstrap` is the load-bearing detail: Bloomreach runs four+ sequential MCP calls (`list_cloud_organizations` → `list_projects` → `get_event_schema` → `get_customer_property_schema` → `list_catalogs` → `get_project_overview`); Synthetic just returns its compile-time-known `syntheticWorkspaceSchema` const. Same `Promise<WorkspaceSchema>` return type — different ways of producing it. **Same shape, different failure model:** Bloomreach's bootstrap can fail with rate-limit retries, OAuth expiry, or network 5xx; Synthetic's can't fail at all (it's a property read on a module-level const). The result is the agent layer treats both identically: `const schema = await result.bootstrap(req.signal);`.

Both modes' `dispose` is currently a no-op — Bloomreach because the session outlives the request via the cookie store; Synthetic because there's nothing to release. The call-site keeps the symmetric shape (`finally { await result.dispose() }`) anyway so a future adapter that DOES need teardown (a hypothetical websocket-backed adapter, a subprocess-backed one) plugs in without changing the route.

```
factory return shape (symmetric across modes)
┌──────────────────────────────────────────────────┐
│  { ok: true,  dataSource, bootstrap, dispose }    │
│  { ok: false, authUrl }      ← Bloomreach OAuth   │
└──────────────────────────────────────────────────┘
        ▲                                ▲
        │ both modes call .bootstrap     │ only Bloomreach can fail to connect
        │ both modes call .dispose       │   (Olist never has an auth gate)
        │ (Bloomreach: no-op)            │
```

### The transport interface (the lower seam)

Below `BloomreachDataSource` sits the older `McpTransport` seam — unchanged, but now scoped to exactly one job: isolating the `@modelcontextprotocol/sdk` HTTP client so the Bloomreach adapter's own unit tests (cache, spacing, retry) don't need network. Olist doesn't use this seam at all — its wire is stdio, so `OlistDataSource` constructs an MCP `Client` + `StdioClientTransport` directly without an `McpTransport` in between.

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

Agents need to call tools, but they should not be coupled to the full Bloomreach adapter class with its cache, retry logic, and rate-limiter. A one-method surface (`McpCaller`) used to live in the agent module — *and it's still there as a legacy alias*, but in practice the agent layer now consumes `DataSource` directly (`McpCaller` is structurally compatible with the `callTool` slice of `DataSource`, so existing test fakes still type-check). The minimal contract the agent layer needs:

```
interface Caller:        # historical / structural; superseded by DataSource
    callTool(
      name,
      args,
      opts?: { cacheTtlMs?, skipCache? },
    ) → Promise<{ result, durationMs, fromCache }>
```

Both `BloomreachDataSource` and `OlistDataSource` satisfy this without ceremony — structural typing means any object whose `callTool` signature is a superset of what the caller demands is accepted. In production, `makeDataSource()` returns the right adapter; in tests, a hand-written fake is passed.

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

### Code in this codebase

Each sub-section above names a part of the seam; here's where each one lives in the repo.

#### lib/data-source/types.ts (upper seam — NEW since 2026-06-02)

**Interface** (L64–L72): `DataSource` — the three-method backend-swap port. Imported by `runAgentLoop` (via `McpCaller`-compatible structural typing) and by every adapter.

```typescript
// L64–L72
export interface DataSource {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult>;
  listTools(opts?: DataSourceListOptions): Promise<unknown>;
}
```

Note `dispose` isn't on the interface — it's added per-adapter so test fakes don't need to implement it. The factory exposes `dispose` on its return shape, which is where route handlers consume it.

#### lib/data-source/index.ts (the factory — NEW)

**`makeDataSource(mode, sessionId)`** (L73–L109): the single entry point for both live modes. Returns `{ok: true, dataSource, bootstrap, dispose}` on success, `{ok: false, authUrl}` only on the Bloomreach branch when OAuth tokens are missing.

```typescript
// L77–L89 (the live-sql branch)
if (mode === 'live-sql') {
  const ds = new OlistDataSource();
  await ds.connect();
  return {
    ok: true,
    mode,
    dataSource: ds,
    // Synthesized — Olist has no schema-discovery tools.
    bootstrap: async () => olistWorkspaceSchema(),
    dispose: () => ds.dispose(),
  };
}
```

The Bloomreach branch (L93–L108) defers to `connectMcp(sessionId)` and passes the resulting client through as the `DataSource`, with `bootstrap` calling the live `bootstrapSchema` and `dispose` as a no-op (the session outlives the request via the cookie store).

#### lib/data-source/bloomreach-data-source.ts (the Bloomreach adapter — RELOCATED)

**Was:** `lib/mcp/client.ts` `McpClient` class.
**Now:** `BloomreachDataSource implements DataSource` (L121–L214). Internals unchanged — same 60s cache, ~1 req/s spacing, parse-the-retry-hint retry ladder, capturing-fetch error capture, `McpToolError` re-tag. The rename is the entire delta of the move.

```typescript
// L121–L137 (excerpt)
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;
  // …
  constructor(private transport: McpTransport, opts: ClientOpts = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 200;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 10_000;
    this.retryCeilingMs = opts.retryCeilingMs ?? 20_000;
  }
```

#### lib/mcp/client.ts (backwards-compat shim — NEW)

A 17-line file. Re-exports `BloomreachDataSource as McpClient`, `McpToolError`, and the legacy option types so every existing import (`import { McpClient } from '../mcp/client'`) compiles unchanged.

```typescript
// L13–L19
export {
  BloomreachDataSource as McpClient,
  McpToolError,
  type CallToolOptions,
  type ListToolsOptions,
  type CallToolResult,
} from '../data-source/bloomreach-data-source';
```

This shim is what made the seam extraction a zero-callsite-change refactor. Delete it the day every consumer has migrated to `DataSource`.

#### lib/data-source/olist-data-source.ts (the second adapter — NEW)

**`OlistDataSource implements DataSource`** (L93–L197). Spawns `mcp-server-olist`'s compiled entry via `StdioClientTransport` (L127–L138) on first use (lazy connect, L109–L118), wires an MCP `Client`, and exposes `callTool` (L143–L167) / `listTools` (L169–L174) / `dispose` (L177–L196). `OlistToolError` mirrors `McpToolError` so the agent loop's surface stays consistent.

```typescript
// L127–L141 (the subprocess spawn)
const transport = new StdioClientTransport({
  command: this.nodeExecutable,
  args: [this.serverEntry],
  stderr: 'inherit',                  // ready/log lines surface to parent
});
const client = new Client(
  { name: 'blooming-insights-olist-adapter', version: '0.1.0' },
  { capabilities: {} },
);
await client.connect(transport);
this.transport = transport;
this.client = client;
```

The subprocess lifecycle is one-per-instance, lazy-connect-on-first-use, killed on `dispose()`. See `10-authored-mcp-server.md` for the server side.

**Interface** (L7–L10): `McpTransport` — the two-method contract `BloomreachDataSource` depends on.
**Capturing-fetch error seam** (`HttpErrorHolder` L15–L17, `makeCapturingFetch` L24–L36): a `fetch` wrapper that stashes the body of any non-OK response so transport errors carry the real server text.
**Real impl** (L41–L74): `SdkTransport` — wraps `Client` from `@modelcontextprotocol/sdk` (and an optional `HttpErrorHolder`, L42–L45). The only file in the Bloomreach path that imports the SDK HTTP client class.

GitHub: `lib/mcp/transport.ts`

```typescript
// L7–L10
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<unknown>;
}
```

#### lib/agents/base.ts

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

#### test/mcp/client.test.ts (lower-seam fakes)

**fakeTransport** (L5–L12): plain object satisfying `McpTransport`, counting calls. Every test in this file passes a `fakeTransport` to `new BloomreachDataSource(t)` (or its `McpClient` alias) — no real MCP connection required. This is the fake that proves the **lower** seam works.

#### test/data-source/olist-data-source.test.ts and adapter tests (upper-seam fakes)

`runAgentLoop` tests pass plain-object `DataSource` fakes structurally — the agent layer never imports a concrete adapter. The Olist adapter's own tests stub the subprocess entry path so the spawn is exercised without actually running the SQLite server. Total test count grew from 144 to 269 across the seam extraction + Olist adapter + eval scaffolding.

#### test/agents/base.test.ts

**buildFakeAnthropic** (L16–L56): constructs a `{ messages: { create: vi.fn() } }` object with scripted response sequences, cast `as unknown as Anthropic` at the call site.
**buildFakeMcp** (L76–L83): plain object satisfying `McpCaller`.

Both fakes are passed directly into `runAgentLoop` at test call sites (e.g., L127–L135).

GitHub: `test/agents/base.test.ts`

---

## Provider / transport abstraction — diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  AGENT LAYER                                                                 │
│                                                                              │
│   runAgentLoop (lib/agents/base.ts)                                          │
│     opts: { anthropic, mcp }     mcp.callTool → DataSource                  │
│   MonitoringAgent / DiagnosticAgent / RecommendationAgent / QueryAgent      │
│     all consume the same DataSource — no concrete adapter import             │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ DataSource interface (lib/data-source/types.ts L64-L72)
                                   │ ★ UPPER SEAM — backend swap ★
              ┌────────────────────┼───────────────────┐
              ▼                    ▼                   ▼
   ┌──────────────────┐  ┌───────────────────┐  ┌──────────────────┐
   │  ADAPTER A       │  │  ADAPTER B        │  │  TEST FAKES      │
   │  BloomreachData  │  │  OlistDataSource  │  │  plain object    │
   │  Source          │  │  (lib/data-source/│  │  satisfying       │
   │  (live-          │  │   olist-data-     │  │  DataSource      │
   │   bloomreach)    │  │   source.ts)      │  │  (269 tests)     │
   │                  │  │                   │  │                  │
   │  cache + spacing │  │  subprocess +     │  └──────────────────┘
   │  + retry + auth  │  │  stdio + lazy     │
   │  + McpToolError  │  │  connect          │
   └────────┬─────────┘  └─────────┬─────────┘
            │ McpTransport          │ Client + StdioClientTransport
            │ ★ LOWER SEAM ★        │ (no lower seam — stdio is the wire)
            │ HTTP-SDK swap         │
   ┌────────┴──────────┐            │
   ▼                   ▼            ▼
┌─────────────┐  ┌─────────────┐  ┌──────────────────────────────┐
│ SdkTransport│  │fakeTransport│  │ mcp-server-olist subprocess  │
│ (prod)      │  │ (client.    │  │   (Node, better-sqlite3)     │
│             │  │  test.ts)   │  │   3 domain tools             │
└──────┬──────┘  └─────────────┘  │   see 10-authored-mcp-server │
       │                          └──────────────────────────────┘
       ▼
┌──────────────────────────────┐
│ @modelcontextprotocol/sdk    │
│ + StreamableHTTPClientTrans  │
│ + OAuth (loomi connect)      │
└──────────────────────────────┘

           ┌───────────────────────────────────────────┐
           │  makeDataSource(mode, sessionId) factory  │
           │  (lib/data-source/index.ts L73-L109)      │
           │                                            │
           │  picks adapter by mode, returns:           │
           │    { ok, dataSource, bootstrap, dispose } │
           │  route handlers consume this, never the    │
           │  concrete adapter directly                 │
           └───────────────────────────────────────────┘
```

Two seams, two jobs. The **upper** seam (`DataSource`) is the backend-swap port — it's why the same agent stack drives Bloomreach in prod AND Olist in eval. The **lower** seam (`McpTransport`) is the HTTP-SDK-swap port — it's why `BloomreachDataSource`'s cache + spacing + retry tests run offline. Everything above the upper seam is adapter-agnostic. Everything below the lower seam is `BloomreachDataSource`-specific.

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

### Thin interface vs thick adapter — the design tension this repo actually resolved

The `DataSource` interface has three methods. Each adapter has hundreds of lines of internal behavior the interface deliberately doesn't expose: `BloomreachDataSource` (~215 LOC) carries cache + spacing + retry + OAuth-aware error capture; `OlistDataSource` (~200 LOC) carries subprocess lifecycle + stdio transport + AbortSignal composition + lazy connect. **Thin interface, thick adapters** is the trade actually made here, and it pays off twice: (1) the agent layer doesn't have to care whether it's getting cache hits, retry waits, or subprocess starts — the `durationMs` field captures the operational cost; (2) adding a third adapter (a hypothetical OpenAI tool-calling backend, a pure-fixture replay backend for golden-trace tests) doesn't touch the agents.

The opposite — **thick interface, thin adapters** — would push policy up: `DataSource.callToolWithCache(...)`, `DataSource.callToolWithRetry(...)`, `DataSource.startSubprocess(...)`. That interface would be longer than either adapter's *useful* surface, and every new adapter would have to either implement the methods it doesn't care about (Olist faking a cache) or violate the contract (Olist throwing on the cache method). The thin-interface choice keeps the contract honest at the cost of pushing common patterns down into per-adapter code. The repo accepts that cost — see the duplicated `composeSignals` helper in `OlistDataSource` L56–L76 that mirrors the one in `lib/mcp/transport.ts` — and the reason is the agents never want to coordinate cache policy across backends anyway.

### Where it breaks down

**Adding methods is still a commitment.** If a future agent needs `listResources()` (MCP supports it; this codebase doesn't use it yet), the `DataSource` interface must add it, both real adapters must implement it (Bloomreach delegates to `Client.listResources`; Olist either no-ops or throws), and every fake must update. For three methods, cheap. For a surface that mirrors a dozen MCP methods, the interface starts becoming a leaky mirror that tracks every MCP SDK change.

**The interface hides capability — by design.** `DataSource.callTool` collapses the typed result into `Promise<unknown>`. Callers lose the type information and use `unwrap<T>(result)` in `lib/mcp/schema.ts` to recover it. Bloomreach-specific things like cache TTLs (`cacheTtlMs`, `skipCache`) live on the concrete `BloomreachDataSource` class, not on the interface — so route handlers that want to set them have to import the concrete class. That's a deliberate split: the agent layer (read-only EQL queries, never cared about cache TTL) consumes the interface; the dev tooling (`/api/mcp/call`, `/api/mcp/capture`) consumes the concrete class.

**Two adapters can drift in failure semantics.** `BloomreachDataSource` retries on Bloomreach's 429 with a parsed-hint backoff. `OlistDataSource` doesn't retry at all (SQLite never 429s). An agent's failure-handling code can't assume "all DataSource implementations retry rate limits" — that contract isn't in the interface. The repo accepts this by keeping retry-aware logic out of the agent loop and only inside the adapter that needs it.

### What to explore next

- How `BloomreachDataSource`'s cache and rate-limiter sit *inside* the adapter rather than at the interface — they're only possible because the transport is injectable (`04-caching-and-rate-limiting.md`).
- How the four agents each consume the same `DataSource` but build different system prompts and tool schemas (`06-multi-agent-orchestration.md`).
- How `mcp-server-olist` is structured as the "far side" of the Olist adapter — three domain tools, SQLite-backed (`10-authored-mcp-server.md`).
- TypeScript structural typing: understand why a plain `{ callTool, listTools }` object satisfies `DataSource` without `implements DataSource` — search for "duck typing" and "structural vs nominal type systems."

---

## Interview defense

**What they're really asking:** "Do you understand why this code is structured this way, and can you distinguish deliberate design from accidental complexity?"

---

**[mid] Why does `BloomreachDataSource` take a `McpTransport` in its constructor instead of just creating an `SdkTransport` internally? And why does the agent layer depend on `DataSource` rather than on `BloomreachDataSource` directly?**

Two questions, two seams. (1) `BloomreachDataSource` takes the transport because the test can then pass a fake — if it constructs `SdkTransport` internally, the only way to test the cache/spacing/retry logic without a live MCP server is to intercept the `@modelcontextprotocol/sdk` module, which couples tests to the import system. Passing the transport in makes every test a matter of constructing a plain object. (2) The agent layer depends on `DataSource` because, since 2026-06, there are TWO real backends: `BloomreachDataSource` (live HTTPS MCP with OAuth) and `OlistDataSource` (stdio subprocess running an authored MCP server over SQLite). Both adapters satisfy the same three-method `DataSource` interface (`lib/data-source/types.ts` L64–L72), and `makeDataSource(mode, sessionId)` picks one per request based on `bi:mode`. The agents don't know which they got — that's the whole point.

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

**[arch] You now have TWO adapters: BloomreachDataSource over HTTP-MCP-with-OAuth, OlistDataSource over a stdio subprocess. Defend the decision NOT to lift retry / cache / signal composition into the `DataSource` interface.**

The opposing position — lift them up — is the textbook "uniform interface" instinct, and it would push every adapter to either fake those concerns (Olist forced to expose a no-op cache) or violate the contract. The reason the repo kept the interface thin is that the agents don't actually compose backends — they pick one per request and run with it. Lifting policy up only pays off when a caller wants to *coordinate* policy across adapters (e.g., "evict the cache when the subprocess restarts") — which never happens here. The cost paid for thinness is one duplicated helper (`composeSignals` lives in both `lib/mcp/transport.ts` and `lib/data-source/olist-data-source.ts`). The cost paid by the opposite choice would be a `DataSource` interface bigger than either adapter's useful surface. The honest framing: the interface is shaped by the *callers*, not by the *adapters' similarities*. The callers want one method (`callTool`); they get one method.

```
Thin interface (current)            Thick interface (rejected)
┌─────────────────────────┐         ┌──────────────────────────────┐
│ DataSource (3 methods)  │         │ DataSource (15+ methods)     │
│   callTool              │         │   callToolWithCache          │
│   listTools             │         │   callToolWithRetry          │
│   dispose               │         │   getCacheStats              │
│                          │         │   startSubprocess (no-op?)   │
│ → adapters carry policy │         │ → adapters fake or violate    │
│   internally             │         │   methods they don't want    │
└─────────────────────────┘         └──────────────────────────────┘
```

**The dodge: "Isn't this interface just indirection you don't need for one SDK?"**

That dodge worked before 2026-06; it doesn't anymore. The codebase NOW runs two real backends (Bloomreach Engagement in prod, mcp-server-olist for eval), with a runtime switch on `bi:mode = 'live-bloomreach' | 'live-sql'`. The interface is no longer there *just* for the test cases in `base.test.ts` that script response sequences — it's there for the production switch in `app/api/briefing/route.ts` that picks the adapter per request. Honest historical framing: before the Olist work, the abstraction was a maintenance cost paid for testability; after the Olist work, it's load-bearing for two production code paths. The earlier instinct ("you don't need it for one SDK") would have meant rewriting every agent's `mcp` import the day a second backend was wanted. The seam paid off the day it was used.

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
- `lib/data-source/types.ts` L64–L72: the three-method `DataSource` interface — the **upper** seam, the backend-swap port
- `lib/data-source/index.ts` L73–L109: `makeDataSource(mode, sessionId)` — the factory that hides which adapter the route got
- `lib/data-source/bloomreach-data-source.ts` L121: `BloomreachDataSource implements DataSource` — the relocated Bloomreach adapter
- `lib/data-source/olist-data-source.ts` L93–L141: `OlistDataSource implements DataSource` + subprocess spawn — the second adapter
- `lib/mcp/client.ts` L13–L19: the 17-line shim that aliases `BloomreachDataSource` as `McpClient` for zero-callsite-change migration
- `lib/mcp/transport.ts` L7–L10: the **lower** seam — `McpTransport`, the HTTP-SDK swap port (Bloomreach-only)
- `lib/agents/base.ts` L16–L22: `McpCaller`, the historical one-method surface for agents (structurally compatible with `DataSource`)

---

## See also

→ [audit.md](./audit.md) (system-map-and-boundaries lens — `DataSource` upper seam + `McpTransport` lower seam) · [01-request-flow.md](./01-request-flow.md) (now branches on `bi:mode` → `live-sql` vs `live-bloomreach`) · [04-caching-and-rate-limiting.md](./04-caching-and-rate-limiting.md) (cache + retry live INSIDE `BloomreachDataSource`, not at the interface) · [06-multi-agent-orchestration.md](./06-multi-agent-orchestration.md) (agents consume `DataSource`, never a concrete adapter) · [10-authored-mcp-server.md](./10-authored-mcp-server.md) (the far side of `OlistDataSource` — three domain tools over SQLite)

---
