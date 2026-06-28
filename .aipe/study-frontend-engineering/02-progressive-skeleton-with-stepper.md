# Progressive Skeleton With Stepper

**Industry names:** progressive disclosure, shape-mirroring skeletons, optimistic UI for streams, perceived-performance composition. **Type:** Industry-standard pattern, project-specific 4-tier composition.

## Zoom out, then zoom in

You already know what a skeleton loader is — that gray pulsing box that holds layout while data loads. The default React pattern is "render `<Skeleton />` while `isLoading`, swap to real content when the data arrives." That works for a 200ms `fetch + json()`. It does not work for **30-90 seconds of agent reasoning**.

If you only render one skeleton for the whole investigation and swap it for the result, the user stares at a pulsing rectangle for a minute. The product narrative — "an analyst that shows its work" — needs a UI that *animates with the work*. You can't fake it with a longer skeleton; you have to compose **four tiers** that each fill in independently as data lands.

```
  Zoom out — where the 4-tier composition lives in the system

  ┌─ UI layer (browser) ───────────────────────────────────────────────────┐
  │                                                                        │
  │  app/page.tsx              app/investigate/[id]/page.tsx               │
  │       │                          │                                     │
  │       └─────── composes ─────────┘                                     │
  │                       │                                                │
  │                       ▼                                                │
  │   ┌─ TIER 1 (~0ms) ─────────────────────────────────────────────┐      │
  │   │  static shell: header, layout grid, ★ ProcessStepper ★      │      │
  │   └─────────────────────────────────────────────────────────────┘      │
  │   ┌─ TIER 2 (~100ms) ───────────────────────────────────────────┐      │
  │   │  ★ Skeleton ★ × N — shape-mirror the cards/diagnosis        │      │
  │   └─────────────────────────────────────────────────────────────┘      │
  │   ┌─ TIER 3 (continuous) ───────────────────────────────────────┐      │
  │   │  ★ CoverageGrid ★ — 10 tiles stream in one at a time;       │      │
  │   │  ★ StatusLog ★ — trace items animate per fade-up keyframe   │      │
  │   └─────────────────────────────────────────────────────────────┘      │
  │   ┌─ TIER 4 (on done) ──────────────────────────────────────────┐      │
  │   │  real cards / EvidencePanel / RecommendationCard — bi-fade-up│     │
  │   └─────────────────────────────────────────────────────────────┘      │
  │                       ▲                                                │
  │                       │ state updates from the streaming hooks         │
  │   useBriefingStream / useInvestigation (see 01-ndjson-stream-...)      │
  │                                                                        │
  └────────────────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **four independent visual tiers, each filling in on its own timeline, each shape-mirroring its eventual content so the layout never shifts.** Tier 1 paints from the static markup. Tier 2 paints as soon as the hook reports `status === 'loading'`. Tier 3 paints once per arriving event. Tier 4 swaps in when the result arrives. The user perceives "always something moving."

## Structure pass

Three layers, one axis — **how much does this surface know about the underlying data?** — traced across the tiers.

**Layer 1: the static shell.** Knows: nothing about the data. The header text, the layout grid, the page width — all encoded at render time from constants in the page component. `ProcessStepper` *almost* belongs here; it's static markup with three steps and accepts state props per step. Renders during the first React commit, before any effect runs.

**Layer 2: the shape-mirroring skeletons.** Knows: the *shape* of the data, not the data. `Skeleton` (18 LOC, one rectangle) is dumb; `RecommendationCardSkeleton` (71 LOC) is deliberately laid out as the shape of `RecommendationCard` — same feature-chip box, same title block, same expected-impact callout, same three-up tile row — so when the real data swaps in, no layout shifts. The "loading" branch in `EvidencePanel.tsx:62-99` does the same thing for the diagnosis card.

**Layer 3: the progressive surfaces.** Know: data as it arrives. `CoverageGrid` accepts a `coverage` array that starts empty and grows; each tile renders based on whether its category has been reported yet (pending → live). `StatusLog` accepts a growing `items` array; each new item animates in via `bi-fade-up`. Neither surface waits for a `done` signal — they render at every state change.

**Layer 4: the finalized content.** Knows: the complete result. Renders only when `status === 'loaded'` (feed) or `complete && diagnosis` (investigation). The handoff from tier 2 (skeleton) to tier 4 (real content) is a conditional render in the page; the handoff from tier 3 (progressive surface) is a continuous animation — same component, new data.

**The seams.** The interesting one is between tier 2 and tier 4 — the shape-mirroring contract. If `RecommendationCardSkeleton`'s layout drifts from `RecommendationCard`'s layout, the swap-in causes a visual jump. That contract is enforced by *eyeball* (look at them side-by-side), not by code — there's no shared layout primitive. That's a known fragility; see lens 8.5 in `audit.md`.

```
  Axis traced — "how much does this surface know about the data?"

  tier 1  static shell           → NOTHING (just markup)
                       │
                       │ axis answer flips: now knows shape, not data
                       ▼
  tier 2  shape-mirror skeletons → SHAPE OF DATA
                       │
                       │ axis answer flips: now knows partial data
                       ▼
  tier 3  progressive surfaces   → DATA AS IT ARRIVES (event-by-event)
                       │
                       │ axis answer flips: now knows complete data
                       ▼
  tier 4  finalized content      → COMPLETE DATA

  each tier-boundary is a seam — a contract about WHEN this surface
  renders and WHAT it needs to know to render
```

## How it works

The pattern's shape first, then a walk through each tier.

### Move 1 — the mental model

You've built loading states before — `if (loading) return <Skeleton />; return <Content data={data} />`. That's a *one-tier* pattern: nothing → skeleton → content. For a 200ms fetch it's fine. The mental model here: **stack more tiers**, each one running on its own clock.

```
  The 4-tier pattern shape — time on the x-axis

  visible content
       ▲
  100% │                                          ┌──────── tier 4 ─►
       │                                          │  real cards
       │                                          │
   75% │                              ┌───────────┘
       │                              │   tier 3 (progressive)
       │              ┌───────────────┘   CoverageGrid + StatusLog
   50% │              │                   filling tile-by-tile,
       │              │                   line-by-line
       │              │ tier 2 (skeletons shaped like the result)
   25% │     ┌────────┘
       │     │ tier 1 (static shell + ProcessStepper)
       │     │
     0 └─────┴──────────────────────────────────────────────────►
        0ms  100ms                  ~5-90s             done

  the user perceives "always something happening" because some tier
  is always the first to paint and another is filling in behind it
```

The bridge from what you know: a single-skeleton loading state is a **step function** (0 → 100% at the `done` event). This is a **staircase** with four steps, each riding on a different signal. The signal stack is what makes it work — the `status === 'loading'` boolean for tier 2, individual stream events for tier 3, `status === 'loaded'` for tier 4.

### Move 2 — the step-by-step walkthrough

#### Tier 1 — the static shell + `ProcessStepper`

Paints on the first React commit. Zero data dependencies. The shell is just markup in the page:

```ts
// app/page.tsx:120-156
<main className="min-h-screen px-6 py-10 mx-auto w-full max-w-5xl" ...>
  <div style={{ marginBottom: 32 }}>
    <h1>blooming insights</h1>
    <p>your workspace, in bloom</p>
    {workspace?.projectName && <p>{workspace.projectName.toLowerCase()} · ...</p>}
    {/* mode toggle */}
  </div>
  <ProcessStepper
    monitoring={{ state: monitoringState(status), sub: monitoringSub(...) }}
    diagnostic={{ state: 'pending', sub: 'opens when you investigate' }}
    recommendation={{ state: 'pending', sub: 'opens when you investigate' }}
  />
```

`ProcessStepper` (`components/shared/ProcessStepper.tsx`, 138 LOC) is the load-bearing component of tier 1. It always renders all three steps regardless of state — the visual difference comes from the per-step `state` prop:

```ts
// components/shared/ProcessStepper.tsx:47-64
function badgeStyle(state: StepState): CSSProperties {
  const base: CSSProperties = { width: 22, height: 22, borderRadius: '50%', ... };
  if (state === 'complete' || state === 'active')
    return { ...base, background: 'var(--accent-teal)', color: 'var(--bg-base)' };
  if (state === 'error')
    return { ...base, background: 'var(--accent-coral)', color: 'var(--bg-base)' };
  return { ...base, border: '1px solid var(--border)', color: 'var(--text-tertiary)' };
}
```

The badge content (`✓` vs `!` vs the step number) and the pulse animation are driven by state:

```ts
// components/shared/ProcessStepper.tsx:107-113
<span aria-hidden
  className={state === 'active' ? 'animate-pulse' : undefined}
  style={badgeStyle(state)}>
  {state === 'complete' ? '✓' : state === 'error' ? '!' : i + 1}
</span>
```

The pulse on `active` is the **first signal of motion the user sees**. It paints in the same frame as the static shell — sub-100ms — and it tells the user "the system is working" before any data has arrived.

The **stepper-as-router** detail: each step's `href` prop is optional. When provided, the step renders as a `next/link`; the active step never gets `href` (you're already there). This turns the status bar itself into the cross-step navigation:

```ts
// app/investigate/[id]/page.tsx:115-119
<ProcessStepper
  monitoring={{ state: 'complete', sub: 'change detected', href: '/' }}
  diagnostic={{ state: diagState, sub: diagSub }}
  recommendation={{ state: recState, sub: recSub,
                    href: diagnosisReady ? recommendHref : undefined }}
/>
```

#### Tier 2 — the shape-mirroring skeletons

Paint as soon as the streaming hook reports `loading`. The page renders 4 stacked `<Skeleton height={96} />` blocks for the feed:

```ts
// app/page.tsx:277-285
{status === 'loading' && !reconnectPolicy.reconnecting && (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <Skeleton height={96} />
    <Skeleton height={96} />
    <Skeleton height={96} />
    <Skeleton height={96} />
  </div>
)}
```

`Skeleton` itself is the minimum-viable primitive (`components/shared/Skeleton.tsx`, 18 LOC):

```ts
export default function Skeleton({ height = 80, width = '100%' }: SkeletonProps) {
  return (
    <div className="animate-pulse" style={{
      background: 'var(--bg-surface)',
      borderRadius: 4,
      height, width,
    }} />
  );
}
```

The height is hand-picked to match an actual `InsightCard` (~96px) so when the cards swap in, the column height doesn't jump.

The richer version of this pattern is `RecommendationCardSkeleton` (`components/investigation/RecommendationCardSkeleton.tsx`, 71 LOC). It's not one rectangle — it's a **scaffold** that mirrors the shape of the real card:

```ts
// components/investigation/RecommendationCardSkeleton.tsx:20-69
<div aria-hidden style={cardStyle}>
  {/* top row: feature chip · position · confidence */}
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
    <Skeleton height={18} width={72} />
    <Skeleton height={14} width={96} />
    <span style={{ marginLeft: 'auto' }}><Skeleton height={14} width={104} /></span>
  </div>
  {/* title + rationale */}
  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
    <Skeleton height={16} width="70%" />
    <Skeleton height={12} />
    <Skeleton height={12} width="85%" />
  </div>
  {/* expected-impact box */}
  <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', ... }}>
    <Skeleton height={10} width={88} />
    <Skeleton height={16} width="55%" />
  </div>
  {/* effort · time to set up · read result in */}
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
    <div style={tile}><Skeleton height={10} width={44} /><Skeleton height={14} width="60%" /></div>
    <div style={tile}><Skeleton height={10} width={64} /><Skeleton height={14} width="50%" /></div>
    <div style={tile}><Skeleton height={10} width={68} /><Skeleton height={14} width="50%" /></div>
  </div>
</div>
```

Compare side by side with `RecommendationCard` (`components/investigation/RecommendationCard.tsx:74-238`):

| skeleton block | matches card block | LOC in card |
|----------------|-------------------|-------------|
| feature chip + position + confidence row | `top row: feature chip + position/highest + confidence` | L80-107 |
| title + rationale | `title` + `rationale` | L110-126 |
| expected-impact box | `expected impact — highlighted, with the assumption` | L129-152 |
| 3-up effort / time / read-result tiles | `effort · time to set up · read result in` | L155-170 |

Same boxes, same gaps, same grid. The skeleton's `aria-hidden` flag (`RecommendationCardSkeleton.tsx:18`) tells screen readers to skip it — only sighted users see this tier; the a11y story for the stream lives in tier 3.

The same shape-mirroring pattern repeats in `EvidencePanel`'s loading branch (`components/investigation/EvidencePanel.tsx:62-99`) — a confidence tile, a customers-affected tile, the conclusion callout, two hypothesis rows, all as skeletons sized to match the real diagnosis.

**What breaks if you skip the shape mirror.** A generic `<Skeleton height={400} />` placeholder works *if* the real card is exactly 400px. The moment the card's height drifts (because the conclusion is two lines instead of three, because the prerequisites section appears), the swap-in shifts the layout and the user's eye loses the position. Shape-mirroring trades skeleton complexity for layout stability.

#### Tier 3 — the progressive surfaces

Paint at every state change, not just at `done`. Two surfaces own this tier: `CoverageGrid` (the 10-category tile grid) and `StatusLog` (the streaming trace sidebar).

**`CoverageGrid` — tiles stream in one at a time.** The grid receives a `coverage` array that starts empty and grows as the briefing emits `coverage_item` events:

```ts
// lib/hooks/useBriefingStream.ts:209-213
case 'coverage_item':
  // accumulate one tile at a time → the grid fills progressively
  setCoverage((prev) =>
    prev.some((c) => c.category === evt.item.category) ? prev : [...prev, evt.item],
  );
  break;
```

The grid renders **all 10 categories every render**, but a category that hasn't been reported yet renders a *pending tile* (a third skeleton variant — animated, opacity 0.5, "checking…" label):

```ts
// components/feed/CoverageGrid.tsx:123-153
{CATEGORIES.map((cat) => {
  const report = byCat.get(cat.id);
  // ...
  // ── pending tile — gate hasn't reported this category yet ──
  if (!report && loading) {
    return (
      <div key={cat.id} className="animate-pulse" style={{...}}>
        <div style={{...}}>
          <span style={{...}}>
            <Icon size={13} color="var(--text-tertiary)" />
          </span>
          <span style={{ ...microMono, color: 'var(--text-tertiary)' }}>checking…</span>
        </div>
        <div style={{ ...labelMono, color: 'var(--text-tertiary)' }}>{cat.label}</div>
        <div style={{ marginTop: 'auto' }}><Skeleton height={9} width="80%" /></div>
      </div>
    );
  }
  // ... live tile renders here
})}
```

The header counts (`monitored`, `firing`, `skipped`) tick up as tiles stream in (`CoverageGrid.tsx:71-74, 93-101`). The user watches a real progress signal — "checking 3/10…", "checking 7/10…" — not a single indeterminate spinner.

**`StatusLog` — trace items animate per fade-up keyframe.** The sidebar receives a `traceItems` array that grows per `reasoning_step` / `tool_call_start` / `tool_call_end` event. The header shows query count + "running…" + an indeterminate progress bar:

```ts
// components/shared/StatusLog.tsx:48-67
<div className="lowercase" style={{...}}>
  {title}
  {countLabel ? ` · ${countLabel}` : ''}
  {scanning ? ' · running…' : ''}
  {scanning && <div className="bi-progress" style={{ marginTop: 8 }} aria-hidden />}
</div>
```

`bi-progress` is the indeterminate bar keyframe (`app/globals.css:44-65`):

```css
@keyframes bi-indeterminate {
  0%   { left: -40%; width: 40%; }
  50%  { left: 25%;  width: 50%; }
  100% { left: 100%; width: 40%; }
}
.bi-progress { position: relative; height: 2px; overflow: hidden; ... }
.bi-progress::after {
  content: ''; position: absolute; top: 0; height: 100%;
  background: var(--accent-teal); border-radius: 2px;
  animation: bi-indeterminate 1.2s ease-in-out infinite;
}
```

The empty state — `items.length === 0 && scanning` — shows pulsing dots (`bi-dots`, `app/globals.css:67-76`) so the sidebar feels alive *before the first event arrives*:

```ts
// components/shared/StatusLog.tsx:69-83
{items.length > 0 ? (
  <ReasoningTrace items={items} />
) : (
  <p className="lowercase" style={{...}}>
    {emptyMessage}
    {scanning && (
      <span className="bi-dots" aria-hidden style={{ display: 'inline-flex', gap: 2 }}>
        <span>·</span><span>·</span><span>·</span>
      </span>
    )}
  </p>
)}
```

Each arriving trace item gets the `bi-fade-up` animation:

```ts
// components/investigation/ReasoningTrace.tsx:64-67, 94-95
{items.map((item) =>
  item.kind === 'step' ? (
    <div key={item.id} className="bi-fade-up"> ... </div>
  ) : (
    <div key={item.id} className="bi-fade-up"> ... </div>
  ),
)}
```

`bi-fade-up` (`app/globals.css:37-42`) is `opacity: 0 → 1` + `translateY(8px) → 0` over 400ms. Each item slides up into place; the eye reads it as "the agent just said this."

**All three animations are gated on `prefers-reduced-motion`.** Users with motion sensitivity get the same content with no movement (`globals.css:42, 78-80`).

#### Tier 4 — the finalized content

Renders only when the stream completes. The handoff from tier 2 (skeleton) to tier 4 (real cards) is one conditional in the page:

```ts
// app/page.tsx:348-354
{status === 'loaded' && (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
    {insights.map((insight) => (
      <InsightCard key={insight.id} insight={insight} />
    ))}
  </div>
)}
```

`InsightCard` itself uses `bi-fade-up` (`InsightCard.tsx:179`) so the cards animate in rather than pop. The skeleton was at the same column, same vertical position, same height; the swap is a 400ms fade rather than a layout shift.

On the investigation page, the handoff happens **per-section**: `EvidencePanel` swaps its skeleton for the diagnosis card the moment `diagnosis !== null`, even if more events are still arriving for the sidebar:

```ts
// app/investigate/[id]/page.tsx:150
<EvidencePanel diagnosis={diagnosis} loading={streaming} />
```

```ts
// components/investigation/EvidencePanel.tsx:48-101
export default function EvidencePanel({ diagnosis, loading }: EvidencePanelProps) {
  if (!diagnosis) {
    if (!loading) return <div>no diagnosis yet</div>;
    return /* skeleton shaped like the diagnosis */;
  }
  // ... real diagnosis card
}
```

The streaming hook sets `diagnosis` from the `'diagnosis'` event arm — which fires *before* `done`. So the user sees the conclusion as soon as the diagnostic agent commits to one, while the sidebar continues to fill in the supporting steps.

#### Layers-and-hops — one streaming briefing through the 4 tiers

```
  Layers-and-hops — what travels and which direction, per tier

  t=0ms                                                              t=done
   │                                                                   │
   ▼                                                                   ▼

  ┌─ Browser ───────────────────────────────────────────────────────────────┐
  │                                                                         │
  │  TIER 1 ──► static shell + ProcessStepper(active pulse on monitoring)   │
  │  ▲                                                                      │
  │  │ first React commit                                                   │
  │  │                                                                      │
  │  TIER 2 ──► 4× <Skeleton height={96} /> + CoverageGrid pending tiles    │
  │  ▲                                                                      │
  │  │ status === 'loading' on first hook render                            │
  │  │                                                                      │
  │  TIER 3 ──► CoverageGrid tiles fill in as events arrive ──┐             │
  │             StatusLog items fade-up as events arrive      │             │
  │  ▲                                                        │             │
  │  │ setCoverage / setTraceItems per event                  │             │
  │  │                                                        │             │
  │  TIER 4 ──► <InsightCard /> × N, bi-fade-up               │             │
  │  ▲                                                        │             │
  │  │ status === 'loaded' on 'done' event                    │             │
  │                                                           │             │
  │   ┌────────────────────────────────────────────────────┐  │             │
  │   │  readNdjson kernel — see 01-ndjson-stream-reader   │  │             │
  │   │  emits: workspace, coverage_item × N, tool_call_*  │◄─┘             │
  │   │         reasoning_step × N, insight × N, done      │                │
  │   └──────────────────────────┬─────────────────────────┘                │
  │                              │ HTTP/1.1 chunked ndjson                  │
  └──────────────────────────────┼──────────────────────────────────────────┘
                                 ▼
                              service layer (briefing route)

  the four tiers paint on four different signals — they never wait for the
  same one
```

### Move 3 — the principle

The pattern that generalizes: **decompose a long wait into independent visual signals and ride each one separately.** When the underlying work is a sequence (events, chunks, agent steps), the UI's visual progress should be a sequence too — not a binary `loading | loaded`. Each tier is bound to a different signal: the static shell to the first paint, the skeleton to the first hook render, the progressive surfaces to each arriving event, the finalized content to the terminal event. The closer your tier-count matches your signal-count, the more the UI feels alive instead of stuck.

The frontend instinct this teaches: **count your signals before you count your loading states.** A single `isLoading` boolean is a tell that you've collapsed every signal into one.

## Primary diagram

Everything Move 2 walked, in one frame.

```
  The full picture — 4 tiers riding 4 signals on the feed page

  signal stack                     visible UI                  bound to
  ════════════                     ══════════                  ════════
                                                              
  first React commit       ───►   header text                  static markup
  (~0ms after navigation)         layout grid                  in app/page.tsx
                                  mode-toggle buttons          
                                  ProcessStepper:              
                                    • monitoring · active ↻    monitoringState(
                                    • diagnostic · pending       status)
                                    • recommendation · pending
                                                              
  ────────────────────────────────────────────────────────────────────────────
                                                              
  hook reports             ───►   CoverageGrid:               useBriefingStream
  status === 'loading'              10× pending tiles          status === 'loading'
  (within a tick)                   ("checking…")             
                                  4× <Skeleton height={96} />  
                                  StatusLog:                   
                                    "connecting…" + bi-dots   
                                                              
  ────────────────────────────────────────────────────────────────────────────
                                                              
  per-event from kernel    ───►   CoverageGrid tile flips:    coverage_item evt
  (NDJSON stream)                   pending → live/firing      
                                  StatusLog item appended:    reasoning_step OR
                                    bi-fade-up animation       tool_call_* evt
                                  Stepper sub text updates:   stepStatus from
                                    "query N · <EQL...>"       reasoning_step
                                                              
  ────────────────────────────────────────────────────────────────────────────
                                                              
  hook reports             ───►   <InsightCard /> × N:        useBriefingStream
  status === 'loaded'               bi-fade-up swap-in         status === 'loaded'
  ('done' event)                  Stepper: monitoring ✓        on 'done' evt
                                  StatusLog: scanning off      
                                                              
  ════════════════════════════════════════════════════════════════════════════
  
  4 signals → 4 tiers → 4 surfaces that animate independently
  layout never shifts because tier 2 sizes match tier 4 sizes
  every animation gates on prefers-reduced-motion
```

## Elaborate

The pattern's roots are older than streaming AI. Facebook's content-loading paper (the original skeleton-screens paper, 2013) made the case for shape-mirroring placeholders over spinners on perceived-performance grounds: a spinner says "wait"; a skeleton says "this is what's coming." LinkedIn extended it with progressive image-loading. The 4-tier composition here is what you get when you apply the same logic to a streaming response instead of a single fetch.

What the React ecosystem normally reaches for here is **Suspense + `loading.tsx`** in the App Router — a single fallback boundary for an awaited resource. Suspense doesn't fit this product because:

1. Suspense models a single promise-resolution, not a sequence
2. `loading.tsx` lives at the route level — there's nowhere to put per-section streaming
3. The data isn't an awaited promise; it's a `ReadableStream` consumed inside an effect

React Query's `placeholderData` is closer — it lets you render shape during a refetch — but it still binds to a request-response shape. NDJSON streams break that contract.

The closest mainstream analog is **shadcn/ui's streaming patterns with React Server Components** — but those depend on RSC, which this app explicitly doesn't use (see `audit.md` lens 1). The pattern here is the framework-free version: hand-composed tiers, no library, every signal explicit in the page or hook.

The pattern most adjacent in your portfolio is **contrl's real-time on-device ML pipeline** (per `me.md`'s system-design portfolio). That has the same shape — a long-running process emitting events (pose-landmark frames at 30fps), the UI bound to each event individually — but rendered inside React Native with worklets-core instead of NDJSON. The underlying principle (signal-per-render, not request-per-render) transfers.

What to read next: the streaming hook itself in `01-ndjson-stream-reader-hook.md` — the events these tiers consume all flow through the kernel walked there.

## Interview defense

**Q: How do you handle a 30-second loading state in a React app?**

Open with the verdict: "Not with a single `<Skeleton />` and a spinner. With four tiers, each bound to a different signal."

```
  whiteboard sketch — 4 tiers, 4 signals

  ───────────────► time
                                                                
  tier 1: static shell + stepper        bound to: first commit  
  tier 2: shape-mirror skeletons        bound to: status===loading
  tier 3: per-event surfaces            bound to: each NDJSON event
  tier 4: finalized content             bound to: status===loaded
                                                                
  the user always sees motion because some tier is always
  the most recent thing to paint
```

Then name the load-bearing part: "Tier 3 is what makes the difference. A coverage tile flipping from 'checking…' to 'anomaly' isn't a loading state — it's content. Same with each trace item fading into the sidebar. The user reads them as 'the agent just discovered this.'"

**Q: Why not use Suspense?**

"Suspense models a single promise-resolution. The data here is a sequence of events arriving over 30-90 seconds, not a single awaited value. `loading.tsx` is route-level — there's nowhere to put per-section streaming. The events are consumed inside a `useEffect` from a `ReadableStream`, which Suspense doesn't subscribe to. The 4-tier composition is what fills that gap."

**Q: How do you keep the layout from shifting when the real data swaps in?**

"Shape-mirroring skeletons. `RecommendationCardSkeleton` is laid out as a deliberate shape-mirror of `RecommendationCard` — same feature chip box, same title block, same expected-impact callout, same 3-up tile row, same gaps. When the real card swaps in, no layout shifts. The skeleton's height matches the card's typical height, hand-tuned."

```
  shape-mirror in action — the skeleton's job

  before swap                      after swap
  ┌──────────────────┐             ┌──────────────────┐
  │ ▭ ▭▭▭ ··········│             │[chip] action 1 of │
  │ ▭▭▭▭▭▭▭▭        │             │ Launch retention  │
  │ ▭▭▭▭▭ ▭▭▭▭     │             │ Win back lapsed   │
  │ ┌─────────────┐ │             │ ┌─────────────┐  │
  │ │ ▭▭▭ ▭▭▭▭▭▭ │ │   ─────►    │ │+$4-7k expected│ │
  │ └─────────────┘ │             │ └─────────────┘  │
  │ ▭▭▭ ▭▭▭▭ ▭▭▭   │             │ low · 5 min · 7d │
  └──────────────────┘             └──────────────────┘
   same box positions               same box positions
   same gaps                        same gaps
                                   → swap is a fade, not a jump
```

"There's a known fragility — the contract between the skeleton's layout and the card's layout is enforced by eyeball, not code. If the card grows a new section, you have to remember to add it to the skeleton too. Documented in the audit."

**Q: What's the role of `ProcessStepper` here?**

"Two roles — it's the only tier-1 element that carries state (the active step pulses), and it doubles as cross-step navigation. Each step accepts an optional `href`; when set, that step renders as a `next/link`. The current step never gets `href`, so it stays inert. The status bar IS the navigation."

**Q: Why do all the animations gate on `prefers-reduced-motion`?**

"Three keyframes — `bi-fade-up` (item entrance), `bi-progress` (indeterminate bar), `bi-dots` (pulsing thinking dots). All three are decorative; users with motion sensitivity get the content without movement. The CSS is `@media (prefers-reduced-motion: reduce) { ... animation: none; }`. It's table stakes; not having it would fail the audit."

**Q: What's the biggest gap in this pattern?**

"The streaming surfaces have no `aria-live` regions. A sighted user sees the trace fade in, the coverage tiles flip, the cards swap; a screen-reader user hears silence for 30-90 seconds. The product narrative — 'an analyst that shows its work' — only works for sighted users today. The fix is a polite `aria-live="polite"` wrap on the `StatusLog` items and on the insight cards container — but it has to be tuned so the coverage grid (10 tiles updating) doesn't chatter. Lens 8 of the audit ranks this as the #1 frontend red flag."

## See also

- `00-overview.md` — the state architecture and network seam diagrams
- `01-ndjson-stream-reader-hook.md` — the events this 4-tier composition consumes; the kernel that delivers them
- `audit.md` lens 1 (rendering & reactivity), lens 3 (component architecture), lens 6 (styling & design system), lens 8.1 (the aria-live gap), lens 8.5 (the skeleton-card layout contract)
- `study-software-design` (sibling guide) — `ProcessStepper` and `Skeleton` as deep modules with thin interfaces
- `study-performance-engineering` (sibling guide) — perceived performance vs measured FCP / LCP
- `study-security` (sibling guide) — the `TraceContent` renderer (used inside `StatusLog`'s `ReasoningTrace`) and its XSS surface
