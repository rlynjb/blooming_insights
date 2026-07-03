# audit — the 7-lens walk

Pass 1 of the study. One `##` section per lens. Findings anchored to
`file:line`. When a lens finds a technique that's load-bearing enough
to earn a dedicated pattern file, the lens cross-links there instead of
restating the deep walk.

═════════════════════════════════════════════════
Lens 1 — what is tested and what isn't
═════════════════════════════════════════════════

The coverage MAP, not the number. Which critical paths have tests,
which don't.

### What IS tested (well)

- **The MCP client's cache + rate-limit ladder** —
  `lib/mcp/client.ts` gets 14 tests
  (`test/mcp/client.test.ts:14-198`) covering the cache miss/hit
  contract, TTL expiry (fake timers), per-name+args keying, rate-limit
  retry with parsed retry-after windows, `McpToolError` wrapping.
  This is the highest-stakes surface in the repo — every agent tool
  call routes through it, the alpha server rate-limits at ~1 req/s,
  and the retry ladder decides whether the demo works. It's the
  best-tested single module.

- **Auth + session** — `lib/mcp/auth.ts` (14 tests) +
  `lib/mcp/auth-providers/*` (17 tests, Session B additions) covers
  the OAuth provider surface, CSRF state one-time-use
  (`auth.test.ts:99-108`), AES-256-GCM cookie round-trip
  (`auth.test.ts:124-134`), and provider-factory validation for the
  three new auth types (`auth-providers.test.ts`).

- **Schema parsing against real fixtures** —
  `test/fixtures/*.json` holds 8 captured MCP payloads
  (`get_event_schema.json`, `get_customer_property_schema.json`,
  `list_catalogs.json`, `get_project_overview.json`, …). The
  `parseWorkspaceSchema` tests
  (`test/mcp/schema.test.ts:62-297`) run the actual wire format
  through the parser — this is fixture-anchored contract testing.
  See `05-fixture-anchored-schema-tests.md`.

- **Agent loops** — `runAgentLoop` gets 8 tests
  (`test/agents/base.test.ts:101-384`) covering tool-use → text
  handoff, `maxTurns` budget, `maxToolCalls` synthesis flip, and
  error recovery. Every specialized agent
  (`monitoring/diagnostic/recommendation/query/intent`) has its own
  file with 3–10 tests, all built on the same scripted-Anthropic
  fake. See `01-scripted-anthropic-fake.md`.

- **Route integration** — `briefing.integration.test.ts` (7 tests) +
  `agent.integration.test.ts` (10 tests) hit the routes end-to-end
  with the full mock stack (Anthropic + MCP + session + connect).
  Happy path, demo replay, 401, `listTools` failure, Anthropic 529,
  cancellation, phase-timing log — all covered
  (`briefing.integration.test.ts:115-407`).

- **NDJSON codec** — `test/streaming/ndjson.test.ts` covers the 5
  cases that matter: multi-event chunk, split line, trailing buffer,
  malformed line, and `cancelOn` short-circuit
  (`ndjson.test.ts:17-98`). Test uses the SAME `readNdjson` kernel
  the production UI hooks use.

- **New config module** — `lib/mcp/config.ts` (23 tests, Session D)
  covers the encode/decode round-trip, three distinct fail-safe
  fall-through paths (malformed base64 / invalid JSON / invalid
  shape), and localStorage read-through with an in-memory shim
  (`config.test.ts`). See `06-fail-safe-decode-contract-tests.md`.

### What is NOT tested

- **`components/**/*.tsx`** — 20 `.tsx` files, zero tests. Includes
  `InsightCard`, `EvidencePanel`, `RecommendationCard`, `StatusLog`,
  `ToolCallBlock`, `ProcessStepper`, `SeverityBadge`, `AgentBadge`,
  the settings modal, the QueryBox, the SkelentonCard family. The
  derive-field logic that feeds them IS unit-tested
  (`test/insights/derive.test.ts`), so the pipe's inputs are
  correct; nothing checks the render. **This is the largest
  untested surface in the repo.** See gap #2 in `00-overview.md`.

- **Client hooks** — `lib/hooks/{useInvestigation,
  useBriefingStream, useReconnectPolicy, useDemoCapture}.ts`. Zero
  tests. The load-bearing invariant "survives StrictMode by NOT
  cancelling in-flight fetch on cleanup" lives in a comment
  (`useInvestigation.ts`), not a test. See gap #1.

- **Markdown export** — `lib/export/investigationMarkdown.ts`. Zero
  tests. Pure function; trivially snapshot-testable; broken export
  is a broken demo. See gap #3.

- **The `mcp-data-source.ts` layer beyond its interface** — the
  fault-injecting decorator (`lib/data-source/fault-injecting.ts`)
  has documented behavior but no unit test. Its four failure modes
  ARE exercised through the load harness (`eval/load.eval.ts`), but
  as an integration property — the decorator's isolated logic
  (per-error probabilities, xorshift32 seed, callback firing) has
  no unit test.

- **Design docs' example code** — `lib/design/**` exists as
  written-down decisions, not runnable code; correct that it has no
  tests.

**Red flag check:** is the most important / most complex code the
least tested? **Partial no.** The MCP client (most complex
control-flow: cache + rate-limit + retry-after parsing + exponential
backoff) is the best-tested. The client hooks (highest user impact:
every page depends on them) are the least tested. Net: the
server-side risk is well-covered; the client-side risk is not.

═════════════════════════════════════════════════
Lens 2 — test design and levels (the pyramid as-built)
═════════════════════════════════════════════════

### The shape

```
  The pyramid as-built

  ────────────  e2e / browser         0 tests   (none)
    ────────    integration          19 tests   (test/api/*)
   ──────────   unit                242 tests   (everything else)
```

Standard, healthy shape. 90%+ of assertions run in sub-second unit
tests; a narrow band of integration tests wires the routes through
the full mock stack; no browser layer.

### Where the seams live

**Fakes, not mocks** — the repo consistently reaches for scripted
fakes over `vi.fn().mockReturnValue(...)` at the load-bearing seams:

- **Anthropic SDK** — a scripted-response queue that's shared
  module state between `_helpers.ts` and every integration test
  (`test/api/_helpers.ts:47-93`). Each test fills the queue with
  the exact sequence of turns the SDK would return; the fake throws
  on exhaustion so mismatches fail loudly. See
  `01-scripted-anthropic-fake.md`.

- **MCP caller** — `McpCaller` is an interface (`{ callTool(name,
  args) → { result, durationMs, fromCache } }`), so unit tests
  hand-roll a fake for the specific tool sequence the test needs
  (`test/agents/diagnostic.test.ts:103-109`). The integration
  tests upgrade this to a per-tool switch table in
  `makeBootstrapCallTool` (`_helpers.ts:169-220`). See
  `02-scripted-mcp-caller-fake.md`.

- **HTTP transport** — `test/mcp/transport.test.ts` uses
  `vi.stubGlobal('fetch', …)` to swap out the real `fetch` for the
  20-line duration of a test, then `vi.unstubAllGlobals()` in
  `afterEach` (`transport.test.ts:11-13`). See
  `03-http-transport-mock-with-module-hoisting.md`.

- **Session + connect** — mocked at module load in
  `_helpers.ts` (`briefing.integration.test.ts:51-59`). Each test
  reassigns `currentMcp` / `currentConn` / `currentSessionId`;
  the mock factory reads these at call-time so tests don't need
  to re-mock per case.

### Where the balance is off

**One inverted-pyramid smell (contained):** the integration tests
in `test/api/` do a *lot* of work per test — 17 total tests but each
one drains a full NDJSON stream, exercises 8-10 mocked surfaces,
and asserts on 5-15 events. When they fail, the failure surface is
wide (which mock did I break? Anthropic? MCP? session?). The
`_helpers.ts` file has ~425 lines of scaffolding to make this
tolerable — extensive comments explain the reality-vs-plan deltas
uncovered during Phase 3 (`agent.integration.test.ts:7-25`). This
is a fine tradeoff for a repo of this shape (streaming NDJSON
routes are the product), but it means the integration tests are
NOT cheap to add to — a new route or a new stream-shape needs
another 30-line arrange block.

**No over-mocked unit tests** — the agent unit tests script the
Anthropic + MCP boundary and let `runAgentLoop`'s real code do the
work between them. That's the right level. There's no case here of
a unit test that stubs the code under test.

**No missing integration coverage at a critical seam** — the two
routes that carry the product both have integration tests. `/api/mcp/*`
routes are utility (start OAuth, callback, tools list) — the
allowlist that gates them is unit-tested
(`test/api/mcp-call-allowlist.test.ts`), and the flow itself is
covered indirectly through the auth tests.

═════════════════════════════════════════════════
Lens 3 — tests as design pressure
═════════════════════════════════════════════════

Where code was hard to test *because* the design was tangled — and
where testable code proves the design was clean.

### The clean seams — tests are easy because design is clean

- **`runAgentLoop` takes its `anthropic` as a parameter**
  (`lib/agents/base.ts` signature). No `new Anthropic(…)` inside
  the loop. Test files hand it a scripted fake in ~40 lines
  (`base.test.ts:16-56`). This is the deep-vs-shallow module
  test: the module has one clean seam (constructor injection), the
  test file consumes it in one line. Cross-link:
  `study-software-design`'s deep-modules discussion.

- **`McpClient` takes its `transport` as a parameter**
  (`lib/mcp/client.ts` constructor). Every rate-limit + retry test
  hands it a hand-rolled 4-line transport
  (`client.test.ts:5-12`). Zero elaborate setup — the seam is at
  the type boundary.

- **`DataSource` is an interface** — the same code that runs
  against Bloomreach in prod runs against `SyntheticDataSource` in
  the eval harness and against `FaultInjectingDataSource` in the
  load harness. The seam has now shipped in five uses without a
  caller-surface change (`fault-injecting.ts:11-16` documents
  this). Cross-link: `study-system-design`'s
  provider-abstraction pattern.

- **`readNdjson` takes the `ReadableStream` as a parameter** —
  works against a real `Response.body` in prod and against a
  hand-rolled `ReadableStream` in the tests
  (`ndjson.test.ts:5-13`). The `collectEvents` helper
  (`_helpers.ts:384-389`) is 4 lines *because* the production
  kernel is a pure function of a stream.

### The seams that DO show design pressure (mild)

- **The route handlers do their own bootstrap.** `/api/briefing`
  reads `sessionId → connectMcp → bootstrapSchema → coverage gate →
  listTools → monitoring scan → NDJSON stream`, all inside one
  `start(controller)` closure. Testing this needs 5 module-level
  `vi.mock` calls (`briefing.integration.test.ts:38-87`). Not
  broken — it works — but each new stream event or phase means the
  test file's arrange block grows too. If a second route wanted the
  same pipeline, the mocks would have to duplicate. The seam that
  *would* fix this is a `runBriefing(deps): AsyncIterable<AgentEvent>`
  helper injected into the route — the route would shrink to
  `for await (const e of runBriefing(deps)) controller.enqueue(...)`
  and the test would drop the 5 mocks. Design finding, cross-link
  to `study-software-design`.

- **In-memory session-keyed maps** — `lib/state/insights.ts` +
  `investigations.ts` hold state as top-level `Map`s. Test files
  need explicit `_clear()` / `_clearInvestigationCache()` calls in
  `beforeEach` (`briefing.integration.test.ts:99`,
  `agent.integration.test.ts:98`). Every test that forgets these
  becomes order-dependent. The clean-slate helpers are named with
  `_` prefixes to signal "test-only," which is honest — but a
  factory that constructs a fresh state map per request would take
  the pressure off entirely. Mild finding.

### Untestable code as a design smell — check

- **Client hooks with implicit React scheduler dependencies** —
  `useInvestigation.ts` documents the StrictMode double-mount
  handling in a comment because there's no test asserting the
  behavior. This isn't hard to test (jsdom + a scripted
  `ReadableStream` gets you there), but the fact that the invariant
  is *communicated as a comment, not a test* is a red flag: any
  refactor that "cleans up" the effect could silently break the
  demo path.

Cross-link summary: hard-to-test surfaces in this repo are mostly
mild (the routes' bootstrap size, the map-based state); the deep
modules that are easy to test dominate.

═════════════════════════════════════════════════
Lens 4 — determinism, isolation, and flakiness
═════════════════════════════════════════════════

Tests that depend on time, network, ordering, or shared state.

### What's controlled

- **Time is faked when it matters** — every rate-limit,
  retry-after, and cache-TTL test uses `vi.useFakeTimers()` +
  `vi.advanceTimersByTimeAsync(N)` inside the test and
  `vi.useRealTimers()` at the end (`client.test.ts:49-58`,
  `client.test.ts:60-78`, `client.test.ts:111-140`). No test
  waits on real `setTimeout` for its assertions. See
  `04-fake-timer-time-travel-for-rate-limits.md`.

- **Env is scoped** — `AUTH_SECRET` is set via
  `vi.stubEnv('AUTH_SECRET', 'test-secret-please-ignore')` in
  `beforeEach` and released via `vi.unstubAllEnvs()` in `afterEach`
  (`auth.test.ts:117-122`). Direct `process.env.X = ...` mutation
  was retired after it caused cross-file flakiness in parallel
  workers (comment `auth.test.ts:114-116`). The auth-providers
  tests re-use the same pattern (`auth-providers.test.ts:70-102`).

- **Insight/investigation state is cleared** — every integration
  test opens with `clearInsights()` +
  `_clearInvestigationCache()` + `_resetSchemaCache()`
  (`briefing.integration.test.ts:94-99`,
  `agent.integration.test.ts:beforeEach`). The `_resetSchemaCache()`
  comment (`briefing.integration.test.ts:95`) documents why: the
  cache would silently skip bootstrap on the second test and drift
  the mock-call assertions.

- **The Anthropic queue is drained** — `resetAnthropicQueue()`
  fires in `beforeEach` and the mock throws on exhausted queue
  (`_helpers.ts:73-74`). Test order can't reorder responses; each
  test declares its own script.

### What's not controlled

- **The eval harness is intentionally non-deterministic** — that's
  the whole point of an eval (`eval/README.md:20-26`,
  `vitest.eval.config.ts:1-32`). It's excluded from `npm test` by
  file-pattern (`vitest.config.ts:12`), which is the right seam.
  Cross-link to `study-ai-engineering`.

- **The demo replay in `briefing.integration.test.ts:172-195`
  reads real files** (`lib/state/demo-insights.json`) and paces
  emissions at 140ms — the test bumps its timeout to 15s to
  accommodate. If the demo snapshot changed in a way that reshuffled
  events (e.g. new insight class added), this test would need
  updating. Deliberate coupling; documented.

### Flakiness sources — none found

I checked for the obvious patterns:
- No `Date.now()` assertions without fake timers.
- No `Math.random()` inside assertions (only in test-mock helper for id
  generation, `_helpers.ts:109` — cosmetic, not asserted on).
- No `sleep(N)` waits.
- No shared file-system state between tests.
- No unstubbed globals surviving across files (`afterEach` on the
  transport tests, `_helpers.ts` resets on the integration tests).

If any test has ever flaked in CI, it's not because of a pattern
the code shows.

═════════════════════════════════════════════════
Lens 5 — edge cases and error paths
═════════════════════════════════════════════════

The happy path is usually tested. Boundary values, empty/null,
error branches — the rest.

### What's covered

- **Every JSON validator has both accept and reject cases** —
  `test/mcp/validate.test.ts` walks `isAnomalyArray`, `isDiagnosis`,
  `isRecommendationArray` with a well-formed input, an empty input,
  a null / string / non-array input, a missing-field input, and each
  enum-boundary violation (`validate.test.ts:22-120`). This is
  systematic — no "happy-path-only" validator.

- **Every fail-safe decoder has null-return tests** —
  `decodeConfigHeader` returns null for 5 distinct malformed
  inputs: missing, empty, malformed base64, non-JSON base64, valid
  base64 with invalid shape (`config.test.ts:97-121`). The
  discipline is: bad input → null, never throw. See
  `06-fail-safe-decode-contract-tests.md`.

- **The MCP client's error branches are tested** — transport
  throws → wrapped as `McpToolError`
  (`client.test.ts:178-197`); error result → not cached
  (`client.test.ts:89-99`); rate-limit → retried with parsed
  window (`client.test.ts:111-140`); max retries → returns error
  (`client.test.ts:169-176`).

- **The routes' error branches are integration-tested** —
  `/api/briefing` covers 401 unauthed
  (`briefing.integration.test.ts:203-222`), `listTools` throws
  (`briefing.integration.test.ts:230-265`), Anthropic 529
  (`briefing.integration.test.ts:275-300`). `/api/agent` covers
  404 insight-not-found + cached-investigation short-circuit +
  unauthed (see `agent.integration.test.ts` first ~10 tests).

- **Cancellation** — the newest test
  (`briefing.integration.test.ts:312-345`) verifies pre-abort
  cancellation drops through to the finally without emitting
  `done` or `error`, and that the phase log records
  `aborted: true`.

### Where the boundary coverage thins

- **The intent classifier has 7 tests but they're all string-in
  → intent-out** (`test/agents/intent.test.ts`). No coverage of what
  happens when the classifier's Anthropic call throws (does it
  fall through to a default? Does it propagate?). Small gap.

- **The `parseAgentJson` extractor is tested for happy shapes
  (fenced json, bare json, embedded in prose, no-json throws)**
  (`validate.test.ts:5-19`), but not for the boundary where the
  extractor finds valid JSON that isn't a JSON *object* (e.g. a
  bare number, a string literal). Downstream `isDiagnosis` /
  `isAnomalyArray` would reject those, so it's not a real
  correctness gap — but it means the extractor's error signaling
  is under-specified.

- **Property-based testing is not used anywhere.** Every test
  writes explicit fixtures. For validators + parsers, a
  fast-check pass would catch a class of shape drift that the
  current explicit cases don't. Not a bug, a missed technique.

═════════════════════════════════════════════════
Lens 6 — testing AI features
═════════════════════════════════════════════════

The determinism seam in practice: how the repo wraps a
non-deterministic core in a deterministic harness.

### The seam is shipped end-to-end

This repo has the AI-feature seam more cleanly than most — it's
the single strongest test-design pattern in the codebase.

```
  How this repo tests an AI feature

  ┌─ deterministic harness (test/agents/*.test.ts) ────────────┐
  │  · scripted Anthropic fake (queue of scripted responses)   │
  │  · scripted MCP fake (per-tool switch)                     │
  │  · assert on: parse output, tool sequence, hook fires,     │
  │              JSON validation, fallback shape               │
  └───────────────────────────┬────────────────────────────────┘
                              │  wraps
  ┌─ non-deterministic core (lib/agents/*.ts) ─────────────────┐
  │  · runAgentLoop → real Anthropic + real MCP                │
  │  · in TESTS: swapped for the fakes above                   │
  │  · in EVAL: run for real, judged by rubric                 │
  └───────────────────────────┬────────────────────────────────┘
                              │  handoff to
  ┌─ probabilistic eval (eval/*.eval.ts) ──────────────────────┐
  │  · 10 goldens, real Anthropic, RubricJudge                 │
  │  · assert on: verdict != 'fail' for gated cases, per-dim   │
  │              pass rates, baseline gate                     │
  │  · study-ai-engineering territory                          │
  └────────────────────────────────────────────────────────────┘
```

- **Prompt assembly, tool dispatch, output parsing** — the three
  parts of an LLM feature that ARE deterministic — all have tests.
  `runAgentLoop` (dispatch) has 8 tests. `parseAgentJson` /
  `isDiagnosis` / `isRecommendationArray` (output parsing) have
  ~25 tests. Prompt assembly is exercised via
  `schemaSummary(fixtureSchema)` and the same fixture is used in
  every monitoring/diagnostic test — so prompt-shape changes surface
  in the test file as diffs.

- **Fallback behavior on unparseable model output** — 
  `DiagnosticAgent.investigate` returns a "fallback diagnosis"
  when JSON extraction fails (`diagnostic.test.ts:227-268`), and
  the tests explicitly assert `conclusion.match(/Insufficient/i)`
  + empty evidence + empty hypotheses. This is the exact shape
  the UI's `EvidencePanel` renders when the model gave up —
  contract-tested here.

- **Dedicated-synthesis salvage** — when the loop ends with
  rambling prose instead of JSON, the agent makes a second
  tool-less synthesis call. Tested with a scripted 2-response
  queue: rambling first, valid JSON second
  (`diagnostic.test.ts:273-292`).

- **Signal-class-aware eval gate** — the eval harness only fails
  on `has-signal` / `partial-signal` cases (real anomalies where
  the agent should conclude something); `no-signal` / `positive`
  cases are measured, not gated (`run.eval.ts:407-424`). This is
  the correct discipline: gate on correctness, measure on
  calibration.

- **Judge-error placeholder** — when the judge model fails to
  produce parseable structured output (parse error after retries),
  the receipt records `verdict: 'judge_error'` instead of throwing
  (`run.eval.ts:97-108`). This keeps the aggregation code honest —
  a run with 2 judge errors doesn't disappear from the summary
  block.

The AI-feature seam finding is: **`test/agents/*.test.ts` is
`study-testing`'s territory, `eval/*.eval.ts` is
`study-ai-engineering`'s territory, and the split is clean at the
config level** (`vitest.config.ts` includes only `test/**`;
`vitest.eval.config.ts` includes only `eval/**`; the two never
cross-run).

═════════════════════════════════════════════════
Lens 7 — testing red flags audit (capstone)
═════════════════════════════════════════════════

The consolidated checklist. What's firing in this repo?

```
  Red flag                                              Firing?
  ─────────────────────────────────────────────────────────────
  most important / most complex code least tested       PARTIAL
    → server-side densely tested; client hooks /
      components not tested. Lens 1 finding.
  heavy mocking that tests the mock, not the code        NO
    → fakes are at the seam (Anthropic + MCP + fetch),
      real code runs between them.
  inverted pyramid (all e2e, slow, flaky)                NO
    → 242 unit / 19 integration / 0 browser.
  tests that pass/fail on rerun with no change           NO
    → fake timers + stubEnv + explicit resets; no
      shared file-system state.
  tests that must run in a specific order                NO
    → _clear() helpers in beforeEach; queue drained.
  zero tests on error/exception branches                 NO
    → every validator has reject cases; routes' error
      branches integration-tested; fail-safe decoders
      have null-return tests.
  test that needs elaborate setup to reach the code      MILD
    → integration tests wire 5 mocks × 30-line
      arrange each. Not broken; scale ceiling visible.
  LLM feature with no test at the boundary               NO
    → prompt assembly, dispatch, output parsing all
      deterministically tested. Lens 6 finding.
  test uses real network / real time                     NO
    → npm test has no network calls; eval harness
      isolated by config.
  flaky test suppressed with retry: N                    NO
    → no vitest retry config; no it.skip except one
      documented cancellation placeholder (retired).
  a test file with no assertions                         NO
  a test that asserts on itself (tautological)           NO
```

### The three red flags that ARE firing (in priority order)

1. **`components/**/*.tsx` untested** (partial red flag under
   "most important code least tested"). See gap #2.
2. **`lib/hooks/use*.ts` untested** (same lens; the
   StrictMode-double-mount comment is not a substitute for a
   test). See gap #1.
3. **Integration-test arrange blocks approaching a scale
   ceiling** (mild). Adding a third streaming route would tax the
   existing helper file. Design finding as much as testing
   finding — cross-link to `study-software-design`'s deep-module
   audit.

Everything else on the checklist is clear.
