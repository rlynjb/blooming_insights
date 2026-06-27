# Progressive skeleton with stepper

**Industry name(s):** progressive disclosure of work · skeleton + stepper composition · perceived-instant streaming UI · multi-tier loading state
**Type:** Industry standard (frontend) · Project-specific composition

> The product is a 30-90s agent run. The UI is a composition of four primitives (`Skeleton`, `ProcessStepper`, `CoverageGrid` pending tiles, `ReasoningTrace`/`StatusLog`) that turn that wait into a multi-tier progress experience: shape-holding skeletons fill the layout from frame 1, a stepper above the content names *which* stage is running and its sub-status, a tile grid streams in one tile per category as the gate reports it, and a sticky sidebar streams the agent's tool calls and thoughts in real time. Strip any one and the UX collapses to "blank screen → big content jump." The composition IS the pattern; no single component carries it.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three primitives + one composing layout, used on every routed page. The primitives are in `components/shared/Skeleton.tsx` (18 LOC, one animated `<div>`), `components/shared/ProcessStepper.tsx` (139 LOC, the three-stage horizontal stepper), and `components/shared/StatusLog.tsx` (87 LOC, the sticky sidebar over `ReasoningTrace`). The composition lives at the page level: the feed page composes them around a streaming briefing (`app/page.tsx:560-808`), the diagnose page composes them around the `useInvestigation` hook (`app/investigate/[id]/page.tsx:115-220`), and the recommend page does the same with a different center column (`app/investigate/[id]/recommend/page.tsx:112-194`). `CoverageGrid` (`components/feed/CoverageGrid.tsx`) is the feed-specific fourth tier — a tile grid that fills in as the gate reports each category.

```
Zoom out — where progressive skeleton + stepper lives

┌─ UI ─────────────────────────────────────────────────────────┐  ← we are here
│                                                                │
│  page-shell                                                    │
│  ├─ ProcessStepper          (named stage + sub-status)         │
│  │  · monitoring / diagnostic / recommendation                  │
│  │  · state: pending / active / complete / error               │
│  ├─ CoverageGrid            (feed-only: tile grid + pending)   │
│  │  · 10 tiles · stream in 1 at a time · pending uses Skeleton │
│  ├─ Skeleton stacks         (content placeholders, shape-true) │
│  ├─ live content area       (insights / EvidencePanel / Recs)  │
│  └─ StatusLog (aside)       (sticky · ReasoningTrace · scanning)│
│                                                                  │
│  ★ the composition IS the pattern ★                             │
│                                                                  │
└────────────────────┬─────────────────────────────────────────────┘
                     │  status: 'loading' | 'loaded' | 'error' | 'empty'
                     │  events streaming in
                     ▼
┌─ Data layer ────────────────────────────────────────────────────┐
│  useInvestigation hook (pages 2/3) · inline reader (page 1)     │
│  → see 01-ndjson-stream-reader-hook.md                           │
└──────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this composition answers: *how do you make a 30-90s wait feel like a 200ms wait?* The answer is to put no blank moment between page load and "something is happening." Four tiers cooperate: (1) the **stepper** says which of three stages is running and what it just did, before any data has arrived; (2) the **coverage grid** holds the shape of "ten categories will be checked" with Skeleton tiles, and flips each tile to its real state as the gate reports it; (3) the **skeleton stacks** below hold the shape of "four insight cards are coming" so the layout never jumps; (4) the **sticky sidebar** streams the agent's actual tool calls and thoughts so the user can *watch* the work, not wait for it. The cleverness is the composition, not any individual component. None of the four primitives is novel; together they're the entire perceived-instant UX.

---

## Structure pass

**Layers.** Four altitudes that cooperate within one page render: the **stepper layer** (a row above content; named-stage progress that comes from the routing context, not from streaming data), the **shape layer** (skeleton placeholders that hold the page's vertical rhythm so the layout never jumps), the **tile layer** (the feed-specific `CoverageGrid` that fills in tile-by-tile from coverage-stream events), and the **trace layer** (the sticky `<aside>` that streams the *meaningful* work — every tool call, every thought, in real time).

**Axis: time-to-first-paint of MEANING.** How fast does the user see something that tells them what the system is doing? Each layer answers this differently. The stepper answers it before any data arrives (renders synchronously from page state). The shape layer answers it on first paint (the Tailwind `animate-pulse` boxes are part of the initial render). The tile layer answers it as soon as the first `coverage_item` event arrives (~200-500ms after fetch start). The trace layer answers it as soon as the first `reasoning_step` or `tool_call_start` event arrives. The composition stacks four progressively-richer answers so the user gets information at every order of magnitude (10ms, 100ms, 1s, 10s).

**Seams.** Three seams matter. **Seam 1: stepper → shape layer.** The stepper renders synchronously; the shape layer hangs off the `status === 'loading'` flag. The seam is the page-level state variable that flips them between modes (`status` in `app/page.tsx:96, 266`; `loading` prop in `EvidencePanel.tsx:48-99`). **Seam 2 (load-bearing): shape layer → tile layer.** The shape layer is *static placeholder* — the same skeleton each frame. The tile layer is *progressive* — each tile flips from skeleton to real once. The handoff is per-category, not per-page: each `coverage_item` event the stream produces flips one tile (`CoverageGrid.tsx:117-280` uses `byCat.get(cat.id)` to look up the per-category report and renders pending vs live accordingly). **Seam 3: tile layer → trace layer.** The tile layer shows *coverage of the categories scanned*; the trace layer shows *the actual queries running*. The seam is "structure of work" vs "instance of work" — both are streaming, both update progressively, but they answer different user questions.

```
Structure pass — the progressive composition

┌─ 1. LAYERS ───────────────────────────────────────────────┐
│  Stepper layer (3-stage named progress, synchronous)       │
│  Shape layer   (Skeleton stacks, hold the layout)           │
│  Tile layer    (CoverageGrid, fills in tile-by-tile)        │
│  Trace layer   (StatusLog/aside, streams tool calls + steps)│
└────────────────────────┬───────────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼─────────────────────────────────────┐
│  time-to-first-paint of meaning: how fast does the user see │
│  something that tells them what the system is doing?         │
└────────────────────────┬─────────────────────────────────────┘
                         │  trace across layers
┌─ 3. SEAMS ────────────▼─────────────────────────────────────┐
│  S1: stepper → shape (synchronous → status-flag-driven)     │
│  S2: shape → tile ★ load-bearing                            │
│      (static placeholders → per-category flip on event)     │
│  S3: tile → trace (structure of work → instance of work)    │
└────────────────────────┬─────────────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

---

## How it works

**Use cases.** Four places the composition is reached for:

- **Feed page during the initial briefing scan.** `app/page.tsx:560-808`. The full four-tier composition: ProcessStepper at L561-L568, CoverageGrid at L624, Skeleton stack at L626-L633, hand-rolled StatusLog aside at L743-L808.
- **Diagnose page during the diagnostic agent run.** `app/investigate/[id]/page.tsx:115-220`. ProcessStepper at L115-L119, EvidencePanel's shape-true skeleton at L150 (via the `loading` prop), shared StatusLog component at L214-L220.
- **Recommend page during the recommendation agent run.** `app/investigate/[id]/recommend/page.tsx:112-194`. ProcessStepper at L112-L116, RecommendationCardSkeleton stack at L172-L174, shared StatusLog component at L186-L192.
- **StreamingResponse for the `?q=` ask flow.** `components/chat/StreamingResponse.tsx:182-215`. The smaller-scale variant: no stepper (it's not pipeline-shaped), no tiles, but Skeleton at L213 + an inline `bi-dots` "thinking…" + the trace expands inline (L246-L272). Demonstrates the same pattern at a smaller scale.

### Move 1 — mental model: four primitives that stack on the time axis

You know how a YouTube video has a low-res placeholder, then a buffering spinner, then the first frame, then real motion? Same shape: progressively richer information at each tier, no blank moment between them. The four primitives are stacked on the *time axis* of perceived progress.

```
Pattern — the four tiers, by what the user sees when

  time     | stepper        | shape      | tiles          | trace
  ─────────┼────────────────┼────────────┼────────────────┼──────────────────
  0ms      | "monitoring"   | skeletons  | 10 pending     | "connecting…"
           |   active       | hold layout| dashed borders | (empty placeholder)
  ─────────┼────────────────┼────────────┼────────────────┼──────────────────
  ~300ms   | "scanning      | (same)     | tile 1 flips   | first tool_call_start
           |  your wkspace…"|            | live           | appears
  ─────────┼────────────────┼────────────┼────────────────┼──────────────────
  ~3s      | "query 4 ·     | (same)     | 5 tiles flipped| 4 tool calls done
           |  events_metric"|            | live           | 2 reasoning steps
  ─────────┼────────────────┼────────────┼────────────────┼──────────────────
  ~30s     | "8 changes     | (replaced  | 10 tiles done  | 6-10 tool calls
           |  found"        | by cards)  | (2 firing, 8   | 4-6 reasoning steps
           |   complete     |            |  clear, 0 no   | "diagnosis ready"
           |                |            |  data)         |
  ─────────┴────────────────┴────────────┴────────────────┴──────────────────

  the user always has SOMETHING to read — the silence is filled at every
  order of magnitude. perceived latency drops from 30s → 200ms.
```

The composition's "secret" is that no single tier is doing the heavy lifting. The stepper alone would be a vague spinner. The skeleton alone would be content that never arrives. The tiles alone would be progress without context. The trace alone would be a debug log without structure. All four together fill in the parts the others can't.

### Move 2.1 — the stepper layer: named-stage progress from page context

`ProcessStepper` (`components/shared/ProcessStepper.tsx`) renders three horizontally-arranged rows, each with a number badge (1/2/3), a label (`monitoring anomalies` / `investigating the issue` / `decision & recommendation`), an optional sub-line (the live status from streaming data), and four mutually-exclusive states (`pending` / `active` / `complete` / `error`).

```
Pattern — the stepper as a synchronous progress indicator

  ┌─ stepper props ──────────────────────────────────────────────┐
  │  monitoring:     { state, sub, href? }                        │
  │  diagnostic:     { state, sub, href? }                        │
  │  recommendation: { state, sub, href? }                        │
  └──────────────────────────────────────────────────────────────┘

  rendered as:

  ┌─[1]─monitoring anomalies─┬─[2]─investigating the issue─┬─[3]─decision & recommendation─┐
  │     scanning your wkspc…  │     opens when you investig.│     opens when you investig.  │
  │     ACTIVE (pulsing teal) │     PENDING (grey)          │     PENDING (grey)            │
  └───────────────────────────┴─────────────────────────────┴───────────────────────────────┘

  on each page the stepper renders DIFFERENT states — same component, same shape:

  feed:        [1] ACTIVE          [2] pending         [3] pending
  diagnose:    [1] complete (link) [2] ACTIVE          [3] pending (jumpable when ready)
  recommend:   [1] complete (link) [2] complete (link) [3] ACTIVE
```

The `sub` field is where the streaming data feeds back into the stepper. On the feed, `monitoringSub` (`app/page.tsx:50-64`) derives the sub-line from the current `stepStatus` (last `reasoning_step` content), `queryCount`, and `insights.length`. So the stepper sub-line changes from `scanning your workspace…` → `query 4 · select_events(metric='cart_add')` → `8 changes found` as the briefing runs. The user reads one line and knows what's happening.

**What breaks if you remove:**

- The stepper itself → the user knows "something is loading" but not what stage of what. Routes feel orphaned.
- The `sub` field → the stepper becomes static. The user knows they're at stage 2, doesn't know whether it's making progress.
- The `state` field's four states → the stepper can't distinguish active from pending; pages can't show "where you are in the pipeline."

**Code in this codebase — `components/shared/ProcessStepper.tsx:66-138`** (the stepper render):

```
  function ProcessStepper({ monitoring, diagnostic, recommendation }) {
    const inputs: StepInput[] = [monitoring, diagnostic, recommendation];
    return (
      <div
        role="group"                                 ← a11y: groups the three steps
        aria-label="analysis pipeline"
        style={{ display: 'flex', /* … */ }}
      >
        {STEPS.map((step, i) => {                   ← STEPS is fixed:
          const { state, sub, href } = inputs[i];      monitoring / diagnostic /
                                                       recommendation
          const labelColor =
            state === 'pending'  ? 'var(--text-tertiary)' :
            state === 'error'    ? 'var(--accent-coral)' :
                                   'var(--text-primary)';
          const subColor = state === 'active'
            ? 'var(--text-secondary)'
            : 'var(--text-tertiary)';
          // …
          const inner = (
            <>
              <span
                aria-hidden                          ← number/check/exclamation is
                className={state === 'active'           decorative; the label carries
                  ? 'animate-pulse' : undefined}        the semantic name
                style={badgeStyle(state)}
              >
                {state === 'complete' ? '✓' :
                 state === 'error'    ? '!' : i + 1}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="lowercase" style={{ /* labelStyle */, color: labelColor }}>
                  {step.label}                       ← "monitoring anomalies" etc.
                </div>
                {sub && (
                  <div className="lowercase" style={{ /* subStyle */, color: subColor }}
                       title={sub}>
                    {sub}                            ← the live status from streaming data
                  </div>                                e.g. "query 4 · select_events(…)"
                )}
              </div>
            </>
          );
          return href ? (
            <Link key={step.key} href={href} style={wrapStyle}>{inner}</Link>
          ) : (
            <div key={step.key} style={wrapStyle}>{inner}</div>
          );                                          ← becomes a <Link> only when href
        })}                                              is passed (the diagnose page
      </div>                                            makes step 3 jumpable when ready)
    );
  }
       │
       └─ the four states (pending/active/complete/error) + the optional sub-line
          + the optional href compose to give every page-stage combination its own
          rendering — same component, three pages, six different visible states.
```

### Move 2.2 — the shape layer: skeletons that hold the layout

`Skeleton` (`components/shared/Skeleton.tsx`) is 18 lines: one animated `<div>` with configurable `height` and `width`, `background: var(--bg-surface)`, `borderRadius: 4`, and the Tailwind `animate-pulse` class. It does one thing: occupy space the eventual content will occupy.

```
Pattern — skeletons hold the SHAPE of what's coming

  loading state                       loaded state
  ─────────────────────────           ─────────────────────────
  ┌─────────────────────┐             ┌─────────────────────┐
  │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │             │  💼 ssr crawl rate    │
  │  ▓▓▓▓▓▓▓▓▓▓▓        │   ──▶       │     dropped 18%       │
  │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓    │             │  ──────────────────   │
  └─────────────────────┘             │  evidence · timeline  │
                                       └─────────────────────┘
  ┌─────────────────────┐             ┌─────────────────────┐
  │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │             │  📉 conversion drop   │
  │  ▓▓▓▓▓▓▓▓▓▓▓        │             │     in checkout       │
  │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓    │             │  ──────────────────   │
  └─────────────────────┘             │  evidence · timeline  │
                                       └─────────────────────┘

  the layout DOES NOT JUMP when content arrives — the skeletons
  occupy roughly the same vertical space the cards will use.
```

On the feed, four `<Skeleton height={96} />` stack vertically while `status === 'loading'` (`app/page.tsx:626-633`). On the investigate page, `EvidencePanel.tsx:62-99` renders a structurally-shaped skeleton (two tile placeholders + a callout box + two hypothesis rows) so the loaded panel arrives into the same visual rhythm. `RecommendationCardSkeleton.tsx` does the same for the recommend page.

The `EvidencePanel` skeleton wraps the placeholder block in `aria-hidden` (`EvidencePanel.tsx:63`) so assistive tech is told to skip the visual filler. `RecommendationCardSkeleton.tsx:18` does the same. (The a11y audit notes that not every skeleton in the codebase carries this — the feed's `<Skeleton height={96} />` stack at `app/page.tsx:627-632` is *not* `aria-hidden`-wrapped.)

**What breaks if you remove:**

- The skeleton stacks → the page renders empty for the entire loading window, then the cards drop in and the layout jumps as the viewport recomputes.
- The shape-true skeleton (vs generic boxes) → the layout still jumps slightly when content arrives, because the placeholder's vertical rhythm differs from the loaded shape.
- The `aria-hidden` wrapper → screen readers read out a string of empty boxes as content; the user hears noise that isn't the page.

**Code in this codebase — `components/shared/Skeleton.tsx:1-18`** (the entire primitive):

```
  interface SkeletonProps {
    height?: number | string;       ← optional; default 80
    width?: number | string;        ← optional; default '100%'
  }

  export default function Skeleton({ height = 80, width = '100%' }: SkeletonProps) {
    return (
      <div
        className="animate-pulse"     ← Tailwind utility = CSS keyframe animation
        style={{
          background: 'var(--bg-surface)',  ← darker than the page, lighter than border
          borderRadius: 4,                    so it reads as "card-shaped placeholder"
          height,
          width,
        }}
      />
    );
  }
       │
       └─ 18 LOC. one job. consumed by every page-level loading state.
          its smallness IS the point — composition wins, not configuration.
```

### Move 2.3 — the tile layer: progressive disclosure per-category

`CoverageGrid` (`components/feed/CoverageGrid.tsx`) is the feed-specific fourth primitive — a 10-category tile grid that fills in as the monitoring agent's gate reports each category. This is the move that's hardest to find in other codebases because it's specific to *coverage-of-a-checklist* progress, not just *progress-of-one-thing* progress.

```
Pattern — per-category progressive disclosure

  the gate reports categories in any order over ~3-15 seconds.
  each report flips one tile from pending → live.

  frame 1 (~0ms):                   frame 2 (~500ms):                frame 3 (~10s):
  ┌────┬────┬────┬────┐             ┌────┬────┬────┬────┐             ┌────┬────┬────┬────┐
  │ ░░ │ ░░ │ ░░ │ ░░ │             │ ✓  │ ░░ │ ░░ │ ░░ │             │ ✓  │ ●  │ ✓  │ ✓  │
  │ ░░ │ ░░ │ ░░ │ ░░ │             │clear│ ░░ │ ░░ │ ░░ │             │clear│anom│clear│clear│
  ├────┼────┼────┼────┤             ├────┼────┼────┼────┤             ├────┼────┼────┼────┤
  │ ░░ │ ░░ │ ░░ │ ░░ │             │ ░░ │ ░░ │ ░░ │ ░░ │             │ ●  │ ✓  │ —  │ ●  │
  │ ░░ │ ░░ │ ░░ │ ░░ │             │ ░░ │ ░░ │ ░░ │ ░░ │             │anom│clear│no  │anom│
  │    │    │    │    │             │    │    │    │    │             │    │     │data│    │
  └────┴────┴────┴────┘             └────┴────┴────┴────┘             └────┴────┴────┴────┘
  10 dashed-border tiles            1 live tile, 9 pending             all 10 reported

  the tile flips because byCat.get(cat.id) now returns a report;
  before the event arrived, the lookup returned undefined → pending tile.
```

The component renders all 10 categories from the static `CATEGORIES` list (`lib/agents/categories.ts`) every frame, but each tile reads its state from a `Map` built from the streamed `coverage` prop (`CoverageGrid.tsx:65`). When a `coverage_item` event arrives, the feed's effect appends to the coverage array (`app/page.tsx:333-338` only adds if not already present, so duplicates don't double-flip), the `Map` rebuilds, and the previously-pending tile finds its report and re-renders as live.

The pending tile state is visually distinct: dashed border, no icon background, "—" or "checking…" microcopy. The live states use `--accent-coral` for anomaly, `--accent-teal` for clear, `--accent-amber` for limited, and grey for unavailable/no-data. Each tile that's firing (has an associated `Insight`) wraps in a `<Link>` to `/investigate/<id>` — the user can drill into any anomaly tile directly.

**What breaks if you remove:**

- The pending-state rendering → tiles only appear after they're reported, and the layout grows as the grid fills in. The user gets "1 tile, 2 tiles, 3 tiles…" growing the page.
- The per-category `Map` lookup → the component can't distinguish reported from pending; loses the progressive-disclosure property.
- The "anomaly coverage" header counters (`monitored`, `firing`, `no data`) → the user can't see the rollup of progress; loses the "checking 5/10…" thread of awareness.

**Code in this codebase — `components/feed/CoverageGrid.tsx:61-115`** (the tile layer header + counters):

```
  function CoverageGrid({ coverage, insights, loading = false }) {
    if ((!coverage || coverage.length === 0) && !loading) return null;
                                                       ↑ idle: render nothing

    const byCat = new Map(coverage.map((c) => [c.category, c]));  ← lookup by category
    const insightByCat = new Map<CategoryId, Insight>();
    for (const i of insights)
      if (i.category && !insightByCat.has(i.category))
        insightByCat.set(i.category, i);              ← which insight FIRES which tile

    // counts reflect what's been reported SO FAR — tick up as tiles stream in
    const checked   = coverage.length;
    const monitored = coverage.filter(c => c.coverage !== 'unavailable').length;
    const firing    = CATEGORIES.filter(c => insightByCat.has(c.id)).length;
    const skipped   = coverage.filter(c => c.coverage === 'unavailable');
    const settling  = loading && checked < CATEGORIES.length;  ← still scanning?

    return (
      <div className="bi-fade-up">                    ← gentle entrance animation
        <div /* header row */>
          <div>
            <div style={{ /* title */ }}>anomaly coverage</div>
            <div style={{ /* counter row */ }}>
              10 categories ·
              <span style={{ color: 'var(--accent-teal)' }}>{monitored} monitored</span> ·
              <span style={{ color: 'var(--accent-coral)' }}>{firing} firing</span> ·
              <span style={{ color: 'var(--text-tertiary)' }}>{skipped.length} no data</span>
              {settling && (                          ← only while still scanning
                <span className="animate-pulse" style={{ color: 'var(--text-tertiary)' }}>
                  {' '}· checking {checked}/10…
                </span>                               ← the running progress thread
              )}
            </div>
          </div>
          <div /* legend row */>{/* coral/teal/amber dots + planned */}</div>
        </div>
        <div style={{ display: 'grid',
                      gridTemplateColumns:
                        'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
          {CATEGORIES.map((cat) => {                  ← ALWAYS renders all 10
            const report = byCat.get(cat.id);            categories; per-tile
            const Icon = ICONS[cat.id];                  state comes from byCat
            const coverageState = report?.coverage ?? 'unavailable';
            // …tile rendering: pending if !report, live if report present
          })}
        </div>
      </div>
    );
  }
       │
       └─ the load-bearing property: CATEGORIES.map runs every render and produces
          all 10 tiles. each tile picks its state from byCat.get(cat.id). missing
          entries render as pending; present entries render as live. so each
          coverage_item event flips one tile from pending to live — without
          changing the grid's layout.
```

### Move 2.4 — the trace layer: the sticky sidebar that streams the work

`StatusLog` (`components/shared/StatusLog.tsx`) is a sticky `<aside>` that wraps `ReasoningTrace` (`components/investigation/ReasoningTrace.tsx`) with a parameterized header. It does three things: hold the sticky position (so it stays visible while the main content scrolls), render the streaming `TraceItem[]` (reasoning steps + tool calls in chronological order), and surface a header status (count + `scanning…` suffix + indeterminate progress bar).

```
Pattern — the trace as a real-time work log

  ┌─ <aside> sticky top:16 ─────────────────────────────┐
  │  how this was figured out · 5 steps · running…       │  ← header
  │  ┌───────────────────────┐                            │
  │  │  ▓▓▓▓ progress bar    │  ← bi-progress animation   │
  │  └───────────────────────┘                            │
  │                                                       │
  │  ┃ ◇ DIAGNOSTIC · thought                             │  ← ReasoningTrace
  │  ┃   "the conversion drop is mostly mobile-checkout"  │
  │  ┃                                                    │
  │  ┃ ◇ select_events                                    │  ← ToolCallBlock
  │  ┃   ● running…                                       │     (running)
  │  ┃                                                    │
  │  ┃ ◇ DIAGNOSTIC · hypothesis                          │
  │  ┃   "checkout step 3 latency"                        │
  │  ┃                                                    │
  │  ┃ ◇ select_events                                    │
  │  ┃   ✓ 842ms                                          │  ← ToolCallBlock
  │  ┃                                                    │     (done)
  └──────────────────────────────────────────────────────┘

  every event arrival appends a row. the user can watch every tool
  call, every thought, in real time. the bi-fade-up animation makes
  each new row visible without being jarring (gated by
  prefers-reduced-motion).
```

`ReasoningTrace` (`components/investigation/ReasoningTrace.tsx`) renders each item by kind: reasoning steps get an agent badge + step-kind label + timestamp + the content text, tool calls get a `ToolCallBlock` (collapsible, shows tool name + status dot + duration or "running…"). The colors map to the trace's meaning: amber for hypothesis, teal for conclusion, grey for thought, coral for errors.

The same `StatusLog` is rendered on both investigation pages (`app/investigate/[id]/page.tsx:214-220`, `recommend/page.tsx:186-192`) with parameterized `title` strings (`how this was figured out` / `how these were chosen`). The feed page renders its *own* hand-rolled version of the same shape inline (`app/page.tsx:743-808`) — that drift is named in audit red flag #5.

**What breaks if you remove:**

- The trace layer entirely → the user sees the stepper saying "active" and the skeletons holding the layout, but the work itself is invisible. The "this is actually doing something" reassurance is gone.
- The streaming append (vs append-on-done) → trace items appear all at once when the agent finishes, defeating the watch-the-work property.
- The sticky position → the trace scrolls off-screen as the main content grows, losing visibility during long runs.

**Code in this codebase — `app/page.tsx:560-568, 624-633, 743-808`** (the composition site on the feed — all four tiers assembled, with the trace layer as the sticky `<aside>`):

```
  // process stepper — monitoring runs here; the other two run on investigate
  <ProcessStepper
    monitoring={{
      state: monitoringState(status),                  ← 'active'/'complete'/'error'
      sub: monitoringSub(status, stepStatus,              from feed status flag
                         queryCount, insights.length),  ← live sub from stream events
    }}
    diagnostic={{ state: 'pending', sub: 'opens when you investigate' }}
    recommendation={{ state: 'pending', sub: 'opens when you investigate' }}
  />

  …

  // anomaly coverage grid — the category checklist, ABOVE the cards
  <CoverageGrid coverage={coverage} insights={insights}
                loading={status === 'loading' && !reconnecting} />

  // loading
  {status === 'loading' && !reconnecting && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Skeleton height={96} />                         ← four 96px-tall card-shaped
      <Skeleton height={96} />                            placeholders. when insights
      <Skeleton height={96} />                            arrive, this block unmounts
      <Skeleton height={96} />                            and the InsightCards mount
    </div>                                                in roughly the same space
  )}

  …

  // ── col 2 — live statuses / logs, so the user sees background work ──
  <aside style={{ position: 'sticky', top: 16, /* … */ }}>
    <div className="lowercase" style={{ /* sticky header */ }}>
      how this briefing was gathered ·{' '}
      {traceItems.length > 0
        ? `${queryCount} ${queryCount === 1 ? 'query' : 'queries'}`
        : '-- queries'}
      {status === 'loading' && ' · scanning…'}        ← the suffix that signals
    </div>                                                ongoing work
    <div style={{ padding: '10px 16px 16px' }}>
      {traceItems.length > 0 ? (
        <ReasoningTrace items={traceItems} />          ← real trace once events arrive
      ) : status === 'loading' ? (
        <p>connecting to the agent…</p>                ← placeholder before event #1
      ) : (
        <p>-- the agent's query-by-query trace…</p>    ← idle/demo-without-trace
      )}
    </div>
  </aside>
       │
       └─ this is the inline copy of StatusLog (audit red flag #5).
          the shared component (components/shared/StatusLog.tsx) does the same
          shape — used on both investigate pages. extracting this inline aside
          to use the shared component is the natural fold-along when app/page.tsx
          gets its hooks-extraction refactor.
```

### Move 3 — the principle

A long-running operation needs a multi-tier progress UI, not a single spinner. The tiers don't have to be elegant — they have to cover different time scales (synchronous render, first-paint, first-event, every-event) and different user questions (what stage / what shape / what coverage / what work). Each tier carries the user from one scale to the next so there's never a blank moment between any pair. The composition is the pattern; no individual component matters. And the failure mode of *removing* a tier isn't visual ugliness — it's the user thinking the page is broken.

---

## Primary diagram

The full composition on the feed page, with every tier labelled and the streaming data driving each one.

```
PROGRESSIVE COMPOSITION — the feed page during a live briefing

┌─ page-shell (max-w-5xl, py-10) ──────────────────────────────────────┐
│  ┌─ header ────────────────────────────────────────────────────────┐  │
│  │  blooming insights · your workspace, in bloom                    │  │
│  │  [demo|live] · live · real workspace data                        │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌─ STEPPER LAYER  (always renders, never blocks) ─────────────────┐  │
│  │  [1] monitoring anomalies   [2] investigating   [3] decision &  │  │
│  │      query 4 · selecting…       opens when you  recommendation  │  │
│  │      (pulsing teal)              investigate    (pending)       │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌─ TILE LAYER  CoverageGrid (10 cats · streams in) ──┐                │
│  │  anomaly coverage · 5 monitored · 1 firing · 0 no data            │
│  │  ┌─────┬─────┬─────┬─────┐                                        │
│  │  │ ✓   │ ✓   │ ●   │ ░░  │   ← per-category flip on coverage_item │
│  │  │clear│clear│anom │░░░░░│                                        │
│  │  └─────┴─────┴─────┴─────┘                                        │
│  └────────────────────────────────────────────────────────────────────┘
│                                                                        │
│  ┌─ MAIN GRID  (lg:grid-cols-3) ──────────────────────────────────┐   │
│  │  ┌─ col 1 (col-span-2) ──────┐   ┌─ col 2 (sticky aside) ────┐ │   │
│  │  │  SHAPE LAYER while loading │   │  TRACE LAYER (StatusLog)  │ │   │
│  │  │  ▓▓▓▓▓▓▓▓ (Skel h=96)      │   │  how this briefing was    │ │   │
│  │  │  ▓▓▓▓▓▓▓▓                  │   │  gathered · 5 queries     │ │   │
│  │  │  ▓▓▓▓▓▓▓▓                  │   │  ┌─────────────────────┐  │ │   │
│  │  │  ▓▓▓▓▓▓▓▓                  │   │  │ ▓▓▓ progress bar    │  │ │   │
│  │  │                            │   │  └─────────────────────┘  │ │   │
│  │  │  → on first insight event: │   │  ┃ MONITORING · thought  │ │   │
│  │  │    skeletons replaced by   │   │  ┃   "scanning revenue…" │ │   │
│  │  │    real InsightCards       │   │  ┃ ● list_metrics done   │ │   │
│  │  │                            │   │  ┃ ● select_events run…  │ │   │
│  │  │                            │   │  ┃ MONITORING · hyp.     │ │   │
│  │  └────────────────────────────┘   │  ┃   "cart_add anomalous"│ │   │
│  │                                    │  ┃ ● select_events done  │ │   │
│  │                                    │  └─────────────────────┐ │ │   │
│  │                                    │                          │ │   │
│  └─────────────────────────────────────┴──────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘

   data flow ──── one NDJSON stream drives every layer
   ────────
   coverage_item event   ──▶  CoverageGrid: flip 1 tile
   tool_call_start event ──▶  StatusLog: append "running…" row
                              + ProcessStepper sub: "query N · {name}"
                              + queryCount++
   reasoning_step event  ──▶  StatusLog: append step row
                              + ProcessStepper sub: latest content
   tool_call_end event   ──▶  StatusLog: replace row "running" → "Nms"
   insight event         ──▶  feed list: append InsightCard
   done event            ──▶  ProcessStepper: monitoring complete
                              + skeletons unmount, cards rendered
                              + StatusLog header: "5 queries" (no "·running…")
```

The diagram is the contract. One stream drives four UI tiers; each tier handles a different user question on a different time scale.

---

## Elaborate

**Where the pattern comes from.** Skeleton screens were popularized by Facebook and LinkedIn around 2013 as an alternative to spinners; the research finding was that *the perceived wait* depended more on whether the user could see structure forming than on the actual wait length. Stepper UIs come from checkout-flow design (Amazon, Shopify) where "you are at step 2 of 4" is a primary affordance. The two have always been used in combination on long-running operations, but the composition is so common that it doesn't have a standard name — each codebase reaches for the primitives and assembles them.

This codebase's twist is the per-category progressive disclosure in `CoverageGrid`. That's the specific shape of "coverage-of-a-checklist progress" — used elsewhere for things like CI test runners (each test flips from pending → running → pass/fail) or migration runners (each migration flips). The pattern is named in the build space ("test running indicators"), less so in product UIs.

**The deeper principle.**

```
Three rules for long-running operations:

  1. never let the screen be blank.
     someone clicked something. before any data has arrived, show that you saw
     the click — even just by laying out the page's eventual shape.

  2. fill silence at every order of magnitude.
     10ms (synchronous render) · 100ms (first event) · 1s (first response) ·
     10s (significant work done). user attention has a different question
     at each scale; answer them all.

  3. show the actual work, not a spinner.
     a spinner that runs for 30 seconds erodes trust ("is this stuck?"); a
     trace that streams reasoning steps and tool calls builds trust ("it's
     working — I can see what it's doing").

  the composition here is just rule 1 + rule 2 + rule 3 stacked vertically.
```

**Where it breaks down.**

1. **`prefers-reduced-motion` is partial.** The custom `bi-fade-up`, `bi-progress`, `bi-dots` animations *are* gated by the media query (`globals.css:42, 78-80`). The Tailwind `animate-pulse` utility is *not* — it's used in 15+ places (skeleton, status dots, pulsing badges) and continues to animate even when the user has indicated they don't want motion. Documented in `.aipe/audits/a11y-2026-06-02.md` Lens 5.
2. **No `aria-live` on the streaming surfaces.** The progressive disclosure is invisible to screen-reader users. The CoverageGrid's "checking N/10…", the StatusLog's running trace, the StreamingResponse's "thinking…" → answer transition — none are wrapped in a live region. The progressive UX is a sighted-user-only feature today. (Audit red flag #6; `.aipe/audits/a11y-2026-06-02.md` Lens 6.)
3. **Layout-shift only happens on the loaded transition.** The skeleton stack height (`<Skeleton height={96} />` × 4 = 384px + gaps) is *approximately* the loaded InsightCard stack height, but not exactly — insights vary in height based on copy length. There's a small CLS on the transition that perfect shape-mirroring would eliminate.
4. **The feed's inline StatusLog drifts from the shared component.** Two near-identical implementations means two places to update when the shape changes (audit red flag #5).

**What to explore next.**

- **The bigger SSR play.** Next.js 16 supports streaming SSR with `<Suspense>` boundaries. The first paint could ship the stepper + skeleton + empty CoverageGrid *server-rendered*, then hydrate and start streaming. Today everything is `'use client'` so the server-rendered HTML is empty. The shift would mean lifting the hook above the `'use client'` boundary or using a server-component wrapper that calls into a client-island for the streaming part. Non-trivial — a redesign, not a refactor.
- **Real `aria-live` regions on the streaming surfaces.** The smallest move: wrap `StatusLog` in `<div role="log" aria-live="polite">`. Bigger move: announce milestones only (diagnosis ready, N actions proposed) on `aria-live="assertive"` regions instead of every reasoning step.
- **Shape-true skeletons.** The `EvidencePanel` skeleton is the model — it mirrors the loaded shape (tiles + callout + hypothesis rows). The feed's `<Skeleton height={96} />` stack is generic. A `<InsightCardSkeleton />` that mirrors the real card's layout would reduce CLS to zero.

---

## Interview defense

### What they are really asking

"How do you handle long-loading states?" is asking: do you know the difference between a spinner and a multi-tier progress UI, do you understand that perceived performance is a different problem than real performance, and do you know how to compose framework primitives (skeletons, steppers, streaming logs) so the user never sees a blank moment.

### Q + A

**[mid] Walk me through what the user sees in the first 200ms after they land on the feed.**

The page-shell renders synchronously: header, ProcessStepper showing `monitoring anomalies` as ACTIVE with sub-line "scanning your workspace…", CoverageGrid with 10 dashed-border pending tiles, a stack of four 96px-tall skeleton placeholders for the eventual cards, and the sticky sidebar saying "connecting to the agent…". So in the first frame they see the stage they're at, the shape of the work that's coming, and a placeholder for the trace they're about to watch. No spinner. The 30-60s of agent work hasn't started, but the user already knows the system saw the click, knows what's coming, and has somewhere to look.

```
  t=0         page shell + ProcessStepper + Skeleton stack + empty CoverageGrid
              + "connecting to the agent…" — ALL synchronous
  t=200-500ms first coverage_item event arrives → one tile flips
              + first tool_call_start → trace gets its first row
              + ProcessStepper sub-line updates to "query 1 · list_metrics"
  t=3-15s     tile grid fills in, trace grows, ProcessStepper sub updates
              constantly with the latest reasoning step
  t=30-60s    `done` event → ProcessStepper monitoring goes COMPLETE,
              skeleton stack unmounts, InsightCards render
```

**[mid] Why not just use a spinner?**

A spinner answers exactly one question ("is something happening?") and gives zero information about what or how long. For a 30-60s wait that's the difference between trusting the system and reloading the page. The composition answers four questions at four different time scales: stepper says *which stage*, skeleton says *what shape*, tile grid says *what coverage*, trace says *what work*. Each fills in silence at a different order of magnitude. No moment is information-free.

**[senior] How does the layout not jump when content arrives?**

Two moves. The skeleton stacks (`<Skeleton height={96} />` × 4 on the feed; the shape-true skeleton in `EvidencePanel.tsx:62-99` on the investigate page) approximate the loaded content's vertical rhythm. The CoverageGrid renders all 10 tiles from frame 1 regardless of how many have been reported — each tile flips state in place without growing the grid. The single layout shift that does happen is when the skeleton stack unmounts and the real cards mount; the cards aren't perfectly the same height as the skeletons (CLS isn't zero). The fix would be component-shaped skeletons (`<InsightCardSkeleton />`) mirroring the real layout — not done yet.

**[arch] How does the CoverageGrid know which tiles are pending vs done without holding its own state?**

It's stateless. `CATEGORIES.map(...)` runs every render and produces all 10 tile rows. The state comes from the `coverage` prop — a `Map<categoryId, report>` built fresh each render from the array prop. If `byCat.get(cat.id)` returns a report, the tile renders live; if it returns undefined, the tile renders pending. The parent (the feed page) owns the array; each `coverage_item` stream event appends to it; the component just renders the projection. No effects, no useState in the component. The progressive disclosure is just React's reconciliation noticing that one tile's `coverageState` prop went from "unavailable-as-default" to "clear-as-reported."

### The dodge

**"Why not use a third-party component library for this — Mantine, Chakra, Radix?"**

Honest answer: the primitives are too small to be worth a dependency. Skeleton is 18 LOC, ProcessStepper is 139 LOC, StatusLog is 87 LOC. A library Stepper or Skeleton would lock the visual styling to that library's tokens, and the styling decisions here (dashed borders for pending, color-coded state, the specific badge shapes) are product-specific. The composition's value isn't in the primitives — it's in the assembly. A library version of any individual primitive wouldn't change the composition story.

### Anchors

- `components/shared/Skeleton.tsx:1-18` — the entire primitive
- `components/shared/ProcessStepper.tsx:25-29, 66-138` — the three-stage stepper
- `components/feed/CoverageGrid.tsx:61-115, 117-280` — the per-category progressive disclosure
- `components/shared/StatusLog.tsx:28-86` — the sticky sidebar wrapping ReasoningTrace
- `components/investigation/EvidencePanel.tsx:62-99` — the shape-true skeleton variant
- `app/page.tsx:561-568, 624, 626-633, 743-808` — the composition site on the feed

---

---

## See also

- [audit.md](./audit.md) — the rendering, component-architecture, and red-flags lenses all reference this composition.
- [01-ndjson-stream-reader-hook.md](./01-ndjson-stream-reader-hook.md) — the data-fetch primitive that feeds this composition's events.
- `study-system-design/05-streaming-ndjson.md` — the producer side: how the route emits the events that drive the tier transitions.
- `.aipe/audits/a11y-2026-06-02.md` — Lens 5 (Visual) and Lens 6 (Dynamic content) describe the a11y posture of these surfaces, including the gaps the composition has not addressed (`aria-live`, `prefers-reduced-motion` coverage of `animate-pulse`).
- `study-performance-engineering` — owns the actual measurement (FCP / LCP / TTI / CLS as numbers); this guide names the composition that drives perceived performance.

---

Generated: 2026-06-03 — `/aipe:study-frontend-engineering` (per `specs/study-frontend-engineering.md`).
