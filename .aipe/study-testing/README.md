# Study — Testing & Correctness (blooming insights)

The question this guide answers: **how do you know the code works — and will keep working after the next change?** A good suite tells you what a change broke before your users do. A suite that doesn't is decoration.

This guide follows the **two-pass audit-style format**: one `audit.md` walks the 7-lens inventory across the whole suite; four live pattern files (01–04) give deep walks on the testing techniques the repo currently exercises. Two more files (05, 06) are kept as **RETIRED** historical record of the Phase 3 LLM-eval pipeline that was deleted with the Olist removal — patterns real, in-repo anchors gone.

## The map

```
One pillar — npm test, deterministic, 221 tests

  ┌─ PILLAR 1 — DETERMINISTIC: same input → same output (npm test) ───────┐
  │                                                                       │
  │   lib/mcp/*           107 tests  parsers, codecs, type guards, retries│
  │   lib/agents/*         57 tests  loop control + per-agent (D/R/M/Q/I) │
  │   test/api/*           20 tests  NDJSON route integration             │
  │   test/state/*         16 tests  in-memory store round-trips          │
  │   test/insights/*      11 tests  derived-field calculators            │
  │   test/data-source/*    5 tests  SyntheticDataSource at the seam      │
  │   test/streaming/*      5 tests  NDJSON codec round-trips             │
  │                                                                       │
  │   221 vitest tests across 24 files; node env; passWithNoTests:true    │
  └───────────────────────────────────────────────────────────────────────┘
```

The deterministic-vs-eval seam is still the framing that matters for AI testing (see `study-ai-engineering/05-evals-and-observability/`), but **in this repo only the deterministic half ships now.** The Phase 3 eval suite, the `mcp-server-olist/` package, and the `olist.integration.test.ts` file are gone (PR #8, commit 62c24d7). The `DataSource` interface seam at `lib/data-source/types.ts` survives — and the new in-process `SyntheticDataSource` is what every agent test injects through it.

## What's here

| file | shape | what it covers |
|------|-------|----------------|
| [00-overview.md](00-overview.md) | overview | one-page orientation, the seam, reading order |
| [audit.md](audit.md) | **Pass 1 — the audit** | 7-lens survey of the deterministic suite, with file:line grounding and ranked findings |
| [01-scripted-anthropic-harness.md](01-scripted-anthropic-harness.md) | Pass 2 — pattern | the load-bearing harness for every agent test (31 tests across 5 files) |
| [02-fixture-driven-schema-parser.md](02-fixture-driven-schema-parser.md) | Pass 2 — pattern | 24 schema-parser tests driven by 8 captured `test/fixtures/*.json` payloads |
| [03-vi-stubenv-isolation.md](03-vi-stubenv-isolation.md) | Pass 2 — pattern | the AUTH_SECRET flake fix (commit `e83a8e0`); canonical post-mortem story |
| [04-acceptance-plus-per-gate-rejection.md](04-acceptance-plus-per-gate-rejection.md) | Pass 2 — pattern | the 25-test `validate.ts` discipline: one isolated rejection per guard gate |
| [05-llm-eval-as-testing.md](05-llm-eval-as-testing.md) | **RETIRED** | Historical record of LLM-as-judge as a testing discipline. The Phase 3 eval suite this file walked was deleted (PR #8). Pattern real, in-repo anchors gone. |
| [06-eval-flywheel.md](06-eval-flywheel.md) | **RETIRED** | Historical record of the measure→fix→re-measure cadence. Same deletion as 05. |

## Reading order

Start with **`audit.md`** — it's the one-pass survey. Each `##` section walks one lens (what-is-tested-and-what-isnt, test-design-and-levels, tests-as-design-pressure, determinism-isolation-and-flakiness, edge-cases-and-error-paths, testing-ai-features, testing-red-flags-audit). Lenses with significant findings cross-link to a pattern file for the deep walk.

Then read the live pattern files in number order — most foundational first:

1. **01** — the scripted-Anthropic harness is the load-bearing pattern for the whole suite. Every agent test depends on it; if you understand only one pattern from this guide, make it this one.
2. **02** — the fixture-driven schema parser is the second-most-load-bearing — captured-response fixtures + value-specific assertions are how the MCP boundary stays covered.
3. **03** — `vi.stubEnv` isolation is the canonical post-mortem story. Read it for the *process* (how to fix a flake), not just the specific bug.
4. **04** — acceptance + per-gate rejection is the discipline behind 25 of the most defensive tests in the suite. Read it for the spread-isolation move.

Files 05 and 06 are kept as a deliberate paper trail. Open them only if you want to read about LLM-as-judge testing technique and the eval-flywheel methodology in the abstract — neither file's code anchors exist in the repo anymore.

## The posture, in one paragraph

Robust where it matters most for plumbing: parsers (`lib/mcp/schema.ts` has 24 fixture-driven tests), codecs (`lib/mcp/events.ts` round-trips NDJSON 7 times), type-guard rejection paths (`lib/mcp/validate.ts` validates 25 acceptance/rejection cases), and the agent loop's tool dispatch (`lib/agents/base.ts` has a scripted-Anthropic harness covering all control-flow branches; 31 tests across 5 agent files share the harness). The Phase 2 swap closed the route-layer gap — `test/api/agent.integration.test.ts` (10 tests) and `test/api/briefing.integration.test.ts` (7 tests) drive the NDJSON streams end-to-end. The `DataSource` seam at `lib/data-source/types.ts` is exercised through `test/data-source/synthetic-data-source.test.ts` (5 tests) against the new in-process `SyntheticDataSource` adapter — a clean replacement for the deleted `olist.integration.test.ts` at the same seam, without the subprocess/stdio cost. **The Phase 3 eval suite that used to be the second pillar is gone.** PR #8 (commit 62c24d7) removed the entire `eval/` directory (~75 files, all four eval scripts, the LLM-as-judge harness, the committed `eval/results/` paper trail) and the `mcp-server-olist/` package (43 server-side tests). The four portfolio numbers — detection 37%/33%, diagnosis 53.3%, recommendation 100%, regression 30% — are no longer measurable in this repo. The 17-line backwards-compat shim at `lib/mcp/client.ts` is still here and still the honest test-cost trade-off worth naming.

---
Updated: 2026-06-02 — Restructured to two-pass shape (audit.md + 4 discovered-pattern files). 169 tests across 18 files (vitest run). AI-eval seam framed as Case B and pointed at study-ai-engineering/05.
Updated: 2026-06-16 — 144→269 tests across 28 files (Phase 2 swap + Phase 3 eval). Added concept files 05 (LLM eval as testing) and 06 (eval flywheel). Closed the Case B framing — eval suite now exists. Named the 17-line backwards-compat shim as a test-cost engineering trade-off.
Updated: 2026-06-19 — Olist removal (PR #8) deleted eval/ + mcp-server-olist/. Reverted to one-pillar framing: 221 tests / 24 files. Files 05 and 06 marked RETIRED in the table. New `test/data-source/synthetic-data-source.test.ts` (5 tests, commit c75ec3e) is the replacement seam exemplar.
