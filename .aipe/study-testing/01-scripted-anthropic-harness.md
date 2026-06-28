# 01 — Scripted Anthropic harness
*Industry name: constructor-injected fakes / dependency injection for testability. Type: Industry standard.*

## Zoom out — where this pattern lives

```
  the harness sits at the SDK seam, not at the network

  ┌─ Test layer ─────────────────────────────────────────────────────┐
  │  test/agents/base.test.ts                                         │
  │  buildFakeAnthropic([response, response, ...])                    │
  │  ★ THIS PATTERN ★ — scripted multi-turn fake                      │
  └─────────────────────────────┬────────────────────────────────────┘
                                │  injected via constructor / param
  ┌─ Agent layer ───────────────▼────────────────────────────────────┐
  │  runAgentLoop({ anthropic, dataSource, ... })                    │
  │  MonitoringAgent(anthropic, dataSource, schema, allTools)         │
  └─────────────────────────────┬────────────────────────────────────┘
                                │  WOULD call .messages.create()
  ┌─ Provider layer (NEVER REACHED IN TESTS) ────────────────────────┐
  │  Anthropic API                                                    │
  └──────────────────────────────────────────────────────────────────┘
```

The agent code receives `anthropic` as a parameter. In production, it's
a real `new Anthropic({ apiKey })`. In tests, it's a hand-rolled object
whose `.messages.create` drains a scripted queue. No network. No SDK
internals. No `nock` / `msw` / HTTP-level mocking. The seam is the
interface, not the wire.

## Structure pass — the skeleton this pattern hangs on

**Layers:** test → agent → provider. The fake replaces the provider
end-to-end without touching the agent.

**Axis: control — who decides what the next "model response" is?**

```
  control flips at the agent / provider seam

  ┌─ test  ───────┐   seam: anthropic.messages.create   ┌─ provider ──┐
  │  TEST decides │ ════════════════════════════════════►│  (faked)    │
  │  every reply  │     (responses[idx++])               │  returns    │
  │  in advance   │                                      │  scripted   │
  └───────────────┘                                      └─────────────┘
         ▲                                                      ▲
         └── same axis (control), two answers ──────────────────┘
                → this boundary carries a contract:
                  the agent loop must work for ANY sequence
                  of valid SDK responses
```

In production the LLM decides what comes back. In tests the script
does. The agent loop doesn't know the difference and shouldn't.

**The seam that matters:** `Anthropic.Messages.Message` shape.
Anything that satisfies the type satisfies the agent. The fake builds
one by hand (`base.test.ts:28-48`).

## How it works

### Move 1 — the mental model

You know how `useState` takes whatever you hand it as initial value and
the hook doesn't care if you got it from a fetch, a constant, or a
test? Same idea. The agent loop takes an `anthropic` parameter and
doesn't care if it's the real SDK or a hand-rolled object with a
`.messages.create` method. **Constructor injection at the seam means
the test gets to BE the SDK for one method.**

```
  The pattern — a scripted FSM playing the model's role

       responses = [r1, r2, r3]      ┐
       idx       = 0                  │  test owns the script
                                      ┘
       ┌──────────────────────────────────┐
       │  fake.messages.create() {        │  → responses[idx++]
       │    return responses[idx++]       │     (throws if out of script)
       │  }                               │
       └──────────────────────────────────┘
                       │
                       │  called once per agent-loop turn
                       ▼
       ┌──────────────────────────────────┐
       │  runAgentLoop({                  │
       │    anthropic: fake,              │  ← INJECTED here
       │    dataSource: fakeMcp,          │  ← also injected
       │    ...                           │
       │  })                              │
       └──────────────────────────────────┘
                       │
                       │  asserts on result.toolCalls,
                       │  result.finalText, callCount()
                       ▼
                  test passes / fails
```

The script is the test's hypothesis: "given these responses in this
order, the loop should do X." Each `it()` ships its own script.

### Move 2 — the step-by-step walkthrough

#### Step 1 — the agent class takes its deps in the constructor

The whole pattern depends on the agent being **injectable**, not on the
test being clever. The agent class signature is the load-bearing thing:

```ts
// lib/agents/monitoring.ts:73-80
export class MonitoringAgent {
  constructor(
    private anthropic: Anthropic,             // ← swappable
    private dataSource: McpCaller,            // ← swappable
    private schema: WorkspaceSchema,          // ← swappable
    private allTools: McpToolDef[],           // ← swappable
    private sessionId?: string,
  ) {}
```

And the `McpCaller` type is deliberately narrowed so the fake only has
to implement one method:

```ts
// lib/agents/base.ts:11-14
/** The agent-facing subset of DataSource used by AptKit tool-registry
 *  adapters. Full data sources can list tools, but reusable agents
 *  only need the callTool execution seam. */
export type McpCaller = Pick<DataSource, 'callTool'>;
```

`Pick<DataSource, 'callTool'>` is the trick. The full `DataSource`
interface has six methods; the agent only uses one; the type narrows
to one; the fake only implements one. **The smaller the contract, the
cheaper the fake.**

If `MonitoringAgent` reached for `new Anthropic(...)` inside its own
constructor instead of taking one as a parameter, every test would
need `vi.mock('@anthropic-ai/sdk', ...)` at module scope. Look at the
integration tests for that exact dance — `test/api/_helpers.ts:68-84`
— it works, but it costs a module-level mock with a real class shim
because Anthropic is `new`-d up. The unit tests don't pay that cost
because the agent itself is injectable.

#### Step 2 — build the fake as a scripted queue

The fake is plain TypeScript. No mocking library required for the
shape; vitest's `vi.fn` is used only so the test can assert call counts.

```ts
// test/agents/base.test.ts:16-56 (annotated)
function buildFakeAnthropic(responses: FakeResponse[]) {
  let idx = 0;                                        // ← next index to serve
  let count = 0;                                      // ← total calls observed

  const create = vi.fn(async () => {
    count++;
    const resp = responses[idx];
    if (!resp) throw new Error(                       // ← LOUD failure if
      `No scripted response at index ${idx}`);          //    the loop reads
    idx++;                                            //    past the script
    return {                                          // ← build a full
      id: `msg_${idx}`,                                 //    Anthropic message
      type: 'message' as const,                         //    shape by hand —
      role: 'assistant' as const,                       //    SDK type guards
      model: AGENT_MODEL,                               //    won't accept a
      /* ... usage fields ... */                        //    half-object
      content: resp.content,                          // ← THE SCRIPT
      stop_reason: resp.stop_reason,                  // ← THE SCRIPT
    } as unknown as Anthropic.Messages.Message;
  });

  return { anthropic: { messages: { create } }, callCount: () => count };
}
```

**Why "throw if out of script" is load-bearing.** A silent `undefined`
return would make the loop hang or fail in a different place. The
explicit throw turns "the loop made one more call than I expected" into
a localized, readable failure. This is the cheapest correctness gate
the fake gets.

#### Step 3 — fake the content blocks too

The `content` array in each response holds either `text` blocks or
`tool_use` blocks (or both). The test builds them with helpers:

```ts
// test/agents/base.test.ts:58-70
function toolUseBlock(id, name, input) {
  return { type: 'tool_use', id, name, input,
           caller: { type: 'direct' } } as unknown as Anthropic.Messages.ContentBlock;
}
function textBlock(text) {
  return { type: 'text', text, citations: null } as unknown as Anthropic.Messages.ContentBlock;
}
```

A `tool_use` block in a scripted response makes the loop dispatch
`dataSource.callTool(name, input)`. A `text` block with
`stop_reason: 'end_turn'` makes the loop return its final text. The
test gets to script the model's mind one turn at a time.

#### Step 4 — fake the dataSource side, too

Same trick on the other seam:

```ts
// test/agents/base.test.ts:76-83
function buildFakeMcp(impl) {
  return {
    async callTool(name, args) {
      const result = await impl(name, args);
      return { result, durationMs: 1, fromCache: false };
    },
  };
}
```

Note the return shape: `{ result, durationMs, fromCache }` — the
production envelope from `McpClient.callTool`. The agent reads `result`;
the duration and cache flag are observable but optional. The fake fakes
**the envelope**, not the network.

#### Step 5 — write the test as a sequence of (script, assert)

The control-flow tests in `base.test.ts` follow a tight shape:

```ts
// test/agents/base.test.ts:105-147 (the canonical happy-path test)
it('executes a tool then returns final text', async () => {
  // 1. SCRIPT
  const { anthropic, callCount } = buildFakeAnthropic([
    { content: [toolUseBlock('tu1', 'get_project_overview', {...})],
      stop_reason: 'tool_use' },                        // turn 1: ask for tool
    { content: [textBlock('done: 5 customers')],
      stop_reason: 'end_turn' },                        // turn 2: done
  ]);
  const mcp = buildFakeMcp(async () => ({
    isError: false, content: [],
    structuredContent: { data: { total_customers: 5 } },
  }));

  // 2. RUN
  const result = await runAgentLoop({
    anthropic, dataSource: mcp,
    agent: 'monitoring', system: 'You are a monitoring agent.',
    userPrompt: 'Check the project.',
    toolSchemas: fakeToolSchemas,
    onToolCall: vi.fn(),
  });

  // 3. ASSERT — every observable: final text, tool calls, hooks, turn count
  expect(result.finalText).toContain('done');
  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls[0].toolName).toBe('get_project_overview');
  expect(callCount()).toBe(2);
});
```

The script names the test's hypothesis. The asserts pin every observable
the agent loop produces. No hidden state, no time dependency, no
network — the test would pass identically on a plane.

```
  the eight base.test.ts cases — what each scripted shape proves

  it# scripted shape                          what it pins
  ─── ─────────────────────────────────────   ───────────────────────────
  1   [tool_use] [text end_turn]              happy path: dispatch then text
  2   [text end_turn]                         no-tools path: return turn 1
  3   [tool_use → mcp throws] [text]          error recovery: record + go on
  4   [tool_use] [tool_use] (maxTurns: 2)     budget: stop, return ""
  5   [tool_use] [text] (maxToolCalls: 1)     forced synthesis: omit tools
                                              on turn 2
  6   [text+tool_use] [text]                  onText fires per turn-with-text
  7   [tool_use] [text]                       onToolResult fires after exec
  8   [tool_use] [text] (synthesisInstruction) instruction appended ONLY on
                                              the forced-final turn
```

Eight `it()`. Eight scripts. The control flow of the entire agent loop
is pinned by which scripts produce which observables. **Strip this
pattern out and you lose every agent-loop test** — and with them, the
proof that the loop's budget enforcement, error recovery, and forced
synthesis behave correctly under any script.

### Move 2 variant — the load-bearing skeleton

The kernel of this pattern is three things. Drop any of them and it
isn't the pattern anymore.

```
  THE KERNEL — three parts, what breaks if missing

  1. INJECTABLE AGENT
     constructor takes anthropic + dataSource as params
     → without this, every test needs vi.mock('@anthropic-ai/sdk', ...)
       at module scope (the cost the integration tests already pay)

  2. SCRIPTED QUEUE WITH LOUD EXHAUSTION
     responses[idx++] with a throw on idx >= responses.length
     → without the throw, a "the loop made one more call than I
       expected" bug shows up as undefined.content.flatMap and the
       failure surfaces 30 lines from its actual cause

  3. NARROW SEAM (McpCaller = Pick<DataSource, 'callTool'>)
     the fake implements ONE method, not the whole interface
     → without the narrowing, the fake has to stub list_tools,
       dispose, bootstrap, etc. — every fake gets heavier every
       time you add a method to DataSource
```

Skeleton = these three. Optional hardening on top: `vi.fn()` for call
counts, helper builders for `tool_use` / `text` blocks, the
`buildFakeMcp` envelope wrapper. Useful, not load-bearing.

The interview-payoff move is naming the **loud exhaustion** rule. Most
people remember the inject-and-script half; far fewer call out that the
queue has to throw on overflow. It's the part that turns one kind of
bug (off-by-one in test setup) into a localized failure instead of a
mystery.

### Move 3 — the principle

**Test against the interface, not the wire.** When you own the
interface (your own `McpCaller` type), the fake is plain TypeScript.
When you don't own the interface (Anthropic's SDK), satisfy its
*shape* in-process — never reach for HTTP-level mocking unless the wire
itself is what you're testing.

The cost: the fake is a parallel implementation of the SDK's contract.
If the SDK evolves, the fake drifts. The benefit: every test runs in
milliseconds against a deterministic surface, and the failure modes
you script are the failure modes you understand.

## Primary diagram — the whole pattern in one frame

```
  THE SCRIPTED ANTHROPIC HARNESS — one frame

  ┌─ TEST FILE ────────────────────────────────────────────────────┐
  │                                                                  │
  │   const { anthropic, callCount } = buildFakeAnthropic([          │
  │     { content: [toolUseBlock(...)],  stop_reason: 'tool_use' }, │
  │     { content: [textBlock('done')],  stop_reason: 'end_turn' },  │
  │   ]);                                                            │
  │                          │  injected ↓                           │
  └──────────────────────────┼───────────────────────────────────────┘
                             │
  ┌─ AGENT LOOP (lib/agents/base-legacy.ts) ─────────────────────────┐
  │                          ▼                                        │
  │   runAgentLoop({                                                  │
  │     anthropic,           ← fake provider                          │
  │     dataSource: fakeMcp, ← fake McpCaller                         │
  │     toolSchemas, ...                                              │
  │   })                                                              │
  │   ─────────────────────────────                                   │
  │   turn 1: anthropic.messages.create()  → fake serves responses[0]│
  │           sees tool_use → dataSource.callTool(...)               │
  │           fake mcp returns { result, durationMs, fromCache }     │
  │   turn 2: anthropic.messages.create()  → fake serves responses[1]│
  │           sees text + end_turn → return finalText                 │
  └──────────────────────────┬───────────────────────────────────────┘
                             │  result + observables
  ┌─ TEST ASSERTS ◄──────────┘                                       ┐
  │   expect(result.finalText).toContain('done')                     │
  │   expect(result.toolCalls).toHaveLength(1)                       │
  │   expect(callCount()).toBe(2)                                    │
  └──────────────────────────────────────────────────────────────────┘

  No network reached. No SDK internals exercised. Test owns every
  bit of input; agent loop's control flow is the only thing under test.
```

## Elaborate

This pattern is older than it looks. It's the **test double** discipline
(Meszaros, *xUnit Test Patterns*, 2007) applied to LLM SDKs. The shape
is the same as faking a database connection, a payment gateway, or any
other slow / costly / non-deterministic external resource — what's
new here is only **what** is being faked.

The closest analog in the React world is faking `fetch` in a custom
hook test: you don't `nock` the network, you replace the function the
hook calls. Same idea here: replace the SDK call site, not the wire.

What makes the LLM case different from a payment-gateway fake:

  → **Multi-turn.** The fake has to play across N round trips, not
    just answer one question. The queue shape solves that.
  → **Branching control flow.** The model's `stop_reason` and
    `content` array shape decide what the loop does next. A script
    that emits `tool_use` versus `end_turn` versus a mix of text +
    tool_use is exercising different code paths in the loop.
  → **Token / turn budgets.** The loop has caps (`maxTurns`,
    `maxToolCalls`) that change behavior. Test 4 and test 5 in
    `base.test.ts` pin those caps by scripting more turns than the
    cap allows and asserting the loop stops.

The next-up reading on this pattern: **contract tests** — running the
same script against the fake AND the real SDK in CI to detect when
the SDK's response shape evolves out from under you. Not in this repo
today; named here as the move that would harden the fake against SDK
drift.

## Interview defense

**Q: "Why fake the SDK in-process instead of mocking HTTP at the
network layer?"**

The seam is the interface, not the wire. The agent loop calls
`anthropic.messages.create(...)` and reads back `{ content, stop_reason,
usage }`. Mocking at HTTP means I'd have to fake the SDK's
serialization, its retry behavior, its error coercion — code I don't
own and shouldn't pin. Faking at the interface means I script the
exact shape the agent reads, which is a tiny surface I do own
(`Anthropic.Messages.Message`). It also runs at memory speed instead
of network speed.

The diagram I'd draw: the SDK seam with `TEST decides → fake →
agent loop` on one side and `(would have called) → anthropic.com` on
the other, and a circle around the SDK boundary showing where the fake
lives.

*anchor:* `test/agents/base.test.ts:16-56` for the fake; `lib/agents/monitoring.ts:73-80` for the injectable agent.

**Q: "What's the load-bearing part everyone forgets?"**

The queue throws when it's exhausted. If the loop makes one more call
than the script expected, you don't want a silent `undefined` flowing
into `response.content.flatMap` — you want a screaming "no scripted
response at index N" that points at the exact off-by-one. Same idea
as a BFS's empty-frontier termination: it's the cheapest correctness
gate the kernel gets, and it's the part that turns "test failed for
unclear reasons" into "test failed because turn 3 wasn't scripted."

*anchor:* `test/agents/base.test.ts:25-27` — the throw is one line, and
it's the one line that turns a confusing failure into a localized one.

**Q: "What's the cost of this pattern?"**

The fake is a parallel implementation of the SDK's response shape, by
hand, with `as unknown as Anthropic.Messages.Message` to satisfy the
type. When the SDK's response type evolves, the fake drifts and tests
break in a way that LOOKS like real failures. The mitigation in this
repo is two helpers (`textBlock`, `toolUseBlock` in `base.test.ts:58-70`)
that centralize the shape — when Anthropic adds a field, you fix one
file, not eight. The further-out mitigation (not done here) is contract
tests that run the same script against the fake and the real SDK to
catch drift in CI.

## See also

  → `02-fixture-driven-schema-parser-tests.md` — the same "fake at the
    interface, not the wire" discipline applied to the MCP envelope.
  → `04-acceptance-with-per-gate-rejection.md` — what the loop's
    parsed output is checked against after the harness runs.
  → `audit.md` lens 2 — where this pattern lives in the bigger
    pyramid; lens 3 — why the agent's testability is itself a design
    signal.
