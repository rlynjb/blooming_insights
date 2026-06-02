# Testing & Correctness — audit

> **Verdict-first.** Strong where it matters most: 169 vitest tests across 18 files concentrate on the `lib/` plumbing — parsers, type guards, codecs, the agent loop's control flow — and the patterns there are sharp. The strongest pattern is the **scripted-Anthropic harness** (31 tests across 5 agent files): a fake `messages.create` returning a queued list of responses, the real agent code running end-to-end against it. The load-bearing gap is the **integration boundary** — `app/api/agent/route.ts` (NDJSON stream, 300s budget, intent dispatch), `app/api/briefing/route.ts`, and `lib/mcp/connect.ts` (OAuth orchestration) have zero tests; every wire between tested lib pieces is unverified. Highest-priority finding: extract `runInvestigation(deps)` from the route handler and reuse the scripted-Anthropic pattern one layer up — one afternoon for the biggest leverage move in the suite. The eval gap (no goldset, no judge, no offline runner against the live model) is real but lives next door at `study-ai-engineering/05-evals-and-observability/`; here it's named as Case B and left there.

## what-is-tested-and-what-isnt

169 tests cluster in `lib/`. The risk map by directory:

```
lib/mcp/        96 tests / 8 files   parsers, codecs, type guards, retry ladder
lib/agents/     53 tests / 8 files   loop control + per-agent (Mon, Diag, Rec, Q)
lib/state/       9 tests / 2 files   in-memory store round-trips
lib/insights/   11 tests / 1 file    derived-field calculators

  app/api/*      0 tests              NDJSON stream, 300s budget, OAuth callback
  components/    0 tests              React UI
  app/*/page.tsx 0 tests
```

The top files by test count: `validate.ts` (25), `schema.ts` (24), `client.ts` (14), `auth.ts` (14), `categories.ts` (12), `derive.ts` (11), `monitoring.ts` (10), `base.ts` (8). Three named gaps:

- **Gap A (real)** — the routes. `app/api/agent/route.ts` orchestrates intent → cache → diagnostic agent → recommendation agent → NDJSON stream with a 300s `maxDuration`. Every piece in isolation has tests; the wiring does not.
- **Gap B (real, security-relevant)** — `lib/mcp/connect.ts` orchestrates the OAuth handshake (DCR → PKCE → token exchange) and `lib/mcp/session.ts` derives the cookie-backed sessionId. Zero tests on either; a regression would silently break auth.
- **Gap C (acceptable for scope)** — components/ and app/page.tsx have zero tests. `vitest.config.ts` is `environment: 'node'` with no `@testing-library/react` dep. UI is mostly read-only rendering of well-typed lib outputs.

`vitest.config.ts` line 7 has `passWithNoTests: true`, which converts silent gaps into not-gaps from CI's perspective — a new untested lib file does not register.

→ see `01-scripted-anthropic-harness.md` for the load-bearing pattern that makes the agent layer testable
→ see `02-fixture-driven-schema-parser.md` for why `schema.ts` has 24 tests against real captured payloads

## test-design-and-levels

The pyramid as-built: wide unit base, one strong middle layer, empty top. ~138 pure-unit tests (single function, single assertion), 31 scripted-Anthropic tests (real agent code with faked SDK + faked MCP — closer to integration than unit), zero route-level integration tests, zero e2e tests. No Playwright, no `test/api/` directory.

The interesting design choice is where the scripted-Anthropic pattern sits — it's the *integration sweet spot* for AI features. The real `runAgentLoop` runs end-to-end with multi-turn dispatch, message-history accumulation, type-guard fallback, synthesis fallback. Only the Anthropic SDK and the `McpCaller` interface are faked. That's an integration test for non-deterministic code, deliberately collapsed back to determinism.

The pyramid's missing band is **route-level integration**: a test that imports `GET` from `app/api/agent/route.ts`, constructs a `NextRequest`, fakes Anthropic + MCP at the module seam, awaits the response, reads the NDJSON stream, asserts on event order + the `done` sentinel. Not exotic — every primitive needed exists (the `vi.mock` of `@anthropic-ai/sdk` already works one layer down). Just not built.

→ see `01-scripted-anthropic-harness.md` for the harness mechanics
→ see `02-fixture-driven-schema-parser.md` for the fixture-driven unit level (Level 2)

## tests-as-design-pressure

Where the lib layer has explicit seams, it has tests. Where the route layer hides its dependencies behind module-top imports, it does not.

The seam ladder, top to bottom:

- **parameter injection** — `parseAgentJson(text)`, `isDiagnosis(v)`, every type guard. Trivially testable.
- **constructor injection** — `new McpClient(transport, opts)`, `new DiagnosticAgent(anthropic, mcp, schema, toolDefs)`. Pass any fake.
- **options-bag injection** — `runAgentLoop({ anthropic, mcp, … })`. Pass fakes in a record.
- **test-only `_` exports** — `_clearAuthStore`, `_authCookieCrypto.{encrypt,decrypt}`. Controlled leak of internals via an underscore convention. Used by `auth.test.ts` to reset module state in `beforeEach` and to reach the production AES-256-GCM round-trip without spinning a Next request context.
- **THE FLIP — module-level import (no DI)** — `app/api/agent/route.ts` imports `Anthropic` and `connectMcp` at the module top. No parameter, no constructor, no options bag. To substitute you must `vi.mock` the import, which works but nobody has done it.
- **framework-implicit (next/headers)** — `lib/mcp/session.ts` and parts of `lib/mcp/auth.ts` read `cookies()` from `next/headers`. Reachable only inside a Next request context.

The design pressure was applied to `lib/`. It was not applied to the route layer. The lib has 169 tests; the routes have zero. Same finding, two vantages.

The clean fix for the route is mechanical: extract `runInvestigation(deps: { anthropic, mcp, … })` as a pure function, leave the `GET` handler as a 5-line wrapper that wires deps and calls it. The same scripted-Anthropic pattern then works one layer up.

→ see `01-scripted-anthropic-harness.md` for how the `McpCaller` seam pays off

## determinism-isolation-and-flakiness

One flake of record, fixed, and the fix is the canonical post-mortem story for this repo.

Sources of non-determinism, all handled:

- **time** — `vi.useFakeTimers()` + `vi.advanceTimersByTime` in every TTL/retry test (`client.test.ts` lines 50, 78, 111–167). The rate-limit retry tests advance fake time past Bloomreach's 10s window without actually waiting.
- **process.env** — `vi.stubEnv` / `vi.unstubAllEnvs` in `auth.test.ts` lines 117–122. THIS IS the AUTH_SECRET fix from commit `e83a8e0`. Before: direct `process.env.AUTH_SECRET = …` in `beforeEach` with no afterEach; the var leaked across parallel workers because a vitest worker process is reused across files, and `process.env` is a single object inside that process. The crypto test failed ~1 in N runs and passed in isolation. After: tracked stubbing that vitest restores on every test exit. 169 tests across repeated runs, clean.
- **global fetch** — `vi.stubGlobal('fetch', …)` + `vi.unstubAllGlobals()` in `transport.test.ts`.
- **module-scoped in-memory state** — `_clearAuthStore()`, `_clear()` on the insight cache, `_clearInvestigationCache()` all called in `beforeEach` on the respective test files.
- **network** — faked at every boundary. No test in the suite makes a real HTTP call.
- **filesystem** — read-only access to committed fixtures.

Known-but-not-enforced: there's no ESLint rule banning direct `process.env.X = …` in `test/**/*.ts`. The same flake class could land in a future test file and nothing would catch it.

→ see `03-vi-stubenv-isolation.md` for the full post-mortem walkthrough

## edge-cases-and-error-paths

Strong on type-guard rejection (~12 of 25 `validate.test.ts` tests are isolated-gate rejections), the retry ladder (5 of 14 `client.test.ts` tests), and the parser robustness block (4 of 24 `schema.test.ts` tests cover empty events, missing `event_types_overview`, missing `default_group.properties`, text-only fallback).

The pattern that earns its own file: **acceptance + per-gate rejection** — for every gate in a type guard, one acceptance test (positive control) plus one isolated-gate rejection test (every other field valid via spread, only the gate-under-test broken). 25 tests in `validate.test.ts` follow this discipline. The dual-shape `estimatedImpact` coverage (legacy `string` AND rich `{ range, … }` object, with rejection when object is missing `range`) is the canonical case.

The weak spot: **no test scripts a throw from `anthropic.messages.create`**. Every scripted-Anthropic fake returns a response. If the SDK throws (network blip, 401, model-side 429), the agent's behaviour is undefined-by-test — likely an uncaught exception bubbling to the route, which 500s. The `mcp.callTool` throw path is tested (`base.test.ts` lines 182–214); the Anthropic throw path is not. Asymmetry.

Other gaps under this lens, all named-not-fixed:

- NDJSON stream truncated mid-flight (client disconnects) — 0 tests (also: no NDJSON stream tests at all).
- Concurrent investigations on the same insight (race) — 0 tests.
- OAuth callback with mismatched state — `consumeState` itself is tested (`auth.test.ts`), but no end-to-end callback test asserts the rejection fails the flow.

→ see `04-acceptance-plus-per-gate-rejection.md` for the rejection-coverage discipline

## testing-ai-features

This is a 100%-AI product — every investigation runs Claude + MCP — and the deterministic-vs-eval seam is the most important framing in the audit.

**What IS tested deterministically (the wrapper):** prompt assembly (`schemaSummary`, 10 tests), tool dispatch (`base.test.ts`, 8 tests), message accumulation, output parsing (`parseAgentJson`, 5 tests), output validation (`isDiagnosis` etc., 25 tests), synthesis fallback (`diagnostic.test.ts` lines 273–291; `recommendation.test.ts`). Every test in `test/agents/*.test.ts` injects a scripted Anthropic response and runs the real agent against it. The scripted-Anthropic pattern is this repo's high-water mark for AI-feature testing.

**What is NOT tested (the core):** quality. Whether the diagnosis is correct, whether prompt v2 regressed against prompt v1, whether the recommendation is actually useful — none of these are deterministic and none have a Vitest answer. 169 green tests prove the *wrapper* works; they say nothing about model output quality. Every prompt edit and model swap ships with zero quality measurement.

This is **Case B** — the eval substrate is partially built (the NDJSON trace and `durationMs` spans persist via `lib/state/investigations.ts`, replayable via `getCachedInvestigation`), but the goldset + runner + judge are not built. The buildable target — `evals/` at the repo root with `golden/`, `adversarial/`, `regression/`, `rubrics/`, `runner.ts` — is named at `.aipe/study-ai-engineering/05-evals-and-observability/`. This lens names the gap; the deep walk lives next door.

The bridge between the two halves is **trace replay**: the NDJSON event stream is already a span sequence (`tool_call_start { toolName, agent }` → `tool_call_end { durationMs, result?, error? }`), and the trace replayed with a changed prompt against the live model IS the eval harness. That's the seam where testing hands off to evals.

→ see `01-scripted-anthropic-harness.md` for the deterministic-wrapper layer
→ (external) `.aipe/study-ai-engineering/05-evals-and-observability/` for the eval-half write-up

## testing-red-flags-audit

Eleven flags marked against this repo:

```
flag                                          status   evidence
────                                          ──────   ────────
 1  missing critical-path tests               ✗ present  no test/api/, no test/mcp/connect.test.ts
 2  hard-to-test code (design smell)          ✓ clean    McpCaller + McpTransport + options-bag DI
 3  flakes accepted                           ✓ clean    one fixed via vi.stubEnv (e83a8e0)
 4  time / order dependence                   ✓ clean    vi.useFakeTimers + _clear() helpers
 5  over-mocking (test the mock, not code)    ✓ clean    scripted-Anthropic runs real agent
 6  mock things you don't own                 ✓ clean    McpTransport wraps the MCP SDK
 7  no contract test on external              ✗ present  fixtures from 2026-05 never re-validated
 8  no lint guard on env mutation             △ partial  no ESLint rule banning direct process.env.X =
 9  passWithNoTests masks gaps                △ partial  vitest.config.ts line 7 + no coverage gate
10  no end-to-end smoke                       ✗ present  no Playwright, no NDJSON-stream test
11  test code drift / dead helpers            ✓ clean    minimal helpers, no drift
AI  no quality eval (Case B)                  ✗ present  no evals/ directory; see file 06 + sibling guide
```

Tally: **5 clean, 2 partial, 5 present (including the AI eval gap).** The five present flags cluster around a single shape: **the integration boundary is undertested**. Route layer (flag 1), external MCP contract (flag 7), end-to-end NDJSON stream (flag 10), and the AI quality boundary (eval gap) are all variations on "units are tested, seams aren't." That's the audit's load-bearing finding.

The closest existing step toward flag 7: `test/mcp/tool-coverage.test.ts` (lines 70–82) hardcodes the bootstrap tool list and cross-checks it against the registry — a static contract assertion. It would graduate to a real contract test if it were run against the live MCP server's `listTools()` at CI time.

## Top 3 ranked findings

1. **Route handler has zero tests** — `app/api/agent/route.ts` orchestrates the highest-value flow (intent → cache → diagnostic → recommendation → NDJSON stream → done sentinel) with a 300s `maxDuration` budget. Fix shape: extract `runInvestigation(deps: { anthropic, mcp, … })` as a pure function (a one-afternoon refactor), then apply the same scripted-Anthropic pattern that `base.test.ts` uses today, one layer up. Closes flag 1 and flag 10 simultaneously.

2. **No contract test against the live MCP shape** — `test/fixtures/*.json` were captured on 2026-05; if Bloomreach renames `events` to `event_definitions` tomorrow, all 24 `schema.test.ts` tests still pass against the stale fixtures while production breaks. Fix shape: a CI job that fetches a fresh fixture from the real MCP server and shape-diffs against the committed one (existing `tool-coverage.test.ts` lines 70–82 hardcodes the bootstrap tool list — graduate that to a live `listTools()` check).

3. **No quality eval against the live model (Case B)** — `test/agents/*.test.ts` line 273–291 (`diagnostic.test.ts`) — every scripted-Anthropic test asserts the wrapper extracted the test author's pre-written JSON, not that the real model's output is correct. 169 green tests, zero quality signal. Fix shape: a `evals/` directory with `golden/` (20–50 hand-curated anomaly → expected diagnosis-class cases), `runner.ts` (replay against the live agent, score via rubric / LLM judge), and a regression set that grows over time. Pointer: `.aipe/study-ai-engineering/05-evals-and-observability/`. Not a unit-test gap — the seam where testing hands off to evals.
