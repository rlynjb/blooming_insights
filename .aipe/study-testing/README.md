# Study — Testing & Correctness (blooming insights)

The question this guide answers: **how do you know the code works — and will keep working after the next change?** A good suite tells you what a change broke before your users do. A suite that doesn't is decoration.

This guide follows the **two-pass audit-style format**: one `audit.md` walks the 7-lens inventory across the whole suite; six pattern files give deep walks on the testing techniques the repo exercises deliberately. Two of those files cover the **eval suite as a testing discipline** — probabilistic by core, deterministic in scaffold, run on a separate non-`npm test` track.

## The map

```
The deterministic / probabilistic seam — both pillars audited here now

  ┌─ PILLAR 1 — DETERMINISTIC: same input → same output (npm test) ───────┐
  │                                                                       │
  │   lib/mcp/*           107 tests  parsers, codecs, type guards, retries│
  │   lib/agents/*         57 tests  loop control + per-agent (D/R/M/Q/I) │
  │   test/api/*           20 tests  NDJSON route integration             │
  │   test/state/*         16 tests  in-memory store round-trips          │
  │   test/insights/*      11 tests  derived-field calculators            │
  │   test/data-source/*   10 tests  DataSource seam integration          │
  │   test/streaming/*      5 tests  NDJSON codec round-trips             │
  │   mcp-server-olist/    43 tests  sqlite tools (TDD'd in Phase 2 swap) │
  │                                                                       │
  │   269 vitest tests across 28 files; node env; passWithNoTests:true    │
  └───────────────────────────┬───────────────────────────────────────────┘
                              │  hand-off at the agent boundary
                              ▼
  ┌─ PILLAR 2 — PROBABILISTIC: eval suite (separate `npm run eval:*` track)┐
  │                                                                       │
  │   eval/scripts/run-detection.ts       precision/recall vs 3 seeded    │
  │   eval/scripts/run-diagnosis.ts       5-criterion LLM-as-judge ≥ 7    │
  │   eval/scripts/run-recommendation.ts  3-criterion LLM-as-judge ≥ 4    │
  │   eval/scripts/run-regression.ts      capture + structural + judge    │
  │   eval/results/<date>[-<tag>]/        committed paper trail           │
  │                                                                       │
  │   K=10 runs/anomaly; ~$10–15 full Phase 3 spend; LLM-as-judge         │
  │   NOT part of `npm test`. Deliberately separate — expensive +         │
  │   non-deterministic. Calibration via 8/8 + 3/3 manual spot-checks.    │
  └───────────────────────────────────────────────────────────────────────┘
```

The seam that matters: **determinism.** Pillar 1 asserts "equals expected value" — pure unit, integration, contract. Pillar 2 asserts "good enough / didn't regress" — LLM-as-judge against a seeded ground truth, with K=10 runs to capture variance. Both ship here now; the model-architecture deep-walk on evals still lives in `study-ai-engineering/05-evals-and-observability/`.

## What's here

| file | shape | what it covers |
|------|-------|----------------|
| [00-overview.md](00-overview.md) | overview | one-page orientation, the seam, reading order |
| [audit.md](audit.md) | **Pass 1 — the audit** | 7-lens survey of both pillars, with file:line grounding and ranked findings |
| [01-scripted-anthropic-harness.md](01-scripted-anthropic-harness.md) | Pass 2 — pattern | the load-bearing harness for every agent test (40 tests across 6 files) |
| [02-fixture-driven-schema-parser.md](02-fixture-driven-schema-parser.md) | Pass 2 — pattern | 24 schema-parser tests driven by 8 captured `test/fixtures/*.json` payloads |
| [03-vi-stubenv-isolation.md](03-vi-stubenv-isolation.md) | Pass 2 — pattern | the AUTH_SECRET flake fix (commit `e83a8e0`); canonical post-mortem story |
| [04-acceptance-plus-per-gate-rejection.md](04-acceptance-plus-per-gate-rejection.md) | Pass 2 — pattern | the 25-test `validate.ts` discipline: one isolated rejection per guard gate |
| [05-llm-eval-as-testing.md](05-llm-eval-as-testing.md) | Pass 2 — pattern | **NEW.** The Phase 3 eval suite as the *second testing pillar* — LLM-as-judge rubric design, calibration spot-checks, K=10 variance, `EVAL_RUN_TAG`, eval-vs-`npm test` boundary, pre-flight gates |
| [06-eval-flywheel.md](06-eval-flywheel.md) | Pass 2 — pattern | **NEW.** measure → fix → re-measure as a testing-driven methodology; the PR D→E→F→G arc, with the K=10 parallel-run race incident |

## Reading order

Start with **`audit.md`** — it's the one-pass survey. Each `##` section walks one lens (what-is-tested-and-what-isnt, test-design-and-levels, tests-as-design-pressure, determinism-isolation-and-flakiness, edge-cases-and-error-paths, testing-ai-features, testing-red-flags-audit). Lenses with significant findings cross-link to a pattern file for the deep walk.

Then read the pattern files in number order — most foundational first:

1. **01** — the scripted-Anthropic harness is the load-bearing pattern for Pillar 1. Every agent test depends on it; if you understand only one pattern from this guide, make it this one.
2. **02** — the fixture-driven schema parser is the second-most-load-bearing — captured-response fixtures + value-specific assertions are how the MCP boundary stays covered.
3. **03** — `vi.stubEnv` isolation is the canonical post-mortem story. Read it for the *process* (how to fix a flake), not just the specific bug.
4. **04** — acceptance + per-gate rejection is the discipline behind 25 of the most defensive tests in the suite. Read it for the spread-isolation move.
5. **05** — LLM eval as testing is Pillar 2. Read it for the rubric-design discipline + calibration receipts + the *why this is separate from `npm test`* boundary.
6. **06** — the eval flywheel is what you do with Pillar 2 once it exists. Read it for the PR-by-PR cadence and the parallel-run race story.

## The posture, in one paragraph

Robust where it matters most for plumbing: parsers (`lib/mcp/schema.ts` has 24 fixture-driven tests), codecs (`lib/mcp/events.ts` round-trips NDJSON 7 times), type-guard rejection paths (`lib/mcp/validate.ts` validates 25 acceptance/rejection cases), and the agent loop's tool dispatch (`lib/agents/base.ts` has a scripted-Anthropic harness covering all control-flow branches; 40 tests across 6 agent files share the harness). The Phase 2 swap closed the route-layer gap — `test/api/agent.integration.test.ts` (10 tests) and `test/api/briefing.integration.test.ts` (7 tests) now drive the NDJSON streams end-to-end, and the new DataSource seam (`lib/data-source/`) is integration-tested through `test/data-source/olist.integration.test.ts` (10 tests) plus the 43-test `mcp-server-olist/` package. The model-quality gap that *was* Case B in v1 of this guide is now partially closed by Phase 3 — a four-script eval suite (detection, diagnosis, recommendation, regression) with K=10 runs per anomaly, LLM-as-judge rubrics calibrated against 8/8 + 3/3 manual spot-checks, and a committed result paper trail at `eval/results/<date>[-<tag>]/`. The eval suite is **not** part of `npm test` — it's the second pillar, runnable via `npm run eval:*`. **One real testing pattern worth naming explicitly:** the `lib/mcp/client.ts` backwards-compat shim (17 lines re-exporting `BloomreachDataSource` as `McpClient`) was kept on purpose to avoid renaming 16 test-file imports during the Phase 2 swap — test-rewrite cost is a real engineering input, not an afterthought.

---
Updated: 2026-06-02 — Restructured to two-pass shape (audit.md + 4 discovered-pattern files). 169 tests across 18 files (vitest run). AI-eval seam framed as Case B and pointed at study-ai-engineering/05.
Updated: 2026-06-16 — 144→269 tests across 28 files (Phase 2 swap + Phase 3 eval). Added concept files 05 (LLM eval as testing) and 06 (eval flywheel). Closed the Case B framing — eval suite now exists. Named the 17-line backwards-compat shim as a test-cost engineering trade-off.
