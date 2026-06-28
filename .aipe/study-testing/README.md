# study-testing — reading order + map

The question this study answers: **how do you know the code works — and will
keep working after the next change?**

In blooming insights that question has two halves, and the partition between
them is the spine of the whole guide:

```
  THE DETERMINISM SEAM — what's in this guide and what isn't

  ┌─ DETERMINISTIC correctness (this guide) ─────────────────────────┐
  │  given known input → assert known output                          │
  │  the suite is `npm test` (vitest)                                 │
  │  24 files, 221 tests, all passing                                 │
  │  proves PLUMBING: schema parsers, agent loop control flow,        │
  │  route shape, NDJSON framing, auth round-trips                    │
  └──────────────────────────────────────────────────────────────────┘
                              │
                              │  meets here when you test
                              │  an AI feature: a deterministic
                              │  harness wraps a probabilistic core
                              ▼
  ┌─ PROBABILISTIC evaluation (study-ai-engineering, not here) ──────┐
  │  is the model's output "good enough"?                            │
  │  did it regress on a non-deterministic surface?                  │
  │  THIS REPO HAS NO EVAL HARNESS TODAY.                            │
  │  it had one (Phase 3, retired with the Olist substrate) —        │
  │  the pattern is real, the substrate is gone.                     │
  └──────────────────────────────────────────────────────────────────┘
```

If the assertion is `expect(x).toBe(y)`, it's testing — it belongs in this
guide. If the assertion is "the LLM's diagnosis is on-topic," it's
**evaluation** and lives in `study-ai-engineering`. State which half a
finding is.

## How to read this

```
  1. 00-overview.md       one-page orientation
                          the deterministic/probabilistic seam, the suite
                          you've got, the gap you don't have
                          ★ start here

  2. audit.md             the 7-lens audit (Pass 1)
                          every lens walked against this repo, with
                          file:line grounding or honest "not yet exercised"

  3. 01- through 06-      discovered patterns (Pass 2)
                          one file per testing technique the repo
                          deliberately exercises
```

## The pattern files

Six patterns earn a file. Each one names what the suite stops catching if
you strip it out:

```
  01-scripted-anthropic-harness.md
       constructor-injected fake of the Anthropic SDK +
       BloomingToolRegistryAdapter — drives multi-turn agent loops
       through scripted responses, no network
       strip it: lose every agent-loop test (control-flow, budgets,
       cancellation, error recovery)

  02-fixture-driven-schema-parser-tests.md
       eight captured JSON envelopes from the live Bloomreach MCP
       server, replayed through unwrap() + parseWorkspaceSchema()
       strip it: schema drift goes undetected until production

  03-vi-stubenv-isolation.md
       per-test env stubbing with stubEnv/unstubAllEnvs for cookie
       crypto + auth-mode tests, isolated across parallel workers
       strip it: AUTH_SECRET leaks across files and flakes the suite

  04-acceptance-with-per-gate-rejection.md
       type-guard tests (isAnomalyArray, isDiagnosis, isRecommendationArray)
       pair one "well-formed accepts" with one rejection per field/enum
       strip it: bad agent output corrupts the UI shape silently

  05-llm-as-judge-as-testing.md
       LLM-as-judge IS a deterministic harness from this guide's seat
       (you assert a structured verdict from a probabilistic core).
       Pattern is real; substrate is gone — Case B (shipped, used,
       retired with the Olist domain).

  06-eval-flywheel.md
       the four-pillar eval loop (gold dataset → LLM judge →
       category coverage → flywheel back to the prompts) — built
       once for the previous substrate, retired. Case B. Honest
       framing: the discipline is on your résumé; the pipeline
       is not in this repo.
```

## Cross-links

  → "Hard to test" findings (deep coupling, untestable side effects) live
    in `study-software-design`, not here.
  → Eval pipeline patterns and LLM-as-judge concept depth live in
    `study-ai-engineering`. This guide only covers the **deterministic
    seam** that wraps the eval — the test harness around the call.
  → The streaming contract (`AgentEvent` NDJSON) tested in
    `test/streaming/ndjson.test.ts` is also a system-design seam; see
    `study-system-design` for the routing/transport view.
