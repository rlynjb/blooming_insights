# Study — Testing & Correctness (blooming insights)

The question this guide answers: **how do you know the code works — and will keep working after the next change?** A good suite tells you what a change broke before your users do. A suite that doesn't is decoration.

## The map

```
The deterministic / probabilistic seam — what's audited here vs next door

  ┌─ DETERMINISTIC: same input → same output (study-testing, THIS GUIDE) ─┐
  │                                                                       │
  │   lib/mcp/*       unit tests on parsers, codecs, type guards          │
  │   lib/agents/*    scripted-Anthropic loop tests + pure helpers        │
  │   lib/state/*     in-memory store round-trips                         │
  │   lib/insights/*  derived-field calculators                           │
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

| # | concept | the question |
|---|---------|--------------|
| 01 | [what-is-tested-and-what-isnt.md](01-what-is-tested-and-what-isnt.md) | The risk map — which critical paths have tests, which don't |
| 02 | [test-design-and-levels.md](02-test-design-and-levels.md) | The pyramid as-built: unit vs integration vs e2e, with this repo's "scripted Anthropic" pattern |
| 03 | [tests-as-design-pressure.md](03-tests-as-design-pressure.md) | Where the design got *better* because it had to be testable — and where it's still hard |
| 04 | [determinism-isolation-and-flakiness.md](04-determinism-isolation-and-flakiness.md) | The AUTH_SECRET flake fix as the canonical isolation story |
| 05 | [edge-cases-and-error-paths.md](05-edge-cases-and-error-paths.md) | Boundary values, type-guard rejection paths, the rate-limit retry ladder |
| 06 | [testing-ai-features.md](06-testing-ai-features.md) | The seam in practice — what IS testable about an LLM feature, what hands off to evals |
| 07 | [testing-red-flags-audit.md](07-testing-red-flags-audit.md) | The consolidated checklist marked against this repo |

## Reading order

Start with **01** — the risk map. It tells you what each `lib/` file has and lacks before you go deep on any single mechanism. Then **02** for the pyramid shape (mostly unit tests with one strong integration shape: scripted-Anthropic). **04** is the most operationally interesting concept because it's the one bug the suite *had* and *fixed* — the AUTH_SECRET flake. **06** is the honest framing of the AI-eval gap; cross-link to `study-ai-engineering/05-evals-and-observability/` for the would-be shape. End on **07** as the capstone.

## The posture, in one paragraph

Robust where it matters most for plumbing: parsers (`lib/mcp/schema.ts` has 24 fixture-driven tests), codecs (`lib/mcp/events.ts` round-trips NDJSON 7 times), type-guard rejection paths (`lib/mcp/validate.ts` validates 25 acceptance/rejection cases), and the agent loop's tool dispatch (`lib/agents/base.ts` has a scripted-Anthropic harness covering all 8 control-flow branches). Real-but-narrow on isolation — the AUTH_SECRET-via-`vi.stubEnv` fix (commit `e83a8e0`) is exactly the right kind of post-mortem fix, but the rest of the suite hasn't been re-audited for the same class of leak. **Three real gaps:** zero tests on the NDJSON streaming routes (`app/api/agent/route.ts`, `app/api/briefing/route.ts`) — the SSE event ordering and the route's 300s budget logic both go unverified; zero contract test that pins the *exact shape* the MCP server returns vs what `parseWorkspaceSchema` expects (fixtures pass today, but if Bloomreach changes shape the test won't catch it — the schema test would still pass against stale fixtures); and zero agent-trajectory evals — every test injects a scripted Anthropic response, so the real model could regress quality forever and the green-bar would not move. That last gap is Case B, not a unit-test gap, and it points at `study-ai-engineering/05-evals-and-observability/`.

---
Updated: 2026-05-31 — Initial generation. 169 tests across 18 files (vitest run). AI-eval seam framed as Case B and pointed at study-ai-engineering/05.
