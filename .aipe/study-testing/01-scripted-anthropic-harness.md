# 01 — Scripted-Anthropic harness

**Industry name:** Scripted external / deterministic harness around a probabilistic core. **Type:** Industry standard for AI products.

## Zoom out, then zoom in

Every AI feature in blooming insights — diagnosis, recommendation, monitoring scan, query answer, intent classification — runs Claude in a multi-turn loop with tool use. The model's output is non-deterministic. To test the *agent code that wraps* the model, you build a fake `messages.create` that returns a *queued* list of pre-written responses and inject it as the SDK. The real agent code runs end-to-end against the script; the test author controls every turn.

The pattern is shared across the agent test suite: `buildFakeAnthropic` is the harness builder, and five agent test files build directly on it — `base.test.ts` (8 tests), `monitoring.test.ts` (10), `diagnostic.test.ts` (5), `recommendation.test.ts` (5), `query.test.ts` (3). **31 tests total** depend on this harness shape. (`synthesis-instruction.test.ts` and `tool-schemas.test.ts` test sibling concerns and don't take the harness; `intent.test.ts` and `categories.test.ts` mock the SDK at a different layer.)

```
Zoom out — where this pattern sits in the system

  ┌─ UI layer (components/, app/*/page.tsx) ─────────────────┐
  │  Investigation buttons, ReasoningTrace, FeedGrid          │
  └─────────────────────────────────────────────────────────┘
                                ▲ stream
  ┌─ HTTP route ────────────────┴────────────────────────────┐
  │  app/api/agent/route.ts  →  NDJSON stream                 │
  └─────────────────────────────────────────────────────────┘
                                ▲ calls
  ┌─ ★ AGENT LAYER (where this pattern lives) ★ ────────────┐
  │  lib/agents/{base,diagnostic,recommendation,monitoring,  │
  │              query}.ts                                    │
  │                                                           │ ← we are here
  │  Tested via: scripted Anthropic + fake DataSource         │
  │  31 tests across 5 files                                   │
  └─────────────────────────────────────────────────────────┘
                                ▲ tool calls
  ┌─ External (faked at the SDK seam) ──────────────────────┐
  │  Anthropic Messages API   ←   FAKED in tests             │
  │  Bloomreach MCP            ←   FAKED in tests             │
  └─────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern's kernel is a **response queue plus an index that advances per call**, wrapped behind a `vi.fn()` so the test can assert on what was *sent* to the model as well as what came back.

## Structure pass

**Layers:** the test → the scripted SDK fake → the real agent code → the scripted MCP fake. **Axis traced:** *what's real, what's faked?* **The seams where the answer flips:**

```
The axis "is this code real or faked?" — across the test stack

  axis traced = "does this run the production code path?"

  ┌─ FAKE: Anthropic SDK ────────────────────┐
  │  messages.create = vi.fn(...)             │  faked at the SDK
  │  pulls next response from a queue          │  boundary (one seam)
  └──────────────────┬───────────────────────┘
                     │  flip 1: from here down
                     │  it's all real
                     ▼
  ┌─ ★ REAL: DiagnosticAgent.investigate ★ ──┐
  │  builds system prompt                     │  REAL — agent class
  │  calls runAgentLoop                        │  REAL — loop function
  │  multi-turn for-loop                       │  REAL — control flow
  │  extracts text + tool_use blocks           │  REAL — block walker
  │  accumulates messages with tool_result    │  REAL — history mgr
  │  enforces maxTurns + maxToolCalls         │  REAL — budgets
  │  parses output via parseAgentJson          │  REAL — parser
  │  validates via isDiagnosis                 │  REAL — type guard
  │  on failure, runs synthesize() fallback   │  REAL — fallback path
  └──────────────────┬───────────────────────┘
                     │  flip 2: at the MCP
                     │  call boundary
                     ▼
  ┌─ FAKE: McpCaller (one method, 5 lines) ──┐
  │  async callTool(name, args) {             │  faked at the
  │    return { result: …, durationMs: 1,     │  McpCaller interface
  │             fromCache: false };           │  (a second seam)
  │  }                                         │
  └──────────────────────────────────────────┘
```

Two seams, one real middle. The pattern works because the agent loop's control flow is *deterministic given* the model's outputs. Make the outputs deterministic by scripting them, and every branch becomes assertable.

## How it works

### Move 1 — the mental model

You queue a list of pre-written responses, hand a function that pops the next one off the queue to the agent (disguised as the SDK), and run the real agent code. The agent thinks it's talking to a model; the test author chose every word the "model" said.

```
The scripted-Anthropic kernel — queue + index + real loop

  ┌─ test sets up the script ───────────────────────────────┐
  │  responses = [                                           │
  │    { content: [toolUseBlock('execute_eql', {…})],        │ ← turn 1: tool call
  │      stop_reason: 'tool_use' },                          │
  │    { content: [textBlock('```json\n{…}\n```')],          │ ← turn 2: final JSON
  │      stop_reason: 'end_turn' },                          │
  │  ];                                                       │
  └──────────────────────────────────────────────────────────┘
                            │
                            ▼ injected as anthropic
  ┌─ REAL agent loop runs ──────────────────────────────────┐
  │  for turn in 0..maxTurns:                                │
  │     res = await anthropic.messages.create(...)           │ ← pulls next entry
  │     if no tool_use blocks in res.content:                │
  │        return finalText                                  │
  │     for each tool_use block:                             │
  │        result = await mcp.callTool(name, args)           │ ← faked too
  │        messages.push(tool_result)                        │
  └──────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌─ test asserts on real behaviour ────────────────────────┐
  │  expect(result.toolCalls).toHaveLength(1)                 │
  │  expect(result.finalText).toContain('done')               │
  │  expect(create.mock.calls[1][0].system).toContain('JSON') │ ← assertion on
  └──────────────────────────────────────────────────────────┘    what was sent
```

### Move 2 — the walkthrough

#### The response queue + index (part 1 of the kernel)

The fake `messages.create` must return a *different* response each call. A static return value can only test one-turn flows. The pattern: close over a list and an index; advance the index per call.

```
The queue mechanic — what makes multi-turn testable

  responses[0]  ──┐
  responses[1]    │
  responses[2]    │  ←─── idx = 0, ++ on each create() call
  responses[3]    │       (response queue stays in closure)
  responses[N]  ──┘

  pseudocode:
    let idx = 0
    create = async () => {
      const resp = responses[idx]
      idx = idx + 1
      return resp
    }
```

Drop this and you have a single-shot fake. You can test "what does the agent do on one turn with this response," but not "what does the agent do across turns when the model first calls a tool, then returns prose."

#### The shape-faithful response (part 2 of the kernel)

The fake must match the Anthropic SDK's response shape closely enough that the agent's real code doesn't crash on a missing field. The agent reads `content[]`, `stop_reason`, and the block-level `type`/`name`/`input`/`text`. The SDK's type system *also* requires `id`, `model`, `role`, `usage`, `container`, etc. — fields the agent doesn't read, but TypeScript and any defensive runtime checks do.

```
The shape contract — every field the SDK promises

  pseudocode:
    fake_response = {
      id:              'msg_test',
      type:            'message',
      role:            'assistant',
      model:           AGENT_MODEL,
      stop_reason:     'tool_use' | 'end_turn',
      stop_sequence:   null,
      usage:           { input_tokens: 1, output_tokens: 1, … },
      container:       null,
      content:         [...the blocks the test cares about...],
    }
```

If the test only sets `content` and `stop_reason`, TypeScript yells. More importantly, any production-side defensive code (`response.usage?.input_tokens ?? 0`) reads a field that doesn't exist on the fake, which can flip a branch silently. Match the shape.

#### Mock-call introspection (part 3 of the kernel)

The fake is a `vi.fn(...)`, not just a plain function. That makes `create.mock.calls` available — a list of `[arguments]` arrays, one per call. Tests use this to assert on what the agent *sent* to the model, not just what came back. The single highest-leverage assertion this enables: did the agent append `synthesisInstruction` to the system prompt only on the forced-final turn?

```
Mock-call introspection — assertion on outbound traffic

  ┌─ the fake is a vi.fn ──────────────────────────────────┐
  │  create = vi.fn(async () => responses[idx++])           │
  └────────────────────┬───────────────────────────────────┘
                       │ every call recorded
                       ▼
  ┌─ test reads the call log ──────────────────────────────┐
  │  calls = anthropic.messages.create.mock.calls           │
  │  calls[0][0].system  ← system prompt sent on turn 1     │
  │  calls[1][0].system  ← system prompt sent on turn 2     │
  │  calls[0][0].tools   ← tools offered on turn 1          │
  │  calls[1][0].tools   ← (should be empty on forced-final)│
  └────────────────────────────────────────────────────────┘
```

Without this, you can only test the agent's *return value*. With it, you can test the agent's *outbound behaviour* — which is where the bug-prone branches actually live.

#### The DataSource fake (the second seam — renamed in Phase 2)

The agent doesn't call the MCP SDK directly. It calls through a `DataSource` interface (`lib/data-source/types.ts`) — three methods, structurally typed. A test satisfies it with a 5-line object literal. No `implements` keyword required; TypeScript accepts the shape match. *(Historical note: v1 of this guide called the interface `McpCaller`. The Phase 2 swap renamed it to `DataSource` when a second implementation was added. Mechanics unchanged; same shape match, same five-line fake works. The second implementation today is `SyntheticDataSource`; the brief stint with `OlistDataSource` is gone with the Olist removal.)*

```
The McpCaller seam — interface is the contract

  pseudocode:
    interface McpCaller {
      callTool(name, args, opts?) -> { result, durationMs, fromCache }
    }

    fake_mcp = {
      async callTool(name, args) {
        const result = await impl(name, args)        // scripted per call
        return { result: result, durationMs: 1, fromCache: false }
      }
    }
```

The compression matters: the real `BloomreachDataSource` (formerly `McpClient`, now living at `lib/data-source/bloomreach-data-source.ts`) does retries, caching, rate-limit parsing, error tagging — fifty lines of behaviour. The interface narrows it to one method. The test gets to ignore all the production-side complexity and focus on what the agent *does* with the result. That's the seam.

The seam still pays off post-Olist-removal: two production implementations (`BloomreachDataSource` for live, `SyntheticDataSource` for the in-process demo/test path) AND a test convention where every agent test passes a hand-rolled five-line fake. One interface, multiple consumers; the `DataSource` extraction is the load-bearing refactor that keeps the agent layer testable without touching its production code path.

### Move 2 variant — the load-bearing skeleton

Drop any one of these three and the pattern collapses:

1. **A response queue + advancing index.** Drop this and you can only test single-turn flows. The agent's multi-turn behaviour — message accumulation, tool-then-text, forced-final on budget exhaustion — becomes untestable.

2. **A shape-faithful response object.** Drop this and TypeScript rejects the fake at compile time, or the agent's defensive reads (`response.usage?…`) silently see `undefined` and flip branches.

3. **A vi.fn wrapper + mock.calls inspection.** Drop this and you can assert on what came back from the fake, but not on what was sent to it. The "did `synthesisInstruction` get appended on the forced-final turn?" assertion becomes impossible, and that's the single most bug-prone branch in the loop.

Skeleton = queue + shape + mock.calls. Optional hardening: helper functions for `toolUseBlock(id, name, input)` and `textBlock(text)` (so the queue stays readable), a `callCount()` accessor exposed from the closure (convenience, not necessity).

### Code in this codebase

**Use case A — proving the agent loop's branches end-to-end.** `test/agents/base.test.ts` has 8 tests, each exercising one branch of `runAgentLoop` (tool-then-text, text-only, tool-throws, maxTurns hit, maxToolCalls hit, onText surfacing, synthesisInstruction on forced-final turn). The load-bearing one is the `synthesisInstruction` test on lines 361–383 — it's the bug-prone branch and the test uses `create.mock.calls[0][0].system` vs `calls[1][0].system` to inspect the actual prompts sent.

```
test/agents/base.test.ts  (lines 16–48 — the harness builder)

  function buildFakeAnthropic(responses: FakeResponse[]): {
    anthropic: { messages: { create: ReturnType<typeof vi.fn> } };
    callCount: () => number;
  } {
    let idx = 0;                                  ← queue index in closure
    const create = vi.fn(async () => {            ← vi.fn → mock.calls available
      const resp = responses[idx];
      idx = idx + 1;                              ← advance per call
      return {
        id: 'msg_test',                           ← shape-faithful: fields the
        type: 'message',                           ← SDK type requires even
        role: 'assistant',                         ← though the agent doesn't
        model: AGENT_MODEL,                        ← read them
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, … },
        container: null,
        content: resp.content,
        stop_reason: resp.stop_reason,
      };
    });
    return { anthropic: { messages: { create } }, callCount: () => idx };
  }
       │
       └─ five lines of mechanics, three lines of shape padding. The shape
          padding is load-bearing: drop the `usage` field and any defensive
          read in production-side code reads undefined and silently flips
          a branch.

test/agents/base.test.ts  (lines 361–383 — the load-bearing test)

  it('appends synthesisInstruction to the system prompt only on the forced-final turn', async () => {
    const { anthropic } = buildFakeAnthropic([
      { content: [toolUseBlock('tu8', 'get_project_overview', { project_id: 'z' })],
        stop_reason: 'tool_use' },                ← turn 1: tool call
      { content: [textBlock('final')],
        stop_reason: 'end_turn' },                ← turn 2: forced-final
    ]);
    const mcp = buildFakeMcp(async () => ({ ok: true }));

    await runAgentLoop({
      anthropic: anthropic as unknown as Anthropic,
      mcp, agent: 'diagnostic', system: 'BASE SYSTEM',
      userPrompt: 'go', toolSchemas: fakeToolSchemas,
      maxToolCalls: 1, maxTurns: 8,
      synthesisInstruction: 'OUTPUT JSON NOW',
    });

    const calls = (anthropic as ...).messages.create.mock.calls;
    expect(calls[0][0].system).toBe('BASE SYSTEM');           ← unmodified on turn 1
    expect(calls[1][0].system).toContain('OUTPUT JSON NOW');  ← augmented on turn 2
       │
       └─ this assertion only works because create is a vi.fn. The "appended
          on the forced-final turn" branch is the one a refactor is most
          likely to break silently; this test is the load-bearing guard
          against burning tokens on every turn.
  });
```

**Use case B — covering all four agents with one pattern.** The same harness builder appears at the top of `base.test.ts` (8 tests on `runAgentLoop`), `diagnostic.test.ts` (5 tests on `DiagnosticAgent.investigate` including the synthesis fallback), `monitoring.test.ts` (10 tests on `MonitoringAgent.scan`), `recommendation.test.ts` (5 tests on `RecommendationAgent.propose`), and `query.test.ts` (3 tests on `QueryAgent.answer`). **31 tests total** depend on this pattern. Strip the harness and the agent layer has zero deterministic coverage.

```
test/agents/diagnostic.test.ts  (lines 273–291 — the synthesis fallback)

  it('synthesizes a diagnosis from gathered evidence when the loop output is unusable', async () => {
    const { anthropic } = buildFakeAnthropic([
      // Investigation loop ends with rambling prose (no valid JSON)
      { content: [textBlock('Let me keep investigating — more queries first.')],
        stop_reason: 'end_turn' },                ← turn 1: unusable text
      // The dedicated tool-less synthesis call returns a valid diagnosis
      { content: [textBlock('```json\n' + VALID_DIAGNOSIS_JSON + '\n```')],
        stop_reason: 'end_turn' },                ← turn 2: synthesis call
    ]);

    const agent = new DiagnosticAgent(anthropic as unknown as Anthropic,
                                       buildFakeMcp(), FIXTURE_SCHEMA, FAKE_TOOL_DEFS);

    const result = await agent.investigate(SAMPLE_ANOMALY);
    expect(result.conclusion).toContain('payment UI regression');
    expect(result.hypothesesConsidered).toHaveLength(2);
       │
       └─ this proves the WRAPPER's fallback path works when the loop output
          is unusable. What it does NOT prove: that the real model's output
          would ever look like the scripted JSON. That's the model-quality
          gap — once filled by the (now-deleted) Phase 3 eval suite; today
          unmeasured in this repo. See `study-ai-engineering/05-evals-and-
          observability/` for the testing discipline that would close it.
  });
```

### Move 3 — the principle

**A probabilistic core is testable when you can substitute it at a known seam.** The Anthropic SDK is the seam; the script is the substitution. The pattern travels to any probabilistic external — payments, geo lookup, third-party AI APIs. The test bench wraps the boundary; the production code runs the real path. What you give up: any signal about the *model's* quality (that's evals, next door). What you get: assertions on every branch of the deterministic glue, fast.

## Primary diagram

The full harness, every part labelled:

```
The scripted-Anthropic harness — full view

  ┌─ FAKE Anthropic SDK ────────────────────────────────────┐
  │                                                         │
  │  function buildFakeAnthropic(responses) {                │
  │    let idx = 0;                                          │
  │    const create = vi.fn(async () => {                    │
  │      const resp = responses[idx];                        │  ← queue + index
  │      idx = idx + 1;                                      │
  │      return {                                            │
  │        id: 'msg_test', type: 'message', role: 'asst',   │
  │        model: AGENT_MODEL, stop_sequence: null,         │  ← shape-faithful
  │        usage: { input_tokens: 1, output_tokens: 1, … }, │
  │        container: null,                                  │
  │        content:     resp.content,                        │
  │        stop_reason: resp.stop_reason,                    │
  │      };                                                  │
  │    });                                                   │
  │    return { messages: { create }, callCount: () => idx } │  ← vi.fn → mock.calls
  │  }                                                       │
  └──────────────────────────┬──────────────────────────────┘
                             │ injected as Anthropic
                             ▼
  ┌─ ★ REAL agent code ★ ──────────────────────────────────┐
  │                                                         │
  │  new DiagnosticAgent(fakeAnthropic, fakeMcp, schema,    │  agent class
  │                       toolDefs)                          │  is real
  │     .investigate(anomaly, { onToolCall, onText, … })    │
  │     │                                                   │
  │     ├─ builds system prompt                              │  real
  │     ├─ calls runAgentLoop                                │  real
  │     │   ├─ for turn in 0..maxTurns                       │  real
  │     │   ├─ pulls next scripted response                  │  via fake
  │     │   ├─ extracts text + tool_use blocks               │  real
  │     │   ├─ calls mcp.callTool per tool_use               │  via fake
  │     │   ├─ appends tool_result to messages               │  real
  │     │   └─ enforces maxTurns + maxToolCalls + forceFinal │  real
  │     ├─ parses output via parseAgentJson                  │  real
  │     ├─ validates via isDiagnosis                         │  real
  │     └─ on failure, runs synthesize() fallback            │  real
  └──────────────────────────┬──────────────────────────────┘
                             │ calls mcp.callTool
                             ▼
  ┌─ FAKE McpCaller ───────────────────────────────────────┐
  │                                                         │
  │  function buildFakeMcp(impl) {                          │
  │    return {                                             │
  │      async callTool(name, args) {                       │
  │        const result = await impl(name, args);          │
  │        return { result, durationMs: 1, fromCache: false }│
  │      }                                                  │
  │    };                                                   │
  │  }                                                      │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

The "scripted external" pattern predates AI products by decades — it's how you test code that talks to anything probabilistic or expensive (real database, real payments processor, real geo API). The AI variant is mechanically identical; the only thing that changed is which boundary you script. OpenAI's `evals` library, Anthropic's `inspect_ai`, and Langfuse all draw the same line: deterministic harness around the AI call, probabilistic eval *of* the AI call, two complementary disciplines.

The `vi.fn() + mock.calls` mechanic is the unsung enabler. Jest's `jest.fn()` does the same job; the introspection that comes for free is what makes the pattern's full power available. Without it, you can only assert on return values — which is half the contract.

Cross-reference: `study-software-design`'s "deep modules are easy to test" finding maps directly here. `runAgentLoop` is a deep module (one entry point, small interface, a lot of behaviour); the harness is small *because* the module is deep.

## Interview defense

**Q: Is this a unit test or an integration test?** Closer to integration. The unit under test is the entire `DiagnosticAgent.investigate` method, which runs a multi-turn loop with real branching, real message-history accumulation, real parser, real type guard, real fallback. The only fakes are at the boundaries: Anthropic at the SDK seam, MCP at the `McpCaller` interface. The middle is real. That's an integration test where the externals are scripted.

```
The fake / real boundary in one diagram

   FAKE                  REAL                              FAKE
  ──────              ────────────────                   ──────
  Anthropic    ─►  DiagnosticAgent.investigate    ─►    McpCaller
  SDK              │                                     interface
   .messages.      │  → builds system prompt
    create         │  → calls runAgentLoop
   (scripted       │     │
    queue +        │     ├─ for turn in maxTurns
    vi.fn)         │     ├─ extracts text/tool blocks
                   │     ├─ accumulates messages         │ ◄─ scripted
                   │     ├─ enforces maxTurns budget     │     tool result
                   │     └─ forceFinal logic              │
                   │  → parses output via parseAgentJson
                   │  → validates via isDiagnosis
                   │  → on failure, runs synthesize()
                   └────────────────────────────────────
```

**Q: What's the load-bearing part most people forget?** The `vi.fn` wrapper. People often write `const create = async () => responses[idx++]` and lose `mock.calls`. The moment you can't inspect what was *sent* to the model, you lose the highest-leverage class of assertion — the prompt-augmentation tests in `base.test.ts` (forceFinal, tool removal on forced-final turn) all depend on reading `create.mock.calls[N][0]`.

**Q: What does this pattern *not* catch?** Anything that's a function of the real model's output. If Anthropic ships a model that emits worse JSON tomorrow — fewer markdown fences, more rambling prose — every test in this file still passes (the script returns what the test author wrote). That's the AI-eval gap. The harness catches *wiring* bugs; it cannot catch *quality* bugs. You need both disciplines; this pattern is one half.

## See also

- `audit.md#testing-ai-features` — the deterministic-vs-eval seam this pattern straddles
- `02-fixture-driven-schema-parser.md` — the fixture-driven unit pattern (Level 2), one rung below this on the pyramid
- `04-acceptance-plus-per-gate-rejection.md` — the type-guard rejection discipline that the harness's `isDiagnosis` validation step depends on
- `05-llm-eval-as-testing.md` — **RETIRED.** Historical record of LLM-as-judge testing discipline; the in-repo eval suite it references was deleted in PR #8
- (external) `.aipe/study-ai-engineering/05-evals-and-observability/` — the model-architecture / rubric-design deep walk; the only place this repo still teaches model-quality measurement

---
