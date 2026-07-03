# 01 — NDJSON `AgentEvent` wire

**NDJSON event stream over a typed discriminated union** — Industry standard.

## Zoom out — where this concept lives

The one live diagnostic surface that carries every mid-flight signal from
the server-side agent loop to the browser. Every reasoning step, every tool
call, every diagnosis, every recommendation, and every error rides this
wire.

```
  Zoom out — the NDJSON wire in the whole system

  ┌─ Browser (UI) ─────────────────────────────────────────────┐
  │  useInvestigation → readNdjson → dispatch(AgentEvent)       │
  └───────────────────────────┬─────────────────────────────────┘
                              │  HTTP · Content-Type: application/x-ndjson
  ┌─ Next route (Node) ───────▼─────────────────────────────────┐
  │  /api/agent  → ★ NDJSON stream of AgentEvent ★  ← we are    │
  │  /api/briefing → same shape + `workspace` extension          │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ Agents + AptKit ─────────▼─────────────────────────────────┐
  │  DiagnosticAgent · RecommendationAgent · MonitoringAgent     │
  │  BloomingTraceSinkAdapter fans events into `send()`          │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in — what it is.** A newline-delimited JSON stream of a
discriminated-union type called `AgentEvent`. Eight variants. One producer
per route, four consumers total. The union is the wire contract; every
consumer switches on `type` and TypeScript narrows the rest.

## Structure pass

**Layers.** Producer (route handler) · transport (HTTP body, chunked) ·
parser (`readNdjson`) · consumers (browser hook, cache writer, replay
loop, eval receipt).

**One axis held constant: control.** Who decides what appears on the wire?

```
  One question, held constant across the layers

  "who decides what event goes on the wire next?"

  ┌───────────────────────────────────────┐
  │ producer:  route handler's send()     │   → ROUTE decides
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ transport: chunked HTTP body        │   → TRANSPORT streams bytes
      └─────────────────────────────────────┘
          ┌────────────────────────────────┐
          │ parser: readNdjson             │   → PARSER splits lines
          └────────────────────────────────┘
              ┌────────────────────────────┐
              │ consumer: dispatch(event)  │   → CONSUMER reacts
              └────────────────────────────┘

  the route is the single source of truth for what happened
```

**Seams.** Two matter:

- **producer ↔ transport** — the `encodeEvent(e) + '\n'` boundary
  (`lib/mcp/events.ts:15-17`). Once you `enqueue()` the encoded bytes,
  the browser sees them. There's no batching, no buffering above this
  line.
- **transport ↔ parser** — the `\n`-terminated line boundary. The
  parser guarantees per-line JSON.parse; a malformed line is silently
  skipped by default (`lib/streaming/ndjson.ts:47-49`).

## How it works

### Move 1 — the mental model

You know how a WebSocket sends discrete typed messages? Same shape here,
but over a one-way HTTP body: the server pushes lines, the browser reads
until end-of-stream. Each line is one JSON object. The `type` field
narrows what the rest of the object looks like. That's it. No framing,
no length prefix, no headers per event — just JSON + `\n`.

```
  The wire — literal shape

     stream bytes ────────────────────────────────►

     {"type":"reasoning_step","step":{...}}\n
     {"type":"tool_call_start","toolName":"list_projects","agent":"diagnostic"}\n
     {"type":"tool_call_end","toolName":"list_projects","agent":"diagnostic","durationMs":347,"result":{...}}\n
     {"type":"reasoning_step","step":{...}}\n
     ...
     {"type":"diagnosis","diagnosis":{...}}\n
     {"type":"recommendation","recommendation":{...}}\n
     {"type":"done"}\n

     ▲                                                       ▲
     └── one event = one line = one JSON.stringify + '\n' ───┘
```

### Move 2 — the mechanism, step by step

The mechanism has five moving parts. Each part is the smallest thing that
can break independently.

**Part A — the union itself.** The whole diagnostic vocabulary in eight
variants. Drop one and a specific piece of evidence disappears from the
UI.

Real code from `lib/mcp/events.ts:1-22`:

```ts
// lib/mcp/events.ts
import type { ReasoningStep, Insight, Diagnosis, Recommendation, AgentName } from './types';

export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }
  | { type: 'tool_call_end'; toolName: string; agent: AgentName; durationMs: number; result?: unknown; error?: string }
  | { type: 'insight'; insight: Insight }
  | { type: 'diagnosis'; diagnosis: Diagnosis }
  | { type: 'recommendation'; recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error'; message: string };

export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}

export function decodeEvent(line: string): AgentEvent {
  return JSON.parse(line) as AgentEvent;
}
```

Each variant is *one specific piece of evidence*. `tool_call_end` carries
`durationMs` — that's your per-tool latency histogram source, on the wire.
`error` carries a human message — that's the user-facing "something broke"
signal. `done` is the termination sentinel — without it, the browser can't
distinguish "server closed the connection normally" from "server crashed
mid-stream and the socket dropped."

**Part B — the producer's `send` closure.** One function per route that
does two things atomically: encode + enqueue.

Real code from `app/api/agent/route.ts:191-195`:

```ts
const collected: AgentEvent[] = [];
const send = (e: AgentEvent) => {
  collected.push(e);
  controller.enqueue(encoder.encode(encodeEvent(e)));
};
```

The `collected[]` array is what gets written to the dev cache
(`saveInvestigation(insightId, collected)`, `route.ts:307`) so a replay
later fires the identical wire. **This is why the wire is also the
persistence format** — same array, same events, deterministic replay.

**Part C — the fanout from AptKit → `send`.** The `BloomingTraceSinkAdapter`
sits between AptKit and the route. Every `CapabilityEvent` from the AptKit
agent loop turns into a call on `hooks.onToolCall` / `onToolResult` /
`onText`, and those close over `send`.

Real code from `app/api/agent/route.ts:201-215`:

```ts
const hooksFor = (agent: AgentName) => ({
  onText: (t: string) => {
    if (t.trim()) stepFor(agent, 'thought', t);
  },
  onToolCall: (tc: ToolCall) => send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
  onToolResult: (tc: ToolCall) =>
    send({
      type: 'tool_call_end',
      toolName: tc.toolName,
      agent,
      durationMs: tc.durationMs ?? 0,
      result: trunc(tc.result),
      error: tc.error,
    }),
});
```

Note `trunc(tc.result)` — results are capped at 4000 chars
(`route.ts:98-102`). A huge MCP payload doesn't blow up the browser or the
dev cache. That's a debugging-vs-cost tradeoff called out at the seam.

**Part D — the parser (`readNdjson`).** The browser side of the boundary.
Reads chunked bytes, buffers, splits on `\n`, JSON.parses each line, calls
`onEvent`. The trailing-buffer flush + malformed handler + `cancelOn`
polling are the three things it gets right.

Real code from `lib/streaming/ndjson.ts:27-64`:

```ts
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
  opts?: {
    cancelOn?: () => boolean;
    onMalformed?: (line: string, err: unknown) => void;
  },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (opts?.cancelOn?.()) {
        await reader.cancel();
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';                     // last fragment: incomplete, hold
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as E);
        } catch (err) {
          opts?.onMalformed?.(line, err);          // default: silent skip
        }
      }
    }
    const tail = buf.trim();                       // flush trailing buffer
    if (tail) {
      try { onEvent(JSON.parse(tail) as E); }
      catch (err) { opts?.onMalformed?.(tail, err); }
    }
  } finally {
    reader.releaseLock();
  }
}
```

The `buf = lines.pop() ?? ''` line is the load-bearing one. `split('\n')`
returns N+1 entries when there are N newlines; the last entry is what
comes AFTER the final `\n` — which might be an incomplete JSON object if
the chunk boundary landed mid-event. Pop it back into `buf` and it gets
prepended to the next chunk. Get this wrong and the parser drops one
event per chunk boundary — a bug you'd only see under high concurrency.

**Part E — the dispatcher (consumer).** The browser hook that pattern-
matches on `type` and mutates React state. This is the "one place" the
wire's TypeScript narrowing pays off.

Real code from `lib/hooks/useInvestigation.ts:99-153`:

```ts
const handle = (e: AgentEvent) => {
  switch (e.type) {
    case 'reasoning_step': {
      const it: TraceItem = {
        kind: 'step',
        id: e.step.id,
        agent: e.step.agent,
        stepKind: e.step.kind as 'thought' | 'hypothesis' | 'conclusion',
        content: e.step.content,
        ts: Date.now(),
      };
      cItems.push(it);
      setItems((p) => [...p, it]);
      break;
    }
    case 'tool_call_start': { /* ... */ break; }
    case 'tool_call_end':
      replaceRunningTool(cItems, e);
      setItems((p) => replaceRunningTool([...p], e));
      break;
    case 'diagnosis':
      cDiag = e.diagnosis;
      setDiagnosis(e.diagnosis);
      break;
    case 'recommendation':
      cRecs.push(e.recommendation);
      setRecommendations((p) => [...p, e.recommendation]);
      break;
    case 'done':
      setComplete(true);
      /* stash to sessionStorage for step-3 handoff */
      break;
    case 'error':
      setError(e.message);
      break;
    default:
      break;
  }
};
```

Every `case` narrows `e` to exactly one variant — TypeScript refuses to
compile if you drop the wrong field. Exhaustiveness isn't statically
checked here (there's a `default: break`), but adding a new variant will
force you to think about it here.

### Move 2 variant — the load-bearing skeleton

The kernel that survives being the pattern:

```
  discriminated union type
  + encoder that stringifies + '\n'
  + parser that splits on '\n' and JSON.parses each line
  + dispatcher that switches on `type`
```

- **Drop the discriminated union** and consumers lose narrowing. The
  dispatcher becomes `if (typeof e.result !== 'undefined') …` heuristics.
  Adding a variant breaks silently.
- **Drop the `\n` terminator** and the parser can't split lines. You
  either need length-prefix framing or a full JSON streaming parser.
  NDJSON's whole simplicity story evaporates.
- **Drop the trailing-buffer flush + `buf.pop()`** and events land
  half-parsed on chunk boundaries under load. One-in-N events go
  missing; the bug is not reproducible in dev.
- **Drop the `done` sentinel** and the browser can't tell "stream ended
  successfully" from "connection dropped mid-run." The UI's spinner
  spins forever.

Skeleton vs hardening:

- **Skeleton:** union + encode + parse + dispatch + `done`.
- **Hardening:** `trunc()` on tool-result payloads (cost); `cancelOn`
  polling in `readNdjson` (StrictMode cleanup); `startedRef` guard in
  the hook (StrictMode double-mount); malformed-line callback
  (observability of the wire itself); truncation-aware error variant.

### Move 3 — the principle

**One typed vocabulary, one line-oriented transport, one exhaustive
dispatch.** NDJSON is the simplest possible streaming protocol — plain
HTTP body, no framing, no dependency — but it works because the *values*
on the wire are typed. The type discipline is what turns a stream of
bytes into a diagnostic surface. Drop the union and it's ad-hoc; keep it
and every consumer knows exactly what to expect.

## Primary diagram

The full recap.

```
  NDJSON AgentEvent wire — full picture

  ┌─ AptKit primitive ─────────────────────────────────────────┐
  │  DiagnosticInvestigationAgent · loop steps                  │
  │       │  CapabilityEvent { type: step | tool_call_start...}  │
  │       ▼                                                     │
  │  ┌─ BloomingTraceSinkAdapter.emit ──────────────────────┐  │
  │  │  onCapabilityEvent(ev)   → raw hook (eval)            │  │
  │  │  onText(text)            → step event                 │  │
  │  │  onToolCall(tc)          → tool_call_start event      │  │
  │  │  onToolResult(tc)        → tool_call_end event        │  │
  │  └───────────────┬───────────────────────────────────────┘  │
  └──────────────────┼──────────────────────────────────────────┘
                     │  hooksFor(agent).onToolCall(...)
  ┌─ /api/agent ─────▼──────────────────────────────────────────┐
  │  send(e: AgentEvent) {                                       │
  │    collected.push(e)                                         │
  │    controller.enqueue(encoder.encode(encodeEvent(e)))        │
  │  }                                                           │
  │                                                              │
  │  encodeEvent(e) = JSON.stringify(e) + '\n'                   │
  └──────────────────┬──────────────────────────────────────────┘
                     │  HTTP · Content-Type: application/x-ndjson
  ┌─ Browser ────────▼──────────────────────────────────────────┐
  │  readNdjson(res.body, handle):                               │
  │    read → decode → buf += chunk                              │
  │    lines = buf.split('\n'); buf = lines.pop()                │
  │    for each line: JSON.parse → handle(event)                 │
  │                                                              │
  │  handle(e: AgentEvent):                                      │
  │    switch(e.type) { ... }  ← exhaustive per variant          │
  │      reasoning_step → setItems                               │
  │      tool_call_start → append running tool item              │
  │      tool_call_end   → mark tool done + duration             │
  │      diagnosis       → setDiagnosis                          │
  │      recommendation  → setRecommendations                    │
  │      done            → setComplete + sessionStorage stash    │
  │      error           → setError                              │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

NDJSON as a format is old (originating in the early 2010s at Twitter
and elsewhere) and deliberately unfussy — it's what the JSONLines /
LDJSON / MongoDB-mongoexport world calls the same thing. It became the
default for LLM streaming responses (OpenAI's `stream: true`, Anthropic's
`stream=true`, Vercel's AI SDK) because Server-Sent Events adds framing
you don't need and WebSockets add duplex you don't need.

Blooming's twist is that the *typed* union is doing the observability
work. Without the union, this is another `data: {...}\n\n` stream and
consumers are on their own. With the union, the same wire drives:

- the UI (one dispatcher)
- the dev cache (one array, deterministic replay)
- the demo snapshot (same array, filtered by step)
- future eval consumers (the raw event is already the ground truth)

Adjacent concepts to read next:

- `04-capability-trace-fanout.md` — how AptKit's `CapabilityEvent`
  becomes Blooming's `AgentEvent` at the adapter seam.
- `05-streaming-ndjson.md` in the study-system-design guide — the
  same wire from the request-flow perspective.
- Anthropic's streaming docs on `content_block_delta` — a lower-level
  streaming variant of the same idea, per-token instead of per-event.

## Interview defense

**Q: Walk me through how a live diagnostic run gets from the AptKit
agent loop into the browser's trace panel.**

```
  Live path — one sentence per hop

  AptKit agent loop
        │  emits CapabilityEvent per step / tool call
        ▼
  BloomingTraceSinkAdapter.emit
        │  fans out to hooks.onCapabilityEvent (raw) +
        │  hooks.onToolCall / onToolResult / onText
        ▼
  route's hooksFor(agent) closure
        │  translates to AgentEvent, calls send()
        ▼
  send(e)
        │  encode = JSON.stringify + '\n'; enqueue chunk
        ▼
  browser fetch()
        │  ReadableStream chunks arrive
        ▼
  readNdjson
        │  buffer + split('\n') + JSON.parse each line
        ▼
  handle(e)
        │  switch(e.type) → setItems / setDiagnosis / ...
        ▼
  ReasoningTrace React component renders
```

Anchor: the wire is defined *once* in `lib/mcp/events.ts` as an
8-variant discriminated union. Every producer emits it, every consumer
narrows it. That's the whole protocol.

**Q: Why NDJSON and not Server-Sent Events?**

Because you don't need SSE's `retry` / `id` / `event:` framing, and you
don't want the browser's automatic reconnection either — an
investigation is one-shot; if it fails you re-run it deliberately.
NDJSON is JSON + `\n`, works over any HTTP body, decodable with a
9-line loop, and Vercel's Node runtime streams it without special
configuration. The whole substrate is `Content-Type:
application/x-ndjson` + one loop.

**Q: The kernel — what would you rebuild from memory?**

Union of typed variants + `stringify + '\n'` encoder + `split('\n')`
parser with buffer for the trailing partial line + `switch(type)`
dispatcher + a `done` sentinel. That's it. Drop the trailing-buffer
handling and you get intermittent event loss on chunk boundaries — the
kind of bug that only shows up under load.

Anchor: `lib/streaming/ndjson.ts:40-42` — `buf = lines.pop() ?? ''`.
Three lines that are the load-bearing part.

**Q: How would you add trace-ID propagation to this wire?**

Add a `requestId: string` field to every variant (or to the top-level
event envelope), mint it in the route's stream start, thread it into
the `send` closure, propagate to logs. Consumers that don't care can
ignore it. This is the fix pointed to as red-flag R2 in `audit.md`.

## See also

- `03-per-phase-timing-log.md` — the *other* live surface: what the
  server logs alongside the wire.
- `04-capability-trace-fanout.md` — where AptKit events turn into
  Blooming events.
- `02-receipts-as-evidence.md` — the durable version of the same
  information, on disk for post-hoc analysis.
