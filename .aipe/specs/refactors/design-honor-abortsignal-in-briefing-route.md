# Design refactor — honor `req.signal` inside `/api/briefing` stream

> Source: `.aipe/audits/design-2026-06-15.md` Lens 4 (layers — the route's stream does not honor its request's cancellation signal, breaking the cancel-on-poll contract the layer below already supports).
> Source: discovered while writing `test/api/briefing.integration.test.ts:289` — the cancellation test (Test 6) is documented as SKIPPED because the route doesn't read `req.signal`. The test exists; the wire it tests doesn't.
> Cross-ref: `test/api/briefing.integration.test.ts:275-291` — the explicit `it.skip` and the documented reason.
> Verification harness: this refactor flips the skip into a real test — `test/api/briefing.integration.test.ts:289` becomes a real `it(...)` after this lands.

---

## What to refactor

The `/api/briefing` route opens an NDJSON `ReadableStream` and runs schema bootstrap + coverage gate + monitoring scan inside `start(controller)`. It does not read `req.signal`; it does not pass an `AbortSignal` to its in-flight work. When the client cancels (closes the tab, navigates away, the React `useEffect` cleanup runs `cancelled = true`), the route keeps running — burning the full 300s budget on work whose consumer is gone.

The same gap exists at `/api/agent`'s stream (`app/api/agent/route.ts:168-294`); fix both in scope.

The fix is small and localized:

- `app/api/briefing/route.ts:181` — `start(controller)` signature already has access to the outer `req` from the `export async function GET(req)` closure (`:76`). Wire `req.signal` through to:
  - `bootstrapSchema(mcp, { signal: req.signal })` (`:200`) — if the schema bootstrap takes a signal option; if not, add it.
  - `MonitoringAgent.scan(...)` (`:240-257`) — needs an `AbortSignal` parameter the agent threads to `runAgentLoop` and from there to `anthropic.messages.create({ signal })`.
  - The `for (const insight of listInsights(sid))` send loop (`:262`) — should check `req.signal.aborted` between sends.
- `app/api/agent/route.ts:169` — same plumbing. Wire `req.signal` to `bootstrapSchema`, the four agent classes (`DiagnosticAgent.investigate`, `RecommendationAgent.propose`, `QueryAgent.answer`, `classifyIntent`), and the cached-replay loop at `:130-134`.

On cancellation: the catch block already exists; the cancelled work throws an `AbortError`, the catch logs `redactSecrets(formatError(e))`, the finally emits the phase summary. No new behaviour visible to clients (they've cancelled — they're not reading).

---

## Why

Three reasons, in order of leverage:

1. **The cancel contract exists at the layer below but the layer above doesn't reach for it.** `lib/streaming/ndjson.ts:33` polls `cancelOn` between reads, so an unmounted consumer of the briefing stream WILL break out of the parser side cleanly. `lib/mcp/transport.ts:123` uses `AbortSignal.timeout(TOOL_TIMEOUT_MS)` per MCP call, so the transport side already knows what an `AbortSignal` is. The route is the missing link: it accepts a `NextRequest` (which carries `req.signal`) and runs a long stream, but doesn't pass the signal down. **That's a pass-through-the-layer failure** — the route layer is supposed to translate "client cancelled" into "stop the work below," and it doesn't.

2. **Burned 300s budget per cancelled request is a real ops cost.** Vercel charges by execution time, not by response bytes. A user who navigates away mid-briefing today incurs the full schema_bootstrap + coverage_gate + list_tools + monitoring_scan execution — averaging tens of seconds per Anthropic call × multiple tool-use turns. The phase-timing log (`app/api/briefing/route.ts:277`) records the burn but doesn't prevent it. Honoring `req.signal` short-circuits this.

3. **The integration test scaffold already has the test, marked as skipped.** `test/api/briefing.integration.test.ts:289` is `it.skip('cleans up reader on client cancel — needs route-side signal handling', () => {})`. The test file explicitly documents WHY: *"the route's `start(controller)` does not read `req.signal` and has no abort guard inside its bootstrap loop, so a consumer-side cancel doesn't shorten the route's work."* This refactor flips the skip into a real test. The verification harness is already written — it's just gated on the route doing what this spec lifts.

---

## Refactor type

**Invert Dependency** (the route's stream gains a dependency on `req.signal`, threading it to the work below) + **Pull Complexity Downward** (the abort decision moves from "the route runs to natural completion regardless of consumer" to "the route honors its consumer's cancellation, which is the contract a long-lived response is supposed to obey").

Not Extract Function (no extraction). Not Move Function (nothing moves). Not Separate Pure from Effectful (the work is already effectful end-to-end; this is about cancellation, not purity).

---

## Current structure

```
  /api/briefing — stream layer doesn't see the request signal
  ┌──────────────────────────────────────────────────────────┐
  │ export async function GET(req: NextRequest) {             │
  │   /* ... preflight checks; demo branch; auth gate ... */  │
  │                                                           │
  │   const stream = new ReadableStream<Uint8Array>({         │
  │     async start(controller) {                             │
  │       try {                                               │
  │         const schema = await bootstrapSchema(mcp);  ◄── no signal │
  │         /* ... coverage gate (in-memory, fast) ... */     │
  │         const raw = await mcp.listTools();          ◄── transport │
  │                                                       has timeout │
  │                                                       but no link │
  │                                                       to req      │
  │         const anomalies = await agent.scan({        ◄── no signal │
  │           onToolCall, onToolResult, onText,               │
  │         }, runnable);                                     │
  │         /* ... send insights, done ... */                 │
  │       } catch (e) { /* error event */ }                   │
  │       finally { /* phase log */ }                         │
  │     },                                                    │
  │   });                                                     │
  │ }                                                         │
  └──────────────────────────────────────────────────────────┘

  client cancels → readable stream closes → start() keeps running
                   to natural completion → finally fires → budget burned
```

The transport-layer 30s timeout (`lib/mcp/transport.ts:123`) bounds each MCP call but doesn't react to the client cancelling. The agent-layer `runAgentLoop` (`lib/agents/base.ts:103`) has no signal parameter and no abort check between turns. The route is the closest layer to the request and the only one that has `req.signal` in scope — but it doesn't pass it down.

---

## Target structure

```
  /api/briefing — signal threaded through every layer
  ┌──────────────────────────────────────────────────────────┐
  │ export async function GET(req: NextRequest) {             │
  │   /* ... preflight checks; demo branch; auth gate ... */  │
  │                                                           │
  │   const stream = new ReadableStream<Uint8Array>({         │
  │     async start(controller) {                             │
  │       try {                                               │
  │         req.signal.throwIfAborted();           ◄── early bail │
  │         const schema = await bootstrapSchema(mcp, {       │
  │           signal: req.signal,                             │
  │         });                                               │
  │                                                           │
  │         req.signal.throwIfAborted();                     │
  │         const raw = await mcp.listTools({                 │
  │           signal: req.signal,                             │
  │         });                                               │
  │                                                           │
  │         const anomalies = await agent.scan({              │
  │           onToolCall, onToolResult, onText,               │
  │           signal: req.signal,            ◄── threaded     │
  │         }, runnable);                                     │
  │                                                           │
  │         req.signal.throwIfAborted();                     │
  │         for (const insight of listInsights(sid))          │
  │           send({ type: 'insight', insight });             │
  │         send({ type: 'done' });                           │
  │       } catch (e) {                                       │
  │         if (e instanceof DOMException &&                  │
  │             e.name === 'AbortError') {                    │
  │           /* client cancelled — no error event, finally   │
  │              still runs the phase log */                  │
  │           return;                                         │
  │         }                                                 │
  │         console.error('[briefing] error:',                │
  │           redactSecrets(formatError(e)));                 │
  │         send({ type: 'error',                             │
  │           message: '/api/briefing · ' + ... });           │
  │       } finally {                                         │
  │         /* phase log fires even on abort — operators       │
  │            see how much budget was burned before cancel */│
  │         console.log(JSON.stringify({                      │
  │           route: '/api/briefing', sessionId: sid,         │
  │           totalMs, phases, aborted: req.signal.aborted    │
  │         }));                                              │
  │         controller.close();                               │
  │       }                                                   │
  │     },                                                    │
  │   });                                                     │
  │ }                                                         │
  └──────────────────────────────────────────────────────────┘
```

End state: the route layer passes the signal to every layer below. `bootstrapSchema`, `McpClient.listTools`, the four agent classes' public methods, and `runAgentLoop` all gain an optional `signal?: AbortSignal` parameter. The signal is checked at three coarse-grained checkpoints in the route (between phases) AND inside `runAgentLoop`'s loop (between turns).

The implementation surface fans out:

- `lib/agents/base.ts:48` — `RunAgentLoopOpts<T>` gains `signal?: AbortSignal`. The for-loop at `:103` checks `opts.signal?.aborted` and bails. The `anthropic.messages.create(params)` call at `:120` passes `params.signal = opts.signal` so the SDK aborts in-flight.
- `lib/agents/{monitoring,diagnostic,recommendation,query}.ts` — each agent's public method (`scan`, `investigate`, `propose`, `answer`) gains an `opts.signal?` and threads it to `runAgentLoop`.
- `lib/agents/intent.ts` — `classifyIntent(anthropic, query, sessionId?, signal?)` adds the signal as the 4th param, threaded to the SDK call.
- `lib/mcp/schema.ts` — `bootstrapSchema(mcp, { signal?: AbortSignal })` accepts the signal and threads it to its internal `mcp.callTool` calls.
- `lib/mcp/client.ts` — `McpClient.callTool(name, args, opts)` and `listTools()` gain `signal?: AbortSignal` in opts. The signal composes with the existing `AbortSignal.timeout(TOOL_TIMEOUT_MS)` via `AbortSignal.any([signal, timeout])` (modern browsers + Node 20+).
- `lib/mcp/transport.ts:123` and `:142` — the existing `AbortSignal.timeout` composes with the propagated signal via `AbortSignal.any([opts.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)])`.

This is wider than a one-file refactor but the SHAPE is the same at every layer: add an optional signal, thread it down. No layer's API changes for callers who don't pass a signal. All existing tests pass without modification.

---

## Must not change

- **The 7+9 integration tests at `test/api/briefing.integration.test.ts` + `test/api/agent.integration.test.ts` must stay green without modification.** Their tests never cancel the response, so the signal-propagation path is dormant under those tests. They verify the non-cancelled path is unchanged.
- **The 199+ existing unit tests must stay green.** `runAgentLoop`, `McpClient`, `bootstrapSchema`, the four agent classes — all of their existing test cases call without a signal. The signal parameter is optional; the existing call shape is unchanged.
- **No client-visible response shape change.** The NDJSON event variants, the JSON 401/500 bodies, the headers — all unchanged.
- **The phase-timing log shape adds ONE optional field (`aborted: boolean`).** That's a non-breaking addition; the existing 7 fields stay; downstream Vercel filters that key on `route` / `phases.phase` / `totalMs` continue to work.
- **The transport-layer 30s per-call timeout (`TOOL_TIMEOUT_MS`) is preserved.** The composition is `AbortSignal.any([client_cancel_signal, AbortSignal.timeout(30_000)])` — whichever fires first wins. The 30s ceiling continues to bound any single MCP call.
- Do not touch `lib/state/insights.ts`, `lib/state/investigations.ts`, `lib/streaming/ndjson.ts`, `app/api/mcp/{call,tools,reset,capture}/route.ts`.
- Do not change `lib/mcp/auth.ts` or `lib/mcp/connect.ts` — the auth/connect chain is short, runs before the stream opens, and doesn't need cancellation.

---

## Must not introduce

- No new dependencies. `AbortSignal.any` is in modern Node + browsers; if your target runtime is below Node 20 / Chromium 116, manually compose with `AbortController` + `addEventListener('abort')` glue.
- No new abstractions. Do not introduce a `CancellationContext`, a `RouteContext`, or a "cancellation token." `AbortSignal` IS the abstraction; the standard library already provides it.
- No additional refactors discovered along the way. If the executor notices that the four agent classes' constructor signatures could be consolidated (a finding the page-decomposition notebook touches on), that's a separate spec.
- No retry-on-abort behaviour. When the signal fires, the work bails; it doesn't retry. The whole point is to STOP work, not redirect it.
- No change to the synthesize/recovery turn's abort behaviour beyond the basic propagation. If the recovery turn is mid-flight when the signal fires, it bails the same way the main turn does.
- No new console warnings or errors in the happy-path smoke test.

---

## Done when

- `app/api/briefing/route.ts:181-285` and `app/api/agent/route.ts:168-298` both pass `req.signal` through to every async operation inside their `start(controller)`.
- Every layer named above gains an optional `signal?: AbortSignal` parameter and threads it down. `grep -nE "signal\?: AbortSignal" lib/agents/*.ts lib/mcp/*.ts` shows the propagation chain.
- `test/api/briefing.integration.test.ts:289` is flipped from `it.skip` to `it`, with a real test body that:
  1. Creates a `NextRequest` with an `AbortController`.
  2. Calls `GET(req)` and starts draining the response.
  3. After the first event is read, calls `controller.abort()`.
  4. Asserts the stream closes within a short window (e.g. 500ms), the phase log fires with `aborted: true`, no `done` event was emitted.
- An equivalent test added to `test/api/agent.integration.test.ts` for the agent route.
- All existing Vitest tests pass (214 + 1 skipped → 216 passing as the previously-skipped test runs).
- `npm run dev` smoke test:
  1. Start a live briefing. Wait 5s. Reload the page. Observe in the Vercel/dev logs: the phase summary fires with `aborted: true` and `totalMs` reflecting only the partial work done. The schema_bootstrap phase shows the time it took; later phases either don't appear or show partial values.
  2. Start a live briefing. Don't cancel. Observe: phase summary fires with `aborted: false` (or absent — pick the convention) and all four phases appear with non-zero durations.
- No regression in MCP call timeout behaviour: the 30s per-call ceiling still fires when an MCP call hangs.

---

## Note on agent-route variation

`/api/agent` also has the cached-replay loop at `:130-134`:

```ts
async start(controller) {
  for (const e of events) {
    controller.enqueue(encoder.encode(encodeEvent(e)));
    await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
  }
  controller.close();
},
```

This loop iterates over cached events with a 180ms delay between each — a cancelled client should stop this loop too. Add `if (req.signal.aborted) break;` between iterations. The replay-delay timeout doesn't need to be cancellable (180ms is short enough), but the loop body needs to read the signal.
