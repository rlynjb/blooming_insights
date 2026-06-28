# RFC 05 — DataSource seam + adapter pattern

**Decision:** Introduce a `DataSource` interface (`lib/data-source/types.ts`,
71 LOC) that exposes only `callTool` and `listTools`. Every consumer — agent,
route handler, bootstrap helper — depends on the interface, never on a
concrete adapter. Two adapters today: `BloomreachDataSource` (HTTPS + OAuth +
rate-limit) and `SyntheticDataSource` (516 LOC, in-process deterministic
fake). One factory (`makeDataSource`) decides which based on `bi:mode`.

## Context

The agents (monitoring, diagnostic, recommendation, query) need to execute
tools to look at the workspace's data. Originally those tools came from one
place — the Bloomreach `loomi-mcp-alpha` server, via the MCP SDK transport,
behind OAuth, rate-limited to ~1 req/s, with the alpha server's habit of
revoking tokens every few minutes.

Three forces showed up over the project's life that argued for a backend
abstraction:

  1. **The Bloomreach server is unreliable.** Token revocations, rate limits,
     hung requests. A live-only product is a fragile product.
  2. **Evals need a deterministic substrate.** You cannot calibrate
     LLM-as-judge against a stochastic upstream that may rate-limit you out
     of a test run.
  3. **The demo path is the reliability floor.** A recruiter clicking the
     link needs to see *something* within 1 second, every time. That can't
     route through the alpha server.

So a backend abstraction was on the table. The default move ("just keep using
`McpClient` directly; pass it everywhere") was the alternative.

The abstraction won, and it's earned its weight by surviving **two adapter
swaps** without changing the caller surface.

## Goals

  → **Agents depend on an interface, not a vendor.** A monitoring agent
    should be able to scan a Bloomreach workspace or a deterministic fake
    workspace without knowing which.
  → **The factory branch lives in one place.** Route handlers branch on
    `bi:mode` and ask the factory for a `DataSource`. They never construct
    an adapter directly.
  → **Adapter-specific concerns stay inside the adapter.** OAuth, rate-
    limiting, retry, the per-call 30s timeout — all live behind
    `BloomreachDataSource`. The synthetic adapter doesn't pay for any of
    them.
  → **Bootstrap (workspace schema) lives behind the same seam.** Different
    adapters bootstrap differently; the factory's `bootstrap` callback
    captures it.

## Non-goals

  → **A generic SQL data source.** Olist (the Brazilian e-commerce SQL
    substrate) was added in Phase 2 and removed in PR #8 (the
    `lib/data-source/index.ts` header notes this). The seam survived its
    removal cleanly. The seam exists for the *current* adapters, not for
    speculative future ones.
  → **A plugin loader.** Adapters are checked in. Adding one is a code
    change to `makeDataSource`, not a runtime config.
  → **Hot-swapping at runtime.** Each request picks a mode at the route
    handler and sticks with it.

## The decision

The interface is what the agents actually call. The adapters are concrete
implementations that satisfy it. The factory is the only place that knows
which mode means which adapter.

```
  DataSource seam — the interface, the adapters, the factory

  ┌─ Consumers (agents, route handlers, bootstrap) ──────────────┐
  │  MonitoringAgent, DiagnosticAgent, RecommendationAgent,      │
  │  QueryAgent, bootstrapSchema, /api/briefing, /api/agent      │
  │  → all depend on `DataSource`, never on a concrete adapter   │
  └─────────────────────────────┬────────────────────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              │                                   │
              ▼                                   ▼
  ┌─ DataSource interface ───────────────────────────────────────┐
  │  lib/data-source/types.ts  (71 LOC)                          │
  │   callTool(name, args, opts?) → { result, durationMs,        │
  │                                    fromCache }               │
  │   listTools(opts?) → unknown                                 │
  └─────────────────────────────┬────────────────────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        │                                               │
        ▼                                               ▼
  ┌────────────────────────────┐         ┌────────────────────────────┐
  │  BloomreachDataSource      │         │  SyntheticDataSource       │
  │  214 LOC                   │         │  516 LOC                   │
  │  • McpClient wrapper       │         │  • in-process fake         │
  │  • OAuth (PKCE+DCR)        │         │  • deterministic results   │
  │  • ~1 req/s rate-limit     │         │  • 0ms latency             │
  │  • 30s per-call timeout    │         │  • no network              │
  │  • cookie-encrypted auth   │         │  • drop-in agent loop      │
  └────────────────────────────┘         └────────────────────────────┘
                ▲                                       ▲
                │                                       │
                └─────────────┬─────────────────────────┘
                              │
  ┌─ Factory: makeDataSource(mode, sessionId) ───────────────────┐
  │  lib/data-source/index.ts                                    │
  │   'live-bloomreach'  → connectMcp(sessionId) → Bloomreach    │
  │   'live-synthetic'   → new SyntheticDataSource()             │
  │   (the 'demo' branch never reaches the factory — the route   │
  │    serves the committed snapshot directly)                   │
  └──────────────────────────────────────────────────────────────┘
```

**Verdict-first:** the seam is two methods on an interface, two adapters
behind it, one factory in front. Agents don't know which one they're
talking to.

### The load-bearing parts of the interface

`DataSource` is small on purpose. Look at what's NOT in it:

```ts
// lib/data-source/types.ts:63-71 — the entire interface
export interface DataSource {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult>;

  listTools(opts?: DataSourceListOptions): Promise<unknown>;
}
```

Two methods, both returning the `{ result, durationMs, fromCache }` envelope
that mirrors `McpClient` exactly. The envelope shape is load-bearing —
**every agent's tool-call trace reads `durationMs` and `fromCache` to render
the `ToolCallBlock` UI**. Drop those fields and the streaming `StatusLog`
loses its duration display.

What's not in the interface is as important as what is:

  → **No OAuth.** The Bloomreach adapter handles auth internally; the
    synthetic adapter has none. Putting it in the interface would force
    the synthetic adapter to fake it.
  → **No caching opts.** `BloomreachDataSource` exposes `skipCache` and
    `cacheTtlMs` on its concrete class, not on the interface, because
    `SyntheticDataSource` is deterministic and instant — caching is
    meaningless there.
  → **No bootstrap.** Different adapters bootstrap differently. The factory
    returns a `bootstrap` callback so the route handler doesn't care which
    shape it took.

### The factory — one switch, one return type

```ts
// lib/data-source/index.ts:67-100 (simplified)
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
  // live-bloomreach
  const conn = await connectMcp(sessionId);
  if (!conn.ok) return { ok: false, mode, authUrl: conn.authUrl };
  return {
    ok: true, mode, dataSource: conn.mcp,
    bootstrap: (signal?) => bootstrapSchema(conn.mcp, { signal }),
    dispose: async () => {},
  };
}
```

The `{ ok: false, mode, authUrl }` branch is what makes this work for the
live path — the route handler gets back an auth URL when OAuth is needed
and redirects the browser. The synthetic adapter cannot fail this way, so
it always returns `ok: true`. Same factory, two failure surfaces, one
consumer-side check.

## Alternatives considered

### Alternative A — Keep `McpClient` everywhere

Just pass `McpClient` instances into agents directly. Add a `MockMcpClient`
for tests when needed.

**Why it lost:** Two things, both real.

  1. **The synthetic mode isn't a mock — it's a product surface.** Users
     toggle to `live-synthetic` and run real agent loops against
     deterministic data. That's not "stub for tests"; it's "second adapter
     for the demo + eval substrate." The MCP-shaped surface would be the
     wrong abstraction (it implies OAuth, transport, rate limits — none of
     which the synthetic adapter has).
  2. **Caller-side knowledge of the adapter would leak.** Without the
     interface, every agent constructor would type-annotate `McpClient`.
     Adding `SyntheticDataSource` would be a type change in every consumer.
     The interface keeps the change at the factory.

### Alternative B — Multiple narrow interfaces

`ToolCaller`, `ToolLister`, `WorkspaceBootstrap` — split by capability.

**Why it lost:** Premature. Agents always need both `callTool` and the
schema; route handlers need bootstrap. Splitting buys nothing today. If a
future agent only needs `callTool` (e.g. a pure query agent that doesn't
bootstrap), narrow it then.

### Alternative C — Plugin loader

A `data-sources/` folder with file-based discovery; adapters self-register.

**Why it lost:** Two adapters total, both checked in. Plugin loaders earn
their weight at 5+ adapters with third-party authorship. We have neither.

## Tradeoffs accepted

  → **The interface stays MCP-shaped.** `callTool` / `listTools` is the MCP
    vocabulary. A future adapter to a non-tool backend (e.g. a direct SQL
    query layer) would have to fit itself into the tool envelope or argue
    for a second seam. Acceptable for now; revisit if a non-tool backend
    becomes real.
  → **The `{ result, durationMs, fromCache }` envelope leaks MCP semantics
    into the synthetic adapter.** `SyntheticDataSource` returns
    `durationMs: 0` and `fromCache: false` everywhere. Slightly silly but
    cheap.
  → **The factory branch is hand-coded.** Adding `live-postgres` is a code
    change in two places (`LiveMode` union + `makeDataSource` switch).
    Acceptable — TypeScript's exhaustiveness check catches the second one.
  → **`bootstrap` is part of the factory result, not the interface.**
    Decided this way because the bootstrap shape differs sharply between
    Bloomreach (multi-tool orchestration via `list_cloud_organizations` →
    `list_projects` → `get_event_schema`) and Synthetic (return the
    pre-built `syntheticWorkspaceSchema` constant). Forcing it onto the
    interface would mean either two methods or one that returns
    inconsistent shapes. The factory closure is cleaner.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| A new adapter forgets to set `durationMs` or `fromCache` | TypeScript requires both fields; CI catches it. |
| The interface drifts to accommodate adapter-specific options | Adapter-specific options stay on the concrete class (`BloomreachDataSource.skipCache` etc.). The interface stays minimal by policy. |
| The Bloomreach adapter's per-call timeout doesn't compose with the route signal | It does — `lib/mcp/transport.ts:38` sets `TOOL_TIMEOUT_MS = 30_000` and composes it with the route signal at line 131 via `composeSignals`. First signal to fire wins. (Earlier rehearse books incorrectly noted this as a gap — it has been verified against current code.) |
| A future synthetic-style adapter forgets to enforce the same shape contract as the live one (different tool names, different result envelopes) | The agents' tool schemas (`lib/agents/tool-schemas.ts`) are validated at adapter-construction time in tests; a mismatched synthetic adapter fails the eval suite before it ships. |

## Rollout / migration — the seam survived two swaps

This is the part that earns the seam its weight in this RFC.

```
  Adapter history — what was added, what was removed, what stayed

  Phase 1                  Phase 2                  Today
  ────────                 ────────                 ─────
  BloomreachDataSource     BloomreachDataSource     BloomreachDataSource
                           + OlistDataSource        + SyntheticDataSource
                             (SQL-backed)            (in-process fake)

                           PR #8 (2026-06-18):
                             OlistDataSource removed
                             SyntheticDataSource added
                             same interface, no
                             caller-surface change
```

  → **Phase 1:** One adapter. The interface existed but was monomorphic.
  → **Phase 2 (added 2026-06-15):** Olist adapter joined behind the
    interface. The Phase 3 eval flywheel built its 4-pillar suite on Olist
    (detection / diagnosis / recommendation / regression). LLM-as-judge
    calibrated 8/8 + 3/3 manual spot-check. The eval surfaced three real
    bugs: BRL cents-vs-Reais (the judge caught it at run 8, R$131,965
    implausible AOV); binary calibration (29/30); conclusion-instability
    (30%). All three were *inside* the agents, not the adapter — evidence
    the seam wasn't hiding the bugs.
  → **PR #8 (removed 2026-06-18):** Olist adapter removed. Synthetic
    adapter added in the same shape. **Zero caller-surface change.** The
    agents didn't know the substrate moved. The factory's switch grew one
    branch, lost another.

Two adapter swaps without changing the caller surface is the receipt that
this is a real abstraction, not future-proofing. The next eval flywheel
runs against Synthetic.

## Open questions

  → **Should `bootstrap` live on the interface?** Today it's a factory
    closure. A future adapter whose schema changes per session (a
    multi-tenant fake?) might want it. Open — revisit if the case arises.
  → **A non-tool backend** (direct SQL, direct HTTP without MCP envelope)
    would force the interface to grow a second shape, or a sibling
    interface (`QueryRunner`?). Today every realistic backend fits the
    tool envelope; revisit when one doesn't.
  → **Per-adapter telemetry.** Today the `durationMs` field is the only
    cross-adapter latency signal. A richer envelope (`{ result, latency,
    tokensIn?, tokensOut? }`) would unify how the synthetic adapter's free
    calls and the Bloomreach adapter's billed calls show up in the trace.
    Open — would change the envelope for all consumers.

---

**Coach note:** When a reviewer says "isn't this just an interface around
one thing?" the answer is **"it was — then it had two adapters, now it has
two different ones, and the consumer surface never moved."** That's the
test that separates a real seam from speculative future-proofing.
