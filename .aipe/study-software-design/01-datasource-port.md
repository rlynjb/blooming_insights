# DataSource — the port under the agents

Ports & adapters (hexagonal) · Deep module · Industry standard

## Zoom out — where this concept lives

You know how a `fetch()` call doesn't care whether the URL is
hitting NGINX, Vercel, or your laptop? The client depends on the
HTTP contract, not on the server. Same idea. The agents in this
repo hold a `DataSource`, not a Bloomreach client — so anything
that satisfies the port can go behind them.

```
  Zoom out — where the DataSource port sits

  ┌─ Client layer (agents) ──────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent ·                 │
  │  RecommendationAgent · QueryAgent                    │
  └────────────────────────┬─────────────────────────────┘
                           │  hold: DataSource
  ┌─ Port ────────────────▼──────────────────────────────┐
  │  ★ DataSource ★  (lib/data-source/types.ts:63)        │ ← you are here
  │     callTool(name, args, opts) → { result, ... }      │
  │     listTools(opts)                                   │
  └────────────────────────┬─────────────────────────────┘
                           │  implemented by
  ┌─ Adapters ────────────▼──────────────────────────────┐
  │  BloomreachDataSource  (live MCP over OAuth)          │
  │  SyntheticDataSource   (fixture, deterministic)       │
  │  FaultInjectingDataSource (decorator — see 03-)       │
  └──────────────────────────────────────────────────────┘
```

The whole point: the agents never import a Bloomreach type, never
know an MCP transport exists, never see an OAuth token. The port
between them is the entire contract.

## Structure pass

**Layers.** Two: the client layer (four agent classes) and the
adapter layer (three adapter classes, one of them a decorator).
The port is the joint between them.

**Axis: control.** Who decides which adapter is in play? Not the
agent — the agent receives whatever `DataSource` its constructor
was handed. The route handler / eval runner picks. Control flips
outward at construction, then never moves again during the
investigation.

**Seams.** One seam of interest: the `DataSource` interface. A
load-bearing seam because the *identity of the backend* flips
across it. On the client side it's "some data source." On the
adapter side it's Bloomreach-specific concerns (OAuth, rate limit,
retry ladder) or Synthetic-specific concerns (deterministic
event tables) or Fault-injecting concerns (probability rolls).

## How it works

### Move 1 — the mental model

The pattern is *ports & adapters* (also called hexagonal, or
dependency-inversion at the boundary). Three roles, one seam:

```
  Ports & adapters — the shape

           holds ─────────────►
    ┌──────────┐              ┌───────────────┐
    │  client  │              │      port     │
    │ (agents) │──depends-on──│ (DataSource)  │
    └──────────┘              └──────┬────────┘
                                     │  implemented by
                     ┌───────────────┼───────────────┐
                     ▼               ▼               ▼
              ┌───────────┐  ┌───────────┐   ┌───────────────┐
              │ Bloomreach│  │ Synthetic │   │FaultInjecting │
              │  (live)   │  │ (fixture) │   │ (decorator)   │
              └───────────┘  └───────────┘   └───────────────┘
                     ▲               ▲               ▲
                     └── adapters ───┴───────────────┘
                     each one satisfies the port's shape
```

- **port** — the interface every adapter must satisfy. Owned by
  the codebase (`DataSource` in `types.ts:63`). Holds no behavior.
- **adapter** — an implementation of the port. Wraps a real
  vendor (Bloomreach MCP), a fixture (Synthetic), or wraps
  another adapter (FaultInjecting decorator).
- **client** — code that depends on the port and never touches
  an adapter directly. The four agents.
- **seam** — the swap boundary. Everything above it is Blooming-
  owned; everything below it can be swapped independently.

### Move 2 — the walkthrough

**The port itself.** Two methods, nothing else.

```typescript
// lib/data-source/types.ts:63-71
export interface DataSource {
  callTool(                                 // one method to invoke a tool
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult>;

  listTools(opts?: DataSourceListOptions): Promise<unknown>;
}
```

Annotation:
- Line 64 (`callTool`) — the workhorse. Takes a tool name (the
  MCP tool the agent picked, e.g. `execute_analytics_eql`), the
  args the agent chose, and returns the standard envelope.
- Line 70 (`listTools`) — bootstrap. Called once at investigation
  start so the agents know what surface the adapter exposes.

That's the whole port. Two methods. Zero fields. Zero adapter-
specific state. This is why depth ratio here is ~1:100 — the
interface is 15 lines of signature and the three adapters
underneath it are ~740 LOC of real work.

**The envelope — matching behavior across adapters.**

```typescript
// lib/data-source/types.ts:53-57
export interface DataSourceCallResult {
  result: unknown;    // opaque; unwrap<T>() at call site
  durationMs: number; // measured; adapters return 0 if not tracked
  fromCache: boolean; // Bloomreach uses it; Synthetic returns false
}
```

Annotation:
- `result` stays `unknown` on the port. This is deliberate — call
  sites cast via `unwrap<T>(result)` in `lib/mcp/schema.ts`, which
  is the single place that knows about the MCP result shape
  (`structuredContent` preferred over `content[0].text`).
- `fromCache` isn't a Bloomreach-specific concern *conceptually* —
  any adapter could cache — so it lives on the port. `SyntheticDataSource`
  returns `false`; `BloomreachDataSource` returns `true` when it
  hits its 60s response cache.

**The adapter — Bloomreach as one concrete example.**

```typescript
// lib/data-source/bloomreach-data-source.ts:1-16 (header)
// The Bloomreach adapter — implements the DataSource interface over a
// connected MCP transport. Carries the OAuth/PKCE/DCR-driven Bloomreach
// loomi connect session (lib/mcp/auth.ts + lib/mcp/connect.ts), the ~1
// req/s proactive spacing, the rate-limit retry ladder ..., the
// AbortSignal composition for cancellation, and the 60s response cache
// that absorbs repeats.
```

Annotation: every one of those concerns — OAuth, spacing, retry
ladder, cancellation, cache — lives inside this file. Not one of
them appears in the port. Not one appears in the agents. That's
what "hides ~200 LOC of decisions" means concretely: the agent
calls `dataSource.callTool('execute_analytics_eql', {...})` and
the retry ladder just happens.

**The client — how an agent uses the port.**

```typescript
// lib/agents/monitoring.ts:73-93 (constructor + scan method)
export class MonitoringAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,        // ← the port (aliased as McpCaller)
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}

  async scan(hooks?: MonitorHooks, categories: AnomalyCategory[] = []): Promise<Anomaly[]> {
    const toolRegistry = new BloomingToolRegistryAdapter(this.dataSource, this.allTools);
    // ...
  }
}
```

Annotation:
- `private dataSource: McpCaller` (line 76) — the port. Not
  `BloomreachDataSource`, not `SyntheticDataSource`, just the
  port. (`McpCaller` in `lib/agents/base.ts` is a type alias for
  `DataSource` — see audit lens 7, the alias should probably go
  away, but the shape is right.)
- Line 83 — the tool-registry adapter (aptkit-side) receives the
  port. Nothing in the aptkit bridge knows Bloomreach exists either.

**Substitution in practice — four live uses of the seam.**

1. **Olist added, then removed.** An Olist SQL-backed adapter
   previously satisfied this port; it was removed. No agent code
   changed to add or remove it — see `types.ts:6-9`.
2. **Synthetic added.** `SyntheticDataSource`
   (`synthetic-data-source.ts` — 516 LOC of fixture generator)
   satisfies the port. Same agents, same call sites. Used by
   evals + the `live · synthetic` mode toggle on the feed
   (`app/page.tsx:172`).
3. **FaultInjecting wraps.** The decorator (`03-fault-injecting-decorator.md`)
   wraps *any* other adapter. Same port. Wrapping is
   composition, not replacement.

Four uses means the seam has paid rent four times.

### Move 3 — the principle

A deep module is one where a small interface hides a large body
of behavior. The measure isn't lines-of-signature vs lines-of-body
(a ratio); it's how much you can rebuild the body from the
interface. You can't rebuild the OAuth ladder, the rate-limit
retry, or the fault-injection PRNG from `callTool(name, args)`.
You also can't leak upward from them without breaking the
signature. That's what depth buys — you can change everything
below and nothing above needs to know.

## Primary diagram

```
  DataSource — the seam under the agents

  ┌──────────────────────────────────────────────────────────────┐
  │ Client layer                                                 │
  │  MonitoringAgent  DiagnosticAgent  RecommendationAgent  QueryAgent │
  └───────┬───────────────┬───────────────┬───────────────┬──────┘
          │               │               │               │
          └───────────────┴───────┬───────┴───────────────┘
                                  │  holds
                          ┌───────▼────────┐
                          │  DataSource    │  types.ts:63
                          │  callTool()    │  15 LOC of signature
                          │  listTools()   │
                          └───────┬────────┘
                                  │  implemented by
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
    ┌──────────────────┐ ┌────────────────┐ ┌───────────────────┐
    │ Bloomreach       │ │ Synthetic      │ │ FaultInjecting    │
    │ (214 LOC)        │ │ (516 LOC)      │ │ (167 LOC)         │
    │ OAuth · rate     │ │ deterministic  │ │ decorator — wraps │
    │ limit · retry ·  │ │ EQL fixtures   │ │ any of the other  │
    │ cache · abort    │ │                │ │ two               │
    └──────────────────┘ └────────────────┘ └───────────────────┘
              ▲                   ▲                    ▲
              └───────────────────┴────────────────────┘
                       ~740 LOC of hidden work
                       none of it visible above the seam
```

## Elaborate

The pattern goes by several names. **Ports & adapters** (Alistair
Cockburn's original 2005 paper — the port is a shape, an adapter
plugs into it). **Hexagonal architecture** (same idea, drawn as a
hexagon so you have six sides to attach adapters to). **Dependency
inversion at the boundary** (the abstract dependency-inversion
principle applied to the outermost seam). **Provider abstraction**
in cloud-vendor contexts.

What makes them all the same idea: you invert the direction of
dependency at the boundary between "code you own" (the client)
and "code you don't want to depend on" (the vendor). Without
inversion, the client imports the vendor SDK. With inversion, the
client imports the port, and the adapter that satisfies the port
is the only thing that imports the SDK.

The reason this pattern shows up over and over in code that
survives: vendors change. SDKs deprecate. Rate-limit policies
shift. Test environments need fixtures. Every one of those is a
reason to want to swap adapters without touching the client. If
you didn't have the seam, you'd be rewriting every agent every
time.

Where this repo pushes on the pattern: the third live adapter is a
*decorator*, not a peer. `FaultInjectingDataSource` implements the
port and wraps another `DataSource` — see `03-fault-injecting-decorator.md`
for how that composition works.

## Interview defense

**Q: What makes `DataSource` a deep module?**
Two-method interface (`callTool` + `listTools`), zero fields,
zero adapter-specific config on the port. Under it, three
adapters run ~740 LOC of code the caller never sees: Bloomreach's
OAuth ladder, retry policy, cache; Synthetic's deterministic
fixture tables; the fault injector's PRNG. The four agents
(monitoring, diagnostic, recommendation, query) hold the port
type and swap adapters without changing.

The one-second version: *depth is how much of the body you can't
rebuild from reading the interface.*

**Q: You claim the seam has paid rent. What proves it?**
Four live substitutions with no client-side change. Olist added,
Olist removed, Synthetic added, FaultInjecting wraps. Every one
was accepted through the port's `implements` contract. The
agents' construction signatures didn't move.

**Q: What's the load-bearing part people forget?**
The `{ result, durationMs, fromCache }` envelope. Without it,
adapters would leak their measurement/caching stories upward —
`fromCache` on the port matters because the UI's tool-call trace
shows a cache hit differently from a live call, and that
distinction has to survive the seam. If you dropped the envelope
to just return `unknown`, you'd have to add out-of-band
observability channels for each adapter and the port would stop
being enough.

**Q: What would you do differently?**
Rename `McpCaller` in `lib/agents/base.ts` — it's a type alias
for `DataSource` from the pre-rename era and the alias is now
misleading. It also makes `lib/agents/base.ts` a shallow module
(14 LOC total). Either drop the alias and have the agents
import `DataSource` directly, or rename it `ToolCaller` so the
name matches the abstraction level.

## See also

- `.aipe/read-aposd/` — the book chapter on deep modules.
- `.aipe/study-system-design/` — the same seam at the service
  altitude (provider abstraction).
- `02-aptkit-bridge.md` — the *upper* seam (agents → aptkit) that
  runs the same pattern one layer up.
- `03-fault-injecting-decorator.md` — how the third adapter
  composes with the other two.
