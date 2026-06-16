# Study — Testing & Correctness: overview

The question this guide answers: **how do you know the code works — and will keep working after the next change?** A good suite tells you what a change broke before your users do. A suite that doesn't is decoration.

## The shape of this guide

Two passes, mandated by the audit-style format.

**Pass 1 — `audit.md`.** One file walks the 7-lens inventory against this repo, with `file:line` grounding. Each lens has a `##` section: what's tested, what isn't, where the gap is, where the discipline is sharpest. Capstone lens consolidates the red-flag checklist. **Read `audit.md` first** — it's the one-pass survey of the whole testing surface, **both pillars**.

**Pass 2 — discovered-pattern files.** Six pattern files name the testing techniques this repo actually exercises deliberately, each with a deep walk in the full `format.md` template (Zoom out → Structure pass → How it works → Primary diagram → Implementation in codebase → Elaborate → Interview defense → Validate → See also). 01–04 cover Pillar 1 (deterministic `npm test`); **05–06 cover Pillar 2 (the eval suite as a testing discipline, added in this revision)**. Read after `audit.md`, in the order they're numbered.

## The map

```
The deterministic / probabilistic seam — both pillars now exercised in this repo

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
  │   detection      precision/recall vs 3 seeded anomalies, structural   │
  │                  ground-truth comparison                              │
  │   diagnosis      5-criterion LLM-as-judge rubric, pass ≥7             │
  │   recommendation 3-criterion LLM-as-judge rubric, pass ≥4             │
  │   regression     capture goldens, then structural diff + LLM          │
  │                  similarity judge on re-run                           │
  │                                                                       │
  │   K=10 runs per anomaly; ~$10–15 full Phase 3 spend                   │
  │   EVAL_RUN_TAG env var → sibling result dirs for same-day re-runs     │
  │   results committed under eval/results/<date>[-<tag>]/                │
  │   NOT part of `npm test`. Deliberately separated — expensive +        │
  │   non-deterministic. Calibration via manual 8/8 + 3/3 spot-checks.    │
  └───────────────────────────────────────────────────────────────────────┘
```

The seam that matters: **determinism.** Pillar 1 asserts "equals expected value." Pillar 2 asserts "good enough / didn't regress" via LLM-as-judge against a seeded ground truth, with K=10 runs to capture model-output variance. Both pillars ship here. The model-architecture and rubric-design *theory* still lives in `study-ai-engineering/05-evals-and-observability/`; this guide's job is the **testing-discipline angle**: how the eval suite is run, gated, isolated, and trusted.

## Reading order

1. **`audit.md`** — the 7-lens survey across both pillars. Lens 6 (`testing-ai-features`) is where the two pillars meet; lens 7 (`testing-red-flags-audit`) carries the consolidated checklist.
2. **`01-scripted-anthropic-harness.md`** — the load-bearing pattern for the agent layer. 40 tests across 6 agent files depend on this harness shape; strip it and the agent layer has zero deterministic coverage.
3. **`02-fixture-driven-schema-parser.md`** — 24 tests in `schema.ts` driven by 8 captured `test/fixtures/*.json` payloads. The canonical pattern for testing parsers against real upstream shapes.
4. **`03-vi-stubenv-isolation.md`** — the AUTH_SECRET flake fix from commit `e83a8e0`. The canonical post-mortem story; generalizes to any tracked-mutation isolation.
5. **`04-acceptance-plus-per-gate-rejection.md`** — the 25-test `validate.ts` discipline. One acceptance + one isolated rejection per gate via spread.
6. **`05-llm-eval-as-testing.md`** — Pillar 2. The 4-eval suite as a testing discipline: rubric design, calibration receipts, K=10 variance, `EVAL_RUN_TAG`, pre-flight gates, the eval-vs-`npm test` boundary.
7. **`06-eval-flywheel.md`** — measure → fix → re-measure as a testing-driven methodology. The PR D→E→F→G arc; the K=10 parallel-run race incident is the post-mortem anecdote.

## The posture, in one paragraph

Robust where it matters most for plumbing: parsers (`lib/mcp/schema.ts` has 24 fixture-driven tests), codecs (`lib/mcp/events.ts` round-trips NDJSON 7 times), type-guard rejection paths (`lib/mcp/validate.ts` validates 25 acceptance/rejection cases), and the agent loop's tool dispatch (`lib/agents/base.ts` has a scripted-Anthropic harness covering all control-flow branches; 40 tests across 6 agent files share the harness). The Phase 2 swap closed the route-layer gap from the previous revision — `test/api/*.integration.test.ts` (20 tests) now drives the NDJSON streams end-to-end, and the new `lib/data-source/` seam is integration-tested through `test/data-source/olist.integration.test.ts` plus the 43-test `mcp-server-olist/` server-side package. The model-quality gap that was Case B (no goldset, no judge, no offline runner) is now Phase 3 reality — a four-eval suite with K=10 runs per anomaly, LLM-as-judge rubrics calibrated against manual spot-checks, and a committed `eval/results/` paper trail. The eval suite is deliberately **not** part of `npm test` — expensive (~$10–15 full spend) and non-deterministic, so it lives behind `npm run eval:*` with its own pre-flight gates (e.g. PR G's regression scorer refuses to run with `process.exit(1)` when no goldens are captured). The 17-line backwards-compat shim at `lib/mcp/client.ts` is the honest test-cost trade-off worth naming — kept on purpose to avoid renaming 16 test-file imports during the swap.

---
Updated: 2026-06-02 — Restructured to two-pass shape (audit.md + 4 discovered-pattern files). 169 tests across 18 files (vitest run). AI-eval seam framed as Case B and pointed at study-ai-engineering/05.
Updated: 2026-06-16 — 144→269 tests across 28 files (Phase 2 swap added test/api, test/data-source, test/streaming, mcp-server-olist; Phase 3 added eval suite). Added concept files 05 (LLM eval as testing) and 06 (eval flywheel). Closed the Case B framing; the eval suite is the second testing pillar now.
