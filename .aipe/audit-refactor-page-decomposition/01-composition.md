# Chapter 01 — Composition

Composition refactors are the smallest-grain moves on the catalog: Extract Function, Rename, Move Function, Extract Variable, Inline Function, Replace Conditional with Polymorphism. The techniques you reach for first when a file feels too dense and you're trying to figure out *why*. The feed page is full of these opportunities. The chapter's job is to rank which ones survive the preconditions intact, which ones can't safely land until the preconditions land, and which ones are the warm-up extractions that prove the contract is workable.

## Map of the territory

- **DEEP — Extract Hook (the four-hook lift, headlined by `useBriefingStream`).** The page's headline composition move. Three of the four hooks are gated on preconditions A and B; one (`useModePersistence`) is not.
- **DEEP — Extract Variable (the inline-style object soup).** ~40 unique `style={{}}` objects in the JSX, several near-duplicates between sibling components. Already a half-named pattern (`EvidencePanel.tsx:13-46` has the discipline).
- **BRIEF — Move Function (the three file-scope helpers).** `stashInsights`, `readBody`, `formatCustomerCount` are page-scoped today; each belongs in a `lib/` module.
- **BRIEF — Rename (`demoSuffix`, `captureAll`).** Two names that misdescribe what the thing actually is.
- **MENTION** — Extract Function on the AUTH_RE regex (`page.tsx:208`) — it's literal-shared with the regex inside the same file's NDJSON error handler (`page.tsx:407`). Two copies of the same pattern in one file.
- **MENTION** — Inline Function on `monitoringState` and `monitoringSub` (`page.tsx:44-64`). Two trivial pure functions used in exactly one JSX site each. Inline them OR move them to live next to `ProcessStepper` (Chapter 02 covers the move version).
- **NOT FOUND** — Replace Conditional with Polymorphism (the page's branches are mode toggles and status switches; nothing earns its own Strategy type).
- **NOT FOUND** — Extract Class (this is a React component, not a class component; the abstraction unit is the hook, not the class).

---

### Extract Hook — the four-hook lift, headlined by `useBriefingStream` (DEEP)

**Where it shows up.** Four concerns live in `app/page.tsx` that each map to a hook:

- The mode toggle + localStorage persistence (L122-L150) → `useModePersistence()` returns `[mode, setMode]`.
- The 218-LOC NDJSON-streaming effect (L258-L476) → `useBriefingStream(mode)` returns the nine-field briefing object.
- The reconnect-on-revoked-token branch buried inside the NDJSON `error` arm (L400-L435) → `useReconnectPolicy()` returns `{ reconnecting, triggerReconnect }`.
- The dev-only demo-capture orchestration (L156-L256) → `useDemoCapture(insights, workspace, trace)` returns `{ capturing, captureAll }`.

```
The feed page today — every concern at one altitude

  ┌─ app/page.tsx (817 LOC) ─────────────────────────────────────┐
  │                                                                │
  │  L95–L150   STATE — 15 useState slots, file scope              │
  │             ┌─────────────────────────────────────────────┐    │
  │             │ status, insights, workspace, errorMessage,  │    │
  │             │ activeQuery, demoSuffix, stepStatus,        │    │
  │             │ queryCount, traceItems, coverage,           │    │
  │             │ reconnecting, capturing, mode, ready,       │    │
  │             │ forcedDemo (const, but in the state graph)  │    │
  │             └─────────────────────────────────────────────┘    │
  │                                                                │
  │  L156–L256  DEMO CAPTURE (100 LOC)                              │
  │             postCapture · runInvestigation · captureAll        │
  │             → dev-only orchestration, gated by NODE_ENV         │
  │                                                                │
  │  L258–L476  BIG EFFECT (218 LOC)                                │
  │             fetch + NDJSON loop + 9-case handle() switch       │
  │             reconnect branch buried in `error` arm             │
  │             stepper-state + coverage + trace accumulation       │
  │                                                                │
  │  L478–L817  JSX (339 LOC)                                       │
  │             reads from all 15 state slots                       │
  └────────────────────────────────────────────────────────────────┘
```

The audit names three hooks. The book argues for four, because `useModePersistence` is the warm-up extraction the audit folded back into the page at ~10 LOC. The audit was right to call it small; the book argues small is exactly what you want as the first cut.

**Why it's like this.** Reconstructable: the page accreted concerns one at a time as features shipped. Mode toggle came in when demo mode landed. The reconnect branch came in when the alpha Bloomreach server started revoking tokens mid-investigation. The demo-capture flow came in when the snapshot file became the live demo's source of truth. Each concern was small when it shipped; each landed inside the existing big-effect because there was nowhere else to put it without inventing a new file. The eight-concerns shape is what you get when you keep saying yes to "just one more useState" with no friction to stop you. The IK-curriculum framing makes the failure mode obvious in retrospect — the same pattern that produces a 14-method God Class in OOP produces a 15-`useState` God Component in React.

**Take.** Lift the four hooks. Don't skip `useModePersistence` — at ~10 LOC it's not over-engineering; it's the contract test for the others. The order matters and it's not the order the audit listed.

Lift in this order:

1. **`useModePersistence`** — easiest. No async, no NDJSON, no reconnect, no test scaffold dependency. ~10 LOC moves out. The integration test from precondition B gets its first easy assertion: "mounting the page reads the persisted mode from localStorage." If the integration test can't catch a regression on this, the test scaffold itself is broken — and you want to know that BEFORE you lift the 218-LOC effect.

2. **`useBriefingStream(mode)`** — the headline lift. ~150 LOC moves out. Returns `{ status, insights, workspace, coverage, traceItems, queryCount, stepStatus, errorMessage, reconnecting }` — nine fields, which is wide but each one is genuinely the page's contract. Internally calls `parseNdjsonStream` from precondition A (Chapter 02). Gated on A.

3. **`useReconnectPolicy()`** — narrower than it looks. The reconnect branch reads three sessionStorage flags, calls `/api/mcp/reset`, and reloads the window. Lifting it into its own hook makes the side effect testable — today the test would have to mock `window.location.href`, which is awkward inside a 218-LOC effect; in its own hook the seam is one function. ~30 LOC moves out. The hook return shape is `{ reconnecting, triggerReconnect }` and the `useBriefingStream` calls `triggerReconnect()` when the regex matches.

4. **`useDemoCapture(insights, workspace, trace)`** — last because it's dev-only. ~100 LOC moves out. Gated behind `NODE_ENV !== 'production'`, behind `!isDemo`, behind `status === 'loaded'`. Lift it last so the more-impactful hooks land first. The internal orchestration (`postCapture`, `runInvestigation`, `captureAll`) maps onto a `lib/dev/capture.ts` module — Chapter 02 covers the structural piece.

After all four land, the page collapses to ~120 LOC of layout + composition. The four hook calls become four lines.

```
The feed page after the four lifts — depth where there was none

  export default function HomePage() {
    const [mode, setMode] = useModePersistence()                    // ~10 LOC hidden
    const briefing       = useBriefingStream(mode)                   // ~150 LOC hidden
    const reconnect      = useReconnectPolicy()                      // ~30 LOC hidden
    const capture        = useDemoCapture(                           // ~100 LOC hidden
      briefing.insights, briefing.workspace, briefing.traceItems
    )

    // …~80 LOC of JSX reading from { briefing, reconnect, capture, mode, setMode }
  }
```

**The tradeoff.** Cost of doing it: four new files in `lib/hooks/`, four new test files (the integration test from precondition B suffices for behaviour preservation; each hook also wants its own unit test for its return shape). Approximate ~250 LOC moved out of one file into four; the total LOC barely changes. Cost of not doing it: the next contributor who adds a ninth concern adds it to the same flat file scope, because that's the only seam there is. The audit is going to say "still live" for the third audit in a row. The page has already grown one useState slot since the 06-02 audit (14 → 15); the trajectory is linear.

The breakpoint where the calculus flips: if a fifth concern lands inside this file before the lifts (a query-box re-enable, a second insight category gated by a flag, anything), the merge surface of the cleanup grows by another logical region and the integration test from precondition B has to cover one more case. **Today is the cheapest the four-hook lift will ever be.** The audit's `fix-later` rating is correct — it's not urgent — but the trajectory means "later" gets more expensive every audit cycle.

**What I'd watch for.** Three failure modes the lift looks like it won't have but does.

1. **The `mode` and `ready` dependency entanglement.** The big effect's dependency array is `[mode, ready]`. `ready` flips from false to true exactly once after the persisted mode is resolved (L138). If you lift the mode hook and the briefing hook separately, the briefing hook needs to know about `ready` — either by exposing it from the mode hook, or by passing the resolved mode in and letting the briefing hook gate on `mode != null`. The second shape is cleaner. The first shape preserves the current control flow exactly. Pick the second shape; rename the contract.

2. **The reconnect branch's lifecycle dependency on the briefing stream.** Today the reconnect logic lives inside the stream's `error` event handler — when the stream emits an error matching the regex, the handler triggers the reconnect AND returns from the read loop. After the lift, the briefing hook has to expose either an `error` field that the reconnect hook watches via `useEffect`, OR a callback that the briefing hook calls when the regex matches. The callback shape is tighter (no useEffect chain), and it matches what `useInvestigation` already does internally with its own handle() switch. Pick the callback shape.

3. **The closure mirror discipline.** Today the big effect declares `let cancelled = false` and a `collected: Insight[] = []` array, mutated synchronously alongside the async setState calls. This is the same parallel-closure-mirror pattern `useInvestigation` uses (`useInvestigation.ts:65-67`). When `useBriefingStream` extracts, it needs to KEEP this pattern — the audit's `study-frontend-engineering/01-ndjson-stream-reader-hook.md` walks the reason in full. The temptation will be to "clean up the redundancy" between the React state and the closure mirror. Don't. The mirror is load-bearing; deleting it changes the semantics on the `done` arm of the stream. The integration test from precondition B should explicitly assert "the final insights count equals the streamed insight count" so this fails loudly if someone deletes the mirror.

**Verdict.** Worth doing in four lifts, in the order above, after both preconditions land. `useModePersistence` is the warm-up; `useBriefingStream` is the headline; `useReconnectPolicy` is the principle-violation correction (Chapter 05 walks why); `useDemoCapture` is the cleanup that turns a dev-only orchestration into a properly-bounded module. Don't lift more than one per session; the cleanup audit's hard rule about not batching cleanup refactors applies in full here.

---

### Extract Variable — the inline-style object soup (DEEP)

**Where it shows up.** The JSX (L478-L815) is dominated by inline `style={{...}}` objects. Spot count of the unique objects: ~40 distinct inline blocks across ~340 LOC of JSX. The pattern is consistent with sibling components (`InsightCard.tsx`, `CoverageGrid.tsx`, `EvidencePanel.tsx`) — and `EvidencePanel.tsx:13-46` already shows the discipline of pulling repeated style objects into named `CSSProperties` constants at the top of the file.

Half-cluster examples within the feed page alone:

- The mode-toggle button style (`page.tsx:531-541`) and the reconnect button style (`page.tsx:674-684`) share the same six lines of font/border/padding properties with two differences (color, background).
- The "lowercase mono small text" pattern repeats 7 times with the same three lines (`color: 'var(--text-tertiary)'`, `fontFamily: 'var(--font-mono), monospace'`, `fontSize: '0.72rem'`).
- The card-row container style (`page.tsx:617-619`, `L744-L753`) appears in two places with the same `display: 'grid'` / `gap: 24` pattern but on different parent elements.

**Why it's like this.** Reconstructable: Tailwind v4 landed mid-build; the project already had inline `style={{}}` with CSS variables as the working convention before the migration was complete. The cleanup audit (`#17 Inline-CSS vs Tailwind drift`) names this as `accept` because converting to Tailwind classes is its own decision (touches many files; needs a top-down style-system call). But within the feed page, Extract Variable is the smaller move that doesn't require the bigger decision.

**Take.** Pull the recurring style objects into named `CSSProperties` constants at file scope, the way `EvidencePanel.tsx:13-46` already does. ~15 named constants kills ~120 lines of inline JSX clutter without touching the className strategy. The Tailwind-vs-inline decision can come later; this is the "improve what's there" cleanup that doesn't take a side.

The reason this matters for the through-line: when you extract `useBriefingStream`, you're going to move state slots out of the page. The JSX stays. If the JSX is 340 LOC of inline styles, the diff of the page-collapses-to-120-LOC moment is harder to read than it needs to be. Pull the style objects to named constants BEFORE the hook lifts and you give the reviewer's eye a clean JSX baseline. Do it AFTER and you're mixing structural change (extraction) with cosmetic change (variable naming) in the same review.

**The tradeoff.** Cost: 15 named constants at the top of the file (~30 LOC), 40 inline style sites updated. Pure mechanical change. Cost of not: the JSX diff during the hook lifts is noisier. The audit names it `accept` because it's cosmetic; this notebook upgrades it to `worth doing as preparation for the hook lifts`. Same severity, different timing argument.

**What I'd watch for.** The trap of pulling style objects into constants is that you sometimes lose the locality of the dependency between a style and the prop it reads. Example: the mode-toggle button at L527-L544 has `background: mode === m ? 'var(--accent-teal)' : 'transparent'` — that's a per-render-computed style, not a constant. Don't try to extract it into a `modeToggleButtonStyle` constant; the style depends on a render-scoped variable. Extract a function: `modeToggleStyleFor(active: boolean): CSSProperties`. That's the right shape for any style that varies by prop or state. Static styles → constants; varying styles → functions returning constants. The boundary is one rule and it's easy to miss.

**Verdict.** Worth doing — and worth doing as preparation for the hook lifts, not as a separate cleanup later. Ship in its own session, ahead of `useModePersistence`. Behaviour-preserving in the strictest sense (zero React semantics change, zero CSS output change).

---

### Move Function — the three file-scope helpers (BRIEF)

**Where it shows up.** Three pure functions live at file scope inside `app/page.tsx`:

- `stashInsights(list: Insight[]): void` at L70-L77 — writes each insight to `sessionStorage` under `bi:insight:${id}`. Used at L315 (snapshot path) and L392 (stream `done` path).
- `readBody(res: Response): Promise<Record<string, unknown>>` at L81-L89 — defensively parses a Response body as JSON-or-text-under-`__raw`. Used at L284, L294, L310.
- `formatCustomerCount(n: number): string` at L91-L93 — one-line `n.toLocaleString()` wrapper used once at L511.

**Take.** All three move out. `stashInsights` belongs in `lib/state/stash.ts` (paired with `useInvestigation.ts`'s `stashKey` and `diagHandoffKey` helpers — they're the same family of session-key helpers). `readBody` belongs in `lib/http/body.ts` (it's a defensive HTTP utility, not a page concern). `formatCustomerCount` is a single-call one-liner — either inline it at the call site (the simpler move) or move it to a `lib/format/` module if the format-helper family is going to grow. Verdict: move `stashInsights` and `readBody`; inline `formatCustomerCount`. The first two are utilities the lib/ layer should own; the third is over-extracted for what it does.

---

### Rename — `demoSuffix`, `captureAll` (BRIEF)

**Where it shows up.** Two names that describe what the value/function looks like rather than what it represents.

- `demoSuffix: string` (L102, L160, L263, L597). The value is `'&demo=cached'` or `''`. It's a query-string fragment, not a "suffix" — that's a string-shape description, not a semantic one. Rename: `demoQueryParam`.
- `captureAll(): Promise<void>` (L206). The function does three things: capture the briefing, run each investigation, re-capture to bundle. "captureAll" reads like "capture every item in a list," but the items aren't insights — they're capture *steps*. Rename: `runFullDemoCapture` or `captureBriefingAndInvestigations`.

**Take.** Rename both. Lowest-risk refactor in the chapter; one IDE rename each; verdict is "worth doing while you're already in the file for the Extract Variable pass." No standalone session needed; fold into the JSX-cleanup commit.

---

### Mentions

- **Extract Function on the AUTH_RE regex** (`page.tsx:208`, `page.tsx:407`). Same regex literal `/invalid_token|unauthor|forbidden|401|session expired|reconnect/i` written twice in one file. Pull to `const AUTH_FAIL_RE = /.../` at file scope, then to `lib/mcp/auth.ts` once the `useReconnectPolicy` hook lifts (the hook is the natural owner). Two-line refactor; do it or don't, but if you do it, do it before the hook lift so the hook inherits the named constant.

- **Inline (or Move) `monitoringState` and `monitoringSub`** (`page.tsx:44-64`). Two trivial pure functions used in exactly one JSX site each (L562-L568). Either inline both (they're 4 and 8 lines respectively) or move them next to `ProcessStepper.tsx` where they belong. Move is the better shape — Chapter 02 covers it under Move Function.

---

## Chapter close

The pattern that emerges from this chapter: the feed page is composition-rich, which is the opposite of what the audit's "shallow module" framing suggests at first glance. The page isn't shallow because it lacks refactoring opportunities — it's shallow because it has too many of them held at one altitude. Extract Variable applies in ~40 places. Extract Function applies in three. Extract Hook applies in four. Move Function applies in five. Rename applies in two. That's not a file that needs one big refactor; that's a file that needs five small, ordered, behaviour-preserving lifts with a contract test catching each one.

The discipline the chapter argues for: **don't do the four-hook lift before the Extract Variable pass.** The styles cleanup makes the JSX legible; the styles cleanup AFTER the hooks lift is half-mixed with the bigger structural change and the reviewer can't tell which line moved for which reason. Cleanup-before-extraction is the order. Then preconditions A and B. Then the four hooks, one per session, smallest first.

The other through-line: this chapter is the warm-up for Chapter 02. Every composition opinion above is downstream of the structural seam in Chapter 02 — the NDJSON kernel and the `runInvestigation(deps)` extraction. Lift those, and the four hooks become a different shape of problem. Skip those, and Extract Hook becomes Extract Hook + Refactor NDJSON Parser + Build Integration Test Scaffold In Flight, which is the failure mode the cleanup audit's hard rules name out loud.
