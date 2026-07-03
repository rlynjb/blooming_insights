# 00 — Overview

The one-page snapshot. Numbers first, then the map, then the three
gaps that would catch the most production regressions, then the
lens verdicts.

═════════════════════════════════════════════════
THE NUMBERS
═════════════════════════════════════════════════

```
  Test suite — as of runId 2026-07-03T04-08-28-644Z

  Deterministic suite       261 tests · 26 files · Vitest · node env
    baseline pre-hardening   221
    + Weeks 2-4 hardening    +24
    + Session B (auth-prov)  +24
    + Session D (config)     +23
                             ────
                             261 currently

  Eval harness              10 goldens · offline · $0.15/case
    diagnosis-quality        4 dimensions
    recommendation-quality   4 dimensions
    calibration              blind judge-vs-human, 3 metrics
    load harness             semaphore worker pool, distribution stats
    regression gate          committed baseline.json, 10pp threshold

  CI                         .github/workflows/ci.yml
                              typecheck + npm test + npm run build
                              (lint deferred — 28 pre-existing errors)
```

═════════════════════════════════════════════════
THE COVERAGE MAP — where the risk is
═════════════════════════════════════════════════

Not a % number — a **risk map.** Each cell says: is the critical
path here tested? If yes, at which level?

```
  Coverage — the load-bearing surfaces

  ┌─ Client / UI layer ────────────────────────────────────────┐
  │  components/**/*.tsx        NOT TESTED   20 files          │
  │  lib/hooks/use*.ts          NOT TESTED   4 files           │
  │  app/**/page.tsx            NOT TESTED   (impl detail)     │
  │                                                            │
  │  → largest untested surface. See gap #1.                   │
  └─────────────────────────┬──────────────────────────────────┘
                            │  fetch + NDJSON
  ┌─ Route layer ───────────▼──────────────────────────────────┐
  │  app/api/briefing/route.ts  INTEGRATION   7 tests          │
  │  app/api/agent/route.ts     INTEGRATION  10 tests          │
  │  app/api/mcp/**             UNIT (allowlist only)   3      │
  │                                                            │
  │  → happy path + 4 error branches + cancellation covered    │
  └─────────────────────────┬──────────────────────────────────┘
                            │
  ┌─ Agent layer ───────────▼──────────────────────────────────┐
  │  lib/agents/base.ts         UNIT          8 tests          │
  │  lib/agents/monitoring.ts   UNIT         10 tests          │
  │  lib/agents/diagnostic.ts   UNIT          5 tests          │
  │  lib/agents/recommendation  UNIT          5 tests          │
  │  lib/agents/query.ts        UNIT          3 tests          │
  │  lib/agents/intent.ts       UNIT          7 tests          │
  │  lib/agents/categories.ts   UNIT         12 tests          │
  │                                                            │
  │  → densest layer. Scripted-Anthropic-fake carries this.    │
  └─────────────────────────┬──────────────────────────────────┘
                            │
  ┌─ MCP / auth / config ───▼──────────────────────────────────┐
  │  lib/mcp/client.ts          UNIT         14 tests          │
  │  lib/mcp/auth.ts            UNIT         14 tests          │
  │  lib/mcp/auth-providers/    UNIT         17 tests    NEW   │
  │  lib/mcp/config.ts          UNIT         23 tests    NEW   │
  │  lib/mcp/schema.ts          UNIT         24 tests          │
  │  lib/mcp/transport.ts       UNIT         15 tests          │
  │  lib/mcp/events.ts          UNIT          7 tests          │
  │  lib/mcp/validate.ts        UNIT         25 tests          │
  │  lib/mcp/tool-coverage.ts   UNIT          8 tests          │
  │                                                            │
  │  → deepest coverage in the repo. Fixture-anchored          │
  │    (test/fixtures/*.json) locks the wire format.           │
  └─────────────────────────┬──────────────────────────────────┘
                            │
  ┌─ State + streaming ─────▼──────────────────────────────────┐
  │  lib/state/insights.ts      UNIT         12 tests          │
  │  lib/state/investigations.ts UNIT         4 tests          │
  │  lib/streaming/ndjson.ts    UNIT          5 tests          │
  │  lib/insights/derive.ts     UNIT         11 tests          │
  │                                                            │
  │  → NDJSON kernel reused between prod code and tests via    │
  │    collectEvents(). See pattern 03.                        │
  └────────────────────────────────────────────────────────────┘
```

═════════════════════════════════════════════════
THE THREE HIGHEST-LEVERAGE GAPS
═════════════════════════════════════════════════

Ranked by "would production notice if this broke?"

### 1. Client hooks and streaming consumers (`lib/hooks/use*.ts`)

**File:** `lib/hooks/useInvestigation.ts`, `useBriefingStream.ts`,
`useReconnectPolicy.ts`, `useDemoCapture.ts` (4 files, ~zero tests)
**Why it matters:** every page depends on these; a stale-state or
StrictMode-double-mount bug here breaks the demo. The comment in
`useInvestigation.ts` warns that it "survives StrictMode by NOT
cancelling the in-flight fetch on cleanup" — that's a load-bearing
invariant with no test defending it. The route's cancellation path
IS tested (`briefing.integration.test.ts:312-345`); the client half
of the same seam isn't.
**Determinism side:** deterministic (React hooks with mocked
`fetch` + `ReadableStream`). Belongs here.
**First test to write:** a jsdom test that mounts `useInvestigation`
with a scripted `ReadableStream`, unmounts it before the stream
finishes, remounts it, and asserts the stashed result loads
instantly from `sessionStorage`.

### 2. Component render + click-through (`components/**/*.tsx`)

**File:** `components/feed/InsightCard.tsx`,
`components/investigation/EvidencePanel.tsx`,
`components/investigation/RecommendationCard.tsx`,
`components/shared/StatusLog.tsx` (20 `.tsx` files, no tests)
**Why it matters:** all the derived-field logic tested in
`test/insights/derive.test.ts` feeds into these components. The
derive logic is unit-tested; the render is not. A broken
`impactAssumption` fallback or a wrong `SeverityBadge` color would
still ship green.
**Determinism side:** deterministic (React Testing Library, given
input → known DOM). Belongs here.
**First test to write:** `InsightCard` with each of the 4 severities +
a card that has `impact` vs a card that falls back to the derived
label — assert the DOM text matches the derived-field contract.

### 3. Investigation markdown export (`lib/export/investigationMarkdown.ts`)

**File:** `lib/export/investigationMarkdown.ts` (no tests)
**Why it matters:** the export button on both investigate pages
depends on this. It's the artifact users take out of the product —
a broken export is a broken portfolio demo. Pure function of
`{Insight, Diagnosis, Recommendation[]}` → string; trivially
snapshot-testable.
**Determinism side:** deterministic (pure function). Belongs here.
**First test to write:** a golden-string test for one full trio
(insight + diagnosis + 2 recommendations) — pin the exact markdown
output. Regressions in heading levels or bullet ordering block the PR.

═════════════════════════════════════════════════
LENS VERDICTS — one line each
═════════════════════════════════════════════════

For the full walk see `audit.md`.

```
  Lens                                       Verdict
  ─────────────────────────────────────────────────────────────────
  1. what-is-tested-and-what-isnt            server dense, client sparse
  2. test-design-and-levels                  right pyramid, sensible fakes
  3. tests-as-design-pressure                seams earn their tests
  4. determinism-isolation-and-flakiness     fake timers + stubEnv discipline
  5. edge-cases-and-error-paths              fail-safe contracts explicit
  6. testing-ai-features                     seam pattern shipped end-to-end
  7. testing-red-flags-audit                 3 red flags firing (see audit)
```

═════════════════════════════════════════════════
IF YOU ONLY READ THREE FILES AFTER THIS ONE
═════════════════════════════════════════════════

- **`audit.md`** — the 7-lens walk with `file:line` grounding for
  every finding
- **`01-scripted-anthropic-fake.md`** — the strongest test-design
  pattern in the repo; without it, no agent test could exist
- **`06-fail-safe-decode-contract-tests.md`** — the newest pattern
  (Session D) that locks the wire format across a security-adjacent
  seam
