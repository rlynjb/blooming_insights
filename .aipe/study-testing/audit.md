# audit.md — the 7-lens testing audit
*Pass 1 of the two-pass output. Each lens is walked against this repo with `file:line` grounding or honest `not yet exercised`. Significant patterns cross-link into Pass 2 files.*

The suite: `npm test` → vitest → 24 files, 221 tests, all passing. Node
environment, `test/**/*.test.ts` include glob. See `vitest.config.ts:6-14`
and `package.json:25`.

---

## 1. what-is-tested-and-what-isnt — the risk map

Not a coverage percentage. The **risk** map.

```
  layer                     tests?              the honest read
  ─────────────────────     ───────────────     ──────────────────────────
  React components          ZERO                no .test.tsx anywhere;
  (components/**)                               UI verified by eye
  Next.js routes            integration only    briefing + agent routes
  (app/api/**)              (mocked SDK + DS)   covered; mcp/* routes
                                                largely unaudited
  Agent loops               TDD'd with fakes    base-legacy.runAgentLoop
  (lib/agents)              (8 it() in          control flow fully tested
                            base.test.ts)
  MCP client + transport    deep unit           cache, ttl, rate-limit,
  (lib/mcp/client.ts,                           retry, timeout, error
   lib/mcp/transport.ts)                        enrichment all asserted
  Auth (OAuth + cookies)    deep unit           token round-trip, PKCE,
  (lib/mcp/auth.ts)                             state CSRF, AES-256-GCM
                                                cookie crypto
  Schema parsing            fixture-driven      see lens 2 deep walk +
  (lib/mcp/schema.ts)                           Pass 2 file 02
  Validators                acceptance + per-   see lens 5 + Pass 2
  (lib/agents/                gate rejection    file 04
   legacy-validate.ts)
  Streaming framing         deep unit           NDJSON parse,
  (lib/streaming/                               reassembly, cancellation
   ndjson.ts)
  Insight derivation        unit                derive.test.ts (11 it())
  (lib/insights/derive.ts)
  Data source adapters      unit                SyntheticDataSource +
  (lib/data-source)                             makeDataSource factory
```

**The red flag check:** is the most-important / most-complex code the
least tested?

Mostly no. The agent loop (the trickiest control flow in the repo) has
the deepest unit coverage. The Bloomreach data envelope (the most
brittle integration point) is pinned by eight captured fixtures. The
auth round-trip (the load-bearing security primitive) has its own
isolated env-stubbing dance.

The honest miss: **components are 100% untested.** That's a deliberate
choice for a one-engineer app in active visual flux — every component
test today would be rewritten next week — but it's a real risk. A wiring
regression in `StatusLog` or `EvidencePanel` ships without a red.

---

## 2. test-design-and-levels — the pyramid as built

```
  pyramid as-built — measured by it() count

         ┌──────────────────┐
         │   integration    │   17 it() across briefing + agent routes
         │   (mocked SDK)   │   (test/api/*.integration.test.ts)
       ┌─┴──────────────────┴─┐
       │                      │
       │       unit           │   204 it() across agents, mcp, state,
       │   (faked seams)      │   insights, streaming, data-source
       └──────────────────────┘   (test/{agents,mcp,state,insights,
                                   streaming,data-source}/*)

         no e2e tier (intentional — no browser driver in the project)
```

The shape is right-side-up: unit-heavy, integration-thin, no e2e.

**Where mocking earns its keep — and where it could rot.** The shared
helpers in `test/api/_helpers.ts:68-84` build a class-shaped Anthropic
mock that satisfies `new Anthropic(...)` (the route does it inside the
handler, so a `vi.fn()` factory fails — needs a real class). The mock
queue (`anthropicQueue`) is module-shared state, hand-cycled by
`resetAnthropicQueue()` in every `beforeEach`. Brittle? A little — a
test that forgets the reset poisons the next one — but it's the
cheapest way to drive multi-turn flows through a route that constructs
its own client.

**The smell to watch:** integration tests that mock the MCP transport
ALSO mock the data source factory (`vi.mock('../../lib/data-source')`)
to remap onto the same `currentMcp` state — see
`test/api/briefing.integration.test.ts:66-87`. Two mocks pointing at one
state machine works, but if a third seam gets added (a `makeBriefing`
factory, say) the indirection will start to bend. Flag it; don't fix it
yet.

→ see `01-scripted-anthropic-harness.md` for the injected-fakes pattern deep walk.

---

## 3. tests-as-design-pressure — what the testability tells you about the design

The agent classes (`MonitoringAgent`, `DiagnosticAgent`,
`RecommendationAgent`) take their dependencies via constructor:

```ts
// lib/agents/monitoring.ts:73-80
export class MonitoringAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}
```

This is constructor injection, and the tests prove it works: tests pass
plain-object fakes for `anthropic` and `dataSource` (see
`test/agents/base.test.ts:51-83`) — no global state, no module-level
singletons to reset, no `jest.mock` gymnastics inside the agent itself.
The `McpCaller` type (`lib/agents/base.ts:14`) is deliberately narrowed
to `Pick<DataSource, 'callTool'>` — the agent only needs the one method,
so the fake only has to implement one method.

**This is the design lesson the testability surfaces.** Where the
boundary is sharp, the test is cheap. Where it's blurry, the test pays
in setup.

Counter-example: the route handlers construct their own
`new Anthropic({ apiKey })` inside the handler body. That's why the
integration tests have to use a module-level `vi.mock('@anthropic-ai/sdk',
...)` with a class shim. The mock works, but it's a sign the route
itself is mildly testability-hostile — passing an `Anthropic` instance
in via a function parameter would make the integration test as simple
as the unit test. Today's tradeoff (route owns the client construction)
is fine; the test cost is real and worth naming.

Deep deep modules vs shallow tests is the `study-software-design` lens
— don't restate it here.

---

## 4. determinism-isolation-and-flakiness

```
  isolation discipline                where it lives
  ───────────────────────────         ──────────────────────────────────
  vi.useFakeTimers / advance          test/mcp/client.test.ts:49-58
    (cache ttl, rate limit)           test/mcp/client.test.ts:60-92
  vi.stubEnv + unstubAllEnvs          test/mcp/auth.test.ts:117-122
    (per-test env vars)               (the AUTH_SECRET cookie crypto block)
  vi.stubGlobal('fetch', ...)         test/mcp/transport.test.ts:19-25
    + vi.unstubAllGlobals in          test/mcp/transport.test.ts:11-13
    afterEach                         (capturing-fetch tests)
  module-scope mocks reset            test/api/_helpers.ts:52-55
    per-test (anthropicQueue,         test/api/*.integration.test.ts
    currentMcp, currentConn,          beforeEach blocks
    currentSessionId)
  schema cache reset                  test/api/briefing.integration.test.ts:97
    (_resetSchemaCache)               (bootstrapSchema memoizes — without
                                       this, test 2 skips its own bootstrap)
  insights map clear                  test/api/*.integration.test.ts
    (_clear)                          beforeEach
```

**No flaky tests observed.** Three rounds of `npm test` all green in
~6.3s. Suite is fast enough to run on every save.

The thing the discipline DOESN'T catch: a test that leaks
`process.env.ANTHROPIC_API_KEY` (set directly in both integration test
beforeEach blocks at `briefing.integration.test.ts:112` and
`agent.integration.test.ts:146`). If a future test inspects that env var
without expecting it to be set, it'll surprise. Fix is the same pattern
as auth.test.ts — use `vi.stubEnv` + `vi.unstubAllEnvs`.

→ see `03-vi-stubenv-isolation.md` for the env-isolation pattern deep walk.

---

## 5. edge-cases-and-error-paths

The validators (`lib/agents/legacy-validate.ts`) are the clearest case
of edge-case discipline in the suite. Every type guard pairs one
"well-formed accepts" assertion with **one rejection per field**:

```
  isAnomalyArray (6 it() in test/mcp/validate.test.ts)
    ✓ accepts a well-formed anomaly array
    ✓ accepts an empty array
    ✗ rejects a non-array
    ✗ rejects a missing-field object
    ✗ rejects a bad severity ("huge")
    ✗ rejects a bad direction ("sideways")

  isRecommendationArray (8 it()) — same shape: per-field rejection
    of every enum (bloomreachFeature, confidence) and every required
    field (title, rationale, steps, estimatedImpact, …)
```

This is the right discipline for a JSON-from-LLM seam. The LLM will
produce malformed output eventually; the guard's job is to refuse it
loudly, and the test's job is to prove that refusal is per-field, not
overall.

**Error-path coverage on the agent loop:** `base.test.ts:182-214` proves
the loop **records** a tool error as an `is_error: true` block and
**continues** to the next turn, where the LLM can recover. That's the
load-bearing failure-mode contract for the whole agent system — and
it's tested directly.

**Error-path coverage on the routes:** four error scenarios in
`briefing.integration.test.ts` — 401 unauthed
(`briefing.integration.test.ts:203-222`), listTools throws
(`230-265`), Anthropic SDK throws mid-scan (`275-300`), client cancel
(`312-345`). Each one asserts the exact error event shape the UI's
NDJSON consumer parses.

The honest miss: the 6 mcp callback / reset / call routes in
`app/api/mcp/**` are not exercised by integration tests. The auth
provider is unit-tested; the routes that wire it together are not.

→ see `04-acceptance-with-per-gate-rejection.md` for the validator pattern deep walk.

---

## 6. testing-ai-features — the deterministic harness around a probabilistic core

This is where the seam lives — the most important lens in the audit for
this repo specifically.

**What IS tested at the AI boundary (deterministic):**

```
  layer                              tested?     how
  ───────────────────────            ────        ─────────────────────
  prompt assembly                    NO          no test reads a prompt
  (lib/agents/legacy-prompts/*.md)               file and asserts shape
  tool schema filtering              YES         test/agents/tool-schemas.test.ts
  (lib/agents/tool-schemas.ts)                   (3 it())
  tool dispatch (model says          YES         test/agents/base.test.ts
   "call this tool" → loop                       (it #1: tool then text)
   actually calls it)
  budget enforcement                 YES         test/agents/base.test.ts
   (maxTurns + maxToolCalls)                     (it #4 + #5)
  forced-synthesis turn              YES         test/agents/base.test.ts
   (omit tools + append                          (it #8: synthesisInstruction)
    synthesis instruction)
  output parsing                     YES         test/mcp/validate.test.ts
   (parseAgentJson, isAnomalyArray,              (25 it() — every guard
    isDiagnosis, isRecommendationArray)           with per-field rejection)
  schema-from-MCP                    YES         test/mcp/schema.test.ts
   (parseWorkspaceSchema)                        (24 it() — fixtures from
                                                  the real server)
  category coverage gate             YES         test/mcp/tool-coverage.test.ts
   (which monitoring categories                  (8 it())
    have the tools they need?)
```

**What is NOT tested at the AI boundary (probabilistic):**

```
  the model's actual output quality        NO eval harness today
    → does the diagnosis correctly         no eval set
       identify the cause?                 no LLM-as-judge
    → does the recommendation actually     no regression gate on
       fit the anomaly?                     output drift
    → does the monitoring agent surface
       the RIGHT anomalies (not just
       parseable ones)?
```

The agent's NDJSON trace (`AgentEvent` stream in `lib/mcp/events.ts`) is
the inspectable trajectory — every reasoning step, tool call, and tool
result is captured. Humans read it. No harness scores it. The trace is
**testable** (the stream contract is unit-tested at
`test/streaming/ndjson.test.ts`); the **content** of the trace is not
evaluated.

**The Phase 3 narrative — Case B framing.** An automated eval pipeline
**did exist**: four-pillar harness (gold dataset + LLM-as-judge calibrated
by K=10 manual spot-checks + category coverage gate + a BRL-currency
sentinel that caught a rounding bug before merge), built against the
Olist e-commerce substrate that lived in the `mcp-server-olist`
sibling repo. PR #8 on 2026-06-18 removed that substrate; the eval
pipeline was retired with it. The pattern is real; the substrate is
gone. Honest claim today: "I shipped and ran a four-pillar eval. I
retired it deliberately when the substrate changed." Dishonest claim:
"the repo has evals." It doesn't.

→ see `05-llm-as-judge-as-testing.md` for why LLM-as-judge is testing
and `06-eval-flywheel.md` for the retired four-pillar walk.

---

## 7. testing-red-flags-audit — consolidated checklist

```
  red flag                                       this repo
  ───────────────────────────────────            ─────────────────────
  most important / most complex code is the     NO (agent loop is the
   least tested                                  most-tested code)
  heavy mocking that tests the mock              MOSTLY NO; the
   not the code                                  Anthropic shim is
                                                  a real class with
                                                  scripted output —
                                                  the loop's control
                                                  flow is what's
                                                  asserted, not the
                                                  mock's internals
  an inverted pyramid (all e2e, slow, flaky)    NO (no e2e tier)
  tests that pass/fail on rerun                  NOT OBSERVED (3 runs,
                                                  all green, ~6s)
  tests that must run in a specific order        NO (every test
                                                  initializes its own
                                                  fixtures in
                                                  beforeEach)
  zero tests on error / exception branches       PARTIAL — agent loop
                                                  error path tested;
                                                  route error paths
                                                  tested; mcp/* routes
                                                  not
  a test that needs elaborate setup to reach     ONE candidate — the
   the code                                       integration tests'
                                                  triple-mock (Anthropic
                                                  + connect + data-source)
                                                  for the route handler.
                                                  Real, justified, but
                                                  noisy. See lens 3.
  an LLM feature with no test at the boundary    NO at the wrapper
   (prompt assembly, tool dispatch, parsing)     (tool dispatch + parse
                                                  + schema are all
                                                  tested);
                                                  YES at the prompt
                                                  itself (prompt files
                                                  are not asserted on)
  no automated check that the model OUTPUT       YES, currently —
   doesn't regress                                acknowledged gap;
                                                  shipped-and-retired
                                                  narrative documented
                                                  in lens 6 + Pass 2
                                                  files 05 + 06
  zero component tests                           YES — deliberate, but
                                                  the cost lands the
                                                  day a wiring
                                                  regression ships
```

**Verdict:** the suite is well-designed for what it covers and honest
about what it doesn't. The single biggest leverage move is adding back
an LLM eval (the pattern is on the résumé; the implementation is gone)
— and naming it as "the next thing" rather than pretending it exists is
the move that holds up under interview pressure.
