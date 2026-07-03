# 03 — HTTP Transport Mock with Module Hoisting

**Industry name:** *module-level test double* + *global fetch stub*
(sometimes called *sociable tests* when they let real code inside the
module boundary talk to a mocked outer boundary).
**Type:** Language-specific pattern (Vitest / Jest module-hoisting
semantics).
**Determinism side:** DETERMINISTIC. The `fetch` swap and the
module-load-order mock both replace non-deterministic I/O with
scripted responses.

═════════════════════════════════════════════════
Zoom out — where this pattern sits
═════════════════════════════════════════════════

Patterns 01 and 02 test the agent layer by injecting fakes at
construction time. That works because `runAgentLoop` takes its deps
as parameters. But the *route* layer instantiates its own
Anthropic and MCP clients inside the handler — you can't reach into a
handler and swap constructor args. This pattern is what you reach for
when the seam is at the module boundary, not the constructor
boundary.

```
  Zoom out — where module mocking lives

  ┌─ Route handler layer (app/api/*/route.ts) ─────────────────┐
  │                                                             │
  │  export async function GET(req) {                           │
  │    const anthropic = new Anthropic({ apiKey: ... });        │ ← can't
  │    const { mcp } = await connectMcp(sid);                    │   inject
  │    const stream = new ReadableStream({                       │   here
  │      start: async (controller) => { ... }                    │
  │    });                                                       │
  │    return new Response(stream);                              │
  │  }                                                          │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │ MODULE BOUNDARY     │  ← we mock HERE
                    │  @anthropic-ai/sdk  │
                    │  lib/mcp/session    │
                    │  lib/mcp/connect    │
                    │  lib/data-source    │
                    └─────────┬──────────┘
                              │
                     (real modules; skipped)
```

The lower-level `test/mcp/transport.test.ts` uses the same pattern's
sibling — `vi.stubGlobal('fetch', ...)` — because the transport's
`fetch` is the platform global, not something you construct.

═════════════════════════════════════════════════
Structure pass — layers · axes · seams
═════════════════════════════════════════════════

**Layers:**
- test file (calls `vi.mock(...)` at module scope, imports route AFTER)
- Vitest module-hoisting (rearranges `vi.mock` calls to run before
  any `import`)
- mocked module (returns test's factory result to any consumer)
- route handler (imports the mocked module, unaware it's fake)

**Axis held constant — trust:** what does each layer trust from the
one below?
- test: trusts Vitest to hoist the mock before the imports
- Vitest: trusts the mock factory to return the module shape
- route: trusts the SDK module to give it a working `Anthropic` class
- SDK-as-mocked: gives it a class whose `create()` reads from a
  scripted queue

Trust *flips* at the module boundary — that's the seam.

**Seam:** the ES-module boundary. `import Anthropic from
'@anthropic-ai/sdk'` in `route.ts` is the injection point that only
`vi.mock` can control.

═════════════════════════════════════════════════
How it works
═════════════════════════════════════════════════

#### Move 1 — the mental model

You know how `import X from 'y'` in Node normally resolves `'y'` via
the module cache once, then hands the same instance to every
importer? Vitest's `vi.mock('y', factory)` intercepts that
resolution: any test file that calls `vi.mock('y', ...)` at module
scope makes every subsequent import of `'y'` return the factory
result instead of the real module. Vitest hoists these calls to the
top of the file automatically — even if you write them AFTER your
imports, they run BEFORE.

```
  Module-mock hoisting — what Vitest actually runs

  what you write:                    what runs:

  import { GET } from '.../route';   vi.mock('sdk', () => fakeSdk)
  vi.mock('sdk', () => fakeSdk);     vi.mock('lib/mcp/session', ...)
  vi.mock('.../session', ...);       import { GET } from '.../route'
                                     // ← now imports resolve to
                                     //   the mocked modules
```

Kernel:
- **`vi.mock(path, factory)`** at module scope in the test file
- **Vitest hoists** the mock call before any `import`
- **The factory returns** the entire module shape (default export,
  named exports) the mocked module normally provides
- **State variables** (`let currentMcp = ...`) live between the
  mock declaration and the test body, so the factory can close over
  them and each test reassigns them

Drop hoisting: your `import` runs first, resolves the real module,
the mock arrives too late.

Drop the module-shape faithfulness: consumers of the mocked module
fail with cryptic errors when they access a field the mock didn't
provide.

Drop the closed-over state: every test would need its own `vi.mock`
call — impossible, since a mock declared inside `it()` runs AFTER
the imports.

#### Move 2 — the walkthrough

**Step 1 — the SDK module mock (class instantiation seam).**

The route does `new Anthropic({ apiKey })` inside the handler. The
mock has to be a real ES-module class, not a `vi.fn().mockImplementation`,
because Vitest's spy wrapper isn't `new`-able unless the underlying
target is a function or class:

```
  Location: test/api/_helpers.ts:68-84

  export function mockAnthropicModule(): { default: unknown } {
    class MockAnthropic {                     // ← real class, so
      messages = {                             //   `new MockAnthropic`
        create: async (params) => {            //   works from the route
          anthropicCalls.push(params);
          const next = anthropicQueue.shift(); // ← shared module state
          if (!next) throw new Error(...);
          return typeof next === 'function' ? next() : next;
        }
      }
    }
    return { default: MockAnthropic };         // ← shape matches
                                               //   `import Anthropic from ...`
  }
```

The test file wires this at module scope:

```
  Location: test/api/briefing.integration.test.ts:38

  vi.mock('@anthropic-ai/sdk', () => mockAnthropicModule());
```

That's the entire SDK mock. The queue (`anthropicQueue`) is module-level
state in `_helpers.ts`; tests fill it via `setAnthropicResponses(...)`
inside `beforeEach`.

**Step 2 — the session + connect mocks (function seam).**

The route calls `await getOrCreateSessionId(req)` and
`await connectMcp(sid)`. Both are pure functions imported from
`lib/mcp/session` and `lib/mcp/connect`. The mocks close over
mutable state so each test can point them at a different scenario:

```
  Location: test/api/briefing.integration.test.ts:44-59

  let currentMcp: MockMcp = makeMockTransport('ok');
  let currentConn = { ok: true, mcp: currentMcp as ... };
  let currentSessionId = 'test-session-001';

  vi.mock('../../lib/mcp/session', () => ({
    getOrCreateSessionId: vi.fn(async () => currentSessionId),
    readSessionId: vi.fn(async () => currentSessionId),
  }));

  vi.mock('../../lib/mcp/connect', () => ({
    connectMcp: vi.fn(async () => currentConn),
    completeAuth: vi.fn(async () => {}),
  }));
```

Key detail: **the mock factory returns a function that closes over
`currentConn`, so reassigning `currentConn` in a test's arrange step
takes effect immediately.** No re-mocking per test. Each test:

```
  Location: briefing.integration.test.ts:203-207

  // Arrange: swap the connect mock to return `ok: false`
  const mockSession = makeMockSession('unauthed');
  currentSessionId = mockSession.sessionId;
  currentConn = { ok: false, authUrl: mockSession.authUrl! };
```

**Step 3 — the partial-module mock (`vi.importActual` for real code
you want to keep).**

The `lib/data-source` module has 4-5 exports. The route uses
`makeDataSource(mode, sid)`; tests want to override just that one
but keep the rest (`parseLiveMode`, `SyntheticDataSource`, the
constants). `vi.importActual` gets the real module inside the mock
factory:

```
  Location: briefing.integration.test.ts:66-87

  vi.mock('../../lib/data-source', async () => {
    const real = await vi.importActual<typeof import('.../data-source')>(
      '../../lib/data-source'
    );
    const { bootstrapSchema } = await import('../../lib/mcp/schema');
    return {
      ...real,                                 // ← keep everything real
      makeDataSource: vi.fn(async () => {      // ← overwrite just this one
        if (!currentConn.ok) {
          return { ok: false, mode: 'live-mcp',
                   authUrl: currentConn.authUrl };
        }
        const ds = currentConn.mcp as ...;
        return {
          ok: true, mode: 'live-mcp',
          dataSource: ds,
          bootstrap: (signal) => bootstrapSchema(ds, { signal }),
          dispose: async () => {}
        };
      })
    };
  });
```

This is the trick that keeps the tests honest: `bootstrapSchema` is
REAL code, running against the fake `dataSource`. If bootstrap logic
drifts (a new field needed from `get_event_schema`), the test fails
loudly at bootstrap, not silently downstream.

**Step 4 — the `fetch` global stub (for transport tests).**

The transport tests operate one layer below — they test the
`SdkTransport` class and its `makeCapturingFetch` wrapper. The seam
here is the platform `fetch` global, and `vi.stubGlobal` is the tool:

```
  Location: test/mcp/transport.test.ts:15-42

  afterEach(() => {
    vi.unstubAllGlobals();                     // ← restored per test
  });

  describe('makeCapturingFetch', () => {
    it('records the body of a non-OK response ...', async () => {
      const holder: HttpErrorHolder = { last: null };
      const f = makeCapturingFetch(holder);
      vi.stubGlobal(                            // ← platform swap
        'fetch',
        async () => new Response(
          '{"error":"invalid_token","error_description":"..."}',
          { status: 401 }
        )
      );

      const res = await f('https://example.com/mcp');
      expect(res.status).toBe(401);
      expect(holder.last).toMatchObject({ status: 401 });
      expect(holder.last?.body).toContain('invalid_token');
    });
  });
```

`vi.stubGlobal` swaps the property on `globalThis` and remembers the
original; `vi.unstubAllGlobals` in `afterEach` restores it. Without
the `afterEach`, a `fetch` stub in one file would leak into another
running in the same worker.

#### Move 2 variant — the load-bearing skeleton

Three moving parts, all irreducible:

- **Module hoisting** — `vi.mock` must run before `import`. Skip it
  (put the mock inside a `beforeEach`) and the route module resolves
  the real SDK before the mock lands. Silent failure — the tests
  never touch your mock.

- **Faithful module shape** — the factory must return everything the
  consumer will import. Miss a named export and the consumer fails
  with `undefined is not a function` at the exact line of use.
  `vi.importActual + spread + selective override` is the discipline
  when the module has multiple exports.

- **Closed-over mutable state** — `currentMcp`, `currentConn`,
  `currentSessionId` are the only way for a test's arrange step to
  influence the mock. Reassign them inside `it()` — the mock reads
  them at call time.

Hardening on top: `_clear()` helpers in `beforeEach`
(insights, investigations, schema cache, Anthropic queue), the
scenario enum (`'ok' | 'list-tools-fail' | ...`) for reproducible
failure modes, `afterEach(() => vi.unstubAllGlobals())` for the
transport test.

#### Move 3 — the principle

When a system's seam is at the module boundary rather than a
constructor argument, use the module system's own indirection to
swap it: `vi.mock`. Two disciplines make this safe — mock hoisting
awareness (so mocks land before imports) and closed-over mutable
state (so tests can vary scenarios without re-mocking). Use
`vi.importActual` when the mocked module has multiple exports and
you only want to overwrite one — this is what keeps tests honest by
running real production code against the fake seam.

═════════════════════════════════════════════════
Primary diagram
═════════════════════════════════════════════════

The full flow of a route integration test.

```
  End-to-end flow — integration test → mocked route

  ┌─ test file (top of module) ─────────────────────────────────┐
  │                                                              │
  │  let currentMcp    = makeMockTransport('ok');                │
  │  let currentConn   = { ok: true, mcp: currentMcp };          │
  │  let currentSessionId = 'test-001';                          │
  │                                                              │
  │  vi.mock('@anthropic-ai/sdk',       () => mockAnthropicModule())│
  │  vi.mock('.../session',             () => ({ getOrCreateSessionId: async () => currentSessionId }))│
  │  vi.mock('.../connect',             () => ({ connectMcp: async () => currentConn }))│
  │  vi.mock('.../data-source',    async () => {                 │
  │    const real = await vi.importActual(...);                   │
  │    return { ...real, makeDataSource: async () => ({ ...  │
  │             dataSource: currentConn.mcp, ...})};             │
  │  });                                                          │
  │                                                              │
  │  import { GET } from '.../route';   ◄── resolves to mocks    │
  └───────────────────┬──────────────────────────────────────────┘
                      │
     beforeEach:      │ _clear()s + resetAnthropicQueue()
                      │ + reassign currentMcp / currentConn to the
                      │   test's scenario
                      ▼
     it(...):    setAnthropicResponses([...scripted...])
                 currentConn = { ok: false, ... }
                      │
                      ▼
                 const req  = new NextRequest(url)
                 const res  = await GET(req)   ◄── real route code runs
                                                    against fake seams
                      │
                      ▼
                 collectEvents(res)  ◄── real readNdjson kernel drains
                                          the stream (patterns 01+02
                                          drove what the fake returned)
                      │
                      ▼
                 assert on the collected events
```

═════════════════════════════════════════════════
Elaborate
═════════════════════════════════════════════════

Vitest's `vi.mock` inherits its shape from Jest's `jest.mock`, which
inherits from the pre-ES-modules world of `proxyquire` and
`require.cache` manipulation. The hoisting behavior is a modern
convenience — with static ES imports, you can't put a `.mock()` call
after the imports and expect it to affect them, so the tooling
rearranges the code at compile time.

This pattern lives at a specific altitude in the test pyramid: too
high for constructor injection (the seam is not a param), too low
for a full browser test (the routes don't reach the browser, they
reach `NextRequest → GET → Response`). The route integration tests
in this repo are the middle band — 19 tests total, each drains a
full stream, each covers one branch of the route's control flow.

The `_helpers.ts` file is a good study in why this pattern's
scaffolding grows. The comment at
`test/api/agent.integration.test.ts:1-25` lists five "plan-vs-real"
deltas Phase 3 discovered — `?q=` not `?query=`, `insight not
found` not `anomaly not found`, the cached-investigation short-circuit,
etc. Each is a place where the test's mental model of the route
drifted from the code, and the fix was to update the scaffolding.
That's the tax on this altitude: the more the fake looks like prod,
the more it has to stay in sync with prod.

Cross-links:
- `01-scripted-anthropic-fake.md` — the mocked SDK reuses the same
  scripted-queue kernel here, wrapped in a class instead of a factory
- `02-scripted-mcp-caller-fake.md` — the mocked `data-source`
  wires `makeMockTransport(scenario)` (pattern 02's integration
  upgrade) as the `dataSource`
- `04-fake-timer-time-travel-for-rate-limits.md` — the transport
  tests combine `vi.stubGlobal('fetch')` with `vi.useFakeTimers` for
  the timeout scenario

═════════════════════════════════════════════════
Interview defense
═════════════════════════════════════════════════

**Q: The route does `new Anthropic(...)` inside the handler. How do
you test it without hitting the API?**

Answer: Use module-level mocking. `vi.mock('@anthropic-ai/sdk', () =>
{ default: MockAnthropic })` at the top of the test file, where
`MockAnthropic` is a real class whose `messages.create` reads from a
scripted queue. Vitest hoists the mock above the imports, so when
the route imports the SDK it gets the fake. The class is required
(not a `vi.fn`) because the route uses `new`.

Anchor: `test/api/_helpers.ts:68-84` and
`briefing.integration.test.ts:38`.

Diagram sketch:

```
  vi.mock('sdk', () => fakeClass)    ◄── hoisted first
              │
              ▼
  import route          ◄── resolves 'sdk' to fake
              │
              ▼
  route calls new Anthropic() ── gets fakeClass instance
              │
              ▼
  .messages.create() ── reads scripted queue
```

**Q: How do you make one test test the unauthed branch and another
test the happy path — without redefining the mock?**

Answer: Close the mock factory over mutable state. Declare `let
currentConn = { ok: true, ... }` at module scope, have the mock
factory return `currentConn` at call time. Each test's arrange step
reassigns `currentConn = { ok: false, authUrl: ... }`. The mock reads
the new value on the next call. No re-mocking, no test-specific
factory.

Anchor: `briefing.integration.test.ts:44-59` (declaration) and
`:203-207` (per-test override).

**Q: What breaks if you write your `vi.mock` calls after the
imports?**

Answer: Nothing visible — Vitest hoists them automatically. But if
the compiler/transformer didn't hoist (older tooling, some edge
cases), the imports would resolve first and your mock would arrive
too late. The imports would bind to the real module, and no amount
of later `vi.mock` calls would touch them. The defensive move is to
**always write `vi.mock` at the top of the file, above the imports**
— matches the runtime order and doesn't rely on hoisting magic.

═════════════════════════════════════════════════
See also
═════════════════════════════════════════════════

- `01-scripted-anthropic-fake.md` — the SDK-class fake reuses the
  scripted-queue kernel
- `02-scripted-mcp-caller-fake.md` — the mocked data-source module
  wires in a per-tool switch fake
- `04-fake-timer-time-travel-for-rate-limits.md` — combined with
  `stubGlobal('fetch')` for timeout scenarios
- `audit.md` lens 2 — the integration-test arrange-block scale
  ceiling this pattern approaches
