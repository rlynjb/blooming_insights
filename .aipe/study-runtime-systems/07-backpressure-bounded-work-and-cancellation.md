# Backpressure, Bounded Work, and Cancellation

**Industry name:** cancellation token, abort signal, deadline, rate limiter · **Type:** Industry standard

## Zoom out — where this concept lives

This is the most important runtime concern in the codebase. Every other concept (event loop, state isolation, stream lifecycle) is correctness; bounded work is what keeps a single 300-second route budget from being burned by one stuck call or one runaway agent loop. The repo has FIVE layers of bounds, composed.

```
  Zoom out — five bounds, stacked top to bottom

  ┌─ Browser tab ────────────────────────────────────────────────────────┐
  │  bound #5: useEffect cleanup → cancelOn flag → reader.cancel()       │
  │  (useBriefingStream.ts:298; deliberate non-cancel in useInvestigation)│
  └────────────────┬─────────────────────────────────────────────────────┘
                   │  fetch(req); browser owns the req.signal
  ┌─ Vercel ────────▼────────────────────────────────────────────────────┐
  │  bound #4: maxDuration = 300s (the platform-enforced wall clock)     │
  └────────────────┬─────────────────────────────────────────────────────┘
                   │  req.signal propagated INTO the route handler
  ┌─ Node process ──▼────────────────────────────────────────────────────┐
  │  bound #3: agent-loop maxTurns + maxToolCalls budgets                │
  │            (base-legacy.ts:99, 114-206)                              │
  │  bound #2: per-call AbortSignal.timeout(30_000) composed with         │
  │            req.signal via AbortSignal.any (transport.ts:131, 173)    │
  │  bound #1: ~1 req/s proactive spacing + parsed rate-limit retry     │
  │            (bloomreach-data-source.ts:130-174, 191-205)              │
  │  ★ THIS CONCEPT LIVES IN ALL FIVE LAYERS ★                          │
  └──────────────────────────────────────────────────────────────────────┘
```

The five bounds defend different things. Bound #1 keeps Bloomreach from rate-limiting us. Bound #2 keeps one stuck MCP call from burning the route budget. Bound #3 keeps the agent loop from looping forever or blowing the token budget. Bound #4 is the platform's ceiling. Bound #5 is the user's cancel. Each bound is tighter than the one above; the smallest active bound always wins.

## Structure pass

### Axis: what kind of overrun does each bound prevent?

```
  bound #1 (rate spacing)        → server-side throttling penalties
  bound #2 (per-call timeout)    → one slow MCP call burning the route
  bound #3 (loop budgets)        → infinite agent loops; runaway token cost
  bound #4 (route maxDuration)   → platform-level kill (504 to the client)
  bound #5 (browser cleanup)     → server work continuing after tab closed
```

Each bound targets a different failure mode. Removing any single one would allow that failure mode to surface.

### Seams

The interesting seam is **the cancel propagation chain**. `req.signal` lives at the route handler; the deepest awaiter is `client.callTool` inside the MCP SDK. Between them are bootstrap, listTools, agent loops, dataSource adapters — and the signal threads through every layer as an explicit `{ signal }` option.

```
  The cancel propagation seam — what happens at each hop

  req.signal (browser cancel)
    │
    ▼
  route handler — req.signal.throwIfAborted() at coarse boundaries
    │  passes signal: req.signal
    ▼
  bootstrap() / agent.scan() / agent.investigate()
    │  passes signal through hooks.signal or { signal }
    ▼
  runAgentLoop — signal?.throwIfAborted() between turns; passes to each callTool
    │  passes signal to anthropic.messages.create AND dataSource.callTool
    ▼
  dataSource.callTool — passes signal: options.signal
    │
    ▼
  transport.callTool — composes signal with AbortSignal.timeout(30_000)
    │  via AbortSignal.any (composeSignals)
    ▼
  client.callTool — passes composed signal to the SDK
    │
    ▼
  the fetch deep inside the SDK — aborts when EITHER signal fires
```

That chain is the load-bearing part of the whole bounding story. Cut it at any layer and cancel doesn't reach the deepest await — which means a closed browser tab still burns 30 seconds of MCP timeout, or worse, the full 300-second route budget if the timeout layer is also cut.

## How it works

### Move 1 — the mental model

You know how `Promise.race([fetchA, fetchB])` settles when the first one finishes? `AbortSignal.any([signalA, signalB])` is the same idea applied to cancels — the resulting signal fires as soon as ANY input signal fires. The repo uses this to OR a client-driven cancel with a server-driven timeout: whichever happens first wins, and the in-flight call gets a cancel. That's the kernel of bound #2.

```
  AbortSignal.any — the "first to fire wins" cancel composition

  ┌─ req.signal ───────────────────┐
  │  (fires when client cancels)   │
  └──────────┬─────────────────────┘
             │
             ├──► AbortSignal.any  ────► composed signal
             │                          (passes to client.callTool)
             ┌─────────────────────┐
             │ AbortSignal.timeout │
             │ (fires at T+30s)    │
             └─────────────────────┘
```

If the user closes the tab at T=5s, the composed signal fires at T=5s and the MCP call aborts. If the user holds the tab open and the MCP call hangs, the composed signal fires at T=30s (the timeout) and the MCP call aborts. Either way, the deepest await rejects with `AbortError` and the route's catch block sees it.

### Move 2 — the moving parts

#### Bound #1 — proactive ~1 req/s spacing + parsed rate-limit retry

Bloomreach's loomi connect server rate-limits per user GLOBALLY. The repo defends against this two ways: a proactive sleep before each call, and a reactive retry on rate-limit errors.

```ts
// lib/data-source/bloomreach-data-source.ts:190-205 (proactive spacing)
private async liveCall(name: string, args: ..., signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

`minIntervalMs` is `1100` (1.1s) for production (`lib/mcp/connect.ts:97`). Between two calls, the second one sleeps however much time is needed to space them at least 1.1s apart. The 1.1s is a compromise: Bloomreach states the rate window in error text as either "(1 per 1 second)" or "(1 per 10 second)", and waiting 10s between every call would cost ~60s on a 6-call investigation — blowing the original 60s route budget. The connect comment at `lib/mcp/connect.ts:86-93` walks the math.

The reactive retry kicks in when a call comes back rate-limited despite the spacing:

```ts
// lib/data-source/bloomreach-data-source.ts:163-174 (rate-limit retry ladder)
let retries = 0;
while (isRateLimited(result) && retries < this.maxRetries) {
  retries++;
  const hintMs = parseRetryAfterMs(result);
  const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
  const waitMs = Math.min(
    hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
    this.retryCeilingMs,
  );
  await sleep(waitMs);
  result = await this.liveCall(name, args, options.signal);
}
```

The parser at `parseRetryAfterMs` (`bloomreach-data-source.ts:64-71`) handles two error shapes — `"Retry after ~12 second(s)"` and `"rate limit reached (1 per 10 second)"` — and falls back to exponential backoff (`retryDelayMs * 2^retries`). Every wait is capped by `retryCeilingMs = 20_000`. With `maxRetries = 3` and ~10s per wait, a single call can spend up to ~30s on retries, which is exactly why bound #2 exists as the outer ceiling.

The latent micro-race on `lastCallAt` is discussed in `04-shared-state-races-and-synchronization.md`; it doesn't fire today because tools run sequentially per turn.

#### Bound #2 — per-call `AbortSignal.timeout(30_000)` composed with `req.signal`

```ts
// lib/mcp/transport.ts:38, 129-145
const TOOL_TIMEOUT_MS = 30_000;
// ...
async callTool(name: string, args: ..., opts?: CallToolOpts): Promise<unknown> {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
  try {
    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
    }
    // ... attach captured body if available ...
    throw err;
  }
}
```

`AbortSignal.timeout(30_000)` is a standard primitive: returns an `AbortSignal` that fires automatically at T+30s. `composeSignals` (`transport.ts:173-189`) ORs it with `opts?.signal` (the client cancel signal threaded down from the route):

```ts
export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => !!s);
  if (filtered.length === 0) return new AbortController().signal;
  if (filtered.length === 1) return filtered[0];
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(filtered);
  }
  // fallback for older runtimes (no-op in current env)
  const ac = new AbortController();
  for (const s of filtered) {
    if (s.aborted) {
      ac.abort((s as unknown as { reason?: unknown }).reason);
      return ac.signal;
    }
    s.addEventListener('abort', () => ac.abort(...), { once: true });
  }
  return ac.signal;
}
```

`AbortSignal.any` is the modern primitive (Node 20+). The fallback exists for older runtimes — the comment notes it's a no-op in this env. The pattern is "use the standard primitive when present, hand-roll the equivalent otherwise."

Important: the rate-limit retry ladder in `bloomreach-data-source.ts:163-174` ONLY retries on successful-but-rate-limited results (where the call returned an envelope with `isError: true`). A timeout throws and skips the retry — exactly what we want. Retrying a 30s timeout would risk another 30s wait inside the same route budget.

#### Bound #3 — agent-loop `maxTurns` + `maxToolCalls` budgets

```ts
// lib/agents/base-legacy.ts:99, 114-206
export async function runAgentLoop<T = null>(opts: ...): Promise<AgentRunResult<T>> {
  const {
    // ...
    maxTurns = 8,
    maxTokens = 4096,
    maxToolCalls,
    synthesisInstruction,
    // ...
  } = opts;

  for (let turn = 0; turn < maxTurns; turn++) {
    signal?.throwIfAborted();
    const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
    const forceFinal = turn === maxTurns - 1 || budgetSpent;
    // ... on forceFinal, drop the tools array so the model MUST produce a final answer ...
    const res = await anthropic.messages.create(params, signal ? { signal } : undefined);
    // ...
  }
}
```

Two bounds, working together:

- `maxTurns = 8` is the hard ceiling on iterations. On turn 8, the loop drops the `tools` array from the request, forcing the model to produce a text answer instead of another tool call. Without this, a confused model could chain tool calls forever (or until Vercel kills the route).
- `maxToolCalls` (passed per-agent) is a separate hard cap on TOTAL tool calls across all turns. The diagnostic agent uses this to bound EQL costs. When hit, the loop forces a final synthesis turn the same way.

The `synthesisInstruction` (`base-legacy.ts:230-232`) is appended to the system prompt on the forced-final turn:

```
"You have NO more tool calls available. {middle} Do not say you need more queries."
```

This is the "force the model to STOP exploring and emit its structured answer" lever. Without it, models tend to keep asking for more data and never produce the JSON the caller is waiting for.

The `signal?.throwIfAborted()` at the top of each iteration is the per-turn cancel check. A cancel mid-loop bails immediately on the next iteration — the current `await anthropic.messages.create(...)` is also signal-aware (passes `{ signal }`), so a cancel during a model call aborts the call directly.

#### Bound #4 — platform `maxDuration = 300`

```ts
// app/api/agent/route.ts:22, app/api/briefing/route.ts:19
export const maxDuration = 300;
```

Vercel Pro's per-function ceiling. The platform kills the function at T=300s regardless of what's happening. Every inner bound is sized to stay comfortably under this. The original comment on briefing:

```
// 300s = Vercel Pro's max. The monitoring agent + ~1 req/s MCP spacing can run
// well past Hobby's 60s ceiling, so the live briefing needs the higher budget.
```

The phase summary log fires in `finally` so we can see how much of the 300s was burned even if the function was killed by the platform (the platform-kill case shows up as `aborted: true` and the partial `phases` list).

#### Bound #5 — browser cleanup, with one deliberate exception

```ts
// lib/hooks/useBriefingStream.ts:130, 152, 297-299 (cancel on cleanup)
const cancelledRef = useRef(false);
// ...
useEffect(() => {
  // ...
  cancelledRef.current = false;
  // ...
  (async () => {
    // ... await readNdjson(res.body, handle, { cancelOn: () => cancelledRef.current }); ...
  })();

  return () => {
    cancelledRef.current = true;
  };
}, [mode, ready]);
```

The cleanup flips `cancelledRef`. The ndjson reader polls it between reads (`lib/streaming/ndjson.ts:33-36`) and calls `await reader.cancel()` on the next true reading, which propagates the cancel back up the fetch chain — and eventually to the server's `req.signal`.

The contrast is `useInvestigation`:

```ts
// lib/hooks/useInvestigation.ts:36-37, 44-49
// NOTE: we deliberately do NOT cancel the fetch on effect cleanup. React
// StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first
// cleanup, with the started-guard blocking the re-mount, aborted the stream
// and left the logs empty. The started-guard prevents a double fetch; the
// in-flight run simply completes (setState after unmount is a safe no-op).

const startedRef = useRef(false);
useEffect(() => {
  if (!id) return;
  if (startedRef.current) return;
  startedRef.current = true;
  // ... no cancel callback on cleanup ...
});
```

This is a deliberate choice to survive React StrictMode's mount→cleanup→remount. The cost: a closed-tab investigation keeps running on the server until `maxDuration` (300s) kills it. For an alpha with low traffic, that's an acceptable trade for not breaking development. It's finding #4 in the audit.

### Move 2 variant — the load-bearing skeleton

The bounded-work kernel has FOUR required parts. Drop any one and you have a runaway.

```
  The bounded-work skeleton — what each part defends

  1. CANCEL SOURCES (signal inputs)
     - req.signal (client closes/aborts)
     - AbortSignal.timeout(N) (per-call deadline)
     - per-agent budgets (maxTurns / maxToolCalls)
     - platform maxDuration

  2. CANCEL COMPOSITION
     - AbortSignal.any to OR multiple sources into one
     - first signal to fire wins; the cause propagates as the reject reason

  3. CANCEL PROPAGATION
     - signal threaded explicitly through every async layer
     - throwIfAborted() at coarse boundaries between awaits
     - the SDK at the deepest layer must accept { signal } too

  4. CANCEL HANDLING
     - catch AbortError separately from real errors
     - skip error events on cancel (no consumer)
     - run finally for teardown regardless
```

What breaks when each is missing:
- Drop #1 and there's no upper bound on work.
- Drop #2 and you can only react to one source — usually the timeout, leaving client cancel unhandled.
- Drop #3 and the cancel exists but never reaches the deepest await; the call runs to completion.
- Drop #4 and a cancel surfaces as an error event in production logs, generating false alerts.

The repo gets all four right. The signal threads from `req.signal` at the route through `dataSource.callTool` to the MCP SDK's fetch — 5 layers, all signal-aware.

### Move 3 — the principle

Bounded work in async systems is the discipline of "no work without an owner who can cancel it." Every long-running operation must accept a cancel token; every async layer must pass it through; every catch must distinguish cancel from failure. The repo's five-bound stack is the worked example: client cancel + per-call timeout + per-loop budget + per-route ceiling + browser cleanup. The smallest active bound wins, and the system fails predictably (with a clear error path) rather than catastrophically (with a hung process or a runaway bill).

## Primary diagram

```
  The full cancel chain — five bounds, one signal threaded through them

  ┌─ Browser tab ────────────────────────────────────────────────────────┐
  │  bound #5: useEffect cleanup → cancelledRef = true                   │
  │            → ndjson reader sees cancel → await reader.cancel()       │
  │            (skipped intentionally in useInvestigation)               │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │  cancel propagates upstream via fetch
  ┌─ Vercel ────────────────────▼────────────────────────────────────────┐
  │  bound #4: maxDuration = 300s — platform-enforced wall clock         │
  │  req.signal: AbortSignal handed to the route handler                 │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │  signal threaded INTO handler
  ┌─ Node route handler ────────▼────────────────────────────────────────┐
  │  req.signal.throwIfAborted() at coarse boundaries                    │
  │  signal passed to: bootstrap(req.signal), dataSource.listTools,      │
  │                    classifyIntent, all four agent classes            │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │  signal passed down via hooks.signal
  ┌─ runAgentLoop ──────────────▼────────────────────────────────────────┐
  │  bound #3: maxTurns (8) + maxToolCalls budget                        │
  │  signal?.throwIfAborted() between turns                              │
  │  signal passed to anthropic.messages.create AND dataSource.callTool  │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │  signal passed via { signal } opt
  ┌─ BloomreachDataSource ──────▼────────────────────────────────────────┐
  │  bound #1: ~1 req/s proactive spacing                                │
  │            + rate-limit retry ladder (max 3 retries × 10s each)      │
  │  signal passed through to transport.callTool                         │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │  signal composed with timeout
  ┌─ SdkTransport ──────────────▼────────────────────────────────────────┐
  │  bound #2: composeSignals(opts.signal, AbortSignal.timeout(30_000))  │
  │  via AbortSignal.any — first to fire wins                            │
  │  composed signal handed to client.callTool                           │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │  signal reaches the deepest await
  ┌─ MCP SDK + fetch ───────────▼────────────────────────────────────────┐
  │  the actual network I/O; aborts on signal fire                       │
  │  throws AbortError, which propagates back up the await chain         │
  │  → route handler's catch → AbortError detected → return              │
  │  → finally runs: disposeDataSource + controller.close                │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

`AbortSignal` and `AbortController` are the standardized cancel primitive across Web APIs and Node. They replaced the older pattern of "pass a `cancelled` boolean by reference" and the unstandardized `CancellationToken` shapes. The composition primitive `AbortSignal.any` landed in Node 20 and modern browsers; it's the right tool for OR'ing client cancel with timeouts. Before it, you'd hand-roll the equivalent (which is what `composeSignals` falls back to for older runtimes).

The phase-summary log line at the end of each route's `finally` is the production observability for this whole bounding story:

```ts
console.log(JSON.stringify({
  route: '/api/agent',
  sessionId: sid,
  mode,
  totalMs: Math.round(performance.now() - t0),
  phases,                  // [{phase: 'schema_bootstrap', durationMs: 4500}, ...]
  aborted: req.signal.aborted,
}));
```

When something blows the budget, you read this log and see which phase ate the time. When something hits the per-call timeout, the phases array stops at that phase and `totalMs` is just over 30s into it. When a client cancels, `aborted: true` and the phases tell you how far the work got. That single log line is the runtime's confession.

The "not yet exercised" parts:

- **Backpressure beyond stream emission.** The repo's stream emission rate is bounded by agent turn frequency, which is itself bounded by MCP round trips (seconds). There's no high-throughput path that would need explicit backpressure (`controller.desiredSize`, `pull(controller)`).
- **Graceful shutdown.** Serverless functions are killed by the platform; there's no SIGTERM handler, no in-flight request drain, no "stop accepting new connections."
- **Circuit breakers.** No global "if Bloomreach has been failing for N minutes, stop trying for M minutes." A future addition for production stability.

## Interview defense

> Q: "How does a closed browser tab actually cancel an in-flight investigation?"

`req.signal` fires when the platform sees the client connection drop. The route handler's `throwIfAborted()` at the top of each phase bails immediately. Every async layer below the handler — bootstrap, listTools, classifyIntent, agent loops, dataSource.callTool, transport.callTool — accepts `{ signal }` and passes it through. At the deepest layer, `SdkTransport.callTool` composes `req.signal` with `AbortSignal.timeout(30_000)` via `AbortSignal.any`; the composed signal is handed to the MCP SDK's fetch. When the client cancels, `req.signal` fires, the composed signal fires, the fetch aborts, the await chain rejects with AbortError, the route's catch recognizes it, the finally runs teardown. End to end.

> Q: "What's the load-bearing part most people forget?"

Cancel propagation. People wire `req.signal` at the route and a `{ signal }` option at the deepest call — and forget the five layers in between. Without explicit threading, the cancel exists but never reaches the await that's actually parked. The deepest await is the one most likely to be hanging (a stuck MCP call); that's the one a cancel most needs to reach. The repo threads `signal` through every layer explicitly; if you grep for `signal?` you can trace the whole chain.

> Q: "Why both a per-call timeout AND a per-route budget?"

Different failure modes. A stuck call (one MCP request hanging because Bloomreach has a bad day) needs the per-call timeout — without it, one bad call burns the whole 300s. A confused agent loop (model keeps asking for more tools, never converges) needs the per-loop budget — without it, the loop would chain calls forever inside the route budget. The two bounds catch different bugs; they're complementary, not redundant.

> Q: "What's the most fragile bound in this stack?"

Browser cleanup is the most fragile because it's the easiest to get wrong. `useInvestigation` deliberately doesn't cancel on cleanup (to survive React StrictMode), which means a closed tab keeps the server running until the per-route budget kicks in. That's a documented trade for the alpha; at scale it would be the first thing to fix.

## See also

- `03-event-loop-and-async-io.md` — how `AbortSignal.timeout` uses `setTimeout` under the hood; how an aborted fetch rejects via microtask.
- `04-shared-state-races-and-synchronization.md` — the latent micro-race on `lastCallAt` (would only fire if parallel callTool became a thing).
- `06-filesystem-streams-and-resource-lifecycle.md` — how the `finally` block guarantees teardown when a cancel arrives mid-stream.
- `08-runtime-systems-red-flags-audit.md` — the useInvestigation non-cancel ranked as finding #4.
