# 02 — Test design and levels

**Industry name:** Test pyramid / test levels. **Type:** Industry standard.

## Zoom out, then zoom in

The pyramid as-built in blooming insights is **wide at the bottom, thin everywhere else.** Almost everything is unit tests; one notable shape — the scripted-Anthropic loop — straddles unit and integration; there are no end-to-end tests of the running app. The pyramid is honest because the lib layer is deep and well-isolated. The thin top is the gap.

```
Zoom out — the pyramid as it actually exists in this repo

  ┌─ end-to-end (real Next dev server, real browser) ────────────┐
  │                       0 tests                                 │
  │  no Playwright, no MCP-recorded fixtures driving the route    │ ← top is empty
  └───────────────────────────────────────────────────────────────┘

  ┌─ integration (real seams, faked externals) ──────────────────┐
  │                       0 dedicated tests                       │
  │  the "scripted Anthropic" tests in test/agents/ partially      │
  │  fill this — they exercise the real agent classes wired to    │ ← middle is
  │  a real `runAgentLoop`, with only the Anthropic SDK + McpCaller│   half-filled
  │  faked. Closer to integration than unit.                       │
  └───────────────────────────────────────────────────────────────┘

  ┌─ ★ unit (single function or class, all deps faked) ★ ─────────┐
  │                       ~140 tests                              │
  │  schema.ts (24), validate.ts (25), client.ts (14), auth.ts    │ ← we are here
  │  (14), categories.ts (12), derive.ts (11), events.ts (7) …    │   the base is wide
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. The interesting design choice is **the scripted-Anthropic pattern.** It's not pure unit (the real agent class is wired to a real loop, with multiple turns and real branching), but it's not integration either (no real HTTP, no real model). It deserves its own treatment because every AI feature in this repo is tested that way.

## Structure pass

**Layers:** unit → integration → e2e. **Axis traced:** *how much of the real system runs in this test?* **The seams where the answer flips:**

```
The axis "how much of the real system runs?" — held constant

  axis traced = "what's faked here?"

  ┌─ pure unit test ──────────────────────┐
  │  parseAgentJson('{"a":1}')           │
  │  isDiagnosis({...})                  │   ALMOST EVERYTHING IS REAL
  │  encodeEvent({type:'done'})          │   one input → one output
  └─────────────────────┬────────────────┘     no IO, no model
                        │  flip 1: the test
                        │  starts spinning a
                        │  multi-turn loop
                        ▼
  ┌─ ★ scripted-Anthropic test ★ ─────────┐
  │  new DiagnosticAgent(fakeAnthropic,   │  REAL: the agent class,
  │    fakeMcp, schema, tools)             │  the runAgentLoop, the
  │  await agent.investigate(anomaly)     │  message-history accumulator,
  │                                        │  the type-guard fallback path,
  │                                        │  the synthesis-call fallback
  │  fakeAnthropic returns scripted text   │  FAKE: Anthropic SDK,
  │  fakeMcp returns scripted tool result  │         McpCaller
  └─────────────────────┬────────────────┘
                        │  flip 2: the test
                        │  would have to spin
                        │  the Next route
                        ▼
  ┌─ integration test (route + lib) ──────┐
  │                NONE                    │  would exercise
  │                                        │  app/api/agent/route.ts
  │                                        │  with a fake Anthropic
  │                                        │  + fake MCP transport
  └─────────────────────┬────────────────┘
                        │  flip 3: would need
                        │  real network +
                        │  real OAuth
                        ▼
  ┌─ end-to-end test ─────────────────────┐
  │                NONE                    │
  └───────────────────────────────────────┘
```

The seam between "unit" and "scripted-Anthropic" is where the test design gets interesting. The seam between "scripted-Anthropic" and "route integration" is where the audit has its strongest finding: a one-step lift from existing patterns would cover the route layer.

## How it works

### Move 1 — the mental model

The scripted-Anthropic pattern is the kernel of this repo's testing design. You build a fake `anthropic.messages.create` that returns a *list* of pre-scripted responses one at a time, then run the real agent against it. The agent thinks it's talking to a real model; the test author controls every response. It's a fixture-driven integration test for non-deterministic code, deliberately collapsed back to determinism.

```
The scripted-Anthropic pattern — the kernel

  ┌─ test sets up the script ─────────────────────────────────┐
  │  responses = [                                            │
  │    { content: [toolUseBlock('execute_analytics_eql',…)]   │  ← turn 1: tool call
  │    , stop_reason: 'tool_use' },                           │
  │    { content: [textBlock('```json\n{...}\n```')],         │  ← turn 2: final JSON
  │      stop_reason: 'end_turn' }                            │
  │  ]                                                        │
  └──────────────────────────────────────────────────────────┘
                            │
                            ▼ injected as anthropic
  ┌─ REAL agent loop (lib/agents/base.ts, real code) ────────┐
  │  for turn in 0..maxTurns:                                 │
  │     res = await anthropic.messages.create(...)            │  ← pulls next script entry
  │     if no tool_use:                                       │
  │        return finalText                                   │
  │     for each tool_use:                                    │
  │        result = await mcp.callTool(name, args)            │  ← faked too
  │        messages.push(tool_result)                         │
  └──────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌─ test asserts on the OUTCOME ────────────────────────────┐
  │  expect(result.toolCalls).toHaveLength(1)                 │
  │  expect(result.finalText).toContain('done')               │
  │  expect(onToolCall).toHaveBeenCalledTimes(1)              │
  └──────────────────────────────────────────────────────────┘
```

The reason this works: the agent loop's control flow is deterministic *given* the model's outputs. Make the model's outputs deterministic by scripting them, and you can assert on every branch of the loop.

### Move 2 — the walkthrough, level by level

#### Level 1 — pure unit tests (the wide base)

**The shape.** One function, one input, one assertion. No setup, no mocks beyond a trivial fixture.

```
The pure-unit pattern — input → expected output

  ┌─ given ─────────────────┐
  │  input: '{"a":1}'        │
  └────────────┬────────────┘
               ▼
  ┌─ run ───────────────────┐
  │  parseAgentJson(input)   │  ← the unit
  └────────────┬────────────┘
               ▼
  ┌─ expect ────────────────┐
  │  toEqual({a: 1})         │
  └─────────────────────────┘
```

**Where this lives in the suite.** The 25 tests in `validate.test.ts`, the 11 in `derive.test.ts`, the 12 in `categories.test.ts`, the 7 in `events.test.ts`, the 3 in `intent.test.ts`, the 3 in `tool-schemas.test.ts`. All read like the pseudocode above — given, run, expect.

**The boundary condition.** Pure-unit tests are useless for code that has *meaningful behaviour from talking to other code* — the agent loop, the OAuth handshake. You can't unit-test "this agent makes the right tool call after seeing this error" because the behaviour lives in the conversation, not in any single function.

#### Level 2 — fixture-driven unit tests (also wide base)

**The shape.** Same as pure-unit, but the input is a real captured response from the wild. The fixture *is* the test contract — the test asserts that the parser handles what the real server returns.

```
Fixture-driven unit — the contract IS the fixture

  ┌─ test/fixtures/get_event_schema.json ─────────────────┐
  │  { "structuredContent": { "events": [ … 28 events     │  captured from a real
  │  including campaign(204917) and purchase(27046) … ] }}│  Bloomreach call
  └──────────────────────────┬──────────────────────────┘
                             │ loaded via readFileSync
                             ▼
  ┌─ run ──────────────────────────────────────────────┐
  │  parseWorkspaceSchema({ eventSchema: fixture, … })  │
  └────────────────────────┬──────────────────────────┘
                           ▼
  ┌─ expect ───────────────────────────────────────────┐
  │  schema.events.length === 28                        │
  │  schema.events[0].name === 'campaign'               │
  │  schema.events[0].eventCount === 204917             │
  └────────────────────────────────────────────────────┘
```

**Where this lives.** The 24 tests in `schema.test.ts` are the canonical example — they load `test/fixtures/get_event_schema.json` and assert specific event counts that match the real captured payload (`campaign 204917`, `purchase 27046`, `view_item 89717`).

**The boundary condition.** Fixtures go stale. If Bloomreach changes the shape of `get_event_schema` tomorrow, every test in `schema.test.ts` still passes — they're parsing 2026-05 fixtures, not 2026-08 reality. This is the "no contract test" gap called out in `07-testing-red-flags-audit.md`.

#### Level 3 — the scripted-Anthropic pattern (the integration sweet spot)

**The shape.** Build a fake `Anthropic` instance whose `messages.create` returns a pre-scripted sequence. Build a fake `McpCaller` whose `callTool` returns scripted results. Wire both into the real agent class. Run the agent end-to-end and assert on what it actually did.

```
The scripted-Anthropic harness — what's real, what's fake

  ┌─ FAKE Anthropic ────────────────────────────────────────┐
  │  let idx = 0;                                           │
  │  const create = vi.fn(async () => {                     │  ← pulls the next
  │    const resp = responses[idx++];                       │     scripted response
  │    return { ...resp, model: AGENT_MODEL, … };           │     each call
  │  });                                                    │
  └────────────────────────┬───────────────────────────────┘
                           │ injected
                           ▼
  ┌─ ★ REAL agent ★ ───────────────────────────────────────┐
  │  new DiagnosticAgent(fakeAnthropic, fakeMcp, schema,   │  ← real class
  │                       toolDefs)                         │
  │     .investigate(anomaly, { onToolCall, onText, … })   │
  │     │                                                  │
  │     ├─ builds the system prompt (real)                 │
  │     ├─ calls runAgentLoop (real)                       │
  │     │   ├─ multi-turn for-loop (real)                  │
  │     │   ├─ extracts text + tool_use blocks (real)      │
  │     │   ├─ calls mcp.callTool (faked McpCaller)        │
  │     │   ├─ appends tool_result to messages (real)      │
  │     │   └─ enforces maxTurns + maxToolCalls (real)     │
  │     ├─ parses agent output via parseAgentJson (real)   │
  │     ├─ validates via isDiagnosis (real)                │
  │     └─ on failure, runs synthesize() fallback (real)   │
  └────────────────────────┬───────────────────────────────┘
                           ▼
  ┌─ FAKE McpCaller ───────────────────────────────────────┐
  │  { async callTool(name, args) {                         │
  │      return { result: { ok: true }, durationMs: 1, … } │
  │    }                                                    │
  │  }                                                      │
  └────────────────────────────────────────────────────────┘
```

**What this catches.** Every branch of `runAgentLoop` — tool-then-text, text-only, tool-throws, maxTurns hit, maxToolCalls hit, synthesisInstruction appended on forced-final turn. All 8 of `base.test.ts`'s scenarios exercise the *real* loop with scripted-Anthropic outputs (`base.test.ts` lines 105–384).

**What this misses.** The model itself is the part you can't test this way. If the real Anthropic model emits worse JSON tomorrow, every test still passes — the fakes return whatever the test wrote. That's the AI-eval gap, and it's covered in `06-testing-ai-features.md`.

**The boundary condition.** This pattern is the high-water mark of what deterministic testing can do for AI features. You've collapsed the probabilistic part (the model) back to determinism by scripting. Past that, you're in eval territory.

#### Level 4 — route integration tests (the empty band)

**The shape that doesn't exist.** A test that imports the route handler `POST` or `GET` function from `app/api/agent/route.ts`, calls it with a constructed `NextRequest`, asserts on the response shape (NDJSON event order, status code, headers).

```
The route-integration test that's missing (pseudocode)

  ┌─ test setup ────────────────────────────────────────┐
  │  vi.mock('@anthropic-ai/sdk', () => fakeAnthropic)   │
  │  vi.mock('@/lib/mcp/connect', () => fakeMcpClient)   │
  └──────────────────────┬──────────────────────────────┘
                         ▼
  ┌─ import the real handler ──────────────────────────┐
  │  import { GET } from '@/app/api/agent/route'         │
  └──────────────────────┬──────────────────────────────┘
                         ▼
  ┌─ run ──────────────────────────────────────────────┐
  │  const req = new NextRequest('http://x/api/agent…'  │
  │             + '?step=diagnose&insight={…}')          │
  │  const res = await GET(req)                          │
  │  const stream = await readNdjson(res.body)           │
  └──────────────────────┬──────────────────────────────┘
                         ▼
  ┌─ assert on the OUTPUT contract ────────────────────┐
  │  events[0].type === 'reasoning_step'                 │
  │  events[1].type === 'tool_call_start'                │
  │  events[2].type === 'tool_call_end'                  │
  │  events[N-1].type === 'done'   ← done sentinel last │
  │  no event has interior '\n' (NDJSON invariant)      │
  └────────────────────────────────────────────────────┘
```

**Why this is the highest-leverage missing test.** Every piece in the route handler (`classifyIntent`, `getAnomaly`, `DiagnosticAgent`, `encodeEvent`) is unit-tested in isolation. The bug class this would catch is *ordering and termination* — does the `done` event always fire last? Does an exception in the diagnostic agent fire an `error` event before the stream closes? Today: nobody knows from the test bar.

### Move 2 variant — the load-bearing skeleton of the scripted-Anthropic pattern

What is the *minimum* you need for this pattern to work?

1. **A response queue + an index that advances each call.** The fake `messages.create` must return a *different* response each call, not the same one. Drop this and you can only test one-turn flows. (`base.test.ts` builds this with `let idx = 0; idx++` on lines 22–30.)

2. **The fake must match the Anthropic SDK's response shape closely enough that the agent's code doesn't blow up.** That's why `buildFakeAnthropic` includes `usage`, `stop_reason`, `model`, `container`, etc. — fields the agent doesn't read but the type system requires (`base.test.ts` lines 32–48). Drop this and TypeScript complains and runtime crashes when the agent inspects a field.

3. **A way to assert the agent *sent the right thing* to the model.** vi.fn() makes `create.mock.calls` available, which the `system`-prompt test in `base.test.ts` lines 378–383 uses to verify `synthesisInstruction` was appended on the right turn.

Skeleton = response queue + shape-faithful response + mock-call inspection. Drop any one and you can't test what you need to test. Optional hardening: the helpers (`toolUseBlock`, `textBlock`), the `callCount()` exposed by the closure for assertion convenience.

### Move 3 — the principle

**The right test level is determined by where the bug class lives.** Pure-unit catches arithmetic and parsing bugs. Fixture-driven catches "we misread the schema" bugs. Scripted-Anthropic catches loop-control and protocol bugs. Route-integration catches wiring and contract bugs. End-to-end catches deployment and network bugs. blooming insights is strong at levels 1–3 and absent at levels 4–5. The fix for the gap is not "more tests" — it's "test the next level up."

## Primary diagram

The full pyramid for blooming insights, with every test file mapped to its level:

```
The pyramid, as-built — every test file placed on a level

                          ╱ ╲
                         ╱   ╲
                        ╱ e2e ╲          0 tests
                       ╱───────╲
                      ╱         ╲
                     ╱ integ.    ╲       0 route tests
                    ╱ (routes)    ╲      (the highest-value missing band)
                   ╱───────────────╲
                  ╱  ★ scripted-     ╲
                 ╱    Anthropic ★     ╲   ~31 tests across
                ╱  base.test.ts (8)    ╲  test/agents/{base,diagnostic,
               ╱   diagnostic (5)        ╲ monitoring,query,recommendation}
              ╱    monitoring (10)        ╲
             ╱     query (3)               ╲
            ╱      recommendation (5)       ╲
           ╱─────────────────────────────────╲
          ╱   pure + fixture-driven UNIT      ╲   ~138 tests:
         ╱   validate (25), schema (24),       ╲  the wide base where
        ╱    client (14), auth (14),            ╲ all 18 files have
       ╱     categories (12), derive (11),       ╲ at least one test
      ╱      tool-coverage (8), events (7),       ╲
     ╱       intent (7), insights/state (9),       ╲
    ╱        transport (4), investigations (4),     ╲
   ╱         tool-schemas (3)                        ╲
  ╱___________________________________________________╲

   total: 169 tests / 18 files (vitest run, environment: 'node')
```

## Implementation in codebase

**Use case A — proving the agent loop's branches.** `base.test.ts` has 8 tests, each exercising one branch of `runAgentLoop`. Together they're a near-exhaustive harness for the multi-turn dispatch logic. The test that proves `synthesisInstruction` is only appended on the forced-final turn (lines 361–383) is the load-bearing one — it's the bug-prone branch and the test uses `create.mock.calls[0][0].system` vs `calls[1][0].system` to inspect the actual prompts sent.

```
test/agents/base.test.ts  (lines 361–383)

  it('appends synthesisInstruction to the system prompt only on the forced-final turn', async () => {
    const { anthropic } = buildFakeAnthropic([
      { content: [toolUseBlock('tu8', 'get_project_overview', { project_id: 'z' })],
        stop_reason: 'tool_use' },          ← turn 1: tool call (tools offered, plain system)
      { content: [textBlock('final')], stop_reason: 'end_turn' },  ← turn 2: forced-final
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
    expect(calls[0][0].system).toBe('BASE SYSTEM');            ← unmodified on turn 1
    expect(calls[1][0].system).toContain('OUTPUT JSON NOW');   ← augmented on turn 2
       │
       └─ this is the test that proves the augmentation is conditional on
          forceFinal === true. Without it, you'd append the synthesis
          instruction on every turn and burn tokens (or worse, change behaviour).
  });
```

**Use case B — proving the parser holds against captured reality.** `schema.test.ts` loads 7 real fixtures and asserts specific values from the captured payload. `events[0].name === 'campaign'` and `eventCount === 204917` are not arbitrary — they're the actual most-frequent event in the captured Bloomreach project.

```
test/mcp/schema.test.ts  (lines 101–104)

  it('first event (campaign, 204917) is the most active', () => {
    expect(schema.events[0].name).toBe('campaign');     ← real Bloomreach data,
    expect(schema.events[0].eventCount).toBe(204917);   ← not invented; locks the
  });                                                     parser against the
       │                                                  shape that was seen.
       └─ swap "campaign" for a different event tomorrow and the parser must
          still get the most-frequent-first ordering right; this is a regression
          guard against a sort bug introduced in a refactor.
```

## Elaborate

The pyramid metaphor is from Mike Cohn's *Succeeding with Agile* (2009) — wide base of fast unit tests, thin top of slow e2e tests. The variant for AI features adds the "scripted external" layer between unit and integration, which is what blooming insights uses. The pattern travels: any time you have a probabilistic external (LLM, payments, geo lookup), you script it at the boundary and test the deterministic glue around it. The vitest `vi.fn()` + `mock.calls` introspection is the unsung mechanic — it's what lets you assert on what the agent *sent*, not just what it returned.

Cross-reference: the route-integration gap is the same gap `study-software-design` would call out under "test the seams, not the layers" — every layer is well-tested, but the seams (route → lib, OAuth → MCP client) aren't.

## Interview defense

**Q: "scripted-Anthropic" — is that a unit test or an integration test?** It's closer to integration. The unit under test is the entire `DiagnosticAgent.investigate` method, which runs a multi-turn loop with real branching, real message-history accumulation, real parser fallback. The only fakes are at the boundaries: Anthropic (faked at the SDK seam) and MCP (faked at the `McpCaller` interface). That's an integration test where the externals are scripted.

```
The fake / real boundary in the scripted-Anthropic pattern

   FAKE                  REAL                              FAKE
  ──────              ────────────────                   ──────
  Anthropic    ─►  DiagnosticAgent.investigate    ─►    McpCaller
  SDK              │                                     interface
   .messages.      │  → builds system prompt
    create         │  → calls runAgentLoop
   (scripted)      │     │
                   │     ├─ for turn in maxTurns           │
                   │     ├─ extracts text/tool blocks      │
                   │     ├─ accumulates messages           │ ◄─ scripted
                   │     ├─ enforces maxTurns budget       │     tool result
                   │     └─ forceFinal logic               │
                   │  → parses output via parseAgentJson   │
                   │  → validates via isDiagnosis          │
                   │  → on failure, runs synthesize()      │
                   └────────────────────────────────────
```

**Q: Why not just integration-test the route?** Because nobody has built the harness for it yet, not because the pattern would be hard. The shape would be: import `GET` from the route file, fake `@anthropic-ai/sdk` and `@/lib/mcp/connect`, build a `NextRequest`, await the response, read the NDJSON stream. The blocker is setup investment, not technique. Real gap.

## Validate

1. **Reconstruct:** Sketch the pyramid for this repo. Which level is wide, which is thin, which is empty?
2. **Explain:** Walk through what makes `base.test.ts`'s 8 tests "integration-flavored unit tests" rather than pure unit tests.
3. **Apply:** Design the first route-integration test for `app/api/agent/route.ts`. What do you fake at the boundary, what do you assert on?
4. **Defend:** A teammate says "let's add e2e tests with Playwright." Argue for or against, given the current pyramid shape.

## See also

- [01-what-is-tested-and-what-isnt.md](01-what-is-tested-and-what-isnt.md) — the risk map that names the route-integration gap
- [03-tests-as-design-pressure.md](03-tests-as-design-pressure.md) — why the scripted-Anthropic pattern works (`McpCaller` interface, dependency injection)
- [06-testing-ai-features.md](06-testing-ai-features.md) — what's above the scripted-Anthropic ceiling (the AI-eval gap)
