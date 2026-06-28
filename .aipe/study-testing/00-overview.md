# 00 — Testing overview
*One-page orientation: the suite you have, the seam you're working across, the gap you don't.*

## Zoom out — where testing sits in this system

```
  Zoom out — the testing layer, against the system

  ┌─ UI layer (browser) ─────────────────────────────────────────────┐
  │  React 19 components · NDJSON stream consumer                    │
  │  → not tested with vitest; visual + manual                       │
  └─────────────────────────────┬────────────────────────────────────┘
                                │  fetch / ReadableStream
  ┌─ Service layer (Next.js routes) ───────────────────────────────┐
  │  app/api/briefing/route.ts                                       │
  │  app/api/agent/route.ts             ← INTEGRATION TESTS land here │
  │    (mocked Anthropic SDK + mocked makeDataSource factory)        │
  └─────────────────────────────┬────────────────────────────────────┘
                                │
  ┌─ Agent layer (lib/agents) ──▼────────────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent          │
  │    each takes (anthropic, dataSource, schema, allTools)           │
  │    constructor-injected → tests pass scripted FAKES               │
  │  base-legacy.runAgentLoop      ★ UNIT TESTS land here ★          │
  └─────────────────────────────┬────────────────────────────────────┘
                                │  McpCaller seam (callTool)
  ┌─ Data layer (lib/mcp + lib/data-source) ─────────────────────────┐
  │  BloomreachDataSource · McpClient · SdkTransport · validate.ts   │
  │    unit + integration (cache, timeout, retry, error enrichment)  │
  └─────────────────────────────┬────────────────────────────────────┘
                                │  HTTP+SSE
  ┌─ Provider layer (real network) ──────────────────────────────────┐
  │  Bloomreach loomi-mcp-alpha · Anthropic API                       │
  │  → never hit from the test suite; faked at the seam above        │
  └──────────────────────────────────────────────────────────────────┘
```

We are here for everything above the provider layer. The suite stops at
the seam — no test ever opens a socket to Bloomreach or Anthropic.

## The numbers, blunt

  → **24 test files, 221 tests, all passing.** One command: `npm test`
    (vitest with `passWithNoTests: true`, node environment, `test/**/*.test.ts`).
    See `package.json:25` and `vitest.config.ts:12`.
  → **Zero component tests.** No `.test.tsx`. The UI shape is verified by
    eye on the running dev server, not by the suite.
  → **Zero end-to-end tests.** No Playwright, no Cypress. The route's
    behavior is exercised by integration tests that mock the network at
    the SDK seam, not by driving a real browser through it.
  → **Zero automated LLM evals.** No `eval/` directory in the repo today.
    The suite proves plumbing (control flow, schema shape, parse round-trips,
    error recovery), NOT output quality. The agent's NDJSON trace is the
    inspectable trajectory — humans read it, no harness scores it.

## The seam — deterministic vs probabilistic

```
  what the suite asserts             where probabilistic output is
  (deterministic)                    (untested by this suite)
  ────────────────────────────       ─────────────────────────────
  "given THIS scripted Anthropic     "given a real prompt and real
   response with a tool_use block,    Bloomreach data, does the
   the loop dispatches the tool,      monitoring agent surface the
   feeds the result back, and         RIGHT anomalies, with sound
   stops after 2 turns"                rationale, in the right
                                       severity?"
  → asserted in test/agents/base.test.ts
                                     → would require an eval set +
                                       LLM-as-judge calibration
                                       → that pipeline DOES NOT
                                         EXIST in this repo today
```

The honest framing: today's suite proves that **the wiring around the
LLM is correct** — the tool dispatch, the budget enforcement, the schema
parse, the NDJSON framing, the auth gate. It does NOT prove that the
LLM's output is good. That's a known gap and it's named in lens 6 of
the audit.

## What "shipped + used + retired" means for the eval narrative

There was an `eval/` directory. It ran a four-pillar harness against the
**Olist substrate** (the e-commerce dataset that lived in
`mcp-server-olist` before PR #8 removed it on 2026-06-18). The pillars:

  1. a small gold dataset of (input → expected-judgment)
  2. an LLM-as-judge calibrated by manual K=10 spot-checks
  3. a category-coverage gate (every anomaly type seen at least once)
  4. a "BRL" sentinel that caught a currency-rounding bug before merge

Those four pillars worked. They caught at least one bug that would have
shipped (the BRL rounding). They're a credible interview narrative — and
they're **gone** from the codebase today, retired with the substrate they
ran against. Honest framing: don't claim the eval pipeline is live. Claim
the *experience of building and retiring one* — that's true.

## Where to go next

  → `audit.md` — the 7-lens audit, every lens walked.
  → `01-scripted-anthropic-harness.md` — the pattern that lets every
    agent test run offline.
  → `02-fixture-driven-schema-parser-tests.md` — the eight captured
    JSON envelopes that pin the Bloomreach schema contract.
  → `03-vi-stubenv-isolation.md` — how the auth tests stay
    parallel-safe.
  → `04-acceptance-with-per-gate-rejection.md` — the type-guard
    test discipline.
  → `05-llm-as-judge-as-testing.md` — why this technique is testing
    and not evaluation (Case B, framing).
  → `06-eval-flywheel.md` — the retired four-pillar narrative
    (Case B, honest).
