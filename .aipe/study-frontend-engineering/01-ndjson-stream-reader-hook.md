# NDJSON stream reader hook

**Industry name(s):** custom data-fetching hook · `fetch` + `ReadableStream` consumer · line-buffered streaming reader
**Type:** Industry standard (React 18+) · Language-agnostic kernel

> `useInvestigation` is the frontend's load-bearing data-fetch primitive. It opens one `fetch` to a long-running NDJSON endpoint, drains the `ReadableStream` line by line, parses each line as a JSON event, dispatches into a `switch` that writes five `useState` slots in lockstep with a parallel closure mirror, and stashes the final result in `sessionStorage` on `done`. Strip it and the live agent trace dies; strip it and both investigation pages can't show what the agent is doing in real time. It is the *one* hook that turns a 30-90s server-side agent run into a UI that animates from the first event.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Two pages mount this hook (the diagnose page at `app/investigate/[id]/page.tsx:38` and the recommend page at `app/investigate/[id]/recommend/page.tsx:37`). It is no longer the only NDJSON reader in the codebase — but as of 2026-06-15 the kernel itself is no longer duplicated: every reader (`useInvestigation`, `useBriefingStream`, `useDemoCapture`, `StreamingResponse`) delegates the read loop to the shared `readNdjson` utility at `lib/streaming/ndjson.ts:18-64`. This hook's value now is its **React-specific shape** around that shared kernel: the StrictMode latch, the closure-mirror beside `useState`, the typed `handle()` switch, and the `sessionStorage` stash-on-done. It sits squarely in the UI band, between the React component above (`useState`-driven re-renders) and the route handler below (`/api/agent` emitting `AgentEvent` NDJSON over `fetch`).

```
Zoom out — where the reader hook lives

┌─ UI ─────────────────────────────────────────────────────┐  ← we are here
│  app/investigate/[id]/page.tsx        (page: composes)   │
│  app/investigate/[id]/recommend/page.tsx                  │
│  ★ lib/hooks/useInvestigation.ts ★                       │
│      · 5 useState slots (live tier)                       │
│      · 1 useRef startedRef (run-once latch)               │
│      · fetch → reader → handle() switch                   │
│      · sessionStorage stash on `done`                     │
│  components/investigation/EvidencePanel.tsx (consumes)    │
│  components/shared/StatusLog.tsx           (consumes)     │
└────────────────────────────┬────────────────────────────────┘
                             │  GET /api/agent?…&step=
                             │  Content-Type: application/x-ndjson
┌─ Route handler ────────────▼────────────────────────────────┐
│  app/api/agent/route.ts                                     │
│  emits NDJSON AgentEvent stream over fetch body             │
└─────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this pattern answers: *how do you turn a long-running HTTP response that emits structured events line by line into React state that re-renders as each event arrives, without a third-party library?* React Query and SWR solve the request side but not the streamed-event side; `EventSource` solves the streamed-event side but loses `AbortController` symmetry and types poorly (string-only data, untyped `event:` discriminator). The answer here is to own the kernel: `fetch` → `getReader()` → buffered `TextDecoder` → split on `\n` → `JSON.parse` → dispatch into a typed event switch → `setState` per event arm. The hook IS the kernel plus three React-specific guards (`useRef` started-latch for StrictMode, parallel closure mirror for stash-on-done, dependency array of `[id, step]`).

---

## Structure pass

**Layers.** Three layers inside the hook: the **lifecycle layer** (`useEffect` runs once per mount; `useRef` latch survives StrictMode double-invoke), the **consumer layer** (the `fetch` → reader → line-buffer loop), and the **state-projection layer** (the `handle(event)` switch writing five `useState` slots + the closure mirror). One layer outside the hook: the **call site** (the page component that destructures the hook's return).

**Axis: lifecycle.** When does each part run, exactly once or many times? This axis is right because the hook's reason-for-being is that React's natural answers are wrong: `useEffect` runs *twice* per mount under StrictMode (the fix needs a latch), `setState` queues are async and batched (the stash needs a synchronous mirror), and the `fetch`'s `ReadableStream` reader runs once-per-mount as a long-running loop (the cleanup needs to *not* abort it). Each layer's "when does this fire" answer is what dictates its shape.

**Seams.** Two load-bearing seams. **Seam 1: lifecycle → consumer.** The startedRef latch flips the answer to "does this effect run exactly once" from React's default ("no — twice in dev") to "yes, by guard." Without this seam the consumer opens two parallel streams. **Seam 2: consumer → state-projection.** Each `JSON.parse(line)` produces a typed `AgentEvent`; the switch is where untyped wire bytes become typed React state. If you remove the type guards (the discriminated-union `case e.type === '…'` arms), the state layer holds `unknown` and the consumer page can't read it.

```
Structure pass — the reader hook

┌─ 1. LAYERS ──────────────────────────────────────────┐
│  Lifecycle (useEffect + useRef latch)                 │
│  Consumer  (fetch → getReader → loop → line-buffer)   │
│  State-projection (handle() switch → 5 useState slots │
│                    + parallel closure mirror)         │
│  Call site (destructures the hook's return)           │
└────────────────────────┬──────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼───────────────────────────────┐
│  lifecycle: when does each part run, once or many?   │
└────────────────────────┬──────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼───────────────────────────────┐
│  S1: lifecycle → consumer (default "fires twice"      │
│      flips to "fires once" via startedRef latch)      │
│  S2: consumer → state-projection (untyped bytes flip  │
│      to typed AgentEvent in the switch)               │
└────────────────────────┬──────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

---

## How it works

### Move 1 — mental model: the hook is a buffered consumer + a typed switch + a React state mirror

You know how `EventSource` gives you `.onmessage` callbacks and you write `setState` inside them? Same shape, three differences: (1) you bring the transport (`fetch`), (2) the messages are typed `AgentEvent` objects (not stringly-typed `data:` blobs), and (3) the loop runs inside `useEffect` so it inherits React's lifecycle, which makes you write a guard.

```
Pattern — the kernel shape

  ┌──────────────────────────────────────────────────────────┐
  │  fetch(url) ─▶ res.body.getReader()                       │
  │                       │                                    │
  │                       ▼                                    │
  │                  read() loop                               │
  │                       │                                    │
  │       ┌── decode bytes (UTF-8) ──▶ buf += text             │
  │       │                                                    │
  │       │   lines = buf.split('\n');  buf = lines.pop()      │
  │       │                                                    │
  │       │   for each line:                                   │
  │       │     trim                                           │
  │       │     JSON.parse                                     │
  │       │     handle(event)  ──▶  switch (event.type) {…}    │
  │       │                              │                     │
  │       │                              ▼                     │
  │       │                         setState(…)                │
  │       │                         mirror.push(…)             │
  │       └─────────── next chunk ──────┘                      │
  │                                                            │
  │   on stream close: flush trailing line if any              │
  │                    stash final mirror to sessionStorage    │
  └──────────────────────────────────────────────────────────┘
```

That's the whole shape. The walkthrough breaks it into the three moves that each have a non-obvious bit: the line-buffering kernel (a one-line bug if you get it wrong), the started-guard (one of the few places `useRef` beats `useState`), and the closure mirror (the answer to "why two copies of the same data").

### Move 2.1 — the line-buffering kernel

The hook is reading from a stream of bytes, not lines. UTF-8 is variable-width. A `read()` chunk can split a multi-byte character mid-sequence; it can also split a JSON line mid-text. The kernel handles both with one decoder and one running buffer.

```
Pattern — line-buffering with a partial-line tail

  raw chunks from the wire:        |{"type":"too|l_call_start","toolName":"l|ist_events"}\n{"typ|
  ─────────────────────────────────┘            └─────────────────────┘            └─────────
                                    chunk 1                 chunk 2                  chunk 3

  after TextDecoder({stream:true}):  decodes safely across multi-byte boundaries

  running buffer (`buf`) grows:
    after chunk 1:  '{"type":"too'                                 lines: []          buf: '{"type":"too'
    after chunk 2:  '{"type":"tool_call_start",…l|ist_events"}\n'   lines: ['{"type":"tool_call_start",…}']
                                                                                      buf: ''   (after .pop())

  on stream close:
    if buf.trim():  one last JSON.parse — the trailing line never closed by '\n'
```

```
Pseudocode — the kernel

  reader  ← res.body.getReader()
  decoder ← new TextDecoder()
  buf     ← ''
  while True:
    {done, value} ← await reader.read()
    if done: break
    buf ← buf + decoder.decode(value, {stream: true})    // partial UTF-8 OK
    lines ← buf.split('\n')
    buf   ← lines.pop()  // the last element is the partial trailing line
    for line in lines:
      if line.trim() == '': continue
      try: handle(JSON.parse(line))
      catch: /* swallow malformed line — server might still recover */
  if buf.trim():                                         // flush partial trailer
    try: handle(JSON.parse(buf))
    catch: /* ignore */
```

**What breaks if you remove:**

- The `{stream: true}` flag on `decode()` → a `read()` that splits a multi-byte UTF-8 character produces `U+FFFD` replacement characters in the middle of your JSON, and the parse throws.
- The `buf = lines.pop()` → the partial trailing line is treated as complete; the next chunk concatenates *to the next event*, and the merged blob fails to parse.
- The trailing-line flush after the loop → the last event of the stream is silently dropped if the server didn't emit `\n` after it (some servers don't).
- The `try / catch` around `JSON.parse` → one malformed line kills the entire stream and the UI never reaches `done`.

### Move 2.2 — the started-guard (the StrictMode latch)

React 18+ StrictMode (dev only) double-invokes effects: it runs the effect, runs its cleanup, runs the effect again on the same fiber. The textbook fix is to make the effect cancellable — return a cleanup that aborts. That fix is wrong here: aborting the first run cancels the stream, the re-run opens a fresh one, you double the cost OR you guard the re-run and end up with no completed stream at all.

```
Pattern — the guard, NOT the abort

  React 18 StrictMode dev cycle:
  mount ──▶ effect run #1 ──▶ cleanup ──▶ effect run #2

  ❌ cancel-on-cleanup (the textbook fix, wrong here):
    run #1: opens fetch stream
    cleanup: reader.cancel()  ──▶  stream aborts
    run #2: opens fetch stream AGAIN  ──▶  double cost
                                    OR
            blocked by guard       ──▶  empty logs

  ✅ this hook: started-guard, no cleanup:
    run #1: startedRef.current === false
            startedRef.current = true
            opens fetch stream
            (stream completes — the agent's NDJSON ends with `done`)
    cleanup: (no cleanup registered)
    run #2: startedRef.current === true  ──▶  return immediately
    result: exactly one stream, runs to completion
```

The latch is `useRef`, not `useState`, on purpose. Changing a ref does *not* trigger a re-render, and the ref's `.current` value persists across the StrictMode mount → re-mount because React reuses the same fiber. A `useState` boolean would re-render the component when set, and the re-render would happen before the dependency array re-checks, with no benefit over the ref.

**What breaks if you remove:**

- The latch → effect runs twice in dev; either two streams open (double-cost on the alpha MCP server which is rate-limited, also confusing logs) or the cancel-on-cleanup workaround leaves you with empty logs.

The deeper "why no `AbortController` at all" rationale + the `sessionStorage` handoff mechanics are in `study-system-design/07-client-stream-handoff.md`. This file is the *frontend data-fetch primitive*; that file is the *system-level cross-step seam*.

### Move 2.3 — the parallel closure mirror

The `done` handler needs to write the *complete* result to `sessionStorage`. React's `setState` is asynchronous and batched. If the `done` handler tried to read `items` from React state, it would close over a stale snapshot — the version of `items` from the render in which the effect was created, not the latest. The mirror is the fix: each `handle()` arm pushes into a plain array declared inside the effect's closure, *and* calls `setState` for the React-rendered version. The two are kept in lockstep so the synchronous mirror is always one event ahead of (or equal to) the asynchronous React state.

```
Pattern — two copies, one source of truth at stash time

  closure (inside the effect)              React state (live UI)
  ────────────────────────────             ──────────────────────
  cItems  : TraceItem[]    ─▶ mutated      items          : useState
  cDiag   : Diagnosis|null ─▶ assigned     diagnosis      : useState
  cRecs   : Recommendation[] ─▶ pushed     recommendations: useState

  each handle() arm:
    cItems.push(it)                        setItems(p => [...p, it])
    cDiag = e.diagnosis                    setDiagnosis(e.diagnosis)
    cRecs.push(e.recommendation)           setRecommendations(p => [...p, e.recommendation])

  on `done`:
    sessionStorage.setItem(stashKey, JSON.stringify({
      items: cItems,           ← always freshest, synchronously available
      diagnosis: cDiag,
      recommendations: cRecs,
    }))
```

**What breaks if you remove the mirror:**

- The `done` handler reads stale React state → the stashed result is missing the last 1-3 events (whichever didn't make it through React's batched update queue before the handler fires).
- Re-visits hydrate from a partial stash and skip the "incomplete" tell, because `complete` is set to `true` regardless.

### Move 3 — the principle

A streaming React hook is a buffered consumer plus a typed switch plus a React state mirror, in that order. Get the buffer right (one decoder, one running string, one `pop()` of the partial trailing line, one flush after close) and the parse is correct. Get the lifecycle right (a ref latch for StrictMode, no cleanup-cancel for one-shot streams) and the effect runs once. Get the projection right (a parallel closure mirror alongside `useState`) and you can synchronously inspect the final result on `done`. Each move handles a failure mode that React's defaults don't anticipate — and each move is mechanical once you've seen it. The hook is "boring framework code" that's load-bearing precisely because it's correct.

---

## Primary diagram

The full lifecycle of one hook invocation, end to end, with every layer labelled.

```
USEINVESTIGATION(id, step) — one mount, one stream, one stash

┌─ React lifecycle layer ─────────────────────────────────────────────┐
│  useEffect([id, step]) fires                                          │
│  startedRef.current?                                                  │
│    ──yes──▶ return (StrictMode re-mount; ignore)                      │
│    ──no───▶ startedRef.current = true                                 │
│                                                                       │
│  hydrate path:                                                        │
│    sessionStorage[`bi:inv:${step}:${id}`]?                            │
│      ──hit──▶ setItems / setDiagnosis / setRecommendations            │
│                setComplete(true) ; return (no fetch)                  │
│                                                                       │
│  miss path: continue to consumer layer                                │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
┌─ Consumer layer ─────────────────────▼──────────────────────────────────┐
│  url = `/api/agent?insightId=${id}&step=${step}`                         │
│   (live mode: + &live=1 &insight=<bi:insight:…> &diagnosis=<bi:diag:…>)  │
│  res = await fetch(url)                                                  │
│  reader = res.body.getReader()                                           │
│  decoder = new TextDecoder()                                             │
│  buf = ''                                                                │
│  while not done:                                                         │
│    chunk = await reader.read()                                           │
│    buf += decoder.decode(chunk.value, {stream:true})                     │
│    lines = buf.split('\n')                                               │
│    buf = lines.pop()    ← partial tail                                   │
│    for line in lines: handle(JSON.parse(line))                           │
│  flush(buf) if buf.trim()                                                │
└─────────────────────────────────────┬────────────────────────────────────┘
                                      │  events flow into handle()
┌─ State-projection layer ────────────▼────────────────────────────────────┐
│  handle(event):                                                          │
│    switch event.type:                                                    │
│      'reasoning_step'    ─▶ cItems.push(…)   setItems(p => [...p, …])    │
│      'tool_call_start'   ─▶ cItems.push(…)   setItems(p => [...p, …])    │
│      'tool_call_end'     ─▶ replaceRunningTool(cItems, e)                 │
│                              setItems(p => replaceRunningTool([...p], e))│
│      'diagnosis'         ─▶ cDiag = e.diag   setDiagnosis(e.diag)         │
│      'recommendation'    ─▶ cRecs.push(…)    setRecommendations(p=>…)     │
│      'done'              ─▶ setComplete(true)                            │
│                              sessionStorage.setItem(                     │
│                                `bi:inv:${step}:${id}`,                   │
│                                JSON.stringify({items: cItems,            │
│                                                diagnosis: cDiag,         │
│                                                recommendations: cRecs})) │
│                              if step==='diagnose' && cDiag:              │
│                                sessionStorage.setItem(                   │
│                                  `bi:diag:${id}`, JSON.stringify({…}))   │
│      'error'             ─▶ setError(e.message)                          │
└──────────────────────────────────────────────────────────────────────────┘
```

The diagram is the contract. The page component above destructures `{ items, diagnosis, recommendations, complete, error }` and renders. Nothing else.

---

## Implementation in codebase

**Use cases.** Three places this hook is reached for in the repo:

- **Diagnose step.** `app/investigate/[id]/page.tsx:38` calls `useInvestigation(id, 'diagnose')`. The page destructures `{ items, diagnosis, complete, error }` (omits `recommendations`) and renders `<EvidencePanel diagnosis={diagnosis} loading={streaming} />` + `<StatusLog items={items} title="how this was figured out" scanning={streaming} />`. The hook owns the entire data-fetch + stream-parse + stash cycle; the page is layout + composition.
- **Recommend step.** `app/investigate/[id]/recommend/page.tsx:37` calls `useInvestigation(id, 'recommend')`. Same destructure shape (this time it uses `recommendations`). The hook *internally* reads `bi:diag:<id>` to load the handed-over diagnosis for context display + live-mode URL parameter.
- **Re-visits and browser-back navigation.** Both pages — when the user clicks "← diagnosis" from the recommend page back to the diagnose page, the hook hydrates from `bi:inv:diagnose:<id>` (`useInvestigation.ts:50-63`) and renders the cached result instantly without re-firing the agent. The 30-90s wait happens *once* per investigation per tab.

The other three streaming surfaces — `useBriefingStream` (feed), `useDemoCapture` (dev capture), and `StreamingResponse` (chat) — are *not* this hook, but they now all share the same kernel via `readNdjson` in `lib/streaming/ndjson.ts`. The 2026-06-15 page-decomposition refactor closed audit red flag #2 by extracting the kernel; each consumer keeps its own `onEvent` switch (the typed dispatch arms) but delegates the byte-level loop.

### Code side by side, with a line-by-line read

`lib/hooks/useInvestigation.ts:43, 47-48` (the started-guard):

```
  const startedRef = useRef(false);              ← ref, not useState — no re-render
                                                    on mutation; persists across the
                                                    StrictMode mount → cleanup →
                                                    re-mount because React reuses
                                                    the same fiber

  useEffect(() => {
    if (!id) return;
    if (startedRef.current) return;              ← STRIC MODE GUARD
    startedRef.current = true;                   ←   if dev double-invokes, the
                                                    second run returns immediately
       │
       └─ this two-line guard is the *entire* StrictMode adaptation.
          no AbortController, no cleanup-cancel, no signal — load-bearing
          for a one-shot stream where aborting is worse than allowing
          a tiny amount of wasted work on a mid-stream navigate-away.
```

`lib/hooks/useInvestigation.ts:50-63` (hydrate path):

```
  try {
    const raw = sessionStorage.getItem(stashKey(step, id));     ← key:
    if (raw) {                                                     'bi:inv:diagnose:<id>'
      const s = JSON.parse(raw) as Partial<InvestigationState>;     OR
      setItems(s.items ?? []);                                      'bi:inv:recommend:<id>'
      setDiagnosis(s.diagnosis ?? null);
      setRecommendations(s.recommendations ?? []);
      setComplete(true);                                          ← critical: tells
      return;                                                        the consuming page
    }                                                                we're done, no spinner
  } catch {
    /* ignore — fall through to a live/replay fetch */
  }
       │
       └─ this is what makes a route-change away-and-back zero-cost.
          step 2 → step 3 → back to step 2: the diagnostic agent never
          re-runs because the stash from the first visit is read here.
```

`lib/hooks/useInvestigation.ts:65-67` (the closure mirror):

```
  const cItems: TraceItem[] = [];                ← parallel array, mutated
  let cDiag: Diagnosis | null = null;               synchronously alongside
  const cRecs: Recommendation[] = [];               the async setState calls
       │
       └─ the mirror exists so the `done` handler at L130-L144 can
          synchronously read the freshest result for the stash write.
          React state (items / diagnosis / recommendations) is updated
          via setState, which is async and batched — closing over those
          inside the `done` arm would stash stale values.
```

`lib/hooks/useInvestigation.ts:184-208` (the kernel loop):

```
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });   ← {stream:true} is what
                                                     handles multi-byte UTF-8
                                                     split across chunks
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';                      ← partial trailing line stays
                                                     in the buffer for the next
                                                     iteration to complete
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line) as AgentEvent);   ← typed dispatch
      } catch {
        /* ignore malformed line */                ← do NOT throw — one bad line
                                                     should not kill the stream
      }
    }
  }
  if (buf.trim()) {                                ← flush trailing event after
    try {                                            stream close (some producers
      handle(JSON.parse(buf) as AgentEvent);         omit the final '\n')
    } catch {
      /* ignore */
    }
  }
```

`lib/hooks/useInvestigation.ts:130-144` (the stash-on-done):

```
  case 'done':
    setComplete(true);
    try {
      sessionStorage.setItem(
        stashKey(step, id),                        ← bi:inv:<step>:<id>
        JSON.stringify({                            ← serializes the
          items: cItems,                              CLOSURE MIRROR, not
          diagnosis: cDiag,                           the React state
          recommendations: cRecs,
        }),
      );
      if (step === 'diagnose' && cDiag) {
        sessionStorage.setItem(                    ← cross-step handoff:
          diagHandoffKey(id),                         step 2 writes the
          JSON.stringify({ diagnosis: cDiag }),       diagnosis for step 3
        );                                            to read on its mount
      }
    } catch {
      /* stash is best-effort */
    }
    break;
       │
       └─ the cross-step handoff mechanics (bi:diag:<id> → &diagnosis= URL
          param on the recommend step) live in
          study-system-design/07-client-stream-handoff.md — this file is the
          data-fetch primitive; that file is the system-level handoff.
```

---

## Elaborate

**Where the pattern comes from.** Two histories converge here: the `EventSource` / Server-Sent Events lineage (HTML5; one-way server-to-client stream, automatically reconnects, types as `string`) and the `fetch` + `ReadableStream` lineage (the Fetch + Streams specs; bidirectional control, typed body, integrates with `AbortController`). The pattern in this codebase is the `fetch` variant because the team chose NDJSON over SSE as the wire format (`study-system-design/05-streaming-ndjson.md` documents why — the discriminated-union `AgentEvent` type is shared between producer and consumer, while SSE's `event:` / `data:` framing would have required a parallel typed contract).

The "custom hook that wraps a streaming `fetch` and projects into `useState`" shape is a working pattern in production React codebases since React 18 made effects' double-invocation a known dev-time signal — every team that ships streaming UIs writes some version of this hook. The interesting variations are how each handles three things: (1) StrictMode (latch vs cancel vs no-op), (2) cancellation on real navigation (abort vs accept the cost), (3) the typed-event projection (single `handle()` switch vs per-event subscribers).

**The deeper principle.**

```
Three classes of effect, three correct shapes:

  ┌─────────────────────┬──────────────────────────┬─────────────────────┐
  │ effect class        │ what it is               │ correct shape        │
  ├─────────────────────┼──────────────────────────┼─────────────────────┤
  │ re-runnable query   │ idempotent fetch         │ AbortController in   │
  │                     │ (next mount re-fetches   │ cleanup; re-run      │
  │                     │  with no harm)           │ re-fetches           │
  ├─────────────────────┼──────────────────────────┼─────────────────────┤
  │ subscription        │ long-lived listener      │ unsubscribe in       │
  │                     │ (WebSocket, EventSource) │ cleanup; re-run      │
  │                     │                          │ re-subscribes        │
  ├─────────────────────┼──────────────────────────┼─────────────────────┤
  │ ONE-SHOT STREAM ★   │ long-running response    │ ref latch; NO        │
  │                     │ whose live output IS the │ cleanup; let the     │
  │                     │ product                  │ stream complete      │
  └─────────────────────┴──────────────────────────┴─────────────────────┘
```

This hook is in class 3, which is the rarest class and the one React's official guidance doesn't lead with. Classes 1 and 2 cover most use cases; class 3 is the right answer when the *visible* side effect of the effect (the streaming log) is what the user came to see. Aborting that effect on cleanup is throwing away the product.

**Where it breaks down.**

1. **No real cancellation on navigate-away.** A user who clicks "back" mid-stream wastes whatever budget the agent was about to spend. The cost is small (one Anthropic + ≤6 MCP calls per navigate-away) and the failure mode (re-introducing the StrictMode bug if you add an `AbortController` naively) is real, so the cost is accepted — `cleanup-2026-06-02.md` #21 marks this `accept`.
2. **No invalidation.** `bi:inv:diagnose:<id>` lives for the tab's lifetime. If the underlying anomaly data changed (a fresh briefing recomputed it), the stash still serves the stale diagnosis. The user must close the tab to clear it.
3. **`sessionStorage` is per-tab.** Open in a new tab and the stash is empty; the new tab re-fetches. Deep-links and middle-clicks defeat the cache.
4. **The latch defeats intentional re-runs.** The dependency array is `[id, step]`, but the guard short-circuits before the deps are re-read, so changing `step` without remounting would not re-run. In practice `step` is fixed per page, so this never bites; it would if the hook were reused for a step-toggle inside one component.

**What to explore next.**

- **React Query / SWR** — solves StrictMode dedupe + per-step memoization, but does not by itself solve the cross-instance handoff (the `?insight=` URL parameter needs the server-side route to be aware of the carrier, which a client-side query cache is invisible to). The honest answer is React Query *plus* `sessionStorage` for the carrier — which is more pieces, not fewer.
- **`use(promise)` (React 19)** — would shift the hook to be Suspense-compatible. The catch: the streaming output is not a single promise; it's a long-lived event stream. The pattern doesn't compose cleanly with `<Suspense>` unless you wrap the *first event arrival* as the promise and stream the rest into state — adding a layer of indirection that the current shape doesn't need.
- **Shared `readNdjson` utility** — DONE 2026-06-15. The line-buffering + decoder + cancellation logic was hoisted to `lib/streaming/ndjson.ts` (64 LOC) and is consumed by all four streaming surfaces. Each consumer keeps its own typed `onEvent` switch, but the byte loop is one place. Audit red flag #2 RESOLVED.

---

## Interview defense

### What they are really asking

"Walk me through your data-fetching hook" is asking: do you understand why React StrictMode double-invokes effects, do you know the difference between a cancellable subscription and a one-shot stream, do you know how to parse NDJSON correctly (the line-buffering gotcha is the question behind the question), and do you know why the closure-mirror exists alongside `useState`.

### Q + A

**[mid] How do you stop the agent from running twice in development?**

A `useRef` boolean latch — `startedRef`. The effect's first two lines are `if (startedRef.current) return;` then `startedRef.current = true;`. StrictMode runs the effect, runs cleanup, then runs the effect again on the same fiber; the ref keeps its value across that remount, so the second run returns immediately. Crucially, I do *not* register an `AbortController` in cleanup — see the next question.

```
  effect run #1: startedRef false → set true → fetch stream opens
  cleanup:       (none registered)
  effect run #2: startedRef true → return
```

**[mid] You have a `fetch` that streams NDJSON. Walk me through parsing it correctly.**

You need a `TextDecoder` with `{stream: true}` and a running buffer string. On every `read()` chunk, decode it, append to the buffer, split the buffer on `\n`, *pop* the last element back into the buffer (it's a partial line that the next chunk will complete), and `JSON.parse` each complete line in a try/catch. After the loop ends, flush the trailing buffer if it's non-empty.

```
Pattern recap — the four load-bearing parts

  ✓ TextDecoder({stream:true})  — handles multi-byte UTF-8 split mid-chunk
  ✓ buf.split('\n'); buf = lines.pop()  — keeps the partial trailing line
  ✓ try / catch around JSON.parse  — one bad line shouldn't kill the stream
  ✓ flush buf after loop ends  — some producers omit the final '\n'

  remove any one and you have a class of bugs. the {stream:true} bug is
  the subtlest because it only shows up on chunks that happen to land on
  a multi-byte character boundary — rare in dev, common in prod.
```

**[senior] Why two copies of the data — the React state AND a parallel closure array?**

The `done` handler needs to write the *complete* result to `sessionStorage` synchronously. React's `setState` is async and batched; reading `items` from React state inside the `done` arm would close over a snapshot from the render in which the effect was created — stale by the time `done` fires. The closure mirror (`cItems`, `cDiag`, `cRecs`) is mutated alongside each `setState` call, so on `done` I can stash the freshest data. The two are kept in lockstep, the mirror is the source of truth at stash time.

```
  before stash:
    cItems     = [step1, tool1, tool2, step2, step3]   ← always freshest
    items state = [step1, tool1, tool2, step2, step3]  ← async, but caught up
    sessionStorage.setItem(key, JSON.stringify({ items: cItems, … }))
                                                       ↑
                                          if you read `items` from state here,
                                          you'd risk missing the last 1-3 events
```

**[arch] Why not abort the fetch in cleanup, like the React docs show?**

Because the fetch is a one-shot NDJSON stream whose live output is the product — the reasoning log the user watches. The React-docs cancel-on-cleanup pattern is correct for re-runnable queries: abort, then the re-run re-fetches. Here, StrictMode's cleanup would abort the only stream, and the guard would block the re-run from starting a fresh one, leaving the logs empty. So the hook guards instead of cancels and lets the in-flight stream complete; a `setState` after unmount is a no-op in React 18+. The accepted cost is a tiny amount of wasted work on a true mid-stream navigate-away; the benefit is correctness under StrictMode and zero double-fetch.

### The dodge

**"Why not use React Query / SWR?"**

Honest answer: React Query solves StrictMode dedupe and the per-step memo, but it does not by itself solve the two boundaries that actually hurt — a serverless instance switch (the feed's anomaly isn't in instance B's memory) and the agent-step-to-agent-step handoff (step 2's diagnosis isn't in step 3's component state). Both need state the *server* can read, and a client-side query cache is invisible to the server. So even with React Query I would still need a carrier into the request — a query param or a server session. `sessionStorage` + query params is the minimum that crosses both the client-nav boundary and the network boundary. The cost is no invalidation and no new-tab durability — which is the right trade for a single-session demo/live flow and the wrong one the moment deep-links matter at scale.

### Anchors

- `lib/hooks/useInvestigation.ts:43, 47-48` — the started-guard
- `lib/hooks/useInvestigation.ts:50-63` — the hydrate path that makes re-visits zero-cost
- `lib/hooks/useInvestigation.ts:65-67` — the closure mirror declaration
- `lib/hooks/useInvestigation.ts:184-208` — the kernel loop (line buffering + decoder + trailing flush)
- `lib/hooks/useInvestigation.ts:130-144` — the stash + cross-step handoff
- `app/investigate/[id]/page.tsx:38` and `app/investigate/[id]/recommend/page.tsx:37` — the call sites

---

---

## See also

- [audit.md](./audit.md) — the rendering-and-reactivity and data-fetching-and-cache lenses both anchor to this hook.
- [02-progressive-skeleton-with-stepper.md](./02-progressive-skeleton-with-stepper.md) — the consumer side: what the page renders *while* this hook streams.
- `study-system-design/07-client-stream-handoff.md` — the cross-step `sessionStorage` handoff mechanics (this hook is the data-fetch primitive; that file is the system-level seam).
- `study-system-design/05-streaming-ndjson.md` — the producer side of the wire format.
- `study-software-design/02-shallow-module-page-component.md` — the proposed `useBriefingStream` is this hook's pattern applied to the feed.

---

Generated: 2026-06-03 — `/aipe:study-frontend-engineering` (per `specs/study-frontend-engineering.md`).
Updated: 2026-06-16 — kernel was hoisted to shared `lib/streaming/ndjson.ts:18-64` consumed by all four streaming surfaces (closes audit red flag #2). The hook's value now is the React-specific shape around that shared kernel (StrictMode latch, closure mirror, typed switch, sessionStorage stash).
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
