# Story: AUTH_SECRET flake — the only documented incident with a clean fingerprint

**Competency:** failure-recovery ★ (the non-negotiable senior-bar slot)
**Also probes:** technical-judgment (recognizing the diagnostic fingerprint)
**Lands at:** Anthropic | Meta | Google | all
**Project / context:** blooming insights (Loomi Connect AI Hackathon, 2026-05-27 → 2026-06-02)
**Cross-link:** [`.aipe/study-debugging-observability/05-auth-secret-flake-postmortem.md`](../study-debugging-observability/05-auth-secret-flake-postmortem.md) · [`.aipe/rehearse-interview-defense/05-the-failure-story.md`](../rehearse-interview-defense/05-the-failure-story.md)

---

## Situation

Day 2 of the 7-day Loomi Connect hackathon. The vitest suite for `blooming_insights` had been green for ~3 days of build. On a routine full-suite run on `2026-05-28`, one test went red intermittently: `test/mcp/auth.test.ts > 'round-trips an encrypted store under AUTH_SECRET'`. The test passed every time in isolation; flaked roughly 1-in-N in full parallel `vitest run`. The OAuth flow itself was fine in dev — but the same `_authCookieCrypto` module is what encrypts the production session cookie on Vercel, so a real flake here meant the demo cookie could fail to decrypt on stage.

## Task

I owned the flake. Solo project, no one else was going to look at it. The specific decision I owned was: **diagnose the root cause, write a fix that prevents the class of bug, and document the lesson in a place where the next person (likely me, six weeks from now) can't silently revert it.** Not "just make the test green again" — that's an L0 move on a test flake.

## Action

I recognized the fingerprint immediately: **"isolated pass, parallel flake" is always shared mutable state.** That sentence is what cut the diagnostic loop from "stare at the test for an hour" to "find the global the test mutates." I opened `test/mcp/auth.test.ts`, scrolled to the failing describe block, and the third line was `process.env.AUTH_SECRET = 'test-secret-please-ignore'` — an untracked mutation of an OS-process-level global. Vitest's default is parallel workers; `process.env` is shared across them; another test file's worker was racing my cleanup.

I considered three fixes and rejected two. **Rejected: run vitest in single-worker mode** (`--no-file-parallelism`) — that's hiding the bug, not fixing it, and it doubles the test-suite wall-clock. **Rejected: a custom global-setup that pre-sets `AUTH_SECRET` before any worker starts** — that fixes the symptom but leaves the underlying anti-pattern (direct `process.env` mutation in test files) in place; future tests would re-introduce the same flake.

**Chose: switch to vitest's tracked-mutation API** — `vi.stubEnv('AUTH_SECRET', '…')` in `beforeEach`, `vi.unstubAllEnvs()` in `afterEach`. Tracked mutations know how to undo themselves; the `afterEach` IS the regression guard. The diff: 12 lines added, 3 removed, one file. Production code untouched.

Then the part that makes it a senior move: I wrote a comment block at the top of the describe block — five lines — that names the root cause ("leaked across files running in parallel workers"), the fix ("stubEnv/unstubAllEnvs"), and the prevention ("keeps it self-contained"). The comment lives next to the code so future readers find the lesson without looking up a separate post-mortem doc. The comment IS the post-mortem.

Commit: `e83a8e0`. Files touched: `test/mcp/auth.test.ts` only.

## Result

The verification I ran: the same pattern (full `vitest run`) that detected the flake passed clean across repeated runs after the fix. The commit message records "157 tests pass across repeated runs; tsc clean." Production code: zero change — the `_authCookieCrypto` module never had a bug; the test file did.

Beyond the immediate fix, the lesson generalised: every flake in this repo whose fingerprint matches "isolated pass, parallel flake" now short-circuits to "find the shared global." This is the only documented incident in `blooming_insights` with a clean root-cause arc, and it earned its own pattern file at `.aipe/study-debugging-observability/05-auth-secret-flake-postmortem.md` — which the `2026-06-02` recon audit then named as the **single L2 spike outside the AI surface** that keeps the repo's median from sliding to L0-with-claims.

## What I'd do differently / what I learned

I'd add a project-wide `tests/setup.ts` that runs `vi.unstubAllEnvs()` in a global `afterEach` — one line in the vitest config, every test in every file gets the cleanup automatically. Today the prevention is scoped to one describe block; a different test file mutating `process.env.OTHER_VAR` directly would have the same flake potential. The lesson I'd internalise harder: **when a fix is local, the prevention is local — generalising the prevention is a separate move and it's worth doing in the same PR.**

---

## Defense — likely follow-ups

- **Q: Walk me through the diagnostic in detail. How did you know to look at `process.env` first?**
  A: The fingerprint. "Isolated pass + parallel flake" is always shared mutable state — that's the diagnostic shortcut. Once I had that, the question wasn't "what's wrong with the test," it was "what global does the test mutate?" I opened the file, the third line was `process.env.AUTH_SECRET = '…'`, and the diagnosis was done. The fingerprint cuts an hour of staring into ~30 seconds of code-reading.

- **Q: Why use `vi.stubEnv` instead of just `delete process.env.AUTH_SECRET` in `afterEach`?**
  A: Two reasons. First, `vi.stubEnv` is *tracked* — vitest knows what it changed, including whether the variable existed before, and `unstubAllEnvs` restores the prior state correctly (removes vars that didn't previously exist instead of leaving them as `''`). A manual `delete` doesn't distinguish "was unset" from "was set to something else." Second, naming it `vi.stubEnv` flags the *intent* — this is a test stub, not production code — which makes the test file's discipline visible in grep.

- **Q: What about a project-wide ESLint rule banning direct `process.env.X = …` in `test/**`?**
  A: That's the right move and I didn't ship it. The smallest add is layer 1 (`tests/setup.ts` with a global `afterEach`); the next layer is the lint rule. Both would close the gap between "this describe block is safe" and "every test in the project is safe by default." I'd ship layer 1 in the same PR as the fix next time, and the lint rule as a follow-up.

- **Q: This is a test-infra bug, not a production incident. What would change if a user actually hit a broken AUTH_SECRET in production?**
  A: Honest answer: the detection layer is the test runner. There's no Sentry, no PagerDuty, no production error tracker — a user would see the OAuth flow fail and presumably stop using the product. The mitigation in prod would be cookie rotation + re-auth, but the detection latency would be "developer notices the user's error message." The four-phase post-mortem template I wrote in `05-auth-secret-flake-postmortem.md` is what I'd use to write up a real production incident when one lands. The template is reusable; the *tooling* at each phase (detect/diagnose/fix/prevent) is not built yet.

- **Q: You said you "recognized the fingerprint immediately." Where did that intuition come from?**
  A: Reading about parallel-test flakes in other people's post-mortems — Google's SRE Book chapter on flake taxonomies, plus a few Jest / RSpec migration writeups where the same pattern shows up. The fingerprint sentence is mine; the underlying pattern is industry-standard. The senior signal isn't inventing the fingerprint — it's recognising it fast enough that the diagnosis takes minutes instead of hours.
