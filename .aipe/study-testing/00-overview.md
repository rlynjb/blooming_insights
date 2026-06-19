# Study — Testing & Correctness: overview

The question this guide answers: **how do you know the code works — and will keep working after the next change?** A good suite tells you what a change broke before your users do. A suite that doesn't is decoration.

## The shape of this guide

Two passes, mandated by the audit-style format.

**Pass 1 — `audit.md`.** One file walks the 7-lens inventory against this repo, with `file:line` grounding. Each lens has a `##` section: what's tested, what isn't, where the gap is, where the discipline is sharpest. Capstone lens consolidates the red-flag checklist. **Read `audit.md` first** — it's the one-pass survey of the whole testing surface.

**Pass 2 — discovered-pattern files.** Four live pattern files (01–04) name the testing techniques this repo actually exercises deliberately, each with a deep walk in the full `format.md` template (Zoom out → Structure pass → How it works → Primary diagram → Implementation in codebase → Elaborate → Interview defense → Validate → See also). Files 05 and 06 are kept as **RETIRED historical artifacts** — they document the Phase 3 LLM-eval and eval-flywheel patterns that were deleted from the codebase in the Olist removal (PR #8, commit 62c24d7); the patterns themselves are real industry techniques, but there's no longer any in-repo code to anchor them.

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

The deterministic-vs-evaluation seam is still the most important framing for AI testing as a discipline (and `study-ai-engineering/` still teaches it on the model-architecture side), but **in this repo** only the deterministic half ships. There is no second pillar here: the four-script eval suite, the `mcp-server-olist/` package, the LLM-as-judge harness, the `eval/results/` paper trail — all deleted with the Olist removal. The seam survives at the `DataSource` interface (`lib/data-source/types.ts`) and the new `SyntheticDataSource` is the in-process adapter every test injects through that seam instead.

## Reading order

1. **`audit.md`** — the 7-lens survey. Lens 6 (`testing-ai-features`) is where the deterministic harness pattern is named; lens 7 (`testing-red-flags-audit`) carries the consolidated checklist.
2. **`01-scripted-anthropic-harness.md`** — the load-bearing pattern for the agent layer. 31 tests across 5 agent files depend on this harness shape; strip it and the agent layer has zero deterministic coverage.
3. **`02-fixture-driven-schema-parser.md`** — 24 tests in `schema.ts` driven by 8 captured `test/fixtures/*.json` payloads. The canonical pattern for testing parsers against real upstream shapes.
4. **`03-vi-stubenv-isolation.md`** — the AUTH_SECRET flake fix from commit `e83a8e0`. The canonical post-mortem story; generalizes to any tracked-mutation isolation.
5. **`04-acceptance-plus-per-gate-rejection.md`** — the 25-test `validate.ts` discipline. One acceptance + one isolated rejection per gate via spread.
6. **`05-llm-eval-as-testing.md`** — **RETIRED.** The Phase 3 eval suite the file teaches is gone. Read it as a record of the LLM-as-judge testing discipline, not as a live in-repo pattern.
7. **`06-eval-flywheel.md`** — **RETIRED.** Same — the measure→fix→re-measure cadence the file teaches is a real methodology, but the eval suite that drove it was deleted with Olist.

## The posture, in one paragraph

Robust where it matters most for plumbing: parsers (`lib/mcp/schema.ts` has 24 fixture-driven tests), codecs (`lib/mcp/events.ts` round-trips NDJSON 7 times), type-guard rejection paths (`lib/mcp/validate.ts` validates 25 acceptance/rejection cases), and the agent loop's tool dispatch (`lib/agents/base.ts` has a scripted-Anthropic harness covering all control-flow branches; 31 tests across 5 agent files share the harness). The Phase 2 swap closed the route-layer gap — `test/api/*.integration.test.ts` (20 tests) drives the NDJSON streams end-to-end, and the `lib/data-source/` seam is exercised through `test/data-source/synthetic-data-source.test.ts` (5 tests) against the in-process `SyntheticDataSource`. **What used to be Pillar 2 — the Phase 3 LLM eval suite — is gone.** It was deleted alongside the Olist MCP server in PR #8 (commit 62c24d7): ~75 files, four eval scripts (detection / diagnosis / recommendation / regression), the K=10 calibration discipline, the LLM-as-judge harness, the `eval/results/<date>/` paper trail. Files 05 and 06 are preserved as historical record. The four portfolio numbers from that era — detection 37%/33%, diagnosis 53.3%, recommendation 100%, regression 30% — are no longer measurable in this repo. The model-quality gap that the eval suite once filled is back open: today's one pillar tells you the wiring works, not whether the agent's output is good.

---
Updated: 2026-06-02 — Restructured to two-pass shape (audit.md + 4 discovered-pattern files). 169 tests across 18 files (vitest run). AI-eval seam framed as Case B and pointed at study-ai-engineering/05.
Updated: 2026-06-16 — 144→269 tests across 28 files (Phase 2 swap added test/api, test/data-source, test/streaming, mcp-server-olist; Phase 3 added eval suite). Added concept files 05 (LLM eval as testing) and 06 (eval flywheel). Closed the Case B framing; the eval suite is the second testing pillar now.
Updated: 2026-06-19 — Olist removal (PR #8, commit 62c24d7) deleted the entire eval/ directory, `mcp-server-olist/`, `olist.integration.test.ts`. Reverted to one-pillar framing: 221 tests / 24 files. Files 05 and 06 marked RETIRED (banners already in place). `test/data-source/synthetic-data-source.test.ts` (5 tests, commit c75ec3e) is the new exemplar for the DataSource seam.
