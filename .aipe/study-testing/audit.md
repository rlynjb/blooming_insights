# Testing & Correctness — audit

> **Verdict-first.** One pillar now. **The deterministic suite (`npm test`):** 221 vitest tests across 24 files. `lib/` plumbing (parsers, type guards, codecs) is still sharp, the Phase 2 swap's route-level integration tests still ship (`test/api/*.integration.test.ts`, 20 tests), and the `DataSource` seam survives — now exercised through `test/data-source/synthetic-data-source.test.ts` (5 tests) against the in-process `SyntheticDataSource` instead of the deleted Olist subprocess. The strongest deterministic pattern is still the **scripted-Anthropic harness** (31 tests across 5 agent files): a fake `messages.create` returning a queued list of responses, the real agent code running end-to-end against it. **The Phase 3 eval suite that was Pillar 2 in the previous revision is gone.** PR #8 (commit 62c24d7) deleted the entire `eval/` directory (~75 files: detection / diagnosis / recommendation / regression scripts, the LLM-as-judge harness, the K=10 calibration discipline, the committed result paper trail), the `mcp-server-olist/` package (43 server-side tests), and `olist.integration.test.ts` (161 LOC). The four portfolio numbers from that era — detection 37%/33%, diagnosis 53.3%, recommendation 100%, regression 30% — are no longer measurable in this repo. Files `05-llm-eval-as-testing.md` and `06-eval-flywheel.md` are preserved as RETIRED historical record. **The trade-off worth naming** is still here: `lib/mcp/client.ts` is a 17-line backwards-compat shim re-exporting `BloomreachDataSource` as `McpClient` to avoid renaming 16 test-file imports — test-rewrite cost is a real engineering input, not an afterthought.

## what-is-tested-and-what-isnt

221 tests across 24 files; all in the main repo. The risk map by directory:

```
MAIN REPO (vitest include: test/**/*.test.ts)
lib/mcp/         107 tests / 7 files   parsers, codecs, type guards, retry ladder
lib/agents/       57 tests / 9 files   loop control + per-agent (D/R/M/Q/I) +
                                       categories + intent + synthesis-instruction
                                       + tool-schemas
test/api/         20 tests / 3 files   NDJSON route integration (agent + briefing)
                                       + mcp-call-allowlist contract
test/state/       16 tests / 2 files   insights cache + investigation cache
test/insights/    11 tests / 1 file    derived-field calculators
test/data-source/  5 tests / 1 file    SyntheticDataSource through the
                                       DataSource interface
test/streaming/    5 tests / 1 file    NDJSON encode/decode round-trips

  components/    0 tests              React UI (unchanged)
  app/*/page.tsx 0 tests              page components (unchanged)
```

The top files by test count: `validate.ts` (25), `schema.ts` (24), `transport.ts` (15), `client.ts` (14), `auth.ts` (14), `categories.ts` (12), `insights.test.ts` (12), `derive.ts` (11), `monitoring.ts` (10), `agent.integration.test.ts` (10). **Three gaps from the original audit, with their current status:**

- **Gap A (CLOSED)** — the routes. `test/api/agent.integration.test.ts` (10 tests) and `test/api/briefing.integration.test.ts` (7 tests) construct a `NextRequest`, invoke `GET`/`POST`, and assert on the NDJSON stream's event order. The Phase 2 data-source extraction made this possible — the agent's MCP dependency is now a `DataSource` fake at the seam.
- **Gap B (still open)** — `lib/mcp/connect.ts` orchestrates the OAuth handshake (DCR → PKCE → token exchange) and `lib/mcp/session.ts` derives the cookie-backed sessionId. Zero tests on either; a regression would silently break auth.
- **Gap C (still acceptable for scope)** — `components/` and `app/*/page.tsx` have zero tests. `vitest.config.ts` is `environment: 'node'`; no `@testing-library/react`. UI is mostly read-only rendering of well-typed lib outputs.

`vitest.config.ts` line 11 still has `passWithNoTests: true`, which converts silent gaps into not-gaps from CI's perspective. The risk hasn't changed.

→ see `01-scripted-anthropic-harness.md` for the load-bearing pattern that makes the agent layer testable
→ see `02-fixture-driven-schema-parser.md` for why `schema.ts` has 24 tests against real captured payloads

## test-design-and-levels

The pyramid as-built: wide unit base, one strong middle layer, plus a route-level integration band added in the Phase 2 swap. ~165 pure-unit tests (single function, single assertion), 31 scripted-Anthropic tests (real agent code with faked SDK + faked DataSource — closer to integration than unit), **20 route-level integration tests**, **5 DataSource integration tests through the in-process `SyntheticDataSource`**. No Playwright, no browser-level e2e — still the missing top band.

```
The four levels (deterministic suite)

  ▲  Level 4 — e2e/ Playwright (still missing — explicit gap)
  │  Level 3 — test/api/ integration (20 tests)
  │                + test/data-source/synthetic-data-source.test.ts (5 tests)
  │  Level 2 — agent tests via scripted-Anthropic + fake DataSource
  │                (31 tests across 5 files)
  │  Level 1 — pure unit tests (~165)
```

The interesting design choice is where the scripted-Anthropic pattern sits — it's the *integration sweet spot* for AI features. The real `runAgentLoop` runs end-to-end with multi-turn dispatch, message-history accumulation, type-guard fallback, synthesis fallback. Only the Anthropic SDK and the `DataSource` interface are faked. That's an integration test for non-deterministic code, deliberately collapsed back to determinism.

The pyramid's previously-missing middle band — route-level integration — was **closed by Phase 2**. `test/api/agent.integration.test.ts` constructs a `NextRequest`, injects fakes at the DataSource seam, awaits the response, reads the NDJSON stream, asserts on event order + the `done` sentinel. Phase 2's split of `lib/data-source/` made this possible by extracting the dependency at the right boundary.

Still missing at the top: **browser-level e2e** (Playwright clicking through the demo path and asserting the UI renders the diagnosis/recommendation correctly). With the Phase 3 eval suite removed, there is also no longer any in-repo measurement of model-output quality.

→ see `01-scripted-anthropic-harness.md` for the harness mechanics
→ see `02-fixture-driven-schema-parser.md` for the fixture-driven unit level (Level 1 sharpest)

## tests-as-design-pressure

The Phase 2 swap is still the clearest evidence in this audit: the `lib/data-source/` extraction is a refactor done *to enable testing* the route layer. It produced the 20 route-integration tests, the 5 DataSource-seam tests, and the agent harness now injects a `DataSource` (not an `McpClient` directly). That design move outlived the Olist removal — the seam survives, only the second implementation (`OlistDataSource`) and its server-side tests are gone.

The seam ladder, top to bottom (post-Olist-removal):

- **parameter injection** — `parseAgentJson(text)`, `isDiagnosis(v)`, every type guard. Trivially testable.
- **constructor injection** — `new BloomreachDataSource(transport, opts)` / `new SyntheticDataSource()` / `new DiagnosticAgent(anthropic, dataSource, schema, toolDefs)`. Pass any fake.
- **options-bag injection** — `runAgentLoop({ anthropic, dataSource, … })`. Pass fakes in a record.
- **test-only `_` exports** — `_clearAuthStore`, `_authCookieCrypto.{encrypt,decrypt}`, `_resetSchemaCache`. Controlled leak of internals via an underscore convention. Used in `beforeEach` to reset module state.
- **THE SEAM — `DataSource` interface (`lib/data-source/types.ts`)** — three methods (`callTool`, `listTools`, the lifecycle). Both `BloomreachDataSource` (production) and `SyntheticDataSource` (in-process, deterministic) implement it; agent tests inject either a hand-rolled fake or the real `SyntheticDataSource`.
- **framework-implicit (next/headers)** — `lib/mcp/session.ts` and parts of `lib/mcp/auth.ts` read `cookies()` from `next/headers`. Reachable only inside a Next request context.

**The test-cost trade-off worth naming.** `lib/mcp/client.ts` was deleted on purpose during the Phase 2 swap, then restored as a 17-line backwards-compat shim that re-exports `BloomreachDataSource` as `McpClient`. The reason was test cost: 16 existing test files imported `McpClient` from this path; renaming all 16 would have been ~30 minutes of churn for zero behavioural change. The shim costs 17 lines, opens no real surface, and disappears the day callers migrate. Honest engineering — the cost of rewriting tests is a real input to the refactoring decision, not an afterthought. Worth mentioning to a reviewer who asks "why does this file still exist?"

The design pressure that *wasn't* applied: `lib/mcp/connect.ts` (Gap B, the OAuth orchestrator) and the page components (Gap C, acceptable for scope).

→ see `01-scripted-anthropic-harness.md` for how the `DataSource` seam pays off

## determinism-isolation-and-flakiness

One flake of record, fixed, and the fix is the canonical post-mortem story for this repo.

Sources of non-determinism, all handled:

- **time** — `vi.useFakeTimers()` + `vi.advanceTimersByTime` in every TTL/retry test (`client.test.ts` lines 50, 78, 111–167). The rate-limit retry tests advance fake time past Bloomreach's 10s window without actually waiting.
- **process.env** — `vi.stubEnv` / `vi.unstubAllEnvs` in `auth.test.ts` lines 117–122. THIS IS the AUTH_SECRET fix from commit `e83a8e0`. Before: direct `process.env.AUTH_SECRET = …` in `beforeEach` with no afterEach; the var leaked across parallel workers because a vitest worker process is reused across files, and `process.env` is a single object inside that process. The crypto test failed ~1 in N runs and passed in isolation. After: tracked stubbing that vitest restores on every test exit. 221 tests across repeated runs, clean.
- **global fetch** — `vi.stubGlobal('fetch', …)` + `vi.unstubAllGlobals()` in `transport.test.ts`.
- **module-scoped in-memory state** — `_clearAuthStore()`, `_clear()` on the insight cache, `_clearInvestigationCache()`, `_resetSchemaCache()` all called in `beforeEach` on the respective test files.
- **network** — faked at every boundary. No test in the suite makes a real HTTP call.
- **filesystem** — read-only access to committed fixtures.

Known-but-not-enforced: there's no ESLint rule banning direct `process.env.X = …` in `test/**/*.ts`. The same flake class could land in a future test file and nothing would catch it.

→ see `03-vi-stubenv-isolation.md` for the full post-mortem walkthrough on the AUTH_SECRET flake

## edge-cases-and-error-paths

Strong on type-guard rejection (~12 of 25 `validate.test.ts` tests are isolated-gate rejections), the retry ladder (5 of 14 `client.test.ts` tests), and the parser robustness block (4 of 24 `schema.test.ts` tests cover empty events, missing `event_types_overview`, missing `default_group.properties`, text-only fallback).

The pattern that earns its own file: **acceptance + per-gate rejection** — for every gate in a type guard, one acceptance test (positive control) plus one isolated-gate rejection test (every other field valid via spread, only the gate-under-test broken). 25 tests in `validate.test.ts` follow this discipline. The dual-shape `estimatedImpact` coverage (legacy `string` AND rich `{ range, … }` object, with rejection when object is missing `range`) is the canonical case.

The weak spot: **no test scripts a throw from `anthropic.messages.create`**. Every scripted-Anthropic fake returns a response. If the SDK throws (network blip, 401, model-side 429), the agent's behaviour is undefined-by-test — likely an uncaught exception bubbling to the route, which 500s. The `mcp.callTool` throw path is tested (`base.test.ts` lines 182–214); the Anthropic throw path is not. Asymmetry.

Other gaps under this lens, all named-not-fixed:

- NDJSON stream truncated mid-flight (client disconnects) — 0 tests.
- Concurrent investigations on the same insight (race) — 0 tests.
- OAuth callback with mismatched state — `consumeState` itself is tested (`auth.test.ts`), but no end-to-end callback test asserts the rejection fails the flow.

→ see `04-acceptance-plus-per-gate-rejection.md` for the rejection-coverage discipline

## testing-ai-features

This is a 100%-AI product — every investigation runs Claude + MCP — so the deterministic-vs-eval seam is still the most important framing in the audit. **Today only the deterministic half exists in the repo.**

**Half 1 — what IS tested deterministically (the wrapper):** prompt assembly (`schemaSummary`, ~10 tests), tool dispatch (`base.test.ts`, ~8 tests), message accumulation, output parsing (`parseAgentJson`, 5 tests), output validation (`isDiagnosis` etc., 25 tests), synthesis fallback (`diagnostic.test.ts` lines 273–291; `recommendation.test.ts`), the route-level NDJSON stream (`test/api/agent.integration.test.ts`, 10 tests), the `DataSource` seam through the in-process `SyntheticDataSource` (`test/data-source/synthetic-data-source.test.ts`, 5 tests). Every agent test injects a scripted Anthropic response and runs the real agent against it. **31 tests across 5 files** share the scripted-Anthropic pattern.

**Half 2 — what is NOT tested:** quality. The Phase 3 eval suite that briefly closed this gap is gone:

```
the deleted Pillar 2 (PR #8, commit 62c24d7)
─────────────────────────────────────────────
eval/scripts/run-detection.ts              precision/recall vs seeded anomalies
eval/scripts/run-diagnosis.ts              5-criterion LLM-as-judge rubric, pass ≥ 7
eval/scripts/run-recommendation.ts         3-criterion LLM-as-judge rubric, pass ≥ 4
eval/scripts/run-regression.ts             capture + structural + judge
eval/results/<date>[-<tag>]/               committed paper trail
mcp-server-olist/test/  (43 tests)         SQLite tools the eval ran against
test/data-source/olist.integration.test.ts the seam test for the deleted adapter

  → all four eval scripts deleted (no detection, no diagnosis judge, no rec judge,
    no regression scoring)
  → no goldens captured here anymore
  → no eval/results/<date>/ paper trail
  → no model-output variance capture (K=10 is gone with the harness that ran it)
```

The pattern files 05 (`llm-eval-as-testing`) and 06 (`eval-flywheel`) are preserved with RETIRED banners. They document a real testing discipline — LLM-as-judge, K-run variance capture, pre-flight gates, the eval flywheel cadence — but the code anchors they cite (eval/scripts/*, eval/results/*) no longer exist in this repo. Read them as record, not as live in-repo patterns.

**What's NOT tested at all anymore:** model-output quality. The agent code is exercised deterministically and end-to-end through the route layer; whether the model says the right thing about a given anomaly is not measured in `npm test`, and there's no out-of-band measurement either now. That's the honest gap.

**The seam still pays off.** Both the production agent path and the test harness inject through the same `DataSource` interface. `SyntheticDataSource` is the in-process adapter the tests use; `BloomreachDataSource` is the production one. One seam, two consumers; the load-bearing refactor that originally enabled this still stands.

→ see `01-scripted-anthropic-harness.md` for the deterministic-wrapper layer
→ see `05-llm-eval-as-testing.md` (RETIRED) for the LLM-as-judge discipline in the abstract
→ see `06-eval-flywheel.md` (RETIRED) for the measure→fix→re-measure methodology
→ (external) `.aipe/study-ai-engineering/05-evals-and-observability/` for the model-architecture / rubric-theory deep walk

## testing-red-flags-audit

Twelve flags marked against this repo:

```
flag                                          status   evidence
────                                          ──────   ────────
 1  missing critical-path tests               ✓ clean    test/api/*.integration.test.ts (20 tests)
 2  hard-to-test code (design smell)          ✓ clean    DataSource interface + options-bag DI
 3  flakes accepted                           ✓ clean    one fixed via vi.stubEnv (e83a8e0)
 4  time / order dependence                   ✓ clean    vi.useFakeTimers + _clear() helpers
 5  over-mocking (test the mock, not code)    ✓ clean    scripted-Anthropic runs real agent
 6  mock things you don't own                 ✓ clean    DataSource seam owned by this repo
 7  no contract test on external              ✗ present  fixtures from 2026-05 never re-validated
 8  no lint guard on env mutation             △ partial  no ESLint rule banning direct process.env.X =
 9  passWithNoTests masks gaps                △ partial  vitest.config.ts line 11 + no coverage gate
10  no end-to-end smoke                       △ partial  NDJSON stream tests exist; no Playwright UI
11  test code drift / dead helpers            ✓ clean    minimal helpers, no drift
12  parallel-run hazard                       — n/a      eval pipeline that surfaced this is removed
AI-eval  no quality eval                      ✗ present  eval/ deleted with Olist removal (PR #8)
```

Tally: **6 clean, 3 partial, 2 present, 1 n/a.** The flag that flipped present→clean stays clean: **flag 1** (route tests still exist). The flag that flipped back to present: **AI-eval** (no eval suite anymore). **Flag 12** (parallel eval-run hazard) is now n/a — the eval pipeline that created the shared-results-dir race no longer exists; `EVAL_RUN_TAG` was the mitigation but there's nothing left to mitigate.

The remaining structural gaps are at the **production-MCP contract boundary** (flag 7) and the **model-quality boundary** (AI-eval). The first survives unchanged; the second was briefly closed and is now reopened by the Olist removal.

The closest existing step toward flag 7: `test/mcp/tool-coverage.test.ts` (lines 70–82) hardcodes the bootstrap tool list and cross-checks it against the registry — a static contract assertion. It would graduate to a real contract test if it were run against the live MCP server's `listTools()` at CI time.

## Top 3 ranked findings (this revision)

1. **No measurement of model-output quality anywhere** — the deterministic harness proves the wiring works; the deleted eval suite was the only thing measuring whether the agent said the right thing about an anomaly. PR #8 removed it on purpose (75-file cleanup, the Olist adapter was retired) — but now the model-quality gap is back open and there is no replacement. Fix shape options: (a) a small `eval/` reboot against `SyntheticDataSource` with a handful of seeded anomalies and an LLM-as-judge rubric, reusing the deleted pattern at a smaller scale; (b) accept the gap and rely on manual spot-checks against the demo snapshot. Either is honest — drifting on without naming the gap is not.

2. **No contract test against the live MCP shape** — same finding as before, unaffected by the Olist removal. `test/fixtures/*.json` were captured on 2026-05; if Bloomreach renames `events` to `event_definitions` tomorrow, all 24 `schema.test.ts` tests still pass against the stale fixtures while production breaks. Fix shape: a CI job that fetches a fresh fixture from the real MCP server and shape-diffs against the committed one.

3. **No throw-path test on `anthropic.messages.create`** — every scripted-Anthropic fake in the suite returns a response. If the SDK throws (401, 429, transient network), the agent's behaviour is undefined-by-test. The `mcp.callTool` throw path IS tested (`base.test.ts` lines 182–214); the Anthropic throw path is not. Fix shape: extend `buildFakeAnthropic` to accept `{ throw: '401 Unauthorized' }` queue entries and add three tests (route layer surfaces the error to NDJSON; synthesis fallback survives a throw; non-retryable error propagates instead of being swallowed).

---
