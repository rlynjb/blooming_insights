# port-and-adapter — the DataSource seam

*Industry standard.* The port/adapter pattern (also called hexagonal, or ports-and-adapters). The abstraction the callers depend on is `DataSource`; the concrete swappable implementations behind it are the adapters.

## Zoom out, then zoom in

Every backend-data question in this system routes through one interface. Four things live behind it — three real adapters and one decorator — and every one of them was added or removed without a caller change. That's the receipt.

```
  Zoom out — where the DataSource seam lives

  ┌─ UI layer ────────────────────────────────────────────────────┐
  │  app/page.tsx  ·  useBriefingStream  ·  useInvestigation      │
  └───────────────────────────┬───────────────────────────────────┘
                              │  GET /api/briefing | /api/agent
  ┌─ Route layer ─────────────▼───────────────────────────────────┐
  │  briefing/route.ts  ·  agent/route.ts                          │
  │      ↓ holds  DataSource  (never the concrete adapter)         │
  ├───────────────────────────┬───────────────────────────────────┤
  │                     ★ THE SEAM ★                              │  ← we are here
  │             lib/data-source/types.ts::DataSource               │
  ├───────────────────────────┬───────────────────────────────────┤
  │  Adapter layer            │                                    │
  │    BloomreachDataSource   ← live-bloomreach                    │
  │    SyntheticDataSource    ← live-synthetic                     │
  │    FaultInjectingDataSource ← decorator, offline only          │
  └───────────────────────────┬───────────────────────────────────┘
                              │  HTTPS (Bloomreach) | in-process
  ┌─ Provider layer ──────────▼───────────────────────────────────┐
  │  Bloomreach MCP  ·  synthetic fixtures  ·  wrapped-inner       │
  └───────────────────────────────────────────────────────────────┘
```

You're looking at the *only* joint in this codebase that has been swapped four times without a caller ever knowing. Everything else in system-design here rides on it — the demo/live toggle, the eval harness, the load tests, the "swap in a different backend later" story.

Ok — zoom in. The pattern is: the caller depends on an *interface* (`DataSource`), not on any of the concrete classes. A factory (`makeDataSource`) picks which concrete class to instantiate at runtime, and hands the caller back the interface. You've seen the shape as a React `useState`-like hook where the reducer is injected: same idea, one altitude up.

## Structure pass

Two layers, one axis, one seam.

**Layers:** the *caller layer* (route handlers + agent classes) and the *provider layer* (Bloomreach MCP, synthetic fixtures, whatever the decorator wraps).

**Axis:** *dependency direction*. Both layers depend inward on the `DataSource` interface. Neither depends on the other.

**Seam:** `lib/data-source/types.ts:63-71`. This is where the dependency arrows meet.

```
  Structure pass — one axis (dependency direction) across the seam

  ┌─ Caller layer ──────────────────┐
  │  briefing/route.ts               │
  │  agent/route.ts                  │
  │  MonitoringAgent                 │
  │  DiagnosticAgent                 │
  │  RecommendationAgent             │
  │  QueryAgent                      │
  └────────────────┬─────────────────┘
                   │ depends on
                   ▼
   ────────────────────────────────────  seam: DataSource
                   ▲
                   │ depends on
  ┌─ Adapter layer ┴─────────────────┐
  │  BloomreachDataSource            │
  │  SyntheticDataSource             │
  │  FaultInjectingDataSource        │
  └──────────────────────────────────┘

  the axis flips at the seam:
    caller says "I need something that implements DataSource"
    adapter says "I promise to implement DataSource"
    neither depends on the other's concrete file
```

That's the load-bearing invariant. If the axis stopped flipping — if the route handlers started importing `BloomreachDataSource` directly — the seam would go from load-bearing to cosmetic, and the four-shipments receipt would collapse.

## How it works

### Move 1 — the mental model

You've written this shape before. It's the same as passing a reducer to `useReducer` — the hook doesn't know what your reducer does, it just calls it. Or a fetcher passed to SWR. Or a repository injected into a service in a Java-shop backend. The caller says "I need something that supports these two operations"; the runtime picks which concrete thing gets passed in.

Here, the two operations are `callTool` and `listTools`. Everything else — OAuth, rate-limiting, caching, fault injection — is invisible to the caller.

```
  The port-and-adapter kernel — three parts

  ┌─ port (the interface) ──────┐
  │  DataSource                  │   ← the two methods every adapter promises
  │    callTool(name, args, opts)│
  │    listTools(opts)           │
  └──────────┬───────────────────┘
             │ implemented by
             ▼
  ┌─ adapters (the swappable N) ┐
  │  BloomreachDataSource        │   ← real HTTPS + OAuth
  │  SyntheticDataSource         │   ← in-process fake
  │  FaultInjectingDataSource    │   ← decorator wrapping any adapter
  └──────────┬───────────────────┘
             │ constructed by
             ▼
  ┌─ factory (the selector) ────┐
  │  makeDataSource(mode, sid)   │   ← picks the adapter at runtime
  └──────────────────────────────┘

  three parts — remove any one and the seam collapses:
    · no port    → caller has to pick a concrete class at import time
    · no adapter → nothing to inject; caller has to implement it inline
    · no factory → caller has to select which adapter itself — mode leaks
```

### Move 2 — the walkthrough

**The port itself** — `lib/data-source/types.ts:63-71`. This is what every caller sees:

```typescript
export interface DataSource {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult>;

  listTools(opts?: DataSourceListOptions): Promise<unknown>;
}
```

Two methods. That's the entire contract. Notice what's *not* here: no `authenticate()`, no `disconnect()`, no `retryLadder()`. Those are Bloomreach-specific concerns; they live on the concrete class, not on the port. If they leaked into the interface, every adapter would owe a stub for them, and the interface would stop being cross-adapter.

The `DataSourceCallResult` envelope — `{ result, durationMs, fromCache }` (`lib/data-source/types.ts:53-57`) — is deliberately shaped to match Bloomreach's original `McpClient` return type byte-for-byte. That's the migration receipt: the port was designed *around* the existing adapter's shape, not the other way around. If you'd designed the port first, you'd have picked something cleaner; matching the existing shape meant the caller sites needed *zero code changes* when the port landed.

**Adapter #1 — the live one.** `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts:1-16`) wraps the connected MCP transport with the ~1 req/s spacing, the rate-limit retry ladder that parses the server-stated retry window, and the 60s response cache. It's 214 LOC of adapter concerns. None of that shows up in the port.

The load-bearing detail: the file's own comment names the history — `originally McpClient in lib/mcp/client.ts` — renamed and moved to `lib/data-source/` in the PR-A phase. The internals didn't change. The rename was the whole extraction.

**Adapter #2 — the fake.** `SyntheticDataSource` (`lib/data-source/synthetic-data-source.ts:1-20`) re-implements the response shapes of ~15 Bloomreach tools with deterministic in-process fake data. Ships alongside its own `syntheticWorkspaceSchema` so `bootstrap()` doesn't call the live orchestrator.

Why 516 LOC for a fake? Because the tools it fakes are the ones the agents actually call — and the agents test the response shape (`isError`, `structuredContent`, `content[0].text` — see `lib/mcp/schema.ts::unwrap`). If the synthetic returned a simpler shape, the agents would branch on `mode === 'live-synthetic'` internally, and the seam would be broken from the *inside*. This is a "big fake" trading LOC for a clean seam.

**Adapter #3 — the decorator.** `FaultInjectingDataSource` (`lib/data-source/fault-injecting.ts:59-104`) is the fourth shipment and the most interesting. It doesn't replace an adapter — it *wraps* one. The constructor takes an `inner: DataSource` plus a `FaultRates` config; `callTool` rolls a random number per call and either injects a fault or delegates to `inner.callTool(name, args, opts)`.

```
  Decorator vs swap — two ways to reach through the seam

  swap (adapters #1 and #2):                 decorator (adapter #3):

     caller                                    caller
       │                                         │
       │ DataSource                              │ DataSource
       ▼                                         ▼
   ┌─────────────────┐              ┌─ FaultInjectingDataSource ─┐
   │   Adapter A     │              │   .inner: DataSource        │
   │   OR            │              │        │                    │
   │   Adapter B     │              │        │ pass-through       │
   └─────────────────┘              │        ▼                    │
                                    │   ┌─ Adapter A or B ─┐      │
                                    │   │  (unmodified)   │       │
                                    │   └─────────────────┘       │
                                    └────────────────────────────┘

  both surface the same DataSource to the caller; both cost zero caller changes;
  the decorator adds behavior WITHOUT touching either the port or the wrapped
  adapter — it just implements the port itself and holds one inside.
```

The load-bearing part: the fault injector implements the same `DataSource` interface, so anything upstream — the load harness, an integration test, a debug route — can point at it exactly as if it were a real adapter. This is *the third use of the seam* without a caller-side change, and the second cited proof that the abstraction actually pays for itself.

**The factory** — `lib/data-source/index.ts:67-100`. `makeDataSource(mode, sid)` is a discriminated-union return that hands the caller a fully-connected `DataSource` plus a `bootstrap` closure that knows which schema-fetch path to run (live orchestrator vs. static synthetic schema).

The route handler's job is *only*: parse `mode` from the query string via `parseLiveMode`, call `makeDataSource`, unwrap the result. It never sees `BloomreachDataSource` or `SyntheticDataSource` by name (`app/api/briefing/route.ts:169-188`, `app/api/agent/route.ts:165-181`). That's the receipt: **grep the route handlers for the concrete adapter names and you find nothing.**

**Move 2 variant — the skeleton.** The three-part kernel — port + adapters + factory — is the whole pattern. What breaks when each is missing:

- **No port** → the caller imports a concrete class. Switching modes means editing the caller. First swap costs a rewrite; every future swap costs the same rewrite.
- **No adapters** → nothing implements the port. The pattern isn't wrong, it just isn't *doing* anything. Deleting the seam and inlining the one implementation would be a wash.
- **No factory** → the caller has to `if (mode === 'live-bloomreach') new BloomreachDataSource() else new SyntheticDataSource()`. The mode leaks up into every caller instead of being centralized. Adding a fourth adapter now means editing every caller.

Optional hardening around the kernel: `dispose` (per-adapter lifecycle), `bootstrap` (per-adapter schema-fetch strategy), the `MakeDataSourceResult` discriminated union (per-adapter failure surfaces — Bloomreach fails-open with `{ ok: false, authUrl }`; synthetic can't fail). All of these are add-ons that pay their own way; none is essential to being a port-and-adapter.

### Move 3 — the principle

**A port is only load-bearing if it's been swapped.** Four times through this one — Olist added, Olist removed, Synthetic added, FaultInjecting decorated — with zero changes to any caller. That's the empirical proof the abstraction earns its keep. Ports that never get exercised are decoration; ports that survive four shipments are the reason your architecture ships.

Second-order principle: **decorate before you swap.** The fault injector was the interesting move because it added a whole new capability (offline failure injection) *without* being a fourth alternative. The wrapping form is strictly more composable than replacement — you can stack it, you can inject it into an already-running system, you can turn it off with `new FaultInjectingDataSource(inner, { rates: {} })`. When the port supports decoration, the axes of variation multiply cheaply.

## Primary diagram

```
  The full seam — one port, three real uses, one composition

                        ┌─────────────────────────────────┐
                        │  app/api/briefing/route.ts       │
                        │  app/api/agent/route.ts          │
                        │  MonitoringAgent · DiagnosticAgent│
                        │  RecommendationAgent · QueryAgent│
                        └──────────────┬──────────────────┘
                                       │ holds
                                       │  DataSource  (never the concrete type)
                                       ▼
                        ┌──────────────────────────────────┐
                        │ lib/data-source/types.ts          │
                        │   interface DataSource            │
                        │     callTool()                    │
                        │     listTools()                   │
                        └──────────────┬──────────────────┘
                                       │ produced by
                                       ▼
                        ┌──────────────────────────────────┐
                        │ lib/data-source/index.ts          │
                        │   makeDataSource(mode, sid)       │
                        │   parseLiveMode(raw) → LiveMode   │
                        └──┬───────────────────────────┬────┘
                           │ 'live-bloomreach'         │ 'live-synthetic'
                           ▼                           ▼
    ┌──────────────────────────────────┐   ┌────────────────────────────┐
    │ BloomreachDataSource              │   │ SyntheticDataSource         │
    │   OAuth + PKCE + DCR              │   │   in-process fixtures       │
    │   ~1 req/s spacing                │   │   syntheticWorkspaceSchema  │
    │   retry ladder + 60s cache        │   │   ~15 tool response shapes  │
    │   (214 LOC)                       │   │   (516 LOC — fake big)      │
    └──────────────────────────────────┘   └────────────────────────────┘
                           ▲                           ▲
                           │                           │
                           │  wraps EITHER (decorator) │
                           └───────────┬───────────────┘
                                       │
                        ┌──────────────┴──────────────────┐
                        │ FaultInjectingDataSource         │
                        │   .inner: DataSource             │
                        │   timeout / rate_limit /         │
                        │   server_error / malformed_json  │
                        │   xorshift32 for determinism     │
                        │   (167 LOC · offline only)       │
                        └──────────────────────────────────┘

  four shipments through this port; zero caller-side changes
```

## Elaborate

The pattern is old — Alistair Cockburn coined "hexagonal architecture" (his name for it) in 2005 as a reaction to layered architectures that let the caller reach through to the storage engine. Every modern take (Uncle Bob's "clean architecture," DDD's "repositories," Java's "dependency inversion") is a restatement of the same three-part shape: caller depends on an interface, adapter implements it, factory injects it.

The thing textbook treatments miss: **the pattern only earns its cost after the second swap.** The first adapter you build behind a port is more expensive than inlining. The second is cheaper. The third — and Blooming's FaultInjecting decorator is the third — is where the abstraction wins outright, because now you've built a composition tool, not just a replacement tool.

The Blooming-specific context that makes this land harder than most textbook examples: the Bloomreach loomi connect MCP server is *alpha*. Tokens revoke after minutes, tools change response shapes between versions, rate-limits shift. A codebase without the seam would have every one of those problems leaking into the agent files. Here, they leak into `BloomreachDataSource` alone — one adapter is the whole blast radius. And when the alpha eventually ships GA and simplifies, only that one file needs to change.

What to read next:
- `02-aptkit-boundary.md` — the neighbor pattern. Same three-part shape (port + adapter + factory), applied at a different altitude — this time between Blooming's app code and `@aptkit/core`'s provider-neutral primitives.
- `05-demo-vs-live-mode.md` — how the runtime toggle picks which mode to route to `makeDataSource`, and where that decision falls on the layer boundaries.
- `study-software-design` — the code-level altitude of "port," "adapter," and "seam" as reusable vocabulary. That guide owns the general definitions; this file owns their *application* in this repo.

## Interview defense

**Q: "You've got three adapters and a decorator behind one interface. What's the receipt this abstraction actually pays for itself?"**

A: Four shipments through the seam, zero caller changes. Olist added (Phase 2), Olist removed (PR #8), Synthetic added (Week 3-ish), FaultInjecting decorated (Week 4B). Grep the route handlers for `BloomreachDataSource` and `SyntheticDataSource` — you won't find either name. They only appear in the factory and in tests. That's the load-bearing test: if I stripped the port out, each of those four shipments would have been a rewrite of every route + every agent. Instead each was a new file plus one factory branch.

```
   caller layer  ────────►  DataSource  ◄────────  four shipments
   (unchanged 4×)             (port)                Olist·add
                                                     Olist·remove
                                                     Synthetic·add
                                                     FaultInjector·wrap
```

*Load-bearing part people forget:* the factory. Without it, the mode-selection logic leaks into every caller. Removing the factory silently degrades the seam from "swap without a rewrite" to "swap with a rewrite of every caller that instantiates a data source."

**Q: "Why is the decorator interesting? Isn't it just a fourth adapter?"**

A: No — an adapter *replaces*; the decorator *composes*. `FaultInjectingDataSource` implements `DataSource` AND holds a `DataSource` inside it. That means I can stack it on top of the synthetic adapter for offline load tests, or (hypothetically) on top of the Bloomreach adapter for a controlled chaos-test in staging. The upstream code doesn't know it's wrapped. That's a whole new capability — configurable failure injection — added *without* touching either the port or any existing adapter. Swap-style adapters are additive at the *implementation* axis; decorators are additive at the *composition* axis. When your port supports both, the abstraction is doing real work.

```
   swap:                        decorate:

   caller ─► adapter A           caller ─► [ decorator ─► adapter A ]
                                                            ▲
                                            adds behavior ──┘
                                            without touching adapter A
```

*Load-bearing part people forget:* the decorator implements the same interface as what it wraps. If it exposed even one extra method, the caller would have to know it's wrapped, and the seam would leak. The whole trick is that `.inner: DataSource` is invisible from outside.

**Q: "Where's the risk in this abstraction?"**

A: Two places.

First — **interface drift.** The port matches Bloomreach's `McpClient` shape byte-for-byte because that's the shape callers depended on before the port existed. If Bloomreach's shape ever changes in a way that doesn't fit the port, either the port grows (and every adapter owes the new field), or the Bloomreach adapter starts translating (and hides real behavior from callers). Neither is free. Today, this hasn't happened; watch for it when Bloomreach ships GA.

Second — **fake divergence.** The synthetic adapter re-implements 15+ tool response shapes. Every time Bloomreach adds a tool the agents use, the synthetic has to add it too, or `live-synthetic` silently starts returning `undefined`. There's no compile-time check for this — the port types tools as `unknown`. Move: a smoke test that lists both adapters' available tools and diffs them.

## See also

- `02-aptkit-boundary.md` — the AptKit port-and-adapter pattern at the provider-neutral primitive altitude.
- `05-demo-vs-live-mode.md` — how the runtime toggle picks the mode that drives this seam.
- `06-budget-and-observability.md` — cross-cutting hooks that ride *above* the DataSource seam.
- `07-eval-regression-gate.md` — how the fault-injecting decorator gets exercised in CI.
