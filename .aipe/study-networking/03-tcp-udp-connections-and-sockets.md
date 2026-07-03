# 03 — TCP/UDP, connections, and sockets

## Subtitle

Transport-layer connections and lifecycle (Language-agnostic — the sockets behind the HTTP calls, and how long each one lives).

## Zoom out, then zoom in

Every one of the three HTTPS hops in the network map is a TCP connection under the hood (no UDP anywhere in this codebase's application layer). What's interesting isn't that TCP carries the requests — that's true of any HTTPS app — it's the **lifecycle** of the connections. The inbound one is long-lived (kept open for the whole NDJSON stream, up to 300 seconds). The two outbound ones are short-lived per call and pooled by Node's fetch. Different lifecycle stories on either side of the same route function.

```
  Zoom out — connection lifecycles across the layers

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  browser fetch() — TCP conn held open for the response     │
  │  body (streaming), reused by the browser's HTTP/2 pool     │
  │  for subsequent same-origin calls                          │
  └────────────────────────┬───────────────────────────────────┘
                           │  hop 1: LONG-LIVED
                           │  connection open ~5–120s
                           ▼
  ┌─ Service band (route) ─────────────────────────────────────┐
  │  ★ THIS FILE ★                                             │  ← we are here
  │  the multiplexer — holds one inbound socket open while     │
  │  opening/closing many outbound ones                        │
  └──────────┬──────────────────────────────┬──────────────────┘
             │ hop 2: SHORT-LIVED, POOLED   │ hop 3: SHORT-LIVED, POOLED
             │ per tool call, ~200ms-30s    │ per model turn, ~2-10s
             ▼                              ▼
  ┌─ MCP server ──────────────────┐  ┌─ Anthropic API ────────┐
  │  each callTool = one HTTPS    │  │  each messages.create  │
  │  request; ideally reuses TCP  │  │  = one HTTPS request;  │
  │  conn from the last call      │  │  same reuse story      │
  └───────────────────────────────┘  └────────────────────────┘
```

Zoom in — this file walks the lifecycle. When does each socket open? When does it close? What's holding it open in between? Where does that lifecycle constrain what the app can do?

## Structure pass

**Layers:**
- Browser TCP pool (HTTP/2 to same-origin)
- Vercel edge socket to the function invocation
- Node function's outbound `undici` connection pool
- Two upstream TCP endpoints (MCP origin, Anthropic API)

**Axis — LIFECYCLE (when does this connection exist?):**

```
  "how long does this socket live?" — traced down the stack

  browser ─► route          → OPEN for whole response body
                              (up to 300s NDJSON stream)
       seam #1: request/response is one TCP conversation
  route ─► MCP              → OPEN per tool call
                              (~30ms-30s), pooled per host
       seam #2: pool decides "reuse or open new"
  route ─► Anthropic        → OPEN per model turn
                              (~2-10s), pooled per host
       seam #3: TLS handshake amortized by keep-alive

  the answer flips at each seam:
    one long-lived, N short-lived
```

**Seams:**
- Seam #1 — the inbound socket stays open for the whole stream body. Closing early = "stream aborted" on the browser side.
- Seam #2/3 — the outbound sockets get pooled by `undici`. Reused across calls within an instance's lifetime; each new TLS handshake costs ~50-100ms.

## How it works

### Move 1 — the mental model

Think of the route function as a **valve** with one large-diameter pipe on the input side (the browser's long-lived stream) and two smaller pipes it opens on demand for each internal request (the pooled outbound fetches). The valve stays open until the response body closes; the two smaller pipes open and close many times during that window.

```
  The valve — one inbound pipe, N outbound bursts

              inbound (browser fetch)
                       │
              ═════════════════════════
              ║   route function      ║
              ║  ┌─────────────────┐  ║   outbound MCP call
              ║  │   ReadableStream ─╫──►  ─ open ─ close
              ║  │   controller     │  ║   outbound Anthropic call
              ║  │   .enqueue(byte) ─╫──►  ─ open ─ close
              ║  └─────────────────┘  ║   MCP call again (pool reuses)
              ═════════════════════════   ─ open ─ close
                       │
              (open until stream close)

  inbound: one TCP connection, held open the whole time
  outbound: many short TCP conversations, pooled per host
```

### Move 2 — the walkthrough

#### Hop 1 (down) — the browser's request TCP

The browser opens one TCP connection to the deploy origin (or reuses an HTTP/2 stream on an existing one) when the user's `fetch('/api/briefing')` fires. Nothing special — standard `fetch` over HTTPS. The interesting part is what happens next.

#### Hop 1 (up) — the response body stays open

The route returns a `Response` whose body is a `ReadableStream<Uint8Array>`. From `app/api/agent/route.ts:189-192`:

```ts
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    // ...
  },
});
```

That stream stays open — the socket stays open — until `controller.close()` fires. Which is why the socket lives up to 300 seconds:

```ts
// app/api/agent/route.ts:23
// 300s = Vercel Pro's max. A live investigation (diagnostic → recommendation)
// runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it.
export const maxDuration = 300;
```

The consequence: **one open socket, potentially for five minutes.** During that window, the browser's `readNdjson` is reading one chunk at a time. If the browser closes early (user navigates away), the socket closes and `req.signal.aborted` becomes true — which the route observes:

```ts
// app/api/agent/route.ts:134-136 (inside the cached-replay loop)
// Client cancelled mid-replay — break out so we don't keep enqueuing
// bytes into an already-closed reader.
if (req.signal.aborted) break;
```

For the live path, the abort signal is composed with the transport's per-call timeout so any in-flight MCP call cancels immediately (see file 07). That's the load-bearing lifecycle detail: **the inbound socket's close event propagates all the way down to the outbound socket's abort.**

#### Hop 2 and hop 3 — pooled outbound sockets

Node's global `fetch` (backed by `undici` on Node 20+) pools TCP connections per origin automatically. When `dataSource.callTool` or `anthropic.messages.create` runs, `undici` checks its pool for an idle connection to the target host. If one's available, it reuses it (skipping TCP handshake + TLS handshake, saving ~50-100ms). If not, it opens a new one.

No `httpAgent` is configured in this repo. No `keepalive: true` flag on the individual fetch calls. Grep confirms:

```
grep "httpAgent|keep-alive|keepalive" — no matches in lib/ or app/
```

The pool is Node-runtime-default. On Vercel's ephemeral functions, that pool's lifetime is the function invocation's lifetime — which can be a few seconds to a few minutes. The consequence: **each cold function invocation pays one TCP+TLS handshake per upstream host on its first call.** Subsequent calls within the same invocation reuse.

For a live investigation with ~5-15 MCP tool calls in the ReAct loop, only the first call takes the handshake hit. The rest ride the pool.

```
  Outbound pool — per-host TCP reuse

  first MCP call:
    open TCP → TLS handshake → HTTP request → response
    (socket returned to pool, not closed)

  second MCP call:
    pool.acquire() → use pooled socket → HTTP request → response
    (no handshake!)

  ... N-1 more times ...

  function invocation ends → pool discarded → all sockets close

  first Anthropic call:
    same pattern, different host → different pool entry
```

#### Neither client uses HTTP/2 to upstreams explicitly

`undici` speaks HTTP/1.1 by default. If Bloomreach's server negotiates HTTP/2 during ALPN, `undici` would fall back to HTTP/1.1 (it doesn't currently support H2 as a client without `undici.Client` H2 flag). Anthropic's SDK uses its own transport but effectively HTTP/1.1 as well. No multiplexing across streams.

The practical implication: **each concurrent outbound call needs its own socket.** If a route were to fire 5 MCP calls in parallel, `undici` would either open 5 sockets or serialize them onto fewer. For this repo the ReAct loop is sequential inside a single agent — one MCP call at a time — so pool size doesn't hit its ceiling in practice.

#### Zero UDP anywhere

QUIC (which is UDP-based) isn't used at the application layer. DNS resolution goes through the OS resolver, which likely uses UDP under the hood — but that's below the app's abstraction level. No custom UDP sockets, no QUIC transports, no realtime UDP-based protocols.

#### The 30-second per-call ceiling as a socket lifecycle constraint

The transport composes a 30-second `AbortSignal.timeout` with the route-level cancel signal. From `lib/mcp/transport.ts:38, :131-137`:

```ts
const TOOL_TIMEOUT_MS = 30_000;
// ...
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
    // ...
  }
}
```

When that signal fires, `undici` aborts the fetch, which closes the underlying TCP socket. **Socket-level cancellation is how the app enforces "no single call takes more than 30s."** Without the abort, the socket would sit there waiting for the server's response until Node's default socket timeout (~2 minutes) or the route's 300s budget ran out — both of which are worse.

### Move 3 — the principle

**Lifecycle is what makes networks visible.** For a same-origin `fetch` call that resolves in 50ms, the socket lifecycle is invisible — it opens, gets used, gets pooled or closed, all under the hood. When one socket is held open for 5 minutes and the other side of the same function is opening/closing sockets at the rate of the ReAct loop, lifecycle stops being invisible. The route function is where those two lifecycles meet, which is why every timeout, cancel, and pool decision in this repo happens right there.

## Primary diagram

```
  Connection lifecycle — all three hops laid out over time

  time ───────────────────────────────────────────────────────►

  ┌─ hop 1 (browser → route) ─────────────────────────────────┐
  │                                                            │
  │  browser TCP conn ═══════════════════════════════════════  │
  │                    ▲                                     ▲ │
  │              fetch() opens                controller.close│
  │              (or reuses HTTP/2)          browser reader end│
  │                                                            │
  │  ~0-300s open (up to maxDuration)                          │
  └────────────────────────────────────────────────────────────┘

  ┌─ hop 2 (route → MCP), pooled outbound ────────────────────┐
  │                                                            │
  │  MCP conn ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── (closed)│
  │             │   │   │   │   │   │   │   │   │             │
  │           call 1│ call 2│ call 3│ call 4│                  │
  │                 │       │       │       │                  │
  │  each interval: pool acquire → HTTP req → response → return│
  │  first call pays TCP+TLS handshake; rest reuse             │
  │  each call bounded by AbortSignal.timeout(30_000)          │
  └────────────────────────────────────────────────────────────┘

  ┌─ hop 3 (route → Anthropic), separate pool ────────────────┐
  │                                                            │
  │  Anthropic conn ─── ─── ─── ─── ─── ─── (closed at fn end)│
  │                  │   │   │   │   │                         │
  │              turn 1 turn 2 turn 3 turn 4                  │
  │                                                            │
  │  interleaved with hop 2 calls in the ReAct loop            │
  │  same pool-per-host story, different host                  │
  └────────────────────────────────────────────────────────────┘

  when hop 1 aborts (browser closes tab):
    req.signal.aborted = true
    → composeSignals fires
    → in-flight hop 2/3 fetches abort
    → their TCP sockets close
    → route function exits early
```

## Elaborate

**Why pool per host, not per app.** TLS handshakes are expensive (RTT-bound, ~50-100ms). Pooling amortizes them across calls to the same origin. Two origins → two pools. If you added a third upstream (a database HTTP API, say), you'd get a third pool entry, but the pooling is otherwise transparent — you don't configure it.

**Why the inbound socket is different.** The response body is a *stream*, not a request/response transaction. HTTP/1.1's `Transfer-Encoding: chunked` (or HTTP/2's DATA frames) keep the socket open until the server sends the terminating chunk (empty chunk + CRLF for HTTP/1.1). Vercel's edge doesn't buffer `application/x-ndjson` bodies, so chunks reach the browser as fast as the route writes them. The socket lives as long as the stream does.

**What's not exercised.** WebSockets (would need a different upgrade handshake and a socket lifetime that outlives request/response). Long-polling (which would require multiple short-lived connections; NDJSON is strictly better for this shape). Custom `undici.Agent` with configured pool size, keep-alive settings, or HTTP/2. Explicit socket-level timeouts (Node's `socket.setTimeout` — everything happens at the `AbortSignal` layer instead).

**On Vercel's ephemeral function lifetime.** The pool is per-invocation, but Vercel keeps warm instances around between invocations — so a subsequent invocation *might* hit the same instance and reuse its pool. Best-effort optimization, not a load-bearing property. If you were running this on a long-lived Node server, the pool would persist across all requests to that server; on Vercel it doesn't.

**The `HTTP 0:` timeout tag.** The transport wraps the timeout error with a distinct message shape — `HTTP 0: timeout after 30000ms` — so callers can pattern-match on it. `HTTP 0` because there was no HTTP response at all; the socket was cancelled before the server responded. See `08-networking-red-flags-audit.md` for how this shows up in the fault-injection surface.

## Interview defense

**Q: How long does one socket live in this app?**

Depends which socket. The inbound socket (browser → route) lives for the entire NDJSON stream, up to 300 seconds. The outbound sockets (route → MCP, route → Anthropic) are per-call — they open when a fetch fires, get pooled after the response completes, get discarded when the function invocation ends. Individual calls are bounded by a 30-second `AbortSignal.timeout` composed with the route-level cancel signal, so no single outbound call can hold a socket open longer than that.

```
  timeline of one 100-second investigation:

  inbound socket:  ═════════════════════════════════════════════
                   0s                                        100s
  outbound (MCP):    ─── ── ─── ─ ─── ── ─── ─── ─── ── ─── ──
                     each ~200ms-30s, pooled per host
  outbound (Anth):     ─── ─── ─── ─── ─── ─── ─── ───
                       each ~2-10s, pooled per host
```

Anchor: `app/api/agent/route.ts:23` (maxDuration), `lib/mcp/transport.ts:38` (TOOL_TIMEOUT_MS).

**Q: How does the app handle a browser closing the tab mid-investigation?**

`req.signal` fires. That signal is composed with the transport's per-call timeout via `composeSignals` in `lib/mcp/transport.ts:131-133`, so any in-flight MCP call aborts. `undici` cancels the fetch, the underlying TCP socket closes, and the route's `try/catch` catches the AbortError:

```ts
if (e instanceof DOMException && e.name === 'AbortError') {
  return;
}
```

The route exits without emitting an error event (no consumer to read it), the finally block runs the dispose + logs the phase timings, and the function invocation ends. All three sockets close.

Anchor: `app/api/agent/route.ts:313-315`.

**Q: What's the load-bearing socket-lifecycle detail people miss when they build this shape?**

Composing the abort signal into the transport. Without composition, aborting the inbound socket doesn't propagate to the outbound sockets — they keep running until their own timeout fires, burning route budget and cost. The `composeSignals` call in `lib/mcp/transport.ts:131` is what wires "browser closed the tab" to "MCP call cancels now." One line, but the socket lifecycle wouldn't join up without it.

## See also

- `01-network-map.md` — the topology this lifecycle sits inside
- `07-timeouts-retries-pooling-and-backpressure.md` — the 30s timeout as the load-bearing lifecycle constraint
- `06-websockets-sse-streaming-and-realtime.md` — why the inbound socket has a different lifecycle than the outbound ones
