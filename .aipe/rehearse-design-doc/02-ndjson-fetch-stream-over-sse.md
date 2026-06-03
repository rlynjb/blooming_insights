# RFC-002: NDJSON over fetch+ReadableStream — not SSE, not WebSocket

**Status:** Accepted (implemented)
**Owner:** rein
**Decision:** Both streaming routes (`/api/agent`, `/api/briefing`) emit newline-delimited JSON over a Next.js `ReadableStream` with `Content-Type: application/x-ndjson`. The browser consumes them with `fetch` + `response.body.getReader()` + a manual line-buffering loop. We explicitly do NOT use Server-Sent Events / `EventSource`, do NOT use WebSocket, do NOT long-poll, and do NOT wait for completion before responding.

---

## Context

`/api/agent` runs a Claude tool-use loop that calls Bloomreach MCP tools under a ~1 request/second rate limit. The combined diagnose+recommend flow takes about 100-115 seconds wall-clock. The split-step flow (one agent per request) is ~50-60 seconds. `app/api/agent/route.ts:20` sets `maxDuration = 300` (Vercel Pro's ceiling).

`/api/briefing` runs the monitoring agent over 7-10 anomaly categories with the schema-gated coverage stream. Similar order-of-magnitude latency, similar shape.

Three facts shape the design:

1. **The user cannot wait 60+ seconds for an empty screen.** The agent's reasoning steps, tool calls, and intermediate results need to appear *as they happen* — otherwise the UI is dead until the very end.

2. **The GET handler is not idempotent.** Triggering it consumes Anthropic tokens (a real dollar cost), runs Bloomreach queries against a rate-limited tenant API, and produces non-deterministic output. Calling it twice is not safe.

3. **The connection runs through Vercel's edge.** Anything that exceeds platform timeouts, requires sticky sessions, or needs bidirectional traffic adds infrastructure surface.

Implementation lives at `app/api/agent/route.ts:168-267` (the producer side), `app/api/briefing/route.ts` (the sibling briefing producer), `lib/hooks/useInvestigation.ts:153-212` (the consumer side), `lib/mcp/events.ts:4-22` (the wire format).

---

## Goals

- First reasoning-step log line appears in the UI within ~1-2 seconds of the user's click. No silent waiting.
- Every intermediate event (tool call, tool result, diagnosis, recommendation) renders the moment it's produced. The UI cadence matches the agent's cadence.
- A dropped connection does not trigger a duplicate agent run, and does not cost the user a second Anthropic bill.
- The same wire format works for live agent runs and for the demo-cache replay path. The consumer can't tell them apart.
- Tests of the consumer loop run with no network — feed it a string with `\n`s, assert the handler is called the right number of times.

## Non-goals

- Reconnect-and-resume. If the connection drops mid-stream, the investigation is over. The user re-runs (or the cache serves the next attempt). We do not maintain server-side event logs with cursors.
- Bidirectional communication. The user sends one GET; the server streams back. There is no client-pushes-during-stream.
- Multi-subscriber fan-out. One client per stream. There is no broadcast.
- Backpressure. The producer writes as fast as it can; the consumer reads as fast as it can. We do not engage the `ReadableStream` `desiredSize` / `pull` machinery.

---

## The decision

```
  ┌─ Service layer (app/api/agent/route.ts) ────────────────────────────┐
  │                                                                     │
  │  new ReadableStream<Uint8Array>({                                  │
  │    async start(controller) {                                        │
  │      const send = (e: AgentEvent) => {                              │
  │        collected.push(e);                                           │
  │        controller.enqueue(encoder.encode(encodeEvent(e)));          │
  │      };                                                             │
  │      try {                                                          │
  │        send(reasoning_step 'reading the workspace schema…');        │ ← first line on the wire
  │        const schema = await bootstrapSchema(conn.mcp);              │
  │        // …run agents, send events as they happen…                  │
  │        send({ type: 'done' });                                      │
  │      } catch (e) {                                                  │
  │        send({ type: 'error', message: ... });                       │ ← throw → error event, not HTTP 500
  │      } finally {                                                    │
  │        controller.close();                                          │
  │      }                                                              │
  │    }                                                                │
  │  })                                                                 │
  │                                                                     │
  │  Response(stream, { headers: 'Content-Type: application/x-ndjson' })│
  └─────────────────────────────────┬───────────────────────────────────┘
                                    │  HTTP chunked transfer
                                    │  one JSON object per line, `\n` delimited
                                    ▼
  ┌─ UI layer (lib/hooks/useInvestigation.ts) ──────────────────────────┐
  │                                                                     │
  │  const reader = res.body.getReader();                              │
  │  const dec = new TextDecoder();                                    │
  │  let buf = '';                                                     │
  │  for (;;) {                                                        │
  │    const { done, value } = await reader.read();                    │
  │    if (done) break;                                                │
  │    buf += dec.decode(value, { stream: true });                     │ ← multi-byte safe
  │    const lines = buf.split('\n');                                  │
  │    buf = lines.pop() ?? '';                                        │ ← partial line stays in buf
  │    for (const line of lines) {                                     │
  │      if (!line.trim()) continue;                                   │
  │      try { handle(JSON.parse(line) as AgentEvent); } catch {}      │ ← per-line catch
  │    }                                                               │
  │  }                                                                 │
  └─────────────────────────────────────────────────────────────────────┘
```

The wire contract is a discriminated union in `lib/mcp/events.ts:4-12`:

```
AgentEvent =
  | { type: 'reasoning_step';   step: ReasoningStep }
  | { type: 'tool_call_start';  toolName: string; agent: AgentName }
  | { type: 'tool_call_end';    toolName: string; agent: AgentName; durationMs; result?; error? }
  | { type: 'insight';          insight: Insight }
  | { type: 'diagnosis';        diagnosis: Diagnosis }
  | { type: 'recommendation';   recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error';            message: string }
```

`encodeEvent(e)` is exactly `JSON.stringify(e) + '\n'`. `decodeEvent(line)` is `JSON.parse(line)`. The newline is the framing.

Three load-bearing pieces:

1. **The producer enqueues the moment it has something to write.** No buffering, no batching. The schema-bootstrap reasoning step at `app/api/agent/route.ts:201` fires *before* the schema read, so the user sees a log line in ~50ms instead of staring at silence for ~1.5s.

2. **The consumer's `buf.split('\n')` + `lines.pop()` pattern handles chunk-boundary line splits.** TCP can split a JSON line mid-byte; the trailing partial is held in `buf` until the next chunk completes it. This is the one mechanism that has to be correct — getting it wrong produces sporadic parse errors that depend on TCP segmentation.

3. **The cache-replay path uses the same wire format.** `app/api/agent/route.ts:127-141` writes encoded events from a cached array with a 180ms paced delay between them. The consumer doesn't know it's a replay. Same contract, different producer.

---

## Alternatives considered

### Alternative A: Server-Sent Events (`EventSource`)

The obvious default. WHATWG-spec'd, `text/event-stream` framing, browser-native `EventSource` API, auto-reconnect on drop, server can hint reconnect delay with `retry:`.

**Why it lost:**

The auto-reconnect is the disqualifier. When `EventSource` loses the connection, it re-issues the GET. In this app that GET triggers a fresh ~115s Claude agent run. Auto-reconnect becomes auto-re-bill *and* a phantom duplicate investigation.

```
  EventSource on dropped connection:

  Browser ──GET /api/agent──► Server: starts 115s run → stream
           ←── 60s of stream ──
  connection drops at t=60s
  Browser waits retry-ms (default 3s)
  Browser ──GET /api/agent──► Server: starts ANOTHER 115s run
                              (previous run still in-flight or wasted)
```

We could mitigate by setting `retry:` to a very large number and instructing the client to ignore reconnects — but at that point we've removed the only thing SSE gives us over fetch-stream, while keeping its SSE framing tax (`data:`, `event:`, `id:` envelope per event).

The honest framing: SSE is the right answer when the GET handler is idempotent. Ours isn't. The whole pattern is wrong for non-idempotent server work.

Other SSE drawbacks that came up but didn't decide the call:
- `EventSource` is GET-only, no custom headers by default. Not a blocker today but a constraint we don't want to inherit.
- SSE framing requires escaping newlines in data payloads. NDJSON has the same constraint but the JSON serializer handles it automatically.

### Alternative B: WebSocket

Bidirectional, framed, well-supported, designed for long-lived connections.

**Why it lost:**

- It's bidirectional and we don't need that. The user clicks, the server streams back. There is no client-pushes-during-stream use case in this product. Paying for a duplex transport when we want simplex is paying for capability we don't use.
- Vercel serverless functions don't natively support WebSocket upgrades on the standard Node runtime. Workarounds exist (Vercel Edge functions, dedicated WS hosts) but each is its own infrastructure surface.
- WebSocket frames are not HTTP. Browser DevTools' Network tab shows the upgrade but doesn't render the message stream the way it does NDJSON chunks. Debuggability tanks.
- The reconnect/re-run problem from SSE applies here too: if we wired auto-reconnect, we'd re-trigger the agent. If we didn't, we'd be using a duplex protocol for one-shot streams.

### Alternative C: Long-poll / wait-and-respond with full JSON

The "boring" answer: just `await` the full agent run server-side, return one big JSON payload at the end.

**Why it lost:**

- 100-115 seconds of empty UI. The user has no idea anything is happening. No reasoning trace, no tool call display, no "we're working on it" beyond a spinner.
- Any client-side timeout (browser, mobile carrier, CDN) cuts the response before it arrives. We'd see "investigation just hangs" reports.
- Cancellation is impossible from the UI side without dropping the whole connection, which doesn't actually cancel the server-side work.
- The product *is* the reasoning trace. Hiding it until done removes the demo value.

### Alternative D: Poll a status endpoint

Kick off the agent in a background queue (Vercel Cron, a dedicated worker), return immediately with an `investigationId`, have the client poll `/api/agent/status?id=...` every second or two.

**Why it lost:**

- Requires a job queue + a persistent store for the partial results. Both of these are infrastructure we explicitly avoided in RFC-001 (no database).
- Every poll is its own HTTP round-trip — overhead of ~50-100 events × 1-2s polling interval becomes minutes of compounded latency vs. seconds of streamed real-time.
- The polling shape is the right answer for *jobs that survive a page refresh* (e.g., a long export). Our agent runs are bound to a specific user session and a specific UI page; if the page closes, the work is wasted. No polling needed.

If the agent ever needs to survive page reloads (open question below), this is the alternative we revisit. Today it isn't.

### Alternative E: gRPC-Web / Connect-RPC streaming

The "use the framework" answer. Protocol buffers, generated clients, streaming RPC semantics, vendor-neutral.

**Why it lost:**

- Adds a code-generation build step + a runtime library for what is currently 20 lines of fetch + a `for` loop.
- The event types are simple enough (a discriminated union of 8 variants) that protobuf's schema language buys nothing over TypeScript's.
- Debuggability suffers — binary-framed protobuf vs. human-readable NDJSON in DevTools.
- One more vendor lock-shape on the way to where we want to be (host-agnostic).

```
  Alternatives matrix

  option            push-cadence   reconnect    bidirectional   infra-tax   chosen?
  ─────────────────  ────────────   ─────────    ─────────────   ────────    ───────
  NDJSON fetch       per-event      none ★       no              none        ★
  SSE/EventSource    per-event      auto ✗       no              none        no (auto-reconnect re-runs $)
  WebSocket          per-event      auto         yes             real        no (we don't need duplex)
  long-poll          end-of-run     n/a          no              none        no (silent UI)
  status-poll        every Ns       n/a          no              queue+DB    no (needs persistence)
  gRPC-Web           per-event      varies       yes             real        no (overkill for 8 event types)
```

---

## Tradeoffs accepted

We chose NDJSON over fetch-stream, accepting:

1. **Manual line-buffering in the consumer.** `buf.split('\n')` + `lines.pop()` is 4 lines of code, but getting it wrong produces parse errors that depend on TCP segmentation and are hard to reproduce. *We accept this — the alternative (SSE) re-runs the agent on disconnect.*

2. **No auto-reconnect.** Dropped connection = stream over. *We accept this as a feature — auto-reconnect was the SSE disqualifier.*

3. **No built-in client-side cancellation contract.** Aborting the fetch on the client doesn't necessarily cancel the server-side agent run (the `controller.close()` in `finally` runs but the agent loop may already have spent the tool calls). *We accept this — the agent's `maxToolCalls` budget bounds the cost regardless.*

4. **No event IDs / resume.** A reconnecting client can't ask for "events after the last one I saw." *We accept this — see open question #1.*

5. **Two consumers of the wire format** (actually three — `components/chat/StreamingResponse.tsx:107-132` carries a smaller third copy). `lib/hooks/useInvestigation.ts:184-201` (investigation hook) and `app/page.tsx:268-419` (feed page) each have their own copy of the reader loop. Drift risk. The duplication is also called out in `.aipe/study-frontend-engineering/audit.md` red-flag #2 — the architectural call (one shared `useNdjsonReader` vs hooks each own their own) is gated on the feed-page-hooks extraction. RFC-004 owns the framing for that gating. *We accept this — extraction is mechanical refactor work, not architectural.*

6. **The briefing route's `BriefingEvent` is a local superset of `AgentEvent`.** We deliberately did NOT widen the shared union (which would force the investigation view to handle event types it never receives). Two consumers, one core contract, one local extension. *We accept this — the discipline is "extend locally, never widen the contract."*

---

## Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Consumer's line-buffering bug → silent parse failures | Medium | The per-line `catch` block at `useInvestigation.ts:195-199` ignores malformed lines instead of failing the stream. Bugs in the buffer produce missing events, not crashes. Tests: `test/mcp/events.test.ts`. |
| TCP chunk lands mid-JSON, partial line discarded by mistake | Medium | `buf = lines.pop() ?? ''` is the load-bearing line. Diagrammed at `.aipe/study-system-design/05-streaming-ndjson.md`. Test covered. |
| Producer throws after first event sent → can't return HTTP 500 (headers already gone) | Medium | The `try`/`catch` inside `start()` converts thrown errors into `{ type: 'error', message }` NDJSON events. Consumer's switch handles `'error'` → `setError`. `app/api/agent/route.ts:255-260`. |
| Serverless function timeout cuts the stream before `done` | Medium | `maxDuration = 300` at `app/api/agent/route.ts:20` is Vercel Pro's max; combined run is ~100-115s, comfortable margin. Split-step flow reduces per-request to ~50-60s. On a stricter limit (Hobby's 60s), the combined run does NOT fit — partly why the flow split exists. |
| CDN buffers the response and the user sees nothing until the end | Low | `Cache-Control: no-cache, no-transform` header at `app/api/agent/route.ts:107-110` tells intermediaries not to buffer. Verified against Vercel's edge. |
| React StrictMode double-invokes the effect → two fetches → two agent runs | Medium | `startedRef` guard in `useInvestigation.ts:32-36, 43, 47-48` blocks the second invocation. We deliberately do NOT cancel on cleanup — cancelling on StrictMode's first cleanup while the guard blocks the re-mount aborts the stream and leaves the trace empty. |
| Multi-byte UTF-8 character split across two TCP chunks | Low | `TextDecoder.decode(value, { stream: true })` at `useInvestigation.ts:190` defers multi-byte sequences across calls. Without `{ stream: true }` the character becomes U+FFFD. |

---

## Rollout / migration

This was day-one shape. No rollout question.

The recent migration that matters: `bootstrapSchema()` moved *inside* the `ReadableStream` (`app/api/agent/route.ts:196-202`), with a `reasoning_step` emitted before the schema read. Before, the user stared at silence for 1-2s while the schema loaded. After, the first log line lands in ~50ms. Same architecture, better cadence.

The second recent migration: the `step` query param (`'diagnose' | 'recommend'`) splits the combined run into two requests. Each step runs one agent (live) or filters the cached snapshot for that step's events (replay). This lowered per-request wall-clock from ~115s to ~50-60s, gave us comfortable margin against any timeout, and matches the two-page UI flow. The wire format did not change. `app/api/agent/route.ts:66-84` (filter), `app/api/agent/route.ts:117-118` (parse).

---

## Open questions

1. **Resumable streams.** If a user drops connection at t=80s of a 115s run, the only recovery is "re-run from cache (if one exists) or re-run live (paying again)." A real resume would require server-side event IDs + a per-stream event log. Cost: a real persistent store (which RFC-001 explicitly avoided). Not justified yet — the cache replay path covers the dominant repeated-investigation case.

2. **Backpressure.** Producer writes as fast as it can; consumer reads as fast as it can. The `ReadableStream`'s `desiredSize` / `pull` mechanism is not used. For our event sizes (small JSON objects, 50-200 bytes after encode) and rates (10-100 events over 115s = far less than 1KB/s), buffer pressure is not a real concern. The day we stream large tool results raw, this changes.

3. **Two consumer loops, one wire format.** `useInvestigation.ts` and `app/page.tsx` each have their own `buf.split('\n')` loop. Extraction to a shared `readNdjsonStream(res, handle)` is straightforward. Not done yet because the two loops have slightly different error-handling needs (the feed page deals with `BriefingEvent`, the hook with `AgentEvent`). Mechanical refactor; deferred.

4. **The `error` event is the only mechanism for mid-stream failures.** The consumer handles it by setting `error` state. There's no retry-with-backoff, no "fall back to cached result." If the live run fails halfway, the user sees the error and re-runs by hand. Acceptable for current scope; will need a retry policy if/when we ship to less patient users.

5. **WebSocket revisit if we ship multi-user collaborative features.** If two users ever need to watch the same investigation as it runs, the broadcast pattern wants WebSocket (or SSE with broadcast). Not on the roadmap.

---

## What a reviewer will push on (and the framing that holds)

> "SSE is the standard for server push. Why are you fighting the platform?"

We're not fighting the platform — we're choosing a protocol whose reconnect semantics match our handler's idempotency. SSE's reconnect behavior is correct for cheap idempotent handlers and wrong for expensive non-idempotent ones. Ours is the second kind. The protocol choice follows the handler's properties, not the other way around.

> "You wrote your own line-buffering. That's a maintenance burden."

Four lines of code, tested by `test/mcp/events.test.ts`. The alternative (SSE) would have written its own bug — re-running a 115s agent on a flaky connection. The trade isn't "buffer code" vs. "no buffer code"; it's "buffer code" vs. "duplicate billing."

> "What if the connection drops?"

The user sees the error event (or, if the transport itself failed, a network error in the catch block), and re-runs by hand or hits the cache. We do not silently retry. If we silently retried, we'd silently double-spend.

> "Why not just await the full run server-side and return a single JSON?"

The product *is* the live trace. The user watches the agent reason, call tools, find evidence, and conclude. Compressing that into "100 seconds of nothing, then a final answer" removes the experience the product is selling.

> "WebSocket would be more performant."

For sending ~50 small events over ~115 seconds, the protocol overhead is in the noise. The infrastructure cost (Vercel WebSocket support, debugging the upgrade handshake) dominates. Performance is not the bottleneck; first-event latency and reconnect semantics are.

---

## References

- `lib/mcp/events.ts:4-22` — the `AgentEvent` wire contract + `encodeEvent` / `decodeEvent`
- `app/api/agent/route.ts:20` — `maxDuration = 300`
- `app/api/agent/route.ts:105` — `REPLAY_DELAY_MS = 180` (cache-replay pacing)
- `app/api/agent/route.ts:107-110` — NDJSON headers (`Content-Type` + `Cache-Control`)
- `app/api/agent/route.ts:127-141` — cache-replay producer (same wire format)
- `app/api/agent/route.ts:168-267` — live producer (`ReadableStream` + `send`)
- `app/api/agent/route.ts:196-202` — bootstrap-inside-stream (first-line cadence fix)
- `lib/hooks/useInvestigation.ts:32-36, 43, 47-48` — `startedRef` StrictMode guard
- `lib/hooks/useInvestigation.ts:153-212` — consumer loop
- `lib/hooks/useInvestigation.ts:184-201` — line-buffering kernel (`buf.split('\n')` + `lines.pop()`)
- `app/page.tsx:268-419` — second consumer loop (feed / briefing)
- `.aipe/study-system-design/05-streaming-ndjson.md` — deeper teaching guide on the mechanism
- `.aipe/study-networking/06-websockets-sse-streaming-and-realtime.md` — the broader transport landscape
- `.aipe/study-frontend-engineering/01-ndjson-stream-reader-hook.md` — the consumer-side walk (the hook-shaped reader loop)
- `.aipe/study-frontend-engineering/audit.md` — confirms the same NDJSON-over-fetch finding from the frontend lens (rendering-and-reactivity + data-fetching-and-cache lenses)
- `.aipe/rehearse-design-doc/04-framework-runtime-without-data-primitives.md` — the consumer-side companion RFC (why we hand-roll the reader instead of reaching for Suspense / use() / SWR)
- WHATWG HTML spec — `EventSource` (the standard we deliberately don't use)
- RFC 7230 — HTTP/1.1 chunked transfer encoding (the primitive that makes streaming work)

---

**Updated:** 2026-06-03 — cross-references added to `study-frontend-engineering/audit.md` and RFC-004 (the consumer-side companion). Reader-loop duplication tradeoff #5 expanded to acknowledge the third copy in `StreamingResponse.tsx` and the RFC-004 framing of the gated extraction.
