# 01 — NDJSON reasoning trace

*Industry standard pattern: structured event stream over a long-lived HTTP response (server-sent events / NDJSON), one consumer being the production UI itself*

## Zoom out — where this concept lives

The live trace is *the* observability surface. It's not separate from the product — the product is "an analyst that shows its work," so the same stream that drives the UI is the same stream a developer reads to debug a wrong answer.

```
  Zoom out — the live trace, in the stack

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  StatusLog (sticky sidebar)                               │
  │  ┌─ ★ ReasoningTrace ★ ─ THIS CONCEPT ─────────────────┐  │ ← we are here
  │  │  renders each AgentEvent as a line                  │  │
  │  └─────────────────────────────────────────────────────┘  │
  └─────────────────────┬─────────────────────────────────────┘
                        │  fetch + readNdjson kernel
  ┌─ Service layer ─────▼─────────────────────────────────────┐
  │  /api/briefing, /api/agent                                 │
  │  encodeEvent(e) → enqueue → controller (ReadableStream)    │
  └─────────────────────┬─────────────────────────────────────┘
                        │  callTool, model.complete
  ┌─ Provider layer ────▼─────────────────────────────────────┐
  │  Bloomreach MCP server, Anthropic                          │
  └────────────────────────────────────────────────────────────┘
```

Zoom in — the concept. The agent's reasoning is encoded as a discriminated union (`AgentEvent`), serialized one JSON object per `\n`-terminated line, streamed over a long-lived HTTP response, and read by a generic NDJSON reader (`readNdjson`) that calls one callback per event. The UI's `StatusLog` is the canonical consumer; the demo replay path, the investigation hook, and the chat surface all reuse the same kernel.

## Structure pass

Axis: **who decides what gets observed?**

- At the route layer: CODE decides. Every `controller.enqueue(encoder.encode(encodeEvent(e)))` is a deliberate write — the agent loop hands events to the route via hooks (`onText`, `onToolCall`, `onToolResult`), and the route shapes them into `AgentEvent` variants.
- At the AptKit boundary: LIBRARY decides. `BloomingTraceSinkAdapter` (`lib/agents/aptkit-adapters.ts:100-141`) is called by AptKit's runtime whenever it has something to emit (a model step, a tool call). The library decides *when*; this repo decides *what the wire format is*.
- At the UI: CONSUMER decides what to render. `useInvestigation` and the briefing page each have a `switch (e.type)` over the discriminated union and selectively bind events to state.

Seam: the boundary where the axis flips is `BloomingTraceSinkAdapter.emit`. Above it (in AptKit's runtime) the library decides. Below it (the hooks back into the route) this codebase decides. That's the contract: `CapabilityEvent` (AptKit's neutral shape) on one side, `AgentEvent` (this repo's wire shape) on the other. The adapter is what makes the seam load-bearing.

## How it works

### Move 1 — the mental model

You know how Server-Sent Events let a server push named events to a browser over one long HTTP response? Same idea here, except plain NDJSON (one JSON object per line) instead of the SSE framing, and the events are a TypeScript discriminated union so the consumer's `switch` is exhaustive.

```
  Pattern — the wire shape

  HTTP response (long-lived, Content-Type: application/x-ndjson)
   ┌──────────────────────────────────────────────────────────┐
   │ {"type":"reasoning_step","step":{"agent":"monitoring",…}}\n │  ← line 1
   │ {"type":"tool_call_start","toolName":"execute_…","agent":…}\n │  ← line 2
   │ {"type":"tool_call_end","toolName":"execute_…","durationMs":1240}\n │  ← line 3
   │ {"type":"insight","insight":{…}}\n                            │  ← line 4
   │ {"type":"done"}\n                                              │  ← line 5
   └──────────────────────────────────────────────────────────┘

   each line is one AgentEvent variant; \n is the framing
```

The trick: the same JSON line a developer reads in DevTools' network panel is the same line `readNdjson` parses, is the same line that drives a UI row in `ReasoningTrace`. One representation, three uses.

### Move 2 — step by step

#### The wire contract: `AgentEvent`

`lib/mcp/events.ts:4-12`. Eight variants. Each carries exactly the fields the UI needs to render it.

```ts
export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }
  | { type: 'tool_call_end'; toolName: string; agent: AgentName; durationMs: number; result?: unknown; error?: string }
  | { type: 'insight'; insight: Insight }
  | { type: 'diagnosis'; diagnosis: Diagnosis }
  | { type: 'recommendation'; recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

Bridge: a discriminated union is just a tagged enum — the `type` field is the tag, every consumer narrows on it. If you've ever written a Redux reducer over an action union, this is the same shape.

What breaks if a variant goes missing: the agent loop emits a `tool_call_end` with no `tool_call_start`? The UI's running/done resolution at `lib/hooks/useInvestigation.ts:87-96` walks backwards looking for the matching `running` row — finds nothing, the late `end` is silently ignored. The kernel doesn't enforce pairing; the consumer's resolver does.

#### The encoder: `encodeEvent`

`lib/mcp/events.ts:14-17`. Three lines, deliberately. `JSON.stringify(e) + '\n'`. That's it. The `\n` is the framing — every event ends with one, every reader splits on one. The encoder is symmetric with `decodeEvent` for tests (`test/mcp/events.test.ts:11-41` round-trips every variant).

What breaks if it's missing: the consumer's buffer fills up with multi-event chunks and never resolves into single events. The kernel's `buf.split('\n')` produces an empty trailing element each chunk, but no completed lines.

#### The reader kernel: `readNdjson`

`lib/streaming/ndjson.ts:17-64`. Generic over event type; one callback per event; `cancelOn` poll between reads; silent skip on malformed lines.

```
  Layers-and-hops — readNdjson

  ┌─ Producer (route) ─┐ hop 1: bytes      ┌─ Reader kernel ──┐
  │ controller.enqueue │ ─────────────────► │ TextDecoder       │
  │ (one chunk = many  │ Uint8Array          │ + buf accumulator │
  │  events possible)  │                     └────────┬──────────┘
  └────────────────────┘                              │ hop 2: split('\n')
                                                      ▼
                                            ┌────────────────────┐
                                            │ for each line:     │
                                            │   JSON.parse →     │
                                            │   onEvent(e)        │
                                            └────────────────────┘
```

Why a kernel at all: the briefing page, the investigation hook, the demo capture path, and the chat surface all run the same `fetch → reader → TextDecoder → buf → split → parse → handle` loop. Without a kernel each one had a slightly different version, and the differences were where bugs hid (one forgot to flush the trailing buffer, another caught and threw on malformed JSON instead of skipping). The kernel is the canonicalisation.

Three boundary behaviors worth naming:

1. **Trailing buffer flush.** When the stream ends mid-line (producer didn't terminate with `\n`), the kernel flushes the trailing `buf` as a final event. The current producers always terminate with `\n` (via `encodeEvent`), so this is a no-op in practice — but it preserves the kernel's correctness for any future producer that omits it.
2. **Silent malformed-line skip.** A `JSON.parse` that throws is logged to the optional `onMalformed` callback (default silent) and the loop continues. This is deliberate — one corrupt event must not blow up the whole stream.
3. **Polled cancellation.** `cancelOn` is checked between reads. The hook's started-guard prevents a double fetch in StrictMode, so cancellation is rarely needed in practice — but a tab close during a long stream uses this path.

What breaks if removed:

- Drop the trailing flush → a producer that ever omits the terminal newline loses its last event silently. Today no producer does this, but a future one might.
- Drop the malformed skip → one bad JSON line kills the whole stream and the user sees a partial trace.
- Drop the cancellation poll → a closed tab keeps the agent loop running in the background, burning Anthropic + MCP budget for output no one will see.

#### The consumer: the `switch` over the union

`lib/hooks/useInvestigation.ts:98-152`. Each variant binds to a piece of state:

- `reasoning_step` → push a `TraceItem.kind='step'` with a timestamp
- `tool_call_start` → push a `TraceItem.kind='tool'` with `status='running'`
- `tool_call_end` → walk backward to find the matching `running` row, flip to `done`
- `diagnosis`, `recommendation`, `error`, `done` → bind to top-level state

The exhaustive switch is what makes the union load-bearing. TypeScript narrows each case to the variant's payload, so adding a new variant to the union forces a compile error in every consumer until handled — the type system is what propagates a wire-format change.

#### The dual-write closure: `send`

`app/api/agent/route.ts:187-190`:

```ts
const collected: AgentEvent[] = [];
const send = (e: AgentEvent) => {
  collected.push(e);
  controller.enqueue(encoder.encode(encodeEvent(e)));
};
```

This is the small detail that ties the live trace to the recording mechanism. Every event is *both* written to the wire AND appended to an in-memory buffer. When the combined investigation run completes, `saveInvestigation(insightId!, collected)` (`app/api/agent/route.ts:302`) writes the buffer to the dev cache, and the next time someone hits the same insight, the cached path replays it through the same encoder. The live stream and the replay stream are byte-compatible by construction.

### Move 3 — the principle

**Make the observability surface and the product surface the same surface.** When the user sees the reasoning, the developer also sees the reasoning. When the recording format equals the wire format, every live run is a future fixture. The cost is that the wire format is now a product API and breaking it breaks the UI — but the payoff is that one discriminated union, owned in one file, drives the product *and* the diagnostic surface *and* the reproduction story.

## Primary diagram

```
  the live trace, end to end

  ┌─ AptKit runtime ─┐  CapabilityEvent  ┌─ BloomingTraceSinkAdapter ─┐
  │  agent loop      │ ─────────────────► │  emit(): map → AgentEvent   │
  └──────────────────┘                    └──────────────┬──────────────┘
                                                         │ hooks (onText, onToolCall, …)
                                                         ▼
                                            ┌─ /api/briefing | /api/agent ─┐
                                            │  const send = e ⇒ {           │
                                            │    collected.push(e);          │
                                            │    enqueue(encodeEvent(e))      │
                                            │  }                              │
                                            └──────────┬─────────────────────┘
                                                       │  HTTP NDJSON
                                                       ▼
                                            ┌─ readNdjson kernel ──┐
                                            │  for each \n-line:    │
                                            │    JSON.parse → onEvent│
                                            └──────────┬─────────────┘
                                                       │  switch (e.type)
                                                       ▼
                                            ┌─ StatusLog + ReasoningTrace ─┐
                                            │  one TraceItem per event       │
                                            └────────────────────────────────┘

                  in parallel, the same send() also fills `collected`
                  → saveInvestigation(id, collected) → demo replay route
                  → next visit hits the cached path, byte-compatible
```

## Elaborate

Where this pattern comes from: NDJSON (newline-delimited JSON) is the industrial form of "a stream of structured records" — used by ndjson.org's reference spec, by `jq`'s `--seq` mode, by `kubectl logs --json`, by every analytic event log. Server-Sent Events is the alternative wire framing; the JSON-line shape is the alternative to plain text. This repo's specific composition — discriminated union + generic reader + UI-as-consumer — is what makes it observability-relevant rather than just data-transport.

Adjacent concepts in this repo: the demo replay path (file 05) leans entirely on this contract being byte-stable. The per-request phase log (file 02) is the *sibling* signal — what the live trace doesn't aggregate, the phase log captures in one summary line. The redaction at the error edge (file 03) is the upstream sanitizer — by the time an error makes it into an `AgentEvent.error.message`, it's already been redacted.

What to read next: the AptKit runtime's `CapabilityEvent` definition (in `node_modules/@aptkit/core`) is the cousin contract — the adapter at `lib/agents/aptkit-adapters.ts:100-141` is exactly the translation layer between AptKit's neutral event and this repo's product-shaped event.

## Interview defense

**Q: Walk me through what happens between a user clicking "investigate" and the first reasoning step showing up in the sidebar.**

```
  click → fetch → bootstrap inside the stream → first encode → first render

  click ─► useInvestigation.fetch('/api/agent?insightId=…&step=diagnose')
            │
            ▼
          ReadableStream.start(controller)
            │  (1) req.signal.throwIfAborted()
            │  (2) bootstrap(schema)   ← first emitted reasoning_step is "reading the workspace schema…"
            ▼
          send({type:'reasoning_step', step:{agent:'diagnostic', kind:'thought', content:'reading…'}})
            │
            ▼
          controller.enqueue(encoder.encode(encodeEvent(e)))
            │  HTTP NDJSON byte over the wire
            ▼
          readNdjson kernel: split('\n'), JSON.parse, onEvent(e)
            │
            ▼
          switch(e.type) case 'reasoning_step':
            setItems(p => [...p, {kind:'step', ..., ts: Date.now()}])
            ▼
          React renders one new ReasoningTrace row, agent-coloured
```

The load-bearing detail: bootstrap happens *inside* the stream, not before it. If bootstrap ran before opening the stream, the user would see a silent 4-second wait while the schema loaded. By emitting the first `reasoning_step` before `bootstrap()`, the UI shows activity immediately and the user sees connection establishing in real time. The comment at `app/api/agent/route.ts:227-228` calls this out explicitly.

**Q: Why a discriminated union instead of a generic `{type, payload}` shape?**

```
  generic                          discriminated
  {type: 'tool_call_end',           {type:'tool_call_end',
   payload: {                        toolName: 'foo',
     toolName: 'foo',                durationMs: 12,
     durationMs: 12,                 result: {…}}
     result: {…}}}                  // consumer narrows on type;
  // consumer must validate          // payload is statically typed
  // payload shape per type           // per variant
```

The narrowing is what matters. With a generic payload, the consumer's `switch` knows nothing — every case body has to assert the payload shape at runtime. With the union, every case body has the right type for free, and a new variant added to the union forces a compile error in every `switch` that doesn't handle it. The wire format is the same; the type story is night and day. Anchor: `lib/mcp/events.ts:4-12`.

**Q: What goes wrong if `encodeEvent` stops terminating with `\n`?**

The first symptom is the UI lagging — events arrive as a buffered batch instead of one-by-one, because `buf.split('\n')` only yields completed lines and `buf` keeps growing. The second symptom is a `done` event at end-of-stream getting lost into the trailing-buffer-flush path, which works (so the consumer still sees `done`) but masks the framing bug. The third symptom is a future consumer that doesn't run the trailing flush losing every event. The fix is one line; the framing rule lives in `lib/mcp/events.ts:14-17` and is tested at `test/mcp/events.test.ts:47-50`.

## See also

- `02-per-request-phase-log.md` — the sibling structured-log signal; what the live trace doesn't aggregate, the phase log captures.
- `03-redaction-at-the-error-edge.md` — by the time an error reaches `AgentEvent.error.message`, it's already been redacted.
- `05-replay-snapshot-as-fixture.md` — leans entirely on this contract being byte-stable; the `collected[]` buffer is the recording mechanism.
- `study-system-design/06-streaming-ndjson.md` — the same kernel, viewed through the system-design lens (the *where* in the architecture, not the *evidence* it carries).
- `study-data-modeling` — the shape of `Insight` / `Diagnosis` / `Recommendation` that ride inside the union variants.
