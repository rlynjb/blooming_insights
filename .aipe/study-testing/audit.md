# Audit — the 7-lens walk

Every finding cites a real file with line range. Verdicts are ranked
worst-first inside each lens. State which side of the determinism seam a
finding is on. Cross-link to the Pass 2 pattern files (`01-…` through
`06-…`) for deep walks; the audit stays a lens-by-lens read.

Suite state at time of audit:
- `test/**/*.test.ts`: 24 files, **221 passing tests** (verified via
  `wc -l` and `grep -cE "^\s*(it|test)\("`).
- `eval/**/*.eval.ts`: 7 files. `run.eval.ts` runs 10 goldens. Latest
  baseline runId `2026-07-03T04-08-28-644Z` (see `eval/baseline.json`).
- CI (`.github/workflows/ci.yml`): typecheck + `npm test` + `next build`.
  Lint deliberately omitted (28 pre-existing errors, separate cleanup).
  Evals are NOT wired into CI push/PR — a manual `npm run eval` +
  `npm run eval:gate` step (deliberate: cost + non-determinism).

---

## 1. what-is-tested-and-what-isnt

**The coverage map — risk-ranked, not percentage-ranked.**

### What has tests (worth reading top-down)

- **`lib/agents/base.ts` (the shared `runAgentLoop`)** — 8 test cases in
  `test/agents/base.test.ts:105-345` covering: tool execution then final
  text, no-tools direct return, tool error captured and loop continues,
  `maxTurns` bailout with empty finalText, `maxToolCalls` forced-final-turn
  synthesis instruction, `onText` per-turn callback, `onToolResult` after
  execution, and byte-identity of the synthesis instruction (`
  synthesisInstruction` only appended on the forced-final turn). This is
  the most load-bearing surface in the codebase and the test file walks
  every control-flow edge.

- **Per-agent scripting**: `test/agents/monitoring.test.ts` (10+ cases),
  `diagnostic.test.ts` (10+), `recommendation.test.ts` (10+),
  `query.test.ts` (10+), `intent.test.ts`. Each agent's loop is walked with
  a scripted Anthropic fake and asserts on: tool-call args, JSON parse of
  final output, hypotheses coverage, error handling. → deep walk in
  `01-scripted-anthropic-fake.md`.

- **`lib/mcp/client.ts` — cache + rate-limit + retry**: `test/mcp/client.test.ts:14-198`
  covers cache-hit, cache-miss, `skipCache`, TTL expiry with
  `vi.useFakeTimers()`, per-call rate-limit floor (`minIntervalMs`),
  error-result not cached, retry after rate-limited response, parsed
  retry-after window (`(1 per 10 second)`, `Retry after ~7 seconds`), max
  retries then give up, transport-throw wrapped as `McpToolError` with the
  tool name in the message. Every load-bearing branch of the retry ladder
  is asserted.

- **`lib/mcp/auth.ts` — OAuth + cookie crypto**: `test/mcp/auth.test.ts`
  covers round-trip tokens/verifier, session isolation between two ids,
  DCR client metadata shape (`public-client`, `openid profile email` scope),
  `hasTokens`/`clearAuth`, and (with `vi.stubEnv('AUTH_SECRET', …)`) the
  AES-256-GCM cookie round-trip.

- **`lib/mcp/transport.ts` — fetch capture + error enrichment**:
  `test/mcp/transport.test.ts` covers `makeCapturingFetch` recording a 401
  body without consuming the original response, non-OK responses recorded,
  OK responses not recorded, and `SdkTransport` attaching the captured body
  to a thrown tool error's message.

- **`lib/mcp/schema.ts` — bootstrap parsing against real fixtures**:
  `test/mcp/schema.test.ts:1-297`. Loads 4 captured JSON files from
  `test/fixtures/` (real MCP responses), calls `unwrap` and
  `parseWorkspaceSchema` against them, and asserts on shape:
  `structuredContent` preferred, `content[0].text` fallback, events sorted
  by count descending, no duplicate names, etc. → deep walk in
  `03-captured-fixture-schema-tests.md`.

- **`lib/mcp/validate.ts` — agent output shape guards**:
  `test/mcp/validate.test.ts:1-120`. `parseAgentJson` (fenced ```json,
  bare, embedded), `isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`
  — accept/reject positive+negative, including the rich `estimatedImpact`
  object shape.

- **API integration tests (route level, mocked at the SDK/transport/session
  seams)**: `test/api/briefing.integration.test.ts` (~400 lines, 7 cases),
  `test/api/agent.integration.test.ts` (~565 lines, 5+ phases). These
  drive the actual Next `NextRequest` through the handler and consume the
  NDJSON stream via the production `readNdjson` kernel — no shortcut
  parsers. → shape lives in the `mockAnthropicModule` +
  `makeMockTransport` helpers at `test/api/_helpers.ts:1-425`.

- **`test/api/mcp-call-allowlist.test.ts`** — a contract pin test on the
  `/api/mcp/call` allowlist guard: an allowlisted tool reaches
  `conn.mcp.callTool` (no 403), an unsanctioned name (e.g. `whoami`)
  returns 403, a non-string name returns 403. Named "contract pin" in the
  file header — the test's whole job is to make removing a tool name
  from the allowlist a compile-time forcing function.

- **`lib/data-source/synthetic-data-source.ts`** — `test/data-source/synthetic-data-source.test.ts`
  covers `listTools()` returning Bloomreach-shaped tool defs,
  `bootstrapSchema` parsing the synthetic payloads into a `WorkspaceSchema`,
  and `execute_analytics_eql` returning MCP-shaped envelopes. →
  `02-injected-datasource-fake.md`.

- **`lib/state/insights.ts` + `investigations.ts`** — session-scoped state
  maps. `insights.test.ts` explicitly tests cross-session isolation (the
  bug the refactor fixed), plus the intentional-drop contract on
  `insightToAnomaly` (evidence, impact, history, category all dropped).

- **`lib/streaming/ndjson.ts`** — `test/streaming/ndjson.test.ts:1-98`.
  Multi-line chunk emits one event per line, line split across two reads
  reassembles, trailing buffer (no terminal newline) flushed at end,
  malformed line silently skipped and reported via `onMalformed`, cancel
  cleanly stops the reader.

- **`lib/insights/derive.ts`** — pure derivation (revenue impact, diagnosis
  confidence rules, impact range/assumption). 8 cases in
  `test/insights/derive.test.ts`.

- **`lib/mcp/events.ts` codec** — `test/mcp/events.test.ts:1-81` round-trips
  every `AgentEvent` variant, asserts `encodeEvent` ends with `\n` and
  never contains an interior newline (this last is the pin that keeps
  NDJSON safe).

- **`lib/mcp/tool-coverage.ts`** — `test/mcp/tool-coverage.test.ts:1-83`.
  Cross-checks what the server exposes vs what the agents are configured
  to call; `bootstrapTools` byte-equality to the `resolveProject +
  bootstrapSchema` code path (an anchor test — if either drifts, this
  fires).

- **`lib/agents/categories.ts`** — `test/agents/categories.test.ts` walks
  the coverage table (full / limited / unavailable) against a real-world
  event set ("wobbly-ukulele"). Domain-specific but the pattern
  (capability introspection against a workspace) is well-tested.

- **`lib/agents/base-legacy.ts` `buildSynthesisInstruction`** —
  `test/agents/synthesis-instruction.test.ts` pins the assembled string
  byte-for-byte against the pre-lift inline version for each of the four
  agents. Explicit contract-pin test named as such.

### What does NOT have tests (real risk)

- **`lib/hooks/useInvestigation.ts`** — the client hook that consumes
  `/api/agent`'s NDJSON stream. **No tests.** This is gap #1 in
  `00-overview.md`. Deterministic-side finding — the hook has a scripted
  producer available (any of the test/_helpers.ts patterns work), and
  its behavior *is* exact-assertion-friendly (given event sequence → final
  state).
- **`lib/hooks/useBriefingStream.ts`** — same shape gap. Consumes
  `/api/briefing`'s NDJSON. Auto-reconnect on `invalid_token` — an
  important recovery path — is untested.
- **`lib/hooks/useReconnectPolicy.ts`** — extracted from `app/page.tsx`
  precisely because it deserved a seam. The seam exists; no tests bind to
  it yet.
- **`components/**/*.tsx`** — no component tests. All 19 tsx components
  under `components/` are exercised only in dev/prod. Low-medium risk
  for most (`SeverityBadge`, `Skeleton`, `AgentBadge` are near-trivial);
  medium risk for `EvidencePanel`, `RecommendationCard`, `ReasoningTrace`
  which have real conditional logic.
- **`lib/mcp/session.ts`** — no direct unit test. Every integration test
  mocks it, so the real implementation runs untested. Gap #2 in
  `00-overview.md`.
- **`lib/mcp/connect.ts`** — no direct unit test. Exercised indirectly by
  the API integration tests, but the `redirect_uri` host-based branching
  logic itself has no assertions.
- **`lib/export/investigationMarkdown.ts`** — no tests. Low-frequency use
  (user clicks "export ↓"), low risk.
- **`app/**/page.tsx` server components** — no tests. Thin shells; risk
  scales with how much logic each page does, and these are mostly
  data-fetch-and-render.

**Red flag: is the most important / most complex code the least tested?**
No — the load-bearing agent loops, the MCP transport ladder, and the
schema-parser boundary all have dense coverage. **But** the
`useInvestigation` hook IS complex (StrictMode-survival, sessionStorage
rehydrate, per-step trace filtering) and completely untested. Not the
worst version of this red flag, but not clean either.

---

## 2. test-design-and-levels

**Pyramid as-built vs the pyramid as-recommended.**

### The shape

```
                          Evals (probabilistic)
                             ▲
                             │  10 goldens · rubric-judged
                             │  eval/run.eval.ts
                             │  ~$0.09/case · ~15-40min/run
                             │
                     Integration (deterministic)
                             ▲
                             │  3 files, ~1400 lines
                             │  test/api/*.integration.test.ts
                             │  Mocks at 4 seams:
                             │    Anthropic SDK · DataSource · session · NDJSON
                             │
                             Unit (deterministic)
                             ▲
                             │  20+ files, ~200 tests
                             │  Pure logic + scripted agent loops
                             │  All fakes injected — no vi.mock on domain code
```

**This is the pyramid shape you want**: broad base of fast unit tests,
narrow middle of route-level integration tests hitting real handlers, and
a tiny load-bearing top layer of AI evals. No browser/e2e layer.

### The seams the integration tests mock

`test/api/_helpers.ts:24-425` documents four surfaces:

1. **Anthropic SDK** — module-scope `vi.mock('@anthropic-ai/sdk', () => mockAnthropicModule())`
   installs a real `class MockAnthropic` (needs to be `new`-able because
   the route does `new Anthropic({ apiKey })`). Tests fill a shared
   scripted queue via `setAnthropicResponses(...)` in `beforeEach`. The
   queue is shared module state — `resetAnthropicQueue()` MUST run
   between tests. → `01-scripted-anthropic-fake.md`.
2. **DataSource** — a fake `DataSource` (matches port surface: `callTool` +
   `listTools`) driven by a scenario enum (`'ok' | 'list-tools-fail' |
   'tool-call-fail' | 'timeout'`). Returns MCP-shaped envelopes with
   `{ structuredContent: {…} }`. → `02-injected-datasource-fake.md`.
3. **Session/auth** — `vi.mock('../../lib/mcp/session', …)` stubs
   `getOrCreateSessionId` + `readSessionId`; `vi.mock('../../lib/mcp/connect', …)`
   stubs `connectMcp`.
4. **NDJSON consumer** — `collectEvents(response)` reuses the production
   `readNdjson` kernel. No shortcut parser — if the parser breaks, this
   consumer breaks with it, which is the correct behavior.

**Why this is good**: the mocks live at the *outer* boundary of the app
(SDK, transport, session), not inside domain code. Tests exercise the real
`runAgentLoop`, real `bootstrapSchema`, real `deriveInsightFields`. The
mocks don't hide bugs in the code under test.

### The unit tests

**Pure logic**: `derive.test.ts`, `validate.test.ts`, `tool-coverage.test.ts`,
`schema.test.ts`, `events.test.ts`, `ndjson.test.ts`, `insights.test.ts`,
`investigations.test.ts`, `synthesis-instruction.test.ts`,
`categories.test.ts`. No mocks needed; inputs and outputs are values.

**Agent loops**: `base.test.ts`, `monitoring.test.ts`, `diagnostic.test.ts`,
`recommendation.test.ts`, `query.test.ts`. Each builds a `buildFakeAnthropic`
inline (same pattern in every file — the test files predate the shared
`mockAnthropicModule` helper, which is why five files repeat almost
identical builder functions). Each test scripts a specific model
response sequence and asserts on: tool-use args, final JSON output,
callback invocations, control-flow branches.

**Red flag check — heavy mocking that tests the mock, not the code?**
Not firing. The mocks are at the SDK boundary; the agent loop itself
runs. If the agent loop parses `tool_use` blocks wrong, tests fail. If
the loop's `maxTurns` guard is off-by-one, tests fail. Real code runs
under test.

**Red flag check — inverted pyramid?** Not firing. Almost all tests are
sub-second unit tests. The three integration test files are the middle;
they run in the same `vitest run` and finish in seconds.

### The eval subsystem sits *outside* the pyramid

`eval/**/*.eval.ts` are **excluded from `npm test`** by design — the
default `vitest.config.ts` `include` pattern only picks `test/**/*.test.ts`.
The eval runner is `vitest.eval.config.ts` with a 5-minute per-test
timeout. This partition IS the seam.

The eval subsystem itself uses vitest as its runner but ships six distinct
tools:
- `run.eval.ts` — 10 goldens through both agents + rubric judge
- `baseline.eval.ts` — build the committed pass-rate table
- `gate.eval.ts` — compare a candidate run to the baseline
- `load.eval.ts` — N × K semaphore concurrency, no judges
- `generate-worksheet.eval.ts` + `compute-agreement.eval.ts` — calibration
- `report.eval.ts` — human-readable summary

Each is `describe.skipIf(!shouldRun)`-guarded on a distinct env var
(`RUN_LOAD`, `RUN_BASELINE`, etc.), which is how one config runs six
different tools with per-package.json script.

---

## 3. tests-as-design-pressure

**Where code is testable *because* the design allowed it. Where it isn't
because the design didn't.**

### The tests you can write because the design earned them

- **`runAgentLoop(anthropic, mcp, …)`** takes both dependencies as
  parameters. That single decision is what makes every agent test
  possible — you build a `buildFakeAnthropic([…scripted responses])` and
  a `buildFakeMcp((name, args) => result)`, pass them in, and the loop
  runs against the fakes exactly as it runs against the real SDK. If
  either were a module-level `new Anthropic()` or a top-level import
  reaching for a singleton, the test file would be forced to use
  `vi.mock` on domain code, and every test would be testing the mock.

- **`DataSource` as a port**: `BloomreachDataSource`, `SyntheticDataSource`,
  and `FaultInjectingDataSource` all implement the same `DataSource`
  interface (`lib/data-source/types.ts`). The eval harness uses
  `SyntheticDataSource` (no network), unit tests use inline fake
  `DataSource` objects, load tests wrap either in `FaultInjectingDataSource`.
  Three real implementations of the same port, and swapping them requires
  zero downstream changes. → `02-injected-datasource-fake.md`.

- **Pure functions**: `deriveInsightFields`, `parseAgentJson`, `isDiagnosis`,
  `unwrap`, `parseWorkspaceSchema`, `encodeEvent`, `decodeEvent`,
  `readNdjson`. Every one of these has tests because they're pure — value
  in, value out, no environment. The test files are short and dense.

### The tests you can't write because the design didn't allow it

- **`useInvestigation.ts`** — starts a fetch inside a `useEffect`, reads
  and writes `sessionStorage`, deliberately doesn't cancel on cleanup to
  survive StrictMode's double-invoke. Testing this needs a seam that
  isn't there: a way to intercept the fetch call. Options are
  `vi.stubGlobal('fetch', …)` (works but every test is fragile to fetch
  boundaries), extracting the stream-consumption into a pure function
  taking a `ReadableStream` (the right fix — this is the deep-modules
  finding), or writing a component-integration test with
  `@testing-library/react` + MSW (the heavyweight fix). **This is a
  design-pressure finding**: the hook is hard to test because its two
  side effects (fetch, sessionStorage) share a scope with its logic.
  Cross-link to `study-software-design` for the deep-vs-shallow module
  angle — the pure stream-consumption function is the deeper module the
  hook currently swallows.

- **`app/page.tsx`** — same problem, one level up. It hosts the
  `useBriefingStream` hook and the demo/live toggle. Test surface is a
  full React tree render.

### Not a design-pressure finding but worth noting

- **Auth store `AsyncLocalStorage`** is a real module-level singleton in
  prod (`_authCookieCrypto`). Tests reset it with `_clearAuthStore()` in
  `beforeEach` — that reset export is a test-only escape hatch that
  crossed a boundary. It's the pragmatic call, but it's the sort of
  thing that hides accidental cross-test coupling if `beforeEach`
  is skipped. No case of that in the current suite.

---

## 4. determinism-isolation-and-flakiness

**Tests that pass or fail on rerun for reasons you can't control train
people to ignore red. I couldn't find any in this suite.**

### Time — controlled

Every timing test uses `vi.useFakeTimers()` and reverts with
`vi.useRealTimers()` inside the test. See:

- `test/mcp/client.test.ts:49-77` (TTL expiry, rate-limit)
- `test/mcp/client.test.ts:111-167` (parsed retry-after windows)

No `setTimeout(..., 100)` and then `await sleep(200)` — every wait is on a
timer the test drives.

### Network — none in `npm test`

Zero. Every mention of `fetch` is either `vi.stubGlobal('fetch', …)` (see
`test/mcp/transport.test.ts:19-25`) or a helper that returns a fake
Response. The Anthropic SDK is mocked at module level. The MCP
transport is mocked. The session cookie store is mocked. No test in
`npm test` opens a socket.

### Ordering — no dependencies

Every test file resets state in `beforeEach`:

- `test/api/briefing.integration.test.ts` and `agent.integration.test.ts`
  both call `resetAnthropicQueue()`, `_resetSchemaCache()`, `_clear` on the
  insights map, and — in the agent case — `_clearInvestigationCache()`.
  The comment in `agent.integration.test.ts:130-146` documents this
  explicitly: without the schema-cache reset, the second test would skip
  the bootstrap `callTool` path and every mock-call assertion would
  drift.
- `test/mcp/auth.test.ts:16-19` calls `_clearAuthStore()`.
- `test/mcp/transport.test.ts:11-13` uses `afterEach(() => vi.unstubAllGlobals())`.
- Every scripted-Anthropic file resets `idx = 0` when a new response set
  is installed (implicit — new closure per test).

### Env vars — isolated

`test/mcp/auth.test.ts` uses `vi.stubEnv('AUTH_SECRET', 'test-secret-please-ignore')`
inside individual tests. `process.env.ANTHROPIC_API_KEY = 'test-key'` is
set in `beforeEach` of the integration files. No test mutates a shared
env without a beforeEach fence.

### Shared mutable state — surfaced via reset-only exports

`_clearAuthStore()`, `_clear()` on insights, `_clearInvestigationCache()`,
`_resetSchemaCache()`, `_authCookieCrypto` — every escape hatch is
prefixed `_` and used in `beforeEach`. This is the right shape: the
production code doesn't expose these, but the test hook is right there.

### Fixture data — captured once, checked in

`test/fixtures/*.json` are real MCP responses captured from wobbly-ukulele
and committed to the repo. They don't change between runs. If the
Bloomreach server changes shape, you re-capture and re-commit — the
capture is deliberate, not automatic. → `03-captured-fixture-schema-tests.md`.

### Real numbers — no flake sources found

I searched for common flake triggers: `Math.random`, `Date.now()`,
`new Date()`, unsealed timers, real network calls, unresetted module
state. None fired against `test/**/*.test.ts`.

**Verdict on this lens: clean.** If a test in this suite goes red, it's
because the code changed, not because the moon phase did.

### The eval side is another story

`eval/run.eval.ts` runs against real Anthropic and IS non-deterministic
by nature — that's the whole point of the rubric-based approach. The
determinism there comes from a different mechanism: signal-class-gated
assertions (`has-signal` / `partial-signal` must not fail, everything
else measured) and a committed baseline (`eval/baseline.json`) that a
regression gate compares against. → `04-signal-class-gated-eval.md` and
`05-rubric-baseline-and-regression-gate.md`.

---

## 5. edge-cases-and-error-paths

**The happy path is usually tested. What about the boundaries?**

### What's well-covered

- **Rate limit ladder** (`test/mcp/client.test.ts:101-176`): retry-after
  parse from three different message shapes (`(1 per 10 second)`,
  `Retry after ~7 seconds`, no window falls back to base delay), max
  retries then give up, tool-throw wrapped as `McpToolError`.
- **Malformed JSON in NDJSON** (`test/streaming/ndjson.test.ts:49-60`):
  malformed line reported via `onMalformed` callback, subsequent lines
  still emit.
- **Empty transports return `{ tools: [] }`** (`test/mcp/client.test.ts:80-87`).
- **Error results not cached** (`test/mcp/client.test.ts:89-99`) —
  correctness-critical: a cached error would poison the workspace for
  the whole session.
- **Judge-error placeholder** (`eval/run.eval.ts:101-108`,
  `run.eval.ts:314-326`): when RubricJudge can't produce structured
  output after retries, the receipt gets a `'judge_error'` verdict
  instead of throwing, so the summary aggregation sees complete data.
- **Signal-class-aware gate** (`eval/run.eval.ts:406-424`): a fail on a
  `no-signal` case is a measured data point, not a test failure.
- **Cross-session isolation** (`test/state/insights.test.ts:53-80`): the
  bug this refactor fixed — two sessions writing concurrently must not
  overwrite each other's feed state. Test names the bug shape.
- **Intentional-drop contract** (`test/state/insights.test.ts:110-130`):
  the round-trip `insight → anomaly` drops `evidence`, `impact`, `history`,
  `category`. Five separate `it()` cases pin each drop, so the next
  person adding a field to `Anomaly` has a forcing function.
- **Diagnosis fallback on parse failure** (`test/api/agent.integration.test.ts`
  header comment 5): the diagnostic flow returns
  `{ conclusion: 'Insufficient data…' }` when the model output doesn't
  parse. Recommendation returns `[]`. Both shapes verified.
- **Cancellation on `readNdjson`** (`test/streaming/ndjson.test.ts:62-97`):
  `cancelOn: () => cancel` flips to true after the first event; the
  reader must call `cancel()` before the second read.

### What's not covered — worth naming

- **`useInvestigation` reconnect-on-`invalid_token`**: gap #1. The whole
  auth-recovery UX depends on this. Untested.
- **Empty MCP tool list at bootstrap**: `filterToolSchemas(allTools,
  monitoringAllowlist)` when the server returned zero tools. Only lightly
  covered — the "server missing a bootstrap tool" case is asserted in
  `test/mcp/tool-coverage.test.ts:52-57`, but the downstream `listTools()
  === { tools: [] }` path through the agent loop isn't specifically
  exercised.
- **Concurrent `putInsights` calls for the same session** — is there a
  race window? The test file has cross-session isolation but not
  intra-session concurrency (in-memory map, so probably fine, but not
  asserted).
- **`FaultInjectingDataSource` deterministic sequence with a fixed seed**
  — `lib/data-source/fault-injecting.ts` documents that
  `FAULT_SEED` makes the fault pattern reproducible, but I don't see
  a unit test in `test/data-source/` that pins this. The load harness
  uses it, but that's an eval, not a deterministic test. → this is a
  small `test/data-source/fault-injecting.test.ts` waiting to be
  written.

### Red flag — zero tests on error branches?

Not firing. Error branches are well-represented, especially in the MCP
ladder. What's *under*-represented is the empty-collection edge (empty
array of tools, empty array of insights, empty diagnosis with a well-
shaped fallback). Small gap, low impact.

---

## 6. testing-ai-features — the seam in practice

**This is the strongest section of the audit. The determinism seam here
isn't rhetoric — it's an architected surface.**

### The seam, drawn

```
   Deterministic harness                    Probabilistic core
   ─────────────────────                    ──────────────────

   test/agents/monitoring.test.ts           eval/run.eval.ts
     buildFakeAnthropic([...scripted])        real Anthropic client
     buildFakeMcp((name, args) => result)     SyntheticDataSource
     scripted tool_use blocks                 RubricJudge scores
     assertions: exact equality               assertions: verdict != fail
                                              per signal class
        │                                        │
        └────────────── same runAgentLoop ──────┘
                        same DataSource port
                        same JSON parse
                        same schema
```

The Anthropic SDK is the only piece that flips. Everything else — the
tool schemas, the JSON parser, the diagnosis shape validator, the
`DataSource`, the workspace schema — is identical between the
deterministic tests and the probabilistic evals. That's why an
eval-caught regression in `actionable_next_step` doesn't need a unit
test to reproduce; the offending code path is the *same* path both
harnesses drive.

### What the deterministic side pins

- **Tool-use dispatch**: every agent's scripted test asserts on the
  `tool_use` block's `name` and `input` — the exact call the model would
  make. If a prompt change causes the model to call `execute_analytics`
  instead of `execute_analytics_eql`, the eval fails but the unit test
  can pin the fake-model script that must be preserved to keep the tool
  routing correct.
- **JSON parse**: `parseAgentJson` handles fenced ```json blocks,
  unlabelled ``` blocks, bare JSON, JSON embedded in prose. Five test
  cases in `test/mcp/validate.test.ts:4-20`.
- **Shape validation**: `isDiagnosis`, `isAnomalyArray`,
  `isRecommendationArray` — the type guards. Rejects null, non-object,
  missing fields, bad enum values, non-array where array expected.
- **Synthesis-instruction byte identity**: `test/agents/synthesis-instruction.test.ts`
  pins the exact string appended when `maxToolCalls` is reached, for each
  agent. This is a *contract pin* — a rename or reshape of the closer
  string ("Do not say you need more queries.") must be deliberate.
- **`maxTurns` bailout**: `test/agents/base.test.ts` verifies the loop
  stops after `maxTurns` and returns `finalText: ''` without looping
  forever. The most important safety property of the agent loop, tested.

### What the probabilistic side pins

- **10 goldens across 4 signal classes**: has-signal (5), partial-signal
  (2), no-signal (3), positive (1). No-signal cases explicitly test
  hallucination resistance — `eval/goldens/05-no-signal-retention-subscribers.ts`
  presents an anomaly about subscription MRR against a substrate that
  has *no* subscription data, and the correct-response-shape doc says
  the agent should refuse rather than confabulate. → `04-signal-class-gated-eval.md`.
- **4-dimensional rubric per artifact**: `eval/rubrics/diagnosis-quality.ts`
  scores 1-5 on `root_cause_plausibility`, `evidence_grounding`,
  `scope_coherence`, `actionable_next_step`. Judge is Claude Sonnet 4.6
  with `temperature: 0` and `maxTokens: 4096`.
- **Judge-error resilience**: if RubricJudge's structured-output parse
  fails after retries, the receipt gets a synthetic `'judge_error'`
  verdict and the case doesn't drop out of the summary.
- **Committed baseline + regression gate**: `eval/baseline.json` is the
  per-dimension pass-rate reference; `eval/gate.eval.ts` blocks if any
  dimension regresses by more than `GATE_MAX_REGRESSION` (default 10pp).
  Signal-gated: `has-signal` and `partial-signal` MUST not fail; the
  rest are measured. → `05-rubric-baseline-and-regression-gate.md`.
- **Blind calibration**: `eval/calibration/generate-worksheet.eval.ts`
  emits a null-filled worksheet, human labels blind, then
  `compute-agreement.eval.ts` measures verdict agreement + exact-match
  dimensions + within-1 dimensions. A `labelerMode: 'pilot-ai-vs-ai'`
  vs `'human'` tag makes the pilot number honest about what it measures.
  Latest pilot: 6/6 verdict, 13/24 exact-match, 24/24 within-1.
- **Load harness**: `eval/load.eval.ts` runs N investigations at
  concurrency K via a semaphore-based worker pool, no judges, emits
  distribution stats (p50/p95/p99 per phase) and per-investigation
  cost. When `FAULT_TIMEOUT`, `FAULT_RATE_LIMIT`, etc. env vars are set,
  it wraps the DataSource with `FaultInjectingDataSource` — the same
  path that hits the retry ladder in prod. → `06-fault-injection-decorator.md`.

### The bootstrapping problem this design solves

Testing an AI feature has an obvious chicken-and-egg: the model output
is non-deterministic, so you can't assert on exact strings, but the
model output flows through code that *is* deterministic (parse, validate,
dispatch, route). This repo solves it by putting the seam **at the SDK
level, not inside the agent loop**. `runAgentLoop` takes an `Anthropic`
instance as a parameter. Tests pass a scripted fake; evals pass the real
SDK. The 90% of the code that isn't the model call gets covered by unit
tests; the 10% that is the model call gets covered by rubric evals; the
join happens at exactly one seam.

**Red flag — LLM feature with no test at the boundary?** Not firing.
Every boundary (prompt assembly → tool_use dispatch → JSON parse →
shape validation) has deterministic tests. The `synthesis-instruction`
contract pin is the most extreme version — pinning the exact string
that gets appended on the forced-final turn.

---

## 7. testing-red-flags-audit — capstone checklist

Ranked from firing hardest to not firing.

- **Firing (2):**
  - **Client hooks + components entirely untested.** `useInvestigation`,
    `useBriefingStream`, `useReconnectPolicy` — no tests. All the tsx
    components — no tests. See gap #1 in `00-overview.md`.
  - **Legacy path tested, production path not.** `test/agents/base.test.ts:4`
    and `test/agents/synthesis-instruction.test.ts:12` both import from
    `../../lib/agents/base-legacy`. The production route uses
    `lib/agents/base`. Either the two are identical (in which case
    swap the imports) or they're not (in which case the tests are
    pinning the wrong thing). This is gap #3 in `00-overview.md`.

- **Not firing:**
  - **Heavy mocking that tests the mock, not the code.** Mocks live at
    the SDK/transport/session boundary, not inside domain code.
  - **Inverted pyramid.** No e2e, three integration tests, dozens of
    unit tests. Correct shape.
  - **Test that passes/fails on rerun with no code change.** No source
    of non-determinism found in `test/**/*.test.ts`.
  - **Tests that must run in a specific order.** Every file resets
    state in `beforeEach`. Vitest runs files in parallel by default; no
    intra-file order dependencies observed.
  - **Zero tests on error branches.** Error branches are dense — see
    lens 5.
  - **A test that needs elaborate setup to reach the code.**
    Integration tests need module-level `vi.mock` + `beforeEach`
    reset, but the setup is factored into `test/api/_helpers.ts` and
    reused. Unit tests need almost nothing.
  - **Prompt assembly, tool dispatch, output parsing untested.** All
    three are tested at the deterministic boundary; the rubric evals
    catch the model side.
  - **Global mutable state that tests don't reset.** Every module with
    state exports a `_clear*` reset used in `beforeEach`.
  - **Time-dependent test using real setTimeout.** All timing goes
    through `vi.useFakeTimers()`.
  - **Fixture data that drifts.** Fixtures are captured once and
    committed. Re-capture is deliberate.

---

## Cross-links out of this audit

- **Deep-vs-shallow modules and hard-to-test as a design smell** —
  cross-link to `study-software-design`. The `useInvestigation` hook and
  `app/page.tsx` are the concrete anchors. The hook mixes stream
  consumption (pure), sessionStorage rehydration (impure but easy to
  substitute), and React lifecycle glue (hard to test). Splitting them
  is a design finding, not a testing finding.
- **Eval subsystem internals** — cross-link to `study-ai-engineering`.
  The rubric definitions, the `@aptkit/core` LLM-as-judge mechanics, the
  calibration protocol design — all belong there. This audit only names
  the deterministic wrapper: how the goldens are loaded, how the
  baseline is written, how the regression gate compares two runs.
