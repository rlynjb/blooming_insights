# Per-call timeout ceiling — `TOOL_TIMEOUT_MS = 30_000`

**Industry standard / Language-agnostic**

The 300s route budget protects the route; the per-call timeout protects the
route budget from a single hung call. `TOOL_TIMEOUT_MS = 30_000` in
`lib/mcp/transport.ts:38` is composed via `AbortSignal.timeout()` against the
client's `req.signal`, so whichever fires first — client cancellation OR the
30-second ceiling — aborts the in-flight HTTP call.

## Zoom out — where this concept lives

Two layers of cancellation compose at the transport seam. The route hands its
client `req.signal` down through `dataSource.callTool` to `transport.callTool`;
the transport adds its own `AbortSignal.timeout(30_000)` to whatever signal it
received. The first to fire wins.

```
  Zoom out — where this concept lives

  ┌─ Service layer ─────────────────────────────────────┐
  │  app/api/agent/route.ts                              │
  │   - req.signal (client cancel)                      │
  │   - 300s route budget (maxDuration)                 │
  └─────────────────────────┬───────────────────────────┘
                            │  signal threaded down
  ┌─ Adapter layer ─────────▼───────────────────────────┐
  │  BloomreachDataSource.callTool                       │
  │   - spacing gate, retry ladder                      │
  └─────────────────────────┬───────────────────────────┘
                            │  signal threaded down
  ┌─ Transport layer ───────▼───────────────────────────┐
  │  SdkTransport.callTool                              │
  │   ★ composes req.signal WITH                        │
  │     AbortSignal.timeout(30_000) ★   ← we are here   │
  │   first to fire wins                                │
  └─────────────────────────┬───────────────────────────┘
                            │
  ┌─ MCP SDK ───────────────▼───────────────────────────┐
  │  Client.callTool                                    │
  │  uses signal for fetch abort                        │
  └─────────────────────────────────────────────────────┘
```

## The structure pass

The axis to trace is **"which signal can interrupt this call?"** — and the
answer flips at the transport seam.

```
  axis = "which signal cancels in-flight work?"

  ┌─ route layer ─────────────────────────────────────────┐
  │  ONE signal — req.signal (client cancellation only)   │
  └────────────────────────┬──────────────────────────────┘
                           │  seam: SdkTransport.callTool
                           ▼
  ┌─ transport layer ─────────────────────────────────────┐
  │  TWO signals composed:                                │
  │    1. req.signal (passed in)                          │
  │    2. AbortSignal.timeout(TOOL_TIMEOUT_MS)            │
  │  whichever fires first cancels                        │
  └───────────────────────────────────────────────────────┘
```

That seam — the addition of the timeout signal — is what turns "best-effort
cancellation" into a guarantee. Above the seam, a hung call can hang as long
as the client stays connected. Below the seam, no single call can exceed
30s, regardless of what the client does.

## How it works

### Move 1 — the mental model

You've used `AbortController` to cancel a `fetch()` when a React component
unmounts. The transport here does the same thing — except instead of one
signal (the unmount), it composes two signals (unmount AND a 30s self-imposed
deadline) into one combined signal, then hands it to `fetch`. Whichever
underlying signal fires first triggers the cancel.

```
  The pattern — compose-and-race two cancel signals

   route's req.signal           AbortSignal.timeout(30_000)
        │                                │
        │   (client cancels?)            │   (30s elapsed?)
        │                                │
        └────────────┬───────────────────┘
                     ▼
              composeSignals(...)
                     │
                     ▼
            ONE combined signal
                     │
                     ▼
         transport.client.callTool({…}, { signal })
                     │
            cancel fires → fetch aborts → AbortError thrown
                     │
                     ▼
            isTimeoutError(err)? → "HTTP 0: timeout after 30000ms"
            else                  → underlying error
```

Kernel: two signals, one combiner (`AbortSignal.any` or a manual fallback),
one branch that distinguishes the timeout case from the client-cancel case
so the error tag is honest.

### Move 2 — the walkthrough

#### The timeout constant

```ts
// lib/mcp/transport.ts:30-38
/** Per-call upper bound on a single MCP tool/listTools round-trip. A hung
 *  Bloomreach connection would otherwise burn the entire 300s route budget on
 *  one stuck call. Sibling of `retryCeilingMs: 20_000` in client.ts — that
 *  ceiling bounds a rate-limit retry wait, this one bounds the request itself.
 *  Thrown as `HTTP 0: timeout after 30000ms`, riding the existing transport
 *  failure path (McpClient.liveCall already wraps it in McpToolError). The
 *  retry ladder in McpClient.callTool only retries successful-but-rate-limited
 *  results, so the timeout error fails fast — exactly what we want, since a
 *  retry would just risk another 30s wait inside the same route budget. */
const TOOL_TIMEOUT_MS = 30_000;
```

The comment is doing real work: it names the sibling ceiling, explains *why*
the timeout fails fast instead of retrying (a retry would just risk another
30s wait), and names the error tag (`HTTP 0`) callers can recognize.

**What breaks without this ceiling.** A hung TCP connection (provider
unreachable but socket not RST'd) holds the route hostage for the full 300s
budget on one tool call. The other 295 seconds of work never run. The route
times out at the platform layer with no useful telemetry about which call
hung.

#### Composing two signals

```ts
// lib/mcp/transport.ts:129-146
async callTool(name: string, args: Record<string, unknown>, opts?: CallToolOpts): Promise<unknown> {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
  try {
    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
  } catch (err) {
    // Timeout path — distinct `HTTP 0:` tag so callers can recognize it.
    if (isTimeoutError(err)) {
      throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
    }
    const captured = this.httpErrors?.last;
    if (captured) {
      const body = captured.body.trim();
      throw new Error(`HTTP ${captured.status}${body ? `: ${body}` : ''}`, { cause: err });
    }
    throw err;
  }
}
```

Three moves on one line: `opts?.signal` (the route's `req.signal`) and
`AbortSignal.timeout(30_000)` are passed to `composeSignals`, which returns
one combined signal that aborts when either source fires.

**What breaks if you don't compose them.** If you pass only `req.signal`,
the timeout doesn't fire — hung calls hold the route. If you pass only the
timeout, client cancellation doesn't propagate — closing the tab leaves a
call running for the full 30s. You need both, OR'd together.

#### The composer with a fallback

`composeSignals` prefers `AbortSignal.any` (Node 20+ / modern browsers) and
falls back to a manual `AbortController` glue for older runtimes.

```ts
// lib/mcp/transport.ts:173-189
export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => !!s);
  if (filtered.length === 0) return new AbortController().signal;
  if (filtered.length === 1) return filtered[0];
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(filtered);
  }
  const ac = new AbortController();
  for (const s of filtered) {
    if (s.aborted) {
      ac.abort((s as unknown as { reason?: unknown }).reason);
      return ac.signal;
    }
    s.addEventListener('abort', () => ac.abort((s as unknown as { reason?: unknown }).reason), { once: true });
  }
  return ac.signal;
}
```

Three guards in order:
- Zero signals → return a never-aborting signal (a fresh `AbortController`'s
  signal, never `.abort()`'d). Caller sees no cancellation.
- One signal → return it as-is. No composition overhead.
- `AbortSignal.any` available → use it (the right answer on Node 20+).
- Fallback → manual AC that forwards abort events.

**What breaks if you skip the single-signal short-circuit.** You wrap one
signal in a manual AC for no reason — adds a listener, increases the
likelihood of subtle event-ordering bugs. Real cost is small; the
short-circuit is mostly a clarity-vs-overhead choice.

#### Recognizing the timeout when it fires

When the timeout fires, the SDK surfaces it as either a `DOMException` with
name `AbortError`/`TimeoutError` (from `AbortSignal.timeout`) or as its own
`McpError` with `code: RequestTimeout`. The transport detects both by name
so it doesn't depend on importing `McpError` just for the check:

```ts
// lib/mcp/transport.ts:44-48
function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('name' in err)) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}
```

The error gets re-thrown with the distinct `HTTP 0: timeout after 30000ms`
tag (line 137). The `HTTP 0` prefix is a deliberate convention — real HTTP
statuses start at 100. Callers grep for it to distinguish timeout from
other transport failures.

```
  Layers-and-hops — what cancellation looks like

  ┌─ route ──────────────────────┐
  │  req.signal (client cancel)  │ ───────┐
  └──────────────────────────────┘        │
                                          │ composed in transport
  ┌─ transport ──────────────────┐        │
  │  AbortSignal.timeout(30_000) │ ───────┤
  └──────────────────────────────┘        │
                                          ▼
                                   ONE signal handed to
                                   client.callTool({…}, { signal })
                                          │
                                   first to fire wins
                                          │
                            ┌─────────────┴─────────────┐
                            ▼                           ▼
                       client cancel              30s elapsed
                       AbortError                 TimeoutError
                            │                           │
                            ▼                           ▼
                       isTimeoutError? no         isTimeoutError? yes
                            │                           │
                            ▼                           ▼
                       re-throw with               throw "HTTP 0:
                       captured body               timeout after
                       if any                      30000ms"
```

#### Interaction with the retry ladder (deliberate non-interaction)

The retry ladder (see `02-rate-limit-retry-ladder.md`) only retries calls
that returned `isError: true` with rate-limit text. A timeout throws — it
doesn't return — so the retry ladder doesn't see it and doesn't retry.
This is exactly what the comment at `transport.ts:36-37` flags: "the retry
ladder in McpClient.callTool only retries successful-but-rate-limited
results, so the timeout error fails fast — exactly what we want, since a
retry would just risk another 30s wait inside the same route budget."

**The principle behind that choice.** Retrying a timeout is a different
contract from retrying a rate-limit. The provider explicitly told you to
wait (rate-limit) → retry is the right answer. The provider failed to
respond at all (timeout) → it's degraded; another 30s wait is more likely
to also time out than to succeed. Fail fast and let the route surface the
error.

### Move 3 — the principle

The principle: **every async call that can take "as long as the network
takes" needs a self-imposed ceiling that's smaller than your budget.** The
platform's deadline (Vercel's 300s) isn't your budget — it's the deadline
after which the platform kills your process with no recourse. Your budget
is the slice of that you can afford to spend on one call without starving
the rest of the route.

A useful test: **for every wait in your code, ask "what's the worst case if
this wait runs to completion, and can my caller survive that worst case?"**
If the worst case exceeds your budget, you need a ceiling that's tighter
than the underlying primitive.

In this repo:
- `transport.callTool` → 30s ceiling (this file).
- Retry ladder waits → 20s ceiling per retry (`02-rate-limit-retry-ladder.md`).
- Spacing gate → 1.1s deterministic wait (`01-spacing-gate-vs-backpressure.md`).

Each ceiling is set against the next-larger budget. They compose because
each one is small enough that the worst-case sum still fits.

## Primary diagram

```
  Per-call timeout — the composition

  caller (route handler):
    req.signal — fires on client navigation away
    300s maxDuration — fires when the platform kills the process

  passed down through:
    dataSource.callTool(name, args, { signal: req.signal })
    └─ liveCall(name, args, signal)
       └─ transport.callTool(name, args, { signal })   ← here

  transport composes:
    composeSignals(
      req.signal,                          ← from route
      AbortSignal.timeout(30_000)          ← self-imposed
    ) → ONE combined signal

  hands to: client.callTool({…}, { signal })

  on fire:
    isTimeoutError(err) ? throw "HTTP 0: timeout after 30000ms"
                        : re-throw with captured body if any

  what fails-fast:
    timeout (don't retry — provider is degraded)
    client cancel (no consumer to send to)

  what retries:
    rate-limit envelopes (provider explicitly told us to wait)
```

## Elaborate

**Why 30s, not 10s or 60s.** Chosen as a reasonable per-call ceiling against
the 300s route budget, allowing for ~10 worst-case-but-not-hung calls per
route. Some Bloomreach EQL queries against larger workspaces legitimately
take 5-15s; setting the ceiling at 10s would false-positive on those. 60s
would be permissive enough that a hung call still hurts the route. 30s
threads the needle.

**`AbortSignal.any` arrived in Node 20.** Before that you had to manual-glue
two `AbortController`s together — listen for `abort` on each source, call
`.abort()` on the combined target. The fallback in `composeSignals` carries
that older pattern for runtimes where `AbortSignal.any` isn't available;
on the current target (Node 20+, modern browsers) the `if` takes the fast
path.

**What `req.signal` doesn't cover.** The mid-retry `sleep()` calls
(`bloomreach-data-source.ts:172`) use a plain `setTimeout`-based promise
that doesn't honor any signal. If a client cancels during a 20s retry wait,
the wait still runs to completion — but the *next* `liveCall` will see the
aborted `req.signal` and fail-fast. So cancellation propagates with up to
20s of latency. Acceptable today; would matter if you ever exposed
mid-investigation cancellation as a user feature.

**Why `HTTP 0` as the timeout marker.** Real HTTP status codes start at
100. Picking `0` makes the error tag distinguishable in logs by simple grep
(`grep "HTTP 0:"`) without needing a structured field. Same convention as
some HTTP client libraries (e.g. axios) use for connection-level failures.

## Interview defense

**Q: How do you bound the time a single network call can take?**

The transport layer composes two `AbortSignal`s before each call: the
route's `req.signal` for client cancellation, and `AbortSignal.timeout(30_000)`
for a self-imposed 30s ceiling. They go through `composeSignals` which
prefers `AbortSignal.any` on Node 20+ and falls back to manual
`AbortController` glue. Whichever signal fires first aborts the in-flight
call.

The 30s number isn't arbitrary — it's chosen against the 300s route budget
so up to ten worst-case-but-not-hung calls can compose under the budget,
and it's above the legitimate slow EQL query latencies (~5-15s). The
timeout is deliberately not retried by the higher-level retry ladder
because retrying a timeout just risks another 30s wait against a provider
that's already failed to respond.

```
  Sketch — the composition

   req.signal ──┐
                ├─ composeSignals → ONE signal → client.callTool(…)
   timeout(30) ─┘
                              │
                  first to fire wins
                              │
        AbortError / TimeoutError thrown → tagged "HTTP 0: timeout"
```

Anchor: `lib/mcp/transport.ts:129-146` for the composition, `:30-38` for
the constant + rationale.

**Q: Why not retry the timeout?**

The retry ladder above this only retries calls that returned `isError: true`
with a rate-limit envelope — the provider explicitly told us to wait. A
timeout means the provider didn't respond at all; it's degraded. Retrying
would just risk another 30s wait inside the same route budget. The right
move is fail fast, surface "HTTP 0: timeout after 30000ms" on the NDJSON
stream, and let the UI decide what to do — almost always render an error
and offer a manual retry.

**Q: What's the load-bearing skeleton most people skip?**

That you need **both** signals composed, not just one. If you only pass
`req.signal`, a hung TCP socket holds the route for 300s. If you only pass
the timeout, closing the tab leaves work running for the full 30s. The
composition turns "best-effort cancel" into a hard ceiling — first to fire
wins, both are bounded.

## See also

- `01-spacing-gate-vs-backpressure.md` — the proactive 1.1s wait before each
  call (which doesn't honor any signal — happens before this ceiling kicks in).
- `02-rate-limit-retry-ladder.md` — the orthogonal ceiling on retry waits
  (`retryCeilingMs = 20_000`); sibling pattern, different problem.
- `../study-runtime-systems/` — `AbortSignal` mechanics, `AbortSignal.any`,
  `AbortSignal.timeout`, event loop interaction.
- `../study-distributed-systems/` — partial-failure semantics: when is a
  hung remote a transient blip vs a degraded provider?
