# 01 — the port (`DataSource`) and its two adapters

## Subtitle

Ports and adapters · dependency inversion · the deep module — *Industry standard (Hexagonal Architecture)*.

## Zoom out — where this concept lives

Before we dive in, here's where the port sits in the whole system. The agents talk to it from above; the live MCP server and the in-process fixture live below. Everything in between is the port's body.

```
  Zoom out — the DataSource seam in the system

  ┌─ Agent layer (the client) ──────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent│
  │  QueryAgent (each holds a `DataSource`, not an adapter) │
  └────────────────────────────┬────────────────────────────┘
                               │  callTool(name, args, {signal})
                               │  listTools({signal})
  ┌─ The port (★ THIS CONCEPT ★) ─────────▼────────────────┐
  │  interface DataSource                                   │ ← we are here
  │    2 methods · 1-line option type                       │
  └────────────────────────────┬────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
  ┌─ Adapter (live) ──────────┐    ┌─ Adapter (fixture) ──────────┐
  │  BloomreachDataSource     │    │  SyntheticDataSource         │
  │  OAuth · 60s cache ·      │    │  in-process 30-tool switch · │
  │  1 req/s spacing ·        │    │  realistic envelope shapes · │
  │  retry ladder · timeout   │    │  no network                  │
  │  (216 LOC)                │    │  (516 LOC)                   │
  └────────────────┬──────────┘    └──────────────────────────────┘
                   │  StreamableHTTPClientTransport (HTTP+OAuth)
                   ▼
  ┌─ Outside the boundary ──────────────────────────────────┐
  │  Bloomreach loomi connect MCP server                    │
  └─────────────────────────────────────────────────────────┘
```

## Zoom in — what it is

You know how a `fetch()` returns the same `Response` whether the URL is `localhost:3000` or `api.bloomreach.com`? Same idea. The agent layer doesn't know whether it's talking to a real MCP server over OAuth or to deterministic in-process fakes — it sees a `DataSource` either way. The runtime mode (`?mode=live-bloomreach` vs `?mode=live-synthetic`) picks the adapter; the call site never branches.

The pattern's industry name is **ports and adapters** (sometimes "hexagonal architecture"). The standard role-vocabulary:

```
  port      the interface · the swap point this codebase owns
            → `DataSource` (lib/data-source/types.ts:63)
  adapter   an implementation of the port; adapts an outside thing
            → `BloomreachDataSource` (live MCP)
            → `SyntheticDataSource` (fixture)
  client    code that depends on the port and calls it
            → the four agent classes + bootstrapSchema
  factory   selects + constructs an adapter, returns it as the port
            → `makeDataSource(mode, sessionId)` in lib/data-source/index.ts
  DI        dependency injection — passing the adapter in as a parameter
            → route handlers pass the result of `makeDataSource` into agents
  DIP       dependency inversion — clients depend on the port, not the adapter
            → no agent file imports `BloomreachDataSource` or `SyntheticDataSource`
```

Four words and you have it: port · adapter · client · seam. After first mention, the local name (`DataSource`) alone is fine.

## Structure pass — layers · axes · seams

Three layers stack here: the **clients** (agents + bootstrap), the **port** (interface), the **adapters** (concrete data sources). Hold one axis still and watch the answer change as you descend.

**Axis = dependency direction.**

```
  Trace "what does each layer depend on?" down the stack

  ┌─ clients (agents) ───────────┐
  │  depend on: DataSource (port)│   → upward arrow points at port
  └───────────────┬──────────────┘
                  │  ↑ DIP — never imports an adapter
                  ▼
  ┌─ port (interface) ───────────┐
  │  depends on: NOTHING         │   → a pure type declaration
  └───────────────┬──────────────┘
                  │
                  ▼
  ┌─ adapters ───────────────────┐
  │  depend on: DataSource (port)│   → upward arrow ALSO points at port
  │  + transport / fixture data  │
  └──────────────────────────────┘
                  ▲
        Both sides point AT the port. Neither side points AT each other.
        That's dependency inversion in one picture.
```

The seams: **the upper seam** (clients ↔ port) and **the lower seam** (port ↔ adapters). The load-bearing axis — what *flips* at each seam — is the `result` type. Above the port, `result: unknown` (the agent loop calls `unwrap<T>(result)` at each call site to narrow). Inside `BloomreachDataSource`, the result is whatever the MCP SDK returned (typed but adapter-specific). Inside `SyntheticDataSource`, the result is a hand-built `{ structuredContent, content: [{ type: 'text', text: ... }] }` envelope that imitates the SDK's shape. The port hides which side built it.

## How it works

### Move 1 — the mental model

A port is a wall socket. Anything with the right plug fits — a lamp, a toaster, a phone charger. The wall doesn't care which appliance is on the other end; the appliance doesn't care which generator powers the grid. The socket is the contract.

Here's the literal shape of the pattern in this repo:

```
  The port pattern — one interface, two adapters, swappable at runtime

         ┌──────────────────────────────────────────┐
         │              the four agents             │
         │      (clients holding a DataSource)      │
         └──────────────────┬───────────────────────┘
                            │ depends on
                            ▼
              ┌──────────────────────────────┐
              │  DataSource interface (port) │
              │    callTool / listTools      │
              └─┬──────────────────────────┬─┘
   implemented  │                          │   implemented
       by      ▼                            ▼      by
  ┌─────────────────────┐    ┌─────────────────────────┐
  │ BloomreachDataSource│    │  SyntheticDataSource    │
  │     (live)          │    │      (fixture)          │
  └─────────────────────┘    └─────────────────────────┘

       ↑ neither adapter depends on the other.
         neither knows the other exists.
```

Five lines of TypeScript define the contract. Two adapter classes — 216 LOC + 516 LOC — implement it. The four agent classes hold the port; none of them ever names a concrete adapter. The factory `makeDataSource(mode, sessionId)` is the one place in the repo that names both concrete classes by string.

### Move 2 — the step-by-step walkthrough

#### Part 1 — the port (the smallest part, the load-bearing one)

This is the smallest part of the pattern. It's also the load-bearing one — change this interface and every adapter and every client has to change. **Five lines of TypeScript that the rest of the file hangs off:**

```ts
// lib/data-source/types.ts:63-71
export interface DataSource {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult>;

  listTools(opts?: DataSourceListOptions): Promise<unknown>;
}
```

What's on the surface:

  → `callTool(name, args, opts?)` — the agent invokes one tool. `opts.signal` is the cancellation handle.
  → `listTools(opts?)` — the agent enumerates tools (used once at bootstrap to build the schema the model sees).
  → `DataSourceCallResult = { result: unknown; durationMs: number; fromCache: boolean }` — the result envelope mirrors `BloomreachDataSource.callTool` exactly so the rename from `McpClient` did not change behaviour (the comment at lines 12-13 names this on purpose).

What's NOT on the surface:

  → No `skipCache` / `cacheTtlMs` (cache-control is Bloomreach-specific; lives only on `BloomreachDataSource`).
  → No `connect()` / `dispose()` (lifecycle lives in the factory result).
  → No protocol vocabulary — no `Transport`, no `OAuth`, no `Client`.

Drop any of these and the pattern still survives. Add any of them to the port and the synthetic adapter has to grow a no-op stub. **The smallest-thing-that-still-is-the-pattern is exactly this.**

#### Part 2 — the adapter (the live one)

`BloomreachDataSource` in `lib/data-source/bloomreach-data-source.ts:121-214` is the adapter that wraps the connected MCP SDK transport. Its public surface implements the port; its private surface holds the four things the port deliberately hides:

```
  Layers-and-hops — what BloomreachDataSource.callTool does

  ┌─ agent ──┐  callTool("execute_analytics_eql", {project_id, eql}, {signal})
  │ (client) │ ──────────────────────────────────────────────────────────►
  └──────────┘
                                                              ┌─ adapter ─────────────┐
                                                              │ 1. check cache (60s)  │
                                                              │ 2. wait ~1 req/s gate │
                                                              │ 3. compose abort:     │
                                                              │    signal + 30s timeout│
                                                              │ 4. call SDK transport │
                                                              │ 5. detect rate-limit  │
                                                              │ 6. parse retry hint   │
                                                              │ 7. sleep + retry x3   │
                                                              │ 8. cache success      │
                                                              │ 9. throw McpToolError │
                                                              │    on transport throw │
                                                              └───────────┬───────────┘
                                                                          │  HTTPS + OAuth Bearer
                                                                          ▼
                                                              ┌─ Bloomreach MCP ─────┐
                                                              │  loomi connect alpha │
                                                              └──────────────────────┘
```

Annotated, the load-bearing arms:

```ts
// lib/data-source/bloomreach-data-source.ts:139-188 (excerpt)
async callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  options: CallToolOptions = {},
): Promise<CallToolResult<T>> {
  const cacheKey = `${name}:${JSON.stringify(args)}`;
  const ttl = options.cacheTtlMs ?? 60_000;

  // ── hide #1: 60s response cache (60s default) ──────────────────────────
  if (!options.skipCache) {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { result: cached.result as T, durationMs: 0, fromCache: true };
    }
  }

  const start = Date.now();
  let result = await this.liveCall(name, args, options.signal);

  // ── hide #2: rate-limit retry ladder honouring server's stated window ──
  let retries = 0;
  while (isRateLimited(result) && retries < this.maxRetries) {
    retries++;
    const hintMs = parseRetryAfterMs(result);                         // ← parses "retry after ~12 seconds"
    const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
    const waitMs = Math.min(
      hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
      this.retryCeilingMs,                                            // ← bounded so 3 retries fit the 60s budget
    );
    await sleep(waitMs);
    result = await this.liveCall(name, args, options.signal);
  }

  const durationMs = Date.now() - start;

  // ── hide #3: never cache error results — they should not poison the cache ──
  if ((result as any)?.isError === true) {
    return { result: result as T, durationMs, fromCache: false };
  }

  this.cache.set(cacheKey, { result, expiresAt: Date.now() + ttl });
  return { result: result as T, durationMs, fromCache: false };
}
```

And the inner `liveCall` (lines 190-205) carries hide #4, the proactive ~1 req/s spacing and the typed-error throw:

```ts
private async liveCall(name: string, args, signal?: AbortSignal): Promise<unknown> {
  // ── hide #4a: proactive ~1 req/s spacing (Bloomreach rate-limits per user globally)
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });  // ← composes signal + 30s timeout inside the transport
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();
    // ── hide #4b: tag the failure with the tool name + redacted detail ──
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

The agent layer sees exactly *none* of this. It calls `dataSource.callTool(name, args, {signal})` and gets back `{result, durationMs, fromCache}`. If the result throws, it's an `McpToolError` with the tool name and a clean detail. That's the depth.

#### Part 3 — the adapter (the fixture)

`SyntheticDataSource` in `lib/data-source/synthetic-data-source.ts:314-496` implements the same port with **zero network**, **zero OAuth**, **zero rate limiting**, **zero retries**. Its body is a 30-tool dispatch `switch` returning realistic envelopes:

```ts
// lib/data-source/synthetic-data-source.ts:319-331 (excerpt)
async callTool(name, args = {}, _opts?): Promise<DataSourceCallResult> {
  const started = Date.now();
  const payload = this.dispatch(name, args);   // ← the 30-case switch
  return {
    result: payload,
    durationMs: Date.now() - started,
    fromCache: false,
  };
}

// lib/data-source/synthetic-data-source.ts:498-503
function ok(payload: unknown): ToolResult {
  return {
    structuredContent: payload,                                   // ← what unwrap<T>(result) prefers
    content: [{ type: 'text', text: JSON.stringify(payload) }],   // ← fallback if structuredContent absent
  };
}
```

Why both `structuredContent` and `content`? Because `lib/mcp/schema.ts:36-43` `unwrap<T>` prefers `structuredContent` and falls back to `content[0].text`. The synthetic adapter mirrors the live MCP envelope exactly so the same `unwrap` call works for both adapters. **That's the contract the port doesn't say but every adapter has to honour.**

#### Part 4 — the factory and DI

The factory is the *one place* in the repo that names both concrete adapters by their class names. Everyone else gets back a `DataSource`:

```ts
// lib/data-source/index.ts:67-100 (excerpt)
export async function makeDataSource(
  mode: LiveMode,
  sessionId: string,
): Promise<MakeDataSourceResult> {
  if (mode === 'live-synthetic') {
    const dataSource = new SyntheticDataSource();
    return {
      ok: true,
      mode,
      dataSource,                                                  // ← typed as `DataSource`, not `SyntheticDataSource`
      bootstrap: async () => syntheticWorkspaceSchema,
      dispose: async () => {},
    };
  }

  // live-bloomreach — defer to the existing OAuth-aware connect path
  const conn: ConnectResult = await connectMcp(sessionId);
  if (!conn.ok) {
    return { ok: false, mode, authUrl: conn.authUrl };             // ← auth-fail bubble: route returns 401 with the URL
  }
  const bloomreachDs = conn.mcp;
  return {
    ok: true,
    mode,
    dataSource: bloomreachDs,
    bootstrap: (signal?) => bootstrapSchema(bloomreachDs, { signal }),
    dispose: async () => {},
  };
}
```

And the dependency injection at the route handler:

```ts
// app/api/briefing/route.ts:172-186 (excerpt)
const dsResult = await makeDataSource(mode, sid);            // ← picks the adapter
if (!dsResult.ok) {
  return NextResponse.json({ needsAuth: true, authUrl: dsResult.authUrl }, { status: 401 });
}
const dataSource = dsResult.dataSource;                      // ← typed as `DataSource`

// ... later, passed into the agent constructor:
const agent = new MonitoringAgent(anthropic, dataSource, schema, allTools, sid);
//                                          ^^^^^^^^^^ — DI: the agent gets the port, not the adapter
```

The agent's constructor signature in `lib/agents/monitoring.ts:74-80` reads:

```ts
constructor(
  private anthropic: Anthropic,
  private dataSource: McpCaller,        // ← Pick<DataSource, 'callTool'> — even narrower than the port
  private schema: WorkspaceSchema,
  private allTools: McpToolDef[],
  private sessionId?: string,
) {}
```

`McpCaller = Pick<DataSource, 'callTool'>` (in `lib/agents/base.ts:14`) is a *narrower-than-the-port* type the agent uses, because the agent never needs `listTools` after bootstrap. That's a small flourish on top of DIP — depend on the *narrowest* useful surface, not the whole port.

### Move 3 — the principle

**Stable interface, swappable adapter** is the move. The port has to be defined by what the *client* needs from the *outside world*, not by what any one adapter happens to expose. If the port were shaped like Bloomreach's MCP — `connect`, `oauth`, `disconnect`, `getResource`, `listResources` — the synthetic adapter would have to grow no-op stubs and the port would leak the MCP protocol vocabulary into every agent.

By shaping the port around what the agents *actually need* (`callTool`, `listTools`, `signal` for cancellation, an opaque `result: unknown`), the synthetic adapter can be a 30-case switch and the live adapter can be the OAuth-rate-limited-retrying beast it has to be. Both fit the same socket.

This is the AOSD definition of a deep module distilled to its sharpest form: **small interface, large body, the body changes without the interface needing to**.

## Primary diagram

The recap — port, two adapters, factory, DI hop:

```
  ┌─ UI / route handlers ──────────────────────────────────────────────┐
  │  GET /api/briefing?mode=live-synthetic                             │
  └───────────────────────────────┬────────────────────────────────────┘
                                  │ 1) reads mode from query string
                                  ▼
                       ┌──────────────────────┐
                       │  makeDataSource(     │   (the factory — only
                       │     mode, sessionId  │    code that names both
                       │  )                   │    concrete adapters)
                       └──────────┬───────────┘
                                  │ 2) returns {ok, dataSource, bootstrap, dispose}
                                  ▼
  ┌─ injected into the agent constructor (DI) ────────────────────────┐
  │  new MonitoringAgent(anthropic, dataSource, schema, tools, sid)   │
  └───────────────────────────────┬────────────────────────────────────┘
                                  │ 3) agent.scan(...) calls dataSource.callTool(...)
                                  ▼
                       ┌──────────────────────┐
                       │  interface DataSource│   (the port — agents
                       │    callTool          │    only ever see this type)
                       │    listTools         │
                       └─┬──────────────────┬─┘
                         │                  │
                         ▼                  ▼
              ┌───────────────────┐  ┌───────────────────────┐
              │ Bloomreach        │  │ Synthetic             │
              │ DataSource        │  │ DataSource            │
              │  (live MCP/OAuth) │  │  (in-process switch)  │
              └─────────┬─────────┘  └───────────────────────┘
                        │
                        ▼
              ┌───────────────────┐
              │ Bloomreach loomi  │
              │ connect MCP server│
              └───────────────────┘
```

## Elaborate

The pattern was named by Alistair Cockburn (2005, "Hexagonal Architecture") and made famous by Robert C. Martin's "Clean Architecture" as **the Dependency Inversion Principle** — *clients depend on abstractions; abstractions don't depend on details.* The hex picture itself was meant to show that any number of adapters can attach to the same port — a UI adapter at the top, a database adapter at the bottom, a test fixture beside it.

The repo's framing is the canonical one. The **port** owns the abstraction the application's business logic needs. The **adapters** are the boundary code that translates between that abstraction and whatever real thing is on the other side (an SDK, a wire protocol, a fixture). The two adapters here — `BloomreachDataSource` and `SyntheticDataSource` — are the textbook "production + test fixture" pair, except the fixture is also a *runtime mode* (`?mode=live-synthetic`) so the user can flip to it without recompiling.

For the conceptual treatment, read `.aipe/read-aposd/part-2/03-deep-modules.md` — the chapter that defines what makes a module deep and why it's the most important AOSD primitive.

The story of how this seam was extracted is documented in the `BloomreachDataSource` file header (`lib/data-source/bloomreach-data-source.ts:1-14`): it was originally `McpClient` in `lib/mcp/client.ts`, renamed and moved to `lib/data-source/` in PR A of Phase 2. The class was already shaped to be the Bloomreach adapter — extracting the port was a type-level move, not a body rewrite. **That's the cheapest possible port extraction:** when the would-be adapter already exists, lifting an interface over it is a one-PR change.

## Interview defense

### Q1: "What's the load-bearing part of this design? If I removed it, what would break?"

```
  the load-bearing part — the port (5 lines of TS)

  delete this →    ┌──────────────────────┐
                   │ interface DataSource │
                   │   callTool           │
                   │   listTools          │
                   └──────────────────────┘
                            ↓
  what breaks:  every agent has to import a concrete class.
                 swapping bloomreach ↔ synthetic requires
                 a route handler conditional, not a config flag.
                 tests have to stub a real `BloomreachDataSource`
                 (or hand-roll a fake at every test site).
```

The port itself is the load-bearing part. The 2-method interface is what lets the four agents stay ignorant of which adapter they hold. Strip it and the dependency arrows reverse — agents depend on `BloomreachDataSource`, which depends on the MCP SDK, which depends on the network. That's the version of the codebase where you can't unit-test an agent without mocking the SDK.

**Anchor:** the port is the swap point this codebase owns.

### Q2: "Why doesn't the port expose `skipCache` or `connect()`? Aren't those features?"

```
  the depth test — what BELONGS on the port?

  ┌─ on the port (every adapter must answer) ─────────────────┐
  │  callTool(name, args, {signal?})  ← what agents need      │
  │  listTools({signal?})              ← what bootstrap needs  │
  └────────────────────────────────────────────────────────────┘

  ┌─ off the port (adapter-private) ──────────────────────────┐
  │  skipCache: true                  ← Bloomreach-only       │
  │    (Synthetic has no cache to skip)                       │
  │  cacheTtlMs                       ← Bloomreach-only       │
  │  connect() / disconnect()         ← lifecycle = factory   │
  │    (Synthetic constructs instantly)                       │
  └────────────────────────────────────────────────────────────┘
```

Because they aren't on every adapter. `skipCache` only makes sense for `BloomreachDataSource` (the synthetic adapter has no cache to skip). `connect()` only makes sense for live (the synthetic adapter is constructed instantly). Putting either on the port forces the synthetic adapter to grow a no-op stub — a textbook AOSD "leaking implementation detail upward."

The cache-bypass features live on `BloomreachDataSource`'s own surface (`lib/data-source/bloomreach-data-source.ts:22-26`), and the four MCP routes that need them (`/api/mcp/call`, `/api/mcp/capture`, debug paths) hold a `BloomreachDataSource` directly — they're already in the adapter's vocabulary, so dropping to it is honest.

**Anchor:** what doesn't fit every adapter doesn't belong on the port.

### Q3: "Walk me through how the factory and DI compose."

```
  the factory + DI hop — one diagram

  request          factory                  dependency injection
  ───────          ───────                  ────────────────────
                                        ┌─ DI →     agent
  route handler                         │           holds
   │                                    │      `DataSource`
   │ reads ?mode                        │      (never
   │                                    │       the adapter)
   ▼                                    │
  makeDataSource(mode, sid)             │
   │                                    │
   ├──► live-bloomreach                 │
   │      → connectMcp(sid)             │
   │      → returns BloomreachDataSource├──┐
   │                                    │  │
   ├──► live-synthetic                  │  │
   │      → new SyntheticDataSource()   │  ├─ typed as DataSource
   │                                    │  │
   └─◄ returns {dataSource, bootstrap,──┘  │
       dispose, ...}                       │
                                           ▼
  ┌─ injected at construction site ────────────────────────────┐
  │  new MonitoringAgent(anthropic, dataSource, schema, ...)   │
  └────────────────────────────────────────────────────────────┘
```

The factory is the *one place* that names both concrete adapters by their class names. The route handler reads `?mode` from the query string, calls `makeDataSource(mode, sid)`, gets back the port-typed `dataSource`, and threads it into the agent constructor. That's dependency injection: the agent didn't pick its adapter; the route handler did, and the agent has no way to know which one it got.

The bonus: if Bloomreach's OAuth dance fails, `makeDataSource` returns `{ ok: false, authUrl }` and the route handler returns a 401 with the URL — the caller never has to know that *only the Bloomreach branch* can fail at construction. The factory's result type carries the difference.

**Anchor:** the factory picks the adapter, the route injects it, the agent never knows.

## See also

  → `00-overview.md` — where the port sits in the four-altitude system.
  → `audit.md` — lens 2 (deep-vs-shallow modules) and lens 4 (layers-and-abstractions).
  → `03-aptkit-bridge-information-hiding.md` — the *other* port-and-adapter pair in this repo (between Blooming and `@aptkit/core`).
  → `.aipe/read-aposd/part-2/03-deep-modules.md` — the conceptual chapter on deep modules.
  → `.aipe/read-aposd/part-2/04-information-hiding.md` — why the port hides what it hides.
  → `.aipe/study-system-design/` — for the architecture-altitude view of the same seam.
