# port + adapter + decorator + preset + factory

## Subtitle

**Ports and adapters (hexagonal architecture)** with a **decorator** and a **factory** on top — the AOSD deep-module pattern taken to its full shape. *Industry standard.*

Role-vocabulary this file uses (literature lead, repo local name in parens):

```
  port      the interface — the swap point         (DataSource)
  adapter   an implementation of the port          (BloomreachDataSource / McpDataSource,
                                                    SyntheticDataSource)
  client    code that depends on the port           (the agents; connectMcp)
  decorator wraps an adapter, adds a concern        (FaultInjectingDataSource)
  factory   selects + constructs an adapter         (makeDataSource)
  seam      the boundary you swap on one side       (the port itself)
  DI        dependency injection                    (adapter passed to agent ctor)
  DIP       dependency inversion                    (agents depend on DataSource,
                                                    not BloomreachDataSource)
```

## Zoom out — where this concept lives

Every layer that touches "get data from outside the process" flows through one interface. The concept sits at the border between your agents (business logic) and everything external (Bloomreach's alpha MCP, a local synthetic fixture, a fault-injecting decorator wrapping either one). The whole point of the diagram below is that the arrow **stops at the port** — nothing above it sees which adapter is on the bottom.

```
  the DataSource seam — where the port lives in the whole system

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  React components (feed, investigate, chat)                  │
  └─────────────────────────┬────────────────────────────────────┘
                            │  NDJSON fetch
  ┌─ Route layer ──────────▼────────────────────────────────────┐
  │  app/api/{briefing,agent}/route.ts                          │
  └─────────────────────────┬────────────────────────────────────┘
                            │  new MonitoringAgent(dataSource, ...)
  ┌─ Agent layer (the client) ─────────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent    │
  │       │                                                      │
  │       └─── holds a `DataSource` reference                   │
  └───────┼──────────────────────────────────────────────────────┘
          │  callTool(name, args, opts)
  ═══════ ▼ ══════════ ★ THE PORT ★ ═══════════════════════════════  ← we are here
          │  interface DataSource { callTool; listTools }
  ┌───────┴──────────────────────────────────────────────────────┐
  │  adapter layer:                                              │
  │   ┌─ McpDataSource ─────┐  ┌─ SyntheticDataSource ─┐         │
  │   │  live MCP server    │  │  deterministic fixture │         │
  │   │  (Bloomreach preset)│  │  (no OAuth, no network)│         │
  │   └─────────────────────┘  └────────────────────────┘         │
  │                                                              │
  │  optional wrapping:                                          │
  │   ┌─ FaultInjectingDataSource ── wraps ANY of the above ─┐   │
  │   │  timeout · rate_limit · server_error · malformed     │   │
  │   └───────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────────┘
```

The client (agents) doesn't know which adapter is on the other side of the port. The factory (`makeDataSource`) is the one place that knows — and even it doesn't know when a decorator is layered on top (the fault-injection harness adds that at eval time).

## Zoom in — what this pattern is

The pattern is the **port** — one interface (`DataSource` in `lib/data-source/types.ts`) with two methods. Behind it, the codebase has grown four things:

1. Two **adapters** (live MCP, in-process synthetic)
2. One **decorator** (fault-injecting wrapper)
3. One **preset** (the Bloomreach default that the MCP adapter falls back to)
4. One **factory** (`makeDataSource(mode, sessionId, override)`)

The point of putting all four in one file is that this is exactly the shape AOSD says to build for a swappable dependency: a small interface hides big behavior, adapters implement it, decorators layer on it, and a factory keeps the client from ever naming a concrete class.

## Structure pass — skeleton first

### Axes

The right axis to hold constant here is **"who decides which backend gets called?"** Let's trace it.

- Above the port: **the agent has no idea.** It receives a `DataSource` in its constructor.
- At the factory: **`makeDataSource(mode)` decides**, but only from `mode: LiveMode`.
- Above the factory: **the route handler decides mode** from `?mode=`.
- Above the route handler: **the browser's `bi:mode` localStorage decides**.
- If a decorator is present: **the harness decides fault rates**, orthogonal to the mode question.

So the decision walks *up and out of the process* to the UI. That's the DIP payoff — dependencies point inward, at the port.

The other axis worth tracing is **"where does failure originate?"** — timeouts and rate limits fire *inside* the MCP adapter and are handled there; the port promises "success or `McpToolError`." That's error definition eliminating special cases (AOSD chapter, small).

### Seams

The port is the load-bearing seam. Trace the "who decides which backend" axis across it: above → the agent has no idea; below → the concrete adapter runs. The axis-answer flips. Seam confirmed.

Two secondary seams:

- The **decorator seam** — `FaultInjectingDataSource` wraps *any* `DataSource`. That's another "which behavior?" boundary; above it a call goes to the inner adapter unchanged, below it a fraction of calls fail with a specific fault shape. Same axis: "which behavior?" flips.
- The **transport seam** — `McpTransport` interface below the MCP adapter. Same shape, lower in the stack.

### Layered decomposition

Layers, holding "who owns the decision to retry a rate-limited call?" constant:

- Agent layer: **nobody retries** — they see one result.
- Port layer: **nobody retries** — the promise is `callTool` returns `DataSourceCallResult`.
- Adapter layer (`BloomreachDataSource.callTool`): **THE ADAPTER retries** — parses the penalty window, sleeps, retries up to `maxRetries=3`.
- Transport layer: **nobody retries** — one call, one response (or one throw).

Same question, one answer that flips at exactly one layer. That's the adapter earning its place.

## How it works

### Move 1 — the mental model

Think of the port like a **wall socket you defined yourself**. The socket has two prongs (`callTool`, `listTools`); anything with the right shape plugs in. The MCP adapter is the "wall power" plug; the Synthetic adapter is the "battery pack" plug; the fault-injecting decorator is a surge protector you can stack in between. The lamp (the agent) doesn't know or care which one is behind the socket — it just draws power.

```
  the shape of the pattern — one interface, N implementations, optional wrapping

                ┌────────────────────────┐
                │  client (the agent)    │
                └────────────┬───────────┘
                             │  depends on
                             ▼
             ┌───────────────────────────────┐
             │  PORT: DataSource interface   │
             │    callTool + listTools       │
             └───┬─────────┬─────────┬───────┘
                 │         │         │
        implements│         │implements│implements
                 ▼         ▼         ▼
        ┌────────────┐ ┌─────────┐ ┌──────────────┐
        │ McpData    │ │Synthetic│ │FaultInjecting│  ← decorator: wraps
        │ Source     │ │DataSrc  │ │DataSource     │    ANY of the others
        └────────────┘ └─────────┘ └──────────────┘

  and the factory picks which one — clients never name a concrete class:

        makeDataSource('live-mcp')       → connectMcp → McpDataSource
        makeDataSource('live-synthetic') → SyntheticDataSource
        (test harness)                   → new FaultInjectingDataSource(inner, rates)
```

Now the mechanism.

### Move 2 — the walkthrough

The five roles get walked one at a time. Each has its own file in `lib/data-source/`.

#### The port (`DataSource`) — the interface

The port is 71 lines including doc comments. Two methods, one options bag per method, one result envelope. That's it.

Real code from `lib/data-source/types.ts:63-71`, annotated:

```typescript
export interface DataSource {
  //                    ▲ this is the whole surface — 2 methods
  callTool(
    name: string,                             // MCP tool name (e.g. execute_analytics_eql)
    args: Record<string, unknown>,             // arbitrary tool args
    opts?: DataSourceCallOptions,              // only { signal? } is portable
  ): Promise<DataSourceCallResult>;            // { result, durationMs, fromCache }

  listTools(opts?: DataSourceListOptions): Promise<unknown>;
  //                                     ▲ result stays `unknown` on purpose:
  //                                       adapters may include structuredContent
}
```

**What breaks if you remove any part:** drop `signal` from `DataSourceCallOptions` and mid-request cancellation dies (client navigates away, in-flight Anthropic call keeps burning tokens). Drop `fromCache` from the result envelope and the UI's "how this was gathered" panel can't tell cached from live calls. Drop `durationMs` and every trace loses timing. Drop `listTools` and the bootstrap phase can't discover which tools the server exposes. The interface is 2 methods precisely because 2 methods are the minimum that the agents need.

**Why `result: unknown`:** the MCP envelope has `structuredContent` on some servers and `content[]` on others; the `unwrap<T>(result)` helper in `lib/mcp/schema.ts` prefers the former and falls back to the latter. Making `result` generic would force every call site to declare the shape it expects; leaving it `unknown` and casting at the point of use keeps the port narrow.

#### The adapter (`BloomreachDataSource` — aliased `McpDataSource`) — the live implementation

The concrete class body is in `lib/data-source/bloomreach-data-source.ts` (214 LOC). The alias file at `lib/data-source/mcp-data-source.ts` (27 LOC) re-exports it under the honest name. This is the "rename via re-export" pattern; it has its own file at `03-rename-via-reexport.md`.

The adapter's body, side-by-side with what each part does:

```typescript
// lib/data-source/bloomreach-data-source.ts:121-137
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  //             ▲ 60s TTL cache — absorbs repeat tool calls in the same
  //               investigation
  private lastCallAt = 0;
  //             ▲ powers the ~1 req/s proactive spacing (Bloomreach
  //               rate-limits per user globally)
  private minIntervalMs: number;      // default 1100ms — 1 call per ~1.1s
  private maxRetries: number;         // default 3
  private retryDelayMs: number;       // default 10_000 — Bloomreach's 10s window
  private retryCeilingMs: number;     // default 20_000 — hard cap on any single wait

  constructor(private transport: McpTransport, opts: ClientOpts = {}) {
    //                     ▲ dependency injection: transport is passed in.
    //                       The adapter doesn't know if it's an SdkTransport
    //                       (real) or a fake (tests).
    ...
  }
}
```

The full `callTool` body (`lib/data-source/bloomreach-data-source.ts:139-188`) does 5 things in order:

1. **Cache read.** Same `name:JSON.stringify(args)` key → return with `fromCache: true, durationMs: 0` if fresh.
2. **Live call** via `this.liveCall(name, args, options.signal)` which does the spacing wait + `transport.callTool` + tag any throw as `McpToolError`.
3. **Rate-limit retry ladder.** While `isRateLimited(result)` fires and `retries < maxRetries`: parse the server's stated window (`parseRetryAfterMs`), fall back to exponential backoff, cap at `retryCeilingMs`, sleep, redo the live call.
4. **Error-result short-circuit.** If the result is `isError: true`, return it without caching (don't poison the cache with a failure).
5. **Cache write and return.** Set the cache with `expiresAt = Date.now() + ttl`, return `{result, durationMs, fromCache: false}`.

**What breaks if you remove any part:** drop the cache and a 6-call investigation makes 6 Bloomreach round-trips even when 4 are duplicates → blows the 60s route budget. Drop the spacing and Bloomreach returns 429 on call 2. Drop the retry ladder and the *first* 429 kills the whole investigation. Drop the AbortSignal composition (inside `liveCall`) and closing the browser tab leaves the Anthropic call running server-side. Every part is load-bearing.

#### The second adapter (`SyntheticDataSource`) — the fixture

516 LOC in `lib/data-source/synthetic-data-source.ts`. Same 2-method interface, but the body serves pre-computed deterministic data — no network, no OAuth, no rate limit. It's what the default `live-synthetic` mode uses.

The point of having *two* adapters (rather than "we plan to have one someday") is that the port has been proven — it's been used at least twice, with wildly different backends. That's the receipt.

#### The decorator (`FaultInjectingDataSource`) — the wrapper

176 LOC in `lib/data-source/fault-injecting.ts`. Wraps *any* `DataSource` and adds a fault-injection layer. The header comment names the 5-uses receipt as the tier-2 story (`fault-injecting.ts:11-16`):

> "The seam has now shipped in FIVE uses without a caller-surface change: Olist added, Olist removed, Synthetic added, this fault decorator, and the McpDataSource / AuthProvider generalization."

The decorator's shape:

```typescript
// lib/data-source/fault-injecting.ts:65-74
export class FaultInjectingDataSource implements DataSource {
  //                                              ▲ same interface as the inner —
  //                                                the caller can't tell it's decorated
  constructor(
    private readonly inner: DataSource,
    //                     ▲ the wrapped adapter — could be MCP, Synthetic, or
    //                       another decorator (composition works)
    private readonly options: FaultInjectorOptions,
  ) { ... }

  async callTool(name, args, opts) {
    this.callIndex += 1;
    const roll = this.random();                    // xorshift32 when seeded, else Math.random
    // ... 4 accumulated-probability checks, each firing a specific fault shape
    // If none fire: return this.inner.callTool(name, args, opts);
  }
}
```

**What breaks if you remove any part:** drop `inner` and the wrapper has nothing to pass through to → the fault-only mode is useless. Drop the accumulated-probability roll and multiple faults could fire on one call → invalid test scenario (fault #4 never gets exercised). Drop the seed → the fault sequence isn't reproducible across test runs → intermittent-only regressions.

**The tier-2 receipt shape:** 9 injected faults / 3 investigations / 0 failed / per-case ~$0.09. That's the number that makes this pattern load-bearing: the seam is the reason the graceful-degradation story is defensible.

#### The preset — the default that saves the fresh deploy

The Bloomreach settings live at `lib/mcp/connect.ts:120-125`:

```typescript
return {
  ok: true,
  mcp: new BloomreachDataSource(new SdkTransport(client, httpErrors), {
    minIntervalMs: 1100,      // ~1 req/s — Bloomreach's observed limit
    retryDelayMs: 10_000,     // the stated 10s penalty window
    retryCeilingMs: 20_000,   // cap on any single retry wait
    maxRetries: 3,            // 3 tries × 10s = 30s worst case, within 60s budget
  }),
};
```

These four numbers are the **preset**: they encode what a Bloomreach connection needs to survive Bloomreach's alpha rate limits. An unset env (no MCP_URL, no MCP_AUTH_TYPE) still yields a working connection because the preset supplies the numbers.

This is what the CLAUDE.md context calls "Bloomreach is not the primary adapter — it's the preset." The adapter class is generic (`McpDataSource`); Bloomreach is the first user whose limits shaped the defaults.

#### The factory (`makeDataSource`) — the one place that names concrete classes

The full body from `lib/data-source/index.ts:84-120`:

```typescript
export async function makeDataSource(
  mode: LiveMode,
  sessionId: string,
  mcpConfigOverride?: McpConfigOverride | null,
): Promise<MakeDataSourceResult> {
  if (mode === 'live-synthetic') {
    const dataSource = new SyntheticDataSource();      // ← names one concrete class
    return { ok: true, mode, dataSource, bootstrap: ..., dispose: async () => {} };
  }

  // live-mcp — defer to the existing connect path.
  const conn: ConnectResult = await connectMcp(sessionId, mcpConfigOverride);
  if (!conn.ok) {
    return { ok: false, mode, authUrl: conn.authUrl };  // ← OAuth redirect path
  }
  const mcpDs = conn.mcp;                                // ← names the second class
  return { ok: true, mode, dataSource: mcpDs, bootstrap: ..., dispose: async () => {} };
}
```

**What the factory does that the client cannot:**

- **Names concrete classes** (`new SyntheticDataSource`, `connectMcp → BloomreachDataSource`). The client only sees `DataSource`.
- **Handles the "not connected yet" case** — Bloomreach OAuth returns `{ ok: false, authUrl }` so the route handler can redirect the browser. The synthetic path can't fail this way.
- **Owns the `bootstrap` closure.** Live MCP bootstraps via `bootstrapSchema(mcpDs)`; synthetic returns a static `syntheticWorkspaceSchema`. Same closure signature; different bodies.
- **Owns the `dispose` closure.** Both are currently no-ops (MCP client is session-scoped via the cookie store), but the shape is future-proof.

**What breaks if you remove the factory and let route handlers construct adapters directly:** every route handler needs to know both class constructors, both bootstrap paths, and the OAuth redirect shape. The route surface widens. And the day a third adapter arrives, every route needs editing — instead of one factory.

### Move 2.5 — Phase A vs Phase B (the migration receipt)

The port shipped as `McpClient` in Phase 1, was lifted to `DataSource` in Phase 2, added the Synthetic adapter in Phase 2 PR B, absorbed the fault decorator in Phase 4, and got the auth-strategy split + rename in Session B. Five uses of the seam without a caller-surface change:

```
  the 5 uses — Phase A (starting shape) → Phase B (each addition)

  ┌──────────────┐                          agents call...
  │  the agents  │
  └──────┬───────┘
         │
         ▼   (the port hasn't changed since Phase 2)
    DataSource
         │
  ┌──────┼──────┐──────────────┬──────────────┬──────────────────┐
  │      │      │              │              │                  │
  ▼      ▼      ▼              ▼              ▼                  ▼
  1.     2.     3.             4.             5.                (Olist
  Olist  (Olist Synthetic     FaultInject    McpDataSource +    is now removed
  added  removed)adapter      decorator      AuthProvider split at seam;
         at seam) added                      (rename via         port unchanged)
                                             re-export)

  the agents' code didn't change once across any of these
```

**The take-away isn't "we swapped adapters."** It's "we swapped adapters, added a decorator, split the auth flow into a strategy family, and renamed the concrete class — and every one of those was invisible to the agents." That's the tier-2 receipt: the seam earned it five times.

### Move 3 — the principle

**The principle:** a port earns its keep by how many things you get to change on one side without touching the other. The AOSD phrase for this is "deep module" — big body, small interface. This code has taken it further: the interface is 2 methods; the body is 4 files totaling ~1100 LOC (adapter + adapter + decorator + factory); the client (the agents) has never had to change. That ratio is the whole game.

A port with one implementation is a hypothesis. A port with two is a used pattern. A port with two adapters + a decorator + a preset + a factory is a design that has paid rent.

## Primary diagram

```
  the five roles in one picture, plus what each part is protecting

  ┌─── agents (client) ────────────────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent    │
  │  — hold a `DataSource`, never a concrete class              │
  └─────────────────────────┬───────────────────────────────────┘
                            │
                            │  callTool(name, args, {signal})
                            │
  ┌─── PORT ──────────────▼───────────────────────────────────┐
  │  interface DataSource { callTool; listTools }              │
  │  71 LOC in lib/data-source/types.ts                        │
  │  — the swap point; holds no behavior                       │
  └───────────────┬─────────────┬─────────────┬─────────────────┘
                  │             │             │
                  │ implements  │ implements  │ wraps
                  ▼             ▼             ▼
  ┌── ADAPTER ─────┐ ┌── ADAPTER ──┐ ┌── DECORATOR ────────────┐
  │ McpData        │ │ Synthetic   │ │ FaultInjecting          │
  │ Source         │ │ DataSource  │ │ DataSource              │
  │ (Bloomreach    │ │ 516 LOC     │ │ 176 LOC                 │
  │  preset:       │ │ deterministic│ │ 4 fault kinds           │
  │  1100ms space, │ │ fake data   │ │ xorshift32 PRNG         │
  │  10s window,   │ └─────────────┘ │ wraps ANY DataSource    │
  │  20s ceiling,  │                 └─────────────────────────┘
  │  3 retries)    │
  │ 214 LOC        │
  └────────────────┘
              ▲
              │  aliased as McpDataSource via
              │  27-LOC re-export file (see 03-)
              │
  ┌── FACTORY ──────────────────────────────────────────────────┐
  │ makeDataSource(mode, sessionId, override)                   │
  │ 125 LOC in lib/data-source/index.ts                         │
  │ — the only code that names concrete classes                 │
  │ — owns bootstrap + dispose closures                         │
  │ — handles OAuth redirect ({ ok: false, authUrl })           │
  └─────────────────────────────────────────────────────────────┘

  what the port is protecting the agents from:
    OAuth 2.1 + PKCE + DCR flow · session cookie store ·
    ~1 req/s spacing · 60s response cache · rate-limit retry
    ladder with parsed penalty windows · AbortSignal composition ·
    McpToolError tagging · timeout ceilings · retry backoff · the
    fact that Bloomreach's alpha revokes tokens after minutes
```

## Elaborate

**Where the pattern comes from.** Ports-and-adapters (hexagonal architecture) is Alistair Cockburn's 2005 formulation of what Ousterhout would later call a deep module: an application-owned interface that isolates the domain from every external concern. The AOSD framing — small interface, big body — is a subset of what hexagonal makes explicit at architecture altitude. This codebase does both: the port is small (2 methods) and the body behind it is big (~1100 LOC across the five roles).

**What problem the shape solves for this repo.** Before Phase 2, the agents held `McpClient` directly; the class name leaked "MCP" into every agent's constructor. That meant: no way to run the agents against a fixture without a real MCP server; no way to inject faults without patching `McpClient` internals; no way to swap the OAuth flow for a bearer token without editing the class. Lifting `DataSource` over it fixed all three, and the receipt is that 5 subsequent changes happened without the agents' code changing.

**Adjacent concepts.**

- **Strategy pattern** — the auth providers behind `makeAuthProvider` are the same shape at a different level (see `02-auth-strategy-injection.md`). Strategy is a port-family for a single decision (which auth flow), not the whole external-boundary port.
- **Decorator pattern** — `FaultInjectingDataSource` is a textbook decorator. It preserves the interface, adds a concern, and composes (you could wrap the decorator in another decorator).
- **Factory method** — `makeDataSource` is the classical factory: it returns instances typed as the interface. When callers never name the concrete class, the factory has done its job.

**Where to read more.** Ousterhout, *A Philosophy of Software Design*, chapter 4 (Modules Should Be Deep) and chapter 6 (General-Purpose Modules Are Deeper). Cockburn's original hexagonal writeup is at alistair.cockburn.us. The strategy + decorator pieces are in the GoF Design Patterns book; nothing about them is new, but seeing all four in one 5-file directory is unusual outside senior codebases.

## Interview defense

### Q: What's the deepest module in this codebase and how do you know?

**Answer:** The `DataSource` interface at `lib/data-source/types.ts`. 71 LOC of interface plus doc comments, 2 methods (`callTool`, `listTools`), and behind it the whole OAuth 2.1 + PKCE + DCR flow, the ~1 req/s spacing, the 60s cache, the rate-limit retry ladder, AbortSignal composition, and typed `McpToolError`. The proof it's deep is that we've shipped 5 changes to what's behind it — Olist added, Olist removed, Synthetic adapter added, fault-injecting decorator added, and the McpDataSource + AuthProvider rename — without the agents' code changing once. Big body, small surface, zero caller-side churn. That's the shape Ousterhout means by "deep."

Diagram to sketch while answering:

```
   agents  →  DataSource port (2 methods)  →  [4 adapters/decorators, ~1100 LOC]

   the arrow doesn't reverse: five changes happened right of the port
   without one change to the left
```

Anchor: *lib/data-source/types.ts:63-71 — the whole interface fits on one screen; the body is 4 files.*

### Q: The `FaultInjectingDataSource` looks like a pass-through decoration — the AOSD red flag for a wrapper that doesn't earn its keep. Defend it.

**Answer:** It's not pass-through — it's exactly the AOSD "decorator" pattern with real added behavior. It preserves the `DataSource` interface (that's the point — the caller can't tell it's decorated), but the body adds four fault kinds (timeout, rate_limit, server_error, malformed_json), a seeded xorshift32 PRNG for reproducibility, and an accumulated-probability roll so one call can only fire one fault kind. What we get from it is the tier-2 graceful-degradation receipt: 9 injected faults / 3 investigations / 0 failed. Without it, we'd have no evidence that the agents survive real Bloomreach failures — and every fault kind we test corresponds to a shape Bloomreach's alpha actually returns.

The AOSD test that separates "real decorator" from "pass-through": name what breaks if the wrapper is removed. Here, without the decorator we lose the entire offline fault-injection harness — the eval runs would only test happy paths.

Anchor: *lib/data-source/fault-injecting.ts:11-16 — the header comment names the 5-uses receipt explicitly.*

### Q: Why does `mcp-data-source.ts` re-export instead of moving the code?

**Answer:** Because moving the ~290 LOC of class body would break every existing import site (`connectMcp`, the 4 MCP routes, the tests, the fault harness) with no behavior change. The re-export lets the honest new name (`McpDataSource`) coexist with the historical name (`BloomreachDataSource`) at the same class; new code prefers the new name, existing imports still resolve. This is the "rename via re-export" pattern — deep-module win: the naming change is invisible to every caller. See `03-rename-via-reexport.md`.

Anchor: *lib/data-source/mcp-data-source.ts:18-22 — the entire body of the file is a re-export.*

### Q: Where does the client actually pick which adapter runs?

**Answer:** The client never picks. `makeDataSource(mode, sessionId, override)` picks — from a `LiveMode` discriminant (`'live-mcp' | 'live-synthetic'`). Above the factory, the route handler reads `?mode=` from the URL. Above the route, the browser reads `bi:mode` from localStorage. That's the DIP payoff: the decision walks all the way up and out of the process, so the agents don't own it and can't accidentally couple to it.

The concrete adapter class names appear in exactly two places: inside `makeDataSource` (`new SyntheticDataSource()`, `connectMcp() → BloomreachDataSource`) and inside the fault-injection harness (`new FaultInjectingDataSource(inner, rates)`). Nowhere else.

Anchor: *lib/data-source/index.ts:84-120 — the factory body; every `new X(...)` is on one screen.*

## See also

- [audit.md](./audit.md) — lens 2 (deep-vs-shallow modules) names the port as the deepest module in the repo; lens 6 (errors-and-special-cases) names the `McpToolError + retry ladder` design as the error-definition win.
- [02-auth-strategy-injection.md](./02-auth-strategy-injection.md) — the strategy pattern that hides behind the MCP adapter's `authProvider`. Same DI shape at a nested level.
- [03-rename-via-reexport.md](./03-rename-via-reexport.md) — how `mcp-data-source.ts` renames the class without moving 290 LOC.
- `.aipe/read-aposd/` (chapter on Deep Modules) — the primitive taught abstractly.
- `.aipe/study-system-design/` — the same seam viewed at architecture altitude ("provider abstraction" pattern).
