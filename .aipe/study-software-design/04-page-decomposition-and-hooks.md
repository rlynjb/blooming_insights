# 04 — page decomposition (the resolved shallow module)

## Subtitle

Extract function · custom hooks · resolved shallow module — *Language-agnostic (React idiom)*.

## Zoom out — where the page sits

`app/page.tsx` is the feed entry point — the page the user lands on. It used to be ~817 LOC and carried inline: the briefing fetch loop, the demo capture orchestration, and the revoked-token reconnect dance. Today it's 461 LOC and the three concerns live behind three custom hooks. This file walks the decomposition.

```
  Zoom out — page.tsx and the three hooks it composes

  ┌─ Browser (the user's tab) ────────────────────────────────────────┐
  │                                                                   │
  │  ┌─ app/page.tsx (★ THIS CONCEPT ★) ───────────────────────────┐ │
  │  │  HomePage — the React component                              │ │ ← we are here
  │  │   · header + mode toggle + stepper                           │ │
  │  │   · loads, error, empty, loaded UI branches                  │ │
  │  │   · status sidebar                                           │ │
  │  │   · composes three custom hooks                              │ │
  │  └────────────────┬─────────────────────────────────────────────┘ │
  │                   │                                                │
  │       ┌───────────┼─────────────────────┐                         │
  │       ▼           ▼                     ▼                         │
  │  ┌─────────┐ ┌──────────────┐ ┌─────────────────┐                │
  │  │useBrief-│ │useDemoCapture│ │useReconnect-    │                │
  │  │ingStream│ │              │ │Policy           │                │
  │  │313 LOC  │ │146 LOC       │ │123 LOC          │                │
  │  └─────────┘ └──────────────┘ └─────────────────┘                │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

## Zoom in — what it is

When a single component grows past the point you can hold its full state shape and effect graph in your head, the move is **extract function** — pull each load-bearing concern into its own named module. In React the named module is usually a **custom hook**: a function that owns its own state, returns a value, and the component composes it.

The three concerns the original `HomePage` carried — fetching+parsing the briefing stream, capturing a demo snapshot, recovering from a revoked OAuth token — are *independent* (each has its own state, its own effect graph, its own failure mode) and *high-cohesion* internally (each one's pieces only make sense together). That's the textbook condition for extraction.

The role-vocabulary for this pattern:

```
  component       the React function that owns the JSX
                  → HomePage in app/page.tsx
  custom hook     a reusable stateful function the component composes
                  → useBriefingStream, useDemoCapture, useReconnectPolicy
  concern         one cohesive responsibility extracted from the component
                  → "fetch + parse the briefing stream" is one concern
  composition     wiring multiple hooks together at the call site
                  → page.tsx composes the three via callbacks
                    (onAuthError → reconnectPolicy.handle)
```

## Structure pass — layers · axes · seams

Two layers: the **component** (the JSX-producing function that the React renderer calls) and the **hooks** (stateful functions the component composes). Trace one axis down the stack: **who owns the state?**

```
  Trace "who owns each piece of state?" across the layers

  ┌─ HomePage (the component) ────────────────────────┐
  │  owns: activeQuery (local UI state)               │
  │        mode + ready (mode toggle)                 │
  │  reads: the values returned by the three hooks    │
  └───────────────────────┬───────────────────────────┘
                          │  composes hooks
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
  ┌──────────────┐ ┌──────────────┐ ┌─────────────────┐
  │useBriefing   │ │useDemoCapture│ │useReconnectPolicy│
  │Stream         │ │              │ │                 │
  │ owns:         │ │ owns:        │ │ owns:           │
  │   status     │ │   capturing  │ │   reconnecting  │
  │   insights   │ │              │ │                 │
  │   trace      │ │              │ │                 │
  │   coverage   │ │              │ │                 │
  │   (9 fields) │ │ (1 field)    │ │ (1 field +      │
  │              │ │              │ │  sessionStorage │
  │              │ │              │ │  flag)          │
  └──────────────┘ └──────────────┘ └─────────────────┘
```

The seam between the component and each hook is the function signature. What flips across it: above the seam, *one return value*; below the seam, *the entire state-and-effect graph for that concern*. The component never `useState`s `status` or `insights`; the hook does. The component never `useEffect`s a fetch; the hook does.

## How it works

### Move 1 — the mental model

A custom hook is just a function that *happens* to call other hooks (`useState`, `useEffect`, `useRef`, etc.) and follows the same rules as any other hook (called unconditionally, at the top of the function). The React convention is the `use` prefix — calling it tells you it's hook-shaped and obeys the rules of hooks.

The literal shape of this decomposition:

```
  The decomposition — one component, three hooks

       ┌──────────────────────────────────────────────────────────────┐
       │  HomePage (app/page.tsx, 461 LOC)                            │
       │                                                              │
       │   const reconnectPolicy = useReconnectPolicy();              │
       │   const briefing = useBriefingStream(mode, ready, {           │
       │     onAuthError: reconnectPolicy.handle,                     │
       │     onStreamComplete: reconnectPolicy.clearFlag,             │
       │   });                                                         │
       │   const capture = useDemoCapture(                            │
       │     briefing.insights, briefing.workspace, briefing.trace    │
       │   );                                                          │
       │                                                              │
       │   return ( <JSX> ... </JSX> )                                │
       └──────────────────────────────────────────────────────────────┘

       ↑ the component reads three return values and renders JSX.
         each hook owns its own state and effects.
         the wiring between hooks is just callback parameters.
```

Notice the composition: the *component* doesn't know how to handle a 401 from the briefing stream. `useBriefingStream` doesn't either — it just calls `onAuthError(msg)`. `useReconnectPolicy.handle` is the one that knows what to do. **The component is the choreographer; the hooks are the dancers.**

### Move 2 — the step-by-step walkthrough

#### Part 1 — the briefing stream hook (the biggest extraction)

`useBriefingStream` (`lib/hooks/useBriefingStream.ts`, 313 LOC) is the biggest of the three. Its job: own the GET `/api/briefing` fetch, the NDJSON parse loop, the 9-case event dispatcher, and the 9 state fields the UI reads. It returns one stable 9-field object.

```ts
// lib/hooks/useBriefingStream.ts:83-93 — the return shape
export interface UseBriefingStreamResult {
  status: FeedStatus;                                  // 'loading' | 'error' | 'empty' | 'loaded'
  insights: Insight[];
  workspace: BriefingResponse['workspace'];
  coverage: CoverageReport;
  traceItems: TraceItem[];
  errorMessage: string;
  stepStatus: string;
  queryCount: number;
  demoSuffix: string;
}
```

And the composition site:

```tsx
// app/page.tsx:100-113 — the call site is 14 lines
const {
  status, insights, workspace, coverage, traceItems,
  errorMessage, stepStatus, queryCount, demoSuffix,
} = useBriefingStream(mode, ready, {
  onAuthError: reconnectPolicy.handle,
  onStreamComplete: reconnectPolicy.clearFlag,
});
```

What's hidden inside the hook:

  → A `useEffect([mode, ready])` that resets state, builds the URL, fetches, and either handles the JSON demo body or starts the NDJSON read loop.
  → A `useRef<boolean>` cancel latch reset on every effect run, polled by `readNdjson`'s `cancelOn`, flipped true by the cleanup function.
  → A `useRef<UseBriefingStreamCallbacks>` that holds the latest callbacks so the effect's `[mode, ready]` dep array doesn't re-run when the caller passes fresh closures each render.
  → The 9-case `switch (evt.type)` dispatcher inside `handle()`, including the coverage-item accumulator, the trace-item runner-replacement, and the auth-error bail-out.
  → The `stashInsights(list)` helper that pre-writes each insight to `sessionStorage` so the investigation page can hand them across (a same-instance-memory-isn't-reliable-on-Vercel correctness move).

The component never sees any of that. It calls the hook, reads the return value, renders.

#### Part 2 — the reconnect policy hook (the smallest extraction)

`useReconnectPolicy` (`lib/hooks/useReconnectPolicy.ts`, 123 LOC) is the smallest and the cleanest example. Its job: own the auth-error predicate, the one-shot session flag that prevents reconnect loops, and the reset+reload action. Returns an interface with one boolean (`reconnecting`) and three callbacks (`handle`, `reconnect`, `clearFlag`).

```ts
// lib/hooks/useReconnectPolicy.ts:47-66 — the return shape
export interface UseReconnectPolicyResult {
  reconnecting: boolean;
  handle: (errorMessage: string) => boolean;     // inspect; fire if auth-shaped; return true if handled
  reconnect: () => void;                          // unconditional reset+reload (manual button)
  clearFlag: () => void;                          // success path clears the one-shot guard
}
```

The composition pattern — *predicate + handler exported as one hook* — is the load-bearing move. Before the extraction, the page held the regex, the one-shot guard, the reset call, and the reload all inline; the briefing-fetch effect inspected error messages and fired the reconnect inline. Now:

```tsx
// app/page.tsx:52 (the policy hook)
const reconnectPolicy = useReconnectPolicy();

// app/page.tsx:111-112 (the briefing hook's auth-error callback wired into the policy)
onAuthError: reconnectPolicy.handle,
onStreamComplete: reconnectPolicy.clearFlag,

// app/page.tsx:254-265 (the JSX that reads `reconnecting`)
{reconnectPolicy.reconnecting && (
  <p style={...}>session expired — reconnecting to bloomreach…</p>
)}

// app/page.tsx:316-332 (the manual reconnect button)
<button onClick={reconnectPolicy.reconnect}>reconnect</button>
```

Four touch points; one cohesive concern. The hook exports both the policy *and* the predicate-only helpers (`isAuthErrorAuto`, `isAuthErrorButton`) at module scope so non-hook consumers like `useDemoCapture` can match the error shape without spinning up a separate hook instance — that's a subtle but real benefit of putting the policy and its predicates in one file.

**The two-regex honest finding lives here** (`useReconnectPolicy.ts:33-34`). The file's header comment names the latent bug and the refactor spec where unification is filed. That's the right way to comment a knowingly-imperfect module — call out the rough edge in the place a future reader will read first.

#### Part 3 — the demo capture hook (the orchestration extraction)

`useDemoCapture` (`lib/hooks/useDemoCapture.ts`, 146 LOC) is the third concern: the dev-only single-click snapshot-capture orchestration. Three phases inside the hook (POST briefing capture → run each investigation → POST again to bundle); the component just renders the button.

```ts
// lib/hooks/useDemoCapture.ts:38-41 — the return shape
export interface UseDemoCaptureResult {
  capturing: { active: boolean; msg: string };  // for the button's disabled state + label
  captureAll: () => Promise<void>;              // the on-click handler
}
```

And the composition:

```tsx
// app/page.tsx:118 (the hook)
const { capturing, captureAll } = useDemoCapture(insights, workspace, traceItems);

// app/page.tsx:360-383 (the JSX — the button is gated by NODE_ENV + mode)
{process.env.NODE_ENV !== 'production' && !isDemo && status === 'loaded' && (
  <button disabled={capturing.active} onClick={captureAll}>
    {capturing.active ? `⏳ ${capturing.msg}` : 'ⓘ dev · capture this as the demo snapshot (one click)'}
  </button>
)}
```

The hook takes the *current state of the briefing* (insights, workspace, traceItems) as arguments — it doesn't read them from anywhere else. That's deliberate: the captured snapshot has to match what the user is looking at, so the hook closure over those three values is the data the capture sends. When `useBriefingStream` reloads (mode flip, reconnect), the captured values change and `captureAll` rebinds.

**The honest design tradeoff lives in the hook's comment** (`useDemoCapture.ts:140-143`):

```ts
// postCapture / runInvestigation are closures over insights/workspace/
// traceItems; rebinding captureAll when those change keeps the captured
// body in sync with the latest UI state. capturing.active is read inside.
```

Naming why the dep array is what it is — that's the right level of comment for an `useCallback` whose deps look surprising.

#### Part 4 — the composition at the component

Now the payoff. The component's first 119 lines (after the imports) read like a script:

```tsx
// app/page.tsx:46-119 (annotated)
export default function HomePage() {
  // ── component-owned UI state (1 field) ──
  const [activeQuery, setActiveQuery] = useState<string | null>(null);

  // ── concern 1: revoked-token reconnect policy ──
  const reconnectPolicy = useReconnectPolicy();

  // ── component-owned mode state (the toggle persisted in localStorage) ──
  const forcedDemo = process.env.NEXT_PUBLIC_DEMO_ONLY === '1';
  const [mode, setMode] = useState<BriefingMode>('demo');
  const [ready, setReady] = useState(false);
  const isDemo = mode === 'demo';

  // ── resolve persisted mode before the first fetch ──
  useEffect(() => { /* localStorage read + migrate */ }, [forcedDemo]);

  // ── mode-flip handler ──
  function switchMode(next: BriefingMode) { /* setMode + clear query */ }

  // ── concern 2: briefing stream (composed with the reconnect policy) ──
  const {
    status, insights, workspace, coverage, traceItems,
    errorMessage, stepStatus, queryCount, demoSuffix,
  } = useBriefingStream(mode, ready, {
    onAuthError: reconnectPolicy.handle,
    onStreamComplete: reconnectPolicy.clearFlag,
  });

  // ── concern 3: demo-snapshot capture (composed with briefing's output) ──
  const { capturing, captureAll } = useDemoCapture(insights, workspace, traceItems);

  return ( <JSX> ... </JSX> );
}
```

**The component owns 1 UI field** (`activeQuery`) **+ 2 mode fields** (`mode`, `ready`). Everything else lives in the hooks. The composition pattern is callback-based: `useBriefingStream`'s `onAuthError` is wired to `useReconnectPolicy.handle`; `useDemoCapture`'s three inputs come from `useBriefingStream`'s output.

#### Part 5 — what's still load-bearing in the component

This is the honest part. After the extraction, what remains in the component is **the JSX, the JSX, the JSX**:

```
  what remains in app/page.tsx (line ranges)

  46–119   composition + mode handling (the 70 lines above)
  120–210  header + mode toggle JSX
  213–220  ProcessStepper JSX
  222–251  active-query response JSX
  253–265  reconnecting banner JSX
  267–453  the main grid: feed + status sidebar JSX
                ├── loading skeletons
                ├── error UI + auth reconnect button
                ├── empty state
                ├── loaded → InsightCard list
                ├── dev-only capture button
                └── live trace panel
  455–460  hidden QueryBox JSX (behind SHOW_QUERY_BOX flag)
```

JSX is hard to extract cleanly into hooks — it's the React component's actual job. What the decomposition achieved is putting the *imperative state-and-effect logic* behind hooks, leaving the JSX where it belongs. The remaining 340 lines of JSX are long, but they're declarative — they read straight down the page. That's a real limit of how much further this particular file can shrink without introducing a `FeedHeader` / `FeedErrorPanel` / `FeedStatusSidebar` family of presentational components. Whether that's worth the indirection cost is a separate audit.

### Move 3 — the principle

**Extract by responsibility, not by length.** The page wasn't decomposed because 817 LOC is too long; it was decomposed because three *independent* concerns lived together. Each one had its own state shape, its own effect graph, its own failure mode. After the extraction, each lives in a file the size of its concern: 313 LOC for the stream-with-9-cases, 146 LOC for the three-phase orchestration, 123 LOC for the predicate + one-shot guard + reset call.

The deeper principle: **a custom hook is the React equivalent of a deep module**. The interface (the return shape — `{ status, insights, ... }`, `{ capturing, captureAll }`, `{ reconnecting, handle, reconnect, clearFlag }`) is small. The body (the state declarations, the effects, the refs, the closures, the dispatchers) is large. The component composes the interfaces; the bodies are hidden.

That maps directly back to AOSD's `DataSource` lesson in `01-port-and-adapter-data-source.md`: stable interface, large body, the body changes without the interface needing to. The hook is the same shape at the React layer.

## Primary diagram

The decomposition in full — component composition + hook internals + what's hidden:

```
  ┌─ app/page.tsx — HomePage (461 LOC) ───────────────────────────────────┐
  │                                                                       │
  │  state owned by component:                                            │
  │     activeQuery · mode · ready                                        │
  │                                                                       │
  │  composes three hooks:                                                │
  │                                                                       │
  │  ┌─ const reconnectPolicy = useReconnectPolicy(); ─────────────────┐  │
  │  │  returns: { reconnecting, handle, reconnect, clearFlag }        │  │
  │  └────────────────┬────────────────────────────────────────────────┘  │
  │                   │ wired into                                         │
  │                   ▼                                                    │
  │  ┌─ const briefing = useBriefingStream(mode, ready, { ... }) ──────┐  │
  │  │  callbacks: { onAuthError: reconnectPolicy.handle,              │  │
  │  │               onStreamComplete: reconnectPolicy.clearFlag }     │  │
  │  │  returns: 9 fields (status, insights, workspace, coverage,      │  │
  │  │           traceItems, errorMessage, stepStatus,                 │  │
  │  │           queryCount, demoSuffix)                               │  │
  │  └────────────────┬────────────────────────────────────────────────┘  │
  │                   │ output fed into                                    │
  │                   ▼                                                    │
  │  ┌─ const capture = useDemoCapture(insights, workspace, trace) ───┐  │
  │  │  returns: { capturing, captureAll }                             │  │
  │  └─────────────────────────────────────────────────────────────────┘  │
  │                                                                       │
  │  JSX (340 lines): header · mode toggle · stepper · query response ·   │
  │       reconnect banner · grid(feed + sidebar) · capture button ·      │
  │       hidden QueryBox                                                  │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ useBriefingStream (313 LOC) ──┐  ┌─ useDemoCapture (146 LOC) ──┐
  │  - 9 useState declarations     │  │  - 1 useState (capturing)   │
  │  - 1 useEffect([mode, ready])  │  │  - useCallback(captureAll)  │
  │  - 1 useRef (cancel latch)     │  │  - 3 helpers (postCapture,  │
  │  - 1 useRef (callbacks)         │  │    runInvestigation, ...)   │
  │  - 9-case event dispatcher     │  │                              │
  │  - 1 helper: stashInsights      │  │                              │
  │  - readNdjson kernel call      │  │                              │
  └────────────────────────────────┘  └─────────────────────────────┘

  ┌─ useReconnectPolicy (123 LOC) ──┐
  │  - 1 useState (reconnecting)    │
  │  - useCallback × 3 (fireReset,  │
  │    handle, clearFlag)            │
  │  - 2 module-level regex         │
  │  - 2 module-level predicates    │
  │    (also exported separately)   │
  └─────────────────────────────────┘
```

## Elaborate

**Extract function** is one of the oldest refactoring moves — Martin Fowler's *Refactoring* (1999) lists it as the canonical "first move when a function gets too long." Custom hooks are React's specific version: a function that calls other hooks and returns a value. The `use` prefix is enforced by the React linter (`react-hooks/rules-of-hooks` ESLint plugin) — calling a hook outside a function whose name starts with `use` is flagged as an error.

The pattern shows up in every long-lived React codebase. The signal that you need it: a `useEffect` whose dep array contains 5+ entries; a component whose top is more `useState` + `useEffect` than JSX; an effect that does multiple things (fetch + parse + dispatch + reconnect-on-auth-error). The fix is always the same shape: name the concern, extract it into a `use[Concern]` hook, return what the component reads.

The two readability traps to avoid:

  → **Over-extraction.** A hook that wraps a single `useState` call adds indirection without hiding complexity. The rule of thumb: a hook is worth extracting when it owns ≥2 pieces of state, ≥1 effect, or a non-trivial dispatcher.
  → **Leaky abstractions.** A hook that returns refs the caller has to thread, or that needs the caller to call `start()` / `stop()` in a specific order, has leaked its internals. The interface should be a *result*, not a *protocol*. The three hooks here all return values, not protocols (`useDemoCapture` returns `{ capturing, captureAll }` — call `captureAll` and you're done).

This decomposition's lineage is documented in `.aipe/audit-refactor-page-decomposition/`. The original 817-LOC `page.tsx` was the largest "shallow module" finding in an earlier audit — shallow in AOSD's sense (large body, many independent concerns crammed together) rather than small. The decomposition was the action; this file teaches the result.

For the conceptual treatment, read `.aipe/read-aposd/part-2/03-deep-modules.md` (shallow modules are the negative space of deep ones) and `.aipe/read-aposd/part-2/08-together-or-apart.md` (the AOSD chapter on when to split a module).

## Interview defense

### Q1: "How did you decide the boundaries between the three hooks?"

```
  the test — three signals, all three present per concern

  signal 1: own state shape       → can name the state without referencing
                                     the other concerns
  signal 2: own effect graph      → can describe when the effect re-runs
                                     and what triggers cleanup
  signal 3: own failure mode      → can name a distinct way it can fail
                                     and what the recovery is

  ┌─ useBriefingStream ──────────────────────────────────────────────┐
  │  state: status, insights, workspace, coverage, trace, errorMsg,  │
  │         stepStatus, queryCount, demoSuffix (9 fields)            │
  │  effect: [mode, ready] — re-runs on mode flip                    │
  │  failure: 401 → onAuthError callback; non-401 → status='error'   │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ useDemoCapture ─────────────────────────────────────────────────┐
  │  state: capturing { active, msg }                                │
  │  effect: none — fires only on user click                          │
  │  failure: phase 1 fail → alert + abort; phase 2 auth fail →      │
  │           keep cached, return early                              │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ useReconnectPolicy ─────────────────────────────────────────────┐
  │  state: reconnecting + sessionStorage 'bi:reconnecting' flag     │
  │  effect: none — fires on handle() / reconnect() being called     │
  │  failure: alreadyTried → return false, let caller surface error  │
  └──────────────────────────────────────────────────────────────────┘
```

Three tests, applied per concern. **Own state shape, own effect graph, own failure mode.** If a concern has all three, it earns its own hook. If two concerns share state (e.g. "the current selected insight" is read by three things), they don't extract cleanly — leave them in the component.

The briefing stream has 9 state fields, one effect keyed on `[mode, ready]`, and a 401-vs-other failure split. The demo capture has 1 state field, no effect (user-triggered), and a 3-phase failure path. The reconnect policy has 1 state field + 1 sessionStorage flag, no effect (callback-triggered), and a one-shot-guard failure path. Each one passes all three signals.

**Anchor:** state + effect + failure — if all three are distinct, the concern earns its hook.

### Q2: "What's the cost of this decomposition? Hooks aren't free."

```
  the costs — name them honestly

  cost 1: indirection
    component reads briefing.insights instead of insights (1 dot)
    new contributor has to open 4 files to follow one fetch

  cost 2: composition wiring
    page.tsx wires onAuthError → reconnectPolicy.handle
    if the contract drifts (handle expects string, callback passes
    Error), it's a runtime bug, not a type error inside the component

  cost 3: hook lifetime + StrictMode subtleties
    useInvestigation has the "do NOT cancel on cleanup" workaround
    (the comment at useInvestigation.ts:36-37) — that's a real
    extraction cost: StrictMode behavior is now per-hook, harder
    to debug across files

  cost 4: read-trace cost
    grep for `insights` returns hits in 4 files instead of 1
    (page.tsx + the 3 hooks)
```

Four costs, named:

  1. **Indirection** — the component reads `briefing.insights` instead of `insights`. One extra dot. A new contributor has to open 4 files to follow one fetch end-to-end.
  2. **Composition wiring** — the contract between hooks is callback-based, not type-checked across the boundary. If `onAuthError`'s signature drifts (e.g. starts being called with `Error` instead of `string`), the type error fires in the hook's caller, not at the composition site.
  3. **Hook lifetime + StrictMode subtleties** — `useInvestigation.ts:36-37` documents an in-the-wild StrictMode trap where cancelling on cleanup aborts a re-mount's stream. That's a real cost of putting effects behind hooks: the subtle behaviour is now per-hook, and the workaround needs documenting.
  4. **Read-trace cost** — a `grep -rn insights` returns hits in 4 files instead of 1.

The benefit (the component's mental model is 70 lines instead of 600) outweighs the costs for this codebase, but the costs are real. The rule of thumb: extract when the concern is genuinely independent; don't extract just because the file is long.

**Anchor:** the four costs of extraction — indirection, composition drift, StrictMode subtleties, grep noise.

### Q3: "What's still load-bearing in `page.tsx` after the extraction? Could it shrink more?"

```
  what's left — and why some of it has to stay

  ──────────────────────────────────────────────────────────────────────
  46–119    composition + mode handling      ── 70 LOC ── could shrink
                                                 (useMode() would
                                                  extract the localStorage
                                                  read + migrate dance)
  120–210   header + mode toggle JSX          ── 90 LOC ── JSX, hard to
                                                            shrink without
                                                            FeedHeader.tsx
  213–220   ProcessStepper JSX                ──  8 LOC ── already a
                                                           component
  222–251   active-query response JSX         ── 30 LOC ── component-
                                                           specific
  253–265   reconnecting banner JSX           ── 13 LOC ── hook returns
                                                           reconnecting;
                                                           banner is JSX
  267–453   feed grid (feed + sidebar)        ── 186 LOC ── the bulk;
                                                            five branches
                                                            of UI state
  455–460   hidden QueryBox                   ──  6 LOC ── feature flag
  ──────────────────────────────────────────────────────────────────────
  total                                       ── 461 LOC ──
```

After the extraction, three places could shrink further:

  → **The mode + localStorage dance (lines 61-95).** Extracts cleanly into a `useMode()` hook that owns the persisted-value migration. Probably worth doing — it's another "own state shape, own effect graph, own failure mode" concern.
  → **The header + mode toggle JSX (lines 120-210).** Extracts into a `FeedHeader` component. Worth doing if it grows; not worth doing today.
  → **The feed grid (lines 267-453).** This is the big one. Extracts into `FeedColumn` + `FeedStatusSidebar`. *But* the five branches of UI state (loading / error / empty / loaded / dev-capture) are tightly coupled — the conditions overlap (`status === 'loaded'`, `status === 'loading' && !reconnecting`, etc.). Pulling them into components creates prop-drilling pain.

**The honest answer:** the next meaningful shrink is `useMode()` (50 LOC out). Further extraction past that crosses into "JSX-vs-state separation" territory, which is a different kind of refactor with its own costs.

**Anchor:** the JSX is the component's job; the state-and-effect logic is the hook's. The decomposition is done when those two are cleanly separated.

## See also

  → `00-overview.md` — the system view of where the hooks sit.
  → `audit.md` — lens 2 (deep-vs-shallow modules) and lens 4 (layers-and-abstractions).
  → `02-streaming-ndjson-kernel.md` — the kernel that both `useBriefingStream` and `useInvestigation` consume.
  → `05-session-keyed-state.md` — a different kind of "small interface, real correctness invariant" decomposition.
  → `.aipe/read-aposd/part-2/03-deep-modules.md` and `.aipe/read-aposd/part-2/08-together-or-apart.md` — the conceptual chapters.
  → `.aipe/audit-refactor-page-decomposition/` — the action history of how this decomposition was done.
