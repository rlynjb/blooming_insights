# 01 — injected fake Anthropic client

*Industry term:* scripted **fake** (vs mock) over **dependency
injection** — Language-agnostic

## Zoom out, then zoom in

You've passed a `fetch` into a function in a test so it returns
canned JSON instead of hitting the network. Same shape here, just one
layer up: the production code takes a `messages.create` surface, the
test hands it one that drains a scripted queue.

```
  Zoom out — where this pattern lives in this codebase

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  React components, hooks                                 │
  └──────────────────────────────┬───────────────────────────┘
                                 │
  ┌─ API routes ─────────────────▼───────────────────────────┐
  │  GET /api/briefing   GET /api/agent                      │
  └──────────────────────────────┬───────────────────────────┘
                                 │
  ┌─ Agents (lib/agents) ────────▼───────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent ·                     │
  │  RecommendationAgent · QueryAgent                        │
  │             │                                             │
  │             ▼                                             │
  │  runAgentLoop(anthropic, dataSource, ...)                │
  │             ▲                                             │ ← we are here
  │             │  ★ THIS SEAM ★                              │
  │             │  pass a real Anthropic instance in          │
  │             │  production; pass a scripted fake in tests  │
  └─────────────┴─────────────────────────────────────────────┘
                │
  ┌─ External (provider) ────────▼───────────────────────────┐
  │  @anthropic-ai/sdk → api.anthropic.com                   │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** The agent loop's only contact with Anthropic is through
the `anthropic` parameter — specifically `anthropic.messages.create(params)`.
Production hands it `new Anthropic({ apiKey })`; tests hand it a
scripted fake whose `create()` drains an array of pre-built
`Anthropic.Messages.Message` objects in order. The loop can't tell the
difference because the type signature is the same. No network, no API
key, no flakiness — and the assertions become deterministic on top of
a probabilistic system.

## Structure pass

**Layers — three depths the pattern sits across:**
- outer: the test (scripts the responses, asserts on the result)
- middle: `runAgentLoop` (the code under test — runs identically in
  both worlds)
- inner: `anthropic.messages.create()` (the boundary — real in
  production, fake in tests)

**One axis held constant — *who controls the response*:**
- outer (test): the test author chose the response array up front
- middle (loop): doesn't know or care; treats the response as data
- inner (boundary): in tests, the queue; in prod, the model

**The seam — where the axis flips:** at `anthropic.messages.create`.
On the test side, control belongs to the script. On the production
side, control belongs to the model. The loop above the seam reads the
same shape in both cases (an `Anthropic.Messages.Message` with
`content` and `stop_reason`) — the *typed contract* is what makes the
substitution safe.

## How it works

### Move 1 — the mental model

A scripted **fake** is an object you build in the test that satisfies
the same type as the real dependency, but whose behavior is a queue of
pre-baked responses you control. Each test fills the queue with the
exact sequence of Anthropic messages it wants the loop to see, then
asserts on what the loop produced. The standard term here is "fake"
(not "mock") — a mock records calls *for* assertions; a fake stands in
*for* a real implementation. This repo uses both: the fake provides
the substitute behavior, `vi.fn()` records the calls.

```
  The scripted-queue kernel

  test setup                runtime                       test assertion
  ──────────                ────────                      ──────────────
  responses = [             create() call 1               expect(result
    msg_a,        ─►        ─► returns msg_a (idx=0→1)      .finalText)
    msg_b,                  create() call 2                 .toContain(...)
    msg_c,        ─►        ─► returns msg_b (idx=1→2)
  ]                         create() call 3                expect(call
                            ─► returns msg_c (idx=2→3)       Count()).toBe(3)
                            create() call 4
                            ─► throws "no scripted
                               response at index 3"  ──► test fails LOUD
                                                         (no silent undefined)
```

The kernel is six lines: an array, an index, a `vi.fn()` that returns
`responses[idx++]` and throws if it overruns. The "throws on overrun"
detail is load-bearing — it converts an off-by-one in the test setup
into an immediate failure instead of an `undefined` return that the
loop then crashes on with a confusing stack.

### Move 2 — the step-by-step walkthrough

**Build the response factory.** The real
`Anthropic.Messages.Message` has 12+ fields the loop never reads (`id`,
`role`, `usage.cache_creation`, `container`, ...). A helper builds the
minimum shape and casts through `unknown` to satisfy the type checker.

```
  Shape contract — what the loop actually reads vs what the type wants

  ┌─ Anthropic.Messages.Message (12+ fields) ───────────┐
  │                                                       │
  │   the loop READS:           the type WANTS:           │
  │   ─────────────             ──────────────            │
  │   content[]    ◄────►       content                   │
  │   stop_reason  ◄────►       stop_reason               │
  │                             id, role, model, usage,   │
  │                             container, stop_details,  │
  │                             stop_sequence, ...        │
  │                             ↑ all of these get        │
  │                               dummy values            │
  └─────────────────────────────────────────────────────┘
```

The repo carries this in two places:

  → `test/agents/base.test.ts:23-56` — local to the agent unit tests
  → `test/api/_helpers.ts:96-136` (`mockAnthropicResponse`) — the
    central version for the integration tests

These should be one helper; they aren't yet (drift risk noted in
`audit.md` lens 2).

**Build the scripted Anthropic.** A factory function returns the
fake and a `callCount` accessor so assertions can pin "exactly 2
SDK calls fired."

```typescript
// test/agents/base.test.ts:16-56  (real repo code, annotated)

function buildFakeAnthropic(responses: FakeResponse[]): {
  anthropic: unknown;
  callCount: () => number;
} {
  let idx = 0;
  let count = 0;

  // vi.fn() wraps so we can also assert `.mock.calls` later (mock recording)
  const create = vi.fn(async () => {
    count++;
    const resp = responses[idx];
    if (!resp) throw new Error(`No scripted response at index ${idx}`);
    idx++;                                                // ← bump after read
    return {
      id: `msg_${idx}`,
      type: 'message' as const,
      role: 'assistant' as const,
      model: AGENT_MODEL,
      // ...12 more dummy fields the loop never reads...
      content: resp.content,
      stop_reason: resp.stop_reason,
    } satisfies Partial<Anthropic.Messages.Message>
      as unknown as Anthropic.Messages.Message;          // ← double-cast to
  });                                                    //   satisfy the SDK

  const anthropic = { messages: { create } };
  return { anthropic, callCount: () => count };
}
```

The `satisfies Partial<...> as unknown as ...` pattern is the
TypeScript-specific dance for "I know I'm returning less than the
full type, and I'm asserting the loop doesn't care." It's noisy,
honest, and pinned to the SDK type — when Anthropic ships a v5 that
renames `content`, the test fails at the type level, not at runtime.

**Use it in a test.** Each test scripts the exact sequence the loop
will encounter:

```typescript
// test/agents/base.test.ts:105-147  (the "executes a tool then finishes" test)

const { anthropic, callCount } = buildFakeAnthropic([
  // Turn 1: model requests a tool call
  { content: [toolUseBlock('tu1', 'get_project_overview', { project_id: 'p' })],
    stop_reason: 'tool_use' },
  // Turn 2: model returns final text after seeing the tool result
  { content: [textBlock('done: 5 customers')],
    stop_reason: 'end_turn' },
]);

const mcp = buildFakeMcp(async () => ({                  // ← see file 02
  isError: false,
  content: [],
  structuredContent: { data: { total_customers: 5 } },
}));

const result = await runAgentLoop({
  anthropic: anthropic as unknown as Anthropic,          // ← injection point
  dataSource: mcp,
  agent: 'monitoring',
  system: 'You are a monitoring agent.',
  userPrompt: 'Check the project.',
  toolSchemas: fakeToolSchemas,
});

expect(result.finalText).toContain('done');              // assertions on the
expect(result.toolCalls).toHaveLength(1);                // result of REAL code
expect(callCount()).toBe(2);                             // running against a
                                                         // scripted Anthropic
```

The real `runAgentLoop` runs end-to-end. It parses the `content`
blocks, finds the `tool_use`, dispatches to `dataSource.callTool`,
appends a `tool_result` message, calls `create()` again, sees the
`end_turn`, and returns. *Every line of that code is exercised.* The
only thing replaced is the outermost edge.

**Layers-and-hops — the full request flow in a test:**

```
  Inside one test invocation — labelled hops

  ┌─ Test ───────────┐  hop 1: runAgentLoop({...})      ┌─ runAgentLoop ──┐
  │  it(...)         │ ───────────────────────────────► │  base-legacy.ts  │
  │                  │  hop 8: { finalText, toolCalls } │                  │
  │                  │ ◄─────────────────────────────── │                  │
  └──────────────────┘                                  └──────┬───────┬──┘
                                                              │       │
                                       hop 2: messages.create │       │ hop 4: callTool('get_project_overview', ...)
                                                              ▼       ▼
                                          ┌─ Fake Anthropic ─┐  ┌─ Fake McpCaller ─┐
                                          │  buildFakeAnthr. │  │  buildFakeMcp    │
                                          └────────┬─────────┘  └────────┬─────────┘
                                                   │                     │
                                       hop 3: msg w/ tool_use            │ hop 5: { isError: false, ... }
                                                   │                     │
                                                   └──────► loop ◄───────┘
                                                              │
                                                hop 6: messages.create (turn 2)
                                                              │
                                                              ▼
                                                       msg w/ text "done"
                                                              │
                                                              hop 7: parse, append
                                                              │
                                                              ▼  (back to hop 8 above)
```

Every hop crosses a boundary you control. No hop reaches a network, a
file, or a real model.

**Per-test reset is mandatory.** The `anthropicQueue` in
`test/api/_helpers.ts:44` is module-level state because vitest
re-resolves `vi.mock` factories once. Without `resetAnthropicQueue()`
in `beforeEach` (`briefing.integration.test.ts:98`), the second
test sees the first test's leftover responses and either fails on the
wrong assertion or — worse — passes for the wrong reason. Module-level
state is the price you pay for hoisted `vi.mock`; explicit per-test
reset is the discipline that keeps it safe.

### Move 3 — the principle

**Test the code, not the framework.** When you mock the SDK at the
edge instead of mocking every internal helper, the test exercises your
own code under realistic conditions — including the parsing, the
control flow, the error handling. The model is unknowable; everything
*around* the model is deterministic. Inject the unknowable, run the
deterministic. The seam you choose is the contract you trust.

## Primary diagram

```
  The full pattern — scripted fake at the SDK boundary

  ┌─ Test file (agents/base.test.ts) ────────────────────────────────────┐
  │                                                                       │
  │  1. Build the response queue           2. Build the fake SDK          │
  │     ┌────────────────────────┐            ┌────────────────────────┐ │
  │     │ [msg_a (tool_use),     │  ──────►   │ class { messages: {    │ │
  │     │  msg_b (end_turn)]     │            │   create: vi.fn(...)   │ │
  │     └────────────────────────┘            │ } }                    │ │
  │                                            └───────────┬────────────┘ │
  │                                                        │              │
  │  3. Inject + run                                       │              │
  │     ┌────────────────────────────────────────────────▼────────────┐  │
  │     │  await runAgentLoop({ anthropic: fake, dataSource: ... })   │  │
  │     │                                                              │  │
  │     │  ┌────────────────────────────────────────────────────────┐ │  │
  │     │  │  REAL code (lib/agents/base-legacy.ts)                 │ │  │
  │     │  │  ─ parse content blocks                                │ │  │
  │     │  │  ─ dispatch tool_use → dataSource.callTool             │ │  │
  │     │  │  ─ append tool_result, loop                            │ │  │
  │     │  │  ─ enforce maxTurns / maxToolCalls                     │ │  │
  │     │  │  ─ fire onText / onToolCall / onToolResult             │ │  │
  │     │  └────────────────────────────────────────────────────────┘ │  │
  │     │                                                              │  │
  │     │  returns { finalText, toolCalls }                            │  │
  │     └──────────────────────────┬───────────────────────────────────┘  │
  │                                │                                       │
  │  4. Assert                     ▼                                       │
  │     expect(result.finalText).toContain('done')                         │
  │     expect(result.toolCalls).toHaveLength(1)                           │
  │     expect(callCount()).toBe(2)        ← did the loop call exactly N? │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘

  no network · no api key · no model variability · same code path as prod
```

## Elaborate

The pattern is a direct application of dependency injection — pass
the dependency in, don't `import` it inside the function. The
`runAgentLoop` signature
(`lib/agents/base-legacy.ts`, parameter `anthropic: Anthropic`) made
the test possible. If the loop had done `import Anthropic from
'@anthropic-ai/sdk'; const client = new Anthropic(...)` inside
itself, you'd need module mocking (the heavier `vi.mock` machinery
that integration tests resort to) instead of plain DI.

The split in this repo is honest about that:

  → **Agent unit tests** inject the fake directly (lightweight, fast).
  → **Integration tests** can't — the route module does
    `new Anthropic({ apiKey })` inside the handler, so they fall back
    to `vi.mock('@anthropic-ai/sdk', () => mockAnthropicModule())`
    at module scope (`test/api/briefing.integration.test.ts:38`).
    Same kernel underneath, different injection mechanism above it.

What this *won't* tell you: whether the model actually produces
parseable JSON in the wild. That's the eval problem — see the
`study-ai-engineering` arc. The unit tests prove the loop handles
the shapes you can imagine; the eval suite proves the model produces
those shapes often enough to ship. Both are necessary; neither is
sufficient.

## Interview defense

**Q: Why use a fake instead of mocking `Anthropic` with `vi.fn()` and
returning whatever?**

A `vi.fn().mockResolvedValue({})` returns the *same thing* every
call. The agent loop needs a *sequence* — turn 1 is a tool_use, turn 2
is the end_turn after the model sees the tool result. A scripted queue
gives you that ordering. The vi.fn wrapper is still there — we use it
to record `.mock.calls` for assertions like "the second create call's
`system` field contains the synthesis instruction" — but the queue is
what makes the *sequence* testable.

```
  Why a queue, not a constant return

  vi.fn().mockResolvedValue(msg)        scripted queue ([a, b, c])
  ──────────────────────────────        ─────────────────────────
  every call → same msg                 call 1 → a
  → loop sees same tool_use forever     call 2 → b
  → tests for maxTurns ARE possible     call 3 → c
    but tests for "tool then finish"    → tests the actual ordering
    are not                               the loop will see in prod
```

**Q: What's the load-bearing part of this kernel — the one part that
if missing, the suite stops catching something specific?**

The throw-on-overrun (`if (!resp) throw new Error('No scripted
response at index ${idx}')`). Without it, the fake returns `undefined`
when the queue is empty, and the agent loop reads
`undefined.content` and throws a generic `TypeError: Cannot read
properties of undefined (reading 'content')`. With it, the test fails
with "No scripted response at index 3" — which immediately tells you
the loop made more SDK calls than your script anticipated. That single
line is the difference between a 5-minute debug and a 30-second one.

**Q: What ISN'T this catching?**

The model's actual behavior. If GPT/Claude starts returning
recommendations in YAML instead of JSON tomorrow, every test here
still passes — the scripted queue happens to return JSON, so
`parseAgentJson` succeeds. The eval suite catches that; the unit tests
don't, and shouldn't.

## See also

  → `02-mcp-as-callable-port.md` — the matching pattern at the MCP
    boundary
  → `06-scripted-ndjson-integration-harness.md` — same fake, applied
    at the route level
  → `audit.md` lens 6 — testing AI features, where this pattern is
    load-bearing
