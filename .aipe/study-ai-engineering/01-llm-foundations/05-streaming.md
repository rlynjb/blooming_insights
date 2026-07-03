# Streaming responses

## Subtitle

NDJSON over `ReadableStream` / Server-sent partial responses — Industry standard.

## Zoom out, then zoom in

Every user-facing surface in blooming_insights streams. The feed streams monitoring anomalies as they're discovered. The investigation page streams the diagnostic agent's reasoning steps and tool calls live. The recommendation page does the same for the recommendation agent. None of it waits for the full response.

The interesting bit: the transport is **newline-delimited JSON over `ReadableStream`**, not SSE (`EventSource`), and not the Anthropic SDK's streaming mode either. The agents themselves run *non-streaming* against Anthropic — you'll see `MessageCreateParamsNonStreaming` in the adapter. The streaming that reaches the UI is a *step-level* stream (one JSON event per agent step / tool call), not a *token-level* stream.

```
  Zoom out — the two streams and their split

  ┌─ UI (browser) ──────────────────────────────────────┐
  │  fetch() + reader.read()                             │
  │  parses NDJSON, updates StatusLog per event          │
  └───────────────────────┬──────────────────────────────┘
                          │  step-level NDJSON
  ┌─ Route handler ──────▼───────────────────────────────┐
  │  ReadableStream, encodes AgentEvent per line         │
  │  app/api/agent/route.ts · app/api/briefing/route.ts  │
  └───────────────────────┬──────────────────────────────┘
                          │  AgentHooks callbacks
  ┌─ Agent (aptkit loop) ▼───────────────────────────────┐
  │  ★ non-streaming Anthropic call per turn ★           │ ← this is where the boundary is
  │  emits: reasoning_step, tool_call_start/end,          │
  │         diagnosis, recommendation, done, error        │
  └──────────────────────────────────────────────────────┘
```

Zoom in: token-level streaming would give lower time-to-first-token, but you lose schema validation and structured outputs mid-stream. Step-level streaming keeps the schema guarantees and still gives the UI progress cues.

## Structure pass

- **Layers:** Anthropic → agent turn → hook → route encoder → NDJSON line → UI reader → StatusLog. Seven bands.
- **Axis: latency.** Full-response wait: 60–120s for a diagnostic. Step-level stream: first UI event in 3–8s. Token-level would be lower still but breaks structured output.
- **Seam:** the `AgentEvent` type in `lib/mcp/events.ts`. That's the streaming contract — everything upstream produces one; everything downstream consumes one.

## How it works

### Move 1 — the mental model

You know how `fetch()` on a large response can be consumed as a stream via `response.body.getReader()`? That's the browser-side of what this codebase does. On the server, instead of returning a single `Response` with a JSON body, the route returns a `ReadableStream` that emits `AgentEvent` JSON lines as the agent produces them.

```
  Step-level NDJSON streaming — the shape

  server writes:                    client reads:
  ┌─ ReadableStream ─────────┐      ┌─ reader.read() loop ────┐
  │  {"type":"reasoning_..."}│─────▶│  parse each line as JSON│
  │  \n                      │      │  dispatch to UI state    │
  │  {"type":"tool_call_..."}│─────▶│                          │
  │  \n                      │      │                          │
  │  {"type":"diagnosis",...}│─────▶│  final event → close     │
  │  {"type":"done"}         │      │  reader                  │
  └──────────────────────────┘      └──────────────────────────┘

  each line: one complete JSON object, newline-delimited
```

### Move 2 — the step-by-step walkthrough

**The event contract.** `lib/mcp/events.ts` and `lib/mcp/types.ts` define the discriminated union. Seven variants:

- `reasoning_step` — one line of agent thinking + which agent produced it.
- `tool_call_start` — an MCP tool call kicked off (name, args, agent).
- `tool_call_end` — the tool call finished (result, duration, error?).
- `diagnosis` — the completed `Diagnosis` object (only after the diagnostic phase).
- `recommendation` — a `Recommendation` object (may fire multiple times).
- `done` — the whole run finished cleanly.
- `error` — something went wrong (auth, budget, exception).

**The route encoder.** Both `app/api/briefing/route.ts` and `app/api/agent/route.ts` construct a `ReadableStream` and write encoded events. Sketch:

```ts
// simplified from app/api/agent/route.ts
const stream = new ReadableStream({
  async start(controller) {
    const write = (e: AgentEvent) => controller.enqueue(encodeEvent(e));
    try {
      // pass write callbacks as AgentHooks to the agent
      await agent.investigate(anomaly, {
        onText: (text) => write({ type: 'reasoning_step', step: { agent, kind: 'thought', content: text } }),
        onToolCall: (tc) => write({ type: 'tool_call_start', agent, toolCall: tc }),
        onToolResult: (tc) => write({ type: 'tool_call_end', agent, toolCall: tc }),
      });
      write({ type: 'done' });
    } catch (err) {
      write({ type: 'error', error: formatError(err) });
    } finally {
      controller.close();
    }
  },
});
return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
```

`encodeEvent()` is `JSON.stringify(event) + '\n'`. That's it. No SSE framing, no chunked-transfer weirdness beyond what `ReadableStream` gives you for free.

**The client reader.** `lib/hooks/useInvestigation.ts` is the client-side consumer. It reads `response.body.getReader()`, decodes the byte stream, splits on newlines, JSON.parses each line, and dispatches to state. It stashes the trace in `sessionStorage` so step 3 (recommend) and back-navigation hydrate instantly.

**Why NDJSON, not SSE.** SSE (Server-Sent Events + `EventSource`) is the classic browser streaming API, but it's read-only from the server and doesn't compose well with `fetch()` + auth headers + POST bodies. NDJSON over `fetch()` + `ReadableStream` composes naturally with everything else the route does (POST body for `?insight=`, custom headers for `BI_MCP_CONFIG_HEADER`, `req.signal` for cancellation).

Diagram of one full investigation stream:

```
  One diagnostic investigation — event stream over time

  t=0.2s   reasoning_step  { agent: "diagnostic", kind: "thought",
                             content: "The mobile checkout drop is..." }
  t=0.5s   tool_call_start { agent: "diagnostic",
                             tc: { toolName: "execute_analytics_eql",
                                   args: { eql: "..." } } }
  t=5.1s   tool_call_end   { agent: "diagnostic",
                             tc: { toolName: "...", result: {...},
                                   durationMs: 4600 } }
  t=5.3s   reasoning_step  { agent: "diagnostic", kind: "thought",
                             content: "That confirms the payment..." }
  ... (5–10 more turns) ...
  t=52.4s  diagnosis       { conclusion, evidence, hypothesesConsidered }
  t=52.5s  done
```

### Move 3 — the principle

Streaming lets you decouple "the model has produced the answer" from "the user has seen progress." For a 60-second agent run, that's the difference between the user watching a spinner and the user watching thoughts + tool calls scroll by. The two-stream split — non-streaming to the model, step-streaming to the UI — is what lets you keep structured output guarantees *and* live UX.

## Primary diagram

```
  Streaming — full frame

  ┌─ Anthropic (per turn) ─────────────────────────────────┐
  │  non-streaming messages.create()                        │
  │  returns full response after 5–15s                      │
  └──────────────────────┬─────────────────────────────────┘
                         │
  ┌─ aptkit agent loop ─▼───────────────────────────────────┐
  │  fires trace events per turn:                          │
  │    · model_started / model_finished                    │
  │    · tool_call / tool_result                           │
  │    · text output                                        │
  │  BloomingTraceSinkAdapter forwards to hooks             │
  └──────────────────────┬─────────────────────────────────┘
                         │  hook callbacks
  ┌─ route ReadableStream ▼─────────────────────────────────┐
  │  each hook writes AgentEvent → NDJSON line              │
  └──────────────────────┬─────────────────────────────────┘
                         │  HTTP/1.1 chunked
                         ▼
  ┌─ UI reader ────────────────────────────────────────────┐
  │  fetch().body.getReader() + JSON.parse per line         │
  │  StatusLog appends per event                            │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

Streaming is where "what the user experiences" and "what the model does" diverge cleanly. The model still runs turn-by-turn, blocking on each Anthropic call; the UI sees a continuous flow because you emit an event as soon as any information is available.

The alternative — Anthropic SDK's `.stream()` mode — would give token-level updates. Two costs stopped this codebase from using it: (1) you can't schema-validate a partial response, so tool_use / structured output paths break; (2) the trace-based observability (`onCapabilityEvent`, cost accounting) is turn-based, not token-based.

Related: **../02-context-and-prompts/03-prompt-chaining.md** (the chain that produces two streams back-to-back for step 2 → step 3). **../05-evals-and-observability/04-llm-observability.md** (how the trace events feed telemetry).

## Project exercises

### B1.5 · Add a stream backpressure ceiling

- **Exercise ID:** B1.5
- **What to build:** If the UI's `useInvestigation.ts` reader stalls (browser tab hidden, network slow), the route's `ReadableStream` accumulates unbounded — the agent keeps running and enqueuing. Add a soft cap: if `controller.desiredSize` goes negative, hold the next enqueue behind a `setTimeout(0)` gate.
- **Why it earns its place:** Turns "I know NDJSON works" into "I understand streaming has backpressure and here's where I addressed it." Interview signal.
- **Files to touch:** `app/api/agent/route.ts` (add the backpressure gate), `test/state/investigations.test.ts` (add a slow-consumer test).
- **Done when:** a test where the consumer reads at 1 event/sec while the agent produces at 10 events/sec produces no memory growth on the server; agent turns still complete.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: Why NDJSON instead of SSE?**

SSE ships with `EventSource`, which is read-only, GET-only, no custom headers, no request body. This codebase's routes are POST-with-body (`insightId` in the URL, but there's also a `BI_MCP_CONFIG_HEADER` per-request header for the swappable-MCP override). NDJSON over `fetch()` + `ReadableStream` composes with all of that natively. The load-bearing part: you can't add `Authorization: Bearer <token>` to `EventSource` without a workaround; you can with `fetch()`.

**Q: You said the model call is non-streaming. So how is the UI streaming?**

Two independent streams. Model → agent turn is non-streaming (waits for the full response so the schema-checked tool_use is well-formed). Agent turn → UI is step-streaming — after each turn, the agent emits a `reasoning_step` or `tool_call_end` event, and the route enqueues it into the ReadableStream. The user sees smooth progress even though each individual model call is a blocking 5–15 second wait.

```
  Two-stream split

  model ──▶ agent turn      (non-streaming: waits for full JSON)
                │
                ▼
  agent turn ──▶ UI event    (step-streaming: one JSON line per turn)
```

## See also

- [../05-evals-and-observability/04-llm-observability.md](../05-evals-and-observability/04-llm-observability.md) — trace events power both the stream and the receipts.
- [../02-context-and-prompts/03-prompt-chaining.md](../02-context-and-prompts/03-prompt-chaining.md) — two agents streaming back-to-back.
- [04-structured-outputs.md](04-structured-outputs.md) — why step-level not token-level streaming preserves the schema contract.
