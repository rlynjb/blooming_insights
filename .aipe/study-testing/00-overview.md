# Overview — the audit at a glance

## Verdict

**A strong deterministic suite bolted to a load-bearing eval subsystem, both
converging on the same DataSource seam.** 221 vitest cases run in `npm test`
with zero network and zero flake sources I could find. Ten rubric-judged
golden cases run in `npm run eval` against real Anthropic, with a committed
baseline and a regression gate wired for CI. That combination — deterministic
harness *plus* probabilistic evaluator sharing one abstraction — is the
architectural win of this repo's test strategy.

**The suite's job is done well at the seams it chose to defend.** The
untested surface is the client (React components, hooks, `app/` route
handlers as HTTP shells). That's a deliberate scope call — this codebase's
correctness risk is in the agent loops and the MCP boundary, and both are
tested exhaustively. But it means a UI regression will not be caught by CI.

**One thing to fix first (see gap #1 below):** integration tests for
`app/api/agent/route.ts` and `app/api/briefing/route.ts` exist and are good,
but the `useInvestigation` / `useBriefingStream` client hooks that consume
those NDJSON streams are **completely untested**. That's the exact seam
where an `AgentEvent` shape change would surface in production before it
surfaces in CI.

---

## Coverage map — risk-ranked, not percentage-ranked

```
   Area                                     Tests?    Risk if broken
   ──────────────────────────────────────   ──────    ──────────────────────
   lib/agents/base + monitoring /                    everything downstream
     diagnostic / recommendation / query    YES       breaks; agent output
                                            (5 files) is wrong; JSON parse
                                                      throws
   lib/mcp/client (cache + rate-limit +               live traffic 429s and
     retry ladder)                          YES       loses recovery; caches
                                                      errors
   lib/mcp/auth (OAuth + encrypted cookie   YES       auth breaks silently;
     store)                                           tokens leak or vanish
   lib/mcp/transport (fetch capture +                 error messages become
     error enrichment)                      YES       useless in prod
   lib/mcp/schema (bootstrap parsing        YES       schema drift breaks
     against real captured fixtures)                  every downstream agent
   lib/mcp/validate + tool-coverage         YES       agent output parses as
                                                      wrong shape and 500s
   lib/data-source (Synthetic +             YES       eval + prod share this
     BloomreachDataSource seam)             (Synthetic port; break it and both
                                             tested)  fail
   lib/state/{insights,investigations}      YES       cross-session leaks,
                                                      cache bugs
   lib/streaming/ndjson (parser)            YES       every UI stream breaks

   app/api/briefing + app/api/agent         YES       route contract drift
     (route integration tests)              (2 files) → UI can't hydrate

   lib/hooks/useInvestigation               NO        stream cancellation,
                                                      sessionStorage rehydrate,
                                                      StrictMode double-invoke
   lib/hooks/useBriefingStream              NO        auto-reconnect on
                                                      invalid_token
   lib/hooks/useReconnectPolicy             NO        same
   lib/hooks/useDemoCapture                 NO        dev-only, low risk
   components/**/*.tsx                      NO        UI regressions

   lib/mcp/session (cookie AsyncLocalStorage) NO      touched from many places;
                                                      no direct unit test
   lib/mcp/connect (redirect URI /          NO        indirectly hit via API
     host-based)                                     integration tests only
   lib/export/investigationMarkdown         NO        low-frequency use
   app/**/page.tsx (server pages)           NO        thin shells, low risk
   lib/agents/prompts/*.md                  N/A       assertions on prompt
                                                     text are eval-territory
```

Everything above the blank line has real risk if it breaks and has a test.
Everything below has some risk and doesn't. The next section says which of
the untested items to close first.

---

## The three highest-leverage gaps

Ranked by "regression this test would catch that will otherwise hit
production."

### 1. `lib/hooks/useInvestigation.ts` — NDJSON consumer contract

The client hook that drives the investigation UI. It calls `/api/agent`,
reads the NDJSON stream, buffers `reasoning_step` and `tool_call_*` events,
finalizes on `diagnosis` and `recommendation`, stashes the result in
`sessionStorage`, and — deliberately — does NOT cancel the in-flight fetch on
React StrictMode's double-invoke cleanup. That last decision is the exact
kind of thing a test would pin. Right now the route producer is tested
(`test/api/agent.integration.test.ts`) and the parser is tested
(`test/streaming/ndjson.test.ts`), but the consumer that stitches those two
together is not. A change to `AgentEvent`'s discriminated union, a rename in
the diagnosis shape, or an accidental `signal.abort()` in the cleanup would
all break this hook in production before failing any test.

**The first three tests to write:**

1. Hook consumes a scripted NDJSON stream and finalizes `diagnosis` +
   `recommendations` state correctly across the discriminated-union
   event types.
2. Hook does NOT cancel the fetch when the effect cleanup fires (the
   StrictMode-survival contract — it's documented in the hook file but
   only tested by "does the demo work in prod").
3. Hook re-hydrates from `sessionStorage` on remount without re-fetching
   (the back-nav-from-step-3 contract).

**Determinism seam:** deterministic. The producer is scripted, the assertions
are exact-match on state.

### 2. `lib/mcp/session.ts` — no direct test

Session ID cookie handling with `AsyncLocalStorage` in prod and a file store
in dev. Used by every route that touches Bloomreach. The integration tests
mock this surface entirely (`vi.mock('../../lib/mcp/session', …)` in both
briefing and agent integration tests), so the real implementation runs
untested. Given the file store's role in dev auth reliability and the fact
that `getOrCreateSessionId` is on the critical path for both routes, one
regression here breaks everything downstream.

**The first three tests to write:**

1. `readSessionId` returns `null` when no cookie is present (currently
   asserted only via mock).
2. `getOrCreateSessionId` generates a stable id on repeated calls within
   the same `AsyncLocalStorage` context.
3. File-store dev path round-trips a session id across a mock cookie
   header round-trip.

**Determinism seam:** deterministic.

### 3. `test/agents/base.test.ts` still imports `base-legacy`

`test/agents/base.test.ts` line 4: `import { runAgentLoop, AGENT_MODEL } from
'../../lib/agents/base-legacy'`. The new base (`lib/agents/base.ts`) is what
the production route uses; the legacy path is tested but the shipping code
is not exercised by these 15+ unit tests directly. Also
`test/agents/synthesis-instruction.test.ts` line 12 imports from `base-legacy`.
The tests pass, but they may be pinning a shape the production code no
longer holds.

**The fix:** rename the imports to `lib/agents/base` (if the surface is
compatible) or explicitly document which tests are meant to stay against
legacy while the new base grows its own tests. Either way, the situation
where legacy is tested and prod isn't is the exact seam that gets ignored
until it silently breaks.

**Determinism seam:** deterministic.

---

## One-line verdict per lens

Full walk in `audit.md`. Each verdict here is the summary of the section
below.

- **what-is-tested-and-what-isnt** — critical MCP + agent paths well
  covered; client hooks + components entirely uncovered; the risk shape is
  right for a backend-heavy app.
- **test-design-and-levels** — pyramid shape is correct: unit tests for
  pure logic + agent loops with injected fakes, three integration tests
  covering both API routes end-to-end, one wall-crossing suite (evals) at
  the top. No e2e/browser tests — deliberate choice.
- **tests-as-design-pressure** — the `DataSource` port and the
  `runAgentLoop`-with-injected-Anthropic pattern are testable *because*
  they were designed for testability. The client hooks are untestable
  *because* they aren't — `useInvestigation` reads `sessionStorage` and
  triggers fetches from inside `useEffect` with no seam to intercept.
  Cross-link → `study-software-design`.
- **determinism-isolation-and-flakiness** — I could not find a flaky test.
  Every timing-dependent test uses `vi.useFakeTimers()`; every module
  mock resets in `beforeEach`; env vars use `vi.stubEnv`. The scripted
  Anthropic queue is drained per-test with `resetAnthropicQueue()`.
- **edge-cases-and-error-paths** — good on error paths (rate-limit retry,
  parse errors, malformed NDJSON lines, judge-error placeholders). Less
  strong on empty-collection edges; a couple of "returns []" branches
  aren't explicitly asserted.
- **testing-ai-features** — this is where the repo excels. The
  determinism seam is not just talked about, it's *architected*: the
  `DataSource` port lets a fake fixture drive unit tests, `Synthetic` drives
  evals, `FaultInjecting` drives load with failures. Rubrics carry
  gated/measured signal-class logic. Baseline + regression gate exist.
- **testing-red-flags-audit** — 2/12 red flags firing. No inverted pyramid,
  no shared-mutable-state tests, no ordering dependencies. The two firing
  are: (a) the client hooks are untested, and (b) an isolated `base-legacy`
  import lingers in two test files.
