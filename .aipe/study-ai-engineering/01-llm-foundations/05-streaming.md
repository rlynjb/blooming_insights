# 05 — streaming

**Subtitle:** Two streams — non-streaming LLM, NDJSON over fetch · Project-specific

## Zoom out, then zoom in

"Streaming" means two completely different things in this codebase, and the
distinction is load-bearing.

```
  Zoom out — the two streams

  ┌─ Browser ──────────────────────────────────────────────┐
  │  fetch('/api/agent?...').then(res => readNdjson(...))   │
  │           ▲                                            │
  │           │  STREAM 2: NDJSON over ReadableStream      │  ← we are here
  │           │  (one line per agent event)                │   for this page
  └───────────┼────────────────────────────────────────────┘
              │
  ┌─ Route ───┴─────────────────────────────────────────────┐
  │  new ReadableStream({ start(controller) { … } })        │
  └───────────┬─────────────────────────────────────────────┘
              │
  ┌─ Agent loop (AptKit) ──────────────────────────────────┐
  │  while(not done) {                                     │
  │     adapter.complete(req)   ← STREAM 1 would go here   │
  │     // BUT: we use messages.create (NOT streaming)     │
  │  }                                                     │
  └────────────────────────────────────────────────────────┘
```

**Stream 1:** the Anthropic API's *token-by-token* streaming response. **NOT
used** in this codebase — `MessageCreateParamsNonStreaming` is the type
annotation in `aptkit-adapters.ts:43`.

**Stream 2:** the **NDJSON wire format** Blooming uses to push agent *events*
(tool calls, reasoning steps, insights, diagnosis, recommendations) to the
browser as they happen. This **is** the streaming UX the user sees.

## Structure pass

  → **One axis to trace — granularity.** Stream 1 is per-token; Stream 2 is
    per-event. The user-perceived latency in blooming insights comes from
    Stream 2 starting early (the bootstrap thought lands in <2s) and
    populating tool-call rows + reasoning steps as the agent loop turns,
    even though each individual model call is non-streaming. The waiting
    is hidden by *event* streaming, not by *token* streaming.

  → **Two seams to name:**
    - **Adapter ↔ Anthropic:** could swap `messages.create` for
      `messages.stream` for token streaming. Trade: harder error handling
      and validation (you can't `parseAgentJson` until the whole text
      arrives anyway, so the validation step *forces* you to await).
    - **Route ↔ Browser:** `ReadableStream` + `encoder.encode(encodeEvent(e))`
      + `controller.enqueue` — this is plain Web Streams, no SSE,
      no WebSocket.

## How it works

### Move 1 — the mental model

You already use this pattern: think of any HTTP API that returns a JSON Lines
log file. Each line is a complete JSON value; you can parse and act on it
without waiting for the next line. Now make the file infinite (or
agent-loop-length) and read it from a browser fetch.

```
  NDJSON over Web Streams — one byte direction

  server (route handler)                 client (browser)
  ──────────────────────                ────────────────
  controller.enqueue(bytes)   ────►     reader.read()
       ↑                                     │
       │  encoder.encode(                    ▼
       │   JSON.stringify(event) + '\n')   parse one line at a time
       │                                     │
       ▼                                     ▼
  emit { type: 'tool_call_start', … }    onEvent(evt) — dispatch into UI state
```

One line = one event. The `\n` is the framing. The producer writes
`encodeEvent(e)` (`lib/mcp/events.ts:15-17`); the consumer reads with
`readNdjson` (`lib/streaming/ndjson.ts:17-64`).

### Move 2 — the step-by-step walkthrough

**Producer side — the route writes the stream.** Look at the agent route
(`app/api/agent/route.ts:184-189`):

```typescript
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const collected: AgentEvent[] = [];
    const send = (e: AgentEvent) => {
      collected.push(e);
      controller.enqueue(encoder.encode(encodeEvent(e)));
    };
    // … bootstrap, agent loop, every callback eventually calls send(…)
```

Breakdown:

  → **`TextEncoder`** — Web Streams trade in `Uint8Array`. The encoder
    converts the JSON string + `\n` into bytes for the wire.

  → **`controller.enqueue`** — pushes one chunk to the readable side. Each
    `send(e)` produces one chunk that is exactly one NDJSON line.

  → **`collected.push(e)`** — same event also captured locally so the route
    can `saveInvestigation(insightId, collected)` at the end. This is the
    demo-capture path; the live stream and the saved replay share the same
    event tape.

The route hooks every agent callback to `send`:

```typescript
const hooksFor = (agent: AgentName) => ({
  onText: (t: string) => { if (t.trim()) stepFor(agent, 'thought', t); },
  onToolCall: (tc: ToolCall) => send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
  onToolResult: (tc: ToolCall) => send({
    type: 'tool_call_end',
    toolName: tc.toolName,
    agent,
    durationMs: tc.durationMs ?? 0,
    result: trunc(tc.result),   // ← truncate large results to 4000 chars
    error: tc.error,
  }),
});
```

Every time AptKit's trace sink emits an event, Blooming converts it to an
`AgentEvent` and writes it on the wire.

**Consumer side — the browser reads the stream.** `readNdjson`
(`lib/streaming/ndjson.ts:17-64`):

```typescript
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
  opts?: { cancelOn?: () => boolean; onMalformed?: (line, err) => void },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (opts?.cancelOn?.()) { await reader.cancel(); return; }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';                              // ← hold partial line
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try { onEvent(JSON.parse(line) as E); }
        catch (err) { opts?.onMalformed?.(line, err); }
      }
    }
    const tail = buf.trim();                                // ← flush trailing buffer
    if (tail) { try { onEvent(JSON.parse(tail) as E); } catch (err) { opts?.onMalformed?.(tail, err); } }
  } finally {
    reader.releaseLock();
  }
}
```

The load-bearing parts:

  → **`buf = lines.pop() ?? ''`** — `split('\n')` produces N+1 elements when
    the chunk has N newlines; the last element is either empty (chunk
    ended on `\n`) or a partial line. Save it into `buf` so the next
    `read()` can concatenate it with the next chunk's prefix. Without
    this, a tool result that arrives in two chunks gets split mid-line and
    both halves fail to parse.

  → **`cancelOn` poll** — checked before every `read()`. When the React
    cleanup function sets `cancelledRef.current = true`, the next
    iteration cancels the reader and exits. Cleanly stops the in-flight
    HTTP request when the user navigates away — without it, the read
    hangs until the route closes the stream.

  → **`onMalformed` (default: silent)** — malformed lines don't crash the
    consumer. Useful for forward-compat: if a future producer adds a new
    event type and the parser doesn't recognize it, the line still
    decodes — the *dispatcher* would just see an unknown `type`. Truly
    malformed JSON (rare) is silently skipped.

  → **trailing-buffer flush** — at EOF, parse what's left in `buf`. A no-op
    in practice (the encoder always appends `\n`) but the correct shape
    for any future producer that omits it.

**Four streaming surfaces use this one kernel:** `useBriefingStream`,
`useInvestigation`, `useDemoCapture`, and the chat / `QueryBox` consumer.
All four use `readNdjson<E>` with different event-type unions. The hook code
that calls it is identical in shape — fetch, parse handle, dispatch into
React state.

**Why no SSE (EventSource)?** Three reasons named in the project context:

  1. SSE requires GET; the streaming routes accept GET, fine — but SSE
     forces text framing (`data: ...\n\n`) and re-imposes a parse layer.
     NDJSON is one line = one JSON. Simpler.

  2. SSE auto-reconnects on disconnect, which sounds nice until you realize
     the agent loop's progress doesn't replay — the client would just
     restart from `event 1` and the server would re-run the whole
     investigation. The codebase's auto-reconnect policy
     (`lib/hooks/useReconnectPolicy.ts`) is one-shot and *intentional*:
     it triggers only on `invalid_token` errors and reloads once.

  3. Cancellation is harder with `EventSource` — you have to call
     `eventSource.close()` and there's no `cancelOn` poll between reads.
     With fetch + `ReadableStream`, cancellation composes with React
     cleanup via the cancel latch ref.

### Move 3 — the principle

**Stream events, not tokens.** What the user feels as "fast" in this product
isn't token-by-token text — it's *the first tool-call row appearing in
StatusLog within 2 seconds*. That's an event, and it lands the moment the
agent loop emits its first trace callback. Token streaming would buy nothing
here because the JSON has to be complete before `parseAgentJson` can validate
it — every individual model call ends with an `await` regardless of whether
the call streamed.

The reverse is also true: in a chat UI that shows the model's text as it
appears, token streaming is exactly what you want, because each token is a
useful unit of work for the user's eyes. Blooming's surface isn't that.

## Primary diagram

```
  The two streams — what each actually does

  ┌─ Stream 1: token streaming — NOT USED ─────────────┐
  │                                                    │
  │  anthropic.messages.stream({…})                    │
  │       │                                            │
  │       ▼ events: {input_json_delta, text_delta, …}  │
  │  per-token callback                                │
  │                                                    │
  │  WHY NOT: parseAgentJson needs the whole text to   │
  │  validate; partial JSON doesn't validate. We pay   │
  │  for the full call and await anyway.               │
  └────────────────────────────────────────────────────┘

  ┌─ Stream 2: NDJSON over Web Streams — USED ─────────┐
  │                                                    │
  │  route: new ReadableStream({ start(controller) {   │
  │           const send = (e) => controller.enqueue(   │
  │             encoder.encode(encodeEvent(e)));       │
  │           hooks.onToolCall = (tc) => send(…);      │
  │           hooks.onToolResult = (tc) => send(…);    │
  │           hooks.onText = (t) => send(…);           │
  │         } })                                        │
  │                                                    │
  │  client: readNdjson(res.body, onEvent, {cancelOn}) │
  │           → split('\n'), parse, dispatch           │
  │                                                    │
  │  Used by 4 surfaces:                               │
  │    useBriefingStream                               │
  │    useInvestigation                                │
  │    useDemoCapture                                  │
  │    QueryBox / StreamingResponse                    │
  └────────────────────────────────────────────────────┘
```

## Elaborate

The NDJSON-over-fetch pattern works because Web Streams landed broadly
supported by the time blooming insights was built (Chrome 78+, Firefox 65+,
Safari 14.1+). Five years ago you'd have needed SSE for this. Today
`fetch + ReadableStream` is the lower-overhead choice.

The `cancelOn` ref-poll pattern in `readNdjson` is a Blooming-specific
adaptation. React's StrictMode (enabled — `reactStrictMode: true` in
`next.config.ts`) double-invokes effects in dev, which would normally cancel
the first stream when the second mount starts. `useInvestigation` explicitly
*doesn't* cancel on cleanup (see the comment in `lib/hooks/useInvestigation.ts`)
to survive StrictMode — instead it relies on the cancel-latch ref being reset
when the second mount runs. The pattern is unusual; it's what makes the
investigate page work right under StrictMode.

The `result: trunc(tc.result)` in the route (`app/api/agent/route.ts:97-101`)
truncates large tool results to 4000 chars before emitting on the wire. The
*original* result is what gets stored in the demo snapshot for replay, but
the *streamed* version is bounded so a 10MB EQL result doesn't crash the
browser. This is a Web Streams quirk: large chunks are technically fine, but
parsing a 10MB JSON line in the browser blocks the main thread.

## Project exercises

### Exercise — add real token streaming for the QueryBox answer

  → **Exercise ID:** `study-ai-eng-05.1`
  → **What to build:** Add a second adapter method
    `AnthropicModelProviderAdapter.completeStream()` that uses
    `anthropic.messages.stream`, emits `text_delta` events to a new
    `onTextDelta` callback. Wire `QueryAgent.answer()` to use the streaming
    variant. Emit a new `AgentEvent` variant `{ type: 'text_delta', delta }`.
    On the browser, `StreamingResponse.tsx` appends each delta to a visible
    answer.
  → **Why it earns its place:** QueryBox is the one surface where a user
    reads the model's prose. Token streaming would meaningfully improve
    perceived latency *here* — unlike monitoring/diagnostic where the
    output is JSON and has to validate at the end.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts` (add stream method),
    `lib/agents/query.ts` (use it), `app/api/agent/route.ts` (free-form
    branch around line 247-260), `lib/mcp/events.ts`,
    `components/chat/StreamingResponse.tsx`.
  → **Done when:** A query like "what's our purchase trend?" shows the
    answer appearing word-by-word in the response panel.
  → **Estimated effort:** `1–2 days`

## Interview defense

**Q: Is blooming insights' UI streaming token by token from Claude?**

No, and that's deliberate. The Anthropic call is non-streaming
(`MessageCreateParamsNonStreaming` in `aptkit-adapters.ts:43`). What streams
is the **agent event tape** — tool calls, reasoning steps, intermediate
diagnoses — over a Web Streams `ReadableStream` in NDJSON format. The user's
perceived "this thing is doing something" comes from event streaming, not
token streaming, because each agent turn produces structured JSON that has to
be fully complete before `parseAgentJson` can validate it.

```
  Token streaming               Event streaming (what we do)
  ──────────────                ──────────────
  per-token deltas              per-event NDJSON lines
  good for: chat / prose UI     good for: multi-step agents
  bad for:  validated JSON      bad for:  single-shot chat
```

**Anchor line:** "Four surfaces share one `readNdjson` kernel. Token streaming
is the next move only on the QueryBox surface — the others produce JSON that
has to await."

**Q: What's the load-bearing detail in `readNdjson`?**

```
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';        // ← THIS LINE
```

Holding the trailing partial line in `buf` is what makes the reader robust
to a chunk arriving mid-line. Drop the `buf.pop()` and a multi-chunk tool
result splits across two reads and both halves fail to parse. The kernel is
~50 lines and that one's the irreducible bit.

**Anchor line:** "Partial-line buffering — the same pattern you'd write for
a stdin line-reader, only on a `Uint8Array` stream."

## See also

  → `01-what-an-llm-is.md` — the non-streaming model call
  → `04-structured-outputs.md` — why we can't validate until the call ends
  → `04-agents-and-tool-use/02-tool-calling.md` — what generates the events that get streamed
