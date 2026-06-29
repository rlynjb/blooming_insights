# Progressive skeleton with stepper

**Subtitle:** progressive loading + skeleton screens + indeterminate progress (industry-standard perceived-performance pattern), composed as a four-tier reveal across the page. Local terms: the skeleton (`Skeleton`), the process stepper (`ProcessStepper`), the coverage grid (`CoverageGrid`), the status log (`StatusLog`), the fade-in keyframe (`bi-fade-up`).

## Zoom out, then zoom in

**Zoom out — where this concept lives.** Monitoring takes 30-60 seconds. The user is staring at the screen the whole time. Without this pattern they'd be staring at a spinner; with it, they're watching the agent work — the stepper says where in the pipeline we are, the coverage tiles check in one category at a time, the trace fills in line by line, and when an insight finally lands it fades in instead of popping.

```
  Zoom out — where the four reveal surfaces live on one page

  ┌─ UI / app/page.tsx ────────────────────────────────────────────────┐
  │                                                                    │
  │  ┌──────────────────────────────────────────────────────────────┐  │
  │  │ ★ ProcessStepper ★      ① monitoring  ② diagnostic  ③ rec    │  │ ← tier 1
  │  │   "scanning your workspace…" (active step pulses)            │  │
  │  └──────────────────────────────────────────────────────────────┘  │
  │                                                                    │
  │  ┌─ col 1 (2/3) ─────────────────────────────┐ ┌─ col 2 (1/3) ──┐  │
  │  │ ★ CoverageGrid ★                          │ │ ★ StatusLog ★  │  │
  │  │   10 tiles · checking <n>/10…             │ │  bi-progress   │  │ ← tiers 2 + 3
  │  │   [tile][tile][checking…]                 │ │  bi-dots       │  │
  │  │                                           │ │                │  │
  │  │ ★ Skeleton × 4 ★                          │ │  ReasoningTrace│  │ ← tier 4
  │  │   ▒▒▒▒▒▒▒▒▒▒  ← animate-pulse             │ │   line·line·   │  │
  │  │   ▒▒▒▒▒▒▒▒▒▒                              │ │   tool·result  │  │
  │  │                                           │ │                │  │
  │  │ insights ↓ bi-fade-up on each arrival     │ │                │  │
  │  └───────────────────────────────────────────┘ └────────────────┘  │
  └────────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** You know how a `fetch()` UI usually looks: button → spinner → results, with nothing in between? This is the same loading state stretched across four surfaces that each tell a different story while the same network request runs. The pattern is **progressive composition** — instead of one boolean `isLoading` controlling one spinner, you have one `status` driving four different visual treatments, each pulled forward in time as soon as it has anything to show.

The question this concept answers: **how do you make a 30-60-second agent run feel like the system is working the whole time, not just at the start and end?**

## Structure pass

Layers, axis, seams.

### Layers

```
  outer — the page (app/page.tsx)
          owns layout, conditional reveals, the data → UI map

      middle — the four reveal surfaces
               ProcessStepper, CoverageGrid, Skeleton ×4, StatusLog
               (each is its own component, each has its own "I'm loading" shape)

          inner — the per-element entrance animation
                  bi-fade-up keyframe + animate-pulse Tailwind utility
                  (the css that makes the reveal feel intentional)
```

### Axis — perceived time

We trace ONE question down the layers: **what does the user see at t = 200ms, t = 2s, t = 15s, t = 30s?**

```
  Tracing "what does the user see at time t" down the layers

  t = 200ms          t = 2s              t = 15s              t = 30s
  ────────           ─────               ──────               ──────
  outer:
    stepper          ✓     ✓ active        ✓ active (pulsing) ✓ "5 found"
    grid             skeleton tiles      6/10 checked         all 10 in
    col-1 skel       ▒▒▒▒▒▒              ▒▒▒▒▒▒              cards fading in
    sidebar log      "connecting…"       2 tool calls         11 tool calls

  middle:
    Skeleton         animate-pulse       animate-pulse        unmount on loaded
    CoverageGrid     all tiles pending   tiles streaming in   all tiles present
    StatusLog        bi-dots loader      ReasoningTrace rows  scrolling trace
    ProcessStepper   active + pulse      active + pulse       complete (✓ ø)

  inner:
    bi-fade-up       —                   per-row entrance     per-card entrance
    bi-progress      indeterminate bar   indeterminate bar    unmount
    bi-dots          three pulsing dots  three pulsing dots   unmount
```

The pattern's value is in the contrast across columns. At every column the user has something specific to look at.

### Seams

```
  Two seams worth studying

  parent owns status  ═══════════════════ child owns reveal
        │                                       │
        │                                       ▼
        │           seam 1: prop-driven loading
        │           (every reveal surface takes a `loading` /
        │            `scanning` / `status` boolean — the parent
        │            decides; the child decides how to render it)
        │
        ▼
  not-yet-arrived item  ════════════════ arrived item
        │                                       │
        │                                       ▼
            seam 2: per-item bi-fade-up
            (a 400ms CSS animation marks the
             transition between absence and
             presence; with prefers-reduced-motion
             it collapses to a 0ms substitution)
```

Seam 1 is the data flow: `useBriefingStream` reports `status`, the page passes `loading={status === 'loading'}` (or `scanning={!complete}`) to each of the four surfaces, and each one renders its own skeleton variant. Seam 2 is the entrance animation: when `coverage_item` lands in state, the new tile renders with `.bi-fade-up`, which the CSS turns into a `translateY(8px) → translateY(0)` + opacity ramp.

Hand off to How it works.

## How it works

### Move 1 — the mental model

You know how a list of cards usually appears: data arrives → `setState` → all cards render at once. This pattern slows that final step down on purpose, by stacking *four* different loading affordances and revealing them in time order:

```
  The pattern — four tiers staged across the load

  t = 0  ────►  ProcessStepper       "active" — pulse on the badge
                  └─ "scanning your workspace…" sub-line
                CoverageGrid         skeleton tiles  ▒▒▒▒  ▒▒▒▒
                                     "checking 0/10…"
                Skeleton × 4         ▒▒▒▒▒▒▒▒▒▒  (animate-pulse)
                StatusLog            "connecting…" + bi-dots loader
                                     + bi-progress indeterminate bar

  t = 2s ────►  ProcessStepper       (still active)
                CoverageGrid         tile 1 fades in (real)
                                     "checking 1/10…"
                Skeleton × 4         (unchanged)
                StatusLog            row 1: "tool_call_start: list_..."
                                     bi-fade-up entrance

  t = 15s ───►  CoverageGrid         9/10 tiles in, 1 still skeleton
                Skeleton × 4         (unchanged — insights not yet committed)
                StatusLog            8 rows of trace, bi-progress running

  t = 30s ───►  ProcessStepper       "complete" — ✓ "5 changes found"
                CoverageGrid         all 10 tiles, some firing
                Skeleton × 4         unmount
                InsightCard × 5      fade in one at a time
                StatusLog            bi-progress unmounts, trace done
```

That's the staged reveal. Each tier has its own "still loading" shape — they don't all collapse to one spinner.

### Move 2 — step by step

Four moving parts. One sub-heading each. Then the composition at the page level.

#### Part 1 — the process stepper (`ProcessStepper`)

The narrative surface. Three stages identically named on every route — `monitoring anomalies → investigating the issue → decision & recommendation` — so the user always knows where they are in the pipeline. Each step has a state (`pending | active | complete | error`) and a sub-line (the live status text). The active step's badge pulses.

```
  ProcessStepper — three slots, one shared visual contract

  ┌──────────────┬──────────────────┬──────────────────────┐
  │ ① pulsing    │ ② pending        │ ③ pending             │
  │ monitoring   │ investigating    │ decision & rec        │
  │ "scanning…"  │ "opens when…"    │ "opens when…"         │
  └──────────────┴──────────────────┴──────────────────────┘

  same component on:
    app/page.tsx                            (monitoring = active)
    app/investigate/[id]/page.tsx           (monitoring = ✓, diagnostic = active)
    app/investigate/[id]/recommend/page.tsx (① ✓, ② ✓, ③ = active)
```

Real code, annotated:

```ts
// components/shared/ProcessStepper.tsx:25-29 — the labels are fixed
const STEPS = [
  { key: 'monitoring',     label: 'monitoring anomalies' },
  { key: 'diagnostic',     label: 'investigating the issue' },
  { key: 'recommendation', label: 'decision & recommendation' },
] as const;

// components/shared/ProcessStepper.tsx:108-112 — the active badge pulses
<span
  aria-hidden
  className={state === 'active' ? 'animate-pulse' : undefined}
  style={badgeStyle(state)}
>
  {state === 'complete' ? '✓' : state === 'error' ? '!' : i + 1}
</span>
```

The page maps its `status` to the stepper state through a pure function (`app/page.tsx:20-24`):

```ts
function monitoringState(status: FeedStatus): StepState {
  if (status === 'loading') return 'active';
  if (status === 'error') return 'error';
  return 'complete'; // loaded | empty
}
```

And derives a sub-line that's specifically not a generic "loading…" — it surfaces the real query the monitoring agent is running (`app/page.tsx:26-40`):

```ts
function monitoringSub(status, statusText, queryCount, insightCount): string {
  if (status === 'loading') {
    const q = statusText.trim();
    if (q) return queryCount > 0 ? `query ${queryCount} · ${q}` : q;
    return 'scanning your workspace…';
  }
  if (status === 'empty') return 'no notable changes';
  if (status === 'error') return 'scan failed';
  return `${insightCount} change${insightCount === 1 ? '' : 's'} found`;
}
```

What breaks if you remove it: the user loses the *where am I* signal. They see things happening on the page but don't know whether the system has moved on to a new stage or is stuck on the first one.

#### Part 2 — the coverage grid (`CoverageGrid`)

The progressive surface. Ten categories, each with three possible states (`pending` while waiting on its NDJSON event, `live` with real data, `planned` when the workspace doesn't emit the required events). The grid renders all ten tile slots immediately; each slot starts as a pulsing skeleton and is replaced atomically when the corresponding `coverage_item` event arrives.

```
  CoverageGrid — three tile variants, same grid slot

  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │ ⚙ checking…      │  │ ⚠ anomaly         │  │ ⓘ no data source │
  │ ▒▒▒▒▒▒▒▒▒        │  │ revenue_drop      │  │ inventory         │
  │ animate-pulse    │  │ usa: -38.4%       │  │ planned · needs   │
  │ opacity: 0.5     │  │ severity-coral    │  │   stock event     │
  └──────────────────┘  └──────────────────┘  └──────────────────┘
   pending tile          live (firing) tile    planned (ghost) tile
```

Real code at `components/feed/CoverageGrid.tsx:124-153` for the pending tile:

```tsx
if (!report && loading) {
  return (
    <div key={cat.id} className="animate-pulse" style={{ ...pendingStyle }}>
      <Icon size={13} color="var(--text-tertiary)" />
      <span style={{ ...microMono, color: 'var(--text-tertiary)' }}>checking…</span>
      <div style={{ ...labelMono, color: 'var(--text-tertiary)' }}>{cat.label}</div>
      <Skeleton height={9} width="80%" />
    </div>
  );
}
```

The grid header gets its own progressive counter — "10 categories · 3 monitored · 1 firing · checking 4/10…" — that ticks up as tiles arrive (`CoverageGrid.tsx:74, 97-101`):

```tsx
const checked = coverage.length;
const monitored = coverage.filter((c) => c.coverage !== 'unavailable').length;
const firing = CATEGORIES.filter((c) => insightByCat.has(c.id)).length;
const settling = loading && checked < CATEGORIES.length;
// ...
{settling && (
  <span className="animate-pulse" style={{ color: 'var(--text-tertiary)' }}>
    {' '}· checking {checked}/10…
  </span>
)}
```

This is the load-bearing UX claim of the whole pattern: the grid *can* render its skeleton because the gate emits `coverage_item` events incrementally, and the grid *does* render the real tile the instant the event lands. The component bridges the streaming back-end to a progressive front-end without buffering.

What breaks if you remove the pending tiles: the grid pops into existence at t=30s, after the stepper has been "scanning…" for half a minute with nothing else to look at. The two surfaces stop telling the same story.

#### Part 3 — the skeleton placeholder (`Skeleton`)

The local surface. Four skeleton cards stand in for the insights that will eventually arrive (`app/page.tsx:278-285`):

```tsx
{status === 'loading' && !reconnectPolicy.reconnecting && (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <Skeleton height={96} />
    <Skeleton height={96} />
    <Skeleton height={96} />
    <Skeleton height={96} />
  </div>
)}
```

The `Skeleton` component is 18 lines (`components/shared/Skeleton.tsx`):

```tsx
export default function Skeleton({ height = 80, width = '100%' }: SkeletonProps) {
  return (
    <div
      className="animate-pulse"
      style={{
        background: 'var(--bg-surface)',
        borderRadius: 4,
        height,
        width,
      }}
    />
  );
}
```

Tailwind's `animate-pulse` is the shimmer. The `bg-surface` token keeps the skeleton in palette. The 96px height is sized to roughly match the eventual `InsightCard` so the layout doesn't jump when the cards arrive.

What breaks if you remove it: layout shift. The column-1 region is empty until t=30s, then suddenly shoves the page down by ~500px when five cards land. The skeleton *reserves the space* and *previews the shape*.

#### Part 4 — the status log (`StatusLog`)

The provenance surface. The agent's live reasoning trace + tool calls, with two distinct loading affordances: the `bi-progress` indeterminate bar in the header (`components/shared/StatusLog.tsx:64-66`) and the `bi-dots` three-dot loader next to the empty-state text (`StatusLog.tsx:73-80`).

```ts
// components/shared/StatusLog.tsx — the header and the empty state
<div className="lowercase" style={{ ...headerStyle }}>
  {title}
  {countLabel ? ` · ${countLabel}` : ''}
  {scanning ? ' · running…' : ''}
  {scanning && <div className="bi-progress" style={{ marginTop: 8 }} aria-hidden />}
</div>
<div style={{ padding: '10px 16px 16px' }}>
  {items.length > 0 ? (
    <ReasoningTrace items={items} />     // real trace
  ) : (
    <p className="lowercase" style={{ ...muted }}>
      {emptyMessage}
      {scanning && (
        <span className="bi-dots" aria-hidden>
          <span>·</span><span>·</span><span>·</span>
        </span>
      )}
    </p>
  )}
</div>
```

The CSS keyframes (`app/globals.css:44-76`) own the look:

```css
@keyframes bi-indeterminate {
  0%   { left: -40%; width: 40%; }
  50%  { left: 25%;  width: 50%; }
  100% { left: 100%; width: 40%; }
}
.bi-progress::after {
  content: '';
  position: absolute;
  height: 100%;
  background: var(--accent-teal);
  animation: bi-indeterminate 1.2s ease-in-out infinite;
}

@keyframes bi-dot { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
.bi-dots > span { animation: bi-dot 1.2s ease-in-out infinite; }
.bi-dots > span:nth-child(2) { animation-delay: 0.2s; }
.bi-dots > span:nth-child(3) { animation-delay: 0.4s; }
```

What breaks if you remove the sidebar: the user has no idea *what* the agent is doing. Without it the page reads as "loading… loading… (30 seconds) … done." With it, the page reads as "the agent ran `list_cloud_organizations`, then `list_projects`, then `execute_analytics_eql` for purchase events …" — which is the entire product pitch.

#### The composition — page-level orchestration

The four surfaces don't talk to each other. They each take props from the page and render their own piece. The page (`app/page.tsx:213-453`) does the wiring:

```ts
// app/page.tsx:213-220 — stepper driven by status
<ProcessStepper
  monitoring={{
    state: monitoringState(status),
    sub: monitoringSub(status, stepStatus, queryCount, insights.length),
  }}
  diagnostic={{ state: 'pending', sub: 'opens when you investigate' }}
  recommendation={{ state: 'pending', sub: 'opens when you investigate' }}
/>

// app/page.tsx:276 — grid driven by coverage + status
<CoverageGrid
  coverage={coverage}
  insights={insights}
  loading={status === 'loading' && !reconnectPolicy.reconnecting}
/>

// app/page.tsx:278-285 — skeletons driven by status alone
{status === 'loading' && !reconnectPolicy.reconnecting && (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <Skeleton height={96} /><Skeleton height={96} />
    <Skeleton height={96} /><Skeleton height={96} />
  </div>
)}

// app/page.tsx:348-354 — insights replace skeletons on 'loaded'
{status === 'loaded' && (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
    {insights.map((insight) => <InsightCard key={insight.id} insight={insight} />)}
  </div>
)}
```

`status` is one of `'loading' | 'error' | 'empty' | 'loaded'`. Each surface conditionally renders against it (or against the streaming substate it owns). There's no central "reveal coordinator" — the prop fan-out from the hook to the four surfaces IS the coordinator.

#### The per-item entrance — `bi-fade-up`

Every appended item gets the `bi-fade-up` class. New `InsightCard` (`InsightCard.tsx:179`), every `CoverageGrid` tile container (`CoverageGrid.tsx:77`), every row in `ReasoningTrace` (`ReasoningTrace.tsx:66, 94`), every `EvidencePanel` body (`EvidencePanel.tsx:107`). The CSS (`globals.css:37-42`):

```css
@keyframes bi-fade-up {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.bi-fade-up { animation: bi-fade-up 0.4s ease both; }
@media (prefers-reduced-motion: reduce) { .bi-fade-up { animation: none; } }
```

A 400ms entrance — short enough not to feel like waiting, long enough to register as intentional. And it's gated on `prefers-reduced-motion` so a vestibular-sensitive user gets the data without the motion.

#### The flow — layers-and-hops

What the user sees at the end of the stream, traced from the wire down to the pixel.

```
  Layers-and-hops — one coverage_item event lights one tile

  ┌─ Network ──────────┐    hop 1: {"type":"coverage_item",        ┌─ Client / kernel ─┐
  │  HTTP chunk        │ ────────────"item":{"category":           │ readNdjson        │
  │                    │              "revenue_drop",…}}\n         │  → JSON.parse     │
  └────────────────────┘                                            └─────────┬─────────┘
                                                                              │ hop 2: onEvent(evt)
                                                                              ▼
                                                                    ┌─ Client / hook ────┐
                                                                    │ useBriefingStream  │
                                                                    │ case 'coverage_item│
                                                                    │ setCoverage(p =>   │
                                                                    │   [...p, evt.item])│
                                                                    └─────────┬──────────┘
                                                                              │ hop 3: re-render
                                                                              ▼
                                                                    ┌─ Client / React ───┐
                                                                    │ <CoverageGrid      │
                                                                    │   coverage={...}/> │
                                                                    └─────────┬──────────┘
                                                                              │ hop 4: byCat.get(cat.id)
                                                                              │        finds the new tile
                                                                              ▼
                                                                    ┌─ Client / DOM ─────┐
                                                                    │ skeleton div       │
                                                                    │ replaced by        │
                                                                    │ real tile div      │
                                                                    │ .bi-fade-up runs   │
                                                                    └────────────────────┘
```

Hop 4 is the moment of the reveal: the conditional in `CoverageGrid.tsx:124` (`if (!report && loading)`) flips from `true` to `false`, the skeleton unmounts, and the real tile mounts with the entrance animation.

### Move 3 — the principle

**One status, four reveal surfaces, each told to stay specific.** The principle generalizes past this app: when work takes longer than a spinner can defend (anything past ~2 seconds), don't show one loading state — show as many as the work has stages. The trick isn't sophistication, it's *non-genericness*. The stepper says "monitoring is the active stage." The coverage grid says "category 3 of 10 just came back." The skeleton says "the cards will land here, in this shape." The status log says "the agent just ran `execute_analytics_eql` for purchase events." Four sentences worth of information, each owned by its own surface.

The cross-cutting version: **make the loading state as informative as the loaded state.** A spinner is a loading state with one bit of information ("something is happening"). A progressive composition is a loading state with as many bits as the back-end is willing to stream. The CSS — `animate-pulse`, `bi-fade-up`, `bi-progress`, `bi-dots` — is the polish; the streaming substrate is the substance.

## Primary diagram

The four-tier reveal, end to end.

```
  Progressive skeleton with stepper — the full reveal

  TIME →  t=0                  t=2s                  t=15s                t=30s
  ─────────────────────────────────────────────────────────────────────────────────

  STATUS  status='loading'     status='loading'      status='loading'     status='loaded'
          coverage=[]          coverage=[item1]      coverage=[6 items]   coverage=[10 items]
          insights=[]          insights=[]           insights=[]          insights=[5]
          traceItems=[]        traceItems=[2]        traceItems=[8]       traceItems=[11]

  TIER 1  ┌──ProcessStepper──┐ ┌──ProcessStepper──┐  ┌──ProcessStepper──┐ ┌──ProcessStepper──┐
          │ ① active (pulse) │ │ ① active (pulse) │  │ ① active (pulse) │ │ ① ✓ "5 found"     │
          │ "scanning…"      │ │ "query 1 · purch.│  │ "query 6 · sess.│ │ ② pending          │
          │ ② pending        │ │ ② pending        │  │ ② pending        │ │ ③ pending          │
          └──────────────────┘ └──────────────────┘  └──────────────────┘ └──────────────────┘

  TIER 2  ┌──CoverageGrid────┐ ┌──CoverageGrid────┐  ┌──CoverageGrid────┐ ┌──CoverageGrid────┐
          │ checking 0/10…   │ │ checking 1/10…   │  │ checking 6/10…   │ │ 3 monitored ·    │
          │ [▒][▒][▒][▒][▒]  │ │ [✓][▒][▒][▒][▒]  │  │ [✓✓✓✓✓✓][▒][▒]  │ │  1 firing · 6   │
          │ animate-pulse    │ │ tile fade-up     │  │ tiles fade-up    │ │  no data source │
          └──────────────────┘ └──────────────────┘  └──────────────────┘ └──────────────────┘

  TIER 3  ┌──Skeleton ×4─────┐ ┌──Skeleton ×4─────┐  ┌──Skeleton ×4─────┐ ┌──InsightCard ×5──┐
          │ ▒▒▒▒▒▒▒▒▒▒▒▒    │ │ ▒▒▒▒▒▒▒▒▒▒▒▒    │  │ ▒▒▒▒▒▒▒▒▒▒▒▒    │ │ each fades in    │
          │ ▒▒▒▒▒▒▒▒▒▒▒▒    │ │ ▒▒▒▒▒▒▒▒▒▒▒▒    │  │ ▒▒▒▒▒▒▒▒▒▒▒▒    │ │ via bi-fade-up    │
          │ ▒▒▒▒▒▒▒▒▒▒▒▒    │ │ ▒▒▒▒▒▒▒▒▒▒▒▒    │  │ ▒▒▒▒▒▒▒▒▒▒▒▒    │ │                  │
          └──────────────────┘ └──────────────────┘  └──────────────────┘ └──────────────────┘

  TIER 4  ┌──StatusLog───────┐ ┌──StatusLog───────┐  ┌──StatusLog───────┐ ┌──StatusLog───────┐
          │ "connecting…"·   │ │ tool: list_organ.│  │ 11 rows trace    │ │ trace complete   │
          │   bi-dots        │ │ tool: execute_an.│  │ bi-progress bar  │ │ bi-progress      │
          │ bi-progress bar  │ │ bi-progress bar  │  │ scrolling        │ │ unmount          │
          └──────────────────┘ └──────────────────┘  └──────────────────┘ └──────────────────┘

  the four tiers move at different rates, but together they tell one story:
  "the system is working, here's exactly what it's doing right now"
```

## Elaborate

**Where this pattern comes from.** Skeleton screens were popularized by Facebook around 2013 and have since become standard in any app with a noticeable load time (LinkedIn, YouTube, Slack, GitHub). The classic skeleton-screen pattern is one boolean `isLoading` controlling one set of skeletons. The progressive variant — staging multiple loading affordances at different granularities — is the natural extension when the back-end is streaming-shaped rather than request-shaped.

The blooming insights variant earns its keep because the monitoring agent's runtime is *long* (30-60s) and *staged* (10 categories checked in sequence, each producing 0-N tool calls, each emitting events as it goes). A single skeleton would have hidden all of that; the four-tier composition exposes it.

**Adjacent patterns.**
- *Stale-while-revalidate* — render the previous data while the new data loads. Not used here; the briefing always starts from empty state when the mode toggles.
- *Optimistic UI* — render the assumed result before the network confirms it. Not used here; the app is read-only.
- *Streaming SSR with `<Suspense>`* — the React 19 / Next 16 way to stream a server-rendered tree progressively. Not used here; everything is client-side, and the streaming substrate is the NDJSON kernel (see `01-ndjson-stream-reader-hook.md`), not RSC.
- *Layout shift prevention* — the broader category the `Skeleton`-sized-to-the-real-card move belongs to. CLS (cumulative layout shift) measurement belongs to `study-performance-engineering`.

**What this pattern doesn't yet solve.**
- *Accessibility for the stream* — the status log has no `aria-live` region (`audit.md` → frontend-red-flags-audit ranks this #1). A blind user sees nothing. The pattern as shipped is sighted-user-only.
- *Reduced motion as a first-class state* — the `bi-fade-up`/`bi-progress`/`bi-dots` keyframes all check `prefers-reduced-motion: reduce`, which is correct. But the *information* in the progressive reveal is still preserved with motion off (the same status text + counter still updates). Worth naming because the pattern doesn't degrade — it gracefully simplifies.
- *Error states across the four tiers* — when monitoring fails, the stepper turns to `error` state but the coverage grid stays in its last partial state. There's no "the load broke; here's what we got before it broke" recovery affordance.

**See also.** The data side of this pattern (where the events come from, how they're parsed) lives in `01-ndjson-stream-reader-hook.md`. The same `bi-fade-up` keyframe runs on every appended `ReasoningTrace` row inside the `StatusLog`, which is the pattern's smallest unit.

## Interview defense

**Q: Why four loading states instead of one spinner?**

A — *the diagram you sketch:*

```
  One spinner vs. four progressive reveals

  one spinner                            four progressive reveals
  ───────────                            ───────────────────────
  "is the page loading?"                 stepper:    where in the pipeline?
  one bit of information                 grid:       which categories checked?
                                         skeletons:  what shape will land?
                                         status log: what's the agent doing now?
  works for ≤ 2s                         works for 30-60s
  works for one-shot fetch               works for streaming
  user → "is it broken?" at 5s           user → "I can see it working"
```

The work takes 30-60 seconds. A spinner past two seconds reads as broken. Four reveals each tell a different specific story — together they cover the gap.

*Anchor:* the four-tier composition lives in `app/page.tsx:213-453`; the streaming substrate that makes it possible is in `01-ndjson-stream-reader-hook.md`.

---

**Q: What's the load-bearing part — the one people forget?**

A — *the diagram:*

```
  The load-bearing part: progressive surfaces require progressive events

  ┌─ Wire format ──────────────────────────────────────────────────┐
  │  one big "result" event at the end    →  one big reveal at end │
  │  one event per category               →  tiles stream in       │
  │  one event per tool call              →  trace fills line by   │
  │                                          line                  │
  └────────────────────────────────────────────────────────────────┘

  The pattern depends on the back-end emitting:
    - coverage_item per category (not one final 'coverage')
    - reasoning_step + tool_call_start + tool_call_end per tool
    - insight per anomaly (not one final 'insights')

  Without that, all four surfaces collapse to "loading… (30s) … done."
```

The load-bearing part isn't the CSS or the skeletons — it's that the producer streams an event per category, an event per tool call, an event per insight. The visual progressive reveal IS a wire-format choice. If the route emitted one final result, the UI would be a spinner regardless of how many `Skeleton` components you stacked.

*Anchor:* `lib/hooks/useBriefingStream.ts:36-45` for the 9-case event union; the dispatcher at `:204-286` is where streaming events become progressive state.

---

**Q: Where does this pattern break, and what would you do next?**

A — *the diagram:*

```
  Three break points, ranked

  ① no aria-live on the trace            blind user sees nothing
                                          fix: role="log" aria-live="polite"
                                               on the trace container

  ② error mid-stream                     stepper goes red, grid frozen at partial
                                          fix: an "incomplete coverage" affordance
                                               on the grid that names what's missing

  ③ no virtualization on long traces      ReasoningTrace re-renders all items per
                                          appended event
                                          fix: React.memo on row + windowed render
                                               at the threshold (~100 items)
```

The accessibility one is the most user-visible. The error one is the next most likely to surface in real usage (the alpha Bloomreach server revokes tokens after minutes). The virtualization one is a future-tense concern at today's trace lengths.

*Anchor:* the audit's `frontend-red-flags-audit` ranks these same three at the top of the list.

## See also

- `01-ndjson-stream-reader-hook.md` — the streaming substrate that makes the progressive reveal possible. Without per-category events, the four-tier composition collapses to one spinner.
- `audit.md` → `styling-and-design-system` — the design-token + keyframe inventory the pattern reaches for (`bi-fade-up`, `bi-progress`, `bi-dots`, `animate-pulse`).
- `audit.md` → `component-architecture` — `StatusLog` extracted from `app/page.tsx`; the page's inline copy still duplicates the sidebar shape.
- `audit.md` → `frontend-red-flags-audit` — the `aria-live` gap, the duplication, the per-row memoization risk.
- Neighbor: `study-performance-engineering` — CLS (cumulative layout shift) measurement; the skeleton-sized-to-the-real-card move would be the first thing it'd vindicate.
- Neighbor: `study-runtime-systems` — the React scheduler's behavior when one `setState` lands per arriving line under StrictMode. This file owns the visual composition; the runtime owns the render scheduling.
