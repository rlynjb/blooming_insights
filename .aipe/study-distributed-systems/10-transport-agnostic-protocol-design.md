# 10 — transport-agnostic protocol design

**Industry name(s):** transport-agnostic protocol · heterogeneous-backend adapter · adapter pattern · subprocess-as-service · JSON-RPC over arbitrary transports
**Type:** Industry standard · Language-agnostic · Project-specific (the `DataSource` seam + `makeDataSource` factory are this codebase's expression of the pattern)

> **Verdict-first:** Phase 2 introduced a second distributed-systems surface — `OlistDataSource` spawns the `mcp-server-olist` Node subprocess and talks to it over stdio. That sounds like local plumbing, but it has the *shape* of a real distributed boundary: a JSON-RPC 2.0 protocol (the same MCP envelope the Bloomreach side uses), an opaque partner that can crash or hang, a per-call timeout, an explicit dispose. The interesting structural fact is that both adapters implement the *same* `DataSource` interface (`callTool`, `listTools`, `dispose`) and return the *same* `{result, durationMs, fromCache}` envelope — agent code doesn't know which backend it's talking to. The `makeDataSource(mode, sessionId)` factory hides the bootstrap asymmetry (HTTP OAuth handshake vs subprocess spawn) and the dispose asymmetry (no-op vs `client.close() + transport.close()`). That's the pattern this file teaches: **one protocol can ride two transports with two failure ontologies behind one interface**, and the discipline of carving the seam at the right altitude is what makes the rest of the codebase short.

---

## Zoom out, then zoom in

```
  Zoom out — the DataSource seam, both adapters under one roof

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  bi:mode (demo | live-sql | live-bloomreach)               │
  │  picks which adapter the route should construct            │
  └─────────────────────────┬────────────────────────────────┘
                            │  ?mode=live-sql | live-bloomreach
                            ▼
  ┌─ Service layer ─────────────────────────────────────────────┐
  │  route handler                                                │
  │     ↓                                                          │
  │  makeDataSource(mode, sid)  ← factory: picks adapter +        │
  │     │                          connects + returns ds + dispose │
  │     │                                                          │
  │  ★ agent loop sees one DataSource type ★    ← we are here      │
  │     │                                                          │
  │     ├──► BloomreachDataSource   (HTTP+SSE, cache, retry)       │
  │     └──► OlistDataSource        (stdio, no cache, 30s timeout) │
  └─────┬──────────────────────────────────────────────┬─────────┘
        │ HTTPS                                         │ stdio (pipe)
        ▼                                               ▼
  ┌─ Bloomreach MCP ────────┐                  ┌─ mcp-server-olist ─┐
  │  remote, OAuth-authed,   │                  │  local child Node   │
  │  rate-limited            │                  │  process,           │
  │  network failure modes   │                  │  SQLite-backed      │
  │                          │                  │  process failure    │
  │                          │                  │  modes              │
  └──────────────────────────┘                  └─────────────────────┘
  same JSON-RPC 2.0 protocol on both sides; same DataSource interface above
```

**Zoom in.** The question this file answers: *what does it cost to support two completely different transports behind one client-facing interface, and what design lets you scale that count without rewriting the callers each time?* The answer is the `DataSource` interface — three methods, one envelope shape, two implementations today, room for N tomorrow. The factory pattern (`makeDataSource`) hides the construction asymmetries that *do* differ across adapters; everything else flows from the interface.

---

## Structure pass

**Layers.** Four. **Caller** (agent loop or route handler — holds a `DataSource` reference, never a concrete adapter). **Interface** (`DataSource` — three methods + envelope type). **Adapter** (`BloomreachDataSource` or `OlistDataSource` — handles partial failure, caching, lifecycle in transport-appropriate ways). **Transport + remote** (HTTP+SSE to Bloomreach, stdio pipe to mcp-server-olist child).

**Axis: what varies, what stays constant.** Hold one question across all layers: *what does the caller care about, and what can the adapter freely change without breaking the caller?* The **caller** cares about: tool name, args, abort signal, `{result, durationMs, fromCache}` envelope, the typed error class shape (an error object the route can stringify). The **caller does not care about**: transport, auth scheme, rate-limit window, cache TTL, retry budget, subprocess lifecycle. The interface picks the cut deliberately — keep `result` as `unknown` so adapters can return arbitrary MCP shapes, expose `fromCache` for diagnostics, hide everything else.

**Seams.** Two real, one absent.

- **Seam A: caller ↔ DataSource.** The interface boundary. Caller passes a tool name, args, optional abort signal; gets back the envelope. Same signature regardless of backend. Failure surfaces as a typed error subclass (`McpToolError` or `OlistToolError`) — different classes, but both have `toolName` + `detail`, so the route can render them uniformly.
- **Seam B: DataSource ↔ transport.** Adapter-internal. The Bloomreach adapter holds an `McpTransport` (the SDK transport wrapping fetch + SSE + OAuth). The Olist adapter holds a `Client` + `StdioClientTransport`. Both are MCP SDK objects; both speak JSON-RPC 2.0 framed differently. This seam is where the adapter's transport-specific work lives.
- **Seam: factory ↔ adapter-construction details** — *not absent, but partial*. The factory `makeDataSource` hides bootstrap differences (Bloomreach: `connectMcp` → OAuth handshake → may return `{ok: false, authUrl}`; Olist: `new OlistDataSource()` → lazy spawn). But it does NOT hide the schema-bootstrap asymmetry — that lives in the factory's `bootstrap` field, with two completely different implementations (live MCP discovery vs synthesized static schema). Worth knowing where the asymmetry leaks.

```
  Structure pass — the layers + what each owns

  ┌─ caller (agent loop, route handler) ────────────────┐
  │  owns: tool name, args, AbortSignal, the prompt      │
  │  consumes: {result, durationMs, fromCache}           │
  │  does NOT see: transport, auth, retry, cache, child  │
  │                process — anything backend-specific   │
  └────────────────┬────────────────────────────────────┘
                   │  DataSource interface (3 methods)
  ┌────────────────▼────────────────────────────────────┐
  │  DataSource — the seam                              │
  │  callTool(name, args, opts?) → DataSourceCallResult │
  │  listTools(opts?) → unknown                         │
  │  (no dispose on the abstract interface — it lives   │
  │   on the concrete adapter; the factory result       │
  │   exposes a uniform dispose())                      │
  └────────────────┬────────────────────────────────────┘
                   │  implementations differ
       ┌───────────┴────────────┐
       ▼                        ▼
  ┌─ Bloomreach... ─┐  ┌─ Olist... ──────────┐
  │ cache + retry +  │  │ subprocess + per-    │
  │ spacing + auth   │  │ call AbortSignal +   │
  │ via cookie       │  │ idempotent connect + │
  │                  │  │ explicit dispose     │
  └─────┬────────────┘  └─────┬────────────────┘
        │ HTTPS+SSE           │ stdio (pipe)
        ▼                     ▼
  ┌─ Bloomreach ─┐         ┌─ olist subproc ─┐
  └───────────────┘         └─────────────────┘
  (same MCP/JSON-RPC 2.0 protocol on both transports)
```

The seam is at the right altitude. Cutting it lower (e.g. "share the retry logic across adapters") would force adapters to fit a partial-failure shape that doesn't match their transport. Cutting it higher (e.g. "give the caller the raw MCP `Tool` shape") would couple callers to MCP and make a future non-MCP adapter impossible.

---

## How it works

### Move 1 — the mental model

You already know `interface Repository { find(id), save(doc) }` with a `PostgresRepository` and an `InMemoryRepository`. Same idea — one interface, two implementations, callers don't care which one's wired up. The twist here is that the two implementations don't just differ in *where* the data lives (one process vs another) — they differ in *what can go wrong on the way to the data*. So the adapter has to take on partial-failure work itself, in a transport-appropriate shape.

```
  The pattern — same interface, two failure ontologies

  ┌─ DataSource (interface) ───────────────────────────────┐
  │   callTool(name, args, opts?) → {result, durationMs,   │
  │                                  fromCache}            │
  │   listTools(opts?) → unknown                            │
  └────────────────┬───────────────────────────────────────┘
                   │ implementations
       ┌───────────┴─────────────┐
       ▼                         ▼
   network failure              process failure
   (429, 401, hang, TLS)        (spawn err, EPIPE, crash)
       │                         │
       ▼                         ▼
   retry-with-parsed-window     per-call AbortSignal.timeout
   60s response cache           no cache (cheap round-trip)
   ~1 req/s spacing             idempotent connect (spawn once)
   no per-call timeout (GAP)    explicit dispose
   no respawn (irrelevant)      no respawn on crash (GAP)

  same envelope shape returned to caller;
  same error-class shape (Error subclass with .toolName / .detail);
  different partial-failure toolkit inside.
```

The principle: **the interface promises what the caller can rely on; the adapter does whatever transport-appropriate work is needed to deliver that promise**.

### Move 2 — the moving parts

#### Part 1 — the interface itself: three methods + one envelope

The `DataSource` interface (`lib/data-source/types.ts:64-72`) is deliberately tiny — three things the agent loop actually uses. Adding methods to the interface forces both adapters to grow; that pressure is the right kind. The envelope `{result, durationMs, fromCache}` matches what `McpClient` returned pre-Phase-2 exactly, so the seam was extracted without behavior change.

```
  The DataSource interface — kernel

  interface DataSource {
    callTool(name, args, opts?) → Promise<{
      result: unknown;        ← MCP result envelope; opaque to interface
      durationMs: number;     ← wall-clock from adapter; for tracing
      fromCache: boolean;     ← true if served without remote round-trip
    }>;
    listTools(opts?) → Promise<unknown>;
  }

  load-bearing choices:
    result is unknown        — adapter can return any shape; caller narrows
    durationMs is on every    — uniform tracing across heterogeneous backends
      result envelope
    fromCache is on every     — caller can show "served from cache" badge
      result envelope            (Olist always returns false → cosmetic ok)
    dispose() is NOT on        — disposal is concrete-class concern; factory
      the interface             surfaces a uniform dispose() on the result
```

Boundary condition: `result: unknown` means callers must `unwrap<T>(result)` (in `lib/mcp/schema.ts`) to get a typed value. The cost is type-narrowing at call sites; the benefit is the interface stays protocol-agnostic — a future SQL-direct adapter wouldn't even have an MCP envelope, and `result` could be a row set.

#### Part 2 — the two adapters with two failure ontologies

The adapters are where the transport-specific work lives. Same shape (`callTool` / `listTools`), completely different internals.

```
  BloomreachDataSource — the HTTP+SSE adapter
  (lib/data-source/bloomreach-data-source.ts)

  state:        cache Map; lastCallAt; retry/spacing knobs
  on callTool:  cache hit? return immediately
                else liveCall (with ~1s spacing)
                while result is rate-limited and retries < budget:
                  parse server's "Retry after N" hint
                  sleep min(hint + 500ms, ceiling)
                  liveCall again
                cache success result (60s TTL); NEVER cache errors
                return envelope
  on listTools: pass through to transport.listTools (no cache)
  failure: HTTP 200 + isError envelope (rate limit) OR thrown
           McpToolError (transport-level: 401, network, 5xx)


  OlistDataSource — the stdio adapter
  (lib/data-source/olist-data-source.ts)

  state:        Client + StdioClientTransport (lazy); connectPromise
  on callTool:  ensure connect() (idempotent; spawns child ONCE)
                signal = composeSignals(opts?.signal,
                                        AbortSignal.timeout(30_000))
                client.callTool(..., { signal })
                catch err: throw OlistToolError(name, ...)
                return envelope with fromCache: false
  on listTools: ensure connect(); client.listTools(...)
  on dispose:   client.close() (best-effort); transport.close()
                                       (best-effort); reset to null
  failure: spawn error (entry not found, throws); EPIPE (child closed);
           AbortSignal.timeout fires (request canceled);
           any of the above wrapped in OlistToolError
```

The lesson surfaces in the table: where the Bloomreach adapter has retry + cache + spacing, the Olist adapter has timeout + idempotent-connect + dispose. Neither is wrong; each fits its transport. The interface above stays unchanged.

#### Part 3 — the factory that hides bootstrap asymmetry

`makeDataSource(mode, sessionId)` (`lib/data-source/index.ts:73-109`) is the one place that knows about both adapters. It picks the constructor, runs the bootstrap, and returns a uniform result envelope to the route handler.

```
  makeDataSource — pseudocode of the factory

  function makeDataSource(mode, sessionId):
    if mode === 'live-sql':
      ds = new OlistDataSource()
      await ds.connect()                   ← spawns subprocess
      return {
        ok: true,
        mode,
        dataSource: ds,
        bootstrap: async () => olistWorkspaceSchema(),  ← synthesized
        dispose:   () => ds.dispose(),                  ← real cleanup
      }
    // mode === 'live-bloomreach'
    conn = await connectMcp(sessionId)     ← OAuth handshake; may fail
    if !conn.ok:
      return { ok: false, authUrl: conn.authUrl }   ← route can redirect
    return {
      ok: true,
      mode,
      dataSource: conn.mcp,
      bootstrap: (signal) => bootstrapSchema(conn.mcp, { signal }),
                                            ← 4 live MCP calls
      dispose:   async () => {},            ← no-op (cookie owns it)
    }

  what the route sees:
    same envelope shape {ok, mode, dataSource, bootstrap, dispose} OR
    {ok: false, authUrl} on the Bloomreach OAuth-failed path.

  what's symmetric:
    dataSource (DataSource), bootstrap (() → Promise<WorkspaceSchema>),
    dispose (() → Promise<void>)
  what's asymmetric (hidden inside the factory):
    Olist: spawn subprocess at construction; synthesized schema; real dispose
    Bloomreach: OAuth handshake; live schema discovery; no-op dispose
                (cookie-scoped, outlives the request)
```

The asymmetry has to live somewhere. The factory absorbs it; the route handler just calls `await result.bootstrap(signal)` and `await result.dispose()`, identical code regardless of mode.

#### Part 4 — JSON-RPC 2.0 as the protocol both transports carry

Both adapters speak MCP, which is JSON-RPC 2.0 under the hood. The SDK handles framing differently per transport — newline-delimited frames on stdio, SSE event payloads over HTTP — but the request/response shapes are the same. Once a frame arrives at the SDK's client, the upper layer reads `{result, error}` identically whether it came from the network or a pipe.

```
  JSON-RPC over two transports — same protocol, different framing

  Bloomreach side (HTTP+SSE):
    POST /mcp  →  StreamableHTTPClientTransport
       body: { jsonrpc: "2.0", id: 7, method: "tools/call",
               params: { name: "...", arguments: {...} } }
       response (SSE event): { jsonrpc: "2.0", id: 7, result: {...} }

  Olist side (stdio):
    write to child stdin:  StdioClientTransport
       line: {"jsonrpc":"2.0","id":7,"method":"tools/call",
              "params":{"name":"...","arguments":{...}}}\n
       read from child stdout:
       line: {"jsonrpc":"2.0","id":7,"result":{...}}\n

  same id, same method, same params; same result shape on the way back.
  the framing is the transport's job; the SDK normalizes.
```

The right next move IF we added a third backend (say, a WebSocket-based MCP server, or a Lambda-backed REST endpoint with MCP framing): a new adapter that implements `DataSource`, plus one new arm in `makeDataSource`. Nothing in the agent layer changes.

#### Part 5 — what NOT YET EXERCISED looks like

```
  things NOT YET EXERCISED at this lens

  - more than two adapters
    only Bloomreach + Olist today; the interface is shaped for N

  - hot-swap mid-session
    a user can switch bi:mode but only between requests; no live
    swap of the running adapter on a single request

  - adapter-level circuit breaker
    if Bloomreach is degraded, no automatic switch to Olist; the
    user picks the mode via bi:mode

  - protocol versioning across adapters
    both adapters speak the same MCP version today; the day the
    upstream MCP spec changes, both have to upgrade together or
    the interface needs a compatibility shim

  - composing adapters (caching, logging, replay layers)
    no decorator pattern wrapping a DataSource with a different
    DataSource (e.g. a "logging DataSource" that wraps either
    adapter). The shape supports this; nothing currently uses it.
```

The composability piece is the most interesting one for the future. A decorator like `new LoggingDataSource(bloomreachDs)` could add structured logging around every call without modifying the adapter. The seam is shaped for it; the use case hasn't arrived.

### Move 3 — the principle

**Pick the interface so the caller cares about the right things, then let each backend's adapter do whatever transport-appropriate work the interface promises.** The right altitude is the one where the same three method signatures can carry an HTTP-OAuth-cached-retrying adapter, a subprocess-spawning-timing-out adapter, and (hypothetically) a SQL-direct or REST-only adapter — and the caller above the interface doesn't know which one's live. The wrong altitude either leaks implementation details up (the agent loop would have to know what a 429 looks like) or forces shared mechanism down (every adapter must have a cache, even one where caching makes no sense). The DataSource interface in this codebase is at the right altitude because: (a) callers only care about `{result, durationMs, fromCache}` and a typed error class, (b) every adapter can express its partial-failure story without contortion, and (c) the factory absorbs the bootstrap and dispose asymmetries that genuinely don't fit the same shape.

---

## Primary diagram

```
  Transport-agnostic protocol design — full picture

  ┌─ agent loop (lib/agents/base.ts) ─────────────────────────────────┐
  │  holds:  dataSource: DataSource                                     │
  │  calls:  await dataSource.callTool(name, args, { signal })          │
  │  reads:  result.result (unknown), result.durationMs                 │
  │  knows nothing about backend                                        │
  └─────────────────────────────┬─────────────────────────────────────┘
                                ▼
  ┌─ DataSource interface (lib/data-source/types.ts) ─────────────────┐
  │  callTool(name, args, opts?) → {result, durationMs, fromCache}    │
  │  listTools(opts?) → unknown                                        │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │  picked by makeDataSource(mode, sid)
       ┌────────────────────────┴────────────────────────────┐
       ▼                                                      ▼
  ┌─ BloomreachDataSource ──────────┐                ┌─ OlistDataSource ──────────────┐
  │ (lib/data-source/                │                │ (lib/data-source/               │
  │  bloomreach-data-source.ts)      │                │  olist-data-source.ts)          │
  │                                  │                │                                 │
  │  callTool:                       │                │  callTool:                      │
  │    cache check → hit? return     │                │    await connect()              │
  │    liveCall (with ~1s spacing)   │                │      ← lazy; spawns once;       │
  │    retry-on-rate-limit loop:     │                │        idempotent under         │
  │      parse hint, sleep, retry    │                │        concurrent first calls   │
  │    cache success (60s); never    │                │    signal = composeSignals(     │
  │      cache errors                │                │      opts.signal,               │
  │    return envelope                │                │      AbortSignal.timeout(30s)) │
  │                                  │                │    client.callTool(..., signal) │
  │  state: cache Map, lastCallAt,   │                │    catch: OlistToolError        │
  │         retry knobs              │                │    return {..., fromCache:false}│
  │                                  │                │                                 │
  │  failure modes:                  │                │  state: Client, transport,      │
  │   - 429 in body → retry          │                │         connectPromise          │
  │   - 401/5xx/network → throw      │                │                                 │
  │     McpToolError                 │                │  failure modes:                 │
  │   - hang → eats route's 300s     │                │   - spawn error → connect()     │
  │     budget (gap)                 │                │     throws                      │
  │                                  │                │   - EPIPE / child crash → throw │
  │                                  │                │     OlistToolError              │
  │                                  │                │   - 30s timeout → throw         │
  │                                  │                │     OlistToolError              │
  └─────────┬────────────────────────┘                └─────────┬───────────────────────┘
            │ HTTP+SSE (JSON-RPC frames over SSE)               │ stdio (JSON-RPC frames
            ▼                                                    ▼  over newline-delimited
  ┌─ Bloomreach MCP (remote, OAuth-authed) ─┐         ┌─ mcp-server-olist subprocess ┐
  │  ~1 req/s/user GLOBAL                    │         │  Node child process            │
  │  token revokes after minutes             │         │  reads SQLite read-only        │
  │  429 with retry hint in body             │         │  three tools (read-only)       │
  └──────────────────────────────────────────┘         └────────────────────────────────┘

  factory + result envelope (lib/data-source/index.ts):
    makeDataSource(mode, sid) → MakeDataSourceResult
      = { ok: true, mode, dataSource, bootstrap, dispose }
      | { ok: false, mode: 'live-bloomreach', authUrl }
    route handler calls `result.dispose()` in finally — uniform regardless of mode.
```

---

## Implementation in codebase

**Use cases.**
- The agent loop in `lib/agents/base.ts` calls `dataSource.callTool(name, args, { signal })` and reads `{result, durationMs, fromCache}`. The same code runs whether the user is in `live-bloomreach` mode (HTTP+SSE to the remote MCP server) or `live-sql` mode (stdio to the local subprocess). Adding a new backend wouldn't require touching the agent at all.
- The briefing route (`app/api/briefing/route.ts:160-189`) decides which adapter to use based on `?mode=`, calls `makeDataSource(mode, sid)`, then runs the same `bootstrap()` → `monitoringAgent.runScan(...)` pipeline regardless of mode. The `finally` block calls `dsResult.dispose()` — no-op for Bloomreach (cookie-scoped client), real subprocess cleanup for Olist.
- The factory's `ok: false` branch lets the Bloomreach OAuth-expired path bubble up as `{ ok: false, authUrl }` so the route handler can redirect the browser. The Olist branch never returns `ok: false` (no auth to fail), keeping the route's error-handling simple but the factory's union type accommodates both.

**Code side by side.**

```
  lib/data-source/types.ts  (lines 38-72)

  export interface DataSourceCallOptions {
    signal?: AbortSignal;
  }                                                    ← minimal; only what
                                                          the agent passes today
  export interface DataSourceCallResult {
    result: unknown;                                  ← protocol-agnostic;
    durationMs: number;                                  callers narrow as needed
    fromCache: boolean;                                ← cosmetic on Olist
  }

  export interface DataSource {
    callTool(
      name: string,
      args: Record<string, unknown>,
      opts?: DataSourceCallOptions,
    ): Promise<DataSourceCallResult>;

    listTools(opts?: DataSourceListOptions): Promise<unknown>;
  }
       │
       └─ this IS the seam. Three method signatures, one envelope. Adding
          a property to the envelope forces every adapter to provide it;
          that pressure keeps the surface small. Note: no dispose() here —
          disposal is a concrete-class concern, and the factory result
          exposes the uniform dispose() instead.
```

```
  lib/data-source/olist-data-source.ts  (lines 93-141, 176-196)

  export class OlistDataSource implements DataSource {
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private connectPromise: Promise<void> | null = null;
    // ...

    /** Lazy-connect on first use. Idempotent — concurrent callers share
     *  one in-flight promise so the subprocess is spawned exactly once. */
    async connect(): Promise<void> {
      if (this.client) return;                       ← fast-path: already up
      if (this.connectPromise) return this.connectPromise;  ← join in flight
      this.connectPromise = this.doConnect();
      try { await this.connectPromise; }
      finally { this.connectPromise = null; }
    }

    private async doConnect(): Promise<void> {
      if (!existsSync(this.serverEntry)) {
        throw new Error(
          `OlistDataSource: server entry not found at ${this.serverEntry}.
           Run 'npm run build' in mcp-server-olist/ first.`,
        );                                           ← clear pre-spawn error
      }
      const transport = new StdioClientTransport({
        command: this.nodeExecutable,                ← node binary
        args: [this.serverEntry],                    ← the built JS entry
        stderr: 'inherit',                           ← child stderr → parent
      });                                               (so logs reach us; stdio
                                                        reserved for protocol)
      const client = new Client(
        { name: 'blooming-insights-olist-adapter', version: '0.1.0' },
        { capabilities: {} },
      );
      await client.connect(transport);               ← MCP handshake over stdio
      this.transport = transport;
      this.client = client;
    }

    /** Tear down the subprocess + client cleanly. Idempotent. */
    async dispose(): Promise<void> {
      const client = this.client;
      const transport = this.transport;
      this.client = null;
      this.transport = null;                         ← reset BEFORE close,
      if (client) {                                     so re-entry is safe
        try { await client.close(); }
        catch { /* best-effort */ }
      }
      if (transport) {
        try { await transport.close(); }
        catch { /* best-effort */ }
      }
    }
  }
       │
       └─ the subprocess lifecycle is right here: lazy spawn (one child per
          instance, exactly once under concurrency), explicit dispose with
          state-reset-before-close so a re-disposed instance doesn't
          double-close. The "best-effort" catches are intentional — there's
          nothing useful for the route handler to do if a teardown fails;
          surfacing the error would just noise the cleanup path.
```

```
  lib/data-source/index.ts  (lines 73-109)

  export async function makeDataSource(
    mode: LiveMode,
    sessionId: string,
  ): Promise<MakeDataSourceResult> {
    if (mode === 'live-sql') {
      const ds = new OlistDataSource();
      await ds.connect();                            ← spawn at construction
      return {
        ok: true,
        mode,
        dataSource: ds,
        bootstrap: async () => olistWorkspaceSchema(),  ← synthesized;
                                                           Olist has no
                                                           schema discovery
                                                           tools
        dispose: () => ds.dispose(),                 ← real subprocess kill
      };
    }
    // live-bloomreach — defer to the existing connect path.
    const conn: ConnectResult = await connectMcp(sessionId);
    if (!conn.ok) {
      return { ok: false, mode, authUrl: conn.authUrl };  ← route redirects
    }
    return {
      ok: true,
      mode,
      dataSource: conn.mcp,
      bootstrap: (signal?: AbortSignal) =>
        bootstrapSchema(conn.mcp, { signal }),       ← live MCP discovery
      dispose: async () => {},                       ← no-op; cookie owns
                                                        the session
    };
  }
       │
       └─ the factory is the ONE place that knows both adapters exist.
          It hides three asymmetries: (1) construction (spawn vs OAuth
          handshake), (2) bootstrap (synthesized vs live discovery),
          (3) dispose (real vs no-op). The route handler downstream
          gets a uniform envelope and writes one `finally` block
          regardless of mode.
```

---

## Elaborate

The pattern of "one interface, N transport-specific adapters" predates this codebase by decades — `java.sql.Connection` over JDBC drivers, Go's `io.Reader` over file/network/buffer, Python's `requests` Session adapter mechanism. What's *interesting* in blooming insights is that the two adapters don't just have different transports — they have completely different *failure ontologies*. The HTTP adapter deals with rate limits and tokens; the stdio adapter deals with subprocess lifecycle and broken pipes. They share zero partial-failure code, and that's the right call — forcing them to share would push the abstraction up a layer where it would handle neither well.

The trick is also how the factory absorbs construction asymmetry. The `MakeDataSourceResult` union (`ok: true` with bootstrap + dispose, `ok: false` with authUrl) is a small but important piece of design — without it, the Bloomreach OAuth path would have to throw to signal "you need to redirect," which would couple the route's error handling to the auth flow. By making the failure typed (the union arm), the route handles auth-redirect as a normal result.

The right next move IF the codebase grows to N>2 adapters: a registry pattern (`adapterRegistry.register('live-sql', factory)`) and a decoupled construction path. Today, the `if/else` in `makeDataSource` is fine — two adapters, two arms. At five adapters, the if/else becomes the smelly part and the registry is the refactor.

One observation worth keeping: the `dispose` placement matters. It's NOT on the `DataSource` interface because the abstract surface should describe what callers *use* the data source for (calling tools, listing tools), not its lifetime. The lifetime is owned by whoever constructed it — the factory in this case — and exposed on the factory's *result envelope*, not the interface. Putting `dispose` on the interface would force every adapter to implement one even when its lifetime is owned by something else (like the Bloomreach cookie-scoped client).

---

## Interview defense

**Q: You have two completely different backends — one HTTPS, one a local subprocess. How do you keep the agent code from having to know which one's live?**

The `DataSource` interface — three methods, one envelope, and a uniform `{result, durationMs, fromCache}` shape. Both adapters implement it. The `makeDataSource(mode, sessionId)` factory picks the implementation, runs the construction (which is asymmetric — OAuth handshake for one, subprocess spawn for the other), and returns a uniform result envelope to the route handler. The agent loop holds a `DataSource` reference and calls `callTool`; it has no idea whether the call is going over HTTPS or over a Unix pipe to a child process.

```
  the seam

  agent loop  ──────►  DataSource (interface)
                          │
                ┌─────────┴─────────┐
                ▼                   ▼
         BloomreachDataSource   OlistDataSource
         (HTTP+SSE, cache,      (stdio, subprocess,
          retry-on-429)          per-call 30s timeout)
                │                   │
                ▼                   ▼
         remote MCP server     child Node process
```

**Q: Why isn't dispose on the DataSource interface?**

Because disposal is a lifetime concern, not a usage concern. The agent loop *uses* the data source (callTool, listTools); it doesn't own the data source's lifetime. The factory owns construction; the factory's result envelope exposes dispose. Putting dispose on the interface would force every adapter to have one even when its lifetime is owned externally — the Bloomreach client outlives any single request via the cookie-scoped auth store, so its dispose is genuinely a no-op. The interface stays clean; the factory result handles the asymmetry.

**Q: What's the load-bearing piece of the Olist adapter that people forget?**

The idempotent `connect()`. Concurrent callers under the first call share one in-flight promise, so the subprocess is spawned exactly once. Without the `connectPromise` field guarding `doConnect()`, two simultaneous `callTool` calls on a fresh adapter would race to spawn two subprocesses — and one of them would lose, leaving a leaked child or a confused MCP client state. The pattern (lazy + idempotent + concurrency-safe) is a small primitive that appears everywhere distributed work touches a child process.

```
  the idempotent-connect pattern

  if this.client: return                  ← fast-path
  if this.connectPromise: return promise  ← join in flight
  this.connectPromise = doConnect()       ← claim the slot
  try await; finally clear promise

  three guards = exactly-once spawn under N concurrent first calls
```

---

## Validate

- **Reconstruct.** Without looking, write the `DataSource` interface. Name what's on it, what's NOT (and why), and what the envelope shape is. Now describe how `BloomreachDataSource.callTool` and `OlistDataSource.callTool` differ in their failure handling.
- **Explain.** Why does `makeDataSource` (`lib/data-source/index.ts:73-109`) have an `ok: false` arm for `live-bloomreach` but not for `live-sql`? Because the Bloomreach branch can fail at OAuth (token expired, never authorized) — that's a genuine "redirect the browser to re-auth" failure mode. The Olist branch has no auth, so the only failure modes are spawn errors (which throw, not return false). The union type encodes this asymmetry.
- **Apply.** A new requirement: add a third adapter for a REST-only analytics provider (no MCP, no JSON-RPC). Walk through the changes. (Define a third adapter class implementing `DataSource`; the `callTool` body translates the MCP-style call to REST + back to the envelope. Add a third arm in `makeDataSource` for the new mode. The agent layer changes zero lines. The mock-test surface is the same — `DataSource` is mockable.)
- **Defend.** Why share zero partial-failure code between the two adapters? Because their transports' failure ontologies are fundamentally different — retry-with-parsed-window is meaningful for HTTP 429s but meaningless for an EPIPE; per-call `AbortSignal.timeout` is meaningful for a hanging subprocess but redundant for HTTP if there's already a retry budget. Forcing shared mechanism would either force one side to over-engineer (Bloomreach: per-call timeout it doesn't need yet) or force the other to under-engineer (Olist: a retry loop that can't help). The right unit of reuse is the *interface*, not the mechanism.

---

## See also

- `01-distributed-system-map.md` — Seam C (Bloomreach HTTP) and Seam F (Olist subprocess) in the map
- `02-partial-failure-timeouts-and-retries.md` — the asymmetric partial-failure stories per adapter
- `03-idempotency-deduplication-and-delivery-semantics.md` — the asymmetric cache (Bloomreach: 60s TTL; Olist: none)
- `04-consistency-models-and-staleness.md` — the asymmetric staleness contract
- `06-queues-streams-ordering-and-backpressure.md` — JSON-RPC framing over stdio is the second framed stream in the codebase
- `09-distributed-systems-red-flags-audit.md` — RISK 10 (subprocess lifecycle hazards)
- `.aipe/study-system-design/` — the DataSource seam from an architectural-shape perspective
- `.aipe/study-software-design/` — the same seam from a deep-modules / information-hiding perspective

---
Updated: 2026-06-16 — Initial generation as the Phase 2 concept file. Covers the DataSource interface, the makeDataSource factory, the two-adapter shape with asymmetric failure ontologies, subprocess lifecycle as a distributed primitive, and JSON-RPC 2.0 over arbitrary transports.
