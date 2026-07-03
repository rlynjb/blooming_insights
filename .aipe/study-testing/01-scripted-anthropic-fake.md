# Scripted Anthropic fake

*Test double · Language-agnostic pattern · Deterministic side of the seam*

The single technique that makes every agent-loop test in this repo
possible. The Anthropic SDK is replaced at module load with a class whose
`messages.create()` drains a shared queue of pre-scripted responses. Tests
fill the queue in `beforeEach`; the agent loop runs against it as if it
were the real network.

## Zoom out, then zoom in

```
  Zoom out — where the scripted Anthropic fake lives

  ┌─ Test file ──────────────────────────────────────────────────┐
  │ vi.mock('@anthropic-ai/sdk', () => mockAnthropicModule())     │
  │ (module-scope; hoisted before the route module loads)         │
  └───────────────────────────┬──────────────────────────────────┘
                              │
  ┌─ Route module ───────────▼──────────────────────────────────┐
  │ const anthropic = new Anthropic({ apiKey: … })               │
  │   ← this `new` hits ★ MockAnthropic ★                        │
  │ await anthropic.messages.create({ … })                       │
  │   ← this hits the scripted-queue drain                       │
  └───────────────────────────┬──────────────────────────────────┘
                              │
  ┌─ Shared queue (module state) ────────────────────────────────┐
  │ anthropicQueue.shift() → returns next scripted message       │
  │ anthropicCalls.push(params) → records what was asked         │
  │ resetAnthropicQueue() in beforeEach clears both              │
  └──────────────────────────────────────────────────────────────┘
```

The lump in the middle is what we're focused on: `MockAnthropic`, defined
as an actual `class` (not a `vi.fn().mockImplementation(...)`) because
vitest's spy wrapper isn't `new`-able unless the underlying function is
declared as `function` or `class`. The route does `new Anthropic({apiKey})`
inside the handler, so the mock has to be `new`-able.

## Structure pass

- **Layers**: test file → module boundary (`vi.mock`) → route module → SDK
  boundary (`new Anthropic()`) → mocked class → shared queue.
- **Axis (control)**: who decides what the "model" says next? The test does
  — it calls `setAnthropicResponses([...])` before the route runs, and the
  route reads what the test wrote.
- **Seam**: `new Anthropic(…)`. That single constructor call is the seam
  where prod and test diverge. The scripted queue is what makes that
  seam usable in an assertion.

## How it works

The pattern lives in two places: `test/api/_helpers.ts:24-136` as the
canonical helper used by the two integration tests, and inline in each of
`test/agents/{base,monitoring,diagnostic,recommendation,query}.test.ts`
as a per-file `buildFakeAnthropic(responses)` (the five agent test files
predate the helper — same pattern, five copies).

### Move 1 — the shape

You already know how to script a request/response round trip: `fetch`
returns a `Promise<Response>`, you resolve it with a fixed body. Same idea
here, but the "response" is a fully-formed `Anthropic.Messages.Message`
object with `content` blocks (text or tool_use), a `stop_reason`, a
`usage` block. The test pre-builds a *sequence* of these — the model's
scripted turns — and the fake pops them one at a time.

```
  Scripted Anthropic — the shape of the queue

  test setup                    each `messages.create()` call
  ──────────                    ──────────────────────────────
   [ Msg 1 ]                     shift()  →  Msg 1  (turn 1: tool_use)
   [ Msg 2 ]  ═══════════════▶   shift()  →  Msg 2  (turn 2: tool_use)
   [ Msg 3 ]                     shift()  →  Msg 3  (turn 3: end_turn)
                                 shift()  →  undefined → THROW
                                             ("scripted queue exhausted")
```

The throw on exhaustion is deliberate — tests should fail loudly when the
agent loop runs longer than scripted, not silently hang on `undefined`.

### Move 2 — the moving parts

**The `vi.mock` call must be at module scope.** Vitest hoists `vi.mock` to
the top of the file *before* any imports run, so by the time the route
module does `import Anthropic from '@anthropic-ai/sdk'`, the mock is
already installed. If you put `vi.mock` inside a `beforeAll`, it fires
too late — the route has already imported the real SDK. The comment at
`test/api/briefing.integration.test.ts:17-19` names this explicitly:

```typescript
// Mocks live at module scope so they're registered before the route module is
// imported (vitest hoists `vi.mock`).
```

**The mock must be a class, not a spy.** From `_helpers.ts:66-84`:

```typescript
export function mockAnthropicModule(): { default: unknown } {
  class MockAnthropic {
    messages = {
      create: async (params: Anthropic.Messages.MessageCreateParamsNonStreaming) => {
        anthropicCalls.push(params);
        const next = anthropicQueue.shift();
        if (!next) throw new Error('mock anthropic: scripted queue exhausted');
        return typeof next === 'function' ? next() : next;
      },
    };
  }
  return { default: MockAnthropic };
}
```

The route does `new Anthropic({apiKey})`. If the mock were a plain
function, `new` would throw `TypeError: X is not a constructor`. `class
MockAnthropic` is both callable-with-`new` and lets us attach the
`messages` field naturally.

Notice `anthropicCalls.push(params)` on line 3. Every call the route
makes is recorded in a module-level array. Tests can assert on what was
asked: which `tools` were sent, what the system prompt was, what
`max_tokens` was set to. This is the observability half of the fake.

**Function entries are the error-injection hook.**
`setAnthropicResponses([mockAnthropicResponse({...}), anthropicErrorResponse('boom')])`
scripts a two-turn sequence where turn 2 throws. From `_helpers.ts:89-93`:

```typescript
export function anthropicErrorResponse(message: string): () => Anthropic.Messages.Message {
  return () => {
    throw new Error(message);
  };
}
```

The `typeof next === 'function' ? next() : next` line in the drain code
means a function in the queue gets *called*, and if it throws, the throw
propagates up through `runAgentLoop` into the route's catch block, which
emits an `error` event on the NDJSON stream. That's how tests script a
mid-stream SDK failure.

**The queue is module state; `resetAnthropicQueue()` MUST run in
`beforeEach`.** From `_helpers.ts:52-55`:

```typescript
export function resetAnthropicQueue(): void {
  anthropicQueue.length = 0;
  anthropicCalls.length = 0;
}
```

Vitest resolves the mock factory once — the two module-level arrays are
shared across every test in every file that mocks `@anthropic-ai/sdk`.
Skip the reset and test 2 either sees leftover responses from test 1 or,
worse, records assertions against calls from both. Every integration
test file has this in its `beforeEach`. Skipping it is the exact silent
failure the scripted-queue architecture is vulnerable to.

**Building a response shape is enough work to earn a helper.** From
`_helpers.ts:96-136`, `mockAnthropicResponse({text, toolUses, stop_reason,
usage})` fills all 12 required fields on `Anthropic.Messages.Message`
(model, id, container, stop_details, stop_sequence, usage cache fields,
etc.). Without the helper every test would fill these by hand and drift.

### Move 3 — the principle

**Constructor injection at the SDK boundary is what makes this whole test
strategy work.** `runAgentLoop(anthropic, mcp, …)` takes the SDK as a
parameter. If it did `import { anthropic } from './anthropic-singleton'`
or `new Anthropic()` inside itself, the test would be forced to
`vi.mock` on domain code — and every test would then be testing the
mock's behavior, not the loop's. The seam is inherited from the design.
The scripted queue is what fills the seam.

Two industry names for what this is: **module-boundary mocking** (the
Jest/Vitest lineage) and **stateful test double** (the Meszaros
xUnit-Test-Patterns lineage). Either term identifies the pattern in a
one-second interview lookup.

## Primary diagram

```
  Scripted Anthropic fake — the whole shape

  ┌─ test/api/briefing.integration.test.ts ──────────────────────┐
  │                                                              │
  │ vi.mock('@anthropic-ai/sdk',                                 │
  │   () => mockAnthropicModule())          ◄─── hoisted first   │
  │                                                              │
  │ beforeEach(() => {                                           │
  │   resetAnthropicQueue()                                      │
  │   setAnthropicResponses([                                    │
  │     mockAnthropicResponse({ toolUses: [{name:'x',input:…}]}),│
  │     mockAnthropicResponse({ text: '[{…anomalies…}]' }),      │
  │   ])                                                         │
  │ })                                                           │
  │                                                              │
  │ it('emits insights on happy path', async () => {             │
  │   const res = await GET(makeRequest())                       │
  │   const events = await collectEvents(res)                    │
  │   expect(events).toContainEqual({ type: 'insight', … })      │
  │   expect(getAnthropicCalls()).toHaveLength(2)                │
  │ })                                                           │
  └──────────────────┬───────────────────────────────────────────┘
                     │
  ┌─ test/api/_helpers.ts ────────────────────────────────────────┐
  │  anthropicQueue: ScriptedResponse[]  (module state)           │
  │  anthropicCalls: Params[]            (module state)           │
  │                                                                │
  │  class MockAnthropic { messages.create = async (params) => {   │
  │    anthropicCalls.push(params)                                 │
  │    const next = anthropicQueue.shift()                         │
  │    if (!next) throw new Error('scripted queue exhausted')      │
  │    return typeof next === 'function' ? next() : next           │
  │  }}                                                            │
  └──────────────────┬─────────────────────────────────────────────┘
                     │  vi.mock returns { default: MockAnthropic }
                     ▼
  ┌─ app/api/briefing/route.ts (production code, unchanged) ──────┐
  │  const anthropic = new Anthropic({ apiKey: … })  // ← Mock    │
  │  const runResult = await runAgentLoop(anthropic, mcp, …)      │
  │    // inside: await anthropic.messages.create({tools, msgs})   │
  │    // ← drains the queue                                       │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern is not unique to this repo; it's what Jest and Vitest were
designed for. Where this repo goes further than the average codebase:

- **The recorded-call half.** Most module mocks just replace behavior.
  This one also *records* every call in `anthropicCalls`, exposed via
  `getAnthropicCalls()`. That's the observability seam — tests assert
  on both what came out AND what went in. See the integration tests'
  `expect(getAnthropicCalls().at(-1)?.system).toContain(...)` patterns.
- **The error-injection hook via function-in-queue.** Most fakes handle
  errors by having a separate `.mockRejectedValueOnce(...)` path. This
  one puts the "throwing function" in the same queue as the "returning
  message" values, so the temporal ordering of successes and failures
  is a single flat list. Reads cleaner in test setup.
- **The five agent test files' inline builders predate the helper.**
  `test/agents/{base,monitoring,diagnostic,recommendation,query}.test.ts`
  each have their own `function buildFakeAnthropic(responses)`. Same
  pattern, five copies. Consolidation is a cleanup task, but the
  duplication doesn't hide bugs — each file's builder is self-contained.

Related standard terms worth naming for the interview:
- **Test double** (Meszaros): the umbrella term for stubs, mocks, spies,
  fakes. `MockAnthropic` is a **fake** in this taxonomy — it has working
  behavior (drains a queue) rather than just recording calls.
- **Module-boundary mocking**: `vi.mock('@anthropic-ai/sdk', …)` operates
  at the ES module boundary. The route module gets the fake as its
  default export.
- **Response staging**: the queue-and-drain pattern where a test stages
  the future responses before the code under test runs.

## Interview defense

**Q: Why not just mock `messages.create` directly with `vi.fn()`?**

A: Because the route does `new Anthropic({apiKey})` — a `vi.fn()`
mock isn't `new`-able. `class MockAnthropic` is. The `new` matters
because it's how the route gets a fresh SDK instance per-request in
production; the test has to match that shape or the mock doesn't
apply.

**Q: What's the failure mode if you forget `resetAnthropicQueue()`?**

A: The queue is module-level state — vitest resolves the factory
once. If test 1 scripts 3 responses and consumes 2, test 2 starts
with 1 leftover response. Test 2's assertions on `getAnthropicCalls()`
count are also off by whatever test 1 pushed. It'd manifest as
"tests pass in isolation but fail when run together" — the classic
shared-state test smell. Every integration test file has
`resetAnthropicQueue()` in `beforeEach` for this reason.

**Q: When would you break this pattern and use MSW or a real HTTP
mock instead?**

A: When you need to test something below the SDK level — the
retry-on-429 behavior of the SDK itself, HTTP timeouts, connection
pooling. This repo doesn't test those because they belong to
Anthropic. If you were testing a custom fetch layer that wraps the
SDK, MSW at the network boundary would be the right seam. Above the
SDK, module-level fake is faster and reads cleaner.

**Q: What's the load-bearing part someone would forget?**

A: The `throw new Error('scripted queue exhausted')` on `shift() ===
undefined`. Without it, the fake returns `undefined`, the route calls
`.content` on undefined, and the test fails with `TypeError: Cannot
read property 'content' of undefined` two frames deep in the loop.
With the throw, the test fails immediately with "scripted queue
exhausted" — you know instantly the loop ran longer than you
scripted. It's a diagnostic aid, not just error handling.

## See also

- `02-injected-datasource-fake.md` — the *other* seam this test
  strategy fills. Same shape (inject a fake) at a different boundary.
- `04-signal-class-gated-eval.md` — the probabilistic side of the
  seam. Same agents, real SDK, rubric verdict instead of equality.
- `audit.md` lens 2 — where this pattern sits in the overall test
  pyramid.
