# Rendering, client, and mobile performance

**Industry name(s):** streaming UI · skeleton loaders · perceived performance · progressive rendering
**Type:** Industry standard · Language-agnostic

> blooming insights' client perf strategy is **"hide the latency, don't fight it."** The agents take ~100s to complete an investigation — that's a fixed cost set by external constraints (file 03). The UI's response is to **stream progress events from the first second** (NDJSON pipeline via React 19 + Web Streams API, `lib/hooks/useInvestigation.ts:184-208`), **render skeleton placeholders** while data is loading (`components/shared/Skeleton.tsx`, `components/feed/CoverageGrid.tsx`), and **show progressive states in the ProcessStepper** (`components/shared/ProcessStepper.tsx`) so the user always sees *something updating*. No Web Vitals are measured. No bundle analyzer is configured. No React Profiler is integrated. This is *applied* perceived-performance design without *measured* validation — the strategy is right; the meter is absent (same finding as file 02).

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Client performance has two halves: *actual* (LCP, INP, CLS, bundle size, JS execution time) and *perceived* (the user's experience of waiting). The two diverge when the actual numbers are large but the perceived experience is good — and blooming insights is exactly that shape. The investigation takes 100s, but the user sees the first reasoning step in ~1-2s, watches activity build, reads the diagnosis at ~30-60s, and the recommendations as they stream in. The bar isn't "make it fast"; the bar is "make it feel like work is happening." For this codebase, perceived-performance design is the *only* lever, because the actual latency is bounded externally.

```
  Zoom out — where rendering perf lives           ← we are here (UI band, perceived axis)

  ┌─ UI (Next.js 16 App Router, React 19) ───────────────────────────────┐
  │                                                                       │
  │  Server-rendered shell    + client-component pages (use client)      │
  │  app/page.tsx             feed view                                   │
  │  app/investigate/[id]/page.tsx   investigation view                  │
  │                                                                       │
  │  ★ NDJSON streaming reader (useInvestigation hook) ★                  │
  │     reads chunks as they arrive; appends to state per event           │
  │                                                                       │
  │  Skeleton placeholders during loading                                 │
  │  ProcessStepper showing pipeline state                                │
  │  StatusLog showing live agent thoughts + tool calls                   │
  │                                                                       │
  │  no Web Vitals measurement                                            │
  │  no React Profiler integration                                        │
  │  no bundle analyzer                                                   │
  └──────────────────────┬────────────────────────────────────────────────┘
                         │ HTTPS + chunked NDJSON
  ┌─ Route ────────────▼──────────────────────────────────────────────────┐
  │  ReadableStream sends events as they happen                           │
  │  REPLAY_DELAY_MS = 140/180 paces the demo replay                      │
  │  (paced for readable UX, NOT for backpressure)                        │
  └───────────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *the agent is slow by external constraint — what does the UI do to make the wait survivable?* The answer is four moves: stream events progressively (so the page is never frozen), skeleton placeholders (so the layout doesn't reflow when data arrives), pipeline stepper (so the user knows what phase they're in), and live status log (so the user can read the agent's reasoning as it happens). Below, you'll see each move, the React 19 streaming pattern that powers them, and the absent measurement that would *validate* the strategy is working.

---

## Structure pass

**Layers.** Two bands relevant to client perf: the server route (which writes NDJSON chunks) and the browser (which reads them and updates React state). Everything else is server-side.

**Axis: time-to-feedback.** Hold one question constant across both bands: *how long until the user sees something change?* Time-to-feedback is the right axis for client perf because perceived latency is bounded by it. Actual latency (file 03) is the wall-clock cost of the operation; time-to-feedback is the *user-experienced* version. For this system, actual is ~100s but time-to-feedback is ~1-2s — a ~50× perceived speedup that's pure UX engineering.

**Seams.** Two load-bearing.

- **R1: render boundary.** Server-rendered shell ↔ client-component interactivity. Pages start as server-rendered HTML (cheap, fast first paint) and hydrate on the client (where the streaming reader takes over). The seam is where actual measurements would split — LCP is mostly server-side; INP is mostly client-side.
- **R2: state arrival.** Stream chunk arrives ↔ React state updates. Every NDJSON line triggers a `setState` call (`useInvestigation.ts:97-150`), which schedules a re-render. The frequency (~100-200 setState calls per investigation) is *not* throttled — each event causes a synchronous state update. For this load level it's fine; at higher event-rates it would warrant `unstable_batchedUpdates` or a manual buffer.

```
  Structure pass — Rendering / client perf

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  Server route · Browser                           │
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  time-to-feedback: how long until the user sees   │
  │  something change?                                │
  └────────────────────────┬─────────────────────────┘
                           │  trace it across layers
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  R1: render boundary  (server shell → client hydration)│
  │  R2: state arrival    (chunk → setState per event)★    │
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest walks the four UX moves, the React 19 streaming pattern, and the absent measurement.

---

## How it works

### Move 1 — the mental model

You've built a React form where the submit button shows a spinner while the request flies, then renders the response. blooming insights is the same shape *scaled up over 100 seconds*: instead of "spinner → response," it's "skeleton + first event → more events streaming → diagnosis → more events → recommendations → done." The user is never staring at a blank page; the page is *always* doing something. The trick is the NDJSON stream + Web Streams API — the browser reads chunks as they arrive, and each chunk is one update to one piece of state.

```
  Pattern — perceived-performance kernel

   USER         CLICK
   PAGE         ┌─────────────────────────────────────────┐
                │ render skeleton + ProcessStepper (active)│
                └─────────────────────────────────────────┘
                          │
                          ▼  fetch /api/agent  (stream opens)
                ┌─────────────────────────────────────────┐
                │ first event arrives (~1-2s)              │
                │ StatusLog renders first thought          │
                └─────────────────────────────────────────┘
                          │
                          ▼  more events stream in
                ┌─────────────────────────────────────────┐
                │ tool calls appear, durations resolve     │
                │ user sees live progress                  │
                └─────────────────────────────────────────┘
                          │
                          ▼  diagnosis event (~30-60s)
                ┌─────────────────────────────────────────┐
                │ EvidencePanel renders (skeleton replaced)│
                │ recommendation button appears            │
                └─────────────────────────────────────────┘
                          │
                          ▼  done event (~100s)
                ┌─────────────────────────────────────────┐
                │ status panel finalizes                   │
                │ stream closes                            │
                └─────────────────────────────────────────┘

   what the user feels: continuous progress (the page is alive)
   what the wall clock says: 100s
```

The mental model: **the wall clock doesn't change; the user's experience of it does**. Every UX move in this file is about converting the 100s of actual latency into ~1-2s of perceived "frozen" time. Streaming + skeletons + stepper + log = the user never thinks the page is broken.

---

### Move 2 — the four UX moves, one at a time

#### Move 2.1 — Streaming the route response (NDJSON)

The route handler returns a `ReadableStream<Uint8Array>` (`app/api/agent/route.ts:169`, `app/api/briefing/route.ts:178`). Each emitted event is one NDJSON line, written to the controller as soon as it's available. The browser reads chunks from `response.body.getReader()` and parses each line into an event.

```
  Pattern — NDJSON streaming, server → browser

   server (Next.js route handler):
     const stream = new ReadableStream({
       async start(controller) {
         const send = (e) => controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
         // ... agent runs, calling send(...) per event ...
         send({ type: 'done' });
       },
     });
     return new Response(stream, {
       headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8',
                  'Cache-Control': 'no-cache, no-transform' }       ← no buffering
     });

   browser (useInvestigation hook):
     const res = await fetch(url);
     const reader = res.body.getReader();
     const dec = new TextDecoder();
     let buf = '';
     for (;;) {
       const { done, value } = await reader.read();
       if (done) break;
       buf += dec.decode(value, { stream: true });                  ← accumulate chunk
       const lines = buf.split('\n');                                ← split on newline
       buf = lines.pop() ?? '';                                     ← keep partial line
       for (const line of lines) {
         if (!line.trim()) continue;
         handle(JSON.parse(line));                                   ← per-event dispatch
       }
     }
```

The boundary: **`Cache-Control: no-cache, no-transform` is load-bearing**. Without `no-transform`, gzip middleware (Vercel's edge or any intermediate proxy) might buffer the response until it's complete to compress more efficiently — defeating the streaming. The header tells every intermediary "do not buffer, do not transform." That's what makes the user see the first event in ~1-2s instead of at ~100s.

The other boundary: **the `buf.split('\n')` + `buf = lines.pop()` pattern handles partial lines correctly**. If a chunk arrives with `'{"type":"reasoning_step",...}\n{"type":"tool_call_start"`, the first line is complete and dispatched; the partial `{"type":"tool_call_start"` is kept in the buffer for the next chunk. Without this, partial JSON would throw on parse.

#### Move 2.2 — Skeleton placeholders

`components/shared/Skeleton.tsx` is a 20-line component: a div with `animate-pulse` class, configurable height/width, surface-color background. Used wherever data hasn't arrived yet — most visibly in the investigation page (`app/investigate/[id]/page.tsx`) and the recommendation list (`components/investigation/RecommendationCardSkeleton.tsx`).

```
  Pattern — skeleton placeholder

   while data is loading:
     <Skeleton height={80} width="100%" />
     ⇒ renders a pulsing rectangle the same size as the real content

   when data arrives:
     <RealComponent data={data} />
     ⇒ renders in place, no layout shift

   WHY THIS MATTERS for perf:
     CLS (Cumulative Layout Shift) is a Web Vital — the page jumping
     around as content arrives is a measurable UX failure. Skeleton
     placeholders pre-allocate the layout so when real content arrives,
     it slides in without reflowing the rest of the page.

   WHY THIS MATTERS for perceived perf:
     a skeleton is "loading and I know what's coming." A blank space is
     "broken or maybe empty." Same wall-clock time, different mental model.

   blooming insights does NOT measure CLS — but it ships skeletons in
   the right places anyway. The strategy is correct; the validation
   is absent.
```

The boundary: **skeletons only work if they match the real content's dimensions**. A skeleton that's 80px tall but the real content is 200px tall causes a layout shift when it loads — the very thing skeletons exist to prevent. The blooming insights skeletons match the real components (recommendation cards, evidence panels) by size.

#### Move 2.3 — ProcessStepper (the pipeline state)

`components/shared/ProcessStepper.tsx` is the visible pipeline status: three steps (monitoring → diagnostic → recommendation), each with a state (`pending` / `active` / `complete` / `error`) and a sub-line of human-readable status. The investigation page (`app/investigate/[id]/page.tsx:115-119`) updates the stepper as the streaming events arrive.

```
  Pattern — ProcessStepper

   three steps, three states each:
     ┌──────────────┬──────────────┬──────────────┐
     │ ✓ monitoring │ ◌ diagnostic │   recommend  │   ← active middle, pending right
     │   complete   │ ◐ testing... │   awaiting   │
     └──────────────┴──────────────┴──────────────┘
                       ↑
                       │ animate-pulse class when active
                       │ sub-line updates with current status

   states drive visible style:
     pending:  outlined number, text-tertiary
     active:   filled accent, animate-pulse, text-primary
     complete: filled accent + ✓ glyph
     error:    coral background + ! glyph

   WHY THIS MATTERS for perceived perf:
     the user sees WHICH PHASE they're in. A flat spinner says "loading."
     A pipeline stepper says "loading specifically: testing hypotheses
     right now, then proposing actions." That's the difference between
     "stuck" and "making progress."
```

The boundary: **the stepper must update *immediately* when the phase changes**. If the recommendation phase starts but the stepper still says "testing hypotheses…", the UI lies. The investigation page wires `diagState` and `recState` to the live `diagnosis` and `complete` flags from the hook, so the stepper transitions the moment those flags flip.

#### Move 2.4 — StatusLog (the live thought log)

`components/shared/StatusLog.tsx` renders the agent's `reasoning_step` events and `tool_call_start`/`tool_call_end` events as a scrollable list. The user can read the agent's thoughts in real time and see which tools fired.

```
  Pattern — StatusLog

   for each event in the stream:
     - reasoning_step (kind=thought):  render as italic line
     - reasoning_step (kind=hypothesis): render with diagnostic style
     - reasoning_step (kind=conclusion): render with conclusion style
     - tool_call_start: render "running execute_analytics_eql..."
     - tool_call_end: replace the matching start with duration
                       "execute_analytics_eql · 1.2s"

   replaceRunningTool function (useInvestigation.ts:86-95):
     walks the items array backwards, finds the last matching running tool,
     replaces it in place with the done state + duration

   WHY THIS MATTERS for perceived perf:
     the agent's thoughts read like a colleague working through a problem.
     "let me check conversion in the last 30 days first... ok, that's
     normal... let me look at the previous 30 days..." The user FEELS the
     thinking happening, not just a spinner.

   WHY THIS MATTERS for trust:
     showing the agent's reasoning + tool calls + durations builds trust.
     a black box that takes 100s is suspicious; a glass box that takes
     100s is collaborative.
```

The boundary: **the list grows monotonically per investigation** (~50-100 items). Each `setState` triggers a re-render. For this volume it's fine; if event rates jumped (say a streamed-text agent emitting per-token events), the per-event setState would become a bottleneck and warrant `useReducer` + manual batching.

---

### Move 2.5 — current state vs the absent measurement

Everything above is *applied* perceived-performance design that works. None of it is *validated* by measurement.

```
  Phase A — what's shipped (current)
  ────────────────────────────────────
   NDJSON streaming           ✓ (route + hook)
   Skeleton placeholders      ✓ (Skeleton.tsx, RecommendationCardSkeleton.tsx,
                                 CoverageGrid loading prop)
   ProcessStepper             ✓ (three states + sub-line)
   StatusLog                  ✓ (live thoughts + tool durations)
   Demo replay paced          ✓ (REPLAY_DELAY_MS 140/180)
   Cache-Control no-transform ✓ (prevents intermediary buffering)

  Phase B — what's absent (would-be validation)
  ──────────────────────────────────────────────
   Web Vitals (LCP/INP/CLS)   ✗ no measurement
   Vercel Speed Insights       ✗ not enabled
   React Profiler integration  ✗ not used
   Bundle analyzer             ✗ no @next/bundle-analyzer config
   Time-to-first-event metric  ✗ not logged (would be ~1-2s, untracked)
   Time-to-diagnosis metric    ✗ not logged (would be ~30-60s, untracked)
   Per-event render cost       ✗ not profiled
```

The gap: **the strategy is right (stream + skeleton + stepper + log); nothing proves it's still right after a refactor**. If a future change adds a heavy synchronous parse to the per-event handler and the time-to-first-event goes from 1-2s to 5s, no measurement would catch it. The fix is the same as file 02: add the meter (Web Vitals via `next/web-vitals`, or per-event timing via `performance.mark`).

---

### Move 3 — the principle

**Perceived performance is a UX strategy, not a measurement.** The four moves in this file (streaming, skeletons, stepper, log) all *work* — they hide the 100s of actual latency behind ~1-2s of time-to-feedback. But "they work" today is a *belief*, not a *fact*, because no measurement validates it. The right discipline is: ship the UX moves first (the cheap part), then add Web Vitals + per-event timing (the cheaper part) so a regression doesn't land silently. blooming insights has done the first half; the second half is still pending.

---

## Primary diagram

The full client perf picture — what's shipped, what bounds it, what's missing.

```
  blooming insights — client perf at a glance

  ┌─ Server route ─────────────────────────────────────────────────────────┐
  │                                                                         │
  │  ReadableStream out                                                    │
  │  - one NDJSON line per event                                           │
  │  - Cache-Control: no-cache, no-transform  (prevents buffering)         │
  │  - REPLAY_DELAY_MS = 140/180 paces demo replay                         │
  │  app/api/agent/route.ts:131-139, :167-264                              │
  │  app/api/briefing/route.ts:97-143, :178-258                            │
  └────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ HTTPS chunked stream
                                  ▼
  ┌─ Browser ──────────────────────────────────────────────────────────────┐
  │                                                                         │
  │  ┌─ Read pipeline (useInvestigation hook) ────────────────────────────┐│
  │  │  fetch → response.body.getReader() → TextDecoder → split('\n')     ││
  │  │  per line: JSON.parse → handle(event) → setState                    ││
  │  │  ★ ~100-200 setState calls per investigation, no batching          ││
  │  │  lib/hooks/useInvestigation.ts:184-208                             ││
  │  └────────────────────────────────────────────────────────────────────┘│
  │                                                                         │
  │  ┌─ UX moves (4 patterns) ────────────────────────────────────────────┐│
  │  │                                                                     ││
  │  │  1. Skeleton placeholders                                          ││
  │  │     components/shared/Skeleton.tsx                                  ││
  │  │     components/investigation/RecommendationCardSkeleton.tsx         ││
  │  │     CoverageGrid `loading` prop renders skeleton tiles              ││
  │  │                                                                     ││
  │  │  2. ProcessStepper (three states × three steps)                     ││
  │  │     components/shared/ProcessStepper.tsx                            ││
  │  │     active step shows animate-pulse, sub-line updates live          ││
  │  │                                                                     ││
  │  │  3. StatusLog (live thoughts + tool calls)                          ││
  │  │     components/shared/StatusLog.tsx                                 ││
  │  │     replaceRunningTool replaces in-place when duration arrives      ││
  │  │                                                                     ││
  │  │  4. Streaming reveals (e.g. CoverageGrid fills tile-by-tile)        ││
  │  │     commit 7b5707b shipped this for the briefing flow               ││
  │  └────────────────────────────────────────────────────────────────────┘│
  │                                                                         │
  │  ┌─ Hydration model ──────────────────────────────────────────────────┐│
  │  │  Next.js 16 App Router                                              ││
  │  │  app/page.tsx, app/investigate/[id]/page.tsx are 'use client'       ││
  │  │  server-rendered shell, client hydrates and opens stream            ││
  │  └────────────────────────────────────────────────────────────────────┘│
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ NOT MEASURED ─────────────────────────────────────────────────────────┐
  │  Web Vitals (LCP / INP / CLS)                                          │
  │  Time-to-first-event (~1-2s, untracked)                                │
  │  Time-to-diagnosis (~30-60s, untracked)                                │
  │  Time-to-done (~100s, untracked)                                       │
  │  Bundle size (no @next/bundle-analyzer)                                │
  │  React render cost (no React Profiler integration)                     │
  │  setState frequency under high event rate (no observation)             │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ NOT EXERCISED (mobile/native) ────────────────────────────────────────┐
  │  Mobile-specific perf (e.g. touch latency, viewport optimizations)     │
  │  PWA / offline (no service worker)                                     │
  │  Native mobile (this is a web app, not React Native)                   │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases — where each UX move appears

- **NDJSON streaming** — both `/api/agent` and `/api/briefing` return `ReadableStream<Uint8Array>` responses. The browser-side reader lives in `useInvestigation` (for investigations) and inline in `app/page.tsx` (for the feed briefing).
- **Skeleton placeholders** — `EvidencePanel` shows skeletons while diagnosis loads; `RecommendationCardSkeleton` shows three placeholder cards while recommendations stream in; `CoverageGrid` renders pending tiles while categories resolve.
- **ProcessStepper** — both the feed (`app/page.tsx`) and the investigation page show the three-step stepper, with the current step `active` (pulsing) and the others `pending` or `complete`.
- **StatusLog** — the investigation page's right column shows live agent activity; the feed shows it for the monitoring scan. Each event triggers an in-place update.
- **Streaming reveal (CoverageGrid)** — commit `7b5707b` made the coverage grid fill tile-by-tile in step with the checklist log lines, instead of all-at-once.

### Code side by side

**The NDJSON read loop in useInvestigation — chunk handling done right.**

```
  lib/hooks/useInvestigation.ts  (lines 184–208)

  const res = await fetch(url);
  // ... auth / error checks ...

  const reader = res.body.getReader();                          ← Web Streams API reader
  const dec = new TextDecoder();
  let buf = '';                                                  ← buffer for partial lines
  for (;;) {
    const { done, value } = await reader.read();                ← pull next chunk
    if (done) break;
    buf += dec.decode(value, { stream: true });                 ← decode bytes, keep multi-byte state
    const lines = buf.split('\n');                              ← split on newline
    buf = lines.pop() ?? '';                                    ← keep the tail (partial line)
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line) as AgentEvent);                 ← per-event dispatch
      } catch {
        /* ignore malformed line */
      }
    }
  }
  if (buf.trim()) {                                             ← flush any final line
    try { handle(JSON.parse(buf) as AgentEvent); } catch { /* */ }
  }
        │
        └─ THREE robustness details:
           (1) `dec.decode(value, { stream: true })` handles multi-byte
               characters that may split across chunk boundaries
           (2) `buf = lines.pop()` keeps the partial last line (which
               doesn't yet have a newline) for the next iteration
           (3) the trailing buf.trim() handles the case where the stream
               ends mid-line (which shouldn't happen with NDJSON but is
               defensive)
```

**The event handler — each event maps to one setState (no batching).**

```
  lib/hooks/useInvestigation.ts  (lines 97–151, abbreviated)

  const handle = (e: AgentEvent) => {
    switch (e.type) {
      case 'reasoning_step': {
        const it: TraceItem = { kind: 'step', id: e.step.id, ... };
        cItems.push(it);
        setItems((p) => [...p, it]);                            ← state update per event
        break;
      }
      case 'tool_call_start': {
        const it: TraceItem = { kind: 'tool', id: ..., status: 'running', ... };
        cItems.push(it);
        setItems((p) => [...p, it]);                            ← state update per event
        break;
      }
      case 'tool_call_end':
        replaceRunningTool(cItems, e);
        setItems((p) => replaceRunningTool([...p], e));         ← state update per event
        break;
      case 'diagnosis':
        cDiag = e.diagnosis;
        setDiagnosis(e.diagnosis);                              ← state update per event
        break;
      // ... etc ...
    }
  };
        │
        └─ ~100-200 setState calls per investigation. Each call schedules
           a re-render. React 18+ batches automatic updates within the
           same task, but cross-await boundaries (like the read loop) are
           NOT batched. For this load (~100-200 events over ~100s, so
           ~1-2 events/sec average), this is fine. At higher rates (e.g.
           streamed text-block deltas), this would warrant useReducer +
           a deliberate flush, or unstable_batchedUpdates / startTransition.
```

**The skeleton component — simple and correctly sized.**

```
  components/shared/Skeleton.tsx  (full file, 19 lines)

  interface SkeletonProps {
    height?: number | string;
    width?: number | string;
  }

  export default function Skeleton({ height = 80, width = '100%' }: SkeletonProps) {
    return (
      <div
        className="animate-pulse"                                ← Tailwind: pulsing opacity animation
        style={{
          background: 'var(--bg-surface)',
          borderRadius: 4,
          height,                                                ← caller specifies dimensions
          width,
        }}
      />
    );
  }
        │
        └─ minimal API; correctness depends on the caller passing
           dimensions that match the real content. Used at 80px default
           but explicitly sized in RecommendationCardSkeleton etc.
```

**The ProcessStepper — three states drive three visible styles.**

```
  components/shared/ProcessStepper.tsx  (lines 47–64)

  function badgeStyle(state: StepState): CSSProperties {
    const base: CSSProperties = {
      width: 22, height: 22, borderRadius: '50%',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '0.7rem', fontFamily: 'var(--font-mono), monospace',
      flexShrink: 0,
    };
    if (state === 'complete' || state === 'active')                ← both filled (active also pulses)
      return { ...base, background: 'var(--accent-teal)', color: 'var(--bg-base)' };
    if (state === 'error')
      return { ...base, background: 'var(--accent-coral)', color: 'var(--bg-base)' };
    return { ...base, border: '1px solid var(--border)', color: 'var(--text-tertiary)' };
  }                                                                 ← pending = outlined only
        │
        └─ STATE → STYLE mapping in one place. The investigation page
           computes `diagState` and `recState` from live data and hands
           them in. The stepper itself is pure presentation — no fetch,
           no state machine. The animate-pulse on the active badge
           (applied at line 109) is the visible "I'm working" signal.
```

**The CoverageGrid streaming reveal — commit 7b5707b's improvement.**

```
  app/api/briefing/route.ts  (lines 109–119)

  step('matching the workspace schema to the 10-category anomaly checklist…');
  const coverageLines = coverageChecklistSteps(coverage);
  coverage.forEach((item, i) => {
    step(coverageLines[i]);                                       ← log line per category
    send({ type: 'coverage_item', item });                        ← one tile per category
  });
        │
        └─ BEFORE commit 7b5707b: the whole coverage report was sent as
           one event ⇒ all 10 tiles appeared at once.
           AFTER 7b5707b: one tile resolves per checklist line ⇒ the grid
           fills progressively in step with the log. Same wall-clock
           time, dramatically different felt experience.
           This is perceived-perf in commit shape: zero actual speedup,
           significant UX win.
```

---

## Elaborate

**Where this pattern comes from.** Perceived performance as a design discipline traces to the Nielsen Norman Group's UX research from the late 90s: humans tolerate latency *much* better when they can see progress, and intolerably when they can't. The 0.1s / 1s / 10s thresholds (instant / responsive / attention-span-broken) are foundational. The web's specific tools — skeleton screens, optimistic UI, progressive disclosure — all serve the same goal: make the user *feel* the system is working. Streaming responses (chunked HTTP, NDJSON, Server-Sent Events) are the modern incarnation: ship bytes incrementally so the user sees something within the responsiveness threshold even if completion takes minutes.

**Why React 19 + Web Streams API matters here.** Older React versions had less batching control and Streams API was less common. React 19's automatic batching covers same-task updates well; the manual `setItems((p) => [...p, it])` pattern in the hook is idiomatic and works correctly under StrictMode (the `startedRef.current` guard prevents the double-mount issue called out in the file's NOTE comment). Web Streams API (`response.body.getReader()`) is the standard way to read incremental responses; older code would have used `EventSource` or polling. The combination is what makes the streaming pattern in this codebase concise.

**Why no Web Vitals is the same finding as file 02.** Both files end at the same gap: applied design without measured validation. File 02's `res.usage` is the cheapest unread meter; this file's Web Vitals is the cheapest UX meter. Both are five-line additions; both unblock real measurement. The next-gen Next.js makes Web Vitals trivial — `import { useReportWebVitals } from 'next/web-vitals'` plus a callback that posts to `/api/telemetry` is the whole integration.

**Connection to adjacent concepts.** File 03 explains why the actual latency is unmovable (external constraints). File 05 explains the streaming pipeline from the I/O lens. File 08 ranks "no Web Vitals" as a finding alongside "no res.usage."

---

## Interview defense

### Q: An investigation takes 100 seconds. Why doesn't the user perceive it as slow?

**Answer:** Four UX moves that convert ~100s of actual latency into ~1-2s of time-to-feedback. (1) NDJSON streaming — the first reasoning step lands in ~1-2s; the user sees activity immediately. (2) Skeleton placeholders — the layout doesn't shift when content arrives, so the page feels stable. (3) ProcessStepper — the user sees *which phase* is running ("diagnostic: testing hypotheses…"), not just "loading." (4) StatusLog — the agent's thoughts and tool calls stream into a log; the user can read along. The wall-clock time is unchanged; the experience is transformed. The honest gap: none of this is *measured* — no Web Vitals, no time-to-first-event metric. The strategy is applied, not validated.

```
  100s of latency, broken down by perceived experience

   0.0s   click "investigate"
   0.1s   ProcessStepper + skeletons render (server shell)
   1-2s   first reasoning_step event arrives → log starts
   3-10s  bootstrap done, first tool call appears
   30-60s diagnosis event arrives → EvidencePanel renders
   60-90s recommendation events stream in
   100s   done, stream closes
```

### Q: What's the cost of the per-event setState pattern in useInvestigation?

**Answer:** Each NDJSON event triggers one `setState`, which schedules a re-render. For ~100-200 events over ~100s, that's ~1-2 events/sec on average — well within React's comfortable range. The cost: each re-render walks the StatusLog component (typically 10-100 items by mid-run) and reconciles the list. At this volume, total render time per investigation is single-digit seconds (mostly idle between events). The boundary: if event rates jumped (e.g. a streamed text-delta agent emitting per-token events at ~50/sec), the per-event setState would become a bottleneck and need batching — useReducer with a manual flush, or `startTransition` to mark updates as non-urgent. For today's load, plain setState is correct.

### Q: There's no Web Vitals measurement and no React Profiler. How would you add the cheapest meter?

**Answer:** `import { useReportWebVitals } from 'next/web-vitals'` in `app/layout.tsx`, plus a callback that posts to `/api/telemetry` (or just `console.log` to Vercel function logs). Total: ~10 lines. This gets you LCP, INP, CLS, FCP, TTFB out of the box. For per-investigation timing (time-to-first-event, time-to-done), wrap the `fetch` call in `useInvestigation` with `performance.now()` markers and emit them on `done`. Both are smaller than fixing the corresponding gap in file 02 (`res.usage` logging), and both unblock the "is the UX strategy working?" question that's currently a belief.

```
  cheapest perf meter on the client

   1. add useReportWebVitals in app/layout.tsx
      → LCP, INP, CLS, FCP, TTFB on every page load
   2. wrap fetch in useInvestigation with performance.now()
      → time-to-first-event, time-to-done per investigation
   3. ship both to /api/telemetry (or console.log)
      → first time anyone can answer "is this fast enough?"

   total cost: ~20 lines
   total value: turns belief into fact
```

---

## Validate

**Level 1 — Reconstruct.** Name the four perceived-performance moves in blooming insights' UI and the files they live in. (Answer: (1) NDJSON streaming — `useInvestigation.ts:184-208` (reader), `app/api/agent/route.ts:131-264` and `app/api/briefing/route.ts:97-258` (writer); (2) Skeleton placeholders — `components/shared/Skeleton.tsx`, `components/investigation/RecommendationCardSkeleton.tsx`; (3) ProcessStepper — `components/shared/ProcessStepper.tsx`; (4) StatusLog — `components/shared/StatusLog.tsx`. Bonus: streaming reveals — commit `7b5707b` for the CoverageGrid tile-by-tile fill.)

**Level 2 — Explain.** Why is `Cache-Control: no-cache, no-transform` load-bearing for the streaming pattern? (Answer: `no-cache` prevents intermediaries from caching the response (an investigation is per-request unique). `no-transform` prevents intermediaries (CDN edges, proxies, gzip middleware) from buffering the response to compress or transform it more efficiently — buffering would defeat the streaming entirely, making the user wait until the full response is ready. Without `no-transform`, the user might see all events at ~100s instead of the first event at ~1-2s.)

**Level 3 — Apply.** A new agent type streams text deltas at ~50 events/sec (instead of the current ~1-2). What's the first thing that breaks, and what's the fix? (Answer: the per-event `setState` in the useInvestigation hook starts to dominate render time. At 50 events/sec × ~10ms per re-render of a growing list = ~500ms of CPU per second, which means lag and dropped frames. The fix: switch from per-event setState to a useReducer + buffered flush — accumulate events in a ref, flush every ~16ms (one animation frame) via `requestAnimationFrame`. Alternative: wrap each setState in `startTransition` to mark them as non-urgent, letting React skip them under pressure. Either approach trades per-event freshness for sustained framerate.)

**Level 4 — Defend.** A reviewer says "the user waits 100 seconds — no UX is going to fix that. Show them a spinner and let them browse another tab." Defend. (Answer: the empirical evidence (NN/g research, dozens of streaming UI deployments) is that users *do* perceive streamed work very differently from monolithic waits. A spinner at 100s is read as "broken or stuck"; a streaming log at 100s is read as "the system is working through my problem." The blooming insights design takes the second path — the user can read the agent's thoughts as they happen, which builds trust *and* fills the wait with content. The honest gap is that none of this is *measured*: we don't have time-to-first-event tracking, no Web Vitals, no validation that the strategy is working. The fix isn't "ship the spinner"; the fix is "add the meter so we know the streaming UX is doing its job.")

---

## See also

- `02-measurement-baselines-and-profiling.md` — the same "design without measurement" gap on the server side
- `03-latency-throughput-and-tail-behavior.md` — the actual latency the UI is hiding
- `05-io-network-and-database-bottlenecks.md` — the NDJSON streaming pipeline from the I/O lens
- `08-performance-red-flags-audit.md` — "no Web Vitals" as a finding
- `.aipe/study-system-design/01-system-design/02-request-response-and-data-flow.md` — the NDJSON flow from the request-shape lens
