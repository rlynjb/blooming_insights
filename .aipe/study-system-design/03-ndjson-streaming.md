# streaming-ndjson — one contract, one kernel, four surfaces

*Industry standard.* Newline-delimited JSON streaming — one JSON object per `\n`-terminated line, over an HTTP `ReadableStream`. Blooming uses it as the transport between server-side agents and the browser's live UI.

## Zoom out, then zoom in

The agent runs for 60-300 seconds and emits progress the whole time — tool calls firing, reasoning steps landing, insights appearing. Buffering that until the run finishes gives you a UI that sits at a spinner for two minutes. Streaming it gives you the "analyst showing its work" surface.

```
  Zoom out — where NDJSON streaming lives

  ┌─ UI layer ────────────────────────────────────────────────────┐
  │  StatusLog · ReasoningTrace · InsightCard · EvidencePanel     │
  │      consumes: TraceItem[] · Diagnosis · Insight[]             │
  └──────────────────────────┬────────────────────────────────────┘
                             │  parsed events dispatched
  ┌─ Client hook layer ──────▼────────────────────────────────────┐
  │  useBriefingStream · useInvestigation                          │
  │      calls: readNdjson(body, onEvent, { cancelOn })            │
  └──────────────────────────┬────────────────────────────────────┘
                             │  fetch response body (Uint8Array stream)
  ┌─ Network layer ──────────▼────────────────────────────────────┐
  │                    ★ THE NDJSON WIRE ★                         │  ← we are here
  │       content-type: application/x-ndjson; charset=utf-8        │
  │       cache-control: no-store, no-transform                    │
  │       body:  <JSON>\n<JSON>\n<JSON>\n...                       │
  └──────────────────────────┬────────────────────────────────────┘
                             │  ReadableStream<Uint8Array>
  ┌─ Route layer ────────────▼────────────────────────────────────┐
  │  /api/briefing · /api/agent                                    │
  │      emits AgentEvent | BriefingEvent to the controller        │
  │      encoded via encodeEvent(e) = JSON.stringify(e) + '\n'     │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in. One event contract (`AgentEvent`), one encoder (`encodeEvent`), one client-side parse kernel (`readNdjson`). Four surfaces speak it: the briefing route, the agent route, the capture path (dev-only demo snapshot writer), and the chat surface.

## Structure pass

**Layers:** the route (emits), the wire (bytes), the client hook (parses), the UI (consumes).

**Axis:** *event shape*. The event contract must survive intact end-to-end. If any layer mutates the shape, the next layer's discriminated-union switch breaks.

**Seam:** the encoder/decoder pair — `encodeEvent` in `lib/mcp/events.ts:15-17` on the server side; `readNdjson` in `lib/streaming/ndjson.ts` on the client side.

```
  Structure pass — the event shape held constant across layers

  route.ts                        wire                          client hook
  ────────                        ────                          ───────────
  send({type:'tool_call_start',   JSON.stringify(e)+'\n'        JSON.parse(line)
        toolName, agent})    ───► same bytes             ───►   as AgentEvent
                                  no rewriting                   dispatch on e.type

  route.ts                        wire                          UI
  ────────                        ────                          ───
  send({type:'insight',           JSON.stringify(e)+'\n'        setInsights(prev
        insight: {...}})     ───► same bytes             ───►   => [...prev, e.insight])

  the event shape is the contract; the bytes are just how it travels
  every layer trusts every other layer to leave the shape alone
```

The event shape is what makes NDJSON a real streaming protocol vs. "raw text with newlines." Every line is a *complete* JSON object. No half-messages. No message continuation. The parser can `JSON.parse` each line independently. If one line is malformed, it gets skipped and the rest of the stream keeps working — that's the second-order property that makes this transport robust.

## How it works

### Move 1 — the mental model

You've written `fetch('/api/whatever').then(r => r.json())` a hundred times. NDJSON is the same idea except the response has *many* JSON objects instead of one, and you get to react to each as it arrives instead of waiting for all of them.

```
  NDJSON — the shape of the wire

     ┌──────────────────┐  server writes one event → \n
     │ {"type":"...",...} │
     │ {"type":"...",...} │  ← client reads bytes → decodes → splits on \n
     │ {"type":"...",...} │       → parses each complete line → dispatches
     │ {"type":"done"}    │       → repeat until stream ends
     └──────────────────┘

  key property: every line is a COMPLETE JSON object
  → parser doesn't need to hold half-messages
  → one malformed line skipped ≠ stream broken
  → same code path handles "burst of 5 events" and "one every 20 seconds"
```

### Move 2 — the walkthrough

**The event contract** — `lib/mcp/events.ts:4-12`:

```typescript
export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }
  | { type: 'tool_call_end'; toolName: string; agent: AgentName;
      durationMs: number; result?: unknown; error?: string }
  | { type: 'insight'; insight: Insight }
  | { type: 'diagnosis'; diagnosis: Diagnosis }
  | { type: 'recommendation'; recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

Discriminated union on `type`. This is the *single source of truth* for the wire format. Every producer (route handler) emits values assignable to `AgentEvent`; every consumer (client hook) parses to `AgentEvent` and dispatches on `e.type`. TypeScript enforces exhaustiveness at compile time.

The briefing route extends this union locally with two more variants (`workspace`, `coverage_item`) — see `app/api/briefing/route.ts:56-60`. That's the *right* extension shape: the shared contract survives, the local extensions live at the call site.

**The encoder** — `lib/mcp/events.ts:15-17`:

```typescript
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}
```

Nine characters of implementation. That's the whole server side of the transport. The `\n` at the end is what makes it NDJSON rather than JSON-blob-slam; skip the newline and the client's line-splitter never gets to see boundaries.

**The route emits the stream** — pattern shared across `/api/briefing/route.ts:190-329` and `/api/agent/route.ts:184-341`:

```typescript
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: AgentEvent) =>
      controller.enqueue(encoder.encode(encodeEvent(e)));
    try {
      // ... run the agents, calling send() for every event
      send({ type: 'done' });
    } catch (e) {
      send({ type: 'error', message: e.message });
    } finally {
      controller.close();
    }
  },
});
return new Response(stream, { headers: NDJSON_HEADERS });
```

The `send` closure is where the event contract touches the wire. Notice what's *not* in there: no batching, no ordering guarantees, no back-pressure. `controller.enqueue` synchronously buffers into the stream; the runtime handles flushing to the client. If the client can't drink fast enough, the runtime's own back-pressure eventually stalls the producer.

The `finally` block is load-bearing. `controller.close()` fires on both success and error, so a mid-stream throw doesn't leave the client hanging. The route also logs `phases[]` and `aborted` in the same block (`/api/briefing/route.ts:317-324`) — one JSON summary line per request even on failure. That's the incident-signal path: when a 299-second run hits the 300s Vercel limit, you can still see how much of each phase was burned.

**The client-side kernel** — `lib/streaming/ndjson.ts:17-64`. This is the *only* place in the codebase that reads NDJSON. Every client hook that consumes an NDJSON stream calls into this one function:

```
  readNdjson — the kernel

  ┌──────────────────────────────────────────────────────┐
  │  reader = body.getReader()                            │
  │  decoder = new TextDecoder()                          │
  │  buf = ''                                              │
  │  loop:                                                 │
  │    if cancelOn?() → reader.cancel(); return           │
  │    { value, done } = await reader.read()              │
  │    if done → break                                    │
  │    buf += decoder.decode(value, { stream: true })    │
  │    lines = buf.split('\n')                            │
  │    buf = lines.pop()   ← trailing partial line        │
  │    for each line in lines:                            │
  │      try onEvent(JSON.parse(line))                    │
  │      catch → onMalformed?(line, err)                  │
  │  flush trailing buf if non-empty                      │
  └──────────────────────────────────────────────────────┘

  four load-bearing details:
    · buf-and-split: chunks don't align with event boundaries
    · trailing-pop: keep the incomplete tail for the next read
    · malformed skipped: one bad line doesn't kill the stream
    · cancelOn poll: consumer can bail out without cancelling upstream
```

**How the client uses it** — `lib/hooks/useBriefingStream.ts` and `lib/hooks/useInvestigation.ts` both share the same shape:

```typescript
await readNdjson<BriefingEvent>(response.body, (event) => {
  if (event.type === 'workspace') setWorkspace(event.workspace);
  else if (event.type === 'insight') setInsights(prev => [...prev, event.insight]);
  else if (event.type === 'done') {
    setComplete(true);
    onStreamComplete?.();
  }
  // ...
});
```

Discriminated-union dispatch. `readNdjson` calls `onEvent` synchronously for each parsed event; the hook does React state updates inline. React batches those into a single render per tick.

**Move 2 variant — the skeleton.** Four parts, remove any one and the transport breaks:

- **The event contract** (`AgentEvent`) — remove it and producers + consumers stop agreeing on the shape. Silent bugs where the wire looks fine but the UI doesn't render half the events.
- **The encoder** (`encodeEvent`) — remove the `\n` terminator and the client-side splitter sees one long line forever. Whole stream stalls.
- **The kernel** (`readNdjson`) — replace with per-hook parsing and the buffer-across-chunks logic gets forgotten in at least one place. Some hook silently drops half the events.
- **The `done` event** — remove it and the client never knows the stream *finished successfully* vs. *the connection dropped*. Auto-reconnect logic (`useReconnectPolicy`) breaks: it thinks every stream ended abnormally.

Optional hardening: replay delays (`REPLAY_DELAY_MS = 140` for briefing, `180` for agent) that space out demo-replay events so the UI has time to render each one; the malformed-line skip (silent by default; some hooks pass an `onMalformed` for dev diagnostics); the phase-timings log that fires in `finally` and captures how much budget the stream burned even on failure.

### Move 2.5 — demo replay reuses the same wire

The demo path (`?demo=cached`) reads a committed `demo-insights.json` snapshot and emits the same NDJSON events with a small delay between them (`app/api/briefing/route.ts:99-152`):

```typescript
const emit = async (e: BriefingEvent) => {
  controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
  await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
};
```

Client-side, nothing changes. The hook is calling `readNdjson` the same way, dispatching the same events, updating the same state. The UI has *no idea* whether it's watching a live agent run or replaying a snapshot from three days ago. That's the win of pinning the transport contract: **the demo path is not a special-case UI mode, it's a different server-side producer.**

### Move 3 — the principle

**The wire contract is the API.** As soon as you have more than one producer (live route + demo replay + eval receipt writer + capture snapshotter, in Blooming's case) and more than one consumer (`useBriefingStream` + `useInvestigation` + the demo capture tool), the event shape is doing more architectural work than any single route handler. Change it and every producer + every consumer has to move together. That's a real API — and it deserves to live in one file (`lib/mcp/events.ts`) with real types, not scattered across the routes as ad-hoc `send({...})` calls.

The corollary: **buffer at the boundary, not inside the app.** The Vercel runtime buffers bytes for you; React batches state updates for you; the browser handles chunked transfer for you. You don't need per-event locking, ordering, or back-pressure in the app code. All of that lives in the transport substrate. What lives in the app is the event *shape*.

## Primary diagram

```
  The NDJSON pipeline, one frame

  ┌─ Route (server) ────────────────────────────────────────────────┐
  │                                                                  │
  │  const stream = new ReadableStream({                             │
  │    start(controller) {                                            │
  │      const send = e => controller.enqueue(                       │
  │        encoder.encode(encodeEvent(e))                            │
  │      );                                                           │
  │      // ...                                                       │
  │      send({ type: 'tool_call_start', toolName, agent });         │
  │      send({ type: 'tool_call_end', ..., durationMs, result });   │
  │      send({ type: 'insight', insight });                         │
  │      send({ type: 'done' });                                     │
  │    }                                                              │
  │  });                                                              │
  │  return new Response(stream, { headers: NDJSON_HEADERS });       │
  └──────────────────────────────┬──────────────────────────────────┘
                                 │  content-type: application/x-ndjson
                                 │  body:
                                 │    {"type":"tool_call_start",...}\n
                                 │    {"type":"tool_call_end",...}\n
                                 │    {"type":"insight",...}\n
                                 │    {"type":"done"}\n
                                 ▼
  ┌─ Wire (HTTP chunked) ────────────────────────────────────────────┐
  │  bytes arrive at the client in arbitrary-size chunks              │
  │  chunks do NOT align with event boundaries                        │
  └──────────────────────────────┬──────────────────────────────────┘
                                 ▼
  ┌─ Client hook (browser) ──────────────────────────────────────────┐
  │                                                                   │
  │  await readNdjson<BriefingEvent>(response.body, (event) => {     │
  │    if (event.type === 'insight') setInsights(...)                │
  │    else if (event.type === 'done') setStatus('loaded')           │
  │    ...                                                            │
  │  }, { cancelOn: () => cancelled })                               │
  │                                                                   │
  │   ↓ inside readNdjson:                                            │
  │   ─ reader.read() → Uint8Array chunk                              │
  │   ─ decoder.decode(chunk, { stream: true })                       │
  │   ─ buf += decoded; lines = buf.split('\n'); buf = lines.pop()   │
  │   ─ for each line: JSON.parse → onEvent(event)                    │
  └──────────────────────────────┬──────────────────────────────────┘
                                 ▼
  ┌─ UI ──────────────────────────────────────────────────────────────┐
  │  StatusLog reads traceItems · InsightCard reads insights          │
  │  ReasoningTrace shows tool calls as they complete                 │
  │  EvidencePanel renders once diagnosis arrives                     │
  └───────────────────────────────────────────────────────────────────┘

  four surfaces speak this wire:
    · /api/briefing         (live monitoring)
    · /api/agent            (live investigation + query)
    · demo replay branch    (both routes)
    · capture path          (dev-only demo-snapshot writer)
```

## Elaborate

Why NDJSON rather than Server-Sent Events (SSE)? Blooming considered it. SSE has a nicer browser API (`EventSource`) but two dealbreakers here:

1. **SSE requires GET with a `text/event-stream` content type**; the browser opens the connection with its own retry logic that's hard to control. Blooming needs the reconnect policy to be app-controlled (`useReconnectPolicy`) because Bloomreach revokes tokens and the reconnect involves a `/api/mcp/reset` call, not just re-opening the same URL.
2. **SSE's built-in `event:` and `data:` framing is more constrained** than one-JSON-per-line. Blooming's events carry structured payloads with nested objects; NDJSON is a natural fit.

Fetch + `ReadableStream` gives Blooming full control of the connection, cancellation via `AbortSignal`, and the ability to POST as easily as GET (not currently used, but not blocked either).

The historical shape of this transport in Blooming: an earlier version (before the `readNdjson` extraction) inlined the buffer-and-split loop inside each hook. That worked but the trailing-partial-line handling got subtly different in two of the four surfaces. Extracting the kernel to `lib/streaming/ndjson.ts` fixed the drift and left a comment (`ndjson.ts:6-12`) documenting which producer's shape the kernel matches.

What to read next:
- `study-networking` — the HTTP semantics under the streaming transport (chunked transfer encoding, `Cache-Control: no-store, no-transform`, `content-type` negotiation).
- `study-runtime-systems` — `ReadableStream`, `TextEncoder`/`TextDecoder`, `AbortSignal` — how the Vercel edge runtime executes these primitives.
- `05-demo-vs-live-mode.md` — the demo replay branch that reuses this wire without the UI knowing.

## Interview defense

**Q: "Why NDJSON specifically? Why not just return the final result?"**

A: The agents run for 60-300 seconds. Returning the final result means the user watches a spinner for that whole window. Streaming lets the "analyst showing its work" surface be *actual UI* — every tool call the agent makes appears in `StatusLog` as it happens, every reasoning step lands in `ReasoningTrace`, every insight fades into the feed as the anomaly is detected. That's the product's core pitch. It only works with an event stream.

NDJSON specifically (vs. SSE) because Blooming needs app-controlled reconnect: Bloomreach revokes OAuth tokens after minutes, and the reconnect involves a `/api/mcp/reset` call. `EventSource`'s built-in auto-reconnect fights that; `fetch` + `ReadableStream` lets the app own the policy (`useReconnectPolicy`).

```
   final result:    click → spinner 300s → cards appear
                            │
                            └─ silent for the whole run

   NDJSON stream:   click → tool_call_start ─┐
                          → tool_call_end   │ progressive
                          → insight         │ reveal
                          → insight         │
                          → done            ┘
```

*Load-bearing part people forget:* the `done` event. Without it, the client can't distinguish "stream ended successfully" from "connection dropped mid-run." The reconnect policy needs that discrimination.

**Q: "You have one `readNdjson` kernel and four surfaces speaking the same event shape. What's that split saving you?"**

A: Two things. One, the buffer-and-split loop is subtle — chunks don't align with event boundaries, so you always need to hold the trailing partial line for the next read. If every hook writes that loop itself, it drifts. In Blooming's earlier version, two of the four surfaces had different malformed-line handling. Extracting `readNdjson` normalized it.

Two, the event contract (`AgentEvent`) is the API. It's the shape every producer emits and every consumer parses. Living in one file with real types means changes are visible: adding a variant means every consumer's discriminated-union switch gets a compile error until it handles the new case. If the shape were scattered across routes as ad-hoc `send({...})` calls, adding a new event kind would silently be a runtime bug in the surfaces that didn't get updated.

```
   Producers                    Contract                  Consumers
   ─────────                    ────────                  ─────────
   /api/briefing                                          useBriefingStream
   /api/agent           ──►   lib/mcp/events.ts    ──►    useInvestigation
   demo replay path               AgentEvent              (both hooks share
   capture path                                             the same kernel)
```

*Load-bearing part people forget:* the buffer-across-chunks handling. If you `JSON.parse` each raw chunk directly, you'll parse "part of an event" and throw. The `buf += decoded; lines = buf.split('\n'); buf = lines.pop()` shape is what makes it robust.

**Q: "What happens when the stream fails mid-flight?"**

A: Three paths, depending on where.

- **Client cancels** (tab close, navigation, unmount cleanup): `req.signal.aborted` is true; the route's try-catch matches `DOMException.name === 'AbortError'` and returns without emitting an error event (`app/api/agent/route.ts:308-310`) — but the `finally` block still runs, closes the controller, and logs the phase timings. The client just stops reading.
- **Server throws** (Bloomreach rate-limit exhausted, budget exceeded, transport error): the try-catch emits `{ type: 'error', message }` and the finally closes. The client's `readNdjson` sees the error event, dispatches it, and — if it's an `invalid_token` shape — `useReconnectPolicy.handle` fires the reset+reload. All other error messages surface as the red error panel in the UI.
- **Network drops mid-response**: `reader.read()` throws or returns `done: true` unexpectedly. The client hook sees no `done` event; it treats the stream as failed. No reconnect (Blooming's reconnect only fires on auth-error semantics, not on connection loss).

The `finally` block on both routes always logs one JSON summary line to Vercel: `{ route, sessionId, mode, totalMs, phases, aborted }`. Even a 299-second timeout death leaves that receipt behind.

*Load-bearing part people forget:* the `finally` runs on every path — success, error, and abort. The phase-timings log is the incident-signal path. Skip that and a timeout at the 300s Vercel ceiling gives you nothing to debug from.

## See also

- `01-datasource-seam.md` — the tool-call source; every `tool_call_start`/`tool_call_end` event on the wire started as a `dataSource.callTool` invocation.
- `02-aptkit-boundary.md` — the trace-sink adapter that translates AptKit's `CapabilityEvent`s into the Blooming events on this wire.
- `05-demo-vs-live-mode.md` — where the demo-replay branch and the live branch both plug into this wire.
