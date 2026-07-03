# 02 — Scripted MCP Caller Fake

**Industry name:** *test double implementing a port* (Ports & Adapters
/ hexagonal terminology).
**Type:** Language-agnostic pattern, applied to the `McpCaller` /
`DataSource` interface.
**Determinism side:** DETERMINISTIC. The MCP surface is a network
call in production; in tests we hand the code a synchronous
in-process fake that returns whatever tool result the test needs.

═════════════════════════════════════════════════
Zoom out — where this pattern sits
═════════════════════════════════════════════════

The Anthropic fake (pattern 01) handles the *outer* seam of an agent
turn (LLM response). The MCP fake handles the *inner* seam of each
turn (tool call). Every agent test wires BOTH — the LLM fake decides
which tool to call, the MCP fake decides what result comes back, and
`runAgentLoop`'s real code stitches them together.

```
  Zoom out — the twin seams

  ┌─ Agent layer ────────────────────────────────────────────┐
  │  runAgentLoop                                            │
  │      │                                                    │
  │      │  each turn:                                        │
  │      │                                                    │
  │      ├───► anthropic.messages.create()  ──► pattern 01    │
  │      │                                                    │
  │      │  if tool_use:                                      │
  │      │                                                    │
  │      └───► ★ mcp.callTool(name, args) ★  ──► THIS FILE   │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │  DataSource port    │  ← constructor param
                    └─────────┬──────────┘
                              │
              ┌───────────────┼─────────────────┐
              ▼               ▼                 ▼
  BloomreachDataSource   Synthetic       ★ FAKE ★
  (prod, HTTP+OAuth)     (eval harness)   (this file)
```

The port has now shipped in five uses without a caller-surface change
— `BloomreachDataSource` in prod, `SyntheticDataSource` in the eval
harness, `FaultInjectingDataSource` in the load harness, a hand-rolled
Olist adapter (retired), and the test fakes here. **That's the payoff
of putting `DataSource` behind an interface.**

═════════════════════════════════════════════════
Structure pass — layers · axes · seams
═════════════════════════════════════════════════

**Layers:**
- test scaffolding (`buildFakeMcp(impl)` in unit tests;
  `makeMockTransport(scenario)` in integration tests)
- port (`McpCaller` / `DataSource` — 2-method interface)
- production adapters (`BloomreachDataSource`, `SyntheticDataSource`,
  `FaultInjectingDataSource`)
- `runAgentLoop` (production; consumes the port)

**Axis held constant — dependency:** who depends on whom?
- `runAgentLoop` depends on the *port*, not any adapter
- production wires the Bloomreach adapter
- eval wires the Synthetic adapter
- tests wire an inline fake
- the arrow always points at the port; the adapter is swapped

**Seam:** the `McpCaller` interface (`test/agents/base.test.ts:5`,
`lib/agents/base.ts`). It has exactly one method that matters:
`callTool(name, args) → { result, durationMs, fromCache }`.

═════════════════════════════════════════════════
How it works
═════════════════════════════════════════════════

#### Move 1 — the mental model

You've seen dependency injection in a React app — you pass a
`fetch` function to a data hook so tests can hand it a fake. Same
move at the agent layer: `runAgentLoop` takes its MCP client as a
parameter. The fake is a 3-line object that implements the one
method the loop calls. There's no framework, no `vi.mock` — just an
object with a `callTool()` method that returns whatever the test needs.

```
  The port-fake pattern

  test constructs:  fake = { callTool: async () => ({ result: {...} }) }
                                                          │
                                                          ▼
  runAgentLoop(deps={ dataSource: fake }) ─── real loop dispatches tool
                                                          │
                                              fake.callTool('name', {args})
                                                          │
                                                          ▼
                                              returns { result, durationMs,
                                                        fromCache: false }
                                                          │
                                                          ▼
                                              feeds result back to next
                                              anthropic.messages.create()
```

Kernel:
- **the port interface** — `McpCaller = { callTool(name, args) →
  DataSourceCallResult }`. Drop it and the loop couples to a specific
  adapter's shape; adding a new adapter breaks the loop
- **the wrapping envelope** — `{ result, durationMs, fromCache }`.
  Drop it and the loop can't distinguish cached-vs-live for logging;
  Session B's rate-limit reporter breaks
- **the `is_error` fold at the loop** — `runAgentLoop` catches a
  `callTool` throw and feeds it back as an `is_error: true`
  tool_result block. Drop that and tool errors crash the loop
  instead of letting the model recover

#### Move 2 — the walkthrough

**The unit-test factory — one line per test.**

Unit tests use a tiny factory that takes an implementation function
and wraps it in the port envelope:

```
  Location: test/agents/base.test.ts:76-83

  function buildFakeMcp(
    impl: (name, args) => Promise<unknown>
  ): McpCaller {
    return {
      async callTool(name, args) {
        const result = await impl(name, args);
        return { result, durationMs: 1, fromCache: false };
      }
    };
  }
```

Each test calls this with an inline implementation that returns
exactly the tool result shape that test needs:

```
  Location: test/agents/base.test.ts:119-123

  const mcp = buildFakeMcp(async () => ({
    isError: false,
    content: [],
    structuredContent: { data: { total_customers: 5 } }
  }));
```

That's it. Two lines. The test never touches network, never touches
OAuth, never touches rate limits.

**The error-recovery test — critical corner case.**

`runAgentLoop`'s contract says: if `callTool` throws, catch the error,
feed it back to the model as an `is_error` tool_result block, and let
the model decide what to do next. The test that pins this
(`test/agents/base.test.ts:182-214`) uses the fake's implementation
to throw:

```
  Location: test/agents/base.test.ts:196-198

  const mcp = buildFakeMcp(async () => {
    throw new Error('MCP transport failed');
  });
```

Combined with a 2-response Anthropic script (tool_use → text), this
exercises the exact recovery path a real 500 error would trigger.
The assertions:

```
  Location: test/agents/base.test.ts:209-213

  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls[0].error).toBeDefined();
  expect(result.toolCalls[0].error).toContain('MCP transport failed');
  expect(result.finalText).toContain('recovered after error');
```

Note: the fake didn't need to do anything special — it just threw.
The kernel (production code catches, wraps as `is_error`, feeds
forward) is what's under test. This is why a simple fake beats a
complex one: it exercises the real logic between the two seams.

**The integration-test upgrade — per-tool switch.**

Integration tests can't use a 3-line fake because the routes call
`bootstrapSchema`, which fires six specific bootstrap tools
(`list_cloud_organizations`, `list_projects`, `get_event_schema`,
`get_customer_property_schema`, `list_catalogs`,
`get_project_overview`). The fake has to return realistic-shaped
data per tool name:

```
  Location: test/api/_helpers.ts:169-220 (excerpt)

  function makeBootstrapCallTool() {
    return vi.fn(async (name, _args, _opts?) => {
      let structuredContent;
      switch (name) {
        case 'list_cloud_organizations':
          structuredContent = { data: [{ id: 'org-test', ... }] };
          break;
        case 'list_projects':
          structuredContent = { data: [{ id: 'proj-test', ... }] };
          break;
        case 'get_event_schema':
          structuredContent = { events: [
            { type: 'purchase', properties: { ... } },
            { type: 'session_start', properties: { ... } },
          ]};
          break;
        // ...
        default:
          structuredContent = { data: [], rows: [] };
      }
      return { result: { structuredContent }, durationMs: 1,
               fromCache: false };
    });
  }
```

The tool-name switch is a controlled tradeoff: it introduces the
same "if test scaffolding fell out of sync with prod, tests still
pass" risk that a real integration test avoids. The mitigation is
that `bootstrapSchema` errors early on a missing/malformed field
(`lib/mcp/schema.ts` uses `parseWorkspaceSchema` with strict
validators), so if the fake's shape drifts from prod, the tests
fail loudly during bootstrap, not silently downstream.

**Scenario-driven variants — the failure-mode dimension.**

`makeMockTransport(scenario, opts)` selects between four failure
scripts (`_helpers.ts:288-339`):

```
  ┌─ 'ok'                ─┐  happy path
  │  callTool → bootstrap  │
  │  listTools → tool list │
  └────────────────────────┘

  ┌─ 'list-tools-fail'   ─┐  bootstrap OK, listTools throws
  │  callTool → bootstrap  │  → workspace + coverage flushed;
  │  listTools → throw    │    then error event fired
  └────────────────────────┘

  ┌─ 'tool-call-fail'    ─┐  one specific tool throws
  │  callTool → happy      │
  │    UNLESS name===opts.tool → McpToolError
  │  listTools → happy    │
  └────────────────────────┘

  ┌─ 'timeout'           ─┐  callTool returns never-resolving Promise
  │  callTool → new Promise(() => {})
  │  listTools → happy    │  ← tests MUST use fake timers
  └────────────────────────┘
```

Each scenario pins a route-level failure the production code has to
handle. The scenarios are one enum, so a new scenario is a new case
and the compiler tells you which callers to update.

#### Move 2 variant — the load-bearing skeleton

Kernel: **port + envelope + is-error fold.**

- Drop the port → adapter swap breaks the loop; five uses in five
  months (see zoom-out) prove the port is worth its bytes
- Drop the envelope → observability (`fromCache` logging, per-call
  duration) can't be structured
- Drop the is-error fold → tool errors crash the loop, model can't
  recover, single 500 kills the whole investigation

Hardening: the per-tool switch in `makeBootstrapCallTool`
(brittleness vs realism tradeoff), the scenario enum
(discoverability), the McpToolError wrapping (matches production
shape).

#### Move 3 — the principle

When a system depends on an external service, make the service a
port with the minimum interface the caller needs. In-process fakes
are then trivial (an object with a method), and the same production
code runs against every adapter — real, synthetic, fault-injected,
and test-fake — without a caller-surface change. **The number of
adapters your port has quietly become is the health metric.** This
repo's `DataSource` port has five and counting.

═════════════════════════════════════════════════
Primary diagram
═════════════════════════════════════════════════

The full picture — one port, five adapters, one loop.

```
  Full picture — DataSource port + its adapters

  ┌─ Consumers (loop) ──────────────────────────────────────────┐
  │  runAgentLoop({ dataSource, anthropic, ... })                │
  │      ─── depends on the port only ───►                       │
  └──────────────────────────────┬───────────────────────────────┘
                                 │
                    ┌────────────▼───────────┐
                    │  DataSource port        │
                    │  callTool(name, args)   │
                    │  → { result, durationMs,│
                    │      fromCache }        │
                    └────────────┬────────────┘
                                 │
      ┌───────────┬─────────┬────┼──────┬────────────┐
      ▼           ▼         ▼    ▼      ▼            ▼
  Bloomreach  Synthetic  Fault  Olist  buildFakeMcp  makeMockTransport
  (prod)      (eval)     (load) (RIP)  (unit tests)  (integration)
     │           │         │              │              │
     ▼           ▼         ▼              ▼              ▼
   HTTP +    in-process  wraps        (retired)     inline object
   OAuth +   fixture     any inner                   with per-tool
   PKCE      data        adapter                     switch
```

═════════════════════════════════════════════════
Elaborate
═════════════════════════════════════════════════

The pattern is **Ports & Adapters** (hexagonal architecture, Alistair
Cockburn, 2005). The vocabulary: the *port* is the interface the
domain code depends on; *adapters* are the implementations. Domain
code depends on the port, not any adapter, so adapters can be
swapped without touching the domain.

In test contexts, this pattern is what makes "test doubles" cheap.
Without a port, you'd have to mock a concrete class (`vi.mock`,
`jest.spyOn`, whatever) and inherit all its baggage; with a port, a
test double is a two-line object that satisfies the interface.

The MCP fake here has the added property that the tool result
envelope (`structuredContent` or `content[0].text`) is idempotent —
the same fake data can drive both a schema-parsing unit test (does
`unwrap(fixture)` return the right structuredContent?) and an
integration test (does the route's schema bootstrap survive a
minimal-but-realistic mock envelope?). Pattern 05 leans on this
same envelope with real captured fixtures.

Cross-link:
- Pattern 01 (Anthropic fake) is always used alongside this one —
  the two seams are wired together per test
- `study-system-design`'s provider-abstraction pattern covers the
  port design decision at the architecture level; here we cover
  its testing payoff

═════════════════════════════════════════════════
Interview defense
═════════════════════════════════════════════════

**Q: You have an agent that hits an MCP server. How do you test it
without hitting the network?**

Answer: Put the MCP surface behind a small port — an interface with
just `callTool(name, args)` — and pass it into the agent as a
constructor param. Production wires up a real HTTP + OAuth adapter;
tests wire up a two-line object that returns whatever tool result
the test needs. The agent code is identical in both; only the
adapter changes.

Anchor: `test/agents/base.test.ts:76-83` — `buildFakeMcp()` — and
`_helpers.ts:169-220` — `makeBootstrapCallTool()` for the
integration-test upgrade with per-tool switching.

Diagram sketch:

```
  runAgentLoop → DataSource port
                    ▲   ▲    ▲
                    │   │    │
             Bloomreach  Synthetic  test-fake
             (prod)      (eval)     (unit)
```

**Q: What breaks if the port isn't stable across all its adapters?**

Answer: A new adapter breaks every caller that took the old shape.
In this repo, the `DataSource` port has now shipped in 5 adapters
(Bloomreach → Olist → Synthetic → Fault-injecting → test fake) with
zero caller-surface changes — that's the payoff of putting the
interface first. The load-bearing part is the envelope shape
(`{ result, durationMs, fromCache }`); if any adapter drifted from
that, the observability logging in `runAgentLoop` (per-turn duration
+ cache-hit ratio) breaks.

**Q: Isn't a fake this simple hiding bugs a real integration test
would catch?**

Answer: The unit-level fake IS meant to hide the transport — the
question the unit test answers is "does `runAgentLoop` correctly
sequence turns and tool calls?" not "does the OAuth handshake
work?" The transport itself has its own tests
(`test/mcp/transport.test.ts`). The integration tests
(`test/api/_helpers.ts`) upgrade the fake to per-tool switching so
`bootstrapSchema` sees realistic-shaped envelopes; that pins the
seam between the transport contract and the schema parser. The
unit-vs-integration split IS the answer.

═════════════════════════════════════════════════
See also
═════════════════════════════════════════════════

- `01-scripted-anthropic-fake.md` — the twin seam; always used with
  this pattern
- `05-fixture-anchored-schema-tests.md` — the fake's realistic
  envelope shape shares wire format with the real captured fixtures
- `audit.md` lens 3 — the port as design-pressure payoff (the
  `DataSource` port shipping in 5 adapters)
- `study-system-design` — provider-abstraction at the architecture
  level
