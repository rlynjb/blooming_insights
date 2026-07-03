# progressive skeleton with stepper

**Progressive disclosure / streaming-render composition** — Industry standard (as a pattern; the four-tier composition is project-specific).

## Zoom out, then zoom in

You've built a form with a spinner. Loading state → spinner. Success state → form. Error state → red text. This is the same idea multiplied by four surfaces stacked on the same page, driven by the same NDJSON event stream.

```
  Zoom out — where the progressive composition lives

  ┌─ Browser (app/page.tsx) ─────────────────────────────────┐
  │  ┌─ tier 1: ProcessStepper ────────────────────────────┐ │
  │  │  monitoring [1] → diagnostic [2] → recommendation [3]│ │
  │  │  pending · active · complete · error                │ │
  │  └─────────────────────────────────────────────────────┘ │
  │  ┌─ tier 2: CoverageGrid (10 category tiles) ──────────┐ │
  │  │  pending → clear · limited · anomaly                │ │
  │  └─────────────────────────────────────────────────────┘ │
  │  ┌─ tier 3: Skeleton × 4 (card placeholders) ─────────┐  │
  │  │  gray boxes → real InsightCard as each lands       │  │
  │  └────────────────────────────────────────────────────┘  │
  │  ┌─ tier 4: StatusLog / ReasoningTrace (sidebar) ─────┐  │
  │  │  connecting → reasoning + tool calls stream in     │  │
  │  └────────────────────────────────────────────────────┘  │
  └────────────────────────┬─────────────────────────────────┘
                           │  all four tiers driven by
                           │  ★ ONE useBriefingStream call ★
                           ▼
                    NDJSON stream from /api/briefing
```

**Zoom in — the concept.** A monitoring agent takes 20-40 seconds to check the workspace. The naive UI is a spinner for 30 seconds and then a page of insight cards. That's not the product — the product is *watching* the agent work. So the UI opens four tiers of feedback that fill in progressively, each carrying a different level of "what's happening": the stepper says which phase, the coverage grid says which categories have been checked, the skeleton says how many cards to expect, the status log says the exact query. All four tiers read from the *same* event stream.

## The structure pass

Layers — four tiers of feedback, all reading the same stream:

```
  One stream, four tiers, one axis (specificity)

  ┌─ tier 1 — ProcessStepper ──────────────────────────┐
  │  which PHASE   (monitoring / diagnostic / decision) │  most abstract
  │  state ∈ pending · active · complete · error        │
  └──────────────────────────┬──────────────────────────┘
                             │  derived from FeedStatus
  ┌─ tier 2 — CoverageGrid ──▼──────────────────────────┐
  │  which CATEGORY was checked, with what result       │  ↓
  │  10 tiles: pending → clear / limited / anomaly      │  more specific
  └──────────────────────────┬──────────────────────────┘
                             │  driven by 'coverage_item' events
  ┌─ tier 3 — Skeleton ──────▼──────────────────────────┐
  │  how MANY cards to expect, in the layout            │  ↓
  │  4 gray boxes → replaced by InsightCards as they    │
  │  land in the 'done' collected array                 │
  └──────────────────────────┬──────────────────────────┘
                             │  driven by 'insight' + 'done'
  ┌─ tier 4 — StatusLog / ReasoningTrace ──────────────┐
  │  the exact QUERY the agent just ran                 │  most specific
  │  driven by every 'reasoning_step' and 'tool_call_*' │
  └─────────────────────────────────────────────────────┘
```

**Axis: specificity.** Trace it top to bottom.
- Tier 1 (stepper) — "we're checking things." One of three states, one phase.
- Tier 2 (coverage grid) — "we checked cart-abandonment, and it's clear." One of 10 categories, one of 4 outcomes.
- Tier 3 (skeleton → cards) — "here are the specific anomalies we found." Actual card content.
- Tier 4 (status log) — "we're running `execute_analytics_eql` with this filter." Verbatim agent thought / tool call.

The axis flips at every tier. If a user glances at the page, they get the phase. If they focus, they get the category. If they read, they get the anomaly. If they dive in, they get the query itself. **Same stream, four altitudes.**

Seams: two matter. Seam A is `useBriefingStream` → the four tiers (all four read the same hook's return shape). Seam B is between tiers 3 and 4 — the skeleton and status log render in parallel via `grid-cols-1 lg:grid-cols-3` at `page.tsx:270`; column 1 is tier 3, column 2 is tier 4. Neither blocks the other.

## How it works

### Move 1 — the mental model

You've built a `<Suspense fallback={<Spinner />}>` before. Same shape, four times: each tier declares its own "loading" (skeleton), "empty" (nothing to show), "loaded" (real content), and (where relevant) "error" states. The skeleton shape matches the real content shape — same height, same rough layout — so when the real content lands there's no layout shift.

```
  The pattern — each tier is a state machine reading the same events

  event stream:  workspace → coverage_item × N → tool_call_start
                          → reasoning_step → tool_call_end → insight
                          → ... → done

  tier 1 (stepper):     [monitoring: active] → [monitoring: complete]
  tier 2 (coverage):    []                    → [tile ✓]              → [tile ✓ tile ✓]  → ...
  tier 3 (cards):       [skeleton x 4]        → [skeleton x 4]        → [skeleton x 4]   → [card x N]
  tier 4 (status log):  [connecting…]         → [tool_call_start...]  → [thought...]     → ...

                        │◄──────────────── all reading the same stream ────────────────►│
```

The load-bearing bit is that the tiers **update at different rates**. The stepper flips once (loading → complete). The coverage grid ticks up 10 times. The status log streams every event (dozens). The card list fills in at the end. Each tier decides its own granularity. Miss that and you either (a) update the stepper on every event (over-communication) or (b) update the status log only on completion (loses the point).

### Move 2 — the walkthrough

#### Sub-move A — the ProcessStepper (tier 1)

Three step slots, each with a `state ∈ pending | active | complete | error` and an optional `sub` line. State comes from the parent — the feed page derives `monitoringState(status)` from `FeedStatus`, the investigate pages derive their own from the diagnosis/recommendation state.

```
  The stepper — one input per step, deterministic render

  ┌─ input for step ─────────────────────────────────────┐
  │  { state: 'pending' | 'active' | 'complete' | 'error'│
  │    sub?: string           (status line)              │
  │    href?: string          (turns step into a Link)   │
  │  }                                                   │
  └───────────────────────┬──────────────────────────────┘
                          │  × 3 (monitoring, diagnostic, recommendation)
                          ▼
  ┌─ render ─────────────────────────────────────────────┐
  │  [1][2][3]  labels + sub lines                       │
  │  ‗ active step: badge pulses (animate-pulse)         │
  │  ‗ complete: green ✓ badge                           │
  │  ‗ pending: outlined circle                          │
  │  ‗ error: red '!' badge                              │
  └──────────────────────────────────────────────────────┘
```

The subtle design choice — the **active step never shows ✓**. When the user is *on* the diagnose page, `diagState = 'active'` (`investigate/[id]/page.tsx:46`), even after the diagnosis lands. Only when they leave the page for step 3 does step 2 flip to `complete`. This is documented in the project context ("the **current** step stays `active` (never ✓) while the user is on it").

Code (`components/shared/ProcessStepper.tsx:83-92`):

```tsx
const labelColor =
  state === 'pending'
    ? 'var(--text-tertiary)'                    // faded
    : state === 'error'
      ? 'var(--accent-coral)'                   // red
      : 'var(--text-primary)';                  // white — active AND complete both bright
```

The badge gets `background: var(--accent-teal)` for both `complete` and `active` states (line 59-60) — the difference is the *content* (`✓` vs `i + 1`) and the `animate-pulse` class on `active` (line 109). Consistent visual language: green means "you're in it or past it," gray means "not yet."

**Where it breaks if you strip it:** without the stepper, the user has no idea whether the app is *starting*, *middle of a phase*, or *between phases*. The reasoning log alone doesn't answer "how far along am I?" because reasoning steps look identical whether it's step 5 of 30 or step 25 of 30.

#### Sub-move B — the CoverageGrid (tier 2)

Ten anomaly-category tiles, one per `CategoryId` in `lib/agents/categories.ts`. Each tile has three visual states:

```
  Coverage tile lifecycle — one tile

  ┌─ pending ─────────┐  server hasn't reported this category yet
  │  gray icon        │  animate-pulse, opacity 0.5
  │  "checking…"      │  Skeleton bar at bottom
  │  category label   │
  └──────────┬────────┘
             │  coverage_item event lands for this category
             ▼
  ┌─ resolved ────────┐  server reported: coverage ∈ full | limited | unavailable
  │  colored icon     │
  │  status label     │  clear · limited · anomaly · no data source
  │  finding text     │  agent's one-line finding for this category
  └───────────────────┘
```

The load-bearing move is the **accumulator pattern in the event handler** (`useBriefingStream.ts:209-214`):

```tsx
case 'coverage_item':
  setCoverage((prev) =>
    prev.some((c) => c.category === evt.item.category)
      ? prev
      : [...prev, evt.item],
  );
  break;
```

Each `coverage_item` event pushes ONE tile's report into the accumulator. `CoverageGrid.tsx:117-153` renders one tile per `CATEGORIES[i]`, looking up its status from the coverage map — if the category isn't in the map yet AND `loading === true`, the tile renders as pending. This means the grid fills in progressively, tile by tile, as the monitoring agent reports each category.

The counts at the top (`CoverageGrid.tsx:70-73`) update on every re-render:

```tsx
const checked = coverage.length;
const monitored = coverage.filter((c) => c.coverage !== 'unavailable').length;
const firing = CATEGORIES.filter((c) => insightByCat.has(c.id)).length;
const skipped = coverage.filter((c) => c.coverage === 'unavailable');
```

Not memoized — cheap enough at N=10 that recomputing per render is fine. If N grew to 100+ this would warrant `useMemo`; see `audit.md → frontend-red-flags-audit` red flag #2.

**Where it breaks if you strip it:** without the coverage grid, the user sees "5 anomalies" but has no idea whether the agent checked 5 categories or 50. The grid is the **completeness signal** — "we looked at these 10 things, and here's what came back." Without it, the pitch drops from "your workspace, in bloom" to "here are five things we noticed."

#### Sub-move C — the Skeleton and the card fill (tier 3)

Four gray rectangles while loading (`page.tsx:278-285`), replaced by the real `InsightCard`s at once when the `done` event lands (`useBriefingStream.ts:266-273`):

```tsx
// during 'loading':
<Skeleton height={96} />
<Skeleton height={96} />
<Skeleton height={96} />
<Skeleton height={96} />

// on 'done':
case 'done':
  setInsights(collected);           // ← the accumulated insights land here
  stashInsights(collected);         // ← + sessionStorage stash for the investigation page
  callbacksRef.current?.onStreamComplete?.();
  setStatus(collected.length === 0 ? 'empty' : 'loaded');
  break;
```

Note the choice: individual `case 'insight'` events push to a **local `collected: Insight[]`** at `useBriefingStream.ts:202,264` — they do NOT go to state as they arrive. Only on `done` does the whole array land in `setInsights(collected)` at once.

This is a deliberate pacing choice. Cards popping in one-at-a-time competes for attention with the tier-4 status log, which IS updating in real time. Batching card display at `done` gives the eye ONE thing to look at (the log) during the run, then delivers the payoff (the cards) once. Compare the alternative:

```
  Comparison — card streaming vs batch-on-done

  ┌─ streaming (alt) ──────┐   ┌─ batch on 'done' (this) ─┐
  │ card 1 pops in         │   │ [skeleton × 4] holds     │
  │ card 2 pops in         │   │ [skeleton × 4] holds     │
  │ card 3 pops in         │   │ [skeleton × 4] holds     │
  │ log is scrolling       │   │ log is scrolling         │
  │ eye jumps back & forth │   │ eye stays on log         │
  │ card 4 pops in         │   │ done → cards land at once│
  └────────────────────────┘   │ eye moves to cards       │
                                └──────────────────────────┘
   two things competing         one thing at a time
   for the same eye             then handoff
```

The `Skeleton` component itself is 18 LOC — a `div` with `background: 'var(--bg-elevated)'` and a `bi-fade-up` animation. Trivial. What earns its keep is that the four skeletons **match the eventual card height** (`height={96}`) — so when the cards land there's no layout shift. That's the value: not the gray box, but the shape.

**Where it breaks if you strip it:** without the skeletons, the "loading" state is either an empty column (user thinks it's broken) or a plain spinner (no sense of scale). With four `Skeleton height={96}` boxes the user sees "there's going to be roughly this many things, roughly this size" before any content arrives.

#### Sub-move D — the StatusLog + ReasoningTrace (tier 4)

The sticky sidebar. Reads `traceItems: TraceItem[]` from the same hook, streams every reasoning step and tool call as it arrives. Lives in a right-column `aside` at `page.tsx:386-452` (and again wrapped in the `StatusLog` component at `investigate/[id]/page.tsx:214`).

The `TraceItem` shape at `ReasoningTrace.tsx:6-24` is a discriminated union:

```ts
type TraceItem =
  | { kind: 'step';  id; agent; stepKind; content; ts? }
  | { kind: 'tool';  id; toolName; status; durationMs?; result?; error?; ts? };
```

The dispatch in `useBriefingStream.ts:218-262` is the interesting part. `tool_call_start` pushes a new `{ kind: 'tool', status: 'running' }`; `tool_call_end` finds the last matching tool by name and status, and mutates it in place:

```tsx
case 'tool_call_end':
  setTraceItems((prev) => {
    const next = [...prev];
    for (let i = next.length - 1; i >= 0; i--) {
      const it = next[i];
      if (it.kind === 'tool' && it.toolName === evt.toolName && it.status === 'running') {
        next[i] = { ...it, status: 'done', durationMs: evt.durationMs, result: evt.result, error: evt.error };
        break;
      }
    }
    return next;
  });
  break;
```

The `for (let i = next.length - 1; i >= 0; i--)` — reverse scan — is a subtle correctness fix. Two concurrent tool calls with the same name (the monitoring agent runs multiple `execute_analytics_eql`s in parallel) would produce two `tool_call_start` events before either `tool_call_end`. Reverse-scanning matches the most recent running one, so the completion of tool A closes tool A's row (the older entry) and tool B's completion closes tool B's row (the newer entry). Forward-scan would close A twice.

Cross-linking: this is identical to the pattern used in `useInvestigation.ts:87-96` (the `replaceRunningTool` helper). Same reverse-scan, same reasoning. When the same pattern shows up in two places without being extracted, that's a signal — either it's still finding its shape, or it's stable and worth pulling out. Here it's stable enough; the extraction is a `refactor` candidate, not a `study` finding.

**Where it breaks if you strip it:** this IS the pitch. Everything else is packaging. Without the reasoning trace, blooming insights becomes "an anomaly detector" — a category that already exists and has commodity vendors. WITH the trace, it's "an analyst that shows its work" — which is the differentiator. The trace visible to the user is the point.

### Move 3 — the principle

**Progressive disclosure is a *composition*, not a single component.** Four tiers reading the same event stream, each rendering at its own granularity — coarse → fine, from phase to query. The value isn't in any tier individually (a stepper alone is a decoration; a status log alone is chaos). It's in the *composition* — every tier answers "what's happening?" at a different altitude, so the user's eye can land wherever their attention is right now.

The broader principle: streaming UIs need multiple **rate-adapted feedback tiers** off the same event source. Fast events (log lines) belong at the finest tier; slow state transitions (phase changes) belong at the coarsest. Trying to jam everything into one tier — either a single spinner or a single log — fails predictably: too abstract to inform, or too specific to skim.

## Primary diagram — recap

All four tiers, the shared stream, and where each derives its state.

```
  The full composition — one hook, four tiers, one stream

  ┌─ /api/briefing NDJSON stream ─────────────────────────────────┐
  │  workspace → coverage_item × 10 → tool_call_start →           │
  │  reasoning_step → tool_call_end → insight × N → done          │
  └─────────────────────────────┬─────────────────────────────────┘
                                │  readNdjson (see 01-*)
                                ▼
  ┌─ useBriefingStream (return shape) ────────────────────────────┐
  │  status | insights | workspace | coverage | traceItems |      │
  │  errorMessage | stepStatus | queryCount | demoSuffix          │
  └──┬──────────────┬──────────────┬──────────────┬──────────────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
  ┌────────┐   ┌────────┐   ┌─────────────┐   ┌──────────────┐
  │ TIER 1 │   │ TIER 2 │   │  TIER 3     │   │  TIER 4      │
  │ Stepper│   │ Grid   │   │  Skeleton × │   │  StatusLog + │
  │        │   │        │   │  4  → cards │   │  ReasoningTr.│
  ├────────┤   ├────────┤   ├─────────────┤   ├──────────────┤
  │ reads: │   │ reads: │   │ reads:      │   │ reads:       │
  │ status │   │ coverage│   │ status,     │   │ traceItems   │
  │        │   │ insights│   │ insights    │   │              │
  ├────────┤   ├────────┤   ├─────────────┤   ├──────────────┤
  │ updates│   │ updates│   │ updates on  │   │ updates on   │
  │ 1×     │   │ 10×    │   │ 'done' only │   │ every event  │
  └────────┘   └────────┘   └─────────────┘   └──────────────┘
   phase        category      anomaly           query
```

## Elaborate

**Where the pattern comes from.**

Progressive disclosure has been a UX term since Nielsen (early 90s) — start with the coarse summary, let the user drill deeper. What this repo does is the *streaming* variant: not "hide details until asked" but "reveal details as they become known." Related patterns:

- **Skeleton screens** — Facebook popularized these (~2013) as a replacement for spinners. Same idea used here in tier 3.
- **Streaming SSR** (Next.js, Remix) — server-side counterpart. The server ships HTML in chunks; the browser renders as it arrives. This repo does NOT do streaming SSR (all pages are `'use client'`); it does client-side streaming from an NDJSON API.
- **Suspense with `<Await>`** (Remix) / `<Suspense>` (React) — a compiler-supported form of the tier composition. Each `<Suspense>` boundary is a tier. This repo could refactor to use `<Suspense>` if the fetches moved to route loaders; today the `useEffect + useState` pattern does the same job without the framework buy-in.

**Adjacent concepts.**

- **Optimistic UI** — same "show something now, correct later" philosophy applied to writes. This repo doesn't do writes, so it's not exercised. If the QueryBox were re-enabled (`page.tsx:16` — `SHOW_QUERY_BOX = false`) and free-form queries persisted, this would apply.
- **Virtualization** — when the trace grows past ~100 items the sidebar becomes long. This repo doesn't virtualize (`ReasoningTrace.tsx:64-105` maps over all items). At current lengths it's fine; at 500+ it becomes a `react-virtuoso` / `react-window` candidate.
- **State machines** — each tier is implicitly a state machine (`FeedStatus = 'loading' | 'error' | 'empty' | 'loaded'`, `StepState = 'pending' | 'active' | 'complete' | 'error'`). None are formalized with XState or similar — the string unions do the job.

**What would change if this were RSC.**

React Server Components with streaming HTML would push each tier to the server. Instead of `useState` accumulating events, the server would render each tier's DOM as data arrived and stream the HTML. Advantages: no client JS for the render, initial HTML has content. Disadvantages here: the four consumers reading the same event stream would each need their own suspense boundary; the "click a card, go to investigate" hydration would still need the client stash (`bi:insight:<id>`). Net: for a live-agent pitch, the client stream + client render is genuinely simpler. The migration is not on the roadmap.

## Interview defense

**Q: You have a 30-second server operation. What does the UI do?**

Diagram:

```
  ┌─ Stepper: monitoring [active] ─┐  ← flips once
  ├─ Grid: 10 tiles filling in ────┤  ← ticks 10 times
  ├─ 4 skeletons →  4 cards       ─┤  ← flips once (at done)
  └─ Log: streams every event ────┘  ← ticks 20-40 times
                                      updates at different rates
                                      off ONE event stream
```

Answer: four tiers of feedback off the same event stream. Coarse-to-fine — phase (stepper), category (grid), anomaly (cards), query (log). Each tier updates at its own rate. The stepper flips once. The grid ticks 10 times. The log streams every event. The cards batch on `done` to avoid competing with the log for the user's attention. All four read from `useBriefingStream`, which owns the fetch, the NDJSON parse, and the event dispatcher.

The load-bearing part people forget: **cards batch on `done`, not per-event.** The individual `insight` events push to a local `collected` array (not to state); only `done` calls `setInsights(collected)`. This is deliberate — cards popping in one at a time distracts from the log that IS updating in real time. Batching the payoff at the end gives the eye ONE thing to watch during the run. Anchor: `useBriefingStream.ts:202,264-273`.

**Q: How do you avoid layout shift when the skeletons swap to real content?**

The `Skeleton` component takes an explicit `height` prop (`page.tsx:280-283` — `<Skeleton height={96} />`). 96 pixels matches the eventual `InsightCard` compact height. When the cards land, the container stays the same height — no CLS. Same trick on the coverage tiles: `minHeight: 96` on both the pending tile (`CoverageGrid.tsx:135`) and the resolved tile (`CoverageGrid.tsx:168, 231`).

**Q: The four tiers all re-render on every event. Isn't that wasteful?**

Yes, and it's documented in the audit as red flag #2. Today the payload is small enough (10 coverage items + ~30 trace items) that the eye doesn't see jank — the `bi-fade-up` animation on each new item masks it. When the trace hits ~200 items the map-over-all-items on every event becomes measurable, and `React.memo` on `TraceItem` rows keyed by `id` becomes the fix. Actual measurement belongs in `study-performance-engineering`. Not a bug today; a documented deferrable.

**Q: Why not `<Suspense>`?**

Suspense pairs with a route loader or an RSC-side data fetch — both require moving the fetch out of `useEffect` into a framework-owned data layer. The four fetches this repo does (briefing / agent × 3) all live in `useEffect` because they're driven by user state (`bi:mode`, insight ID, StrictMode-safe start guards). Refactoring to route loaders would work but doesn't buy anything the current shape doesn't have — each tier is already its own state machine, already renders its own loading / empty / loaded / error branches. Suspense is the answer when you have deeply nested async boundaries; here there are four parallel siblings, not a nested tree.

## See also

- `01-ndjson-stream-reader-hook.md` — the *source* of the events these four tiers consume; how bytes become the `AgentEvent` / `BriefingEvent` values dispatched to each tier's state.
- `audit.md` — the state-architecture lens for the six state seams, the component-architecture lens for the sizes and boundaries, and the frontend-red-flags lens for the missing `aria-live` (which lives on tier 4).
- `study-performance-engineering` — measurement of the re-render cost, FCP/LCP for the initial skeleton paint, and where memoization would pay off.
- `study-runtime-systems` — how the async NDJSON reader and the four `useState` cascades interact with React's scheduler.
- `study-software-design` — the reasoning for centralizing `readNdjson` and NOT centralizing the `TraceItem` reverse-scan mutation (two callers, still stable, not yet worth extracting).
