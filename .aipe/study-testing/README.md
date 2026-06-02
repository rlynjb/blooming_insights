# Study — Testing & Correctness (blooming insights)

The question this guide answers: **how do you know the code works — and will keep working after the next change?** A good suite tells you what a change broke before your users do. A suite that doesn't is decoration.

This guide follows the **two-pass audit-style format**: one `audit.md` walks the 7-lens inventory across the whole suite; four pattern files give deep walks on the testing techniques the repo exercises deliberately.

## The map

```
The deterministic / probabilistic seam — what's audited here vs next door

  ┌─ DETERMINISTIC: same input → same output (study-testing, THIS GUIDE) ─┐
  │                                                                       │
  │   lib/mcp/*       96 tests   parsers, codecs, type guards, retries    │
  │   lib/agents/*    53 tests   loop control + per-agent (D/R/M/Q)       │
  │   lib/state/*      9 tests   in-memory store round-trips              │
  │   lib/insights/*  11 tests   derived-field calculators                │
  │                                                                       │
  │   169 vitest tests across 18 files; node env; passWithNoTests:true    │
  └───────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  hands off where output is not deterministic
                                  ▼
  ┌─ PROBABILISTIC: "good enough?" / "didn't regress?" (study-ai-engineering) ┐
  │                                                                          │
  │   Was the diagnosis ACTUALLY correct?  Did the prompt regress?           │
  │   Is this recommendation any GOOD?                                       │
  │                                                                          │
  │   → no eval set, no judge, no goldset in this repo today                 │
  │   → Case B treatment lives in study-ai-engineering/05-evals-...          │
  └──────────────────────────────────────────────────────────────────────────┘
```

The seam that matters: **determinism.** If the assertion is "equals expected value," it's testing — this guide. If the assertion is "didn't regress on a non-deterministic LLM output," it's evaluation — next door. They meet when you test an AI feature: a deterministic harness (here, the scripted-Anthropic loop) wrapping a probabilistic core (the real model, untested today).

## What's here

| file | shape | what it covers |
|------|-------|----------------|
| [00-overview.md](00-overview.md) | overview | one-page orientation, the seam, reading order |
| [audit.md](audit.md) | **Pass 1 — the audit** | 7-lens survey of the whole suite, with file:line grounding and ranked findings |
| [01-scripted-anthropic-harness.md](01-scripted-anthropic-harness.md) | Pass 2 — pattern | the load-bearing harness for every agent test (31 tests across 5 files) |
| [02-fixture-driven-schema-parser.md](02-fixture-driven-schema-parser.md) | Pass 2 — pattern | 24 schema-parser tests driven by 8 captured `test/fixtures/*.json` payloads |
| [03-vi-stubenv-isolation.md](03-vi-stubenv-isolation.md) | Pass 2 — pattern | the AUTH_SECRET flake fix (commit `e83a8e0`); canonical post-mortem story |
| [04-acceptance-plus-per-gate-rejection.md](04-acceptance-plus-per-gate-rejection.md) | Pass 2 — pattern | the 25-test `validate.ts` discipline: one isolated rejection per guard gate |

## Reading order

Start with **`audit.md`** — it's the one-pass survey. Each `##` section walks one lens (what-is-tested-and-what-isnt, test-design-and-levels, tests-as-design-pressure, determinism-isolation-and-flakiness, edge-cases-and-error-paths, testing-ai-features, testing-red-flags-audit). Lenses with significant findings cross-link to a pattern file for the deep walk.

Then read the pattern files in number order — most foundational first:

1. **01** — the scripted-Anthropic harness is the load-bearing pattern. Every agent test depends on it; if you understand only one pattern from this guide, make it this one.
2. **02** — the fixture-driven schema parser is the second-most-load-bearing — captured-response fixtures + value-specific assertions are how the MCP boundary stays covered.
3. **03** — `vi.stubEnv` isolation is the canonical post-mortem story. Read it for the *process* (how to fix a flake), not just the specific bug.
4. **04** — acceptance + per-gate rejection is the discipline behind 25 of the most defensive tests in the suite. Read it for the spread-isolation move.

## The posture, in one paragraph

Robust where it matters most for plumbing: parsers (`lib/mcp/schema.ts` has 24 fixture-driven tests), codecs (`lib/mcp/events.ts` round-trips NDJSON 7 times), type-guard rejection paths (`lib/mcp/validate.ts` validates 25 acceptance/rejection cases), and the agent loop's tool dispatch (`lib/agents/base.ts` has a scripted-Anthropic harness covering all 8 control-flow branches; 31 tests across 5 agent files share the harness). Real-but-narrow on isolation — the AUTH_SECRET-via-`vi.stubEnv` fix (commit `e83a8e0`) is exactly the right kind of post-mortem fix, but the rest of the suite hasn't been re-audited for the same class of leak. **Three real gaps:** zero tests on the NDJSON streaming routes (`app/api/agent/route.ts`, `app/api/briefing/route.ts`) — the SSE event ordering and the route's 300s budget logic both go unverified; zero contract test that pins the *exact shape* the MCP server returns vs what `parseWorkspaceSchema` expects (fixtures pass today, but if Bloomreach changes shape the test won't catch it — the schema test would still pass against stale fixtures); and zero agent-trajectory evals — every test injects a scripted Anthropic response, so the real model could regress quality forever and the green-bar would not move. That last gap is Case B, not a unit-test gap, and it points at `study-ai-engineering/05-evals-and-observability/`.

---
Updated: 2026-06-02 — Restructured to two-pass shape (audit.md + 4 discovered-pattern files). 169 tests across 18 files (vitest run). AI-eval seam framed as Case B and pointed at study-ai-engineering/05.
