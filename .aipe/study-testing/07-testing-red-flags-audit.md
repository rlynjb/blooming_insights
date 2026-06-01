# 07 — Testing red flags, marked against this repo

**Industry name:** Testing antipatterns checklist / suite-health audit. **Type:** Industry standard.

## Zoom out, then zoom in

The capstone. Eleven red flags that tend to appear in real codebases, each marked **✓ clean**, **△ partial**, or **✗ present** against blooming insights, with the file evidence. The pattern: this repo has solved the *plumbing* red flags (over-mocking, hidden coupling, time-dependent flakes) and left the *integration* and *evaluation* red flags open.

```
Zoom out — the red-flag checklist at a glance

  category               flag                                  status
  ─────────              ────                                  ──────
  coverage                missing-test-on-critical-path        ✗ present
                          (route handlers, OAuth orchestration)

  design                  hard-to-test untestable code         ✓ clean
                          (deep modules, DI everywhere)

  flakiness               flakes accepted                       ✓ clean (one fixed)
                          time/order/env-dependent              ✓ clean

  isolation               leaky shared state                    ✓ clean (one fixed)

  mocks                   over-mocked unit tests                ✓ clean
                          mock-the-thing-you-own                ✓ clean

  contracts               no contract test on external          ✗ present
                          (Bloomreach MCP shape, fixtures stale-able)

  AI features             no quality eval                       ✗ present (Case B)
                          unit tests on plumbing only            (see file 06)

  hygiene                 passWithNoTests masks gaps            △ partial

  hygiene                 no lint guard on direct env mutation  △ partial

  e2e                     no end-to-end smoke                   ✗ present
                          NDJSON stream not tested end-to-end

  hygiene                 test code drift / dead helpers        ✓ clean
```

Now zoom in. Each red flag gets a one-paragraph verdict, the file evidence, and — when the flag is present — the smallest move that would clear it.

## Structure pass

**Layers:** the test (does it exist?) → the design (could it exist?) → the discipline (is it enforced?). **Axis traced:** *what's blocking the gap from closing?* **The seams where the answer flips:**

```
The axis "what blocks closing this gap?" — across red-flag categories

  axis traced = "WHY does this red flag persist?"

  ┌─ blocked by missing test ─────────────────────────┐
  │  no route-handler integration test                │  fix: write the test
  │  no contract test for MCP shapes                   │  (existing pattern
  │  no end-to-end NDJSON smoke                       │  applies, just hasn't
  └──────────────────┬────────────────────────────────┘  been done)

  ┌─ blocked by missing design seam ──────────────────┐
  │  app/api/agent/route.ts imports Anthropic +        │  fix: extract
  │  connectMcp at module top — no DI                  │  runInvestigation(deps)
  │                                                     │  first, then test
  └──────────────────┬────────────────────────────────┘  (see file 03)

  ┌─ blocked by missing discipline (lint / convention) ┐
  │  no rule banning direct process.env.X mutation     │  fix: ESLint rule
  │  passWithNoTests: true masks new gaps              │  + flip to false
  └──────────────────┬────────────────────────────────┘  + add coverage gate

  ┌─ blocked by Case-B build (the eval suite) ────────┐
  │  no quality eval, no goldset, no judge             │  fix: ~1 week MVP
  └───────────────────────────────────────────────────┘  (see file 06)
```

Four categories of blocker. The first two are one-afternoon fixes. The third is a one-rule lint addition. The fourth is the multi-week eval-suite build that's pointed at `study-ai-engineering/05-evals-and-observability/`.

## How it works

### Move 1 — the mental model

A red-flag audit is the inverse of a test-coverage report. Coverage tells you "this line was executed." A red-flag audit tells you "this *class* of bug is undefended." Coverage is per-line; the audit is per-*shape-of-bug*. The audit's value is forcing the team to name what they accept: which gaps are real, which are deferred, which are okay-for-now.

```
The audit shape — every flag, three honest verdicts

  ┌─ clean ✓ ─────────────────────────────────────────────┐
  │  flag exists in some codebases, NOT THIS ONE          │
  │  document why; preserve the discipline                 │
  └───────────────────────────────────────────────────────┘

  ┌─ partial △ ───────────────────────────────────────────┐
  │  flag is being defended in some places, not all       │
  │  name the gap; note the fix                            │
  └───────────────────────────────────────────────────────┘

  ┌─ present ✗ ───────────────────────────────────────────┐
  │  flag is unaddressed, real bug class is live           │
  │  decide: fix now, defer with a ticket, or accept       │
  │  consciously                                           │
  └───────────────────────────────────────────────────────┘
```

### Move 2 — the walkthrough, flag by flag

#### Flag 1 — missing tests on the critical path ✗ present

**The shape.** `app/api/agent/route.ts` is the heart of every investigation: NDJSON-stream orchestration, intent classification, agent dispatch, 300s budget guard. Zero tests. `lib/mcp/connect.ts` orchestrates OAuth (DCR → PKCE → token exchange). Zero tests.

**Evidence.** No `test/api/` directory. No `test/mcp/connect.test.ts`. The lib functions they call (`classifyIntent`, `DiagnosticAgent`, `encodeEvent`) are all tested in isolation; the *wiring* is not.

**Fix.** Extract `runInvestigation(deps)` from the route handler (see file 03 for the design pressure). Then apply the scripted-Anthropic pattern one layer up — fake `@anthropic-ai/sdk` and `@/lib/mcp/connect`, await the handler's response, read the NDJSON stream, assert on event order and `done` sentinel. Estimated: one afternoon for the route, one day for connect.

#### Flag 2 — hard-to-test code (design smell) ✓ clean (in lib/)

**The shape.** "I'd test this but I can't" usually means deep coupling: hidden globals, hardcoded imports, no seam to inject a fake. Untestable = a design smell.

**Evidence.** `lib/mcp/client.ts` takes `transport` in its constructor (lines 87–95). `lib/agents/base.ts` defines `McpCaller` as the seam (lines 16–22). `runAgentLoop` takes anthropic + mcp in an options bag (lines 48–62). Every lib function has a clean injection point. **The clean discipline is the reason 169 tests exist with this little ceremony.**

**Where it's *not* clean.** The route layer (flag 1) — but that's the same flag, surfaced from the design side.

#### Flag 3 — flakes accepted ✓ clean

**The shape.** "Oh that test fails sometimes" is the death of a green bar.

**Evidence.** One flake of record (the AUTH_SECRET crypto test), fixed in commit `e83a8e0` with a comment block explaining the post-mortem so the fix can't be silently reverted. See file 04 for the full story.

**Fix none needed.** Generalization opportunity: a lint rule banning direct `process.env.X = …` in test files would prevent this class of flake landing somewhere else (covered under flag 8).

#### Flag 4 — time-dependent / order-dependent tests ✓ clean

**The shape.** A test that passes/fails based on what ran before it, or based on real-time elapsed.

**Evidence.** Every TTL / retry test in `client.test.ts` uses `vi.useFakeTimers()` and advances time deterministically (lines 50–78, 111–167). Every shared-state test (`auth.test.ts`, `insights.test.ts`, `investigations.test.ts`) resets state in `beforeEach` via the `_clear` exports.

#### Flag 5 — over-mocking (test the mock, not the code) ✓ clean

**The shape.** The bad version of mocking: you mock every function the code calls, then the test just verifies the mocks were called. You've tested nothing real — you've tested the mock-call recorder.

**Evidence.** The scripted-Anthropic pattern (file 02) does the *opposite*: fakes are placed at the boundary (Anthropic SDK, McpCaller), and the *real* agent code runs end-to-end. The test asserts on the agent's *real* behaviour (sorted anomalies, capped recommendations, synthesis fallback). The only "mock-the-call" tests are when verifying prompt assembly — `base.test.ts` line 378 reads `messages.create.mock.calls[1][0].system` to confirm `synthesisInstruction` was appended on the right turn, which is the right use of mock-call introspection (asserting on what was sent, not on the mock's existence).

#### Flag 6 — mock the thing you own ✓ clean

**The shape.** A long-standing testing rule: don't mock libraries you don't own (Anthropic SDK, MCP SDK) directly — wrap them in your own interface and mock that. Direct mocks of third-party libraries are brittle; the library's shape can change and your mock silently goes stale.

**Evidence.** `lib/mcp/transport.ts` wraps the MCP SDK Client behind the `McpTransport` interface (lines 7–10). `lib/agents/base.ts` wraps Anthropic behind `McpCaller` for the tool side and takes the Anthropic SDK directly only because that one is too tightly woven into the loop. The Anthropic fake is hand-crafted to match the SDK's response shape (`base.test.ts` lines 32–48 set every field the SDK requires). One concession to "mock what you don't own" — defensible because the response shape is well-documented and stable.

#### Flag 7 — no contract test for the external boundary ✗ present

**The shape.** Fixtures are captured snapshots. If the external service (Bloomreach MCP) changes its response shape tomorrow, every fixture-based test still passes against stale fixtures — but production breaks the moment a real call returns the new shape.

**Evidence.** `test/mcp/schema.test.ts` loads 7 fixtures from `test/fixtures/*.json` (lines 5–10). All 24 tests assert against the captured 2026-05 shapes. There is no test that compares the *live* MCP server's `listTools()` against `bootstrapTools` at CI time, and no test that re-fetches a fresh fixture to verify the shape hasn't drifted.

**Fix.** Two layers. (1) A `tool-coverage.test.ts`-style assertion at CI time that the live MCP server's tool list still includes every name in `monitoringTools / diagnosticTools / recommendationTools / bootstrapTools`. There's a step in this direction (`tool-coverage.test.ts` lines 70–82 hardcodes the bootstrap list), but no live check. (2) A periodic "refresh fixtures" CI job that pulls fresh responses from the real MCP server and fails if the shape diff is non-trivial. Estimated: one afternoon for the shape-diff job; ongoing for the curation.

#### Flag 8 — no lint guard on direct env mutation △ partial

**The shape.** The AUTH_SECRET fix (file 04) replaced direct `process.env.X = …` with `vi.stubEnv` in one file. Without a lint rule banning direct mutation in test files, the same flake can land somewhere else next week.

**Evidence.** `eslint.config.mjs` (the one ESLint config) is the standard Next config; no custom rule. A `no-process-env-mutation-in-test` ESLint plugin or a project-specific rule would close the gap.

**Fix.** Add an ESLint rule that flags `process.env.X = …` in `test/**/*.ts`. Recommend `vi.stubEnv` instead in the message.

#### Flag 9 — `passWithNoTests: true` masks new gaps △ partial

**The shape.** `vitest.config.ts` (line 7) has `passWithNoTests: true`. A new file added to `lib/` with zero tests will not even register as a problem — you'd have to read the diff and notice.

**Evidence.** `vitest.config.ts` lines 1–9, explicitly set. Combined with no coverage threshold, the test bar can be 100% green while coverage silently erodes.

**Fix.** Two options, increasing strictness. (1) Flip to `passWithNoTests: false` — only fails when the *config* finds zero tests at all (not very useful here). (2) Add `coverage: { thresholds: { lines: 70 } }` so a coverage drop fails CI. Combined with running `vitest --coverage` on every PR. Estimated: one afternoon.

#### Flag 10 — no end-to-end smoke ✗ present

**The shape.** Nothing in CI exercises the running app — no Playwright, no MCP-recorded fixture driving the full route stack, no `curl http://localhost:3000/api/agent` against a faked external boundary.

**Evidence.** No `playwright.config.ts`, no `e2e/` directory, no `cypress` dep in `package.json`. The closest thing is the route's `app/api/mcp/capture-demo/route.ts`, which is a one-shot dev helper, not a CI test.

**Fix.** Lower-cost option: an integration test in `test/api/agent.test.ts` (covered under flag 1) gets you 80% of the value without browser tooling. Higher-cost option: Playwright spinning the dev server and clicking through one investigation. The first is the right starting point.

#### Flag 11 — test code drift / dead helpers ✓ clean

**The shape.** Helper functions in test files that exist for tests that no longer exist; copy-paste fakes that diverge from production interface signatures.

**Evidence.** Every test file has minimal helpers (`buildFakeAnthropic`, `buildFakeMcp`, `toolUseBlock`, `textBlock`) and every helper is referenced by tests in the same file. The shared shape of `buildFakeAnthropic` across `base.test.ts`, `monitoring.test.ts`, `diagnostic.test.ts`, `recommendation.test.ts`, `query.test.ts` is duplicated but consistent — a refactor opportunity for a `test/helpers/fakes.ts` module, but the duplication isn't drift.

### Move 2 variant — the checklist of cleanest-to-worst

Ranked from "fix now" to "accept consciously":

```
The triage list — what to fix when

  fix now (small move, large leverage)
  ────────────────────────────────────
  1. Add ESLint rule banning process.env.X = … in test/**/*.ts (flag 8)
  2. Flip passWithNoTests: false + add coverage thresholds (flag 9)
  3. Write test/api/agent.test.ts (flag 1, flag 10 — same fix)

  fix next week (medium move, medium leverage)
  ────────────────────────────────────────────
  4. Extract runInvestigation(deps); test it with scripted-Anthropic (flag 1)
  5. Add test/mcp/connect.test.ts using the same pattern (flag 1)
  6. Add live-MCP shape-diff job in CI (flag 7)

  fix next quarter (large move, large leverage)
  ─────────────────────────────────────────────
  7. Build the goldset eval suite (Case B, file 06)

  accept consciously
  ──────────────────
  8. React component tests (no users, scope tradeoff — file 01)
  9. Helper de-duplication into test/helpers (cosmetic, not load-bearing)
```

### Move 3 — the principle

**A test suite is defined as much by what it doesn't test as by what it does.** A green bar that fails to specify what's not covered is a worse signal than a yellow bar that names the gaps. The red-flag audit is the discipline of naming the gaps loudly — so the team can decide which to close, which to defer, and which to accept. blooming insights closes the plumbing gaps (5 of 11 flags clean), partially closes hygiene (2 partial), and leaves the integration + eval gaps open (4 present). Those four are the audit's homework.

## Primary diagram

The full audit, marked:

```
The 11-flag audit for blooming insights — status, evidence, fix

  flag                             status  evidence                fix
  ────                             ──────  ────────                ───
   1  missing critical-path tests   ✗      no test/api/             extract
                                            no test/mcp/connect      runInvestigation;
                                                                     test layer up

   2  hard-to-test design smell     ✓ clean  McpCaller + McpTransport (none)
                                            + options-bag DI

   3  flakes accepted               ✓ clean  one fixed via stubEnv    (none; generalize
                                            (e83a8e0)                  via flag 8)

   4  time / order dependence       ✓ clean  vi.useFakeTimers +       (none)
                                            _clear() helpers

   5  over-mocking (mock the call)  ✓ clean  scripted-Anthropic +     (none)
                                            real agent code runs

   6  mock things you don't own     ✓ clean  McpTransport wraps SDK   (none)

   7  no contract test on external  ✗      fixtures from 2026-05      live-shape-diff
                                            never re-validated         CI job

   8  no lint guard on env mutation △        ESLint config has no      add custom
                                            custom rule                ESLint rule

   9  passWithNoTests masks gaps    △        vitest.config.ts line 7   flip + add
                                                                       coverage gate

  10  no end-to-end smoke           ✗      no Playwright, no test/    test/api/
                                            api directory               agent.test.ts
                                                                       (same as flag 1)

  11  test drift / dead helpers     ✓ clean  helpers used; some        (cosmetic
                                            duplication acceptable      refactor opt.)


  ┌─ AI-specific flag (file 06) ─────────────────────────────────────┐
  │                                                                   │
  │  no quality eval (Case B)        ✗      no evals/ directory,      build goldset +
  │                                          no goldset, no judge      runner; see
  │                                                                    study-ai-eng/05
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘

  TALLY:
    clean    5 (design + flakiness + time + over-mocking + own-mocking)
    partial  2 (env-mutation lint, passWithNoTests)
    present  4 (critical-path, external-contract, e2e smoke, AI eval)
```

## Implementation in codebase

**Use case A — the cleanest flag in this repo (over-mocking).** Every agent test uses the scripted-Anthropic pattern, which exercises the real agent code end-to-end:

```
test/agents/base.test.ts  (lines 286–320 — the onText test)

  it('calls onText with reasoning text for each turn that has text', async () => {
    const { anthropic } = buildFakeAnthropic([
      { content: [
          textBlock('thinking about it'),                  ← scripted MODEL output
          toolUseBlock('tu6', 'get_project_overview', { project_id: 'r' }),
        ], stop_reason: 'tool_use' },
      { content: [textBlock('final')], stop_reason: 'end_turn' },
    ]);

    const mcp = buildFakeMcp(async () => ({ ok: true }));
    const onTextCalls: string[] = [];
    const onText = (text) => { onTextCalls.push(text); };

    await runAgentLoop({                                   ← REAL loop runs
      anthropic: anthropic as unknown as Anthropic,
      mcp, agent: 'monitoring', system: 'You are a monitoring agent.',
      userPrompt: 'Check things.', toolSchemas: fakeToolSchemas, onText,
    });

    expect(onTextCalls).toHaveLength(2);                    ← assert on REAL
    expect(onTextCalls[0]).toContain('thinking about it');     behaviour: did
    expect(onTextCalls[1]).toContain('final');                  the loop call
                                                                  onText with
                                                                  the right text
                                                                  at each turn?
       │
       └─ this is NOT "did onText get called" — that would be over-mocking.
          It's "given the model said X, did the loop's text-extraction logic
          surface X to the caller via onText?" — that's testing the loop's
          real behaviour through a controlled boundary.
  });
```

**Use case B — the worst flag in this repo (no contract test on external).** The schema fixtures pin the parser against a 2026-05 snapshot. There's no test that fires if Bloomreach changes the shape:

```
test/mcp/schema.test.ts  (lines 5–16) — the fixture-load setup

  function loadFixture(name: string): unknown {
    const p = join(__dirname, '../fixtures', name);
    return JSON.parse(readFileSync(p, 'utf-8'));        ← reads committed file
  }                                                       captured on 2026-05

  const eventSchemaFixture = loadFixture('get_event_schema.json');  ← stale-able
  const customerPropsFixture = loadFixture('get_customer_property_schema.json');
  const catalogsFixture = loadFixture('list_catalogs.json');
  const overviewFixture = loadFixture('get_project_overview.json');
       │
       └─ all 24 tests below assert against this captured-2026-05 shape.
          If Bloomreach renames `events` to `event_definitions` tomorrow,
          every test still passes (parsing the old fixture, which still
          has `events`). Production breaks the first time a real call
          returns the new shape. The fix is a CI job that pulls a fresh
          fixture and shape-diffs against the committed one.
```

## Elaborate

The red-flag-audit pattern is descended from code-review checklists (Beck, *Extreme Programming*) and tech-debt heatmaps (Kim et al., *Accelerate*). The variant that ranks by "what blocks closing" is what makes it actionable — without that axis, the list reads as "everything could be better," which is true and useless. The honest framing — "5 clean, 2 partial, 4 present, here's the buildable order" — is the difference between a useful audit and a complaint letter.

The four "present" flags in this repo cluster around a single shape: **the integration boundary is undertested**. The route layer (flag 1), the external MCP shape (flag 7), the end-to-end NDJSON stream (flag 10), and the AI quality boundary (eval gap) are all variations on "the units are tested, the seams aren't." That's the audit's load-bearing finding — and it's the same finding `study-software-design`'s "test the seams" would land on.

## Interview defense

**Q: One flag to fix this week — which?** Add the route-integration test for `app/api/agent/route.ts`. It closes flag 1 (missing critical-path test) and flag 10 (no end-to-end smoke) simultaneously. The pattern is borrowed directly from the scripted-Anthropic tests one layer down — fake Anthropic at the SDK seam, fake MCP at the McpTransport seam, await the handler's NDJSON response, assert on event order and the `done` sentinel. One afternoon, large leverage.

**Q: One flag to defer — which?** React component tests. Adding `@testing-library/react` + switching `vitest.config.ts` to jsdom is non-trivial setup for a UI surface that's mostly read-only rendering of well-typed lib outputs. The lib layer already catches the bugs that matter. Defer until a specific UI bug recurs that lib tests can't catch.

**Q: The "no quality eval" gap — why is that in this audit instead of just the AI-engineering audit?** Because the *symptom* shows up as testing: 169 green tests, every prompt edit ships unmeasured, every model swap ships unmeasured. From the testing lens, the failure mode is "the green bar is lying about quality." From the AI-engineering lens, it's "no goldset, no judge." Same gap, two vantage points; calling it out here keeps the testing audit honest about what its green bar means.

```
The same gap from two lenses

   testing lens                          AI-engineering lens
   ────────────                          ───────────────────
   "169 tests pass; ship?"               "no eval, ship?"
   green bar says wrapper works          quality signal: none
   says nothing about quality            buildable: goldset + judge
                                          + runner
   gap is real even with 100% line       gap is real even with 100
   coverage of lib/                       eval cases — they meet at
                                          counterfactual replay
```

## Validate

1. **Reconstruct:** Without looking, list the 4 ✗-present flags and the 2 △-partial flags for this repo.
2. **Explain:** Why is flag 7 (no contract test on external) load-bearing even though the fixtures are real captured payloads?
3. **Apply:** Pick one ✗-present flag and write the first test that would start closing it. Include the file path, the imports, and a one-paragraph test description.
4. **Defend:** A reviewer says "this audit reads as 'add more tests.'" Push back by naming a test you'd NOT add (the React components) and explaining the tradeoff.

## See also

- [01-what-is-tested-and-what-isnt.md](01-what-is-tested-and-what-isnt.md) — the coverage map that flag 1 reads against
- [02-test-design-and-levels.md](02-test-design-and-levels.md) — the route-integration test (flag 1 + 10 fix) lives in the missing band
- [03-tests-as-design-pressure.md](03-tests-as-design-pressure.md) — the design fix for flag 1 (extract `runInvestigation(deps)`)
- [04-determinism-isolation-and-flakiness.md](04-determinism-isolation-and-flakiness.md) — the AUTH_SECRET fix; flag 8 is the lint rule that would generalize the lesson
- [06-testing-ai-features.md](06-testing-ai-features.md) — the AI-eval gap (Case B); points at study-ai-engineering/05 for the buildable target
