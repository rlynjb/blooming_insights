# Shallow module — `app/page.tsx` (the resolved worked example)

*industry name: shallow module / classitis / god component · type: Language-agnostic (APOSD red flag)*

> **Resolved.** This is a worked negative-then-positive example. The historical shape (`app/page.tsx` at 817 LOC carrying 8 concerns at one altitude) violated APOSD's deep-module rule. The current shape (461 LOC + 3 single-purpose hooks) honors it. The file is kept in the guide because the lesson — what a shallow module looks like, what it costs, what fixes it — is best taught from a real codebase case rather than an invented one.

---

## Zoom out, then zoom in

**Zoom out — where this pattern lives.** The UI layer's entry point.

```
  Zoom out — where the feed page sits in the system

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  app/page.tsx  ★ THIS COMPONENT ★                         │  ← you are here
  │   uses → useBriefingStream (the 9-case NDJSON dispatcher) │
  │   uses → useDemoCapture    (dev capture flow)             │
  │   uses → useReconnectPolicy (revoked-token reconnect)     │
  │  components/feed/InsightCard, CoverageGrid, …             │
  └───────────────────────────┬───────────────────────────────┘
                              │  fetch /api/briefing (NDJSON)
                              │  (also POST /api/mcp/capture-demo
                              │   from the dev capture flow)
  ┌─ Route layer ─────────────▼───────────────────────────────┐
  │  app/api/briefing/route.ts                                │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** A *shallow module* is the opposite of a deep one: an interface nearly as complex as the body. APOSD's specific cases include "classitis" (one tiny class per concern) and "god component" (one class doing many things at one altitude). `app/page.tsx` was historically the second variant — a 817-LOC React component owning 8 unrelated concerns (mode persistence, briefing fetch, NDJSON dispatch, demo capture, reconnect policy, query state, layout, error UI) at the same level. The fix wasn't classitis (chopping into many tiny components); it was extraction by *concern boundary* into three single-purpose hooks. The component shrank to 461 LOC; each hook is one screen and tests independently.

---

## Structure pass

**Layers.** Two perspectives — before vs after.

```
  BEFORE (shallow):                AFTER (deep enough):
  ─────────────────                ──────────────────────
  app/page.tsx (817 LOC)           app/page.tsx (461 LOC)
   15 useState                      ── orchestrates ──
   2 useEffect                      ↓        ↓        ↓
   8 concerns at ONE altitude:     useBriefingStream  (313)
     - mode persistence            useDemoCapture     (146)
     - briefing fetch              useReconnectPolicy (123)
     - NDJSON parse loop (25 LOC)
     - 9-case event dispatcher    each hook = ONE concern,
     - reconnect policy           one screen, one test surface
     - demo capture flow
     - query state
     - layout + error UI
```

**Axis — trace one question.** *Where would I make a change to "how the briefing stream consumes events"?*

```
  shape              edit lands where?
  ─────────────      ──────────────────────────────────────────
  BEFORE             inside the 200+ LOC useEffect in page.tsx
                     (somewhere between :242 and :432); touching
                     the same useEffect that also reads
                     localStorage, fires the reconnect, and
                     manages 15 pieces of state
  AFTER              lib/hooks/useBriefingStream.ts (313 LOC,
                     one screen of NDJSON dispatch — that's the
                     whole file)
```

The axis-answer flips at the seam where each concern got its own hook. Before, every change went through one giant function. After, "where do I change X" has a one-file answer for every X.

**Seams.** Before: no internal seams — everything in one function body. After: three horizontal seams (the page component ↔ each hook). The 3-hook split was the right grain because each hook has a clearly-different lifecycle: the briefing stream re-runs when mode changes; the capture flow runs once on button click; the reconnect policy fires on auth errors. Same code in one function would have to interleave three lifecycles — that interleaving was the shallow part.

---

## How it works

### Move 1 — the mental model

A shallow module is like a class with one public method that takes 12 arguments and dispatches to 8 internal branches — the interface size approaches the body size, so the wrapper isn't really hiding anything. APOSD's image: an interface where you have to read the implementation to know how to call it correctly. The page component was the same idea at a different scale — a React component whose "interface" (props + state shape + the dispatch behavior the caller has to understand) was as wide as its body, because every concern leaked into every other.

```
  Shallow module — interface nearly as wide as body

         interface ───────────────────────────►
         ┌───────────────────────────────────┐
         │  HomePage()                       │
         │   useState ×15                    │   the "interface" of
         │   useEffect ×2 (200+ LOC body)    │   this component is its
         │   handles 9 NDJSON event cases    │   ENTIRE BODY — there's
         │   reads localStorage              │   no hiding happening
         │   fires reset+reload              │
         │   runs capture flow               │
         └──────────────────┬────────────────┘
                            │
                            ▼
                       body ≈ interface

  Deep enough (after the lift):

         interface ────►   body (hidden)
         ┌──────────────┐  ┌─────────────────────────────────┐
         │ HomePage()   │  │  useBriefingStream(mode, ready) │
         │  reads state │→ │   (313 LOC, 9-case dispatch +   │
         │  from hooks  │  │    cancellation + auth bail)    │
         │  renders     │  └─────────────────────────────────┘
         │              │  ┌─────────────────────────────────┐
         │              │→ │  useDemoCapture(...)            │
         │              │  │   (146 LOC, capture flow)       │
         │              │  └─────────────────────────────────┘
         │              │  ┌─────────────────────────────────┐
         │              │→ │  useReconnectPolicy()           │
         │              │  │   (123 LOC, reset+reload guard) │
         │              │  └─────────────────────────────────┘
         └──────────────┘
                            interface ≪ body now
```

### Move 2 — the step-by-step walkthrough

#### Move 2a — diagnosing the shallow shape (the historical state)

Three diagnostic signals fired at once on the original page.tsx:

  - **Concern count at one altitude.** Reading the file top-to-bottom, you'd encounter: mode persistence → demo/live toggle → briefing fetch → NDJSON parse loop → 9-case event dispatcher → reconnect policy → demo capture flow → query state → layout → error UI. Ten distinct things, all at the same nesting level. None pulled out into a sub-shape.
  - **State density.** 15 `useState` calls in one component is the smoke. Each one is a piece of mutable state the component owns. 15 of them means the component carries 15 different concerns' state. The number itself isn't the bug — but combined with the second signal, it's a strong tell.
  - **Effect length.** Two `useEffect` blocks; one (`:242-432`) was ~190 LOC and did fetch + 9-case dispatch + reconnect bail + cleanup. A useEffect over ~100 LOC is a "this should probably be a hook" indicator.

The APOSD-canonical question: *"If I want to change ONE concern, do I have to touch a function that also handles unrelated concerns?"* Before the lift, "change the NDJSON event handling" touched the same useEffect as "handle the reconnect on revoked token" — they were interleaved. That's the shallow-module cost.

#### Move 2b — the fix: three hook extractions by concern

The 5-seam refactor reframed the lift as three independent extractions, each with its own concern boundary and verification harness:

```
  Extraction 1 — useBriefingStream(mode, ready)
  ─────────────────────────────────────────────
  what moved:    the briefing fetch + NDJSON parse loop + 9-case
                 dispatcher (~218 LOC out of page.tsx)
  where it went: lib/hooks/useBriefingStream.ts (313 LOC)
  return shape:  9-field object (status, insights, workspace,
                 coverage, traceItems, errorMessage, stepStatus,
                 queryCount, demoSuffix)
  verification:  test/api/briefing.integration.test.ts pins the
                 NDJSON event contract this hook consumes (7 tests)
  callbacks:     onAuthError, onStreamComplete — let the page
                 compose with useReconnectPolicy without the hook
                 importing it directly

  Extraction 2 — useReconnectPolicy()
  ────────────────────────────────────
  what moved:    auth-shape regex + session-flag guard +
                 reset+reload action (~36 LOC + the duplicated
                 inline error button at :606-645)
  where it went: lib/hooks/useReconnectPolicy.ts (123 LOC)
  return shape:  3 fields (reconnecting, handle, reconnect,
                 clearFlag)
  notable:       deliberately keeps TWO regex variants verbatim
                 (LONG for auto, SHORT for the manual button) — a
                 latent bug worth flagging is documented in the
                 hook's header comment rather than unified blindly

  Extraction 3 — useDemoCapture(insights, workspace, traceItems)
  ──────────────────────────────────────────────────────────────
  what moved:    the dev-only capture flow (3 phases: capture
                 briefing → run each investigation → bundle the
                 result, ~84 LOC out of page.tsx)
  where it went: lib/hooks/useDemoCapture.ts (146 LOC)
  return shape:  2 fields (capturing: { active, msg }, captureAll)
  verification:  test/api/agent.integration.test.ts pins the
                 /api/agent NDJSON contract runInvestigation drains
```

The fourth potential extraction (`useModePersistence` — the ~10 LOC localStorage read at `:130-140`) was deliberately NOT lifted. At 10 LOC it's almost too small to be its own hook; the audit's call was to leave it inline. This is a deliberate "small enough to stay" decision, not an oversight.

#### Move 2c — the post-lift page

`app/page.tsx`, 461 LOC. What it does NOW:

  - Owns 5 useState calls (down from 15) — only state genuinely local to the page (`activeQuery`, `mode`, `ready`).
  - Composes three hooks (`useBriefingStream`, `useDemoCapture`, `useReconnectPolicy`) with explicit callback wiring.
  - Renders the layout: header, two-column body, fixed query box, error UI, capture button.

```ts
  // app/page.tsx (simplified shape, post-lift)
  export default function HomePage() {
    const [activeQuery, setActiveQuery] = useState<string | null>(null);
    const reconnectPolicy = useReconnectPolicy();
    const [mode, setMode] = useState<BriefingMode>('demo');
    const [ready, setReady] = useState(false);

    // resolve persisted mode → useEffect at :68-84 (the small hold-out)
    useEffect(() => { /* read localStorage; setMode + setReady */ }, [forcedDemo]);

    const { status, insights, workspace, coverage, traceItems, ... } =
      useBriefingStream(mode, ready, {
        onAuthError: reconnectPolicy.handle,
        onStreamComplete: reconnectPolicy.clearFlag,
      });

    const { capturing, captureAll } = useDemoCapture(insights, workspace, traceItems);

    // ... render
  }
```

The page now reads top-to-bottom as orchestration: read state, compose hooks, render. The 9-case NDJSON dispatcher is INSIDE `useBriefingStream` where it belongs. The reset+reload dance is INSIDE `useReconnectPolicy`. The 3-phase capture is INSIDE `useDemoCapture`. None of those concerns is interleaved with another.

### Move 2 variant — the load-bearing skeleton

The fix's kernel: **(1) one concern per hook + (2) explicit composition via callbacks + (3) a verification harness already in place before the lift.**

What breaks when each part is missing:

  - **One hook with multiple concerns** — you've moved the shallow module from `page.tsx` to a hook file. Same problem; new address. The hook count is irrelevant; the *concerns per hook* is what matters.
  - **Implicit composition (the hook calls another hook directly instead of accepting callbacks)** — couples the hooks to each other, makes them harder to test independently, recreates the spaghetti at a different layer.
  - **No verification harness before the lift** — refactoring without tests is "I'm pretty sure I didn't break anything." With tests (the briefing + agent integration suites), you can MOVE the implementation knowing the contract is pinned. This was the precondition the prior audit named explicitly; the lift was deferred until it landed.

### Move 2.5 — current state vs prior state (the comparison)

```
  Phase A — historical (BEFORE PR #1–#4)        Phase B — current (AFTER PR #1–#4)
  ──────────────────────────────────────        ──────────────────────────────────
  app/page.tsx                                   app/page.tsx                461 LOC
    817 LOC                                        + lib/hooks/useBriefingStream  313
    15 useState                                    + lib/hooks/useDemoCapture     146
    2 useEffect (one ≈ 190 LOC)                    + lib/hooks/useReconnectPolicy 123
    8 concerns at one altitude                                                 ────
    inline 25-LOC NDJSON parse loop              total 1043 LOC, but each file is
    duplicate auth-error button at two           ONE concern and fits on one screen
    locations                                    every concern has a single home
                                                 every hook has its own test surface
```

The total line count rose (817 → 1043 across 4 files) — that's expected. Lifting a god component adds the overhead of hook signatures, return-type shapes, and `'use client'` directives. The win isn't fewer lines; it's *fewer concerns per file*. The largest file dropped from 817 to 461; the next-largest is 313. No file holds more than one concern.

### Move 3 — the principle

> **A shallow module isn't fixed by chopping into smaller pieces — it's fixed by chopping along concern boundaries.**
>
> "Classitis" (one tiny class per micro-task) makes the problem worse: now you have 20 shallow modules instead of one. The right move identifies the concerns that *don't share state, don't share lifecycle, and don't need to know about each other* — those are the natural seams. Split there. Anything else recreates the shallowness at a different scale.
>
> The other half of the lesson: the verification harness comes BEFORE the lift. Without it, the refactor is faith-based. With it, the contract is pinned and the implementation can move.

---

## Primary diagram

```
  The fix — what 8-concerns-at-one-altitude became

  ┌─ BEFORE: shallow ─────────────────────────────────────────────────┐
  │                                                                   │
  │  app/page.tsx  (817 LOC, 15 useState, 2 useEffect)                │
  │  ┌─────────────────────────────────────────────────────────────┐ │
  │  │ everything at one altitude:                                 │ │
  │  │   mode persistence    briefing fetch    NDJSON parse loop   │ │
  │  │   9-case dispatcher   reconnect policy  demo capture        │ │
  │  │   query state         layout            error UI            │ │
  │  │ ──────────────────────────────────────────────────────────  │ │
  │  │ change ANY concern → touch a function that also handles     │ │
  │  │ unrelated concerns                                          │ │
  │  └─────────────────────────────────────────────────────────────┘ │
  └───────────────────────────────────────────────────────────────────┘
                                  │
                                  │  preconditions cleared first:
                                  │    • NDJSON kernel lifted    (commit 0f06eff)
                                  │    • integration tests landed (PR #4)
                                  ▼
  ┌─ AFTER: 3 hooks + orchestration page ────────────────────────────┐
  │                                                                  │
  │  app/page.tsx (461 LOC) — orchestration only                     │
  │   const recPolicy = useReconnectPolicy();                        │
  │   const { ... } = useBriefingStream(mode, ready, {               │
  │     onAuthError: recPolicy.handle,                               │
  │     onStreamComplete: recPolicy.clearFlag,                       │
  │   });                                                            │
  │   const { capturing, captureAll } =                              │
  │     useDemoCapture(insights, workspace, traceItems);             │
  │   ── render ──                                                   │
  │                                                                  │
  │  ┌─ lib/hooks/useBriefingStream.ts (313 LOC) ────────────────┐  │
  │  │ owns: briefing fetch + 9-case NDJSON dispatcher +         │  │
  │  │       cancellation + auth-bail callback                   │  │
  │  │ verification: test/api/briefing.integration.test.ts       │  │
  │  └───────────────────────────────────────────────────────────┘  │
  │                                                                  │
  │  ┌─ lib/hooks/useDemoCapture.ts (146 LOC) ───────────────────┐  │
  │  │ owns: 3-phase dev capture (briefing → investigations →     │  │
  │  │       bundle) + auth bail on revoked token mid-loop       │  │
  │  │ verification: test/api/agent.integration.test.ts          │  │
  │  └───────────────────────────────────────────────────────────┘  │
  │                                                                  │
  │  ┌─ lib/hooks/useReconnectPolicy.ts (123 LOC) ───────────────┐  │
  │  │ owns: auth-shape regexes + session-flag guard +           │  │
  │  │       reset+reload action                                 │  │
  │  │ verification: hook-local test (no upstream contract)      │  │
  │  └───────────────────────────────────────────────────────────┘  │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘

  each hook = one concern, one screen, one test surface
  page = composition + render, no business logic interleaving
```

---

## Elaborate

**Where this primitive comes from.** "Classitis" is APOSD's term for the related anti-pattern (Ch. 4). React-world calls the component variant "god component"; Vue calls it "page component anti-pattern." Same shape, same fix: extract by concern, not by size.

**What changed in this codebase.** The lift landed across PRs #1–#4 (June 2026), gated by two preconditions: lifting the kernel (`readNdjson`, commit `0f06eff`) and adding integration tests for the route NDJSON contracts (PR #4). With the preconditions cleared, the three hook extractions executed in sequence (Frontend-Behaviour template — state/effects/events lifts, not module restructures). The shallow-module case has been verified-resolved since 2026-06-15.

**The decision NOT to extract `useModePersistence`** (the ~10 LOC localStorage read for the demo/live toggle) is a real APOSD judgment call. At 10 LOC, lifting it would emit a 4th hook for what's essentially a one-liner — the wrapper would be as complex as the body, which is shallow-module's exact failure mode applied to a hook. The audit called it: leave it inline as documented-without-stub. Future executor can fold it into one of the three existing hooks if they touch the page; otherwise it stays.

**What's adjacent in this codebase.**

  - `01-deep-module-data-source.md` — the positive example (deep by construction).
  - `02-information-hiding-aptkit-bridge.md` — the positive example at a different altitude.
  - `03-pulled-complexity-down-readndjson.md` — precondition A for this lift.
  - `.aipe/audit-refactor-page-decomposition/00-overview.md` — the 5-seam reframing notebook that planned the lift.
  - `audit.md` Lens 2 (deep-vs-shallow-modules).

**What to read next.** `.aipe/read-aposd/part-2/03-deep-modules.md` — the book's chapter on deep modules names classitis as the inverse failure mode; the fix is what this page demonstrates.

---

## Interview defense

**Q1: How do you spot a shallow module in a real codebase?**

Three signals together. *Concern count at one altitude* — when you read the file top-to-bottom you can list 6+ unrelated responsibilities (mode persistence, fetch, dispatch, reconnect, capture, layout). *Density* — 15 `useState` calls in one React component, or a class with 20 public methods, or a function taking 12 arguments. *Effect length* — a single `useEffect` over 100+ LOC, or a function body over a few hundred lines. Any one of these is a smoke; all three at once is the fire. The APOSD canonical test: "if I want to change one concern, do I touch a function that also handles unrelated concerns?" If yes, it's shallow.

```
  the three signals — fire when all three together
  ───────────────────────────────────────────────
  concern count       6+ unrelated responsibilities
  state density       15 useState (or equivalent)
  effect length       useEffect > 100 LOC
```

Anchor: the historical `app/page.tsx` at 817 LOC.

**Q2: What's the load-bearing detail people miss when they try to fix a shallow module?**

That chopping by SIZE makes it worse. APOSD calls this classitis — splitting one shallow module into many tiny ones. You now have 20 wrappers each as wide as their bodies; the shallow problem has propagated. The fix is chopping by CONCERN: identify the seams where state, lifecycle, and knowledge naturally separate, and split there. For the page component, the natural seams were "the briefing stream (re-runs on mode change)," "the capture flow (runs on button click)," and "the reconnect policy (fires on auth error)" — three different lifecycles, so three hooks. The fourth potential extraction (mode persistence at 10 LOC) was deliberately NOT lifted because the wrapper would be as wide as the body — classitis applied to hooks.

```
  the wrong fix         the right fix
  ─────────────         ──────────────
  20 tiny components    3 hooks, one per natural concern
  each as shallow as    (lifecycle / state / failure boundary)
  the original          + leave 10-LOC concerns INLINE
```

Anchor: `lib/hooks/useBriefingStream.ts`, `lib/hooks/useDemoCapture.ts`, `lib/hooks/useReconnectPolicy.ts`.

**Q3: Why did you put the integration tests BEFORE the lift, not after?**

Because the lift moves code across a contract boundary. The route emits NDJSON events; the hook consumes them. The lift doesn't change either side's behavior — it just relocates where consumption happens. Without tests pinning the contract, "I didn't break anything" is faith. With the tests (the 7 in `test/api/briefing.integration.test.ts` and 9 in `test/api/agent.integration.test.ts`), the contract is pinned in code — any drift fails CI. The hook extraction then becomes a mechanical move with a verifiable outcome. The prior audit deferred the lift specifically because the tests weren't in place; once PR #4 landed them, the lift was ready to execute.

Anchor: the prior audit `.aipe/audits/design-2026-06-14.md` "deferred until precondition B" language; PR #4's test list.

**Q4: The post-lift codebase has MORE lines (817 → 1043 across 4 files). How is that a win?**

Total line count isn't the metric — *concerns per file* is. Before: one 817-LOC file with 8 interleaved concerns. After: four files, each with ONE concern, each fits on one screen. The 226-LOC overhead pays for hook signatures, return-type shapes, callback wiring, and the explicit composition the page now does. What you BUY is: changes are localized, tests are local to each hook, the briefing dispatch is no longer interleaved with the reconnect policy, the capture flow no longer interleaves with the query state. The page reads as orchestration; each hook reads as a single mechanism. The wider the gap between concerns per file (1 vs 8), the easier the codebase is to change. **Concerns is the metric; lines is the receipt.**

```
  total LOC ↑   from 817 to 1043
  concerns per file ↓↓   from 8 to 1
  test surface per concern ↑   from 0 to 1
  the trade is the change-localization win
```

Anchor: line counts in the Primary diagram above.

---

## See also

  → `01-deep-module-data-source.md` — the positive example at the data layer.
  → `02-information-hiding-aptkit-bridge.md` — the positive example at the agent layer.
  → `03-pulled-complexity-down-readndjson.md` — precondition A for this lift.
  → `audit.md` Lens 1 (complexity), Lens 2 (deep-vs-shallow).
  → `.aipe/audit-refactor-page-decomposition/00-overview.md` — the planning notebook.
  → `.aipe/audits/design-2026-06-15.md` — the action-shaped audit that triggered the lift.
  → `.aipe/read-aposd/part-2/03-deep-modules.md` — the book chapter on deep modules + classitis.
