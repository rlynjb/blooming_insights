# 05 — Streaming responses

**Type:** Industry standard. Also called: server-sent events (SSE), NDJSON stream, token streaming.

## Zoom out, then zoom in

Streaming isn't just about token-by-token model output — in this repo it's the whole architecture of "show your work." The agent's reasoning is a first-class UX surface, not a log.

```
  Zoom out — the NDJSON stream is the product

  ┌─ UI ──────────────────────────────────────────────────────────────┐
  │  StatusLog · ReasoningTrace · ToolCallBlock                        │
  │  (renders live AgentEvent stream)                                  │
  └─────────────────────────────▲─────────────────────────────────────┘
                                │
                                │  fetch() + ReadableStream reader
                                │
  ┌─ Route ─────────────────────┴─────────────────────────────────────┐
  │  app/api/agent/route.ts writes NDJSON via ReadableStream           │
  │  ★ THIS CONCEPT ★                                                  │
  └─────────────────────────────▲─────────────────────────────────────┘
                                │  AgentEvent per turn
  ┌─ Agent hooks ───────────────┴─────────────────────────────────────┐
  │  onText, onToolCall, onToolResult fired from BloomingTraceSinkAdapter│
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. This codebase streams the AGENT's events — reasoning steps, tool call starts, tool call ends, insights, diagnoses, recommendations — as newline-delimited JSON. Not the model's token-by-token output. The model calls are non-streaming (`Anthropic.Messages.MessageCreateParamsNonStreaming`); the streaming happens at the agent-event granularity. That's a deliberate design choice — the interesting unit to render is "the agent called this tool" or "the agent concluded X," not "the agent emitted the token 'because'."

## Structure pass

**Layers:**
- Outer: the browser fetch reader parsing NDJSON lines
- Middle: the route's `ReadableStream` writing one JSON object per turn
- Inner: the agent's hooks firing on model text / tool events

**Axis: what's the streamed unit?**
- Outer (UI): whole `AgentEvent` object
- Middle (route): one NDJSON line per event
- Inner (agent): individual model events (text block, tool_use block, tool_result)

**Seam:** the NDJSON contract in `lib/mcp/events.ts`. This is what "must not change" refers to in the project context — every event kind (`reasoning_step`, `tool_call_start`, `tool_call_end`, `insight`, `diagnosis`, `recommendation`, `done`, `error`) is a discriminated union both sides depend on.

## How it works

### Move 1 — the mental model

You've written `fetch('/api/data').then(r => r.json())` — one request, one response body, wait for the whole thing. Now imagine the server writing the response body in chunks, one JSON object per chunk separated by `\n`, and the client reading with a `ReadableStream` reader that parses each line as it arrives. That's NDJSON.

```
  NDJSON — one JSON object per line, streamed as it happens

  server writes:                    client sees:
  ─────────────────                  ───────────────────
  {"type":"reasoning_step",...}\n    (parse line, render)
   ← ~2s wait                        (spinner, then update)
  {"type":"tool_call_start",...}\n   (parse, render tool bubble)
   ← ~800ms wait                     (waiting for result…)
  {"type":"tool_call_end",...}\n     (parse, close the bubble)
  {"type":"reasoning_step",...}\n    (next thought lands)
   ...
  {"type":"diagnosis",...}\n         (the payload)
  {"type":"done"}\n                  (close the stream)
```

### Move 2 — walk the mechanism

**The event shape.**

`AgentEvent` in `lib/mcp/events.ts` is a discriminated union. Every variant carries a `type` field plus per-type fields. The `reasoning_step` type carries `{agent, content, ts}`; `tool_call_start` carries `{agent, toolName, args, id, ts}`; `diagnosis` carries the typed `Diagnosis` payload. There's a `done` sentinel and an `error` variant. The producers (route handlers) and consumers (`StatusLog`, `useInvestigation`) both depend on this shape — CHANGING IT breaks committed demo snapshots that replay events.

**The producer side.**

In `app/api/agent/route.ts` (and briefing/route.ts), the handler builds a `ReadableStream` and passes a `writeEvent` closure to the agent. Every agent-side callback (`onText`, `onToolCall`, `onToolResult`, plus terminal `insight` / `diagnosis` / `recommendation` events) writes one NDJSON line to the stream. Rough shape:

```
  Route handler shape (simplified)

  return new Response(
    new ReadableStream({
      async start(controller) {
        const write = (event) => controller.enqueue(
          new TextEncoder().encode(JSON.stringify(event) + '\n')
        );

        try {
          await diagnosticAgent.investigate(anomaly, {
            onText: (text) => write({type: 'reasoning_step', agent: 'diagnostic', content: text, ts: Date.now()}),
            onToolCall: (tc) => write({type: 'tool_call_start', ...}),
            onToolResult: (tc) => write({type: 'tool_call_end', ...}),
          });
          write({type: 'diagnosis', payload: diagnosis});
          write({type: 'done'});
        } catch (err) {
          write({type: 'error', message: String(err)});
        } finally {
          controller.close();
        }
      }
    }),
    {headers: {'Content-Type': 'application/x-ndjson'}}
  );
```

**The consumer side.**

`lib/hooks/useInvestigation.ts` runs a `fetch()` and reads the body with `getReader()`. It buffers on partial lines (an event can arrive split across chunks), splits on `\n`, JSON-parses each complete line, and dispatches to the right state update. When `type: 'diagnosis'` arrives, the hook stashes the payload in `sessionStorage` so navigating back or forward hydrates instantly. When `type: 'done'` arrives, the reader exits.

**Why the agent events are streamed and the model output isn't.**

Two reasons. (1) The interesting unit for the UI is "the agent decided to check payment_failure rates" (a reasoning step or a tool call) — not "the model emitted the word 'payment'." Token-level would fire hundreds of times and swamp the UI. (2) Every terminal payload — insight, diagnosis, recommendation — needs to be a whole, validated object. Streaming a half-built JSON schema-conformant object is possible but complex and buys nothing here. The model calls stay non-streaming (`Anthropic.Messages.MessageCreateParamsNonStreaming` at `lib/agents/aptkit-adapters.ts:68`).

**Perceived latency.**

The user sees the FIRST reasoning_step in about 3-5 seconds (first model call + first tool_use decision). Without streaming they'd wait ~225s (p50 total) staring at a spinner. With streaming they see steps arriving every 5-15 seconds and never wonder if the request hung. That's the whole latency win — total time is unchanged; perceived wait drops.

### Move 3 — the principle

Stream the unit the user cares about, not the unit the underlying API produces. Anthropic can stream tokens; that's rarely what you want to render. In this codebase the interesting unit is one turn of the agent's reasoning + tool use, and that's what the NDJSON contract exposes. Design the streamed unit at the domain layer, then figure out the wire format.

## Primary diagram

The full stream, from agent event to rendered UI.

```
  NDJSON stream — one investigation, end to end

  agent (AptKit loop)                                        UI
  ─────────────────                                          ──
      │                                                       │
      │ onText("checking payment_failure rates…")             │
      ▼                                                       │
  TraceSinkAdapter fires hook                                 │
      │                                                       │
      ▼                                                       │
  route.ts writeEvent(reasoning_step) ── NDJSON line ────►    │
                                                              │
                                                          fetch reader
                                                          buffers
                                                          splits on \n
                                                          JSON.parse
                                                              │
                                                              ▼
                                                     dispatch to state
                                                     → ReasoningTrace
                                                       renders bubble
                                                              │
      │                                                       │
      │ onToolCall({name:'execute_analytics_eql', args:…})    │
      ▼                                                       │
  writeEvent(tool_call_start) ── NDJSON line ────────────►    │
                                                    ToolCallBlock renders
                                                    (spinner, tool name)
      │                                                       │
      │ (~1-5s wait for tool)                                  │
      │                                                       │
      │ onToolResult({result:…, durationMs:1234})              │
      ▼                                                       │
  writeEvent(tool_call_end) ── NDJSON line ──────────────►    │
                                                    ToolCallBlock closes
                                                    duration shown
                                                    JSON expandable
      │                                                       │
      │ (loop repeats ~5-10 more turns)                        │
      │                                                       │
      ▼                                                       │
  writeEvent(diagnosis, payload) ── NDJSON line ─────────►    │
                                                    EvidencePanel populates
                                                    session storage stash
      │                                                       │
      ▼                                                       │
  writeEvent(done) ── NDJSON line ───────────────────────►    │
  controller.close()                                     reader exits
```

## Elaborate

NDJSON vs SSE — both are streaming formats. SSE (`EventSource`) has a specific text/event-stream format with `data:` prefixes and reconnection semantics; NDJSON is just JSON per line over any transport (HTTP, WebSocket, file). This codebase picked NDJSON because the client uses `fetch()` (not `EventSource`) — `EventSource` doesn't support custom headers, doesn't support POST, and its reconnection semantics conflict with the once-per-navigation model of an investigation. NDJSON over `fetch()` + reader is more flexible and equivalently trivial to parse.

The `Content-Type: application/x-ndjson` is a convention, not a standard registered mime type. Some proxies buffer streaming responses if they don't recognize the type — Vercel's edge network handles this fine for `text/plain` or `application/x-ndjson` when the response uses `Transfer-Encoding: chunked`.

## Project exercises

### Exercise — heartbeat pings during long tool calls

- **Exercise ID:** C1.5-A · Case A (concept exercised).
- **What to build:** when a tool call is running for > 5s, emit a `{type:'tool_call_progress', id, elapsedMs}` NDJSON line every 3s so the UI can update the elapsed counter without waiting for `tool_call_end`. Adds keepalive behavior on some proxies that buffer long-quiet streams.
- **Why it earns its place:** proves the NDJSON contract can carry mid-flight state without breaking the discriminated union. Interviewer signal: "I extended the stream with a new event kind and used it to fix a real UX problem — the spinner-with-no-progress-during-slow-tools issue."
- **Files to touch:** `lib/mcp/events.ts` (add `tool_call_progress` variant), `app/api/agent/route.ts` (setInterval during pending calls), `components/investigation/ToolCallBlock.tsx` (render elapsed).
- **Done when:** running a synthetic case with an artificially slow tool renders a live "elapsed 5s… 8s… 11s…" counter next to that call.
- **Estimated effort:** 1-4hr.

## Interview defense

**Q: Why not use SSE?**

Two reasons. First: `EventSource` doesn't support POST and doesn't support custom headers. The investigation stream is behind auth and takes a body payload — SSE won't carry it. Second: NDJSON over `fetch()` + `ReadableStream` reader is trivially simple: one line = one JSON object, `TextDecoder` + `.split('\n')` + `JSON.parse`. SSE's specific format buys reconnection semantics we don't want anyway (an investigation is one-shot; a mid-stream disconnect means restart, not reconnect).

**Q: Why not stream tokens from the model?**

The interesting unit for the UI is not the token — it's the reasoning step or the tool call. Token-level streaming would fire hundreds of times per turn and the UI would be constantly re-rendering half-built prose that eventually gets discarded when the model shifts to a tool_use block. The agent-event stream is coarser-grained, semantically meaningful, and each unit is validated before it's rendered.

**Q: What breaks if you change the NDJSON contract?**

The demo snapshot replay. Committed `lib/state/demo-insights.json` and `lib/state/demo-investigations.json` are captured event streams played back by `?demo=cached`. Changing the discriminated union's variants (renaming, removing) invalidates every snapshot. That's why the project context calls out `AgentEvent` explicitly under "What must not change" — additive fields are fine, breaking changes force a re-capture.

## See also

- `lib/mcp/events.ts` — the AgentEvent discriminated union
- `lib/hooks/useInvestigation.ts` — the client reader
- `app/api/agent/route.ts` — the producer
- `components/shared/StatusLog.tsx` — the UI consumer
- `04-agents-and-tool-use/01-agents-vs-chains.md` — what's actually happening between two events on the wire
