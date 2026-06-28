# 03 — vi.stubEnv() isolation
*Industry name: per-test environment stubbing / test-local config injection. Type: Industry standard (vitest-specific API).*

## Zoom out — where this pattern lives

```
  the isolation pattern sits at the test/process boundary

  ┌─ vitest worker process ──────────────────────────────────────────┐
  │                                                                   │
  │   ┌─ test file A ──────────────┐  ┌─ test file B ──────────────┐  │
  │   │ vi.stubEnv('AUTH_SECRET',  │  │ (no stub — sees real env)  │  │
  │   │   'test-secret')           │  │                            │  │
  │   │ ...runs auth crypto tests  │  │                            │  │
  │   │ vi.unstubAllEnvs()         │  │                            │  │
  │   └────────────────────────────┘  └────────────────────────────┘  │
  │                ★ THE STUB IS SCOPED TO THE TEST ★                  │
  │                no leak to file B even when they run in parallel    │
  └──────────────────────────────────────────────────────────────────┘
                                │
                                │  if you used process.env.X = '...' instead
                                ▼
  ┌─ process-wide env (BAD if shared across workers) ─────────────────┐
  │  the var stays set after the test, the next test sees it,         │
  │  parallel workers race on it → flake                              │
  └──────────────────────────────────────────────────────────────────┘
```

This pattern matters because vitest runs test files in parallel by
default, and `process.env` is process-wide. Setting an env var with
`process.env.X = 'foo'` in one file CAN leak into another file's test
running in the same worker — or, worse, the same var written by two
parallel workers races. `vi.stubEnv` solves both by tracking the
mutation and restoring it on `vi.unstubAllEnvs()`.

## Structure pass — the skeleton this pattern hangs on

**Layers:** test → vitest stub-tracker → process.env.

**Axis: state — who owns the env var, and when does it revert?**

```
  state ownership flips across the stub boundary

  ┌─ outside the test ──┐  vi.stubEnv() ┌─ inside the stubbed test ──┐
  │  PROCESS owns       │ ═════════════►│  TEST owns AUTH_SECRET     │
  │  AUTH_SECRET        │               │  (vitest remembers the     │
  │  (whatever .env     │               │   prior value to restore)  │
  │   sets, or unset)   │  vi.unstubAllEnvs()
  └─────────────────────┘ ◄═════════════└────────────────────────────┘
         ▲                                              ▲
         └─── state ownership flips, then flips back ───┘
              → no other test sees the test-local value
```

The boundary is `beforeEach` / `afterEach`. The stub is set inside the
boundary; the restore happens at the boundary. Cross either side and
the state belongs to the other owner.

**The seam that matters:** `vi.unstubAllEnvs()` in `afterEach`. Without
it, the stub leaks to the *next test in the same file*. The leak
across files is harder (vitest re-imports the test file fresh for each
file's environment) but the within-file leak is the cheap, common one.

## How it works

### Move 1 — the mental model

You know how a `useState` value reverts to its initial when the
component unmounts? Same idea here at the test level: `vi.stubEnv`
"sets" the value for the test, `vi.unstubAllEnvs` "unmounts" the stub
and restores whatever was there before. The test is a tiny scope; the
env var is local to that scope.

```
  The pattern — env mutation tracked, restored on exit

      beforeEach() ────► vi.stubEnv('AUTH_SECRET', 'x')
                              │
                              │  vitest remembers: ('AUTH_SECRET', prev)
                              ▼
                       process.env.AUTH_SECRET === 'x'   ← test sees this
                              │
                              ▼
                         the test runs
                              │
                              ▼
      afterEach()  ────► vi.unstubAllEnvs()
                              │
                              │  vitest restores each tracked var
                              ▼
                       process.env.AUTH_SECRET === prev  ← back to baseline
```

The thing that makes it bulletproof is the **tracking**. `vi.stubEnv`
records every var it touches; `vi.unstubAllEnvs` restores all of them
in one call. You can't forget to restore one — they all go back
together.

### Move 2 — the step-by-step walkthrough

#### Step 1 — find the env-dependent code

Auth cookie crypto reads `AUTH_SECRET` to derive the AES-256-GCM key:

```ts
// the production code in lib/mcp/auth.ts reads AUTH_SECRET at call time:
//   _authCookieCrypto.encrypt(store) → reads process.env.AUTH_SECRET
//   _authCookieCrypto.decrypt(token) → same
// (the test exposes _authCookieCrypto specifically so tests can drive
//  the round-trip without going through the cookie-jar surface)
```

Without a test-supplied secret, the encryption would either throw
("AUTH_SECRET is not set") or use a default that the test would have
to know — both fragile.

#### Step 2 — stub the var per-test, restore in afterEach

```ts
// test/mcp/auth.test.ts:112-135 (annotated)
describe('auth cookie crypto (production backend)', () => {
  // Isolate AUTH_SECRET with vitest's tracked env stubbing: set it before
  // each test and restore the prior environment after. Mutating
  // process.env directly (as before) leaked the var across files running
  // in parallel workers, which made this block flaky. stubEnv/unstubAllEnvs
  // keeps it self-contained.
  beforeEach(() => {
    vi.stubEnv('AUTH_SECRET', 'test-secret-please-ignore');     // ← scoped IN
  });
  afterEach(() => {
    vi.unstubAllEnvs();                                          // ← scoped OUT
  });

  it('round-trips an encrypted store under AUTH_SECRET', () => {
    const store = { 'sid-1': { tokens, codeVerifier: 'v', state: 's' } };
    const token = _authCookieCrypto.encrypt(store);
    expect(typeof token).toBe('string');
    expect(token).not.toContain('tok');                          // ← ciphertext,
    expect(_authCookieCrypto.decrypt(token)).toEqual(store);     //    not plaintext
  });

  it('returns an empty store for a tampered/garbage cookie', () => {
    expect(_authCookieCrypto.decrypt('not-a-valid-token')).toEqual({});
  });
});
```

The comment in the test is doing real work — it names the prior bug
(parallel-worker leak) and the fix (stubEnv). That's the audit trail
for "why this style, not the obvious `process.env.X = ...` style."

#### Step 3 — what would go wrong without the discipline

```
  scenario                                        outcome WITHOUT stubEnv
  ────────────────────────────────────────────    ─────────────────────────────
  test A sets process.env.AUTH_SECRET = 'a'      test B runs in the same file,
  test B runs in the same file, doesn't set it    sees 'a', might pass on 'a'
                                                  but rely on it implicitly
                                                  (silent dependency)
  test A sets process.env.AUTH_SECRET = 'a'      test B in another file,
  test B in a parallel worker reads it            running in another worker
                                                  process, would normally NOT
                                                  see it — but if both files
                                                  run in the same worker
                                                  (pool='single', or with
                                                  vitest's file-grouping),
                                                  test B sees 'a' as the
                                                  baseline → flake
  the test forgets to unset the var              the NEXT test file in the
  after running                                   same worker inherits it as
                                                  baseline; tests outside this
                                                  block start using 'a' as if
                                                  it were always set
```

With `stubEnv` + `unstubAllEnvs`, none of these matter — vitest tracks
the mutation, scopes it to the test, and reverts it cleanly. The leak
window shrinks to "inside this one `it()`."

#### Step 4 — the rest of the env-handling in the suite

Two other test files write to env directly without using stubEnv:

```ts
// test/api/briefing.integration.test.ts:112
process.env.ANTHROPIC_API_KEY = 'test-key';

// test/api/agent.integration.test.ts:146
process.env.ANTHROPIC_API_KEY = 'test-key';
```

These are written in a `beforeEach` and never unset. **They're a known
gap** (called out in `audit.md` lens 4). Today they don't cause flakes
because:

  → `ANTHROPIC_API_KEY` is only *read* by the route handlers, never
    asserted on as "should be unset" elsewhere in the suite, so the
    leak is invisible.
  → The integration tests run after the unit tests in most local
    runs, so the order-dependency happens to not bite.

But the pattern is fragile. If a future test wanted to assert "the
route returns 500 when the API key is missing," it would have to
either work around the inherited value or convert these two writes to
`vi.stubEnv` form. The fix is one-line per file:
`vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')` plus the matching
`vi.unstubAllEnvs()` in `afterEach`.

#### Step 5 — the sibling pattern: vi.stubGlobal + vi.unstubAllGlobals

The same discipline applies one layer up — to global mutations like
`fetch`. The transport tests use it:

```ts
// test/mcp/transport.test.ts:11-13
afterEach(() => {
  vi.unstubAllGlobals();
});
```

And per-test:

```ts
// test/mcp/transport.test.ts:19-25
const f = makeCapturingFetch(holder);
vi.stubGlobal(
  'fetch',
  async () => new Response('{"error":"invalid_token"}', { status: 401 }),
);
```

Same shape: stub in the test, restore in afterEach. The pattern is
"track-and-restore for any process-wide mutation." Env vars are the
common case; globals like `fetch` are the next-most-common; both use
the same discipline because they're both single-shared-process state.

### Move 3 — the principle

**Process-wide state needs scope-tracked mutation.** Anytime a test
needs to set something the whole process can see — env vars, globals,
the system clock, the random seed — write through a tracked stub
that knows how to restore on teardown. The `let prev = process.env.X;
process.env.X = 'y'; afterEach(() => { process.env.X = prev; })` style
works but is one easy `forgot-to-restore` bug away from a leak. Tracked
stubs (`stubEnv`, `stubGlobal`, `useFakeTimers`) move the discipline
from human attention to library guarantee.

## Primary diagram — the whole pattern in one frame

```
  vi.stubEnv() ISOLATION — one frame

  ┌─ vitest test runner ────────────────────────────────────────────┐
  │                                                                  │
  │   describe('auth cookie crypto') {                                │
  │                                                                  │
  │     beforeEach(() => {                                            │
  │       vi.stubEnv('AUTH_SECRET', 'test-secret');                  │
  │     });                                ──────────────┐           │
  │                                                       │           │
  │     afterEach(() => {                                 ▼           │
  │       vi.unstubAllEnvs();          ┌──────────────────────────┐  │
  │     });                            │ tracked-env table:        │  │
  │                                    │   AUTH_SECRET → prev      │  │
  │     it('round-trips encrypted', () │   (vitest remembers)      │  │
  │       process.env.AUTH_SECRET     └──────────────────────────┘  │
  │         === 'test-secret'                                         │
  │       _authCookieCrypto.encrypt(...)                              │
  │     })                                                            │
  │                                                                  │
  │   }   ← when this block exits, every tracked env var is restored │
  │       no leak to test file B running in the same worker          │
  └──────────────────────────────────────────────────────────────────┘

  the prior style (process.env.X = 'y' directly) had no restore →
  parallel-worker flake → the audit trail is in the test's comment
```

## Elaborate

The vitest `vi.stubEnv` / `vi.unstubAllEnvs` pair is a direct
descendant of Sinon's `sinon.stub(process.env, 'X')` and Jest's
`jest.replaceProperty`. The shape is universal across modern JS test
runners: a per-mutation tracker that the runner can flush on teardown.

The underlying principle goes deeper than env vars — it's the **stub
discipline** generalized. Any time the test needs to change something
the production code reads from a shared source, you want the change
**scoped to the test**, **tracked by the runner**, and **reverted
automatically**. Manual reversion is a footgun.

The history: parallel test execution is what made this matter. When
tests were single-threaded and sequential, "set the var, run the
test, unset the var" by hand worked fine because the next test ran
strictly after. Parallel execution broke that: a parallel worker
reading `process.env.X` while another worker writes it is a data race
with no warning. The runner-level stub fixes it by either (a) running
each file in its own process where the env is fresh, or (b) tracking
the mutation per-test and never letting it escape the test scope.

The cross-cutting cousin: **fake timers**. `vi.useFakeTimers()` /
`vi.useRealTimers()` is the same shape applied to `setTimeout` /
`Date.now`. The cache TTL test in `test/mcp/client.test.ts:49-58`
uses it for the same reason: time is process-wide state, and the
test wants to control it locally.

## Interview defense

**Q: "Why not just `process.env.X = 'y'` in the test?"**

It works until two tests touch the same var. Then it's a flake — the
test that runs first wins, the test that runs second inherits the
leaked value, and the third one might mutate it again, and you spend
half a day chasing a test that "fails sometimes." `vi.stubEnv` tracks
the mutation per-test and restores on `vi.unstubAllEnvs()`, so the
leak window is zero.

I'd point at the comment in `test/mcp/auth.test.ts:114-118`: it names
the prior bug (parallel-worker leak), names the fix (stubEnv), and
keeps the audit trail in the test file. That's how you signal "we
chose this style deliberately, not by accident."

*anchor:* `test/mcp/auth.test.ts:112-135` for the canonical pattern;
`test/mcp/transport.test.ts:11-13` for the same shape on globals.

**Q: "What's the load-bearing part people forget?"**

`afterEach(() => vi.unstubAllEnvs())`. The stub WITHOUT the restore
leaks to the next `it()` in the same `describe` block. Most people
remember to stub; far fewer remember the restore. The `unstubAllEnvs`
shape is nice because it doesn't ask you to remember WHICH vars you
stubbed — it just restores everything tracked, so the test author
can't accidentally leave one behind.

It's the same lesson as `useFakeTimers` / `useRealTimers`: the
"clean up after yourself" half of the API is what makes the pattern
parallel-safe.

*anchor:* `test/mcp/auth.test.ts:120-122` for the afterEach;
`test/mcp/transport.test.ts:11-13` for the global-equivalent.

**Q: "Two of your integration tests still write `process.env.ANTHROPIC_API_KEY`
directly. Why?"**

That's an inconsistency, and it's the kind of thing a code review
should catch. The reason they don't cause flakes today is luck:
`ANTHROPIC_API_KEY` is only read by the route under test, never
asserted on elsewhere, and the leak is invisible. But it's one new
test away from being a bug. The fix is mechanical — replace the
direct write with `vi.stubEnv`, add `vi.unstubAllEnvs()` in
`afterEach`. I left the inconsistency in the audit (lens 4) instead
of fixing it silently because the goal is to surface the discipline,
not to ship the cleanup.

*anchor:* `test/api/briefing.integration.test.ts:112` and
`test/api/agent.integration.test.ts:146` for the direct-write style;
`test/mcp/auth.test.ts:117-122` for the corrected style.

## See also

  → `01-scripted-anthropic-harness.md` — the injected-fakes pattern
    that *avoids* needing module-level stubs for the SDK seam.
  → `audit.md` lens 4 — the broader determinism/isolation/flakiness
    audit; names the two `process.env.X = ...` direct writes still
    in the suite.
