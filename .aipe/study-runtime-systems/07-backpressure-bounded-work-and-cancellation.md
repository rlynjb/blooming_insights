# Backpressure, bounded work, and cancellation

**Industry name:** `AbortController` / `AbortSignal` propagation · per-call timeout · spacing gate · `maxDuration` route ceiling · **Type:** Industry standard (composed in a project-specific way)

## Zoom out, then zoom in

The whole stack ends up running on **three bounds**, layered: a per-call 30s timeout, a ~1.1s spacing gate between calls, and a 300s per-request ceiling. Above all of those rides the propagated `AbortSignal`, which composes with each. There is no queue, no semaphore, no token bucket — just signals and timeouts forming the bounding box.

```
  Zoom out — three nested time bounds, one signal threading them

  ┌─ band 2: Node server ★ THIS FILE ★ ─────────────────────────────┐
  │                                                                   │
  │  Vercel route ceiling: maxDuration = 300s ───────────┐            │
  │  ┌─────────────────────────────────────────────────┐ │            │
  │  │  agent loop                                      │ │            │
  │  │   ┌────────────────────────────────────────┐    │ │            │
  │  │   │  one MCP tool call                     │    │ │            │
  │  │   │   ┌──────────────────────────────┐     │    │ │            │
  │  │   │   │ spacing gate: ≤1.1s wait     │     │    │ │            │
  │  │   │   └──────────────────────────────┘     │    │ │            │
  │  │   │   ┌──────────────────────────────┐     │    │ │            │
  │  │   │   │ per-call timeout: 30s        │     │    │ │            │
  │  │   │   └──────────────────────────────┘     │    │ │            │
  │  │   │   + rate-limit retry ≤3 × 20s          │    │ │            │
  │  │   └────────────────────────────────────────┘    │ │            │
  │  └─────────────────────────────────────────────────┘ │            │
  │                                                       │            │
  │  ▲ req.signal (AbortSignal) composes with             │            │
  │    each per-call timeout via composeSignals           │            │
  │                                                       │            │
  └───────────────────────────────────────────────────────┘            │
                                                                       │
  ▼  AbortSignal propagation                                           │
  client (useInvestigation): deliberately does NOT cancel on unmount ──┘
```

Zoom in. The interesting mechanic is the **`AbortSignal` propagation through `DataSource.callTool`** and how it composes with the per-call 30s timeout. That's the only cancellation primitive in the system; everything else is either a timeout (a self-firing signal) or a coarse phase boundary that does `signal.throwIfAborted()`.

## Structure pass

**Axis: who decides this work should stop?**

```
  Four altitudes, one question (who decides to stop?)

  ┌─ Vercel platform ───────────────────────────────────────────┐
  │  maxDuration=300s — the platform kills the process          │  → PLATFORM
  │  if the route runs over                                     │     decides
  └────────────────────────┬───────────────────────────────────┘
                           │
  ┌─ client (browser) ────▼────────────────────────────────────┐
  │  fetch() lives or dies with the tab                         │  → BROWSER
  │  useInvestigation deliberately won't cancel on unmount      │     decides
  └────────────────────────┬───────────────────────────────────┘     (but the hook
                           │                                          opts out)
  ┌─ server handler ──────▼────────────────────────────────────┐
  │  req.signal — propagated through every async layer          │  → REQUEST
  │  throwIfAborted at coarse boundaries                        │     signal decides
  └────────────────────────┬───────────────────────────────────┘
                           │
  ┌─ per-call ────────────▼────────────────────────────────────┐
  │  AbortSignal.timeout(30_000) inside SdkTransport            │  → PER-CALL
  │  composed via composeSignals(req.signal, timeout)           │     timeout decides
  │  first one to fire wins                                     │
  └────────────────────────────────────────────────────────────┘
```

**Seam: every `composeSignals` call.** That's where two abort signals are OR'd into one. The Bloomreach transport's `callTool` (`lib/mcp/transport.ts:131`) is the only place this composition happens for tool calls. Cancellation propagation is a *chain*: client → req.signal → composeSignals → inner fetch's abort.

## How it works

### Move 1 — the mental model

You know how `fetch(url, { signal })` can be aborted by calling `controller.abort()` on the matching `AbortController`? Same primitive, scaled up to chain through every layer of the stack. One signal flows from `req.signal` (provided by Next.js) into the agent loop, into the DataSource, into the MCP transport, into the underlying `fetch`. At each layer, it's optionally composed with a fresh timeout signal so that *either* a client cancel *or* a per-call timeout fires the abort.

```
  Pattern — signal propagation chain

  req.signal ──┐
               ├──► composeSignals  ──► fetch({signal})
   AbortSignal─┤      (OR via
   .timeout(30k)│     AbortSignal.any)
               ┘

  if EITHER fires → the OR'd signal fires → fetch aborts → throws AbortError
```

The threading is the entire trick. Forget to pass `signal` at any layer and the cancel stops there; the layers below keep running.

### Move 2 — the moving parts

#### Move 2.1 — the `DataSource.callTool` signature carries the signal

`lib/data-source/types.ts:63-71` declares the contract:

```ts
// lib/data-source/types.ts:63-71 (annotated)
export interface DataSource {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,            // ← { signal?: AbortSignal }
  ): Promise<DataSourceCallResult>;

  listTools(opts?: DataSourceListOptions): Promise<unknown>;
}
```

Both methods accept `signal`. The agent layer always passes it; the route handlers always pass it from `req.signal`. There is no "skip-signal" path.

#### Move 2.2 — Bloomreach adapter: signal threads through to the transport

`lib/data-source/bloomreach-data-source.ts:139-205` shows the full path:

```ts
// lib/data-source/bloomreach-data-source.ts:139-205 (excerpts)
async callTool<T = unknown>(
  name,
  args,
  options: CallToolOptions = {},      // ← { signal?, cacheTtlMs?, skipCache? }
): Promise<CallToolResult<T>> {
  // ... cache check ...
  let result = await this.liveCall(name, args, options.signal);  // ← signal pass-down

  // retry ladder (NOT signal-aware — see below)
  while (isRateLimited(result) && retries < this.maxRetries) {
    await sleep(waitMs);
    result = await this.liveCall(name, args, options.signal);
  }
  // ...
}

private async liveCall(name, args, signal?: AbortSignal): Promise<unknown> {
  // ... spacing gate ...
  try {
    return await this.transport.callTool(name, args, { signal });  // ← into transport
  } catch (err) {
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

**Two things to notice.** First, the signal is threaded through every layer down to the transport. Second, the retry ladder's `sleep(waitMs)` is **not** signal-aware — if the client cancels mid-retry-wait, we sleep for the full duration before the next `liveCall` sees the aborted signal and throws. So a 20s retry wait can delay cancellation by up to 20s. Minor; worth knowing.

#### Move 2.3 — `composeSignals` does the OR

`lib/mcp/transport.ts:173-189` is the actual composition:

```ts
// lib/mcp/transport.ts:173-189 (annotated)
export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => !!s);
  if (filtered.length === 0) return new AbortController().signal;
  if (filtered.length === 1) return filtered[0];
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
    return (AbortSignal as any).any(filtered);             // ← Node 20+ native AbortSignal.any
  }
  // fallback for older runtimes
  const ac = new AbortController();
  for (const s of filtered) {
    if (s.aborted) { ac.abort((s as any).reason); return ac.signal; }
    s.addEventListener('abort', () => ac.abort((s as any).reason), { once: true });
  }
  return ac.signal;
}
```

Used at `lib/mcp/transport.ts:131`:

```ts
const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
try {
  return await this.client.callTool({ name, arguments: args }, undefined, { signal });
} catch (err) {
  if (isTimeoutError(err)) {
    throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
  }
  // ...
}
```

So inside one MCP call, the active signal is `req.signal OR AbortSignal.timeout(30_000)`. Whichever fires first aborts the fetch. The catch branch tags timeouts as `HTTP 0:` so callers can distinguish them from server-returned errors.

```
  Execution trace — composed signal firing

  state:  req.signal aborted=false, timeout fires at +30s
  ─────   ───────────────────────────────────────────────
  t=0     liveCall enters, calls transport.callTool({signal})
  t=0     composeSignals returns OR'd signal
  t=0     client.callTool dispatches fetch with OR'd signal
  t=12s   ... still waiting on Bloomreach ...
  t=18s   user closes tab → browser severs connection
  t=18s   Vercel marks req.signal as aborted
  t=18s   OR'd signal fires (req.signal branch)
  t=18s   underlying fetch sees abort, throws DOMException
  t=18s   transport.callTool throws, liveCall catches, rethrows McpToolError

  Alternative trace — timeout wins:
  t=0     ...
  t=30s   AbortSignal.timeout fires (timeout branch)
  t=30s   fetch aborts, throws DOMException
  t=30s   isTimeoutError → re-throws as 'HTTP 0: timeout after 30000ms'
```

#### Move 2.4 — synthetic adapter accepts the signal but ignores it

`lib/data-source/synthetic-data-source.ts:319-331`:

```ts
async callTool(
  name: string,
  args: Record<string, unknown> = {},
  _opts?: DataSourceCallOptions,           // ← signal accepted, name prefixed with _ to silence linter
): Promise<DataSourceCallResult> {
  const started = Date.now();
  const payload = this.dispatch(name, args);
  return {
    result: payload,
    durationMs: Date.now() - started,
    fromCache: false,
  };
}
```

Why ignore the signal: the dispatch is **synchronous in-process work** — there's nothing async to interrupt. The signal exists in the signature because the abstract `DataSource` interface mandates it; the implementation doesn't need to act on it.

**This is the honest framing.** It's not a bug; it's not technical debt; it's the right shape. If a future adapter did long-running CPU work, it'd need to check `signal.aborted` periodically. The synthetic dispatch is <1ms, so the question doesn't arise.

#### Move 2.5 — the route handler is the cancellation source

`app/api/agent/route.ts` plants `req.signal.throwIfAborted()` at every coarse phase boundary plus threads `req.signal` into every async call:

```ts
// app/api/agent/route.ts (line numbers in source)
:226   req.signal.throwIfAborted();                              // before bootstrap
:235   const schema = await bootstrap(req.signal);               // bootstrap with signal
:237   req.signal.throwIfAborted();
:239   const rawTools = await dataSource.listTools({ signal: req.signal });
:248   req.signal.throwIfAborted();                              // before intent classification
:250   const intent = await classifyIntent(anthropic, q, sid, req.signal);
:274   req.signal.throwIfAborted();                              // before diagnostic
:282   diagnosis = await diagAgent.investigate(inv, { ..., signal: req.signal });
:290   req.signal.throwIfAborted();                              // before recommendation
:294   const recommendations = await recAgent.propose(..., { ..., signal: req.signal });
```

The `throwIfAborted()` calls are belt-and-braces — they make cancellation immediate at the boundary even if the next async call wouldn't have observed the signal for a few seconds (e.g. mid-spacing-gate). The `await` calls with `signal` ensure cancellation propagates *into* the call as well.

Catch + early-return on AbortError keeps the cancellation clean:

```ts
// app/api/agent/route.ts:303-310
} catch (e) {
  if (e instanceof DOMException && e.name === 'AbortError') {
    return;                                                       // no error event, no log noise
  }
  console.error('[agent] error:', redactSecrets(formatError(e)));
  send({ type: 'error', message: ... });
}
```

#### Move 2.6 — the client deliberately does NOT cancel on unmount

`lib/hooks/useInvestigation.ts:32-37` is the comment that owns this decision:

```
NOTE: we deliberately do NOT cancel the fetch on effect cleanup. React
StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first
cleanup, with the started-guard blocking the re-mount, aborted the stream
and left the logs empty. The started-guard prevents a double fetch; the
in-flight run simply completes (setState after unmount is a safe no-op).
```

What this means in practice:

  → Real user closes tab → browser kills connection → `req.signal` aborts server-side → cancellation chain fires.
  → React StrictMode mount-unmount-remount → hook cleanup runs → nothing happens → stream continues → re-mount sees `startedRef.current=true` and skips → in-flight stream eventually completes and any `setState` after unmount is a React no-op.

The tradeoff is honest: **a user who nav-aways within the SPA (without closing the tab) keeps a server function running for up to 300s of budget burn.** The hook author chose StrictMode-safety over aggressive cancellation; for an analytics app where investigations are explicitly opened by clicking, that's defensible.

The other hooks **do** plumb cancellation correctly — `useBriefingStream` has a `cancelledRef.current` latch (`lib/hooks/useBriefingStream.ts:130-132, 150-152`) polled by `readNdjson`'s `cancelOn` option. So the briefing stream stops reading on unmount; only the investigation stream doesn't.

#### Move 2.7 — what's the *bounded work* story

There's no work-queue, no semaphore. The bounding is purely time-based:

| bound | source | scope | what it bounds |
|---|---|---|---|
| 300s | `maxDuration = 300` | per route invocation | total wall time of one request |
| 30s | `TOOL_TIMEOUT_MS` (`transport.ts:38`) | per MCP call | one tool round-trip |
| 1.1s | `minIntervalMs: 1100` (`connect.ts:97`) | between MCP calls | rate limit compliance |
| 20s × 3 | `retryCeilingMs / maxRetries` (`bloomreach-data-source.ts:135-136`) | per retry wait | rate-limit retry ceiling |

Notice what's missing: **no upper bound on the number of tool calls per request.** The agent loop can call as many tools as it wants until the 300s ceiling fires. The spacing gate is the de-facto throttle (~270 calls max in 300s at 1.1s spacing, minus the actual call time). This is "not yet exercised" as a hard cap; the spacing+timeouts combine to bound it implicitly.

### Move 2 variant — the load-bearing skeleton

The cancellation kernel is **3 parts**. Strip any one and cancellation breaks somewhere.

**Kernel:**
  1. Accept a `signal` parameter at every async boundary.
  2. Compose it with timeouts via `composeSignals` at the inner-most call.
  3. Re-throw AbortErrors and let the route handler's catch differentiate them.

**What breaks if you remove each:**

  → **Remove #1 (drop signal from a layer's signature).** Cancel events fire at the source but don't reach the inner fetch. The user sees a "stuck" stream until the per-call timeout fires (30s) or the route ceiling fires (300s).
  → **Remove #2 (skip composition with timeout).** The per-call ceiling is gone. One hung Bloomreach connection burns the full 300s budget on a single call. The comment at `transport.ts:32-38` explicitly names this as the design reason.
  → **Remove #3 (no AbortError handling in catch).** The cancellation chain works, but every cancel produces a noisy error event on the wire and a noisy log line. The user-facing path looks like a failure rather than a clean cancellation.

**Optional hardening** (not in the kernel): the `throwIfAborted()` at coarse boundaries — speeds up cancellation latency by interrupting at the next phase boundary instead of waiting for the next async call to observe the signal. Nice-to-have, not load-bearing.

### Move 3 — the principle

Cancellation in JavaScript is a **chain of opt-ins**, not a runtime feature. There's no equivalent of OS-level `kill` or POSIX signals; you have to pass `AbortSignal` to every layer and compose it with every fresh timeout at every layer. The discipline is the design. The codebase makes this discipline visible by accepting `signal` in the abstract `DataSource` interface, so an adapter that fails to thread it would fail typing review. The places it deliberately doesn't propagate (synthetic dispatch, retry sleeps, the investigation hook) are commented and owned.

## Primary diagram

```
  Backpressure / bounded work / cancellation — the full picture

  ┌─ client (useInvestigation, useBriefingStream) ──────────────────┐
  │                                                                  │
  │  useBriefingStream:  cancelledRef.current → readNdjson cancelOn  │
  │  useInvestigation:   DOES NOT CANCEL (StrictMode opt-out)        │
  │                                                                  │
  └────────────────────────────────┬────────────────────────────────┘
                                   │  HTTP (close on tab close only)
  ┌─ Vercel platform ──────────────▼────────────────────────────────┐
  │  maxDuration = 300s — kills the process if route runs over       │
  │  req.signal fires when client disconnects                        │
  └────────────────────────────────┬────────────────────────────────┘
                                   │
  ┌─ route handler ────────────────▼────────────────────────────────┐
  │  req.signal.throwIfAborted() — at every coarse phase boundary    │
  │  req.signal — passed to bootstrap, listTools, every agent run    │
  │  catch (AbortError) → return early, no error event               │
  └────────────────────────────────┬────────────────────────────────┘
                                   │
  ┌─ agent layer ──────────────────▼────────────────────────────────┐
  │  signal passed through to every ds.callTool({signal})            │
  └────────────────────────────────┬────────────────────────────────┘
                                   │
  ┌─ BloomreachDataSource ─────────▼────────────────────────────────┐
  │  spacing gate: ≤1.1s setTimeout (NOT signal-aware)               │
  │  liveCall: passes signal to transport.callTool                   │
  │  retry sleep: ≤20s (NOT signal-aware)                            │
  └────────────────────────────────┬────────────────────────────────┘
                                   │
  ┌─ SdkTransport ─────────────────▼────────────────────────────────┐
  │  composeSignals(opts.signal, AbortSignal.timeout(30_000))        │
  │  whichever fires first wins                                      │
  └────────────────────────────────┬────────────────────────────────┘
                                   │
  ┌─ MCP SDK / fetch ──────────────▼────────────────────────────────┐
  │  fetch(url, {signal}) — aborts on signal, throws DOMException    │
  └──────────────────────────────────────────────────────────────────┘

  SyntheticDataSource: accepts signal, ignores it (sync dispatch).
```

## Elaborate

`AbortController` / `AbortSignal` landed in browsers around 2017 and Node followed shortly after; `AbortSignal.timeout` (the self-firing variant) came in Node 17.3. `AbortSignal.any` (the static composer) is Node 20.3+ — which is exactly why `composeSignals` falls back to a manual `AbortController` glue for older runtimes (`lib/mcp/transport.ts:180-189`). Vercel's Node 20 image has both natives.

The "thread signal through every layer" discipline is the same shape as Go's `context.Context` as a first argument — except Go enforces it culturally (every standard library function takes `ctx` first), where JavaScript leaves it as an optional last argument. Adopting Go's discipline in TypeScript means making `opts.signal` part of every abstract interface, which is exactly what `DataSource` does.

Worth reading: the WHATWG DOM spec for `AbortSignal.any` semantics (especially around `reason` propagation); the MCP SDK source for how `client.callTool({signal})` actually plumbs the signal into the underlying transport.

## Interview defense

**Q: Walk me through cancellation propagation in this codebase end-to-end.**

Five layers, every one accepts `signal`:

```
  client (real tab close — not React unmount)
      ↓
  browser severs TCP
      ↓
  Vercel: req.signal aborts
      ↓
  route handler: req.signal.throwIfAborted() OR await with signal
      ↓
  DataSource.callTool({signal})
      ↓
  SdkTransport.callTool: composeSignals(signal, AbortSignal.timeout(30_000))
      ↓
  fetch({signal}): aborts → throws DOMException AbortError
      ↓
  catch (AbortError) at the route → early return → finally closes the stream
```

Two places it deliberately doesn't propagate:
  1. The investigation hook (`useInvestigation:32-37`) — won't cancel on React unmount because StrictMode would empty the trace.
  2. `BloomreachDataSource.sleep` inside the retry ladder (`bloomreach-data-source.ts:172`) — not signal-aware, so a cancel during a 20s retry wait is delayed up to 20s.

The synthetic adapter accepts the signal and ignores it (`synthetic-data-source.ts:319-331`) because the dispatch is synchronous — there's nothing to interrupt.

Anchor: "signal threaded through every layer, OR'd with a timeout at the fetch boundary, AbortError handled at the route."

**Q: What's the load-bearing kernel of cancellation, and what would break without it?**

Three parts:

```
   #1 ──► every async boundary accepts a signal parameter
   #2 ──► composeSignals OR's it with per-call timeout
          at the innermost layer
   #3 ──► catch AbortError, distinguish from real errors
```

Drop #1: cancel events fire at the top but stop at the first layer that doesn't pass `signal` down. The cancel becomes "stuck stream until the 30s per-call timeout fires."

Drop #2: a hung Bloomreach connection burns the full 300s route budget on one call. The 30s ceiling is the only thing protecting us from that scenario.

Drop #3: every cancel looks like a failure. Logs are noisy, the UI's error path fires on benign disconnects.

The optional-hardening part — `throwIfAborted()` at coarse phase boundaries — just speeds up the latency. Not load-bearing; reduces cancellation lag from "next await" to "next phase boundary."

```
  the test:  remove one part, name the consequence
   #1 missing → cancel doesn't reach fetch
   #2 missing → no per-call ceiling
   #3 missing → noisy logs on disconnect
```

## See also

  → `02-processes-threads-and-tasks.md` for the single-thread context that makes cancellation latency = "next yield point."
  → `03-event-loop-and-async-io.md` for the event-loop mechanics behind `AbortSignal.timeout`.
  → `06-filesystem-streams-and-resource-lifecycle.md` for the `finally { controller.close() }` that pairs with cancellation.
  → `08-runtime-systems-red-flags-audit.md` for the ranked risks this seam creates.
