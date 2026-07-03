# 01 — Scripted Anthropic Fake

**Industry name:** *scripted test double* over the LLM SDK boundary
(a.k.a. *response queue fake*).
**Type:** Language-agnostic pattern applied to a specific SDK.
**Determinism side:** DETERMINISTIC — the fake replaces the
probabilistic core with a scripted queue, so `test/agents/*.test.ts`
becomes a pure input/output assertion suite. This is the load-bearing
seam that makes the entire agent unit-test layer possible.

═════════════════════════════════════════════════
Zoom out — where this pattern sits
═════════════════════════════════════════════════

Every agent test file needs to answer the same question: *does
`runAgentLoop` correctly stitch together turns of Anthropic responses
into a final result, and does it correctly hand off tool calls to the
MCP surface between turns?* The seam it swaps is the one place the
system is non-deterministic — the LLM.

```
  Zoom out — the seam this pattern swaps

  ┌─ Agent layer (lib/agents/*) ────────────────────────────┐
  │  runAgentLoop      DiagnosticAgent      RecommendationAgent│
  │        │                 │                       │      │
  │        └──── all call →  anthropic.messages.create       │
  └───────────────────────────┬─────────────────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │  ★ THIS SEAM ★     │  ← we swap it in tests
                    │  Anthropic SDK      │
                    └─────────┬──────────┘
                              │
                     ┌────────▼────────┐
                     │  Anthropic API   │  (real; skipped in test)
                     └─────────────────┘
```

The tests never hit the API — they hand `runAgentLoop` a fake that
looks like the SDK but reads from a scripted queue. The whole 261-test
`npm test` runs offline in sub-seconds.

═════════════════════════════════════════════════
Structure pass — layers · axes · seams
═════════════════════════════════════════════════

**Layers:**
- test code (calls `runAgentLoop(...)` with a fake)
- fake shim (`{ messages: { create } }` — a queue-drained function)
- `runAgentLoop` (production; runs untouched)
- MCP fake (`McpCaller` interface, pattern 02)

**Axis held constant — control:** who decides what happens next in
the agent loop?
- outermost (test): test scripts the sequence
- middle (`runAgentLoop`): the real production loop decides based
  on `stop_reason` and content blocks
- innermost (SDK fake): reads the next scripted response, throws
  on exhaustion

**Seam:** the constructor of `runAgentLoop` — it takes `anthropic`
as a parameter. That's the only injection point; everything above
hangs off it.

═════════════════════════════════════════════════
How it works
═════════════════════════════════════════════════

#### Move 1 — the mental model

You know how in a UI test you can hand a component a scripted
`fetch()` that returns `{ users: [...] }` on the first call and
`{ error: 'boom' }` on the second? Same idea, but the "component"
is `runAgentLoop` and the "fetch" is `anthropic.messages.create`.
The fake is a queue-drained function: each call to `create()`
pops the next scripted `Message` off a `responses[]` array. Two
call sites → two scripted responses.

```
  The scripted-queue kernel

  test setup:      responses = [resp_turn1, resp_turn2]
                       │
                       ▼
  runAgentLoop calls anthropic.messages.create(...)
                       │
                       ▼
       fake pops responses[idx++]  → returns resp_turn1
                       │
              (real loop decides: tool_use → dispatch to MCP fake)
                       │
                       ▼
  runAgentLoop calls anthropic.messages.create(...) again
                       │
                       ▼
       fake pops responses[idx++]  → returns resp_turn2
                       │
                       ▼
       end_turn        → loop returns final result
```

The kernel has three parts. Drop any one and it breaks:

- **the queue** — indexed by call count; without it the fake would
  always return the same response and multi-turn tests couldn't work
- **the throw-on-exhaustion** — `if (!resp) throw new Error(...)`;
  without it, the fake returns `undefined` and the test fails 10
  lines later with a cryptic error about `stop_reason` being
  `undefined`. The throw fails at the *scripting* mistake, not the
  downstream consequence
- **the `caller: { type: 'direct' }` field on `tool_use` blocks** —
  the SDK's TypeScript shape requires it; forgetting it makes
  `content` fail a compile check inside `runAgentLoop`

#### Move 2 — the walkthrough

**Building the fake — the factory.**

The factory `buildFakeAnthropic(responses)` returns an object shaped
like `{ messages: { create } }`. That's the entire SDK surface the
agents touch — no `client.completions`, no `client.beta`, nothing
else. Because the SDK is opaque to the tests, the fake is tiny.

```
  Location: test/agents/base.test.ts:16-56

  function buildFakeAnthropic(responses: FakeResponse[]) {
    let idx = 0;
    let count = 0;

    const create = vi.fn(async () => {          // ← queue-drained
      count++;                                    //   fn (per call)
      const resp = responses[idx];
      if (!resp) throw new Error(                 // ← fail loud on
        `No scripted response at index ${idx}`    //   mismatch, don't
      );                                          //   silently return
      idx++;                                      //   undefined
      return {
        id: `msg_${idx}`,
        type: 'message',
        role: 'assistant',
        model: AGENT_MODEL,
        content: resp.content,                    // ← only these two
        stop_reason: resp.stop_reason,            //   fields matter
        usage: { input_tokens: 10, ... }
      };
    });

    return { anthropic: { messages: { create } }, callCount };
  }
```

The `usage` field is real-shaped (matches the SDK's `Usage` type)
because `runAgentLoop` logs it — but it's cosmetic. The two fields
that drive the loop are `content` (the array of content blocks) and
`stop_reason` (`'tool_use' | 'end_turn' | 'max_tokens' | ...`).

**Content-block helpers — where the type discipline lives.**

Two 4-line helpers make the assertions readable and the types happy:

```
  Location: test/agents/base.test.ts:58-70

  function toolUseBlock(id, name, input) {
    return {
      type: 'tool_use', id, name, input,
      caller: { type: 'direct' }             // ← SDK requires this
    } as unknown as Anthropic.Messages.ContentBlock;
  }

  function textBlock(text) {
    return { type: 'text', text, citations: null }
      as unknown as Anthropic.Messages.ContentBlock;
  }
```

The double-cast (`as unknown as`) is deliberate. The SDK's
`ContentBlock` union has 8+ shapes with private fields (`_type`,
`caller`), and we don't want to hand-roll the entire discriminated
union each time. The double-cast says "trust me, this is the shape."
Tests that break the shape fail at runtime with an actionable
`stop_reason: undefined` error, not a cryptic type error.

**Consumer side — how a test drives it.**

The consumer pattern is: script exactly the turns you want, wire the
fake into the loop, assert on both the loop's return value AND the
`callCount`.

```
  Location: test/agents/base.test.ts:105-147

  it('executes a tool then returns final text', async () => {
    const { anthropic, callCount } = buildFakeAnthropic([
      // Turn 1: model requests a tool
      { content: [toolUseBlock('tu1', 'get_project_overview',
                                { project_id: 'p' })],
        stop_reason: 'tool_use' },
      // Turn 2: model returns final text
      { content: [textBlock('done: 5 customers')],
        stop_reason: 'end_turn' },
    ]);

    const mcp = buildFakeMcp(async () => ({           // ← pattern 02
      isError: false, content: [],
      structuredContent: { data: { total_customers: 5 } }
    }));

    const result = await runAgentLoop({
      anthropic: anthropic as unknown as Anthropic,   // ← seam swap
      dataSource: mcp,
      agent: 'monitoring',
      system: 'You are a monitoring agent.',
      userPrompt: 'Check the project.',
      toolSchemas: fakeToolSchemas,
      onToolCall: vi.fn(),
    });

    expect(result.finalText).toContain('done');
    expect(result.toolCalls).toHaveLength(1);
    expect(callCount()).toBe(2);                       // ← both turns fired
  });
```

The `callCount()` assertion is important. Without it, a test that
scripts 3 turns but the loop only runs 2 would still pass — the
assertions on `finalText` would look reasonable, but a real
regression (loop bailed early) would slip through. Asserting `callCount`
pins the exact turn count.

**Load-bearing details every consumer of this pattern gets right:**

- `stop_reason: 'tool_use'` on the tool-call turn (not `'end_turn'`) —
  otherwise `runAgentLoop` would exit immediately without dispatching
- `stop_reason: 'end_turn'` on the final text turn — otherwise the
  loop would try another turn and pop `undefined` from an empty queue
- Sequence of turns MATCHES the queue index — if a test scripts
  [tool_use, tool_use, end_turn] but the model only fires 2 tool
  calls, the last scripted response is never consumed and `callCount`
  reveals the drift

#### Move 2 variant — the load-bearing skeleton

Kernel: **queue + index + throw-on-exhaustion.**

- Drop the queue → single response can't script multi-turn.
- Drop the index → each call returns responses[0] forever; multi-turn tests break.
- Drop the throw → mismatched scripts fail cryptically 20 lines later.

Hardening on top: `callCount()` accessor (for the pin assertion),
`usage` field (cosmetic), `vi.fn()` wrapping (so tests can also read
`.mock.calls[i][0]` to assert on the *outgoing* request shape — see
`base.test.ts:277-281`, which asserts that the second turn omits
`tools` after the budget is spent).

#### Move 3 — the principle

When a system depends on a non-deterministic external service, make
the seam constructor-injectable and put a scripted fake behind it.
The fake becomes the entire correctness surface for the layer above;
the real service is only exercised by a separate, cost-aware,
non-deterministic harness. This split is what lets you test agent
loops in sub-milliseconds and eval them at ~$0.15/case — the same
production code runs against both.

═════════════════════════════════════════════════
Primary diagram
═════════════════════════════════════════════════

The recap: three actors, one seam, two suites.

```
  Full picture — the seam and both suites

  ┌─ npm test  (test/agents/*.test.ts) ─────────────────────────┐
  │                                                             │
  │  test writes:            uses:                              │
  │  responses = [           runAgentLoop({                     │
  │    { content: [toolUse],   anthropic: FAKE  ────┐           │
  │      stop_reason: '...' }, dataSource: FAKE ─┐  │           │
  │    { content: [text],      toolSchemas: ...  │  │           │
  │      stop_reason: '...' }, onToolCall: vi.fn() │           │
  │  ]                       })                  │  │           │
  │                                              │  │           │
  │  asserts:                                    │  │           │
  │  · finalText / toolCalls[i]                  ▼  ▼           │
  │  · callCount() === scripted length      ┌────────────┐      │
  │  · onToolCall fired N times             │ real       │      │
  │                                         │ runAgentLoop│     │
  │                                         │ + real      │      │
  │                                         │ McpClient   │      │
  │                                         └────────────┘      │
  └─────────────────────────────────────────────────────────────┘
                                                    │
                                                    │  same code
                                                    ▼
  ┌─ npm run eval  (eval/run.eval.ts) ──────────────────────────┐
  │                                                             │
  │  runAgentLoop({                                             │
  │    anthropic: REAL Anthropic client,                        │
  │    dataSource: SyntheticDataSource,                         │
  │    ...                                                       │
  │  })                                                          │
  │  → judged by RubricJudge → verdict stays out of npm test    │
  │  → cross-link to study-ai-engineering                       │
  └─────────────────────────────────────────────────────────────┘
```

═════════════════════════════════════════════════
Elaborate
═════════════════════════════════════════════════

The pattern's ancestor is **fake HTTP servers for API clients** —
you don't run the real API in tests, you hand your client a shim
that returns pre-baked responses. The Anthropic version adds one
twist: the responses aren't just body shapes, they're *sequences* —
because agent loops make multiple calls per test. That's why the
queue matters.

The style is copy-pasted (deliberately) across three test files:
`test/agents/base.test.ts`, `monitoring.test.ts`, `diagnostic.test.ts`,
`recommendation.test.ts`, `query.test.ts`. The
`buildFakeAnthropic()` helper is duplicated in each. A shared
`test/helpers/anthropic-fake.ts` would DRY it up, but the current
duplication is intentional — each file's fake tweaks the fields
that matter for its assertions (some read `.mock.calls`, some don't;
some need the `usage` field asserted on, some don't). The Session B/D
additions (`auth-providers.test.ts`, `config.test.ts`) don't use
this pattern because they don't cross the Anthropic seam — they test
pure functions.

The integration-test version (`test/api/_helpers.ts:mockAnthropicModule`)
takes the same pattern and pushes it up one level: instead of
constructing the fake in the test, it stubs the entire module at
load time (`vi.mock('@anthropic-ai/sdk', ...)`), so the route's
`new Anthropic(...)` inside its handler picks up the fake
transparently. Same queue, wrapped in a class.

Cross-link: `study-ai-engineering` covers the other half of the seam
(the eval harness that runs against real Anthropic + judges the
output). That side asks "did the model do a good job?" This side
asks "did our code correctly handle whatever the model returned?"

═════════════════════════════════════════════════
Interview defense
═════════════════════════════════════════════════

**Q: How do you unit-test code that calls an LLM?**

Answer: You make the LLM SDK constructor-injectable, then hand your
code a scripted fake — an object shaped like the SDK but drained
from a queue of pre-baked responses. Multi-turn agent loops need
sequenced responses, so the queue advances on each `create()` call.
The fake throws on queue exhaustion so a mis-scripted test fails at
the source of the mistake, not 10 lines later.

Anchor: `test/agents/base.test.ts:16-56` — `buildFakeAnthropic()`
factory. Every agent unit test in this repo consumes it.

Diagram sketch:

```
  test: [resp1, resp2] → fake.create() pops → real runAgentLoop
                                              decides based on
                                              stop_reason + content
```

**Q: What breaks if you don't throw on queue exhaustion?**

Answer: Silent test failures with confusing errors. `runAgentLoop`
reads `resp.content` and `resp.stop_reason`; if `resp` is `undefined`,
it fails 5-10 lines deep in the loop with a TypeError about reading
`stop_reason` of undefined. The user has no idea their script was
wrong. Throwing at the point of exhaustion pins the actual mistake:
"you scripted 2 responses but the loop needs 3."

**Q: Why not use `jest.mock` / `vi.mock` for the whole SDK?**

Answer: Because a hand-rolled fake gives you the per-call queue with
zero magic — you can see the state (`idx`, `count`) and reason about
it. Module-level mocks are the right choice at the *integration*
boundary (the route's `new Anthropic(...)`), where the fake needs to
survive across the module-import boundary — see
`test/api/_helpers.ts:mockAnthropicModule`. At the unit level, the
constructor-injection version is more transparent.

═════════════════════════════════════════════════
See also
═════════════════════════════════════════════════

- `02-scripted-mcp-caller-fake.md` — the sibling fake for the MCP
  boundary; the two are always used together
- `03-http-transport-mock-with-module-hoisting.md` — the same
  pattern at the module level (integration tests)
- `audit.md` lens 6 — how this pattern shipped the AI-feature seam
  end-to-end
- `study-ai-engineering` — the probabilistic half of the seam
  (real Anthropic + judge)
