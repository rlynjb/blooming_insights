# Injected DataSource fake

*Ports and adapters (hexagonal architecture) · Industry standard · Deterministic side*

`DataSource` is a port. Three real adapters implement it — `BloomreachDataSource`
(production), `SyntheticDataSource` (offline evals + demos), `FaultInjectingDataSource`
(load harness). Tests inject whichever adapter they need. The agents and
the API routes depend only on the port; swapping adapters is a factory
choice, not a rewrite.

## Zoom out, then zoom in

```
  Zoom out — where the DataSource port lives

  ┌─ Provider ──────────────────────────────────────────────────┐
  │ Bloomreach loomi connect MCP server                          │
  │ (OAuth-protected, rate-limited alpha)                        │
  └───────────────────────────┬──────────────────────────────────┘
                              │ HTTP + StreamableHTTPClientTransport
  ┌─ Service — lib/data-source ────────────────────────────────────┐
  │                                                                │
  │      ★ DataSource (port) ★  ← the abstraction the app codes to │
  │       ├─ callTool(name, args, opts) → { result, durationMs,    │
  │       │                                 fromCache }             │
  │       └─ listTools() → { tools: [...] }                         │
  │                                                                 │
  │   Three adapters implement the port:                            │
  │   ┌─ BloomreachDataSource     ─┐  used by app/api/*/route.ts    │
  │   ┌─ SyntheticDataSource       ─┤  used by eval/run.eval.ts     │
  │   ┌─ FaultInjectingDataSource  ─┘  wraps either of the above    │
  └────────────────────────┬───────────────────────────────────────┘
                           │ callTool / listTools
  ┌─ Service — lib/agents ─▼──────────────────────────────────────┐
  │ runAgentLoop(anthropic, dataSource, schema, tools, …)          │
  │   ← never opens a socket; only calls dataSource.callTool()     │
  └────────────────────────────────────────────────────────────────┘
```

The port is `lib/data-source/types.ts`. The three adapters are:
`lib/data-source/bloomreach-data-source.ts`,
`lib/data-source/synthetic-data-source.ts`,
`lib/data-source/fault-injecting.ts`.

## Structure pass

- **Layers**: the port sits between the agents (which don't care where
  data comes from) and the adapters (which each have their own I/O
  concerns).
- **Axis (dependency)**: the arrow points *at* the port, from both sides.
  Agents depend on the port. Adapters implement the port. Nothing in
  `lib/agents` imports from `lib/data-source/{bloomreach,synthetic,fault-injecting}`
  — only from `types.ts`.
- **Seam**: the port itself. Every test that swaps a `DataSource` is
  crossing this seam. Every load test that decorates one adapter with
  another (`FaultInjectingDataSource(new SyntheticDataSource(...))`) is
  stacking swaps at the same seam.

## How it works

Three uses of the port to walk. Each is a distinct testing capability.

### Move 1 — the shape

You've built with this before. `useState` doesn't care whether the value
comes from a form input, a `fetch`, or `localStorage` — it's just "value
in, setter out." An interface is a contract the caller can rely on no
matter who implements it. Here the contract is:

```
  interface DataSource {
    callTool(name, args, opts?): Promise<{result, durationMs, fromCache}>
    listTools(): Promise<{tools: [...]}>
  }
```

Two methods. Any object that has them can play. The seam is that
narrow.

```
  Three adapters, one port

    ┌──── DataSource port ────┐
    │  callTool()             │
    │  listTools()            │
    └─────┬────┬────┬─────────┘
          │    │    │
     ┌────▼┐  ┌▼───────┐  ┌▼─────────────┐
     │Bloom │  │Synth  │  │FaultInject   │
     │reach │  │etic   │  │(wraps either)│
     └──────┘  └───────┘  └──────────────┘
      HTTP     in-memory   probability-based
      OAuth    fixtures     failure surface
```

### Move 2 — the three uses in this repo

#### The unit test use: inline fake

`test/agents/base.test.ts:76-83` builds a `buildFakeMcp(impl)` — a
one-method fake that ignores `listTools` and only implements `callTool`:

```typescript
function buildFakeMcp(impl: (name: string, args: Record<string, unknown>) => Promise<unknown>): McpCaller {
  return {
    async callTool(name, args) {
      const result = await impl(name, args);
      return { result, durationMs: 1, fromCache: false };
    },
  };
}
```

Note the return shape matches the port envelope exactly: `{result,
durationMs, fromCache}`. The unit test doesn't care about `durationMs`
so it hardcodes 1. The `fromCache: false` is honest — this fake never
caches, so it's never a hit.

Test usage looks like `buildFakeMcp(async () => ({ isError: false, ok:
true }))` — you pass a function that maps `(name, args) → result`, and
the agent loop runs against it as if it were the real MCP.

#### The integration test use: scenario-driven fake

`test/api/_helpers.ts:288-339` builds `makeMockTransport(scenario, opts)`
— a fake that takes a scenario tag and returns the corresponding
behavior. Four scenarios:
- `'ok'` — happy path, bootstrap calls return realistic
  `structuredContent` for each MCP tool.
- `'list-tools-fail'` — `listTools()` throws; bootstrap `callTool` still
  works (matches the real failure ordering).
- `'tool-call-fail'` — specific tool name throws an `McpToolError`;
  other tools fall through to happy path.
- `'timeout'` — `callTool` returns `new Promise<never>(() => {})` — a
  never-resolving promise (tests using this MUST drive the clock with
  `vi.useFakeTimers()`, per the comment on line 328).

The bootstrap callTool at `_helpers.ts:169-220` returns realistic MCP
envelopes for every bootstrap-phase tool: `list_cloud_organizations`,
`list_projects`, `get_event_schema`, `get_customer_property_schema`,
`list_catalogs`, `get_project_overview`. Every unknown tool gets a
generic empty-success envelope so the agent loop doesn't blow up if
the model decides to call something the fake didn't script.

This is the fake that runs through the two integration test files. Two
routes, one fake, four scenarios that cover the failure surface the
routes need to handle.

#### The eval use: real deterministic substrate

`lib/data-source/synthetic-data-source.ts` (~1000 lines) is a *real* class,
not a test-only fake. It ships in production code, is used by demo
mode, and is what the eval harness calls. It implements
`listTools()` by returning Bloomreach-shaped tool defs (so the agents
call the same tool names) and `callTool(name, args)` by returning
canned analytics results tailored to make specific anomalies appear.
Test at `test/data-source/synthetic-data-source.test.ts` verifies:

```typescript
it('lists Bloomreach-shaped tools for the existing agents', async () => {
  const dataSource = new SyntheticDataSource();
  const listed = await dataSource.listTools();
  const names = listed.tools.map((tool) => tool.name);
  expect(names).toContain('execute_analytics_eql');
  expect(names).toContain('list_scenarios');
  expect(names).toContain('list_cloud_organizations');
});
```

The seam is *identity of surface*. `SyntheticDataSource` MUST expose
the same tool names as Bloomreach, or the agents' allowlist filtering
would drop them and the eval would run against zero tools. This test
pins that.

#### The load harness use: decorator on any adapter

`lib/data-source/fault-injecting.ts:59-68`:

```typescript
export class FaultInjectingDataSource implements DataSource {
  private callIndex = 0;
  private prngState: number;

  constructor(
    private readonly inner: DataSource,
    private readonly options: FaultInjectorOptions,
  ) {
    this.prngState = options.seed ?? 0;
  }
```

The constructor takes `inner: DataSource`. Any adapter fits. In
`eval/load.eval.ts:250-260`:

```typescript
const dataSource = FAULT_ENABLED
  ? new FaultInjectingDataSource(baseDataSource, {
      rates: FAULT_RATES,
      seed: FAULT_SEED != null ? FAULT_SEED + index : undefined,
      onFault: (f) => {
        faultCounts[f.kind] = (faultCounts[f.kind] ?? 0) + 1;
      },
    })
  : baseDataSource;
```

This is the decorator pattern in its cleanest form — same interface as
the thing it wraps, adds a behavior (fault injection) without the
wrapped adapter knowing. → `06-fault-injection-decorator.md`.

### Move 3 — the principle

**Ports and adapters is testable *because* it forces the seam to be
narrow.** Two methods. That's the entire contract every test has to
implement. Compare to a design where the agent imports
`fetchBloomreachEvents` directly — every test would need to
`vi.mock('./bloomreach', ...)` and implement whatever surface the mock
happens to touch, which drifts.

The industry names to know for the interview: **hexagonal architecture**
(Cockburn), **ports and adapters** (same thing, different vocabulary),
**dependency inversion** (SOLID: depend on abstractions). The specific
adapter-of-an-adapter shape (`FaultInjectingDataSource(inner)`) is the
**decorator pattern** (GoF).

## Primary diagram

```
  Injected DataSource — one port, four use sites, three adapters

  ┌── the port ────────────────────────────────────────────────┐
  │ lib/data-source/types.ts:                                  │
  │   interface DataSource {                                    │
  │     callTool(name, args, opts?) → {result, durationMs,       │
  │                                    fromCache}                │
  │     listTools() → {tools: [...]}                            │
  │   }                                                          │
  └──┬──────────┬──────────┬──────────────┬──────────────────┘
     │          │          │              │
     │          │          │              │
   PROD       EVAL      LOAD           UNIT
     │          │          │              │
     ▼          ▼          ▼              ▼
  ┌───────┐ ┌─────────┐ ┌──────────┐  ┌────────────────┐
  │Bloom  │ │Synthetic│ │FaultInj- │  │inline fake in  │
  │reach  │ │(real,   │ │ectingDS  │  │test file:      │
  │DS     │ │ships in │ │(wraps a  │  │  buildFakeMcp( │
  │       │ │prod for │ │concrete  │  │    impl        │
  │       │ │synthetic│ │DS)       │  │  )             │
  │       │ │mode)    │ │          │  │                │
  └───┬───┘ └────┬────┘ └─────┬────┘  └────────────────┘
      │          │            │
      ▼          ▼            ▼
   HTTP      in-memory    inner.callTool()
   OAuth     canned data  + probability roll
              per anomaly  + PRNG-seeded
                            fault sequence
```

## Elaborate

The seam has survived four adapter swaps as of this audit:

1. Bloomreach only (initial)
2. Bloomreach + Olist (a second real store)
3. Bloomreach + Olist + Synthetic (Olist retired shortly after)
4. Bloomreach + Synthetic + FaultInjecting decorator

Each change was one file added to `lib/data-source/`, one new case in
the factory, and zero changes in `lib/agents/` or `app/api/`. That's
the load-bearing test of a port: *how much has to change downstream
when you add or swap an adapter?* Zero is the target.

The **contract test** shape shows up naturally here: any DataSource
must satisfy the same behavioral contract, so a shared test suite that
runs against every implementation would catch drift. This repo doesn't
have that (yet) — each adapter has its own tests. A future finding
would be to extract a `dataSourceContract.test.ts` that runs the same
assertions against `BloomreachDataSource`, `SyntheticDataSource`, and
`FaultInjectingDataSource(new SyntheticDataSource(…))`. Not a critical
gap because the port surface is small, but the shape is there.

## Interview defense

**Q: What's the difference between a port and an interface?**

A: Same thing at the type level in TypeScript. The word "port" comes
from hexagonal architecture and adds a semantic: this is a *seam
across the domain boundary*, not just any interface. In this repo the
DataSource port is the boundary between "our code" (agents, routes,
UI) and "external I/O" (the MCP server, or synthetic data, or fault
injection). Calling it a port signals that its purpose is to keep the
outside from leaking in.

**Q: Why not just use `vi.mock('./bloomreach-data-source')`?**

A: Because the mocked module hides the surface the tests are supposed
to be verifying. With `vi.mock`, the mock's shape is defined at the
test site, drifts from the real module's shape, and passes tests
against a shape the production code doesn't actually depend on. With
the port, every fake implements the same `DataSource` type — TypeScript
enforces surface parity at compile time. When the port grows a method,
every fake fails to compile until it's updated. That's the test the
architecture buys you.

**Q: What breaks if you remove the `durationMs` field from the return
shape?**

A: `McpClient.callTool`'s in-line duration measurement was moved into
the port itself, so `durationMs` in the envelope is what the client
uses to log timing per request. Remove it and the log line goes to
`undefined ms`. Not a correctness bug, but a diagnostics regression.
The `fromCache` field is more load-bearing — the cache layer at
`lib/mcp/client.ts` reports `true` on a hit, and both the log line and
the eval's cost math depend on it. Removing `fromCache` means every
cache hit gets counted as a real API call in cost estimation.

**Q: When would the decorator pattern be the wrong choice?**

A: When the "decoration" has to see or mutate the wrapped adapter's
internal state. `FaultInjectingDataSource` only knows the surface
(`callTool` throws or the inner adapter's result flows through), so
it composes cleanly. If it needed to know which cache entries the
inner adapter has, or intercept a specific field of the return, the
composition would leak — you'd end up either exposing that state
through the port (which everyone else has to see) or reaching around
the port (which breaks the whole model). Decorator is right when the
new behavior is *about* the seam, not about what's behind it.

## See also

- `01-scripted-anthropic-fake.md` — the *other* seam. Same shape
  (inject a fake) at the SDK boundary.
- `06-fault-injection-decorator.md` — the load-harness use of this
  port. Decorator over adapter.
- `03-captured-fixture-schema-tests.md` — how the port's bootstrap
  payloads get pinned against real captured responses.
- `audit.md` lens 3 — tests-as-design-pressure. The port is the
  reason the agents are testable.
