# Request, response, and data flow

**Industry name(s):** request lifecycle · data flow audit · streaming pipeline · waterfall vs parallel
**Type:** Industry standard · Language-agnostic

> blooming insights has **three live end-to-end flows + one replay shortcut**: the morning briefing (`/api/briefing`), the investigation step (`/api/agent?step=…`), and the free-form query (`/api/agent?q=…`). Each is a **one-way NDJSON stream**: the request opens the channel and the response continues *emitting events* until the agent loop reaches `done`. The flow is mostly sequential (no parallel MCP calls — the 1 req/s ceiling makes parallelism a footgun), with the deliberate exception of the *cache-replay shortcut* at the very top of `/api/agent`, which returns committed/in-process events without ever touching MCP or Anthropic. The load-bearing trick is that the route writes the *first* event (`stepFor(leadAgent, 'thought', 'reading the workspace schema…')`) INSIDE the stream, so the browser sees activity before any external call finishes.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Most apps you've shipped (AdvntrCue, dryrun) had request flows that ended with `return json(data)`. This codebase ends with `controller.close()` after potentially 200+ NDJSON lines. That single difference — *response as a stream of events instead of a result* — reshapes every layer above and below it. The UI doesn't `setData(result)`; it reads a `ReadableStream` and dispatches one event at a time. The route doesn't `return data`; it owns a controller and decides when to close. The agent loop has hooks (`onText`, `onToolCall`, `onToolResult`) that fire on every meaningful step.

```
  Zoom out — where this concept lives           ← we are here (every band)

  ┌─ UI ────────────────────────────────────────┐
  │   fetch(url) → body.getReader() → NDJSON loop│  ★ READS A STREAM ★
  └─────────────────────┬───────────────────────┘
                        │
  ┌─ Route handler ─────▼───────────────────────┐
  │   new ReadableStream({ async start(ctrl) {…}})│ ★ WRITES A STREAM ★
  └─────────────────────┬───────────────────────┘
                        │
  ┌─ Agent loop ───────▼────────────────────────┐
  │   hooks fire on every text/tool event        │ ★ EMITS STEPS ★
  └─────────────────────┬───────────────────────┘
                        │
  ┌─ McpClient + Bloomreach ────────────────────┐
  │   sequential calls (1.1s spaced)             │
  └──────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *for each of the three flows, what's the exact sequence of hops, who waits for whom, where is work serial vs parallel, and where does the cache shortcut the flow entirely?* The mechanics live in the legacy `01-request-flow.md` for the briefing flow (cited below for the hop-by-hop). This audit names *all three* flows side-by-side and ranks them by the same axis (control: code-decides vs model-decides) so you can see where the procedural pipeline ends and the agentic loop begins.

---

## Structure pass

**Layers.** The same five from file 01 (UI · Route · Agent · Provider · External). Request flow is the spine — it spans every band.

**Axis: control.** *Who decides what happens next at each layer?* The route decides the *outer* shape (schema → coverage → scan; or replay → done). The agent loop decides the *inner* shape (model picks tool → execute → loop). This is the right axis for request flow because the most consequential thing about a flow is "is this hop deterministic or does someone else (model, server) decide what comes next?" State and failure are downstream of control: once you know who's driving, you can ask "what state does the driver touch" and "what happens when the driver fails."

**Seams.** Three of interest, ranked by surprise.

- **S1: route → agent loop.** Control flips from CODE-decides (route's fixed pipeline order) to MODEL-decides (Claude chooses the next tool). This is the most consequential seam in the whole system — every later concern (latency, budget, output validation) hangs off this flip. **★ Load-bearing.**
- **S2: cache-replay shortcut at the top of `/api/agent`.** This is *the seam that doesn't exist for replay requests*. Before the route even thinks about connecting to MCP, it checks `getCachedInvestigation(insightId)` and, on a hit, opens the stream and replays canned events at a paced rhythm. The agent loop never runs. Bloomreach is never called. Anthropic is never called. The control axis on a replay request is: ROUTE-decides start-to-finish. Naming this as a seam is what makes the demo-mode pattern visible.
- **S3: route → client (NDJSON wire).** Control flips from server (writes events) to client (reads events). The contract: every line is a JSON object with a `type` discriminator; `done` or `error` ends the stream; trailing buffer after the final `\n` is parsed too.

```
  Structure pass — control across the three flows

  ┌─ 1. LAYERS ────────────────────────────────────────────┐
  │  UI · Route · Agent loop · Provider · External           │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 2. AXIS ────────────────▼────────────────────────────┐
  │  control: who decides what happens next?                │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 3. SEAMS ───────────────▼────────────────────────────┐
  │  S1: route → agent loop   (CODE → MODEL)  ★ load-bearing │
  │  S2: cache-replay shortcut (route-decides start-to-finish)│
  │  S3: route → client       (server-writes → client-reads) │
  └────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You've shipped `fetch(url).then(r => r.json()).then(setData)` a hundred times. The whole flow there is: open connection → wait → get one chunk → close → done. Now imagine the response is *long-running* — 30 seconds, 200 events, multiple agents thinking and making tool calls. You can't wait for the whole thing because the user will think the app froze, and you can't return early because there IS no "early" — every event matters. NDJSON streaming is the obvious answer: open the connection, write events as you produce them, close when done.

```
  The mental model — fetch() vs streaming fetch()

  normal fetch                              streaming fetch (this codebase)
  ──────                                    ─────
  fetch(url)                                fetch(url)
    .then(r => r.json())                      → r.body.getReader()
    .then(setData)                            → loop: read chunk, split on \n
                                              → dispatch each line
  ┌─────────────────────────┐               ┌─────────────────────────┐
  │ one big response         │               │ many small lines        │
  │ UI waits, then renders   │               │ UI renders as they land │
  │ atomic success/fail      │               │ partial-success possible│
  └─────────────────────────┘               └─────────────────────────┘
```

The shape that lands for every flow in this codebase: **request opens the channel; response emits events; the agent loop drives event emission via hooks; `done` ends it.** Two non-streaming requests exist (`/api/mcp/callback`, `/api/mcp/tools`) — those are just normal JSON endpoints. The three flows below are all streaming.

### Move 2 — each flow, hop by hop

#### Flow 1 — the morning briefing (`/api/briefing`)

The page mounts → fires `fetch('/api/briefing')` (or `?demo=cached`) → the route opens a stream → emits `workspace` event → emits `coverage_item` × 10 (gate the 10-category checklist against the live schema) → emits `tool_call_start` / `tool_call_end` for each EQL the monitoring agent runs → emits one `insight` per anomaly the agent flags → emits `done` → closes.

```
  Briefing — request lifecycle (live mode)

  Browser                Route                Agent (Monitoring)     Bloomreach MCP

  fetch /api/briefing ──►                                                          │
                          getOrCreateSessionId                                      │
                          connectMcp(sid)  ──── (cookie has tokens)                 │
                          new ReadableStream                                        │
                          ◄── 200 OK + content-type: x-ndjson                       │
  reader.read() ──►       step('reading the workspace schema…')                     │
                          bootstrapSchema(mcp) ──────────────────────────► get_event_schema
                                                                       ◄──         │ result
                                                ──────────────────────► get_customer_property_schema
                                                                       ◄──         │
                                                ──────────────────────► list_catalogs
                                                                       ◄──         │
                                                ──────────────────────► get_project_overview
                                                                       ◄──         │
                          send({workspace})                                         │
                          schemaCapabilities + coverageReport                       │
                          send({coverage_item}) × 10  (tile by tile)                │
                          MonitoringAgent.scan(runnable)                            │
                                                onToolCall ──► send({tool_call_start})
                                                              ──────────────────► execute_analytics_eql
                                                                                ◄──│ result
                                                onToolResult ─► send({tool_call_end + result})
                                                                                    │
                                                  … repeats up to maxToolCalls=6 …  │
                                                model: "here are my anomalies as JSON"
                          parse + sort + slice(10)                                  │
                          send({insight}) × N                                       │
                          send({done})                                              │
                          controller.close()
                          ◄── stream ends                                            │
  done ──► render feed                                                              │
```

The whole flow is one HTTP request, one TCP connection, no parallelism. The route blocks on each `await`: the 4 schema calls are sequential (~5s total at 1.1s spacing), the up-to-6 EQL calls are sequential, and inside each EQL call the Anthropic model latency adds 1–3s for the reasoning between calls. End-to-end on a cold start: 30–60 seconds for the visible insights to start landing in the UI.

#### Flow 2 — an investigation step (`/api/agent?step=diagnose`)

The investigate page mounts → `useInvestigation(id, 'diagnose')` fires `fetch('/api/agent?insightId=…&step=diagnose')` → the route checks the cache first. **If cached** (which is the common path in demo mode and after the first run on a warm instance): replay the cached events filtered to `step='diagnose'`, paced at 180ms each, never touching MCP or Anthropic. **If live**: connect, bootstrap schema, run DiagnosticAgent (up to 6 tool calls), emit `diagnosis`, send `done`.

```
  Investigation step — cache-replay vs live (the S2 shortcut)

  ┌─ Cached path (common) ─────────────────────────────────────┐
  │                                                             │
  │  fetch /api/agent?insightId=X&step=diagnose                 │
  │       │                                                     │
  │       ▼                                                     │
  │  getCachedInvestigation(X)  ◄── hit                         │
  │       │                                                     │
  │       ▼                                                     │
  │  filterByStep(events, 'diagnose')                           │
  │       │                                                     │
  │       ▼                                                     │
  │  for e in events: send(e); await sleep(180ms)               │
  │       │                                                     │
  │       ▼                                                     │
  │  controller.close()                                         │
  │                                                             │
  │  total latency: ~180ms × N events  (paced for readability)  │
  │  external calls: 0                                          │
  │  cost: $0 (no Anthropic tokens, no MCP quota)               │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Live path (live mode or no cache) ────────────────────────┐
  │                                                             │
  │  fetch /api/agent?insightId=X&step=diagnose&live=1          │
  │       │                                                     │
  │       ▼                                                     │
  │  getCachedInvestigation(X)  ◄── miss (or live=1 skips it)   │
  │       │                                                     │
  │       ▼                                                     │
  │  resolveAnomaly(X, ?insight=…)  ◄── client may stash        │
  │       │                                                     │
  │       ▼                                                     │
  │  getOrCreateSessionId → connectMcp → bootstrapSchema        │
  │       │                                                     │
  │       ▼                                                     │
  │  DiagnosticAgent.investigate(anomaly, hooks)                │
  │     loop (≤6 tool calls):                                   │
  │       send({reasoning_step}) on each text block             │
  │       send({tool_call_start}) → mcp.callTool → send({tool_call_end}) │
  │       loop again until done                                 │
  │     if !parseable: synthesize() — tool-less synthesis call  │
  │     return Diagnosis                                        │
  │       │                                                     │
  │       ▼                                                     │
  │  send({diagnosis})                                          │
  │  send({done})                                               │
  │  saveInvestigation(X, collected)  (only on combined runs)   │
  │  controller.close()                                         │
  │                                                             │
  │  total latency: 30–90s typical                              │
  │  external calls: 4 schema + ≤6 EQL + ≤7 Anthropic           │
  └─────────────────────────────────────────────────────────────┘
```

The recommend step (`?step=recommend`) does the same shape but reads the diagnosis from a query param (`?diagnosis=…`, base64-stashed by the client from `sessionStorage`). If no diagnosis is handed over, the route throws — the client guarantees one is present because step 3 is reached *after* step 2 completed and stashed its diagnosis. The combined run (`step=null`) is reserved for `/api/mcp/capture-demo` to seed the demo snapshot.

#### Flow 3 — the free-form query (`/api/agent?q=…`)

The feed's `QueryBox` fires `fetch('/api/agent?q=…')` → the route opens a stream → routes to `QueryAgent.answer`. The agent runs `classifyIntent` first (a fast Anthropic call that picks one of four intents), then runs the loop with the query-tool subset, then emits the final natural-language answer as a `reasoning_step` with `kind: 'conclusion'`. No `insight`, no `diagnosis`, no `recommendation` events — just text.

```
  Query flow — the simplest of the three

  fetch /api/agent?q="why did mobile drop?"
       │
       ▼
  classifyIntent(anthropic, q)  ──► one of: trend | composition | comparison | drilldown
       │
       ▼
  send({reasoning_step kind:'thought' content:'interpreting as a trend query'})
       │
       ▼
  QueryAgent.answer(q, intent, hooks)
       │  loop (≤6 tool calls): reasoning_step + tool_call_* events
       ▼
  send({reasoning_step kind:'conclusion' content: finalText})
  send({done})
  controller.close()
```

This flow is *never cached* — `getCachedInvestigation` is keyed by `insightId`, and queries have no insight id. Every query is a live run; budget-bound at ~6 tool calls + 1 intent classification call.

#### S2 — the cache-replay shortcut as its own architectural pattern

This deserves its own callout because it's a load-bearing piece of the demo story. The route's first line of real logic on `/api/agent` is the cache check:

```
  app/api/agent/route.ts  (lines 127–141)  ← annotated

  const cached = insightId && !live ? getCachedInvestigation(insightId) : null;
  if (cached) {
    const events = step ? filterByStep(cached, step) : cached;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const e of events) {
          controller.enqueue(encoder.encode(encodeEvent(e)));
          await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: NDJSON_HEADERS });
  }
       │
       └─ this 14-line block IS the demo mode. No MCP, no Anthropic, no auth.
          The browser sees identical-shape NDJSON events at a paced rhythm.
          The UI code is the same. The wire format is the same. The only
          difference is that the route never crossed B2.
```

Three things make this work: the wire format is shared (NDJSON `AgentEvent` lines are produced the same way in both live and cached paths); the cache key (`insightId`) is stable; and the replay pacing (`REPLAY_DELAY_MS = 180ms` for agent events, 140ms for briefing) makes a cached replay feel like a live run instead of an instant data-dump. This is the same architectural pattern as `useState` in React — *the consumer sees the same shape regardless of which code path produced it.*

### Move 3 — the principle

**Streaming pulls perceived latency away from real latency.** Real latency for an investigation is 30–90s. Perceived latency is "how long until I see *something* on the screen" — and that's 200ms because the route writes `step('reading the workspace schema…')` inside the stream *before* the schema bootstrap. The user is reading a status line while the route is still waiting for the first MCP call. The choice to stream isn't about throughput (we're not bandwidth-bound), it's about *responsiveness perception*. The same architecture as a CLI progress bar — the work isn't faster, but you know it's working. This is the underlying principle behind every choice in this layer: NDJSON over plain JSON, hooks over batched results, paced replay over instant data-dump.

---

## Primary diagram

The full recap visual — three flows + the replay shortcut, side by side, with the seams marked.

```
  Three live flows + one replay shortcut

  ┌─ Flow 1 — BRIEFING ─────────────────────────────────────────────────────────┐
  │  Browser  ──► /api/briefing                                                  │
  │              session → connect → bootstrap → coverage gate → monitoring scan │
  │              ◄── NDJSON: workspace, coverage_item×10, tool_*, insight×N, done│
  │  total: 30–60s · external: 4+≤6 MCP, ≤7 Anthropic                            │
  └──────────────────────────────────────────────────────────────────────────────┘
                                  │  S1 (CODE→MODEL) inside MonitoringAgent.scan
  ┌─ Flow 2 — INVESTIGATION STEP ───────────────────────────────────────────────┐
  │  Browser  ──► /api/agent?insightId=…&step=diagnose                           │
  │                                                                              │
  │              ┌─ S2: cache-replay shortcut (the common path) ───────────────┐ │
  │              │  cached? → filterByStep → paced replay → done              │ │
  │              │  total: ~180ms × N events · external: 0                    │ │
  │              └──────────────────────────────────────────────────────────────┘ │
  │                                                                              │
  │              ┌─ live path ──────────────────────────────────────────────────┐ │
  │              │  miss → resolve → connect → schema → DiagnosticAgent          │ │
  │              │  ◄── NDJSON: reasoning_step, tool_*, diagnosis, done          │ │
  │              │  total: 30–90s · external: 4+≤6 MCP, ≤7 Anthropic              │ │
  │              └──────────────────────────────────────────────────────────────┘ │
  │                                                                              │
  │  next: step=recommend reads the diagnosis from ?diagnosis=… (client-stashed) │
  └──────────────────────────────────────────────────────────────────────────────┘

  ┌─ Flow 3 — QUERY ───────────────────────────────────────────────────────────┐
  │  Browser  ──► /api/agent?q="why did mobile drop?"                            │
  │              classifyIntent → QueryAgent.answer                              │
  │              ◄── NDJSON: reasoning_step×N, tool_*, reasoning_step(conclusion)│
  │              ◄── NDJSON: done                                                │
  │  total: 20–40s · external: 1+≤6 MCP, ≤7 Anthropic · NEVER CACHED             │
  └──────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

**Use case 1 — a returning visitor opens an insight.** Cached path. `useInvestigation('abc', 'diagnose')` fires → route checks `getCachedInvestigation('abc')` → returns the 30+ events recorded during the last live run → replays at 180ms/event → UI fills in over ~5–6 seconds. Zero external calls.

**Use case 2 — a fresh visitor in live mode investigates.** Live path. The page sets `localStorage.bi:mode = 'live'`, the hook adds `&live=1` to the URL, the route's `!live` guard skips the cache. Full live flow runs, 30–90s, ending with `saveInvestigation` writing into the in-process `Map` so the next visitor on the *same instance* gets a cached replay.

**Use case 3 — the user asks "why did mobile drop?" in the query box.** Never cached. `classifyIntent` picks `trend`, the QueryAgent runs with the EQL tool, the route emits reasoning + tool events + a final conclusion. The browser renders the conclusion as the answer text under the query.

### File · function index for each flow

| Flow | File · Function | Lines | What it owns |
|---|---|---|---|
| Briefing demo replay | `app/api/briefing/route.ts` · `GET` | L75–L151 | Paced NDJSON replay of `demo-insights.json` |
| Briefing live | `app/api/briefing/route.ts` · `GET` | L153–L257 | Schema → coverage gate → monitoring scan → emit insights |
| Agent cache check | `app/api/agent/route.ts` · `GET` | L127–L141 | The S2 shortcut |
| Agent live | `app/api/agent/route.ts` · `GET` | L143–L264 | Live diagnostic/recommendation/query flow |
| Agent loop | `lib/agents/base.ts` · `runAgentLoop` | L48–L176 | The CODE→MODEL flip — Claude picks tools, loop dispatches |
| NDJSON encoding | `lib/mcp/events.ts` · `encodeEvent` | L15–L17 | `JSON.stringify(e) + '\n'` — the wire format |
| NDJSON decoding | `lib/hooks/useInvestigation.ts` · the reader loop | L184–L208 | Read chunks, split on `\n`, parse each line, dispatch |
| Replay pacing | `app/api/agent/route.ts` · `REPLAY_DELAY_MS` | L105 | 180ms between events in cache-replay |
| Replay pacing (briefing) | `app/api/briefing/route.ts` · `REPLAY_DELAY_MS` | L23 | 140ms between events in demo replay |
| Step filter | `app/api/agent/route.ts` · `filterByStep` | L66–L84 | Splits a combined investigation into per-step replay |
| Anomaly resolution | `app/api/agent/route.ts` · `resolveAnomaly` | L37–L62 | Client param → in-memory map → demo snapshot waterfall |

### Sample — the first-event-inside-the-stream trick

```
  app/api/agent/route.ts  (lines 196–203)  ← annotated

  try {
    // Bootstrap INSIDE the stream so the client sees progress immediately
    // (instead of a silent wait while we connect + read the schema).
    const leadAgent: AgentName =
      q && !insightId ? 'coordinator' : step === 'recommend' ? 'recommendation' : 'diagnostic';
    stepFor(leadAgent, 'thought', 'reading the workspace schema…');
    const schema = await bootstrapSchema(conn.mcp);
       │
       └─ the stepFor() call IS the "your request is being worked on" signal.
          Without it, the user would wait 4–5 seconds (4 sequential schema
          MCP calls at 1.1s spacing) before any event arrived. With it, the
          UI gets a reasoning_step in <100ms — long before bootstrapSchema
          finishes. The browser feels alive. This is the load-bearing
          ergonomic choice that justifies the streaming pattern at all.
```

### Sample — the NDJSON reader loop on the client

```
  lib/hooks/useInvestigation.ts  (lines 184–208)  ← annotated

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });   ← {stream: true} handles multi-byte UTF-8 splits
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';                       ← last segment may be partial; hold it
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line) as AgentEvent);
      } catch {
        /* ignore malformed line */
      }
    }
  }
  if (buf.trim()) {                                ← final flush — buffer after last \n
    try { handle(JSON.parse(buf) as AgentEvent); } catch { /* ignore */ }
  }
       │
       └─ this is the mechanism behind every flow in this guide. Read chunks
          (network-aligned, not event-aligned), accumulate in a buffer, split
          on \n, hold the trailing partial line for the next chunk. Without
          the buf.pop() trick, every chunk boundary would mangle one event.
          The legacy 02-dsa/03-ndjson-line-buffering.md teaches this kernel
          at mechanism depth — this audit just names it as the contract.
```

---

## Elaborate

### Why three flows and not one

The three flows are *different shapes of work* — that's why they're separate. The briefing scans the whole workspace and produces a list (broad, shallow, fixed-iteration). The investigation drills into one anomaly (narrow, deep, agent-driven). The query answers a free-form question (no fixed shape). They share the agent loop and the NDJSON wire, but they don't share routes because their parameters (workspace-wide vs `insightId` vs `q=`), their state implications (insights map vs investigation map vs no map), and their auth requirements (briefing needs schema + monitoring tools; query needs schema + query tools) all differ. Collapsing them into one route would require a discriminator on every parameter and would hide which agents run when. The three-route split is the right call for ~5K LOC; it might consolidate when there are 10 flows.

### Where parallelism would help — and where it'd hurt

**Hurts.** Parallel MCP calls. The Bloomreach rate limit is GLOBAL per user, so parallel calls just get 429'd and re-serialized through the retry path — net latency goes up. The codebase correctly serializes (see `lib/mcp/schema.ts` L177–L182 "Sequential — the server allows ~1 req/s").

**Could help.** The 4 schema bootstrap calls *could* batch via a single `get_workspace_schema` MCP tool if the upstream supported it — but it doesn't, so we make 4 calls. The coverage gate is pure (no I/O), so it's free. The Anthropic call between agent turns is serial by construction (each turn depends on the previous turn's tool results).

**Where it would help if added.** A single MCP call that returned event schema + customer props + catalogs + overview together would shave ~3s off every briefing's cold start. That's an upstream-feature ask, not a client-side fix.

### Cache-replay vs server-side rendering

The cache-replay pattern is a poor man's "server-side render of an investigation." If you wanted to make the cached path fast as well as cheap, you'd skip the NDJSON entirely and return the full investigation as one JSON blob — the UI then takes one render pass to populate. We chose the replay shape so the *demo* feels like a live run. That's a UX call, not a latency call: the cache hit is already free; we're paying ~6 seconds of paced replay deliberately so the demo shows the agent "thinking." For a non-demo product, an instant return would be the right call.

### Cross-link to legacy mechanism teaching

- The briefing flow walked hop-by-hop with anchors → `.aipe/study-system-design-dsa/01-system-design/01-request-flow.md`
- The NDJSON wire format + how the route writes a stream → `.aipe/study-system-design-dsa/01-system-design/05-streaming-ndjson.md`
- The client-side stream reader + the cross-step handoff via `sessionStorage` → `.aipe/study-system-design-dsa/01-system-design/07-client-stream-handoff.md`
- The multi-agent orchestration (one loop, four agents, forced-final synthesis) → `.aipe/study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md`
- The NDJSON line-buffering kernel (chunk → buffer → split → pop trailing partial) → `.aipe/study-system-design-dsa/02-dsa/03-ndjson-line-buffering.md` (mechanism-level depth)

---

## Interview defense

**What they are really asking:** can you walk a request end-to-end without hand-waving, name where work is serial vs parallel, and defend the streaming choice?

---

**[mid] — Walk me through what happens when a user clicks "investigate this insight."**

The page mounts the investigation route. `useInvestigation` fires `fetch('/api/agent?insightId=X&step=diagnose')`. On the server, the route first checks `getCachedInvestigation(X)` — if hit, it opens a stream and replays the cached events at 180ms each. If miss, it resolves the anomaly (either from the `?insight=` param the client stashed, or from the in-memory `Map`, or from the demo JSON), connects to MCP (which checks the encrypted `bi_auth` cookie for tokens), bootstraps the workspace schema, and runs `DiagnosticAgent.investigate`. The agent runs `runAgentLoop` — up to 6 tool calls, each one going through `McpClient` with the 1.1s spacing and the bounded rate-limit retry. Every text block from the model is emitted as a `reasoning_step` event; every tool call emits `tool_call_start` and `tool_call_end`. When the agent emits its final `Diagnosis` JSON, the route emits a `diagnosis` event, then `done`, then closes. On the client, `useInvestigation` reads the body with a chunked reader, splits on `\n`, parses each line, and dispatches it into React state.

```
  click ──► fetch ──► cache check ──► [hit: replay] OR [miss: live]
  live: connect → schema → DiagnosticAgent.investigate → emit events → done
```

---

**[senior] — Why streaming and not just `return json(diagnosis)`?**

Perceived latency. A diagnosis takes 30–90 seconds — Anthropic latency plus 6 MCP calls at 1.1s spacing plus potential retries. If we returned one JSON blob at the end, the user would stare at a spinner for a minute and the app would feel broken. Streaming lets us emit `step('reading the workspace schema…')` in the first 200ms — *inside* the stream's `start(controller)` body, before any external call resolves — and then every tool call and every reasoning step as it happens. The user is reading the agent's work in real time. Real latency is unchanged; perceived latency drops from "30s blank" to "200ms first event, then activity for 30s." Same architecture as a CLI progress bar — the work isn't faster, but you know it's working.

```
  perceived latency

  ┌─ return json ──┐         ┌─ NDJSON stream ─────────────────────────────┐
  │ 30s blank      │         │ 200ms first event, then activity for 30s      │
  │ then full data │  vs     │ user reads the agent thinking                  │
  └────────────────┘         └────────────────────────────────────────────────┘
```

---

**[arch] — Where would you add parallelism in this pipeline?**

Almost nowhere — and that's the point. The Bloomreach rate limit is GLOBAL per user at ~1 req/s, so parallel MCP calls collide and re-serialize through the retry path. The 4 schema bootstrap calls *could* batch if upstream offered a combined endpoint, but they don't, so we serialize at 1.1s spacing. The Anthropic calls between agent turns are inherently sequential (each turn depends on the previous turn's tool results). Where I *could* add parallelism is independent investigations across users — but those already run in independent Vercel instances. The honest answer: this pipeline is shaped by external rate limits, not by our compute, so adding parallelism inside the pipeline buys nothing. The next architectural move is *vertical* (a queue between route and agent loop) not horizontal (parallel calls).

---

**The dodge — "have you measured real latency?"**

Not in production. I have observed it via the route's structured logs (`console.error` with full stack on failure) and via running the live flow on `/?live=1` against my own Bloomreach project. Briefing cold-start runs ~30–60s; investigation runs ~30–90s; query runs ~20–40s. Those are wall-clock numbers from manual runs, not p50/p99 from a real metrics pipeline. There's no instrumentation in the codebase — no Datadog, no OpenTelemetry, no `console.time`. For a real production deployment, the next move is to instrument the route handlers and the agent loop's per-turn duration. That'd let me answer "is the bottleneck Anthropic latency or MCP spacing?" empirically instead of by inspection.

---

**One-line anchors:**
- Three flows + one cache-replay shortcut; all share the NDJSON `AgentEvent` wire format.
- The first event inside the stream (`stepFor(..., 'reading the workspace schema…')`) is the load-bearing UX trick.
- Parallelism inside the pipeline buys nothing because the rate limit is global per user.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, draw the three flows. For each, list the events in order, name which events the agent loop emits via hooks, and mark which flow can hit the cache-replay shortcut. Check against the primary diagram.

### Level 2 — Explain
Why does `/api/agent/route.ts` check the cache *before* doing any auth setup? What would change if we put the cache check after `connectMcp`? Reference `app/api/agent/route.ts` L127–L141 and L155–L166.

### Level 3 — Apply
A teammate proposes adding a "share this investigation" feature: a user can send a URL that opens someone else's cached investigation. Walk through which flow this uses, what cache mechanism (the in-process Map vs the demo file) it would need to read from, and where the per-Vercel-instance state would break it. Reference `lib/state/investigations.ts`.

### Level 4 — Defend
Defend the choice to make queries (`?q=`) never cached, while investigations are. When would caching a query be valuable, and what'd it cost?

### Quick check
- Which file owns the cache-replay shortcut? → `app/api/agent/route.ts` L127–L141
- Which file owns the NDJSON line-buffering reader? → `lib/hooks/useInvestigation.ts` L184–L208
- Which constant controls replay pacing? → `REPLAY_DELAY_MS` (`app/api/agent/route.ts` L105 = 180ms; `app/api/briefing/route.ts` L23 = 140ms)
- Which hop is the CODE→MODEL control flip? → `runAgentLoop` (`lib/agents/base.ts` L85–L102, model picks tools)

---

## See also

→ [01-system-map-and-boundaries.md](./01-system-map-and-boundaries.md) · [03-state-ownership-and-source-of-truth.md](./03-state-ownership-and-source-of-truth.md) · [06-failure-handling-and-reliability.md](./06-failure-handling-and-reliability.md) · `.aipe/study-system-design-dsa/01-system-design/01-request-flow.md` (briefing hop-by-hop) · `.aipe/study-system-design-dsa/01-system-design/05-streaming-ndjson.md` (NDJSON mechanism) · `.aipe/study-system-design-dsa/01-system-design/07-client-stream-handoff.md` (client reader + handoff)
