# Study — Testing & Correctness: overview

The question this guide answers: **how do you know the code works — and will keep working after the next change?** A good suite tells you what a change broke before your users do. A suite that doesn't is decoration.

## The shape of this guide

Two passes, mandated by the audit-style format.

**Pass 1 — `audit.md`.** One file walks the 7-lens inventory against this repo, with `file:line` grounding. Each lens has a `##` section: what's tested, what isn't, where the gap is, where the discipline is sharpest. Capstone lens consolidates the red-flag checklist. **Read `audit.md` first** — it's the one-pass survey of the whole testing surface.

**Pass 2 — discovered-pattern files.** Four pattern files name the testing techniques this repo actually exercises deliberately, each with a deep walk in the full `format.md` template (Zoom out → Structure pass → How it works → Primary diagram → Implementation in codebase → Elaborate → Interview defense → Validate → See also). Read after `audit.md`, in the order they're numbered — they get progressively more specific.

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

## Reading order

1. **`audit.md`** — the 7-lens survey. Tells you where the suite is sharp, where it isn't, and what the load-bearing findings are. Each lens cross-links to a pattern file when the finding warrants a deep walk.
2. **`01-scripted-anthropic-harness.md`** — the load-bearing pattern for the agent layer. 31 tests across 5 agent files depend on this harness shape; strip it and the agent layer has zero coverage.
3. **`02-fixture-driven-schema-parser.md`** — 24 tests in `schema.ts` driven by 8 captured `test/fixtures/*.json` payloads. The canonical pattern for testing parsers against real upstream shapes (and the staleness gap that comes with it).
4. **`03-vi-stubenv-isolation.md`** — the AUTH_SECRET flake fix from commit `e83a8e0`. The canonical post-mortem story for the repo; generalizes to any tracked-mutation isolation (env, timers, globals).
5. **`04-acceptance-plus-per-gate-rejection.md`** — the 25-test `validate.ts` discipline. One acceptance test + one isolated rejection per gate, with every other field held valid via spread.

## The posture, in one paragraph

Robust where it matters most for plumbing: parsers (`lib/mcp/schema.ts` has 24 fixture-driven tests), codecs (`lib/mcp/events.ts` round-trips NDJSON 7 times), type-guard rejection paths (`lib/mcp/validate.ts` validates 25 acceptance/rejection cases), and the agent loop's tool dispatch (`lib/agents/base.ts` has a scripted-Anthropic harness covering all 8 control-flow branches; 31 tests across 5 agent files share the harness). Real-but-narrow on isolation — the AUTH_SECRET-via-`vi.stubEnv` fix (commit `e83a8e0`) is exactly the right kind of post-mortem fix, but the rest of the suite hasn't been re-audited for the same class of leak. **Three real gaps:** zero tests on the NDJSON streaming routes (`app/api/agent/route.ts`, `app/api/briefing/route.ts`) — the SSE event ordering and the route's 300s budget logic both go unverified; zero contract test that pins the *exact shape* the MCP server returns vs what `parseWorkspaceSchema` expects (fixtures pass today, but if Bloomreach changes shape the test won't catch it); and zero agent-trajectory evals — every test injects a scripted Anthropic response, so the real model could regress quality forever and the green-bar would not move. That last gap is Case B, not a unit-test gap, and it points at `study-ai-engineering/05-evals-and-observability/`.

---
Updated: 2026-06-02 — Restructured to two-pass shape (audit.md + 4 discovered-pattern files). 169 tests across 18 files (vitest run). AI-eval seam framed as Case B and pointed at study-ai-engineering/05.
