# Incident analysis and prevention

**Industry name(s):** post-mortem, root cause analysis, contributing conditions, regression guard, blameless review
**Type:** Industry standard · Language-agnostic

> Honest verdict: this repo has one documented incident with a clean root cause, a one-file fix, and a regression guard — commit `e83a8e0` (the flake-fix). That's it. There's no Sentry, no on-call rotation, no incident-management tool, no runbook directory, no SLO breach process. So this file does two things: (1) walk the `e83a8e0` flake-fix end-to-end as the canonical worked example of "reproduce → isolate → verify → prevent", and (2) name precisely what's missing for incident response past that one shape. The lesson the flake-fix teaches is real and reusable: when you find a "passes in isolation, flakes in parallel" pattern, the answer is almost always *shared mutable state* — in this case, `process.env`.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Incident response is a *workflow*: detect → mitigate → reproduce → diagnose → fix → prevent. Each step has its own tooling stack in a mature org (PagerDuty for detect, runbooks for mitigate, snapshots for reproduce, traces for diagnose, code review for fix, regression tests for prevent). blooming insights has *some* of those — the trace and the snapshot are real diagnose/reproduce tools — but it has *none* of detect/mitigate/runbook tooling. The one incident the repo has on record (flake) was detected by the test runner, not by users; that's why it could be handled inside the development loop with no incident-management overhead.

```
  Zoom out — where incident response sits across layers

  ┌─ User / observation surface ────────────────────┐
  │  no Sentry, no PagerDuty, no error-tracker       │
  │  detection = "the user reports something broke"  │
  │  OR "the test runner went red"                   │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ Diagnosis tooling ─────┴───────────────────────┐
  │  ★ trace (live + cache replay) ★                 │
  │  ★ snapshot (3-rung store) ★                     │
  │  4× console.error in route catches                │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ Fix + prevent ─────────┴───────────────────────┐  ← we are here
  │  test suite (vitest) is the regression-guard      │
  │  layer; the e83a8e0 fix added afterEach           │
  │  unstubAllEnvs to prevent recurrence              │
  └─────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** A post-mortem is the *written artifact* of an incident — the timeline, the root cause, the contributing conditions, the fix, the regression guard. The discipline of writing one is what converts "we fixed it" into "this kind of bug won't happen again here." The repo's one post-mortem is the commit message on `e83a8e0`: it names the root cause (`process.env.AUTH_SECRET` mutated directly, leaked across vitest's parallel workers), the fix (switch to `vi.stubEnv` + `vi.unstubAllEnvs`), the verification (157 tests pass across repeated runs), and the contributing condition (parallel workers + shared global state). Five lines, all four parts.

---

## Structure pass

**Layers.** Four phases of an incident: detect (how you find out), diagnose (how you understand it), fix (the change that resolves it), prevent (the change that stops it from happening again).

**Axis: failure (where does the failure originate, propagate, and get contained?).** The flake-fix tells a clean story along this axis. Originate: the auth crypto test file set `process.env.AUTH_SECRET = '…'` directly. Propagate: vitest's parallel workers share the `process.env` global; the var leaked into other test files' processes. Contained: nowhere — that's why it flaked. The fix shifts containment into the test framework (`vi.stubEnv` tracks the change and restores it via `vi.unstubAllEnvs` in `afterEach`).

**Seams.** Two load-bearing:

- **Test ↔ test (parallel worker boundary).** Vitest's default is parallel files. The boundary is where state *should* be isolated but wasn't. The flake lived at this seam.
- **Code ↔ test framework.** The fix doesn't change the production code; it changes the *test discipline* around it. The seam between "what you're testing" and "how you're testing" is where the prevention happens.

A *missing* seam — for honesty: no detect↔mitigate seam exists in this repo. There's no automated alert, no on-call rotation, no runbook to grab. When the test went red, a human noticed; when a user reports a production bug, a human notices. The repo has no automation around incident detection.

```
  Structure pass — incident analysis

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  detect · diagnose · fix · prevent             │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  failure: where does it originate, propagate,  │
  │  get contained?                                │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  test↔test (parallel worker): LOAD (the flake) │
  │  code↔test framework: LOAD (the fix lives here)│
  │  (gap: detect↔mitigate has no tooling)         │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. Now walk the worked example.

---

## How it works

**Mental model.** A post-mortem is a *layered cause analysis*. You don't stop at "the test failed" — you ask "why did it fail?" (root cause: shared global state), then "why did that go undetected for so long?" (contributing condition: passes in isolation hide the problem), then "what would have caught it earlier?" (prevention: stricter test isolation discipline). Each layer names a different change you could make; the fix usually touches one of them, the prevention usually touches another.

```
  Pattern — the layered post-mortem

  symptom              "the auth crypto test flakes ~1-in-N"
        ↓
  root cause           process.env.AUTH_SECRET mutated directly;
                       vitest's parallel workers share process.env
        ↓
  contributing         (a) parallel workers — default vitest behavior
  conditions           (b) the test passed in isolation, hiding the leak
                       (c) no afterEach cleanup convention
        ↓
  fix                  swap to vi.stubEnv (tracked) + vi.unstubAllEnvs in
                       afterEach — restores the env after each test
        ↓
  prevention           (a) the afterEach itself IS the regression guard
                       (b) the lesson: any test mutating a global must
                           use a tracked-mutation API
        ↓
  verification         157 tests pass across repeated runs; tsc clean
```

The diagram is the workflow. The worked example below walks each rung against the real diff.

### Move 2 — walk the flake-fix end to end

#### Detect — the test runner went red

The reader anchor: you've had a CI build fail. The first signal here was vitest's exit code: `npm run test` flaked. Importantly, the test *passed in isolation* — running `test/mcp/auth.test.ts` alone always passed. The flake only appeared in a full `vitest run` where parallel workers exercised other test files concurrently. This pattern ("isolated pass, parallel flake") is the diagnostic fingerprint — it always means shared global state.

What happened: a developer ran the full test suite, saw `auth.test.ts > round-trips an encrypted store` fail intermittently. The full diagnostic process took less than a session because the fingerprint is well-known.

Boundary: in this repo, the detection layer is the test runner. There's no Sentry, no production error tracking, no synthetic check — the dev would have to *run the suite* to see the flake. CI presumably runs `npm run test`, so a CI run that flakes catches it eventually, but the detection latency is "next CI run after the bug lands," not "real time."

#### Diagnose — name the shared global

The reader anchor: you've debugged a "works on my machine" bug and the answer was an environment variable. Same shape — but the environment variable was being set *inside the test*, not outside it. The mutation `process.env.AUTH_SECRET = 'test-secret-please-ignore'` was the original code (visible in the diff). Vitest runs test files in parallel workers (separate processes? same process? — important question, see below), and `process.env` is shared at the OS-process level.

What happened: the diagnostic move is to read the code and ask "what does this mutate that escapes the test's scope?" `process.env.X = …` is the textbook answer. The leak isn't between test *cases* (those run sequentially within a file), it's between test *files* (those run in parallel workers). The crypto round-trip test depends on `process.env.AUTH_SECRET` being set; a different test file's worker might run first, find no `AUTH_SECRET`, fail. Or might overwrite the value mid-test. Either way: shared mutable state, racing.

Boundary: the diagnosis here used the trace's neighbor — the *test* trace, i.e. vitest's output. There's no equivalent of `lib/mcp/events.ts` for tests; vitest's own reporter is the trace surface. This is *fine* because the testing framework already has structured output. The point: the repo's own observability stack (trace, snapshot, console.error) played zero role in diagnosing this incident — the test runner's output was sufficient.

```
  Diagnose — what the parallel-worker leak looks like

  worker A (file 1: auth.test.ts)        worker B (file 2: other.test.ts)
  ─────────────────────────────────       ─────────────────────────────────
  process.env.AUTH_SECRET = 'test'        runs first; no AUTH_SECRET set
  encrypt(store) — needs AUTH_SECRET
  ✓ pass

       (next run, race goes the other way)

  worker A starts; reads process.env      worker B does process.env.X = 'other'
  AUTH_SECRET → undefined (overwritten   process.env.AUTH_SECRET → cleared
  or never set in this order)             by another test's cleanup
  encrypt() throws / decrypts garbage
  ✗ flake
```

#### Fix — switch to a tracked mutation API

The reader anchor: you've used a setup/teardown pattern in a test framework (Jest's `beforeEach`/`afterEach`, RSpec's `before(:each)/after(:each)`). The fix is exactly this — but using vitest's *tracked* env stubbing primitive, which knows what was changed and how to undo it.

What changed (the diff):

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

#### Prevent — the afterEach IS the regression guard

The reader anchor: you've added a lint rule to prevent a class of mistake. Same shape — but here the "rule" is a convention enforced by the test framework's API. Once the `beforeEach`/`afterEach` pattern is in place, any future test in that `describe` block is automatically isolated. The pattern *itself* is the prevention.

What's the leading indicator that the prevention works? The commit message says it: "157 tests pass across repeated runs; tsc clean." That's verification of the fix; the prevention is the structural change (the convention is now in the file). Future tests in `describe('auth cookie crypto (production backend)', …)` will inherit the cleanup.

Boundary: the prevention is *scoped to one describe block*. If a different test file mutates `process.env.OTHER_VAR` directly, it'll have the same flake potential. There's no project-wide lint rule, no `eslint-plugin-no-process-env-mutate`, no test-runner-level enforcement. The lesson generalises ("any test mutating a global must use a tracked-mutation API") but the prevention is local.

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
                │ leaks across files                       │ restored after each
                │                                          │ test, regardless of
                                                            │ which file runs
```

#### Move 3 — the principle

A flake whose fingerprint is "passes in isolation, fails in parallel" is *always* shared mutable state. The state can be process env, the filesystem, a singleton in a shared module, a database — but the shape of the failure is the same. The discipline that catches this class of bug is *tracked mutation*: any mutation that escapes the test's scope must be done through an API that knows how to undo it. `vi.stubEnv` is one example; `vi.spyOn`, `mockFn.mockReset`, fixture rollback in DB tests are the same idea. The lesson generalises beyond this repo: when you see the fingerprint, look for `process.env`, `global.X`, module-level mutable state, or filesystem writes. The fix is almost always "swap to a tracked-mutation primitive and add a teardown."

---

## Primary diagram

The full incident lifecycle for `e83a8e0`, with each phase's file:line.

```
  e83a8e0 flake-fix — full incident lifecycle

  ┌─ Detect ─────────────────────────────────────────────────┐
  │  signal: vitest run, ~1-in-N failure on                    │
  │          auth.test.ts > 'round-trips an encrypted store'   │
  │  tooling: test runner exit code (no Sentry, no PagerDuty)  │
  └─────────────────────────▲───────────────────────────────┘
                            │ pattern: passes in isolation
  ┌─ Diagnose ──────────────┴───────────────────────────────┐
  │  reading test/mcp/auth.test.ts (pre-diff):                │
  │    process.env.AUTH_SECRET = 'test-secret-please-ignore'  │
  │  ↑ direct mutation of process-level shared state          │
  │  fingerprint: "isolated pass, parallel flake"             │
  │  conclusion: vitest parallel workers race process.env     │
  └─────────────────────────▲───────────────────────────────┘
                            │
  ┌─ Fix ───────────────────┴───────────────────────────────┐
  │  diff: test/mcp/auth.test.ts (12 added, 3 removed)         │
  │    + import { afterEach, vi }                              │
  │    + beforeEach(() => vi.stubEnv('AUTH_SECRET', '…'))      │
  │    + afterEach(() => vi.unstubAllEnvs())                   │
  │    - process.env.AUTH_SECRET = '…'  (× 2)                  │
  │  one file, one describe block, no production change        │
  └─────────────────────────▲───────────────────────────────┘
                            │
  ┌─ Prevent ───────────────┴───────────────────────────────┐
  │  the afterEach IS the regression guard — env is restored  │
  │  after each test, regardless of which file the worker     │
  │  runs concurrently with                                   │
  │  scope: local to this describe block                      │
  │  lesson generalises (any tracked-mutation), prevention    │
  │  doesn't (no project-wide lint)                            │
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

Three real moments where the incident-response shape gets exercised:

- **A flaky test reappears.** First move: run the suite repeatedly. If it's the "isolated pass, parallel flake" pattern, look for shared mutable state. The `e83a8e0` template is now a reusable recipe — `vi.stubEnv`/`vi.unstubAllEnvs` for env vars, `vi.spyOn` + `mockRestore` for module-level functions, fixture rollback for DB state.

- **A user reports a bad investigation result.** The diagnostic loop is different — there's no test runner involved. Load their `insightId`, the cache replays the captured run, you scrub the trace looking for the failing event. The trace + snapshot machinery IS the incident-diagnosis tool for runtime bugs. (See `02-reproduction-and-evidence.md`.)

- **The route catches an exception in prod.** Today, the only signal is the `console.error` line in Vercel's stdout (`app/api/agent/route.ts:160,256`; `app/api/briefing/route.ts:166,248`) plus the `{type:'error',message}` event in the trace (which the user sees in the UI). There's no incident tooling past that — no Sentry to dedupe, no PagerDuty to page, no Slack to notify. The repo is in "manual log review" mode for prod incidents.

### Code side by side, with a line-by-line read

The fix diff — the smallest meaningful incident-fix in the repo:

```
  test/mcp/auth.test.ts  (lines 1, 112–123, after the fix)

  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';   ← added: afterEach, vi
  ...
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
      expect(typeof token).toBe('string');
      expect(token).not.toContain('tok');
      expect(_authCookieCrypto.decrypt(token)).toEqual(store);
    });
    ...
  })
        │
        └─ the comment IS the post-mortem. It names the root cause
           ("leaked across files running in parallel workers") and the
           prevention ("stubEnv/unstubAllEnvs keeps it self-contained").
           Future readers find the lesson next to the code.
```

The catch sites — what's available in production today for incident *detection*:

```
  app/api/agent/route.ts  (lines 256–260)

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
           paging, no rotation. Incident response = "developer notices
           the user's error message and digs in."
```

The reproduction primitive — what's available for incident *diagnosis*:

```
  lib/state/investigations.ts  (lines 22–28)

  export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
    if (mem.has(insightId)) return mem.get(insightId)!;                        ← rung 1
    const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;    ← rung 2 (dev)
    if (fromFile) return fromFile;
    const fromDemo = readJson(DEMO_FILE)[insightId];                           ← rung 3 (committed)
    return fromDemo ?? null;
  }
        │
        └─ for a captured incident, this is the time-machine. Load the
           insightId, replay the run, scrub the trace. The snapshot
           machinery IS the incident-diagnosis tool for runtime bugs
           (when the bug was on the captured path).
```

---

## Elaborate

The post-mortem discipline blooming insights demonstrates — naming the root cause, the fix, the contributing conditions, and the verification in the commit message — is the SRE-book template scaled to a one-developer codebase. Google's SRE Book emphasizes the *blameless* post-mortem: focus on systemic causes (shared mutable state, lack of teardown convention) rather than human ones ("the developer forgot afterEach"). The `e83a8e0` commit message does this implicitly — it names the framework default (parallel workers) and the missing API (tracked mutation) without finger-pointing.

What this incident *missed* — and worth naming for honesty: there's no automated regression suite that runs N parallel iterations of the test to confirm the flake is fixed. The verification ("157 tests pass across repeated runs") is manual. A more rigorous prevention would add a CI job that runs the test suite K times in parallel and fails if any of the runs flake. That's not built; the commit message claim is the verification.

What this kind of incident doesn't teach you: production-incident response. The flake-fix lived entirely in the test loop — no users were affected, no rollback was needed, no on-call was paged. Real prod incidents involve mitigation (rollback, feature flag), customer communication, post-incident review with multiple stakeholders, and runbook updates. None of those rungs are exercised in this repo. Naming this explicitly is the point — the one example is good, the absence of others is honest.

The closest related pattern in this codebase: the cache snapshot. If the agent route ever has a regression (e.g. a prompt change degrades the diagnostic agent's accuracy), the snapshot lets you replay pre-regression runs and compare. That's a *regression-diagnosis* tool — different from a runtime-incident tool, but adjacent. The snapshot machinery would slot directly into a regression-suite if someone built one ("for each captured insightId, replay and assert the diagnosis matches the captured one"). Not built; one-week-of-work away.

---

## Interview defense

**Q1. Walk me through your one incident in detail.**

The bug: `auth.test.ts > 'round-trips an encrypted store under AUTH_SECRET'` flaked ~1-in-N in full `vitest run`, passed every time in isolation. Detection: a developer ran the suite, saw the failure, noticed the "isolated pass, parallel flake" fingerprint. Diagnosis: read the test, found `process.env.AUTH_SECRET = '…'` — an untracked mutation of process-global state. Vitest's parallel workers share `process.env`, so other test files raced the cleanup. Fix: replace the direct assignment with `vi.stubEnv('AUTH_SECRET', '…')` in `beforeEach` and `vi.unstubAllEnvs()` in `afterEach`. Verification: 157 tests pass across repeated runs, per the commit message. Prevention: the `beforeEach`/`afterEach` pair IS the regression guard for that describe block; the generalisable lesson is "any test mutating a global must use a tracked-mutation API." File touched: `test/mcp/auth.test.ts` only. Production code: unchanged. Commit: `e83a8e0`.

```
  fingerprint  → isolated pass + parallel flake = shared mutable state
  root cause   → process.env mutated directly
  fix          → vi.stubEnv + vi.unstubAllEnvs (tracked mutation)
  prevent      → afterEach is the guard (scoped to describe block)
  verify       → suite passes N for N runs
```

**Anchor:** the fingerprint sentence — "isolated pass, parallel flake is always shared mutable state."

**Q2. The repo has no Sentry, no PagerDuty, no runbooks. What's the smallest move that would change that?**

The smallest move is probably *not* adding Sentry — it's adding a `lib/log.ts` first. The 4× `console.error` lines need structured fields (`event`, `insightId`, `route`, `error`) before a Sentry breadcrumb would carry useful context. Once structured logs exist, Sentry is a one-line `Sentry.captureException(e, {tags: fields})` at each catch site. Without the structured fields, Sentry inherits the same lossy strings the console does. So: (1) add `lib/log.ts`, ~30 lines, (2) swap the 4 catches, (3) add Sentry at the catch sites with the structured tags as breadcrumbs. The full diff is small; the order matters. Naming the order is the credibility signal — adding Sentry first would gold-plate the gap, not fix it.

```
  step 1  lib/log.ts  (30 lines)        → structured fields exist
  step 2  swap 4 console.error          → catches emit structured
  step 3  add Sentry.captureException   → tags = structured fields
                                          (rich incident context)
```

**Anchor:** the structured-log layer is the prerequisite for any meaningful incident tooling. Skipping it gives you a fancy dashboard of opaque strings.

---

## Validate

1. **Reconstruct.** Without looking, name the four phases of an incident lifecycle and what the `e83a8e0` flake-fix did at each phase.
2. **Explain.** Why is "passes in isolation, flakes in parallel" a diagnostic fingerprint, and what does it always point to? Anchor: `test/mcp/auth.test.ts:117–122`.
3. **Apply to a scenario.** A user reports the recommendation panel was empty for one investigation. Walk the incident-response phases (detect, diagnose, fix, prevent) and name what tooling exists and what's missing at each phase.
4. **Defend the decision.** Argue for adding Sentry to this repo today. Argue against. Name the leading indicator that flips the decision.

---

## See also

- `02-reproduction-and-evidence.md` — the cache replay is the diagnosis tool for captured runtime bugs.
- `03-structured-logs-and-correlation.md` — the prerequisite layer for any incident tooling past `console.error`.
- `06-state-snapshots-and-debugging-boundaries.md` — the snapshot machinery as a regression-diagnosis substrate.
- `08-debugging-observability-red-flags-audit.md` — where the missing incident tooling is ranked.
- `.aipe/study-testing/` — the testing discipline that the flake-fix exemplified; that guide owns the testing lessons, this one owns the incident lessons.
