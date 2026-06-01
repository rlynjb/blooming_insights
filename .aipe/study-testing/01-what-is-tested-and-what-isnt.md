# 01 — What's tested and what isn't

**Industry name:** Coverage map / risk map. **Type:** Language-agnostic.

## Zoom out, then zoom in

Before walking individual tests, see where the suite sits in the whole codebase. The 169 vitest tests cluster on the *pure logic* layer — parsers, type guards, codecs, in-memory stores, the agent loop's control flow. The routes that *call* that logic, and the React UI that consumes it, are untested.

```
Zoom out — what has tests vs what doesn't

  ┌─ React UI (components/, app/*/page.tsx) ─────────────────┐
  │  StatusLog, ReasoningTrace, InsightCard, FeedGrid…       │
  │                                                          │
  │                  NO TESTS                                │ ← 0 tests
  └──────────────────────────────────────────────────────────┘
                              ▲
                              │ data + events
  ┌─ HTTP routes (app/api/*) ───────────────────────────────┐
  │  /api/agent (NDJSON stream)   /api/briefing            │
  │  /api/mcp/{call,callback,…}                            │
  │                                                          │
  │                  NO TESTS                                │ ← 0 tests
  └──────────────────────────────────────────────────────────┘
                              ▲
                              │ orchestrates
  ┌─ ★ TESTED LAYER ★  lib/ ─────────────────────────────────┐
  │                                                          │
  │  lib/mcp/*       96 tests   (parsers, codecs, types)     │
  │  lib/agents/*    53 tests   (loop, helpers, agents)      │
  │  lib/state/*      9 tests   (round-trips)                │
  │  lib/insights/*  11 tests   (derived fields)             │
  │                                                          │
  │  TOTAL: 169 vitest tests across 18 files                 │ ← we are here
  └──────────────────────────────────────────────────────────┘
                              ▲
                              │ tool calls (OAuth + MCP)
  ┌─ External: Bloomreach MCP + Anthropic API ──────────────┐
  │  Not tested — faked at the seam (`McpCaller`, scripted   │
  │  Anthropic messages.create)                              │
  └──────────────────────────────────────────────────────────┘
```

Now zoom in. The audit question for every concept file: **does the code that breaks the worst when wrong have the strongest tests?** In this repo the answer is mostly yes for `lib/`, mostly no for `app/api/` and `app/`.

## Structure pass

**Layers (top → bottom):** UI components → HTTP route handlers → lib services → external boundaries. **Axis traced:** *test coverage density* (tests per file). **The seams where the axis flips:**

```
The axis "tests per file" — held constant across every layer

  axis traced = "is this file covered, and how deeply?"

  ┌─ UI layer (components/, app/*/page.tsx) ──────┐
  │  ~10 files   →   0 tests  →  density: 0       │  flip 1: no coverage
  └────────────────────────────┬──────────────────┘  on UI logic
                               │
  ┌─ HTTP route layer (app/api/*) ────────────────┐
  │  ~10 files   →   0 tests  →  density: 0       │  flip 2: no coverage
  └────────────────────────────┬──────────────────┘  on streaming, on
                               │                     303 redirects,
                               │                     on the budget logic
  ┌─ ★ lib service layer ★  (lib/mcp, lib/agents) ┐
  │  ~25 files   →  169 tests →  density: HIGH    │  flip 3: coverage
  │  schema.ts (24), validate.ts (25),            │  concentrates here
  │  client.ts (14), auth.ts (14), base.ts (8)    │
  └────────────────────────────┬──────────────────┘
                               │
  ┌─ External (Bloomreach, Anthropic) ────────────┐
  │  not testable — faked at the boundary         │  flip 4: replaced
  └───────────────────────────────────────────────┘  by fakes
```

The skeleton: **all the coverage is in one band.** The seam between "lib/" and "app/" is where the coverage cliff is. Mechanics (how the agent loop actually runs, how the route streams) hang on this skeleton — it's load-bearing for every concept file that follows.

## How it works

### Move 1 — the mental model

The risk map is a single picture: for every source file under `lib/` and `app/`, count the tests that exercise it. Stack-rank the file list by *how much damage a silent bug there would do* (the agent loop > a layout component). Compare the two lists. A file that is high-damage AND low-coverage is the highest-risk surface. A file that is low-damage AND high-coverage is over-tested. The map names both.

```
The risk map — damage on one axis, coverage on the other

                   high coverage
                       │
                       │   schema.ts (24)    ← good: high-damage, high-coverage
                       │   validate.ts (25)
                       │   client.ts (14)
                       │   base.ts (8)
                       │
        low damage ────┼──── high damage
                       │
                       │
                       │   app/api/agent      ← RISK: high-damage, zero coverage
                       │   app/api/briefing      (NDJSON stream, 300s budget,
                       │   connect.ts            OAuth callback all here)
                       │
                   no coverage
```

The lesson: the diagonal you want is **top-right**. The danger zone is **bottom-right** — high damage, zero tests. blooming insights has three files in the danger zone.

### Move 2 — the walkthrough

**The coverage map, file by file (the actual numbers).** Read every test file, then for every source file, list how many tests reference it (either by import or by exercising its exported surface).

```
lib/mcp coverage (96 tests / 8 files)

  schema.ts            ████████████████████████  24 tests   parseWorkspaceSchema
                                                              + unwrap, fixture-driven
  validate.ts          █████████████████████████ 25 tests   parseAgentJson, isAnomalyArray,
                                                              isDiagnosis, isRecommendationArray
  client.ts            ██████████████             14 tests  cache + retry + rate-limit + error
  auth.ts              ██████████████             14 tests  OAuth provider + cookie crypto
  tool-coverage.ts     ████████                    8 tests  extractToolNames +
                                                              crossCheckToolCoverage
  events.ts            ███████                     7 tests  NDJSON codec round-trips
  transport.ts         ████                        4 tests  capturing fetch + HTTP error enrich
  tools.ts             (none — config registry referenced by tool-coverage tests)
  types.ts             (no runtime, type-only)
  session.ts           ────                        0 tests  cookie session id
  connect.ts           ────                        0 tests  the OAuth connect orchestration

lib/agents coverage (53 tests / 8 files)

  categories.ts        ████████████               12 tests  coverageFor / missingFor /
                                                              schemaCapabilities
  monitoring.ts        ██████████                 10 tests  schemaSummary + scan
  base.ts              ████████                    8 tests  runAgentLoop (all 8 branches)
  intent.ts            ███████                     7 tests  parseIntent
  diagnostic.ts        █████                       5 tests  investigate + synthesis fallback
  recommendation.ts    █████                       5 tests  propose + cap + synthesis
  query.ts             ███                         3 tests  answer + fallback
  tool-schemas.ts      ███                         3 tests  filterToolSchemas

lib/state coverage (9 tests / 2 files)

  insights.ts          █████                       5 tests  anomalyToInsight + put/get/list
  investigations.ts    ████                        4 tests  saveInvestigation + demo seed

lib/insights coverage (11 tests / 1 file)

  derive.ts            ███████████                11 tests  deriveInsightFields +
                                                              diagnosisConfidence + helpers

UNTESTED lib FILES

  lib/mcp/session.ts            cookie-backed sessionId — security-relevant
  lib/mcp/connect.ts            OAuth-connect orchestration — security-relevant
  lib/hooks/useInvestigation.ts client React hook (no React testing infra)
  lib/export/investigationMarkdown.ts  markdown export
  lib/design/tokens.ts          static tokens (no runtime)
```

**The "what isn't tested" verdict.** Three categories of gap. Each gets a separate verdict.

**Gap A — the routes.** `app/api/agent/route.ts` (300-line orchestrator that streams NDJSON events through a Diagnostic→Recommendation pipeline with a 300s `maxDuration` budget), `app/api/briefing/route.ts`, and the `app/api/mcp/*` family have zero tests. The orchestration logic (intent classification → cache check → agent dispatch → NDJSON encoding) is exactly the kind of glue that an integration test would catch a regression on. **Verdict: real gap.** The route is the integration boundary; the lib functions it calls are tested in isolation, but the wiring is not.

**Gap B — the OAuth callback.** `lib/mcp/connect.ts` orchestrates the OAuth handshake (DCR → PKCE → token exchange) and is exercised only end-to-end through the dev server. `consumeState` is tested in `auth.test.ts` (CSRF state); the rest of the connect path is not. **Verdict: real gap, security-relevant.** A regression here is silent — auth would just stop working without a unit test catching it.

**Gap C — the React components.** Components/ and app/page.tsx have zero tests. No `@testing-library/react`, no `vitest-dom` setup. **Verdict: acceptable for the current scope.** This is a portfolio app, not a production product with stakeholders depending on UI invariants; the UI logic is mostly rendering of well-typed lib outputs. Reach for component tests only if a specific UI bug recurs.

### Move 3 — the principle

**Coverage is risk, not percentage.** A `coverage: 80%` badge would tell you nothing about which 20% is missing. The risk map is the better instrument — it says *which surfaces are exposed*, not how many lines have a green dot.

## Primary diagram

The full recap visual — the coverage cliff seen from outside, with the three named gaps:

```
The full coverage map of blooming insights

  ┌─ UI ─────────────────────────────────────────────────────────────────┐
  │  components/* (~10 files)           │ React components               │
  │  app/*/page.tsx (4 routes)          │ pages                          │
  │                                     │                                │
  │   ┌─ tests ─┐                                                        │
  │   │   0     │  ← Gap C: acceptable for current scope                 │
  │   └─────────┘                                                        │
  └─────────────────────────────────────────────────────────────────────┘
                                ▲ rendered
  ┌─ HTTP routes ─────────────────────────────────────────────────────────┐
  │  app/api/agent/route.ts             │ NDJSON stream, 300s budget,    │
  │                                     │ insight → diagnose → recommend │
  │  app/api/briefing/route.ts          │ NDJSON briefing                │
  │  app/api/mcp/callback/route.ts      │ OAuth code exchange            │
  │  app/api/mcp/{call,reset,tools,…}   │ debug / reset                  │
  │                                     │                                │
  │   ┌─ tests ─┐                                                        │
  │   │   0     │  ← Gap A: REAL GAP — orchestration boundary            │
  │   └─────────┘    (event ordering, budget guard, intent dispatch)     │
  └─────────────────────────────────────────────────────────────────────┘
                                ▲ calls
  ┌─ ★ lib services — 169 tests concentrate here ★ ──────────────────────┐
  │                                                                      │
  │  lib/mcp/schema.ts     (24)  ──┐                                     │
  │  lib/mcp/validate.ts   (25)    │                                     │
  │  lib/mcp/client.ts     (14)    │  STRONG: deterministic logic,       │
  │  lib/mcp/auth.ts       (14)    │  fixture-driven, type-guard          │
  │  lib/agents/base.ts    ( 8)    │  rejection paths, scripted-loop      │
  │  lib/agents/categories.ts(12)  │  branches                            │
  │  lib/agents/monitoring.ts(10)  │                                     │
  │  lib/insights/derive.ts (11)  ─┘                                     │
  │  …all 18 test files map here                                         │
  │                                                                      │
  │  lib/mcp/connect.ts       ← Gap B: real, OAuth orchestration silent  │
  │  lib/mcp/session.ts       ← Gap B: real, sessionId derivation silent │
  └─────────────────────────────────────────────────────────────────────┘
                                ▲ tool calls
  ┌─ External (faked at boundary, never reached in tests) ──────────────┐
  │  Bloomreach MCP HTTP    Anthropic Messages API                       │
  └─────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases — where the coverage map decides whether to ship.**

Whenever you change a `lib/mcp/*` parser or a `lib/agents/*` agent: run `npm test`, watch the green bar. Whenever you change an `app/api/*` route handler: the green bar tells you nothing — you have to verify by hitting the route in the browser. That asymmetry is the coverage cliff in practice.

**The test layout, file by file (showing the cliff exists).**

```
test/  (the entire suite)
  ├── agents/
  │   ├── base.test.ts           (8 tests)  → lib/agents/base.ts
  │   ├── categories.test.ts    (12 tests)  → lib/agents/categories.ts
  │   ├── diagnostic.test.ts     (5 tests)  → lib/agents/diagnostic.ts
  │   ├── intent.test.ts         (7 tests)  → lib/agents/intent.ts
  │   ├── monitoring.test.ts    (10 tests)  → lib/agents/monitoring.ts
  │   ├── query.test.ts          (3 tests)  → lib/agents/query.ts
  │   ├── recommendation.test.ts (5 tests)  → lib/agents/recommendation.ts
  │   └── tool-schemas.test.ts   (3 tests)  → lib/agents/tool-schemas.ts
  ├── mcp/
  │   ├── auth.test.ts          (14 tests)  → lib/mcp/auth.ts
  │   ├── client.test.ts        (14 tests)  → lib/mcp/client.ts
  │   ├── events.test.ts         (7 tests)  → lib/mcp/events.ts
  │   ├── schema.test.ts        (24 tests)  → lib/mcp/schema.ts + fixtures/
  │   ├── tool-coverage.test.ts  (8 tests)  → lib/mcp/tool-coverage.ts
  │   ├── transport.test.ts      (4 tests)  → lib/mcp/transport.ts
  │   └── validate.test.ts      (25 tests)  → lib/mcp/validate.ts
  ├── state/
  │   ├── insights.test.ts       (5 tests)  → lib/state/insights.ts
  │   └── investigations.test.ts (4 tests)  → lib/state/investigations.ts
  ├── insights/
  │   └── derive.test.ts        (11 tests)  → lib/insights/derive.ts
  └── fixtures/  (7 captured JSON fixtures of real MCP responses)
       │
       └─ note: there is NO test/api/  and NO test/components/ — the
          coverage cliff IS the missing directories
```

The missing directories are the audit's loudest finding. `test/api/agent.test.ts` would catch a regression in NDJSON event order. `test/api/mcp/callback.test.ts` would catch an OAuth flow break. Neither exists.

**The vitest config — what's in scope, what isn't.**

```
vitest.config.ts (lines 1–10)

  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: {
      environment: 'node',        ← only node, no jsdom → React tests can't run
                                    even if you wrote them, without adding
                                    @testing-library/react and switching env
      include: ['test/**/*.test.ts'],  ← strict glob: only test/ tree,
                                          only .test.ts (not .test.tsx)
      passWithNoTests: true,      ← will not fail CI if a directory has zero
                                    tests — quiet rather than loud about gaps
    },
  });
```

The `passWithNoTests: true` line is itself part of the gap story. It means a new file added to `lib/` with zero coverage will not even register as a problem — you'd have to read the diff and notice. A stricter config (`passWithNoTests: false` and a coverage threshold) would convert silent gaps into loud ones.

## Elaborate

The "tested / untested" cliff is a familiar shape in Next.js apps: route handlers and React components both run inside a framework that's hostile to unit-testing without setup, so people skip both. The lib/ layer is comfortable territory because it's plain TypeScript. The fix is not "test everything" — it's "test the orchestration layer where the lib pieces compose," because that's where most bugs actually happen. In this repo that means `app/api/agent/route.ts` and `lib/mcp/connect.ts`.

Cross-reference: `study-software-design`'s "deep modules are easy to test" finding maps directly here — the deep modules (`schema.ts`, `validate.ts`, `categories.ts`) are the well-tested ones, and that is not a coincidence.

## Interview defense

**Q: Where would you start if a stakeholder asked "what's the biggest testing gap?"** The NDJSON streaming route. `app/api/agent/route.ts` orchestrates intent classification → cache lookup → diagnostic agent → recommendation agent → event stream. Every piece in isolation has tests, but the wiring is unverified. That's where the integration regressions will land first.

```
The integration shape that is untested

  POST /api/agent?step=diagnose&insight=…
                  │
                  ▼
   ┌─ classifyIntent ──┐  ← tested (7)
   │                   │
   ├─ getAnomaly ──────┤  ← tested (5)
   │                   │
   ├─ getCachedInvestigation
   │                   │  ← tested (4)
   ├─ DiagnosticAgent ─┤  ← tested (5)
   │                   │
   ├─ encodeEvent ─────┤  ← tested (7)
   │                   │
   └─ NDJSON stream ───┘  ← NOT TESTED — the wiring
                            (event ordering, error event on throw,
                             done sentinel, 300s maxDuration honored)
```

**Q: 169 tests across 18 files — is that enough?** For the deterministic logic, yes. For the orchestration, no. The deterministic logic has fixture-driven parsers and rejection-path type guards; that surface is where deterministic tests have leverage. The orchestration is where you need an HTTP-level integration test, and there are zero of those.

**Q: Why no React tests?** Honest answer: scope. `vitest.config.ts` has `environment: 'node'` and no `@testing-library/react` dep in `package.json`. Adding component tests is a non-trivial setup investment for a UI surface that is mostly read-only rendering of well-typed lib outputs. Defensible for the current portfolio scope; would be a problem if this had real users.

## Validate

1. **Reconstruct:** Without looking, can you sketch the four-layer diagram (UI → routes → lib → external) and mark which layer has all 169 tests?
2. **Explain:** Why does `vitest.config.ts` (lines 1–10) make React tests structurally impossible without changing the file?
3. **Apply:** A new file `lib/mcp/refresh.ts` is added with a `refreshTokens()` function. Which test file should be created, and what 3 cases should it cover? (Answer: `test/mcp/refresh.test.ts`, with happy path, expired-token path, and network-error path — matching the pattern in `auth.test.ts`.)
4. **Defend:** A reviewer says "every file should have tests." Push back with the risk-map framing — name a file in this repo where you'd NOT add tests, and why.

## See also

- [02-test-design-and-levels.md](02-test-design-and-levels.md) — the pyramid shape, what makes the "scripted Anthropic" pattern an integration test
- [04-determinism-isolation-and-flakiness.md](04-determinism-isolation-and-flakiness.md) — the AUTH_SECRET isolation fix as the canonical post-mortem
- [06-testing-ai-features.md](06-testing-ai-features.md) — the AI-eval gap (Case B), where the would-be evals live
- [07-testing-red-flags-audit.md](07-testing-red-flags-audit.md) — the checklist, marked against this repo
