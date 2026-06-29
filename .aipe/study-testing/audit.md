# audit.md — testing & correctness, 7-lens walk

A blunt scan of what the 24 vitest files (221 tests, all passing) cover
and what they don't. Verdict-first per lens; cross-links to Pass 2
patterns where a finding is load-bearing enough to earn its own file.

## 1. what-is-tested-and-what-isnt

**Verdict: backend logic is well-covered; the UI is naked.** The 221
tests sit on top of `lib/` — the agent loop, the MCP boundary,
validators, derived insight fields, the streaming kernel, the state
maps, and three API routes. The whole React layer — 19 components,
4 hooks, 3 page routes — has zero automated tests.

The risk map, worst-first:

```
  what                                       tests   risk if it breaks
  ─────────────────────────────────────────  ─────   ──────────────────
  React components (InsightCard, Evidence-      0    silent UI regressions;
    Panel, RecommendationCard, ReasoningTrace,        the surface users see
    ToolCallBlock, StatusLog, ...)                    has no safety net
  React hooks (useInvestigation,                 0    StrictMode double-mount
    useBriefingStream, useReconnectPolicy,             bugs, race conditions,
    useDemoCapture)                                    sessionStorage drift
  app/api/mcp/{callback,reset,tools,            0    auth callback bugs land
    capture,capture-demo}/route.ts                     in production silently
  app/page.tsx + app/investigate/[id]/         0    page wiring untested
    {page.tsx, recommend/page.tsx}
  ───────────────────────────────────────────────────────────────────────
  ✓ runAgentLoop (lib/agents/base-legacy)        8    well-covered
  ✓ Monitoring/Diagnostic/Recommendation/        23   well-covered
    Query agents (4 files, scan+propose+
    investigate+answer)
  ✓ McpClient cache + rate-limit + retry         14   well-covered
  ✓ SdkTransport + redaction + timeout           15   well-covered
  ✓ Validators (parseAgentJson, isAnomalyArray,  25   well-covered
    isDiagnosis, isRecommendationArray)
  ✓ Schema bootstrap on real fixtures            24   well-covered
  ✓ /api/briefing + /api/agent integration       17   well-covered
  ✓ Insight + investigation state isolation      16   well-covered
  ✓ AgentEvent NDJSON codec round-trip            7   well-covered
  ✓ readNdjson streaming kernel                   5   well-covered
```

The most important and most complex code (the agent loop, the MCP
client, the streaming codec) is the *most* tested. That's the right
shape. The gap is at the *top* of the stack — the UI, where most of
the user-visible behaviour lives.

→ Pattern files relevant: `01-injected-fake-anthropic-client.md` shows
  how the well-covered half stays deterministic;
  `04-real-fixture-snapshot-test.md` shows the schema-bootstrap
  pinning.

## 2. test-design-and-levels

**Verdict: the pyramid is sound where it exists — unit-heavy with
focused integration on the two streaming routes.** No e2e at all.

```
  the as-built pyramid

  ┌─ E2E ────────────────────────────────────────┐
  │  (none)                                        │
  └────────────────────────────────────────────────┘
  ┌─ Integration (~17 tests) ────────────────────┐
  │  /api/briefing + /api/agent — real route,    │
  │  mocked Anthropic SDK, mocked connectMcp,    │
  │  scripted DataSource. Asserts on NDJSON      │
  │  event sequence, status codes, phase logs.   │
  └────────────────────────────────────────────────┘
  ┌─ Unit (~204 tests) ──────────────────────────┐
  │  agents, MCP client, validators, schema,     │
  │  state, streaming, derive, data-source       │
  └────────────────────────────────────────────────┘
```

The mock surface in the integration tests is precise: only the
*boundary* dependencies (the Anthropic SDK, the connect / session
modules) are mocked. The real route handler, real `runAgentLoop`, real
`bootstrapSchema`, real `parseAgentJson`, real `McpClient` rate-limit
all run. That's the inversion of "mock-everything" anti-pattern — the
mocks are at the edges, the code under test is the middle.

Watch out: the agent tests (`test/agents/*.test.ts`) and the
integration tests carry near-duplicate `buildFakeAnthropic` /
`buildFakeMcp` helpers. The integration tests centralized into
`test/api/_helpers.ts` (good); the per-agent tests re-declare them
in-file (drift risk if one tweaks the Message shape and the other
doesn't). One central helper would close that gap.

→ See `01-injected-fake-anthropic-client.md` for the kernel.

## 3. tests-as-design-pressure

**Verdict: the design is testable because seams were extracted
deliberately.** Two examples that pay rent:

  → `McpCaller` (`lib/agents/base.ts:14`) — the agent-facing port. The
    full `DataSource` can `listTools()`, but the agent loop only needs
    `callTool`. Narrowing the type makes `buildFakeMcp` a one-liner;
    the test never has to stand up a fake `listTools` it'll never
    call. The seam was extracted *because* tests needed it.

  → `McpClient` constructor takes an `McpTransport`
    (`lib/mcp/client.ts`), and `SdkTransport` wraps the real
    `@modelcontextprotocol/sdk` `Client`. The test substitutes a fake
    transport in seven lines (`test/mcp/client.test.ts:5-12`). No
    network, no SDK, no nock — the seam IS the substitution.

```
  Why these seams pay off — the substitution shape

  ┌─ Real path ──────────────────────────────────┐
  │  agent  →  McpClient  →  SdkTransport  →     │
  │                          @mcp/sdk Client  →  │
  │                          loomi MCP server    │
  └─────────────────────────────────────────────┘
                                ▲
                                │  substituted here in tests
                                │
  ┌─ Test path ──────────────────────────────────┐
  │  agent  →  buildFakeMcp({ callTool })        │
  │            ↑                                  │
  │            McpCaller — the narrowest port    │
  └─────────────────────────────────────────────┘
```

→ See `02-mcp-as-callable-port.md`.

One spot where the design *isn't* testable enough to bother yet: the
React hook layer. `useInvestigation` (`lib/hooks/useInvestigation.ts`)
needs a `@testing-library/react` setup that doesn't exist yet, plus a
fake `EventSource`-style stream — it's not impossible, it's
unfounded. That's a coverage gap (lens 1), not a design smell.

## 4. determinism-isolation-and-flakiness

**Verdict: deterministic by construction. Three patterns earn the
calm:**

  → **Injected fakes for every external system.** Anthropic SDK never
    contacted (every test in `test/agents/`). MCP server never
    contacted (every test in `test/mcp/`). `fetch` stubbed via
    `vi.stubGlobal` (`test/mcp/transport.test.ts:18`). No network in
    the entire 6.2-second run.

  → **Fake timers for the rate-limit / retry tests.** `vi.useFakeTimers()`
    drives the 200ms `minIntervalMs`, the 10s `(1 per 10 second)`
    retry-after parser, and the 7s `Retry after ~N seconds` hint
    (`test/mcp/client.test.ts:60-77, 111-167`). The 30-second
    `TOOL_TIMEOUT_MS` is asserted via synchronous rejection rather
    than real elapsed time (`test/mcp/transport.test.ts:107-125`).

  → **Tracked env stubbing.** `vi.stubEnv('AUTH_SECRET', ...)` +
    `vi.unstubAllEnvs()` in `afterEach` (`test/mcp/auth.test.ts:117-122`).
    The comment is explicit about why: direct mutation leaked across
    parallel workers and made the block flaky.

```
  Isolation surfaces — pinned with named tools

  process.env          →  vi.stubEnv / vi.unstubAllEnvs
  global fetch         →  vi.stubGlobal / vi.unstubAllGlobals (afterEach)
  Date.now / setTimeout→  vi.useFakeTimers / vi.useRealTimers
  module-level state   →  beforeEach hooks reset queues + caches
    (anthropicQueue,        (resetAnthropicQueue, _resetSchemaCache,
     _schemaCache,           _clearInvestigationCache, _clearAuthStore,
     investigationCache,     _clear)
     authStore,
     insights map)
```

Cross-session isolation is *itself* tested
(`test/state/insights.test.ts:53-80`) — two sessions writing
concurrently must not overwrite each other. That's the bug the refactor
was meant to fix, pinned with a test that will fail loudly if anyone
ever re-introduces it.

→ See `05-tracked-env-stubbing.md`.

The one ordering trap to know about: every test that calls
`bootstrapSchema` MUST call `_resetSchemaCache()` first
(`test/api/briefing.integration.test.ts:96`). The comment names the
bug ("the second test would skip the bootstrap callTool path
entirely"). It's the right fix; it's also the kind of trap that bites
the next person who adds a new bootstrap test and forgets.

## 5. edge-cases-and-error-paths

**Verdict: the error paths are the well-tested paths.** The validators
get 25 tests, most of which are reject-cases (bad severity, bad
direction, missing fields, non-array, non-object). The agent loop
has explicit tests for `MCP transport failed` (continues to final
text), `maxTurns` hit (returns `''`), `maxToolCalls` reached (forces
final answer without tools). The integration tests cover 401 unauthed,
404 not found, 200-with-error-event-in-stream, and pre-aborted
cancellation.

The standout move is the integration-test cancellation pin:

```typescript
// test/api/briefing.integration.test.ts:312-345
const ac = new AbortController();
ac.abort();                      // pre-abort: deterministic
const req = new NextRequest(url, { signal: ac.signal });
const response = await GET(req);
// asserts: no `done`, no `error`, summary log has aborted: true
```

Pre-aborting sidesteps the race against "did the first chunk land
before the abort fired?" — it's a tiny detail that turns a flaky test
into a deterministic one.

What's NOT tested at the error-path level:

  → The five untested MCP routes (`callback`, `reset`, `tools`,
    `capture`, `capture-demo`) — auth callback bugs and capture-flow
    failures both fall here.
  → React error boundaries — none defined in the codebase, no tests
    for what happens when an `InsightCard` throws mid-render.
  → The browser-side `fetch + stream reader` consumer paths in
    `useInvestigation` / `useBriefingStream`. The server emits an
    `error` event; whether the client handles it correctly is
    unverified.

## 6. testing-ai-features

**Verdict: this is the lens the repo nails.** Every agent test runs
the real `runAgentLoop` against a scripted fake of the SDK type
(`Anthropic.Messages.Message`). The deterministic harness wraps a
probabilistic core — exactly the seam the spec describes.

```
  Deterministic harness around a probabilistic core

  ┌─ Test (deterministic) ───────────────────────────────────┐
  │                                                          │
  │  scripted [msg, msg, msg]  ─►  buildFakeAnthropic        │
  │                                       │                  │
  │                                       ▼                  │
  │                              messages.create()           │
  │                                       │                  │
  │  ┌────────────────────────────────────▼───────────────┐  │
  │  │  real code: runAgentLoop                           │  │
  │  │    parses content blocks                           │  │
  │  │    routes tool_use → buildFakeMcp                  │  │
  │  │    enforces maxTurns / maxToolCalls                │  │
  │  │    fires onText / onToolCall / onToolResult        │  │
  │  └────────────────────────────────────────────────────┘  │
  │                                       │                  │
  │                                       ▼                  │
  │                              { finalText, toolCalls }    │
  │                                       │                  │
  │  expect(result.finalText).toContain('done')              │
  │                                                          │
  └──────────────────────────────────────────────────────────┘

  In production this same loop runs against the real SDK (probabilistic).
  Every part you can test deterministically is tested here.
```

The four agents (Monitoring, Diagnostic, Recommendation, Query) each
have their own test file that exercises:

  → the happy path (scripted JSON parses, returns the parsed shape)
  → the recovery path (first turn returns prose, second turn returns
    JSON — `runRecoveryTurn` fires)
  → the fallback path (both turns fail to parse — fallback shape
    lands, doesn't throw)
  → hook firing (`onText`, `onToolCall`, `onToolResult` called the
    right number of times)
  → the synthesis instruction (only appended on the forced-final
    turn — `test/agents/base.test.ts:361-383`)

The integration tests go a step further: they pin the exact NDJSON
event sequence the route emits, including the phase-timing log shape
in the `finally` block. That's the contract the UI hooks depend on,
and it's mechanically defended.

The eval half — the probabilistic side — is the built-and-retired
arc. The 4-pillar suite + LLM-as-judge ran on the Olist substrate
during Phase 3, calibrated 8/8 against manual spot-check, surfaced
three real bugs (the BRL cents-vs-Reais miscount, a binary-calibration
drift at 29/30, a 30% conclusion-instability rate), and was retired
with PR #8. The next-version target rides the synthetic data source
and is owned by `study-ai-engineering`.

→ See `01-injected-fake-anthropic-client.md` and
  `06-scripted-ndjson-integration-harness.md`.

## 7. testing-red-flags-audit

The consolidated checklist, marked against this repo:

```
  red flag                                          status   evidence
  ────────────────────────────────────────────────  ──────   ──────────
  Heavy mocking that tests the mock                 ✗ clear  mocks are AT
                                                              the seams,
                                                              real code in
                                                              the middle
  Tests that pass/fail on rerun                     ✗ clear  221/221, no
                                                              known flaky
  Tests that need a specific order                  ⚠ one    schema-cache
                                                              reset trap
                                                              (lens 4)
  Inverted pyramid (all e2e, slow, flaky)           ✗ clear  no e2e at all;
                                                              6.2s wall clock
  Zero tests on error/exception branches            ✗ clear  lens 5 is the
                                                              strong half
  Most-important code is the least-tested           ✗ clear  inverse —
                                                              agent loop +
                                                              MCP client are
                                                              the MOST tested
  Untestable code = a design smell                  ✗ clear  McpCaller +
                                                              McpTransport
                                                              seams paid for
                                                              themselves
  LLM feature with no test at the boundary          ✗ clear  every agent
                                                              has scripted-
                                                              SDK tests
  ────────────────────────────────────────────────  ──────   ──────────
  The big one: NO React / hook / page tests         ✓ open   the UI layer
                                                              is the gap
  Five MCP API routes uncovered                     ✓ open   callback /
                                                              reset / tools /
                                                              capture x2
  Per-agent test helpers duplicated (drift risk)    ⚠ mild   integration
                                                              tests centralized;
                                                              agents didn't
  Eval half not in this folder (Case B)             ✗ clear  built / retired;
                                                              next-version
                                                              target lives in
                                                              study-ai-eng
```

**The top finding (worst-first):** the UI layer has no automated
testing. 19 components, 4 hooks, 3 page routes, zero tests. The lib
layer is in great shape; the layer the user actually touches has the
biggest gap. The constructive move: stand up `@testing-library/react`
+ jsdom, start with the two hooks that own the streaming-consumer
state (`useInvestigation`, `useBriefingStream`) — those are where the
race conditions and StrictMode bugs live, and the AgentEvent NDJSON
contract is already test-pinned on the server side, so a hook test can
script the same event sequence and assert what the hook does with it.
