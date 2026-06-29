# 05 — tracked env stubbing (and global-state isolation)

*Industry term:* **test isolation** via tracked stubs — Industry
standard

## Zoom out, then zoom in

You've written `process.env.NODE_ENV = 'test'` at the top of a test
file and shrugged. Then one day a parallel test runner picks up that
file alongside a sibling that asserts `NODE_ENV === 'production'`,
and one of them flakes intermittently because they're racing for the
same process-wide variable. Vitest's `stubEnv` / `unstubAllEnvs` is
the tracked version of that move: stub it before each test, unstub it
after, never leak across files. This repo uses it deliberately at
exactly the spots that bit before.

```
  Zoom out — where the leak surfaces are

  ┌─ Vitest worker (one node process) ───────────────────────────┐
  │                                                               │
  │  test file A           test file B           test file C       │
  │  ─────────────         ─────────────         ─────────────     │
  │  mutates                mutates                mutates         │
  │  process.env            global.fetch           Date / clock    │
  │  ───────────            ─────────────          ─────────────   │
  │  ★ shared state ★      ★ shared state ★       ★ shared state ★ │ ← we are here
  │                                                                │
  │  one process, many test files                                  │
  │  shared globals leak across files unless                       │
  │  isolated explicitly                                           │
  └────────────────────────────────────────────────────────────────┘
```

**Zoom in.** Vitest doesn't fork a process per test file by default —
it runs them in worker threads that share `process.env`, `globalThis`,
and any module-level state. The flake mode is: file A sets
`process.env.AUTH_SECRET = 'x'`, runs, doesn't reset; file B runs
later, finds `AUTH_SECRET` already set, and either passes for the
wrong reason or fails on a different unrelated assertion. The fix is
*every* test that mutates shared state must use the tracked-stub
machinery — `stubEnv`/`unstubAllEnvs` for env, `stubGlobal`/
`unstubAllGlobals` for globals, `useFakeTimers`/`useRealTimers` for
the clock — and pair them with `beforeEach`/`afterEach`.

## Structure pass

**Layers — three surfaces of shared state this repo defends:**
- outer: `process.env` (read by `auth.ts`'s production code)
- middle: `globalThis.fetch` (read by `transport.ts`'s capturing fetch)
- inner: the test-local clock (`Date.now`, `setTimeout`, used by
  `McpClient`'s rate-limit + retry tests)

**One axis held constant — *what's the cleanup story*:**
- outer: `beforeEach: vi.stubEnv(...)`, `afterEach: vi.unstubAllEnvs()`
- middle: `afterEach: vi.unstubAllGlobals()` (top-level in the file)
- inner: `vi.useFakeTimers()` per test, `vi.useRealTimers()` to close

**The seam — where the axis flips:** at the test boundary. Inside the
test, the stubbed value is what production code sees. Outside the test
(in the next test, in another file, in a parallel worker), the real
value is restored. Without the tracked machinery, the boundary doesn't
exist — the stub bleeds across.

## How it works

### Move 1 — the mental model

A **tracked stub** is a replacement of a shared global where the
framework records the original and provides an explicit teardown.
Vitest's API:
- `vi.stubEnv(name, value)` — sets `process.env[name]`, remembers
  what was there
- `vi.unstubAllEnvs()` — restores everything `stubEnv` touched
- `vi.stubGlobal(name, value)` — same shape for `globalThis`
- `vi.unstubAllGlobals()` — restores
- `vi.useFakeTimers()` / `vi.useRealTimers()` — same shape for the
  clock

The kernel skeleton: **stub at setup, restore at teardown.** Three
parts:
(1) the setup hook (`beforeEach` or top of the test)
(2) the production code under test reads the stubbed value
(3) the teardown hook (`afterEach`) restores the original

```
  The stub/restore kernel

  ┌─ beforeEach ────┐    ┌─ test body ────────────┐    ┌─ afterEach ─────┐
  │ vi.stubEnv(     │    │ // prod code reads      │    │ vi.unstubAllEnvs│
  │   'AUTH_SECRET',│ ─► │ // process.env.AUTH_*    │ ─► │ // restored to  │
  │   'test-value'  │    │ // sees 'test-value'    │    │ // original     │
  │ )               │    │                         │    │ // (or unset)   │
  └─────────────────┘    └─────────────────────────┘    └─────────────────┘

  If you skip the teardown:
                                                       ┌─ next test ─────┐
                                                       │ // prod code     │
                                                       │ // STILL sees    │
                                                       │ // 'test-value' │
                                                       │ // bug ──────►   │
                                                       └─────────────────┘
```

Drop the teardown and the stub leaks. Drop the setup and the
production code sees whatever the *previous* test left behind. The
two are a pair; you can't have one without the other.

### Move 2 — the step-by-step walkthrough

**Env stubbing — the real fix.**
`test/mcp/auth.test.ts:117-122` has a comment that names the bug
this fix solved:

```typescript
describe('auth cookie crypto (production backend)', () => {
  // Isolate AUTH_SECRET with vitest's tracked env stubbing: set it before each
  // test and restore the prior environment after. Mutating process.env directly
  // (as before) leaked the var across files running in parallel workers, which
  // made this block flaky. stubEnv/unstubAllEnvs keeps it self-contained.
  beforeEach(() => {
    vi.stubEnv('AUTH_SECRET', 'test-secret-please-ignore');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('round-trips an encrypted store under AUTH_SECRET', () => {
    const store = { 'sid-1': { tokens, codeVerifier: 'v', state: 's' } };
    const token = _authCookieCrypto.encrypt(store);
    expect(typeof token).toBe('string');
    expect(token).not.toContain('tok'); // ciphertext, not plaintext tokens
    expect(_authCookieCrypto.decrypt(token)).toEqual(store);
  });
  // ...
});
```

The production code (`lib/mcp/auth.ts`) reads `process.env.AUTH_SECRET`
to derive its AES-256-GCM key. The test needs that variable set to
*something*. Before the tracked stub: a top-of-file mutation
(`process.env.AUTH_SECRET = ...`) leaked into any sibling test that
ran in the same worker thread. After: each `it` block sees a fresh
stub, then `unstubAllEnvs` puts the world back. The flake is gone
because the boundary between tests is now real.

**Global stubbing — fetch interception.**
`test/mcp/transport.test.ts:11-13, 18-25`:

```typescript
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('makeCapturingFetch', () => {
  it('records the body of a non-OK response and leaves the original readable', async () => {
    const holder: HttpErrorHolder = { last: null };
    const f = makeCapturingFetch(holder);
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('{"error":"invalid_token","error_description":"token revoked"}', {
          status: 401,
        }),
    );
    const res = await f('https://example.com/mcp');
    // ...
  });
});
```

The setup is per-test (different tests want different fake responses);
the teardown is `afterEach` at the `describe` level. `unstubAllGlobals`
restores `globalThis.fetch` to whatever was there before, so the next
file's tests that use real fetch (or stub their own) don't get a
leaked stub. The `holder` is *local* state for the test — no leak
risk because it's not on a global.

**Fake timers — the clock as global state.**
`test/mcp/client.test.ts:49-58`:

```typescript
it('expires cache after ttl', async () => {
  vi.useFakeTimers();                                   // ← takeover
  const t = fakeTransport(() => ({ ok: 1 }));
  const c = new McpClient(t);
  await c.callTool('whoami', {}, { cacheTtlMs: 1000 });
  vi.advanceTimersByTime(1001);                         // ← jump
  await c.callTool('whoami', {}, { cacheTtlMs: 1000 });
  expect(t.calls).toBe(2);
  vi.useRealTimers();                                   // ← give back
});
```

`vi.useFakeTimers()` is the takeover, `vi.useRealTimers()` is the
restore. Skip the restore and the *next* test's `setTimeout` runs
under fake timers — which usually means the test hangs (the timer
never fires because nothing advances the clock). It's the same
stub/restore kernel applied to time.

**Module-level state reset — the in-house version.** Production code
maintains some module-level state too (caches, in-memory maps).
Those have their own reset hooks:

```
  Module-level state surfaces — and their reset hooks

  state                                       reset hook                       called from
  ───────────────────────────────────────     ────────────────────────────     ─────────────
  schema bootstrap cache (lib/mcp/schema)     _resetSchemaCache()              every integration
                                                                                  test beforeEach
  insight feed (lib/state/insights)           _clear()                         briefing/agent tests
  investigation cache (lib/state/             _clearInvestigationCache()       agent tests
    investigations)
  auth store map (lib/mcp/auth)               _clearAuthStore()                auth tests
  anthropic mock queue (test/api/_helpers)    resetAnthropicQueue()            all integration tests
```

The naming convention is `_<lowercase>` — the leading underscore
signals "this is a test-only door into module state." That's
self-documenting in code review: any PR that adds a `_resetX()` is
declaring "I have new module-level state that tests need to reset."
Without the convention, those exports would look like normal API.

**Layers-and-hops — what each isolation surface protects:**

```
  Isolation surfaces — what leaks if missing

  surface              leak shape if missing                          fix
  ─────────            ────────────────────────                       ──────────────
  process.env          worker B reads worker A's AUTH_SECRET          stubEnv / unstubAllEnvs
                       → crypto round-trips with wrong key
                       → flaky encrypt/decrypt assertions
  globalThis.fetch     worker B's fetch call hits worker A's stub     stubGlobal / unstubAllGlobals
                       → wrong canned response or hard ECONNREFUSED
  Date / setTimeout    test 2 hangs because fake timers never         useFakeTimers / useRealTimers
                       advance, or test 2 fires real setTimeouts
                       while test 1's fake timer assertions still
                       expect manual advance
  _schemaCache         second integration test skips bootstrap        _resetSchemaCache() in beforeEach
                       phase entirely, mock-call assertions drift
  _investigationCache  agent test gets a previous test's cached       _clearInvestigationCache() in beforeEach
                       investigation back, hitting the cache hit
                       branch instead of the cache miss branch
                       under test
```

### Move 3 — the principle

**Every shared global is a hidden parameter — test it through the
same machinery as explicit ones.** The cleanest tests are the ones
that take their dependencies as arguments (the injected fakes in
files 01 and 02). For the dependencies you can't pass — env, fetch,
the clock — use tracked stubs so the *implicit* dependency still has
explicit setup and teardown. The day a sibling test starts flaking is
the day someone took the shortcut. The tracked machinery is the
discipline that prevents the shortcut from ever working.

## Primary diagram

```
  The full pattern — three flavors of tracked isolation, same shape

  ┌─ Vitest worker (shared state surfaces) ──────────────────────────────┐
  │                                                                       │
  │  ┌─ env ─────────────┐   ┌─ globals ────────┐   ┌─ clock ──────────┐ │
  │  │ process.env       │   │ globalThis.fetch  │   │ Date, setTimeout │ │
  │  │ process.env.NODE_*│   │ globalThis.console│   │ setInterval      │ │
  │  └─────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘ │
  │            │                      │                       │           │
  │            ▼                      ▼                       ▼           │
  │     vi.stubEnv          vi.stubGlobal              vi.useFakeTimers   │
  │     vi.unstubAllEnvs    vi.unstubAllGlobals        vi.useRealTimers   │
  │            │                      │                       │           │
  │            ▼                      ▼                       ▼           │
  │     auth crypto test       transport capture        rate-limit / TTL  │
  │     (test/mcp/auth.ts)     (test/mcp/transport.ts)  retry tests       │
  │                                                     (test/mcp/client) │
  │                                                                       │
  │  ┌─ module-level state (this repo's own caches) ──────────────────┐  │
  │  │   _resetSchemaCache · _clear (insights) ·                       │  │
  │  │   _clearInvestigationCache · _clearAuthStore ·                  │  │
  │  │   resetAnthropicQueue                                           │  │
  │  │                                                                 │  │
  │  │   convention: _<lowercase>Reset — test-only doors,              │  │
  │  │   always called from beforeEach                                 │  │
  │  └─────────────────────────────────────────────────────────────────┘  │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘

  Same kernel three times: stub at setup, restore at teardown.
  Module state is the in-house version; same discipline.
```

## Elaborate

Vitest's `stubEnv`/`stubGlobal` machinery was added in v0.26 (2022)
specifically because direct mutation of `process.env` had become a
common flake source as parallel test execution became the default.
Jest had the same problem and ended up with its own teardown idioms
(`jest.replaceProperty`, `jest.spyOn(process.env, ...)`). The shape
generalizes: any test runner that runs multiple files in the same
process needs an explicit story for shared globals, or the test
order starts mattering.

The pattern's deeper kin is the "test-only public API" — the
`_clear`, `_resetSchemaCache`, etc. exports. Naming them with a
leading underscore is the convention this repo settled on; other
codebases use a separate `__test__` subdirectory or a `vi.mock`-style
override. None is better than the others; the discipline is that
*every* module with hidden state has *some* documented reset hook,
and tests use it.

What you don't get from this pattern alone: cross-worker isolation
in CI when workers fully fork (vitest's `poolOptions.threads.isolate
= true`). In that mode, each file gets its own process, and global
leaks across files become impossible. But thread isolation is more
expensive, and most repos start with the looser default and add the
discipline-based isolation this file describes. This repo runs on the
default and the discipline holds.

What this *doesn't* defend against: a production module that *stores*
the env value in a `const` at module load. If `auth.ts` had done
`const SECRET = process.env.AUTH_SECRET;` at module scope, stubbing
the env after the module loaded would be a no-op — the constant
captured the value once. The fix would be to read the env *inside*
the function each call, or to make the secret an explicit parameter.
The fact this repo's auth crypto tests work means the prod code does
the lazy-read move correctly; the test pattern *and* the prod
implementation cooperate.

## Interview defense

**Q: Why `vi.stubEnv` instead of just assigning `process.env.X = ...`
in `beforeEach` and `delete process.env.X` in `afterEach`?**

Three reasons. First, manual restore is incomplete — you reset to
`undefined`, but if the variable was *already set* in the parent
environment, you've now deleted it. `unstubAllEnvs` restores the
*prior* value, whatever that was. Second, manual restore is
forgetful — every new `beforeEach` needs a matching `afterEach`
written by hand; one missed pair is a leak. `unstubAllEnvs` covers
*every* stub set in this test, no per-variable bookkeeping. Third, the
comment on `auth.test.ts:117-122` literally names this — manual
mutation *was* the implementation, and it *was* flaky, and switching
to the tracked API *fixed* it. The proof is in the commit history.

```
  Manual mutation vs tracked stub

  manual                          tracked
  ──────                          ──────
  process.env.X = 'v'             vi.stubEnv('X', 'v')
  ...test...                      ...test...
  delete process.env.X            vi.unstubAllEnvs()
  ↑                                ↑
  resets to undefined              restores prior value
  (loses original if any)          (whatever it was)

  needs a pair per variable        one teardown covers all stubs
```

**Q: Load-bearing part of this kernel — what breaks if missing?**

The `afterEach` teardown. `stubEnv` without `unstubAllEnvs` is worse
than direct mutation, because vitest's stub keeps a reference *and*
mutates the process env — so the next test sees the stubbed value
*and* a stale internal stub record that might log warnings or fight
the next call. The teardown is what closes the loop; the setup
without it is half a pattern, and a flake source.

**Q: What ISN'T this catching?**

Test-order *dependencies* inside a file (where test 2 expects test 1
to have side-effected the module). Vitest runs tests in file order
by default, so those "dependencies" sometimes pass by accident. The
fix isn't tracked stubs — it's making each test self-contained, which
this repo mostly does through the `_resetX()` hooks. Catching the
ones that still slip through would need vitest's randomized test
order (`test.sequence.shuffle`), which the repo doesn't use yet.
That's a soft spot, not a refutation of the pattern.

## See also

  → `04-real-fixture-snapshot-test.md` — the parallel discipline for
    fixture freshness
  → `06-scripted-ndjson-integration-harness.md` — the integration
    harness that depends on `resetAnthropicQueue` + `_resetSchemaCache`
    in every `beforeEach`
  → `audit.md` lens 4 — determinism-isolation-and-flakiness, where the
    full isolation story is summarized
