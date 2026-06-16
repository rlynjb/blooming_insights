# Testing & Correctness — audit

> **Verdict-first.** Strong on both pillars now. **Pillar 1 (deterministic, `npm test`):** 269 vitest tests across 28 files — `lib/` plumbing (parsers, type guards, codecs) is sharp as before, the Phase 2 swap closed the route gap with `test/api/*.integration.test.ts` (20 tests), and the new `lib/data-source/` seam plus 43-test `mcp-server-olist/` package add server-side coverage that didn't exist in v1 of this audit. The strongest deterministic pattern is still the **scripted-Anthropic harness** (40 tests across 6 agent files now): a fake `messages.create` returning a queued list of responses, the real agent code running end-to-end against it. **Pillar 2 (probabilistic, separate `npm run eval:*` track):** the Phase 3 eval suite — four scripts (detection, diagnosis, recommendation, regression), K=10 runs per anomaly, LLM-as-judge rubrics calibrated against manual 8/8 + 3/3 spot-checks, results committed under `eval/results/<date>[-<tag>]/`. Pillar 2 is deliberately **not** in `npm test` (expensive + non-deterministic) and is the second discipline this audit now covers — see lens 6 and pattern files 05 + 06. The Case-B framing from v1 ("no eval set, no judge") is closed — eval suite exists, with `process.exit(1)` pre-flight gates and an `EVAL_RUN_TAG` env var that prevents same-day re-runs from clobbering result dirs. **The one trade-off worth naming**: `lib/mcp/client.ts` was kept as a 17-line backwards-compat shim re-exporting `BloomreachDataSource` as `McpClient` purely to avoid renaming 16 test files during the swap — test-rewrite cost is a real engineering input, not an afterthought.

## what-is-tested-and-what-isnt

269 tests across 28 files; main repo has 226 across 24 files, the `mcp-server-olist/` package adds 43 across 4 files. The risk map by directory:

```
MAIN REPO (vitest include: test/**/*.test.ts)
lib/mcp/         107 tests / 8 files   parsers, codecs, type guards, retry ladder
lib/agents/       57 tests / 9 files   loop control + per-agent (D/R/M/Q/I) +
                                       synthesis-instruction + tool-schemas
test/api/         20 tests / 3 files   NDJSON route integration (agent + briefing)
                                       + mcp-call-allowlist contract
test/state/       16 tests / 2 files   insights cache + investigation cache
test/insights/    11 tests / 1 file    derived-field calculators
test/data-source/ 10 tests / 1 file    OlistDataSource integration via stdio
test/streaming/    5 tests / 1 file    NDJSON encode/decode round-trips

MCP-SERVER-OLIST (vitest include: mcp-server-olist/test/**/*.test.ts)
mcp-server-olist/test/   43 tests / 4 files
                                       server.test.ts (smoke), tools/
                                       get_anomaly_context, get_metric_timeseries,
                                       get_segments (SQLite query correctness +
                                       anomaly-window math + schema introspection)

  components/    0 tests              React UI (unchanged)
  app/*/page.tsx 0 tests              page components (unchanged)
```

The top files by test count: `validate.ts` (25), `schema.ts` (24), `auth.ts` (~16), `client.ts` (~16), `categories.ts` (12), `derive.ts` (11), `monitoring.ts` (10), `agent.integration.test.ts` (10), `olist.integration.test.ts` (10). **Three gaps from v1 either closed or recharacterized:**

- **Gap A (CLOSED)** — the routes. `test/api/agent.integration.test.ts` (10 tests) and `test/api/briefing.integration.test.ts` (7 tests) construct a `NextRequest`, invoke `GET`/`POST`, and assert on the NDJSON stream's event order. Phase 2's data-source extraction made this possible — the agent's MCP dependency is now an `OlistDataSource` fake at the seam.
- **Gap B (still open)** — `lib/mcp/connect.ts` orchestrates the OAuth handshake (DCR → PKCE → token exchange) and `lib/mcp/session.ts` derives the cookie-backed sessionId. Zero tests on either; a regression would silently break auth. Same finding as v1; not in the Phase 2 scope.
- **Gap C (still acceptable for scope)** — `components/` and `app/*/page.tsx` have zero tests. `vitest.config.ts` is `environment: 'node'`; no `@testing-library/react`. UI is mostly read-only rendering of well-typed lib outputs.

`vitest.config.ts` line 11 still has `passWithNoTests: true`, which converts silent gaps into not-gaps from CI's perspective. The risk hasn't changed since v1.

→ see `01-scripted-anthropic-harness.md` for the load-bearing pattern that makes the agent layer testable
→ see `02-fixture-driven-schema-parser.md` for why `schema.ts` has 24 tests against real captured payloads
→ see `05-llm-eval-as-testing.md` for the second pillar — what's tested *probabilistically* against the live model

## test-design-and-levels

The pyramid as-built: wide unit base, *two* strong middle layers now, plus a separate pillar above. ~190 pure-unit tests (single function, single assertion), 40 scripted-Anthropic tests (real agent code with faked SDK + faked DataSource — closer to integration than unit), **20 route-level integration tests now**, **10 DataSource integration tests through the real stdio transport**, **43 server-side tests inside `mcp-server-olist/`**, and the Phase 3 eval suite as a separate non-`npm test` track for the model-quality layer. No Playwright, no browser-level e2e — still the missing top band.

```
The four levels (deterministic) + the second pillar (probabilistic)

  ▲  Pillar 2 — eval/  (npm run eval:*, not npm test)
  │     LLM-as-judge over real agent calls
  │     ── separate track, ~$10–15 full Phase 3 spend ──
  │
  │  Level 4 — e2e/ Playwright (still missing — explicit gap)
  │  Level 3 — test/api/ integration (NEW: 20 tests)
  │                + test/data-source/ via real stdio (NEW: 10 tests)
  │  Level 2 — agent tests via scripted-Anthropic + fake DataSource
  │                (40 tests across 6 files)
  │  Level 1 — pure unit tests (~190)
```

The interesting design choice is where the scripted-Anthropic pattern sits — still the *integration sweet spot* for AI features in `npm test`. The real `runAgentLoop` runs end-to-end with multi-turn dispatch, message-history accumulation, type-guard fallback, synthesis fallback. Only the Anthropic SDK and the `DataSource` interface are faked. That's an integration test for non-deterministic code, deliberately collapsed back to determinism.

The pyramid's previously-missing middle band — route-level integration — was **closed by Phase 2**. `test/api/agent.integration.test.ts` constructs a `NextRequest`, injects fakes at the DataSource seam, awaits the response, reads the NDJSON stream, asserts on event order + the `done` sentinel. Phase 2's split of `lib/data-source/` made this possible by extracting the dependency at the right boundary.

Still missing at the top: **browser-level e2e** (Playwright clicking through the demo path and asserting the UI renders the diagnosis/recommendation correctly). The Phase 3 eval suite covers the model-quality band above the test pyramid — not the UI-level smoke test.

→ see `01-scripted-anthropic-harness.md` for the harness mechanics
→ see `02-fixture-driven-schema-parser.md` for the fixture-driven unit level (Level 1 sharpest)
→ see `05-llm-eval-as-testing.md` for the second pillar above the deterministic pyramid

## tests-as-design-pressure

The Phase 2 swap is the clearest evidence in this audit: a refactor *to enable testing* (the `lib/data-source/` extraction) produced ~82 new tests in the main repo plus 43 in `mcp-server-olist/`. The route layer that v1 of this audit called "the design-pressure failure" got the same treatment and is now integration-tested.

The seam ladder, top to bottom (post-Phase-2):

- **parameter injection** — `parseAgentJson(text)`, `isDiagnosis(v)`, every type guard. Trivially testable.
- **constructor injection** — `new BloomreachDataSource(transport, opts)` / `new OlistDataSource(serverPath)` / `new DiagnosticAgent(anthropic, dataSource, schema, toolDefs)`. Pass any fake.
- **options-bag injection** — `runAgentLoop({ anthropic, dataSource, … })`. Pass fakes in a record.
- **test-only `_` exports** — `_clearAuthStore`, `_authCookieCrypto.{encrypt,decrypt}`. Controlled leak of internals via an underscore convention. Used by `auth.test.ts` to reset module state in `beforeEach`.
- **THE SEAM THAT GOT EXTRACTED — `DataSource` interface (`lib/data-source/types.ts`)** — three methods (`callTool`, `listTools`, the lifecycle). The route layer used to call `connectMcp()` and pass the resulting client downstream; now both `app/api/agent/route.ts` and the integration tests instantiate a `DataSource` and inject it. This is the single refactor that closed Gap A from v1.
- **framework-implicit (next/headers)** — `lib/mcp/session.ts` and parts of `lib/mcp/auth.ts` read `cookies()` from `next/headers`. Reachable only inside a Next request context. Still the same as v1.

**The test-cost trade-off worth naming.** `lib/mcp/client.ts` was deleted on purpose, then restored as a 17-line backwards-compat shim that re-exports `BloomreachDataSource` as `McpClient`. The reason was test cost: 16 existing test files imported `McpClient` from this path; renaming all 16 would have been ~30 minutes of churn for zero behavioural change. The shim costs 17 lines, opens no real surface, and disappears the day callers migrate. Honest engineering — the cost of rewriting tests is a real input to the refactoring decision, not an afterthought. Worth mentioning to a reviewer who asks "why does this file still exist?"

The design pressure that *wasn't* applied: `lib/mcp/connect.ts` (Gap B, the OAuth orchestrator) and the page components (Gap C, acceptable for scope). Same gaps as v1.

→ see `01-scripted-anthropic-harness.md` for how the `DataSource` seam pays off
→ see `05-llm-eval-as-testing.md` for how the *same* `DataSource` seam lets the eval suite inject an `OlistDataSource` into the production agents unchanged

## determinism-isolation-and-flakiness

One flake of record, fixed, and the fix is the canonical post-mortem story for this repo.

Sources of non-determinism, all handled:

- **time** — `vi.useFakeTimers()` + `vi.advanceTimersByTime` in every TTL/retry test (`client.test.ts` lines 50, 78, 111–167). The rate-limit retry tests advance fake time past Bloomreach's 10s window without actually waiting.
- **process.env** — `vi.stubEnv` / `vi.unstubAllEnvs` in `auth.test.ts` lines 117–122. THIS IS the AUTH_SECRET fix from commit `e83a8e0`. Before: direct `process.env.AUTH_SECRET = …` in `beforeEach` with no afterEach; the var leaked across parallel workers because a vitest worker process is reused across files, and `process.env` is a single object inside that process. The crypto test failed ~1 in N runs and passed in isolation. After: tracked stubbing that vitest restores on every test exit. 269 tests across repeated runs, clean.
- **global fetch** — `vi.stubGlobal('fetch', …)` + `vi.unstubAllGlobals()` in `transport.test.ts`.
- **module-scoped in-memory state** — `_clearAuthStore()`, `_clear()` on the insight cache, `_clearInvestigationCache()` all called in `beforeEach` on the respective test files.
- **network** — faked at every boundary. No test in the suite makes a real HTTP call.
- **filesystem** — read-only access to committed fixtures.

Known-but-not-enforced: there's no ESLint rule banning direct `process.env.X = …` in `test/**/*.ts`. The same flake class could land in a future test file and nothing would catch it.

**The Phase 3 parallel-run incident.** During PR E development, the main session ran `npm run eval:diagnosis -- --K=10` from a Bash session while a sub-agent (working on PR E in parallel) ALSO triggered K=10 against the same `eval/results/<date>/` directory. Both processes were detected via `ps aux` and killed (PIDs 30039 and 30040) before the second run could clobber the first. The lesson is identical to the AUTH_SECRET flake: **shared mutable state across parallel test runs is a hazard.** Today the mitigation is `EVAL_RUN_TAG=<suffix>` — set the env var and same-day re-runs land in `eval/results/<date>-<tag>/` instead. Cf. how `vi.stubEnv` tracks env mutation in vitest; `EVAL_RUN_TAG` is the same idea applied to filesystem output dirs.

→ see `03-vi-stubenv-isolation.md` for the full post-mortem walkthrough on the AUTH_SECRET flake
→ see `06-eval-flywheel.md` for the parallel-run incident in full

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

This is a 100%-AI product — every investigation runs Claude + MCP — and the deterministic-vs-eval seam is still the most important framing in the audit. **Both halves now exist in the repo.**

**Half 1 — what IS tested deterministically (the wrapper, Pillar 1):** prompt assembly (`schemaSummary`, ~10 tests), tool dispatch (`base.test.ts`, ~8 tests), message accumulation, output parsing (`parseAgentJson`, 5 tests), output validation (`isDiagnosis` etc., 25 tests), synthesis fallback (`diagnostic.test.ts` lines 273–291; `recommendation.test.ts`), the route-level NDJSON stream (`test/api/agent.integration.test.ts`, 10 tests), the DataSource seam through real stdio (`test/data-source/olist.integration.test.ts`, 10 tests). Every agent test injects a scripted Anthropic response and runs the real agent against it. **40 tests across 6 files** share the scripted-Anthropic pattern.

**Half 2 — what is now ALSO tested probabilistically (the core, Pillar 2):** quality. The Phase 3 eval suite ships four scripts:

```
the 4-eval suite (Pillar 2)                rubric / scoring
─────────────────────────                  ────────────────
eval/scripts/run-detection.ts              precision/recall vs 3 seeded
                                            anomalies (structural ground-truth
                                            comparison via scorer.ts)
eval/scripts/run-diagnosis.ts              5-criterion LLM-as-judge rubric,
                                            pass ≥ 7 (judge: judges/diagnosis-judge.md)
eval/scripts/run-recommendation.ts         3-criterion LLM-as-judge rubric,
                                            pass ≥ 4 (judge: judges/recommendation-judge.md)
eval/scripts/run-regression.ts             capture goldens, then structural diff +
                                            LLM similarity judge on re-run
```

**Variance and calibration discipline.** K=10 runs per anomaly capture model-output variance — one run could lie, ten runs surface the distribution. Judges are calibrated against manual spot-checks: 8/8 diagnosis judge agreement with hand-scored runs, 3/3 recommendation judge agreement (including the BRL-currency-bug catch that surfaced PR E). Calibration receipts are committed under `eval/results/<date>-score-baseline/` so a reviewer can audit the judge-vs-human delta.

**Pre-flight gates as testing discipline.** `eval/scripts/run-regression.ts` lines 387–399 illustrate the pattern: `scoreMode` refuses to run unless every fixture has a captured `golden_output`, exiting with `process.exit(1)` and a remediation message ("Run `npm run eval:regression -- --capture` first"). Designed-in safety for inherently non-deterministic test infrastructure. Same shape elsewhere: `ANTHROPIC_API_KEY` missing → exit 1; no seeded anomalies in DB → exit 1.

**The eval suite is NOT in `npm test`.** Deliberately. It costs ~$10–15 to run all four at full K=10, takes 5–30 minutes per script, and the LLM-as-judge makes pass/fail non-deterministic. Mixing it into the CI test command would produce flakes, blow the test-runtime budget, and burn money on every PR. The split is `npm test` for the deterministic pillar, `npm run eval:*` for the probabilistic one.

**The bridge.** Both pillars share the same `DataSource` seam. `eval/scripts/lib/run-agent.ts` instantiates the real production agent with an injected `OlistDataSource` — the same seam the deterministic tests inject a fake into. One seam serves both pillars; that's the deep payoff of the Phase 2 refactor.

**What's still NOT tested:** the *production* MCP path (Bloomreach). The eval suite runs against the Olist DataSource (faster, deterministic-enough, hermetic) — the production Bloomreach DataSource has zero quality measurement. Honest gap; named, not closed.

→ see `01-scripted-anthropic-harness.md` for the deterministic-wrapper layer
→ see `05-llm-eval-as-testing.md` for the eval suite as a testing discipline
→ see `06-eval-flywheel.md` for measure → fix → re-measure as methodology
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
12  parallel-run hazard (eval results)        △ partial  EVAL_RUN_TAG mitigates; not enforced
AI-eval  no quality eval                      ✓ clean    eval/ suite shipped; K=10; calibrated judges
AI-bdry  no live-MCP eval against production  ✗ present  eval runs against Olist, not Bloomreach
```

Tally: **7 clean, 4 partial, 2 present.** A material shift from v1's 5/2/5. The flags that flipped from present to clean: **flag 1** (route tests now exist), **flag 6 reframed** (the seam is now `DataSource` owned in-repo, not the MCP SDK), and **AI-eval** (the Phase 3 eval suite exists with calibrated judges). The flags that flipped partial→partial-with-new-evidence: **flag 10** (NDJSON event order is verified, but browser-level UI smoke still isn't). **New flag 12** (parallel eval-run hazard) was named after the PR E session/sub-agent race incident; `EVAL_RUN_TAG` mitigates but isn't enforced — a future eval driver could refuse to write to a non-tagged dir if another process is holding it open.

The remaining structural gap is at the **production-MCP boundary** (flag 7 + AI-bdry): the eval suite runs the agents against Olist (faster, deterministic-enough, hermetic) but never against the live Bloomreach MCP. That's the load-bearing finding of this revision.

The closest existing step toward flag 7: `test/mcp/tool-coverage.test.ts` (lines 70–82) hardcodes the bootstrap tool list and cross-checks it against the registry — a static contract assertion. It would graduate to a real contract test if it were run against the live MCP server's `listTools()` at CI time.

## Top 3 ranked findings (this revision)

1. **No quality eval against the *production* MCP path** — the Phase 3 eval suite runs against `OlistDataSource`. The production code path uses `BloomreachDataSource`. Same agents, different data-source. The eval suite never measures whether the agent produces good output on the actual Bloomreach schema with the actual sparse-tail 90-day windows the product is shipped to handle. Fix shape: a `eval:scripts:bloomreach` track that swaps the injected DataSource and runs the same rubrics against a captured fixture set from production. Half the eval infrastructure is already reusable; the missing piece is a hermetic Bloomreach fixture set with seeded anomalies.

2. **No contract test against the live MCP shape** — same finding as v1. `test/fixtures/*.json` were captured on 2026-05; if Bloomreach renames `events` to `event_definitions` tomorrow, all 24 `schema.test.ts` tests still pass against the stale fixtures while production breaks. Fix shape: a CI job that fetches a fresh fixture from the real MCP server and shape-diffs against the committed one. The `mcp-server-olist/` package's tests demonstrate the shape — they exercise the same tool surface, just against a known-good Olist seeded fixture.

3. **Parallel-run hazards in the eval pipeline (the PR E incident)** — main session + sub-agent both ran `K=10` against the same `eval/results/<date>/` directory; detected via `ps aux` and killed before clobber. Today `EVAL_RUN_TAG` is the mitigation but it's opt-in. Fix shape: add a lockfile check at eval-script entry — if `eval/results/<date>/.lock` exists, refuse to start unless `EVAL_RUN_TAG` is set. Cheap, mechanical, prevents the next variant of this incident.

---
Updated: 2026-06-16 — Two-pillar reframing: deterministic 269-test suite (28 files) + Phase 3 eval suite as the second testing pillar. Closed Gap A (route tests now exist), reframed Gap B/C as unchanged, added test-cost trade-off (17-line `lib/mcp/client.ts` shim) as design-pressure finding. Updated red-flag tally 5/2/5 → 7/4/2 with one new flag (parallel-run hazard). Top-3 findings repointed: production-MCP eval gap, contract test gap (unchanged), parallel-run hazard.
