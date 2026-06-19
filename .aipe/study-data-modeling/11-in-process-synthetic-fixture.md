# In-process synthetic fixture

**Industry name(s):** In-process fake · synthetic adapter · interface-conformant test double · fixture-through-the-real-seam · contract test · data-modeling-for-test
**Type:** Industry standard · Language-agnostic · Project-specific (the `SyntheticDataSource` variant — the same `DataSource` interface as the live Bloomreach adapter, in-memory const literals as the data)

> A real architectural pattern at the data-modeling-for-test layer. The repo ships **two** classes that implement the same `DataSource` interface — `BloomreachDataSource` (live MCP over OAuth + rate-limited Bloomreach) and `SyntheticDataSource` (in-process const literals). The agent loop above this seam holds a `DataSource` reference and cannot tell which is which. The synthetic adapter is **deterministic by construction** (every payload is source code; no PRNG, no `Date.now()`), exposes the same `listTools()` surface, and returns results through the same `{ structuredContent, content }` envelope. This is the data-modeling pattern at the *test seam*: keep the contract honest by serving fake data through the same shape as real data, so the loop above never branches on "is this real."

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The pattern lives at the **DataSource seam** — the abstract surface every backend adapter must implement (`lib/data-source/types.ts`). The agent loop band above this seam (monitoring, diagnostic, recommendation, query agents) holds a `DataSource` reference and calls `dataSource.callTool(name, args)`. The implementation underneath can be live (`BloomreachDataSource`) or in-process (`SyntheticDataSource`). The route handler picks one at request time based on the user's mode toggle and the factory in `lib/data-source/index.ts`.

```
  Zoom out — where the in-process synthetic fixture lives

  ┌─ UI client band ───────────────────────────────────────────┐
  │  app/page.tsx                                              │
  │  mode toggle: 'demo' / 'live-bloomreach' / 'live-synthetic'│
  └──────────────────────────┬─────────────────────────────────┘
                             │  ?mode= ride-along in the request
  ┌─ Route handler band ─────▼─────────────────────────────────┐
  │  app/api/{briefing,agent}/route.ts                          │
  │  parseLiveMode(?mode=) → makeDataSource(mode, sessionId)    │
  │  receives a DataSource (cannot tell which subclass)         │
  └──────────────────────────┬─────────────────────────────────┘
                             │  dataSource.callTool(name, args)
  ┌─ DataSource seam ────────▼─────────────────────────────────┐
  │  interface DataSource {              ★ THE CONTRACT          │
  │    callTool(name, args) → {result, durationMs, fromCache}   │
  │    listTools() → unknown                                     │
  │  }                                                           │
  └──────┬───────────────────────────────┬────────────────────┘
         │                               │
         ▼                               ▼
  ┌─ live ────────────────┐   ┌─ in-process synthetic ─────────┐
  │ BloomreachDataSource  │   │ SyntheticDataSource (file 11)  │
  │ OAuth + MCP transport │   │ const literals + switch        │
  │ ~1 req/s rate limit   │   │ no I/O, deterministic           │
  │ session-scoped tokens │   │ free of network                 │
  └───────────────────────┘   └────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this concept answers: how do you serve fake data to the agent loop without letting the loop know it's fake? Two parts: (1) the fake implementation conforms to the **same interface** as the live one — same method signatures, same result envelope, same tool surface; (2) the fake data is **deterministic by construction** — const literals, no PRNG, no clock reads, so the same call returns the same bytes every time. The agent loop never sees a branch. The data is part of the source code.

---

## Structure pass

**Layers.** Four-layer stack: UI client → route handler → DataSource seam → adapter implementation. The interesting layer is the **DataSource seam** — that's where the contract lives. Below it, the two adapters look completely different (OAuth + network vs switch statement + constants) but behave identically from above.

**Axis: substitutability.** For each call the agent makes, can the synthetic adapter answer it indistinguishably from the live one? That's the right axis because the pattern is *literally* about substitutability — the whole point is that the loop above doesn't branch on which adapter is present. Cost is wrong (synthetic is free, live is rate-limited — different cost profiles by design); failure is wrong (synthetic doesn't fail; live can — the asymmetry is acceptable). Substitutability pops the seams: where the answer is yes (`callTool`, `listTools`, the result envelope), the contract holds; where it's no (the `bootstrap` step that does ~4 MCP round-trips for live but just returns the const for synthetic), the factory hides the difference.

**Seams.** Three matter. **Seam 1: agent ↔ DataSource.** Single contract — `callTool(name, args)` returns `{result, durationMs, fromCache}`. Both adapters honor it. **Seam 2: DataSource ↔ data.** Live adapter calls out over the network to MCP; synthetic adapter reads from a top-level const. The shape of the result is identical because both pass through `ok({ structuredContent, content })`. **Seam 3: factory ↔ mode toggle.** The `makeDataSource(mode, sessionId)` function in `lib/data-source/index.ts` is where the substitution happens — one branch per mode, one DataSource returned. The route handler holds only the interface.

```
  Structure pass — substitutability across seams

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  UI · Route · DataSource seam · Adapter implementation    │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  substitutability: can synthetic answer indistinguishably?│
  │  yes for the loop above; no for cost / failure profile    │
  └─────────────────────────────┬────────────────────────────┘
                                │  trace across seams
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  S1: agent ↔ DataSource         ★ CONTRACT HOLDS         │
  │  S2: DataSource ↔ data          ★ SHAPES MATCH (envelope)│
  │  S3: factory ↔ mode toggle      ★ SUBSTITUTION HAPPENS   │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — How it works
```

---

## How it works

### Move 1 — the pattern as a picture

You know how a typical Vitest unit test does `vi.fn().mockResolvedValue({...})` to stub a function? Same idea here, but **at the class level instead of the function level** — a whole second implementation of the interface that returns canned data through the real envelope. The shape of the pattern is one interface, two implementations, one factory.

```
  the pattern — one interface, two implementations

         interface DataSource
         ├ callTool(name, args)
         └ listTools()
                  │
        ┌─────────┴─────────┐
        │                   │
    LIVE                 SYNTHETIC
    OAuth + MCP          const + switch
    network + retry      no I/O
    real data            deterministic
        │                   │
        └─────────┬─────────┘
                  │
            makeDataSource(mode)
                  │
                  ▼
         agent loop (cannot tell which)
```

The kernel is: a class that implements the *same interface* as the real adapter, returning the *same envelope shape* with const-literal data inside. Strip away the envelope conformance and the agent loop has to branch on "is this synthetic"; strip away the determinism contract and the synthetic adapter stops being a fixture. Both are load-bearing.

### Move 2 — the moving parts, one at a time

#### the interface (Seam 1: the contract)

The whole pattern hinges on the interface being *thin enough* that both implementations can honor it cheaply, but *fat enough* that the agent loop has everything it needs. The actual contract is two methods: `callTool(name, args, opts?)` returns a `{result, durationMs, fromCache}` envelope; `listTools(opts?)` returns the tool catalog.

```
  the contract — what every adapter must answer

  callTool(name, args)
    ┌─────────────────────────────────────────────────────┐
    │  IN:  tool name (string), args (any record)         │
    │  OUT: { result, durationMs, fromCache }             │
    │  result = MCP-shaped { structuredContent?, content?,│
    │                        isError? }                    │
    │                                                      │
    │  the agent loop reads `result` and `durationMs`;    │
    │  `fromCache` shows up in the UI trace ("how this    │
    │  was gathered") as a dot color                       │
    └─────────────────────────────────────────────────────┘

  listTools()
    ┌─────────────────────────────────────────────────────┐
    │  IN:  none (signal optional)                         │
    │  OUT: { tools: ToolDef[] }                           │
    │                                                      │
    │  the tool catalog the agent advertises to the LLM.  │
    │  must include every tool the agent might call.       │
    └─────────────────────────────────────────────────────┘
```

What breaks if the result envelope drifts: the agent loop's `unwrap(result)` helper in `lib/mcp/schema.ts` prefers `structuredContent`, falling back to `content[0].text`. The synthetic adapter MUST emit both (it does — see `ok()` at L498). If only one is set, the agent sees a different shape than the live path and the LLM's next tool call may go off-script. The envelope is part of the contract, not a detail.

#### the synthetic implementation (Seam 2: data + dispatch)

`SyntheticDataSource.callTool(name, args)` is a one-line method that defers to `dispatch(name, args)` and wraps the result in the envelope. `dispatch` is a `switch` over the tool name. **One tool, one case, one const literal.**

```
  the dispatch — pseudocode, not actual code

  function dispatch(name, args):
    switch name:
      case 'list_cloud_organizations':
        return ok({ data: [{ id, name }] })            // 1 row
      case 'list_projects':
        return ok({ data: [{ id: PROJECT_ID, name: ... }] })
      case 'get_event_schema':
        return ok({ events: syntheticWorkspaceSchema.events.map(...) })
      case 'execute_analytics':
      case 'execute_analytics_eql':
        return ok({ ...analyticsResult,
                    query: args.eql ?? args.query,    // echo input
                    project_id: args.project_id ?? PROJECT_ID })
      case 'list_segmentations':
        return ok({ data: segments })                  // const literal
      ...
      default:
        return errorResult(name)                        // tool not implemented

  notes:
    - `analyticsResult` is a TOP-LEVEL const (lines 275–307);
      same call → same bytes always (no PRNG, no Date.now())
    - `args` is echoed selectively (the EQL query string is
      passed through) so the UI trace shows what the agent asked,
      but the answer doesn't depend on it
```

What breaks if the determinism is silently broken — say someone adds `Date.now()` to a tool case so the timestamps look fresh — the demo path becomes flaky (re-renders show different timestamps), the agent's tool-call traces become non-comparable, and downstream tests that diff on the JSON start to flake. There's no test asserting "same call → same bytes" today; the audit (file 07) names this as finding #7.

#### the catalog (Seam 1 again: tools advertised vs tools dispatched)

`listTools()` returns a catalog assembled from the MCP `tools` module (`lib/mcp/tools.ts`) — the same source the live adapter uses. Each tool gets a `ToolDef` with a name, a description from a hand-authored map, and a permissive `inputSchema` (`additionalProperties: true`). The catalog and the dispatcher are **two parallel lists** of tool names: one for what's advertised to the LLM, one for what's actually answered.

```
  the parallel-list smell — and why it's tolerated

  ┌─ toolNames[] (the catalog) ─────────────────────────┐
  │  derived from MCP `tools` module                     │
  │  union of: bootstrapTools, monitoringTools,          │
  │            diagnosticTools, recommendationTools,     │
  │            queryTools                                 │
  └──────────────────────────────────────────────────────┘

  ┌─ switch (the dispatcher) ───────────────────────────┐
  │  hand-written cases, one per tool                    │
  │  default branch returns errorResult(name)            │
  └──────────────────────────────────────────────────────┘

  drift risk: a tool added to the MCP module gets advertised
  but lands in the `default` branch → the LLM thinks the tool
  works and gets `{ error: "synthetic tool is not implemented" }`.

  current mitigation: the default branch's payload is shaped
  like a real MCP error, so the agent loop's retry / fallback
  logic at least recognizes it. but the fix is real: every
  tool in toolNames[] should have a dispatcher case.
```

What breaks: a tool is advertised, the LLM picks it, the dispatcher returns `errorResult`, the agent gets `isError: true` back, the retry logic may fire, the cost is wasted budget. The synthetic adapter today covers all the tools the agents actually reach for (the test suite in `test/data-source/synthetic-data-source.test.ts` exercises the agent loops end-to-end against it), but a future tool addition would need a parallel update.

#### the factory (Seam 3: substitution)

The factory `makeDataSource(mode, sessionId)` in `lib/data-source/index.ts` is where the swap happens. For `live-synthetic`, it constructs a fresh `SyntheticDataSource()` and returns it; for `live-bloomreach`, it defers to `connectMcp(sessionId)` which does the OAuth handshake. The route handler holds only the `DataSource` interface — never the concrete class.

```
  the factory — substitution diagram

  makeDataSource(mode, sessionId)
        │
        ├─ mode === 'live-synthetic'?
        │     │ yes
        │     ▼
        │  const dataSource = new SyntheticDataSource()
        │  return { ok: true, dataSource,
        │           bootstrap: async () => syntheticWorkspaceSchema,
        │           dispose:    async () => {} }
        │
        └─ mode === 'live-bloomreach'?
              │ yes
              ▼
           conn = await connectMcp(sessionId)
           if (!conn.ok) → return { ok: false, authUrl }
           return { ok: true, dataSource: conn.mcp,
                    bootstrap: (signal) => bootstrapSchema(conn.mcp, ...),
                    dispose: async () => {} }
```

The interesting asymmetry: the `bootstrap` branch differs by mode. Live bootstrap fans out across ~4 MCP round-trips and projects the result into a typed `WorkspaceSchema`; synthetic bootstrap returns the const `syntheticWorkspaceSchema` directly. The agent above this seam calls `await result.bootstrap()` the same way in both cases — the factory hides the asymmetry behind a function reference. **That's the substitution pattern done right**: the asymmetric work lives in the factory, not in the agent loop.

What breaks: if the agent loop ever reaches around the interface and asks "is this a `SyntheticDataSource`?" using `instanceof`, the substitution is broken. Today no agent code does this. If a future feature wants "synthetic-only" behavior (e.g. show "this is fake data" in the UI), the right answer is to surface that through the interface (a `mode: LiveMode` field on the result) rather than letting the agent loop branch on the concrete class.

### Move 3 — the principle

The in-process synthetic fixture is a data-modeling pattern at the test seam. Two truths: (1) the **shape of the data** is governed by the same interface as the real source — same `WorkspaceSchema`, same `Anomaly[]`, same tool envelope, so the agents can't tell the difference. (2) the **lifecycle of the data** is *opposite* — real data is fetched, possibly rate-limited, possibly failed; fake data is bundled, instant, never fails. The pattern's power comes from honoring (1) while accepting (2) as an asymmetry the factory hides. The lesson generalizes: when you want to substitute a fake for a real implementation at a seam, the data shape is the contract; the lifecycle is the cost you accept.

---

## Primary diagram

The full picture — interface, two implementations, factory, and the const literal as the data.

```
  the in-process synthetic fixture — full recap

  ┌─ AGENT LOOP ─────────────────────────────────────────────┐
  │   monitoring · diagnostic · recommendation · query        │
  │   holds: DataSource (interface only)                       │
  │   never branches on concrete class                         │
  └────────────────────────┬─────────────────────────────────┘
                           │ dataSource.callTool(name, args)
  ┌─ INTERFACE (Seam 1) ───▼─────────────────────────────────┐
  │   DataSource {                                             │
  │     callTool(name, args) → {result, durationMs, fromCache}│
  │     listTools()           → { tools: ToolDef[] }           │
  │   }                                                        │
  └────────────────────────┬─────────────────────────────────┘
                           │ implemented by both
              ┌────────────┴────────────┐
              ▼                         ▼
  ┌─ LIVE ──────────────┐   ┌─ SYNTHETIC ──────────────────┐
  │  BloomreachDataSource│   │  SyntheticDataSource          │
  │  ────────────────────│   │  ──────────────────────────── │
  │  OAuth + MCP         │   │  callTool() → dispatch()      │
  │  ~1 req/s rate limit │   │  dispatch() = switch on name  │
  │  retries, caching    │   │  returns ok({structuredContent,│
  │  result.fromCache    │   │             content})         │
  │   = (real cache)     │   │  result.fromCache = false     │
  │                      │   │  durationMs = Date.now() - t0 │
  │                      │   │                                │
  │                      │   │  data: TOP-LEVEL CONSTS        │
  │                      │   │    syntheticWorkspaceSchema    │
  │                      │   │    analyticsResult             │
  │                      │   │    customers, segments,        │
  │                      │   │    campaigns, scenarios,       │
  │                      │   │    catalogItems                │
  └──────────────────────┘   └────────────────────────────────┘
                           │ both honor the contract
                           │ above this line nothing differs
                           ▼
  ┌─ FACTORY (Seam 3) ──────────────────────────────────────┐
  │   makeDataSource(mode, sessionId)                         │
  │     mode === 'live-synthetic'  → new SyntheticDataSource  │
  │     mode === 'live-bloomreach' → connectMcp(sessionId)    │
  │   returns: { ok, dataSource, bootstrap, dispose }         │
  │   the asymmetric work lives HERE, not in the agent        │
  └──────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

- **Live-synthetic mode in the UI.** The mode toggle on `app/page.tsx` offers `'live-bloomreach'` and `'live-synthetic'` (alongside the demo mode that bypasses agents entirely). When the user picks live-synthetic, the route handler calls `makeDataSource('live-synthetic', sessionId)`, gets a `SyntheticDataSource`, and runs the full agent loop against it. The agents make real tool calls, the LLM does real reasoning, the trace shows real timings — only the data is fake. This is the **demo with the real agent loop** path; it doesn't require OAuth and doesn't burn the Bloomreach rate limit.
- **Local development without Bloomreach credentials.** A developer cloning the repo for the first time can run `npm run dev`, pick the live-synthetic mode in the UI, and exercise the full app without setting up OAuth. The Bloomreach mode is still there for when they have credentials.
- **Testing the agent loops end-to-end.** Tests in `test/data-source/synthetic-data-source.test.ts` (and the agent test suite) use `SyntheticDataSource` directly as the injected data source. The agents run their real loops against deterministic data; the test asserts on the shape of the result.

### The interface contract

```
lib/data-source/types.ts  (lines 17–71)

  export interface DataSource {
    callTool(
      name: string,                                ← tool name (any tool advertised)
      args: Record<string, unknown>,               ← agent's tool input
      opts?: DataSourceCallOptions,                ← signal etc.
    ): Promise<DataSourceCallResult>;              ← envelope (see below)

    listTools(opts?: DataSourceListOptions): Promise<unknown>;
  }

  export interface DataSourceCallResult {
    result: unknown;                               ← MCP-shaped result
    durationMs: number;                            ← for the UI trace
    fromCache: boolean;                            ← shown in trace dot
  }
       │
       │  the contract is intentionally MINIMAL — two methods,
       │  one envelope. anything more would couple the agent
       │  to a specific adapter. the file comment names this:
       │  "Defined by what the agents + bootstrapSchema actually
       │   consume from the existing McpClient surface".
       └──
```

### The synthetic implementation

```
lib/data-source/synthetic-data-source.ts  (lines 314–331)

  export class SyntheticDataSource implements DataSource {
    async listTools(_opts?): Promise<{ tools: ToolDef[] }> {
      return { tools: toolDefs };                  ← const catalog (L153–166)
    }

    async callTool(name, args = {}, _opts?): Promise<DataSourceCallResult> {
      const started = Date.now();                  ← envelope honesty:
      const payload = this.dispatch(name, args);     real durationMs even if
      return {                                       the data is fake
        result: payload,
        durationMs: Date.now() - started,
        fromCache: false,                          ← always false — synthetic
      };                                              doesn't cache (the data IS
    }                                                 already in memory)
  }
       │
       │  the class is THIN. the work is in dispatch().
       │  callTool's only job is the envelope; dispatch's only
       │  job is the per-tool data.
       └──
```

### The dispatch (the switch over tool name)

```
lib/data-source/synthetic-data-source.ts  (lines 333–495)  ← excerpt

  private dispatch(name: string, args: Record<string, unknown>): ToolResult {
    switch (name) {
      case 'list_cloud_organizations':
        return ok({ data: [{ id: 'org-synthetic-blooming',
                             name: 'Synthetic Blooming Org' }] });
      case 'list_projects':
        return ok({ data: [{ id: PROJECT_ID, name: PROJECT_NAME }] });
      case 'get_event_schema':
        return ok({                                ← projects the const literal
          events: syntheticWorkspaceSchema.events.map((event) => ({
            type: event.name,
            properties: { default_group: {
              properties: event.properties.map((property) => ({ property })),
            }},
          })),
        });
      case 'execute_analytics':
      case 'execute_analytics_eql':                ← two tools, one payload
        return ok({
          ...analyticsResult,                      ← top-level const L275–L307
          query: args.eql ?? args.query ?? args.analysis ?? null,
          project_id: args.project_id ?? PROJECT_ID,
        });
      ...
      default:
        return errorResult(name);                  ← the parallel-list smell
    }
  }
       │
       │  every case ends in ok(...) — the envelope is uniform.
       │  the `default` branch is the smell named above:
       │  a tool advertised by listTools but missing from the
       │  dispatcher will land here and return an isError result.
       └──
```

### The factory (where the substitution happens)

```
lib/data-source/index.ts  (lines 67–100)

  export async function makeDataSource(
    mode: LiveMode,
    sessionId: string,
  ): Promise<MakeDataSourceResult> {
    if (mode === 'live-synthetic') {                ← the synthetic branch
      const dataSource = new SyntheticDataSource();
      return {
        ok: true,
        mode,
        dataSource,                                  ← the only DataSource the
                                                       route ever sees
        bootstrap: async () => syntheticWorkspaceSchema,
                                                     ← the asymmetry: bootstrap
                                                       for synthetic is instant,
                                                       for live is 4 round-trips
        dispose: async () => {},                     ← noop — no resources held
      };
    }

    // live-bloomreach — defer to the existing connect path. it owns the OAuth
    // dance, including the case where the session has no valid tokens (returns
    // `{ ok: false, authUrl }` so the route can redirect).
    const conn: ConnectResult = await connectMcp(sessionId);
    if (!conn.ok) return { ok: false, mode, authUrl: conn.authUrl };
    return { ok: true, mode, dataSource: conn.mcp,
             bootstrap: (signal) => bootstrapSchema(conn.mcp, { signal }),
             dispose: async () => {} };
  }
       │
       │  the route holds the result. it calls `result.dataSource.callTool(...)`
       │  the same way regardless of mode. the bootstrap asymmetry is hidden
       │  behind a function reference — the route awaits it the same way.
       └──
```

### The const literals (the data IS the source code)

```
lib/data-source/synthetic-data-source.ts  (lines 85–108, 275–307)

  export const syntheticWorkspaceSchema: WorkspaceSchema = {
    projectId: 'synthetic-blooming-project',
    projectName: 'Synthetic Blooming Workspace',
    events: syntheticEvents,                       ← 10 events with property lists
    customerProperties: [...],                     ← 9 customer properties
    catalogs: [...],                               ← 2 catalogs
    totalCustomers: 126_420,                       ← stable big number
    totalEvents:    757_710,                       ← sum of event counts
    oldestTimestamp: Date.UTC(2025, 11, 1),        ← 2025-12-01
    dataHorizon: { from: '2025-12-01',             ← 182-day window
                   to: '2026-06-01',
                   durationDays: 182 },
  };
       │
       │  ★ every field is a literal. no Date.now(), no Math.random(),
       │    no PRNG. the data is part of the bundle.
       └──

  const analyticsResult = {                        ← the payload for both
    summary: '...',                                  execute_analytics tools
    currency: 'USD',
    anomalies: [...],                              ← 2 hand-authored anomalies
    rows:     [...],                               ← 2 time-bucket rows
    funnel:   { view, cart, checkout, purchase },
    history:  [...],                               ← 12 weekly values
  };
       │
       │  ★ same call returns the same bytes. determinism is implicit —
       │    no test asserts it (audit file 07, finding #7).
       └──
```

---

## Elaborate

The in-process synthetic fixture is one point on a spectrum of "how do you serve fake data to a system that thinks it's getting real data." The cheapest end is a `vi.fn().mockResolvedValue({...})` stub — one function, one call site, gone after the test. The most elaborate end is a containerized fake service (TestContainers, LocalStack) — a full subprocess that speaks the wire protocol. The synthetic adapter sits in the middle: a class that implements the same in-process interface as the real implementation, returning const-literal data. The right point on the spectrum depends on three questions: how often is the fake reached for? what does conformance to the real interface buy you? how expensive is the alternative?

This repo's answers: (1) the fake is reached for in the live-synthetic mode AND in every agent-loop test — high frequency. (2) Conformance buys you the full agent loop running through the *same* code path as production — high confidence. (3) The alternative (run Bloomreach in CI) costs OAuth, rate-limits, and credentials. So the in-process synthetic fixture lands in the sweet spot.

The deeper structural point: the **DataSource interface is the load-bearing piece**. Without it, the route handler would have to construct a `BloomreachDataSource` directly, the test setup would have to swap class names, and every consumer would carry a "do I have a real one or a fake one?" check. With the interface, substitution is one factory branch. The cost of defining the interface (the `lib/data-source/types.ts` file, ~70 lines) buys substitutability across the whole agent stack.

A note on what the synthetic adapter is **not** doing: it isn't generating *novel* data on each call. It isn't seeded by a request id; it isn't varying timestamps to look fresh; it isn't simulating rate-limit errors. Those would all be reasonable extensions — but they'd also turn the contract from "deterministic by construction" to "deterministic if you pass the same seed." Today's pure-const approach is the simplest version of the pattern. The day the synthetic mode needs to simulate failures or per-request variation, a seeded PRNG (mulberry32-style) earns its place; until then, it's complexity nobody needs.

The historical context: this pattern *replaced* a previous attempt (the Olist SQLite warehouse + `mulberry32(seed=42)` seeder + ground-truth `seeded_anomalies` table) that lived in the repo briefly during 2026-06 and was removed in PR #8. File 09 is the historical write-up of that earlier pattern. The new pattern is strictly simpler — same agent-facing interface, much smaller surface area, no subprocess, no DB file, no seeder script. The Olist pattern had an answer to "how do you grade detection precision against ground truth"; the new pattern doesn't. That's an honest tradeoff: the eval pipeline that needed ground truth is also gone, so the simpler fixture is the right shape for what's left.

## Interview defense

**Q: Walk me through the data-modeling-for-test pattern in this repo.**
A: There are two implementations of the same `DataSource` interface — `BloomreachDataSource` (live MCP over OAuth, ~1 req/s rate limit, session-scoped tokens) and `SyntheticDataSource` (in-process, const literals, deterministic by construction). The interface is two methods: `callTool(name, args)` returning a `{result, durationMs, fromCache}` envelope, and `listTools()` returning a tool catalog. The agents above this seam hold a `DataSource` reference and never branch on which concrete class they have. The factory `makeDataSource(mode, sessionId)` is where the substitution happens — one branch per mode, one DataSource returned. The synthetic adapter exists for two use cases: the live-synthetic mode in the UI (run the real agent loop against fake data without OAuth or rate limits), and the test suite (inject the synthetic adapter directly into agent-loop tests). The data is part of the source code — top-level const literals like `syntheticWorkspaceSchema` and `analyticsResult` — so the same call returns the same bytes every time.

```
  diagram while you talk

  interface DataSource (lib/data-source/types.ts)
        │
        ├ callTool(name, args) → {result, durationMs, fromCache}
        └ listTools() → {tools: ToolDef[]}
              │
        ┌─────┴─────┐
   live     synthetic
   OAuth    const + switch
   MCP      no I/O
        └─────┬─────┘
              ▼
        makeDataSource(mode) — the substitution point
              │
              ▼
        agent loop (cannot tell which)
```

**Anchor:** the interface is the contract; const literals are the determinism.

**Q: What's load-bearing about this pattern? What would break if you skipped it?**
A: Two parts are load-bearing. **(1) The same envelope shape** on both sides — both implementations return through `ok({ structuredContent, content })`. If the synthetic side emitted only one of those, the agent's `unwrap(result)` helper would behave differently on the synthetic path than the live path, and the LLM's next tool call could go off-script. **(2) The determinism contract** — every payload is a const literal. If someone adds `Date.now()` to a tool case, the demo path becomes flaky and tests that diff on JSON start to flake. There's a real audit finding (#7 in file 07) that this contract isn't asserted in code today — a doc comment + a byte-equality test would fix it in ~30 minutes.

**Q: When does the synthetic adapter NOT earn its place?**
A: When the system under test is the *transport* itself — OAuth, rate limiting, retry, network failure. The synthetic adapter sits *above* the transport, returning canned data through the envelope. Anything that depends on real transport behavior (token expiry, rate-limit responses, partial network failures, the alpha Bloomreach server's "revoke after minutes" quirk) can't be tested with this — you'd need either the real adapter against a staging Bloomreach, or a separate fake transport that simulates failures. The in-process synthetic fixture is for testing *agent reasoning*, not network behavior.

```
  diagram while you talk

  ✓ tests reasoning, prompts, tool selection, loop termination
  ✗ tests rate-limit retry, token refresh, partial responses,
    network timeouts, OAuth flows

  the line is: anything that requires the LIVE transport behavior
  isn't testable with the in-process fake. that's not a bug;
  it's the boundary of what the pattern covers.
```

## Validate

1. **Reconstruct.** Without opening the files: name the two methods on the `DataSource` interface and the three-field result envelope of `callTool`. Why does `fromCache` always return `false` from the synthetic adapter, and what would be misleading about returning `true`?

2. **Explain.** The factory `makeDataSource(mode, sessionId)` returns *different* `bootstrap` functions for live vs synthetic (one fans out across ~4 MCP round-trips; the other returns the const directly). Why is this asymmetry **correct**, not a smell? (Hint: trace what each one does and what the agent above the factory sees.)

3. **Apply.** Suppose you want to add a new tool, `get_funnel_breakdown`, that breaks down a funnel by customer segment. Trace the changes needed: which MCP module gets it added to (so it shows up in `toolNames`), which dispatcher case has to be written in `SyntheticDataSource`, and what shape the const literal must have. What's the simplest test you'd write to catch the day someone advertises the tool without implementing the case?

4. **Defend.** Someone proposes replacing the const-literal approach with a seeded PRNG (mulberry32-style) so the synthetic data can vary across calls without losing determinism. Defend the *current* pure-const approach for THIS repo today. At what point would the seeded PRNG earn its place? (Hint: file 09's RETIRED banner names the predecessor that used mulberry32; what use case justified it then that doesn't apply now?)

## See also

- `01-the-data-model-and-its-shape.md` — `WorkspaceSchema` is the typed shape both adapters derive into; the synthetic derivation is the top-level const this file walks.
- `06-access-patterns-and-storage-choice.md` — the three storage layers; the in-process synthetic fixture is layer #3.
- `07-data-modeling-red-flags-audit.md` — finding #7 (no determinism contract test on the synthetic adapter).
- `09-deterministic-synthetic-data.md` — RETIRED. The predecessor pattern (mulberry32 + SQLite + seeded_anomalies). The cousin: same intent (deterministic owned-by-repo fixture), different implementation (in-process vs DB-backed).
- `study-system-design/03-provider-abstraction.md` — the system-design framing of the same seam (provider abstraction over the upstream data source).
- `study-testing/audit.md` — how the synthetic adapter is used in the agent-loop test suite.

---
Created: 2026-06-19 — new pattern file covering the in-process synthetic fixture (`lib/data-source/synthetic-data-source.ts`). Replaces the data-modeling-for-test slot previously held by the deterministic-synthetic-data file (09), which is now RETIRED.
