# 06 — scripted NDJSON integration harness

*Industry term:* **integration test** with module-mocked SDK +
streaming response **drain** — Industry standard

## Zoom out, then zoom in

You've written a fetch test that hits a route handler and inspects
the response JSON. Same shape — except the response here is a
*stream* of newline-delimited events, and the handler runs a full
agent loop that calls the (mocked) Anthropic SDK and the (mocked)
MCP server inside the stream's `start(controller)` callback. The
harness drains the NDJSON with the *same kernel* the live UI uses,
and asserts on the sequence of event types the route emitted.

```
  Zoom out — where this harness lives

  ┌─ UI layer (browser) ───────────────────────────────────────┐
  │  useBriefingStream → fetch('/api/briefing') → readNdjson   │
  └────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ live request flow
                                  │
  ┌─ API route layer ──────────────────────────────────────────┐
  │  GET /api/briefing   (NextRequest → Response w/ stream)    │
  │  GET /api/agent      (NextRequest → Response w/ stream)    │
  └─────────────────────────────┬──────────────────────────────┘
                                │
  ┌─ Integration test harness ──▼──────────────────────────────┐
  │  briefing.integration.test.ts (7 tests)                     │ ← we are here
  │  agent.integration.test.ts (10 tests)                       │
  │  _helpers.ts (mock factories)                              │
  │                                                             │
  │  drives:  GET(req) → Response → readNdjson → collectEvents │
  │  mocks:   Anthropic SDK · session · connectMcp · data-source│
  │  asserts: event type sequence, status, headers, phase logs │
  └─────────────────────────────────────────────────────────────┘
```

**Zoom in.** Most of the agent unit tests inject the fake Anthropic
directly because their function-under-test takes it as a parameter.
The integration tests can't — the route handler does
`new Anthropic({ apiKey })` *inside itself*, so the only way to
substitute is to intercept the module *import*. Vitest's `vi.mock` at
the top of the test file does that, and the mock factory wires the
same scripted-queue kernel from file 01. The big add at this layer is
**draining the streaming response** — `readNdjson` (the production
streaming kernel) is reused to consume the test's response body, so
the test exercises the exact contract the UI depends on.

## Structure pass

**Layers — five depths the harness operates across:**
- outer: the test body (arranges queues, drives `GET(req)`, asserts on
  the event array)
- middle 1: the route handler (real code — opens a stream, runs the
  agent loop, emits NDJSON)
- middle 2: the mocks (Anthropic SDK, session, connect, data-source)
- middle 3: `readNdjson` (the same kernel the UI uses to consume)
- inner: the test asserts on the `events: AgentEvent[]` array

**One axis held constant — *what does each layer trust*:**
- outer: trusts the route to emit events in the documented sequence
- middle 1: trusts the mocked SDK to return whatever the queue holds
- middle 2: returns scripted shapes per call
- middle 3: trusts the NDJSON line-terminator contract
  (no interior `\n`)
- inner: asserts both the *contents* and the *order*

**The seam — where the axis flips:** at the `vi.mock` boundary.
Above it, real route handler code. Below it, scripted mocks. The
inversion vs the unit tests: the route handler can't *take* its
dependencies as parameters, so the substitution has to happen at
module-resolution time, not at call time.

## How it works

### Move 1 — the mental model

An **integration test** here is "drive the route handler with a real
`NextRequest`, drain its real streaming `Response`, assert on the
sequence of events that came out." The two big moving parts:
(1) `vi.mock` to substitute the SDK + transport at module load,
(2) the production NDJSON kernel reused to consume the stream the
route emits. The harness is the same kernel as the unit tests with
two adapter layers added: module-level mocking instead of DI, and
streaming-response draining instead of a single return value.

```
  The harness kernel

  setup (module scope)              run (per test)                     assert
  ────────────────────             ─────────────────                   ──────
  vi.mock('@anthropic-ai/sdk')      setAnthropicResponses([...])      types =
  vi.mock('../../lib/mcp/session')  setMcp / setConn (scenarios)        events.map
  vi.mock('../../lib/mcp/connect')  const req = new NextRequest(url)    (e => e.type)
  vi.mock('../../lib/data-source')  const res = await GET(req)         expect(types)
                                    const events = await                .toContain
                                      collectEvents(res)                ('workspace')
                                                                      expect(types
                                                                       [types.length-1])
                                                                       .toBe('done')
```

The four parts that the unit tests don't have: module mocks,
scenario-switching state, the `GET(req)` drive, and the
event-sequence assertion. Strip any and the harness doesn't reach
this layer of confidence — strip module mocks and you need a real
Anthropic key, strip scenarios and you can only test the happy path,
strip the drive and you're back to unit-testing functions, strip the
sequence assertion and you can only check the last event.

### Move 2 — the step-by-step walkthrough

**Module-level mocks — registered before the route imports.**
`test/api/briefing.integration.test.ts:38-87`:

```typescript
// 1) Stub the Anthropic SDK at module load — the route does
//    `new Anthropic(...)` inside the handler, so the mock has to be
//    in place before the route module runs.
vi.mock('@anthropic-ai/sdk', () => mockAnthropicModule());

// 2) Session + connect surfaces. State vars below let each test swap
//    happy/error/unauthed without re-mocking.
let currentMcp: MockMcp = makeMockTransport('ok');
let currentConn: Awaited<...> = { ok: true, mcp: currentMcp as ... };
let currentSessionId = 'test-session-001';

vi.mock('../../lib/mcp/session', () => ({
  getOrCreateSessionId: vi.fn(async () => currentSessionId),
  readSessionId: vi.fn(async () => currentSessionId),
}));

vi.mock('../../lib/mcp/connect', () => ({
  connectMcp: vi.fn(async () => currentConn),
  completeAuth: vi.fn(async () => {}),
}));

// 3) Data-source factory — wraps the same currentConn state into a
//    DataSource shape the route's makeDataSource expects.
vi.mock('../../lib/data-source', async () => { /* ... */ });

// Import AFTER mocks are registered so the route sees them.
import { GET } from '../../app/api/briefing/route';
```

The vitest hoisting rule: `vi.mock` calls are hoisted to the *top* of
the file before any imports. The `let currentMcp = ...` declarations
are not hoisted, which is why the mock factories read them *lazily*
(inside the returned function bodies). When a test reassigns
`currentMcp = makeMockTransport('list-tools-fail')`, the next call
into the mock reads the new value. That's how scenarios switch without
re-mocking the module.

**Scenario factories — one function, named failure modes.**
`test/api/_helpers.ts:288-339` (`makeMockTransport`) takes a `scenario:
'ok' | 'list-tools-fail' | 'tool-call-fail' | 'timeout'` and returns a
mock with the matching failure mode wired into `callTool` / `listTools`.

```
  Scenario coverage — what each one tests

  scenario          what the mock does                  what the test asserts
  ───────────       ──────────────────                  ─────────────────────
  'ok'              callTool: scripted bootstrap        happy path: workspace +
                    listTools: full monitoring          coverage_item events +
                                tool list               done; bootstrap callTool
                                                        invoked 6 times
  'list-tools-fail' callTool: same happy bootstrap      partial flush: workspace +
                    listTools: throws Error('503')      coverage_item events fire
                                                        BEFORE the error event;
                                                        no done
  'tool-call-fail'  callTool: throws McpToolError       depends on which tool —
                                  on opts.tool          bootstrap tools surface as
                    listTools: happy                    route error; monitoring
                                                        tools surface as is_error
                                                        in the agent loop
  'timeout'         callTool: never resolves            tests MUST drive fake
                    listTools: happy                    timers or attach a short
                                                        abort signal
```

Each scenario is named, has a docstring explaining what it tests, and
the type lists them in a single union — adding a fifth scenario means
adding a branch in `makeMockTransport`, not editing N test files.

**Drive the route, drain the stream.** `briefing.integration.test.ts:116-159`:

```typescript
it('streams NDJSON ending in `done` on the happy path', async () => {
  // Arrange — script the monitoring agent to return [] immediately so the
  // loop terminates after exactly ONE Anthropic call.
  setAnthropicResponses([
    mockAnthropicResponse({ text: '```json\n[]\n```', stop_reason: 'end_turn' }),
  ]);

  // Act
  const req = new NextRequest('http://localhost:3000/api/briefing');
  const response = await GET(req);

  // Assert: status + content-type
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');

  const events = await collectEvents<AgentEvent | { type: string }>(response);

  // The route emits a deterministic phase order on the happy path:
  //   reasoning_step (schema) → workspace → reasoning_step + coverage_item
  //   per category (×10) → reasoning_step ("checking N of 10…") →
  //   …monitoring agent runs (no insights here) → done
  expect(events.length).toBeGreaterThan(0);
  const types = events.map((e) => (e as { type: string }).type);
  expect(types).toContain('workspace');
  expect(types).toContain('coverage_item');
  expect(types[types.length - 1]).toBe('done');

  // The 6 bootstrap tool calls fire exactly once each + listTools once.
  expect(currentMcp.listTools).toHaveBeenCalledTimes(1);
  const calledTools = currentMcp.callTool.mock.calls.map((c) => c[0]);
  expect(calledTools).toContain('list_cloud_organizations');
  expect(calledTools).toContain('list_projects');
  expect(calledTools).toContain('get_event_schema');
  // ...
});
```

The pattern is arrange/act/assert with a streaming drain in the
middle. `collectEvents` is two lines:

```typescript
// _helpers.ts:384-389
export async function collectEvents<E>(response: Response): Promise<E[]> {
  const events: E[] = [];
  if (!response.body) return events;
  await readNdjson<E>(response.body, (e) => events.push(e));   // ← prod kernel
  return events;
}
```

That `readNdjson` is the *same* function the production UI hooks use
(`useBriefingStream`, `useInvestigation`). When the test passes,
you've proven not just that the route emits a particular sequence of
bytes — you've proven that the production NDJSON consumer parses
those bytes into the same events the test sees. Drift between
producer and consumer is impossible because they share the kernel.

**Layers-and-hops — what fires inside a test:**

```
  One integration test invocation — labelled hops

  ┌─ test body ────────┐  hop 1: GET(req)            ┌─ /api/briefing route ──┐
  │  setAnthropicResp  │ ─────────────────────────► │  real handler          │
  │  setMcp scenario   │                            │  opens ReadableStream  │
  │  GET(req)          │                            └─────────┬──────────────┘
  │  collectEvents     │                                      │
  │  assert            │                                      │ hop 2: bootstrapSchema
  └────────────────────┘                                      ▼
                                              ┌─ mocked makeDataSource ─┐
                                              │ → currentMcp.callTool   │
                                              │   (6 bootstrap calls)   │
                                              └─────────┬───────────────┘
                                                        │ hop 3: workspace event
                                                        ▼
                                              ┌─ controller.enqueue(...) ─┐
                                              │   workspace event         │
                                              │   coverage_item × N       │
                                              │   reasoning_step × N      │
                                              └─────────┬─────────────────┘
                                                        │ hop 4: listTools
                                                        ▼
                                              ┌─ currentMcp.listTools ─┐
                                              └─────────┬──────────────┘
                                                        │ hop 5: runAgentLoop
                                                        ▼
                                              ┌─ mocked Anthropic.create ─┐
                                              │ → []                      │
                                              └─────────┬─────────────────┘
                                                        │ hop 6: enqueue('done')
                                                        ▼
                                              stream closes
                                                        │
                                                        │ hop 7: response body
                                                        ▼
  ┌─ collectEvents ────┐ ◄─────────────────────  ReadableStream
  │  readNdjson loop   │
  │  events.push(e)    │
  └─────────┬──────────┘
            │ hop 8: AgentEvent[]
            ▼
       assertions
```

Eight hops, all inside the test process, all deterministic.

**The phase-log assertion — what the contract says happens.**
`briefing.integration.test.ts:354-407` is the most production-shape
test in the file. The route's `finally` block emits one `console.log`
per request with the shape `{ route, sessionId, totalMs, phases:
[{phase, durationMs}] }`. The test spies on `console.log`, filters for
the line tagged `'/api/briefing'`, parses it as JSON, and asserts on
the phase names (`schema_bootstrap`, `coverage_gate`, `list_tools`,
`monitoring_scan`) and that every phase has a non-negative
`durationMs`. The whole observability contract — what the route logs
in production — is mechanically defended.

**Reality-pinning comments.** The header of `agent.integration.test.ts`
lists five "plan-vs-real-route deltas" Phase 3 uncovered (e.g. "the
query-flow param is `?q=...`, NOT `?query=...`," "the 404 body reads
`{ error: 'insight not found' }`, NOT `'anomaly not found'`"). Those
comments are gold — they document the moments the test author wrote
an assertion that was *plausible* but *wrong*, and pinned the actual
behavior instead. Anyone refactoring the route can read the test
file's header before changing route surfaces and avoid silently
breaking the contract.

### Move 3 — the principle

**Reuse the production consumer to drain the production producer.**
The temptation in integration testing is to write a parallel
consumer ("split on `\n`, JSON.parse each, push") — and then drift.
The repo's `collectEvents` calls the same `readNdjson` the UI hooks
call, so when the test passes you've proven the contract end-to-end:
producer produces what the consumer can consume, with the *exact*
same parsing rules. That's the strongest signal a test of this shape
can give.

## Primary diagram

```
  The full pattern — module mocks at the edge, real handler in the middle

  ┌─ Test file (briefing.integration.test.ts) ───────────────────────────┐
  │                                                                       │
  │  ┌─ Module-scope vi.mock (hoisted to top) ──────────────────────┐   │
  │  │   '@anthropic-ai/sdk'                ← scripted-queue fake    │   │
  │  │   'lib/mcp/session'                  ← session id stub        │   │
  │  │   'lib/mcp/connect'                  ← connect ok/!ok stub    │   │
  │  │   'lib/data-source'                  ← data-source factory   │   │
  │  └─────────────────────────────────────────────────────────────┘   │
  │                                                                       │
  │  ┌─ beforeEach reset hooks ─────────────────────────────────────┐   │
  │  │   _resetSchemaCache · resetAnthropicQueue · clearInsights ·  │   │
  │  │   _clearInvestigationCache · scenario state to 'ok'           │   │
  │  └─────────────────────────────────────────────────────────────┘   │
  │                                                                       │
  │  ┌─ Per test (Arrange/Act/Assert) ──────────────────────────────┐   │
  │  │   ARRANGE                                                     │   │
  │  │     setAnthropicResponses([...])     ← script the SDK         │   │
  │  │     currentMcp = makeMockTransport(scenario, opts)            │   │
  │  │     currentConn = { ok: ..., mcp: ... }                       │   │
  │  │                                                                │   │
  │  │   ACT                                                          │   │
  │  │     const req = new NextRequest(url, { signal? })             │   │
  │  │     const response = await GET(req)                           │   │
  │  │     const events = await collectEvents(response)              │   │
  │  │                          ▲                                     │   │
  │  │                          │  uses prod readNdjson kernel       │   │
  │  │                                                                │   │
  │  │   ASSERT                                                       │   │
  │  │     expect(response.status).toBe(200 | 401 | 404)              │   │
  │  │     expect(types).toContain('workspace')                       │   │
  │  │     expect(types[last]).toBe('done')   (or .not.toContain on  │   │
  │  │                                         error / abort paths)  │   │
  │  │     expect(currentMcp.callTool).toHaveBeenCalledWith(...)     │   │
  │  │     // phase log spy assertions                                │   │
  │  └─────────────────────────────────────────────────────────────┘   │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘

  17 tests across 2 files cover: happy path · demo replay · 401 unauthed
  · listTools failure · SDK throw mid-stream · cancellation (pre-aborted)
  · phase-log shape · diagnose/recommend/query flows · recovery turn
  · fallback diagnosis · 404 unknown insight · sessionId threading
```

## Elaborate

This pattern is what most teams reach for when "unit tests" hit their
ceiling — the agent loop is well-tested in isolation, but the route
handler does *more*: it owns the bootstrap order, the phase timing
logs, the auth gate, the demo replay branch, the cancellation
handling, the NDJSON framing. Integration tests catch the wiring
between those pieces. They're slower than unit tests (~2-3x per test
because the whole route runs) but still 6.2s for all 24 files because
nothing goes off the box.

The `vi.mock`-hoisting model is vitest-specific (and shared with
Jest); other runners have their own idioms. The kernel — "intercept
the dependency at module resolution, drive the unit, drain the side
effects" — generalizes. Node's `--experimental-import-mock` and the
ESM `register()` hook are the language-native primitives most test
runners build on.

What the harness *doesn't* test: the React side of the streaming
contract. The route emits events in a specific order; whether
`useBriefingStream` correctly updates state in that order, handles a
mid-stream error event, or recovers from an aborted stream is a
*different* test (one that doesn't exist yet — see `audit.md` lens 1).
The harness pins the producer; the matching consumer-side harness
would pin `useBriefingStream` against the same event sequence.
Building it would close half of the audit's "UI layer is naked" gap.

The reality-pinning comments deserve their own callout. The five
deltas in `agent.integration.test.ts`'s header (`?q=` vs `?query=`,
`'insight not found'` vs `'anomaly not found'`, etc.) are documented
because the test author wrote an assertion against the plan and the
test failed — and instead of changing the route to match the plan,
they updated the test to pin the actual behavior. That choice
preserves the contract the UI depends on. The header comment is the
audit trail for anyone refactoring later.

## Interview defense

**Q: Why not use a real Anthropic key + a recording proxy
(`@anthropic-ai/sdk`'s tape mode, nock, MSW)?**

Three reasons. First, recordings still go stale — Anthropic changes
the response shape, your tapes don't, and your test starts proving
"the parser handles the *historical* response," which is exactly the
problem fixture-based tests can have (file 04 wears its discipline
explicitly; recording tests usually don't). Second, recordings can't
easily script error paths — "the SDK throws 529 overloaded mid-loop"
is one line with the scripted queue, but it's a fight with recording
tools. Third, the test wall-clock blows up — even with cached
responses you're paying the SDK setup cost, and the suite goes from
6.2s to a minute. The scripted-queue fake matches the SDK type
contract; recordings match the SDK *behavior*. For these tests we
care about the contract.

**Q: Load-bearing part of this kernel — what breaks if missing?**

`collectEvents` reusing the production `readNdjson` kernel. The
temptation is to write a parallel consumer (`response.text().then(t =>
t.split('\n').filter(Boolean).map(JSON.parse))`). If you do, the test
is parsing NDJSON by *one* set of rules and the live UI is parsing it
by *another* — and when one drifts (say, the route starts emitting
multi-line JSON objects, or the consumer starts handling trailing
whitespace differently), the test still passes while the UI breaks.
Sharing the kernel means producer-consumer drift is impossible: the
test fails the same way the UI would.

```
  Why share the kernel — drift surfaces

  parallel test consumer                    shared readNdjson
  ──────────────────────                    ─────────────────
  test: handles split('\n')                 test: handles split('\n')
  UI:   handles split('\n')                 UI:   handles split('\n')
  → independent: drift OK                   → SAME function: drift impossible

  drift example: route starts emitting      drift example: route starts
  events with trailing whitespace           emitting same shape
  test still passes (split handles it)      test would catch immediately if
  UI breaks (its parser is stricter)         UI's parser is stricter, because
                                             they ARE the same parser
```

**Q: What ISN'T this catching?**

The React consumer side. The harness proves the route emits events in
a specific NDJSON sequence; whether `useBriefingStream` reduces those
events into the right React state — handling double-mount under
StrictMode, sessionStorage hydration, in-flight cancel on unmount,
mid-stream `error` event surfacing — is unverified. The route is
trusted; the hook isn't. That's the top finding of `audit.md`.

## See also

  → `01-injected-fake-anthropic-client.md` — the SDK-fake kernel this
    harness scales up
  → `02-mcp-as-callable-port.md` — the port that `currentMcp` /
    `makeMockTransport` substitutes for in this layer
  → `05-tracked-env-stubbing.md` — the isolation discipline this
    harness leans on (`resetAnthropicQueue`, `_resetSchemaCache`,
    etc., in every `beforeEach`)
  → `audit.md` lens 6 — testing AI features, where this harness pins
    the deterministic-harness-around-probabilistic-core shape at the
    route level
