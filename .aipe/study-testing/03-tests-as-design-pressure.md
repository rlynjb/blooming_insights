# 03 — Tests as design pressure

**Industry name:** Testability as a design property / dependency injection at the seam. **Type:** Industry standard.

## Zoom out, then zoom in

Tests don't just verify code — they shape it. When code is hard to test, that's a *design* signal: tangled dependencies, hidden state, no seam to inject a fake at. blooming insights got this mostly right in `lib/` (deep, pure modules, dependency injection at the boundary) and mostly wrong where the seams are awkward (`lib/mcp/connect.ts`, the `app/api/*` routes).

```
Zoom out — where the codebase made testability easy vs hard

  ┌─ DESIGN MAKES TESTING EASY ────────────────────────────────────────┐
  │                                                                    │
  │  lib/mcp/client.ts                                                 │
  │     constructor(private transport: McpTransport, opts) {…}         │  ← seam: inject
  │                                                                       a fake transport
  │  lib/agents/base.ts                                                 │
  │     interface McpCaller { callTool(...) }                          │  ← seam: inject
  │     runAgentLoop({ anthropic, mcp, … })                            │   a fake caller
  │                                                                     │   AND a fake
  │                                                                     │   Anthropic
  │  lib/mcp/auth.ts                                                    │
  │     export const _authCookieCrypto = { encrypt, decrypt }          │  ← test-only export
  │     export function _clearAuthStore() { … }                        │   for isolation
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ DESIGN MAKES TESTING HARD ────────────────────────────────────────┐
  │                                                                    │
  │  app/api/agent/route.ts                                            │  ← no DI: imports
  │     import { connectMcp } from '@/lib/mcp/connect'                 │   `connectMcp`
  │     import Anthropic from '@anthropic-ai/sdk'                      │   directly; no way
  │     export async function GET(req) { … }                           │   to inject a fake
  │                                                                     │   without vi.mock
  │  lib/mcp/connect.ts                                                 │
  │     OAuth orchestration that touches next/headers cookies,         │  ← reads request
  │     env vars, and the auth store all in one function                │   context implicitly
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘
```

Now zoom in. The mechanism we care about is *the seam*: a boundary in the code where you can substitute a fake without rewriting either side. Where blooming insights has good seams, it has good tests. Where it doesn't, it doesn't.

## Structure pass

**Layers:** parameter (the in-function level) → constructor (the class level) → import (the module level) → framework (the route level). **Axis traced:** *can I substitute this dependency without forking the source?* **The seams where the answer flips:**

```
The axis "can I inject a fake here?" — held constant up the stack

  axis traced = "is there a seam?"

  ┌─ parameter injection (in-function) ──────────┐
  │  parseAgentJson(text: string)                │  YES — pass any string,
  └──────────────────────┬───────────────────────┘  no setup needed

  ┌─ constructor injection (class) ──────────────┐
  │  new McpClient(transport, opts)              │  YES — pass any McpTransport
  │  new DiagnosticAgent(anthropic, mcp, …)      │  YES — pass any fake
  └──────────────────────┬───────────────────────┘    that satisfies the interface

  ┌─ function-options injection (record-of-deps) ┐
  │  runAgentLoop({ anthropic, mcp, … })         │  YES — pass fakes in
  └──────────────────────┬───────────────────────┘    the options bag

  ┌─ ★ module-level import (no DI) ★ ────────────┐
  │  app/api/agent/route.ts                       │  FLIP HERE — must use
  │    import Anthropic from '...'                │  vi.mock to swap the import,
  │    import { connectMcp } from '...'           │  and vi.mock has limits in
  │                                               │  ESM/Next; the lack of an
  │                                               │  injection seam is what
  │                                               │  makes the route hard to test
  └──────────────────────┬───────────────────────┘

  ┌─ framework-implicit (next/headers) ───────────┐
  │  await (await cookies()).get('bi_session')    │  WORST — reads an implicit
  │  (inside lib/mcp/session.ts, lib/mcp/auth.ts) │  request context that exists
  └───────────────────────────────────────────────┘  only inside a Next request
```

The seam shifts location at every layer. The lib layer's seams are explicit (constructor, parameter, options); the route layer's seams are implicit (module imports, request context). That difference is exactly why lib has 169 tests and routes have zero.

## How it works

### Move 1 — the mental model

A seam is the bolt where two parts of a system join — and where a test can interpose. The strongest form is **dependency injection**: the dependency arrives through a parameter or constructor, the caller chooses what to pass, the test passes a fake. The weakest form is **a hardcoded import** — to swap it you have to mutate the module system itself (vi.mock, which works for ESM but is brittle and breaks ergonomics).

```
The seam — the shape that lets you substitute a fake

  ┌─ CODE under test ───────────────────┐
  │                                     │
  │  function doWork(transport) {       │  ← parameter is the seam
  │    transport.callTool(...)          │
  │  }                                  │
  └──────────────────────┬──────────────┘
                         │
            ┌────────────┴────────────┐
            │                         │
            ▼                         ▼
       production                  test
  ┌──────────────┐            ┌──────────────┐
  │ SdkTransport │            │ fakeTransport│
  │ (real HTTP)  │            │ (returns     │
  └──────────────┘            │  scripted    │
                              │  values)     │
                              └──────────────┘

  the SEAM is the parameter type; both ends satisfy McpTransport
```

### Move 2 — the walkthrough

#### Seam type 1 — the `McpCaller` interface (the textbook example)

**The shape.** `lib/agents/base.ts` defines `McpCaller` as a *minimal* interface — just the methods the agent loop calls. The real `McpClient` *structurally* satisfies it; a test can satisfy it with a 5-line literal.

```
McpCaller — the interface IS the seam

  lib/agents/base.ts
  ┌────────────────────────────────────────────────┐
  │ interface McpCaller {                          │
  │   callTool(name, args, opts?): Promise<{       │  ← every test in
  │     result: unknown;                            │     test/agents/*.test.ts
  │     durationMs: number;                          │     uses this seam
  │     fromCache: boolean;                          │
  │   }>;                                            │
  │ }                                                │
  └─────────────────────┬──────────────────────────┘
                        │
        ┌───────────────┴──────────────┐
        │                              │
        ▼                              ▼
  ┌─ production ──────┐         ┌─ test ──────────────┐
  │ class McpClient   │         │ function buildFakeMcp()
  │  callTool(…) {…}  │         │  return {
  │  // ↑ retries,    │         │    async callTool() {
  │  //   cache,      │         │      return { result: {ok:1},
  │  //   rate limit, │         │              durationMs: 1,
  │  //   tag errors  │         │              fromCache: false };
  │ }                 │         │    }
  └───────────────────┘         │  }
                                 └─────────────────────┘
```

**Why this is load-bearing.** Drop the interface and the agent code would have to depend on the concrete `McpClient`, which means every test would have to construct a real `McpClient` with a fake transport. The interface compresses the surface from "everything `McpClient` does" to "the one method the agent calls." That compression is what makes the test fake five lines instead of fifty.

**The boundary condition.** The interface is *structurally* matched, not nominally — Vitest's `buildFakeMcp` doesn't `implements McpCaller`, it just *shapes* like one and TypeScript accepts it. Useful for tests; risky if the interface drifts and the fake silently goes stale. Mitigation in this repo: `McpCaller` has been stable since the agent layer landed.

#### Seam type 2 — the `transport` constructor parameter on `McpClient`

**The shape.** Same idea, one layer deeper. `McpClient` takes a `McpTransport` in its constructor, and the test passes a fake transport that returns scripted values per tool name.

```
McpClient's transport seam — visible in test/mcp/client.test.ts

  test/mcp/client.test.ts (lines 5–12)

  function fakeTransport(impl) {
    const t = {
      calls: 0,
      async callTool(name) { t.calls++; return impl(name); },  ← scripted per call
      async listTools() { return { tools: [] }; },             ← no real network
    };
    return t;
  }

  // then in tests:
  const t = fakeTransport(() => ({ ok: 1 }));
  const c = new McpClient(t);              ← inject the fake at construction
  const r = await c.callTool('whoami', {});
  expect(r.fromCache).toBe(false);          ← assert on the REAL McpClient's
                                              cache + retry logic
```

**Why this is load-bearing.** All 14 tests in `client.test.ts` use this seam. The rate-limit retry tests (lines 101–167) use `vi.useFakeTimers()` + the scripted transport to advance time deterministically — that's only possible because the transport is injectable. Drop the seam and you'd have to either ship a real HTTP server in the test or skip the retry coverage entirely.

#### Seam type 3 — test-only exports (`_clearAuthStore`, `_authCookieCrypto`)

**The shape.** Sometimes a clean seam doesn't exist — the module has internal state (the in-memory store, the request-scoped AsyncLocalStorage). Rather than letting the test mutate it sideways, the module *exports* a deliberately-named test-only helper.

```
lib/mcp/auth.ts (lines 244–259)

  /** test-only — exercise the production cookie crypto without a request context. */
  export const _authCookieCrypto = {
    encrypt: (store) => encryptStore(store),
    decrypt: (token) => decryptStore(token),
  };
       │
       └─ the leading underscore is the convention saying "not for production
          use." It exposes the internal AES-256-GCM round-trip so the test can
          assert on it without spinning a full Next request context.

  /** test-only */
  export function _clearAuthStore() {
    memStore.clear();
    if (PERSIST) { try { writeFileSync(CACHE_FILE, JSON.stringify({})); } catch { … } }
  }
       │
       └─ this is the isolation seam every auth test relies on. Without it,
          test order would matter — saving tokens in test 1 would leak into
          test 2. See 04-determinism-isolation-and-flakiness.md for the rest.
```

**Why this is load-bearing.** Without `_clearAuthStore`, every test in `auth.test.ts` would have to either run in a fresh worker (slow) or accept order-dependence (flaky). Without `_authCookieCrypto`, the production cookie crypto code would have zero tests because the only way to reach `encryptStore`/`decryptStore` is through `withAuthCookies`, which requires a Next request context.

**The boundary condition.** Test-only exports are a *controlled* leak of internals. The convention (`_` prefix) keeps them out of the public surface; an over-zealous tree-shaker or a linter rule banning underscore exports would break the test suite. Acceptable cost.

#### Seam type 4 — the route handler (THE MISSING SEAM)

**The shape that doesn't exist.** `app/api/agent/route.ts` imports its dependencies directly: `Anthropic` from the SDK, `connectMcp` from `lib/mcp/connect`. There's no parameter, no constructor, no options bag to swap. To test it you'd have to use `vi.mock` to replace the imports — workable, but fragile, and nobody has done it.

```
app/api/agent/route.ts (lines 1–16, abridged)

  import Anthropic from '@anthropic-ai/sdk';          ← hardcoded import
  import { connectMcp } from '@/lib/mcp/connect';     ← hardcoded import
  import { DiagnosticAgent } from '@/lib/agents/diagnostic';
  …

  export async function GET(req: NextRequest) {       ← only seam is the request
    const sessionId = await getOrCreateSessionId();   ← reads cookies implicitly
    const mcp = await connectMcp(sessionId);          ← hardcoded transport
    const anthropic = new Anthropic({ apiKey: … });   ← hardcoded SDK
    …
  }

  The design pressure that wasn't applied: extract a `runInvestigation(deps)`
  function that takes anthropic + mcp + session as parameters. The handler
  becomes a 5-line wrapper that wires deps and calls it. The function is then
  trivially testable with the same scripted-Anthropic pattern that base.test.ts
  uses today.
```

**Why this is the design lesson.** The route handler is exactly where the testing gap and the design gap line up. The lib layer is testable because every dependency is injected. The route is untestable because no dependency is injected. The fix is the same as the audit finding: **extract the orchestration to a pure function, leave the handler as a thin wrapper.**

### Move 3 — the principle

**Tests are a forcing function for good seams.** A function with five parameters is awkward to write but trivial to test; a function with three implicit dependencies is easy to write and impossible to test. The cost lives at write time vs read+change time, and the tests are the read+change-time receipt. Where blooming insights pays the cost up front (`McpCaller`, `McpTransport`, test-only exports), it gets the tests for free. Where it skips the cost (route handlers, `connect.ts`), the tests stay zero.

## Primary diagram

The full design-pressure picture for blooming insights — where the seams are and where they aren't:

```
The seam map — every seam in the codebase, marked tested or not

  ┌─ TESTED VIA EXPLICIT SEAMS ──────────────────────────────────────────┐
  │                                                                       │
  │  parseAgentJson(text)            ─ parameter ──────► 5 tests          │
  │  isDiagnosis(v), isAnomalyArray, ─ parameter ──────► 25 tests         │
  │     isRecommendationArray                                              │
  │  parseWorkspaceSchema({ … })     ─ options bag ────► 24 tests         │
  │  coverageFor(cat, available)     ─ parameter ──────► 12 tests         │
  │  parseIntent(text)               ─ parameter ──────► 7 tests          │
  │  encodeEvent / decodeEvent       ─ parameter ──────► 7 tests          │
  │  deriveInsightFields(anomaly)    ─ parameter ──────► 11 tests         │
  │                                                                       │
  │  new McpClient(transport, opts)  ─ constructor ────► 14 tests         │
  │  new DiagnosticAgent(anthropic,  ─ constructor ────►  5 tests         │
  │     mcp, schema, toolDefs)          (4 params)                        │
  │  new MonitoringAgent(…)          ─ constructor ────► 10 tests         │
  │  new RecommendationAgent(…)      ─ constructor ────►  5 tests         │
  │  new QueryAgent(…)               ─ constructor ────►  3 tests         │
  │  new BloomreachAuthProvider(     ─ constructor ────► 14 tests         │
  │     sessionId, redirectUri)                                            │
  │                                                                       │
  │  runAgentLoop({ anthropic, mcp,  ─ options bag ────►  8 tests         │
  │     toolSchemas, … })                                                  │
  │                                                                       │
  │  _clearAuthStore()               ─ test-only export  ──► used by all  │
  │  _authCookieCrypto.{encrypt,decrypt}  ─ test-only ────►  2 tests      │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ NOT TESTED — NO USABLE SEAM ────────────────────────────────────────┐
  │                                                                       │
  │  GET /api/agent (route.ts)       ─ hardcoded imports ─► 0 tests       │
  │     │   ↑ Anthropic, connectMcp, intent classifier all imported       │
  │     │     at module top — no injection point                          │
  │     │                                                                 │
  │     └─ design fix: extract runInvestigation(deps) and wire in the     │
  │        handler. Then the same scripted-Anthropic pattern that         │
  │        base.test.ts uses today works one layer up.                    │
  │                                                                       │
  │  POST /api/briefing (route.ts)   ─ hardcoded imports ─► 0 tests       │
  │  GET /api/mcp/callback           ─ implicit cookies ──► 0 tests       │
  │                                                                       │
  │  connectMcp(sessionId)           ─ reads request ─────► 0 tests       │
  │     │   ↑ orchestrates DCR → PKCE → token exchange,                   │
  │     │     touches next/headers cookies implicitly                     │
  │                                                                       │
  │  getOrCreateSessionId()          ─ reads cookies ─────► 0 tests       │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case A — proving that the `McpCaller` interface is the seam in practice.** Every agent test (`base.test.ts`, `diagnostic.test.ts`, `monitoring.test.ts`, `query.test.ts`, `recommendation.test.ts`) imports `McpCaller` as a *type*, then builds a 6-line fake that satisfies it structurally. Same pattern in all five files.

```
lib/agents/base.ts  (lines 16–22)

  export interface McpCaller {
    callTool(
      name: string,
      args: Record<string, unknown>,
      opts?: { cacheTtlMs?: number; skipCache?: boolean },
    ): Promise<{ result: unknown; durationMs: number; fromCache: boolean }>;
  }
       │
       └─ the *interface* is the seam, not McpClient. Agents depend on this
          type, not the class — so tests substitute via the type.

test/agents/base.test.ts  (lines 76–83)

  function buildFakeMcp(impl): McpCaller {
    return {
      async callTool(name, args) {
        const result = await impl(name, args);
        return { result, durationMs: 1, fromCache: false };  ← satisfies the contract
      },
    };
  }
       │
       └─ five lines. That is the price of the seam. With no seam, this is
          either "spin up a real McpClient + transport" (~50 lines) or
          "rewrite the agent to not depend on McpClient" (~ never happens).
```

**Use case B — the test-only export pattern in auth.ts, used by both isolation and crypto coverage.**

```
lib/mcp/auth.ts  (lines 243–259)

  /** test-only — exercise the production cookie crypto without a request context. */
  export const _authCookieCrypto = {
    encrypt: (store: Store): string => encryptStore(store),  ← internal fn lifted
    decrypt: (token: string): Store => decryptStore(token),  ← into a test handle
  };

  /** test-only */
  export function _clearAuthStore(): void {
    memStore.clear();
    if (PERSIST) {
      try { writeFileSync(CACHE_FILE, JSON.stringify({})); }
      catch { /* ignore */ }
    }
  }
       │
       └─ this is what makes the AUTH_SECRET test work — the in-memory store
          can be reset cleanly between tests. Without it, the store would
          either persist across tests (order-dependence) or require restarting
          the test process per case (slow).

test/mcp/auth.test.ts  (lines 6–12, 16–17, 117–122)

  import { …, _clearAuthStore, _authCookieCrypto } from '../../lib/mcp/auth';

  describe('BloomreachAuthProvider', () => {
    beforeEach(() => { _clearAuthStore(); });        ← isolation via the seam

  describe('auth cookie crypto (production backend)', () => {
    beforeEach(() => { vi.stubEnv('AUTH_SECRET', 'test-secret-please-ignore'); });
    afterEach(() => { vi.unstubAllEnvs(); });        ← env isolation, see file 04

    it('round-trips an encrypted store under AUTH_SECRET', () => {
      const token = _authCookieCrypto.encrypt(store);  ← reach internal fn
      expect(_authCookieCrypto.decrypt(token)).toEqual(store);
    });
```

## Elaborate

The "dependency injection" name is old (Fowler, 2004) and overloaded — people associate it with heavy DI frameworks. In TypeScript with structural typing, DI collapses to "take the dependency as a parameter" — no framework needed. The `McpCaller` interface and the options-bag pattern in `runAgentLoop` are textbook examples. The test-only export pattern (`_` prefix) is folkloric — every codebase reinvents it, and it works as long as the team treats the convention as binding.

Cross-reference: `study-software-design`'s "deep modules are easy to test" finding is the same observation seen from the design side. A deep module (`schema.ts`, `validate.ts`, `categories.ts`) is easy to test *because* it has a small, sharp interface — the same property that makes it deep also makes it injectable.

## Interview defense

**Q: How did you decide what to inject vs hardcode?** Inject anything that crosses a network or has nondeterministic behaviour — that's Anthropic, MCP, the cookie store. Hardcode anything that's pure logic — schema parsing, intent classification, derived insight fields. The split is *not* about coupling, it's about whether the test bench can usefully substitute. Pure functions don't need a seam because there's nothing to substitute.

**Q: The `_clearAuthStore` test-only export — isn't that a code smell?** It is a controlled leak of internals. The alternative is worse: either tests reach into the module's internals via `(module as any).memStore.clear()` (which gives up all type safety and breaks on refactor), or the module has no in-memory state at all (which forces the cookie path everywhere and breaks dev ergonomics). Test-only exports with an `_` convention are the least-bad option.

```
The three ways to handle module-internal state in tests

  ┌─ option 1: tests reach in via `as any` ──────────────────┐
  │  (auth as any).memStore.clear()                          │  worst — no
  │  silently breaks on refactor, no type safety              │  refactor safety
  └──────────────────────────────────────────────────────────┘

  ┌─ option 2: refactor to remove all internal state ────────┐
  │  every function takes the store as a parameter            │  works but bloats
  │                                                            │  every call site
  └──────────────────────────────────────────────────────────┘

  ┌─ option 3: ★ test-only `_` exports ★ ────────────────────┐
  │  export function _clearAuthStore() { … }                  │  ← chosen here
  │  convention says "not for prod use"                       │
  │  type-checked, refactor-safe                              │
  └──────────────────────────────────────────────────────────┘
```

**Q: Why isn't `app/api/agent/route.ts` tested?** Because the design didn't apply the same pressure there. It imports its dependencies at the module top — no parameter, no constructor, no options bag. The fix is to extract `runInvestigation(deps)` as a pure function and leave the handler as a thin wrapper. That's a one-afternoon refactor that would unlock the highest-value missing test in the suite.

## Validate

1. **Reconstruct:** Without looking, list three seam types used in this repo (parameter, constructor, options bag, test-only export, interface) and one place each is used.
2. **Explain:** Why does the `_authCookieCrypto` export start with an underscore? What would break if you removed the convention?
3. **Apply:** Sketch the refactor of `app/api/agent/route.ts` that would make it testable. What function signature would the extracted `runInvestigation` have?
4. **Defend:** A reviewer says "tests shouldn't shape production code." Push back with the seam argument — name one seam in this repo that exists *because* of tests, and explain why removing it would make the codebase worse.

## See also

- [01-what-is-tested-and-what-isnt.md](01-what-is-tested-and-what-isnt.md) — the gap list, where the missing seams live
- [02-test-design-and-levels.md](02-test-design-and-levels.md) — the scripted-Anthropic pattern, which the `McpCaller` seam enables
- [04-determinism-isolation-and-flakiness.md](04-determinism-isolation-and-flakiness.md) — the AUTH_SECRET fix, which exists because `_clearAuthStore` does
