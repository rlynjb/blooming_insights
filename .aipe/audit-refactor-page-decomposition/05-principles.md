# Chapter 05 — Principles

The principles chapter walks the catalog principles — SRP, DRY, Separation of Concerns, Dependency Inversion, Open/Closed, Liskov, Interface Segregation, Locality of Behaviour, Principle of Least Surprise, Tell-Don't-Ask — and asks which ones the feed page honors, which ones it violates, and which violations matter for the through-line. The opinionated take is at the top: **the page violates SRP loudly, Separation of Concerns subtly, and the Principle of Least Surprise at exactly one well-commented site. The first two are the cleanup the audit names. The third is the failure mode the integration test from precondition B has to catch.**

## Map of the territory

- **DEEP — Single Responsibility (`app/page.tsx`).** Already named as the headline violation across multiple audits. This chapter reframes the depth-ratio argument around the four-hook lift and the ordering Chapter 01 prescribes.
- **DEEP — Separation of Concerns (the reconnect branch buried inside the NDJSON `error` handler).** The subtler violation. Wire-format parsing and session-state mutation share a switch arm. The fix is `useReconnectPolicy`.
- **DEEP — Principle of Least Surprise (the reconnect branch's window.location reload from inside a stream handler).** The deliberate surprise that's load-bearing but mis-located. The comment is good; the placement is wrong.
- **BRIEF — Locality of Behaviour.** The page honors LoB by default; the reconnect branch's comments are the canonical example.
- **MENTION** — Tell-Don't-Ask. Minor: the page reads `localStorage.getItem('bi:mode')` inline; would be cleaner if the mode hook owned the read.
- **NOT FOUND — DRY.** The NDJSON parser duplication is a DRY violation by the strict reading, but it's covered as Extract Module in Chapter 02; the principle framing adds nothing.
- **NOT FOUND — Dependency Inversion.** The page is React-level — no concrete-vs-abstract dependency seam. The route-layer DI violation is covered in the eval-substrate notebook; it's the same issue, different layer.
- **NOT FOUND — Open/Closed, Liskov, Interface Segregation.** No inheritance, no interface hierarchy at the page layer. Not applicable.

---

### Single Responsibility — `app/page.tsx` (DEEP)

**Where it's violated.** One default export. Eight concerns. The list, from the cleanup audit and `study-software-design/02-shallow-module-page-component.md`:

1. Layout + JSX rendering (~340 LOC)
2. NDJSON stream reading (~50 LOC inside the big effect)
3. Reconnect policy on revoked token (~30 LOC buried in the `error` arm)
4. Demo-capture orchestration (~100 LOC; dev-only)
5. Mode toggle + persistence (~30 LOC including the effect that resolves it)
6. Coverage tile accumulation (~5 LOC in the `coverage_item` arm)
7. Trace item accumulation (~30 LOC across multiple arms)
8. Stepper-state derivation (`monitoringState` + `monitoringSub`, ~20 LOC)

15 useState slots, all visible to the JSX, all mutable from the big effect.

```
The depth-ratio failure — what SRP actually measures

  BEFORE
  ┌─ app/page.tsx (817 LOC) ────────────────────────────────────┐
  │  visible interface: 15 useState slots, all read by JSX        │
  │  implementation:    218-LOC effect, 100-LOC capture flow,     │
  │                     2-LOC stepper helpers, 339-LOC JSX        │
  │                                                                │
  │  interface ≈ implementation                                    │
  │  every contributor learns all 15 slots to edit one concern    │
  └────────────────────────────────────────────────────────────────┘

  AFTER (four hooks + Chapter 02 preconditions)
  ┌─ app/page.tsx (~120 LOC) ───────────────────────────────────┐
  │  visible interface: layout + composition (4 hook calls)      │
  │  implementation:    ~80 LOC of JSX                            │
  │                                                                │
  │  interface < implementation per concern                       │
  │  contributor learns one hook to edit one concern              │
  └────────────────────────────────────────────────────────────────┘

  the depth ratio isn't about LOC. it's about
  "how much does a contributor have to learn to edit safely?"
  before:  everything
  after:   one hook
```

**Why it matters here.** Cognitive load on the next contributor is the immediate cost — already named in three audits. The deeper cost for this notebook's through-line is testability: the file in its current shape cannot be unit tested (no `@testing-library/react`, no `environment: 'jsdom'` in `vitest.config.ts`), and the integration test from precondition B has to mount the entire file just to assert that the mode persistence works. After the four-hook lift, each concern has its own seam where a unit test can mount one hook in isolation — the integration test becomes the end-to-end backstop, not the only test scaffold.

**Is it worth fixing?** Yes — and the ordering matters. The cleanup audit's `fix-later #8` rating is correct (not urgent, not on a critical path); this notebook adds: the *order* in which the four hooks lift is the load-bearing decision. `useModePersistence` first (warmup, lowest risk, proves the integration-test scaffold from precondition B), then `useBriefingStream` (headline, depends on Chapter 02 precondition A), then `useReconnectPolicy` (corrects the Separation of Concerns violation below), then `useDemoCapture` (dev-only; ships last because its blast radius is smallest). Chapter 01 walks the order in detail. The principle-level claim: SRP at this scale is best fixed in four sequential cuts, not one big lift, because each cut leaves the test scaffold and the rest of the code in a working state for the next reviewer.

**Which techniques would address it.** Extract Hook (the four lifts), Extract Module (the NDJSON kernel as Chapter 02 precondition), Move Function (`monitoringState`/`monitoringSub` to the stepper component). Cross-references: `.aipe/study-software-design/02-shallow-module-page-component.md` (the deep walk), `.aipe/specs/refactors/00-plan-2026-06-14.md` (the execution sequence), this notebook Chapter 01 (the ordered ranking) and Chapter 02 (the structural preconditions).

---

### Separation of Concerns — the reconnect branch inside the NDJSON `error` handler (DEEP)

**Where it's violated.** `app/page.tsx:400-435`. Inside the big effect's `handle()` switch, the `case 'error':` arm does two things in one block:

1. **Wire-format-level work**: receive an `error` event with a `message`, regex-match against an auth-failure pattern.
2. **Session-state-level work**: read sessionStorage's `bi:reconnecting` flag to check whether reconnect has been tried already, set the flag if not, set the `reconnecting` UI state, call `/api/mcp/reset`, then redirect the window to `/`.

```
The violation — two concerns in one switch arm

  case 'error': {
    const msg = evt.message ?? 'something went wrong'
    if (/invalid_token|unauthor|forbidden|401|session expired|reconnect/i.test(msg)) {
      ── WIRE-FORMAT CONCERN  ↑ above this line
      ── SESSION-STATE CONCERN ↓ below this line
      let alreadyTried = false
      try {
        alreadyTried = sessionStorage.getItem('bi:reconnecting') === '1'
      } catch { /* ignore */ }
      if (!alreadyTried) {
        try { sessionStorage.setItem('bi:reconnecting', '1') } catch { /* ignore */ }
        setReconnecting(true)
        fetch('/api/mcp/reset', { method: 'POST' }).finally(() => {
          window.location.href = '/'
        })
        return
      }
      try { sessionStorage.removeItem('bi:reconnecting') } catch { /* ignore */ }
    }
    setErrorMessage(msg)
    setStatus('error')
    break
  }
```

The arm parses a wire-format event and immediately calls `window.location.href = '/'`. Wire format and window navigation should not share a control-flow path.

**Why it matters here.** Two costs.

1. **Testability.** The reconnect logic cannot be unit-tested without mocking `window.location.href`, `fetch`, AND the entire NDJSON stream. The seam is too deep. After lifting to `useReconnectPolicy()` with a `triggerReconnect()` action, the seam is one function: the test fakes `fetch`, asserts the storage flag is set, and asserts the navigation effect would fire (or stubs `window.location` for the assertion). The cost of mocking goes from three concerns to one.

2. **Cognitive load on the next contributor.** A reader who opens `case 'error':` expects to see error-message presentation. They don't expect to see a session-state machine, a fetch call, and a window reload. The principle of least surprise (next section) bites here too — but the cleanest fix is at this layer: separate the concerns, and the surprise stays in one named hook where the comment can document it precisely.

**Is it worth fixing?** Yes. The fix is `useReconnectPolicy()` returning `{ reconnecting, triggerReconnect }`. The NDJSON event handler becomes: `if (AUTH_RE.test(msg)) { reconnect.triggerReconnect(); return; }` — three lines, one concern. The session-state machine, the fetch, and the navigation all move inside the hook. The hook has one job; the event handler has one job; the JSX reads `reconnect.reconnecting` to render the "session expired — reconnecting…" line.

**Which techniques would address it.** Extract Hook (`useReconnectPolicy`), Extract Variable (the AUTH_RE regex constant — already noted in Chapter 01), Move Function (the sessionStorage flag-read/write into the hook). Cross-references: `.aipe/study-software-design/02-shallow-module-page-component.md` (lists `useReconnectPolicy` as one of the three audit-named hooks), this notebook Chapter 01 (the lift order).

---

### Principle of Least Surprise — the reconnect's window.location.href = '/' (DEEP)

**Where it's violated.** Same site as above: `page.tsx:420-423`. Inside what reads like an event handler ("case 'error':"), the code calls `fetch('/api/mcp/reset', ...)` and then sets `window.location.href = '/'`. That's a hard window navigation triggered from inside a streaming event handler. The next reader does not expect this; the JSX above doesn't suggest it; the function name (`handle`) doesn't hint at it.

The codebase already has one well-documented deliberate surprise: `useInvestigation` deliberately doesn't cancel its fetch on cleanup (`lib/hooks/useInvestigation.ts:31-36`). That surprise is well-placed (inside a hook), well-commented (six lines naming the StrictMode bug and the rejected alternative), and read by anyone touching the hook. The feed page's reconnect-from-error-arm is the same shape of surprise — but it's not in a hook, the comment is shorter, and the reader has to scroll past 50 lines of other event arms to find it.

**Why it matters here.** The integration test from precondition B has to assert this branch works. Today, the test would have to mount the full page, fake a stream that emits `{ type: 'error', message: 'invalid_token' }`, intercept the window navigation, and assert the storage flag was set. That's a wide test seam. After the `useReconnectPolicy` lift, the test scope is "given a triggerReconnect() call, does the hook do the right session-state dance and navigation?" — a hook-level test, not a page-level test.

The deeper reason this lands as DEEP rather than BRIEF: this is the failure mode hardest to catch in code review. A reviewer reading the four-hook lift diff will see the move of code from page to hook; they will NOT immediately notice that the new hook's behavior is "navigate the window if triggered" unless the hook's name and comment make that loud. The discipline: name the hook `useReconnectPolicy` (not `useReconnect`); the word "policy" hints at "decides whether to navigate." Then put a comment on the hook above the function declaration naming exactly the same shape `useInvestigation.ts:31-36` does — what the surprise is, what triggers it, why the alternative was rejected. That's the principle correction: deliberate surprise is fine; deliberate surprise should be named and commented at the seam where it lives.

**Is it worth fixing?** Yes — and the lift IS the fix. The branch's surprise is currently mis-located; the lift relocates it to a hook where the surprise is the hook's job. Same code, different file, vastly clearer reading.

**Which techniques would address it.** Same Extract Hook lift as above. The principle correction is a side effect of the SoC correction. Cross-references: `.aipe/audits/cleanup-2026-06-14.md` (#21 — `useInvestigation` deliberately doesn't cancel: the canonical example of deliberate surprise done right), this notebook Chapter 01 (the lift), Chapter 02 (the integration-test seam that catches regressions in this branch).

---

### Locality of Behaviour — honored by default (BRIEF)

**Where it's honored.** The feed page's reconnect branch (despite being mis-located) is well-commented inline: the comment at L402-L406 explains the alpha server's revoke behavior, the rationale for the once-only guard, and the alternative considered (loop-on-fresh-token-also-revoked). The audit-cited canonical LoB example in this codebase is `lib/mcp/connect.ts:82-88` (the `minIntervalMs: 1100` comment); the feed page extends the same discipline to its own surprises, in the same shape.

**Take.** Two takes. (1) The page honors LoB more than the audits credit it for — the reconnect branch's comments name the failure mode, the alternative, and the constraint, all in one block above the code. That's load-bearing inline documentation. (2) LoB honored well INSIDE a switch arm doesn't excuse the location of the arm. The fix is the lift (Chapters 01-02); the comment moves with the code; the location becomes correct AND the comment stays load-bearing. **Don't lose the comment in the lift.** That's the discipline.

---

### Mentions

- **Tell-Don't-Ask — the mode read.** `page.tsx:131-133` reads `localStorage.getItem('bi:mode')` directly in a `useEffect`. After the `useModePersistence` lift, the page never touches `localStorage` — the hook tells the page what mode is. Minor improvement; same principle as the eval-substrate notebook's `res.usage` finding, smaller stakes.

---

## Chapter close

The principle this codebase honors by default on the feed page is Locality of Behaviour — the page's comments name the failure modes, alternatives, and constraints inline at the seams that matter. The principle this codebase strains against most is the Principle of Least Surprise at exactly one site: the reconnect-from-error-arm. And they are the **same comment**, viewed from two angles. The reconnect branch is well-commented (LoB win) AND badly placed (POLS loss). The fix is the same lift in both readings — `useReconnectPolicy()` — and the discipline during the lift is to preserve the comment as you move the code.

The other through-line, viewed at the principle layer: SRP and SoC violations on the feed page are not violations of taste — they're violations of the test seam. The page in its current shape cannot be unit-tested cleanly, and the integration test from precondition B has to mount the full file to assert anything. After the four-hook lift, each concern is unit-testable in isolation AND the integration test becomes a backstop, not a substitute. That's the principle-level argument for the four-hook lift: **principles aren't aesthetics; they're how you make the codebase legible to future maintenance.**

The book's final claim: every refactor in this notebook is downstream of two preconditions and one ordering decision. Precondition A (the NDJSON kernel module) changes the difficulty class. Precondition B (the integration test scaffold) makes the lifts safe. And the ordering — `useModePersistence` → `useBriefingStream` → `useReconnectPolicy` → `useDemoCapture` — keeps each lift small enough to bisect if a regression surfaces. Five seams; two preconditions; one order. That's the notebook in one sentence.
