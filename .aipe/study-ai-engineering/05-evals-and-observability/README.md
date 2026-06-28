# 05 — evals and observability

**Case B for evals.** The honest current state: **no automated LLM eval
harness in repo today**. Unit tests with fake MCP adapters cover the
*agent loop* logic (24 files, 221 passing), but there's no LLM-as-judge,
no golden set, no regression suite for diagnosis quality.

Observability is **lightweight but present**: `console.log` calls from
`AnthropicModelProviderAdapter` (per-request `usage` + per-route phase
summary in `app/api/agent/route.ts:331-338`). No tracing platform, no
dashboards beyond Vercel's log search.

## Files

```
01-eval-set-types.md         ← golden / adversarial / regression (Case B)
02-eval-methods.md           ← exact match / fuzzy / rubric / judge (Case B)
03-llm-as-judge-bias.md      ← position / verbosity / self-preference (Case B)
04-llm-observability.md      ← traces / spans / replay (partial)
```

## What's pattern-only (Case B) in this section

All of 01-03. blooming insights has tests but no evals. The distinction:

  → **Tests** check that code behaves as specified given mocked inputs
    (24 files, 221 passing). Fast, deterministic, scoped to functions.
  → **Evals** check that the LLM produces quality outputs given real
    inputs. Slow, non-deterministic, scoped to whole agent loops.

The existing test suite is in good shape (see `test/agents/`,
`test/mcp/`, `test/data-source/`, `test/streaming/`). The eval suite
doesn't exist yet.

## What's partially exercised

  → **`04-llm-observability.md`** — per-call `usage` log
    (`lib/agents/aptkit-adapters.ts:57-61`) and per-route phase summary
    (`app/api/agent/route.ts:331-338`) exist. What's missing: per-call
    DB row aggregation, tracing platform (Langfuse / Phoenix / etc.),
    replay capability against past traces. Pattern teaches what those
    would look like.

## What's load-bearing for *next steps*

If you had a week to add LLM evals to this codebase, the order would be:

  1. **Build a golden set** for the diagnostic agent (10-20 hand-curated
     anomaly→diagnosis pairs). Stored in
     `test/fixtures/golden-diagnoses.json`.
  2. **Write an LLM-as-judge** that scores generated diagnoses against
     the golden ones on a rubric (correct cause? right evidence cited?
     right hypotheses considered?). Use a different model family from
     the agent (e.g. GPT-4 to judge Claude) to reduce self-preference
     bias.
  3. **Wire to CI** so every commit runs the eval on the golden set;
     PRs that drop the score below threshold get flagged.

The exercise blocks in each file name the slice that file's pattern
would own.
