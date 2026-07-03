# TCP/UDP, connections, and sockets

*Transport-layer connections (Industry standard)* — the connections and
sockets underneath the HTTP calls in this repo. Almost all of it is
delegated to the platform; the code touches sockets nowhere directly.

## Zoom out — where this concept lives

Every network call in this repo goes through `fetch` — either the
browser's `fetch` on the client, or Node's built-in `fetch` (backed by
Undici) inside the routes. Undici manages a connection pool, keeps
sockets warm with HTTP keepalive, and reuses them across requests.
None of that shows up in the app code — but understanding what Undici
does under the hood is what lets you reason about long-lived stream
lifetimes and the 30s per-call timeout.

```
  Zoom out — where sockets live in this repo

  ┌─ Client (browser fetch) ────────────────────────────────────┐
  │  browser's HTTP stack manages sockets                        │
  │  HTTP/1.1 keepalive or HTTP/2 multiplexed (browser choice)   │
  └───────────────────────┬──────────────────────────────────────┘
                          │  TCP + TLS to Vercel edge
                          ▼
  ┌─ Vercel edge (TLS terminated) ──────────────────────────────┐
  │  Vercel handles keepalive to Node runtime                    │
  └───────────────────────┬──────────────────────────────────────┘
                          │
  ┌─ Node runtime (route handler) ──────────────────────────────┐
  │  ★ SOCKETS LIVE HERE (in Undici's pool) ★                    │
  │  fetch() → Undici Agent (default: keepalive on, pool sized)  │
  │  no custom Agent; no custom Dispatcher                       │
  └───┬───────────────────────────────────────────────┬──────────┘
      │  TCP+TLS to loomi-mcp-alpha.bloomreach.com    │  TCP+TLS to api.anthropic.com
      ▼                                                ▼
  ┌─ Bloomreach ────┐                          ┌─ Anthropic ────┐
  │  MCP over HTTPS │                          │  HTTPS         │
  └─────────────────┘                          └────────────────┘
```

The app owns nothing at the socket layer — no `new Agent(…)`, no
`net.Socket`, no `dgram`. The platform's defaults carry the whole
weight. That's a design choice, and it's the right one at this
traffic volume.

## The structure pass

Two seams that matter, one axis: **connection lifetime — how long does
the underlying TCP+TLS connection live?**

```
  Axis: "how long does one TCP+TLS connection last?"

  ┌─────────────────────────────────────────┐
  │ browser → route                          │  → per fetch, but
  │ NDJSON response (chunked)                │    lives for the whole
  │                                          │    300s stream lifetime
  └─────────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ route → Bloomreach                   │  → Undici keepalive,
      │ many short JSON-RPC calls            │    connection reused
      │                                       │    across ~15 tool calls
      └──────────────────────────────────────┘
          ┌──────────────────────────────────┐
          │ route → Anthropic                │  → Undici keepalive,
          │ many short LLM calls              │    connection reused
          │                                   │    across ReAct turns
          └──────────────────────────────────┘
```

The seam that matters: the *browser-to-route* connection is
long-lived (streaming for potentially 5 minutes), while every
*route-to-upstream* connection is short-lived but pooled and reused.

## How it works

### Move 1 — the mental model

You know that `fetch('/api')` behind the scenes opens a TCP connection,
does a TLS handshake, sends the HTTP request, reads the response. What
you might not know: on a modern platform (browser, Node with Undici,
Chromium), the connection *stays open* after the response for reuse.
The next `fetch` to the same origin skips the TCP handshake, skips the
TLS handshake, and starts sending immediately.

```
  The pattern — one physical connection, many logical requests

  time ─►

  connection open ─┐
                    │  fetch #1 request bytes
                    │  fetch #1 response bytes
                    │              gap ~50ms (Undici keepalive)
                    │  fetch #2 request bytes         ← same connection
                    │  fetch #2 response bytes
                    │              gap ~1100ms (1 req/s spacing)
                    │  fetch #3 request bytes         ← still same connection
                    │  fetch #3 response bytes
                    │              …
                    │  (connection eventually closed by idle timeout
                    │   on server side, or process exit on client)
```

For blooming_insights this means the ~15 tool calls in one investigation
open exactly *one* TCP+TLS handshake to Bloomreach and *one* to Anthropic,
then reuse. That's a big win — TLS handshake alone is ~100-300ms per
attempt.

### Move 2 — where sockets show up (and don't)

#### The route-to-upstream connections

Node 18+ ships `fetch` as a global backed by Undici. The default
`Dispatcher` maintains a connection pool with:
  - HTTP/1.1 keepalive on by default
  - ~10 sockets per origin (Undici default)
  - idle timeout ~4s (so a Bloomreach call every ~1.1s reuses)
  - automatic HTTP/2 negotiation via ALPN if the server offers it

The app doesn't override any of this. There's no `import { Agent } from 'undici'`
anywhere in `lib/`. That's fine — one user, one MCP origin, one LLM
origin, one route at a time.

**What that means concretely**: the 300s stream from the browser hosts
a Node request context that makes ~15 outbound fetches. All of them
share one Undici pool per origin. The `1.1s` proactive spacing in
`BloomreachDataSource.liveCall` at `lib/data-source/bloomreach-data-source.ts:190-198`:

```ts
  private async liveCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    // …
    const result = await this.transport.callTool(name, args, { signal });
```

is *application-level* spacing to respect Bloomreach's global 1-req-per-second
rate limit — it has nothing to do with the underlying TCP connection.
The Undici pool doesn't care about the wait; the socket stays open
during the sleep.

#### The browser-to-route stream

The interesting one. The route returns a `ReadableStream` inside a
`Response` (`app/api/briefing/route.ts:191-336`), so from the browser's
perspective this is one `fetch` that never fully completes until the
route emits `done`. Under HTTP/1.1 that's one dedicated socket for the
duration; under HTTP/2 it's one stream ID over a multiplexed connection.

Cancellation matters here. When the effect unmounts:

```ts
  return () => {
    cancelledRef.current = true;   // useBriefingStream.ts:298
  };
```

The `readNdjson` loop polls `cancelOn()` between reads and calls
`reader.cancel()` (`lib/streaming/ndjson.ts:33-36`). That closes the
underlying HTTP/1 socket or HTTP/2 stream, and the browser fires
`AbortError` back into the route via `req.signal`. The route's
`throwIfAborted()` guards then abort in-flight upstream calls.

Here's the whole cancellation chain across the socket layer:

```
  Cancellation path — from user tab close to socket release

  User closes tab
        │
        │  browser fires
        │  navigator.sendBeacon-style teardown OR
        │  effect cleanup runs on route change
        ▼
  ┌─ Browser ───────────────────────────────────────────────┐
  │  cancelledRef.current = true                             │
  │  readNdjson polls, sees cancel, calls reader.cancel()    │
  │  → HTTP/1 socket closed OR HTTP/2 stream RST_STREAM     │
  └─────────────┬───────────────────────────────────────────┘
                │  TCP FIN or HTTP/2 reset
                ▼
  ┌─ Route ─────────────────────────────────────────────────┐
  │  req.signal fires (AbortError)                           │
  │  throwIfAborted() at next check                          │
  │  in-flight callTool signal (composed) → aborts           │
  └─────────────┬───────────────────────────────────────────┘
                │  cancel propagates via AbortSignal
                ▼
  ┌─ Undici pool ───────────────────────────────────────────┐
  │  in-flight upstream request cancelled                    │
  │  socket returned to pool (or destroyed if mid-transfer)  │
  └──────────────────────────────────────────────────────────┘
```

The route logs `aborted: req.signal.aborted` in the finally summary
(`briefing/route.ts:323`) so an operator can see cancellation events
in the Vercel log stream.

#### UDP — not exercised

No `dgram`, no `datagram`, no QUIC-level code. HTTP/3 (QUIC over UDP)
would be handled entirely by the platform stack if the browser and
upstream negotiate it, but the app doesn't see it.

#### Raw TCP — not exercised

No `net.Socket` anywhere in `lib/`. No `net.createConnection`. All
network access is via `fetch`.

### Move 3 — the principle

Trust the platform's socket layer until you have a specific reason not
to. Undici's defaults handle keepalive, pooling, and idle timeout
correctly for the workload here. You'd revisit only when:
  - **You need a specific keepalive interval** to prevent an
    intermediate NAT/firewall from dropping idle connections.
  - **You need per-user connection isolation** (e.g. a multi-tenant
    proxy where each tenant needs their own pool).
  - **You need a specific TLS session ticket policy** for perf.

None of those apply at this repo's scale.

## Primary diagram

```
  Primary — the socket picture

  ┌─ Browser ────────────────────────────────────────────────────┐
  │  one long-lived fetch (up to 300s) → one HTTP stream         │
  │  reader.cancel() → RST_STREAM or FIN                          │
  └───────────────────────┬──────────────────────────────────────┘
                          │  one TCP+TLS conn (or HTTP/2 stream)
                          ▼
  ┌─ Vercel edge (TLS terminated) ──────────────────────────────┐
  │  reverse proxy → Node runtime                                │
  └───────────────────────┬──────────────────────────────────────┘
                          │  local/loopback
                          ▼
  ┌─ Node runtime (Undici pool) ────────────────────────────────┐
  │                                                                │
  │  origin: loomi-mcp-alpha.bloomreach.com                       │
  │  ┌──────────────────────────┐                                 │
  │  │ socket 1 (keepalive)     │  ← reused for ~15 tool calls    │
  │  └──────────────────────────┘                                 │
  │                                                                │
  │  origin: api.anthropic.com                                    │
  │  ┌──────────────────────────┐                                 │
  │  │ socket 1 (keepalive)     │  ← reused for ReAct turns       │
  │  └──────────────────────────┘                                 │
  │                                                                │
  │  No custom Agent, Dispatcher, or Pool — Undici defaults       │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The interesting decision here is *not* to touch sockets. In a system
where every millisecond mattered you'd tune keepalive, pre-warm the
pool at cold start, maybe pin an HTTP/2 connection. Here, the largest
network cost per request is:

  - Anthropic latency: ~2-5s per LLM turn (dominated by model compute)
  - Bloomreach latency: ~200-500ms per tool call + rate-limit waits

The socket handshake savings (~200ms for TLS 1.3, once, on the first
call) are noise against those. Not worth engineering.

The one place it *would* matter: if the Vercel Node runtime cold-starts
mid-briefing. A cold start opens fresh sockets to both origins; the
first tool call absorbs the TLS handshake. Not measurable in the
current baseline (`2026-07-03T04-08-28-644Z`), but a knob to consider
if you saw a bimodal latency distribution on the first call.

## Interview defense

**Q: How does the app manage connection pooling to Bloomreach?**

  Verdict first: it doesn't — Undici does, and the defaults are right
  for this workload.

```
  answer sketch — one pool per origin, warm across the briefing

  briefing route lifetime (~50-100s)
      │
      ├─ callTool #1  → Undici opens socket #1 to bloomreach
      │  200ms TLS handshake included
      │
      ├─ 1.1s spacing (app-level, socket stays open)
      │
      ├─ callTool #2  → REUSES socket #1
      │  no TLS handshake
      │
      ├─ callTool #15 → still socket #1
      │
      └─ route returns → socket idle in pool
                        idle timeout ~4s → Undici closes
```

  Anchor: `lib/data-source/bloomreach-data-source.ts:190-205` (the
  1.1s spacing sits *on top of* Undici's pool, which handles the
  socket reuse transparently).

**Q: What happens to the underlying TCP connection when the browser
tab closes mid-stream?**

  Direct: browser closes the stream, the socket (HTTP/1) or stream
  (HTTP/2) sends RST/FIN, Node's `req.signal` fires `AbortError`, the
  route's next `throwIfAborted()` throws, and any in-flight upstream
  `callTool` has its own composed signal aborted, which cancels the
  Undici request and returns the socket to the pool (or destroys it if
  it was mid-transfer).

  Anchor: `useBriefingStream.ts:298`, `lib/streaming/ndjson.ts:33-36`,
  `briefing/route.ts:215,248,259,283,290`.

## See also

  - `01-network-map.md` — the three hops these sockets carry
  - `04-tls-and-trust-establishment.md` — the TLS handshake we skip on reuse
  - `07-timeouts-retries-pooling-and-backpressure.md` — the timeouts that ride on top
