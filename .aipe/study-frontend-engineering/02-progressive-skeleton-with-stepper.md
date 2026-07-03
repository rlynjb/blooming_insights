# progressive skeleton with stepper

## Subtitle

**progressive rendering with stubbed placeholders** · industry standard for "show what's happening" streaming UIs — a.k.a. *skeleton screens*, *streaming SSR handoff*, *progressive disclosure* (each vendor gives it a different name).

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The feed page is not a single-shot render. It's four independent visual tiers, each with its own placeholder, each of which flips to real data as a matching stream event arrives. The user watches the shape appear from the top down: stepper first (mounted immediately), coverage tiles second (one per `coverage_item` event), insight cards third (batched at `done`), reasoning trace ongoing (every reasoning + tool event). The whole feed has real shape from the first paint — nothing is empty; nothing is a spinner.

```
  Zoom out — where progressive skeletons sit

  ┌─ UI layer (React tree) ─────────────────────────────────────────┐
  │                                                                  │
  │  ★ 4-tier progressive composition ★  ← we are here               │
  │    ├─ ProcessStepper   (mounted; state comes from fetch status)  │
  │    ├─ CoverageGrid     (10 pending tiles → tiles fill in)        │
  │    ├─ Skeleton stack   (4 card placeholders → cards render)      │
  │    └─ ReasoningTrace   (empty → grows per reasoning/tool event)  │
  │                                                                  │
  └────────────────────────────────────┬────────────────────────────┘
                                        │  each tier consumes a
                                        │  slice of the stream
                                        ▼
  ┌─ Stream consumer (useBriefingStream) ──────────────────────────┐
  │  status | insights | coverage | traceItems | stepStatus | ...   │
  └─────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The pattern is *stubbed structure first, real data folds in*. Skeleton screens are the well-known name, but this repo pushes further — the skeleton isn't one blob for the whole page, it's four independent tiers each keyed to a different NDJSON event type. The stepper reflects the fetch status; the grid fills tile-by-tile; the card slot shows N placeholder cards until the whole result set is ready; the reasoning trace grows one row at a time. Load-bearing test: strip this out and the whole "shows its work" pitch — the reason blooming_insights streams at all — becomes invisible. You'd have a spinner and then a big flash of everything, and the user would never see the agent actually working.

## Structure pass

Skeleton before mechanics.

**Layers — from framework down to placeholder.**

```
  Layers — four tiers of the feed, top to bottom

  ┌─ tier 1: ProcessStepper (three fixed slots) ────────────────┐
  │   state derived from FeedStatus | sub derived from stream    │
  ├─ tier 2: CoverageGrid (10 fixed tiles) ─────────────────────┤
  │   coverage array grows tile-by-tile; unfilled = pending      │
  ├─ tier 3: card slot (4 Skeletons OR N InsightCards) ─────────┤
  │   binary swap: loading → skeleton; loaded → real cards       │
  ├─ tier 4: ReasoningTrace (grows unbounded) ──────────────────┤
  │   empty → trace items appended per reasoning_step / tool     │
  └──────────────────────────────────────────────────────────────┘
```

**Axis held constant — what does this tier show when data is absent?**

  - Tier 1 (stepper): step 1 badge shows a spinner-styled `active` state, steps 2/3 show `pending` placeholder text.
  - Tier 2 (grid): all 10 tiles render as pending skeletons; each is a tile-sized box with the category icon dimmed.
  - Tier 3 (cards): a stack of 4 fixed-height `Skeleton` boxes.
  - Tier 4 (trace): an empty state text "connecting to the agent…".

Same axis across every tier: **no data = keep the shape; fill it as data arrives.** Nothing collapses; nothing jumps.

**Seams — where placeholder flips to real data.**

  - Stepper ← FeedStatus mapping (`app/page.tsx:20-25`). Seam: the `monitoringState()` function turning `'loading' | 'error' | 'empty' | 'loaded'` into `StepState`.
  - Grid ← `coverage_item` event (`useBriefingStream.ts:220-224`). Seam: the array-accumulator that appends one tile at a time.
  - Card slot ← `done` event (`useBriefingStream.ts:277-284`). Seam: the batched publish from the closure-scoped `collected: Insight[]`.
  - Trace ← `reasoning_step` + `tool_call_start/end` events (`useBriefingStream.ts:229-273`). Seam: the append/patch on `traceItems`.

Four seams, four independent tiers, four different stream events. This is why the whole feed feels alive during a live briefing — each tier reacts to a different event so the UI updates constantly.

## How it works

### Move 1 — the mental model

You know how a `fetch()` has three UI states: loading / success / error? A single-state loading spinner tells the user "something is happening" but not "what's happening." The progressive pattern splits the single "loading" state into as many sub-states as the stream has stages, and gives each stage its own placeholder → real handoff.

The mental model: **the shape of the final UI is present from the first paint; every sub-region has its own dumb stub that swaps for real data when its matching event arrives.** Not one skeleton for the page — one skeleton per region, each keyed to a different setState in the streaming hook.

```
  Pattern — four independent tiers, each swaps its stub for real data

  time →

  t0 (mount)                t1 (workspace)         t2 (coverage_item×N)
  ┌─ stepper ─┐             ┌─ stepper ─┐          ┌─ stepper ─┐
  │ ● 1 · loading           │ ● 1 · scanning       │ ● 1 · query 1
  │ ○ 2 · pending           │ ○ 2 · pending        │ ○ 2 · pending
  │ ○ 3 · pending           │ ○ 3 · pending        │ ○ 3 · pending
  ├───────────┤             ├───────────┤          ├───────────┤
  │ [ 10 pending tiles ]    │ [ header + 10 ]      │ [3 filled, 7 pending]
  ├───────────┤             ├───────────┤          ├───────────┤
  │ ▭ skeleton              │ ▭ skeleton           │ ▭ skeleton
  │ ▭ skeleton              │ ▭ skeleton           │ ▭ skeleton
  ├───────────┤             ├───────────┤          ├───────────┤
  │ (empty trace)           │ • thought: scan...   │ • tool: get_events
  └───────────┘             └───────────┘          └───────────┘

  t3 (insight×N + done)     t4 (final)
  ┌─ stepper ─┐             ┌─ stepper ─┐
  │ ✓ 1 · 3 changes         │ ✓ 1 · 3 changes
  │ ○ 2 · opens when...     │ ○ 2 · opens when...
  ├───────────┤             │ ○ 3 · ...
  │ [10 filled]             ├───────────┤
  ├───────────┤             │ [10 filled]
  │ ▪ InsightCard           ├───────────┤
  │ ▪ InsightCard           │ ▪ real cards
  │ ▪ InsightCard           ├───────────┤
  ├───────────┤             │ • full trace visible
  │ • trace grows           └───────────┘
  └───────────┘
```

Every column has real shape. The user always sees something meaningful.

### Move 2 — the step-by-step walkthrough

I'll walk each of the four tiers as its own moving part, then show how they're composed in `app/page.tsx`.

#### Tier 1 — the ProcessStepper (fetch status → step state)

The stepper has three fixed slots (monitoring / diagnostic / recommendation) and takes three `StepInput` props (`components/shared/ProcessStepper.tsx:14-18`). Each slot renders a badge, a label, and a status sub-line. On the feed page, only monitoring runs; the other two are gated on the investigate flow.

**The mapping from FeedStatus to StepState is a pure function.** Lives at the top of `app/page.tsx`:

```typescript
// app/page.tsx:21-25
function monitoringState(status: FeedStatus): StepState {
  if (status === 'loading') return 'active';
  if (status === 'error')   return 'error';
  return 'complete';  // loaded | empty
}
```

Every re-render, this recomputes from the current status. The stepper doesn't own the status; the hook does. The mapping is what makes the tier "swap its stub" — `pending` → `active` → `complete` as the fetch progresses.

```
  Layers-and-hops — status → step-state → visual badge

  ┌─ useBriefingStream (owns status) ──────────────────────────┐
  │   status: 'loading' | 'loaded' | 'empty' | 'error'          │
  └────────────────────────┬────────────────────────────────────┘
                           │  hop 1: read from hook return
                           ▼
  ┌─ app/page.tsx:270-272 ────────────────────────────────────┐
  │   monitoringState(status) → 'active' | 'complete' | 'error' │
  │   monitoringSub(status, stepStatus, queryCount, count)      │
  └────────────────────────┬────────────────────────────────────┘
                           │  hop 2: props into ProcessStepper
                           ▼
  ┌─ components/shared/ProcessStepper.tsx:66-137 ─────────────┐
  │   badge(state): green ✓ | teal (active + pulse) | grey ○   │
  │   label color / sub color per state                        │
  └────────────────────────────────────────────────────────────┘
```

The stepper is dumb: give it three inputs, it renders three steps. All the "loading vs done" logic lives in the page-level mapping function.

**What breaks if this tier is missing:** the user has no top-level indication of *which* of the three pipeline stages is currently running. They see individual sub-regions update but no overall progress rail.

#### Tier 2 — the CoverageGrid (accumulator with pending fill)

The category list is fixed at 10 (`lib/agents/categories`). The stream reports `coverage_item` events one at a time as the gate agent checks each category — coverage tiles fill in progressively while unfilled ones render as pending skeletons.

The key move is in the render logic (`components/feed/CoverageGrid.tsx:61-75`):

```typescript
export default function CoverageGrid({ coverage, insights, loading = false }: CoverageGridProps) {
  if ((!coverage || coverage.length === 0) && !loading) return null;   // idle: hide entirely

  const byCat = new Map(coverage.map((c) => [c.category, c]));         // reported so far
  // ...
  const checked = coverage.length;                                     // grows 0 → 10
  const settling = loading && checked < CATEGORIES.length;             // still filling?
```

Then the grid walks `CATEGORIES` (the fixed 10) and, for each, checks `byCat.has(category)`. Reported → real tile with icon + label + severity. Not reported yet, still loading → pending skeleton tile. The counter at the top ticks up as `checked/10` (`components/feed/CoverageGrid.tsx:99`).

The accumulator on the streaming side is one line in the hook:

```typescript
// lib/hooks/useBriefingStream.ts:220-224
case 'coverage_item':
  setCoverage((prev) =>
    prev.some((c) => c.category === evt.item.category) ? prev : [...prev, evt.item],
  );
  break;
```

Idempotent append — if the category is already in the list (server retried, whatever), skip.

```
  Pattern — 10 fixed slots, N ≤ 10 fill in over time

    initial:  [ □ □ □ □ □ □ □ □ □ □ ]       ← all pending
              coverage.length = 0

    after e1: [ ■ □ □ □ □ □ □ □ □ □ ]       ← one filled
              coverage = [{category:'conversion_drop', …}]

    after e5: [ ■ ■ ■ ■ ■ □ □ □ □ □ ]       ← half filled
              coverage.length = 5

    after e10: [ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ]      ← all filled
               coverage.length = 10; settling flips false
```

**What breaks if this tier is missing:** the user has no evidence the agent is even checking the categories it claims to check. When the final result set has 2 anomalies, they wonder about the other 8. The grid answers: 10 checked, 8 clean, 2 firing.

#### Tier 3 — the card slot (binary swap: skeleton stack ↔ real cards)

The card slot is the simplest — it's a `status`-driven ternary between two children. Loading? Four fixed-height `Skeleton` boxes. Loaded? The insights. Error? The error panel. Empty? An empty-state line.

```typescript
// app/page.tsx:334-341 (loading)
{status === 'loading' && !reconnectPolicy.reconnecting && (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <Skeleton height={96} />
    <Skeleton height={96} />
    <Skeleton height={96} />
    <Skeleton height={96} />
  </div>
)}
```

```typescript
// app/page.tsx:404-410 (loaded)
{status === 'loaded' && (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    {insights.map((insight) => (
      <InsightCard key={insight.id} insight={insight} />
    ))}
  </div>
)}
```

Four skeletons at 96px each = same visual height as four typical InsightCards. When `status` flips to `'loaded'`, the skeletons unmount and the cards mount in the same slot. Visual continuity: the section doesn't jump.

**What breaks if this tier is missing:** the section between the grid and the trace goes empty during loading. The user has no reservation-of-space cue and any layout below (there's none here, but in a longer page) would jump.

#### Tier 4 — the ReasoningTrace (grows unbounded, appended per event)

The trace is the load-bearing "shows its work" surface. Every `reasoning_step` and `tool_call_start`/`tool_call_end` event pushes an item. Reasoning steps show thoughts / hypotheses / conclusions with agent badges. Tool calls show name + status (running / done) + result.

The append is one line per event (`lib/hooks/useBriefingStream.ts:229-273`):

```typescript
case 'tool_call_start':
  setQueryCount((n) => n + 1);
  setTraceItems((prev) => [
    ...prev,
    { kind: 'tool', id: crypto.randomUUID(), toolName: evt.toolName,
      status: 'running', ts: Date.now() },
  ]);
  break;

case 'reasoning_step': {
  const { content, id, kind } = evt.step;
  if (content) {
    setStepStatus(content);   // ← also drives the stepper's sub-line
    setTraceItems((prev) => [
      ...prev,
      { kind: 'step', id: id ?? crypto.randomUUID(),
        agent: 'monitoring', stepKind: (kind as any) ?? 'thought',
        content, ts: Date.now() },
    ]);
  }
  break;
}

case 'tool_call_end':
  setTraceItems((prev) => {                     // ← find the matching 'running' → flip
    const next = [...prev];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].kind === 'tool' && next[i].toolName === evt.toolName
          && next[i].status === 'running') {
        next[i] = { ...next[i], status: 'done', durationMs: evt.durationMs,
                    result: evt.result, error: evt.error };
        break;
      }
    }
    return next;
  });
  break;
```

`tool_call_end` deserves attention: it doesn't append; it finds the most recent matching `running` tool item and flips it in place. This is why the same tool call appears once (starts → running → done), not twice.

The trace renders in `components/investigation/ReasoningTrace.tsx:52-107` — flat list, one child per item, `key={item.id}`. Empty state ("connecting to the agent…") is rendered by the parent in `app/page.tsx:475-506` when `traceItems.length === 0 && status === 'loading'`.

```
  Skeleton — the trace-item accumulator

    prev = []
    event 'tool_call_start'  { toolName: 'get_metrics' }
      → prev = [{ kind:'tool', toolName:'get_metrics', status:'running' }]

    event 'reasoning_step'   { kind:'thought', content:'checking...' }
      → prev = [ tool(running), step(thought) ]

    event 'tool_call_end'    { toolName:'get_metrics', durationMs: 342 }
      → walk backwards, find matching running tool, flip to done:
        prev = [ tool(done, 342ms), step(thought) ]
```

**What breaks if this tier is missing:** the whole "shows its work" pitch is invisible. This is the tier flagged as R1 in the audit — it works visually but has no `aria-live`, so it's invisible to assistive tech. See `audit.md`.

#### The composition — how the page wires all four

The load-bearing composition happens in ~40 lines of `app/page.tsx:268-341`:

```typescript
// tier 1 — stepper, derived state
<ProcessStepper
  monitoring={{
    state: monitoringState(status),
    sub: monitoringSub(status, stepStatus, queryCount, insights.length),
  }}
  diagnostic={{ state: 'pending', sub: 'opens when you investigate' }}
  recommendation={{ state: 'pending', sub: 'opens when you investigate' }}
/>

// tier 2 — coverage grid, accumulator with loading flag
<CoverageGrid
  coverage={coverage}
  insights={insights}
  loading={status === 'loading' && !reconnectPolicy.reconnecting}
/>

// tier 3 — the card slot, ternary swap
{status === 'loading' && !reconnectPolicy.reconnecting && (
  <>{[0,1,2,3].map(i => <Skeleton key={i} height={96} />)}</>
)}
{status === 'error' && <ErrorPanel /* ... */ />}
{status === 'empty' && <p>no notable changes right now</p>}
{status === 'loaded' && insights.map(insight => <InsightCard key={insight.id} insight={insight} />)}

// tier 4 — trace (in a sidebar aside)
{traceItems.length > 0 ? (
  <ReasoningTrace items={traceItems} />
) : status === 'loading' ? (
  <p>connecting to the agent…</p>
) : (
  <p>-- the agent's query-by-query trace…</p>
)}
```

Each tier reads a different slice of the hook return. Each tier has its own placeholder logic. Each tier updates independently as its source data changes. No shared "isLoading" flag; no orchestrator; no `<Suspense>`. Four independent tiers, one shared streaming hook.

### Move 3 — the principle

**Split the "loading" state into as many sub-states as the stream has stages.** A single spinner tells the user *something* is happening. A four-tier progressive UI tells the user *what* is happening at every moment: stepper says "monitoring," grid says "5 of 10 categories checked," card slot reserves space for 4 results, trace says "just called `get_metrics`." Each tier is dumb on its own — a stub + a swap. The composition is what makes the page feel alive.

Generalization: whenever your stream has typed events, give each event type its own dedicated UI region with its own placeholder. Don't fold multiple streams into one giant `<Suspense>` boundary — you lose the granularity that makes progressive rendering worth doing.

## Primary diagram

```
  Progressive feed — 4 tiers, 4 seams, 1 stream

  ┌─ stream events (from server route via readNdjson) ─────────────────┐
  │  workspace  →  coverage_item×N  →  reasoning_step×N  →              │
  │  tool_call_start / tool_call_end×N  →  insight×N  →  done           │
  └───────────┬───────────────┬────────────────┬──────────────┬─────────┘
              │               │                 │              │
              │               │                 │              │
    ┌─────────▼──────┐  ┌────▼────┐  ┌─────────▼──────┐  ┌────▼─────┐
    │ status derive  │  │ setCove-│  │ setStepStatus  │  │ collected│
    │ 'loading' →    │  │ rage(   │  │ setTraceItems  │  │ .push    │
    │ 'loaded' at    │  │ append) │  │ (append)       │  │ at 'done'│
    │ 'done'         │  │         │  │                │  │ setState │
    └─────────┬──────┘  └────┬────┘  └───────┬────────┘  └────┬─────┘
              │              │                │                │
              ▼              ▼                ▼                ▼
    ┌────────────────┐ ┌───────────┐  ┌────────────────┐ ┌──────────────┐
    │ tier 1         │ │ tier 2    │  │ tier 4         │ │ tier 3       │
    │ ProcessStepper │ │ Coverage  │  │ ReasoningTrace │ │ card slot    │
    │ 3 fixed slots  │ │ Grid      │  │ empty → grows  │ │ 4 skeletons  │
    │ monitoring ●   │ │ 10 tiles  │  │ per event      │ │  → N cards   │
    │ diagnostic ○   │ │ N filled  │  │                │ │              │
    │ recommendation○│ │ N pending │  │                │ │              │
    └────────────────┘ └───────────┘  └────────────────┘ └──────────────┘

  four regions, four seams, four different setStates, one shared stream
```

## Elaborate

**Where this pattern comes from.** Skeleton screens go back to Luke Wroblewski's 2013 posts; Facebook and LinkedIn made them ubiquitous by 2016. The modern React shape is *streaming SSR handoff* — the server sends the page shell with `<Suspense>` fallbacks; each fallback resolves as its data streams in. This repo doesn't use that specific mechanism (no SSR handoff for the streaming data), but the *pattern* is the same: keep the shape, fill in the content.

The 4-tier granularity here goes further than typical skeleton screens. Most apps have one region-wide skeleton and swap it for the content. Splitting into four independent regions, each keyed to a different stream event, is what makes the streaming pitch visible.

**How it connects to adjacent concepts.**

  - Each tier's placeholder → real swap is a discriminated switch on FeedStatus or an array length. See `01-ndjson-stream-reader-hook.md` for the events that drive the switches.
  - `tool_call_end`'s "find-and-flip" pattern is close to *optimistic updates with rollback* except there's no rollback — the tool call has already happened server-side; we're just reflecting its state change.
  - The stepper's derived-state approach (pure function from status) is textbook "derived state, don't stash it" — see the state-architecture lens in `audit.md`.

**What could earn its place next.** An `aria-live="polite"` on the trace (see `audit.md` R1). Route-level `<Suspense>` would be overkill for this many independent tiers — this repo's fine-grained pattern is a better fit for streaming NDJSON.

## Interview defense

### Q1 — Why four independent tiers instead of one big `<Suspense>`?

Different events matter for different regions. A single boundary would either wait for all events (losing the whole progressive story) or resolve on the first event (leaving three regions still empty). Independent tiers let each region react to its own slice — stepper reacts to fetch status, grid reacts to `coverage_item`, cards react to `done`, trace reacts to every reasoning + tool event.

```
  Comparison — one boundary vs four tiers

  <Suspense fallback>:                    4 independent tiers:

    ▓▓▓▓▓ (one fallback for everything)    ● 1 · loading
    ▓▓▓▓▓                                  [ 3 filled, 7 pending ]
    ▓▓▓▓▓                                  ▭ ▭ ▭ ▭
    ▓▓▓▓▓                                  • thought: scan…
                                           • tool: get_metrics
    → resolves once  → all-at-once flash   → each region updates
                                              independently
```

**Anchor.** `app/page.tsx:268-341` (composition); `lib/hooks/useBriefingStream.ts:215-297` (the switch that drives each tier).

### Q2 — The load-bearing part everyone forgets on this pattern

**Reserving the shape.** A skeleton that's smaller than the real content still lets the surrounding page jump when the swap happens. The four Skeletons at `height={96}` are the same visual height as four typical InsightCards, so the layout below doesn't shift on the flip. Same logic for the 10 pending tiles in the grid — 10 tiles rendered, 10 slots reserved, filled tiles slot in where the pending ones were.

```
  Shape reservation — same footprint before and after

    loading:                        loaded:
    ┌──────────────┐               ┌──────────────┐
    │ ▭ 96px       │               │ ▪ Card       │
    ├──────────────┤               ├──────────────┤
    │ ▭ 96px       │               │ ▪ Card       │
    ├──────────────┤    → swap →   ├──────────────┤
    │ ▭ 96px       │               │ ▪ Card       │
    ├──────────────┤               ├──────────────┤
    │ ▭ 96px       │               │ ▪ Card       │
    └──────────────┘               └──────────────┘

    total height: identical → no jump
```

**Anchor.** `app/page.tsx:334-341`. Grid's fixed-10 logic: `components/feed/CoverageGrid.tsx:74, 79-108`.

### Q3 — How is `tool_call_end` implemented and why?

It's not an append — it's a find-and-flip. Walk `traceItems` from the end backwards, find the first `tool` item with a matching `toolName` and `status: 'running'`, replace it in place with `status: 'done' + durationMs + result`. Otherwise you'd have two entries for the same call (start + end) instead of one that transitions.

```
  Find-and-flip — the tool-call lifecycle in one row

    start event  → append { toolName, status:'running' }
                   trace = [ ..., tool(get_metrics, running) ]

    end event    → walk backwards, find matching running, patch in place
                   trace = [ ..., tool(get_metrics, done, 342ms) ]
```

**Anchor.** `lib/hooks/useBriefingStream.ts:255-272` (briefing); `lib/hooks/useInvestigation.ts:88-97` (investigation, same pattern).

### Q4 — What's missing from this pattern in this repo (name the gap)?

The trace has no `aria-live`. Visually, items stream in and fade up nicely. To a screen reader, the DOM changes but no announcement fires; the assistive tech gets the same static snapshot from mount time. The fix is one attribute (`aria-live="polite"` + `role="log"`) on `ReasoningTrace`'s container `<div>` at `components/investigation/ReasoningTrace.tsx:52-63`. Named as R1 in the audit — top-ranked risk because the whole "shows its work" pitch is invisible to the users who most need real-time feedback.

**Anchor.** `components/investigation/ReasoningTrace.tsx:52-63`. Audit finding: `audit.md` → `frontend-red-flags-audit` R1.

## See also

  - `01-ndjson-stream-reader-hook.md` — the kernel that produces the events each tier consumes.
  - `03-settings-modal-with-localstorage-persistence.md` — the modal that gates which server the stream talks to.
  - `audit.md` → `frontend-red-flags-audit` R1 — the aria-live gap.
  - `audit.md` → `state-architecture` — how the streaming hook owns the tier-driving state.
  - Cross-guide: FCP / LCP measurement of the skeleton-to-content swap → `study-performance-engineering`.
