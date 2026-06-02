# 03 — `vi.stubEnv` isolation (the AUTH_SECRET flake fix)

**Industry name:** Tracked environment stubbing / hermetic env isolation. **Type:** Industry standard (vitest-specific name).

## Zoom out, then zoom in

A flake erodes trust in the whole green bar. Once "oh that test fails sometimes" enters the team's vocabulary, the suite stops being a contract. blooming insights had exactly one flake of record — the AUTH_SECRET crypto test in `auth.test.ts` — and the fix lands as the canonical post-mortem story for the repo. The mechanism: replace direct `process.env.X = …` with `vi.stubEnv` + `vi.unstubAllEnvs`, so vitest tracks the mutation and restores the prior value on test exit even when the test throws.

```
Zoom out — where this pattern lives in the test infrastructure

  ┌─ Test suite (169 tests across 18 files) ──────────────────────┐
  │                                                                │
  │  vitest runs files in parallel WORKERS                        │
  │  each worker is a Node process; a worker is reused across     │
  │  multiple test files; process.env is one object PER PROCESS    │
  │                                                                │
  └────────────────────────────────┬───────────────────────────────┘
                                   │
  ┌─ ★ ISOLATION LAYER (where this pattern lives) ★ ──────────────┐
  │                                                                │
  │  test/mcp/auth.test.ts lines 117–122 — the fixed block          │
  │     beforeEach: vi.stubEnv('AUTH_SECRET', 'test-secret-…')      │  ← we are here
  │     afterEach:  vi.unstubAllEnvs()                              │
  │                                                                │
  │  Same family in the suite:                                     │
  │     vi.useFakeTimers / vi.useRealTimers   (time)               │
  │     vi.stubGlobal('fetch', …) / vi.unstubAllGlobals (globals)  │
  │     _clearAuthStore / _clear / _clearInvestigationCache        │
  │       (module-scoped state)                                    │
  └────────────────────────────────┬───────────────────────────────┘
                                   │
  ┌─ Code under test ──────────────▼───────────────────────────────┐
  │  lib/mcp/auth.ts                                                │
  │     encryptStore / decryptStore — read process.env.AUTH_SECRET  │
  │     to derive the AES-256-GCM key                               │
  └────────────────────────────────────────────────────────────────┘
```

Now zoom in. The interesting story is **why direct `process.env.X = …` leaked across files, why `vi.stubEnv` doesn't, and why this is the load-bearing isolation pattern for any process-global the tests touch.**

## Structure pass

**Layers:** one test → tests in one file → tests in one worker process → tests in parallel worker processes. **Axis traced:** *what is shared at this layer, and what isolates it?* **The seams where the answer flips:**

```
The axis "what's shared, what's isolated?" — across nesting levels

  axis traced = "what state can leak in or out?"

  ┌─ inside one test ─────────────────────────────┐
  │  local consts, per-test fakes, expect() asserts│  ISOLATED by language
  └────────────────────┬──────────────────────────┘    (function scope)

  ┌─ across tests in one file ────────────────────┐
  │  module-scoped state: memStore, in-mem caches  │  SHARED by default —
  └────────────────────┬──────────────────────────┘  needs _clear() in
                                                      beforeEach (every
                                                      shared-state test
                                                      file has these)

  ┌─ ★ across files in one worker ★ ──────────────┐
  │  process.env mutations                         │  THE FLAKE LIVED HERE
  │  any process-global (process.env, globalThis,  │  vitest reuses one
  │  vi.useFakeTimers state if not restored)       │  worker process across
  │                                                 │  many test files; raw
  │                                                 │  process.env writes
  └────────────────────┬──────────────────────────┘  leak until the worker
                                                      exits

  ┌─ across parallel workers ─────────────────────┐
  │  filesystem writes, network sockets, real DB   │  not used in this suite
  └───────────────────────────────────────────────┘
```

The flip that matters: **the seam between "module-scoped" and "process-scoped" state.** Module state (memStore) is shared *within* a file and *obvious* — every test file with shared state has a `_clear()` call in `beforeEach`. Process state (`process.env`) is shared *across* every file in the worker and *silent* — there's no compile error, no warning, nothing visible until a parallel worker races for the same global.

## How it works

### Move 1 — the mental model

A test is hermetic when it produces the same result every time, regardless of what ran before or runs after. The kernel of hermetic testing is **route every mutation of shared state through a framework-tracked mutator**, so cleanup is automatic even when the test throws.

```
The hermetic-test kernel — track and restore

  ┌─ beforeEach: put the world into a known state ─────────────┐
  │  vi.stubEnv('AUTH_SECRET', 'X')   ← TRACKED env override   │
  │  vi.useFakeTimers()                ← TRACKED time freeze    │
  │  vi.stubGlobal('fetch', fn)       ← TRACKED global stub    │
  │  _clearAuthStore()                ← module reset            │
  └────────────────────────┬───────────────────────────────────┘
                           ▼
  ┌─ the test runs in that world ──────────────────────────────┐
  │  (may throw — afterEach still runs)                         │
  └────────────────────────┬───────────────────────────────────┘
                           ▼
  ┌─ afterEach (or auto): restore everything ──────────────────┐
  │  vi.unstubAllEnvs()    ← env back to what worker saw before │
  │  vi.useRealTimers()    ← time unfrozen                      │
  │  vi.unstubAllGlobals() ← global back to native fetch        │
  └────────────────────────────────────────────────────────────┘
```

The point of the *framework-tracked* mutator: it knows what it changed and can put it back. Direct `process.env.X = 'y'` doesn't — vitest has no record of the change and can't restore the prior value.

### Move 2 — the walkthrough

#### The flake, before the fix

Before commit `e83a8e0`, the auth crypto block in `auth.test.ts` mutated `process.env.AUTH_SECRET` directly inside `beforeEach` and had no `afterEach`. The flake mechanics:

```
The flake mechanic — process.env leak across parallel workers

  ┌─ vitest scheduler ─────────────────────────────────────────────┐
  │  spawns N worker processes (one per CPU core, roughly)         │
  │  each worker is a long-lived Node process                      │
  │  scheduler assigns test FILES to workers as they finish        │
  │  one worker → many files, in sequence                          │
  └──────────────────────────────────────────────────────────────┘

  ┌─ WORKER A timeline ─────────────────────────────────────────────┐
  │                                                                  │
  │  T0   run test/mcp/auth.test.ts                                  │
  │         beforeEach → process.env.AUTH_SECRET = 'test-secret'    │
  │         test passes                                              │
  │         NO afterEach → AUTH_SECRET stays set in this process    │
  │                                                                  │
  │  T1   worker reused → run test/mcp/client.test.ts                │
  │         AUTH_SECRET is STILL 'test-secret'                       │
  │         client tests don't read it; they pass                    │
  │                                                                  │
  │  T2   worker reused → run test/mcp/transport.test.ts             │
  │         STILL set; doesn't matter to these tests                 │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ WORKER B timeline (parallel) ──────────────────────────────────┐
  │                                                                  │
  │  T0   run test/mcp/client.test.ts FIRST                          │
  │         AUTH_SECRET is UNDEFINED in this worker                  │
  │                                                                  │
  │  T1   worker reused → run test/mcp/auth.test.ts                  │
  │         beforeEach → process.env.AUTH_SECRET = 'test-secret'    │
  │         crypto test runs against the just-set value             │
  │         passes (in this run)                                     │
  │                                                                  │
  │  T2 …                                                            │
  │  THE FLAKE: if mid-block the worker pool rebalances or a        │
  │  parallel read happens, the env can be in an unexpected state.  │
  │  Failed ~1 in N runs. Passed in isolation. Mystified everyone.  │
  └──────────────────────────────────────────────────────────────────┘
```

The symptom: green bar most days, red bar occasionally, no diff that explained it. The diagnostic move: notice that the failing test depends on `process.env.AUTH_SECRET` and that no afterEach restores it.

#### The fix, what changed

Switch to `vi.stubEnv`, which vitest *tracks*. Every stub is registered in a per-test list; `vi.unstubAllEnvs()` walks the list and restores prior values. The afterEach guarantees cleanup even when the test throws.

```
vi.stubEnv mechanic — tracked mutation + automatic restore

  ┌─ test entry ─────────────────────────────────────────────┐
  │  vi.stubEnv('AUTH_SECRET', 'test-secret')                │
  │     │                                                     │
  │     ├─ vitest reads current value:                       │
  │     │     prior = process.env.AUTH_SECRET (may be undef)│
  │     │                                                     │
  │     ├─ stores (varName, prior) in per-test stub registry │
  │     │                                                     │
  │     └─ sets process.env.AUTH_SECRET = 'test-secret'     │
  └─────────────────────┬───────────────────────────────────┘
                        │
                        ▼
  ┌─ test runs (may throw) ─────────────────────────────────┐
  │  encryptStore / decryptStore read AUTH_SECRET           │
  │  assertions execute                                       │
  └─────────────────────┬───────────────────────────────────┘
                        │
                        ▼ afterEach runs unconditionally
  ┌─ test exit ──────────────────────────────────────────────┐
  │  vi.unstubAllEnvs()                                       │
  │     │                                                     │
  │     ├─ walks the stub registry                           │
  │     │                                                     │
  │     └─ for each (varName, prior):                        │
  │           if prior was undefined → delete process.env.X  │
  │           else → process.env.X = prior                    │
  └──────────────────────────────────────────────────────────┘

  Net effect: worker.process.env.AUTH_SECRET on test EXIT
              ===
              worker.process.env.AUTH_SECRET on test ENTRY
              (every time, every test)
```

Now parallel workers no longer race for a global. Each test gets the var set to its expected value on entry; the var is restored to whatever the worker had before on exit. Nothing leaks across files.

#### Why the same shape generalizes (vi.useFakeTimers, vi.stubGlobal)

The pattern repeats for every process-global the suite touches. Time (`Date.now`, `setTimeout`) is a global; `vi.useFakeTimers` is the tracked mutator, `vi.useRealTimers` is the restore. `fetch` is a global; `vi.stubGlobal('fetch', fn)` is the tracked mutator, `vi.unstubAllGlobals` is the restore. The lesson: **never mutate a process-global directly in a test — use the framework's tracked mutator.**

```
The family — same shape, different globals

  global               tracked mutator              restore
  ──────               ───────────────              ───────
  process.env.X        vi.stubEnv('X', val)         vi.unstubAllEnvs()
  Date.now / timers    vi.useFakeTimers()           vi.useRealTimers()
  globalThis.fetch     vi.stubGlobal('fetch', fn)   vi.unstubAllGlobals()
  globalThis.anything  vi.stubGlobal(name, val)     vi.unstubAllGlobals()
```

All three live in the suite. `vi.useFakeTimers` is in every TTL/retry test in `client.test.ts`. `vi.stubGlobal('fetch', …)` is in the capturing-fetch test in `transport.test.ts`. `vi.stubEnv` is the AUTH_SECRET fix.

### Move 2 variant — the load-bearing skeleton

What is the minimum that makes the pattern correct?

1. **A tracked mutator at test entry.** `vi.stubEnv` (not `process.env.X = …`). Without "tracked," the framework can't restore the prior value because it doesn't know what the prior value was.

2. **An automatic restore at test exit.** `vi.unstubAllEnvs()` in `afterEach`. The restore must run *unconditionally* — including when the test throws. `afterEach` runs on failure; cleanup placed inside the test body after `expect()` does not (because `expect` throws on failure).

3. **Exception-safe cleanup.** Drop this and a single failing test corrupts every test after it in the same worker. The combination of `afterEach` + tracked mutator gives you this for free — even if the test body throws partway through, vitest still calls `afterEach`, which restores via the tracker.

Skeleton = tracked entry + tracked exit + exception-safe. Drop any one and the flake is one parallel-worker race away.

### Move 3 — the principle

**Flakes are state leaks in disguise.** A test that fails sometimes is rarely "actually nondeterministic" — it's deterministic given the world state, and the world state changed underneath it. The fix is never "retry the test"; the fix is "find the leak and seal it." Route every mutation of shared state through a framework-tracked mutator. The discipline travels: env vars, timers, globals, module-scoped state — same shape, different name.

## Primary diagram

The full before/after, side by side:

```
The AUTH_SECRET flake fix — before vs after

  ┌─ BEFORE commit e83a8e0 (flaky) ─────────────────────────────────┐
  │                                                                  │
  │  test/mcp/auth.test.ts                                           │
  │  ────────────────────                                            │
  │                                                                  │
  │   describe('auth cookie crypto', () => {                          │
  │     beforeEach(() => {                                            │
  │       process.env.AUTH_SECRET = 'test-secret';   ← raw mutation, │
  │     });                                            untracked       │
  │     // (no afterEach — the leak)                                 │
  │                                                                  │
  │     it('round-trips an encrypted store', () => {…});             │
  │   });                                                            │
  │                                                                  │
  │  RESULT: process.env.AUTH_SECRET persists in the worker          │
  │  process after this block exits. The next file the worker runs   │
  │  inherits the value; if a parallel worker has the var unset and  │
  │  a downstream test races for it, the suite flakes.               │
  │                                                                  │
  │  SYMPTOM: ~1 in N failure rate. Passes in isolation. No diff     │
  │  explains it. Worst possible kind of flake — looks like           │
  │  "intermittent," is actually "deterministic given env state."    │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ AFTER commit e83a8e0 (clean) ──────────────────────────────────┐
  │                                                                  │
  │  test/mcp/auth.test.ts  (lines 112–122)                          │
  │  ────────────────────                                            │
  │                                                                  │
  │   describe('auth cookie crypto (production backend)', () => {     │
  │     // Isolate AUTH_SECRET with vitest's tracked env stubbing:   │
  │     // set it before each test and restore the prior environment │
  │     // after. Mutating process.env directly (as before) leaked    │
  │     // the var across files running in parallel workers, which   │
  │     // made this block flaky. stubEnv/unstubAllEnvs keeps it     │
  │     // self-contained.                                           │
  │     beforeEach(() => {                                            │
  │       vi.stubEnv('AUTH_SECRET', 'test-secret-please-ignore');    │
  │     });                                                          │
  │     afterEach(() => {                                            │
  │       vi.unstubAllEnvs();                                        │
  │     });                                                          │
  │                                                                  │
  │     it('round-trips an encrypted store under AUTH_SECRET', () => {…}); │
  │     it('returns an empty store for a tampered cookie', () => {…});│
  │   });                                                            │
  │                                                                  │
  │  WHAT CHANGED:                                                   │
  │   • vi.stubEnv registers the mutation with vitest's tracker.    │
  │   • afterEach calls vi.unstubAllEnvs, which restores prior      │
  │     values for every stub registered in this test.              │
  │   • afterEach runs even when the test throws → exception-safe.  │
  │   • Worker.process.env on test exit === on test entry.          │
  │   • Parallel workers no longer race for the global.             │
  │                                                                  │
  │  RESULT: 169 tests pass across repeated runs (commit message    │
  │  says 157 at fix time; suite has grown since). Zero re-flakes.  │
  │                                                                  │
  │  THE COMMENT BLOCK is part of the fix — it explains WHY this    │
  │  pattern exists so the next person doesn't "simplify" it back.  │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case A — the AUTH_SECRET fix in full context.** The comment block above the `beforeEach` is itself part of the fix. It names *why* the pattern exists, so the next refactor doesn't silently revert to raw mutation.

```
test/mcp/auth.test.ts  (lines 112–122 — the fixed block, full)

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
       └─ the comment is the post-mortem itself. Without it, a year from now
          someone reviews this code, sees "wait, why is this stubEnv pattern
          here when other tests use plain assignment?" and refactors it back
          to a flake. The comment is documentation as a guard rail.

  test/mcp/auth.test.ts  (lines 126–133 — the test that depends on the isolation)

    it('round-trips an encrypted store under AUTH_SECRET', () => {
      const store = { … };
      const token = _authCookieCrypto.encrypt(store);     ← reads AUTH_SECRET
      expect(_authCookieCrypto.decrypt(token)).toEqual(store);
    });
    it('returns an empty store for a tampered/garbage cookie', () => {
      expect(_authCookieCrypto.decrypt('not-a-valid-token')).toEqual({});
    });
       │
       └─ both tests need AUTH_SECRET set to a known value. The encrypt/decrypt
          path derives an AES-256-GCM key from the env var; if the var is the
          wrong value mid-test, decrypt fails on input it produced itself.
          That's the exact failure mode the flake produced before the fix.
```

**Use case B — same family for `fetch`, in the transport test.** `vi.stubGlobal('fetch', …)` is the same pattern applied to a different global; `vi.unstubAllGlobals()` in `afterEach` is the same exception-safe restore.

```
test/mcp/transport.test.ts  (lines 1–18, 33–39)

  import { describe, it, expect, vi, afterEach } from 'vitest';

  afterEach(() => {
    vi.unstubAllGlobals();         ← restore real fetch after every test
  });

  describe('makeCapturingFetch', () => {
    it('records the body of a non-OK response and leaves the original readable', async () => {
      const holder = { last: null };
      const f = makeCapturingFetch(holder);
      vi.stubGlobal(                ← tracked global stub
        'fetch',
        async () => new Response('{"error":"invalid_token", …}', { status: 401 }),
      );
       │
       └─ scripted Response stands in for a real HTTP call. The capturing
          fetch can then be tested without spinning a real HTTP server. The
          stub leak is bounded by the file-scoped afterEach above; no other
          test in the suite sees a stubbed fetch.
```

## Elaborate

The "stub the global through the framework" pattern is older than vitest — Jest's `jest.replaceProperty` did the same job before being deprecated in favor of `jest.spyOn` for similar use cases. The underlying observation goes back further: a parallel test runner is a multi-process system, and shared state (env vars, files, sockets) needs the same discipline you'd apply to any concurrent system. Locks, isolation, deterministic teardown. The fact that you don't *see* the parallelism doesn't mean it isn't there.

The deeper lesson: **the framework's tracked mutator is a kind of context manager**. It pairs a setup operation with a guaranteed teardown, even on exception. Python's `with` statement, Go's `defer`, Rust's `Drop` — all the same idea. vitest's `stubEnv` is the same primitive in a JS testing skin.

Cross-reference: `study-software-design`'s "principle of least surprise" — the fixed code is *more* code than the raw mutation, but it's also more *honest* about what it's doing. The comment block names the post-mortem; the explicit `afterEach` makes the cleanup contract visible. Surprise-minimizing code is testing-friendly code.

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
                                       vi.unstubAllEnvs();           ← restored
                                    });
```

**Q: Why `vi.stubEnv` instead of `delete process.env.X` in afterEach?** Because `delete` doesn't restore the *prior* value — it just deletes. If the worker shell or a parent test had already set `AUTH_SECRET` to something else, `delete` loses that value. `vi.stubEnv` saves the prior value on entry and `vi.unstubAllEnvs` puts it back; the worker ends in exactly the state it started in, every time. The mutation is symmetric — that's what makes it composable with whatever else is going on in the worker.

**Q: What flake classes haven't you generalized this lesson to?** Honest answer: the rest of the suite hasn't been re-audited with the same lens. The fix landed in one file; the discipline hasn't been generalized to a lint rule banning direct `process.env.X = …` in test files. Adding an ESLint rule (or a project-specific check) would prevent the same class of bug from landing in a future test file. That's flag 8 in the red-flag audit and the obvious next move.

## Validate

1. **Reconstruct:** Without looking, draw the timeline of the AUTH_SECRET flake: which worker mutated which global at which point, and why parallel workers made it visible.
2. **Explain:** Why does `vi.stubEnv` work where direct `process.env.X = …` fails? What does vitest track that direct mutation doesn't?
3. **Apply:** A new test for `lib/mcp/session.ts` needs `BI_SESSION_SECRET` set. Write the `beforeEach` / `afterEach` pair correctly on the first try.
4. **Defend:** A reviewer says "just rerun the test in CI if it flakes once." Push back with the "flakes are state leaks in disguise" argument and name what gets eroded by accepting retry-on-flake.

## See also

- `audit.md#determinism-isolation-and-flakiness` — the full isolation map for the suite
- `audit.md#testing-red-flags-audit` — flag 8 (no lint guard on env mutation) is the generalization opportunity this fix points to
- `01-scripted-anthropic-harness.md` — the agent tests' isolation depends on the same family (`vi.fn`, `vi.stubGlobal` work on the same tracked-mutation principle)
- `04-acceptance-plus-per-gate-rejection.md` — the type-guard tests this file's `_authCookieCrypto` calls feed
