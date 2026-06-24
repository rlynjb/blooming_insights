# AUTH_SECRET flake post-mortem

**Industry name(s):** parallel-worker test flake, shared-mutable-state leak, env-stubbing discipline, post-mortem template
**Type:** Industry standard (the post-mortem template) · Project-specific (this incident's diff)

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** This is the only documented incident in the repo with a clean root cause, a one-file fix, and a regression guard. Commit `e83a8e0` (the flake-fix) walks the canonical incident lifecycle — detect → diagnose → fix → prevent → verify — at a granularity small enough that the whole story fits in a commit message. The reason this gets its own pattern file: the *shape* of the post-mortem is reusable beyond this specific incident. Every flake with the fingerprint "isolated pass, parallel flake" is the same kind of bug (shared mutable state), and the discipline that fixes it (tracked-mutation primitives) generalises to any test framework, any global, any fixture.

```
  Zoom out — where the post-mortem sits across the layers

  ┌─ User / observation surface ────────────────────┐
  │  no Sentry, no PagerDuty, no error-tracker       │
  │  detection: test runner exit code                │
  └─────────────────────────▲───────────────────────┘
                            │ vitest run flaked
  ┌─ Diagnosis ─────────────┴───────────────────────┐
  │  fingerprint: "isolated pass + parallel flake"   │
  │  → always points to shared mutable state         │
  │  read test/mcp/auth.test.ts:                     │
  │    process.env.AUTH_SECRET = '…'  ← the leak     │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ Fix + prevent ─────────┴───────────────────────┐  ← we are here
  │  vi.stubEnv('AUTH_SECRET', '…') in beforeEach    │
  │  vi.unstubAllEnvs() in afterEach                 │
  │  the afterEach IS the regression guard           │
  │  (test/mcp/auth.test.ts:117-122)                 │
  └─────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** A post-mortem is a *layered cause analysis* — root cause, contributing conditions, fix, prevention, verification — written down so the next person hitting the same symptom can short-circuit to the answer. The discipline of writing one is what converts "we fixed it" into "this kind of bug won't happen again here." The repo's one post-mortem is the commit message on `e83a8e0`: it names the root cause (`process.env.AUTH_SECRET` mutated directly), the fix (`vi.stubEnv` + `vi.unstubAllEnvs`), the verification ("157 tests pass across repeated runs"), and the contributing condition (parallel workers + shared global state). Five lines, all four parts. The fingerprint sentence — *"isolated pass, parallel flake is always shared mutable state"* — is the reusable lesson; it generalises to any framework with parallel workers and any test that mutates anything process-global.

---

## Structure pass

**Layers.** Four phases of the incident lifecycle: detect (how you find out), diagnose (how you understand it), fix (the change that resolves it), prevent (the change that stops it from happening again).

**Axis: failure (where does the failure originate, propagate, and get contained?).** The flake-fix tells a clean story along this axis.
- **Originate.** The auth crypto test file set `process.env.AUTH_SECRET = '…'` directly. That single mutation was the root cause.
- **Propagate.** Vitest's parallel workers share the `process.env` global at the OS-process level. The variable leaked into other test files' processes — sometimes overwritten, sometimes cleared, sometimes never set when this worker ran first.
- **Contain.** Nowhere — that's why it flaked. The fix shifts containment into the test framework (`vi.stubEnv` tracks the change and restores it via `vi.unstubAllEnvs` in `afterEach`). After the fix, the mutation is contained to one test's lifetime, regardless of which worker any test runs in.

**Seams.** Two load-bearing:

- **Test ↔ test (parallel worker boundary).** Vitest's default is parallel files. The boundary is where state *should* be isolated but wasn't. The flake lived at this seam. Crossing it the wrong way (direct `process.env` mutation) leaks; crossing it the right way (`vi.stubEnv` with `afterEach` cleanup) doesn't.
- **Code ↔ test framework.** The fix doesn't change the production code at all — `_authCookieCrypto` is untouched. It changes the *test discipline* around it. The seam between "what you're testing" and "how you're testing" is where the prevention lives. Knowing which side of that seam your fix lands on is half the post-mortem's value.

A *missing* seam, named for honesty: there's no detect↔mitigate seam in this repo. No automated alert, no on-call rotation, no runbook to grab. When the test went red, a human noticed. The repo has no automation around incident detection past the test runner exit code.

```
  Structure pass — the post-mortem

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  detect · diagnose · fix · prevent             │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  failure: origin · propagation · containment   │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  test↔test (parallel): LOAD (where flake lives)│
  │  code↔test framework: LOAD (fix lives here,    │
  │                              not in prod code) │
  │  detect↔mitigate: ABSENT (no tooling)          │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. Now walk the four phases against the real diff.

---

## How it works

**Mental model.** A post-mortem is a *layered cause analysis*. You don't stop at "the test failed" — you ask "why did it fail?" (root cause: shared global state), then "why did that go undetected for so long?" (contributing condition: passes in isolation hide the problem), then "what would have caught it earlier?" (prevention: stricter test isolation discipline). Each layer names a different change you could make; the fix usually touches one of them, the prevention usually touches another.

```
  Pattern — the layered post-mortem

  symptom              "the auth crypto test flakes ~1-in-N"
        ↓ why?
  root cause           process.env.AUTH_SECRET mutated directly;
                       vitest's parallel workers share process.env
        ↓ why undetected?
  contributing         (a) parallel workers — default vitest behavior
  conditions           (b) the test passed in isolation, hiding the leak
                       (c) no afterEach cleanup convention
        ↓ change that resolves?
  fix                  swap to vi.stubEnv (tracked) + vi.unstubAllEnvs in
                       afterEach — restores the env after each test
        ↓ change that prevents?
  prevention           (a) the afterEach itself IS the regression guard
                       (b) the lesson: any test mutating a global must
                           use a tracked-mutation API
        ↓ proof?
  verification         157 tests pass across repeated runs; tsc clean
                       (the same pattern that detected the flake now
                        passes N for N runs)
```

### Move 2 — walk the four phases

#### Detect — the test runner went red

The reader anchor: you've had a CI build fail and wondered what changed. Same shape. The first signal here was vitest's exit code: `npm run test` flaked. Critically, the test *passed in isolation* — running `test/mcp/auth.test.ts` alone always passed. The flake only appeared in a full `vitest run` where parallel workers exercised other test files concurrently.

This pattern ("isolated pass, parallel flake") is the diagnostic *fingerprint* — it always means shared global state. Recognizing the fingerprint cuts the diagnostic loop from "spend an hour staring at the test" to "find the global the test mutates."

Boundary: in this repo, the detection layer is the test runner. There's no Sentry, no production error tracking, no synthetic check — the dev would have to *run the suite* to see the flake. CI presumably runs `npm run test`, so a CI run that flakes catches it eventually, but the detection latency is "next CI run after the bug lands," not "real time."

```
  Detect — what the signal looked like

  developer runs:    npm run test
  vitest output:     ✓ 156 passed
                     ✗ 1 failed (intermittent)
                       auth.test.ts > round-trips an encrypted store

  re-run isolated:   npx vitest run test/mcp/auth.test.ts
                     ✓ 157 passed (always)

  re-run full:       npx vitest run
                     ~ sometimes passes, sometimes fails
                       ▲
                       └─ fingerprint: "isolated pass, parallel flake"
                          → diagnostic shortcut: find the shared global
```

#### Diagnose — name the shared global

The reader anchor: you've debugged a "works on my machine" bug and the answer was an environment variable. Same shape — but the environment variable was being set *inside the test*, not outside it. The mutation `process.env.AUTH_SECRET = 'test-secret-please-ignore'` was the original code (visible in the diff). Vitest runs test files in parallel workers, and `process.env` is shared at the OS-process level.

The diagnostic move is: read the test code and ask "what does this mutate that escapes the test's scope?" Direct `process.env.X = …` is the textbook answer. The leak isn't between test *cases* within a file (those run sequentially); it's between test *files* (those run in parallel workers). The crypto round-trip test depends on `process.env.AUTH_SECRET` being set; a different test file's worker might run first, find no `AUTH_SECRET`, fail. Or might overwrite the value mid-test. Either way: shared mutable state, racing.

Boundary: the diagnosis here used the *test* trace, i.e. vitest's reporter output — not the repo's own observability stack. The trace/snapshot/`console.error` machinery played zero role in finding this bug because the failure was test-time, not runtime. The test runner's structured output was sufficient.

```
  Diagnose — what the parallel-worker leak looks like

  worker A (file 1: auth.test.ts)        worker B (file 2: other.test.ts)
  ─────────────────────────────────       ─────────────────────────────────
  process.env.AUTH_SECRET = 'test'        runs first; no AUTH_SECRET set
  encrypt(store) — needs AUTH_SECRET
  ✓ pass

       (next run, race goes the other way)

  worker A starts; reads process.env      worker B does process.env.X = '…'
  AUTH_SECRET → undefined (overwritten   process.env.AUTH_SECRET → cleared
  or never set in this order)             by another test's cleanup
  encrypt() throws / decrypts garbage
  ✗ flake
                                                          ▲
                                                          └─ shared mutable state,
                                                             racing, no isolation
```

#### Fix — switch to a tracked mutation API

The reader anchor: you've used a setup/teardown pattern in a test framework (Jest's `beforeEach`/`afterEach`, RSpec's `before(:each)`/`after(:each)`). The fix is exactly this — but using vitest's *tracked* env-stubbing primitive, which knows what was changed and how to undo it.

The diff:

```
  - import { describe, it, expect, beforeEach } from 'vitest';
  + import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

    describe('auth cookie crypto (production backend)', () => {
  +   beforeEach(() => {
  +     vi.stubEnv('AUTH_SECRET', 'test-secret-please-ignore');
  +   });
  +   afterEach(() => {
  +     vi.unstubAllEnvs();
  +   });

      it('round-trips an encrypted store under AUTH_SECRET', () => {
  -     process.env.AUTH_SECRET = 'test-secret-please-ignore';
        ...
```

12 lines added, 3 removed, one file. The mechanism: `vi.stubEnv` writes to `process.env` *and* records the prior value; `vi.unstubAllEnvs` restores everything `stubEnv` changed during the test, including for env vars that didn't previously exist (they get *removed*, not left set to `''`).

Boundary: the fix is *test-only*. The production code is unchanged. The original `process.env.AUTH_SECRET = '…'` was never in production — it was test setup that leaked into prod-test interleaving. This matters: the fix doesn't change behavior of the system being tested; it changes the discipline of the test framework's use.

```
  Fix — the tracked-mutation discipline

  before (untracked):                     after (tracked):
  ─────────────────────────               ──────────────────────────────────
  process.env.AUTH_SECRET = '…'           vi.stubEnv('AUTH_SECRET', '…')
            ▲                                       ▲
            │                                       │
            └─ writes the global                   └─ writes the global
            └─ NOT tracked by the framework        └─ TRACKED: vitest knows
            └─ NO cleanup pairing                       what it changed and
                                                        how to undo it
                                                   └─ vi.unstubAllEnvs() in
                                                        afterEach restores
```

#### Prevent — the afterEach IS the regression guard

The reader anchor: you've added a lint rule to prevent a class of mistake. Same shape — but here the "rule" is a convention enforced by the test framework's API. Once the `beforeEach`/`afterEach` pattern is in place, any future test in that `describe` block is automatically isolated. The pattern *itself* is the prevention.

What's the leading indicator that the prevention works? The commit message says it: "157 tests pass across repeated runs; tsc clean." That's verification of the fix; the prevention is the structural change (the convention is now in the file). Future tests in `describe('auth cookie crypto (production backend)', …)` will inherit the cleanup.

Boundary: the prevention is *scoped to one describe block*. If a different test file mutates `process.env.OTHER_VAR` directly, it'll have the same flake potential. There's no project-wide lint rule, no `eslint-plugin-no-process-env-mutate`, no test-runner-level enforcement. The lesson generalises ("any test mutating a global must use a tracked-mutation API") but the prevention is local. Adding a project-wide rule would be a follow-up — not done in this incident.

```
  Prevent — the afterEach itself is the guard

  before (the bug):                       after (the fix):
  ─────────────────────────────────       ─────────────────────────────────
  describe('crypto', () => {              describe('crypto', () => {
    it('round-trips', () => {               beforeEach(() => {
      process.env.AUTH_SECRET = '…'           vi.stubEnv('AUTH_SECRET', '…')
      ...                                  });
    });                                    afterEach(() => {
                                             vi.unstubAllEnvs()
                                           });
                                           it('round-trips', () => { ... });
  })                                      })
                ▲                                          ▲
                │ leaks across files                       │ restored after each test,
                │                                          │ regardless of which file
                                                            │ runs concurrently
```

#### Move 3 — the principle

A flake whose fingerprint is "passes in isolation, fails in parallel" is *always* shared mutable state. The state can be process env, the filesystem, a singleton in a shared module, a database — but the shape of the failure is the same. The discipline that catches this class of bug is *tracked mutation*: any mutation that escapes the test's scope must be done through an API that knows how to undo it. `vi.stubEnv` is one example; `vi.spyOn`, `mockFn.mockReset`, fixture rollback in DB tests are the same idea. The lesson generalises far beyond this repo: when you see the fingerprint, look for `process.env`, `global.X`, module-level mutable state, or filesystem writes. The fix is almost always "swap to a tracked-mutation primitive and add a teardown."

---

## Primary diagram

The full incident lifecycle for `e83a8e0`, with each phase's evidence.

```
  e83a8e0 flake-fix — full incident lifecycle

  ┌─ Detect ─────────────────────────────────────────────────┐
  │  signal: vitest run, ~1-in-N failure on                    │
  │          auth.test.ts > 'round-trips an encrypted store'   │
  │  tooling: test runner exit code (no Sentry, no PagerDuty)  │
  │  fingerprint: "isolated pass + parallel flake"             │
  └─────────────────────────▲───────────────────────────────┘
                            │
  ┌─ Diagnose ──────────────┴───────────────────────────────┐
  │  reading test/mcp/auth.test.ts (pre-diff):                │
  │    process.env.AUTH_SECRET = 'test-secret-please-ignore'  │
  │  ↑ direct mutation of process-level shared state          │
  │  fingerprint applied: shared global → parallel race        │
  │  conclusion: vitest parallel workers race process.env     │
  └─────────────────────────▲───────────────────────────────┘
                            │
  ┌─ Fix ───────────────────┴───────────────────────────────┐
  │  diff: test/mcp/auth.test.ts (12 added, 3 removed)         │
  │    + import { afterEach, vi }                              │
  │    + beforeEach(() => vi.stubEnv('AUTH_SECRET', '…'))      │
  │    + afterEach(() => vi.unstubAllEnvs())                   │
  │    - process.env.AUTH_SECRET = '…'  (× 2)                  │
  │  one file, one describe block, NO production change        │
  └─────────────────────────▲───────────────────────────────┘
                            │
  ┌─ Prevent ───────────────┴───────────────────────────────┐
  │  the afterEach IS the regression guard — env is restored  │
  │  after each test, regardless of which file the worker     │
  │  runs concurrently with                                   │
  │  scope: local to this describe block                      │
  │  lesson generalises (any tracked-mutation primitive);     │
  │  prevention doesn't (no project-wide lint rule)            │
  └─────────────────────────▲───────────────────────────────┘
                            │
  ┌─ Verify ────────────────┴───────────────────────────────┐
  │  commit message: "157 tests pass across repeated runs;    │
  │                   tsc clean."                              │
  │  proof: the same pattern (run the suite N times) that      │
  │  detected the flake now passes N for N runs                │
  └─────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Three real moments the post-mortem template gets exercised:

- **A flaky test reappears.** First move: run the suite repeatedly. If it's the "isolated pass, parallel flake" pattern, look for shared mutable state. The `e83a8e0` template is now a reusable recipe — `vi.stubEnv`/`vi.unstubAllEnvs` for env vars, `vi.spyOn` + `mockRestore` for module-level functions, fixture rollback for DB state. The diagnostic shortcut is fingerprint-first.

- **A user reports a bad investigation result.** Different shape — this is a *runtime* incident, not a *test* incident. The diagnostic loop uses the trace and snapshot machinery (load the `insightId`, the cache replays, scrub the trace looking for the failing event). The phases (detect → diagnose → fix → prevent) are the same; the tooling at each phase is different. This file's lesson — *write the four-phase post-mortem* — applies to both incident kinds.

- **The route catches an exception in prod.** Today, the only detect signal is the `console.error` line in Vercel's stdout plus the `{type:'error',message}` event in the trace. There's no incident tooling past that — no Sentry to dedupe, no PagerDuty to page, no Slack to notify. The repo is in "manual log review" mode for prod incidents. When the first prod incident lands that needs a post-mortem, this file is the template for writing it.

### Code side by side, with a line-by-line read

The fix in place — the comment IS the post-mortem:

```
  test/mcp/auth.test.ts  (lines 112-122, after the fix)

  describe('auth cookie crypto (production backend)', () => {
    // Isolate AUTH_SECRET with vitest's tracked env stubbing: set it before each
    // test and restore the prior environment after. Mutating process.env directly
    // (as before) leaked the var across files running in parallel workers, which
    // made this block flaky. stubEnv/unstubAllEnvs keeps it self-contained.
    beforeEach(() => {
      vi.stubEnv('AUTH_SECRET', 'test-secret-please-ignore');                  ← tracked write
    });
    afterEach(() => {
      vi.unstubAllEnvs();                                                       ← tracked restore
    });

    it('round-trips an encrypted store under AUTH_SECRET', () => {
      // (the original process.env.AUTH_SECRET = '…' line removed here)        ← was: untracked write
      const store = { 'sid-1': { tokens, codeVerifier: 'v', state: 's' } };
      const token = _authCookieCrypto.encrypt(store);
      ...
```

The comment names the root cause ("leaked across files running in parallel workers"), the fix ("stubEnv/unstubAllEnvs"), and the prevention ("keeps it self-contained"). Future readers find the lesson next to the code — no separate post-mortem doc to look up.

The catch sites — what's available in production today for incident *detection*:

```
  app/api/agent/route.ts  (lines 255-260)

  } catch (e) {
    console.error('[agent] error:', e); // full stack/cause in Vercel logs   ← only prod detection signal
    send({
      type: 'error',
      message: `/api/agent · ${e instanceof Error ? e.message : String(e)}`, ← surfaces to UI
    });
  }
        │
        └─ this is the whole detection layer for prod incidents on /api/agent.
           Vercel's log explorer is the dashboard. No aggregation, no
           paging, no rotation. Incident response = "developer notices the
           user's error message and digs in." When a real prod incident
           lands, the post-mortem template from THIS file is what to write.
```

The reproduction primitive — what's available for incident *diagnosis* of runtime bugs:

```
  lib/state/investigations.ts  (lines 22-28)

  export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
    if (mem.has(insightId)) return mem.get(insightId)!;                        ← rung 1
    const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;    ← rung 2 (dev)
    if (fromFile) return fromFile;
    const fromDemo = readJson(DEMO_FILE)[insightId];                           ← rung 3 (committed)
    return fromDemo ?? null;
  }
        │
        └─ for a captured runtime incident, this is the time-machine. Load
           the insightId, replay the run, scrub the trace. The snapshot
           machinery IS the incident-diagnosis tool for runtime bugs (when
           the bug was on the captured path). Different tooling from the
           flake-fix story; same four-phase shape.
```

---

## Elaborate

The post-mortem discipline this repo demonstrates — naming the root cause, the fix, the contributing conditions, and the verification in the commit message — is the SRE-book template scaled to a one-developer codebase. Google's SRE Book emphasizes the *blameless* post-mortem: focus on systemic causes (shared mutable state, lack of teardown convention) rather than human ones ("the developer forgot afterEach"). The `e83a8e0` commit message does this implicitly — it names the framework default (parallel workers) and the missing API (tracked mutation) without finger-pointing.

What this incident *missed* — and worth naming for honesty: there's no automated regression suite that runs N parallel iterations of the test to confirm the flake is fixed. The verification ("157 tests pass across repeated runs") is manual. A more rigorous prevention would add a CI job that runs the test suite K times in parallel and fails if any of the runs flake. That's not built; the commit message claim is the verification. Adding it would close the loop between "we fixed it" and "the fix can't silently regress" — a separate small project, ~1 hour.

What this kind of incident doesn't teach you: production-incident response. The flake-fix lived entirely in the test loop — no users were affected, no rollback was needed, no on-call was paged. Real prod incidents involve mitigation (rollback, feature flag), customer communication, post-incident review with multiple stakeholders, and runbook updates. None of those rungs are exercised in this repo. Naming this explicitly is the point — the one example is good; the absence of others is honest.

The closest related pattern in this codebase: the cache snapshot. If the agent route ever has a regression (e.g. a prompt change degrades the diagnostic agent's accuracy), the snapshot lets you replay pre-regression runs and compare. That's a *regression-diagnosis* tool — different from a runtime-incident tool, but adjacent. The snapshot machinery would slot directly into a regression-suite if someone built one ("for each captured insightId, replay and assert the diagnosis matches the captured one"). Not built; one-week-of-work away. The four-phase post-mortem template generalises to any incident the repo eventually has — runtime, regression, security, performance.

The fingerprint sentence ("isolated pass, parallel flake = shared mutable state") is the reusable distillation. Once you internalise it, every future flake with that fingerprint takes minutes to diagnose instead of hours. The class of bugs is the same shape every time; what changes is *which global* was mutated. Env vars, filesystem entries, singletons, in-process registries, DB rows — all are candidates.

---

## Interview defense

**Q1. Walk me through your one incident in detail.**

The bug: `auth.test.ts > 'round-trips an encrypted store under AUTH_SECRET'` flaked ~1-in-N in full `vitest run`, passed every time in isolation. Detection: a developer ran the suite, saw the failure, noticed the "isolated pass, parallel flake" fingerprint — that's the diagnostic shortcut to "shared mutable state." Diagnosis: read the test, found `process.env.AUTH_SECRET = '…'` — an untracked mutation of process-global state. Vitest's parallel workers share `process.env`, so other test files raced the cleanup. Fix: replace the direct assignment with `vi.stubEnv('AUTH_SECRET', '…')` in `beforeEach` and `vi.unstubAllEnvs()` in `afterEach`. Verification: 157 tests pass across repeated runs, per the commit message. Prevention: the `beforeEach`/`afterEach` pair IS the regression guard for that describe block; the generalisable lesson is "any test mutating a global must use a tracked-mutation API." File touched: `test/mcp/auth.test.ts` only. Production code: unchanged. Commit: `e83a8e0`.

```
  fingerprint  → isolated pass + parallel flake = shared mutable state
  root cause   → process.env mutated directly
  fix          → vi.stubEnv + vi.unstubAllEnvs (tracked mutation)
  prevent      → afterEach is the guard (scoped to describe block)
  verify       → suite passes N for N runs
```

**Anchor:** the fingerprint sentence — "isolated pass, parallel flake is always shared mutable state."

**Q2. What's the smallest move that would turn this incident's lessons into project-wide prevention?**

Three layers, ordered by leverage:

1. **A `tests/setup.ts` that runs `vi.unstubAllEnvs()` in a project-wide `afterEach`.** Vitest supports a global setup file referenced from `vitest.config.ts`. One line in the setup, every test in every file gets the cleanup automatically. Zero adoption cost for future tests.

2. **An ESLint rule banning `process.env.X = …` in `test/**` files.** Either a custom rule or `eslint-plugin-no-restricted-syntax` with a selector matching assignment expressions on `process.env`. Prevents the mistake at lint time, before it reaches CI.

3. **A CI job that runs `vitest run` K times in a row (e.g. K=5).** If any iteration flakes, the job fails. Catches not just env leaks but any shared-state flake. Adds K× test time to CI — acceptable for K=5 if total test time is short.

The first move is the smallest and highest-leverage. The second is preventive (catches the mistake before commit). The third is verification (catches it before deploy). Doing all three is overkill for a solo repo today; the first one alone closes the gap from "this one describe block is safe" to "every describe block in the project is safe by default."

```
  layer 1: tests/setup.ts        → 1 line, all tests inherit cleanup
  layer 2: ESLint rule           → preventive, blocks the mistake
  layer 3: CI ×K flake guard     → verification, catches drift
                                          ▲
                                          └─ today: none of the three is built
                                             smallest valuable add: layer 1
```

**Anchor:** name the three layers by *what they prevent* — automatic cleanup, banned syntax, drift detection. Each closes a different failure mode.

---

---

## See also

- `audit.md` — the broader lens audit; this incident is named in incident-analysis-and-prevention as the only documented incident in the repo.
- `01-ndjson-agentevent-discriminated-union.md` — the typed-event discipline that's the runtime-incident analog of "tracked mutation."
- `03-three-rung-mem-file-seed-store.md` — the snapshot machinery as a regression-diagnosis substrate for runtime incidents.
- `04-dual-write-send-to-stream-and-store.md` — the dual-write that captures runtime evidence (the analog of the test runner's reporter output for runtime bugs).
- `06-eval-result-paper-trail.md` (RETIRED) — once held two additional incident anecdotes (the BRL cents-vs-Reais model-level bug surfaced by the judge, and the parallel-run K=10 race detected via `ps aux`). Both incidents were RESOLVED-BY-DELETION when PR #8 removed the Olist pipeline. The anecdotes remain instructive in the historical file; they no longer describe a live system.
- `.aipe/study-testing/` — the testing discipline that this flake-fix exemplifies; that guide owns the testing lessons, this one owns the incident lessons.
- `.aipe/study-security/` — the auth/crypto layer the test was exercising (`_authCookieCrypto`).

---
Updated: 2026-06-19 — reverted framing to "the only documented incident in the repo" after PR #8 removed the Olist pipeline; the BRL bug and parallel-run race noted in the previous refresh are RESOLVED-BY-DELETION; cross-link to `06-` retained with RETIRED treatment.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
