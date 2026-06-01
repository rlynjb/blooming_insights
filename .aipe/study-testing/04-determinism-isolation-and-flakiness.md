# 04 — Determinism, isolation, and flakiness

**Industry name:** Test isolation / hermetic tests / flake control. **Type:** Industry standard.

## Zoom out, then zoom in

A flaky test trains people to ignore red. The instant a green-bar isn't trustworthy, the suite stops being a contract and becomes decoration — "oh, that one fails sometimes." blooming insights had exactly one flake of record (the AUTH_SECRET crypto test, fixed in commit `e83a8e0`), and the fix is the canonical example of the right way to handle test isolation. The rest of the suite is mostly clean by construction — fakes everywhere, `vi.useFakeTimers()` for any time-sensitive code, in-memory stores with `_clear` helpers.

```
Zoom out — sources of non-determinism in the test suite

  ┌─ TIME ───────────────────────────────────────────────────────────────┐
  │  test/mcp/client.test.ts — vi.useFakeTimers() in every TTL/retry test │  ← handled
  │  Tests verify rate-limit retry windows by advancing fake time by       │
  │  exact ms; without fakes these would either be flaky (real sleep) or   │
  │  slow (10s waits). Lines 50–78, 111–167.                              │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ ENVIRONMENT VARIABLES ──────────────────────────────────────────────┐
  │  test/mcp/auth.test.ts — vi.stubEnv('AUTH_SECRET', …) per-test        │  ← handled
  │  This is the post-mortem fix from commit e83a8e0 (see below).         │   (after a flake)
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ SHARED IN-MEMORY STATE ─────────────────────────────────────────────┐
  │  lib/mcp/auth.ts memStore        — _clearAuthStore() in beforeEach    │  ← handled
  │  lib/state/insights.ts in-mem    — _clear() in beforeEach             │  ← handled
  │  lib/state/investigations.ts     — _clearInvestigationCache()         │  ← handled
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ NETWORK ────────────────────────────────────────────────────────────┐
  │  Faked at every boundary — no test in the suite makes a real HTTP     │  ← handled
  │  call. McpTransport injected as a fake; vi.stubGlobal('fetch', …)     │
  │  for the capturing-fetch test (transport.test.ts lines 14–18).        │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ FILESYSTEM ─────────────────────────────────────────────────────────┐
  │  Only reads — test/mcp/schema.test.ts uses readFileSync on the         │  ← acceptable;
  │  committed fixtures; test/state/investigations.test.ts reads the      │   no writes,
  │  committed demo-investigations.json. No writes.                        │   no contention
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ TEST EXECUTION ORDER ───────────────────────────────────────────────┐
  │  vitest defaults to parallel workers; no test relies on a specific    │  ← handled by
  │  ordering. Every shared-state test resets in beforeEach.              │   the resets
  └───────────────────────────────────────────────────────────────────────┘
```

Now zoom in. The interesting story is **how the AUTH_SECRET flake happened, what the fix was, and which class of bug it represents** — because that's the only flake of record in this repo, and the lesson generalizes.

## Structure pass

**Layers:** the test → the test process → other test processes (parallel workers). **Axis traced:** *is the resource I'm using shared with anything outside my test?* **The seams where the answer flips:**

```
The axis "is this resource shared?" — the isolation question

  axis traced = "what can leak in or out?"

  ┌─ inside one test ─────────────────────┐
  │  local consts, fakes built per-test    │  ISOLATED by construction
  │  expect() assertions                   │  ← single test scope
  └──────────────────┬───────────────────┘

  ┌─ across tests in one file ────────────┐
  │  module-scoped state                   │  SHARED by default —
  │    (memStore, in-mem insight cache,    │  needs beforeEach reset
  │     in-mem investigation cache)        │  ← every shared-state file
  └──────────────────┬───────────────────┘    has _clear() in beforeEach

  ┌─ ★ across test files (worker level) ★ ─┐
  │  process.env mutations                 │  THIS IS WHERE THE FLAKE LIVED
  │  (and any other process-global)        │  ← vitest runs files in parallel
  │                                         │     workers, but a worker can be
  │                                         │     reused across files; a direct
  │                                         │     process.env.X = 'y' leaks
  │                                         │     until the worker exits
  └──────────────────┬───────────────────┘

  ┌─ across processes (the OS) ────────────┐
  │  filesystem writes, network sockets    │  not used in this suite
  └────────────────────────────────────────┘
```

The flip that matters: **the seam between "module-scoped" and "process-scoped" state.** Module state (memStore) is shared across tests in the same file and obvious. Process state (`process.env`) is shared across *every* test in the worker and silent. The flake was a process-state leak that looked like module-state from the test's perspective.

## How it works

### Move 1 — the mental model

A test is hermetic when it produces the same result every time, regardless of what ran before or runs after. The kernel of hermetic testing is **reset state at the boundary you can't control**. If memStore is shared, reset it in `beforeEach`. If `process.env.AUTH_SECRET` is shared across parallel workers, stub it in `beforeEach` and unstub in `afterEach`. If time advances, freeze it with `vi.useFakeTimers()`.

```
The hermetic-test pattern — set, run, restore

  ┌─ beforeEach: set the world to a known state ───────────────────┐
  │  _clearAuthStore()              ← reset module-scoped memStore  │
  │  vi.stubEnv('AUTH_SECRET', 'X') ← override process.env, tracked │
  │  vi.useFakeTimers()             ← freeze the clock              │
  └─────────────────────────────┬──────────────────────────────────┘
                                ▼
  ┌─ the test runs in that world ──────────────────────────────────┐
  │  …                                                              │
  └─────────────────────────────┬──────────────────────────────────┘
                                ▼
  ┌─ afterEach: restore (or trust the next beforeEach) ────────────┐
  │  vi.unstubAllEnvs()             ← removes the env override     │
  │  vi.useRealTimers()             ← unfreezes time               │
  └────────────────────────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

#### Move 2.1 — the AUTH_SECRET flake, before and after

**The shape of the flake.** Before commit `e83a8e0`, the auth crypto block in `auth.test.ts` mutated `process.env.AUTH_SECRET` directly inside the test body and did not reset it. Vitest runs test *files* in parallel workers, but a single worker process is reused across many files — and `process.env` is a single object inside that process. So:

```
The flake — comparison: process.env leak across parallel test files

  ┌─ BEFORE (flaky) ───────────────────────────────────────────────────┐
  │                                                                    │
  │  test/mcp/auth.test.ts                                             │
  │     describe('auth cookie crypto', () => {                         │
  │       beforeEach(() => {                                           │
  │         process.env.AUTH_SECRET = 'test-secret';   ← MUTATION       │
  │       });                                          (no afterEach!) │
  │       it('round-trips an encrypted store', () => {…});             │
  │     });                                                            │
  │                                                                    │
  │  meanwhile, in WORKER PROCESS A (single Node process):             │
  │                                                                    │
  │     1. runs test/mcp/auth.test.ts                                  │
  │        ↳ sets process.env.AUTH_SECRET = 'test-secret'              │
  │        ↳ test passes                                               │
  │        ↳ NEVER UNSETS IT (no afterEach hook)                       │
  │                                                                    │
  │     2. worker is reused to run test/mcp/client.test.ts             │
  │        ↳ process.env.AUTH_SECRET is STILL 'test-secret' here       │
  │        ↳ client tests pass (they don't read AUTH_SECRET)           │
  │                                                                    │
  │     3. worker reused for test/mcp/transport.test.ts                │
  │        ↳ STILL set; doesn't matter                                 │
  │                                                                    │
  │  meanwhile, in WORKER PROCESS B (parallel):                        │
  │                                                                    │
  │     1. runs test/mcp/client.test.ts FIRST                          │
  │        ↳ process.env.AUTH_SECRET is UNDEFINED                      │
  │                                                                    │
  │     2. worker reused for test/mcp/auth.test.ts                     │
  │        ↳ describe('auth cookie crypto') runs                       │
  │        ↳ beforeEach sets it; ROUND-TRIP TEST PASSES                │
  │                                                                    │
  │  THE FLAKE: if the auth.test.ts BLOCK is interrupted mid-flight    │
  │  by a worker rebalancing or a parallel test reading the var, the   │
  │  round-trip test can see an env state it didn't expect. Failed     │
  │  ~1 in N runs; passed in isolation; mystified everyone.            │
  └────────────────────────────────────────────────────────────────────┘
```

**The fix.** Switch to `vi.stubEnv` / `vi.unstubAllEnvs`, which vitest *tracks*: every stub is registered, and `unstubAllEnvs` restores the prior value at the end of every test. Now the worker's `process.env` is the same on test exit as on test entry, every time.

```
The fix — vi.stubEnv tracks and restores

  ┌─ AFTER (commit e83a8e0) ─────────────────────────────────────────────┐
  │                                                                       │
  │  test/mcp/auth.test.ts (lines 117–122)                               │
  │     describe('auth cookie crypto (production backend)', () => {       │
  │       beforeEach(() => {                                              │
  │         vi.stubEnv('AUTH_SECRET', 'test-secret-please-ignore');       │  ← tracked stub
  │       });                                                             │
  │       afterEach(() => {                                               │
  │         vi.unstubAllEnvs();                                           │  ← restore boundary
  │       });                                                             │
  │       it('round-trips an encrypted store under AUTH_SECRET', () => {…});│
  │       it('returns an empty store for a tampered/garbage cookie',  …);│
  │     });                                                               │
  │                                                                       │
  │  WHAT CHANGED:                                                        │
  │    • The stub is registered with vitest, not written through to        │
  │      process.env raw. Vitest knows about it and can restore it.       │
  │    • afterEach runs even if the test throws → guaranteed cleanup.     │
  │    • Now: worker.process.env.AUTH_SECRET on test exit ===              │
  │           worker.process.env.AUTH_SECRET on test entry.                │
  │    • Parallel workers are no longer racing for a global. Each test    │
  │      gets the var set to its expected value at entry and removed at   │
  │      exit; nothing leaks across files.                                │
  │                                                                       │
  │  RESULT: 169 tests pass across repeated runs (commit message says    │
  │  157 at fix time; suite has grown since). tsc clean.                  │
  └───────────────────────────────────────────────────────────────────────┘
```

**The boundary condition.** `vi.stubEnv` only works because vitest knows about it — `process.env.X = 'y'` is invisible to vitest's tracking. The lesson generalizes: **never mutate a process-global directly in a test**. Use the framework's tracked mutator (`vi.stubEnv`, `vi.stubGlobal`, `vi.useFakeTimers`) so cleanup is automatic.

#### Move 2.2 — `vi.useFakeTimers()` as the time-isolation seam

**The shape.** Anything that depends on `Date.now()` or `setTimeout` is non-deterministic. The fix is the same shape as the env fix: replace the global with a tracked fake at the start of the test, advance it deterministically, restore at the end.

```
Time isolation — vi.useFakeTimers in test/mcp/client.test.ts

  ┌─ test/mcp/client.test.ts (lines 49–58) ───────────────────────────┐
  │                                                                   │
  │  it('expires cache after ttl', async () => {                      │
  │    vi.useFakeTimers();                  ← freeze time at "now"    │
  │    const t = fakeTransport(() => ({ ok: 1 }));                     │
  │    const c = new McpClient(t);                                     │
  │    await c.callTool('whoami', {}, { cacheTtlMs: 1000 });           │
  │    vi.advanceTimersByTime(1001);        ← jump past the TTL        │
  │    await c.callTool('whoami', {}, { cacheTtlMs: 1000 });           │
  │    expect(t.calls).toBe(2);             ← cache expired → 2 calls │
  │    vi.useRealTimers();                  ← restore the real clock  │
  │  });                                                               │
  │                                                                   │
  │  Without fake timers, this test either:                            │
  │    (a) actually waits 1001ms (slow — multiply by 14 cache-test     │
  │        cases = ~14s for one test file)                             │
  │    (b) sleeps via real setTimeout and races against the worker     │
  │        scheduler — flaky on a loaded CI machine                    │
  └───────────────────────────────────────────────────────────────────┘
```

The same pattern handles the rate-limit retry tests (`client.test.ts` lines 111–167) — they advance fake time past Bloomreach's 10-second retry window without actually waiting 10 seconds.

#### Move 2.3 — module state reset via `_clear` exports

**The shape.** Same kernel as the env fix, one layer down. Module-scoped state (memStore, in-mem insight cache) is shared across tests *within* a file by default. Reset it explicitly.

```
The three reset helpers in the suite

  lib/mcp/auth.ts         → _clearAuthStore()             ← memStore.clear()
  lib/state/insights.ts   → _clear()                       ← inserted state map
  lib/state/investigations.ts → _clearInvestigationCache() ← in-mem investigation map

  All three follow the same pattern:

    beforeEach(() => _clearXxx())          ← every test starts clean

  Without these, test order would matter. Test 1 saves an insight; test 2
  expects listInsights().length === 0 and gets 1 instead, intermittently
  depending on vitest's ordering.
```

### Move 2 variant — the load-bearing skeleton of a hermetic test

The minimum kernel that makes a test hermetic:

1. **A way to set state at boundary entry.** Whether that's `_clearAuthStore`, `vi.stubEnv`, or `vi.useFakeTimers` — you need to put the world in a known state before the test runs.

2. **A way to restore state at boundary exit.** `afterEach` or the framework's auto-restore. Drop this and the cleanup is *probabilistic* (depends on whether tests throw) and process-state leaks across tests.

3. **The cleanup must run even when the test throws.** `afterEach` runs on failure too; cleanup inside the test body after `expect()` does not (because `expect` throws on failure). Drop this and a single failing test corrupts every test after it in the same worker.

Skeleton = entry-state hook + exit-state hook + exception-safe cleanup. Drop any one and you have a flake waiting to happen.

### Move 3 — the principle

**Flakes are a state-leak in disguise.** A test that fails sometimes is rarely "actually nondeterministic" — it's deterministic given the world state, and the world state changed underneath it. The fix is never "retry the test"; the fix is "find the leak and seal it." The AUTH_SECRET fix is the textbook execution: identify the leaked global, route every read/write through a tracked mutator, restore on test exit. Apply that lens to anything that fails one-in-N times in CI.

## Primary diagram

The full isolation map for blooming insights — every source of non-determinism and how it's handled:

```
The hermetic-test map for blooming insights

  ┌─ source of non-det. ─┬─ handled by ──────────────────┬─ file ──────────┐
  │                      │                                │                 │
  │  time (Date.now,     │  vi.useFakeTimers()           │ test/mcp/       │
  │  setTimeout)         │  + vi.advanceTimersByTime     │ client.test.ts  │
  │                      │  + vi.useRealTimers in cleanup│ (lines 50, 78,  │
  │                      │                                │  111–167)       │
  │                      │                                │                 │
  │  ★ process.env ★     │  vi.stubEnv + vi.unstubAllEnvs│ test/mcp/       │
  │                      │  (commit e83a8e0 fix)         │ auth.test.ts    │
  │                      │                                │ (lines 117–122) │
  │                      │                                │                 │
  │  global fetch        │  vi.stubGlobal('fetch', …)    │ test/mcp/       │
  │                      │  + afterEach unstubAllGlobals │ transport.ts    │
  │                      │                                │ (lines 9–11)    │
  │                      │                                │                 │
  │  memStore (auth)     │  _clearAuthStore() in         │ test/mcp/       │
  │                      │  beforeEach                    │ auth.test.ts    │
  │                      │                                │ (line 17, 84)   │
  │                      │                                │                 │
  │  insight cache       │  _clear() in beforeEach        │ test/state/     │
  │                      │                                │ insights.test.ts│
  │                      │                                │ (line 12)       │
  │                      │                                │                 │
  │  investigation cache │  _clearInvestigationCache() in │ test/state/     │
  │                      │  beforeEach                    │ investigations  │
  │                      │                                │ .test.ts (l. 24)│
  │                      │                                │                 │
  │  network             │  injected fake transport      │ all test/mcp,   │
  │                      │  (never reaches real network)  │ test/agents     │
  │                      │                                │                 │
  │  test ordering       │  every shared-state test       │ all of test/    │
  │                      │  resets in beforeEach           │                 │
  └──────────────────────┴────────────────────────────────┴─────────────────┘

  KNOWN LEAK CLASSES NOT YET AUDITED:
    • test/mcp/transport.test.ts unstubs globals in afterEach (good),
      but the auth.test.ts pattern of "stubEnv per-block" hasn't been
      audited across the rest of the suite. There's no other env mutation
      that the grep found — likely clean — but no test enforces it.
    • lib/state has _clear() in tests; lib/mcp/auth has _clearAuthStore.
      If a new lib/state/X file is added with module-scoped state and no
      _clear export, no lint rule will catch the missing reset.
```

## Implementation in codebase

**Use case A — the AUTH_SECRET fix in context.** Commit `e83a8e0` (May 28, 2026): "test(auth): isolate AUTH_SECRET with vi.stubEnv to fix the flaky crypto test". The commit changed 15 lines in one file. The story it tells is the canonical post-mortem shape.

```
test/mcp/auth.test.ts  (lines 112–122 — the fixed block)

  describe('auth cookie crypto (production backend)', () => {
    // Isolate AUTH_SECRET with vitest's tracked env stubbing: set it before each
    // test and restore the prior environment after. Mutating process.env directly
    // (as before) leaked the var across files running in parallel workers, which
    // made this block flaky. stubEnv/unstubAllEnvs keeps it self-contained.
    beforeEach(() => {
      vi.stubEnv('AUTH_SECRET', 'test-secret-please-ignore');   ← every test starts
    });                                                          with this exact value
    afterEach(() => {
      vi.unstubAllEnvs();                                       ← every test exits
    });                                                          with the prior env
       │
       └─ the comment block is the post-mortem itself — it names WHY this
          pattern exists, so the next person doesn't "simplify" it back to
          direct mutation. That comment is part of the fix.
  });
```

**Use case B — `vi.stubGlobal` for the capturing-fetch test.** The transport test stubs the global `fetch` to return scripted Response objects, then `afterEach` undoes the stub.

```
test/mcp/transport.test.ts  (lines 1–18, 33–39)

  import { describe, it, expect, vi, afterEach } from 'vitest';

  afterEach(() => {
    vi.unstubAllGlobals();         ← restore real fetch after every test in this file
  });

  describe('makeCapturingFetch', () => {
    it('records the body of a non-OK response and leaves the original readable', async () => {
      const holder = { last: null };
      const f = makeCapturingFetch(holder);
      vi.stubGlobal(
        'fetch',
        async () => new Response('{"error":"invalid_token", …}', { status: 401 }),
      );
       │
       └─ scripted Response stands in for a real HTTP call. The capturing fetch
          can then be tested without spinning a real HTTP server. The stub leak
          is bounded by the afterEach above.
```

## Elaborate

The "flaky test" pattern is older than test frameworks. The fix has the same shape regardless of language: stub globals through the framework's tracked mutator so cleanup is automatic. Vitest's `vi.stubEnv` is descended from Jest's `jest.replaceProperty` (deprecated → replaced by `jest.spyOn` for similar reasons); both exist because hand-rolled `delete process.env.X` in `afterEach` is a footgun (it doesn't restore the *prior* value, just deletes — losing whatever was set in the parent shell).

The deeper observation: **a parallel test runner is a multi-process system**, and shared state (env vars, files, sockets) needs the same discipline you'd apply to any concurrent system. Locks, isolation, deterministic teardown. The fact that you don't *see* the parallelism doesn't mean it isn't there.

## Interview defense

**Q: Walk me through a flaky test you fixed.** The AUTH_SECRET crypto test in `auth.test.ts`. Failure mode: passed in isolation, flaked ~1 in N times in the full suite. Root cause: the `beforeEach` set `process.env.AUTH_SECRET` directly and there was no `afterEach`. Vitest runs test files in parallel workers; a single worker process is reused across files, so the env var leaked across file boundaries — when a parallel worker rebalanced or a downstream test read the var, the state wasn't what either side expected. Fix: replace direct mutation with `vi.stubEnv` + `vi.unstubAllEnvs` in `afterEach`, which vitest tracks and restores. One file changed, 15 lines, 157 tests passing across repeated runs.

```
The fix in one diagram

   BEFORE                           AFTER
   ──────                           ─────
   beforeEach(() => {               beforeEach(() => {
     process.env.AUTH_SECRET = X;     vi.stubEnv('AUTH_SECRET', X);  ← tracked
   });                              });
   // (no afterEach — leaks)        afterEach(() => {
                                       vi.unstubAllEnvs();              ← restored
                                    });
```

**Q: What other flake classes haven't you audited?** Honest answer: the rest of the suite hasn't been re-audited with the same lens. The fix landed in one file; the discipline hasn't been generalized to a lint rule banning direct `process.env.X = …` in test files. Adding that rule (or an ESLint plugin) would prevent the same class of bug landing somewhere else.

**Q: Why does this matter beyond one test?** Because a single flake erodes trust in the whole bar. Once "oh that test fails sometimes" enters the team's vocabulary, the suite stops being a contract. The discipline of "hermetic by construction" is worth more than the specific fix — it's the difference between a green bar that means "ship it" and a green bar that means "probably ship it."

## Validate

1. **Reconstruct:** Without looking, draw the timeline of the AUTH_SECRET flake: which process mutated which global at which point, and why parallel workers made it visible.
2. **Explain:** Why does `vi.stubEnv` work where direct `process.env.X = …` fails? What does vitest track that direct mutation doesn't?
3. **Apply:** A new test for `lib/mcp/session.ts` would need to set `BI_SESSION_SECRET`. Write the `beforeEach` / `afterEach` pair correctly on the first try.
4. **Defend:** A reviewer says "just rerun the test in CI if it flakes once." Push back with the "flakes are a state-leak in disguise" argument and name what gets eroded by accepting retry-on-flake.

## See also

- [03-tests-as-design-pressure.md](03-tests-as-design-pressure.md) — `_clearAuthStore` as a test-only export, the seam this fix depends on
- [05-edge-cases-and-error-paths.md](05-edge-cases-and-error-paths.md) — `vi.useFakeTimers()` for the rate-limit retry tests, same family of isolation tool
- [07-testing-red-flags-audit.md](07-testing-red-flags-audit.md) — the "no lint rule banning direct process.env mutation" finding
