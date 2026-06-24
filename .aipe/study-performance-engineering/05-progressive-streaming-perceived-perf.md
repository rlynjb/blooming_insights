# Progressive streaming as perceived performance

**Industry name(s):** progressive streaming · perceived performance · NDJSON streaming · streaming UI · time-to-feedback
**Type:** Industry standard

> blooming insights' UI strategy is **"hide the latency, don't fight it."** An investigation takes ~100s end-to-end — that's a fixed cost set by external constraints (Bloomreach's rate limit, Anthropic's latency variance, the route's 300s ceiling). The UI's response is to **stream events from the first second** so the user sees activity within ~1-2s, *not* at ~100s. Four UX moves work together: NDJSON streaming (server emits events as they happen, client reads chunk-by-chunk), skeleton placeholders (layout doesn't shift when data arrives), a ProcessStepper (visible pipeline state — "diagnostic: testing hypotheses…"), and a StatusLog (live agent thoughts + tool calls with durations). The wall clock doesn't change; the user's experience of it transforms from "frozen page" to "visible work in progress." The pattern's load-bearing line is `Cache-Control: no-cache, no-transform` (`lib/state/headers.ts` or wherever `NDJSON_HEADERS` is defined; used in `app/api/agent/route.ts` and `app/api/briefing/route.ts`) — without `no-transform`, any intermediary gzip middleware could buffer the response until complete, defeating the streaming entirely.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Client performance has two halves: *actual* (LCP, INP, CLS, bundle size, JS execution time) and *perceived* (how the user experiences waiting). The two diverge when actual numbers are large but the experience is good — and that's exactly the blooming insights shape. Actual investigation latency is ~100s; perceived time-to-feedback is ~1-2s. The ~50× perceived speedup isn't a real speedup — it's UX engineering. For this system, perceived-performance design is the *only* lever, because the actual latency is bounded externally and can't be reduced by client code.

```
  Zoom out — where progressive streaming lives

  ┌─ Browser (React 19 client) ────────────────────────┐
  │  fetch → response.body.getReader() (Web Streams)   │
  │  per chunk: split('\n') → JSON.parse → setState    │
  │  ★ skeleton + ProcessStepper + StatusLog ★         │  ← we are here
  └────────────────────────┬────────────────────────────┘
                           │ HTTPS, chunked transfer
  ┌─ Server route (Next.js 16) ─▼─────────────────────┐
  │  ReadableStream — controller.enqueue per event     │
  │  Cache-Control: no-cache, no-transform             │
  │  one NDJSON line per event                         │
  └────────────────────────┬────────────────────────────┘
                           │
  ┌─ Agent loop ──────────▼───────────────────────────┐
  │  emits reasoning_step, tool_call_start,            │
  │  tool_call_end, diagnosis, recommendation events   │
  │  ~100-200 events per investigation                 │
  └─────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *the agent run is ~100s; what does the UI do to make that wait survivable, and what's the load-bearing technical detail?* The answer is *four UX moves (streaming, skeletons, stepper, log) anchored on NDJSON chunk-by-chunk delivery; the load-bearing detail is `Cache-Control: no-cache, no-transform` to prevent intermediary buffering.* Below, you'll see the streaming kernel, each UX move's role, the failure mode if any one is broken, and the absent measurement that would *validate* the strategy.

---

## Structure pass

**Layers.** Two relevant bands. The server route writes NDJSON chunks; the browser reads them and updates React state. Everything else is server-side (agent loop, MCP, Anthropic) — not relevant to perceived perf.

**Axis: time-to-feedback.** Hold one question constant across both bands: *how long until the user sees something change after they click?* Time-to-feedback is the right axis for perceived perf because perceived latency is *bounded* by it. Actual latency (the agent's 100s) is the wall-clock cost; time-to-feedback is the *user-experienced* version. For this system, actual is ~100s but time-to-feedback is ~1-2s — a ~50× perceived speedup that's pure UX engineering.

**Seams.** Three load-bearing.

- **PS1: render boundary.** Server-rendered shell ↔ client-component interactivity. Pages start as server-rendered HTML (cheap, fast first paint) and hydrate on the client (where the streaming reader takes over). Actual metrics split across this seam — LCP is mostly server-side; INP is mostly client-side.
- **PS2: chunk arrival ↔ React state update.** Every NDJSON line triggers a `setState` call (`lib/hooks/useInvestigation.ts:97-150`), which schedules a re-render. The frequency (~100-200 setState calls per investigation) is *not* throttled — each event causes a synchronous state update. Fine at today's ~1-2 events/sec rate; would matter at higher rates.
- **PS3: intermediary handling.** The HTTP response travels through unknown intermediaries (Vercel edge, possibly CDNs, possibly corporate proxies). A buffering intermediary defeats streaming entirely — the user waits ~100s for the full response instead of ~1-2s for the first chunk. The `Cache-Control: no-cache, no-transform` header is the contract that prevents this.

```
  Structure pass — Progressive streaming

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
  │  PS1: render boundary  (server shell → hydration) │
  │  PS2: chunk → setState  (per-event update)        │
  │  PS3: intermediary      ★ no-transform header     │
  │       buffering risk                              │
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest walks the streaming kernel, each UX move, and the validation gap.

---

## How it works

### Move 1 — the mental model

You've built a React form where the submit button shows a spinner while the request flies, then renders the response. blooming insights is the same shape *scaled up over 100 seconds*: instead of "spinner → response," it's "skeleton + first event → more events streaming → diagnosis → more events → recommendations → done." The user is never staring at a blank page; the page is *always* doing something. The trick is the NDJSON stream + Web Streams API — the browser reads chunks as they arrive, and each chunk is one update to one piece of state.

```
  Pattern — the perceived-perf kernel (one click → continuous feedback)

   t=0.0s   USER CLICKS "investigate"
   t=0.1s   page renders with skeleton + ProcessStepper (server shell)
              user feels: "okay it's loading"
   t=1-2s   first reasoning_step event arrives
              StatusLog renders first agent thought
              user feels: "it's actually doing something"
   t=3-10s  bootstrap done, first tool call appears with status: running
              user feels: "specific work is happening"
   t=30-60s  diagnosis event arrives
              EvidencePanel renders; skeleton is replaced
              user feels: "the system understands my problem"
   t=60-90s recommendation events stream in (one per recommendation)
              cards appear progressively
              user feels: "the system is proposing solutions"
   t=100s   done event; stream closes; UI finalizes
              user feels: "complete"

   ─────────────────────────────────────────────────────
   actual latency:        ~100s
   perceived latency:     ~1-2s (time-to-first-feedback)
   ratio:                 ~50× perceived speedup (pure UX)
```

The model: **the wall clock doesn't change; the user's experience of it does**. Every UX move in this file converts the 100s of actual latency into ~1-2s of perceived "frozen" time. The four moves compose: streaming reveals progress, skeletons prevent layout shift, the stepper communicates phase, the log shows reasoning. Take any one away and the experience degrades disproportionately.

---

### Move 2 — the streaming kernel, the four UX moves, the buffering risk

#### Move 2.1 — the streaming kernel (NDJSON over Web Streams API)

The server emits one NDJSON line per event; the browser reads chunks and parses each line. The whole thing is ~30 lines on each side.

```
  Pattern — NDJSON streaming, server → browser

   ─── SERVER ────────────────────────────────────────────────────
   const stream = new ReadableStream({
     async start(controller) {
       const send = (e) =>
         controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
                                            ↑ one NDJSON line
       // ... agent runs, calling send(...) per event ...
       send({ type: 'done' });
     },
   });
   return new Response(stream, { headers: NDJSON_HEADERS });
                                            ↑ Cache-Control: no-cache, no-transform

   ─── BROWSER ───────────────────────────────────────────────────
   const res = await fetch(url);
   const reader = res.body.getReader();
   const dec = new TextDecoder();
   let buf = '';                                  ← buffer for partial lines
   for (;;) {
     const { done, value } = await reader.read();
     if (done) break;
     buf += dec.decode(value, { stream: true }); ← decode bytes (multi-byte safe)
     const lines = buf.split('\n');               ← split on newline
     buf = lines.pop() ?? '';                     ← keep partial last line for next chunk
     for (const line of lines) {
       if (!line.trim()) continue;
       handle(JSON.parse(line));                  ← dispatch the event
     }
   }
   if (buf.trim()) handle(JSON.parse(buf));      ← flush final line
```

The boundary: **partial-line handling is load-bearing**. A chunk can arrive mid-event-line: `'{"type":"reasoning_step",...}\n{"type":"tool_call_start"'`. The first line is complete and dispatched; the partial `{"type":"tool_call_start"` is kept in `buf` for the next chunk. Without `buf = lines.pop()`, the partial JSON would throw on `JSON.parse`. This is the most common bug in hand-rolled NDJSON readers — and the blooming insights reader handles it correctly.

#### Move 2.2 — Skeleton placeholders (layout stability)

`components/shared/Skeleton.tsx` is a 20-line component: a div with `animate-pulse`, configurable dimensions, surface-color background. Used wherever data hasn't arrived yet.

```
  Pattern — skeleton placeholder

   while data is loading:
     <Skeleton height={80} width="100%" />
     ⇒ renders a pulsing rectangle matching real content size

   when data arrives:
     <RealComponent data={data} />
     ⇒ slides in IN PLACE — no layout shift

   WHY THIS MATTERS:
     CLS (Cumulative Layout Shift) is a Web Vital — pages jumping
     around as content arrives is a measurable UX failure.
     Skeletons pre-allocate layout so real content arrives without
     reflowing the rest of the page.

   THE FAILURE IF SKIPPED:
     - skeleton too small / too tall: layout shifts when real content arrives
     - no skeleton at all: blank space reads as "broken or empty"
     - skeleton too prominent: distracts from other arriving content

   blooming insights' choice: skeletons match real-content dimensions
     (RecommendationCardSkeleton is sized to the real Recommendation card;
      EvidencePanel skeleton matches the real evidence panel)
```

The boundary: **a skeleton that doesn't match the real content's dimensions causes the very layout shift it exists to prevent**. Get the size right or skip the skeleton entirely.

#### Move 2.3 — ProcessStepper (visible pipeline state)

`components/shared/ProcessStepper.tsx` shows three steps (monitoring → diagnostic → recommendation), each with a state (`pending` / `active` / `complete` / `error`) and a sub-line of human-readable status.

```
  Pattern — ProcessStepper (state machine + style)

   three steps, four states each:
     pending:  outlined circle, text-tertiary       (haven't started)
     active:   filled accent + animate-pulse       (working RIGHT NOW)
     complete: filled accent + ✓ glyph             (done, moved on)
     error:    coral background + ! glyph          (failed)

   render shape:
     ┌──────────────┬──────────────┬──────────────┐
     │ ✓ monitoring │ ◌ diagnostic │   recommend  │
     │   complete   │ ◐ testing... │   awaiting   │  ← sub-line per step
     └──────────────┴──────────────┴──────────────┘
                       ↑ animate-pulse on active

   STATE DRIVES STYLE in one mapping function (badgeStyle).
   investigation page computes diagState / recState from live data;
   stepper is pure presentation.

   WHY THIS MATTERS:
     a flat spinner says "loading" (no information).
     a pipeline stepper says "loading SPECIFICALLY: testing hypotheses
     RIGHT NOW, then proposing actions." That's the difference between
     "stuck" and "making progress."
```

The boundary: **the stepper must update *immediately* when the phase changes**. If the recommendation phase starts but the stepper still says "testing hypotheses…", the UI lies. The fix is wiring the state transitions to the live event flags from the hook (`diagnosis` flag → diagnostic moves to complete; `recommendation` first arrival → recommendation moves to active).

#### Move 2.4 — StatusLog (live agent thoughts + tool calls)

`components/shared/StatusLog.tsx` renders the agent's `reasoning_step` events and `tool_call_start`/`tool_call_end` events as a scrollable list. The user can read the agent's thoughts in real time and see which tools fired.

```
  Pattern — StatusLog (per-event render with in-place update)

   for each event in the stream:
     reasoning_step (kind=thought):     render as italic line
     reasoning_step (kind=hypothesis):  render with diagnostic style
     reasoning_step (kind=conclusion):  render with conclusion style
     tool_call_start:                   render "running execute_analytics_eql..."
     tool_call_end:                     replace the matching start with duration
                                          "execute_analytics_eql · 1.2s"

   the replaceRunningTool function (useInvestigation.ts:86-95):
     walks items array backwards
     finds the last matching running tool
     replaces it in place with the done state + duration

   WHY THIS MATTERS for perceived perf:
     the agent's thoughts read like a colleague working through a problem.
     "let me check conversion in the last 30 days first... ok, that's
     normal... let me look at the previous 30 days..." — the user FEELS
     the thinking happening, not just a spinner.

   WHY THIS MATTERS for trust:
     showing the agent's reasoning + tool calls + durations builds trust.
     a black box that takes 100s is suspicious; a glass box that takes
     100s is collaborative.
```

The boundary: **the list grows monotonically per investigation** (~50-100 items). Each `setState` triggers a re-render. For this volume it's fine; if event rates jumped (streamed text-deltas), the per-event setState would become a bottleneck. The fix at that point is `useReducer` + a manual flush via `requestAnimationFrame`.

#### Move 2.5 — the buffering risk (PS3 from the structure pass)

The HTTP response travels through unknown intermediaries. Any of them might decide to *buffer* the response to compress it more efficiently (gzip middleware works better on whole responses than on tiny chunks). Buffering defeats streaming entirely — the client waits for the full response before seeing the first byte.

```
  Pattern — the buffering risk (and the header that prevents it)

   without the right headers, here's what CAN happen:

   server emits:    event 1 → buffer
                    event 2 → buffer
                    event 3 → buffer
                    ...
                    event N → buffer
                    'done' → close stream

   intermediary:    sees the full response, gzips it, sends it as one chunk

   client receives: one giant chunk at ~100s containing all events
                    user sees frozen page for ~100s
                    then everything appears at once

   ★ THE STREAMING IS DEFEATED ★
   ───────────────────────────────────────────────────────────────────

   the fix (in NDJSON_HEADERS):
     'Content-Type': 'application/x-ndjson; charset=utf-8',
     'Cache-Control': 'no-cache, no-transform',
                                  ↑ THE CRITICAL DIRECTIVE
   what each directive does:
     no-cache:      don't store this response in any cache (per-request unique)
     no-transform:  ★ DO NOT BUFFER, DO NOT TRANSFORM ★
                      tells every intermediary (CDN, proxy, gzip middleware)
                      that the response must be passed through unmodified
                      ⇒ chunks arrive in real time at the client
```

The principle: **the `no-transform` directive is what makes streaming actually stream**. Without it, the entire UX strategy of this file silently collapses — same code, same agents, same NDJSON emission, but the user sees everything at 100s instead of ~1-2s. It's one line in the headers definition; it's load-bearing in the sense that removing it breaks the whole pattern silently.

---

### Move 3 — the principle

**Perceived performance is a UX strategy, not a measurement.** The four moves in this file all *work* — they convert the 100s of actual latency into ~1-2s of time-to-feedback. But "they work" today is a *belief*, not a *fact*, because no measurement validates it. There are no Web Vitals (no LCP/INP/CLS), no time-to-first-event metric, no React Profiler integration. The right discipline is: ship the UX moves first (the cheap part), then add Web Vitals + per-event timing (the cheaper part) so a regression doesn't land silently. blooming insights has done the first half; the second half is still pending. The general lesson: **perceived perf without measurement is engineering on hope — it works until it doesn't, and you find out from a user complaint, not from a metric.**

---

## Primary diagram

The full picture — the streaming kernel, the four UX moves, the buffering risk, the missing measurements.

```
  blooming insights — progressive streaming at a glance

  ┌─ Server route ─────────────────────────────────────────────────────┐
  │                                                                     │
  │  ReadableStream<Uint8Array>                                        │
  │    controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'))    │
  │    one NDJSON line per event                                        │
  │                                                                     │
  │  Cache-Control: no-cache, no-transform   ★ LOAD-BEARING ★          │
  │  Content-Type: application/x-ndjson; charset=utf-8                 │
  │                                                                     │
  │  app/api/agent/route.ts:167-264                                    │
  │  app/api/briefing/route.ts:178-258                                 │
  └────────────────────────────────┬───────────────────────────────────┘
                                   │ HTTP/1.1 chunked transfer
                                   ▼
  ┌─ Browser (React 19, useInvestigation hook) ────────────────────────┐
  │                                                                     │
  │  ┌─ Read pipeline ──────────────────────────────────────────────┐  │
  │  │  fetch → response.body.getReader() → TextDecoder               │  │
  │  │  per chunk: split('\n') → JSON.parse → handle(event)          │  │
  │  │  partial-line handling: buf = lines.pop() ?? ''               │  │
  │  │  ★ ~100-200 setState calls per investigation, no batching ★    │  │
  │  │  lib/hooks/useInvestigation.ts:184-208                        │  │
  │  └──────────────────────────────────────────────────────────────┘  │
  │                                                                     │
  │  ┌─ Four UX moves ──────────────────────────────────────────────┐  │
  │  │                                                                │  │
  │  │  1. NDJSON streaming                                          │  │
  │  │     time-to-first-event: ~1-2s                                │  │
  │  │     ★ converts 100s actual → 1-2s perceived ★                 │  │
  │  │                                                                │  │
  │  │  2. Skeleton placeholders                                     │  │
  │  │     components/shared/Skeleton.tsx                            │  │
  │  │     RecommendationCardSkeleton, CoverageGrid loading state    │  │
  │  │     prevents layout shift (Web Vital: CLS)                    │  │
  │  │                                                                │  │
  │  │  3. ProcessStepper                                            │  │
  │  │     components/shared/ProcessStepper.tsx                      │  │
  │  │     pending / active / complete / error per step              │  │
  │  │     active step has animate-pulse                             │  │
  │  │                                                                │  │
  │  │  4. StatusLog                                                 │  │
  │  │     components/shared/StatusLog.tsx                           │  │
  │  │     live thoughts + tool calls + durations                    │  │
  │  │     replaceRunningTool for in-place duration update           │  │
  │  └──────────────────────────────────────────────────────────────┘  │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ NOT MEASURED (the validation gap) ────────────────────────────────┐
  │                                                                     │
  │  Web Vitals (LCP / INP / CLS)            ← no useReportWebVitals   │
  │  Vercel Speed Insights                    ← not enabled             │
  │  React Profiler integration               ← not used                │
  │  Bundle analyzer                          ← no @next/bundle-analyzer │
  │  Time-to-first-event                      ← no performance.mark    │
  │  Time-to-diagnosis                        ← no performance.mark    │
  │  Per-event render cost                    ← no profiling            │
  │  setState frequency under high event rate ← no observation          │
  │                                                                     │
  │  ★ same gap as R2 (server-side res.usage logging) ★                │
  │  ★ same finding: applied without validation ★                      │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases — where each UX move appears

- **NDJSON streaming** — both `/api/agent` (investigation runs) and `/api/briefing` (monitoring scan) return `ReadableStream<Uint8Array>` responses. The browser-side reader lives in `useInvestigation` (for investigations) and inline in `app/page.tsx` (for the feed briefing).
- **Skeleton placeholders** — `EvidencePanel` shows skeletons while the diagnosis loads; `RecommendationCardSkeleton` shows three placeholder cards while recommendations stream in; `CoverageGrid` renders pending tiles while categories resolve.
- **ProcessStepper** — both the feed (`app/page.tsx`) and the investigation page show the three-step stepper, with the current step `active` (pulsing) and the others `pending` or `complete`.
- **StatusLog** — the investigation page's right column shows live agent activity; the feed shows it for the monitoring scan. Each event triggers an in-place update.
- **Streaming reveal (CoverageGrid)** — commit `7b5707b` (per the audit) made the coverage grid fill tile-by-tile in step with the checklist log lines, instead of all-at-once. Pure perceived-perf win: zero actual speedup, significant UX improvement.

### Code side by side

**The browser-side NDJSON read loop — chunk handling done right.**

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
    buf += dec.decode(value, { stream: true });                 ← decode (multi-byte safe)
    const lines = buf.split('\n');                              ← split on newline
    buf = lines.pop() ?? '';                                    ← keep partial last line
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
           (1) dec.decode(value, { stream: true }) — handles multi-byte
               characters split across chunk boundaries
           (2) buf = lines.pop() ?? '' — keeps the partial line (no \n
               yet) for the next iteration
           (3) trailing buf.trim() — handles the edge case of stream
               ending mid-line (defensive; shouldn't happen with NDJSON)
```

**The event handler — per-event setState (works at today's rates).**

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
        setItems((p) => replaceRunningTool([...p], e));         ← in-place update
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
           same task, but cross-await boundaries (the read loop) are NOT
           batched. For this load (~1-2 events/sec average), this is
           fine. At higher rates (e.g. streamed text-block deltas at
           ~50/sec), this would warrant useReducer + a deliberate flush.
```

**The server-side stream construction — where events become chunks.**

```
  app/api/agent/route.ts  (lines 167–264, abbreviated)

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const collected: AgentEvent[] = [];
      const send = (e: AgentEvent) => {
        collected.push(e);                                              ← keep for cache
        controller.enqueue(encoder.encode(encodeEvent(e)));             ← write NDJSON line
      };
      // ... agent runs, calling send(...) per event ...
      send({ type: 'done' });
      if (step == null) saveInvestigation(insightId!, collected);
    },
  });

  return new Response(stream, { headers: NDJSON_HEADERS });             ← ★ load-bearing headers
        │
        └─ controller.enqueue is synchronous and buffer-backed (Web
           Streams API). No await needed — the chunk goes into the
           internal buffer, the HTTP stack drains it on the wire. Each
           event becomes one HTTP chunk (or part of one, depending on
           chunking strategy). On a network with reasonable latency,
           the browser sees each event within milliseconds of send().
```

**The skeleton component — minimal and correctly sized.**

```
  components/shared/Skeleton.tsx  (full file, 19 lines)

  interface SkeletonProps {
    height?: number | string;
    width?: number | string;
  }

  export default function Skeleton({ height = 80, width = '100%' }: SkeletonProps) {
    return (
      <div
        className="animate-pulse"                                ← Tailwind: pulsing opacity
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
           Layout-shift prevention is the WHOLE job of this component.
```

**The ProcessStepper state-to-style mapping.**

```
  components/shared/ProcessStepper.tsx  (lines 47–64)

  function badgeStyle(state: StepState): CSSProperties {
    const base: CSSProperties = {
      width: 22, height: 22, borderRadius: '50%',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '0.7rem', fontFamily: 'var(--font-mono), monospace',
      flexShrink: 0,
    };
    if (state === 'complete' || state === 'active')                ← both filled
      return { ...base, background: 'var(--accent-teal)', color: 'var(--bg-base)' };
    if (state === 'error')
      return { ...base, background: 'var(--accent-coral)', color: 'var(--bg-base)' };
    return { ...base, border: '1px solid var(--border)', color: 'var(--text-tertiary)' };
                                                                    ← pending = outlined only
  }
        │
        └─ STATE → STYLE in one place. The investigation page computes
           diagState and recState from live data and hands them in. The
           stepper itself is pure presentation — no fetch, no state
           machine. The animate-pulse on the active badge (applied
           separately) is the visible "I'm working" signal.
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
        └─ BEFORE 7b5707b: the whole coverage report was sent as one
           event ⇒ all 10 tiles appeared at once.
           AFTER 7b5707b: one tile resolves per checklist line ⇒ the
           grid fills progressively in step with the log. Same wall-
           clock time, dramatically different felt experience. This is
           perceived-perf in COMMIT shape: zero actual speedup,
           significant UX win.
```

---

## Elaborate

**Where this pattern comes from.** Perceived performance as a design discipline traces to the Nielsen Norman Group's UX research from the late 90s: humans tolerate latency *much* better when they can see progress, and intolerably when they can't. The 0.1s / 1s / 10s thresholds (instant / responsive / attention-span-broken) are foundational. The web's specific tools — skeleton screens, optimistic UI, progressive disclosure — all serve the same goal: make the user *feel* the system is working. Streaming responses (chunked HTTP, NDJSON, Server-Sent Events) are the modern incarnation: ship bytes incrementally so the user sees something within the responsiveness threshold even if completion takes minutes.

**Why NDJSON over Server-Sent Events.** Both ship bytes incrementally. SSE has a defined format (`data: ...\n\n`) and built-in browser support (`EventSource`); NDJSON is simpler (one JSON object per line, parse with `JSON.parse`). The blooming insights choice is NDJSON because (a) the team controls both ends, so the wire format doesn't need to follow a spec, (b) it's easier to debug (one line per event is grep-friendly in logs), and (c) the events have a discriminated union shape that maps cleanly to TypeScript types. SSE's reconnect-on-disconnect machinery isn't needed because the agent run is single-shot, not a persistent subscription.

**Why React 19 + Web Streams API matters here.** Older React versions had less batching control and Streams API was less common. React 19's automatic batching covers same-task updates well; the manual `setItems((p) => [...p, it])` pattern in the hook is idiomatic and works correctly under StrictMode (the `startedRef.current` guard prevents the double-mount issue). Web Streams API (`response.body.getReader()`) is the standard way to read incremental responses; older code would have used polling or XHR's `responseText` chunking. The combination is what makes the streaming pattern in this codebase concise.

**Why no Web Vitals is the same finding as the server-side missing-meter (R2/R7 in the audit).** Both end at the same gap: applied design without measured validation. Server-side, the missing meter is `res.usage` logging. Client-side, the missing meter is Web Vitals + per-event timing. Both are five-line additions; both unblock real measurement. The Next.js `useReportWebVitals` API makes Web Vitals trivial — `import { useReportWebVitals } from 'next/web-vitals'` plus a callback that posts to `/api/telemetry` is the whole integration. The reason it's absent: the perceived-perf design has been good enough that nobody's reached for the meter — which is the worst-case justification (the lack is itself a tripwire that never fires until something breaks silently).

**Connection to adjacent concepts.** `01-300s-vercel-budget-as-hard-ceiling.md` covers the actual latency this file is hiding. `02-ttl-cache-with-no-cache-on-error.md` covers the cache that reduces actual latency on hits. `03-spacing-gate-as-rate-limit-compliance.md` covers the floor that makes actual latency unavoidable. This file is the *UX layer* on top of all of those — it doesn't change the wall clock, it changes what the wall clock feels like.

---

## Interview defense

### Q: An investigation takes 100 seconds. Why doesn't the user perceive it as slow?

**Answer:** Four UX moves that convert ~100s of actual latency into ~1-2s of time-to-feedback. (1) NDJSON streaming — the first `reasoning_step` event lands in ~1-2s; the user sees activity immediately. (2) Skeleton placeholders — the layout doesn't shift when content arrives, so the page feels stable. (3) ProcessStepper — the user sees *which phase* is running ("diagnostic: testing hypotheses…"), not just "loading." (4) StatusLog — the agent's thoughts and tool calls stream into a log; the user can read along. The wall-clock time is unchanged; the experience is transformed. The honest gap: none of this is *measured* — no Web Vitals, no time-to-first-event metric. The strategy is applied, not validated.

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

### Q: What's the most important technical detail that makes the streaming actually work?

**Answer:** `Cache-Control: no-cache, no-transform` in the response headers. Specifically `no-transform`. Without it, any intermediary in the HTTP path — Vercel's edge, a CDN, corporate proxies, gzip compression middleware — could decide to buffer the response and emit it as one chunk to compress better. That would defeat the streaming entirely: the user waits ~100s, then sees everything at once. With `no-transform`, every intermediary is contractually required to pass the response through unmodified — chunks arrive in real time. It's one line in the headers definition, but removing it silently collapses the whole UX strategy of this file. The fact that nobody usually thinks about it is exactly why it's the load-bearing detail.

### Q: There's no Web Vitals measurement and no React Profiler. How would you add the cheapest meter, and why hasn't it been added?

**Answer:** `import { useReportWebVitals } from 'next/web-vitals'` in `app/layout.tsx`, plus a callback that posts to `/api/telemetry` (or just `console.log` to Vercel function logs). Total: ~10 lines. This gets you LCP, INP, CLS, FCP, TTFB out of the box. For per-investigation timing (time-to-first-event, time-to-done), wrap the `fetch` call in `useInvestigation` with `performance.now()` markers and emit them on `done`. Both are smaller than fixing the server-side equivalent gap (`res.usage` logging — R2 in the audit), and both unblock the "is the UX strategy working?" question that's currently a belief. Why it hasn't been added: the design has been good enough that nobody's reached for the meter. That's the worst-case justification — the lack is itself a tripwire that never fires until something breaks silently (a refactor that doubles time-to-first-event lands with no signal).

---

---

## See also

- `audit.md` — the lens-level findings, including this pattern in `rendering-client-and-mobile-performance`
- `01-300s-vercel-budget-as-hard-ceiling.md` — the actual latency this UX strategy is hiding
- `02-ttl-cache-with-no-cache-on-error.md` — the cache that reduces actual latency on hits
- `03-spacing-gate-as-rate-limit-compliance.md` — the floor that makes actual latency unavoidable
- `04-synthesize-as-cost-concentration.md` — the same "design without measurement" gap on the server side
- `.aipe/study-system-design/audit.md#request-response-and-data-flow` — the NDJSON flow from the request-shape lens
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
